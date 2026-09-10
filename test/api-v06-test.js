// msmate-api v0.6 测试：应用层加密（pubkey/解密登录）+ 反馈 API + 后台新接口（stats/users/devices/feedback）
// 起本地 server.js（DATA_DIR 隔离临时目录，MSMATE_MAIL 不设 = dev 模式拿 devCode）
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-api-v06-'))
let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    } }, (res) => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => { let j = {}; try { j = JSON.parse(buf) } catch { } resolve({ status: res.statusCode, data: j, raw: buf }) })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

const serverPath = path.join(ROOT, 'api-server', 'server.js')
let PORT = 0

async function main() {
  // 起 server（固定随机端口：PORT=0 时启动日志打的是 :0，拿不到实际端口）
  const { spawn } = require('child_process')
  PORT = 30000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [serverPath], {
    env: Object.assign({}, process.env, { DATA_DIR, PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server 启动超时')), 10000)
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening on')) { clearTimeout(timer); resolve() }
    })
    child.stderr.on('data', (d) => process.stderr.write(d))
  })
  child.stdout.on('data', () => { })

  // ① 健康检查 + 版本
  const ping = await req('GET', '/ping')
  ok('ping 返回 v0.6.0', ping.status === 200 && ping.data.version === '0.6.0', ping.raw)

  // ② RSA 公钥下发
  const pk = await req('GET', '/v1/auth/pubkey')
  ok('pubkey 端点返回 PEM 公钥', pk.status === 200 && pk.data.ok && /BEGIN PUBLIC KEY/.test(pk.data.pubkey || ''))

  // ③ dev 模式拿注册验证码
  const email = 'v06test@example.com'
  const sc = await req('POST', '/v1/auth/send-code', { email, scene: 'register' })
  ok('send-code 返回 devCode', sc.status === 200 && sc.data.ok && sc.data.devCode, sc.raw)

  // ④ RSA 加密注册（passwordEnc）
  function enc(pubkey, text) {
    return crypto.publicEncrypt({ key: pubkey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(text, 'utf8')).toString('base64')
  }
  const password = 'test-pass-12345'
  const reg = await req('POST', '/v1/auth/register', {
    email, passwordEnc: enc(pk.data.pubkey, password), nickname: 'v06', code: sc.data.devCode, agree: 'v1'
  })
  ok('register 用 passwordEnc 注册成功（服务端解密）', reg.status === 200 && reg.data.ok && reg.data.token, reg.raw)
  const token = reg.data.token

  // ⑤ 加密登录
  const login = await req('POST', '/v1/auth/login', { email, passwordEnc: enc(pk.data.pubkey, password) })
  ok('login 用 passwordEnc 登录成功', login.status === 200 && login.data.ok && login.data.token, login.raw)

  // ⑥ 旧客户端兼容：明文 password 也能登录
  const loginOld = await req('POST', '/v1/auth/login', { email, password })
  ok('明文 password 兼容登录（过渡期）', loginOld.status === 200 && loginOld.data.ok, loginOld.raw)

  // ⑦ 坏密文拒绝
  const badEnc = await req('POST', '/v1/auth/login', { email, passwordEnc: 'AAAA' + enc(pk.data.pubkey, password).slice(4) })
  ok('损坏的 passwordEnc 被拒绝', badEnc.status === 401, badEnc.raw)

  // ⑧ 反馈提交
  const fb1 = await req('POST', '/v1/feedback', { type: 'bug', content: '传输大文件时进度条偶尔卡住', contact: 'qq:123456' }, token)
  ok('feedback 提交成功', fb1.status === 200 && fb1.data.ok && fb1.data.seq === 1, fb1.raw)
  const fb2 = await req('POST', '/v1/feedback', { type: 'idea', content: '希望支持暗色主题的文件图标' }, token)
  ok('第二条反馈 seq=2', fb2.data.ok && fb2.data.seq === 2, fb2.raw)

  // ⑨ 反馈限流（每小时 5 条，已发 2 条 → 再发 3 条成功，第 6 条拒绝）
  for (let i = 0; i < 3; i++) await req('POST', '/v1/feedback', { type: 'idea', content: '填充反馈' + i }, token)
  const fb6 = await req('POST', '/v1/feedback', { type: 'idea', content: '第 6 条应该被限流' }, token)
  ok('反馈限流：第 6 条 429', fb6.status === 429, fb6.raw)

  // ⑩ 反馈内容过短
  const fbShort = await req('POST', '/v1/feedback', { type: 'bug', content: '短' }, token)
  ok('过短反馈 400', fbShort.status === 400, fbShort.raw)

  // ⑪ 后台登录（ADMIN_PASS 未设 → data/admin.key 自动生成）
  const adminKey = fs.readFileSync(path.join(DATA_DIR, 'admin.key'), 'utf8').trim()
  const al = await req('POST', '/admin/api/login', { key: adminKey })
  ok('后台登录成功（admin.key）', al.status === 200 && al.data.ok, al.raw)
  const at = al.data.token

  // ⑫ stats
  const stats = await req('GET', '/admin/api/stats', null, at)
  const s = stats.data.stats || {}
  ok('stats：用户数=1', stats.data.ok && s.users === 1, stats.raw)
  ok('stats：未读反馈=5', s.feedback && s.feedback.open === 5, JSON.stringify(s.feedback))
  ok('stats：orders 结构齐', s.orders && typeof s.orders.reviewing === 'number')

  // ⑬ users
  const users = await req('GET', '/admin/api/users', null, at)
  ok('users 列表含注册用户（paid=0）', users.data.ok && users.data.users.length === 1 && users.data.users[0].paid === 0, users.raw)

  // ⑭ devices
  const devices = await req('GET', '/admin/api/devices', null, at)
  ok('devices 接口可达（无心跳=空）', devices.data.ok && Array.isArray(devices.data.devices) && devices.data.onlineCount === 0, devices.raw)

  // ⑮ feedback 列表 + resolve
  const fbList = await req('GET', '/admin/api/feedback?filter=open', null, at)
  ok('反馈列表 open=5', fbList.data.ok && fbList.data.items.length === 5 && fbList.data.openCount === 5, fbList.raw)
  const fid = fbList.data.items[0].id
  const rs = await req('POST', `/admin/api/feedback/${fid}/resolve`, {}, at)
  ok('标记已处理', rs.data.ok, rs.raw)
  const fbList2 = await req('GET', '/admin/api/feedback?filter=open', null, at)
  ok('resolve 后 open=4', fbList2.data.openCount === 4, fbList2.raw)

  // ⑯ 未授权访问拒绝
  const noAuth = await req('GET', '/admin/api/stats')
  ok('后台接口未授权 401', noAuth.status === 401, noAuth.raw)
  const noFb = await req('POST', '/v1/feedback', { type: 'bug', content: '未登录的反馈应被拒' })
  ok('反馈未登录 401', noFb.status === 401, noFb.raw)

  child.kill()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'} (${pass}/${pass + fail})`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('TEST_ERROR', e); process.exit(1) })
