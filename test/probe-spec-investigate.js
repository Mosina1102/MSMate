// 侦查：①MSMate AI 的产出（格式规范版）里混进了什么 ②模板里"说明性内容"（红字/文本框标注/批注）的形态
const fs = require('fs')
const JSZip = require('jszip')

async function inspect(label, file) {
  const z = await JSZip.loadAsync(fs.readFileSync(file))
  const doc = await z.file('word/document.xml').async('string')
  console.log(`\n===== ${label} =====`)
  console.log(`document.xml ${(doc.length / 1024).toFixed(0)}KB`)
  // 红字
  const reds = doc.match(/w:color w:val="(FF0000|C00000|FF0100|E60000|DF0101|FF0808|FF1A1A|EE0000|CD0000|8B0000|FF2400|D20000)"/gi) || []
  console.log(`红字 run 数: ${reds.length}`)
  // 文本框标注
  const txbx = (doc.match(/<w:txbxContent>/g) || []).length
  console.log(`文本框(txbxContent) 数: ${txbx}`)
  if (txbx) {
    const texts = [...doc.matchAll(/<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g)].map((m) =>
      (m[1].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('').trim()).filter(Boolean)
    texts.slice(0, 15).forEach((t) => console.log(`  [文本框] ${t.slice(0, 50)}`))
  }
  // 批注
  const hasCmt = !!z.file('word/comments.xml')
  console.log(`批注文件: ${hasCmt ? '有' : '无'}`)
  if (hasCmt) {
    const cxml = await z.file('word/comments.xml').async('string')
    const cmts = [...cxml.matchAll(/<w:comment\s[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:comment>/g)]
    cmts.slice(0, 10).forEach((m) => {
      const t = (m[2].match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('').trim()
      console.log(`  [批注·${m[1]}] ${t.slice(0, 60)}`)
    })
  }
  // 红字文字内容
  const redTexts = [...doc.matchAll(/<w:r>(?:(?!<\/w:r>)[\s\S])*?w:color w:val="(?:FF0000|C00000|D20000|EE0000)"(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>([^<]*)<\/w:t>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/gi)]
    .map((m) => m[1].trim()).filter(Boolean)
  if (redTexts.length) {
    console.log(`红字文字样本:`)
    redTexts.slice(0, 12).forEach((t) => console.log(`  [红字] ${t.slice(0, 50)}`))
  }
  // 占位符
  const ph = doc.match(/[×xX]{6,}/g) || []
  console.log(`×××占位符出现: ${ph.length} 处`)
}

async function main() {
  const dir = 'C:/Users/ars/Desktop/实验喵！'
  const tpl = dir + '/论文格式模板.docx'
  const out = dir + '/素材论文-格式规范版.docx'
  if (fs.existsSync(tpl)) await inspect('模板（论文格式模板.docx）', tpl)
  else console.log('模板不存在: ' + tpl)
  if (fs.existsSync(out)) await inspect('MSMate AI 的产出（素材论文-格式规范版.docx）', out)
  else console.log('产出不存在: ' + out)
}
main().catch((e) => { console.error(e.stack); process.exit(1) })
