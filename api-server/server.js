// MSMate API 服务 v0.3 —— 零依赖（Node 内置模块），PM2/Docker 均可跑
// 接口：
//   GET  /ping                     健康检查
//   GET  /v1/latest                客户端检查更新
//   GET  /v1/myip                  调用者公网 IP（真远程辅助）
//   POST /v1/auth/send-code        发邮箱验证码 {email, scene: register|reset}
//   POST /v1/auth/register         邮箱注册 {email, password, nickname?, code, agree:'v1'} → {token, user}
//   POST /v1/auth/login            邮箱登录 {email, password}              → {token, user}
//   POST /v1/auth/reset            验证码重置密码 {email, code, password}
//   GET  /v1/auth/me               Bearer token 查当前用户                 → {user}
//   PATCH /v1/auth/profile         改昵称 {nickname}
//   POST /v1/auth/avatar           上传头像 {dataUrl}（≤200KB base64）
//   GET  /avatars/<uid>.<ext>      头像静态服务
//   GET/PUT /v1/sync               云同步 blob（≤5MB，服务端不管结构）
//   POST /v1/credits/orders        创建充值订单 {amount}（元，1-500，¥1=100积分）
//   POST /v1/credits/orders/:id/voucher  提交付款凭证 {voucher}
//   GET  /v1/credits/orders/my     我的订单
//   GET  /v1/credits/balance       积分余额
//   POST /admin/api/login          批款后台登录 {key}（密钥在 data/admin.key）
//   GET  /admin/api/orders         订单列表 ?status=
//   POST /admin/api/orders/:id/approve | /reject  批款
//   GET  /admin                    批款后台网页（手机可用）
// 数据：data/users.json、data/orders.json、data/sync/<uid>.json、
//       data/avatars/<uid>.<ext>、data/admin.key、data/secret.key
// 邮件：MSMATE_MAIL=on 且配置 SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS 后发真邮件；
//       未配置时为 dev 模式——验证码打印到日志并随接口返回 devCode（仅供联调）

const http = require('http')
const url = require('url')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const tls = require('tls')

const PORT = process.env.PORT || 3210
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json')
const SECRET_FILE = path.join(DATA_DIR, 'secret.key')
const ADMIN_KEY_FILE = path.join(DATA_DIR, 'admin.key')
const SYNC_DIR = path.join(DATA_DIR, 'sync')
const AVATAR_DIR = path.join(DATA_DIR, 'avatars')
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000 // 30 天
const ADMIN_TTL_MS = 3600 * 1000 // 后台会话 1 小时
const CODE_TTL_MS = 5 * 60 * 1000 // 验证码 5 分钟
const SYNC_MAX_BYTES = 5 * 1024 * 1024
const AVATAR_MAX_BYTES = 200 * 1024

const MAIL_ON = process.env.MSMATE_MAIL === 'on'
const MAIL_CFG = {
  host: process.env.SMTP_HOST || '',
  port: +(process.env.SMTP_PORT || 465),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || ''
}

// ─────────────────── 基础工具 ───────────────────

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(SYNC_DIR, { recursive: true })
  fs.mkdirSync(AVATAR_DIR, { recursive: true })
}

function loadSecret() {
  ensureDataDir()
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim()
    if (s.length >= 64) return s
  } catch {}
  const s = crypto.randomBytes(48).toString('hex')
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 })
  return s
}

function loadAdminKey() {
  ensureDataDir()
  try {
    const s = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim()
    if (s.length >= 32) return s
  } catch {}
  const s = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(ADMIN_KEY_FILE, s, { mode: 0o600 })
  return s
}

const SECRET = loadSecret()

// 管理密钥：优先环境变量 ADMIN_PASS（自定义密码，≥6 位），未设置则自动生成 data/admin.key
const ADMIN_KEY = String(process.env.ADMIN_PASS || '').trim().length >= 6
  ? String(process.env.ADMIN_PASS).trim()
  : loadAdminKey()

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  return fallback
}

function saveJson(file, obj) {
  ensureDataDir()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

function loadUsers() {
  const j = loadJson(USERS_FILE, { users: [] })
  return j && Array.isArray(j.users) ? j : { users: [] }
}
const saveUsers = (db) => saveJson(USERS_FILE, db)

function loadOrders() {
  const j = loadJson(ORDERS_FILE, { orders: [] })
  return j && Array.isArray(j.orders) ? j : { orders: [] }
}
const saveOrders = (db) => saveJson(ORDERS_FILE, db)

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
}

// token 结构：uid.exp.随机数.密码版本.签名（pwdV 用于重置密码后吊销旧 token）
function issueToken(uid, pwdV) {
  const exp = Date.now() + TOKEN_TTL_MS
  const nonce = crypto.randomBytes(8).toString('hex')
  const payload = `${uid}.${exp}.${nonce}.${pwdV}`
  return `${payload}.${sign(payload)}`
}

function verifyToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 5) return null
  const [uid, expStr, nonce, pwdV] = parts
  const payload = `${uid}.${expStr}.${nonce}.${pwdV}`
  const expect = sign(payload)
  const sig = parts[4]
  // 常数时间比较防时序攻击
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  if (!Number.isFinite(+expStr) || Date.now() > +expStr) return null
  const pwdVNum = +pwdV
  if (!Number.isFinite(pwdVNum)) return null
  return { uid, pwdV: pwdVNum, exp: +expStr }
}

// 后台会话 token：adm.exp.随机数.签名
function issueAdminToken() {
  const exp = Date.now() + ADMIN_TTL_MS
  const nonce = crypto.randomBytes(8).toString('hex')
  const payload = `adm.${exp}.${nonce}`
  return `${payload}.${sign(payload)}`
}

function verifyAdminToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`
  const expect = sign(payload)
  if (parts[3].length !== expect.length || !crypto.timingSafeEqual(Buffer.from(parts[3]), Buffer.from(expect))) return null
  if (parts[0] !== 'adm' || !Number.isFinite(+parts[1]) || Date.now() > +parts[1]) return null
  return true
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254
}

function isValidPassword(s) {
  return typeof s === 'string' && s.length >= 8 && s.length <= 72
}

// ─────────────────── 限流：每 IP 每分钟 10 次 ───────────────────

const rateBuckets = new Map()

function rateLimited(ip) {
  const now = Date.now()
  const b = rateBuckets.get(ip)
  if (!b || now > b.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + 60000 })
    return false
  }
  b.count++
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k)
  }
  return b.count > 10
}

// 验证码发送限流：同邮箱冷却（默认 60 秒，可配 MSMATE_CODE_COOLDOWN_MS）；同 IP 每小时 20 条
const CODE_COOLDOWN_MS = Math.max(0, +(process.env.MSMATE_CODE_COOLDOWN_MS ?? 60000))
const codeCooldown = new Map() // email → 上次发送时间
const codeIpBucket = new Map() // ip → {count, resetAt}

function codeSendLimited(email, ip) {
  const now = Date.now()
  const last = codeCooldown.get(email)
  if (CODE_COOLDOWN_MS > 0 && last && now - last < CODE_COOLDOWN_MS) return '发送太频繁，请一分钟后再试'
  const b = codeIpBucket.get(ip)
  if (!b || now > b.resetAt) {
    codeIpBucket.set(ip, { count: 1, resetAt: now + 3600000 })
  } else {
    b.count++
    if (b.count > 20) return '今日发送次数已达上限，请明天再试'
  }
  codeCooldown.set(email, now)
  return null
}

// ─────────────────── 邮箱验证码（内存存储，5 分钟有效） ───────────────────

const mailCodes = new Map() // email → {code, scene, exp}

function makeCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

// 验证码邮件 HTML 模板：table 布局 + 全内联样式（邮件客户端兼容），无外部图片零裂图
function codeMailHtml(code, scene) {
  const title = scene === 'reset' ? '重置登录密码' : '注册 MSMate 账号'
  const hello = scene === 'reset'
    ? '你正在找回 MSMate 账号的登录密码'
    : '欢迎加入 MSMate！你正在注册一个新账号'
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f9;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(60,50,120,0.10);">
<tr><td style="background:#6c4ce0;padding:24px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:40px;height:40px;background:rgba(255,255,255,0.18);border-radius:10px;text-align:center;font-size:22px;font-weight:700;color:#ffffff;font-family:Arial,sans-serif;">M</td>
<td style="padding-left:12px;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:1px;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">MSMate</td>
<td style="padding-left:12px;font-size:12px;color:rgba(255,255,255,0.72);font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">你的 AI 工作台</td>
</tr></table>
</td></tr>
<tr><td style="padding:30px 32px 6px;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="font-size:18px;font-weight:700;color:#22222a;">${title}</div>
<div style="font-size:14px;color:#55555f;line-height:1.8;margin-top:8px;">${hello}。请在应用中输入以下验证码完成操作：</div>
</td></tr>
<tr><td style="padding:16px 32px 6px;">
<div style="background:#f4f1fe;border:1px solid #e4dcfc;border-radius:12px;padding:22px 0;text-align:center;">
<span style="font-size:34px;font-weight:700;color:#6c4ce0;letter-spacing:10px;font-family:Consolas,'Courier New',monospace;">${code}</span>
<div style="font-size:12px;color:#8a84a0;margin-top:10px;">验证码 5 分钟内有效，超时请重新获取</div>
</div>
</td></tr>
<tr><td style="padding:18px 32px 0;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="font-size:12px;color:#9a96a8;line-height:1.9;">若非本人操作，请忽略本邮件，你的账号不会受任何影响。<br>为保障账户安全，请勿将验证码透露给任何人，MSMate 工作人员不会向你索取验证码。</div>
</td></tr>
<tr><td style="padding:26px 32px 24px;font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="border-top:1px solid #ececf2;padding-top:16px;font-size:12px;color:#b0adc0;line-height:1.8;">本邮件由 MSMate 系统自动发送，请勿直接回复。<br>&copy; 2026 MSMate &middot; mosina.top</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

// 零依赖 SMTP 客户端：TLS 直连（465），顺序状态机
function sendMail(to, subject, text, html) {
  return new Promise((resolve, reject) => {
    const { host, port, user, pass, from } = MAIL_CFG
    if (!host || !user || !pass) return reject(new Error('SMTP 未配置'))
    let step = 0
    let buf = ''
    const b64 = (s) => Buffer.from(s).toString('base64')
    // 有 html 时走 multipart/alternative：老客户端看纯文本，现代客户端看 HTML
    let dataBody
    if (html) {
      const bd = 'msmate-' + crypto.randomBytes(10).toString('hex')
      dataBody = [
        `From: MSMate <${from}>`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${bd}"`,
        '',
        `--${bd}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        text,
        '',
        `--${bd}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        '',
        `--${bd}--`,
        '.'
      ].join('\r\n')
    } else {
      dataBody = [
        `From: MSMate <${from}>`,
        `To: <${to}>`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        text,
        '.'
      ].join('\r\n')
    }
    const cmds = [
      null, // 等 220
      'EHLO msmate',
      'AUTH LOGIN',
      b64(user),
      b64(pass),
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      dataBody,
      'QUIT'
    ]
    const sock = tls.connect({ host, port, servername: host }, () => {})
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('SMTP 超时')) })
    sock.on('error', (e) => reject(e))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      // 多行响应以 "NNN "（空格）结尾才算完整
      if (!/\r?\n\d{3} (?:-|$)/.test(buf) && !/\r?\n\d{3}-/.test(buf)) {
        // 继续等
      }
      const lines = buf.split(/\r?\n/)
      const last = lines[lines.length - 2] || lines[0] || ''
      if (!/^\d{3} /.test(last)) return
      const code = +last.slice(0, 3)
      buf = ''
      if (code >= 500) { sock.destroy(); reject(new Error(`SMTP ${code}: ${last}`)); return }
      if (step === 0) {
        if (code !== 220) { sock.destroy(); reject(new Error(`SMTP greeting ${code}`)); return }
      } else if (step === 5 && code !== 250) { // MAIL FROM
        sock.destroy(); reject(new Error(`SMTP from ${code}`)); return
      } else if (step === 6 && code !== 250) { // RCPT TO
        sock.destroy(); reject(new Error(`SMTP rcpt ${code}`)); return
      } else if (step === 8 && code !== 250) { // DATA 结束
        sock.destroy(); reject(new Error(`SMTP data ${code}`)); return
      }
      step++
      if (step < cmds.length) {
        if (cmds[step]) sock.write(cmds[step] + '\r\n')
      } else {
        sock.end()
        resolve()
      }
    })
  })
}

