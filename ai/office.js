// ============================================
// MSWork Office 引擎 v2：完整排版能力
// - Word：docx 引擎（标题层级/行内加粗/引用/列表/图片嵌入/页眉页脚页码/自动目录）
// - Excel：exceljs 引擎（多 sheet/合并单元格/公式/表头样式/自动列宽/冻结首行/边框）
// 读取端：Word 文本沿用 JSZip 轻解析；Excel 读写统一 exceljs
// ============================================
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  ImageRun, Header, Footer, PageNumber, TableOfContents, PageBreak,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType
} = require('docx')
const ExcelJS = require('exceljs')

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// ===== 共享：markdown 结构化解析 =====

// 段落结构样式（颜色由主题决定，不再写死）
const PARA_STYLES = {
  title:   { bold: true, size: 40 },
  h1:      { bold: true, size: 32 },
  h2:      { bold: true, size: 28 },
  h3:      { bold: true, size: 24 },
  bold:    { bold: true, size: 24 },
  center:  { size: 24, align: 'center' },
  quote:   { size: 24, indent: 420 },
  normal:  { size: 24 },
  callout: { size: 24 },
  divider: { size: 24 },
  image:   { size: 24, align: 'center' }
}

// 标题间距节奏（twips）：标题前留大空隙做分区、后留小空隙贴正文（参考成熟文档排版：h1 前 18pt / h2 前 13pt / h3 前 10pt）
const HEADING_SPACING = {
  title: { before: 0, after: 240 },
  h1: { before: 360, after: 160 },
  h2: { before: 260, after: 130 },
  h3: { before: 200, after: 110 }
}

// callout 信息卡四色调色板：{bg 卡片底, bar 左竖线, text 文字色}
const CALLOUT_TONES = {
  info:   { bg: 'EFF4F9', bar: '3E7CB5', text: '2E5E8C' },
  ok:     { bg: 'EFF7EF', bar: '4C9A63', text: '2F6B3F' },
  warm:   { bg: 'FDF4E7', bar: 'D98E2B', text: '8A5A14' },
  danger: { bg: 'FBEDED', bar: 'C7545E', text: '8F3039' }
}

// ===== 主题系统：一套结构 × 三套视觉 =====
// modern=现代风(新默认，摆脱"Word 默认蓝") / classic=旧版公文蓝 / gov=红头公文风
const THEMES = {
  modern: {
    fonts: { heading: '微软雅黑', body: '等线', western: 'Segoe UI' },
    titleColor: '1F3350', h1Color: '2E5E8C', h2Color: '3E7CB5', h3Color: '4A89BC',
    bodyColor: '333333',
    quoteColor: '44546A', quoteItalic: false, quoteBg: 'EFF4F9', quoteBar: '3E7CB5',
    tableHeadFill: '2E5E8C', tableHeadColor: 'FFFFFF', zebra: 'F4F8FC', borderColor: 'C9D4E0',
    headerLineColor: 'C9D4E0', lineSpacing: 1.15
  },
  classic: {
    fonts: { heading: '黑体', body: '宋体', western: 'Times New Roman' },
    titleColor: null, h1Color: '2F5496', h2Color: '2F5496', h3Color: '1F3864',
    bodyColor: null,
    quoteColor: '595959', quoteItalic: true, quoteBg: null, quoteBar: null,
    tableHeadFill: 'D9E2F3', tableHeadColor: '1F2328', zebra: null, borderColor: 'B0B7C3',
    headerLineColor: null, lineSpacing: null
  },
  gov: {
    fonts: { heading: '黑体', body: '仿宋', western: 'Times New Roman' },
    titleColor: 'C00000', h1Color: '000000', h2Color: '333333', h3Color: '333333',
    bodyColor: null,
    quoteColor: '595959', quoteItalic: false, quoteBg: 'FDF3F3', quoteBar: 'C00000',
    tableHeadFill: 'F2DCDB', tableHeadColor: '000000', zebra: null, borderColor: 'D9A9A9',
    headerLineColor: 'C00000', lineSpacing: null
  }
}
const FONTS_DEFAULT = THEMES.modern.fonts

function normTheme(t) {
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const base = THEMES[String(t.base || '').trim().toLowerCase()] || THEMES.modern
    const out = { ...base }
    // 键级覆盖：允许只换个别色
    for (const k of ['titleColor', 'h1Color', 'h2Color', 'h3Color', 'bodyColor', 'quoteColor', 'quoteBg', 'quoteBar', 'tableHeadFill', 'tableHeadColor', 'zebra', 'borderColor', 'headerLineColor']) {
      if (typeof t[k] === 'string' && /^[0-9A-Fa-f]{6}$/.test(t[k])) out[k] = t[k].toUpperCase()
    }
    // accent 一键换装：强调色派生到标题/引用条/表头/页眉线（真机场景：策划书要品牌橙而不是默认蓝）
    if (typeof t.accent === 'string' && /^[0-9A-Fa-f]{6}$/.test(t.accent)) {
      const a = t.accent.toUpperCase()
      out.h1Color = a
      out.h2Color = a
      out.h3Color = a
      out.quoteBar = a
      out.tableHeadFill = a
      out.tableHeadColor = 'FFFFFF'
      out.headerLineColor = a
    }
    return out
  }
  return THEMES[String(t || '').trim().toLowerCase()] || THEMES.modern
}

// 段落样式的主题色映射
function styleColor(style, theme) {
  switch (style) {
    case 'title': return theme.titleColor
    case 'h1': return theme.h1Color
    case 'h2': return theme.h2Color
    case 'h3': return theme.h3Color
    case 'quote': return theme.quoteColor
    default: return theme.bodyColor
  }
}

const HEADING_STYLES = new Set(['title', 'h1', 'h2', 'h3'])

function normFonts(f, defaults = FONTS_DEFAULT) {
  const out = { ...defaults }
  if (f && typeof f === 'object') {
    if (f.heading) out.heading = String(f.heading)
    if (f.body) out.body = String(f.body)
    if (f.western) out.western = String(f.western)
  }
  return out
}

// 行内 markdown：**加粗** *斜体* __下划线__ ~~删除线~~ ==高亮== `代码` 拆 runs
const INLINE_TOKEN_RE = /(\*\*[^*]+\*\*|\*[^*]+?\*|__[^_]+__|~~[^~]+~~|==[^=]+==|`[^`]+`)/g
function inlineRuns(text, base = {}) {
  const runs = []
  for (const part of String(text).split(INLINE_TOKEN_RE)) {
    if (!part) continue
    const r = { text: part, bold: !!base.bold, italic: !!base.italic, underline: !!base.underline, strike: !!base.strike, size: base.size, color: base.color, font: base.font, highlight: base.highlight }
    if (/^\*\*[^*]+\*\*$/.test(part)) { r.text = part.slice(2, -2); r.bold = true }
    else if (/^\*[^*]+\*$/.test(part)) { r.text = part.slice(1, -1); r.italic = true }
    else if (/^__[^_]+__$/.test(part)) { r.text = part.slice(2, -2); r.underline = true }
    else if (/^~~[^~]+~~$/.test(part)) { r.text = part.slice(2, -2); r.strike = true }
    else if (/^==[^=]+==$/.test(part)) { r.text = part.slice(2, -2); r.highlight = r.highlight || 'yellow' }
    else if (/^`[^`]+`$/.test(part)) { r.text = part.slice(1, -1); r.font = 'Consolas'; r.color = r.color || 'C7254E'; r.highlight = r.highlight || 'lightGray' }
    runs.push(r)
  }
  return runs.length ? runs : [{ text: '', bold: !!base.bold, size: base.size, color: base.color }]
}

// markdown 表格行解析：| a | b | → [cells]；分隔行 |---|---| / |:-:|:-:| 返回 null（AI 常写单横线/冒号变体）
function parseTableRow(s) {
  const cells = s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  if (cells.length && cells.every((c) => c === '' || /^:?-+:?$/.test(c))) return null
  return cells
}

// 段落统一化：支持 "## 标题" 简写、字符串、{text, style} 对象、![alt](图片路径)、markdown 表格块
function normParagraphs(paras) {
  if (typeof paras === 'string') paras = paras.split(/\r?\n/)
  // 数组元素里也可能有含换行的多行字符串（整块 markdown 表格等），统一按行拆开
  paras = (Array.isArray(paras) ? paras : []).flatMap((p) => (typeof p === 'string' ? p.split(/\r?\n/) : [p]))
  const out = []
  let tblBuf = null // 累积连续的 |...| 行
  const flushTbl = () => {
    if (tblBuf && tblBuf.rows.length) out.push({ style: 'table', rows: tblBuf.rows })
    tblBuf = null
  }
  for (const p of Array.isArray(paras) ? paras : []) {
    if (p == null) { flushTbl(); continue }
    if (typeof p === 'object' && !Array.isArray(p)) {
      flushTbl()
      // table/image 对象段由 mdParaToDocx 专管（style 不在 PARA_STYLES 且无 text），直传不降级——否则被空段丢弃逻辑吞掉
      if (p.style === 'table' || p.style === 'image') { out.push(p); continue }
      const style = PARA_STYLES[p.style] ? p.style : 'normal'
      const text = String(p.text ?? '').trim()
      // 保留段落级覆盖字段（align/color/size/bold/italic/font/runs），text 为空但有 runs 直传时也保留；divider 空段无文字也要保留
      if (text || (Array.isArray(p.runs) && p.runs.length) || style === 'divider') out.push({ ...p, text, style })
      continue
    }
    const s = String(p)
    if (/^\s*\|.*\|?\s*$/.test(s) && s.includes('|')) {
      const row = parseTableRow(s)
      if (!tblBuf) tblBuf = { rows: [] }
      if (row) tblBuf.rows.push(row)
      continue
    }
    flushTbl()
    if (!s.trim()) continue
    const img = s.trim().match(/^!\[([^\]]*)\]\(([^)]+?)\)(?:\s*\{([^}]*)\})?\s*$/)
    if (img) {
      const node = { style: 'image', image: img[2].trim(), alt: img[1].trim() }
      // 后缀参数：![注](路径) {width:400} 或 {width:400, align:left}
      if (img[3]) {
        const wm = img[3].match(/width\s*[:=]\s*(\d+)/i)
        if (wm) node.width = Number(wm[1])
        const am = img[3].match(/align\s*[:=]\s*(left|center|right)/i)
        if (am) node.align = am[1].toLowerCase()
      }
      // 路径尾部 =400 简写：![注](C:\a.png =400)
      const sm = node.image.match(/\s[=]\s*(\d+)\s*$/)
      if (sm) { node.width = Number(sm[1]); node.image = node.image.slice(0, sm.index).trim() }
      out.push(node)
      continue
    }
    if (s.startsWith('# ')) out.push({ text: s.slice(2).trim(), style: 'h1' })
    else if (s.startsWith('## ')) out.push({ text: s.slice(3).trim(), style: 'h2' })
    else if (/^#{3,5} /.test(s)) out.push({ text: s.replace(/^#{3,5} /, '').trim(), style: 'h3' })
    else if (s.startsWith('> ')) out.push({ text: s.slice(2).trim(), style: 'quote' })
    else if (/^\*\*[^*]+\*\*$/.test(s.trim())) out.push({ text: s.trim().replace(/^\*\*|\*\*$/g, ''), style: 'bold' })
    // 分隔线（v2.4.94）：--- 或 *** → 细底边框空段，章节间轻分区
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(s)) out.push({ style: 'divider' })
    else if (/^[-*] /.test(s)) out.push({ text: '• ' + s.slice(2).trim(), style: 'normal' })
    else out.push({ text: s.trim(), style: 'normal' })
  }
  flushTbl()
  return out
}

// ===== 图片尺寸探测（png/jpg/gif/bmp，够用即可）=====
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    if (buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d) return { type: 'bmp', width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue }
        const marker = buf[off + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { type: 'jpg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        }
        off += 2 + buf.readUInt16BE(off + 2)
      }
    }
  } catch {}
  return null
}

// 读取图片 → {buffer, type, width, height}；sizeHint 可传宽度像素（等比缩放）；失败返回 null
function loadImage(imgPath, maxW = 560, maxH = 620, sizeHint = null) {
  try {
    const p = imgPath.replace(/^file:\/\/\//, '').replace(/^"|"$/g, '').replace(/^<|>$/g, '').trim()
    const buf = fs.readFileSync(p)
    const info = imageSize(buf)
    if (!info || !info.width || !info.height) return null
    let { width, height } = info
    if (sizeHint && Number(sizeHint) > 0) {
      const w = Math.max(1, Math.min(Number(sizeHint), maxW * 2))
      const s = w / width
      width = w
      height = Math.max(1, Math.round(height * s))
    } else {
      const scale = Math.min(1, maxW / width, maxH / height)
      width = Math.max(1, Math.round(width * scale))
      height = Math.max(1, Math.round(height * scale))
    }
    return { buffer: buf, type: info.type, width, height }
  } catch { return null }
}

// ===== Word 生成（docx 引擎）=====

function docxRun(r, fonts = FONTS_DEFAULT) {
  const ascii = r.font || fonts.western
  return new TextRun({
    text: r.text,
    bold: !!r.bold,
    italics: !!r.italic,
    underline: r.underline ? {} : undefined,
    strike: r.strike ? true : undefined,
    highlight: r.highlight || undefined,
    size: r.size || 24,
    color: r.color || undefined,
    // run 底纹（v2.4.94 编辑器保真：docx-preview 的 span background-color → shade 六位 HEX）
    ...(r.shade ? { shading: { type: ShadingType.CLEAR, fill: r.shade } } : {}),
    font: { ascii, hAnsi: ascii, eastAsia: r.font || r.eastAsia || fonts.body }
  })
}

// markdown 表格块 → docx Table（主题色表头 + 斑马纹 + 细边框）
function mdTableToDocx(rows, fonts, theme = THEMES.modern) {
  const cols = Math.max(...rows.map((r) => r.length))
  const bd = { style: BorderStyle.SINGLE, size: 4, color: theme.borderColor }
  const trs = rows.map((cells, ri) => new TableRow({
    tableHeader: ri === 0,
    children: Array.from({ length: cols }, (_, ci) => {
      const text = String(cells[ci] ?? '')
      const head = ri === 0
      const zebraFill = !head && theme.zebra && ri % 2 === 0 ? theme.zebra : null
      const fill = head ? theme.tableHeadFill : zebraFill
      return new TableCell({
        width: { size: Math.floor(100 / cols), type: WidthType.PERCENTAGE },
        ...(fill ? { shading: { type: ShadingType.CLEAR, fill } } : {}),
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({
          alignment: head ? AlignmentType.CENTER : undefined,
          children: inlineRuns(text, { bold: head, color: head ? theme.tableHeadColor : undefined }).map((r) => docxRun({ ...r, eastAsia: head ? fonts.heading : fonts.body }, fonts))
        })]
      })
    })
  }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: bd, bottom: bd, left: bd, right: bd, insideHorizontal: bd, insideVertical: bd },
    rows: trs
  })
}

function mdParaToDocx(p, fonts = FONTS_DEFAULT, layout = {}, theme = THEMES.modern) {
  if (p.style === 'table') return [mdTableToDocx(p.rows, fonts, theme), new Paragraph({ children: [] })]
  if (p.style === 'image') {
    const img = loadImage(p.image, 560, 620, p.width || null)
    if (!img) return [new Paragraph({ children: [docxRun({ text: `（图片缺失：${p.image}）`, italic: true, color: 'A6A6A6' }, fonts)] })]
    const alignMap = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT }
    const imgAlign = alignMap[p.align] || AlignmentType.CENTER
    const out = [new Paragraph({
      alignment: imgAlign,
      spacing: { before: 120, after: p.alt ? 40 : 160 },
      children: [new ImageRun({ data: img.buffer, type: img.type, transformation: { width: img.width, height: img.height } })]
    })]
    if (p.alt) out.push(new Paragraph({ alignment: imgAlign, spacing: { after: 160 }, children: [docxRun({ text: p.alt, size: 20, color: '808080' }, fonts)] }))
    return out
  }
  // 结构样式 + 段落级覆盖（align/color/size/bold/italic/font 都可单段改）
  const st = { ...(PARA_STYLES[p.style] || PARA_STYLES.normal) }
  if (p.align) st.align = p.align
  if (p.color) st.color = p.color
  if (p.size) st.size = Number(p.size) || st.size
  if (p.bold != null) st.bold = !!p.bold
  if (p.italic != null) st.italic = !!p.italic
  const headingMap = { h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3, title: HeadingLevel.TITLE }
  const opts = {}
  if (headingMap[p.style]) opts.heading = headingMap[p.style]
  // 标题间距节奏：前大后小做分区感（全局 lineSpacing 仍由文档默认控制）
  if (HEADING_SPACING[p.style]) opts.spacing = { ...HEADING_SPACING[p.style] }
  // 正文/引用/信息卡段后距：120twips=6pt 呼吸感，段落不再挤成一坨（标题/图片有自己的间距节奏）
  if (!HEADING_SPACING[p.style]) opts.spacing = { after: 120, line: 340, lineRule: 'auto' }
  // 分隔线：细底边框空段（章节间轻分区，比大标题更轻的节奏工具）
  if (p.style === 'divider') {
    return [new Paragraph({
      spacing: { before: 160, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: theme.quoteBar || theme.h3Color || 'C9D4E0', space: 1 } },
      children: []
    })]
  }
  // callout 信息卡：浅底色块 + 左竖线 + 深色字（tone: info/ok/warm/danger，活动规则、注意事项、关键结论用它）
  if (p.style === 'callout') {
    const tone = CALLOUT_TONES[p.tone] || CALLOUT_TONES.info
    opts.shading = { type: ShadingType.CLEAR, fill: tone.bg }
    opts.border = { left: { style: BorderStyle.SINGLE, size: 16, color: tone.bar, space: 4 } }
    st.color = p.color || tone.text
    if (p.bold == null) st.bold = true
  }
  if (!st.color) st.color = styleColor(p.style, theme)
  if (st.align) opts.alignment = AlignmentType[String(st.align).toUpperCase()] || AlignmentType.CENTER
  if (st.indent) opts.indent = { left: st.indent }
  // 首行缩进（公文/论文正文标准）：normal 段落按 2 字符缩进
  if (layout.firstLine && p.style === 'normal') opts.indent = { ...(st.indent ? { left: st.indent } : {}), firstLine: 480 }
  // 主题引用块：modern/gov 用竖线+浅底；classic 保持旧的纯斜体灰字
  if (p.style === 'quote' && theme.quoteBar) {
    if (theme.quoteBg) opts.shading = { type: ShadingType.CLEAR, fill: theme.quoteBg }
    opts.border = { left: { style: BorderStyle.SINGLE, size: 12, color: theme.quoteBar, space: 6 } }
    st.italic = theme.quoteItalic === true
  } else if (p.style === 'quote' && theme.quoteItalic) {
    st.italic = true
  }
  const eastAsia = p.font || (HEADING_STYLES.has(p.style) ? fonts.heading : fonts.body)
  // runs 直传（每个字可指定字体/字号/颜色/加粗/斜体/下划线/删除线/高亮）；否则按行内 markdown 拆
  opts.children = p.runs
    ? p.runs.map((r) => docxRun({ ...st, ...r, eastAsia: r.font || eastAsia }, fonts))
    : inlineRuns(p.text, st).map((r) => docxRun({ ...r, eastAsia }, fonts))
  return [new Paragraph(opts)]
}

// 封面页：{ title, subtitle, org, author, date } 居中排版 + 分页
function coverParas(cover, fonts) {
  const c = cover || {}
  const line = (text, size, opts = {}) => text ? new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: opts.before || 0, after: opts.after || 200 },
    children: [docxRun({ text: String(text), bold: !!opts.bold, size, eastAsia: opts.heading ? fonts.heading : fonts.body }, fonts)]
  }) : null
  const out = []
  const t = line(c.title || '', 56, { bold: true, heading: true, before: 3600, after: 480 })
  if (t) out.push(t)
  const sub = line(c.subtitle, 32, { after: 3200 })
  if (sub) out.push(sub)
  for (const key of ['org', 'author', 'date']) {
    const p = line(c[key], 28, { after: 240 })
    if (p) out.push(p)
  }
  out.push(new Paragraph({ children: [new PageBreak()] }))
  return out
}

// 创建 Word：content = { title, paragraphs, header, footer, pageNumbers, toc, fonts, lineSpacing, firstLine, cover }
async function createDocx(filePath, content) {
  const c = content || {}
  const fonts = normFonts(c.fonts)
  const theme = normTheme(c.theme)
  const layout = { firstLine: !!c.firstLine }
  // 行距：显式指定优先，否则用主题默认行距
  const lineSpacing = Number(c.lineSpacing) > 0 ? Number(c.lineSpacing) : (theme.lineSpacing || null)
  const docSpacing = lineSpacing ? { line: Math.round(lineSpacing * 240), lineRule: 'auto' } : undefined

  const title = c.title || path.basename(filePath, '.docx')
  const children = c.cover ? coverParas(c.cover, fonts)
    : c.noTitle ? [] // 工作台所见即所得编辑已有文档：不重复插文件名标题
    : [new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [docxRun({ text: title, bold: true, size: 40, color: theme.titleColor || undefined, eastAsia: fonts.heading }, fonts)] })] // 大标题居中：docx Title 样式默认左对齐（老大实锤），文档常规是大标题居中

  if (c.toc) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 }, children: [docxRun({ text: c.tocTitle || '目  录', bold: true, size: 32, eastAsia: fonts.heading }, fonts)] }))
    children.push(new TableOfContents('目录', { hyperlink: true, headingStyleRange: c.tocLevels || '1-3' }))
    children.push(new Paragraph({ children: [new PageBreak()] }))
  }
  for (const p of normParagraphs(c.paragraphs || [])) children.push(...mdParaToDocx(p, fonts, layout, theme))

  const headers = c.header
    ? { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [docxRun({ text: String(c.header), size: 18, color: '808080' }, fonts)] })] }) }
    : undefined
  const wantFooter = c.footer || c.pageNumbers
  const footers = wantFooter
    ? {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              ...(c.footer ? [docxRun({ text: String(c.footer), size: 18, color: '808080' }, fonts)] : []),
              ...(c.footer && c.pageNumbers ? [docxRun({ text: '  —  ', size: 18, color: '808080' }, fonts)] : []),
              ...(c.pageNumbers ? [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '595959', font: { ascii: fonts.western, hAnsi: fonts.western, eastAsia: fonts.body } })] : [])
            ]
          })]
        })
      }
    : undefined

  const doc = new Document({
    features: c.toc ? { updateFields: true } : undefined,
    styles: { default: { document: { run: { font: { ascii: fonts.western, hAnsi: fonts.western, eastAsia: fonts.body }, size: 24 }, paragraph: docSpacing ? { spacing: docSpacing } : undefined } } },
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1800, bottom: 1440, left: 1800 } } },
      headers, footers,
      children
    }]
  })
  const buffer = await Packer.toBuffer(doc)
  // 目录域预填静态条目：打开即见目录（无页码），用户在 Word/WPS 里更新域（F9）后变带页码超链接版
  let finalBuf = buffer
  if (c.toc) {
    try {
      const zip = await JSZip.loadAsync(buffer)
      const docFile = zip.file('word/document.xml')
      if (docFile) {
        let xml = await docFile.async('string')
        const sepIdx = xml.indexOf('<w:fldChar w:fldCharType="separate"/>')
        const endIdx = xml.indexOf('<w:fldChar w:fldCharType="end"/>')
        if (sepIdx > 0 && endIdx > sepIdx) {
          const heads = normParagraphs(c.paragraphs || []).filter((p) => ['h1', 'h2', 'h3'].includes(p.style) && p.text)
          if (heads.length) {
            const tabs = (lv) => `<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="8296"/></w:tabs>`
            const entry = (p) => {
              const lv = p.style === 'h1' ? 0 : p.style === 'h2' ? 1 : 2
              const ind = lv * 240
              return `<w:p><w:pPr>${tabs(lv)}<w:ind w:left="${ind}"/><w:spacing w:after="60" w:line="320" w:lineRule="auto"/></w:pPr>` +
                `<w:r><w:rPr>${p.style === 'h1' ? '<w:b/>' : ''}<w:sz w:val="${p.style === 'h1' ? 24 : 21}"/></w:rPr><w:t xml:space="preserve">${escapeXml(String(p.text))}</w:t></w:r>` +
                `<w:r><w:rPr><w:sz w:val="21"/></w:rPr><w:tab/><w:t xml:space="preserve"> </w:t></w:r></w:p>`
            }
            const staticXml = heads.map(entry).join('')
            const afterSep = xml.indexOf('</w:p>', sepIdx) + 6
            xml = xml.slice(0, afterSep) + staticXml + xml.slice(afterSep)
            zip.file('word/document.xml', xml)
            finalBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
          }
        }
      }
    } catch { /* 预填失败退回纯域版，不影响文档生成 */ }
  }
  fs.writeFileSync(filePath, finalBuf)
  await validateDocx(filePath, { throwOnError: true })
  return finalBuf.length
}

