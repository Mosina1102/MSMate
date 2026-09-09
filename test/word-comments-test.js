// v2.5.6 批注真跑：构造带批注的 docx → parseWordComments + read_word 工具链全通
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const office = require('../ai/office.js')

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

async function buildCommentedDocx(outPath) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`)
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:r><w:t>论文正文第一段，讲述数字经济背景。</w:t></w:r></w:p>
<w:p><w:r><w:t>这段说法不够严谨</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>，中小企业数字化转型路径单一</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="a3"/></w:rPr><w:commentReference w:id="0"/></w:r><w:r><w:t>，需要补充案例。</w:t></w:r></w:p>
<w:p><w:r><w:t>结论段。</w:t></w:r><w:r><w:rPr><w:rStyle w:val="a3"/></w:rPr><w:commentReference w:id="1"/></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`)
  zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}>
<w:comment w:id="0" w:author="王导师" w:date="2026-09-06T10:00:00Z" w:initials="王"><w:p><w:r><w:t>这里要补充一个具体案例支撑论点</w:t></w:r></w:p></w:comment>
<w:comment w:id="1" w:author="王导师" w:date="2026-09-06T10:05:00Z" w:initials="王"><w:p><w:r><w:t>结论太单薄，扩展成两段</w:t></w:r></w:p></w:comment>
</w:comments>`)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(outPath, buf)
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt-'))
  const docx = path.join(dir, '带批注论文.docx')
  await buildCommentedDocx(docx)

  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)

  // ① 引擎层：parseWordComments
  const cmts = await office.parseWordComments(docx)
  ok(`批注条数=2（实际 ${cmts.length}）`, cmts.length === 2)
  ok('批注0 作者=王导师', cmts[0].author === '王导师')
  ok('批注0 日期截取', String(cmts[0].date).startsWith('2026-09-06'))
  ok('批注0 内容', cmts[0].text === '这里要补充一个具体案例支撑论点')
  ok('批注0 锚定文本（range 内文字）', cmts[0].anchor === '，中小企业数字化转型路径单一')
  ok('批注1 内容', cmts[1].text === '结论太单薄，扩展成两段')
  ok('批注1 无 range → 空锚定', cmts[1].anchor === '')

  // ② 工具层：read_word 自动带出批注区
  const toolsMod = require('../ai/tools.js')
  const t = toolsMod.createTools({
    tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'x' }), snapshotDir: () => dir, register: () => {} },
    desktopDir: dir, tmpDir: dir, workspaceDir: dir,
    getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
  })
  const r = await t.execute('read_word', { path: docx })
  ok('read_word ok', r.ok)
  ok('正文带出', r.message.includes('中小企业数字化转型路径单一'))
  ok('批注区带出（标题）', r.message.includes('文档批注（2 条'))
  ok('批注作者+锚定+内容一行式', r.message.includes('王导师 2026-09-06: "，中小企业数字化转型路径单一" → 这里要补充一个具体案例支撑论点'))
  ok('空锚定占位', r.message.includes('（未锚定到选中文本）'))

  // ③ 无批注文档不出现批注区
  const plain = path.join(dir, '无批注.docx')
  await office.createDocx(plain, { title: '普通文档', paragraphs: [{ text: '你好', style: 'normal' }] })
  const r2 = await t.execute('read_word', { path: plain })
  ok('无批注文档无批注区', r2.ok && !r2.message.includes('文档批注'))

  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
