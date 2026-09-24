// pptx-preview × Electron 22 探针：vendor UMD 直载 + 真渲染 createPptx 产物 + slide DOM 断言
// 通过标准：
//   ① vendor 落盘（pptx-preview + jszip）
//   ② Chromium 108 里 UMD 载入（全局 pptxPreview.init / JSZip）
//   ③ 标准 pptx（纯 pptxgenjs）直接渲染出 slide 节点 + 中文文本上屏
//   ④ office.js createPptx 产物（[Content_Types].xml 带幽灵 Override）→ 修复重试链路渲染成功
const fs = require('fs')
const path = require('path')
const os = require('os')
const { app, BrowserWindow } = require('electron')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ① vendor 文件落盘
  const vendorPptx = path.join(SRC, 'vendor', 'pptx-preview.min.js')
  const vendorJszip = path.join(SRC, 'vendor', 'jszip.min.js')
  ok('vendor/pptx-preview.min.js 落盘', fs.existsSync(vendorPptx) && fs.statSync(vendorPptx).size > 1000000)
  ok('vendor/jszip.min.js 落盘', fs.existsSync(vendorJszip) && fs.statSync(vendorJszip).size > 50000)

  // ② 造两份真实 pptx：office.js 产物（AI 主链路）+ 纯 pptxgenjs 产物（标准文件）
  const office = require(path.join(ROOT, 'ai/office.js'))
  const PptxGenJS = require('pptxgenjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-preview-probe-'))
  const outline = [
    'theme: authority',
    'style: soft',
    '---',
    '#cover 探针封面标题',
    '##探针副标题',
    '---',
    '##探针内容页',
    '- 要点一',
    '- 要点二'
  ].join('\n')
  const officePath = path.join(dir, 'office.pptx')
  try {
    const size = await office.createPptx(officePath, { title: '探针演示文稿', content: outline })
    ok('createPptx 产物落盘', fs.existsSync(officePath) && size > 30000, String(size))
  } catch (e) {
    ok('createPptx 产物落盘', false, e.message)
  }
  const vanillaPath = path.join(dir, 'vanilla.pptx')
  try {
    const pres = new PptxGenJS()
    pres.layout = 'LAYOUT_16x9'
    const sl = pres.addSlide()
    sl.addText('探针封面标题', { x: 1, y: 1, w: 8, h: 1, fontSize: 32 })
    await pres.writeFile({ fileName: vanillaPath })
    ok('纯 pptxgenjs 产物落盘', fs.existsSync(vanillaPath))
  } catch (e) {
    ok('纯 pptxgenjs 产物落盘', false, e.message)
  }

  // ③ 渲染层真载：offscreen 窗口 file:// 直载 vendor UMD + 双链路渲染
  const tmpHtml = path.join(__dirname, '.tmp-pptx-probe.html')
  const vUrl = 'file:///' + SRC.replace(/\\/g, '/')
  fs.writeFileSync(tmpHtml, `<!DOCTYPE html><html><head>
<script src="${vUrl}/vendor/jszip.min.js"></script>
<script src="${vUrl}/vendor/pptx-preview.min.js"></script>
</head><body><div id="host"></div></body></html>`)
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    const logs = []
    win.webContents.on('console-message', (e, level, msg) => { logs.push(`[L${level}] ${msg}`) })
    await win.loadFile(tmpHtml)
    // 渲染层跑与工作台集成完全一致的链路：base64→ArrayBuffer→preview→0 页时 Content_Types 修复重试
    const r = await win.webContents.executeJavaScript(`(async function() {
      const out = {}
      out.pptxDefined = typeof pptxPreview !== 'undefined' && typeof pptxPreview.init === 'function'
      out.jszipDefined = typeof JSZip !== 'undefined' && typeof JSZip.loadAsync === 'function'
      if (!out.pptxDefined || !out.jszipDefined) return out
      // 工作台同款修复函数：剔除 [Content_Types].xml 里指向缺失文件的 Override，返回 null 表示无需修复
      const repairContentTypes = async (buf) => {
        const zip = await JSZip.loadAsync(buf)
        const f = zip.file('[Content_Types].xml')
        if (!f) return null
        let ct = await f.async('string')
        let removed = 0
        ct = ct.replace(/<Override PartName="([^"]+)"[^>]*\\/>/g, (m, part) => {
          const name = part.replace(/^\\//, '')
          const ent = zip.files[name]
          if (!ent || ent.dir) { removed++; return '' }
          return m
        })
        if (!removed) return null
        zip.file('[Content_Types].xml', ct)
        return { buf: await zip.generateAsync({ type: 'arraybuffer' }), removed }
      }
      const renderFile = async (b64, host) => {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        let buf = bytes.buffer
        let pv = pptxPreview.init(host, { width: 960, height: 540 })
        await pv.preview(buf)
        let repaired = false
        if (pv.slideCount === 0) {
          const fix = await repairContentTypes(buf)
          if (fix) {
            repaired = true
            buf = fix.buf
            pv.destroy()
            host.innerHTML = ''
            pv = pptxPreview.init(host, { width: 960, height: 540 })
            await pv.preview(buf)
          }
        }
        return { slideCount: pv.slideCount, slideDom: host.querySelectorAll('.slide-wrapper, .pptx-preview-slide-wrapper').length, text: host.textContent.indexOf('探针封面标题') !== -1, repaired }
      }
      try {
        out.vanilla = await renderFile(${JSON.stringify(fs.readFileSync(vanillaPath).toString('base64'))}, document.getElementById('host'))
        document.getElementById('host').innerHTML = ''
        out.office = await renderFile(${JSON.stringify(fs.readFileSync(officePath).toString('base64'))}, document.getElementById('host'))
      } catch (e) { out.error = (e && e.message) || String(e) }
      return out
    })()`)
    if (logs.length) console.log('--- 页面 console ---\n' + logs.slice(0, 12).join('\n'))
    ok('UMD 载入（pptxPreview + JSZip）', r.pptxDefined && r.jszipDefined)
    ok('渲染无抛错', !r.error, r.error || '')
    ok('标准 pptx 直接渲染（slideCount≥1）', r.vanilla && r.vanilla.slideCount >= 1 && r.vanilla.slideDom >= 1, JSON.stringify(r.vanilla || null))
    ok('标准 pptx 中文文本上屏', r.vanilla && r.vanilla.text === true)
    ok('office.js 产物走修复链路', r.office && r.office.repaired === true, JSON.stringify(r.office || null))
    ok('office.js 产物修复后渲染（slideCount≥2）', r.office && r.office.slideCount >= 2 && r.office.slideDom >= 2, 'slideDom ' + (r.office ? r.office.slideDom : 'null'))
    ok('office.js 产物中文文本上屏', r.office && r.office.text === true)
    win.destroy()
  } catch (e) {
    ok('渲染层探针', false, e.message)
  }
  fs.rmSync(tmpHtml, { force: true })
  console.log(`\n${fail === 0 ? 'PPTX_PREVIEW_PROBE_OK' : 'PPTX_PREVIEW_PROBE_FAIL'} (${pass}/${pass + fail})`)
  app.exit(fail ? 1 : 0)
}

app.on('window-all-closed', () => {})
app.whenReady().then(main)
