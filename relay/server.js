// MSConnect 2.0 中转服务器（互联网通道）
// 职责：设备注册表 + 桥接撮合 + TLS 加密字节转发（不解析业务数据，只搬字节）
// 用法：node relay/server.js [端口]（默认 9769）
// 协议（控制连接，JSON + \n 分帧）：
//   客户端 ->  { type: 'reg-host', deviceId, name }        注册在线
//              { type: 'bridge', target }                  请求桥接到目标设备
//              { type: 'pipe', bridgeId, role }            管道连接的第一行（随后变为原始字节流）
//              { type: 'list' } / { type: 'ping' }
//   服务器 ->  { type: 'reg-ok' } / { type: 'reg-error', reason }
//              { type: 'device-list', devices: [{ deviceId, name }] }
//              { type: 'bridge-id', bridgeId, target }
//              { type: 'bridge-offer', bridgeId, from }    通知被连接方
//              { type: 'pipe-ready' } / { type: 'error', reason } / { type: 'pong' }
//   管道连接：首行 JSON 后服务器回 { type:'pipe-ready' }，此后为纯字节转发
'use strict'

const tls = require('tls')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const PORT = parseInt(process.argv[2] || process.env.RELAY_PORT || '9769', 10)
const CERT_DIR = path.join(__dirname, 'certs')
const HOST_TIMEOUT = 35000 // 控制连接心跳超时

// === 证书 ===
function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl', '/bin/openssl'
  ]
  for (const c of candidates) {
    try { execFileSync(c, ['version'], { stdio: 'ignore' }); return c } catch { }
  }
  return null
}

async function ensureCerts() {
  const certFile = path.join(CERT_DIR, 'cert.pem')
  const keyFile = path.join(CERT_DIR, 'key.pem')
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return { certFile, keyFile }
  fs.mkdirSync(CERT_DIR, { recursive: true })

  // 方案一：selfsigned 纯 JS 生成（无原生依赖，推荐）
  try {
    const selfsigned = require('selfsigned')
    console.log('[relay] 首次运行，生成自签名证书（selfsigned）...')
    // selfsigned v5 返回 Promise
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'msconnect-relay' }],
      { days: 3650, keySize: 2048, algorithm: 'sha256' })
    fs.writeFileSync(keyFile, pems.private)
    fs.writeFileSync(certFile, pems.cert)
    return { certFile, keyFile }
  } catch (err) {
    console.log(`[relay] selfsigned 不可用（${String(err.message || err).split('\n')[0]}），尝试 openssl...`)
  }

  // 方案二：openssl 命令行
  const openssl = findOpenssl()
  if (!openssl) {
    console.error('[relay] 无法生成证书：缺少 selfsigned 包且未找到 openssl。')
    console.error('[relay] 请在 relay 目录执行 npm install selfsigned，或手动生成证书放入 relay/certs/。')
    process.exit(1)
  }
  console.log('[relay] 首次运行，生成自签名证书（openssl）...')
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile,
    '-out', certFile, '-days', '3650', '-nodes', '-subj', '/CN=msconnect-relay'], { stdio: 'ignore' })
  return { certFile, keyFile }
}

// === 状态 ===
const hosts = new Map()      // deviceId -> { sock, name, lastSeen }
const bridges = new Map()    // bridgeId -> { target, from, aPipe, bPipe, timer }

function jsonLine(sock, obj) {
  try { sock.write(JSON.stringify(obj) + '\n') } catch { }
}

function cleanupBridge(bridgeId) {
  const b = bridges.get(bridgeId)
  if (!b) return
  if (b.timer) clearTimeout(b.timer)
  for (const p of [b.aPipe, b.bPipe]) {
    if (p) { try { p.destroy() } catch { } }
  }
  bridges.delete(bridgeId)
}

// 两侧管道就绪后，把两个原始流对拼
function trySplice(bridgeId) {
  const b = bridges.get(bridgeId)
  if (!b || !b.aPipe || !b.bPipe) return
  bridges.delete(bridgeId)
  if (b.timer) clearTimeout(b.timer)
  const a = b.aPipe, c = b.bPipe
  const onErr = () => { try { a.destroy() } catch { } try { c.destroy() } catch { } }
  a.on('error', onErr); c.on('error', onErr)
  a.pipe(c); c.pipe(a)
  console.log(`[relay] 桥接建立 ${b.from} -> ${b.target}`)
}