// 读取 docx 的文字内容（轻量解析：段落文本 + 空行分隔）
async function readDocxText(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const doc = zip.file('word/document.xml')
  if (!doc) throw new Error('不是有效的 Word 文档（缺少 document.xml）')
  const xml = await doc.async('string')
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ===== PDF 文本提取（v2.5.68：read_pdf——AI 读不了 PDF 文件的补位）=====
// pdf-parse（纯 JS CJS，require 链过 Electron 探针）；扫描件/图片型 PDF 无文本层 → 返回空文本，
// tools 层提示用户转图片走 view_image 识图
async function readPdfText(filePath) {
  const pdfParse = require('pdf-parse')
  const data = await pdfParse(fs.readFileSync(filePath))
  return String(data.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ===== Word 批注解析（v2.5.6：read_word 自动带出导师批注，AI 改论文逐条落实）=====
// 批注内容在 word/comments.xml（w:comment w:id/w:author/w:date + 内容段）；
// 被批注的文本在 document.xml 的 commentRangeStart..commentRangeEnd 之间。
async function parseWordComments(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const cmtFile = zip.file('word/comments.xml')
  if (!cmtFile) return []
  const cxml = await cmtFile.async('string')
  const dFile = zip.file('word/document.xml')
  const dxml = dFile ? await dFile.async('string') : ''
  const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  const plain = (xml) => decode((xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim()
  const out = []
  // w:comment 自闭合（空批注）与带内容两种形态都吃
  const re = /<w:comment\s([^>]*?)\/>|<w:comment\s([^>]*?)>([\s\S]*?)<\/w:comment>/g
  let m
  while ((m = re.exec(cxml))) {
    const attrs = m[1] || m[2] || ''
    const id = (attrs.match(/w:id="([^"]+)"/) || [])[1]
    if (id == null) continue
    const author = decode((attrs.match(/w:author="([^"]*)"/) || [])[1] || '')
    const date = (attrs.match(/w:date="([^"]*)"/) || [])[1] || ''
    const text = plain(m[3] || '')
    // 锚定文本：commentRangeStart..End 之间被划选的文字（截 80 字防刷屏）
    let anchor = ''
    const am = dxml.match(new RegExp(`<w:commentRangeStart[^>]*w:id="${id}"[^>]*/>[\\s\\S]*?<w:commentRangeEnd[^>]*w:id="${id}"[^>]*/>`))
    if (am) {
      anchor = plain(am[0])
      if (anchor.length > 80) anchor = anchor.slice(0, 80) + '…'
    }
    out.push({ id, author, date, anchor, text })
  }
  return out
}

// ===== Word 追加（JSZip XML 注入：文本段落 + 图片）=====

// 旧引擎段落 XML（追加路径复用）
function runXml(text, { bold = false, italic = false, size = 24, color = null } = {}) {
  const rPr = []
  if (bold) rPr.push('<w:b/>')
  if (italic) rPr.push('<w:i/>')
  if (color) rPr.push(`<w:color w:val="${color}"/>`)
  rPr.push(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`)
  return `<w:r><w:rPr>${rPr.join('')}</w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}
function paraXml(text, opts = {}) {
  const pPr = []
  if (opts.align === 'center') pPr.push('<w:jc w:val="center"/>')
  if (opts.indent) pPr.push(`<w:ind w:left="${opts.indent}"/>`)
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''
  return `<w:p>${pPrXml}${inlineRuns(text, opts).map((r) => runXml(r.text, r)).join('')}</w:p>`
}

// 追加用的图片（重新读取拿缩放后尺寸 + buffer）
function imageDrawingXml(imgPath, sizeHint = null) {
  return loadImage(imgPath, 560, 620, sizeHint)
}
function inlineDrawingParaXml({ cx, cy }, docPrId, rId) {
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${docPrId}" name="Picture ${docPrId}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${docPrId}" name="img${docPrId}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

const IMG_CT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }

// 追加用的 markdown 表格 → w:tbl XML（modern 主题：深蓝表头白字 + 斑马纹 + 细边框）
function mdTableXml(rows) {
  const theme = THEMES.modern
  const cols = Math.max(...rows.map((r) => r.length))
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((k) => `<w:${k} w:val="single" w:sz="4" w:color="${theme.borderColor}"/>`).join('')
  const trs = rows.map((cells, ri) => {
    const head = ri === 0
    const zebraFill = !head && theme.zebra && ri % 2 === 1 ? theme.zebra : null
    const tcs = Array.from({ length: cols }, (_, ci) => {
      const fill = head ? theme.tableHeadFill : zebraFill
      const tcPr = `<w:tcPr><w:tcW w:w="0" w:type="auto"/>${fill ? `<w:shd w:val="clear" w:fill="${fill}"/>` : ''}</w:tcPr>`
      const text = String(cells[ci] ?? '')
      const runs = inlineRuns(text, { bold: head, color: head ? theme.tableHeadColor : undefined }).map((r) => runXml(r.text, { ...r, size: 21 })).join('')
      const jc = head ? '<w:jc w:val="center"/>' : ''
      return `<w:tc>${tcPr}<w:p><w:pPr>${jc}</w:pPr>${runs}</w:p></w:tc>`
    }).join('')
    return `<w:tr>${tcs}</w:tr>`
  }).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>${trs}</w:tbl>`
}

// ===== Word 精准编辑（edit 模式：find/replace）=====
// 层1：同一 w:t 内直接替换（保留全部格式）
// 层2：跨 run 匹配（如加粗把句子拆成多个 run）→ 整段重建，保留段落属性和首个文本 run 的格式
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function normReplacements(content) {
  let reps
  if (Array.isArray(content)) reps = content
  else if (content && Array.isArray(content.replacements)) reps = content.replacements
  else if (content && content.find != null) reps = [content]
  else throw new Error('edit 模式缺少 replacements：传 [{find:"旧文字", replace:"新文字", all?}]')
  const out = reps.map((r) => ({ find: String((r && r.find) ?? ''), replace: String((r && r.replace) ?? ''), all: !r || r.all !== false })).filter((r) => r.find)
  if (!out.length) throw new Error('replacements 里没有有效的 find')
  return out
}

async function editDocx(filePath, content) {
  const reps = normReplacements(content)
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const doc = zip.file('word/document.xml')
  if (!doc) throw new Error('不是有效的 Word 文档（缺少 document.xml）')
  let xml = await doc.async('string')
  let replaced = 0
  const missed = []
  for (const rep of reps) {
    let count = 0
    const findEsc = escapeXml(rep.find)
    const repEsc = escapeXml(rep.replace)
    // 层1：同一 w:t 节点内替换
    xml = xml.replace(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g, (m, open, txt, close) => {
      if (!txt.includes(findEsc)) return m
      count += rep.all ? txt.split(findEsc).length - 1 : 1
      return open + (rep.all ? txt.split(findEsc).join(repEsc) : txt.replace(findEsc, repEsc)) + close
    })
    // 层2：跨 run 匹配 → 整段重建
    if (count === 0) {
      xml = xml.replace(/<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (pXml) => {
        if (!pXml.endsWith('</w:p>')) return pXml
        if (count && !rep.all) return pXml
        const texts = [...pXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1]))
        if (!texts.length) return pXml
        const joined = texts.join('')
        if (!joined.includes(rep.find)) return pXml
        const parts = rep.all ? joined.split(rep.find) : (() => {
          const i = joined.indexOf(rep.find)
          return [joined.slice(0, i), joined.slice(i + rep.find.length)]
        })()
        count += rep.all ? parts.length - 1 : 1
        // 重建：保留 pPr 和首个文本 run 的 rPr（格式基本不变），全文合并为单 run
        const pPr = (pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [])[0] || ''
        const rPr = (pXml.match(/<w:r>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [])[1] || ''
        let outText = ''
        parts.forEach((seg, i) => { if (i) outText += rep.replace; outText += seg })
        return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(outText)}</w:t></w:r></w:p>`
      })
    }
    if (count === 0) missed.push(rep.find)
    else replaced += count
  }
  zip.file('word/document.xml', xml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(filePath, buffer)
  await validateDocx(filePath, { throwOnError: true })
  return { replaced, missed, size: buffer.length }
}

async function modifyDocx(filePath, content, mode) {
  if (mode === 'replace') return createDocx(filePath, content)
  if (mode === 'edit') return editDocx(filePath, content)
  const paras = normParagraphs((content && content.paragraphs) || [])
  let addXml = ''
  const images = [] // {buffer, ext}
  for (const p of paras) {
    if (p.style === 'table') {
      addXml += mdTableXml(p.rows) + paraXml('', {})
    } else if (p.style === 'image') {
      const info = imageDrawingXml(p.image, p.width || null)
      if (info) { images.push(info); addXml += `__IMG_SLOT_${images.length - 1}__` }
      else addXml += paraXml(`（图片缺失：${p.image}）`, { italic: true, size: 24, color: 'A6A6A6' })
      if (p.alt) addXml += paraXml(p.alt, { size: 20, align: 'center', color: '808080' })
    } else {
      addXml += paraXml(p.text, PARA_STYLES[p.style])
    }
  }
  if (!addXml) throw new Error('没有可追加的内容')

  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const doc = zip.file('word/document.xml')
  if (!doc) throw new Error('不是有效的 Word 文档（缺少 document.xml）')
  let xml = await doc.async('string')

  // 图片：注册 relationship + media 文件，替换占位符
  if (images.length) {
    let rels = zip.file('word/_rels/document.xml.rels')
    let relsXml = rels ? await rels.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    let maxRid = 0
    for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) maxRid = Math.max(maxRid, parseInt(m[1], 10))
    const mediaFiles = zip.file(/^word\/media\//) || []
    let mediaIdx = mediaFiles.length
    let ctXml = await zip.file('[Content_Types].xml').async('string')
    let docPrId = 100 + Math.floor(Math.random() * 100)
    images.forEach((img, i) => {
      maxRid++
      mediaIdx++
      const ext = IMG_CT[img.type] ? img.type : 'png'
      const rId = `rId${maxRid}`
      const cx = img.width * 9525
      const cy = img.height * 9525
      relsXml = relsXml.replace('</Relationships>', `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${mediaIdx}.${ext}"/></Relationships>`)
      zip.file(`word/media/image${mediaIdx}.${ext}`, img.buffer)
      if (!ctXml.includes(`Extension="${ext}"`)) ctXml = ctXml.replace('</Types>', `<Default Extension="${ext}" ContentType="${IMG_CT[ext]}"/></Types>`)
      addXml = addXml.replace(`__IMG_SLOT_${i}__`, inlineDrawingParaXml({ cx, cy }, docPrId++, rId))
    })
    zip.file('[Content_Types].xml', ctXml)
    zip.file('word/_rels/document.xml.rels', relsXml)
  }
  if (addXml.includes('__IMG_SLOT_')) throw new Error('图片注入失败，请重试')

  if (xml.includes('<w:sectPr')) xml = xml.replace('<w:sectPr', addXml + '<w:sectPr')
  else xml = xml.replace('</w:body>', addXml + '</w:body>')
  zip.file('word/document.xml', xml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(filePath, buffer)
  await validateDocx(filePath, { throwOnError: true })
  return buffer.length
}

// ===== 指令式格式修改（style_word 底层）：治"单独改格式费劲且改不好" =====
// ops 直接说意图：{ target, align, color, font, sizePt, bold, firstLine }
// target: 'title'文档大标题 | 'h1'/'h2'/'h3'各级标题 | 'all'全部段落 | { contains:'文本' } 按内容定位
// 手术原则：增量改（有则替换/无则按 OOXML 顺序锚点插入），不重排 rPr，避开 schema 顺序雷
async function styleDocx(filePath, ops) {
  const list = (Array.isArray(ops) ? ops : [ops]).filter((o) => o && o.target)
  if (!list.length) throw new Error('缺少 ops（至少一条格式指令，如 { target:"title", align:"center" }）')
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const doc = zip.file('word/document.xml')
  if (!doc) throw new Error('不是有效的 Word 文档（缺少 document.xml）')
  let xml = await doc.async('string')

  const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  const pStyleOf = (p) => { const m = p.match(/<w:pStyle w:val="([^"]+)"/); return m ? m[1] : '' }
  const pTextOf = (p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => unesc(m[1])).join('')
  const isH = (st, lv) => new RegExp(`^(heading${lv}|${lv})$`, 'i').test(st || '')

  // pPr 内确保 w:jc（对齐）：有则替换，无则插（pPr 的 rPr 前/尾部——jc 在 ind 后合法）
  const setParaAlign = (p, val) => {
    if (/<w:jc w:val="/.test(p)) return p.replace(/<w:jc w:val="[^"]*"\s*\/>/, `<w:jc w:val="${val}"/>`)
    if (/<w:pPr\b[^>]*>/.test(p)) return p.replace(/(<w:pPr\b[^>]*>)/, `$1<w:jc w:val="${val}"/>`)
    return p.replace(/(<w:p\b[^>]*>)/, `$1<w:pPr><w:jc w:val="${val}"/></w:pPr>`)
  }
  // rPr 内"有则替换/无则插入"：anchorRe 是插入锚点（新元素须在锚点前才合 schema 顺序）
  const rprSet = (p, tag, xml, anchorRes) => {
    const re = new RegExp(`<w:${tag}\\b[^>]*/?>`)
    let out = p
    let touched = false
    out = out.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (m, inner) => {
      if (touched) return m
      touched = true
      if (re.test(inner)) return m.replace(re, xml)
      for (const a of anchorRes) {
        const am = inner.match(a)
        if (am) return m.replace(am[0], xml + am[0])
      }
      return `<w:rPr>${xml}${inner}</w:rPr>`
    })
    return out
  }

  const report = list.map(() => 0)
  // 第一轮：分段 + 定位 title 段（pStyle=Title 优先，否则第一个非空段）
  const segs = []
  const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let m
  while ((m = re.exec(xml)) !== null) segs.push({ xml: m[0], start: m.index })
  if (!segs.length) throw new Error('文档里没有段落可改')
  let titleIdx = segs.findIndex((s) => pStyleOf(s.xml) === 'Title')
  if (titleIdx < 0) titleIdx = segs.findIndex((s) => pTextOf(s.xml).trim())

  // 第二轮：逐段匹配 ops 并手术
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const pText = pTextOf(seg.xml)
    const st = pStyleOf(seg.xml)
    let np = seg.xml
    let hit = false
    for (let oi = 0; oi < list.length; oi++) {
      const op = list[oi]
      let match = false
      if (op.target === 'all') match = !!pText.trim() || /w:pPr/.test(np)
      else if (op.target === 'title') match = i === titleIdx
      else if (op.target === 'h1') match = isH(st, 1)
      else if (op.target === 'h2') match = isH(st, 2)
      else if (op.target === 'h3') match = isH(st, 3)
      else if (typeof op.target === 'object' && op.target.contains) match = pText.includes(op.target.contains)
      if (!match) continue
      hit = true
      if (op.align) {
        const val = { center: 'center', left: 'left', right: 'right', justify: 'both', both: 'both' }[String(op.align).toLowerCase()]
        if (!val) throw new Error(`align 无效: ${op.align}（center/left/right/justify）`)
        np = setParaAlign(np, val)
      }
      if (op.firstLine === 'none') {
        np = np.replace(/(<w:ind [^>]*?) w:firstLine="\d+"/, '$1').replace(/(<w:ind [^>]*?) w:firstLineChars="\d+"/, '$1')
      }
      const colorHex = op.color ? (/^[0-9a-fA-F]{6}$/.test(String(op.color)) ? String(op.color).toUpperCase() : { black: '000000', red: 'FF0000', blue: '0000FF', gray: '808080', auto: 'auto' }[String(op.color).toLowerCase()] || null) : null
      if (op.color && !colorHex) throw new Error(`color 无效: ${op.color}（6 位 hex 如 000000，或 black/red/blue/gray/auto）`)
      const sizeHalf = Number(op.sizePt) > 0 ? Math.round(Number(op.sizePt) * 2) : null
      if (op.color || op.font || sizeHalf || op.bold !== undefined) {
        // run 级手术：只动有文字的 run（<w:t> 非空），空 run（sectPr/书签等）不动
        np = np.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (run) => {
          if (!/<w:t[^>]*>[^<]/.test(run)) return run
          let r = run
          if (colorHex) {
            if (/<w:color w:val="/.test(r)) r = r.replace(/<w:color w:val="[^"]*"\s*\/>/, `<w:color w:val="${colorHex}"/>`)
            else r = rprSet(r, 'color', `<w:color w:val="${colorHex}"/>`, [/<w:szCs\b/, /<w:sz\b/, /<w:u\b/, /<w:highlight\b/, /<\/w:rPr>/])
          }
          if (sizeHalf) {
            if (/<w:sz w:val="/.test(r)) {
              r = r.replace(/<w:sz w:val="\d+"\s*\/>/, `<w:sz w:val="${sizeHalf}"/>`).replace(/<w:szCs w:val="\d+"\s*\/>/, `<w:szCs w:val="${sizeHalf}"/>`)
            } else {
              r = rprSet(r, 'sz', `<w:sz w:val="${sizeHalf}"/><w:szCs w:val="${sizeHalf}"/>`, [/<\/w:rPr>/])
            }
          }
          if (op.bold === true) {
            if (/<w:b\s*w:val="(?:0|false)"/.test(r)) r = r.replace(/<w:b\s*w:val="(?:0|false)"\s*\/>/, '<w:b/>')
            else if (!/<w:b\b[^>]*\/>/.test(r)) r = rprSet(r, 'b', '<w:b/>', [/<w:rFonts\b/, /<\/w:rPr>/])
          } else if (op.bold === false) {
            if (/<w:b\/>/.test(r)) r = r.replace(/<w:b\/>/, '<w:b w:val="0"/>')
            else if (/<w:b\b[^>]*\/>/.test(r) && !/<w:b\s*w:val="(?:1|true)"/.test(r)) r = r.replace(/<w:b\b[^>]*\/>/, '<w:b w:val="0"/>')
          }
          if (op.font) {
            const f = escapeXml(String(op.font))
            if (/<w:rFonts\b[^>]*\/>/.test(r)) {
              r = /w:eastAsia="/.test(r)
                ? r.replace(/w:eastAsia="[^"]*"/, `w:eastAsia="${f}"`)
                : r.replace(/<w:rFonts\b/, `<w:rFonts w:eastAsia="${f}"`)
            } else {
              r = rprSet(r, 'rFonts', `<w:rFonts w:eastAsia="${f}"/>`, [/<w:b\b/, /<w:color\b/, /<w:szCs\b/, /<w:sz\b/, /<\/w:rPr>/])
            }
          }
          return r
        })
      }
    }
    if (hit) {
      for (let oi = 0; oi < list.length; oi++) {
        const op = list[oi]
        const match = op.target === 'all' ? !!pText.trim() : op.target === 'title' ? i === titleIdx
          : op.target === 'h1' ? isH(st, 1) : op.target === 'h2' ? isH(st, 2) : op.target === 'h3' ? isH(st, 3)
          : (typeof op.target === 'object' && op.target.contains) ? pText.includes(op.target.contains) : false
        if (match) report[oi]++
      }
      xml = xml.slice(0, seg.start) + np + xml.slice(seg.start + seg.xml.length)
      // 重算后续段偏移（长度变了）
      const delta = np.length - seg.xml.length
      for (let j = i + 1; j < segs.length; j++) segs[j].start += delta
    }
  }

  const miss = list.map((o, i) => ({ o, n: report[i] })).filter((x) => !x.n)
  if (report.every((n) => !n)) throw new Error(`没有任何段落命中——target 写法：title/h1/h2/h3/all 或 { contains:"段落里的文字" }。可先 read_word 看内容再定位`)
  zip.file('word/document.xml', xml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(filePath, buffer)
  await validateDocx(filePath, { throwOnError: true })
  const done = list.map((o, i) => {
    const t = typeof o.target === 'object' && o.target.contains ? `"${o.target.contains}"段` : String(o.target)
    const what = [o.align && `对齐=${o.align}`, o.color && `颜色=${o.color}`, o.font && `字体=${o.font}`, o.sizePt && `字号=${o.sizePt}磅`, o.bold !== undefined && `加粗=${o.bold}`, o.firstLine === 'none' && '去首行缩进'].filter(Boolean).join('/')
    return `${t}: ${what}（${report[i]} 段）`
  }).join('；')
  return { buffer: buffer.length, done, miss: miss.map((x) => JSON.stringify(x.o.target)) }
}

// ===== Excel（exceljs 全接管）=====

// Excel 主题：与 Word THEMES 对应的表头/斑马纹/边框配色
const XLSX_THEMES = {
  modern:  { headerFill: 'FF2E5E8C', headerColor: 'FFFFFFFF', zebra: 'FFF4F8FC', borderColor: 'FFC9D4E0', font: '等线' },
  classic: { headerFill: 'FFD9E2F3', headerColor: 'FF1F2328', zebra: null, borderColor: 'FFB0B7C3', font: '宋体' },
  gov:     { headerFill: 'FFF2DCDB', headerColor: 'FF000000', zebra: null, borderColor: 'FFD9A9A9', font: '仿宋' }
}
function normXTheme(t) {
  return XLSX_THEMES[String(t || '').trim().toLowerCase()] || XLSX_THEMES.modern
}
function themeBorder(xt) {
  const b = { style: 'thin', color: { argb: xt.borderColor } }
  return { left: b, right: b, top: b, bottom: b }
}

const THIN = { style: 'thin', color: { argb: 'FFB0B7C3' } }
const BORDER = { left: THIN, right: THIN, top: THIN, bottom: THIN }

function sanitizeSheetName(name, used) {
  let s = String(name || '').replace(/[\\/*?:[\]]/g, ' ').trim() || 'Sheet'
  s = s.slice(0, 31)
  let base = s, n = 2
  while (used.has(s)) s = `${base.slice(0, 28)}_${n++}`
  used.add(s)
  return s
}

// 单元格值解析：数字→数值；"=SUM(...)"→公式；其余→字符串
function parseCellValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v == null) return ''
  const s = String(v)
  if (s.startsWith('=')) return { formula: s.slice(1) }
  return s
}

// 状态条件配色（经典 Excel 三色 + 信息蓝）：值命中即整格上色，人工表灵魂
const STATUS_STYLES = {
  ok:   { bg: 'FFC6EFCE', fg: 'FF006100' },
  bad:  { bg: 'FFFFC7CE', fg: 'FF9C0006' },
  warn: { bg: 'FFFFEB9C', fg: 'FF9C6500' },
  info: { bg: 'FFDDEBF7', fg: 'FF1F4E79' }
}

function setCellStyled(cell, v, { header = false, zebra = null, xtheme = null, status = null } = {}) {
  cell.value = parseCellValue(v)
  cell.border = xtheme ? themeBorder(xtheme) : BORDER
  if (header) {
    cell.font = { bold: true, size: 11, color: { argb: xtheme.headerColor }, name: xtheme.font }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: xtheme.headerFill } }
    cell.alignment = { horizontal: 'center', vertical: 'center' }
    return
  }
  // 状态配色优先（覆盖斑马纹）；日期/日期字符串自动 yyyy-mm-dd 格式
  const st = status && STATUS_STYLES[status]
  if (st) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: st.bg } }
    cell.font = { bold: true, size: 11, color: { argb: st.fg }, name: xtheme.font }
  } else if (zebra) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebra } }
  }
  if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd'
  else if (typeof cell.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cell.value.trim())) cell.numFmt = 'yyyy-mm-dd'
}

// 列宽自适应 v2（治"单元格太小显示不全"）：
// ① 中文/全角按 2.25 显示宽度系数（11pt 下实测 2 偏挤）；② 余量 +3、上限 80；
// ③ 长文本/显式换行自动 wrapText + 估算行数设行高（ExcelJS 不设行高时 Excel 只显示首行——"显示不全"主根因）；
// ④ 合并单元格：成员格跳过，起点格按跨列分摊宽度（防标题把首列撑爆）
function autoFitColumns(ws) {
  const colNum = (letters) => String(letters).split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0)
  const dispW = (s) => { let l = 0; for (const ch of String(s)) l += ch.charCodeAt(0) > 255 ? 2.25 : 1; return l }
  const cellStr = (v) => {
    if (v == null) return ''
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
      if (v.formula) return v.result != null ? String(v.result) : '=' + v.formula
      if (v.text != null) return String(v.text)
      if (v.result != null) return String(v.result)
      return ''
    }
    return String(v)
  }
  const MAXW = 80, MINW = 8, LINE_H = 14.4, MAX_LINES = 12
  // merge 映射：成员格不参与估宽；起点格记跨列数（估行高用）
  const mergeSpan = new Map()  // 'r,c' -> 列数（仅 merge 起点）
  const mergedMember = new Set() // 'r,c' 非起点成员
  try {
    for (const ref of (ws.model && ws.model.merges) || []) {
      const m = String(ref).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
      if (!m) continue
      const c1 = colNum(m[1]), r1 = parseInt(m[2], 10), c2 = colNum(m[3]), r2 = parseInt(m[4], 10)
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
        for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
          if (r === r1 && c === c1) mergeSpan.set(`${r},${c}`, Math.abs(c2 - c1) + 1)
          else mergedMember.add(`${r},${c}`)
        }
      }
    }
  } catch {}
  const widths = []
  const wrapCells = [] // { rn, col, segs }
  ws.eachRow({ includeEmpty: true }, (row, rn) => {
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = `${rn},${col}`
      if (mergedMember.has(key)) return // merge 成员不撑列宽
      const s = cellStr(cell.value)
      if (!s) { if (!widths[col - 1]) widths[col - 1] = MINW; return }
      const segs = String(s).split(/\r?\n/)
      const span = mergeSpan.get(key) || 1
      const maxSeg = Math.max(...segs.map((x) => dispW(x)))
      // merge 起点格宽度按跨列分摊（单列不独扛整行标题）
      const w = Math.min(Math.max(maxSeg / span + 3, MINW), MAXW)
      if (!widths[col - 1] || w > widths[col - 1]) widths[col - 1] = w
      // 需要换行的格：显式 \n 多行 或 单行超可用宽
      if (segs.length > 1 || maxSeg > MAXW - 3) {
        const al = cell.alignment || {}
        cell.alignment = Object.assign({}, al, { wrapText: true })
        wrapCells.push({ rn, col, segs })
      }
    })
  })
  widths.forEach((w, i) => { if (w) ws.getColumn(i + 1).width = w })
  // 行高：wrap 格按"各显示行 / 可用列宽"估算，取该行最大需求，封顶 12 行
  const rowNeed = new Map()
  for (const wc of wrapCells) {
    const span = mergeSpan.get(`${wc.rn},${wc.col}`) || 1
    let avail = 0
    for (let c = wc.col; c < wc.col + span; c++) avail += (widths[c - 1] || MINW) - 2
    avail = Math.max(avail, 6)
    let lines = 0
    for (const seg of wc.segs) lines += Math.max(1, Math.ceil(dispW(seg) / avail))
    rowNeed.set(wc.rn, Math.max(rowNeed.get(wc.rn) || 1, Math.min(lines, MAX_LINES)))
  }
  for (const [rn, lines] of rowNeed) {
    if (lines > 1) {
      const row = ws.getRow(rn)
      const cur = Number(row.height) || 0
      row.height = Math.max(cur, lines * LINE_H + 4)
    }
  }
}

// 向 worksheet 写一张表（headers + rows + merges + statusMap）；xtheme 提供表头/斑马纹/边框配色
function buildSheet(ws, data, opts = {}) {
  const { headers = [], rows = [], merges = [], statusMap = {} } = data || {}
  const { autoWidth = true, freezeHeader = true, xtheme = XLSX_THEMES.modern } = opts
  const hasHeader = Array.isArray(headers) && headers.length
  if (freezeHeader && hasHeader) ws.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' }]
  if (hasHeader) {
    const row = ws.getRow(1)
    headers.forEach((v, i) => setCellStyled(row.getCell(i + 1), v, { header: true, xtheme }))
    row.height = 22
  }
  // statusMap：{"列名或列号": {"值":"ok|bad|warn|info"}} —— 命中值整格条件配色
  const colStatus = []
  const headerList = Array.isArray(headers) ? headers.map((h) => String(h)) : []
  for (const [key, rule] of Object.entries(statusMap || {})) {
    if (!rule || typeof rule !== 'object') continue
    const idx = headerList.indexOf(String(key))
    const col = idx >= 0 ? idx : (/^\d+$/.test(String(key)) ? Number(key) - 1 : -1)
    if (col >= 0) colStatus[col] = rule
  }
  let startRow = hasHeader ? 2 : 1
  let ri = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    const row = ws.getRow(startRow + ri)
    // 斑马纹：偶数数据行（第2、4、6…行数据）浅色底，与 Word 主题表格一致
    const zebra = xtheme.zebra && ri % 2 === 1 ? xtheme.zebra : null
    ;(Array.isArray(r) ? r : [r]).forEach((v, ci) => {
      const rule = colStatus[ci]
      const status = rule ? rule[String(v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : v)] || rule[String(v == null ? '' : v)] : null
      setCellStyled(row.getCell(ci + 1), v, { zebra, xtheme, status: status || null })
    })
    ri++
  }
  for (const mg of Array.isArray(merges) ? merges : []) {
    try { ws.mergeCells(String(mg).toUpperCase()) } catch {}
  }
  if (autoWidth) autoFitColumns(ws)
}

// sheet 数据归一化：{headers, rows, merges, statusMap} 或 markdown 字符串（交给调用方解析，这里只收结构化）
function normalizeSheetData(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return { headers: data.headers || [], rows: Array.isArray(data.rows) ? data.rows : [], merges: data.merges || [], statusMap: data.statusMap || {} }
  }
  return { headers: [], rows: [], merges: [], statusMap: {} }
}

// 颜色归一：'FFEEEE' / '#EEEEEE' / 'EEEEEE' → ARGB
function normArgb(c) {
  const s = String(c || '').replace(/^#/, '').toUpperCase()
  if (/^[0-9A-F]{8}$/.test(s)) return s
  if (/^[0-9A-F]{6}$/.test(s)) return 'FF' + s
  return null
}

// 遍历范围（如 "A2:C10" 或单格 "B2"）内每个单元格
function iterRange(ws, range, fn) {
  const m = String(range || '').toUpperCase().match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/)
  if (!m) throw new Error(`范围格式错误："${range}"，应为如 A2:C10 或 B2`)
  const c1 = ws.getColumn(m[1]).number, r1 = parseInt(m[2], 10)
  const c2 = m[3] ? ws.getColumn(m[3]).number : c1, r2 = m[4] ? parseInt(m[4], 10) : r1
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) fn(ws.getRow(r).getCell(c))
  }
}

// 应用范围样式数组：{ sheet?, range, bold, italic, font, size, color, bg, numFmt, align }
function applyXlsxStyles(wb, styles) {
  for (const st of Array.isArray(styles) ? styles : []) {
    if (!st || !st.range) continue
    const ws = st.sheet ? wb.getWorksheet(String(st.sheet)) || wb.worksheets[0] : wb.worksheets[0]
    if (!ws) continue
    iterRange(ws, st.range, (cell) => {
      const font = { ...(cell.font || {}) }
      if (st.bold != null) font.bold = !!st.bold
      if (st.italic != null) font.italic = !!st.italic
      if (st.font) font.name = String(st.font)
      if (st.size) font.size = Number(st.size)
      const color = normArgb(st.color)
      if (color) font.color = { argb: color }
      cell.font = font
      const bg = normArgb(st.bg)
      if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }
      if (st.numFmt) cell.numFmt = String(st.numFmt)
      if (st.align || st.wrap != null) {
        cell.alignment = { ...(cell.alignment || {}) }
        if (st.align) cell.alignment.horizontal = String(st.align)
        if (st.wrap != null) { cell.alignment.wrapText = !!st.wrap; cell.alignment.vertical = cell.alignment.vertical || 'top' }
      }
      if (st.valign) cell.alignment = { ...(cell.alignment || {}), vertical: String(st.valign) }
    })
    // 行高（人工表大标题行/区块行常需指定高度）
    if (st.rowHeight) {
      const m = String(st.range).match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/)
      if (m) {
        const r1 = Number(m[2]); const r2 = Number(m[4])
        for (let r = r1; r <= r2; r++) ws.getRow(r).height = Number(st.rowHeight)
      } else {
        const m2 = String(st.range).match(/([A-Z]+)(\d+)/)
        if (m2) ws.getRow(Number(m2[2])).height = Number(st.rowHeight)
      }
    }
  }
}

// 创建表格。sheets: { 表名: {headers, rows, merges} } 多表；否则单表 Sheet1；styles: 范围样式数组；theme: modern/classic/gov
async function createXlsx(filePath, { headers = [], rows = [], sheets = null, merges = [], statusMap = {}, autoWidth = true, freezeHeader = true, styles = [], theme = 'modern' } = {}) {
  const wb = new ExcelJS.Workbook()
  const used = new Set()
  const xtheme = normXTheme(theme)
  if (sheets && typeof sheets === 'object' && Object.keys(sheets).length) {
    for (const [name, data] of Object.entries(sheets)) {
      const ws = wb.addWorksheet(sanitizeSheetName(name, used))
      buildSheet(ws, normalizeSheetData(data), { autoWidth, freezeHeader, xtheme })
    }
  } else {
    const ws = wb.addWorksheet('Sheet1')
    buildSheet(ws, { headers, rows, merges, statusMap }, { autoWidth, freezeHeader, xtheme })
  }
  applyXlsxStyles(wb, styles)
  await wb.xlsx.writeFile(filePath)
  return fs.statSync(filePath).size
}

// 列出所有工作表名
async function listXlsxSheets(filePath) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  return wb.worksheets.map((w) => w.name)
}

// 读取工作表为二维数组（公式取最近计算结果；无结果则显示公式原文）
function cellText(v) {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('')
    if (v.result != null) return String(v.result)
    if (v.formula) return '=' + v.formula
    if (v.text != null) return String(v.text)
    return ''
  }
  return String(v)
}

function readTableFromWs(ws) {
  const table = []
  ws.eachRow({ includeEmpty: true }, (row, rn) => {
    while (table.length < rn - 1) table.push([])
    const cells = []
    let maxC = 0
    row.eachCell({ includeEmpty: true }, (cell, cn) => {
      maxC = Math.max(maxC, cn)
      cells[cn - 1] = cellText(cell.value)
    })
    const out = []
    for (let c = 0; c < maxC; c++) out.push(cells[c] ?? '')
    table.push(out)
  })
  return table
}

async function readXlsx(filePath, sheetName) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  if (!wb.worksheets.length) throw new Error('文件里没有工作表')
  const ws = sheetName ? wb.getWorksheet(String(sheetName)) : wb.worksheets[0]
  if (!ws) throw new Error(`找不到工作表"${sheetName}"（现有：${wb.worksheets.map((w) => w.name).join('、')}）`)
  return readTableFromWs(ws)
}

// 追加行（值支持 "=公式" 形式）
async function appendXlsxRows(filePath, rows, sheetName) {
  const list = (Array.isArray(rows) ? rows : [rows]).map((r) => (Array.isArray(r) ? r : [r]))
  if (!list.length) throw new Error('没有可追加的行')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = sheetName ? wb.getWorksheet(String(sheetName)) : wb.worksheets[0]
  if (!ws) throw new Error(`找不到工作表"${sheetName}"`)
  for (const r of list) {
    const row = ws.addRow([])
    ;(Array.isArray(r) ? r : [r]).forEach((v, ci) => setCellStyled(row.getCell(ci + 1), v))
  }
  autoFitColumns(ws) // 追加后列宽/行高自适应（新行长文本不再显示不全）
  await wb.xlsx.writeFile(filePath)
  return fs.statSync(filePath).size
}

// 修改单元格："B2"；value 为 "=SUM(...)" 时写入公式
async function modifyXlsxCell(filePath, cellRef, value, sheetName) {
  const m = String(cellRef || '').toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!m) throw new Error(`单元格引用格式错误："${cellRef}"，应为如 B2 的形式（列字母+行号）`)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = sheetName ? wb.getWorksheet(String(sheetName)) : wb.worksheets[0]
  if (!ws) throw new Error(`找不到工作表"${sheetName}"`)
  const cell = ws.getCell(`${m[1]}${m[2]}`)
  cell.value = parseCellValue(value)
  cell.border = BORDER
  autoFitColumns(ws) // 改值后列宽/行高自适应（改成长文本不再显示不全）
  await wb.xlsx.writeFile(filePath)
  return fs.statSync(filePath).size
}

// 格式化：读取后全量重建为美化样式（保留合并单元格结构）
async function formatXlsx(filePath, { autoWidth = true, freezeHeader = true, theme = 'modern' } = {}) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const src = wb.worksheets[0]
  if (!src) throw new Error('文件里没有工作表')
  const table = readTableFromWs(src)
  if (!table.length) throw new Error('表格是空的，没有可美化的内容')
  const merges = (src.model && Array.isArray(src.model.merges)) ? src.model.merges.slice() : []
  // 裁掉整列为空的尾随列
  const maxLen = Math.max(...table.map((r) => r.length))
  let lastCol = -1
  for (let c = 0; c < maxLen; c++) {
    if (table.some((r) => String(r[c] ?? '').trim() !== '')) lastCol = c
  }
  const trimmed = table.map((r) => r.slice(0, lastCol + 1))
  const out = new ExcelJS.Workbook()
  const ws = out.addWorksheet(src.name || 'Sheet1')
  buildSheet(ws, { headers: trimmed[0].map((v) => v ?? ''), rows: trimmed.slice(1), merges }, { autoWidth, freezeHeader, xtheme: normXTheme(theme) })
  await out.xlsx.writeFile(filePath)
  return fs.statSync(filePath).size
}

// 批量修改单元格：cells = { "B2": 值, ... } 或 [{cell, value}]；值以 = 开头写成公式
async function modifyXlsxCells(filePath, cells, sheetName) {
  const entries = Array.isArray(cells)
    ? cells.map((c) => [c && c.cell != null ? c.cell : (c && c.ref), c ? c.value : undefined])
    : Object.entries(cells && typeof cells === 'object' ? cells : {})
  if (!entries.length) throw new Error('没有要修改的单元格（cells 传 {"B2":"新值"} 或 [{cell,value}]）')
  // 先全部校验引用格式，再统一写入（避免改了一半才发现格式错）
  const refs = entries.map(([ref]) => {
    const m = String(ref || '').toUpperCase().match(/^([A-Z]+)(\d+)$/)
    if (!m) throw new Error(`单元格引用格式错误："${ref}"，应为如 B2 的形式（列字母+行号）`)
    return m
  })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = sheetName ? wb.getWorksheet(String(sheetName)) : wb.worksheets[0]
  if (!ws) throw new Error(`找不到工作表"${sheetName}"`)
  entries.forEach(([ref, value], i) => {
    const cell = ws.getCell(`${refs[i][1]}${refs[i][2]}`)
    cell.value = parseCellValue(value)
    cell.border = BORDER
  })
  await wb.xlsx.writeFile(filePath)
  return { count: entries.length, size: fs.statSync(filePath).size }
}

// ===== Word 格式解析引擎（v2.4.95：read_word_format / apply_word_format）=====
// 思路借鉴：openxml-ts 的 effective style 级联（直接格式 → pStyle → basedOn 链 → docDefaults）
// XML 解析用 linkedom DOMParser（text/xml 模式正确处理 OOXML 自闭合标签与命名前缀），零新依赖

function parseXmlDoc(xml) {
  const { DOMParser } = require('linkedom')
  return new DOMParser().parseFromString(String(xml), 'text/xml')
}

// OOXML 数值换算
const szToPt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.round((n / 2) * 10) / 10 : null } // 半点→磅
const twToCm = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.round((n / 567) * 100) / 100 : null } // twips→厘米
function lineToRatio(v, rule) {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return null
  if (rule === 'exact' || rule === 'atLeast') return `${Math.round((n / 20) * 10) / 10}pt`
  return Math.round((n / 240) * 100) / 100 // auto：240=1倍
}
const firstAttr = (el, tag, attr = 'w:val') => {
  if (!el) return null
  const t = el.getElementsByTagName(tag)[0]
  return t ? t.getAttribute(attr) : null
}

// 提取 run 级格式（w:rPr）→ 扁平对象；empty=true 表示节点存在但无任何格式标记
function readRPr(rPr) {
  if (!rPr) return null
  const fonts = rPr.getElementsByTagName('w:rFonts')[0]
  const out = {
    bold: !!rPr.getElementsByTagName('w:b')[0] && firstAttr(rPr, 'w:b') !== '0' && firstAttr(rPr, 'w:b') !== 'false',
    italic: !!rPr.getElementsByTagName('w:i')[0] && firstAttr(rPr, 'w:i') !== '0',
    underline: firstAttr(rPr, 'w:u') || null,
    strike: !!rPr.getElementsByTagName('w:strike')[0],
    sizePt: szToPt(firstAttr(rPr, 'w:sz')),
    color: firstAttr(rPr, 'w:color') || null,
    font: (fonts && (fonts.getAttribute('w:ascii') || fonts.getAttribute('w:hAnsi'))) || null,
    eastAsiaFont: (fonts && fonts.getAttribute('w:eastAsia')) || null
  }
  const shd = rPr.getElementsByTagName('w:shd')[0]
  if (shd && shd.getAttribute('w:fill') && shd.getAttribute('w:fill') !== 'auto') out.shade = shd.getAttribute('w:fill')
  return out
}

// 提取段落级格式（w:pPr）→ 扁平对象
function readPPr(pPr) {
  if (!pPr) return null
  const spacing = pPr.getElementsByTagName('w:spacing')[0]
  const ind = pPr.getElementsByTagName('w:ind')[0]
  const out = {
    styleId: firstAttr(pPr, 'w:pStyle') || null,
    align: firstAttr(pPr, 'w:jc') || null,
    lineRule: (spacing && spacing.getAttribute('w:lineRule')) || null,
    lineRaw: (spacing && spacing.getAttribute('w:line')) || null,
    beforePt: spacing && spacing.getAttribute('w:before') ? Math.round((parseInt(spacing.getAttribute('w:before'), 10) / 20) * 10) / 10 : null,
    afterPt: spacing && spacing.getAttribute('w:after') ? Math.round((parseInt(spacing.getAttribute('w:after'), 10) / 20) * 10) / 10 : null,
    indentFirstLine: ind && ind.getAttribute('w:firstLineChars') ? parseInt(ind.getAttribute('w:firstLineChars'), 10) / 100 : (ind && ind.getAttribute('w:firstLine') ? Math.round((parseInt(ind.getAttribute('w:firstLine'), 10) / 240) * 10) / 10 : null), // firstLineChars 单位 1/100 字符优先；firstLine twips≈/240 字符
    indentLeftChars: ind && ind.getAttribute('w:leftChars') ? parseInt(ind.getAttribute('w:leftChars'), 10) / 100 : (ind && ind.getAttribute('w:left') ? Math.round((parseInt(ind.getAttribute('w:left'), 10) / 240) * 10) / 10 : null),
    outlineLvl: firstAttr(pPr, 'w:outlineLvl') != null ? parseInt(firstAttr(pPr, 'w:outlineLvl'), 10) : null,
    numPr: !!pPr.getElementsByTagName('w:numPr')[0]
  }
  if (out.lineRule === 'auto' && out.lineRaw) out.lineRatio = lineToRatio(out.lineRaw, 'auto')
  else if (out.lineRaw) out.linePt = lineToRatio(out.lineRaw, out.lineRule)
  const shd = pPr.getElementsByTagName('w:shd')[0]
  if (shd && shd.getAttribute('w:fill') && shd.getAttribute('w:fill') !== 'auto') out.shade = shd.getAttribute('w:fill')
  return out
}

// 解析 styles.xml → { docDefaults:{rPr,pPr}, map:{styleId:{name,type,basedOn,rPr,pPr}} }
function parseStylesXml(stylesEl) {
  const ctx = { docDefaults: { rPr: null, pPr: null }, map: {} }
  if (!stylesEl) return ctx
  const dd = stylesEl.getElementsByTagName('w:docDefaults')[0]
  if (dd) {
    const rd = dd.getElementsByTagName('w:rPrDefault')[0]
    const pd = dd.getElementsByTagName('w:pPrDefault')[0]
    ctx.docDefaults.rPr = rd ? readRPr(rd.getElementsByTagName('w:rPr')[0]) : null
    ctx.docDefaults.pPr = pd ? readPPr(pd.getElementsByTagName('w:pPr')[0]) : null
  }
  for (const st of stylesEl.getElementsByTagName('w:style')) {
    const id = st.getAttribute('w:styleId')
    if (!id) continue
    const nameEl = st.getElementsByTagName('w:name')[0]
    ctx.map[id] = {
      name: (nameEl && (nameEl.getAttribute('w:val') || nameEl.textContent)) || id,
      type: st.getAttribute('w:type') || 'paragraph',
      basedOn: firstAttr(st, 'w:basedOn') || null,
      rPr: readRPr(st.getElementsByTagName('w:rPr')[0]),
      pPr: readPPr(st.getElementsByTagName('w:pPr')[0])
    }
  }
  return ctx
}

// 样式级联合并：基于链向上（深度≤8 + seen 防环）叠加 rPr/pPr，直接格式最后覆盖
function mergeFmt(base, over) {
  if (!over) return { ...base }
  const out = { ...base }
  for (const k of Object.keys(over)) if (over[k] !== null && over[k] !== undefined && over[k] !== false) out[k] = over[k]
  return out
}
function cascadeStyle(styleId, stylesCtx, kind) {
  const chain = []
  let cur = styleId
  const seen = new Set()
  let depth = 0
  while (cur && stylesCtx.map[cur] && !seen.has(cur) && depth < 8) {
    seen.add(cur)
    chain.unshift(stylesCtx.map[cur])
    cur = stylesCtx.map[cur].basedOn
    depth++
  }
  let fmt = {}
  for (const s of chain) fmt = mergeFmt(fmt, kind === 'rPr' ? s.rPr : s.pPr)
  return fmt
}

// 段落角色识别：outlineLvl/样式名/numPr → title|h1|h2|h3|quote|list|normal
function detectRole(pPr, stylesCtx) {
  const styleId = pPr && pPr.styleId
  const st = styleId ? stylesCtx.map[styleId] : null
  const name = st ? String(st.name).toLowerCase() : ''
  if (name === 'title' || /标题$|^title$/.test(String(st && st.name || ''))) return 'title'
  const ol = pPr && pPr.outlineLvl
  if (ol === 0 || /heading 1|标题 1/.test(name)) return 'h1'
  if (ol === 1 || /heading 2|标题 2/.test(name)) return 'h2'
  if (ol === 2 || /heading 3|标题 3/.test(name)) return 'h3'
  if (/quote|引用/.test(name)) return 'quote'
  if (pPr && pPr.numPr) return 'list'
  return 'normal'
}

// 单段生效格式级联：docDefaults → 样式链 → 直接格式
function resolveParaFormat(pEl, stylesCtx) {
  const pPrEl = pEl.getElementsByTagName('w:pPr')[0] || null
  const pDirect = readPPr(pPrEl)
  const role = detectRole(pDirect, stylesCtx)
  let pFmt = mergeFmt(cascadeStyle(pDirect && pDirect.styleId ? pDirect.styleId : null, stylesCtx, 'pPr'), stylesCtx.docDefaults.pPr)
  pFmt = mergeFmt(pFmt, pDirect)
  // run 级：取段落里第一个有文字的 run 的 rPr 级联（docDefaults → 段落样式 rPr → 直接格式）
  let rFmt = mergeFmt(cascadeStyle(pDirect && pDirect.styleId ? pDirect.styleId : null, stylesCtx, 'rPr'), stylesCtx.docDefaults.rPr)
  let directRun = null
  for (const r of pEl.getElementsByTagName('w:r')) {
    if (r.getElementsByTagName('w:t').length) { directRun = readRPr(r.getElementsByTagName('w:rPr')[0]); break }
  }
  rFmt = mergeFmt(rFmt, directRun)
  return { role, para: pFmt, run: rFmt }
}

// 段落文字（所有 w:t 拼接，实体解码）
function paraText(pEl) {
  let out = ''
  for (const t of pEl.getElementsByTagName('w:t')) out += t.textContent || ''
  return decodeEntities(out)
}

// 主入口：解析整份 Word 的全部生效格式 + 指纹
async function parseWordFormat(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('不是有效的 Word 文档（缺少 document.xml）')
  const docEl = parseXmlDoc(await docFile.async('string'))
  const stylesFile = zip.file('word/styles.xml')
  const stylesCtx = parseStylesXml(stylesFile ? parseXmlDoc(await stylesFile.async('string')) : null)

  const body = docEl.getElementsByTagName('w:body')[0]
  const paras = []
  if (body) {
    let idx = 0
    for (const child of body.children) {
      const tag = child.tagName || ''
      if (tag === 'w:p') {
        const text = paraText(child)
        const fmt = resolveParaFormat(child, stylesCtx)
        paras.push({ idx: idx++, tag: 'p', text, role: fmt.role, para: fmt.para, run: fmt.run })
      } else if (tag === 'w:tbl') {
        // 表格：取首行首段格式代表 + 表格属性（底纹/边框色）
        const firstP = child.getElementsByTagName('w:p')[0]
        const fmt = firstP ? resolveParaFormat(firstP, stylesCtx) : null
        const shd = child.getElementsByTagName('w:shd')[0]
        paras.push({ idx: idx++, tag: 'table', text: firstP ? paraText(firstP) : '', role: 'table', para: fmt ? fmt.para : {}, run: fmt ? fmt.run : {}, shade: (shd && shd.getAttribute('w:fill') !== 'auto' && shd.getAttribute('w:fill')) || null })
      }
    }
  }

  // 页面设置：body 直接子级的 sectPr（最后一节的页面参数；段落内 sectPr 是中间节，跳过）
  let sect = null
  if (body) {
    for (const child of body.children) if ((child.tagName || '') === 'w:sectPr') { sect = child; break }
  }
  const page = sect ? {
    widthCm: twToCm(firstAttr(sect, 'w:pgSz', 'w:w')),
    heightCm: twToCm(firstAttr(sect, 'w:pgSz', 'w:h')),
    marginTopCm: twToCm(firstAttr(sect, 'w:pgMar', 'w:top')),
    marginBottomCm: twToCm(firstAttr(sect, 'w:pgMar', 'w:bottom')),
    marginLeftCm: twToCm(firstAttr(sect, 'w:pgMar', 'w:left')),
    marginRightCm: twToCm(firstAttr(sect, 'w:pgMar', 'w:right'))
  } : null

  const hasHeader = (zip.file(/^word\/header\d+\.xml/) || []).length > 0
  const hasFooter = (zip.file(/^word\/footer\d+\.xml/) || []).length > 0

  return { paragraphs: paras, styles: stylesCtx, page, hasHeader, hasFooter }
}

// 指纹聚合：正文众数 + 各级标题代表格式 → JSON + 人类可读摘要
function fmtDesc(fmt) {
  if (!fmt) return ''
  const parts = []
  const f = fmt.font || fmt.eastAsiaFont
  if (f) parts.push(`字体 ${f}`)
  if (fmt.sizePt) parts.push(`${fmt.sizePt}pt`)
  if (fmt.bold) parts.push('加粗')
  if (fmt.italic) parts.push('斜体')
  if (fmt.color) parts.push(`颜色 #${fmt.color}`)
  if (fmt.lineRatio) parts.push(`行距${fmt.lineRatio}倍`)
  else if (fmt.linePt) parts.push(`行距${fmt.linePt}`)
  if (fmt.beforePt != null) parts.push(`段前${fmt.beforePt}pt`)
  if (fmt.afterPt != null) parts.push(`段后${fmt.afterPt}pt`)
  if (fmt.indentFirstLine) parts.push(`首行缩进${fmt.indentFirstLine}字符`)
  if (fmt.align) parts.push(fmt.align === 'center' ? '居中' : fmt.align === 'right' ? '右对齐' : fmt.align === 'both' ? '两端对齐' : fmt.align)
  return parts.join(' ')
}
function wordFormatFingerprint(parsed) {
  const paras = parsed.paragraphs.filter((p) => p.tag === 'p')
  // v2.5.63：红字段落（≥50% 文字红系色）剔除——模板的红字说明书会污染正文众数（实测把正文算成"Times 10.5pt 加粗 红"）
  const RED = /^(FF0000|C00000|EE0000|CD0000|D20000|E60000|FF0100|B22222|DC143C|8B0000|FF1A1A|RED)$/i
  const isRedPara = (p) => {
    if (!p.run || !p.run.color) return false
    if (!RED.test(p.run.color)) return false
    // run.color 只是首个/级联色，段落内可能混排——文字主体色即算（格式说明书段落整段同色，够用）
    return true
  }
  const bodyParas = paras.filter((p) => p.role === 'normal' && p.text.trim() && !isRedPara(p))
  // 正文格式众数（字体/字号/行距出现频率最高者；key 是字符串，数值字段转回数字）
  const modeOf = (arr) => {
    const cnt = {}
    for (const v of arr) if (v != null) cnt[v] = (cnt[v] || 0) + 1
    const ks = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])
    if (!ks.length) return null
    const n = Number(ks[0])
    return Number.isFinite(n) && /^\d+(\.\d+)?$/.test(ks[0]) ? n : ks[0]
  }
  const body = bodyParas.length ? {
    font: modeOf(bodyParas.map((p) => p.run.eastAsiaFont || p.run.font)),
    sizePt: modeOf(bodyParas.map((p) => p.run.sizePt)),
    color: modeOf(bodyParas.map((p) => p.run.color)),
    lineRatio: modeOf(bodyParas.map((p) => p.para.lineRatio)),
    linePt: modeOf(bodyParas.map((p) => p.para.linePt)),
    indentFirstLine: modeOf(bodyParas.map((p) => p.para.indentFirstLine)),
    afterPt: modeOf(bodyParas.map((p) => p.para.afterPt))
  } : null
  // 角色采样防污染（v2.5.79）：模板作者常拿标题样式排承诺书/封面大字（实测"诚信承诺书"挂 Heading 3，
  // 居中+粗污染 h3 指纹，而真示范段"1.3.1 研究的主要内容"挂的是"论文正文"样式采不到）——
  // 角色段没有长着该级编号脸的，就退采正文角色里匹配该级编号的示范段（剔目录条目：页码数字结尾）
  const ROLE_NUM_PAT = {
    h1: /^(第[一二三四五六七八九十百0-9]+章|[一二三四五六七八九十]+、|引\s*言|绪\s*论|结\s*论)/,
    h2: /^\d+\.\d+(?!\.\d)/,
    h3: /^\d+\.\d+\.\d+/
  }
  const head = (role) => {
    // 目录条目两形态：①"……12"引导点+页码 ②页码是制表符点前导符（文本无点）——"研究背景1"中文+数字粘尾
    const looksTocEntry = (t) => /[…]\s*\d+$/.test(t) || /[\u4e00-\u9fa5][0-9ivxIVX]{1,4}$/.test(t)
    const hits = paras.filter((p) => p.role === role && p.text.trim())
    const pat = ROLE_NUM_PAT[role]
    let hit = (pat && hits.find((p) => pat.test(p.text.trim()))) || hits[0]
    if (pat && (!hit || !pat.test(hit.text.trim()))) {
      const alt = paras.find((p) => p.role === 'normal' && p.text.trim() && pat.test(p.text.trim()) && !looksTocEntry(p.text.trim()))
      if (alt) hit = alt
    }
    return hit ? { font: hit.run.eastAsiaFont || hit.run.font, sizePt: hit.run.sizePt, bold: hit.run.bold, color: hit.run.color, lineRatio: hit.para.lineRatio, beforePt: hit.para.beforePt, afterPt: hit.para.afterPt, align: hit.para.align } : null
  }
  const fp = {
    page: parsed.page,
    hasHeader: parsed.hasHeader,
    hasFooter: parsed.hasFooter,
    title: head('title'),
    h1: head('h1'),
    h2: head('h2'),
    h3: head('h3'),
    body,
    quote: head('quote'),
    stats: {
      totalParas: paras.length,
      headings: paras.filter((p) => /^h[123]$/.test(p.role) || p.role === 'title').length,
      tables: parsed.paragraphs.filter((p) => p.tag === 'table').length
    }
  }
  // 人类可读摘要（AI 直接读）
  const pg = parsed.page ? `${parsed.page.widthCm}×${parsed.page.heightCm}cm 页边距 上${parsed.page.marginTopCm}/下${parsed.page.marginBottomCm}/左${parsed.page.marginLeftCm}/右${parsed.page.marginRightCm}cm` : '页面设置未显式定义'
  const lines = [
    `【文档格式指纹】页面：${pg}${parsed.hasHeader ? '，有页眉' : ''}${parsed.hasFooter ? '，有页脚' : ''}`,
    fp.title ? `大标题：${fmtDesc(fp.title)}` : null,
    fp.h1 ? `一级标题：${fmtDesc(fp.h1)}` : null,
    fp.h2 ? `二级标题：${fmtDesc(fp.h2)}` : null,
    fp.h3 ? `三级标题：${fmtDesc(fp.h3)}` : null,
    fp.body ? `正文：${fmtDesc(fp.body)}` : '正文：（无正文段）',
    fp.quote ? `引用块：${fmtDesc(fp.quote)}` : null,
    `规模：共 ${fp.stats.totalParas} 段 / ${fp.stats.headings} 个标题 / ${fp.stats.tables} 个表格`
  ].filter(Boolean)
  return { fingerprint: fp, summary: lines.join('\n') }
}

// ===== 论文格式规范书蒸馏（v2.5.62：read_paper_spec）=====
// 模板 = 写给人类学生的"格式说明书"：批注里是权威规则（"三号，黑体，1.5倍行距"）、红字是说明书正文、
// 示范文字只是格式载体。蒸馏成结构化规范 + 几百字可读文本——AI 改论文前先看规范书再"理解后生成"，
// 不把 151KB 模板全文塞进上下文，产出零模板残渣（红字/批注/说明书一个不带走）。

// 中文号数 → 磅
const CN_SIZE_PT = { '初号': 42, '小初': 36, '一号': 26, '小一': 24, '二号': 22, '小二': 18, '三号': 16, '小三': 15, '四号': 14, '小四': 12, '五号': 10.5, '小五': 9, '六号': 7.5, '小六': 6.5, '七号': 5.5, '八号': 5 }
const CN_FONTS = ['黑体', '宋体', '仿宋_GB2312', '仿宋', '楷体_GB2312', '楷体', '隶书', '微软雅黑', '华文中宋', '华文楷体', '方正小标宋简体', 'Times New Roman', 'Arial', 'Calibri']

// 中文格式规则文本 → 结构化格式（批注"三号，黑体，1.5倍行距"→ {sizePt:16, eastAsiaFont:'黑体', lineRatio:1.5}）
function parseFormatRuleText(text) {
  const t = String(text || '').replace(/\s+/g, '')
  if (!t) return null
  const fmt = {}
  const flags = []
  // 字号：中文号数
  const sizeCN = t.match(/(小?[初一二三四五六七八]号)/)
  if (sizeCN) fmt.sizePt = CN_SIZE_PT[sizeCN[1]] != null ? CN_SIZE_PT[sizeCN[1]] : CN_SIZE_PT[sizeCN[1].replace(/号$/, '')]
  // 字体（中文 eastAsia；西文 ascii）
  for (const f of CN_FONTS) {
    if (t.includes(f)) { if (/Times|Arial|Calibri/i.test(f)) fmt.font = f; else fmt.eastAsiaFont = f; break }
  }
  if (!fmt.font && /Times\s*New\s*Roman/i.test(t)) fmt.font = 'Times New Roman'
  // 行距：倍数 / 固定值磅
  const ratio = t.match(/([\d.]+)\s*倍行距/)
  if (ratio) fmt.lineRatio = parseFloat(ratio[1])
  else if (/单倍行距/.test(t)) fmt.lineRatio = 1
  const exact = t.match(/(?:固定值|行间距固定值)\s*([\d.]+)\s*磅/)
  if (exact) fmt.linePt = parseFloat(exact[1])
  // 对齐
  if (/居中/.test(t)) fmt.align = 'center'
  else if (/右对齐/.test(t)) fmt.align = 'right'
  else if (/两端对齐/.test(t)) fmt.align = 'both'
  // 修饰
  if (/加粗|粗体/.test(t)) fmt.bold = true
  if (/斜体/.test(t)) fmt.italic = true
  if (/下划线/.test(t) && !/页眉/.test(t)) fmt.underline = 'single'
  if (/空两字符|首行缩进\s*2\s*字符|缩进\s*2\s*字符/.test(t) && !/悬挂/.test(t)) fmt.indentFirstLine = 2
  // 悬挂缩进（参考文献条目式："悬挂缩进2字符"）→ indentHanging
  const hang = t.match(/悬挂缩进\s*([0-9一二三四五六七八九十]+)\s*字符/)
  if (hang) fmt.indentHanging = /^[\d.]+$/.test(hang[1]) ? parseFloat(hang[1]) : ({ '一': 1, '二': 2, '三': 3, '四': 4, '五': 5 }[hang[1]] || 2)
  // 特殊指令（无法/不宜结构化的，交 AI 理解）
  if (/空一行/.test(t)) flags.push('blankLine')
  if (/另起一页/.test(t)) flags.push('pageBreakBefore')
  if (/手签|手写/.test(t)) flags.push('handwritten')
  if (/页眉.{0,6}(下划线|横线)|(下划线|横线).{0,6}页眉/.test(t)) flags.push('headerUnderline')
  if (/罗马/.test(t)) flags.push('pageNumRoman')
  if (/阿拉伯/.test(t)) flags.push('pageNumDecimal')
  const hasFmt = Object.keys(fmt).length > 0
  if (!hasFmt && !flags.length) return null
  return { fmt: hasFmt ? fmt : null, flags, raw: String(text).trim() }
}

// 批注锚定的示范文字 → 格式角色（规则文本自带"X级标题"词最可靠；锚定段查找排除目录条目防误判）
function anchorSpecRole(anchorText, parsed, ruleText) {
  const a = String(anchorText || '').replace(/\s+/g, '')
  // ① 规则文本自带角色词（"一级标题，小三号，黑体"→ h1）——作者明说，最可靠
  const hint = String(ruleText || '').match(/([一二三四五六]?)级标题/)
  if (hint) return { '一级标题': 'h1', '二级标题': 'h2', '三级标题': 'h3', '四级标题': 'h3', '五级标题': 'h3', '级标题': 'h1' }[hint[0]] || 'h1'
  if (a) {
    const probe = a.slice(0, Math.min(a.length, 12))
    // ② 查锚定文字所在段落：优先 heading/title 类（模板正文标题），**排除目录条目**（"1.1 研究背景....12"以页码数字结尾且先于正文出现）
    const hit = parsed.paragraphs.find((p) => p.tag === 'p' && p.text && p.text.replace(/\s+/g, '').includes(probe) && (/^(h[123]|title|quote)$/.test(p.role) || !/[.…]\s*\d+$/.test(p.text.trim())))
    if (hit) {
      if (/^h[123]$/.test(hit.role) || hit.role === 'title' || hit.role === 'quote') return hit.role
      const tx = hit.text.trim()
      if (/^摘\s*要/.test(tx)) return 'abstractHead'
      if (/^关键词/.test(tx)) return 'keywords'
      if (/^Abstract/i.test(tx)) return 'enAbstractHead'
      if (/^Key\s*words/i.test(tx)) return 'enKeywords'
      if (/^目\s*录/.test(tx)) return 'tocHead'
      if (/^参考文献/.test(tx)) return 'refsHead'
      if (a.length >= 8) return 'body'
    }
  }
  // 兜底：锚定文字/规则文本特征
  const both = a + String(ruleText || '')
  if (/页眉/.test(both)) return 'header'
  if (/页脚|页码/.test(both)) return 'footer'
  if (/关键词/.test(both)) return 'keywords'
  if (/ABSTRACT/i.test(both)) return 'enAbstractHead'
  if (/^摘\s*要|^摘\s*要/.test(a)) return 'abstractHead'
  if (/目\s*录/.test(both)) return 'tocHead'
  if (/第[一二三四五六七八九十百]+章|^[一二三四五六七八九十]+、/.test(a)) return 'h1'
  if (a.length >= 8) return 'body'
  return 'other'
}

// 红字说明书提取：段落内文字 ≥50% 是红系色 → 判为"写给学生的说明"，聚合原文
function extractRedNotes(docXml) {
  const RED = /^(FF0000|C00000|EE0000|CD0000|D20000|E60000|FF0100|B22222|DC143C|8B0000|FF1A1A|RED)$/i
  const paras = []
  const re = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
  let m
  while ((m = re.exec(docXml))) {
    let text = '', redChars = 0, totalChars = 0
    for (const r of m[1].matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      const ts = [...r[1].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join('')
      if (!ts) continue
      totalChars += ts.length
      const color = (r[1].match(/w:color w:val="([^"]+)"/) || [])[1]
      if (color && RED.test(color)) { redChars += ts.length; text += ts }
    }
    if (redChars >= 4 && totalChars && redChars / totalChars >= 0.5) paras.push(text.trim())
  }
  // 去重 + 截断（每段 200 字、最多 20 段）
  const seen = new Set()
  return paras.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true }).map((p) => p.slice(0, 200)).slice(0, 20)
}

// 规范书主体：解析模板 → {roles(结构化), rules(批注规则), redNotes(说明书原文), sections(分节页码), images(资产), summary(可读文本)}
async function extractPaperFormatSpec(filePath, opts = {}) {
  const parsed = await parseWordFormat(filePath)
  const fp = wordFormatFingerprint(parsed).fingerprint
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const docXml = await zip.file('word/document.xml').async('string')
  const cmts = await parseWordComments(filePath)

  // ① 批注 → 规则（批注是作者明示的权威格式，优先级最高）
  const rules = []
  for (const c of cmts) {
    const pr = parseFormatRuleText(c.text)
    const role = anchorSpecRole(c.anchor, parsed, c.text)
    rules.push({ role, anchor: c.anchor, ruleText: c.text, fmt: pr ? pr.fmt : null, flags: pr ? pr.flags : [], author: c.author })
  }
  // ② 角色聚合：先指纹兜底，后批注落位（批注是作者明示的权威格式，字段级覆盖指纹）
  const roles = {}
  const mergeRole = (role, fmt, source) => {
    if (!role || !fmt) return
    const clean = {}
    for (const [k, v] of Object.entries(fmt)) if (v != null && v !== '') clean[k] = v
    if (!Object.keys(clean).length) return
    const r = roles[role] || (roles[role] = { sources: [] })
    Object.assign(r, clean)
    if (!r.sources.includes(source)) r.sources.push(source)
  }
  const fmap = { title: fp.title, h1: fp.h1, h2: fp.h2, h3: fp.h3, body: fp.body, quote: fp.quote }
  for (const [role, f] of Object.entries(fmap)) {
    if (!f) continue
    const g = { ...f }
    if (g.font && !g.eastAsiaFont && !/Times|Arial|Calibri/i.test(g.font)) g.eastAsiaFont = g.font // 指纹的 font 字段可能装的是中文字体名
    mergeRole(role, g, '格式指纹')
  }
  for (const r of rules) if (r.fmt) mergeRole(r.role, r.fmt, '批注')
  // ③ 红字说明书
  const redNotes = extractRedNotes(docXml)
  // ④ 分节页码（每节 sectPr 的 pgNumType）+ 页眉文字
  const sectionSpecs = [...docXml.matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)].map((m) => {
    const s = m[0]
    const pgNum = (s.match(/<w:pgNumType[^>]*\/>/) || [])[0] || ''
    return {
      pageNumFmt: (pgNum.match(/w:fmt="([^"]+)"/) || [])[1] || null,
      pageNumStart: (() => { const v = (pgNum.match(/w:start="([^"]+)"/) || [])[1]; return v != null ? parseInt(v) : null })()
    }
  })
  let headerText = ''
  for (const f of Object.keys(zip.files)) {
    if (/^word\/header\d+\.xml$/.test(f)) {
      const xml = await zip.file(f).async('string')
      const t = (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('').trim()
      if (t) { headerText = t; break }
    }
  }
  const headerUnderlined = await (async () => {
    for (const f of Object.keys(zip.files)) {
      if (/^word\/header\d+\.xml$/.test(f)) {
        const xml = await zip.file(f).async('string')
        if (/<w:pBdr>[\s\S]*?<w:bottom/.test(xml)) return true
      }
    }
    return false
  })()
  // ⑤ 图片资产导出（校徽等，生成封面时沿用）
  const images = []
  const mediaFiles = Object.keys(zip.files).filter((f) => /^word\/media\/.+/.test(f) && !f.endsWith('/')) // 排除目录条目（jszip 会生成 'word/media/' key，async 对目录抛错连累整个导出）
  if (mediaFiles.length && opts.assetsDir) {
    try {
      fs.mkdirSync(opts.assetsDir, { recursive: true })
      for (const f of mediaFiles) {
        try {
          const file = zip.file(f)
          if (!file || file.dir) continue
          const dest = path.join(opts.assetsDir, path.basename(f))
          fs.writeFileSync(dest, await file.async('nodebuffer'))
          images.push(dest)
        } catch (e) { /* 单个文件失败不连累其他 */ }
      }
    } catch (e) { /* 资产导出失败不影响规范书 */ }
  }
  // ⑥ 可读规范书
  const pg = parsed.page ? `页面 ${parsed.page.widthCm}×${parsed.page.heightCm}cm，边距 上${parsed.page.marginTopCm}/下${parsed.page.marginBottomCm}/左${parsed.page.marginLeftCm}/右${parsed.page.marginRightCm}cm` : '页面设置未显式定义'
  const pageNumDesc = (fmt, start) => {
    if (!fmt && start == null) return '无页码'
    const f = /roman/i.test(fmt || '') ? '罗马数字' : /decimal|arabic/i.test(fmt || '') || fmt == null ? '阿拉伯数字' : fmt
    return `${f} 从${start != null ? start : 1} 起`
  }
  const sectionLines = sectionSpecs.map((s, i) => `  第${i + 1}节：${pageNumDesc(s.pageNumFmt, s.pageNumStart)}`)
  const ROLE_NAMES = { title: '大标题', h1: '一级标题', h2: '二级标题', h3: '三级标题', body: '正文', quote: '引用块', abstractHead: '摘要排头', keywords: '关键词行', enAbstractHead: '英文摘要排头', enKeywords: '英文关键词行', tocHead: '目录排头', refsHead: '参考文献排头', header: '页眉', footer: '页脚', other: '其他' }
  const roleLines = Object.entries(roles).map(([role, f]) => {
    const desc = fmtDesc(f)
    return desc ? `${ROLE_NAMES[role] || role}：${desc}${f.sources && f.sources.length ? `（来源：${f.sources.join('+')}）` : ''}` : null
  }).filter(Boolean)
  const ruleLines = rules.map((r) => {
    const role = ROLE_NAMES[r.role] || r.role
    const anchor = r.anchor ? `锚定"${r.anchor.slice(0, 24)}"` : '未锚定'
    const parsed1 = r.fmt ? '（已解析）' : ''
    const flags = r.flags.length ? ` [${r.flags.join(',')}]` : ''
    return `  - [${role}] ${anchor}："${r.ruleText}"${parsed1}${flags}`
  })
  const summary = [
    '【论文格式规范书】（从模板蒸馏——模板里的红字/批注/示范文字都是写给学生的说明，不要出现在产出文档里）',
    pg,
    sectionSpecs.length ? '分节页码：\n' + sectionLines.join('\n') : null,
    headerText || headerUnderlined ? `页眉：${headerText ? `"${headerText}"` : '（空）'}${headerUnderlined ? '，页眉下有下划线' : ''}` : null,
    roleLines.length ? roleLines.join('\n') : null,
    rules.length ? `模板批注规则（${rules.length} 条，作者原始标注）：\n` + ruleLines.join('\n') : null,
    redNotes.length ? `模板红字说明书（${redNotes.length} 段原文，含页码/目录等细则，AI 自行理解执行）：\n` + redNotes.map((n) => `  - "${n}"`).join('\n') : null,
    images.length ? `模板图片资产（${images.length} 个，校徽等封面图形可沿用）：\n` + images.map((p) => `  - ${p}`).join('\n') : null,
    `已排除说明性内容：红字段落 ${redNotes.length} 段 / 批注 ${cmts.length} 条`
  ].filter(Boolean).join('\n')

  // v2.5.77：板块存在性判定与 classifyTplSection 内容特征对齐——说明书式模板没有"摘要/目录"排头
  // （节里只有示范内容），光靠排头文字会误判"模板无此板块"导致逐节对照表漏检
  const tplTexts = parsed.paragraphs.map((p) => (p.text || '').trim()).filter(Boolean)
  const isTocEntry = (t) => /^[^…]{1,40}[…\. ]{3,}[0-9IVXivx]{1,4}$/.test(t.replace(/\s+/g, ''))
  return { roles, rules, redNotes, sections: sectionSpecs, headerText, headerUnderlined, images, page: parsed.page, fingerprint: fp,
    hasTocSection: tplTexts.some((t) => /^目\s*录/.test(t)) || tplTexts.filter(isTocEntry).length >= 3,
    hasSections: {
      abstract: tplTexts.some((t) => /^摘\s*要/.test(t) || /^关键词[:：]/.test(t)),
      keywords: tplTexts.some((t) => /^关键词/.test(t)),
      refs: tplTexts.some((t) => /^参考文献/.test(t)) || tplTexts.filter((t) => /^\[\d+\]/.test(t)).length >= 2
    }, summary }
}

// ===== 产出体检（v2.5.65：check_paper_format）=====
// "蒸馏→套用"处理不了内容级复杂度——套完后由程序对照规范书**逐项体检**（客观不漏项），
// 输出 issue 清单给 AI 逐条修正（AI 管语义层：引用上标/序号语义/措辞），修完复查直到清零。
const RED_COLOR_RE = /^(FF0000|C00000|EE0000|CD0000|D20000|E60000|FF0100|B22222|DC143C|8B0000|FF1A1A|RED)$/i
async function checkPaperFormat(paperPath, templatePath) {
  const spec = await extractPaperFormatSpec(templatePath)
  const parsed = await parseWordFormat(paperPath)
  const zip = await JSZip.loadAsync(fs.readFileSync(paperPath))
  const docXml = await zip.file('word/document.xml').async('string')
  const issues = []
  const add = (severity, item, detail, fix) => issues.push({ severity, item, detail, fix })

  // ① 说明性内容残留（模板说明书带进产出=高优）
  const redRunCount = [...docXml.matchAll(/<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<w:color w:val="(?:FF0000|C00000|EE0000|CD0000|D20000|E60000|FF0100|B22222|DC143C|8B0000)"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/gi)].length
  if (redRunCount) add('high', '红字残留', `${redRunCount} 处红色文字 run（模板说明书标红残留），正文应全部黑色`, 'apply_word_format picks 把这些段落 color 清掉，或 modify_word 处理')
  // 批注残留：docx 库生成的文档可能自带**空** comments.xml 部件——有实际 <w:comment> 才算残留
  const cmtPart = zip.file('word/comments.xml')
  if (cmtPart && /<w:comment\s[^>]*w:id=/.test(await cmtPart.async('string')))
    add('high', '批注残留', '产出里还带着模板批注', '重新跑 apply_word_template（新版自动剥批注）')
  const placeholderHits = [...docXml.matchAll(/<w:t[^>]*>([^<]*(?:XXX|××××|2024年X月|20××年)[^<]*)<\/w:t>/gi)].map((m) => m[1].trim()).slice(0, 3)
  if (placeholderHits.length) add('high', '示范占位符残留', `封面/正文还有模板示范值：${placeholderHits.join('；')}`, 'apply_word_template 传 cover 参数替换，或 modify_word 手改')

  // ② 角色格式核对（抽产出里的代表段 vs 规范书）
  // v2.5.66：body 期望值用**模板指纹**（spec.roles.body 会被多条 body 误判批注覆盖成五号——体检自己不能也错）
  const cmpFont = (expect, actual) => expect && actual && actual !== expect && actual !== 'Times New Roman' // 西文对中文字体名的兼容不算不符
  const checkRole = (role, findFn, label) => {
    const fmt = role === 'body' ? (spec.fingerprint && spec.fingerprint.body ? spec.fingerprint.body : spec.roles[role]) : spec.roles[role]
    if (!fmt || !Object.keys(fmt).length) return
    const hit = parsed.paragraphs.find(findFn)
    if (!hit) return
    const loc = `段落"${(hit.text || '').trim().slice(0, 18)}"`
    const actualFont = hit.run.eastAsiaFont || hit.run.font
    if (fmt.eastAsiaFont && actualFont && !actualFont.includes(fmt.eastAsiaFont) && cmpFont(fmt.eastAsiaFont, actualFont))
      add('medium', `${label}字体不符`, `期望 ${fmt.eastAsiaFont}，实际 ${actualFont}（${loc}）`, `apply_word_format picks 精准改该段 eastAsiaFont:"${fmt.eastAsiaFont}"`)
    if (fmt.sizePt && hit.run.sizePt && Math.abs(hit.run.sizePt - fmt.sizePt) > 0.6)
      add('medium', `${label}字号不符`, `期望 ${fmt.sizePt}pt，实际 ${hit.run.sizePt}pt（${loc}）`, `apply_word_format picks 精准改该段 sizePt:${fmt.sizePt}`)
    if (role === 'body' && fmt.indentFirstLine && !hit.para.indentFirstLine)
      add('medium', '正文首行缩进缺失', `期望首行缩进 ${fmt.indentFirstLine} 字符（${loc}）`, 'apply_word_format picks 改该段 indentFirstLine:2')
    if (role === 'body' && hit.para.align === 'center' && (hit.text || '').trim().length >= 30)
      add('medium', '正文段落被居中', `正文应两端对齐（${loc}）`, 'apply_word_format picks 改该段 align:"both"')
  }
  // v2.5.76：封面字段段（"学生姓名        学号"空格撑长≥30）、示范值残留段、原创性声明/授权页固定内容——都不算正文，排除防误报
  const coverFieldRe = /^(题\s*目|学\s*院|专\s*业|年\s*级|学\s*号|学生姓名|姓\s*名|指导教师|指导及评语教师|导师|教学站|作者（签名）|结稿日期|年\s+月|本人郑重声明|本毕业论文（设计）作者完全了解|本科毕业论文（设计）(原创性声明|版权使用授权书))/
  checkRole('body', (p) => p.role === 'normal' && (p.text || '').trim().length >= 30 && !coverFieldRe.test((p.text || '').trim()) && !/×××/.test(p.text || ''), '正文')
  checkRole('h1', (p) => p.role === 'h1', '一级标题')
  checkRole('h2', (p) => p.role === 'h2', '二级标题')
  checkRole('h3', (p) => p.role === 'h3', '三级标题')
  checkRole('keywords', (p) => /^关键词/.test((p.text || '').trim()), '关键词行')

  // ③ 引用上标：正文有 [数字] 文本但全文档无上标 run → 提示（内容级，AI 落实）
  // 排除以 [N] 开头的段落——那是参考文献条目本身，不是正文引用
  const bodyRefTexts = parsed.paragraphs.filter((p) => p.role === 'normal' && /\[\d+\]/.test(p.text || '') && !/^\s*\[\d+\]/.test((p.text || '').trim()))
  const hasSup = /<w:vertAlign w:val="superscript"\/>/.test(docXml)
  if (bodyRefTexts.length && !hasSup)
    add('medium', '正文引用未上标', `${bodyRefTexts.length} 段正文含 [数字] 引用标记（如"${(bodyRefTexts[0].text.match(/\[\d+\][^\s]{0,10}/) || ['[?]'])[0]}…"），规范要求右上角上标`, 'modify_word/apply_word_format 把 [数字] 设为上标（vertAlign superscript），并核对序号与参考文献一致')

  // ④ 序号连续性：相邻手动编号段跳号 → 提示
  let seq = []
  const seqCheck = () => {
    if (seq.length >= 3) {
      for (let i = 1; i < seq.length; i++) {
        if (seq[i].n !== seq[i - 1].n + 1) {
          add('medium', '序号跳号', `出现 ${seq[i - 1].n}. 之后紧跟 ${seq[i].n}.（缺 ${seq[i - 1].n + 1}，第 ${seq[i].idx + 1} 段附近）`, 'modify_word 修正序号连续性')
          break
        }
      }
    }
  }
  let prevIdx = -2
  for (const p of parsed.paragraphs) {
    const m = (p.text || '').trim().match(/^(\d+)[.、．]\s*\S/)
    if (m && p.role === 'normal' && p.idx === prevIdx + 1) seq.push({ idx: p.idx, n: parseInt(m[1]) })
    else { seqCheck(); seq = m && p.role === 'normal' ? [{ idx: p.idx, n: parseInt(m[1]) }] : [] }
    prevIdx = p.idx
  }
  seqCheck()

  // ⑤ 参考文献：有文献条目但无对应格式 → 粗查（条目段缩进）
  const refEntries = parsed.paragraphs.filter((p) => /^\[\d+\]/.test((p.text || '').trim()))
  if (refEntries.length && spec.roles.refsBody && spec.roles.refsBody.indentHanging) {
    add('low', `参考文献 ${refEntries.length} 条`, `规范要求 ${spec.roles.refsBody.eastAsiaFont || ''} ${spec.roles.refsBody.sizePt || ''}pt 悬挂缩进${spec.roles.refsBody.indentHanging}字符，请抽查前 2 条格式`, 'apply_word_format picks 批量改条目段')
  }

  // ⑥ v2.5.66：孤立符号/空符号段（素材论文的 bullet ○ 残留、意义不明符号）
  const symbolParas = parsed.paragraphs.filter((p) => {
    const t = (p.text || '').replace(/\s+/g, '')
    return t && /^([○●〇•▪◆·※※*·]|o)+$/.test(t) && t.length <= 6
  })
  if (symbolParas.length)
    add('high', '孤立符号段残留', `${symbolParas.length} 段只有"○/•"之类的列表符号没有内容（${symbolParas.slice(0, 2).map((p) => `"${p.text.trim()}"`).join('、')}…）——素材的空列表项残留，看起来像乱码`, 'modify_word edit 删除这些空符号段落')

  // ⑦ v2.5.66：结构完整性（**以模板板块为准**——模板有什么板块产出就该有什么；公司文档没摘要不报）
  const hasAbs = parsed.paragraphs.some((p) => /^摘\s*要/.test((p.text || '').trim()))
  const hasKw = parsed.paragraphs.some((p) => /^关键词/.test((p.text || '').trim()))
  const hasRefs = parsed.paragraphs.some((p) => /^参考文献/.test((p.text || '').trim()))
  const hasToc = / TOC /.test(docXml)
  const hasH1 = parsed.paragraphs.some((p) => p.role === 'h1')
  if (spec.hasSections && spec.hasSections.abstract && !hasAbs) add('high', '缺摘要板块', '模板有摘要节但产出里没有"摘 要"——论文原文可能没有摘要内容', '先 modify_word 给论文补摘要，再重新套模板')
  if (spec.hasSections && spec.hasSections.keywords && !hasKw) add('high', '缺关键词', '产出里没有"关键词："行', '先补关键词行再重新套模板')
  if (spec.hasSections && spec.hasSections.refs && !hasRefs) add('high', '缺参考文献', '产出里没有"参考文献"标题和条目', '先 modify_word 补参考文献条目（[1][2]…格式），再重新套模板')
  if (spec.hasTocSection && !hasH1) add('medium', '缺一级章节标题', '正文没有"第X章/一、"式章标题，目录和章节格式将无从谈起', '规范正文标题写法后重套')
  if (!hasToc && spec.hasTocSection) add('medium', '缺目录', '产出没有 TOC 目录域（模板有目录节时应自动插入）', 'modify_word 传入 toc:true 重新生成，或手动插入目录域')

  const sevOrder = { high: 0, medium: 1, low: 2 }
  issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])
  // v2.5.77：逐节对照进度表——每节显式 ✓/✗（没有问题的节也要亮 ✓，AI 才知道"这段过了可以下一段"；
  // 老大定的分段循环工作流：提取一段格式→改一段→本工具对比→PASS 才进下一段，正确 > 速度）
  const secOf = (item) => /示范占位符|红字|批注/.test(item) ? '封面'
    : /摘要/.test(item) ? '摘要'
    : /关键词/.test(item) ? '关键词'
    : /目录|一级章节标题/.test(item) ? '目录'
    : /^正文|序号|孤立符号/.test(item) ? '正文'
    : /参考文献/.test(item) ? '参考文献' : '其他'
  const secDefs = [
    ['封面', '无占位符/红字/批注残留', true],
    ['摘要', hasAbs ? '排头在位' : '模板有摘要节但产出没有', !!(spec.hasSections && spec.hasSections.abstract)],
    ['关键词', hasKw ? '关键词行在位' : '缺关键词行', !!(spec.hasSections && spec.hasSections.keywords)],
    ['目录', hasToc ? 'TOC 域在位' : '缺目录域', !!spec.hasTocSection],
    ['正文', hasH1 ? '章节结构可识别' : '缺一级章节标题', true],
    ['参考文献', hasRefs ? '标题在位' : '缺参考文献板块', !!(spec.hasSections && spec.hasSections.refs)]
  ]
  const progressLines = secDefs.map(([name, okDesc, apply]) => {
    if (!apply) return `  — ${name}：模板无此板块，不检查`
    const secIssues = issues.filter((x) => secOf(x.item) === name)
    return secIssues.length
      ? `  ✗ ${name}：${secIssues.length} 项待修（${secIssues.slice(0, 2).map((x) => x.item).join('、')}${secIssues.length > 2 ? ' 等' : ''}）`
      : `  ✓ ${name}：${okDesc}——已过，可进下一段`
  })
  const progress = `【逐节对照进度】（分段循环工作流：每节独立验证，✓ 才算过）\n${progressLines.join('\n')}\n`
  const summary = issues.length
    ? progress + `【产出体检】发现 ${issues.length} 项待修：\n` + issues.map((x, i) => `  ${i + 1}. [${x.severity}] ${x.item} —— ${x.detail}\n     ↳ 修法：${x.fix}`).join('\n') + '\n\n逐条修正后再跑一次 check_paper_format 复查，直到逐节全 ✓。'
    : progress + '【产出体检】0 项问题——格式与规范书一致，无需修正。'
  return { issues, summary, spec }
}

// ===== Word 格式套用引擎（参考 A 改 B：AI 传 rules，程序化 XML 精准套用，B 内容一字不动）=====

// AI 传来的格式对象 → OOXML 片段（严格按 ECMA-376 pPr 子元素顺序：spacing < ind < jc < outlineLvl < rPr）
function fmtToPPrXml(fmt) {
  const bits = []
  if (fmt.lineRatio || fmt.linePt != null) {
    if (fmt.lineRatio) bits.push(`<w:spacing w:line="${Math.round(fmt.lineRatio * 240)}" w:lineRule="auto"${fmt.beforePt != null ? ` w:before="${Math.round(fmt.beforePt * 20)}"` : ''}${fmt.afterPt != null ? ` w:after="${Math.round(fmt.afterPt * 20)}"` : ''}/>`)
    else bits.push(`<w:spacing w:line="${Math.round(parseFloat(fmt.linePt) * 20)}" w:lineRule="exact"${fmt.beforePt != null ? ` w:before="${Math.round(fmt.beforePt * 20)}"` : ''}${fmt.afterPt != null ? ` w:after="${Math.round(fmt.afterPt * 20)}"` : ''}/>`)
  } else if (fmt.beforePt != null || fmt.afterPt != null) {
    bits.push(`<w:spacing${fmt.beforePt != null ? ` w:before="${Math.round(fmt.beforePt * 20)}"` : ''}${fmt.afterPt != null ? ` w:after="${Math.round(fmt.afterPt * 20)}"` : ''}/>`)
  }
  if (fmt.indentFirstLine) bits.push(`<w:ind w:firstLineChars="${Math.round(fmt.indentFirstLine * 100)}" w:firstLine="${Math.round(fmt.indentFirstLine * 240)}"/>`)
  else if (fmt.indentHanging) bits.push(`<w:ind w:leftChars="${Math.round(fmt.indentHanging * 100)}" w:left="${Math.round(fmt.indentHanging * 240)}" w:hangingChars="${Math.round(fmt.indentHanging * 100)}" w:hanging="${Math.round(fmt.indentHanging * 240)}"/>`) // 悬挂缩进（参考文献条目）
  if (fmt.align) bits.push(`<w:jc w:val="${escapeXml(fmt.align)}"/>`)
  if (fmt.outlineLvl != null && fmt.outlineLvl >= 0 && fmt.outlineLvl <= 8) bits.push(`<w:outlineLvl w:val="${fmt.outlineLvl}"/>`)
  return bits.join('')
}
function fmtToRPrXml(fmt) {
  const bits = []
  if (fmt.font || fmt.eastAsiaFont) {
    const ascii = escapeXml(fmt.font || fmt.eastAsiaFont)
    const ea = escapeXml(fmt.eastAsiaFont || fmt.font)
    bits.push(`<w:rFonts w:ascii="${ascii}" w:hAnsi="${ascii}" w:eastAsia="${ea}"/>`)
  }
  if (fmt.bold) bits.push('<w:b/><w:bCs/>')
  if (fmt.italic) bits.push('<w:i/><w:iCs/>')
  if (fmt.underline) bits.push(`<w:u w:val="${escapeXml(fmt.underline === true ? 'single' : fmt.underline)}"/>`)
  if (fmt.strike) bits.push('<w:strike/>')
  if (fmt.color) bits.push(`<w:color w:val="${escapeXml(String(fmt.color).replace(/^#/, ''))}"/>`)
  if (fmt.shade) bits.push(`<w:shd w:val="clear" w:fill="${escapeXml(String(fmt.shade).replace(/^#/, ''))}"/>`)
  if (fmt.sizePt) bits.push(`<w:sz w:val="${Math.round(fmt.sizePt * 2)}"/><w:szCs w:val="${Math.round(fmt.sizePt * 2)}"/>`)
  return bits.length ? `<w:rPr>${bits.join('')}</w:rPr>` : ''
}

// rules 规范化：{ map:{role:'source'|fmt}, picks:[{match, role?, format?}] } 两种形态可混用
function normApplyRules(rules) {
  const out = { map: {}, picks: [] }
  if (!rules || typeof rules !== 'object') return out
  const src = rules.map || rules
  for (const role of ['title', 'h1', 'h2', 'h3', 'quote', 'list', 'body']) {
    const v = src[role]
    if (v === undefined) continue
    if (v === 'source' || (v && typeof v === 'object' && !Array.isArray(v))) out.map[role] = v
  }
  const picks = Array.isArray(rules.picks) ? rules.picks : (Array.isArray(rules) ? rules : [])
  for (const p of picks) {
    if (!p || !p.match) continue
    out.picks.push({ match: String(p.match), role: p.role || null, format: p.format && typeof p.format === 'object' ? p.format : null })
  }
  return out
}

// 'source' 解析：从 A 的指纹取角色格式（缺角色降级 body）
function resolveSourceFmt(role, v, sourceFp) {
  if (v !== 'source') return v
  if (!sourceFp) return null
  const pick = sourceFp[role] || sourceFp.body
  return pick && Object.keys(pick).length ? pick : null
}

// 主入口：把格式套用到目标 Word（内容一字不动，只动 pPr/rPr）
// sourcePath(A 文档) 用于 rules 里 'source' 的格式来源，可空（全显式 format 时）
async function applyWordFormat(targetPath, sourcePath, rules) {
  const { map, picks } = normApplyRules(rules)
  if (!Object.keys(map).length && !picks.length) throw new Error('rules 为空：传 { map:{ h1:"source", h2:"source", body:"source" } } 或 { picks:[{ match:"段落文字", format:{...} }] }（两种可混用）')
  let sourceFp = null
  if (Object.keys(map).some((k) => map[k] === 'source')) {
    if (!sourcePath) throw new Error('rules 里用了 "source" 但没传 formatPath（A 文档路径），无法读取参考格式')
    sourceFp = wordFormatFingerprint(await parseWordFormat(sourcePath)).fingerprint
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(targetPath))
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('不是有效的 Word 文档（缺少 document.xml）')
  const xml = await docFile.async('string')

  // B 的样式表（map 模式判定段落角色用）
  const stylesFile = zip.file('word/styles.xml')
  const stylesCtx = parseStylesXml(stylesFile ? parseXmlDoc(await stylesFile.async('string')) : null)

  // 字符串扫描所有段落块（含自闭合空段占位），tblDepth 追踪表格嵌套
  const blockRe = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  const tblRe = /<\/?w:tbl(?:\s[^>]*)?>/g
  const applied = []
  const missedPicks = picks.map((p) => p.match)
  let outXml = ''
  let lastEnd = 0
  let tblDepth = 0
  let m
  const posList = []
  while ((m = blockRe.exec(xml))) {
    posList.push({ start: m.index, end: m.index + m[0].length, block: m[0] })
  }
  for (let pi = 0; pi < posList.length; pi++) {
    const pos = posList[pi]
    // 追踪表格深度：统计上一个块结束点到当前块开始点之间的 tbl 开闭标签
    const prevEnd = pi === 0 ? 0 : posList[pi - 1].end
    const seg = xml.slice(prevEnd, pos.start)
    let segT
    tblRe.lastIndex = 0
    while ((segT = tblRe.exec(seg))) {
      if (segT[0].startsWith('</')) tblDepth = Math.max(0, tblDepth - 1)
      else tblDepth++
    }
    const inTable = tblDepth > 0
    let newBlock = pos.block
    if (!/<\/w:p>/.test(pos.block)) { outXml += xml.slice(lastEnd, pos.end); lastEnd = pos.end; continue } // 自闭合空段不动
    const pEl = parseXmlDoc(pos.block).documentElement
    const text = paraText(pEl).trim()
    const pPrEl = pEl.getElementsByTagName('w:pPr')[0] || null
    const role = inTable ? null : detectRole(readPPr(pPrEl), stylesCtx)
    const pDirect = readPPr(pPrEl)

    // 命中判定：picks 按文字（含匹配即中）；map 按角色（表格内段落不参与角色映射，保表格样式）
    let hitFmt = null
    let hitTag = null
    for (const pk of picks) {
      if (text && text.includes(pk.match)) {
        const f = pk.format || resolveSourceFmt(pk.role, 'source', sourceFp)
        if (f) {
          hitFmt = f
          hitTag = `pick:「${pk.match.slice(0, 20)}」`
          const mi = missedPicks.indexOf(pk.match)
          if (mi >= 0) missedPicks.splice(mi, 1)
        }
        break
      }
    }
    if (!hitFmt && role) {
      const mapKey = role === 'normal' ? 'body' : role // rules 键名 body ↔ 角色名 normal
      if (map[mapKey]) {
        const f = resolveSourceFmt(mapKey, map[mapKey], sourceFp)
        if (f) { hitFmt = f; hitTag = mapKey }
      }
    }

    if (hitFmt && text) {
      // ① 段落 pPr 重组：删旧 spacing/ind/jc/outlineLvl/rPr → 按 schema 顺序插新
      let inner = null
      if (pPrEl) {
        const s = pos.block.indexOf('>', pos.block.indexOf('<w:pPr')) + 1
        const e = pos.block.indexOf('</w:pPr>', s)
        inner = pos.block.slice(s, e)
          .replace(/<w:spacing[^>]*\/>/g, '')
          .replace(/<w:ind[^>]*\/>/g, '')
          .replace(/<w:jc[^>]*\/>/g, '')
          .replace(/<w:outlineLvl[^>]*\/>/g, '')
          .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '')
      }
      const insertBits = fmtToPPrXml(hitFmt)
      // 角色是标题族且原段无 outlineLvl → 补大纲级别（导航窗格可识别）
      const ol = /^h[123]$/.test(hitTag) ? { h1: 0, h2: 1, h3: 2 }[hitTag] : null
      const extraOl = ol != null && !/<w:outlineLvl/.test(insertBits) && pDirect && pDirect.outlineLvl == null ? `<w:outlineLvl w:val="${ol}"/>` : ''
      const newInner = inner + insertBits + extraOl
      const pprXml = `<w:pPr>${newInner}${fmtToRPrXml(hitFmt)}</w:pPr>`
      if (pPrEl) newBlock = newBlock.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, pprXml)
      else newBlock = newBlock.replace(/(<w:p(?:\s[^>]*)?>)/, `$1${pprXml}`)
      // ② 每个文本 run 的 rPr 替换（rPr 必须是 run 首子元素；非文本 run 不动）
      newBlock = newBlock.replace(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g, (rm, rInner) => {
        if (!/<w:t[\s>]/.test(rInner)) return rm
        const stripped = rInner.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '')
        return `<w:r>${fmtToRPrXml(hitFmt)}${stripped}</w:r>`
      })
      applied.push({ role: hitTag, text: text.slice(0, 40) })
    }
    outXml += xml.slice(lastEnd, pos.start) + newBlock
    lastEnd = pos.end
  }
  outXml += xml.slice(lastEnd)

  if (!applied.length) {
    throw new Error(`没有段落被套用：${missedPicks.length ? `picks 文字没匹配上（${missedPicks.slice(0, 3).join('、')}）` : 'map 里没有任何角色命中文档段落'}。可先 read_word 看目标文档实际文字，match 用段落开头连续文字`)
  }
  zip.file('word/document.xml', outXml)
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(targetPath, buf)
  return { applied, missedPicks, size: buf.length }
}

