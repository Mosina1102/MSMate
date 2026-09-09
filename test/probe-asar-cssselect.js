// 解剖打包 asar 里的 css-select/linkedom，对比开发目录找 ESM 污染来源
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v256', 'win-unpacked', 'resources', 'app.asar')

function readJson(innerPath) {
  try {
    const buf = asar.extractFile(asarPath, innerPath.replace(/\//g, '\\'))
    return JSON.parse(buf.toString('utf8'))
  } catch (e) { return { _err: e.message } }
}

const cssSel = readJson('node_modules/css-select/package.json')
console.log('asar css-select:', cssSel._err ? ('ERR ' + cssSel._err) : `v${cssSel.version} main=${cssSel.main} type=${cssSel.type} exports=${JSON.stringify(cssSel.exports)}`)

const linkedom = readJson('node_modules/linkedom/package.json')
console.log('asar linkedom:', linkedom._err ? ('ERR ' + linkedom._err) : `v${linkedom.version} deps=${JSON.stringify(linkedom.dependencies)}`)

// matches.js 的 require 方式
try {
  const m = asar.extractFile(asarPath, 'node_modules\\linkedom\\cjs\\shared\\matches.js').toString('utf8')
  const req = m.match(/require\([^)]*\)/g) || []
  console.log('asar matches.js requires:', req.slice(0, 5))
} catch (e) { console.log('matches.js 读取失败:', e.message) }

// asar 里 css-select/dist 文件清单
try {
  const list = asar.listPackage(asarPath).filter((f) => /css-select/.test(f))
  console.log('asar css-select 文件数:', list.length)
  list.slice(0, 12).forEach((f) => console.log('  ', f))
} catch (e) { console.log('listPackage 失败:', e.message) }
