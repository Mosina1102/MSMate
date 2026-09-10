// 全局设置 + 自定义背景 冒烟测试
// 1) udpDiscovery.setBroadcastInterval 钳制与运行态重置
// 2) 静态一致性：index.html 的 gs* ID 与 app.js 引用一一对应；CSS 关键规则存在；顶栏旧入口已移除
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

// === 1. 扫描频率 ===
console.log('— 扫描频率 setBroadcastInterval —')
const { UDPDiscovery } = require('../server/udpDiscovery')
{
  const d = new UDPDiscovery()
  ok(d.broadcastInterval === 3000, '默认广播间隔 3000ms')
  ok(d.setBroadcastInterval(1000) === 1000, '设置为 1000ms 生效')
  ok(d.setBroadcastInterval(9999) === 9999, '设置为 9999ms 生效')
  ok(d.setBroadcastInterval(100) === 1000, '低于下限钳到 1000ms')
  ok(d.setBroadcastInterval(99999) === 10000, '高于上限钳到 10000ms')
  ok(d.setBroadcastInterval('abc') === 3000, '非法值回退 3000ms')
  ok(d.broadcastTimer === null, '未启动状态不创建定时器')
}

// === 2. 静态一致性 ===
console.log('— 全局设置静态一致性 —')
const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
// app.js + work.js 拆分后合并检查
const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')

const gsIds = [
  'globalSettingsModal', 'gsThemeSelect', 'gsBgThumb', 'gsBgPickBtn', 'gsBgClearBtn',
  'gsBgOpacity', 'gsBgOpacityVal', 'gsBgBlur', 'gsBgBlurVal', 'gsBgScale', 'gsBgScaleVal',
  'gsBgMask', 'gsBgMaskVal', 'gsPanelAlpha', 'gsPanelAlphaVal',
  'gsDownloadDirInput', 'gsDownloadDirBtn', 'gsScanInterval', 'gsStartupMode',
  'gsDeviceNameInput', 'gsDeviceNameSaveBtn', 'gsDeviceIPText',
  'gsAppVersion', 'gsHelpBtn', 'gsSettingsCancel', 'gsSettingsSave',
  'appBackground', 'appBgImg', 'appBgMask', 'globalSettingsBtn',
]
// appBgMask 的暗化纯靠 CSS 变量 --app-bg-mask 驱动，JS 无需引用
const jsIds = gsIds.filter((i) => i !== 'globalSettingsModal' && i !== 'appBgMask')
for (const id of gsIds) {
  ok(html.includes(`id="${id}"`), `HTML 含 #${id}`)
}
for (const id of jsIds) {
  ok(appjs.includes(`'${id}'`) || appjs.includes(`"${id}"`), `app.js 引用 #${id}`)
}

ok(!html.includes('editDeviceNameBtn'), '顶栏旧✏️入口已移除')
ok(html.includes('local-device-pill'), '顶栏本机胶囊卡已就位')
ok(appjs.includes("bind('globalSettingsBtn', 'click', openGlobalSettings)"), '全局设置入口已绑定')
ok(appjs.includes('msmate_last_mode'), '启动页「跟随上次」已记录')
ok(css.includes('.app-bg-img'), 'CSS 背景图层样式存在')
ok(css.includes(':root.has-bg .panel'), 'CSS 面板透明化规则存在')
ok(css.includes('.gs-nav-item.active'), 'CSS 全局设置导航样式存在')
ok(!/class="[^"]*\bai-nav-item gs-nav-item/.test(html), 'gs 导航不挂 ai-nav-item（两弹窗互不干扰）')

