// 格式指纹"提取A→套B"真实链路探针（回答老大三问：工具齐吗/指纹全吗/直接套行不行）
// 流程：造格式丰富A + 素文B → 提A指纹 → applyWordFormat(map source) 套B → diff 两指纹
const fs = require('fs')
const path = require('path')
const os = require('os')
const office = require('../ai/office')

function fail(m) { console.error('PROBE_FAIL: ' + m); process.exit(1) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-probe-'))

async function main() {
  // ① 造 A：格式丰富（标题黑体二号居中 / 正文宋体小四 1.5 倍行距首行缩进）
  const A = path.join(tmp, 'A-参考.docx')
  await office.createDocx(A, {
    fonts: { heading: '黑体', body: '宋体' },
    lineSpacing: 1.5,
    firstLine: true,
    paragraphs: [
      { text: '格式参考文档标题', style: 'title' },
      { text: '这是一级标题示范', style: 'h1' },
      { text: '正文段落一号：宋体小四，1.5 倍行距，首行缩进两字符，用于验证指纹提取与套用的完整性。', style: 'body' },
      { text: '正文段落二号：内容不同但格式同源，验证众数聚合的稳定性。', style: 'body' }
    ]
  })
  // ② 造 B：全默认（微软雅黑/单倍行距/无缩进——和 A 每项都不同）
  const B = path.join(tmp, 'B-目标.docx')
  await office.createDocx(B, {
    paragraphs: [
      { text: '目标文档标题（待被改成 A 的格式）', style: 'title' },
      { text: '目标一级标题（待套 A 的 h1 格式）', style: 'h1' },
      { text: '目标正文段落：默认格式，等会被套成 A 的样子。', style: 'body' }
    ]
  })
  // ②.5 跨页属性链验证：A 的表格开"跨页重复表头"（formatWordTable 默认给表头加 tblHeader），
  //     B 的表格关闭——map source 套用后 B 应被对齐成 A 的跨页策略
  await office.addWordTable(A, { rows: [['列一', '列二'], ['a1', 'b1'], ['a2', 'b2']] })
  await office.formatWordTable(A, { index: 1, style: 'grid' })   // headerRepeat 默认 true → 表头加 tblHeader
  await office.addWordTable(B, { rows: [['甲', '乙'], ['丙', '丁']] })
  // 模拟"用户手打的表"：剥掉 B 的 tblHeader（addWordTable 默认会加）——真实场景 B 的表通常没设跨页表头
  const JSZip = require('jszip')
  {
    const zip = await JSZip.loadAsync(fs.readFileSync(B))
    let xml = await zip.file('word/document.xml').async('string')
    xml = xml.replace(/<w:tblHeader\/>/g, '')
    zip.file('word/document.xml', xml)
    fs.writeFileSync(B, await zip.generateAsync({ type: 'nodebuffer' }))
    console.log('[准备] B 的表格已剥成"手打无跨页表头"状态')
  }

  // ③ 提取 A 的指纹（老大问 2：指纹全不全，看输出字段）
  const fpA = office.wordFormatFingerprint(await office.parseWordFormat(A))
  console.log('[A 指纹]')
  console.log(fpA.summary || JSON.stringify(fpA.fingerprint, null, 2))

  // ④ 直接套：B 按角色 map 全部 source（老大问 3：直接按提取的格式走，不逐条手写）
  const applyRet = await office.applyWordFormat(B, A, { map: { title: 'source', h1: 'source', body: 'source' } })
  console.log(`[套用完成] 跨页同步：${applyRet.crossPageFixed ? JSON.stringify(applyRet.crossPageFixed) : '（未触发）'}`)
  console.log(`[A 指纹跨页] ${JSON.stringify(fpA.fingerprint.crossPage)}`)

  // ⑤ diff 验证：A 里存在的角色，套完后 B 应一致；A 没有的角色（如 h2）没有套用意义，跳过
  const fpB = office.wordFormatFingerprint(await office.parseWordFormat(B))
  const roles = ['title', 'h1', 'h2', 'h3', 'body']
  let allOk = true
  for (const r of roles) {
    const a = fpA.fingerprint[r] || {}
    if (!Object.keys(a).length) continue // A 没有该角色 → 跳过（格式套用不动内容，不造空角色）
    const b = JSON.stringify(fpB.fingerprint[r] || {})
    const ok = b === JSON.stringify(a)
    console.log(`[${r}] ${ok ? '✓ 一致' : '✗ 不一致'}${ok ? '' : `\n  A=${JSON.stringify(a)}\n  B=${b}`}`)
    if (!ok) allOk = false
  }
  // 页面设置也应被带上（A 与 B 同为 createDocx 默认页面，故再验证单项字段存在性）
  console.log(`[页面设置] A=${JSON.stringify(fpA.fingerprint.page || '（指纹未含页面——由 sectPr 单独管理）')}`)
  // 跨页断言：套完后 B 的表格应与 A 同策略（表头重复开）
  const cpB = fpB.fingerprint.crossPage
  const cpOk = fpA.fingerprint.crossPage && fpA.fingerprint.crossPage.headerRepeat === true && cpB && cpB.headerRepeat === true
  console.log(`[跨页属性] ${cpOk ? '✓ B 已对齐 A（表头跨页重复=开）' : `✗ 未对齐：A=${JSON.stringify(fpA.fingerprint.crossPage)} B=${JSON.stringify(cpB)}`}`)
  if (!cpOk) allOk = false

  fs.rmSync(tmp, { recursive: true, force: true })
  if (!allOk) fail('存在不一致角色')
  console.log('\nPROBE_OK：指纹提取→map source 直接套用，全角色一致')
}

// ⑥ style_word 新指令全验证：斜体/下划线/删除线/行距/段前后/缩进/页边距/分散对齐/上下标/突出显示
async function probeStyleWord() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'style-probe-'))
  const D = path.join(tmp, 'style-target.docx')
  await office.createDocx(D, {
    paragraphs: [
      { text: '样式验证文档标题', style: 'title' },
      { text: '这段文字用来验证斜体下划线删除线突出显示等 run 级格式指令。', style: 'body' }
    ]
  })
  // 一口气下全部新指令
  await office.styleDocx(D, [
    { target: 'title', align: 'distribute', lineRatio: 2 },
    { target: { contains: '斜体下划线' }, italic: true, underline: 'double', strike: true, highlight: 'yellow', lineRatio: 1.5, beforePt: 6, afterPt: 12, firstLine: 2 },
    { target: 'page', marginTopCm: 3, marginLeftCm: 2.8 }
  ])
  // 指纹回读验证
  const fp = office.wordFormatFingerprint(await office.parseWordFormat(D))
  const body = fp.fingerprint.body || {}
  const seg = (fp.summary.match(/正文：[^\n]*/) || [''])[0]
  console.log('[style_word 新指令回读]')
  console.log(seg)
  console.log(`页面: ${JSON.stringify(fp.fingerprint.page)}`)
  const checks = [
    ['斜体', body.italic == 1 || body.italic === true],      // modeOf 会把 '1' 转数字 1
    ['下划线 double', body.underline === 'double'],
    ['删除线', body.strike == 1 || body.strike === true],
    ['高亮 yellow', body.highlight === 'yellow'],
    ['行距 1.5', body.lineRatio != null && Math.abs(body.lineRatio - 1.5) < 0.05],
    ['段前 6pt', body.beforePt != null && Math.abs(body.beforePt - 6) < 1],
    ['段后 12pt', body.afterPt != null && Math.abs(body.afterPt - 12) < 1],
    ['首行缩进 2 字符', body.indentFirstLine != null && Math.abs(body.indentFirstLine - 2) < 0.2],
    ['页边距上 3cm', fp.fingerprint.page && Math.abs(fp.fingerprint.page.marginTopCm - 3) < 0.05],
    ['页边距左 2.8cm', fp.fingerprint.page && Math.abs(fp.fingerprint.page.marginLeftCm - 2.8) < 0.05]
  ]
  let bad = 0
  for (const [name, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (!ok) bad++ }
  // 分散对齐（title 角色 align=distribute——指纹 title 里看）
  const t = fp.fingerprint.title || {}
  const distOk = t.align === 'distribute'
  console.log(`  ${distOk ? '✓' : '✗'} 分散对齐(distribute)`); if (!distOk) bad++
  fs.rmSync(tmp, { recursive: true, force: true })
  if (bad) fail(`style_word 新指令 ${bad} 项验证失败`)
  console.log('STYLE_PROBE_OK：斜体/下划线/删除线/高亮/行距/段前后/缩进/页边距/分散对齐 读写全通')
}

