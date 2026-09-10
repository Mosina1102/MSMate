// v0.6 AI 自动审核自测：mock 硅基流动上游（OCR 文本可控），验证提凭证→OCR 提取→规则核验→自动批/转人工全链路
// 用法：node test/api-v06-autoreview-test.js（自动起 mock 上游 + 本地服务，零外部依赖零成本）
const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MOCK_PORT = 3219
const API_PORT = 3220
const DATA_DIR = path.join(os.tmpdir(), 'msmate-v06-test-' + Date.now())
const ADMIN_PASS = 'test-admin-123'

// mock OCR 返回文本（用例间切换）
let OCR_TEXT = ''

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 200) : ''}`) }
}

async function jreq(port, pathname, { method = 'GET', body = null, token = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(`http://127.0.0.1:${port}` + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let j = null
  try { j = await r.json() } catch { }
  return { code: r.status, j }
}

const SHOT_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function registerAndOrder(amount) {
  const email = `ar-${Date.now()}-${Math.floor(Math.random() * 1e6)}@msmate.dev`
  const sc = await jreq(API_PORT, '/v1/auth/send-code', { method: 'POST', body: { email, scene: 'register' } })
  const reg = await jreq(API_PORT, '/v1/auth/register', { method: 'POST', body: { email, password: 'test-pass-123', nickname: 'AR测试', code: sc.j.devCode, agree: 'v1' } })
  const token = reg.j && reg.j.token
  const od = await jreq(API_PORT, '/v1/credits/orders', { method: 'POST', token, body: { amount } })
  return { token, orderId: od.j && od.j.order && od.j.order.id }
}

