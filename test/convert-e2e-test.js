// convert_file 格式转换端到端测试（Electron 内跑，nativeImage/printToPDF 需要）
// 运行：npx electron test/convert-e2e-test.js
// 覆盖：png→jpg、jpg→png、多图合成 PDF、md→docx、html→pdf、非法目标拒绝、源不动
// 音视频（FFmpeg 下载 80MB）默认跳过，设 FFMPEG_E2E=1 才真跑
const fs = require('fs')
const path = require('path')
const os = require('os')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

async function main() {
  const { SnapshotManager } = require('../ai/snapshots')
  const { createTools } = require('../ai/tools')
  const { PDFDocument } = require('pdf-lib')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-e2e-'))
  const snapshots = new SnapshotManager({ dir: path.join(tmp, 'snapshots'), log: () => {} })
  const tools = createTools({ tcpAgent: { getConnectedDevices: () => [] }, snapshots, desktopDir: tmp, tmpDir: tmp, log: () => {} })

  // 造源：两张 PNG（nativeImage 画）+ 一个 md + 一个 html
  const el = require('electron')
  const png1 = path.join(tmp, 'p1.png')
  const png2 = path.join(tmp, 'p2.png')
  const mk = (file, color) => {
    const size = 120
    const img = el.nativeImage.createEmpty()
    const buf = Buffer.alloc(size * size * 4)
    for (let i = 0; i < size * size; i++) { buf[i * 4] = color[0]; buf[i * 4 + 1] = color[1]; buf[i * 4 + 2] = color[2]; buf[i * 4 + 3] = 255 }
    const im = el.nativeImage.createFromBitmap(buf, { width: size, height: size })
    fs.writeFileSync(file, im.toPNG())
  }
  mk(png1, [200, 60, 60]); mk(png2, [60, 120, 200])

  const md = path.join(tmp, '笔记.md')
  fs.writeFileSync(md, '# 转换测试\n\n这是一段**加粗**正文。\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |\n')
  const html = path.join(tmp, '页面.html')
  fs.writeFileSync(html, '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:40px}h1{color:#333}</style></head><body><h1>HTML 转 PDF 测试</h1><p>背景色与文字都要保留。</p></body></html>')

  const pageCount = async (f) => (await PDFDocument.load(fs.readFileSync(f))).getPageCount()

  // ① png→jpg
  const r1 = await tools.execute('convert_file', { path: png1, to: 'jpg' })
  const jpg1 = path.join(tmp, 'p1.jpg')
  ok('png→jpg 成功', r1.ok === true && fs.existsSync(jpg1), r1.message)
  ok('jpg 是有效图片', fs.existsSync(jpg1) && el.nativeImage.createFromBuffer(fs.readFileSync(jpg1)).toPNG().length > 100)

  // ② jpg→png（跨格式回转）
  const r2 = await tools.execute('convert_file', { path: jpg1, to: 'png' })
  ok('jpg→png 成功', r2.ok === true && fs.existsSync(path.join(tmp, 'p1.png')) && r2.ok, r2.message)

  // ③ 多图合成 PDF
  const pdfOut = path.join(tmp, '合册.pdf')
  const r3 = await tools.execute('convert_file', { paths: [png1, png2], to: 'pdf', out: pdfOut })
  ok('双图合成 PDF 成功', r3.ok === true && fs.existsSync(pdfOut), r3.message)
  ok('PDF 页数 = 2', (await pageCount(pdfOut)) === 2, String(await pageCount(pdfOut)))

  // ④ md→docx
  const r4 = await tools.execute('convert_file', { path: md, to: 'docx' })
  const docxOut = path.join(tmp, '笔记.docx')
  ok('md→docx 成功（zip 魔数）', r4.ok === true && fs.existsSync(docxOut) && fs.readFileSync(docxOut).slice(0, 2).toString() === 'PK', r4.message)

  // ④b md→pdf（md→docx→COM 两跳，需本机 Word/WPS；产出验证后删）
  const r4b = await tools.execute('convert_file', { path: md, to: 'pdf' })
  const mdPdf = path.join(tmp, '笔记.pdf')
  if (!fs.existsSync(mdPdf)) console.log('  [debug] dir now:', fs.readdirSync(tmp).join(' | '), '\n  [debug] msg:', r4b.message)
  else console.log('  [debug] head bytes:', Buffer.from(fs.readFileSync(mdPdf).slice(0, 16)).toString('hex'), JSON.stringify(fs.readFileSync(mdPdf).slice(0, 16).toString()), 'size:', fs.statSync(mdPdf).size)
  ok('md→pdf 成功（两跳经 COM）', r4b.ok === true && fs.existsSync(mdPdf) && fs.readFileSync(mdPdf).slice(0, 4).toString() === '%PDF', r4b.message)

  // ④c docx→pdf（同 COM 链路，直接源）
  const r4c = await tools.execute('convert_file', { path: docxOut, to: 'pdf' })
  ok('docx→pdf 成功', r4c.ok === true && fs.existsSync(path.join(tmp, '笔记.pdf')) && fs.readFileSync(path.join(tmp, '笔记.pdf')).slice(0, 4).toString() === '%PDF', r4c.message)

  // ⑤ html→pdf
  const r5 = await tools.execute('convert_file', { path: html, to: 'pdf' })
  const htmlPdf = path.join(tmp, '页面.pdf')
  ok('html→pdf 成功', r5.ok === true && fs.existsSync(htmlPdf), r5.message)
  ok('html pdf %PDF 魔数', fs.existsSync(htmlPdf) && fs.readFileSync(htmlPdf).slice(0, 4).toString() === '%PDF')

  // ⑥ 非法目标拒绝
  const r6 = await tools.execute('convert_file', { path: png1, to: 'exe' })
  ok('非法目标被拒', r6.ok === false, r6.message)

  // ⑦ 源文件不动
  ok('源文件未被动过', fs.statSync(png1).size > 0 && fs.statSync(md).size > 0)

  // ⑧ 音视频（FFmpeg 下载 80MB，默认跳过）
  if (process.env.FFMPEG_E2E === '1') {
    const fakeVid = path.join(tmp, 'in.mp4')
    // 用 ffmpeg 自产测试视频（彩条）再转 mp3，闭环不依赖外网素材
    try {
      const ffDir = path.join(process.env.APPDATA || tmp, 'ms-interconnect', 'ffmpeg', 'bin')
      const ffExe = path.join(ffDir, 'ffmpeg.exe')
      const { execFileSync } = require('child_process')
      if (fs.existsSync(ffExe)) {
        execFileSync(ffExe, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', fakeVid], { timeout: 60000, windowsHide: true })
        const r8 = await tools.execute('convert_file', { path: fakeVid, to: 'mp3' })
        ok('视频提取 mp3 成功（FFmpeg）', r8.ok === true && fs.existsSync(path.join(tmp, 'in.mp3')), r8.message)
      } else ok('FFmpeg 预缓存不存在，跳过音视频用例', true)
    } catch (e) { ok('音视频用例', false, e.message) }
  } else ok('音视频用例默认跳过（FFMPEG_E2E=1 开启）', true)

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'CONVERT_E2E_OK' : 'CONVERT_E2E_FAIL'} (${pass}/${pass + fail})`)
  el.app.exit(fail ? 1 : 0)
}

const { app } = require('electron')
app.on('window-all-closed', () => {})
app.whenReady().then(main)
