// v2.5.62 真模板试跑：桌面实验喵的论文格式模板 → read_paper_spec 蒸馏全链路
const fs = require('fs')
const path = require('path')
const os = require('os')
const office = require('../ai/office.js')

const TPL = 'C:/Users/ars/Desktop/实验喵！/论文格式模板.docx'

async function main() {
  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)
  if (!fs.existsSync(TPL)) { console.log('真模板不存在，跳过'); process.exit(0) }

  const assetsDir = path.join(os.tmpdir(), 'spec-test-assets')
  const spec = await office.extractPaperFormatSpec(TPL, { assetsDir })

  // ① 批注规则解析（"小二号，黑体，固定值20磅，居中"→ sizePt 18 / 黑体 / linePt 20 / center）
  ok(`批注规则 ${spec.rules.length} 条`, spec.rules.length >= 6)
  const rule = spec.rules.find((r) => r.ruleText.includes('小二号'))
  ok('批注"小二号，黑体，固定值20磅，居中"→ sizePt=18', rule && rule.fmt && rule.fmt.sizePt === 18)
  ok('…eastAsiaFont=黑体', rule && rule.fmt && rule.fmt.eastAsiaFont === '黑体')
  ok('…linePt=20', rule && rule.fmt && rule.fmt.linePt === 20)
  ok('…align=center', rule && rule.fmt && rule.fmt.align === 'center')
  const trRule = spec.rules.find((r) => r.ruleText.includes('Times New Roman'))
  ok('批注"四号，Times New Roman…"→ font=Times New Roman + sizePt=14', trRule && trRule.fmt && trRule.fmt.font === 'Times New Roman' && trRule.fmt.sizePt === 14)
  const blank = spec.rules.find((r) => r.flags.includes('blankLine'))
  ok('批注"空一行"→ flag blankLine', !!blank)
  const hand = spec.rules.find((r) => r.flags.includes('handwritten'))
  ok('批注"手签"→ flag handwritten', !!hand)

  // ② 红字说明书
  ok(`红字说明书 ${spec.redNotes.length} 段`, spec.redNotes.length >= 2)
  ok('红字说明书含页码规则（罗马）', spec.redNotes.some((n) => /罗马/.test(n)))
  ok('红字说明书含目录要求', spec.redNotes.some((n) => /目录/.test(n)))

  // ③ 角色聚合
  ok('roles.body 有结构', !!(spec.roles.body && spec.roles.body.eastAsiaFont || (spec.roles.body && spec.roles.body.font)))
  console.log('roles keys:', Object.keys(spec.roles).join(','))
  console.log('roles.body:', JSON.stringify(spec.roles.body))

  // ④ 分节页码
  ok(`分节 ${spec.sections.length} 节`, spec.sections.length >= 2)
  ok('有罗马页码节', spec.sections.some((s) => /roman/i.test(s.pageNumFmt || '')))

  // ⑤ summary 输出
  ok('summary 含规范书标题', spec.summary.includes('论文格式规范书'))
  ok('summary 含排除说明', spec.summary.includes('已排除说明性内容'))
  console.log('\n===== 规范书全文 =====')
  console.log(spec.summary)
  console.log(`\n（规范书长度: ${spec.summary.length} 字 vs 模板全文 ~4 万字）`)

  console.log('\n' + asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
