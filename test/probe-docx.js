// 分析两份 docx 的内部结构：sectPr 分节/页码/页眉页脚引用、段落格式摘要、表格样式、样式表定义
const fs = require('fs')
const path = require('path')
const base = 'f:/局域网互传2.0/test/docx-probe'

function extractParas(xml, max) {
  const blocks = []
  const re = /<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g
  let m
  while ((m = re.exec(xml)) && blocks.length < max) blocks.push(m[0])
  return blocks
}

function analyze(name, dir) {
  const doc = fs.readFileSync(path.join(dir, 'word/document.xml'), 'utf8')
  const out = { name }
  out.sectCount = (doc.match(/<w:sectPr/g) || []).length
  const sects = doc.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || []
  out.sects = sects.map((s) => ({
    pgNumType: (s.match(/<w:pgNumType[^/>]*\/>/) || ['(none)'])[0],
    headers: (s.match(/<w:headerReference[^/>]*\/>/g) || []),
    footers: (s.match(/<w:footerReference[^/>]*\/>/g) || []),
    titlePg: s.includes('<w:titlePg'),
    pgMar: (s.match(/<w:pgMar[^/>]*\/>/) || [''])[0]
  }))
  out.paras = extractParas(doc, 26).map((p) => ({
    text: (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').slice(0, 45),
    jc: (p.match(/<w:jc w:val="([^"]+)"/) || [])[1] || '',
    pStyle: (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || '',
    fonts: [...new Set((p.match(/w:eastAsia="([^"]+)"/g) || []).map((x) => x))].slice(0, 2),
    sz: [...new Set((p.match(/<w:sz w:val="(\d+)"/g) || []).map((x) => x.match(/\d+/)[0]))].slice(0, 3),
    color: [...new Set((p.match(/<w:color w:val="([^"]+)"/g) || []).map((x) => x))].slice(0, 2),
    bold: p.includes('<w:b/>') || p.includes('<w:b ')
  }))
  out.tableCount = (doc.match(/<w:tbl>/g) || []).length
  const tbl = doc.match(/<w:tbl>[\s\S]{0,900}?<\/w:tblPr>/)
  out.firstTablePr = tbl ? tbl[0].replace(/\s+/g, ' ').slice(0, 420) : null
  // 样式表：Heading/标题族 + 正文
  const styles = fs.readFileSync(path.join(dir, 'word/styles.xml'), 'utf8')
  out.styles = {}
  for (const m of styles.matchAll(/<w:style [^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const id = m[1]
    const nm = (m[2].match(/<w:name w:val="([^"]+)"/) || [])[1] || ''
    if (/^(Heading\d|1|2|3|4|a[0-9]{1,2}|Normal)$/.test(id) || /heading|标题|页眉|页脚|正文/.test(nm)) {
      out.styles[id + '(' + nm + ')'] = {
        color: (m[2].match(/<w:color w:val="([^"]+)"/) || [])[1],
        sz: (m[2].match(/<w:sz w:val="(\d+)"/) || [])[1],
        eastAsia: (m[2].match(/w:eastAsia="([^"]+)"/) || [])[1],
        ascii: (m[2].match(/w:ascii="([^"]+)"/) || [])[1],
        jc: (m[2].match(/<w:jc w:val="([^"]+)"/) || [])[1],
        outline: (m[2].match(/<w:outlineLvl w:val="(\d+)"/) || [])[1]
      }
    }
  }
  // header/footer 文本
  out.hf = {}
  for (const f of fs.readdirSync(path.join(dir, 'word'))) {
    if (/^(header|footer)\d+\.xml$/.test(f)) {
      const c = fs.readFileSync(path.join(dir, 'word', f), 'utf8')
      const txt = (c.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('|').slice(0, 60)
      out.hf[f] = { txt, underline: c.includes('<w:u '), pgField: c.includes('PAGE'), tabStops: (c.match(/<w:tab w:val="(\w+)"/g) || []).join(',') }
    }
  }
  return out
}

console.log(JSON.stringify([
  analyze('TEMPLATE', path.join(base, 'template')),
  analyze('PAPER', path.join(base, 'paper'))
], null, 1))
