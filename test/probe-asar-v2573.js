// 发布后闭环：抽查 v2.5.73 产物 asar 里的旧版 .doc 兼容链路 + 版本号
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v2573', 'win-unpacked', 'resources', 'app.asar')
const tools = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const officeJs = asar.extractFile(asarPath, path.join('ai', 'office.js')).toString('utf8')
const ps1 = asar.extractFile(asarPath, path.join('ai', 'doc2docx.ps1')).toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const checks = [
  ['ps1 引擎探测 KWPS', ps1.includes('KWPS.Application')],
  ['ps1 SaveAs2 docx', ps1.includes('SaveAs2')],
  ['office isLegacyDoc', officeJs.includes('function isLegacyDoc') && officeJs.includes('0xD0, 0xCF, 0x11, 0xE0')],
  ['tools docToDocx', tools.includes('async function docToDocx')],
  ['tools ensureReadableDocx', tools.includes('async function ensureReadableDocx')],
  ['tools 写链守卫', (tools.match(/legacyDocWriteBlock\(/g) || []).length >= 10],
  ['tools 读链转换点位', (tools.match(/await ensureReadableDocx\(/g) || []).length >= 6],
  ['pdf_to_image 纠偏', tools.includes('这是旧版 .doc（Word 二进制），不是 PDF')],
]
let bad = 0
checks.forEach(([k, hit]) => { if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar: ${k}`) })
const vOk = pkg.version === '2.5.73'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
