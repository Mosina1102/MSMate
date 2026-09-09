// MSWork Agent 端到端测试：真实调用硅基流动，验证 文本协议→工具执行 全链路
// 运行：node test/ai-agent-test.js
const os = require('os')
const path = require('path')
const fs = require('fs')
const { SiliconFlowClient } = require('../ai/siliconflow')
const { SnapshotManager } = require('../ai/snapshots')
const { createTools } = require('../ai/tools')
const { WorkAgent } = require('../ai/agent')

// Key 不入源码：从环境变量 MSWORK_AI_KEY 读取（seed_key.txt 播种机制已移除）
const API_KEY = process.env.MSWORK_AI_KEY || ''

// 测试目录放 D 盘根下（避开 C 盘保护区；根目录写入受权限限制时 AI 应自动建子目录）
const tmp = path.join('D:\\', 'mswork-ai-test-tmp')
fs.mkdirSync(tmp, { recursive: true })
const TARGET = path.join(tmp, 'output', 'mswork_ai_test.txt')
const DOCX_TARGET = path.join(tmp, 'output', 'mswork_ai_test.docx')

const snapshots = new SnapshotManager({ dir: path.join(tmp, 'snapshots'), log: console.log })
const tcpStub = { getConnectedDevices: () => [] }
const tools = createTools({
  tcpAgent: tcpStub,
  snapshots,
  desktopDir: path.join(os.homedir(), 'Desktop'),
  tmpDir: tmp,
  log: console.log
})

const agent = new WorkAgent({
  client: new SiliconFlowClient({ apiKey: API_KEY }),
  tools,
  snapshots,
  tcpAgent: tcpStub,
  getSetting: (k) => (k === 'aiApiKey' ? API_KEY : null),
  setSetting: () => true,
  send: (e) => {
    if (e.type === 'content_delta') process.stdout.write(e.delta)
    else if (e.type !== 'reasoning_delta') console.log('\n[event]', JSON.stringify(e).slice(0, 260))
  },
  log: console.log,
  hostName: '测试机'
})
agent.setHistoryDir(tmp)

console.log('目标文件:', TARGET)
if (fs.existsSync(TARGET)) fs.unlinkSync(TARGET)
if (fs.existsSync(DOCX_TARGET)) fs.unlinkSync(DOCX_TARGET)

agent
  .sendUserMessage(`请在 "${path.join(tmp, 'output')}" 目录下创建一个名为 mswork_ai_test.txt 的文本文件，内容为：MSWork 测试成功。目录不存在就先创建。然后再用 create_word 工具在同目录创建 mswork_ai_test.docx，标题"测试文档"，正文两段：第一段"这是第一段"，第二段"这是第二段"。全部完成后告诉我结果。`)
  .then(async (r) => {
    console.log('\n[agent result]', JSON.stringify(r))
    const created = fs.existsSync(TARGET) && fs.readFileSync(TARGET, 'utf8').includes('MSWork')
    console.log(created ? '✅ 端到端测试通过：AI 成功创建文本文件' : '❌ 测试失败：文本文件未创建')
    let docxOk = false
    if (created && fs.existsSync(DOCX_TARGET)) {
      const { readDocxText } = require('../ai/office')
      const text = await readDocxText(DOCX_TARGET)
      docxOk = text.includes('第一段') && text.includes('第二段')
      console.log(docxOk ? '✅ Word 测试通过：docx 创建且内容可读' : `❌ Word 内容异常: ${text}`)
    } else {
      console.log('❌ 测试失败：Word 文档未创建')
    }
    if (!created || !docxOk) process.exit(1)

    // 回滚测试：撤销本轮所有操作（新建的文件应被删除）
    const cp = agent.checkpoints[agent.checkpoints.length - 1]
    console.log(`\n[回滚测试] 回滚到 msgIndex=${cp.msgIndex}，撤销 ${cp.undos.length} 项`)
    const rb = await agent.rollbackTo(cp.msgIndex)
    console.log('[回滚结果]', JSON.stringify(rb))
    const rolledBack = !fs.existsSync(TARGET) && !fs.existsSync(DOCX_TARGET)
    console.log(rolledBack ? '✅ 回滚测试通过：AI 新建的文件已被删除' : '❌ 回滚测试失败：文件仍存在')
    process.exit(rolledBack ? 0 : 1)
  })
  .catch((e) => {
    console.error('❌ 异常:', e)
    process.exit(1)
  })
