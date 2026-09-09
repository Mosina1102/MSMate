// app.js emoji 替换 patch 3（含 CRLF 未命中修复）
const fs = require('fs')
const p = 'f:/局域网互传2.6/src/js/app.js'
let s = fs.readFileSync(p, 'utf8')
let ok = 0, fail = []
const pairs = [
  // --- 修复 5 对未命中（单行，避开换行符差异） ---
  ["  if (item.isDir) return '📁'", "  if (item.isDir) return iconSvg('folder')"],
  ["  if (item.kind === 'webapp') return '🌐'", "  if (item.kind === 'webapp') return iconSvg('globe')"],
  ["      b.className = 'btn btn-ghost btn-xs'\n      b.textContent = label", "      b.className = 'btn btn-ghost btn-xs'\n      if (label.includes('<svg')) b.innerHTML = label; else b.textContent = label"],
  ["      const b = document.createElement('button')\n      b.textContent = txt\n      b.title = tip", "      const b = document.createElement('button')\n      if (txt.includes('<svg')) b.innerHTML = txt; else b.textContent = txt\n      b.title = tip"],
  ["    const btn = document.createElement('button')\n    btn.textContent = label\n    if (cls) btn.className = cls", "    const btn = document.createElement('button')\n    if (label.includes('<svg')) btn.innerHTML = label; else btn.textContent = label\n    if (cls) btn.className = cls"],
  ["  return '📄'\n}", "  return iconSvg('file-text')\n}"],
  // --- 空状态 ---
  ["<div class=\"empty-icon\">📂</div>", "<div class=\"empty-icon\">${iconSvg('folder-open')}</div>"],
  ["<div class=\"empty-icon\">🗂</div>", "<div class=\"empty-icon\">${iconSvg('folder-open')}</div>"],
  ["<div class=\"empty-icon\">📋</div>", "<div class=\"empty-icon\">${iconSvg('clipboard')}</div>"],
  ["<div class=\"empty-icon\">📜</div>", "<div class=\"empty-icon\">${iconSvg('file-text')}</div>"],
  ["<div class=\"empty-icon\">📦</div>", "<div class=\"empty-icon\">${iconSvg('archive')}</div>"],
  ["<div class=\"empty-icon\">📊</div>", "<div class=\"empty-icon\">${iconSvg('table')}</div>"],
  ["<div class=\"empty-icon\">🔍</div>", "<div class=\"empty-icon\">${iconSvg('search')}</div>"],
  // Word 文档起稿空态（L1653）
  ["<div class=\"empty-icon\">📝</div>", "<div class=\"empty-icon\">${iconSvg('file-pen')}</div>"],
  // --- bulk 发送/新建/右键菜单 ---
  ["mkBtn('📤 发送', item.origin === 'local' ? '发送选中文件到对方（文件夹逐个传）' : '把选中项下载回本机', async", "mkBtn(iconSvg('send') + ' 发送', item.origin === 'local' ? '发送选中文件到对方（文件夹逐个传）' : '把选中项下载回本机', async"],
  ["{ label: '📝 新建 Word 文档', fn: () => wbNewHere('docx') },", "{ label: iconSvg('file-pen') + ' 新建 Word 文档', fn: () => wbNewHere('docx') },"],
  ["{ label: '📊 新建 Excel 表格', fn: () => wbNewHere('xlsx') },", "{ label: iconSvg('table') + ' 新建 Excel 表格', fn: () => wbNewHere('xlsx') },"],
  ["{ label: '📽 新建 PPT 演示', fn: () => wbNewHere('pptx') },", "{ label: iconSvg('presentation') + ' 新建 PPT 演示', fn: () => wbNewHere('pptx') },"],
  ["acts.push({ label: '📋 粘贴', fn: () => wbPasteTo(nav.cwd, item, wbRe", "acts.push({ label: iconSvg('clipboard') + ' 粘贴', fn: () => wbPasteTo(nav.cwd, item, wbRe"],
  ["acts.push({ label: '🔄 刷新', fn: wbRefresh })", "acts.push({ label: iconSvg('rotate-cw') + ' 刷新', fn: wbRefresh })"],
  ["acts.push({ label: ent.isDirectory ? '📂 进入' : '📂 打开', fn: () => wb", "acts.push({ label: iconSvg('folder-open') + (ent.isDirectory ? ' 进入' : ' 打开'), fn: () => wb"],
  ["acts.push({ label: '🗂 加入工作台', fn: () => addToWor", "acts.push({ label: iconSvg('folder-input') + ' 加入工作台', fn: () => addToWor"],
  ["acts.push({ label: '📋 复制', fn: () => wbClipSet(false) })", "acts.push({ label: iconSvg('clipboard') + ' 复制', fn: () => wbClipSet(false) })"],
  ["acts.push({ label: '✂️ 剪切', fn: () => wbClipSet(true) })", "acts.push({ label: iconSvg('scissors') + ' 剪切', fn: () => wbClipSet(true) })"],
  ["acts.push({ label: '📥 粘贴到该文件夹', fn: () => wbPast", "acts.push({ label: iconSvg('folder-input') + ' 粘贴到该文件夹', fn: () => wbPast"],
  ["acts.push({ label: '🧭 在资源管理器中显示', fn: () => _api.openInE", "acts.push({ label: iconSvg('app-window') + ' 在资源管理器中显示', fn: () => _api.openInE"],
  ["acts.push({ label: '📤 发送到对方', fn: async", "acts.push({ label: iconSvg('send') + ' 发送到对方', fn: async"],
  ["acts.push({ label: '📥 下载到本机', fn: async () => { for (const x of targets) await", "acts.push({ label: iconSvg('download') + ' 下载到本机', fn: async () => { for (const x of targets) await"],
  ["acts.push({ label: '✏️ 编辑', fn: () => editRemote", "acts.push({ label: iconSvg('square-pen') + ' 编辑', fn: () => editRemote"],
  ["acts.push({ label: '🏷 重命名', fn: () => showRenameModal(ent.path, ent", "acts.push({ label: iconSvg('square-pen') + ' 重命名', fn: () => showRenameModal(ent.path, ent"],
  // 引用胶囊
  ["_wbQuoteCap.textContent = '➕ 添加到对话'", "_wbQuoteCap.innerHTML = iconSvg('plus') + ' 添加到对话'"],
  // 设备卡
  ["const remarkHtml = remark ? `<div class=\"device-remark\">📝 ${escapeHtml(remark)}", "const remarkHtml = remark ? `<div class=\"device-remark\">${iconSvg('file-pen')} ${escapeHtml(remark)}"],
  ["let icon = '💻'", "let icon = iconSvg('laptop')"],
  ["else if (viaIPv6) { metaText = '📡 IPv6 直连'; icon = '📡';", "else if (viaIPv6) { metaText = 'IPv6 直连'; icon = iconSvg('radio-tower');"],
  // 中转/IPv6 状态文本去 emoji（有 badge 颜色标识）
  ["case 'online': return '✅ 已连接中转服务器'", "case 'online': return '已连接中转服务器'"],
  ["case 'error': return `❌ ${snap.error || '连接失败'}`", "case 'error': return `${snap.error || '连接失败'}`"],
  ["updateIpv6Tag(`✅ 有 ${r.addresses.length} 个 IPv6 地址`, 'on')", "updateIpv6Tag(`有 ${r.addresses.length} 个 IPv6 地址`, 'on')"],
  ["updateIpv6Tag('❌ 本机没有公网 IPv6', 'err')", "updateIpv6Tag('本机没有公网 IPv6', 'err')"],
  ["updateIpv6Tag('❌ 检测失败', 'err')", "updateIpv6Tag('检测失败', 'err')"],
  // 传输取消按钮
  ["<button class=\"transfer-can", "<button class=\"transfer-can"], // 占位无变化
  // 对讲
  ["if (hint) hint.textContent = ptt.hotkey ? `🎙 ${ptt.hotkey}` : '🎙 对讲'", "if (hint) hint.innerHTML = `${iconSvg('mic')} ${ptt.hotkey ? ptt.hotkey + ' ' : ''}对讲`.replace('  ', ' ')"],
  ["updateStatus('🎙 正在喊话...', 'busy')", "updateStatus('正在喊话...', 'busy')"],
  // getFileIcon 映射（emoji→lucide 名）
  ["'exe': '⚙️', 'dll': '📦', 'zip': '🗜', 'rar': '🗜', '7z': '🗜',", "'exe': 'app-window', 'dll': 'package', 'zip': 'archive', 'rar': 'archive', '7z': 'archive',"],
  ["'pdf': '📕', 'doc': '📘', 'docx': '📘', 'xls': '📗', 'xlsx': '📗',", "'pdf': 'file-text', 'doc': 'file-text', 'docx': 'file-text', 'xls': 'table', 'xlsx': 'table',"],
  ["'ppt': '📙', 'pptx': '📙', 'txt': '📝', 'md': '📝',", "'ppt': 'presentation', 'pptx': 'presentation', 'txt': 'file-text', 'md': 'file-text',"],
  ["'js': '📜', 'ts': '📜', 'html': '📜', 'css': '📜', 'py': '📜',", "'js': 'file-code', 'ts': 'file-code', 'html': 'file-code', 'css': 'file-code', 'py': 'file-code',"],
  ["'json': '📋', 'xml': '📋', 'sql': '📋',", "'json': 'file-code', 'xml': 'file-code', 'sql': 'file-code',"],
  // 会话列表
  ["title.textContent = (s.pinned ? '📌 ' : '') + (s.title || '新会话')", "title.innerHTML = (s.pinned ? iconSvg(s.pinned ? 'pin' : 'pin-off') + ' ' : '') + escapeHtml(s.title || '新会话')"],
  ["mkBtn('✏', '重命名', () => startInlineRename(s, row, title)),", "mkBtn(iconSvg('square-pen'), '重命名', () => startInlineRename(s, row, title)),"],
  ["mkBtn(s.pinned ? '📍' : '📌', s.pinned ? '取消置顶' : '置顶', async () => {", "mkBtn(iconSvg(s.pinned ? 'pin-off' : 'pin'), s.pinned ? '取消置顶' : '置顶', async () => {"],
  ["title.textContent = (s.pinned ? '📌 ' : '') + (s.title || '新会话')\n    title.title = s.title || '新会话'", "title.innerHTML = (s.pinned ? iconSvg('pin') + ' ' : '') + escapeHtml(s.title || '新会话')\n    title.title = s.title || '新会话'"],
  // 设置页 option
  ["<option value=\"\">📌 已存服务商（${_providerLibCache.length} 条，选中可编辑；空", "<option value=\"\">已存服务商（${_providerLibCache.length} 条，选中可编辑；空"],
  ["<option value=\"\">📌 我的常用模型${chatList.length ? '' : '（空：输入后点 ➕）", "<option value=\"\">我的常用模型${chatList.length ? '' : '（空：输入后点「添加」）"],
  ["<option value=\"\">📌 我的常用识图模型${visionList.length ? '' : '（空：输入后", "<option value=\"\">我的常用识图模型${visionList.length ? '' : '（空：输入后"],
  // 模型清单删除按钮
  ["      del.textContent = '✕'", "      del.innerHTML = iconSvg('x')"],
  // 划选引用
  ["if (mQuote) return { icon: '✏️', name: `${mQuote[1]} 的划选`, title: String(ref), q", "if (mQuote) return { icon: iconSvg('square-pen'), name: `${mQuote[1]} 的划选`, title: String(ref), q"],
  // 回滚确认
  ["btn.textContent = '⚠ 确认回滚？'", "btn.innerHTML = iconSvg('triangle-alert') + ' 确认回滚？'"],
  ["div.textContent = `⚠️ ${text}`", "div.textContent = text"],
  // 过程折叠 chevron
  ["<span class=\"chat-process-chevron\">▼</span>", "<span class=\"chat-process-chevron\">${iconSvg('chevron-down')}</span>"],
  // 工具卡
  ["<span class=\"tool-card-icon\">${TOOL_ICONS[c.name] || '🔧'}</span>", "<span class=\"tool-card-icon\">${iconSvg(TOOL_ICONS[c.name] || 'wrench')}</span>"],
  ["const icon = ev.name === 'generate_image' && ev.args && ev.args.image ? '🖌️' : (TOOL_ICONS[ev.name] || '🔧')", "const icon = ev.name === 'generate_image' && ev.args && ev.args.image ? iconSvg('paintbrush') : iconSvg(TOOL_ICONS[ev.name] || 'wrench')"],
  // 定时任务 toast
  ["showToast(`⏰ 定时任务已开工${ev.catchUp ? '（错过补跑）' : ''}", "showToast(`定时任务已开工${ev.catchUp ? '（错过补跑）' : ''}"],
  // 思考折叠标签（textContent，去 emoji 留文本）
  ["thinking.querySelector('.label').textContent = '💭 思考中…'", "thinking.querySelector('.label').textContent = '思考中…'"],
  ["thinking.querySelector('.label').textContent = '💭 已深度思考（点击展开）'", "thinking.querySelector('.label').textContent = '已深度思考（点击展开）'"],
  // 任务清单卡
  ["title.textContent = `📋 任务清单 ${done}/${total}`", "title.innerHTML = `${iconSvg('list-checks')} 任务清单 ${done}/${total}`"],
  ["ic.textContent = it.status === 'done' ? '✅' : it.status === 'doing' ? '🔄' : '⬜'", "ic.innerHTML = it.status === 'done' ? iconSvg('check') : it.status === 'doing' ? iconSvg('loader-circle') : iconSvg('circle')"],
  // 定位按钮
  ["locate.textContent = '📂'", "locate.innerHTML = iconSvg('folder-open')"],
  // 问题选项卡图标
  ["<span class=\"tool-card-icon\">🧩</span>", "<span class=\"tool-card-icon\">${iconSvg('puzzle')}</span>"],
]

for (const [oldS, newS] of pairs) {
  if (oldS === newS) continue
  if (s.includes(oldS)) { s = s.split(oldS).join(newS); ok++ } else { fail.push(oldS.slice(0, 66)) }
}
fs.writeFileSync(p, s)
console.log(`替换 ${ok}/${pairs.length} 对`)
if (fail.length) { console.log('未命中：'); fail.forEach(f => console.log('  ' + f)) }

// 残留终查（排除注释）
const lines = s.split('\n')
let rest = 0
lines.forEach((l, i) => {
  const code = l.replace(/\/\/.*$/, '')
  const m = code.match(/[\u{1F000}-\u{1FAFF}\u{2300}-\u{27BF}]/gu)
  if (m) { rest++; console.log(`L${i + 1} [${[...new Set(m)].join(' ')}] ${code.trim().slice(0, 78)}`) }
})
console.log(`剩余行数: ${rest}`)
