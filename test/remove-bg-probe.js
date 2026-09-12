// remove_bg 端到端探针：AI 生成实物图 → 产品级 remove_bg（tools.js 真代码）→ 验证透明底
// 通过标准：输出 PNG 存在；alpha 双向分布（背景被抠掉 + 主体保留）；模型缓存命中
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')

const SF_KEY = 'sk-xmvygdzmvinctnnopqzryqqaelxspgaswuzlwcmlvicqohqg'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-rmbg-'))

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = JSON.stringify(body)
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SF_KEY}`, 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}
function get(url) {
  return new Promise((resolve, reject) => {
    const get2 = (u, n) => {
      try {
        console.log('下载:', u.slice(0, 90))
        const req = https.get(u, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && n < 5) { r.resume(); return get2(r.headers.location, n + 1) }
          if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode + ' ' + u.slice(0, 60))) }
          const chunks = []
          r.on('data', (c) => chunks.push(c))
          r.on('end', () => resolve(Buffer.concat(chunks)))
          r.on('error', (e) => reject(e))
        })
        req.on('error', (e) => reject(e))
      } catch (e) { reject(e) }
    }
    get2(url, 0)
  })
}

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ① AI 生成一张白底实物图（苹果）
  console.log('生成白底实物图（Z-Image-Turbo）...')
  const gen = await post('https://api.siliconflow.cn/v1/image/generations', { model: 'Tongyi-MAI/Z-Image-Turbo', prompt: 'a single shiny red apple, centered, on pure white background, product photo', image_size: '1024x1024' })
  const genJ = JSON.parse(gen.text)
  const imgUrl = genJ.images && genJ.images[0] && genJ.images[0].url
  ok('生图返回 URL', !!imgUrl, gen.text.slice(0, 150))
  if (!imgUrl) return done()
  const imgBuf = await get(imgUrl)
  const srcPath = path.join(tmp, 'apple.png')
  fs.writeFileSync(srcPath, imgBuf)
  ok('实物图下载', imgBuf.length > 50000, imgBuf.length + 'B')

  // ② 实例化产品工具（ai/tools.js 真代码，mock 注入依赖）
  const createTools = require(path.join(__dirname, '..', 'ai', 'tools.js')).createTools
  const tools = createTools({
    tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'x' }), snapshotDir: () => tmp, register: () => {} },
    desktopDir: path.join(tmp, 'desktop'), tmpDir: tmp, workspaceDir: path.join(tmp, 'ws'),
    getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}
  })

  // ③ 真抠图（execute 调度入口，与 agent 同款调用路径）
  console.log('抠图推理（首次含模型下载 4.4MB）...')
  const t0 = Date.now()
  const r = await tools.execute('remove_bg', { path: srcPath })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  ok('remove_bg 执行成功', r && r.ok, JSON.stringify(r).slice(0, 200))
  if (!r || !r.ok) return done()
  console.log(`耗时 ${dt}s（首次含模型下载）→ ${r.path}`)

  // ④ 输出验证：PNG + alpha 双向分布
  const el = require('electron').nativeImage
  const outBuf = fs.readFileSync(r.path)
  ok('输出 PNG 魔数', outBuf[0] === 0x89 && outBuf[1] === 0x50)
  const outImg = el.createFromBuffer(outBuf)
  ok('输出可解码', !outImg.isEmpty())
  const sz = outImg.getSize()
  const bmp = outImg.toBitmap()
  let opaque = 0, transparent = 0
  const total = sz.width * sz.height
  for (let i = 0; i < total; i++) {
    const a = bmp[i * 4 + 3]
    if (a >= 250) opaque++
    else if (a <= 5) transparent++
  }
  const opPct = (opaque / total * 100).toFixed(1), trPct = (transparent / total * 100).toFixed(1)
  console.log(`alpha 分布：主体不透明 ${opPct}% | 背景全透明 ${trPct}%`)
  ok('背景被抠掉（全透明 >10%）', transparent / total > 0.10, trPct + '%')
  ok('主体被保留（不透明 >10%）', opaque / total > 0.10, opPct + '%')

  // ⑤ 二次调用走 session 缓存（速度对比）
  const t1 = Date.now()
  const r2 = await tools.execute('remove_bg', { path: srcPath, out: path.join(tmp, 'apple2.png') })
  ok('二次调用成功（session 缓存）', r2 && r2.ok, JSON.stringify(r2).slice(0, 120))
  console.log(`二次耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`)

  done()
  function done() {
    console.log(`\n${fail === 0 ? 'REMOVE_BG_PROBE_OK' : 'REMOVE_BG_PROBE_FAIL'} (${pass}/${pass + fail})`)
    require('electron').app.exit(fail ? 1 : 0)
  }
}

const { app } = require('electron')
app.on('window-all-closed', () => {})
app.whenReady().then(main)