async function handleSendCode(req, res, body, ip) {
  const limited = codeSendLimited(String(body.email || '').toLowerCase(), ip)
  if (limited) return json(res, 429, { ok: false, error: limited })
  const email = String(body.email || '').trim().toLowerCase()
  const scene = body.scene === 'reset' ? 'reset' : 'register'
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })

  const db = loadUsers()
  const exists = db.users.some(u => u.email === email)
  if (scene === 'register' && exists) return json(res, 409, { ok: false, error: '该邮箱已注册，请直接登录' })
  if (scene === 'reset' && !exists) return json(res, 404, { ok: false, error: '该邮箱未注册' })

  const code = makeCode()
  mailCodes.set(email, { code, scene, exp: Date.now() + CODE_TTL_MS })
  const subj = scene === 'reset' ? '【MSMate】密码重置验证码' : '【MSMate】注册验证码'
  const text = [
    `【MSMate】${scene === 'reset' ? '密码重置' : '注册'}验证码`,
    '',
    `你的验证码是：${code}`,
    '',
    '验证码 5 分钟内有效，超时请重新获取。',
    '若非本人操作，请忽略本邮件，你的账号不会受任何影响。',
    '为保障账户安全，请勿将验证码透露给任何人。',
    '',
    '— MSMate · mosina.top'
  ].join('\n')
  if (MAIL_ON) {
    try {
      await sendMail(email, subj, text, codeMailHtml(code, scene))
      json(res, 200, { ok: true, sent: true })
    } catch (e) {
      console.error('[mail] 发送失败:', e.message)
      json(res, 502, { ok: false, error: '邮件发送失败，请稍后再试' })
    }
  } else {
    // dev 模式：不配置 SMTP 时验证码随响应返回（仅供本地联调，生产必须配置 MSMATE_MAIL=on）
    console.warn(`[mail] DEV 模式验证码 ${email} → ${code}`)
    json(res, 200, { ok: true, sent: false, devCode: code })
  }
}

function checkCode(email, scene, code) {
  const rec = mailCodes.get(email)
  if (!rec || rec.scene !== scene || rec.exp < Date.now()) return false
  if (rec.code !== String(code || '').trim()) return false
  mailCodes.delete(email) // 一次性
  return true
}

// ─────────────────── 用户业务 ───────────────────

function publicUser(u) {
  const ext = u.avatarExt || 'png'
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname || '',
    credits: u.credits || 0,
    sign: u.sign || { total: 0, lastDate: '' },
    avatarUrl: u.avatarExt ? `/avatars/${u.id}.${ext}?v=${u.avatarV || 0}` : '',
    createdAt: u.createdAt
  }
}

// Bearer token → 用户对象（含 pwdV 校验），失败返回 null
function authUser(req) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const t = verifyToken(token)
  if (!t) return null
  const user = loadUsers().users.find(u => u.id === t.uid)
  if (!user || (user.pwdV || 1) !== t.pwdV) return null
  return user
}

async function handleAuthRegister(req, res, body, ip) {
  if (rateLimited(ip)) return json(res, 429, { ok: false, error: '操作过于频繁，请一分钟后再试' })
  const email = String(body.email || '').trim().toLowerCase()
  const password = body.password
  const nickname = String(body.nickname || '').trim().slice(0, 32)
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })
  if (!isValidPassword(password)) return json(res, 400, { ok: false, error: '密码需要 8-72 位' })
  // 协议同意必须先于验证码校验：未同意直接拒绝，不消耗验证码（防扯皮：注册记录即协议存档）
  if (body.agree !== 'v1') return json(res, 400, { ok: false, error: '请先阅读并勾选同意《MSMate 用户协议》' })
  if (!checkCode(email, 'register', body.code)) return json(res, 400, { ok: false, error: '验证码错误或已过期' })

  const db = loadUsers()
  if (db.users.some(u => u.email === email)) return json(res, 409, { ok: false, error: '该邮箱已注册' })

  const salt = crypto.randomBytes(16).toString('hex')
  const user = {
    id: crypto.randomUUID(),
    email,
    nickname,
    credits: 0,
    pwdV: 1,
    agreed: 'v1',
    salt,
    passHash: hashPassword(password, salt),
    createdAt: new Date().toISOString()
  }
  db.users.push(user)
  saveUsers(db)
  json(res, 200, { ok: true, token: issueToken(user.id, 1), user: publicUser(user) })
}

async function handleAuthLogin(req, res, body, ip) {
  if (rateLimited(ip)) return json(res, 429, { ok: false, error: '操作过于频繁，请一分钟后再试' })
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')

  const db = loadUsers()
  const user = db.users.find(u => u.email === email)
  // 统一错误文案，不暴露邮箱是否存在
  if (!user) return json(res, 401, { ok: false, error: '邮箱或密码错误' })
  const hash = hashPassword(password, user.salt)
  const ok = hash.length === user.passHash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passHash))
  if (!ok) return json(res, 401, { ok: false, error: '邮箱或密码错误' })
  json(res, 200, { ok: true, token: issueToken(user.id, user.pwdV || 1), user: publicUser(user) })
}

async function handleAuthReset(req, res, body, ip) {
  if (rateLimited(ip)) return json(res, 429, { ok: false, error: '操作过于频繁，请一分钟后再试' })
  const email = String(body.email || '').trim().toLowerCase()
  const password = body.password
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })
  if (!isValidPassword(password)) return json(res, 400, { ok: false, error: '密码需要 8-72 位' })
  if (!checkCode(email, 'reset', body.code)) return json(res, 400, { ok: false, error: '验证码错误或已过期' })

  const db = loadUsers()
  const user = db.users.find(u => u.email === email)
  if (!user) return json(res, 404, { ok: false, error: '该邮箱未注册' })
  const salt = crypto.randomBytes(16).toString('hex')
  user.salt = salt
  user.passHash = hashPassword(password, salt)
  user.pwdV = (user.pwdV || 1) + 1 // 旧 token 全部失效
  user.updatedAt = new Date().toISOString()
  saveUsers(db)
  json(res, 200, { ok: true, token: issueToken(user.id, user.pwdV), user: publicUser(user) })
}

function handleAuthMe(req, res) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const t = verifyToken(token)
  const user = t ? loadUsers().users.find(u => u.id === t.uid) : null
  if (!t || !user || (user.pwdV || 1) !== t.pwdV) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
  // 滑动续签：剩余有效期不足一半（15 天）时换发新 token，客户端存新值
  let fresh = null
  if (t.exp - Date.now() < TOKEN_TTL_MS / 2) fresh = issueToken(user.id, user.pwdV || 1)
  json(res, 200, { ok: true, user: publicUser(user), ...(fresh ? { token: fresh } : {}) })
}

