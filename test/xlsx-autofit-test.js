// xlsx 列宽自适应探针：真跑 createXlsx → 读回验证 列宽/wrap/行高（治"单元格太小显示不全"）
const fs = require('fs')
const path = require('path')
const os = require('os')
const assert = require('assert')
const ExcelJS = require('exceljs')
const { createXlsx, formatXlsx, modifyXlsxCell } = require('../ai/office')

;(async () => {
  let pass = 0, fail = 0
  const ok = (cond, name) => { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msxlsx-'))
  const f = path.join(dir, 't.xlsx')

  // ① 创建：长中文备注（超宽应 wrap）+ 正常列 + 合并大标题（不撑爆 A 列）+ 显式换行格
  const longText = '这是一段特别长的备注内容，用于验证列宽自适应与自动换行行高估算是否生效，反复重复一遍以超过列宽上限触发换行机制，反复重复一遍以超过列宽上限触发换行机制。'
  await createXlsx(f, {
    headers: ['序号', '名称', '备注'],
    rows: [
      [1, '甘孜日报周报', longText],
      [2, '建设管理档案', '短备注'],
      [3, '多行格', '第一行\n第二行\n第三行']
    ],
    merges: ['A5:F5'],
    statusMap: {},
    theme: 'modern'
  })
  // 给 merge 标题格填内容再触发一次 format 重建（formatXlsx 走同一 autoFit）
  const wb0 = new ExcelJS.Workbook(); await wb0.xlsx.readFile(f)
  const ws0 = wb0.worksheets[0]
  ws0.getCell('A5').value = '大标题：这是一个横跨六列的合并标题格，内容很长很长很长，用来验证合并格按跨列分摊宽度而不是把 A 列撑到爆'
  await wb0.xlsx.writeFile(f)
  await formatXlsx(f, { theme: 'modern' })

  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f)
  const ws = wb.worksheets[0]
  const colW = (i) => ws.getColumn(i).width || 0

  ok(colW(1) >= 6 && colW(1) < 30, `A 列未被合并标题撑爆（宽 ${colW(1).toFixed(1)}）`)
  ok(colW(3) > 20, `长文本列给足宽度（备注列宽 ${colW(3).toFixed(1)}）`)
  const noteCell = ws.getCell('C2')
  ok(noteCell.alignment && noteCell.alignment.wrapText === true, '长文本格自动 wrapText')
  ok(Number(ws.getRow(2).height) > 18, `长文本行高已撑开（${Number(ws.getRow(2).height).toFixed(1)}pt）`)
  ok(Number(ws.getRow(4).height) > 40, `显式换行行高按 3 行估算（${Number(ws.getRow(4).height).toFixed(1)}pt）`)
  ok(colW(2) >= 10 && colW(2) < 30, `正常中文列宽合理（名称列 ${colW(2).toFixed(1)}）`)

  // ② modify 改成长文本后自适应跟上
  await modifyXlsxCell(f, 'B3', '这个格子被改成了很长很长很长很长很长很长很长很长很长很长的内容需要换行显示')
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.readFile(f)
  const ws2 = wb2.worksheets[0]
  const b3 = ws2.getCell('B3')
  ok((b3.alignment || {}).wrapText === true || colW(2) > 30, 'modify 改长文本后 wrap/列宽跟上')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`[xlsx-autofit] ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('[xlsx-autofit] 探针炸了:', e.message); process.exit(1) })