// ===== Word 模板嫁接引擎（v2.5.5）：学校模板出骨架（分节+页眉页脚+封面+罗马/阿拉伯页码分区），论文出血肉 =====
// 背景：apply_word_format 只能套段落格式，扛不住论文模板的"结构级格式"——分节页眉页脚、页码分区、
// 填空式封面、三线表。AI 生成稿的通病（Normal(Web) 网页样式 + Segoe UI 中文字体 + 0F1111 网页色 + 单节无页眉）
// 靠逐段套格式永远修不齐，必须整体嫁接。思路学 browser-docx-merger 的 rels/media 映射，自研不引库。

// top-level 块扫描：body 内部切成 [{type:'p'|'tbl'|'sect'|'other', xml, text}]
// 自闭合空段也保留（防块错位，v2.4.95 教训）；表格整体一个块（不深入表格内段落）
function scanTopBlocks(bodyInner) {
  const blocks = []
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>|<w:sectPr(?:\s[^>]*)?\/>/g
  let m
  while ((m = re.exec(bodyInner))) {
    const xml = m[0]
    const type = xml.startsWith('<w:tbl') ? 'tbl' : xml.startsWith('<w:sectPr') ? 'sect' : 'p'
    let text = ''
    if (type === 'p') {
      // v2.5.78：<w:br/> 软换行映射成 \n（"1.1 标题\n正文"挤同段时 softbreakSplitBlocks 才有行可拆；
      // <w:br w:type="page"/> 分页符不映射）；paraText（linkedom 路径）同步处理
      text = decodeEntities((xml.match(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br(?:\s[^>]*)?\/>/g) || [])
        .map((t) => (t.startsWith('<w:br') ? (/w:type="page"/.test(t) ? '' : '\n') : t.replace(/<[^>]+>/g, '')))
        .join(''))
    }
    blocks.push({ type, xml, text })
  }
  return blocks
}

