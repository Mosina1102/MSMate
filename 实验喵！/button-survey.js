// 按钮/可交互元素普查（只读分析，不改任何文件）
const fs = require('fs')
const src = fs.readFileSync(__dirname + '/../src/js/app.js', 'utf8')
const lines = src.split('\n')

// 找出动态创建按钮的位置
const btnLines = []
lines.forEach((l, i) => {
  if (/createElement\('button'\)/.test(l)) btnLines.push(i)
})

console.log(`动态按钮总数: ${btnLines.length}`)
console.log('---')
for (const idx of btnLines) {
  // 向下找 6 行内的 textContent / innerHTML / title
  const ctx = lines.slice(idx, idx + 7).join(' ')
  const text = (ctx.match(/textContent\s*=\s*['"`]([^'"`]{1,24})/) || [])[1] || '?'
  const hasTitle = /\.title\s*=/.test(ctx)
  const inner = (ctx.match(/innerHTML\s*=\s*['"`]([^'"`]{1,30})/) || [])[1] || ''
  console.log(`L${idx + 1} ${hasTitle ? '[T]' : '[ ]'} 文字:${text} ${inner ? 'HTML:' + inner.slice(0, 20) : ''}`)
}

// 顶栏/图标类 innerHTML 注入 emoji 图标的
console.log('--- 图标符号注入（textContent = emoji/符号）---')
const iconLines = []
lines.forEach((l, i) => {
  if (/textContent\s*=\s*['"`][\u2190-\u2BFF\u{1F000}-\u{1FAFF}✕✓×⋯↻⇄⟳]/u.test(l)) iconLines.push([i + 1, (l.match(/textContent\s*=\s*['"`]([^'"`]{1,10})/) || [])[1]])
})
for (const [n, t] of iconLines.slice(0, 40)) console.log(`L${n} ${t}`)
