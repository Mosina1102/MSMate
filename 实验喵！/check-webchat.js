// webchat.js emoji 检查（只读）
const fs = require('fs')
const lines = fs.readFileSync('f:/局域网互传2.6/src/js/webchat.js', 'utf8').split('\n')
lines.forEach((l, i) => {
  const code = l.replace(/\/\/.*$/, '')
  const m = code.match(/[\u{1F000}-\u{1FAFF}\u{2300}-\u{27BF}]/gu)
  if (m) console.log(`L${i + 1} [${[...new Set(m)].join(' ')}] ${code.trim().slice(0, 80)}`)
})
console.log('done')
