// 临时探针：摸清素材论文/模板真身（用完即删）
const fs = require('fs')
const JSZip = require('jszip')
const path = require('path')
const DIR = 'f:/局域网互传2.0/实验喵！'

async function main() {
  // ===== 论文 =====
  const pz = await JSZip.loadAsync(fs.readFileSync(path.join(DIR, '素材论文.docx')))
  const pdoc = await pz.file('word/document.xml').async('string')
  console.log('=== 素材论文 ===')
  console.log('含盒马鲜生:', pdoc.includes('盒马鲜生'), '| 含数字经济:', pdoc.includes('数字经济'), '| 含0F1115:', pdoc.includes('0F1115'), '| 含Segoe UI:', pdoc.includes('Segoe UI'), '| 表格数:', (pdoc.match(/<w:tbl>/g) || []).length, '| 含Abstract:', /Abstract/i.test(pdoc), '| 含Keywords:', /Keywords/i.test(pdoc))
  const bodyOpen = pdoc.match(/<w:body(?:\s[^>]*)?>/)
  const inner = pdoc.slice(bodyOpen.index + bodyOpen[0].length, pdoc.lastIndexOf('</w:body>'))
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  let m, n = 0, texts = []
  while ((m = re.exec(inner)) && n < 400) {
    const t = (m[0].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('')
    if (t.trim()) texts.push(t.trim().slice(0, 40))
    n++
  }
  console.log('前25个非空段:', JSON.stringify(texts.slice(0, 25), null, 0))
  console.log('总非空段:', texts.length)

  // ===== 模板 =====
  const tz = await JSZip.loadAsync(fs.readFileSync(path.join(DIR, '论文格式模板.docx')))
  const tdoc = await tz.file('word/document.xml').async('string')
  console.log('\n=== 论文格式模板 ===')
  console.log('部件:', Object.keys(tz.files).filter((f) => /word\/(header|footer)/.test(f)).join(', '))
  console.log('sectPr数:', (tdoc.match(/<w:sectPr[\s>]/g) || []).length, '| upperRoman:', tdoc.includes('upperRoman'), '| start=1:', tdoc.includes('w:start="1"'), '| headerReference:', (tdoc.match(/headerReference/g) || []).length, '| footerReference:', (tdoc.match(/footerReference/g) || []).length)
  const { splitTplSections } = (() => { const o = require('../ai/office'); return o })()
  // splitTplSections 未导出的话直接复制逻辑太重——先试 require
  const bodyO = tdoc.match(/<w:body(?:\s[^>]*)?>/)
  const tinner = tdoc.slice(bodyO.index + bodyO[0].length, tdoc.lastIndexOf('</w:body>'))
  const tre = /<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>|<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  // 手动切节
  const secs = []
  let cur = []
  let mm
  const blocks = []
  while ((mm = tre.exec(tinner))) blocks.push(mm[0])
  for (const b of blocks) {
    if (b.startsWith('<w:sectPr')) { secs.push(cur); cur = []; continue }
    if (b.startsWith('<w:p') && b.includes('<w:sectPr')) { cur.push(b); secs.push(cur); cur = []; continue }
    cur.push(b)
  }
  secs.push(cur)
  secs.forEach((s, i) => {
    const ts = s.map((b) => (b.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('')).filter((t) => t.trim())
    console.log(`节#${i}: 段=${s.length} 首3行=${JSON.stringify(ts.slice(0, 3))}`)
  })
  // 封面行 w:t 结构（第一节前12段）
  console.log('\n封面区段落 w:t 明细:')
  secs[0] && secs[0].slice(0, 14).forEach((b, i) => {
    const wts = (b.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((x) => x.replace(/<\/?w:t[^>]*>/g, ''))
    console.log(`  p${i}: ${JSON.stringify(wts)}`)
  })
  const ni = secs.findIndex((s) => s.map((b) => (b.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('')).join('').includes('题目'))
  if (ni > 0 && ni !== 0) {
    console.log(`\n含"题目"的节#${ni} 段落 w:t 明细:`)
    secs[ni].slice(0, 16).forEach((b, i) => {
      const wts = (b.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map((x) => x.replace(/<\/?w:t[^>]*>/g, ''))
      console.log(`  p${i}: ${JSON.stringify(wts)}`)
    })
  }
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
