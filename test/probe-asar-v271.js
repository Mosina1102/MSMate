// v2.7.1+ 发布后闭环：抽查产物 asar——SVG 乱码修复 + 人设微调 + 版本号（用法：node probe-asar-v271.js [产物目录名] [期望版本号，默认 2.7.1]）
const asar = require('@electron/asar')
const path = require('path')

const dir = process.argv[2] || 'release_build_v271'
const VER = process.argv[3] || '2.7.1'
const asarPath = path.join(__dirname, '..', dir, 'win-unpacked', 'resources', 'app.asar')
const app = asar.extractFile(asarPath, 'src\\js\\app.js').toString('utf8')
const prompt = asar.extractFile(asarPath, 'ai\\prompt.js').toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))

const checks = [
  [app.includes("$('wbViewIcon').innerHTML = itIcon(item)"), 'asar app.js：wbViewIcon 改 innerHTML（SVG 乱码修复）'],
  [!/textContent\s*=\s*(iconSvg|getFileIcon|itIcon)\(/.test(app), 'asar app.js：无 textContent 赋值图标串残留'],
  [/icon\.innerHTML = meta\.icon/.test(app) && !/textContent\s*=\s*meta\.icon/.test(app), 'asar app.js：引用胶囊 icon.innerHTML = meta.icon（2.7.11 补修）'],
  [/b\.innerHTML = txt/.test(app) && !/\.textContent\s*=\s*txt\b/.test(app), 'asar app.js：会话菜单 mkBtn innerHTML（删除会话按钮乱码修复）'],
  [/it\.innerHTML = a\.label/.test(app) && !/textContent\s*=\s*a\.label/.test(app), 'asar app.js：资源面板右键菜单 innerHTML（2.7.11 补修）'],
  [prompt.includes('默认称呼「你」，关怀句/收尾句用，不每句塞'), 'asar prompt.js：人设默认称呼（不每句塞「你」）'],
  [prompt.includes('声音（说话体）：口语小词自然带（从/个/的），不播报腔'), 'asar prompt.js：人设「声音」小节（口语体不播报腔）'],
  [pkg.version === VER, `asar package.json：version=${VER}（实际 ${pkg.version}）`]
]
let ok = true
for (const [pass, msg] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${msg}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
