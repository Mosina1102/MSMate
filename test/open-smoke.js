// open_url / open_path 冒烟测试：校验安全拦截（协议白名单/可执行拒绝/存在性校验）
// 真实"打开浏览器/文件夹"的副作用用例默认跳过，设 OPEN_SMOKE_REAL=1 才执行
const fs = require('fs')
const path = require('path')
const os = require('os')
const { createTools } = require('../ai/tools')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-open-'))
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }

  const tools = createTools({
    tcpAgent: {}, snapshots: {}, desktopDir: dir, tmpDir: dir, workspaceDir: dir,
    getSetting: () => null, setSetting: () => true, log: () => {}
  })

  // ===== open_url 安全校验 =====
  const r1 = await tools.execute('open_url', { url: 'file:///C:/Windows/System32/cmd.exe' })
  check('open_url 拒绝 file:// 协议', r1.ok === false && r1.message.includes('拒绝'))
  const r2 = await tools.execute('open_url', { url: 'javascript:alert(1)' })
  check('open_url 拒绝 javascript: 协议', r2.ok === false)
  const r3 = await tools.execute('open_url', { url: 'ms-settings:display' })
  check('open_url 拒绝 ms-settings: 等自定义协议', r3.ok === false)
  const r4 = await tools.execute('open_url', { url: '`https://example.com`' })
  check('open_url 剥反引号后放行（不实际打开无法断言，仅确认不报拒绝）', !r4.message.includes('拒绝'))

  // ===== open_path 安全校验 =====
  const r5 = await tools.execute('open_path', { path: path.join(dir, '不存在的文件.txt') })
  check('open_path 路径不存在报错', r5.ok === false && r5.message.includes('不存在'))
  const exe = path.join(dir, '假程序.exe')
  fs.writeFileSync(exe, 'MZ fake')
  const r6 = await tools.execute('open_path', { path: exe })
  check('open_path 未审批拒绝 .exe（打开等于运行）', r6.ok === false && r6.message.includes('拒绝'))
  const exeMissing = path.join(dir, '不存在程序.exe')
  const r6b = await tools.execute('open_path', { path: exeMissing, __approved: true })
  check('open_path 审批后放行 .exe（走到存在性校验报不存在，未触发拒绝）', r6b.ok === false && r6b.message.includes('不存在'))
  const clsExe = await tools.classify('open_path', { path: exe })
  check('classify .exe 强制审批（任何模式都弹卡片）', clsExe.forceApproval === true && clsExe.destructive === true)
  const bat = path.join(dir, '脚本.bat')
  fs.writeFileSync(bat, '@echo off')
  const r7 = await tools.execute('open_path', { path: bat })
  check('open_path 未审批拒绝 .bat', r7.ok === false)
  const js = path.join(dir, '脚本.js')
  fs.writeFileSync(js, 'console.log(1)')
  const r8 = await tools.execute('open_path', { path: js })
  check('open_path 未审批拒绝 .js 脚本', r8.ok === false)
  const r9 = await tools.execute('open_path', { path: 'C:\\Windows\\系统配置\\受保护.ini' })
  check('open_path 拒绝 C 盘保护区（除桌面）', r9.ok === false && r9.message.includes('保护区'))

  // ===== summarize / 分类 / 工具清单一致性 =====
  check('summarize open_url', tools.summarize('open_url', { url: 'https://a.b' }).includes('打开网址'))
  check('summarize open_path', tools.summarize('open_path', { path: 'X:\\a.txt' }).includes('打开'))
  const cls = await tools.classify('open_url', { url: 'https://a.b' })
  check('classify open_url 非破坏性（免审批）', cls.destructive === false)
  const cls2 = await tools.classify('open_path', { path: dir })
  check('classify open_path 非破坏性（免审批）', cls2.destructive === false)
  const defs = tools.defs || []
  check('TOOL_DEFS 含 open_url/open_path（提示词一致性红线）',
    defs.some((t) => t.name === 'open_url') && defs.some((t) => t.name === 'open_path'))

  // ===== 真实打开（有副作用，默认跳过）=====
  if (process.env.OPEN_SMOKE_REAL === '1') {
    const r10 = await tools.execute('open_url', { url: 'https://example.com' })
    check('open_url 真实打开 example.com', r10.ok === true)
    const r11 = await tools.execute('open_path', { path: dir })
    check('open_path 真实打开临时文件夹', r11.ok === true)
  } else {
    console.log('⏭️ 跳过真实打开用例（设 OPEN_SMOKE_REAL=1 启用）')
  }

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
