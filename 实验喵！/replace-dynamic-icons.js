// app.js 动态 emoji → iconSvg() 批量替换（带存在性断言）
const fs = require('fs')
const p = 'f:/局域网互传2.6/src/js/app.js'
let s = fs.readFileSync(p, 'utf8')
let ok = 0, fail = []

const pairs = [
  // 启动渲染（init 完成后渲染一遍静态占位）
  ["  init().catch(err => {", "  init().then(() => renderIcons(document)).catch(err => {"],
  // toast 成功前缀去 emoji（success 样式已带绿色）
  ["showToast(`✓ ${data.fileName} 已同步到对方电脑`, 'success')", "showToast(`${data.fileName} 已同步到对方电脑`, 'success')"],
  // 文件列表图标（本地/远程两处）
  ["const icon = isDesktop ? '🖥️' : (isDrive ? '💿' : (isDir ? '📁' : getFileIcon(entry.name)))",
   "const icon = isDesktop ? iconSvg('monitor') : (isDrive ? iconSvg('hard-drive') : (isDir ? iconSvg('folder') : getFileIcon(entry.name)))"],
  // 工作台页签图标
  ["tab.innerHTML = `<span class=\"wb-tab-icon\">${it.kind === 'webapp' || it.kind === 'urltab' ? '🌐' : (it.isDir ? '📁' : getFileIcon(it.name))}</span>",
   "tab.innerHTML = `<span class=\"wb-tab-icon\">${it.kind === 'webapp' || it.kind === 'urltab' ? iconSvg('globe') : (it.isDir ? iconSvg('folder') : getFileIcon(it.name))}</span>"],
  // shellDirs 图标映射
  ["icon: { desktop: '🖥', downloads: '📥', documents: '📄', pictures: '🖼', music: '🎵', videos: '🎬' }[k] || '📁'",
   "icon: { desktop: iconSvg('monitor'), downloads: iconSvg('download'), documents: iconSvg('file-text'), pictures: iconSvg('image'), music: iconSvg('music'), videos: iconSvg('video') }[k] || iconSvg('folder')"],
  // Word 编辑器工具栏
  ["if (!save.textContent.includes('●')) save.textContent = '● 保存 (Ctrl+S)'",
   "if (!save.dataset.savedIcon) { save.dataset.savedIcon = '1'; save.innerHTML = iconSvg('save') + ' 保存 (Ctrl+S)' }"],
  ["const replBtn = fmtBtn('🔍', '查找替换（同一段落内匹配）', () => {})", "const replBtn = fmtBtn(iconSvg('search'), '查找替换（同一段落内匹配）', () => {})"],
  ["fmtBtn('❝', '引用块', () => block('blockquote'))", "fmtBtn(iconSvg('text-quote'), '引用块', () => block('blockquote'))"],
  ["fmtBtn('🧹', '清除格式', () => cmd('removeFormat'))", "fmtBtn(iconSvg('eraser'), '清除格式', () => cmd('removeFormat'))"],
  ["extBtn.textContent = '🖥 外部编辑'", "extBtn.innerHTML = iconSvg('external-link') + ' 外部编辑'"],
  // 空状态
  ["<div class=\"empty-icon\">🖥</div><div>正在启动", "<div class=\"empty-icon\">${iconSvg('monitor')}</div><div>正在启动"],
  ["<div class=\"empty-icon\">🖥</div><div>在 ${appName}", "<div class=\"empty-icon\">${iconSvg('monitor')}</div><div>在 ${appName}"],
  ["<div class=\"empty-icon\">📄</div><div>${appName} 文档窗口已关闭", "<div class=\"empty-icon\">${iconSvg('file-text')}</div><div>${appName} 文档窗口已关闭"],
  ["<div class=\"empty-icon\">📖</div><div>正在读取…</div>", "<div class=\"empty-icon\">${iconSvg('book-open')}</div><div>正在读取…</div>"],
  // 图片编辑器
  ["btn.innerHTML = '✏ AI 编辑'", "btn.innerHTML = iconSvg('square-pen') + ' AI 编辑'"],
  ["title=\"橡皮擦（擦除涂多的遮罩）\">◌ 橡皮</button>", "title=\"橡皮擦（擦除涂多的遮罩）\">${iconSvg('eraser')} 橡皮</button>"],
  ["title=\"合成遮罩图并发到对话框，由你写指令让 AI 改图\">✓ 发送到对话框</button>", "title=\"合成遮罩图并发到对话框，由你写指令让 AI 改图\">${iconSvg('check')} 发送到对话框</button>"],
  ["goBtn.textContent = '✓ 发送到对话框'", "goBtn.innerHTML = iconSvg('check') + ' 发送到对话框'"],
  // 2517 搜索空态
  ["<div class=\"empty-icon\">${entries.length ? '🔍' : '📭'}</div>", "<div class=\"empty-icon\">${entries.length ? iconSvg('search') : iconSvg('inbox')}</div>"],
  // 工作台新建菜单
  ["{ label: '📁 新建文件夹', fn: () => wbNewHere('folder') },", "{ label: iconSvg('folder-plus') + ' 新建文件夹', fn: () => wbNewHere('folder') },"],
  ["{ label: '📄 新建文本文档', fn: () => wbNewHere('txt') },", "{ label: iconSvg('file-plus') + ' 新建文本文档', fn: () => wbNewHere('txt') },"],
  ["acts.push({ label: '💬 引用 AI', fn: wbQuoteRefs })", "acts.push({ label: iconSvg('message-square') + ' 引用 AI', fn: wbQuoteRefs })"],
  ["acts.push({ label: '🗑 删除', danger: true, fn: () => wbDeleteTargets(targets) })", "acts.push({ label: iconSvg('trash-2') + ' 删除', danger: true, fn: () => wbDeleteTargets(targets) })"],
  // L2530 文件夹 icon
  ["      icon.textContent = '📁'", "      icon.innerHTML = iconSvg('folder')"],
  // wbTabIcon
  ["  if (item.isDir) return '📁'\n  if (item.kind === 'webapp') return '🌐'", "  if (item.isDir) return iconSvg('folder')\n  if (item.kind === 'webapp') return iconSvg('globe')"],
  // 设备扫描空态
  ["<div class=\"empty-icon\">🔍</div><div>正在扫描局域网...", "<div class=\"empty-icon\">${iconSvg('search')}</div><div>正在扫描局域网..."],
  // 中转设备
  ["if (viaRelay) { metaText = '🌐 互联网通道'; icon = '🌏';", "if (viaRelay) { metaText = '互联网通道'; icon = iconSvg('globe');"],
  // 连接中状态
  ["case 'connecting': return '⏳ 连接中...'", "case 'connecting': return '连接中...'"],
  // getFileIcon（工作台用）
  ["    'jpg': '🖼', 'jpeg': '🖼', 'png': '🖼', 'gif': '🖼', 'bmp': '🖼',",
   "    'jpg': 'image', 'jpeg': 'image', 'png': 'image', 'gif': 'image', 'bmp': 'image',"],
  ["    'mp3': '🎵', 'wav': '🎵', 'flac': '🎵',", "    'mp3': 'music', 'wav': 'music', 'flac': 'music',"],
  ["    'mp4': '🎬', 'avi': '🎬', 'mkv': '🎬', 'mov': '🎬',", "    'mp4': 'video', 'avi': 'video', 'mkv': 'video', 'mov': 'video',"],
  ["  return iconMap[ext] || '📄'", "  return iconMap[ext] || 'file-text'"],
  // AI 工具图标表
  ["  list_dir: '📂', read_file: '📖', write_file: '✏️', create_folder: '📁',", "  list_dir: 'folder-open', read_file: 'book-open', write_file: 'square-pen', create_folder: 'folder-plus',"],
  ["  copy_path: '📋', move_path: '🚚', rename_path: '🏷️', delete_path: '🗑️',", "  copy_path: 'clipboard', move_path: 'arrow-right-left', rename_path: 'tag', delete_path: 'trash-2',"],
  ["  search_files: '🔍', create_word: '📝', read_word: '📄',", "  search_files: 'search', create_word: 'file-pen', read_word: 'file-text',"],
  ["  generate_image: '🎨', generate_video: '🎬',", "  generate_image: 'paintbrush', generate_video: 'video',"],
  ["  open_url: '🌐', open_path: '🚀'", "  open_url: 'globe', open_path: 'rocket'"],
  // 生成模式 chip
  ["${work.genMode === 'image' ? `🖼 图片生成模式", "${work.genMode === 'image' ? `图片生成模式"],
  [" : '🎬 视频生成模式'}</span>", " : '视频生成模式'}</span>"],
  // 传输队列状态
  ["stat.textContent = it.state === 'ok' ? '✓ 完成' : (it.cancelled ? '✗ 已取消' : '✗ 失败')", "stat.textContent = it.state === 'ok' ? '完成' : (it.cancelled ? '已取消' : '失败')"],
  // 会话删除两段式
  ["mkBtn('🗑', '删除会话（连历史一起删，再点一次确认）', async (b) => {", "mkBtn(iconSvg('trash-2'), '删除会话（连历史一起删，再点一次确认）', async (b) => {"],
  ["          b.textContent = '❗'", "          b.innerHTML = iconSvg('triangle-alert')"],
  ["          setTimeout(() => { delArmed = false; b.textContent = '🗑' }, 3000)", "          setTimeout(() => { delArmed = false; b.innerHTML = iconSvg('trash-2') }, 3000)"],
  // 视频背景空态
  ["thumb.innerHTML = '<span class=\"gs-bg-thumb-empty\">🎬 视频背景</span>'", "thumb.innerHTML = '<span class=\"gs-bg-thumb-empty\">视频背景</span>'"],
  // 模型下拉默认项
  ["s.innerHTML = `<option value=\"\">🌐 默认（顶部服务商）</option>` +", "s.innerHTML = `<option value=\"\">默认（顶部服务商）</option>` +"],
  // TTS 合成/试听
  ["  btn.textContent = '⏳ 合成中'", "  btn.innerHTML = iconSvg('loader-circle') + ' 合成中'"],
  ["    btn.textContent = '▶ 试听'", "    btn.innerHTML = iconSvg('play') + ' 试听'"],
  // 定时任务
  ["info.textContent = `⏰ ${t.time} · ${t.task}${t.enabled ? '' : '（已暂停）'}`", "info.innerHTML = `${iconSvg('clock')} ${t.time} · ${escapeHtml(t.task)}${t.enabled ? '' : '（已暂停）'}`"],
  // 引用缩略图标
  ["  return { icon: '📄', name: ref, title: ref }", "  return { icon: iconSvg('file-text'), name: ref, title: ref }"],
  // bulk 操作 mkBtn（L2474）text 感知
  ["    const mkBtn = (label, title, fn) => {\n      const b = document.createElement('button')\n      b.className = 'btn btn-ghost btn-xs'\n      b.textContent = label\n      b.title = title",
   "    const mkBtn = (label, title, fn) => {\n      const b = document.createElement('button')\n      b.className = 'btn btn-ghost btn-xs'\n      if (label.includes('<svg')) b.innerHTML = label; else b.textContent = label\n      b.title = title"],
  // 会话栏 mkBtn（L6691）
  ["    const mkBtn = (txt, tip, fn) => {\n      const b = document.createElement('button')\n      b.textContent = txt\n      b.title = tip",
   "    const mkBtn = (txt, tip, fn) => {\n      const b = document.createElement('button')\n      if (txt.includes('<svg')) b.innerHTML = txt; else b.textContent = txt\n      b.title = tip"],
  // 页签菜单 textContent 感知
  ["    const btn = document.createElement('button')\n    btn.textContent = label\n    if (cls) btn.className = cls", "    const btn = document.createElement('button')\n    if (label.includes('<svg')) btn.innerHTML = label; else btn.textContent = label\n    if (cls) btn.className = cls"],
  // bulk 菜单 emoji（📥 加入工作台等）
  ["mkBtn('📥 加入工作台', '把选中项收进工作台标签', () => {", "mkBtn(iconSvg('folder-input') + ' 加入工作台', '把选中项收进工作台标签', () => {"],
  // 上下文菜单（工作台页签）
  ["['👁 打开', () => { wbActiveKey = wbKey(it); renderWorkbench() }],", "[iconSvg('eye') + ' 打开', () => { wbActiveKey = wbKey(it); renderWorkbench() }],"],
  ["['💬 引用到 AI', () => wbAddRef(it)],", "[iconSvg('message-square') + ' 引用到 AI', () => wbAddRef(it)],"],
  ["['↗ 系统打开', () => {", "[iconSvg('external-link') + ' 系统打开', () => {"],
  ["['✏️ 重命名', () => renameWbItem(it)] : null,", "[iconSvg('square-pen') + ' 重命名', () => renameWbItem(it)] : null,"],
  ["['📋 复制路径', () => {", "[iconSvg('clipboard') + ' 复制路径', () => {"],
  ["['✕ 关闭', () => removeWbItem(it), 'danger'],", "[iconSvg('x') + ' 关闭', () => removeWbItem(it), 'danger'],"],
  ["['✕ 关闭其他', () => closeOtherWbItems(it), 'danger']", "[iconSvg('x') + ' 关闭其他', () => closeOtherWbItems(it), 'danger']"],
  // 引用 AI 按钮（图片查看）
  ["mkBtn('💬 引用 AI', '引用给 AI 当上下文', () => {", "mkBtn(iconSvg('message-square') + ' 引用 AI', '引用给 AI 当上下文', () => {"],
  // Word 编辑器查找替换提示
  ["if (!find) { replMsg.textContent = '⚠️ 先填要查找的文字'; return }", "if (!find) { replMsg.textContent = '先填要查找的文字'; return }"],
  ["replMsg.textContent = count ? `✅ 已替换 ${count} 处（Ctrl+S 保存生效）` : '未找到（仅匹配同一段落内文字）'", "replMsg.textContent = count ? `已替换 ${count} 处（Ctrl+S 保存生效）` : '未找到（仅匹配同一段落内文字）'"],
  // 更新弹窗大图标
  ["<div style=\"font-size:48px;margin-bottom:20px;\">⚠️</div>", "<div style=\"font-size:48px;margin-bottom:20px;\">${iconSvg('triangle-alert')}</div>"],
  // 文件类型推断（wb 引用）
  ["  if (!/\\.[A-Za-z0-9]{1,8}$/.test(name)) return '📁'", "  if (!/\\.[A-Za-z0-9]{1,8}$/.test(name)) return iconSvg('folder')"],
  ["  if (/\\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name)) return '🖼️'", "  if (/\\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name)) return iconSvg('image')"],
  ["  if (/\\.(docx?|xlsx?|pptx?|pdf|txt|md)$/i.test(name)) return '📄'", "  if (/\\.(docx?|xlsx?|pptx?|pdf|txt|md)$/i.test(name)) return iconSvg('file-text')"],
  ["  return '📄'\n}", "  return iconSvg('file-text')\n}"],
]

for (const [oldS, newS] of pairs) {
  if (s.includes(oldS)) { s = s.split(oldS).join(newS); ok++ } else { fail.push(oldS.slice(0, 70)) }
}
fs.writeFileSync(p, s)
console.log(`替换 ${ok}/${pairs.length} 对`)
if (fail.length) { console.log('未命中：'); fail.forEach(f => console.log('  ' + f)) }

// 残留 emoji 终查（排除注释行）
const lines = s.split('\n')
let rest = 0
lines.forEach((l, i) => {
  const code = l.replace(/\/\/.*$/, '')
  const m = code.match(/[\u{1F000}-\u{1FAFF}\u{2300}-\u{27BF}]/gu)
  if (m) { rest++; console.log(`L${i + 1} [${[...new Set(m)].join(' ')}] ${code.trim().slice(0, 80)}`) }
})
console.log(`剩余行数: ${rest}`)
