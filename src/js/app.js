// ============================================
// LAN 互传 - 前端应用逻辑 v2
// 支持文件夹递归传输、多选、搜索、排序、历史
// ============================================

let _api = null
let apiAvailable = false

function initAPI() {
  _api = window.api
  if (_api && _api._fallback) {
    apiAvailable = false
    return false
  }
  apiAvailable = !!_api
  return apiAvailable
}

// === State ===
const state = {
  localPath: 'root',
  localEntries: [],
  remotePath: 'root',
  remoteEntries: [],
  connectedDeviceId: null,
  connectedDeviceInfo: null,
  devices: new Map(),
  // 多设备：所有已连接的设备 { deviceId: deviceInfo }
  connectedDevices: new Map(),
  // 多选
  localSelected: new Set(),
  remoteSelected: new Set(),
  lastLocalClick: null,
  lastRemoteClick: null,
  // Work 工作台（汇集的文件项，按会话持久化）
  wbItems: [],
  // 传输
  transfers: new Map(),
  transferHistory: [],
  activeTab: 'active',
  // 设置
  defaultDownloadDir: '',
  pairCode: null,
  // 重命名
  renameTarget: null,
  // 设备备注 { deviceId: remark }
  deviceRemarks: {},
  // 远程文件拖出到窗口外（桌面/资源管理器）的追踪
  remoteDragOutItems: null,
  remoteDragConsumed: false,
  // 复制/剪切粘贴板
  clipboard: { source: null, items: [], cut: false },
  // 自动重连
  lastConnectedIP: null,
  manualDisconnect: false,
  reconnectAttempts: 0,
  reconnecting: false,
  // 互联网模式（中转服务器在线设备 { deviceId: { deviceId, name } }）
  relayDevices: new Map(),
  // IPv6 直连历史设备 { deviceId: { name, addrs: [] } }
  ipv6Peers: new Map(),
  // 互联网在线设备（msmate-api presence 登记的设备，P2P 直连公网 IP）
  netDevices: new Map(),
}

// === DOM ===
const $ = (id) => document.getElementById(id)
let localNameEl, localIPEl, localPathEl, remotePathEl
let localFileList, remoteFileList, deviceItems, transferList, transferHistoryList
let deviceCount, remoteFileView, deviceListEl
let statusDot, statusText, toast
let pairCodeDisplay, pairCodeEl, pairRequestModal
let pairCodeInput, contextMenu
let renameModal, renameInput

function initDOM() {
  localNameEl = $('localName'); localIPEl = $('localIP')
  localPathEl = $('localPath'); remotePathEl = $('remotePath')
  localFileList = $('localFileList'); remoteFileList = $('remoteFileList')
  deviceItems = $('deviceItems'); transferList = $('transferList')
  transferHistoryList = $('transferHistoryList')
  deviceCount = $('deviceCount'); remoteFileView = $('remoteFileView')
  deviceListEl = $('deviceList')
  statusDot = $('statusDot'); statusText = $('statusText'); toast = $('toast')
  pairCodeDisplay = $('pairCodeDisplay'); pairCodeEl = $('pairCode')
  pairRequestModal = $('pairRequestModal')
  pairCodeInput = $('pairCodeInput')
  contextMenu = $('context-menu')
  renameModal = $('renameModal'); renameInput = $('renameInput')
}

