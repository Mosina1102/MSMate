// 发布后闭环：抽查 v2.5.79 产物 asar 里的论文引擎修复 + 版本号
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v2579', 'win-unpacked', 'resources', 'app.asar')
const officeJs = asar.extractFile(asarPath, path.join('ai', 'office.js')).toString('utf8')
const tools = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const checks = [
  ['逐节对照进度表', officeJs.includes('【逐节对照进度】') && officeJs.includes('已过，可进下一段')],
  ['issue 板块归类', officeJs.includes('secOf') && officeJs.includes('secDefs')],
  ['板块判定内容特征对齐', officeJs.includes('hasTocSection: tplTexts.some') && officeJs.includes('/^关键词[:：]/')],
  ['check desc 分段循环', tools.includes('宁可多步不可做错') && tools.includes('六节全 ✓ 才算完成')],
  ['apply desc 分段循环', tools.includes('修一个板块复查一次') && tools.includes('禁止套完不验就交差')],
  ['spec desc 逐段依据', tools.includes('逐段提取模板格式') && tools.includes('✓ 才进下一段')],
  // v2.5.79：软换行拆段/单级编号 h3/指纹防污染（本次发布核心修复）
  ['软换行拆段重建纯段（不重复）', officeJs.includes('function softbreakSplitBlocks') && officeJs.includes('buildParaXml(head, {})')],
  ['单级编号行 h3 标记', officeJs.includes('function singleLevelHeadRole')],
  ['h2/h3 指纹防污染', officeJs.includes('ROLE_NUM_PAT') && officeJs.includes('looksTocEntry')],
]
let bad = 0
checks.forEach(([k, hit]) => { if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar: ${k}`) })
const vOk = pkg.version === '2.5.79'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
