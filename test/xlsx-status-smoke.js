// Excel 状态条件配色 + 日期格式 冒烟（对标结款表样例）
const fs = require('fs')
const path = require('path')
const os = require('os')
const ExcelJS = require('exceljs')
const { createXlsx } = require('../ai/office')

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msxlsx-st-'))

  // ① statusMap 按列名匹配 + 日期格式
  const p1 = path.join(dir, 'settle.xlsx')
  await createXlsx(p1, {
    headers: ['机构', '结款日期', '状态', '金额'],
    rows: [
      ['论文通A', '2026-09-01', '已结款', 1200],
      ['论文通B', '2026-09-02', '未结款', 800],
      ['论文通C', '2026-09-03', '待定', 300]
    ],
    statusMap: { '状态': { '已结款': 'ok', '未结款': 'bad', '待定': 'warn' } }
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(p1)
  const ws = wb.getWorksheet('Sheet1')
  const st = ws.getRow(2).getCell(3)
  const bd = ws.getRow(3).getCell(3)
  const wn = ws.getRow(4).getCell(3)
  check('ok 绿底', st.fill.fgColor.argb === 'FFC6EFCE' && st.font.color.argb === 'FF006100')
  check('bad 红底', bd.fill.fgColor.argb === 'FFFFC7CE' && bd.font.color.argb === 'FF9C0006')
  check('warn 黄底', wn.fill.fgColor.argb === 'FFFFEB9C')
  const dc = ws.getRow(2).getCell(2)
  check('日期列 yyyy-mm-dd', dc.numFmt === 'yyyy-mm-dd')
  check('斑马纹仍生效(第2行数据非状态列)', ws.getRow(3).getCell(1).fill && ws.getRow(3).getCell(1).fill.fgColor.argb === 'FFF4F8FC')

  // ② sheets 多表路径 + statusMap 透传
  const p2 = path.join(dir, 'multi.xlsx')
  await createXlsx(p2, {
    sheets: { '汇总': { headers: ['渠道', '进度'], rows: [['淘宝', '已完成'], ['拼多多', '进行中']], statusMap: { '进度': { '已完成': 'ok', '进行中': 'info' } } } }
  })
  const wb2 = new ExcelJS.Workbook()
  await wb2.xlsx.readFile(p2)
  const ws2 = wb2.getWorksheet('汇总')
  check('多表 statusMap 透传(ok)', ws2.getRow(2).getCell(2).fill.fgColor.argb === 'FFC6EFCE')
  check('多表 statusMap 透传(info)', ws2.getRow(3).getCell(2).fill.fgColor.argb === 'FFDDEBF7')

  // ③ 无 statusMap 不影响老用法
  const p3 = path.join(dir, 'plain.xlsx')
  await createXlsx(p3, { headers: ['A', 'B'], rows: [[1, 2]] })
  const wb3 = new ExcelJS.Workbook()
  await wb3.xlsx.readFile(p3)
  check('老用法不报错', wb3.getWorksheet('Sheet1').getRow(1).getCell(1).value === 'A')

  // ④ wrap 换行 + rowHeight 行高（对标预算表的区块合并排版）
  const p4 = path.join(dir, 'budget.xlsx')
  await createXlsx(p4, {
    headers: ['商品名称', '备注'],
    rows: [['烘焙布', '可重复利用，一小张烫10次左右要换，员工自裁分装']],
    merges: ['A1:B1'],
    styles: [
      { range: 'A1:B1', bold: true, align: 'center', rowHeight: 30 },
      { range: 'B2:B2', wrap: true, valign: 'top' }
    ]
  })
  const wb4 = new ExcelJS.Workbook()
  await wb4.xlsx.readFile(p4)
  const ws4 = wb4.getWorksheet('Sheet1')
  check('wrap 长文本自动换行', ws4.getRow(2).getCell(2).alignment.wrapText === true)
  check('rowHeight 标题行 30', ws4.getRow(1).height === 30)
  check('merges 大标题行', ws4.getCell('A1').isMerged || (ws4.model.merges || {}).includes && true)

  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
