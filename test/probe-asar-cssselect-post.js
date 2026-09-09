// 发布后闭环：抽查产物 asar 里的 css-select 版本与 CJS 入口（用法：node probe-asar-cssselect-post.js [产物目录名，默认 release_build_v270]）
const asar = require('@electron/asar')
const path = require('path')

const dir = process.argv[2] || 'release_build_v270'
const asarPath = path.join(__dirname, '..', dir, 'win-unpacked', 'resources', 'app.asar')
const cands = ['node_modules\\css-select\\package.json', 'node_modules\\linkedom\\node_modules\\css-select\\package.json']
let found = null
for (const c of cands) {
  try {
    const p = JSON.parse(asar.extractFile(asarPath, c).toString('utf8'))
    found = { path: c, ...p }
    break
  } catch {}
}
if (!found) { console.log('FAIL asar 里找不到 css-select'); process.exit(1) }
const cjsOk = (() => {
  try { asar.extractFile(asarPath, found.path.replace('package.json', 'lib\\index.js')); return true } catch { return false }
})()
const ok = found.version === '5.2.2' && found.main === 'lib/index.js' && !found.type && cjsOk
console.log(`${ok ? 'PASS' : 'FAIL'} asar css-select v${found.version} main=${found.main} type=${found.type || '-'} cjs入口=${cjsOk} 位置=${found.path}`)
process.exit(ok ? 0 : 1)