// ⑦ style_word 列表/页眉页脚 + add_word_image 全验证
async function probeNewFeatures() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newfeat-probe-'))
  const D = path.join(tmp, 'nf.docx')
  await office.createDocx(D, {
    paragraphs: [
      { text: '功能验证文档', style: 'title' },
      { text: '这是第一个列表项', style: 'body' },
      { text: '这是第二个列表项', style: 'body' },
      { text: '插图定位段落：图片会插到这段后面', style: 'body' }
    ]
  })
  // 列表 + 页眉
  await office.styleDocx(D, [
    { target: { contains: '第一个列表项' }, list: 'bullet' },
    { target: { contains: '第二个列表项' }, list: 'number' },
    { target: 'header', text: 'MSMate 公共页眉' }
  ])
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(fs.readFileSync(D))
  const xml = await zip.file('word/document.xml').async('string')
  const hdr = zip.file('word/header1.xml') ? await zip.file('word/header1.xml').async('string') : ''
  const num = zip.file('word/numbering.xml') ? await zip.file('word/numbering.xml').async('string') : ''
  const checks = [
    ['项目符号 numId=10', /<w:numId w:val="10"\/>/.test(xml)],
    ['编号 numId=11', /<w:numId w:val="11"\/>/.test(xml)],
    ['numbering.xml 定义', num.includes('abstractNumId="90"') && num.includes('abstractNumId="91"')],
    ['页眉部件含文字', hdr.includes('MSMate 公共页眉')],
    ['sectPr 页眉引用', /<w:headerReference[^>]*w:type="default"/.test(xml)]
  ]
  let bad = 0
  for (const [n, ok] of checks) { console.log(`  ${ok ? '✓' : '✗'} ${n}`); if (!ok) bad++ }
  // 页眉清空
  await office.styleDocx(D, [{ target: 'header', text: '' }])
  const hdr2 = await JSZip.loadAsync(fs.readFileSync(D)).then(async (z) => await z.file('word/header1.xml').async('string'))
  const clrOk = !hdr2.includes('MSMate 公共页眉')
  console.log(`  ${clrOk ? '✓' : '✗'} 页眉清空`); if (!clrOk) bad++
  // 插图：造个小 PNG（1x1 红点）插到"插图定位段落"后
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const imgP = path.join(tmp, 'dot.png')
  fs.writeFileSync(imgP, png)
  await office.addWordImage(D, imgP, { afterText: '插图定位段落', widthCm: 5 })
  const z3 = await JSZip.loadAsync(fs.readFileSync(D))
  const x3 = await z3.file('word/document.xml').async('string')
  const media = z3.file(/^word\/media\//) || []
  const posOk = x3.indexOf('<w:drawing') > x3.indexOf('插图定位段落')
  const imgOk = media.length === 1 && /<w:drawing/.test(x3) && posOk
  console.log(`  ${imgOk ? '✓' : '✗'} 插图（media 1 个 + drawing 在定位段后）`); if (!imgOk) bad++
  fs.rmSync(tmp, { recursive: true, force: true })
  if (bad) fail(`新功能 ${bad} 项失败`)
  console.log('NEWFEAT_PROBE_OK：列表/页眉(写入+清空)/插图 全通')
}

