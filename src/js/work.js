// ============================================
// MSWork AI 助手渲染层（从 app.js 拆出，v2.7.12 模块化）
// 依赖 app.js 的全局环境（state/_api/工具函数），加载顺序必须在 app.js 之后
// ============================================

// ============================================
// MSWork AI 助手（Work 模式）
// 检查点回滚：用户消息 = 检查点，回滚会还原文件并撤回对话
// ============================================
const AI_PROVIDERS = {
  siliconflow: {
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1'
  },
  msmate: {
    name: 'MSMate 内置（扣积分）',
    baseUrl: '' // 动态：登录账号 + 服务端代理，无需手动配置
  },
  deepseek: {
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1'
  },
  zhipu: {
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1'
  },
  custom: { name: '自定义（OpenAI 兼容）', baseUrl: '' }
}
// 常用模型清单由用户自己维护（设置里 ➕ 添加 / 🗑 删除），存 settings：chatModelList / visionModelList

const EMPTY_CHAT_HTML = `<div class="empty-state"><div class="empty-title">我是 MSMate 助手</div><div class="empty-hint">让我帮你复制/移动/创建/编辑文件<br>本机和已连接设备都行，试试看喵</div></div>`

// 空状态按主题出形象：莫西主题换成莫西立绘+人设语气（三无简洁风），其他主题保持通用文案
function emptyChatHtml() {
  try {
    if (document.documentElement.classList.contains('theme-moxi')) {
      return '<div class="empty-state moxi-empty"><img class="moxi-empty-img" src="../assets/moxi/emotion-eager.webp" alt="莫西"><div class="empty-title">我是莫西</div><div class="empty-hint">任务交给我。<br>本机和已连接设备的文件，都能处理。</div></div>'
    }
  } catch {}
  return EMPTY_CHAT_HTML
}

// 主题热切换时空状态跟随换装（正在显示空状态才重建）+ 莫西默认背景跟随主题
document.addEventListener('theme-changed', () => {
  try {
    if (typeof applyAppearance === 'function') applyAppearance()
    if (typeof curChatEl !== 'function') return
    const cur = curChatEl()
    if (cur && cur.querySelector(':scope > .empty-state')) cur.innerHTML = emptyChatHtml()
  } catch {}
})

// ===== 多会话：每个会话独立的渲染状态，后台会话的 AI 流也实时渲染到自己的容器 =====
const SESS_KEYS = ['running', 'curAssistant', 'curContent', 'curReasoning', 'toolCards', 'roundSteps', 'stickToBottom', 'rollbackArmed', 'restoreArmed']

function makeSessState(sid) {
  return {
    sid, loaded: false, el: null, // el: 该会话的聊天容器（#chatList 内，切换=显隐）
    running: false, curAssistant: null, curContent: '', curReasoning: '',
    toolCards: new Map(), roundSteps: [], stickToBottom: true,
    rollbackArmed: null, restoreArmed: null
  }
}

const work = {
  mode: 'link',
  // 多会话
  sessions: new Map(),  // sessionId -> 渲染状态
  active: null,         // 当前查看的会话 id
  sessionList: [],      // 后端会话元数据缓存
  _ctx: null,           // 当前渲染上下文（后台会话事件到达时临时切换）
  config: { approvalMode: 'manual', rules: [] },
  rules: [],
  memory: [],
  genMode: null,        // 直连生成模式（'image'|'video'），✨上滑菜单选择
  genRatio: ''          // 直连生图画幅比例（'16:9' 等，''=默认方图），仅 image 模式生效
}
// 代理：旧代码里的 work.curAssistant / work.running 等直接落到"当前渲染上下文"
for (const k of SESS_KEYS) {
  Object.defineProperty(work, k, {
    get() { return work._ctx ? work._ctx[k] : undefined },
    set(v) { if (work._ctx) work._ctx[k] = v }
  })
}
work._ctx = makeSessState('__boot__') // 启动兜底，激活会话后替换

function sessState(sid) {
  if (!work.sessions.has(sid)) work.sessions.set(sid, makeSessState(sid))
  return work.sessions.get(sid)
}

// 临时切换渲染上下文：后台会话的事件复用同一套渲染函数
function withSession(sid, fn) {
  const prev = work._ctx
  work._ctx = sessState(sid)
  try { fn() } finally { work._ctx = prev }
}

// 当前渲染上下文对应的聊天容器（自动挂载到 #chatList，非活动会话保持隐藏）
function curChatEl() {
  const st = work._ctx || sessState(work.active)
  if (!st.el) {
    const div = document.createElement('div')
    div.className = 'chat-session'
    div.innerHTML = emptyChatHtml()
    st.el = div
  }
  const list = $('chatList')
  if (list && st.el.parentNode !== list) {
    // 挂载会话容器时，清掉 index.html 写死的初始空状态（否则会和新会话的空状态叠两层）
    list.querySelectorAll(':scope > .empty-state').forEach((n) => n.remove())
    list.appendChild(st.el)
  }
  st.el.classList.toggle('hidden', st.sid !== work.active)
  return st.el
}

const TOOL_ICONS = {
  list_dir: 'folder-open', read_file: 'book-open', write_file: 'square-pen', create_folder: 'folder-plus',
  copy_path: 'clipboard', move_path: 'arrow-right-left', rename_path: 'tag', delete_path: 'trash-2',
  search_files: 'search', create_word: 'file-pen', read_word: 'file-text',
  generate_image: 'paintbrush', generate_video: 'video',
  open_url: 'globe', open_path: 'rocket'
}

// ✨菜单画幅快捷比例 → 硅基流动 image_size（v2.4.83）；胶囊显示比例、发送传尺寸
const GEN_RATIO_SIZE = { '1:1': '1024x1024', '16:9': '1280x720', '9:16': '720x1280', '4:3': '1024x768', '3:4': '768x1024' }

