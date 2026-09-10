// ============================================
// Word 所见即所得编辑引擎（从 app.js 拆出，v2.7.12 模块化）
// 链路：mammoth HTML 起稿 → contenteditable 编辑 → DOM 转段落/runs → 高保真写回 docx
// 依赖 app.js 全局环境，加载顺序：app.js → word-embed.js → 本文件 → work.js
// ============================================
// ===== Word 所见即所得编辑（打开即编辑，像 WPS 一样直接改，Ctrl+S 高保真写回） =====
// 链路：mammoth HTML 起稿 → contenteditable 直接编辑 → DOM 转段落/runs → fs:word-rich-save
// （主进程先快照备份原文件，再用排版引擎重排生成 docx：run 级样式/列表/表格/图片全保留）
const WB_BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'DIV', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE', 'FIGURE', 'PRE', 'HEADER', 'FOOTER'])

// 行内收集：text/inline 标签 → runs（br 记为 {br:true}），run 级样式逐层继承
function wbInlineRuns(nodes, fmt, out) {
  for (const n of nodes) {
    if (n.nodeType === 3) {
      if (n.nodeValue) out.push({ text: n.nodeValue, ...fmt })
      continue
    }
    if (n.nodeType !== 1) continue
    const tag = n.tagName
    if (tag === 'BR') { out.push({ br: true }); continue }
    const nf = { ...fmt }
    if (tag === 'STRONG' || tag === 'B') nf.bold = true
    else if (tag === 'EM' || tag === 'I') nf.italic = true
    else if (tag === 'U') nf.underline = true
    else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') nf.strike = true
    else if (tag === 'MARK') nf.highlight = nf.highlight || 'yellow'
    else if (tag === 'CODE') { nf.font = 'Consolas'; nf.color = nf.color || 'C7254E'; nf.highlight = nf.highlight || 'lightGray' }
    else if (tag === 'A') { nf.color = wbHexColor(n) || nf.color || '0563C1'; nf.underline = true }
    else if (tag === 'SPAN' || tag === 'FONT') {
      const c = wbHexColor(n)
      if (c) nf.color = c
      // v2.4.94：docx-preview 的 run 样式全在 span inline style（font-weight/color/font-size/family/背景），逐项提为 run 字段
      const st = (n.getAttribute && n.getAttribute('style')) || ''
      if (!nf.bold && /\bfont-weight\s*:\s*(bold|[7-9]00)/.test(st)) nf.bold = true
      if (!nf.italic && /\bfont-style\s*:\s*italic/.test(st)) nf.italic = true
      if (!nf.underline && /\btext-decoration[^;]*underline/.test(st)) nf.underline = true
      if (!nf.strike && /\btext-decoration[^;]*line-through/.test(st)) nf.strike = true
      if (!nf.color) {
        const cm = /(?:^|;)\s*color\s*:\s*(rgb\([^)]*\)|#[0-9a-fA-F]{6})/.exec(st)
        if (cm) { const hex = wbCssColorToHex(cm[1]); if (hex) nf.color = hex }
      }
      if (nf.size == null) {
        const sm = /(?:^|;)\s*font-size\s*:\s*([\d.]+)\s*(pt|px)/.exec(st)
        // 统一存半点（docx 硬件单位）：pt×2；px 按 96dpi→pt 换算 ×0.75×2
        if (sm) nf.size = Math.round(parseFloat(sm[1]) * (sm[2] === 'px' ? 1.5 : 2))
      }
      if (nf.font == null) {
        const fm = /(?:^|;)\s*font-family\s*:\s*([^;]+)/.exec(st)
        if (fm) {
          const fam = fm[1].split(',')[0].replace(/["']/g, '').trim()
          if (fam && fam !== 'inherit') nf.font = fam
        }
      }
      if (nf.shade == null && !nf.highlight) {
        const bm = /(?:^|;)\s*background(?:-color)?\s*:\s*(rgb\([^)]*\)|#[0-9a-fA-F]{6})/.exec(st)
        if (bm) { const hex2 = wbCssColorToHex(bm[1]); if (hex2 && hex2 !== 'FFFFFF' && hex2 !== '000000') nf.shade = hex2 }
      }
    }
    wbInlineRuns([...n.childNodes], nf, out)
  }
}

function wbHexColor(node) {
  const st = node.getAttribute && node.getAttribute('style')
  if (!st) return null
  const m = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/.exec(st)
  if (!m) return null
  let hex = m[1].slice(1)
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return hex.toUpperCase()
}

// v2.4.94：rgb(r, g, b) / #hex → 6 位大写 HEX（docx-preview 输出的颜色都是 rgb() 形态）
function wbCssColorToHex(css) {
  const s = String(css || '').trim()
  const hm = /^#([0-9a-fA-F]{6})$/.exec(s)
  if (hm) return hm[1].toUpperCase()
  const rm = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s)
  if (rm) {
    const [r, g, b] = [Number(rm[1]), Number(rm[2]), Number(rm[3])]
    if (r > 255 || g > 255 || b > 255) return null
    return [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  }
  return null
}

// br 拆行 + 相邻同格式合并 + 首尾空白清理 → 每行一组 runs
function wbSplitRuns(runs) {
  const lines = [[]]
  for (const r of runs) {
    if (r.br) { lines.push([]); continue }
    const last = lines[lines.length - 1]
    const prev = last[last.length - 1]
    const same = prev && prev.bold === r.bold && prev.italic === r.italic && prev.underline === r.underline
      && prev.strike === r.strike && (prev.highlight || null) === (r.highlight || null)
      && (prev.color || null) === (r.color || null) && (prev.font || null) === (r.font || null)
      && (prev.size || null) === (r.size || null) && (prev.shade || null) === (r.shade || null)
    if (same) prev.text += r.text
    else {
      const nr = { text: r.text }
      for (const k of ['bold', 'italic', 'underline', 'strike', 'highlight', 'color', 'font', 'size', 'shade']) if (r[k] != null) nr[k] = r[k]
      last.push(nr)
    }
  }
  return lines
    .map((line) => {
      if (line.length) {
        line[0].text = line[0].text.replace(/^\s+/, '')
        const le = line[line.length - 1]
        le.text = le.text.replace(/\s+$/, '')
      }
      return line.filter((r) => r.text)
    })
    .filter((line) => line.length)
}

function emitWbBlock(node, style, align, paras) {
  let buf = []
  const flush = () => {
    for (const line of wbSplitRuns(buf)) {
      paras.push(align ? { text: '', runs: line, style, align } : { text: '', runs: line, style })
    }
    buf = []
  }
  for (const n of Array.from(node.childNodes)) {
    if (n.nodeType === 3) { if (n.nodeValue) buf.push({ text: n.nodeValue }); continue }
    if (n.nodeType !== 1) continue
    const tag = n.tagName
    if (tag === 'BR') { buf.push({ br: true }); continue }
    if (tag === 'IMG') {
      flush()
      const src = n.getAttribute('src') || ''
      // 图片走 markdown 字符串通道（normParagraphs 对象路径不收 image）；data: URI 由主进程落临时文件
      if (src) paras.push(`![${n.getAttribute('alt') || '图片'}](${src})`)
      continue
    }
    if (WB_BLOCK_TAGS.has(tag)) { flush(); emitWbStructured(n, style, align, paras); continue }
    wbInlineRuns([n], {}, buf)
  }
  flush()
}

function emitWbStructured(n, style, align, paras) {
  const tag = n.tagName
  if (tag === 'H1') return emitWbBlock(n, 'h1', align, paras)
  if (tag === 'H2') return emitWbBlock(n, 'h2', align, paras)
  if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') return emitWbBlock(n, 'h3', align, paras)
  if (tag === 'BLOCKQUOTE') return emitWbBlock(n, 'quote', align, paras)
  // v2.4.94：docx-preview 段落特征还原（class=标题族 / style 带 border-left=引用块 / 表格已在下方通用分支处理）
  if (tag === 'P' || tag === 'DIV') {
    const cls = (n.getAttribute && n.getAttribute('class')) || ''
    const hm = /docx_heading([1-6])/.exec(cls)
    if (hm) return emitWbBlock(n, Number(hm[1]) <= 1 ? 'h1' : Number(hm[1]) === 2 ? 'h2' : 'h3', align, paras)
    if (/\bdocx_title\b/.test(cls)) return emitWbBlock(n, 'h1', align, paras)
    if (!style || style === 'normal') {
      const pst = (n.getAttribute && n.getAttribute('style')) || ''
      if (/border-left\s*:/.test(pst)) return emitWbBlock(n, 'quote', align, paras)
    }
  }
  if (tag === 'UL' || tag === 'OL') {
    let i = 0
    for (const li of Array.from(n.children)) {
      if (li.tagName !== 'LI') continue
      i++
      const runs = []
      wbInlineRuns([...li.childNodes], {}, runs)
      for (const line of wbSplitRuns(runs)) {
        paras.push({ text: '', runs: [{ text: tag === 'OL' ? i + '. ' : '• ' }, ...line], style: 'normal' })
      }
    }
    return
  }
  if (tag === 'TABLE') {
    const rows = []
    for (const tr of n.querySelectorAll('tr')) {
      const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
        .map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim())
      if (cells.length) rows.push(cells)
    }
    // markdown 表格行字符串（normParagraphs 连续 | 行自动聚合）
    if (rows.length) paras.push(rows.map((cells) => `| ${cells.join(' | ')} |`).join('\n'))
    return
  }
  if (tag === 'PRE') {
    for (const ln of (n.textContent || '').split('\n')) {
      if (ln.trim()) paras.push({ text: '', runs: [{ text: ln, font: 'Consolas', highlight: 'lightGray' }], style: 'normal' })
    }
    return
  }
  if (tag === 'HR') return
  emitWbBlock(n, style, align, paras) // P/DIV/SECTION/FIGURE…
}

function htmlToWordParas(root) {
  const paras = []
  // v2.5.1 高保真模式：docx-preview 的 DOM 只收每页 article 里的正文——
  // 页眉/页脚/脚注/尾注渲染出来是为了对齐 WPS 观感，保存时不能混进正文
  const articles = root.querySelectorAll('.docx-wrapper section.docx > article')
  if (articles.length) {
    for (const a of articles) emitWbBlock(a, 'normal', null, paras)
    return paras
  }
  emitWbBlock(root, 'normal', null, paras)
  return paras
}

// 所见即所得编辑器主体：打开即编辑。入口自动择优：本机有 WPS/Word → 内嵌（真内核）；
// 否则内置编辑器。工具条=查找替换 + 格式按钮 + 外部编辑 + 保存；Ctrl+S 保存
async function mountWbDocxRich(item) {
  const key = wbKey(item)
  wbRenderedKey = key
  // 自动择优：探测 .docx 默认程序（UserChoice），有 WPS/Word 且未被单次豁免 → 走内嵌。
  // v2.4.57：preferOpen=内置优先（默认）时跳过 WPS/Word 内嵌直接用内置渲染器——真机反馈"设了内置
  // 优先还是优先 WPS"即此处的自动择优抢先走了 WPS 内嵌；想用 WPS 随时点工具条「在默认程序中编辑」
  let handler = null
  if (wbDocxForceBuiltin.has(item.path)) wbDocxForceBuiltin.delete(item.path) // 只豁免一次，重开回到择优
  else if (((await _api.getSetting('preferOpen').catch(() => null)) || 'builtin') === 'builtin') handler = null
  else handler = await _api.docxHandler().catch(() => null)
  if (handler && handler.exe && handler.kind) return mountWbDocxEmbed(item, key, handler)
  const body = $('wbViewBody')
  wbRenderedKey = key
  body.innerHTML = `<div class="wb-docx-wrap wb-view-content"><div class="empty-state"><div class="empty-icon">${iconSvg('file-pen')}</div><div>正在载入文档…</div></div></div>`
  // v2.4.94 高保真双模式：docx-preview 分页渲染（预览=编辑，和 WPS 看起来一个样），mammoth 起稿降级兜底
  const bufResp = await _api.docxBuffer(item.path).catch(() => null)
  let fallbackHtml = null
  if (!bufResp || !bufResp.base64) {
    const r0 = await _api.renderOffice(item.path).catch(() => null)
    if (!r0 || !r0.html) {
      const msg = (r0 && r0.error) || (bufResp && bufResp.error) || '渲染失败'
      body.innerHTML = `<div class="wb-view-content"><div class="pv-fallback"><div>${escapeHtml(msg)}</div><div class="wb-view-meta">无法进入编辑，点上方「系统打开」查看</div></div></div>`
      return
    }
    fallbackHtml = r0.html
  }
  if (wbRenderedKey !== key) return
  body.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'wb-docx-wrap wb-view-content'
  const bar = document.createElement('div')
  bar.className = 'wb-fs-bar wb-docx-bar'
  const ed = document.createElement('div')
  ed.className = 'wb-docx-rte'
  ed.contentEditable = 'true'
  ed.spellcheck = false
  const cmd = (name, val) => {
    ed.focus()
    document.execCommand('styleWithCSS', false, false)
    document.execCommand(name, false, val || null)
  }
  const fmtBtn = (label, title, fn) => {
    const b = document.createElement('button')
    b.className = 'btn btn-ghost btn-xs'
    b.innerHTML = label // label 可能是 iconSvg 串，textContent 会显示源码（2.7.1 补修）
    b.title = title
    b.addEventListener('mousedown', (e) => e.preventDefault()) // 保住选区
    b.addEventListener('click', fn)
    bar.appendChild(b)
    return b
  }
  const block = (tag) => cmd('formatBlock', `<${tag}>`)
  // 脏标记：改过未保存时保存键出圆点提醒
  const save = document.createElement('button')
  save.className = 'btn btn-primary btn-xs'
  save.textContent = '保存 (Ctrl+S)'
  save.title = '保存并重新生成 Word：原文档自动快照备份；文档按排版主题重排（run 级样式/列表/表格/图片保留）'
  save.addEventListener('mousedown', (e) => e.preventDefault())
  const markDirty = () => {
    if (!save.dataset.savedIcon) { save.dataset.savedIcon = '1'; save.innerHTML = iconSvg('save') + ' 保存 (Ctrl+S)' }
  }
  // 查找替换面板（编辑器内 DOM 替换，所见即所得的一部分）
  const replBtn = fmtBtn(iconSvg('search'), '查找替换（同一段落内匹配）', () => {})
  const replPanel = document.createElement('div')
  replPanel.className = 'wb-docx-repl hidden'
  replPanel.innerHTML = `
    <input class="wb-repl-find" placeholder="查找文字">
    <span class="wb-repl-arrow">→</span>
    <input class="wb-repl-rep" placeholder="替换为（留空=删除）">
    <button class="btn btn-primary btn-xs wb-repl-go">全部替换</button>
    <span class="wb-repl-msg"></span>`
  const replFind = replPanel.querySelector('.wb-repl-find')
  const replRep = replPanel.querySelector('.wb-repl-rep')
  const replMsg = replPanel.querySelector('.wb-repl-msg')
  replBtn.addEventListener('click', () => {
    replPanel.classList.toggle('hidden')
    if (!replPanel.classList.contains('hidden')) replFind.focus()
  })
  const replaceInEditor = () => {
    const find = replFind.value
    if (!find) { replMsg.textContent = '先填要查找的文字'; return }
    let count = 0
    // v2.5.1：高保真模式只在正文 article 里替换（页眉页脚不进保存链路，替换了也存不下来）
    const arts = ed.querySelectorAll('.docx-wrapper section.docx > article')
    const roots = arts.length ? [...arts] : [ed]
    for (const rootEl of roots) {
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)
      const nodes = []
      while (walker.nextNode()) nodes.push(walker.currentNode)
      for (const t of nodes) {
        if (!t.nodeValue.includes(find)) continue
        count += t.nodeValue.split(find).length - 1
        t.nodeValue = t.nodeValue.split(find).join(replRep.value)
      }
    }
    replMsg.textContent = count ? `已替换 ${count} 处（Ctrl+S 保存生效）` : '未找到（仅匹配同一段落内文字）'
    if (count) markDirty()
    ed.focus()
  }
  replPanel.querySelector('.wb-repl-go').addEventListener('click', replaceInEditor)
  for (const inp of [replFind, replRep]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceInEditor() } })
  }
  fmtBtn('¶', '正文', () => block('p'))
  fmtBtn('H1', '标题 1', () => block('h1'))
  fmtBtn('H2', '标题 2', () => block('h2'))
  fmtBtn('H3', '标题 3', () => block('h3'))
  fmtBtn('B', '加粗', () => cmd('bold'))
  fmtBtn('I', '斜体', () => cmd('italic'))
  fmtBtn('U', '下划线', () => cmd('underline'))
  fmtBtn('S', '删除线', () => cmd('strikeThrough'))
  fmtBtn(iconSvg('text-quote'), '引用块', () => block('blockquote'))
  fmtBtn('• 列表', '无序列表', () => cmd('insertUnorderedList'))
  fmtBtn('1. 列表', '有序列表', () => cmd('insertOrderedList'))
  fmtBtn(iconSvg('eraser'), '清除格式', () => cmd('removeFormat'))
  // 在默认程序中编辑：交给 WPS/Word（有装什么用什么内核，保真 100%），保存后自动刷新回来
  const extBtn = document.createElement('button')
  extBtn.className = 'btn btn-ghost btn-xs'
  extBtn.innerHTML = iconSvg('external-link') + ' 外部编辑'
  extBtn.title = '用系统默认程序（WPS/Office）打开编辑：那边保存后这里自动重新载入，保真度 100%'
  extBtn.addEventListener('click', async () => {
    if (save.dataset.savedIcon && !confirm('编辑器里有未保存的修改，去外部编辑会丢弃（文件内容不变）。继续？')) return
    const base = await _api.fileMtime(item.path).catch(() => null)
    await _api.openFile(item.path).catch(() => {})
    showToast('已用系统默认程序打开，在那边保存后这里会自动刷新', 'info')
    const w = await _api.waitFileChange(item.path, base && base.mtimeMs, 180000).catch(() => null)
    if (w && w.changed && wbRenderedKey === key) {
      showToast('检测到文件已在外部保存，正在重新载入…', 'success')
      mountWbDocxRich(item)
    }
  })
  bar.appendChild(extBtn)
  bar.appendChild(save)
  const saveRich = async () => {
    const paragraphs = htmlToWordParas(ed)
    if (!paragraphs.length) { showToast('文档内容为空，未保存', 'error'); return }
    save.disabled = true
    save.textContent = '保存中…'
    const res = await _api.saveWordRich(item.path, paragraphs).catch((err) => ({ error: (err && err.message) || '保存失败' }))
    save.disabled = false
    save.textContent = '保存 (Ctrl+S)'
    if (res && res.success) showToast('已保存：排版引擎重排生成，原文档已自动备份', 'success')
    else showToast(`保存失败: ${(res && res.error) || '未知错误'}`, 'error')
  }
  save.addEventListener('click', saveRich)
  ed.addEventListener('input', markDirty)
  ed.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      saveRich()
    }
  })
  // 内容注入：docx-preview 高保真渲染成功 → 直接编辑真分页 DOM；失败降级 mammoth 起稿
  // v2.5.3 关键修复：容器必须先挂进 DOM 再调 renderDocxPreview——否则 preload 里
  // document.getElementById(hostId) 找不到容器 → 永远返回"找不到渲染容器" → 每份 docx
  // 都静默回退 mammoth 纯文本（v2.4.94 起高保真模式从未真正生效过的隐形大坑）
  wrap.appendChild(bar)
  wrap.appendChild(replPanel)
  wrap.appendChild(ed)
  body.appendChild(wrap)
  let hiFi = false
  let hiFiError = '' // v2.5.4：高保真失败原因不再静默——真机排障全靠这个亮在界面上
  if (bufResp && bufResp.base64) {
    const hostId = 'wb-docx-host-' + Date.now().toString(36)
    ed.id = hostId
    const rr = await _api.renderDocxPreview(bufResp.base64, hostId).catch((e) => ({ ok: false, error: (e && e.message) || '调用失败' }))
    if (rr && rr.ok) {
      hiFi = true
      ed.classList.add('wb-docx-hifi') // v2.5.1：真分页纸面观感（灰底白纸 + 阴影，对齐 WPS 页面视图）
      const pg = document.createElement('span')
      pg.className = 'wb-view-meta'
      pg.style.marginLeft = 'auto'
      pg.textContent = `共 ${rr.pages || 1} 页 · 高保真分页视图`
      bar.appendChild(pg)
    } else {
      hiFiError = (rr && rr.error) || '未知错误'
      const r1 = await _api.renderOffice(item.path).catch(() => null)
      fallbackHtml = (r1 && r1.html) || null
    }
  } else if (!bufResp || !bufResp.base64) {
    hiFiError = (bufResp && bufResp.error) || '文档读取失败'
  }
  if (!hiFi) {
    if (!fallbackHtml) {
      body.innerHTML = `<div class="wb-view-content"><div class="pv-fallback"><div>渲染失败</div><div class="wb-view-meta">无法进入编辑，点上方「系统打开」查看</div></div></div>`
      return
    }
    ed.innerHTML = fallbackHtml
    if (hiFiError) {
      const warn = document.createElement('span')
      warn.className = 'wb-view-meta'
      warn.style.cssText = 'margin-left:auto;color:#c47f00;cursor:default'
      warn.title = hiFiError
      warn.textContent = `兼容模式 · 高保真渲染失败：${hiFiError}`
      bar.appendChild(warn)
    }
  }
  attachWbTextQuote(ed, item.name) // 编辑器里划词也能「添加到对话」
  ed.focus()
}

