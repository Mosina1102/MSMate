// 检查 docx-preview 0.4.0 的选项支持 + 生成的 CSS
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'docx-preview', 'dist', 'docx-preview.js'), 'utf8')
for (const key of ['useBase64URL', 'createObjectURL', 'renderHeaders', 'ignoreLastRenderedPageBreak', 'experimental', 'docx_heading', 'breakPages']) {
  const re = new RegExp(key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g')
  const n = (src.match(re) || []).length
  console.log(`${key}: ${n} 处`)
}