function initWorkMode() {
  const chatList = $('chatList')

  // --- 模式切换 ---
  const slider = $('modeSlider')
  const linkSections = $('linkModeSections')
  const workSection = $('workSection')
  const setMode = (mode) => {
    work.mode = mode
    try { localStorage.setItem('msmate_last_mode', mode) } catch {}
    const isWork = mode === 'work'
    $('modeLink').classList.toggle('active', !isWork)
    $('modeWork').classList.toggle('active', isWork)
    slider.classList.toggle('work', isWork) // 滑块背景块滑到 Work 一侧
    document.body.classList.toggle('work-wide', isWork) // 侧栏拉宽给聊天框，双面板让位
    document.body.classList.toggle('work-mode', isWork) // 工作台/资源面板/分割条开关
    applyWorkPaneLayout(isWork) // 本地/远程面板搬进资源面板页签（DOM 移动保留全部监听）
    linkSections.classList.toggle('hidden', isWork)
    workSection.classList.toggle('hidden', !isWork)
  }
  $('modeLink').addEventListener('click', () => setMode('link'))
  $('modeWork').addEventListener('click', () => setMode('work'))

  // --- 滚动跟随：输出期间用户可向上翻历史，靠近底部才自动跟随 ---
  chatList.addEventListener('scroll', () => {
    work.stickToBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 60
  })

  // --- 聊天输入 ---
  const chatInput = $('chatInput')
  // 聊天框/聊天记录内选文也能「添加到对话」（走引用胶囊体系）
  attachWbTextQuote(chatInput, '聊天记录')
  attachWbTextQuote(chatList, '聊天记录')
  const doSend = () => {
    if (work.running) {
      _api.aiAbort(work.active)
      return
    }
    const text = chatInput.value.trim()
    let full = [text, chatRefList.join('\n')].filter(Boolean).join('\n')
    let genRefImages = []
    let genBatch = ''
    if (work.genMode === 'image') {
      // v2.4.84 参考图直通：图片模式下聊天框里的本地图片胶囊自动作为参考图（≤3张，图生图/多图合成）；
      // [引用文件: …] 协议文本会污染画面描述，不拼进 prompt；非图片引用对生图无意义，剔除并提示
      genRefImages = chatRefList.map(refImagePath).filter(Boolean)
      const skipped = chatRefList.length - genRefImages.length
      if (genRefImages.length > 3) { genRefImages.length = 3; showToast('参考图最多 3 张，已只取前 3 张', 'info') }
      if (skipped > 0) showToast(`${skipped} 个非图片引用已忽略（仅图片可作为参考图）`, 'info')
      if (!text) { showToast(genRefImages.length ? '请描述想怎么用这些参考图生成画面' : '描述不能为空', 'info'); return }
      full = text
      // v2.4.85 张数：菜单选了用菜单的（没选传空由 agent 从描述解析）；v2.4.90 编辑模式也支持多张（逐张补齐）
      genBatch = work.genCount || ''
      if (genRefImages.length && parseInt(genBatch, 10) > 1) showToast(`参考图编辑将连续生成 ${genBatch} 张变体（逐张生成，稍慢）`, 'info')
    }
    if (!full) return
    chatInput.value = ''
    fitChatInput()
    chatRefList.length = 0
    const genMode = work.genMode || null
    // v2.4.85 模式保持：生成模式发送后不再自动清除（连续生图/改图/反复迭代不用重选）；
    // 胶囊上的 × 随时手动关；renderChatRefs 刷胶囊
    renderChatRefs()
    setChatRunning(true)
    work.stickToBottom = true
    // 生成模式直连：上滑菜单选了生图/生视频 → 直接调生成管线（不走工具循环）
    // v2.4.83：图片模式带画幅比例（菜单快捷选择 → 尺寸），没选=空（agent 从提示词解析或默认方图）
    // v2.4.84：图片模式带参考图（有图=图生图/多图合成，无图=文生图）
    // v2.4.85：带张数 batch + 润色开关 polish（关=传 false）
    const call = genMode === 'image' ? _api.aiGenerateImage(work.active, full, GEN_RATIO_SIZE[work.genRatio] || '', genRefImages, genBatch, work.genPolish === false ? false : undefined, work.genSteps || '30')
      : genMode === 'video' ? _api.aiGenerateVideo(work.active, full)
      : _api.aiSend(full, work.active)
    call
      .catch((err) => appendChatError(`发送失败: ${err.message}`))
      .finally(() => setChatRunning(false))
  }

  // --- 生成模式（加号左边 ✨ 上滑菜单：生图免费 / 生视频付费）---
  function setGenMode(mode) {
    work.genMode = mode
    chatInput.placeholder = mode === 'image'
      ? '描述你想生成的画面…（主体/风格/构图/光线，Enter 发送）'
      : '描述视频内容：主体+动作+场景+镜头…（Enter 发送，生成约 2-10 分钟）'
    if (mode === 'image') showToast('提示：拖图片进聊天框，发送时自动作为参考图（图生图，最多3张）', 'info')
    renderChatRefs()
  }
  function clearGenMode() {
    if (!work.genMode) return
    work.genMode = null
    chatInput.placeholder = '让 AI 帮你干活…（Enter 发送，拖文件进来可引用）'
    renderChatRefs()
  }
  const genMenu = $('chatGenMenu')
  if (genMenu) {
    $('chatGenBtn').addEventListener('click', (e) => {
      e.stopPropagation()
      genMenu.classList.toggle('hidden')
    })
    genMenu.addEventListener('click', (e) => e.stopPropagation())
    genMenu.querySelectorAll('.gen-menu-item').forEach((item) => {
      item.addEventListener('click', () => {
        setGenMode(item.dataset.mode)
        genMenu.classList.add('hidden')
        chatInput.focus()
      })
    })
    // 画幅比例行（v2.4.83）：点比例=想生图，自动带上图片生成模式；不关菜单方便再选
    const genRatioRow = $('chatGenRatio')
    if (genRatioRow) {
      genRatioRow.querySelectorAll('.gr-btn').forEach((b) => {
        b.addEventListener('click', () => {
          work.genRatio = b.dataset.ratio || ''
          genRatioRow.querySelectorAll('.gr-btn').forEach((x) => x.classList.toggle('active', x === b))
          setGenMode('image')
        })
      })
    }
    // 张数行 + 润色开关（v2.4.85）：张数同比例逻辑（自动/1/2/4）；润色点一下切换开关态（默认开）
    const genCountRow = $('chatGenCount')
    if (genCountRow) {
      genCountRow.querySelectorAll('.gr-btn[data-count]').forEach((b) => {
        b.addEventListener('click', () => {
          work.genCount = b.dataset.count || ''
          genCountRow.querySelectorAll('.gr-btn[data-count]').forEach((x) => x.classList.toggle('active', x === b))
          setGenMode('image')
        })
      })
      // 润色开关（v2.4.85 张数行末尾 → v2.4.90 质量行末尾）
      const polishBtn = genMenu.querySelector('#chatGenPolish')
      if (polishBtn) {
        work.genPolish = true // 默认开：主模型先把口语扩写成结构化提示词再喂图片模型
        polishBtn.addEventListener('click', () => {
          work.genPolish = !work.genPolish
          polishBtn.classList.toggle('active', work.genPolish)
          showToast(work.genPolish ? '提示词润色已开：发送前主模型先扩写描述' : '提示词润色已关：原始描述直出', 'info')
        })
      }
    }
    // 质量档位行（v2.4.89 老大拍板）：低30/中50/高100，默认低30；同比例/张数逻辑（点了自动带图片模式）
    const genQualityRow = $('chatGenQuality')
    if (genQualityRow) {
      genQualityRow.querySelectorAll('.gr-btn').forEach((b) => {
        b.addEventListener('click', () => {
          work.genSteps = b.dataset.steps || '30'
          genQualityRow.querySelectorAll('.gr-btn').forEach((x) => x.classList.toggle('active', x === b))
          setGenMode('image')
        })
      })
    }
    document.addEventListener('click', () => genMenu.classList.add('hidden'))
  }
  $('chatSend').addEventListener('click', doSend)
  // Enter 发送；Shift+Enter / Ctrl+Enter 换行（Ctrl+Enter 在光标处插换行）
  const insertAtCursor = (el, text) => {
    const s = el.selectionStart ?? el.value.length
    const epos = el.selectionEnd ?? s
    el.value = el.value.slice(0, s) + text + el.value.slice(epos)
    const np = s + text.length
    el.setSelectionRange(np, np)
    el.focus()
  }
  chatInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    if (e.ctrlKey) {
      e.preventDefault()
      insertAtCursor(chatInput, '\n')
      return
    }
    if (!e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  })

  // --- 拖拽文件引用：拖入的文件/文件夹变成输入框上方的"引用胶囊"（图标+名称+×删除）， ---
  // --- 不会被打字误删；发送时自动以 [引用文件: 路径] 格式拼进消息，AI 协议不变 ---
  // （refIcon/refChipMeta 为顶层共享函数，用户消息渲染也用）
  const chatRefList = []
  const chatRefsEl = $('chatRefs')

  function renderChatRefs() {
    chatRefsEl.innerHTML = ''
      // 生成模式胶囊（上滑菜单选中的生图/生视频模式，× 取消；v2.4.85 发送后保持，手动 × 才退）
      if (work.genMode) {
        const gm = document.createElement('span')
        gm.className = 'chat-ref-chip gen-mode-chip'
        // v2.4.84：图片模式下统计本地图片胶囊数，提示将作为参考图
        const refCnt = work.genMode === 'image' ? chatRefList.map(refImagePath).filter(Boolean).length : 0
        // v2.4.85：张数（自动/1/2/4）+ 润色开关态；v2.4.89：质量档位（非默认 30 时显示）
        const cntTxt = work.genMode === 'image' && work.genCount ? ` · ${work.genCount}张` : ''
        const polishTxt = work.genMode === 'image' ? (work.genPolish === false ? ' · 润色关' : '') : ''
        const stepsTxt = work.genMode === 'image' && work.genSteps && work.genSteps !== '30' ? ` · ${work.genSteps}步` : ''
        gm.title = work.genMode === 'image'
        ? (refCnt ? `当前为图生图：${refCnt} 张参考图将随描述一起发送；点 × 取消模式` : '当前为图片生成模式；拖图片进来可自动作为参考图（图生图，最多3张）')
        : '当前为生成模式，发送的内容将直接作为生成描述；点 × 取消'
        gm.innerHTML = `<span>${work.genMode === 'image' ? `图片生成模式${work.genRatio ? ' · ' + work.genRatio : ''}${cntTxt}${polishTxt}${stepsTxt}${refCnt ? ` · 参考图×${refCnt}` : ''}` : '视频生成模式'}</span><span class="chip-x" title="取消生成模式">×</span>`
        gm.querySelector('.chip-x').addEventListener('click', clearGenMode)
        chatRefsEl.appendChild(gm)
      }
    chatRefList.forEach((ref, i) => {
      const meta = refChipMeta(ref)
      const chip = document.createElement('span')
      chip.className = 'chat-ref-chip' + (meta.remote ? ' remote' : '')
      chip.title = meta.title
      const icon = document.createElement('span')
      icon.className = 'ref-icon'
      icon.innerHTML = meta.icon // meta.icon 是 SVG 串，textContent 会显示源码（2.7.1 补修）
      const name = document.createElement('span')
      name.className = 'ref-name'
      name.textContent = meta.name
      const x = document.createElement('span')
      x.className = 'ref-x'
      x.textContent = '×'
      x.title = '移除引用'
      x.addEventListener('click', () => {
        chatRefList.splice(i, 1)
        renderChatRefs()
        chatInput.focus()
      })
      chip.append(icon, name, x)
      // 图片生成模式下本地图片胶囊自动作为参考图（v2.4.84），加小标识区分普通文件引用
      if (work.genMode === 'image' && refImagePath(ref)) {
        const tag = document.createElement('span')
        tag.className = 'ref-tag'
        tag.textContent = '参考图'
        tag.title = '图片生成模式下，这张图会作为参考图发给编辑模型（图生图）'
        chip.insertBefore(tag, x)
      }
      chatRefsEl.appendChild(chip)
    })
  }

  function appendChatRef(ref) {
    if (chatRefList.includes(ref)) return // 同一文件只引用一次
    chatRefList.push(ref)
    renderChatRefs()
    chatInput.focus()
  }
  // 工作台等模块从外部追加引用胶囊
  work._appendChatRef = (ref) => appendChatRef(ref)
  // v2.4.85：外部模块带生成模式（图片编辑器「发送到对话框」自动切图片模式，编辑图直接是参考图）
  work._setGenMode = (mode) => setGenMode(mode)
  // --- Ctrl+V 粘贴图片：剪贴板有图就存文件挂引用胶囊（截图工具/微信复制的图直接粘进来）---
  chatInput.addEventListener('paste', async (e) => {
    try {
      const items = (e.clipboardData && e.clipboardData.items) || []
      const hasImg = Array.from(items).some((it) => it.type && it.type.startsWith('image/'))
      if (!hasImg || !_api.saveClipboardImage) return // 纯文本粘贴走默认行为
      e.preventDefault()
      const r = await _api.saveClipboardImage()
      if (r && r.ok && r.path) appendChatRef(r.path)
      else showToast((r && r.error) || '粘贴图片失败', 'error')
    } catch (err) { console.error('[paste-img]', err) }
  })
  // 输入框为空时按退格 = 删除最后一个引用胶囊
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !chatInput.value && chatRefList.length) {
      e.preventDefault()
      chatRefList.pop()
      renderChatRefs()
    }
  })

  // --- 下载进度条：聊天框上方实时显示 AI 的下载任务，用户可随时取消 ---
  const dlBarEl = $('dlBar')
  const dlItems = new Map() // id -> {fileName, received, total, state: 'run'|'ok'|'fail', message}

  function fmtSize(n) {
    if (!n || n <= 0) return ''
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    return (n / 1024).toFixed(0) + ' KB'
  }

  function renderDlBar() {
    dlBarEl.innerHTML = ''
    if (!dlItems.size) return
    for (const [id, it] of dlItems) {
      const row = document.createElement('div')
      row.className = 'dl-item' + (it.state !== 'run' ? ' ' + it.state : '')
      const info = document.createElement('div')
      info.className = 'dl-info'
      const name = document.createElement('span')
      name.className = 'dl-name'
      name.textContent = it.fileName
      name.title = it.message || it.fileName
      const stat = document.createElement('span')
      stat.className = 'dl-stat'
      if (it.state === 'run') {
        const pct = it.total ? Math.min(100, Math.round((it.received / it.total) * 100)) : null
        stat.textContent = pct != null ? `${pct}% · ${fmtSize(it.received)}/${fmtSize(it.total)}` : fmtSize(it.received) || '连接中…'
      } else {
        stat.textContent = it.state === 'ok' ? '完成' : (it.cancelled ? '已取消' : '失败')
      }
      info.append(name, stat)
      row.appendChild(info)
      // 进度条
      const track = document.createElement('div')
      track.className = 'dl-track'
      const fill = document.createElement('div')
      fill.className = 'dl-fill' + (it.state !== 'run' ? ' ' + it.state : '')
      const pct = it.total ? Math.min(100, (it.received / it.total) * 100) : (it.state === 'ok' ? 100 : 8)
      fill.style.width = (it.state === 'fail' ? 100 : pct) + '%'
      track.appendChild(fill)
      row.appendChild(track)
      // 取消按钮（仅进行中）
      if (it.state === 'run') {
        const x = document.createElement('span')
        x.className = 'dl-x'
        x.textContent = '×'
        x.title = '取消这个下载'
        x.addEventListener('click', () => { try { _api.cancelDownload(id) } catch {} })
        row.appendChild(x)
      }
      dlBarEl.appendChild(row)
    }
  }

  if (_api.onDownloadProgress) {
    _api.onDownloadProgress((info) => {
      if (!info || !info.id) return
      if (info.type === 'start') {
        dlItems.set(info.id, { fileName: info.fileName || '下载任务', received: 0, total: 0, state: 'run' })
      } else if (info.type === 'progress') {
        const it = dlItems.get(info.id)
        if (it) { it.received = info.received || 0; it.total = info.total || 0 }
      } else if (info.type === 'end') {
        const it = dlItems.get(info.id)
        if (it) {
          it.state = info.ok ? 'ok' : 'fail'
          it.cancelled = !!info.cancelled
          it.message = info.message || ''
          it.received = info.size || it.received
          it.total = info.size || it.total
          setTimeout(() => { dlItems.delete(info.id); renderDlBar() }, info.ok ? 1500 : 4000)
        }
      }
      renderDlBar()
    })
  }
  // --- 输入框动态增高：随内容长高方便改稿，上限 40vh 超出内部滚动；发送/清空/回填后重算 ---
  const fitChatInput = () => {
    const max = Math.max(110, Math.round(window.innerHeight * 0.4))
    chatInput.style.maxHeight = max + 'px'
    chatInput.style.height = 'auto'
    chatInput.style.height = Math.min(chatInput.scrollHeight, max) + 'px'
  }
  chatInput.addEventListener('input', fitChatInput)
  window.addEventListener('resize', fitChatInput)
  fitChatInput()

  // 拖文件引用：热区 = 整个输入行（textarea/胶囊/按钮都算）+ 聊天消息区
  const inputRow = chatInput.closest('.chat-input-row')
  const addRefsFromDrop = (e) => {
    // 1) 本软件文件面板内拖入
    try {
      const raw = e.dataTransfer.getData('application/json')
      if (raw) {
        const data = JSON.parse(raw)
        if (data && Array.isArray(data.items)) {
          if (data.source === 'remote') state.remoteDragConsumed = true // 已作为引用消费，不要触发 dragend 的下载
          for (const it of data.items) {
            if (!it || !it.path) continue
            if (data.source === 'remote') {
              appendChatRef(`[引用远程文件: ${data.deviceName || '远程设备'}|${data.deviceId || ''}|${it.path}]`)
            } else {
              appendChatRef(`[引用文件: ${it.path}]`)
            }
          }
          return true
        }
      }
    } catch {}
    // 2) 系统外部（资源管理器/桌面）拖入
    const paths = getExternalDroppedPaths(e.dataTransfer)
    let hit = false
    for (const p of paths) { appendChatRef(`[引用文件: ${p.path}]`); hit = true }
    if (hit) return true
    // 3) 微信/QQ 拖文字消息（或任意文本拖入）：走引用块，AI 能看出这是引用的聊天记录
    const dragText = (e.dataTransfer.getData('text/plain') || '').trim()
    if (dragText) {
      const html = (e.dataTransfer.getData('text/html') || '').trim()
      // 微信/QQ 常塞富文本：剥壳取纯文本，取不到就退回 plain
      const fromHtml = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
      const text = (fromHtml.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()) || dragText
      appendChatRef(buildQuoteRef('聊天记录', text))
      showToast('已把聊天记录加入对话（引用块）', 'success')
      return true
    }
    return false
  }
  const bindChatDropZone = (el) => {
    if (!el) return
    el.addEventListener('dragover', (e) => {
      const types = e.dataTransfer.types || []
      // Files=外部文件；application/json=本软件内部；text=微信/QQ 拖文字消息
      const ok = types.includes('Files') || types.includes('application/json') || types.includes('text/plain') || types.includes('text/html')
      if (!ok) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      inputRow.classList.add('drag-over')
    })
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) inputRow.classList.remove('drag-over')
    })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation() // 避免触发全局 drop / 面板互传逻辑
      inputRow.classList.remove('drag-over')
      addRefsFromDrop(e)
    })
  }
  bindChatDropZone(inputRow)
  bindChatDropZone($('chatList'))

  // --- ➕ 选择文件引用：和拖拽等价，纯 UI 入口 ---
  $('chatAttachBtn').addEventListener('click', async () => {
    try {
      const files = await _api.selectFiles()
      if (Array.isArray(files)) for (const p of files) appendChatRef(`[引用文件: ${p}]`)
    } catch {}
  })

  // --- 语音输入：MediaRecorder 录音 → 硅基流动 ASR（SenseVoiceSmall）→ 文本插入输入框 ---
  // 两种触发：点麦克风开始/结束；聊天界面内按住 V 说话，松开自动转文字（微信式）
  const voiceBtn = $('voiceInputBtn')
  const voice = { rec: null, stream: null, active: false, startTs: 0, chunks: [] }
  const setVoiceUI = (on) => {
    voiceBtn.classList.toggle('recording', on)
    chatInput.placeholder = on
      ? '正在听写…（再点麦克风或松开 V 结束）'
      : '让 AI 帮你干活…（Enter 发送，拖文件进来可引用）'
  }
  async function startVoiceInput() {
    if (voice.active) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      voice.stream = stream
      voice.chunks = []
      voice.startTs = Date.now()
      const rec = new MediaRecorder(stream)
      rec.ondataavailable = (e) => { if (e.data && e.data.size) voice.chunks.push(e.data) }
      rec.onstop = () => finishVoiceInput()
      rec.start()
      voice.rec = rec
      voice.active = true
      setVoiceUI(true)
    } catch (err) {
      showToast(`麦克风不可用: ${err.message}`, 'error')
    }
  }
  function stopVoiceInput() {
    if (!voice.active) return
    voice.active = false
    setVoiceUI(false)
    try { if (voice.rec && voice.rec.state !== 'inactive') voice.rec.stop() } catch {}
  }
  async function finishVoiceInput() {
    const dur = Date.now() - voice.startTs
    try { if (voice.stream) voice.stream.getTracks().forEach((t) => t.stop()) } catch {}
    voice.stream = null
    voice.rec = null
    if (dur < 600 || !voice.chunks.length) return // 太短当误触
    const blob = new Blob(voice.chunks, { type: (voice.chunks[0] && voice.chunks[0].type) || 'audio/webm' })
    voice.chunks = []
    voiceBtn.classList.add('transcribing')
    try {
      const data = new Uint8Array(await blob.arrayBuffer())
      const res = await _api.aiVoiceTranscribe({ data, mime: blob.type })
      if (res && res.ok && res.text) {
        insertAtCursor(chatInput, res.text + ' ')
        chatInput.dispatchEvent(new Event('input')) // 动态增高重算
      } else {
        showToast((res && res.message) || '语音识别失败', 'error')
      }
    } catch (err) {
      showToast(`语音识别失败: ${err.message}`, 'error')
    } finally {
      voiceBtn.classList.remove('transcribing')
      chatInput.focus()
    }
  }
  voiceBtn.addEventListener('click', () => (voice.active ? stopVoiceInput() : startVoiceInput()))
  // V 键按住说话：仅 Work 聊天界面可见时生效；焦点在其它输入框不抢键；中文输入法组词中（isComposing）不抢键
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'v' && e.key !== 'V') return
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return
    if (e.isComposing) return // 拼音打字中的 v 是字母，不是热键
    if (work.mode !== 'work' || $('workSection').classList.contains('hidden')) return
    const t = e.target
    if (t !== chatInput && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (voice.active) return
    e.preventDefault()
    startVoiceInput()
  })
  document.addEventListener('keyup', (e) => {
    if ((e.key === 'v' || e.key === 'V') && voice.active) {
      e.preventDefault()
      stopVoiceInput()
    }
  })
  window.addEventListener('blur', () => { if (voice.active) stopVoiceInput() })

  // --- 顶栏按钮 + 会话条 ---
  $('aiNewChatBtn').addEventListener('click', createNewSession)
  $('aiSettingsBtn').addEventListener('click', openAiSettings)
  // 全局设置（外观 / 互联与传输 / 设备 / 关于）
  initGlobalSettings()
  $('aiApprovalTag').addEventListener('click', (e) => { e.stopPropagation(); showApprovalMenu() })
  document.addEventListener('click', (e) => { // 点外部关闭控制模式菜单
    const m = $('aiApprovalMenu')
    if (m && !m.classList.contains('hidden') && !m.contains(e.target)) m.classList.add('hidden')
  })
  fillQuickModelSelect() // v0.4：自绘模型菜单（按钮+菜单的事件在函数内绑定一次）
  initBrowserCtlBridge() // browser_* 网页控制：主进程桥回执（AI 受控页签）
  // --- 内置截图：按钮入口 + 成品自动注入聊天引用（存工作区「截图」+ 剪贴板已同时写入）---
  const capBtn = $('chatCaptureBtn')
  if (capBtn) capBtn.addEventListener('click', () => { if (_api.captureStart) _api.captureStart() })
  if (_api.onCaptureInject) _api.onCaptureInject(({ path }) => {
    if (typeof work._appendChatRef === 'function' && path) work._appendChatRef(path)
  })
  const sessionMenu = $('sessionMenu')
  $('sessionBarBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    renderSessionMenu()
    sessionMenu.classList.toggle('hidden')
  })
  document.addEventListener('click', (e) => {
    if (!sessionMenu.classList.contains('hidden') && !$('sessionBar').contains(e.target)) {
      sessionMenu.classList.add('hidden')
    }
  })

  // --- 弹窗 ---
  $('aiSettingsCancel').addEventListener('click', () => $('aiSettingsModal').classList.add('hidden'))
  $('aiSettingsSave').addEventListener('click', saveAiSettings)
  // 设置内左侧导航切换
  document.querySelectorAll('.ai-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ai-nav-item').forEach((b) => b.classList.toggle('active', b === btn))
      document.querySelectorAll('#aiSettingsModal .ai-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.pane))
    })
  })
  // 数据同步：导出 / 导入
  $('aiExportDataBtn').addEventListener('click', exportWorkData)
  $('aiImportDataBtn').addEventListener('click', importWorkData)
  // 云同步：状态显示 + 立即同步（登录后自动备份 Work 会话+AI 设置到账号，每 5 分钟）
  $('cloudSyncNowBtn').addEventListener('click', async () => {
    const btn = $('cloudSyncNowBtn')
    const st = $('cloudSyncState')
    btn.disabled = true
    if (st) st.textContent = '同步中…'
    try {
      const r = await _api.cloudSyncNow()
      if (r && r.ok) {
        const t = fmtLocalTime(r.lastSyncAt)
        if (st) st.textContent = `上次同步：${t || '刚刚'}`
        showToast('云同步完成：Work 会话与 AI 设置已备份到账号', 'success')
      } else {
        if (st) st.textContent = '同步失败（未登录或网络不通）'
        showToast((r && r.error) || '云同步失败', 'error')
      }
    } catch (err) {
      if (st) st.textContent = '同步失败'
      showToast(`云同步失败: ${err.message}`, 'error')
    }
    btn.disabled = false
  })
  refreshCloudSyncState()
  $('aiProviderSelect').addEventListener('change', applyProviderUI)
  // 服务商库：选中回填编辑表单，💾 存入/更新，🗑 删除；各模型槽位下拉选用即存
  if ($('aiProviderLibSelect')) {
    // 库名预设（老大指定）：自定义输入 + 三预设，选/输预设名自动带出接口地址（baseUrl 已填或已有值则不覆盖）
    const PROVIDER_NAME_PRESETS = {
      'OpenRouter': 'https://openrouter.ai/api/v1',
      'DeepSeek官网': 'https://api.deepseek.com/v1',
      '硅基流动': 'https://api.siliconflow.cn/v1'
    }
    $('aiProviderLibName').addEventListener('change', () => {
      const url = PROVIDER_NAME_PRESETS[$('aiProviderLibName').value.trim()]
      const baseInput = $('aiProviderLibBaseUrl')
      if (url && !baseInput.value.trim()) baseInput.value = url
    })
    $('aiProviderLibSelect').addEventListener('change', (e) => {
      const p = _providerLibCache.find((x) => x.id === e.target.value)
      $('aiProviderLibName').value = p ? (p.name || '') : ''
      $('aiProviderLibBaseUrl').value = p ? (p.baseUrl || '') : ''
      $('aiProviderLibKey').value = p ? (p.apiKey || '') : ''
    })
    $('aiProviderLibSaveBtn').addEventListener('click', async () => {
      const name = $('aiProviderLibName').value.trim()
      const baseUrl = $('aiProviderLibBaseUrl').value.trim().replace(/\/+$/, '')
      const apiKey = $('aiProviderLibKey').value.trim()
      if (!baseUrl || !apiKey) { showToast('接口地址和 API Key 都填好才能存入服务商库', 'warn'); return }
      const sel = $('aiProviderLibSelect')
      const id = sel.value || `p_${Date.now().toString(36)}`
      const item = { id, name: name || baseUrl.replace(/^https?:\/\//, '').split('/')[0], baseUrl, apiKey }
      const i = _providerLibCache.findIndex((x) => x.id === id)
      if (i >= 0) _providerLibCache[i] = item
      else _providerLibCache.push(item)
      await _api.setSetting('aiProviderList', _providerLibCache)
      renderProviderLib()
      sel.value = id
      showToast('已存入服务商库：下方各模型槽位的运营商下拉里即可选用', 'success')
    })
    $('aiProviderLibDelBtn').addEventListener('click', async () => {
      const id = $('aiProviderLibSelect').value
      if (!id) { showToast('先在下拉里选中要删除的服务商', 'warn'); return }
      _providerLibCache = _providerLibCache.filter((x) => x.id !== id)
      await _api.setSetting('aiProviderList', _providerLibCache)
      for (const [cap, selId] of PROVIDER_SLOTS) {
        const s = $(selId)
        if (s && s.value === id) { s.value = ''; await _api.setSetting(`ai${cap}Provider`, '').catch(() => {}) }
      }
      $('aiProviderLibName').value = ''
      $('aiProviderLibBaseUrl').value = ''
      $('aiProviderLibKey').value = ''
      renderProviderLib()
      showToast('已从服务商库删除（引用它的槽位已回退默认）', 'info')
    })
    for (const [cap, selId] of PROVIDER_SLOTS) {
      const s = $(selId)
      if (s) s.addEventListener('change', () => { _api.setSetting(`ai${cap}Provider`, s.value).catch(() => {}) })
    }
    loadProviderLib()
  }
  // 网页版模型（[网页]DeepSeek）：启用后工作台挂常驻网页页签，模型下拉出现 [网页]DeepSeek
  if ($('aiWebDeepseekBtn')) $('aiWebDeepseekBtn').addEventListener('click', toggleWebDeepseek)
  if ($('aiWebRulesBtn')) {
    $('aiWebRulesBtn').addEventListener('click', async () => {
      // 网页版规则 = MSM 默认规则 + 大记事本 + 用户自定义规则（每条对话自动附件），记事本是唯一需要用户维护的
      const r = await _api.aiOpenNotes()
      if (!r || !r.success) showToast((r && r.error) || '打开记事本失败', 'error')
    })
  }
  // 下拉选模型 → 直接填进输入框；➕/🗑 维护用户自己的常用清单
  $('aiModelPresetSelect').addEventListener('change', (e) => { if (e.target.value) $('aiModelInput').value = e.target.value })
  $('aiVisionModelPresetSelect').addEventListener('change', (e) => { if (e.target.value) $('aiVisionModelInput').value = e.target.value })
  $('aiModelAddBtn').addEventListener('click', () => addToModelList('chatModelList', 'aiModelInput', 'aiModelPresetSelect'))
  $('aiModelDelBtn').addEventListener('click', () => delFromModelList('chatModelList', 'aiModelPresetSelect'))
  $('aiVisionModelAddBtn').addEventListener('click', () => addToModelList('visionModelList', 'aiVisionModelInput', 'aiVisionModelPresetSelect'))
  $('aiVisionModelDelBtn').addEventListener('click', () => delFromModelList('visionModelList', 'aiVisionModelPresetSelect'))
  $('aiVoiceModelPresetSelect').addEventListener('change', (e) => { if (e.target.value) $('aiVoiceModelInput').value = e.target.value })
  $('aiVoiceModelAddBtn').addEventListener('click', () => addToModelList('voiceModelList', 'aiVoiceModelInput', 'aiVoiceModelPresetSelect'))
  $('aiVoiceModelDelBtn').addEventListener('click', () => delFromModelList('voiceModelList', 'aiVoiceModelPresetSelect'))
  $('aiThemeSelect').addEventListener('change', (e) => applyTheme(e.target.value))
  $('aiRuleAddBtn').addEventListener('click', addRuleFromInput)
  $('aiRuleNewInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addRuleFromInput()
    }
  })
  $('aiMemoryClearBtn').addEventListener('click', () => {
    if (!work.memory || !work.memory.length) return
    work.memory = []
    renderMemoryEditor()
    showToast('已清空记忆，保存设置后生效', 'info')
  })
  $('aiOpenWorkspaceBtn').addEventListener('click', async () => {
    const r = await window.api.aiOpenWorkspace()
    if (!r || !r.success) showToast((r && r.error) || '打开工作台失败', 'error')
  })
  $('aiOpenNotesBtn').addEventListener('click', async () => {
    const r = await window.api.aiOpenNotes()
    if (!r || !r.success) showToast((r && r.error) || '打开记事本失败', 'error')
  })
  // v2.4.97：TTS 试听 / 检查更新 / 定时任务
  if ($('aiTtsTestBtn')) $('aiTtsTestBtn').addEventListener('click', ttsTestPlay)
  if ($('checkUpdateBtn')) $('checkUpdateBtn').addEventListener('click', checkAppUpdate)
  // v2.5.0：更新提示条——去下载（应用内下载，banner 变进度条）/ 立即重启更新 / 关闭 / 进度事件流
  if ($('updateBannerDownload')) $('updateBannerDownload').addEventListener('click', startInAppUpdate)
  if ($('updateBannerInstall')) $('updateBannerInstall').addEventListener('click', installUpdateNow)
  if (_api.onUpdateDlProgress) {
    _api.onUpdateDlProgress((d) => {
      if (!d) return
      if (_updateBannerDismissed) return // v2.5.2：用户本次启动已关横幅 → 进度/就绪事件不再打扰（下载照常，退出时自动装）
      if (d.status === 'error') {
        _updateDownloading = false
        const b = $('updateBanner'); if (b) b.classList.add('hidden')
        showToast(d.error || '下载失败', 'error'); return
      }
      if (d.status === 'readyToInstall') { _updateDownloading = false; setUpdateBannerMode('ready', d); return }
      if (d.status === 'downloading') updateBannerProgress(d)
    })
  }
  if ($('updateBannerClose')) {
    $('updateBannerClose').addEventListener('click', () => {
      _updateBannerDismissed = true // 本次启动不再提示
      const b = $('updateBanner')
      if (b) b.classList.add('hidden')
    })
  }
  if ($('aiScheduleAddBtn')) $('aiScheduleAddBtn').addEventListener('click', addSchedule)
  $('snapshotsClose').addEventListener('click', () => $('snapshotsModal').classList.add('hidden'))

  // --- AI 事件流 ---
  _api.onAiEvent(handleAiEvent)

  // --- 工作台 / 资源面板 / 预览（需在 initSessions 之前，会话激活时会加载工作台） ---
  initWorkbenchUI()

  // --- 初始化：加载会话列表并恢复上次查看的会话 ---
  initSessions()
  _api.aiGetConfig().then((cfg) => {
    if (cfg) { work.config = cfg; updateApprovalTag() }
    fillQuickModelSelect()
  }).catch(() => {})
}

// ===== 多会话管理 =====
async function initSessions() {
  try { work.sessionList = (await _api.aiSessions()) || [] } catch { work.sessionList = [] }
  let saved = null
  try { saved = localStorage.getItem('msmate_active_session') } catch {}
  const target = work.sessionList.find((s) => s.id === saved) || work.sessionList[0]
  if (target) await activateSession(target.id, { skipLoad: false })
}

async function activateSession(sid, { skipLoad } = {}) {
  await wbPersistFlush() // 切走前把待写工作台清单落回旧会话（防止串进新会话）
  work.active = sid
  try { localStorage.setItem('msmate_active_session', sid) } catch {}
  const st = sessState(sid)
  work._ctx = st // 后续渲染/操作都落在该会话
  const el = curChatEl() // 挂载容器并显隐
  el.classList.remove('hidden')
  for (const other of work.sessions.values()) {
    if (other !== st && other.el) other.el.classList.add('hidden')
  }
  renderSessionBar()
  // 工作台内容按会话独立加载
  try { loadWorkbench(sid) } catch {}
  if (!st.loaded && !skipLoad) {
    st.loaded = true
    await restoreHistory(sid)
  }
  setChatRunning(st.running) // 同步发送按钮/运行点
  $('chatInput') && $('chatInput').focus()
}

async function createNewSession() {
  let meta = null
  try { meta = await _api.aiSessionCreate('') } catch (err) {
    showToast(`新建会话失败: ${err.message}`, 'error')
    return
  }
  if (!meta) return
  work.sessionList.unshift(meta)
  await activateSession(meta.id)
}

function sessionMeta(sid) {
  return work.sessionList.find((s) => s.id === sid)
}

async function autoTitleSession(sid, text) {
  const meta = sessionMeta(sid)
  if (!meta) return
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 20)
  // 默认名（主进程建会话时是"新对话"，历史上还有"新会话"）都不算已命名，首条消息来了就自动取名
  if (!t || ['', '新会话', '新对话', '未命名会话'].includes(meta.title)) return
  meta.title = t
  try { await _api.aiSessionRename(sid, t) } catch {}
  renderSessionBar()
}

function updateSessionRunDot() {
  const dot = $('sessionRunDot')
  if (!dot) return
  const activeRunning = sessState(work.active) && sessState(work.active).running
  const anyRunning = [...work.sessions.values()].some((s) => s.running)
  dot.classList.toggle('hidden', !anyRunning)
  dot.classList.toggle('bg-run', !!activeRunning)
  dot.title = activeRunning ? '当前会话运行中' : '其他会话运行中'
}

