// 生成 src/js/icons.js（从 node_modules/lucide-static 拷贝所需 SVG）
// 重跑：node 实验喵！/gen-icons.js
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const srcDir = path.join(root, 'node_modules/lucide-static/icons')
const outPath = path.join(root, 'src/js/icons.js')

// 用到的 Lucide 图标清单
const NAMES = [
  'settings', 'sliders-horizontal', 'sparkles', 'mic', 'radio-tower', 'globe',
  'book-open', 'link', 'folder-open', 'send', 'clipboard', 'trash-2',
  'laptop', 'keyboard', 'bell', 'file-pen', 'pin', 'plus', 'save', 'upload',
  'download', 'file-plus', 'folder-plus', 'x', 'play', 'loader-circle', 'clock',
  'undo-2', 'brain', 'list-checks', 'external-link', 'folder', 'check', 'file',
  'hard-drive', 'monitor', 'search', 'eraser', 'paintbrush', 'music',
  'chevron-down', 'triangle-alert', 'eye', 'message-square', 'arrow-left',
  'volume-2', 'image', 'video', 'file-text', 'arrow-up-left', 'square-pen',
  'circle-help', 'archive', 'table', 'presentation', 'scissors', 'folder-input',
  'inbox', 'arrow-right-left', 'rocket', 'tag', 'text-quote',
  'file-code', 'app-window', 'package', 'pin-off', 'wrench', 'puzzle', 'circle', 'rotate-cw',
  'user', 'circle-user-round', 'mail', 'lock', 'log-in', 'log-out',
]

const items = []
const missing = []
for (const name of NAMES) {
  const p = path.join(srcDir, name + '.svg')
  if (!fs.existsSync(p)) { missing.push(name); continue }
  let svg = fs.readFileSync(p, 'utf8').trim()
  // 去掉 width/height（尺寸交给 CSS），压成单行
  svg = svg.replace(/\s*width="\d+"\s+height="\d+"/, '').replace(/\s+/g, ' ').replace(/> </g, '><')
  items.push(`  ${JSON.stringify(name)}: ${JSON.stringify(svg)}`)
}
if (missing.length) {
  console.error('缺失图标：' + missing.join(', '))
  process.exit(1)
}

const out = `// Lucide 图标库（ISC License）— 由 实验喵！/gen-icons.js 生成，勿手改
// 用法：
//   1. HTML 静态位：<span data-icon="globe"></span>，启动后 renderIcons(document) 渲染
//   2. JS 动态位：iconSvg('globe') 返回 SVG 字符串，直接拼 innerHTML
window.ICONS = {
${items.join(',\n')}
}

// 渲染单个图标（默认 1em 跟随字号，描边 currentColor 跟随文字颜色）
window.iconSvg = function (name) {
  const svg = window.ICONS[name]
  return svg ? svg.replace('<svg', '<svg class="ic-svg" aria-hidden="true"') : ''
}

// 扫描容器内所有 [data-icon] 占位并渲染（重复调用安全）
window.renderIcons = function (root) {
  const scope = root && root.querySelectorAll ? root : document
  scope.querySelectorAll('[data-icon]').forEach((el) => {
    const name = el.getAttribute('data-icon')
    if (name && window.ICONS[name]) el.innerHTML = window.ICONS[name].replace('<svg', '<svg class="ic-svg" aria-hidden="true"')
  })
}
`

fs.writeFileSync(outPath, out)
console.log(`生成 ${outPath}：${items.length} 个图标，${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`)
