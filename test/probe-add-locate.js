// 调试：addWordTable afterText 定位
const fs = require('fs')
const path = require('path')
const os = require('os')
const office = require('../ai/office.js')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-'))
  const doc = path.join(dir, '文档.docx')
  await office.createDocx(doc, { title: 'T', noTitle: true, paragraphs: [
    { text: '服务清单', style: 'h2' },
    { text: '这是服务清单说明段。', style: 'normal' },
    '| 项目 | 数量 |',
    '| --- | --- |',
    '| 导演 | 1 |',
    { text: '文档尾部说明。', style: 'normal' }
  ], fonts: { heading: '黑体', body: '宋体' } })
  const JSZip = require('jszip')
  const z = await JSZip.loadAsync(fs.readFileSync(doc))
  const docXml = await z.file('word/document.xml').async('string')
  console.log('docXml 长度:', docXml.length)
  const pm = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
  let mm, i = 0
  while ((mm = pm.exec(docXml)) && i < 12) {
    const t = ((mm[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x[0].replace(/<[^>]+>/g, '')).join('')).trim()
    console.log(`段[${i}] "${t.slice(0, 30)}"`)
    i++
  }
  console.log('含"服务清单":', /服务清单/.test(docXml))
  await office.addWordTable(doc, { afterText: '服务清单', rows: [['项目', '天数'], ['剪辑', '3']] })
  console.log('add 成功')
})().catch((e) => console.error('ERR', e.message))