// v2.5.76：模板"格式说明示范段"识别——说明书式模板（真正的结构排头不存在，全靠示范内容撑着）
// 覆盖形态："三号黑体，居中"/"小四号宋体"/"空一行"/"空一格"/"Times New Roman,三号粗，居中"/
// "用罗马字母编号号"/"3～5个，关键词用一个空格分隔，小四号宋体"/"右缩进两个字"/"……"/"第二……"
// 仅用于模板侧（classifyTplSection 过滤 + cover 节剔除）——绝不碰论文自己的内容
function isFormatDemoPara(text) {
  const t = (text || '').trim()
  if (!t) return false
  if (/^[…\.]{2,}$/.test(t)) return true // 示范省略段"……"
  if (/^第[一二三四五六七八九十百0-9]+[…\.]{2,}$/.test(t)) return true // 示范章标题"第二……"
  if (t.length > 40) return false
  // 强信号：号数/字体/版式指令词——至少命中一个才继续（防误杀正文）
  if (!/(?:[一二三四五六小初](?:十)?[一二三四五六小初]?号|黑体|宋体|楷体|仿宋|隶书|Times|New|Roman|行距|空一|空二|另起|页眉|页脚|页码|编号|编序|上标|下标|缩进|空格|罗马|居中|左对齐|右对齐|两端对齐|下划线|加粗|分号|分隔|～)/.test(t)) return false
  // 全段必须由版式词组成（允许标点/空白/数字）——正文真句子不会全命中
  return /^(?:[一二三四五六小初](?:十)?[一二三四五六小初]?号|黑体|宋体|楷体|仿宋|隶书|华文|行楷|方正|小标宋|粗|加粗|斜体|居中|居左|居右|左对齐|右对齐|两端对齐|下划线|上标|下标|行距|倍|磅|字|字符|个|空一格|空一行|空一页|空两格|空格|另起|一页|页眉|页脚|页码|号|之下|之上|罗马|字母|数字|中文|英文|汉字|表格|图|逐章|单独|编序|编号|序号|缩进|右缩进|左缩进|两|一|有|条|宋|黑|楷|仿|分隔|分号|逗号|用|按|和|与|及|之|的|为|是|或|种|至|到|～|…|。|，|,|\.|、|\/|;|；|:|：|-|—|\s|\d|关键词|Keywords?|摘要|目录|参考文献|致谢|题目|标题|正文|左右|不少于|页|Times|New|Roman)+$/.test(t)
}

