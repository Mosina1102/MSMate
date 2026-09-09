// ============================================
// 快照缓存槽：AI 执行删除/覆盖/移动前自动备份原文件
// 出问题可一键还原，是"AI 抽风"的兜底保障
// ============================================
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

class SnapshotManager {
  constructor({ dir, log, maxSnapshots = 50, maxFileBytes = 200 * 1024 * 1024 }) {
    this.dir = dir
    this.log = log || (() => {})
    this.maxSnapshots = maxSnapshots
    this.maxFileBytes = maxFileBytes
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  }

  snapshotDir(id) {
    return path.join(this.dir, id)
  }

  // 递归统计总大小（带上限，超限提前返回 -1 避免扫大盘）
  dirSizeFast(dirPath, cap) {
    let total = 0
    const walk = (p, depth) => {
      if (depth > 12 || total > cap) return
      let entries
      try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = path.join(p, e.name)
        if (e.isDirectory()) {
          walk(full, depth + 1)
        } else {
          try { total += fs.statSync(full).size } catch {}
          if (total > cap) return
        }
      }
    }
    walk(dirPath, 0)
    return total > cap ? -1 : total
  }

  copyFileChecked(src, dest) {
    const st = fs.statSync(src)
    if (st.size > this.maxFileBytes) {
      throw new Error(`文件过大（${(st.size / 1048576).toFixed(1)}MB > ${(this.maxFileBytes / 1048576)}MB），跳过备份`)
    }
    fs.copyFileSync(src, dest)
    return st.size
  }

  copyFolderChecked(src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    let total = 0
    const entries = fs.readdirSync(src, { withFileTypes: true })
    for (const e of entries) {
      const s = path.join(src, e.name)
      const d = path.join(dest, e.name)
      if (e.isDirectory()) {
        total += this.copyFolderChecked(s, d)
      } else {
        total += this.copyFileChecked(s, d)
      }
    }
    return total
  }

  // 本地快照：备份 targetPath（文件或文件夹）到缓存槽
  // 返回 { ok, id, size, reason? }
  backupLocal(originalPath, target = 'local', deviceId = null) {
    const id = 'snap_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex')
    const dataDir = path.join(this.snapshotDir(id), 'data')
    let meta
    try {
      const st = fs.statSync(originalPath)
      fs.mkdirSync(dataDir, { recursive: true })
      let size = 0
      if (st.isDirectory()) {
        // 文件夹：备份到 data/<文件夹名>/
        const dest = path.join(dataDir, path.basename(originalPath) || 'folder')
        size = this.copyFolderChecked(originalPath, dest)
        if (size > this.maxFileBytes * 2.5) throw new Error('文件夹过大，跳过备份')
      } else {
        size = this.copyFileChecked(originalPath, path.join(dataDir, path.basename(originalPath)))
      }
      meta = {
        id,
        time: Date.now(),
        originalPath,
        target,
        deviceId,
        isDirectory: st.isDirectory(),
        size,
        ok: true
      }
    } catch (err) {
      meta = { id, time: Date.now(), originalPath, target, deviceId, size: 0, ok: false, reason: err.message }
      try { fs.rmSync(this.snapshotDir(id), { recursive: true, force: true }) } catch {}
      try { fs.mkdirSync(this.snapshotDir(id), { recursive: true }) } catch {}
    }
    try {
      fs.writeFileSync(path.join(this.snapshotDir(id), 'meta.json'), JSON.stringify(meta, null, 2))
    } catch (err) {
      this.log(`快照元数据写入失败: ${err.message}`)
    }
    this.prune()
    return meta
  }

  // 为远程备份预留快照位（下载由 tools 模块负责），登记元数据
  register(id, meta) {
    try {
      fs.mkdirSync(path.join(this.snapshotDir(id), 'data'), { recursive: true })
      fs.writeFileSync(path.join(this.snapshotDir(id), 'meta.json'), JSON.stringify(meta, null, 2))
      this.prune()
    } catch {}
  }

  list() {
    const result = []
    let ids = []
    try { ids = fs.readdirSync(this.dir) } catch { return result }
    for (const id of ids) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'meta.json'), 'utf8'))
        result.push(meta)
      } catch {}
    }
    result.sort((a, b) => b.time - a.time)
    return result
  }

  // 还原：把备份内容复制回原路径（覆盖）
  restore(id) {
    const meta = this.list().find((m) => m.id === id)
    if (!meta || !meta.ok) return { success: false, error: '快照不存在或备份时未成功' }
    const dataDir = path.join(this.dir, id, 'data')
    try {
      if (!meta.isDirectory) {
        const files = fs.readdirSync(dataDir)
        if (!files.length) return { success: false, error: '备份数据为空' }
        fs.mkdirSync(path.dirname(meta.originalPath), { recursive: true })
        fs.copyFileSync(path.join(dataDir, files[0]), meta.originalPath)
      } else {
        // 文件夹：把 data/<name>/ 下的内容整体复制回去
        const folders = fs.readdirSync(dataDir, { withFileTypes: true })
        const srcRoot = folders.length ? path.join(dataDir, folders[0].name) : dataDir
        this.restoreFolder(srcRoot, meta.originalPath)
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  restoreFolder(src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name)
      const d = path.join(dest, e.name)
      if (e.isDirectory()) this.restoreFolder(s, d)
      else fs.copyFileSync(s, d)
    }
  }

  remove(id) {
    try {
      fs.rmSync(this.snapshotDir(id), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  prune() {
    const all = this.list()
    for (let i = this.maxSnapshots; i < all.length; i++) this.remove(all[i].id)
  }
}

module.exports = { SnapshotManager }
