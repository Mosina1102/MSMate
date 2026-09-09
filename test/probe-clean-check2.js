// 调试：干净对照（完整论文套模板）体检剩余 issue
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const office = require('../ai/office.js')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's266-'))
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const zt = new JSZip()
  zt.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
  zt.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zt.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p><w:r><w:t>摘  要</w:t></w:r></w:p><w:p><w:r><w:t>1.1 研究背景</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>研究背景示范</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p><w:p><w:r><w:t>模板正文示范段落。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
  zt.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="0" w:author="教务处" w:date="2026-09-07T10:00:00Z"><w:p><w:r><w:t>二级标题，四号，黑体，固定值20磅</w:t></w:r></w:p></w:comment></w:comments>`)
  const tpl = path.join(dir, 't.docx')
  fs.writeFileSync(tpl, await zt.generateAsync({ type: 'nodebuffer' }))
  const fullPaper = path.join(dir, '完整论文.docx')
  await office.createDocx(fullPaper, { title: '测试论文', noTitle: true, firstLine: true, paragraphs: [
    { text: '第一章 绪论', style: 'h1' },
    { text: '这是一段足够长的干净正文文字用于体检对照不应触发任何问题，字号字体均按模板规范。', style: 'normal', font: '宋体' },
    { text: '参考文献', style: 'h1' },
    { text: '[1] 王宝义. "新零售"的本质、成因及实践动向[J]. 中国流通经济, 2017.', style: 'normal', font: '宋体' }
  ], fonts: { heading: '黑体', body: '宋体' } })
  const clean = path.join(dir, 'c.docx')
  await office.applyWordTemplate(fullPaper, tpl, { outputPath: clean })
  const chk = await office.checkPaperFormat(clean, tpl)
  console.log('issues:', JSON.stringify(chk.issues, null, 1))
})().catch((e) => console.error('ERR', e.message))
