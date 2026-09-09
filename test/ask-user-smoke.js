// ask_user 中途提问冒烟测试（mock client 跑真实 agent 循环，不调真实 API）
const fs = require('fs')
const os = require('os')
const path = require('path')
const { WorkAgent } = require('../ai/agent')

// 脚本化 client：第 N 轮返回预置回复
function makeClient(scripts) {
  let i = 0
  return {
    async *chatStream() {
      const content = scripts[Math.min(i++, scripts.length - 1)]
      yield { type: 'content_delta', delta: content }
    }
  }
}

const mockTools = {
  classify: async () => ({ destructive: false, note: '', paths: [] }),
  summarize: (n) => n,
  isProtectedLocal: () => false,
  execute: async () => ({ ok: true, message: 'ok' })
}

function makeAgent(scripts, events, onAsk) {
  const agent = new WorkAgent({
    client: makeClient(scripts),
    tools: mockTools,
    snapshots: {},
    tcpAgent: {},
    getSetting: () => null,
    setSetting: () => true,
    send: (e) => {
      events.push(e)
      if (e.type === 'tool_call' && e.name === 'ask_user' && onAsk) {
        setTimeout(() => onAsk(agent, e), 10)
      }
    },
    log: () => {},
    hostName: '测试机'
  })
  agent.setHistoryDir(fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-ask-')))
  return agent
}

const ASK_SCRIPT = '我先确认一下需求。\n```tool\n{"name":"ask_user","arguments":{"questions":[{"question":"要哪种格式？","header":"格式","options":[{"label":"Word","description":"docx 文档"},{"label":"Excel","description":"xlsx 表格"}],"multiSelect":false},{"question":"放在哪里？","header":"位置","options":[{"label":"桌面","description":"放到桌面"}],"multiSelect":false}]}}\n```'
const DONE_SCRIPT = '好的，收到你的回答，任务完成。'

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }

  // 1. 正常回答：AI 提问 → 用户点选+填其他 → AI 收到答案继续
  {
    const events = []
    const agent = makeAgent([ASK_SCRIPT, DONE_SCRIPT], events, (ag, e) => {
      ag.resolveAsk(e.callId, { answers: [{ selected: ['Word'], other: '顺便加个目录' }, { selected: [], other: 'D:\\报告' }] })
    })
    const r = await agent.sendUserMessage('帮我做一份文档')
    check('回答后任务正常跑完', r.success === true)
    const tr = events.find((e) => e.type === 'tool_result' && e.name === 'ask_user')
    check('提问卡片收到结果事件', !!tr && tr.ok === true)
    check('答案格式化含选项与其他', tr && tr.message.includes('要哪种格式') && tr.message.includes('Word') && tr.message.includes('其他：顺便加个目录') && tr.message.includes('其他：D:\\报告'))
    const answered = agent.history.some((m) => m.role === 'user' && m.content.includes('用户已回答') && m.content.includes('顺便加个目录'))
    check('答案写入历史供 AI 后续使用', answered)
  }

  // 2. 取消提问：AI 收到"按最合理方案继续"提示
  {
    const events = []
    const agent = makeAgent([ASK_SCRIPT, DONE_SCRIPT], events, (ag, e) => {
      ag.resolveAsk(e.callId, { cancelled: true })
    })
    const r = await agent.sendUserMessage('帮我做一份文档')
    check('取消后任务继续跑完', r.success === true)
    const tr = events.find((e) => e.type === 'tool_result' && e.name === 'ask_user')
    check('取消提示写给 AI', tr && tr.message.includes('用户取消了提问') && tr.message.includes('最合理方案'))
  }

  // 3. abort 停止：等待回答时停止任务，waitAsk 应被释放
  {
    const events = []
    const agent = makeAgent([ASK_SCRIPT, DONE_SCRIPT], events, (ag, e) => {
      setTimeout(() => ag.abort(), 10)
    })
    const r = await agent.sendUserMessage('帮我做一份文档')
    check('提问中 abort 任务结束', r.success === true)
    check('pendingAsks 已清空', agent.pendingAsks.size === 0)
  }

  // 4. 子Agent 提问：resolveAsk 沿子Agent链转发
  {
    const parent = Object.create(WorkAgent.prototype)
    parent.pendingAsks = new Map()
    parent.childAgents = []
    const child = Object.create(WorkAgent.prototype)
    let got = null
    child.pendingAsks = new Map([['ask_1', { resolve: (p) => { got = p } }]])
    parent.childAgents.push(child)
    const hit = parent.resolveAsk('ask_1', { answers: [{ selected: ['甲'], other: '' }] })
    check('子Agent 提问可由父级转发回答', hit === true && got && got.answers[0].selected[0] === '甲')
  }

  console.log(pass ? '\n✅ ask_user 冒烟测试全部通过' : '\n❌ 有失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
