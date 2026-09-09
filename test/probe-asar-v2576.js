// 发布后闭环：抽查 v2.5.76 产物 asar 里的说明书式模板嫁接修复 + 版本号
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v2576', 'win-unpacked', 'resources', 'app.asar')
const officeJs = asar.extractFile(asarPath, path.join('ai', 'office.js')).toString('utf8')
const tools = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const checks = [
  ['isFormatDemoPara 引擎', officeJs.includes('function isFormatDemoPara') && officeJs.includes('空一格')],
  ['节判定内容特征（目录条目/关键词/文献条目）', officeJs.includes('tocEntries') && officeJs.includes('^关键词[:：]') && officeJs.includes('^\\[\\d+\\]')],
  ['清洗后重算 kind', /sec\.kind = classifyTplSection\(sec\.paras, prevKind\)/.test(officeJs)],
  ['注意事项剔除+声明解禁', officeJs.includes('/^注\\s*意\\s*事\\s*项/') && officeJs.includes('本科毕业论文.{0,8}(原创性声明|版权使用授权书)')],
  ['摘要排头 fallback', officeJs.includes("buildParaXml('摘  要'")],
  ['封面标签放宽（题 目 带空格/教学站）', officeJs.includes('题\\s*目') && officeJs.includes('教学站')],
  ['体检排除封面字段/声明页误报', officeJs.includes('coverFieldRe') && officeJs.includes('本人郑重声明')],
  ['apply_word_format 论文禁用警示', tools.includes('改论文格式禁用本工具')],
  ['apply_word_template 工作流固化', tools.includes('校徽等封面图片、原创性声明/授权页自动迁入') && tools.includes('改论文格式**必须走本工具**')],
]
let bad = 0
checks.forEach(([k, hit]) => { if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar: ${k}`) })
const vOk = pkg.version === '2.5.76'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
