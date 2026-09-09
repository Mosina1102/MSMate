// MSConnect 2.0 IPv6 直连辅助模块
// 职责：收集本机全局 IPv6 地址（公网可达的 2xxx/3xxx 段）、生成/解析邀请串
// 设计要点：hello 消息中新增 ipv6 字段携带地址列表，1.0 收到后会忽略未知字段，完全向后兼容
'use strict'

const os = require('os')

// 判断是否为全局单播 IPv6（排除链路本地/ULA/Teredo/6to4/内网）
function isGlobalIPv6(addr) {
  if (!addr) return false
  const a = addr.toLowerCase()
  if (a.startsWith('fe80:') || a.startsWith('fec0:')) return false   // 链路本地
  if (a.startsWith('fc') || a.startsWith('fd')) return false          // ULA 内网
  if (a.startsWith('2001:0') || a.startsWith('2001:db8')) return false // Teredo/文档段
  if (a.startsWith('2002:')) return false                             // 6to4
  return a.startsWith('2') || a.startsWith('3')                       // 全局单播 2000::/3
}

function stripScope(addr) {
  const i = addr.indexOf('%')
  return i === -1 ? addr : addr.slice(0, i)
}

// 收集本机全局 IPv6 地址（去重）
function getGlobalIPv6Addresses() {
  const out = []
  const seen = new Set()
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv6' || addr.internal) continue
      const clean = stripScope(addr.address)
      if (!isGlobalIPv6(clean)) continue
      if (seen.has(clean)) continue
      seen.add(clean)
      out.push(clean)
    }
  }
  return out
}

// 邀请串：MS6.<base64url(JSON)>
// JSON: { v: 1, id: deviceId, name, port, addrs: [全局IPv6...] }
function buildInvite(deviceId, name, port) {
  const payload = {
    v: 1,
    id: deviceId,
    name: name || deviceId,
    port,
    addrs: getGlobalIPv6Addresses()
  }
  if (!payload.addrs.length) return null
  return 'MS6.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

// 解析邀请串；也兼容用户直接粘贴一个 IPv6 地址
function parseInvite(text) {
  const t = (text || '').trim()
  if (!t) return { success: false, error: '内容为空' }

  if (t.toUpperCase().startsWith('MS6.')) {
    try {
      const obj = JSON.parse(Buffer.from(t.slice(4), 'base64url').toString('utf8'))
      if (obj && obj.v === 1 && obj.id && Array.isArray(obj.addrs) && obj.addrs.length) {
        return {
          success: true,
          deviceId: String(obj.id),
          name: String(obj.name || obj.id),
          port: parseInt(obj.port, 10) || 45679,
          addrs: obj.addrs.filter(isGlobalIPv6).slice(0, 4)
        }
      }
      return { success: false, error: '邀请串内容无效' }
    } catch {
      return { success: false, error: '邀请串格式错误' }
    }
  }

  // 裸 IPv6 地址（含端口方括号形式 [addr]:port）
  let host = t
  let port = 45679
  const m = t.match(/^\[([0-9a-fA-F:]+)\](?::(\d+))?$/)
  if (m) { host = m[1]; if (m[2]) port = parseInt(m[2], 10) }
  if (host.includes(':') && isGlobalIPv6(host)) {
    return { success: true, deviceId: null, name: 'IPv6 设备', port, addrs: [host] }
  }

  return { success: false, error: '不是有效的邀请串或 IPv6 地址' }
}

module.exports = { isGlobalIPv6, getGlobalIPv6Addresses, buildInvite, parseInvite }
