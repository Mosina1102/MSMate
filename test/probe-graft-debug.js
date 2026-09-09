// 打点调试：applyWordTemplate 内部走了哪条路、bodyBlocks 是什么
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const office = require('../ai/office.js')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'))
  const tpl = path.join(dir, 't.docx'), paper = path.join(dir, 'p.docx'), out = path.join(dir, 'o.docx')
  await office.createDocx(tpl, { title: '毕业论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '模板正文样本。', style: 'normal' }], fonts: { heading: '黑体', body: '宋体' } })
  await office.createDocx(paper, { title: '测试论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '论文正文段落一。', style: 'normal' }, { style: 'table', rows: [['特征', '表现'], ['数据', '要素']] }], fonts: { heading: '微软雅黑', body: '微软雅黑' } })
  const r = await office.applyWordTemplate(paper, tpl, { outputPath: out, cover: { name: '测试员' } })
  console.log('sectionReport:', JSON.stringify(r.sectionReport, null, 1))
  console.log('paper:', JSON.stringify(r.paper))
  const z = await JSZip.loadAsync(fs.readFileSync(out))
  const xml = await z.file('word/document.xml').async('string')
  const i = xml.indexOf('<w:tbl>')
  console.log('\n产出 tbl 是否三线化:', /<w:tblBorders><w:top w:val="single" w:color="auto" w:sz="12"/.test(xml))
  if (i >= 0) console.log('产出 tblPr:', xml.slice(i, i + 260))
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
