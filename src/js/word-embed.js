// ============================================
// WPS/Word 内嵌 + 通用网页页签渲染层（从 app.js 拆出，v2.7.12 模块化）
// 依赖 app.js 全局环境，加载顺序必须在 app.js 之后、work.js 之前
// ============================================
// ===== WPS/Word 内嵌（实验性）：状态与生命周期 =====
// wbEmbed.alive=true 时该 docx 页签由外部程序窗口盖着：切走→HIDE，切回→SHOW，移除/换会话→CLOSE
let wbEmbed = { key: null, alive: false, pollTimer: null, ro: null }
let wbDocxForceBuiltin = new Set() // 用户点「内置编辑」的单次豁免（按文件路径）
function wbEmbedKill() {
  if (!wbEmbed.key) return
  _api.docxEmbedClose().catch(() => {})
  if (wbEmbed.pollTimer) clearInterval(wbEmbed.pollTimer)
  if (wbEmbed.ro) { try { wbEmbed.ro.disconnect() } catch {} }
  wbEmbed = { key: null, alive: false, pollTimer: null, ro: null }
}
function wbEmbedSync(key) {
  if (!wbEmbed.alive) return
  if (wbEmbed.key !== key) _api.docxEmbedHide().catch(() => {}) // 切到其它页签：藏起来（文档继续开着）
}

let wbSaveTimer = null
let wbPersistSid = null // 待写清单归属的会话（排程时锁定，防止切会话后写串）
function wbPersist() {
  wbPersistSid = work.active
  if (!wbPersistSid) return
  if (wbSaveTimer) clearTimeout(wbSaveTimer)
  wbSaveTimer = setTimeout(() => {
    wbSaveTimer = null
    if (work.active !== wbPersistSid) return // 会话已切走：旧清单绝不写进新会话
    try { _api.wbSet(wbPersistSid, { items: state.wbItems, navs: wbFolderNav }) } catch {}
  }, 300)
}

// 切会话/删会话前冲刷：待写清单立刻落到归属会话，不丢
async function wbPersistFlush() {
  if (!wbSaveTimer) return
  clearTimeout(wbSaveTimer)
  wbSaveTimer = null
  const sid = wbPersistSid
  if (!sid) return
  try { await _api.wbSet(sid, { items: state.wbItems, navs: wbFolderNav }) } catch {}
}

let wbLoadSeq = 0 // 加载序号：快速切会话时旧加载结果作废
async function loadWorkbench(sid) {
  const seq = ++wbLoadSeq
  let data = null
  try { data = (await _api.wbGet(sid)) || [] } catch {}
  if (seq !== wbLoadSeq) return
  // 兼容两代格式：旧=纯数组，新={items, navs}
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : [])
  state.wbItems = items
  wbActiveKey = null
  wbRenderedKey = null
  wbEditors = {} // 换会话清编辑态（未保存内容不跨会话带）
  wbGrids = {}
  // 文件夹浏览导航态跨重启恢复（位置记忆）；无则空
  wbFolderNav = (!Array.isArray(data) && data && data.navs && typeof data.navs === 'object') ? data.navs : {}
  // 本地来源项做存在性检查（远程项跨网络，不做即时检查；webapp 伪路径跳过）
  for (const it of state.wbItems) {
    if (it.kind === 'webapp' || it.kind === 'urltab') { it._missing = false; continue }
    if (it.origin !== 'local') { it._missing = false; continue }
    try { it._missing = !(await _api.fsExists(it.path)) } catch { it._missing = false }
  }
  if (seq !== wbLoadSeq) return
  wbEmbedKill() // 换会话：把内嵌的 WPS/Word 文档窗口收掉（那边有未保存会自己弹窗问）
  renderWorkbench()
}

function addToWorkbench(entries, origin, originName) {
  let added = 0
  for (const it of entries) {
    if (!it || !it.path) continue
    const key = origin + '|' + it.path
    if (state.wbItems.some(w => w.origin + '|' + w.path === key)) continue
    state.wbItems.push({
      path: it.path,
      name: it.name || String(it.path).split(/[\\/]/).filter(Boolean).pop() || it.path,
      isDir: !!it.isDir,
      size: it.size || 0,
      origin,
      originName: originName || (origin === 'local' ? '本机' : '远程设备'),
      _missing: false
    })
    added++
  }
  if (added) {
    // 自动切换到新加入的第一个文件预览
    const first = entries.find(it => it && it.path)
    if (first) {
      const key = (origin || 'local') + '|' + first.path
      if (state.wbItems.some(w => wbKey(w) === key)) wbActiveKey = key
    }
    renderWorkbench()
    wbPersist()
    showToast(`已加入工作台 ${added} 项`, 'success')
  } else {
    showToast('所选项目已在工作台中', 'info')
  }
}