// === Init ===
async function init() {
  initDOM()

  if (!initAPI()) {
    showErrorScreen()
    return
  }

  // 绑定所有事件监听器（优先绑定，确保可交互）
  bindEvents()
  setupIPCLListeners()

  // 异步初始化
  try {
    const info = await _api.getInfo()
    if (localNameEl) localNameEl.textContent = info.localName || info.computerName
    if (localIPEl) localIPEl.textContent = info.localIP
    const versionEl = $('appVersion')
    if (versionEl && info.version) versionEl.textContent = `v${info.version}`
  } catch { }

  // 加载设备备注
  try {
    state.deviceRemarks = await _api.getDeviceRemarks() || {}
  } catch { }

  try {
    await loadLocalDirectory(state.localPath)
  } catch { }

  try {
    await refreshDevices()
  } catch { }

  // 恢复主进程层面已存在的连接（如窗口重开/热重载场景）
  try {
    const res = await _api.getConnectedDevices()
    if (res && res.success && Array.isArray(res.devices)) {
      for (const dev of res.devices) {
        state.connectedDevices.set(dev.deviceId, dev)
        if (!state.devices.has(dev.deviceId)) {
          state.devices.set(dev.deviceId, { ...dev, discovered: true })
        }
      }
      if (!state.connectedDeviceId && state.connectedDevices.size > 0) {
        const first = state.connectedDevices.entries().next().value
        state.connectedDeviceId = first[0]
        state.connectedDeviceInfo = first[1]
        if (remoteFileView) remoteFileView.classList.remove('hidden')
        const hint = $('notConnectedHint')
        if (hint) hint.classList.add('hidden')
        refreshRemoteDirectory('root')
      }
      renderDeviceList()
    }
  } catch { }

  // 加载设置：默认下载目录
  try {
    const dir = await _api.getSetting('defaultDownloadDir')
    if (dir) {
      state.defaultDownloadDir = dir
    } else {
      // 首次使用默认系统下载目录
      state.defaultDownloadDir = await _api.getDownloadsDir()
    }
    updateDownloadDirDisplay()
  } catch { }

  // 加载传输历史
  try {
    state.transferHistory = await _api.getTransferHistory() || []
  } catch { }

  // 初始化对讲机（PTT）
  try { await initPTT() } catch { }

  // 互联网模式（中转服务器）
  try { initRelayUI() } catch { }

  // IPv6 直连
  try { initIpv6UI() } catch { }

  // MSWork AI 助手
  try { initWorkMode() } catch (e) { console.error('[MSWork] init failed:', e) }

  // 全局外观（自定义背景 + 启动页面，依赖 initWorkMode 的模式滑块已绑定）
  try { await initAppearance() } catch { }

  updateStatus('就绪', 'ready')
  showToast('局域网互传已启动', 'success')

  // v2.4.98：启动 10 秒后静默检查更新（不拖慢启动，仅在发现新版本时冒提示条）
  setTimeout(() => { try { startupUpdateCheck() } catch { } }, 10000)
  // v2.5.4：启动 4 秒后检查"更新了什么"——装完新版首次启动弹更新说明（只弹一次）
  setTimeout(() => { try { showUpdateWelcome() } catch { } }, 4000)
}

function showErrorScreen() {
  const app = $('app')
  if (app) {
    app.innerHTML = `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;color:#fff;background:#1a1a2e;">
      <div style="font-size:48px;margin-bottom:20px;">${iconSvg('triangle-alert')}</div>
      <h2 style="color:#ff6b6b;">应用加载失败</h2>
      <p style="color:#aaa;">无法与主进程通信，请重新启动应用</p></div>`
  }
}

