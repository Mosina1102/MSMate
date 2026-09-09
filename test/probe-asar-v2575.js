// 发布后闭环：抽查 v2.5.75 产物 asar 里的正斜杠根因修复 + 缓存 + 版本号
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v2575', 'win-unpacked', 'resources', 'app.asar')
const ps1 = asar.extractFile(asarPath, path.join('ai', 'doc2docx.ps1')).toString('utf8')
const tools = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const checks = [
  ['Node 层 path.resolve 根因修复', tools.includes('srcPath = path.resolve(srcPath)')],
  ['ps1 Resolve-Path 双保险', ps1.includes('Resolve-Path -LiteralPath $Src')],
  ['转换缓存复用', tools.includes('docConvInflight') && tools.includes('mtimeMs')],
  ['引擎三候选仍在', /@\(\'KWPS\.Application\', \'Word\.Application\', \'WPS\.Application\'\)/.test(ps1)],
]
let bad = 0
checks.forEach(([k, hit]) => { if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar: ${k}`) })
const vOk = pkg.version === '2.5.75'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