// 把网页版模型（如 DeepSeek 网页版）作为常驻页签加入工作台：引擎在后台跑，不抢预览区视图
function addWebAppToWorkbench(web, activate = true) {
  const app = (typeof WbWebChat !== 'undefined' && WbWebChat.APPS[web]) || { name: web }
  const item = {
    kind: 'webapp', web,
    path: `webchat://${web}`,
    name: app.name || web,
    isDir: false, size: 0,
    origin: 'local', originName: '内嵌网页',
    _missing: false
  }
  const key = wbKey(item)
  if (!state.wbItems.some(w => wbKey(w) === key)) state.wbItems.push(item)
  if (activate) wbActiveKey = key
  wbRenderedKey = null
  renderWorkbench()
  wbPersist()
}

function addSelectionToWorkbench(source) {
  if (source === 'local') {
    const sel = getSelectedLocalItems()
    if (!sel.length) { showToast('请先在本地面板选中文件/文件夹', 'error'); return }
    const withSize = sel.map(it => {
      const e = state.localEntries.find(e => e.path === it.path)
      return { ...it, size: e ? e.size : 0 }
    })
    addToWorkbench(withSize, 'local', '本机')
  } else {
    if (!state.connectedDeviceId) { showToast('远程面板未连接设备', 'error'); return }
    const sel = getSelectedRemoteItems()
    if (!sel.length) { showToast('请先在远程面板选中文件/文件夹', 'error'); return }
    const devName = (state.connectedDeviceInfo && (state.connectedDeviceInfo.name || state.connectedDeviceInfo.hostname)) || '远程设备'
    const withSize = sel.map(it => {
      const e = state.remoteEntries.find(e => e.path === it.path)
      return { ...it, size: e ? e.size : 0 }
    })
    addToWorkbench(withSize, state.connectedDeviceId, devName)
  }
}

function addContextToWorkbench(source, target) {
  if (!target || !target.path) return
  if (source === 'local') {
    const sel = getSelectedLocalItems()
    const items = (sel.length && sel.some(s => s.path === target.path))
      ? sel
      : [{ path: target.path, name: target.name, isDir: target.isDirectory }]
    const withSize = items.map(it => {
      const e = state.localEntries.find(e => e.path === it.path)
      return { ...it, size: e ? e.size : 0 }
    })
    addToWorkbench(withSize, 'local', '本机')
  } else {
    if (!state.connectedDeviceId) return
    const sel = getSelectedRemoteItems()
    const items = (sel.length && sel.some(s => s.path === target.path))
      ? sel
      : [{ path: target.path, name: target.name, isDir: target.isDirectory }]
    const devName = (state.connectedDeviceInfo && (state.connectedDeviceInfo.name || state.connectedDeviceInfo.hostname)) || '远程设备'
    const withSize = items.map(it => {
      const e = state.remoteEntries.find(e => e.path === it.path)
      return { ...it, size: e ? e.size : 0 }
    })
    addToWorkbench(withSize, state.connectedDeviceId, devName)
  }
}

// === 工作台渲染：顶部标签页 + 内嵌预览/编辑区 ===
let wbActiveKey = null // 当前预览项 key = origin|path
let wbEditors = {} // key -> { saved, content, dirty, timer } 纯文本编辑态（切页保留）
let wbRenderedKey = null // 当前已渲染进预览区的 key（避免同项重复重渲染闪屏）
let wbFolderNav = {} // key -> { cwd, stack, sels, filter } 文件夹内嵌浏览器导航态
let wbGrids = {} // key -> { sheet, edits, dirty } Excel 网格编辑态（edits: {'r,c': value}）
let wbTabDragIdx = null // 标签拖动排序：被拖标签下标
let wbShellDirs = null // 快速访问目录缓存 { desktop, downloads, ... }

const wbKey = (it) => (it.origin || 'local') + '|' + it.path

function getWbActive() {
  return state.wbItems.find(w => wbKey(w) === wbActiveKey) || null
}

