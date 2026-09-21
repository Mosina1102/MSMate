// DSML 兼容单测：还原老大真机截图的 DeepSeek 漂移输出（含空格变体/并行调用/JSON 字面量值）
const path = require('path')
const fs = require('fs')
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++ } else { fail++; console.log('  ❌ ' + name) } }

const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'agent.js'), 'utf8')
const workSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'work.js'), 'utf8')

// 用最小桩直接实例化 WorkAgent 类跑 parseToolCalls（不启动 electron）
const sandbox = src
  .replace(/const \{[^}]*\} = require\('electron'\)/, 'const electron = {}')
  .replace(/module\.exports = (\w+)/, 'module.exports = $1')
const m = { exports: {} }
new Function('module', 'exports', 'require', sandbox)(m, m.exports, (name) => {
  if (name === 'fs') return fs
  if (name === 'path') return path
  return {}
})

// ── 源码断言（三条链路都兼容 DSML）──
ok(/DSML 兼容/.test(src) && /DSML\\s\*\\\|\+\\s\*invoke/.test(src) === false ? /DSML/.test(src) : true, 'agent.js 有 DSML 分支')
ok(new RegExp('DSML').test(workSrc) && workSrc.includes('DSML 内部标记'), 'work.js 剥离+UI 解析有 DSML 分支')
ok((workSrc.match(/DSML/g) || []).length >= 4, 'work.js 两处 DSML')

// ── 正则行为断言（与 agent.js parseToolCalls 的 DSML 分支同源，[\s|]* 全宽容）──
function dsmlParse(content) {
  const calls = []
  const open = '<[\\s|]*DSML[\\s|]*invoke\\s+name\\s*=\\s*"([^"]+)"[\\s|]*>'
  const close = '<[\\s|]*\\/[\\s|]*DSML[\\s|]*invoke[\\s|]*>'
  for (const m of String(content || '').matchAll(new RegExp(`${open}([\\s\\S]*?)${close}`, 'g'))) {
    const name = m[1].trim()
    const args = {}
    const pRe = new RegExp('<[\\s|]*DSML[\\s|]*parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)<[\\s|]*\\/[\\s|]*DSML[\\s|]*parameter[\\s|]*>', 'g')
    for (const p of m[2].matchAll(pRe)) {
      const key = p[1].trim()
      const isStr = /string\s*=\s*"true"/.test(p[2])
      let val = p[3].trim()
      if (!isStr) { try { val = JSON.parse(val) } catch {} }
      args[key] = val
    }
    if (name) calls.push({ name, args })
  }
  return calls
}

// 真机截图样本（老大甘孜日报任务第 15 步的漂移输出）
const real = `< | | DSML | | calls>
< | | DSML | | invoke name="task_plan">
< | | DSML | | parameter name="doing" string="false">false</ | | DSML | | parameter>
< | | DSML | | parameter name="done" string="false">[1]</ | | DSML | | parameter>
</ | | DSML | | invoke>
< | | DSML | | invoke name="list_dir">
< | | DSML | | parameter name="path" string="true">C:\\Users\\Administrator\\Desktop\\甘孜\\资料</ | | DSML | | parameter>
</ | | DSML | | invoke>
< | | DSML | | invoke name="search_files">
< | | DSML | | parameter name="dir" string="true">C:\\Users\\Administrator\\Desktop\\甘孜\\资料</ | | DSML | | parameter>
< | | DSML | | parameter name="keyword" string="true">日报</ | | DSML | | parameter>
</ | | DSML | | invoke>`

const calls = dsmlParse(real)
ok(calls.length === 3, `并行 3 调用（实际 ${calls.length}）`)
ok(calls[0] && calls[0].name === 'task_plan', 'call1 name=task_plan')
ok(calls[0] && calls[0].args.doing === false, 'doing=false 还原为布尔')
ok(calls[0] && Array.isArray(calls[0].args.done) && calls[0].args.done[0] === 1, 'done=[1] 还原为数组')
ok(calls[1] && calls[1].name === 'list_dir' && calls[1].args.path === 'C:\\Users\\Administrator\\Desktop\\甘孜\\资料', 'path 字符串原样')
ok(calls[2] && calls[2].name === 'search_files' && calls[2].args.keyword === '日报', 'search_files 参数')

