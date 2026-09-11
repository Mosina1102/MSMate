// 提取 ADMIN_HTML 内嵌 <script> 做语法检查（一次性）
const fs = require('fs')
const src = fs.readFileSync('api-server/server.js', 'utf8')
const start = src.indexOf('const ADMIN_HTML = `')
const endMark = '</body></html>`'
const end = src.indexOf(endMark, start)
if (start < 0 || end < 0) { console.log('EXTRACT FAIL'); process.exit(1) }
const block = src.slice(start, end)
const jsStart = block.indexOf('<script>')
const js = block.slice(jsStart + 8, block.lastIndexOf('</script>'))
// 模板字符串风险点检查
console.log('script len:', js.length)
console.log('反引号:', js.includes('`'), '| ${:', js.includes('${'), '| </script>:', js.toLowerCase().includes('</script>'), "| \\':", js.includes("\\'"))
fs.writeFileSync(process.env.TEMP + '/admin-check.js', js)
console.log('written to %TEMP%/admin-check.js')