async function handleAuthProfile(req, res, body, user) {
  const nickname = String(body.nickname || '').trim().slice(0, 32)
  const db = loadUsers()
  const u = db.users.find((x) => x.id === user.id)
  if (!u) return json(res, 401, { ok: false, error: '账号不存在' })
  u.nickname = nickname
  u.updatedAt = new Date().toISOString()
  saveUsers(db)
  json(res, 200, { ok: true, user: publicUser(u) })
}

async function handleAuthAvatar(req, res, body, user) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''))
  if (!m) return json(res, 400, { ok: false, error: '仅支持 PNG/JPG 图片' })
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length < 64) return json(res, 400, { ok: false, error: '图片内容无效' })
  if (buf.length > AVATAR_MAX_BYTES) return json(res, 413, { ok: false, error: '图片过大（限 200KB）' })
  const ext = m[1] === 'jpeg' ? 'jpg' : 'png'
  ensureDataDir()
  // 清掉旧扩展名文件，写新头像
  for (const e of ['png', 'jpg']) {
    try { fs.unlinkSync(path.join(AVATAR_DIR, `${user.id}.${e}`)) } catch {}
  }
  fs.writeFileSync(path.join(AVATAR_DIR, `${user.id}.${ext}`), buf)
  const db = loadUsers()
  const u = db.users.find((x) => x.id === user.id)
  if (!u) return json(res, 401, { ok: false, error: '账号不存在' })
  u.avatarExt = ext
  u.avatarV = Date.now()
  u.updatedAt = new Date().toISOString()
  saveUsers(db)
  json(res, 200, { ok: true, user: publicUser(u) })
}

// ─────────────────── 云同步 ───────────────────

function handleSyncGet(req, res) {
  const user = authUser(req)
  if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
  const file = path.join(SYNC_DIR, `${user.id}.json`)
  const j = loadJson(file, null)
  if (!j) return json(res, 200, { ok: true, blob: null, updatedAt: null })
  json(res, 200, { ok: true, blob: j.blob, updatedAt: j.updatedAt })
}

async function handleSyncPut(req, res, body, user) {
  let raw
  try { raw = JSON.stringify(body.blob ?? null) } catch { return json(res, 400, { ok: false, error: 'blob 不可序列化' }) }
  if (raw.length > SYNC_MAX_BYTES) return json(res, 413, { ok: false, error: '同步数据过大（限 5MB）' })
  const file = path.join(SYNC_DIR, `${user.id}.json`)
  saveJson(file, { blob: JSON.parse(raw), updatedAt: new Date().toISOString() })
  json(res, 200, { ok: true })
}

// ─────────────────── 积分充值 ───────────────────

const CREDITS_PER_YUAN = 100
const SHOT_DIR = path.join(DATA_DIR, 'screenshots')
const AUTOREVIEW_FILE = path.join(DATA_DIR, 'auto-review.json')
const FIXED_TIERS = [1, 3, 6, 30, 68, 128]
const AUTOREVIEW_MODEL = 'PaddlePaddle/PaddleOCR-VL-1.5' // 上游免费 OCR：提取截图文字做规则核验，成本为零

function loadAutoReview() {
  try {
    const c = JSON.parse(fs.readFileSync(AUTOREVIEW_FILE, 'utf8'))
    return { enabled: !!c.enabled, payee: String(c.payee || '').slice(0, 32), maxAuto: Math.min(128, Math.max(1, Math.round(+c.maxAuto || 68))) }
  } catch { return { enabled: false, payee: '', maxAuto: 68 } }
}
function saveAutoReview(cfg) {
  fs.writeFileSync(AUTOREVIEW_FILE, JSON.stringify({ enabled: !!cfg.enabled, payee: String(cfg.payee || '').trim().slice(0, 32), maxAuto: Math.min(128, Math.max(1, Math.round(+cfg.maxAuto || 68))) }, null, 2))
}

// 视觉 OCR：PaddleOCR-VL-1.5 走 OpenAI 兼容 chat/completions（image_url base64），返回识别出的全部文字
// （SF_BASE 支持 http:// ——测试用本地 mock 上游）
function sfOcrText(imgPath) {
  return new Promise((resolve, reject) => {
    const mod = require(SF_BASE.startsWith('https') ? 'https' : 'http')
    const b64 = fs.readFileSync(imgPath).toString('base64')
    const payload = JSON.stringify({
      model: AUTOREVIEW_MODEL,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }, { type: 'text', text: '识别并原样输出图片中的全部文字（含金额、收款方、时间等），不要添加任何解释' }] }],
      max_tokens: 1000, stream: false
    })
    const u = new URL(SF_BASE + '/chat/completions')
    const req = mod.request({ hostname: u.hostname, port: u.port || (SF_BASE.startsWith('https') ? 443 : 80), path: u.pathname + (u.search || ''), method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SF_API_KEY, 'Content-Length': Buffer.byteLength(payload) }, timeout: 25000 }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        try {
          const j = JSON.parse(raw)
          const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
          if (!txt) throw new Error('OCR 返回为空')
          resolve(String(txt))
        } catch (e) { reject(new Error('OCR 解析失败: ' + e.message)) }
      })
    })
    req.on('timeout', () => { req.destroy(new Error('OCR 请求超时')) })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// 自动审核（v0.6）：AI 只当录入员——OCR 提取截图文字，规则核验（金额=订单额/档位内、收款方昵称命中、
// 未超自动批上限）；全过 → 自动批款 + ntfy 提醒抽查；任一存疑 → 留在人工队列并附疑点。
// 已知边界：PS 伪造截图防不住（无流水可比对），靠"自动批后 ntfy 抽查 + 大额强制人工"兜底
async function autoReviewOrder(o) {
  const cfg = loadAutoReview()
  const reasons = []
  if (!cfg.enabled) return
  if (!o.screenshot) reasons.push('未上传付款截图')
  if (!cfg.payee) reasons.push('后台未配置收款方昵称')
  if (!FIXED_TIERS.includes(o.amount)) reasons.push('订单金额不是固定档位')
  if (o.amount > cfg.maxAuto) reasons.push(`金额超过自动批上限 ¥${cfg.maxAuto}`)
  if (!reasons.length) {
    try {
      const text = (await sfOcrText(path.join(SHOT_DIR, o.screenshot))).replace(/\s+/g, '')
      const amounts = new Set()
      for (const m of text.matchAll(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)/g)) amounts.add(parseFloat(m[1]))
      const amountOk = amounts.has(o.amount) || amounts.has(Number(o.amount.toFixed(1)))
      const payeeOk = text.includes(String(cfg.payee).replace(/\s+/g, ''))
      if (!amountOk) reasons.push('截图中未找到与订单一致的付款金额')
      if (!payeeOk) reasons.push('截图中未找到收款方昵称')
    } catch (e) {
      reasons.push('截图识别失败（' + e.message + '）')
    }
  }
  o.aiReview = { verdict: reasons.length ? 'manual' : 'auto', reasons, at: new Date().toISOString() }
  o.updatedAt = new Date().toISOString()
  const udb = loadUsers()
  const u = udb.users.find(x => x.id === o.uid)
  if (!reasons.length) {
    // 自动批款：与 handleAdminApprove 同逻辑
    o.status = 'done'
    if (u) u.credits = (u.credits || 0) + o.credits
    saveOrders(loadOrdersBump(o))
    saveUsers(udb)
    notifyAdmin('MSMate 自动批款（请抽查）', `${(u && (u.nickname || u.email)) || '用户'} 的 ¥${o.amount} 订单经截图核验自动到账，请抽空核对收款记录`)
  } else {
    saveOrders(loadOrdersBump(o))
    notifyAdmin('MSMate 待审核充值', `${(u && (u.nickname || u.email)) || '用户'} 提交了 ¥${o.amount} 凭证（AI 存疑：${reasons[0]}），请打开批款后台处理`)
  }
}
// 自动审核结束后把 o 的最新态合并回重载的订单表（防审核期间其他写操作覆盖丢失）
function loadOrdersBump(o) {
  const db = loadOrders()
  const cur = db.orders.find(x => x.id === o.id)
  if (cur) { cur.status = o.status; cur.aiReview = o.aiReview; cur.updatedAt = o.updatedAt }
  return db
}

function orderPublic(o, u) {
  return {
    id: o.id, amount: o.amount, credits: o.credits, status: o.status,
    voucher: o.voucher || '', createdAt: o.createdAt, updatedAt: o.updatedAt,
    rejectReason: o.rejectReason || '', screenshot: o.screenshot || '', aiReview: o.aiReview || null,
    nickname: u ? (u.nickname || '') : '', email: u ? u.email : ''
  }
}

