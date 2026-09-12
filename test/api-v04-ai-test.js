// msmate-api v0.4 AI 代理接口自测：真实调用硅基流动（低成本控制）
// 用法：SF_API_KEY=sk-xxx node test/api-v04-ai-test.js
const BASE = process.env.MSMATE_API_BASE || 'http://127.0.0.1:3215'
const DATA_DIR = process.env.DATA_DIR || '' // 同机直改测试数据目录，给测试账号加积分
const fs = require('fs')

function grantCredits(email, n) {
  if (!DATA_DIR) return false
  try {
    const f = DATA_DIR + '/users.json'
    const db = JSON.parse(fs.readFileSync(f, 'utf8'))
    const u = db.users.find(x => x.email === email)
    if (!u) return false
    u.credits = n
    fs.writeFileSync(f, JSON.stringify(db))
    return true
  } catch { return false }
}

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 200) : ''}`) }
}

async function jreq(pathname, { method = 'GET', body = null, token = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let j = null
  try { j = await r.json() } catch { }
  return { code: r.status, j }
}

async function main() {
  console.log(`── msmate-api v0.4 AI 代理自测（${BASE}）──`)

  // 0. 基础
  const pingRes = await jreq('/ping')
  check('ping 版本 0.7.0', pingRes.code === 200 && pingRes.j.version === '0.7.0', pingRes.j)

  // 1. 模型清单（公开）
  const models = await jreq('/v1/ai/models')
  check('模型清单 6 对话(含 2 个 visionOnly) + 2 生图 + TTS + ASR',
    models.code === 200 && models.j.chat.length === 6 && models.j.chat.filter(c => c.visionOnly).length === 2 && models.j.image.length === 2 && models.j.tts.id && models.j.asr.id, models.j)
  check('识图模型：Qwen3.6-35B-A3B 带视觉标记（MoE 秒级默认）+ Qwen3.8-27B 高清备选',
    models.j.chat.some(c => c.id === 'Qwen/Qwen3.6-35B-A3B' && c.vision && c.creditsPerMTokIn === 270 && c.creditsPerMTokOut === 1620)
    && models.j.chat.some(c => c.id === 'Qwen/Qwen3.8-27B' && c.vision && c.visionOnly), models.j.chat)

  // 2. 未登录 401
  const noAuth = await jreq('/v1/ai/openai/chat/completions', { method: 'POST', body: { model: 'x' } })
  check('未登录 401', noAuth.code === 401, noAuth)

  // 3. 注册拿 token（DEV 模式 send-code 响应带 devCode）
  const email = `ai-test-${Date.now()}@msmate.dev`
  const sc = await jreq('/v1/auth/send-code', { method: 'POST', body: { email, scene: 'register' } })
  const devCode = (sc.j && sc.j.devCode) || ''
  // 未同意用户协议 → 400（不消耗验证码）
  const noAgree = await jreq('/v1/auth/register', { method: 'POST', body: { email, password: 'test-pass-123', nickname: 'AI测试', code: devCode } })
  check('未同意协议 400', noAgree.code === 400 && /用户协议/.test(noAgree.j.error || ''), noAgree.j)
  const reg = await jreq('/v1/auth/register', { method: 'POST', body: { email, password: 'test-pass-123', nickname: 'AI测试', code: devCode, agree: 'v1' } })
  const token = reg.j && reg.j.token
  check('注册成功拿 token', !!token, reg.j)
  if (!token) return console.log(`pass=${pass} fail=${fail}`)

  // 4. 余额 0 → 402 拒绝
  const broke = await jreq('/v1/ai/openai/chat/completions', { method: 'POST', token, body: { model: 'Qwen/Qwen3.6-35B-A3B', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, stream: false } })
  check('零余额 402 拒绝', broke.code === 402 && broke.j.code === 'INSUFFICIENT_CREDITS', broke)

  // 4.5 给测试账号加 500 积分（直改数据目录）
  check('测试账号加积分', grantCredits(email, 500))

  // 5. 真实对话（非流式，最便宜模型）
  const bal = await jreq('/v1/credits/balance', { token })
  console.log(`  ℹ 当前余额 ${bal.j.credits}`)
  if ((bal.j.credits || 0) > 0) {
    const chat = await jreq('/v1/ai/openai/chat/completions', {
      method: 'POST', token,
      body: { model: 'Qwen/Qwen3.6-35B-A3B', messages: [{ role: 'user', content: '只回答两个字：你好' }], max_tokens: 500, stream: false }
    })
    check('非流式对话成功', chat.code === 200 && chat.j.choices && chat.j.choices[0].message.content, chat.j)
    check('响应附 _msmate 扣费', chat.code === 200 && chat.j && chat.j._msmate && chat.j._msmate.credits >= 1 && typeof chat.j._msmate.balance === 'number', chat.j && chat.j._msmate)
    check('余额已扣减', chat.code === 200 && chat.j && chat.j._msmate && chat.j._msmate.balance < bal.j.credits, chat.j && chat.j._msmate)

    // 6. 流式对话（SSE）
    const sse = await fetch(BASE + '/v1/ai/openai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'Qwen/Qwen3.6-35B-A3B', messages: [{ role: 'user', content: '只回答两个字：好的' }], max_tokens: 500, stream: true })
    })
    const text = await sse.text()
    const hasDelta = text.includes('"delta"') || text.includes('[DONE]')
    check('流式 SSE 200 且有 delta/DONE', sse.status === 200 && hasDelta, sse.status)
    // v0.5：扣费回执帧必须在 [DONE] 之前（客户端标准收流才能读到）
    const doneIdx = text.indexOf('[DONE]')
    const receiptIdx = text.indexOf('_msmate')
    check('流式回执帧在 [DONE] 之前', receiptIdx > -1 && doneIdx > -1 && receiptIdx < doneIdx, { receiptIdx, doneIdx })
    const bal2 = await jreq('/v1/credits/balance', { token })
    check('流式后余额继续扣减', chat.code === 200 && chat.j && chat.j._msmate && bal2.j.credits < chat.j._msmate.balance, bal2.j)

    // 7. 未在清单模型 400
    const bad = await jreq('/v1/ai/openai/chat/completions', { method: 'POST', token, body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } })
    check('清单外模型 400', bad.code === 400, bad)

    // 8. TTS（按字节扣费，短文本控制成本）
    const tts = await fetch(BASE + '/v1/ai/openai/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'FunAudioLLM/CosyVoice2-0.5B', text: '你好', voice: 'FunAudioLLM/CosyVoice2-0.5B:alex' })
    })
    const buf = await tts.arrayBuffer()
    check('TTS 返回音频', tts.status === 200 && buf.byteLength > 500, { status: tts.status, len: buf.byteLength })
    const bal3 = await jreq('/v1/credits/balance', { token })
    check('TTS 后余额扣减', bal3.j.credits < bal2.j.credits, bal3.j)

    // 9. 生图（Z-Image-Turbo 6 积分/张）
    const img = await jreq('/v1/ai/openai/images/generations', {
      method: 'POST', token,
      body: { model: 'Tongyi-MAI/Z-Image-Turbo', prompt: 'a cute cat', size: '512x512' }
    })
    check('生图成功返回 URL', img.code === 200 && img.j.data && img.j.data[0].url, { code: img.code, keys: img.j && Object.keys(img.j) })
    check('生图附扣费', img.j._msmate && img.j._msmate.credits === 45, img.j._msmate)
  } else {
    console.log('  ⚠ 跳过真实调用（余额为 0，需服务端手动加积分）')
  }

  // 10. 设备在线登记（互联网 P2P 发现）
  const devId = 'test-dev-' + Date.now().toString(36)
  const ping = await jreq('/v1/presence', { method: 'POST', token, body: { deviceId: devId, name: '测试设备', platform: 'win32' } })
  check('presence 心跳上报', ping.code === 200 && ping.j.ok, ping.j)
  const plist = await jreq('/v1/presence', { token })
  const found = plist.j && plist.j.devices ? plist.j.devices.find(d => d.deviceId === devId) : null
  check('presence 列表含设备且带公网 IP', !!found && !!found.ip, found)
  const notAuth = await jreq('/v1/presence', { method: 'POST', body: { deviceId: devId } })
  check('presence 未登录 401', notAuth.code === 401, notAuth)

  // 11. 订单取消
  const ord = await jreq('/v1/credits/orders', { method: 'POST', body: { amount: 1 } })
  // 上面未带 token 是探测未登录；带 token 重新下单
  const ord2 = await jreq('/v1/credits/orders', { method: 'POST', token, body: { amount: 1 } })
  check('创建充值订单', ord2.code === 200 && ord2.j.order && ord2.j.order.id, ord2.j)
  check('未登录下单 401', ord.code === 401, ord.code)
  if (ord2.j.order && ord2.j.order.id) {
    const oid = ord2.j.order.id
    const c1 = await jreq(`/v1/credits/orders/${oid}/cancel`, { method: 'POST', token })
    check('取消待支付订单', c1.code === 200 && c1.j.order.status === 'cancelled', c1.j)
    const c2 = await jreq(`/v1/credits/orders/${oid}/cancel`, { method: 'POST', token })
    check('重复取消被拒 400', c2.code === 400, c2.code)
  }

  // 12. 防刷单：pending 占位唯一 + 凭证号全局唯一
  const o3 = await jreq('/v1/credits/orders', { method: 'POST', token, body: { amount: 1 } })
  check('防刷-创建订单', o3.code === 200 && o3.j.order && o3.j.order.id, o3.j)
  const o4 = await jreq('/v1/credits/orders', { method: 'POST', token, body: { amount: 1 } })
  check('防刷-pending 占位唯一（第二单被拒 429）', o4.code === 429, o4.j)
  if (o3.j.order && o3.j.order.id) {
    const v1 = await jreq(`/v1/credits/orders/${o3.j.order.id}/voucher`, { method: 'POST', token, body: { voucher: 'TESTVOUCH123' } })
    check('防刷-提交凭证', v1.code === 200, v1.j)
    const c3 = await jreq(`/v1/credits/orders/${o3.j.order.id}/cancel`, { method: 'POST', token })
    check('防刷-取消审核中订单', c3.code === 200, c3.j)
    const o5 = await jreq('/v1/credits/orders', { method: 'POST', token, body: { amount: 1 } })
    check('防刷-取消后可再下单', o5.code === 200 && o5.j.order && o5.j.order.id, o5.j)
    if (o5.j.order && o5.j.order.id) {
      const v2 = await jreq(`/v1/credits/orders/${o5.j.order.id}/voucher`, { method: 'POST', token, body: { voucher: 'TESTVOUCH123' } })
      check('防刷-凭证号全局唯一（重复被拒 409）', v2.code === 409, v2.j)
    }
  }

  // 13. 每日签到（+50/天，累计封顶 200）
  const s1 = await jreq('/v1/credits/signin', { method: 'POST', token })
  check('签到成功 +50', s1.code === 200 && s1.j.ok && s1.j.awarded === 50 && s1.j.total === 50, s1.j)
  const balAfterSign = await jreq('/v1/credits/balance', { token })
  check('签到后余额入账', balAfterSign.code === 200 && balAfterSign.j.credits === s1.j.credits, balAfterSign.j)
  const s2 = await jreq('/v1/credits/signin', { method: 'POST', token })
  check('当日重复签到被拒', s2.code === 200 && !s2.j.ok && /已签到/.test(s2.j.error || ''), s2.j)
  const noSign = await jreq('/v1/credits/signin', { method: 'POST' })
  check('未登录签到 401', noSign.code === 401, noSign.code)

  console.log(`\n结果: pass=${pass} fail=${fail}`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('测试异常:', e.message); process.exit(1) })