function renderWorkbench() {
  const tabs = $('wbTabs')
  if (!tabs) return
  const items = state.wbItems
  if ($('wbCount')) $('wbCount').textContent = String(items.length)
  const total = items.reduce((s, w) => s + (w.isDir ? 0 : (w.size || 0)), 0)
  if ($('wbStats')) $('wbStats').textContent = `${items.length} 项 · 共 ${formatSize(total)}`
  // 当前激活项被移除/清空时，自动落到最后一项
  if (!items.some(w => wbKey(w) === wbActiveKey)) {
    wbActiveKey = items.length ? wbKey(items[items.length - 1]) : null
  }
  tabs.innerHTML = ''
  state.wbItems.forEach((it, idx) => {
    const key = wbKey(it)
    const tab = document.createElement('div')
    tab.className = 'wb-tab' + (key === wbActiveKey ? ' active' : '') + (it._missing ? ' missing' : '')
    const ed = wbEditors[key]
    const grid = wbGrids[key]
    if ((ed && ed.dirty) || (grid && grid.dirty)) tab.classList.add('dirty')
    tab.title = `${it.name}\n${it.originName || '本机'}${it._missing ? '\n文件不存在' : ''}`
    tab.innerHTML = `<span class="wb-tab-icon">${it.kind === 'webapp' || it.kind === 'urltab' ? iconSvg('globe') : (it.isDir ? iconSvg('folder') : getFileIcon(it.name))}</span><span class="wb-tab-name">${escapeHtml(it.name)}</span>`
    const close = document.createElement('span')
    close.className = 'wb-tab-close'
    close.textContent = '×'
    close.title = '移出工作台（不删除文件本身）'
    close.addEventListener('click', (e) => { e.stopPropagation(); removeWbItem(it) })
    tab.appendChild(close)
    tab.addEventListener('click', () => {
      if (key === wbActiveKey) return
      wbActiveKey = key
      renderWorkbench()
    })
    // 中键直接关闭
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); removeWbItem(it) }
    })
    // 右键菜单（预览/引用/系统打开/重命名/复制路径/关闭/关闭其他）
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      openWbTabMenu(e.clientX, e.clientY, it)
    })
    tab.addEventListener('dragstart', (e) => {
      wbTabDragIdx = idx
      if (it.origin !== 'local') return
      e.dataTransfer.setData('application/json', JSON.stringify({
        source: 'local',
        items: [{ path: it.path, name: it.name, isDir: it.isDir }]
      }))
    })
    tabs.appendChild(tab)
  })
  const active = tabs.querySelector('.wb-tab.active')
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  renderWbView()
}

// 标签右键菜单
function closeWbTabMenu() {
  const old = document.querySelector('.wb-tab-menu')
  if (old) old.remove()
}

function openWbTabMenu(x, y, it) {
  closeWbTabMenu()
  const menu = document.createElement('div')
  menu.className = 'wb-tab-menu'
  const mkItems = [
    [iconSvg('eye') + ' 打开', () => { wbActiveKey = wbKey(it); renderWorkbench() }],
    [iconSvg('message-square') + ' 引用到 AI', () => wbAddRef(it)],
    [iconSvg('external-link') + ' 系统打开', () => {
      if (it._missing) return showToast('文件不存在', 'error')
      if (it.isDir) _api.openInExplorer(it.path).catch(() => {})
      else _api.openFile(it.path).catch(() => {})
    }],
    it.origin === 'local' && !it.isDir ? [iconSvg('square-pen') + ' 重命名', () => renameWbItem(it)] : null,
    [iconSvg('clipboard') + ' 复制路径', () => {
      navigator.clipboard.writeText(it.path).then(() => showToast('已复制路径', 'success')).catch(() => {})
    }],
    null,
    [iconSvg('x') + ' 关闭', () => removeWbItem(it), 'danger'],
    [iconSvg('x') + ' 关闭其他', () => closeOtherWbItems(it), 'danger']
  ]
  for (const item of mkItems) {
    if (!item) { const hr = document.createElement('div'); hr.style.cssText = 'height:1px;background:var(--border-light);margin:3px 6px'; menu.appendChild(hr); continue }
    const [label, fn, cls] = item
    const btn = document.createElement('button')
    btn.innerHTML = label // label 含 iconSvg 串，textContent 会显示源码（2.7.1 补修）
    if (cls) btn.className = cls
    btn.addEventListener('click', () => { closeWbTabMenu(); fn() })
    menu.appendChild(btn)
  }
  document.body.appendChild(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px'
}
document.addEventListener('click', closeWbTabMenu)
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest || !e.target.closest('.wb-tab')) closeWbTabMenu()
})