function renderSessionBar() {
  const meta = sessionMeta(work.active)
  if (meta) $('sessionBarTitle').textContent = meta.title || '新会话'
  updateSessionRunDot()
}

function renderSessionMenu() {
  const listEl = $('sessionMenuList')
  listEl.innerHTML = ''
  if (!work.sessionList.length) {
    listEl.innerHTML = '<div class="session-menu-empty">暂无会话</div>'
    return
  }
  for (const s of work.sessionList) {
    const row = document.createElement('div')
    row.className = 'session-menu-item' + (s.id === work.active ? ' active' : '')
    const st = work.sessions.get(s.id)
    const running = st && st.running
    const title = document.createElement('span')
    title.className = 'session-item-title'
    title.innerHTML = (s.pinned ? iconSvg(s.pinned ? 'pin' : 'pin-off') + ' ' : '') + escapeHtml(s.title || '新会话')
    title.title = s.title || '新会话'
    title.addEventListener('click', async () => {
      $('sessionMenu').classList.add('hidden')
      await activateSession(s.id)
    })
    row.appendChild(title)
    if (running) {
      const dot = document.createElement('span')
      dot.className = 'session-item-dot'
      dot.textContent = '●'
      dot.title = '运行中'
      row.appendChild(dot)
    }
    // 操作：重命名 / 置顶 / 删除（删除二次确认）
    const ops = document.createElement('span')
    ops.className = 'session-item-ops'
    const mkBtn = (txt, tip, fn) => {
      const b = document.createElement('button')
      b.innerHTML = txt // txt 是 iconSvg 串，textContent 会显示源码（2.7.1 补修）
      b.title = tip
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(b) })
      return b
    }
    let delArmed = false
    ops.append(
      mkBtn(iconSvg('square-pen'), '重命名', () => startInlineRename(s, row, title)),
      mkBtn(iconSvg(s.pinned ? 'pin-off' : 'pin'), s.pinned ? '取消置顶' : '置顶', async () => {
        s.pinned = !s.pinned
        try { await _api.aiSessionPin(s.id, s.pinned) } catch {}
        work.sessionList.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
        renderSessionMenu()
        renderSessionBar()
      }),
      mkBtn(iconSvg('trash-2'), '删除会话（连历史一起删，再点一次确认）', async (b) => {
        if (!delArmed) {
          delArmed = true
          b.innerHTML = iconSvg('triangle-alert')
          setTimeout(() => { delArmed = false; b.innerHTML = iconSvg('trash-2') }, 3000)
          return
        }
        try { await _api.aiSessionDelete(s.id) } catch {}
        work.sessionList = work.sessionList.filter((x) => x.id !== s.id)
        const stDel = work.sessions.get(s.id)
        if (stDel && stDel.el) stDel.el.remove()
        work.sessions.delete(s.id)
        if (work.active === s.id) {
          work.active = null
          const next = work.sessionList[0]
          if (next) await activateSession(next.id)
          else await createNewSession()
        } else {
          renderSessionBar()
          renderSessionMenu()
        }
      })
    )
    row.appendChild(ops)
    listEl.appendChild(row)
  }
}

// 菜单内联重命名：标题变成输入框，Enter/失焦提交
function startInlineRename(s, row, titleSpan) {
  const input = document.createElement('input')
  input.className = 'session-item-rename'
  input.value = s.title || ''
  input.maxLength = 40
  titleSpan.replaceWith(input)
  input.focus()
  input.select()
  const commit = async () => {
    const t = input.value.trim()
    if (t && t !== s.title) {
      s.title = t
      try { await _api.aiSessionRename(s.id, t) } catch {}
    }
    renderSessionMenu()
    renderSessionBar()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    if (e.key === 'Escape') { input.value = s.title; input.blur() }
  })
  input.addEventListener('blur', commit)
  input.addEventListener('click', (e) => e.stopPropagation())
}

function stripToolBlocks(text) {
  return String(text || '')
    .replace(/```tool[\s\S]*?```/g, '')
    .replace(/<tool_call\s*>[\s\S]*?<\/tool_call\s*>/g, '') // tool_call XML 标签（Qwen/GLM 系漂移形态）不进正文
    .replace(/<[\s|]*DSML[\s|]*[\s\S]*?(?:<[\s|]*\/[\s|]*DSML[\s|]*(?:invoke|calls|parameter)[\s|]*>|$)/g, '') // DeepSeek DSML 内部标记（漂移产物）不进正文，防乱码
    .trim()
}

function approvalModeOf(v) {
  return v === 'auto' ? 'auto' : (v === 'unlimited' ? 'unlimited' : 'manual')
}

function updateApprovalTag() {
  const tag = $('aiApprovalTag')
  if (!tag) return
  const mode = approvalModeOf(work.config.approvalMode)
  const label = tag.querySelector('.as-label')
  const text = mode === 'auto' ? '自动信任' : (mode === 'unlimited' ? '无限制' : '手动批准')
  if (label) label.textContent = text
  else tag.textContent = text
  tag.classList.toggle('manual', mode === 'manual')
  tag.classList.toggle('auto', mode === 'auto')
  tag.classList.toggle('unlimited', mode === 'unlimited')
}

async function applyApprovalMode(next) {
  work.config.approvalMode = next
  updateApprovalTag()
  try { await _api.aiSetConfig({ approvalMode: next }) } catch {}
  if (next === 'unlimited') showToast('无限制模式已开启：所有操作（含 exe/脚本/桌面控制）不再询问。重启应用自动回落自动信任', 'error')
  else if (next === 'auto') showToast('已切换：自动信任（C盘除桌面仍需批准）', 'success')
  else showToast('已切换：手动批准', 'success')
}

// 控制模式三选菜单（手动批准/自动信任/无限制）：无限制=会话级高危档，两步确认防误触
function showApprovalMenu() {
  const menu = $('aiApprovalMenu')
  const btn = $('aiApprovalTag')
  if (!menu || !btn) return
  if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return }
  const cur = approvalModeOf(work.config.approvalMode)
  const item = (val, name, desc, cls) => `
    <button type="button" class="am-item ${cls}" data-mode="${val}">
      <span class="am-dot"></span>
      <span><span class="am-name">${name}${val === cur ? ' ✓' : ''}</span><span class="am-desc">${desc}</span></span>
    </button>`
  menu.innerHTML =
    item('manual', '手动批准', '每个风险操作都弹卡确认，最稳妥', 'manual') +
    item('auto', '自动信任', '自动执行（C盘除桌面、运行exe/脚本仍需确认）', 'auto') +
    item('unlimited', '无限制（挂机办公）', '所有操作全自动不再询问，含 exe/脚本/桌面控制；重启应用自动回落自动信任', 'unlimited')
  menu.classList.remove('hidden')
  const rect = btn.getBoundingClientRect()
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + 'px'
  const mh = menu.offsetHeight
  menu.style.top = (rect.top - mh - 8 > 8 ? rect.top - mh - 8 : rect.bottom + 8) + 'px'
  menu.querySelectorAll('.am-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const mode = el.getAttribute('data-mode')
      if (mode === 'unlimited' && cur !== 'unlimited' && !el.classList.contains('armed')) {
        el.classList.add('armed')
        const n = el.querySelector('.am-name')
        if (n) n.textContent = '再次点击确认开启（本会话内不再询问任何操作）'
        setTimeout(() => { // 3 秒不点就解除武装，防误触
          if (!el.isConnected) return
          el.classList.remove('armed')
          if (n) n.textContent = '无限制（挂机办公）'
        }, 3000)
        return
      }
      menu.classList.add('hidden')
      await applyApprovalMode(mode)
    })
  })
}

// ===== browser_* 网页控制（AI 受控页签）：导航/快照/点击/填表/读取 =====
// 受控页签固定一个（path='url://ai-ctl'，名称"AI 浏览"），用户全程可见操作内容；
// ref 表存 webview 主世界 window.__msAiRefs（页面自身导航后自然失效，需重新 snapshot）
const AI_WEB_PATH = 'url://ai-ctl'
const AI_WEB_KEY = 'local|' + AI_WEB_PATH

function aiWebView() {
  const v = typeof ensureUrlView === 'function' ? ensureUrlView(AI_WEB_KEY, 'about:blank') : null
  return v ? v.el : null
}

async function waitAiWebLoad(el, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < (timeoutMs || 15000)) {
    try {
      const st = await el.executeJavaScript('({s:document.readyState,t:document.title,u:location.href})')
      if (st && st.s === 'complete') { await new Promise((r) => setTimeout(r, 400)); return st }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function browserNavigate(url) {
  const el = aiWebView()
  if (!el) return { ok: false, error: '工作台网页层不可用' }
  let u = String(url || '').trim()
  if (!u) return { ok: false, error: 'url 为空' }
  // 本地文件直接开发预览：Windows 路径自动转 file:/// URL（AI 写完网页自己看效果）
  if (/^[a-zA-Z]:[\\/]/.test(u)) u = 'file:///' + u.replace(/\\/g, '/')
  if (!/^(https?:\/\/|file:\/\/)/i.test(u)) u = 'https://' + u
  let it = state.wbItems.find((w) => w.aiCtl)
  if (!it) {
    state.wbItems.push({ kind: 'urltab', url: u, path: AI_WEB_PATH, name: 'AI 浏览', isDir: false, size: 0, origin: 'local', originName: 'AI', _missing: false, aiCtl: true })
  } else { it.url = u; it.path = AI_WEB_PATH }
  try { wbPersist() } catch {}
  wbActiveKey = AI_WEB_KEY
  wbRenderedKey = null
  renderWorkbench()
  // renderWbView 首建带 src；已存在的 webview 层手动导航
  try { el.loadURL(u) } catch { try { el.setAttribute('src', u) } catch {} }
  const st = await waitAiWebLoad(el)
  aiRefsClear()
  if (!st) return { ok: false, error: '页面加载超时（15s），可能网络不通或站点很慢' }
  return { ok: true, title: st.t || '', url: st.u || u }
}

function aiRefsClear() {
  const el = aiWebView()
  if (el) { try { el.executeJavaScript('window.__msAiRefs = {}') } catch {} }
}

const AI_SNAP_JS = `(() => {
  const out = []
  window.__msAiRefs = {}
  const nodes = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick]')
  let n = 0
  for (const el of nodes) {
    if (n >= 120) { out.push('（元素超过 120 个，已截断）'); break }
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue
    n++
    const ref = 'e' + n
    window.__msAiRefs[ref] = el
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const ph = el.getAttribute('placeholder') || ''
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 50)
    out.push(ref + ': ' + tag + (type ? '[' + type + ']' : '') + (ph ? ' 占位="' + ph + '"' : '') + (text ? ' 文="' + text + '"' : '') + ' @(' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ')')
  }
  return out.join('\\n') || '（页面没有可交互元素）'
})()`

async function browserSnapshot() {
  const el = aiWebView()
  if (!el) return { ok: false, error: 'AI 浏览页签不存在，先 browser_navigate' }
  try {
    const list = await el.executeJavaScript(AI_SNAP_JS)
    return { ok: true, elements: String(list || '') }
  } catch (e) { return { ok: false, error: '快照失败: ' + e.message } }
}

async function browserClick(ref) {
  const el = aiWebView()
  if (!el) return { ok: false, error: 'AI 浏览页签不存在，先 browser_navigate' }
  const r = String(ref || '').trim()
  if (!/^e\d+$/.test(r)) return { ok: false, error: 'ref 格式应为 e数字（来自 browser_snapshot）' }
  try {
    const res = await el.executeJavaScript(`(() => {
      const el = (window.__msAiRefs || {})['${r}']
      if (!el || !el.isConnected) return 'REF_GONE'
      el.scrollIntoView({ block: 'center' })
      const rc = el.getBoundingClientRect()
      const opts = { bubbles: true, cancelable: true, view: window, clientX: rc.x + rc.width / 2, clientY: rc.y + rc.height / 2 }
      ;['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => { try { el.dispatchEvent(new MouseEvent(t, opts)) } catch (e) {} })
      try { el.click() } catch (e) {}
      return 'OK'
    })()`)
    if (res !== 'OK') return { ok: false, error: '元素已失效（页面重渲染了），重新 browser_snapshot 后再操作' }
    await new Promise((rr) => setTimeout(rr, 600)) // 等 SPA 路由/弹窗落定
    const st = await waitAiWebLoad(el, 4000)
    return { ok: true, navigated: st ? (st.t || '') : '' }
  } catch (e) { return { ok: false, error: '点击失败: ' + e.message } }
}

async function browserFill(ref, value) {
  const el = aiWebView()
  if (!el) return { ok: false, error: 'AI 浏览页签不存在，先 browser_navigate' }
  const r = String(ref || '').trim()
  if (!/^e\d+$/.test(r)) return { ok: false, error: 'ref 格式应为 e数字（来自 browser_snapshot）' }
  const v = String(value == null ? '' : value)
  const b64v = (() => { try { return btoa(unescape(encodeURIComponent(v))) } catch { return '' } })() // 中文绕开拼接编码坑
  try {
    const res = await el.executeJavaScript(`(() => {
      const el = (window.__msAiRefs || {})['${r}']
      if (!el || !el.isConnected) return 'REF_GONE'
      let v = ''
      try { v = decodeURIComponent(escape(atob('${b64v}'))) } catch (e) { return 'DEC_ERR' }
      const tag = el.tagName
      if (tag === 'SELECT') {
        const hit = Array.from(el.options).some((o) => { if (o.value === v || o.text === v) { el.value = o.value; return true } return false })
        if (hit) { el.dispatchEvent(new Event('change', { bubbles: true })); return 'OK' }
        return 'NO_OPTION'
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v) // 原生 setter 绕 React 受控组件
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return 'OK'
      }
      if (el.isContentEditable) { el.innerText = v; el.dispatchEvent(new InputEvent('input', { bubbles: true })); return 'OK' }
      return 'NOT_EDITABLE'
    })()`)
    if (res === 'OK') return { ok: true }
    const msg = { REF_GONE: '元素已失效（页面重渲染了），重新 browser_snapshot', NOT_EDITABLE: '该元素不是可编辑控件（input/textarea/select/contenteditable 才能填）', NO_OPTION: '下拉框没有匹配选项（value 或 文本都要对上）', DEC_ERR: '值解码失败' }[res]
    return { ok: false, error: msg || ('填充失败: ' + res) }
  } catch (e) { return { ok: false, error: '填充失败: ' + e.message } }
}

async function browserRead() {
  const el = aiWebView()
  if (!el) return { ok: false, error: 'AI 浏览页签不存在，先 browser_navigate' }
  try {
    const info = await el.executeJavaScript('({t:document.title,u:location.href,b:(document.body?document.body.innerText:"")})')
    const body = String((info && info.b) || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 8000)
    return { ok: true, title: (info && info.t) || '', url: (info && info.u) || '', text: body }
  } catch (e) { return { ok: false, error: '读取失败: ' + e.message } }
}

function initBrowserCtlBridge() {
  if (!_api.onAiBrowserCtl || _api._browserCtlBound) return
  _api._browserCtlBound = true
  _api.onAiBrowserCtl(async ({ reqId, op, params }) => {
    let result = { ok: false, error: '未知操作: ' + op }
    try {
      const p = params || {}
      if (op === 'navigate') result = await browserNavigate(p.url)
      else if (op === 'snapshot') result = await browserSnapshot()
      else if (op === 'click') result = await browserClick(p.ref)
      else if (op === 'fill') result = await browserFill(p.ref, p.value)
      else if (op === 'read') result = await browserRead()
    } catch (e) { result = { ok: false, error: e.message } }
    try { _api.browserCtlResult(reqId, result) } catch {}
  })
}

// ===== 主模型快捷切换（聊天输入区自绘菜单：内置模型置顶带积分价 + 常用模型，Trae 风格分组）=====
function mqmBtnLabel(model) {
  const btn = $('chatModelQuickBtn')
  if (!btn) return
  const m = String(model || '')
  const name = m.startsWith('[内置]') ? `内置·${m.slice(4).split('/').pop()}` : (m || '默认模型')
  btn.textContent = name
  btn.title = m ? `${m}（点击切换主模型）` : '主模型快捷切换'
}

function renderQuickModelMenu(builtin, list, cur) {
  const menu = $('chatModelQuickMenu')
  if (!menu) return
  // 积分倍率（Trae 风格）：输出 10 积分/百万tokens = 1x，0.9x ≈ 9 积分/百万tokens
  const ratio = (c) => (c.creditsPerMTokOut / 10).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'x'
  const row = (val, name, price, tip) => `
    <button type="button" class="mqm-item${val === cur ? ' active' : ''}" data-model="${escapeHtml(val)}" title="${escapeHtml(tip || val)}">
      <span class="mqm-check">${val === cur ? '✓' : ''}</span>
      <span class="mqm-name">${escapeHtml(name)}</span>
      ${price ? `<span class="mqm-price">${escapeHtml(price)}</span>` : ''}
    </button>`
  let html = ''
  if (builtin && Array.isArray(builtin.chat) && builtin.chat.length) {
    const chatList = builtin.chat.filter((c) => !c.visionOnly) // visionOnly 只服务内置看图工具
    if (chatList.length) {
      html += '<div class="mqm-group">内置模型（登录后可用，按积分计费）</div>'
      html += chatList.map((c) => row(
        '[内置]' + c.id,
        c.name,
        ratio(c),
        `${c.desc} · ${ratio(c)} = 每百万tokens 输入 ${c.creditsPerMTokIn} / 输出 ${c.creditsPerMTokOut} 积分`
      )).join('')
    }
  }
  html += '<div class="mqm-group">常用模型</div>'
  html += (list && list.length ? list : []).map((m) => row(m, m, '', m)).join('')
  if (!list || !list.length) html += '<div class="mqm-item mqm-hint" style="cursor:default">清单为空，去 设置 → AI设置 → 模型服务 添加常用模型</div>'
  menu.innerHTML = html
  menu.querySelectorAll('.mqm-item[data-model]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      menu.classList.add('hidden')
      const model = btn.getAttribute('data-model') || ''
      if (model.startsWith('[内置]')) {
        const st = await _api.authGetState().catch(() => ({}))
        if (!st || !st.token) { showToast('内置模型需先登录 MSMate 账号（点顶栏头像）', 'info'); return }
      }
      work.config.model = model
      mqmBtnLabel(model)
      try {
        await _api.aiSetConfig({ model })
        showToast(`已切换主模型：${model.startsWith('[内置]') ? model.slice(4).split('/').pop() : model}`, 'success')
      } catch (err) {
        showToast(`切换失败: ${err.message}`, 'error')
      }
    })
  })
}

async function fillQuickModelSelect() {
  const btn = $('chatModelQuickBtn')
  if (!btn) return
  mqmBtnLabel((work.config && work.config.model) || '')
  if (btn._mqmBound) return // 事件只绑一次；后续调用只刷新按钮文案
  btn._mqmBound = true
  btn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const menu = $('chatModelQuickMenu')
    if (!menu) return
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return }
    const [list, builtinR] = await Promise.all([
      _api.getSetting('chatModelList').catch(() => []),
      _builtinModelsCache ? Promise.resolve(_builtinModelsCache) : _api.aiBuiltinModels().then((r) => (r && r.ok ? r.data : null)).catch(() => null)
    ])
    if (builtinR) _builtinModelsCache = builtinR
    renderQuickModelMenu(builtinR, Array.isArray(list) ? list : [], (work.config && work.config.model) || '')
    // fixed 定位贴按钮上方（侧栏 overflow:hidden 会裁掉 absolute 浮层，只能走 fixed）
    menu.classList.add('hidden')
    menu.style.visibility = 'hidden'
    menu.classList.remove('hidden')
    const rect = btn.getBoundingClientRect()
    const mw = menu.offsetWidth
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + 'px'
    menu.style.top = (rect.top - 6) + 'px'
    menu.style.visibility = ''
  })
  document.addEventListener('click', (e) => {
    const menu = $('chatModelQuickMenu')
    if (!menu || menu.classList.contains('hidden')) return
    if (!menu.contains(e.target) && !btn.contains(e.target)) menu.classList.add('hidden')
  })
}

// ===== 主题切换（执事风=默认 / 经典白 / 莫西 / 深色）=====
function getSavedTheme() {
  try {
    const t = localStorage.getItem('msmate_theme')
    return (t === 'dark' || t === 'classic' || t === 'moxi') ? t : 'butler'
  } catch { return 'butler' }
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : (theme === 'classic' ? 'classic' : (theme === 'moxi' ? 'moxi' : 'butler'))
  const root = document.documentElement
  root.classList.toggle('theme-light', t !== 'dark')
  root.classList.toggle('theme-butler', t === 'butler')
  root.classList.toggle('theme-moxi', t === 'moxi')
  applyPanelRgb()
  try { localStorage.setItem('msmate_theme', t) } catch {}
  document.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: t } })) // 桌宠/形象层联动
}

// ===== 全局设置：外观（自定义背景）=====
// 各主题的面板底色 RGB（供 has-bg 半透明面板混色用）
const THEME_PANEL_RGB = { dark: '37, 37, 55', light: '255, 255, 255' }
let bgMedia = null // { kind: 'image'|'anim'|'video', src } 自定义背景媒体（图片=dataUrl，动图/视频=file:// 路径）
const appearance = { bgOpacity: 100, bgBlur: 0, bgScale: 100, bgMask: 0, panelAlpha: 85 }

function applyPanelRgb() {
  const rgb = document.documentElement.classList.contains('theme-light') ? THEME_PANEL_RGB.light : THEME_PANEL_RGB.dark
  document.documentElement.style.setProperty('--panel-rgb', rgb)
}

