// 超长 title 提示普查（只读）
const fs = require('fs')
for (const f of ['f:/局域网互传2.6/src/index.html', 'f:/局域网互传2.6/src/js/app.js']) {
  console.log('===== ' + f.split('/').pop() + ' =====')
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  lines.forEach((l, i) => {
    const m = l.match(/title="([^"]{45,})"/)
    if (m) console.log(`L${i + 1} (${m[1].length}字) ${m[1].slice(0, 70)}`)
  })
}
