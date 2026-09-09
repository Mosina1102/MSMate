// 复现冒烟场景：createDocx 默认表格经 applyWordTemplate 后 tblBorders 是否落上
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const office = require('../ai/office.js')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tri-'))
  const tpl = path.join(dir, 't.docx'), paper = path.join(dir, 'p.docx'), out = path.join(dir, 'o.docx')
  await office.createDocx(tpl, { title: '毕业论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '模板正文样本。', style: 'normal' }], fonts: { heading: '黑体', body: '宋体' } })
  await office.createDocx(paper, { title: '测试论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '论文正文段落一。', style: 'normal' }, { style: 'table', rows: [['特征', '表现'], ['数据', '要素']] }], fonts: { heading: '微软雅黑', body: '微软雅黑' } })
  await office.applyWordTemplate(paper, tpl, { outputPath: out, cover: { name: '测试员' } })
  const z = await JSZip.loadAsync(fs.readFileSync(out))
  const xml = await z.file('word/document.xml').async('string')
  const i = xml.indexOf('<w:tbl>')
  if (i < 0) {
    console.log('产出里根本没有 <w:tbl>！')
    const zp0 = await JSZip.loadAsync(fs.readFileSync(paper))
    const pxml0 = await zp0.file('word/document.xml').async('string')
    console.log('论文原件 has <w:tbl>:', pxml0.includes('<w:tbl>'), ' has 特征:', pxml0.includes('特征'))
    return
  }
  console.log('tbl 头部 500 字:')
  console.log(xml.slice(i, i + 500))
  // 对照：论文原件里的表格长啥样
  const zp = await JSZip.loadAsync(fs.readFileSync(paper))
  const pxml = await zp.file('word/document.xml').async('string')
  const j = pxml.indexOf('<w:tbl>')
  console.log('\n论文原件 tbl 头部 400 字:')
  console.log(pxml.slice(j, j + 400))
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
