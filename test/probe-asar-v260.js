// 发布后闭环：抽查 v2.6.0 产物 asar 里的工具手册化改造（六册手册进包 + 接线 + 版本号）
const asar = require('@electron/asar')
const path = require('path')

const asarPath = path.join(__dirname, '..', 'release_build_v260', 'win-unpacked', 'resources', 'app.asar')
const promptJs = asar.extractFile(asarPath, path.join('ai', 'prompt.js')).toString('utf8')
const tools = asar.extractFile(asarPath, path.join('ai', 'tools.js')).toString('utf8')
const agentJs = asar.extractFile(asarPath, path.join('ai', 'agent.js')).toString('utf8')
const mainJs = asar.extractFile(asarPath, 'main.js').toString('utf8')
const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const MANUAL_NAMES = ['word文档.md', '论文排版.md', '表格.md', '图片视频.md', '网络下载.md', '跨设备协作.md']
const checks = [
  // ① 六册手册真在 asar 里且非空
  ...MANUAL_NAMES.map((n) => [`manuals/${n} 在包内非空`, (() => {
    try { return asar.extractFile(asarPath, path.join('ai', 'manuals', n)).length > 2000 } catch { return false }
  })()]),
  // ② 主规则瘦身 + 双轨渲染
  ['TOOL_DEFS manual 字段 29 处', (tools.match(/manual: '/g) || []).length === 29],
  ['brief 行尾带手册路径', tools.includes('→ 手册：ai_manuals/')],
  ['prompt 四管道落盘', ['function manualsSourceDir', 'function releaseManualsTo', 'function loadManualsMarkdown', 'function manualsIndexSection'].every((s) => promptJs.includes(s))],
  ['索引段插入系统提示词', promptJs.includes('manualsIndexSection(ctx.manualsDir)')],
  ['网页版拼接手册全文', promptJs.includes('loadManualsMarkdown()') && promptJs.includes('禁止对 ai_manuals/ 路径发起 read_file')],
  // ③ 接线
  ['agent 注入 manualsDir', agentJs.includes("manualsDir: this.workspaceDir ? path.join(this.workspaceDir, 'ai_manuals') : ''")],
  ['main 启动释放手册', mainJs.includes('releaseManualsTo(workspaceDir)')],
]
let bad = 0
checks.forEach(([k, hit]) => { if (!hit) bad++; console.log(`${hit ? 'PASS' : 'FAIL'} asar: ${k}`) })
const vOk = pkg.version === '2.6.0'
if (!vOk) bad++
console.log(`${vOk ? 'PASS' : 'FAIL'} asar package.json version = ${pkg.version}`)
process.exit(bad ? 1 : 0)
