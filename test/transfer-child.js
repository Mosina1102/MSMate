// 大文件互传端到端测试子进程（由 upload-e2e-test.js 拉起，勿单独运行）
// ROLE 必须按角色区分（同机子进程否则生成相同 deviceId）；NOACK=1 吞掉 complete-ack 模拟老版本接收方
process.env.MSC_DEVICE_ID = process.env.ROLE || 'X'
const fs = require('fs')
const crypto = require('crypto')
const { TCPAgent } = require('../server/tcpAgent')
const { AuthManager } = require('../server/authManager')

const auth = new AuthManager(process.env.DATA_DIR)
const agent = new TCPAgent(auth)
agent.setDeviceName(process.env.ROLE)
agent.start(parseInt(process.env.PORT, 10))

const send = (m) => { try { process.send(m) } catch {} }

// 配对码流程上报（与 pair-child 一致）
agent.on('incoming-pair-request', (d) => send({ type: 'pair-request', deviceId: d.deviceId, pairCode: d.pairCode, isV2: d.isV2 }))
agent.on('pair:required', (d) => send({ type: 'pair-required', deviceId: d.deviceId }))
agent.on('auto-accepted', () => send({ type: 'auto-accepted' }))

// 吞 ack 模式：模拟 2.7.11 这类不回 complete-ack 的老版本接收方（走 10 秒兜底）
if (process.env.NOACK === '1') {
  const orig = agent.sendMsg.bind(agent)
  agent.sendMsg = (socket, type, data, requestId) => {
    if (type === 'file-transfer-complete-ack') return
    return orig(socket, type, data, requestId)
  }
}

// 接收完成时刻（含写盘 flush 完毕）
agent.on('file-transfer-complete', (d) => {
  send({ type: 'recv-complete', transferId: d.transferId, path: d.path, size: d.size, t: Date.now() })
})
// 接收进度采样（每 20% 报一次，给主测试做杀进程时机判断）
const lastRecvProgress = {}
agent.on('file-transfer-progress', (d) => {
  if (d.incoming && d.progress >= (lastRecvProgress[d.transferId] || 0) + 20) {
    lastRecvProgress[d.transferId] = d.progress
    send({ type: 'recv-progress', progress: d.progress, fileName: d.fileName })
  }
})
// 关键日志透传（断流保护触发等）
agent.on('log', (line) => {
  if (String(line).includes('[接收]')) send({ type: 'log-line', line })
})

process.on('message', async (m) => {
  if (m.type === 'query') {
    send({ type: 'ready', deviceId: agent.deviceId })
    return
  }
  if (m.type === 'connect') {
    const r = await agent.connectByIP(m.ip, m.port)
    send({ type: 'connect-result', success: r.success, error: r.error })
  } else if (m.type === 'verify') {
    const r = await agent.sendPairVerifyCode(m.deviceId, m.code)
    send({ type: 'verify-result', success: r.success, error: r.error })
  } else if (m.type === 'upload') {
    const t0 = Date.now()
    try {
      const r = await agent.uploadFile(m.deviceId, m.localPath, m.remoteDir, true)
      send({ type: 'upload-result', success: r.success === true, error: r.error || null, t0, t1: Date.now() })
    } catch (err) {
      send({ type: 'upload-result', success: false, error: err.message, t0, t1: Date.now() })
    }
  } else if (m.type === 'sha') {
    try {
      const h = crypto.createHash('sha512')
      const s = fs.createReadStream(m.path)
      s.on('data', (c) => h.update(c))
      s.on('end', () => send({ type: 'sha-result', sha: h.digest('hex'), size: fs.statSync(m.path).size }))
      s.on('error', (e) => send({ type: 'sha-result', error: e.message }))
    } catch (e) {
      send({ type: 'sha-result', error: e.message })
    }
  } else if (m.type === 'transfers') {
    send({
      type: 'transfers-result',
      count: agent.transfers.size,
      entries: [...agent.transfers.entries()].map(([k, v]) => ({ id: k.slice(0, 8), type: v.type, dest: v.destPath || v.localPath || '', status: v.status }))
    })
  } else if (m.type === 'unlock-check') {
    // 文件句柄是否仍被锁：能改名 = 已解锁（打不开的根源就是写入句柄未关）
    try {
      fs.renameSync(m.path, m.path + '.t')
      fs.renameSync(m.path + '.t', m.path)
      send({ type: 'unlock-result', unlocked: true })
    } catch (e) {
      send({ type: 'unlock-result', unlocked: false, error: e.message })
    }
  }
})