async function handleOrderCreate(req, res, body, user) {
  const amount = Math.round(+(body.amount))
  if (!Number.isFinite(amount) || amount < 1 || amount > 500) return json(res, 400, { ok: false, error: '金额需在 1-500 元之间' })
  const db = loadOrders()
  // 防刷单三层（v0.5）：
  // ① 一人最多 1 个 pending（未提交凭证）占位单——你只要还有一个未付款的单，就不能再开新单，
  //    必须先取消/提交。堵死"挂一排 ¥1 空单占位"的刷法。
  const myPending = db.orders.some(o => o.uid === user.id && o.status === 'pending')
  if (myPending) return json(res, 429, { ok: false, error: '你有一笔订单尚未提交凭证，请先付款/提交或取消后再下单' })
  // ② 待完成（pending+reviewing）总数上限 5，防止一个账号囤积多单干扰人工
  const mine = db.orders.filter(o => o.uid === user.id && (o.status === 'pending' || o.status === 'reviewing'))
  if (mine.length >= 5) return json(res, 429, { ok: false, error: '有太多待完成订单，请先等待审核' })
  const order = {
    id: 'R' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    uid: user.id,
    amount,
    credits: amount * CREDITS_PER_YUAN,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
  db.orders.push(order)
  saveOrders(db)
  json(res, 200, { ok: true, order: orderPublic(order) })
}

async function handleOrderVoucher(req, res, body, user, orderId) {
  const voucher = String(body.voucher || '').trim().slice(0, 32)
  if (voucher.length < 4) return json(res, 400, { ok: false, error: '请填写付款凭证号（微信账单里的转账单号）' })
  // 付款截图（可选但推荐：附图走 AI 自动审核可秒批）：dataUrl ≤400KB，png/jpeg/webp
  let shotFile = ''
  const shotDataUrl = String(body.screenshot || '')
  const shotM = shotDataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)
  if (shotM) {
    const b64 = shotM[2]
    if (b64.length > 560000) return json(res, 400, { ok: false, error: '截图过大（超 400KB），请裁剪后重试' })
    shotFile = orderId + '.' + (shotM[1] === 'jpeg' ? 'jpg' : shotM[1])
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    fs.writeFileSync(path.join(SHOT_DIR, shotFile), Buffer.from(b64, 'base64'))
  }
  const db = loadOrders()
  const o = db.orders.find(x => x.id === orderId && x.uid === user.id)
  if (!o) return json(res, 404, { ok: false, error: '订单不存在' })
  if (o.status !== 'pending' && o.status !== 'reviewing') return json(res, 400, { ok: false, error: '该订单状态不可提交凭证' })
  // 防刷单③：凭证号严格全局唯一（含已取消订单）——放行已取消会留下"提交假凭证→取消→重复提交"的刷单循环；
  // 微信转账单号天然全局唯一，一人一单。误取消已付款订单的极端情况走人工（后台拒绝并备注）。
  const dup = db.orders.find(x => x.id !== o.id && x.voucher === voucher)
  if (dup) return json(res, 409, { ok: false, error: '该凭证号已被使用，请核对微信账单里的真实转账单号' })
  o.voucher = voucher
  if (shotFile) o.screenshot = shotFile
  o.status = 'reviewing'
  o.updatedAt = new Date().toISOString()
  saveOrders(db)
  // AI 自动审核（v0.6）：同步跑（OCR 十秒级），结果写订单并决定自动批/转人工；开关关/无截图直接落人工
  try { await autoReviewOrder(o) } catch (e) { try { console.error('[auto-review]', e.message) } catch {} }
  // 手机息屏提醒：推送 ntfy（自动批/转人工两种文案都在 autoReviewOrder 里发过；此处兜底异常情况）
  if (!o.aiReview) {
    const ou = loadUsers().users.find(x => x.id === o.uid)
    notifyAdmin('MSMate 待审核充值', `${(ou && (ou.nickname || ou.email)) || '用户'} 提交了 ¥${o.amount} 凭证，单号 ${o.id}，请打开批款后台处理`)
  }
  const fresh = (loadOrders().orders.find(x => x.id === o.id)) || o
  const msg = fresh.aiReview && fresh.aiReview.verdict === 'auto'
    ? { ok: true, order: orderPublic(fresh), auto: true }
    : { ok: true, order: orderPublic(fresh) }
  json(res, 200, msg)
}

function handleOrdersMy(req, res, user) {
  const db = loadOrders()
  const users = loadUsers().users
  const uMap = new Map(users.map(u => [u.id, u]))
  const list = db.orders
    .filter(o => o.uid === user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map(o => orderPublic(o, uMap.get(o.uid)))
  json(res, 200, { ok: true, orders: list })
}

// 用户取消自己的待支付/审核中订单（防"退出不付款"堆积待支付单）
function handleOrderCancel(req, res, user, orderId) {
  const db = loadOrders()
  const o = db.orders.find(x => x.id === orderId && x.uid === user.id)
  if (!o) return json(res, 404, { ok: false, error: '订单不存在' })
  if (o.status !== 'pending' && o.status !== 'reviewing') return json(res, 400, { ok: false, error: '仅待支付/审核中的订单可取消' })
  o.status = 'cancelled'
  o.updatedAt = new Date().toISOString()
  saveOrders(db)
  json(res, 200, { ok: true, order: orderPublic(o) })
}

function handleBalance(req, res, user) {
  json(res, 200, { ok: true, credits: user.credits || 0 })
}

// ─────────────────── 每日签到（v0.5）───────────────────
// 每天签到 +50 积分，累计封顶 200（拉新福利，成本上限每人 ¥1.33 上游成本）
const SIGNIN_AWARD = 50
const SIGNIN_CAP = 200

function handleSignin(req, res, user) {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) // 按北京时间（UTC+8）翻篇
  const sign = user.sign || { total: 0, lastDate: '' }
  if (sign.lastDate === today) return json(res, 200, { ok: false, error: '今天已签到，明天再来', total: sign.total, cap: SIGNIN_CAP, credits: user.credits || 0 })
  if ((sign.total || 0) >= SIGNIN_CAP) return json(res, 200, { ok: false, error: `签到福利已达上限（${SIGNIN_CAP} 积分），感谢支持`, total: sign.total, cap: SIGNIN_CAP, credits: user.credits || 0 })
  const award = Math.min(SIGNIN_AWARD, SIGNIN_CAP - sign.total)
  sign.total += award
  sign.lastDate = today
  const db = loadUsers()
  const u = db.users.find(x => x.id === user.id)
  if (!u) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
  u.sign = sign
  u.credits = (u.credits || 0) + award
  saveUsers(db)
  user.credits = u.credits
  user.sign = sign
  json(res, 200, { ok: true, awarded: award, total: sign.total, cap: SIGNIN_CAP, credits: u.credits })
}

// ─────────────────── 管理员推送提醒（ntfy）───────────────────
// NTFY_TOPIC 未配置 = 关闭。手机装 ntfy app（开源，GitHub/应用商店可下）订阅同名主题，
// 息屏也能收到系统级推送。主题名即密码（谁订阅谁知道），务必用长随机串。
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')
const NTFY_TOPIC = String(process.env.NTFY_TOPIC || '').trim()

function notifyAdmin(title, body) {
  if (!NTFY_TOPIC) return
  try {
    const payload = JSON.stringify({ topic: NTFY_TOPIC, title: String(title).slice(0, 64), message: String(body).slice(0, 300), tags: ['money_with_wings'], priority: 'high' })
    const u = new URL(NTFY_SERVER)
    const req = require('https').request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      // 结果落日志：docker logs 可见（此前静默吞错，推送断了无从排查）
      let buf = ''
      res.on('data', c => { if (buf.length < 200) buf += c })
      res.on('end', () => console.log(`[ntfy] ${res.statusCode} ${title}`))
      if (res.statusCode !== 200) console.error(`[ntfy] 推送异常 ${res.statusCode}: ${buf}`)
    })
    req.on('error', (e) => console.error(`[ntfy] 推送失败: ${e.message}（服务器到 ${NTFY_SERVER} 不通？）`))
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')) } catch { } })
    req.write(payload)
    req.end()
  } catch (e) {
    console.error(`[ntfy] 推送构造失败: ${e.message}`)
  }
}

// ─────────────────── 设备在线登记（互联网 P2P 发现，v0.4）───────────────────
// 登录设备 30s 心跳上报 {deviceId,name,platform}，服务端记录公网 IP；
// 列表只发 90s 内有心跳的设备。文件只是断电缓存，心跳 30s 内自然重建。
const PRESENCE_FILE = path.join(DATA_DIR, 'presence.json')

function loadPresence() {
  try { return JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8')) } catch { }
  return {}
}

function handlePresencePing(req, res, body, user) {
  const deviceId = String(body.deviceId || '').trim().slice(0, 64)
  if (!deviceId) return json(res, 400, { ok: false, error: '缺少 deviceId' })
  const db = loadPresence()
  const now = Date.now()
  for (const k of Object.keys(db)) {
    if (now - new Date(db[k].lastAt).getTime() > 10 * 60 * 1000) delete db[k] // 惰性清理僵尸记录
  }
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  db[deviceId] = {
    deviceId,
    name: String(body.name || '').trim().slice(0, 48) || '未命名设备',
    platform: String(body.platform || '').trim().slice(0, 24),
    uid: user.id,
    ip,
    lastAt: new Date().toISOString()
  }
  try { fs.writeFileSync(PRESENCE_FILE, JSON.stringify(db)) } catch { }
  json(res, 200, { ok: true })
}

function handlePresenceList(req, res, user) {
  const db = loadPresence()
  const now = Date.now()
  const devices = Object.values(db)
    .filter(d => now - new Date(d.lastAt).getTime() <= 90 * 1000)
    .map(d => ({ deviceId: d.deviceId, name: d.name, platform: d.platform, ip: d.ip, lastAt: d.lastAt }))
  json(res, 200, { ok: true, devices })
}

// ─────────────────── 批款后台 ───────────────────

async function handleAdminLogin(req, res, body) {
  const key = String(body.key || '')
  const ok = key.length === ADMIN_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))
  if (!ok) return json(res, 401, { ok: false, error: '管理密钥错误' })
  json(res, 200, { ok: true, token: issueAdminToken() })
}

function adminAuth(req) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  return verifyAdminToken(token)
}

function handleAdminOrders(req, res, query) {
  const db = loadOrders()
  const users = loadUsers().users
  const uMap = new Map(users.map(u => [u.id, u]))
  const status = (query && query.status) || 'reviewing'
  const list = db.orders
    .filter(o => status === 'all' ? true : o.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100)
    .map(o => orderPublic(o, uMap.get(o.uid)))
  const counts = { pending: 0, reviewing: 0, done: 0, rejected: 0 }
  for (const o of db.orders) counts[o.status] = (counts[o.status] || 0) + 1
  json(res, 200, { ok: true, orders: list, counts })
}