async function renameWbItem(it) {
  const newName = prompt('重命名为：', it.name)
  if (!newName || newName.trim() === it.name) return
  const clean = newName.trim()
  try {
    const r = await _api.renameLocalFile(it.path, clean)
    if (!r || r.success === false) { showToast((r && r.error) || '重命名失败', 'error'); return }
    const oldKey = wbKey(it)
    const idx = it.path.lastIndexOf('\\') >= 0 ? it.path.lastIndexOf('\\') : it.path.lastIndexOf('/')
    const newPath = it.path.slice(0, idx + 1) + clean
    delete wbEditors[oldKey]
    delete wbGrids[oldKey]
    delete wbFolderNav[oldKey]
    it.path = newPath
    it.name = clean
    if (wbActiveKey === oldKey) wbActiveKey = wbKey(it)
    renderWorkbench()
    wbPersist()
    showToast('已重命名', 'success')
  } catch (err) {
    showToast('重命名失败: ' + err.message, 'error')
  }
}

function closeOtherWbItems(keep) {
  const others = state.wbItems.filter(w => w !== keep)
  if (!others.length) return
  const dirtyCount = others.filter(w => {
    const k = wbKey(w)
    return (wbEditors[k] && wbEditors[k].dirty) || (wbGrids[k] && wbGrids[k].dirty)
  }).length
  const tip = dirtyCount
    ? `关闭其他 ${others.length} 个标签？${dirtyCount} 个文件有未保存的修改将丢失。`
    : `关闭其他 ${others.length} 个标签？文件本身不会被删除。`
  if (!confirm(tip)) return
  for (const w of others) {
    const k = wbKey(w)
    delete wbEditors[k]
    delete wbGrids[k]
    delete wbFolderNav[k]
  }
  state.wbItems = [keep]
  wbActiveKey = wbKey(keep)
  renderWorkbench()
  wbPersist()
}

// 新建文本文件/文件夹（F）：目标=当前正在浏览的本地文件夹，否则桌面
async function wbCreateEntry(isDir) {
  let dir = wbShellDirs ? wbShellDirs.desktop : null
  if (!dir) { showToast('正在初始化，稍后再试', 'info'); return }
  const it = getWbActive()
  if (it && it.isDir && it.origin === 'local') {
    const nav = wbFolderNav[wbKey(it)]
    if (nav && nav.cwd) dir = nav.cwd
  }
  const name = prompt(isDir ? '新文件夹名称：' : '新文本文件名称（如 笔记.txt / 计划.md）：')
  if (!name || !name.trim()) return
  const r = await _api.createWbEntry(dir, name.trim(), isDir).catch(() => null)
  if (r && r.success) {
    addToWorkbench([{ path: r.path, name: r.name, isDir }], 'local', '本机')
  } else {
    showToast((r && r.error) || '创建失败', 'error')
  }
}

// 预览区：按当前激活标签渲染（复用 wbRenderedKey 防重复闪屏）
// ===== 通用网页页签（AI open_url 打开的网址在工作台里看）：专属 webview 层管理 =====
const wbUrlViews = {} // key -> { el, wrap }
function ensureUrlView(key, url) {
  const host = document.getElementById('wbView')
  if (!host) return null
  let v = wbUrlViews[key]
  if (!v) {
    const wrap = document.createElement('div')
    wrap.className = 'wb-web-layer hidden'
    const el = document.createElement('webview')
    el.className = 'wb-web-view' // 必须挂样式：wb-web-layer 是 flex 列容器，无样式 webview 默认 150px 高 → 网页只占顶部一条
    el.setAttribute('src', url)
    // allowpopups 是布尔属性：存在即生效（写 "false" 也是开启！）。挂上后链接转跳统一走主进程
    // setWindowOpenHandler 拦截转工作台页签（main.js web-contents-created），不会弹真窗口
    el.setAttribute('allowpopups', 'true')
    el.setAttribute('webpreferences', 'backgroundThrottling=false')
    wrap.appendChild(el)
    host.appendChild(wrap)
    v = wbUrlViews[key] = { el, wrap }
  }
  return v
}
function showUrlView(key, url) {
  const v = ensureUrlView(key, url)
  if (!v) return
  for (const k of Object.keys(wbUrlViews)) wbUrlViews[k].wrap.classList.toggle('hidden', k !== key)
}
function hideAllUrlViews() {
  for (const k of Object.keys(wbUrlViews)) wbUrlViews[k].wrap.classList.add('hidden')
}
function destroyUrlView(key) {
  const v = wbUrlViews[key]
  if (!v) return
  try { v.el.remove() } catch {}
  try { v.wrap.remove() } catch {}
  delete wbUrlViews[key]
}

