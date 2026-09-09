// 追踪输出文档里 0F1115 / Segoe UI 残留位置
const fs = require('fs')
const JSZip = require('jszip')
async function main() {
  const zip = await JSZip.loadAsync(fs.readFileSync('f:/局域网互传2.0/实验喵！/素材论文-套模板格式.docx'))
  const doc = await zip.file('word/document.xml').async('string')
  for (const needle of ['0F1115', 'Segoe UI']) {
    let idx = 0
    let n = 0
    while ((idx = doc.indexOf(needle, idx)) >= 0 && n < 5) {
      console.log(`\n=== ${needle} @${idx} ===`)
      console.log(doc.slice(Math.max(0, idx - 260), idx + 120).replace(/></g, '>\n<'))
      idx += needle.length
      n++
    }
    console.log(`${needle} total: ${(doc.match(new RegExp(needle.replace(/ /g, ' '), 'g')) || []).length}`)
  }
  console.log('\n=== 尾部 600 ===')
  console.log(doc.slice(-600).replace(/></g, '>\n<'))
}
main().catch((e) => { console.error(e); process.exit(1) })
