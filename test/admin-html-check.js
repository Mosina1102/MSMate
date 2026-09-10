// 批款后台内嵌 JS 语法防回归：从 server.js 的 ADMIN_HTML 提取 <script> 内容，node --check 验证
// 背景：反引号模板字符串里写转义曾致浏览器侧 script 整页挂掉（"点登录没反应"事故×2）
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const src = fs.readFileSync(path.join(__dirname, '..', 'api-server', 'server.js'), 'utf8')
const start = src.indexOf('const ADMIN_HTML = `')
const end = src.indexOf('`', start + 'const ADMIN_HTML = `'.length + 1)
if (start < 0 || end < 0) { console.error('未找到 ADMIN_HTML 模板'); process.exit(1) }
const html = src.slice(start + 'const ADMIN_HTML = `'.length, end)
const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) { console.error('ADMIN_HTML 中未找到 <script> 块'); process.exit(1) }
// 模板字符串里 \` 和 \$ 的转义在输出 HTML 时会被反转义，这里同步反转义后再检查
const js = m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$')
const tmp = path.join(require('os').tmpdir(), 'admin-html-script-check.js')
fs.writeFileSync(tmp, js)
const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' })
if (r.status !== 0) {
  console.error('✗ 内嵌 JS 语法错误：')
  console.error(r.stderr || r.stdout)
  process.exit(1)
}
// 附加断言：提醒系统三件套必须在场（防误删）
const need = ['function beep()', 'function poll()', 'setInterval(poll, 15000)', 'keepAlive()', 'sndbtn']
const missing = need.filter(k => js.indexOf(k) < 0)
if (missing.length) { console.error('✗ 提醒系统代码缺失：' + missing.join(', ')); process.exit(1) }
// 禁用项：模板内不得出现内联 onclick 带引号嵌套、反引号、${（会炸外层模板）
if (/\$\{/.test(html)) { console.error('✗ ADMIN_HTML 内出现 ${，会破坏外层模板字符串'); process.exit(1) }
console.log('✓ ADMIN_HTML 内嵌 JS 语法检查通过（' + js.split('\n').length + ' 行）+ 提醒系统断言 5 项 + 模板安全检查通过')
