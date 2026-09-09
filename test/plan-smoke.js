// 任务清单（task_plan）冒烟测试：建清单/打勾/进度注入/UI 事件
const { WorkAgent } = require('../ai/agent')

function makeClient(scripts) {
  let i = 0
  return {
    async *chatStream() {
      const content = scripts[Math.min(i++, scripts.length - 1)]
      yield { type: 'content_delta', delta: content }
    }
  }
}

function makeAgent(scripts, events, executeLog) {
  const mockTools = {
    defs: [{ name: 'web_search' }, { name: 'task_plan' }],
    classify: async () => ({ destructive: false, note: '', paths: [] }),
    summarize: (n) => n,
    isProtectedLocal: () => false,
    execute: async (name, args) => {
      executeLog.push({ name, args })
      return { ok: true, message: '搜索结果：xxx' }
    }
  }
  const agent = new WorkAgent({
    client: makeClient(scripts),
    tools: mockTools,
    snapshots: {},
    tcpAgent: {},
    getSetting: (k) => (k === 'aiApiKey' ? 'mock-key' : null), // v2.4.44 起 sendUserMessage 校验 API Key（无 Key 直接拒绝）
    setSetting: () => true,
    send: (e) => events.push(e),
    log: () => {},
    hostName: '测试机'
  })
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  agent.setHistoryDir(fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-plan-')))
  return agent
}

const T = (s) => '好的。\n```tool\n' + JSON.stringify(s) + '\n```'

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }

  // 场景 1：建清单 → 干活 → 打勾推进 → 全部完成收尾
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([
      T({ name: 'task_plan', arguments: { items: ['搜索直链', '下载图片', '汇报成果'] } }) + '\n' + T({ name: 'web_search', arguments: { query: 'mc 壁纸' } }),
      T({ name: 'task_plan', arguments: { doing: 2, done: 1 } }) + '\n' + T({ name: 'web_search', arguments: { query: 'mc 壁纸 4k 高清直链' } }),
      T({ name: 'task_plan', arguments: { done: [2, 3] } }),
      '全部搞定，汇报！'
    ], events, executeLog)
    const r = await agent.sendUserMessage('下壁纸')
    check('清单场景任务正常结束', r.success === true)
    check('task_plan 不进工具执行器', executeLog.every((e) => e.name === 'web_search') && executeLog.length === 2)
    const planEvents = events.filter((e) => e.type === 'plan')
    check('UI 收到 3 次 plan 事件', planEvents.length === 3)
    const last = planEvents[planEvents.length - 1]
    check('最终 3/3 全部完成', last && last.done === 3 && last.total === 3)
    check('第2项曾标记进行中', planEvents.some((e) => e.items[1] && e.items[1].status === 'doing'))
    const searchResult = agent.history.find((m) => m.role === 'user' && m.content.includes('name="web_search"'))
    check('工具结果注入进度行', searchResult && /\[任务清单 \d\/3 完成/.test(searchResult.content))
    const tpResult = agent.history.filter((m) => m.role === 'user' && m.content.includes('name="task_plan"'))
    check('清单结果带下一步提示', tpResult.some((m) => m.content.includes('下一步：第')))
    const allDone = tpResult[tpResult.length - 1]
    check('全部完成提示出现', allDone && allDone.content.includes('全部完成'))
  }

  // 场景 2：没建清单就打勾 → 拒绝并教用法；乱序号不炸
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([
      T({ name: 'task_plan', arguments: { done: 1 } }),
      T({ name: 'task_plan', arguments: { items: ['唯一一项'], done: 99, doing: 1 } }),
      '汇报！'
    ], events, executeLog)
    const r = await agent.sendUserMessage('干活')
    check('异常场景正常结束', r.success === true)
    const noPlan = agent.history.find((m) => m.role === 'user' && m.content.includes('还没有任务清单'))
    check('无清单时拒绝并教建清单', !!noPlan)
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('越界序号被忽略、doing 正常生效', last && last.total === 1 && last.items[0].status === 'doing' && last.done === 0)
  }

  // 场景 3：没建清单就先干活 → 系统一次性提醒补清单（含"别一步一停"敲打）
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([
      T({ name: 'web_search', arguments: { query: 'mc 壁纸' } }),
      T({ name: 'task_plan', arguments: { items: ['搜索', '汇报'] } }) + '\n' + T({ name: 'web_search', arguments: { query: 'mc 壁纸 高清' } }),
      T({ name: 'task_plan', arguments: { done: [1, 2] } }),
      '汇报！'
    ], events, executeLog)
    // v2.4.45 起 ≤14 字视为小任务不催建板：本场景测多步任务提醒，消息须描述完整多步目标
    const r = await agent.sendUserMessage('帮我下载几张mc壁纸放进新建的文件夹里')
    check('提醒场景任务正常结束', r.success === true)
    const nudges = agent.history.filter((m) => m.content.includes('【系统提醒】'))
    check('没建清单先干活 → 系统提醒补清单', nudges.length === 1 && nudges[0].content.includes('task_plan 建立任务清单'))
    check('提醒包含反一步一停敲打', nudges.length && nudges[0].content.includes('禁止只干一步'))
  }

  // 场景 4：建清单后想收尾（真机变体：干一步→建清单→"汇报"停机）→ 收尾护栏拦一次强制继续
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([
      T({ name: 'web_search', arguments: { query: 'mc 壁纸' } }),
      T({ name: 'task_plan', arguments: { items: ['搜索', '下载', '汇报'] } }),
      '我先汇报一下进度……', // 清单没勾完就想收尾 → 应被拦截
      T({ name: 'task_plan', arguments: { done: [1, 2, 3] } }),
      '这次真汇报！'
    ], events, executeLog)
    const r = await agent.sendUserMessage('下壁纸')
    check('收尾拦截场景任务正常结束', r.success === true)
    const nudges = agent.history.filter((m) => m.content.includes('【系统提醒】') && m.content.includes('清单还有未完成项'))
    check('清单未完成想收尾 → 拦截一次', nudges.length === 1 && nudges[0].content.includes('第 1 项'))
    check('拦截包含强制继续指令', nudges.length && nudges[0].content.includes('全部勾完才允许汇报'))
    const ev = events.find((e) => e.type === 'tool_parse_error' && String(e.error || '').includes('提前收尾'))
    check('UI 收到收尾拦截事件', !!ev)
    // 护栏只拦一次：二次收尾直接放行，不无限循环
    check('护栏只拦一次不循环', agent.history.filter((m) => m.content.includes('清单还有未完成项')).length === 1)
  }

  // 场景 5：原地打转护栏（真机变体：活干完了反复重发相同清单状态 + 进行中的项被提示"开工"导致循环）
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([
      T({ name: 'web_search', arguments: { query: 'mc 壁纸' } }),
      T({ name: 'task_plan', arguments: { items: ['移动A', '移动B', '汇报'], doing: 1 } }),
      T({ name: 'task_plan', arguments: { done: 1, doing: 2 } }), // 状态变更：ok
      T({ name: 'task_plan', arguments: { doing: [2] } }),        // 参数不同但状态不变 → 原地打转警告
      T({ name: 'task_plan', arguments: { done: 2 } }),           // 打勾推进：ok
      '我先汇报一下进度……',                                        // 清单没勾完 → 收尾拦截一次
      T({ name: 'task_plan', arguments: { done: [1, 3] } }),
      '最终汇报！'
    ], events, executeLog)
    const r = await agent.sendUserMessage('整理桌面图片')
    check('打转场景任务正常结束', r.success === true)
    const spinning = agent.history.filter((m) => m.role === 'user' && m.content.includes('原地打转'))
    check('重复相同清单状态 → 原地打转警告', spinning.length === 1 && spinning[0].content.includes('没有任何变化'))
    check('打转警告带打勾指引', spinning.length && spinning[0].content.includes('done:2'))
    const tpResults = agent.history.filter((m) => m.role === 'user' && /<tool_result name="task_plan"/.test(m.content))
    check('进行中的项提示"打勾推进"而非"开工"', tpResults.some((m) => m.content.includes('进行中——该项工作实际完成后')))
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('最终 3/3 全部完成', last && last.done === 3 && last.total === 3)
  }

  // 场景 6：干完活不打卡护栏（真机变体：Qwen3-8B 下载完 29 张图后重发相同清单标 doing，不知道打勾）
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([
      T({ name: 'web_search', arguments: { query: 'q1' } }),
      T({ name: 'task_plan', arguments: { items: ['下载壁纸', '保存文件'], doing: 1 } }),
      T({ name: 'web_search', arguments: { query: 'q2' } }),
      T({ name: 'web_search', arguments: { query: 'q3' } }),
      T({ name: 'web_search', arguments: { query: 'q4' } }),
      T({ name: 'task_plan', arguments: { doing: 2 } }),                                  // 3 次工具 0 打勾 → 空转提醒
      T({ name: 'task_plan', arguments: { items: ['下载壁纸', '保存文件'], doing: 1 } }), // 重发相同清单零打勾 → 重发提醒
      T({ name: 'task_plan', arguments: { done: [1, 2] } }),
      '最终汇报！'
    ], events, executeLog)
    const r = await agent.sendUserMessage('下载壁纸')
    check('打卡护栏场景任务正常结束', r.success === true)
    const tpResults = agent.history.filter((m) => m.role === 'user' && /<tool_result name="task_plan"/.test(m.content))
    check('3 次工具 0 打勾 → 空转提醒', tpResults.some((m) => m.content.includes('没有勾掉任何项')))
    check('重发相同清单零打勾 → 重发提醒', tpResults.some((m) => m.content.includes('重发了和当前完全相同的清单')))
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('最终 2/2 全部完成', last && last.done === 2 && last.total === 2)
  }

  // 场景 7：报到循环分级（真机变体：模型每轮带相同 task_plan"报到"+同轮照常 web_fetch 干活 → 温和提示不打断；
  // 单独纯重发相同清单不干活 → 维持硬拒绝）
  {
    const events = []
    const executeLog = []
    const mixed = '好的。\n```tool\n' + JSON.stringify({ name: 'task_plan', arguments: { doing: 1 } }) + '\n```\n```tool\n' + JSON.stringify({ name: 'web_search', arguments: { query: '重庆天气' } }) + '\n```'
    const agent = makeAgent([
      T({ name: 'task_plan', arguments: { items: ['查天气', '写word'], doing: 1 } }),
      mixed,                                                      // 同轮：重复清单(软通过) + web_search(照常执行)
      T({ name: 'task_plan', arguments: { doing: 1 } }),          // 单独纯重发 → 原地打转硬拒绝
      T({ name: 'task_plan', arguments: { done: 1, doing: 2 } }),
      T({ name: 'task_plan', arguments: { done: [1, 2] } }),
      '汇报完成！'
    ], events, executeLog)
    const r = await agent.sendUserMessage('查重庆天气写进word')
    check('报到分级场景任务正常结束', r.success === true)
    const tpResults = agent.history.filter((m) => m.role === 'user' && /<tool_result name="task_plan"/.test(m.content))
    check('同轮有真工具 → 重复清单软通过(ok=true 提示勿重发)', tpResults.some((m) => m.content.includes('重复上报') && m.content.includes('ok="true"')))
    check('同轮真工具照常执行', executeLog.some((x) => x.name === 'web_search'))
    const spinning = agent.history.filter((m) => m.role === 'user' && m.content.includes('原地打转'))
    check('单独纯重发 → 维持原地打转硬拒绝', spinning.length === 1)
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('最终 2/2 全部完成', last && last.done === 2 && last.total === 2)
  }

  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