// 内嵌模式：把 WPS/Word 的文档窗口钉进预览区（真内核 100% 保真）。
// 失败回退链：内嵌失败 → 系统默认程序窗口外打开+保存自动刷新；「内置编辑」随时可切回
async function mountWbDocxEmbed(item, key, handler) {
  const body = $('wbViewBody')
  const appName = handler.kind === 'word' ? 'Word' : 'WPS'
  body.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'wb-docx-wrap wb-view-content'
  const bar = document.createElement('div')
  bar.className = 'wb-fs-bar wb-docx-bar'
  const status = document.createElement('span')
  status.className = 'wb-fs-cwd'
  status.style.flex = '1'
  status.textContent = `正在用 ${appName} 在工作台内打开…`
  bar.appendChild(status)
  const builtin = document.createElement('button')
  builtin.className = 'btn btn-ghost btn-xs'
  builtin.textContent = '内置编辑'
  builtin.title = '改用 MSMate 内置编辑器（mammoth 起稿 + 排版重排方案）'
  builtin.addEventListener('click', () => {
    wbDocxForceBuiltin.add(item.path)
    wbEmbedKill()
    mountWbDocxRich(item)
  })
  bar.appendChild(builtin)
  const host = document.createElement('div')
  host.className = 'wb-embed-host'
  host.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('monitor')}</div><div>正在启动 ${appName}…（首次约几秒）</div></div>`
  wrap.appendChild(bar)
  wrap.appendChild(host)
  body.appendChild(wrap)

  const rectPhys = () => {
    const r = host.getBoundingClientRect()
    const d = window.devicePixelRatio || 1
    return { x: Math.round(r.left * d), y: Math.round(r.top * d), w: Math.round(r.width * d), h: Math.round(r.height * d) }
  }
  const p0 = rectPhys()
  const r = await _api.docxEmbed({ exe: handler.exe, filePath: item.path, ...p0 }).catch(() => ({ ok: false, reason: 'ipc-error' }))
  if (wbRenderedKey !== key) { _api.docxEmbedClose().catch(() => {}); return } // 期间切走了：收掉再退
  if (!r || !r.ok) {
    // 回退①：内嵌不成（WPS 多标签整合模式抓不到独立窗口等）→ 窗口外打开 + 保存自动刷新
    wbDocxForceBuiltin.delete(item.path)
    const reason = String((r && r.reason) || '未知')
    let hint = ''
    if (reason.includes('no-window')) {
      const wins = (reason.split(';windows=')[1] || '').split(' || ').filter(Boolean)
      hint = wins.length
        ? `。检测到的 Office 窗口：${wins.join(' / ')}.  若 WPS 是多标签整合模式，请在 WPS 设置→打开方式→勾选「独立窗口模式」后重试`
        : '。未检测到任何 WPS/Word 窗口——若 WPS 是多标签整合模式，请在 WPS 设置→打开方式→勾选「独立窗口模式」后重试'
    }
    status.textContent = `内嵌不可用（${reason}），已改用 ${appName} 在外部窗口打开${hint}`
    host.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('monitor')}</div><div>在 ${appName} 里编辑保存后，这里会自动刷新</div><div class="wb-view-meta">也可点上方「内置编辑」用内置编辑器</div></div>`
    const base = await _api.fileMtime(item.path).catch(() => null)
    _api.openFile(item.path).catch(() => {})
    const w2 = await _api.waitFileChange(item.path, base && base.mtimeMs, 300000).catch(() => null)
    if (w2 && w2.changed && wbRenderedKey === key) { showToast('检测到外部保存，已重新载入', 'success'); mountWbDocxRich(item) }
    return
  }
  wbEmbed = { key, alive: true, pollTimer: null, ro: null }
  status.textContent = `${appName} 内嵌编辑中（真内核 100% 保真；切其它页签会暂时隐藏）`
  wbEmbed.ro = new ResizeObserver(() => {
    if (!wbEmbed.alive || wbEmbed.key !== key) return
    const p = rectPhys()
    _api.docxEmbedMove(p.x, p.y, p.w, p.h).catch(() => {})
  })
  wbEmbed.ro.observe(host)
  // 存活轮询：用户直接关掉 WPS 文档窗口 → 收尾提示
  wbEmbed.pollTimer = setInterval(async () => {
    if (!wbEmbed.alive || wbEmbed.key !== key) { clearInterval(wbEmbed.pollTimer); return }
    const a = await _api.docxEmbedAlive().catch(() => false)
    if (!a) {
      clearInterval(wbEmbed.pollTimer)
      wbEmbed.alive = false
      status.textContent = `${appName} 文档窗口已关闭`
      host.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('file-text')}</div><div>${appName} 文档窗口已关闭</div><div class="wb-view-meta">可点上方「内置编辑」，或重新双击文件打开</div></div>`
    }
  }, 3000)
}

async function openPreview(item, opts) {
  const key = wbKey(item)
  if (item.kind === 'webapp') { // 网页版页签由 WbWebChat 层接管（renderWbView 已显隐）；双保险清图片悬浮控件
    $('wbViewBody').querySelectorAll('.wb-img-nav,.wb-img-count,.wb-img-edit-btn').forEach(n => n.remove())
    return
  }
  wbRenderedKey = key
  $('wbViewIcon').innerHTML = itIcon(item) // itIcon 返回 SVG 串，textContent 会把源码显示成文本（2.7.1 修）
  $('wbViewName').textContent = item.name
  $('wbViewMeta').textContent = `${item.originName || '本机'} · ${item.isDir ? '文件夹' : (item.size ? formatSize(item.size) : '文件')}${item._missing ? ' · 文件不存在' : ''}`
  wbRefreshToolbar(item)
  const body = $('wbViewBody')

  // 文件夹：内嵌资源管理器网格（可进入子目录/预览文件）
  if (item.isDir) {
    renderWbFolder(item)
    return
  }

  // 远程文件：本机 file:// / fs 读不到，不渲染坏图坏文档
  if (item.origin !== 'local') {
    body.innerHTML = `<div class="wb-view-content"><div class="pv-fallback"><div>远程文件不直接预览</div><div class="wb-view-meta">点上方「发送」取回本机后再看</div></div></div>`
    return
  }

  const kind = getPreviewKind(item.name)
  if (!kind) {
    body.innerHTML = `<div class="wb-view-content"><div class="pv-fallback"><div>该类型不支持内置预览</div><div class="wb-view-meta">点上方「系统打开」用默认程序查看</div></div></div>`
    return
  }

  // Excel：内置网格编辑器（单元格改值写回，保留样式/公式）
  if (kind === 'xlsx') {
    mountWbGrid(item)
    return
  }

  if (kind === 'docx') {
    if (wbEmbed.alive && wbEmbed.key === key) { _api.docxEmbedShow().catch(() => {}); return } // 切回页签：直接亮出嵌入窗口
    mountWbDocxRich(item) // 打开即编辑（自动择优：有 WPS/Word → 内嵌；否则内置）
    return
  }

  const url = fileToUrl(item.path)
  if (kind === 'text') {
    const ed = wbEditors[key]
    if (ed) {
      // 已有编辑态（切页回来保留未保存内容）
      mountWbEditor(item)
      return
    }
    body.innerHTML = `<div class="wb-view-content"><div class="empty-state"><div class="empty-icon">${iconSvg('book-open')}</div><div>正在读取…</div></div></div>`
    const r = await _api.readTextFile(item.path).catch(() => null)
    if (wbRenderedKey !== key) return
    if (r && r.content !== undefined) {
      wbEditors[key] = { saved: r.content, content: r.content, dirty: false, timer: null, mtimeMs: r.mtimeMs }
      mountWbEditor(item)
    } else {
      const msg = (r && r.error) || '读取失败'
      body.innerHTML = `<div class="wb-view-content"><div class="pv-fallback"><div>${escapeHtml(msg)}</div><div class="wb-view-meta">文件过大或不支持，点上方「系统打开」查看</div></div></div>`
      if (r && r.tooBig) _api.openFile(item.path).catch(() => {})
    }
    return
  }
  if (kind === 'image') {
    const imgUrl = (opts && opts.bust) ? fileToUrl(item.path) + '?t=' + Date.now() : fileToUrl(item.path) // bust: AI 改图后刷新用，破 file:// 缓存
    body.innerHTML = `<div class="wb-zoom wb-view-content"><img class="pv-media" src="${imgUrl}"></div>`
    attachWbZoom(body.querySelector('img'))
    mountWbImgNav(item, body) // v2.4.73: 同目录图片左右翻页（箭头 + 键盘 ←/→）
    mountWbImgEdit(item, body) // v2.4.76: AI 图片编辑入口（画笔遮罩 + 指令 → 编辑模型）
    return
  }
  body.innerHTML = `<div class="wb-view-content" style="height:100%">${wbMediaHTML(kind, url)}</div>`
}

// 图片查看翻页（v2.4.73，老大要求"方便用户"）：同目录图片按名称排序，左右箭头/键盘 ←→ 切换，
// 原地替换当前页签的文件（页签标题/meta 同步变，不产生新页签）；滚轮保留缩放（attachWbZoom）不抢
// v2.4.74 修：item 是 state.wbItems 共享对象，翻页 go() 会原地改 item.path——闭包清理/守卫若直接
// 对比 item.path 永远相等（自己和自己比）→ 键盘监听永不清理 → 连按 N 个监听各翻一页、按钮成对累积
// （老大实锤"键盘翻页越翻越卡+按钮多渲染"）。修复：挂载时快照 myPath 做全闭包对比 + 翻页后本 nav
// 主动退役（retire 移除键盘监听）+ 挂载前清残留按钮
async function mountWbImgNav(item, body) {
  const myPath = item.path // 快照！后续全用 myPath 对比，绝不直接用 item.path（会被 go 原地改）
  try {
    const dir = String(myPath).replace(/[\\/][^\\/]+$/, '')
    body.querySelectorAll('.wb-img-nav,.wb-img-count').forEach(n => n.remove()) // 双保险：清可能残留的旧箭头
    const r = await _api.listLocalDirectory(dir)
    if (wbRenderedKey !== 'local|' + myPath) return // 已切到别的页签/别的文件，别挂导航（快照对比）
    if (!r || !r.success || !Array.isArray(r.entries)) return
    const imgs = r.entries
      .filter(e => !e.isDirectory && getPreviewKind(e.name) === 'image')
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true }))
    const idx = imgs.findIndex(e => e.path === myPath)
    if (idx < 0 || imgs.length < 2) return
    let retired = false
    const retire = () => { if (!retired) { retired = true; window.removeEventListener('keydown', onKey) } }
    const go = (d) => {
      const cur = getWbActive()
      if (!cur || cur.path !== myPath) { retire(); return } // 本 nav 已过时（页签切走/文件已变），退场
      const n = imgs[(idx + d + imgs.length) % imgs.length]
      retire() // 翻页后本 nav 退役：键盘监听移除（新 nav 由 openPreview 重挂，按钮随 innerHTML 重置）
      cur.path = n.path
      cur.name = n.name
      cur.size = n.size
      wbActiveKey = wbKey(cur) // 原地改 path 后 key 变了，必须同步激活 key，否则 renderWorkbench 会把激活项落到最后一项
      renderWorkbench()
      openPreview(cur)
      wbPersist() // 翻页后位置持久化，重启恢复到当前这张
    }
    const mk = (d, txt, cls) => {
      const b = document.createElement('button')
      b.className = 'wb-img-nav ' + cls
      b.innerHTML = txt
      b.title = d < 0 ? '上一张（←）' : '下一张（→）'
      b.addEventListener('click', () => go(d))
      body.appendChild(b)
    }
    mk(-1, '‹', 'wb-img-nav-prev')
    mk(1, '›', 'wb-img-nav-next')
    const tag = document.createElement('div')
    tag.className = 'wb-img-count'
    tag.textContent = `${idx + 1} / ${imgs.length}`
    body.appendChild(tag)
    const onKey = (e) => {
      const cur = getWbActive()
      if (!cur || cur.path !== myPath) { retire(); return } // 切走自动清理（快照对比，共享对象改 path 也不影响）
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    window.addEventListener('keydown', onKey)
  } catch {}
}

// === AI 图片编辑器（v2.4.76 初版；v2.4.77 四连改；v2.4.78 智能涂抹+提示词精修）===
// ①圆圈光标：鼠标变笔刷同大小圆圈，所见即所得；②遮罩紫色半透明；③橡皮擦与笔刷同大小一键切换；
// ④指令移到对话框：涂完点「发送到对话框」→ 合成纯黑遮罩版原图存 userData/iedit-tmp（保留=历史可追溯）
// → 以 [引用文件: …] 塞进聊天框 → 老大自己写指令发送 → AI 走 generate_image 编辑链路（v2.4.75）
// ⑤智能涂抹（v2.4.78）：一笔首尾闭合自动填充圈内（实心），非闭合只留线条；画笔走离屏层整笔盖章，来回涂不叠深
// 原理：Qwen-Image-Edit 不收 mask 参数，黑区+指令引导重绘是社区标准做法
function mountWbImgEdit(item, body) {
  const myPath = item.path
  const btn = document.createElement('button')
  btn.className = 'wb-img-edit-btn'
  btn.title = 'AI 编辑：涂选区域 → 发到对话框写指令改图'
  btn.innerHTML = iconSvg('square-pen') + ' AI 编辑'
  btn.addEventListener('click', () => {
    const cur = getWbActive()
    if (!cur || cur.path !== myPath) return
    openWbImageEditor(cur, body)
  })
  body.appendChild(btn)
}

function openWbImageEditor(item, body) {
  const myPath = item.path
  body.innerHTML = `
    <div class="wb-iedit">
      <div class="wb-iedit-bar">
        <button type="button" class="wb-iedit-back" title="返回图片查看">← 退出</button>
        <span class="wb-iedit-name" title="${escapeHtml(myPath)}">${escapeHtml(String(myPath).replace(/^.*[\\/]/, ''))}</span>
        <div class="wb-iedit-tools">
          <button type="button" class="wb-iedit-tool active" data-tool="brush" title="画笔（涂抹要修改的区域）">${iconSvg('paintbrush')} 画笔</button>
          <button type="button" class="wb-iedit-tool" data-tool="eraser" title="橡皮擦（擦除涂多的遮罩）">${iconSvg('eraser')} 橡皮</button>
        </div>
        <div class="wb-iedit-ratios" title="画幅：编辑模型不收比例参数，按比例先裁原图再编辑（所见即所得）">
          <button type="button" class="wb-iedit-ratio active" data-ratio="">原图</button>
          <button type="button" class="wb-iedit-ratio" data-ratio="1:1">1:1</button>
          <button type="button" class="wb-iedit-ratio" data-ratio="4:3">4:3</button>
          <button type="button" class="wb-iedit-ratio" data-ratio="3:4">3:4</button>
          <button type="button" class="wb-iedit-ratio" data-ratio="16:9">16:9</button>
          <button type="button" class="wb-iedit-ratio" data-ratio="9:16">9:16</button>
        </div>
        <label class="wb-iedit-brush">粗细 <input type="range" class="wb-iedit-size" min="8" max="120" value="36"></label>
        <button type="button" class="wb-iedit-clear" title="清空全部遮罩">清空</button>
        <button type="button" class="wb-iedit-undo" title="撤销上一笔">撤销</button>
        <label class="wb-iedit-origref" title="勾选后 AI 可看到涂抹区原貌，改色/微调更保真；删除/替换内容时建议不勾"><input type="checkbox" class="wb-iedit-origref-chk" checked> 参考原图</label>
        <button type="button" class="wb-iedit-send" title="合成遮罩图并发到对话框，由你写指令让 AI 改图">${iconSvg('check')} 发送到对话框</button>
      </div>
      <div class="wb-iedit-stage">
        <div class="wb-iedit-canvas-wrap"><img class="wb-iedit-img" alt="编辑中图片"><canvas class="wb-iedit-mask"></canvas><div class="wb-iedit-cursor"></div></div>
        <div class="wb-iedit-hint">正在读取图片…</div>
      </div>
    </div>`
  const wrap = body.querySelector('.wb-iedit-canvas-wrap')
  const img = body.querySelector('.wb-iedit-img')
  const mask = body.querySelector('.wb-iedit-mask')
  const cursorEl = body.querySelector('.wb-iedit-cursor')
  const goBtn = body.querySelector('.wb-iedit-send')
  const origrefChk = body.querySelector('.wb-iedit-origref-chk') // v2.4.87 参考原图开关（默认开）
  const hint = body.querySelector('.wb-iedit-hint')
  const setHint = (t, bad) => { hint.textContent = t; hint.className = 'wb-iedit-hint' + (bad ? ' wb-iedit-hint-bad' : '') }
  // 底图一律 dataURL 加载：file:// 图画进 canvas 后 toDataURL 会因跨域污染抛 SecurityError，data: 不污染
  const loadInto = (el, p) => _api.readFileBase64(p).then((r) => {
    if (!r || !r.ok) { setHint(r && r.message ? r.message : '图片读取失败', true); return false }
    el.src = `data:${r.mime};base64,${r.base64}`
    return true
  })
  const origImg = new Image() // 画幅裁切的像素源：始终从原图中心裁，反复切比例不叠加
  let origDataUrl = null
  loadInto(img, myPath).then((okr) => {
    if (!okr) return
    origDataUrl = img.src
    origImg.src = origDataUrl
    setHint('涂抹要改的区域（紫色半透明，一笔画个闭合的圈会自动填满内部），涂多了用橡皮擦，然后点「发送到对话框」写指令让 AI 改图')
  })

  // 尺寸对齐：canvas 跟随图片显示尺寸（遮罩坐标与显示坐标一致，合成时按比例映射回原图像素）
  const syncSize = () => {
    const r = img.getBoundingClientRect()
    if (!r.width || !r.height) return
    mask.width = Math.round(r.width)
    mask.height = Math.round(r.height)
  }
  img.addEventListener('load', syncSize) // 常驻：画幅裁切换底图后也要重对齐（v2.4.83）
  if (img.complete) syncSize()
  const ro = new ResizeObserver(syncSize)
  ro.observe(wrap)

  const mctx = mask.getContext('2d')
  mctx.lineCap = 'round'
  mctx.lineJoin = 'round'
  let tool = 'brush' // brush=画笔（画紫色遮罩）| eraser=橡皮（destination-out 擦遮罩）
  const brushPx = () => parseInt(body.querySelector('.wb-iedit-size').value) || 36
  const applyTool = () => {
    mctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    // 橡皮必须完全不透明：destination-out 按源 alpha 决定擦除量，0.55 透明色一次只擦 55%（老大实锤：一次擦不干净）
    mctx.strokeStyle = tool === 'eraser' ? '#000' : 'rgba(109,90,224,0.55)'
    mctx.fillStyle = tool === 'eraser' ? '#000' : 'rgba(109,90,224,0.55)'
    mctx.lineWidth = brushPx()
  }
  // 工具切换（画笔/橡皮一体：同笔刷大小，仅擦除行为不同）
  body.querySelectorAll('.wb-iedit-tool').forEach((b) => b.addEventListener('click', () => {
    tool = b.dataset.tool
    body.querySelectorAll('.wb-iedit-tool').forEach((x) => x.classList.toggle('active', x === b))
    cursorEl.classList.toggle('eraser', tool === 'eraser')
  }))
  // 圆圈光标：直径=笔刷大小，随鼠标移动（所见即所得），画布内隐藏系统光标
  // 注意：cursorEl 的定位基准是 wrap（position:relative），而 img/mask 是 flex 居中的 abs 元素
  // ——图片不铺满 wrap 时 mask 原点≠wrap 原点，必须按 wrap rect 算，否则圆圈偏离鼠标
  const moveCursor = (e) => {
    const r = wrap.getBoundingClientRect()
    const d = brushPx()
    cursorEl.style.width = d + 'px'
    cursorEl.style.height = d + 'px'
    cursorEl.style.left = (e.clientX - r.left - d / 2) + 'px'
    cursorEl.style.top = (e.clientY - r.top - d / 2) + 'px'
    cursorEl.style.display = 'block'
  }
  mask.addEventListener('pointerenter', moveCursor)
  mask.addEventListener('pointermove', moveCursor)
  mask.addEventListener('pointerleave', () => { cursorEl.style.display = 'none' })

  let drawing = false
  let last = null
  let curPts = null // 当前笔点集：一笔首尾闭合 → 自动填充圈内（实心），非闭合只留线条
  let curCv = null // 画笔笔迹离屏层（不透明紫）：拖动实时预览、松手终态都以 0.55 盖章，来回涂抹不叠深
  let committed = null // 本笔开始前的遮罩快照：拖动中实时重绘（底图+当前笔预览），所见即所得
  const strokes = [] // 撤销用：每笔存 ImageData
  const pos = (e) => {
    const r = mask.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const dot = (ctx, p) => {
    ctx.beginPath()
    ctx.arc(p.x, p.y, brushPx() / 2, 0, Math.PI * 2)
    ctx.fill()
  }
  // 拖动实时回显：清屏 → 本笔前快照打底 → 当前笔以 0.55 盖上（松手终态与预览完全一致）
  const repaint = () => {
    mctx.clearRect(0, 0, mask.width, mask.height)
    mctx.drawImage(committed, 0, 0)
    mctx.globalAlpha = 0.55
    mctx.drawImage(curCv, 0, 0)
    mctx.globalAlpha = 1
  }
  const onDown = (e) => {
    if (goBtn.disabled) return
    e.preventDefault()
    drawing = true
    last = pos(e)
    applyTool()
    try { strokes.push(mctx.getImageData(0, 0, mask.width, mask.height)) ; if (strokes.length > 30) strokes.shift() } catch {}
    if (tool === 'brush') {
      curPts = [last]
      curCv = document.createElement('canvas')
      curCv.width = mask.width
      curCv.height = mask.height
      const cctx = curCv.getContext('2d')
      cctx.lineCap = 'round'
      cctx.lineJoin = 'round'
      cctx.strokeStyle = '#6d5ae0'
      cctx.fillStyle = '#6d5ae0'
      cctx.lineWidth = brushPx()
      dot(cctx, last)
      committed = document.createElement('canvas')
      committed.width = mask.width
      committed.height = mask.height
      committed.getContext('2d').drawImage(mask, 0, 0)
      repaint()
    } else {
      dot(mctx, last) // 橡皮：destination-out 直接擦主遮罩（不透明色一次擦净）
    }
  }
  const onMove = (e) => {
    if (!drawing) return
    e.preventDefault()
    const p = pos(e)
    if (tool === 'brush') {
      const cctx = curCv.getContext('2d')
      cctx.beginPath()
      cctx.moveTo(last.x, last.y)
      cctx.lineTo(p.x, p.y)
      cctx.stroke()
      curPts.push(p)
      repaint() // 拖动中实时显示笔迹（老大实锤：松手才出现不行）
    } else {
      applyTool() // 橡皮：同步滑块粗细
      mctx.beginPath()
      mctx.moveTo(last.x, last.y)
      mctx.lineTo(p.x, p.y)
      mctx.stroke()
    }
    last = p
  }
  const onUp = () => {
    if (drawing && tool === 'brush' && curCv) {
      // 智能涂抹（老大 v2.4.78）：一笔首尾闭合 → closePath 填充圈内（实心圆）；非闭合笔只留线条
      if (curPts && curPts.length >= 3) {
        const f = curPts[0]
        const l = curPts[curPts.length - 1]
        if (Math.hypot(l.x - f.x, l.y - f.y) <= Math.max(32, brushPx())) {
          const cctx = curCv.getContext('2d')
          cctx.beginPath()
          cctx.moveTo(curPts[0].x, curPts[0].y)
          for (let i = 1; i < curPts.length; i++) cctx.lineTo(curPts[i].x, curPts[i].y)
          cctx.closePath()
          cctx.fill()
        }
      }
      repaint() // 终态=拖动预览（底图+整笔 0.55 盖章），无叠加加深
    }
    drawing = false
    last = null
    curPts = null
    curCv = null
    committed = null
  }
  mask.addEventListener('pointerdown', onDown)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  // 滚轮调笔刷粗细（编辑器内不缩放，翻页键盘监听已随 innerHTML 重置销毁）
  mask.addEventListener('wheel', (e) => {
    e.preventDefault()
    const s = body.querySelector('.wb-iedit-size')
    s.value = Math.max(8, Math.min(120, (parseInt(s.value) || 36) + (e.deltaY < 0 ? 6 : -6)))
  }, { passive: false })

  // === 画幅（v2.4.83 老大定调「加画幅按钮组」）：编辑模型不收比例参数（接口硬限制）===
  // 方案=先本地裁再编辑：从原图中心裁出目标画幅、缩放到标准输出尺寸（与生图 size 对齐），
  // 所见即所得；遮罩/笔迹清空重来；发送路径自动生效（合成基于当前 img 像素）
  const RATIO_OUT = { '1:1': [1024, 1024], '4:3': [1024, 768], '3:4': [768, 1024], '16:9': [1280, 720], '9:16': [720, 1280] }
  const resetMaskState = () => {
    strokes.length = 0
    drawing = false
    last = null
    curPts = null
    curCv = null
    committed = null
    mctx.clearRect(0, 0, mask.width, mask.height) // 显式清：mask.width 不变时 canvas 不会自动重置
  }
  const applyCrop = (ratio) => {
    if (!origDataUrl || !origImg.complete || !origImg.naturalWidth) return
    resetMaskState()
    if (!RATIO_OUT[ratio]) { img.src = origDataUrl; setHint('已还原原图画幅'); return }
    const [tw, th] = RATIO_OUT[ratio]
    const tr = tw / th
    const ow = origImg.naturalWidth
    const oh = origImg.naturalHeight
    let cw = ow
    let ch = ow / tr
    if (ch > oh) { ch = oh; cw = oh * tr } // 原图内取最大内接裁切框（中心对齐）
    const off = document.createElement('canvas')
    off.width = tw
    off.height = th
    off.getContext('2d').drawImage(origImg, (ow - cw) / 2, (oh - ch) / 2, cw, ch, 0, 0, tw, th)
    img.src = off.toDataURL('image/png')
    setHint(`已按 ${ratio} 裁剪为 ${tw}×${th}，重新涂抹要改的区域后发送`)
  }
  body.querySelectorAll('.wb-iedit-ratio').forEach((b) => b.addEventListener('click', () => {
    body.querySelectorAll('.wb-iedit-ratio').forEach((x) => x.classList.toggle('active', x === b))
    applyCrop(b.dataset.ratio)
  }))

  body.querySelector('.wb-iedit-clear').addEventListener('click', () => { strokes.length = 0; mctx.clearRect(0, 0, mask.width, mask.height) })
  body.querySelector('.wb-iedit-undo').addEventListener('click', () => {
    const s = strokes.pop()
    if (s) mctx.putImageData(s, 0, 0)
  })
  const back = () => { ro.disconnect(); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); openPreview(item, { bust: true }) }
  body.querySelector('.wb-iedit-back').addEventListener('click', back)

  goBtn.addEventListener('click', async () => {
    if (goBtn.disabled) return
    // 遮罩检测：读 alpha 通道。涂了=局部精修（纯黑遮罩图）；没涂=整图直传（老大 v2.4.79：不涂也放行）
    let hasMask = false
    try {
      const d = mctx.getImageData(0, 0, mask.width, mask.height).data
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) { hasMask = true; break }
    } catch {}
    setHint(hasMask ? '正在合成遮罩图并发送到对话框…' : '未涂抹：整图直传，发送后在对话框写指令让 AI 改图…')
    goBtn.disabled = true
    let origRefSavedPath = null // v2.4.87 参考原图：保存成功后的「原_」路径（塞胶囊用）
    try {
      // 合成：原图 + 遮罩区涂纯黑（按显示尺寸→原图像素映射），导出 dataURL（超 10MB 降 JPEG）
      // v2.4.87 参考原图（老大拍板，默认开）：涂黑前先导出无遮罩原貌版存「原_」（与「编辑_」同 base 时间戳配对，
      // tools.js 靠前缀精确识别分工）——AI 能看到涂抹区原内容，微调保形态；同一 canvas 顺序导出，画幅切换后天然是当前画幅
      const off = document.createElement('canvas')
      off.width = img.naturalWidth
      off.height = img.naturalHeight
      const octx = off.getContext('2d')
      octx.drawImage(img, 0, 0)
      let origRefUrl = null
      if (hasMask && origrefChk && origrefChk.checked) {
        origRefUrl = off.toDataURL('image/png')
        if (origRefUrl.length > 12.5 * 1024 * 1024) origRefUrl = off.toDataURL('image/jpeg', 0.92)
      }
      if (hasMask) {
        const sx = img.naturalWidth / mask.width
        const sy = img.naturalHeight / mask.height
        const md = mctx.getImageData(0, 0, mask.width, mask.height)
        octx.fillStyle = '#000'
        for (let y = 0; y < mask.height; y++) {
          for (let x = 0; x < mask.width; x++) {
            if (md.data[(y * mask.width + x) * 4 + 3] > 8) {
              octx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.ceil(sx), Math.ceil(sy))
            }
          }
        }
      }
      let dataUrl = off.toDataURL('image/png')
      if (dataUrl.length > 12.5 * 1024 * 1024) dataUrl = off.toDataURL('image/jpeg', 0.92)
      // 存 userData/iedit-tmp（保留不清理=历史可追溯）：涂了=「编辑_」前缀（AI 自动补黑区语义）；没涂=「整图_」前缀（纯指令改图）
      const ext = /^data:image\/jpeg/.test(dataUrl) ? 'jpg' : 'png'
      const prefix = hasMask ? '编辑_' : '整图_'
      const base = String(myPath).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
      const tmpPath = await _api.userDataPath().catch(() => '')
      if (!tmpPath) { setHint('无法定位用户数据目录', true); return }
      const ts = Date.now()
      const savePath = tmpPath.replace(/[\\/]+$/, '') + `\\iedit-tmp\\${prefix}${base}_${ts}.${ext}`
      const sr = await _api.saveDataUrlFile(dataUrl, savePath)
      if (!sr || !sr.ok) { setHint((sr && sr.message) || '保存合成图失败', true); return }
      // v2.4.87：参考原图勾选时存「原_同base同时间戳」（tools.js 前缀配对识别原貌参考），胶囊紧随编辑图
      if (origRefUrl && hasMask) {
        const oext = /^data:image\/jpeg/.test(origRefUrl) ? 'jpg' : 'png'
        const origPath = tmpPath.replace(/[\\/]+$/, '') + `\\iedit-tmp\\原_${base}_${ts}.${oext}`
        const osr = await _api.saveDataUrlFile(origRefUrl, origPath)
        if (osr && osr.ok) origRefSavedPath = origPath
      }
      // 引用胶囊塞进聊天框 + 切到聊天输入（老大自己写指令发送 → AI 走 generate_image 编辑链路）
      // v2.4.85：自动带上图片生成模式——编辑图直接是参考图，之后拖新图进来也是参考图，一起多图合成
      if (typeof work._appendChatRef === 'function') {
        work._appendChatRef(`[引用文件: ${savePath}]`)
        if (origRefSavedPath) work._appendChatRef(`[引用文件: ${origRefSavedPath}]`)
      }
      if (typeof work._setGenMode === 'function') work._setGenMode('image')
      back()
    } catch (err) {
      setHint('发送失败：' + (err && err.message ? err.message : err), true)
      goBtn.disabled = false
      goBtn.innerHTML = iconSvg('check') + ' 发送到对话框'
    }
  })
}

// === 文件夹内嵌浏览器：资源管理器大图标网格（本地可预览文件，远程可浏览目录） ===
// nav: { cwd, stack, sels:[], entries, filter } —— 整个 nav 持久化（位置记忆）
// opts.silent: 实时刷新复用（跳过"正在读取…"闪屏，旧内容保留到新列表就绪；重入守卫天然防旧盖新）
async function renderWbFolder(item, opts) {
  const key = wbKey(item)
  const nav = wbFolderNav[key] || (wbFolderNav[key] = { cwd: item.path, stack: [], sels: [], filter: '' })
  if (!Array.isArray(nav.sels)) nav.sels = []
  const body = $('wbViewBody')
  // 远程文件夹需要设备在线
  if (item.origin !== 'local' && item.origin !== state.connectedDeviceId) {
    body.innerHTML = `<div class="wb-fs-bar"><span class="wb-fs-cwd">${escapeHtml(nav.cwd)}</span></div><div class="wb-view-content"><div class="pv-fallback"><div>「${escapeHtml(item.originName || '远程设备')}」未连接</div><div class="wb-view-meta">连接该设备后即可浏览</div></div></div>`
    return
  }
  if (item.origin === 'local') _api.watchDir(nav.cwd).catch(() => {}) // 实时刷新：AI 在本目录（含子目录）增删改 → dir-changed → 重拉

  const cwd = nav.cwd
  if (!(opts && opts.silent)) body.innerHTML = `<div class="wb-fs-bar"><span class="wb-fs-cwd">${escapeHtml(cwd)}</span></div><div class="wb-view-content"><div class="empty-state"><div class="empty-icon">${iconSvg('folder-open')}</div><div>正在读取…</div></div></div>`
  let r = null
  try {
    r = item.origin === 'local'
      ? await _api.listLocalDirectory(cwd)
      : await _api.listRemoteDirectory(item.origin, cwd)
  } catch {}
  if (wbRenderedKey !== key || wbFolderNav[key] !== nav || nav.cwd !== cwd) return

  if (!r || !r.success || !Array.isArray(r.entries)) {
    const msg = (r && r.error) || '无法访问该目录'
    body.innerHTML = `<div class="wb-fs-bar"><span class="wb-fs-cwd">${escapeHtml(cwd)}</span></div><div class="wb-view-content"><div class="pv-fallback"><div>读取失败</div><div class="wb-view-meta">${escapeHtml(msg)}</div></div></div>`
    return
  }

  const entries = r.entries.slice()
    .sort((a, b) => (b.isDirectory - a.isDirectory) || String(a.name).localeCompare(String(b.name), 'zh-CN'))
  nav.entries = entries.map(e => ({ name: e.name, path: e.path, isDirectory: !!e.isDirectory }))
  nav.sels = nav.sels.filter(p => entries.some(e => e.path === p))

  body.innerHTML = ''
  const bar = document.createElement('div')
  bar.className = 'wb-fs-bar'
  const upBtn = document.createElement('button')
  upBtn.className = 'btn btn-ghost btn-xs'
  upBtn.textContent = '上级'
  upBtn.disabled = nav.stack.length === 0
  upBtn.title = '返回上一级'
  upBtn.addEventListener('click', () => {
    const nav2 = wbFolderNav[key]
    if (!nav2 || !nav2.stack.length) return
    nav2.cwd = nav2.stack.pop()
    nav2.sels = []
    renderWbFolder(item)
    wbPersist()
  })
  const cwdSpan = document.createElement('span')
  cwdSpan.className = 'wb-fs-cwd'
  cwdSpan.textContent = cwd
  cwdSpan.title = cwd
  const filter = document.createElement('input')
  filter.className = 'wb-fs-filter'
  filter.placeholder = '筛选当前目录…'
  filter.value = nav.filter || ''
  bar.appendChild(upBtn)
  bar.appendChild(cwdSpan)
  bar.appendChild(filter)

  const grid = document.createElement('div')
  grid.className = 'wb-fs-grid wb-view-content'
  // 批量操作条（选中 >=1 项出现）
  const bulk = document.createElement('div')
  bulk.className = 'wb-fs-bulkbar hidden'

  const updateBulk = () => {
    const n = nav.sels.length
    if (!n) { bulk.classList.add('hidden'); return }
    bulk.classList.remove('hidden')
    bulk.innerHTML = ''
    const count = document.createElement('span')
    count.className = 'bulk-count'
    count.textContent = `已选 ${n} 项`
    bulk.appendChild(count)
    const mkBtn = (label, title, fn) => {
      const b = document.createElement('button')
      b.className = 'btn btn-ghost btn-xs'
      b.innerHTML = label // label 含 iconSvg 串，textContent 会显示源码（2.7.1 补修）
      b.title = title
      b.addEventListener('click', fn)
      bulk.appendChild(b)
    }
    const selEntries = entries.filter(e => nav.sels.includes(e.path))
    mkBtn(iconSvg('folder-input') + ' 加入工作台', '把选中项收进工作台标签', () => {
      addToWorkbench(selEntries.map(e => ({ path: e.path, name: e.name, isDir: e.isDirectory })), item.origin, item.originName || '本机')
      nav.sels = []
      buildGrid()
      updateBulk()
    })
    mkBtn(iconSvg('message-square') + ' 引用 AI', '引用给 AI 当上下文', () => {
      if (typeof work._appendChatRef !== 'function') { showToast('请先切换到 Work 聊天使用引用', 'error'); return }
      for (const e of selEntries) {
        work._appendChatRef(item.origin === 'local' ? `[引用文件: ${e.path}]` : `[引用远程文件: ${item.originName || '远程设备'}|${item.origin}|${e.path}]`)
      }
      showToast(`已引用 ${selEntries.length} 项到聊天`, 'success')
    })
    mkBtn(iconSvg('send') + ' 发送', item.origin === 'local' ? '发送选中文件到对方（文件夹逐个传）' : '把选中项下载回本机', async () => {
      if (!state.connectedDeviceId) { showToast('请先连接设备', 'error'); return }
      if (item.origin === 'local') {
        if (!state.remotePath || state.remotePath === 'root') { showToast('请先在远程面板进入目标目录', 'error'); return }
        for (const e of selEntries) await uploadFile(e.path, e.isDirectory)
      } else {
        for (const e of selEntries) await downloadFile(e.path, e.isDirectory)
      }
    })
    const clearBtn = document.createElement('button')
    clearBtn.className = 'btn btn-ghost btn-xs'
    clearBtn.textContent = '取消选择'
    clearBtn.addEventListener('click', () => { nav.sels = []; buildGrid(); updateBulk() })
    bulk.appendChild(clearBtn)
  }

  const buildGrid = () => {
    const kw = (nav.filter || '').trim().toLowerCase()
    const list = kw ? entries.filter(e => String(e.name).toLowerCase().includes(kw)) : entries
    grid.innerHTML = ''
    if (!list.length) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">${entries.length ? iconSvg('search') : iconSvg('inbox')}</div><div>${entries.length ? '没有匹配的项目' : '空文件夹'}</div></div>`
      return
    }
    list.forEach((e) => {
      const idx = entries.indexOf(e)
      const cell = document.createElement('div')
      cell.className = 'wb-fs-item' + (nav.sels.includes(e.path) ? ' sel' : '')
      cell.title = e.name
      const icon = document.createElement('span')
      icon.className = 'wb-fs-icon'
      // 本地图片直接出缩略图，方便一眼扫图
      const isLocalImg = !e.isDirectory && item.origin === 'local' && getPreviewKind(e.name) === 'image'
      if (e.isDirectory) {
        icon.innerHTML = iconSvg('folder')
      } else if (isLocalImg) {
        const img = document.createElement('img')
        img.className = 'wb-fs-thumb'
        // ?m=修改时间：文件写完 mtime 变 → URL 变 → 强制重载。防止半截下载图被 file:// 缓存住一直显示一半（v2.4.66）
        img.src = fileToUrl(e.path) + '?m=' + (e.modifiedTime || 0)
        img.loading = 'lazy'
        img.addEventListener('error', () => { icon.innerHTML = getFileIcon(e.name) })
        icon.appendChild(img)
      } else {
        icon.innerHTML = getFileIcon(e.name)
      }
      cell.innerHTML = `<span class="wb-fs-name">${escapeHtml(e.name)}</span>`
      cell.dataset.path = e.path
      cell.dataset.name = e.name
      cell.dataset.isdir = String(!!e.isDirectory)
      cell.prepend(icon)
      cell.addEventListener('click', (ev) => {
        if (ev.ctrlKey) {
          const i = nav.sels.indexOf(e.path)
          if (i >= 0) nav.sels.splice(i, 1)
          else nav.sels.push(e.path)
        } else if (ev.shiftKey && nav._lastIdx >= 0) {
          const [a, b] = [Math.min(nav._lastIdx, idx), Math.max(nav._lastIdx, idx)]
          nav.sels = entries.slice(a, b + 1).map(x => x.path)
        } else {
          nav.sels = [e.path]
        }
        nav._lastIdx = idx
        buildGrid()
        updateBulk()
      })
      cell.addEventListener('dblclick', () => {
        if (e.isDirectory) {
          nav.stack.push(nav.cwd)
          nav.cwd = e.path
          nav.sels = []
          renderWbFolder(item)
          wbPersist()
        } else if (item.origin === 'local') {
          // 双击=收进工作台并打开（已在台内则直接激活页签），不再只做临时预览
          const wk = (item.origin || 'local') + '|' + e.path
          if (state.wbItems.some(w => wbKey(w) === wk)) {
            wbActiveKey = wk
            renderWorkbench()
          } else {
            addToWorkbench([{ path: e.path, name: e.name, isDir: false, size: e.size || 0 }], item.origin, item.originName || '本机')
          }
        } else {
          showToast('远程文件不直接预览，可选中后「发送」取回本机', 'info')
        }
      })
      grid.appendChild(cell)
    })
  }
  filter.addEventListener('input', () => {
    nav.filter = filter.value
    buildGrid()
  })
  // ===== 右键菜单（v2.4.71）：补齐文件管理器基本操作 =====
  // 项目 → 打开/加入工作台/引用AI/复制/剪切/粘贴(文件夹)/重命名/删除/资源管理器/发送/下载/编辑
  // 空白 → 新建文件夹/文本/Word/Excel/PPT + 粘贴 + 刷新
  const wbRefresh = () => renderWbFolder(item)
  const selEntriesNow = () => entries.filter(x => nav.sels.includes(x.path))
  const wbClipSet = (cut) => {
    const list = selEntriesNow()
    if (!list.length) { showToast('请先选择文件', 'info'); return false }
    state.clipboard = {
      source: item.origin === 'local' ? 'local' : 'remote',
      deviceId: item.origin === 'local' ? null : item.origin,
      items: list.map(x => ({ path: x.path, isDir: x.isDirectory })),
      cut
    }
    showToast(`已${cut ? '剪切' : '复制'} ${list.length} 项`, 'success')
    return true
  }
  const wbDeleteTargets = async (targets) => {
    if (!targets || !targets.length) return
    const label = targets.length > 1 ? `${targets.length} 项` : `「${targets[0].name}」`
    if (!confirm(`确定要删除 ${label} 吗？此操作不可撤销。`)) return
    let okN = 0, failN = 0
    for (const t of targets) {
      try {
        const r = item.origin === 'local'
          ? await _api.deleteLocalFile(t.path)
          : await _api.deleteRemoteFile(item.origin, t.path)
        if (!r.success) throw new Error(r.error)
        okN++
      } catch (err) { failN++; showToast(err.message, 'error') }
    }
    showToast(failN ? `删除完成: 成功 ${okN}，失败 ${failN}` : '已删除', failN ? 'info' : 'success')
    nav.sels = []
    wbRefresh()
  }
  const wbOpenEntry = (ent) => {
    if (ent.isDirectory) {
      nav.stack.push(nav.cwd)
      nav.cwd = ent.path
      nav.sels = []
      renderWbFolder(item)
      wbPersist()
    } else if (item.origin === 'local') {
      const wk = 'local|' + ent.path
      if (state.wbItems.some(w => wbKey(w) === wk)) { wbActiveKey = wk; renderWorkbench() }
      else addToWorkbench([{ path: ent.path, name: ent.name, isDir: false, size: ent.size || 0 }], 'local', item.originName || '本机')
    } else {
      showToast('远程文件不直接打开，可「下载」取回本机', 'info')
    }
  }
  const wbQuoteRefs = () => {
    const list = selEntriesNow()
    if (!list.length) { showToast('请先选择文件', 'info'); return }
    if (typeof work._appendChatRef !== 'function') { showToast('请先切换到 Work 聊天使用引用', 'error'); return }
    for (const x of list) {
      work._appendChatRef(item.origin === 'local' ? `[引用文件: ${x.path}]` : `[引用远程文件: ${item.originName || '远程设备'}|${item.origin}|${x.path}]`)
    }
    showToast(`已引用 ${list.length} 项到聊天`, 'success')
  }
  const wbNewHere = (type) => {
    showNewItemModal(item.origin === 'local' ? 'local' : 'remote', nav.cwd, type,
      entries.map(x => String(x.name)), item.origin === 'local' ? null : item.origin, wbRefresh)
  }
  grid.addEventListener('contextmenu', (ev) => {
    const cellEl = ev.target.closest('.wb-fs-item')
    const isLocal = item.origin === 'local'
    const hasClip = state.clipboard && Array.isArray(state.clipboard.items) && state.clipboard.items.length > 0
    if (!cellEl) {
      // 空白处：新建 + 粘贴 + 刷新
      ev.preventDefault()
      const acts = [
        { label: iconSvg('folder-plus') + ' 新建文件夹', fn: () => wbNewHere('folder') },
        { label: iconSvg('file-plus') + ' 新建文本文档', fn: () => wbNewHere('txt') },
        { label: iconSvg('file-pen') + ' 新建 Word 文档', fn: () => wbNewHere('docx') },
        { label: iconSvg('table') + ' 新建 Excel 表格', fn: () => wbNewHere('xlsx') },
        { label: iconSvg('presentation') + ' 新建 PPT 演示', fn: () => wbNewHere('pptx') },
        { sep: true }
      ]
      if (hasClip) acts.push({ label: iconSvg('clipboard') + ' 粘贴', fn: () => wbPasteTo(nav.cwd, item, wbRefresh) })
      acts.push({ label: iconSvg('rotate-cw') + ' 刷新', fn: wbRefresh })
      showWbFsMenu(ev, acts)
      return
    }
    ev.preventDefault()
    const p = cellEl.dataset.path
    // 右键未选中项 → 单选它（已在多选里则保持多选，批量操作）
    if (!nav.sels.includes(p)) {
      nav.sels = [p]
      nav._lastIdx = entries.findIndex(x => x.path === p)
      grid.querySelectorAll('.wb-fs-item').forEach(c => c.classList.toggle('sel', nav.sels.includes(c.dataset.path)))
      updateBulk()
    }
    const ent = entries.find(x => x.path === p)
    if (!ent) return
    const multi = nav.sels.length > 1 && nav.sels.includes(p)
    const targets = multi ? selEntriesNow() : [ent]
    const acts = []
    if (!multi) acts.push({ label: iconSvg('folder-open') + (ent.isDirectory ? ' 进入' : ' 打开'), fn: () => wbOpenEntry(ent) })
    if (ent.isDirectory && !multi) acts.push({ label: iconSvg('folder-input') + ' 加入工作台', fn: () => addToWorkbench([{ path: ent.path, name: ent.name, isDir: true, size: 0 }], item.origin, item.originName || (isLocal ? '本机' : '远程设备')) })
    acts.push({ label: iconSvg('message-square') + ' 引用 AI', fn: wbQuoteRefs })
    acts.push({ sep: true })
    acts.push({ label: iconSvg('clipboard') + ' 复制', fn: () => wbClipSet(false) })
    acts.push({ label: iconSvg('scissors') + ' 剪切', fn: () => wbClipSet(true) })
    if (ent.isDirectory && !multi) acts.push({ label: iconSvg('folder-input') + ' 粘贴到该文件夹', fn: () => wbPasteTo(ent.path, item, wbRefresh) })
    acts.push({ sep: true })
    if (isLocal && !multi) acts.push({ label: iconSvg('app-window') + ' 在资源管理器中显示', fn: () => _api.openInExplorer(ent.path) })
    if (isLocal && state.connectedDeviceId) acts.push({ label: iconSvg('send') + ' 发送到对方', fn: async () => {
      if (!state.remotePath || state.remotePath === 'root') { showToast('请先在互联面板进入远程目标目录', 'error'); return }
      for (const x of targets) await uploadFile(x.path, x.isDirectory)
    } })
    if (!isLocal) {
      acts.push({ label: iconSvg('download') + ' 下载到本机', fn: async () => { for (const x of targets) await downloadFile(x.path, x.isDirectory) } })
      if (!multi && !ent.isDirectory) acts.push({ label: iconSvg('square-pen') + ' 编辑', fn: () => editRemoteFile(ent.path) })
    }
    if (!multi) acts.push({ label: iconSvg('square-pen') + ' 重命名', fn: () => showRenameModal(ent.path, ent.name, isLocal ? 'local' : 'remote', isLocal ? null : item.origin, wbRefresh) })
    acts.push({ label: iconSvg('trash-2') + ' 删除', danger: true, fn: () => wbDeleteTargets(targets) })
    showWbFsMenu(ev, acts)
  })
  buildGrid()
  updateBulk()
  body.appendChild(bar)
  body.appendChild(grid)
  body.appendChild(bulk)
}