// 模板节归属：按节内段落判断 → cover|abstract|enAbstract|toc|body|thanks|refs
// v2.5.76 两大增强：①格式说明示范段先过滤再判（"三号黑体，居中"给每节开路会把判定全打瞎成 cover）
// ②说明书式模板没有结构排头——靠内容特征识别：目录条目（"……页码"引导点≥3）/关键词行/Keywords 行/
//   文献条目（[1][2]≥2）/编号标题（"1.""（一）"≥2）——示范内容所在的节正是论文对应内容该去的位置
function classifyTplSection(paras, prevKind) {
  const nonEmpty = paras.filter((p) => p.text && p.text.trim() && !isFormatDemoPara(p.text))
  const texts = nonEmpty.map((p) => p.text.trim())
  const first = texts[0] || ''
  if (/^目\s*录/.test(first)) return 'toc'
  // 目录条目特征：≥3 段"文字……页码"引导点（含罗马页码）——先去空格防". …"中缀形态漏匹配
  const tocEntries = texts.filter((t) => /^[^…]{1,40}[…\. ]{3,}[0-9IVXivx]{1,4}$/.test(t.replace(/\s+/g, '')))
  if (tocEntries.length >= 3 || (prevKind === 'toc' && tocEntries.length >= 1)) return 'toc'
  if (prevKind === 'toc' && /^\d+(\.\d+)*\s+\S+\s*\d+$/.test(first)) return 'toc'
  if (nonEmpty.some((p) => /^摘\s*要/.test(p.text.trim()))) return 'abstract'
  if (nonEmpty.some((p) => /^关键词[:：]/.test(p.text.trim()))) return 'abstract'
  if (nonEmpty.some((p) => /^(Abstract|Key\s*words?)\b/i.test(p.text.trim()))) return 'enAbstract'
  if (/^致\s*谢/.test(first)) return 'thanks'
  if (/^参考文献/.test(first)) return 'refs'
  // 文献条目特征：[1][2]… 示范条目（排头缺失时靠条目识别）
  if (texts.filter((t) => /^\[\d+\]/.test(t)).length >= 2) return 'refs'
  if (/^(第[一二三四五六七八九十百0-9]+[章]|引\s*言|绪\s*论|一\s*、|\d+\s+\S)/.test(first)) return 'body'
  // 编号标题特征：示范正文节（"1.员工绩效考核含义"“（一）xxx”各≥2——模板示范正文所在的节=论文正文该插的位置）
  if (texts.filter((t) => /^\d+[\.、]\s*\S/.test(t)).length >= 2 || texts.filter((t) => /^[（(][一二三四五六七八九十0-9]+[）)]/.test(t)).length >= 2) return 'body'
  return 'cover'
}

// 模板切节：top-level 块流 → [{kind, paras:[{xml,text}], sectPr(该节页设置XML，含页眉页脚引用)}]
function splitTplSections(tplDocXml) {
  const bodyOpen = tplDocXml.match(/<w:body(?:\s[^>]*)?>/)
  if (!bodyOpen) return []
  const bodyInner = tplDocXml.slice(bodyOpen.index + bodyOpen[0].length, tplDocXml.lastIndexOf('</w:body>'))
  const blocks = scanTopBlocks(bodyInner)
  const sections = []
  let cur = { paras: [], sectPr: null }
  const flush = () => {
    if (cur.paras.length || cur.sectPr) {
      cur.kind = classifyTplSection(cur.paras, sections.length ? sections[sections.length - 1].kind : null)
      sections.push(cur)
    }
  }
  for (const b of blocks) {
    if (b.type === 'sect') { cur.sectPr = b.xml; flush(); cur = { paras: [], sectPr: null } }
    else if (b.type === 'p' && /<w:sectPr[\s>]/.test(b.xml)) {
      // 段内 sectPr：节分隔段——抽 sectPr，段落本身一般无正文，丢弃
      cur.sectPr = (b.xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/) || [null])[0] || cur.sectPr
      if (b.text.trim()) cur.paras.push({ xml: b.xml.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/, ''), text: b.text })
      flush(); cur = { paras: [], sectPr: null }
    } else cur.paras.push({ xml: b.xml, text: b.text })
  }
  flush()
  return sections
}

// 论文章节标题角色判定（短段 + 编号模式）→ h1|h2|h3|null
// 体系A：第X章=h1 / 1.1=h2 / 1.1.1=h3；体系B：一、=h1 /（一）=h2
function paperHeadingRole(text) {
  const t = (text || '').trim()
  if (!t || t.length > 30) return null
  if (/^(第[一二三四五六七八九十百0-9]+章|引\s*言|绪\s*论|结\s*论|参考文献|致\s*谢|附\s*录|结\s*语)/.test(t)) return 'h1'
  if (/^[一二三四五六七八九十]+、/.test(t)) return 'h1'
  if (/^\d+\.\d+\.\d+(?!\.?\d)/.test(t)) return 'h3'
  if (/^\d+\.\d+(?!\.?\d)/.test(t)) return 'h2'
  if (/^[（(][一二三四五六七八九十0-9]+[）)]/.test(t)) return 'h2'
  return null
}

// 单级编号短行（"1. 理论意义"式）→ h3：模板 h3 示范是 1.3.1 式，但论文常用单级式；
// 只在软换行拆段场景生效，不动 paperHeadingRole（防正文自动编号列表被误判）；句末带标点的排除（列表项"1. 打开设置。"不套）
function singleLevelHeadRole(t) {
  return /^\d{1,2}[.、]\s*\S{1,15}$/.test(t || '') && !/[。，；,.;：:]$/.test(t.trim()) ? 'h3' : null
}

// v2.5.78：软换行拆段——网页转来的论文常把"1.1 研究背景"小节标题和正文挤在同一段（w:br 软换行），
// 标题排成正文样式 + 目录抓不到章节。仅当"段落含 <w:br 换行 且 首行是标题"才拆（<w:br w:type="page" 分页符不拆），
// 全部行重建为纯段（含首行——b.xml 是整段全部文字，复用会"合并段+拆出段"重复；正文块下游统一 reformatParaXml 套模板格式，原式不保）；
// 识别不出标题的多行段（诗歌/地址等）原样保留
function softbreakSplitBlocks(bodyBlocks) {
  const out = []
  for (const b of bodyBlocks) {
    // 用首行判标题（paperHeadingRole 有 30 字上限，合并段全文超限会漏判）；
    // "2. 实践意义"式单级编号短行（paperHeadingRole 不认，防误伤正文自动编号列表不改它）也允许拆——
    // 否则同层兄弟行（搭"1.2 研究意义"车拆出的"1. 理论意义"）独立了它还挤在正文段，不一致
    const firstLine = (b.text || '').split('\n')[0].trim()
    const headRole = paperHeadingRole(firstLine) || singleLevelHeadRole(firstLine)
    if (b.type !== 'p' || !/<w:br(?![^>]*w:type="page")[^>]*\/>/.test(b.xml) || !headRole) { out.push(b); continue }
    const lines = b.text.split(/\n/)
    const head = lines[0].trim()
    out.push({ type: 'p', xml: buildParaXml(head, {}), text: head, role: headRole })
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].trim()
      if (t) out.push({ type: 'p', xml: buildParaXml(t, {}), text: t, role: singleLevelHeadRole(t) || undefined })
    }
  }
  return out
}

// 论文内容提取：题目/摘要正文/关键词/正文块（从第一个章标题起，剔除论文自己的 sectPr）
function extractPaperContent(paperDocXml) {
  const bodyOpen = paperDocXml.match(/<w:body(?:\s[^>]*)?>/)
  if (!bodyOpen) return { title: '', absParas: [], kwText: '', bodyBlocks: [] }
  const bodyInner = paperDocXml.slice(bodyOpen.index + bodyOpen[0].length, paperDocXml.lastIndexOf('</w:body>'))
  const blocks = scanTopBlocks(bodyInner).filter((b) => b.type !== 'sect' && !/<w:sectPr[\s>]/.test(b.xml))
  let title = ''
  let absStart = -1
  let kwText = ''
  // 摘要区：题目段/摘要段起 → 第一个章标题前
  for (let i = 0; i < blocks.length; i++) {
    const t = blocks[i].text.trim()
    if (!t) continue
    if (!title && /论文题目|题目[:：]/.test(t)) { title = t.replace(/^.*?题目[:：]\s*/, '').trim(); absStart = i + 1; continue }
    if (/^摘\s*要/.test(t)) { absStart = i; break }
  }
  const absParas = []
  if (absStart >= 0) {
    for (let i = absStart; i < blocks.length; i++) {
      const t = blocks[i].text.trim()
      if (!t) continue
      if (/^关键词/.test(t)) { kwText = t.replace(/^关键词[:：]?\s*/, '').trim(); break }
      if (paperHeadingRole(t)) break // 没有关键词行，遇到正文标题就停
      const v = t.replace(/^摘\s*要[:：]?\s*/, '').trim()
      if (v) absParas.push(v)
    }
  }
  // 正文：第一个章标题段起（找不到章标题时退化为摘要区之后全部）
  let bodyStart = blocks.findIndex((b) => b.type === 'p' && paperHeadingRole(b.text))
  if (bodyStart < 0) bodyStart = absStart >= 0 ? absStart + absParas.length + (kwText ? 1 : 0) : 0
  const bodyBlocks = blocks.slice(bodyStart >= 0 ? bodyStart : 0)
  // 英文摘要（可选）：Abstract 段起 → Key words 行止。仅扫正文开始前的前置区
  //（防正文段落以 "Abstract" 开头误命中），判定以"有没有 Abstract 段"为准（只有一行+关键词也算有）
  let enStart = -1
  for (let i = 0; i < bodyStart; i++) {
    const t = blocks[i].text.trim()
    if (/^Abstract(\s*[:：]|$)/i.test(t)) { enStart = i; break }
  }
  const enAbstractParas = []
  let enKwText = ''
  if (enStart >= 0) {
    // 从 Abstract 段自身起收集（合并段"Abstract: 内容…"的内容不能丢），剥掉排头前缀
    for (let i = enStart; i < bodyStart; i++) {
      const t = blocks[i].text.trim()
      if (!t) continue
      if (/^Key\s*words?\b/i.test(t)) { enKwText = t.replace(/^Key\s*words?\b[:：]?\s*/i, '').trim(); break }
      if (i > enStart && (paperHeadingRole(t) || /^\d+(\.\d+)*\s+\S/.test(t))) break
      const v = t.replace(/^Abstract\s*[:：]?\s*/i, '').trim()
      if (v) enAbstractParas.push(v)
    }
  }
  return { title, absParas: absParas.filter(Boolean), kwText, enAbstractParas, enKwText, hasEnAbstract: enStart >= 0, bodyBlocks }
}

// v2.5.64/v2.5.66：论文自动编号（w:numPr）→ 手动编号文字；bullet 空符号段清理——
// 论文自带 numbering 引用在迁入模板后常断链/重编号导致序号混乱（图3：1.~10. 与内容分离错乱）；
// 素材论文的 bullet（○ 符号）空列表段迁移后成孤立圆圈（图1）。
// 规则：decimal 单级列表 → 序号写进段首（去 numPr）；bullet → 空文字段整段删、有文字的剥符号转普通段；
// 其他格式（中文序号/多级）保留 numPr 原样。返回数组可含 null（已删段），调用方需 filter(Boolean)。
function convertNumPrToText(blocks, numberingXml) {
  if (!blocks.some((b) => b.type === 'p' && /<w:numPr>/.test(b.xml))) return blocks
  // numId → abstractNumId → lvl0 numFmt/lvlText
  const num2abs = {}
  for (const m of (numberingXml || '').matchAll(/<w:num [^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"[^>]*\/>/g)) num2abs[m[1]] = m[2]
  const absInfo = {}
  for (const m of (numberingXml || '').matchAll(/<w:abstractNum [^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const lvl0 = (m[2].match(/<w:lvl w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/) || [])[1] || ''
    absInfo[m[1]] = {
      fmt: (lvl0.match(/<w:numFmt w:val="([^"]+)"\/>/) || [])[1] || '',
      text: (lvl0.match(/<w:lvlText w:val="([^"]+)"\/>/) || [])[1] || '%1.'
    }
  }
  const counters = {}
  const cnNum = (n) => '一二三四五六七八九十'[n - 1] || String(n)
  const out = []
  for (const b of blocks) {
    if (b.type !== 'p' || !/<w:numPr>/.test(b.xml)) { out.push(b); continue }
    const numId = (b.xml.match(/<w:numId w:val="(\d+)"[^>]*\/>/) || [])[1]
    const ilvl = (b.xml.match(/<w:ilvl w:val="(\d+)"[^>]*\/>/) || [])[1] || '0'
    if (!numId || ilvl !== '0') { out.push(b); continue } // 多级列表不转（层级缩进语义复杂，保留原样）
    const abs = absInfo[num2abs[numId]]
    if (abs && abs.fmt === 'decimal') {
      counters[numId] = (counters[numId] || 0) + 1
      const prefix = String(abs.text).replace('%1', String(counters[numId])).replace('%2', cnNum(counters[numId])) + ' '
      let xml = b.xml.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '')
      let first = true
      xml = xml.replace(/(<w:t[^>]*>)([^<]*)(<\/w:t>)/, (wm, a, b2, c) => {
        if (!first) return wm
        first = false
        return `${a}${escapeXml(prefix)}${b2}${c}`
      })
      out.push({ ...b, xml })
      continue
    }
    if (abs && abs.fmt === 'bullet') {
      // bullet 符号（○•▪）没有编号语义：空文字段=垃圾符号段整段删；有文字的剥 numPr 转普通段落
      if (!(b.text || '').trim()) continue // → null，调用方 filter 掉
      out.push({ ...b, xml: b.xml.replace(/<w:numPr>[\s\S]*?<\/w:numPr>/, '') })
      continue
    }
    out.push(b) // 其他格式（中文/字母序号）保留
  }
  return out
}

// 段落重格式化（内容不动，pPr/rPr 全换）：删 pStyle/spacing/ind/jc/outlineLvl/shd/段内rPr（保 numPr 列表编号），
// run 级 rPr 全替换——**不含 w:t 的 run（w:br/w:tab/w:cr/空 run）也要换**（控制符 run 是网页字体/色残留重灾区）；
// 图片等内容 run（drawing/pict/object）整体不动
function reformatParaXml(block, fmt, outlineLvl) {
  const pprMatch = block.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
  let inner = pprMatch ? pprMatch[1] : ''
  inner = inner
    .replace(/<w:pStyle[^>]*\/>/g, '')
    .replace(/<w:spacing[^>]*\/>/g, '')
    .replace(/<w:ind[^>]*\/>/g, '')
    .replace(/<w:jc[^>]*\/>/g, '')
    .replace(/<w:outlineLvl[^>]*\/>/g, '')
    .replace(/<w:shd[^>]*\/>/g, '')
    .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/g, '')
  const ol = outlineLvl != null ? `<w:outlineLvl w:val="${outlineLvl}"/>` : ''
  const newPpr = `<w:pPr>${inner}${fmtToPPrXml(fmt)}${ol}${fmtToRPrXml(fmt)}</w:pPr>`
  let out = pprMatch ? block.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, newPpr) : block.replace(/(<w:p(?:\s[^>]*)?>)/, `$1${newPpr}`)
  out = out.replace(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g, (rm, rInner) => {
    if (/<w:drawing|<w:object/.test(rInner)) return rm
    // VML 图形 run（论文 --- 分隔线=VML 横线）：rPr 无视觉作用照删，VML 填充色统一 auto（黑线）——
    // 网页色 0F1115 藏在 fillcolor 里，文本 run 清不干净的就是它
    const stripped = rInner
      .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '')
      .replace(/fillcolor="#[0-9A-Fa-f]{6}"/g, 'fillcolor="auto"')
    return `<w:r>${fmtToRPrXml(fmt)}${stripped}</w:r>`
  })
  return out
}

// 造新段落：<w:p>单文本run</w:p> → 套格式
function buildParaXml(text, fmt, opts = {}) {
  const runs = opts.runs || [{ text, rPr: fmtToRPrXml(fmt) }]
  const runXml = runs.map((r) => `<w:r>${r.rPr || ''}<w:t xml:space="preserve">${escapeXml(r.text)}</w:t></w:r>`).join('')
  const ol = opts.outlineLvl != null ? `<w:outlineLvl w:val="${opts.outlineLvl}"/>` : ''
  const ppr = `<w:pPr>${opts.align !== undefined || fmt.align ? `<w:jc w:val="${escapeXml(opts.align || fmt.align || 'left')}"/>` : ''}${ol}${fmtToRPrXml(fmt)}</w:pPr>`
  return `<w:p>${ppr}${runXml}</w:p>`
}

// 保模板原段格式、换文本：pPr 原样 + 第一个文本 run 的 rPr + 单 run 新文本
// 用途：模板"摘 要：示范内容…"合并段拆出纯排头"摘  要"（格式保真，示范文本丢弃）
function rebuildParaWithText(block, text) {
  const pprM = block.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)
  const ppr = pprM ? pprM[0] : ''
  let rpr = ''
  const rM = block.match(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/)
  if (rM) { const rm = rM[1].match(/<w:rPr>[\s\S]*?<\/w:rPr>/); rpr = rm ? rm[0] : '' }
  return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

// 表格三线化：删 tblStyle 引用（论文表样式 id 在模板样式表里不存在）→ 显式顶/底线 1.5 磅，其余无；
// 单元格黑底填充(shd)/旧单元格边框(tcBorders)全清（网页风黑底表格残留主源）；
// 首行每格补 0.75 磅底线=三线表栏目线（tcBorders 按 schema 顺序插在 tcW/gridSpan/vMerge 之后）；
// 表内段落套正文格式（无缩进），首行加粗
function triLineTableXml(tblXml, bodyFmt) {
  let out = tblXml.replace(/<w:tblStyle[^>]*\/>/g, '')
  const borders = '<w:tblBorders><w:top w:val="single" w:color="auto" w:sz="12" w:space="0"/><w:left w:val="none" w:color="auto" w:sz="0" w:space="0"/><w:bottom w:val="single" w:color="auto" w:sz="12" w:space="0"/><w:right w:val="none" w:color="auto" w:sz="0" w:space="0"/><w:insideH w:val="none" w:color="auto" w:sz="0" w:space="0"/><w:insideV w:val="none" w:color="auto" w:sz="0" w:space="0"/></w:tblBorders>'
  if (/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/.test(out)) out = out.replace(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/, borders)
  else out = out.replace(/(<w:tblPr>)/, `$1${borders}`)
  out = out.replace(/<w:shd[^>]*\/>/g, '').replace(/<w:tcBorders>[\s\S]*?<\/w:tcBorders>/g, '')
  // 表内段落：首行(tr)加粗，全部套正文格式但去首行缩进；首行每格补栏目线
  let firstRow = true
  out = out.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (tr) => {
    const cellFmt = { ...bodyFmt, indentFirstLine: null, align: 'center', bold: firstRow }
    let r = tr.replace(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
      const hasText = /<w:t[\s>]/.test(p)
      if (!hasText) return p
      return reformatParaXml(p, cellFmt, null)
    })
    if (firstRow) {
      const bd = '<w:tcBorders><w:bottom w:val="single" w:color="auto" w:sz="6" w:space="0"/></w:tcBorders>'
      r = r.replace(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g, (tc, tcInner) => {
        if (!/<w:tcPr>/.test(tcInner)) return tc.replace(/(<w:tc(?:\s[^>]*)?>)/, `$1<w:tcPr>${bd}</w:tcPr>`)
        return tc.replace(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/, (tm, pr) => {
          // ECMA-376 CT_TcPr 顺序：tcBorders 必须排在 tcW/gridSpan/hMerge/vMerge 之后
          const re2 = /<w:tcW[^>]*\/>|<w:gridSpan[^>]*\/>|<w:vMerge[^>]*\/>|<w:hMerge[^>]*\/>/g
          let lastEnd = 0, mm
          while ((mm = re2.exec(pr))) lastEnd = re2.lastIndex
          return '<w:tcPr>' + pr.slice(0, lastEnd) + bd + pr.slice(lastEnd) + '</w:tcPr>'
        })
      })
    }
    firstRow = false
    return r
  })
  return out
}

// TOC 域段（dirty 打开自动提示更新；占位文本兜底手点）
function buildTocParaXml(bodyFmt) {
  const rpr = fmtToRPrXml({ ...bodyFmt, indentFirstLine: null })
  return `<w:p><w:pPr>${rpr}</w:pPr>` +
    '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r>${rpr}<w:t>（目录域：打开文档后若未自动生成，右键此处选「更新域」）</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
}

