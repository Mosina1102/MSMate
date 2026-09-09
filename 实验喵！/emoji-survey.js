// 全量盘点 UI 中 emoji（只读）
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const files = [
  ['index.html', path.join(root, 'src/index.html')],
  ['app.js', path.join(root, 'src/js/app.js')],
  ['webchat.js', path.join(root, 'src/js/webchat.js')],
]
const emojiRe = /[\u2190-\u2BFF\u{1F000}-\u{1FAFF}✓✕⚠️⬆⬇⏳⏰]/u
for (const [name, p] of files) {
  console.log(`===== ${name} =====`)
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  let count = 0
  lines.forEach((l, i) => {
    // 跳过纯注释行（// 或 <!-- 或 css 注释）
    const code = l.replace(/\/\/.*$/, '').replace(/<!--.*?-->/g, '')
    if (!emojiRe.test(code)) return
    const chars = [...new Set(code.match(/\p{Extended_Pictographic}|[\u2190-\u2BFF✓✕⬆⬇]/gu))] || []
    console.log(`L${i + 1} [${chars.join(' ')}] ${code.trim().slice(0, 90)}`)
    count++
  })
  console.log(`小计 ${count} 行`)
}