// ⑧ PPT 页级操作/结构读取 + 表格行高
let bad = 0
async function probePptTable() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-tbl-probe-'))
  // PPT：造 3 页 → 读结构 → 调序 → 删页
  const P = path.join(tmp, 'probe.pptx')
  await office.createPptx(P, {
    title: 'PPT 页级操作探针',
    content: 'theme: midnight\n---\n#cover 探针封面\n---\n## 第一页标题\n第一页正文内容\n---\n## 第二页标题\n第二页正文内容\n---\n## 第三页标题\n第三页正文内容'
  })
  const r0 = await office.readPptx(P)
  const structOk = r0.count === 4 && r0.slides.every((s) => s.shapes >= 0 && s.struct !== undefined)
  console.log(`  ${structOk ? '✓' : '✗'} read_pptx 结构计数（${r0.count} 页，首页：${r0.slides[0].struct || '纯文字'}）`)
  if (!structOk) bad = (bad || 0) + 1
  // 调序：把第 2 页移到第 1 位 → 第 1 页应变成"第一页标题"所在页之外的顺序变化
  await office.editPptx(P, { actions: [{ op: 'moveSlide', page: 2, to: 1 }] })
  const r1 = await office.readPptx(P)
  const movedOk = r1.count === 4 && !r1.slides[0].lines.join('').includes('探针封面')
  console.log(`  ${movedOk ? '✓' : '✗'} moveSlide 调序（新第 1 页 = ${r1.slides[0].lines[0] || '（无文字）'}）`)
  if (!movedOk) bad = (bad || 0) + 1
  // 删页：删掉第 1 页 → 剩 3 页
  await office.editPptx(P, { actions: [{ op: 'deleteSlide', page: 1 }] })
  const r2 = await office.readPptx(P)
  const delOk = r2.count === 3
  console.log(`  ${delOk ? '✓' : '✗'} deleteSlide 删页（现 ${r2.count} 页）`)
  if (!delOk) bad = (bad || 0) + 1
  // 加新页：插到第 1 页后（成为新的第 2 页）
  await office.editPptx(P, { actions: [{ op: 'insertSlide', page: 1, title: '新插入页标题', body: '新页正文第一行\n新页正文第二行' }] })
  const r3 = await office.readPptx(P)
  const newPage = r3.slides[1] || {}
  const insOk = r3.count === 4 && (newPage.lines || []).join('|').includes('新插入页标题') && (newPage.lines || []).join('|').includes('新页正文第一行')
  console.log(`  ${insOk ? '✓' : '✗'} insertSlide 加页（新第 2 页：${(newPage.lines || [])[0] || '（无）'}，${newPage.struct || ''}）`)
  if (!insOk) bad = (bad || 0) + 1
  // 表格行高：docx + addWordTable + formatWordTable rowHeightCm
  const D = path.join(tmp, 'rowh.docx')
  await office.createDocx(D, { paragraphs: [{ text: '行高验证', style: 'body' }] })
  await office.addWordTable(D, { rows: [['甲', '乙'], ['丙', '丁']] })
  await office.formatWordTable(D, { index: 1, style: 'grid', rowHeightCm: 1.2 })
  const JSZip2 = require('jszip')
  const z4 = await JSZip2.loadAsync(fs.readFileSync(D))
  const x4 = await z4.file('word/document.xml').async('string')
  const trOk = /<w:trHeight w:val="680" w:hRule="atLeast"\/>/.test(x4)   // 1.2cm ≈ 680 dxa
  console.log(`  ${trOk ? '✓' : '✗'} 表格行高 trHeight(1.2cm≈680dxa)`)
  if (!trOk) bad = (bad || 0) + 1
  fs.rmSync(tmp, { recursive: true, force: true })
  bad = bad || 0
  if (bad) fail(`PPT/表格 ${bad} 项失败`)
  console.log('PPTTBL_PROBE_OK：read 结构计数/调序/删页/表格行高 全通')
}

main().then(() => probeStyleWord()).then(() => probeNewFeatures()).then(() => probePptTable()).catch((e) => fail(e.stack || e.message))
