// 调试：dump 模板切节结果，看每节首段文本与归属判定
const fs = require('fs')
const JSZip = require('jszip')
const SRC = 'f:/局域网互传2.0/ai/office.js'
// 直接用 office.js 内部函数——通过重新 require 拿不到非导出函数，这里复制 scanTopBlocks/classifyTplSection 逻辑调试
const decodeEntities = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&(?!amp;)/g, '&').replace(/&amp;/g, '&')

function scanTopBlocks(bodyInner) {
  const blocks = []
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>|<w:sectPr(?:\s[^>]*)?\/>/g
  let m
  while ((m = re.exec(bodyInner))) {
    const xml = m[0]
    const type = xml.startsWith('<w:tbl') ? 'tbl' : xml.startsWith('<w:sectPr') ? 'sect' : 'p'
    let text = ''
    if (type === 'p') text = decodeEntities((xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
    blocks.push({ type, xml, text })
  }
  return blocks
}

async function main() {
  const zip = await JSZip.loadAsync(fs.readFileSync('f:/局域网互传2.0/实验喵！/论文格式模板.docx'))
  const doc = await zip.file('word/document.xml').async('string')
  const bodyOpen = doc.match(/<w:body(?:\s[^>]*)?>/)
  const inner = doc.slice(bodyOpen.index + bodyOpen[0].length, doc.lastIndexOf('</w:body>'))
  const blocks = scanTopBlocks(inner)
  console.log('total blocks:', blocks.length)
  // 手动切节 dump
  const sections = []
  let cur = { paras: [], sectPr: null }
  for (const b of blocks) {
    if (b.type === 'sect') { cur.sectPr = b.xml; sections.push(cur); cur = { paras: [], sectPr: null } }
    else if (b.type === 'p' && /<w:sectPr[\s>]/.test(b.xml)) {
      cur.sectPr = (b.xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/) || [null])[0] || cur.sectPr
      sections.push(cur); cur = { paras: [], sectPr: null }
    } else cur.paras.push(b)
  }
  if (cur.paras.length || cur.sectPr) sections.push(cur)
  console.log('sections:', sections.length)
  sections.forEach((s, i) => {
    const nonEmpty = s.paras.filter((p) => p.text.trim())
    const texts = nonEmpty.slice(0, 3).map((p) => JSON.stringify(p.text.slice(0, 25)))
    const sectInfo = s.sectPr ? ((s.sectPr.match(/<w:pgNumType[^/>]*\/>/) || ['nopg'])[0] + ' ' + (s.sectPr.match(/headerReference[^/]*r:id="([^"]+)"/) || ['', ''])[1]) : 'no-sectPr'
    console.log(`#${i} paras=${s.paras.length} first=${texts.join(' | ')} || ${sectInfo}`)
  })
}
main().catch((e) => { console.error(e); process.exit(1) })