function applyAppearance() {
  const root = document.documentElement
  const bgEl = $('appBackground')
  const imgEl = $('appBgImg')
  if (!bgEl || !imgEl) return
  // 莫西主题默认背景：用户未设置自定义背景时用海报（横）铺底，参数定版
  // （不透明 100 / 模糊 0 / 缩放 0=不额外放大即 scale1 / 暗化 0 / 面板透明 85）；用户自设背景优先
  const moxiDefault = !bgMedia && document.documentElement.classList.contains('theme-moxi')
  const media = moxiDefault ? { kind: 'image', src: '../assets/moxi/poster-h.webp' } : bgMedia
  const params = moxiDefault
    ? { bgOpacity: 100, bgBlur: 0, bgScale: 100, bgMask: 0, panelAlpha: 85 }
    : appearance
  const hasBg = !!media
  root.style.setProperty('--panel-alpha', String(params.panelAlpha / 100))
  if (hasBg) {
    // 图片走 background-image；GIF 动图/视频走元素挂载（img 才有帧动画，video 才能循环播放）
    if (media.kind === 'image') {
      imgEl.innerHTML = ''
      imgEl.style.backgroundImage = `url("${media.src}")`
    } else {
      imgEl.style.backgroundImage = ''
      imgEl.innerHTML = media.kind === 'video'
        ? `<video class="app-bg-media" src="${media.src}" autoplay loop muted playsinline></video>` // 静音循环，不打扰
        : `<img class="app-bg-media" src="${media.src}" draggable="false" alt="">`
    }
    root.style.setProperty('--app-bg-opacity', String(params.bgOpacity / 100))
    root.style.setProperty('--app-bg-blur', `${params.bgBlur}px`)
    root.style.setProperty('--app-bg-scale', String(params.bgScale / 100))
    root.style.setProperty('--app-bg-mask', String(params.bgMask / 100))
  }
  root.classList.toggle('has-bg', hasBg)
  bgEl.classList.toggle('hidden', !hasBg)
}

async function initAppearance() {
  applyPanelRgb()
  try {
    const saved = await _api.getSetting('uiAppearance')
    if (saved && typeof saved === 'object') Object.assign(appearance, saved)
  } catch {}
  try {
    const bg = await _api.getBackground()
    if (bg && bg.kind === 'image' && bg.dataUrl) bgMedia = { kind: 'image', src: bg.dataUrl }
    else if (bg && (bg.kind === 'anim' || bg.kind === 'video') && bg.url) bgMedia = { kind: bg.kind, src: bg.url }
  } catch {}
  applyAppearance()
  // 启动页面：跟随上次 / 指定模式（需在 initWorkMode 绑定滑块之后调用）
  try {
    const sm = await _api.getSetting('startupMode')
    const last = (typeof localStorage.getItem('msmate_last_mode') === 'string')
      ? localStorage.getItem('msmate_last_mode') : 'link'
    const target = sm === 'link' || sm === 'work' ? sm : last
    if (target === 'work' && work.mode !== 'work') $('modeWork').click()
  } catch {}
}

// ===== 全局设置弹窗 =====
let gsSnapshot = null   // 打开时的外观快照（取消还原用）
let gsSnapshotBg = null

function gsSyncSliderUI() {
  $('gsBgOpacity').value = appearance.bgOpacity
  $('gsBgBlur').value = appearance.bgBlur
  $('gsBgScale').value = appearance.bgScale
  $('gsBgMask').value = appearance.bgMask
  $('gsPanelAlpha').value = appearance.panelAlpha
  $('gsBgOpacityVal').textContent = `${appearance.bgOpacity}%`
  $('gsBgBlurVal').textContent = `${appearance.bgBlur}px`
  $('gsBgScaleVal').textContent = `${appearance.bgScale}%`
  $('gsBgMaskVal').textContent = `${appearance.bgMask}%`
  $('gsPanelAlphaVal').textContent = `${appearance.panelAlpha}%`
}

function gsSyncBgThumb() {
  const thumb = $('gsBgThumb')
  if (!thumb) return
  if (bgMedia && bgMedia.kind === 'video') {
    thumb.style.backgroundImage = ''
    thumb.innerHTML = '<span class="gs-bg-thumb-empty">视频背景</span>'
  } else if (bgMedia && bgMedia.src) {
    thumb.style.backgroundImage = `url("${bgMedia.src}")`
    thumb.innerHTML = ''
  } else {
    thumb.style.backgroundImage = ''
    thumb.innerHTML = '<span class="gs-bg-thumb-empty">未设置</span>'
  }
}

async function openGlobalSettings() {
  // 外观
  $('gsThemeSelect').value = getSavedTheme()
  try { $('gsPetSelect').value = (await _api.getSetting('petEnabled')) ? 'on' : 'off' } catch { $('gsPetSelect').value = 'off' }
  gsSyncSliderUI()
  gsSyncBgThumb()
  // 互联与传输
  $('gsDownloadDirInput').value = state.defaultDownloadDir || ''
  try { $('gsScanInterval').value = String((await _api.getSetting('scanIntervalMs')) || 3000) } catch {}
  try { $('gsStartupMode').value = (await _api.getSetting('startupMode')) || 'last' } catch {}
  // v2.5.1 开机自启：读注册表实时状态（万一被安全软件清了，展示的是真实状态）
  try { const as = await _api.getAutoStart(); $('gsAutoStart').value = (as && as.enabled) ? 'on' : 'off' } catch { $('gsAutoStart').value = 'off' }
  // 设备
  $('gsDeviceNameInput').value = localNameEl ? localNameEl.textContent : ''
  $('gsDeviceIPText').value = localIPEl ? localIPEl.textContent : ''
  // 关于
  const gv = $('gsAppVersion')
  if (gv) gv.textContent = $('appVersion') ? $('appVersion').textContent : ''
  // 快照（取消还原）
  gsSnapshot = JSON.stringify(appearance)
  gsSnapshotBg = bgMedia
  $('globalSettingsModal').classList.remove('hidden')
}

function closeGlobalSettings() {
  $('globalSettingsModal').classList.add('hidden')
}

async function saveGlobalSettings() {
  closeGlobalSettings()
  try {
    await _api.setSetting('uiAppearance', { ...appearance })
    await _api.setSetting('scanIntervalMs', parseInt($('gsScanInterval').value, 10) || 3000)
    await _api.setSetting('startupMode', $('gsStartupMode').value)
    // v2.5.1 开机自启：写注册表（主进程顺带落 settings.json，供启动时补同步）
    const asWant = $('gsAutoStart').value === 'on'
    const asRes = await _api.setAutoStart(asWant).catch(() => null)
    if (asRes && asWant && !asRes.enabled) showToast('开机自启注册失败（可能被系统拦截），请重试', 'error')
    showToast('全局设置已保存', 'success')
  } catch (err) {
    showToast(`保存失败: ${err.message}`, 'error')
  }
}

function cancelGlobalSettings() {
  // 滑块是即时生效的，取消时还原到打开时的快照
  if (gsSnapshot) Object.assign(appearance, JSON.parse(gsSnapshot))
  bgMedia = gsSnapshotBg
  applyAppearance()
  closeGlobalSettings()
}

function initGlobalSettings() {
  // 左侧导航切换（样式同 AI 设置，但互不干扰）
  const modal = $('globalSettingsModal')
  modal.querySelectorAll('.gs-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.gs-nav-item').forEach((b) => b.classList.toggle('active', b === btn))
      modal.querySelectorAll('.ai-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.pane))
    })
  })
  $('gsSettingsCancel').addEventListener('click', cancelGlobalSettings)
  $('gsSettingsSave').addEventListener('click', saveGlobalSettings)
  modal.addEventListener('click', (e) => { if (e.target === modal) cancelGlobalSettings() })

  // 外观：主题即时切换（与 AI 设置里的主题联动，同一存储）
  $('gsThemeSelect').addEventListener('change', (e) => applyTheme(e.target.value))
  $('gsPetSelect').addEventListener('change', (e) => { try { _api.petSetEnabled(e.target.value === 'on') } catch {} })
  // 外观：滑块实时预览
  const sliderMap = [
    ['gsBgOpacity', 'bgOpacity', (v) => `${v}%`],
    ['gsBgBlur', 'bgBlur', (v) => `${v}px`],
    ['gsBgScale', 'bgScale', (v) => `${v}%`],
    ['gsBgMask', 'bgMask', (v) => `${v}%`],
    ['gsPanelAlpha', 'panelAlpha', (v) => `${v}%`],
  ]
  for (const [id, key, fmt] of sliderMap) {
    $(id).addEventListener('input', (e) => {
      appearance[key] = parseInt(e.target.value, 10) || 0
      $(`${id}Val`).textContent = fmt(appearance[key])
      applyAppearance()
    })
  }
  // 外观：选图 / 清除
  $('gsBgPickBtn').addEventListener('click', async () => {
    try {
      const r = await _api.pickBackground()
      if (!r) return
      if (r.error) { showToast(r.error, 'error'); return }
      if (r.kind === 'image' && r.dataUrl) bgMedia = { kind: 'image', src: r.dataUrl }
      else if ((r.kind === 'anim' || r.kind === 'video') && r.url) bgMedia = { kind: r.kind, src: r.url }
      if (bgMedia) {
        applyAppearance()
        gsSyncBgThumb()
      }
    } catch (err) {
      showToast(`选择背景失败: ${err.message}`, 'error')
    }
  })
  $('gsBgClearBtn').addEventListener('click', async () => {
    try { await _api.clearBackground() } catch {}
    bgMedia = null
    applyAppearance()
    gsSyncBgThumb()
  })

  // 互联与传输：默认下载目录（复用既有选择流程）
  $('gsDownloadDirBtn').addEventListener('click', async () => {
    await changeDownloadDir()
    $('gsDownloadDirInput').value = state.defaultDownloadDir || ''
  })

  // 设备：修改本机设备名（原顶栏入口移到这里）
  $('gsDeviceNameSaveBtn').addEventListener('click', async () => {
    const name = $('gsDeviceNameInput').value.trim()
    if (!name) { showToast('请输入设备名称', 'error'); return }
    try {
      const res = await _api.setDeviceName(name)
      if (localNameEl) localNameEl.textContent = res.name || name
      showToast('设备名称已更新，对方将同步看到', 'success')
    } catch (err) {
      showToast(`修改失败: ${err.message}`, 'error')
    }
  })

  // 关于：操作手册
  $('gsHelpBtn').addEventListener('click', showHelpModal)
}

// ===== AI 设置（多服务商 + 自定义规则）=====
let aiCfgCache = null // 本次打开设置时的配置快照（服务商切换时显示各平台档案的 Key 状态）
async function openAiSettings() {
  try {
    const cfg = await _api.aiGetConfig()
    aiCfgCache = cfg
    if (cfg) {
      $('aiProviderSelect').value = cfg.provider || 'siliconflow'
      $('aiBaseUrlInput').value = cfg.baseUrl || ''
      $('aiModelInput').value = cfg.model || ''
      $('aiVisionModelInput').value = cfg.visionModel || ''
      $('aiVoiceModelInput').value = cfg.voiceModel || ''
      $('aiImageModelInput').value = cfg.imageModel || ''
      $('aiImageEditModelInput').value = cfg.imageEditModel || ''
      $('aiVideoModelInput').value = cfg.videoModel || ''
      // v2.4.97：语音合成槽位 + 音色（TTS 不经 agent，直接读写设置）；v2.4.99 更新源已内置，无需回填
      _api.getSetting('aiTtsModel').then((v) => { $('aiTtsModelInput').value = v || '' }).catch(() => {})
      _api.getSetting('aiTtsVoice').then((v) => { $('aiTtsVoiceSelect').value = v || '' }).catch(() => {})
      loadSchedules()
      fillScheduleSessions()
      // 上下文压缩（v2.4.80）：设置面板必须回填——否则开过压缩后每次打开设置再保存都会被默认 false 静默关掉
      $('aiCompactToggle').checked = !!cfg.compactEnabled
      $('aiContextLimitInput').value = (parseInt(cfg.contextLimit) && parseInt(cfg.contextLimit) !== 65536) ? String(cfg.contextLimit) : ''
      $('aiModeSelect').value = cfg.approvalMode || 'manual'
      $('aiThemeSelect').value = getSavedTheme()
      _api.getSetting('preferOpen').then((v) => { $('preferOpenSelect').value = v || 'builtin' }).catch(() => {})
      work.rules = (cfg.rules || []).slice()
      work.memory = (cfg.memory || []).slice()
      renderRulesEditor()
      renderMemoryEditor()
      // Key 不回显明文，只提示已设置
      $('aiApiKeyInput').value = ''
      $('aiApiKeyInput').placeholder = cfg.hasKey ? `已设置（${cfg.apiKeyMasked}），留空保持不变` : '未设置，请输入'
    }
  } catch {}
  applyProviderUI()
  syncWebDeepseekBtn()
  loadBuiltinCards() // v0.4 内置模型卡片：每次打开面板刷新清单与余额
  $('aiSettingsModal').classList.remove('hidden')
}

function applyProviderUI() {
  const key = $('aiProviderSelect').value
  const p = AI_PROVIDERS[key] || AI_PROVIDERS.custom
  const baseInput = $('aiBaseUrlInput')
  const keyInput = $('aiApiKeyInput')
  const baseRow = $('aiBaseUrlRow')
  const prof = (aiCfgCache && aiCfgCache.profiles && aiCfgCache.profiles[key]) || null
  if (key === 'msmate') {
    // 内置：走服务端代理 + 登录态鉴权，无需 baseUrl/Key
    if (baseRow) baseRow.classList.add('hidden')
    baseInput.value = ''
    baseInput.disabled = true
    keyInput.value = ''
    keyInput.disabled = true
    keyInput.placeholder = '使用当前登录账号，无需 Key'
  } else {
    if (baseRow) baseRow.classList.remove('hidden')
    keyInput.disabled = false
    if (key === 'custom') {
      baseInput.disabled = false
      baseInput.placeholder = 'https://api.xxx.com/v1'
      if (prof && prof.baseUrl) baseInput.value = prof.baseUrl
    } else {
      baseInput.value = p.baseUrl
      baseInput.disabled = true
    }
    // Key 输入框按平台档案显示状态：各平台 Key 并存，切换服务商不丢
    keyInput.value = ''
    keyInput.placeholder = (prof && prof.hasKey)
      ? `该平台已设置（${prof.apiKeyMasked}），留空保持不变`
      : (aiCfgCache && aiCfgCache.hasKey && key === (aiCfgCache.provider || 'siliconflow')
        ? `已设置（${aiCfgCache.apiKeyMasked}），留空保持不变` : '未设置，请输入')
  }
  fillModelSelects() // 常用模型清单来自用户自管设置，与服务商无关
}

// ===== 云同步状态（数据同步面板）：登录后自动进行，这里只展示与手动触发 =====
// lastSyncAt 存的是 UTC ISO 串（主进程 toISOString），展示前转本地时间（否则差 8 小时）
function fmtLocalTime(iso) {
  const d = new Date(iso)
  if (!iso || isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
async function refreshCloudSyncState() {
  const st = $('cloudSyncState')
  if (!st) return
  try {
    const r = await _api.cloudSyncStatus()
    if (!r || !r.loggedIn) { st.textContent = '未登录（登录后自动开启）'; return }
    const t = fmtLocalTime(r.lastSyncAt)
    st.textContent = t ? `上次同步：${t}` : '已登录，等待首次同步'
  } catch { st.textContent = '状态获取失败' }
}

function updateBuiltinBalance(n) {
  const el = $('aiBuiltinBalance')
  if (el && typeof n === 'number') el.textContent = `余额 ${n} 积分`
}

// ===== MSMate 内置模型卡片（v0.4）：登录后可用，按积分计费 =====
let _builtinModelsCache = null
async function loadBuiltinCards() {
  const el = $('aiBuiltinCards')
  if (!el) return
  const state = await _api.authGetState().catch(() => ({}))
  if (!state || !state.token) {
    el.innerHTML = '<div class="ai-builtin-empty">登录 MSMate 账号后可用内置模型（按积分计费，无需自己的 API Key）</div>'
    return
  }
  if (!_builtinModelsCache) {
    const r = await _api.aiBuiltinModels().catch(() => null)
    if (!r || !r.ok) {
      el.innerHTML = `<div class="ai-builtin-empty">${(r && r.error) || '内置模型清单获取失败'}</div>`
      return
    }
    _builtinModelsCache = r.data
  }
  const m = _builtinModelsCache
  const bal = await _api.creditsBalance().catch(() => null)
  const balance = bal && bal.ok ? bal.credits : null
  // 积分倍率（Trae 风格）：输出 10 积分/百万tokens = 1x；真实单价放悬停提示
  const ratio = (c) => (c.creditsPerMTokOut / 10).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'x'
  const priceOf = (c) => `${ratio(c)}`
  const priceTitle = (c) => `每百万tokens：输入 ${c.creditsPerMTokIn} / 输出 ${c.creditsPerMTokOut} 积分（1x = 10 积分/百万tokens）`
  // visionOnly（PaddleOCR）只服务内置看图工具，不出现在可选主模型里
  const chatCards = m.chat.filter((c) => !c.visionOnly).map((c) => `
    <div class="ai-builtin-card${c.premium ? ' premium' : ''}">
      <div class="ai-builtin-head"><span class="ai-builtin-name">${escapeHtml(c.name)}</span>${c.premium ? '<span class="ai-builtin-tag">深度</span>' : ''}${c.vision ? '<span class="ai-builtin-tag">视觉</span>' : ''}</div>
      <div class="ai-builtin-desc" title="${escapeHtml(priceTitle(c))}">${escapeHtml(c.desc)} · <span class="ai-builtin-price">${escapeHtml(priceOf(c))}</span></div>
      <button type="button" class="ai-builtin-use" data-model="${escapeHtml(c.id)}">设为对话模型</button>
    </div>`).join('')
  const imgLine = m.image.map((c) => `${escapeHtml(c.name)}（${c.creditsPerImage} 积分/张）`).join('、')
  const toolLine = `生图：${imgLine} · 语音合成：${escapeHtml(m.tts.name)} · 语音识别：${escapeHtml(m.asr.name)}（${m.asr.creditsPerReq} 积分/次）——在下方槽位选「MSMate 内置（扣积分）」即可使用`
  el.innerHTML = `
    <div class="ai-builtin-topline"><span class="ai-builtin-title">内置模型</span><span class="ai-builtin-balance" id="aiBuiltinBalance">余额 ${balance === null ? '…' : balance + ' 积分'}</span></div>
    <div class="ai-builtin-grid">${chatCards}</div>
    <div class="ai-builtin-toolhint">${toolLine}</div>`
  el.querySelectorAll('.ai-builtin-use').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-model')
      const model = '[内置]' + id
      $('aiModelInput').value = model
      $('aiProviderSelect').value = 'msmate'
      applyProviderUI()
      try {
        await _api.aiSetConfig({ model })
        const fresh = await _api.aiGetConfig()
        if (fresh) { work.config = fresh; updateApprovalTag() }
        fillQuickModelSelect()
        showToast(`已切换到内置模型：${id.split('/').pop()}`, 'success')
        const balEl = $('aiBuiltinBalance')
        const nb = await _api.creditsBalance().catch(() => null)
        if (balEl && nb && nb.ok) balEl.textContent = `余额 ${nb.credits} 积分`
      } catch (err) {
        showToast(`切换失败：${err.message}`, 'error')
      }
    })
  })
}

// ===== 服务商库（v2.4.61 老大方案）：顶部统一管理多个运营商（名称+地址+Key，可自定义增删），
// 下方每个模型槽位（主/识图/语音/生图/视频）独立下拉选用——灵活混搭（如主模型 DS 官网、生图硅基流动）
let _providerLibCache = []
const PROVIDER_SLOTS = [
  ['Main', 'aiMainProviderSelect'], ['Vision', 'aiVisionProviderSelect'],
  ['Voice', 'aiVoiceProviderSelect'], ['Image', 'aiImageProviderSelect'],
  ['ImageEdit', 'aiImageEditProviderSelect'], ['Video', 'aiVideoProviderSelect'],
  ['Tts', 'aiTtsProviderSelect']
]
async function loadProviderLib() {
  try { _providerLibCache = (await _api.getSetting('aiProviderList')) || [] } catch { _providerLibCache = [] }
  if (!Array.isArray(_providerLibCache)) _providerLibCache = []
  renderProviderLib()
  for (const [cap, selId] of PROVIDER_SLOTS) {
    const sel = $(selId)
    if (!sel) continue
    try { sel.value = String((await _api.getSetting(`ai${cap}Provider`)) || '') } catch { sel.value = '' }
  }
}
function renderProviderLib() {
  const sel = $('aiProviderLibSelect')
  if (!sel) return
  sel.innerHTML = `<option value="">已存服务商（${_providerLibCache.length} 条，选中可编辑；空表单填好后点「新增」）</option>` +
    _providerLibCache.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.baseUrl)}</option>`).join('')
  for (const [, selId] of PROVIDER_SLOTS) {
    const s = $(selId)
    if (!s) continue
    const cur = s.value
    s.innerHTML = `<option value="">默认（顶部服务商）</option>` +
      _providerLibCache.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.baseUrl)}</option>`).join('')
    if (_providerLibCache.some((x) => x.id === cur)) s.value = cur
  }
}

// ===== 网页版模型（[网页]DeepSeek）：工作台内嵌真实网页自动对话，用网页版免费额度 =====
function syncWebDeepseekBtn() {
  const btn = $('aiWebDeepseekBtn')
  if (!btn) return
  _api.getSetting('aiWebDeepseek').then((on) => {
    const enabled = !!on
    btn.textContent = enabled ? '停用 DeepSeek（网页版）' : '启用 DeepSeek（网页版）'
    btn.classList.toggle('btn-ghost', enabled)
    btn.classList.toggle('btn-accent', !enabled)
  }).catch(() => {})
}

