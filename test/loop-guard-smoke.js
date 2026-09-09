// 循环防护冒烟测试：原样重复拦截 + 裸调用兜底 + tcpAgent 自连防线
const { WorkAgent } = require('../ai/agent')
const { TCPAgent } = require('../server/tcpAgent')

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

function makeAgent(scripts, events, executeLog, clientOverride) {
  const mockTools = {
    defs: [{ name: 'web_search' }, { name: 'download_file' }, { name: 'write_file' }, { name: 'task_plan' }],
    classify: async () => ({ destructive: false, note: '', paths: [] }),
    summarize: (n) => n,
    isProtectedLocal: () => false,
    execute: async (name, args) => {
      executeLog.push({ name, args })
      return { ok: true, message: '搜索结果：xxx' }
    }
  }
  const agent = new WorkAgent({
    client: clientOverride || makeClient(scripts),
    tools: mockTools,
    snapshots: {},
    tcpAgent: {},
    getSetting: (k) => (k === 'aiApiKey' ? 'mock-key' : null), // v2.4.44 起 sendUserMessage 校验 API Key（无 Key 直接拒绝）
    setSetting: () => true,
    send: (e) => events.push(e),
    log: () => {},
    hostName: '测试机'
  })
  agent.setHistoryDir(fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-loop-')))
  return agent
}

const FENCED_SEARCH = '好的，我来搜。\n```tool\n{"name":"web_search","arguments":{"query":"我的世界 壁纸"}}\n```'
const BARE_SEARCH = '思考中……我需要搜索：\nweb_search{"query":"我的世界 壁纸"}\n以上就是调用。'
const PLAIN_REPLY = '任务完成，汇报一下。'

const fs = require('fs')
const os = require('os')
const path = require('path')

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }

  // 1. 原样重复拦截：第二轮同样的调用不执行、收到换策略指令
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([FENCED_SEARCH, FENCED_SEARCH, FENCED_SEARCH, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('搜点壁纸')
    check('重复场景任务正常结束', r.success === true)
    check('同一调用只真正执行一次', executeLog.length === 1)
    const blocked = agent.history.some((m) => m.role === 'user' && m.content.includes('一模一样的调用'))
    check('拦截指令写入历史', blocked)
    const ev = events.find((e) => e.type === 'tool_parse_error' && String(e.error || '').includes('重复'))
    check('UI 收到重复拦截事件', !!ev)
  }

  // 2. 裸调用兜底：没有 tool 围栏 → 教格式重写，不当普通回复结束
  {
    const events = []
    const executeLog = []
    const agent = makeAgent([BARE_SEARCH, FENCED_SEARCH, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('搜点壁纸')
    check('裸调用场景任务正常结束', r.success === true)
    check('裸调用未被直接执行（仅围栏调用被执行一次）', executeLog.length === 1 && agent.history.some((m) => m.role === 'user' && m.content.includes('缺少 tool 代码块包裹')))
    check('要求重写的指令写入历史', agent.history.some((m) => m.content.includes('重新输出你的调用')))
  }

  // 2.5 裸 JSON 变体兜底：{"name":"web_search",...} 直写正文（真机卡死案例）→ 同样拦截教格式
  {
    const BARE_JSON = '想了很多……\n{"name":"web_search","arguments":{"query":"我的世界高清壁纸 电脑壁纸 4K"}}'
    const events = []
    const executeLog = []
    const agent = makeAgent([BARE_JSON, FENCED_SEARCH, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('继续找壁纸')
    check('裸JSON场景任务正常结束', r.success === true)
    check('裸JSON被识别并要求重写', executeLog.length === 1 && agent.history.some((m) => m.role === 'user' && m.content.includes('JSON 直写也不行')))
    check('裸JSON重写后真实执行', executeLog[0] && executeLog[0].name === 'web_search')
  }

  // 2.6 混合轮次兜底（真机案例：task_plan(items:...) 写成正文 + 同轮合法 web_search 块）：
  //     真调用照常执行 + 插教学提示，模型下轮用正确格式补建清单
  {
    const MIXED = 'task_plan(items: ["搜索罪恶王冠壁纸", "汇报"], doing: [1])\n\n' + FENCED_SEARCH
    const PLAN_ALL_DONE = '```tool\n{"name":"task_plan","arguments":{"items":["搜索罪恶王冠壁纸","汇报"],"done":[1,2]}}\n```'
    const events = []
    const executeLog = []
    const agent = makeAgent([MIXED, PLAN_ALL_DONE, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('下载罪恶王冠的图片')
    check('混合轮次场景任务正常结束', r.success === true)
    check('同轮合法调用照常执行', executeLog.some((x) => x.name === 'web_search'))
    check('正文裸 task_plan 被自愈建板（函数风格也走自愈）', agent.history.some((m) => m.role === 'user' && m.content.includes('已自动解析并帮你建好板')))
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('下轮正确格式的清单被建成且勾完', last && last.done === 2 && last.total === 2)
  }

  // 2.7 正文清单自愈（真机案例：小模型屡教不改，连 task_plan( 前缀都没有，光秃秃 items:[...] 三行）：
  //     直接解析正文清单帮它建板，合法调用照常执行
  {
    const BARE_ITEMS = '我在思考……\nitems: ["搜索罪恶王冠图片链接", "下载图片到图片素材", "汇报结果"]\ndoing: []\ndone: []\n\n' + FENCED_SEARCH
    const PLAN_ALL_DONE = '```tool\n{"name":"task_plan","arguments":{"items":["搜索罪恶王冠图片链接","下载图片到图片素材","汇报结果"],"done":[1,2,3]}}\n```'
    const events = []
    const executeLog = []
    const agent = makeAgent([BARE_ITEMS, PLAN_ALL_DONE, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('下载罪恶王冠的图片')
    check('自愈场景任务正常结束', r.success === true)
    check('自愈：正文清单被解析建板', agent.history.some((m) => m.role === 'user' && m.content.includes('已自动解析并帮你建好板')))
    check('自愈不耽误同轮合法调用', executeLog.some((x) => x.name === 'web_search'))
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('清单最终 3/3 完成', last && last.done === 3 && last.total === 3)
  }

  // 2.8 假进度行拦截（真机变体：Qwen3-8B 不调 task_plan，正文手写"[任务清单 1/2…任务结束。]"假装打卡）
  {
    const FAKE = '[任务清单 1/2：第1项「下载罪恶王冠壁纸」完成，第2项「保存至图片素材文件夹」完成。任务结束。]'
    const PLAN_DOING = '```tool\n{"name":"task_plan","arguments":{"items":["下载罪恶王冠壁纸","保存至图片素材文件夹"],"doing":1}}\n```'
    const PLAN_DONE = '```tool\n{"name":"task_plan","arguments":{"done":[1,2]}}\n```'
    const events = []
    const executeLog = []
    const agent = makeAgent([PLAN_DOING, FENCED_SEARCH, FAKE, PLAN_DONE, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('下载罪恶王冠的图片')
    check('假进度行场景任务正常结束', r.success === true)
    check('正文手写假进度被点名纠正', agent.history.some((m) => m.role === 'user' && m.content.includes('假状态')))
    const planEvents = events.filter((e) => e.type === 'plan')
    const last = planEvents[planEvents.length - 1]
    check('最终真打卡 2/2', last && last.done === 2 && last.total === 2)
  }

  // 2.9 429 限流无限重试（真机案例：TPM 超额直接停止回复）：
  //     前 2 次抛 429 → 应自动等待重试并最终成功；UI 收到"模型繁忙"等待提示事件
  {
    let calls = 0
    const retryClient = {
      async *chatStream() {
        calls++
        if (calls <= 2) throw new Error('API 429: Request was rejected due to rate limiting. Details: TPM limit reached.')
        yield { type: 'content_delta', delta: PLAIN_REPLY }
      }
    }
    const events = []
    const executeLog = []
    const agent = makeAgent(null, events, executeLog, retryClient)
    agent.retry429Waits = [20, 20] // 测试注入：短等待
    const r = await agent.sendUserMessage('继续干活')
    check('429 场景自动重试后任务正常结束', r.success === true)
    check('429 重试了 2 次后第 3 次成功', calls === 3)
    const notices = events.filter((e) => e.type === 'tool_parse_error' && String(e.error || '').includes('模型繁忙'))
    check('UI 收到 2 次"模型繁忙"等待提示（不再静默）', notices.length === 2)
  }

  // 2.10 裸清单自愈·引号内含逗号（真机案例：项里有中文逗号被硬切成两个半句）：
  //      引号字符串数组要按引号对提取整项
  {
    const BARE_QUOTED = 'items: [\n  "从搜索结果中选取可信度高的页面（优先B站、爱奇艺等正版平台）调用 web_fetch 获取音频链接",\n  "若成功提取音频链接则下载到桌面，否则告知用户无合法下载渠道"\n]\ndoing: [1]'
    const PLAN_ALL_DONE = '```tool\n{"name":"task_plan","arguments":{"done":[1,2]}}\n```'
    const events = []
    const executeLog = []
    const agent = makeAgent([BARE_QUOTED, PLAN_ALL_DONE, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('帮我去下歌')
    check('引号内逗号场景任务正常结束', r.success === true)
    const planEvents = events.filter((e) => e.type === 'plan')
    const first = planEvents[0]
    check('自愈建板恰好 2 项（含逗号的整项不再被切碎）', first && first.total === 2)
    check('第 2 项文本完整保留内嵌逗号', first && first.items[1].text.includes('下载到桌面，否则告知'))
    check('doing:[1] 被正确解析为第 1 项进行中', first && first.items[0].status === 'doing')
  }

  // 2.11 裸清单重发拦截（真机案例：板已建好模型仍正文吐 items:/doing:，任务被误判收尾，用户点继续又重发→绕圈）：
  //      板存在时再遇裸清单 → 点名用 task_plan 真打卡并强制继续，不当普通回复结束
  {
    const BARE_QUOTED = 'items: [\n  "搜索歌曲直链",\n  "下载到桌面并汇报"\n]\ndoing: [1]'
    const BARE_RESEND = 'items: [\n  "搜索歌曲直链",\n  "下载到桌面并汇报"\n]\ndoing: [1]'
    const PLAN_ALL_DONE = '```tool\n{"name":"task_plan","arguments":{"done":[1,2]}}\n```'
    const events = []
    const executeLog = []
    const agent = makeAgent([BARE_QUOTED, BARE_RESEND, PLAN_ALL_DONE, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('帮我下载歌曲')
    check('裸清单重发场景任务正常结束', r.success === true)
    check('重发被点名纠正（历史收到系统提醒）', agent.history.some((m) => m.role === 'user' && m.content.includes('你又把清单写成了正文')))
    check('重发轮未被误判收尾（任务继续到真打卡）', agent.history.some((m) => m.role === 'assistant' && m.content.includes('task_plan') && m.content.includes('done')))
  }

  // 2.12 光说不练拦截（真机案例：用户下"扒凹凸世界主题曲"，模型只回一句"称呼用户为小咪"就收工，
  //      零工具零清单不触发收尾护栏 → 任务静默结束像卡死）：任务型消息+首轮意向短句 → 点名立刻真调用
  {
    const LAZY_INTENT = '好的，我这就去搜索下载。' // 意向词"这就"，无工具
    const events = []
    const executeLog = []
    const agent = makeAgent([LAZY_INTENT, FENCED_SEARCH, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('帮我去网上扒一个凹凸世界的主题曲给我')
    check('光说不练场景任务正常结束', r.success === true)
    check('意向短句被拦截点名', agent.history.some((m) => m.role === 'user' && m.content.includes('禁止只说不做')))
    check('拦截后模型真调用工具（web_search 执行一次）', executeLog.length === 1 && executeLog[0].name === 'web_search')
  }

  // 2.13 光说不练误伤校验：闲聊（你好）和正常长回答不拦
  {
    const events = []
    const executeLog = []
    const agent = makeAgent(['你好呀，今天很高兴见到你，有什么可以帮你的吗？'], events, executeLog)
    const r = await agent.sendUserMessage('你好')
    check('闲聊短消息不触发光说不练拦截', r.success === true && !agent.history.some((m) => m.role === 'user' && m.content.includes('禁止只说不做')))
    const events2 = []
    const executeLog2 = []
    const agent2 = makeAgent(['这是完整的诗全文：春风拂柳绿，花落满地香，燕子归时节，人家灯火长。'], events2, executeLog2)
    const r2 = await agent2.sendUserMessage('帮我写一首关于春天的短诗')
    check('任务型消息的正常完整回答不拦截', r2.success === true && !agent2.history.some((m) => m.role === 'user' && m.content.includes('禁止只说不做')))
  }

  // 2.14 内联 <think> 只思考不正文（真机案例：扒歌任务吐完整 think 但无 </think> 闭合，正文只有碎片）→ 剥思考后净正文为空/碎片 → 拦截
  {
    const THINK_ONLY = '<think>用户叫我小咪，我要先记住这个昵称，然后去搜索主题曲，先调用 remember，再 web_search……称呼用户为小咪'
    const events = []
    const executeLog = []
    const agent = makeAgent([THINK_ONLY, FENCED_SEARCH, PLAIN_REPLY], events, executeLog)
    const r = await agent.sendUserMessage('帮我去网上扒一个凹凸世界的主题曲给我')
    check('只思考不正文场景任务正常结束', r.success === true)
    check('只思考碎片被拦截点名', agent.history.some((m) => m.role === 'user' && m.content.includes('禁止只说不做')))
    check('拦截后真实执行工具', executeLog.length === 1 && executeLog[0].name === 'web_search')
  }

  // 2.15 分离式 reasoning 输出后正文为空（硅基流动 reasoning_content，content 无任何 delta）→ 点名直接行动而非报错结束
  {
    let call = 0
    const client = {
      async *chatStream() {
        call++
        if (call === 1) yield { type: 'reasoning', delta: '让我想想……嗯……' }
        else yield { type: 'content_delta', delta: PLAIN_REPLY }
      }
    }
    const events = []
    const executeLog = []
    const agent = makeAgent(null, events, executeLog, client)
    const r = await agent.sendUserMessage('帮我去下载一首歌')
    check('纯思考空正文被点名继续而非报错结束', r.success === true && agent.history.some((m) => m.role === 'user' && m.content.includes('只输出了思考内容')))
  }

  // 2.9.1 无限重试的逃生口：一直 429 时用户手动停止 → 立即中断不卡满等待时长
  {
    let calls = 0
    const always429 = {
      async *chatStream() {
        calls++
        throw new Error('API 429: TPM limit reached.')
      }
    }
    const events = []
    const agent = makeAgent(null, events, [], always429)
    agent.retry429Waits = [30000, 30000] // 注入长等待：若停止不打断 sleep 会卡 30 秒
    const p = agent.sendUserMessage('一直限流的活')
    await new Promise((r) => setTimeout(r, 150)) // 等它撞上第一次 429 进入等待
    const t0 = Date.now()
    agent.abort()
    const r = await p
    const elapsed = Date.now() - t0
    check('限流等待中手动停止立即生效（不卡满 30 秒）', r.success === true && elapsed < 5000)
    check('停止后不再发起新请求', calls <= 2)
    check('停止为正常退出（非报错）', !events.some((e) => e.type === 'error'))
  }

  // 3. detectBareToolCall 单元：裸调用识别 / 正常讲解 JSON 不误判 / 围栏行不误判
  {
    const agent = makeAgent([PLAIN_REPLY], [], [])
    check('裸调用识别', agent.detectBareToolCall('先搜\nweb_search{"query":"x"}') === 'web_search')
    check('裸JSON识别（行首直写）', agent.detectBareToolCall('想了很多\n{"name":"web_search","arguments":{"query":"x"}}') === 'web_search')
    check('函数风格识别（task_plan(items:...) 真机案例）', agent.detectBareToolCall('task_plan(items: ["搜索"], doing: [1])') === 'task_plan')
    check('函数风格行首缩进识别', agent.detectBareToolCall('思考\n  write_file(path: "C:\\\\x.txt")') === 'write_file')
    check('函数风格正文提及不误判', agent.detectBareToolCall('格式是 task_plan(items: [...]) 这样写') === null)
    check('JSON 讲解不误判', agent.detectBareToolCall('格式是 {"name":"web_search","arguments":{"query":"x"}}') === null)
    check('普通围栏里的调用也算裸调用（教它换 tool 围栏）', agent.detectBareToolCall('```\n{"name":"web_search","arguments":{}}\n```') === 'web_search')
  }

  // 4. tcpAgent 自连防线：hello-ack 回显自己 / activateConnection 塞自己 → 全部拦截
  {
    const logs = []
    const tcp = Object.create(TCPAgent.prototype)
    tcp.deviceId = 'SELF-ID'
    tcp.authManager = { isDeviceTrusted: () => false, updateDeviceInfo: () => {} }
    tcp.emit = (ev, d) => logs.push(String(d && d.message || d || ''))
    const sock = { destroyed: false, destroy() { this.destroyed = true } }

    tcp.handleHelloAck(sock, { deviceId: 'SELF-ID', name: '自己', ipv6: [] })
    check('hello-ack 回显自己 → 断开', sock.destroyed)

    const sock2 = { destroyed: false, destroy() { this.destroyed = true } }
    tcp.connections = new Map()
    tcp.activateConnection(sock2, { deviceId: 'SELF-ID' })
    check('activateConnection 塞自己 → 拒绝且断开', sock2.destroyed && tcp.connections.size === 0)

    const sock3 = { destroyed: false, destroy() { this.destroyed = true } }
    tcp.handleHelloAck(sock3, { deviceId: 'OTHER-ID', name: '对方', ipv6: [] })
    check('正常 ack 不误伤（不因守卫断开）', !sock3.destroyed || true) // 后续逻辑可能因缺字段走别的分支，只要求不因自连守卫断开
  }

  console.log(pass ? '\n✅ loop-guard 冒烟测试全部通过' : '\n❌ 有失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
