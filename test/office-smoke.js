// office.js 冒烟测试：Word 修改 + Excel 创建/读取/追加（临时目录内自测后清理）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createDocx, readDocxText, modifyDocx, createXlsx, appendXlsxRows, readXlsx, modifyXlsxCell, modifyXlsxCells, formatXlsx } = require('../ai/office')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-office-'))
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }
  try {
    // Word：创建 → 追加 → 读
    const docx = path.join(dir, '测试文档.docx')
    await createDocx(docx, { title: '测试标题', paragraphs: ['第一段', '## 小节', '第二段'] })
    check('创建 docx', fs.existsSync(docx))
    const before = await readDocxText(docx)
    check('读取 docx 含标题和段落', before.includes('测试标题') && before.includes('第一段') && before.includes('小节'))
    await modifyDocx(docx, { paragraphs: ['追加的第三段'] }, 'append')
    const after = await readDocxText(docx)
    check('追加后原内容保留', after.includes('第一段') && after.includes('测试标题'))
    check('追加内容出现', after.includes('追加的第三段'))
    await modifyDocx(docx, { title: '新标题', paragraphs: ['全量重写的内容'] }, 'replace')
    const replaced = await readDocxText(docx)
    check('replace 后旧内容消失', replaced.includes('全量重写的内容') && !replaced.includes('第一段'))
    await modifyDocx(docx, { paragraphs: [{ text: '样式标题', style: 'h2' }, { text: '引用段', style: 'quote' }, '## 简写标题'] }, 'append')
    const styled = await readDocxText(docx)
    check('样式段落追加', styled.includes('样式标题') && styled.includes('引用段') && styled.includes('简写标题'))

    // 富文本 markdown 直传：行内加粗拆多 run、标题层级映射、星号不残留
    const JSZip = require('jszip')
    const rich = path.join(dir, '富文本.docx')
    await createDocx(rich, {
      title: '富文本测试',
      paragraphs: [
        '# 一级标题',
        '## 二级小节',
        '这是**行内重点**和普通文字混排，还有**第二个重点**。',
        '> 这是一句引用',
        '- 列表项甲',
        '1. 编号项',
        '#### 深层标题'
      ]
    })
    const richZip = await JSZip.loadAsync(fs.readFileSync(rich))
    const richXml = await richZip.file('word/document.xml').async('string')
    check('行内加粗生成加粗 run', (richXml.match(/<w:b\/>/g) || []).length >= 5 && richXml.includes('行内重点'))
    check('markdown 星号不残留', !richXml.includes('**'))
    check('编号列表保留', richXml.includes('1. 编号项'))
    check('深层标题(####)转 h3', richXml.includes('深层标题'))

    // Excel：创建 → 读 → 追加 → 读
    const xlsx = path.join(dir, '测试表格.xlsx')
    await createXlsx(xlsx, { headers: ['姓名', '数量', '备注'], rows: [['苹果', 3, ''], ['香蕉', 12, '带空格 描述']] })
    check('创建 xlsx', fs.existsSync(xlsx))
    let table = await readXlsx(xlsx)
    check('表头读取', table[0] && table[0][0] === '姓名' && table[0][1] === '数量')
    check('数字单元格读取', table[1] && table[1][1] === '3')
    check('含空格文本读取', table[2] && table[2][2] === '带空格 描述')
    await appendXlsxRows(xlsx, [['樱桃', 7, '追加行']])
    table = await readXlsx(xlsx)
    check('追加行读取', table.length === 4 && table[3][0] === '樱桃' && table[3][1] === '7')

    // 单元格修改：改现有 / 改空单元格 / 改数字
    await modifyXlsxCell(xlsx, 'B1', 99)
    table = await readXlsx(xlsx)
    check('修改现有单元格(数字)', table[0][1] === '99')
    await modifyXlsxCell(xlsx, 'C2', '改过的备注')
    table = await readXlsx(xlsx)
    check('修改文本单元格', table[1][2] === '改过的备注')
    await modifyXlsxCell(xlsx, 'D4', '新列新行')
    table = await readXlsx(xlsx)
    check('跨行跨列新增单元格', table[3] && table[3][3] === '新列新行')
    await modifyXlsxCell(xlsx, 'AA1', '远列')
    table = await readXlsx(xlsx)
    check('AA 远列写入', table[0][26] === '远列')

    // 格式美化：重建为美化样式，数据内容必须原样保留
    const beforeFmt = await readXlsx(xlsx)
    await formatXlsx(xlsx)
    const afterFmt = await readXlsx(xlsx)
    check('美化后数据不变', JSON.stringify(beforeFmt) === JSON.stringify(afterFmt))

    // markdown 简写：Word 引用/加粗/列表 + Excel 直接吃 markdown 表格文本
    const mdDocx = path.join(dir, 'md简写.docx')
    await createDocx(mdDocx, { title: 'MD', paragraphs: ['> 一句引用', '**重点句**', '- 第一项', '* 第二项'] })
    const mdText = await readDocxText(mdDocx)
    check('markdown 引用/加粗/列表简写', mdText.includes('一句引用') && mdText.includes('重点句') && !mdText.includes('**') && mdText.includes('• 第一项') && mdText.includes('• 第二项'))

    const { createTools } = require('../ai/tools')
    const tools = createTools({
      tcpAgent: { getConnectedDevices: () => [] },
      snapshots: { backupLocal: () => ({ ok: true, id: 'x' }) },
      desktopDir: path.join(dir, 'desktop'),
      tmpDir: dir,
      workspaceDir: dir,
      getSetting: () => null,
      setSetting: () => {},
      log: () => {}
    })
    const mdXlsx = path.join(dir, 'md表格.xlsx')
    const rMd = await tools.execute('create_table', { path: mdXlsx, content: '| 姓名 | 数量 |\n|---|---|\n| 苹果 | 3 |\n| 香蕉 | 12 |' })
    const mdTable = rMd.ok ? await readXlsx(mdXlsx) : []
    check('create_table 直吃 markdown 表格', rMd.ok && mdTable[0][0] === '姓名' && mdTable[1][1] === '3' && mdTable[2][0] === '香蕉', rMd.message)

    // ===== v2 引擎新能力 =====

    // Word 插图（create + append 都要支持）
    const imgPath = path.join(dir, '像素.png')
    fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
    const imgDocx = path.join(dir, '插图.docx')
    await createDocx(imgDocx, { title: '图文档', paragraphs: ['正文一句', `![图 1 描述](${imgPath})`, '图后文字'] })
    const imgZip = await JSZip.loadAsync(fs.readFileSync(imgDocx))
    const imgXml = await imgZip.file('word/document.xml').async('string')
    const imgMedia = imgZip.file(/^word\/media\//) || []
    check('create_word 嵌入图片(media)', imgMedia.length === 1 && imgXml.includes('<w:drawing'))
    check('create_word 图片居中带图注', imgXml.includes('图 1 描述') && imgXml.includes('图后文字'))
    await modifyDocx(imgDocx, { paragraphs: [`![追加图](${imgPath})`] }, 'append')
    const imgZip2 = await JSZip.loadAsync(fs.readFileSync(imgDocx))
    const imgXml2 = await imgZip2.file('word/document.xml').async('string')
    const imgMedia2 = imgZip2.file(/^word\/media\//) || []
    check('append 追加图片', imgMedia2.length === 2 && imgXml2.includes('<w:drawing'))
    check('追加图片注册关系', (await imgZip2.file('word/_rels/document.xml.rels').async('string')).includes('image2'))

    // 论文要素：页眉 / 页脚页码 / 自动目录
    const paper = path.join(dir, '论文.docx')
    await createDocx(paper, { title: '研究', header: '测试页眉', pageNumbers: true, toc: true, paragraphs: ['# 第一章', '内容', '## 1.1 小节', '更多'] })
    const paperZip = await JSZip.loadAsync(fs.readFileSync(paper))
    const paperXml = await paperZip.file('word/document.xml').async('string')
    check('自动目录字段写入', paperXml.includes('TOC'))
    check('目录后分页', paperXml.includes('<w:br w:type="page"/>'))
    const headerFiles = paperZip.file(/^word\/header\d\.xml/) || []
    const footerFiles = paperZip.file(/^word\/footer\d\.xml/) || []
    const headerText = headerFiles.length ? await headerFiles[0].async('string') : ''
    const footerText = footerFiles.length ? await footerFiles[0].async('string') : ''
    check('页眉写入', headerText.includes('测试页眉'))
    check('页脚页码字段', footerText.includes('PAGE'))
    const settingsFile = paperZip.file('word/settings.xml')
    const settingsXml = settingsFile ? await settingsFile.async('string') : ''
    check('打开时提示更新目录(updateFields)', settingsXml.includes('updateFields'))

    // Excel 合并单元格 + 多工作表 + 公式
    const advXlsx = path.join(dir, '进阶表格.xlsx')
    await createXlsx(advXlsx, {
      headers: ['月份', '销售额', '备注'], rows: [['一月', 100, ''], ['二月', 200, ''], ['合计', '=SUM(B2:B3)', '']]
    })
    let adv = await readXlsx(advXlsx)
    check('公式单元格读回原文', adv[3] && adv[3][1] === '=SUM(B2:B3)')
    await modifyXlsxCell(advXlsx, 'C4', '=B2&B3')
    adv = await readXlsx(advXlsx)
    check('modify_table 写公式', adv[3][2] === '=B2&B3')

    const multiXlsx = path.join(dir, '多工作表.xlsx')
    const rMulti = await tools.execute('create_table', {
      path: multiXlsx,
      sheets: {
        '汇总': '| 部门 | 人数 |\n|---|---|\n| 研发 | 30 |\n| 市场 | 12 |',
        '明细': { headers: ['姓名', '部门'], rows: [['张三', '研发']] }
      }
    })
    check('多工作表创建', rMulti.ok, rMulti.message)
    const sumTable = rMulti.ok ? await readXlsx(multiXlsx, '汇总') : []
    const detTable = rMulti.ok ? await readXlsx(multiXlsx, '明细') : []
    check('汇总表读取', sumTable[0][0] === '部门' && sumTable[1][1] === '30')
    check('明细表读取', detTable[0][0] === '姓名' && detTable[1][0] === '张三')
    const rMiss = rMulti.ok ? await tools.execute('read_table', { path: multiXlsx, sheet: '不存在' }) : { ok: false }
    check('不存在的工作表明确报错', !rMiss.ok && rMiss.message.includes('现有'))

    // 合并单元格：创建 → 读回 → 美化后保留
    const ExcelJS = require('exceljs')
    const mergeXlsx = path.join(dir, '合并单元格.xlsx')
    await createXlsx(mergeXlsx, { headers: ['组名', '成员', '得分'], rows: [['甲组', '张三', 90], ['', '李四', 85]], merges: ['A2:A3'] })
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(mergeXlsx)
      check('合并单元格写入', (wb.worksheets[0].model.merges || []).includes('A2:A3'))
    }
    await formatXlsx(mergeXlsx)
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(mergeXlsx)
      check('美化后合并保留', (wb.worksheets[0].model.merges || []).includes('A2:A3'))
    }
    const mergedTable = await readXlsx(mergeXlsx)
    check('合并表数据完整', mergedTable[1][0] === '甲组' && mergedTable[2][1] === '李四')

    // ===== v2.1 排版标准件：字体族 / 行距 / 首行缩进 / 封面 =====
    const thesis = path.join(dir, '标准论文.docx')
    await createDocx(thesis, {
      title: '标准论文',
      fonts: { heading: '黑体', body: '仿宋', western: 'Times New Roman' },
      lineSpacing: 1.5,
      firstLine: true,
      cover: { title: '基于测试的研究', subtitle: '——冒烟分册', org: '测试大学', author: '张三', date: '2026年9月' },
      toc: true,
      paragraphs: ['# 第一章', '正文段落要有首行缩进，English words 用西文字体。']
    })
    const thesisZip = await JSZip.loadAsync(fs.readFileSync(thesis))
    const thesisXml = await thesisZip.file('word/document.xml').async('string')
    const thesisStyles = await thesisZip.file('word/styles.xml').async('string')
    check('字体族：正文仿宋+西文Times', thesisXml.includes('w:eastAsia="仿宋"') && thesisXml.includes('ascii="Times New Roman"'))
    check('字体族：标题黑体', thesisXml.includes('w:eastAsia="黑体"'))
    check('行距 1.5 写入默认样式', thesisStyles.includes('w:line="360"'))
    check('正文首行缩进2字符', thesisXml.includes('w:firstLine="480"'))
    const thesisText = await readDocxText(thesis)
    check('封面页内容齐全', thesisText.includes('基于测试的研究') && thesisText.includes('——冒烟分册') && thesisText.includes('测试大学') && thesisText.includes('张三') && thesisText.includes('2026年9月'))

    // Word 内插表格：content 里 markdown 表格 → w:tbl（表头底色）+ append 也支持
    const tblDocx = path.join(dir, '文档内表格.docx')
    await createDocx(tblDocx, {
      title: '含表文档',
      paragraphs: ['# 数据章节', '| 月份 | 销量 |\n|---|---|\n| 一月 | 100 |\n| 二月 | 200 |', '表后正文']
    })
    const tblZip = await JSZip.loadAsync(fs.readFileSync(tblDocx))
    const tblXml = await tblZip.file('word/document.xml').async('string')
    check('markdown 表格转 w:tbl', tblXml.includes('<w:tbl>') && tblXml.includes('月份') && tblXml.includes('二月'))
    check('文档内表格表头底色(modern默认)', tblXml.includes('w:fill="2E5E8C"'))
    check('表格后正文保留', tblXml.includes('表后正文'))
    await modifyDocx(tblDocx, { paragraphs: ['| 追加列 | 值 |\n|---|---|\n| 甲 | 1 |'] }, 'append')
    const tblXml2 = await (await JSZip.loadAsync(fs.readFileSync(tblDocx))).file('word/document.xml').async('string')
    check('append 追加文档内表格', (tblXml2.match(/<w:tbl>/g) || []).length === 2 && tblXml2.includes('追加列'))

    // Excel 范围样式：加粗/底色/数字格式/对齐
    const styledXlsx = path.join(dir, '范围样式.xlsx')
    const rStyled = await tools.execute('create_table', {
      path: styledXlsx,
      headers: ['项目', '比率', '金额'],
      rows: [['甲', 0.256, 1234.5], ['乙', 0.5, 88]],
      styles: [
        { range: 'B2:B3', numFmt: '0.0%', align: 'center' },
        { range: 'C2:C3', numFmt: '#,##0.00', bold: true, bg: 'FFF2CC' },
        { range: 'A2:A3', font: '楷体', color: 'CC0000' }
      ]
    })
    check('create_table 带 styles 创建', rStyled.ok, rStyled.message)
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(styledXlsx)
      const ws = wb.worksheets[0]
      check('样式：numFmt+对齐', ws.getCell('B2').numFmt === '0.0%' && ws.getCell('B2').alignment.horizontal === 'center')
      check('样式：加粗+底色+千分位', ws.getCell('C2').font.bold === true && ws.getCell('C2').numFmt === '#,##0.00' && ws.getCell('C2').fill.fgColor.argb === 'FFFFF2CC')
      check('样式：字体+字色', ws.getCell('A2').font.name === '楷体' && ws.getCell('A2').font.color.argb === 'FFCC0000')
    }
    // 多工作表时 styles 指定 sheet
    const styledMulti = path.join(dir, '多表样式.xlsx')
    await tools.execute('create_table', {
      path: styledMulti,
      sheets: { '汇总': '| 部门 | 合计 |\n|---|---|\n| 研发 | 30 |', '明细': '| 姓名 | 工时 |\n|---|---|\n| 张三 | 160 |' },
      styles: [{ sheet: '明细', range: 'B2', numFmt: '0"小时"', bg: 'DDEBF7' }]
    })
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(styledMulti)
      const det = wb.getWorksheet('明细')
      check('styles 指定工作表生效', det && det.getCell('B2').numFmt.includes('小时') && det.getCell('B2').fill.fgColor.argb === 'FFDDEBF7')
    }

    // ===== v2.2 主题系统 / 行内富文本 / edit 模式 / 批量 cells =====

    // Word 主题：gov 红头公文（标题红字 + 引用浅红底）+ modern 默认行距
    const govDocx = path.join(dir, '红头公文.docx')
    await createDocx(govDocx, { title: '红头文件', theme: 'gov', paragraphs: ['# 一级标题', '正文', '> 引用一句', '| 项目 | 数量 |\n|---|---|\n| 甲 | 1 |'] })
    const govZip = await JSZip.loadAsync(fs.readFileSync(govDocx))
    const govXml = await govZip.file('word/document.xml').async('string')
    check('gov 主题标题红字', govXml.includes('w:color w:val="C00000"'))
    check('gov 主题引用浅红底', govXml.includes('w:fill="FDF3F3"'))
    check('gov 主题表格红棕表头', govXml.includes('w:fill="F2DCDB"'))
    const modDocx = path.join(dir, '现代主题.docx')
    await createDocx(modDocx, { title: '现代', paragraphs: ['正文'] })
    const modStyles = await (await JSZip.loadAsync(fs.readFileSync(modDocx))).file('word/styles.xml').async('string')
    check('modern 默认行距 1.15', modStyles.includes('w:line="276"'))

    // 行内富文本：下划线/删除线/高亮/代码
    const richDocx = path.join(dir, '行内富文本.docx')
    await createDocx(richDocx, { title: '行内', paragraphs: ['有 __下划线__ 有 ~~删除线~~ 有 ==高亮== 有 `代码`'] })
    const richXml2 = await (await JSZip.loadAsync(fs.readFileSync(richDocx))).file('word/document.xml').async('string')
    check('下划线生成 w:u', richXml2.includes('<w:u '))
    check('删除线生成 w:strike', richXml2.includes('<w:strike/>'))
    check('高亮生成 highlight', richXml2.includes('w:val="yellow"'))
    check('代码用 Consolas', richXml2.includes('Consolas'))

    // 段落级覆盖：右对齐 + runs 直传
    const ovDocx = path.join(dir, '段落覆盖.docx')
    await createDocx(ovDocx, { title: '覆盖', paragraphs: [
      { text: '右对齐红字', align: 'right', color: 'FF0000' },
      { runs: [{ text: '直传红粗', bold: true, color: 'CC0000' }, { text: '和普通' }] }
    ] })
    const ovXml = await (await JSZip.loadAsync(fs.readFileSync(ovDocx))).file('word/document.xml').async('string')
    check('段落级右对齐+颜色', ovXml.includes('w:jc w:val="right"') && ovXml.includes('w:color w:val="FF0000"'))
    check('runs 直传生效', ovXml.includes('直传红粗') && ovXml.includes('w:color w:val="CC0000"'))

    // Word edit 模式：同 run / 跨 run（加粗拆 run 的句子）/ 找不到
    const editDocx = path.join(dir, '编辑.docx')
    await createDocx(editDocx, { title: '编辑测试', paragraphs: ['原始句子保持不动', '价格是**一百二十**元整'] })
    const rEdit1 = await modifyDocx(editDocx, { replacements: [{ find: '原始句子', replace: '改过的句子' }] }, 'edit')
    check('edit 同 run 替换计数', rEdit1.replaced === 1 && rEdit1.missed.length === 0)
    const editTxt1 = await readDocxText(editDocx)
    check('edit 同 run 内容生效', editTxt1.includes('改过的句子') && editTxt1.includes('保持不动'))
    const rEdit2 = await modifyDocx(editDocx, { replacements: [{ find: '是一百二十元', replace: '是三百元' }] }, 'edit')
    const editTxt2 = await readDocxText(editDocx)
    check('edit 跨 run(加粗)替换', rEdit2.replaced === 1 && editTxt2.includes('是三百元整'), JSON.stringify(rEdit2))
    const rEdit3 = await modifyDocx(editDocx, { replacements: [{ find: '不存在的文字', replace: 'x' }] }, 'edit')
    check('edit 找不到报 missed', rEdit3.replaced === 0 && rEdit3.missed.length === 1)

    // Excel 主题：modern 表头深蓝白字 + 斑马纹
    const themeXlsx = path.join(dir, '主题表格.xlsx')
    await createXlsx(themeXlsx, { headers: ['品名', '数量'], rows: [['甲', 1], ['乙', 2], ['丙', 3]] })
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(themeXlsx)
      const ws = wb.worksheets[0]
      check('xlsx modern 表头深蓝白字', ws.getCell('A1').fill.fgColor.argb === 'FF2E5E8C' && ws.getCell('A1').font.color.argb === 'FFFFFFFF')
      check('xlsx modern 斑马纹(第2行数据)', ws.getCell('A3').fill.fgColor.argb === 'FFF4F8FC' && !(ws.getCell('A2').fill && ws.getCell('A2').fill.fgColor))
    }
    // tools 层：create_table theme:gov
    const govXlsx = path.join(dir, '公文表格.xlsx')
    const rGov = await tools.execute('create_table', { path: govXlsx, content: '| 项目 | 金额 |\n|---|---|\n| 甲 | 10 |\n| 乙 | 20 |', theme: 'gov' })
    check('create_table theme:gov', rGov.ok, rGov.message)
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(govXlsx)
      check('xlsx gov 表头红棕', rGov.ok && wb.worksheets[0].getCell('A1').fill.fgColor.argb === 'FFF2DCDB')
    }

    // 批量 cells：对象 + 数组两种传法
    const rBatch1 = await tools.execute('modify_table', { path: themeXlsx, cells: { B2: 99, C4: '=B2*2' } })
    check('modify_table cells 批量(对象)', rBatch1.ok, rBatch1.message)
    const rBatch2 = await tools.execute('modify_table', { path: themeXlsx, cells: [{ cell: 'A2', value: '批量甲' }, { cell: 'B3', value: 55 }] })
    check('modify_table cells 批量(数组)', rBatch2.ok, rBatch2.message)
    const batchTable = rBatch1.ok && rBatch2.ok ? await readXlsx(themeXlsx) : []
    check('批量修改结果读取', batchTable[1][0] === '批量甲' && batchTable[1][1] === '99' && batchTable[2][1] === '55' && batchTable[3][2] === '=B2*2')
    const rBatchBad = await tools.execute('modify_table', { path: themeXlsx, cells: { '2B': 'x' } })
    check('批量错误引用明确报错', !rBatchBad.ok && rBatchBad.message.includes('引用格式'), rBatchBad.message)
    // office.js 直调批量
    await modifyXlsxCells(themeXlsx, { A4: '直调丁' })
    check('modifyXlsxCells 直调', (await readXlsx(themeXlsx))[3][0] === '直调丁')

    // format_table 带 theme
    const fmtXlsx = path.join(dir, '美化主题.xlsx')
    await tools.execute('create_table', { path: fmtXlsx, headers: ['a'], rows: [[1]] })
    const rFmt = await tools.execute('format_table', { path: fmtXlsx, theme: 'classic' })
    check('format_table theme:classic', rFmt.ok, rFmt.message)
    {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.readFile(fmtXlsx)
      check('美化 classic 表头浅蓝', rFmt.ok && wb.worksheets[0].getCell('A1').fill.fgColor.argb === 'FFD9E2F3')
    }

    console.log(pass ? '\n✅ office.js 冒烟测试全部通过' : '\n❌ 有失败项')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  process.exitCode = pass ? 0 : 1
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
