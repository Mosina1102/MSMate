// 大图 413 验证（一次性）：>2MB 请求体应返回 413 明确错误（不再误导为"非 JSON"）
const BASE = process.env.MSMATE_API_BASE || 'http://127.0.0.1:3274'
const fs = require('fs')
const path = require('path')

async function main() {
  const email = `big-img-${Date.now()}@msmate.dev`
  const sc = await (await fetch(BASE + '/v1/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, scene: 'register' }) })).json()
  const reg = await (await fetch(BASE + '/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test123456', nickname: '大图测试', code: sc.devCode, agree: 'v1' }) })).json()
  const img = fs.readFileSync(path.join(__dirname, 'fixtures', 'design-demo-huge.png')).toString('base64')
  const r = await fetch(BASE + '/v1/ai/openai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token },
    body: JSON.stringify({ model: 'Qwen/Qwen3.8-27B', messages: [{ role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + img } }] }] })
  })
  const j = await r.json().catch(() => ({}))
  console.log(`HTTP ${r.status} | ${j.error || ''}`)
  console.log(r.status === 413 && /2MB/.test(j.error || '') ? 'BIGIMG_413_OK' : 'BIGIMG_413_FAIL')
  process.exit(r.status === 413 ? 0 : 1)
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
