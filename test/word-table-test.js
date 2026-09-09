// v2.5.70 Word 表格工具套件手工冒烟：read → format → edit → add 全流程
const fs = require('fs')
const path = require('path')
const os = require('os')
const office = require('../ai/office.js')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-'))
  const doc = path.join(dir, '文档.docx')
  await office.createDocx(doc, { title: 'T', noTitle: true, paragraphs: [
    { text: '服务清单', style: 'h2' },
    { text: '这是服务清单说明段。', style: 'normal' },
    '| 项目 | 数量 |',
    '| --- | --- |',
    '| 导演 | 1 |',
    { text: '文档尾部说明。', style: 'normal' }
  ], fonts: { heading: '黑体', body: '宋体' } })

  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)

  // ① read
  const JSZipL = require('jszip')
  const zl = await JSZipL.loadAsync(fs.readFileSync(doc))
  const docXml0 = await zl.file('word/document.xml').async('string')
  const tables = office.scanWordTables(docXml0)
  ok(`scanWordTables：${tables.length} 个表`, tables.length === 1)

  // ② format 三线表 + 列宽 + 表内文字
  await office.formatWordTable(doc, { index: 1, style: 'threeline', colWidths: [5, 5], eastAsiaFont: '黑体', sizePt: 12, headerBold: true })
  const JSZip = require('jszip')
  let z = await JSZip.loadAsync(fs.readFileSync(doc))
  let x = await z.file('word/document.xml').async('string')
  console.log('threeline后 tbl 计数:', (x.match(/<w:tbl(?:\s[^>]*)?>/g) || []).length, '| 尾部:', x.slice(-200).replace(/\s+/g, ' ').slice(-160))
  ok('三线表：顶/底线 sz12', /<w:tblBorders><w:top w:val="single" w:color="auto" w:sz="12"/.test(x))
  ok('三线表：无竖线', !/<w:insideV w:val="single"/.test(x))
  ok('栏目线 sz6 注入', /<w:tcBorders><w:bottom w:val="single" w:color="auto" w:sz="6"/.test(x))
  ok('列宽生效（5cm=2835 dxa）', x.includes('w:w="2835"'))
  ok('表头跨页重复 tblHeader', x.includes('<w:tblHeader/>'))
  ok('表内文字黑体', /<w:rFonts[^>]*w:eastAsia="黑体"[^>]*\/>/.test(x) || x.includes('w:eastAsia="黑体"'))

  // ③ zebra 风格
  const preZebra = await (require('jszip')).loadAsync(fs.readFileSync(doc))
  const preX = await preZebra.file('word/document.xml').async('string')
  console.log('zebra前 tbl 计数:', (preX.match(/<w:tbl(?:\s[^>]*)?>/g) || []).length)
  await office.formatWordTable(doc, { index: 1, style: 'zebra', headerFill: '2E5E8C', headerColor: 'FFFFFF', zebraFill: 'F4F8FC' })
  z = await JSZip.loadAsync(fs.readFileSync(doc))
  x = await z.file('word/document.xml').async('string')
  ok('斑马纹：表头底色', x.includes('w:fill="2E5E8C"'))
  ok('斑马纹：隔行底色', x.includes('w:fill="F4F8FC"'))
  ok('底纹 CLEAR 模式（WPS 兼容）', x.includes('w:val="clear"') && !x.includes('w:val="solid"'))

  // ④ edit：setCell + insertRow + mergeCells
  await office.editWordTable(doc, { index: 1, ops: [
    { op: 'setCell', row: 2, col: 1, text: '摄影指导' },
    { op: 'insertRow', at: 3, cells: ['灯光师', '1'] }
  ]})
  z = await JSZip.loadAsync(fs.readFileSync(doc))
  x = await z.file('word/document.xml').async('string')
  ok('setCell 改格成功', x.includes('摄影指导'))
  ok('insertRow 插行成功', x.includes('灯光师'))

  // ⑤ add：在"文档尾部说明"前插表
  const addDoc = path.join(dir, '插入.docx')
  fs.copyFileSync(doc, addDoc)
  await office.addWordTable(addDoc, { afterText: '服务清单', rows: [['项目', '天数'], ['剪辑', '3']], colWidths: [4, 4], theme: { base: 'modern' } })
  z = await JSZip.loadAsync(fs.readFileSync(addDoc))
  x = await z.file('word/document.xml').async('string')
  ok('add 插表成功（现 2 个表）', (x.match(/<w:tbl(?:\s[^>]*)?>/g) || []).length === 2)
  const pos = x.indexOf('剪辑')
  ok('插表位置在"服务清单"之后', pos < x.indexOf('文档尾部说明'))

  // ⑥ edit mergeCells
  const mergeDoc = path.join(dir, '合并.docx')
  await office.createDocx(mergeDoc, { title: 'M', noTitle: true, paragraphs: ['| a | b |', '| 1 | 2 |', '| 3 | 4 |'] })
  await office.editWordTable(mergeDoc, { index: 1, ops: [{ op: 'mergeCells', r1: 2, r2: 3, c1: 1, c2: 1 }] })
  z = await JSZip.loadAsync(fs.readFileSync(mergeDoc))
  x = await z.file('word/document.xml').async('string')
  ok('纵向合并 vMerge restart+continue', x.includes('<w:vMerge w:val="restart"/>') && x.includes('<w:vMerge/>'))

  // ⑦ 按列参数（语义驱动："金额列右对齐"）
  const colDoc = path.join(dir, '按列.docx')
  await office.createDocx(colDoc, { title: 'C', noTitle: true, paragraphs: ['服务费用清单', '| 项目 | 金额 |', '| --- | --- |', '| 布展 | 12000 |'] })
  await office.formatWordTable(colDoc, { index: 1, style: 'grid', colAligns: ['center', 'right'], colBold: [null, true] })
  z = await JSZip.loadAsync(fs.readFileSync(colDoc))
  x = await z.file('word/document.xml').async('string')
  const dataCellM = x.match(/<w:tc(?:\s[^>]*)?>(?:(?!<\/w:tc>)[\s\S])*?布展(?:(?!<\/w:tc>)[\s\S])*?<\/w:tc>/)
  const amtCellM = x.match(/<w:tc(?:\s[^>]*)?>(?:(?!<\/w:tc>)[\s\S])*?12000(?:(?!<\/w:tc>)[\s\S])*?<\/w:tc>/)
  ok('按列：首列居中', !!dataCellM && dataCellM[0].includes('<w:jc w:val="center"/>'))
  ok('按列：金额列右对齐', !!amtCellM && amtCellM[0].includes('<w:jc w:val="right"/>'))
  ok('按列：金额列加粗（列级覆盖）', !!amtCellM && amtCellM[0].includes('<w:b/>'))

  // ⑧ keepWithPrev：表标题与表格同页
  await office.formatWordTable(colDoc, { index: 1, style: 'grid', keepWithPrev: true })
  z = await JSZip.loadAsync(fs.readFileSync(colDoc))
  x = await z.file('word/document.xml').async('string')
  ok('keepWithPrev：表前段落注入 keepNext', x.includes('<w:keepNext/>'))

  // ⑨ v2.5.72：setCell 富文本（paras 多段异格式）
  await office.editWordTable(doc, { index: 1, ops: [
    { op: 'setCell', row: 2, col: 1, text: { paras: [
      { text: '摄影指导', bold: true, align: 'center' },
      { text: '（外聘）', sizePt: 9, color: '888888' }
    ] } }
  ]})
  z = await JSZip.loadAsync(fs.readFileSync(doc))
  x = await z.file('word/document.xml').async('string')
  const richCell = x.match(/<w:tc(?:\s[^>]*)?>(?:(?!<\/w:tc>)[\s\S])*?摄影指导(?:(?!<\/w:tc>)[\s\S])*?<\/w:tc>/)
  ok('富文本：同格两段异格式', !!richCell && (richCell[0].match(/<w:p(?:\s[^>]*)?>/g) || []).length >= 2 && richCell[0].includes('（外聘）'))
  ok('富文本：首段加粗+居中', !!richCell && richCell[0].includes('<w:b/>') && richCell[0].includes('<w:jc w:val="center"/>'))

  // ⑩ v2.5.72：diagHeader 斜线表头
  await office.editWordTable(doc, { index: 1, ops: [
    { op: 'diagHeader', row: 1, col: 1, lines: ['项目', '姓名'] }
  ]})
  z = await JSZip.loadAsync(fs.readFileSync(doc))
  x = await z.file('word/document.xml').async('string')
  const diagCell = x.match(/<w:tc(?:\s[^>]*)?>(?:(?!<\/w:tc>)[\s\S])*?<w:tl2br[^>]*\/>(?:(?!<\/w:tc>)[\s\S])*?<\/w:tc>/)
  ok('斜线表头：tl2br 对角线注入', !!diagCell)
  ok('斜线表头：右上/左下错位文字', !!diagCell && diagCell[0].includes('项目') && diagCell[0].includes('姓名'))
  ok('斜线表头：tc 标签完整（不丢结构）', (x.match(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g) || []).length >= 1 && (x.match(/<\/w:tc>/g) || []).length >= 6)

  // ⑪ v2.5.72：fixPaperPaging 全局分页修复
  const pgDoc = path.join(dir, '分页.docx')
  await office.createDocx(pgDoc, { title: 'P', noTitle: true, paragraphs: ['季度统计表', '| 名 | 值 |', '| a | 1 |', '| b | 2 |', '文档尾段。'] })
  // createDocx 的 markdown 表格自带 tblHeader/keepNext——先剥掉才能验证补头路径真实工作
  let zp = await JSZip.loadAsync(fs.readFileSync(pgDoc))
  let dx = await zp.file('word/document.xml').async('string')
  dx = dx.replace(/<w:tblHeader\/>/g, '').replace(/<w:keepNext\/>/g, '')
  zp.file('word/document.xml', dx)
  fs.writeFileSync(pgDoc, await zp.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const pgR = await office.fixPaperPaging(pgDoc)
  ok('分页修复：返回统计（1 表 / keepNext / tblHeader）', pgR.tables === 1 && pgR.keepNextAdded >= 1 && pgR.headerRepeated >= 1)
  z = await JSZip.loadAsync(fs.readFileSync(pgDoc))
  x = await z.file('word/document.xml').async('string')
  ok('分页修复：keepNext + tblHeader 落盘', x.includes('<w:keepNext/>') && x.includes('<w:tblHeader/>'))

  // ⑫ v2.5.72：svgToPng 纯 Node 明确报错（应用内渲染链路由 electron-probe 覆盖）
  const svgPath = path.join(dir, 'chart.svg')
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#4a6fa5"/></svg>')
  let svgErr = ''
  try { await office.svgToPng(svgPath, path.join(dir, 'chart.png')) } catch (e) { svgErr = e.message }
  ok('svgToPng：应用外明确报错（不静默）', svgErr.includes('应用'))

  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