async function toggleWebDeepseek() {
  const tag = (typeof WbWebChat !== 'undefined' && WbWebChat.APPS.deepseek && WbWebChat.APPS.deepseek.tag) || '[网页]DeepSeek'
  const cur = await _api.getSetting('aiWebDeepseek')
  const next = !cur
  await _api.setSetting('aiWebDeepseek', next)
  if (next) {
    const list = (await _api.getSetting('chatModelList')) || []
    if (!list.includes(tag)) { list.push(tag); await _api.setSetting('chatModelList', list) }
    addWebAppToWorkbench('deepseek')
    showToast('已启用：工作台出现网页页签，首次需在网页里登录 DeepSeek 账号', 'success')
  } else {
    const list = ((await _api.getSetting('chatModelList')) || []).filter((m) => m !== tag)
    await _api.setSetting('chatModelList', list)
    if (typeof WbWebChat !== 'undefined') WbWebChat.destroy('deepseek')
    state.wbItems = state.wbItems.filter((w) => w.kind !== 'webapp')
    wbRenderedKey = null
    renderWorkbench()
    wbPersist()
    showToast('已停用 DeepSeek（网页版）', 'info')
  }
  syncWebDeepseekBtn()
  fillModelSelects()
}

// 填充"我的常用模型"下拉栏 + 输入联想（数据来自用户自己添加的清单）
async function fillModelSelects() {
  const chatList = (await _api.getSetting('chatModelList')) || []
  const visionList = (await _api.getSetting('visionModelList')) || []
  const mSel = $('aiModelPresetSelect')
  const vSel = $('aiVisionModelPresetSelect')
  mSel.innerHTML = `<option value="">我的常用模型${chatList.length ? '' : '（空：输入后点「添加」）'}</option>` +
    chatList.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
  vSel.innerHTML = `<option value="">我的常用识图模型${visionList.length ? '' : '（空：输入后点「添加」）'}</option>` +
    visionList.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
  $('aiModelPresets').innerHTML = chatList.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')
  $('aiVisionModelPresets').innerHTML = visionList.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('')
  syncModelSelect(mSel, $('aiModelInput').value)
  syncModelSelect(vSel, $('aiVisionModelInput').value)
  fillQuickModelSelect() // 聊天区快捷下拉与清单同步
}

// 常用清单增删：➕ 把当前输入框的值加进清单；🗑 删除选中的那一项
async function addToModelList(listKey, inputId, selId) {
  const input = $(inputId)
  const v = input.value.trim()
  if (!v) return showToast('先在输入框里填模型名再加')
  const list = (await _api.getSetting(listKey)) || []
  if (!list.includes(v)) {
    list.push(v)
    await _api.setSetting(listKey, list)
  }
  await fillModelSelects()
  $(selId).value = v
}
async function delFromModelList(listKey, selId) {
  const sel = $(selId)
  const v = sel.value
  if (!v) return showToast('先在下拉里选中要删的模型')
  const list = ((await _api.getSetting(listKey)) || []).filter((m) => m !== v)
  await _api.setSetting(listKey, list)
  await fillModelSelects()
}

// 下拉与输入框联动：当前值在清单里就选中它，自定义值保持"从常用中选择"占位
function syncModelSelect(sel, val) {
  if (!sel) return
  sel.value = ''
  if (val && Array.from(sel.options).some((o) => o.value === val)) sel.value = val
}

// --- 自定义规则：逐条添加 ---
function renderRulesEditor() {
  const listEl = $('aiRulesList')
  if (!listEl) return
  listEl.innerHTML = ''
  if (!work.rules.length) {
    listEl.innerHTML = '<div class="ai-rule-empty">暂无规则，可添加如「所有新文件统一放到 D:\\AI输出」</div>'
    return
  }
  work.rules.forEach((rule, idx) => {
    const item = document.createElement('div')
    item.className = 'ai-rule-item'
    const num = document.createElement('span')
    num.className = 'ai-rule-num'
    num.textContent = (idx + 1) + '.'
    const text = document.createElement('span')
    text.className = 'ai-rule-text'
    text.textContent = rule
    const del = document.createElement('button')
    del.className = 'ai-rule-del'
    del.innerHTML = iconSvg('x')
    del.title = '删除这条规则'
    del.addEventListener('click', () => {
      work.rules.splice(idx, 1)
      renderRulesEditor()
    })
    item.appendChild(num)
    item.appendChild(text)
    item.appendChild(del)
    listEl.appendChild(item)
  })
}

function addRuleFromInput() {
  const input = $('aiRuleNewInput')
  const val = (input.value || '').trim().slice(0, 500)
  if (!val) return
  if (!work.rules) work.rules = []
  if (work.rules.length >= 50) {
    showToast('规则最多 50 条', 'error')
    return
  }
  work.rules.push(val)
  input.value = ''
  renderRulesEditor()
  input.focus()
}

// --- AI 长期记忆：设置里可查看/删除 ---
function renderMemoryEditor() {
  const listEl = $('aiMemoryList')
  if (!listEl) return
  listEl.innerHTML = ''
  const mem = work.memory || []
  if (!mem.length) {
    listEl.innerHTML = '<div class="ai-rule-empty">暂无记忆。和 AI 聊天时表达偏好（如「文件都放桌面」），它会自动记住。</div>'
    return
  }
  mem.forEach((m, idx) => {
    const item = document.createElement('div')
    item.className = 'ai-rule-item'
    const num = document.createElement('span')
    num.className = 'ai-rule-num'
    num.textContent = (idx + 1) + '.'
    const text = document.createElement('span')
    text.className = 'ai-rule-text'
    text.textContent = m.fact || ''
    const del = document.createElement('button')
    del.className = 'ai-rule-del'
    del.innerHTML = iconSvg('x')
    del.title = '删除这条记忆'
    del.addEventListener('click', () => {
      work.memory.splice(idx, 1)
      renderMemoryEditor()
    })
    item.appendChild(num)
    item.appendChild(text)
    item.appendChild(del)
    listEl.appendChild(item)
  })
}

async function saveAiSettings() {
  const cfg = {
    provider: $('aiProviderSelect').value,
    baseUrl: $('aiBaseUrlInput').value.trim(),
    apiKey: $('aiApiKeyInput').value.trim(),
    model: $('aiModelInput').value.trim(),
    visionModel: $('aiVisionModelInput').value.trim(),
    voiceModel: $('aiVoiceModelInput').value.trim(),
    imageModel: $('aiImageModelInput').value.trim(),
    imageEditModel: $('aiImageEditModelInput').value.trim(),
    videoModel: $('aiVideoModelInput').value.trim(),
    compactEnabled: $('aiCompactToggle').checked,
    contextLimit: parseInt($('aiContextLimitInput').value) || null, // 空=清除该模型专属上限回默认（按模型保存，v2.4.81）
    approvalMode: $('aiModeSelect').value,
    rules: (work.rules || []).slice(),
    memory: (work.memory || []).slice()
  }
  try {
    await _api.setSetting('preferOpen', $('preferOpenSelect').value) // 文件打开方式：内置/系统（main.js shell:open-file 读取）
    await _api.setSetting('aiTtsModel', $('aiTtsModelInput').value.trim()) // v2.4.97：语音合成模型/音色（v2.4.99 更新源内置不再存）
    await _api.setSetting('aiTtsVoice', $('aiTtsVoiceSelect').value)
    await _api.aiSetConfig(cfg)
    const fresh = await _api.aiGetConfig()
    if (fresh) { work.config = fresh; updateApprovalTag() }
    fillQuickModelSelect() // 设置里改了主模型，快捷下拉同步
    $('aiSettingsModal').classList.add('hidden')
    showToast('AI 设置已保存', 'success')
  } catch (err) {
    showToast(`保存失败: ${err.message}`, 'error')
  }
}

// ===== v2.4.97：语音合成试听 / 应用更新检查 / 定时任务 =====
let _ttsAudio = null
async function ttsTestPlay() {
  const btn = $('aiTtsTestBtn')
  const text = $('aiTtsTestText').value.trim() || '你好喵，我是 MSMate 的 AI 助手'
  btn.disabled = true
  btn.innerHTML = iconSvg('loader-circle') + ' 合成中'
  try {
    const r = await _api.ttsSpeak({
      text,
      voice: $('aiTtsVoiceSelect').value || undefined,
      model: $('aiTtsModelInput').value.trim() || undefined
    })
    if (!r || r.error) { showToast((r && r.error) || '语音合成失败', 'error'); return }
    if (_ttsAudio) { try { _ttsAudio.pause() } catch {} }
    _ttsAudio = new Audio('data:audio/mp3;base64,' + r.audioBase64)
    _ttsAudio.play().catch(() => showToast('播放失败', 'error'))
  } catch (err) {
    showToast(`试听失败: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
    btn.innerHTML = iconSvg('play') + ' 试听'
  }
}
async function checkAppUpdate() {
  const btn = $('checkUpdateBtn')
  const out = $('updateResultText')
  btn.disabled = true
  out.textContent = '正在检查更新…'
  try {
    const r = await _api.checkUpdate()
    if (r && r.error) { out.textContent = r.message || '检查失败'; return }
    if (r && r.hasUpdate) {
      // v2.5.2：发现新版自动开始下载（进度在顶部横幅），不再等用户点"去下载"
      out.textContent = `发现新版本 v${r.latest}（当前 v${r.current}），已自动开始下载，进度见顶部横幅。下载完可直接点横幅里的「立即重启更新」，或退出软件时自动装好。`
      if (r.notes) {
        const notes = document.createElement('div')
        notes.style.cssText = 'opacity:.7;white-space:pre-wrap;margin-top:4px'
        notes.textContent = String(r.notes).slice(0, 300)
        out.appendChild(notes)
      }
      startInAppUpdate()
    } else if (r) {
      out.textContent = `已是最新版本（${r.current}）`
    }
  } catch (err) {
    out.textContent = `检查失败: ${err.message}`
  } finally { btn.disabled = false }
}
// v2.4.98：启动后静默检查更新；v2.5.0：应用内下载闭环（offer 发现新版 / progress 下载中 / ready 重启安装）
let _updateBannerDismissed = false
let _updateDownloading = false // 前端防重：进度事件流已接住时不再重复发下载请求
function setUpdateBannerMode(mode, info) {
  const banner = $('updateBanner'), text = $('updateBannerText'), bar = $('updateBannerBar'), fill = $('updateBannerFill')
  const dl = $('updateBannerDownload'), inst = $('updateBannerInstall')
  if (!banner || !text) return
  banner.classList.remove('hidden')
  if (dl) dl.classList.toggle('hidden', mode !== 'offer')
  if (inst) inst.classList.toggle('hidden', mode !== 'ready')
  if (bar) bar.classList.toggle('hidden', mode !== 'progress')
  if (fill && mode !== 'progress') fill.style.width = '0%'
  if (mode === 'offer') text.innerHTML = `发现新版本 <b>v${escapeHtml((info && info.latest) || '')}</b>（当前 v${escapeHtml((info && info.current) || '')}）`
  else if (mode === 'progress') text.innerHTML = `正在下载 <b>v${escapeHtml((info && info.version) || '')}</b>…`
  else if (mode === 'ready') text.innerHTML = `<b>v${escapeHtml((info && info.version) || '')}</b> 已就绪！点右边立即重启更新；不点的话退出软件时也会自动装好（装完不自动打开，下次自己打开就是新版）`
}
function updateBannerProgress(d) {
  const bar = $('updateBannerBar'), fill = $('updateBannerFill'), text = $('updateBannerText')
  if (bar && bar.classList.contains('hidden')) setUpdateBannerMode('progress', d)
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, d.percent || 0))}%`
  if (text) {
    const part = d.totalMB ? `（${d.receivedMB || 0}/${d.totalMB} MB）` : ''
    text.innerHTML = `正在下载 <b>v${escapeHtml(d.version || '')}</b> ${d.percent || 0}%${part}`
  }
}
async function startInAppUpdate() {
  if (_updateDownloading) return
  _updateDownloading = true
  setUpdateBannerMode('progress', {})
  try {
    const r = await _api.updateDownload()
    if (r && r.ok && r.status === 'readyToInstall') { _updateDownloading = false; setUpdateBannerMode('ready', r); return }
    if (r && r.ok && r.status === 'uptodate') {
      _updateDownloading = false
      const b = $('updateBanner'); if (b) b.classList.add('hidden')
      showToast(`已是最新版本（${r.current}）`, 'success'); return
    }
    if (r && !r.ok) { // 失败：进度事件流会先发 error 兜底，这里再兜一层
      _updateDownloading = false
      const b = $('updateBanner'); if (b) b.classList.add('hidden')
      showToast(r.error || '下载失败', 'error')
    }
    // r.ok && r.status === 'downloading'（含 already）：进度事件流接管
  } catch (err) {
    _updateDownloading = false
    const b = $('updateBanner'); if (b) b.classList.add('hidden')
    showToast(`下载失败: ${err.message}`, 'error')
  }
}
// v2.5.6：安装中遮罩——替代 v2.5.4 的独立进度窗进程（那玩意从旧 exe 运行且全程存活，
// 锁死安装目录导致升级卸旧必炸）。主窗口内提示，退出后由安装器自动拉起新版
function showInstallOverlay() {
  if ($('msm-install-overlay')) return
  const ov = document.createElement('div')
  ov.id = 'msm-install-overlay'
  ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(30,25,60,.45);display:flex;align-items:center;justify-content:center'
  ov.innerHTML = `
    <div style="width:320px;padding:26px 30px;background:var(--card,#fff);border-radius:16px;box-shadow:0 18px 60px rgba(30,20,80,.35);text-align:center">
      <div style="margin:0 auto 14px;width:34px;height:34px;border-radius:50%;border:4px solid var(--line,rgba(0,0,0,.08));border-top-color:#6d5ae0;animation:msmSpin .9s linear infinite"></div>
      <div style="font-size:15px;font-weight:700;color:var(--text,#2a2547)">正在安装更新…</div>
      <div style="font-size:12px;color:var(--text-2,#8a85a8);margin-top:6px">装完后将自动重启新版，请稍候</div>
    </div>
    <style>@keyframes msmSpin{to{transform:rotate(360deg)}}</style>`
  document.body.appendChild(ov)
}
function removeInstallOverlay() {
  const ov = $('msm-install-overlay')
  if (ov) ov.remove()
}
async function installUpdateNow() {
  const btn = $('updateBannerInstall')
  if (btn) { btn.disabled = true; btn.textContent = '正在重启…' }
  showInstallOverlay()
  await new Promise((r) => setTimeout(r, 1200)) // 遮罩展示 1.2 秒再退出，用户有感知
  try {
    const r = await _api.updateInstall()
    if (r && !r.ok) {
      removeInstallOverlay()
      showToast(r.error || '启动安装失败', 'error')
      if (btn) { btn.disabled = false; btn.textContent = '立即重启更新' }
    }
  } catch (err) {
    removeInstallOverlay()
    showToast(`重启失败: ${err.message}`, 'error')
    if (btn) { btn.disabled = false; btn.textContent = '立即重启更新' }
  }
}
// v2.5.4：更新完成欢迎弹窗——装完新版首次启动，用"人话"告诉用户这次更新了什么。
// 数据源：主进程下载更新时存下的 Release 说明（settings.updateNotes）；
// 只在「notes 版本 == 当前版本 && 没弹过」时弹一次，弹完标记，之后再也不打扰。
async function showUpdateWelcome() {
  try {
    const info = await _api.getInfo()
    const ver = info && info.version
    if (!ver) return
    const n = await _api.getSetting('updateNotes')
    if (!n || n.version !== ver || !(n.notes || '').trim()) return
    const shown = await _api.getSetting('updateNotesShown')
    if (shown === n.version) return
    await showUpdateWelcomeModal(n)
    await _api.setSetting('updateNotesShown', n.version)
  } catch { } // 静默：没 notes/手动装的/读失败都不打扰
}
function showUpdateWelcomeModal(n) {
  return new Promise((resolve) => {
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(30,25,60,.42);display:flex;align-items:center;justify-content:center'
    const card = document.createElement('div')
    card.style.cssText = 'width:540px;max-width:92vw;max-height:78vh;display:flex;flex-direction:column;background:var(--card,#fff);border-radius:16px;box-shadow:0 18px 60px rgba(30,20,80,.35);overflow:hidden'
    card.innerHTML = `
      <div style="padding:18px 22px 12px;display:flex;align-items:center;gap:12px">
        <img src="../assets/icon.png" alt="" style="width:40px;height:40px;border-radius:11px;flex:none;object-fit:contain;box-shadow:0 4px 10px rgba(109,90,224,.25)">
        <div>
          <div style="font-size:16px;font-weight:700;color:var(--text,#2a2547)">MSMate 已更新到 v${escapeHtml(n.version)}</div>
          <div style="font-size:12px;color:var(--text-2,#8a85a8);margin-top:2px">这次更新了这些，看看有什么新变化 →</div>
        </div>
      </div>
      <div class="md-body" style="flex:1;overflow:auto;padding:4px 22px 10px;font-size:13px;line-height:1.75;color:var(--text,#2a2547)"></div>
      <div style="padding:12px 22px 16px;display:flex;justify-content:flex-end;border-top:1px solid var(--line,rgba(0,0,0,.06))">
        <button class="btn btn-accent" style="min-width:110px">知道了，开始用</button>
      </div>`
    const body = card.querySelector('.md-body')
    try { body.appendChild(renderMarkdownFrag(n.notes)) } catch { body.textContent = n.notes }
    const close = () => { ov.remove(); resolve() }
    card.querySelector('button').addEventListener('click', close)
    ov.addEventListener('click', (e) => { if (e.target === ov) close() })
    ov.appendChild(card)
    document.body.appendChild(ov)
  })
}
async function startupUpdateCheck() {
  if (_updateBannerDismissed) return
  const banner = $('updateBanner')
  if (!banner || !banner.classList.contains('hidden')) return // 已显示/无元素：跳过
  try {
    const st = _api.updateGetState ? await _api.updateGetState() : null // 先恢复本地状态：上次下载完没装的，直接提示重启更新
    if (st && st.status === 'readyToInstall') { setUpdateBannerMode('ready', st); return }
    const r = await _api.checkUpdate()
    if (!r || r.error || !r.hasUpdate || _updateBannerDismissed) return
    // v2.5.2：检测到新版直接自动下载（老大拍板：要用户点同意的话，退出自动更新就没意义了）
    startInAppUpdate()
  } catch { } // 静默：网络不通/未填仓库都不打扰
}
// 定时任务（存 aiSchedules：[{id,time,task,sessionId,enabled}]，主进程 30s 扫描到点派发）
let _schedulesCache = []
async function loadSchedules() {
  try { _schedulesCache = (await _api.getSetting('aiSchedules')) || [] } catch { _schedulesCache = [] }
  if (!Array.isArray(_schedulesCache)) _schedulesCache = []
  renderSchedules()
}
function renderSchedules() {
  const box = $('aiScheduleList')
  if (!box) return
  if (!_schedulesCache.length) { box.innerHTML = '<span style="opacity:.6">（还没有定时任务）</span>'; return }
  box.innerHTML = ''
  for (const t of _schedulesCache) {
    const row = document.createElement('div')
    row.className = 'rule-item'
    const info = document.createElement('span')
    info.innerHTML = `${iconSvg('clock')} ${t.time} · ${escapeHtml(t.task)}${t.enabled ? '' : '（已暂停）'}`
    const ops = document.createElement('span')
    const tgl = document.createElement('button')
    tgl.className = 'btn btn-sm'
    tgl.textContent = t.enabled ? '暂停' : '启用'
    tgl.onclick = async () => { t.enabled = !t.enabled; await _api.setSetting('aiSchedules', _schedulesCache); renderSchedules() }
    const del = document.createElement('button')
    del.className = 'btn btn-sm'
    del.textContent = '删除'
    del.onclick = async () => { _schedulesCache = _schedulesCache.filter((x) => x.id !== t.id); await _api.setSetting('aiSchedules', _schedulesCache); renderSchedules() }
    ops.appendChild(tgl)
    ops.appendChild(del)
    row.appendChild(info)
    row.appendChild(ops)
    box.appendChild(row)
  }
}
async function addSchedule() {
  const time = $('aiScheduleTime').value
  const task = $('aiScheduleTask').value.trim()
  if (!time) { showToast('先选执行时间', 'error'); return }
  if (!task) { showToast('先填任务描述', 'error'); return }
  _schedulesCache.push({ id: 'sched_' + Date.now().toString(36), time, task, sessionId: $('aiScheduleSession').value || '', enabled: true })
  await _api.setSetting('aiSchedules', _schedulesCache)
  $('aiScheduleTask').value = ''
  renderSchedules()
  showToast(`定时任务已添加：每天 ${time} 自动执行`, 'success')
}
// 派发目标会话下拉（Work 模式全部会话）
async function fillScheduleSessions() {
  const sel = $('aiScheduleSession')
  if (!sel) return
  try {
    const list = (await _api.aiSessions()) || []
    const cur = sel.value
    sel.innerHTML = '<option value="">默认会话</option>' +
      list.filter((s) => s && s.id).map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title || s.id.slice(0, 8))}</option>`).join('')
    if (list.some((s) => s.id === cur)) sel.value = cur
  } catch {}
}

// ===== 数据同步：跨设备物理迁移（导出 zip / 导入 zip + 重启生效） =====
async function exportWorkData() {
  const btn = $('aiExportDataBtn')
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  btn.disabled = true
  try {
    const r = await _api.aiExportData(`msmate-data-${stamp}.zip`)
    if (!r || r.canceled) return
    if (!r.success) return showToast(r.error || '导出失败', 'error')
    showToast(`已导出：${r.path}`, 'success')
  } catch (err) {
    showToast(`导出失败: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
  }
}