function handleControl(sock) {
  let buf = Buffer.alloc(0)
  let me = null          // 注册后的 deviceId
  sock._jsonMode = true  // pipe 化后转为 false，进入纯字节转发模式

  sock.on('data', (d) => {
    if (!sock._jsonMode) return // 已成为管道，字节由 pipe() 转发，此处不再解析
    buf = Buffer.concat([buf, d])
    let idx
    while ((idx = buf.indexOf(0x0A)) !== -1) {
      const line = buf.slice(0, idx).toString('utf8').trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { sock.destroy(); return }
      onControl(sock, msg)
      if (sock.destroyed) return
    }
  })

  function touch() {
    const h = me && hosts.get(me)
    if (h) h.lastSeen = Date.now()
  }

  function onControl(sock, msg) {
    touch()
    switch (msg.type) {
      case 'ping':
        jsonLine(sock, { type: 'pong' })
        break

      case 'reg-host': {
        if (!msg.deviceId || typeof msg.deviceId !== 'string') { jsonLine(sock, { type: 'reg-error', reason: 'deviceId 无效' }); return }
        // 同设备重连：踢掉旧连接
        const old = hosts.get(msg.deviceId)
        if (old && old.sock !== sock) { try { old.sock.destroy() } catch { } }
        me = msg.deviceId
        hosts.set(msg.deviceId, { sock, name: String(msg.name || msg.deviceId).slice(0, 64), lastSeen: Date.now() })
        jsonLine(sock, { type: 'reg-ok' })
        console.log(`[relay] 注册 ${msg.deviceId} (${msg.name || ''})，在线 ${hosts.size}`)
        break
      }

      case 'list': {
        const devices = []
        for (const [deviceId, h] of hosts) {
          if (h.sock !== sock) devices.push({ deviceId, name: h.name })
        }
        jsonLine(sock, { type: 'device-list', devices })
        break
      }

      case 'bridge': {
        const target = hosts.get(msg.target)
        if (!me) { jsonLine(sock, { type: 'error', reason: '请先注册' }); return }
        if (!target || target.sock === sock) { jsonLine(sock, { type: 'error', reason: '目标设备不在线' }); return }
        const bridgeId = crypto.randomBytes(12).toString('hex')
        bridges.set(bridgeId, { target: msg.target, from: me, aPipe: null, bPipe: null, timer: setTimeout(() => cleanupBridge(bridgeId), 15000) })
        jsonLine(sock, { type: 'bridge-id', bridgeId, target: msg.target })
        jsonLine(target.sock, { type: 'bridge-offer', bridgeId, from: me })
        break
      }

      case 'pipe': {
        const b = bridges.get(msg.bridgeId)
        if (!b) { jsonLine(sock, { type: 'error', reason: '桥接请求已过期' }); sock.destroy(); return }
        jsonLine(sock, { type: 'pipe-ready' })
        sock._jsonMode = false
        if (msg.role === 'connector') b.aPipe = sock
        else b.bPipe = sock
        trySplice(msg.bridgeId)
        break
      }

      default:
        break
    }
  }

  sock.on('close', () => {
    if (me && hosts.get(me) && hosts.get(me).sock === sock) {
      hosts.delete(me)
      console.log(`[relay] 离线 ${me}，在线 ${hosts.size}`)
    }
    // 清掉与该连接相关的未完成桥接
    for (const [id, b] of bridges) {
      if (b.from === me || b.target === me || b.aPipe === sock || b.bPipe === sock) cleanupBridge(id)
    }
  })
  sock.on('error', () => { })
}

// 僵尸主机清理：心跳超时
setInterval(() => {
  const now = Date.now()
  for (const [id, h] of hosts) {
    if (now - h.lastSeen > HOST_TIMEOUT) {
      try { h.sock.destroy() } catch { }
      hosts.delete(id)
      console.log(`[relay] 心跳超时清理 ${id}`)
    }
  }
}, 10000).unref()

async function main() {
  const { certFile, keyFile } = await ensureCerts()
  const server = tls.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    (sock) => handleControl(sock)
  )
  server.on('tlsClientError', (err) => console.log('[relay] TLS 握手失败:', err.message))
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[relay] MSConnect 中转服务器已启动，端口 ${PORT}（TLS）`)
  })
  server.on('error', (err) => {
    console.error('[relay] 服务器错误:', err.message)
    process.exit(1)
  })
}

main()