// AI 打开网址 → 工作台网页页签
function addUrlTab(url) {
  const key = 'local|url://' + url
  if (!state.wbItems.some(w => wbKey(w) === key)) {
    let name = ''
    try { name = new URL(url).hostname } catch { name = String(url).slice(0, 30) }
    state.wbItems.push({ kind: 'urltab', url, path: 'url://' + url, name, isDir: false, size: 0, origin: 'local', originName: '网页', _missing: false })
    wbPersist()
  }
  wbActiveKey = key
  wbRenderedKey = null
  renderWorkbench()
}

function renderWbView() {
  const body = $('wbViewBody')
  const toolbar = $('wbViewToolbar')
  if (!body) return
  const it = getWbActive()
  wbEmbedSync(wbActiveKey) // 内嵌的 WPS/Word 窗口只属于它自己的页签：切走就藏
  // 网页版模型层（DeepSeek 网页版 webview）：非网页页签时藏层（只显隐不销毁，保登录保会话）
  if (it && it.kind === 'webapp' && typeof WbWebChat !== 'undefined') {
    wbRenderedKey = wbActiveKey
    toolbar.classList.add('hidden')
    // 图片预览的悬浮控件（AI 编辑按钮/翻页箭头/计数）是 z-index 5/6 的绝对定位元素，
    // 会浮在网页层之上残留（老大实锤 v2.4.83：图→网页切换按钮残留）；body 内容照旧保留，
    // 切回图片页签走 openPreview 全量重挂，这里删掉即可
    body.querySelectorAll('.wb-img-nav,.wb-img-count,.wb-img-edit-btn').forEach(n => n.remove())
    hideAllUrlViews()
    WbWebChat.show(it.web || 'deepseek')
    return
  }
  if (typeof WbWebChat !== 'undefined') WbWebChat.hide()
  // 通用网页页签（AI open_url 打开的网址）：专属 webview 层只显隐，切页签不销毁保状态
  if (it && it.kind === 'urltab') {
    wbRenderedKey = wbActiveKey
    toolbar.classList.add('hidden')
    body.querySelectorAll('.wb-img-nav,.wb-img-count,.wb-img-edit-btn').forEach(n => n.remove())
    showUrlView(wbActiveKey, it.url)
    return
  }
  hideAllUrlViews()
  // it 为空（工作台空/刚切会话）必须强制重绘：否则上一个会话的预览残留在屏上
  if (it && wbRenderedKey === wbActiveKey && body.querySelector('.wb-view-content, textarea.wb-editor, .empty-state')) {
    wbRefreshToolbar(it)
    return
  }
  body.querySelectorAll('video, audio').forEach((m) => { try { m.pause() } catch {} })
  if (!it) {
    wbRenderedKey = null
    toolbar.classList.add('hidden')
    const tiles = wbShellDirs
      ? Object.entries(wbShellDirs).map(([k, p]) => ({ k, p, icon: { desktop: iconSvg('monitor'), downloads: iconSvg('download'), documents: iconSvg('file-text'), pictures: iconSvg('image'), music: iconSvg('music'), videos: iconSvg('video') }[k] || iconSvg('folder'), name: { desktop: '桌面', downloads: '下载', documents: '文档', pictures: '图片', music: '音乐', videos: '视频' }[k] || k }))
      : []
    body.innerHTML = `
      <div class="empty-state" style="padding-top:34px">
        <div class="empty-icon">${iconSvg('folder-open')}</div>
        <div>工作台还是空的</div>
        <div class="empty-hint">在右侧资源面板选中文件/文件夹<br>点「加入工作台」或直接拖进来</div>
      </div>
      ${tiles.length ? `<div class="wb-quick">${tiles.map(t => `<div class="wb-quick-tile" data-quick="${t.k}" title="${escapeHtml(t.p)}"><span class="q-icon">${t.icon}</span><span class="q-name">${t.name}</span></div>`).join('')}</div>` : ''}
    `
    if (tiles.length) {
      body.querySelectorAll('.wb-quick-tile').forEach((tile) => {
        tile.addEventListener('click', () => {
          const t = tiles.find(x => x.k === tile.dataset.quick)
          if (t) addToWorkbench([{ path: t.p, name: t.name, isDir: true }], 'local', '本机')
        })
      })
    }
    return
  }
  toolbar.classList.remove('hidden')
  if (it && it.origin === 'local' && !it.isDir) _api.watchDir(wbDirOf(it.path)).catch(() => {}) // 文件页签：watch 父目录，AI 改文件时内容实时重载
  openPreview(it)
}