function bindEvents() {
  const bind = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn) }
  
  bind('refreshBtn', 'click', refreshDevices)
  bind('manualConnectBtn', 'click', manualConnect)
  const manualIPInput = $('manualIPInput')
  if (manualIPInput) {
    manualIPInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') manualConnect()
    })
  }
  bind('selectLocalFolder', 'click', selectLocalFolder)
  bind('selectFiles', 'click', selectFiles)
  bind('localUp', 'click', () => navigateUp('local'))
  bind('remoteUp', 'click', () => navigateUp('remote'))
  bind('remotePath', 'click', () => { if (state.connectedDeviceId) refreshRemoteDirectory() })
  bind('showPairCode', 'click', showPairCode)
  bind('clearTransfers', 'click', clearCompletedTransfers)
  bind('pairReject', 'click', handlePairReject)
  bind('pairSubmitCode', 'click', handlePairSubmitCode)
  // 配对码输入框：回车直接提交
  if (pairCodeInput) {
    pairCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePairSubmitCode()
    })
  }
  bind('localPath', 'click', selectLocalFolder)

  // 互联网模式（v0.5：官方服务自动连接，无自定义配置项）
  bind('relaySettingsBtn', 'click', openRelayModal)
  bind('relayCancel', 'click', () => { const m = $('relayModal'); if (m) m.classList.add('hidden') })

  // IPv6 直连
  bind('ipv6OpenBtn', 'click', openIpv6Modal)
  bind('ipv6Close', 'click', () => { const m = $('ipv6Modal'); if (m) m.classList.add('hidden') })
  bind('ipv6CopyInvite', 'click', handleIpv6CopyInvite)
  bind('ipv6ConnectBtn', 'click', handleIpv6Connect)

  // 搜索和排序
  bind('localSearch', 'input', () => renderLocalFileList(state.localEntries))
  bind('localSort', 'change', () => renderLocalFileList(state.localEntries))
  bind('remoteSearch', 'input', () => renderRemoteFileList(state.remoteEntries))
  bind('remoteSort', 'change', () => renderRemoteFileList(state.remoteEntries))

  // 批量操作
  bind('localBatchUpload', 'click', batchUploadSelected)
  bind('remoteBatchDownload', 'click', batchDownloadSelected)

  // 标签页切换
  bind('tabActive', 'click', () => switchTab('active'))
  bind('tabHistory', 'click', () => switchTab('history'))

  // 重命名模态框
  bind('renameCancel', 'click', () => { if (renameModal) renameModal.classList.add('hidden') })
  bind('renameConfirm', 'click', confirmRename)
  // Enter 确认 / Esc 取消（输入法组合中不触发）
  if (renameInput) {
    renameInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') {
        e.preventDefault()
        confirmRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (renameModal) renameModal.classList.add('hidden')
      }
    })
  }

  // 右键菜单
  document.addEventListener('contextmenu', handleContextMenu)
  document.addEventListener('click', hideContextMenu)
  document.addEventListener('click', hideWbFsMenu)
  initContextMenu()

  // 拖拽到远程面板
  setupDragDrop()

  // 快捷键
  document.addEventListener('keydown', handleKeyDown)

  // 下载目录更改
  bind('changeDownloadDir', 'click', changeDownloadDir)
  bind('openDownloadDir', 'click', openDownloadFolder)

  // 操作手册
  bind('helpBtn', 'click', showHelpModal)
  bind('helpClose', 'click', () => { const m = $('helpModal'); if (m) m.classList.add('hidden') })
  const helpOverlay = $('helpModal')
  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) helpOverlay.classList.add('hidden') })
  }

  // 全局设置（外观 / 互联与传输 / 设备 / 关于）
  bind('globalSettingsBtn', 'click', openGlobalSettings)

  // 对讲机（PTT）
  const pttBtn = $('pttBtn')
  if (pttBtn) {
    pttBtn.addEventListener('mousedown', (e) => { e.preventDefault(); if (e.button === 0) startTalking() }) // 仅左键喊话，右键留给设置
    pttBtn.addEventListener('mouseup', () => stopTalking())
    pttBtn.addEventListener('mouseleave', () => { if (ptt.talking) stopTalking() })
    pttBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); openPttModal() })
  }
  // 鼠标在按钮外松开也要停止喊话
  document.addEventListener('mouseup', () => { if (ptt.talking && !ptt.hotkeyTalking) stopTalking() })
  bind('pttCancel', 'click', () => { const m = $('pttModal'); if (m) m.classList.add('hidden') })
  bind('pttSave', 'click', savePttHotkey)
  bind('pttClearHotkey', 'click', () => {
    ptt.pendingHotkey = ''
    const inp = $('pttHotkeyInput')
    if (inp) inp.value = '（未设置，仅用按钮对讲）'
  })
  const pttHotkeyInput = $('pttHotkeyInput')
  if (pttHotkeyInput) {
    pttHotkeyInput.addEventListener('keydown', recordHotkeyInput)
    pttHotkeyInput.addEventListener('keyup', recordHotkeyInput)
    // 鼠标侧键（XBUTTON1/2 = Mouse4/Mouse5）也可设为对讲热键
    pttHotkeyInput.addEventListener('mousedown', recordHotkeyMouse)
    pttHotkeyInput.addEventListener('blur', resetHotkeyRecorder)
  }
  // 对讲音量滑块：拖动实时生效
  const pttVolumeSlider = $('pttVolumeSlider')
  if (pttVolumeSlider) {
    pttVolumeSlider.addEventListener('input', () => {
      const v = Math.max(0, Math.min(200, parseInt(pttVolumeSlider.value, 10) || 100))
      ptt.volume = v
      const label = $('pttVolumeLabel')
      if (label) label.textContent = `${v}%`
      applyPTTVolume()
    })
  }
  const pttModalOverlay = $('pttModal')
  if (pttModalOverlay) {
    pttModalOverlay.addEventListener('click', (e) => { if (e.target === pttModalOverlay) pttModalOverlay.classList.add('hidden') })
  }

  // 设备右键菜单
  initDeviceContextMenu()
}