function handleAdminApprove(req, res, orderId) {
  const odb = loadOrders()
  const o = odb.orders.find(x => x.id === orderId)
  if (!o) return json(res, 404, { ok: false, error: '订单不存在' })
  if (o.status !== 'reviewing' && o.status !== 'pending') return json(res, 400, { ok: false, error: '该订单已处理' })
  const udb = loadUsers()
  const u = udb.users.find(x => x.id === o.uid)
  if (!u) return json(res, 404, { ok: false, error: '订单对应用户不存在' })
  o.status = 'done'
  o.updatedAt = new Date().toISOString()
  u.credits = (u.credits || 0) + o.credits
  saveOrders(odb)
  saveUsers(udb)
  json(res, 200, { ok: true, order: orderPublic(o, u), credits: u.credits })
}

async function handleAdminReject(req, res, body, orderId) {
  const odb = loadOrders()
  const o = odb.orders.find(x => x.id === orderId)
  if (!o) return json(res, 404, { ok: false, error: '订单不存在' })
  if (o.status !== 'reviewing' && o.status !== 'pending') return json(res, 400, { ok: false, error: '该订单已处理' })
  o.status = 'rejected'
  o.rejectReason = String(body.reason || '').trim().slice(0, 64)
  o.updatedAt = new Date().toISOString()
  saveOrders(odb)
  json(res, 200, { ok: true, order: orderPublic(o) })
}

function handleAdminAutoReviewGet(res) {
  json(res, 200, { ok: true, config: loadAutoReview() })
}
function handleAdminAutoReviewPost(req, res, body) {
  saveAutoReview(body || {})
  json(res, 200, { ok: true, config: loadAutoReview() })
}
// 截图查看（admin <img> 无法带 header，token 走 query ?t=）：文件名白名单防路径穿越
function handleScreenshot(req, res, file, query) {
  const token = String((query && query.t) || '')
  if (!verifyAdminToken(token)) return json(res, 401, { ok: false, error: '后台登录已过期' })
  if (!/^[A-Za-z0-9]+\.(png|jpg|webp)$/.test(file)) return json(res, 404, { ok: false, error: '不存在' })
  const p = path.join(SHOT_DIR, file)
  if (!fs.existsSync(p)) return json(res, 404, { ok: false, error: '不存在' })
  const ext = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
  res.writeHead(200, { 'Content-Type': ext, 'Cache-Control': 'private, max-age=600' })
  res.end(fs.readFileSync(p))
}

// ─────────────────── AI 代理（v0.4）：内置模型 OpenAI 兼容透传 + 积分扣费 ───────────────────
// 客户端把"MSMate 内置"当普通 OpenAI 兼容服务商使用：baseUrl = 本服务 /v1/ai/openai，apiKey = 登录 token
// 服务端用 SF_API_KEY 转发硅基流动，按 usage 结算扣积分；上游 key 永不落客户端

const SF_API_KEY = String(process.env.SF_API_KEY || '').trim()
const SF_BASE = (process.env.SF_BASE || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
const AI_PROXY_MAX_BYTES = 20 * 1024 * 1024 // ASR/图片编辑上传上限
const AI_USAGE_FILE = path.join(DATA_DIR, 'ai-usage.json')

// 定价 = 上游人民币单价（元/百万 tokens；图片按张、TTS 按 UTF-8 千字节、ASR 按次）
// 扣费积分 = ceil(成本元 × CREDITS_PER_YUAN × AI_MARKUP)，毛利 1.5 倍
const AI_MARKUP = 1.5
const AI_CHAT_MODELS = [
  { id: 'deepseek-ai/DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', desc: '日常对话主力，支持工具调用', costIn: 3, costOut: 9, costCache: 0.3 },
  { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6 35B A3B', desc: '超值档，轻量任务，支持工具调用', costIn: 1.8, costOut: 10.8 },
  { id: 'zai-org/GLM-4.5V', name: 'GLM-4.5V 视觉', desc: '看图/截图理解', costIn: 1, costOut: 6, costCache: 0.1, vision: true },
  { id: 'zai-org/GLM-5.3', name: 'GLM-5.3 旗舰', desc: '深度思考，复杂任务', costIn: 8, costOut: 28, costCache: 2, premium: true },
  { id: 'PaddlePaddle/PaddleOCR-VL-1.5', name: 'PaddleOCR 视觉', desc: '看图/OCR（内置视觉工具默认，上游免费）', costIn: 0, costOut: 0, vision: true, visionOnly: true }
]
const AI_IMAGE_MODELS = [
  // 上游 0.3 元/张 → 0.3 × 100 × 1.5 = 45 积分/张（此前 6/8 积分严重倒挂亏本，2026-09-10 修正）
  { id: 'Tongyi-MAI/Z-Image-Turbo', name: 'Z-Image Turbo', desc: '文生图', creditsPerImage: 45 },
  { id: 'Qwen/Qwen-Image-Edit-2509', name: 'Qwen 图片编辑', desc: '涂改/局部重绘', creditsPerImage: 45, edit: true }
]
const AI_TTS_MODEL = { id: 'FunAudioLLM/CosyVoice2-0.5B', name: 'CosyVoice2 语音合成', desc: '文本朗读', creditsPerKByte: 8 }
// 上游 SenseVoiceSmall 免费 → 0 积分（语音输入免费体验）
const AI_ASR_MODEL = { id: 'FunAudioLLM/SenseVoiceSmall', name: 'SenseVoice 语音识别', desc: '语音输入', creditsPerReq: 0 }
const AI_CHAT_IDS = AI_CHAT_MODELS.map(m => m.id)
const AI_IMAGE_GEN_IDS = AI_IMAGE_MODELS.filter(m => !m.edit).map(m => m.id)
const AI_IMAGE_EDIT_IDS = AI_IMAGE_MODELS.filter(m => m.edit).map(m => m.id)

function aiCreditsFromYuan(yuan) { return Math.max(1, Math.ceil(yuan * CREDITS_PER_YUAN * AI_MARKUP)) }

function aiAppendUsage(entry) {
  try {
    const list = loadJson(AI_USAGE_FILE, [])
    list.push(entry)
    if (list.length > 5000) list.splice(0, list.length - 5000)
    saveJson(AI_USAGE_FILE, list)
  } catch { }
}

// 扣积分：重新查库改值落盘（user 是 authUser 的引用，同步刷新其 credits）
function aiCharge(user, credits, note) {
  if (!(credits > 0)) return 0
  const db = loadUsers()
  const u = db.users.find(x => x.id === user.id)
  if (!u) return 0
  u.credits = Math.max(0, (u.credits || 0) - credits)
  saveUsers(db)
  user.credits = u.credits
  aiAppendUsage({ at: new Date().toISOString(), uid: u.id, credits, balance: u.credits, note })
  return credits
}

function aiBalanceOf(user) {
  const u = loadUsers().users.find(x => x.id === user.id)
  return u ? (u.credits || 0) : 0
}

function readRaw(req, maxBytes) {
  const limit = maxBytes || AI_PROXY_MAX_BYTES
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// 透传转发到硅基流动，返回上游响应流
function sfProxy(upstreamPath, { method = 'POST', headers = {}, body = null } = {}) {
  const u = new URL(SF_BASE + upstreamPath)
  const mod = u.protocol === 'http:' ? require('http') : require('https')
  const h = { Authorization: `Bearer ${SF_API_KEY}` }
  for (const k of Object.keys(headers)) h[k] = headers[k]
  if (body != null) h['Content-Length'] = Buffer.byteLength(body)
  const outReq = mod.request(u, { method, headers: h })
  if (body != null) outReq.write(body)
  outReq.end()
  return { outReq, done: new Promise((resolve, reject) => {
    outReq.on('response', resolve)
    outReq.on('error', reject)
  }) }
}

// 上游错误 → 统一 JSON 错误响应（透传上游 message）
async function sfProxyError(res, upRes, fallbackCode) {
  let text = ''
  upRes.on('data', c => { text += c; if (text.length > 4000) upRes.destroy() })
  await new Promise(r => upRes.on('close', r))
  let msg = `AI 服务错误（HTTP ${upRes.statusCode}）`
  try { const j = JSON.parse(text); if (j.message) msg = j.message; else if (j.error && j.error.message) msg = j.error.message } catch { }
  json(res, fallbackCode || 502, { ok: false, error: msg })
}

// multipart 里抽取文本字段值（不完整解析，够拿 model/n 三个字段）
function multipartField(buf, name) {
  const m = new RegExp(`Content-Disposition: form-data; name="${name}"\\r?\\n\\r?\\n([^\\r\\n]+)`).exec(buf.toString('utf8'))
  return m ? m[1].trim() : ''
}

async function proxyChatCompletions(req, res, user) {
  let body
  try { body = JSON.parse((await readRaw(req, 2 * 1024 * 1024)).toString('utf8') || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是有效 JSON' }) }
  const model = String(body.model || '')
  const meta = AI_CHAT_MODELS.find(m => m.id === model)
  if (!meta) return json(res, 400, { ok: false, error: `模型不在内置清单：${model || '(空)'}` })
  const maxTokens = Math.min(8192, Math.max(1, +body.max_tokens || 8192))
  body.max_tokens = maxTokens
  const stream = body.stream !== false
  if (stream) body.stream_options = { include_usage: true }
  const payload = JSON.stringify(body)

  // 预检：余额需覆盖"最坏全额输出"积分与 20 积分门槛的较小者
  const worst = aiCreditsFromYuan(maxTokens * meta.costOut / 1e6)
  const gate = Math.min(worst, 20)
  const balance = aiBalanceOf(user)
  if (balance < gate) {
    return json(res, 402, { ok: false, error: `积分不足（余额 ${balance}，本次至少需 ${gate} 积分），请充值`, code: 'INSUFFICIENT_CREDITS', balance })
  }

  const { outReq, done } = sfProxy('/chat/completions', { headers: { 'Content-Type': 'application/json' }, body: payload })
  // 客户端中止 → 断上游
  res.on('close', () => { try { outReq.destroy() } catch { } })
  const upRes = await done
  if (upRes.statusCode !== 200) return await sfProxyError(res, upRes, 502)

  const settle = (usage, fallbackOutBytes) => {
    let ct = 0, pt = 0, cached = 0
    if (usage) {
      pt = usage.prompt_tokens || 0
      ct = usage.completion_tokens || 0
      cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0
    } else if (fallbackOutBytes > 0) {
      ct = Math.round(fallbackOutBytes / 3) // 中断兜底：中文约 3 字节/token 粗估
    }
    if (pt + ct <= 0) return 0
    const yuan = ((pt - cached) * meta.costIn + cached * (meta.costCache ?? meta.costIn) + ct * meta.costOut) / 1e6
    const credits = aiCreditsFromYuan(yuan)
    aiCharge(user, credits, `对话 ${meta.name}`)
    return credits
  }

  if (!stream) {
    const chunks = []
    upRes.on('data', c => chunks.push(c))
    await new Promise(r => upRes.on('end', r))
    let j
    try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 502, { ok: false, error: 'AI 服务响应异常' }) }
    const credits = settle(j.usage, 0)
    j._msmate = { credits, balance: user.credits }
    return json(res, 200, j)
  }

  // 流式：逐行转发 SSE，旁路嗅探 usage 帧（OpenAI 格式：独立 chunk，choices 为空数组）
  // [DONE] 扣下最后再发：扣费回执帧必须走在 [DONE] 之前（标准 SSE 客户端收到 [DONE] 即收流，之后补帧读不到）
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  let buffer = ''
  let usage = null
  let contentBytes = 0
  for await (const chunk of upRes) {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) { try { res.write('\n') } catch { } ; continue } // 保留 SSE 事件边界空行
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue // 扣下，收流后随回执帧一起发
        try {
          const j = JSON.parse(data)
          if (j.usage) usage = j.usage
          const d = j.choices && j.choices[0] && j.choices[0].delta
          if (d && d.content) contentBytes += Buffer.byteLength(d.content, 'utf8')
        } catch { }
      }
      try { res.write(line + '\n') } catch { }
    }
  }
  // 结算后先发扣费回执帧，再补 [DONE] 收流
  const credits = settle(usage, usage ? 0 : contentBytes)
  try { res.write(`data: ${JSON.stringify({ _msmate: { credits, balance: user.credits } })}\n\n`) } catch { }
  try { res.write('data: [DONE]\n\n') } catch { }
  res.end()
}