async function importWorkData() {
  const btn = $('aiImportDataBtn')
  if (!confirm('导入会覆盖本机的设置、规则、长期记忆、所有会话记录和工作台文件（导入前会自动备份）。\n确定继续吗？')) return
  btn.disabled = true
  try {
    const r = await _api.aiImportData()
    if (!r || r.canceled) return
    if (!r.success) return showToast(r.error || '导入失败', 'error')
    alert(`导入成功（${r.summary}），应用即将重启以生效。`)
    await _api.aiRestartApp()
  } catch (err) {
    showToast(`导入失败: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
  }
}

// ===== 快照弹窗 =====
async function openSnapshots() {
  await renderSnapshots()
  $('snapshotsModal').classList.remove('hidden')
}

async function renderSnapshots() {
  const listEl = $('snapshotList')
  work.restoreArmed = null
  let list = []
  try { list = await _api.aiListSnapshots() || [] } catch {}
  if (!list.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('archive')}</div><div>暂无快照</div><div class="empty-hint">AI 删除/覆盖文件前会自动备份到这里</div></div>`
    return
  }
  listEl.innerHTML = ''
  for (const s of list) {
    const item = document.createElement('div')
    item.className = 'snapshot-item'
    const time = new Date(s.time).toLocaleString('zh-CN')
    const sizeText = s.size ? ` · ${formatSize(s.size)}` : ''
    const targetText = s.target && s.target !== 'local' ? ` · 设备: ${escapeHtml(String(s.target))}` : ' · 本机'
    const okText = s.ok ? '' : `<span class="bad"> · 备份未成功</span>`
    item.innerHTML = `
      <div class="snapshot-info">
        <div class="snapshot-path">${escapeHtml(s.originalPath || '')}</div>
        <div class="snapshot-meta">${time}${sizeText}${targetText}${okText}</div>
      </div>
      <div class="snapshot-actions"></div>`
    const actions = item.querySelector('.snapshot-actions')
    if (s.ok) {
      const restoreBtn = document.createElement('button')
      restoreBtn.className = 'btn btn-accent btn-xs'
      restoreBtn.textContent = '还原'
      restoreBtn.addEventListener('click', async () => {
        if (work.restoreArmed !== s.id) {
          work.restoreArmed = s.id
          restoreBtn.textContent = '确认还原?'
          setTimeout(() => {
            if (work.restoreArmed === s.id) { work.restoreArmed = null; restoreBtn.textContent = '还原' }
          }, 3000)
          return
        }
        restoreBtn.disabled = true
        const r = await _api.aiRestoreSnapshot(s.id).catch((err) => ({ success: false, error: err.message }))
        if (r && r.success) {
          showToast('快照已还原', 'success')
          renderSnapshots()
        } else {
          showToast(`还原失败: ${(r && r.error) || '未知错误'}`, 'error')
          restoreBtn.disabled = false
        }
      })
      actions.appendChild(restoreBtn)
    }
    const delBtn = document.createElement('button')
    delBtn.className = 'btn btn-ghost btn-xs'
    delBtn.textContent = '删除'
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true
      await _api.aiDeleteSnapshot(s.id).catch(() => {})
      renderSnapshots()
    })
    actions.appendChild(delBtn)
    listEl.appendChild(item)
  }
}

// ===== 消息渲染 =====
function clearChatEmpty() {
  const empty = curChatEl().querySelector('.empty-state')
  if (empty) empty.remove()
}

function scrollChat(force) {
  const chatList = $('chatList')
  if (chatList && (force || work.stickToBottom)) chatList.scrollTop = chatList.scrollHeight
}

// 引用标记解析（顶层共享：输入胶囊 + 用户消息渲染都用）
function refIcon(name) {
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) return iconSvg('folder')
  if (/\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name)) return iconSvg('image')
  if (/\.(zip|rar|7z|gz)$/i.test(name)) return iconSvg('archive')
  if (/\.(docx?|xlsx?|pptx?|pdf|txt|md)$/i.test(name)) return iconSvg('file-text')
  return iconSvg('file-text')
}

function refChipMeta(ref) {
  // 划选引用：[来自文件 xxx 的划选] 标记行 + > 引用行（多行整体是一条 ref）
  const first = String(ref).split('\n')[0]
  const mQuote = /^\[来自文件 (.+) 的划选\]$/.exec(first)
  if (mQuote) return { icon: iconSvg('square-pen'), name: `${mQuote[1]} 的划选`, title: String(ref), quote: true }
  const mLocal = /^\[引用文件: (.+)\]$/.exec(ref)
  if (mLocal) {
    const p = mLocal[1]
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p
    return { icon: refIcon(name), name, title: p }
  }
  const mRemote = /^\[引用远程文件: (.+?)\|([^|]*)\|(.+)\]$/.exec(ref)
  if (mRemote) {
    const name = mRemote[3].split(/[\\/]/).filter(Boolean).pop() || mRemote[3]
    return { icon: refIcon(name), name: `${mRemote[1]}/${name}`, title: ref, remote: true }
  }
  // agent 层发送前会把 [引用文件: …] 转成 <file_ref target="…" path="…" /> 存历史，渲染时等价处理
  const mTag = /^<file_ref\s+target="([^"]*)"\s+path="([^"]*)"\s*\/>$/.exec(ref)
  if (mTag) {
    const target = (mTag[1] || 'local').trim()
    const p = (mTag[2] || '').trim()
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p
    if (target === 'local' || !target) return { icon: refIcon(name), name, title: p }
    let devName = target
    try {
      const info = state.connectedDevices && state.connectedDevices.get(target)
      if (info) devName = info.name || info.hostname || target
    } catch {}
    return { icon: refIcon(name), name: `${devName}/${name}`, title: p, remote: true }
  }
  return { icon: iconSvg('file-text'), name: ref, title: ref }
}

// v2.4.84：引用胶囊里可作参考图的本地图片路径（图片生成模式下自动转参考图）；远程/文档/划选返回 null。
// 只认 png/jpg/jpeg/webp——编辑模型（Qwen-Image-Edit）base64 通道实际支持的范围
function refImagePath(ref) {
  const m = /^\[引用文件: (.+)\]$/.exec(String(ref))
  if (!m) return null
  const p = m[1]
  return /\.(png|jpe?g|webp)$/i.test(p) ? p : null
}

function appendUserMsg(text, msgIndex) {
  clearChatEmpty()
  const chatList = curChatEl()
  const div = document.createElement('div')
  div.className = 'chat-msg user'
  div.dataset.text = text
  // 引用行 [引用文件: …] / [引用远程文件: …] / [来自文件 xxx 的划选]+>引用块 渲染为只读胶囊，其余为正文（AI 收到的原文不变）
  const refs = []
  const bodyLines = []
  let quoteBuf = null // 划选引用：标记行 + 后续 > 行收成一条 ref
  const flushQuote = () => {
    if (quoteBuf) {
      refs.push([quoteBuf.marker, ...quoteBuf.lines].join('\n'))
      quoteBuf = null
    }
  }
  for (const ln of String(text).split('\n')) {
    const t = ln.trim()
    const qm = /^\[来自文件 (.+) 的划选\]$/.exec(t)
    if (qm) { flushQuote(); quoteBuf = { marker: t, lines: [] }; continue }
    if (quoteBuf && /^>\s?/.test(ln)) { quoteBuf.lines.push(ln); continue }
    flushQuote()
    if (/^\[引用(远程)?文件: .+\]$/.test(t) || /^<file_ref\s+/.test(t)) refs.push(t)
    else bodyLines.push(ln)
  }
  flushQuote()
  if (refs.length) {
    const refsEl = document.createElement('div')
    refsEl.className = 'chat-refs msg-refs'
    for (const ref of refs) {
      const meta = refChipMeta(ref)
      const chip = document.createElement('span')
      chip.className = 'chat-ref-chip' + (meta.remote ? ' remote' : '')
      chip.title = meta.title
      const icon = document.createElement('span')
      icon.className = 'ref-icon'
      icon.innerHTML = meta.icon // meta.icon 是 SVG 串，textContent 会显示源码（2.7.1 补修）
      const name = document.createElement('span')
      name.className = 'ref-name'
      name.textContent = meta.name
      chip.append(icon, name)
      refsEl.appendChild(chip)
    }
    div.appendChild(refsEl)
  }
  const body = bodyLines.join('\n').replace(/^\s+|\s+$/g, '')
  if (body) {
    const bodyEl = document.createElement('span')
    bodyEl.textContent = body
    div.appendChild(bodyEl)
  }
  if (!body && !refs.length) div.textContent = text
  if (msgIndex !== null && msgIndex !== undefined) {
    const btn = document.createElement('button')
    btn.className = 'msg-checkpoint'
    btn.textContent = '↩ 回到此处'
    btn.title = '回滚到这条消息之前：还原被改/删的文件、删除 AI 新建的文件，并撤回这段对话'
    btn.addEventListener('click', () => doRollback(msgIndex, btn, text))
    div.appendChild(btn)
  }
  chatList.appendChild(div)
  scrollChat(true)
}

async function doRollback(msgIndex, btn, originalText) {
  if (work.running) {
    showToast('AI 正在执行任务，请先停止', 'error')
    return
  }
  // Trae 式确认卡：先拉"将撤销哪些文件操作"的清单，看清变化再拍板（老大要求"一定一定可以真实回退"）
  let preview = null
  try { preview = await _api.aiRollbackPreview(msgIndex, work.active) } catch {}
  showRollbackConfirm(msgIndex, btn, originalText, preview)
}

// 回滚确认卡（Trae 式，内嵌聊天流）：看清将撤销哪些文件操作，取消或确认
function showRollbackConfirm(msgIndex, btn, originalText, preview) {
  const old = $('rollbackConfirmCard')
  if (old) old.remove()
  const card = document.createElement('div')
  card.id = 'rollbackConfirmCard'
  card.className = 'rb-card'
  const items = (preview && preview.items) || []
  const listHtml = items.map((it) => `
    <div class="rb-item${it.action.indexOf('删除') !== -1 ? ' danger' : ''}">
      <span class="rb-icon">${iconSvg(it.action.indexOf('删除') !== -1 ? 'trash-2' : 'file-text')}</span>
      <span class="rb-name" title="${escapeHtml(it.path || '')}">${escapeHtml(it.name || '')}</span>
      <span class="rb-action">${escapeHtml(it.action)}</span>
    </div>`).join('')
  card.innerHTML = `
    <div class="rb-title">${iconSvg('triangle-alert')}<span>确定要回滚到此步骤并重新开始吗？</span></div>
    ${items.length ? `<div class="rb-list">${listHtml}</div>` : '<div class="rb-empty">这一步没有文件改动，仅撤回这段对话</div>'}
    <div class="rb-tip">文件将还原为该步骤之前的状态（逆序撤销），此段对话会撤回，原消息填回输入框</div>
    <div class="rb-btns">
      <button class="btn btn-ghost" id="rbCancel">取消</button>
      <button class="btn btn-ghost" id="rbRollback">仅回滚</button>
      <button class="btn btn-primary" id="rbRerun">回滚并重跑</button>
    </div>`
  // 内嵌聊天流：插到「回到此处」按钮所在消息的后面，不做全屏遮罩（Trae 同款对话框形态）
  const msgEl = btn && btn.parentElement
  if (msgEl && msgEl.parentElement) msgEl.after(card)
  else (curChatEl() || document.body).appendChild(card)
  card.scrollIntoView({ block: 'nearest' })
  const close = () => card.remove()
  card.querySelector('#rbCancel').addEventListener('click', close)
  const execRollback = async (rerun) => {
    close()
    btn.disabled = true
    btn.textContent = '回滚中…'
    const r = await _api.aiRollback(msgIndex, work.active).catch((err) => ({ success: false, error: err.message }))
    if (r && r.success) {
      showToast(`已回滚 ${r.undone} 项文件操作${r.failed ? `（${r.failed} 项失败）` : ''}`, r.failed ? 'error' : 'success')
      // 原消息文本回填输入框，方便改一改重新发送
      if (typeof originalText === 'string') {
        const chatInput = $('chatInput')
        if (chatInput) {
          chatInput.value = originalText
          chatInput.dispatchEvent(new Event('input')) // 触发动态增高重算
          chatInput.focus()
        }
      }
      if (rerun) {
        // Trae 同款"回退并重新开始"：回滚完成后自动重发原消息（稍等输入框回填与刷新落定）
        setTimeout(() => { const send = $('chatSend'); if (send && !work.running) send.click() }, 400)
      }
    } else {
      showToast(`回滚失败: ${(r && r.error) || '未知错误'}`, 'error')
      btn.disabled = false
      btn.textContent = '↩ 回到此处'
    }
  }
  card.querySelector('#rbRollback').addEventListener('click', () => execRollback(false))
  card.querySelector('#rbRerun').addEventListener('click', () => execRollback(true))
}

function appendChatError(text) {
  clearChatEmpty()
  const chatList = curChatEl()
  const div = document.createElement('div')
  div.className = 'chat-msg error'
  div.textContent = text
  chatList.appendChild(div)
  // v0.4 积分不足（服务端 402 INSUFFICIENT_CREDITS）：错误条下方附「去充值」，一键打开充值弹窗
  if (/积分不足|INSUFFICIENT_CREDITS/.test(String(text))) {
    const row = document.createElement('div')
    row.className = 'chat-msg chat-recharge-row'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-primary btn-xs'
    btn.textContent = '去充值'
    btn.addEventListener('click', () => {
      btn.disabled = true
      if (typeof creditsOpen === 'function') creditsOpen()
      btn.disabled = false
    })
    row.appendChild(btn)
    chatList.appendChild(row)
  }
  scrollChat(true)
}

// 限流等待提示：单条复用（无限重试也不刷屏），带转圈；每次显示都挪到聊天最底部（多轮任务不埋楼上）；流恢复/轮次结束即撤
function showRetryWait(text) {
  const ctx = work._ctx
  const list = curChatEl()
  if (!list) return
  let el = ctx._retryNotice
  if (!el || !el.isConnected) {
    clearChatEmpty()
    el = document.createElement('div')
    el.className = 'chat-msg steps-notice retry-waiting'
    ctx._retryNotice = el
  }
  list.appendChild(el) // appendChild 对已挂载元素=移动到末尾，保证永远贴着最新消息
  el.innerHTML = `<span class="ai-spin"></span><span>${escapeHtml(text)}</span>`
  scrollChat(true)
}

function hideRetryWait() {
  const ctx = work._ctx
  if (ctx._retryNotice && ctx._retryNotice.isConnected) ctx._retryNotice.remove()
  ctx._retryNotice = null
}

// 步数用尽提示：本轮 AI 反复空转烧满上限被系统叫停（非报错，轻提示即可）
function appendStepsNotice(max) {
  finalizeAssistant()
  clearChatEmpty()
  const chatList = curChatEl()
  const div = document.createElement('div')
  div.className = 'chat-msg steps-notice'
  div.textContent = `ℹ️ AI 本轮执行步数已达上限（${max} 步），已自动停止。可以点这条消息下方重新发送，或把任务拆小一点再试。`
  chatList.appendChild(div)
  scrollChat(true)
}

async function restoreHistory(sid) {
  const chatList = curChatEl()
  chatList.innerHTML = emptyChatHtml()
  work.toolCards.clear()
  work.roundSteps = []
  work.curAssistant = null
  work.curContent = ''
  const history = await _api.aiGetHistory(sid).catch(() => [])
  if (!Array.isArray(history)) return
  // 从历史消息重建过程折叠块：assistant 消息里的 tool 块 → ⚙️ 折叠块，最后的纯文本回复展开
  let groupCalls = [] // 当前一轮累积的工具调用摘要 [{name, args}]
  // 段内积分总和（v2.7.14）：多步任务最后一条总结显示整段累计（每步积分仍在各自中间消息上）。段 = 两条真实用户消息之间
  const segTotals = new Map()
  {
    let acc = 0
    let lastAssistantIdx = -1
    for (let i = 0; i < history.length; i++) {
      const m = history[i]
      const isRealUser = m.role === 'user' && m.content && !m.content.startsWith('<tool_result') && !m.content.startsWith('（系统提示')
      if (isRealUser) {
        if (lastAssistantIdx >= 0) segTotals.set(lastAssistantIdx, acc)
        acc = 0
        lastAssistantIdx = -1
      } else if (m.role === 'assistant') {
        acc += m._credits || 0
        lastAssistantIdx = i
      }
    }
    if (lastAssistantIdx >= 0) segTotals.set(lastAssistantIdx, acc)
  }
  const flushGroup = (finalMsg, reasoning, credits) => {
    if (groupCalls.length) {
      clearChatEmpty()
      appendProcessFold(groupCalls)
      groupCalls = []
    }
    if (finalMsg) {
      clearChatEmpty()
      const div = document.createElement('div')
      div.className = 'chat-msg assistant'
      div.innerHTML = '<div class="chat-assistant-head"><img class="ai-avatar" src="../assets/icon.png" alt=""><span class="ai-name">MSMate</span></div>'
      // 历史里的 _reasoning（v0.4 入史）：重载后恢复"已深度思考"折叠块
      if (reasoning) {
        const think = document.createElement('div')
        think.className = 'chat-thinking collapsed'
        think.innerHTML = `<div class="chat-thinking-header"><span class="chat-thinking-chevron">${iconSvg('chevron-down')}</span><span class="label">已深度思考（点击展开）</span></div><div class="chat-thinking-body"></div>`
        think.querySelector('.chat-thinking-header').addEventListener('click', () => think.classList.toggle('collapsed'))
        div.appendChild(think)
        think.querySelector('.chat-thinking-body').textContent = String(reasoning).replace(/(?:\s*\n){3,}/g, '\n\n').trim()
      }
      const contentEl = document.createElement('div')
      contentEl.className = 'chat-content'
      div.appendChild(contentEl)
      linkifyFilePaths(contentEl, finalMsg)
      if (credits > 0) mountCreditsTag(div, credits) // 历史里的 _credits：重载后悬停仍能看到本次消耗
      chatList.appendChild(div)
    }
  }
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]
    if (msg.role === 'user') {
      if (!msg.content || msg.content.startsWith('<tool_result') || msg.content.startsWith('（系统提示')) continue
      flushGroup(null)
      appendUserMsg(msg.content, i)
    } else if (msg.role === 'assistant') {
      const calls = parseToolBlocksUI(msg.content || '')
      const clean = stripToolBlocks(msg.content || '').trim()
      if (calls.length) {
        groupCalls.push(...calls)
        if (clean) flushGroup(null) // 有说明文字但后面还有工具/回复，说明文字并入历史（可忽略）
      } else if (clean) {
        flushGroup(clean, msg._reasoning, segTotals.has(i) ? segTotals.get(i) : (msg._credits || 0))
      }
    }
  }
  flushGroup(null)
  scrollChat(true)
}

// UI 侧轻量解析 assistant 消息里的 ```tool``` 块
function parseToolBlocksUI(content) {
  const out = []
  const re = /```tool\s*([\s\S]*?)```/g
  let m
  while ((m = re.exec(content))) {
    try {
      const obj = JSON.parse(m[1])
      if (obj && obj.name) out.push({ name: obj.name, args: obj.args || {} })
    } catch {}
  }
  // DSML 兼容：DeepSeek 网页版漂移吐内部标记，历史重建也能还原成工具卡片（竖线/空格混排全宽容）
  const open = '<[\\s|]*DSML[\\s|]*invoke\\s+name\\s*=\\s*"([^"]+)"[\\s|]*>'
  const close = '<[\\s|]*\\/[\\s|]*DSML[\\s|]*invoke[\\s|]*>'
  for (const dm of String(content || '').matchAll(new RegExp(`${open}([\\s\\S]*?)${close}`, 'g'))) {
    const args = {}
    for (const p of dm[2].matchAll(/<[\s|]*DSML[\s|]*parameter\s+name\s*=\s*"([^"]+)"([^>]*)>([\s\S]*?)<[\s|]*\/[\s|]*DSML[\s|]*parameter[\s|]*>/g)) {
      let val = p[3].trim()
      if (/string\s*=\s*"false"/.test(p[2])) { try { val = JSON.parse(val) } catch {} }
      args[p[1].trim()] = val
    }
    if (dm[1].trim()) out.push({ name: dm[1].trim(), args })
  }
  // tool_call XML 标签兼容：Qwen/GLM 系漂移形态，历史重建还原成工具卡片
  // 标签体是函数调用风格 funcName(k=v,...)——切分/取值逻辑与主进程 parseToolCallArgs 同款
  for (const m of String(content || '').matchAll(/<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/g)) {
    const body = m[1].trim()
    const fm = body.match(/^([a-zA-Z_][\w.]*)\s*\(([\s\S]*)\)\s*$/)
    if (fm && fm[1]) {
      const args = {}
      const parts = []
      let depth = 0, inStr = false, esc = false, start = 0
      const s = fm[2]
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
      out.push({ name: fm[1], args })
    } else {
      try {
        const obj = JSON.parse(body)
        if (obj && obj.name) out.push({ name: obj.name, args: obj.args || obj.arguments || {} })
      } catch {}
    }
  }
  return out
}

