// 最小复现：createDocx 的 {style:'table'} 到底产出什么
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const office = require('../ai/office.js')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctbl-'))
  const p = path.join(dir, 'only-table.docx')
  await office.createDocx(p, { title: 'T', noTitle: true, paragraphs: [{ style: 'table', rows: [['特征', '表现'], ['数据', '要素']] }] })
  const z = await JSZip.loadAsync(fs.readFileSync(p))
  const xml = await z.file('word/document.xml').async('string')
  console.log('has <w:tbl>:', xml.includes('<w:tbl>'))
  console.log('has 特征:', xml.includes('特征'))
  console.log('body 片段:', xml.slice(xml.indexOf('<w:body>'), xml.indexOf('<w:body>') + 700))
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
