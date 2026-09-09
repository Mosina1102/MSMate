// 生成一份模拟论文结构的 docx（标题层级+表格+分页），用于真机 CDP 诊断
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, PageBreak, AlignmentType } = require('docx')
const fs = require('fs')
const path = require('path')

const doc = new Document({
  styles: {
    default: {
      heading1: { run: { size: 32, bold: true, color: '1F4E79', font: '微软雅黑' } },
      heading2: { run: { size: 28, bold: true, color: '2E74B5', font: '微软雅黑' } }
    }
  },
  sections: [{
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '《诊断用例》高保真渲染验证', bold: true, size: 44 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'MSMate 自动生成 · 2026/9/6', color: '888888' })] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('一、背景设定')] }),
      new Paragraph({ children: [new TextRun('这一段是正文，用于验证字体、字号与行距是否保留。'), new TextRun({ text: '这里附带红色强调文字。', color: 'C00000', bold: true })] }),
      new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('1.1 核心世界观')] }),
      new Paragraph({ children: [new TextRun('二级标题下的正文段落。')] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('二、人物深度剖析')] }),
      new Table({
        rows: [
          new TableRow({ children: [new TableCell({ children: [new Paragraph('角色')] }), new TableCell({ children: [new Paragraph('能力')] }), new TableCell({ children: [new Paragraph('代价')] })] }),
          new TableRow({ children: [new TableCell({ children: [new Paragraph('示例A')] }), new TableCell({ children: [new Paragraph('示例B')] }), new TableCell({ children: [new Paragraph('示例C')] })] })
        ]
      }),
      new Paragraph({ children: [new PageBreak(), new TextRun('第二页的内容，验证分页。')] })
    ]
  }]
})

const out = path.join(process.env.USERPROFILE, 'Desktop', 'MSMate诊断-高保真验证.docx')
Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(out, buf); console.log('OK ' + out + ' ' + buf.length + 'B') })
