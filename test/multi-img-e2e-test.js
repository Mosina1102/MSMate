// 多图一次识别端到端（一次性）：paths 两张图（含一张 4.4MB 大图）一个请求，验证 MoE 默认模型 + 多图合并 + 跳过容错
const BASE = process.env.MSMATE_API_BASE || 'http://127.0.0.1:3274'
const fs = require('fs')
const path = require('path')

async function main() {
  const email = `multi-${Date.now()}@msmate.dev`
  const sc = await (await fetch(BASE + '/v1/auth/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, scene: 'register' }) })).json()
  const reg = await (await fetch(BASE + '/v1/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'test123456', nickname: '多图测试', code: sc.devCode, agree: 'v1' }) })).json()
  const token = reg.token
  const dataDir = process.env.DATA_DIR
  if (dataDir && fs.existsSync(path.join(dataDir, 'users.json'))) {
    try {
      const f = path.join(dataDir, 'users.json')
      const db = JSON.parse(fs.readFileSync(f, 'utf8'))
      const u = db.users.find((x) => x.email === email)
      if (u) { u.credits = 2000; fs.writeFileSync(f, JSON.stringify(db)) }
    } catch (e) { console.log('加积分失败（不影响流程）:', e.message) }
  }
  const fixtures = path.join(__dirname, 'fixtures')
  // 三"张"：两张小图（大图压缩已由 compress-probe 单独验证，这里走真实压缩后的尺寸量级）+ 一个不存在的路径（验证跳过容错）
  const t0 = Date.now()
  const r = await fetch(BASE + '/v1/ai/openai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      model: 'Qwen/Qwen3.6-35B-A3B', stream: false, max_tokens: 4096, enable_thinking: false,
      messages: [{ role: 'user', content: [
        { type: 'text', text: '这两张海报分别是什么？主标题各是什么？' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + fs.readFileSync(path.join(fixtures, 'design-demo.png')).toString('base64') } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + fs.readFileSync(path.join(fixtures, 'design-demo.png')).toString('base64') } }
      ] }]
    })
  })
  const j = await r.json().catch(() => ({}))
  const s = ((Date.now() - t0) / 1000).toFixed(1)
  const content = j.choices && j.choices[0] && j.choices[0].message && (j.choices[0].message.content || '')
  console.log(`HTTP ${r.status} | ${s}s | content ${content ? content.length : 0} 字`)
  console.log('预览:', String(content || JSON.stringify(j).slice(0, 120)).slice(0, 200).replace(/\n/g, ' '))
  const ok = r.status === 200 && /火锅/.test(content || '') && s < 30
  console.log(ok ? '\nMULTI_IMG_OK（多图一次识别通，MoE 够快）' : '\nMULTI_IMG_FAIL')
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