// 封面字段替换：按标签匹配段落文本（"学    院           网络与继续教育学院     "）→ 重写 w:t，空格骨架尽力保留
const COVER_LABELS = [
  ['title', /题\s*目/, ''], ['college', /学\s*院|教学站/, '学院'], ['major', /专\s*业/, '专业'],
  ['grade', /年\s*级/, '年级'], ['studentId', /学\s*号/, '学号'], ['name', /学生姓名|姓\s*名/, '学生姓名'],
  ['advisor', /指导教师|指导及评语教师|导师/, '指导教师'], ['date', /结稿日期|日期|年\s*月/, '结稿日期']
]
function replaceCoverFields(coverParas, cover) {
  if (!cover || typeof cover !== 'object') return { paras: coverParas, replaced: [] }
  // v2.5.64：新值写进"值 run"（保住值 run 的 rPr——下划线 u:thick 在值 run 上，此前写进标签 run 导致下划线丢失）
  // 结构：标签 run（"中文题目："）+ 值 run（示范值/空，带下划线）；单 run 字段行（标签+值同 run）也可用
  function rewriteRuns(block, preLen, newVal) {
    const ts = []
    let tmp = block.replace(/(<w:t[^>]*>)([^<]*)(<\/w:t>)/g, (wm, a, b, c) => { ts.push({ a, b, c }); return `\u0000${ts.length - 1}\u0000` })
    if (!ts.length) return block
    // 定位值区起点 preLen（"前缀+标签+：/空格"字符数）落在哪个 w:t；恰好落在 run 末尾则值写下一个 run
    let acc = 0, valueIdx = ts.length - 1
    for (let i = 0; i < ts.length; i++) {
      if (acc + ts[i].b.length >= preLen) { valueIdx = (acc + ts[i].b.length === preLen && i + 1 < ts.length) ? i + 1 : i; break }
      acc += ts[i].b.length
    }
    const carry = preLen - ts.slice(0, valueIdx).reduce((s, t) => s + t.b.length, 0)
    ts.forEach((t, i) => {
      if (i < valueIdx) return
      if (i === valueIdx) t.b = t.b.slice(0, Math.max(0, carry)) + escapeXml(String(newVal))
      else t.b = ''
    })
    return tmp.replace(/\u0000(\d+)\u0000/g, (wm, i) => ts[+i].a + ts[+i].b + ts[+i].c)
  }
  // v2.5.78：只认"字段行"——前缀除空白/标点/「中文|英文|外文」排头词外不得含实质文字（否则承诺书正文里的
  // "指导教师"会被误当字段行，值区覆盖把整段声明截成 29 字+"李四"）；无标签的手签行（"年 月 日"，模板批注
  // 要求手写）不自动填日期
  const FIELD_LINE_OK = /^(?:中文|英文|外文)?[：:、，。．.\s]*$/
  const replaced = []
  const out = coverParas.map((p) => {
    let block = p.xml
    for (const [key, re] of COVER_LABELS) {
      const val = cover[key]
      if (!val || !re.test(p.text)) continue
      const old = p.text
      // 前缀长度：标签前缀(原样，如"中文题目：") + 标签 + 冒号——新值从这之后写进值 run
      const m = old.match(new RegExp('^(.*?)(' + re.source + ')[：:]?\\s*'))
      const preLen = m ? m[0].length : 0
      if (m && !FIELD_LINE_OK.test(m[1])) continue // 前缀带实质文字（正文句）→ 不是字段行，绝不动
      if (key === 'date' && !/结稿日期|日期/.test(m ? m[2] : '') && !/结稿日期|日期/.test(old.slice(0, 10))) continue // 无标签"年 月 日"=手签行，不填
      block = rewriteRuns(block, preLen, String(val))
      replaced.push(key)
      break // 一段只命中一个字段
    }
    return { xml: block, text: p.text }
  })
  return { paras: out, replaced }
}

