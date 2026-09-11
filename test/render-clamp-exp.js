// 实验：找 Electron 22 离屏窗口突破工作区钳制的方法
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow } = require('electron')

app.on('window-all-closed', () => {})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tryMethod(name, fn) {
  let win = null
  try {
    win = fn()
    try { win.webContents.setAudioMuted(true) } catch {}
    await win.loadFile(path.join(__dirname, 'fixtures', 'design-demo.html'))
    await sleep(250)
    const img = await win.webContents.capturePage()
    const sz = img ? img.getSize() : { width: 0, height: 0 }
    console.log(`[${name}] captured ${sz.width}x${sz.height}`)
  } catch (e) {
    console.log(`[${name}] FAIL ${e.message}`)
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy() } catch {}
  }
  await sleep(400)
}

app.whenReady().then(async () => {
  const base = { show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true } }

  await tryMethod('A-构造函数直给1754', () => new BrowserWindow({ ...base, width: 1240, height: 1754 }))

  await tryMethod('B-创建后setSize(1754)', () => {
    const w = new BrowserWindow({ ...base, width: 1240, height: 900 })
    w.setSize(1240, 1754)
    return w
  })

  await tryMethod('C-创建后setContentSize(1754)', () => {
    const w = new BrowserWindow({ ...base, width: 1240, height: 900 })
    w.setContentSize(1240, 1754)
    return w
  })

  await tryMethod('D-setMaximumSize解除+setSize', () => {
    const w = new BrowserWindow({ ...base, width: 1240, height: 900 })
    w.setMaximumSize(0, 0)
    w.setSize(1240, 1754)
    return w
  })

  await tryMethod('E-capturePage(rect全页)', () => {
    const w = new BrowserWindow({ ...base, width: 1240, height: 900 })
    w._wantRect = { x: 0, y: 0, width: 1240, height: 1754 }
    // capturePage(rect) 在 tryMethod 里没传 rect，这里单独处理不了，跳过
    return w
  })

  app.exit(0)
})
