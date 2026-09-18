// 莫西桌宠素材预处理：缩图 + 去AI毛边 + 动作帧切帧拼条 → assets/moxi/
// 运行：npx electron test/moxi-asset-prep.js（一次性脚本，跑完素材入包可删）
// 原理：offscreen 窗口加载处理页（源图以 base64 data URL 内嵌，避开 canvas 跨域污染），
//       页面里 canvas 做像素处理，主进程收 base64 写盘。透明图 WebP q0.92，海报 WebP q0.88。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SRC = path.join(__dirname, '..', '桌宠版本素材')
const OUT = path.join(__dirname, '..', 'assets', 'moxi')

// 透明情绪图/立绘：统一按高缩放；海报按宽/高约束
const TASKS = [
  { src: 'Q版立绘.png', out: 'emotion-normal.webp', h: 512 },
  { src: 'Q版（伤心）.png', out: 'emotion-sad.webp', h: 512 },
  { src: 'Q版（喜欢）.png', out: 'emotion-like.webp', h: 512 },
  { src: 'Q版（干劲满满）.png', out: 'emotion-eager.webp', h: 512 },
  { src: 'Q版（惊讶）.png', out: 'emotion-surprised.webp', h: 512 },
  { src: 'Q版（无语）.png', out: 'emotion-speechless.webp', h: 512 },
  { src: 'Q版（生气）.png', out: 'emotion-angry.webp', h: 512 },
  { src: 'Q版（疑惑）.png', out: 'emotion-confused.webp', h: 512 },
  { src: 'Q版（睡觉）.png', out: 'emotion-sleep.webp', h: 512 },
  { src: '头像（Q版）.png', out: 'avatar.webp', h: 256 },
  { src: '透明底正比立绘1.png', out: 'standee.webp', h: 1024 },
  { src: '海报（横）.png', out: 'poster-h.webp', w: 1280, opaque: true, q: 0.88 },
  { src: '海报（竖）.png', out: 'poster-v.webp', h: 1280, opaque: true, q: 0.88 }
]