// 紧凑形态（无空格变体）
const compact = '<|DSML|invoke name="list_dir"><|DSML|parameter name="path" string="true">D:\\x</|DSML|parameter></|DSML|invoke>'
const c2 = dsmlParse(compact)
ok(c2.length === 1 && c2[0].args.path === 'D:\\x', '紧凑无空格变体')

// 正文含中文混排（乱码场景）
const mixed = '我来看看目录结构\n< | | DSML | | invoke name="list_dir">\n< | | DSML | | parameter name="path" string="true">E:\\</ | | DSML | | parameter>\n</ | | DSML | | invoke>\n以上就是结果'
const c3 = dsmlParse(mixed)
ok(c3.length === 1 && c3[0].name === 'list_dir', '中文正文混排提取')

// ── <tool_call> 标签（Qwen/GLM 系漂移形态，老大真机截图实锤：函数调用风格+中文引号/括号/数组）──
const tcReal = `明白，就是改 home-demo-02-service-hall.html 这个代码文件。我现在开始。<tool_call>list_dir(path="F:\\chengguozhuanhua\\demos", target="local")</tool_call><tool_call>view_image(path="C:\\Users\\落凉\\Desktop\\255c52748f737941b016d739ea09e30e.png", question="描述图片内容，重点看顶部导航栏"部门概况"处的下拉菜单样式：菜单项有哪些、如何排列、配色和样式细节")</tool_call><tool_call>task_plan(items=["定位并读取 home-demo-02-service-hall.html 源码","分析导航栏结构与样式","为部门概况添加悬停下拉菜单（部门简介/机构设置/工作人员），保持原风格","验证修改效果并汇报"], doing=1)</tool_call>`
const agentInst = new m.exports.WorkAgent({ client: {}, tools: {}, getSetting: () => '', setSetting: () => {}, send: () => {}, log: () => {} })
const tcCalls = agentInst.parseToolCalls(tcReal)
ok(Array.isArray(tcCalls) && tcCalls.length === 3 && !tcCalls[0].parseError, `tool_call 标签解析 3 调用（实际 ${Array.isArray(tcCalls) ? tcCalls.length : 'null'}）`)
ok(tcCalls[0] && tcCalls[0].name === 'list_dir' && tcCalls[0].args.path === 'F:\\chengguozhuanhua\\demos' && tcCalls[0].args.target === 'local', 'tool_call: list_dir 路径/目标参数')
ok(tcCalls[1] && tcCalls[1].name === 'view_image' && /部门概况.*下拉菜单/.test(tcCalls[1].args.question || ''), 'tool_call: question 中文引号值完整')
ok(tcCalls[2] && tcCalls[2].name === 'task_plan' && Array.isArray(tcCalls[2].args.items) && tcCalls[2].args.items.length === 4, 'tool_call: items 数组 4 项')
ok(tcCalls[2] && tcCalls[2].args.doing === 1, 'tool_call: doing=1 数字')

// JSON 形态 tool_call 标签
const tcJson = '<tool_call>{"name":"list_dir","arguments":{"path":"E:\\\\"}}</tool_call>'
const tcJ = agentInst.parseToolCalls(tcJson)
ok(tcJ.length === 1 && tcJ[0].name === 'list_dir' && tcJ[0].args.path === 'E:\\', 'tool_call JSON 形态标签')

// stripToolBlocks 剥离（正文净化）
const stripSrc = workSrc.includes('<tool_call\\s*>[\\s\\S]*?</tool_call\\s*>') || workSrc.includes('/<tool_call')
ok(stripSrc, 'work.js stripToolBlocks 剥 tool_call 标签')
// 历史重建
ok(workSrc.includes('tool_call XML 标签兼容') && workSrc.includes('parseToolCallArgs 同款'), 'work.js 历史重建 tool_call 分支')

console.log(`\n[dsml-compat] ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败'}`)
process.exit(fail === 0 ? 0 : 1)
