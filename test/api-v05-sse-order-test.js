// v0.5 SSE 扣费回执帧顺序自测：模拟硅基流动上游，验证 _msmate 帧走在 [DONE] 之前
// 用法：node test/api-v05-sse-order-test.js（自动起 mock 上游 + 本地服务，零外部依赖零成本）
const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MOCK_PORT = 3217
const API_PORT = 3218
const DATA_DIR = path.join(os.tmpdir(), 'msmate-v05-test-' + Date.now())

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

function main() {
  // 1. 模拟上游：SSE 流（delta ×2 → usage 帧 → [DONE]），支持非流式 JSON
  const mock = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      const body = (() => { try { return JSON.parse(raw || '{}') } catch { return {} } })()
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n')
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
        res.write('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":50}}}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: '你好' } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } }))
      }
    })
  })

  mock.listen(MOCK_PORT, async () => {
    // 2. 起本地 msmate-api（SF_BASE 指向 mock）
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'api-server', 'server.js')], {
      env: { ...process.env, PORT: String(API_PORT), DATA_DIR, SF_BASE: `http://127.0.0.1:${MOCK_PORT}`, SF_API_KEY: 'mock-key' },
      stdio: 'ignore'
    })

    try {
      // 等 /ping 就绪
      let ready = false
      for (let i = 0; i < 40 && !ready; i++) {
        await new Promise(r => setTimeout(r, 250))
        try { const p = await jreq(API_PORT, '/ping'); ready = p.code === 200 } catch { }
      }
      check('本地服务就绪', ready)

      // 注册拿 token
      const email = `sse-${Date.now()}@msmate.dev`
      const sc = await jreq(API_PORT, '/v1/auth/send-code', { method: 'POST', body: { email, scene: 'register' } })
      const reg = await jreq(API_PORT, '/v1/auth/register', { method: 'POST', body: { email, password: 'test-pass-123', nickname: 'SSE测试', code: sc.j.devCode, agree: 'v1' } })
      const token = reg.j && reg.j.token
      check('注册拿 token', !!token, reg.j)

      // 直改 users.json 加 500 积分
      const uf = path.join(DATA_DIR, 'users.json')
      const db = JSON.parse(fs.readFileSync(uf, 'utf8'))
      db.users.find(u => u.email === email).credits = 500
      fs.writeFileSync(uf, JSON.stringify(db))

      // 3. 非流式：_msmate 结算帧
      const ns = await jreq(API_PORT, '/v1/ai/openai/chat/completions', {
        method: 'POST', token,
        body: { model: 'Qwen/Qwen3.6-35B-A3B', messages: [{ role: 'user', content: 'hi' }], stream: false }
      })
      check('非流式 200', ns.code === 200, ns.code)
      check('非流式 _msmate 结算（缓存计价）', ns.j._msmate && ns.j._msmate.credits >= 1, ns.j && ns.j._msmate)
      // 成本 = (100-50)×1.8 + 50×1.8 + 20×10.8 = 90+90+216=396元/M → wait: 全按无缓存算= (50×1.8+50×1.8+20×10.8)/1e6 元
      // 具体值：((100-50)*1.8 + 50*1.8 + 20*10.8)/1e6 元 = (90+90+216)/1e6 = 0.000396 元 ×150 = 0.0594 → ceil=1 积分
      check('Qwen3.6 定价结算', ns.j._msmate && ns.j._msmate.credits === 1, ns.j && ns.j._msmate)

      // 4. 流式：_msmate 帧必须在 [DONE] 之前
      const r = await fetch(`http://127.0.0.1:${API_PORT}/v1/ai/openai/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'Qwen/Qwen3.6-35B-A3B', messages: [{ role: 'user', content: 'hi' }], stream: true })
      })
      const text = await r.text()
      check('流式 200', r.status === 200, r.status)
      const doneIdx = text.indexOf('[DONE]')
      const receiptIdx = text.indexOf('_msmate')
      check('回执帧存在于流中', receiptIdx > -1, text.slice(-300))
      check('回执帧在 [DONE] 之前（核心修复）', doneIdx > -1 && receiptIdx > -1 && receiptIdx < doneIdx, { doneIdx, receiptIdx })
      const m = text.match(/_msmate":\{"credits":(\d+),"balance":(\d+)/)
      // 非流式那发已扣 1 积分（500→499），本发流式再扣 1 → 498
      check('回执帧含积分与余额', !!m && +m[1] >= 1 && +m[2] === 498, m && m.slice(0))
      check('usage 帧被透传（含缓存明细）', text.includes('cached_tokens'), null)

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
