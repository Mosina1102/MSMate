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

// 渠道② 邮件兜底：腾讯云到 ntfy.sh 常年不通（国内被墙），推送失败/未配置时改发邮件到发件账号自己
// （QQ 邮箱 app 有新邮件通知）；1 分钟内同标题+内容去重，防超时重试连发
function notifyAdminByMail(title, body, why) {
  if (!MAIL_CFG.host || !MAIL_CFG.user || !MAIL_CFG.pass) { console.warn(`[ntfy→mail] SMTP 未配置，兜底跳过: ${title}`); return }
  const sig = title + '|' + body
  if (notifyAdminByMail._sig === sig && Date.now() - notifyAdminByMail._t < 60000) return
  notifyAdminByMail._sig = sig
  notifyAdminByMail._t = Date.now()
  sendMail(MAIL_CFG.user, `[MSMate] ${title}`, `${body}\n\n—— ntfy 兜底邮件（原因：${why}）`).then(
    () => console.log(`[ntfy→mail] 兜底邮件已发: ${title}（原因: ${why}）`),
    (e) => console.error(`[ntfy→mail] 兜底邮件失败: ${e.message}`)
  )
}

function notifyAdmin(title, body) {
  if (!NTFY_TOPIC) { notifyAdminByMail(title, body, 'NTFY_TOPIC 未配置'); return }
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
      res.on('end', () => {
        console.log(`[ntfy] ${res.statusCode} ${title}`)
        if (res.statusCode !== 200) notifyAdminByMail(title, body, `ntfy HTTP ${res.statusCode}: ${buf.slice(0, 80)}`)
      })
    })
    req.on('error', (e) => {
      console.error(`[ntfy] 推送失败: ${e.message}（服务器到 ${NTFY_SERVER} 不通？）`)
      notifyAdminByMail(title, body, `ntfy 不通: ${e.message}`)
    })
    req.setTimeout(8000, () => { try { req.destroy(new Error('timeout')) } catch { } })
    req.write(payload)
    req.end()
  } catch (e) {
    console.error(`[ntfy] 推送构造失败: ${e.message}`)
    notifyAdminByMail(title, body, `ntfy 构造失败: ${e.message}`)
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
  let buf
  try { buf = Buffer.from(String(b64 || ''), 'base64') } catch { return null }
  if (!buf.length) return null
  // 双 padding 兼容：桌面客户端 RSA-OAEP-SHA256；手机端 jsencrypt 默认 PKCS1-v1.5（v0.7 MSMate App）
  for (const padding of [crypto.constants.RSA_PKCS1_OAEP_PADDING, crypto.constants.RSA_PKCS1_PADDING]) {
    try {
      return crypto.privateDecrypt({ key: RSA_PRIVATE_PEM, padding, oaepHash: 'sha256' }, buf).toString('utf8')
    } catch { }
  }
  return null
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
  { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6 35B A3B', desc: '超值档，轻量任务，MoE 秒级响应，支持视觉（识图默认）', costIn: 1.8, costOut: 10.8, vision: true },
  { id: 'zai-org/GLM-4.5V', name: 'GLM-4.5V 视觉', desc: '看图/截图理解', costIn: 1, costOut: 6, costCache: 0.1, vision: true },
  { id: 'zai-org/GLM-5.3', name: 'GLM-5.3 旗舰', desc: '深度思考，复杂任务', costIn: 8, costOut: 28, costCache: 2, premium: true },
  { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8 27B 视觉', desc: '原生视觉看图/OCR（稠密慢但细节强）', costIn: 3, costOut: 12, vision: true, visionOnly: true },
  { id: 'PaddlePaddle/PaddleOCR-VL-1.5', name: 'PaddleOCR 视觉', desc: '看图/OCR（免费备胎，上游免费但限流）', costIn: 0, costOut: 0, vision: true, visionOnly: true }
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
  let raw
  try { raw = await readRaw(req, 2 * 1024 * 1024) } catch (e) {
    if (e && /too large/i.test(e.message)) return json(res, 413, { ok: false, error: '请求体超过 2MB：图片太大，请压缩图片后再识图' })
    return json(res, 400, { ok: false, error: '请求读取失败' })
  }
  let body
  try { body = JSON.parse(raw.toString('utf8') || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是有效 JSON' }) }
  const model = String(body.model || '')
  const meta = AI_CHAT_MODELS.find(m => m.id === model)
  if (!meta) return json(res, 400, { ok: false, error: `模型不在内置清单：${model || '(空)'}` })
  const maxTokens = Math.min(8192, Math.max(1, +body.max_tokens || 8192))
  body.max_tokens = maxTokens
  // 只有显式 stream:true 才走流式（主对话客户端显式传了；view_image 等工具不传=非流式，
  // 不能默认流式强转——老客户端拿到 SSE 解析不了，且只加 stream_options 不设 stream 会被上游 502）
  const stream = body.stream === true
  if (stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
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

// token 直接验证（WS 鉴权用，不走 http header）
function authUserByToken(token) {
  const t = verifyToken(token)
  if (!t) return null
  const user = loadUsers().users.find(u => u.id === t.uid)
  if (!user || (user.pwdV || 1) !== t.pwdV) return null
  return user
}

// ─────────────────── 收款码（v0.7：MSMate App 充值扫码用，base64 内嵌保持单文件部署）───────────────────
const PAY_QR_DATAURL = 'data:image/png;base64,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'

// ─────────────────── WebSocket（v0.7：MSMate App 流式 AI 通道，RFC6455 手写零依赖）───────────────────
// 端点 /ws。协议见 MSMate-App/PLAN.md：首帧 auth {token}，此后 chat.send / image.gen / ping。
// 服务端每 30s 发 ping 帧；90s 无任何帧（含 pong）断开。
const wsClients = new Set()

function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}

function wsEncode(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const len = data.length
  let head
  if (len < 126) { head = Buffer.alloc(2); head[1] = len }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) }
  head[0] = 0x80 | opcode
  return Buffer.concat([head, data])
}

function wsSend(ws, obj) {
  try { if (!ws.socket.destroyed) ws.socket.write(wsEncode(JSON.stringify(obj))) } catch { }
}

function wsClose(ws, code = 1000) {
  try { ws.socket.write(wsEncode(Buffer.from([(code >> 8) & 0xff, code & 0xff]), 0x8)) } catch { }
  try { ws.socket.end() } catch { }
  try { ws.socket.destroy() } catch { }
}

// 解析一帧；返回消耗字节数（0=数据不完整，-1=连接已关闭）
function wsHandleFrame(ws) {
  const buf = ws.buffer
  if (buf.length < 2) return 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { if (buf.length < 4) return 0; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return 0; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  if (len > 4 * 1024 * 1024) { wsClose(ws, 1009); return -1 }
  let mask = null
  if (masked) { if (buf.length < off + 4) return 0; mask = buf.slice(off, off + 4); off += 4 }
  if (buf.length < off + len) return 0
  let payload = buf.slice(off, off + len)
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  ws.buffer = buf.slice(off + len)
  if (opcode === 0x8) { wsClose(ws); return -1 }                    // close
  if (opcode === 0x9) { try { if (!ws.socket.destroyed) ws.socket.write(wsEncode(payload, 0xA)) } catch { }; return off + len } // ping→pong
  if (opcode === 0xA) { ws.lastSeen = Date.now(); return off + len } // pong
  if (opcode === 0x1) {
    ws.lastSeen = Date.now()
    let msg = null
    try { msg = JSON.parse(payload.toString('utf8')) } catch { }
    if (msg) {
      try { wsOnMessage(ws, msg) } catch (e) { console.error('[ws] 消息处理异常: ' + e.message) }
    }
    return off + len
  }
  return off + len // 二进制/分片帧：v1 不支持，静默丢弃
}

function wsOnMessage(ws, msg) {
  const t = String(msg.t || '')
  if (!ws.authed) {
    if (t !== 'auth') { wsSend(ws, { t: 'auth.fail', error: '请先鉴权' }); return wsClose(ws, 4001) }
    const user = authUserByToken(String(msg.token || ''))
    if (!user) { wsSend(ws, { t: 'auth.fail', error: '登录已过期，请重新登录' }); return wsClose(ws, 4001) }
    ws.authed = true
    ws.user = user
    return wsSend(ws, { t: 'auth.ok', user: publicUser(user), credits: user.credits || 0 })
  }
  if (t === 'ping') return wsSend(ws, { t: 'pong' })
  if (t === 'chat.send') {
    wsChatSend(ws, msg).catch(e => wsSend(ws, { t: 'error', id: msg.id, error: '对话处理异常: ' + e.message }))
    return
  }
  if (t === 'image.gen') {
    wsImageGen(ws, msg).catch(e => wsSend(ws, { t: 'error', id: msg.id, error: '生图处理异常: ' + e.message }))
    return
  }
  if (t === 'video.gen') return wsSend(ws, { t: 'error', id: msg.id, error: '视频功能即将开放，敬请期待' })
  wsSend(ws, { t: 'error', id: msg.id, error: '未知消息类型' })
}

// 流式对话桥：上游 SSE → chat.delta 逐段下发 → 结算 → chat.done（计费公式与 HTTP 版一致）
async function wsChatSend(ws, msg) {
  const id = String(msg.id || '')
  const user = ws.user
  const body = msg.body || {}
  const model = String(body.model || '')
  const meta = AI_CHAT_MODELS.find(m => m.id === model)
  if (!meta) return wsSend(ws, { t: 'error', id, error: `模型不在内置清单：${model || '(空)'}` })
  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : []
  if (!messages.length) return wsSend(ws, { t: 'error', id, error: '对话内容为空' })
  const maxTokens = Math.min(8192, Math.max(1, +body.max_tokens || 8192))
  const payload = JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } })
  const worst = aiCreditsFromYuan(maxTokens * meta.costOut / 1e6)
  const gate = Math.min(worst, 20)
  if (aiBalanceOf(user) < gate) {
    return wsSend(ws, { t: 'error', id, code: 'INSUFFICIENT_CREDITS', error: `积分不足（余额 ${aiBalanceOf(user)}，本次至少需 ${gate} 积分），请充值` })
  }
  if (!SF_API_KEY) return wsSend(ws, { t: 'error', id, error: 'AI 服务未配置，请联系管理员' })
  const { outReq, done } = sfProxy('/chat/completions', { headers: { 'Content-Type': 'application/json' }, body: payload })
  let upRes
  try { upRes = await done } catch (e) { return wsSend(ws, { t: 'error', id, error: '上游连接失败: ' + e.message }) }
  if (upRes.statusCode !== 200) {
    let text = ''
    upRes.on('data', c => { text += c; if (text.length > 4000) upRes.destroy() })
    await new Promise(r => upRes.on('close', r))
    let m = `AI 服务错误（HTTP ${upRes.statusCode}）`
    try { const j = JSON.parse(text); if (j.message) m = j.message; else if (j.error && j.error.message) m = j.error.message } catch { }
    return wsSend(ws, { t: 'error', id, error: m })
  }
  let buffer = '', usage = null, contentBytes = 0
  for await (const chunk of upRes) {
    buffer += chunk.toString('utf8')
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const j = JSON.parse(data)
        if (j.usage) usage = j.usage
        const d = j.choices && j.choices[0] && j.choices[0].delta
        if (d && d.content) {
          contentBytes += Buffer.byteLength(d.content, 'utf8')
          wsSend(ws, { t: 'chat.delta', id, delta: d.content })
        }
      } catch { }
    }
  }
  let ct = 0, pt = 0, cached = 0
  if (usage) {
    pt = usage.prompt_tokens || 0
    ct = usage.completion_tokens || 0
    cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0
  } else if (contentBytes > 0) {
    ct = Math.round(contentBytes / 3)
  }
  let credits = 0
  if (pt + ct > 0) {
    const yuan = ((pt - cached) * meta.costIn + cached * (meta.costCache ?? meta.costIn) + ct * meta.costOut) / 1e6
    credits = aiCharge(user, aiCreditsFromYuan(yuan), `对话 ${meta.name}（App）`)
  }
  wsSend(ws, { t: 'chat.done', id, credits, balance: user.credits })
}