function setupIPCLListeners() {
  _api.onDeviceFound((device) => {
    state.devices.set(device.deviceId, { ...device, discovered: true })
    renderDeviceList()
  })
  // 2.0：配对流程（被连方弹码 / 发起方输码 / 自动接受）
  _api.onIncomingPairRequest(handlePairRequest)
  _api.onPairRequired(handlePairRequired)
  _api.onPairAutoAccepted(handlePairAutoAccepted)
  _api.onDeviceLost((deviceId) => {
    state.devices.delete(deviceId)
    // 设备从局域网消失 → 断开与它的连接（如有）
    if (state.connectedDevices.has(deviceId)) {
      disconnectDevice(deviceId)
      return
    }
    renderDeviceList()
  })
  _api.onConnectionStatus((data) => {
    if (data.status === 'connected') {
      const wasActive = state.connectedDeviceId === data.deviceId
      state.reconnecting = false
      state.reconnectAttempts = 0
      // 把设备加入设备列表（被连接方也能在列表中看到对方）
      if (data.deviceInfo) {
        state.devices.set(data.deviceId, {
          deviceId: data.deviceInfo.deviceId || data.deviceId,
          hostname: data.deviceInfo.hostname,
          name: data.deviceInfo.name || data.deviceInfo.hostname,
          ip: data.deviceInfo.ip,
          platform: data.deviceInfo.platform
        })
      }
      const host = data.deviceInfo ? (data.deviceInfo.name || data.deviceInfo.hostname) : '设备'
      state.connectedDevices.set(data.deviceId, data.deviceInfo || { deviceId: data.deviceId, name: host, hostname: host })

      if (!state.connectedDeviceId || wasActive) {
        // 无活动设备（首次）或重连回当前活动设备 → 设为活动，保持/加载目录
        state.connectedDeviceId = data.deviceId
        state.connectedDeviceInfo = data.deviceInfo
        updateStatus(`已连接: ${host}`, 'connected')
        if (remoteFileView) remoteFileView.classList.remove('hidden')
        const hint = $('notConnectedHint')
        if (hint) hint.classList.add('hidden')
        if (!wasActive) {
          showToast(`已连接到 ${host}`, 'success')
          refreshRemoteDirectory('root')
        } else {
          // 重连回同一设备，保持当前目录
          refreshRemoteDirectory()
        }
      } else {
        // 已有活动设备，新设备连入 → 不抢占当前浏览，仅提示可切换
        const activeHost = state.connectedDeviceInfo ? (state.connectedDeviceInfo.name || state.connectedDeviceInfo.hostname) : ''
        updateStatus(`已连接: ${activeHost} (+${state.connectedDevices.size - 1})`, 'connected')
        showToast(`已连接到 ${host}，点击设备列表切换`, 'info')
      }
      renderDeviceList()
      updatePTTButton()
    } else {
      // 断开：从多设备 Map 移除
      const info = state.connectedDevices.get(data.deviceId)
      state.connectedDevices.delete(data.deviceId)
      const host = info ? (info.name || info.hostname) : (data.deviceInfo ? (data.deviceInfo.name || data.deviceInfo.hostname) : '设备')

      if (data.deviceId === state.connectedDeviceId) {
        // 活动设备断开：切换到其他已连接设备，或清空远程面板
        state.connectedDeviceId = null
        state.connectedDeviceInfo = null
        state.remotePath = 'root'
        state.remoteEntries = []
        state.remoteSelected.clear()
        if (remotePathEl) remotePathEl.value = ''
        const remoteUpBtn = $('remoteUp')
        if (remoteUpBtn) remoteUpBtn.disabled = true

        if (state.connectedDevices.size > 0) {
          // 还有其他连接 → 自动切换
          const next = state.connectedDevices.entries().next().value
          state.connectedDeviceId = next[0]
          state.connectedDeviceInfo = next[1]
          const nextHost = next[1].name || next[1].hostname
          updateStatus(`已连接: ${nextHost}`, 'connected')
          showToast(`${host} 已断开，已切换到 ${nextHost}`, 'info')
          refreshRemoteDirectory('root')
        } else {
          if (remoteFileView) remoteFileView.classList.add('hidden')
          const hint = $('notConnectedHint')
          if (hint) hint.classList.remove('hidden')
          updateStatus('连接已断开', 'disconnected')
          showToast(`${host} 已断开`, 'info')
          // 全部断开且非手动断开时自动重连
          if (!state.manualDisconnect && state.lastConnectedIP) {
            autoReconnect()
          }
        }
      } else {
        // 非活动设备断开，仅提示
        showToast(`${host} 已断开`, 'info')
        const activeHost = state.connectedDeviceInfo ? (state.connectedDeviceInfo.name || state.connectedDeviceInfo.hostname) : ''
        updateStatus(`已连接: ${activeHost}`, 'connected')
      }
      renderDeviceList()
      updatePTTButton()
    }
  })
  _api.onTransferProgress((data) => updateTransferProgress(data))
  _api.onTransferComplete((data) => completeTransfer(data))
  if (_api.onEditUploaded) {
    _api.onEditUploaded((data) => {
      showToast(`${data.fileName} 已同步到对方电脑`, 'success')
    })
  }
  _api.onTransferError((data) => errorTransfer(data))

  // 智能通知：窗口可见时主进程转发来的 toast（对方发文件/编辑/新建）
  if (_api.onToastNotification) {
    _api.onToastNotification((data) => {
      const text = data.body ? `${data.title}  ${data.body}` : data.title
      showNotifyToast(text, data.filePath, 5000)
    })
  }
  // 对方新建文件/文件夹 → 刷新远程列表
  if (_api.onFileCreatedRemote) {
    _api.onFileCreatedRemote((data) => {
      if (state.connectedDeviceId) refreshRemoteDirectory()
    })
  }
  // 对方删除了本机文件 → 刷新本地列表
  if (_api.onFileDeletedLocal) {
    _api.onFileDeletedLocal((data) => {
      if (state.localPath && state.localPath !== 'root') loadLocalDirectory(state.localPath)
    })
  }

  // === 目录实时刷新（主进程 fs.watch 推送，AI/外部改文件都能感知） ===
  if (_api.onDirChanged) {
    let dirRefreshTimer = null
    _api.onDirChanged(({ dir }) => {
      clearTimeout(dirRefreshTimer)
      dirRefreshTimer = setTimeout(() => {
        // ① 互联模式左侧本地列表
        if (state.localPath && state.localPath !== 'root' && wbPathEq(state.localPath, dir)) {
          loadLocalDirectory(state.localPath)
        }
        // ② 工作台激活页签：文件夹 → 静默重拉；文本/图片文件 → 内容重载（有未保存修改不覆盖）
        const it = getWbActive()
        if (!it || it.origin !== 'local') return
        const key = wbKey(it)
        if (it.isDir) {
          const nav = wbFolderNav[key]
          if (nav && wbPathEq(nav.cwd, dir)) renderWbFolder(it, { silent: true })
          return
        }
        if (!wbPathEq(wbDirOf(it.path), dir)) return
        const kind = getPreviewKind(it.name)
        const ed = wbEditors[key]
        if (kind === 'text') {
          if (ed && ed.dirty) return // 用户正在改且没保存：绝不用磁盘内容盖掉输入
          _api.readTextFile(it.path).then((r) => {
            if (!r || r.content === undefined) return
            const ed2 = wbEditors[key]
            if (!ed2 || ed2.dirty) return // 拉取期间用户开始编辑：放弃覆盖
            ed2.saved = r.content
            ed2.content = r.content
            ed2.mtimeMs = r.mtimeMs
            if (wbRenderedKey === key) mountWbEditor(it)
          }).catch(() => {})
        } else if (kind === 'image' && wbRenderedKey === key) {
          openPreview(it, { bust: true }) // 图片：带时间戳破 file:// 缓存重挂
        }
      }, 350) // 与主进程 400ms 防抖叠加：爆发事件只刷一次
    })
  }
}