// === 3. 账号（auth 域）静态一致性 ===
console.log('— 账号 auth 域静态一致性 —')
const authjs = fs.readFileSync(path.join(ROOT, 'src/js/auth.js'), 'utf8')
ok(/<script src="js\/work\.js"><\/script>\s*<script src="js\/auth\.js"><\/script>/.test(html), 'index.html 引入 auth.js（紧跟 work.js 之后）')
const authIds = [
  // 顶栏入口
  'accountBtn', 'accountBtnInner', 'creditBadge', 'creditValue',
  // 侧栏账号行
  'accountRow', 'accountAvatar', 'accountName', 'accountSub',
  // 弹窗与表单
  'accountModal', 'authCloseX', 'authBrandTitle', 'authBrandSub',
  'authForms', 'authProfile', 'authEmail', 'authNickname',
  'authNicknameField', 'authPassword', 'authEye', 'authError', 'authSubmit', 'authLogout', 'authCancel',
  // 资料卡：昵称编辑 + 积分占位（authCreditRow 为纯展示容器，无需 JS 引用）
  'authEditNick', 'authNickEdit', 'authNickInput', 'authNickSave', 'authNickCancel',
  'authCreditVal',
]
for (const id of authIds) {
  ok(html.includes(`id="${id}"`), `HTML 含 #${id}`)
}
for (const id of authIds) {
  ok(authjs.includes(`'${id}'`), `auth.js 引用 #${id}`)
}
ok(html.includes('data-icon="coins"'), '积分徽标与积分行用 coins 图标')
ok(html.includes('data-icon="eye"'), '密码眼睛默认 eye 图标')
ok(html.includes('data-icon="square-pen"'), '修改昵称用 square-pen 图标')
ok(html.includes('data-icon="log-out"'), '退出登录按钮用 log-out 图标')
ok(authjs.includes("rowAvatar.innerHTML = iconSvg('user')"), '账号行头像 SVG 走 innerHTML（防乱码约定）')
ok(authjs.includes("btnInner.innerHTML = iconSvg('user')"), '顶栏头像 SVG 走 innerHTML（防乱码约定）')
ok(authjs.includes("iconSvg(authState.eyeOn ? 'eye-off' : 'eye')"), '眼睛切换走 innerHTML 动态图标')
ok(!authjs.includes('authApplyAvatar('), 'auth.js 无幽灵函数 authApplyAvatar 引用（E2E 抓过的渲染抛错 bug）')
ok(authjs.includes('authApplyAvatarImg(btnInner,') && authjs.includes('authApplyAvatarImg(rowAvatar,'), '顶栏+侧栏头像统一走 authApplyAvatarImg（有头像图显示图，无图显示首字）')
ok(css.includes('.avatar-mini-img'), 'CSS 头像图样式存在')
ok(authjs.includes('authState.user'), 'authState.user 登录态字段存在')
ok(authjs.includes('authMe()'), '启动时后台校验 token')
ok(authjs.includes('data-authtab'), '登录/注册页签切换就位')
ok(authjs.includes('authUpdateProfile'), '昵称编辑走 authUpdateProfile 桥')
ok(css.includes('.account-row'), 'CSS 侧栏账号行样式存在')
ok(css.includes('.account-btn'), 'CSS 顶栏头像按钮样式存在')
ok(css.includes('.credit-badge'), 'CSS 积分徽标样式存在')
ok(css.includes('.auth-brand-logo'), 'CSS 弹窗品牌头样式存在')
ok(css.includes('.auth-input-wrap input'), 'CSS 登录表单输入样式存在')
ok(css.includes('.auth-error.shake'), 'CSS 错误抖动动画存在')
ok(css.includes('.auth-nick-edit'), 'CSS 昵称编辑态样式存在')
ok(css.includes('.auth-credit-row'), 'CSS 积分行样式存在')
ok(css.includes('body.work-mode .account-row'), 'Work 模式账号行隐藏（不挤输入框）')
// 主进程与 preload 配对
const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const preloadjs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
for (const ch of ['auth:get-state', 'auth:register', 'auth:login', 'auth:me', 'auth:logout', 'auth:profile']) {
  ok(mainjs.includes(`'${ch}'`), `main.js 注册 ${ch}`)
  ok(preloadjs.includes(`'${ch}'`), `preload.js 桥接 ${ch}`)
}
ok(mainjs.includes('101.43.150.46:3210'), '主进程指向 msmate-api 服务地址（IP 直连，备案前域名被拦）')
ok(mainjs.includes('authBodyWithPassword({ email, password, nickname, code, agree: \'v1\' })'), 'auth:register 转发邮箱验证码与协议标记（code 不许丢，v2.7.16 密码走 RSA 加密）')
ok(preloadjs.includes('authRegister: (email, password, nickname, code)'), 'preload 注册桥把 code 传给主进程（E2E 抓过的丢参 bug）')
ok(mainjs.includes('authBodyWithPassword({ email, code, password })'), 'auth:reset 转发验证码与密码（v2.7.16 密码走 RSA 加密）')
ok(mainjs.includes("'/v1/auth/pubkey'") && mainjs.includes('RSA_PKCS1_OAEP_PADDING'), 'main.js 应用层加密：拉取服务端 RSA 公钥 + OAEP 加密密码（v2.7.16）')
ok(mainjs.includes("session.defaultSession.on('will-download'"), 'main.js 接管 will-download（网页下载进度，v2.7.16）')
ok(mainjs.includes("ipcMain.handle('feedback:submit'") && preloadjs.includes('feedbackSubmit:'), '应用内反馈链路（IPC + preload 桥，v2.7.16）')
ok(mainjs.includes("getSetting('auth')"), 'token 存 settings.json（auth 键）')
// 服务端
const serversrc = fs.readFileSync(path.join(ROOT, 'api-server/server.js'), 'utf8')
ok(serversrc.includes("'/v1/auth/profile'"), '服务端提供 PATCH /v1/auth/profile（改昵称）')

