const fs = require('fs')
const h = fs.readFileSync('f:/局域网互传2.0/test/real-out.html', 'utf8')
// 所有 class 属性值
const cls = [...new Set((h.match(/class="([^"]+)"/g) || []).map((s) => s.slice(7, -1)))]
console.log('class 值清单:', cls.join(' | '))
// img 标签逐个看（含换行）
const imgTags = h.match(/<img[^>]*>/g) || []
console.log('img 标签数:', imgTags.length)
console.log('--- 第1个 img 完整标签 ---')
console.log((imgTags[0] || '').slice(0, 400))
console.log('src= 出现次数:', (h.match(/ src=/g) || []).length)
// 有 class 的 p 长啥样
const pWithClass = h.match(/<p class="[^"]*"[^>]*>/g) || []
console.log('--- 前5个带 class 的 p ---')
pWithClass.slice(0, 5).forEach((t, i) => console.log(i, t.slice(0, 160)))
