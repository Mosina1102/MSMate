const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, session } = require('electron')
const path = require('path')
const os = require('os')
const net = require('net')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')

// Windows 通知必需：设置 AppUserModelId，否则系统通知不弹出
app.setAppUserModelId('com.ms-interconnect.app')

// 对讲机：允许未经用户手势自动播放音频（对方喊话时直接外放）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 单实例控制：多次打开只保留一个实例，第二次打开时聚焦到已有窗口
// MSC_USER_DATA 环境变量可覆盖配置目录（用于多开测试）
if (process.env.MSC_USER_DATA) app.setPath('userData', process.env.MSC_USER_DATA)
else {
  // 产品更名 MSWork → MSMate 后默认配置目录会变，沿用旧目录保证用户数据（设置/快照/记忆）连续
  try {
    const defaultUserData = app.getPath('userData')
    const legacyDir = path.join(path.dirname(defaultUserData), 'MSWork')
    const defaultEmpty = !fs.existsSync(defaultUserData) || fs.readdirSync(defaultUserData).length === 0
    if (defaultEmpty && fs.existsSync(legacyDir)) app.setPath('userData', legacyDir)
  } catch {}
}
// v2.5.6：进度窗进程下线——它从旧 exe 运行且全程存活，锁死安装目录里的 MSMate.exe，
// 升级卸载旧版时文件被锁必炸（F 盘安装 + C 盘 TEMP 跨盘 Rename 也必炸）。改回直接静默安装，
// "正在安装"感知由主窗口遮罩提供（app.js installUpdateNow），装完由安装器自动拉起新版。
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// === Early logging (before app ready) ===
const earlyLogDir = process.env.LOCALAPPDATA || os.tmpdir()
let logFile = path.join(earlyLogDir, 'lan-transfer-boot.log')