// 页面端处理逻辑（executeJavaScript 注入执行）
const PAGE_FN = `
window.loadImg = (dataUrl) => new Promise((res, rej) => {
  const im = new Image()
  im.onload = () => res(im)
  im.onerror = () => rej(new Error('图片加载失败'))
  im.src = dataUrl
})
// 去 AI 毛边：低 alpha 收边 + 低 alpha 区蓝紫雾降透明（主体高 alpha 不动，保护紫色头发）
window.edgeFix = (ctx, w, h) => {
  const d = ctx.getImageData(0, 0, w, h), p = d.data
  for (let i = 0; i < p.length; i += 4) {
    let a = p[i + 3]
    if (a === 0) continue
    if (a < 24) { p[i + 3] = 0; continue }
    const r = p[i], g = p[i + 1], b = p[i + 2]
    if (a < 120 && b > g + 25 && b >= r && (b - g) > 25) a = Math.round(a * 0.4) // 低alpha蓝紫晕
    else if (a < 140) a = Math.round(a * 0.75)                                   // 普通软边收紧
    p[i + 3] = a
  }
  ctx.putImageData(d, 0, 0)
}
window.convertTask = async (dataUrl, opts) => {
  const im = await window.loadImg(dataUrl)
  const tw = opts.w || Math.round(im.height ? im.width * (opts.h / im.height) : im.width)
  const th = opts.h || Math.round(im.width ? im.height * (opts.w / im.width) : im.height)
  const c = document.createElement('canvas')
  c.width = tw; c.height = th
  const x = c.getContext('2d')
  x.imageSmoothingQuality = 'high'
  if (opts.opaque) { x.fillStyle = '#ffffff'; x.fillRect(0, 0, tw, th) }
  x.drawImage(im, 0, 0, tw, th)
  if (!opts.opaque) window.edgeFix(x, tw, th)
  return { w: tw, h: th, data: c.toDataURL('image/webp', opts.q || 0.92) }
}
// 动作帧：4×4 切格（右移 8 + 底收 10，固定偏移）→ 内容归一化（水平居中+底边基线+大小贴中位数）→ 拼条
// 注：逐帧迭代校准试过不如这版（会误切），勿回加
window.cutStrip = async (dataUrl) => {
  const im = await window.loadImg(dataUrl)
  const cw = Math.floor(im.width / 4), ch = Math.floor(im.height / 4)
  const shift = 8  // 窗口右移：切掉左缘的上一帧尾巴残留
  const shiftY = 10 // 底部收窄：切掉下一行顶部渗入
  const cellW = cw - shift
  const cellH = ch - shiftY
  const cut = () => {
    const c = document.createElement('canvas')
    c.width = cellW; c.height = cellH
    return c
  }
  const cells = []
  for (let i = 0; i < 16; i++) {
    const c = cut()
    c.getContext('2d').drawImage(im, (i % 4) * cw + shift, Math.floor(i / 4) * ch, cellW, cellH, 0, 0, cellW, cellH)
    cells.push(c)
  }
  // 每格内容包围盒（alpha > 24 视为实体）
  const boxes = cells.map((c) => {
    const x = c.getContext('2d')
    const d = x.getImageData(0, 0, c.width, c.height), p = d.data
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1
    for (let yy = 0; yy < c.height; yy++) for (let xx = 0; xx < c.width; xx++) {
      if (p[(yy * c.width + xx) * 4 + 3] > 24) {
        if (xx < minX) minX = xx; if (xx > maxX) maxX = xx
        if (yy < minY) minY = yy; if (yy > maxY) maxY = yy
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
  })
  // 大小基准 = 有效帧包围盒高的中位数
  const hs = boxes.filter(Boolean).map((b) => b.h).sort((a, b) => a - b)
  const baseH = hs.length ? hs[Math.floor(hs.length / 2)] : cellH
  const out = document.createElement('canvas')
  out.width = cellW * 16; out.height = cellH
  const ox = out.getContext('2d')
  for (let i = 0; i < 16; i++) {
    const c = cells[i], b = boxes[i]
    const x = c.getContext('2d')
    if (!b) { ox.drawImage(c, i * cellW, 0); continue } // 空格原样
    const scale = Math.min(1.22, Math.max(0.82, baseH / b.h)) // 大小贴基准，限幅防糊防过度
    const dw = Math.round(b.w * scale), dh = Math.round(b.h * scale)
    const dx = Math.round((cellW - dw) / 2)      // 水平居中
    const dy = Math.max(0, cellH - 2 - dh)       // 垂直底边对齐（统一坐姿基线，留 2px）
    const tmp = cut()
    const tx = tmp.getContext('2d')
    tx.imageSmoothingQuality = 'high'
    tx.drawImage(c, b.x, b.y, b.w, b.h, dx, dy, dw, dh)
    window.edgeFix(tx, cellW, cellH)
    ox.drawImage(tmp, i * cellW, 0)
  }
  return { w: out.width, h: out.height, cellW, cellH, data: out.toDataURL('image/webp', 0.92) }
}
`

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  app.disableHardwareAcceleration()
  await app.whenReady()
  fs.mkdirSync(OUT, { recursive: true })

  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body><script>${PAGE_FN}<\/script></body></html>`))

  const b64 = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')
  const save = (name, dataUrl) => {
    const raw = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    const f = path.join(OUT, name)
    fs.writeFileSync(f, raw)
    return raw.length
  }

  // --motion <路径>：外部连续动作网格（4×4）→ 白底自动过本地抠图 → 切帧 → typing-loop.webp（一条龙）
  const motionIdx = process.argv.indexOf('--motion')
  if (motionIdx > -1 && process.argv[motionIdx + 1]) {
    const src = path.resolve(process.argv[motionIdx + 1])
    if (!fs.existsSync(src)) { console.error('FAIL 源图不存在:', src); app.exit(1) }
    try {
      let cutSrc = src
      // 无 alpha（白底/实底）先走本地 remove_bg（离线 ONNX，零成本）
      const probe = await win.webContents.executeJavaScript(`(async () => {
        const im = await window.loadImg(${JSON.stringify(b64(src))})
        const c = document.createElement('canvas')
        c.width = Math.min(im.width, 64); c.height = Math.min(im.height, 64)
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height)
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        let hasAlpha = false
        for (let i = 3; i < d.length; i += 4) { if (d[i] < 250) { hasAlpha = true; break } }
        return { hasAlpha, w: im.width, h: im.height }
      })()`)
      ok(`源图 ${path.basename(src)} ${probe.w}x${probe.h}`, true)
      if (!probe.hasAlpha) {
        console.log('源图无透明通道 → 本地 remove_bg 抠图…')
        const os = require('os')
        const { createTools } = require('../ai/tools')
        const settingsDir = [process.env.MSC_USER_DATA, path.join(os.homedir(), 'AppData', 'Roaming', 'MSMate-moxi-test'), path.join(os.homedir(), 'AppData', 'Roaming', 'MSWork'), path.join(os.homedir(), 'AppData', 'Roaming', 'MSMate')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'settings.json')))
        const readS = () => { try { return JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8')) } catch { return {} } }
        const tools = createTools({
          tcpAgent: { getConnectedDevices: () => [], uploadFile: async () => ({ success: true }), downloadFile: async () => ({ success: true }) },
          snapshots: { backupLocal: () => ({ ok: false }) },
          desktopDir: OUT, tmpDir: OUT, workspaceDir: OUT,
          getSetting: (k) => readS()[k], setSetting: () => true, log: () => {}
        })
        const rb = await tools.execute('remove_bg', { path: src, out: path.join(OUT, '.tmp-motion-cut.png') })
        if (!rb.ok) { ok('白底抠图', false, rb.message.slice(0, 120)); app.exit(1) }
        cutSrc = path.join(OUT, '.tmp-motion-cut.png')
        ok('白底自动抠图', fs.existsSync(cutSrc))
      }
      const s = await win.webContents.executeJavaScript(`cutStrip(${JSON.stringify(b64(cutSrc))})`)
      const ssize = save('typing-loop.webp', s.data)
      ok(`typing-loop.webp ${s.w}x${s.h}（格 ${s.cellW}x${s.cellH}）`, ssize > 3000, (ssize / 1024).toFixed(0) + 'KB')
      fs.writeFileSync(path.join(__dirname, '.tmp-moxi-strip-preview.webp'), Buffer.from(s.data.slice(s.data.indexOf(',') + 1), 'base64'))
      console.log(`\n${fail === 0 ? 'MOTION_OK' : 'MOTION_FAIL'} (${pass}/${pass + fail})`)
      app.exit(fail ? 1 : 0)
    } catch (e) {
      console.error('FAIL motion 管道:', e.message)
      app.exit(1)
    }
    return
  }

  try {
    for (const t of TASKS) {
      const srcP = path.join(SRC, t.src)
      if (!fs.existsSync(srcP)) { ok(`源图 ${t.src}`, false, '不存在'); continue }
      const r = await win.webContents.executeJavaScript(`convertTask(${JSON.stringify(b64(srcP))}, ${JSON.stringify(t)})`)
      const size = save(t.out, r.data)
      ok(`${t.out} ${r.w}x${r.h}`, size > 3000 && size < 900 * 1024, (size / 1024).toFixed(0) + 'KB')
    }
    // 动作帧切帧拼条
    const stripP = path.join(SRC, '动作帧（Work）.png')
    const s = await win.webContents.executeJavaScript(`cutStrip(${JSON.stringify(b64(stripP))})`)
    const ssize = save('work-strip.webp', s.data)
    ok(`work-strip.webp ${s.w}x${s.h}（格 ${s.cellW}x${s.cellH}）`, ssize > 3000, (ssize / 1024).toFixed(0) + 'KB')
    // 导一张预览 PNG 供人工检查切帧质量（WebP 也能 Read，直接存 webp）
    fs.writeFileSync(path.join(__dirname, '.tmp-moxi-strip-preview.webp'), Buffer.from(s.data.slice(s.data.indexOf(',') + 1), 'base64'))
  } catch (e) {
    ok('素材处理全流程', false, e.message)
  }

  try { win.destroy() } catch {}
  console.log(`\n${fail === 0 ? 'MOXI_ASSET_OK' : 'MOXI_ASSET_FAIL'} (${pass}/${pass + fail})`)
  app.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('预处理异常:', e); app.exit(1) })
