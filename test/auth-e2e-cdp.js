// 账号链路 CDP 端到端测试 v3：顶栏入口 + 品牌 UI + 眼睛 + 昵称编辑 + 积分徽标
//         + v0.3 新增：注册验证码流程 + 积分充值面板（档位/收款码/凭证/订单）+ 未登录守卫
// 前置：本地 api-server v0.3（DEV 模式，隔离 DATA_DIR）跑在 3210
//       应用以 --remote-debugging-port=9333 + MSC_USER_DATA 隔离 + MSMATE_API_BASE=http://127.0.0.1:3210 启动
const http = require('http')
const fs = require('fs')

const API_BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:3210'

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body || {}))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const targets = await getJson('http://127.0.0.1:9333/json')
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url))
  if (!page) { console.error('❌ 找到应用页面目标失败:', targets.map(t => t.url)); process.exit(1) }
  console.log('✅ 连接目标:', page.url.slice(0, 60))

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let mid = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++mid
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evalJs(expr, awaitPromise = false) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || 'exception' }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  await sleep(1500) // 等 app init 完成

  let pass = 0, fail = 0
  const ok = (cond, name) => { if (cond) { pass++; console.log('  ✅ ' + name) } else { fail++; console.log('  ❌ ' + name) } }

  // 1. 未登录初始态
  ok(await evalJs(`!!window.api && typeof window.api.authUpdateProfile === 'function'`), 'preload 暴露 authUpdateProfile')
  ok(await evalJs(`!!window.api && typeof window.api.creditsOrderCreate === 'function'`), 'preload 暴露 creditsOrderCreate（充值桥）')
  ok(await evalJs(`document.querySelector('#accountBtnInner .ic-svg') !== null`), '顶栏头像未登录显示人形图标（SVG 正常渲染）')
  ok(await evalJs(`document.getElementById('creditBadge').classList.contains('hidden')`), '未登录积分徽标隐藏')
  ok(await evalJs(`document.getElementById('accountName').textContent`) === '未登录', '侧栏账号行显示未登录')

  // 2. 顶栏入口打开弹窗（品牌 UI）
  await evalJs(`document.getElementById('accountBtn').click()`)
  await sleep(300)
  ok(await evalJs(`!document.getElementById('accountModal').classList.contains('hidden')`), '点击顶栏头像打开弹窗')
  ok(await evalJs(`document.getElementById('authBrandTitle').textContent`) === '欢迎回来', '品牌头默认「欢迎回来」')
  ok(await evalJs(`document.querySelector('.auth-brand-logo') !== null`), '品牌 logo 就位')

  // 3. 密码眼睛切换
  await evalJs(`
    document.querySelector('.auth-tab[data-authtab="register"]').click();
    document.getElementById('authEmail').value = 'cdp3-e2e@msmate.dev';
    document.getElementById('authNickname').value = '顶栏联调喵';
    document.getElementById('authPassword').value = 'cdp3-test-12345';
  `)
  await evalJs(`document.getElementById('authEye').click()`)
  ok(await evalJs(`document.getElementById('authPassword').type`) === 'text', '点眼睛 → 密码明文')
  ok(await evalJs(`document.querySelector('#authEye .ic-svg') !== null`), '眼睛图标切换后仍为 SVG（无乱码）')
  await evalJs(`document.getElementById('authEye').click()`)
  ok(await evalJs(`document.getElementById('authPassword').type`) === 'password', '再点 → 密码密文')

  // 4. 品牌头注册态文案
  ok(await evalJs(`document.getElementById('authBrandTitle').textContent`) === '创建账号', '切注册后品牌头变「创建账号」')

  // 5. 注册（v0.3 需邮箱验证码：脚本直取 devCode → 先错码被拒 → 正码注册）
  const email = `cdp3-${Date.now()}@msmate.dev`
  const sc = await postJson(API_BASE + '/v1/auth/send-code', { email, scene: 'register' })
  ok(sc && sc.ok && /^\d{6}$/.test(sc.devCode || ''), `服务端 dev 模式下发验证码（${sc && sc.devCode ? '6 位' : '失败'}）`)
  await evalJs(`
    document.querySelector('.auth-tab[data-authtab="register"]').click();
    document.getElementById('authEmail').value = ${JSON.stringify(email)};
    document.getElementById('authNickname').value = '顶栏联调喵';
    document.getElementById('authPassword').value = 'cdp3-test-12345';
    document.getElementById('authCode').value = '000000';
  `)
  await evalJs(`document.getElementById('authSubmit').click()`)
  await sleep(1500)
  ok(/验证码错误或已过期/.test(await evalJs(`document.getElementById('authError').textContent`) || ''), '错误验证码被拒（服务端文案）')
  await evalJs(`document.getElementById('authCode').value = ${JSON.stringify((sc && sc.devCode) || '')}`)
  await evalJs(`document.getElementById('authSubmit').click()`)
  await sleep(1800)
  ok(await evalJs(`document.getElementById('accountModal').classList.contains('hidden')`), '验证码注册成功自动关弹窗')
  ok(await evalJs(`document.getElementById('accountBtnInner').textContent`) === '顶', '顶栏头像变昵称首字')
  ok(await evalJs(`!document.getElementById('creditBadge').classList.contains('hidden')`), '积分徽标登录后显示')
  ok(await evalJs(`document.getElementById('creditValue').textContent`) === '0', '积分占位 0')
  ok(await evalJs(`document.getElementById('accountName').textContent`) === '顶栏联调喵', '侧栏账号行同步昵称')

  // 6. 资料卡：编辑昵称（顶栏/侧栏/资料卡三处同步）
  await evalJs(`document.getElementById('accountBtn').click()`)
  await sleep(300)
  ok(await evalJs(`!document.getElementById('authLogout').classList.contains('hidden')`), '资料卡显示退出按钮')
  ok(await evalJs(`document.getElementById('authCreditVal').textContent`) === '0', '资料卡积分行占位 0')
  await evalJs(`document.getElementById('authEditNick').click()`)
  await sleep(200)
  ok(await evalJs(`!document.getElementById('authNickEdit').classList.contains('hidden')`), '进入昵称编辑态')
  await evalJs(`
    document.getElementById('authNickInput').value = '改名后的喵';
    document.getElementById('authNickSave').click();
  `)
  await sleep(1500)
  ok(await evalJs(`document.getElementById('authProfileName').textContent`) === '改名后的喵', '资料卡昵称已更新')
  ok(await evalJs(`document.getElementById('accountBtnInner').textContent`) === '改', '顶栏头像同步新昵称')
  ok(await evalJs(`document.getElementById('accountName').textContent`) === '改名后的喵', '侧栏账号行同步新昵称')
  await evalJs(`document.getElementById('authCloseX').click()`)
  await sleep(200)

  // 7. 积分充值面板（收款码 + 档位 + 凭证 + 订单）
  await evalJs(`document.getElementById('creditBadge').click()`)
  await sleep(800)
  ok(await evalJs(`!document.getElementById('creditsModal').classList.contains('hidden')`), '点积分徽标打开充值面板')
  ok(await evalJs(`document.querySelectorAll('#creditsGrid .credits-tier').length`) === 6, '六个充值档位就位')
  ok(await evalJs(`document.getElementById('creditsNextBtn').disabled`) === true, '未选档下一步禁用')
  await evalJs(`document.querySelector('.credits-tier[data-amount="3"]').click()`)
  await sleep(150)
  ok(await evalJs(`document.querySelector('.credits-tier[data-amount="3"]').classList.contains('active')`), '点 ¥3 档位高亮')
  ok(await evalJs(`!document.getElementById('creditsNextBtn').disabled`), '选档后下一步可点')
  await evalJs(`document.getElementById('creditsNextBtn').click()`)
  await sleep(1200)
  ok(await evalJs(`!document.getElementById('creditsStepPay').classList.contains('hidden')`), '进入扫码支付步')
  ok(await evalJs(`document.getElementById('creditsPayAmount').textContent`) === '¥3', '应付金额 ¥3')
  ok(await evalJs(`(document.getElementById('creditsOrderId').textContent || '').length > 4`), '订单号展示')
  ok(await evalJs(`(document.getElementById('creditsOrderShort').textContent || '').length === 8`), '备注短号 8 位')
  ok(await evalJs(`document.querySelector('.credits-qr-wrap img') !== null`), '微信收款码图就位')
  await evalJs(`
    document.getElementById('creditsVoucher').value = '123';
    document.getElementById('creditsSubmitVoucher').click();
  `)
  await sleep(400)
  ok(await evalJs(`!document.getElementById('creditsPayError').classList.contains('hidden')`), '过短凭证被拦')
  await evalJs(`
    document.getElementById('creditsVoucher').value = '1000333444';
    document.getElementById('creditsSubmitVoucher').click();
  `)
  await sleep(1500)
  ok(await evalJs(`!document.getElementById('creditsStepAmount').classList.contains('hidden')`), '凭证提交成功回选金额步')
  const orderText = await evalJs(`document.getElementById('creditsOrdersList').textContent`) || ''
  ok(/¥3/.test(orderText) && /审核中/.test(orderText), `我的订单出现 ¥3 审核中（实际：${orderText.slice(0, 40)}）`)
  ok(/尾号/.test(orderText), '订单含备注尾号')
  await evalJs(`document.getElementById('creditsCloseX').click()`)
  await sleep(200)
  ok(await evalJs(`document.getElementById('creditsModal').classList.contains('hidden')`), '充值面板可关闭')

  // 8. token 落盘复查（含新昵称）
  const settingsFile = 'f:/局域网互传2.6/test/userData-auth-test/settings.json'
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { }
  ok(!!(saved && saved.auth && saved.auth.user && saved.auth.user.nickname === '改名后的喵'), 'settings.json 同步新昵称')

  // 8.5 v0.4 内置模型卡片（登录态：清单/余额/一键切换）
  await evalJs(`document.getElementById('aiSettingsBtn').click()`)
  await sleep(1200) // 等 loadBuiltinCards 拉清单+余额
  ok(await evalJs(`!document.getElementById('aiSettingsModal').classList.contains('hidden')`), '打开 AI 设置面板')
  ok(await evalJs(`document.querySelectorAll('#aiBuiltinCards .ai-builtin-card').length`) === 4, '内置对话模型卡片 4 张')
  ok(await evalJs(`document.querySelectorAll('#aiBuiltinCards .ai-builtin-tag').length >= 2`), '深度/视觉标签就位')
  ok(/余额 \d+ 积分/.test(await evalJs(`(document.getElementById('aiBuiltinBalance')||{}).textContent`) || ''), '余额行渲染（含积分数）')
  ok(await evalJs(`(document.querySelector('#aiBuiltinCards .ai-builtin-toolhint')||{textContent:''}).textContent.includes('生图') && document.querySelector('#aiBuiltinCards .ai-builtin-toolhint').textContent.includes('语音合成')`), '工具行含生图/语音提示')
  await evalJs(`document.querySelector('#aiBuiltinCards .ai-builtin-use').click()`)
  await sleep(900)
  ok(await evalJs(`document.getElementById('aiProviderSelect').value`) === 'msmate', '点卡片 → 服务商切到 msmate')
  ok(/^\[内置\]/.test(await evalJs(`document.getElementById('aiModelInput').value`) || ''), '点卡片 → 模型变 [内置] 前缀')
  await evalJs(`document.getElementById('aiSettingsCancel').click()`)
  await sleep(200)

  // 9. 登出 → 顶栏恢复图标、徽标隐藏；未登录点徽标 → 引导登录
  await evalJs(`document.getElementById('accountBtn').click()`)
  await sleep(200)
  await evalJs(`document.getElementById('authLogout').click()`)
  await sleep(600)
  ok(await evalJs(`document.querySelector('#accountBtnInner .ic-svg') !== null`), '登出后顶栏恢复人形图标')
  ok(await evalJs(`document.getElementById('creditBadge').classList.contains('hidden')`), '登出后积分徽标隐藏')
  ok(await evalJs(`document.getElementById('accountName').textContent`) === '未登录', '侧栏恢复未登录')
  // v0.4 未登录态：内置模型卡片显示登录引导
  await evalJs(`document.getElementById('aiSettingsBtn').click()`)
  await sleep(600)
  ok(await evalJs(`document.querySelector('#aiBuiltinCards .ai-builtin-empty') !== null`), '未登录开面板 → 卡片区显示登录引导')
  ok(await evalJs(`document.querySelectorAll('#aiBuiltinCards .ai-builtin-card').length`) === 0, '未登录不渲染模型卡片')
  await evalJs(`document.getElementById('aiSettingsCancel').click()`)
  await sleep(200)
  await evalJs(`document.getElementById('creditBadge').click()`)
  await sleep(300)
  ok(await evalJs(`document.getElementById('creditsModal').classList.contains('hidden')`), '未登录点徽标不弹充值面板')
  ok(await evalJs(`!document.getElementById('accountModal').classList.contains('hidden')`), '未登录点徽标弹出登录框')
  await evalJs(`document.getElementById('authCloseX').click()`)
  await sleep(200)

  // 10. 错误密码 → 服务端文案（先切回登录页签）
  await evalJs(`document.getElementById('accountBtn').click()`)
  await sleep(200)
  await evalJs(`document.querySelector('.auth-tab[data-authtab="login"]').click()`)
  await sleep(200)
  await evalJs(`
    document.getElementById('authEmail').value = ${JSON.stringify(email)};
    document.getElementById('authPassword').value = 'wrong-password-1';
    document.getElementById('authSubmit').click();
  `)
  await sleep(1500)
  const errMsg = await evalJs(`document.getElementById('authError').textContent`)
  ok(await evalJs(`!document.getElementById('authError').classList.contains('hidden')`) && /邮箱或密码错误/.test(errMsg || ''), `错误密码显示服务端文案（实际：${errMsg}）`)

  // 11. X 关闭 + 遮罩关闭
  await evalJs(`document.getElementById('authCloseX').click()`)
  await sleep(200)
  ok(await evalJs(`document.getElementById('accountModal').classList.contains('hidden')`), '点 X 关闭弹窗')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  ws.close()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('E2E 脚本异常:', e.message); process.exit(1) })