function log(msg) {
  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${msg}\n`
  try { fs.appendFileSync(logFile, line) } catch {}
}

log('=== Starting LAN Transfer ===')
log(`platform: ${os.platform()}`)
log(`isPackaged: ${app.isPackaged}`)
log(`resourcesPath: ${process.resourcesPath}`)
log(`__dirname: ${__dirname}`)

// === Error handlers ===
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT: ${err.message}\n${err.stack}`)
  try { dialog.showErrorBox('程序错误', `程序发生错误:\n${err.message}`) } catch {}
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`)
})

let mainWindow = null
let tcpAgent = null
let udpDiscovery = null
let authManager = null
let tray = null

const isDev = process.argv.includes('--dev')

log(`isDev: ${isDev}`)

let TCPAgent, createOfficeFile, UDPDiscovery, AuthManager, getDiskSpace
let HotkeyListener
let NetRelay
let ipv6Invite
let netRelay = null
try {
  log('Loading modules...')
  const tcpModule = require('./server/tcpAgent')
  TCPAgent = tcpModule.TCPAgent
  createOfficeFile = tcpModule.createOfficeFile
  UDPDiscovery = require('./server/udpDiscovery').UDPDiscovery
  AuthManager = require('./server/authManager').AuthManager
  getDiskSpace = require('./server/diskSpace').getDiskSpace
  HotkeyListener = require('./server/hotkeyListener').HotkeyListener
  NetRelay = require('./server/netRelay').NetRelay
  ipv6Invite = require('./server/ipv6Invite')
  log('Modules loaded successfully')
} catch (err) {
  log(`Module load failed: ${err.message}\n${err.stack}`)
  try { dialog.showErrorBox('模块加载失败', `${err.message}`) } catch {}
  process.exit(1)
}

// MSWork AI 模块（加载失败不阻塞主程序，仅禁用 AI 功能）
let SiliconFlowClient, SnapshotManager, createTools, WorkAgent, SessionStore, httpGet
let workAgent = null
let aiTools = null
let sessionStore = null // 多会话索引/存储
let createAgentInstance = null // init 时注入的 Agent 工厂
let packData = null // 数据同步导出打包（ai/data-sync.js）
let applyImport = null // 数据同步导入还原（ai/data-sync.js）
const workAgents = new Map() // sessionId -> WorkAgent（懒创建，支持多会话同时运行）
const MAX_CONCURRENT_RUNS = 4 // 同时运行的 AI 会话上限
try {
  ;({ SiliconFlowClient } = require('./ai/siliconflow'))
  ;({ resolveModelProvider } = require('./ai/tools'))
  ;({ httpGet } = require('./ai/tools'))
  ;({ httpDownload } = require('./ai/tools'))
  ;({ SnapshotManager } = require('./ai/snapshots'))
  ;({ createTools } = require('./ai/tools'))
  ;({ WorkAgent } = require('./ai/agent'))
  ;({ releaseManualsTo } = require('./ai/prompt'))
  ;({ SessionStore } = require('./ai/sessions'))
  ;({ packData, applyImport } = require('./ai/data-sync'))
  log('AI modules loaded successfully')
} catch (err) {
  log(`AI modules load failed: ${err.message}\n${err.stack}`)
}

function getWorkAgent(sessionId) {
  const sid = sessionId || (sessionStore && sessionStore.list()[0] && sessionStore.list()[0].id)
  if (!sid) return workAgent
  if (!workAgents.has(sid) && createAgentInstance) workAgents.set(sid, createAgentInstance(sid))
  return workAgents.get(sid) || null
}

function runningAgentCount() {
  let n = 0
  for (const a of workAgents.values()) if (a.running) n++
  return n
}

function createWindow() {
  const appPath = app.getAppPath()
  const preloadPath = isDev
    ? path.join(__dirname, 'preload.js')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'preload.js')
  const htmlPath = path.join(appPath, 'src', 'index.html')
  const iconPath = path.join(appPath, 'assets', 'icon.png')

  log(`createWindow: preloadPath=${preloadPath}`)
  log(`createWindow: htmlPath=${htmlPath}`)
  log(`createWindow: preload exists=${fs.existsSync(preloadPath)}`)
  log(`createWindow: html exists=${fs.existsSync(htmlPath)}`)

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'MSMate - 互联 · AI 电脑助手',
    icon: iconPath,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true // 工作台网页版模型（DeepSeek 网页版内嵌自动对话）
    }
  })

  mainWindow.setMenuBarVisibility(false)

  // F12 or Ctrl+Shift+I to toggle DevTools for debugging
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || 
        (input.control && input.shift && input.key === 'I'))) {
      mainWindow.webContents.toggleDevTools()
    }
  })

  // 全局右键菜单：输入框（剪切/粘贴/全选）与选中文字（复制）全界面通用——
  // Work 工作区、设置表单、聊天框等默认没有系统右键菜单，必须手动挂
  mainWindow.webContents.on('context-menu', (event, params) => {
    const editable = params.isEditable
    const hasSelection = params.selectionText && params.selectionText.trim().length > 0
    if (!editable && !hasSelection) return // 空白处右键不弹菜单
    const template = []
    if (editable) {
      template.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }
      )
    }
    if (hasSelection) {
      template.push({ role: 'copy', label: '复制' })
    }
    if (editable) {
      template.push(
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      )
    }
    Menu.buildFromTemplate(template).popup({ window: mainWindow })
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    log('mainWindow shown')
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    const errMsg = `页面加载失败:\n错误代码: ${errorCode}\n描述: ${errorDescription}`
    log(`did-fail-load: ${errMsg}`)
    console.error('页面加载失败:', errorCode, errorDescription)
    try { dialog.showErrorBox('加载失败', errMsg) } catch {}
  })

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    const errMsg = `渲染进程崩溃:\n原因: ${details.reason}`
    log(`render-process-gone: ${errMsg}`)
    console.error('渲染进程崩溃:', details.reason)
    try { dialog.showErrorBox('渲染错误', errMsg) } catch {}
  })

  // 卡死侦探：窗口无响应时记日志（配合主进程每次工具调用的时间戳日志定位卡点）
  mainWindow.webContents.on('unresponsive', () => {
    log('UI-UNRESPONSIVE: 窗口无响应（渲染进程主线程阻塞或主进程事件循环卡住）')
  })
  mainWindow.webContents.on('responsive', () => {
    log('UI-RESPONSIVE: 窗口恢复响应')
  })

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['VERBOSE', 'INFO', 'WARNING', 'ERROR']
    const line2 = `[Renderer ${levels[level]}] ${message} (${sourceId}:${line})`
    console.log(line2)
    log(line2)
  })

  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.loadFile(htmlPath).catch(err => {
    console.error('loadFile 失败:', err)
    dialog.showErrorBox('加载失败', `无法加载页面:\n${err.message}`)
  })

  // 最小化到托盘而不是退出
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      mainWindow.webContents.send('tray:minimized')
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault()
  })

  mainWindow.webContents.on('new-window', (e, url) => {
    e.preventDefault()
    shell.openExternal(url)
  })
}

function createTray() {
  const appPath = app.getAppPath()
  const iconPath = path.join(appPath, 'assets', 'icon.png')
  
  let trayIcon
  try {
    trayIcon = require('electron').nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) trayIcon = undefined
  } catch {}

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus() } } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit() } }
  ])

  tray = new Tray(trayIcon || undefined)
  tray.setToolTip('MS互联 - 局域网文件共享')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

// ===== 互联网传输每日限额（v0.5）：公网 IP 连接的收发流量 2GB/天，局域网不限 =====
// 计数在 tcpAgent 按连接的公网/桥接标记累加，这里只负责"当日窗口 + 持久化"（3 秒防抖落盘，别让每个 chunk 都写盘）
const NET_DAILY_LIMIT = 2 * 1024 * 1024 * 1024
let _netUsage = null
let _netSaveTimer = null

function netUsageToday() {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (!_netUsage || _netUsage.date !== today) _netUsage = { date: today, bytes: 0 }
  return _netUsage
}

function netUsagePersist() {
  clearTimeout(_netSaveTimer)
  _netSaveTimer = setTimeout(() => { try { setSetting('netUsage', _netUsage) } catch { } }, 3000)
}

function netQuotaHooks() {
  try { _netUsage = getSetting('netUsage') || null } catch { _netUsage = null }
  return {
    // 发向：超额拒绝（返回 false 时 tcpAgent 会断开该公网连接）
    take(n) {
      const u = netUsageToday()
      if (u.bytes + n > NET_DAILY_LIMIT) return false
      u.bytes += n
      netUsagePersist()
      return true
    },
    // 收向：只累计不拦截（对方发送端有自己的出向额度兜底）
    add(n) {
      const u = netUsageToday()
      u.bytes += n
      netUsagePersist()
    }
  }
}

function netQuotaLeft() { return Math.max(0, NET_DAILY_LIMIT - netUsageToday().bytes) }

function initServices() {
  log('initServices:开始初始化...')
  const userDataPath = app.getPath('userData')
  log(`userDataPath: ${userDataPath}`)
  
  authManager = new AuthManager(userDataPath)
  log('authManager created')

  tcpAgent = new TCPAgent(authManager, { netQuota: netQuotaHooks() })
  log('tcpAgent created')

  // 互联网传输超额：通知渲染层弹提示（连接已被 tcpAgent 断开）
  tcpAgent.on('net-quota-exceeded', () => {
    try { if (mainWindow) mainWindow.webContents.send('net-quota-exceeded') } catch { }
  })

  // 自净化：清理历史脏数据（旧版本 bug 会把"自己"写进 IPv6 设备表），守住后不再混入
  try {
    const peers = getIpv6Peers()
    if (tcpAgent.deviceId && peers[tcpAgent.deviceId]) {
      delete peers[tcpAgent.deviceId]
      setSetting('ipv6Peers', peers)
      log('[安全] 已从 IPv6 设备表清除本机条目（历史脏数据）')
    }
  } catch {}

  // MSWork AI 助手初始化
  if (WorkAgent) {
    try {
      // 默认不预置 API Key：用户需在设置里填自己的 Key（不打包任何密钥进软件）
      const snapshots = new SnapshotManager({ dir: path.join(userDataPath, 'mswork_snapshots'), log })
      const desktopDir = app.getPath('desktop')
      // AI 工作台：助理的专属文件区（记事本、中间成果、收集的信息都放这里）
      const workspaceDir = path.join(userDataPath, 'workspace')
      try { fs.mkdirSync(workspaceDir, { recursive: true }) } catch {}
      // 工具手册释放：asar 内 ai/manuals/*.md → 工作区 ai_manuals/（每次启动覆盖，升级即更新）
      try { releaseManualsTo(workspaceDir) } catch {}
      const tools = createTools({
        tcpAgent,
        snapshots,
        desktopDir,
        tmpDir: userDataPath,
        workspaceDir,
        getSetting,
        setSetting,
        log,
        // 下载进度 → 聊天框顶部进度条（渲染层）
        onDownloadProgress: (info) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:download-progress', info)
        },
        // AI 打开的文件/网址 → 渲染层工作台页签（Work 模式在工作台预览；互联模式渲染层自行回退系统打开）
        onWorkbenchOpen: (payload) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:workbench-open', payload)
        }
      })
      aiTools = tools
      // 多会话：每个会话一个独立 WorkAgent（各自历史/检查点/运行状态），可同时运行
      createAgentInstance = (sessionId) => {
        const pvMain = resolveModelProvider(getSetting, 'main') // 多运营商：每次建 agent 重新解析主模型槽位（切换服务商即时生效，v2.4.61）
        const agent = new WorkAgent({
          client: new SiliconFlowClient({ apiKey: (pvMain && pvMain.apiKey) || getSetting('aiApiKey') || undefined, baseUrl: pvMain && pvMain.baseUrl }),
          tools,
          snapshots,
          tcpAgent,
          getSetting,
          setSetting,
          send: (event) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:event', { ...event, sessionId })
          },
          log,
          hostName: getSetting('deviceName') || os.hostname(),
          desktopDir,
          workspaceDir,
          // 网页版模型（[网页]DeepSeek）：把对话请求转给渲染层的工作台内嵌网页引擎执行
          webChatAsk: (payload) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ai:webchat-ask', { sessionId, ...payload })
          }
        })
        agent.setHistoryDir(path.join(userDataPath, 'ai-chat', 'sessions', sessionId))
        return agent
      }
      sessionStore = new SessionStore(path.join(userDataPath, 'ai-chat'))
      try { sessionStore.migrate(userDataPath) } catch {} // 旧单历史文件 → 第一个会话
      try { sessionStore.ensureDefault() } catch {}
      workAgent = getWorkAgent(sessionStore.list()[0].id)
      registerAIIPC()
      log('WorkAgent initialized')
    } catch (err) {
      log(`WorkAgent init failed: ${err.message}\n${err.stack}`)
    }
  }
  
  udpDiscovery = new UDPDiscovery()
  log('udpDiscovery created')

  // 加载自定义设备名并应用到 TCP / UDP 发现
  try {
    const savedName = getSetting('deviceName')
    if (savedName) {
      tcpAgent.deviceName = savedName
      if (udpDiscovery.setDeviceName) udpDiscovery.setDeviceName(savedName)
      log(`loaded deviceName: ${savedName}`)
    }
  } catch (err) {
    log(`load deviceName error: ${err.message}`)
  }

  // 加载设备扫描频率（全局设置 → 互联与传输）
  try {
    const savedInterval = parseInt(getSetting('scanIntervalMs'), 10)
    if (savedInterval && udpDiscovery.setBroadcastInterval) {
      udpDiscovery.setBroadcastInterval(savedInterval)
      log(`loaded scanIntervalMs: ${savedInterval}`)
    }
  } catch (err) {
    log(`load scanIntervalMs error: ${err.message}`)
  }

  log('initServices:注册事件监听...')

  tcpAgent.on('log', (msg) => {
    if (mainWindow) mainWindow.webContents.send('tcp:log', msg)
  })
  tcpAgent.on('device-found', (device) => {
    if (mainWindow) mainWindow.webContents.send('device:found', device)
  })
  tcpAgent.on('device-lost', (deviceId) => {
    if (mainWindow) mainWindow.webContents.send('device:lost', deviceId)
  })
  tcpAgent.on('file-transfer-progress', (data) => {
    if (mainWindow) mainWindow.webContents.send('transfer:progress', data)
  })
  tcpAgent.on('file-transfer-complete', (data) => {
    if (mainWindow) mainWindow.webContents.send('transfer:complete', data)
    saveTransferHistory(data)

    // 智能通知：对方发来文件或编辑了文件（带上对方设备名）
    if (data.direction === 'upload' && data.path) {
      const fileName = path.basename(data.path)
      const device = getDeviceNameById(data.deviceId)
      const isEdit = data.isEdit === true
      const title = isEdit ? '✏ 对方编辑了文件' : '📥 对方发来了文件'
      const body = (device ? `[${device}] ` : '') + (isEdit ? `${fileName} 已被对方修改并同步` : fileName)
      smartNotify(title, body, data.path)
    }
  })
  // 对方新建文件/文件夹通知
  tcpAgent.on('file-created', (data) => {
    if (data.direction === 'incoming' && data.filePath) {
      const fileName = path.basename(data.filePath)
      const device = getDeviceNameById(data.deviceId)
      const isFolder = data.fileType === 'folder'
      const title = isFolder ? '📁 对方新建了文件夹' : '📄 对方新建了文件'
      smartNotify(title, (device ? `[${device}] ` : '') + fileName, null)
      if (mainWindow) mainWindow.webContents.send('file:created-remote', data)
    }
  })
  // 对方删除了本机文件：通知 + 刷新本地列表
  tcpAgent.on('file-deleted', (data) => {
    if (data.direction === 'incoming' && data.filePath) {
      const fileName = path.basename(data.filePath)
      const device = getDeviceNameById(data.deviceId)
      const title = data.isDirectory ? '🗑 对方删除了文件夹' : '🗑 对方删除了文件'
      smartNotify(title, (device ? `[${device}] ` : '') + fileName, null)
      if (mainWindow) mainWindow.webContents.send('file:deleted-local', data)
    }
  })
  tcpAgent.on('file-transfer-error', (data) => {
    if (mainWindow) mainWindow.webContents.send('transfer:error', data)
  })
  tcpAgent.on('firewall-warning', () => {
    if (mainWindow) {
      dialog.showErrorBox(
        '防火墙提示',
        '无法启动网络服务，可能被 Windows 防火墙阻止。\n\n请在弹出的"Windows 安全中心"中勾选"专用网络"和"公用网络"的允许选项，然后重新启动应用。'
      )
    }
  })
  tcpAgent.on('connection-status', (data) => {
    log(`[连接] ${data.status} ${data.deviceId} ${data.deviceInfo ? (data.deviceInfo.name || data.deviceInfo.hostname || '') : ''}`)
    if (mainWindow) mainWindow.webContents.send('connection:status', data)
  })
  // IPv6 地址自动学习：hello/hello-ack 都会触发
  tcpAgent.on('peer-learned', (data) => {
    if (!data || !data.deviceId || data.deviceId === tcpAgent.deviceId) return // 拦截"学到自己"（旧版本回显）
    if (data.ipv6 && data.ipv6.length) {
      saveIpv6Peer(data.deviceId, data.name, data.ipv6)
    }
  })
  tcpAgent.on('incoming-pair-request', (data) => {
    if (mainWindow) mainWindow.webContents.send('pair:request', data)
  })
  tcpAgent.on('pair:required', (data) => {
    if (mainWindow) mainWindow.webContents.send('pair:required', data)
  })
  tcpAgent.on('pair:auto-accepted', (data) => {
    if (mainWindow) mainWindow.webContents.send('pair:auto-accepted', data)
  })
  tcpAgent.on('paired', (data) => {
    if (mainWindow) mainWindow.webContents.send('paired', data)
  })
  // 远程审批被拒/超时：通知发起方 UI 关掉等待框
  tcpAgent.on('pair:decision', (data) => {
    if (mainWindow) mainWindow.webContents.send('pair:decision', data)
  })

  // 对讲机：对方喊话事件转发到渲染进程
  tcpAgent.on('ptt-start', ({ deviceId, sampleRate }) => {
    if (!mainWindow) return
    let name = '对方'
    try {
      const sock = tcpAgent.connections.get(deviceId)
      const info = sock && sock._deviceInfo
      if (info) name = info.name || info.hostname || '对方'
    } catch {}
    mainWindow.webContents.send('ptt:incoming-start', { deviceId, name, sampleRate })
  })
  tcpAgent.on('ptt-audio', (data) => {
    if (mainWindow) mainWindow.webContents.send('ptt:incoming-chunk', data)
  })
  tcpAgent.on('ptt-end', (data) => {
    if (mainWindow) mainWindow.webContents.send('ptt:incoming-end', data)
  })

  udpDiscovery.on('device-found', (device) => {
    if (mainWindow) mainWindow.webContents.send('device:found', device)
  })
  udpDiscovery.on('device-lost', (deviceId) => {
    if (mainWindow) mainWindow.webContents.send('device:lost', deviceId)
  })

  log('initServices:启动 TCP 和 UDP 服务...')
  try {
    tcpAgent.start()
    log('TCP 服务已启动')
  } catch (err) {
    log(`TCP 启动错误: ${err.message}`)
  }
  try {
    udpDiscovery.start()
    log('UDP 服务已启动')
  } catch (err) {
    log(`UDP 启动错误: ${err.message}`)
  }

  // 互联网模式（v0.5）：官方 presence 自动连接（登录即心跳，30 秒/次），不再支持自定义中转服务器。
  // 旧版 relayEnabled/relayHost 设置废弃不再读取（startNetRelay 保留仅供日后官方桥接复用）
  log('initServices:完成')
}

// === 互联网模式（中转服务器） ===
function startNetRelay(hostStr) {
  if (!NetRelay) return { success: false, error: '模块未加载' }
  if (!hostStr) return { success: false, error: '请填写中转服务器地址' }

  if (netRelay) { try { netRelay.stop() } catch { } }

  netRelay = new NetRelay({
    deviceId: tcpAgent.deviceId,
    deviceName: tcpAgent.deviceName || os.hostname(),
    getCertPin: () => { try { return getSetting('relayCertPin') || null } catch { return null } },
    setCertPin: (fp) => { try { setSetting('relayCertPin', fp) } catch { } }
  })

  netRelay.on('status', (snap) => {
    if (mainWindow) mainWindow.webContents.send('relay:status', { ...snap, host: getSetting('relayHost') || '' })
  })
  netRelay.on('device-list', (devices) => {
    // 过滤中转服务器回显的本机条目：设备列表出现"自己"会引发自连/配对混乱
    const filtered = (Array.isArray(devices) ? devices : []).filter((d) => d && d.deviceId !== tcpAgent.deviceId)
    if (mainWindow) mainWindow.webContents.send('relay:devices', filtered)
  })
  netRelay.on('log', (msg) => {
    if (mainWindow) mainWindow.webContents.send('tcp:log', `[互联网] ${msg}`)
  })
  // 被连接方：承接桥接流并注入 tcpAgent（对称握手，配对/传输协议原样复用）
  netRelay.on('bridge-socket', (sock) => {
    try {
      tcpAgent.adoptSocket(sock, { tempIP: 'via-relay' })
    } catch (err) {
      log(`桥接注入失败: ${err.message}`)
    }
  })

  // 同机双实例自动化测试钩子：设置 MSC_RELAY_AUTOCONNECT=1 后，在线列表一出现设备就自动桥接
  if (process.env.MSC_RELAY_AUTOCONNECT) {
    const tryAutoConnect = (devices) => {
      if (!devices || !devices.length) {
        netRelay.once('device-list', tryAutoConnect)
        return
      }
      if (tcpAgent.connections.size > 0) return
      const target = devices[0]
      log(`[测试] 自动桥接 ${target.deviceId} (${target.name || ''})`)
      netRelay.connectTo(target.deviceId)
        .then((sock) => tcpAgent.adoptSocket(sock, { tempIP: 'via-relay' }))
        .catch((err) => log(`[测试] 自动桥接失败: ${err.message}`))
    }
    netRelay.once('device-list', tryAutoConnect)
  }

  return netRelay.start(hostStr)
}

// === 传输历史 ===
function getHistoryPath() {
  return path.join(app.getPath('userData'), 'transfer-history.json')
}

function saveTransferHistory(data) {
  try {
    const historyPath = getHistoryPath()
    let history = []
    try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')) } catch {}
    
    const entry = {
      name: data.fileName || path.basename(data.path || ''),
      direction: data.direction,
      path: data.path || '',
      size: data.size || 0,
      device: getDeviceNameById(data.deviceId) || '',
      time: new Date().toISOString()
    }
    history.unshift(entry)
    if (history.length > 200) history = history.slice(0, 200)
    
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2))
  } catch (err) {
    log(`saveTransferHistory error: ${err.message}`)
  }
}

// 根据 deviceId 获取对方设备名（多设备场景下消息提示需要区分来源）
function getDeviceNameById(deviceId) {
  try {
    const sock = tcpAgent && tcpAgent.connections.get(deviceId)
    const info = sock && sock._deviceInfo
    return (info && (info.name || info.hostname)) || null
  } catch {
    return null
  }
}

// === 智能通知：窗口可见时 toast，不可见时系统通知 ===
function smartNotify(title, body, filePath) {
  const isVisible = mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()
  if (isVisible) {
    mainWindow.webContents.send('notification:toast', { title, body, filePath })
  } else {
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body })
      notification.on('click', () => {
        if (filePath) shell.openPath(filePath)
        if (mainWindow) { mainWindow.show(); mainWindow.focus() }
      })
      notification.show()
    }
  }
}

// 文件夹递归复制（外部拖到本地面板用）
function copyFolderRecursive(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyFolderRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// === 设置 ===
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function getSetting(key) {
  try {
    const settings = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'))
    return settings[key]
  } catch {
    return null
  }
}

function setSetting(key, value) {
  try {
    let settings = {}
    try { settings = JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) } catch {}
    settings[key] = value
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2))
    return true
  } catch {
    return false
  }
}

// === 文件夹递归扫描 ===
function scanFolderRecursive(folderPath) {
  const results = []
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name)
      const relativePath = path.relative(folderPath, fullPath)
      if (entry.isDirectory()) {
        results.push({ path: fullPath, relativePath, isDirectory: true, size: 0 })
        results.push(...scanFolderRecursive(fullPath))
      } else {
        let size = 0
        try { size = fs.statSync(fullPath).size } catch {}
        results.push({ path: fullPath, relativePath, isDirectory: false, size })
      }
    }
  } catch (err) {
    log(`scanFolderRecursive error: ${err.message}`)
  }
  return results
}

// === IPC Handlers ===

// === 对讲机（PTT） ===
let pttHotkeyListener = null
const PTT_HOTKEY_DEFAULT = 'Ctrl+Alt+V'

function startPTTHotkey() {
  if (!HotkeyListener) return
  if (!pttHotkeyListener) {
    pttHotkeyListener = new HotkeyListener()
    pttHotkeyListener.on('down', () => {
      if (mainWindow) mainWindow.webContents.send('ptt:hotkey-down')
    })
    pttHotkeyListener.on('up', () => {
      if (mainWindow) mainWindow.webContents.send('ptt:hotkey-up')
    })
    pttHotkeyListener.on('error', (err) => log(`PTT 热键错误: ${err.message}`))
  }
  pttHotkeyListener.stop()
  let accel = null
  try { accel = getSetting('pttHotkey') } catch {}
  if (accel === null || accel === undefined) accel = PTT_HOTKEY_DEFAULT
  if (!accel) {
    log('PTT: 未设置全局热键，跳过')
    return
  }
  const ok = pttHotkeyListener.start(accel)
  log(`PTT: 全局热键 ${accel} ${ok ? '启动成功' : '启动失败'}`)
}

function stopPTTHotkey() {
  if (pttHotkeyListener) pttHotkeyListener.stop()
}

ipcMain.handle('ptt:get-hotkey', () => {
  let accel = null
  try { accel = getSetting('pttHotkey') } catch {}
  return accel === null || accel === undefined ? PTT_HOTKEY_DEFAULT : accel
})

ipcMain.handle('ptt:start', (event, { deviceId, sampleRate }) => {
  try { return tcpAgent ? tcpAgent.sendPTTStart(deviceId, sampleRate) : false } catch { return false }
})

ipcMain.on('ptt:chunk', (event, { deviceId, b64 }) => {
  try { if (tcpAgent) tcpAgent.sendPTTChunk(deviceId, b64) } catch {}
})

ipcMain.handle('ptt:stop', (event, { deviceId }) => {
  try { return tcpAgent ? tcpAgent.sendPTTEnd(deviceId) : false } catch { return false }
})

ipcMain.handle('app:get-info', () => {
  const networkInterfaces = os.networkInterfaces()
  let localIP = '127.0.0.1'
  let localName = os.hostname()
  for (const [, interfaces] of Object.entries(networkInterfaces)) {
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address
        break
      }
    }
  }
  const customName = getSetting('deviceName')
  return {
    version: app.getVersion(),
    localIP,
    localName: customName || localName,
    computerName: os.hostname(),
    customName: customName || '',
    platform: os.platform(),
    selfId: tcpAgent ? tcpAgent.deviceId : ''
  }
})

ipcMain.handle('app:get-paired-devices', () => {
  return authManager.getTrustedDevices()
})

ipcMain.handle('app:get-pair-code', () => {
  return authManager.generatePairCode()
})

ipcMain.handle('app:accept-pair', async (event, { deviceId, accepted, requestId }) => {
  return tcpAgent.respondPair(deviceId, accepted, requestId)
})
// 2.0：发起方提交配对码校验
ipcMain.handle('app:verify-pair-code', async (event, { deviceId, code }) => {
  return tcpAgent.sendPairVerifyCode(deviceId, code)
})

ipcMain.handle('device:remove-paired', async (event, deviceId) => {
  authManager.removeDevice(deviceId)
  tcpAgent.disconnectDevice(deviceId)
  return true
})

ipcMain.handle('device:refresh', async () => {
  udpDiscovery.refresh()
  return true
})

// 修改自己设备名称（保存 + 广播给已连接设备 + 更新 UDP 发现）
ipcMain.handle('device:set-name', async (event, { name }) => {
  const trimmed = (name || '').trim()
  const finalName = trimmed ? trimmed.slice(0, 32) : null
  setSetting('deviceName', finalName)
  if (tcpAgent) tcpAgent.setDeviceName(finalName)
  if (udpDiscovery && udpDiscovery.setDeviceName) udpDiscovery.setDeviceName(finalName)
  // 同步到互联网模式（重连中转会以新名字重新注册）
  if (netRelay) {
    netRelay.deviceName = finalName || os.hostname()
    if (netRelay.online) netRelay._send({ type: 'reg-host', deviceId: netRelay.deviceId, name: netRelay.deviceName })
  }
  return { success: true, name: finalName || os.hostname() }
})

ipcMain.handle('device:get-name', async () => {
  const n = getSetting('deviceName')
  return { name: n || '', hostname: os.hostname() }
})

// 设备备注：存储 { deviceId: remark }
ipcMain.handle('device:get-remarks', async () => {
  return getSetting('deviceRemarks') || {}
})

ipcMain.handle('device:set-remark', async (event, { deviceId, remark }) => {
  let remarks = {}
  try { remarks = getSetting('deviceRemarks') || {} } catch {}
  if (remark && remark.trim()) {
    remarks[deviceId] = remark.trim().slice(0, 50)
  } else {
    delete remarks[deviceId]
  }
  setSetting('deviceRemarks', remarks)
  return { success: true, remarks }
})

ipcMain.handle('connection:connect', async (event, { deviceId }) => {
  if (deviceId === tcpAgent.deviceId) return { success: false, error: '不能连接自己' }
  return tcpAgent.connectDevice(deviceId)
})

ipcMain.handle('connection:connect-by-ip', async (event, { ip }) => {
  const raw = String(ip || '').trim()
  // v2.7.16：参数三路分发——IPv4/IPv6 走 TCP 直连；设备 ID 走互联网通道：
  // ① 互联网模式在线 → 中转桥接（relayConnectTo）；② 未在线但已登录 → presence 查对方公网 IP 直连
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) || raw.includes(':')
  if (isIp) return tcpAgent.connectByIP(raw)
  if (!raw) return { success: false, error: '请输入 IP 地址或设备 ID' }
  if (netRelay && netRelay.online) {
    try {
      const sock = await netRelay.connectTo(raw)
      return tcpAgent.adoptSocket(sock, { tempIP: 'via-relay' })
    } catch (err) {
      return { success: false, error: `桥接失败: ${err.message}（对方须在线且开启互联网模式）` }
    }
  }
  try {
    const a = authGetSaved()
    if (a.token) {
      const r = await authRequest('/v1/presence', { method: 'GET', token: a.token })
      if (r.status === 200 && r.data && r.data.ok) {
        const hit = (r.data.devices || []).find(d => d.deviceId === raw)
        if (hit && hit.ip) return tcpAgent.connectByIP(hit.ip)
        return { success: false, error: '对方不在线：需对方登录并打开 MSMate（或改填对方公网 IP）' }
      }
    }
  } catch { }
  return { success: false, error: '设备 ID 需要互联网模式（设置里开启）或登录后才能解析，也可直接填对方公网 IP' }
})

// 互联网传输额度查询（渲染层设备列表展示 + 连接前预检）
ipcMain.handle('net:quota', async () => {
  return { limit: NET_DAILY_LIMIT, used: netUsageToday().bytes, left: netQuotaLeft() }
})

// ===== 好友（远程设备通讯录，v2.7.14）：存 settings.json，加好友一键直连 =====
function friendsNormalize(list) {
  return (Array.isArray(list) ? list : [])
    .filter(f => f && String(f.host || '').trim())
    .slice(0, 50)
}

ipcMain.handle('friends:get', async () => {
  return friendsNormalize(getSetting('friends'))
})

ipcMain.handle('friends:add', async (event, f) => {
  const host = String((f && f.host) || '').trim().slice(0, 120)
  const name = String((f && f.name) || '').trim().slice(0, 32)
  if (!host) return { ok: false, error: '请填写对方 IP 或设备 ID' }
  const list = friendsNormalize(getSetting('friends'))
  const existing = list.findIndex(x => x.host === host)
  // 重复添加 = 更新备注并置顶；新加不带备注且旧有条目时沿用旧备注
  const entry = { host, name: name || (existing >= 0 ? (list[existing].name || '') : ''), addedAt: new Date().toISOString() }
  if (existing >= 0) list.splice(existing, 1)
  list.unshift(entry)
  setSetting('friends', list.slice(0, 50))
  return { ok: true, friends: list.slice(0, 50) }
})

ipcMain.handle('friends:remove', async (event, { host }) => {
  const key = String((host || '')).trim()
  const list = friendsNormalize(getSetting('friends')).filter(x => x.host !== key)
  setSetting('friends', list)
  return { ok: true, friends: list }
})

ipcMain.handle('connection:disconnect', async (event, { deviceId }) => {
  return tcpAgent.disconnectDevice(deviceId)
})

// 获取当前所有已连接设备（多设备支持；过滤可能混入的本机条目）
ipcMain.handle('connection:get-connected', async () => {
  try {
    const devices = tcpAgent.getConnectedDevices().filter((d) => d.deviceId !== tcpAgent.deviceId)
    return { success: true, devices }
  } catch {
    return { success: false, devices: [] }
  }
})

// === 互联网模式 IPC ===
ipcMain.handle('relay:get-state', async () => {
  return {
    enabled: !!getSetting('relayEnabled'),
    host: getSetting('relayHost') || '',
    status: netRelay ? netRelay.status : 'stopped',
    lastError: netRelay ? netRelay.lastError : null,
    certPinned: !!getSetting('relayCertPin')
  }
})

ipcMain.handle('relay:save', async (event, { enabled, host }) => {
  const hostStr = (host || '').trim()
  setSetting('relayEnabled', !!enabled && !!hostStr)
  setSetting('relayHost', hostStr)
  if (enabled && hostStr) {
    const r = startNetRelay(hostStr)
    return { success: r !== false }
  }
  if (netRelay) { try { netRelay.stop() } catch { } }
  return { success: true }
})

ipcMain.handle('relay:connect', async (event, { deviceId }) => {
  if (!netRelay || !netRelay.online) return { success: false, error: '互联网模式未在线' }
  if (deviceId === tcpAgent.deviceId) return { success: false, error: '不能连接自己' }
  try {
    const sock = await netRelay.connectTo(deviceId)
    return tcpAgent.adoptSocket(sock, { tempIP: 'via-relay' })
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('relay:reset-pin', async () => {
  setSetting('relayCertPin', null)
  return { success: true }
})

// === IPv6 直连 IPC ===
function getIpv6Peers() {
  try { return getSetting('ipv6Peers') || {} } catch { return {} }
}

function saveIpv6Peer(deviceId, name, addrs) {
  if (!deviceId || !Array.isArray(addrs) || !addrs.length) return
  if (tcpAgent && deviceId === tcpAgent.deviceId) return // 自己绝不进 IPv6 设备表
  try {
    const peers = getIpv6Peers()
    const prev = peers[deviceId]
    // 合并新旧地址（临时地址会轮换，多备几个候选）
    const merged = [...new Set([...(addrs || []), ...((prev && prev.addrs) || [])])].slice(0, 6)
    peers[deviceId] = { name: name || (prev && prev.name) || deviceId, addrs: merged, updatedAt: Date.now() }
    setSetting('ipv6Peers', peers)
    if (mainWindow) mainWindow.webContents.send('ipv6:peers', peers)
  } catch { }
}

ipcMain.handle('ipv6:get-invite', async () => {
  try {
    const addrs = ipv6Invite ? ipv6Invite.getGlobalIPv6Addresses() : []
    const invite = ipv6Invite ? ipv6Invite.buildInvite(tcpAgent.deviceId, tcpAgent.deviceName || os.hostname(), 45679) : null
    return { success: true, invite, addresses: addrs }
  } catch (err) {
    return { success: false, error: err.message, invite: null, addresses: [] }
  }
})

ipcMain.handle('ipv6:connect-invite', async (event, { text }) => {
  if (!tcpAgent) return { success: false, error: '服务未就绪' }
  const parsed = ipv6Invite.parseInvite(text)
  if (!parsed.success) return { success: false, error: parsed.error }
  // 自己的邀请码：直接拒绝，防止设备表混进自己
  if (parsed.deviceId && parsed.deviceId === tcpAgent.deviceId) {
    return { success: false, error: '这是本机自己的邀请码，不需要连接自己' }
  }

  const errors = []
  for (const addr of parsed.addrs) {
    try {
      const r = await tcpAgent.connectByIP(addr)
      if (r.success) {
        // 带设备 ID 的邀请串才做地址记忆；裸地址只连不存
        if (parsed.deviceId) saveIpv6Peer(parsed.deviceId, parsed.name, [addr])
        return { success: true, deviceId: parsed.deviceId, name: parsed.name, addr }
      }
      errors.push(`${addr}: ${r.error}`)
    } catch (err) {
      errors.push(`${addr}: ${err.message}`)
    }
  }
  return { success: false, error: `所有地址均连接失败（${errors.length} 个）——请检查对方是否在线、防火墙是否放行` }
})

ipcMain.handle('ipv6:connect-peer', async (event, { deviceId }) => {
  if (!tcpAgent) return { success: false, error: '服务未就绪' }
  const peer = getIpv6Peers()[deviceId]
  if (!peer) return { success: false, error: '没有该设备的历史地址' }
  const errors = []
  for (const addr of peer.addrs) {
    try {
      const r = await tcpAgent.connectByIP(addr)
      if (r.success) return { success: true, deviceId, addr }
      errors.push(`${addr}: ${r.error}`)
    } catch (err) {
      errors.push(`${addr}: ${err.message}`)
    }
  }
  return { success: false, error: `历史地址均连接失败（${errors.length} 个），请让对方重新发一次邀请码` }
})

ipcMain.handle('ipv6:get-peers', async () => {
  return { success: true, peers: getIpv6Peers() }
})

ipcMain.handle('ipv6:remove-peer', async (event, { deviceId }) => {
  try {
    const peers = getIpv6Peers()
    delete peers[deviceId]
    setSetting('ipv6Peers', peers)
    if (mainWindow) mainWindow.webContents.send('ipv6:peers', peers)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:list-local', async (event, { path: targetPath }) => {
  return listLocalDirectory(targetPath)
})

// 工作台/互联列表实时刷新：监听"当前正在看的目录"（AI 删/加/改文件 → 防抖通知渲染层重拉）
// 同一时刻只挂一个 watcher（渲染层切换目录时换目标），读操作不触发事件无循环风险
let dirWatch = { watcher: null, dir: '', timer: null, pending: new Set(), lastSizes: '' }
ipcMain.handle('file:watch-dir', async (event, { path: dir }) => {
  try {
    dir = String(dir || '')
    if (dirWatch.dir === dir && dirWatch.watcher) return { ok: true } // 已在监听
    if (dirWatch.watcher) { try { dirWatch.watcher.close() } catch {} dirWatch.watcher = null }
    clearTimeout(dirWatch.timer)
    dirWatch.dir = ''
    dirWatch.pending.clear()
    dirWatch.lastSizes = ''
    if (!dir || dir === 'root' || dir === '/') return { ok: false }
    const w = fs.watch(dir, { recursive: true }, (ev, fname) => {
      dirWatch.pending.add(String(fname || ''))
      clearTimeout(dirWatch.timer)
      dirWatch.timer = setTimeout(async () => {
        if (dirWatch.dir !== dir) return // 已切走：陈旧事件丢弃
        // 写稳定检测（v2.4.66）：AI 并行下载时文件边写边触发事件，立即刷新会读到半截文件
        // （老大实锤"图片只有一半"）。等文件大小连续两轮不变（写入完成）才通知，最多等 ~2.7s
        for (let round = 0; round < 6; round++) {
          if (dirWatch.dir !== dir) return
          await new Promise((r) => setTimeout(r, 450))
          const names = [...dirWatch.pending].filter(Boolean).slice(0, 20)
          const sizes = names.map((f) => { try { return fs.statSync(path.join(dir, f)).size } catch { return -1 } }).join(',')
          if (sizes === dirWatch.lastSizes) break // 连续两轮大小不变：写入已稳定
          dirWatch.lastSizes = sizes
        }
        if (dirWatch.dir !== dir) return
        dirWatch.lastSizes = ''
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('file:dir-changed', { dir })
      }, 400) // AI 批量写/解压会爆发大量事件，400ms 合并成一次刷新
    })
    w.on('error', () => { // 权限/网络盘监听失败：静默降级（不刷新但绝不能崩）
      try { w.close() } catch {}
      if (dirWatch.watcher === w) { dirWatch.watcher = null; dirWatch.dir = '' }
    })
    dirWatch.watcher = w
    dirWatch.dir = dir
    return { ok: true }
  } catch { return { ok: false } }
})

ipcMain.handle('file:list-remote', async (event, { deviceId, path: targetPath }) => {
  return tcpAgent.listRemoteDirectory(deviceId, targetPath)
})

ipcMain.handle('file:download', async (event, { deviceId, remotePath, localPath, transferId }) => {
  try {
    return await tcpAgent.downloadFile(deviceId, remotePath, localPath, transferId)
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:upload', async (event, { deviceId, localPath, remotePath, transferId }) => {
  try {
    return await tcpAgent.uploadFile(deviceId, localPath, remotePath, false, transferId)
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 文件夹递归下载：先在远程扫描文件列表，然后逐个下载到本地对应目录
ipcMain.handle('file:download-folder', async (event, { deviceId, remotePath, localDir }) => {
  try {
    // 请求远程扫描文件夹结构
    const fileList = await tcpAgent.scanRemoteFolder(deviceId, remotePath)
    if (!fileList || fileList.length === 0) {
      return { success: false, error: '文件夹为空或无法访问' }
    }

    const folderName = path.basename(remotePath)
    const localBase = path.join(localDir, folderName)
    
    // 在本地创建目录结构
    for (const item of fileList) {
      if (item.isDirectory) {
        const localPath = path.join(localBase, item.relativePath)
        try { fs.mkdirSync(localPath, { recursive: true }) } catch {}
      }
    }

    // 逐个下载文件
    let successCount = 0
    let failCount = 0
    for (const item of fileList) {
      if (!item.isDirectory) {
        const localFilePath = path.join(localBase, item.relativePath)
        const localFileDir = path.dirname(localFilePath)
        try { fs.mkdirSync(localFileDir, { recursive: true }) } catch {}
        
        try {
          await tcpAgent.downloadFile(deviceId, item.path, localFilePath, null, true)
          successCount++
        } catch {
          failCount++
        }
      }
    }

    return { success: true, successCount, failCount, totalFiles: fileList.filter(f => !f.isDirectory).length }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 文件夹递归上传：在本地扫描文件列表，然后逐个上传到远程对应目录
ipcMain.handle('file:upload-folder', async (event, { deviceId, localPath, remoteDir }) => {
  try {
    const fileList = scanFolderRecursive(localPath)
    if (fileList.length === 0) {
      return { success: false, error: '文件夹为空或无法访问' }
    }

    const folderName = path.basename(localPath)
    const remoteBase = remoteDir.endsWith('\\') ? remoteDir + folderName : remoteDir + '\\' + folderName

    // 在远程创建目录结构
    for (const item of fileList) {
      if (item.isDirectory) {
        const remoteFolderPath = path.join(remoteBase, item.relativePath)
        try { await tcpAgent.createRemoteFolder(deviceId, remoteFolderPath) } catch {}
      }
    }

    // 逐个上传文件
    let successCount = 0
    let failCount = 0
    for (const item of fileList) {
      if (!item.isDirectory) {
        const remoteFileDir = path.join(remoteBase, path.dirname(item.relativePath))
        try {
          await tcpAgent.uploadFile(deviceId, item.path, remoteFileDir, true)
          successCount++
        } catch {
          failCount++
        }
      }
    }

    return { success: true, successCount, failCount, totalFiles: fileList.filter(f => !f.isDirectory).length }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:batch-download', async (event, { deviceId, files, destDir }) => {
  return tcpAgent.batchDownload(deviceId, files, destDir)
})

ipcMain.handle('file:batch-upload', async (event, { deviceId, filePaths, remoteDir }) => {
  return tcpAgent.batchUpload(deviceId, filePaths, remoteDir)
})

ipcMain.handle('file:delete-remote', async (event, { deviceId, filePath }) => {
  return tcpAgent.deleteRemoteFile(deviceId, filePath)
})

ipcMain.handle('file:create-folder-remote', async (event, { deviceId, folderPath }) => {
  return tcpAgent.createRemoteFolder(deviceId, folderPath)
})

ipcMain.handle('file:rename-remote', async (event, { deviceId, oldPath, newName }) => {
  return tcpAgent.renameRemoteFile(deviceId, oldPath, newName)
})

// === 远程编辑：下载→打开→保存后自动上传回对方 ===
const editSessions = new Map()

ipcMain.handle('file:edit-remote', async (event, { deviceId, remotePath }) => {
  try {
    const fileName = path.basename(remotePath)
    const remoteDir = path.dirname(remotePath)
    const tmpDir = path.join(os.tmpdir(), 'ms-connect-edit')
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
    }
    const tmpPath = path.join(tmpDir, fileName)

    // 删除旧临时文件（避免断点续传追加）
    try { fs.unlinkSync(tmpPath) } catch {}

    // 下载文件到临时目录
    const dlResult = await tcpAgent.downloadFile(deviceId, remotePath, tmpPath)
    if (!dlResult.success) {
      return { success: false, error: '下载失败: ' + dlResult.error }
    }

    // 记录编辑会话（确保文件存在，兼容空文件）
    if (!fs.existsSync(tmpPath)) {
      fs.writeFileSync(tmpPath, Buffer.alloc(0))
    }
    const stats = fs.statSync(tmpPath)
    const session = {
      remotePath, deviceId, remoteDir,
      lastMtime: stats.mtimeMs,
      uploading: false,
      debounceTimer: null,
      watcher: null
    }
    editSessions.set(tmpPath, session)

    // 监控文件变化（保存后自动上传）
    session.watcher = fs.watch(tmpPath, () => {
      handleEditFileChange(tmpPath)
    })

    // 用系统默认程序打开文件
    shell.openPath(tmpPath)

    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

async function handleEditFileChange(tmpPath) {
  const session = editSessions.get(tmpPath)
  if (!session || session.uploading) return

  try {
    const stats = fs.statSync(tmpPath)
    if (stats.mtimeMs === session.lastMtime) return
    session.lastMtime = stats.mtimeMs

    // 防抖：等2秒再上传，避免连续保存触发多次
    if (session.debounceTimer) clearTimeout(session.debounceTimer)
    session.debounceTimer = setTimeout(async () => {
      session.uploading = true
      try {
        // 强制覆盖上传（forceOverwrite=true）
        const result = await tcpAgent.uploadFile(session.deviceId, tmpPath, session.remoteDir, true)
        if (result.success && mainWindow) {
          mainWindow.webContents.send('edit:uploaded', { fileName: path.basename(tmpPath) })
        }
      } catch {}
      session.uploading = false
    }, 2000)
  } catch {}
}

ipcMain.handle('transfer:cancel', async (event, { transferId }) => {
  return tcpAgent.cancelTransfer(transferId)
})

ipcMain.handle('dialog:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择文件夹'
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('dialog:select-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    title: '选择文件'
  })
  if (result.canceled) return null
  return result.filePaths
})

ipcMain.handle('dialog:select-save', async (event, { defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存到',
    defaultPath: defaultPath || ''
  })
  if (result.canceled) return null
  return result.filePath
})

// === 自定义背景（全局设置 → 外观）：图片压缩存 JPEG；GIF 动图/视频原样复制（过 nativeImage 会变静帧）===
function getBackgroundPath() {
  return path.join(app.getPath('userData'), 'ui-background.jpg')
}
function getAnimBackgroundPath(ext) {
  return path.join(app.getPath('userData'), 'ui-background-anim.' + (ext || 'gif'))
}
function getVideoBackgroundPath(ext) {
  return path.join(app.getPath('userData'), 'ui-background-video.' + (ext || 'mp4'))
}
// 清掉其他类型的旧背景（keep 豁免当前要写的那个）
function clearBgFiles(keep) {
  const cands = [getBackgroundPath(), getAnimBackgroundPath('gif'), getVideoBackgroundPath('mp4'), getVideoBackgroundPath('webm')]
  for (const f of cands) {
    if (f === keep) continue
    try { fs.unlinkSync(f) } catch {}
  }
}
const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '')

// 选图/动图/视频 → 图片压缩（长边 2560 / JPEG 82，仅变小才用）；gif/视频原样复制 → 存 userData
ipcMain.handle('ui:pick-background', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: '选择背景（图片 / GIF 动图 / 视频）',
    filters: [{ name: '背景素材', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'mp4', 'webm'] }]
  })
  if (result.canceled || !result.filePaths[0]) return null
  const src = result.filePaths[0]
  const ext = path.extname(src).slice(1).toLowerCase()
  try {
    if (ext === 'mp4' || ext === 'webm') {
      const dst = getVideoBackgroundPath(ext)
      clearBgFiles(dst)
      fs.copyFileSync(src, dst)
      return { kind: 'video', url: fileUrl(dst) }
    }
    if (ext === 'gif') {
      const dst = getAnimBackgroundPath('gif')
      clearBgFiles(dst)
      fs.copyFileSync(src, dst)
      return { kind: 'anim', url: fileUrl(dst) }
    }
    const { nativeImage } = require('electron')
    let img = nativeImage.createFromPath(src)
    if (img.isEmpty()) return { error: '无法读取该图片' }
    // 缩放到长边 2560（等比），仅缩后更小才采用
    const size = img.getSize()
    const longEdge = Math.max(size.width, size.height)
    if (longEdge > 2560) {
      const ratio = 2560 / longEdge
      img = img.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio), quality: 'good' })
    }
    const buf = img.toJPEG(82)
    clearBgFiles(getBackgroundPath())
    fs.writeFileSync(getBackgroundPath(), buf)
    return { kind: 'image', dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` }
  } catch (err) {
    return { error: err.message }
  }
})

