// ============================================
// MSWork Agent：会话循环 + 工具调用调度 + 审批控制 + 检查点回滚
// 协议：AI 输出 ```tool {"name":"...","arguments":{...}}``` 文本块
// 默认不含 API Key：用户在设置里填自己的 Key，存 settings.json
// ============================================
const fs = require('fs')
const path = require('path')
const { assembleSystemPrompt, assembleWebRulesDoc } = require('./prompt')

const MAX_STEPS = 100                // 单轮工具调用次数上限（批量下图等大批量任务的余量；防空转靠原样重复护栏，这个只是烧 token 的急刹）
const MAX_PARALLEL = 4               // 并行执行上限（一个老大最多四个小的同时干活）
const CREATE_TOOLS = ['create_word', 'create_table', 'create_folder'] // 防重复护栏覆盖的创建类工具（write_file 是覆盖语义不拦）
const APPROVAL_TIMEOUT = 10 * 60 * 1000
const HISTORY_FILE = 'mswork_chat.json'
const HISTORY_KEEP = 80

// ===== 上下文压缩（v2.4.80，设置默认关）=====
const COMPACT_TRIGGER = 0.8          // 上下文估算达到上限的 80% 触发压缩（老大定值）
const COMPACT_KEEP_RECENT = 8        // 压缩时保留最近原文条数（当前任务的连续性靠它们）
const COMPACT_MIN_HISTORY = 16       // 历史少于此条数不压（可压内容太少，摘要得不偿失）
const COMPACT_CHARS_PER_TOKEN = 2.2  // token 粗估：中英混合 ≈ 2.2 字符/token（中文~1.5 英文~4，取保守中间值）
const COMPACT_TRANSCRIPT_CAP = 30000 // 喂给摘要模型的对话原文上限（字符）：摘要请求自身也不能爆上下文

// ===== 直连生图画幅解析（v2.4.83）：提示词 → 硅基流动 image_size（宽x高）=====
// 只认这 5 档（与硅基流动支持尺寸对齐）；非常规比例取 log 差最小的近似档
const IMG_RATIO_SIZES = [
  { r: 16 / 9, size: '1280x720' },
  { r: 9 / 16, size: '720x1280' },
  { r: 4 / 3, size: '1024x768' },
  { r: 3 / 4, size: '768x1024' },
  { r: 1, size: '1024x1024' }
]
function parseImgRatioSize(text) {
  const t = String(text || '')
  const m = t.match(/(\d{1,2})\s*[:：比]\s*(\d{1,2})/) // "16:9" "16：9" "16比9"（排除时间/分数误伤：比例上限 1:3 内近似）
  if (m) {
    const w = parseInt(m[1])
    const h = parseInt(m[2])
    if (w > 0 && h > 0 && Math.max(w, h) / Math.min(w, h) <= 3.2) {
      const r = w / h
      let best = IMG_RATIO_SIZES[0]
      for (const it of IMG_RATIO_SIZES) {
        if (Math.abs(Math.log(it.r / r)) < Math.abs(Math.log(best.r / r))) best = it
      }
      return best.size
    }
  }
  if (/手机壁纸|手机屏|竖屏|竖图|竖版/.test(t)) return '720x1280'
  if (/横屏|横图|横版|宽屏|壁纸/.test(t)) return '1280x720'
  if (/头像|方图|方形|正方形/.test(t)) return '1024x1024'
  return null
}

// 直连生图张数解析（v2.4.85）：用户提示词里说"生成4张/来两张/四张壁纸"→张数（1-4），没提=null。
// batch_size 接口上限 4，超了钳到 4；仅文生图生效（编辑模型固定 1 张）
const BATCH_CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 4, 六: 4, 七: 4, 八: 4, 九: 4, 十: 4 }
function parseImgBatchCount(text) {
  const t = String(text || '')
  let n = null
  const mDigit = /(\d{1,2})\s*张/.exec(t)
  if (mDigit) n = parseInt(mDigit[1], 10)
  else {
    const mCn = /([一两二三四五六七八九十])\s*张/.exec(t)
    if (mCn) n = BATCH_CN_NUM[mCn[1]]
  }
  if (n == null || n <= 0) return null
  return Math.min(4, Math.max(1, n))
}

const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B'

// 工具轮尾部精简格式提醒：每轮拼在发给网页端的增量尾部（不进本地 history，网页端每轮可见）。
// 只在用户消息轮带规则附件的话，长任务几十个工具轮后规则被上下文稀释 → tool 块格式漂移
// （正文写调用/arguments 双重编码/URL 带反引号），精简提醒每轮 ~200 字防漂移
const WEB_TURN_REMINDER = [
  '【格式提醒（每轮附带，务必遵守）】',
  '1. 工具调用必须用 tool 代码块：三个反引号 + tool 换行 + {"name":"工具名","arguments":{…}} 换行 + 三个反引号；arguments 必须是 JSON 对象，不能写成字符串。',
  '2. 一轮可以并行输出多个 tool 代码块；URL 直接写原文，不要包反引号或行内代码。',
  '3. 任务进度用 task_plan 工具传 doing/done 序号打勾，不要用正文清单代替。',
  '4. 严禁使用网页平台自带的函数调用/插件功能（页面出现工具调用卡片=走错通道，会话会卡死）；发起工具的唯一方式是正文里的 tool 代码块。'
].join('\n')

// 创建防重键：目录 + 去掉数字/“新/副本/copy”等尾缀后的文件名（用于拦截“换名字重复创建”）
function createKey(p) {
  const norm = String(p).toLowerCase().replace(/\//g, '\\')
  const name = norm.split('\\').pop() || ''
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[\s\-_]*(\d+|新|副本|copy|new|final|最终)+$/i, '').trim()
  const dir = norm.slice(0, norm.length - name.length)
  return dir + base + ext
}

// ask_user 回答格式化：把用户的选项/补充文本整理成 AI 好读的清单
function formatAskAnswers(args, res) {
  const qs = (args && Array.isArray(args.questions)) ? args.questions : []
  const lines = qs.map((q, i) => {
    const a = (res.answers && res.answers[i]) || {}
    const picked = []
    if (Array.isArray(a.selected)) picked.push(...a.selected.map(String))
    if (a.other) picked.push(`其他：${a.other}`)
    return `${i + 1}. ${String((q && q.question) || '').slice(0, 80)} → ${picked.length ? picked.join('；') : '（未作选择）'}`
  })
  return lines.join('\n')
}

// ===== 模型来源路由：模型名可带 [平台] 前缀，避免不同平台同名模型混淆 =====
// "[官方]deepseek-chat" → DeepSeek 官方档案；"[硅基流动]deepseek-ai/DeepSeek-V3" → 硅基流动档案；
// "[内置]deepseek-ai/DeepSeek-V4-Flash" → MSMate 内置（走服务端代理扣积分）；
// "[网页]DeepSeek" → 工作台内嵌网页版引擎；无前缀 → 沿用当前全局服务商（兼容旧配置）
const MODEL_ROUTE_RE = /^\[(官方|硅基流动|智谱|自定义|内置|网页)\]\s*/
const TAG_TO_PROVIDER = { '官方': 'deepseek', '硅基流动': 'siliconflow', '智谱': 'zhipu', '自定义': 'custom', '内置': 'msmate', '网页': 'web' }
function parseModelRoute(model) {
  const raw = String(model || '').trim()
  const m = MODEL_ROUTE_RE.exec(raw)
  if (!m) return { tag: null, provider: null, model: raw, isWeb: false }
  const tag = m[1]
  return { tag, provider: TAG_TO_PROVIDER[tag] || null, model: raw.slice(m[0].length).trim(), isWeb: tag === '网页' }
}

// ===== 网页端内容兜底清洗（DeepSeek DOM 改版时页面侧重建失效的保险） =====
// 从 text[start]（'{'）做括号配对提取完整 JSON（跳过字符串字面量，防嵌套 } 截断）
function extractJsonAt(text, start) {
  if (text[start] !== '{') return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const cand = text.slice(start, i + 1)
        try { JSON.parse(cand); return cand } catch { return null }
      }
    }
  }
  return null
}

// <tool_call> 标签的函数调用风格参数解析（Qwen/GLM/Kimi 系漂移形态）：
// "path=\"...\", target=\"local\", items=[\"a\",\"b\"], doing=1" → 括号/字符串感知切分，防值内逗号误切
function parseToolCallArgs(s) {
  const args = {}
  const parts = []
  let depth = 0, inStr = false, esc = false, start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const key = part.slice(0, eq).trim()
    let val = part.slice(eq + 1).trim()
    if (!key) continue
    if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val)
    else if (val === 'true') val = true
    else if (val === 'false') val = false
    else if (/^[[{]/.test(val)) { try { val = JSON.parse(val) } catch {} }
    else if (/^"[\s\S]*"$/.test(val)) { try { val = JSON.parse(val) } catch { val = val.slice(1, -1) } }
    args[key] = val
  }
  return args
}

// 无围栏形态（innerText 漏网）："tool\n复制\n下载\n{...}" → 重建 ```tool 围栏。
// 已带任何 ``` 围栏时信任页面侧重建结果，不再动（防重复清洗）。
function rebuildWebToolFences(content) {
  let text = String(content || '')
  if (text.includes('```')) return text
  let out = ''
  const HEAD = /(^|\n)[ \t]*tool[ \t]*(?=\n|$)/
  let guard = 0
  while (guard++ < 50) {
    const m = HEAD.exec(text)
    if (!m) { out += text; break }
    out += text.slice(0, m.index)
    // 前瞻 (?=\n) 不消费换行：先吃掉 tool 行尾换行，否则按钮行/JSON 匹配不上（真机踩坑）
    let rest = text.slice(m.index + m[0].length).replace(/^\r?\n/, '')
    // 剥按钮行（复制/下载，改版兜底）
    let bm
    while ((bm = /^[ \t]*(?:复制|下载|复制代码|下载代码|展开|收起)[^\n]*\n/.exec(rest))) rest = rest.slice(bm[0].length)
    if (rest.startsWith('{')) {
      const json = extractJsonAt(rest, 0)
      if (json) {
        out += '\n```tool\n' + json + '\n```'
        text = rest.slice(json.length)
        continue
      }
    }
    // tool 行后不是 JSON（正文巧合）→ 原样保留，继续向后找
    out += m[0] + '\n'
    text = rest
  }
  return out
}

class WorkAgent {
  constructor({ client, tools, snapshots, tcpAgent, getSetting, setSetting, send, log, hostName, desktopDir, workspaceDir, isChild, webChatAsk, onFileChanged }) {
    this.client = client
    this.tools = tools
    this.snapshots = snapshots
    this.tcpAgent = tcpAgent
    this.getSetting = getSetting
    this.setSetting = setSetting
    this.send = send || (() => {})
    this.log = log || (() => {})
    this.onFileChanged = onFileChanged || null // 回滚落盘后通知渲染层刷新工作台（与工具执行链路同通道）
    this.hostName = hostName || '本机'
    this.desktopDir = desktopDir || ''
    this.workspaceDir = workspaceDir || ''   // AI 工作台（助理专属文件区）
    this.isChild = !!isChild    // 子Agent不允许再委派，防止递归
    this.childAgents = []       // 运行中的子Agent，父 abort 时联动终止
    this.history = []          // [{role, content, time}]
    this.checkpoints = []      // [{msgIndex, undos:[撤销记录]}] 每条用户消息 = 一个检查点
    this.running = false
    this.aborted = false
    this.abortController = null
    this.pendingApprovals = new Map() // approvalId -> { resolve, timer }
    this.pendingAsks = new Map()      // askId(callId) -> { resolve, timer } 中途向用户提问
    this.historyDir = null
    this.webChatAsk = webChatAsk || null   // 网页版模型桥：请求渲染层工作台内嵌网页引擎自动对话
    this._webMode = false                  // 本次任务是否网页模式（模型回复来自内嵌网页，工具循环与 API 模式一致）
    this._webChatResolve = null            // 网页对话等待中的 Promise resolve
    this._webChatBuf = ''                  // 网页对话流式增量累积
    this._webConvUrl = ''                  // 网页端对话 URL（/a/chat/s/<uuid>）：随会话持久化，重启后可回到原网页对话（真机：重启后网页端不记得对话）
    this._webConvStarted = false           // 本进程内已开过网页对话（首次发消息后置位）
  }

  // ===== 审批模式（三档）=====
  // unlimited（无限制）是会话级档位：运行期写进 settings 让 UI 状态一致，
  // 但读到即回落 auto 并修正存档——重启应用防线自动复位，防止上一次挂机忘了切回来
  normalApprovalMode() {
    const m = this.getSetting('aiApprovalMode') || 'manual'
    if (m === 'unlimited') { this.setSetting('aiApprovalMode', 'auto'); return 'auto' }
    return m
  }

