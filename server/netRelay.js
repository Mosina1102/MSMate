// MSConnect 2.0 互联网模式客户端（连接中转服务器）
// 职责：TLS 外连注册在线、拉取远程设备列表、桥接撮合（主动/被动）、产出可注入
//       tcpAgent 的原始双端流。与 1.0 的局域网通道完全隔离，互不影响。
'use strict'

const tls = require('tls')
const { EventEmitter } = require('events')

const PING_INTERVAL = 15000
const RECONNECT_MIN = 2000
const RECONNECT_MAX = 30000
const BRIDGE_TIMEOUT = 10000

class NetRelay extends EventEmitter {
  constructor({ deviceId, deviceName, getCertPin, setCertPin }) {
    super()
    this.deviceId = deviceId
    this.deviceName = deviceName
    this.getCertPin = getCertPin || (() => null)
    this.setCertPin = setCertPin || (() => { })

    this.enabled = false
    this.host = null          // { host, port }
    this.sock = null          // 控制连接（TLS）
    this.status = 'stopped'   // stopped | connecting | online | error
    this.lastError = null
    this.devices = []         // 远程在线设备 [{ deviceId, name }]
    this._buf = Buffer.alloc(0)
    this._retryTimer = null
    this._pingTimer = null
    this._retryDelay = RECONNECT_MIN
    this._pendingBridges = new Map() // bridgeId -> { resolve, reject, timer }
  }

  get online() { return this.status === 'online' }

  // === 启停 ===
  start(hostStr) {
    const parsed = this._parseHost(hostStr)
    if (!parsed) {
      this.status = 'error'
      this.lastError = '服务器地址无效，应为 域名或IP:端口'
      this.emit('status', this._statusSnapshot())
      return false
    }
    this.enabled = true
    this.host = parsed
    this._connect()
    return true
  }

  stop() {
    this.enabled = false
    this._clearTimers()
    this._rejectAllBridges('互联网模式已关闭')
    if (this.sock) { try { this.sock.destroy() } catch { } this.sock = null }
    this.status = 'stopped'
    this.devices = []
    this.emit('status', this._statusSnapshot())
    this.emit('device-list', [])
  }

  _parseHost(str) {
    if (!str) return null
    let host = String(str).trim()
    if (!host) return null
    let port = 9769
    const m = host.match(/^(.+):(\d+)$/)
    if (m) { host = m[1]; port = parseInt(m[2], 10) }
    if (!host || !port || port < 1 || port > 65535) return null
    return { host, port }
  }

  _statusSnapshot() {
    return { status: this.status, error: this.lastError, devices: this.devices.length }
  }

  _setStatus(status, error) {
    this.status = status
    if (error !== undefined) this.lastError = error
    this.emit('status', this._statusSnapshot())
  }