// 图片滚轮缩放 + 拖拽平移（双击复位）
function attachWbZoom(img) {
  if (!img) return
  let scale = 1
  let tx = 0
  let ty = 0
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})` }
  img.style.cursor = 'grab'
  const wrap = img.parentElement
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault()
    scale = Math.min(8, Math.max(0.2, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
    if (scale === 1) { tx = 0; ty = 0 }
    apply()
  }, { passive: false })
  img.addEventListener('mousedown', (e) => {
    if (scale === 1) return
    e.preventDefault()
    const sx = e.clientX - tx
    const sy = e.clientY - ty
    img.style.cursor = 'grabbing'
    const mv = (ev) => { tx = ev.clientX - sx; ty = ev.clientY - sy; apply() }
    const up = () => {
      img.style.cursor = 'grab'
      window.removeEventListener('mousemove', mv)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', mv)
    window.addEventListener('mouseup', up)
  })
  img.addEventListener('dblclick', () => { scale = 1; tx = 0; ty = 0; apply() })
}

// 把编辑器挂进预览区（编辑态在 wbEditors，切页不丢；md 文件左编辑右实时预览）
function mountWbEditor(item) {
  const key = wbKey(item)
  const ed = wbEditors[key]
  const body = $('wbViewBody')
  const isMd = /\.(md|markdown)$/i.test(item.name || '')
  body.innerHTML = ''
  let previewEl = null
  const refreshMd = () => {
    if (!previewEl) return
    const holder = document.createElement('div')
    holder.appendChild(renderMarkdownFrag(ed.content))
    previewEl.innerHTML = holder.innerHTML || '<p style="color:var(--text-muted)">（空文档）</p>'
  }
  const ta = document.createElement('textarea')
  ta.className = 'wb-editor'
  ta.spellcheck = false
  ta.value = ed.content
  ta.addEventListener('input', () => {
    const cur = wbEditors[key]
    if (!cur) return
    cur.content = ta.value
    cur.dirty = ta.value !== cur.saved
    wbRefreshToolbar(getWbActive())
    refreshMd()
    // 停顿 1.5s 自动保存（不打断输入）
    if (cur.timer) clearTimeout(cur.timer)
    cur.timer = setTimeout(() => wbSaveEdit(false), 1500)
  })
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      wbSaveEdit()
    }
    // Tab 缩进：插入 4 空格不丢焦点
    if (e.key === 'Tab') {
      e.preventDefault()
      const s = ta.selectionStart
      ta.setRangeText('    ', s, ta.selectionEnd, 'end')
      ta.dispatchEvent(new Event('input'))
    }
  })
  if (isMd) {
    const wrap = document.createElement('div')
    wrap.className = 'wb-md-wrap wb-view-content'
    wrap.appendChild(ta)
    previewEl = document.createElement('div')
    previewEl.className = 'wb-md-preview'
    wrap.appendChild(previewEl)
    body.appendChild(wrap)
    refreshMd()
  } else {
    body.appendChild(ta)
  }
  attachWbTextQuote(ta, item.name)
  wbRefreshToolbar(item)
}

// 工作台划词胶囊：选中文字松开左键浮出「添加到对话」，点击走引用胶囊体系（输入框上方 chip + 聊天记录胶囊卡片）
// 单例胶囊：mountWbEditor 每次切页都重建 textarea，胶囊只建一份防 DOM 泄漏
let _wbQuoteCap = null
let _wbQuoteText = ''
let _wbQuoteFile = ''
function wbQuoteHide() {
  if (_wbQuoteCap) _wbQuoteCap.style.display = 'none'
}
// 划选引用 ref：标记行 + > 引用行（appendUserMsg/refChipMeta 按此结构渲染胶囊）
function buildQuoteRef(fileName, text) {
  const clipped = text.length > 2000 ? text.slice(0, 2000) + '…（划选过长已截断）' : text
  return `[来自文件 ${fileName} 的划选]\n` + clipped.split('\n').map((l) => '> ' + l).join('\n')
}
function ensureWbQuoteCap() {
  if (_wbQuoteCap) return _wbQuoteCap
  _wbQuoteCap = document.createElement('div')
  _wbQuoteCap.className = 'wb-quote-cap'
  _wbQuoteCap.innerHTML = iconSvg('plus') + ' 添加到对话'
  _wbQuoteCap.style.display = 'none'
  document.body.appendChild(_wbQuoteCap)
  document.addEventListener('mousedown', (e) => {
    if (_wbQuoteCap.style.display !== 'none' && !_wbQuoteCap.contains(e.target)) wbQuoteHide()
  })
  _wbQuoteCap.addEventListener('mousedown', (e) => e.preventDefault()) // 点胶囊不收选区不抢焦点
  _wbQuoteCap.addEventListener('click', () => {
    if (!_wbQuoteText) { wbQuoteHide(); return }
    const ref = buildQuoteRef(_wbQuoteFile, _wbQuoteText)
    let done = false
    if (typeof work._appendChatRef === 'function') {
      work._appendChatRef(ref) // 引用胶囊 chip（悬停看全文），发送时原文随消息给 AI
      done = true
    } else {
      const input = $('chatInput')
      if (input) {
        input.value = (input.value ? input.value.replace(/\s+$/, '') + '\n\n' : '') + ref + '\n'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.focus()
        done = true
      }
    }
    if (done) showToast('划选已加入对话引用胶囊，AI 能看到原文', 'success')
    wbQuoteHide()
  })
  return _wbQuoteCap
}
function wbQuoteShowAt(x, y) {
  const cap = ensureWbQuoteCap()
  cap.style.display = 'block'
  cap.style.left = Math.max(8, Math.min(x, window.innerWidth - cap.offsetWidth - 8)) + 'px'
  cap.style.top = Math.max(8, Math.min(y, window.innerHeight - cap.offsetHeight - 8)) + 'px'
}
function attachWbTextQuote(el, fileName) {
  if (el._wbQuoteBound) return
  el._wbQuoteBound = true
  const getSel = () => {
    if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') return el.value.slice(el.selectionStart, el.selectionEnd)
    const s = window.getSelection()
    if (s && s.rangeCount && el.contains(s.anchorNode)) return String(s) // 只认本元素内的选区
    return ''
  }
  el.addEventListener('mouseup', (e) => {
    setTimeout(() => {
      _wbQuoteText = getSel().trim()
      _wbQuoteFile = fileName
      if (!_wbQuoteText) return wbQuoteHide()
      wbQuoteShowAt(e.clientX, e.clientY + 10)
    }, 0)
  })
  el.addEventListener('blur', wbQuoteHide)
  el.addEventListener('scroll', wbQuoteHide, true)
}

// Excel 网格编辑器：单元格点选编辑，=开头按公式写回（保留原样式）
async function mountWbGrid(item, sheetName) {
  const key = wbKey(item)
  const body = $('wbViewBody')
  body.innerHTML = `<div class="wb-grid-wrap wb-view-content"><div class="empty-state"><div class="empty-icon">${iconSvg('table')}</div><div>正在读取表格…</div></div></div>`
  const r = await _api.readXlsxSheet(item.path, sheetName || null).catch(() => null)
  if (wbRenderedKey !== key) return
  if (!r || !r.success || !Array.isArray(r.rows)) {
    const msg = (r && r.error) || '读取失败'
    body.innerHTML = `<div class="wb-grid-wrap wb-view-content"><div class="pv-fallback"><div>${escapeHtml(msg)}</div><div class="wb-view-meta">点上方「系统打开」用 WPS/Excel 查看</div></div></div>`
    return
  }
  const grid = wbGrids[key] && wbGrids[key].sheet === r.name ? wbGrids[key] : (wbGrids[key] = { sheet: r.name, edits: {}, dirty: false })
  if (grid.sheet !== r.name) { grid.sheet = r.name; grid.edits = {}; grid.dirty = false }

  const colName = (c) => {
    let s = ''
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26) }
    return s
  }
  const wrap = document.createElement('div')
  wrap.className = 'wb-grid-wrap wb-view-content'
  // 工作表切换
  if ((r.sheets || []).length > 1) {
    const sheets = document.createElement('div')
    sheets.className = 'wb-grid-sheets'
    for (const n of r.sheets) {
      const b = document.createElement('button')
      b.textContent = n
      if (n === r.name) b.className = 'active'
      b.addEventListener('click', () => {
        if (grid.dirty && !confirm('切换工作表将丢失未保存的修改，确定？')) return
        if (grid.dirty) { grid.edits = {}; grid.dirty = false }
        mountWbGrid(item, n)
      })
      sheets.appendChild(b)
    }
    wrap.appendChild(sheets)
  }
  const scroll = document.createElement('div')
  scroll.className = 'wb-grid-scroll'
  const table = document.createElement('table')
  table.className = 'wb-grid'
  // v2.4.94 还原真实版式：列宽（Excel 字符宽 → px ≈ w*7+5）/合并单元格（rowspan+colspan）/加粗/字色/底色/对齐/numFmt 显示值
  const colIdx = (letters) => {
    let n = 0
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n
  }
  const mergeCells = []
  const covered = new Set() // 被合并覆盖的格子：跳过渲染
  for (const m of (r.merges || [])) {
    const mm = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(String(m))
    if (!mm) continue
    const c1 = colIdx(mm[1]), r1 = Number(mm[2]), c2 = colIdx(mm[3]), r2 = Number(mm[4])
    if (!(r2 >= r1 && c2 >= c1 && r1 <= r.rows.length && c1 <= (r.rows[0] || []).length)) continue
    mergeCells.push({ r1, c1, r2, c2 })
    for (let ri = r1; ri <= r2; ri++) for (let ci = c1; ci <= c2; ci++) {
      if (ri !== r1 || ci !== c1) covered.add(ri + ',' + ci)
    }
  }
  if (r.cols && r.cols.some((w) => w)) {
    const cg = document.createElement('colgroup')
    const cw = document.createElement('col')
    cw.style.width = '42px'
    cg.appendChild(cw)
    for (let c = 1; c <= r.rows[0].length; c++) {
      const col = document.createElement('col')
      const w = r.cols[c - 1]
      if (w) col.style.width = Math.max(36, Math.min(420, Math.round(w * 7 + 5))) + 'px'
      cg.appendChild(col)
    }
    table.appendChild(cg)
  }
  const thead = document.createElement('thead')
  const hr = document.createElement('tr')
  hr.appendChild(Object.assign(document.createElement('th'), { textContent: '#' }))
  for (let c = 1; c <= r.rows[0].length; c++) {
    hr.appendChild(Object.assign(document.createElement('th'), { textContent: colName(c) }))
  }
  thead.appendChild(hr)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  r.rows.forEach((row, ri) => {
    const tr = document.createElement('tr')
    const rh = document.createElement('td')
    rh.className = 'rowhead'
    rh.textContent = ri + 1
    tr.appendChild(rh)
    row.forEach((cell, ci) => {
      const rCol = ri + 1
      const cCol = ci + 1
      if (covered.has(rCol + ',' + cCol)) return // 合并覆盖格：不渲染
      const td = document.createElement('td')
      const editKey = `${rCol},${cCol}`
      // 显示值：编辑覆盖 > 公式原始式 > numFmt 格式化值 > 原始文本
      const shown = grid.edits[editKey] !== undefined ? grid.edits[editKey] : (cell.f ? '=' + cell.f : (cell.t != null ? cell.t : cell.v))
      td.textContent = shown
      if (cell.f && grid.edits[editKey] === undefined) td.classList.add('formula-cell')
      // 真实样式还原（只读展示层；写回内容不变，样式不丢）
      if (cell.b) td.style.fontWeight = 'bold'
      if (cell.fc && /^([0-9A-Fa-f]{6})$/.test(cell.fc)) td.style.color = '#' + cell.fc
      if (cell.bg && /^([0-9A-Fa-f]{6})$/.test(cell.bg)) td.style.backgroundColor = '#' + cell.bg
      if (cell.al && ['left', 'center', 'right'].includes(cell.al)) td.style.textAlign = cell.al
      const mg = mergeCells.find((x) => x.r1 === rCol && x.c1 === cCol)
      if (mg) {
        if (mg.r2 > mg.r1) td.rowSpan = mg.r2 - mg.r1 + 1
        if (mg.c2 > mg.c1) td.colSpan = mg.c2 - mg.c1 + 1
      }
      td.dataset.r = rCol
      td.dataset.c = cCol
      td.addEventListener('click', () => selectCell(td))
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
  })
  table.appendChild(tbody)
  scroll.appendChild(table)
  const input = document.createElement('input')
  input.className = 'wb-grid-input'
  const hint = document.createElement('div')
  hint.className = 'wb-grid-hint'
  hint.textContent = `点单元格编辑 · Enter 确认并下移 · ${r.truncated ? `大表已截断为前 ${r.rows.length} 行 × ${r.rows[0].length} 列 · ` : ''}Ctrl+S 保存写回（原文件自动备份）`
  wrap.appendChild(scroll)
  wrap.appendChild(input)
  wrap.appendChild(hint)
  body.innerHTML = ''
  body.appendChild(wrap)

  let curTd = null
  function selectCell(td) {
    commitEdit()
    curTd = td
    td.classList.add('selected')
    const key2 = `${td.dataset.r},${td.dataset.c}`
    const ri = Number(td.dataset.r) - 1
    const ci = Number(td.dataset.c) - 1
    const orig = r.rows[ri][ci]
    input.value = grid.edits[key2] !== undefined ? grid.edits[key2] : (orig.f ? '=' + orig.f : orig.v)
    const scrollRect = scroll.getBoundingClientRect()
    const tdRect = td.getBoundingClientRect()
    input.style.display = 'block'
    input.style.left = (tdRect.left - scrollRect.left + scroll.scrollLeft) + 'px'
    input.style.top = (tdRect.top - scrollRect.top + scroll.scrollTop) + 'px'
    input.style.width = Math.max(90, tdRect.width) + 'px'
    input.style.height = tdRect.height + 'px'
    input.focus()
    input.select()
  }
  function commitEdit(moveDown) {
    if (!curTd) return
    const val = input.value
    const key2 = `${curTd.dataset.r},${curTd.dataset.c}`
    const ri = Number(curTd.dataset.r) - 1
    const ci = Number(curTd.dataset.c) - 1
    const orig = r.rows[ri][ci]
    const origShown = grid.edits[key2] !== undefined ? grid.edits[key2] : (orig.f ? '=' + orig.f : orig.v)
    if (val !== origShown) {
      grid.edits[key2] = val
      grid.dirty = true
      wbRefreshToolbar(getWbActive())
    }
    curTd.textContent = val
    curTd.classList.toggle('formula-cell', val.startsWith('='))
    curTd.classList.remove('selected')
    input.style.display = 'none'
    const was = curTd
    curTd = null
    if (moveDown) {
      const next = was.parentElement.nextElementSibling
      if (next) {
        const nt = next.children[Number(was.dataset.c)]
        if (nt) selectCell(nt)
      }
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(true) }
    else if (e.key === 'Escape') {
      input.style.display = 'none'
      if (curTd) { curTd.classList.remove('selected'); curTd = null }
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit(false)
      if (curTd === null) {
        // Tab 右移：找原单元格右邻
      }
    }
  })
  scroll.addEventListener('scroll', () => commitEdit(false))
  wbRefreshToolbar(item)
}

async function wbSaveGrid(item) {
  const key = wbKey(item)
  const grid = wbGrids[key]
  if (!grid || !grid.dirty) return
  const updates = Object.entries(grid.edits).map(([k, v]) => {
    const [r, c] = k.split(',').map(Number)
    return { r, c, v }
  })
  const res = await _api.writeXlsxCells(item.path, grid.sheet, updates).catch(() => null)
  if (wbGrids[key] !== grid) return
  if (res && res.success) {
    grid.edits = {}
    grid.dirty = false
    if (wbRenderedKey === key) mountWbGrid(item, grid.sheet) // 重读拿到公式最新值
    showToast('表格已保存', 'success')
  } else {
    showToast((res && res.error) || '保存失败', 'error')
  }
  wbRefreshToolbar(item)
}

async function wbSaveEdit(manual = true) {
  const it = getWbActive()
  if (!it) return
  const key = wbKey(it)
  // Excel 网格优先
  const grid = wbGrids[key]
  if (grid && grid.dirty) { await wbSaveGrid(it); return }
  const ed = wbEditors[key]
  if (!ed || !ed.dirty) return
  if (ed.timer) { clearTimeout(ed.timer); ed.timer = null }
  const r = await _api.writeTextFile(it.path, ed.content).catch(() => null)
  if (wbEditors[key] !== ed) return // 编辑态已被切会话/移出清掉
  if (r && r.success) {
    ed.saved = ed.content
    ed.dirty = false
    it.size = r.size
    if (manual) showToast('已保存', 'success')
  } else {
    showToast((r && r.error) || '保存失败', 'error')
  }
  wbRefreshToolbar(it)
}

function itIcon(item) {
  if (item.isDir) return iconSvg('folder')
  if (item.kind === 'webapp') return iconSvg('globe')
  return getFileIcon(item.name)
}

async function wbSendOne(it) {
  if (!it || it._missing) return
  if (it.kind === 'webapp' || it.kind === 'urltab') { showToast('网页页签不用发送，选 [网页] 模型对话即可', 'info'); return }
  if (!state.connectedDeviceId) { showToast('请先连接设备', 'error'); return }
  if (it.origin === 'local') {
    if (!state.remotePath || state.remotePath === 'root') { showToast('请先在远程面板进入目标目录', 'error'); return }
    await uploadFile(it.path, it.isDir)
  } else {
    if (it.origin !== state.connectedDeviceId) {
      showToast(`「${it.name}」来自「${it.originName}」，请先连接该设备`, 'error')
      return
    }
    await downloadFile(it.path, it.isDir)
  }
}

// === Work 三面板拖拽调宽（侧栏 | 工作台 | 资源面板） ===
function applyWorkPaneLayout(isWork) {
  const dual = document.querySelector('.dual-pane')
  const wbPanel = $('workbenchPanel')
  const resPanel = $('resourcePanel')
  if (!wbPanel || !resPanel || !dual) return
  const localSection = document.querySelector('.local-panel')
  const remoteSection = document.querySelector('.remote-panel')
  if (!localSection || !remoteSection) return
  if (isWork) {
    // 把两个浏览面板搬进资源面板页签（DOM 移动保留全部事件监听）
    $('resLocalHome').appendChild(localSection)
    $('resRemoteHome').appendChild(remoteSection)
    wbPanel.classList.remove('hidden')
    resPanel.classList.remove('hidden')
    // v2.4.31 一次性作废旧工作台宽度（旧版分割条错位时存的值无意义，让新默认 58% 生效）
    try {
      if (localStorage.getItem('msmate_wb_workbench_w_ver') !== '31') {
        localStorage.removeItem('msmate_wb_workbench_w')
        localStorage.setItem('msmate_wb_workbench_w_ver', '31')
      }
    } catch {}
    // 恢复上次的拖拽宽度
    try {
      const sw = parseInt(localStorage.getItem('msmate_wb_sidebar_w'), 10)
      const sidebar = document.querySelector('.sidebar')
      if (sw >= 360 && sidebar) sidebar.style.width = sw + 'px'
      const ww = parseInt(localStorage.getItem('msmate_wb_workbench_w'), 10)
      if (ww >= 320) wbPanel.style.flexBasis = ww + 'px'
    } catch {}
  } else {
    dual.appendChild(localSection)
    dual.appendChild(remoteSection)
    wbPanel.classList.add('hidden')
    resPanel.classList.add('hidden')
    document.querySelector('.sidebar').style.width = ''
  }
}

function initSplitters() {
  const body = document.body
  const setup = (el, onMove) => {
    if (!el) return
    el.addEventListener('mousedown', (e) => {
      if (!body.classList.contains('work-mode')) return
      e.preventDefault()
      body.classList.add('splitting')
      el.classList.add('active')
      const move = (ev) => onMove(ev)
      const up = () => {
        body.classList.remove('splitting')
        el.classList.remove('active')
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        try {
          const sidebar = document.querySelector('.sidebar')
          if (sidebar) localStorage.setItem('msmate_wb_sidebar_w', String(sidebar.offsetWidth))
          const wb = $('workbenchPanel')
          if (wb) localStorage.setItem('msmate_wb_workbench_w', String(wb.offsetWidth))
        } catch {}
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }
  setup($('splitSidebar'), (ev) => {
    const sidebar = document.querySelector('.sidebar')
    if (!sidebar) return
    const w = Math.min(window.innerWidth * 0.6, Math.max(360, ev.clientX))
    sidebar.style.width = w + 'px'
  })
  setup($('splitWorkbench'), (ev) => {
    const wb = $('workbenchPanel')
    if (!wb) return
    const dual = document.querySelector('.dual-pane')
    const rect = dual.getBoundingClientRect()
    // 无上限：最多留给资源面板 300px 保底宽度
    const max = Math.max(320, rect.width - 300)
    const w = Math.min(max, Math.max(320, ev.clientX - rect.left))
    wb.style.flexBasis = w + 'px'
  })
}

function initWorkbenchUI() {
  const panel = $('workbenchPanel')
  if (!panel) return
  // 网页版模型：主进程发来对话请求 → 工作台内嵌网页引擎执行，结果流式回传主进程
  if (typeof WbWebChat !== 'undefined' && _api.onAiWebchatAsk) {
    WbWebChat.setHandlers({
      // 未登录：把网页页签加进当前会话工作台并激活，用户直接在网页里登录
      onNeedLogin: (web) => {
        const key = 'local|webchat://' + web
        if (!state.wbItems.some(w => wbKey(w) === key)) addWebAppToWorkbench(web)
        else { wbActiveKey = key; wbRenderedKey = null; renderWorkbench() }
      }
    })
    _api.onAiWebchatAsk(({ sessionId, prompt, attachments, newSession, resumeUrl }) => {
      const web = 'deepseek'
      // 网页对话发生时确保页签存在，但不抢激活（用户正在看的预览不动；未登录才会激活引导登录）
      const key = 'local|webchat://' + web
      if (!state.wbItems.some(w => wbKey(w) === key)) addWebAppToWorkbench(web, false)
      WbWebChat.send(web, prompt, {
        onDelta: (d) => _api.webchatChunk(sessionId, '', d).catch(() => {}),
        onConvUrl: (url) => _api.webchatConv(sessionId, url).catch(() => {}),
        onWait: (sec) => _api.webchatWait(sessionId, '', sec).catch(() => {}), // v2.4.82 等待心跳：防"卡死"体感
        onDone: (t) => _api.webchatDone(sessionId, '', t).catch(() => {}),
        onError: (m) => _api.webchatError(sessionId, '', m).catch(() => {})
      }, attachments, newSession, resumeUrl)
    })
  }
  // ===== AI 打开的文件/网址进工作台（tools open_path/open_url → 主进程 → 这里）=====
  // Work 模式：文件加工作台预览、网址开网页页签；互联模式没有工作台 → 回退系统打开
  if (_api.onAiWorkbenchOpen) {
    _api.onAiWorkbenchOpen((payload) => {
      try {
        if (!payload) return
        if (payload.kind === 'url') {
          if (work.mode === 'work') addUrlTab(payload.url)
          else _api.openExternalFallback({ url: payload.url }).catch(() => {})
          return
        }
        if (work.mode === 'work') {
          addToWorkbench([{ path: payload.path, name: payload.name, isDir: false, size: payload.size || 0 }], 'local', '本机')
        } else {
          // 内置优先（默认）：互联模式自动切到 Work 模式进工作台页签——真机反馈"设了内置优先
          // 还是打开 WPS"即此处旧逻辑互联模式直接回退系统打开导致；系统优先才回退系统打开
          _api.getSetting('preferOpen').then((v) => {
            if ((v || 'builtin') === 'builtin' && $('modeWork')) {
              $('modeWork').click()
              setTimeout(() => {
                try { addToWorkbench([{ path: payload.path, name: payload.name, isDir: false, size: payload.size || 0 }], 'local', '本机') } catch (e) { console.warn('切模式后入工作台失败', e) }
              }, 60)
            } else {
              _api.openExternalFallback({ path: payload.path }).catch(() => {})
            }
          }).catch(() => _api.openExternalFallback({ path: payload.path }).catch(() => {}))
        }
      } catch (e) { console.warn('workbench-open 处理失败', e) }
    })
  }
  // 拖拽进入工作台任意区域（本地/远程面板拖来的文件都收）
  panel.addEventListener('dragover', (e) => {
    if (!(e.dataTransfer.types || []).includes('application/json')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    panel.classList.add('drag-over')
  })
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over')
  })
  panel.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    panel.classList.remove('drag-over')
    let data = null
    try { data = JSON.parse(e.dataTransfer.getData('application/json')) } catch {}
    if (!data || !Array.isArray(data.items) || !data.items.length) return
    if (data.source === 'remote') {
      state.remoteDragConsumed = true // 已收进工作台，别再触发拖出下载
      addToWorkbench(data.items, data.deviceId || state.connectedDeviceId, data.deviceName || '远程设备')
    } else {
      addToWorkbench(data.items, 'local', '本机')
    }
  })
  $('wbClearBtn').addEventListener('click', () => {
    if (!state.wbItems.length) return
    const dirtyCount = Object.values(wbEditors).filter(ed => ed.dirty).length +
      Object.values(wbGrids).filter(g => g.dirty).length
    const tip = dirtyCount ? `清空工作台？${dirtyCount} 个文件有未保存的修改将丢失。文件本身不会被删除。` : '清空工作台？不会删除文件本身。'
    if (!confirm(tip)) return
    state.wbItems = []
    wbEditors = {}
    wbGrids = {}
    wbFolderNav = {}
    wbActiveKey = null
    wbRenderedKey = null
    wbEmbedKill() // 清空时收掉内嵌的 WPS/Word 文档窗口
    if (typeof WbWebChat !== 'undefined') WbWebChat.destroy('deepseek') // 网页层一并收掉
    renderWorkbench()
    wbPersist()
  })
  // 标签拖动排序：拖到标签条上松手=排序；拖出去仍按文件拖拽处理
  const tabsEl = $('wbTabs')
  tabsEl.addEventListener('dragover', (e) => {
    if (wbTabDragIdx === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  })
  tabsEl.addEventListener('drop', (e) => {
    if (wbTabDragIdx === null) return
    e.preventDefault()
    e.stopPropagation()
    const from = wbTabDragIdx
    wbTabDragIdx = null
    const kids = Array.from(tabsEl.children)
    let to = kids.findIndex((el) => e.clientX <= el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2)
    if (to === -1) to = kids.length
    if (to > from) to--
    if (to === from) return
    const [moved] = state.wbItems.splice(from, 1)
    state.wbItems.splice(to, 0, moved)
    renderWorkbench()
    wbPersist()
  })
  tabsEl.addEventListener('dragend', () => { wbTabDragIdx = null })
  // 新建文本/文件夹（F）
  $('wbNewFileBtn').addEventListener('click', () => wbCreateEntry(false))
  $('wbNewDirBtn').addEventListener('click', () => wbCreateEntry(true))
  // 快速访问目录缓存（E）
  _api.shellDirs().then((d) => { wbShellDirs = d }).catch(() => {})
  $('wbSendBtn').addEventListener('click', wbSendAll)
  $('localAddToWb').addEventListener('click', () => addSelectionToWorkbench('local'))
  $('remoteAddToWb').addEventListener('click', () => addSelectionToWorkbench('remote'))
  // 预览区工具条
  $('wbSaveBtn').addEventListener('click', () => wbSaveEdit())
  $('wbRefBtn').addEventListener('click', () => {
    const it = getWbActive()
    if (it) wbAddRef(it)
  })
  $('wbSendOneBtn').addEventListener('click', () => wbSendOne(getWbActive()))
  $('wbOpenSysBtn').addEventListener('click', () => {
    const it = getWbActive()
    if (!it || it._missing) return
    if (it.isDir) _api.openInExplorer(it.path).catch(() => {})
    else _api.openFile(it.path, { forceSystem: true }).catch(() => {}) // 明确系统语义：跳过内置分流，否则会被送回工作台死循环
  })
  $('wbLocateBtn').addEventListener('click', () => {
    const it = getWbActive()
    if (!it) return
    if (it.origin !== 'local') { showToast('远程文件请先取回本机再定位', 'error'); return }
    _api.openInExplorer(it.path).catch(() => {})
  })
  // Ctrl+S：预览区有未保存文本时保存（编辑器内已单独拦截，这里兜输入框外焦点）
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      const it = getWbActive()
      const ed = it && wbEditors[wbKey(it)]
      if (ed && ed.dirty) {
        e.preventDefault()
        wbSaveEdit()
      }
    }
  })
  // 资源面板页签（本地 | 远程）
  const resPanel = $('resourcePanel')
  resPanel.querySelectorAll('.res-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      resPanel.querySelectorAll('.res-tab').forEach((t) => t.classList.toggle('active', t === tab))
      resPanel.querySelectorAll('.res-tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.rtab !== tab.dataset.rtab))
    })
  })
  initSplitters()
}

// === 设备管理 ===
async function refreshDevices() {
  try {
    updateStatus('扫描中...', 'connecting')
    await _api.refreshDevices()
    await new Promise(r => setTimeout(r, 500))
    renderDeviceList()
    updateStatus('就绪', 'ready')
  } catch {
    showToast('扫描设备失败，请检查防火墙是否放行本程序', 'error')
    updateStatus('就绪', 'ready')
  }
}

// v2.7.14：手动 IP 直连已并入「桥接」弹窗（仅连接不保存），manualConnect 退役

function renderDeviceList() {
  if (!deviceItems || !deviceCount) return
  // 桥接页签：好友通讯录单独渲染
  if (state.deviceTab === 'friends') return renderFriendsList()
  // 合并四类设备：局域网 > 中转 > IPv6 历史 > 互联网 presence（同 ID 以高优先级为准）
  const devices = Array.from(state.devices.values())
  for (const d of state.relayDevices.values()) {
    if (!state.devices.has(d.deviceId)) devices.push(d)
  }
  for (const p of state.ipv6Peers.values()) {
    if (!state.devices.has(p.deviceId) && !state.relayDevices.has(p.deviceId)) devices.push(p)
  }
  for (const d of state.netDevices.values()) {
    if (!state.devices.has(d.deviceId) && !state.relayDevices.has(d.deviceId) && !state.ipv6Peers.has(d.deviceId)) devices.push(d)
  }

  if (devices.length === 0) {
    deviceItems.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('search')}</div><div>正在扫描局域网...</div><div class="empty-hint">异地设备？点右上角 + 添加桥接</div></div>`
    deviceCount.textContent = '0'
    return
  }

  // 按类型分组：局域网 / 远程在线（互联网 presence、桥接、IPv6）
  const lan = devices.filter(d => !d.viaNet && !d.viaRelay && !d.viaIPv6)
  const remote = devices.filter(d => d.viaNet || d.viaRelay || d.viaIPv6)
  const deviceHtml = (device) => {
    const isActive = state.connectedDeviceId === device.deviceId
    const isConnected = state.connectedDevices.has(device.deviceId)
    const displayName = device.name || device.hostname
    const remark = state.deviceRemarks[device.deviceId]
    const remarkHtml = remark ? `<div class="device-remark">${iconSvg('file-pen')} ${escapeHtml(remark)}</div>` : ''
    const statusText = isActive ? '浏览中' : (isConnected ? '已连接·切换' : '点击连接')
    const viaRelay = !!device.viaRelay
    const viaIPv6 = !!device.viaIPv6
    const viaNet = !!device.viaNet
    let metaText = device.ip
    let icon = iconSvg('laptop')
    let badge = ''
    if (viaNet) { icon = iconSvg('globe'); badge = ' <span class="relay-badge">互联网</span>' }
    else if (viaRelay) { metaText = '互联网通道'; icon = iconSvg('globe'); badge = ' <span class="relay-badge">远程</span>' }
    else if (viaIPv6) { metaText = 'IPv6 直连'; icon = iconSvg('radio-tower'); badge = ' <span class="relay-badge">远程</span>' }
    return `<div class="device-item ${isActive ? 'connected' : ''}" data-device-id="${device.deviceId}">
      <span class="device-icon">${icon}</span>
      <div class="device-info">
        <div class="device-name">${escapeHtml(displayName)}${badge}</div>
        <div class="device-meta"><span>${escapeHtml(metaText)}</span></div>
        ${remarkHtml}
      </div>
      <span class="device-status ${isActive || isConnected ? 'online' : 'offline'}">${statusText}</span>
    </div>`
  }
  const groupHtml = (title, list, icon) => list.length
    ? `<div class="device-group-title">${iconSvg(icon)} ${title} · ${list.length}</div>` + list.map(deviceHtml).join('')
    : ''
  deviceItems.innerHTML = groupHtml('局域网', lan, 'laptop')
    + groupHtml('远程在线', remote, 'globe')
    + netQuotaHintHtml(devices)

  deviceCount.textContent = devices.length

  deviceItems.querySelectorAll('.device-item').forEach(item => {
    item.addEventListener('click', () => {
      const deviceId = item.dataset.deviceId
      if (deviceId === state.connectedDeviceId) {
        // 点击当前浏览的设备 → 断开
        disconnectDevice(deviceId)
      } else if (state.connectedDevices.has(deviceId)) {
        // 已连接的其他设备 → 切换浏览
        switchActiveDevice(deviceId)
      } else {
        connectToDevice(deviceId)
      }
    })
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showDeviceContextMenu(e, item.dataset.deviceId)
    })
  })
}