// 主入口：模板嫁接。templatePath=学校格式模板（骨架），paperPath=论文（血肉），options.cover=封面字段
async function applyWordTemplate(paperPath, templatePath, options = {}) {
  const { outputPath, cover } = options
  const tplZip = await JSZip.loadAsync(fs.readFileSync(templatePath))
  const paperZip = await JSZip.loadAsync(fs.readFileSync(paperPath))
  const tplDoc = await tplZip.file('word/document.xml').async('string')
  const paperDoc = await paperZip.file('word/document.xml').async('string')
  if (!/<w:body>/.test(tplDoc) || !/<w:body>/.test(paperDoc)) throw new Error('不是有效的 Word 文档（缺少 body）')

  // ① 模板格式来源：**一切以模板蒸馏为准，模板没明示的绝不猜**（每个学校/公司模板不同，死规则不可用——老大定调 v2.5.66）
  // 优先级：批注规则（spec.roles，作者明示）> 模板指纹（正文实际众数，剔红字）> 无 → 保持论文原样 + 警告暴露给 AI
  const spec = await extractPaperFormatSpec(templatePath)
  const tplFp = wordFormatFingerprint(await parseWordFormat(templatePath)).fingerprint
  const RED = /^(FF0000|C00000|EE0000|CD0000|D20000|E60000|FF0100|B22222|DC143C|8B0000|FF1A1A|RED)$/i
  // 正文格式防污染：center/bold/红色都是题目·排头批注错判或红字说明残留——正文两端对齐不加粗黑色
  const sanitizeBody = (f) => {
    const g = { ...(f || {}) }
    if (g.align === 'center') delete g.align
    if (g.bold) delete g.bold
    if (g.color && RED.test(g.color)) delete g.color
    return g
  }
  const hasFmt = (f) => f && Object.values(f).some((v) => v != null && v !== '')
  const pick = (role) => {
    const sp = spec.roles[role]
    if (hasFmt(sp)) return { ...sp }
    if (hasFmt(tplFp[role])) return { ...tplFp[role] }
    return null // 模板完全没提供该角色格式 → null（正文保持论文原样，绝不套死规则）
  }
  // v2.5.66：正文格式来源——模板正文众数（剔红字后）是正文的真格式。批注里锚定"英文关键词（五号）/
  // 表标题（五号）/文献条目（五号）"的规则会被误判成 body 且按顺序互相覆盖（实测最终五号覆盖了小四=老大截图的错）。
  const fmtH1 = pick('h1'), fmtH2 = pick('h2'), fmtH3 = pick('h3')
  const fmtBody = sanitizeBody(tplFp.body && Object.keys(tplFp.body).length ? tplFp.body : (spec.roles.body || null))
  const fmtTitle = hasFmt(spec.roles.title) ? { ...spec.roles.title } : (hasFmt(tplFp.title) ? { ...tplFp.title } : (fmtH1 ? { ...fmtH1 } : null))
  // 参考文献排头+条目格式：模板批注明示才用（公司文档没有参考文献概念，绝不假设）
  const fmtRefsHead = hasFmt(spec.roles.refsHead) ? { ...spec.roles.refsHead, align: 'center' } : null
  const fmtRefsBody = hasFmt(spec.roles.refsBody) ? { ...spec.roles.refsBody } : null
  // 无蒸馏结果的警告（暴露给 AI：模板没明示的格式保持论文原样，需要的话 AI 用 picks 手动指定）
  const formatWarnings = []
  if (!hasFmt(fmtBody)) formatWarnings.push('模板未明示正文格式（无批注规则也无正文样式众数）——正文保持论文原样，需要调整请用 apply_word_format picks 手动指定')
  if (!fmtH1) formatWarnings.push('模板未明示一级标题格式——章标题保持论文原样')

  // ② 模板切节 + 论文提取
  // v2.5.76：节判定前预处理——①剔"注意事项（定稿删除此页）→声明/授权"块（注意事项里的"2.论文字数要求"
  // 等编号标题会把封面节误判成 body，封面就被论文正文顶掉了）；②剔格式说明示范段（"三号黑体，居中"开路打瞎判定）
  const tplSections = splitTplSections(tplDoc)
  for (const sec of tplSections) {
    let dropNotes = false
    const kept = []
    for (const p of sec.paras) {
      const t = (p.text || '').trim()
      if (/^注\s*意\s*事\s*项/.test(t)) { dropNotes = true; continue }
      // 停止条件=声明/授权**标题段**（段首就是标题词）——注意事项清单条目"2）原创性声明"不含糊，不能提前解禁
      if (dropNotes && /^(本科毕业论文.{0,8}(原创性声明|版权使用授权书)|原创性声明|版权使用授权书)/.test(t)) dropNotes = false
      if (dropNotes || isFormatDemoPara(p.text)) continue
      kept.push(p)
    }
    sec.paras = kept
  }
  // 清洗后重判节类型（splitTplSections 切节时基于原始 paras 定的 kind——预处理改了 paras 必须重算）
  {
    let prevKind = null
    for (const sec of tplSections) {
      sec.kind = classifyTplSection(sec.paras, prevKind)
      prevKind = sec.kind
    }
  }
  if (!tplSections.length) throw new Error('模板解析失败：没有切出任何节')
  const paper = extractPaperContent(paperDoc)
  // v2.5.64：论文自动编号转手动编号（numbering 引用迁移后断链/重编号 → 序号混乱的根因）
  // v2.5.66：bullet 空符号段（○）整段删除——返回含 null 需过滤
  const numberingXml = paperZip.file('word/numbering.xml') ? await paperZip.file('word/numbering.xml').async('string') : ''
  paper.bodyBlocks = convertNumPrToText(paper.bodyBlocks, numberingXml).filter(Boolean)
  // v2.5.78：软换行拆段——"1.1 标题\n正文"挤同段的小节标题拆独立段（标题角色+目录可抓）
  paper.bodyBlocks = softbreakSplitBlocks(paper.bodyBlocks)
  // v2.5.66：结构完整性检查——**以模板板块为准**（模板有摘要节论文没摘要才警告；公司文档没摘要不报）
  const structWarnings = []
  if (spec.hasSections.abstract && !paper.absParas.length) structWarnings.push('模板有摘要节但论文没有摘要内容——建议先 modify_word 补摘要再重套')
  if (spec.hasSections.keywords && !paper.kwText) structWarnings.push('模板有关键词但论文没有关键词行——建议先补"关键词：xxx；xxx"再重套')
  if (spec.hasSections.refs && !paper.bodyBlocks.some((b) => b.type === 'p' && /^\[\d+\]/.test(b.text.trim()))) structWarnings.push('模板有参考文献节但论文没有文献条目（[1][2]…格式）——建议先补再重套')
  if (spec.hasTocSection && !paper.bodyBlocks.some((b) => b.type === 'p' && paperHeadingRole(b.text) === 'h1')) structWarnings.push('模板有目录但正文没有一级章节标题（第X章/一、/1 空格式）——章节结构将无法识别，建议规范标题写法')
  const usedKinds = new Set()
  // 末节的 sectPr 必须以 body 级收尾（不能包段落里）——文档末尾的 body 级 sectPr 是 Word 规范要求，
  // 跳过的节（致谢/参考文献/空尾节）其页设置也不能丢，统一在组装完后收口
  const lastSec = tplSections[tplSections.length - 1]

  // ③ 组装新 body：封面(字段替换,仅首个cover节) → 摘要(排头+论文摘要) → 目录(排头+TOC域) → 正文(论文重格式化)
  // thanks/refs/enAbstract 无内容来源 → 整节跳过（示范内容丢弃）；后续 cover 节（承诺书/注意事项）原样保留
  const parts = []
  const sectionReport = []
  const bodyFmtNoIndent = { ...fmtBody, indentFirstLine: null }
  for (const sec of tplSections) {
    if (sec.kind === 'cover') {
      const firstCover = !usedKinds.has('cover')
      // v2.5.76：格式说明示范段/注意事项块已在节判定前的预处理统一剔除（这里只做封面字段替换）
      const { paras, replaced } = firstCover ? replaceCoverFields(sec.paras, cover) : { paras: sec.paras, replaced: [] }
      parts.push(paras.map((p) => p.xml).join(''))
      if (sec.sectPr && sec !== lastSec) parts.push(`<w:p><w:pPr>${sec.sectPr}</w:pPr></w:p>`)
      sectionReport.push({ kind: 'cover', kept: paras.length, coverReplaced: replaced })
      usedKinds.add('cover')
    } else if (sec.kind === 'abstract') {
      if (usedKinds.has('abstract')) { sectionReport.push({ kind: 'abstract', skipped: true }); continue }
      usedKinds.add('abstract')
      // 排头：模板"摘 要"排头段（纯排头原样；合并段"摘 要：示范…"拆出纯排头保格式）；模板示范正文/关键词全丢
      // v2.5.76：说明书式模板无排头段（节内只有示范内容）→ 用模板 title 格式造"摘  要"排头兜底
      const headP = sec.paras.find((p) => /^摘\s*要/.test(p.text.trim()))
      const headIsMerged = !!headP && !/^摘\s*要\s*$/.test(headP.text.trim())
      // v2.5.78：模板排头本就是"摘 要：内容"合并行（说明书式模板）→ 产出按模板版式排成一行
      //（题目居中一行 + 空一行 + "摘 要：正文…"），不再拆出孤立"摘 要"再居中插一遍题目（题目重复根因）
      const bits = []
      if (headIsMerged) {
        if (paper.title) bits.push(buildParaXml(paper.title, { ...fmtTitle, align: 'center' }, { align: 'center' }))
        if (paper.title && paper.absParas.length) bits.push(buildParaXml('', fmtBody)) // v2.5.64 题目与摘要正文间空一行
        bits.push(buildParaXml('', { ...(fmtBody || {}) }, { runs: [
          { text: headP.text.trim().match(/^摘\s*要[：:]?/)[0] + (/[：:]\s*$/.test(headP.text.trim().match(/^摘\s*要[：:]?/)[0]) ? '' : '：'), rPr: fmtToRPrXml({ ...(fmtBody || {}), bold: true, indentFirstLine: null }) },
          { text: paper.absParas.join('\n'), rPr: fmtToRPrXml(bodyFmtNoIndent) }
        ] }))
      } else {
        bits.push(headP ? headP.xml : buildParaXml('摘  要', { ...fmtTitle, align: 'center' }, { align: 'center' }))
        // v2.5.78：排头合并段里已带论文题目（模板排头恰好=论文题目）→ 不再重复插入题目段
        const headHasTitle = headP && paper.title && headP.text.trim().replace(/^摘\s*要[：:]?/, '').trim() === paper.title.trim()
        if (!headHasTitle && paper.title) bits.push(buildParaXml(paper.title, { ...fmtTitle, align: 'center' }, { align: 'center' }))
        if (paper.title && paper.absParas.length) bits.push(buildParaXml('', fmtBody)) // v2.5.64 题目与摘要正文间空一行（模板批注"空一行"）
        for (const t of paper.absParas) bits.push(buildParaXml(t, fmtBody))
      }
      if (paper.kwText) {
        if (paper.absParas.length) bits.push(buildParaXml('', fmtBody)) // v2.5.64 摘要与关键词之间空一行（模板批注明示）
        bits.push(buildParaXml('', fmtBody, { runs: [
          { text: '关键词：', rPr: fmtToRPrXml({ ...fmtBody, bold: true, indentFirstLine: null }) },
          { text: paper.kwText, rPr: fmtToRPrXml(bodyFmtNoIndent) }
        ] }))
      }
      if (sec.sectPr && sec !== lastSec) bits.push(`<w:p><w:pPr>${sec.sectPr}</w:pPr></w:p>`)
      parts.push(bits.join(''))
      sectionReport.push({ kind: 'abstract', head: !!headP, inserted: bits.length - (headP ? 1 : 0) - (sec.sectPr ? 1 : 0) })
    } else if (sec.kind === 'enAbstract') {
      if (usedKinds.has('enAbstract') || !paper.hasEnAbstract) {
        sectionReport.push({ kind: 'enAbstract', skipped: true, reason: '论文无英文摘要' })
        continue // 论文没有英文摘要 → 整节跳过
      }
      usedKinds.add('enAbstract')
      // v2.5.76：同 abstract——无排头段时造 "Abstract" 排头兜底
      const headP = sec.paras.find((p) => /^Abstract/i.test(p.text.trim()))
      const headIsMerged = !!headP && !/^Abstract\s*$/i.test(headP.text.trim())
      const bits = []
      if (headIsMerged) { // v2.5.78：合并行"Abstract: …"按模板版式排成一行
        if (paper.enTitle) bits.push(buildParaXml(paper.enTitle, { ...fmtTitle, align: 'center' }, { align: 'center' }))
        bits.push(buildParaXml('', { ...(fmtBody || {}) }, { runs: [
          { text: headP.text.trim().match(/^Abstract\s*[：:]?/i)[0] + (/[：:]\s*$/.test(headP.text.trim().match(/^Abstract\s*[：:]?/i)[0]) ? '' : ': '), rPr: fmtToRPrXml({ ...(fmtBody || {}), bold: true, indentFirstLine: null }) },
          { text: paper.enAbstractParas.join('\n'), rPr: fmtToRPrXml(bodyFmtNoIndent) }
        ] }))
      } else {
        bits.push(headP ? headP.xml : buildParaXml('Abstract', { ...fmtTitle, align: 'center' }, { align: 'center' }))
        if (paper.enTitle) bits.push(buildParaXml(paper.enTitle, { ...fmtTitle, align: 'center' }, { align: 'center' }))
        for (const t of paper.enAbstractParas) bits.push(buildParaXml(t, fmtBody))
      }
      if (paper.enKwText) {
        bits.push(buildParaXml('', fmtBody, { runs: [
          { text: 'Key words: ', rPr: fmtToRPrXml({ ...fmtBody, bold: true, indentFirstLine: null }) },
          { text: paper.enKwText, rPr: fmtToRPrXml(bodyFmtNoIndent) }
        ] }))
      }
      if (sec.sectPr && sec !== lastSec) bits.push(`<w:p><w:pPr>${sec.sectPr}</w:pPr></w:p>`)
      parts.push(bits.join(''))
      sectionReport.push({ kind: 'enAbstract', inserted: paper.enAbstractParas.length })
    } else if (sec.kind === 'toc') {
      if (usedKinds.has('toc')) { sectionReport.push({ kind: 'toc', skipped: true }); continue }
      usedKinds.add('toc')
      const headP = sec.paras.find((p) => /^目\s*录/.test(p.text.trim()))
      const bits = [headP ? (/^目\s*录\s*$/.test(headP.text.trim()) ? headP.xml : rebuildParaWithText(headP.xml, headP.text.trim().match(/^目\s*录/)[0])) : buildParaXml('目  录', { ...fmtTitle, align: 'center' }, { align: 'center' })]
      bits.push(buildTocParaXml(fmtBody))
      if (sec.sectPr && sec !== lastSec) bits.push(`<w:p><w:pPr>${sec.sectPr}</w:pPr></w:p>`)
      parts.push(bits.join(''))
      sectionReport.push({ kind: 'toc', head: !!headP, tocField: true, droppedDemo: sec.paras.length - (headP ? 1 : 0) })
    } else if (sec.kind === 'thanks' || sec.kind === 'refs') {
      sectionReport.push({ kind: sec.kind, skipped: true, reason: '模板示范内容丢弃（论文自带时在正文中）' })
    } else { // body：第一个 body 类节放论文正文，后续 body 节跳过（模板正文多节时页眉引用随节，v1 从简）
      if (usedKinds.has('body')) { sectionReport.push({ kind: 'body', skipped: true }); continue }
      usedKinds.add('body')
      const bits = []
      for (const b of paper.bodyBlocks) {
        if (b.type === 'tbl') { bits.push(triLineTableXml(b.xml, bodyFmtNoIndent)); continue }
        if (b.type !== 'p') { bits.push(b.xml); continue }
        if (!b.text.trim() && !/<w:drawing|<w:pict/.test(b.xml)) {
          // 空段占位保留，但 pPr 里段落标记的 rPr（网页字体/色残留）要清——素材空段是 Segoe UI 重灾区
          bits.push(reformatParaXml(b.xml, fmtBody, null))
          continue
        }
        const role = b.role || paperHeadingRole(b.text) // b.role：softbreakSplitBlocks 拆出的单级编号行（"1. 理论意义"式）标记的 h3
        // v2.5.66：模板未明示的角色格式（null）→ 退正文格式再退空格式（保持论文原样），绝不套死规则
        let fmt = role === 'h1' ? (fmtH1 || fmtBody) : role === 'h2' ? (fmtH2 || fmtBody) : role === 'h3' ? (fmtH3 || fmtBody) : fmtBody
        let ol = role === 'h1' ? 0 : role === 'h2' ? 1 : role === 'h3' ? 2 : null
        // v2.5.64：参考文献排头/条目用模板批注格式（"参考文献"四号黑体居中；条目五号宋体悬挂缩进），
        // 文中"参考文献"标题 paperHeadingRole 判 h1 会被排成章标题大字——特判纠正；模板没批注格式退 fmtBody/fmtBody 空格式
        const bt = b.text.trim()
        if (role === 'h1' && /^参考文献/.test(bt)) { fmt = fmtRefsHead || (fmtH1 || fmtBody); ol = 0 }
        else if (/^\[\d+\]/.test(bt)) { fmt = fmtRefsBody || fmtBody; ol = null }
        bits.push(reformatParaXml(b.xml, fmt || {}, ol))
      }
      if (sec.sectPr && sec !== lastSec) bits.push(`<w:p><w:pPr>${sec.sectPr}</w:pPr></w:p>`) // 中间节的分节符要包在段落里
      parts.push(bits.join(''))
      sectionReport.push({ kind: 'body', blocks: paper.bodyBlocks.length })
    }
  }
  // 正文节兜底：模板没有 body 类节（异常模板）→ 论文正文接末尾，沿用最后节页设置
  if (!usedKinds.has('body')) {
    const bits = []
    for (const b of paper.bodyBlocks) {
      if (b.type === 'tbl') { bits.push(triLineTableXml(b.xml, bodyFmtNoIndent)); continue } // 兜底路径表格同样三线化（退化模板/单节模板）
      if (b.type !== 'p') { bits.push(b.xml); continue }
      const role = b.role || paperHeadingRole(b.text)
      const fmt = role === 'h1' ? (fmtH1 || fmtBody) : role === 'h2' ? (fmtH2 || fmtBody) : role === 'h3' ? (fmtH3 || fmtBody) : fmtBody
      bits.push(reformatParaXml(b.xml, fmt || {}, role ? { h1: 0, h2: 1, h3: 2 }[role] : null))
    }
    parts.push(bits.join(''))
    sectionReport.push({ kind: 'body', fallbackNoTplBody: true, blocks: paper.bodyBlocks.length })
  }
  // 末节 sectPr 收口：无论末节是正文/参考文献还是空尾节，它的页设置（页眉页脚引用/页码）以 body 级 sectPr 落在文档尾
  if (lastSec && lastSec.sectPr) parts.push(lastSec.sectPr)

  // ④ 论文资产迁移：document.rels 全量迁入（图片/超链接等），Id 统一重编号为 rIdT* 前缀——
  //   绝不复用 rId 数字（论文 rId8 会撞模板 rId8=页眉，指错对象），media 文件照拷改 Target
  const paperRelsRaw = paperZip.file('word/_rels/document.xml.rels') ? await paperZip.file('word/_rels/document.xml.rels').async('string') : ''
  const idMap = {}
  const newRelTags = []
  let relN = 100
  let mediaN = 0
  const ctNeeded = new Set()
  for (const tagm of paperRelsRaw.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const tag = tagm[0]
    const oldId = (tag.match(/Id="([^"]+)"/) || [])[1]
    if (!oldId) continue
    const target = (tag.match(/Target="([^"]+)"/) || [])[1] || ''
    const type = (tag.match(/Type="([^"]+)"/) || [])[1] || ''
    let newTag = tag.replace(/Id="[^"]+"/, `Id="rIdT${relN}"`)
    if (type.endsWith('/image') && /^media\//.test(target)) {
      const src = paperZip.file('word/' + target)
      if (!src) continue // 图片文件缺失，丢弃该关系
      const ext = (target.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || 'png'
      const newName = `media/paperImg${relN}.${ext}`
      tplZip.file('word/' + newName, await src.async('nodebuffer'))
      newTag = newTag.replace(/Target="[^"]+"/, `Target="${newName}"`)
      ctNeeded.add(ext.toLowerCase())
      mediaN++
    }
    idMap[oldId] = `rIdT${relN}`
    newRelTags.push(newTag)
    relN++
  }
  let bodyXml = parts.join('')
  bodyXml = bodyXml.replace(/(r:(?:embed|id)=")(rId\d+)(")/g, (mm, a, rid, c) => (idMap[rid] ? a + idMap[rid] + c : mm))
  // v2.5.63：模板保留段落（封面/排头等）剥红系色标记——红字是写给学生的格式说明，产出转默认黑
  bodyXml = bodyXml.replace(/<w:color w:val="(?:FF0000|C00000|EE0000|CD0000|D20000|E60000|FF0100|B22222|DC143C|8B0000|FF1A1A|RED)"[^>]*\/>/gi, '')

  // ⑤ document.xml 重组 + rels/Content_Types 补写
  const bodyOpen = tplDoc.match(/<w:body(?:\s[^>]*)?>/)
  // bodyTail 从 </w:body> 起截（含闭合标签本身）——此前 +len 跳过了闭合标签，输出 document.xml 缺 </w:body>
  const bodyTail = tplDoc.slice(tplDoc.lastIndexOf('</w:body>'))
  const newDoc = tplDoc.slice(0, bodyOpen.index + bodyOpen[0].length) + bodyXml + bodyTail
  tplZip.file('word/document.xml', newDoc)
  if (newRelTags.length) {
    const relsPath = 'word/_rels/document.xml.rels'
    const relsFile = tplZip.file(relsPath)
    // 模板可能没有 rels（退化模板）→ 造空骨架，绝不让后续迁移段拿到 null
    const raw = relsFile ? await relsFile.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    tplZip.file(relsPath, raw.replace('</Relationships>', newRelTags.join('') + '</Relationships>'))
  }
  // 论文 numbering：正文列表段的 numId 引用要活，整包搬入（模板无 numbering 无冲突）
  if (paperZip.file('word/numbering.xml')) {
    tplZip.file('word/numbering.xml', await paperZip.file('word/numbering.xml').async('nodebuffer'))
    const ctRaw = await tplZip.file('[Content_Types].xml').async('string')
    if (!ctRaw.includes('numbering.xml')) {
      tplZip.file('[Content_Types].xml', ctRaw.replace('</Types>', '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'))
    }
    const relsPath = 'word/_rels/document.xml.rels'
    const relsFile = tplZip.file(relsPath)
    const raw = relsFile ? await relsFile.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
    if (!raw.includes('numbering.xml')) {
      tplZip.file(relsPath, raw.replace('</Relationships>', '<Relationship Id="rIdT900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>'))
    }
  }
  { // media 扩展名兜底：Content_Types 缺 Default 就补
    const ctRaw = await tplZip.file('[Content_Types].xml').async('string')
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', emf: 'image/x-emf', wmf: 'image/x-wmf' }
    let ct = ctRaw
    for (const ext of ctNeeded) {
      if (!new RegExp(`Extension="${ext}"`).test(ct) && MIME[ext]) {
        ct = ct.replace('</Types>', `<Default Extension="${ext}" ContentType="${MIME[ext]}"/></Types>`)
      }
    }
    if (ct !== ctRaw) tplZip.file('[Content_Types].xml', ct)
  }

  // ⑦ v2.5.63：产出零批注——模板批注是写给学生的格式说明（"三号黑体"等），不是论文内容，一个不带
  // ①剥 document.xml 批注锚点（RangeStart/RangeEnd/含 Reference 的 run 整个剥）
  const outDocFile = tplZip.file('word/document.xml')
  let outDoc = await outDocFile.async('string')
  outDoc = outDoc
    .replace(/<w:commentRangeStart[^>]*\/>/g, '')
    .replace(/<w:commentRangeEnd[^>]*\/>/g, '')
    .replace(/<w:r(?:\s[^>]*)?>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, '')
  tplZip.file('word/document.xml', outDoc)
  // ②删 comments 部件（comments/commentsExtended/commentsIds/commentsExtensible）
  for (const f of Object.keys(tplZip.files)) if (/^word\/comments.*\.xml$/i.test(f) && !f.endsWith('/')) tplZip.remove(f)
  // ③Content_Types 去 comments override
  const ctOut = tplZip.file('[Content_Types].xml')
  if (ctOut) {
    const ct = (await ctOut.async('string')).replace(/<Override PartName="\/word\/comments[^"]*"[^>]*\/>/g, '')
    tplZip.file('[Content_Types].xml', ct)
  }
  // ④rels 去 comments 关系
  const rlOut = tplZip.file('word/_rels/document.xml.rels')
  if (rlOut) {
    const rl = (await rlOut.async('string')).replace(/<Relationship[^>]*Type="[^"]*\/comments"[^>]*\/>/g, '')
    tplZip.file('word/_rels/document.xml.rels', rl)
  }

  // ⑥ 输出（默认与论文同目录 "原名-套模板格式.docx"；不覆盖原文件）
  const outPath = outputPath || paperPath.replace(/\.docx$/i, '-套模板格式.docx')
  const buf = await tplZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(outPath, buf)
  return {
    outputPath: outPath,
    size: buf.length,
    paper: { title: paper.title, abstractParas: paper.absParas.length, keywords: paper.kwText, bodyBlocks: paper.bodyBlocks.length },
    sections: sectionReport,
    imagesMigrated: mediaN,
    tocField: true,
    warnings: [...structWarnings, ...formatWarnings]
  }
}

// ===== Word 表格工具套件（v2.5.70：read/format/add/edit 四件）=====
// 对 document.xml 第 N 个 <w:tbl> 做 XML 变换（复用三线表引擎成熟逻辑泛化）——
// 一切格式参数来自模板蒸馏/用户口述，零死规则（死规则不可用——老大定调）。

// 扫顶层表格（嵌套表格罕见，非贪婪截断可接受）
function scanWordTables(docXml) {
  const tables = []
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g
  let m
  while ((m = re.exec(docXml))) tables.push({ xml: m[0], start: m.index, end: m.index + m[0].length })
  return tables
}
const splitTrs = (tblXml) => [...tblXml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].map((x) => x[0])
const splitTcs = (trXml) => [...trXml.matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((x) => x[0])
const cellPlainText = (tcXml) => decodeEntities((tcXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim()

// 定位表格：{index:1起} 或 {near:'表格上方/表内文字'}
function locateTable(docXml, locator = {}) {
  const tables = scanWordTables(docXml)
  if (!tables.length) throw new Error('文档里没有表格')
  if (locator.index != null) {
    const i = parseInt(locator.index, 10) - 1
    if (i < 0 || i >= tables.length) throw new Error(`表格序号超出范围：文档共 ${tables.length} 个表格，传 1~${tables.length}`)
    return { tbl: tables[i], index: i + 1, total: tables.length }
  }
  if (locator.near) {
    const key = String(locator.near).replace(/\s+/g, '')
    // 找含 key 的段落位置，取其后的第一个表；没有则取其前最后一个表
    let anchor = -1
    const pm = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
    let pm2
    while ((pm2 = pm.exec(docXml))) {
      const t = ((pm2[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('')).replace(/\s+/g, '')
      if (key && t.includes(key)) { anchor = pm2.index + pm2[0].length; break }
    }
    const after = tables.find((t) => t.start >= anchor)
    if (after) return { tbl: after, index: tables.indexOf(after) + 1, total: tables.length }
    const before = [...tables].reverse().find((t) => t.end <= anchor)
    if (before) return { tbl: before, index: tables.indexOf(before) + 1, total: tables.length }
    throw new Error(`没找到与"${locator.near}"相邻的表格`)
  }
  return { tbl: tables[0], index: 1, total: tables.length }
}

// 预设 → 边框/底色参数（用户显式参数覆盖预设）
function tableStylePreset(style, p = {}) {
  const b = (sz) => `<w:${p._bTag || 'top'} w:val="single" w:color="${p.borderColor || 'auto'}" w:sz="${sz}" w:space="0"/>`
  const S = {
    threeline: { borders: { top: 12, bottom: 12, insideH: 0, insideV: 0, left: 0, right: 0 }, firstRowLine: 6, headerFill: null, zebraFill: null, headerBold: true },
    grid: { borders: { top: 4, bottom: 4, left: 4, right: 4, insideH: 4, insideV: 4 }, headerFill: p.headerFill || null, zebraFill: null, headerBold: true },
    zebra: { borders: { top: 4, bottom: 4, left: 4, right: 4, insideH: 0, insideV: 0 }, headerFill: p.headerFill || '2E5E8C', headerColor: p.headerColor || 'FFFFFF', zebraFill: p.zebraFill || 'F4F8FC', headerBold: true },
    light: { borders: { top: 4, bottom: 4, left: 4, right: 4, insideH: 4, insideV: 4 }, headerFill: p.headerFill || 'D9E2F3', zebraFill: null, headerBold: true },
    none: { borders: { top: 0, bottom: 0, left: 0, right: 0, insideH: 0, insideV: 0 }, headerFill: null, zebraFill: null, headerBold: false }
  }
  const s = S[style] || S.grid
  return { ...s, ...p }
}

// 表格格式化：预设+全参数 → XML 重写
async function formatWordTable(paperPath, params = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(paperPath))
  const docXml0 = await zip.file('word/document.xml').async('string')
  const { tbl, index, total } = locateTable(docXml0, params)
  const st = tableStylePreset(params.style || 'grid', params)
  const rows = splitTrs(tbl.xml)
  const headerRows = Math.max(1, parseInt(params.headerRows, 10) || 1)
  const borderXml = (tag, sz) => (sz > 0 ? `<w:${tag} w:val="single" w:color="${params.borderColor || 'auto'}" w:sz="${sz}" w:space="0"/>` : `<w:${tag} w:val="none" w:color="auto" w:sz="0" w:space="0"/>`)
  const bd = st.borders
  const tblBorders = `<w:tblBorders>${borderXml('top', bd.top)}${borderXml('left', bd.left)}${borderXml('bottom', bd.bottom)}${borderXml('right', bd.right)}${borderXml('insideH', bd.insideH)}${borderXml('insideV', bd.insideV)}</w:tblBorders>`
  // 表内文字格式（用户参数或保持原样——只动用户要求的）
  const fmt = {}
  if (params.eastAsiaFont) fmt.eastAsiaFont = params.eastAsiaFont
  if (params.font) fmt.font = params.font
  if (params.sizePt) fmt.sizePt = params.sizePt
  const cellAlign = params.align || null
  // v2.5.71：按列覆盖（语义驱动排版——"金额列右对齐""状态列标色"一步到位）。列级参数优先级最高
  const colOverrides = (ci) => {
    const o = {}
    const pick2 = (k, arr) => { if (Array.isArray(arr) && arr[ci] != null) o[k] = arr[ci] }
    pick2('align', params.colAligns)
    pick2('bold', params.colBold)
    pick2('sizePt', params.colSizePt)
    pick2('color', params.colColors)
    pick2('eastAsiaFont', params.colEastAsiaFont)
    pick2('font', params.colFont)
    return o
  }
  // 列宽：colWidths(cm 数组) 或 widthPct
  let gridXml = (tbl.xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/) || ['<w:tblGrid></w:tblGrid>'])[0]
  const cmToDxa = (cm) => Math.round(cm * 567)
  if (Array.isArray(params.colWidths) && params.colWidths.length) {
    gridXml = `<w:tblGrid>${params.colWidths.map((cm) => `<w:gridCol w:w="${cmToDxa(cm)}"/>`).join('')}</w:tblGrid>`
  }
  // 行级重写
  const newRows = rows.map((trXml, trIdx) => {
    const isHeader = trIdx < headerRows
    const isZebra = !isHeader && st.zebraFill && (trIdx - headerRows) % 2 === 0
    let newRow = trXml
    // 表头跨页重复（trPr 唯一化：已有则不重复注入）
    if (isHeader && params.headerRepeat !== false && !/<w:tblHeader\/>/.test(newRow)) {
      newRow = newRow.replace(/(<w:tr(?:\s[^>]*)?>)/, '$1<w:trPr><w:tblHeader/></w:trPr>')
    }
    // 单元格级重写
    let tcIdx = -1
    newRow = newRow.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (tc) => {
      tcIdx++
      const fill = isHeader ? (st.headerFill || null) : (isZebra ? st.zebraFill : null)
      // 保留原 tcPr 的 gridSpan/vMerge（合并信息不丢），重写 tcW/shd/vAlign
      const span = (tc.match(/<w:gridSpan[^>]*\/>/) || [''])[0]
      const vmerge = (tc.match(/<w:vMerge[^>]*\/>/) || [''])[0]
      const tcW = (tc.match(/<w:tcW[^>]*\/>/) || [''])[0]
      let tcPr = `<w:tcPr>${tcW !== '' ? tcW : ''}${span}${vmerge}`
      if (fill) tcPr += `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`
      if (params.vAlign !== false) tcPr += '<w:vAlign w:val="center"/>'
      tcPr += '</w:tcPr>'
      let newTc = tc.replace(/<w:tcPr>[\s\S]*?<\/w:tcPr>/, '').replace(/(<w:tc(?:\s[^>]*)?>)/, `$1${tcPr}`)
      // 三线表栏目线：首行每格补底线
      if (params.style === 'threeline' && trIdx === 0) {
        newTc = newTc.replace(/<\/w:tcPr>/, '<w:tcBorders><w:bottom w:val="single" w:color="auto" w:sz="6" w:space="0"/></w:tcBorders></w:tcPr>')
      }
      // 表内文字格式 + 对齐（列级覆盖最后=最高优先）
      const cellFmt = { ...fmt }
      if (isHeader && (st.headerBold || params.headerBold)) cellFmt.bold = true
      if (isHeader && st.headerColor) cellFmt.color = st.headerColor
      if (cellAlign) cellFmt.align = isHeader ? 'center' : cellAlign
      else if (isHeader) cellFmt.align = 'center'
      Object.assign(cellFmt, colOverrides(tcIdx))
      newTc = newTc.replace(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g, (pm) => {
        if (!/<w:t[\s>]/.test(pm)) return pm // 空段不动
        return reformatParaXml(pm, cellFmt, null)
      })
      return newTc
    })
    return newRow
  })
  // tblPr 重建（保留 tblStyle）+ 整表重组（切片重组避免重复行 XML 的 replace 错位）；tbl 开/闭标签必须齐全
  const tblOpen = (tbl.xml.match(/<w:tbl(?:\s[^>]*)?>/) || ['<w:tbl>'])[0]
  const tblStyle = (tbl.xml.match(/<w:tblStyle[^>]*\/>/) || [''])[0]
  const tblW = params.widthPct != null ? `<w:tblW w:w="${params.widthPct * 50}" w:type="pct"/>` : ((tbl.xml.match(/<w:tblW[^>]*\/>/) || ['<w:tblW w:w="0" w:type="auto"/>'])[0])
  const newTblPr = `<w:tblPr>${tblStyle}${tblW}${tblBorders}<w:tblLayout w:type="${Array.isArray(params.colWidths) ? 'fixed' : 'autofit'}"/></w:tblPr>`
  const newTbl = tblOpen + newTblPr + gridXml + newRows.join('') + '</w:tbl>'
  let docXml = docXml0.replace(tbl.xml, () => newTbl)
  // v2.5.71：keepWithPrev——表格前最近的段落加 keepNext（表标题和表格不被分页拆开）
  if (params.keepWithPrev) {
    const before = docXml.slice(0, docXml.indexOf(newTbl))
    const lastPend = before.lastIndexOf('</w:p>')
    const pStart = before.lastIndexOf('<w:p', lastPend)
    if (pStart >= 0 && lastPend > pStart) {
      const pXml = docXml.slice(pStart, lastPend + 6)
      const newP = pXml.includes('<w:pPr>')
        ? pXml.replace(/(<w:pPr>)(<w:pStyle[^>]*\/>)?/, (mm2, a, ps) => a + (ps || '') + '<w:keepNext/>')
        : pXml.replace(/(<w:p(?:\s[^>]*)?>)/, '$1<w:pPr><w:keepNext/></w:pPr>')
      docXml = docXml.slice(0, pStart) + newP + docXml.slice(lastPend + 6)
    }
  }
  zip.file('word/document.xml', docXml)
  fs.writeFileSync(paperPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return { index, total, rows: rows.length, style: params.style || 'grid' }
}

// 表格内容编辑：ops 顺序执行（setCell/insertRow/deleteRow/insertCol/deleteCol/mergeCells/deleteTable）
// 实现：每 op 在 trs 数组/字符串上变换，op 尾整表重组（tblHead + grid + trs.join）——避免重复行 XML 的 replace 错位
async function editWordTable(paperPath, params = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(paperPath))
  const docXml0 = await zip.file('word/document.xml').async('string')
  const ops = Array.isArray(params.ops) ? params.ops : [params.ops].filter(Boolean)
  if (!ops.length) throw new Error('缺少 ops（操作数组）')
  let docXml = docXml0
  const done = []
  let lastTotal = 0
  for (const op of ops) {
    const { tbl, index, total } = locateTable(docXml, { index: params.index, near: params.near })
    lastTotal = total
    // 表头（tblPr 到 <w:tblGrid> 前）+ grid + trs 三段拆解
    const gridStart = tbl.xml.indexOf('<w:tblGrid>')
    const tblHead = tbl.xml.slice(0, gridStart)
    const rows = splitTrs(tbl.xml)
    const grid = (tbl.xml.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/) || ['<w:tblGrid></w:tblGrid>'])[0]
    let trs = rows.slice()
    let newGrid = grid
    // v2.5.72：setCell 富文本——text 字符串（\n 分段）/ {paras:[{text,bold,align,color,sizePt,eastAsiaFont,font}]} 多段异格式
    // 入参 tcXml 是完整 <w:tc ...>...</w:tc>，返回必须保留 tc 标签（丢了 tcPr 会直接挂在 tr 下，XML 损坏）
    const setCellRich = (tcXml, spec) => {
      const tcOpen = (tcXml.match(/^<w:tc(?:\s[^>]*)?>/) || ['<w:tc>'])[0]
      const tcPr = (tcXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0]
      const buildPara = (p) => {
        const spec2 = typeof p === 'object' && p !== null ? p : { text: String(p) }
        const rpr = fmtToRPrXml({ bold: spec2.bold, color: spec2.color, sizePt: spec2.sizePt, eastAsiaFont: spec2.eastAsiaFont, font: spec2.font, underline: spec2.underline })
        const align = spec2.align ? `<w:jc w:val="${escapeXml(spec2.align)}"/>` : ''
        const lines = String(spec2.text).split('\n')
        const runs = lines.map((ln, i) => `<w:r>${rpr}<w:t xml:space="preserve">${escapeXml(ln)}</w:t></w:r>${i < lines.length - 1 ? `<w:r>${rpr}<w:br/></w:r>` : ''}`).join('')
        return `<w:p><w:pPr>${align}${rpr}</w:pPr>${runs}</w:p>`
      }
      if (spec && typeof spec === 'object' && Array.isArray(spec.paras)) return tcOpen + tcPr + spec.paras.map(buildPara).join('') + '</w:tc>'
      const parts = String(spec).split('\n')
      if (parts.length === 1) return tcOpen + tcPr + `<w:p><w:r><w:t xml:space="preserve">${escapeXml(parts[0])}</w:t></w:r></w:p></w:tc>`
      return tcOpen + tcPr + parts.map((t) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r></w:p>`).join('') + '</w:tc>'
    }
    if (op.op === 'setCell') {
      const tr = trs[(op.row || 1) - 1]
      if (!tr) throw new Error(`setCell：行 ${op.row} 不存在（共 ${trs.length} 行）`)
      const tcs = splitTcs(tr)
      const tc = tcs[(op.col || 1) - 1]
      if (!tc) throw new Error(`setCell：列 ${op.col} 不存在（共 ${tcs.length} 列）`)
      trs[trs.indexOf(tr)] = tr.replace(tc, () => setCellRich(tc, op.text))
      done.push(`改格(${op.row},${op.col})="${String(op.text).slice(0, 10)}"`)
    } else if (op.op === 'insertRow') {
      const at = Math.min(Math.max(op.at || trs.length + 1, 1), trs.length + 1)
      const refTr = trs[Math.min(at, trs.length) - 1] || trs[0]
      const cells = Array.isArray(op.cells) ? op.cells : []
      let ci = 0 // replace 回调的第二个参数是 offset 不是序号——用闭包计数器
      const newTr = refTr.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (tc) => setCellRich(tc, cells[ci++] != null ? cells[ci - 1] : '')).replace(/<w:tblHeader\/>/g, '')
      trs.splice(at - 1, 0, newTr)
      done.push(`第${at}行插入 ${cells.length} 格`)
    } else if (op.op === 'deleteRow') {
      const at = op.at || trs.length
      if (!trs[at - 1]) throw new Error(`deleteRow：行 ${at} 不存在`)
      trs.splice(at - 1, 1)
      done.push(`删第${at}行`)
    } else if (op.op === 'insertCol' || op.op === 'deleteCol') {
      if (trs.some((tr) => /<w:vMerge|<w:gridSpan/.test(tr))) throw new Error('该表含合并单元格，暂不支持整列插删——先解除合并')
      const cols0 = (grid.match(/<w:gridCol[^>]*\/>/g) || [])
      const at = op.at || (op.op === 'insertCol' ? cols0.length + 1 : cols0.length)
      if (op.op === 'deleteCol' && (at < 1 || at > cols0.length)) throw new Error(`deleteCol：列 ${at} 不存在（共 ${cols0.length} 列）`)
      trs = trs.map((tr) => {
        const tcs = splitTcs(tr)
        if (op.op === 'insertCol') {
          const pos = Math.min(at, tcs.length) - 1
          const refTc = tcs[pos]
          const newTc = refTc.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, '').replace(/(<w:tc(?:\s[^>]*)?>)/, '$1')
          return tr.replace(refTc, () => newTc + refTc)
        }
        return tr.replace(tcs[at - 1], () => '')
      })
      const refCol = cols0[Math.min(at, cols0.length) - 1] || '<w:gridCol w:w="1000"/>'
      const colParts = cols0.slice()
      if (op.op === 'insertCol') colParts.splice(at - 1, 0, refCol)
      else colParts.splice(at - 1, 1)
      newGrid = `<w:tblGrid>${colParts.join('')}</w:tblGrid>`
      done.push(op.op === 'insertCol' ? `第${at}列前插入列` : `删第${at}列`)
    } else if (op.op === 'mergeCells') {
      const { r1 = 1, c1 = 1, r2 = r1, c2 = c1 } = op
      if (r1 === r2) {
        const tr = trs[r1 - 1]
        const tcs = splitTcs(tr)
        const span = c2 - c1 + 1
        const first = tcs[c1 - 1].replace(/<w:gridSpan[^>]*\/>/g, '').replace(/(<w:tcPr>)/, `$1<w:gridSpan w:val="${span}"/>`)
        trs[r1 - 1] = tr.replace(tcs[c1 - 1], () => first).replace(tcs.slice(c1, c2).join(''), () => '')
        done.push(`合并(${r1},${c1})-(${r2},${c2})`)
      } else {
        for (let r = r1; r <= r2; r++) {
          const tr = trs[r - 1]
          const tcs = splitTcs(tr)
          const tc = tcs[c1 - 1]
          const vm = r === r1 ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>'
          let newTc = tc.replace(/<w:vMerge[^>]*\/>/g, '').replace(/(<w:tcPr>)/, `$1${vm}`)
          if (r !== r1) newTc = newTc.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\/>/g, '<w:p/>')
          trs[r - 1] = tr.replace(tc, () => newTc)
        }
        done.push(`纵向合并(${r1},${c1})-(${r2},${c2})`)
      }
    } else if (op.op === 'diagHeader') {
      // v2.5.72：斜线表头（左上-右下对角线 tl2br）+ 两行错位文字（lines[0] 右上 / lines[1] 左下）
      const tr = trs[(op.row || 1) - 1]
      const tcs = splitTcs(tr)
      const tc = tcs[(op.col || 1) - 1]
      if (!tc) throw new Error(`diagHeader：单元格(${op.row},${op.col})不存在`)
      const lines = Array.isArray(op.lines) ? op.lines : [String(op.text || '').split('\\')[0], String(op.text || '').split('\\')[1]].filter(Boolean)
      const tcPrRaw = (tc.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0]
      const tcW = (tc.match(/<w:tcW[^>]*\/>/) || [''])[0]
      const tcPrNew = tcPrRaw
        ? tcPrRaw.replace('</w:tcPr>', '<w:tcBorders><w:tl2br w:val="single" w:color="auto" w:sz="4" w:space="0"/></w:tcBorders></w:tcPr>')
        : `<w:tcPr>${tcW}<w:tcBorders><w:tl2br w:val="single" w:color="auto" w:sz="4" w:space="0"/></w:tcBorders><w:vAlign w:val="center"/></w:tcPr>`
      const rpr = fmtToRPrXml({ sizePt: 10.5, eastAsiaFont: '宋体' })
      const body = `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r>${rpr}<w:t xml:space="preserve">　　　　${escapeXml(lines[0] || '')}</w:t></w:r></w:p>` +
        `<w:p><w:r>${rpr}<w:t xml:space="preserve">${escapeXml(lines[1] || '')}</w:t></w:r></w:p>`
      // tc 是完整 <w:tc>...</w:tc>，重组必须带回 tc 标签（漏闭合=表格"消失"的老坑）
      const tcOpen = (tc.match(/^<w:tc(?:\s[^>]*)?>/) || ['<w:tc>'])[0]
      trs[trs.indexOf(tr)] = tr.replace(tc, () => tcOpen + tcPrNew + body + '</w:tc>')
      done.push(`斜线表头(${op.row},${op.col})：${lines.join('/')}`)
    } else if (op.op === 'deleteTable') {
      trs = []
      done.push('删除整表')
    } else throw new Error(`未知操作 op.op="${op.op}"（支持 setCell/insertRow/deleteRow/insertCol/deleteCol/mergeCells/deleteTable）`)
    // 整表重组（tbl 开闭标签齐全——漏闭合 = scanWordTables 正则不命中 + Word 打不开）
    const newTbl = trs.length ? tblHead + newGrid + trs.join('') + '</w:tbl>' : ''
    docXml = docXml.replace(tbl.xml, () => newTbl)
  }
  zip.file('word/document.xml', docXml)
  fs.writeFileSync(paperPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return { done, total: lastTotal }
}

// 在文档指定位置插入表格（复用 create_word 的表格渲染体系——样式体系零重复）
async function addWordTable(filePath, opts = {}) {
  const rows = Array.isArray(opts.rows) ? opts.rows : []
  if (!rows.length || !Array.isArray(rows[0])) throw new Error('缺少 rows（二维数组，第一行为表头）')
  // 用 docx 库渲染样表（主题/字体/边框全复用成熟实现），抽出 <w:tbl>
  const tmp = filePath + '.addtable-tmp.docx'
  await createDocx(tmp, { title: 'T', noTitle: true, theme: opts.theme, fonts: opts.fonts, paragraphs: [{ style: 'table', rows }] })
  const z = await JSZip.loadAsync(fs.readFileSync(tmp))
  const xd = await z.file('word/document.xml').async('string')
  const m = xd.match(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/)
  fs.unlinkSync(tmp)
  if (!m) throw new Error('样表生成失败')
  let tblXml = m[0]
  if (Array.isArray(opts.colWidths) && opts.colWidths.length) {
    tblXml = tblXml.replace(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/, `<w:tblGrid>${opts.colWidths.map((cm) => `<w:gridCol w:w="${Math.round(cm * 567)}"/>`).join('')}</w:tblGrid>`)
  }
  const zDoc = await JSZip.loadAsync(fs.readFileSync(filePath))
  const docXml0 = await zDoc.file('word/document.xml').async('string')
  let insertAt = null
  if (opts.afterText) {
    const key = String(opts.afterText).replace(/\s+/g, '')
    const pm = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
    let mm
    while ((mm = pm.exec(docXml0))) {
      const t = ((mm[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('')).replace(/\s+/g, '')
      if (key && t.includes(key)) { insertAt = mm.index + mm[0].length; break }
    }
    if (insertAt == null) throw new Error(`没找到包含"${opts.afterText}"的段落（插入位置定位失败）`)
  } else {
    const sect = docXml0.lastIndexOf('<w:sectPr')
    insertAt = sect > 0 ? sect : docXml0.lastIndexOf('</w:body>')
  }
  const docXml = docXml0.slice(0, insertAt) + tblXml + '<w:p/><w:p/>' + docXml0.slice(insertAt)
  zDoc.file('word/document.xml', docXml)
  fs.writeFileSync(filePath, await zDoc.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const total = scanWordTables(docXml).length
  return { rows: rows.length, cols: rows[0].length, index: opts.afterText ? total : undefined, total }
}

// v2.5.72：全文分页修复（keepNext 全局联动）——所有表格：表前段补 keepNext（标题不与表格拆页）、表首行补 tblHeader（跨页重复表头）
// 从后往前逐表处理（前面的位置不因替换失效）。docx 是 zip！必须 JSZip 解包改 document.xml，直接 utf8 读写整包=文件损坏
async function fixPaperPaging(paperPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(paperPath))
  const docXml0 = await zip.file('word/document.xml').async('string')
  const tables = scanWordTables(docXml0)
  let docXml = docXml0
  let fixedKeep = 0, fixedHeader = 0
  for (let i = tables.length - 1; i >= 0; i--) {
    const t = tables[i]
    // 表前段补 keepNext——仅当 </w:p> 紧贴 <w:tbl>（中间只允许空白）才认；定位段开标签必须匹配真 <w:p>/<w:p 属性>（<w:pPr>/<w:pStyle>/<w:pict> 同前缀会误命中）
    const before = docXml.slice(0, t.start)
    const tailM = before.match(/<\/w:p>(\s*)$/)
    if (tailM) {
      const segEnd = tailM.index
      const opens = [...before.slice(0, segEnd).matchAll(/<w:p(?:\s[^>]*)?>/g)]
      const lastOpen = opens[opens.length - 1]
      if (lastOpen) {
        const pStart = lastOpen.index
        const pXml = docXml.slice(pStart, segEnd + 6)
        if (!/<w:keepNext\/>/.test(pXml)) {
          const newP = pXml.includes('<w:pPr>')
            ? pXml.replace(/(<w:pPr>)(<w:pStyle[^>]*\/>)?/, (mm2, a, ps) => a + (ps || '') + '<w:keepNext/>')
            : pXml.replace(/(<w:p(?:\s[^>]*)?>)/, '$1<w:pPr><w:keepNext/></w:pPr>')
          docXml = docXml.slice(0, pStart) + newP + docXml.slice(segEnd + 6)
          fixedKeep++
        }
      }
    }
    // 表首行补 tblHeader（跨页重复表头）
    const firstTr = (splitTrs(t.xml)[0] || '')
    if (firstTr && !/<w:tblHeader\/>/.test(firstTr)) {
      const newFirst = firstTr.replace(/(<w:tr(?:\s[^>]*)?>)/, '$1<w:trPr><w:tblHeader/></w:trPr>')
      docXml = docXml.replace(firstTr, () => newFirst)
      fixedHeader++
    }
  }
  zip.file('word/document.xml', docXml)
  fs.writeFileSync(paperPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return { tables: tables.length, keepNextAdded: fixedKeep, headerRepeated: fixedHeader }
}

// v2.5.73：旧版 .doc（OLE2 复合文档）魔数探测——不靠后缀（docx 改名 .doc 不会误判，PK 头直接放行走 docx 链路）
function isLegacyDoc(p) {
  try {
    const fd = fs.openSync(p, 'r')
    try {
      const buf = Buffer.alloc(8)
      fs.readSync(fd, buf, 0, 8, 0)
      return buf.equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]))
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

// v2.5.72：SVG → PNG（Electron 隐藏窗口渲染 capturePage）——AI 手写 SVG 图表（柱状/折线/饼，含中文文本）转图片插图。
// 纯 Node 环境（测试）正确报错；MSMate 应用内可用（svgToPng 的探针/冒烟覆盖见 electron-probe）
async function svgToPng(svgPath, pngPath, opts = {}) {
  let electron
  try { electron = require('electron') } catch { throw new Error('svg_to_png 需要 MSMate 应用环境（浏览器外无法渲染 SVG）') }
  if (typeof electron !== 'object' || !electron.BrowserWindow) throw new Error('svg_to_png 需要在 MSMate 应用内运行（Node 环境无法渲染）')
  const { BrowserWindow } = electron
  const svg = fs.readFileSync(svgPath, 'utf8')
  const w = opts.width || parseInt((svg.match(/width="(\d+)/) || [])[1], 10) || 900
  const h = opts.height || parseInt((svg.match(/height="(\d+)/) || [])[1], 10) || 600
  const htmlPath = String(pngPath).replace(/\.png$/i, '') + '.html'
  fs.writeFileSync(htmlPath, `<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#ffffff}</style></head><body>${svg}</body></html>`)
  const win = new BrowserWindow({ show: false, width: w, height: h, frame: false, webPreferences: { offscreen: true } })
  try {
    await win.loadFile(htmlPath)
    await new Promise((r) => setTimeout(r, 400))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h })
    fs.writeFileSync(pngPath, img.toPNG())
  } finally {
    try { win.destroy() } catch {}
    try { fs.unlinkSync(htmlPath) } catch {}
  }
  return { width: w, height: h, size: fs.statSync(pngPath).size }
}

// ===== PPT 生成/读取/编辑（v2.7.15：pptxgenjs 引擎；设计系统学习引用 MiniMax-AI/skills pptx-generator，MIT）=====
// 主题契约五键：primary(标题深色) body(正文) accent(强调) light(浅色块) bg(背景)
// 硬规则（源自 MiniMax 踩坑集）：hex 不带 #（带 # 文件损坏）、透明度用 transparency 属性不编进 hex、
// 标题禁下划装饰线、正文禁加粗、标题 fit:'shrink' 防溢出、正文左对齐禁居中
const PptxGenJS = require('pptxgenjs')

const PPT_FONTS = { cn: 'Microsoft YaHei', en: 'Arial' }

// 18 套调色板（配色值取自 MiniMax 设计系统色表，按主题契约分配角色；body 为可读性校正色）
const PPT_PALETTES = {
  authority: { colors: { primary: '2B2D42', body: '3E4159', accent: 'D90429', light: 'A9B4C2', bg: 'EDF2F4' }, note: '商务权威/年报/政企' },
  wellness:  { colors: { primary: '006D77', body: '2F6B72', accent: 'E29578', light: '83C5BE', bg: 'EDF6F9' }, note: '健康疗愈/医护/瑜伽' },
  nature:    { colors: { primary: '283618', body: '41472B', accent: 'BC6C25', light: 'DDA15E', bg: 'FEFAE0' }, note: '自然户外/环保/农业' },
  vintage:   { colors: { primary: '003049', body: '27435A', accent: 'C1121F', light: '669BBC', bg: 'FDF0D5' }, note: '复古学院/人文/历史' },
  candy:     { colors: { primary: '3D3D3D', body: '555555', accent: 'CDB4DB', light: 'FFC8DD', bg: 'FFFFFF' }, note: '柔和创意/母婴/甜品' },
  bohemian:  { colors: { primary: '6B705C', body: '5C5645', accent: 'D4A373', light: 'CCD5AE', bg: 'FEFAE0' }, note: '波西米亚/婚礼/家居' },
  vivid:     { colors: { primary: '023047', body: '12405E', accent: 'FB8500', light: '8ECAE6', bg: 'FFFFFF' }, note: '高能科技/运动/路演' },
  craft:     { colors: { primary: '414833', body: '4A4A38', accent: '7F5539', light: 'A68A64', bg: 'EDE0D4' }, note: '手作匠艺/咖啡/烘焙' },
  technight: { colors: { primary: 'FFC300', body: 'D6E4F0', accent: '003566', light: '001D3D', bg: '000814' }, dark: true, note: '暗夜科技/发布/汽车（深底）' },
  chart:     { colors: { primary: '264653', body: '2E4A55', accent: 'E76F51', light: 'E9C46A', bg: 'FFFFFF' }, note: '教育图表/数据/统计' },
  forest:    { colors: { primary: '344E41', body: '3B5A4B', accent: '588157', light: 'A3B18A', bg: 'DAD7CD' }, note: '森林生态/ESG/景观' },
  fashion:   { colors: { primary: '4A5759', body: '566567', accent: 'EDAFB8', light: 'B0C4B1', bg: 'F7E1D7' }, note: '莫兰迪时尚/美妆/杂志' },
  food:      { colors: { primary: '335C67', body: '540B0E', accent: 'E09F3E', light: 'FFF3B0', bg: 'FFFFFF' }, note: '复古美食/展览/纪录片' },
  luxury:    { colors: { primary: '22223B', body: '4A4E69', accent: '9A8C98', light: 'C9ADA7', bg: 'F2E9E4' }, note: '高端紫灰/珠宝/咨询' },
  techblue:  { colors: { primary: '03045E', body: '12315A', accent: '0077B6', light: '90E0EF', bg: 'CAF0F8' }, note: '纯净科技蓝/AI/云/海洋' },
  coastal:   { colors: { primary: '0081A7', body: '0B6E85', accent: 'F07167', light: 'FED9B7', bg: 'FDFCDC' }, note: '海岸珊瑚/旅行/夏日' },
  mint:      { colors: { primary: '0E6B5C', body: '2E7D6E', accent: 'FF9F1C', light: 'CBF3F0', bg: 'FFFFFF' }, note: '橙薄荷/儿童/快消/社媒' },
  platinum:  { colors: { primary: '0A0A0A', body: '333333', accent: 'D4AF37', light: 'EFEFEF', bg: 'FFFFFF' }, note: '铂金白金/金融/奢侈/官网' }
}

// 4 种风格配方（圆角/边距/间距，单位英寸；页幅 10 × 5.625 LAYOUT_16x9）
const PPT_STYLES = {
  sharp:   { key: 'sharp',   rS: 0,    rM: 0.03, rL: 0.05, margin: 0.3, pad: 0.14, gap: 0.18, block: 0.3 },
  soft:    { key: 'soft',    rS: 0.05, rM: 0.08, rL: 0.12, margin: 0.4, pad: 0.18, gap: 0.22, block: 0.42 },
  rounded: { key: 'rounded', rS: 0.1,  rM: 0.15, rL: 0.25, margin: 0.5, pad: 0.24, gap: 0.28, block: 0.56 },
  pill:    { key: 'pill',    rS: 0.2,  rM: 0.3,  rL: 0.5,  margin: 0.6, pad: 0.3,  gap: 0.34, block: 0.7 }
}

const PPT_CN_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF5E\u3000-\u303F]/
function pptFontOf(text) { return PPT_CN_RE.test(String(text)) ? PPT_FONTS.cn : PPT_FONTS.en }

// 文本宽度估算（英寸）与行高估算：中文全宽、ASCII 0.56 宽
function pptEstUnits(text) {
  let u = 0
  for (const ch of String(text)) u += PPT_CN_RE.test(ch) ? 1 : 0.56
  return u
}
function pptTextH(text, wIn, fontSize, lh = 1.32) {
  const lines = Math.max(1, Math.ceil((pptEstUnits(text) * fontSize) / 72 / Math.max(wIn, 0.1)))
  return lines * fontSize * lh / 72
}

// 圆角矩形辅助：radius<=0 退化为直角矩形（避免 PptxGenJS rectRadius 0 的歧义）
function pptShape(pres, slide, opts) {
  const o = { ...opts }
  const r = o.rectRadius != null ? o.rectRadius : 0.1
  delete o.rectRadius
  if (r <= 0.001) return slide.addShape(pres.shapes.RECTANGLE, o)
  return slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { ...o, rectRadius: r })
}

// 页码徽标（MiniMax 规范：除封面外每页必带，右下角 x9.3 y5.12）
function pptBadge(pres, slide, num, pal) {
  const fill = pal.dark ? pal.colors.primary : pal.colors.accent
  const txt = pal.dark ? pal.colors.bg : 'FFFFFF'
  slide.addShape(pres.shapes.OVAL, { x: 9.3, y: 5.12, w: 0.36, h: 0.36, fill: { color: fill } })
  slide.addText(String(num), { x: 9.3, y: 5.12, w: 0.36, h: 0.36, fontSize: 11, fontFace: PPT_FONTS.en, color: txt, bold: true, align: 'center', valign: 'middle', margin: 0 })
}

// 大纲解析：theme/style 头两行 + --- 分页 + #cover/#toc/#section/#summary 页型标记（## 内容页标题）
function pptParseOutline(content) {
  const meta = { theme: null, style: null }
  const lines0 = String(content || '').split(/\r?\n/)
  let i = 0
  for (; i < lines0.length; i++) {
    const t = lines0[i].trim()
    if (/^(theme|palette|配色|style|风格)\s*[:：]/i.test(t)) {
      const m = t.split(/[:：]/)
      const k = m[0].trim().toLowerCase(), v = m.slice(1).join(':').trim().toLowerCase()
      if (/^(theme|palette|配色)$/.test(k)) meta.theme = v
      else meta.style = v
      continue
    }
    break
  }
  const blocks = lines0.slice(i).join('\n').split(/^---+\s*$/m).map(s => s.trim()).filter(Boolean)
  const slides = blocks.map((block) => {
    const lines = block.split(/\r?\n/).map(l => l.replace(/\s+$/, ''))
    const sl = { type: 'content', title: '', subs: [], bullets: [], paras: [], table: null, quote: '', image: null }
    let idx = 0
    const first = (lines[0] || '').trim()
    const mk = first.match(/^#(cover|toc|section|summary)\s*[:：]?\s*(.*)$/i)
    if (mk) { sl.type = mk[1].toLowerCase(); sl.title = mk[2].trim(); idx = 1 }
    else {
      const h = first.match(/^#{1,3}\s*(.+)$/)
      if (h) { sl.title = h[1].trim(); idx = 1 }
    }
    const rows = []
    for (; idx < lines.length; idx++) {
      const t = lines[idx].trim()
      if (!t) continue
      if (/^\|.+\|$/.test(t)) {
        const cells = t.slice(1, -1).split('|').map(c => c.trim())
        if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue
        rows.push(cells)
        continue
      }
      if (rows.length) { sl.table = rows.splice(0) }
      const img = t.match(/^!\[[^\]]*\]\(([^)]+)\)/)
      if (img) { sl.image = img[1].trim().replace(/^file:\/\/\//, ''); continue }
      if (/^[-*•]\s+/.test(t)) { sl.bullets.push(t.replace(/^[-*•]\s+/, '')); continue }
      if (/^>\s?/.test(t)) { sl.quote = (sl.quote ? sl.quote + ' ' : '') + t.replace(/^>\s?/, ''); continue }
      if (/^#{2,4}\s+(.*)$/.test(t)) { sl.subs.push(t.replace(/^#{2,4}\s+/, '')); continue }
      sl.paras.push(t)
    }
    if (rows.length) sl.table = rows
    return sl
  })
  return { meta, slides }
}

async function createPptx(filePath, content) {
  let titleHint = '', subtitleHint = ''
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    titleHint = String(content.title || '')
    subtitleHint = String(content.subtitle || '')
    content = content.content != null ? String(content.content) : ''
  }
  const { meta, slides } = pptParseOutline(content)
  if (!slides.length) throw new Error('PPT 内容为空：content 用 --- 独占一行分页，页首 #cover/#toc/#section/#summary 标记页型，内容页用 ## 标题 + - 要点（详见手册）')
  if (!slides.some(s => s.type === 'cover') && titleHint) {
    slides.unshift({ type: 'cover', title: titleHint, subs: subtitleHint ? [subtitleHint] : [], bullets: [], paras: [], table: null, quote: '', image: null })
  }
  if (slides.length > 30) throw new Error(`页数超限（${slides.length} 页 > 30 页上限），请合并或精简大纲`)

  const pal = PPT_PALETTES[PPT_PALETTES[meta.theme] ? meta.theme : 'authority'].colors
  const palDark = !!PPT_PALETTES[PPT_PALETTES[meta.theme] ? meta.theme : 'authority'].dark
  const st = PPT_STYLES[PPT_STYLES[meta.style] ? meta.style : 'soft']
  const ACC = pal.accent, BODY = pal.body, LIGHT = pal.light, BG = pal.bg, PRI = pal.primary

  const pres = new PptxGenJS()
  pres.layout = 'LAYOUT_16x9'
  const PAGE_W = 10, PAGE_H = 5.625
  let contentIdx = 0, sectionIdx = 0, pageNo = 0

  for (const sl of slides) {
    pageNo++
    const slide = pres.addSlide()
    slide.background = { color: BG }

    if (sl.type === 'cover') {
      // 角部装饰块（浅色大圆角矩形出血 + 强调色小出血块），禁用标题下划装饰线
      pptShape(pres, slide, { x: 7.6, y: -1.4, w: 4.4, h: 4.4, fill: { color: LIGHT, transparency: palDark ? 30 : 45 }, rectRadius: st.rL })
      pptShape(pres, slide, { x: -1.1, y: 4.3, w: 3.2, h: 2.4, fill: { color: ACC, transparency: palDark ? 45 : 78 }, rectRadius: st.rL })
      const title = sl.title || '演示文稿'
      slide.addText(title, { x: 0.6, y: 1.85, w: 8.8, h: 1.15, fontSize: 40, bold: true, color: PRI, fontFace: pptFontOf(title), align: 'center', fit: 'shrink' })
      const sub = sl.subs[0] || sl.paras[0] || ''
      if (sub) slide.addText(sub, { x: 1.2, y: 3.12, w: 7.6, h: 0.5, fontSize: 17, color: palDark ? BODY : ACC, fontFace: pptFontOf(sub), align: 'center', fit: 'shrink' })
      const subFromSubs = sl.subs.length > 0
      const metaTxt = (subFromSubs ? sl.subs.slice(1) : sl.subs).concat(subFromSubs ? sl.paras : sl.paras.slice(1)).filter(Boolean).join('  ·  ')
      if (metaTxt) {
        pptShape(pres, slide, { x: 3.3, y: 4.02, w: 3.4, h: 0.42, fill: { color: ACC }, rectRadius: 0.21 })
        slide.addText(metaTxt, { x: 3.3, y: 4.02, w: 3.4, h: 0.42, fontSize: 11, color: palDark ? BG : 'FFFFFF', fontFace: pptFontOf(metaTxt), align: 'center', valign: 'middle', margin: 0, fit: 'shrink' })
      }
    } else if (sl.type === 'toc') {
      const t = sl.title || '目录'
      slide.addText(t, { x: st.margin, y: 0.42, w: 4.5, h: 0.6, fontSize: 30, bold: true, color: PRI, fontFace: pptFontOf(t), align: 'left' })
      const items = sl.bullets.slice(0, 8)
      const twoCol = items.length > 5
      const colW = twoCol ? (PAGE_W - st.margin * 2 - st.block) / 2 : PAGE_W - st.margin * 2
      items.forEach((it, i) => {
        const col = twoCol ? i % 2 : 0
        const row = twoCol ? Math.floor(i / 2) : i
        const x = st.margin + col * (colW + st.block)
        const y = 1.5 + row * 0.72
        pptShape(pres, slide, { x, y: y + 0.05, w: 0.5, h: 0.5, fill: { color: palDark ? ACC : LIGHT }, rectRadius: st.rS })
        slide.addText(String(i + 1).padStart(2, '0'), { x, y: y + 0.05, w: 0.5, h: 0.5, fontSize: 14, bold: true, color: palDark ? BG : PRI, fontFace: PPT_FONTS.en, align: 'center', valign: 'middle', margin: 0 })
        const label = it.replace(/^[0-9０-９]+[\s.．、）)]*\s*/, '')
        slide.addText(label, { x: x + 0.64, y, w: colW - 0.64, h: 0.6, fontSize: 15, color: BODY, fontFace: pptFontOf(label), align: 'left', valign: 'middle', fit: 'shrink', margin: 0 })
      })
    } else if (sl.type === 'section') {
      sectionIdx++
      const t = sl.title || `第 ${sectionIdx} 部分`
      const numbered = /^[0-9ⅠⅡⅢⅣⅤⅥ]/.test(t)
      const numTxt = numbered ? t.split(/[\s.．、]+/)[0] : String(sectionIdx).padStart(2, '0')
      const name = numbered ? t.replace(/^[0-9ⅠⅡⅢⅣⅤⅥ]+[\s.．、）)]*\s*/, '') : t
      const intro = sl.subs[0] || sl.paras[0] || ''
      if (sectionIdx % 2 === 1) {
        pptShape(pres, slide, { x: 0.7, y: 1.75, w: 1.7, h: 1.7, fill: { color: ACC }, rectRadius: st.rL })
        slide.addText(numTxt, { x: 0.7, y: 1.75, w: 1.7, h: 1.7, fontSize: 34, bold: true, color: palDark ? BG : 'FFFFFF', fontFace: PPT_FONTS.en, align: 'center', valign: 'middle', margin: 0 })
        slide.addText(name, { x: 2.75, y: 1.82, w: 6.6, h: 0.95, fontSize: 30, bold: true, color: PRI, fontFace: pptFontOf(name), align: 'left', valign: 'middle', fit: 'shrink' })
        if (intro) slide.addText(intro, { x: 2.77, y: 2.85, w: 6.6, h: 0.55, fontSize: 13, color: BODY, fontFace: pptFontOf(intro), align: 'left', fit: 'shrink', margin: 0 })
      } else {
        slide.addText(numTxt, { x: 1, y: 1.15, w: 8, h: 1.35, fontSize: 64, bold: true, color: ACC, fontFace: PPT_FONTS.en, align: 'center' })
        slide.addText(name, { x: 1, y: 2.62, w: 8, h: 0.8, fontSize: 30, bold: true, color: PRI, fontFace: pptFontOf(name), align: 'center', fit: 'shrink' })
        if (intro) slide.addText(intro, { x: 1.5, y: 3.55, w: 7, h: 0.5, fontSize: 13, color: BODY, fontFace: pptFontOf(intro), align: 'center', fit: 'shrink', margin: 0 })
      }
    } else if (sl.type === 'summary') {
      const title = sl.title || '总结'
      const hasList = sl.bullets.length > 0
      slide.addText(title, { x: st.margin, y: 0.5, w: PAGE_W - st.margin * 2, h: 0.75, fontSize: 30, bold: true, color: PRI, fontFace: pptFontOf(title), align: hasList ? 'left' : 'center', fit: 'shrink' })
      if (hasList) {
        let y = 1.62
        const w = PAGE_W - st.margin * 2
        for (const b of sl.bullets.slice(0, 6)) {
          if (y > 4.7) break
          const h = Math.max(0.4, pptTextH(b, w - 0.45, 15) + 0.08)
          slide.addText('✓', { x: st.margin, y, w: 0.4, h, fontSize: 16, bold: true, color: ACC, fontFace: PPT_FONTS.en, align: 'left', valign: 'top', margin: 0 })
          slide.addText(b, { x: st.margin + 0.45, y, w: w - 0.45, h, fontSize: 15, color: BODY, fontFace: pptFontOf(b), align: 'left', valign: 'top', margin: 0 })
          y += h + 0.12
        }
        const metaTxt = sl.subs.join('  ·  ')
        if (metaTxt) slide.addText(metaTxt, { x: st.margin, y: 5.02, w, h: 0.38, fontSize: 12, color: BODY, fontFace: pptFontOf(metaTxt), align: 'left', margin: 0, fit: 'shrink' })
      } else {
        const sub = sl.subs.concat(sl.paras).filter(Boolean).join('  ·  ')
        if (sub) slide.addText(sub, { x: 1.5, y: 3.3, w: 7, h: 0.55, fontSize: 14, color: BODY, fontFace: pptFontOf(sub), align: 'center', fit: 'shrink', margin: 0 })
      }
    } else {
      contentIdx++
      const title = sl.title || ''
      if (title) slide.addText(title, { x: st.margin, y: 0.32, w: PAGE_W - st.margin * 2, h: 0.62, fontSize: 25, bold: true, color: PRI, fontFace: pptFontOf(title), align: 'left', fit: 'shrink' })
      const bodyTop = 1.18
      const bodyH = PAGE_H - bodyTop - 0.35
      const bodyW = PAGE_W - st.margin * 2
      const hasImg = !!(sl.image && fs.existsSync(sl.image))
      const imgBox = hasImg ? { x: st.margin + bodyW * 0.52 + st.gap, y: bodyTop, w: bodyW * 0.44, h: bodyH } : null
      const textW = hasImg ? bodyW * 0.52 - st.gap : bodyW

      let y = bodyTop
      if (sl.quote) {
        const qh = Math.min(bodyH * 0.6, pptTextH(sl.quote, textW - 0.6, 15) + 0.44)
        pptShape(pres, slide, { x: st.margin, y, w: textW, h: qh, fill: { color: LIGHT, transparency: palDark ? 40 : 35 }, rectRadius: st.rM })
        pptShape(pres, slide, { x: st.margin, y, w: 0.12, h: qh, fill: { color: ACC }, rectRadius: 0.06 })
        slide.addText(sl.quote, { x: st.margin + 0.34, y: y + 0.1, w: textW - 0.55, h: qh - 0.2, fontSize: 15, italic: true, color: BODY, fontFace: pptFontOf(sl.quote), align: 'left', valign: 'middle', margin: 0 })
        y += qh + st.block
      }

      const useCards = !hasImg && !sl.table && !sl.quote && sl.bullets.length >= 3 && sl.bullets.length <= 6 && contentIdx % 2 === 0
      if (useCards) {
        const cols = 2
        const cw = (textW - st.gap) / cols
        const rowsN = Math.ceil(sl.bullets.length / cols)
        const ch = Math.min(1.35, (bodyH - st.gap * (rowsN - 1)) / rowsN)
        sl.bullets.forEach((b, i) => {
          const x = st.margin + (i % cols) * (cw + st.gap)
          const yy = bodyTop + Math.floor(i / cols) * (ch + st.gap)
          pptShape(pres, slide, { x, y: yy, w: cw, h: ch, fill: { color: palDark ? ACC : LIGHT }, rectRadius: st.rM })
          slide.addText(String(i + 1).padStart(2, '0'), { x: x + st.pad, y: yy + st.pad * 0.5, w: 0.8, h: 0.3, fontSize: 13, bold: true, color: palDark ? PRI : ACC, fontFace: PPT_FONTS.en, margin: 0 })
          slide.addText(b, { x: x + st.pad, y: yy + st.pad * 0.5 + 0.28, w: cw - st.pad * 2, h: Math.max(0.3, ch - st.pad - 0.28), fontSize: 12.5, color: BODY, fontFace: pptFontOf(b), align: 'left', valign: 'top', margin: 0 })
        })
      } else if (sl.bullets.length) {
        for (const b of sl.bullets) {
          if (y > bodyTop + bodyH - 0.32) break
          const h = Math.max(0.36, pptTextH(b, textW - 0.34, 14) + 0.06)
          pptShape(pres, slide, { x: st.margin, y: y + 0.1, w: 0.14, h: 0.14, fill: { color: ACC }, rectRadius: 0.07 })
          slide.addText(b, { x: st.margin + 0.34, y, w: textW - 0.34, h, fontSize: 14, color: BODY, fontFace: pptFontOf(b), align: 'left', valign: 'top', margin: 0 })
          y += h + 0.14
        }
      } else if (sl.paras.length) {
        const t = sl.paras.join('\n')
        slide.addText(t, { x: st.margin, y: y + 0.05, w: textW, h: Math.min(bodyH - 0.1, pptTextH(t, textW, 14, 1.3) + 0.15), fontSize: 14, color: BODY, fontFace: pptFontOf(t), align: 'left', valign: 'top', lineSpacingMultiple: 1.3, margin: 0 })
        y += Math.min(1.2, pptTextH(sl.paras.join('  '), textW, 14, 1.3) + 0.2)
      }

      if (sl.table) {
        const rows = sl.table.slice(0, 12)
        const tw = imgBox ? textW : bodyW
        const tableRows = rows.map((cells, ri) => cells.map(c => ({
          text: c,
          options: ri === 0
            ? { bold: true, color: palDark ? BG : 'FFFFFF', fill: { color: ACC }, fontSize: 12 }
            : { color: BODY, fill: { color: ri % 2 === 0 ? (palDark ? pal.light : pal.bg) : (palDark ? pal.accent : LIGHT) }, fontSize: 11.5 }
        })))
        const nCol = Math.max(...rows.map(r => r.length))
        const maxLen = Array.from({ length: nCol }, (_, ci) => Math.max(...rows.map(r => pptEstUnits(r[ci] || '') + 2)))
        const total = maxLen.reduce((a, b) => a + b, 0) || 1
        const colW = maxLen.map(l => +((l / total) * tw).toFixed(2))
        slide.addTable(tableRows, { x: st.margin, y: Math.min(Math.max(y, bodyTop + 0.1), 4.6), w: tw, colW, border: { type: 'solid', pt: 0.5, color: palDark ? ACC : LIGHT }, fontFace: PPT_FONTS.cn, valign: 'middle', margin: 0.06, rowH: 0.34 })
      }

      if (imgBox) {
        try {
          const info = loadImage(sl.image)
          if (info && info.width && info.height) {
            const r = Math.min(imgBox.w / info.width, imgBox.h / info.height)
            const w = info.width * r, h = info.height * r
            slide.addImage({ path: sl.image, x: imgBox.x + (imgBox.w - w) / 2, y: imgBox.y + (imgBox.h - h) / 2, w, h })
          }
        } catch { /* 图片缺失不挡生成 */ }
      }
    }

    if (sl.type !== 'cover') pptBadge(pres, slide, pageNo, { dark: palDark, colors: pal })
  }

  await pres.writeFile({ fileName: filePath })
  return fs.statSync(filePath).size
}

// 读取 PPT：逐页提取文本（a:p 段落 / a:t 文本，JSZip 轻解析零依赖，对标 markitdown 的文本层）
async function readPptx(filePath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const names = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/(\d+)/)[1], 10)) - (parseInt(b.match(/(\d+)/)[1], 10)))
  if (!names.length) throw new Error('不是有效的 PPT 文件（缺少 ppt/slides/）')
  const slides = []
  for (const name of names) {
    const xml = await zip.file(name).async('string')
    const lines = []
    for (const pm of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const txt = [...pm[1].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => decodeEntities(m[1])).join('').trim()
      if (txt) lines.push(txt)
    }
    slides.push({ page: slides.length + 1, lines })
  }
  return { count: slides.length, slides, text: slides.map(s => `【第 ${s.page} 页】\n` + s.lines.join('\n')).join('\n\n') }
}

