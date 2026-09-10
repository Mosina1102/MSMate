// v2.7.1+ 发布后闭环：抽查产物 asar——SVG 乱码修复 + 人设微调 + 版本号（用法：node probe-asar-v271.js [产物目录名] [期望版本号，默认 2.7.1]）
// v2.7.15：渲染层 2.7.12 拆分后断言对象改为四文件拼接（与 workbench-smoke 同口径）；新增 PPT 三件套进包断言
const asar = require('@electron/asar')
const path = require('path')

const dir = process.argv[2] || 'release_build_v271'
const VER = process.argv[3] || '2.7.1'
const asarPath = path.join(__dirname, '..', dir, 'win-unpacked', 'resources', 'app.asar')
// 渲染层四文件拼接（icons/webchat 不含断言对象）：app.js → word-embed.js → word-rich.js → work.js
const RENDER_FILES = ['src\\js\\app.js', 'src\\js\\word-embed.js', 'src\\js\\word-rich.js', 'src\\js\\work.js']
const app = RENDER_FILES.map((f) => asar.extractFile(asarPath, f).toString('utf8')).join('\n')
const prompt = asar.extractFile(asarPath, 'ai\\prompt.js').toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const has = (p) => { try { asar.extractFile(asarPath, p); return true } catch { return false } }

const checks = [
  [app.includes("$('wbViewIcon').innerHTML = itIcon(item)"), 'asar 渲染层：wbViewIcon 改 innerHTML（SVG 乱码修复，现居 word-rich.js）'],
  [!/textContent\s*=\s*(iconSvg|getFileIcon|itIcon)\(/.test(app), 'asar 渲染层：无 textContent 赋值图标串残留'],
  [/icon\.innerHTML = meta\.icon/.test(app) && !/textContent\s*=\s*meta\.icon/.test(app), 'asar 渲染层：引用胶囊 icon.innerHTML = meta.icon（2.7.11 补修）'],
  [/b\.innerHTML = txt/.test(app) && !/\.textContent\s*=\s*txt\b/.test(app), 'asar 渲染层：会话菜单 mkBtn innerHTML（删除会话按钮乱码修复）'],
  [/it\.innerHTML = a\.label/.test(app) && !/textContent\s*=\s*a\.label/.test(app), 'asar 渲染层：资源面板右键菜单 innerHTML（2.7.11 补修）'],
  [prompt.includes('默认称呼「你」，关怀句/收尾句用，不每句塞'), 'asar prompt.js：人设默认称呼（不每句塞「你」）'],
  [prompt.includes('声音（说话体）：口语小词自然带（从/个/的），不播报腔'), 'asar prompt.js：人设「声音」小节（口语体不播报腔）'],
  [has('node_modules\\pptxgenjs\\dist\\pptxgen.cjs.js'), 'asar node_modules：pptxgenjs 进包（PPT 三件套依赖）'],
  [has('ai\\manuals\\ppt文档.md'), 'asar ai/manuals：ppt文档.md 手册进包'],
  [pkg.version === VER, `asar package.json：version=${VER}（实际 ${pkg.version}）`]
]
let ok = true
for (const [pass, msg] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${msg}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
