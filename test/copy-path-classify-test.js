// 用户实锤回归（2.8.4）：GLM-5.3-Flash copy_path(src=["a.html","b.html"]) 批量复制两页时，
// classify 预检 path.basename(数组) 抛裸英文 TypeError（The "path" argument must be of type string.
// Received an instance of Array）→ agent 预检循环无 try 包裹 → 整轮殉葬（0 步执行+卡片卡"执行中"）
// 本测试锁死：classify 对数组 src 不炸、语义不变形
const { createTools } = require('../ai/tools.js')
let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

async function main() {
  const tools = createTools({
    tcpAgent: {}, snapshots: {}, tmpDir: '.', workspaceDir: '.',
    getSetting: () => '', setSetting: () => {}, log: () => {}
  })

  // ① 数组 src 不抛异常（原 bug 现场：批量复制两个页面）
  let r1 = null, e1 = null
  try { r1 = await tools.classify('copy_path', { src: ['C:\\a\\index.html', 'C:\\a\\about.html'], dest_dir: 'C:\\a', target: 'local' }) } catch (e) { e1 = e }
  ok('classify copy_path 数组 src 不抛异常', !e1, e1 && e1.message)
  ok('classify 返回结构完整（destructive 布尔）', r1 && typeof r1.destructive === 'boolean', JSON.stringify(r1))
  ok('classify 不误报破坏性（目标不存在）', r1 && r1.destructive === false, JSON.stringify(r1))

  // ② 单字符串 src 语义不变
  const r2 = await tools.classify('copy_path', { src: 'C:\\nonexist-a1\\x.html', dest_dir: 'C:\\nonexist-b2', target: 'local' })
  ok('classify copy_path 字符串 src 语义不变', r2 && r2.destructive === false && r2.note === '复制操作', JSON.stringify(r2))

  // ③ 缺 src / 缺 dest_dir 都不炸
  const r3 = await tools.classify('copy_path', { dest_dir: 'C:\\x', target: 'local' })
  ok('classify copy_path 缺 src 不炸', r3 && typeof r3.destructive === 'boolean', JSON.stringify(r3))
  const r4 = await tools.classify('copy_path', { src: 'C:\\x\\a.html', target: 'local' })
  ok('classify copy_path 缺 dest_dir 不炸', r4 && typeof r4.destructive === 'boolean', JSON.stringify(r4))

  // ④ agent.js 预检兜底断言（源码级：classify 抛异常不再殉葬整轮）
  const agentSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'ai', 'agent.js'), 'utf8')
  ok('agent.js classify 预检有 try/catch 兜底（降级强制审批）', agentSrc.includes('风险预检异常已降级') && agentSrc.includes('forceApproval: mode !== \'unlimited\''))

  console.log(`\n[classify-copy-path] ${pass}/${pass + fail} ${fail === 0 ? '✓ 全过' : '✗ 有失败'}`)
  process.exit(fail ? 1 : 0)
}
main()
