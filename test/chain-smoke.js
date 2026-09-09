// 多设备链式连接测试（node test/chain-smoke.js）
// 验证：A-B 配对 + A-C 配对共存互不打扰；三方连接注册键名正确
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const TMP = path.join(__dirname, '.tmp-chain-test')
const PORTS = { A: 46301, B: 46302, C: 46303 }

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.error(`  FAIL  ${msg}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function startChild(role, port, dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, 'pair-child.js')], {
    env: { ...process.env, ROLE: role, PORT: String(port), DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  child.on('exit', (code) => console.error(`[${role}] exited:`, code))
  child.waiters = []
  child.on('message', (m) => {
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

  console.log('[1] 启动 A / B / C 三个独立实例')
  const A = startChild('DeviceA', PORTS.A, path.join(TMP, 'a'))
  const B = startChild('DeviceB', PORTS.B, path.join(TMP, 'b'))
  const C = startChild('DeviceC', PORTS.C, path.join(TMP, 'c'))
  const [rA, rB, rC] = await Promise.all([A.readyPromise, B.readyPromise, C.readyPromise])
  const aId = rA.deviceId, bId = rB.deviceId, cId = rC.deviceId
  assert(aId !== bId && aId !== cId && bId !== cId, '三实例 deviceId 互不相同')

  console.log('[2] B 连接 A → 配对激活')
  {
    const pReq = A.waitFor('pair-request')
    B.send({ type: 'connect', ip: '127.0.0.1', port: PORTS.A })
    const req = await pReq
    const ack = B.waitFor('connection-connected') // 发起方激活 = 自己的连接状态变 connected
    const ok = await B.ask({ type: 'verify', deviceId: aId, code: req.pairCode }, 'verify-result')
    assert(ok.success === true, 'B 输码通过')
    await ack
    await sleep(300)
  }

  console.log('[3] C 连接 A → 配对激活（与 B 的连接共存）')
  {
    const pReq = A.waitFor('pair-request')
    C.send({ type: 'connect', ip: '127.0.0.1', port: PORTS.A })
    const req = await pReq
    const ack = C.waitFor('connection-connected')
    const ok = await C.ask({ type: 'verify', deviceId: aId, code: req.pairCode }, 'verify-result')
    assert(ok.success === true, 'C 输码通过')
    await ack
    await sleep(300)
  }

  console.log('[4] 三方连接表互不打扰')
  const aConns = await A.ask({ type: 'conns' }, 'conns-result')
  const bConns = await B.ask({ type: 'conns' }, 'conns-result')
  const cConns = await C.ask({ type: 'conns' }, 'conns-result')
  assert(aConns.connections.length === 2 && aConns.connections.includes(bId) && aConns.connections.includes(cId),
    'A：同时持有 B 和 C 两条连接，键名正确')
  assert(aConns.pending.length === 0, 'A：无 pending 残留')
  assert(bConns.connections.length === 1 && bConns.connections.includes(aId), 'B：只连着 A')
  assert(cConns.connections.length === 1 && cConns.connections.includes(aId), 'C：只连着 A')

  console.log('[5] B 与 C 互不信任（链式隔离）')
  const bTrustC = await B.ask({ type: 'trust', deviceId: cId }, 'trust-result')
  const cTrustB = await C.ask({ type: 'trust', deviceId: bId }, 'trust-result')
  assert(!bTrustC.trusted && !cTrustB.trusted, 'B/C 之间没有产生信任交叉')

  console.log('[6] 断开 B → A 与 C 的连接不受影响')
  B.kill()
  await sleep(600)
  const aConns2 = await A.ask({ type: 'conns' }, 'conns-result')
  assert(aConns2.connections.length === 1 && aConns2.connections.includes(cId), 'A：只剩 C，C 的连接完好')

  A.kill(); C.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })
