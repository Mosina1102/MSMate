// 深挖产出：每节 sectPr 的页眉页脚引用 + 页眉内容 + 封面节特征
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')

const OUT = 'f:/局域网互传2.0/实验喵！/素材论文-套模板格式.docx'

async function main() {
  const zip = await JSZip.loadAsync(fs.readFileSync(OUT))
  const doc = await zip.file('word/document.xml').async('string')

  // 拆出所有 sectPr（段内 + body 级）
  const sects = []
  const re = /<w:sectPr[\s>][\s\S]*?<\/w:sectPr>/g
  let m
  while ((m = re.exec(doc))) sects.push(m[0])
  console.log(`节数: ${sects.length}`)
  sects.forEach((s, i) => {
    const hdr = (s.match(/<w:headerReference[^>]*r:id="([^"]+)"[^>]*w:type="([^"]+)"[^>]*\/>/g) || [])
    const ftr = (s.match(/<w:footerReference[^>]*r:id="([^"]+)"[^>]*w:type="([^"]+)"[^>]*\/>/g) || [])
    const pgNum = (s.match(/<w:pgNumType[^>]*\/>/) || ['无'])[0]
    const titlePg = s.includes('<w:titlePg/>') ? '有titlePg' : '无titlePg'
    console.log(`--- 节${i + 1}: headerRef=${hdr.length ? hdr.join(' | ') : '无'} footerRef=${ftr.length ? ftr.join(' | ') : '无'} ${pgNum} ${titlePg}`)
  })

  // rels: rId → header/footer 文件
  const rels = await zip.file('word/_rels/document.xml.rels').async('string')
  const relMap = {}
  const re2 = /<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g
  while ((m = re2.exec(rels))) relMap[m[1]] = m[2]

  // 页眉内容
  for (const f of Object.keys(zip.files)) {
    if (/word\/(header|footer)\d+\.xml$/.test(f)) {
      const xml = await zip.file(f).async('string')
      const texts = (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').trim()
      console.log(`${f}: "${texts.slice(0, 60)}"`)
    }
  }

  // 封面节（第一节）到第一个分节符之间的文本 → 看封面长啥样
  const firstSectEnd = doc.indexOf('</w:sectPr>')
  const coverXml = doc.slice(0, firstSectEnd)
  const coverTexts = (coverXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, ''))
  console.log('\n封面节文本行:')
  coverTexts.forEach((t) => { if (t.trim()) console.log('  |' + t.trim()) })
  console.log('\n封面是否含图片(drawing/pict):', /<w:drawing|<w:pict/.test(coverXml))
}
main().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1) })
