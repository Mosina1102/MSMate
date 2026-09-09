// 防自包含 + 批量移动/复制冒烟测试（D 盘）
const path = require('path')
const fs = require('fs')
const { createTools } = require('../ai/tools')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // 测试根目录：默认 D 盘（避开 C 盘保护区），可用 MSWORK_TEST_DIR 覆盖
  const testRoot = process.env.MSWORK_TEST_DIR || 'D:\\mswork_test'
  fs.mkdirSync(testRoot, { recursive: true })
  const base = fs.mkdtempSync(path.join(testRoot, 'selfcontain-test-'))
  const workDir = path.join(base, '工作文件夹')
  fs.mkdirSync(path.join(workDir, '子'), { recursive: true })
  fs.writeFileSync(path.join(workDir, 'a.txt'), 'A')
  fs.writeFileSync(path.join(workDir, '子', 'b.txt'), 'B')

  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试' }) },
    desktopDir: path.join(base, '桌面'),
    tmpDir: base,
    workspaceDir: path.join(base, 'ws'),
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })

  // 1) 复制到自身内部 → 拒绝（不会卡死）
  const r1 = await tools.execute('copy_path', { src: workDir, dest_dir: workDir })
  ok('复制到自身内部被拒', !r1.ok && /内部|同一位置/.test(r1.message), r1.message)

  // 2) 移动到自身内部 → 拒绝
  const r2 = await tools.execute('move_path', { src: workDir, dest_dir: workDir })
  ok('移动到自身内部被拒', !r2.ok && /内部|同一位置/.test(r2.message), r2.message)

  // 3) 批量移动（src 数组）：两个文件一次调用
  const destDir = path.join(base, '归类')
  fs.mkdirSync(destDir, { recursive: true })
  fs.writeFileSync(path.join(base, 'x1.txt'), '1')
  fs.writeFileSync(path.join(base, 'x2.txt'), '2')
  const r3 = await tools.execute('move_path', { src: [path.join(base, 'x1.txt'), path.join(base, 'x2.txt')], dest_dir: destDir })
  ok('批量移动 2 项', r3.ok && /2\/2/.test(r3.message) && fs.existsSync(path.join(destDir, 'x1.txt')) && fs.existsSync(path.join(destDir, 'x2.txt')), r3.message)

  // 4) 批量复制（src 数组）
  const copyDir = path.join(base, '副本')
  const r4 = await tools.execute('copy_path', { src: [path.join(destDir, 'x1.txt'), workDir], dest_dir: copyDir })
  ok('批量复制（文件+文件夹）', r4.ok && /2\/2/.test(r4.message) && fs.existsSync(path.join(copyDir, '工作文件夹', '子', 'b.txt')), r4.message)

  // 5) 混合成功/失败（一个不存在的源）
  const r5 = await tools.execute('move_path', { src: [path.join(destDir, 'x1.txt'), path.join(base, '不存在.txt')], dest_dir: copyDir })
  ok('批量部分失败不整体失败', r5.ok && /1\/2/.test(r5.message) && /失败.*不存在|失败/.test(r5.message), r5.message)

  // 6) 文件数量上限保护（构造 >20000 文件太慢，跳过实测，仅验证 copyRecursive 正常路径已覆盖）

  fs.rmSync(base, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'} (${pass}/${pass + fail})`)
  process.exitCode = fail === 0 ? 0 : 1
}
main().catch((e) => { console.error('测试异常:', e); process.exitCode = 1 })
