// msmate-api v0.3 全接口自测：起临时实例（独立 DATA_DIR + 随机端口），逐接口断言
// 覆盖：验证码（dev 模式）→ 注册 → me → 限流 → 登录 → 充值订单/凭证/批款 → 积分到账
//       → 密码重置（旧 token 吊销）→ 头像上传/静态服务 → 云同步 PUT/GET
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = 35000 + Math.floor(Math.random() * 10000)
const BASE = `http://127.0.0.1:${PORT}`
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-api-test-'))

let pass = true
const check = (label, cond, extra) => {
  console.log((cond ? '✅' : '❌') + ' ' + label + (cond || extra === undefined ? '' : `  ← ${JSON.stringify(extra).slice(0, 200)}`))
  if (!cond) pass = false
}

const jpost = (p, body, token) => fetch(BASE + p, {
  method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body || {})
}).then(async r => ({ code: r.status, j: await r.json() }))

const jget = (p, token) => fetch(BASE + p, {
  headers: token ? { Authorization: 'Bearer ' + token } : {}
}).then(async r => ({ code: r.status, j: await r.json() }))

async function main() {
  // 1x1 PNG（合法 base64 头像）
  const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  const ping = await jget('/ping')
  check('ping 存活且版本 0.7.0', ping.code === 200 && ping.j.version === '0.7.0', ping)

  // ── 注册（验证码流程）──
  const email = `t${Date.now()}@test.dev`
  const sc = await jpost('/v1/auth/send-code', { email, scene: 'register' })
  check('send-code dev 模式返回 devCode', sc.code === 200 && /^\d{6}$/.test(sc.j.devCode || ''), sc)
  const badReg = await jpost('/v1/auth/register', { email, password: 'password123', code: '000000' })
  check('错误验证码注册被拒', badReg.code === 400, badReg)
  const reg = await jpost('/v1/auth/register', { email, password: 'password123', nickname: '测试喵', code: sc.j.devCode })
  check('验证码注册成功', reg.code === 200 && reg.j.token && reg.j.user.email === email, reg)
  const token = reg.j.token
  const uid = reg.j.user.id

  // ── me ──
  const me = await jget('/v1/auth/me', token)
  check('me：credits=0 / avatarUrl 为空', me.code === 200 && me.j.user.credits === 0 && me.j.user.avatarUrl === '', me)

  // ── 充值订单 ──
  const o1 = await jpost('/v1/credits/orders', { amount: 1 }, token)
  check('创建 1 元订单 → 100 积分', o1.code === 200 && o1.j.order.credits === 100 && o1.j.order.status === 'pending', o1)
  const badO = await jpost('/v1/credits/orders', { amount: 999 }, token)
  check('超限金额被拒', badO.code === 400, badO)
  const myEmpty = await jget('/v1/credits/orders/my', token)
  check('我的订单可见', myEmpty.code === 200 && myEmpty.j.orders.length === 1, myEmpty)

  // 凭证校验
  const badV = await jpost(`/v1/credits/orders/${o1.j.order.id}/voucher`, { voucher: '12' }, token)
  check('过短凭证被拒', badV.code === 400, badV)
  const v1 = await jpost(`/v1/credits/orders/${o1.j.order.id}/voucher`, { voucher: '1000668899' }, token)
  check('提交凭证 → reviewing', v1.code === 200 && v1.j.order.status === 'reviewing', v1)

  // ── 批款后台 ──
  const badLogin = await jpost('/admin/api/login', { key: 'wrong' })
  check('错误密钥被拒', badLogin.code === 401, badLogin)
  const adminKey = fs.readFileSync(path.join(DATA, 'admin.key'), 'utf8').trim()
  const aLogin = await jpost('/admin/api/login', { key: adminKey })
  check('正确密钥登录后台', aLogin.code === 200 && aLogin.j.token, aLogin)
  const aTok = aLogin.j.token
  const noAuth = await jget('/admin/api/orders?status=reviewing')
  check('无 token 访问后台被拒', noAuth.code === 401, noAuth)
  const list = await jget('/admin/api/orders?status=reviewing', aTok)
  check('后台待审列表含该订单（带用户邮箱）', list.code === 200 && list.j.orders.length === 1 && list.j.orders[0].email === email, list)
  const ap = await jpost(`/admin/api/orders/${o1.j.order.id}/approve`, {}, aTok)
  check('批款通过', ap.code === 200 && ap.j.order.status === 'done', ap)
  const me2 = await jget('/v1/auth/me', token)
  check('积分到账 100', me2.code === 200 && me2.j.user.credits === 100, me2)
  const ap2 = await jpost(`/admin/api/orders/${o1.j.order.id}/approve`, {}, aTok)
  check('重复批款被拒', ap2.code === 400, ap2)

  // 拒绝流
  const o2 = await jpost('/v1/credits/orders', { amount: 3 }, token)
  await jpost(`/v1/credits/orders/${o2.j.order.id}/voucher`, { voucher: '1000998877' }, token)
  const rj = await jpost(`/admin/api/orders/${o2.j.order.id}/reject`, { reason: '未查到收款' }, aTok)
  check('拒绝订单', rj.code === 200 && rj.j.order.status === 'rejected' && rj.j.order.rejectReason === '未查到收款', rj)
  const bal = await jget('/v1/credits/balance', token)
  check('余额仍为 100（拒绝不加积分）', bal.code === 200 && bal.j.credits === 100, bal)

  // ── 头像 ──
  const badA = await jpost('/v1/auth/avatar', { dataUrl: 'data:text/html;base64,PGI+' }, token)
  check('非图片头像被拒', badA.code === 400, badA)
  const av = await jpost('/v1/auth/avatar', { dataUrl: PNG1x1 }, token)
  check('头像上传成功且返回 avatarUrl', av.code === 200 && /\/avatars\/[\w-]+\.png\?v=\d+/.test(av.j.user.avatarUrl || ''), av)
  const avUrl = av.j.user.avatarUrl
  const avRes = await fetch(BASE + avUrl.split('?')[0])
  check('头像静态服务可访问', avRes.status === 200 && (avRes.headers.get('content-type') || '').startsWith('image/png'), avRes.status)

  // ── 云同步 ──
  const put1 = await fetch(BASE + '/v1/sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ blob: { sessions: [{ id: 's1', title: '会话一' }], settings: { theme: 'butler' } } })
  })
  check('云同步 PUT 成功', put1.status === 200 && (await put1.json()).ok, put1.status)
  const get1 = await jget('/v1/sync', token)
  check('云同步 GET 返回 blob', get1.code === 200 && get1.j.blob && get1.j.blob.sessions[0].title === '会话一', get1)
  const putBig = await fetch(BASE + '/v1/sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ blob: { pad: 'x'.repeat(6 * 1024 * 1024) } })
  })
  check('超过 5MB 的 blob 被拒', putBig.status === 413, putBig.status)
  const noSync = await jget('/v1/sync', 'fake.token.here.here')
  check('伪造 token 同步被拒', noSync.code === 401, noSync)

  // ── 密码重置（pwdV 吊销旧 token）──
  const rs = await jpost('/v1/auth/send-code', { email, scene: 'reset' })
  check('reset 验证码下发', rs.code === 200 && /^\d{6}$/.test(rs.j.devCode || ''), rs)
  const oldToken = token
  const reset = await jpost('/v1/auth/reset', { email, code: rs.j.devCode, password: 'newpassword456' })
  check('重置密码成功并返回新 token', reset.code === 200 && reset.j.token, reset)
  const oldMe = await jget('/v1/auth/me', oldToken)
  check('旧 token 已被吊销（pwdV）', oldMe.code === 401, oldMe)
  const newLogin = await jpost('/v1/auth/login', { email, password: 'newpassword456' })
  check('新密码登录成功', newLogin.code === 200 && newLogin.j.user.credits === 100, newLogin)

  // ── 改昵称 ──
  const pf = await fetch(BASE + '/v1/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + newLogin.j.token },
    body: JSON.stringify({ nickname: '改名字喵' })
  })
  const pfJ = await pf.json()
  check('改昵称成功', pf.status === 200 && pfJ.user.nickname === '改名字喵', pfJ)

  // ── 验证码限流（放最后：同 IP 每小时 20 条会把额度烧光）──
  let ipLimited = false
  for (let i = 0; i < 21; i++) {
    const r = await jpost('/v1/auth/send-code', { email: `bulk${Date.now()}-${i}@test.dev`, scene: 'register' })
    if (r.code === 429) { ipLimited = true; break }
  }
  check('同 IP 连发验证码触发小时限流', ipLimited)

  console.log('\n' + (pass ? '🎉 全部通过' : '💥 有失败项'))
  process.exit(pass ? 0 : 1)
}

const srv = spawn(process.execPath, [path.join(__dirname, '../api-server/server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA, MSMATE_CODE_COOLDOWN_MS: '0' }),
  stdio: ['ignore', 'pipe', 'pipe']
})
srv.stdout.on('data', () => {})
srv.stderr.on('data', d => console.error('[srv-err]', String(d).trim()))
setTimeout(() => main().catch(e => { console.error(e); process.exit(1) }).finally(() => srv.kill()), 600)
