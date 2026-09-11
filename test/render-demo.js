// 一次性 demo：用 render_html 同款离屏管线渲染 design-demo.html 出 PNG
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')

app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const htmlPath = path.join(__dirname, 'fixtures', 'design-demo.html')
  const outPng = path.join(__dirname, 'fixtures', 'design-demo.png')
  const W = 1240, H = 1754, SCALE = 1
  let win = null
  try {
    win = new BrowserWindow({
      width: W * SCALE, height: 900, useContentSize: true,
      show: false, frame: false,
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    // 关键：构造函数里的高会被屏幕工作区钳制（如 1440 屏→1392），创建后 setContentSize 才能突破
    win.setContentSize(W * SCALE, H * SCALE)
    try { win.webContents.setAudioMuted(true) } catch {}
    try { win.webContents.setZoomFactor(SCALE) } catch {}
    await win.loadFile(htmlPath)
    // 等 fonts + images 就绪（与 render_html 相同逻辑）
    await win.webContents.executeJavaScript(
      "(function(){return new Promise(function(res){var n=0;(function tick(){var fontsOk=true,imgsOk=true;try{fontsOk=document.fonts.status==='loaded'}catch(e){}try{imgsOk=[].every.call(document.images,function(i){return i.complete})}catch(e){}if((fontsOk&&imgsOk)||n>55){setTimeout(function(){res(1)},100)}else{n++;setTimeout(tick,100)}})()})})()",
      true
    ).catch(() => {})
    const img = await win.webContents.capturePage()
    if (!img || img.isEmpty()) throw new Error('渲染结果为空')
    const buf = img.toPNG()
    fs.writeFileSync(outPng, buf)
    const sz = img.getSize()
    console.log(`DEMO_OK ${sz.width}x${sz.height} ${Math.round(buf.length / 1024)}KB -> ${outPng}`)
  } catch (e) {
    console.error('DEMO_FAIL', e.message)
    app.exit(1)
    return
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy() } catch {}
  }
  app.exit(0)
})
