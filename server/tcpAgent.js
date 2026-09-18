const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { getDiskSpace } = require('./diskSpace')

let JSZip
try { JSZip = require('jszip') } catch {}

const TCP_PORT = parseInt(process.env.MSC_TCP_PORT || '45679', 10)
const BUFFER_SIZE = 64 * 1024
const REQUEST_TIMEOUT = 30000

// 公网 IP 判断（互联网传输每日限额用）：公网地址的连接计流量，局域网/内网/环回不计
function isPublicIP(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '')
  const v = net.isIP(s)
  if (v === 4) {
    const [a, b] = s.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false // 链路本地
    if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 运营商大内网
    return true
  }
  if (v === 6) {
    const low = s.toLowerCase()
    if (low === '::1' || low === '::') return false
    if (low.startsWith('fe80')) return false // 链路本地
    if (low.startsWith('fc') || low.startsWith('fd')) return false // ULA 私有
    return true // 2000::/3 全球单播
  }
  return false
}

// 获取桌面路径（兼容 OneDrive 重定向），失败返回 null
function getDesktopPath() {
  try {
    const { app } = require('electron')
    if (app && app.getPath) {
      const p = app.getPath('desktop')
      if (p && fs.existsSync(p)) return p
    }
  } catch {}
  try {
    const p = path.join(os.homedir(), 'Desktop')
    if (fs.existsSync(p)) return p
  } catch {}
  return null
}

function genId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  return crypto.randomBytes(16).toString('hex')
}

