// 数据同步冒烟测试：导出打包 → 导入还原（含备份/路径穿越防护/白名单过滤）
const fs = require('fs')
const path = require('path')
const os = require('os')
const JSZip = require('jszip')
const { packData, applyImport, filterEntries } = require('../ai/data-sync')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-sync-home-'))
const away = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-sync-away-'))

async function main() {
  // ===== 1. 准备"家里"设备的数据 =====
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ aiRules: ['文件都放桌面'], chatModelList: ['m1'] }))
  fs.mkdirSync(path.join(home, 'ai-chat', 'sessions', 's1'), { recursive: true })
  fs.writeFileSync(path.join(home, 'ai-chat', 'sessions.json'), JSON.stringify([{ id: 's1', title: '项目A' }]))
  fs.writeFileSync(path.join(home, 'ai-chat', 'sessions', 's1', 'mswork_chat.json'), JSON.stringify({ messages: [{ role: 'user', content: '推进项目A' }], checkpoints: [] }))
  fs.mkdirSync(path.join(home, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(home, 'workspace', 'NOTES.md'), '# 记事本\n- 偏好：亮色主题')
  fs.writeFileSync(path.join(home, 'workspace', '成果.docx'), 'binary-ish')

  // ===== 2. 导出打包 =====
  const zip = new JSZip()
  const { fileCount } = packData(home, zip)
  check('打包统计到所有文件', fileCount === 5)
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  fs.writeFileSync(path.join(home, 'export.zip'), buf)

  // ===== 3. "公司"设备导入前有旧数据，导入应备份并覆盖 =====
  fs.writeFileSync(path.join(away, 'settings.json'), JSON.stringify({ aiRules: ['旧规则'] }))
  fs.mkdirSync(path.join(away, 'workspace'), { recursive: true })
  fs.writeFileSync(path.join(away, 'workspace', '旧文件.txt'), '本机旧数据')

  const zip2 = await JSZip.loadAsync(fs.readFileSync(path.join(home, 'export.zip')))
  const r = await applyImport(away, zip2)
  check('导入还原全部文件', r.restored === 5)
  check('备份目录存在', r.backedUp >= 2 && fs.existsSync(r.backupDir))
  check('导入后 settings 为家里的版本', JSON.parse(fs.readFileSync(path.join(away, 'settings.json'), 'utf8')).aiRules[0] === '文件都放桌面')
  check('会话历史完整迁移', fs.readFileSync(path.join(away, 'ai-chat', 'sessions', 's1', 'mswork_chat.json'), 'utf8').includes('推进项目A'))
  check('工作台 NOTES.md 迁移', fs.readFileSync(path.join(away, 'workspace', 'NOTES.md'), 'utf8').includes('亮色主题'))
  check('本机旧文件被清掉', !fs.existsSync(path.join(away, 'workspace', '旧文件.txt')))
  check('备份里保留了旧规则', JSON.parse(fs.readFileSync(path.join(r.backupDir, 'settings.json'), 'utf8')).aiRules[0] === '旧规则')

  // ===== 4. 路径穿越防护：恶意 zip 条目 =====
  const evil = new JSZip()
  evil.file('../../evil.txt', 'pwned')
  evil.file('settings.json', '{"ok":1}')
  const evilBuf = await evil.generateAsync({ type: 'nodebuffer' })
  const evilZip = await JSZip.loadAsync(evilBuf)
  const kept = filterEntries(evilZip)
  check('穿越条目被过滤', kept.length === 1 && kept[0].norm === 'settings.json')
  await applyImport(away, evilZip)
  check('穿越文件没有落盘', !fs.existsSync(path.join(away, 'evil.txt')) && !fs.existsSync(path.join(os.tmpdir(), 'evil.txt')))

  // ===== 5. 白名单外条目被拒 =====
  const stray = new JSZip()
  stray.file('mswork_snapshots/x.txt', 'nope')
  stray.file('random.txt', 'nope')
  stray.file('ai-chat/sessions.json', '[]')
  const strayZip = await JSZip.loadAsync(await stray.generateAsync({ type: 'nodebuffer' }))
  const kept2 = filterEntries(strayZip)
  check('白名单外条目被过滤', kept2.length === 1 && kept2[0].norm === 'ai-chat/sessions.json')

  // ===== 6. 空数据包导入报错 =====
  let threw = false
  try { await applyImport(away, await JSZip.loadAsync(await new JSZip().generateAsync({ type: 'nodebuffer' }))) } catch { threw = true }
  check('空数据包导入明确报错', threw)

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
