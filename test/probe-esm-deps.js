// 排查 linkedom 依赖树里的 ESM-only 雷（Electron 22 / Node 16 不支持 require(ESM)）
const fs = require('fs')
const path = require('path')

const pkgs = ['css-select', 'htmlparser2', 'cssom', 'html-escaper', 'uhyphen']
for (const name of pkgs) {
  const pkgPath = path.join(__dirname, '..', 'node_modules', name, 'package.json')
  if (!fs.existsSync(pkgPath)) { console.log(`${name}: 不存在`); continue }
  const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const exp = p.exports
  let requireable = false
  if (exp) {
    const dot = typeof exp === 'string' ? { '.': exp } : exp['.'] || {}
    const req = typeof dot === 'string' ? dot : (dot.require || dot.default)
    // require 条件指向的文件存在且不是 .mjs → CJS-compatible
    if (typeof req === 'string' && !/\.mjs$/.test(req) && fs.existsSync(path.join(__dirname, '..', 'node_modules', name, req))) requireable = true
  } else if (p.main) {
    requireable = !/\.mjs$/.test(p.main) && fs.existsSync(path.join(__dirname, '..', 'node_modules', name, p.main)) && !p.type
  }
  console.log(`${name}: v${p.version} type=${p.type || 'commonjs(默认)'} require兼容=${requireable ? 'YES' : 'NO(ESM-only 雷!)'} exports=${JSON.stringify(exp || p.main)}`)
}
