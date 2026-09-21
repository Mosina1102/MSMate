// ===== 内置截图（参考 QQ 截图）：全局快捷键 → 抓屏 → 全屏选区/标注 → 保存+剪贴板+注入聊天 =====
// 流程：Ctrl+Shift/A 或 Work 按钮 → 主窗口暂隐（不截自己）→ desktopCapturer 抓主屏物理分辨率一帧
//       → 全屏 capture 窗口铺快照 → 拖选区 + 标注（箭头/矩形/椭圆/画笔/文字/撤销）
//       → 确认：PNG 存工作区「MSMate生成/截图」+ 写剪贴板 + 自动注入聊天引用（work._appendChatRef）
// 坐标体系：canvas 全程物理像素（逻辑坐标 × scaleFactor），导出无损。
const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, clipboard, nativeImage } = require('electron')

const CAPTURE_HOTKEY = 'Ctrl+Shift+A'
const STOP_HOTKEY = 'Ctrl+Shift+X'

function createCaptureManager({ getMainWindow, workspaceDir, log, isDev, appendChatRef, onStop }) {
  let capWin = null
  let wasMainVisible = false
  let inited = false
  // ===== 控制遮罩（Mate 正在控制电脑）：desktop_* 调用期间全屏半透明提示 =====
  // ignoreMouseEvents 鼠标穿透：用户随时可抢回控制权；Ctrl+Shift+X 紧急停止 = 中止 agent + 关遮罩
  let overlayWin = null
  let overlayTimer = null
  let controlAborted = false

  // preload 路径按"是否真打包"判定（app.isPackaged），与主窗口同款——npx 开发启动走 __dirname
  const preloadPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js')
    : path.join(__dirname, 'preload.js')
  const htmlPath = path.join(__dirname, 'src', 'capture.html')

  function log_(m) { try { log(m) } catch {} }

  // 抓主屏一帧（物理分辨率；display_id 匹配主显示器，复用 tools.js captureScreenShot 的选源逻辑）
  async function grabPrimary() {
    const pri = screen.getPrimaryDisplay()
    const sw = Math.round(pri.size.width * pri.scaleFactor)
    const sh = Math.round(pri.size.height * pri.scaleFactor)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: sw, height: sh } })
    if (!sources.length) throw new Error('系统没有可用的屏幕源')
    let src = sources[0]
    try {
      const hit = sources.find((s) => String(s.display_id) === String(pri.id()))
      if (hit) src = hit
    } catch {}
    const img = src.thumbnail
    if (!img || img.isEmpty()) throw new Error('屏幕抓帧为空（可能被系统策略限制）')
    return { dataURL: img.toDataURL(), scale: pri.scaleFactor, bounds: pri.bounds }
  }

  async function startCapture() {
    try {
      if (capWin && !capWin.isDestroyed()) return // 防重入
      const main = getMainWindow()
      wasMainVisible = !!(main && !main.isDestroyed() && main.isVisible())
      if (main && !main.isDestroyed()) main.hide()
      await new Promise((r) => setTimeout(r, 160)) // 等主窗口真消失，避免截到自家窗体
      const shot = await grabPrimary()
      openCapWindow(shot)
    } catch (e) {
      log_('[capture] 启动失败: ' + e.message)
      restoreMain()
    }
  }

  function openCapWindow(shot) {
    const { bounds, scale } = shot
    capWin = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: false, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      show: false,
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false }
    })
    capWin.setAlwaysOnTop(true, 'screen-saver')
    capWin.loadFile(htmlPath)
    capWin.once('ready-to-show', () => {
      if (capWin && !capWin.isDestroyed()) {
        capWin.show()
        capWin.focus()
        try { capWin.webContents.send('capture:bg', shot) } catch {}
      }
    })
    capWin.on('closed', () => { capWin = null })
    capWin.webContents.on('console-message', (_e, _lv, message) => { if (/error|异常|失败|Uncaught/i.test(message)) log_('[capture-render] ' + message) })
  }

  function closeCapWindow() {
    if (capWin && !capWin.isDestroyed()) capWin.destroy()
    capWin = null
  }

  function restoreMain() {
    const main = getMainWindow()
    if (wasMainVisible && main && !main.isDestroyed()) { main.show(); main.focus() }
    wasMainVisible = false
  }

  // 确认：物理像素 dataURL → 存工作区「MSMate生成/截图」+ 剪贴板 + 注入聊天引用
  function finishWithDataURL(dataURL) {
    let savedPath = ''
    try {
      const dir = path.join(workspaceDir || '', 'MSMate生成', '截图')
      fs.mkdirSync(dir, { recursive: true })
      const d = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      savedPath = path.join(dir, `截图-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`)
      fs.writeFileSync(savedPath, Buffer.from(String(dataURL).split(',')[1] || '', 'base64'))
    } catch (e) { log_('[capture] 保存失败: ' + e.message) }
    try {
      const img = nativeImage.createFromDataURL(dataURL)
      if (!img.isEmpty()) clipboard.writeImage(img)
    } catch (e) { log_('[capture] 剪贴板失败: ' + e.message) }
    closeCapWindow()
    restoreMain()
    if (savedPath) {
      if (typeof appendChatRef === 'function') { try { appendChatRef(savedPath) } catch {} }
      const main = getMainWindow()
      if (main && !main.isDestroyed()) { try { main.webContents.send('capture:done', { path: savedPath }) } catch {} }
    }
  }

  function init() {
    if (inited) return
    inited = true
    // 全局快捷键（QQ 式随时可截）；被其他应用占用则降级为仅按钮入口
    try {
      const okReg = globalShortcut.register(CAPTURE_HOTKEY, () => { startCapture() })
      if (!okReg) log_(`[capture] 全局快捷键 ${CAPTURE_HOTKEY} 注册失败（被其他应用占用），仅保留按钮入口`)
    } catch (e) { log_('[capture] 快捷键注册异常: ' + e.message) }
    // 紧急停止热键：AI 控制电脑时用户随时可按，立即中止 agent + 关遮罩 + 拒绝后续 desktop_*
    try {
      const okStop = globalShortcut.register(STOP_HOTKEY, () => { emergencyStop() })
      if (!okStop) log_(`[control] 紧急停止快捷键 ${STOP_HOTKEY} 注册失败`)
    } catch (e) { log_('[control] 急停快捷键注册异常: ' + e.message) }

    ipcMain.on('capture:start', () => { startCapture() })
    ipcMain.on('capture:done', (_e, data) => {
      const d = String((data && data.dataURL) || '')
      if (d.startsWith('data:image/png;base64,')) finishWithDataURL(d)
      else { closeCapWindow(); restoreMain() }
    })
    ipcMain.on('capture:cancel', () => { closeCapWindow(); restoreMain() })
  }

  function destroy() {
    try { globalShortcut.unregister(CAPTURE_HOTKEY) } catch {}
    try { globalShortcut.unregister(STOP_HOTKEY) } catch {}
    hideControlOverlay()
    closeCapWindow()
  }

  // ===== 控制遮罩 =====
  function showControlOverlay() {
    controlAborted = false
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null }
    if (!overlayWin || overlayWin.isDestroyed()) {
      const pri = screen.getPrimaryDisplay()
      overlayWin = new BrowserWindow({
        x: pri.bounds.x, y: pri.bounds.y, width: pri.bounds.width, height: pri.bounds.height,
        frame: false, transparent: true, resizable: false, movable: false,
        alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
        show: false,
        ignoreMouseEvents: true, // 鼠标穿透：遮罩纯提示，用户操作不受阻可随时抢回
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
      })
      overlayWin.setAlwaysOnTop(true, 'screen-saver')
      overlayWin.loadFile(path.join(__dirname, 'src', 'control-overlay.html'))
      overlayWin.once('ready-to-show', () => { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive() })
    } else {
      overlayWin.showInactive()
    }
    armOverlayIdle()
  }
  function armOverlayIdle() {
    if (overlayTimer) clearTimeout(overlayTimer)
    overlayTimer = setTimeout(() => hideControlOverlay(), 15000) // 15s 无控制活动自动收起（不挡屏不碍事）
  }
  function hideControlOverlay() {
    if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null }
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy()
    overlayWin = null
  }
  // 截图前临时隐藏：遮罩会污染 AI 的视觉定位（view_image 要看真实界面），截完恢复
  function hideOverlayForShot() { if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null }; if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide() }
  function restoreOverlayAfterShot() { if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.showInactive(); armOverlayIdle() } }
  function emergencyStop() {
    controlAborted = true
    hideControlOverlay()
    log_('[control] 紧急停止：用户按了 ' + STOP_HOTKEY + '（agent 中止 + 遮罩关闭，desktop_* 后续调用被拒）')
    if (typeof onStop === 'function') { try { onStop() } catch {} } // 中止运行中的 agent（聊天里会出现中止提示）
  }

  return {
    init, startCapture, destroy, CAPTURE_HOTKEY,
    controlOverlay: {
      touch: () => { if (controlAborted) return; showControlOverlay() },
      hideForShot: hideOverlayForShot,
      restoreAfterShot: restoreOverlayAfterShot,
      isAborted: () => controlAborted
    }
  }
}

module.exports = { createCaptureManager, CAPTURE_HOTKEY }
