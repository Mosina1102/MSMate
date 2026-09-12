// 识图模型速度对比（一次性）：Qwen3.8-27B（稠密）vs Qwen3.6-35B-A3B（MoE）
const BASE = process.env.MSMATE_API_BASE || 'http://127.0.0.1:3274'
const fs = require('fs')
const path = require('path')

async function main() {
  const email = `speed-${Date.now()}@msmate.dev`
  const sc = await (await fetch(BASE + '/v1/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, scene: 'register' }) })).json()
  const reg = await (await fetch(BASE + '/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test123456', nickname: '测速', code: sc.devCode, agree: 'v1' }) })).json()
  const token = reg.token
  // 加积分
  const dataDir = process.env.DATA_DIR
  if (dataDir) {
    const f = path.join(dataDir, 'users.json')
    const db = JSON.parse(fs.readFileSync(f, 'utf8'))
    const u = db.users.find((x) => x.email === email)
    if (u) { u.credits = 1000; fs.writeFileSync(f, JSON.stringify(db)) }
  }
  const img = fs.readFileSync(path.join(__dirname, 'fixtures', 'design-demo.png')).toString('base64')
  for (const model of ['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B']) {
    const t0 = Date.now()
    const r = await fetch(BASE + '/v1/ai/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        model, stream: false, max_tokens: 2048, enable_thinking: false,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '一句话说明这张海报的主题和主标题' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + img } }
        ] }]
      })
    })
    const j = await r.json().catch(() => ({}))
    const s = ((Date.now() - t0) / 1000).toFixed(1)
    const content = j.choices && j.choices[0] && j.choices[0].message && (j.choices[0].message.content || '')
    console.log(`${model}: ${s}s HTTP${r.status} | ${(content || JSON.stringify(j).slice(0, 100)).slice(0, 60).replace(/\n/g, ' ')}`)
  }
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