// === Status & Toast ===
function updateStatus(text, type) {
  if (statusText) statusText.textContent = text
  if (statusDot) {
    statusDot.className = 'status-dot'
    if (type === 'connecting') statusDot.classList.add('connecting')
    else if (type === 'error') statusDot.classList.add('error')
  }
}

let toastTimer = null
function showToast(message, type = 'info') {
  if (!toast) return
  toast.textContent = message
  toast.className = `toast ${type}`
  toast.onclick = null
  toast.style.cursor = 'default'
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000)
}

// 通知类 toast：持续时间更长，点击可打开文件
function showNotifyToast(message, filePath, duration = 5000) {
  if (!toast) return
  toast.textContent = message
  toast.className = 'toast info'
  if (filePath) {
    toast.style.cursor = 'pointer'
    toast.onclick = () => { _api.openFile(filePath) }
  } else {
    toast.style.cursor = 'default'
    toast.onclick = null
  }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden')
    toast.onclick = null
    toast.style.cursor = 'default'
  }, duration)
}

// === 排序和过滤 ===
function sortEntries(entries, sortKey, searchTerm) {
  let sorted = [...entries]
  
  // 过滤
  if (searchTerm) {
    const term = searchTerm.toLowerCase()
    sorted = sorted.filter(e => e.name.toLowerCase().includes(term))
  }

  // 排序：盘符/桌面入口始终在前
  sorted.sort((a, b) => {
    const aTop = a.isDrive || a.isDesktop
    const bTop = b.isDrive || b.isDesktop
    if (aTop !== bTop) return aTop ? -1 : 1
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    
    switch (sortKey) {
      case 'name-desc': return b.name.localeCompare(a.name)
      case 'size-desc': return (b.size || 0) - (a.size || 0)
      case 'size-asc': return (a.size || 0) - (b.size || 0)
      case 'date-desc': return (b.modifiedTime || 0) - (a.modifiedTime || 0)
      case 'date-asc': return (a.modifiedTime || 0) - (b.modifiedTime || 0)
      default: return a.name.localeCompare(b.name)
    }
  })
  
  return sorted
}