// 生图桥：Z-Image-Turbo（扣积分，按张计费）；完成返回临时 URL
async function wsImageGen(ws, msg) {
  const id = String(msg.id || '')
  const user = ws.user
  if (!SF_API_KEY) return wsSend(ws, { t: 'error', id, error: 'AI 服务未配置，请联系管理员' })
  const meta = AI_IMAGE_MODELS.find(m => !m.edit)
  const prompt = String(msg.prompt || '').trim().slice(0, 2000)
  if (!prompt) return wsSend(ws, { t: 'error', id, error: '请描述想生成的画面' })
  const size = ['1024x1024', '960x1280', '1280x960'].includes(String(msg.size)) ? String(msg.size) : '1024x1024'
  const cost = meta.creditsPerImage
  if (aiBalanceOf(user) < cost) {
    return wsSend(ws, { t: 'error', id, code: 'INSUFFICIENT_CREDITS', error: `积分不足（余额 ${aiBalanceOf(user)}，本次需 ${cost}），请充值` })
  }
  const payload = JSON.stringify({ model: meta.id, prompt, size, n: 1 }) // Z-Image-Turbo 不支持 negative_prompt（电脑端教训）
  const { done } = sfProxy('/images/generations', { headers: { 'Content-Type': 'application/json' }, body: payload })
  let upRes
  try { upRes = await done } catch (e) { return wsSend(ws, { t: 'error', id, error: '上游连接失败: ' + e.message }) }
  if (upRes.statusCode !== 200) {
    let text = ''
    upRes.on('data', c => { text += c; if (text.length > 4000) upRes.destroy() })
    await new Promise(r => upRes.on('close', r))
    let m = `AI 服务错误（HTTP ${upRes.statusCode}）`
    try { const j = JSON.parse(text); if (j.message) m = j.message; else if (j.error && j.error.message) m = j.error.message } catch { }
    return wsSend(ws, { t: 'error', id, error: m })
  }
  const chunks = []
  upRes.on('data', c => chunks.push(c))
  await new Promise(r => upRes.on('end', r))
  let j
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return wsSend(ws, { t: 'error', id, error: 'AI 服务响应异常' }) }
  const url = j.data && j.data[0] && j.data[0].url
  if (!url) return wsSend(ws, { t: 'error', id, error: '生图结果为空，请重试' })
  const credits = aiCharge(user, cost, `${meta.name} ×1（App）`)
  wsSend(ws, { t: 'image.done', id, url, credits, balance: user.credits })
}

