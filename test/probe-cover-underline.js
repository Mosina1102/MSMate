// 侦查：①模板封面"题  目"行的下划线实现 ②产出封面题目行为何丢下划线
const fs = require('fs')
const JSZip = require('jszip')

async function probe(label, file, kw) {
  const z = await JSZip.loadAsync(fs.readFileSync(file))
  const doc = await z.file('word/document.xml').async('string')
  const paras = [...doc.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
  console.log(`\n===== ${label} =====`)
  let found = 0
  for (const p of paras) {
    const text = (p[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')
    if (kw.test(text) && found < 2) {
      found++
      console.log(`段落文本: "${text.trim().slice(0, 60)}"`)
      console.log(`  XML(前900): ${p[1].replace(/\s+/g, ' ').slice(0, 900)}`)
    }
  }
}

;(async () => {
  const dir = 'C:/Users/ars/Desktop/实验喵！'
  await probe('模板封面题目行', dir + '/论文格式模板.docx', /题\s*目/)
  await probe('产出封面题目行', dir + '/素材论文-套模板格式.docx', /题\s*目|中文题目/)
})().catch((e) => console.error(e.stack))