async function proxyImageGen(req, res, user, isEdit) {
  const raw = await readRaw(req)
  const ids = isEdit ? AI_IMAGE_EDIT_IDS : AI_IMAGE_GEN_IDS
  let model = '', n = 1
  if (isEdit) {
    model = multipartField(raw, 'model')
    n = Math.max(1, Math.min(4, +multipartField(raw, 'n') || 1))
  } else {
    try { const b = JSON.parse(raw.toString('utf8') || '{}'); model = String(b.model || ''); n = Math.max(1, Math.min(4, +b.n || 1)) } catch { }
  }
  if (!ids.includes(model)) return json(res, 400, { ok: false, error: `模型不在内置清单：${model || '(空)'}` })
  const meta = AI_IMAGE_MODELS.find(m => m.id === model)
  const cost = n * meta.creditsPerImage
  const balance = aiBalanceOf(user)
  if (balance < cost) return json(res, 402, { ok: false, error: `积分不足（余额 ${balance}，本次需 ${cost}），请充值`, code: 'INSUFFICIENT_CREDITS', balance })
  const { outReq, done } = sfProxy(isEdit ? '/images/edits' : '/images/generations', { headers: { 'Content-Type': req.headers['content-type'] || 'application/json' }, body: raw })
  const upRes = await done
  if (upRes.statusCode !== 200) return await sfProxyError(res, upRes, 502)
  const chunks = []
  upRes.on('data', c => chunks.push(c))
  await new Promise(r => upRes.on('end', r))
  let j
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 502, { ok: false, error: 'AI 服务响应异常' }) }
  const made = Array.isArray(j.data) ? j.data.length : n
  const credits = aiCharge(user, made * meta.creditsPerImage, `${meta.name} ×${made}`)
  j._msmate = { credits, balance: user.credits }
  json(res, 200, j)
}

async function proxyTts(req, res, user) {
  let body
  try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是有效 JSON' }) }
  if (body.model && body.model !== AI_TTS_MODEL.id) return json(res, 400, { ok: false, error: '模型不在内置清单' })
  body.model = AI_TTS_MODEL.id
  // OpenAI 兼容字段为 input（兼容客户端传 text 的写法）
  const text = String(body.input || body.text || '')
  if (!text.trim()) return json(res, 400, { ok: false, error: 'text 不能为空' })
  if (text.length > 5000) return json(res, 400, { ok: false, error: '单次合成最长 5000 字' })
  body.input = text
  const bytes = Buffer.byteLength(text, 'utf8')
  const cost = Math.max(1, Math.ceil(bytes * AI_TTS_MODEL.creditsPerKByte / 1024))
  const balance = aiBalanceOf(user)
  if (balance < cost) return json(res, 402, { ok: false, error: `积分不足（余额 ${balance}，本次需 ${cost}），请充值`, code: 'INSUFFICIENT_CREDITS', balance })
  const payload = JSON.stringify(body)
  const { outReq, done } = sfProxy('/audio/speech', { headers: { 'Content-Type': 'application/json' }, body: payload })
  const upRes = await done
  if (upRes.statusCode !== 200) return await sfProxyError(res, upRes, 502)
  res.writeHead(200, { 'Content-Type': upRes.headers['content-type'] || 'audio/mpeg' })
  upRes.pipe(res)
  await new Promise(r => { res.on('close', r); upRes.on('end', r) })
  aiCharge(user, cost, `${AI_TTS_MODEL.name} ${text.length} 字`)
}

async function proxyAsr(req, res, user) {
  const raw = await readRaw(req)
  if (!raw.length) return json(res, 400, { ok: false, error: '缺少音频数据' })
  const balance = aiBalanceOf(user)
  if (balance < AI_ASR_MODEL.creditsPerReq) return json(res, 402, { ok: false, error: `积分不足（余额 ${balance}，本次需 ${AI_ASR_MODEL.creditsPerReq}），请充值`, code: 'INSUFFICIENT_CREDITS', balance })
  const { outReq, done } = sfProxy('/audio/transcriptions', { headers: { 'Content-Type': req.headers['content-type'] || 'multipart/form-data' }, body: raw })
  const upRes = await done
  if (upRes.statusCode !== 200) return await sfProxyError(res, upRes, 502)
  const chunks = []
  upRes.on('data', c => chunks.push(c))
  await new Promise(r => upRes.on('end', r))
  let j
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 502, { ok: false, error: 'AI 服务响应异常' }) }
  const credits = aiCharge(user, AI_ASR_MODEL.creditsPerReq, AI_ASR_MODEL.name)
  j._msmate = { credits, balance: user.credits }
  json(res, 200, j)
}

// 内置模型清单（客户端设置面板渲染用；价格为积分口径）
function handleAiModels(res) {
  json(res, 200, {
    ok: true,
    chat: AI_CHAT_MODELS.map(m => ({
      id: m.id, name: m.name, desc: m.desc, vision: !!m.vision, premium: !!m.premium, visionOnly: !!m.visionOnly,
      creditsPerMTokIn: aiCreditsFromYuan(m.costIn), creditsPerMTokOut: aiCreditsFromYuan(m.costOut)
    })),
    image: AI_IMAGE_MODELS.map(m => ({ id: m.id, name: m.name, desc: m.desc, creditsPerImage: m.creditsPerImage, edit: !!m.edit })),
    tts: { id: AI_TTS_MODEL.id, name: AI_TTS_MODEL.name, desc: AI_TTS_MODEL.desc, creditsPerKByte: AI_TTS_MODEL.creditsPerKByte },
    asr: { id: AI_ASR_MODEL.id, name: AI_ASR_MODEL.name, desc: AI_ASR_MODEL.desc, creditsPerReq: AI_ASR_MODEL.creditsPerReq }
  })
}

// /v1/ai/openai/* 入口：鉴权 + 子路径分发
async function aiProxyEntry(req, res, pathname) {
  // 鉴权优先于配置检查：未登录一律 401，不泄露服务端配置状态
  const user = authUser(req)
  if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
  if (!SF_API_KEY) return json(res, 503, { ok: false, error: 'AI 服务未配置，请联系管理员' })
  const sub = pathname.slice('/v1/ai/openai/'.length)
  try {
    if (req.method === 'POST' && sub === 'chat/completions') return await proxyChatCompletions(req, res, user)
    if (req.method === 'POST' && sub === 'images/generations') return await proxyImageGen(req, res, user, false)
    if (req.method === 'POST' && sub === 'images/edits') return await proxyImageGen(req, res, user, true)
    if (req.method === 'POST' && sub === 'audio/speech') return await proxyTts(req, res, user)
    if (req.method === 'POST' && sub === 'audio/transcriptions') return await proxyAsr(req, res, user)
    return json(res, 404, { ok: false, error: '未知 AI 接口' })
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { ok: false, error: `AI 代理异常：${err.message}` })
    try { res.end() } catch { }
  }
}

