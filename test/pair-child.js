// 临时测试：配对码流程子进程（测完删除）
// MSC_DEVICE_ID 必须按角色区分：同机两个子进程否则会生成相同 deviceId（真实场景两台电脑 id 天然不同）
process.env.MSC_DEVICE_ID = process.env.ROLE || 'X'
const { TCPAgent } = require('../server/tcpAgent')
const { AuthManager } = require('../server/authManager')

const auth = new AuthManager(process.env.DATA_DIR)
const agent = new TCPAgent(auth)
agent.setDeviceName(process.env.ROLE)
agent.start(parseInt(process.env.PORT, 10))

const send = (m) => { try { process.send(m) } catch {} }

agent.on('incoming-pair-request', (d) => send({ type: 'pair-request', deviceId: d.deviceId, pairCode: d.pairCode, isV2: d.isV2 }))
agent.on('pair:required', (d) => send({ type: 'pair-required', deviceId: d.deviceId, isV2: d.isV2 }))
agent.on('pair:auto-accepted', (d) => send({ type: 'auto-accepted', deviceId: d.deviceId }))
agent.on('connection-status', (d) => { if (d.status === 'connected') send({ type: 'connection-connected', deviceId: d.deviceId }) })

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
  } else if (m.type === 'trust') {
    send({ type: 'trust-result', deviceId: m.deviceId, trusted: auth.isDeviceTrusted(m.deviceId) })
  } else if (m.type === 'conns') {
    send({ type: 'conns-result', connections: [...agent.connections.keys()], pending: [...agent.pendingSockets.keys()] })
  } else if (m.type === 'self-dial') {
    // 自连测试：拨自己的端口并发 hello，服务端应拒绝（不激活、不写信任）
    const r = await agent.connectByIP('127.0.0.1', parseInt(process.env.PORT, 10))
    send({ type: 'self-dial-result', success: r.success })
  } else if (m.type === 'trust-self') {
    send({ type: 'trust-self-result', trusted: auth.isDeviceTrusted(agent.deviceId), trustCount: Object.keys(auth.trustList).length })
  }
})