async function connectToDevice(deviceId) {
  const device = state.devices.get(deviceId) || state.relayDevices.get(deviceId) || state.ipv6Peers.get(deviceId) || state.netDevices.get(deviceId)
  if (!device) {
    showToast('设备信息不存在，请刷新设备列表', 'error')
    return
  }
  state.lastConnectedIP = device.ip
  state.manualDisconnect = false
  state.reconnectAttempts = 0
  // 互联网设备（公网/中转/IPv6）：连接前查每日额度（2GB），用完就别白连了
  if (device.viaNet || device.viaRelay || device.viaIPv6) {
    const q = await _api.netQuota().catch(() => null)
    if (q && q.left <= 0) {
      showToast('今日互联网传输额度已用完（2GB/天），明日自动恢复', 'error')
      return
    }
  }
  showToast(`正在连接 ${device.hostname || device.name}...`, 'info')
  try {
    // 四条通道：中转 / IPv6 历史 / 互联网 presence P2P 直连 / 局域网直连
    const result = device.viaRelay
      ? await _api.relayConnect(deviceId)
      : device.viaIPv6
        ? await _api.ipv6ConnectPeer(deviceId)
        : await _api.connectByIP(device.ip) // viaNet（公网 IP 直连）与局域网同走 connectByIP（端口 45679）
    if (!result.success) {
      showToast(`连接失败: ${result.error}（请确认对方 MSMate 已打开；互联网直连需对方公网 IP 可达）`, 'error')
    }
  } catch (err) {
    showToast(`连接失败: ${err.message}（请确认对方 MSMate 已打开）`, 'error')
  }
}

