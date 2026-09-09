// transfer_file 同设备降级（本机→本机）冒烟测试：不需要真实远程设备
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools')

async function main() {
  // 注意：C 盘（除桌面）是保护区，测试目录必须放 D 盘
  const base = fs.mkdtempSync(path.join('D:\\', 'xfer-test-'))
  const srcDir = path.join(base, 'src')
  const dstDir = path.join(base, 'dst')
  fs.mkdirSync(srcDir)
  fs.mkdirSync(dstDir)
  fs.writeFileSync(path.join(srcDir, '表格.xlsx'), 'fake-xlsx-content')

  let log = []
  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试不覆盖' }) },
    desktopDir: path.join(base, 'desktop'),
    tmpDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: (m) => log.push(m)
  })

  // 1) 同设备（src/dest 都是 local）→ 降级本地复制
  const r1 = await tools.execute('transfer_file', { src_path: path.join(srcDir, '表格.xlsx'), dest_dir: dstDir })
  const ok1 = r1.ok && fs.existsSync(path.join(dstDir, '表格.xlsx'))
  console.log(ok1 ? '✅ 同设备降级复制' : '❌ 同设备降级失败: ' + r1.message)

  // 2) 缺参数
  const r2 = await tools.execute('transfer_file', { src_path: path.join(srcDir, '表格.xlsx') })
  const ok2 = !r2.ok && /dest_dir/.test(r2.message)
  console.log(ok2 ? '✅ 缺参数拒绝' : '❌ 缺参数未拒绝: ' + r2.message)

  // 3) 未知设备拒绝
  const r3 = await tools.execute('transfer_file', { src_path: path.join(srcDir, '表格.xlsx'), src_target: '不存在的设备', dest_dir: dstDir })
  const ok3 = !r3.ok && /源设备不存在/.test(r3.message)
  console.log(ok3 ? '✅ 未知源设备拒绝' : '❌ 未知设备未拒绝: ' + r3.message)

  // 4) 工具清单包含 transfer_file 且摘要正常
  const inDefs = tools.defs.some((d) => d.name === 'transfer_file')
  const sum = tools.summarize('transfer_file', { src_path: 'C:\\a.xlsx', src_target: 'dev-1', dest_dir: 'D:\\b' })
  const ok4 = inDefs && /跨设备复制/.test(sum)
  console.log(ok4 ? '✅ 工具清单+摘要' : '❌ 工具清单或摘要异常')

  // 5) 远程目标 + 相对 dest_dir（"桌面"显示名）→ 必须拒绝并引导用完整路径
  //    真机实锤：网页模型照抄 list_dir 显示名"桌面"传 dest_dir，对方写盘相对路径 ENOENT 闪退
  let uploadCalled = false
  const toolsRemote = createTools({
    tcpAgent: {
      getConnectedDevices: () => [{ deviceId: 'dev-9', name: '顾夕测试机', hostname: 'guxi-pc' }],
      uploadFile: async () => { uploadCalled = true; return { success: true } }
    },
    snapshots: { backupLocal: () => ({ ok: false }) },
    desktopDir: path.join(base, 'desktop'),
    tmpDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })
  const r5 = await toolsRemote.execute('transfer_file', { src_path: path.join(srcDir, '表格.xlsx'), dest_target: '顾夕测试机', dest_dir: '桌面' })
  const ok5 = !r5.ok && /完整路径/.test(r5.message) && !uploadCalled
  console.log(ok5 ? '✅ 相对 dest_dir（"桌面"别名）拒绝且未发起传输' : '❌ 相对 dest_dir 未拦截: ' + r5.message)

  // 6) 远程目标 + 绝对 dest_dir → 通过校验并调用 uploadFile
  const r6 = await toolsRemote.execute('transfer_file', { src_path: path.join(srcDir, '表格.xlsx'), dest_target: 'dev-9', dest_dir: 'C:\\Users\\guxi\\Desktop' })
  const ok6 = r6.ok && uploadCalled
  console.log(ok6 ? '✅ 绝对 dest_dir 正常发起上传' : '❌ 绝对 dest_dir 未通过: ' + r6.message)

  // 7) dest_dir 带反引号/引号污染 → 自动清洗后通过（网页模型常把 URL/路径写成行内代码）
  uploadCalled = false
  const r7 = await toolsRemote.execute('transfer_file', { src_path: path.join(srcDir, '表格.xlsx'), dest_target: 'dev-9', dest_dir: '`C:\\Users\\guxi\\Desktop`' })
  const ok7 = r7.ok && uploadCalled
  console.log(ok7 ? '✅ dest_dir 反引号污染自动清洗' : '❌ 反引号清洗失败: ' + r7.message)

  // 8) formatEntries：root 快捷入口带完整路径展示（信息源头防呆）
  const toolsLocal = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false }) },
    desktopDir: path.join(base, 'desktop'),
    tmpDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })
  const r8 = await toolsLocal.execute('list_dir', { path: 'root' })
  const ok8 = r8.ok && /完整路径:/.test(r8.message)
  console.log(ok8 ? '✅ root 列表显示桌面完整路径' : '❌ root 列表未显示完整路径')

  fs.rmSync(base, { recursive: true, force: true })
  const all = ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8
  console.log(all ? '\n✅ transfer_file 冒烟测试全部通过' : '\n❌ 存在失败项')
  process.exitCode = all ? 0 : 1
}
main().catch((e) => { console.error('测试异常:', e); process.exitCode = 1 })
