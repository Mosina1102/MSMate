// 合成论文试水：故意带"网页毒"（黑底表格/0F1115彩字/Segoe UI 换行run/超链接标题/英文摘要/VML分隔线）
// 验证 applyWordTemplate 的三线表转换、残留清洗、enAbstract 提取三条真素材论文覆盖不到的路径
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const { applyWordTemplate } = require('../ai/office')

const DIR = 'f:/局域网互传2.0/实验喵！'
const TPL = path.join(DIR, '论文格式模板.docx')
const PAPER = path.join(__dirname, 'tmp-synth-paper.docx')
const OUT = path.join(__dirname, 'tmp-synth-out.docx')

const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const SEGOE = '<w:rPr><w:rFonts w:hint="default" w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Segoe UI" w:cs="Segoe UI"/><w:color w:val="0F1115"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>'

const P = (inner) => `<w:p>${inner}</w:p>`
const T = (rpr, text) => `<w:r>${rpr}<w:t xml:space="preserve">${text}</w:t></w:r>`

// 黑底表格：tblStyle 引用 + 首行黑底(shd 0F1115)+vAlign，第二行普通
const TBL = '<w:tbl><w:tblPr><w:tblStyle w:val="co1"/><w:tblW w:w="0" w:type="auto"/>' +
  '<w:tblBorders><w:top w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>' +
  '<w:tblGrid><w:gridCol w:w="4320"/><w:gridCol w:w="4320"/></w:tblGrid>' +
  '<w:tr><w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="0F1115"/><w:vAlign w:val="center"/></w:tcPr>' + P(T('', '特征')) + '</w:tc>' +
  '<w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="0F1115"/></w:tcPr>' + P(T('', '表现')) + '</w:tc></w:tr>' +
  '<w:tr><w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/></w:tcPr>' + P(T('', '平台化')) + '</w:tc>' +
  '<w:tc><w:tcPr><w:tcW w:w="4320" w:type="dxa"/></w:tcPr>' + P(T('', '要素重构')) + '</w:tc></w:tr></w:tbl>'

const body =
  // 题目（0F1115 色污染）
  P(`<w:pPr>${SEGOE}</w:pPr>` + T(SEGOE, '论文题目：合成测试论文——验证三线表与残留清洗')) +
  P(T('', '摘要：这是合成摘要内容，验证摘要迁移。')) +
  P(T('', '关键词：测试；合成；三线表')) +
  P(T('', 'Abstract: This is a synthetic abstract for testing the en-abstract path.')) +
  P(T('', 'Key words: test; synthetic; triline')) +
  // 超链接包着的章标题（蓝色 run）
  P('<w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="a3"/><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>第一章 绪论</w:t></w:r></w:hyperlink>') +
  // 正文 + Segoe UI 换行 run（w:br 无 w:t，上一版漏洗的重灾区）+ 空段
  P(T('', '正文段落一，后面跟一个控制符换行。')) +
  P(`<w:r>${SEGOE}<w:br/></w:r>` + T('', '换行后的正文内容一')) +
  P(`<w:pPr>${SEGOE}</w:pPr>`) +
  TBL +
  // VML 分隔线（fillcolor 藏 0F1115）
  P(`<w:r>${SEGOE}<w:pict><v:rect o:spt="1" style="height:1.5pt;width:432pt;" fillcolor="#0F1115" stroked="f" o:hr="t"><v:path/></v:rect></w:pict></w:r>`) +
  P(T('', '第二章内容之前的段落。'))

const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">' +
  `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
const paperRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/x" TargetMode="External"/></Relationships>'

async function main() {
  // 造合成论文 docx
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CT)
  zip.file('_rels/.rels', RELS)
  zip.file('word/document.xml', docXml)
  zip.file('word/_rels/document.xml.rels', paperRels)
  fs.writeFileSync(PAPER, await zip.generateAsync({ type: 'nodebuffer' }))

  const r = await applyWordTemplate(PAPER, TPL, { outputPath: OUT, cover: { title: '合成测试论文', name: '测试员' } })
  console.log('sections:', r.sections.map((s) => `${s.kind}${s.skipped ? '(跳)' : s.enAbstractParas != null ? '' : ''}`).join('→'))
  console.log('enAbstractParas:', r.paper ? '-' : '')

  // 解包断言
  const z2 = await JSZip.loadAsync(fs.readFileSync(OUT))
  const doc = await z2.file('word/document.xml').async('string')
  const relsOut = await z2.file('word/_rels/document.xml.rels').async('string')
  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)

  ok('0F1115 全清（文本色+单元格底纹+VML填充）', !doc.includes('0F1115'))
  ok('Segoe UI 全清（含 w:br 控制符 run/空段段落标记）', !doc.includes('Segoe UI'))
  ok('VML 分隔线填充转 auto（黑线）', doc.includes('fillcolor="auto"'))
  ok('英文摘要合并行版式（Abstract: 内容一行，v2.5.78 按模板版式；示范内容丢弃）', doc.includes('Abstract:') && !doc.includes('In recent years, the media reported'))
  ok('英文摘要内容迁入', doc.includes('This is a synthetic abstract for testing the en-abstract path.'))
  ok('英文关键词行生成（Key words: + 内容）', doc.includes('Key words: ') && doc.includes('test; synthetic; triline'))
  ok('超链接标题文字保留（第一章 绪论）', doc.includes('第一章 绪论'))
  ok('超链接 rId 已重映射（rIdT 前缀）', /<w:hyperlink[^>]*r:id="rIdT\d+"/.test(doc) && relsOut.includes('TargetMode="External"'))
  // 三线表
  ok('表格顶/底线 1.5 磅(sz=12)', /<w:tblBorders><w:top w:val="single" w:color="auto" w:sz="12"/.test(doc))
  ok('表格内横线清除（insideH none）', /<w:insideH w:val="none"/.test(doc))
  ok('首行栏目线 0.75 磅(sz=6) 补上', /<w:tcBorders><w:bottom w:val="single" w:color="auto" w:sz="6" w:space="0"\/><\/w:tcBorders>/.test(doc))
  // tcPr 子元素 schema 顺序：tcW < tcBorders < vAlign
  const tr1 = doc.slice(doc.indexOf('<w:tbl>'), doc.indexOf('</w:tr>'))
  const iTcW = tr1.indexOf('<w:tcW'), iBd = tr1.indexOf('<w:tcBorders'), iVa = tr1.indexOf('<w:vAlign')
  ok('tcPr 顺序合规（tcW < tcBorders < vAlign）', iTcW >= 0 && iBd > iTcW && (iVa < 0 || iBd < iVa))
  ok('表头首行加粗', /<w:tbl>[\s\S]*?<w:b\/>/.test(doc))
  ok('单元格黑底已清（shd 移除）', !/<w:shd[^>]*0F1115/.test(doc))
  // 收口
  ok('</w:body> 闭合存在且紧邻 </w:document>', /<\/w:body>\s*<\/w:document>\s*$/.test(doc.trim()))
  ok('body 级 sectPr 收尾（裸 sectPr 紧贴 </w:body>）', /<\/w:p><w:sectPr[\s\S]*<\/w:sectPr><\/w:body>\s*<\/w:document>\s*$/.test(doc.trim()))
  ok('论文自带 body 级 sectPr 已被剔除（不双份）', (doc.match(/<w:sectPr[\s>]/g) || []).length >= 4)
  try {
    const { DOMParser } = require('linkedom')
    new DOMParser().parseFromString(doc, 'text/xml')
    ok('document.xml XML 良构', true)
  } catch (e) { ok('document.xml XML 良构: ' + e.message, false) }

  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
