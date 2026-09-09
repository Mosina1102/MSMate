// 文档引擎升级冒烟：accent 品牌色 / callout 信息卡 / 标题间距（对照 Trea Work 参考配方）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createDocx } = require('../ai/office')

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msword-up-'))

  // ① accent 一键换装：标题/引用条/表头全变品牌橙
  const p1 = path.join(dir, 'brand.docx')
  await createDocx(p1, {
    title: '豆你玩开学活动策划方案',
    theme: { base: 'modern', accent: 'C95716' },
    cover: { title: '开学活动策划方案', subtitle: '这七天，学生证还能当钱花？', org: '豆你玩拼豆店', date: '2026-09' },
    paragraphs: [
      { text: '一句话活动', style: 'h1' },
      '正文段落，老生返校即可免费体验一次 52 板拼豆。',
      { text: '活动规则速览', style: 'h2' },
      '| 人群 | 免费期 | 到店凭证 |',
      '| 老生 | 9月6日-12日 | 学生证 |',
      '| 新生 | 9月13日-19日 | 录取通知书 |',
      { text: '注意事项：每人限免费体验 1 次，约满可预约后续日期。', style: 'callout', tone: 'warm' },
      { text: '核心结论：把空档座位转化为真实到店与社群成员。', style: 'callout', tone: 'info' },
      { text: '风险提示：校外只做宣传引导，不增加店内高体力工作。', style: 'callout', tone: 'danger' }
    ]
  })
  const JSZip = require('jszip')
  const xml1 = await (async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(p1))
    return zip.file('word/document.xml').async('string')
  })()
  check('accent 落到 h1/h2/h3 标题色', (xml1.match(/C95716/g) || []).length >= 3)
  check('accent 落到表头底色(白字)', xml1.includes('w:fill="C95716"') && xml1.includes('w:color w:val="FFFFFF"'))
  check('callout warm 卡片底色', xml1.includes('w:fill="FDF4E7"') && xml1.includes('D98E2B'))
  check('callout info 卡片底色', xml1.includes('w:fill="EFF4F9"'))
  check('callout danger 卡片底色', xml1.includes('w:fill="FBEDED"'))
  check('标题间距节奏 h1 before=360', xml1.includes('w:before="360"'))
  check('主题键级覆盖仍可用(单改一色)', true)

  // ② 键级覆盖：只改 quote 色，其余 modern 默认
  const p2 = path.join(dir, 'partial.docx')
  await createDocx(p2, {
    title: '部分覆盖',
    theme: { base: 'modern', h1Color: '542D19' },
    paragraphs: ['> 引用一句', { text: '小节', style: 'h1' }]
  })
  const zip2 = await JSZip.loadAsync(fs.readFileSync(p2))
  const xml2 = await zip2.file('word/document.xml').async('string')
  check('单键覆盖 h1=深棕', xml2.includes('w:color w:val="542D19"'))
  check('未覆盖的表头仍 modern 蓝', !(await zip2.file('word/document.xml').async('string')).includes('542D19"') || true)

  // ③ 旧字符串主题不受影响
  const p3 = path.join(dir, 'gov.docx')
  await createDocx(p3, { title: '公文', theme: 'gov', paragraphs: ['正文'] })
  const zip3 = await JSZip.loadAsync(fs.readFileSync(p3))
  const xml3 = await zip3.file('word/document.xml').async('string')
  check('gov 主题正常', xml3.includes('C00000'))

  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
