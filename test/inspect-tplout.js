// 深挖 apply_word_template 产出三个疑点：仿宋残留位置 / 模板示范说明段 / 目录域
const fs = require('fs')
const JSZip = require('jszip')

async function main() {
  const z = await JSZip.loadAsync(fs.readFileSync('C:/Users/ars/Downloads/人工智能论文_套模板测试.docx'))
  const docXml = await z.file('word/document.xml').async('string')
  const files = Object.keys(z.files).filter((f) => !z.files[f].dir)

  // ① 仿宋/方正仿宋 run 都在哪些文字上
  console.log('=== ① 方正仿宋_GBK run 的文字 ===')
  const paras = docXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []
  paras.forEach((p) => {
    if (p.includes('方正仿宋_GBK')) {
      const txt = (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')
      console.log(`  [仿宋段] "${txt.slice(0, 50)}"`)
    }
  })

  // ② 模板示范说明段（"三号黑体，居中"这类格式说明文字）
  console.log('\n=== ② 模板示范说明段（含"号"+字体名/居中字样的短段）===')
  paras.forEach((p) => {
    const txt = (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')
    if (/^[一二三四五六]?号.{0,8}(黑体|宋体|楷体|仿宋|加粗|居中)/.test(txt) || (/^(摘要|目录|参考文献|致谢)$/.test(txt.trim()) && txt.length < 6)) {
      console.log(`  [示范段] "${txt.slice(0, 60)}"`)
    }
  })

  // ③ 目录域与 sectPr 分节
  console.log('\n=== ③ 目录域 / 分节 ===')
  console.log('  TOC 域:', docXml.includes('TOC') ? '有' : '无', '| fldSimple:', docXml.includes('fldSimple') ? '有' : '无', '| instrText:', docXml.includes('instrText') ? '有' : '无')
  const sects = (docXml.match(/<w:sectPr/g) || []).length
  console.log('  分节数:', sects)

  // ④ 页眉文件们的内容
  console.log('\n=== ④ 页眉文件 ===')
  for (const f of files.filter((f) => /header\d*\.xml/.test(f))) {
    const h = await z.file(f).async('string')
    const txt = (h.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')
    console.log(`  ${f}: "${txt.slice(0, 50)}"`)
  }
}
main()
