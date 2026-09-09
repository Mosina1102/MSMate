// 配对码全流程多实例测试（node test/pair-test.js）
// 覆盖：未配对不激活、业务拦截前提、错码拒绝、对码互信激活、重连免验证
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const PORT_A = 46101
const PORT_B = 46102
const TMP = path.join(__dirname, '.tmp-pair-test')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.error(`  FAIL  ${msg}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function startChild(role, port, dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, 'pair-child.js')], {
    env: {
      ...process.env,
      ROLE: role,
      PORT: String(port),
      DATA_DIR: dataDir,
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  child.on('error', (e) => console.error(`[${role}] spawn error:`, e.message))
  child.on('exit', (code) => console.error(`[${role}] exited:`, code))
  child.listeners = {}
  child.waiters = []
  child.on('message', (m) => {
    if (child.listeners[m.type]) child.listeners[m.type](m)
    child.waiters = child.waiters.filter(w => {
      if (w.type === m.type && (!w.match || w.match(m))) { w.resolve(m); return false }
      return true
    })
  })
  child.waitFor = (type, match, timeout = 8000) => new Promise((resolve, reject) => {
    const w = { type, match, resolve }
    child.waiters.push(w)
    setTimeout(() => {
      const i = child.waiters.indexOf(w)
      if (i !== -1) { child.waiters.splice(i, 1); reject(new Error(`等待 ${type} 超时`)) }
    }, timeout)
  })
  // 轮询握手：子进程收到 query 才回 ready，规避 IPC 通道未就绪的消息丢失
  child.readyPromise = new Promise((resolve, reject) => {
    const timer = setInterval(() => { try { child.send({ type: 'query' }) } catch {} }, 150)
    child.waiters.push({ type: 'ready', match: null, resolve: (m) => { clearInterval(timer); resolve(m) } })
    setTimeout(() => { clearInterval(timer); reject(new Error('子进程启动超时')) }, 10000)
  })
  child.ask = (msg, replyType, match, timeout = 8000) => {
    child.send(msg)
    return child.waitFor(replyType, match, timeout)
  }
  return child
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })

  console.log('[1] 启动接收方 B 与发起方 A（全新数据目录，互不信任）')
  const B = startChild('DeviceB', PORT_B, path.join(TMP, 'b'))
  const A = startChild('DeviceA', PORT_A, path.join(TMP, 'a'))
  const readyB = await B.readyPromise
  const readyA = await A.readyPromise
  const bId = readyB.deviceId, aId = readyA.deviceId

  console.log('[2] A 连接 B → 期待 B 收到配对请求（显码），A 收到输码要求，双方均未激活')
  B.on('message', () => {})
  const pReqPromise = B.waitFor('pair-request')
  A.send({ type: 'connect', ip: '127.0.0.1', port: PORT_B })
  const pReq = await pReqPromise
  assert(/^\d{6}$/.test(pReq.pairCode), `B 显示 6 位配对码（${pReq.pairCode}）`)
  assert(pReq.isV2 === true, 'B 识别对方为 2.0 设备')
  await A.waitFor('pair-required')
  assert(true, 'A 收到输码要求（pair:required）')

  await sleep(300)
  const aConns1 = await A.ask({ type: 'conns' }, 'conns-result')
  const bConns1 = await B.ask({ type: 'conns' }, 'conns-result')
  assert(aConns1.connections.length === 0 && aConns1.pending.length === 1, 'A：连接未激活，挂在 pending')
  assert(bConns1.connections.length === 0 && bConns1.pending.length === 1, 'B：连接未激活，挂在 pending')

  console.log('[3] A 输错码 → 被拒绝，连接仍可用（还能重试）')
  // verify 的 deviceId 传"目标设备（B）的 id"——与真实渲染层一致（pair-request 里的 deviceId 是对端视角，不能直接用）
  const bad1 = await A.ask({ type: 'verify', deviceId: bId, code: '000000' }, 'verify-result')
  assert(bad1.success === false, '错码被拒绝')
  const bad2 = await A.ask({ type: 'verify', deviceId: bId, code: '999999' }, 'verify-result')
  assert(bad2.success === false, '第二次错码被拒绝')

  console.log('[4] A 输对码 → 双方互信、连接激活')
  const bAutoAccepted = B.waitFor('auto-accepted')
  const ok = await A.ask({ type: 'verify', deviceId: bId, code: pReq.pairCode }, 'verify-result')
  assert(ok.success === true, '配对码校验通过')
  await bAutoAccepted
  assert(true, 'B 收到自动配对完成通知')
  await sleep(300)
  const aConns2 = await A.ask({ type: 'conns' }, 'conns-result')
  const bConns2 = await B.ask({ type: 'conns' }, 'conns-result')
  assert(aConns2.connections.length === 1, 'A：连接已激活')
  assert(aConns2.connections.includes(bId), 'A：连接注册在 B 的 id 名下（修复"已连接自己的电脑"）')
  assert(bConns2.connections.length === 1, 'B：连接已激活')
  const aTrust = await A.ask({ type: 'trust', deviceId: bId }, 'trust-result')
  const bTrust = await B.ask({ type: 'trust', deviceId: aId }, 'trust-result')
  assert(aTrust.trusted && bTrust.trusted, '双向信任已建立并持久化')

  console.log('[5] B 重启（保留信任数据）→ A 重连 → 双方直接连接，无配对流程')
  B.kill()
  await sleep(500)
  const PORT_B2 = PORT_B + 1  // 避开旧端口 TIME_WAIT
  const B2 = startChild('DeviceB', PORT_B2, path.join(TMP, 'b'))
  await B2.readyPromise

  let sawPairFlow = false
  B2.on('message', (m) => { if (m.type === 'pair-request') sawPairFlow = true })
  const aConnected = A.waitFor('connection-connected', null, 8000).catch(() => null)
  A.send({ type: 'connect', ip: '127.0.0.1', port: PORT_B2 })
  await aConnected
  await sleep(500)
  const aConns3 = await A.ask({ type: 'conns' }, 'conns-result')
  const bConns3 = await B2.ask({ type: 'conns' }, 'conns-result')
  assert(!sawPairFlow, '重连未触发配对码流程')
  assert(aConns3.connections.length === 1 && aConns3.pending.length === 0, 'A：直接激活，无 pending')
  assert(bConns3.connections.length === 1 && bConns3.pending.length === 0, 'B：直接激活，无 pending')

  console.log('[6] 回归：B 丢失信任数据（模拟重装）→ A 重连不许"假连接"，须重新配对')
  B2.kill()
  await sleep(500)
  fs.rmSync(path.join(TMP, 'b'), { recursive: true, force: true })  // B 信任记录清空，A 仍保留
  const PORT_B3 = PORT_B + 2  // 避开旧端口 TIME_WAIT
  const B3 = startChild('DeviceB', PORT_B3, path.join(TMP, 'b'))
  await B3.readyPromise

  const pReq2Promise = B3.waitFor('pair-request')
  const aPairRequired = A.waitFor('pair-required', null, 8000).catch(() => null)
  A.send({ type: 'connect', ip: '127.0.0.1', port: PORT_B3 })
  const pReq2 = await pReq2Promise
  await aPairRequired
  assert(true, 'B 重新显码，A 收到输码要求')
  await sleep(300)
  const aConns4 = await A.ask({ type: 'conns' }, 'conns-result')
  assert(aConns4.connections.length === 0 && aConns4.pending.length === 1,
    'A：未输码前绝不激活（修复单向信任假连接：A 显示已连接但文件访问被拦）')

  // 关键回归：模拟真实渲染层把"目标设备自己的 id"当 deviceId 传给 verify（旧 bug 传参），
  // B 端必须把信任写到对端真实 id（aId）上，而不是照抄消息里的字段
  const bAutoAccepted2 = B3.waitFor('auto-accepted')
  const ok2 = await A.ask({ type: 'verify', deviceId: bId, code: pReq2.pairCode }, 'verify-result')
  assert(ok2.success === true, '配对码校验通过')
  await bAutoAccepted2
  await sleep(300)
  const aConns5 = await A.ask({ type: 'conns' }, 'conns-result')
  const bConns4 = await B3.ask({ type: 'conns' }, 'conns-result')
  assert(aConns5.connections.length === 1 && aConns5.connections.includes(bId) && aConns5.pending.length === 0,
    'A：输码后激活且注册在 B 的 id 名下')
  assert(bConns4.connections.length === 1 && bConns4.pending.length === 0, 'B：输码后激活')
  const bTrust2 = await B3.ask({ type: 'trust', deviceId: aId }, 'trust-result')
  assert(bTrust2.trusted, 'B 信任的是 A 的真实 deviceId（修复信任写错对象导致每次重连都要重新配对）')

  console.log('[7] 回归：修好后再次重连 → 双方秒连免配对')
  B3.kill()
  await sleep(500)
  const PORT_B4 = PORT_B + 3
  const B4 = startChild('DeviceB', PORT_B4, path.join(TMP, 'b'))
  await B4.readyPromise
  let sawPairFlow2 = false
  B4.on('message', (m) => { if (m.type === 'pair-request') sawPairFlow2 = true })
  const aConnected2 = A.waitFor('connection-connected', null, 8000).catch(() => null)
  A.send({ type: 'connect', ip: '127.0.0.1', port: PORT_B4 })
  await aConnected2
  await sleep(500)
  const aConns6 = await A.ask({ type: 'conns' }, 'conns-result')
  const bConns5 = await B4.ask({ type: 'conns' }, 'conns-result')
  assert(!sawPairFlow2, '重连未触发配对码流程')
  assert(aConns6.connections.length === 1 && aConns6.pending.length === 0, 'A：秒连激活')
  assert(bConns5.connections.length === 1 && bConns5.pending.length === 0, 'B：秒连激活')

  console.log('[8] 回归：自连拦截（设备列表混入本机时，绝不能和自己配对/激活）')
  await A.ask({ type: 'self-dial' }, 'self-dial-result')
  await sleep(600) // 等服务端拒绝、客户端清理
  const aSelfConns = await A.ask({ type: 'conns' }, 'conns-result')
  const aSelfTrust = await A.ask({ type: 'trust-self' }, 'trust-self-result')
  assert(aSelfConns.connections.length === 1, '自连被拦截：连接数不变（只有 B）')
  assert(aSelfConns.pending.length === 0, '自连未留下 pending 僵尸连接')
  assert(aSelfTrust.trusted === false, '自己永远不会被写进/视为信任')
  const aTrustB = await A.ask({ type: 'trust', deviceId: bId }, 'trust-result')
  assert(aTrustB.trusted, '自连拦截不影响已有 B 的信任')

  A.kill(); B4.kill()

  console.log('[9] 回归：信任表自净化（旧版本 bug 曾把"自己"写进 trust-list.json）')
  const { AuthManager } = require('../server/authManager')
  const dirtyDir = path.join(TMP, 'dirty')
  fs.mkdirSync(dirtyDir, { recursive: true })
  const dirtyData = { SELF123: { name: '自己', addedAt: Date.now() }, PEER456: { name: '真设备', addedAt: Date.now() } }
  fs.writeFileSync(path.join(dirtyDir, 'trust-list.json'), JSON.stringify(dirtyData))
  const am = new AuthManager(dirtyDir)
  am.setOwnDeviceId('SELF123')
  assert(!('SELF123' in am.trustList) && am.trustList.PEER456, '启动即清掉"自己"，保留真设备')
  assert(am.isDeviceTrusted('SELF123') === false, 'isDeviceTrusted(自己) 永远 false')
  assert(am.addTrustedDevice('SELF123', { name: '自己' }) === false, '拒绝把本机写进信任表')
  assert(!('SELF123' in am.trustList), '写入确实未发生')
  assert(am.getTrustedDevices().length === 1 && am.getTrustedDevices()[0].deviceId === 'PEER456', 'getTrustedDevices 不含自己')

  fs.rmSync(TMP, { recursive: true, force: true })

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