// 递归复制文件夹（同步），带自包含防护与数量上限
function copyFolderRecursiveSync(src, dest) {
  const norm = (x) => path.normalize(String(x)).toLowerCase().replace(/[\\/]+$/, '')
  const s = norm(src)
  const d = norm(dest)
  if (s === d) throw new Error('源和目标是同一位置')
  if (d.startsWith(s + path.sep)) throw new Error('不能把文件夹复制到它自己的内部')
  let count = 0
  const walk = (srcP, destP) => {
    if (++count > 20000) throw new Error('文件数量超过上限（20000），已中止')
    if (!fs.existsSync(destP)) fs.mkdirSync(destP, { recursive: true })
    const entries = fs.readdirSync(srcP, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(srcP, entry.name)
      const destPath = path.join(destP, entry.name)
      if (entry.isDirectory()) {
        walk(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }
  walk(src, dest)
}

// 生成空白 Office 文件(docx/xlsx/pptx)
async function createOfficeFile(filePath, fileType) {
  if (!JSZip) throw new Error('jszip 不可用')
  const zip = new JSZip()
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="'
  if (fileType === 'docx') {
    zip.file('[Content_Types].xml', ct + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    zip.folder('_rels').file('.rels', rels + 'word/document.xml"/></Relationships>')
    zip.folder('word').file('document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>')
  } else if (fileType === 'xlsx') {
    zip.file('[Content_Types].xml', ct + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
    zip.folder('_rels').file('.rels', rels + 'xl/workbook.xml"/></Relationships>')
    zip.folder('xl').file('workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
    zip.folder('xl').folder('_rels').file('workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    zip.folder('xl').folder('worksheets').file('sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>')
  } else if (fileType === 'pptx') {
    zip.file('[Content_Types].xml', ct + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>')
    zip.folder('_rels').file('.rels', rels + 'ppt/presentation.xml"/></Relationships>')
    zip.folder('ppt').file('presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>')
    zip.folder('ppt').folder('_rels').file('presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>')
    zip.folder('ppt').folder('slides').file('slide1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>')
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(filePath, buffer)
}

class TCPAgent extends EventEmitter {
  constructor(authManager, options = {}) {
    super()
    this.authManager = authManager
    // 互联网传输每日限额钩子（main.js 注入）：{ take(n)→bool 扣减并判断是否超额, add(n) 只累计（收向） }
    this.netQuota = (options && options.netQuota) || null
    this.server = null
    this.connections = new Map()
    this.pendingSockets = new Map() // 2.0：已连接但未通过配对码验证的设备（deviceId -> socket）
    this.transfers = new Map()
    this.pendingRequests = new Map()
    this._reqSeq = 0
    this.deviceId = this.generateDeviceId()
    // 信任表绑定本机 id：清掉旧版本 bug 写入的"自己"，并杜绝再次写入
    if (this.authManager && this.authManager.setOwnDeviceId) {
      this.authManager.setOwnDeviceId(this.deviceId)
    }
    this.isRunning = false
    this.heartbeatTimer = null
    this.deviceName = null // 自定义设备名（可选）
  }

  // 设置自定义设备名，并重新向所有已连接设备广播 hello
  setDeviceName(name) {
    this.deviceName = name || null
    this.broadcastHello()
  }

  // 向所有已连接设备重新发送 hello（携带最新设备信息）
  broadcastHello() {
    for (const socket of this.connections.values()) {
      try { this.sendHello(socket) } catch {}
    }
  }

  generateDeviceId() {
    const hostname = os.hostname()
    const interfaces = os.networkInterfaces()
    let mac = '00:00:00:00:00:00'
    for (const [, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
          mac = addr.mac
          break
        }
      }
      if (mac !== '00:00:00:00:00:00') break
    }
    // MSC_DEVICE_ID 仅用于同机多开测试；默认空串，哈希与旧版本完全一致，不影响现有配对
    return crypto.createHash('sha256').update(`${hostname}-${mac}-${process.env.MSC_DEVICE_ID || ''}`).digest('hex').slice(0, 12)
  }

  getDeviceInfo() {
    const interfaces = os.networkInterfaces()
    let localIP = '127.0.0.1'
    for (const [, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localIP = addr.address
          break
        }
      }
    }
    return {
      deviceId: this.deviceId,
      hostname: os.hostname(),
      name: this.deviceName || os.hostname(),
      ip: localIP,
      platform: os.platform(),
      version: '1.0.0',
      // 应用版本：旧版不认识此字段会忽略；收到空/缺失 appVersion 即判定为旧版
      appVersion: (() => {
        try { return require('electron').app.getVersion() } catch {}
        try { return require('../package.json').version } catch {}
        return ''
      })(),
      // 2.0 新增：携带全局 IPv6 地址供对方记忆（1.0 收到后忽略未知字段，完全兼容）
      ipv6: (() => {
        try { return require('./ipv6Invite').getGlobalIPv6Addresses() } catch { return [] }
      })()
    }
  }

  start(port) {
    if (this.isRunning) return
    this.isRunning = true

    this.server = net.createServer((socket) => {
      socket.setNoDelay(true)
      socket.setKeepAlive(true, 5000)
      socket._buffer = Buffer.alloc(0)
      socket._connected = false
      socket._role = 'inbound' // 被动方：对方发起的连接
      if (isPublicIP(socket.remoteAddress)) socket._viaNet = true // 公网入站 = 互联网传输，计入每日额度

      socket.on('data', (data) => {
        if (socket._viaNet && this.netQuota) this.netQuota.add(data.length) // 收向流量累计
        socket._buffer = Buffer.concat([socket._buffer, data])
        this.drainBuffer(socket)
      })

      socket.on('close', () => {
        this.handleDisconnect(socket)
      })

      socket.on('error', (err) => {
        this.emit('log', `Socket 错误: ${err.message}`)
        this.handleDisconnect(socket)
      })

      this.sendHello(socket)
    })

    this.server.listen(port || TCP_PORT, '0.0.0.0', () => {
      this.emit('log', `TCP 服务已启动，端口: ${port || TCP_PORT}`)
    })

    this.server.on('error', (err) => {
      this.emit('log', `TCP 服务错误: ${err.message}`)
      if (err.code === 'EADDRINUSE') {
        this.emit('log', `端口 ${port || TCP_PORT} 被占用，请关闭占用程序后重试`)
      } else if (err.code === 'EPERM' || err.code === 'EACCES') {
        this.emit('log', `无法绑定端口，可能被防火墙阻止。请在 Windows 防火墙中允许本应用通过`)
        this.emit('firewall-warning')
      }
    })

    // 启动心跳保活
    this.startHeartbeat()
  }

  stop() {
    this.isRunning = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    for (const [, socket] of this.connections) {
      socket.destroy()
    }
    this.connections.clear()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  // 心跳保活：每5秒发送 ping，检测 pong 超时（15秒无响应则断开）
  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      for (const [deviceId, socket] of this.connections) {
        if (socket._connected && !socket.destroyed) {
          // 检测 pong 超时
          if (socket._lastPongTime && (now - socket._lastPongTime) > 15000) {
            this.emit('log', `心跳超时，设备 ${deviceId} 无响应，断开连接`)
            try { socket.destroy() } catch {}
            this.handleDisconnect(socket)
            continue
          }
          try {
            this.sendMsg(socket, 'ping', {})
          } catch {
            // socket 可能已断开
          }
        }
      }
    }, 5000)
  }

  drainBuffer(socket) {
    let buf = socket._buffer
    let offset = 0

    while (offset < buf.length) {
      const sepIdx = buf.indexOf('\n', offset)
      if (sepIdx === -1) break

      const headerStr = buf.slice(offset, sepIdx).toString('utf-8')
      const colonIdx = headerStr.indexOf(':')

      let msgLen = 0
      let msgType = ''

      if (colonIdx !== -1) {
        msgLen = parseInt(headerStr.slice(0, colonIdx), 10)
        msgType = headerStr.slice(colonIdx + 1)
      } else {
        msgLen = parseInt(headerStr, 10)
      }

      if (isNaN(msgLen) || msgLen < 0) {
        offset = sepIdx + 1
        continue
      }

      const totalLen = sepIdx + 1 + msgLen
      if (buf.length < totalLen) break

      const payload = buf.slice(sepIdx + 1, totalLen)
      offset = totalLen

      if (msgType === 'chunk') {
        if (payload.length < 4) continue
        const metaLen = payload.readUInt32BE(0)
        const metaJson = payload.slice(4, 4 + metaLen).toString('utf-8')
        const chunkData = payload.slice(4 + metaLen)

        try {
          const meta = JSON.parse(metaJson)
          const message = {
            type: 'file-transfer-chunk',
            _requestId: meta.transferId,
            _rawChunk: chunkData
          }
          this.processMessage(socket, message)
        } catch (err) {
          this.emit('log', `块消息解析错误: ${err.message}`)
        }
      } else {
        try {
          const message = JSON.parse(payload.toString('utf-8'))
          message._typeHint = msgType
          this.processMessage(socket, message)
        } catch (err) {
          this.emit('log', `消息解析错误: ${err.message}`)
        }
      }
    }

    socket._buffer = buf.slice(offset)
  }

  processMessage(socket, message) {
    const type = message.type

    // 2.0：未通过配对码验证的连接，只放行握手/心跳/配对消息，业务消息一律拒绝
    if (socket._unverified) {
      const allowed = ['hello', 'hello-ack', 'ping', 'pong', 'pair-verify-code', 'pair-verify-result', 'pair-request', 'pair-response']
      if (!allowed.includes(type)) {
        this.emit('log', `未完成配对的设备尝试 ${type}，已拒绝`)
        return
      }
    }

    switch (type) {
      case 'hello':
        this.handleHello(socket, message.data)
        break

      case 'hello-ack':
        this.handleHelloAck(socket, message.data)
        break

      case 'ping':
        this.sendMsg(socket, 'pong', {})
        break

      case 'pong':
        socket._lastPongTime = Date.now()
        break

      case 'file-list-request':
        this.onFileListRequest(socket, message)
        break

      case 'file-list-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-download-request':
        this.onFileDownloadRequest(socket, message)
        break

      case 'file-download-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-upload-request':
        this.onFileUploadRequest(socket, message)
        break

      case 'file-upload-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-transfer-chunk':
        this.onTransferChunk(message)
        break

      case 'file-transfer-complete':
        this.onTransferComplete(message.data)
        break

      case 'file-transfer-complete-ack':
        this.emit('transfer-ack', message.data)
        break

      case 'file-transfer-error':
        this.onTransferError(message.data)
        break

      case 'file-delete-request':
        this.onFileDeleteRequest(socket, message)
        break

      case 'file-delete-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-mkdir-request':
        this.onFileMkdirRequest(socket, message)
        break

      case 'file-mkdir-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-create-request':
        this.onFileCreateRequest(socket, message)
        break

      case 'file-create-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'disk-space-request':
        this.onDiskSpaceRequest(socket, message)
        break

      case 'disk-space-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-copy-request':
        this.onFileCopyRequest(socket, message)
        break

      case 'file-copy-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-move-request':
        this.onFileMoveRequest(socket, message)
        break

      case 'file-move-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'folder-scan-request':
        this.onFolderScanRequest(socket, message)
        break

      case 'folder-scan-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'file-rename-request':
        this.onFileRenameRequest(socket, message)
        break

      case 'file-rename-response':
        this.resolvePending(message.requestId, message.data)
        break

      case 'pair-request':
        this.onPairRequest(socket, message)
        break

      case 'pair-response':
        this.onPairResponse(message.data)
        break

      case 'pair-verify-code':
        this.onPairVerifyCode(socket, message)
        break

      case 'pair-verify-result':
        this.resolvePending(message.requestId, message.data)
        break

      // 对讲机（PTT）：音频流转发
      case 'audio-start':
        this.emit('ptt-start', { deviceId: socket._deviceId, sampleRate: message.data?.sampleRate || 48000 })
        break

      case 'audio-chunk':
        this.emit('ptt-audio', { deviceId: socket._deviceId, b64: message.data?.b64 })
        break

      case 'audio-end':
        this.emit('ptt-end', { deviceId: socket._deviceId })
        break

      default:
        this.emit('log', `未知消息类型: ${type}`)
    }
  }

  handleHello(socket, data) {
    const isV2 = Array.isArray(data.ipv6)

    // 自连拦截：设备列表混入本机（如中转在线列表回显）被误点/自动重连时，绝不能和自己配对
    if (!data.deviceId || data.deviceId === this.deviceId) {
      this.emit('log', `[安全] 拦截自连/无效连接 (deviceId=${data.deviceId || '空'}, ip=${socket.remoteAddress || '?'})`)
      try { socket.destroy() } catch {}
      return
    }

    const trusted = this.authManager.isDeviceTrusted(data.deviceId)

    // 清理同设备的旧 pending 连接（未完成配对就被新连接取代）
    const pendingOld = this.pendingSockets.get(data.deviceId)
    if (pendingOld && pendingOld !== socket) {
      pendingOld._deviceId = null
      try { pendingOld.destroy() } catch {}
      this.pendingSockets.delete(data.deviceId)
    }

    socket._deviceInfo = data
    socket._deviceId = data.deviceId
    socket._connected = true
    socket._lastPongTime = Date.now()

    if (!trusted) {
      if (isV2) {
        // 2.0 设备：配对码验证通过前不激活连接（业务消息全部拦截）
        socket._unverified = true
        this.pendingSockets.set(data.deviceId, socket)
        // 被动方（接收方）：局域网生成配对码并通知 UI（发起方看得到本机屏幕）；
        // 远程（公网/桥接，_viaNet/_viaRelay）看不到彼此屏幕 → 不发码，等 onPairRequest 弹「同意/拒绝」审批
        if (socket._role !== 'outbound') {
          const remote = !!(socket._viaNet || socket._viaRelay)
          const pairCode = remote ? '' : this.authManager.generatePairCode()
          if (!remote) {
            this.emit('incoming-pair-request', {
              deviceId: data.deviceId,
              deviceInfo: data,
              pairCode,
              isV2: true
            })
          }
        }
        // 5 分钟未完成配对 → 断开
        clearTimeout(socket._pairTimeout)
        socket._pairTimeout = setTimeout(() => {
          if (socket._unverified) {
            this.emit('log', `${data.hostname} 配对超时（5 分钟），连接已断开`)
            try { socket.destroy() } catch {}
          }
        }, 5 * 60 * 1000)
      } else {
        // 1.0 旧版本设备：无配对能力，自动信任（保持旧版互通行为）
        this.authManager.addTrustedDevice(data.deviceId, data)
      }
    }

    if (!socket._unverified) {
      if (!isV2) {
        // 1.0 旧版：无配对能力，保持旧版直连行为
        this.activateConnection(socket, data)
      }
      // 2.0：即使本机已信任对方，也要等对方 hello-ack 确认"对方也信任本机"后才激活，
      // 防止单向信任时本方假连接（UI 显示已连接但业务消息全被对方拦截）
    }

    // 无论是否激活都回 ack：发起方靠 trusted 字段决定是否弹出输码框
    const ack = {
      ...this.getDeviceInfo(),
      trusted: this.authManager.isDeviceTrusted(data.deviceId)
    }
    this.sendMsg(socket, 'hello-ack', ack)
  }

  handleHelloAck(socket, data) {
    const isV2 = Array.isArray(data.ipv6)
    // 自连拦截（ack 侧）：正常 ack 描述的是对方；若竟返回本机信息，说明对端旧版本回显了我们的 hello
    // （或回环自连）。绝不能把"自己的 ID/IPv6"当对方学习/注册，否则设备表会被自己污染
    if (!data.deviceId || data.deviceId === this.deviceId) {
      this.emit('log', `[安全] 拦截异常 hello-ack (deviceId=${data.deviceId || '空'})——疑似旧版本回显或自连`)
      try { socket.destroy() } catch {}
      return
    }
    // 记录对端真实设备信息（ack 描述的是对方自己）——后续配对/激活一律以此为准
    if (data.deviceId) socket._deviceInfo = { ...data }

    // 对方是 2.0 且尚未信任本机、且本机是发起方 → 弹配对 UI：
    // 局域网 = 输对方屏幕上的配对码；远程（_viaNet/_viaRelay）= 发 pair-request 触发对方屏幕「同意/拒绝」
    if (data.trusted === false && isV2 && socket._role === 'outbound') {
      socket._unverified = true
      if (data.deviceId) this.pendingSockets.set(data.deviceId, socket)
      clearTimeout(socket._pairTimeout)
      socket._pairTimeout = setTimeout(() => {
        if (socket._unverified) {
          try { socket.destroy() } catch {}
        }
      }, 5 * 60 * 1000)
      const remote = !!(socket._viaNet || socket._viaRelay)
      this.emit('pair:required', {
        deviceId: data.deviceId,
        deviceInfo: data,
        isV2: true,
        remote
      })
      if (remote) {
        // 远程审批：等待对方在自己屏幕点「同意」→ 对方回 pair-verify-result(success) 激活本端
        this.sendWithResponse(socket, 'pair-request', { deviceId: this.deviceId }, 5 * 60 * 1000).then((res) => {
          if (res && res.success) {
            const peerInfo = socket._deviceInfo
              ? { ...socket._deviceInfo, deviceId: data.deviceId }
              : { deviceId: data.deviceId, hostname: '远程设备' }
            this.authManager.addTrustedDevice(data.deviceId, peerInfo)
            this.activateConnection(socket, peerInfo)
          } else {
            this.emit('log', `远程配对未通过: ${(res && res.error) || '对方拒绝或超时'}`)
            this.emit('pair:decision', { deviceId: data.deviceId, accepted: false, reason: (res && res.error) || 'rejected' })
            try { socket.destroy() } catch {}
          }
        }).catch(() => {
          this.emit('pair:decision', { deviceId: data.deviceId, accepted: false, reason: 'timeout' })
        })
      }
    }

    // 更新信任列表中的设备信息（改名等）
    if (data.trusted && data.deviceId) {
      this.authManager.updateDeviceInfo(data.deviceId, data)
    }

    // 双方互信（重连场景：本机信任对方，且对方 ack 确认也信任本机）→ 激活
    // data.trusted 仅 2.0 设备携带；1.0 无此字段（undefined）视为信任，保持旧版互通
    if (!socket._unverified && data.deviceId && data.trusted !== false && this.authManager.isDeviceTrusted(data.deviceId)) {
      this.activateConnection(socket, data)
    }

    // 2.0：发起方从 hello-ack 学习对方的 IPv6 地址（接收方在 handleHello 学习）
    if (data.deviceId && Array.isArray(data.ipv6)) {
      this.emit('peer-learned', { deviceId: data.deviceId, name: data.name, ipv6: data.ipv6 })
    }
  }

  // 激活连接：注册到连接表、通知 UI（未通过配对验证前不调用）
  activateConnection(socket, data) {
    // 最后一道防线：自己绝不能进连接表
    if (!data || !data.deviceId || data.deviceId === this.deviceId) {
      this.emit('log', `[安全] activateConnection 拦截自连/无效条目 (deviceId=${data && data.deviceId || '空'})`)
      try { socket.destroy() } catch {}
      return
    }
    socket._unverified = false
    clearTimeout(socket._pairTimeout)
    // 清理同设备的旧连接，避免重连后出现多个 socket 导致状态不同步
    const oldSocket = this.connections.get(data.deviceId)
    if (oldSocket && oldSocket !== socket) {
      oldSocket._deviceId = null  // 防止 close 事件重复触发 handleDisconnect
      try { oldSocket.destroy() } catch {}
      this.connections.delete(data.deviceId)
      this.emit('log', `清理 ${data.hostname} 的旧连接`)
    }
    this.pendingSockets.delete(data.deviceId)
    socket._deviceId = data.deviceId
    this.connections.set(data.deviceId, socket)

    this.emit('log', `${data.hostname}(${data.ip}) 已连接`)
    this.emit('peer-learned', { deviceId: data.deviceId, name: data.name || data.hostname, ipv6: Array.isArray(data.ipv6) ? data.ipv6 : [] })
    this.emit('connection-status', {
      status: 'connected',
      deviceId: data.deviceId,
      deviceInfo: data
    })
  }

  sendHello(socket) {
    this.sendMsg(socket, 'hello', this.getDeviceInfo())
  }

  // === 对讲机（PTT）发送 ===
  sendPTTStart(deviceId, sampleRate) {
    const socket = this.connections.get(deviceId)
    if (!socket || !socket._connected) return false
    this.sendMsg(socket, 'audio-start', { sampleRate })
    return true
  }

  sendPTTChunk(deviceId, b64) {
    const socket = this.connections.get(deviceId)
    if (!socket || !socket._connected) return false
    this.sendMsg(socket, 'audio-chunk', { b64 })
    return true
  }

  sendPTTEnd(deviceId) {
    const socket = this.connections.get(deviceId)
    if (!socket || !socket._connected) return false
    this.sendMsg(socket, 'audio-end', {})
    return true
  }

  // 互联网传输每日限额：公网/桥接连接发送前扣减额度，超额断开并通知一次
  _netQuotaGate(socket, bytes) {
    if (!socket._viaNet || !this.netQuota) return true
    if (this.netQuota.take(bytes)) return true
    if (!socket._netQuotaHit) {
      socket._netQuotaHit = true
      this.emit('net-quota-exceeded')
      this.emit('log', '互联网传输今日额度已用完，连接已断开（明日自动恢复）')
    }
    try { socket.destroy() } catch { }
    return false
  }

  sendMsg(socket, type, data, requestId) {
    try {
      const payload = JSON.stringify({ type, data, ...(requestId ? { requestId } : {}) })
      const msgBuf = Buffer.from(payload, 'utf-8')
      const header = Buffer.from(`${msgBuf.length}:${type}\n`, 'utf-8')
      if (!this._netQuotaGate(socket, header.length + msgBuf.length)) return false
      socket.write(Buffer.concat([header, msgBuf]))
    } catch (err) {
      this.emit('log', `发送消息错误: ${err.message}`)
    }
  }

  sendMsgRaw(socket, type, payloadBuf, transferId) {
    try {
      if (type === 'file-transfer-chunk' && transferId) {
        const meta = JSON.stringify({ transferId })
        const metaBuf = Buffer.from(meta, 'utf-8')
        const metaLen = Buffer.alloc(4)
        metaLen.writeUInt32BE(metaBuf.length, 0)
        const combined = Buffer.concat([metaLen, metaBuf, payloadBuf])
        const header = Buffer.from(`${combined.length}:chunk\n`, 'utf-8')
        if (!this._netQuotaGate(socket, header.length + combined.length)) return false
        return socket.write(Buffer.concat([header, combined]))
      } else {
        const header = Buffer.from(`${payloadBuf.length}:${type}\n`, 'utf-8')
        if (!this._netQuotaGate(socket, header.length + payloadBuf.length)) return false
        return socket.write(Buffer.concat([header, payloadBuf]))
      }
    } catch (err) {
      this.emit('log', `发送原始数据错误: ${err.message}`)
      return false
    }
  }

  registerPending(requestId, timeoutMs = REQUEST_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('请求超时'))
      }, timeoutMs)

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timer
      })
    })
  }

  // 2.0：通用请求-响应（发送消息并等待对方带 requestId 的响应）
  sendWithResponse(socket, type, data, timeoutMs = REQUEST_TIMEOUT) {
    const requestId = `req_${Date.now()}_${++this._reqSeq}`
    const promise = this.registerPending(requestId, timeoutMs)
    this.sendMsg(socket, type, data, requestId)
    return promise
  }

  resolvePending(requestId, data) {
    const pending = this.pendingRequests.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingRequests.delete(requestId)
      pending.resolve(data)
    }
  }

  rejectPending(requestId, error) {
    const pending = this.pendingRequests.get(requestId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingRequests.delete(requestId)
      pending.reject(error)
    }
  }

  // === File List ===
  async onFileListRequest(socket, message) {
    const { path: targetPath } = message.data
    const requestId = message.requestId
    
    try {
      // 请求根目录或盘符列表
      if (!targetPath || targetPath === 'root' || targetPath === 'This PC') {
        const drives = this.listDrives()
        this.sendMsg(socket, 'file-list-response', { 
          success: true, 
          path: 'root', 
          entries: drives 
        }, requestId)
        return
      }
      
      // 请求普通目录
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
      this.sendMsg(socket, 'file-list-response', { success: true, path: targetPath, entries: result }, requestId)
    } catch (err) {
      this.sendMsg(socket, 'file-list-response', { success: false, error: err.message, path: targetPath, entries: [] }, requestId)
    }
  }
  
  // 列出本地所有盘符
  listDrives() {
    const entries = []
    // 桌面快捷入口（盘符同级）
    const desktopPath = getDesktopPath()
    if (desktopPath) {
      entries.push({
        name: '桌面',
        path: desktopPath,
        isDirectory: true,
        isDesktop: true,
        size: 0,
        modifiedTime: 0
      })
    }

    if (os.platform() !== 'win32') {
      // 非 Windows 系统，返回根目录
      try {
        const list = fs.readdirSync('/', { withFileTypes: true })
        for (const entry of list) {
          entries.push({
            name: entry.name,
            path: path.join('/', entry.name),
            isDirectory: entry.isDirectory(),
            size: 0,
            modifiedTime: 0
          })
        }
      } catch {}
      return entries
    }

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
      } catch {
        // 跳过不存在的盘符
      }
    }
    return entries
  }

  // === File Download (server side = sending file) ===
  async onFileDownloadRequest(socket, message) {
    const { remotePath, transferId, offset } = message.data
    const requestId = message.requestId

    try {
      const stats = fs.statSync(remotePath)
      if (!stats.isFile()) {
        this.sendMsg(socket, 'file-download-response', { success: false, error: '不是文件' }, requestId)
        return
      }

      const requested = offset || 0
      // 本地残留比远程文件大（同名不同内容/远程已变更）→ 从头重传，避免只收到尾部数据
      const restart = requested > stats.size
      // 已完整 → 不流，客户端按 offset>=fileSize 判定完成
      const alreadyComplete = requested === stats.size && requested > 0
      const startOffset = restart ? 0 : Math.min(requested, stats.size)

      this.sendMsg(socket, 'file-download-response', {
        success: true, fileName: path.basename(remotePath), fileSize: stats.size, offset: startOffset, restart, alreadyComplete
      }, requestId)

      if (alreadyComplete) {
        this.sendMsg(socket, 'file-transfer-complete', { transferId, size: stats.size })
        return
      }

      const readStream = fs.createReadStream(remotePath, { highWaterMark: BUFFER_SIZE, start: startOffset })
      let sent = startOffset
      let paused = false

      readStream.on('data', (chunk) => {
        const ok = this.sendMsgRaw(socket, 'file-transfer-chunk', chunk, transferId)
        sent += chunk.length
        const progress = Math.round((sent / stats.size) * 100)
        this.emit('file-transfer-progress', {
          transferId, direction: 'download',
          fileName: path.basename(remotePath),
          sent, total: stats.size, progress, incoming: false
        })
        if (!ok && !paused) {
          paused = true
          readStream.pause()
          socket.once('drain', () => {
            paused = false
            readStream.resume()
          })
        }
      })

      readStream.on('end', () => {
        this.sendMsg(socket, 'file-transfer-complete', {
          transferId, size: stats.size
        })
      })

      readStream.on('error', (err) => {
        this.sendMsg(socket, 'file-transfer-error', {
          transferId, error: err.message
        })
      })
    } catch (err) {
      this.sendMsg(socket, 'file-download-response', { success: false, error: err.message }, requestId)
    }
  }

  // === File Upload (server side = receiving file) ===
  async onFileUploadRequest(socket, message) {
    const { localPath, remoteDir, transferId, fileName, fileSize, overwrite } = message.data
    const requestId = message.requestId
    const destPath = path.join(remoteDir, fileName)

    // 相对路径防御：真机实锤——发送方把"桌面"这类列表显示名当 dest_dir 传过来，
    // path.join 后成相对路径 → 写盘 ENOENT → writeStream error 无监听 → 主进程闪退。
    // 直接回失败让发送方改用完整路径重试，绝不杀自己进程
    if (!path.isAbsolute(destPath)) {
      this.sendMsg(socket, 'file-upload-response', { success: false, error: `目标目录 "${remoteDir}" 不是完整路径，请传对方磁盘上的绝对路径（如 C:\\Users\\<用户名>\\Desktop）` }, requestId)
      return
    }
    // 目录不存在时自动创建（新装系统/自定义目录场景保底），创建失败也回失败不崩
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
    } catch (err) {
      this.sendMsg(socket, 'file-upload-response', { success: false, error: `目标目录创建失败: ${err.message}` }, requestId)
      return
    }

    // 断点续传：检查远程是否已有部分文件（overwrite=true 时跳过）
    let offset = 0
    if (!overwrite) {
      try {
        const remoteStats = fs.statSync(destPath)
        if (remoteStats.isFile() && remoteStats.size > 0 && remoteStats.size < fileSize) {
          offset = remoteStats.size
        }
      } catch {
        // 文件不存在，offset = 0
      }
    }

    const transfer = {
      type: 'server-receive',
      transferId,
      destPath,
      fileSize,
      received: offset,
      chunks: [],
      writeStream: null,
      status: 'receiving',
      offset,
      overwrite: overwrite === true,
      socket
    }
    this.transfers.set(transferId, transfer)
    this._armReceiveStall(transfer)

    this.sendMsg(socket, 'file-upload-response', {
      success: true, destPath, offset
    }, requestId)
  }

  // 接收中断流保护：（重新）武装定时器。发送方进程暴毙/旧版 bug 中途掐流时分片会永远停，
  // 写入句柄不关 → 文件被系统锁死"点不开"+ transfers 条目泄漏。
  // 收不到任何新分片持续 60 秒（MSC_RECEIVE_STALL_MS 可调，测试用）即关流解锁：
  // 已收到的分片保留（重传走断点续传），并回报发送方失败
  _armReceiveStall(transfer) {
    if (!transfer || transfer.type !== 'server-receive') return
    const stallMs = parseInt(process.env.MSC_RECEIVE_STALL_MS || '60000', 10)
    clearTimeout(transfer.stallTimer)
    transfer.stallTimer = setTimeout(() => {
      if (this.transfers.get(transfer.transferId) !== transfer) return
      this.transfers.delete(transfer.transferId)
      const logClosed = () => this.emit('log', `[接收] ${path.basename(transfer.destPath)} 传输中断（${Math.round(stallMs / 1000)} 秒无数据），已关闭写入并解锁文件，文件可能不完整`)
      if (transfer.writeStream && !transfer.writeStream.destroyed) {
        transfer.writeStream.end(logClosed)
      } else {
        logClosed()
      }
      try { this.sendMsg(transfer.socket, 'file-transfer-error', { transferId: transfer.transferId, error: '对方传输中断（长时间无数据），文件可能不完整' }) } catch {}
    }, stallMs)
  }

  _clearReceiveStall(transfer) {
    if (transfer && transfer.stallTimer) {
      clearTimeout(transfer.stallTimer)
      transfer.stallTimer = null
    }
  }

  onTransferChunk(data) {
    const transferId = data._requestId
    const chunkData = data._rawChunk

    if (!transferId) return

    const transfer = this.transfers.get(transferId)
    if (!transfer) return

    if (transfer.type === 'server-receive') {
      if (!transfer.writeStream) {
        // 断点续传用追加模式
        const streamOpts = transfer.offset > 0 ? { flags: 'a' } : {}
        transfer.writeStream = fs.createWriteStream(transfer.destPath, streamOpts)
        // 写盘异常（磁盘满/权限/设备拔出）只终止本次传输回错误，绝不冒 uncaughtException 杀进程
        transfer.writeStream.on('error', (err) => {
          this.emit('log', `[接收] 写盘失败 ${transfer.destPath}: ${err.message}`)
          try {
            this.sendMsg(transfer.socket, 'file-transfer-error', { transferId, error: `对方写盘失败: ${err.message}` })
          } catch {}
          this._clearReceiveStall(transfer)
          try { transfer.writeStream.destroy() } catch {}
          this.transfers.delete(transferId)
        })
      }
      this._armReceiveStall(transfer)
      transfer.writeStream.write(chunkData)
      transfer.received += chunkData.length

      const progress = transfer.fileSize
        ? Math.round((transfer.received / transfer.fileSize) * 100)
        : 0

      this.emit('file-transfer-progress', {
        transferId, direction: 'upload',
        fileName: path.basename(transfer.destPath),
        sent: transfer.received, total: transfer.fileSize, progress, incoming: true
      })
    } else if (transfer.type === 'client-download') {
      if (transfer.writeStream) {
        transfer.writeStream.write(chunkData)
      }
      transfer.received += chunkData.length
      const progress = Math.round((transfer.received / transfer.totalSize) * 100)
      this.emit('file-transfer-progress', {
        transferId, direction: 'download',
        fileName: transfer.fileName,
        sent: transfer.received, total: transfer.totalSize, progress, incoming: false
      })
    }
  }

  onTransferComplete(data) {
    const transferId = data.transferId
    const transfer = this.transfers.get(transferId)
    if (!transfer) return

    if (transfer.type === 'server-receive') {
      // 等待文件写入磁盘完毕后再通知发送方，避免发送方刷新时文件尚未落盘
      this._clearReceiveStall(transfer)
      const finishUpload = () => {
        if (transfer.socket) {
          this.sendMsg(transfer.socket, 'file-transfer-complete-ack', { transferId, success: true })
        }
        this.emit('file-transfer-complete', {
          transferId, direction: 'upload',
          path: transfer.destPath, size: transfer.fileSize,
          isEdit: transfer.overwrite === true, incoming: true,
          deviceId: transfer.socket ? transfer.socket._deviceId : null
        })
        this.transfers.delete(transferId)
      }
      if (transfer.writeStream) {
        transfer.writeStream.end(finishUpload)
      } else {
        finishUpload()
      }
      return
    } else if (transfer.type === 'client-download') {
      if (transfer.writeStream) {
        transfer.writeStream.end()
      }
      this.emit('file-transfer-complete', {
        transferId, direction: 'download',
        path: transfer.localPath, size: transfer.totalSize, incoming: false,
        deviceId: transfer.socket ? transfer.socket._deviceId : null
      })
    }
    this.transfers.delete(transferId)
  }

  onTransferError(data) {
    this.emit('file-transfer-error', data)
    if (data.transferId) {
      this._clearReceiveStall(this.transfers.get(data.transferId))
      this.transfers.delete(data.transferId)
    }
  }

  // === File Operations ===
  async onFileDeleteRequest(socket, message) {
    const { filePath } = message.data
    const requestId = message.requestId
    try {
      const stat = fs.statSync(filePath)
      const isDirectory = stat.isDirectory()
      if (isDirectory) {
        fs.rmSync(filePath, { recursive: true, force: true })
      } else {
        fs.unlinkSync(filePath)
      }
      this.sendMsg(socket, 'file-delete-response', { success: true }, requestId)
      // 通知本机：对方删除了本机文件，需刷新本地列表
      this.emit('file-deleted', { filePath, isDirectory, direction: 'incoming', deviceId: socket._deviceId })
    } catch (err) {
      this.sendMsg(socket, 'file-delete-response', { success: false, error: err.message }, requestId)
    }
  }

  async onFileMkdirRequest(socket, message) {
    const { folderPath } = message.data
    const requestId = message.requestId
    try {
      fs.mkdirSync(folderPath, { recursive: true })
      this.sendMsg(socket, 'file-mkdir-response', { success: true }, requestId)
      this.emit('file-created', { filePath: folderPath, fileType: 'folder', direction: 'incoming', deviceId: socket._deviceId })
    } catch (err) {
      this.sendMsg(socket, 'file-mkdir-response', { success: false, error: err.message }, requestId)
    }
  }

  async onFileCreateRequest(socket, message) {
    const { filePath, fileType } = message.data
    const requestId = message.requestId
    try {
      if (fileType === 'txt') {
        fs.writeFileSync(filePath, '')
      } else {
        await createOfficeFile(filePath, fileType)
      }
      this.sendMsg(socket, 'file-create-response', { success: true }, requestId)
      this.emit('file-created', { filePath, fileType, direction: 'incoming', deviceId: socket._deviceId })
    } catch (err) {
      this.sendMsg(socket, 'file-create-response', { success: false, error: err.message }, requestId)
    }
  }

  // 磁盘空间查询（服务端）
  async onDiskSpaceRequest(socket, message) {
    const { path: targetPath } = message.data
    const requestId = message.requestId
    try {
      const { total, used, free } = getDiskSpace(targetPath)
      this.sendMsg(socket, 'disk-space-response', { success: true, total, used, free }, requestId)
    } catch (err) {
      this.sendMsg(socket, 'disk-space-response', { success: false, error: err.message }, requestId)
    }
  }

  // 文件复制（服务端）
  async onFileCopyRequest(socket, message) {
    const { srcPath, destDir } = message.data
    const requestId = message.requestId
    try {
      const fileName = path.basename(srcPath)
      const destPath = path.join(destDir, fileName)
      const stats = fs.statSync(srcPath)
      if (stats.isDirectory()) {
        copyFolderRecursiveSync(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
      this.sendMsg(socket, 'file-copy-response', { success: true, destPath }, requestId)
      this.emit('file-created', { filePath: destPath, fileType: stats.isDirectory() ? 'folder' : 'file', direction: 'incoming', deviceId: socket._deviceId })
    } catch (err) {
      this.sendMsg(socket, 'file-copy-response', { success: false, error: err.message }, requestId)
    }
  }

  // 文件移动（服务端）
  async onFileMoveRequest(socket, message) {
    const { srcPath, destDir } = message.data
    const requestId = message.requestId
    try {
      const fileName = path.basename(srcPath)
      const destPath = path.join(destDir, fileName)
      // 防自包含：同位或移入自身内部直接拒绝
      const norm = (x) => path.normalize(String(x)).toLowerCase().replace(/[\\/]+$/, '')
      const sN = norm(srcPath)
      const dN = norm(destPath)
      if (sN === dN) throw new Error('源和目标是同一位置')
      if (dN.startsWith(sN + path.sep)) throw new Error('不能把文件夹移动到它自己的内部')
      // 同盘直接 rename，跨盘 copy + delete
      try {
        fs.renameSync(srcPath, destPath)
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
          const stats = fs.statSync(srcPath)
          if (stats.isDirectory()) {
            copyFolderRecursiveSync(srcPath, destPath)
            fs.rmSync(srcPath, { recursive: true, force: true })
          } else {
            fs.copyFileSync(srcPath, destPath)
            fs.unlinkSync(srcPath)
          }
        } else {
          throw renameErr
        }
      }
      this.sendMsg(socket, 'file-move-response', { success: true, destPath }, requestId)
      this.emit('file-created', { filePath: destPath, fileType: 'move', direction: 'incoming', deviceId: socket._deviceId })
    } catch (err) {
      this.sendMsg(socket, 'file-move-response', { success: false, error: err.message }, requestId)
    }
  }

  // === 客户端方法：查询远程磁盘空间 ===
  async getRemoteDiskSpace(deviceId, targetPath) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId)
    this.sendMsg(socket, 'disk-space-request', { path: targetPath }, requestId)

    try {
      const data = await pending
      if (data.success) {
        return { total: data.total, used: data.used, free: data.free }
      }
      return null
    } catch {
      return null
    }
  }

  // === 客户端方法：远程复制 ===
  async copyRemoteFile(deviceId, srcPath, destDir) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId, REQUEST_TIMEOUT * 10)
    this.sendMsg(socket, 'file-copy-request', { srcPath, destDir }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // === 客户端方法：远程移动 ===
  async moveRemoteFile(deviceId, srcPath, destDir) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId, REQUEST_TIMEOUT * 10)
    this.sendMsg(socket, 'file-move-request', { srcPath, destDir }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // 递归扫描文件夹结构
  async onFolderScanRequest(socket, message) {
    const { path: folderPath } = message.data
    const requestId = message.requestId
    try {
      const entries = this.scanFolderRecursive(folderPath)
      this.sendMsg(socket, 'folder-scan-response', { success: true, entries }, requestId)
    } catch (err) {
      this.sendMsg(socket, 'folder-scan-response', { success: false, error: err.message, entries: [] }, requestId)
    }
  }

  scanFolderRecursive(folderPath) {
    const results = []
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(folderPath, entry.name)
        const relativePath = path.relative(folderPath, fullPath)
        if (entry.isDirectory()) {
          results.push({ path: fullPath, relativePath, isDirectory: true, size: 0 })
          results.push(...this.scanFolderRecursive(fullPath))
        } else {
          let size = 0
          try { size = fs.statSync(fullPath).size } catch {}
          results.push({ path: fullPath, relativePath, isDirectory: false, size })
        }
      }
    } catch {}
    return results
  }

  // 重命名文件/文件夹
  async onFileRenameRequest(socket, message) {
    const { oldPath, newPath } = message.data
    const requestId = message.requestId
    try {
      fs.renameSync(oldPath, newPath)
      this.sendMsg(socket, 'file-rename-response', { success: true, newPath }, requestId)
    } catch (err) {
      this.sendMsg(socket, 'file-rename-response', { success: false, error: err.message }, requestId)
    }
  }

  // === Pairing ===
  async onPairRequest(socket, message) {
    // 以 socket 对端真实身份为准，防止发起方误传 deviceId 导致信任写错对象
    const deviceId = socket._deviceId || message.data.deviceId
    const deviceInfo = socket._deviceInfo || { deviceId, hostname: '未知设备' }

    if (this.authManager.isDeviceTrusted(deviceId)) {
      this.sendMsg(socket, 'pair-response', {
        accepted: true, alreadyTrusted: true
      })
      // v2.7.14 远程审批：已信任也直接激活 + 回执成功（发起方 pair-request 的 requestId 等的就是它）
      if (message.requestId) {
        this.activateConnection(socket, deviceInfo)
        this.sendMsg(socket, 'pair-verify-result', { success: true, alreadyTrusted: true, deviceInfo }, message.requestId)
      }
      return
    }

    // 带上 requestId（发起方 pair-request 的应答通道）+ remote 标记（渲染层据此弹「同意/拒绝」而非显示配对码）
    this.emit('incoming-pair-request', {
      deviceId,
      deviceInfo,
      requestId: message.requestId || '',
      remote: !!(socket._viaNet || socket._viaRelay)
    })
  }

  async onPairVerifyCode(socket, message) {
    const requestId = message.requestId
    // 以 socket 对端真实身份为准：防止发起方误传本机/目标 deviceId 导致信任写错对象（配对码白输、每次重连都要重新配对）
    const deviceId = socket._deviceId || message.data.deviceId
    const pairCode = message.data.pairCode
    const deviceInfo = socket._deviceInfo || { deviceId }

    if (this.authManager.isDeviceTrusted(deviceId)) {
      // 已信任（可能另一条连接已完成配对）→ 直接激活本连接
      this.activateConnection(socket, deviceInfo)
      this.sendMsg(socket, 'pair-verify-result', { success: true, alreadyTrusted: true, deviceInfo }, requestId)
      return
    }

    // 2.0：真正校验配对码（码对 = 视为对方确认，自动接受）
    if (this.authManager.verifyPairCode(pairCode)) {
      this.authManager.addTrustedDevice(deviceId, deviceInfo)
      this.authManager.clearPairCode()
      // 通知本方 UI：对方通过配对码验证（关闭右下角通知/顶栏码）
      this.emit('pair:auto-accepted', { deviceId, deviceInfo })
      this.emit('log', `配对码验证通过: ${deviceInfo.hostname || deviceId}`)
      // 激活连接（注册连接表、通知 UI）
      this.activateConnection(socket, deviceInfo)
      this.sendMsg(socket, 'pair-verify-result', { success: true, deviceInfo }, requestId)
      return
    }

    // 码错误：计数防护，连续错 5 次直接断开
    socket._pairFails = (socket._pairFails || 0) + 1
    if (socket._pairFails >= 5) {
      this.sendMsg(socket, 'pair-verify-result', { success: false, error: '配对码错误次数过多，连接已断开' }, requestId)
      try { socket.destroy() } catch {}
      return
    }
    this.sendMsg(socket, 'pair-verify-result', { success: false, error: '配对码错误，请核对后重试' }, requestId)
  }

  onPairResponse(data) {
    if (data.accepted) {
      this.emit('paired', data)
      this.emit('log', `配对成功: ${data.deviceId}`)
    } else {
      this.emit('log', `配对被拒绝`)
    }
  }

  // 取消/拒绝配对；v2.7.14 远程审批：accepted=true = 被连方点「同意」→ 建立信任 + 激活 + 按 requestId 回执发起方
  respondPair(deviceId, accepted, requestId) {
    const socket = this.pendingSockets.get(deviceId) || this.connections.get(deviceId)
    if (accepted) {
      if (!socket) return { success: false, error: '设备未连接或配对已超时' }
      return this.approvePair(deviceId, socket, requestId)
    }
    if (socket && requestId) {
      this.sendMsg(socket, 'pair-verify-result', { success: false, error: '对方拒绝了本次连接' }, requestId)
    }
    try { socket.destroy() } catch {}
    this.connections.delete(deviceId)
    this.pendingSockets.delete(deviceId)
    this.emit('pair:decision', { deviceId, accepted: false })
    return { success: true }
  }

  // 远程审批通过：被连方点「同意」→ 信任 + 激活本端 + 按 requestId 回执发起方（其 pair-request 应答）
  approvePair(deviceId, socket, requestId) {
    const deviceInfo = socket._deviceInfo || { deviceId, hostname: '远程设备' }
    this.authManager.addTrustedDevice(deviceId, deviceInfo)
    this.activateConnection(socket, deviceInfo)
    clearTimeout(socket._pairTimeout)
    if (requestId) {
      this.sendMsg(socket, 'pair-verify-result', { success: true, deviceInfo, approved: true }, requestId)
    }
    this.emit('log', `远程配对已同意: ${deviceInfo.hostname || deviceId}`)
    this.emit('pair:auto-accepted', { deviceId, deviceInfo })
    return { success: true }
  }

  // 2.0：发起方输入配对码后发送校验请求，等待对方结果
  sendPairVerifyCode(deviceId, pairCode) {
    const socket = this.connections.get(deviceId) || this.pendingSockets.get(deviceId)
    if (!socket) return Promise.resolve({ success: false, error: '设备未连接' })
    return this.sendWithResponse(socket, 'pair-verify-code', { deviceId, pairCode }, 30000)
      .then(res => {
        if (res.success) {
          // 双向信任：对方已通过码校验信任本机，本机同样记入信任列表
          // 关键：res.deviceInfo 是"对方眼里的本机信息"（name/hostname/ip 全是本机的），
          // 绝不能用它注册连接或写信任表 → 否则列表显示成"连接了自己的设备"。
          // 设备信息一律以 socket._deviceInfo（对端 hello/ack 自述）为准，deviceId 以连接目标为准。
          const peerInfo = socket._deviceInfo
            ? { ...socket._deviceInfo, deviceId }
            : { deviceId, hostname: `设备-${deviceId.slice(0, 6)}` }
          this.authManager.addTrustedDevice(deviceId, peerInfo)
          // 发起方激活连接（注册连接表、通知 UI）
          this.activateConnection(socket, peerInfo)
        }
        return { success: !!res.success, error: res.error }
      })
      .catch(() => ({ success: false, error: '校验超时' }))
  }

  // === Connection Management ===
  handleDisconnect(socket) {
    const deviceId = socket._deviceId
    if (!deviceId) return  // 已处理过，防止 close+error 重复触发
    socket._deviceId = null
    // 未完成配对的连接：只清理 pending 表，不发断开事件（UI 从未见过它）
    if (socket._unverified) {
      this.pendingSockets.delete(deviceId)
      return
    }
    this.connections.delete(deviceId)
    this.emit('connection-status', { status: 'disconnected', deviceId, deviceInfo: socket._deviceInfo || null })
    this.emit('log', `${deviceId} 已断开`)
  }

  // 获取当前所有已连接设备（多设备支持）
  getConnectedDevices() {
    const list = []
    for (const [deviceId, socket] of this.connections) {
      const info = socket._deviceInfo || {}
      list.push({
        deviceId,
        hostname: info.hostname || deviceId,
        name: info.name || info.hostname || deviceId,
        ip: info.ip || socket.remoteAddress || '',
        platform: info.platform || '',
        appVersion: info.appVersion || ''   // 空 = 旧版（未上报应用版本）
      })
    }
    return list
  }

  async connectDevice(deviceId) {
    const trustedDevices = this.authManager.getTrustedDevices()
    const device = trustedDevices.find(d => d.deviceId === deviceId)
    if (!device) return { success: false, error: '设备未配对' }

    return new Promise((resolve) => {
      const socket = net.createConnection(TCP_PORT, device.ip, () => {
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 5000)
        socket._deviceId = deviceId
        socket._buffer = Buffer.alloc(0)
        socket._connected = true
        socket._lastPongTime = Date.now()
        socket._role = 'outbound' // 发起方：本机主动连接
        // 注意：此处不写入 connections——未完成配对验证前连接不算"已连接"，
        // 由 activateConnection 在双向信任确认后统一注册，避免 UI 假连接/业务消息被拦截

        socket.on('data', (data) => {
          socket._buffer = Buffer.concat([socket._buffer, data])
          this.drainBuffer(socket)
        })

        socket.on('close', () => this.handleDisconnect(socket))
        socket.on('error', () => this.handleDisconnect(socket))

        this.sendHello(socket)

        this.emit('log', `已连接到 ${device.hostname}`)
        resolve({ success: true, deviceInfo: device })
      })

      socket.on('error', (err) => {
        this.emit('log', `连接失败: ${err.message}`)
        resolve({ success: false, error: err.message })
      })

      socket.setTimeout(REQUEST_TIMEOUT)
      socket.on('timeout', () => {
        socket.destroy()
        resolve({ success: false, error: '连接超时' })
      })
    })
  }

  disconnectDevice(deviceId) {
    const socket = this.connections.get(deviceId)
    if (socket) {
      socket.destroy()
      this.connections.delete(deviceId)
    }
    // 配对流程中（pending 未激活）的连接也一并断开，避免输码前取消连接无效
    const pending = this.pendingSockets.get(deviceId)
    if (pending && pending !== socket) {
      pending._deviceId = null
      try { pending.destroy() } catch {}
      this.pendingSockets.delete(deviceId)
    }
    return { success: true }
  }

  // 通过 IP 直接连接（UDP 发现失败时的保底方案）
  async connectByIP(ip, port) {
    const trimmedIP = (ip || '').trim()
    if (!trimmedIP) return { success: false, error: '请输入 IP 地址' }
    // 本机地址拦截：连自己只会污染设备表（IPv6 临时地址轮换后，历史地址可能撞上本机）
    try {
      const bare = trimmedIP.replace(/^\[|\]$/g, '').replace(/:\d+$/, '')
      const own = require('./ipv6Invite').getGlobalIPv6Addresses() || []
      if (own.some((a) => a.toLowerCase() === bare.toLowerCase())) {
        return { success: false, error: '这是本机自己的地址，不能连接自己' }
      }
    } catch {}

    return new Promise((resolve) => {
      const socket = net.createConnection(port || TCP_PORT, trimmedIP, () => {
        socket.setNoDelay(true)
        socket.setKeepAlive(true, 5000)
        socket._buffer = Buffer.alloc(0)
        socket._connected = true
        socket._lastPongTime = Date.now()
        socket._tempIP = trimmedIP
        socket._role = 'outbound' // 发起方：本机主动连接
        if (isPublicIP(trimmedIP)) socket._viaNet = true // 公网出站 = 互联网传输，计入每日额度

        socket.on('data', (data) => {
          if (socket._viaNet && this.netQuota) this.netQuota.add(data.length) // 收向流量累计
          socket._buffer = Buffer.concat([socket._buffer, data])
          this.drainBuffer(socket)
        })

        socket.on('close', () => this.handleDisconnect(socket))
        socket.on('error', () => this.handleDisconnect(socket))

        this.sendHello(socket)
        this.emit('log', `正在通过 IP 连接 ${trimmedIP}...`)
        resolve({ success: true, message: '连接建立中' })
      })

      socket.on('error', (err) => {
        this.emit('log', `IP 连接失败: ${err.message}`)
        resolve({ success: false, error: err.message })
      })

      socket.setTimeout(REQUEST_TIMEOUT)
      socket.on('timeout', () => {
        socket.destroy()
        resolve({ success: false, error: '连接超时，请确认对方已启动程序且 IP 正确' })
      })
    })
  }

  // 注入一条已建立的连接（互联网模式：从中转服务器桥接来的 TLS socket）
  // 两侧均按对称握手处理：各自 sendHello，由 handleHello 注册设备
  adoptSocket(socket, opts = {}) {
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 5000)
    socket._buffer = Buffer.alloc(0)
    socket._connected = true
    socket._lastPongTime = Date.now()
    socket._viaRelay = true
    socket._viaNet = true // 互联网桥接通道：无论收发都走中转流量，计入每日额度
    socket._role = 'inbound' // 互联网桥接：本端为被动方（显码），发起方通过 connectByIP 建立桥接
    if (opts.tempIP) socket._tempIP = opts.tempIP

    socket.on('data', (data) => {
      if (this.netQuota) this.netQuota.add(data.length) // 收向流量累计
      socket._buffer = Buffer.concat([socket._buffer, data])
      this.drainBuffer(socket)
    })

    socket.on('close', () => this.handleDisconnect(socket))
    socket.on('error', () => this.handleDisconnect(socket))

    this.sendHello(socket)
    this.emit('log', '互联网通道：桥接连接已建立')
    return { success: true }
  }

  // === Remote Operations ===
  async listRemoteDirectory(deviceId, targetPath) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId)

    this.sendMsg(socket, 'file-list-request', { path: targetPath }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  async downloadFile(deviceId, remotePath, localPath, transferId = null, overwrite = false) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    transferId = transferId || genId()
    const fileName = path.basename(remotePath)
    const savePath = localPath || path.join(os.homedir(), 'Downloads', fileName)

    // 断点续传：检查本地是否已有部分下载的文件（overwrite 时强制全新下载）
    let offset = 0
    if (!overwrite) {
      try {
        const localStats = fs.statSync(savePath)
        if (localStats.isFile() && localStats.size > 0) {
          offset = localStats.size
        }
      } catch {
        // 文件不存在，offset = 0
      }
    }

    const transfer = {
      type: 'client-download',
      transferId,
      fileName,
      localPath: savePath,
      totalSize: 0,
      received: offset,
      writeStream: null,
      status: 'requesting'
    }
    this.transfers.set(transferId, transfer)

    try {
      const response = this.registerPending(requestId, REQUEST_TIMEOUT * 10)
      this.sendMsg(socket, 'file-download-request', { remotePath, transferId, offset }, requestId)

      const result = await response

      if (!result.success) {
        throw new Error(result.error || '下载失败')
      }

      // 服务端判定本地残留与远程不一致 → 删除本地残留，从头接收
      if (result.restart) {
        try { fs.unlinkSync(savePath) } catch {}
        offset = 0
      }

      // 本地残留文件比远程文件大（旧逻辑兜底），删除重新下载
      if (offset > result.fileSize) {
        try { fs.unlinkSync(savePath) } catch {}
        offset = 0
      }

      // 文件已下载完（含空文件）
      if (offset >= result.fileSize) {
        // 确保文件存在（空文件情况：fileSize=0 时不创建 writeStream）
        if (offset === 0 && !fs.existsSync(savePath)) {
          fs.writeFileSync(savePath, Buffer.alloc(0))
        }
        this.transfers.delete(transferId)
        return { success: true, localPath: savePath }
      }

      transfer.totalSize = result.fileSize
      transfer.status = 'downloading'
      // 断点续传用追加模式
      transfer.writeStream = fs.createWriteStream(transfer.localPath, offset > 0 ? { flags: 'a' } : {})

      return new Promise((resolve, reject) => {
        transfer.writeStream.on('finish', () => {
          resolve({ success: true, localPath: transfer.localPath })
        })
        transfer.writeStream.on('error', reject)

        setTimeout(() => {
          if (transfer.status !== 'complete') {
            reject(new Error('下载超时'))
          }
        }, REQUEST_TIMEOUT * 20)
      })
    } catch (err) {
      this.transfers.delete(transferId)
      return { success: false, error: err.message }
    }
  }

  async uploadFile(deviceId, localPath, remoteDir, forceOverwrite = false, transferId = null, remoteName = null) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    transferId = transferId || genId()
    const fileName = remoteName || path.basename(localPath)
    let stats
    try {
      stats = fs.statSync(localPath)
    } catch (err) {
      return { success: false, error: `无法读取文件: ${err.message}` }
    }

    try {
      const response = this.registerPending(requestId)
      this.sendMsg(socket, 'file-upload-request', {
        localPath, remoteDir, transferId, fileName, fileSize: stats.size, overwrite: forceOverwrite
      }, requestId)

      const result = await response

      if (!result.success) {
        throw new Error(result.error || '上传失败')
      }

      // 断点续传：从 offset 开始读取
      const offset = result.offset || 0
      if (offset >= stats.size) {
        return { success: true }
      }

      const transfer = {
        type: 'client-upload',
        transferId,
        localPath,
        remoteDir,
        fileName,
        fileSize: stats.size,
        sent: offset,
        status: 'uploading'
      }
      this.transfers.set(transferId, transfer)

      return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(localPath, { highWaterMark: BUFFER_SIZE, start: offset })
        let uploadPaused = false
        let ackTimeout = null
        let done = false

        const finish = (fn) => {
          if (done) return
          done = true
          clearTimeout(ackTimeout)
          clearTimeout(hangTimeout)
          this.removeListener('transfer-ack', onAck)
          this.removeListener('file-transfer-error', onPeerError)
          try { readStream.destroy() } catch {}
          this.transfers.delete(transferId)
          fn()
        }

        // 接收方写盘失败（磁盘满/权限/中断）的即时回报：立刻报错，绝不假装成功
        const onPeerError = (d) => {
          if (d && d.transferId === transferId) {
            finish(() => reject(new Error(d.error || '对方接收失败')))
          }
        }
        this.on('file-transfer-error', onPeerError)

        readStream.on('data', (chunk) => {
          const ok = this.sendMsgRaw(socket, 'file-transfer-chunk', chunk, transferId)
          transfer.sent += chunk.length
          const progress = Math.round((transfer.sent / transfer.fileSize) * 100)
          this.emit('file-transfer-progress', {
            transferId, direction: 'upload',
            fileName, sent: transfer.sent, total: transfer.fileSize, progress, incoming: false
          })
          if (!ok && !uploadPaused) {
            uploadPaused = true
            readStream.pause()
            socket.once('drain', () => {
              uploadPaused = false
              readStream.resume()
            })
          }
        })

        readStream.on('end', () => {
          this.sendMsg(socket, 'file-transfer-complete', { transferId, size: stats.size })
          // ⚠ 文件流全部发完才开始等 ack（此前定时器在上传一开始就启动，大文件传输超 10 秒
          // 会在中途误报成功并掐断读取流 → 对方拿到残缺文件且写入句柄被锁死打不开，
          // 实锤事故：2.7.22→2.7.11 传 188MB 安装包，进度 71% 弹"上传成功"）
          // 对方是老版本不回 ack 时 10 秒兜底放行，不阻塞用户
          ackTimeout = setTimeout(() => {
            this.removeListener('transfer-ack', onAck)
            finish(() => resolve({ success: true }))
          }, 10000)
        })

        // 接收方写入完毕的 ack
        const onAck = (ackData) => {
          if (ackData.transferId === transferId) {
            this.removeListener('transfer-ack', onAck)
            finish(() => resolve({ success: true }))
          }
        }
        this.on('transfer-ack', onAck)

        readStream.on('error', (err) => {
          finish(() => reject(err))
        })

        // 整体超时：流未结束也没收到 ack → 清理并报错（防止流和 transfers 条目永久残留）
        const hangTimeout = setTimeout(() => {
          this.removeListener('transfer-ack', onAck)
          finish(() => reject(new Error('上传超时')))
        }, REQUEST_TIMEOUT * 20)
      })
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  async batchDownload(deviceId, files, destDir) {
    const results = []
    for (const file of files) {
      try {
        const localPath = path.join(destDir, path.basename(file.path))
        const result = await this.downloadFile(deviceId, file.path, localPath, null, true)
        results.push(result)
      } catch (err) {
        results.push({ success: false, error: err.message, file: file.path })
      }
    }
    return results
  }

  async batchUpload(deviceId, filePaths, remoteDir) {
    const results = []
    for (const filePath of filePaths) {
      try {
        const result = await this.uploadFile(deviceId, filePath, remoteDir, true)
        results.push(result)
      } catch (err) {
        results.push({ success: false, error: err.message, file: filePath })
      }
    }
    return results
  }

  async deleteRemoteFile(deviceId, filePath) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId)
    this.sendMsg(socket, 'file-delete-request', { filePath }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  async createRemoteFolder(deviceId, folderPath) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId)
    this.sendMsg(socket, 'file-mkdir-request', { folderPath }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  async createRemoteFile(deviceId, filePath, fileType) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId)
    this.sendMsg(socket, 'file-create-request', { filePath, fileType }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  cancelTransfer(transferId) {
    const transfer = this.transfers.get(transferId)
    if (!transfer) return { success: false }
    if (transfer.writeStream) {
      transfer.writeStream.destroy()
    }
    this.transfers.delete(transferId)
    this.emit('file-transfer-error', { transferId, error: '已取消' })
    return { success: true }
  }

  // 扫描远程文件夹结构（递归）
  async scanRemoteFolder(deviceId, folderPath) {
    const socket = this.connections.get(deviceId)
    if (!socket) return null

    const requestId = genId()
    const pending = this.registerPending(requestId)
    
    this.sendMsg(socket, 'folder-scan-request', { path: folderPath }, requestId)

    try {
      const result = await pending
      return result.entries || []
    } catch (err) {
      return null
    }
  }

  // 重命名远程文件/文件夹
  async renameRemoteFile(deviceId, oldPath, newName) {
    const socket = this.connections.get(deviceId)
    if (!socket) return { success: false, error: '设备未连接' }

    const requestId = genId()
    const pending = this.registerPending(requestId)
    
    const dir = path.dirname(oldPath)
    const newPath = path.join(dir, newName)
    
    this.sendMsg(socket, 'file-rename-request', { oldPath, newPath }, requestId)

    try {
      return await pending
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  getConnections() {
    return Array.from(this.connections.keys())
  }
}

module.exports = { TCPAgent, TCP_PORT, createOfficeFile }