// === 3.5 用户协议（防扯皮条款）静态一致性 ===
console.log('— 用户协议 agreement 静态一致性 —')
ok(html.includes('id="agreementModal"') && html.includes('MSMate 用户协议'), 'HTML 含协议全文弹窗')
ok(html.includes('id="authAgreeField"') && html.includes('id="authAgree"'), '注册表单含协议勾选框')
ok(html.includes('id="authAgreementLink"'), '协议勾选行含可点击链接')
ok(html.includes('出借其自有的第三方模型服务商接口额度') && html.includes('不承担赔偿责任'), '协议含出借说明与数据免责关键条款')
ok(html.includes('id="agreementCloseBtn"'), '协议弹窗有关闭按钮')
for (const el of ['authAgreeField', 'authAgreementLink']) {
  ok(authjs.includes(`'${el}'`), `auth.js 引用 #${el}`)
}
ok(authjs.includes("checked") && authjs.includes('《MSMate 用户协议》'), '注册提交校验协议勾选')
ok(authjs.includes('agreementModal'), 'auth.js 绑定协议弹窗开关')
ok(mainjs.includes("agree: 'v1'"), 'main.js 注册请求带协议版本标记')
ok(serversrc.includes("body.agree !== 'v1'") && serversrc.includes("agreed: 'v1'"), '服务端注册校验并存档协议版本')

// === 4. 积分充值（credits 域）静态一致性 ===
console.log('— 积分充值 credits 域静态一致性 —')
ok(/<script src="js\/auth\.js"><\/script>\s*<script src="js\/credits\.js"><\/script>/.test(html), 'index.html 引入 credits.js（紧跟 auth.js 之后）')
const creditsjs = fs.readFileSync(path.join(ROOT, 'src/js/credits.js'), 'utf8')
const creditsIds = [
  'creditsModal', 'creditsCloseX', 'creditsCloseBtn',
  'creditsStepAmount', 'creditsStepPay',
  'creditsBalanceVal', 'creditsGrid', 'creditsError', 'creditsNextBtn',
  'creditsPayAmount', 'creditsOrderId', 'creditsOrderShort', 'creditsVoucher',
  'creditsPayError', 'creditsSubmitVoucher', 'creditsBackBtn', 'creditsOrdersList',
  'creditsSigninRow', 'creditsSigninProgress', 'creditsSigninBarFill', 'creditsSigninBtn',
]
for (const id of creditsIds) {
  ok(html.includes(`id="${id}"`), `HTML 含 #${id}`)
  ok(creditsjs.includes(`'${id}'`), `credits.js 引用 #${id}`)
}
ok(!html.includes('creditsCustom') && !creditsjs.includes('creditsCustom'), '自定义金额输入已移除（固定档位）')
for (const amount of [1, 3, 6, 30, 68, 128]) {
  ok(html.includes(`data-amount="${amount}"`), `充值档位 ¥${amount} 就位`)
}
ok(html.includes('../assets/wechat-pay-qr.png'), '充值弹窗引用微信收款码')
ok(fs.existsSync(path.join(ROOT, 'assets/wechat-pay-qr.png')), 'assets/wechat-pay-qr.png 收款码图片存在')
ok(html.includes('data-icon="clipboard"'), '凭证输入用 clipboard 图标（data-icon 占位）')
ok(creditsjs.includes('creditsOpen'), 'credits.js 定义 creditsOpen 入口')
ok(authjs.includes('creditsOpen()'), 'auth.js 积分徽标/充值按钮调起 creditsOpen')
ok(creditsjs.includes('authState.user'), '充值面板校验登录态')
ok(creditsjs.includes('window.api.creditsOrderCreate'), '下单走 creditsOrderCreate 桥')
ok(creditsjs.includes('window.api.creditsOrderVoucher'), '凭证提交走 creditsOrderVoucher 桥')
ok(creditsjs.includes('window.api.creditsOrdersMy'), '订单列表走 creditsOrdersMy 桥')
ok(creditsjs.includes('window.api.creditsBalance'), '余额刷新走 creditsBalance 桥')
ok(creditsjs.includes('innerHTML') && !/textContent\s*=\s*iconSvg/.test(creditsjs), 'credits.js 动态图标/列表一律 innerHTML（防乱码约定）')
ok(creditsjs.includes('cs-${o.status}') && creditsjs.includes('rejectReason'), '被拒订单展示拒绝原因（状态类动态映射 cs-*）')
ok(css.includes('.credits-tier.active'), 'CSS 档位选中态样式存在')
ok(css.includes('.credits-order-status'), 'CSS 订单状态徽标样式存在')
ok(css.includes('.cs-reviewing') && css.includes('.cs-done') && css.includes('.cs-rejected'), 'CSS 审核/到账/拒绝状态色存在')
for (const ch of ['credits:order-create', 'credits:order-voucher', 'credits:orders-my', 'credits:balance']) {
  ok(mainjs.includes(`'${ch}'`), `main.js 注册 ${ch}`)
  ok(preloadjs.includes(`'${ch}'`), `preload.js 桥接 ${ch}`)
}
ok(serversrc.includes("'/v1/credits/orders'"), '服务端提供 POST /v1/credits/orders（下单）')
ok(serversrc.includes('/v1/credits/orders/my'), '服务端提供 GET /v1/credits/orders/my')
ok(serversrc.includes('/admin'), '服务端内置 /admin 批款后台')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
