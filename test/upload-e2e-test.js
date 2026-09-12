// 大文件互传端到端回归测试（node test/upload-e2e-test.js）
// 事故背景：2.7.22→2.7.11 传 188MB 安装包，进度 71% 弹"上传成功"，接收端文件残缺且句柄锁死点不开。
// 根因：uploadFile 的 ack 兜底定时器在上传一开始就启动，大文件传输超 10 秒被中途掐流。
// 四道闸：
//   ① 正常传 128MB：sha512 两端一致 + 成功时刻晚于接收方写完盘
//   ② 源码结构断言：ack 定时器必须武装在 readStream 'end' 之后（防再犯，确定性闸门）
//   ③ 对端不回 ack（模拟老版本）：成功必须发生在"文件发完后 ~10 秒兜底"，且文件完整
//   ④ 发送方暴毙：接收端断流保护（3 秒档）自动关流解锁文件、清理 transfers
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const PORT_A = 46121
const PORT_B = 46122
const PORT_B2 = 46123
const TMP = path.join(__dirname, '.tmp-upload-e2e')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS  ${msg}`)
  else { failures++; console.error(`  FAIL  ${msg}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function startChild(role, port, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, 'transfer-child.js')], {
    env: {
      ...process.env,
      ROLE: role,
      PORT: String(port),
      DATA_DIR: dataDir,
      MSC_RECEIVE_STALL_MS: '3000',
      ...extraEnv
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  child.on('error', (e) => console.error(`[${role}] spawn error:`, e.message))
  child.on('exit', (code) => console.error(`[${role}] exited:`, code))
  child.recvCompletes = []
  child.waiters = []
  child.on('message', (m) => {
    if (m.type === 'recv-complete') child.recvCompletes.push(m)
    child.waiters = child.waiters.filter(w => {
      if (w.type === m.type && (!w.match || w.match(m))) { w.resolve(m); return false }
      return true
    })
  })
  child.waitFor = (type, match, timeout = 15000) => new Promise((resolve, reject) => {
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
  child.ask = (msg, replyType, match, timeout = 20000) => {
    child.send(msg)
    return child.waitFor(replyType, match, timeout)
  }
  return child
}

// 两台"设备"配对激活（复用 pair-test 的流程）
async function pair(A, B, bPort) {
  B.on('message', () => {})
  const pReqPromise = B.waitFor('pair-request')
  A.send({ type: 'connect', ip: '127.0.0.1', port: bPort })
  const pReq = await pReqPromise
  const r = await A.ask({ type: 'verify', deviceId: B.deviceId, code: pReq.pairCode }, 'verify-result')
  if (!r.success) throw new Error('配对失败: ' + r.error)
  await sleep(400)
}

// 生成随机文件并返回 sha512
function makeFile(filePath, sizeMB) {
  const buf = crypto.randomBytes(4 * 1024 * 1024)
  const h = crypto.createHash('sha512')
  const fd = fs.openSync(filePath, 'w')
  const chunks = Math.ceil((sizeMB * 1024 * 1024) / buf.length)
  for (let i = 0; i < chunks; i++) {
    const piece = i === chunks - 1 ? buf.subarray(0, sizeMB * 1024 * 1024 - (chunks - 1) * buf.length) : buf
    fs.writeSync(fd, piece)
    h.update(piece)
  }
  fs.closeSync(fd)
  return h.digest('hex')
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })

  console.log('[1] 启动收发双方并配对（接收方 B 断流保护 3 秒档）')
  const B = startChild('DeviceB', PORT_B, path.join(TMP, 'b'))
  const A = startChild('DeviceA', PORT_A, path.join(TMP, 'a'))
  B.deviceId = (await B.readyPromise).deviceId
  A.deviceId = (await A.readyPromise).deviceId
  await pair(A, B, PORT_B)

  console.log('[2] 闸①：正常上传 128MB → 成功且 sha512 两端一致，成功不早于接收方写完盘')
  const bigPath = path.join(TMP, 'big.bin')
  const bigSha = makeFile(bigPath, 128)
  const recvDir = path.join(TMP, 'b-recv')
  fs.mkdirSync(recvDir, { recursive: true })
  const ul1 = await A.ask({ type: 'upload', deviceId: B.deviceId, localPath: bigPath, remoteDir: recvDir }, 'upload-result', null, 60000)
  assert(ul1.success === true, `128MB 上传报成功（耗时 ${((ul1.t1 - ul1.t0) / 1000).toFixed(1)}s）`)
  const recvDone1 = B.recvCompletes[B.recvCompletes.length - 1]
  assert(!!recvDone1, '接收方收到 file-transfer-complete（写盘完毕）')
  if (recvDone1) {
    assert(ul1.t1 >= recvDone1.t, '成功时刻不早于接收方写完盘（此前 71% 就弹成功）')
    assert(recvDone1.size === 128 * 1024 * 1024, `接收方报告大小一致（${recvDone1.size} 字节）`)
  }
  const shaA1 = await A.ask({ type: 'sha', path: bigPath }, 'sha-result')
  const shaB1 = await B.ask({ type: 'sha', path: path.join(recvDir, 'big.bin') }, 'sha-result')
  assert(shaB1.sha === bigSha && shaA1.sha === bigSha, 'sha512 两端与源文件一致（文件完整无残缺）')
  const trB = await B.ask({ type: 'transfers' }, 'transfers-result')
  assert(trB.count === 0, '接收方 transfers 已清理，无残留句柄')

  console.log('[3] 闸②：源码结构断言——ack 兜底定时器必须武装在文件流 end 之后')
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'tcpAgent.js'), 'utf8')
  const idxUpload = src.indexOf('async uploadFile(')
  const idxEndU = src.indexOf("readStream.on('end'", idxUpload)
  const idxErrU = src.indexOf("readStream.on('error'", idxUpload)
  const idxTimer = src.indexOf('ackTimeout = setTimeout')
  assert(idxUpload !== -1 && idxEndU !== -1 && idxTimer > idxEndU && idxTimer < idxErrU,
    'ackTimeout 定时器在 uploadFile 的 readStream end 回调内（上传开始即启动的旧写法已根除）')

  console.log('[4] 闸③：对端不回 ack（模拟老版本）→ 成功须发生在文件发完后 ~10 秒兜底，且文件完整')
  const B2 = startChild('DeviceB2', PORT_B2, path.join(TMP, 'b2'), { NOACK: '1' })
  B2.deviceId = (await B2.readyPromise).deviceId
  await pair(A, B2, PORT_B2)
  const t0 = Date.now()
  const ul2 = await A.ask({ type: 'upload', deviceId: B2.deviceId, localPath: bigPath, remoteDir: path.join(TMP, 'b2-recv') }, 'upload-result', null, 90000)
  const recvDone2 = B2.recvCompletes[B2.recvCompletes.length - 1]
  assert(ul2.success === true, '无 ack 对端上传仍报成功（10 秒兜底放行，不卡死用户）')
  if (recvDone2) {
    const gap = ul2.t1 - recvDone2.t
    assert(gap >= 8500 && gap <= 15000, `成功发生在写完盘后 ${gap}ms ∈ [8.5s, 15s]（若定时器在开局启动，此值 = 10s − 传输时长，会明显偏小）`)
    const shaB2 = await B2.ask({ type: 'sha', path: path.join(TMP, 'b2-recv', 'big.bin') }, 'sha-result')
    assert(shaB2.sha === bigSha, '无 ack 对端文件同样完整（sha512 一致）')
  } else {
    assert(false, '无 ack 对端未收到 file-transfer-complete')
  }

  console.log('[5] 闸④：发送方暴毙 → 接收端 3 秒断流保护关流解锁，transfers 清零')
  const A2 = startChild('DeviceA2', PORT_A + 10, path.join(TMP, 'a2'))
  A2.deviceId = (await A2.readyPromise).deviceId
  await pair(A2, B, PORT_B)
  const killPath = path.join(TMP, 'kill.bin')
  makeFile(killPath, 300)
  const firstProgress = B.waitFor('recv-progress', (m) => m.fileName === 'kill.bin' && m.progress >= 20, 60000)
  const stallLog = B.waitFor('log-line', (m) => m.line.includes('传输中断'), 15000).catch(() => null)
  A2.send({ type: 'upload', deviceId: B.deviceId, localPath: killPath, remoteDir: recvDir })
  await firstProgress
  A2.kill('SIGKILL')
  const triggered = await stallLog
  assert(!!triggered, '断流保护触发：3 秒无数据即关流并记录日志')
  let cleaned = false
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    const t = await B.ask({ type: 'transfers' }, 'transfers-result')
    if (t.count === 0) { cleaned = true; break }
  }
  assert(cleaned, '接收方 transfers 条目已清理（写入流 end 关闭，句柄释放）')
  const killFile = path.join(recvDir, 'kill.bin')
  await B.ask({ type: 'unlock-check', path: killFile }, 'unlock-result', (m) => m.unlocked, 5000)
    .then(() => assert(true, '残缺文件已可正常访问（此前"点不开"的根源已消除）'))
    .catch(() => assert(false, '残缺文件仍被句柄锁死'))

  A.kill(); B.kill(); B2.kill()
  await sleep(300)
  fs.rmSync(TMP, { recursive: true, force: true })

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}; process.exit(1) })
