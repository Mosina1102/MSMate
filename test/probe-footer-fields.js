// 验证产出页脚页码是真 PAGE 域 + 封面/页眉与模板结构一致性
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

const DIR = 'f:/局域网互传2.0/实验喵！'
const TPL = path.join(DIR, '论文格式模板.docx')
const OUT = path.join(DIR, '素材论文-套模板格式.docx')

async function main() {
  const tplZip = await JSZip.loadAsync(fs.readFileSync(TPL))
  const outZip = await JSZip.loadAsync(fs.readFileSync(OUT))
  const asserts = []
  const ok = (name, cond) => asserts.push(`${cond ? 'PASS' : 'FAIL'} ${name}`)

  // 1) 页脚页码必须是 PAGE 域（fldSimple/instrText），不能是死文本
  const footers = Object.keys(outZip.files).filter((f) => /word\/footer\d+\.xml$/.test(f))
  let hasPageField = false
  for (const f of footers) {
    const xml = await outZip.file(f).async('string')
    if (/PAGE/.test(xml) && (xml.includes('fldChar') || xml.includes('fldSimple'))) hasPageField = true
  }
  ok(`页脚页码是 PAGE 域（${footers.length} 个页脚）`, hasPageField)

  // 2) 页眉部件与模板一致（模板的页眉被原样继承）
  const tplHeaders = Object.keys(tplZip.files).filter((f) => /word\/header\d+\.xml$/.test(f))
  const outHeaders = Object.keys(outZip.files).filter((f) => /word\/header\d+\.xml$/.test(f))
  ok(`页眉部件数量>=模板（模板${tplHeaders.length}/产出${outHeaders.length}）`, outHeaders.length >= tplHeaders.length)
  // 模板页眉文本集合 ⊆ 产出页眉文本集合
  const getTexts = async (zip, f) => (await zip.file(f).async('string')).match(/<w:t[^>]*>([^<]*)<\/w:t>/g)?.map((t) => t.replace(/<[^>]+>/g, '')).join('') || ''
  const tplHeaderTexts = new Set()
  for (const f of tplHeaders) { const t = (await getTexts(tplZip, f)).trim(); if (t) tplHeaderTexts.add(t) }
  const outHeaderTexts = new Set()
  for (const f of outHeaders) { const t = (await getTexts(outZip, f)).trim(); if (t) outHeaderTexts.add(t) }
  let allCovered = true
  for (const t of tplHeaderTexts) if (!outHeaderTexts.has(t)) { allCovered = false; console.log(`  缺页眉文本: "${t}"`) }
  // 模板页眉为空（本文模板即如此）→ 断言产出也空（忠实继承，不凭空造页眉）
  if (tplHeaderTexts.size === 0) ok('模板页眉为空 → 产出页眉同样为空（忠实继承）', outHeaderTexts.size === 0)
  else ok('模板页眉文本全部被产出继承', allCovered)

  // 3) 封面结构一致：模板封面节的 drawing/pict 数量 = 产出封面（校徽等图形迁入）
  const tplDoc = await tplZip.file('word/document.xml').async('string')
  const outDoc = await outZip.file('word/document.xml').async('string')
  const tplCover = tplDoc.slice(0, tplDoc.indexOf('</w:sectPr>'))
  const outCover = outDoc.slice(0, outDoc.indexOf('</w:sectPr>'))
  const cnt = (s, re) => (s.match(re) || []).length
  ok(`封面图形数量一致（模板${cnt(tplCover, /<w:drawing|<w:pict/g)}/产出${cnt(outCover, /<w:drawing|<w:pict/g)}）`,
    cnt(tplCover, /<w:drawing|<w:pict/g) === cnt(outCover, /<w:drawing|<w:pict/g))
  // 封面段落结构：段落数量接近（字段替换不改段数）
  const tplCoverParas = cnt(tplCover, /<w:p[ >]/g)
  const outCoverParas = cnt(outCover, /<w:p[ >]/g)
  ok(`封面段落数一致（模板${tplCoverParas}/产出${outCoverParas}）`, tplCoverParas === outCoverParas)

  // 4) 页面尺寸/边距与模板一致（sectPr pgSz/pgMar）
  const tplSz = tplDoc.match(/<w:pgSz[^>]*\/>/)?.[0]
  const outSz = outDoc.match(/<w:pgSz[^>]*\/>/)?.[0]
  ok(`页面尺寸一致（${(tplSz || '').slice(0, 50)}）`, tplSz && tplSz === outSz)

  // 5) 图片资产迁移：模板封面图 media 文件在产出包内
  const tplMedia = Object.keys(tplZip.files).filter((f) => /^word\/media\//.test(f))
  const outMedia = Object.keys(outZip.files).filter((f) => /^word\/media\//.test(f))
  ok(`media 图片资产存在（模板${tplMedia.length}/产出${outMedia.length}）`, outMedia.length >= tplMedia.length)

  console.log(asserts.join('\n'))
  const fail = asserts.filter((a) => a.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