ipcMain.handle('ui:get-background', async () => {
  try {
    for (const ext of ['mp4', 'webm']) {
      const p = getVideoBackgroundPath(ext)
      if (fs.existsSync(p)) return { kind: 'video', url: fileUrl(p) }
    }
    const anim = getAnimBackgroundPath('gif')
    if (fs.existsSync(anim)) return { kind: 'anim', url: fileUrl(anim) }
    const buf = fs.readFileSync(getBackgroundPath())
    return { kind: 'image', dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` }
  } catch {
    return null
  }
})

ipcMain.handle('ui:clear-background', async () => {
  clearBgFiles(null)
  return true
})

// 工作台：常用目录一键直达（快速访问磁贴）
ipcMain.handle('app:get-shell-dirs', async () => {
  const home = os.homedir()
  const pick = (k, fb) => { try { return app.getPath(k) } catch { return path.join(home, fb) } }
  return {
    desktop: pick('desktop', 'Desktop'),
    downloads: pick('downloads', 'Downloads'),
    documents: pick('documents', 'Documents'),
    pictures: pick('pictures', 'Pictures'),
    music: pick('music', 'Music'),
    videos: pick('videos', 'Videos')
  }
})

// 工作台：新建文本文件/文件夹（非法名过滤+防覆盖）
ipcMain.handle('fs:create-wb-entry', async (event, { dir, name, isDir }) => {
  try {
    const clean = String(name || '').trim()
    if (!clean) return { error: '名称不能为空' }
    if (/[\\/:*?"<>|]/.test(clean)) return { error: '名称不能含 \\ / : * ? " < > | 字符' }
    let finalName = clean
    if (!isDir && !path.extname(clean)) finalName = clean + '.txt'
    const target = path.join(dir, finalName)
    if (fs.existsSync(target)) return { error: `「${finalName}」已存在` }
    if (isDir) fs.mkdirSync(target)
    else fs.writeFileSync(target, '', 'utf8')
    return { success: true, path: target, name: finalName }
  } catch (err) {
    return { error: err.message }
  }
})

// 工作台：Excel 网格读取（单表，300行×40列截断保护）
// xlsx 单元格显示值：按 numFmt 格式化常见格式（百分比/千分位/小数位/日期），编辑仍用原始 v
function xlsxDisplay(v, numFmt) {
  try {
    const nf = String(numFmt || '')
    if (v instanceof Date) {
      const p = (n) => String(n).padStart(2, '0')
      const d = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
      return /hh|mm|ss/i.test(nf) ? `${d} ${p(v.getHours())}:${p(v.getMinutes())}` : d
    }
    if (typeof v === 'number' && isFinite(v)) {
      if (/%/.test(nf)) {
        const dec = ((nf.match(/0\.(0+)/) || [])[1] || '').length
        return (v * 100).toFixed(dec) + '%'
      }
      if (/#,##/.test(nf)) {
        const dec = (nf.split('.')[1] || '').replace(/[^0#]/g, '').length
        return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
      }
      const m2 = /0\.(0+)/.exec(nf)
      if (m2) return v.toFixed(m2[1].length)
    }
  } catch {}
  return null
}

ipcMain.handle('fs:xlsx-sheet', async (event, { filePath, sheet }) => {
  try {
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(filePath)
    const names = wb.worksheets.map(w => w.name)
    const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0]
    if (!ws) return { error: '找不到工作表' }
    const maxR = Math.min(ws.rowCount || 0, 300)
    const maxC = Math.min(ws.columnCount || 0, 40)
    // 列宽（Excel 字符宽单位，前端换算 px）
    const cols = []
    for (let c = 1; c <= maxC; c++) {
      let w = null
      try { const col = ws.getColumn(c); if (col && col.width) w = Math.round(col.width * 10) / 10 } catch {}
      cols.push(w)
    }
    // 合并单元格（"A1:B2" 形态原样透出，前端解析成 rowspan/colspan）
    let merges = []
    try { merges = Array.isArray(ws.model.merges) ? ws.model.merges.slice(0, 500) : [] } catch {}
    const rows = []
    for (let r = 1; r <= maxR; r++) {
      const row = []
      for (let c = 1; c <= maxC; c++) {
        const cell = ws.getRow(r).getCell(c)
        let f = null
        try { f = typeof cell.formula === 'string' ? cell.formula : null } catch {}
        const o = { v: cell.text || '', f }
        try {
          // v2.4.94：还原样式——显示值 t（numFmt 格式化）/加粗 b/字色 fc/底色 bg/对齐 al（编辑写回仍用 v/f，样式不丢）
          if (cell.numFmt && cell.numFmt !== 'General' && cell.type === 2) {
            const t = xlsxDisplay(cell.value, cell.numFmt)
            if (t != null && String(t) !== String(o.v)) o.t = t
          }
          if (cell.font && cell.font.bold) o.b = 1
          if (cell.font && cell.font.color && cell.font.color.argb) {
            const fc = String(cell.font.color.argb).slice(2)
            if (fc && fc !== '000000') o.fc = fc
          }
          if (cell.fill && cell.fill.patternType === 'solid' && cell.fill.fgColor && cell.fill.fgColor.argb) {
            const bg = String(cell.fill.fgColor.argb).slice(2)
            if (bg && bg !== 'FFFFFF') o.bg = bg
          }
          if (cell.alignment && cell.alignment.horizontal) o.al = cell.alignment.horizontal
        } catch {}
        row.push(o)
      }
      rows.push(row)
    }
    return {
      success: true,
      name: ws.name,
      sheets: names,
      rows,
      cols,
      merges,
      truncated: (ws.rowCount || 0) > maxR || (ws.columnCount || 0) > maxC
    }
  } catch (err) {
    return { error: err.message }
  }
})

// 工作台：Excel 单元格写回（=开头当公式；覆盖前自动快照）
ipcMain.handle('fs:xlsx-write', async (event, { filePath, sheet, updates }) => {
  try {
    if (!Array.isArray(updates) || !updates.length) return { error: '没有修改内容' }
    if (fs.existsSync(filePath)) {
      try {
        const backupDir = path.join(app.getPath('userData'), 'mswork_snapshots', 'wb-edit-' + Date.now().toString(36))
        fs.mkdirSync(backupDir, { recursive: true })
        fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath) || 'file'))
      } catch {}
    }
    const ExcelJS = require('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(filePath)
    const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0]
    if (!ws) return { error: '找不到工作表' }
    for (const u of updates) {
      const cell = ws.getRow(u.r).getCell(u.c)
      if (typeof u.v === 'string' && u.v.startsWith('=')) cell.value = { formula: u.v.slice(1) }
      else cell.value = u.v === '' ? null : u.v
    }
    await wb.xlsx.writeFile(filePath)
    return { success: true }
  } catch (err) {
    return { error: err.message }
  }
})

// 文件占用检测：WPS/Word 打开着文档时是独占锁，写回必 EPERM——提前探出来给人话提示
function docxLockError(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r+')
    fs.closeSync(fd)
    return null
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
      return '文件正被其它程序占用（WPS/Word 可能正开着它），请先在那些程序里关闭该文档再保存'
    }
    return err ? err.message : '文件不可写'
  }
}

// 工作台：Word 所见即所得保存（DOM 段落/runs 高保真写回；快照备份 + 排版引擎重排生成）
ipcMain.handle('fs:word-rich-save', async (event, { filePath, paragraphs }) => {
  try {
    if (!Array.isArray(paragraphs) || !paragraphs.length) return { error: '没有内容' }
    if (path.extname(filePath).toLowerCase() !== '.docx') return { error: '只支持 .docx 文件' }
    if (fs.existsSync(filePath)) {
      const lockErr = docxLockError(filePath)
      if (lockErr) return { error: lockErr }
    }
    // data: URI 图片落临时文件（mammoth 导出的图片是 base64，排版引擎只认文件路径）
    const os = require('os')
    const norm = paragraphs.map((p) => {
      if (typeof p === 'string' && p.startsWith('![')) {
        const m = /!\[[^\]]*\]\((data:image\/(png|jpeg|jpg|gif|bmp);base64,[^)]+)\)(?:\s*\{([^}]*)\})?\s*$/.exec(p)
        if (m) {
          const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
          const tmp = path.join(os.tmpdir(), `wbimg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
          fs.writeFileSync(tmp, Buffer.from(m[1].replace(/^data:image\/\w+;base64,/, ''), 'base64'))
          return p.replace(m[1], tmp)
        }
      }
      return p
    })
    if (fs.existsSync(filePath)) {
      try {
        const backupDir = path.join(app.getPath('userData'), 'mswork_snapshots', 'wb-edit-' + Date.now().toString(36))
        fs.mkdirSync(backupDir, { recursive: true })
        fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath) || 'file.docx'))
      } catch {}
    }
    const { modifyDocx } = require('./ai/office')
    await modifyDocx(filePath, { paragraphs: norm, noTitle: true }, 'replace')
    return { success: true }
  } catch (err) {
    const msg = err && (err.code === 'EPERM' || err.code === 'EBUSY')
      ? '文件被其它程序占用，保存失败——请关闭 WPS/Word 里打开的这份文档后重试（编辑器里的内容还在，关了再按 Ctrl+S 即可）'
      : err.message
    return { error: msg }
  }
})

