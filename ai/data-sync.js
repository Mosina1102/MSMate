// ============================================
// 数据同步核心逻辑：跨设备物理迁移（导出打包 / 导入还原）
// 数据范围：settings.json（含 AI 配置/规则/记忆/常用模型清单）+ ai-chat（所有会话）+ workspace（工作台含记事本）
// 导入前自动备份到 mswork_snapshots/data-import-<ts>，导入后需重启应用生效
// ============================================
const fs = require('fs')
const path = require('path')

// 白名单顶层条目：导入时只接受这三项，防路径穿越/夹带垃圾
const ALLOWED_TOP = ['settings.json', 'ai-chat', 'workspace']

// 递归把目录内容加进 JSZip（onFile 在每加入一个文件时回调）
function addDirToZip(zip, dir, zipPath, onFile) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const zp = zipPath + '/' + name
    const st = fs.statSync(full)
    if (st.isDirectory()) addDirToZip(zip, full, zp, onFile)
    else { zip.file(zp, fs.readFileSync(full)); onFile() }
  }
}

// 打包 userData 里的白名单数据到 zip；返回 { fileCount }
function packData(userDataPath, zip) {
  let fileCount = 0
  for (const top of ALLOWED_TOP) {
    const src = path.join(userDataPath, top)
    if (!fs.existsSync(src)) continue
    const st = fs.statSync(src)
    if (st.isFile()) {
      zip.file(top, fs.readFileSync(src))
      fileCount++
    } else if (st.isDirectory()) {
      addDirToZip(zip, src, top, () => fileCount++)
    }
  }
  return { fileCount }
}

// 从 zip 条目清单筛选可导入条目：路径规范化 + 白名单顶层，防穿越；返回 [{ entry, norm }]
function filterEntries(zip) {
  const allowed = new Set(ALLOWED_TOP)
  const entries = []
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name]
    if (entry.dir) continue
    const norm = path.posix.normalize(String(name).split('\\').join('/'))
    if (norm.startsWith('..') || path.posix.isAbsolute(norm)) continue
    if (!allowed.has(norm.split('/')[0])) continue
    entries.push({ entry, norm })
  }
  return entries
}

// 导入还原：先备份现有数据，再清空白名单区并写入 zip 内容
// zip 已由调用方 loadAsync；返回 { restored, backedUp, backupDir }
async function applyImport(userDataPath, zip) {
  const entries = filterEntries(zip)
  if (!entries.length) throw new Error('数据包内没有可导入的内容（缺少设置/对话/工作台）')
  // 导入前备份现有数据到快照目录
  const backupDir = path.join(userDataPath, 'mswork_snapshots', 'data-import-' + Date.now())
  let backedUp = 0
  for (const top of ALLOWED_TOP) {
    const p = path.join(userDataPath, top)
    if (!fs.existsSync(p)) continue
    const dest = path.join(backupDir, top)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.cpSync(p, dest, { recursive: true })
    backedUp++
  }
  // 先清空再写入，保证与导出端一致（避免残留旧会话/旧文件）
  for (const top of ALLOWED_TOP) {
    try { fs.rmSync(path.join(userDataPath, top), { recursive: true, force: true }) } catch {}
  }
  let restored = 0
  const userDataRoot = path.resolve(userDataPath) + path.sep
  for (const { entry, norm } of entries) {
    const dest = path.resolve(userDataPath, norm)
    if (!dest.startsWith(userDataRoot)) continue // 双保险（Windows 盘符/前缀变种）
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, Buffer.from(await entry.async('arraybuffer')))
    restored++
  }
  return { restored, backedUp, backupDir }
}

module.exports = { ALLOWED_TOP, packData, applyImport, filterEntries }