// === 互联网传输每日额度（2GB/天）：列表提示 + 连接前预检 + 超额断开提示 ===
let _netQuotaCache = null
async function refreshNetQuota() {
  try { _netQuotaCache = await _api.netQuota() } catch { }
}
function netQuotaHintHtml(devices) {
  const hasNet = (devices || []).some(d => d.viaNet || d.viaRelay || d.viaIPv6)
  if (!hasNet || !_netQuotaCache) return ''
  const b = _netQuotaCache.left || 0
  const fmt = b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}GB` : `${Math.max(0, Math.round(b / 1048576))}MB`
  return `<div class="net-quota-hint">${iconSvg('globe')} 互联网传输今日剩余 ${fmt} / 2GB</div>`
}
if (window.api && window.api.onNetQuotaExceeded) {
  window.api.onNetQuotaExceeded(() => {
    _netQuotaCache = null
    showToast('今日互联网传输额度已用完（2GB/天），明日自动恢复', 'error')
  })
}

// === 桥接（v2.7.14）：远程设备通讯录，加好友式一键直连，存 settings.json ===
function findDiscoveredByFriend(f) {
  const all = [...state.devices.values(), ...state.netDevices.values(), ...state.ipv6Peers.values(), ...state.relayDevices.values()]
  return all.find(d => d.deviceId === f.host || d.ip === f.host)
}

function renderFriendsList() {
  const friends = state.friends || []
  deviceCount.textContent = friends.length
  if (!friends.length) {
    deviceItems.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('user-plus')}</div><div>还没有桥接设备</div><div class="empty-hint">点右上角 +，填对方 IP 或设备 ID</div></div>`
    return
  }
  deviceItems.innerHTML = friends.map((f) => {
    const disc = findDiscoveredByFriend(f)
    const name = f.name || f.host
    return `<div class="device-item friend-item" data-host="${escapeHtml(f.host)}">
      <span class="device-icon">${iconSvg('globe')}</span>
      <div class="device-info">
        <div class="device-name">${escapeHtml(name)}${disc ? ' <span class="relay-badge">在线</span>' : ''}</div>
        <div class="device-meta"><span>${escapeHtml(f.host)}</span></div>
      </div>
      <span class="device-status ${disc ? 'online' : 'offline'}">${disc ? '连接' : '离线'}</span>
      <button type="button" class="friend-del" data-host="${escapeHtml(f.host)}" title="删除桥接">${iconSvg('x')}</button>
    </div>`
  }).join('')
  deviceItems.querySelectorAll('.friend-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.friend-del')) return
      const f = (state.friends || []).find(x => x.host === item.dataset.host)
      if (f) connectFriend(f)
    })
  })
  deviceItems.querySelectorAll('.friend-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const host = btn.dataset.host
      if (!confirm('删除这个桥接？\n（只从列表移除；已建立的信任要在设备右键里移除）')) return
      try {
        const r = await _api.removeFriend(host)
        state.friends = (r && r.friends) || (state.friends || []).filter(x => x.host !== host)
        renderFriendsList()
        showToast('已删除桥接', 'success')
      } catch (err) {
        showToast(`删除失败: ${err.message}`, 'error')
      }
    })
  })
}

// 好友连接：优先对上发现列表（设备 ID/在线 IP），否则按 IP 直连；设备 ID 且离线 → 提示
async function connectFriend(f) {
  const disc = findDiscoveredByFriend(f)
  if (disc) { connectToDevice(disc.deviceId); return }
  const isPrivate = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(f.host)
  if (!isPrivate && !f.host.includes(':')) {
    // 公网 IPv4：走额度预检
    const q = await _api.netQuota().catch(() => null)
    if (q && q.left <= 0) { showToast('今日互联网传输额度已用完（2GB/天），明日自动恢复', 'error'); return }
  }
  state.lastConnectedIP = f.host
  state.manualDisconnect = false
  state.reconnectAttempts = 0
  showToast(`正在连接 ${f.name || f.host}...`, 'info')
  try {
    const result = await _api.connectByIP(f.host)
    if (!result.success) {
      showToast(`连接失败: ${result.error}（对方需在线且 MSMate 已打开；填设备 ID 时对方须在线）`, 'error')
    }
  } catch (err) {
    showToast(`连接失败: ${err.message}`, 'error')
  }
}

function openFriendModal() {
  const m = $('friendModal')
  if (!m) return
  $('friendHost').value = ''
  $('friendName').value = ''
  m.classList.remove('hidden')
  setTimeout(() => { const h = $('friendHost'); if (h) h.focus() }, 100)
}

function friendHostValue() {
  const el = $('friendHost')
  return el ? el.value.trim() : ''
}

function switchDeviceTab(tab) {
  state.deviceTab = tab
  document.querySelectorAll('[data-dtab]').forEach((b) => b.classList.toggle('active', b.dataset.dtab === tab))
  renderDeviceList()
}

async function handleFriendSave() {
  const host = friendHostValue()
  if (!host) { showToast('请填写对方 IP 或设备 ID', 'error'); return }
  try {
    const r = await _api.addFriend(host, ($('friendName') || {}).value || '')
    if (r && r.ok) {
      state.friends = r.friends || []
      const m = $('friendModal')
      if (m) m.classList.add('hidden')
      switchDeviceTab('friends')
      showToast('桥接已添加，对方在线时一键直连', 'success')
    } else {
      showToast((r && r.error) || '添加失败', 'error')
    }
  } catch (err) {
    showToast(`添加失败: ${err.message}`, 'error')
  }
}

function handleFriendConnectOnce() {
  const host = friendHostValue()
  if (!host) { showToast('请填写对方 IP 或设备 ID', 'error'); return }
  const m = $('friendModal')
  if (m) m.classList.add('hidden')
  connectFriend({ host, name: ($('friendName') || {}).value || '' })
}

// === 互联网在线设备（v0.4）：msmate-api presence 登记，30s 轮询；连接走 P2P 公网 IP 直连 ===
async function refreshNetDevices() {
  let changed = false
  await refreshNetQuota()
  try {
    const r = await _api.presenceList()
    if (r && r.ok) {
      const seen = new Set()
      for (const d of (r.devices || [])) {
        if (d.deviceId === r.selfId) continue // 排除自己
        seen.add(d.deviceId)
        const prev = state.netDevices.get(d.deviceId)
        if (!prev || prev.ip !== d.ip || prev.name !== d.name) changed = true
        state.netDevices.set(d.deviceId, { deviceId: d.deviceId, name: d.name, platform: d.platform, ip: d.ip, viaNet: true })
      }
      for (const k of Array.from(state.netDevices.keys())) {
        if (!seen.has(k)) { state.netDevices.delete(k); changed = true }
      }
    }
  } catch { /* 离线保留旧列表，下轮再刷 */ }
  if (changed || state.netDevices.size) renderDeviceList()
}
setInterval(refreshNetDevices, 30000)
setTimeout(refreshNetDevices, 6000)
// 桥接列表启动加载
if (window.api && window.api.getFriends) {
  window.api.getFriends().then((list) => {
    state.friends = Array.isArray(list) ? list : []
    renderDeviceList()
  }).catch(() => { })
}

// === 互联网模式（v0.5：官方服务自动连接，无需用户配置） ===
// 侧栏状态徽标 = 登录态（presence 心跳随登录自动运行）；弹窗展示官方连接状态 + 本机 ID + 额度
function updateRelayTag(snap) {
  const tag = $('relayStatusTag')
  if (!tag) return
  const loggedIn = snap && snap.loggedIn
  tag.textContent = loggedIn ? '在线' : '未登录'
  tag.className = `relay-status ${loggedIn ? 'on' : 'off'}`
  const modalText = $('relayStatusText')
  if (modalText) modalText.textContent = loggedIn ? '已连接官方服务（设备心跳 30 秒/次）' : '未登录（点顶栏头像登录后自动启用）'
}

async function openRelayModal() {
  const m = $('relayModal')
  if (!m) return
  m.classList.remove('hidden')
  // 登录态 + 在线设备数
  try {
    const st = await _api.authGetState()
    const loggedIn = !!(st && st.token)
    updateRelayTag({ loggedIn })
    const n = state.netDevices.size
    if (loggedIn) {
      const extra = n ? ` · 当前 ${n} 台设备在线` : ' · 暂无其他设备在线（双方都登录后自动出现在列表）'
      const modalText = $('relayStatusText')
      if (modalText) modalText.textContent = '已连接官方服务（设备心跳 30 秒/次）' + extra
    }
  } catch { updateRelayTag({ loggedIn: false }) }
  // 本机设备 ID
  try {
    const info = await _api.getInfo()
    const el = $('relaySelfId')
    if (el && info && info.selfId) el.value = info.selfId
  } catch { }
  // 今日额度
  try {
    const q = await _api.netQuota()
    const line = $('relayQuotaLine')
    if (line && q) {
      const b = q.left || 0
      const fmt = b >= 1073741824 ? `${(b / 1073741824).toFixed(1)}GB` : `${Math.max(0, Math.round(b / 1048576))}MB`
      line.textContent = `剩余 ${fmt} / 2GB（局域网直连不限）`
    }
  } catch { }
}

function initRelayUI() {
  // 官方 presence 模式：状态徽标 = 登录态；旧中转服务器的状态/设备钩子已废弃
  if (_api.authGetState) {
    _api.authGetState().then((st) => updateRelayTag({ loggedIn: !!(st && st.token) })).catch(() => { })
  }
}

// === IPv6 直连 ===
function applyIpv6Peers(peersObj) {
  const next = new Map()
  for (const [deviceId, p] of Object.entries(peersObj || {})) {
    if (p && Array.isArray(p.addrs) && p.addrs.length) {
      next.set(deviceId, {
        deviceId,
        name: p.name || deviceId,
        hostname: p.name || deviceId,
        ip: p.addrs[0],
        addrs: p.addrs,
        viaIPv6: true
      })
    }
  }
  state.ipv6Peers = next
  renderDeviceList()
}

function updateIpv6Tag(text, cls) {
  const tag = $('ipv6StatusTag')
  if (tag) { tag.textContent = text; tag.className = `relay-status ${cls}` }
  const st = $('ipv6SelfStatus')
  if (st) st.textContent = text
}

async function openIpv6Modal() {
  const m = $('ipv6Modal')
  if (!m || !_api.ipv6GetInvite) return
  m.classList.remove('hidden')
  try {
    const r = await _api.ipv6GetInvite()
    if (r.success && r.invite) {
      $('ipv6MyInvite').value = r.invite
      updateIpv6Tag(`有 ${r.addresses.length} 个 IPv6 地址`, 'on')
    } else {
      $('ipv6MyInvite').value = ''
      updateIpv6Tag('本机没有公网 IPv6', 'err')
    }
  } catch {
    updateIpv6Tag('检测失败', 'err')
  }
}

async function handleIpv6CopyInvite() {
  const box = $('ipv6MyInvite')
  if (!box || !box.value) {
    showToast('没有可复制的邀请码（本机可能没有 IPv6）', 'error')
    return
  }
  box.select()
  try { await navigator.clipboard.writeText(box.value) } catch { document.execCommand('copy') }
  showToast('邀请码已复制，发给对方即可', 'success')
}

async function handleIpv6Connect() {
  const box = $('ipv6PeerInvite')
  if (!box) return
  const text = box.value.trim()
  if (!text) {
    showToast('请先粘贴对方的邀请码或 IPv6 地址', 'error')
    return
  }
  const btn = $('ipv6ConnectBtn')
  if (btn) { btn.disabled = true; btn.textContent = '连接中...' }
  try {
    const r = await _api.ipv6ConnectInvite(text)
    if (r.success) {
      showToast(`已连上 ${r.name || '对方'}，若首次连接请完成配对`, 'success')
      box.value = ''
      const m = $('ipv6Modal')
      if (m) m.classList.add('hidden')
    } else {
      showToast(`连接失败: ${r.error}（请确认对方 MSMate 已打开）`, 'error')
    }
  } catch (err) {
    showToast(`连接失败: ${err.message}（请确认对方 MSMate 已打开）`, 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '连接对方' }
  }
}

function initIpv6UI() {
  if (!_api.ipv6GetPeers) return
  if (_api.onIpv6Peers) _api.onIpv6Peers((peers) => applyIpv6Peers(peers))
  _api.ipv6GetPeers().then((r) => {
    if (r && r.success) applyIpv6Peers(r.peers)
  }).catch(() => { })
  // 顺手探测本机 IPv6（用于侧栏状态标签）
  _api.ipv6GetInvite().then((r) => {
    if (r.success && r.invite) updateIpv6Tag('可用', 'on')
    else updateIpv6Tag('无 IPv6', 'err')
  }).catch(() => { })
}

// 切换当前浏览的已连接设备（多设备支持）
function switchActiveDevice(deviceId) {
  const info = state.connectedDevices.get(deviceId)
  if (!info) { showToast('该设备未连接', 'error'); return }
  state.connectedDeviceId = deviceId
  state.connectedDeviceInfo = info
  state.remotePath = 'root'
  state.remoteEntries = []
  state.remoteSelected.clear()
  if (remotePathEl) remotePathEl.value = ''
  const host = info.name || info.hostname
  updateStatus(`已连接: ${host}`, 'connected')
  if (remoteFileView) remoteFileView.classList.remove('hidden')
  const hint = $('notConnectedHint')
  if (hint) hint.classList.add('hidden')
  renderDeviceList()
  refreshRemoteDirectory('root')
  showToast(`已切换到 ${host}`, 'success')
  updatePTTButton()
}

// 断开指定设备（真正断开 TCP 连接）
function disconnectDevice(deviceId) {
  const targetId = deviceId || state.connectedDeviceId
  if (!targetId) return
  const info = state.connectedDevices.get(targetId)
  const host = info ? (info.name || info.hostname) : '设备'

  // 手动断开该设备后不再自动重连它
  if (targetId === state.connectedDeviceId) state.manualDisconnect = true

  try { _api.disconnectDevice(targetId) } catch {}

  // 本地状态清理（TCP close 事件也会触发 onConnectionStatus，这里先同步清理避免闪烁）
  state.connectedDevices.delete(targetId)
  if (targetId === state.connectedDeviceId) {
    state.connectedDeviceId = null
    state.connectedDeviceInfo = null
    state.remotePath = 'root'
    state.remoteEntries = []
    state.remoteSelected.clear()
    if (remotePathEl) remotePathEl.value = ''
    const remoteUpBtn = $('remoteUp')
    if (remoteUpBtn) remoteUpBtn.disabled = true

    if (state.connectedDevices.size > 0) {
      // 还有其他连接 → 切换到下一台
      const next = state.connectedDevices.entries().next().value
      state.connectedDeviceId = next[0]
      state.connectedDeviceInfo = next[1]
      const nextHost = next[1].name || next[1].hostname
      updateStatus(`已连接: ${nextHost}`, 'connected')
      showToast(`已断开 ${host}，已切换到 ${nextHost}`, 'info')
      refreshRemoteDirectory('root')
    } else {
      if (remoteFileView) remoteFileView.classList.add('hidden')
      const hint = $('notConnectedHint')
      if (hint) hint.classList.remove('hidden')
      updateStatus('就绪', 'ready')
      showToast(`已断开 ${host}`, 'info')
    }
  } else {
    showToast(`已断开 ${host}`, 'info')
  }
  renderDeviceList()
  updatePTTButton()
}

// 自动重连：无限重试 + 指数退避，只有手动断开才停止
async function autoReconnect() {
  if (state.manualDisconnect || !state.lastConnectedIP) return
  if (state.reconnecting) return  // 防止并发重连
  // 如果已经连接上了（对方先重连过来的），不再重连
  if (state.connectedDeviceId) return
  state.reconnecting = true
  state.reconnectAttempts++
  const attempt = state.reconnectAttempts
  // 指数退避：3s → 5s → 10s → 20s → 30s（上限 30s）
  const delays = [3000, 5000, 10000, 20000, 30000]
  const baseDelay = delays[Math.min(attempt - 1, delays.length - 1)]
  // 加随机抖动，避免双方同时发起重连导致建立两个反向 socket 无法通信
  const delay = baseDelay + Math.floor(Math.random() * 2000)
  const delaySec = Math.round(delay / 1000)
  showToast(`连接断开，${delaySec}秒后自动重连(第${attempt}次)...`, 'info')
  updateStatus(`重连中(第${attempt}次)...`, 'connecting')
  await new Promise(r => setTimeout(r, delay))
  // 延迟期间如果对方已重连过来或用户手动断开，停止重连
  if (state.manualDisconnect) { state.reconnecting = false; return }
  if (state.connectedDeviceId) { state.reconnecting = false; return }
  try {
    const result = await _api.connectByIP(state.lastConnectedIP)
    if (result.success) {
      // 连接建立中，等待 onConnectionStatus connected 事件确认
      // 8秒内未收到 connected 事件则认为握手失败，继续重连
      setTimeout(() => {
        if (state.reconnecting && !state.connectedDeviceId) {
          state.reconnecting = false
          autoReconnect()
        }
      }, 8000)
    } else {
      state.reconnecting = false
      autoReconnect()
    }
  } catch {
    state.reconnecting = false
    autoReconnect()
  }
}

// === 导航 ===
function isDriveRoot(p) { return p && /^[A-Z]:\\$/i.test(p) }
function isDriveLetter(p) { return p && /^[A-Z]:$/i.test(p) }

async function navigateUp(direction) {
  if (direction === 'local') {
    const currentPath = state.localPath
    if (currentPath === 'root') return
    if (isDriveRoot(currentPath)) { await loadLocalDirectory('root'); return }
    // 去掉尾部反斜杠后计算上级目录，实现逐级返回
    const p = currentPath.replace(/\\+$/, '')
    const idx = p.lastIndexOf('\\')
    if (idx === 2) {
      // D:\folder -> D:\ (返回到盘符根目录)
      await loadLocalDirectory(p.substring(0, 3))
    } else if (idx > 2) {
      // D:\folder\sub -> D:\folder (返回到上级文件夹)
      await loadLocalDirectory(p.substring(0, idx))
    } else {
      await loadLocalDirectory('root')
    }
  } else {
    const currentPath = state.remotePath
    if (!currentPath || currentPath === 'root') return
    if (isDriveRoot(currentPath)) { state.remotePath = 'root'; await refreshRemoteDirectory('root'); return }
    const p = currentPath.replace(/\\+$/, '')
    const idx = p.lastIndexOf('\\')
    if (idx === 2) {
      state.remotePath = p.substring(0, 3)
      await refreshRemoteDirectory(state.remotePath)
    } else if (idx > 2) {
      state.remotePath = p.substring(0, idx)
      await refreshRemoteDirectory(state.remotePath)
    } else {
      state.remotePath = 'root'
      await refreshRemoteDirectory('root')
    }
  }
}

// === 传输操作 ===
async function downloadFile(remotePath, isFolder, destDirOverride) {
  if (!state.connectedDeviceId) { showToast('请先连接远程设备', 'error'); return }

  const fileName = remotePath.split('\\').pop()

  if (isFolder) {
    // 文件夹递归下载
    let destDir = destDirOverride || state.defaultDownloadDir
    if (!destDir) {
      destDir = await _api.selectFolder()
      if (!destDir) return
      state.defaultDownloadDir = destDir
      await _api.setSetting('defaultDownloadDir', destDir)
    }
    
    const transferId = 'folder-dl-' + Date.now()
    state.transfers.set(transferId, { id: transferId, name: fileName + ' (文件夹)', direction: 'download', status: 'downloading', progress: 0 })
    renderTransfers()
    
    try {
      const result = await _api.downloadFolder(state.connectedDeviceId, remotePath, destDir)
      if (result.success) {
        completeTransfer({ transferId, direction: 'download', path: destDir, fileName })
        showToast(`文件夹下载完成: ${result.successCount}/${result.totalFiles} 个文件`, 'success')
      } else {
        errorTransfer({ transferId, error: result.error })
        showToast(`下载失败: ${result.error}`, 'error')
      }
    } catch (err) {
      errorTransfer({ transferId, error: err.message })
      showToast(`下载失败: ${err.message}`, 'error')
    }
    return
  }

  // 单文件下载
  let savePath
  let destDir = destDirOverride || state.defaultDownloadDir
  if (destDir) {
    savePath = destDir + '\\' + fileName
  } else {
    savePath = await _api.selectSave(fileName)
    if (!savePath) return
  }

  const transferId = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  state.transfers.set(transferId, { id: transferId, name: fileName, direction: 'download', status: 'downloading', progress: 0, size: 0 })
  renderTransfers()

  try {
    await _api.downloadFile(state.connectedDeviceId, remotePath, savePath, transferId)
    completeTransfer({ transferId, direction: 'download', path: savePath, fileName })
    showToast(`下载完成: ${fileName}`, 'success')
  } catch (err) {
    errorTransfer({ transferId, error: err.message })
    showToast(`下载失败: ${err.message}`, 'error')
  }
}