// ─────────────────── 批款后台网页（零依赖内嵌，手机可用） ───────────────────

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MSMate 批款后台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f3f4f8;color:#24263a;padding:16px;max-width:720px;margin:0 auto}
h1{font-size:18px;margin-bottom:12px;color:#3a2d6b}
.card{background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 4px rgba(30,20,70,.08)}
input,select{font:inherit;padding:9px 12px;border:1px solid #d9d8e6;border-radius:10px;width:100%;margin-bottom:10px}
button{font:inherit;border:0;border-radius:10px;padding:9px 16px;background:#6c4ce0;color:#fff;cursor:pointer}
button.sec{background:#ece9f8;color:#4a3a8a}
button.ok{background:#18a058}
button.no{background:#e0524c}
.row{display:flex;gap:8px;flex-wrap:wrap}
.meta{color:#6b6a80;font-size:12px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px}
.b-rv{background:#fdf1e0;color:#a05a00}.b-pd{background:#e8e8f2;color:#555}.b-done{background:#e2f6ea;color:#0d7a43}.b-rj{background:#fde8e7;color:#b03028}
.amount{font-size:20px;font-weight:700;color:#3a2d6b}
.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.tabs button{background:#fff;color:#4a3a8a;box-shadow:0 1px 3px rgba(30,20,70,.1)}
.tabs button.on{background:#6c4ce0;color:#fff}
.hide{display:none}
.err{color:#b03028;font-size:13px;margin-bottom:8px}
.empty{color:#8a89a0;text-align:center;padding:30px 0}
</style></head><body>
<h1>MSMate 批款后台</h1>
<div id="login" class="card">
  <div class="err" id="lerr"></div>
  <input id="key" type="password" placeholder="管理密钥（ADMIN_PASS 或 data/admin.key）">
  <button id="lbtn" onclick="login()">登录</button>
</div>
<div id="panel" class="hide">
  <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
    <span class="meta" id="lastcheck"></span>
    <button class="sec" id="sndbtn" type="button"></button>
  </div>
  <details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:13px">AI 自动审核设置（附截图的订单自动核验，可秒批）</summary>
    <div style="margin-top:6px">
      <label style="display:block;margin-bottom:4px;font-size:13px"><input type="checkbox" id="ar_on"> 开启自动审核（OCR 核验：金额=档位 + 收款方昵称命中 + 未超上限 → 自动到账并通知抽查；存疑转人工）</label>
      <input id="ar_payee" placeholder="你的微信收款昵称（截图上显示的收款人名字）" style="width:100%;margin-bottom:4px">
      <input id="ar_max" type="number" min="1" max="128" placeholder="自动批上限（元，默认 68）" style="width:100%;margin-bottom:6px">
      <button class="sec" id="ar_save" type="button">保存设置</button>
      <span class="meta" id="ar_msg"></span>
    </div>
  </details>
  <div class="tabs" id="tabs"></div>
  <div id="list"></div>
</div>
<script>
// 全兼容写法：XHR 替代 fetch（老内核手机浏览器无 fetch/Object.assign），localStorage 防御（隐私模式会抛异常）
function storageGet(k) { try { return localStorage.getItem(k) } catch (e) { return '' } }
function storageSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { } }
function storageDel(k) { try { localStorage.removeItem(k) } catch (e) { } }
var token = storageGet('adm_token') || ''
var cur = 'reviewing'
var counts = {}
var tabNames = { reviewing: '待审核', pending: '未提交凭证', done: '已到账', rejected: '已拒绝', all: '全部' }
function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
function xhr(method, path, body, cb) {
  var x = new XMLHttpRequest()
  x.open(method, path, true)
  x.setRequestHeader('Content-Type', 'application/json')
  if (token) x.setRequestHeader('Authorization', 'Bearer ' + token)
  x.onreadystatechange = function () {
    if (x.readyState !== 4) return
    var j = {}
    try { j = JSON.parse(x.responseText) } catch (e) { }
    cb(j)
  }
  x.onerror = function () { cb({ ok: false, error: '网络异常，请重试' }) }
  x.ontimeout = function () { cb({ ok: false, error: '请求超时，请重试' }) }
  x.send(body ? JSON.stringify(body) : null)
}
function login() {
  var btn = document.getElementById('lbtn')
  btn.disabled = true
  btn.textContent = '登录中...'
  xhr('POST', '/admin/api/login', { key: document.getElementById('key').value }, function (j) {
    btn.disabled = false
    btn.textContent = '登录'
    if (j.ok) { token = j.token; storageSet('adm_token', token); showPanel() }
    else document.getElementById('lerr').textContent = j.error || '登录失败'
  })
}
function showPanel() {
  document.getElementById('login').classList.add('hide')
  document.getElementById('panel').classList.remove('hide')
  loadAutoReviewPanel()
  load()
}
function loadAutoReviewPanel() {
  xhr('GET', '/admin/api/autoreview', null, function (j) {
    if (!j.ok || !j.config) return
    document.getElementById('ar_on').checked = !!j.config.enabled
    document.getElementById('ar_payee').value = j.config.payee || ''
    document.getElementById('ar_max').value = j.config.maxAuto || 68
  })
}
function saveAutoReviewPanel() {
  var btn = document.getElementById('ar_save')
  btn.disabled = true
  var body = {
    enabled: document.getElementById('ar_on').checked,
    payee: document.getElementById('ar_payee').value.trim(),
    maxAuto: document.getElementById('ar_max').value
  }
  xhr('POST', '/admin/api/autoreview', body, function (j) {
    btn.disabled = false
    document.getElementById('ar_msg').textContent = j.ok ? '已保存 ✓' : (j.error || '保存失败')
    if (j.ok) setTimeout(function () { document.getElementById('ar_msg').textContent = '' }, 2500)
  })
}
document.getElementById('ar_save').addEventListener('click', saveAutoReviewPanel)
function load() {
  var tabs = document.getElementById('tabs')
  tabs.innerHTML = ''
  var names = Object.keys(tabNames)
  for (var i = 0; i < names.length; i++) {
    (function (s) {
      var b = document.createElement('button')
      if (s === cur) b.className = 'on'
      b.textContent = tabNames[s] + (counts[s] ? ' ' + counts[s] : '')
      b.onclick = function () { cur = s; load() }
      tabs.appendChild(b)
    })(names[i])
  }
  xhr('GET', '/admin/api/orders?status=' + cur, null, function (j) {
    if (!j.ok) { storageDel('adm_token'); token = ''; location.reload(); return }
    counts = j.counts
    var el = document.getElementById('list')
    // 按钮用 data-* + 事件委托，避免内联 onclick 引号嵌套出错（模板字符串转义曾致整页 JS 挂掉）
    el.onclick = function (e) {
      var t = e.target
      if (!t || !t.getAttribute) return
      var id = t.getAttribute('data-oid')
      var what = t.getAttribute('data-what')
      if (id && what) act(id, what)
    }
    if (!j.orders.length) { el.innerHTML = '<div class="empty">暂无订单</div>'; return }
    var html = ''
    for (var i = 0; i < j.orders.length; i++) {
      var o = j.orders[i]
      var cls = { reviewing: 'b-rv', pending: 'b-pd', done: 'b-done', rejected: 'b-rj' }[o.status]
      var name = { reviewing: '待审核', pending: '未提交凭证', done: '已到账', rejected: '已拒绝' }[o.status]
      html += '<div class="card">'
        + '<div class="row" style="justify-content:space-between;align-items:center"><span class="amount">&yen;' + esc(o.amount) + '</span>'
        + '<span class="badge ' + cls + '">' + name + '</span></div>'
        + '<div>' + esc(o.nickname) + ' <span class="meta">' + esc(o.email) + '</span></div>'
        + '<div class="meta">订单 ' + esc(o.id) + ' · 充值 ' + esc(o.credits) + ' 积分</div>'
        + '<div class="meta">提交 ' + esc(o.createdAt) + '</div>'
        + (o.voucher ? '<div>凭证号：<b>' + esc(o.voucher) + '</b></div>' : '')
        + (o.aiReview ? (o.aiReview.verdict === 'auto'
          ? '<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#e7f6ec;color:#1c6b34;font-size:12px">AI 核验通过 · 已自动到账（' + esc((o.aiReview.at || '').replace('T', ' ').slice(0, 16)) + '）— 请抽查收款记录</div>'
          : '<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#fdf3e0;color:#8a5a13;font-size:12px">AI 存疑：' + esc((o.aiReview.reasons || []).join('；')) + '</div>') : '')
        + (o.screenshot ? '<div style="margin:6px 0"><img src="/screenshots/' + esc(o.screenshot) + '?t=' + esc(token) + '" alt="付款截图" style="max-width:100%;max-height:300px;border-radius:8px;border:1px solid #e5e7eb"></div>' : '')
        + (o.rejectReason ? '<div class="meta">拒绝原因：' + esc(o.rejectReason) + '</div>' : '')
        + (o.status === 'reviewing' || o.status === 'pending'
          ? '<div class="row" style="margin-top:8px"><button class="ok" data-oid="' + esc(o.id) + '" data-what="approve">通过 · 加 ' + esc(o.credits) + ' 积分</button>'
            + '<button class="no" data-oid="' + esc(o.id) + '" data-what="reject">拒绝</button></div>'
          : '')
        + '</div>'
    }
    el.innerHTML = html
  })
}
function act(id, what) {
  if (what === 'reject' && !confirm('确认拒绝该订单？')) return
  xhr('POST', '/admin/api/orders/' + id + '/' + what, {}, function (j) {
    if (j.ok) load()
    else alert(j.error || '操作失败')
  })
}
// ===== 新单提醒（v0.5）：15s 轮询待审核数，新增即响铃 + 标题闪烁 + 系统通知 =====
var audioCtx = null
var lastReviewing = -1
var soundOn = storageGet('adm_sound') !== 'off'
var BASE_TITLE = document.title
// 近静音高音振荡器：让浏览器把本页标记为"正在播放音频"，豁免后台标签页的定时器限流
// （否则页面挂后台 5 分钟后轮询会降频到 1 次/分钟，提示就不及时了）
function keepAlive() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx = audioCtx || new AC()
    var o = audioCtx.createOscillator()
    var g = audioCtx.createGain()
    g.gain.value = 0.0001
    o.frequency.value = 18000
    o.connect(g); g.connect(audioCtx.destination)
    o.start()
  } catch (e) { }
}
function beep() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx = audioCtx || new AC()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    var t = audioCtx.currentTime + 0.05
    for (var i = 0; i < 6; i++) {
      var o = audioCtx.createOscillator()
      var g = audioCtx.createGain()
      o.type = 'sine'
      o.frequency.value = (i % 2 === 0) ? 880 : 1320
      g.gain.setValueAtTime(0.0001, t + i * 0.3)
      g.gain.exponentialRampToValueAtTime(0.4, t + i * 0.3 + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.3 + 0.26)
      o.connect(g); g.connect(audioCtx.destination)
      o.start(t + i * 0.3); o.stop(t + i * 0.3 + 0.3)
    }
  } catch (e) { }
}
function renderSndBtn() {
  var b = document.getElementById('sndbtn')
  if (b) b.textContent = soundOn ? '声音：开' : '声音：关'
}
function poll() {
  xhr('GET', '/admin/api/orders?status=reviewing', null, function (j) {
    if (!j.ok) return
    var n = j.orders ? j.orders.length : 0
    var el = document.getElementById('lastcheck')
    if (el) el.textContent = '上次检查 ' + new Date().toLocaleTimeString() + ' · 待审核 ' + n + ' 单'
    if (lastReviewing >= 0 && n > lastReviewing) {
      if (soundOn) beep()
      try { if (window.Notification && Notification.permission === 'granted') new Notification('MSMate 批款后台', { body: n + ' 单待审核，点击打开此页面处理' }) } catch (e) { }
      document.title = '（' + n + ' 单待审核）' + BASE_TITLE
      load()
    }
    if (n === 0) document.title = BASE_TITLE
    lastReviewing = n
  })
}
function showPanel() {
  document.getElementById('login').classList.add('hide')
  document.getElementById('panel').classList.remove('hide')
  renderSndBtn()
  document.getElementById('sndbtn').onclick = function () {
    soundOn = !soundOn
    storageSet('adm_sound', soundOn ? 'on' : 'off')
    renderSndBtn()
  }
  // 通知授权要在用户手势里申请（登录点击链路内），失败静默（http 源可能被浏览器禁）
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission() } catch (e) { }
  keepAlive()
  load()
  poll()
  setInterval(poll, 15000)
}
document.getElementById('key').onkeydown = function (e) { if (e.key === 'Enter' || e.keyCode === 13) login() }
if (token) xhr('GET', '/admin/api/orders?status=reviewing', null, function (j) {
  if (j.ok) showPanel()
  else { storageDel('adm_token'); token = '' }
})
</script>
</body></html>`

// ─────────────────── HTTP 基础 ───────────────────

function json(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

function readBody(req, maxBytes) {
  const limit = maxBytes || 1024 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.removeAllListeners('data')
        req.resume() // 排空剩余数据，让 413 响应能正常送达客户端
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

// ─────────────────── 服务器 ───────────────────

const LATEST = {
  version: '2.7.15',
  url: 'https://github.com/Mosina1102/MSMate/releases/latest',
  notes: 'AI 新增 PPT 能力（create_pptx 生成/read_pptx 读取/edit_pptx 修改，18 套配色×4 风格×5 页型自动排版）；网页抓取过盾增强（指纹一致性修复+Cloudflare 挑战页自动等待通过）；Word 生成增加结构校验关卡',
  publishedAt: '2026-09-10'
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

  try {
    // 健康检查与版本
    if (req.method === 'GET' && pathname === '/ping') {
      return json(res, 200, { ok: true, service: 'msmate-api', version: '0.5.0', time: new Date().toISOString() })
    }
    if (req.method === 'GET' && pathname === '/v1/latest') return json(res, 200, { ok: true, data: LATEST })
    if (req.method === 'GET' && pathname === '/v1/myip') return json(res, 200, { ok: true, ip: ip.replace(/^::ffff:/, '') })

    // 认证
    if (req.method === 'POST' && pathname === '/v1/auth/send-code') return await handleSendCode(req, res, await readBody(req), ip)
    if (req.method === 'POST' && pathname === '/v1/auth/register') return await handleAuthRegister(req, res, await readBody(req), ip)
    if (req.method === 'POST' && pathname === '/v1/auth/login') return await handleAuthLogin(req, res, await readBody(req), ip)
    if (req.method === 'POST' && pathname === '/v1/auth/reset') return await handleAuthReset(req, res, await readBody(req), ip)
    if (req.method === 'GET' && pathname === '/v1/auth/me') return handleAuthMe(req, res)
    if (req.method === 'PATCH' && pathname === '/v1/auth/profile') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return await handleAuthProfile(req, res, await readBody(req), user)
    }
    if (req.method === 'POST' && pathname === '/v1/auth/avatar') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return await handleAuthAvatar(req, res, await readBody(req, 400 * 1024), user)
    }

    // 头像静态服务
    if (req.method === 'GET' && pathname.startsWith('/avatars/')) {
      const file = decodeURIComponent(pathname.slice('/avatars/'.length))
      if (!/^[\w-]+\.(png|jpg)$/.test(file)) return json(res, 400, { ok: false, error: 'bad request' })
      const p = path.join(AVATAR_DIR, file)
      try {
        const buf = fs.readFileSync(p)
        res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : 'image/jpeg')
        res.setHeader('Cache-Control', 'public, max-age=86400')
        res.statusCode = 200
        return res.end(buf)
      } catch {
        res.statusCode = 404
        return res.end('not found')
      }
    }

    // 云同步
    if (req.method === 'GET' && pathname === '/v1/sync') return handleSyncGet(req, res)
    if (req.method === 'PUT' && pathname === '/v1/sync') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return await handleSyncPut(req, res, await readBody(req, SYNC_MAX_BYTES + 256 * 1024), user)
    }

    // 积分充值
    if (req.method === 'POST' && pathname === '/v1/credits/orders') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return await handleOrderCreate(req, res, await readBody(req), user)
    }
    if (req.method === 'POST' && pathname.startsWith('/v1/credits/orders/') && pathname.endsWith('/voucher')) {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      const orderId = pathname.slice('/v1/credits/orders/'.length, -'/voucher'.length)
      return await handleOrderVoucher(req, res, await readBody(req), user, orderId)
    }
    if (req.method === 'POST' && pathname.startsWith('/v1/credits/orders/') && pathname.endsWith('/cancel')) {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      const orderId = pathname.slice('/v1/credits/orders/'.length, -'/cancel'.length)
      return handleOrderCancel(req, res, user, orderId)
    }
    if (req.method === 'GET' && pathname === '/v1/credits/orders/my') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return handleOrdersMy(req, res, user)
    }
    if (req.method === 'GET' && pathname === '/v1/credits/balance') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return handleBalance(req, res, user)
    }
    if (req.method === 'POST' && pathname === '/v1/credits/signin') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return handleSignin(req, res, user)
    }

    // 设备在线登记（互联网 P2P 发现）
    if (req.method === 'POST' && pathname === '/v1/presence') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return handlePresencePing(req, res, await readBody(req), user)
    }
    if (req.method === 'GET' && pathname === '/v1/presence') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return handlePresenceList(req, res, user)
    }

    // AI 代理（v0.4）：内置模型清单 + OpenAI 兼容透传
    if (req.method === 'GET' && pathname === '/v1/ai/models') return handleAiModels(res)
    if (pathname.startsWith('/v1/ai/openai/')) return await aiProxyEntry(req, res, pathname)

    // 批款后台
    if (req.method === 'GET' && pathname === '/admin') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.statusCode = 200
      return res.end(ADMIN_HTML)
    }
    // 付款截图查看（admin token 走 query ?t=，<img> 无法带 header）
    if (req.method === 'GET' && pathname.startsWith('/screenshots/')) {
      return handleScreenshot(req, res, pathname.slice('/screenshots/'.length), query)
    }
    // 自动审核配置（v0.6）
    if (req.method === 'GET' && pathname === '/admin/api/autoreview') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminAutoReviewGet(res)
    }
    if (req.method === 'POST' && pathname === '/admin/api/autoreview') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminAutoReviewPost(req, res, await readBody(req))
    }
    if (req.method === 'POST' && pathname === '/admin/api/login') return await handleAdminLogin(req, res, await readBody(req))
    if (pathname.startsWith('/admin/api/orders/')) {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      const orderId = pathname.split('/')[4]
      if (req.method === 'POST' && pathname.endsWith('/approve')) return handleAdminApprove(req, res, orderId)
      if (req.method === 'POST' && pathname.endsWith('/reject')) return await handleAdminReject(req, res, await readBody(req), orderId)
    }
    if (req.method === 'GET' && pathname === '/admin/api/orders') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminOrders(req, res, query)
    }

    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    const msg = e.message === 'invalid json' ? '请求格式错误' : e.message === 'body too large' ? '请求体过大' : '服务器内部错误'
    console.error('[err]', pathname, e.message)
    json(res, e.message === 'invalid json' ? 400 : e.message === 'body too large' ? 413 : 500, { ok: false, error: msg })
  }
})

server.listen(PORT, () => {
  console.log(`msmate-api v0.5.0 listening on 0.0.0.0:${PORT} (mail: ${MAIL_ON ? 'SMTP' : 'dev 模式，验证码走日志/接口'})`)
})
