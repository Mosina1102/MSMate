// style_word 探针：真跑 createDocx → styleDocx 指令式改格式 → 验证 XML 手术结果
const fs = require('fs')
const path = require('path')
const os = require('os')
const ExcelJS = null
const JSZip = require('jszip')
const { createDocx, styleDocx } = require('../ai/office')

;(async () => {
  let pass = 0, fail = 0
  const ok = (cond, name) => { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msstyle-'))
  const f = path.join(dir, 't.docx')

  // ① 建测试文档：标题 + 一级标题 + 两段正文
  await createDocx(f, {
    title: '测试文档大标题',
    paragraphs: [
      { text: '第一章 概述', style: 'h1' },
      { text: '这是第一段正文内容，讲的是背景。', style: 'body' },
      { text: '这是第二段正文，有个特殊词要定位。', style: 'body' }
    ]
  })

  // ② 大标题默认居中（本轮修复验证：createDocx 的 TITLE 带 alignment CENTER）
  {
    const zip = await JSZip.loadAsync(fs.readFileSync(f))
    const xml = await zip.file('word/document.xml').async('string')
    const titlePara = (xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []).find((p) => p.includes('测试文档大标题'))
    ok(!!titlePara && /w:jc w:val="center"/.test(titlePara), '大标题默认居中（createDocx TITLE 带 jc center）')
  }

  // ③ style_word 指令：title 加大字号 + all 黑色 + contains 定位加粗 + h1 居中
  const r = await styleDocx(f, [
    { target: 'title', sizePt: 26 },
    { target: 'all', color: '000000' },
    { target: { contains: '特殊词' }, bold: true },
    { target: 'h1', align: 'center', font: '黑体' }
  ])
  ok(r && r.done.includes('title'), `title 指令命中（${(r.done.match(/title[^；]*/g) || [''])[0]}）`)
  ok(r.done.includes('all: 颜色=000000（4 段）'), `all 黑色命中全部段落（${(r.done.match(/all[^；]*/g) || [''])[0]}）`)

  // ④ XML 验证
  const zip2 = await JSZip.loadAsync(fs.readFileSync(f))
  const xml2 = await zip2.file('word/document.xml').async('string')
  const paras = xml2.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []
  const titleP = paras.find((p) => p.includes('测试文档大标题'))
  const spP = paras.find((p) => p.includes('特殊词'))
  const h1P = paras.find((p) => p.includes('第一章 概述'))
  ok(!!titleP && /<w:sz w:val="52"/.test(titleP), 'title 字号 26pt=52 半点注入')
  ok(!!spP && /<w:b\/>/.test(spP), 'contains 定位段落加粗注入')
  ok(!!h1P && /w:jc w:val="center"/.test(h1P) && /w:eastAsia="黑体"/.test(h1P), 'h1 居中+黑体双属性')
  const blackRuns = (xml2.match(/<w:color w:val="000000"\/>/g) || []).length
  ok(blackRuns >= 3, `all 黑色 color 注入（${blackRuns} 个 run）`)
  ok(!xml2.includes('\uFFFD'), '无乱码污染')

  // ⑤ 全部段落命中校验（target 写错报因）
  let missErr = ''
  try { await styleDocx(f, [{ target: 'h9' }]) } catch (e) { missErr = e.message }
  ok(/没有任何段落命中/.test(missErr), 'target 无命中时报因清晰')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`[style-word] ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('[style-word] 探针炸了:', e.message); process.exit(1) })