function main() {
  // 1. mock 上游：OCR 文本可控
  const mock = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: OCR_TEXT } }] }))
    })
  })

  mock.listen(MOCK_PORT, async () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'api-server', 'server.js')], {
      env: { ...process.env, PORT: String(API_PORT), DATA_DIR, SF_BASE: `http://127.0.0.1:${MOCK_PORT}`, SF_API_KEY: 'mock-key', ADMIN_PASS },
      stdio: 'ignore'
    })

    try {
      let ready = false
      for (let i = 0; i < 40 && !ready; i++) {
        await new Promise(r => setTimeout(r, 250))
        try { const p = await jreq(API_PORT, '/ping'); ready = p.code === 200 } catch { }
      }
      check('本地服务就绪', ready)

      // 后台登录拿 admin token
      const lg = await jreq(API_PORT, '/admin/api/login', { method: 'POST', body: { key: ADMIN_PASS } })
      const adm = lg.j && lg.j.token
      check('后台登录拿 admin token', !!adm, lg.j)

      // ① 自动审核配置：默认关 → 开启（收款方"莫西"）→ 回读
      const g0 = await jreq(API_PORT, '/admin/api/autoreview', { token: adm })
      check('autoreview GET 默认关', g0.j && g0.j.config && g0.j.config.enabled === false, g0.j)
      const sp = await jreq(API_PORT, '/admin/api/autoreview', { method: 'POST', token: adm, body: { enabled: true, payee: '莫西', maxAuto: 68 } })
      check('autoreview POST 保存', sp.j && sp.j.config && sp.j.config.enabled === true && sp.j.config.payee === '莫西', sp.j)
      const un = await jreq(API_PORT, '/admin/api/autoreview', { token: 'bad-token' })
      check('autoreview 坏 token 401', un.code === 401, un.code)

      // ② 全过 → 自动批款（status done + aiReview auto + 积分到账）
      OCR_TEXT = '微信转账 收款方：莫西 金额：￥30.00 转账单号：1000000000 时间 2026-09-10 12:00'
      const t1 = await registerAndOrder(30)
      const v1 = await jreq(API_PORT, `/v1/credits/orders/${t1.orderId}/voucher`, { method: 'POST', token: t1.token, body: { voucher: '1000000000', screenshot: 'data:image/png;base64,' + SHOT_B64 } })
      check('用例1 提交成功', v1.j && v1.j.ok, v1.j)
      check('用例1 AI 自动批（auto:true）', v1.j && v1.j.auto === true, v1.j)
      check('用例1 订单 done + aiReview auto', v1.j && v1.j.order && v1.j.order.status === 'done' && v1.j.order.aiReview && v1.j.order.aiReview.verdict === 'auto', v1.j && v1.j.order)
      const bal1 = await jreq(API_PORT, '/v1/credits/balance', { token: t1.token })
      check('用例1 积分自动到账 3000', bal1.j && bal1.j.credits === 3000, bal1.j)
      check('用例1 截图落盘', fs.existsSync(path.join(DATA_DIR, 'screenshots', t1.orderId + '.png')))

      // ③ 金额不符 → 转人工（疑点含"金额"）
      OCR_TEXT = '微信转账 收款方：莫西 金额：￥3.00'
      const t2 = await registerAndOrder(30)
      const v2 = await jreq(API_PORT, `/v1/credits/orders/${t2.orderId}/voucher`, { method: 'POST', token: t2.token, body: { voucher: '2000000000', screenshot: 'data:image/png;base64,' + SHOT_B64 } })
      check('用例2 存疑转人工', v2.j && v2.j.ok && !v2.j.auto && v2.j.order.status === 'reviewing', v2.j && v2.j.order)
      check('用例2 疑点含"金额"', JSON.stringify(v2.j.order.aiReview.reasons).includes('金额'), v2.j && v2.j.order.aiReview)

      // ④ 收款方不符 → 转人工（疑点含"收款方"）
      OCR_TEXT = '微信转账 收款方：路人甲 金额：￥6.00'
      const t3 = await registerAndOrder(6)
      const v3 = await jreq(API_PORT, `/v1/credits/orders/${t3.orderId}/voucher`, { method: 'POST', token: t3.token, body: { voucher: '3000000000', screenshot: 'data:image/png;base64,' + SHOT_B64 } })
      check('用例3 疑点含"收款方"', JSON.stringify(v3.j.order.aiReview.reasons).includes('收款方'), v3.j && v3.j.order.aiReview)

      // ⑤ 超上限（128 > 68）→ 转人工（疑点含"上限"）
      OCR_TEXT = '微信转账 收款方：莫西 金额：￥128.00'
      const t4 = await registerAndOrder(128)
      const v4 = await jreq(API_PORT, `/v1/credits/orders/${t4.orderId}/voucher`, { method: 'POST', token: t4.token, body: { voucher: '4000000000', screenshot: 'data:image/png;base64,' + SHOT_B64 } })
      check('用例4 超上限转人工', (v4.j.order.aiReview.reasons || []).some(r => r.includes('上限')), v4.j && v4.j.order.aiReview)

      // ⑥ 无截图 → 转人工（疑点含"截图"）
      const t5 = await registerAndOrder(3)
      const v5 = await jreq(API_PORT, `/v1/credits/orders/${t5.orderId}/voucher`, { method: 'POST', token: t5.token, body: { voucher: '5000000000' } })
      check('用例5 无截图转人工', (v5.j.order.aiReview.reasons || []).some(r => r.includes('截图')), v5.j && v5.j.order.aiReview)

      // ⑦ 截图查看接口：坏 token 401 / 好 token 200 / 未知文件 404
      const s1 = await fetch(`http://127.0.0.1:${API_PORT}/screenshots/${t1.orderId}.png?t=bad`)
      check('截图接口坏 token 401', s1.status === 401, s1.status)
      const s2 = await fetch(`http://127.0.0.1:${API_PORT}/screenshots/${t1.orderId}.png?t=${encodeURIComponent(adm)}`)
      check('截图接口好 token 200 + png', s2.status === 200 && s2.headers.get('content-type') === 'image/png', { s: s2.status, c: s2.headers.get('content-type') })
      const s3 = await fetch(`http://127.0.0.1:${API_PORT}/screenshots/NOPE.png?t=${encodeURIComponent(adm)}`)
      check('截图接口未知文件 404', s3.status === 404, s3.status)
      const s4 = await fetch(`http://127.0.0.1:${API_PORT}/screenshots/..%2Fusers.json?t=${encodeURIComponent(adm)}`)
      check('截图接口路径穿越被白名单拦', s4.status === 404, s4.status)

      console.log(`\n结果: pass=${pass} fail=${fail}`)
    } catch (e) {
      console.error('测试异常:', e.message)
      fail++
    } finally {
      try { child.kill() } catch { }
      try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch { }
      process.exit(fail ? 1 : 0)
    }
  })
}
main()