// === 本地文件操作 ===
async function loadLocalDirectory(dirPath) {
  try {
    const result = await _api.listLocalDirectory(dirPath)
    if (result.success) {
      state.localPath = result.path
      state.localEntries = result.entries
      if (localPathEl) localPathEl.value = result.path === 'root' ? '我的电脑' : result.path
      renderLocalFileList(result.entries)
      updateLocalDiskSpace()
      if (result.path && result.path !== 'root') _api.watchDir(result.path).catch(() => {}) // 实时刷新：AI 改动本目录时主进程会推 dir-changed
    } else {
      showToast(`无法访问: ${result.error}`, 'error')
    }
  } catch (err) {
    showToast('加载文件列表失败', 'error')
  }
}

function renderLocalFileList(entries) {
  if (!localFileList) return
  state.localEntries = entries || []
  
  const searchTerm = $('localSearch') ? $('localSearch').value : ''
  const sortKey = $('localSort') ? $('localSort').value : 'date-asc'
  const sorted = sortEntries(state.localEntries, sortKey, searchTerm)

  if (sorted.length === 0) {
    localFileList.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('folder-open')}</div><div>${searchTerm ? '未找到匹配项' : '此目录为空'}</div></div>`
    updateLocalCount()
    return
  }

  localFileList.innerHTML = sorted.map(entry => {
    const isDrive = entry.isDrive
    const isDesktop = entry.isDesktop
    const isDir = entry.isDirectory || isDrive || isDesktop
    const icon = isDesktop ? iconSvg('monitor') : (isDrive ? iconSvg('hard-drive') : (isDir ? iconSvg('folder') : getFileIcon(entry.name)))
    const itemClass = (isDrive || isDesktop) ? 'file-item folder drive' : (isDir ? 'file-item folder' : 'file-item file')
    const sizeText = isDir ? '' : formatSize(entry.size)
    const selected = state.localSelected.has(entry.path) ? ' selected' : ''
    
    return `<div class="${itemClass}${selected}" data-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" data-isdir="${isDir}" draggable="true">
      <span class="file-item-icon">${icon}</span>
      <span class="file-item-name">${escapeHtml(entry.name)}</span>
      <span class="file-item-size">${sizeText}</span>
    </div>`
  }).join('')

  localFileList.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('dblclick', () => onLocalDoubleClick(item))
    item.addEventListener('click', (e) => onLocalClick(e, item))
    item.addEventListener('dragstart', (e) => {
      // Shift+拖拽 = 拖出到桌面/资源管理器（原生拖出）
      if (e.shiftKey) {
        e.preventDefault()
        _api.startDrag(item.dataset.path)
        return
      }
      const selected = getSelectedLocalItems()
      const items = selected.length > 0 ? selected : [{ path: item.dataset.path, name: item.dataset.name, isDir: item.dataset.isdir === 'true' }]
      e.dataTransfer.setData('application/json', JSON.stringify({ source: 'local', items }))
    })
  })

  updateLocalCount()
}

function onLocalDoubleClick(item) {
  const isDir = item.dataset.isdir === 'true'
  if (isDir) {
    loadLocalDirectory(item.dataset.path)
  } else {
    // 双击本地文件用系统默认程序打开
    _api.openFile(item.dataset.path)
  }
}

function onLocalClick(e, item) {
  const isDir = item.dataset.isdir === 'true'
  const path = item.dataset.path

  if (e.ctrlKey) {
    // Ctrl+点击：切换选中
    if (state.localSelected.has(path)) {
      state.localSelected.delete(path)
    } else {
      state.localSelected.add(path)
    }
  } else if (e.shiftKey && state.lastLocalClick) {
    // Shift+点击：范围选择
    const items = Array.from(localFileList.querySelectorAll('.file-item'))
    const startIdx = items.findIndex(i => i.dataset.path === state.lastLocalClick)
    const endIdx = items.findIndex(i => i.dataset.path === path)
    if (startIdx >= 0 && endIdx >= 0) {
      const [from, to] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)]
      for (let i = from; i <= to; i++) {
        state.localSelected.add(items[i].dataset.path)
      }
    }
  } else {
    // 普通点击：单选
    state.localSelected.clear()
    state.localSelected.add(path)
  }

  state.lastLocalClick = path
  
  // 更新 UI
  localFileList.querySelectorAll('.file-item').forEach(i => {
    i.classList.toggle('selected', state.localSelected.has(i.dataset.path))
  })
  updateLocalCount()
}

function updateLocalCount() {
  const countEl = $('localFileCount')
  if (countEl) countEl.textContent = state.localEntries.length
  
  const selEl = $('localSelectedCount')
  const batchBtn = $('localBatchUpload')
  if (state.localSelected.size > 0) {
    if (selEl) { selEl.textContent = `| 已选 ${state.localSelected.size} 项`; selEl.classList.remove('hidden') }
    if (batchBtn && state.connectedDeviceId) batchBtn.classList.remove('hidden')
  } else {
    if (selEl) selEl.classList.add('hidden')
    if (batchBtn) batchBtn.classList.add('hidden')
  }
}

function getSelectedLocalItems() {
  return state.localEntries
    .filter(e => state.localSelected.has(e.path))
    .map(e => ({ path: e.path, name: e.name, isDir: e.isDirectory || e.isDrive }))
}

// === 远程文件操作 ===
async function refreshRemoteDirectory(targetPath) {
  if (!state.connectedDeviceId) return
  try {
    const p = targetPath || state.remotePath || 'root'
    const result = await _api.listRemoteDirectory(state.connectedDeviceId, p)
    if (result.success) {
      state.remotePath = result.path
      state.remoteEntries = result.entries
      if (remotePathEl) remotePathEl.value = result.path === 'root' ? '我的电脑' : result.path
      const remoteUpBtn = $('remoteUp')
      if (remoteUpBtn) remoteUpBtn.disabled = false
      renderRemoteFileList(result.entries)
      updateRemoteDiskSpace()
    } else {
      showToast(`无法访问: ${result.error}`, 'error')
    }
  } catch (err) {
    showToast('加载远程文件列表失败', 'error')
  }
}

function renderRemoteFileList(entries) {
  if (!remoteFileList) return
  state.remoteEntries = entries || []
  
  const searchTerm = $('remoteSearch') ? $('remoteSearch').value : ''
  const sortKey = $('remoteSort') ? $('remoteSort').value : 'date-asc'
  const sorted = sortEntries(state.remoteEntries, sortKey, searchTerm)

  if (sorted.length === 0) {
    remoteFileList.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('folder-open')}</div><div>${searchTerm ? '未找到匹配项' : '此目录为空'}</div></div>`
    updateRemoteCount()
    return
  }

  remoteFileList.innerHTML = sorted.map(entry => {
    const isDrive = entry.isDrive
    const isDesktop = entry.isDesktop
    const isDir = entry.isDirectory || isDrive || isDesktop
    const icon = isDesktop ? iconSvg('monitor') : (isDrive ? iconSvg('hard-drive') : (isDir ? iconSvg('folder') : getFileIcon(entry.name)))
    const itemClass = (isDrive || isDesktop) ? 'file-item folder drive' : (isDir ? 'file-item folder' : 'file-item file')
    const sizeText = isDir ? '' : formatSize(entry.size)
    const selected = state.remoteSelected.has(entry.path) ? ' selected' : ''
    
    return `<div class="${itemClass}${selected}" data-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}" data-isdir="${isDir}" draggable="true">
      <span class="file-item-icon">${icon}</span>
      <span class="file-item-name">${escapeHtml(entry.name)}</span>
      <span class="file-item-size">${sizeText}</span>
    </div>`
  }).join('')

  remoteFileList.querySelectorAll('.file-item').forEach(item => {
    item.addEventListener('dblclick', () => {
      if (item.classList.contains('folder') || item.classList.contains('drive')) {
        refreshRemoteDirectory(item.dataset.path)
      }
    })
    item.addEventListener('click', (e) => onRemoteClick(e, item))
    item.addEventListener('dragstart', (e) => {
      const selectedItems = Array.from(remoteFileList.querySelectorAll('.file-item.selected'))
      const dragItems = selectedItems.length > 0 ? selectedItems : [item]
      const data = {
        source: 'remote',
        deviceId: state.connectedDeviceId,
        deviceName: (state.connectedDeviceInfo && (state.connectedDeviceInfo.name || state.connectedDeviceInfo.hostname)) || '远程设备',
        items: dragItems.map(i => ({
          path: i.dataset.path,
          isDir: i.dataset.isdir === 'true'
        }))
      }
      e.dataTransfer.setData('application/json', JSON.stringify(data))
      e.dataTransfer.effectAllowed = 'copy'
      // 记录正在拖出的远程文件，dragend 时判断是否拖到了窗口外
      state.remoteDragOutItems = data.items
      state.remoteDragConsumed = false
    })
    item.addEventListener('dragend', () => {
      // 拖到窗口外（桌面/资源管理器）→ 下载到本机桌面
      if (state.remoteDragOutItems && !state.remoteDragConsumed) {
        const items = state.remoteDragOutItems
        state.remoteDragOutItems = null
        downloadRemoteToDesktop(items)
      } else {
        state.remoteDragOutItems = null
        state.remoteDragConsumed = false
      }
    })
  })

  updateRemoteCount()
}

