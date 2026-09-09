// 真机验证：从 app.asar.unpacked 语境下 require asar 内模块是否可行
const { createRequire } = require('module')
const PRELOAD_DIR = 'F:\\MS\\MSConnect\\MSWork\\MSMate\\resources\\app.asar.unpacked'
const ASAR_DIR = 'F:\\MS\\MSConnect\\MSWork\\MSMate\\resources\\app.asar'
const req = createRequire(PRELOAD_DIR + '\\preload.js')

const out = {}
try { const m = req('docx-preview'); out.bare = 'OK ' + typeof m.renderAsync } catch (e) { out.bare = 'FAIL ' + e.message.split('\n')[0] }
try { const m = req(ASAR_DIR + '\\node_modules\\docx-preview'); out.asarDir = 'OK ' + typeof m.renderAsync } catch (e) { out.asarDir = 'FAIL ' + e.message.split('\n')[0] }
try { const m = req(ASAR_DIR + '\\node_modules\\docx-preview\\dist\\docx-preview.js'); out.asarFile = 'OK ' + typeof m.renderAsync } catch (e) { out.asarFile = 'FAIL ' + e.message.split('\n')[0] }
console.log(JSON.stringify(out, null, 2))
