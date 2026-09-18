// 工具输出溢出治理 冒烟测试（借鉴 mksglu/context-mode：原始大输出不进上下文，归档+预览+read_file 回读）
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-overflow-'))
  const tools = createTools({
    tcpAgent: {
      getConnectedDevices: () => [],
      uploadFile: async () => ({ success: true }),
      downloadFile: async () => ({ success: true })
    },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试' }) },
    desktopDir: base,
    tmpDir: base,
    workspaceDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })
  const guard = tools.guardToolOutput

  // ---- 1) guardToolOutput 单元边界 ----
  ok('短输出原样返回', guard('list_dir', { ok: true, message: 'abc' }).message === 'abc')
  ok('恰好阈值不治理', guard('list_dir', { ok: true, message: 'a'.repeat(10240) }).message.length === 10240)
  const big = { ok: true, message: 'A'.repeat(3000) + 'MARK_MIDDLE' + 'B'.repeat(8000) }
  const g1 = guard('web_fetch', big)
  ok('超阈值触发归档', /【输出过大已归档】/.test(g1.message), g1.message.slice(0, 60))
  ok('治理后长度受控', g1.message.length < 10240, 'len=' + g1.message.length)
  ok('保留 ok 等原字段', g1.ok === true && Object.keys(g1).length >= 2)
  ok('豁免工具不治理', !/已归档/.test(guard('read_file', { ok: true, message: 'x'.repeat(20000) }).message))
  ok('无落盘位置退化原样', (() => {
    const t2 = createTools({ tcpAgent: {}, snapshots: {}, desktopDir: '', tmpDir: '', workspaceDir: '', getSetting: () => null, setSetting: () => {}, log: () => {} })
    const msg = 'y'.repeat(20000)
    return t2.guardToolOutput('web_fetch', { ok: true, message: msg }).message === msg
  })())

  // ---- 2) 集成：大目录 list_dir 触发归档 ----
  const bigDir = path.join(base, 'bigdir')
  fs.mkdirSync(bigDir)
  // 200 项上限 × 每行 ~70 字符（62 字符文件名 + 大小），稳定超过 10240
  const midName = 'f0100-' + 'x'.repeat(54) + '.txt' // 中段特征串：只出现在归档全文，预览不含
  for (let i = 0; i < 260; i++) {
    fs.writeFileSync(path.join(bigDir, 'f' + String(i).padStart(4, '0') + '-' + 'x'.repeat(54) + '.txt'), 'z')
  }
  const r1 = await tools.execute('list_dir', { path: bigDir })
  ok('大目录触发归档', r1.ok && /【输出过大已归档】/.test(r1.message), r1.message.slice(0, 80))
  const m = r1.message.match(/完整内容已存：(\S+\.md)/)
  ok('归档路径可提取', !!m, r1.message.slice(0, 120))
  if (m) {
    const arch = m[1]
    ok('归档文件存在', fs.existsSync(arch), arch)
    const archText = fs.readFileSync(arch, 'utf8')
    ok('归档全文含中段内容', archText.includes(midName))
    ok('归档头部含工具名', /# 工具输出归档：list_dir/.test(archText))
    ok('预览省略中段', !r1.message.includes(midName))
    ok('末尾预览在', /---- 末尾预览 ----/.test(r1.message))
    // 闭环：模型用 read_file 读归档文件能拿到中段全文
    const rr = await tools.execute('read_file', { path: arch })
    ok('read_file 回读归档', rr.ok && rr.message.includes(midName))
  }

  // ---- 3) 小目录不治理 ----
  const smallDir = path.join(base, 'smalldir')
  fs.mkdirSync(smallDir)
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(smallDir, 's' + i + '.txt'), 'hi')
  const r2 = await tools.execute('list_dir', { path: smallDir })
  ok('小目录不触发归档', r2.ok && !/已归档/.test(r2.message), r2.message.slice(0, 60))

  // ---- 4) read_file 豁免：150KB 大文件走分段协议而非归档 ----
  const bigFile = path.join(base, 'big.txt')
  fs.writeFileSync(bigFile, ('A'.repeat(99) + '\n').repeat(1536)) // ~150KB
  const r3 = await tools.execute('read_file', { path: bigFile })
  ok('read_file 仍走分段协议', r3.ok && /大文件共/.test(r3.message) && !/已归档/.test(r3.message), r3.message.slice(0, 80))

  // ---- 5) 执行异常（超长错误信息）同样被治理 ----
  const r4 = await tools.execute('nonexist_tool_' + 'z'.repeat(30000), {})
  ok('未知工具短消息不受影响', !r4.ok && !/已归档/.test(r4.message))
  // 造一个执行异常且 message 超长：list_dir 传超长路径 → 报错含路径（Windows 路径上限 260，改用远程错误更可控）
  // 简化：直接验证 guard 包住 catch 分支——调用一个会抛超长错误的场景太绕，用单元断言兜底：
  ok('catch 分支同被治理（单元）', /已归档/.test(guard('some_tool', { ok: false, message: 'E'.repeat(20000) }).message))

  console.log(`\n结果: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1) })