function onRemoteClick(e, item) {
  const path = item.dataset.path

  if (e.ctrlKey) {
    if (state.remoteSelected.has(path)) state.remoteSelected.delete(path)
    else state.remoteSelected.add(path)
  } else if (e.shiftKey && state.lastRemoteClick) {
    const items = Array.from(remoteFileList.querySelectorAll('.file-item'))
    const startIdx = items.findIndex(i => i.dataset.path === state.lastRemoteClick)
    const endIdx = items.findIndex(i => i.dataset.path === path)
    if (startIdx >= 0 && endIdx >= 0) {
      const [from, to] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)]
      for (let i = from; i <= to; i++) state.remoteSelected.add(items[i].dataset.path)
    }
  } else {
    state.remoteSelected.clear()
    state.remoteSelected.add(path)
  }

  state.lastRemoteClick = path
  remoteFileList.querySelectorAll('.file-item').forEach(i => {
    i.classList.toggle('selected', state.remoteSelected.has(i.dataset.path))
  })
  updateRemoteCount()
}

function updateRemoteCount() {
  const countEl = $('remoteFileCount')
  if (countEl) countEl.textContent = state.remoteEntries.length
  
  const selEl = $('remoteSelectedCount')
  const batchBtn = $('remoteBatchDownload')
  if (state.remoteSelected.size > 0) {
    if (selEl) { selEl.textContent = `| 已选 ${state.remoteSelected.size} 项`; selEl.classList.remove('hidden') }
    if (batchBtn) batchBtn.classList.remove('hidden')
  } else {
    if (selEl) selEl.classList.add('hidden')
    if (batchBtn) batchBtn.classList.add('hidden')
  }
}