// 远程文件拖出到窗口外（桌面/资源管理器）→ 下载到本机桌面
async function downloadRemoteToDesktop(items) {
  if (!state.connectedDeviceId || !items || items.length === 0) return
  let desktopDir
  try {
    desktopDir = await _api.getDesktopDir()
  } catch {
    desktopDir = state.defaultDownloadDir || ''
  }
  if (!desktopDir) { showToast('无法获取桌面路径', 'error'); return }

  showToast(`正在下载 ${items.length} 项到桌面...`, 'info')
  for (const item of items) {
    try {
      await downloadFile(item.path, item.isDir, desktopDir)
    } catch (err) {
      showToast(`下载失败: ${err.message}`, 'error')
    }
  }
}

// 远程编辑：下载到临时目录→打开→保存后自动上传回对方
async function editRemoteFile(remotePath) {
  if (!state.connectedDeviceId) { showToast('请先连接远程设备', 'error'); return }
  showToast('正在下载文件用于编辑...', 'info')
  try {
    const result = await _api.editRemoteFile(state.connectedDeviceId, remotePath)
    if (result.success) {
      showToast('文件已打开，保存后自动同步到对方电脑', 'success')
    } else {
      showToast(`编辑失败: ${result.error}`, 'error')
    }
  } catch (err) {
    showToast(`编辑失败: ${err.message}`, 'error')
  }
}

async function uploadFile(localPath, isFolder) {
  if (!state.connectedDeviceId) { showToast('请先连接远程设备', 'error'); return }
  if (!state.remotePath || state.remotePath === 'root') { showToast('请先进入远程设备的某个盘或目录', 'error'); return }

  const fileName = localPath.split('\\').pop()

  if (isFolder) {
    // 文件夹递归上传
    const transferId = 'folder-ul-' + Date.now()
    state.transfers.set(transferId, { id: transferId, name: fileName + ' (文件夹)', direction: 'upload', status: 'uploading', progress: 0 })
    renderTransfers()

    try {
      const result = await _api.uploadFolder(state.connectedDeviceId, localPath, state.remotePath)
      if (result.success) {
        completeTransfer({ transferId, direction: 'upload', path: localPath, fileName })
        showToast(`文件夹上传完成: ${result.successCount}/${result.totalFiles} 个文件`, 'success')
        refreshRemoteDirectory()
      } else {
        errorTransfer({ transferId, error: result.error })
        showToast(`上传失败: ${result.error}`, 'error')
      }
    } catch (err) {
      errorTransfer({ transferId, error: err.message })
      showToast(`上传失败: ${err.message}`, 'error')
    }
    return
  }

  // 单文件上传
  const transferId = 'ul-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  state.transfers.set(transferId, { id: transferId, name: fileName, direction: 'upload', status: 'uploading', progress: 0, size: 0 })
  renderTransfers()

  try {
    await _api.uploadFile(state.connectedDeviceId, localPath, state.remotePath, transferId)
    completeTransfer({ transferId, direction: 'upload', path: localPath, fileName })
    showToast(`上传完成: ${fileName}`, 'success')
    refreshRemoteDirectory()
  } catch (err) {
    errorTransfer({ transferId, error: err.message })
    showToast(`上传失败: ${err.message}`, 'error')
  }
}

// === 批量操作 ===
async function batchDownloadSelected() {
  const items = getSelectedRemoteItems()
  if (items.length === 0) return

  let destDir = state.defaultDownloadDir
  if (!destDir) {
    destDir = await _api.selectFolder()
    if (!destDir) return
    state.defaultDownloadDir = destDir
    await _api.setSetting('defaultDownloadDir', destDir)
  }

  showToast(`开始下载 ${items.length} 个项目...`, 'info')
  
  for (const item of items) {
    await downloadFile(item.path, item.isDir)
  }
  
  state.remoteSelected.clear()
  renderRemoteFileList(state.remoteEntries)
}

async function batchUploadSelected() {
  const items = getSelectedLocalItems()
  if (items.length === 0) return
  if (!state.connectedDeviceId) { showToast('请先连接远程设备', 'error'); return }
  if (!state.remotePath || state.remotePath === 'root') { showToast('请先进入远程设备的某个盘或目录', 'error'); return }

  showToast(`开始上传 ${items.length} 个项目...`, 'info')
  
  for (const item of items) {
    await uploadFile(item.path, item.isDir)
  }
  
  state.localSelected.clear()
  renderLocalFileList(state.localEntries)
}

// === 传输进度和状态 ===
function updateTransferProgress(data) {
  let transfer = state.transfers.get(data.transferId)
  if (!transfer) {
    // 接收方：对方发来的文件，本地未创建条目 → 自动创建接收条目
    if (data.incoming) {
      transfer = {
        id: data.transferId,
        name: data.fileName || '接收中...',
        direction: 'download', // 接收方统一显示为下载（⬇）
        status: 'downloading',
        progress: data.progress || 0,
        sent: data.sent,
        total: data.total,
        size: data.total
      }
      state.transfers.set(data.transferId, transfer)
      renderTransfers()
    }
    return
  }
  transfer.progress = data.progress
  transfer.sent = data.sent
  transfer.total = data.total
  if (transfer.size === 0 && data.total) transfer.size = data.total
  renderTransfers()
}

function completeTransfer(data) {
  let transfer = state.transfers.get(data.transferId)
  if (!transfer) {
    // 接收方快速完成（未收到进度）时补建条目
    if (data.incoming) {
      const fileName = data.fileName || (data.path ? data.path.split('\\').pop() : '已接收')
      transfer = {
        id: data.transferId,
        name: fileName,
        direction: 'download',
        status: 'complete',
        progress: 100,
        size: data.size || 0,
        path: data.path || ''
      }
      state.transfers.set(data.transferId, transfer)
      renderTransfers()
      // 接收完成后刷新本地列表
      if (data.path && state.localPath !== 'root') loadLocalDirectory(state.localPath)
      return
    }
    return
  }
  transfer.status = 'complete'
  transfer.progress = 100
  transfer.path = data.path || transfer.path || ''
  renderTransfers()
  // 不再自动删除，保留在列表中直到用户清除
  // 接收文件后刷新本地文件列表，确保新文件可见
  if (data.path && state.localPath !== 'root') {
    const normDir = (d) => d ? d.replace(/\\+$/, '').toLowerCase() : ''
    const lastSep = data.path.lastIndexOf('\\')
    const fileDir = lastSep > 0 ? data.path.substring(0, lastSep) : ''
    if (normDir(fileDir) === normDir(state.localPath) || normDir(data.path) === normDir(state.localPath)) {
      loadLocalDirectory(state.localPath)
    }
  }
}

function errorTransfer(data) {
  const transfer = state.transfers.get(data.transferId)
  if (transfer) {
    transfer.status = 'error'
    transfer.error = data.error
    renderTransfers()
  }
}

