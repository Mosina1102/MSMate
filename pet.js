// ===== 桌宠"莫西"：透明置顶小窗 + 托盘联动 =====
// 架构分工：本模块只管窗口行为（创建/拖拽/显隐）与事件广播；
// 情绪映射、姿势轮播、气泡语在 src/pet.html 渲染层（素材 assets/moxi/）。
// 事件源：WorkAgent send 事件（与 ai:event 同源）+ 传输完成事件，经 petBroadcast 转发给桌宠。
const path = require('path')
const { app, BrowserWindow, Menu, screen } = require('electron')

const PET_W = 292
const PET_H = 330
// 尺寸档位（比例 × 基准 280x360）：settings.petScale 持久化；
// 渲染层用 body.style.zoom 整体等比缩放——精灵图 background-size 写死定律不动
const PET_SCALES = [
  { key: 'small', label: '小', k: 0.75 },
  { key: 'medium', label: '标准', k: 1 },
  { key: 'large', label: '大', k: 1.3 },
  { key: 'xl', label: '特大', k: 1.6 }
]

function createPetManager({ getSetting, setSetting, log, isDev, showMainWindow, onEnabledChanged }) {
  let petWin = null
  let dragOffset = null // 拖拽偏移：光标相对窗口左上角（drag-start 时算好，move 只贴光标）

  // preload 路径按"是否真打包"判定：isDev 参数是 --dev 启动参数判定，npx electron . 时为 false
  // 会误指 resourcesPath（那里没有 asar.unpacked）→ 桌宠情绪联动静默失效（主进程日志实锤）
  const preloadPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js')
    : path.join(__dirname, 'preload.js')
  const htmlPath = path.join(__dirname, 'src', 'pet.html')

  function petScale() {
    const k = Number(getSetting('petScale'))
    return PET_SCALES.some((s) => s.k === k) && k > 0 ? k : 1
  }

  function createPetWindow() {
    if (petWin && !petWin.isDestroyed()) return
    const k = petScale()
    const W = Math.round(PET_W * k)
    const H = Math.round(PET_H * k)
    petWin = new BrowserWindow({
      width: W,
      height: H,
      x: screen.getPrimaryDisplay().workArea.width - W - 40,
      y: screen.getPrimaryDisplay().workArea.height - H - 20,
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
    // 默认全窗鼠标穿透（forward 模式仅转发 mousemove 供渲染层坐标判定）：
    // 判定框=角色可视框（老大定调），悬停角色框内渲染层才回调恢复接收；空白处点击/右键穿透直达桌面
    try { petWin.setIgnoreMouseEvents(true, { forward: true }) } catch {}
    petWin.loadFile(htmlPath)
    petWin.once('ready-to-show', () => {
      log('pet: ready-to-show 触发')
      if (petWin && !petWin.isDestroyed()) {
        petWin.show(); log('pet: show() 已调用')
        try { petWin.webContents.send('pet:scale', petScale()) } catch {} // 渲染层 body.zoom 等比缩放
      }
    })
    // 右键菜单：显示主界面 / 大小 / 收起莫西 / 关闭桌宠
    petWin.webContents.on('context-menu', (e) => {
      e.preventDefault()
      const cur = petScale()
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => showMainWindow() },
        {
          label: '大小',
          submenu: PET_SCALES.map((s) => ({
            label: (Math.abs(s.k - cur) < 0.01 ? '✓ ' : '') + s.label,
            click: () => setPetScale(s.k)
          }))
        },
        { type: 'separator' },
        { label: '关闭桌宠', click: () => setPetEnabled(false) }
      ]).popup({ window: petWin })
    })
    // 消失问题排查：任何 close/hide/closed 与渲染层报错都落日志
    petWin.on('close', (e) => log('pet: close 事件'))
    petWin.on('hide', () => log('pet: hide 事件'))
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

  // 尺寸切换：窗口 setSize（锚左上角防出屏简单收敛）+ 渲染层 body.zoom + 持久化
  async function setPetScale(k) {
    const v = PET_SCALES.some((s) => s.k === k) ? k : 1
    await setSetting('petScale', v)
    if (petWin && !petWin.isDestroyed()) {
      const W = Math.round(PET_W * v)
      const H = Math.round(PET_H * v)
      const wa = screen.getPrimaryDisplay().workArea
      const [x, y] = petWin.getPosition()
      // 收敛防出屏：窗口整体留在工作区内
      const nx = Math.min(Math.max(x, wa.x - W + 60), wa.x + wa.width - 60)
      const ny = Math.min(Math.max(y, wa.y), wa.y + wa.height - 80)
      petWin.setBounds({ x: nx, y: ny, width: W, height: H })
      try { petWin.webContents.send('pet:scale', v) } catch {}
    }
    log('pet: scale=' + v)
  }

  // Agent/传输事件 → 桌宠渲染层（情绪状态机在 pet.html）
  function petBroadcast(event) {
    if (petWin && !petWin.isDestroyed()) {
      try { petWin.webContents.send('pet:event', event) } catch {}
    }
  }

  // 判定框穿透开关（渲染层按鼠标是否落在角色框内回调）：true=穿透（空白处），false=接收事件（角色上）
  function setMouseIgnore(ignore) {
    if (petWin && !petWin.isDestroyed()) {
      try { petWin.setIgnoreMouseEvents(!!ignore, { forward: true }) } catch {}
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
    const b = petWin.getBounds()
    const W = b.width, H = b.height
    const wa = screen.getPrimaryDisplay().workArea
    const x = Math.min(Math.max(sx - dragOffset.dx, wa.x - W + 60), wa.x + wa.width - 60)
    const y = Math.min(Math.max(sy - dragOffset.dy, wa.y), wa.y + wa.height - 80)
    petWin.setPosition(x, y)
  }

  return { createPetWindow, showPet, hidePet, destroyPet, setPetEnabled, isPetEnabled, petBroadcast, dragStart, dragMove, setMouseIgnore, setPetScale, petScale, PET_W, PET_H }
}

module.exports = { createPetManager }