// 在聊天列表末尾追加一个静态过程折叠块（历史重建用）
function appendProcessFold(calls) {
  const fold = document.createElement('div')
  fold.className = 'chat-process collapsed'
  fold.innerHTML = `
    <div class="chat-process-header"><span class="chat-process-chevron">${iconSvg('chevron-down')}</span><span class="label">已执行 ${calls.length} 步操作（点击展开）</span></div>
    <div class="chat-process-body"></div>`
  fold.querySelector('.chat-process-header').addEventListener('click', () => fold.classList.toggle('collapsed'))
  const body = fold.querySelector('.chat-process-body')
  for (const c of calls) {
    const row = document.createElement('div')
    row.className = 'tool-card static'
    const brief = Object.entries(c.args || {})
      .filter(([k]) => k !== 'content')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('　')
    row.innerHTML = `
      <div class="tool-card-head">
        <span class="tool-card-icon">${iconSvg(TOOL_ICONS[c.name] || 'wrench')}</span>
        <span>${escapeHtml(c.name === 'delegate' ? `委派子任务：${c.args.title || c.args.task || ''}` : c.name + (brief ? '　' + brief : ''))}</span>
        <span class="tool-card-status ok">完成</span>
      </div>`
    body.appendChild(row)
  }
  curChatEl().appendChild(fold) // 原代码引用了未声明的 chatList（潜在 ReferenceError），顺带修复
}

// ===== AI 事件处理 =====
// 多会话：事件带 sessionId，路由到对应会话的渲染上下文（后台会话照常实时渲染到自己的隐藏容器）
function handleAiEvent(ev) {
  if (!ev || !ev.type) return
  const sid = ev.sessionId || work.active || '__boot__'
  withSession(sid, () => handleAiEventInner(ev))
  // 后台会话任务完成时提示（仅在窗口最小化/失焦时打扰，正盯着界面时不弹）
  if (ev.type === 'run_done' && sid !== work.active && !document.hasFocus()) {
    const meta = sessionMeta(sid)
    showToast(`会话「${(meta && meta.title) || '后台'}」任务完成`, 'info')
    renderSessionBar()
  }
  // 新对话收到首条消息 → 自动取标题
  if (ev.type === 'user_msg') autoTitleSession(sid, ev.text)
  // 定时任务到点派发（v2.4.97）：全局 toast 让老大知道 AI 自动开工了
  if (ev.type === 'schedule_fired') {
    showToast(`定时任务已开工${ev.catchUp ? '（错过补跑）' : ''}：${String(ev.task || '').slice(0, 30)}`, 'info')
  }
}

function handleAiEventInner(ev) {
  if (!ev || !ev.type) return
  switch (ev.type) {
    case 'user_msg':
      work.stickToBottom = true
      appendUserMsg(ev.text, ev.msgIndex)
      showWaitingSpin() // 消息发出 → 模型开轮前显示等待转圈
      break
    case 'assistant_start': {
      hideWaitingSpin() // 模型开轮，撤掉等待行
      clearChatEmpty()
      const div = document.createElement('div')
      div.className = 'chat-msg assistant'
      div.innerHTML = `<div class="chat-assistant-head"><img class="ai-avatar" src="../assets/icon.png" alt=""><span class="ai-name">MSMate</span></div><div class="chat-thinking collapsed hidden"><div class="chat-thinking-header"><span class="chat-thinking-chevron">${iconSvg('chevron-down')}</span><span class="label">思考中…</span></div><div class="chat-thinking-body"></div></div><div class="chat-content"><span class="ai-spin"></span></div>`
      div.querySelector('.chat-thinking-header').addEventListener('click', function () {
        div.querySelector('.chat-thinking').classList.toggle('collapsed')
      })
      curChatEl().appendChild(div)
      work.curAssistant = div
      work.curContent = ''
      work.curReasoning = ''
      work.roundSteps.push(div)
      scrollChat(true)
      break
    }
    case 'reasoning_delta': {
      if (!work.curAssistant) break
      const thinking = work.curAssistant.querySelector('.chat-thinking')
      // 执行中实时展开思考，完成后由 finalizeAssistant 收起
      thinking.classList.remove('hidden', 'collapsed')
      thinking.classList.add('thinking-active')
      thinking.querySelector('.label').textContent = '思考中…'
      const body = thinking.querySelector('.chat-thinking-body')
      work.curReasoning += ev.delta
      // 压缩连续空行：思考内容紧凑显示，不留大片空白
      body.textContent = work.curReasoning.replace(/(?:\s*\n){3,}/g, '\n\n').replace(/^\n+/, '')
      body.scrollTop = body.scrollHeight
      scrollChat()
      break
    }
    case 'content_delta': {
      hideRetryWait() // 有正文流回 = 等待结束（网页等待心跳 / 限流重试提示收尾，v2.4.82）
      if (!work.curAssistant) break
      // 首段正文出现：收起思考块
      const thinking = work.curAssistant.querySelector('.chat-thinking')
      if (work.curContent === '' && !thinking.classList.contains('hidden')) {
        thinking.classList.add('collapsed')
        thinking.classList.remove('thinking-active')
        thinking.querySelector('.label').textContent = '已深度思考（点击展开）'
      }
      work.curContent += ev.delta
      // 流式渲染走 markdown（网页端观感）：全量重渲，聊天文本量级下开销可忽略
      const cEl = work.curAssistant.querySelector('.chat-content')
      cEl.textContent = ''
      cEl.appendChild(renderMarkdownFrag(work.curContent.replace(/^\s+/, '')))
      const cur = document.createElement('span')
      cur.className = 'cursor'
      const lastBlock = cEl.lastElementChild
      if (lastBlock && !['PRE', 'TABLE', 'UL', 'OL', 'HR'].includes(lastBlock.tagName)) lastBlock.appendChild(cur)
      else cEl.appendChild(cur)
      scrollChat()
      break
    }
    case 'media_done': {
      // 生成模式直连完成：清掉"正在生成…"占位文案，全量重渲最终结果（markdown 图片/链接卡片）
      if (!work.curAssistant) break
      work.curContent = ev.text || ''
      const cEl = work.curAssistant.querySelector('.chat-content')
      cEl.textContent = ''
      cEl.appendChild(renderMarkdownFrag(work.curContent.replace(/^\s+/, '')))
      scrollChat(true)
      break
    }
    case 'tool_call': {
      if (ev.delegate) break // delegate 卡片由 delegate_start 事件创建，避免重复
      finalizeAssistant()
      clearChatEmpty()
      const card = ev.name === 'ask_user' ? buildAskCard(ev) : buildToolCard(ev)
      work.toolCards.set(ev.callId, card)
      work.toolCallArgs = work.toolCallArgs || new Map()
      work.toolCallArgs.set(ev.callId, ev.args || {}) // edit_file diff / run_command 终端风渲染要回读参数
      work.roundSteps.push(card)
      curChatEl().appendChild(card)
      scrollChat(true)
      break
    }
    case 'delegate_start': {
      finalizeAssistant()
      clearChatEmpty()
      const card = buildDelegateCard(ev)
      work.toolCards.set(ev.delegateId, card)
      work.roundSteps.push(card)
      curChatEl().appendChild(card)
      scrollChat(true)
      break
    }
    case 'delegate_done': {
      const card = work.toolCards.get(ev.delegateId)
      if (card) {
        setToolStatus(card, ev.ok ? 'done' : 'error', ev.ok ? '子任务完成' : '子任务失败')
        const res = card.querySelector('.tool-card-result')
        if (res) {
          linkifyFilePaths(res, String(ev.summary || '').slice(0, 800))
          res.classList.remove('hidden')
        }
      }
      scrollChat()
      break
    }
    case 'tool_running': {
      const card = work.toolCards.get(ev.callId)
      if (card && !card.classList.contains('delegate-card') && !card.classList.contains('ask-card')) setToolStatus(card, 'running', '执行中')
      scrollChat()
      break
    }
    case 'tool_result': {
      // 记忆动作可视化：AI 记住/忘记时弹提示，让用户看得见记忆在积累
      if (ev.ok && (ev.name === 'remember' || ev.name === 'forget')) {
        showToast(String(ev.message || '').split('（')[0].slice(0, 60), ev.name === 'remember' ? 'success' : 'info')
      }
      const card = work.toolCards.get(ev.callId)
      if (card && card.classList.contains('ask-card')) { // 提问卡片：完成态由卡片自己管理，这里只兜底改状态
        if (!card.dataset.done) {
          setToolStatus(card, 'ok', String(ev.message || '').includes('用户已回答') ? '已回答' : '已取消')
          card.dataset.done = '1'
        }
        scrollChat()
        break
      }
      if (card && !card.classList.contains('delegate-card')) { // delegate 卡片由 delegate_done 事件更新
        const rejected = !ev.ok && String(ev.message || '').includes('拒绝')
        setToolStatus(card, ev.ok ? 'ok' : (rejected ? 'rejected' : 'fail'), ev.ok ? '完成' : (rejected ? '已拒绝' : '失败'))
        const res = card.querySelector('.tool-card-result')
        if (res) {
          linkifyFilePaths(res, String(ev.message || '').slice(0, 500))
          // 开发手感增强：edit_file 红绿 diff、run_command 终端风输出
          const cargs = (work.toolCallArgs && work.toolCallArgs.get(ev.callId)) || {}
          if (ev.name === 'edit_file' && cargs.old_string != null) res.appendChild(buildEditDiff(cargs.old_string, cargs.new_string))
          if (ev.name === 'run_command' || ev.name === 'dev_server') res.appendChild(buildCmdOut(String(ev.message || '')))
          res.classList.remove('hidden')
        }
      }
      scrollChat()
      break
    }
    case 'ai_credits': {
      // v0.4 内置模型扣费回执：淡灰小字挂在本条 AI 回复底部，平时隐藏、悬停显示
      const bal = typeof ev.balance === 'number' ? ev.balance : null
      if (ev.credits != null) mountCreditsTag(work.curAssistant, ev.credits, bal)
      if (bal !== null) updateBuiltinBalance(bal) // 面板开着的话顺手刷新余额
      break
    }
    case 'tool_parse_error': { // 限流/断流自动重试：带转圈的等待提示（单条复用不刷屏，不能关气泡——assistant_start 每轮只发一次，关了后续 delta 会丢）
      if (ev.error) showRetryWait(ev.error)
      break
    }
    case 'webchat_wait': // 网页模型排队/深度思考/钩子自愈：可见等待心跳（v2.4.82，防"卡死"体感）
      showRetryWait(`网页模型已等待 ${ev.seconds || 0} 秒（排队或深度思考中，继续等待…）`)
      break
    case 'compact_start': // 上下文压缩（默认关）：暂停模型活动期间的转圈提示（done/error 共用通道收尾）
      if (ev.message) showRetryWait(ev.message)
      break
    case 'compact_done': {
      hideRetryWait()
      if (ev.message) showToast(ev.message)
      break
    }
    case 'plan': { // 任务清单实时进度卡片（一张卡从头更新到尾）
      upsertPlanCard(work, ev)
      scrollChat()
      break
    }
    case 'steps_exhausted':
      finalizeAssistant()
      finalizeRound()
      appendStepsNotice(ev.max || 20)
      break
    case 'error':
      finalizeAssistant()
      hideRetryWait()
      appendChatError(ev.message)
      finalizeRound()
      break
    case 'chat_cleared':
      curChatEl().innerHTML = emptyChatHtml()
      hideRetryWait()
      work.roundSteps = []
      break
    case 'history_updated':
      restoreHistory(ev.sessionId || work.active)
      break
    case 'run_done':
      finalizeAssistant()
      finalizeRound()
      if ((ev.credits || 0) > 0) mountCreditsTag(null, ev.credits, ev.balance) // 兜底：流中 ai_credits 没挂上时补到最后一条回复
      hideWaitingSpin() // 任务收尾，撤掉等待行
      setChatRunning(false)
      playDoneSound() // 回复完成提示音（Windows 系统通知音，轻量）
      break
  }
}

// 回复完成提示音：Windows 自带通知音（无外部资源；文件缺失/播放失败静默不影响主流程）
let _doneAudio = null
function playDoneSound() {
  try {
    if (!_doneAudio) _doneAudio = new Audio('file:///C:/Windows/Media/Windows Notify System Generic.wav')
    _doneAudio.currentTime = 0
    _doneAudio.volume = 0.45
    _doneAudio.play().catch(() => {})
  } catch {}
}

// ===== 开发手感：edit_file 红绿 diff + run_command 终端风输出（老大要求对齐专业 code 工具体感）=====
function buildEditDiff(oldS, newS) {
  const box = document.createElement('div')
  box.className = 'dev-diff'
  const clip = (s, n) => String(s ?? '').split('\n').slice(0, n)
  const maxLines = 24
  const oldLines = clip(oldS, maxLines), newLines = clip(newS, maxLines)
  const row = (sign, text, cls) => {
    const d = document.createElement('div')
    d.className = 'dev-diff-line ' + cls
    d.textContent = sign + ' ' + text
    return d
  }
  oldLines.forEach((l) => box.appendChild(row('-', l, 'del')))
  newLines.forEach((l) => box.appendChild(row('+', l, 'add')))
  const more = []
  if (String(oldS ?? '').split('\n').length > maxLines) more.push(`原内容超 ${maxLines} 行已截断`)
  if (String(newS ?? '').split('\n').length > maxLines) more.push(`新内容超 ${maxLines} 行已截断`)
  if (more.length) {
    const note = document.createElement('div')
    note.className = 'dev-diff-more'
    note.textContent = '… ' + more.join('，')
    box.appendChild(note)
  }
  return box
}

// 报错行号定位：path:line:col 可点击 → 跳工作台对应文件对应行（诊断闭环的"最后一厘米"）
// 端口地址：localhost:xxxx / 127.0.0.1:xxxx 可点击 → AI 浏览器页签直接预览
// 字符类含中文（项目路径常有中文），排除 :;'`|*?<> 防吃进 URL/时间戳
const ERR_LOC_RE = /(?:[A-Za-z]:)?(?:[^\s:;'"`|*?<>]+[/\\])*[^\s:;'"`|*?<>]+\.(?:js|mjs|cjs|ts|tsx|jsx|java|py|json|css|scss|html|vue|log):(\d+)(?::(\d+))?/g
const DEV_URL_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s"'`]*)?/g
function wbGotoFileLine(locPath, line) {
  try {
    const norm = (s) => String(s).replace(/[\\/]+$/, '').toLowerCase()
    let it = state.wbItems.find((w) => norm(w.path) === norm(locPath))
    if (!it) it = state.wbItems.find((w) => norm(w.path).endsWith(norm(locPath))) // 相对路径后缀匹配
    if (!it) {
      addToWorkbench([{ path: locPath, name: String(locPath).split(/[\\/]/).pop(), isDir: false }], 'local', '本机')
      it = state.wbItems.find((w) => norm(w.path) === norm(locPath))
    }
    if (!it) { showToast('跳转失败：文件不在工作台', 'error'); return }
    if (work.mode !== 'work') { const mw = $('modeWork'); if (mw) mw.click() }
    const key = wbKey(it)
    if (wbActiveKey !== key) { wbActiveKey = key; renderWorkbench(); wbPersist() }
    openPreview(it)
    // 等编辑器挂完再跳行+挂报错红标（跳到哪红到哪，一眼锁死问题行）
    setTimeout(() => {
      const ed = wbEditors[key]
      if (ed && ed.cm) {
        ;(ed.errMarks || []).forEach((l) => {
          try { ed.cm.removeLineClass(l, 'background', 'wb-err-line'); ed.cm.removeLineClass(l, 'gutter', 'wb-err-gutter') } catch {}
        })
        ed.errMarks = []
        const ln = Math.max(0, (parseInt(line, 10) || 1) - 1)
        ed.cm.setCursor(ln, 0)
        ed.cm.scrollIntoView(null, 100)
        ed.cm.focus()
        try {
          ed.cm.addLineClass(ln, 'background', 'wb-err-line')
          ed.cm.addLineClass(ln, 'gutter', 'wb-err-gutter')
          ed.errMarks.push(ln)
        } catch {}
      }
    }, 500)
  } catch (e) { console.warn('err-loc 跳转失败', e) }
}

function buildCmdOut(message) {
  const wrap = document.createElement('div')
  wrap.className = 'dev-cmdout'
  const lines = message.split('\n')
  const first = lines[0] || ''
  const codeLine = document.createElement('div')
  codeLine.className = 'dev-cmdout-code' + (/执行成功/.test(first) ? ' ok' : ' bad')
  codeLine.textContent = first
  wrap.appendChild(codeLine)
  if (lines.length > 1) {
    const pre = document.createElement('pre')
    pre.className = 'dev-cmdout-pre'
    // 报错位置染可点击（跳工作台对应行）+ 本机端口染可点击（AI 浏览器直接预览），其余原样
    const pushPlain = (seg, html) => {
      let l2 = 0, u
      DEV_URL_RE.lastIndex = 0
      while ((u = DEV_URL_RE.exec(seg))) {
        html.out += escapeHtml(seg.slice(l2, u.index))
        let url = u[0]
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url.replace(/^0\.0\.0\.0|\[::1\]/, 'localhost')
        html.out += `<span class="dev-url" data-url="${escapeHtml(url)}">${escapeHtml(u[0])}</span>`
        l2 = u.index + u[0].length
      }
      html.out += escapeHtml(seg.slice(l2))
    }
    pre.innerHTML = lines.slice(1).join('\n').slice(0, 4000).split('\n').map((line) => {
      const html = { out: '' }
      let last = 0, m
      ERR_LOC_RE.lastIndex = 0
      while ((m = ERR_LOC_RE.exec(line))) {
        pushPlain(line.slice(last, m.index), html)
        html.out += `<span class="err-loc" data-loc="${escapeHtml(m[0])}">${escapeHtml(m[0])}</span>`
        last = m.index + m[0].length
      }
      pushPlain(line.slice(last), html)
      return html.out || '&nbsp;'
    }).join('\n')
    wrap.appendChild(pre)
    pre.addEventListener('click', (e) => {
      const loc = e.target.closest('.err-loc')
      if (loc) {
        const m = /^(.*):(\d+)(?::(\d+))?$/.exec(loc.dataset.loc || '')
        if (m) wbGotoFileLine(m[1], m[2])
        return
      }
      const url = e.target.closest('.dev-url')
      if (url && typeof addUrlTab === 'function') addUrlTab(url.dataset.url)
    })
  }
  return wrap
}

// 积分消耗标注挂载：container 传 curAssistant 或 null（null = 最后一条 AI 回复，run_done 兜底用）
function mountCreditsTag(container, credits, balance) {
  const div = container || (() => {
    const list = curChatEl()
    if (!list) return null
    const msgs = list.querySelectorAll('.chat-msg.assistant')
    return msgs.length ? msgs[msgs.length - 1] : null
  })()
  if (!div || !(credits > 0)) return
  let tag = div.querySelector(':scope > .msg-credits')
  if (!tag) {
    tag = document.createElement('div')
    tag.className = 'msg-credits'
    div.appendChild(tag)
  }
  const bal = typeof balance === 'number' ? ` · 余额 ${balance}` : ''
  tag.textContent = `本次消耗 ${credits} 积分${bal}`
}

// 等待转圈行：消息发出后/每轮工具执行间隙，提示"模型在干活"（assistant_start 时撤掉）
function showWaitingSpin() {
  if (!work.running) return // 任务已结束（错误/收尾）不显示，防止残留
  const list = curChatEl()
  if (!list || list.querySelector(':scope > .chat-waiting')) return
  const div = document.createElement('div')
  div.className = 'chat-waiting'
  div.innerHTML = '<span class="ai-spin"></span>MSMate 正在思考与执行…'
  list.appendChild(div)
  scrollChat()
}

function hideWaitingSpin() {
  const list = curChatEl()
  const w = list && list.querySelector(':scope > .chat-waiting')
  if (w) w.remove()
}

// 一轮任务结束：把中间过程（工具卡片 + 中间回复）折叠起来，只留最终总结展开
function finalizeRound() {
  const steps = work.roundSteps
  work.roundSteps = []
  const alive = steps.filter((el) => el && el.isConnected)
  if (alive.length <= 1) return // 没有过程（纯聊天），不折叠
  const last = alive[alive.length - 1] // 最终总结消息
  const mid = alive.slice(0, -1)
  if (!mid.length || !last.parentNode) return
  const opCount = mid.filter((el) => el.classList && el.classList.contains('tool-card')).length
  // 摘要条要让人一眼看出"步骤去哪了"：列出前几个工具摘要，不再是无存在感的灰色小字
  const summaries = mid
    .filter((el) => el.classList && el.classList.contains('tool-card'))
    .map((el) => {
      const spans = el.querySelectorAll('.tool-card-head span')
      return spans[1] ? spans[1].textContent.trim() : ''
    })
    .filter(Boolean)
  const preview = summaries.slice(0, 3).map((s) => (s.length > 18 ? s.slice(0, 18) + '…' : s)).join(' · ')
  const more = summaries.length > 3 ? ` 等 ${summaries.length} 步` : ''
  const fold = document.createElement('div')
  fold.className = 'chat-process collapsed'
  fold.innerHTML = `
    <div class="chat-process-header"><span class="chat-process-chevron">${iconSvg('chevron-down')}</span><span class="label">已执行 ${opCount} 步操作${preview ? '：' + escapeHtml(preview) : ''}${more}（点击展开）</span></div>
    <div class="chat-process-body"></div>`
  fold.querySelector('.chat-process-header').addEventListener('click', () => fold.classList.toggle('collapsed'))
  const body = fold.querySelector('.chat-process-body')
  for (const el of mid) body.appendChild(el) // appendChild 自动从原位置移走
  // 挂进最终回复内部、头像行正下方：与"已深度思考"同款折叠行；没有过程时本轮不产生折叠行
  const head = last.querySelector(':scope > .chat-assistant-head')
  if (head) head.after(fold)
  else last.parentNode.insertBefore(fold, last)
  scrollChat()
}

function finalizeAssistant() {
  // 流结束：把工具代码块从气泡文本中移除，去掉光标；路径转为可点击
  if (work.curAssistant) {
    const clean = stripToolBlocks(work.curContent)
    const contentEl = work.curAssistant.querySelector('.chat-content')
    if (clean) linkifyFilePaths(contentEl, clean)
    else contentEl.textContent = '（执行操作中…）'
    const thinking = work.curAssistant.querySelector('.chat-thinking')
    if (thinking && !thinking.classList.contains('hidden')) {
      thinking.classList.add('collapsed')
      thinking.classList.remove('thinking-active')
      thinking.querySelector('.label').textContent = '已深度思考（点击展开）'
    }
  }
  work.curAssistant = null
  work.curContent = ''
  work.curReasoning = ''
}

// Windows 绝对路径正则（不含 Windows 禁字符 \ / : * ? " < > |；路径可含空格）
const WIN_PATH_RE = /[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]+/g

// 把文本里的文件路径渲染为文件名片（点击用系统默认程序打开）；正文走 markdown 渲染（网页端观感）
function linkifyFilePaths(el, text) {
  el.textContent = ''
  text = String(text)
    .replace(/^\s+/, '').replace(/\s+$/, '')      // 去首尾空行，让思考块与正文贴紧
    .replace(/\n{3,}/g, '\n\n')                    // 压缩连续空行（聊天正文里 3+ 空行没有意义）
  const frag = renderMarkdownFrag(text)
  // 遍历渲染后的文本节点，把 Windows 路径替换为文件名片
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT)
  const targets = []
  let n
  while ((n = walker.nextNode())) {
    WIN_PATH_RE.lastIndex = 0
    if (WIN_PATH_RE.test(n.nodeValue)) targets.push(n)
  }
  for (const node of targets) {
    const tv = node.nodeValue
    const rep = document.createDocumentFragment()
    let last = 0
    let m
    WIN_PATH_RE.lastIndex = 0
    while ((m = WIN_PATH_RE.exec(tv))) {
      // 去掉尾部被一起匹配到的标点和 markdown 符号（` * ~ 等）
      const p = m[0].replace(/[.,;:!?)\]】」』"'，。；：！？）`*~|]+$/, '')
      const start = m.index
      const end = start + p.length
      if (end <= start) continue
      if (start > last) rep.appendChild(document.createTextNode(tv.slice(last, start)))
      rep.appendChild(buildFileCard(p))
      last = end
    }
    if (last < tv.length) rep.appendChild(document.createTextNode(tv.slice(last)))
    node.parentNode.replaceChild(rep, node)
  }
  el.appendChild(frag)
}

// ===== 聊天 markdown 渲染（DOM API 构建，内容全部走 textContent，天然防注入）=====
// 行内格式：`code`、**加粗**、*斜体*、[文本](http链接)
function appendInline(parent, str) {
  const codeParts = String(str).split(/(`[^`\n]+`)/g)
  for (const cp of codeParts) {
    if (!cp) continue
    if (cp.length > 2 && cp.startsWith('`') && cp.endsWith('`')) {
      const code = document.createElement('code')
      code.textContent = cp.slice(1, -1)
      parent.appendChild(code)
      continue
    }
    const boldParts = cp.split(/(\*\*[^*\n]+\*\*)/g)
    for (const bp of boldParts) {
      if (!bp) continue
      if (bp.length > 4 && bp.startsWith('**') && bp.endsWith('**')) {
        const b = document.createElement('strong')
        b.textContent = bp.slice(2, -2)
        parent.appendChild(b)
        continue
      }
      // 链接：[文本](http/https) 或 [文本](本地路径)（AI 生成图片/视频结果，点击用系统程序打开）
      let li = 0
      let m
      const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|[A-Za-z]:[\\/][^)\s]+)\)/g
      while ((m = LINK.exec(bp))) {
        if (m.index > li) emitItalic(parent, bp.slice(li, m.index))
        const a = document.createElement('a')
        const href = m[2]
        a.textContent = m[1]
        if (/^https?:\/\//.test(href)) {
          a.href = href
          a.target = '_blank'
          a.rel = 'noopener'
        } else {
          a.href = 'javascript:void(0)'
          a.addEventListener('click', (e) => { e.preventDefault(); _api.openFile(href).catch(() => {}) })
        }
        parent.appendChild(a)
        li = m.index + m[0].length
      }
      if (li < bp.length) emitItalic(parent, bp.slice(li))
    }
  }
}
function emitItalic(parent, str) {
  const parts = String(str).split(/(\*[^*\n]+\*)/g)
  for (const p of parts) {
    if (!p) continue
    if (p.length > 2 && p.startsWith('*') && p.endsWith('*')) {
      const em = document.createElement('em')
      em.textContent = p.slice(1, -1)
      parent.appendChild(em)
    } else {
      parent.appendChild(document.createTextNode(p))
    }
  }
}
// 块级结构：代码块/标题/无序有序列表/引用/表格/分隔线/段落（换行靠 .chat-content 的 pre-wrap）
function renderMarkdownFrag(text) {
  const frag = document.createDocumentFragment()
  const lines = String(text).split(/\r?\n/)
  let i = 0
  let para = []
  const flushPara = () => {
    if (!para.length) return
    const p = document.createElement('p')
    appendInline(p, para.join('\n'))
    frag.appendChild(p)
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (/^```/.test(t)) { // 代码块
      flushPara()
      const pre = document.createElement('pre')
      const code = document.createElement('code')
      const buf = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++ }
      i++ // 跳过收尾 ```
      code.textContent = buf.join('\n')
      pre.appendChild(code)
      frag.appendChild(pre)
      continue
    }
    if (!t) { flushPara(); i++; continue }
    // 独立图片行：![图注](本地路径或http) —— AI 生成图片/工作台插图在聊天里直接显示
    const imgM = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/)
    if (imgM) {
      flushPara()
      const wrap = document.createElement('div')
      wrap.className = 'md-img-wrap'
      const img = document.createElement('img')
      img.className = 'md-img'
      img.alt = imgM[1]
      img.src = /^https?:\/\//.test(imgM[2]) ? imgM[2] : fileToUrl(imgM[2])
      img.loading = 'lazy'
      img.addEventListener('click', () => {
        if (!/^https?:\/\//.test(imgM[2])) _api.openFile(imgM[2]).catch(() => {})
      })
      wrap.appendChild(img)
      if (imgM[1]) {
        const cap = document.createElement('div')
        cap.className = 'md-img-cap'
        cap.textContent = imgM[1]
        wrap.appendChild(cap)
      }
      frag.appendChild(wrap)
      i++
      continue
    }
    let m = t.match(/^(#{1,6})\s+(.+)$/)
    if (m) { // 标题
      flushPara()
      const h = document.createElement('h' + m[1].length)
      appendInline(h, m[2].replace(/\s*#+\s*$/, '')) // 去尾部 ###（AI 常见写法）
      frag.appendChild(h)
      i++
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); frag.appendChild(document.createElement('hr')); i++; continue }
    if (/^>\s?/.test(t)) { // 引用
      flushPara()
      const bq = document.createElement('blockquote')
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i++ }
      appendInline(bq, buf.join('\n'))
      frag.appendChild(bq)
      continue
    }
    if (t.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+$/.test(lines[i + 1].trim()) && lines[i + 1].includes('-')) { // 表格
      flushPara()
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const table = document.createElement('table')
      const thead = document.createElement('thead')
      const trh = document.createElement('tr')
      for (const c of parseRow(lines[i])) { const th = document.createElement('th'); appendInline(th, c); trh.appendChild(th) }
      thead.appendChild(trh)
      table.appendChild(thead)
      const tbody = document.createElement('tbody')
      i += 2
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const tr = document.createElement('tr')
        for (const c of parseRow(lines[i])) { const td = document.createElement('td'); appendInline(td, c); tr.appendChild(td) }
        tbody.appendChild(tr)
        i++
      }
      table.appendChild(tbody)
      frag.appendChild(table)
      continue
    }
    if (/^[-*]\s+/.test(t)) { // 无序列表
      flushPara()
      const ul = document.createElement('ul')
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement('li')
        appendInline(li, lines[i].trim().replace(/^[-*]\s+/, ''))
        ul.appendChild(li)
        i++
      }
      frag.appendChild(ul)
      continue
    }
    if (/^\d+[.、)]\s*\S/.test(t)) { // 有序列表（1. / 1、/ 1)）
      flushPara()
      const ol = document.createElement('ol')
      while (i < lines.length && /^\s*\d+[.、)]\s*\S/.test(lines[i])) {
        const li = document.createElement('li')
        appendInline(li, lines[i].trim().replace(/^\d+[.、)]\s*/, ''))
        ol.appendChild(li)
        i++
      }
      frag.appendChild(ol)
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return frag
}

