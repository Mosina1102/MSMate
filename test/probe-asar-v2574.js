// 发布后闭环：抽查 v2.5.74 产物 asar 里的 COM 转换健壮化 + 版本号
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v2574', 'win-unpacked', 'resources', 'app.asar')
const ps1 = asar.extractFile(asarPath, path.join('ai', 'doc2docx.ps1')).toString('utf8')
const tools = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const checks = [
  ['引擎三候选', /@\(\'KWPS\.Application\', \'Word\.Application\', \'WPS\.Application\'\)/.test(ps1)],
  ['2 轮重试', ps1.includes('for ($round = 1; $round -le 2; $round++)')],
  ['Open fallback', ps1.includes("Open($Src)") && ps1.includes("Open($Src, $false, $true)")],
  ['CONVERT_FAIL 步骤标记', ps1.includes('CONVERT_FAIL')],
  ['Node 层 busy 引导', tools.includes('关闭 WPS/Word 窗口后重试')],
  ['Node timeout 120s', tools.includes('timeout: 120000')],
]
let bad = 0
checks.forEach(([k, hit]) => { if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar: ${k}`) })
const vOk = pkg.version === '2.5.74'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
