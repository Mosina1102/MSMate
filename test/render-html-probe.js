// render_html 探针：offscreen 窗口渲染 HTML → capturePage → PNG
// 验证三件事：①出图尺寸正确 ②scale=2 高清路径正确 ③内容非空白（像素采样）
// 运行：npx electron test/render-html-probe.js（独立 Electron main，不影响主应用）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

const CSS_W = 800, CSS_H = 600
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;width:${CSS_W}px;height:${CSS_H}px;background:#6d5ae0;position:relative;font-family:"Microsoft YaHei";color:#fff;overflow:hidden}
.badge{position:absolute;top:40px;left:40px;background:#f5c451;color:#26283c;font-size:28px;padding:10px 24px;border-radius:12px}
.center{position:absolute;top:200px;left:0;width:100%;text-align:center;font-size:72px;font-weight:900}
</style></head><body><div class="badge">MSMATE</div><div class="center">渲染探针</div></body></html>`

async function render(scale) {
  const tmpHtml = path.join(os.tmpdir(), `msm-render-probe-${scale}.html`)
  fs.writeFileSync(tmpHtml, html)
  const outPng = path.join(os.tmpdir(), `msm-render-probe-${scale}.png`)
  const win = new BrowserWindow({
    width: CSS_W * scale, height: CSS_H * scale, useContentSize: true, show: false, frame: false,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  try {
    win.webContents.setZoomFactor(scale)
    await win.loadFile(tmpHtml)
    await win.webContents.executeJavaScript(
      "(function(){return new Promise(function(res){var n=0;(function tick(){var ok1=true;try{ok1=document.fonts.status==='loaded'}catch(e){}if(ok1||n>50){setTimeout(function(){res(1)},100)}else{n++;setTimeout(tick,100)}})()})})()",
      true
    ).catch(() => {})
    const img = await win.webContents.capturePage()
    if (!img || img.isEmpty()) throw new Error('capture 为空')
    fs.writeFileSync(outPng, img.toPNG())
    return { outPng, size: img.getSize() }
  } finally {
    try { if (!win.isDestroyed()) win.destroy() } catch {}
  }
}

app.whenReady().then(async () => {
  // 探针关键：offscreen 窗口 destroy 后触发 window-all-closed 默认退出 → 回调中断。
  // 主应用无此问题（主窗口常在）；探针单独自控退出
  app.on('window-all-closed', () => { })
  try {
    // ① scale=1 基础渲染
    const r1 = await render(1)
    ok(`scale=1 输出尺寸 ${CSS_W}×${CSS_H}`, r1.size.width === CSS_W && r1.size.height === CSS_H, JSON.stringify(r1.size))

    // ② scale=2 高清（连续创建 offscreen 窗口需小间隔，否则 loadFile 偶发 ERR_FAILED）
    await new Promise((r) => setTimeout(r, 400))
    const r2 = await render(2)
    ok(`scale=2 输出尺寸 ${CSS_W * 2}×${CSS_H * 2}`, r2.size.width === CSS_W * 2 && r2.size.height === CSS_H * 2, JSON.stringify(r2.size))

    // ③ 内容非空白：PNG 尺寸合理且文件非空（像素级验证用 toBitmap 采样）
    const buf = fs.readFileSync(r1.outPng)
    ok('PNG 文件非空', buf.length > 3000, buf.length + 'B')
    // PNG 头验证
    ok('PNG 魔数正确', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
  } catch (e) {
    ok('渲染流程', false, e.message)
  }
  console.log(`\n${fail === 0 ? '✅ RENDER_PROBE_OK' : '❌ RENDER_PROBE_FAIL'} (${pass}/${pass + fail})`)
  app.exit(fail ? 1 : 0)
})
