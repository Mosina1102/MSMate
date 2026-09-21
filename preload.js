try {
  const { contextBridge, ipcRenderer } = require('electron')

  const api = {
    getInfo: () => ipcRenderer.invoke('app:get-info'),
    getPairedDevices: () => ipcRenderer.invoke('app:get-paired-devices'),
    getPairCode: () => ipcRenderer.invoke('app:get-pair-code'),
    acceptPair: (data) => ipcRenderer.invoke('app:accept-pair', data),
    verifyPairCode: (data) => ipcRenderer.invoke('app:verify-pair-code', data),
    removePairedDevice: (deviceId) => ipcRenderer.invoke('device:remove-paired', deviceId),
    refreshDevices: () => ipcRenderer.invoke('device:refresh'),

    // 设备改名 + 备注
    setDeviceName: (name) => ipcRenderer.invoke('device:set-name', { name }),
    getDeviceName: () => ipcRenderer.invoke('device:get-name'),
    getDeviceRemarks: () => ipcRenderer.invoke('device:get-remarks'),
    setDeviceRemark: (deviceId, remark) => ipcRenderer.invoke('device:set-remark', { deviceId, remark }),

    connectDevice: (deviceId) => ipcRenderer.invoke('connection:connect', { deviceId }),
    connectByIP: (ip) => ipcRenderer.invoke('connection:connect-by-ip', { ip }),
    disconnectDevice: (deviceId) => ipcRenderer.invoke('connection:disconnect', { deviceId }),
    getConnectedDevices: () => ipcRenderer.invoke('connection:get-connected'),

    listLocalDirectory: (targetPath) => ipcRenderer.invoke('file:list-local', { path: targetPath }),
    listRemoteDirectory: (deviceId, targetPath) => ipcRenderer.invoke('file:list-remote', { deviceId, path: targetPath }),
    watchDir: (p) => ipcRenderer.invoke('file:watch-dir', { path: p }),
    onDirChanged: (callback) => ipcRenderer.on('file:dir-changed', (_, data) => callback(data)),

    downloadFile: (deviceId, remotePath, localPath, transferId) => ipcRenderer.invoke('file:download', { deviceId, remotePath, localPath, transferId }),
    uploadFile: (deviceId, localPath, remotePath, transferId) => ipcRenderer.invoke('file:upload', { deviceId, localPath, remotePath, transferId }),

    // 文件夹递归传输
    downloadFolder: (deviceId, remotePath, localDir) => ipcRenderer.invoke('file:download-folder', { deviceId, remotePath, localDir }),
    uploadFolder: (deviceId, localPath, remoteDir) => ipcRenderer.invoke('file:upload-folder', { deviceId, localPath, remoteDir }),

    batchDownload: (deviceId, files, destDir) => ipcRenderer.invoke('file:batch-download', { deviceId, files, destDir }),
    batchUpload: (deviceId, filePaths, remoteDir) => ipcRenderer.invoke('file:batch-upload', { deviceId, filePaths, remoteDir }),

    deleteRemoteFile: (deviceId, filePath) => ipcRenderer.invoke('file:delete-remote', { deviceId, filePath }),
    createRemoteFolder: (deviceId, folderPath) => ipcRenderer.invoke('file:create-folder-remote', { deviceId, folderPath }),
    createRemoteFile: (deviceId, filePath, fileType) => ipcRenderer.invoke('file:create-remote-file', { deviceId, filePath, fileType }),
    renameRemoteFile: (deviceId, oldPath, newName) => ipcRenderer.invoke('file:rename-remote', { deviceId, oldPath, newName }),

    // 本地新建文件/文件夹 + 拖出 + 外部拖入复制
    createLocalFile: (parentPath, fileName, fileType) => ipcRenderer.invoke('file:create-local-file', { parentPath, fileName, fileType }),
    createLocalFolder: (parentPath, folderName) => ipcRenderer.invoke('file:create-local-folder', { parentPath, folderName }),
    startDrag: (filePath) => ipcRenderer.send('drag:start', { filePath }),
    copyToLocal: (srcPath, destDir) => ipcRenderer.invoke('file:copy-to-local', { srcPath, destDir }),
    getDiskSpace: (targetPath) => ipcRenderer.invoke('fs:get-disk-space', targetPath),
    getRemoteDiskSpace: (deviceId, targetPath) => ipcRenderer.invoke('file:get-remote-disk-space', { deviceId, targetPath }),
    copyRemoteFile: (deviceId, srcPath, destDir) => ipcRenderer.invoke('file:copy-remote', { deviceId, srcPath, destDir }),
    moveRemoteFile: (deviceId, srcPath, destDir) => ipcRenderer.invoke('file:move-remote', { deviceId, srcPath, destDir }),

    cancelTransfer: (transferId) => ipcRenderer.invoke('transfer:cancel', { transferId }),

    selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
    selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
    selectSave: (defaultPath) => ipcRenderer.invoke('dialog:select-save', { defaultPath }),

    // 自定义背景（全局设置 → 外观）
    pickBackground: () => ipcRenderer.invoke('ui:pick-background'),
    getBackground: () => ipcRenderer.invoke('ui:get-background'),
    clearBackground: () => ipcRenderer.invoke('ui:clear-background'),

    // 工作台：预览读取 / Office 渲染 / 按会话持久化
    saveDataUrlFile: (dataUrl, filePath) => ipcRenderer.invoke('fs:save-dataurl-file', { dataUrl, filePath }),
    userDataPath: () => ipcRenderer.invoke('app:get-user-data-path'),
    readFileBase64: (filePath) => ipcRenderer.invoke('fs:read-file-base64', { path: filePath }),
    readTextFile: (filePath, maxBytes) => ipcRenderer.invoke('fs:read-text-file', { filePath, maxBytes }),
    writeTextFile: (filePath, content) => ipcRenderer.invoke('fs:write-text-file', { filePath, content }),
    shellDirs: () => ipcRenderer.invoke('app:get-shell-dirs'),
    createWbEntry: (dir, name, isDir) => ipcRenderer.invoke('fs:create-wb-entry', { dir, name, isDir }),
    readXlsxSheet: (filePath, sheet) => ipcRenderer.invoke('fs:xlsx-sheet', { filePath, sheet }),
    writeXlsxCells: (filePath, sheet, updates) => ipcRenderer.invoke('fs:xlsx-write', { filePath, sheet, updates }),
    saveWordRich: (filePath, paragraphs) => ipcRenderer.invoke('fs:word-rich-save', { filePath, paragraphs }),
    fileMtime: (filePath) => ipcRenderer.invoke('fs:file-mtime', { filePath }),
    waitFileChange: (filePath, baseMtime, timeoutMs) => ipcRenderer.invoke('fs:wait-file-change', { filePath, baseMtime, timeoutMs }),
    docxHandler: () => ipcRenderer.invoke('docx:handler'),
    docxEmbed: (opts) => ipcRenderer.invoke('docx:embed', opts),
    docxEmbedMove: (x, y, w, h) => ipcRenderer.invoke('docx:embed-move', { x, y, w, h }),
    docxEmbedHide: () => ipcRenderer.invoke('docx:embed-hide'),
    docxEmbedShow: () => ipcRenderer.invoke('docx:embed-show'),
    docxEmbedClose: () => ipcRenderer.invoke('docx:embed-close'),
    docxEmbedAlive: () => ipcRenderer.invoke('docx:embed-alive'),
    renderOffice: (filePath) => ipcRenderer.invoke('fs:render-office', { filePath }),
    // v2.4.94 Word 高保真视图：主进程拿 docx base64 + preload 内渲染 docx-preview（分页/字体/颜色/表格样式全还原）
    docxBuffer: (filePath) => ipcRenderer.invoke('fs:docx-buffer', { filePath }),
    renderDocxPreview: async (base64, hostId) => {
      try {
        const host = document.getElementById(hostId)
        if (!host) return { ok: false, error: '找不到渲染容器' }
        // v2.5.4 关键修复：打包态 preload 在 app.asar.unpacked，向上找不到 asar 内 node_modules
        // （真机实证 Cannot find module 'docx-preview'，2.4.94 起高保真从未在正式包生效的根因）。
        // 目录 require 也读不了 asar（无法做 exports 解析），必须显式 require 到 dist 文件。
        let dp = null
        try { dp = require('docx-preview') } catch { }
        if (!dp) dp = require(require('path').join(__dirname.replace('app.asar.unpacked', 'app.asar'), 'node_modules', 'docx-preview', 'dist', 'docx-preview.js'))
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        let style = document.getElementById('wb-docx-preview-style')
        if (!style) {
          style = document.createElement('style')
          style.id = 'wb-docx-preview-style'
          document.head.appendChild(style)
        }
        style.textContent = ''
        host.innerHTML = ''
        // v2.5.68：按容器宽度自适应缩放——未全屏 webview 窄容器时页面固定 794px 溢出（图1 工具栏/内容占比异常）
        const scale = Math.max(0.35, Math.min(1, ((host.clientWidth || 0) - 48) / 830))
        await dp.renderAsync(bytes, host, style, {
          inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
          scale,
          useBase64URL: true, // 图片转 dataURI——保存时主进程能落临时文件（blob: URL 跨进程拿不到）
          // v2.5.1 全面对齐 WPS 观感：页眉/页脚/脚注/尾注照常渲染（保存链路按 article 收集，不会误收进正文）
          renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
          // 尊重 Word/WPS 保存时分页标记（lastRenderedPageBreak）→ 分页位置和 WPS 打开时一致
          ignoreLastRenderedPageBreak: false,
          // 制表位精确计算（experimental）：目录/表单类文档的 Tab 对齐和 WPS 一个样
          experimental: true,
          trimXmlDeclaration: true, renderChanges: false,
          // v2.5.6：批注气泡渲染——导师批注直接可见（作者+内容显示在划选文字旁），论文改稿场景刚需
          renderComments: true
        })
        return { ok: true, pages: host.querySelectorAll('section.docx').length }
      } catch (err) {
        return { ok: false, error: (err && err.message) || '渲染失败' }
      }
    },
    wbGet: (sessionId) => ipcRenderer.invoke('wb:get', { sessionId }),
    wbSet: (sessionId, data) => ipcRenderer.invoke('wb:set', { sessionId, ...(data || {}) }),

    openFile: (filePath, opts) => ipcRenderer.invoke('shell:open-file', { filePath, ...(opts || {}) }),
    openInExplorer: (filePath) => ipcRenderer.invoke('shell:open-in-explorer', { filePath }),
    // 远程编辑：下载→打开→保存后自动上传
    editRemoteFile: (deviceId, remotePath) => ipcRenderer.invoke('file:edit-remote', { deviceId, remotePath }),
    onEditUploaded: (callback) => ipcRenderer.on('edit:uploaded', (event, data) => callback(data)),
    fsExists: (targetPath) => ipcRenderer.invoke('fs:exists', targetPath),

    // 本地文件操作
    renameLocalFile: (oldPath, newName) => ipcRenderer.invoke('file:rename-local', { oldPath, newName }),
    deleteLocalFile: (filePath) => ipcRenderer.invoke('file:delete-local', { filePath }),
    getDownloadsDir: () => ipcRenderer.invoke('app:get-downloads-dir'),
    getDesktopDir: () => ipcRenderer.invoke('app:get-desktop-dir'),

    // 传输历史
    getTransferHistory: () => ipcRenderer.invoke('history:get'),
    clearTransferHistory: () => ipcRenderer.invoke('history:clear'),

    // 对讲机（PTT）
    pttStart: (deviceId, sampleRate) => ipcRenderer.invoke('ptt:start', { deviceId, sampleRate }),
    pttChunk: (deviceId, b64) => ipcRenderer.send('ptt:chunk', { deviceId, b64 }),
    pttStop: (deviceId) => ipcRenderer.invoke('ptt:stop', { deviceId }),
    getPTTHotkey: () => ipcRenderer.invoke('ptt:get-hotkey'),
    onPTTHotkeyDown: (callback) => ipcRenderer.on('ptt:hotkey-down', () => callback()),
    onPTTHotkeyUp: (callback) => ipcRenderer.on('ptt:hotkey-up', () => callback()),
    onPTTIncomingStart: (callback) => ipcRenderer.on('ptt:incoming-start', (_, data) => callback(data)),
    onPTTIncomingChunk: (callback) => ipcRenderer.on('ptt:incoming-chunk', (_, data) => callback(data)),
    onPTTIncomingEnd: (callback) => ipcRenderer.on('ptt:incoming-end', (_, data) => callback(data)),

    // 设置
    getSetting: (key) => ipcRenderer.invoke('settings:get', { key }),
    setSetting: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
    // v2.5.1 开机自启（读写注册表，实时状态）
    getAutoStart: () => ipcRenderer.invoke('app:get-autostart'),
    setAutoStart: (enabled) => ipcRenderer.invoke('app:set-autostart', { enabled }),

    // 账号体系（邮箱注册/登录；token 由主进程存 userData/settings.json）
    authGetState: () => ipcRenderer.invoke('auth:get-state'),
    authRegister: (email, password, nickname, code) => ipcRenderer.invoke('auth:register', { email, password, nickname, code }),
    authLogin: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
    authMe: () => ipcRenderer.invoke('auth:me'),
    authLogout: () => ipcRenderer.invoke('auth:logout'),
    authUpdateProfile: (nickname) => ipcRenderer.invoke('auth:profile', { nickname }),
    // 邮箱验证码（scene: register|reset）/ 找回密码 / 头像上传
    authSendCode: (email, scene) => ipcRenderer.invoke('auth:send-code', { email, scene }),
    authReset: (email, code, password) => ipcRenderer.invoke('auth:reset', { email, code, password }),
    authAvatar: (dataUrl) => ipcRenderer.invoke('auth:avatar', { dataUrl }),
    // 积分充值（个人收款码 + 凭证批款）
    creditsOrderCreate: (amount) => ipcRenderer.invoke('credits:order-create', { amount }),
    creditsOrderVoucher: (id, voucher) => ipcRenderer.invoke('credits:order-voucher', { id, voucher }),
    creditsOrdersMy: () => ipcRenderer.invoke('credits:orders-my'),
    creditsOrderCancel: (id) => ipcRenderer.invoke('credits:order-cancel', { id }),
    creditsBalance: () => ipcRenderer.invoke('credits:balance'),
    creditsSignin: () => ipcRenderer.invoke('credits:signin'),

    // 互联网传输每日限额（2GB/天，公网连接计流量）
    netQuota: () => ipcRenderer.invoke('net:quota'),
    onNetQuotaExceeded: (cb) => ipcRenderer.on('net-quota-exceeded', () => { try { cb() } catch { } }),

    // 好友（远程设备通讯录）
    getFriends: () => ipcRenderer.invoke('friends:get'),
    addFriend: (host, name) => ipcRenderer.invoke('friends:add', { host, name }),
    removeFriend: (host) => ipcRenderer.invoke('friends:remove', { host }),

    // v2.7.16：用户反馈（须登录，服务端存档 + ntfy 通知管理员）
    feedbackSubmit: (type, content, contact) => ipcRenderer.invoke('feedback:submit', { type, content, contact }),
    // v2.7.16：内置浏览器/网页页签下载进度（will-download 接管，进度浮条）
    onWbDownloadProgress: (cb) => ipcRenderer.on('wb:download-progress', (_e, meta) => { try { cb(meta) } catch { } }),

    // 远程审批被拒/超时（发起方等待框收尾）
    onPairDecision: (callback) => {
      ipcRenderer.on('pair:decision', (_e, data) => { try { callback(data) } catch { } })
    },

    // 应用更新检查（GitHub Releases）+ 语音合成试听（v2.4.97）
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    ttsSpeak: (payload) => ipcRenderer.invoke('ai:tts', payload || {}),

    // 互联网模式（中转服务器）
    relayGetState: () => ipcRenderer.invoke('relay:get-state'),
    relaySave: (enabled, host) => ipcRenderer.invoke('relay:save', { enabled, host }),
    relayConnect: (deviceId) => ipcRenderer.invoke('relay:connect', { deviceId }),
    relayResetPin: () => ipcRenderer.invoke('relay:reset-pin'),
    onRelayStatus: (callback) => ipcRenderer.on('relay:status', (_, data) => callback(data)),
    onRelayDevices: (callback) => ipcRenderer.on('relay:devices', (_, data) => callback(data)),

    // IPv6 直连
    ipv6GetInvite: () => ipcRenderer.invoke('ipv6:get-invite'),
    ipv6ConnectInvite: (text) => ipcRenderer.invoke('ipv6:connect-invite', { text }),
    ipv6ConnectPeer: (deviceId) => ipcRenderer.invoke('ipv6:connect-peer', { deviceId }),
    ipv6GetPeers: () => ipcRenderer.invoke('ipv6:get-peers'),
    ipv6RemovePeer: (deviceId) => ipcRenderer.invoke('ipv6:remove-peer', { deviceId }),
    onIpv6Peers: (callback) => ipcRenderer.on('ipv6:peers', (_, data) => callback(data)),

    onLog: (callback) => {
      ipcRenderer.on('tcp:log', (_, data) => callback(data))
    },
    onDeviceFound: (callback) => {
      ipcRenderer.on('device:found', (_, data) => callback(data))
    },
    onDeviceLost: (callback) => {
      ipcRenderer.on('device:lost', (_, data) => callback(data))
    },
    onFileList: (callback) => {
      ipcRenderer.on('file:list', (_, data) => callback(data))
    },
    onTransferProgress: (callback) => {
      ipcRenderer.on('transfer:progress', (_, data) => callback(data))
    },
    onTransferComplete: (callback) => {
      ipcRenderer.on('transfer:complete', (_, data) => callback(data))
    },
    onTransferError: (callback) => {
      ipcRenderer.on('transfer:error', (_, data) => callback(data))
    },
    onConnectionStatus: (callback) => {
      ipcRenderer.on('connection:status', (_, data) => callback(data))
    },
    onPairRequest: (callback) => {
      ipcRenderer.on('pair:request', (_, data) => callback(data))
    },
    onPaired: (callback) => {
      ipcRenderer.on('paired', (_, data) => callback(data))
    },
    onIncomingPairRequest: (callback) => {
      ipcRenderer.on('pair:request', (_, data) => callback(data))
    },
    // 2.0：发起方收到"对方尚未信任"，需要输入配对码
    onPairRequired: (callback) => {
      ipcRenderer.on('pair:required', (_, data) => callback(data))
    },
    // 2.0：被连方收到"对方已通过配对码验证"，自动接受
    onPairAutoAccepted: (callback) => {
      ipcRenderer.on('pair:auto-accepted', (_, data) => callback(data))
    },
    // 智能通知：窗口可见时主进程发来的 toast 通知
    onToastNotification: (callback) => {
      ipcRenderer.on('notification:toast', (_, data) => callback(data))
    },
    // 对方新建文件/文件夹时通知渲染进程刷新
    onFileCreatedRemote: (callback) => {
      ipcRenderer.on('file:created-remote', (_, data) => callback(data))
    },
    // 对方删除了本机文件：刷新本地列表
    onFileDeletedLocal: (callback) => {
      ipcRenderer.on('file:deleted-local', (_, data) => callback(data))
    },

    // === MSWork AI 助手（多会话：各 API 均可带 sessionId，缺省由主进程落到默认会话）===
    aiSend: (text, sessionId) => ipcRenderer.invoke('ai:send', { text, sessionId }),
    aiAbort: (sessionId) => ipcRenderer.invoke('ai:abort', { sessionId }),
    // 下载进度条：订阅进度事件 / 用户取消
    onDownloadProgress: (cb) => ipcRenderer.on('ai:download-progress', (event, info) => cb(info)),
    cancelDownload: (id) => ipcRenderer.invoke('ai:download-cancel', id),
    aiApprove: (approvalId, ok, sessionId) => ipcRenderer.invoke('ai:approve', { approvalId, ok, sessionId }),
    aiAskResult: (askId, payload, sessionId) => ipcRenderer.invoke('ai:ask-answer', { askId, payload, sessionId }),
    aiClearChat: (sessionId) => ipcRenderer.invoke('ai:clear-chat', { sessionId }),
    aiGetConfig: () => ipcRenderer.invoke('ai:get-config'),
    aiSetConfig: (cfg) => ipcRenderer.invoke('ai:set-config', cfg),
    aiBuiltinModels: () => ipcRenderer.invoke('ai:builtin-models'),
    cloudSyncStatus: () => ipcRenderer.invoke('cloudsync:status'),
    cloudSyncNow: () => ipcRenderer.invoke('cloudsync:now'),
    presenceList: () => ipcRenderer.invoke('presence:list'),
    aiGetHistory: (sessionId) => ipcRenderer.invoke('ai:get-history', { sessionId }),
    aiListSnapshots: () => ipcRenderer.invoke('ai:snapshots'),
    aiRestoreSnapshot: (id) => ipcRenderer.invoke('ai:restore-snapshot', { id }),
    aiDeleteSnapshot: (id) => ipcRenderer.invoke('ai:delete-snapshot', { id }),
    aiRollback: (msgIndex, sessionId) => ipcRenderer.invoke('ai:rollback', { msgIndex, sessionId }),
    // 会话管理：列表 / 新建 / 重命名 / 置顶 / 删除
    aiSessions: () => ipcRenderer.invoke('ai:sessions'),
    aiSessionCreate: (title) => ipcRenderer.invoke('ai:session-create', { title }),
    aiSessionRename: (id, title) => ipcRenderer.invoke('ai:session-rename', { id, title }),
    aiSessionPin: (id, pinned) => ipcRenderer.invoke('ai:session-pin', { id, pinned }),
    aiSessionDelete: (id) => ipcRenderer.invoke('ai:session-delete', { id }),
    aiOpenWorkspace: () => ipcRenderer.invoke('ai:openWorkspace'),
    aiOpenNotes: () => ipcRenderer.invoke('ai:openNotes'),
    // AI 打开的文件/网址进工作台事件（Work 模式开工作台页签；互联模式回退系统打开）
    onAiWorkbenchOpen: (callback) => ipcRenderer.on('ai:workbench-open', (_, data) => callback(data)),
    // AI 改动了本地文件事件（写/改/删/复制/移动等成功后）→ 工作台打开着该文件就自动刷新
    onAiFileChanged: (callback) => ipcRenderer.on('ai:file-changed', (_, data) => callback(data)),
    // 回滚预览：列出将撤销的文件操作清单（Trae 式确认卡）
    aiRollbackPreview: (msgIndex, sessionId) => ipcRenderer.invoke('ai:rollback-preview', { msgIndex, sessionId }),
    openExternalFallback: (payload) => ipcRenderer.invoke('sys:open-external', payload || {}),
    // 数据同步：导出/导入全量数据 zip + 重启生效
    aiExportData: (defaultName) => ipcRenderer.invoke('ai:export-data', { defaultName }),
    aiImportData: () => ipcRenderer.invoke('ai:import-data'),
    aiRestartApp: () => ipcRenderer.invoke('ai:restart-app'),
    // 语音输入：录音数据 → ASR 转文字
    aiVoiceTranscribe: (payload) => ipcRenderer.invoke('ai:voice-transcribe', payload),
    // 应用内更新（v2.5.0）：下载进度事件 + 状态查询 + 立即重启安装
    updateDownload: () => ipcRenderer.invoke('update:download'),
    updateInstall: () => ipcRenderer.invoke('update:install'),
    updateGetState: () => ipcRenderer.invoke('update:get-state'),
    onUpdateDlProgress: (callback) => ipcRenderer.on('update:dl-progress', (_, data) => callback(data)),
    // 网页版模型（[网页]DeepSeek）：主进程请求渲染层网页引擎自动对话；引擎流式回传结果
    onAiWebchatAsk: (callback) => ipcRenderer.on('ai:webchat-ask', (_, data) => callback(data)),
    webchatChunk: (sessionId, requestId, delta) => ipcRenderer.invoke('ai:webchat-chunk', { sessionId, requestId, delta }),
    webchatConv: (sessionId, url) => ipcRenderer.invoke('ai:webchat-conv', { sessionId, url }),
    webchatDone: (sessionId, requestId, text) => ipcRenderer.invoke('ai:webchat-done', { sessionId, requestId, text }),
    webchatError: (sessionId, requestId, error) => ipcRenderer.invoke('ai:webchat-error', { sessionId, requestId, error }),
    webchatWait: (sessionId, requestId, seconds) => ipcRenderer.invoke('ai:webchat-wait', { sessionId, requestId, seconds }),
    // browser_* 网页控制桥：主进程请求渲染层工作台受控页签执行操作，结果回执（请求-响应模式）
    onAiBrowserCtl: (callback) => ipcRenderer.on('ai:browser-ctl', (_, data) => callback(data)),
    browserCtlResult: (reqId, result) => ipcRenderer.send('ai:browser-ctl-result', { reqId, result }),
    // 生成模式直连（聊天输入区"生图/生视频"上滑菜单）
    aiGenerateImage: (sessionId, prompt, size, images, batch, polish, steps) => ipcRenderer.invoke('ai:generate-image', { sessionId, prompt, size, images, batch, polish, steps }),
    aiGenerateVideo: (sessionId, prompt) => ipcRenderer.invoke('ai:generate-video', { sessionId, prompt }),
    onAiEvent: (callback) => {
      ipcRenderer.on('ai:event', (_, data) => callback(data))
    },

    // 桌宠"莫西"（src/pet.html 专用：事件接收 + 拖拽 + 点击唤起主窗口）
    onPetEvent: (callback) => {
      ipcRenderer.on('pet:event', (_, data) => callback(data))
    },
    onPetScale: (callback) => {
      ipcRenderer.on('pet:scale', (_, data) => callback(data))
    },
    petDragStart: (screenX, screenY) => ipcRenderer.send('pet:drag-start', { screenX, screenY }),
    petDragMove: (screenX, screenY) => ipcRenderer.send('pet:drag-move', { screenX, screenY }),
    petClick: () => ipcRenderer.send('pet:click'),
    petFileDrop: (paths) => ipcRenderer.send('pet:file-drop', { paths }),
    petGetEnabled: () => ipcRenderer.invoke('pet:get-enabled'),
    petSetEnabled: (on) => ipcRenderer.invoke('pet:set-enabled', { on }),

    // 内置截图（capture.html 专用：收背景快照 / 提交成品 / 取消；主窗口收注入事件）
    onCaptureBg: (callback) => ipcRenderer.on('capture:bg', (_, data) => callback(data)),
    captureDone: (dataURL) => ipcRenderer.send('capture:done', { dataURL }),
    captureCancel: () => ipcRenderer.send('capture:cancel'),
    captureStart: () => ipcRenderer.send('capture:start'),
    onCaptureInject: (callback) => ipcRenderer.on('capture:inject', (_, data) => callback(data)),
    // 聊天框 Ctrl+V 粘贴图片：剪贴板有图则存文件返回路径（渲染层挂引用胶囊）
    saveClipboardImage: () => ipcRenderer.invoke('chat:save-clipboard-image'),

    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('tcp:log')
      ipcRenderer.removeAllListeners('device:found')
      ipcRenderer.removeAllListeners('device:lost')
      ipcRenderer.removeAllListeners('file:list')
      ipcRenderer.removeAllListeners('transfer:progress')
      ipcRenderer.removeAllListeners('transfer:complete')
      ipcRenderer.removeAllListeners('transfer:error')
      ipcRenderer.removeAllListeners('connection:status')
      ipcRenderer.removeAllListeners('pair:request')
      ipcRenderer.removeAllListeners('pair:required')
      ipcRenderer.removeAllListeners('pair:auto-accepted')
      ipcRenderer.removeAllListeners('paired')
      ipcRenderer.removeAllListeners('notification:toast')
      ipcRenderer.removeAllListeners('file:created-remote')
      ipcRenderer.removeAllListeners('file:deleted-local')
      ipcRenderer.removeAllListeners('ptt:hotkey-down')
      ipcRenderer.removeAllListeners('ptt:hotkey-up')
      ipcRenderer.removeAllListeners('ptt:incoming-start')
      ipcRenderer.removeAllListeners('ptt:incoming-chunk')
      ipcRenderer.removeAllListeners('ptt:incoming-end')
    }
  }

  contextBridge.exposeInMainWorld('api', api)
  console.log('[preload] API exposed successfully')
} catch (err) {
  console.error('[preload] Failed to expose API:', err.message)
  console.error('[preload] Stack:', err.stack)
  
  try {
    const { contextBridge } = require('electron')
    contextBridge.exposeInMainWorld('api', {
      _error: err.message,
      _fallback: true
    })
  } catch (e) {
    console.error('[preload] Even minimal API exposure failed:', e.message)
  }
}
