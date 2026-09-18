// 莫西桌宠主题 冒烟测试：主题四值 + 素材落盘 + 桌宠接线
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8') }

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ---- 1) 素材落盘（assets/moxi/ 14 文件 + WebP 魔数）----
  const assets = [
    'emotion-normal', 'emotion-sad', 'emotion-like', 'emotion-eager', 'emotion-surprised',
    'emotion-speechless', 'emotion-angry', 'emotion-confused', 'emotion-sleep',
    'avatar', 'standee', 'poster-h', 'poster-v', 'work-strip'
  ]
  for (const a of assets) {
    const f = path.join(ROOT, 'assets', 'moxi', a + '.webp')
    const exists = fs.existsSync(f)
    let magic = ''
    if (exists) { const b = fs.readFileSync(f); magic = b.toString('latin1', 0, 12) }
    ok(`素材 ${a}.webp`, exists && magic.startsWith('RIFF') && magic.includes('WEBP') && fs.statSync(f).size > 3000,
      exists ? 'magic=' + magic.slice(0, 4) : '不存在')
  }
  ok('素材总体积受控（<2.5MB）', (() => {
    let total = 0
    for (const a of assets) total += fs.statSync(path.join(ROOT, 'assets', 'moxi', a + '.webp')).size
    return total < 2.5 * 1024 * 1024
  })())

  // ---- 2) 主题四值：index.html 防闪烁 + 两处下拉 ----
  const indexHtml = read('src/index.html')
  ok('防闪烁脚本带 moxi 分支', /if \(_t === 'moxi'\) document\.documentElement\.classList\.add\('theme-moxi'\)/.test(indexHtml))
  ok('AI 设置下拉有莫西项', /id="aiThemeSelect"[\s\S]*?value="moxi">莫西主题/.test(indexHtml))
  ok('全局设置下拉有莫西项', /id="gsThemeSelect"[\s\S]*?value="moxi">莫西主题/.test(indexHtml))
  ok('全局设置有桌宠开关', /id="gsPetSelect"/.test(indexHtml) && /value="on">开启（莫西常驻桌面/.test(indexHtml))
  ok('侧栏/关于页莫西头像 img', (indexHtml.match(/logo-icon-moxi/g) || []).length === 2)
  ok('关于页莫西海报 img', /class="moxi-about-poster"/.test(indexHtml))
  ok('充值弹窗遮罩区立绘 img（登录弹窗已撤）', (indexHtml.match(/moxi-modal-standee/g) || []).length === 1)
  ok('主界面常驻立绘 img（右侧站台）', /id="moxiAppStandee" class="moxi-app-standee"/.test(indexHtml))

  // ---- 3) work.js 主题逻辑 + 空状态形象 ----
  const work = read('src/js/work.js')
  ok('getSavedTheme 接受 moxi', /t === 'dark' \|\| t === 'classic' \|\| t === 'moxi'/.test(work))
  ok('applyTheme 切换 theme-moxi 类', /classList\.toggle\('theme-moxi', t === 'moxi'\)/.test(work))
  ok('applyTheme 派发 theme-changed', /dispatchEvent\(new CustomEvent\('theme-changed'/.test(work))
  ok('emptyChatHtml 莫西形象分支', /function emptyChatHtml\(\)[\s\S]*?theme-moxi[\s\S]*?emotion-eager\.webp/.test(work))
  ok('EMPTY_CHAT_HTML 直引用清零', !/innerHTML = EMPTY_CHAT_HTML/.test(work), '残留处应改 emptyChatHtml()')
  ok('桌宠开关绑定 petSetEnabled', /gsPetSelect'\)\.addEventListener\('change'[\s\S]*?petSetEnabled/.test(work))

  // ---- 4) main.css 莫西主题段 ----
  const css = read('src/styles/main.css')
  ok('token 覆盖段存在', /:root\.theme-light\.theme-moxi \{/.test(css))
  ok('莫西紫 accent', /--accent: #7a5af5/.test(css))
  ok('主按钮药丸化', /theme-moxi \.btn-primary \{[\s\S]*?radius-pill/.test(css))
  ok('logo 显隐规则', /theme-moxi \.logo-icon-moxi \{ display: inline-block/.test(css))
  ok('海报显隐规则', /theme-moxi \.moxi-about-poster \{ display: block/.test(css))
  ok('充值弹窗立绘遮罩区站位（overlay absolute + min() 防出屏）', /#creditsModal \.moxi-modal-standee[\s\S]*?position: absolute/.test(css) && /min\(calc\(50% \+ 270px\), calc\(100% - 250px\)\)/.test(css))
  ok('主界面立绘 64vh 随窗口缩放', /theme-moxi \.moxi-app-standee \{[\s\S]*?height: 64vh/.test(css))
  ok('主界面立绘半透明水印式（内容之上低透明度）', /theme-moxi \.moxi-app-standee \{[\s\S]*?opacity: 0\.32/.test(css) && /theme-moxi \.moxi-app-standee \{[\s\S]*?z-index: 5/.test(css))
  const mainJs = read('main.js')
  ok('createTray 防重复托盘（先销毁旧 Tray）', /if \(tray\) \{ try \{ tray\.destroy\(\) \} catch \{\} tray = null \}/.test(mainJs))
  ok('托盘菜单热更新（Tray 本体不动）', /onEnabledChanged: \(\) => \{ if \(tray\) tray\.setContextMenu\(buildTrayMenu\(\)\) \}/.test(mainJs))
  ok('pet 窗口全事件日志（消失排查）', /ready-to-show 触发/.test(read('pet.js')) && /render-process-gone/.test(read('pet.js')))

  // ---- 5) 桌宠接线：pet.js / pet.html / preload / main.js ----
  ok('pet.js 存在', fs.existsSync(path.join(ROOT, 'pet.js')))
  const petHtml = read('src/pet.html')
  // pet.html：全场景统一动作帧 16 格表情系统（Q 版立绘只在界面，桌宠不用）
  const FRAME_KEYS = ['typingStart', 'typing', 'music', 'question', 'speechless', 'star', 'stressed', 'shock', 'serious', 'sleep', 'shout', 'talk', 'heart', 'love']
  const missingFrame = FRAME_KEYS.filter((k) => !new RegExp(`^\\s+${k}: \\d+,?`, 'm').test(petHtml))
  ok('精灵帧用途表 14 键齐全', missingFrame.length === 0, missingFrame.join(','))
  ok('桌宠不再用 Q 版立绘（场景统一）', !/assets\/moxi\/emotion-/.test(petHtml))
  for (const ev of ['user_msg', 'tool_call', 'tool_result', 'run_done', 'media_done', 'transfer_complete', 'error']) {
    ok(`事件映射 ${ev}`, new RegExp(`^      ${ev}:`, 'm').test(petHtml))
  }
  ok('工作中姿势轮播', /startWork[\s\S]*?WORK_ROTATE/.test(petHtml))
  ok('换帧 crossfade 双层过渡', /activeLayer/.test(petHtml) && /opacity.*transition|transition.*opacity/.test(petHtml))
  ok('呼吸浮动（待机/干活双速）', /@keyframes bob/.test(petHtml) && /actor\.working/.test(petHtml))
  ok('打字随机节奏（600~1500ms）', /600 \+ Math\.random\(\) \* 900/.test(petHtml))
  ok('ask_user → 问号帧', /name === 'ask_user'[\s\S]*?FRAME\.question/.test(petHtml))
  ok('90s 空闲 ZZZ 帧', /90 \* 1000/.test(petHtml) && /FRAME\.sleep/.test(petHtml))
  ok('失败两级：单败乱线/连败无语', /FRAME\.stressed/.test(petHtml) && /FRAME\.speechless/.test(petHtml))
  ok('气泡短句（寡言人设）', /'收到。'/.test(petHtml) && /'完事了。'/.test(petHtml))
  const preload = read('preload.js')
  ok('preload 桌宠 API 七件套', ['onPetEvent', 'petDragStart', 'petDragMove', 'petClick', 'petFileDrop', 'petGetEnabled', 'petSetEnabled'].every((k) => preload.includes(`${k}:`)))
  ok('拖文件给莫西（drop 监听 + IPC + 注入 WorkAgent）', /addEventListener\('drop'/.test(petHtml) && preload.includes('petFileDrop:') && /pet:file-drop/.test(mainJs) && /sendUserMessage/.test(mainJs))
  ok('开机时段问候', /夜猫子，注意身体。/.test(petHtml) && /new Date\(\)\.getHours\(\)/.test(petHtml))
  ok('桌宠右键菜单', /context-menu/.test(read('pet.js')) && /显示主界面[\s\S]*收起莫西[\s\S]*关闭桌宠/.test(read('pet.js')))

  ok('main.js 引入 pet.js', /require\('\.\/pet'\)/.test(mainJs))
  ok('WorkAgent send 广播桌宠', /petMgr\.petBroadcast\(event\)/.test(mainJs))
  ok('传输完成广播桌宠', /type: 'transfer_complete'/.test(mainJs))
  ok('启动恢复桌宠', /getSetting\('petEnabled'\)\) petMgr\.createPetWindow/.test(mainJs))
  ok('桌宠 IPC 五通道', ['pet:drag-start', 'pet:drag-move', 'pet:click', 'pet:get-enabled', 'pet:set-enabled'].every((c) => mainJs.includes(`'${c}'`)))
  ok('pet.html 走 window.api（preload 实际暴露名）', /window\.api && window\.api\.onPetEvent/.test(petHtml) && !petHtml.includes('window.msmate'))
  ok('托盘菜单莫西切换项', /唤出莫西|收起莫西/.test(mainJs))

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