function getSelectedRemoteItems() {
  return state.remoteEntries
    .filter(e => state.remoteSelected.has(e.path))
    .map(e => ({ path: e.path, name: e.name, isDir: e.isDirectory || e.isDrive }))
}

// === Work 工作台：汇集资源面板选中的文件/文件夹，按会话独立持久化 ===
// 数据结构：state.wbItems = [{ path, name, isDir, size, origin('local'|deviceId), originName, _missing }]
function getPreviewKind(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'm4v', 'mov'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  if (['htm', 'html', 'mht', 'mhtml'].includes(ext)) return 'html'
  if (['txt', 'md', 'markdown', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'less', 'scss', 'vue',
    'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala',
    'sql', 'bat', 'cmd', 'ps1', 'sh', 'yml', 'yaml', 'xml', 'ini', 'cfg', 'conf', 'toml',
    'csv', 'log', 'env', 'gitignore'].includes(ext)) return 'text'
  return null
}

function fileToUrl(p) {
  let norm = String(p).replace(/\\/g, '/')
  if (!norm.startsWith('/')) norm = '/' + norm
  return 'file://' + encodeURI(norm).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

// === 全局错误处理 ===
window.addEventListener('error', (e) => {
  console.error('[Global Error]', e.error || e.message)
  if (e.message && !e.message.includes('Script error')) {
    showToast(`错误: ${e.message}`, 'error')
  }
})

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Promise]', e.reason)
})

// === 启动 ===
document.addEventListener('DOMContentLoaded', () => {
  init().then(() => renderIcons(document)).catch(err => {
    console.error('init failed:', err)
    showToast('初始化失败', 'error')
  })
})