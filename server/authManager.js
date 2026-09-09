const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

class AuthManager {
  constructor(userDataPath) {
    this.dataDir = userDataPath
    this.trustListPath = path.join(this.dataDir, 'trust-list.json')
    this.trustList = this.loadTrustList()
    this.ownDeviceId = null
    this.currentPairCode = null
    this.currentPairCodeExpiry = 0
  }

  // 绑定本机 id：清理历史脏数据（旧版本 bug 会把"自己"写进信任表），并守住所有写入/查询
  setOwnDeviceId(deviceId) {
    this.ownDeviceId = deviceId
    if (deviceId && deviceId in this.trustList) {
      delete this.trustList[deviceId]
      this.saveTrustList()
    }
  }

  _isSelf(deviceId) {
    return this.ownDeviceId && deviceId === this.ownDeviceId
  }

  loadTrustList() {
    try {
      if (fs.existsSync(this.trustListPath)) {
        return JSON.parse(fs.readFileSync(this.trustListPath, 'utf-8'))
      }
    } catch {}
    return {}
  }

  saveTrustList() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.trustListPath, JSON.stringify(this.trustList, null, 2))
    } catch (err) {
      console.error('Failed to save trust list:', err)
    }
  }

  generatePairCode() {
    // 幂等：当前码未过期时直接复用，避免顶栏"配对码"按钮覆盖进行中的配对流程
    if (this.currentPairCode && Date.now() < this.currentPairCodeExpiry) {
      return this.currentPairCode
    }
    const code = crypto.randomInt(100000, 999999).toString()
    this.currentPairCode = code
    this.currentPairCodeExpiry = Date.now() + 5 * 60 * 1000
    return code
  }

  verifyPairCode(code) {
    if (!this.currentPairCode) return false
    if (Date.now() > this.currentPairCodeExpiry) return false
    return code === this.currentPairCode
  }

  clearPairCode() {
    this.currentPairCode = null
    this.currentPairCodeExpiry = 0
  }

  isDeviceTrusted(deviceId) {
    if (this._isSelf(deviceId)) return false // 自己永远不信任自己
    return deviceId in this.trustList
  }

  addTrustedDevice(deviceId, deviceInfo) {
    if (this._isSelf(deviceId)) return false // 拒绝把本机写进信任表（历史 bug 根源）
    this.trustList[deviceId] = {
      ...deviceInfo,
      addedAt: Date.now()
    }
    this.saveTrustList()
    return true
  }

  removeDevice(deviceId) {
    delete this.trustList[deviceId]
    this.saveTrustList()
  }

  getTrustedDevices() {
    return Object.entries(this.trustList)
      .filter(([id]) => !this._isSelf(id))
      .map(([id, info]) => ({
        deviceId: id,
        ...info
      }))
  }

  updateDeviceInfo(deviceId, info) {
    if (this.trustList[deviceId] && !this._isSelf(deviceId)) {
      this.trustList[deviceId] = { ...this.trustList[deviceId], ...info }
      this.saveTrustList()
    }
  }
}

module.exports = { AuthManager }