function renderTransfers() {
  if (!transferList) return
  const transfers = Array.from(state.transfers.values())
  
  if (transfers.length === 0) {
    transferList.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('clipboard')}</div><div>暂无传输任务</div><div class="empty-hint">右键文件选择下载/上传，或拖拽文件到对方面板</div></div>`
    return
  }

  transferList.innerHTML = transfers.map(t => `
    <div class="transfer-item ${t.direction} ${t.status === 'complete' ? 'complete' : ''} ${t.status === 'error' ? 'error' : ''} ${t.status === 'complete' && t.path ? 'clickable' : ''}" data-id="${t.id}" ${t.status === 'complete' && t.path ? `title="点击打开文件" data-path="${escapeHtml(t.path)}"` : ''}>
      <span class="transfer-icon">${t.direction === 'download' ? '⬇' : '⬆'}</span>
      <div class="transfer-info">
        <div class="transfer-name">${escapeHtml(t.name)}</div>
        <div class="transfer-progress-bar">
          <div class="transfer-progress-fill" style="width: ${t.progress || 0}%"></div>
        </div>
      </div>
      <div class="transfer-stats">
        <span class="transfer-percent">${t.progress || 0}%</span>
        ${t.status === 'error' ? `<span class="transfer-error-text">${escapeHtml(t.error || '')}</span>` : ''}
      </div>
      ${t.status !== 'complete' && t.status !== 'error' ? `<button class="transfer-cancel" data-id="${t.id}" title="取消">${iconSvg('x')}</button>` : ''}
    </div>
  `).join('')

  // 点击完成的传输条目打开对应文件
  transferList.querySelectorAll('.transfer-item.clickable').forEach(item => {
    item.addEventListener('click', async () => {
      const p = item.dataset.path
      if (!p) return
      const res = await _api.openFile(p)
      if (!res || !res.success) showToast(`无法打开文件（可能已被移动或删除）`, 'error')
    })
  })

  transferList.querySelectorAll('.transfer-cancel').forEach(btn => {
    btn.addEventListener('click', async () => {
      await _api.cancelTransfer(btn.dataset.id)
    })
  })
}

function clearCompletedTransfers() {
  for (const [id, t] of state.transfers) {
    if (t.status === 'complete' || t.status === 'error') {
      state.transfers.delete(id)
    }
  }
  renderTransfers()
}

// === 标签页 ===
function switchTab(tab) {
  state.activeTab = tab
  $('tabActive').classList.toggle('active', tab === 'active')
  $('tabHistory').classList.toggle('active', tab === 'history')
  
  if (tab === 'active') {
    transferList.classList.remove('hidden')
    transferHistoryList.classList.add('hidden')
  } else {
    transferList.classList.add('hidden')
    transferHistoryList.classList.remove('hidden')
    renderTransferHistory()
  }
}

async function renderTransferHistory() {
  if (!transferHistoryList) return
  try {
    const history = await _api.getTransferHistory() || []
    if (history.length === 0) {
      transferHistoryList.innerHTML = `<div class="empty-state"><div class="empty-icon">${iconSvg('file-text')}</div><div>暂无历史记录</div></div>`
      return
    }

    transferHistoryList.innerHTML = history.map((h, idx) => {
      const time = new Date(h.time).toLocaleString('zh-CN')
      const icon = h.direction === 'download' ? '⬇' : '⬆'
      const sizeText = h.size ? formatSize(h.size) : ''
      const meta = [time, h.device ? `[${h.device}]` : '', sizeText].filter(Boolean).join(' · ')
      return `<div class="transfer-item ${h.direction} ${h.path ? 'clickable' : ''}" data-idx="${idx}" ${h.path ? `title="点击打开文件" data-path="${escapeHtml(h.path)}"` : ''}>
        <span class="transfer-icon">${icon}</span>
        <div class="transfer-info">
          <div class="transfer-name">${escapeHtml(h.name)}</div>
          <div class="transfer-meta">${meta}</div>
        </div>
      </div>`
    }).join('')

    // 点击日志打开对应文件
    transferHistoryList.querySelectorAll('.transfer-item.clickable').forEach(item => {
      item.addEventListener('click', async () => {
        const p = item.dataset.path
        if (!p) return
        const res = await _api.openFile(p)
        if (!res || !res.success) showToast(`无法打开文件（可能已被移动或删除）`, 'error')
      })
    })
  } catch {}
}

// === 文件选择对话框 ===
async function selectLocalFolder() {
  try {
    const folder = await _api.selectFolder()
    if (folder) await loadLocalDirectory(folder)
  } catch {
    showToast('选择文件夹失败', 'error')
  }
}

async function selectFiles() {
  try {
    const files = await _api.selectFiles()
    if (files && files.length > 0) {
      if (!state.connectedDeviceId) { showToast('请先连接远程设备', 'error'); return }
      if (!state.remotePath || state.remotePath === 'root') { showToast('请先进入远程设备的某个盘或目录', 'error'); return }
      
      showToast(`上传 ${files.length} 个文件到远程...`, 'info')
      const results = await _api.batchUpload(state.connectedDeviceId, files, state.remotePath)
      const successCount = results.filter(r => r.success).length
      showToast(`上传完成: ${successCount}/${files.length}`, 'success')
      refreshRemoteDirectory()
    }
  } catch {
    showToast('选择文件失败', 'error')
  }
}

// === 配对 ===
async function showPairCode() {
  try {
    const code = await _api.getPairCode()
    state.pairCode = code
    if (pairCodeEl) pairCodeEl.textContent = code
    if (pairCodeDisplay) pairCodeDisplay.classList.remove('hidden')
    showToast(`配对码: ${code}（5 分钟内有效）`, 'info')
    setTimeout(() => { if (pairCodeDisplay) pairCodeDisplay.classList.add('hidden') }, 300000)
  } catch {
    showToast('获取配对码失败', 'error')
  }
}

// 发起方取消配对 / 被连方拒绝（审批模式带 requestId 回执对方）
function handlePairReject() {
  if (!pairRequestModal) return
  _api.acceptPair({
    deviceId: pairRequestModal.dataset.deviceId,
    accepted: false,
    requestId: pairRequestModal.dataset.mode === 'approve' ? (pairRequestModal.dataset.requestId || '') : undefined
  })
  pairRequestModal.classList.add('hidden')
  pairRequestModal.dataset.mode = ''
}

// 2.0：发起方提交配对码（局域网）；桥接审批模式 = 直接回同意
async function handlePairSubmitCode() {
  if (!pairRequestModal) return
  const deviceId = pairRequestModal.dataset.deviceId
  // 桥接审批模式：被连方点「同意连接」→ 带 requestId 回执发起方，双方建立信任
  if (pairRequestModal.dataset.mode === 'approve') {
    const btn = $('pairSubmitCode')
    if (btn) { btn.disabled = true; btn.textContent = '处理中...' }
    try {
      const r = await _api.acceptPair({ deviceId, accepted: true, requestId: pairRequestModal.dataset.requestId || '' })
      if (r && r.success) {
        pairRequestModal.classList.add('hidden')
        pairRequestModal.dataset.mode = ''
        showToast('已同意，桥接建立', 'success')
      } else {
        showToast((r && r.error) || '操作失败', 'error')
      }
    } catch (err) {
      showToast(`操作失败: ${err.message}`, 'error')
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '同意连接' }
    }
    return
  }
  const code = (pairCodeInput ? pairCodeInput.value : '').trim()
  if (!/^\d{6}$/.test(code)) { showToast('请输入 6 位数字配对码', 'error'); return }
  const btn = $('pairSubmitCode')
  if (btn) { btn.disabled = true; btn.textContent = '验证中...' }
  try {
    const result = await _api.verifyPairCode({ deviceId, code })
    if (result && result.success) {
      pairRequestModal.classList.add('hidden')
      if (pairCodeInput) pairCodeInput.value = ''
      showToast('配对成功', 'success')
    } else {
      showToast((result && result.error) || '配对码错误', 'error')
      if (pairCodeInput) { pairCodeInput.value = ''; pairCodeInput.focus() }
    }
  } catch {
    showToast('配对验证失败，请核对 6 位配对码', 'error')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '确认配对' }
  }
}

// 2.0：发起方——对方尚未信任本机，弹出配对 UI。
// 局域网 = 输对方屏幕上的 6 位码；远程桥接（remote）= 无码可输，显示"等待对方点同意"等待态
// （1.0 设备的 hello-ack 不带 trusted 字段，不会触发本函数，走自动信任直连）
function handlePairRequired(data) {
  if (!pairRequestModal) return
  pairRequestModal.dataset.deviceId = data.deviceId
  const name = (data.deviceInfo && (data.deviceInfo.name || data.deviceInfo.hostname)) || '对方设备'
  const targetEl = $('pairTargetName')
  if (targetEl) targetEl.textContent = name
  const requesterView = $('pairRequesterView')
  const title = $('pairModalTitle')
  const submitBtn = $('pairSubmitCode')
  const rejectBtn = $('pairReject')
  const hint = $('pairRequesterHint')
  if (data.remote) {
    // 远程审批等待态：对方屏幕会弹「同意/拒绝」
    pairRequestModal.dataset.mode = 'wait'
    if (title) title.textContent = '桥接连接'
    if (requesterView) requesterView.classList.add('hidden')
    if (submitBtn) submitBtn.classList.add('hidden')
    if (rejectBtn) { rejectBtn.classList.remove('hidden'); rejectBtn.textContent = '取消' }
    if (hint) hint.textContent = '桥接请求已送达，请在对方设备的屏幕上点「同意」…（双方同意后即建立信任并直连，5 分钟内有效）'
    pairRequestModal.classList.remove('hidden')
    return
  }
  pairRequestModal.dataset.mode = 'code'
  if (title) title.textContent = '配对验证'
  if (requesterView) requesterView.classList.remove('hidden')
  if (submitBtn) { submitBtn.classList.remove('hidden'); submitBtn.textContent = '确认配对' }
  if (rejectBtn) { rejectBtn.classList.remove('hidden'); rejectBtn.textContent = '取消' }
  if (hint) hint.textContent = '对方屏幕右下角会收到连接通知并显示 6 位配对码（顶栏同步显示），输入后即可自动完成配对'
  if (pairCodeInput) { pairCodeInput.value = ''; setTimeout(() => pairCodeInput.focus(), 100) }
  pairRequestModal.classList.remove('hidden')
  // 配对码 5 分钟过期 → 自动关闭弹窗
  clearTimeout(pairRequestModal._autoCloseTimer)
  pairRequestModal._autoCloseTimer = setTimeout(() => {
    if (pairRequestModal && !pairRequestModal.classList.contains('hidden') && pairRequestModal.dataset.deviceId === data.deviceId) {
      pairRequestModal.classList.add('hidden')
      showToast('配对超时，请重新连接', 'info')
    }
  }, 300000)
}

// 发起方等待态收尾：对方拒绝/超时（pair:decision）
function handlePairDecision(data) {
  if (!pairRequestModal || pairRequestModal.classList.contains('hidden')) return
  if (data.deviceId && pairRequestModal.dataset.deviceId && pairRequestModal.dataset.deviceId !== data.deviceId) return
  pairRequestModal.classList.add('hidden')
  pairRequestModal.dataset.mode = ''
  showToast(data.accepted ? '桥接成功' : '对方拒绝了本次连接或已超时', data.accepted ? 'success' : 'error')
}

// 2.0：被连方——局域网：右下角通知 + 顶栏显示配对码（码对即自动完成配对）；
// 远程桥接：对方看不到本机屏幕 → 弹「同意/拒绝」审批卡（同意 = 建立双向信任）
function handlePairRequest(data) {
  const name = (data.deviceInfo && (data.deviceInfo.name || data.deviceInfo.hostname)) || '未知设备'
  if (data.remote) {
    if (!pairRequestModal || !data.requestId) return
    pairRequestModal.dataset.deviceId = data.deviceId
    pairRequestModal.dataset.requestId = data.requestId
    pairRequestModal.dataset.mode = 'approve'
    const targetEl = $('pairTargetName')
    if (targetEl) targetEl.textContent = name
    const requesterView = $('pairRequesterView')
    if (requesterView) requesterView.classList.add('hidden')
    const title = $('pairModalTitle')
    if (title) title.textContent = '桥接连接请求'
    const submitBtn = $('pairSubmitCode')
    if (submitBtn) { submitBtn.classList.remove('hidden'); submitBtn.textContent = '同意连接' }
    const rejectBtn = $('pairReject')
    if (rejectBtn) { rejectBtn.classList.remove('hidden'); rejectBtn.textContent = '拒绝' }
    const hint = $('pairRequesterHint')
    if (hint) hint.textContent = '对方通过互联网发起桥接连线，同意后双方建立信任并直连（不想连就点拒绝）'
    pairRequestModal.classList.remove('hidden')
    return
  }
  // 顶栏显示配对码（5 分钟有效）
  if (data.pairCode) {
    state.pairCode = data.pairCode
    if (pairCodeEl) pairCodeEl.textContent = data.pairCode
    if (pairCodeDisplay) pairCodeDisplay.classList.remove('hidden')
    clearTimeout(handlePairRequest._codeTimer)
    handlePairRequest._codeTimer = setTimeout(() => {
      if (pairCodeDisplay) pairCodeDisplay.classList.add('hidden')
    }, 300000)
  }
  showNotifyToast(`${name} 向你发起连接，配对码：${data.pairCode || '------'}（5 分钟内有效）`, null, 10000)
}

// 2.0：被连方——对方通过配对码验证，配对完成（隐藏顶栏码）
function handlePairAutoAccepted(data) {
  if (pairCodeDisplay) pairCodeDisplay.classList.add('hidden')
  const name = (data.deviceInfo && (data.deviceInfo.name || data.deviceInfo.hostname)) || '对方'
  showToast(`${name} 已通过配对码验证，配对完成`, 'success')
}

// === 右键菜单 ===
let contextMenuTarget = null

function handleContextMenu(e) {
  if (!contextMenu) return
  const fileItem = e.target.closest('.file-item')
  const localPanel = e.target.closest('.local-panel')
  const remotePanelEl = e.target.closest('.remote-panel')

  // 不在本地/远程面板内：隐藏菜单
  if (!localPanel && !remotePanelEl) { hideContextMenu(); return }

  e.preventDefault()
  const source = localPanel ? 'local' : 'remote'
  const newActions = ['new-folder', 'new-txt', 'new-docx', 'new-xlsx', 'new-pptx']
  const clipActions = ['copy', 'cut']

  if (!fileItem) {
    // 空白处右键：显示"新建"和"粘贴"（有内容时）
    let canCreate = false
    let newParentPath = null
    if (source === 'local') {
      if (state.localPath && state.localPath !== 'root') { canCreate = true; newParentPath = state.localPath }
    } else {
      if (state.connectedDeviceId && state.remotePath && state.remotePath !== 'root') { canCreate = true; newParentPath = state.remotePath }
    }
    if (!canCreate) { hideContextMenu(); return }
    const hasClip = state.clipboard.items.length > 0
    contextMenuTarget = { source, newParentPath, path: null, name: null, isDirectory: false }
    contextMenu.querySelectorAll('.menu-item').forEach(item => {
      const action = item.dataset.action
      if (action === 'paste') { item.style.display = hasClip ? '' : 'none'; return }
      if (newActions.includes(action)) { item.style.display = ''; return }
      item.style.display = 'none'
    })
  } else {
    // 文件项右键
    const isDirectory = fileItem.dataset.isdir === 'true'
    contextMenuTarget = {
      path: fileItem.dataset.path,
      name: fileItem.dataset.name,
      isDirectory,
      source,
      newParentPath: isDirectory ? fileItem.dataset.path : null
    }
    contextMenu.querySelectorAll('.menu-item').forEach(item => {
      const action = item.dataset.action
      if (action === 'paste') { item.style.display = 'none'; return }
      if (newActions.includes(action)) {
        // 仅文件夹允许在其内部新建
        item.style.display = isDirectory ? '' : 'none'
        return
      }
      if (clipActions.includes(action)) {
        item.style.display = ''; return
      }
      if (source === 'remote') {
        const showActions = isDirectory ? ['download', 'rename', 'delete'] : ['download', 'edit', 'rename', 'delete']
        // Work 模式下远程文件也能收进工作台
        if (document.body.classList.contains('work-mode')) showActions.push('to-workbench')
        item.style.display = showActions.includes(action) ? '' : 'none'
      } else {
        if (action === 'to-workbench') {
          item.style.display = document.body.classList.contains('work-mode') ? '' : 'none'
        } else {
          item.style.display = (action === 'upload' || action === 'open' || action === 'explorer' || action === 'rename' || action === 'delete') ? '' : 'none'
        }
      }
    })
  }

  // 清理多余的分割线
  cleanupSeparators()

  const menuW = 200
  let x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  if (x < 0) x = 0
  contextMenu.style.left = x + 'px'
  contextMenu.style.top = e.clientY + 'px'
  contextMenu.classList.remove('hidden')
  // 显示后按实际高度修正，防止底部溢出
  const menuH = contextMenu.offsetHeight
  let y = e.clientY
  if (y + menuH > window.innerHeight - 8) y = window.innerHeight - menuH - 8
  if (y < 0) y = 0
  contextMenu.style.top = y + 'px'
}

// 隐藏前后没有可见菜单项的分割线
function cleanupSeparators() {
  if (!contextMenu) return
  const all = Array.from(contextMenu.children)
  all.forEach((el, i) => {
    if (!el.classList.contains('menu-separator')) return
    const hasVisibleBefore = all.slice(0, i).some(x => x.classList.contains('menu-item') && x.style.display !== 'none')
    const hasVisibleAfter = all.slice(i + 1).some(x => x.classList.contains('menu-item') && x.style.display !== 'none')
    el.style.display = (hasVisibleBefore && hasVisibleAfter) ? '' : 'none'
  })
}

function hideContextMenu() {
  if (contextMenu) contextMenu.classList.add('hidden')
}

// === 工作台文件网格右键菜单（v2.4.71）：动态构建，与互联面板静态菜单互不干扰 ===
let wbFsMenuEl = null
function showWbFsMenu(e, actions) {
  if (!wbFsMenuEl) {
    wbFsMenuEl = document.createElement('div')
    wbFsMenuEl.id = 'wb-fs-context-menu'
    wbFsMenuEl.className = 'context-menu hidden'
    document.body.appendChild(wbFsMenuEl)
  }
  wbFsMenuEl.innerHTML = ''
  for (const a of actions) {
    if (a.sep) {
      const s = document.createElement('div')
      s.className = 'menu-separator'
      wbFsMenuEl.appendChild(s)
      continue
    }
    const it = document.createElement('div')
    it.className = 'menu-item' + (a.danger ? ' danger' : '')
    it.innerHTML = a.label // label 含 iconSvg 串，textContent 会显示源码（2.7.1 补修）
    it.addEventListener('click', () => {
      hideWbFsMenu()
      try { a.fn() } catch (err) { showToast(err.message, 'error') }
    })
    wbFsMenuEl.appendChild(it)
  }
  const menuW = 200
  let x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  if (x < 0) x = 0
  wbFsMenuEl.style.left = x + 'px'
  wbFsMenuEl.style.top = e.clientY + 'px'
  wbFsMenuEl.classList.remove('hidden')
  const menuH = wbFsMenuEl.offsetHeight
  let y = e.clientY
  if (y + menuH > window.innerHeight - 8) y = window.innerHeight - menuH - 8
  if (y < 0) y = 0
  wbFsMenuEl.style.top = y + 'px'
}

function hideWbFsMenu() {
  if (wbFsMenuEl) wbFsMenuEl.classList.add('hidden')
}

// === 设备右键菜单（备注）===
let deviceMenuEl = null
let deviceMenuTargetId = null

function showDeviceContextMenu(e, deviceId) {
  if (!deviceMenuEl) deviceMenuEl = $('device-context-menu')
  if (!deviceMenuEl) return
  deviceMenuTargetId = deviceId
  // 隐藏文件菜单
  hideContextMenu()
  const menuW = 180
  let x = Math.min(e.clientX, window.innerWidth - menuW - 8)
  if (x < 0) x = 0
  deviceMenuEl.style.left = x + 'px'
  deviceMenuEl.style.top = e.clientY + 'px'
  deviceMenuEl.classList.remove('hidden')
}

function hideDeviceContextMenu() {
  if (deviceMenuEl) deviceMenuEl.classList.add('hidden')
  deviceMenuTargetId = null
}

function initDeviceContextMenu() {
  if (!deviceMenuEl) deviceMenuEl = $('device-context-menu')
  if (!deviceMenuEl) return
  deviceMenuEl.addEventListener('click', async (e) => {
    const action = e.target.dataset.action
    if (!action || !deviceMenuTargetId) { hideDeviceContextMenu(); return }
    const deviceId = deviceMenuTargetId
    if (action === 'device-remark') {
      showDeviceRemarkModal(deviceId)
    } else if (action === 'device-clear-remark') {
      try {
        await _api.setDeviceRemark(deviceId, '')
        delete state.deviceRemarks[deviceId]
        renderDeviceList()
        showToast('备注已清除', 'success')
      } catch (err) {
        showToast(`清除失败: ${err.message}`, 'error')
      }
    }
    hideDeviceContextMenu()
  })
  // 点击其他地方关闭设备菜单
  document.addEventListener('click', (e) => {
    if (deviceMenuEl && !deviceMenuEl.classList.contains('hidden')) {
      if (!e.target.closest('#device-context-menu')) hideDeviceContextMenu()
    }
  })
}

function initContextMenu() {
  if (!contextMenu) contextMenu = $('context-menu')
  if (contextMenu) {
    contextMenu.addEventListener('click', async (e) => {
      const action = e.target.dataset.action
      if (!action || !contextMenuTarget) return
      const { path, name, isDirectory, source } = contextMenuTarget

      // 新建文件/文件夹
      const newTypeMap = {
        'new-folder': 'folder',
        'new-txt': 'txt',
        'new-docx': 'docx',
        'new-xlsx': 'xlsx',
        'new-pptx': 'pptx'
      }
      if (newTypeMap[action]) {
        const parentPath = contextMenuTarget.newParentPath
        if (!parentPath) { hideContextMenu(); return }
        showNewItemModal(source, parentPath, newTypeMap[action])
        hideContextMenu()
        return
      }

      if (action === 'download' && source === 'remote') {
        await downloadFile(path, isDirectory)
      } else if (action === 'copy') {
        copySelected(source)
      } else if (action === 'cut') {
        cutSelected(source)
      } else if (action === 'paste') {
        await pasteToPanel(source)
      } else if (action === 'edit' && source === 'remote') {
        await editRemoteFile(path)
      } else if (action === 'upload' && source === 'local') {
        await uploadFile(path, isDirectory)
      } else if (action === 'to-workbench') {
        addContextToWorkbench(source, contextMenuTarget)
      } else if (action === 'open' && source === 'local') {
        await _api.openFile(path)
      } else if (action === 'explorer' && source === 'local') {
        await _api.openInExplorer(path)
      } else if (action === 'rename') {
        showRenameModal(path, name, source)
      } else if (action === 'delete') {
        if (confirm(`确定要删除 ${name} 吗？此操作不可撤销。`)) {
          try {
            if (source === 'remote') {
              await _api.deleteRemoteFile(state.connectedDeviceId, path)
              refreshRemoteDirectory()
            } else {
              const result = await _api.deleteLocalFile(path)
              if (!result.success) throw new Error(result.error)
              loadLocalDirectory(state.localPath)
            }
            showToast('已删除', 'success')
          } catch (err) {
            showToast(`删除失败: ${err.message}`, 'error')
          }
        }
      }
      hideContextMenu()
    })
  }
}

// === 重命名 / 备注 / 改名（复用同一弹窗）===
function showRenameModal(path, name, source, deviceId, wbRefresh) {
  state.renameTarget = { mode: 'rename', path, name, source, deviceId: deviceId || null, wbRefresh: wbRefresh || null }
  const titleEl = $('renameTitle')
  const labelEl = $('renameLabel')
  if (titleEl) titleEl.textContent = '重命名'
  if (labelEl) labelEl.textContent = '新名称：'
  if (renameInput) { renameInput.value = name; renameInput.placeholder = '输入新名称' }
  if (renameModal) renameModal.classList.remove('hidden')
  // 默认只选中文件名部分（不含扩展名），便于直接输入替换；仍可手动改扩展名
  const dotIdx = name.lastIndexOf('.')
  setTimeout(() => {
    if (!renameInput) return
    renameInput.focus()
    if (dotIdx > 0) renameInput.setSelectionRange(0, dotIdx)
    else renameInput.select()
  }, 50)
}

function showDeviceRemarkModal(deviceId) {
  const device = state.devices.get(deviceId)
  const current = state.deviceRemarks[deviceId] || ''
  state.renameTarget = { mode: 'device-remark', deviceId }
  const titleEl = $('renameTitle')
  const labelEl = $('renameLabel')
  if (titleEl) titleEl.textContent = '设备备注'
  if (labelEl) labelEl.textContent = `备注（${device ? (device.name || device.hostname) : ''}）：`
  if (renameInput) { renameInput.value = current; renameInput.placeholder = '输入备注（留空清除）' }
  if (renameModal) renameModal.classList.remove('hidden')
  setTimeout(() => { if (renameInput) { renameInput.focus(); renameInput.select() } }, 50)
}

function showHelpModal() {
  const m = $('helpModal')
  if (m) m.classList.remove('hidden')
}

async function confirmRename() {
  if (!state.renameTarget) return
  const newName = renameInput ? renameInput.value.trim() : ''
  const target = state.renameTarget

  // 设备备注模式：允许空值（清除备注）
  if (target.mode === 'device-remark') {
    if (renameModal) renameModal.classList.add('hidden')
    try {
      await _api.setDeviceRemark(target.deviceId, newName)
      if (newName) state.deviceRemarks[target.deviceId] = newName
      else delete state.deviceRemarks[target.deviceId]
      renderDeviceList()
      showToast(newName ? '备注已保存' : '备注已清除', 'success')
    } catch (err) {
      showToast(`保存备注失败: ${err.message}`, 'error')
    }
    return
  }

  // 新建文件/文件夹模式
  if (target.mode === 'new-item') {
    if (!newName) { showToast('请输入名称', 'error'); return }
    if (renameModal) renameModal.classList.add('hidden')
    await createNewItem(target.source, target.parentPath, target.type, newName)
    return
  }

  // 默认：文件重命名
  if (!newName) { showToast('请输入新名称', 'error'); return }
  const { path, source } = target
  if (renameModal) renameModal.classList.add('hidden')

  try {
    if (source === 'remote') {
      const result = await _api.renameRemoteFile(target.deviceId || state.connectedDeviceId, path, newName)
      if (result.success) {
        showToast('重命名成功', 'success')
        if (typeof target.wbRefresh === 'function') target.wbRefresh()
        else refreshRemoteDirectory()
      } else {
        showToast(`重命名失败: ${result.error}`, 'error')
      }
    } else {
      // 本地重命名通过 IPC 调用主进程
      const result = await _api.renameLocalFile(path, newName)
      if (result.success) {
        showToast('重命名成功', 'success')
        if (typeof target.wbRefresh === 'function') target.wbRefresh()
        else loadLocalDirectory(state.localPath)
      } else {
        showToast(`重命名失败: ${result.error}`, 'error')
      }
    }
  } catch (err) {
    showToast(`重命名失败: ${err.message}`, 'error')
  }
}

// === 新建文件/文件夹（弹窗输入名称后创建）===
const newItemNameMap = {
  folder: '新建文件夹',
  txt: '新建文本文档.txt',
  docx: '新建 Word 文档.docx',
  xlsx: '新建 Excel 表格.xlsx',
  pptx: '新建 PPT 演示.pptx'
}

function showNewItemModal(source, parentPath, type, existingNames, deviceId, wbRefresh) {
  const baseName = newItemNameMap[type]
  // existingNames：工作台网格传入的当前目录名单（数组）；不传则回退互联面板 entries
  const nameObjs = Array.isArray(existingNames) ? existingNames.map(n => ({ name: n })) : (source === 'local' ? state.localEntries : state.remoteEntries)
  const existing = new Set((nameObjs || []).map(e => String(e.name).toLowerCase()))

  // 生成唯一默认名
  let name = baseName
  if (existing.has(name.toLowerCase())) {
    if (type === 'folder') {
      let i = 2
      while (existing.has(`新建文件夹 (${i})`.toLowerCase())) i++
      name = `新建文件夹 (${i})`
    } else {
      const dot = baseName.lastIndexOf('.')
      const stem = baseName.slice(0, dot)
      const ext = baseName.slice(dot)
      let i = 2
      while (existing.has(`${stem} (${i})${ext}`.toLowerCase())) i++
      name = `${stem} (${i})${ext}`
    }
  }

  const titleMap = { folder: '新建文件夹', txt: '新建文本文档', docx: '新建 Word 文档', xlsx: '新建 Excel 表格', pptx: '新建 PPT 演示' }
  state.renameTarget = { mode: 'new-item', source, parentPath, type, deviceId: deviceId || null, wbRefresh: wbRefresh || null }
  const titleEl = $('renameTitle')
  const labelEl = $('renameLabel')
  if (titleEl) titleEl.textContent = titleMap[type] || '新建'
  if (labelEl) labelEl.textContent = '名称：'
  if (renameInput) {
    renameInput.value = name
    renameInput.placeholder = '输入名称'
    // 选中文件名主体（不含扩展名）便于直接输入
    const dotIdx = type === 'folder' ? -1 : name.lastIndexOf('.')
    if (dotIdx > 0) {
      setTimeout(() => { if (renameInput) { renameInput.focus(); renameInput.setSelectionRange(0, dotIdx) } }, 50)
    } else {
      setTimeout(() => { if (renameInput) { renameInput.focus(); renameInput.select() } }, 50)
    }
  }
  if (renameModal) renameModal.classList.remove('hidden')
}

async function createNewItem(source, parentPath, type, name) {
  const tgt = state.renameTarget || {}
  try {
    let result
    if (source === 'local') {
      if (type === 'folder') {
        result = await _api.createLocalFolder(parentPath, name)
      } else {
        result = await _api.createLocalFile(parentPath, name, type)
      }
      if (!result.success) throw new Error(result.error)
      if (typeof tgt.wbRefresh === 'function') tgt.wbRefresh()
      else {
        await loadLocalDirectory(state.localPath)
        // 滚动到底部，让新文件可见
        setTimeout(() => { if (localFileList) localFileList.scrollTop = localFileList.scrollHeight }, 100)
      }
    } else {
      const devId = tgt.deviceId || state.connectedDeviceId
      if (!devId) throw new Error('未连接远程设备')
      const sep = parentPath.endsWith('\\') || parentPath.endsWith('/') ? '' : '\\'
      const newPath = parentPath + sep + name
      if (type === 'folder') {
        result = await _api.createRemoteFolder(devId, newPath)
      } else {
        result = await _api.createRemoteFile(devId, newPath, type)
      }
      if (!result.success) throw new Error(result.error)
      if (typeof tgt.wbRefresh === 'function') tgt.wbRefresh()
      else {
        await refreshRemoteDirectory()
        setTimeout(() => { if (remoteFileList) remoteFileList.scrollTop = remoteFileList.scrollHeight }, 100)
      }
    }
    showToast(`已创建 ${name}`, 'success')
  } catch (err) {
    showToast(`创建失败: ${err.message}`, 'error')
  }
}

// === 拖拽 ===
// 从 dataTransfer 提取外部拖入的文件路径（Electron 中 file.path 为绝对路径）
function getExternalDroppedPaths(dataTransfer) {
  const paths = []
  const files = dataTransfer.files
  if (!files || files.length === 0) return paths
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (!f.path) continue
    let isDir = false
    const item = dataTransfer.items && dataTransfer.items[i]
    if (item && item.webkitGetAsEntry) {
      try { const entry = item.webkitGetAsEntry(); if (entry && entry.isDirectory) isDir = true } catch {}
    }
    paths.push({ path: f.path, isDir })
  }
  return paths
}

function setupDragDrop() {
  // 拖拽到远程面板 = 上传（内部本地拖入 或 外部桌面拖入）
  const remotePanel = document.querySelector('.remote-panel')
  if (remotePanel) {
    remotePanel.addEventListener('dragover', (e) => {
      if (state.connectedDeviceId && state.remotePath && state.remotePath !== 'root') {
        e.preventDefault()
        remotePanel.classList.add('drag-over')
      }
    })
    remotePanel.addEventListener('dragleave', () => {
      remotePanel.classList.remove('drag-over')
    })
    remotePanel.addEventListener('drop', async (e) => {
      e.preventDefault()
      remotePanel.classList.remove('drag-over')
      if (!state.connectedDeviceId || !state.remotePath || state.remotePath === 'root') return

      // 外部文件拖入 → 上传到远程
      const extPaths = getExternalDroppedPaths(e.dataTransfer)
      if (extPaths.length > 0) {
        showToast(`正在上传 ${extPaths.length} 项到远程...`, 'info')
        for (const p of extPaths) {
          await uploadFile(p.path, p.isDir)
        }
        return
      }

      // 内部本地拖入 → 上传
      const data = e.dataTransfer.getData('application/json')
      if (data) {
        try {
          const parsed = JSON.parse(data)
          if (parsed.source === 'local' && parsed.items) {
            for (const item of parsed.items) {
              await uploadFile(item.path, item.isDir)
            }
          }
        } catch {}
      }
    })
  }

  // 拖拽到本地面板 = 下载（远程拖入）或 复制（外部桌面拖入）
  const localPanel = document.querySelector('.local-panel')
  if (localPanel) {
    localPanel.addEventListener('dragover', (e) => {
      const hasExternal = e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')
      if (state.connectedDeviceId || hasExternal) {
        e.preventDefault()
        localPanel.classList.add('drag-over')
      }
    })
    localPanel.addEventListener('dragleave', () => {
      localPanel.classList.remove('drag-over')
    })
    localPanel.addEventListener('drop', async (e) => {
      e.preventDefault()
      localPanel.classList.remove('drag-over')
      // 标记远程拖入已被本地面板接收，dragend 不再触发下载到桌面
      state.remoteDragConsumed = true

      // 拖到某个本地文件夹上则以其为目标，否则用当前目录
      const folderItem = e.target.closest('.file-item.folder')
      let destDir = folderItem && folderItem.dataset.path ? folderItem.dataset.path : state.localPath
      if (!destDir || destDir === 'root') return

      // 外部文件拖入 → 复制到本地目录
      const extPaths = getExternalDroppedPaths(e.dataTransfer)
      if (extPaths.length > 0) {
        showToast(`正在复制 ${extPaths.length} 项到 ${destDir}`, 'info')
        for (const p of extPaths) {
          try {
            const r = await _api.copyToLocal(p.path, destDir)
            if (!r.success) showToast(`复制失败: ${r.error}`, 'error')
          } catch (err) {
            showToast(`复制失败: ${err.message}`, 'error')
          }
        }
        await loadLocalDirectory(state.localPath)
        showToast('复制完成', 'success')
        return
      }

      // 内部拖入
      const data = e.dataTransfer.getData('application/json')
      if (data) {
        try {
          const parsed = JSON.parse(data)
          if (parsed.source === 'local') return // 本地拖到本地不处理
          // 远程拖到本地 = 下载
          if (parsed.items) {
            showToast(`下载到: ${destDir}`, 'info')
            for (const item of parsed.items) {
              await downloadFile(item.path, item.isDir, destDir)
            }
          }
        } catch {}
      }
    })
  }

  // 全局阻止默认拖放
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())
}

// === 快捷键 ===
function handleKeyDown(e) {
  // 输入法组合中不处理快捷键，避免干扰中文输入
  if (e.isComposing || e.keyCode === 229) return

  // 在输入框中不触发快捷键（除了 Esc）
  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT'

  // Esc：关闭弹窗/取消选择
  if (e.key === 'Escape') {
    const pttModal = $('pttModal')
    if (pttModal && !pttModal.classList.contains('hidden')) {
      pttModal.classList.add('hidden')
      return
    }
    if (renameModal && !renameModal.classList.contains('hidden')) {
      renameModal.classList.add('hidden')
      return
    }
    if (pairRequestModal && !pairRequestModal.classList.contains('hidden')) {
      return
    }
    hideContextMenu()
    state.localSelected.clear()
    state.remoteSelected.clear()
    renderLocalFileList(state.localEntries)
    renderRemoteFileList(state.remoteEntries)
    return
  }

  if (inInput) return

  // 判断焦点在哪个面板
  const focusedPanel = document.activeElement && document.activeElement.closest
    ? (document.activeElement.closest('.local-panel') ? 'local' : (document.activeElement.closest('.remote-panel') ? 'remote' : null))
    : null

  // 用 hover 状态判断当前面板
  const hoveredLocal = document.querySelector('.local-panel:hover')
  const hoveredRemote = document.querySelector('.remote-panel:hover')
  const activePanel = hoveredLocal ? 'local' : (hoveredRemote ? 'remote' : focusedPanel)

  // Ctrl+A 全选
  if (e.ctrlKey && e.key === 'a') {
    e.preventDefault()
    if (activePanel === 'local') {
      state.localSelected.clear()
      state.localEntries.forEach(entry => state.localSelected.add(entry.path))
      renderLocalFileList(state.localEntries)
    } else if (activePanel === 'remote') {
      state.remoteSelected.clear()
      state.remoteEntries.forEach(entry => state.remoteSelected.add(entry.path))
      renderRemoteFileList(state.remoteEntries)
    }
    return
  }

  // Delete 删除
  if (e.key === 'Delete') {
    if (activePanel === 'local' && state.localSelected.size > 0) {
      e.preventDefault()
      deleteSelectedLocal()
    } else if (activePanel === 'remote' && state.remoteSelected.size > 0 && state.connectedDeviceId) {
      e.preventDefault()
      deleteSelectedRemote()
    }
    return
  }

  // F2 重命名
  if (e.key === 'F2') {
    if (activePanel === 'local' && state.localSelected.size === 1) {
      e.preventDefault()
      const item = state.localEntries.find(e => state.localSelected.has(e.path))
      if (item) showRenameModal(item.path, item.name, 'local')
    } else if (activePanel === 'remote' && state.remoteSelected.size === 1 && state.connectedDeviceId) {
      e.preventDefault()
      const item = state.remoteEntries.find(e => state.remoteSelected.has(e.path))
      if (item) showRenameModal(item.path, item.name, 'remote')
    }
    return
  }

  // Backspace 上级目录
  if (e.key === 'Backspace') {
    if (activePanel === 'local') {
      e.preventDefault()
      navigateUp('local')
    } else if (activePanel === 'remote' && state.connectedDeviceId) {
      e.preventDefault()
      navigateUp('remote')
    }
    return
  }

  // F5 刷新
  if (e.key === 'F5') {
    e.preventDefault()
    if (activePanel === 'local') loadLocalDirectory(state.localPath)
    else if (activePanel === 'remote' && state.connectedDeviceId) refreshRemoteDirectory()
    return
  }

  // Ctrl+C 复制
  if (e.ctrlKey && e.key === 'c') {
    if (activePanel === 'local' && state.localSelected.size > 0) {
      e.preventDefault()
      copySelected('local')
    } else if (activePanel === 'remote' && state.remoteSelected.size > 0 && state.connectedDeviceId) {
      e.preventDefault()
      copySelected('remote')
    }
    return
  }

  // Ctrl+X 剪切
  if (e.ctrlKey && e.key === 'x') {
    if (activePanel === 'local' && state.localSelected.size > 0) {
      e.preventDefault()
      cutSelected('local')
    } else if (activePanel === 'remote' && state.remoteSelected.size > 0 && state.connectedDeviceId) {
      e.preventDefault()
      cutSelected('remote')
    }
    return
  }

  // Ctrl+V 粘贴
  if (e.ctrlKey && e.key === 'v') {
    if (activePanel) {
      e.preventDefault()
      pasteToPanel(activePanel)
    }
    return
  }
}

// 批量删除本地选中
async function deleteSelectedLocal() {
  const items = getSelectedLocalItems()
  if (items.length === 0) return
  if (!confirm(`确定要删除选中的 ${items.length} 个项目吗？此操作不可撤销。`)) return
  let ok = 0, fail = 0
  for (const item of items) {
    try {
      const result = await _api.deleteLocalFile(item.path)
      if (result.success) ok++
      else fail++
    } catch { fail++ }
  }
  state.localSelected.clear()
  await loadLocalDirectory(state.localPath)
  showToast(`删除完成: 成功 ${ok} 个${fail > 0 ? '，失败 ' + fail + ' 个' : ''}`, fail > 0 ? 'info' : 'success')
}

// 批量删除远程选中
async function deleteSelectedRemote() {
  const items = getSelectedRemoteItems()
  if (items.length === 0) return
  if (!confirm(`确定要删除选中的 ${items.length} 个项目吗？`)) return
  let ok = 0, fail = 0
  for (const item of items) {
    try {
      await _api.deleteRemoteFile(state.connectedDeviceId, item.path)
      ok++
    } catch { fail++ }
  }
  state.remoteSelected.clear()
  await refreshRemoteDirectory()
  showToast(`删除完成: 成功 ${ok} 个${fail > 0 ? '，失败 ' + fail + ' 个' : ''}`, fail > 0 ? 'info' : 'success')
}

// === 复制 / 剪切 / 粘贴 ===
function copySelected(source) {
  const items = source === 'local' ? getSelectedLocalItems() : getSelectedRemoteItems()
  if (items.length === 0) { showToast('请先选择文件', 'info'); return }
  state.clipboard = { source, items: items.map(i => ({ path: i.path, isDir: i.isDirectory })), cut: false }
  showToast(`已复制 ${items.length} 项`, 'success')
}

function cutSelected(source) {
  const items = source === 'local' ? getSelectedLocalItems() : getSelectedRemoteItems()
  if (items.length === 0) { showToast('请先选择文件', 'info'); return }
  state.clipboard = { source, items: items.map(i => ({ path: i.path, isDir: i.isDirectory })), cut: true }
  showToast(`已剪切 ${items.length} 项`, 'success')
}

async function pasteToPanel(targetPanel) {
  const clip = state.clipboard
  if (!clip || !clip.items || clip.items.length === 0) { showToast('剪贴板为空', 'info'); return }

  // 确定目标目录
  let destDir
  if (targetPanel === 'local') {
    if (!state.localPath || state.localPath === 'root') { showToast('请先进入本地某个目录', 'error'); return }
    destDir = state.localPath
  } else {
    if (!state.connectedDeviceId) { showToast('未连接远程设备', 'error'); return }
    if (!state.remotePath || state.remotePath === 'root') { showToast('请先进入远程某个目录', 'error'); return }
    destDir = state.remotePath
  }

  const isSameDevice = clip.source === targetPanel
  const itemCount = clip.items.length

  if (isSameDevice) {
    // 同设备：复制（或剪切=移动）
    showToast(`正在${clip.cut ? '移动' : '复制'} ${itemCount} 项...`, 'info')
    let ok = 0, fail = 0
    for (const item of clip.items) {
      try {
        if (clip.source === 'local') {
          // 本地→本地：用 copyToLocal 复制
          const r = await _api.copyToLocal(item.path, destDir)
          if (!r.success) throw new Error(r.error)
          // 剪切：复制后删除源
          if (clip.cut && r.path !== item.path) {
            const d = await _api.deleteLocalFile(item.path)
            if (!d.success) throw new Error(d.error)
          }
        } else {
          // 远程→远程：通过 TCP 消息在远程设备上复制/移动
          if (clip.cut) {
            const r = await _api.moveRemoteFile(state.connectedDeviceId, item.path, destDir)
            if (!r.success) throw new Error(r.error)
          } else {
            const r = await _api.copyRemoteFile(state.connectedDeviceId, item.path, destDir)
            if (!r.success) throw new Error(r.error)
          }
        }
        ok++
      } catch (err) { fail++; showToast(err.message, 'error') }
    }
    showToast(`${clip.cut ? '移动' : '复制'}完成: 成功 ${ok}${fail > 0 ? '，失败 ' + fail : ''}`, fail > 0 ? 'info' : 'success')
    if (clip.source === 'local') await loadLocalDirectory(state.localPath)
    else await refreshRemoteDirectory()
  } else {
    // 跨设备：上传或下载
    let ok = 0, fail = 0
    const succeededItems = []
    if (clip.source === 'local' && targetPanel === 'remote') {
      showToast(`正在上传 ${itemCount} 项到远程...`, 'info')
      for (const item of clip.items) {
        try { await uploadFile(item.path, item.isDir); ok++; succeededItems.push(item) } catch (err) { fail++; showToast(`上传失败: ${err.message}`, 'error') }
      }
      // 剪切：上传成功后删除本地源
      if (clip.cut) {
        for (const item of succeededItems) {
          try { await _api.deleteLocalFile(item.path) } catch {}
        }
        await loadLocalDirectory(state.localPath)
      }
    } else if (clip.source === 'remote' && targetPanel === 'local') {
      showToast(`正在下载 ${itemCount} 项到本地...`, 'info')
      for (const item of clip.items) {
        try { await downloadFile(item.path, item.isDir, destDir); ok++; succeededItems.push(item) } catch (err) { fail++; showToast(`下载失败: ${err.message}`, 'error') }
      }
      // 剪切：下载成功后删除远程源
      if (clip.cut) {
        for (const item of succeededItems) {
          try { await _api.deleteRemoteFile(state.connectedDeviceId, item.path) } catch {}
        }
        await refreshRemoteDirectory()
      }
    }
    if (fail > 0) showToast(`完成: 成功 ${ok}，失败 ${fail}`, 'info')
  }

  // 剪切粘贴后清空剪贴板
  if (clip.cut) {
    state.clipboard = { source: null, items: [], cut: false }
  }
}

// 工作台文件夹网格的粘贴（v2.4.71）：复用全局剪贴板；同设备复制/移动 + 跨设备上传/下载
async function wbPasteTo(destDir, originItem, refresh) {
  const clip = state.clipboard
  if (!clip || !clip.items || !clip.items.length) { showToast('剪贴板为空', 'info'); return }
  if (!destDir || destDir === 'root') { showToast('请先进入具体目录', 'error'); return }
  const origin = originItem.origin
  const clipDevice = clip.deviceId || (clip.source === 'remote' ? state.connectedDeviceId : null)
  if (clip.source === origin) {
    // 同设备：复制（剪切=移动）
    let okN = 0, failN = 0
    for (const it of clip.items) {
      try {
        if (origin === 'local') {
          const r = await _api.copyToLocal(it.path, destDir)
          if (!r.success) throw new Error(r.error)
          if (clip.cut && r.path !== it.path) {
            const d = await _api.deleteLocalFile(it.path)
            if (!d.success) throw new Error(d.error)
          }
        } else {
          if (!clipDevice) throw new Error('未知来源设备')
          const r = clip.cut
            ? await _api.moveRemoteFile(clipDevice, it.path, destDir)
            : await _api.copyRemoteFile(clipDevice, it.path, destDir)
          if (!r.success) throw new Error(r.error)
        }
        okN++
      } catch (err) { failN++; showToast(err.message, 'error') }
    }
    showToast(`${clip.cut ? '移动' : '复制'}完成: 成功 ${okN}${failN ? '，失败 ' + failN : ''}`, failN ? 'info' : 'success')
  } else if (clip.source === 'local' && origin !== 'local') {
    // 本机 → 远程设备目录（上传）
    let okN = 0, failN = 0
    for (const it of clip.items) {
      try {
        if (it.isDir) {
          const r = await _api.uploadFolder(origin, it.path, destDir)
          if (!r.success) throw new Error(r.error)
        } else {
          const tid = 'wb-ul-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
          state.transfers.set(tid, { id: tid, name: String(it.path).split('\\').pop() || it.path, direction: 'upload', status: 'uploading', progress: 0, size: 0 })
          renderTransfers()
          await _api.uploadFile(origin, it.path, destDir, tid)
        }
        okN++
      } catch (err) { failN++; showToast(err.message, 'error') }
    }
    showToast(`上传完成: 成功 ${okN}${failN ? '，失败 ' + failN : ''}`, failN ? 'info' : 'success')
  } else if (clip.source === 'remote' && origin === 'local') {
    // 远程设备 → 本机目录（下载）
    let okN = 0, failN = 0
    for (const it of clip.items) {
      try { await downloadFile(it.path, it.isDir, destDir); okN++ } catch (err) { failN++; showToast(err.message, 'error') }
    }
    showToast(`下载完成: 成功 ${okN}${failN ? '，失败 ' + failN : ''}`, failN ? 'info' : 'success')
  } else {
    showToast('该剪贴板内容无法粘贴到此处', 'info')
    return
  }
  if (clip.cut) state.clipboard = { source: null, items: [], cut: false }
  if (typeof refresh === 'function') refresh()
}

// === 下载目录 ===
async function changeDownloadDir() {
  try {
    const folder = await _api.selectFolder()
    if (!folder) return
    state.defaultDownloadDir = folder
    await _api.setSetting('defaultDownloadDir', folder)
    updateDownloadDirDisplay()
    showToast(`下载目录已设为: ${folder}`, 'success')
  } catch (err) {
    showToast('更改下载目录失败', 'error')
  }
}

async function openDownloadFolder() {
  try {
    const dir = state.defaultDownloadDir
    if (!dir) {
      showToast('请先设置下载目录', 'error')
      return
    }
    await _api.openFile(dir)
  } catch (err) {
    showToast('打开文件夹失败', 'error')
  }
}

function updateDownloadDirDisplay() {
  const el = $('downloadDirDisplay')
  if (el && state.defaultDownloadDir) {
    // 显示目录名，鼠标悬停看完整路径
    const name = state.defaultDownloadDir.split(/[\\/]/).pop() || state.defaultDownloadDir
    el.textContent = name
    el.title = state.defaultDownloadDir
  }
}

// === 对讲机（PTT） ===
const ptt = {
  talking: false,
  hotkey: '',
  pendingHotkey: '',
  volume: 100, // 接收音量（%），最大 200 超增益
  // 麦克风采集
  workletAdded: false,
  micStream: null, micCtx: null, workletNode: null, sourceNode: null,
  // 播放
  playCtx: null, playGain: null, incoming: null,
}

// 音频采集 worklet：累积 40ms 采样后以 Float32Array 发出
const PTT_WORKLET = `
class PTTCapture extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Float32Array(8192); this._len = 0; this._chunk = Math.max(128, Math.round(sampleRate * 0.04)) }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._len++] = ch[i]
        if (this._len >= this._chunk) {
          this.port.postMessage(this._buf.slice(0, this._len))
          this._len = 0
        }
      }
    }
    return true
  }
}
registerProcessor('ptt-capture', PTTCapture)
`

async function initPTT() {
  try { ptt.hotkey = (await _api.getPTTHotkey()) || '' } catch { }
  try {
    const v = parseInt(await _api.getSetting('pttVolume'), 10)
    if (!isNaN(v) && v >= 0 && v <= 200) ptt.volume = v
  } catch { }
  updatePTTHotkeyHint()
  updatePTTButton()

  if (_api.onPTTHotkeyDown) _api.onPTTHotkeyDown(() => startTalking(true))
  if (_api.onPTTHotkeyUp) _api.onPTTHotkeyUp(() => stopTalking(true))
  if (_api.onPTTIncomingStart) _api.onPTTIncomingStart(onPTTIncomingStart)
  if (_api.onPTTIncomingChunk) _api.onPTTIncomingChunk(onPTTIncomingChunk)
  if (_api.onPTTIncomingEnd) _api.onPTTIncomingEnd(onPTTIncomingEnd)
}

function updatePTTButton() {
  const btn = $('pttBtn')
  if (btn) btn.disabled = !state.connectedDeviceId
}

function updatePTTHotkeyHint() {
  const hint = $('pttHotkeyHint')
  if (hint) hint.innerHTML = `${iconSvg('mic')} ${ptt.hotkey ? ptt.hotkey + ' ' : ''}对讲`.replace('  ', ' ')
  const btn = $('pttBtn')
  if (btn) btn.title = ptt.hotkey
    ? `按住喊话，松开结束（热键 ${ptt.hotkey}）；右键设置热键`
    : '按住对当前设备喊话，右键设置热键'
}

// 请求麦克风并启动采集（首次调用会请求麦克风权限）
// AudioContext 和 AudioWorkletNode 全程复用：每次会话新建 worklet 会在 Chromium 中
// 残留僵尸处理器，逐次累积拖垮音频线程，表现为说话次数越多越卡
async function ensureMic() {
  if (ptt.micStream && ptt.micCtx && ptt.sourceNode) return
  if (!ptt.micCtx) ptt.micCtx = createPTTContext()
  await ptt.micCtx.resume()
  // 设备可能处于上一次会话的释放过程中，重试获取
  let stream = null
  let lastErr = null
  for (let i = 0; i < 3 && !stream; i++) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      })
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 200))
    }
  }
  if (!stream) throw lastErr || new Error('无法获取麦克风')
  ptt.micStream = stream
  if (!ptt.workletNode) {
    if (!ptt.workletAdded) {
      const blobUrl = URL.createObjectURL(new Blob([PTT_WORKLET], { type: 'application/javascript' }))
      await ptt.micCtx.audioWorklet.addModule(blobUrl)
      URL.revokeObjectURL(blobUrl)
      ptt.workletAdded = true
    }
    const node = new AudioWorkletNode(ptt.micCtx, 'ptt-capture')
    node.port.onmessage = (e) => sendAudioChunk(e.data)
    ptt.workletNode = node
  }
  const src = ptt.micCtx.createMediaStreamSource(stream)
  src.connect(ptt.workletNode) // 只采集，不连扬声器，避免回授
  ptt.sourceNode = src
}

// 释放麦克风（松开按键后停止采集，保护隐私；worklet 与上下文保留复用）
function releaseMic() {
  try { if (ptt.micStream) ptt.micStream.getTracks().forEach(t => t.stop()) } catch { }
  try { if (ptt.sourceNode) ptt.sourceNode.disconnect() } catch { }
  ptt.micStream = null
  ptt.sourceNode = null
}

let pttSession = 0

// 开始喊话（viaHotkey: 热键触发时鼠标抬起不会误停）
async function startTalking(viaHotkey) {
  if (!state.connectedDeviceId) {
    if (document.visibilityState === 'visible') showToast('请先连接设备再对讲', 'info')
    return
  }
  if (ptt.talking) return
  // 同步占位：必须在任何 await 之前置位。否则热键+按钮（或连续触发）并发重入时，
  // 会同时打开多路麦克风叠加发送，对方听到的声音逐次增大直至破音
  ptt.talking = true
  const session = ++pttSession
  const btn = $('pttBtn')
  try {
    updateStatus('正在打开麦克风...', 'busy')
    await ensureMic()
    if (session !== pttSession) { releaseMic(); return } // 等待期间已松开：关掉刚打开的麦克风
    duckIncoming(true) // 半双工：喊话时静音本端接收，防外放回音
    const ok = await _api.pttStart(state.connectedDeviceId, ptt.micCtx.sampleRate)
    if (session !== pttSession) {
      // 等待 pttStart 期间已松开：撤回刚发出的 audio-start，避免状态残留
      if (ok) { try { _api.pttStop(state.connectedDeviceId) } catch { } }
      return
    }
    if (!ok) {
      showToast('喊话失败，设备可能已断开', 'error')
      ptt.talking = false; ptt.hotkeyTalking = false
      duckIncoming(false)
      releaseMic()
      updateStatus('就绪', 'ready')
      return
    }
    if (btn) btn.classList.add('ptt-active')
    updateStatus('正在喊话...', 'busy')
  } catch (err) {
    showToast('麦克风不可用: ' + (err && err.message ? err.message : err), 'error')
    ptt.talking = false; ptt.hotkeyTalking = false
    duckIncoming(false)
    releaseMic()
    updateStatus('就绪', 'ready')
  }
}

function stopTalking(viaHotkey) {
  if (viaHotkey) ptt.hotkeyTalking = false
  pttSession++
  if (!ptt.talking) return
  ptt.talking = false
  try { if (state.connectedDeviceId) _api.pttStop(state.connectedDeviceId) } catch { }
  const btn = $('pttBtn')
  if (btn) btn.classList.remove('ptt-active')
  duckIncoming(false) // 恢复接收音量
  releaseMic()
  updateStatus('就绪', 'ready')
}

function sendAudioChunk(f32) {
  if (!ptt.talking || !state.connectedDeviceId) return
  const i16 = f32ToInt16(f32)
  const b64 = bufToB64(i16.buffer)
  try { _api.pttChunk(state.connectedDeviceId, b64) } catch { }
}

// 创建固定 48000Hz 的音频上下文：采样率恒定，避免系统改麦克风音量/格式后
// 设备重启导致收发采样率不一致（对方听到慢放/卡顿）
function createPTTContext() {
  try {
    return new AudioContext({ sampleRate: 48000 })
  } catch {
    return new AudioContext()
  }
}

// === 接收并播放对方喊话 ===
function ensurePlayCtx() {
  if (!ptt.playCtx) {
    ptt.playCtx = createPTTContext()
    // 主音量节点：100% 为数字满幅，超 100% 为超增益放大
    ptt.playGain = ptt.playCtx.createGain()
    ptt.playGain.gain.value = ptt.volume / 100
    ptt.playGain.connect(ptt.playCtx.destination)
  }
  if (ptt.playCtx.state === 'suspended') ptt.playCtx.resume().catch(() => { })
  return ptt.playCtx
}

function applyPTTVolume() {
  if (ptt.playGain) {
    ptt.playGain.gain.value = ptt.volume / 100
  }
}

// 半双工回声抑制：本端喊话时静音本端接收播放，切断"对方音箱→本端麦克风→回传"的回音路径
function duckIncoming(duck) {
  if (!ptt.playGain) return
  ptt.playGain.gain.value = duck ? 0 : (ptt.volume / 100)
}

function onPTTIncomingStart(data) {
  const ctx = ensurePlayCtx()
  ptt.incoming = { deviceId: data.deviceId, name: data.name || '对方', sampleRate: data.sampleRate || 48000, nextTime: 0 }
  if (ptt.talking) duckIncoming(true) // 本端正在喊话时保持静音（双方同时按住的场景）
  const bar = $('pttIncomingBar')
  if (bar) {
    const nameEl = $('pttIncomingName')
    if (nameEl) nameEl.textContent = ptt.incoming.name
    bar.classList.remove('hidden')
  }
  playDing(880, ctx)
}

function onPTTIncomingChunk(data) {
  if (!ptt.incoming || !ptt.playCtx || !data.b64) return
  try {
    const i16 = new Int16Array(b64ToBuf(data.b64))
    if (i16.length === 0) return
    const f32 = new Float32Array(i16.length)
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
    const ctx = ptt.playCtx
    const buf = ctx.createBuffer(1, f32.length, ptt.incoming.sampleRate)
    buf.getChannelData(0).set(f32)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ptt.playGain)
    const now = ctx.currentTime
    // 抖动缓冲调度：仅在首包/缓冲耗尽时垫底恢复，绝不丢弃已缓冲音频强制跳时间
    if (!ptt.incoming.nextTime) {
      ptt.incoming.nextTime = now + 0.06 // 首包垫 60ms
    } else if (ptt.incoming.nextTime < now) {
      ptt.incoming.nextTime = now + 0.02 // 缓冲耗尽才快速恢复
    } else if (ptt.incoming.nextTime > now + 0.5) {
      ptt.incoming.nextTime = now + 0.06 // 异常积压保护
    }
    src.start(ptt.incoming.nextTime)
    ptt.incoming.nextTime += buf.duration
    src.onended = () => { try { src.disconnect() } catch { } } // 及时回收节点
  } catch { }
}

function onPTTIncomingEnd() {
  if (!ptt.incoming) return
  const drainMs = ptt.playCtx ? Math.max(0, (ptt.incoming.nextTime - ptt.playCtx.currentTime) * 1000) : 0
  ptt.incoming = null
  setTimeout(() => {
    if (!ptt.incoming) {
      const bar = $('pttIncomingBar')
      if (bar) bar.classList.add('hidden')
    }
  }, drainMs + 100)
}

function playDing(freq, ctx) {
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.12, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
    osc.connect(gain); gain.connect(ptt.playGain)
    osc.start()
    osc.stop(ctx.currentTime + 0.16)
  } catch { }
}

// === 音频编码工具 ===
function f32ToInt16(f32) {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return out
}

function bufToB64(buffer) {
  const bytes = new Uint8Array(buffer)
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)))
  }
  return btoa(bin)
}

function b64ToBuf(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

// === 对讲机设置弹窗 ===
async function openPttModal() {
  try { ptt.hotkey = (await _api.getPTTHotkey()) || '' } catch { }
  try {
    const v = parseInt(await _api.getSetting('pttVolume'), 10)
    if (!isNaN(v) && v >= 0 && v <= 200) ptt.volume = v
  } catch { }
  ptt.pendingHotkey = ptt.hotkey
  resetHotkeyRecorder()
  const inp = $('pttHotkeyInput')
  if (inp) inp.value = ptt.hotkey || '（未设置，仅用按钮对讲）'
  const slider = $('pttVolumeSlider')
  const label = $('pttVolumeLabel')
  if (slider) slider.value = ptt.volume
  if (label) label.textContent = `${ptt.volume}%`
  const m = $('pttModal')
  if (m) m.classList.remove('hidden')
}

// 区分左右边的修饰键：可单独作为热键（如右Ctrl）
const PTT_MOD_CODES = {
  ControlLeft: 'LCtrl', ControlRight: 'RCtrl',
  AltLeft: 'LAlt', AltRight: 'RAlt',
  ShiftLeft: 'LShift', ShiftRight: 'RShift',
  MetaLeft: 'Super', MetaRight: 'RSuper'
}
const PTT_STANDALONE_OK = ['RCtrl', 'LCtrl', 'RAlt', 'LAlt', 'RShift', 'LShift']

function recordHotkeyInput(e) {
  e.preventDefault()
  e.stopPropagation()
  const inp = $('pttHotkeyInput')
  if (!inp) return
  if (!ptt.recHeld) ptt.recHeld = []

  if (e.type === 'keyup') {
    // 松开：若全程只按了一个可单用的修饰键，则接受为单键热键
    ptt.recHeld = ptt.recHeld.filter(c => c !== e.code)
    if (ptt.recHeld.length === 0 && !ptt.recCaptured && ptt.recHeldLast && PTT_STANDALONE_OK.includes(ptt.recHeldLast)) {
      ptt.pendingHotkey = ptt.recHeldLast
      inp.value = ptt.recHeldLast
    }
    return
  }

  // Escape 取消录制，恢复原值
  if (e.key === 'Escape') {
    ptt.recHeld = []
    ptt.recCaptured = null
    ptt.recHeldLast = null
    inp.value = ptt.pendingHotkey || '（未设置，仅用按钮对讲）'
    return
  }

  // 修饰键：记入按住列表，可继续组合
  if (PTT_MOD_CODES[e.code]) {
    if (!ptt.recHeld.includes(e.code)) ptt.recHeld.push(e.code)
    ptt.recHeldLast = PTT_MOD_CODES[e.code]
    inp.value = `${ptt.recHeldLast}（松开即设为单键，或继续按住加其他键）`
    return
  }

  // 主键：组装组合键
  const parts = []
  for (const code of ptt.recHeld) {
    const name = PTT_MOD_CODES[code]
    if (name && !parts.includes(name)) parts.push(name)
  }
  if (e.ctrlKey && !parts.some(p => /CTRL$/i.test(p))) parts.push('Ctrl')
  if (e.altKey && !parts.some(p => /ALT$/i.test(p))) parts.push('Alt')
  if (e.shiftKey && !parts.some(p => /SHIFT$/i.test(p))) parts.push('Shift')
  if (e.metaKey && !parts.some(p => /SUPER/i.test(p))) parts.push('Super')

  const code = e.code
  let main = null
  if (/^Key[A-Z]$/.test(code)) main = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) main = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) main = 'Num' + code.slice(6)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) main = code
  else if (code === 'Space') main = 'Space'
  else if (code === 'Backquote') main = '`'
  else if (['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash'].includes(code)) {
    main = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' }[code]
  } else if (['Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Enter', 'Tab'].includes(code)) main = code
  else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) main = code.slice(5)
  if (!main) return
  parts.push(main)

  // 不限制按键：任意单键（含普通键）均可作为热键，由用户自行权衡
  ptt.recCaptured = parts.join('+')
  ptt.pendingHotkey = ptt.recCaptured
  inp.value = ptt.pendingHotkey
}

