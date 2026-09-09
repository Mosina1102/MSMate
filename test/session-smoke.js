// 多会话存储冒烟测试：SessionStore CRUD + 旧历史迁移 + Agent 历史目录隔离约定
const fs = require('fs')
const path = require('path')
const os = require('os')
const { SessionStore, HISTORY_FILE } = require('../ai/sessions')

let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-sessions-'))
try {
  // ===== 1. 空存储 → ensureDefault 建第一个会话 =====
  const store = new SessionStore(base)
  check('空存储 list 为空', store.list().length === 0)
  store.ensureDefault()
  check('ensureDefault 建立一个会话', store.list().length === 1)
  check('默认标题为 新对话', store.list()[0].title === '新对话')
  const first = store.list()[0]

  // ===== 2. CRUD =====
  const s2 = store.create('整理重庆天气')
  check('create 返回元数据', s2 && s2.id && s2.title === '整理重庆天气')
  check('list 按 updatedAt 倒序（新建在前）', store.list()[0].id === s2.id)
  store.rename(s2.id, '重庆天气项目')
  check('rename 生效', store.get(s2.id).title === '重庆天气项目')
  store.rename(s2.id, '')
  check('rename 空串不吞标题', store.get(s2.id).title === '重庆天气项目')
  store.setPinned(s2.id, true)
  store.create('另一个会话')
  check('置顶会话排最前', store.list()[0].id === s2.id && store.list()[0].pinned === true)
  store.touch(s2.id)
  check('touch 更新 updatedAt', store.get(s2.id).updatedAt > 0)
  // 超长标题裁剪
  store.rename(s2.id, 'x'.repeat(60))
  check('rename 超长标题裁到 40', store.get(s2.id).title.length === 40)

  // ===== 3. Agent 历史目录隔离约定：sessions/<id>/mswork_chat.json =====
  const dirA = store.sessionDir(first.id)
  const dirB = store.sessionDir(s2.id)
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  fs.writeFileSync(path.join(dirA, HISTORY_FILE), JSON.stringify({ messages: [{ role: 'user', content: 'A 的消息' }], checkpoints: [] }))
  fs.writeFileSync(path.join(dirB, HISTORY_FILE), JSON.stringify({ messages: [{ role: 'user', content: 'B 的消息' }], checkpoints: [] }))
  const loadHist = (dir) => JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8'))
  check('会话 A 历史独立', loadHist(dirA).messages[0].content === 'A 的消息')
  check('会话 B 历史独立', loadHist(dirB).messages[0].content === 'B 的消息')
  check('两会话目录不同', dirA !== dirB)

  // ===== 4. 旧版单历史文件迁移 =====
  const oldBase = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-old-'))
  fs.writeFileSync(path.join(oldBase, HISTORY_FILE), JSON.stringify({ messages: [{ role: 'user', content: '老版本的历史' }], checkpoints: [] }))
  const store2 = new SessionStore(path.join(oldBase, 'ai-chat'))
  const migrated = store2.migrate(oldBase)
  check('migrate 报告发生迁移', migrated === true)
  check('迁移后有一个会话', store2.list().length === 1)
  const m0 = store2.list()[0]
  const mHist = JSON.parse(fs.readFileSync(path.join(store2.sessionDir(m0.id), HISTORY_FILE), 'utf8'))
  check('迁移后历史内容保留', mHist.messages[0].content === '老版本的历史')
  check('旧文件已移走', !fs.existsSync(path.join(oldBase, HISTORY_FILE)))
  // 重复迁移不覆盖
  const migratedAgain = store2.migrate(oldBase)
  check('无旧文件时 migrate 返回 false', migratedAgain === false)
  // 已有会话时不迁移（防覆盖）
  fs.writeFileSync(path.join(oldBase, HISTORY_FILE), JSON.stringify({ messages: [], checkpoints: [] }))
  const migratedSkip = store2.migrate(oldBase)
  check('已有会话时 migrate 拒绝覆盖', migratedSkip === false)
  check('已有会话数量不变', store2.list().length === 1)

  // ===== 5. 删除会话 =====
  const s3 = store.create('待删除')
  check('删除前 4 个会话', store.list().length === 4)
  check('remove 返回 true', store.remove(s3.id) === true)
  check('删除后 3 个会话', store.list().length === 3)
  check('目录一并清除', !fs.existsSync(store.sessionDir(s3.id)))
  check('remove 不存在的 id 返回 false', store.remove('nonexistent') === false)

  // ===== 6. 索引持久化（重开 store 后数据还在）=====
  const store3 = new SessionStore(base)
  check('重新实例化后索引恢复', store3.list().length === 3 && store3.get(s2.id) !== null)
} finally {
  fs.rmSync(base, { recursive: true, force: true })
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
