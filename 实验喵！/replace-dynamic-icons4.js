// app.js emoji 替换 patch 4（收尾）
const fs = require('fs')
const p = 'f:/局域网互传2.6/src/js/app.js'
let s = fs.readFileSync(p, 'utf8')
let ok = 0, fail = []
const pairs = [
  // 保存未保存状态判断（●→dataset）
  ["if (save.textContent.includes('●') && !confirm('编辑器里有未保存的修改", "if (save.dataset.savedIcon && !confirm('编辑器里有未保存的修改"],
  // 图片编辑器画笔按钮
  ["data-tool=\"brush\" title=\"画笔（涂抹要修改的区域）\">✏ 画笔</button>", "data-tool=\"brush\" title=\"画笔（涂抹要修改的区域）\">${iconSvg('paintbrush')} 画笔</button>"],
  // 传输取消按钮
  ["title=\"取消\">✕</button>` : ''}", "title=\"取消\">${iconSvg('x')}</button>` : ''}"],
  // option 文本残留
  ["条，选中可编辑；空表单填好后点 💾 新增）</option>", "条，选中可编辑；空表单填好后点「新增」）</option>"],
  ["我的常用识图模型${visionList.length ? '' : '（空：输入后点 ➕）'}</option>", "我的常用识图模型${visionList.length ? '' : '（空：输入后点「添加」）'}</option>"],
  // 模型清单 ✕ 删除按钮（4 空格缩进两处）
  ["del.textContent = '✕'", "del.innerHTML = iconSvg('x')"],
  // 引用缩略图标函数（zip/默认）
  ["if (/\\.(zip|rar|7z|gz)$/i.test(name)) return '🗜️'", "if (/\\.(zip|rar|7z|gz)$/i.test(name)) return iconSvg('archive')"],
  ["if (/\\.(docx?|xlsx?|pptx?|pdf|txt|md)$/i.test(name)) return iconSvg('file-text')\n  return iconSvg('file-text')", "if (/\\.(docx?|xlsx?|pptx?|pdf|txt|md)$/i.test(name)) return iconSvg('file-text')\n  return iconSvg('file-text')"],
  // 过程折叠头部
  ["<span class=\"label\">⚙️ 已执行 ${calls.length} 步操作（点击展开）</span>", "<span class=\"label\">已执行 ${calls.length} 步操作（点击展开）</span>"],
  // 思考块初始 HTML
  ["<span class=\"chat-thinking-chevron\">▼</span><span class=\"label\">💭 思考中…</span>", "<span class=\"chat-thinking-chevron\">${iconSvg('chevron-down')}</span><span class=\"label\">思考中…</span>"],
  // 引用缩略 iconMap
  ["const iconMap = { docx: '📘', doc: '📘', xlsx: '📊', xls: '📊', csv: '📊', txt: '📃', pdf: '📕', png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', zip: '🗜️', rar: '🗜️', mp3: '🎵', mp4: '🎬' }",
   "const iconMap = { docx: 'file-text', doc: 'file-text', xlsx: 'table', xls: 'table', csv: 'table', txt: 'file-text', pdf: 'file-text', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', zip: 'archive', rar: 'archive', mp3: 'music', mp4: 'video' }"],
  ["const icon = iconMap[ext] || '📄'\n", "const icon = iconSvg(iconMap[ext] || 'file-text')\n"],
]

for (const [oldS, newS] of pairs) {
  if (oldS === newS) continue
  if (s.includes(oldS)) { s = s.split(oldS).join(newS); ok++ } else { fail.push(oldS.slice(0, 66)) }
}
fs.writeFileSync(p, s)
console.log(`替换 ${ok}/${pairs.length} 对`)
if (fail.length) { console.log('未命中：'); fail.forEach(f => console.log('  ' + f)) }

// 终查（排除注释与保留符号）
const lines = s.split('\n')
let rest = 0
lines.forEach((l, i) => {
  const code = l.replace(/\/\/.*$/, '')
  const m = code.match(/[\u{1F000}-\u{1FAFF}\u{2300}-\u{27BF}]/gu)
  if (m) { rest++; console.log(`L${i + 1} [${[...new Set(m)].join(' ')}] ${code.trim().slice(0, 78)}`) }
})
console.log(`剩余行数: ${rest}`)
