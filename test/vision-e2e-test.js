// 识图端到端测试（一次性）：真图 + Qwen3.8-27B + 不传 stream（模拟老客户端）
// 前置：服务起在 MSMATE_API_BASE（默认 127.0.0.1:3273），DATA_DIR 环境变量与服务的同目录才能加积分
const BASE = process.env.MSMATE_API_BASE || 'http://127.0.0.1:3273'
const fs = require('fs')
const path = require('path')

async function jreq(pathname, { method = 'GET', body = null, token = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = 'Bearer ' + token
  const r = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let j = null
  try { j = await r.json() } catch {}
  return { code: r.status, j }
}

async function main() {
  // ① 注册/登录拿 token
  const email = `vision-e2e-${Date.now()}@msmate.dev`
  const sc = await jreq('/v1/auth/send-code', { method: 'POST', body: { email, scene: 'register' } })
  const code = sc.j && sc.j.devCode
  if (!code) { console.log('E2E_FAIL: 拿不到 devCode', JSON.stringify(sc).slice(0, 200)); process.exit(1) }
  const reg = await jreq('/v1/auth/register', { method: 'POST', body: { email, password: 'test123456', nickname: '识图测试', code, agree: 'v1' } })
  const token = reg.j && reg.j.token
  if (!token) { console.log('E2E_FAIL: 注册失败', JSON.stringify(reg.j).slice(0, 200)); process.exit(1) }

  // ② 加积分（直接改临时数据目录 users.json）
  const dataDir = process.env.DATA_DIR
  if (dataDir) {
    const f = path.join(dataDir, 'users.json')
    const db = JSON.parse(fs.readFileSync(f, 'utf8'))
    const u = db.users.find((x) => x.email === email)
    if (u) { u.credits = 1000; fs.writeFileSync(f, JSON.stringify(db)); console.log('积分已加到 1000') }
  }

  // ③ 识图：真图 + Qwen3.8-27B + 不传 stream（老客户端姿态）
  const img = fs.readFileSync(path.join(__dirname, 'fixtures', 'design-demo.png')).toString('base64')
  const t0 = Date.now()
  const vis = await jreq('/v1/ai/openai/chat/completions', {
    method: 'POST', token,
    body: {
      model: 'Qwen/Qwen3.8-27B',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '一句话说明这张图是什么海报、主标题是什么' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + img } }
      ] }],
      max_tokens: 2048
    }
  })
  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  const msg = vis.j && vis.j.choices && vis.j.choices[0] && vis.j.choices[0].message
  const content = msg && (msg.content || msg.reasoning_content || '')
  console.log(`HTTP ${vis.code} | ${dt}s | content 长度: ${content ? content.length : 0}`)
  console.log('内容预览:', String(content || JSON.stringify(vis.j)).slice(0, 150).replace(/\n/g, ' '))
  const okVision = vis.code === 200 && content && content.length > 10
  console.log(okVision ? '\nVISION_E2E_OK（非流式识图通）' : '\nVISION_E2E_FAIL')

  // ④ 流式回归：显式 stream:true 应该还是 SSE（主对话路径没坏）
  const r = await fetch(BASE + '/v1/ai/openai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ model: 'Qwen/Qwen3.6-35B-A3B', messages: [{ role: 'user', content: '只回答两个字：好的' }], max_tokens: 100, stream: true })
  })
  const text = await r.text()
  const isSSE = r.status === 200 && text.includes('data:') && text.includes('[DONE]')
  console.log(isSSE ? 'STREAM_REGRESSION_OK（流式仍正常）' : `STREAM_REGRESSION_FAIL: HTTP ${r.status} ${text.slice(0, 120)}`)
  process.exit(okVision && isSSE ? 0 : 1)
}

main().catch((e) => { console.error('E2E_ERR', e.message); process.exit(1) })