// 工作台：外部编辑器保存监听（「在默认程序中编辑」用 WPS/Office 改完，这里轮询 mtime 通知刷新）
ipcMain.handle('fs:file-mtime', async (event, { filePath }) => {
  try { return { mtimeMs: fs.statSync(filePath).mtimeMs } } catch { return { mtimeMs: 0 } }
})

ipcMain.handle('fs:wait-file-change', async (event, { filePath, baseMtime, timeoutMs = 120000 }) => {
  const deadline = Date.now() + Math.min(Number(timeoutMs) || 120000, 600000)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 800))
    try {
      const mtimeMs = fs.statSync(filePath).mtimeMs
      if (mtimeMs !== baseMtime) return { changed: true, mtimeMs }
    } catch { return { changed: false } } // 文件没了（被改名/删除）直接退出
  }
  return { changed: false }
})

// === 工作台：docx 外部程序内嵌（实验性，WPS/Word 窗口 SetParent 进应用） ===
const { detectDocxHandler, manager: embedManager } = require('./ai/winembed')

ipcMain.handle('docx:handler', async () => {
  try { return await detectDocxHandler() } catch { return { kind: null } }
})

// 嵌入入口：主窗口 HWND 传给帮手，坐标=父客户区物理像素
ipcMain.handle('docx:embed', async (event, { exe, filePath, x, y, w, h }) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow
    if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' }
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
    const reply = await embedManager.embed(hwnd, exe, filePath, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) })
    return reply.startsWith('OK') ? { ok: true } : { ok: false, reason: reply.replace('FAIL|', '') }
  } catch (err) {
    return { ok: false, reason: err.message }
  }
})
ipcMain.handle('docx:embed-move', async (event, { x, y, w, h }) => {
  const r = await embedManager.move({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }).catch(() => 'FAIL|ipc')
  return { ok: r.startsWith('OK') }
})
ipcMain.handle('docx:embed-hide', async () => ({ ok: (await embedManager.hide().catch(() => 'FAIL|ipc')).startsWith('OK') }))
ipcMain.handle('docx:embed-show', async () => ({ ok: (await embedManager.show().catch(() => 'FAIL|ipc')).startsWith('OK') }))
ipcMain.handle('docx:embed-close', async () => ({ ok: (await embedManager.close().catch(() => 'FAIL|ipc')).startsWith('OK') }))
ipcMain.handle('docx:embed-alive', async () => (await embedManager.alive().catch(() => 'NO')) === 'YES')

// === 工作台：文件预览读取 + 文本保存 + Office 近似渲染 ===
ipcMain.handle('fs:read-text-file', async (event, { filePath, maxBytes = 1048576 }) => {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { error: '不是文件' }
    if (stat.size > maxBytes) return { error: `文件超过 ${Math.round(maxBytes / 1048576)}MB，请用系统打开`, tooBig: true, size: stat.size }
    const content = fs.readFileSync(filePath, 'utf8')
    return { content, size: stat.size, mtimeMs: stat.mtimeMs }
  } catch (err) {
    return { error: err.message }
  }
})

// v2.4.94：工作台 docx 高保真视图——返回文件 base64，渲染层用 docx-preview 分页渲染
ipcMain.handle('fs:docx-buffer', async (event, { filePath }) => {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { error: '不是文件' }
    if (stat.size > 20 * 1048576) return { error: `文档超过 20MB，请用系统打开`, tooBig: true, size: stat.size }
    return { base64: fs.readFileSync(filePath).toString('base64'), size: stat.size, mtimeMs: stat.mtimeMs }
  } catch (err) {
    return { error: err.message }
  }
})

// 工作台文本编辑保存：覆盖前自动快照备份原文件（误改兜底）
ipcMain.handle('fs:write-text-file', async (event, { filePath, content }) => {
  try {
    if (typeof filePath !== 'string' || !filePath.trim()) return { error: '路径无效' }
    if (typeof content !== 'string') return { error: '内容必须为文本' }
    if (Buffer.byteLength(content, 'utf8') > 2 * 1048576) return { error: '内容超过 2MB，请用系统打开编辑', tooBig: true }
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath)
      if (!st.isFile()) return { error: '目标不是文件' }
      try {
        const backupDir = path.join(app.getPath('userData'), 'mswork_snapshots', 'wb-edit-' + Date.now().toString(36))
        fs.mkdirSync(backupDir, { recursive: true })
        fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath) || 'file'))
      } catch {}
    }
    fs.writeFileSync(filePath, content, 'utf8')
    return { success: true, size: Buffer.byteLength(content, 'utf8') }
  } catch (err) {
    return { error: err.message }
  }
})

