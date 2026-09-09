const dgram = require('dgram')
const os = require('os')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const UDP_PORT = parseInt(process.env.MSC_UDP_PORT || '45678', 10)
const BROADCAST_INTERVAL = 3000
const DEVICE_TIMEOUT = 15000

class UDPDiscovery extends EventEmitter {
  constructor() {
    super()
    this.socket = null
    this.isRunning = false
    this.discoveredDevices = new Map()
    this.broadcastTimer = null
    this.cleanupTimer = null
    this.broadcastInterval = BROADCAST_INTERVAL
    this.deviceId = this.generateDeviceId()
    this.deviceName = null // 自定义设备名（可选）
  }

  setDeviceName(name) {
    this.deviceName = name || null
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
    // MSC_DEVICE_ID 仅用于同机多开测试；默认空串，与 tcpAgent 保持一致
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
      timestamp: Date.now()
    }
  }

  // 计算子网定向广播地址（如 192.168.1.255）
  getSubnetBroadcast(ip, netmask) {
    try {
      const ipParts = ip.split('.').map(Number)
      const maskParts = netmask.split('.').map(Number)
      if (ipParts.length !== 4 || maskParts.length !== 4) return null
      const broadcastParts = ipParts.map((ipPart, i) => (ipPart | (~maskParts[i] & 255)))
      return broadcastParts.join('.')
    } catch {
      return null
    }
  }

  // 获取所有非内网 IPv4 接口的广播地址
  getBroadcastAddresses() {
    const addresses = []
    const interfaces = os.networkInterfaces()
    for (const [, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const subnetBcast = this.getSubnetBroadcast(addr.address, addr.netmask)
          if (subnetBcast) addresses.push(subnetBcast)
        }
      }
    }
    return addresses
  }

  start() {
    if (this.isRunning) return
    this.isRunning = true

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    this.socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf-8'))
        if (data.deviceId === this.deviceId) return

        const existing = this.discoveredDevices.get(data.deviceId)
        const newName = data.name || data.hostname
        if (!existing || Date.now() - existing.lastSeen > DEVICE_TIMEOUT) {
          this.discoveredDevices.set(data.deviceId, {
            ...data,
            lastSeen: Date.now()
          })
          this.emit('device-found', {
            deviceId: data.deviceId,
            hostname: data.hostname,
            name: newName,
            ip: rinfo.address,
            platform: data.platform
          })
          this.emit('log', `发现设备: ${newName} (${rinfo.address})`)
        } else {
          // 名称变化时重新通知，让前端更新显示
          const prevName = existing.name || existing.hostname
          this.discoveredDevices.set(data.deviceId, {
            ...data,
            lastSeen: Date.now()
          })
          if (prevName !== newName) {
            this.emit('device-found', {
              deviceId: data.deviceId,
              hostname: data.hostname,
              name: newName,
              ip: rinfo.address,
              platform: data.platform
            })
          }
        }
      } catch {}
    })

    this.socket.on('error', (err) => {
      this.emit('log', `UDP socket 错误: ${err.message}`)
    })

    // 显式绑定到 0.0.0.0 确保接收所有接口的广播
    this.socket.bind(UDP_PORT, '0.0.0.0', () => {
      this.socket.setBroadcast(true)
      this.startBroadcasting()
      this.startCleanup()
      this.emit('log', `UDP 发现服务已启动，端口: ${UDP_PORT}`)
    })
  }

  startBroadcasting() {
    const broadcast = () => {
      const message = JSON.stringify(this.getDeviceInfo())
      const msgBuffer = Buffer.from(message, 'utf-8')

      // 1. 有限广播 255.255.255.255
      try {
        this.socket.send(msgBuffer, UDP_PORT, '255.255.255.255')
      } catch {}

      // 2. 子网定向广播（更可靠，有些路由器不转发 255.255.255.255）
      const subnetAddresses = this.getBroadcastAddresses()
      for (const addr of subnetAddresses) {
        try {
          this.socket.send(msgBuffer, UDP_PORT, addr)
        } catch {}
      }
    }

    broadcast()
    this.broadcastTimer = setInterval(broadcast, this.broadcastInterval)
  }

  // 运行中动态调整广播间隔（全局设置 → 互联与传输 → 设备扫描频率）
  setBroadcastInterval(ms) {
    const interval = Math.min(10000, Math.max(1000, parseInt(ms, 10) || 3000))
    this.broadcastInterval = interval
    if (this.isRunning && this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.startBroadcasting()
    }
    return interval
  }

  startCleanup() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [deviceId, device] of this.discoveredDevices) {
        if (now - device.lastSeen > DEVICE_TIMEOUT) {
          this.discoveredDevices.delete(deviceId)
          this.emit('device-lost', deviceId)
        }
      }
    }, 5000)
  }

  stop() {
    this.isRunning = false
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer)
      this.broadcastTimer = null
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
    this.discoveredDevices.clear()
  }

  // 修复：逐个 emit 已发现的设备
  refresh() {
    for (const device of this.discoveredDevices.values()) {
      this.emit('device-found', {
        deviceId: device.deviceId,
        hostname: device.hostname,
        name: device.name || device.hostname,
        ip: device.ip,
        platform: device.platform
      })
    }
  }

  getDiscoveredDevices() {
    return Array.from(this.discoveredDevices.values())
  }
}

module.exports = { UDPDiscovery, UDP_PORT }