// Windows 路径取父目录（渲染层无 node path；盘根返回自身）
function wbDirOf(p) {
  const s = String(p || '').replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 2 ? s.slice(0, i) : s
}
// 路径相等（Windows 大小写/尾斜杠不敏感）
function wbPathEq(a, b) {
  const n = (x) => String(x || '').replace(/[\\/]+$/, '').toLowerCase()
  return !!a && !!b && n(a) === n(b)
}

// 工具条按钮态随当前项刷新（保存键只在有未保存修改时出现）
function wbRefreshToolbar(it) {
  if (!it) return
  const ed = wbEditors[wbKey(it)]
  const editable = !it.isDir && !it._missing && getPreviewKind(it.name) === 'text'
  if ($('wbSaveBtn')) $('wbSaveBtn').classList.toggle('hidden', !(editable && ed && ed.dirty))
  if ($('wbLocateBtn')) $('wbLocateBtn').classList.toggle('hidden', it.origin !== 'local')
  const tab = $('wbTabs') && $('wbTabs').querySelector(`.wb-tab.active`)
  if (tab) tab.classList.toggle('dirty', !!(ed && ed.dirty))
}

function removeWbItem(it) {
  const key = wbKey(it)
  if (it.kind === 'webapp' && typeof WbWebChat !== 'undefined') WbWebChat.destroy(it.web || 'deepseek')
  if (it.kind === 'urltab') destroyUrlView(key)
  const ed = wbEditors[key]
  if (ed && ed.dirty && !confirm(`「${it.name}」有未保存的修改，移出将丢失，确定？`)) return
  delete wbEditors[key]
  delete wbFolderNav[key]
  if (wbActiveKey === key) { wbActiveKey = null; wbRenderedKey = null }
  if (wbEmbed.key === key) wbEmbedKill() // 移出的页签若正被 WPS/Word 内嵌，关掉
  state.wbItems = state.wbItems.filter(w => w !== it)
  renderWorkbench()
  wbPersist()
}

function wbAddRef(item) {
  if (item.kind === 'webapp' || item.kind === 'urltab') { showToast('网页页签不支持引用，直接选 [网页] 模型对话即可', 'info'); return }
  const ref = item.origin === 'local'
    ? `[引用文件: ${item.path}]`
    : `[引用远程文件: ${item.originName || '远程设备'}|${item.origin}|${item.path}]`
  if (typeof work._appendChatRef === 'function') {
    work._appendChatRef(ref)
    showToast('已引用到聊天，AI 将能看到该文件', 'success')
  } else {
    showToast('请先切换到 Work 模式使用引用', 'error')
  }
}

async function wbSendAll() {
  if (!state.wbItems.length) { showToast('工作台是空的', 'error'); return }
  const localItems = state.wbItems.filter(w => w.origin === 'local' && !w._missing && w.kind !== 'webapp')
  const remoteItems = state.wbItems.filter(w => w.origin !== 'local')
  if (localItems.length) {
    if (!state.connectedDeviceId) { showToast('请先连接设备，再发送本地内容', 'error'); return }
    if (!state.remotePath || state.remotePath === 'root') { showToast('请先在远程面板进入目标目录', 'error'); return }
    showToast(`开始发送 ${localItems.length} 个本地项目...`, 'info')
    for (const it of localItems) {
      await uploadFile(it.path, it.isDir)
    }
  }
  if (remoteItems.length) {
    if (!state.connectedDeviceId) { showToast('请先连接设备，再取回远程内容', 'error'); return }
    for (const it of remoteItems) {
      if (it.origin !== state.connectedDeviceId) {
        showToast(`「${it.name}」来自「${it.originName}」，请先连接该设备`, 'error')
        continue
      }
      await downloadFile(it.path, it.isDir)
    }
  }
}

