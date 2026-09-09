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
  'accountRow', 'accountAvatar', 'accountName', 'accountSub',
  'accountModal', 'authForms', 'authProfile', 'authEmail', 'authNickname',
  'authNicknameField', 'authPassword', 'authError', 'authSubmit', 'authLogout', 'authCancel',
]
for (const id of authIds) {
  ok(html.includes(`id="${id}"`), `HTML 含 #${id}`)
}
for (const id of authIds) {
  ok(authjs.includes(`'${id}'`), `auth.js 引用 #${id}`)
}
ok(html.includes('data-icon="circle-user-round"'), '弹窗标题用 circle-user-round 图标')
ok(html.includes('data-icon="log-out"'), '退出登录按钮用 log-out 图标')
ok(authjs.includes("rowAvatar.innerHTML = iconSvg('user')"), '账号行头像 SVG 走 innerHTML（防乱码约定）')
ok(authjs.includes('authState.user'), 'authState.user 登录态字段存在')
ok(authjs.includes('authMe()'), '启动时后台校验 token')
ok(authjs.includes('data-authtab'), '登录/注册页签切换就位')
ok(css.includes('.account-row'), 'CSS 侧栏账号行样式存在')
ok(css.includes('.auth-field input'), 'CSS 登录表单输入样式存在')
ok(css.includes('.auth-error'), 'CSS 错误提示样式存在')
// 主进程与 preload 配对
const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const preloadjs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
for (const ch of ['auth:get-state', 'auth:register', 'auth:login', 'auth:me', 'auth:logout']) {
  ok(mainjs.includes(`'${ch}'`), `main.js 注册 ${ch}`)
  ok(preloadjs.includes(`'${ch}'`), `preload.js 桥接 ${ch}`)
}
ok(mainjs.includes('api.mosina.top:3210'), '主进程指向 msmate-api 服务地址')
ok(mainjs.includes("getSetting('auth')"), 'token 存 settings.json（auth 键）')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
