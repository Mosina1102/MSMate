// toast/confirm 文案质量普查（只读）
const fs = require('fs')
const src = fs.readFileSync(__dirname + '/../src/js/app.js', 'utf8')
const lines = src.split('\n')

const out = []
lines.forEach((l, i) => {
  const m = l.match(/(?:showToast|toast|notify)\s*\(\s*['"`]([^'"`]+)['"`]/)
  if (m) {
    const t = m[1]
    const flags = []
    if (/[\u2190-\u2BFF\u{1F000}-\u{1FAFF}]/u.test(t)) flags.push('EMOJI')
    if (t.length > 30) flags.push('LONG')
    // 报错类是否含“原因+下一步”
    const isErr = /失败|错误|出错|无法|不能/.test(t)
    if (isErr && !/(请|检查|重试|重新|稍后|确认|先|换|到|试试)/.test(t)) flags.push('无下一步')
    out.push({ n: i + 1, t, flags, isErr })
  }
})
console.log(`toast/notify 共 ${out.length} 条`)
console.log('--- 有问题标记 ---')
for (const { n, t, flags } of out.filter(x => x.flags.length)) console.log(`L${n} [${flags.join(',')}] ${t}`)
console.log('--- 报错类全部 ---')
for (const { n, t } of out.filter(x => x.isErr)) console.log(`L${n} ${t}`)