// 文件名片：图标 + 文件名 + 所在目录，点击打开，侧边小按钮定位到文件夹
function buildFileCard(p) {
  const card = document.createElement('span')
  card.className = 'file-card'
  const norm = p.replace(/\//g, '\\')
  const name = norm.split('\\').pop() || norm
  const dir = norm.slice(0, norm.length - name.length - 1)
  const ext = (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '').toLowerCase()
  const iconMap = { docx: 'file-text', doc: 'file-text', xlsx: 'table', xls: 'table', csv: 'table', txt: 'file-text', pdf: 'file-text', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', zip: 'archive', rar: 'archive', mp3: 'music', mp4: 'video' }
  const icon = iconSvg(iconMap[ext] || 'file-text')
  card.innerHTML = `
    <span class="file-card-icon">${icon}</span>
    <span class="file-card-text">
      <span class="file-card-name">${escapeHtml(name)}</span>
      <span class="file-card-dir">${escapeHtml(dir || '（根目录）')}</span>
    </span>`
  card.title = `点击加入工作台预览：${norm}`
  card.addEventListener('click', async () => {
    try {
      // 本地文件卡片：点击进工作台打开（先确认文件还在，丢了的路径别塞进工作台）
      const exists = await _api.fsExists(norm)
      if (!exists) { showToast('文件不存在或已被移动', 'error'); return }
      addToWorkbench([{ path: norm, name }], 'local', '本机')
      if (!document.body.classList.contains('work-mode')) {
        const mw = document.getElementById('modeWork')
        if (mw) mw.click() // 非 Work 模式自动切过去，工作台立即可见
      }
    } catch (err) {
      showToast(`打开失败: ${err.message}`, 'error')
    }
  })
  const locate = document.createElement('span')
  locate.className = 'file-card-locate'
  locate.innerHTML = iconSvg('folder-open')
  locate.title = '在文件夹中显示'
  locate.addEventListener('click', async (e) => {
    e.stopPropagation()
    try {
      const r = await _api.openInExplorer(norm)
      if (r && r.error) showToast(`打开文件夹失败: ${r.error}`, 'error')
    } catch (err) {
      showToast(`打开文件夹失败: ${err.message}`, 'error')
    }
  })
  card.appendChild(locate)
  return card
}

// 任务清单卡片：同一张卡实时更新（📋 标题 + 进度条 + 逐项勾选）
function upsertPlanCard(work, ev) {
  const items = Array.isArray(ev.items) ? ev.items : []
  if (!items.length) return
  let card = work.planEl
  if (!card || !card.isConnected) {
    clearChatEmpty()
    card = document.createElement('div')
    card.className = 'chat-plan'
    work.roundSteps.push(card)
    curChatEl().appendChild(card)
    work.planEl = card
  }
  const done = ev.done || 0
  const total = ev.total || items.length
  card.textContent = ''
  const head = document.createElement('div')
  head.className = 'chat-plan-head'
  const title = document.createElement('span')
  title.innerHTML = `${iconSvg('list-checks')} 任务清单 ${done}/${total}`
  head.appendChild(title)
  const bar = document.createElement('div')
  bar.className = 'chat-plan-bar'
  const fill = document.createElement('div')
  fill.className = 'chat-plan-fill'
  fill.style.width = Math.round((done / total) * 100) + '%'
  bar.appendChild(fill)
  head.appendChild(bar)
  card.appendChild(head)
  const list = document.createElement('div')
  list.className = 'chat-plan-list'
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'chat-plan-item' + (it.status === 'done' ? ' done' : it.status === 'doing' ? ' doing' : '')
    const ic = document.createElement('span')
    ic.className = 'chat-plan-ic'
    ic.innerHTML = it.status === 'done' ? iconSvg('check') : it.status === 'doing' ? iconSvg('loader-circle') : iconSvg('circle')
    row.appendChild(ic)
    const tx = document.createElement('span')
    tx.textContent = it.text
    row.appendChild(tx)
    list.appendChild(row)
  }
  card.appendChild(list)
}

function buildToolCard(ev) {
  const card = document.createElement('div')
  card.className = 'tool-card'
  // 生图/编辑图分流：传了 image 就是改图 → 🖌️，纯生图 → 🎨（卡片名「AI 编辑图片」由 tools.js summarize 分流）
  const icon = ev.name === 'generate_image' && ev.args && ev.args.image ? iconSvg('paintbrush') : iconSvg(TOOL_ICONS[ev.name] || 'wrench')
  let detail = ''
  if (ev.args) {
    detail = Object.entries(ev.args)
      .filter(([k]) => k !== 'content')
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join('　')
    if (ev.args.content !== undefined) detail += `　content: ${String(ev.args.content).length} 字符`
  }
  card.innerHTML = `
    <div class="tool-card-head">
      <span class="tool-card-icon">${icon}</span>
      <span>${ev.delegateId ? '<span class="child-tag">↳ 子任务</span> ' : ''}${escapeHtml(ev.summary || ev.name)}</span>
      <span class="tool-card-status pending">待确认</span>
    </div>
    ${detail ? `<div class="tool-card-detail">${escapeHtml(detail)}</div>` : ''}
    ${ev.dangerNote && ev.destructive ? `<div class="tool-card-danger">${escapeHtml(ev.dangerNote)}</div>` : ''}
    <div class="tool-card-result hidden"></div>
    <div class="tool-card-actions"></div>`
  if (ev.approvalId) {
    const actions = card.querySelector('.tool-card-actions')
    const okBtn = document.createElement('button')
    okBtn.className = 'btn btn-accent btn-xs'
    okBtn.textContent = '批准'
    const noBtn = document.createElement('button')
    noBtn.className = 'btn btn-ghost btn-xs'
    noBtn.textContent = '拒绝'
    const disable = () => { okBtn.disabled = true; noBtn.disabled = true }
    okBtn.addEventListener('click', () => { disable(); _api.aiApprove(ev.approvalId, true, ev.sessionId) })
    noBtn.addEventListener('click', () => { disable(); _api.aiApprove(ev.approvalId, false, ev.sessionId) })
    actions.appendChild(okBtn)
    actions.appendChild(noBtn)
  } else {
    setToolStatus(card, ev.destructive ? 'pending' : 'running', ev.destructive ? '待执行' : '执行中')
  }
  return card
}

// AI 中途提问卡片：选项点选 + 其他输入 + 多题分页，答完 AI 自动继续
function buildAskCard(ev) {
  const card = document.createElement('div')
  card.className = 'tool-card ask-card'
  const questions = (ev.args && Array.isArray(ev.args.questions) && ev.args.questions.length)
    ? ev.args.questions
    : [{ question: (ev.args && ev.args.question) || '请补充一下你的需求' }]
  const state = questions.map(() => ({ picked: new Set(), other: '' }))
  let idx = 0
  let done = false

  card.innerHTML = `
    <div class="ask-head">
      <span class="ask-badge">AI 提问</span>
      ${questions.length > 1 ? `<span class="ask-count">共 ${questions.length} 题</span>` : ''}
      <span class="tool-card-status pending">待回答</span>
    </div>
    <div class="ask-body"></div>
    <div class="ask-actions"></div>`
  const body = card.querySelector('.ask-body')
  const actions = card.querySelector('.ask-actions')
  const statusEl = card.querySelector('.tool-card-status')

  const render = () => {
    const q = questions[idx] || {}
    const st = state[idx]
    const opts = Array.isArray(q.options) ? q.options : []
    body.innerHTML = `
      <div class="ask-qhead">
        <span class="ask-qtext">${escapeHtml(String(q.question || ''))}</span>
        ${questions.length > 1 ? `<span class="ask-pager"><button class="ask-pager-btn" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>‹</button><span class="ask-pager-num">${idx + 1} / ${questions.length}</span><button class="ask-pager-btn" data-dir="1" ${idx === questions.length - 1 ? 'disabled' : ''}>›</button></span>` : ''}
      </div>
      ${opts.map((o, oi) => {
        const label = String(o.label ?? oi)
        return `
        <div class="ask-option${st.picked.has(label) ? ' picked' : ''}" data-oi="${oi}">
          <span class="ask-option-mark">${q.multiSelect ? '☑' : '◉'}</span>
          <span class="ask-option-text">
            <span class="ask-option-label">${escapeHtml(label)}</span>
            ${o.description ? `<span class="ask-option-desc">${escapeHtml(String(o.description))}</span>` : ''}
          </span>
        </div>`
      }).join('')}
      <div class="ask-other">
        <span class="ask-other-label">其他</span>
        <input class="ask-other-input" type="text" maxlength="500" placeholder="${opts.length ? '补充说明（可留空）' : '请输入你的回答'}" value="${escapeHtml(st.other)}">
        <span class="ask-other-count">${st.other.length}/500</span>
      </div>`

    body.querySelectorAll('.ask-option').forEach((el) => {
      el.addEventListener('click', () => {
        const oi = Number(el.dataset.oi)
        const label = String((questions[idx].options[oi] || {}).label ?? oi)
        const st2 = state[idx]
        if (questions[idx].multiSelect) {
          if (st2.picked.has(label)) st2.picked.delete(label)
          else st2.picked.add(label)
        } else {
          st2.picked.clear()
          st2.picked.add(label)
        }
        render()
      })
    })
    const input = body.querySelector('.ask-other-input')
    input.addEventListener('input', () => {
      state[idx].other = input.value
      const cnt = body.querySelector('.ask-other-count')
      if (cnt) cnt.textContent = `${input.value.length}/500`
    })
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelAsk() })
    body.querySelectorAll('.ask-pager-btn').forEach((b) => {
      b.addEventListener('click', () => {
        idx = Math.min(Math.max(idx + Number(b.dataset.dir), 0), questions.length - 1)
        render()
      })
    })
    renderAskActions()
  }

  const renderAskActions = () => {
    const isLast = idx === questions.length - 1
    actions.innerHTML = ''
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'btn btn-ghost btn-sm'
    cancelBtn.textContent = '取消'
    cancelBtn.addEventListener('click', cancelAsk)
    const nextBtn = document.createElement('button')
    nextBtn.className = 'btn btn-accent btn-sm'
    nextBtn.textContent = isLast ? '提交回答' : '下一题'
    nextBtn.addEventListener('click', () => {
      if (!isLast) { idx++; render() } else submitAsk()
    })
    actions.appendChild(cancelBtn)
    actions.appendChild(nextBtn)
  }

  const finishAsk = (statusText, summaryHtml) => {
    done = true
    card.dataset.done = '1'
    statusEl.className = 'tool-card-status ok'
    statusEl.textContent = statusText
    actions.innerHTML = ''
    body.querySelectorAll('button, input').forEach((el) => { el.disabled = true })
    if (summaryHtml) {
      const sum = document.createElement('div')
      sum.className = 'ask-summary'
      sum.innerHTML = summaryHtml
      body.appendChild(sum)
    }
  }

  const cancelAsk = () => {
    if (done) return
    finishAsk('已取消', '<div class="ask-summary-line">未回答，AI 将按自己的判断继续</div>')
    _api.aiAskResult(ev.callId, { cancelled: true }, ev.sessionId)
  }

  const submitAsk = () => {
    if (done) return
    const answers = questions.map((q, i) => ({ selected: [...state[i].picked], other: state[i].other.trim() }))
    finishAsk('已回答', questions.map((q, i) => {
      const a = answers[i]
      const picked = [...a.selected]
      if (a.other) picked.push(`其他：${escapeHtml(a.other)}`)
      return `<div class="ask-summary-line">${escapeHtml(String((q && q.question) || '').slice(0, 40))} → ${picked.length ? picked.join('；') : '（未作选择）'}</div>`
    }).join(''))
    _api.aiAskResult(ev.callId, { answers }, ev.sessionId)
  }

  render()
  return card
}

// 子任务委派卡片：显示任务描述，完成后展示子Agent总结
function buildDelegateCard(ev) {
  const card = document.createElement('div')
  card.className = 'tool-card delegate-card'
  card.innerHTML = `
    <div class="tool-card-head">
      <span class="tool-card-icon">${iconSvg('puzzle')}</span>
      <span>委派子任务：${escapeHtml(ev.title || '')}</span>
      <span class="tool-card-status running">子Agent工作中</span>
    </div>
    <div class="tool-card-detail">${escapeHtml(ev.task || '')}</div>
    <div class="tool-card-result hidden"></div>
    <div class="tool-card-actions"></div>`
  return card
}

function setToolStatus(card, cls, text) {
  const s = card.querySelector('.tool-card-status')
  if (!s) return
  s.className = `tool-card-status ${cls}`
  s.textContent = text
  if (cls === 'ok' || cls === 'fail' || cls === 'rejected') {
    const actions = card.querySelector('.tool-card-actions')
    if (actions) actions.innerHTML = ''
  }
}

function setChatRunning(running) {
  work.running = running // 落到当前渲染上下文的会话
  updateSessionRunDot()
  // 发送按钮只反映"正在查看的会话"的运行状态
  const activeSt = sessState(work.active)
  const showRunning = work._ctx && work._ctx.sid === work.active ? running : !!(activeSt && activeSt.running)
  const btn = $('chatSend')
  if (!btn) return
  btn.classList.toggle('aborting', showRunning) // 箭头图标固定，运行中翻转向下+变红（CSS 控制）
  btn.title = showRunning ? '停止（点击中断当前任务）' : '发送（Enter）'
}
