// MSMate API 服务 v0.6 —— 零依赖（Node 内置模块），PM2/Docker 均可跑
// 接口：
//   GET  /ping                     健康检查
//   GET  /v1/latest                客户端检查更新
//   GET  /v1/myip                  调用者公网 IP（真远程辅助）
//   GET  /v1/auth/pubkey           RSA 公钥（客户端加密密码用，v0.6）
//   POST /v1/auth/send-code        发邮箱验证码 {email, scene: register|reset}
//   POST /v1/auth/register         邮箱注册 {email, passwordEnc|password, nickname?, code, agree:'v1'} → {token, user}
//   POST /v1/auth/login            邮箱登录 {email, passwordEnc|password}              → {token, user}
//   POST /v1/auth/reset            验证码重置密码 {email, passwordEnc|password, code}
//   GET  /v1/auth/me               Bearer token 查当前用户                 → {user}
//   PATCH /v1/auth/profile         改昵称 {nickname}
//   POST /v1/auth/avatar           上传头像 {dataUrl}（≤200KB base64）
//   GET  /avatars/<uid>.<ext>      头像静态服务
//   GET/PUT /v1/sync               云同步 blob（≤5MB，服务端不管结构）
//   POST /v1/feedback              用户反馈 {type:bug|idea, content, contact?}（须登录，v0.6）
//   POST /v1/credits/orders        创建充值订单 {amount}（元，1-500，¥1=100积分）
//   POST /v1/credits/orders/:id/voucher  提交付款凭证 {voucher}
//   GET  /v1/credits/orders/my     我的订单
//   GET  /v1/credits/balance       积分余额
//   POST /admin/api/login          批款后台登录 {key}（密钥在 data/admin.key）
//   GET  /admin/api/stats          仪表盘统计（v0.6）
//   GET  /admin/api/orders         订单列表 ?status=
//   GET  /admin/api/users          用户列表（v0.6）
//   GET  /admin/api/devices        设备在线记录（v0.6）
//   GET  /admin/api/feedback       反馈列表 ?filter=open|all（v0.6）
//   POST /admin/api/feedback/:id/resolve  标记反馈已处理（v0.6）
//   POST /admin/api/orders/:id/approve | /reject  批款
//   GET  /admin                    批款后台网页（手机可用）
// 数据：data/users.json、data/orders.json、data/feedback.json、data/presence.json、data/sync/<uid>.json、
//       data/avatars/<uid>.<ext>、data/admin.key、data/secret.key、data/rsa-key.json
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

// v0.6：写串行队列——同文件的写操作按序落盘，唯一 tmp 名防交错撞车。
// Node 单线程内同步读-改-写天然原子；队列防的是「未来有人在 load→save 之间插 await」的交错写
const writeQueues = new Map()
function saveJson(file, obj) {
  ensureDataDir()
  const prev = writeQueues.get(file) || Promise.resolve()
  const run = prev.catch(() => { }).then(() => new Promise((resolve, reject) => {
    try {
      const tmp = file + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
      fs.renameSync(tmp, file)
      resolve()
    } catch (e) { reject(e) }
  }))
  writeQueues.set(file, run)
  return run
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
  const password = decryptPassword(body)
  const nickname = String(body.nickname || '').trim().slice(0, 32)
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })
  if (password == null) return json(res, 400, { ok: false, error: '密码加密数据无效，请更新客户端后重试' })
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
  const password = decryptPassword(body)
  if (password == null) return json(res, 401, { ok: false, error: '邮箱或密码错误' })

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
  const password = decryptPassword(body)
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })
  if (password == null) return json(res, 400, { ok: false, error: '密码加密数据无效，请更新客户端后重试' })
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