// 编辑 PPT：find/replace 文本替换（层1 同一 a:t 内替换；层2 跨 run 段落重建，保留首 run rPr 格式）——与 editDocx 同构
async function editPptx(filePath, content) {
  const reps = normReplacements(content)
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  const names = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  if (!names.length) throw new Error('不是有效的 PPT 文件（缺少 ppt/slides/）')
  let replaced = 0
  const missed = []
  const slideXml = new Map()
  for (const name of names) slideXml.set(name, await zip.file(name).async('string'))
  for (const rep of reps) {
    let repCount = 0
    for (const name of names) {
      let xml = slideXml.get(name)
      let count = 0
      const findEsc = escapeXml(rep.find)
      const repEsc = escapeXml(rep.replace)
      xml = xml.replace(/(<a:t[^>]*>)([\s\S]*?)(<\/a:t>)/g, (m, open, txt, close) => {
        if (!txt.includes(findEsc)) return m
        count += rep.all ? txt.split(findEsc).length - 1 : 1
        return open + (rep.all ? txt.split(findEsc).join(repEsc) : txt.replace(findEsc, repEsc)) + close
      })
      if (count === 0) {
        xml = xml.replace(/<a:p\b[^>]*\/>|<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (pXml) => {
          if (!pXml.endsWith('</a:p>')) return pXml
          if (count && !rep.all) return pXml
          const texts = [...pXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(m => decodeEntities(m[1]))
          if (!texts.length) return pXml
          const joined = texts.join('')
          if (!joined.includes(rep.find)) return pXml
          const parts = rep.all ? joined.split(rep.find) : (() => {
            const i = joined.indexOf(rep.find)
            return [joined.slice(0, i), joined.slice(i + rep.find.length)]
          })()
          count += rep.all ? parts.length - 1 : 1
          const rPr = (pXml.match(/<a:r>\s*(<a:rPr[\s\S]*?<\/a:rPr>)/) || [])[1] || ''
          let outText = ''
          parts.forEach((seg, i) => { if (i) outText += rep.replace; outText += seg })
          return `<a:p><a:r>${rPr}<a:t xml:space="preserve">${escapeXml(outText)}</a:t></a:r></a:p>`
        })
      }
      if (count > 0) { slideXml.set(name, xml); repCount += count }
    }
    if (repCount === 0) missed.push(rep.find)
    else replaced += repCount
  }
  for (const [name, xml] of slideXml) zip.file(name, xml)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(filePath, buffer)
  return { replaced, missed, size: buffer.length }
}

// ===== docx 校验关卡（v2.7.15：学 MiniMax minimax-docx 的 XSD validation gate 思路——坏件不交差）=====
// 硬错误（结构损坏，Word 会弹修复框）直接 throw 让 AI 当场自愈；软告警返回 issues
async function validateDocx(filePath, opts = {}) {
  const issues = []
  const hard = (msg) => { if (opts.throwOnError) throw new Error('docx 校验关卡：' + msg); issues.push('[硬]' + msg) }
  let zip
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(filePath))
  } catch (e) {
    hard('zip 结构无法读取（' + e.message + '）')
    return { ok: false, issues }
  }
  for (const p of ['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels']) {
    if (!zip.files[p]) hard(`缺少必需部件 ${p}`)
  }
  if (issues.length) return { ok: false, issues }
  const docXml = await zip.file('word/document.xml').async('string')
  if (!docXml.includes('</w:document>')) hard('document.xml 不完整（缺 </w:document>）')
  const pOpen = (docXml.match(/<w:p(?=[\s>])[^>]*(?<!\/)>/g) || []).length
  const pClose = (docXml.match(/<\/w:p>/g) || []).length
  if (pOpen !== pClose) hard(`段落标签不配对（<w:p> ${pOpen} 个 vs </w:p> ${pClose} 个）`)
  // 关系引用完整性：文档里引用的每个 rId 必须在 rels 中注册，且目标文件真实存在
  const relsXml = await zip.file('word/_rels/document.xml.rels').async('string')
  const rels = new Map([...relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2]]))
  for (const m of docXml.matchAll(/r:(?:id|embed|link)="(rId\d+)"/g)) {
    if (!rels.has(m[1])) { issues.push(`引用了未注册的关系 ${m[1]}（图片/超链接可能损坏）`); continue }
    const target = rels.get(m[1])
    if (!/^https?:/i.test(target)) {
      const norm = 'word/' + target.replace(/^\//, '')
      const normFixed = target.includes('../') ? norm.replace(/[^/]+\.\.\//g, '') : norm
      if (!zip.files[normFixed]) issues.push(`关系 ${m[1]} 的目标文件缺失：${target}`)
    }
  }
  // 样式引用完整性：pStyle 引用的样式必须在 styles.xml 定义（缺了 Word 显示默认样式）
  if (zip.files['word/styles.xml']) {
    const stylesXml = await zip.file('word/styles.xml').async('string')
    const styleIds = new Set([...stylesXml.matchAll(/w:styleId="([^"]+)"/g)].map(m => m[1]))
    for (const m of docXml.matchAll(/<w:pStyle w:val="([^"]+)"/g)) {
      if (!styleIds.has(m[1])) issues.push(`段落引用了未定义样式 ${m[1]}`)
    }
  }
  const ok = !issues.some(i => i.startsWith('[硬]'))
  return { ok, issues }
}

module.exports = { createDocx, readDocxText, readPdfText, parseWordComments, parseWordFormat, wordFormatFingerprint, parseFormatRuleText, extractPaperFormatSpec, checkPaperFormat, anchorSpecRole, convertNumPrToText, replaceCoverFields, applyWordFormat, applyWordTemplate, modifyDocx, styleDocx, createXlsx, appendXlsxRows, readXlsx, modifyXlsxCell, modifyXlsxCells, formatXlsx, listXlsxSheets, scanWordTables, formatWordTable, addWordTable, editWordTable, fixPaperPaging, svgToPng, isLegacyDoc, isFormatDemoPara, splitTplSections, classifyTplSection, softbreakSplitBlocks, createPptx, readPptx, editPptx, validateDocx, PPT_PALETTES, PPT_STYLES }
