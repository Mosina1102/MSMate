// 发布后闭环：抽查 v2.5.72 产物 asar 里的表格补欠四件代码落位 + 版本号
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v2572', 'win-unpacked', 'resources', 'app.asar')
const s = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const b2 = asar.extractFile(asarPath, path.join('ai', 'office.js')).toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const defKeys = ["{ name: 'read_word_tables'", "{ name: 'format_word_table'", "{ name: 'add_word_table'", "{ name: 'edit_word_table'", "{ name: 'fix_paper_paging'", "{ name: 'svg_to_png'", 'diagHeader', "case 'fix_paper_paging'", "case 'svg_to_png'"]
const engKeys = ['setCellRich', "op.op === 'diagHeader'", 'async function fixPaperPaging', 'async function svgToPng', "tcOpen + tcPrNew + body + '</w:tc>'", 'loadAsync']
let bad = 0
defKeys.forEach((k) => { const hit = s.includes(k); if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar tools.js: ${k}`) })
engKeys.forEach((k) => { const hit = b2.includes(k); if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar office.js: ${k}`) })
const vOk = pkg.version === '2.5.72'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
