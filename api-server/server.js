// MSMate API 服务 v0.2 —— 零依赖（Node 内置模块），PM2/Docker 均可跑
// 接口：
//   GET  /ping                 健康检查
//   GET  /v1/latest            客户端检查更新
//   GET  /v1/myip              返回调用者公网 IP（真远程辅助）
//   POST /v1/auth/register     邮箱注册 {email, password, nickname?} → {token, user}
//   POST /v1/auth/login        邮箱登录 {email, password}               → {token, user}
//   GET  /v1/auth/me           Bearer token 查当前用户                  → {user}
// 数据：data/users.json（原子写入），data/secret.key（首次自动生成，用于 token 签名）

const http = require('http')
const url = require('url')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PORT = process.env.PORT || 3210
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SECRET_FILE = path.join(DATA_DIR, 'secret.key')
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000 // 30 天

// ─────────────────── 基础工具 ───────────────────

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
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

const SECRET = loadSecret()

function loadUsers() {
  try {
    const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))
    if (j && Array.isArray(j.users)) return j
  } catch {}
  return { users: [] }
}

// 原子写：临时文件 + rename，防断电损坏
function saveUsers(db) {
  ensureDataDir()
  const tmp = USERS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
  fs.renameSync(tmp, USERS_FILE)
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
}

// token 结构：uid.exp.hex随机数.签名
function issueToken(uid) {
  const exp = Date.now() + TOKEN_TTL_MS
  const nonce = crypto.randomBytes(8).toString('hex')
  const payload = `${uid}.${exp}.${nonce}`
  return `${payload}.${sign(payload)}`
}

function verifyToken(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [uid, expStr, nonce, sig] = parts
  const payload = `${uid}.${expStr}.${nonce}`
  const expect = sign(payload)
  // 常数时间比较防时序攻击
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  if (!Number.isFinite(+expStr) || Date.now() > +expStr) return null
  return uid
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254
}

function isValidPassword(s) {
  return typeof s === 'string' && s.length >= 8 && s.length <= 72
}

// ─────────────────── 简单限流：每 IP 每分钟 10 次（注册/登录） ───────────────────

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
    // 防内存膨胀：清掉过期桶
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k)
  }
  return b.count > 10
}

// ─────────────────── HTTP 基础 ───────────────────

function json(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('invalid json')) }
    })
    req.on('error', reject)
  })
}

function publicUser(u) {
  return { id: u.id, email: u.email, nickname: u.nickname || '', createdAt: u.createdAt }
}

// ─────────────────── 业务路由 ───────────────────

async function handleAuthRegister(req, res, body, ip) {
  if (rateLimited(ip)) return json(res, 429, { ok: false, error: '操作过于频繁，请一分钟后再试' })
  const email = String(body.email || '').trim().toLowerCase()
  const password = body.password
  const nickname = String(body.nickname || '').trim().slice(0, 32)
  if (!isValidEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })
  if (!isValidPassword(password)) return json(res, 400, { ok: false, error: '密码需要 8-72 位' })

  const db = loadUsers()
  if (db.users.some(u => u.email === email)) return json(res, 409, { ok: false, error: '该邮箱已注册' })

  const salt = crypto.randomBytes(16).toString('hex')
  const user = {
    id: crypto.randomUUID(),
    email,
    nickname,
    salt,
    passHash: hashPassword(password, salt),
    createdAt: new Date().toISOString()
  }
  db.users.push(user)
  saveUsers(db)
  json(res, 200, { ok: true, token: issueToken(user.id), user: publicUser(user) })
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
  json(res, 200, { ok: true, token: issueToken(user.id), user: publicUser(user) })
}

function handleAuthMe(req, res) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const uid = verifyToken(token)
  if (!uid) return json(res, 401, { ok: false, error: '登录已过期，请重新登录' })
  const db = loadUsers()
  const user = db.users.find(u => u.id === uid)
  if (!user) return json(res, 401, { ok: false, error: '账号不存在' })
  json(res, 200, { ok: true, user: publicUser(user) })
}

// ─────────────────── 服务器 ───────────────────

const LATEST = {
  version: '2.7.11',
  url: 'https://github.com/Mosina1102/MSMate/releases/latest',
  notes: '',
  publishedAt: '2026-09-08'
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url)
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

  // 基础 CORS（渲染进程直接 fetch 时兜底；主进程请求不受 CORS 限制）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

  try {
    if (req.method === 'GET' && pathname === '/ping') {
      return json(res, 200, { ok: true, service: 'msmate-api', version: '0.2.0', time: new Date().toISOString() })
    }
    if (req.method === 'GET' && pathname === '/v1/latest') {
      return json(res, 200, { ok: true, data: LATEST })
    }
    if (req.method === 'GET' && pathname === '/v1/myip') {
      return json(res, 200, { ok: true, ip: ip.replace(/^::ffff:/, '') })
    }
    if (req.method === 'POST' && pathname === '/v1/auth/register') {
      return await handleAuthRegister(req, res, await readBody(req), ip)
    }
    if (req.method === 'POST' && pathname === '/v1/auth/login') {
      return await handleAuthLogin(req, res, await readBody(req), ip)
    }
    if (req.method === 'GET' && pathname === '/v1/auth/me') {
      return handleAuthMe(req, res)
    }
    json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    const msg = e.message === 'invalid json' ? '请求格式错误' : e.message === 'body too large' ? '请求体过大' : '服务器内部错误'
    json(res, e.message === 'invalid json' || e.message === 'body too large' ? 400 : 500, { ok: false, error: msg })
  }
})

server.listen(PORT, () => {
  console.log(`msmate-api v0.2.0 listening on 0.0.0.0:${PORT}`)
})