  _clearTimers() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null }
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null }
  }

  _rejectAllBridges(reason) {
    for (const [, p] of this._pendingBridges) {
      if (p.timer) clearTimeout(p.timer)
      try { p.reject(new Error(reason)) } catch { }
    }
    this._pendingBridges.clear()
    for (const [, p] of this._pendingPipes || new Map()) {
      if (p.timer) clearTimeout(p.timer)
      try { p.reject(new Error(reason)) } catch { }
    }
    if (this._pendingPipes) this._pendingPipes.clear()
  }

  // === 连接 ===
  _connect() {
    if (!this.enabled || !this.host) return
    this._clearTimers()
    this._setStatus('connecting')

    const sock = tls.connect({
      host: this.host.host,
      port: this.host.port,
      rejectUnauthorized: false, // 自签名证书，用 TOFU 指纹锁定代替 CA 链
      servername: this.host.host
    }, () => {
      // TOFU：首次记录证书指纹，之后必须一致（防中间人）
      const fp = sock.getPeerCertificate && sock.getPeerCertificate().fingerprint256
      const known = this.getCertPin()
      if (known && fp && known !== fp) {
        this._fail(`中转服务器证书已变化（疑似中间人），拒绝连接。如确为服务器换证，请在设置中重新保存。`)
        try { sock.destroy() } catch { }
        return
      }
      if (!known && fp) this.setCertPin(fp)
      this.sock = sock
      this._send({ type: 'reg-host', deviceId: this.deviceId, name: this.deviceName })
      this._setStatus('online')
      this._retryDelay = RECONNECT_MIN
      this._pingTimer = setInterval(() => this._send({ type: 'ping' }), PING_INTERVAL)
      this._send({ type: 'list' })
    })

    sock.on('data', (d) => {
      this._buf = Buffer.concat([this._buf, d])
      let idx
      while ((idx = this._buf.indexOf(0x0A)) !== -1) {
        const line = this._buf.slice(0, idx).toString('utf8').trim()
        this._buf = this._buf.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        this._onMessage(msg)
      }
    })

    sock.on('close', () => {
      if (this.sock === sock) {
        this.sock = null
        this._clearTimers()
        this._rejectAllBridges('与中转服务器的连接已断开')
        this.devices = []
        this.emit('device-list', [])
        if (this.enabled) {
          this._setStatus('connecting', '与中转服务器断开，正在重连...')
          this._retryTimer = setTimeout(() => this._connect(), this._retryDelay)
          this._retryDelay = Math.min(this._retryDelay * 2, RECONNECT_MAX)
        } else {
          this._setStatus('stopped')
        }
      }
    })

    sock.on('error', (err) => {
      if (this.sock !== sock && this.status === 'connecting') {
        this._fail(`无法连接中转服务器: ${err.message}`)
      }
    })
  }

  _fail(errMsg) {
    this._setStatus('error', errMsg)
    if (this.enabled) {
      this._clearTimers()
      this._retryTimer = setTimeout(() => this._connect(), this._retryDelay)
    }
  }

  _send(obj) {
    if (!this.sock || this.sock.destroyed) return
    try { this.sock.write(JSON.stringify(obj) + '\n') } catch { }
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'reg-ok':
        this._send({ type: 'list' })
        break

      case 'reg-error':
      case 'error':
        this.emit('log', `中转服务器: ${msg.reason || '未知错误'}`)
        break

      case 'device-list':
        this.devices = Array.isArray(msg.devices) ? msg.devices : []
        this.emit('device-list', this.devices)
        break

      case 'bridge-id': {
        const p = this._pendingBridges.get(msg.target)
        if (p) {
          // 拿到 bridgeId：开管道连接
          this._openPipe(msg.bridgeId, 'connector').then(p.pipeResolve).catch(p.pipeReject)
        }
        break
      }

      case 'bridge-offer':
        // 被连接：自动开管道承接（应用层配对认证仍会在此后的连接上执行）
        this._openPipe(msg.bridgeId, 'acceptor').then((pipeSock) => {
          this.emit('bridge-socket', pipeSock, { role: 'acceptor' })
        }).catch(() => { })
        break

      case 'pong':
        break

      default:
        break
    }
  }

  // === 主动连接某远程设备：返回桥接好的原始 socket ===
  connectTo(targetId) {
    if (!this.online) return Promise.reject(new Error('互联网模式未在线'))
    // 同一目标只保留一个等待中的桥接请求
    const existing = this._pendingBridges.get(targetId)
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer)
      try { existing.reject(new Error('重复请求已取消')) } catch { }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingBridges.delete(targetId)
        reject(new Error('桥接超时，对方可能不在线'))
      }, BRIDGE_TIMEOUT)
      this._pendingBridges.set(targetId, {
        resolve: (sock) => { this._pendingBridges.delete(targetId); resolve(sock) },
        reject: (err) => { this._pendingBridges.delete(targetId); reject(err) },
        timer,
        pipeResolve: resolve,
        pipeReject: reject
      })
      this._send({ type: 'bridge', target: targetId })
    })
  }

  _openPipe(bridgeId, role) {
    return new Promise((resolve, reject) => {
      const pipeSock = tls.connect({
        host: this.host.host,
        port: this.host.port,
        rejectUnauthorized: false,
        servername: this.host.host
      }, () => {
        pipeSock.write(JSON.stringify({ type: 'pipe', bridgeId, role }) + '\n')
      })
      const timer = setTimeout(() => {
        try { pipeSock.destroy() } catch { }
        reject(new Error('管道连接超时'))
      }, BRIDGE_TIMEOUT)

      let buf = Buffer.alloc(0)
      const onFirstLine = (line) => {
        let msg
        try { msg = JSON.parse(line) } catch { pipeSock.destroy(); return }
        if (msg.type === 'pipe-ready') {
          clearTimeout(timer)
          pipeSock.setNoDelay(true)
          pipeSock.setKeepAlive(true, 5000)
          resolve(pipeSock)
        } else {
          clearTimeout(timer)
          try { pipeSock.destroy() } catch { }
          reject(new Error(msg.reason || '管道被拒绝'))
        }
      }

      pipeSock.on('data', function onData(d) {
        buf = Buffer.concat([buf, d])
        const idx = buf.indexOf(0x0A)
        if (idx === -1) return
        const line = buf.slice(0, idx).toString('utf8').trim()
        pipeSock.removeListener('data', onData)
        onFirstLine(line)
      })
      pipeSock.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(err.message))
      })
      pipeSock.on('close', () => {
        clearTimeout(timer)
      })
    })
  }
}

module.exports = { NetRelay }