// 鼠标侧键录制：XBUTTON1/2 → Mouse4/Mouse5（可配合 Ctrl/Alt/Shift）
function recordHotkeyMouse(e) {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  e.stopPropagation()
  const inp = $('pttHotkeyInput')
  if (!inp) return
  const parts = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  parts.push(e.button === 3 ? 'Mouse4' : 'Mouse5')
  ptt.recCaptured = parts.join('+')
  ptt.pendingHotkey = ptt.recCaptured
  inp.value = ptt.pendingHotkey
}

function resetHotkeyRecorder() {
  ptt.recHeld = []
  ptt.recCaptured = null
  ptt.recHeldLast = null
}

async function savePttHotkey() {
  ptt.hotkey = ptt.pendingHotkey || ''
  try { await _api.setSetting('pttHotkey', ptt.hotkey) } catch { }
  const slider = $('pttVolumeSlider')
  if (slider) {
    const v = Math.max(0, Math.min(200, parseInt(slider.value, 10) || 100))
    ptt.volume = v
    try { await _api.setSetting('pttVolume', String(v)) } catch { }
  }
  applyPTTVolume()
  const m = $('pttModal')
  if (m) m.classList.add('hidden')
  updatePTTHotkeyHint()
  showToast(ptt.hotkey ? `对讲热键已保存: ${ptt.hotkey}（全局生效）` : '已清空对讲热键，仅可使用按钮对讲', 'success')
}

// === 工具函数 ===
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

// 更新本地磁盘空间显示
async function updateLocalDiskSpace() {
  const el = $('localDiskSpace')
  if (!el) return
  if (!state.localPath || state.localPath === 'root') { el.innerHTML = ''; return }
  try {
    const info = await _api.getDiskSpace(state.localPath)
    if (info && info.total) {
      el.innerHTML = `<span class="disk-free">${formatSize(info.free)} 可用</span> / 共 ${formatSize(info.total)}`
    } else {
      el.innerHTML = ''
    }
  } catch { el.innerHTML = '' }
}

// 更新远程磁盘空间显示
async function updateRemoteDiskSpace() {
  const el = $('remoteDiskSpace')
  if (!el) return
  if (!state.connectedDeviceId || !state.remotePath || state.remotePath === 'root') { el.innerHTML = ''; return }
  try {
    const info = await _api.getRemoteDiskSpace(state.connectedDeviceId, state.remotePath)
    if (info && info.total) {
      el.innerHTML = `<span class="disk-free">${formatSize(info.free)} 可用</span> / 共 ${formatSize(info.total)}`
    } else {
      el.innerHTML = ''
    }
  } catch { el.innerHTML = '' }
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  const iconMap = {
    'exe': 'app-window', 'dll': 'package', 'zip': 'archive', 'rar': 'archive', '7z': 'archive',
    'pdf': 'file-text', 'doc': 'file-text', 'docx': 'file-text', 'xls': 'table', 'xlsx': 'table',
    'ppt': 'presentation', 'pptx': 'presentation', 'txt': 'file-text', 'md': 'file-text',
    'jpg': 'image', 'jpeg': 'image', 'png': 'image', 'gif': 'image', 'bmp': 'image',
    'mp3': 'music', 'wav': 'music', 'flac': 'music',
    'mp4': 'video', 'avi': 'video', 'mkv': 'video', 'mov': 'video',
    'js': 'file-code', 'ts': 'file-code', 'html': 'file-code', 'css': 'file-code', 'py': 'file-code',
    'json': 'file-code', 'xml': 'file-code', 'sql': 'file-code',
  }
  return iconSvg(iconMap[ext] || 'file-text')
}

function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