// Word/Excel 近似渲染为 HTML；PPT 等返回 fallback 让前端转系统打开
ipcMain.handle('fs:render-office', async (event, { filePath }) => {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 30 * 1048576) return { error: '文件超过 30MB', fallback: true }
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.docx') {
      const mammoth = require('mammoth')
      const result = await mammoth.convertToHtml({ path: filePath })
      return { html: result.value, kind: 'docx' }
    }
    if (ext === '.xlsx' || ext === '.xlsm') {
      const ExcelJS = require('exceljs')
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(filePath)
      let html = ''
      wb.eachSheet((ws) => {
        html += `<h3 class="pv-sheet-title">${ws.name.replace(/</g, '&lt;')}</h3>`
        html += '<table class="pv-xlsx">'
        ws.eachRow({ includeEmpty: true }, (row) => {
          html += '<tr>'
          const cells = []
          row.eachCell({ includeEmpty: true }, (cell) => {
            let v = cell.text || ''
            v = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            const isNum = typeof cell.value === 'number'
            cells.push(`<td class="${isNum ? 'num' : ''}">${v}</td>`)
          })
          // 补齐稀疏行（eachCell 跳过尾部空单元格）
          const total = ws.columnCount
          while (cells.length < total && total <= 200) cells.push('<td></td>')
          html += cells.join('') + '</tr>'
        })
        html += '</table>'
      })
      return { html, kind: 'xlsx' }
    }
    return { error: '该格式不支持内置渲染', fallback: true }
  } catch (err) {
    return { error: err.message, fallback: true }
  }
})

// === 工作台按会话持久化（userData/ai-chat/sessions/<id>/workbench.json）===
function getWbFile(sessionId) {
  if (!sessionStore) return null
  const dir = sessionStore.sessionDir(sessionId)
  if (!dir) return null
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, 'workbench.json')
}

ipcMain.handle('wb:get', async (event, { sessionId }) => {
  const file = getWbFile(sessionId)
  if (!file) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(data.items) ? { items: data.items, navs: data.navs || {} } : []
  } catch {
    return []
  }
})

ipcMain.handle('wb:set', async (event, { sessionId, items, navs }) => {
  const file = getWbFile(sessionId)
  if (!file) return false
  try {
    fs.writeFileSync(file, JSON.stringify({ items, navs, savedAt: Date.now() }))
    return true
  } catch {
    return false
  }
})

// 表格/Word 类默认走内置工作台预览（v2.4.54）：设置 preferOpen=system 时始终系统程序打开。
// 走 ai:workbench-open 通道：Work 模式进工作台页签；互联模式渲染层自动回退系统打开（openExternalFallback），不会双开
const BUILTIN_OPEN_EXTS = new Set(['.docx', '.xlsx'])

// 打开文件（系统默认程序）
ipcMain.handle('shell:open-file', async (event, { filePath, forceSystem }) => {
  try {
    // 远程设备的路径在本机不存在：给出可行动的提示，而不是让 Windows 弹"找不到文件"
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '本机不存在该文件——它可能位于远程设备上。可让 AI 用 transfer_file 把它复制过来后再打开' }
    }
    // 表格/Word 默认内置打开（设置里可选"系统优先"切回旧行为）；
    // forceSystem=true（工作台「系统打开」按钮等明确系统语义的入口）跳过分流，否则点系统打开会被送回工作台死循环
    const ext = path.extname(filePath).toLowerCase()
    if (!forceSystem && BUILTIN_OPEN_EXTS.has(ext) && (getSetting('preferOpen') || 'builtin') === 'builtin' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:workbench-open', {
        kind: 'file', path: filePath, name: path.basename(filePath), size: fs.statSync(filePath).size
      })
      return { success: true }
    }
    // openPath 成功返回空字符串，失败返回错误信息（不抛异常）
    const errMsg = await shell.openPath(filePath)
    return errMsg ? { success: false, error: errMsg } : { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 在资源管理器中显示
ipcMain.handle('shell:open-in-explorer', async (event, { filePath }) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '本机不存在该路径——它可能位于远程设备上' }
    }
    shell.showItemInFolder(filePath)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 拖出文件到桌面/资源管理器
ipcMain.on('drag:start', (event, { filePath }) => {
  try {
    const { nativeImage } = require('electron')
    const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png')
    let icon
    try { icon = nativeImage.createFromPath(iconPath) } catch {}
    event.sender.startDrag({
      file: filePath,
      icon: icon && !icon.isEmpty() ? icon : nativeImage.createEmpty()
    })
  } catch (err) {
    log(`drag:start error: ${err.message}`)
  }
})

