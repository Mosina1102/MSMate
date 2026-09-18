// Electron 22 offscreen 逐帧捕获 × FFmpeg 合成探针（hyperframes 原理验证：HTML→帧→MP4）
// 通过标准：
//   ① offscreen 窗口加载 HTML（canvas 纯函数渲染，主进程驱动帧号——hyperframes paused-timeline seek 同思想）
//   ② capturePage 逐帧捕获 60 帧 PNG，帧画面确在变化
//   ③ 同帧号重复捕获画面一致（确定性核心：同输入必同帧）
//   ④ offscreen paint 事件流可用（BeginFrame 等价物）
//   ⑤ 本机有 FFmpeg 则真合成 MP4 并校验魔数；无则 SKIP（帧捕获链路已验证）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const W = 480, H = 270, FPS = 30, FRAMES = 60

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  app.disableHardwareAcceleration() // 软件渲染：跨机器确定性、无 GPU 差异
  await app.whenReady()

  const tmp = path.join(__dirname, '.tmp-video-probe')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const framesDir = path.join(tmp, 'frames')
  fs.mkdirSync(framesDir)

  try {
    const win = new BrowserWindow({
      width: W, height: H, show: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false }
    })

    // 纯函数渲染：帧号 t → 画面。无实时时钟/CSS 动画依赖，确定性由"输入=帧号"保证
    const html = `<!doctype html><body style="margin:0;background:#101018">
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
window.render = (t) => {
  const c = document.getElementById('c'), x = c.getContext('2d')
  x.fillStyle = '#101018'; x.fillRect(0, 0, ${W}, ${H})
  x.fillStyle = '#7c5cff'
  x.beginPath(); x.arc(${W / 2} + (t - 30) * 3, ${H / 2}, 40, 0, Math.PI * 2); x.fill()
  x.fillStyle = '#ffffff'; x.font = '24px sans-serif'; x.fillText('frame ' + t, 20, 40)
}
window.render(0)
</script></body>`
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

    const grabFrame = async (t) => {
      await win.webContents.executeJavaScript(`render(${t}); true`)
      await new Promise((r) => setTimeout(r, 40)) // 等合成器出帧（软件渲染 25fps 上限，40ms 足够）
      return (await win.webContents.capturePage()).toPNG()
    }

    // ① 逐帧捕获
    const pngs = []
    for (let i = 0; i < FRAMES; i++) pngs.push(await grabFrame(i))
    ok(`逐帧捕获 ${FRAMES} 帧`, pngs.length === FRAMES && pngs.every((b) => b.length > 500),
      pngs.length + ' 帧, 最小 ' + Math.min(...pngs.map((b) => b.length)) + 'B')

    // ② 帧画面在动：首帧 vs 末帧（圆从左划到右）
    ok('帧画面在动（首尾不同）', !pngs[0].equals(pngs[FRAMES - 1]))

    // ③ 确定性复验：同帧号重捕，raw 位图一致（绕过 PNG 编码器差异，比像素本体）
    await win.webContents.executeJavaScript('render(10); true')
    await new Promise((r) => setTimeout(r, 40))
    const againImg = await win.webContents.capturePage()
    const firstImg10 = Buffer.from(againImg.toBitmap())
    const replayImg = await (async () => {
      await win.webContents.executeJavaScript('render(10); true')
      await new Promise((r) => setTimeout(r, 40))
      return win.webContents.capturePage()
    })()
    ok('同帧号画面可复现（确定性核心）', Buffer.from(replayImg.toBitmap()).equals(firstImg10))

    // ④ offscreen paint 事件流（hyperframes BeginFrame 流式收帧的 Electron 等价物）
    let paintCount = 0
    win.webContents.on('paint', () => paintCount++)
    win.webContents.setFrameRate(FPS)
    await win.webContents.executeJavaScript('render(55); true') // 触发重绘：静止页面合成器不发帧
    await new Promise((r) => setTimeout(r, 600))
    ok('offscreen paint 事件流可用', paintCount > 0, 'paintCount=' + paintCount)

    // ⑤ FFmpeg 合成（本机有才做；真实应用 convert_file 已带按需下载逻辑）
    let ff = ''
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ff = 'ffmpeg' } catch {}
    if (!ff) {
      const cand = path.join(app.getPath('userData'), 'ffmpeg', 'bin', 'ffmpeg.exe')
      if (fs.existsSync(cand)) ff = cand
    }
    if (ff) {
      const out = path.join(tmp, 'probe.mp4')
      execFileSync(ff, ['-y', '-framerate', String(FPS), '-i', path.join(framesDir, '%04d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { stdio: 'ignore' })
      const head = fs.readFileSync(out).subarray(4, 8).toString('latin1')
      ok('FFmpeg 合成 MP4（ftyp 魔数）', fs.existsSync(out) && fs.statSync(out).size > 5000 && head === 'ftyp',
        fs.existsSync(out) ? fs.statSync(out).size + 'B' : '文件不存在')
    } else {
      console.log('SKIP FFmpeg 合成（本机无 ffmpeg.exe，逐帧捕获链路已全部验证）')
    }

    win.destroy()
  } catch (e) {
    ok('探针全流程', false, e.message)
  }

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? 'VIDEO_PROBE_OK' : 'VIDEO_PROBE_FAIL'} (${pass}/${pass + fail})`)
  app.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('探针异常:', e); app.exit(1) })
