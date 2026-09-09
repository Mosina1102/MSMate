// 会话存储：每个会话一个目录（内含 Agent 的 mswork_chat.json），外加索引文件
// 目录结构：baseDir/sessions/<id>/mswork_chat.json + baseDir/sessions.json
const fs = require('fs')
const path = require('path')
const HISTORY_FILE = 'mswork_chat.json' // 与 agent.js 保持一致

class SessionStore {
  constructor(baseDir) {
    this.baseDir = baseDir
    this.indexPath = path.join(baseDir, 'sessions.json')
    this.sessionsDir = path.join(baseDir, 'sessions')
    this._index = null
  }

  _loadIndex() {
    if (this._index) return this._index
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      this._index = Array.isArray(data.sessions) ? data.sessions : []
    } catch {
      this._index = []
    }
    return this._index
  }

  _saveIndex() {
    try {
      fs.mkdirSync(this.baseDir, { recursive: true })
      fs.writeFileSync(this.indexPath, JSON.stringify({ sessions: this._index || [] }))
    } catch {}
  }

  sessionDir(id) {
    return path.join(this.sessionsDir, id)
  }

  // 旧版单历史文件迁移为第一个会话；返回是否发生迁移
  migrate(oldHistoryDir) {
    const oldFile = path.join(oldHistoryDir, HISTORY_FILE)
    if (!fs.existsSync(oldFile)) return false
    if (this._loadIndex().length > 0) return false // 已有会话，不覆盖
    const meta = this.create('历史对话')
    fs.mkdirSync(this.sessionDir(meta.id), { recursive: true })
    fs.renameSync(oldFile, path.join(this.sessionDir(meta.id), HISTORY_FILE))
    return true
  }

  ensureDefault() {
    if (this._loadIndex().length === 0) this.create('新对话')
    return this.list()
  }

  list() {
    return this._loadIndex()
      .slice()
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
  }

  get(id) {
    return this._loadIndex().find((s) => s.id === id) || null
  }

  create(title) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const idx = this._loadIndex()
    // 保证 updatedAt 严格递增（同一毫秒连建多个会话时排序仍稳定）
    const maxUpdated = idx.length ? Math.max(...idx.map((s) => s.updatedAt || 0)) : 0
    const updatedAt = Math.max(Date.now(), maxUpdated + 1)
    const meta = { id, title: title || '新对话', createdAt: Date.now(), updatedAt, pinned: false }
    idx.push(meta)
    this._saveIndex()
    try { fs.mkdirSync(this.sessionDir(id), { recursive: true }) } catch {} // 目录先建好，历史/小笔记都能直接写
    return meta
  }

  rename(id, title) {
    const meta = this.get(id)
    if (!meta) return null
    meta.title = String(title || '').trim().slice(0, 40) || meta.title
    this._saveIndex()
    return meta
  }

  setPinned(id, pinned) {
    const meta = this.get(id)
    if (!meta) return null
    meta.pinned = !!pinned
    this._saveIndex()
    return meta
  }

  touch(id) {
    const meta = this.get(id)
    if (meta) {
      meta.updatedAt = Date.now()
      this._saveIndex()
    }
  }

  remove(id) {
    const idx = this._loadIndex().findIndex((s) => s.id === id)
    if (idx === -1) return false
    this._index.splice(idx, 1)
    this._saveIndex()
    try {
      fs.rmSync(this.sessionDir(id), { recursive: true, force: true })
    } catch {}
    return true
  }
}

module.exports = { SessionStore, HISTORY_FILE }