// WS 心跳 + 清理：30s 主动 ping；90s 无帧断开
setInterval(() => {
  const now = Date.now()
  for (const ws of wsClients) {
    if (ws.socket.destroyed) { wsClients.delete(ws); continue }
    if (now - ws.lastSeen > 90 * 1000) { wsClose(ws, 1001); wsClients.delete(ws); continue }
    try { if (!ws.socket.destroyed) ws.socket.write(wsEncode('', 0x9)) } catch { }
  }
}, 30 * 1000)

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
  /* ⚠ #side/#main 的直接父容器是 #panel（此前只改 #wrap 竖屏不生效，侧栏横排挤占内容区=只有横屏能用） */
  #panel{flex-direction:column}
  #side{width:100%;flex-direction:row;overflow-x:auto;padding:8px;align-items:center;-webkit-overflow-scrolling:touch}
  #side .logo{padding:4px 8px;white-space:nowrap}
  #side .foot{display:none}
  #side button{width:auto;white-space:nowrap;padding:8px 12px}
  #main{padding:12px;max-width:none;width:100%}
  /* 窄屏表格横向滚动，卡片操作按钮加触控热区 */
  .card{overflow-x:auto}
  button{min-height:40px}
  .subtabs button{padding:9px 14px}
}
</style></head><body>
<div id="wrap">
  <div id="login" style="padding:24px;max-width:420px;margin:10vh auto 0">
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
// 侧栏页签导航（v0.6 重写时漏绑，页签全点不动；用事件委托，手机横滚页签同样生效）
document.getElementById('side').onclick = function (e) {
  var t = e.target
  while (t && t.tagName !== 'BUTTON') t = t.parentElement
  var v = t && t.getAttribute && t.getAttribute('data-view')
  if (v) showView(v)
}
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
  version: '2.7.22',
  url: 'https://github.com/Mosina1102/MSMate/releases/latest',
  notes: '新增 AI 抠图（remove_bg）：本地模型抠图去背景，输出透明底 PNG，离线秒级零 API 费；海报合成素材全流程打通（找图→下载→抠图→排版合成）',
  publishedAt: '2026-09-12'
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
      return json(res, 200, { ok: true, service: 'msmate-api', version: '0.7.0', time: new Date().toISOString() })
    }
    if (req.method === 'GET' && pathname === '/v1/latest') return json(res, 200, { ok: true, data: LATEST })
    // v0.7：收款码（MSMate App 充值扫码用；公开——收款码本身就是给付款人看的）
    if (req.method === 'GET' && pathname === '/v1/pay-qr') return json(res, 200, { ok: true, dataUrl: PAY_QR_DATAURL })
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
      // 禁缓存：后台随服务端发版即时更新，浏览器拿旧 HTML 会跟新接口错配
      res.setHeader('Cache-Control', 'no-store')
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

server.on('upgrade', (req, socket) => {
  // v0.7：MSMate App 流式 AI 通道（/ws，RFC6455 手写实现）
  const key = req.headers['sec-websocket-key']
  if (req.url !== '/ws' || !key) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n')
  socket.setNoDelay(true)
  const ws = { socket, buffer: Buffer.alloc(0), user: null, authed: false, lastSeen: Date.now() }
  wsClients.add(ws)
  socket.on('data', (chunk) => {
    try {
      ws.buffer = Buffer.concat([ws.buffer, chunk])
      let guard = 0
      while (guard++ < 500) {
        const used = wsHandleFrame(ws)
        if (used === -1) return // 已关闭
        if (used === 0) break   // 帧不完整，等下一段
      }
    } catch (e) {
      console.error('[ws] 帧解析异常: ' + e.message)
      try { socket.destroy() } catch { }
      wsClients.delete(ws)
    }
  })
  const cleanup = () => wsClients.delete(ws)
  socket.on('close', cleanup)
  socket.on('error', cleanup)
})

server.listen(PORT, () => {
  console.log(`msmate-api v0.7.0 listening on 0.0.0.0:${PORT} (mail: ${MAIL_ON ? 'SMTP' : 'dev 模式，验证码走日志/接口'})`)
})
