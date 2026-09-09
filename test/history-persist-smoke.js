// 聊天历史持久化回归测试（node test/history-persist-smoke.js）
// 回归背景：多会话版 saveHistory 不建会话子目录 → writeFileSync ENOENT 静默失败 → 重启后聊天记录全丢
const fs = require('fs')
const path = require('path')
const os = require('os')
const { WorkAgent } = require('../ai/agent')
const { SessionStore } = require('../ai/sessions')

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`)
  else { failures++; console.error(`  ❌ ${msg}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-hist-'))
try {
  console.log('[1] SessionStore.create 建目录')
  const store = new SessionStore(TMP)
  const meta = store.create('测试会话')
  const dir = store.sessionDir(meta.id)
  assert(fs.existsSync(dir), 'create 即建会话目录')

  console.log('[2] Agent 写历史 → 落盘成功（不再 ENOENT 静默失败）')
  const a = new WorkAgent({})
  a.setHistoryDir(dir)
  a.history = [
    { role: 'user', content: '你好哇' },
    { role: 'assistant', content: '喵！我是 MSMate' }
  ]
  a.checkpoints = [{ msgIndex: 0, undos: [] }]
  let err = null
  try { a.saveHistory() } catch (e) { err = e }
  assert(!err && fs.existsSync(path.join(dir, 'mswork_chat.json')), '历史文件已写入')

  console.log('[3] 重启模拟：新实例从磁盘恢复历史')
  const b = new WorkAgent({})
  b.setHistoryDir(dir)
  assert(b.history.length === 2 && b.history[1].content === '喵！我是 MSMate', '历史完整恢复')
  assert(b.checkpoints.length === 1, '检查点完整恢复')

  console.log('[4] 小笔记本同目录落盘')
  a.historyDir = dir
  a.appendWorkNote('任务完成：测试小笔记本')
  const notesPath = path.join(dir, 'notes.md')
  assert(fs.existsSync(notesPath) && fs.readFileSync(notesPath, 'utf8').includes('小笔记本'), '小笔记写入会话目录')

  console.log('[5] 删除会话 → 历史与小笔记一起清除')
  store.remove(meta.id)
  assert(!fs.existsSync(dir), '会话目录（含小笔记本）已自动清除')

  console.log(failures === 0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