function orderPublic(o, u) {
  return {
    id: o.id, amount: o.amount, credits: o.credits, status: o.status,
    voucher: o.voucher || '', createdAt: o.createdAt, updatedAt: o.updatedAt,
    rejectReason: o.rejectReason || '',
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
  const db = loadOrders()
  const o = db.orders.find(x => x.id === orderId && x.uid === user.id)
  if (!o) return json(res, 404, { ok: false, error: '订单不存在' })
  if (o.status !== 'pending' && o.status !== 'reviewing') return json(res, 400, { ok: false, error: '该订单状态不可提交凭证' })
  // 防刷单③：凭证号严格全局唯一（含已取消订单）——放行已取消会留下"提交假凭证→取消→重复提交"的刷单循环；
  // 微信转账单号天然全局唯一，一人一单。误取消已付款订单的极端情况走人工（后台拒绝并备注）。
  const dup = db.orders.find(x => x.id !== o.id && x.voucher === voucher)
  if (dup) return json(res, 409, { ok: false, error: '该凭证号已被使用，请核对微信账单里的真实转账单号' })
  o.voucher = voucher
  o.status = 'reviewing'
  o.updatedAt = new Date().toISOString()
  saveOrders(db)
  // 手机息屏提醒：有人提交凭证 → 推送到 ntfy 主题（装 ntfy app 订阅同主题即可收系统通知）
  const ou = loadUsers().users.find(x => x.id === o.uid)
  notifyAdmin('MSMate 待审核充值', `${(ou && (ou.nickname || ou.email)) || '用户'} 提交了 ¥${o.amount} 凭证，单号 ${o.id}，请打开批款后台处理`)
  json(res, 200, { ok: true, order: orderPublic(o) })
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

// ─────────────────── 应用层传输加密（v0.6：备案前 HTTP 过渡方案）───────────────────
// 客户端用内置公钥把密码字段加密成 passwordEnc（RSA-OAEP-SHA256 Base64），服务端私钥解密——
// HTTP 明文链路上中间人只能看到密文，密码不泄露。备案过后叠加真 HTTPS，此层保留作纵深防御。
// 密钥对首次启动生成存 data/rsa-key.json；公钥经 GET /v1/auth/pubkey 下发，客户端缓存。
const RSA_KEY_FILE = path.join(DATA_DIR, 'rsa-key.json')
let RSA_PUBLIC_PEM = ''
let RSA_PRIVATE_PEM = ''
try {
  const j = JSON.parse(fs.readFileSync(RSA_KEY_FILE, 'utf8'))
  RSA_PUBLIC_PEM = String(j.public || '')
  RSA_PRIVATE_PEM = String(j.private || '')
} catch { }
if (!RSA_PUBLIC_PEM || !RSA_PRIVATE_PEM) {
  const kp = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  RSA_PUBLIC_PEM = kp.publicKey
  RSA_PRIVATE_PEM = kp.privateKey
  try { fs.writeFileSync(RSA_KEY_FILE, JSON.stringify({ public: RSA_PUBLIC_PEM, private: RSA_PRIVATE_PEM })) } catch (e) { console.error('[crypto] 密钥落盘失败: ' + e.message) }
  console.log('[crypto] RSA 密钥对已生成（data/rsa-key.json）')
}

function rsaDecryptB64(b64) {
  try {
    return crypto.privateDecrypt(
      { key: RSA_PRIVATE_PEM, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(String(b64 || ''), 'base64')
    ).toString('utf8')
  } catch { return null }
}

// 密码字段解密：passwordEnc（密文）优先；明文 password 兼容旧客户端（过渡期）。
// 传了 passwordEnc 但解密失败 = 数据可疑，返回 null 由调用方拒绝
function decryptPassword(body) {
  if (body && body.passwordEnc != null) {
    const p = rsaDecryptB64(body.passwordEnc)
    if (p == null || p === '') return null
    return p
  }
  return String((body && body.password) || '')
}

// ─────────────────── 用户反馈（v0.6：应用内反馈 → 服务端存档 → 后台查看）───────────────────
// 客户端反馈弹窗提交 {type: bug|idea, content, contact?}（须登录）；存 feedback.json + ntfy 通知管理员。
// 详细问题引导用户去 GitHub Issues（客户端弹窗带链接）；后台可标记已处理。
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json')
const feedbackSeen = new Map() // uid → [时间戳] 限流用（每用户每小时 5 条）
function loadFeedback() {
  const j = loadJson(FEEDBACK_FILE, { seq: 0, items: [] })
  return j && Array.isArray(j.items) ? j : { seq: 0, items: [] }
}

function handleFeedbackSubmit(req, res, body, user) {
  const type = String(body.type || 'bug') === 'idea' ? 'idea' : 'bug'
  const content = String(body.content || '').trim().slice(0, 2000)
  const contact = String(body.contact || '').trim().slice(0, 120)
  const appVersion = String(body.appVersion || '').trim().slice(0, 32)
  if (content.length < 5) return json(res, 400, { ok: false, error: '反馈内容太短了（至少 5 个字）' })
  // 限流：每用户每小时 5 条（内存计数，重启清零可接受——刷子重启也就多 5 条）
  const now = Date.now()
  const arr = (feedbackSeen.get(user.id) || []).filter(t => now - t < 3600 * 1000)
  if (arr.length >= 5) return json(res, 429, { ok: false, error: '反馈太频繁了，一小时后再试' })
  arr.push(now)
  feedbackSeen.set(user.id, arr)
  const db = loadFeedback()
  db.seq = (db.seq || 0) + 1
  const item = {
    id: 'fb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    seq: db.seq,
    type,
    content,
    contact,
    appVersion,
    uid: user.id,
    email: user.email || '',
    ip: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
    at: new Date().toISOString(),
    resolved: false
  }
  db.items.unshift(item)
  db.items = db.items.slice(0, 500) // 上限 500 条，防膨胀
  saveJson(FEEDBACK_FILE, db)
  notifyAdmin('收到用户反馈（' + (type === 'bug' ? '问题' : '建议') + '）', 'seq#' + db.seq + ' ' + (user.email || user.id) + '：' + content.slice(0, 120))
  json(res, 200, { ok: true, seq: db.seq })
}

// ─────────────────── 后台数据聚合（v0.6：仪表盘）───────────────────
function adminStatsPayload() {
  const users = loadUsers().users
  const orders = loadOrders().orders
  const today = new Date().toISOString().slice(0, 10)
  let todayPaid = 0, totalPaid = 0
  for (const o of orders) {
    if (o.status === 'done') {
      totalPaid += Number(o.amount) || 0
      if (String(o.createdAt || '').slice(0, 10) === today) todayPaid += Number(o.amount) || 0
    }
  }
  const fb = loadFeedback().items
  const pres = loadPresence()
  const now = Date.now()
  const onlineDevices = Object.values(pres).filter(d => now - new Date(d.lastAt).getTime() <= 90 * 1000).length
  return {
    users: users.length,
    orders: {
      total: orders.length,
      pending: orders.filter(o => o.status === 'pending').length,
      reviewing: orders.filter(o => o.status === 'reviewing').length,
      done: orders.filter(o => o.status === 'done').length,
      rejected: orders.filter(o => o.status === 'rejected').length
    },
    todayPaid,
    totalPaid,
    onlineDevices,
    feedback: { total: fb.length, open: fb.filter(x => !x.resolved).length },
    newUsersToday: users.filter(u => String(u.createdAt || '').slice(0, 10) === today).length
  }
}

function handleAdminStats(req, res) {
  json(res, 200, { ok: true, stats: adminStatsPayload() })
}

function handleAdminDevices(req, res) {
  const db = loadPresence()
  const now = Date.now()
  const users = loadUsers().users
  const uMap = new Map(users.map(u => [u.id, u]))
  const devices = Object.values(db)
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
    .slice(0, 200)
    .map(d => {
      const online = now - new Date(d.lastAt).getTime() <= 90 * 1000
      const u = uMap.get(d.uid)
      return { deviceId: d.deviceId, name: d.name, platform: d.platform, ip: d.ip, lastAt: d.lastAt, online, email: u ? u.email : '' }
    })
  json(res, 200, { ok: true, devices, onlineCount: devices.filter(d => d.online).length })
}

function handleAdminFeedback(req, res, query) {
  const db = loadFeedback()
  const filter = (query && query.filter) || 'open'
  const items = db.items
    .filter(x => filter === 'all' ? true : !x.resolved)
    .slice(0, 200)
  json(res, 200, { ok: true, items, openCount: db.items.filter(x => !x.resolved).length })
}

function handleAdminFeedbackResolve(req, res, body, fbId) {
  const db = loadFeedback()
  const it = db.items.find(x => x.id === fbId)
  if (!it) return json(res, 404, { ok: false, error: '反馈不存在' })
  it.resolved = true
  it.resolvedAt = new Date().toISOString()
  saveJson(FEEDBACK_FILE, db)
  json(res, 200, { ok: true })
}

function handleAdminUsers(req, res) {
  const users = loadUsers().users
  const orders = loadOrders().orders
  const paidMap = new Map()
  for (const o of orders) {
    if (o.status === 'done') paidMap.set(o.uid, (paidMap.get(o.uid) || 0) + (Number(o.amount) || 0))
  }
  const list = users
    .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 300)
    .map(u => ({ id: u.id, email: u.email, nickname: u.nickname || '', credits: u.credits || 0, createdAt: u.createdAt || '', paid: paidMap.get(u.id) || 0 }))
  json(res, 200, { ok: true, users: list })
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
body{font:14px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#eef0f6;color:#26283c}
a{color:#6d5ae0}
/* 布局：桌面侧栏 + 内容区；手机顶部横滚页签 */
#wrap{display:flex;min-height:100vh}
#side{width:172px;background:#1e1b33;color:#b9b4d6;padding:14px 10px;flex-shrink:0;display:flex;flex-direction:column;gap:4px}
#side .logo{color:#fff;font-size:16px;font-weight:700;padding:6px 10px 14px;display:flex;align-items:center;gap:8px}
#side .logo i{width:10px;height:10px;border-radius:3px;background:#8b74f0;display:inline-block}
#side button{display:block;width:100%;text-align:left;background:transparent;color:#b9b4d6;border:0;border-radius:10px;padding:10px 12px;cursor:pointer;font:inherit}
#side button:hover{background:#2c2849;color:#fff}
#side button.on{background:#6d5ae0;color:#fff}
#side button .n{float:right;font-size:12px;background:#e0524c;color:#fff;border-radius:99px;padding:0 7px}
#side .foot{margin-top:auto;font-size:11px;color:#6d6a8c;padding:10px}
#main{flex:1;padding:18px;max-width:980px}
#topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap}
#topbar h1{font-size:19px;color:#2b2350}
.card{background:#fff;border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(30,20,70,.08)}
input,select,textarea{font:inherit;padding:9px 12px;border:1px solid #d9d8e6;border-radius:10px;width:100%;margin-bottom:10px}
button{font:inherit;border:0;border-radius:10px;padding:9px 16px;background:#6d5ae0;color:#fff;cursor:pointer}
button.sec{background:#ece9f8;color:#4a3a8a}
button.ok{background:#18a058}
button.no{background:#e0524c}
button:disabled{opacity:.55;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap}
.meta{color:#6b6a80;font-size:12px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px}
.b-rv{background:#fdf1e0;color:#a05a00}.b-pd{background:#e8e8f2;color:#555}.b-done{background:#e2f6ea;color:#0d7a43}.b-rj{background:#fde8e7;color:#b03028}
.b-on{background:#e2f6ea;color:#0d7a43}.b-off{background:#e8e8f2;color:#777}.b-bug{background:#fde8e7;color:#b03028}.b-idea{background:#e8f0fd;color:#2563b0}
.amount{font-size:20px;font-weight:700;color:#3a2d6b}
.subtabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.subtabs button{background:#fff;color:#4a3a8a;box-shadow:0 1px 3px rgba(30,20,70,.1)}
.subtabs button.on{background:#6d5ae0;color:#fff}
.hide{display:none}
.err{color:#b03028;font-size:13px;margin-bottom:8px}
.empty{color:#8a89a0;text-align:center;padding:30px 0}
/* 仪表盘统计卡 */
#stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:12px}
#stats .st{background:#fff;border-radius:14px;padding:14px;box-shadow:0 1px 4px rgba(30,20,70,.08)}
#stats .st b{display:block;font-size:24px;color:#2b2350}
#stats .st span{font-size:12px;color:#6b6a80}
#stats .st.hl b{color:#6d5ae0}
/* 表格 */
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#6b6a80;font-weight:600;text-align:left;padding:7px 8px;border-bottom:1px solid #e4e3ef;white-space:nowrap}
td{padding:8px;border-bottom:1px solid #f0eff6;vertical-align:top}
tr:last-child td{border-bottom:0}
@media (max-width:719px){
  #wrap{flex-direction:column}
  #side{width:100%;flex-direction:row;overflow-x:auto;padding:8px;align-items:center}
  #side .logo{padding:4px 8px;white-space:nowrap}
  #side .foot{display:none}
  #side button{width:auto;white-space:nowrap;padding:8px 12px}
  #main{padding:12px}
}
</style></head><body>
<div id="wrap">
  <div id="login" class="hide" style="padding:24px;max-width:420px;margin:10vh auto 0">
    <div class="card">
      <h1 style="font-size:18px;margin-bottom:12px;color:#2b2350">MSMate 批款后台</h1>
      <div class="err" id="lerr"></div>
      <input id="key" type="password" placeholder="管理密钥（ADMIN_PASS 或 data/admin.key）">
      <button id="lbtn" type="button">登录</button>
    </div>
  </div>
  <div id="panel" class="hide" style="display:flex;width:100%">
    <div id="side">
      <div class="logo"><i></i>MSMate 后台</div>
      <button type="button" data-view="dashboard" class="on">仪表盘</button>
      <button type="button" data-view="orders">订单<span class="n hide" id="nOrders"></span></button>
      <button type="button" data-view="users">用户</button>
      <button type="button" data-view="feedback">反馈<span class="n hide" id="nFeedback"></span></button>
      <button type="button" data-view="devices">在线设备</button>
      <div class="foot">
        <div id="lastcheck"></div>
        <button class="sec" id="sndbtn" type="button" style="margin-top:8px"></button>
        <button class="sec" id="logout" type="button" style="margin-top:6px">退出登录</button>
      </div>
    </div>
    <div id="main">
      <div id="v-dashboard" class="view">
        <div id="topbar"><h1>仪表盘</h1><span class="meta" id="dashTime"></span></div>
        <div id="stats"></div>
        <div class="card"><b>待处理</b><div id="dashTodo" class="meta" style="margin-top:6px"></div></div>
      </div>
      <div id="v-orders" class="view hide">
        <div id="topbar"><h1>充值订单</h1></div>
        <div class="subtabs" id="otabs"></div>
        <div id="olist"></div>
      </div>
      <div id="v-users" class="view hide">
        <div id="topbar"><h1>用户</h1><span class="meta" id="uCount"></span></div>
        <div class="card" style="padding:6px 10px"><div id="ulist"></div></div>
      </div>
      <div id="v-feedback" class="view hide">
        <div id="topbar"><h1>用户反馈</h1></div>
        <div class="subtabs" id="ftabs"></div>
        <div id="flist"></div>
      </div>
      <div id="v-devices" class="view hide">
        <div id="topbar"><h1>在线设备</h1><span class="meta" id="dCount"></span></div>
        <div class="card" style="padding:6px 10px"><div id="dlist"></div></div>
      </div>
    </div>
  </div>
</div>
<script>
// 全兼容写法：XHR 替代 fetch（老内核手机浏览器无 fetch/Object.assign），localStorage 防御（隐私模式会抛异常）
function storageGet(k) { try { return localStorage.getItem(k) } catch (e) { return '' } }
function storageSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { } }
function storageDel(k) { try { localStorage.removeItem(k) } catch (e) { } }
var token = storageGet('adm_token') || ''
var counts = {}
var orderNames = { reviewing: '待审核', pending: '未提交凭证', done: '已到账', rejected: '已拒绝', all: '全部' }
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
var view = 'dashboard'
var orderStatus = 'reviewing'
var fbFilter = 'open'
function showPanel() {
  document.getElementById('login').classList.add('hide')
  document.getElementById('panel').classList.remove('hide')
  renderSndBtn()
  document.getElementById('sndbtn').onclick = function () {
    soundOn = !soundOn
    storageSet('adm_sound', soundOn ? 'on' : 'off')
    renderSndBtn()
  }
  document.getElementById('logout').onclick = function () { storageDel('adm_token'); location.reload() }
  try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission() } catch (e) { }
  keepAlive()
  showView('dashboard')
  poll()
  setInterval(poll, 15000)
}
function showView(v) {
  view = v
  var btns = document.querySelectorAll('#side button[data-view]')
  for (var i = 0; i < btns.length; i++) btns[i].className = btns[i].getAttribute('data-view') === v ? 'on' : ''
  var views = document.querySelectorAll('.view')
  for (var j = 0; j < views.length; j++) views[j].className = 'view' + (views[j].id === 'v-' + v ? '' : ' hide')
  if (v === 'dashboard') loadDash()
  else if (v === 'orders') loadOrders()
  else if (v === 'users') loadUsersView()
  else if (v === 'feedback') loadFeedbackView()
  else if (v === 'devices') loadDevices()
}
function updateBadges(s) {
  var n1 = document.getElementById('nOrders')
  var n2 = document.getElementById('nFeedback')
  var r = (s.orders.reviewing || 0) + (s.orders.pending || 0)
  if (n1) { n1.textContent = r; n1.className = r ? 'n' : 'n hide' }
  if (n2) { n2.textContent = s.feedback.open; n2.className = s.feedback.open ? 'n' : 'n hide' }
}
function loadDash() {
  xhr('GET', '/admin/api/stats', null, function (j) {
    if (!j.ok) return
    var s = j.stats
    var cards = [
      ['用户总数', s.users, ''], ['今日新增用户', s.newUsersToday, ''], ['今日充值', '¥' + s.todayPaid, ''],
      ['累计充值', '¥' + s.totalPaid, ''], ['在线设备', s.onlineDevices, 'hl'], ['未读反馈', s.feedback.open, 'hl']
    ]
    var html = ''
    for (var i = 0; i < cards.length; i++) {
      html += '<div class="st' + cards[i][2] + '"><b>' + esc(cards[i][1]) + '</b><span>' + cards[i][0] + '</span></div>'
    }
    document.getElementById('stats').innerHTML = html
    document.getElementById('dashTime').textContent = '更新于 ' + new Date().toLocaleTimeString()
    var todo = []
    if (s.orders.reviewing) todo.push(s.orders.reviewing + ' 笔订单待审核')
    if (s.orders.pending) todo.push(s.orders.pending + ' 笔未提交凭证')
    if (s.feedback.open) todo.push(s.feedback.open + ' 条反馈未读')
    document.getElementById('dashTodo').textContent = todo.length ? todo.join('；') : '暂无待处理事项，喝口茶喵'
    updateBadges(s)
  })
}
function loadOrders() {
  var tabs = document.getElementById('otabs')
  tabs.innerHTML = ''
  var names = Object.keys(orderNames)
  for (var i = 0; i < names.length; i++) {
    (function (s) {
      var b = document.createElement('button')
      if (s === orderStatus) b.className = 'on'
      b.textContent = orderNames[s] + (counts[s] ? ' ' + counts[s] : '')
      b.onclick = function () { orderStatus = s; loadOrders() }
      tabs.appendChild(b)
    })(names[i])
  }
  xhr('GET', '/admin/api/orders?status=' + orderStatus, null, function (j) {
    if (!j.ok) { storageDel('adm_token'); token = ''; location.reload(); return }
    counts = j.counts
    var el = document.getElementById('olist')
    // 按钮用 data-* + 事件委托，避免内联 onclick 引号嵌套出错（模板字符串转义曾致整页 JS 挂掉）
    el.onclick = function (e) {
      var t = e.target
      if (!t || !t.getAttribute) return
      var id = t.getAttribute('data-oid')
      var what = t.getAttribute('data-what')
      if (id && what) act(id, what)
    }
    if (!j.orders.length) { el.innerHTML = '<div class="card"><div class="empty">暂无订单</div></div>'; return }
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
function loadUsersView() {
  xhr('GET', '/admin/api/users', null, function (j) {
    if (!j.ok) return
    document.getElementById('uCount').textContent = '共 ' + j.users.length + ' 人'
    var el = document.getElementById('ulist')
    if (!j.users.length) { el.innerHTML = '<div class="empty">暂无用户</div>'; return }
    var html = '<table><tr><th>邮箱</th><th>昵称</th><th>积分</th><th>累计充值</th><th>注册时间</th></tr>'
    for (var i = 0; i < j.users.length; i++) {
      var u = j.users[i]
      html += '<tr><td>' + esc(u.email) + '</td><td>' + esc(u.nickname || '—') + '</td><td>' + esc(u.credits) + '</td><td>¥' + esc(u.paid) + '</td><td class="meta">' + esc(String(u.createdAt).slice(0, 10)) + '</td></tr>'
    }
    el.innerHTML = html + '</table>'
  })
}
function loadFeedbackView() {
  var tabs = document.getElementById('ftabs')
  tabs.innerHTML = ''
  var names = { open: '未读', all: '全部' }
  var kn = Object.keys(names)
  for (var i = 0; i < kn.length; i++) {
    (function (s) {
      var b = document.createElement('button')
      if (s === fbFilter) b.className = 'on'
      b.textContent = names[s]
      b.onclick = function () { fbFilter = s; loadFeedbackView() }
      tabs.appendChild(b)
    })(kn[i])
  }
  xhr('GET', '/admin/api/feedback?filter=' + fbFilter, null, function (j) {
    if (!j.ok) return
    var el = document.getElementById('flist')
    el.onclick = function (e) {
      var t = e.target
      if (!t || !t.getAttribute) return
      var fid = t.getAttribute('data-fid')
      if (fid && t.getAttribute('data-act') === 'resolve') resolveFeedback(fid)
    }
    if (!j.items.length) { el.innerHTML = '<div class="card"><div class="empty">没有反馈，岁月静好</div></div>'; return }
    var html = ''
    for (var i = 0; i < j.items.length; i++) {
      var f = j.items[i]
      html += '<div class="card">'
        + '<div class="row" style="justify-content:space-between;align-items:center"><span class="badge ' + (f.type === 'bug' ? 'b-bug' : 'b-idea') + '">' + (f.type === 'bug' ? '问题' : '建议') + '</span>'
        + '<span class="meta">#' + esc(f.seq) + ' · ' + esc(String(f.at).replace('T', ' ').slice(0, 16)) + '</span></div>'
        + '<div style="margin:6px 0;white-space:pre-wrap">' + esc(f.content) + '</div>'
        + '<div class="meta">' + esc(f.email) + (f.contact ? ' · 联系方式 ' + esc(f.contact) : '') + (f.appVersion ? ' · v' + esc(f.appVersion) : '') + '</div>'
        + (!f.resolved ? '<div class="row" style="margin-top:8px"><button class="sec" data-fid="' + esc(f.id) + '" data-act="resolve">标记已处理</button></div>' : '<div class="meta">已处理 ' + esc(String(f.resolvedAt).slice(0, 16)) + '</div>')
        + '</div>'
    }
    el.innerHTML = html
  })
}
function resolveFeedback(fid) {
  xhr('POST', '/admin/api/feedback/' + fid + '/resolve', {}, function (j) {
    if (j.ok) loadFeedbackView()
    else alert(j.error || '操作失败')
  })
}
function loadDevices() {
  xhr('GET', '/admin/api/devices', null, function (j) {
    if (!j.ok) return
    document.getElementById('dCount').textContent = '在线 ' + j.onlineCount + ' 台 / 记录 ' + j.devices.length + ' 台'
    var el = document.getElementById('dlist')
    if (!j.devices.length) { el.innerHTML = '<div class="empty">还没有设备心跳</div>'; return }
    var html = '<table><tr><th>设备</th><th>平台</th><th>状态</th><th>IP</th><th>所属账号</th><th>最后心跳</th></tr>'
    for (var i = 0; i < j.devices.length; i++) {
      var d = j.devices[i]
      html += '<tr><td>' + esc(d.name) + '</td><td class="meta">' + esc(d.platform || '—') + '</td>'
        + '<td><span class="badge ' + (d.online ? 'b-on' : 'b-off') + '">' + (d.online ? '在线' : '离线') + '</span></td>'
        + '<td class="meta">' + esc(d.ip) + '</td><td class="meta">' + esc(d.email || '—') + '</td>'
        + '<td class="meta">' + esc(String(d.lastAt).replace('T', ' ').slice(0, 19)) + '</td></tr>'
    }
    el.innerHTML = html + '</table>'
  })
}
function act(id, what) {
  if (what === 'reject' && !confirm('确认拒绝该订单？')) return
  xhr('POST', '/admin/api/orders/' + id + '/' + what, {}, function (j) {
    if (j.ok) loadOrders()
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
  xhr('GET', '/admin/api/stats', null, function (j) {
    if (!j.ok) return
    var s = j.stats
    var n = s.orders.reviewing
    var el = document.getElementById('lastcheck')
    if (el) el.textContent = '上次检查 ' + new Date().toLocaleTimeString() + ' · 待审 ' + n + ' · 在线 ' + s.onlineDevices + ' · 反馈 ' + s.feedback.open
    if (lastReviewing >= 0 && n > lastReviewing) {
      if (soundOn) beep()
      try { if (window.Notification && Notification.permission === 'granted') new Notification('MSMate 批款后台', { body: n + ' 单待审核，点击打开此页面处理' }) } catch (e) { }
      if (view === 'orders') loadOrders()
    }
    if (n === 0) document.title = BASE_TITLE
    else document.title = '（' + n + ' 单待审核）' + BASE_TITLE
    lastReviewing = n
    updateBadges(s)
    if (view === 'dashboard') loadDash()
  })
}
document.getElementById('key').onkeydown = function (e) { if (e.key === 'Enter' || e.keyCode === 13) login() }
document.getElementById('lbtn').onclick = login
if (token) xhr('GET', '/admin/api/stats', null, function (j) {
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
  version: '2.7.16',
  url: 'https://github.com/Mosina1102/MSMate/releases/latest',
  notes: '传输加密（密码全程 RSA 加密）；好友桥接支持设备 ID 直连；网页下载显示进度条；新增应用内问题反馈；批款后台 v0.6 大改版（仪表盘/用户/反馈/在线设备）',
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
      return json(res, 200, { ok: true, service: 'msmate-api', version: '0.6.0', time: new Date().toISOString() })
    }
    if (req.method === 'GET' && pathname === '/v1/latest') return json(res, 200, { ok: true, data: LATEST })
    if (req.method === 'GET' && pathname === '/v1/myip') return json(res, 200, { ok: true, ip: ip.replace(/^::ffff:/, '') })

    // 认证
    if (req.method === 'GET' && pathname === '/v1/auth/pubkey') return json(res, 200, { ok: true, pubkey: RSA_PUBLIC_PEM })
    if (req.method === 'POST' && pathname === '/v1/auth/send-code') return await handleSendCode(req, res, await readBody(req), ip)
    if (req.method === 'POST' && pathname === '/v1/auth/register') return await handleAuthRegister(req, res, await readBody(req), ip)
    if (req.method === 'POST' && pathname === '/v1/auth/login') return await handleAuthLogin(req, res, await readBody(req), ip)
    if (req.method === 'POST' && pathname === '/v1/auth/reset') return await handleAuthReset(req, res, await readBody(req), ip)

    // 用户反馈（须登录；限流在 handler 内）
    if (req.method === 'POST' && pathname === '/v1/feedback') {
      const user = authUser(req)
      if (!user) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
      return handleFeedbackSubmit(req, res, await readBody(req), user)
    }

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
    // v0.6 后台扩展：仪表盘 / 在线设备 / 用户反馈
    if (req.method === 'GET' && pathname === '/admin/api/stats') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminStats(req, res)
    }
    if (req.method === 'GET' && pathname === '/admin/api/devices') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminDevices(req, res)
    }
    if (req.method === 'GET' && pathname === '/admin/api/feedback') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminFeedback(req, res, query)
    }
    if (req.method === 'POST' && /^\/admin\/api\/feedback\/[^/]+\/resolve$/.test(pathname)) {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminFeedbackResolve(req, res, await readBody(req), pathname.split('/')[4])
    }
    if (req.method === 'GET' && pathname === '/admin/api/users') {
      if (!adminAuth(req)) return json(res, 401, { ok: false, error: '后台登录已过期' })
      return handleAdminUsers(req, res)
    }

    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    const msg = e.message === 'invalid json' ? '请求格式错误' : e.message === 'body too large' ? '请求体过大' : '服务器内部错误'
    console.error('[err]', pathname, e.message)
    json(res, e.message === 'invalid json' ? 400 : e.message === 'body too large' ? 413 : 500, { ok: false, error: msg })
  }
})

server.listen(PORT, () => {
  console.log(`msmate-api v0.6.0 listening on 0.0.0.0:${PORT} (mail: ${MAIL_ON ? 'SMTP' : 'dev 模式，验证码走日志/接口'})`)
})
