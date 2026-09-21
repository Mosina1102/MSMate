// 开发三件套探针：真跑 run_command / edit_file / search_file_content（临时目录，无系统副作用）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createTools } = require('../ai/tools')

;(async () => {
  let pass = 0, fail = 0
  const ok = (cond, name) => { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }
  const mockSnap = { backupLocal: () => ({ ok: true, id: 'snap_mock' }), register: () => {}, snapshotDir: () => os.tmpdir(), list: () => [], restore: () => ({ success: false }) }
  const tools = createTools({ tcpAgent: {}, snapshots: mockSnap, desktopDir: os.tmpdir(), tmpDir: os.tmpdir(), workspaceDir: os.tmpdir(), getSetting: () => '', setSetting: () => {}, log: () => {} })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msdev-'))

  // ===== run_command =====
  const r1 = await tools.execute('run_command', { command: 'echo hello-dev', cwd: dir })
  ok(r1.ok && r1.message.includes('hello-dev'), `run_command 基础执行（${String(r1.message).split('\n')[0]}）`)
  const r2 = await tools.execute('run_command', { command: 'format' })
  ok(!r2.ok && /黑名单/.test(r2.message), 'run_command 危险黑名单硬拦')
  const r3 = await tools.execute('run_command', { command: 'exit /b 42' })
  ok(!r3.ok && /42/.test(r3.message), `run_command 退出码回传（${String(r3.message).split('\n')[0]}）`)
  const r4 = await tools.execute('run_command', { command: 'echo 中文输出测试' })
  ok(r4.ok && r4.message.includes('中文输出测试'), 'run_command 中文不乱码（chcp 65001）')
  const r5 = await tools.execute('run_command', { command: 'del /f x' })
  ok(!r5.ok && /黑名单/.test(r5.message), 'run_command del /f 拦截')

  // ===== edit_file =====
  const f = path.join(dir, 'app.js')
  fs.writeFileSync(f, 'const port = 8080\nfunction greet() { return "hi" }\nconst host = "local"\n', 'utf8')
  const e1 = await tools.execute('edit_file', { path: f, old_string: 'const port = 8080', new_string: 'const port = 3000' })
  ok(e1.ok && fs.readFileSync(f, 'utf8').includes('const port = 3000'), 'edit_file 单处精准替换')
  const e2 = await tools.execute('edit_file', { path: f, old_string: 'const', new_string: 'let' })
  ok(!e2.ok && /命中 2 处/.test(e2.message), `edit_file 多处命中拒绝（${String(e2.message).split('\n')[0]}）`)
  const e3 = await tools.execute('edit_file', { path: f, old_string: 'const', new_string: 'let', replaceAll: true })
  ok(e3.ok && (fs.readFileSync(f, 'utf8').match(/^let /gm) || []).length === 2, 'edit_file replaceAll 全替换')
  const e4 = await tools.execute('edit_file', { path: f, old_string: '不存在的原文xyz' })
  ok(!e4.ok && /找不到/.test(e4.message), 'edit_file 找不到原文报因')
  const e5 = await tools.execute('edit_file', { path: path.join(dir, 'nope.js'), old_string: 'a', new_string: 'b' })
  ok(!e5.ok && /不存在/.test(e5.message), 'edit_file 文件不存在报因')

  // ===== search_file_content =====
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'x.js'), 'const handleLogin = 1\n', 'utf8') // 应被跳过
  fs.writeFileSync(path.join(dir, 'src.js'), 'function handleLogin() {}\nfunction other() {}\n', 'utf8')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sub', 'y.md'), '登录逻辑见 handleLogin\n', 'utf8')
  const s1 = await tools.execute('search_file_content', { dir, query: 'handleLogin' })
  ok(s1.ok && s1.message.includes('src.js') && s1.message.includes('y.md'), 'search 递归命中多文件')
  ok(!s1.message.includes('node_modules'), 'search 跳过 node_modules')
  const s2 = await tools.execute('search_file_content', { dir, query: 'handleLogin|other', regex: true })
  ok(s2.ok && s2.message.includes('other'), 'search 正则模式')
  const s3 = await tools.execute('search_file_content', { dir, query: 'zzz_no_hit' })
  ok(s3.ok && /未命中/.test(s3.message), 'search 未命中友好返回')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`[dev-tools] ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('[dev-tools] 探针炸了:', e.message); process.exit(1) })