// 本地新建文件夹
ipcMain.handle('file:create-local-folder', async (event, { parentPath, folderName }) => {
  try {
    const folderPath = path.join(parentPath, folderName)
    fs.mkdirSync(folderPath, { recursive: true })
    return { success: true, path: folderPath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 本地新建文件(txt/docx/xlsx/pptx)
ipcMain.handle('file:create-local-file', async (event, { parentPath, fileName, fileType }) => {
  try {
    const filePath = path.join(parentPath, fileName)
    if (fileType === 'txt') {
      fs.writeFileSync(filePath, '')
    } else if (['docx', 'xlsx', 'pptx'].includes(fileType)) {
      await createOfficeFile(filePath, fileType)
    } else {
      fs.writeFileSync(filePath, '')
    }
    return { success: true, path: filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 复制文件到本地目录（外部拖到本地面板）
ipcMain.handle('file:copy-to-local', async (event, { srcPath, destDir }) => {
  try {
    const fileName = path.basename(srcPath)
    const destPath = path.join(destDir, fileName)
    const stats = fs.statSync(srcPath)
    if (stats.isDirectory()) {
      copyFolderRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
    return { success: true, path: destPath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 远程新建文件
ipcMain.handle('file:create-remote-file', async (event, { deviceId, filePath, fileType }) => {
  return tcpAgent.createRemoteFile(deviceId, filePath, fileType)
})

ipcMain.handle('fs:exists', async (event, targetPath) => {
  try {
    fs.accessSync(targetPath)
    return true
  } catch {
    return false
  }
})

// 获取本地磁盘空间
ipcMain.handle('fs:get-disk-space', async (event, targetPath) => {
  try {
    if (!targetPath || targetPath === 'root') return null
    const { total, used, free } = getDiskSpace(targetPath)
    return { total, used, free, path: targetPath }
  } catch {
    return null
  }
})

// 获取远程磁盘空间
ipcMain.handle('file:get-remote-disk-space', async (event, { deviceId, targetPath }) => {
  try {
    if (!tcpAgent || !deviceId || !targetPath || targetPath === 'root') return null
    return await tcpAgent.getRemoteDiskSpace(deviceId, targetPath)
  } catch {
    return null
  }
})

// 远程复制/移动文件
ipcMain.handle('file:copy-remote', async (event, { deviceId, srcPath, destDir }) => {
  try {
    return await tcpAgent.copyRemoteFile(deviceId, srcPath, destDir)
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('file:move-remote', async (event, { deviceId, srcPath, destDir }) => {
  try {
    return await tcpAgent.moveRemoteFile(deviceId, srcPath, destDir)
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 本地重命名
ipcMain.handle('file:rename-local', async (event, { oldPath, newName }) => {
  try {
    const dir = path.dirname(oldPath)
    const newPath = path.join(dir, newName)
    fs.renameSync(oldPath, newPath)
    return { success: true, newPath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 本地删除（文件直接删除，文件夹递归删除）
ipcMain.handle('file:delete-local', async (event, { filePath }) => {
  try {
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true })
    } else {
      fs.unlinkSync(filePath)
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// 获取下载目录
ipcMain.handle('app:get-downloads-dir', async () => {
  try {
    return path.join(os.homedir(), 'Downloads')
  } catch {
    return os.homedir()
  }
})

ipcMain.handle('app:get-desktop-dir', async () => {
  try {
    return app.getPath('desktop')
  } catch {
    return path.join(os.homedir(), 'Desktop')
  }
})

// 传输历史
ipcMain.handle('history:get', async () => {
  try {
    return JSON.parse(fs.readFileSync(getHistoryPath(), 'utf8'))
  } catch {
    return []
  }
})

ipcMain.handle('history:clear', async () => {
  try {
    fs.writeFileSync(getHistoryPath(), '[]')
    return true
  } catch {
    return false
  }
})

// ===== 开机自启（v2.5.1）：Windows 注册表 Run 键，Electron setLoginItemSettings 标准方案 =====
// 开发态 process.execPath 是 electron.exe，需带 app 路径参数；打包后是 MSMate.exe，无参数
function applyAutoStart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname)]
    })
    return true
  } catch (e) {
    log(`开机自启设置失败: ${e.message}`)
    return false
  }
}
ipcMain.handle('app:get-autostart', () => {
  try { return { enabled: !!app.getLoginItemSettings({ path: process.execPath, args: app.isPackaged ? [] : [path.resolve(__dirname)] }).openAtLogin } }
  catch { return { enabled: false } }
})
ipcMain.handle('app:set-autostart', (event, { enabled }) => {
  const ok = applyAutoStart(!!enabled)
  setSetting('autoStart', !!enabled && ok)
  try { return { success: ok, enabled: !!app.getLoginItemSettings({ path: process.execPath, args: app.isPackaged ? [] : [path.resolve(__dirname)] }).openAtLogin } }
  catch { return { success: ok, enabled: !!enabled } }
})

// 设置
ipcMain.handle('settings:get', async (event, { key }) => {
  return getSetting(key)
})

ipcMain.handle('settings:set', async (event, { key, value }) => {
  const result = setSetting(key, value)
  // 对讲机热键变更 → 立即重新注册
  if (key === 'pttHotkey') startPTTHotkey()
  // 设备扫描频率变更 → 立即生效
  if (key === 'scanIntervalMs' && udpDiscovery && udpDiscovery.setBroadcastInterval) {
    udpDiscovery.setBroadcastInterval(value)
  }
  return result
})

// === 账号体系（msmate-api：邮箱注册/登录；token 存 userData/settings.json）===
// 游客可用：互传核心不依赖账号；账号用于后续云同步/远程/积分等在线能力
// MSMATE_API_BASE 环境变量可覆盖服务地址（本地联调用）
// 注意：api.mosina.top 域名在备案完成前会被腾讯云/运营商 DPI 拦截（连 API POST 也拦），
// 故默认走 IP 直连；备案通过后把默认值切回域名
const AUTH_API_BASE = process.env.MSMATE_API_BASE || 'http://101.43.150.46:3210'

function authRequest(pathname, { method = 'GET', body = null, token = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(AUTH_API_BASE + pathname)
    const mod = u.protocol === 'http:' ? require('http') : require('https')
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    let payload = null
    if (body != null) {
      payload = JSON.stringify(body)
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = mod.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let data = {}
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { }
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('timeout', () => { try { req.destroy(new Error('网络请求超时')) } catch { } })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function authGetSaved() {
  const a = getSetting('auth')
  // 读取时也归一化：老存档（authSave 修复前写入）avatarUrl 是相对路径，启动首屏直接渲染会加载失败
  if (a && typeof a === 'object' && a.token && a.user) return { token: a.token, user: normalizeUser(a.user) }
  return { token: '', user: null }
}

function authSave(token, user) {
  // 落盘前归一化 user：avatarUrl 相对路径转绝对 URL。修复"头像偶发回退默认"——
  // 存档里若是 /avatars/... 相对路径，file:// 渲染层启动加载不出来，点开账号面板触发 auth:me 才恢复
  setSetting('auth', token ? { token, user: user ? normalizeUser(user) : null } : null)
  // 内置模型服务商条目同步进 aiProviderList（槽位机制用）：有 token 带 key，登出只清 key（槽位回落用户自己的服务商）
  try {
    const list = JSON.parse(getSetting('aiProviderList') || '[]') || []
    let p = list.find(x => x && x.id === 'msmate')
    if (!token) {
      if (p) p.apiKey = ''
    } else {
      if (!p) { p = { id: 'msmate', name: 'MSMate 内置（扣积分）' }; list.push(p) }
      p.baseUrl = AUTH_API_BASE + '/v1/ai/openai'
      p.apiKey = token
    }
    setSetting('aiProviderList', JSON.stringify(list))
  } catch { }
}

ipcMain.handle('auth:get-state', () => {
  const a = authGetSaved()
  return { token: a.token || '', user: a.user || null }
})

// ===== 应用层传输加密（v0.6）：备案前 HTTP 明文链路的过渡防护 =====
// 首次用到时拉取服务端 RSA 公钥（内存缓存，失败不重试避免每次请求都卡），
// 密码字段用 RSA-OAEP-SHA256 加密成 passwordEnc；公钥拿不到则回退明文（旧服务端兼容）。
// 备案过后叠加真 HTTPS，此层保留作纵深防御。
let AUTH_PUBKEY = ''
let AUTH_PUBKEY_TRIED = false
function ensureAuthPubkey() {
  if (AUTH_PUBKEY || AUTH_PUBKEY_TRIED) return Promise.resolve()
  AUTH_PUBKEY_TRIED = true
  return authRequest('/v1/auth/pubkey', { method: 'GET', timeoutMs: 8000 })
    .then(({ data }) => {
      if (data && data.ok && data.pubkey) AUTH_PUBKEY = String(data.pubkey)
    })
    .catch(() => { })
}
function encryptPassword(password) {
  if (!AUTH_PUBKEY) return null
  try {
    return crypto.publicEncrypt(
      { key: AUTH_PUBKEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(String(password), 'utf8')
    ).toString('base64')
  } catch { return null }
}
// 组装认证请求体：公钥可用 → passwordEnc（密文）；不可用 → 明文 password（兼容旧服务端）
async function authBodyWithPassword(base) {
  await ensureAuthPubkey()
  const enc = encryptPassword(base.password)
  if (enc) {
    const b = Object.assign({}, base, { passwordEnc: enc })
    delete b.password
    return b
  }
  return base
}

ipcMain.handle('auth:register', async (event, { email, password, nickname, code }) => {
  try {
    // agree:'v1' = 协议同意记录（渲染层注册表单已强制勾选，服务端存档防扯皮）
    const body = await authBodyWithPassword({ email, password, nickname, code, agree: 'v1' })
    const r = await authRequest('/v1/auth/register', { method: 'POST', body })
    if (r.status === 200 && r.data && r.data.ok) {
      authSave(r.data.token, r.data.user)
      syncKickoff()
      return { ok: true, user: normalizeUser(r.data.user) }
    }
    return { ok: false, error: (r.data && r.data.error) || `注册失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

ipcMain.handle('auth:login', async (event, { email, password }) => {
  try {
    const body = await authBodyWithPassword({ email, password })
    const r = await authRequest('/v1/auth/login', { method: 'POST', body })
    if (r.status === 200 && r.data && r.data.ok) {
      authSave(r.data.token, r.data.user)
      syncKickoff()
      return { ok: true, user: normalizeUser(r.data.user) }
    }
    return { ok: false, error: (r.data && r.data.error) || `登录失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// 启动时后台校验 token：过期则静默清除，离线则保留本地态
ipcMain.handle('auth:me', async () => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, user: null }
  try {
    const r = await authRequest('/v1/auth/me', { token: a.token })
    if (r.status === 200 && r.data && r.data.ok) {
      // 滑动续签：服务端换发新 token 时保存新值（同步刷新 aiProviderList 里内置服务商的 key）
      authSave(r.data.token || a.token, r.data.user)
      syncKickoff() // 启动校验成功 = 已登录，触发云同步对账
      return { ok: true, user: normalizeUser(r.data.user) }
    }
    if (r.status === 401) authSave(null)
    return { ok: false, user: r.status === 401 ? null : a.user }
  } catch {
    return { ok: false, user: a.user, offline: true }
  }
})

ipcMain.handle('auth:logout', () => {
  authSave(null)
  return { ok: true }
})

// 资料编辑：改昵称（成功后同步本地存档）
ipcMain.handle('auth:profile', async (event, { nickname }) => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '尚未登录' }
  try {
    const r = await authRequest('/v1/auth/profile', { method: 'PATCH', body: { nickname }, token: a.token })
    if (r.status === 200 && r.data && r.data.ok) {
      authSave(a.token, r.data.user)
      return { ok: true, user: normalizeUser(r.data.user) }
    }
    return { ok: false, error: (r.data && r.data.error) || `保存失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// === 邮箱验证码 / 头像 / 积分 / 云同步（对应服务端 v0.3） ===

// 用户信息归一化：avatarUrl 相对路径 → 绝对 URL（渲染层 <img> 直接可用）
function normalizeUser(u) {
  if (u && typeof u.avatarUrl === 'string' && u.avatarUrl.startsWith('/')) {
    u.avatarUrl = AUTH_API_BASE + u.avatarUrl
  }
  return u
}

// 邮箱验证码（scene: register|reset）；dev 模式服务端直接返回 devCode
ipcMain.handle('auth:send-code', async (event, { email, scene }) => {
  try {
    const r = await authRequest('/v1/auth/send-code', { method: 'POST', body: { email, scene } })
    return { ok: !!(r.data && r.data.ok), sent: !!(r.data && r.data.sent), devCode: r.data && r.data.devCode, error: (r.data && r.data.error) || (r.status !== 200 ? `HTTP ${r.status}` : '') }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// 验证码重置密码（服务端会吊销旧 token，返回新 token 直接续登录态）
ipcMain.handle('auth:reset', async (event, { email, code, password }) => {
  try {
    const body = await authBodyWithPassword({ email, code, password })
    const r = await authRequest('/v1/auth/reset', { method: 'POST', body })
    if (r.status === 200 && r.data && r.data.ok) {
      authSave(r.data.token, r.data.user)
      return { ok: true, user: normalizeUser(r.data.user) }
    }
    return { ok: false, error: (r.data && r.data.error) || `重置失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// v2.7.16：用户反馈提交（须登录；服务端存档 + ntfy 通知管理员，详细问题引导去 GitHub Issues）
ipcMain.handle('feedback:submit', async (event, { type, content, contact }) => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '反馈需要先登录；游客请在 GitHub Issues 反馈' }
  try {
    const r = await authRequest('/v1/feedback', {
      method: 'POST', token: a.token,
      body: { type, content, contact, appVersion: app.getVersion() }
    })
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, seq: r.data.seq }
    return { ok: false, error: (r.data && r.data.error) || `提交失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// v2.7.16：内置浏览器/网页页签下载进度——接管默认 session 的 will-download，
// 进度实时推给渲染层浮条（此前下载走 Electron 默认行为，无任何进度提示）
function setupWebDownload() {
  session.defaultSession.on('will-download', (event, item, wc) => {
    const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : wc
    const meta = {
      id: 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: item.getFilename(), path: '',
      received: 0, total: item.getTotalBytes(), state: 'progressing'
    }
    item.on('updated', (_e, state) => {
      meta.state = state
      meta.received = item.getReceivedBytes()
      meta.total = item.getTotalBytes()
      meta.path = item.getSavePath()
      try { target.send('wb:download-progress', meta) } catch { }
    })
    item.once('done', (_e, state) => {
      meta.state = state // completed | canceled | interrupted
      meta.path = item.getSavePath()
      try { target.send('wb:download-progress', meta) } catch { }
    })
  })
}

// 上传头像（渲染层已压成 128x128 base64 dataUrl）
ipcMain.handle('auth:avatar', async (event, { dataUrl }) => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '尚未登录' }
  try {
    const r = await authRequest('/v1/auth/avatar', { method: 'POST', body: { dataUrl }, token: a.token, timeoutMs: 30000 })
    if (r.status === 200 && r.data && r.data.ok) {
      authSave(a.token, r.data.user)
      return { ok: true, user: normalizeUser(r.data.user) }
    }
    return { ok: false, error: (r.data && r.data.error) || `上传失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// === 积分充值（个人收款码 + 凭证人工批款） ===

ipcMain.handle('credits:order-create', async (event, { amount }) => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '登录后才能充值' }
  try {
    const r = await authRequest('/v1/credits/orders', { method: 'POST', body: { amount }, token: a.token })
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, order: r.data.order }
    return { ok: false, error: (r.data && r.data.error) || `下单失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

ipcMain.handle('credits:order-voucher', async (event, { id, voucher }) => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '尚未登录' }
  try {
    const r = await authRequest(`/v1/credits/orders/${encodeURIComponent(id)}/voucher`, { method: 'POST', body: { voucher }, token: a.token })
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, order: r.data.order }
    return { ok: false, error: (r.data && r.data.error) || `提交失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

ipcMain.handle('credits:orders-my', async () => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '尚未登录', orders: [] }
  try {
    const r = await authRequest('/v1/credits/orders/my', { token: a.token })
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, orders: r.data.orders || [] }
    return { ok: false, error: (r.data && r.data.error) || `查询失败（HTTP ${r.status}）`, orders: [] }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}`, orders: [] }
  }
})

ipcMain.handle('credits:order-cancel', async (event, { id }) => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '尚未登录' }
  try {
    const r = await authRequest(`/v1/credits/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', token: a.token })
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, order: r.data.order }
    return { ok: false, error: (r.data && r.data.error) || `取消失败（HTTP ${r.status}）` }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

ipcMain.handle('credits:balance', async () => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, credits: 0 }
  try {
    const r = await authRequest('/v1/credits/balance', { token: a.token })
    if (r.status === 200 && r.data && r.data.ok) return { ok: true, credits: r.data.credits || 0 }
    return { ok: false, credits: 0 }
  } catch {
    return { ok: false, credits: 0, offline: true }
  }
})

// 每日签到（+50/天，累计封顶 200）：成功后同步本地存档的余额与签到进度
ipcMain.handle('credits:signin', async () => {
  const a = authGetSaved()
  if (!a.token) return { ok: false, error: '登录后才能签到' }
  try {
    const r = await authRequest('/v1/credits/signin', { method: 'POST', token: a.token })
    const d = r.data || {}
    if (r.status === 200 && d.ok) {
      if (a.user) {
        a.user.credits = d.credits
        a.user.sign = { total: d.total, lastDate: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) }
        authSave(a.token, a.user)
      }
      return { ok: true, awarded: d.awarded, total: d.total, cap: d.cap, credits: d.credits }
    }
    return { ok: false, error: d.error || `签到失败（HTTP ${r.status}）`, total: d.total, cap: d.cap, credits: d.credits }
  } catch (err) {
    return { ok: false, error: `网络错误：${err.message}` }
  }
})

// === 云同步：登录后自动 把「Work 会话 + AI 设置」备份到账号，换设备登录自动恢复 ===
// 策略：登录/启动校验成功后运行一次——云端较新则恢复（恢复前把本地 ai-chat 备份），否则推送本地
// 之后每 5 分钟：本地数据有变化（hash 不同）自动推送。恢复后需重启应用加载会话，会弹提示。

const SYNC_SETTING_KEYS = ['aiApiKey', 'aiBaseUrl', 'aiProviderList', 'chatModelList', 'visionModelList', 'aiWebDeepseek', 'aiTtsModel', 'aiTtsVoice']
const SYNC_PUSH_INTERVAL_MS = 5 * 60 * 1000

function syncHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex')
}

// 递归收集目录下所有 .json：{ 相对路径: 解析后的对象 }
function syncCollectJson(dir, baseRel, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    const rel = baseRel ? baseRel + '/' + ent.name : ent.name
    if (ent.isDirectory()) {
      syncCollectJson(full, rel, out)
    } else if (ent.isFile() && ent.name.endsWith('.json')) {
      try { out[rel] = JSON.parse(fs.readFileSync(full, 'utf8')) } catch { }
    }
  }
}

function syncGatherBlob() {
  const root = app.getPath('userData')
  const blob = { v: 1, aiChat: {}, settings: {} }
  syncCollectJson(path.join(root, 'ai-chat'), '', blob.aiChat)
  for (const k of SYNC_SETTING_KEYS) {
    try { const v = getSetting(k); if (v !== undefined) blob.settings[k] = v } catch { }
  }
  return blob
}

function syncCopyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  let entries = []
  try { entries = fs.readdirSync(src, { withFileTypes: true }) } catch { return }
  for (const ent of entries) {
    const s = path.join(src, ent.name), d = path.join(dest, ent.name)
    if (ent.isDirectory()) syncCopyDir(s, d)
    else if (ent.isFile()) { try { fs.copyFileSync(s, d) } catch { } }
  }
}

// 应用云端 blob：先备份本地 ai-chat（防同步翻车可回滚），再覆盖写盘 + 回填设置
function syncApplyBlob(blob) {
  const root = app.getPath('userData')
  const chatDir = path.join(root, 'ai-chat')
  if (fs.existsSync(chatDir)) {
    try { syncCopyDir(chatDir, path.join(root, `ai-chat.bak-${Date.now()}`)) } catch { }
  }
  // 清空会话目录后重写（备份已留存）
  try { fs.rmSync(chatDir, { recursive: true, force: true }) } catch { }
  fs.mkdirSync(chatDir, { recursive: true })
  const files = blob && blob.aiChat ? blob.aiChat : {}
  for (const rel of Object.keys(files)) {
    const norm = String(rel).replace(/\\/g, '/')
    if (norm.includes('..')) continue // 防路径穿越
    if (norm.split('/').length > 3) continue // 只收 根文件 / 一级 / 二级子目录（sessions/<id>/mswork_chat.json）
    const dest = path.join(chatDir, norm)
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, JSON.stringify(files[rel], null, 2))
    } catch { }
  }
  const st = blob && blob.settings ? blob.settings : {}
  for (const k of SYNC_SETTING_KEYS) {
    if (st[k] !== undefined) { try { setSetting(k, st[k]) } catch { } }
  }
}

let syncRunning = false
let syncLastPushHash = ''

async function syncAutoRun(reason) {
  if (syncRunning) return
  const a = authGetSaved()
  if (!a.token) return
  syncRunning = true
  try {
    const local = syncGatherBlob()
    const localHash = syncHash(JSON.stringify(local))
    syncLastPushHash = localHash
    const st = getSetting('syncState') || {}
    const r = await authRequest('/v1/sync', { token: a.token, timeoutMs: 20000 })
    if (r.status === 200 && r.data && r.data.ok && r.data.blob) {
      const cloudUpdatedAt = r.data.updatedAt || ''
      const cloudNewer = !st.lastSyncAt || !cloudUpdatedAt || new Date(cloudUpdatedAt) > new Date(st.lastSyncAt)
      const cloudHash = syncHash(JSON.stringify(r.data.blob))
      if (cloudNewer && cloudHash !== localHash) {
        // 云端较新且内容不同 → 恢复云端到本地（先备份）
        syncApplyBlob(r.data.blob)
        setSetting('syncState', { lastSyncAt: new Date().toISOString(), lastHash: cloudHash })
        syncLastPushHash = cloudHash
        try {
          const { BrowserWindow } = require('electron')
          const win = BrowserWindow.getAllWindows()[0]
          if (win) win.webContents.send('notification:toast', { message: '已从云端恢复会话与 AI 设置，重启应用后生效', type: 'success' })
        } catch { }
      } else if (cloudHash !== localHash) {
        // 云端较旧 → 推送本地覆盖云端
        await authRequest('/v1/sync', { method: 'PUT', token: a.token, body: { blob: local }, timeoutMs: 30000 })
        setSetting('syncState', { lastSyncAt: new Date().toISOString(), lastHash: localHash })
      } else {
        setSetting('syncState', { lastSyncAt: new Date().toISOString(), lastHash: localHash })
      }
    } else if (r.status === 200 && r.data && r.data.ok && !r.data.blob) {
      // 云端为空：首推
      await authRequest('/v1/sync', { method: 'PUT', token: a.token, body: { blob: local }, timeoutMs: 30000 })
      setSetting('syncState', { lastSyncAt: new Date().toISOString(), lastHash: localHash })
    }
  } catch { /* 离线静默 */ } finally {
    syncRunning = false
  }
}

// 定时推送：本地会话/设置变化后 5 分钟内自动备份到云端
setInterval(() => {
  const a = authGetSaved()
  if (!a.token) return
  const local = syncGatherBlob()
  const h = syncHash(JSON.stringify(local))
  if (h !== syncLastPushHash) syncAutoRun('periodic').catch(() => { })
}, SYNC_PUSH_INTERVAL_MS)

// 登录成功后的同步入口（供 auth handler 触发，不阻塞登录流程）
function syncKickoff() {
  setTimeout(() => syncAutoRun('login').catch(() => { }), 2500)
}

ipcMain.handle('sync:run-now', () => {
  syncAutoRun('manual').catch(() => { })
  return { ok: true }
})

// ===== 互联网设备在线登记（v0.4）：登录设备 30s 心跳上报 msmate-api /v1/presence =====
// 服务端记录公网 IP，其他设备拉列表拿到 IP 后走 tcpAgent P2P 直连（端口 45679）
async function presencePing() {
  const a = authGetSaved()
  if (!a || !a.token) return
  try {
    await authRequest('/v1/presence', {
      method: 'POST', token: a.token, timeoutMs: 10000,
      body: { deviceId: tcpAgent.deviceId, name: tcpAgent.deviceName || os.hostname(), platform: process.platform }
    })
  } catch { /* 离线静默，下轮心跳补 */ }
}
setInterval(() => { presencePing() }, 30000)
setTimeout(() => { presencePing() }, 5000) // 启动后尽快上线

// === MSWork AI 助手 IPC ===
// ===== 定时任务（v2.4.97）：设置里配置"每天 HH:MM 给某个会话派发任务"，到点自动给 WorkAgent 发消息 =====
// 应用开着才触发；启动/唤醒时补跑今天已到时但没跑的（消息会注明"错过补跑"）；lastRun 按天防重
let schedLastRun = new Map() // taskId -> 'YYYY-MM-DD'
function schedTodayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function schedHHMM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
async function runSchedules(catchUp = false) {
  let list = []
  try { list = JSON.parse(getSetting('aiSchedules') || '[]') } catch {}
  if (!Array.isArray(list) || !list.length) return
  const today = schedTodayStr()
  const now = schedHHMM()
  for (const t of list) {
    if (!t || !t.id || !t.enabled || !/^\d{2}:\d{2}$/.test(String(t.time || '')) || !String(t.task || '').trim()) continue
    if (schedLastRun.get(t.id) === today) continue
    const due = catchUp ? (String(t.time) <= now) : (String(t.time) === now)
    if (!due) continue
    const agent = getWorkAgent(t.sessionId)
    if (!agent || agent.running || runningAgentCount() >= MAX_CONCURRENT_RUNS) continue // 忙/满载：本轮不标记，下轮重试
    schedLastRun.set(t.id, today)
    const tag = catchUp ? '【定时任务·错过补跑' : '【定时任务'
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai:event', { sessionId: t.sessionId, type: 'schedule_fired', task: String(t.task), time: String(t.time), catchUp })
      }
      await agent.sendUserMessage(`${tag}（${t.time}）】${String(t.task).trim()}\n（这是定时任务自动派发的消息，直接按任务执行，完成后简要汇报）`)
    } catch (err) {
      log(`[定时任务] 派发失败: ${err.message}`)
      schedLastRun.delete(t.id) // 失败允许重试
    }
  }
}

// ===== 应用更新：检查 + 应用内下载 + 安装（v2.4.97 检查 / v2.5.0 下载安装闭环）=====
// 状态机放模块顶层：before-quit 自动安装也要读它（registerAIIPC 块内定义顶层摸不到）
const BUILTIN_UPDATE_REPO = 'Mosina1102/MSMate' // v2.4.99：更新源内置（用户无感；设置 updateRepo 可覆盖换源）
const cmpVersions = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x) || 0)
  for (let i = 0; i < 4; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d }
  return 0
}
const updateState = { status: 'idle', percent: 0, receivedMB: 0, totalMB: 0, version: '', file: '', installing: false, installOnQuit: false }
const updateDir = () => { const d = path.join(app.getPath('userData'), 'update'); try { fs.mkdirSync(d, { recursive: true }) } catch (e) {} return d }
const updateRepoOf = () => (String(getSetting('updateRepo') || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')) || BUILTIN_UPDATE_REPO
const fetchLatestRelease = async () => {
  const repo = updateRepoOf()
  const r = await httpGet(`https://api.github.com/repos/${repo}/releases/latest`, 12000, { Accept: 'application/vnd.github+json', 'User-Agent': 'MSMate-Updater' })
  if (r.status === 404) return { error: 'NO_RELEASE', message: `仓库 ${repo} 还没有 Release：把打包好的 exe 传上去就能用了` }
  if (r.status !== 200) return { error: `HTTP_${r.status}`, message: `检查失败（HTTP ${r.status}），稍后再试` }
  const data = JSON.parse(r.buf.toString('utf8'))
  const latest = String(data.tag_name || '').replace(/^v/i, '').trim()
  const current = app.getVersion()
  const hasUpdate = !!latest && cmpVersions(latest, current) > 0
  const asset = Array.isArray(data.assets) ? data.assets.find((a) => /\.exe$/i.test(a.name || '')) : null
  return {
    hasUpdate, latest, current,
    url: (asset && asset.browser_download_url) || data.html_url || `https://github.com/${repo}/releases`,
    assetSize: asset ? asset.size : 0,
    name: String(data.name || ''),
    notes: String(data.body || '').slice(0, 600)
  }
}
const updateProgressPush = (() => { // 进度节流：至少间隔 600ms 才往渲染层推（太密没必要）
  let last = 0
  return (force) => {
    const now = Date.now()
    if (!force && now - last < 600) return
    last = now
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:dl-progress', { status: updateState.status, percent: updateState.percent, receivedMB: updateState.receivedMB, totalMB: updateState.totalMB, version: updateState.version, error: '' }) } catch (e) {}
  }
})()
// 启动时扫描已下载完的更新包：完整 exe 且版本比当前新 → readyToInstall（旧包清理）
function scanReadyUpdate() {
  try {
    const files = fs.readdirSync(updateDir()).filter((f) => /^MSMate\.Setup\.[\d.]+\.exe$/i.test(f))
    for (const f of files) {
      const v = (f.match(/([\d.]+)\.exe$/i) || [])[1] || ''
      const full = path.join(updateDir(), f)
      if (v && cmpVersions(v, app.getVersion()) > 0 && !updateState.file) {
        updateState.status = 'readyToInstall'; updateState.version = v; updateState.file = full; updateState.percent = 100
      } else {
        try { fs.unlinkSync(full) } catch (e) {} // 比当前版本还旧的包没用了，清掉
      }
    }
  } catch (e) {}
}
// v2.5.2 修复"重启更新弹黑窗且装不上"：不再用 cmd.exe+ping+start 链（windowsHide 对 detached cmd 失效→黑窗；
// ping 只等 2 秒但主进程退出常超 2 秒→安装器抢跑→MSMate.exe 文件被锁→NSIS 静默安装失败）。
// 新时序：install/before-quit 只置标记 → will-quit（主进程最后一口气）直接 detached 启动安装器 exe /S；
// 安装器自身加载 1-3 秒 + installer.nsh 里等旧进程死透/强杀兜底，双保险零竞争、零黑窗。
// v2.5.6 三件套之一：spawn 时注入 TEMP/TMP=安装目录同卷临时目录——NSIS 升级卸载旧版时要把旧文件
// Rename 到 $PLUGINSDIR（位于 %TEMP%），装在非 C 盘（如 F:\MS\...）时跨盘 Rename 必然失败
// → 卸载器 Abort(2) → "Failed to uninstall old application files.. 2" → 安装中止。同卷 TEMP 根治。
const updateTempDir = () => {
  try {
    if (!app.isPackaged) return null
    const d = path.join(path.dirname(process.execPath), '..', 'msmate-update-temp')
    fs.mkdirSync(d, { recursive: true })
    return d
  } catch (e) { return null }
}
const spawnInstaller = () => {
  try {
    if (app.isPackaged) {
      const tmp = updateTempDir()
      const env = tmp ? { ...process.env, TEMP: tmp, TMP: tmp } : process.env
      spawn(updateState.file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
    } else {
      spawn(updateState.file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    }
    updateState.installing = true
    log(`更新安装器已启动（静默${updateTempDir() ? '+同卷TEMP' : ''}）: ${updateState.file}`)
    return true
  } catch (e) { log(`启动安装器失败: ${e.message}`); return false }
}

// v2.5.6：进度窗进程（runUpdateProgressMode）整体下线——它从旧 exe 运行且全程存活，锁死安装目录
// 导致升级卸载必炸；"正在安装"感知改由主窗口遮罩（app.js installUpdateNow）+ 安装器自动拉起新版。
// 注：老版本拉起的进度窗进程由 installer.nsh customInit 的无差别强杀兜底收掉。

// v2.5.4：把 Release 说明存到本地——更新安装完的首次启动弹"更新了什么"弹窗用
function saveUpdateNotes(rel) {
  try {
    if (rel && rel.latest && (rel.notes || '').trim()) setSetting('updateNotes', { version: rel.latest, notes: String(rel.notes), date: Date.now() })
  } catch (e) { log(`保存更新说明失败: ${e.message}`) }
}

function registerAIIPC() {
  // v2.4.77 图片编辑器新流程（老大拍板：改图指令移到对话框，保留历史）：编辑器只负责合成"纯黑遮罩版原图"
  // 并存临时文件 → 前端把该文件以 [引用文件: …] 塞进聊天框 → 用户自己写指令发送 → AI 走 generate_image
  // 的编辑链路（v2.4.75）。改图指令留在会话历史里，天然可追溯
  ipcMain.handle('fs:save-dataurl-file', async (event, { dataUrl, filePath } = {}) => {
    try {
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(dataUrl || ''))
      if (!m) return { ok: false, message: '图片数据无效（需要 dataURL）' }
      if (!filePath || !/^[A-Za-z]:[\\/]/.test(String(filePath))) return { ok: false, message: '保存路径无效' }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'))
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, message: `保存失败：${err.message}` }
    }
  })

  // v2.4.77 图片编辑器：合成图存 userData/iedit-tmp（保留=历史可追溯），前端需要拿到 userData 路径拼文件名
  ipcMain.handle('app:get-user-data-path', () => app.getPath('userData'))

  // v2.4.76 图片编辑器用：本地图片读成 base64（编辑器以 dataURL 显示，避免 file:// 画布污染导致 toDataURL 报 SecurityError）
  ipcMain.handle('fs:read-file-base64', async (event, { path: p } = {}) => {
    try {
      if (!p || !/^[A-Za-z]:[\\/]/.test(String(p))) return { ok: false, message: '路径无效' }
      const buf = fs.readFileSync(p)
      if (buf.length > 20 * 1024 * 1024) return { ok: false, message: '图片超过 20MB，编辑器不支持' }
      const ext = String(p).replace(/^.*\./, '').toLowerCase()
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png'
      return { ok: true, base64: buf.toString('base64'), mime }
    } catch (err) {
      return { ok: false, message: `读取失败：${err.message}` }
    }
  })

  ipcMain.handle('ai:openWorkspace', async () => {
    try {
      const dir = workAgent && workAgent.workspaceDir ? workAgent.workspaceDir : path.join(app.getPath('userData'), 'workspace')
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      await shell.openPath(dir)
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  // 系统打开回退（互联模式无工作台，AI 打开的文件/网址由渲染层回退到此通道）
  ipcMain.handle('sys:open-external', async (event, { path: p, url }) => {
    try {
      if (url) {
        if (!/^https?:\/\//i.test(String(url))) return { success: false, error: '仅支持 http/https' }
        shell.openExternal(String(url))
        return { success: true }
      }
      const target = String(p || '')
      if (!target) return { success: false, error: '缺少 path' }
      const errMsg = await shell.openPath(target)
      if (errMsg) return { success: false, error: errMsg }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  ipcMain.handle('ai:openNotes', async () => {
    try {
      const dir = workAgent && workAgent.workspaceDir ? workAgent.workspaceDir : path.join(app.getPath('userData'), 'workspace')
      try { fs.mkdirSync(dir, { recursive: true }) } catch {}
      const notesPath = path.join(dir, 'NOTES.md')
      if (!fs.existsSync(notesPath)) fs.writeFileSync(notesPath, '# 工作台记事本（大笔记本）\n\n（AI 会把跨对话的长期信息写在这里：你的习惯喜好、项目背景、踩坑经验等）\n', 'utf8')
      const errMsg = await shell.openPath(notesPath)
      if (errMsg) return { success: false, error: errMsg }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  // ===== 数据同步：导出/导入全量数据（settings.json + ai-chat + workspace） =====
  // 核心逻辑在 ai/data-sync.js（可冒烟测试）；这里只负责弹窗选路径 + 重启
  ipcMain.handle('ai:export-data', async (event, { defaultName } = {}) => {
    try {
      if (!packData || !applyImport) return { success: false, error: 'AI 模块未加载' }
      let JSZip
      try { JSZip = require('jszip') } catch { return { success: false, error: '缺少 jszip 依赖' } }
      const userDataPath = app.getPath('userData')
      const res = await dialog.showSaveDialog(mainWindow, {
        title: '导出 MSMate 数据',
        defaultPath: defaultName || 'msmate-data.zip',
        filters: [{ name: 'MSMate 数据包', extensions: ['zip'] }]
      })
      if (res.canceled || !res.filePath) return { canceled: true }
      const zip = new JSZip()
      const { fileCount } = packData(userDataPath, zip)
      if (!fileCount) return { success: false, error: '没有可导出的数据' }
      zip.file('manifest.json', JSON.stringify({ app: 'MSMate', version: app.getVersion(), exportedAt: Date.now(), files: fileCount }, null, 2))
      const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      fs.writeFileSync(res.filePath, buf)
      log(`[data-sync] 导出成功: ${res.filePath} (${fileCount} 个文件)`)
      return { success: true, path: res.filePath, files: fileCount }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  ipcMain.handle('ai:import-data', async () => {
    try {
      if (!applyImport) return { success: false, error: 'AI 模块未加载' }
      let JSZip
      try { JSZip = require('jszip') } catch { return { success: false, error: '缺少 jszip 依赖' } }
      const userDataPath = app.getPath('userData')
      const res = await dialog.showOpenDialog(mainWindow, {
        title: '导入 MSMate 数据',
        filters: [{ name: 'MSMate 数据包', extensions: ['zip'] }],
        properties: ['openFile']
      })
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true }
      const zipPath = res.filePaths[0]
      const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
      const { restored, backupDir } = await applyImport(userDataPath, zip)
      log(`[data-sync] 导入成功: ${zipPath}（恢复 ${restored} 个文件，备份 → ${backupDir}）`)
      return { success: true, summary: `恢复 ${restored} 个文件，原数据已备份到 mswork_snapshots` }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
  ipcMain.handle('ai:restart-app', async () => {
    app.relaunch()
    app.exit(0)
    return { success: true }
  })
  ipcMain.handle('ai:send', async (event, { text, sessionId }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return { success: false, error: 'AI 功能未加载' }
    if (runningAgentCount() >= MAX_CONCURRENT_RUNS && !agent.running) {
      return { success: false, error: `同时运行的会话已达上限（${MAX_CONCURRENT_RUNS} 个），请先等某个会话完成` }
    }
    if (sessionStore) sessionStore.touch(sessionId)
    return agent.sendUserMessage(text)
  })
  // ===== 定时任务（v2.4.97）：30s 扫描一次到点任务 + 启动 60s 后补跑今天已到时未跑的 =====
  setInterval(() => { try { runSchedules(false) } catch {} }, 30000)
  setTimeout(() => { try { runSchedules(true) } catch {} }, 60000)
  // ===== 应用更新检查（v2.4.97）+ 应用内下载/安装（v2.5.0）——状态机与工具函数在模块顶层（before-quit 也要读）=====
  ipcMain.handle('app:check-update', async () => {
    if (!/^[^\s/]+\/[^\s/]+$/.test(updateRepoOf())) {
      return { error: 'NO_REPO', message: '更新源无效——填 GitHub 仓库（如 yourname/MSMate）' }
    }
    try {
      return await fetchLatestRelease()
    } catch (err) {
      return { error: 'NET', message: `检查失败：${err.message}（GitHub 直连不稳属预期，可开代理后重试）` }
    }
  })
  ipcMain.handle('update:get-state', async () => {
    if (updateState.status === 'idle') scanReadyUpdate()
    return { status: updateState.status, percent: updateState.percent, version: updateState.version }
  })
  ipcMain.handle('update:download', async () => {
    if (updateState.status === 'downloading') return { ok: true, already: true, status: 'downloading', percent: updateState.percent }
    if (updateState.status === 'readyToInstall') return { ok: true, status: 'readyToInstall', version: updateState.version }
    try {
      const rel = await fetchLatestRelease()
      if (rel.error) return { ok: false, error: rel.message }
      if (!rel.hasUpdate) return { ok: true, status: 'uptodate', latest: rel.latest, current: rel.current }
      const directUrl = String(rel.url || '')
      if (!/\/releases\/download\//i.test(directUrl)) return { ok: false, error: 'Release 里没有 exe 附件' }
      const finalPath = path.join(updateDir(), `MSMate.Setup.${rel.latest}.exe`)
      if (fs.existsSync(finalPath) && rel.assetSize && fs.statSync(finalPath).size === rel.assetSize) { // 之前已下完
        updateState.status = 'readyToInstall'; updateState.percent = 100; updateState.version = rel.latest; updateState.file = finalPath
        saveUpdateNotes(rel) // v2.5.4：装完首次启动弹"更新了什么"
        return { ok: true, status: 'readyToInstall', version: rel.latest }
      }
      const partPath = finalPath + '.part'
      updateState.status = 'downloading'; updateState.percent = 0; updateState.receivedMB = 0
      updateState.totalMB = rel.assetSize ? Math.round(rel.assetSize / 1048576) : 0
      updateState.version = rel.latest; updateState.file = finalPath
      await httpDownload(directUrl, partPath, Math.max(rel.assetSize * 1.15 || 0, 300 * 1024 * 1024), 0, {}, {
        onProgress: (received, total) => {
          updateState.percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0
          updateState.receivedMB = Math.round(received / 1048576 * 10) / 10
          if (!updateState.totalMB && total) updateState.totalMB = Math.round(total / 1048576)
          updateProgressPush(false)
        }
      })
      // v2.5.2：大小校验（防 GitHub 偶发截断装入半包）——不符就删掉重来，绝不让坏包进 readyToInstall
      if (rel.assetSize) {
        const gotSize = fs.statSync(partPath).size
        if (gotSize !== rel.assetSize) {
          try { fs.unlinkSync(partPath) } catch (e) {}
          updateState.status = 'idle'
          return { ok: false, error: `下载不完整（${Math.round(gotSize / 1048576)}/${Math.round(rel.assetSize / 1048576)}MB），请重试` }
        }
      }
      fs.renameSync(partPath, finalPath) // .part → 完整包（崩溃中断的 .part 下次自动重来）
      updateState.status = 'readyToInstall'; updateState.percent = 100
      saveUpdateNotes(rel) // v2.5.4：装完首次启动弹"更新了什么"
      updateProgressPush(true)
      return { ok: true, status: 'readyToInstall', version: rel.latest }
    } catch (err) {
      updateState.status = 'idle'
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:dl-progress', { status: 'error', error: String(err.message || err) }) } catch (e) {}
      return { ok: false, error: String(err.message || err) }
    }
  })
  ipcMain.handle('update:install', async () => {
    if (!updateState.file || !fs.existsSync(updateState.file)) return { ok: false, error: '更新包未就绪，先下载' }
    if (updateState.installing) return { ok: true }
    // v2.5.2：只置标记，真正启动安装器挪到 will-quit（主进程退干净才轮到安装器写文件，防文件锁竞争）
    updateState.installOnQuit = true
    setTimeout(() => { try { app.quit() } catch (e) {} }, 300)
    return { ok: true }
  })
  // ===== 语音合成试听（v2.4.97）：CosyVoice2（硅基流动 /v1/audio/speech），返回 mp3 base64 前端播放 =====
  ipcMain.handle('ai:tts', async (event, { text, voice, model } = {}) => {
    const input = String(text || '').trim()
    if (!input) return { error: '文本为空' }
    if (input.length > 1000) return { error: '试听文本过长（≤1000 字）' }
    const pv = resolveModelProvider(getSetting, 'tts')
    const apiKey = (pv && pv.apiKey) || getSetting('aiApiKey')
    if (!apiKey) return { error: 'API Key 未配置（设置 → AI 设置）' }
    const baseUrl = ((pv && pv.baseUrl) || getSetting('aiBaseUrl') || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
    const body = JSON.stringify({
      model: String(model || getSetting('aiTtsModel') || 'FunAudioLLM/CosyVoice2-0.5B'),
      input,
      voice: String(voice || 'FunAudioLLM/CosyVoice2-0.5B:alex'),
      response_format: 'mp3'
    })
    try {
      const audioBuf = await new Promise((resolve, reject) => {
        const u = new URL(baseUrl + '/audio/speech')
        const mod = u.protocol === 'http:' ? require('http') : require('https')
        const req = mod.request(u, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 60000
        }, (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              const msg = Buffer.concat(chunks).toString('utf8').slice(0, 300)
              return reject(new Error(`HTTP ${res.statusCode}：${msg}`))
            }
            resolve(Buffer.concat(chunks))
          })
        })
        req.on('timeout', () => { try { req.destroy(new Error('请求超时')) } catch {} })
        req.on('error', reject)
        req.write(body)
        req.end()
      })
      if (!audioBuf.length) return { error: '返回音频为空' }
      return { ok: true, audioBase64: audioBuf.toString('base64'), bytes: audioBuf.length }
    } catch (err) {
      return { error: `语音合成失败：${err.message}` }
    }
  })
  // ===== 网页版模型（[网页]DeepSeek）：渲染层网页引擎把自动对话结果回传主进程 =====
  ipcMain.handle('ai:webchat-chunk', (event, { sessionId, delta }) => {
    const agent = workAgents.get(sessionId)
    if (agent && agent.running) agent.onWebChatChunk(String(delta || ''))
  })
  // 网页对话 URL 回传（渲染层引擎检测到 /a/chat/s/<uuid> 变化）：存 agent 内存并随 saveHistory 落盘，
  // 重启后恢复原对话、多本地会话切换时联动切到各自网页对话
  ipcMain.handle('ai:webchat-conv', (event, { sessionId, url }) => {
    const agent = workAgents.get(sessionId)
    if (agent) agent.onWebChatConv(String(url || ''))
  })
  ipcMain.handle('ai:webchat-done', (event, { sessionId, text }) => {
    const agent = getWorkAgent(sessionId)
    if (agent && agent.running) agent.onWebChatDone(typeof text === 'string' ? text : null)
    return true
  })
  ipcMain.handle('ai:webchat-error', (event, { sessionId, error }) => {
    const agent = getWorkAgent(sessionId)
    if (agent && agent.running) agent.onWebChatError(String(error || '网页对话失败'))
    return true
  })
  // 网页对话等待心跳（渲染层引擎 9s 无进展 / 钩子自愈期间上报）：转发前端展示"已等待 N 秒"转圈，
  // v2.4.82 真机实锤：慢启动/钩子自愈期间 UI 零反馈 = 体感"卡死"
  ipcMain.handle('ai:webchat-wait', (event, { sessionId, seconds }) => {
    const agent = workAgents.get(sessionId)
    if (agent && agent.running) agent.onWebChatWait(parseInt(seconds) || 0)
    return true
  })
  // ===== 生成模式直连（聊天输入区"生图/生视频"上滑菜单）：不走工具循环，直接生成 =====
  ipcMain.handle('ai:generate-image', (event, { sessionId, prompt, size, images, batch, polish, steps }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return { success: false, error: 'AI 功能未加载' }
    // v2.4.84：images=参考图路径数组（1-3张，图片生成模式下聊天框图片胶囊自动作为参考图）
    // v2.4.85：batch=一次生成张数（1-4）；polish=提示词润色开关（false=关，其余=开）
    // v2.4.89：steps=质量档位推理步数（低30/中50/高100，默认30）
    return agent.generateMedia('image', String(prompt || ''), size, Array.isArray(images) ? images : [], batch, polish, steps)
  })
  ipcMain.handle('ai:generate-video', (event, { sessionId, prompt }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return { success: false, error: 'AI 功能未加载' }
    return agent.generateMedia('video', String(prompt || ''))
  })
  ipcMain.handle('ai:abort', async (event, { sessionId }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return { success: false }
    return agent.abort()
  })
  // 用户从下载进度条取消下载
  ipcMain.handle('ai:download-cancel', async (event, id) => {
    if (!aiTools || !id) return { ok: false, message: '下载模块未就绪' }
    try { return aiTools.cancelDownload(id) } catch (err) { return { ok: false, message: err.message } }
  })
  ipcMain.handle('ai:approve', async (event, { approvalId, ok, sessionId }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return false
    return agent.approve(approvalId, ok)
  })
  // 用户回答 AI 的中途提问（ask_user 卡片）
  ipcMain.handle('ai:ask-answer', async (event, { askId, payload, sessionId }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return false
    return agent.resolveAsk(askId, payload)
  })
  ipcMain.handle('ai:clear-chat', async (event, { sessionId }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return false
    return agent.clearChat()
  })
  ipcMain.handle('ai:get-config', async () => {
    const agent = workAgent || getWorkAgent()
    if (!agent) return { approvalMode: 'manual', model: '', apiKey: '' }
    return agent.getConfig()
  })
  ipcMain.handle('ai:set-config', async (event, cfg) => {
    const agent = workAgent || getWorkAgent()
    if (!agent) return false
    return agent.setConfig(cfg)
  })
  // 内置模型清单（设置面板渲染"MSMate 内置"卡片，含积分单价）
  ipcMain.handle('ai:builtin-models', async () => {
    try {
      const r = await authRequest('/v1/ai/models', {})
      if (r.status === 200 && r.data && r.data.ok) return { ok: true, data: r.data }
      return { ok: false, error: (r.data && r.data.error) || `HTTP ${r.status}` }
    } catch (err) {
      return { ok: false, error: `网络错误：${err.message}` }
    }
  })
  // ===== 云同步状态/手动触发（设置 → 数据同步 面板显示） =====
  ipcMain.handle('cloudsync:status', () => {
    const st = getSetting('syncState') || {}
    const a = authGetSaved()
    return { loggedIn: !!(a && a.token), lastSyncAt: st.lastSyncAt || '', running: syncRunning }
  })
  ipcMain.handle('cloudsync:now', async () => {
    const a = authGetSaved()
    if (!a || !a.token) return { ok: false, error: '请先登录 MSMate 账号' }
    await syncAutoRun('manual')
    const st = getSetting('syncState') || {}
    return { ok: true, lastSyncAt: st.lastSyncAt || '' }
  })
  // ===== 互联网在线设备列表（presence，P2P 直连用） =====
  ipcMain.handle('presence:list', async () => {
    const selfId = tcpAgent ? tcpAgent.deviceId : ''
    const a = authGetSaved()
    if (!a || !a.token) return { ok: false, selfId, devices: [], error: '请先登录 MSMate 账号' }
    try {
      const r = await authRequest('/v1/presence', { token: a.token, timeoutMs: 10000 })
      if (r.status === 200 && r.data && r.data.ok) return { ok: true, selfId, devices: r.data.devices || [] }
      return { ok: false, selfId, devices: [], error: (r.data && r.data.error) || `HTTP ${r.status}` }
    } catch (err) {
      return { ok: false, selfId, devices: [], error: `网络错误：${err.message}` }
    }
  })
  // ===== 语音输入：录音数据 → 硅基流动 ASR（SenseVoiceSmall，OpenAI 兼容 /audio/transcriptions） =====
  ipcMain.handle('ai:voice-transcribe', async (event, { data, mime }) => {
    try {
      const pvVoice = resolveModelProvider(getSetting, 'voice') // 多运营商：语音槽位独立选服务商（v2.4.61）
      const apiKey = (pvVoice && pvVoice.apiKey) || getSetting('aiApiKey')
      if (!apiKey) return { ok: false, message: '未配置 API Key，语音输入不可用' }
      const base = String((pvVoice && pvVoice.baseUrl) || getSetting('aiBaseUrl') || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
      // 语音模型可配置，默认 FunAudioLLM/SenseVoiceSmall
      const voiceModel = String(getSetting('aiVoiceModel') || '').trim() || 'FunAudioLLM/SenseVoiceSmall'
      const u = new URL(base + '/audio/transcriptions')
      const boundary = '----MSVoice' + Date.now()
      const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${voiceModel}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.webm"\r\nContent-Type: ${mime || 'audio/webm'}\r\n\r\n`, 'utf8')
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      const body = Buffer.concat([head, Buffer.from(data), tail])
      const httpMod = u.protocol === 'http:' ? require('http') : require('https')
      const res = await new Promise((resolve, reject) => {
        const req = httpMod.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'POST',
          timeout: 30000,
          headers: {
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': body.length,
            Authorization: 'Bearer ' + apiKey
          }
        }, (r) => {
          const chunks = []
          r.on('data', (c) => chunks.push(c))
          r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
        })
        req.on('timeout', () => req.destroy(new Error('识别请求超时')))
        req.on('error', reject)
        req.write(body)
        req.end()
      })
      if (res.status !== 200) return { ok: false, message: `语音识别失败(HTTP ${res.status}): ${res.text.slice(0, 160)}` }
      let text = ''
      try { text = String(JSON.parse(res.text).text || '').trim() } catch {}
      if (!text) return { ok: false, message: '没听清内容，请靠近麦克风再试一次' }
      return { ok: true, text }
    } catch (err) {
      return { ok: false, message: `语音识别失败: ${err.message}` }
    }
  })
  ipcMain.handle('ai:get-history', async (event, { sessionId } = {}) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return []
    return agent.getHistory()
  })
  // ===== 会话管理 =====
  ipcMain.handle('ai:sessions', async () => {
    if (!sessionStore) return []
    return sessionStore.list()
  })
  ipcMain.handle('ai:session-create', async (event, { title } = {}) => {
    if (!sessionStore) return null
    return sessionStore.create(title)
  })
  ipcMain.handle('ai:session-rename', async (event, { id, title }) => {
    if (!sessionStore) return null
    return sessionStore.rename(id, title)
  })
  ipcMain.handle('ai:session-pin', async (event, { id, pinned }) => {
    if (!sessionStore) return null
    return sessionStore.setPinned(id, pinned)
  })
  ipcMain.handle('ai:session-delete', async (event, { id }) => {
    if (!sessionStore) return { success: false }
    const ok = sessionStore.remove(id)
    workAgents.delete(id) // 释放该会话的 Agent 实例
    sessionStore.ensureDefault()
    return { success: ok }
  })
  ipcMain.handle('ai:snapshots', async () => {
    const agent = workAgent || getWorkAgent()
    if (!agent) return []
    return agent.listSnapshots()
  })
  ipcMain.handle('ai:restore-snapshot', async (event, { id }) => {
    const agent = workAgent || getWorkAgent()
    if (!agent) return { success: false, error: 'AI 功能未加载' }
    return agent.restoreSnapshot(id)
  })
  ipcMain.handle('ai:delete-snapshot', async (event, { id }) => {
    const agent = workAgent || getWorkAgent()
    if (!agent) return false
    return agent.deleteSnapshot(id)
  })
  ipcMain.handle('ai:rollback', async (event, { msgIndex, sessionId }) => {
    const agent = getWorkAgent(sessionId)
    if (!agent) return { success: false, error: 'AI 功能未加载' }
    return agent.rollbackTo(msgIndex)
  })
}

function listLocalDirectory(targetPath) {
  if (!targetPath || targetPath === 'root' || targetPath === 'This PC') {
    return listDrives()
  }
  try {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true })
    const result = entries.map(entry => {
      const fullPath = path.join(targetPath, entry.name)
      const isFile = entry.isFile()
      let size = 0
      let modifiedTime = 0
      
      try {
        if (isFile) {
          const stat = fs.statSync(fullPath)
          size = stat.size
          modifiedTime = stat.mtimeMs
        }
      } catch (e) {
        // 忽略无法访问的文件
      }
      
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        size,
        modifiedTime
      }
    })
    return { success: true, path: targetPath, entries: result }
  } catch (err) {
    let errorMsg = err.message
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      errorMsg = `权限不足，无法访问 ${targetPath}。请以管理员身份运行，或选择其他目录。`
    } else if (err.code === 'ENOENT') {
      errorMsg = `路径不存在: ${targetPath}`
    } else if (err.code === 'ENOTDIR') {
      errorMsg = `${targetPath} 不是一个目录`
    }
    return { success: false, error: errorMsg, path: targetPath, entries: [] }
  }
}

function listDrives() {
  if (os.platform() !== 'win32') {
    return listLocalDirectory('/')
  }
  const entries = []
  // 桌面快捷入口（盘符同级）
  try {
    const desktopPath = app.getPath('desktop')
    if (desktopPath && fs.existsSync(desktopPath)) {
      entries.push({ name: '桌面', path: desktopPath, isDirectory: true, isDesktop: true, size: 0, modifiedTime: 0 })
    }
  } catch {}
  const driveLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (let i = 0; i < driveLetters.length; i++) {
    const letter = driveLetters[i] + ':\\'
    try {
      fs.accessSync(letter)
      entries.push({
        name: `${driveLetters[i]}:\\`,
        path: letter,
        isDirectory: true,
        isDrive: true,
        size: 0,
        modifiedTime: 0
      })
    } catch {}
  }
  return { success: true, path: 'root', entries }
}

// === App Lifecycle ===

// webview 弹窗拦截：工作台内嵌网页（DeepSeek 页签/通用网页页签）里点击链接转跳（target=_blank /
// window.open）不再弹系统新窗口，转成工作台网页页签（复用 open_url 的 ai:workbench-open 通道，
// Work 模式开页签、互联模式回退系统打开）；渲染层必须挂 allowpopups 属性（布尔属性，存在即生效）
// 弹窗才会走本拦截，放行与否由这里统一裁决
app.on('web-contents-created', (e, wc) => {
  try {
    if (wc.getType() !== 'webview') return
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(String(url || '')) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai:workbench-open', { kind: 'url', url: String(url) })
      }
      return { action: 'deny' } // 一律不开真窗口：进页签或丢弃
    })
  } catch {}
})

app.whenReady().then(() => {
  // v2.5.6：更新临时目录清理（升级安装时 TEMP 注入用的 msmate-update-temp，装完残留清理）
  try {
    if (app.isPackaged) {
      const legacyTmp = path.join(path.dirname(process.execPath), '..', 'msmate-update-temp')
      if (fs.existsSync(legacyTmp)) fs.rmSync(legacyTmp, { recursive: true, force: true, maxRetries: 2 })
    }
  } catch (e) {}
  logFile = path.join(app.getPath('userData'), 'app.log')
  log(`应用启动, 版本: ${app.getVersion()}, 平台: ${os.platform()}, 打包: ${!app.isPackaged}`)
  log(`appPath: ${app.getAppPath()}`)
  log(`resourcesPath: ${process.resourcesPath}`)

  try {
    initServices()
    log('服务初始化完成')
  } catch (err) {
    log(`服务初始化失败: ${err.message}\n${err.stack}`)
    dialog.showErrorBox('启动错误', `服务初始化失败:\n${err.message}`)
  }

  try {
    createWindow()
    createTray()
    log('窗口和托盘创建完成')
  } catch (err) {
    log(`窗口创建失败: ${err.message}\n${err.stack}`)
    dialog.showErrorBox('启动错误', `窗口创建失败:\n${err.message}`)
  }

  // 启动对讲机全局热键
  try { startPTTHotkey() } catch (err) { log(`PTT 热键启动失败: ${err.message}`) }

  // v2.5.1：开机自启——设置里开着但注册表被清（安全软件/手动禁用）→ 启动时补回
  // v2.5.4：默认开机自启（老大拍板）——从未设置过的用户默认开启；显式关过的不打扰
  try {
    const as = getSetting('autoStart')
    if (as == null) { applyAutoStart(true); setSetting('autoStart', true) }
    else if (as === true) applyAutoStart(true)
  } catch (err) { log(`开机自启同步失败: ${err.message}`) }

  // v2.7.16：内置浏览器/网页页签下载进度——接管 will-download，进度实时推渲染层浮条
  try { setupWebDownload() } catch (err) { log(`网页下载接管失败: ${err.message}`) }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 不直接退出，由托盘管理
    // app.quit()
  }
})

app.on('before-quit', () => {
  app.isQuitting = true
  stopPTTHotkey()
  embedManager.quit() // 内嵌文档窗口帮手：退出前把窗口还回桌面，文档不丢
  if (netRelay) { try { netRelay.stop() } catch { } }
  if (tcpAgent) tcpAgent.stop()
  if (udpDiscovery) udpDiscovery.stop()
  // v2.5.2：下载完的新版没装（用户没点"立即重启"）→ 退出时静默自动安装（置标记，will-quit 统一启动）
  try {
    if (typeof updateState !== 'undefined' && updateState.status === 'readyToInstall' && updateState.file && fs.existsSync(updateState.file) && !updateState.installing) {
      updateState.installOnQuit = true
    }
  } catch (e) {}
})

// v2.5.2：主进程完全退出前最后一口气才启动安装器——此刻窗口已关、服务已停，
// 安装器加载自身的 1-3 秒后文件锁必然释放；NSIS 静默装完不自动开应用（老大拍板：装完让用户自己打开）
app.on('will-quit', () => {
  try {
    if (typeof updateState !== 'undefined' && updateState.installOnQuit && updateState.file && fs.existsSync(updateState.file)) {
      spawnInstaller()
    }
  } catch (e) {}
})
