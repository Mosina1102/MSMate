// ===== 桌宠"莫西"：透明置顶小窗 + 托盘联动 =====
// 架构分工：本模块只管窗口行为（创建/拖拽/显隐）与事件广播；
// 情绪映射、姿势轮播、气泡语在 src/pet.html 渲染层（素材 assets/moxi/）。
// 事件源：WorkAgent send 事件（与 ai:event 同源）+ 传输完成事件，经 petBroadcast 转发给桌宠。
const path = require('path')
const { BrowserWindow, Menu, screen } = require('electron')

const PET_W = 280
const PET_H = 360

function createPetManager({ getSetting, setSetting, log, isDev, showMainWindow, onEnabledChanged }) {
  let petWin = null
  let dragOffset = null // 拖拽偏移：光标相对窗口左上角（drag-start 时算好，move 只贴光标）

  const preloadPath = isDev
    ? path.join(__dirname, 'preload.js')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js')
  const htmlPath = path.join(__dirname, 'src', 'pet.html')

  function createPetWindow() {
    if (petWin && !petWin.isDestroyed()) return
    petWin = new BrowserWindow({
      width: PET_W,
      height: PET_H,
      x: screen.getPrimaryDisplay().workArea.width - PET_W - 40,
      y: screen.getPrimaryDisplay().workArea.height - PET_H - 20,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    petWin.setAlwaysOnTop(true, 'screen-saver')
    petWin.loadFile(htmlPath)
    petWin.once('ready-to-show', () => {
      log('pet: ready-to-show 触发')
      if (petWin && !petWin.isDestroyed()) { petWin.show(); log('pet: show() 已调用') }
    })
    // 消失问题排查：任何 close/hide/closed 与渲染层报错都落日志
    petWin.on('close', (e) => log('pet: close 事件'))
    petWin.on('hide', () => log('pet: hide 事件'))
    // 右键菜单：显示主界面 / 收起莫西 / 关闭桌宠
    petWin.webContents.on('context-menu', (e) => {
      e.preventDefault()
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => showMainWindow() },
        { label: '收起莫西', click: () => hidePet() },
        { type: 'separator' },
        { label: '关闭桌宠', click: () => setPetEnabled(false) }
      ]).popup({ window: petWin })
    })
    petWin.on('closed', () => { petWin = null; log('pet: closed（窗口已销毁）') })
    petWin.webContents.on('console-message', (_e, _lv, message) => { if (/error|异常|失败|Uncaught/i.test(message)) log('[pet-render] ' + message) })
    petWin.webContents.on('render-process-gone', (_e, details) => log('pet: 渲染进程崩溃 ' + JSON.stringify(details)))
    log('pet: 莫西已唤出')
  }

  function hidePet() {
    if (petWin && !petWin.isDestroyed()) petWin.hide()
  }

  function showPet() {
    if (!petWin || petWin.isDestroyed()) { createPetWindow(); return }
    petWin.show()
  }

  function destroyPet() {
    if (petWin && !petWin.isDestroyed()) petWin.destroy()
    petWin = null
  }

  // 开关（全局设置/托盘共用）：状态持久化 settings.petEnabled
  // 幂等：on 且窗口已存在时只 show 不重建——防"菜单文案翻转期连点"把刚唤出的莫西误关
  async function setPetEnabled(on) {
    await setSetting('petEnabled', !!on)
    if (on) {
      if (petWin && !petWin.isDestroyed()) petWin.show()
      else createPetWindow()
    } else destroyPet()
    if (onEnabledChanged) onEnabledChanged(!!on)
    log('pet: ' + (on ? '开启' : '关闭'))
  }

  function isPetEnabled() {
    return !!petWin && !petWin.isDestroyed()
  }

  // Agent/传输事件 → 桌宠渲染层（情绪状态机在 pet.html）
  function petBroadcast(event) {
    if (petWin && !petWin.isDestroyed()) {
      try { petWin.webContents.send('pet:event', event) } catch {}
    }
  }

  // 拖拽：mousedown 记录"光标-窗口"偏移，mousemove 光标坐标减偏移即窗口位置（贴边收敛防拖丢）
  function dragStart(sx, sy) {
    if (!petWin || petWin.isDestroyed()) return
    const [wx, wy] = petWin.getPosition()
    dragOffset = { dx: sx - wx, dy: sy - wy }
  }

  function dragMove(sx, sy) {
    if (!petWin || petWin.isDestroyed() || !dragOffset) return
    const wa = screen.getPrimaryDisplay().workArea
    const x = Math.min(Math.max(sx - dragOffset.dx, wa.x - PET_W + 60), wa.x + wa.width - 60)
    const y = Math.min(Math.max(sy - dragOffset.dy, wa.y), wa.y + wa.height - 80)
    petWin.setPosition(x, y)
  }

  return { createPetWindow, showPet, hidePet, destroyPet, setPetEnabled, isPetEnabled, petBroadcast, dragStart, dragMove, PET_W, PET_H }
}

module.exports = { createPetManager }