// === 内嵌预览/编辑器：所有文件都在工作台内打开 ===

// 媒体/PDF/网页 嵌入 HTML（预览区与文件夹浏览器共用）
function wbMediaHTML(kind, url) {
  if (kind === 'image') return `<img class="pv-media" src="${url}">`
  if (kind === 'video') return `<video class="pv-media" controls autoplay src="${url}"></video>`
  if (kind === 'audio') return `<audio class="pv-media" controls autoplay src="${url}"></audio>`
  return `<iframe class="pv-frame" src="${url}"></iframe>` // pdf / html
}

// === 网页下载进度浮条（v2.7.16）：内置浏览器/网页页签点下载 → will-download 接管 → 这里显示进度 ===
// 单例浮条挂在 body 右下角，多条下载并列；完成项停留 4 秒自动消失，可点「打开文件夹」定位
const wbDownloads = new Map() // id → {name, received, total, state, path}
let wbDownloadBox = null
function wbEnsureDownloadBox() {
  if (wbDownloadBox && document.body.contains(wbDownloadBox)) return wbDownloadBox
  wbDownloadBox = document.createElement('div')
  wbDownloadBox.id = 'wbDownloadBox'
  wbDownloadBox.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99990;display:flex;flex-direction:column;gap:8px;max-width:320px'
  document.body.appendChild(wbDownloadBox)
  return wbDownloadBox
}
function wbFormatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0B'
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB'
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  return Math.max(1, Math.round(n / 1024)) + 'KB'
}
function wbRenderDownloads() {
  const box = wbEnsureDownloadBox()
  const rows = []
  for (const [id, d] of wbDownloads) {
    const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : (d.state === 'completed' ? 100 : 0)
    let statusHtml = ''
    if (d.state === 'progressing') {
      statusHtml = `<div style="height:4px;border-radius:99px;background:rgba(109,90,224,.18);overflow:hidden"><div style="height:100%;width:${pct}%;background:#6d5ae0;border-radius:99px;transition:width .2s"></div></div>`
    } else if (d.state === 'completed') {
      statusHtml = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="color:#0d7a43;font-size:12px">已完成 · ${wbFormatBytes(d.total)}</span><button data-dl-open="${escAttr(d.path)}" style="font:12px/1.4 inherit;padding:2px 8px;border:0;border-radius:8px;background:#ece9f8;color:#4a3a8a;cursor:pointer">打开文件夹</button></div>`
    } else if (d.state === 'canceled') {
      statusHtml = '<div style="color:#8a89a0;font-size:12px">已取消</div>'
    } else {
      statusHtml = '<div style="color:#b03028;font-size:12px">下载中断</div>'
    }
    rows.push(`<div style="background:#fff;border-radius:12px;padding:10px 12px;box-shadow:0 4px 14px rgba(30,20,70,.16);font-size:12px;color:#26283c">
      <div style="font-weight:600;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escAttr(d.name)}">${escHtml(d.name)}</div>
      ${d.state === 'progressing' ? `<div class="meta" style="margin-bottom:4px">${wbFormatBytes(d.received)} / ${wbFormatBytes(d.total)} · ${pct}%</div>` : ''}
      ${statusHtml}
    </div>`)
  }
  box.innerHTML = rows.join('')
  box.style.display = rows.length ? 'flex' : 'none'
  // 完成项 4 秒后清除
  for (const [id, d] of wbDownloads) {
    if ((d.state === 'completed' || d.state === 'canceled') && !d._timer) {
      d._timer = setTimeout(() => { wbDownloads.delete(id); wbRenderDownloads() }, 4000)
    }
  }
  box.querySelectorAll('[data-dl-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-dl-open')
      if (p) window.api.openInExplorer(p).catch(() => { })
    })
  })
}
// 防 XSS：下载文件名来自网页，必须转义（进度浮条用 innerHTML 渲染）
function escHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;') }
if (window.api && window.api.onWbDownloadProgress) {
  window.api.onWbDownloadProgress((meta) => {
    if (!meta || !meta.id) return
    const prev = wbDownloads.get(meta.id) || {}
    wbDownloads.set(meta.id, Object.assign(prev, meta))
    wbRenderDownloads()
  })
}

