// msmate-api v0.7 WS 测试：/ws 握手 + 鉴权 + 消息路由 + PKCS1v15 兼容注册
// 手写极简 WS 客户端（协议层全真跑）；上游 SF_API_KEY 不设 → chat/image 走"未配置"错误路径
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-ws-'))
const PORT = 30000 + Math.floor(Math.random() * 20000)
let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

function httpReq(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    } }, (res) => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { let j = {}; try { j = JSON.parse(buf) } catch { } resolve({ status: res.statusCode, data: j }) })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

// 极简 WS 客户端：握手 + 帧收发（客户端帧必须 mask）
function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: '127.0.0.1', port, path: '/ws',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    })
    req.on('upgrade', (res, socket) => {
      const client = { socket, buffer: Buffer.alloc(0), frames: [], waiters: [], closed: false }
      socket.on('data', (c) => {
        client.buffer = Buffer.concat([client.buffer, c])
        for (;;) {
          const buf = client.buffer
          if (buf.length < 2) break
          const opcode = buf[0] & 0x0f
          let len = buf[1] & 0x7f
          let off = 2
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
          if (buf.length < off + len) break
          const payload = buf.slice(off, off + len)
          client.buffer = buf.slice(off + len)
          if (opcode === 0x8) { client.closed = true; socket.destroy(); break }
          if (opcode !== 0x1) continue // pong 等忽略
          let msg = null
          try { msg = JSON.parse(payload.toString('utf8')) } catch { }
          if (msg) {
            const w = client.waiters.shift()
            if (w) w(msg)
            else client.frames.push(msg)
          }
        }
      })
      socket.on('close', () => { client.closed = true })
      client.send = (obj) => {
        const data = Buffer.from(JSON.stringify(obj))
        const mask = crypto.randomBytes(4)
        let head
        if (data.length < 126) { head = Buffer.alloc(2); head[0] = 0x81; head[1] = 0x80 | data.length }
        else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2) }
        const masked = Buffer.alloc(data.length)
        for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4]
        socket.write(Buffer.concat([head, mask, masked]))
      }
      client.waitMsg = (timeout = 8000) => new Promise((res2, rej2) => {
        if (client.frames.length) return res2(client.frames.shift())
        const t = setTimeout(() => rej2(new Error('等待消息超时')), timeout)
        client.waiters.push((m) => { clearTimeout(t); res2(m) })
      })
      resolve(client)
    })
    req.on('error', reject)
    req.end()
  })
}

async function main() {
  const { spawn } = require('child_process')
  const child = spawn(process.execPath, [path.join(ROOT, 'api-server', 'server.js')], {
    env: Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT) }), // 故意不设 SF_API_KEY → AI 走"未配置"错误路径
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server 启动超时')), 10000)
    child.stdout.on('data', (d) => { if (String(d).includes('listening on')) { clearTimeout(timer); resolve() } })
    child.stderr.on('data', (d) => process.stderr.write(d))
  })

  // ① 注册用户（拿真 token）
  const email = 'wstest@example.com'
  const sc = await httpReq('POST', '/v1/auth/send-code', { email, scene: 'register' })
  // 服务端 RSA 公钥（拿来做 PKCS1v15 加密注册，模拟手机端 jsencrypt）
  const pk = await httpReq('GET', '/v1/auth/pubkey')
  const password = crypto.randomBytes(12).toString('hex') + 'Aa1'
  const pkcs1Enc = crypto.publicEncrypt({ key: pk.data.pubkey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8')).toString('base64')
  const reg = await httpReq('POST', '/v1/auth/register', { email, passwordEnc: pkcs1Enc, code: sc.data.devCode, agree: 'v1' })
  ok('PKCS1v15 加密注册成功（手机端 jsencrypt 同款 padding）', reg.status === 200 && reg.data.ok, reg.raw || '')
  const token = reg.data.token
  ok('PKCS1v15 加密登录成功', (await httpReq('POST', '/v1/auth/login', { email, passwordEnc: pkcs1Enc })).data.ok)

  // ② WS 握手
  const c1 = await wsConnect(PORT)
  ok('WS 握手 101 成功', !!c1.socket)

  // ③ 未鉴权发业务帧 → auth.fail
  c1.send({ t: 'chat.send', id: 'x1' })
  const m1 = await c1.waitMsg()
  ok('未鉴权发业务帧被拒（auth.fail）', m1.t === 'auth.fail', JSON.stringify(m1))

  // ④ 重连 + 坏 token → auth.fail
  const c2 = await wsConnect(PORT)
  c2.send({ t: 'auth', token: 'bad.token.here' })
  const m2 = await c2.waitMsg()
  ok('坏 token → auth.fail', m2.t === 'auth.fail', JSON.stringify(m2))

  // ⑤ 好 token → auth.ok + credits
  const c3 = await wsConnect(PORT)
  c3.send({ t: 'auth', token })
  const m3 = await c3.waitMsg()
  ok('好 token → auth.ok 且带积分余额', m3.t === 'auth.ok' && typeof m3.credits === 'number', JSON.stringify(m3))

  // ⑥ ping → pong
  c3.send({ t: 'ping' })
  const m4 = await c3.waitMsg()
  ok('ping → pong', m4.t === 'pong', JSON.stringify(m4))

  // ⑦ chat.send：新用户 0 积分 → 先撞余额预检（与 HTTP 版门槛顺序一致）；协议层路由已通
  c3.send({ t: 'chat.send', id: 'c1', body: { model: 'deepseek-ai/DeepSeek-V4-Flash', messages: [{ role: 'user', content: '你好' }] } })
  const m5 = await c3.waitMsg()
  ok('chat.send 路由通（0 积分先撞余额预检）', m5.t === 'error' && m5.id === 'c1' && /积分不足/.test(m5.error), JSON.stringify(m5))

  // ⑧ 非法模型 → 模型清单校验
  c3.send({ t: 'chat.send', id: 'c2', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } })
  const m6 = await c3.waitMsg()
  ok('非法模型被清单拦截', m6.t === 'error' && /模型不在内置清单/.test(m6.error), JSON.stringify(m6))

  // ⑨ image.gen → 未配置错误
  c3.send({ t: 'image.gen', id: 'i1', prompt: '一只戴紫领结的猫' })
  const m7 = await c3.waitMsg()
  ok('image.gen 路由通（未配置 Key 报错）', m7.t === 'error' && m7.id === 'i1', JSON.stringify(m7))

  // ⑩ video.gen → 未开放提示
  c3.send({ t: 'video.gen', id: 'v1', prompt: '海浪' })
  const m8 = await c3.waitMsg()
  ok('video.gen 未开放提示', m8.t === 'error' && /即将开放/.test(m8.error), JSON.stringify(m8))

  // ⑪ 未知类型
  c3.send({ t: 'nonsense' })
  const m9 = await c3.waitMsg()
  ok('未知消息类型报错', m9.t === 'error' && /未知消息类型/.test(m9.error), JSON.stringify(m9))

  // ⑫ 错误路径后连接仍活着（再 ping 通）
  c3.send({ t: 'ping' })
  const m10 = await c3.waitMsg()
  ok('错误后连接存活（再 ping 通）', m10.t === 'pong', JSON.stringify(m10))

  child.kill()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'} (${pass}/${pass + fail})`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('TEST_ERROR', e); process.exit(1) })