  // ===== 配置 =====
  // apiKey 对外只返回打码版本，避免泄露
  getConfig() {
    const key = this.getSetting('aiApiKey') || ''
    let memory = []
    try { memory = JSON.parse(this.getSetting('aiMemory') || '[]') } catch {}
    // 多平台 Key 档案（key 打码）：{ deepseek:{baseUrl,hasKey,apiKeyMasked}, ... }
    const profiles = {}
    try {
      const raw = JSON.parse(this.getSetting('aiProfiles') || '{}') || {}
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue
        profiles[k] = { baseUrl: v.baseUrl || '', hasKey: !!v.apiKey, apiKeyMasked: v.apiKey ? maskKey(v.apiKey) : '' }
      }
    } catch {}
    return {
      provider: this.getSetting('aiProvider') || 'siliconflow',
      baseUrl: this.getSetting('aiBaseUrl') || 'https://api.siliconflow.cn/v1',
      hasKey: !!key,
      apiKeyMasked: key ? maskKey(key) : '',
      profiles,
      model: this.getSetting('aiModel') || DEFAULT_MODEL,
      visionModel: this.getSetting('aiVisionModel') || '',
      voiceModel: this.getSetting('aiVoiceModel') || '',
      imageModel: this.getSetting('aiImageModel') || '',
      imageEditModel: this.getSetting('aiImageEditModel') || '',
      videoModel: this.getSetting('aiVideoModel') || '',
      compactEnabled: (this.getSetting('aiCompactEnabled') || '0') === '1',
      contextLimit: this.contextLimitFor(this.getSetting('aiModel')),
      approvalMode: this.normalApprovalMode(),
      rules: this.getSetting('aiRules') || [],
      memory
    }
  }

  setConfig(cfg) {
    if (!cfg) return false
    if (cfg.provider) {
      this.setSetting('aiProvider', String(cfg.provider))
      // 当前服务商的 baseUrl/Key 同步写进多平台档案（各平台 Key 并存，切换不丢）
      try {
        const profiles = JSON.parse(this.getSetting('aiProfiles') || '{}') || {}
        const p = (profiles[cfg.provider] && typeof profiles[cfg.provider] === 'object') ? profiles[cfg.provider] : {}
        if (cfg.baseUrl !== undefined && String(cfg.baseUrl).trim()) p.baseUrl = String(cfg.baseUrl).trim()
        if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim() && !cfg.apiKey.includes('****')) p.apiKey = cfg.apiKey.trim()
        profiles[cfg.provider] = p
        this.setSetting('aiProfiles', JSON.stringify(profiles))
      } catch {}
    }
    if (cfg.baseUrl !== undefined && String(cfg.baseUrl).trim()) this.setSetting('aiBaseUrl', String(cfg.baseUrl).trim())
    // 只有传了非空新 Key 才覆盖，避免打码值回写
    if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim() && !cfg.apiKey.includes('****')) {
      this.setSetting('aiApiKey', cfg.apiKey.trim())
    }
    if (typeof cfg.model === 'string' && cfg.model.trim()) this.setSetting('aiModel', cfg.model.trim())
    // 识图模型：允许清空（回退默认免费模型）
    if (typeof cfg.visionModel === 'string') this.setSetting('aiVisionModel', cfg.visionModel.trim())
    // 语音模型：允许清空（回退默认 SenseVoiceSmall）
    if (typeof cfg.voiceModel === 'string') this.setSetting('aiVoiceModel', cfg.voiceModel.trim())
    // 生图/图片编辑/视频模型：允许清空（编辑模型空=改图回退普通生图并提示）
    if (typeof cfg.imageModel === 'string') this.setSetting('aiImageModel', cfg.imageModel.trim())
    if (typeof cfg.imageEditModel === 'string') this.setSetting('aiImageEditModel', cfg.imageEditModel.trim())
    if (typeof cfg.videoModel === 'string') this.setSetting('aiVideoModel', cfg.videoModel.trim())
    // 上下文压缩：开关默认关；上限按模型单独保存（v2.4.81：不同模型上下文容量不一样），
    // 没设过专属上限的模型回落全局旧值/默认 65536；传空值 = 清除该模型专属设置回默认
    if (cfg.compactEnabled !== undefined) this.setSetting('aiCompactEnabled', cfg.compactEnabled ? '1' : '0')
    if (cfg.contextLimit !== undefined) {
      const n = parseInt(cfg.contextLimit)
      const key = String(cfg.model || this.getSetting('aiModel') || '').trim()
      let limits = {}
      try { limits = JSON.parse(this.getSetting('aiContextLimits') || '{}') || {} } catch {}
      if (!limits || typeof limits !== 'object' || Array.isArray(limits)) limits = {}
      if (key) {
        if (n > 0) limits[key] = n
        else delete limits[key]
        this.setSetting('aiContextLimits', JSON.stringify(limits))
      } else if (n > 0) {
        this.setSetting('aiContextLimit', String(n)) // 拿不到模型名时退化为全局（兼容旧路径）
      }
    }
    if (cfg.approvalMode === 'manual' || cfg.approvalMode === 'auto' || cfg.approvalMode === 'unlimited') this.setSetting('aiApprovalMode', cfg.approvalMode)
    if (Array.isArray(cfg.rules)) {
      const rules = cfg.rules.map((r) => String(r).trim().slice(0, 500)).filter(Boolean).slice(0, 50)
      this.setSetting('aiRules', rules)
    }
    // 用户可在设置里手动管理记忆（删除/清空）
    if (Array.isArray(cfg.memory)) {
      const memory = cfg.memory
        .filter((m) => m && typeof m.fact === 'string' && m.fact.trim())
        .map((m) => ({ fact: m.fact.trim().slice(0, 300), time: m.time || Date.now() }))
        .slice(0, 200)
      this.setSetting('aiMemory', JSON.stringify(memory))
    }
    return true
  }

  // ===== 历史持久化（含检查点）=====
  setHistoryDir(dir) {
    this.historyDir = dir
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, HISTORY_FILE), 'utf8')) || {}
      this.history = data.messages || []
      this.checkpoints = data.checkpoints || []
      // 网页对话 URL 恢复：重启后首次网页轮直接导航回原对话（不再丢上下文开新会话）
      this._webConvUrl = String(data.webConvUrl || '')
      this._webConvStarted = !!this._webConvUrl
    } catch {
      this.history = []
      this.checkpoints = []
    }
  }

  saveHistory() {
    if (!this.historyDir) return
    try {
      if (this.history.length > HISTORY_KEEP) {
        // 裁剪最旧的（按检查点边界裁，保证 msgIndex 连续）
        let cut = this.history.length - HISTORY_KEEP
        const keptCheckpoints = this.checkpoints.filter((c) => c.msgIndex >= cut)
        this.history = this.history.slice(cut)
        this.checkpoints = keptCheckpoints.map((c) => ({ ...c, msgIndex: c.msgIndex - cut }))
      }
      fs.mkdirSync(this.historyDir, { recursive: true }) // 会话子目录可能不存在（新建会话还没写过盘）
      fs.writeFileSync(path.join(this.historyDir, HISTORY_FILE), JSON.stringify({
        messages: this.history,
        checkpoints: this.checkpoints,
        webConvUrl: this._webConvUrl || ''
      }))
    } catch (err) {
      this.log(`会话历史保存失败: ${err.message}`)
    }
  }

  getHistory() {
    return this.history
  }

  clearChat() {
    this.history = []
    this.checkpoints = []
    this._webConvUrl = ''      // 清空聊天 = 网页端也开新对话（旧网页对话不再续）
    this._webConvStarted = false
    this.saveHistory()
    this.send({ type: 'chat_cleared' })
    return true
  }

  // 网页端对话 URL 回传（渲染层引擎每轮完成后上报）：存内存，随 saveHistory 落盘。
  // 重启后 setHistoryDir 恢复 → 首次网页轮直接导航回原对话；多本地会话各自持有，切换会话自动切网页对话
  onWebChatConv(url) {
    const u = String(url || '')
    if (/chat\.deepseek\.com\/a\/chat\/s\//.test(u)) this._webConvUrl = u
  }

  // 设备速查（网页规则附件头部专用）：显眼列出 名称/备注/target 映射，DeepSeek 不用翻 48KB 规则也能认出备注
  buildDevicesBrief() {
    const devices = this.tcpAgent && this.tcpAgent.getConnectedDevices ? this.tcpAgent.getConnectedDevices() : []
    if (!devices.length) return '（当前无已连接的远程设备，工具 target 参数一律用 "local"）'
    let remarks = {}
    try { remarks = JSON.parse(this.getSetting('deviceRemarks') || '{}') || {} } catch {}
    return devices.map((d) => {
      const remark = remarks[d.deviceId] ? `，**用户备注"${remarks[d.deviceId]}"**` : ''
      return `- 设备名"${d.name}"${remark} → 工具 target 参数填: ${d.deviceId}（主机名 ${d.hostname}）`
    }).join('\n') + '\n用户消息里出现的设备名或用户备注，就是指上面对应的设备；不确定时用 ask_user 确认，不要凭空猜。'
  }

  // ===== 系统提示词 =====
  // ===== 大记事本智能检索（v2.4.97）=====
  // 长 NOTES.md 按"当前任务相关性"召回相关块（标题/空行分块 + query 2-gram 命中打分），
  // 替代旧"永远只看尾部 2500 字"（前面记录永远看不到）；短全文直出
  extractRelevantNotes(notes, query, limit = 2500) {
    const src = String(notes || '').trim()
    if (!src) return ''
    if (src.length <= limit) return src
    const lines = src.split('\n')
    const blocks = []
    let cur = []
    for (const ln of lines) {
      if (/^#{1,4}\s/.test(ln.trim()) && cur.length) { blocks.push(cur.join('\n')); cur = [ln] }
      else cur.push(ln)
    }
    if (cur.length) blocks.push(cur.join('\n'))
    const q = String(query || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ').trim()
    const grams = new Set()
    if (q) {
      for (const w of q.split(/\s+/)) {
        const lw = w.toLowerCase()
        if (w.length <= 3) { grams.add(lw); continue }
        grams.add(lw)
        for (let i = 0; i + 2 <= lw.length; i++) grams.add(lw.slice(i, i + 2))
      }
    }
    const scored = blocks.map((text, pos) => {
      let hit = 0
      const low = text.toLowerCase()
      for (const g of grams) if (low.includes(g)) hit++
      return { text, pos, hit }
    })
    scored.sort((a, b) => b.hit - a.hit || a.pos - b.pos)
    if (!scored[0] || scored[0].hit === 0) return '（更早的记录已截断，仅显示最近部分；完整内容在工作台 NOTES.md）\n' + src.slice(-limit)
    const picked = []
    let used = 0
    for (const s of scored) {
      if (used + s.text.length > limit) continue
      picked.push(s)
      used += s.text.length
      if (used >= limit) break
    }
    if (!picked.length) return '（更早的记录已截断，仅显示最近部分；完整内容在工作台 NOTES.md）\n' + src.slice(-limit)
    picked.sort((a, b) => a.pos - b.pos)
    return picked.map((s) => s.text).join('\n').slice(0, limit)
  }

  buildSystemPrompt() {
    // 提示词正文已抽离到 ai/prompt.js（分区维护）；这里只负责收集动态数据（设备/路径/规则/记忆/笔记/工具清单）
    const devices = this.tcpAgent && this.tcpAgent.getConnectedDevices ? this.tcpAgent.getConnectedDevices() : []
    let remarks = {}
    try { remarks = JSON.parse(this.getSetting('deviceRemarks') || '{}') || {} } catch {}
    const deviceLines = devices.length
      ? devices.map((d) => {
          const remark = remarks[d.deviceId] ? `，用户备注"${remarks[d.deviceId]}"` : ''
          return `  - 设备名"${d.name}"${remark}（target 填 deviceId: ${d.deviceId}，主机名 ${d.hostname}）`
        }).join('\n')
      : '  （当前无已连接的远程设备，target 一律用 "local"）'
    const localUserDir = path.dirname(this.desktopDir)
    const cfg = this.getConfig()
    // 小笔记本自动注入：本对话之前干过什么，接着干不用用户重复交代
    let sessionNotes = ''
    try {
      if (this.historyDir) {
        const notes = fs.readFileSync(path.join(this.historyDir, 'notes.md'), 'utf8').trim()
        if (notes) sessionNotes = notes.length > 2500 ? '（更早的记录已截断）\n' + notes.slice(-2500) : notes
      }
    } catch {}
    // 大记事本（workspace/NOTES.md 全局长期记忆）：短全文带上，长的按当前任务相关性召回相关块
    let bigNotes = ''
    try {
      if (this.workspaceDir) {
        const raw = fs.readFileSync(path.join(this.workspaceDir, 'NOTES.md'), 'utf8').trim()
        if (raw) {
          const lastUser = [...this.history].reverse().find((h) => h.role === 'user')
          bigNotes = this.extractRelevantNotes(raw, (lastUser && lastUser.content) || '', 2500)
        }
      }
    } catch {}
    return assembleSystemPrompt({
      hostName: this.hostName,
      isChild: this.isChild,
      desktopDir: this.desktopDir,
      localUserDir,
      workspaceDir: this.workspaceDir || '',
      manualsDir: this.workspaceDir ? path.join(this.workspaceDir, 'ai_manuals') : '',
      deviceLines,
      toolPromptSection: this.tools.toolPromptSection,
      rules: cfg.rules,
      memory: cfg.memory,
      bigNotes,
      sessionNotes
    })
  }

  // ===== 主流程 =====
  async sendUserMessage(text) {
    if (this.running) return { success: false, error: 'AI 正在执行任务，请先停止或等待完成' }
    if (!text || !String(text).trim()) return { success: false, error: '消息为空' }
    const cfg = this.getConfig()
    // 模型来源路由：[平台] 前缀 → 对应档案的 baseUrl/Key；无前缀 → 当前全局服务商（兼容旧配置）
    const route = parseModelRoute(cfg.model)
    let effCfg = cfg
    if (route.isWeb) {
      // 网页版模型：不需要 API Key，走工作台内嵌网页引擎
    } else {
      const prof = this.providerProfile(route.provider)
      if (!prof.apiKey) {
        const label = route.tag ? `「${route.tag}」平台` : 'AI 服务商'
        this.send({ type: 'error', message: `${label}的 API Key 未配置，请到 设置 → AI 设置 填写` })
        return { success: false, error: `${label}的 API Key 未配置` }
      }
      // 客户端参数随配置刷新（支持多服务商切换）
      this.client.apiKey = prof.apiKey
      this.client.baseUrl = prof.baseUrl || cfg.baseUrl
      effCfg = { ...cfg, model: route.model || cfg.model }
    }
    this.running = true
    this.aborted = false
    this.abortController = new AbortController()
    this.createdPaths = new Set() // 每轮重置防重复护栏
    this.planNudged = false       // 每轮重置"该建清单"系统提醒（只提醒一次）
    this.finishNudged = false     // 每轮重置"清单没勾完就想收尾"护栏（只拦一次，防死循环）
    this.lazyNudged = false       // 每轮重置"光说不练"护栏（只拦一次，防死循环）
    this.emptyNudged = false      // 每轮重置"只思考无正文"护栏（只拦一次，防死循环）
    // 用户拖入的文件引用 → 结构化标签，AI 可直接拿 target/path 调工具（无需再问路径）
    let msgText = String(text).trim()
    msgText = msgText.replace(/\[引用远程文件:\s*([^|\]]*)\|([^|\]]*)\|([^\]]+)\]/g, (m0, dname, devId, p) => `<file_ref target="${(devId || '').trim()}" path="${p.trim()}" />`)
    msgText = msgText.replace(/\[引用文件:\s*([^\]]+)\]/g, (m0, p) => `<file_ref target="local" path="${p.trim()}" />`)
    // 上下文压缩（默认关，仅本地 API 模式）：在用户消息入历史前执行——checkpoint/msgIndex 都在
    // 压缩后重取，天然不会错位；网页模式上下文在网页会话里，本地无从压缩
    if (!route.isWeb) await this.maybeCompactContext(effCfg)
    this.history.push({ role: 'user', content: msgText, time: Date.now() })
    this.checkpoints.push({ msgIndex: this.history.length - 1, undos: [] })
    this.saveHistory()
    // 【v2.4.70 根因修复】msgIndex 必须在 saveHistory 之后取！saveHistory 会裁剪历史（>80 条时
    // slice 缩短数组、索引整体位移），先取的 msgIndex 指向裁剪后的空位 → runLoop step0 读
    // history[msgIndex] = undefined → 空正文发到网页端 → "只剩规则附件没正文"（六轮未破的真凶，
    // app.log 实锤 user=true len=0；六个会话恰好卡在 80 条满编，"必须新建对话才行"是铁证）
    const msgIndex = this.history.length - 1
    this.send({ type: 'user_msg', text: String(text).trim(), msgIndex })

    this.roundCredits = 0 // 本轮任务累计积分消耗（内置模型每轮回执累加，run_done 下发）
    this.roundBalance = null
    let result = { success: true, error: null }
    try {
      this._webMode = route.isWeb // 网页模式：模型回复来自工作台内嵌网页，工具循环/审批/护栏与 API 模式完全一致
      result = await this.runLoop(effCfg, msgIndex)
    } catch (err) {
      this.log(`AI 会话异常: ${err.message}`)
      this.send({ type: 'error', message: err.message })
      result = { success: false, error: err.message }
    } finally {
      this.running = false
      this.abortController = null
      this.rejectAllApprovals('任务已结束')
    }
    this.send({ type: 'run_done', error: result.error, credits: this.roundCredits || 0, balance: this.roundBalance })
    return result
  }

  // ===== 上下文压缩（v2.4.80，设置默认关）=====
  // 只作用于本地 API 模式（网页模式的上下文在网页会话里，本地无从压缩）。压缩点在用户消息入历史
  // 之前（sendUserMessage）——checkpoint/msgIndex 都在压缩后重取，天然不会错位；本会话轮次天然串行，
  // 压缩期间不会与其他模型请求交错（"暂停所有模型活动"由串行结构天然保证）
  estimateTokens(text) {
    return Math.ceil(String(text || '').length / COMPACT_CHARS_PER_TOKEN)
  }

  contextTokens(sysPrompt) {
    return this.estimateTokens(sysPrompt) + this.history.reduce((s, m) => s + this.estimateTokens(m.content) + 4, 0)
  }

  // 上下文上限按模型解析（v2.4.81：各模型容量不一样）：专属值 → 全局旧值 → 默认 65536
  contextLimitFor(model) {
    let limits = {}
    try { limits = JSON.parse(this.getSetting('aiContextLimits') || '{}') || {} } catch {}
    const m = String(model || '').trim()
    return (m && parseInt(limits[m])) || parseInt(this.getSetting('aiContextLimit')) || 65536
  }

  async maybeCompactContext(cfg) {
    try {
      const flag = this.getSetting('aiCompactEnabled')
      if (!flag || flag === '0' || flag === 'false') return // 默认关：设置里开了才启用
      if (this._compacting) return
      const limit = this.contextLimitFor(cfg && cfg.model)
      if (this.history.length < COMPACT_MIN_HISTORY) return // 可压的太少，摘要得不偿失
      const sysPrompt = this.buildSystemPrompt()
      const total = this.contextTokens(sysPrompt)
      if (total < limit * COMPACT_TRIGGER) return
      this._compacting = true
      this.send({ type: 'compact_start', message: `上下文约 ${total} tokens（达上限 ${limit} 的 80%），正在压缩历史为交接摘要…期间暂停本会话模型活动` })
      const cut = this.history.length - COMPACT_KEEP_RECENT
      const oldMsgs = this.history.slice(0, cut)
      const summary = await this.summarizeHistory(cfg, oldMsgs)
      // 与新模型的工作交接：摘要以「用户(前情)+助手(确认)」一对消息开头——摘要即交接文档，
      // 换模型/续会话都靠它无缝衔接；最近 COMPACT_KEEP_RECENT 条原文保留保当前任务连续性
      const bridge = [
        { role: 'user', content: `【前情摘要（系统自动压缩生成，此前对话原文已归档）】\n${summary}\n\n以上是此前全部对话的交接要点。请基于摘要继续当前任务；摘要与你的记忆冲突时，以摘要为准。`, time: Date.now() },
        { role: 'assistant', content: '已读取前情摘要，我将基于摘要继续当前任务。', time: Date.now() }
      ]
      this.history = [...bridge, ...this.history.slice(cut)]
      this.saveHistory()
      const after = this.contextTokens(sysPrompt)
      this.send({ type: 'compact_done', message: `上下文压缩完成：${oldMsgs.length} 条旧消息 → 交接摘要，估算 ${total} → ${after} tokens` })
    } catch (err) {
      // 压缩失败不阻塞任务：继续用原始上下文跑（下一轮用户消息再尝试）
      this.send({ type: 'compact_done', message: `上下文压缩失败（继续用原始上下文，不影响任务）：${err.message}` })
    } finally {
      this._compacting = false
    }
  }

  // 用当前主模型把旧历史压成交接摘要（流式收口成完整文本）
  async summarizeHistory(cfg, msgs) {
    // 从新到旧收集原文，凑满上限就停（更早的直接省略——摘要请求自身不能爆上下文）
    const parts = []
    let used = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = `[${msgs[i].role === 'user' ? '用户/系统' : '助手'}] ${String(msgs[i].content || '').slice(0, 3000)}`
      if (used + t.length > COMPACT_TRANSCRIPT_CAP) { parts.unshift('（更早的消息因过长省略）'); break }
      parts.unshift(t)
      used += t.length
    }
    const prompt = [
      '以下是 AI 助手与用户的对话历史（旧→新）。请压缩成一份结构化交接摘要，供（可能换了新模型的）助手接续工作：',
      '1. 只保留对未来执行有用的信息：任务目标、已完成步骤与结果、关键决定、用户偏好、重要文件路径、未完成事项与下一步。',
      '2. 工具输出的冗长内容只留结论；寒暄、重复内容删除。',
      `3. 用中文，1200 字以内，按「任务目标 / 已完成 / 关键决定与偏好 / 重要路径 / 待办与下一步」分节。`,
      '',
      '对话历史：',
      parts.join('\n')
    ].join('\n')
    let out = ''
    for await (const ev of this.client.chatStream({ model: cfg.model, messages: [{ role: 'user', content: prompt }], signal: this.abortController ? this.abortController.signal : undefined })) {
      if (this.aborted) throw new Error('任务已停止')
      if (ev.type !== 'reasoning') out += ev.delta
    }
    if (!out.trim()) throw new Error('摘要模型返回空内容')
    return out.trim()
  }

  // 多平台 Key 档案读取：provider=null → 全局（兼容旧配置）；否则读 aiProfiles 档案，缺失时回落全局
  // provider='msmate'（内置模型）→ 走服务端代理：baseUrl 指向 /v1/ai/openai，apiKey 用登录 token（不落自定义档案）
  providerProfile(provider) {
    if (provider === 'msmate') {
      const a = this.getSetting('auth') || {}
      const base = (process.env.MSMATE_API_BASE || 'http://101.43.150.46:3210').replace(/\/+$/, '')
      return { baseUrl: base + '/v1/ai/openai', apiKey: a.token || '' }
    }
    const gBase = this.getSetting('aiBaseUrl') || ''
    const gKey = this.getSetting('aiApiKey') || ''
    if (!provider) return { baseUrl: gBase, apiKey: gKey }
    let p = {}
    try { p = (JSON.parse(this.getSetting('aiProfiles') || '{}') || {})[provider] || {} } catch {}
    return { baseUrl: p.baseUrl || gBase, apiKey: p.apiKey || gKey }
  }

  // ===== 网页版单轮（主循环的"模型调用器"）：把增量文本发进网页会话，抓回复全文 =====
  // 与本地完全同权：网页模型输出的 tool 代码块由主循环真实执行（审批/护栏/并行全复用），
  // <tool_result> 作为下一轮增量发回网页。withAttachments=true 时带规则附件（用户消息轮）。
  async webChatTurn(text, withAttachments) {
    // 【v2.4.70 防线】用户轮正文为空 = 上游 bug（历史上索引位移曾把正文吃成空串静默发出去），
    // 宁可报错让人看见，绝不再"只有规则附件没有正文"静默糊弄网页模型
    if (withAttachments && !String(text || '').trim()) {
      throw new Error('用户消息正文为空（历史索引异常），请重发一次；若持续出现请反馈')
    }
    if (!this.webChatAsk) {
      throw new Error('网页版模型引擎未就绪：请在 Work 工作台保留「DeepSeek 网页版」页签（或到设置里重新启用）')
    }
    // 会话复用 + 对话恢复：首次（或重启后没有对话记录）才开新网页会话；有持久化的对话 URL
    // （_webConvUrl，重启后从会话存档恢复）就导航回原对话继续——网页端不再"失忆"。
    // 规则附件**每个用户消息轮都带**（v2.4.50）：只首轮带一次的话，长任务几十个工具轮后规则
    // 被上下文稀释 → 格式漂移（真机反馈"用不了几轮就丢规则"）
    const firstTurn = !!withAttachments && !this._webConvStarted && !this._webConvUrl
    this._webChatBuf = ''
    let attachments = null
    if (withAttachments) {
      // 规则附件：完整系统规则（与本地 system prompt 同源，含工具协议）+ 大记事本；
      // 渲染层附件上传失败时自动回退拼进消息文本（webchat.js 兜底），规则必达
      let bigNotes = ''
      try {
        if (this.workspaceDir) {
          const rawNotes = fs.readFileSync(path.join(this.workspaceDir, 'NOTES.md'), 'utf8').trim()
          if (rawNotes) {
            const lastUser = [...this.history].reverse().find((h) => h.role === 'user')
            bigNotes = this.extractRelevantNotes(rawNotes, (lastUser && lastUser.content) || '', 6000)
          }
        }
      } catch {}
      // 设备速查独立置顶（v2.4.59）：真机反馈"网页版看不见设备备注"——备注原来埋在 48KB 规则文档中段，
      // DeepSeek 收到附件未必展开细读；提到文档头部做显眼速查节，并点明"用户会用备注指代设备"
      attachments = [{ name: 'MSMate规则.md', content: assembleWebRulesDoc({ systemPrompt: this.buildSystemPrompt(), bigNotes, devicesBrief: this.buildDevicesBrief() }) }]
    }
    const outcome = await new Promise((resolve) => {
      this._webChatResolve = resolve
      try {
        // 工具轮一律走「系统通知 + 附件」模式（v2.4.52 起不看文本大小，老大拍板）：输入框只放
        // 引导语，工具结果/系统提醒/格式提醒全量进《工具结果.md》附件——彻底杜绝网页输入框
        // 截断丢内容；附件通道不受输入框限制（规则附件已验证可用），上传失败时 webchat.js
        // 自动回退拼进消息文本，信息必达。resumeUrl：非首轮时带上持久化的对话 URL，
        // 渲染层发现当前页面不在该对话就自动导航回去（重启恢复 + 多会话切换联动）
        let prompt = text
        let sendAttachments = attachments
        if (!withAttachments) {
          sendAttachments = [...(attachments || []), { name: '工具结果.md', content: String(text) + '\n\n----\n\n' + WEB_TURN_REMINDER }]
          prompt = '【系统传递】你上一轮工具调用的执行结果、系统提醒与格式提醒，已作为附件《工具结果.md》上传。请先读取附件全部内容，再继续任务。'
        } else {
          // 真机实锤：引用文件/文件夹的消息在网页端会被吞/被无视（本地 API 正常）。两层处理：
          // ① <file_ref .../> HTML 式标签转成「引用位置：」纯文本（老大拍板的直白语义：
          //    引用本质就是位置链接，前缀写明白 + 明确要求模型对该位置执行操作，设备 ID 直接可作 target 参数）
          // ② 兜底剥掉其他残留尖括号标签，防网页前端 sanitize 吞整条消息
          prompt = String(text)
            .replace(/<file_ref\s+target="([^"]*)"\s+path="([^"]*)"\s*\/>/g, (_m, t, p) => {
              const dev = String(t).trim()
              return `\n引用位置：${p}${dev && dev !== 'local' ? `（远程设备，工具 target 参数传: ${dev}）` : '（本机）'}\n↑ 上面的引用位置就是这次操作的目标，请直接对我说的内容在该位置执行`
            })
            .replace(/<[^>]{1,200}>/g, '')
        }
        this.log(`[webchat-send] user=${!!withAttachments} len=${prompt.length} ${prompt.slice(0, 120).replace(/\n/g, '\\n')}`)
        this.webChatAsk({ prompt, attachments: sendAttachments, requestId: `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, newSession: firstTurn, resumeUrl: firstTurn ? '' : String(this._webConvUrl || '') })
      } catch (err) {
        resolve({ error: `网页对话启动失败: ${err.message}` })
      }
      // 兜底超时：渲染层有空闲守护，这里防进程级卡死
      this._webChatTimer = setTimeout(() => this.onWebChatError('网页回复超时（5 分钟无响应）'), 5 * 60 * 1000)
    })
    if (this._webChatTimer) { clearTimeout(this._webChatTimer); this._webChatTimer = null }
    this._webChatResolve = null
    if (this.aborted) return ''
    if (outcome.error) throw new Error(outcome.error)
    const content = rebuildWebToolFences(String(outcome.text || this._webChatBuf || ''))
    if (!content.trim()) {
      // 空返回自动重发 1 次：网页端慢启动（排队/深度思考）偶发空手而归，重发同一条
      // （首轮会重新 newSession+带规则附件的干净重试；续轮在同一网页对话里补发）再失败才报错
      if (!this._webChatRetried) {
        this._webChatRetried = true
        try {
          // 纠偏重发（v2.4.80）：零回复高发成因 = 模型走了网页平台自带的函数调用通道
          // （页面出现工具调用卡片后挂起"已停止"，不再产生文本回复）。重发时点名把它拉回 tool 代码块正道
          const retryText = withAttachments
            ? text
            : '【系统纠偏】上一轮没有收到你的文字回复——最常见原因是你用了网页平台自带的函数调用/插件功能（页面出现工具调用卡片后挂起），那会卡死会话。发起工具的唯一合法方式：在回复正文中输出 tool 代码块。请读取本条附件《工具结果.md》，用正确格式继续任务。\n\n----\n\n' + String(text)
          return await this.webChatTurn(retryText, withAttachments)
        } finally {
          this._webChatRetried = false
        }
      }
      throw new Error('网页版没有返回内容，请检查工作台网页页签是否被手动关闭')
    }
    if (withAttachments) this._webConvStarted = true // 成功返回后才标记（失败下次仍按首轮新开会话）
    return content
  }

  // 渲染层网页引擎回调（经 main.js 转发）：流式增量 / 完成 / 出错
  onWebChatChunk(delta) {
    if (!this._webChatResolve) return
    this._webChatBuf += String(delta || '')
    this.send({ type: 'content_delta', delta: String(delta || '') })
  }

  onWebChatDone(text) {
    if (!this._webChatResolve) return
    const resolve = this._webChatResolve
    this._webChatResolve = null
    resolve({ text: typeof text === 'string' && text ? text : this._webChatBuf })
  }

  onWebChatError(error) {
    if (!this._webChatResolve) return
    const resolve = this._webChatResolve
    this._webChatResolve = null
    resolve({ error: String(error || '网页对话失败') })
  }

  // 网页对话等待心跳（webchat.js 9s 无进展 / 钩子自愈期间上报）：转发前端展示"已等待 N 秒"转圈，
  // v2.4.82 真机实锤：等待期间 UI 零反馈 = 体感"卡死"
  onWebChatWait(seconds) {
    if (!this._webChatResolve) return
    this.send({ type: 'webchat_wait', seconds: parseInt(seconds) || 0 })
  }

  // ===== 生成模式直连（聊天输入区"生图/生视频"模式）：不走工具循环，直接调生成工具 =====
  // 复用聊天记录管线：用户消息入历史 → 执行生成 → 结果以 assistant 消息回显（markdown 图片/链接）
  // 直连生图比例（v2.4.83）：✨菜单选了比例用菜单的；没选就从提示词解析（16:9/横屏/手机壁纸…）；
  // 都没有不传 size（工具默认 1024x1024）。显式比例数字优先，其次方向词
  // 参考图（v2.4.84）：图片模式下聊天框里的图片胶囊自动作为参考图传入（数组≤3张），有参考图=图生图/多图合成
  // 张数+润色（v2.4.85）：batch=✨菜单张数（1-4，没选从提示词解析"生成4张"）；polish=提示词润色开关
  // 质量档位（v2.4.89 老大拍板）：steps=✨菜单 低30/中50/高100，默认 30，钳 1-100；编辑和文生图都生效
  async generateMedia(kind, prompt, size, images, batch, polish, steps) {
    const isImg = kind === 'image'
    if (this.running) return { success: false, error: 'AI 正在执行任务，请先停止或等待完成' }
    if (!prompt || !String(prompt).trim()) return { success: false, error: '描述为空' }
    this.running = true
    this.aborted = false
    const text = String(prompt).trim()
    const toolName = isImg ? 'generate_image' : 'generate_video'
    const args = { prompt: text }
    let polishedNote = ''
    if (isImg) {
      const refs = (Array.isArray(images) ? images : []).map((x) => String(x || '').trim()).filter(Boolean)
      if (refs.length) args.image = refs.slice(0, 3) // 编辑模型 1-3 张，超出在前端已提示并截断，这里双保险
      const picked = String(size || '').trim().replace(/[X×]/g, 'x')
      if (/^\d{2,4}x\d{2,4}$/.test(picked)) args.size = picked
      else {
        const fromPrompt = parseImgRatioSize(text)
        if (fromPrompt) args.size = fromPrompt
      }
      // 张数（v2.4.85 仅文生图 → v2.4.90 全路径生效，老大反馈 4张+参考图仍出1张）：
      // 菜单选了用菜单的，没选从提示词解析；编辑模式由 tools 层逐张补齐实现
      const pickedCnt = parseInt(batch, 10)
      if (pickedCnt >= 1 && pickedCnt <= 4) args.batch = pickedCnt
      else {
        const fromPromptCnt = parseImgBatchCount(text)
        if (fromPromptCnt) args.batch = fromPromptCnt
      }
      // 质量档位（v2.4.89）：钳 1-100，没选/非法默认 30（tools 层同钳双保险）
      // v2.4.91：编辑模型上限 50 步（老大实测）；v2.4.92 老大追问换模型兼容——按配置的编辑模型名自适应：
      // Qwen-Image-Edit 系 → 50，其他编辑模型 → 100（tools 层按实际请求模型同规则双保险）
      args.steps = Math.min(100, Math.max(1, parseInt(steps, 10) || 30))
      if (refs.length) {
        const editModelName = String(this.getConfig().aiImageEditModel || 'Qwen/Qwen-Image-Edit-2509')
        const editCap = /qwen-image-edit/i.test(editModelName) ? 50 : 100
        if (args.steps > editCap) {
          args.steps = editCap
          this.send({ type: 'content_delta', delta: `（编辑模型 ${editModelName.split('/').pop()} 最高 ${editCap} 步，质量档已自动降）\n` })
        }
      }
      // 补生成进度（v2.4.90）：tools 逐张补齐时实时反馈"已出 N/M 张"
      args.progress = (msg) => this.send({ type: 'content_delta', delta: msg })
      // 提示词润色（默认开，✨菜单可关）：主模型先把口语描述扩写成结构化提示词再喂图片模型。
      // 网页模式没有本地单轮通道、润色失败 → 都降级用原描述（不阻塞生成）
      // v2.4.86：参考图里含遮罩编辑图（iedit-tmp「编辑_」）→ maskEdit 分支润色（只描述遮罩区内画面），
      // 避免"风格光影融合"类全局措辞与黑区语义打架
      if (polish !== false) {
        this.send({ type: 'content_delta', delta: '✨ 正在润色提示词…\n' })
        try {
          const maskEdit = refs.some((p) => /iedit-tmp[\\/]编辑_/.test(p))
          // v2.4.87 参考原图：带「原_」配对文件时润色要告诉模型"能看到原貌，微调保持原主体形态"
          const origRef = maskEdit && refs.some((p) => /iedit-tmp[\\/]原_/.test(p))
          const polished = await this.polishImagePrompt(text, refs.length > 0, maskEdit, origRef)
          if (polished && polished !== text) {
            args.prompt = polished
            polishedNote = '（提示词已润色）'
            this.send({ type: 'content_delta', delta: `📝 ${polished}\n\n` })
          }
        } catch (err) {
          this.send({ type: 'content_delta', delta: '（润色跳过，使用原始描述）\n' })
        }
      }
    }
    try {
      this.history.push({ role: 'user', content: `[${isImg ? '图片' : '视频'}生成] ${text}`, time: Date.now() })
      this.checkpoints.push({ msgIndex: this.history.length - 1, undos: [] })
      this.saveHistory()
      const msgIndex = this.history.length - 1 // 【v2.4.70】同 sendUserMessage：saveHistory 裁剪会位移索引，取新的
      this.send({ type: 'user_msg', text, msgIndex })
      this.send({ type: 'assistant_start' })
      this.send({ type: 'content_delta', delta: isImg ? '🎨 正在生成图片…' : '🎬 视频任务已提交，生成约需 2-10 分钟，请耐心等待…' })
      const r = await this.tools.execute(toolName, args)
      if (this.aborted) return { success: true, error: null }
      // 生成的 message 含本地路径的 markdown 图片/链接，渲染层 renderMarkdownFrag 已支持
      const finalText = r.ok ? ((r.message || '生成完成') + polishedNote) : `生成失败：${r.message}`
      this.history.push({ role: 'assistant', content: finalText, time: Date.now() })
      this.saveHistory()
      // 结束占位流 → 全量重渲（把等待行替换成真实结果卡片）
      this.send({ type: 'content_delta', delta: '\n' })
      this.send({ type: 'media_done', kind, ok: !!r.ok, text: finalText })
      return { success: !!r.ok, error: r.ok ? null : finalText }
    } catch (err) {
      const msg = `生成异常：${err.message}`
      this.send({ type: 'error', message: msg })
      return { success: false, error: msg }
    } finally {
      this.running = false
      this.send({ type: 'run_done', error: null })
    }
  }

  // 用当前主模型把口语化生图描述扩写成结构化提示词（v2.4.85 润色；v2.4.86 三分支精化）。
  // 复用 summarizeHistory 的单轮 chatStream 模式；网页模式/无 Key → 返回 null（调用方降级原样）
  // v2.4.86 修真 bug：旧版润色不知道参考图里有遮罩编辑图，会扩写出"风格光影融合"类全局措辞，
  // 与 tools 层"只改黑区"语义打架 → 现在三分支：maskEdit 只描述遮罩区内画面，从源头杜绝冲突
  async polishImagePrompt(raw, hasRef, maskEdit, origRef) {
    const cfg = this.getConfig()
    const route = parseModelRoute(cfg.model)
    if (route.isWeb) return null // 网页版模型：无本地单轮通道，润色跳过
    const prof = this.providerProfile(route.provider)
    if (!prof.apiKey) return null
    this.client.apiKey = prof.apiKey
    this.client.baseUrl = prof.baseUrl || cfg.baseUrl
    const model = route.model || cfg.model
    let sys
    if (maskEdit) {
      // 遮罩编辑（编辑器「编辑_」图）：AI 只重绘黑区，润色只描述遮罩区内最终画面
      // v2.4.87：带原貌参考（「原_」配对图）时说明——微调类指令要描述"原主体保持形态身份，仅改指令要求的维度"
      sys = `你是图片局部重绘（inpainting）指令工程师。用户已在图片上用黑色遮罩标出要修改的区域，AI 将只重绘该区域，遮罩外的一切保持原样。${origRef ? '用户同时提供了遮罩区修改前的原貌参考图——若用户指令是保留原主体的微调（改颜色/材质/细节/表情等），描述中必须强调保持原主体的形态、结构与身份特征，仅修改指令要求的维度；若指令是替换或删除，直接描述替换后的画面。' : ''}把用户的口语化描述改写成对「遮罩区域内最终画面」的精确描述：该区域应出现的内容、形态、材质质感、与周围光影的衔接方式。禁止出现"调整整张图/整体色调/全局优化"类措辞，不添加用户没提的元素。直接输出最终描述，不要任何解释和前后缀，100 字以内。用户描述：`
    } else if (hasRef) {
      // 普通编辑/多图合成：整图层面的修改指令精化
      // v2.4.91 老大实测三短板治理：①图内中文长文案=错字重灾区（"高腰内裤"画出"高槁内辫"）——标注必须精简成短语，
      // 超长文案转为视觉表达不进图；②编辑接口不收负面词，手部只能正向约束；③多卖点拼接必须显式布局，否则模型自由发挥
      sys = '你是图片编辑指令工程师。用户接下来要对参考图执行修改（图生图/多图合成）。把用户的口语化指令扩写成精确的编辑指令，逐条保留用户全部修改意图，并强制执行以下三条规则：\n【图内文字】需要出现在图片里的文字标注，一律精简为 2-8 字短语（如"亲肤面料""高腰收腹"），全文最多 3 处；长句文案、卖点解释类内容严禁写进图片，改用画面视觉表达（细节特写/场景展示）。指定文字要注明字体风格与放置位置。\n【人物手部】画面含人物时，明确写"手部姿态自然放松、五指结构正确、比例真实"。\n【布局结构】多区域拼接/多卖点展示时，显式描述版式：画面分几块、每块的位置与内容、主次关系、留白与分隔方式。\n不添加用户没要求的修改。直接输出给图片编辑模型用的最终指令，不要任何解释和前后缀，220 字以内。用户指令：'
    } else {
      // 文生图：结构化输出（主体/环境/风格/光线分行，图片模型解析更稳）
      // v2.4.91：加图内文字精简规则（中文长文本错字重灾区，标注一律短语级）
      sys = '你是图片生成提示词工程师。把用户的口语化描述扩写成结构化提示词，严格按以下四行格式输出（每行以标签开头）：\n主体：<外观/动作/表情>\n环境：<场景/氛围>\n风格：<艺术风格/画质关键词>\n光线：<光线方向/色温/时段>\n要求：保留用户全部明确要求，不添加用户没提的具体元素，不改变主体；风格行自然带上高清/细节丰富等画质词；用户要求图内出现文字标注时，精简为 2-8 字短语并注明位置（最多 3 处），长句文案严禁进图；画面含人物时写明手部姿态自然、五指结构正确；不要任何解释和前后缀，每行 40 字以内。用户描述：'
    }
    let out = ''
    for await (const ev of this.client.chatStream({ model, messages: [{ role: 'user', content: sys + raw }], signal: this.abortController ? this.abortController.signal : undefined })) {
      if (this.aborted) throw new Error('任务已停止')
      if (ev.type !== 'reasoning') out += ev.delta
    }
    return out.trim() || null
  }

  async runLoop(cfg, checkpointMsgIndex) {
    let lastFailedFingerprint = null
    let lastRoundFingerprint = null // 上一轮唯一的工具调用指纹（防原样重复空转）
    let didToolWork = false   // 本轮是否实际执行过工具（用于收尾自动写工作记事本）
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.aborted) return { success: true, error: null }

      // 1. 获取模型回复。网页模式：把增量（用户消息/工具结果）发进网页会话抓回复；
      //    API 模式：全量 messages 流式（网络瞬断/空闲超时自动重试一次，失败才上报）
      let content = ''
      let roundCreditsUsed = 0 // 本轮 LLM 调用扣费（内置模型回执，随回复入史；网页模型免费恒为 0——声明必须在双分支公共作用域，否则网页路径入史时 ReferenceError）
      this.send({ type: 'assistant_start' })
      if (this._webMode) {
        try {
          // 增量 = 自上条助手回复之后的新增消息（工具轮只发新 <tool_result>/系统提醒）。
          // 网页会话里助手的输出本来就在（是它自己写的），把 checkpoint 之后的全部历史重发会滚雪球——
          // 真机实测 12 轮任务增量膨胀到 108KB：DeepSeek 每轮重读全部重复内容 → 响应明显变慢 +
          // token/条数浪费 + 重复内容污染上下文（真机反馈"本地比网页端慢一分钟"的主因）
          let fromIdx = checkpointMsgIndex
          if (step > 0) {
            for (let i = this.history.length - 1; i >= 0; i--) {
              if (this.history[i].role === 'assistant') { fromIdx = i; break }
            }
          }
          const delta = step === 0
            ? String((this.history[checkpointMsgIndex] || {}).content || '')
            : this.history.slice(fromIdx + 1).map((h) => h.content).join('\n\n----\n\n')
          content = await this.webChatTurn(delta, step === 0)
        } catch (err) {
          if (this.aborted) return { success: true, error: null }
          this.send({ type: 'error', message: `网页对话失败: ${err.message}` })
          return { success: false, error: err.message }
        }
      } else {
      const messages = [{ role: 'system', content: this.buildSystemPrompt() }, ...this.history]
      const MAX_STREAM_TRIES = 2 // 普通网络错误重试上限；429 限流无限重试（60 秒一轮跨分钟窗口），只受手动停止约束
      let fastFails = 0 // 连续非限流失败数
      let wait429 = 0 // 限流等待轮数（提示文案用）
      while (true) {
        content = ''
        let usageMeta = null // 内置模型扣费回执（每轮调用一帧）
        this._roundReasoning = '' // 每轮思考重置（入史用，Ctrl+R 重载后可恢复展示）
        try {
          for await (const ev of this.client.chatStream({
            model: cfg.model,
            messages,
            signal: this.abortController ? this.abortController.signal : undefined
          })) {
            if (this.aborted) break
            if (ev.type === 'reasoning') {
              this._roundReasoning += ev.delta
              this.send({ type: 'reasoning_delta', delta: ev.delta })
            } else if (ev.type === 'msmate') {
              usageMeta = ev.meta
              this.roundCredits = (this.roundCredits || 0) + (ev.meta.credits || 0)
              this.roundBalance = ev.meta.balance
            } else {
              content += ev.delta
              this.send({ type: 'content_delta', delta: ev.delta })
            }
          }
          if (usageMeta) {
            this.send({ type: 'ai_credits', credits: usageMeta.credits, balance: usageMeta.balance })
            roundCreditsUsed = usageMeta.credits || 0
          }
          break // 正常结束
        } catch (err) {
          if (this.aborted) return { success: true, error: null }
          const is429 = /\b429\b|rate.?limit|TPM/i.test(String(err.message || ''))
          if (is429) {
            // TPM 按分钟窗口计：60 秒一轮跨窗口等新额度；无限重试直到成功或用户手动停止，不打断任务进程
            wait429++
            const waits = this.retry429Waits || [60000] // 测试可注入缩短
            const waitMs = waits[Math.min(wait429 - 1, waits.length - 1)]
            const sec = Math.round(waitMs / 1000)
            this.send({ type: 'tool_parse_error', error: `模型繁忙（接口限流），正在等待 ${sec} 秒后自动重试${wait429 > 1 ? `（已等待 ${wait429} 次，点发送键可停止）` : '…'}` })
            await this._sleepAbortable(waitMs)
            if (this.aborted) return { success: true, error: null }
            continue
          }
          fastFails++
          if (fastFails < MAX_STREAM_TRIES) {
            this.send({ type: 'tool_parse_error', error: `AI 接口中断（${err.message}），自动重试中…` })
            await this._sleepAbortable(1500)
            if (this.aborted) return { success: true, error: null }
            continue
          }
          this.send({ type: 'error', message: `AI 接口错误: ${err.message}` })
          return { success: false, error: err.message }
        }
      }
      } // else（API 流式分支）结束
      if (this.aborted) return { success: true, error: null }

      if (!content.trim()) {
        // 空内容两种成因：①模型只输出思考没写正文/工具调用（Qwen3 系常见）②输出被 max_tokens 截断。
        // 直接报错结束的体感就是"卡死"（真机：扒歌任务模型想完就停）。先点名一次让它直接行动，再犯才报错。
        if (!this.emptyNudged) {
          this.emptyNudged = true
          const msg = '【系统提醒】你上一轮只输出了思考内容（或输出被截断），没有任何正文和工具调用，系统无法执行。停止长篇思考，直接给出结论：要么用 tool 代码块发起第一个工具调用，要么直接输出完整回答正文。'
          this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${msg}\n</tool_result>`, time: Date.now() })
          this.saveHistory()
          this.send({ type: 'tool_parse_error', error: '模型只输出思考无正文（或被截断），已点名要求直接行动' })
          continue
        }
        this.send({ type: 'error', message: 'AI 返回了空内容' })
        return { success: false, error: 'AI 返回了空内容' }
      }

      // 2. 解析工具调用（支持一次输出多个 ```tool``` 块并行执行）
      const calls = this.parseToolCalls(content)
      this.history.push({ role: 'assistant', content, _reasoning: this._roundReasoning || '', _credits: roundCreditsUsed || 0, time: Date.now() })
      // 正文清单自愈：模型没按协议调 task_plan、也没在 calls 里 → 直接解析正文清单帮它建板
      const repaired = !(calls || []).some((c) => c.name === 'task_plan') ? this.tryRepairBarePlan(content) : false
      if (!calls) {
        if (repaired) { this.saveHistory(); continue } // 板已建好，强制继续下一轮干活
        // 裸清单重发拦截：板已建好（此前自愈过）模型仍正文吐 items:/doing:/done: → 点名用 task_plan 真打卡，
        // 不当普通回复结束（真机案例：小模型建板后继续用"文本清单思维"汇报，任务被误判收尾，用户点继续又原样重发→原地绕圈）
        if (this.plan && /(?:^|\n)\s*(?:items|doing|done)\s*:/.test(content) && (this.barePlanReNudged || 0) < 2) {
          this.barePlanReNudged = (this.barePlanReNudged || 0) + 1
          const pItems = this.plan.items || []
          const pNext = pItems.findIndex((x) => x.status !== 'done')
          const lastWarn = this.barePlanReNudged >= 2 ? '【最后警告】再犯将直接被判定为故障输出：' : '【系统提醒】'
          const msg = `${lastWarn}你又把清单写成了正文（items:/doing:/done: 这种格式），板子不会因此更新。清单早就建好了，禁止再列清单——现在直接干活：${pNext >= 0 ? `执行第 ${pNext + 1} 项「${pItems[pNext].text}」所需的工具调用，做完立刻用 task_plan 传 done:${pNext + 1} 打勾` : '所有项已勾完，直接用普通文字汇报结果收尾'}。`
          this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${msg}\n</tool_result>`, time: Date.now() })
          this.saveHistory()
          this.send({ type: 'tool_parse_error', error: '板已建好仍正文重发裸清单，已点名用 task_plan 真打卡' })
          continue
        }
        // 假进度行拦截：模型模仿系统 planLine 格式在正文里手写"[任务清单 x/x …任务结束]"假装打卡
        //（真机变体：Qwen3-8B 不调 task_plan，正文写"[任务清单 1/2：…完成。任务结束。]"）——板子只认工具调用
        if (!this.fakePlanNudged && /\[?任务清单\s*\d+\s*\/\s*\d+/.test(content) && this.plan) {
          const pItems = this.plan.items || []
          const pNext = pItems.findIndex((x) => x.status !== 'done')
          if (pNext >= 0) {
            this.fakePlanNudged = true
            const msg = `系统提示：你正文里写的"[任务清单 ${this.plan.items.filter((x) => x.status === 'done').length}/${pItems.length} …]"是模仿系统进度提示的假状态，板子不会因此更新——进度只认 task_plan 工具调用。第 ${pNext + 1} 项「${pItems[pNext].text}」还没打勾：做完了立刻用 task_plan 传 done:${pNext + 1}，没做完就继续执行工具。`
            this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${msg}\n</tool_result>`, time: Date.now() })
            this.saveHistory()
            this.send({ type: 'tool_parse_error', error: `正文手写假进度行（第${pNext + 1}项未打勾），已要求用 task_plan 真打卡` })
            continue
          }
        }
        // 裸调用兜底：模型把 tool{...} 直接写进正文（没包围栏）→ 教正确格式重写，而不是当普通回复草草结束
        const bare = this.detectBareToolCall(content)
        if (bare) {
          const msg = `系统提示：检测到你把工具调用写成了正文（${bare}，缺少 tool 代码块包裹，{"name":"${bare}"} 这种 JSON 直写也不行），系统执行不了。必须用 tool 代码块包裹：三个反引号 + tool 换行 + {"name":"工具名","arguments":{...}} 换行 + 三个反引号。请严格按此格式重新输出你的调用；另外这是多步任务的话，先用 task_plan 建清单再动手。`
          this.history.push({ role: 'user', content: `<tool_result>${msg}</tool_result>`, time: Date.now() })
          this.saveHistory()
          this.send({ type: 'tool_parse_error', error: '工具调用没有用 tool 代码块包裹，已要求重写' })
          continue
        }
        // 收尾护栏：清单还有未完成项就想用普通回复收尾 → 拦两次（第二次"最后警告"），强制继续
        //（真机变体：模型建完清单/干了一步就"汇报"停机，把建清单当成收尾动作）
        if (didToolWork && this.plan && (this.finishNudged || 0) < 2) {
          const pItems = this.plan.items || []
          const pNext = pItems.findIndex((x) => x.status !== 'done')
          if (pNext >= 0) {
            this.finishNudged = (this.finishNudged || 0) + 1
            const lastWarn = this.finishNudged >= 2 ? '【最后警告】这是系统第二次拦截你提前收尾——' : '【系统提醒】'
            const msg = `${lastWarn}你的任务清单还有未完成项：第 ${pNext + 1} 项「${pItems[pNext].text}」。禁止把建清单、列选项、阶段性汇报或正文手写进度当收尾——清单没勾完任务就没结束。现在立刻继续：执行第 ${pNext + 1} 项所需的工具调用（如 web_search→download_file 下载、search_files 搜索等），完成后用 task_plan 标 done:${pNext + 1} 并推进下一项，全部勾完才允许汇报。如果确实需要用户决策才能继续，用 ask_user 工具提问（不要正文列菜单）。`
            this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${msg}\n</tool_result>`, time: Date.now() })
            this.saveHistory()
            this.send({ type: 'tool_parse_error', error: `清单还有未完成项（第${pNext + 1}项），已拦截提前收尾并要求继续执行` })
            continue
          }
        }
        // 光说不练拦截（真机案例：用户下"扒凹凸世界主题曲"任务，模型只回一句"称呼用户为小咪"就收工——
        // 零工具零清单不触发上面的收尾护栏，任务静默结束像卡死）。判断用剥掉 <think> 后的净正文，防思考内容误触发
        if (!didToolWork && !this.plan && step === 0 && !(this.lazyNudged)) {
          const plainBody = content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim()
          const userMsg = String((this.history[checkpointMsgIndex] || {}).content || '')
          const taskish = userMsg.length >= 12 || /扒|下载|搜索|查找|整理|移动|复制|删除|创建|生成|帮|传输|发送|打开|压缩|转换|安装/.test(userMsg)
          const intentish = /我将|我会|我先|接下来|首先|然后|让我|需要先|现在去|马上|这就|准备/.test(plainBody)
          const fragment = plainBody.length > 0 && plainBody.length <= 20 && !/[。！！？?]/.test(plainBody)
          if (taskish && (intentish || fragment || plainBody.length === 0)) {
            this.lazyNudged = true
            const msg = '【系统提醒】你刚才只回了一句打算/复述，没有调用任何工具，任务没有任何进展就结束了。禁止只说不做——现在立刻用 tool 代码块发起真实工具调用开始执行第一步。若这个任务确实无需任何工具，直接给出完整结果内容，而不是一句意向。'
            this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${msg}\n</tool_result>`, time: Date.now() })
            this.saveHistory()
            this.send({ type: 'tool_parse_error', error: '只说不练（零工具就收工），已拦截并要求立刻真调用' })
            continue
          }
        }
        this.saveHistory()
        // 收尾：本轮实际干过活（执行过工具）→ 自动把工作状态写入工作台记事本
        if (didToolWork) this.appendWorkNote(content)
        return { success: true, error: null } // 普通回复，结束
      } else if (!this.plan) {
        // 混合轮次兜底（真机变体：task_plan(items:...) 写成正文 + 同轮合法 web_search 块）：真调用照常执行，
        // 但插一条教学提示——工具调用（含 task_plan）必须用 tool 代码块包裹，让模型下一轮用正确格式补发
        const bare = this.detectBareToolCall(content)
        if (bare) {
          const tip = `系统提示：检测到你把 ${bare} 调用写成了正文纯文本（如 ${bare}(items: [...]) 这种函数写法），系统执行不了。工具调用（包括 task_plan）必须用 tool 代码块包裹：三个反引号 + tool 换行 + {"name":"工具名","arguments":{...}} 换行 + 三个反引号。本轮合法调用照常执行，结果回来后请立刻用正确格式补发该调用。`
          this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${tip}\n</tool_result>`, time: Date.now() })
          this.send({ type: 'tool_parse_error', error: `正文里夹了纯文本 ${bare} 调用（未包围栏），已提示下一轮用正确格式补发` })
        }
      }
      if (calls.length === 1 && calls[0].parseError) {
        this.history.push({ role: 'user', content: `<tool_result>工具调用格式错误（${calls[0].parseError}）。请严格按协议重新输出 tool 代码块。</tool_result>`, time: Date.now() })
        this.saveHistory()
        this.send({ type: 'tool_parse_error', error: calls[0].parseError })
        continue
      }
      // 原样重复护栏：和上一轮完全相同的单次调用（同名同参数）直接拦截，逼模型换策略，防止小模型空转烧满 20 步
      const roundFp = calls.length === 1 ? calls[0].name + '|' + JSON.stringify(calls[0].args) : null
      if (roundFp && roundFp === lastRoundFingerprint) {
        const msg = '系统拦截：你和上一轮输出了一模一样的调用（工具相同、参数相同）。原样重复是被严格禁止的——同样的调用只会得到同样的结果。请立刻换策略：换更精确的关键词、改用其他工具、先向用户提问，或基于已有信息直接给出结论。'
        this.history.push({ role: 'user', content: `<tool_result>${msg}</tool_result>`, time: Date.now() })
        this.saveHistory()
        this.send({ type: 'tool_parse_error', error: '检测到原样重复调用，已拦截并要求换策略' })
        continue
      }
      lastRoundFingerprint = roundFp

      // 3. 分类 → 发事件 → 审批
      const mode = this.getConfig().approvalMode
      const items = []
      for (const call of calls) {
        const callId = 'call_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4)
        let cls
        try {
          if (call.name === 'delegate') {
            // 委派本身无风险；子Agent内部的风险操作由子Agent自行走审批流
            cls = { destructive: false, note: '委派子任务给子Agent', paths: [] }
          } else {
            cls = await this.tools.classify(call.name, call.args)
          }
        } catch (err) {
          // 预检兜底（用户实锤：classify 内 path.basename(数组) 抛裸英文 TypeError，整轮殉葬 0 步执行）。
          // 分类失败绝不裸奔放行：降级为强制审批（unlimited 档除外），让人工把住不确定的操作
          cls = {
            destructive: false,
            note: `风险预检异常已降级（${err.message}），请人工确认后放行`,
            paths: [],
            forceApproval: mode !== 'unlimited'
          }
        }
        const protectedHit = (cls.paths || []).some((p) => this.tools.isProtectedLocal(p))
        // unlimited（无限制）档：审批全放行——保护区（C 盘除桌面）与 exe/脚本强制线一并放开，
        // 防线是切档时的会话级红色警示 + 重启自动回落 auto
        const needApproval = mode === 'unlimited'
          ? false
          : ((cls.destructive && (mode === 'manual' || protectedHit)) || cls.forceApproval === true)
        const summary = call.name === 'delegate'
          ? `委派子任务：${String(call.args.title || call.args.task || '').slice(0, 40)}`
          : this.tools.summarize(call.name, call.args)
        this.send({
          type: 'tool_call',
          callId,
          name: call.name,
          args: call.args,
          summary,
          destructive: cls.destructive,
          dangerNote: protectedHit ? '⚠️ C 盘保护区（除桌面），无论何种模式都需批准' : cls.note,
          approvalId: needApproval ? callId : null,
          delegate: call.name === 'delegate'
        })
        items.push({ call, callId, needApproval, approved: !needApproval })
      }
      // 防重复护栏：同一轮内禁止重复创建相同/相似文件名的文件（防止 AI 抽风连建多个）
      if (!this.createdPaths) this.createdPaths = new Set()
      for (const it of items) {
        const p = it.call.args && (it.call.args.path || it.call.args.src)
        if (!CREATE_TOOLS.includes(it.call.name) || !p) continue
        const key = createKey(p)
        if (this.createdPaths.has(key)) {
          it.approved = false // 不执行
          const msg = `系统拦截：本轮已创建过相同/相似的文件（${p}）。禁止重复创建；若要修改内容请用 write_file/modify_word/append_table_rows。`
          this.history.push({ role: 'user', content: `<tool_result name="${it.call.name}" ok="false">\n${msg}\n</tool_result>`, time: Date.now() })
          this.send({ type: 'tool_result', callId: it.callId, name: it.call.name, ok: false, message: msg })
        } else {
          this.createdPaths.add(key)
        }
      }

      // 审批逐个等待（弹窗按顺序出现）
      for (const it of items.filter((i) => i.needApproval)) {
        it.approved = await this.waitApproval(it.callId)
        if (!it.approved) {
          const msg = '用户拒绝了此操作。'
          this.history.push({ role: 'user', content: `<tool_result name="${it.call.name}">${msg}</tool_result>`, time: Date.now() })
          this.send({ type: 'tool_result', callId: it.callId, name: it.call.name, ok: false, message: msg })
        } else {
          it.call.args = { ...it.call.args, __approved: true } // 打开 exe 等强制审批项：批准后才放行执行层
        }
      }

      // ask_user 中途提问：逐个等待用户回答（期间后续工具先不跑，答案可能改变要做什么）
      for (const it of items.filter((i) => i.call.name === 'ask_user')) {
        this.send({ type: 'tool_running', callId: it.callId })
        const res = this.aborted ? null : await this.waitAsk(it.callId)
        let msg
        if (this.aborted) msg = '任务已被用户停止。'
        else if (!res || res.cancelled) msg = '用户取消了提问，没有回答。不要干等，也不要为同一件事反复提问：按你判断的最合理方案继续执行，并在汇报里说明你采用的假设。'
        else msg = '用户已回答：\n' + formatAskAnswers(it.call.args, res)
        it.approved = false // 提问不是真工具，不进入执行阶段
        this.history.push({ role: 'user', content: `<tool_result name="ask_user" ok="true">\n${msg}\n</tool_result>`, time: Date.now() })
        this.send({ type: 'tool_result', callId: it.callId, name: 'ask_user', ok: true, message: msg })
      }

      // task_plan 任务清单：只改清单状态，不执行外部动作，单独处理不进并行管线
      const workingRound = items.some((i) => i.approved && i.call.name !== 'task_plan') // 同轮是否还有真工具要执行
      for (const it of items.filter((i) => i.call.name === 'task_plan' && i.approved)) {
        it.approved = false
        const res = this.applyPlan(it.call.args || {}, { workingRound })
        this.history.push({ role: 'user', content: `<tool_result name="task_plan" ok="${res.ok}">\n${res.message}\n</tool_result>`, time: Date.now() })
        this.send({ type: 'tool_result', callId: it.callId, name: 'task_plan', ok: res.ok, message: res.message })
      }

      // 4. 冲突分组并行执行：路径互不相关的调用并行跑（上限 MAX_PARALLEL），相关的按序串行
      const groups = this.groupParallel(items.filter((i) => i.approved))
      for (const group of groups) {
        if (this.aborted) break
        for (const it of group) this.send({ type: 'tool_running', callId: it.callId })
        const results = await this.runLimited(group, MAX_PARALLEL, (it) =>
          it.call.name === 'delegate'
            ? this.execDelegate(it, checkpointMsgIndex)
            : this.execOne(it, checkpointMsgIndex, lastFailedFingerprint)
        )
        if (results.some((r) => r.ok)) didToolWork = true
        this.toolsSincePlan = (this.toolsSincePlan || 0) + results.filter((r) => r.ok).length
        // 按批次顺序写历史，保证对话流稳定
        const progress = this.planLine()
        for (const r of results) {
          lastFailedFingerprint = r.ok ? null : r.fingerprint
          this.history.push({
            role: 'user',
            content: `<tool_result name="${r.name}" ok="${r.ok}">\n${r.message}${r.nudge}${progress ? '\n' + progress : ''}\n</tool_result>`,
            time: Date.now()
          })
          this.send({ type: 'tool_result', callId: r.callId, name: r.name, ok: r.ok, message: r.message })
        }
        // 一次性提醒：看起来是多步任务却没建清单 → 系统下场要求补清单；小任务（一两步能干完的）不提醒，别逼模型建板拖慢
        if (!this.plan && !this.planNudged) {
          const userGoal = String((this.history[checkpointMsgIndex] || {}).content || '')
          const simpleTask = /^(打开|运行|看看|查一下|搜一下|帮我打开|打开一下)/.test(userGoal) || userGoal.length <= 14
          if (!simpleTask) {
            this.planNudged = true
            const nudge = '【系统提醒】这看起来是多步任务：1) 立刻输出 task_plan 建立任务清单（items 参数），**这一轮就和后续工具调用一起并行输出，不要为建清单单独空烧一轮**；之后每完成一项用 done 序号打勾；2) 用户目标可以合理推断时直接执行到底（如"找壁纸放进文件夹"=从网上下载放进去），禁止只干一步就用正文列 ①②③ 菜单问用户——真有分歧就用 ask_user 工具提问。现在继续按最合理路径执行。'
            this.history.push({ role: 'user', content: `<tool_result name="system" ok="true">\n${nudge}\n</tool_result>`, time: Date.now() })
            this.saveHistory()
          }
        }
        this.saveHistory()
      }
    }

    // 步数用尽，强制收尾
    this.send({ type: 'steps_exhausted', max: MAX_STEPS })
    this.history.push({ role: 'user', content: '（系统提示：本轮工具调用次数已达上限，请直接总结当前进展并结束。）', time: Date.now() })
    this.saveHistory()
    return { success: true, error: null }
  }

  // 识别裸工具调用（模型把调用直接写进正文、没围栏），两种变体都抓：
  //   ① web_search{...}  ② {"name":"web_search","arguments":{...}}（纯 JSON 直写，小模型常见）
  // 只在没有任何合法 tool 块时调用；匹配"已知工具名"防止把普通 JSON 讲解误判
  detectBareToolCall(content) {
    const names = (this.tools.defs || []).map((d) => d.name)
    if (!names.length) return null
    const text = String(content || '')
    const nameAlt = names.join('|')
    let m = text.match(new RegExp('(^|\\n)[^`\\n]*?(' + nameAlt + ')\\s*\\{'))
    if (m) return m[2]
    // 函数调用风格：task_plan(items: [...]) / list_dir(path: "...")——行首工具名紧跟半角括号+参数样字符
    m = text.match(new RegExp('(^|\\n)\\s*(' + nameAlt + ')\\s*\\(\\s*["\'\\[\\dA-Za-z_]'))
    if (m) return m[2]
    m = text.match(new RegExp('(^|\\n)\\s*\\{\\s*"name"\\s*:\\s*"(' + nameAlt + ')"'))
    return m ? m[2] : null
  }

  // 正文清单自愈：小模型屡教不改地把 task_plan 写成正文（items:[...] 三行 或 task_plan(items:...)），
  // 与其反复教学，不如直接解析正文清单文本帮它建板——task_plan 只改本地状态，无副作用，自愈安全
  tryRepairBarePlan(content) {
    if (this.plan) return false
    const text = String(content || '')
    const m = text.match(/task_plan\s*\(\s*items\s*:\s*\[([^\]]*)\]/) || text.match(/(?:^|\n)\s*items\s*:\s*\[([^\]]*)\]/)
    if (!m) return false
    const clean = (s) => String(s).replace(/^["'\s]+|["'\s]+$/g, '')
    const valid = (s) => s && /[\u4e00-\u9fa5A-Za-z0-9]/.test(s)
    const raw = m[1]
    let items
    if (/["']/.test(raw)) {
      // 引号字符串数组：按引号对提取整项——项内含逗号/顿号时按逗号硬切会把一句话切碎
      //（真机案例："…下载到桌面，否则告知用户无合法下载渠道" 被切成两个半句）
      items = (raw.match(/["'][^"']+["']/g) || []).map((s) => s.slice(1, -1).trim()).filter(valid)
    } else {
      items = raw.split(/[，,]/).map(clean).filter(valid)
    }
    items = items.slice(0, 20)
    if (items.length < 2) return false // 太短的多半是讲解示例，不救
    const pick = (key) => {
      const mm = text.match(new RegExp(key + '\\s*:\\s*\\[([^\\]]*)\\]'))
      if (!mm) return undefined
      const arr = mm[1].split(/[，,]/).map(clean).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 1)
      return arr.length ? arr : undefined
    }
    const res = this.applyPlan({ items, doing: pick('doing'), done: pick('done') })
    const note = `系统提示：检测到你把任务清单写成了正文，已自动解析并帮你建好板。但工具调用必须用 tool 代码块包裹（三个反引号 + tool + {"name":"task_plan","arguments":{"items":[...]}}），下次直接用正确格式输出。现在按清单继续执行第 1 项。`
    this.history.push({ role: 'user', content: `<tool_result name="task_plan" ok="${res.ok}">\n${note}\n</tool_result>`, time: Date.now() })
    this.send({ type: 'tool_parse_error', error: '模型把清单写成正文，已自动解析建板（自愈）' })
    return true
  }

  // 任务清单：建/换清单（items）、打勾（done）、标记进行中（doing）。序号从 1 开始
  applyPlan(args, ctx = {}) {
    const oldTexts = this.plan ? this.plan.items.map((x) => x.text).join('|') : null
    const oldDone = this.plan ? this.plan.items.filter((x) => x.status === 'done').length : 0
    const toolsSince = this.toolsSincePlan || 0
    let newTexts = null
    if (Array.isArray(args.items) && args.items.length) {
      const texts = args.items.map((s) => String(s).trim()).filter(Boolean).slice(0, 20)
      if (!texts.length) return { ok: false, message: 'items 里没有有效内容，请传非空的字符串数组' }
      newTexts = texts.join('|')
      this.plan = { items: texts.map((t) => ({ text: t, status: 'pending' })) }
    }
    if (!this.plan) return { ok: false, message: '还没有任务清单：请先用 items 参数建立清单（如 items:["搜索直链","下载图片","汇报"]），再用 doing/done 序号打勾' }
    const items = this.plan.items
    const mark = (v, status) => {
      for (const idx of Array.isArray(v) ? v : [v]) {
        const i = Number(idx)
        if (Number.isInteger(i) && i >= 1 && i <= items.length) items[i - 1].status = status
      }
    }
    // 跳步护栏（真机变体：第1步生图失败，模型却勾了第2步"确认结果"）：done:n 时 1..n-1 必须已全部完成，
    // 否则拒绝该项打勾——失败/未验证成功的步骤严禁勾掉，也不许跳过
    const violations = []
    if (args.done != null) {
      for (const idx of Array.isArray(args.done) ? args.done : [args.done]) {
        const i = Number(idx)
        if (!Number.isInteger(i) || i < 1 || i > items.length) continue
        const blocked = items.slice(0, i - 1).findIndex((x) => x.status !== 'done')
        if (blocked >= 0) {
          violations.push(`第 ${i} 步「${items[i - 1].text}」前面还有未完成的第 ${blocked + 1} 步「${items[blocked].text}」——禁止先勾后面的步骤。工具报错/没有验证成功 = 没完成：不许打勾，把失败情况如实写进清单后继续推进或如实汇报。`)
          continue
        }
        items[i - 1].status = 'done'
      }
    }
    if (args.doing != null) mark(args.doing, 'doing')
    if (violations.length) {
      const done2 = items.filter((x) => x.status === 'done').length
      this.send({ type: 'plan', items: items.map((x) => ({ ...x })), done: done2, total: items.length })
      return { ok: false, message: `⚠️ 打勾被拒绝：\n${violations.join('\n')}\n\n当前清单：\n${items.map((x, i) => `${i + 1}. ${x.status === 'done' ? '[✅]' : x.status === 'doing' ? '[🔄]' : '[ ]'} ${x.text}`).join('\n')}` }
    }
    const done = items.filter((x) => x.status === 'done').length
    const next = items.findIndex((x) => x.status !== 'done')
    this.send({ type: 'plan', items: items.map((x) => ({ ...x })), done, total: items.length })
    const lines = items.map((x, i) => `${i + 1}. ${x.status === 'done' ? '[✅]' : x.status === 'doing' ? '[🔄]' : '[ ]'} ${x.text}`)
    // 原地打转护栏：状态与上一次完全相同 = 这次调用什么都没改变（真机变体：活干完了却反复重发相同状态）
    const sig = items.map((x) => x.status).join(',')
    if (sig === this.lastPlanSig) {
      // 分级（真机变体：模型每轮带 task_plan"报到"+同轮照常干活，硬拒绝反而让它困惑重发→真·循环）：
      // 同轮有真工具在干活 → 温和提示算通过；纯重发清单不干活 → 维持硬拒绝
      if (ctx.workingRound) {
        return { ok: true, message: '（task_plan 与上一次完全相同，属重复上报，已忽略——不用每轮重发清单，继续干活即可；完成一项再传 done:序号 打勾）' }
      }
      const stuck = next >= 0 ? items[next] : null
      let warn = `⚠️ 这次 task_plan 和上一次完全相同，清单没有任何变化——这是原地打转，被严格禁止。请核对实际进度：`
      if (stuck && stuck.status === 'doing') {
        warn += `第 ${next + 1} 项「${stuck.text}」的工作如果你已经做完（如文件已移动/下载成功），立刻传 done:${next + 1} 打勾推进；还没做完就去继续干活，而不是重发清单。`
      } else if (stuck) {
        warn += `第 ${next + 1} 项「${stuck.text}」还没完成，去执行它需要的工具调用，而不是重发清单。`
      } else {
        warn += `所有项都已完成，直接汇报收尾。`
      }
      this.lastPlanSig = sig
      return { ok: false, message: warn }
    }
    this.lastPlanSig = sig
    let msg = `任务清单已更新（${done}/${items.length} 完成）：\n${lines.join('\n')}`
    msg += next >= 0
      ? items[next].status === 'doing'
        ? `\n下一步：第 ${next + 1} 项「${items[next].text}」进行中——该项工作实际完成后，立刻调用 task_plan 传 done:${next + 1} 打勾并推进下一项；严禁重复执行已做过的工作。`
        : `\n下一步：第 ${next + 1} 项「${items[next].text}」——开工时调用 task_plan 传 doing:${next + 1}，完成后传 done:${next + 1}。`
      : `\n全部完成！现在可以汇报收尾了。`
    // 干完活不打卡护栏（真机变体：Qwen3-8B 下载完 29 张图后重发相同清单标 doing，就是不知道打勾）：
    // ①重发相同 items 且零新打勾；②干了一堆工具却从没勾过任何项
    const rebuiltSame = newTexts !== null && newTexts === oldTexts
    if (rebuiltSame && done === oldDone) {
      msg += `\n⚠️ 你重发了和当前完全相同的清单，而且没有新勾掉任何项——这次调用毫无意义。刚才完成的工作（已下载/已移动的文件）属于第几项就立刻传 done:序号，禁止用 doing 重标已经做完的活。`
    } else if (done === oldDone && toolsSince >= 3) {
      msg += `\n⚠️ 自上次清单更新已执行 ${toolsSince} 次工具但没有勾掉任何项：完成一项就传 done:一项，随干随勾，禁止全部堆到最后再补。`
    }
    this.toolsSincePlan = 0
    return { ok: true, message: msg }
  }

  // 给其它工具结果附一行进度提示（小模型每步都能"看一眼做到哪了"）
  planLine() {
    if (!this.plan || !Array.isArray(this.plan.items) || !this.plan.items.length) return ''
    const items = this.plan.items
    const done = items.filter((x) => x.status === 'done').length
    const next = items.findIndex((x) => x.status !== 'done')
    if (done >= items.length) return `[任务清单 ${done}/${items.length} 全部完成，可以汇报收尾]`
    const nxt = items[next]
    // 进行中的项提示"打勾推进"而不是"开工"，防止模型对着已完成的活反复开工
    return nxt.status === 'doing'
      ? `[任务清单 ${done}/${items.length}：第${next + 1}项「${nxt.text}」进行中——已做完就立刻传 done:${next + 1}]`
      : `[任务清单 ${done}/${items.length} 完成，下一步:第${next + 1}项 ${nxt.text}]`
  }

  // 收尾自动把任务进度写入小笔记本（会话目录下 notes.md）
  // 小笔记本跟着会话走：切换对话可续进度，删除对话自动清除（解决"只记不删"）
  appendWorkNote(finalMsg) {
    try {
      if (!this.historyDir) return
      const notesPath = path.join(this.historyDir, 'notes.md')
      let lastUser = ''
      for (let i = this.history.length - 1; i >= 0; i--) {
        const h = this.history[i]
        if (h.role === 'user' && !/^<tool_result/.test(h.content) && !/^（系统提示/.test(h.content)) {
          lastUser = String(h.content).replace(/\s+/g, ' ').trim().slice(0, 200)
          break
        }
      }
      const summary = String(finalMsg || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      const line = `\n## ${new Date().toLocaleString('zh-CN', { hour12: false })}\n- **请求**：${lastUser}\n- **结果**：${summary}\n`
      let existing = ''
      try { existing = fs.readFileSync(notesPath, 'utf8') } catch {}
      let next = (existing || '# 任务笔记（本对话）\n') + line
      if (next.length > 32 * 1024) next = '# 任务笔记（本对话）\n\n（更早的记录已自动截断）\n' + next.slice(-24 * 1024)
      fs.mkdirSync(this.historyDir, { recursive: true })
      fs.writeFileSync(notesPath, next, 'utf8')
    } catch {}
  }

  parseToolCalls(content) {
    let matches = [...String(content || '').matchAll(/```tool\s*([\s\S]*?)```/g)]
    if (!matches.length) {
      // 网页端兜底：页面重建拿不到语言标签时是裸 ```（或 ```json）围栏包 JSON →
      // 内容像工具调用（name + arguments 字段）就当 tool 块处理
      for (const m of String(content || '').matchAll(/```[ \t]*(?:json)?[ \t]*\n?([\s\S]*?)```/g)) {
        const body = m[1].trim()
        if (/^\{/.test(body) && /"name"[ \t]*:/.test(body) && /"arguments"[ \t]*:/.test(body)) matches.push(m)
      }
    }
    if (!matches.length) {
      // DSML 兼容（DeepSeek 网页版新版把内部工具标记文本化，长对话格式漂移时吐出）：
      // 真机形态 "< | | DSML | | invoke name=...>"（竖线/空格混排数量不定）→ 正则用 [\s|]* 全宽容
      // <|DSML|invoke name="xxx"> ... <|DSML|parameter name="p" string="?">value</|DSML|parameter> ... </|DSML|invoke>
      // string="false" 的值按 JSON 字面量还原（false/[1]/数字），"true" 或缺省按字符串
      const open = '<[\\s|]*DSML[\\s|]*invoke\\s+name\\s*=\\s*"([^"]+)"[\\s|]*>'
      const close = '<[\\s|]*\\/[\\s|]*DSML[\\s|]*invoke[\\s|]*>'
      for (const m of String(content || '').matchAll(new RegExp(`${open}([\\s\\S]*?)${close}`, 'g'))) {
        const name = m[1].trim()
        const args = {}
        const pRe = new RegExp('<[\\s|]*DSML[\\s|]*parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)<[\\s|]*\\/[\\s|]*DSML[\\s|]*parameter[\\s|]*>', 'g')
        for (const p of m[2].matchAll(pRe)) {
          const key = p[1].trim()
          const isStr = /string\s*=\s*"true"/.test(p[2])
          let val = p[3].trim()
          if (!isStr) { try { val = JSON.parse(val) } catch {} } // string="false"：值是 JSON 字面量（false/[1]/数字），解析失败就留原串
          args[key] = val
        }
        if (name) matches.push({ 1: JSON.stringify({ name, arguments: args }) })
      }
    }
    if (!matches.length) {
      // <tool_call> 标签（Qwen/GLM/Kimi 系漂移形态，真机截图实锤）：
      // <tool_call>list_dir(path="...", target="local")</tool_call> —— 函数调用风格，
      // 参数含中文引号/括号/数组 → parseToolCallArgs 括号感知切分；也容 JSON 形态标签体
      for (const m of String(content || '').matchAll(/<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/g)) {
        const body = m[1].trim()
        const fm = body.match(/^([a-zA-Z_][\w.]*)\s*\(([\s\S]*)\)\s*$/)
        if (fm && fm[1]) {
          matches.push({ 1: JSON.stringify({ name: fm[1], arguments: parseToolCallArgs(fm[2]) }) })
        } else {
          try {
            const obj = JSON.parse(body)
            if (obj && typeof obj.name === 'string') matches.push({ 1: JSON.stringify(obj) })
          } catch {}
        }
      }
    }
    if (!matches.length) return null
    const calls = []
    for (const m of matches) {
      try {
        const obj = JSON.parse(m[1].trim())
        if (!obj || typeof obj.name !== 'string') return [{ parseError: '缺少 name 字段' }]
        let args = obj.arguments || {}
        // DeepSeek 偶发把 arguments 双重编码成字符串（"arguments":"{\"path\":\"...\"}"）——
        // 不兜底 parse 的话所有参数全是 undefined：真机 create_folder/list_dir 连续 3 次全失败、
        // list_dir 收不到 path 返回了盘符列表，模型拿到的全是报错/错位数据 → 体感"网页版是瞎子"
        if (typeof args === 'string') {
          try { args = JSON.parse(args) } catch { args = {} }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
        // DeepSeek 习惯把 URL 写成行内代码（`https://...`）→ 不清洗则 web_fetch 必然解析失败/超时
        for (const k of ['url', 'baseUrl', 'apiUrl']) {
          if (typeof args[k] === 'string') args[k] = args[k].replace(/^[`'\s]+/, '').replace(/[`'\s]+$/, '')
        }
        calls.push({ name: obj.name, args })
      } catch (err) {
        return [{ parseError: `JSON 解析失败: ${err.message}` }]
      }
    }
    return calls
  }

  // 执行单个调用（供并行批次使用），返回结果摘要供顺序写历史
  async execOne(it, checkpointMsgIndex, prevFailedFingerprint) {
    const { call, callId } = it
    let result
    const t0 = Date.now()
    this.log(`[tool-start] ${call.name} ${JSON.stringify(call.args || {}).slice(0, 300)}`)
    try {
      result = await this.tools.execute(call.name, call.args)
    } catch (err) {
      result = { ok: false, message: `执行异常: ${err.message}` }
    }
    this.log(`[tool-end] ${call.name} ok=${result.ok} ${Date.now() - t0}ms`)
    if (result.ok && result.undo) {
      // 挂到当前检查点，供回滚
      const cp = this.checkpoints.find((c) => c.msgIndex === checkpointMsgIndex)
      if (cp) cp.undos.push(result.undo)
    }
    // 防呆：与上一次失败调用完全相同时，注入换方案提示，防止模型原地打转
    const fingerprint = call.name + ':' + JSON.stringify(call.args || {})
    let nudge = ''
    if (!result.ok && fingerprint === prevFailedFingerprint) {
      nudge = '\n（系统提示：你刚用完全相同的参数调用过该工具且再次失败。禁止再原样重试，必须换一种不同的方案：换路径/换工具/先创建目录再写入。）'
    }
    return { callId, name: call.name, ok: result.ok, message: result.message, nudge, fingerprint }
  }

  // 委派子任务：spawn 独立子Agent 执行，完成后合并 undo 并把总结返回给主Agent
  async execDelegate(it, checkpointMsgIndex) {
    const { call, callId } = it
    const fingerprint = call.name + ':' + JSON.stringify(call.args || {})
    const task = String((call.args && call.args.task) || '').trim()
    const title = String((call.args && call.args.title) || '').trim() || task.slice(0, 24)
    if (this.isChild) {
      return { callId, name: 'delegate', ok: false, message: '子Agent不能再委派其他Agent，请自己完成当前任务。', nudge: '', fingerprint }
    }
    if (!task) {
      return { callId, name: 'delegate', ok: false, message: '缺少 task 参数：必须给出自包含的完整任务描述。', nudge: '', fingerprint }
    }
    this.send({ type: 'delegate_start', delegateId: callId, title, task })
    this.log(`委派子任务: ${title}`)
    const child = new WorkAgent({
      client: this.client,
      tools: this.tools,
      snapshots: this.snapshots,
      tcpAgent: this.tcpAgent,
      getSetting: this.getSetting,
      setSetting: this.setSetting,
      // 只转发工具相关事件给 UI（带 delegateId 标记），子Agent的思考/正文流不转发
      send: (ev) => {
        if (['tool_call', 'tool_running', 'tool_result', 'tool_parse_error', 'error'].includes(ev.type)) {
          this.send({ ...ev, delegateId: callId })
        }
      },
      log: this.log,
      hostName: this.hostName,
      desktopDir: this.desktopDir,
      workspaceDir: this.workspaceDir,
      isChild: true
    })
    this.childAgents.push(child)
    try {
      const r = await child.sendUserMessage(task)
      // 子Agent的文件操作 undo 合并进父检查点，父级回滚可一并撤销
      const cp = this.checkpoints.find((c) => c.msgIndex === checkpointMsgIndex)
      if (cp) {
        for (const c of child.checkpoints) cp.undos.push(...c.undos)
      }
      if (this.aborted) {
        this.send({ type: 'delegate_done', delegateId: callId, ok: false, summary: '（主任务被停止，子任务中止）' })
        return { callId, name: 'delegate', ok: false, message: `子任务「${title}」因主任务停止而中止。`, nudge: '', fingerprint }
      }
      // 取子Agent最后的 assistant 回复作为总结
      let summary = ''
      for (let i = child.history.length - 1; i >= 0; i--) {
        if (child.history[i].role === 'assistant') {
          summary = child.history[i].content.replace(/```tool[\s\S]*?```/g, '').trim()
          break
        }
      }
      if (r.success) {
        this.send({ type: 'delegate_done', delegateId: callId, ok: true, summary })
        return {
          callId,
          name: 'delegate',
          ok: true,
          message: `子任务「${title}」已完成。子Agent总结：\n${summary || '（无总结）'}`,
          nudge: '',
          fingerprint
        }
      }
      this.send({ type: 'delegate_done', delegateId: callId, ok: false, summary: r.error || '未知错误' })
      return { callId, name: 'delegate', ok: false, message: `子任务「${title}」失败：${r.error || '未知错误'}`, nudge: '', fingerprint }
    } catch (err) {
      this.send({ type: 'delegate_done', delegateId: callId, ok: false, summary: err.message })
      return { callId, name: 'delegate', ok: false, message: `子任务「${title}」异常：${err.message}`, nudge: '', fingerprint }
    } finally {
      const i = this.childAgents.indexOf(child)
      if (i >= 0) this.childAgents.splice(i, 1)
    }
  }

  // 限流并行执行（保持结果顺序与输入一致）
  async runLimited(list, limit, fn) {
    const results = new Array(list.length)
    let idx = 0
    const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (idx < list.length) {
        const i = idx++
        results[i] = await fn(list[i])
      }
    })
    await Promise.all(workers)
    return results
  }

  // 冲突分组：同一设备上路径互不相关的调用分到同组并行执行，路径相关的按序串行
  groupParallel(items) {
    const norm = (p) => String(p).toLowerCase().replace(/\//g, '\\')
    const pathsOf = (call) => {
      const a = call.args || {}
      const arr = []
      for (const k of ['path', 'src', 'dest_dir', 'dir']) if (a[k]) arr.push(norm(a[k]))
      return arr
    }
    const related = (p1, p2) => {
      for (const a of p1) for (const b of p2) {
        if (a === b || a.startsWith(b + '\\') || b.startsWith(a + '\\')) return true
      }
      return false
    }
    const conflict = (c1, c2) => {
      // delegate 子任务彼此独立，永远可并行；但与普通工具保守串行（子任务路径未知，避免潜在冲突）
      if (c1.name === 'delegate' && c2.name === 'delegate') return false
      if (c1.name === 'delegate' || c2.name === 'delegate') return true
      const t1 = String((c1.args && c1.args.target) || 'local').toLowerCase()
      const t2 = String((c2.args && c2.args.target) || 'local').toLowerCase()
      if (t1 !== t2) return false // 不同设备天然不冲突
      return related(pathsOf(c1), pathsOf(c2))
    }
    const groups = []
    for (const it of items) {
      let placed = false
      for (const g of groups) {
        if (!g.some((other) => conflict(other.call, it.call))) {
          g.push(it)
          placed = true
          break
        }
      }
      if (!placed) groups.push([it])
    }
    return groups
  }

  // ===== 检查点回滚 =====
  // 回滚到 msgIndex 之前的状态：撤销其后所有文件操作（还原/删除/移回），
  // 并把聊天记录截断到该用户消息之前
  // undo 记录 → 受影响文件路径（回滚完成后发 file-changed 让工作台同步刷新，绝不显示旧内容）
  undoChangePaths(u) {
    if (!u) return []
    const out = []
    const snapPath = (id) => {
      if (!this.snapshots || !this.snapshots.list) return null
      const meta = (this.snapshots.list() || []).find((m) => m.id === id)
      return (meta && meta.originalPath) || null
    }
    try {
      switch (u.type) {
        case 'restore_snap': {
          const p = snapPath(u.snapId)
          if (p) out.push(p)
          break
        }
        case 'delete_local': out.push(u.path); break
        case 'move_back': out.push(u.src, u.dest); break
        case 'rename_back': out.push(u.oldPath, u.newPath); break
        case 'restore_snap_remote': {
          const p = snapPath(u.snapId)
          if (p) out.push(p)
          if (u.remotePath) out.push(u.remotePath)
          break
        }
        case 'delete_remote': out.push(u.path); break
        default: break
      }
    } catch {}
    return out.filter(Boolean)
  }
  // undo 记录 → 回滚确认清单条目（Trae 式："将被修改/将被删除/将移回" + 文件名）
  undoPreviewItem(u) {
    if (!u) return null
    const short = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '')
    switch (u.type) {
      case 'restore_snap': case 'restore_snap_remote': {
        const paths = this.undoChangePaths(u)
        const local = paths.find((p) => /^[a-zA-Z]:/.test(p)) // 本机盘符路径优先展示
        const p = local || paths[0]
        return p ? { action: u.type === 'restore_snap' ? '将被修改' : '将被修改（远程）', path: String(p), name: short(p) } : null
      }
      case 'delete_local': return u.path ? { action: '将被删除', path: String(u.path), name: short(u.path) } : null
      case 'delete_remote': return u.path ? { action: '将被删除（远程）', path: String(u.path), name: short(u.path) } : null
      case 'move_back': return u.src ? { action: '将移回原位', path: String(u.src), name: short(u.src) } : null
      case 'rename_back': return u.newPath ? { action: '将恢复原名', path: String(u.oldPath || u.newPath), name: short(u.oldPath || u.newPath) } : null
      default: return null
    }
  }
  // 回滚预览：这条消息之后会撤销哪些文件操作（渲染层弹 Trae 式确认卡用）
  rollbackPreview(msgIndex) {
    const targets = this.checkpoints.filter((c) => c.msgIndex >= msgIndex)
    const items = []
    for (const c of targets) for (const u of (c.undos || [])) {
      const it = this.undoPreviewItem(u)
      if (it) items.push(it)
    }
    return { count: items.length, items }
  }

  async rollbackTo(msgIndex) {
    if (this.running) return { success: false, error: 'AI 正在执行任务，请先停止' }
    const targets = this.checkpoints.filter((c) => c.msgIndex >= msgIndex)
    if (!targets.length) return { success: false, error: '该消息之前没有需要回滚的操作' }
    this.send({ type: 'rollback_start' })
    const results = []
    // 逆序撤销
    for (let i = targets.length - 1; i >= 0; i--) {
      const undos = targets[i].undos
      for (let j = undos.length - 1; j >= 0; j--) {
        const r = await this.tools.applyUndo(undos[j])
        results.push(r)
        this.log(`回滚: ${r.message}`)
        // 撤销落盘 → 工作台同步刷新（真实回退的最后一环：界面绝不残留旧内容）
        if (r && r.ok && typeof this.onFileChanged === 'function') {
          for (const p of this.undoChangePaths(undos[j])) { try { this.onFileChanged(p) } catch {} }
        }
      }
    }
    // 截断聊天与检查点（网页对话不重置：DeepSeek 网页无法删单条消息，重置=丢全部上下文纯累赘，
    // 老大拍板撤回只动本地，网页对话继续沿用保上下文）
    this.history = this.history.slice(0, msgIndex)
    this.checkpoints = this.checkpoints.filter((c) => c.msgIndex < msgIndex)
    // 任务清单板/防重创建档一并清掉：文件都回滚了，清单和"已创建过"记录不能残留（防回滚后模型状态错乱）
    this.plan = null
    this.createdPaths = new Set()
    this.toolsSincePlan = 0
    this.saveHistory()
    const failed = results.filter((r) => !r.ok).length
    this.send({ type: 'history_updated' })
    return { success: true, undone: results.length, failed }
  }

  // ===== 审批 =====
  waitApproval(approvalId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(approvalId)
        resolve(false)
      }, APPROVAL_TIMEOUT)
      this.pendingApprovals.set(approvalId, {
        resolve: (ok) => {
          clearTimeout(timer)
          this.pendingApprovals.delete(approvalId)
          resolve(ok)
        }
      })
    })
  }

  approve(approvalId, ok) {
    const pending = this.pendingApprovals.get(approvalId)
    if (pending) {
      pending.resolve(!!ok)
      return true
    }
    // 子Agent内部的风险操作审批：沿子Agent链转发
    for (const child of this.childAgents) {
      if (child.approve(approvalId, ok)) return true
    }
    return false
  }

  rejectAllApprovals() {
    for (const [, pending] of this.pendingApprovals) pending.resolve(false)
    this.pendingApprovals.clear()
  }

  // ===== 中途向用户提问（ask_user 工具）=====
  waitAsk(askId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(askId)
        resolve(null) // 超时：null = 用户没有回答
      }, APPROVAL_TIMEOUT)
      this.pendingAsks.set(askId, {
        resolve: (payload) => {
          clearTimeout(timer)
          this.pendingAsks.delete(askId)
          resolve(payload)
        }
      })
    })
  }

  // payload: { cancelled: true } 或 { answers: [{ selected: ['标签'], other: '文本' }] }
  resolveAsk(askId, payload) {
    const pending = this.pendingAsks.get(askId)
    if (pending) {
      pending.resolve(payload || { cancelled: true })
      return true
    }
    // 子Agent的提问：沿子Agent链转发
    for (const child of this.childAgents) {
      if (child.resolveAsk(askId, payload)) return true
    }
    return false
  }

  rejectAllAsks() {
    for (const [, pending] of this.pendingAsks) pending.resolve(null)
    this.pendingAsks.clear()
  }

  // ===== 停止 =====
  abort() {
    if (!this.running) return { success: false, error: '当前没有运行中的任务' }
    this.aborted = true
    if (this.abortController) this.abortController.abort()
    this.rejectAllApprovals()
    this.rejectAllAsks()
    // 网页版对话等待中：直接放行结束（网页里那条消息会留在网页自己的会话里，不影响本应用）
    if (this._webChatResolve) {
      const resolve = this._webChatResolve
      this._webChatResolve = null
      resolve({ error: '已停止' })
    }
    // 联动终止所有运行中的子Agent
    for (const child of this.childAgents) {
      try { child.abort() } catch {}
    }
    return { success: true }
  }

  // 可被 abort 打断的等待：429 限流无限重试的长等期间，用户点停止要立即生效而不是干等满 60 秒
  _sleepAbortable(ms) {
    return new Promise((resolve) => {
      const sig = this.abortController ? this.abortController.signal : null
      if (sig && sig.aborted) return resolve()
      let timer = null
      const onAbort = () => { if (timer) clearTimeout(timer); resolve() }
      timer = setTimeout(() => {
        if (sig) sig.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      if (sig) sig.addEventListener('abort', onAbort, { once: true })
    })
  }

  // ===== 快照 =====
  listSnapshots() {
    return this.snapshots.list()
  }

  restoreSnapshot(id) {
    return this.snapshots.restore(id)
  }

  deleteSnapshot(id) {
    return this.snapshots.remove(id)
  }
}

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 10) return '****'
  return key.slice(0, 5) + '****' + key.slice(-4)
}

module.exports = { WorkAgent, DEFAULT_MODEL, parseModelRoute, extractJsonAt, rebuildWebToolFences }
