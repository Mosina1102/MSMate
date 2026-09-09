// ============================================
// 网页版模型引擎（[网页]DeepSeek）：工作台内嵌真实网页 + 自动对话
// 原理：webview 常驻加载 chat.deepseek.com（partition 持久化登录态），
//       注入脚本自动填框/发送，MutationObserver 流式读取回复 DOM → 回传主进程。
// 纯浏览器行为，不用逆向接口，不怕签名改版。
// 注意：网页 DOM 结构可能随官方改版变化，注入脚本内做多级兜底。
// ============================================
(function () {
  'use strict'

  const APPS = {
    deepseek: {
      name: 'DeepSeek 网页版',
      home: 'https://chat.deepseek.com/',
      partition: 'persist:wbweb-deepseek',
      tag: '[网页]DeepSeek'
    }
  }

  // ===== 状态 =====
  const views = {}      // web -> { el(webview), layer, badge, login: 'pending'|'ok'|'no', loginTimer, pollTimer }
  let busyWeb = null    // 正在自动对话的 web（同一时间只跑一条，网页输入框就一个）
  const bus = { onNeedLogin: null, onStatus: null } // app.js 注入的回调

  // ===== DOM：常驻层（挂在 #wbView 内，absolute 铺满；切页签只显隐不销毁，保登录保会话） =====
  function ensureLayer(web) {
    const host = document.getElementById('wbView')
    if (!host) return null
    let layer = document.getElementById('wbWebLayer')
    if (!layer) {
      layer = document.createElement('div')
      layer.id = 'wbWebLayer'
      layer.className = 'wb-web-layer hidden'
      host.appendChild(layer)
    }
    return layer
  }

  function ensureView(web) {
    const app = APPS[web]
    if (!app) return null
    const layer = ensureLayer(web)
    if (!layer) return null
    let v = views[web]
    if (!v) {
      const el = document.createElement('webview')
      el.setAttribute('partition', app.partition)
      el.setAttribute('src', app.home)
      el.className = 'wb-web-view'
      // allowpopups 是布尔属性：存在即生效（写 "false" 也是开启！）。必须挂上，链接转跳才会走
      // 主进程 setWindowOpenHandler 拦截转工作台页签（main.js web-contents-created），不会弹真窗口
      el.setAttribute('allowpopups', 'true')
      // 关键：禁后台节流——webview 在后台页签时页面 setTimeout/interval 被降频，
      // 空闲判定（4s 定时）永远不来 → 回复完成也不上报 → 聊天区无限转圈
      el.setAttribute('webpreferences', 'backgroundThrottling=false')

      const badge = document.createElement('div')
      badge.className = 'wb-web-badge'

      layer.appendChild(el)
      layer.appendChild(badge)
      v = views[web] = { el, badge, login: 'pending', loginTimer: null, pollTimer: null }

      el.addEventListener('dom-ready', () => { console.log('[webchat-page] dom-ready 重装钩子'); armPageHook(el, web); refreshLogin(web) })
      el.addEventListener('did-navigate', (e) => { console.log(`[webchat-page] did-navigate ${e.url || ''}`); refreshLogin(web) })
      el.addEventListener('did-navigate-in-page', (e) => { console.log(`[webchat-page] did-navigate-in-page ${e.url || ''}`); refreshLogin(web) })
      el.addEventListener('did-fail-load', (e) => {
        if (e && e.errorCode === -3) return // 用户导航中断，可忽略
        setBadge(web, 'error', '网页加载失败')
      })
      // 未登录时轻量轮询：登录成功（跳转后 token 出现）自动翻转状态
      v.loginTimer = setInterval(() => {
        if (v.login !== 'ok') refreshLogin(web)
      }, 3000)
    }
    return v
  }

  function setBadge(web, kind, text) {
    const v = views[web]
    if (!v) return
    v.badge.className = 'wb-web-badge wb-web-badge-' + kind
    v.badge.textContent = text
    v.badge.classList.remove('hidden')
  }

  // ===== 登录检测：localStorage userToken + 页面出现输入框（登录页没有） =====
  async function refreshLogin(web) {
    const v = views[web]
    if (!v || !v.el) return
    let info = null
    try {
      info = await v.el.executeJavaScript(`(() => {
        try {
          const token = !!localStorage.getItem('userToken')
          const hasInput = !!document.querySelector('textarea#chat-input, textarea')
          return { token, hasInput, url: location.href }
        } catch (e) { return { token: false, hasInput: false, url: '' } }
      })()`)
    } catch { return }
    if (!info) return
    // 登录判定以 userToken 为准（调研结论：登录后写入 localStorage.userToken）。
    // token 不存在一律视为未登录——宁可信其无，避免往登录页里自动发消息。
    const prev = v.login
    v.login = info.token ? 'ok' : 'no'
    if (v.login === 'ok') {
      if (prev !== 'ok') setBadge(web, 'ok', '已登录 · 就绪')
      if (v.loginTimer) { clearInterval(v.loginTimer); v.loginTimer = null }
    } else {
      setBadge(web, 'warn', '未登录 · 请在下方网页登录自己的账号')
    }
    if (bus.onStatus) try { bus.onStatus(web, v.login) } catch {}
  }

  function statusOf(web) {
    const v = views[web]
    return v ? v.login : 'pending'
  }

  // ===== 页面注入：回复抓取钩子（每个页面导航后重装） =====
  // 页面侧维护事件队列，宿主 300ms 轮询取走（页面主世界没有 ipcRenderer，轮询最稳）
  function armPageHook(el, web) {
    const hook = `(() => {
      try {
        // 幂等放行必须验证「抓取函数真实存在」（真机"第二句话起整轮卡死"实锤根因）：
        // 旧逻辑只看 __mswbHook 标志，而标志是安装开头就置位——半路抛错（如 body 未就绪
        // 的 TypeError）会留下「标志在、take/probe 缺」的半残钩子，之后所有重装都被误判
        // 'armed' 挡回 → 页面活着也永久零抓取，自愈全失效。半残一律放行走全量重装
        if (window.__mswbHook && typeof window.__mswbTake === 'function' && typeof window.__mswbProbe === 'function') return 'armed'
        window.__mswbEvents = []
        window.__mswbState = 'idle'
        window.__mswbLast = ''
        window.__mswbIdle = null
        window.__mswbFingerprint = '' // 宿主 send 时写入本次 prompt 前 60 字：用于跳过 user 气泡回显
        const report = () => {
          const nodes = document.querySelectorAll('.ds-markdown')
          const el = nodes[nodes.length - 1]
          if (!el) return
          // 新回复判定用「节点锚点」而非「节点总数」：长会话（约 7 轮大块 tool_result 后）
          // DeepSeek 网页启用虚拟滚动——视口窗口固定，旧节点回收 + 新节点插入，节点总数不再
          // 单调增长 → 旧的"条数超过 reset 记录值"门槛永远拦住 → 整轮零抓取 → 150s
          // 超时报"没有返回"（真机"7 个行动后卡死/超时"实锤）。锚点 = reset 时刻最后节点引用，
          // 最后节点不是锚点即视为新回复，不受虚拟化节点总数波动影响
          if (el === window.__mswbAnchor) return
          try {
            // 锚点被回收后的防重建误抓：DeepSeek 对旧回复 re-render 会生成新节点（引用变了
            // 但内容没变）——若当前最后节点文本与锚点文本快照一致，视为仍是旧回复，不抓
            const anchor = window.__mswbAnchor
            if (anchor && !anchor.isConnected && (el.innerText || '') === window.__mswbAnchorText) return
          } catch (e) {}
          try {
            // user 回显跳过：发送的 tool_result/提示文本也渲染成 .ds-markdown 气泡，误抓会把
            // 自己的提示当回复（脏 chunk + 全文长度骤变 → 宿主变短脱钩 → 4.5s 兜底提前截断）。
            // ⚠️ 注意不能按 think 容器跳过"思考独白"：DeepSeek 深度思考模式下正文也在同一容器内
            // 被连坐跳过 → 整轮零抓取 → 25s 兜底误杀（真机卡死实锤），宁可容忍思考文本混入。
            const fp = window.__mswbFingerprint
            if (fp && (el.innerText || '').slice(0, fp.length) === fp) return
          } catch (e) {}
          // 关键：不能用 innerText 整把抓——DeepSeek 把三反引号代码块渲染成组件（语言标签行 +
          // 复制/下载按钮），innerText 读出来围栏丢失、按钮文本混入，必须按 DOM 块级重建围栏
          const text = extractMd(el)
          if (!text) return
          if (text.length > window.__mswbLast.length) {
            const delta = text.slice(window.__mswbLast.length)
            window.__mswbLast = text
            window.__mswbGotChunk = true
            window.__mswbEvents.push(['chunk', delta])
          } else if (text.length < window.__mswbLast.length) {
            // 流式渲染中途节点重建（公式/代码高亮 re-render）会短暂变短：锁定新长度，最终以 full 全量为准
            window.__mswbLast = text
          }
        }
        // DOM 块级重建 markdown：代码块（pre）→ 语言围栏；其余块 → innerText
        // 语言标签优先 code 的 language-xxx class；否则取组件 header（pre 之前的兄弟）剥掉按钮词后的纯单词
        // 注意：本函数整体在外层模板字符串里，禁止出现字面反引号——围栏字符用 \\u0060 转义
        const FENCE = '\u0060\u0060\u0060'
        const extractMd = (root) => {
          try {
            const kids = root.children || []
            if (!kids.length) return root.innerText || ''
            const parts = []
            for (const kid of kids) {
              const pre = kid.tagName === 'PRE' ? kid : (kid.querySelector ? kid.querySelector('pre') : null)
              if (pre) {
                const codeEl = pre.querySelector('code') || pre
                let lang = ''
                const mc = (codeEl.className || '').match(/language-([\\w#+.-]+)/)
                if (mc) lang = mc[1]
                if (!lang) {
                  let header = ''
                  for (const sib of (kid.children || [])) {
                    if (sib === pre || sib.contains(pre)) break
                    header += (sib.innerText || '') + ' '
                  }
                  const t = header.replace(/复制|下载|展开|收起|折叠|复制代码|下载代码/g, '').trim()
                  if (/^[\\w#+.-]{1,15}$/.test(t)) lang = t
                }
                const code = (codeEl.innerText || '').replace(/\\n+$/, '')
                if (code.trim()) parts.push('\\n' + FENCE + lang + '\\n' + code + '\\n' + FENCE + '\\n')
              } else {
                const t = kid.innerText || ''
                if (t.trim()) parts.push(t)
              }
            }
            if (!parts.length) return root.innerText || ''
            return parts.join('\\n\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
          } catch (e) { return root.innerText || '' }
        }
        const bump = () => {
          report()
          window.__mswbState = 'generating'
          if (window.__mswbIdle) clearTimeout(window.__mswbIdle)
          window.__mswbIdle = setTimeout(() => {
            report()
            window.__mswbState = 'idle'
          }, 4000)
        }
        const obs = new MutationObserver(bump)
        const arm = () => { try { obs.observe(document.body, { childList: true, subtree: true, characterData: true }) } catch (e) {} }
        arm()
        // SPA 导航后 body 可能重建
        new MutationObserver(() => { if (document.body && !document.body.__mswbArmed) { document.body.__mswbArmed = true; arm(); bump() } }).observe(document.documentElement, { childList: true, subtree: false })
        document.body.__mswbArmed = true
        // 兜底抢救直读：绕过事件管道直接抽取最后几个 .ds-markdown（跳过 user 回显气泡）。
        // 以「锚点」划界（锚点之前的最后几个节点才是新回复）——防止慢启动期把上一轮全文
        // 捞出来当本轮回复
        window.__mswbProbe = () => {
          try {
            const nodes = document.querySelectorAll('.ds-markdown')
            const fp = window.__mswbFingerprint
            for (let i = nodes.length - 1; i >= 0 && i >= nodes.length - 3; i--) {
              const el = nodes[i]
              // 碰到锚点（reset 时的旧回复）即止——后面全是旧消息（虚拟滚动下总数不再单调，
              // 不能再用 nodes.length <= count+1 门槛，会被整轮拦死零抓取）
              if (el === window.__mswbAnchor) break
              // 锚点被回收后的防重建误抓：内容与锚点快照一致的当旧回复跳过
              if (window.__mswbAnchor && !window.__mswbAnchor.isConnected && (el.innerText || '') === window.__mswbAnchorText) continue
              if (fp && (el.innerText || '').slice(0, fp.length) === fp) continue
              const text = extractMd(el)
              if (text && text.trim()) return text
            }
            return ''
          } catch (e) { return '' }
        }
        window.__mswbTake = () => {
          const evs = window.__mswbEvents.splice(0)
          const full = window.__mswbLast
          const st = window.__mswbState
          // url：当前网页对话地址（/a/chat/s/<uuid>）——宿主检测到变化后回传主进程持久化，
          // 重启后可导航回原对话（网页端"失忆"修复）、多本地会话切换时联动切对话
          return { events: evs, state: st, full, gotChunk: !!window.__mswbGotChunk, url: location.href }
        }
        window.__mswbReset = () => {
          window.__mswbEvents.splice(0)
          window.__mswbLast = ''
          window.__mswbGotChunk = false
          window.__mswbState = 'idle'
          // 记录「节点锚点」：reset 时刻最后一个 .ds-markdown = 上一轮旧回复。
          // 新回复判定 = 最后节点 !== 锚点（节点引用比较，不受虚拟滚动节点总数波动影响）。
          // 同步记录锚点文本快照：锚点被回收后防"旧回复 re-render 新节点"被误抓
          try {
            const nodes = document.querySelectorAll('.ds-markdown')
            window.__mswbAnchor = nodes.length ? nodes[nodes.length - 1] : null
            window.__mswbAnchorText = window.__mswbAnchor ? (window.__mswbAnchor.innerText || '') : ''
          } catch (e) { window.__mswbAnchor = null; window.__mswbAnchorText = '' }
        }
        // 安装标志必须全部函数就位后才置位：中途抛错不残留半残标志（下一次自愈重装能真正装上）
        window.__mswbHook = true
        return 'installed'
      } catch (e) { return 'error:' + e.message }
    })()`
    // 返回安装结果（armed/installed/error:.../exec-fail）：自愈重装时写日志定位半残场景
    return el.executeJavaScript(hook).then((r) => String(r || ''), () => 'exec-fail')
  }

  // 宿主轮询：取页面事件 → onDelta / 完成
  // 完成判定双保险：①页面侧 state=idle（依赖页面定时器，后台节流已禁）②宿主侧自有判定——
  // 收到过 chunk 且 4.5 秒无新 chunk/无全文增长 → 视为完成（不依赖页面侧定时器，最稳）
  function startPolling(web, handlers) {
    const v = views[web]
    if (!v) return
    stopPolling(web)
    let lastProgressAt = Date.now()
    let lastFullLen = 0
    let lastWaitAt = 0
    let lastConvUrl = ''
    let nohookStreak = 0 // v2.4.82：钩子丢失连续计数（自愈重装节流：每 10 跳 ≈3s 试一次）
    let lastHealHow = '' // 上次自愈重装结果（结果变化才补日志，防页面真死时刷屏）
    let rescuedAt = 0    // 上次直读抢救时刻（节流 ~1.5s 一拍）
    let lastProbe = ''   // 上一拍直读文本（连续两拍一致才交付，防把流式中途的半截回复当完整）
    let sentAt = arguments[2] || Date.now()
    v.pollTimer = setInterval(async () => {
      let out = null
      try { out = await v.el.executeJavaScript('(window.__mswbTake ? window.__mswbTake() : "nohook")') } catch { out = 'nohook' }
      if (!handlers) return
      if (out === 'nohook' || out == null) {
        // v2.4.82 真机实锤（"第二句话起整轮卡死"）：webview 重载/导航竞态会丢页面钩子，
        // 旧逻辑 out=null 每跳静默 return——零 chunk、零心跳、零抢救、零报错，干等 5 分钟硬超时，
        // 体感就是"卡死"。自愈三件套：幂等重装钩子（重设锚点防捞旧回复 + 恢复指纹防把回显当回复）
        // + 等待心跳可见 + 落到下方 30s 直读抢救
        nohookStreak++
        if (nohookStreak % 10 === 1) {
          const how = await armPageHook(v.el, web)
          if (nohookStreak === 1 || how !== lastHealHow) console.log(`[webchat-poll] nohook x${nohookStreak} 自愈重装=${how}`)
          lastHealHow = how
          try { await v.el.executeJavaScript('(window.__mswbReset ? (window.__mswbReset(), "ok") : "nohook")') } catch {}
          if (v.lastPrompt) {
            try { await v.el.executeJavaScript(`window.__mswbFingerprint = ${JSON.stringify(String(v.lastPrompt).slice(0, 60))}`) } catch {}
          }
        }
        if (handlers.onWait && Date.now() - lastWaitAt > 9000) {
          lastWaitAt = Date.now()
          try { handlers.onWait(Math.round((Date.now() - sentAt) / 1000)) } catch {}
        }
        return
      }
      nohookStreak = 0
      // 网页对话 URL 变化检测（DeepSeek 发送首条消息后 home → /a/chat/s/<uuid>）：变化才上报
      if (out.url && out.url !== lastConvUrl) {
        lastConvUrl = out.url
        if (handlers.onConvUrl && /chat\.deepseek\.com\/a\/chat\/s\//.test(String(out.url))) {
          try { handlers.onConvUrl(String(out.url)) } catch {}
        }
      }
      let gotEvents = (out.events || []).length > 0
      for (const [type, payload] of (out.events || [])) {
        if (type === 'chunk') { try { handlers.onDelta(payload) } catch {} }
      }
      const fullLen = (out.full || '').length
      // 变短也算进展（重同步）：长回显被跳过后全文长度骤降、正文从零重新增长，
      // 若只在增长时刷新 lastProgressAt，4.5s 兜底会在正文爬回旧峰值前提前触发截断
      if (gotEvents || fullLen !== lastFullLen) { lastProgressAt = Date.now(); lastFullLen = fullLen }
      // 等待心跳：10 秒无进展就上报一次已等待时长——DeepSeek 排队/深度思考时出口要几十秒，
      // 没有心跳的话本地聊天区只有一个空气泡，体感就是"卡死了"（真机反馈）
      if (handlers.onWait && Date.now() - lastProgressAt > 9000 && Date.now() - lastWaitAt > 9000) {
        lastWaitAt = Date.now()
        try { handlers.onWait(Math.round((Date.now() - sentAt) / 1000)) } catch {}
      }
      if (out.full && out.gotChunk && out.state === 'idle' && out.events && out.events.length === 0) {
        // ①②都算完成的依据：页面侧空闲 + 队列空
        stopPolling(web)
        try { handlers.onDone(out.full) } catch {}
        return
      }
      // ② 宿主侧兜底：正文出现过、之后 4.5 秒零进展且页面渲染已停（state=idle）→ 视为完成
      // （页面侧定时器失灵/节流兜底）。必须带 state=idle：流式/深度思考中途有几秒节奏空档是常态，
      // "页面还在变"时提前 finish 会截断后半段（真机教训）
      if (out.full && out.gotChunk && out.state === 'idle' && Date.now() - lastProgressAt > 4500) {
        stopPolling(web)
        try { handlers.onDone(out.full) } catch {}
        return
      }
      // ②' v2.4.82 早期直读抢救（放在 150s 兜底之前）：回复可能早已完整渲染（事件管道哑火 /
      //    思考完一次性吐出后钩子哑掉）——零 chunk 干等 150s 太久。发送 30s 起每 ~1.5s 直读
      //    一次，连续两拍文本一致才交付（流式增长中两拍必不同，不会截断半截回复）。思考期页面
      //    只有 CSS 动画（无 DOM 变化）probe 为空 → 不误杀；锚点 + 指纹双保险防捞旧回复/回显
      if (!out.gotChunk && Date.now() - sentAt > 30000 && Date.now() - rescuedAt > 1500) {
        rescuedAt = Date.now()
        let probeText = ''
        try { probeText = String((await v.el.executeJavaScript('(window.__mswbProbe ? window.__mswbProbe() : "")')) || '') } catch {}
        if (probeText && probeText.trim() && probeText === lastProbe) {
          console.log(`[webchat-poll] 30s直读抢救交付 len=${probeText.length} head=${JSON.stringify(probeText.slice(0, 40))}`)
          stopPolling(web)
          try { handlers.onDone(probeText) } catch {}
          return
        }
        lastProbe = probeText
      }
      // ③ 慢启动兜底：页面渲染已停（state=idle，4 秒无 DOM 变化）且发送 150 秒仍一个 chunk 都没抓到
      // → 兜底结束而非无限转圈。放宽到 150s 是关键：DeepSeek 排队/深度思考/AI 搜索的"准备期"可以
      // 连续几十秒甚至两分钟无 DOM 变化（转圈是 CSS 动画，不触发 MutationObserver），硬杀会把"还在
      // 准备"当成"改版抓不到"→ 杀掉后重发同一条 = 消息重复 + 等待翻倍（真机"卡很久"反馈）
      if (!out.gotChunk && out.state === 'idle' && Date.now() - sentAt > 150000) {
        stopPolling(web)
        // 智能抢救：报空前直接读一次 DOM——回复其实已流出（渲染停 + 有正文）→ 当作回复返回，
        // 兼自愈"事件管道死但 DOM 可读"的改版场景；真没内容才报空
        let rescued = ''
        try { rescued = String((await v.el.executeJavaScript('(window.__mswbProbe ? window.__mswbProbe() : "")')) || '') } catch {}
        console.log(`[webchat-poll] 150s兜底交付 len=${rescued.length}`)
        try { handlers.onDone(rescued) } catch {}
      }
    }, 300)
  }

  function stopPolling(web) {
    const v = views[web]
    if (v && v.pollTimer) { clearInterval(v.pollTimer); v.pollTimer = null }
  }

  // ===== 发送一条消息（自动填框 + 发送 + 流式读回复） =====
  // attachments: [{ name, content }] —— 作为文件附件上传（规则 .md / 工具结果），上传失败自动回退拼进消息文本
  // newSession: true —— 新任务开新会话（先导航回首页，甩掉旧会话上下文污染）
  // 等 DeepSeek 输入框就绪：冷启动/恢复导航后页面是完整冷加载（JS bundle + React hydrate），
  // 固定 1800ms 等不完——真机实锤重启后第一条消息文本全丢（React 未挂载时 native setter 写了
  // 个寂寞，发送只带附件）。轮询等 textarea 出现，最多 maxMs
  async function waitInputReady(web, maxMs) {
    const v = views[web]
    if (!v) return false
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      const ok = await v.el.executeJavaScript(`!!(document.querySelector('textarea#chat-input') || document.querySelector('textarea'))`).catch(() => false)
      if (ok) { await new Promise((r) => setTimeout(r, 800)); return true } // 再缓冲 800ms 让 React 挂上受控监听（400ms 真机不够：textarea 出现 ≠ hydrate 完成）
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  // resumeUrl: 持久化的网页对话 URL —— 非首轮时若当前页面不在该对话，自动导航回去
  //   （软件重启后恢复原对话；多个本地会话切换时联动切到各自的网页对话）
  // 返回通过 handlers 回调：onDelta(delta) / onDone(fullText) / onError(message) / onConvUrl(url)
  async function send(web, prompt, handlers, attachments, newSession, resumeUrl) {
    const app = APPS[web]
    const v = ensureView(web)
    if (!app || !v) { handlers.onError('网页版引擎不可用'); return }
    if (busyWeb) { handlers.onError('上一条网页对话还在回复中，请稍候'); return }

    // 未登录：报错 + 通知 app.js 激活工作台网页页签引导登录
    if (v.login !== 'ok') {
      // 冷启动/重启后 webview 还在加载，localStorage.userToken 读不到 → refreshLogin 误判"未登录"
      // （老大实锤：装新版重启后立刻说话，正文被这里拦死，只剩先行的规则附件发出去）。
      // 先等输入框就绪（只有登录后的页面才有输入框，登录页等到超时）再判定，误报归零
      await waitInputReady(web, 20000)
      await refreshLogin(web)
      if (v.login !== 'ok') {
        show(web)
        if (bus.onNeedLogin) try { bus.onNeedLogin(web) } catch {}
        handlers.onError(`${app.name}还未登录，已在工作台打开登录页，登录后重新发送即可`)
        return
      }
    }

    // 新任务开新会话：旧会话上下文会残留旧规则（如被旧版"禁止 tool 块"规则教坏），每个 MSMate 任务一个干净会话
    if (newSession) {
      try {
        await v.el.loadURL(app.home)
        await waitInputReady(web, 20000) // 冷加载智能等待，取代固定 1800ms（重启后首条消息丢文本根因）
        await refreshLogin(web)
      } catch {}
    } else if (resumeUrl && /chat\.deepseek\.com\/a\/chat\/s\//.test(String(resumeUrl))) {
      // 对话恢复/联动切换：当前页面不在目标对话就导航回去（重启后恢复原对话；多本地会话
      // 各自持有对话 URL，切换本地会话后第一轮自动切到对应的网页对话）。
      // 冷启动首次调用时 webview 可能还没 attach 完成抓不到 location —— 抓不到视为"不在目标对话"，宁可多导航一次
      try {
        let cur = ''
        try { cur = String(await v.el.executeJavaScript('location.href') || '') } catch {}
        if (cur !== resumeUrl) {
          await v.el.loadURL(resumeUrl)
          await waitInputReady(web, 20000) // 冷加载智能等待
          await refreshLogin(web)
        } else {
          await waitInputReady(web, 8000) // 已在目标对话也可能刚恢复，确认输入框就绪
        }
      } catch {}
    } else {
      await waitInputReady(web, 8000) // 无导航场景也确认输入框在（页面可能刚被用户手动刷新过）
    }

    busyWeb = web
    setBadge(web, 'busy', '对话中…')
    let idleGuard = null
    const finish = (fn, arg) => {
      if (idleGuard) clearTimeout(idleGuard)
      idleGuard = null
      stopPolling(web)
      busyWeb = null
      setBadge(web, 'ok', '已登录 · 就绪')
      // 轮次收尾留痕（done/error/超时都走这）：本轮日志整段静默是排障最大障碍，
      // 有这行就能看出"发送 OK → 等待 N 秒 → 交付/报错"的完整时间线
      console.log(`[webchat-turn] end ${fn === handlers.onDone ? `done len=${String(arg || '').length}` : `error ${String(arg || '').slice(0, 80)}`}`)
      try { fn(arg) } catch {}
    }
    // 空闲守护：5 分钟无任何增量 → 报错（主进程另有 5 分钟兜底）
    idleGuard = setTimeout(() => finish(handlers.onError, `${app.name}回复超时，请重试`), 5 * 60 * 1000)

    try {
      // 0) 钩子保险：页面可能刚导航完还没装（armPageHook 幂等）
      armPageHook(v.el, web)
      // 1) 清零页面计数器（防上一条回复长度残留）+ 写入本次 prompt 指纹（页面侧跳过 user 回显气泡）
      await v.el.executeJavaScript('(window.__mswbReset ? (window.__mswbReset(), "ok") : "nohook")')
      try {
        await v.el.executeJavaScript(`window.__mswbFingerprint = ${JSON.stringify(String(prompt).slice(0, 60))}`)
        v.lastPrompt = String(prompt) // v2.4.82：轮询期钩子自愈重装后要恢复指纹（防把 user 回显当模型回复）
      } catch {}
      const sentAt = Date.now()
      // 1.5) 附件上传（规则 .md 等）：DataTransfer 注入 file input（纯 JS，无需真文件选择器）
      let attachText = ''
      for (const att of (Array.isArray(attachments) ? attachments : [])) {
        const name = String(att.name || 'attachment.md')
        const content = String(att.content || '')
        if (!content.trim()) continue
        const up = await v.el.executeJavaScript(`(() => {
          try {
            const file = new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'text/markdown' })
            const inputs = [...document.querySelectorAll('input[type=file]')]
            for (const input of inputs) {
              try {
                const dt = new DataTransfer()
                dt.items.add(file)
                input.files = dt.files
                input.dispatchEvent(new Event('change', { bubbles: true }))
                return { ok: true }
              } catch (e) { continue }
            }
            return { ok: false, error: inputs.length ? 'inject-failed' : 'no-file-input' }
          } catch (e) { return { ok: false, error: e.message } }
        })()`)
        if (up && up.ok) {
          await new Promise((r) => setTimeout(r, 900)) // 等上传卡片出现
        } else {
          // 上传失败回退：内容拼进消息文本（保底规则必达）
          attachText += (attachText ? '\n\n' : '') + `【附件 ${name}】\n${content}`
        }
      }
      if (attachText) prompt = attachText + '\n\n----\n\n' + prompt
      // 2) 填输入框：native setter 绕 React 受控组件；回读验证——真机实锤含 <file_ref> 等
      //    HTML 式标签的文本会被网页前端吞掉（sanitize/受控重置），只发出去附件没有正文。
      //    回读不一致就把全文转附件（通道不受输入框影响），输入框只放引导语，信息必达
      let fill = await v.el.executeJavaScript(`(async () => {
        try {
          const text = ${JSON.stringify(String(prompt))}
          const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
          if (!ta) return { ok: false, error: '找不到输入框（网页可能改版）' }
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          setter.call(ta, text)
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          ta.focus()
          await new Promise((r) => setTimeout(r, 250)) // React 受控重置是 re-render 异步的：同步回读会假一致
          return { ok: true, echo: String(ta.value || '') }
        } catch (e) { return { ok: false, error: e.message } }
      })()`)
      if (!fill || !fill.ok) {
        // 输入框还没渲染好（冷加载慢）：再等一轮重试一次，仍失败才报错
        await waitInputReady(web, 8000)
        const retryFill = await v.el.executeJavaScript(`(async () => {
          try {
            const text = ${JSON.stringify(String(prompt))}
            const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
            if (!ta) return { ok: false, error: '找不到输入框（网页可能改版）' }
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(ta, text)
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            ta.focus()
            await new Promise((r) => setTimeout(r, 250))
            return { ok: true, echo: String(ta.value || '') }
          } catch (e) { return { ok: false, error: e.message } }
        })()`)
        if (!retryFill || !retryFill.ok) { finish(handlers.onError, (retryFill && retryFill.error) || '填充消息失败'); return }
        fill = retryFill
      }
      if (typeof fill.echo === 'string' && fill.echo.trim() !== String(prompt).trim()) {
        // 文本被网页吞了：全文就地注入附件《消息正文.md》（复用 file input 通道），输入框只放引导语
        const up2 = await v.el.executeJavaScript(`(() => {
          try {
            const file = new File([${JSON.stringify(String(prompt))}], '消息正文.md', { type: 'text/markdown' })
            const inputs = [...document.querySelectorAll('input[type=file]')]
            for (const input of inputs) {
              try {
                const dt = new DataTransfer()
                dt.items.add(file)
                input.files = dt.files
                input.dispatchEvent(new Event('change', { bubbles: true }))
                return { ok: true }
              } catch (e) { continue }
            }
            return { ok: false, error: 'no-file-input' }
          } catch (e) { return { ok: false, error: e.message } }
        })()`)
        if (up2 && up2.ok) await new Promise((r) => setTimeout(r, 900))
        await v.el.executeJavaScript(`(() => {
          try {
            const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
            if (!ta) return 'no-input'
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(ta, ${JSON.stringify('【消息传递】我的消息正文已作为附件《消息正文.md》上传，请先读取附件全部内容再回复。')})
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            return 'ok'
          } catch (e) { return 'err' }
        })()`)
      }
      // 3) 发送：点发送按钮 / Enter 后验证「真发出」→ 没发出自动重试。
      //    强判据 lesson（v2.4.62→63 远端实锤）：输入框被清空 ≠ 发送成功——切对话/附件上传后
      //    React 重渲染会把输入框清空/重建，被误判成"已发出"→ 跳过重试和兜底 → 只剩规则附件没正文。
      //    现在唯一判据 = 页面全文出现消息开头（用户气泡渲染出来），误判方向改为"宁可重发不多丢"
      const head = String(prompt).replace(/\s+/g, ' ').trim().slice(0, 20)
      const needVerify = !!head && !String(prompt).startsWith('【系统传递】') // 工具轮引导语无验证价值
      const clickSend = (useEnter) => v.el.executeJavaScript(`((useEnter, head, full) => {
        try {
          const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
          if (!ta) return { ok: false, error: '输入框消失了' }
          // 正文硬计数：head 在页面全文的出现次数（历史气泡 + 新消息气泡）。v2.4.68 起作为唯一成功判据——
          // 旧判据（hit 布尔 / 气泡数新增）被"重复消息 + 附件-only 消息触发回复"联手骗过（老大连续四轮实锤
          // "只剩规则附件没正文"）：重复消息历史里本来就有 head → hit 恒真；附件-only 发出后 DeepSeek 照样
          // 回复 → .ds-markdown 计数照样 +1 → 误判"正文已发"→ 不重试不兜底。改为计数：正文没真的
          // 渲染上屏，计数就不增加 → 必判失败 → 重试 → 转《消息正文.md》兜底，物理上保证必达
          // v2.4.80 关键修复：head 是空白折叠后的前 20 字符，页面 innerText 里是原始换行——
          // 引用文件的消息经「引用位置 + 换行引导语」转换后，前 20 字符必含换行 → split 永远 0 →
          // confirmSent 永远判失败 → 重复重发 4 次（模型收到重复消息陷入困惑停止生成）→ 误报通道失灵。
          // 两侧统一空白折叠后再计数（真机实锤：引用文件后网页端收不到回传消息的唯一根因）
          // ⚠ 本注释在模板字符串里：严禁书写反斜杠转义序列（v2.4.80 实锤：注释里的换行转义会
          //    被 cook 成真实换行，截断双斜线注释、后半截变成非法代码，整个页面脚本语法炸）
          const preCnt = document.body.innerText.replace(/\\s+/g, ' ').split(head).length - 1
          const cnt0 = document.querySelectorAll('.ds-markdown').length
          // 最后一眼自愈：重渲染可能把填好的文本清掉——发送前发现文本丢了当场重填，避免发出空气
          if (String(ta.value || '').replace(/\\s+/g, ' ').trim().indexOf(head) === -1) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(ta, full)
            ta.dispatchEvent(new Event('input', { bubbles: true }))
          }
          if (useEnter) {
            ta.focus()
            ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
            return { ok: true, via: 'enter', preCnt, cnt0 }
          }
          const box = ta.closest('div[class]') || document
          const btns = [...box.querySelectorAll('div[role="button"], button')].filter((b) => b.getAttribute('aria-disabled') !== 'true' && b.offsetParent !== null)
          if (btns.length) { btns[btns.length - 1].click(); return { ok: true, via: 'button', preCnt, cnt0 } }
          ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }))
          return { ok: true, via: 'enter-fallback', preCnt, cnt0 }
        } catch (e) { return { ok: false, error: e.message, preCnt: 0, cnt0: 0 } }
      })(${useEnter ? 'true' : 'false'}, ${JSON.stringify(head)}, ${JSON.stringify(String(prompt))})`).catch((e) => ({ ok: false, error: `页面脚本执行失败: ${e.message}`, preCnt: 0, cnt0: 0 }))
      const confirmSent = async (pre) => {
        pre = pre || { preCnt: 0, cnt0: 0 }
        const t0 = Date.now()
        let last = null
        while (Date.now() - t0 < 3000) {
          const st = await v.el.executeJavaScript(`(() => {
            try {
              const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
              const fullText = document.body.innerText
              return { empty: !ta || String(ta.value || '').trim() === '', cnt: document.querySelectorAll('.ds-markdown').length, cntNow: fullText.replace(/\\s+/g, ' ').split(${JSON.stringify(head)}).length - 1 }
            } catch (e) { return { empty: false, cnt: 0, cntNow: 0 } }
          })()`).catch(() => null)
          last = st
          // 唯一判据（v2.4.68）：正文在页面全文的计数比发送前多 → 新消息气泡真的渲染出来了。
          // 附件-only 消息（正文丢失）不增加正文计数 → 必判失败 → 重试/兜底
          if (st && st.cntNow > (pre.preCnt || 0)) return true
          await new Promise((r) => setTimeout(r, 320))
        }
        console.log(`[webchat-send2] confirm fail head=${JSON.stringify(head)} pre=${JSON.stringify(pre)} last=${JSON.stringify(last)}`)
        return false
      }
      const attachBodyAsFile = async (noteText) => {
        await v.el.executeJavaScript(`(() => {
          try {
            const file = new File([${JSON.stringify(String(prompt))}], '消息正文.md', { type: 'text/markdown' })
            const inputs = [...document.querySelectorAll('input[type=file]')]
            for (const input of inputs) {
              try {
                const dt = new DataTransfer()
                dt.items.add(file)
                input.files = dt.files
                input.dispatchEvent(new Event('change', { bubbles: true }))
                break
              } catch (e) { continue }
            }
            return 'ok'
          } catch (e) { return 'err' }
        })()`)
        await new Promise((r) => setTimeout(r, 900))
        await v.el.executeJavaScript(`(() => {
          try {
            const ta = document.querySelector('textarea#chat-input') || document.querySelector('textarea')
            if (!ta) return 'no-input'
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
            setter.call(ta, ${JSON.stringify(noteText)})
            ta.dispatchEvent(new Event('input', { bubbles: true }))
            return 'ok'
          } catch (e) { return 'err' }
        })()`)
      }
      // 第一轮无条件发送！工具轮引导语（【系统传递】）也要发出去——v2.4.62/63 实锤：
      // clickSend 被 gate 在 needVerify 里，工具轮跳过点发送 → 《工具结果.md》+引导语永远躺输入框不发出
      const r0 = await clickSend(false)
      console.log(`[webchat-send2] try#1 via=${r0 && r0.via} err=${r0 && r0.error || '-'} preCnt=${r0 && r0.preCnt} cnt0=${r0 && r0.cnt0}`)
      let sentOk = true
      if (needVerify) {
        sentOk = await confirmSent(r0)
        for (let i = 1; i < 3 && !sentOk; i++) {
          const r = await clickSend(i === 1) // 第 2 轮改走 Enter（按钮点错/点击被吞时，Enter 是网页原生通道）
          console.log(`[webchat-send2] try#${i + 1} via=${r && r.via} err=${r && r.error || '-'} preCnt=${r && r.preCnt} cnt0=${r && r.cnt0}`)
          sentOk = await confirmSent(r)
          if (!sentOk && i < 2) await new Promise((r2) => setTimeout(r2, 1200)) // 卡顿适配：给 React 喘息再战
        }
      }
      console.log(`[webchat-send2] sentOk=${sentOk} len=${String(prompt).length} head=${JSON.stringify(head)}`)
      if (!sentOk) {
        // 三轮都没验证到落地（原文可能没发出，或发出但页面文本对不上）：原文转附件《消息正文.md》+ 引导语重发，
        // 最后再验一次——仍失败直接报错，不再傻等 5 分钟超时。误判重复好过丢失（v2.4.58 原则）
        console.log('[webchat-send2] fallback: resend body as attachment')
        await attachBodyAsFile('【消息传递】我的消息没能自动发出（已重试多次），正文已作为附件《消息正文.md》上传，请先读取附件全部内容再回复。')
        const r2 = await clickSend(false)
        const ok2 = await confirmSent(r2)
        if (!ok2) { finish(handlers.onError, '网页端发送通道失灵（已重试 4 次），请在网页页签里手动点一次发送再重试'); return }
        try { handlers.onDelta('\n（消息未自动送达，已以附件《消息正文.md》重发）\n') } catch {}
      }
      // 4) 轮询读回复（sentAt 供"25 秒零 chunk"改版兜底计时）
      startPolling(web, {
        onDelta: (d) => {
          if (idleGuard) { clearTimeout(idleGuard); idleGuard = setTimeout(() => finish(handlers.onError, `${app.name}回复超时，请重试`), 5 * 60 * 1000) }
          try { handlers.onDelta(d) } catch {}
        },
        onConvUrl: (url) => { try { handlers.onConvUrl(url) } catch {} },
        onDone: (full) => finish(handlers.onDone, full),
        onError: (m) => finish(handlers.onError, m)
      }, sentAt)
    } catch (err) {
      finish(handlers.onError, `网页对话失败: ${err.message}`)
    }
  }

  // ===== 显隐控制（app.js renderWbView 调用；只显隐不销毁，保登录保会话） =====
  function show(web) {
    const v = ensureView(web)
    const layer = ensureLayer(web)
    if (!layer) return
    layer.classList.remove('hidden')
  }

  function hide() {
    const layer = document.getElementById('wbWebLayer')
    if (layer) layer.classList.add('hidden')
  }

  function destroy(web) {
    const v = views[web]
    if (!v) return
    if (v.loginTimer) clearInterval(v.loginTimer)
    stopPolling(web)
    try { v.el.remove() } catch {}
    delete views[web]
    if (busyWeb === web) busyWeb = null
    const layer = document.getElementById('wbWebLayer')
    if (layer) layer.remove()
  }

  window.WbWebChat = {
    APPS,
    send,
    show,
    hide,
    destroy,
    statusOf,
    refreshLogin,
    isBusy: () => !!busyWeb,
    // app.js 注入回调：onNeedLogin(web) 登录引导；onStatus(web, state) 状态变化
    setHandlers: (h) => Object.assign(bus, h || {})
  }
})()
