// 看产出尾部：sectPr 收尾形态
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const office = require('../ai/office.js')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-'))
  const tpl = path.join(dir, 't.docx'), paper = path.join(dir, 'p.docx'), out = path.join(dir, 'o.docx')
  await office.createDocx(tpl, { title: '毕业论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '模板正文样本。', style: 'normal' }], fonts: { heading: '黑体', body: '宋体' } })
  await office.createDocx(paper, { title: '测试论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '论文正文段落一。', style: 'normal' }, { style: 'table', rows: [['特征', '表现'], ['数据', '要素']] }], fonts: { heading: '微软雅黑', body: '微软雅黑' } })
  await office.applyWordTemplate(paper, tpl, { outputPath: out, cover: { name: '测试员' } })
  const z = await JSZip.loadAsync(fs.readFileSync(out))
  const xml = (await z.file('word/document.xml').async('string')).trim()
  console.log('尾部 600 字:')
  console.log(xml.slice(-600))
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
