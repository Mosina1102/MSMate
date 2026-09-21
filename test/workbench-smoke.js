// Work 工作台 + 资源面板 + 内置预览/编辑器 冒烟测试（静态一致性）
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
// 工具手册（v2.6.0 渐进式披露改造）：低频工具的深度 desc 迁入 ai/manuals/*.md，断言源随迁
const readManual = (name) => fs.readFileSync(path.join(ROOT, 'ai/manuals', name), 'utf8')
let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}`) }
}

const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n')
const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
const { progIdToKind, exeFromCommand } = require(path.join(ROOT, 'ai/winembed.js')) // 纯函数真跑

console.log('— 工作台 DOM（标签页 + 内嵌预览/编辑器） —')
const ids = [
  'workbenchPanel', 'wbTabs', 'wbCount', 'wbStats', 'wbClearBtn', 'wbSendBtn',
  'wbView', 'wbViewToolbar', 'wbViewIcon', 'wbViewName', 'wbViewMeta',
  'wbSaveBtn', 'wbRefBtn', 'wbSendOneBtn', 'wbOpenSysBtn', 'wbViewBody',
  'resourcePanel', 'resTabLocal', 'resTabRemote', 'resLocalHome', 'resRemoteHome',
  'splitSidebar', 'splitWorkbench', 'localAddToWb', 'remoteAddToWb',
]
for (const id of ids) ok(html.includes(`id="${id}"`), `HTML 含 #${id}`)
ok(html.includes('data-action="to-workbench"'), '右键菜单含「加入工作台」项')
ok(html.includes('class="res-tab active"'), '资源页签默认本地')
ok(!html.includes('previewModal'), '独立预览弹窗已移除（全部内嵌工作台）')
{
  const iWb = html.indexOf('id="workbenchPanel"')
  const iSplit = html.indexOf('id="splitWorkbench"')
  const iRes = html.indexOf('id="resourcePanel"')
  ok(iWb !== -1 && iSplit !== -1 && iRes !== -1 && iWb < iSplit && iSplit < iRes, '分割条 DOM 位于工作台与资源面板之间（可拖拽）')
}

console.log('— app.js 逻辑 —')
const fns = ['getPreviewKind', 'fileToUrl', 'wbPersist', 'loadWorkbench', 'addToWorkbench',
  'addSelectionToWorkbench', 'addContextToWorkbench', 'renderWorkbench', 'renderWbView',
  'wbRefreshToolbar', 'removeWbItem', 'wbAddRef', 'wbSendAll', 'wbSendOne', 'openPreview',
  'mountWbEditor', 'wbSaveEdit', 'renderWbFolder', 'wbMediaHTML',
  'applyWorkPaneLayout', 'initSplitters', 'initWorkbenchUI']
for (const fn of fns) ok(appjs.includes(`function ${fn}`), `app.js 定义 ${fn}()`)
ok(appjs.includes('initWorkbenchUI()'), 'initWorkMode 里调用 initWorkbenchUI')
ok(appjs.includes('try { loadWorkbench(sid) } catch {}'), 'activateSession 按会话加载工作台')
ok(appjs.includes("work._appendChatRef = (ref) => appendChatRef(ref)"), '引用接口暴露给工作台')
ok(appjs.includes('wbItems: []'), 'state.wbItems 初始化')
ok(appjs.includes("action === 'to-workbench'"), '右键菜单派发 to-workbench')
ok(appjs.includes("body.classList.contains('work-mode') ? '' : 'none'"), 'to-workbench 仅 Work 模式显示')
ok(appjs.includes("resLocalHome').appendChild(localSection"), 'Work 模式搬移本地面板进页签')
ok(appjs.includes("resRemoteHome').appendChild(remoteSection"), 'Work 模式搬移远程面板进页签')
ok(appjs.includes("dual.appendChild(localSection)"), '互联模式搬回双面板')
ok(appjs.includes('remoteDragConsumed = true // 已收进工作台'), '拖进工作台后阻止拖出下载')
ok(appjs.includes("'msmate_wb_sidebar_w'") && appjs.includes("'msmate_wb_workbench_w'"), '分割条宽度持久化')
ok(appjs.includes('let wbActiveKey'), '激活标签状态')
ok(appjs.includes('let wbEditors'), '文本编辑态缓存（切页不丢）')
ok(appjs.includes('wbSaveEdit'), 'Ctrl+S / 自动保存入口')
ok(appjs.includes('let wbFolderNav'), '文件夹浏览导航态')
ok(appjs.includes("item.isDir) {\n    renderWbFolder(item)") || /if \(item\.isDir\)\s*\{\s*renderWbFolder\(item\)/.test(appjs), '文件夹标签进入内嵌浏览器')
ok(appjs.includes('listLocalDirectory') && appjs.includes('listRemoteDirectory'), '文件夹浏览走本地/远程列目录 API')
ok(!appjs.includes("$('previewModal')") && !appjs.includes('closePreview'), '预览弹窗逻辑已清除')

console.log('— 预览类型覆盖 —')
for (const t of ["'image'", "'video'", "'audio'", "'pdf'", "'docx'", "'xlsx'", "'html'", "'text'"]) {
  ok(appjs.includes(`=== ${t}`) || appjs.includes(`kind === ${t}`) || appjs.includes(`return ${t === 'text' ? "'text'" : t}`), `预览支持 ${t}`)
}

console.log('— main.js / preload.js —')
ok(mainjs.includes("ipcMain.handle('fs:read-text-file'"), 'main 有 fs:read-text-file')
ok(mainjs.includes("ipcMain.handle('fs:write-text-file'"), 'main 有 fs:write-text-file（编辑保存）')
ok(mainjs.includes('wb-edit-'), '覆盖前快照备份（wb-edit-*）')
ok(mainjs.includes("ipcMain.handle('fs:render-office'"), 'main 有 fs:render-office')
ok(mainjs.includes("ipcMain.handle('wb:get'"), 'main 有 wb:get')
ok(mainjs.includes("ipcMain.handle('wb:set'"), 'main 有 wb:set')
ok(mainjs.includes("require('mammoth')"), 'main 用 mammoth 渲染 docx')
ok(mainjs.includes('workbench.json'), '工作台按会话存 workbench.json')
for (const api of ['readTextFile', 'writeTextFile', 'renderOffice', 'wbGet', 'wbSet']) {
  ok(preload.includes(`${api}:`), `preload 暴露 ${api}`)
}

console.log('— CSS —')
for (const cls of ['.workbench-panel', '.wb-tabs-bar', '.wb-tab.active', '.wb-tab-close', '.wb-view',
  '.wb-view-toolbar', '.wb-view-body', 'textarea.wb-editor', '.wb-fs-grid', '.wb-fs-item', '.wb-fs-bar',
  '.resource-panel', '.res-tab.active', '.res-tab-body', '.pane-splitter', '.pv-fallback', '.wb-add-btn']) {
  ok(css.includes(cls), `CSS 含 ${cls}`)
}
ok(css.includes('@keyframes wbIn'), '工作台入场动画（向右挤开）')
ok(/flex: 0 1 var\(--workbench-w, 58%\)/.test(css), '工作台默认 58% 且可被压缩（资源面板不挤没）')
ok(/\.resource-panel\s*\{[^}]*flex: 1 1 300px/.test(css), '资源面板 flex-basis 300 保底')
ok(css.includes('.wb-fs-thumb'), '文件夹网格图片缩略图样式')
ok(css.includes('body.work-mode .pane-splitter'), '分割条仅 Work 模式显示')
ok(css.includes('body.work-mode .wb-add-btn'), '加入工作台按钮仅 Work 模式显示')
ok(!css.includes('.wb-item') && !css.includes('.wb-list'), '旧清单卡片样式已移除')

console.log('— Word 一体化编辑（打开即编辑，查找替换内置） —')
ok(appjs.includes('mountWbDocxRich(item) // 打开即编辑'), 'docx 页签打开即进编辑器（无预览中转）')
ok(!appjs.includes('attachWbDocxEdit') && !appjs.includes('attachWbDocxRich') && !appjs.includes('wbOfficeToIframe'), '旧双按钮/只读预览通道已删')
ok(appjs.includes('saveWordRich(item.path, paragraphs)'), '编辑器调用 saveWordRich')
ok(!appjs.includes('renderWbFolderFile') && !appjs.includes('previewPath'), '文件夹临时预览通道已删（双击=入台打开）')
ok(mainjs.includes('docxLockError'), 'main 有文件占用检测（WPS/Word 锁→人话提示）')
ok(mainjs.includes("require('./ai/office')"), '保存复用 ai/office modifyDocx 引擎')
ok(mainjs.includes('fs:wait-file-change'), 'main 有外部保存监听（轮询 mtime）')
ok(mainjs.includes('fs:file-mtime'), 'main 有 fs:file-mtime')
ok(preload.includes('fileMtime:'), 'preload 暴露 fileMtime')
ok(preload.includes('waitFileChange:'), 'preload 暴露 waitFileChange')
ok(preload.includes('saveWordRich:'), 'preload 暴露 saveWordRich')
ok(appjs.includes("iconSvg('external-link') + ' 外部编辑'"), '编辑器带「外部编辑」按钮（WPS/Office 内核兜底，Lucide 图标）')
ok(/mountWbDocxRich\(item\)\s*\}\s*\}\)/.test(appjs), '外部保存后自动重新载入')
ok(appjs.includes('wb-docx-repl'), '编辑器内置查找替换面板')
ok(appjs.includes('function replaceInEditor') || appjs.includes('const replaceInEditor'), '查找替换走编辑器 DOM 替换')
ok(appjs.includes('createTreeWalker(rootEl, NodeFilter.SHOW_TEXT)'), 'DOM 替换遍历文本节点（v2.5.1：高保真模式按 article 正文遍历）')
ok(appjs.includes('attachWbTextQuote(ed, item.name)'), '编辑器划词仍可「添加到对话」')
ok(appjs.includes('markDirty'), '未保存脏标记')
{
  const office = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
  ok(office.includes('c.noTitle ? []'), 'office 引擎支持免标题生成（noTitle）')
}
ok(css.includes('.wb-docx-rte'), 'CSS 含编辑区样式')
ok(css.includes('.wb-docx-repl'), 'CSS 含查找替换面板样式')

console.log('— v2.4.37：聊天记录拖拽 + 输入框动态增高 + WPS/Word 内嵌 —')
// ① 微信/QQ 拖文字消息 → 引用块
ok(appjs.includes("buildQuoteRef('聊天记录', text)"), '拖入文字走引用块体系')
ok(appjs.includes("types.includes('text/plain') || types.includes('text/html')"), 'dragover 接受外部文字拖入')
ok(appjs.includes('replace(/<br\\s*\\/?>/gi'), '富文本剥壳取纯文本')
// ② 聊天框动态增高
ok(appjs.includes('fitChatInput'), '定义 fitChatInput 动态增高')
ok(appjs.includes('window.innerHeight * 0.4'), '增高上限 40vh')
ok(appjs.includes('chatInput.addEventListener(\'input\', fitChatInput)'), '输入事件触发增高')
ok(css.includes('/* 动态增高由 JS 控') && !css.includes('max-height: 110px'), 'CSS 旧固定高度上限已移除')
// ③ WPS/Word 内嵌（winembed 引擎）
{
  const we = fs.readFileSync(path.join(ROOT, 'ai/winembed.js'), 'utf8')
  ok(we.includes('function progIdToKind'), 'winembed: ProgId 判定')
  ok(we.includes('function detectDocxHandler'), 'winembed: 注册表探测默认程序')
  ok(we.includes('UserChoice'), 'winembed: 优先 UserChoice 关联')
  ok(we.includes('class EmbedManager'), 'winembed: 帮手管理器')
  ok(we.includes("spawn('powershell.exe'"), 'winembed: PowerShell 帮手')
  ok(we.includes('SetParent'), 'winembed: SetParent 钉窗')
  ok(we.includes('EnumWindows'), 'winembed: 枚举窗口抓目标')
  ok(we.includes('waitersQ'), 'winembed: FIFO 响应队列（串行协议）')
  ok(we.includes("Start-Process -FilePath $exe"), '帮手：exe 启动文档')
  ok(we.includes("Contains($baseName"), '帮手：标题含名抓窗（覆盖 ksolaunch 委托，Contains 兼容 WPS 标题格式）')
  ok(we.includes("SetParent($child, [IntPtr]::Zero)"), '帮手退出：窗口还回桌面不丢文档')
  // 纯函数真跑
  ok(we && progIdToKind('WPS.Docx') === 'wps' && progIdToKind('Word.Document.12') === 'word' && progIdToKind('AcroExch.Document') === null, 'winembed: ProgId 判定真跑')
  ok(exeFromCommand('"C:\\Program Files\\wps.exe" /u "%1"') === 'C:\\Program Files\\wps.exe', 'winembed: exe 提取真跑')
}
ok(mainjs.includes("require('./ai/winembed')"), 'main 挂载 winembed')
ok(mainjs.includes("ipcMain.handle('docx:embed'"), 'main 有 docx:embed IPC')
ok(mainjs.includes('embedManager.quit()'), '退出时收掉帮手（窗口还桌面）')
ok(preload.includes('docxHandler:') && preload.includes('docxEmbed:') && preload.includes('docxEmbedClose:'), 'preload 暴露 embed API')
ok(appjs.includes('function mountWbDocxEmbed'), '渲染层内嵌视图')
ok(appjs.includes('_api.docxHandler()'), 'docx 打开自动探测默认程序')
ok(appjs.includes('function wbEmbedSync') && appjs.includes('function wbEmbedKill'), '内嵌生命周期：切页签 HIDE / 移除换会话 CLOSE')
ok(appjs.includes("wbEmbed.alive && wbEmbed.key === key"), '切回页签直接亮出嵌入窗口')
ok(appjs.includes('new ResizeObserver'), 'ResizeObserver 同步窗口位置')
ok(appjs.includes('docxEmbedAlive'), '存活轮询（用户关窗收尾）')
ok(appjs.includes('内置编辑'), '内嵌失败/主动切换可回内置编辑器')
ok(appjs.includes('waitFileChange(item.path, base && base.mtimeMs, 300000)'), '内嵌失败回退外部打开+保存自动刷新')
ok(css.includes('.wb-embed-host'), 'CSS 含内嵌占位区样式')

console.log('— v2.8.5+：编辑器四件套 + 文件改动刷新 + 回档确认卡 —')
const agentSrc = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
const toolsSrc = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
const mainCss = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')
ok(appjs.includes('foldGutter: !isMd') && appjs.includes("gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']"), 'CodeMirror 代码折叠（md 不折叠）')
ok(html.includes('vendor/codemirror/addon/fold/foldcode.js') && html.includes('vendor/codemirror/addon/search/search.js') && html.includes('vendor/codemirror/addon/hint/show-hint.js'), 'index.html 引折叠/搜索/补全 addon（9 script）')
ok(appjs.includes('CodeMirror.hint.anyword') && appjs.includes("on('inputRead'"), '单词自动补全（anyword 键控+输入触发）')
ok(appjs.includes('wb-cm-status') && appjs.includes('cmLangLabel'), '状态条（行:列·语言·缩进档）')
ok(mainCss.includes('.CodeMirror-line::selection') && mainCss.includes('background: #89b4fa') && mainCss.includes('color: #11111b'), '选区负片模式（实心紫底+深色字）')
ok(!mainCss.includes('repeating-linear-gradient') && mainCss.includes('.cm-type-x'), '参考线已改按行画（CSS 无全局渐变）+ 类型染色样式')
ok(appjs.includes('onAiFileChanged') && appjs.includes('delete wbEditors[key]; delete wbGrids[key]; delete wbHtmlModes[key]'), 'AI 改文件→工作台页签自动刷新（渲染层失效重载）')
ok(toolsSrc.includes('FILE_CHANGE_TOOLS') && toolsSrc.includes('function changedPathsOf'), 'tools 执行成功后发 file-changed（改/删/复制/移动路径提取）')
ok(appjs.includes('aiRollbackPreview') && appjs.includes('showRollbackConfirm') && appjs.includes('rb-card') && appjs.includes('rollbackConfirmCard'), '回档 Trae 式确认卡（内嵌聊天流+预览清单+取消/确认）')
ok(agentSrc.includes('rollbackPreview') && agentSrc.includes('undoChangePaths') && agentSrc.includes('undoPreviewItem'), 'agent 回滚预览（清单/受影响路径提取）')
ok(agentSrc.includes('this.plan = null') && agentSrc.includes('this.createdPaths = new Set()'), '回滚后任务清单板/防重档重置')
ok(agentSrc.includes("typeof this.onFileChanged === 'function'"), '回滚落盘后发 file-changed（界面不残留旧内容）')
ok(appjs.includes('cmTypeOverlay') && appjs.includes('cm.addOverlay(cmTypeOverlay)'), '类型/注解语义复染层（大写=类，Trae 思路）')
ok(appjs.includes("on('renderLine'") && appjs.includes('defaultCharWidth'), '缩进参考线按行按档画（renderLine，顶格不画）')
ok(appjs.includes('wbGotoFileLine') && appjs.includes('err-loc') && toolsSrc.includes('extractErrLocs'), '报错行号可点击跳工作台对应行（诊断闭环）')
ok(toolsSrc.includes("name: 'dev_server'") && toolsSrc.includes('devServers'), 'dev_server 长驻开发进程工具（start/stop/list）')
ok(toolsSrc.includes("name: 'git'") && toolsSrc.includes("action === 'commit'"), 'git 版本底座工具（status/diff/commit/log）')
ok(mainSrc.includes('TextDecoder(') && mainSrc.includes('gbk'), '工作台读文件 GBK 兜底（中文注释不再乱码）')
ok(appjs.includes('wb-err-line') && appjs.includes('addLineClass'), '报错行红标（跳转挂标，行背景+行号红）')
ok(appjs.includes('DEV_URL_RE') && appjs.includes("addUrlTab(url.dataset.url)"), 'dev_server 端口一键预览（localhost 可点击开 AI 浏览器）')
ok(appjs.includes('rbRerun') && appjs.includes('回滚并重跑') && appjs.includes('send.click()'), '回滚并重跑（Trae 回退即重新开始）')
ok(toolsSrc.includes('impl[name].call(impl, clean)'), '工具调用保住 this（desktop_* 不再全瘫）')
ok(appjs.includes('getWebContentsId() === payload.wcId') && mainSrc.includes('wcId: wc.id'), '受控页签内导航（AI 感知得到新窗口）')
ok(appjs.includes("'新对话', '未命名会话']"), '会话自动取名豁免对齐主进程默认名')
ok(fs.readFileSync(path.join(ROOT, 'ai/desktop-control.js'), 'utf8').includes('_checkUserBusy') && fs.readFileSync(path.join(ROOT, 'ai/desktop-control.js'), 'utf8').includes('userBusy: true'), 'desktop_* 用户占用避让（鼠标动了就停手）')
ok(fs.readFileSync(path.join(ROOT, 'src/control-overlay.html'), 'utf8').includes('请勿操作鼠标键盘'), '控制遮罩提示"请勿操作鼠标键盘"')
ok(fs.readFileSync(path.join(ROOT, 'ai/manuals/电脑控制.md'), 'utf8').includes('前台占用铁律'), '手册：前台占用铁律（浏览器任务走 browser_*）')

console.log('— v2.4.33：卡片进工作台 + 资源管理器定位 + 划词胶囊 —')
ok(appjs.includes('点击加入工作台预览'), '聊天文件卡片点击改为加入工作台')
ok(appjs.includes('_api.fsExists(norm)'), '卡片点击前确认文件存在（失效路径不进工作台）')
ok(appjs.includes("document.getElementById('modeWork')"), '非 Work 模式点卡片自动切 Work')
ok(appjs.includes('function attachWbTextQuote'), 'app.js 定义 attachWbTextQuote()')
ok(appjs.includes('attachWbCmQuote(cm, item.name)'), '文本编辑器挂划词胶囊（CodeMirror 版）')
ok(appjs.includes('function attachWbCmQuote') && appjs.includes('cm.getSelection()'), 'CodeMirror 划词取选区（cm.getSelection）')
ok(appjs.includes('function cmModeOf') && appjs.includes("java: 'text/x-java'"), 'cmModeOf 扩展名→语法 mode 映射')
ok(appjs.includes('function wbCmMount') && appjs.includes('lineNumbers: true'), '编辑器升级 CodeMirror（行号+高亮，v2.8.5）')
ok(html.includes('vendor/codemirror/codemirror.js') && html.includes('vendor/codemirror/addon/edit/closebrackets.js'), 'index.html 引 CodeMirror vendor（核心+addon）')
ok(appjs.includes('if (!_wbQuoteCap) {') || appjs.includes('function ensureWbQuoteCap'), '胶囊单例（切页重建编辑器不泄漏）')
ok(appjs.includes('来自文件 ${fileName} 的划选'), '插入输入框带来源文件名引用块')
ok(html.includes('id="wbLocateBtn"'), '工作台工具条含资源管理器定位按钮')
ok(appjs.includes("$('wbLocateBtn').addEventListener"), 'wbLocateBtn 绑定打开事件')
ok(appjs.includes("it.origin !== 'local') { showToast('远程文件请先取回本机再定位'"), '远程文件定位兜底提示')
ok(appjs.includes("$('wbLocateBtn').classList.toggle('hidden', it.origin !== 'local')"), '定位按钮仅本地文件显示')
{
  const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
  ok(readManual('word文档.md').includes('只为知道内容时纯文本直读'), '提示词含阅读加固条款（不解析富文本）→ 手册 word文档.md')
}
for (const cls of ['.wb-quote-cap']) ok(css.includes(cls), `CSS 含 ${cls}`)

console.log('— v2.4.34：胶囊体系 + docx 划词 + 所见即所得 —')
ok(appjs.includes('来自文件 ${_wbQuoteFile} 的划选]\\n') || appjs.includes('buildQuoteRef'), '划选 ref 构造器 buildQuoteRef')
ok(appjs.includes('function ensureWbQuoteCap'), '胶囊单例提取 ensureWbQuoteCap()')
ok(appjs.includes("work._appendChatRef(ref) // 引用胶囊 chip"), '添加到对话走引用胶囊体系')
ok(appjs.includes("mQuote = /^\\[来自文件 (.+) 的划选\\]$/.exec(first)"), 'refChipMeta 识别划选引用')
ok(appjs.includes('quoteBuf = { marker: t, lines: [] }'), '聊天记录渲染收拢划选引用块')
ok(appjs.includes("attachWbTextQuote(chatInput, '聊天记录')") && appjs.includes("attachWbTextQuote(chatList, '聊天记录')"), '聊天框/聊天记录内划词可用')
ok(appjs.includes('function mountWbDocxRich'), 'app.js 定义所见即所得编辑器')
ok(appjs.includes('function htmlToWordParas'), 'HTML→段落/runs 转换器')
ok(appjs.includes("cmd('formatBlock', `<${tag}>`)"), '格式工具条（标题/加粗/列表等）')
ok(mainjs.includes("ipcMain.handle('fs:word-rich-save'"), 'main 有 fs:word-rich-save')
ok(mainjs.includes('wbimg-'), 'data URI 图片落临时文件再嵌回')
ok(mainjs.includes("noTitle: true"), '所见即所得保存不重复插标题')
ok(preload.includes('saveWordRich:'), 'preload 暴露 saveWordRich')
{
  const office = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
  ok(office.includes('c.noTitle ? []'), 'office 引擎支持免标题生成（noTitle）')
}
ok(css.includes('.wb-docx-rte'), 'CSS 含所见即所得编辑区样式')

console.log('— v2.4.35：会话切换工作台隔离 + 双击自动入台 —')
// ① 预览残留：无激活项强制重绘
ok(appjs.includes('if (it && wbRenderedKey === wbActiveKey && body.querySelector'), '空工作台强制重绘（旧会话预览不残留）')
// ② 写串：wbPersist 排程锁定会话 + 触发时校验 + 切走前冲刷
ok(appjs.includes('let wbPersistSid = null'), 'wbPersist 排程锁定归属会话')
ok(appjs.includes('if (work.active !== wbPersistSid) return'), '会话已切走不再写入（防清单串进新会话）')
ok(appjs.includes('async function wbPersistFlush'), '定义 wbPersistFlush 冲刷')
ok(appjs.includes('await wbPersistFlush() // 切走前把待写工作台清单落回旧会话'), 'activateSession 切换前冲刷')
// ③ 加载竞态：序号守卫
ok(appjs.includes('let wbLoadSeq = 0'), 'loadWorkbench 序号守卫定义')
ok((appjs.match(/if \(seq !== wbLoadSeq\) return/g) || []).length >= 2, '加载结果过期即作废（await 前后双校验）')
// ④ 双击自动入台
ok(appjs.includes('双击=收进工作台并打开'), '文件夹双击=自动加入工作台并打开')
ok(appjs.includes('addToWorkbench([{ path: e.path, name: e.name, isDir: false, size: e.size || 0 }]'), '双击新文件走 addToWorkbench')
ok(/wbActiveKey = wk\s*renderWorkbench\(\)/.test(appjs), '双击已在台内文件直接激活页签')
// ⑤ navs 持久化链路修复
ok(mainjs.includes('JSON.stringify({ items, navs, savedAt: Date.now() })'), 'wb:set 落盘含 navs')
ok(mainjs.includes('{ items: data.items, navs: data.navs || {} }'), 'wb:get 返回 navs')
ok(preload.includes("wbSet: (sessionId, data) => ipcRenderer.invoke('wb:set', { sessionId, ...(data || {}) })"), 'preload wbSet 透传 navs')
// ⑥ 死样式清理
ok(!css.includes('.wb-fs-file-view') && !css.includes('.wb-fs-file-body') && !css.includes('.wb-fs-navbtns') && !css.includes('.wb-fs-count'), '文件夹临时预览死样式已清')

console.log('— v2.4.38：网页版模型（[网页]DeepSeek 内嵌网页自动对话）+ 多平台 Key 档案 —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  // ① 主进程：webview 开关 + 网页对话桥
  ok(mainjs.includes('webviewTag: true'), 'main.js 开启 webviewTag')
  ok(mainjs.includes("mainWindow.webContents.send('ai:webchat-ask'"), 'main 转发网页对话请求到渲染层')
  ok(mainjs.includes("ipcMain.handle('ai:webchat-chunk'"), 'main 有 ai:webchat-chunk 通道')
  ok(mainjs.includes("ipcMain.handle('ai:webchat-done'"), 'main 有 ai:webchat-done 通道')
  ok(mainjs.includes("ipcMain.handle('ai:webchat-error'"), 'main 有 ai:webchat-error 通道')
  // ② agent：模型来源路由 + 网页纯聊天分支
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const { parseModelRoute } = require(path.join(ROOT, 'ai/agent.js'))
  ok(agent.includes('function parseModelRoute'), 'agent 定义 parseModelRoute')
  ok(parseModelRoute('[官方]deepseek-chat').provider === 'deepseek' && parseModelRoute('[官方]deepseek-chat').model === 'deepseek-chat', '路由解析 [官方] 前缀')
  ok(parseModelRoute('[硅基流动]deepseek-ai/DeepSeek-V3').provider === 'siliconflow', '路由解析 [硅基流动] 前缀')
  ok(parseModelRoute('[网页]DeepSeek').isWeb === true, '路由识别 [网页] 前缀')
  ok(parseModelRoute('deepseek-chat').isWeb === false && parseModelRoute('deepseek-chat').tag === null, '无前缀模型兼容旧配置')
  ok(agent.includes('providerProfile(provider)'), 'agent 多平台档案读取')
  ok(agent.includes('async webChatTurn('), 'agent 网页单轮调用器（v2.4.44 起接入工具循环）')
  ok(agent.includes('onWebChatChunk(delta)') && agent.includes('onWebChatDone(text)') && agent.includes('onWebChatError(error)'), 'agent 网页回调三件套')
  ok(agent.includes("this.send({ type: 'content_delta', delta: String(delta || '') })"), '网页回复走 content_delta 管线')
  ok(agent.includes('if (this._webChatResolve)'), 'abort 中断网页对话等待')
  ok(agent.includes("'aiProfiles'"), 'agent 读写多平台档案 aiProfiles')
  // ③ 渲染层：网页引擎 + 工作台 webapp 页签
  ok(webchat.includes("createElement('webview')"), 'webchat.js 创建 webview')
  ok(webchat.includes("persist:wbweb-deepseek"), 'webview 会话持久化分区（登录一次一直有效）')
  ok(webchat.includes("localStorage.getItem('userToken')"), '登录态检测 userToken')
  ok(webchat.includes('.ds-markdown'), '回复 DOM 抓取钩子（ds-markdown）')
  ok(webchat.includes('HTMLTextAreaElement.prototype'), 'native setter 填输入框（绕 React）')
  ok(webchat.includes('window.__mswbTake'), '页面事件轮询通道')
  ok(webchat.includes('onNeedLogin'), '未登录回调（引导激活页签登录）')
  ok(appjs.includes('function addWebAppToWorkbench'), 'app.js 定义 addWebAppToWorkbench')
  ok(appjs.includes("it.kind === 'webapp' && typeof WbWebChat !== 'undefined'"), 'renderWbView 网页页签分支（只显隐不销毁）')
  ok(appjs.includes("WbWebChat.show(it.web || 'deepseek')") && appjs.includes('WbWebChat.hide()'), '网页层随页签显隐')
  ok(appjs.includes("if (item.kind === 'webapp') { // 网页版页签由 WbWebChat 层接管"), 'openPreview 拦截 webapp（v2.4.83 双保险清悬浮控件）')
  ok(appjs.includes("it.kind === 'webapp' && typeof WbWebChat !== 'undefined') WbWebChat.destroy"), '移出网页页签销毁引擎')
  ok(appjs.includes("_api.onAiWebchatAsk(({ sessionId, prompt, attachments, newSession, resumeUrl })"), 'app.js 接收网页对话请求（含附件/新会话/恢复对话标记）')
  ok(appjs.includes('_api.webchatChunk(sessionId'), '引擎流式回传主进程')
  ok(html.includes('id="aiWebDeepseekBtn"'), 'HTML 含网页版启用按钮')
  ok(html.includes('src="js/webchat.js"'), 'HTML 引入 webchat.js')
  ok(css.includes('.wb-web-layer') && css.includes('.wb-web-badge'), 'CSS 含网页层与状态徽标样式')
  ok(preload.includes('onAiWebchatAsk:') && preload.includes('webchatChunk:'), 'preload 暴露网页对话通道')
  // ④ 设置：多平台 Key 档案
  ok(appjs.includes('let aiCfgCache = null'), '设置页配置快照（档案化 Key 展示）')
  ok(appjs.includes("keyInput.placeholder = (prof && prof.hasKey)"), '服务商切换显示该平台 Key 状态')
  ok(appjs.includes('function toggleWebDeepseek'), '网页版启用/停用开关')
  ok(appjs.includes("getSetting('aiWebDeepseek')"), '网页版开关持久化')
}

console.log('— v2.4.46：网页页签铺满 + 网页端代码块包装修复（围栏重建三道防线） —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const agentSrc = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const { extractJsonAt, rebuildWebToolFences, WorkAgent } = require(path.join(ROOT, 'ai/agent.js'))
  ok(typeof extractJsonAt === 'function' && typeof rebuildWebToolFences === 'function', 'agent 导出网页清洗函数（可真跑）')
  // ① 图1：通用网页页签 webview 必须挂 wb-web-view（无样式 webview 默认 150px 高 → 只占顶部一条）
  ok(appjs.includes("el.className = 'wb-web-view' // 必须挂样式"), '通用网页页签 webview 挂 wb-web-view 铺满样式')
  ok(css.includes('.wb-web-view {'), 'CSS 有 wb-web-view 铺满规则')
  // ② 页面侧 DOM 重建（主防线）：不能用 innerText 整把抓（围栏丢失+按钮混入）
  ok(webchat.includes('const text = extractMd(el)'), 'report 用 extractMd 重建（不再 innerText 整把抓）')
  ok(webchat.includes('const extractMd'), '页面侧定义 extractMd（DOM 块级重建）')
  ok(webchat.includes("match(/language-"), '语言标签识别 code.language-xxx')
  ok(webchat.includes("/复制|下载|展开|收起|折叠|复制代码|下载代码/g"), 'header 剥按钮词（复制/下载）')
  // ③ 宿主侧兜底（agent.js）：无围栏 "tool\n复制\n下载\n{...}" → 重建围栏（图2 实况形态）
  const dirty = '非常抱歉，我之前的格式总是出错。\n\ntool\n复制\n下载\n{"name":"list_dir","arguments":{"path":"C:\\\\Users\\\\ars\\\\Desktop"}}\n\n我这次严格按照这个格式来创建：'
  const rebuilt = rebuildWebToolFences(dirty)
  ok(rebuilt.includes('```tool') && !rebuilt.includes('复制'), '宿主兜底：无围栏+按钮文本 → 重建 ```tool 围栏并剥按钮')
  const parsed = WorkAgent.prototype.parseToolCalls(rebuilt)
  ok(Array.isArray(parsed) && parsed[0] && parsed[0].name === 'list_dir' && parsed[0].args.path === 'C:\\Users\\ars\\Desktop', '图2 实况全文解析出 list_dir 调用（不再死循环重写）')
  // 嵌套 JSON + 字符串内花括号不截断（括号配对扫描）
  const nested = 'tool\n复制\n下载\n{"name":"write_file","arguments":{"path":"a.md","content":"含 } 和 { 的文本"}}'
  const p2 = WorkAgent.prototype.parseToolCalls(rebuildWebToolFences(nested))
  ok(Array.isArray(p2) && p2[0].name === 'write_file' && p2[0].args.content === '含 } 和 { 的文本', '嵌套/字符串花括号 JSON 完整提取不截断')
  // 已有围栏 → 不动（防重复清洗）
  const fenced = '正文\n```tool\n{"name":"list_dir","arguments":{}}\n```\n尾'
  ok(rebuildWebToolFences(fenced) === fenced, '已有围栏时信任页面侧结果不重复清洗')
  // 裸 ```（无语言标签）/```json 围栏包工具 JSON → parseToolCalls 兜底识别
  ok((WorkAgent.prototype.parseToolCalls('```\n{"name":"create_folder","arguments":{"path":"x"}}\n```') || [])[0]?.name === 'create_folder', '裸围栏 JSON 兜底识别（语言标签丢失场景）')
  ok((WorkAgent.prototype.parseToolCalls('```json\n{"name":"list_dir","arguments":{"path":"x"}}\n```') || [])[0]?.name === 'list_dir', '```json 围栏工具调用兜底识别')
  // 普通代码块不误判
  ok(WorkAgent.prototype.parseToolCalls('```python\nprint("name: x")\n```') === null, '普通代码块不误判为工具调用')
  // ⑤ arguments 双重编码兜底（真机实锤：DeepSeek 偶发输出 "arguments":"{\"path\":...}" 字符串，
  //   不兜底则参数全 undefined —— create_folder/list_dir 连续 3 次全失败、list_dir 返回盘符列表，网页版成"瞎子"）
  const pDouble = WorkAgent.prototype.parseToolCalls('```tool\n{"name":"create_folder","arguments":"{\\"path\\":\\"C:\\\\\\\\Users\\\\\\\\ars\\\\\\\\Desktop\\\\\\\\t\\\"}"}\n```')
  ok(Array.isArray(pDouble) && pDouble[0].args && pDouble[0].args.path === 'C:\\Users\\ars\\Desktop\\t', 'arguments 双重编码字符串自动 JSON.parse（参数不再全 undefined）')
  const pBadArgs = WorkAgent.prototype.parseToolCalls('```tool\n{"name":"list_dir","arguments":"not-json"}\n```')
  ok(Array.isArray(pBadArgs) && pBadArgs[0].args && typeof pBadArgs[0].args === 'object', 'arguments 解析失败兜底空对象（不再把字符串当参数对象用）')
  // ④ 超长增量附件化：多工具并行轮 tool_result 拼接 6000+ 字会被网页输入框截断（只剩系统提示没内容）
  ok(agentSrc.includes("'工具结果.md'") && agentSrc.includes("if (!withAttachments) {\n          sendAttachments"), '工具轮一律「系统通知+附件《工具结果.md》」模式（v2.4.52 不看文本大小：输入框只放引导语，彻底杜绝输入框截断）')
  ok(agentSrc.includes('let sendAttachments = attachments') && agentSrc.includes('sendAttachments = [...(attachments || []), { name'), '附件转换保留首轮规则附件不丢失')
  // tool 行后非 JSON → 原样保留不误建
  ok(!rebuildWebToolFences('这是一个 tool\n的用法说明').includes('```tool'), '正文巧合 tool 行不误建围栏')
  // ④ parseToolCalls 仍在主循环原位调用（网页/API 同权）
  ok(agentSrc.includes('const calls = this.parseToolCalls(content)'), '主循环仍经 parseToolCalls 统一解析')
  // ⑤ 注入代码验证（踩坑回归）：外层模板串会吞 \w 与 \n 转义——求值后必须语法合法、围栏/正则正确
  const iHook = webchat.indexOf('const hook = `')
  let hook = null
  if (iHook >= 0) {
    try { hook = eval(webchat.slice(iHook + 'const hook ='.length, webchat.indexOf('`', iHook + 'const hook = '.length + 1) + 1).trim()) } catch {}
  }
  ok(hook && (() => { try { new Function(hook); return true } catch { return false } })(), '注入页面钩子求值后语法合法（模板串转义未炸）')
  ok(hook && hook.includes("const FENCE = '```'"), '注入代码围栏字符正确（u0060 转义求值）')
  ok(hook && hook.includes('/^[\\w#+.-]{1,15}$/'), '语言标签正则保留反斜杠w（外层模板串不吞转义）')
  // ⑥ extractMd DOM stub 真跑：三种消息形态 → 围栏重建
  {
    const seg = hook.slice(hook.indexOf('const FENCE'), hook.indexOf('const bump')) + '\n;globalThis.__mswbExtractMd = extractMd'
    ;(0, eval)(seg)
    const extractMd = globalThis.__mswbExtractMd
    const make = (tag, o = {}) => ({
      tagName: tag, innerText: o.text || '', className: o.cls || '', children: o.children || [],
      contains(x) { if (x === null) return false; if (x === this) return true; return this.children.some((c) => (c.contains ? c.contains(x) : c === x)) },
      querySelector(sel) {
        const want = sel.toUpperCase()
        for (const c of this.children) {
          if (c.tagName === want) return c
          if (c.querySelector) { const r = c.querySelector(sel); if (r) return r }
        }
        return null
      }
    })
    const toolBlock = (lang, code, cls) => make('DIV', { children: [make('DIV', { text: lang + ' 复制 下载' }), make('PRE', { children: [make('CODE', { cls: cls || '', text: code })] })] })
    const r1 = extractMd(make('DIV', { children: [make('P', { text: '我这次严格按照格式：' }), toolBlock('tool', '{"name":"create_folder","arguments":{"path":"x"}}')] }))
    ok(r1.includes('```tool\n{"name":"create_folder"') && WorkAgent.prototype.parseToolCalls(r1)[0].name === 'create_folder', 'extractMd：header 语言标签 → ```tool 围栏（图2 形态全链路解析）')
    const r2 = extractMd(make('DIV', { children: [toolBlock('json', '{"a":1}', 'language-json')] }))
    ok(r2.includes('```json'), 'extractMd：code.language-xxx class 优先识别')
    const r3 = extractMd(make('DIV', { children: [toolBlock('', '{"name":"list_dir","arguments":{}}')] }))
    ok(r3.includes('```\n{') && (WorkAgent.prototype.parseToolCalls(r3) || [])[0].name === 'list_dir', 'extractMd：无语言标签 → 裸围栏仍可被宿主解析（第三道防线衔接）')
    ok(extractMd(make('DIV', { text: '纯文本回复' })) === '纯文本回复', 'extractMd：纯文本原样透传')
  }
  // ⑦ v2.4.46 补丁：抓取时序与参数清洗（真机"下载火影壁纸"卡死排查）
  const urlDirty = '```tool\n{"name":"web_fetch","arguments":{"url":"`https://www.alphacoders.com/search/naruto`","mode":"links"}}\n```'
  const pUrl = WorkAgent.prototype.parseToolCalls(urlDirty)
  ok(Array.isArray(pUrl) && pUrl[0].args.url === 'https://www.alphacoders.com/search/naruto', 'url 参数反引号清洗（DeepSeek 行内代码习惯，不清洗必超时）')
  ok(webchat.includes('window.__mswbFingerprint') && webchat.includes("slice(0, fp.length) === fp"), 'user 回显指纹排除（防把 tool_result 提示当回复误抓）')
  ok(!webchat.includes('think-content'), '不按 think 容器跳过（深度思考模式正文会被连坐 → 整轮零抓取 25s 误杀，真机卡死实锤）')
  ok(webchat.includes('fullLen !== lastFullLen'), '全文变短也算进展（防 4.5s 兜底提前截断）')
  ok(webchat.includes("!out.gotChunk && out.state === 'idle' && Date.now() - sentAt > 150000"), '渲染停+150s 零 chunk 才兜底（排队/深度思考/搜索慢启动期页面可几十秒无 DOM 变化，过早硬杀=回复流出前误报没内容）')
  ok(webchat.includes("out.full && out.gotChunk && out.state === 'idle' && Date.now() - lastProgressAt > 4500"), '4.5s 无进展完成判定带 state=idle 门槛（流式节奏空档不提前 finish）')
  ok(webchat.includes('__mswbProbe') && webchat.includes("(window.__mswbProbe ? window.__mswbProbe() : \"\")"), '报空前 __mswbProbe 直读 DOM 抢救已流出的回复（兼自愈事件管道死亡）')
  ok(!webchat.includes('__mswbCount'), '新回复判定弃用节点总数（长会话虚拟滚动下节点总数不再单调增长 → count 门槛整轮零抓取 → 150s 超时报"没有返回"，真机 7 个行动后卡死实锤）')
  ok(webchat.includes('window.__mswbAnchor') && webchat.includes('el === window.__mswbAnchor'), 'report 用节点锚点判定新回复（最后节点 !== reset 时锚点 = 新回复，不受虚拟化节点总数波动影响）')
  ok(webchat.includes('window.__mswbAnchorText'), '锚点文本快照防重建误抓（旧回复 re-render 后引用变化但内容不变，不得当新回复）')
  ok(webchat.includes('if (el === window.__mswbAnchor) break'), 'probe 以锚点划界（碰到锚点即止，其后才算新回复，防慢启动期捞到上一轮全文）')
  ok(webchat.includes('}, sentAt)'), 'startPolling 接收 sentAt 计时起点')
  ok(agentSrc.includes('_webConvStarted') && agentSrc.includes('newSession: firstTurn'), '网页会话复用：newSession 仍只首次开新会话（_webConvStarted 标记）')
  ok(agentSrc.includes("if (withAttachments) {\n      // 规则附件") || /attachments = \[\{ name: 'MSMate规则\.md'/.test(agentSrc), '规则附件每个用户消息轮都带（v2.4.50：只首轮带一次会被长任务上下文稀释丢规则）')
  ok(agentSrc.includes('WEB_TURN_REMINDER') && agentSrc.includes("content: String(text) + '\\n\\n----\\n\\n' + WEB_TURN_REMINDER"), '格式提醒随工具结果附件每轮下发（不进本地 history）')
  ok(agentSrc.includes('_webChatRetried') && agentSrc.includes('return await this.webChatTurn(retryText, withAttachments)'), '网页空返回自动重发 1 次再报错（v2.4.80 起重发带纠偏话术拉回 tool 代码块正道）')
  // 对话恢复 + 多会话联动（v2.4.52）：网页对话 URL 随会话持久化，重启/切会话自动导航回原对话
  ok(agentSrc.includes('firstTurn = !!withAttachments && !this._webConvStarted && !this._webConvUrl'), '有持久化对话 URL 时不新开网页会话（重启不再失忆）')
  ok(agentSrc.includes("resumeUrl: firstTurn ? '' : String(this._webConvUrl || '')"), '非首轮下发 resumeUrl（渲染层自动导航回原对话）')
  ok(agentSrc.includes('onWebChatConv(url)') && agentSrc.includes('/chat\\.deepseek\\.com\\/a\\/chat\\/s\\//.test(u)'), 'onWebChatConv 校验并记录网页对话 URL')
  ok(agentSrc.includes('webConvUrl: this._webConvUrl') && agentSrc.includes("this._webConvUrl = String(data.webConvUrl || '')"), 'webConvUrl 随会话存档持久化/恢复')
  ok(agentSrc.includes("this._webConvUrl = ''      // 清空聊天"), 'clearChat 同步清空网页对话记录（下次开新对话）')
  ok(webchat.includes('url: location.href') && webchat.includes('lastConvUrl'), '页面引擎 take 返回对话 URL，变化才上报（onConvUrl）')
  ok(webchat.includes('cur !== resumeUrl') && webchat.includes('await v.el.loadURL(resumeUrl)'), 'send 恢复导航：页面不在目标对话就 loadURL 回去（冷启动抓不到也导航）')
  ok(appjs.includes('onConvUrl: (url) => _api.webchatConv(sessionId, url)'), 'app.js 转发 onConvUrl → IPC')
  ok(preload.includes('webchatConv: (sessionId, url)') && mainjs.includes("'ai:webchat-conv'"), 'preload/main 通道 ai:webchat-conv 齐备')

  // ⑧ v2.4.46 补丁4：webview 弹窗拦截转工作台页签 + allowpopups 布尔属性语义
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  ok(appjs.includes("el.setAttribute('allowpopups', 'true')"), 'urltab webview 挂 allowpopups（布尔属性存在即生效，弹窗统一交主进程裁决）')
  ok(webchat.includes("el.setAttribute('allowpopups', 'true')"), 'DeepSeek webview 挂 allowpopups（写 "false" 也会开启，语义要写对）')
  ok(mainSrc.includes("wc.getType() !== 'webview'") && mainSrc.includes('setWindowOpenHandler'), '主进程拦截 webview 弹窗（点链接不再弹系统新窗口）')
  ok(mainSrc.includes("mainWindow.webContents.send('ai:workbench-open', { kind: 'url', url"), '弹窗 URL 复用 ai:workbench-open 通道转工作台网页页签')
  ok(mainSrc.includes("return { action: 'deny' }"), '弹窗一律 deny（进页签或丢弃，绝不开真窗口）')
}

console.log('— v2.4.39：生成模式（生图/生视频）+ 网页版规则注入 + WPS 中文路径修复 —')
{
  const winembed = fs.readFileSync(path.join(ROOT, 'ai/winembed.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n')
  // ① WPS 内嵌中文路径：StreamReader UTF-8（[Console]::InputEncoding 在重定向 stdin 下不生效）
  ok(winembed.includes('StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)'), 'winembed 帮手按 UTF-8 读 stdin（中文路径不乱码）')
  ok(winembed.includes('StreamWriter([Console]::OpenStandardOutput()'), 'winembed 帮手按 UTF-8 写 stdout')
  ok(winembed.includes('$line = $sr.ReadLine()'), 'winembed 帮手主循环改用 $sr 读行')
  // ② 生成工具（生图免费 Kolors / 生视频付费 Wan）
  ok(tools.includes("name: 'generate_image'") && tools.includes("name: 'generate_video'"), 'tools 注册 generate_image/generate_video')
  ok(tools.includes('Kwai-Kolors/Kolors'), '生图默认免费模型 Kolors')
  ok(tools.includes('/images/generations') && tools.includes('/video/submit') && tools.includes('/video/status'), '生图/生视频 API 端点')
  ok(tools.includes('function httpJson('), 'tools JSON 请求 helper')
  ok(tools.includes('aiImageModel') && tools.includes('aiVideoModel'), '生成模型可配置（aiImageModel/aiVideoModel）')
  ok(tools.includes("case 'generate_image'") && tools.includes("case 'generate_video'"), 'summarize 生成卡片摘要')
  // ③ agent：生成模式直连 + 网页版规则注入
  ok(agent.includes('async generateMedia(kind, prompt, size, images, batch, polish, steps)'), 'agent 生成模式直连 generateMedia（v2.4.83 画幅；v2.4.84 参考图；v2.4.85 张数/润色；v2.4.89 质量档）')
  ok(agent.includes('this.tools.execute(toolName, args)'), 'generateMedia 复用工具实现（size=菜单选择→提示词解析兜底）')
  ok(agent.includes("send({ type: 'media_done'"), 'agent 发 media_done 事件')
  ok(agent.includes('assembleWebRulesDoc'), 'agent 网页版规则文档构建（v2.4.43 同源化）')
  // ④ IPC 与 preload
  ok(mainjs.includes("ipcMain.handle('ai:generate-image'") && mainjs.includes("ipcMain.handle('ai:generate-video'"), 'main 注册生成 IPC')
  ok(preload.includes('aiGenerateImage:') && preload.includes('aiGenerateVideo:'), 'preload 暴露生成 API')
  // ⑤ 渲染层：上滑菜单 + 模式胶囊 + 发送分流 + 结果渲染
  ok(html.includes('id="chatGenBtn"') && html.includes('id="chatGenMenu"'), 'HTML 含生成按钮与上滑菜单')
  ok(html.includes('data-mode="image"') && html.includes('data-mode="video"'), '菜单项 image/video')
  ok(appjs.includes('function setGenMode(mode)') && appjs.includes('function clearGenMode()'), 'app.js 生成模式状态机')
  ok(appjs.includes("_api.aiGenerateImage(work.active, full, GEN_RATIO_SIZE[work.genRatio] || '', genRefImages, genBatch, work.genPolish === false ? false : undefined, work.genSteps || '30')") && appjs.includes("_api.aiGenerateVideo(work.active, full)"), 'doSend 生成模式分流（v2.4.83 画幅；v2.4.84 参考图；v2.4.85 张数+润色；v2.4.89 质量档）')
  ok(appjs.includes("gen-mode-chip"), '输入框上方生成模式胶囊')
  ok(appjs.includes("case 'media_done'"), 'media_done 事件渲染最终结果')
  ok(appjs.includes('md-img-wrap') && appjs.includes('!\\\\[') || appjs.includes('imgM = t.match'), 'markdown 独立图片行渲染')
  ok(appjs.includes('[A-Za-z]:[\\\\/][^)\\s]+'), 'appendInline 链接支持本地路径（点击打开）')
  ok(css.includes('.gen-menu') && css.includes('.md-img'), 'CSS 含菜单/图片样式')
}

console.log('— v2.4.40：no-window 修复（Contains 匹配/进程复用）+ 网页完成判定（深度思考不误判）+ 规则 .md 每条注入 —')
{
  const winembed = fs.readFileSync(path.join(ROOT, 'ai/winembed.js'), 'utf8')
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  // ① no-window：标题 Contains + 启动器进程退出后继续找 + 12s 等待
  ok(winembed.includes('$t.Contains($baseName)'), 'winembed 窗口标题用 Contains 匹配（WPS 标题格式兼容）')
  ok(!/\$proc\.HasExited\) \{ break \}/.test(winembed), 'winembed 启动器进程退出不再直接放弃（复用进程开窗）')
  ok(winembed.includes('AddSeconds(12)'), 'winembed 窗口等待延长到 12 秒')
  // ② 网页卡住：深度思考期不误判完成
  ok(webchat.includes('window.__mswbGotChunk = true'), 'webchat 记录本轮已收到 chunk')
  ok(webchat.includes('out.full && out.gotChunk'), 'webchat 完成判定要求 gotChunk（思考期不误判）')
  ok(webchat.includes('window.__mswbAnchor = nodes.length ? nodes[nodes.length - 1] : null'), 'webchat reset 记录节点锚点（防上一条回复残留误判；虚拟滚动下节点总数不可靠，锚点=最后节点引用）')
  ok(webchat.includes("}, 4000)"), 'webchat 空闲判定放宽到 4 秒')
  // ③ 规则每条注入（v2.4.43 起改为「MSMate规则.md」附件：同源合成，见 v2.4.43 区断言）
  ok(agent.includes('assembleWebRulesDoc'), 'agent 网页规则走同源合成文档（prompt.js）')
  ok(agent.includes("name: 'MSMate规则.md'"), 'agent 规则以附件形式每条随消息发送')
  ok(agent.includes('NOTES.md'), 'agent 读取大记事本（workspace/NOTES.md）进规则文档')
}

console.log('— v2.4.41：生成模型可配置去硬编码 + 跳步打勾护栏 + webview 节流修复 + no-window 诊断 —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const winembed = fs.readFileSync(path.join(ROOT, 'ai/winembed.js'), 'utf8')
  const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  // ① 生图/视频模型设置项（用户可换模型，不硬编码免费/付费）
  ok(html.includes('id="aiImageModelInput"') && html.includes('id="aiVideoModelInput"'), 'HTML 含生图/视频模型输入框')
  ok(appjs.includes('imageModel: $(') && appjs.includes('videoModel: $('), 'saveAiSettings 保存生图/视频模型')
  ok(agent.includes("this.setSetting('aiImageModel'") && agent.includes("this.setSetting('aiVideoModel'"), 'setConfig 写入生图/视频模型')
  ok(agent.includes("imageModel: this.getSetting('aiImageModel')"), 'getConfig 回读生图/视频模型')
  ok(!html.includes('免费 · Kolors') && !html.includes('付费 · 约¥1/个'), '菜单文案不再硬编码免费/付费')
  ok(!appjs.includes('图片生成 · 免费'), '模式胶囊不再硬编码免费/付费')
  ok(!tools.includes('免费额度'), '工具结果消息不再写免费额度')
  // ② 跳步打勾护栏 + 失败不打勾约束
  ok(agent.includes('禁止先勾后面的步骤'), 'task_plan 跳步打勾硬拒绝')
  ok(tools.includes('严禁跳步'), 'task_plan 工具描述含失败不打勾/禁跳步约束')
  // ③ webview 后台节流（转圈根因）+ 宿主侧完成判定双保险
  ok(webchat.includes('backgroundThrottling=false'), 'webview 禁后台节流（后台页签定时器不被降频）')
  ok(webchat.includes('lastProgressAt'), '宿主侧自有完成判定（不依赖页面定时器）')
  // ④ no-window 诊断
  ok(winembed.includes('no-window;windows='), 'winembed 失败回传检测到的 Office 窗口标题')
  ok(appjs.includes('独立窗口模式'), '降级提示含整合模式引导')
  // ⑤ 空规则不注入（分区空值安全：rules/memory 为空时返回空串，不产生空标题段）
  ok(promptjs.includes('return (rules && rules.length)'), '空规则时分区返回空（不注入空段）')
}

console.log('— v2.4.42：生图 size 校验 + WPS 抓窗去白名单 + 规则附件化（网页传文件） —')
{
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const winembed = fs.readFileSync(path.join(ROOT, 'ai/winembed.js'), 'utf8')
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  // ① 生图 size 严格校验（真机变体：模型传 size:1024 → 硅基流动 50507）
  ok(tools.includes('xX×'), '生图 size 宽x高格式校验（非法回默认 1024x1024）')
  ok(readManual('图片视频.md').includes('不要只传一个数字'), '工具参数描述强调 size 格式 → 手册 图片视频.md')
  // ② WPS 抓窗：不再依赖进程名白名单（新版 wpsoffice 等进程名会漏），标题含文件名直接抓
  ok(!winembed.includes('$namesOk'), 'winembed 移除进程名白名单（任意进程标题含文件名即可）')
  ok(winembed.includes('if ($t2)'), 'no-window 诊断枚举所有可见窗口标题（前 8 个）')
  // ③ 规则 .md 作为附件发网页（老大方案：网页支持传文件，不占正文）
  ok(agent.includes('MSMate规则.md'), 'agent 规则文件以附件形式随消息发送')
  ok(webchat.includes('attachments') && webchat.includes('new DataTransfer()'), 'webchat 支持附件上传（file input 注入）')
  ok(webchat.includes('【附件'), '附件上传失败自动回退拼进消息文本')
  ok(appjs.includes('sessionId, prompt, attachments, newSession, resumeUrl }'), 'webchat-ask 转发附件/新会话/恢复对话标记')
}

console.log('— v2.4.43：网页规则同源化（默认规则+大记事本+用户规则 → 附件）+ 设置入口改大记事本 —')
{
  const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  // ① 同源合成：默认规则 + 用户规则/记忆（复用本地分区） + 大记事本
  ok(promptjs.includes('function assembleWebRulesDoc'), 'prompt.js 新增网页规则文档组装（与本地规则同源）')
  ok(promptjs.includes('系统会真实解析并执行你输出的每一个 tool 代码块'), '网页规则说明工具会被真实执行（v2.4.44 工具循环）')
  ok(agent.includes('assembleWebRulesDoc({ systemPrompt: this.buildSystemPrompt(), bigNotes, devicesBrief: this.buildDevicesBrief() })'), 'agent 规则附件 = 完整 systemPrompt + 设备速查 + 大记事本')
  ok(!agent.includes('buildWebChatPrefix'), '旧文本前缀通道已删（规则走附件）')
  // ② mswork_web_rules.md 体系清除
  ok(!mainjs.includes('mswork_web_rules.md'), 'main 不再读写 mswork_web_rules.md')
  ok(!mainjs.includes('ai:web-rules-open'), 'main 删除 web-rules-open IPC')
  ok(!preload.includes('webRulesOpen'), 'preload 移除 webRulesOpen')
  // ③ 设置入口改「打开大记事本」
  ok(html.includes('打开大记事本'), '设置页入口改「打开大记事本」')
  ok(appjs.includes("await _api.aiOpenNotes()"), '入口复用 aiOpenNotes 通道')
}

console.log('— v2.4.44：网页版接入工具循环（与本地同权：解析 tool 块/审批/护栏全复用） —')
{
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
  // ① 网页模式统一走主工具循环（纯聊天分支已删）
  ok(agent.includes('this._webMode = route.isWeb'), 'sendUserMessage 标记网页模式')
  ok(agent.includes('if (this._webMode) {'), 'runLoop 网页分支（增量发送抓回复）')
  ok(!agent.includes('runWebChat('), '纯聊天分支 runWebChat 已删')
  ok(agent.includes("if (this.history[i].role === 'assistant') { fromIdx = i; break }") && agent.includes('this.history.slice(fromIdx + 1).map((h) => h.content)'), '工具轮增量只发上条助手回复之后的新消息（网页会话自己有助手输出，重发全史=滚雪球：真机 12 轮膨胀到 108KB、DeepSeek 每轮重读重复内容响应变慢）')
  ok(!agent.includes('this.history.slice(checkpointMsgIndex + 1).map'), '旧的全量增量切法已移除')
  ok(agent.includes('await this.webChatTurn(delta, step === 0)'), '每轮经 webChatTurn 取网页回复')
  // ② 增量只在用户轮带附件（网页会话自己记住上下文）
  ok(agent.includes('content = await this.webChatTurn(delta, step === 0)'), '附件仅用户消息轮携带')
  // ③ 网页规则不再禁用工具，明确告知会被真实执行
  ok(!promptjs.includes('禁止输出 tool 代码块'), '网页规则不再禁 tool 块')
  ok(promptjs.includes('与本地版完全一致'), '网页规则强调与本地同权')
}

console.log('— v2.4.59：网页设备备注速查置顶 + Bing 词条垃圾降权 + 搜索换词引导 —')
{
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 真机反馈"网页版看不见设备备注"——备注埋在 48KB 规则文档中段，DeepSeek 未必展开细读；
  //    设备速查（名称+备注+target 映射）独立置顶到规则附件头部
  ok(agent.includes('buildDevicesBrief()'), 'agent 提供设备速查构建')
  ok(agent.includes('devicesBrief: this.buildDevicesBrief()'), '规则附件传入设备速查')
  ok(promptjs.includes('# 当前可用设备速查'), '规则附件头部设备速查置顶')
  ok(agent.includes('用户消息里出现的设备名或用户备注，就是指上面对应的设备'), '速查节点明备注指代关系')
  // ② 真机实测 Bing 搜"我的世界 草方块 壁纸"前两条是"我（汉语汉字）"词条——老大拍板：不搞正则过滤花活，
  //    count=20 一次多抓 15 条让 AI 自己分辨
  ok(tools.includes('&setlang=zh-CN&count=20'), 'Bing 请求一次要 20 条')
  ok(tools.includes('out.length < 15'), '搜索结果上限提到 15 条')
  ok(tools.includes('请自行判断哪些与任务真正相关'), '结果尾注引导 AI 自辨相关性')
  ok(readManual('网络下载.md').includes('近似重复的词引擎只会返回同样的结果'), 'web_search desc 引导换词搜索 → 手册 网络下载.md')
}

console.log('— v2.4.58：网页引用消息三重必达 + 引用位置语义（老大方案） —')
{
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  // ① file_ref → 「引用位置：」直白语义（老大拍板：引用本质就是位置链接），设备 ID 直接给 target 参数
  ok(agent.includes('引用位置：${p}'), 'file_ref 转引用位置前缀')
  ok(agent.includes('请直接对我说的内容在该位置执行'), '引用行带明确操作指令')
  ok(agent.includes('[webchat-send] user='), '网页发送前打日志（真机排查有证据）')
  // ② 发送链三层验证：回读（延迟 250ms 防 React 异步重置假一致）→ 发送后页面落地验证 → 未落地转附件重发
  ok(webchat.includes('await new Promise((r) => setTimeout(r, 250))'), '回读延迟防受控重置假一致')
  ok(webchat.includes('消息未自动送达，已以附件'), '发送后未落地自动转附件重发')
  ok(webchat.includes("fullText.replace(/\\\\s+/g, ' ').split(${JSON.stringify(head)}"), '页面全文验证消息落地（正文计数判据，v2.4.80 折叠空白）')
}

console.log('— v2.4.57：docx 工作台内嵌 WPS 抢先修复 + 系统打开死循环修复 —')
{
  // 真机反馈：设了内置优先，双击 docx 进工作台仍被 WPS 打开——mountWbDocxRich 的"自动择优"
  // 探测到 WPS/Word 就抢先内嵌（xlsx 走内置网格无此问题）；点「系统打开」又被 shell:open-file
  // 分流回工作台形成死循环，用户永远到不了 WPS
  ok(appjs.includes("=== 'builtin') handler = null"), '内置优先时跳过 WPS/Word 内嵌直接用内置渲染器')
  ok(appjs.includes('openFile(it.path, { forceSystem: true })'), '工作台「系统打开」按钮走强制系统通道')
  ok(mainjs.includes('!forceSystem && BUILTIN_OPEN_EXTS.has(ext)'), 'shell:open-file 支持 forceSystem 跳过分流')
  ok(preload.includes('openFile: (filePath, opts) => ipcRenderer.invoke'), 'preload openFile 支持透传参数')
}

console.log('— v2.4.56：网页版引用文件消息被吞修复 —')
{
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  // 真机实锤：用户消息含 <file_ref .../> HTML 式标签（引用文件/文件夹）会被 DeepSeek 网页前端吞掉
  // → 只发出去规则附件没正文，模型答非所问；本地 API 走 JSON 通道不受影响（与真机现象吻合）
  ok(webchat.includes('echo: String(ta.value'), '网页输入框填入后回读验证')
  ok(webchat.includes("消息正文.md"), '回读不一致自动转附件《消息正文.md》兜底')
}

console.log('— v2.4.55：撤回不重置网页对话（老大拍板砍掉联动）+ 互联模式内置打开自动切 Work —')
{
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  // ① 撤回只动本地：rollbackTo 不再清 _webConvUrl（重置=丢全部上下文纯累赘）
  ok(!agent.includes('webReset'), 'rollbackTo 无网页会话重置逻辑')
  ok(!appjs.includes('网页端对话无法删除已发消息'), '回滚 toast 无重排提示')
  // ② 内置优先：互联模式收到 workbench-open 自动切 Work 模式进工作台（真机"还是开 WPS"修复）
  ok(appjs.includes("$('modeWork').click()"), '互联模式内置优先自动切 Work 模式')
  ok(/preferOpen'\)\.then\(\(v\) => \{\s*\n\s*if \(\(v \|\| 'builtin'\) === 'builtin'/.test(appjs), '渲染层按 preferOpen 分流（默认内置）')
}

console.log('— v2.4.54：表格/Word 内置优先打开（设置项）—')
{
  const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  ok(mainjs.includes("BUILTIN_OPEN_EXTS = new Set(['.docx', '.xlsx'])"), '内置打开白名单 docx/xlsx')
  ok(mainjs.includes("(getSetting('preferOpen') || 'builtin') === 'builtin'"), 'shell:open-file 按 preferOpen 分流（默认内置）')
  ok(mainjs.includes("send('ai:workbench-open'"), '内置打开走 workbench-open 通道')
  ok(html.includes('id="preferOpenSelect"'), '设置面板含文件打开方式下拉')
  ok(appjs.includes("setSetting('preferOpen'") && appjs.includes("getSetting('preferOpen')"), '设置读写 preferOpen')
}

console.log('— v2.4.53：transfer_file dest_dir 完整路径校验 + 接收端写盘防崩 —')
{
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const tcp = fs.readFileSync(path.join(ROOT, 'server/tcpAgent.js'), 'utf8')
  // ① 发送端：相对 dest_dir 拒绝 + 引导 list_dir 探真实路径（真机实锤网页模型传"桌面"崩对方）
  ok(tools.includes('!path.isAbsolute(args.dest_dir)'), 'transfer_file 校验 dest_dir 必须绝对路径')
  ok(tools.includes('完整路径:'), 'root 列表显示快捷入口完整路径（信息源头防呆）')
  ok(/dest_dir\(目标文件夹的完整磁盘路径/.test(tools), '工具说明强调 dest_dir 完整路径')
  // ② 接收端：相对路径拒绝回错 + 自动建目录 + writeStream error 监听（绝不冒 uncaughtException 杀进程）
  ok(tcp.includes('!path.isAbsolute(destPath)'), '接收端拒绝相对 destPath 并回错误帧')
  ok(tcp.includes('fs.mkdirSync(path.dirname(destPath), { recursive: true })'), '接收端写盘前自动建目录')
  ok(tcp.includes("transfer.writeStream.on('error'"), '接收端 writeStream 挂 error 监听')
}

console.log('— v2.4.45：小任务禁建板 + AI 打开默认进工作台 + 网页新任务新会话 —')
{
  const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  // ① 小任务不建规划板（提示词 + 系统提醒都不逼建板）
  ok(promptjs.includes('清单只给多步任务用') && promptjs.includes('严禁建板'), '提示词：一两步小任务严禁建板直接干')
  ok(agent.includes('const simpleTask ='), '系统提醒对简单任务跳过建板督促')
  // ② AI 打开的文件/网址默认进工作台（Work 模式），互联模式回退系统打开
  ok(tools.includes('onWorkbenchOpen({ kind: \'url\', url })') && tools.includes('onWorkbenchOpen({ kind: \'file\''), 'tools open_url/open_path 走工作台通道')
  ok(mainjs.includes("mainWindow.webContents.send('ai:workbench-open'"), 'main 转发 workbench-open 到渲染层')
  ok(mainjs.includes("ipcMain.handle('sys:open-external'"), 'main 系统打开回退通道')
  ok(preload.includes('onAiWorkbenchOpen:') && preload.includes('openExternalFallback:'), 'preload 暴露工作台打开/回退 API')
  ok(appjs.includes('function addUrlTab') && appjs.includes("it.kind === 'urltab'"), 'app.js 通用网页页签（urltab）')
  ok(appjs.includes("browserNavigate(payload.url).catch(() => {})") && appjs.includes('else addUrlTab(payload.url)'), '网址进工作台：受控页签内导航/普通页签分流')
  // ③ 网页版新任务自动开新会话（甩掉旧上下文污染）
  ok(agent.includes('newSession: firstTurn') && agent.includes('_webConvStarted'), 'agent 用户消息轮只在首次开新网页会话（后续复用保上下文）')
  ok(webchat.includes('async function send(web, prompt, handlers, attachments, newSession, resumeUrl)'), 'webchat send 接收 newSession + resumeUrl（恢复对话导航）')
  ok(webchat.includes('await v.el.loadURL(app.home)'), '新会话先导航回首页')
}

console.log('— v2.4.76→77：工作台 AI 图片编辑器（画笔遮罩打底；v2.4.77 重构为"发对话框"流程） —')
{
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  ok(appjs.includes('mountWbImgEdit') && appjs.includes('wb-img-edit-btn'), '图片预览右上角「AI 编辑」入口按钮')
  ok(appjs.includes('openWbImageEditor') && appjs.includes("'rgba(109,90,224,0.55)'"), '编辑器画布：遮罩层画笔（MSMate 紫半透明）')
  ok(appjs.includes("octx.fillStyle = '#000'"), '遮罩区域合成涂纯黑（映射回原图像素）')
  ok(appjs.includes('readFileBase64') && appjs.includes('data:${r.mime};base64,${r.base64}'), '底图 dataURL 加载（防 file:// 画布污染 SecurityError）')
  ok(appjs.includes('滚轮调笔刷粗细') && appjs.includes('strokes.pop()'), '滚轮调笔刷 + 撤销/清空涂抹')
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  ok(preload.includes("'fs:read-file-base64'"), 'preload 桥：readFileBase64')
  const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  ok(mainjs.includes("ipcMain.handle('fs:read-file-base64'"), '主进程 IPC：base64 读取')
  ok(!mainjs.includes("ipcMain.handle('ai:image-edit'"), '旧 ai:image-edit 直连已删（v2.4.77：指令移对话框，AI 走 generate_image 编辑链路）')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(tools.includes('module.exports = { createTools, resolveModelProvider, httpJson, httpDownload, extractArticleText, httpGet, sniffMagic }'), 'tools 导出 httpJson/httpDownload/sniffMagic 供主进程复用')
}

console.log('— v2.4.75：图片编辑模型（Qwen-Image-Edit，老大：改一张图+对话中反复修改） —')
{
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  ok(html.includes('id="aiImageEditModelInput"') && html.includes('aiImageEditProviderSelect'), '设置新增「图片编辑」模型栏（模型+运营商下拉）')
  ok(html.includes('Qwen/Qwen-Image-Edit-2509'), '默认模型 Qwen-Image-Edit-2509')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  ok(appjs.includes("['ImageEdit', 'aiImageEditProviderSelect']"), 'PROVIDER_SLOTS 收录 ImageEdit 槽位')
  ok(appjs.includes('imageEditModel: $(\'aiImageEditModelInput\')'), '设置读写含 imageEditModel')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  ok(agent.includes("this.setSetting('aiImageEditModel'") && agent.includes("getSetting('aiImageEditModel')"), 'agent 配置存取 aiImageEditModel')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(tools.includes("resolveModelProvider(getSetting, imgPayload ? 'imageEdit' : 'image')"), '编辑模式走 imageEdit 运营商')
  ok(tools.includes("data:image/${/\\.(jpe?g)$/i.test(ip) ? 'jpeg'"), '本地图片转 base64 data URI 上传')
  ok(tools.includes('image: imgPayload, num_inference_steps: steps'), '编辑请求体带 image + 步数变量（v2.4.88 噪点修复→v2.4.89 档位化；不传 image_size/negative_prompt）')
  ok(readManual('图片视频.md').includes('把上一轮结果图的路径作为 image 传回来'), '工具描述引导对话式反复修改 → 手册 图片视频.md')
}

console.log('— v2.4.74：图片键盘翻页监听泄漏修复（老大实锤：键盘翻页按钮成对累积越翻越卡） —')
{
  const app = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  ok(app.includes('const myPath = item.path // 快照'), '挂载时快照 path（共享对象原地改导致自对比恒等）')
  ok(app.includes('body.querySelectorAll(\'.wb-img-nav,.wb-img-count\').forEach(n => n.remove())'), '挂载前清残留按钮（双保险）')
  ok(app.includes('const retire = () =>'), 'retire 主动退役机制')
  ok(app.includes("if (!cur || cur.path !== myPath) { retire(); return } // 本 nav 已过时"), 'go 守卫用快照对比')
  ok(app.includes("retire() // 翻页后本 nav 退役"), '翻页后旧 nav 立即退役（键盘监听移除）')
}

console.log('— v2.4.73：图片查看翻页 + 视频直链抓取（老大：浏览图片不能翻页不方便；爬视频对应提升） —')
{
  const app = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  ok(app.includes('function mountWbImgNav'), '图片翻页导航挂载函数')
  ok(app.includes("e.key === 'ArrowLeft'") && app.includes("e.key === 'ArrowRight'"), '键盘 ←/→ 翻页')
  ok(app.includes('wbActiveKey = wbKey(cur)'), '翻页同步激活 key（防激活项落最后）')
  ok(app.includes('mountWbImgNav(item, body)'), '图片预览挂翻页导航')
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n')
  ok(css.includes('.wb-img-nav-prev') && css.includes('.wb-img-count'), '翻页箭头/计数样式')
  ok(css.includes('position: relative; /* 图片翻页箭头/计数的定位锚点'), 'wb-view-body 定位锚点')
  const ac = fs.readFileSync(path.join(ROOT, 'ai/anticrawl.js'), 'utf8')
  ok(ac.includes("mode === 'videos'") && ac.includes('RENDER_NO_VIDEOS'), 'renderPage 视频模式（video标签+网络记录）')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(tools.includes('videosMode') && tools.includes('是 HLS 切片流不是完整文件'), 'web_fetch mode:videos（含 m3u8 下不了引导）')
  ok(readManual('网络下载.md').includes('videos=渲染抓视频地址'), '工具描述含视频模式 → 手册 网络下载.md')
}

console.log('— v2.4.72：搜索/抓网页跨轮去重（老大担忧：换词又搜出原 7 个链接重复读空转） —')
{
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(tools.includes('const WEB_SEEN_TTL = 10 * 60 * 1000') && tools.includes('function webSeenCheck'), 'URL 会话记忆（10 分钟 TTL，同任务多轮窗口）')
  ok(tools.includes('if (webSeenCheck(it.url)) { stale++; continue }'), 'web_search 跨轮过滤已见链接（不占名额）')
  ok(tools.includes('条链接全部与近期搜索结果重复（已过滤）'), '全滤光 → 引导换明显不同的词/换站')
  ok(tools.includes('另过滤 ${stale} 条近期已出现过的重复链接'), '结果头部注明过滤数')
  ok(tools.includes('该链接近期已抓取过（重复提醒）'), 'web_fetch 重复抓取提醒（提醒不阻断）')
  ok(tools.includes('if (rr.ok) webSeenMark(url)'), '抓取成功后标记记忆（供下轮去重）')
  ok(tools.includes('function webSeenSweep'), 'TTL 过期清扫（防 Map 膨胀）')
}

console.log('— v2.4.71：工作台文件夹右键菜单（老大实锤：项目不能删/复制/剪切，空白不能新建） —')
{
  const app = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  ok(app.includes("grid.addEventListener('contextmenu'"), '工作台网格挂 contextmenu（项目+空白双分支）')
  ok(app.includes('function showWbFsMenu') && app.includes('function hideWbFsMenu'), '动态菜单构建/隐藏函数')
  ok(app.includes("document.addEventListener('click', hideWbFsMenu)"), '全局点击隐藏工作台菜单')
  ok(app.includes('cell.dataset.path = e.path') && app.includes("cell.dataset.isdir = String(!!e.isDirectory)"), '网格单元带 path/name/isdir dataset')
  ok(app.includes('async function wbPasteTo(destDir, originItem, refresh)'), '工作台粘贴（同设备复制/移动+跨设备上传/下载）')
  ok(app.includes('deviceId: item.origin === \'local\' ? null : item.origin'), '剪贴板记录来源 deviceId（多设备不串线）')
  ok(app.includes('wbDeleteTargets = async (targets)'), '删除（含多选批量+确认）')
  ok(app.includes('function showNewItemModal(source, parentPath, type, existingNames, deviceId, wbRefresh)'), '新建弹窗支持工作台目录名单/设备/刷新回调')
  ok(app.includes('function showRenameModal(path, name, source, deviceId, wbRefresh)'), '重命名弹窗支持 deviceId/wbRefresh')
  ok(app.includes('const devId = tgt.deviceId || state.connectedDeviceId'), 'createNewItem 用工作台指定的设备')
  ok(app.includes("iconSvg('square-pen') + ' 重命名'") && app.includes("iconSvg('trash-2') + ' 删除', danger: true"), '菜单含重命名+红色删除（Lucide 图标）')
  ok(app.includes("iconSvg('folder-plus') + ' 新建文件夹'") && app.includes("iconSvg('file-plus') + ' 新建文本文档'") && app.includes("iconSvg('rotate-cw') + ' 刷新'"), '空白菜单含新建全家桶+刷新（Lucide 图标）')
}

console.log('— v2.4.70：「只剩规则附件没正文」真根因=saveHistory 裁剪位移索引（六轮终修，app.log 实锤 user=true len=0） —')
{
  const ag = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  // msgIndex 必须在 saveHistory 之后取（裁剪 >80 条时 slice 位移全部索引）——以修复标记为锚验证顺序
  const v270Mark = ag.indexOf('v2.4.70 根因修复')
  ok(v270Mark > -1, 'v2.4.70 根因修复标记在位')
  const region = ag.slice(Math.max(0, v270Mark - 300), v270Mark + 500)
  ok(region.indexOf('this.saveHistory()') < region.indexOf('const msgIndex = this.history.length - 1'), 'sendUserMessage: msgIndex 在 saveHistory 之后重取（裁剪位移后取新索引）')
  ok(ag.includes('【v2.4.70】同 sendUserMessage：saveHistory 裁剪会位移索引'), 'generateMedia: 同款索引修复')
  ok(ag.includes('用户消息正文为空（历史索引异常）'), 'webChatTurn 空正文防线（宁可报错不静默发空）')
  ok(ag.includes('const HISTORY_KEEP = 80'), '裁剪上限 80 条（根因定位依据）')
}

console.log('— v2.4.69：web_fetch mode:images 无头渲染抓图片直链（老大点破：百度图片类站点 JS 动态渲染，静态抓取全是占位符） —')
{
  const ac = fs.readFileSync(path.join(ROOT, 'ai/anticrawl.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(ac.includes("mode = 'html'") && ac.includes("const wantImages = mode === 'images'"), 'renderPage 支持 images 模式（开图片加载）')
  ok(ac.includes('window.scrollTo(0, H() * i / 4)'), '滚动触发懒加载（图片站标配分屏滚动）')
  ok(ac.includes("performance.getEntriesByType('resource')"), '图片直链提取含网络请求记录兜底')
  ok(ac.includes('data-imgurl'), 'img data-* 属性全家桶（百度图片原图藏在 data 属性里）')
  ok(tools.includes("/^(images?|pics?)$/i.test(String(args.mode || ''))"), 'web_fetch mode:images 入口分发')
  ok(tools.includes('const processResp = async (contentType, html)'), 'processResp async 化（links 动态站渲染兜底用 await）')
  ok(tools.includes('是 JS 动态渲染站（静态抓取无链接），经无头浏览器渲染后提取到'), 'links 模式静态为空 → 渲染兜底再提一轮')
  ok(readManual('网络下载.md').includes('images=渲染抓图片直链'), '工具 desc 引导 AI 用 mode:images → 手册 网络下载.md')
}

console.log('— v2.4.68：发送验证硬判据=正文计数（老大四轮实锤"只剩规则附件"，旧判据被重复消息+附件回复联手骗过） —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  ok(webchat.includes('v2.4.68 起作为唯一成功判据'), '正文硬计数注释在位（防回退到 hit 布尔/气泡数判据）')
  ok(webchat.includes('cntNow: fullText.replace(/\\\\s+/g, \' \').split(${JSON.stringify(head)}).length - 1'), 'confirmSent 采样正文计数（v2.4.80 折叠空白：引用文件消息的换行 head 也能命中）')
  ok(!webchat.includes('preHit'), '旧 preHit 布尔判据彻底移除')
}

console.log('— v2.4.67：重启后登录 guard 误拦修复（老大实锤"重启后只剩规则附件"复发） —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  ok(webchat.includes('先等输入框就绪（只有登录后的页面才有输入框，登录页等到超时）再判定'), '登录 guard 先等页面就绪再判定（冷启动读不到 token 误拦正文）')
  ok(webchat.includes('await waitInputReady(web, 20000)\n      await refreshLogin(web)'), 'guard 内置 20s 就绪等待')
}

console.log('— v2.4.66：实时刷新等写稳定 + 缩略图缓存破坏（老大实锤"图片只有一半"） —')
{
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const app = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  ok(mainJs.includes('写入稳定') || mainJs.includes('写稳定检测'), '主进程等文件大小连续两轮不变才通知刷新')
  ok(mainJs.includes("dirWatch.timer = setTimeout(async () => {"), '稳定检测异步化（statSync 采样）')
  ok(app.includes("'?m=' + (e.modifiedTime || 0)"), '网格缩略图带 mtime 破 file:// 缓存')
}

console.log('— v2.4.65：工作台目录实时刷新 + 视频/GIF 背景 + 本地模型上下文瘦身（老大实测变慢） —')
{
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const app = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n')
  // ① 目录实时刷新：fs.watch（递归）→ 防抖推渲染层 → 列表/文件夹页签/打开中内容三路刷新
  ok(mainJs.includes("fs.watch(dir, { recursive: true }"), '主进程递归监听当前目录')
  ok(mainJs.includes("setTimeout(() => {\n        if (dirWatch.dir !== dir) return") || mainJs.includes('400) // AI 批量写/解压会爆发大量事件'), '主进程 400ms 防抖合并爆发事件')
  ok(preload.includes('watchDir:') && preload.includes('onDirChanged:'), 'preload 暴露 watch/changed 通道')
  ok(app.includes('renderWbFolder(it, { silent: true })'), '文件夹页签静默刷新（不闪"正在读取"）')
  ok(app.includes('if (ed && ed.dirty) return // 用户正在改且没保存'), '编辑中有未保存内容不覆盖')
  ok(app.includes('_api.watchDir(result.path)'), '互联模式本地列表也实时刷新')
  ok(app.includes('function wbPathEq'), '路径匹配大小写/尾斜杠不敏感')
  ok(app.includes("openPreview(it, { bust: true })"), '图片刷新带时间戳破 file:// 缓存')
  // ② 视频/GIF 背景：静音循环 + 同容器滤镜
  ok(mainJs.includes("'ui-background-video.'"), '视频背景原样复制（不过 nativeImage）')
  ok(mainJs.includes("'ui-background-anim.'"), 'GIF 动图原样保留帧动画')
  ok(mainJs.includes("extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'mp4', 'webm']"), '选择器支持视频/动图格式')
  ok(app.includes('<video class="app-bg-media" src="${media.src}" autoplay loop muted playsinline>'), '视频背景静音循环')
  ok(css.includes('.app-bg-media'), '媒体背景样式（cover 撑满+同滤镜）')
  // ③ 本地模型上下文瘦身（实测变慢主因：工具结果/正文喂给模型太多）
  ok(tools.includes('.slice(0, 120)'), '搜索摘要 220→120 字')
  ok(tools.includes('htmlToText(html, 9000)'), '网页正文 12000→9000 字')
}

console.log('— v2.4.63：网页发送强判据修复（远端"只剩规则附件"实锤）+ web_search 多词一次搜（老大方案） —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ⓪ v2.4.62 远端实锤教训：confirmSent 用"输入框清空"当主判据，切对话/附件上传后 React 重渲染
  //    清空输入框被误判"已发出"→ 跳过重试兜底 → 只剩规则附件没正文。v2.4.63 强判据+自愈+日志
  ok(webchat.includes('[webchat-send2] sentOk='), '发送结果埋日志（远端排查有证据）')
  ok(webchat.includes('setTimeout(r, 800)'), '输入框就绪缓冲 400→800ms（textarea 出现 ≠ hydrate 完成）')
  ok(webchat.includes('第一轮无条件发送！工具轮引导语'), '工具轮也无条件点发送（v2.4.62/63 实锤：gate 在验证里=工具反馈永远躺输入框）')
  // ① 发送后验证「真发出」+ 卡顿吞事件不再傻等转圈（v2.4.63 升级：强判据+最后一眼自愈+快照判重复）
  ok(webchat.includes('const confirmSent = async (pre) =>'), '发送后 confirmSent 验证闭环')
  ok(webchat.includes('if (st && st.cntNow > (pre.preCnt || 0)) return true'), '验证唯一判据=正文计数增加（附件-only 发出必判失败→重试→兜底，v2.4.68 硬判据）')
  ok(webchat.includes("const preCnt = document.body.innerText.replace(/\\\\s+/g, ' ').split(head).length - 1"), '发送前快照正文计数（历史+新气泡全量）')
  ok(webchat.includes('发送前发现文本丢了当场重填'), '最后一眼自愈：重渲染丢文本当场重填')
  ok(webchat.includes('for (let i = 1; i < 3 && !sentOk; i++)'), '未发出自动重试（首根发+2 轮重试：按钮→Enter→按钮）')
  ok(webchat.includes('await clickSend(i === 1)'), '第 2 轮改走 Enter 原生通道')
  ok(webchat.includes('网页端发送通道失灵（已重试 4 次）'), '重试穷尽报错引导手动发送（不再无限转圈）')
  ok(webchat.includes('const attachBodyAsFile = async (noteText)'), '兜底转附件抽公共函数')
  // ② web_search 多词一次搜：| 分隔 2-3 个词并发搜、按链接去重合并，治"兜兜转转很多圈"
  ok(tools.includes("raw.split('|')") && tools.includes('.slice(0, 3)'), 'query 支持 | 多词（上限 3 个）')
  ok(tools.includes('Promise.all(qs.map('), '多词并发搜索')
  ok(tools.includes('const seen = new Set()') && tools.includes("String(it.url).replace(/[#?].*$/, '')"), '按链接去重合并')
  ok(tools.includes('qs.length > 1 ? 8 : 15'), '多词每组 8 条控总量、单词保持 15 条')
  ok(readManual('网络下载.md').includes('强烈推荐一次传 2-3 个不同角度的词'), 'desc 引导 AI 多角度编词 → 手册 网络下载.md')
  ok(tools.includes('多词 × 四引擎搜索（'), '多词结果带分组标注（四引擎版）')
}

console.log('— v2.4.77：AI 图片编辑器四连改（圆圈光标 / 紫遮罩 / 橡皮擦 / 指令移对话框） —')
{
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 圆圈光标：直径=笔刷大小，所见即所得（系统光标隐藏，自绘圆圈替代）
  ok(appjs.includes('<div class="wb-iedit-cursor">'), '编辑器 DOM 含自绘圆圈光标节点')
  ok(appjs.includes('cursorEl.style.width = d + \'px\'') && appjs.includes('cursorEl.style.height = d + \'px\''), '圆圈直径=笔刷大小实时同步')
  ok(appjs.includes('const r = wrap.getBoundingClientRect()') && appjs.includes('e.clientX - r.left - d / 2'), '光标按 wrap rect 定位（图片居中时不偏移）')
  ok(css.includes('.wb-iedit-mask {\n  cursor: none;') || /\.wb-iedit-mask\s*\{[^}]*cursor:\s*none/.test(css), 'mask 隐藏系统光标（cursor:none）')
  ok(/\.wb-iedit-cursor\s*\{[^}]*border-radius:\s*50%/.test(css), '圆圈光标圆形样式')
  // ② 遮罩紫色半透明（109,90,224 = MSMate 品牌紫 #6d5ae0，与 CSS 光标描边 --mark-rgb 一致）
  ok(appjs.includes("'rgba(109,90,224,0.55)'"), '遮罩紫色半透明（画笔 stroke/fill）')
  ok(/\.wb-iedit-cursor\s*\{[^}]*rgba\(var\(--mark-rgb\)/.test(css), '光标描边同紫色')
  ok(appjs.includes('涂抹要改的区域（紫色半透明'), '提示语同步说明紫色遮罩')
  // ③ 橡皮擦：与笔刷同大小，一键切换 destination-out
  ok(appjs.includes('data-tool="brush"') && appjs.includes('data-tool="eraser"'), '画笔/橡皮成对按钮')
  ok(appjs.includes("tool === 'eraser' ? 'destination-out' : 'source-over'"), '橡皮走 destination-out 擦除')
  ok(appjs.includes('cursorEl.classList.toggle(\'eraser\', tool === \'eraser\')'), '切换时圆圈光标同步换橡皮样式')
  ok(/\.wb-iedit-cursor\.eraser\s*\{[^}]*dashed/.test(css), '橡皮态光标虚线灰描边')
  ok(appjs.includes('const brushPx = () => parseInt(body.querySelector(\'.wb-iedit-size\').value) || 36'), '画笔/橡皮共用同一粗细')
  // ④ 指令移到对话框：合成纯黑遮罩图 → 存 iedit-tmp → 引用胶囊进聊天框
  ok(mainjs.includes("ipcMain.handle('fs:save-dataurl-file'"), 'main 有 fs:save-dataurl-file（合成图落盘）')
  ok(mainjs.includes("ipcMain.handle('app:get-user-data-path'"), 'main 有 app:get-user-data-path')
  ok(preload.includes('saveDataUrlFile:'), 'preload 暴露 saveDataUrlFile')
  ok(preload.includes('userDataPath:'), 'preload 暴露 userDataPath')
  ok(appjs.includes('const prefix = hasMask ? \'编辑_\' : \'整图_\''), '合成图存 userData/iedit-tmp（编辑_/整图_ 前缀分支）')
  ok(appjs.includes('const ext = /^data:image\\/jpeg/.test(dataUrl) ? \'jpg\' : \'png\''), '超 10MB 降 JPEG 时扩展名跟随 mime')
  ok(appjs.includes('if (d[i] > 8) { hasMask = true; break }'), '发送前检测遮罩（alpha 通道，分流编辑_/整图_）')
  ok(appjs.includes("work._appendChatRef(`[引用文件: ${savePath}]`)"), '合成图以引用胶囊塞进聊天框（用户自写指令）')
  ok(appjs.includes("octx.fillStyle = '#000'"), '遮罩区涂纯黑（Qwen-Image-Edit 黑区引导重绘）')
  ok(appjs.includes('img.naturalWidth / mask.width'), '显示坐标按比例映射回原图像素')
  ok(tools.includes('/iedit-tmp[\\\\/]编辑_/'), 'AI 侧识别编辑器合成图（fromEditor）')
  ok(tools.includes('【图片局部重绘任务】'), '编辑器图自动补局部重绘语义（v2.4.86 卷质量版）')
  ok(appjs.includes('ro.disconnect(); window.removeEventListener(\'pointermove\', onMove)'), '退出编辑器清理观察器与全局监听（防泄漏）')
}

console.log('— v2.4.78：智能涂抹（闭合圈自动填充）+ 改图提示词精修（老大定调"好好P图"） —')
{
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 智能涂抹：一笔闭合 → closePath 填充内部（实心）；非闭合只留线条
  ok(appjs.includes('let curPts = null // 当前笔点集：一笔首尾闭合 → 自动填充圈内（实心），非闭合只留线条'), '记录当前笔点集（闭合检测用）')
  ok(appjs.includes('Math.hypot(l.x - f.x, l.y - f.y) <= Math.max(32, brushPx())'), '闭合判定：首尾距离 ≤ max(32px, 笔刷直径)')
  ok(appjs.includes('cctx.closePath()') && /cctx\.closePath\(\)\s*\n\s*cctx\.fill\(\)/.test(appjs), '闭合笔 closePath+fill 填充实心')
  ok(appjs.includes('if (curPts && curPts.length >= 3)'), '点数 ≥3 才判闭合（防误触）')
  // ② 笔迹离屏层：整笔一次盖章，来回涂抹不叠深（透明度均匀）
  ok(appjs.includes('let curCv = null // 画笔笔迹离屏层（不透明紫）：拖动实时预览、松手终态都以 0.55 盖章，来回涂抹不叠深'), '画笔走离屏层')
  ok(appjs.includes('mctx.globalAlpha = 0.55') && appjs.includes('mctx.drawImage(curCv, 0, 0)'), '整笔以 0.55 透明度一次盖上')
  ok(appjs.includes("cctx.strokeStyle = '#6d5ae0'") && appjs.includes("cctx.fillStyle = '#6d5ae0'"), '离屏层不透明紫（#6d5ae0 MSMate 紫）')
  // ③ 改图提示词精修：未涂抹区完全保留 + 涂抹区与周围风格融合（v2.4.86 卷质量重写，老断言换新语义）
  ok(tools.includes('1. 遮罩外区域忠实还原：光照方向、色温、材质纹理、物体形态、构图透视、景深、噪点颗粒必须与${baseRef}完全一致'), '硬性约束1：未涂抹区原样保留（点名三要素+景深噪点，v2.4.87 基准图引用化）')
  ok(tools.includes('2. 遮罩区内新内容与四周原图无缝衔接：色调、光影方向、质感、透视、清晰度保持一致'), '硬性约束2：风格自然融合（好好P图）')
  ok(tools.includes('3. 输出完整单张图片，成品中不保留黑色遮罩标记'), '硬性约束3：成品收尾（无遮罩标记）')
  ok(appjs.includes('一笔画个闭合的圈会自动填满内部'), '编辑器提示语说明智能涂抹')
}

console.log('— v2.4.79：编辑器三连修（拖动实时笔迹 / 橡皮一次擦净 / 未涂放行整图直传） —')
{
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 拖动实时笔迹：本笔前快照打底 + 当前笔预览，每次 move 重绘（老大实锤：松手才出现不行）
  ok(appjs.includes('let committed = null // 本笔开始前的遮罩快照：拖动中实时重绘（底图+当前笔预览），所见即所得'), '本笔前快照 committed 层')
  ok(appjs.includes('const repaint = () => {') && appjs.includes('mctx.clearRect(0, 0, mask.width, mask.height)'), 'repaint：清屏+底图+预览重绘')
  ok(appjs.includes('repaint() // 拖动中实时显示笔迹'), 'onMove 实时回显笔迹')
  ok(appjs.includes("committed.getContext('2d').drawImage(mask, 0, 0)"), 'onDown 快照遮罩作底图')
  // ② 橡皮一次擦净：destination-out 按源 alpha 决定擦除量，0.55 透明色一次只擦 55%（老大实锤）
  ok(appjs.includes("tool === 'eraser' ? '#000' : 'rgba(109,90,224,0.55)'"), '橡皮不透明色（一次擦净）/画笔紫透明')
  ok(appjs.includes('dot(mctx, last) // 橡皮：destination-out 直接擦主遮罩（不透明色一次擦净）'), '橡皮起点圆点也一次擦净')
  // ③ 未涂抹放行：整图直传（整图_ 前缀），AI 不带黑区语义走纯指令
  ok(!appjs.includes('先在图上涂抹要修改的区域，再发送到对话框'), '旧「必须涂抹」拦截已删')
  ok(appjs.includes("setHint(hasMask ? '正在合成遮罩图并发送到对话框…' : '未涂抹：整图直传，发送后在对话框写指令让 AI 改图…')"), '发送提示区分两种模式')
  ok(appjs.includes('if (hasMask) {') && appjs.includes('octx.fillStyle = \'#000\''), '有遮罩才涂黑合成（没涂=原图直传）')
  ok(tools.includes('/iedit-tmp[\\\\/]编辑_/') && !tools.includes('整图_'), 'AI 黑区语义只命中编辑_（整图_ 纯指令改图）')
}

console.log('— v2.4.80：引用文件发送判据空白折叠修复 + 上下文压缩（默认关/80% 触发/交接摘要） —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  // ① 引用文件必卡死根因：head 空白折叠 vs 页面原始换行 → split 恒 0 → 重复重发 4 次（模型收
  //    到重复消息困惑"已停止"）→ 误报"发送通道失灵"。两侧统一折叠后计数
  ok(webchat.includes("cntNow: fullText.replace(/\\\\s+/g, ' ').split("), 'confirmSent 计数前折叠页面空白（含换行 head 可命中）')
  ok(!webchat.includes('cntNow: fullText.split('), '旧未折叠 cntNow 判据已移除')
  // ② 上下文压缩链路（默认关，仅本地 API 模式）
  ok(agent.includes('const COMPACT_TRIGGER = 0.8'), '80% 阈值触发（老大定值）')
  ok(agent.includes('async maybeCompactContext(cfg)'), '压缩主流程存在')
  ok(agent.includes("if (!route.isWeb) await this.maybeCompactContext(effCfg)"), '压缩只挂本地模式（用户消息入历史前）')
  ok(agent.includes("(this.getSetting('aiCompactEnabled') || '0') === '1'"), '开关默认关（设置开启才生效）')
  ok(agent.includes('【前情摘要（系统自动压缩生成，此前对话原文已归档）】'), '交接桥：前情摘要以 user 消息开头')
  ok(agent.includes('已读取前情摘要，我将基于摘要继续当前任务。'), '交接桥：assistant 确认消息成对')
  ok(agent.includes('compact_start') && agent.includes('compact_done'), '压缩开始/完成事件通知（前端转圈+toast）')
  // ③ 压缩设置 UI + 回填（回填缺失 = 开过后每次打开设置保存都被静默关掉）
  ok(appjs.includes("compactEnabled: $('aiCompactToggle').checked,"), '设置保存含压缩开关')
  ok(appjs.includes("contextLimit: parseInt($('aiContextLimitInput').value) || null,"), '设置保存含上下文上限（空=清除专属回默认）')
  ok(appjs.includes("$('aiCompactToggle').checked = !!cfg.compactEnabled"), '设置打开时回填压缩开关（防静默重置）')
  ok(appjs.includes("$('aiContextLimitInput').value = (parseInt(cfg.contextLimit)"), '设置打开时回填上下文上限')
  ok(html.includes('id="aiCompactToggle"') && html.includes('id="aiContextLimitInput"'), '设置面板压缩 UI 存在')
}

console.log('— v2.4.81：模板注释转义炸脚本修复（老大实锤 Script failed to execute）+ 上下文上限按模型保存 —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  // ① v2.4.80 真机实锤：executeJavaScript 的模板字符串里，注释含 \n 转义会被 cook 成真实
  //    换行 → 截断 // 注释、后半截变非法代码 → 整个页面脚本 SyntaxError → GUEST_VIEW_MANAGER_CALL
  //    "Script failed to execute"。字符串断言抓不到语法层炸，这里扫"注释行含反斜杠转义"的雷
  ok(!/^[ \t]*\/\/.*\\n/m.test(webchat), 'webchat 模板注释无换行转义（cook 截断注释=注入代码）')
  ok(webchat.includes('.catch((e) => ({ ok: false, error: `页面脚本执行失败: ${e.message}`'), 'clickSend 挂 catch：脚本炸降级为可重试失败（不再抛天书 IPC 错误）')
  ok(webchat.includes("「引用位置 + 换行引导语」"), '炸雷注释已改写为无转义版本')
  // ② 上下文上限按模型单独保存（各模型容量不同）：专属值 → 全局旧值 → 默认 65536
  ok(agent.includes('contextLimitFor(model)') && agent.includes("JSON.parse(this.getSetting('aiContextLimits') || '{}')"), '按模型解析上限（专属→全局→默认）')
  ok(agent.includes('const limit = this.contextLimitFor(cfg && cfg.model)'), '压缩触发用当前模型的专属上限')
  ok(agent.includes('contextLimit: this.contextLimitFor(this.getSetting(\'aiModel\')),'), 'getConfig 返回当前模型的解析上限（设置回填正确）')
  ok(agent.includes("if (n > 0) limits[key] = n") && agent.includes('else delete limits[key]'), '传数值存专属上限/传空清除回默认')
}

console.log('— v2.4.82：钩子半残中毒修复（第二句话起永久瞎实锤）+ 自愈重装 + 30s 直读抢救 + 等待心跳全链路 —')
{
  const webchat = fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8')
  const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const preloadjs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const appjs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  // ① 真机实锤根因（app.log：01:15:15 发送 OK 后 5 分钟整段静默 + 取消后下一句"你好"又卡）：
  //    旧 armPageHook 开头就置位 __mswbHook，半路抛错留下「标志在、take/probe 缺」半残钩子，
  //    之后所有重装被幂等检查误判 'armed' 挡回 → 页面活着也永久零抓取，跨回合持续卡死
  ok(webchat.includes("if (window.__mswbHook && typeof window.__mswbTake === 'function' && typeof window.__mswbProbe === 'function') return 'armed'"), '幂等放行验证抓取函数真实存在（半残钩子不再挡重装）')
  ok(webchat.indexOf('window.__mswbTake = () => {') !== -1 && webchat.indexOf('window.__mswbTake = () => {') < webchat.indexOf('window.__mswbHook = true'), '安装标志全部函数就位后才置位（成功收尾处）')
  ok((webchat.match(/__mswbHook = true/g) || []).length === 1, '置位点唯一（只在安装成功收尾）')
  // ② 自愈重装回传结果 + 诊断日志（本轮日志整段静默是排障最大障碍）
  ok(webchat.includes('const how = await armPageHook(v.el, web)'), '自愈重装回读安装结果（定位半残场景）')
  ok(webchat.includes('[webchat-poll] nohook x${nohookStreak} 自愈重装=${how}`'), '钩子丢失自愈日志（结果变化才补，防刷屏）')
  ok(webchat.includes('[webchat-poll] 30s直读抢救交付 len=${probeText.length}'), '30s 直读抢救交付日志')
  ok(webchat.includes('[webchat-poll] 150s兜底交付 len=${rescued.length}`'), '150s 兜底交付日志')
  ok(webchat.includes('[webchat-turn] end ${fn === handlers.onDone'), '轮次收尾留痕（done/error/超时全走 finish）')
  ok(webchat.includes("console.log('[webchat-page] dom-ready 重装钩子')") && webchat.includes('[webchat-page] did-navigate ${e.url'), '页面导航/dom-ready 日志（钩子丢失诱因可追溯）')
  // ③ 轮询期钩子丢失自愈（重装节流 + 锚点重设 + 指纹恢复）
  ok(webchat.includes('(window.__mswbTake ? window.__mswbTake() : "nohook")'), 'take 脚本钩子缺失返回 nohook（不再 null 静默）')
  ok(webchat.includes('nohookStreak++') && webchat.includes('if (nohookStreak % 10 === 1)'), '轮询期幂等重装钩子自愈（≈3s 节流）')
  ok(webchat.includes('window.__mswbFingerprint = ${JSON.stringify(String(v.lastPrompt).slice(0, 60))}'), '自愈重装后恢复 prompt 指纹（防把回显当回复）')
  ok(webchat.includes('v.lastPrompt = String(prompt)'), 'send 时记录 lastPrompt（自愈恢复指纹的数据源）')
  // ④ 早期直读抢救：回复可能早已渲染完而事件管道哑火——30s 起直读，两拍稳定才交付（不截断流式）
  ok(webchat.includes('if (!out.gotChunk && Date.now() - sentAt > 30000 && Date.now() - rescuedAt > 1500)'), '30s 起早期直读抢救（替代 150s 干等）')
  ok(webchat.includes('probeText === lastProbe'), '直读两拍一致才交付（流式增长中不误截断）')
  // ⑤ 等待心跳全链路（webchat→preload→main→agent→前端转圈）：等待可见不再像卡死
  ok(webchat.includes('handlers.onWait(Math.round((Date.now() - sentAt) / 1000))'), '钩子丢失期间也发等待心跳')
  ok(appjs.includes('onWait: (sec) => _api.webchatWait(sessionId'), '渲染层转发 onWait 心跳')
  ok(preloadjs.includes('webchatWait:'), 'preload 暴露 webchatWait')
  ok(mainjs.includes("ipcMain.handle('ai:webchat-wait'"), '主进程接收等待心跳')
  ok(agent.includes('onWebChatWait(seconds)') && agent.includes("type: 'webchat_wait'"), 'agent 转发 webchat_wait 事件')
  ok(appjs.includes("case 'webchat_wait'") && appjs.includes('网页模型已等待'), '前端展示已等待 N 秒转圈')
  ok(appjs.includes('hideRetryWait() // 有正文流回 = 等待结束'), '正文流回自动收起等待提示')
}

// ===== v2.4.83：图→网页悬浮控件残留修复 + 「AI 编辑图片」卡片分流 + 画幅比例三件套 =====
{
  console.log('— v2.4.83 悬浮控件残留 + 卡片分流 + 画幅比例 —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // Q1 图→网页/网址页签切换清悬浮控件（AI 编辑按钮 z-index 6 绝对定位，会浮在网页层上残留）
  ok((appjs.match(/\.wb-img-nav,\.wb-img-count,\.wb-img-edit-btn/g) || []).length >= 3, '网页页签三分支（webapp/urltab/openPreview）都清图片悬浮控件')
  ok(/\.wb-img-edit-btn\s*\{[^}]*z-index: 6/.test(css), 'AI 编辑按钮确为悬浮层（回归背景：z-index 6 绝对定位）')
  // Q3 卡片改名「AI 编辑图片」+ 图标分流（传 image=改图）
  ok(tools.includes('args.image ? `AI 编辑图片：') && tools.includes('`AI 生图：'), 'summarize 按是否传 image 分流卡片名（编辑图片/生图）')
  ok(appjs.includes("ev.name === 'generate_image' && ev.args && ev.args.image ? iconSvg('paintbrush')"), '前端卡片图标随编辑/生图分流（Lucide 图标）')
  ok(appjs.includes('generate_image: ') && appjs.includes('generate_video: '), 'TOOL_ICONS 补生图/生视频图标（历史折叠块不再 🔧）')
  // Q2a 编辑器画幅按钮组：先本地中心裁原图再编辑（编辑模型不收比例参数，接口硬限制）
  ok(appjs.includes('wb-iedit-ratios') && appjs.includes('data-ratio="16:9"'), '编辑器工具栏含画幅按钮组（原图/1:1/4:3/3:4/16:9/9:16）')
  ok(appjs.includes('const RATIO_OUT = ') && appjs.includes('applyCrop('), '画幅裁切实现（RATIO_OUT 标准输出尺寸 + applyCrop 中心裁切）')
  ok(appjs.includes('const origImg = new Image()'), '裁切始终以原图为像素源（反复切比例不叠加）')
  ok(appjs.includes("img.addEventListener('load', syncSize) // 常驻"), '换底图后遮罩画布重对齐（常驻 load 监听）')
  ok(css.includes('.wb-iedit-ratios') && css.includes('.wb-iedit-ratio.active'), 'CSS 画幅组样式（分段式 + active 高亮）')
  // Q2b 工具 desc 画幅换算指引（模型工具循环路径）→ 手册 图片视频.md
  ok(readManual('图片视频.md').includes('画幅换算（v2.4.83）') && readManual('图片视频.md').includes('"3:4"→768x1024'), 'desc 教模型提示词比例→宽x高换算，没提比例不许自作主张 → 手册 图片视频.md')
  // Q2c 直连管线提示词比例解析（无模型参与的直连路径）
  ok(agent.includes('function parseImgRatioSize(') && agent.includes('手机壁纸|手机屏|竖屏|竖图|竖版'), '直连生图提示词比例解析（显式比例数字优先，方向词兜底）')
  ok(agent.includes('async generateMedia(kind, prompt, size, images, batch, polish, steps)') && agent.includes('parseImgRatioSize(text)'), 'generateMedia 接收菜单尺寸 + 提示词解析兜底（v2.4.85 张数/润色 + v2.4.89 质量档入参）')
  // Q2d ✨菜单比例快捷按钮 + 胶囊 + 直连传参
  ok(html.includes('id="chatGenRatio"') && (html.match(/class="gr-btn/g) || []).length === 14, '✨菜单比例行 6 键 + 张数行 5 键 + 质量行 3 键（v2.4.89 含低30/中50/高100）')
  ok(appjs.includes('const GEN_RATIO_SIZE = ') && appjs.includes('GEN_RATIO_SIZE[work.genRatio]'), '比例→尺寸映射 + 直连传参')
  ok(appjs.includes("genRatioRow.querySelectorAll('.gr-btn')") && appjs.includes("setGenMode('image')"), '点比例自动带上图片生成模式（不关菜单）')
  ok(appjs.includes('图片生成模式${work.genRatio'), '生成模式胶囊显示所选比例')
  ok(preload.includes('aiGenerateImage: (sessionId, prompt, size, images, batch, polish, steps) =>'), 'preload 透传 size + images + batch/polish/steps（v2.4.85+v2.4.89）')
  ok(mainjs.includes("agent.generateMedia('image', String(prompt || ''), size, Array.isArray(images) ? images : [], batch, polish, steps)"), '主进程 handler 透传 size + images + batch/polish/steps（v2.4.85+v2.4.89）')
  ok(css.includes('.gen-menu-ratio') && css.includes('.gr-btn.active'), 'CSS 菜单比例行样式')
}

// ===== v2.4.84：图片生成模式参考图直通（拖图即图生图，1-3 张多图合成）=====
{
  console.log('— v2.4.84 图片模式参考图直通 + 多图编辑 —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 工具层：image 支持数组（1-3 张），第一张=主图；黑区语义仅单图成立
  ok(tools.includes("const imgRaw = Array.isArray(args.image) ? args.image : (args.image ? [args.image] : [])"), 'generate_image image 参数收数组（字符串/数组双兼容）')
  ok(tools.includes('if (imgs.length > 3) { droppedMulti = imgs.length - 3; imgs = imgs.slice(0, 3) }'), '超 3 张参考图截断并计数')
  ok(tools.includes('imgPayload = payloads.length === 1 ? payloads[0] : payloads'), '单图传字符串（现状兼容）/多图传数组（硅基流动 image: string|array）')
  ok(tools.includes('const editorIdx = imgs.findIndex((p) => /iedit-tmp[\\\\/]编辑_/.test(p))'), '编辑器黑区语义（v2.4.85 升级：多图命中任一张并指明第几张）')
  ok(tools.includes('多图合成 ${imgs.length} 张') && tools.includes('参考图超 3 张上限'), '结果 message 报告多图合成张数与截断提示')
  ok(readManual('图片视频.md').includes('③传 2-3 张 image 数组=多图合成/主体迁移'), 'desc 教模型多图用法（第一张=主图，其余=参考素材）→ 手册 图片视频.md')
  ok(readManual('图片视频.md').includes('传[image1,image2]'), 'params 示例含多图数组写法 → 手册 图片视频.md')
  // ② agent 直连层：images 数组 → args.image（≤3 双保险）
  ok(agent.includes('if (refs.length) args.image = refs.slice(0, 3)'), 'generateMedia 参考图入 args.image（slice(0,3) 双保险）')
  ok(agent.includes('const refs = (Array.isArray(images) ? images : []).map((x) => String(x || \'\').trim()).filter(Boolean)'), 'generateMedia 规整 images（非数组/空白项过滤）')
  // ③ IPC 层
  ok(mainjs.includes("ipcMain.handle('ai:generate-image', (event, { sessionId, prompt, size, images, batch, polish, steps }) =>"), 'main handler 接收 images + batch/polish/steps')
  ok(preload.includes('aiGenerateImage: (sessionId, prompt, size, images, batch, polish, steps) =>'), 'preload 透传 images + batch/polish/steps')
  // ④ 前端：图片模式下图胶囊自动转参考图
  ok(appjs.includes('function refImagePath(ref)'), 'refImagePath 顶层判断函数（引用胶囊→参考图路径）')
  ok(appjs.includes('return /\\.(png|jpe?g|webp)$/i.test(p) ? p : null'), '仅 png/jpg/jpeg/webp 可作参考图（编辑模型实际支持范围）')
  ok(appjs.includes('genRefImages = chatRefList.map(refImagePath).filter(Boolean)'), 'doSend 图片模式收集图片胶囊为参考图')
  ok(appjs.includes('genRefImages.length = 3; showToast(\'参考图最多 3 张，已只取前 3 张\', \'info\')'), '前端超 3 张截断 + toast 提示')
  ok(appjs.includes('full = text'), '图片模式 prompt 只含用户描述（[引用文件:] 协议不污染画面）')
  ok(appjs.includes("showToast(`${skipped} 个非图片引用已忽略（仅图片可作为参考图）`, 'info')"), '非图片引用剔除并提示')
  ok(appjs.includes("if (!text) { showToast(genRefImages.length ? '请描述想怎么用这些参考图生成画面' : '描述不能为空', 'info'); return }"), '图片模式必须有描述（有图无字引导，不静默）')
  ok(appjs.includes("if (work.genMode === 'image' && refImagePath(ref))"), '图片模式下图胶囊挂「参考图」小标')
  ok(appjs.includes("tag.className = 'ref-tag'") && appjs.includes("tag.textContent = '参考图'"), '参考图标识 DOM（视觉区分普通引用）')
  ok(appjs.includes('参考图×${refCnt}'), '生成模式胶囊显示参考图计数')
  ok(appjs.includes('拖图片进聊天框，发送时自动作为参考图'), '切图片模式 toast 可发现性提示')
  const cssAll = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')
  ok(cssAll.includes('.chat-ref-chip .ref-tag'), 'CSS 参考图小标样式')
}

// ===== v2.4.85：张数（1-4批量）+ 提示词润色 + 生成模式保持 + 编辑器自动带模式 =====
{
  console.log('— v2.4.85 张数/润色/模式保持/编辑器直通参考图 —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  // ① 张数：菜单张数行 + agent 解析 + tools batch_size
  ok(html.includes('id="chatGenCount"') && html.includes('data-count="4"'), 'HTML ✨菜单张数行（自动/1/2/4）')
  ok(agent.includes('function parseImgBatchCount(text)'), 'agent 张数解析函数（"生成4张/来两张"→1-4）')
  ok(agent.includes('if (pickedCnt >= 1 && pickedCnt <= 4) args.batch = pickedCnt'), 'generateMedia 菜单张数入 args.batch')
  ok(agent.includes('const fromPromptCnt = parseImgBatchCount(text)'), 'generateMedia 无菜单选择时从提示词解析张数')
  ok(tools.includes('const wantCnt = Math.min(4, Math.max(1, parseInt(args.batch, 10) || 1))'), 'tools 张数钳 1-4（v2.4.90 全路径生效，不再编辑强制 1）')
  ok(tools.includes('batch_size: wantCnt, negative_prompt: negPrompt, num_inference_steps: steps'), '文生图 body 带 batch_size（仅多张时，v2.4.86 负面词 + v2.4.88/89 步数档位化）')
  ok(tools.includes('let urls = (resp && Array.isArray(resp.images) ? resp.images : []).map((x) => x && x.url).filter(Boolean)'), '响应 images 数组全收（多张下载；let=2511 回落重取）')
  ok(tools.includes("savePath.slice(0, dot) + `_${i + 1}` + savePath.slice(dot)"), '多张按 _N 序号命名')
  ok(tools.includes('batch ${urls.length} 张'), '结果 message 报告批量张数')
  // ② 润色：菜单开关 + agent 单轮润色 + 降级链
  ok(html.includes('id="chatGenPolish"') && html.includes('data-icon="sparkles"') && html.includes('润色'), 'HTML 润色开关（v2.4.90 移到质量行末尾，Lucide 图标）')
  ok(appjs.includes("work.genPolish = !work.genPolish") && appjs.includes('提示词润色已开'), 'app 润色开关切换 + toast')
  ok(agent.includes('async polishImagePrompt(raw, hasRef, maskEdit, origRef)'), 'agent 润色函数（v2.4.86 三分支；v2.4.87 原貌参考感知）')
  ok(agent.includes("if (route.isWeb) return null // 网页版模型：无本地单轮通道，润色跳过"), '润色网页模式跳过（无本地通道）')
  ok(agent.includes('args.prompt = polished') && agent.includes('（提示词已润色）'), '润色结果替换 prompt + 结果标注')
  ok(agent.includes('（润色跳过，使用原始描述）'), '润色失败降级原样（不阻塞生成）')
  ok(agent.includes('if (polish !== false)'), '润色默认开（false 才关）')
  // ③ 模式保持 + 编辑器自动带模式（老大实测场景：编辑完添加到对话再拖新图当参考）
  ok(!appjs.includes('    clearGenMode()\n    renderChatRefs()'), 'doSend 发送后不再自动清生成模式（保持连续生图）')
  ok(appjs.includes("work._setGenMode = (mode) => setGenMode(mode)"), '挂 _setGenMode 外部钩子')
  ok(appjs.includes("if (typeof work._setGenMode === 'function') work._setGenMode('image')"), '编辑器「发送到对话框」自动切图片模式（编辑图=参考图）')
  ok(appjs.includes("gm.querySelector('.chip-x').addEventListener('click', clearGenMode)"), '模式胶囊 × 手动退（保持后唯一退出）')
  ok(appjs.includes('work.genCount ? ` · ${work.genCount}张`'), '模式胶囊显示张数')
  // ④ 多图含编辑图黑区语义（编辑图+新拖图多图合成场景）
  ok(tools.includes('const editorIdx = imgs.findIndex((p) => /iedit-tmp[\\\\/]编辑_/.test(p))'), '黑区语义改 findIndex（多图命中任一张）')
  ok(tools.includes('第 ${editorIdx + 1} 张是编辑基准图'), '多图黑区语义指明基准图（v2.4.87 分工版）')
  // ⑤ IPC 层
  ok(preload.includes('aiGenerateImage: (sessionId, prompt, size, images, batch, polish, steps)'), 'preload 透传 batch + polish + steps')
  ok(mainjs.includes('agent.generateMedia(\'image\', String(prompt || \'\'), size, Array.isArray(images) ? images : [], batch, polish, steps)'), '主进程 handler 透传 batch + polish + steps')
  const css85 = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')
  ok(css85.includes('.gr-btn.gr-toggle') && css85.includes('border-style: dashed'), 'CSS 润色开关样式（关=虚线灰）')
}

// ===== v2.4.87：参考原图（遮罩编辑带原貌参考，微调保形态，老大拍板默认开）=====
{
  console.log('— v2.4.87 参考原图：编辑器开关 + 「原_」配对 + 黑区语义分工 —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 编辑器 UI：开关默认开 + 发送时带「原_」胶囊
  ok(appjs.includes("class=\"wb-iedit-origref-chk\" checked"), '编辑器「参考原图」开关（默认勾选）')
  ok(appjs.includes('origRefUrl = off.toDataURL(\'image/png\')'), '涂黑前先导出无遮罩原貌版（同 canvas 复用）')
  ok(appjs.includes('if (origRefUrl.length > 12.5 * 1024 * 1024) origRefUrl = off.toDataURL(\'image/jpeg\', 0.92)'), '原貌图超 10MB 降 JPEG（10MB 接口限制）')
  ok(appjs.includes('`\\\\iedit-tmp\\\\原_${base}_${ts}.${oext}`'), '「原_」同 base 同时间戳配对命名')
  ok(appjs.includes('if (origRefSavedPath) work._appendChatRef(`[引用文件: ${origRefSavedPath}]`)'), '原图胶囊紧随编辑图胶囊（顺序固定）')
  ok(appjs.includes('if (hasMask && origrefChk && origrefChk.checked)'), '仅涂抹+勾选才存原貌图（整图直传不需要）')
  // ② tools 黑区语义：配对识别 + 分工说明
  ok(tools.includes("imgs.findIndex((p, i) => i !== editorIdx && /iedit-tmp[\\\\/]原_/.test(p))"), '「原_」配对识别（非编辑图位次）')
  ok(tools.includes('第 ${origRefIdx + 1} 张是遮罩区域修改前的原貌参考图'), '黑区语义说明原貌参考图分工')
  ok(tools.includes('必须保持原主体的形态、结构与身份特征，仅在指令要求的维度上修改'), '微调类指令保形态身份（老大核心诉求）')
  ok(tools.includes('若指令是替换或删除，按指令执行，不受原貌约束'), '替换/删除不受原貌约束（防残留）')
  ok(tools.includes("const baseRef = imgs.length > 1 ? `第 ${baseIdx} 张基准图` : '原图'"), '基准图引用单/多图自适应（原文→基准图）')
  ok(readManual('图片视频.md').includes('「原_」开头的是遮罩区修改前的原貌参考图'), 'desc 同步「原_」语义（工具循环路径）→ 手册 图片视频.md')
  // ③ agent 润色：原貌感知
  ok(agent.includes("const origRef = maskEdit && refs.some((p) => /iedit-tmp[\\\\/]原_/.test(p))"), '润色检测「原_」配对')
  ok(agent.includes('保持原主体的形态、结构与身份特征，仅修改指令要求的维度'), '润色 maskEdit 分支感知原貌（微调措辞）')
  // ④ CSS
  const css87 = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')
  ok(css87.includes('.wb-iedit-origref') && css87.includes("accent-color: var(--accent)"), 'CSS 参考原图开关样式')
}

// ===== v2.4.88：推理步数 20→30（编辑图噪点白斑+文字花修复，老大实测反馈）=====
{
  console.log('— v2.4.88 推理步数提效：编辑/文生图统一默认步数（20→30 治白斑） —')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(tools.includes('num_inference_steps: steps'), '推理步数入请求体（v2.4.89 档位化变量）')
  ok(tools.includes('API 默认 20 步收敛不完全→暗部亮部出白斑、文字被啃花'), '注释记录根因（20 步噪点来源）')
  // 编辑和文生图两分支都带（三处：编辑 body / 文生图多张 body / 文生图单张 body）
  const bodyAll = tools.slice(tools.indexOf('async generate_image'), tools.indexOf('async generate_video'))
  ok((bodyAll.match(/num_inference_steps: steps/g) || []).length === 4, '全部请求体带步数变量（v2.4.90：editBody/t2iBody×2/singleBody 四处）')
}

// ===== v2.4.89：质量档位（✨菜单 低30/中50/高100，老大拍板）=====
{
  console.log('— v2.4.89 质量档位：推理步数可选 低30/中50/高100（编辑+文生图都生效） —')
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(html.includes('id="chatGenQuality"') && html.includes('data-steps="100"'), 'HTML ✨菜单质量行（低30/中50/高100，默认低30）')
  ok(appjs.includes("work.genSteps = b.dataset.steps || '30'"), '质量行点击绑定 work.genSteps')
  ok(appjs.includes("work.genSteps || '30'"), 'doSend 透传质量档位（默认 30）')
  ok(appjs.includes("work.genSteps !== '30'"), '模式胶囊非默认档显示步数')
  ok(preload.includes('aiGenerateImage: (sessionId, prompt, size, images, batch, polish, steps)'), 'preload 透传 steps')
  ok(mainjs.includes('{ sessionId, prompt, size, images, batch, polish, steps }'), 'main handler 接收 steps')
  ok(agent.includes('async generateMedia(kind, prompt, size, images, batch, polish, steps)'), 'agent generateMedia 收 steps')
  ok(agent.includes('args.steps = Math.min(100, Math.max(1, parseInt(steps, 10) || 30))'), 'agent steps 钳 1-100 默认 30')
  ok(tools.includes('const stepsRaw = Math.min(100, Math.max(1, parseInt(args.steps, 10) || 30))'), 'tools steps 钳 1-100 默认 30（v2.4.91 编辑模式再钳 50）')
  ok(readManual('图片视频.md').includes('steps(可选,推理步数1-100默认30'), '工具 desc 支持 steps 参数（AI 对话路径可调质量）→ 手册 图片视频.md')
}

// ===== v2.4.90：✨菜单 UI 舒展化 + 编辑模式多张（4张+参考图仍出1张修复，老大实测反馈）=====
{
  console.log('— v2.4.90 菜单防挤压 + 参考图模式多张（逐张补齐循环） —')
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① UI 舒展化：润色移到质量行 + 菜单加宽 + 按钮防竖排字
  const qualityRow = html.slice(html.indexOf('id="chatGenQuality"'), html.indexOf('id="chatGenQuality"') + 600)
  ok(qualityRow.includes('id="chatGenPolish"'), '润色开关在质量行末尾（张数行 4 键不再挤）')
  ok(css.includes('min-width: 272px'), '菜单加宽 200→272px')
  ok(css.includes('.gen-menu-ratio .gr-btn {\n  padding: 3px 9px;') && css.includes('white-space: nowrap;\n  flex-shrink: 0;\n}'), '按钮 nowrap+flex-shrink:0（防"默认/自动"竖排字）')
  // ② 编辑模式多张：wantCnt 全路径 + 逐张补齐循环 + 进度回调
  ok(tools.includes('const wantCnt = Math.min(4, Math.max(1, parseInt(args.batch, 10) || 1))'), '张数解析不再按 imgPayload 强制 1（断点根因）')
  ok(tools.includes('while (urls.length < wantCnt && guard < wantCnt)'), '补齐循环：实回张数短于要求数时逐张补')
  ok(tools.includes('if (urls.length >= wantCnt || extraFails >= 2) break'), '补齐止损：达标或连败 2 次停（保留已出的）')
  ok(tools.includes("prog(`\\n⏳ 已出 ${urls.length}/${wantCnt} 张，正在补生成第 ${Math.min(urls.length + 1, wantCnt)} 张…\\n`)"), '补生成实时进度（"已出 N/M 张"）')
  ok(agent.includes('args.progress = (msg) => this.send({ type: \'content_delta\', delta: msg })'), 'agent 注入 progress 回调（tools→前端 content_delta）')
  ok(tools.includes('同一指令连续生成 ${urls.length} 张变体'), '编辑多张结果消息标注变体数')
  ok(appjs.includes('参考图编辑将连续生成 ${genBatch} 张变体（逐张生成，稍慢）'), '发送前 toast 改为多张变体提示')
  ok(readManual('图片视频.md').includes('batch(可选,一次生成张数1-4') && readManual('图片视频.md').includes('编辑(带image)模式下多张=同一指令逐张多次生成稍慢'), 'desc 更新：编辑模式 batch 语义（AI 对话路径同步）→ 手册 图片视频.md')
}

// ===== v2.4.91：编辑模型步数钳50 + 润色治乱码/手部/布局（老大实测：乱字+手部错误+选50步仍有问题）=====
{
  console.log('— v2.4.91 编辑步数上限50 + 润色三规则（图内文字精简/手部正向约束/显式布局） —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 步数钳制：v2.4.91 首创 → v2.4.92 按模型自适应（Qwen-Image-Edit 系 50，其余编辑模型 100）
  ok(agent.includes("const editCap = /qwen-image-edit/i.test(editModelName) ? 50 : 100"), 'agent：编辑步数上限按模型自适应（换高步数模型不被卡）')
  ok(agent.includes('最高 ${editCap} 步，质量档已自动降'), '降级时前端 delta 提示（动态模型名+上限）')
  ok(tools.includes('const stepsCap = /qwen-image-edit/i.test(model) ? 50 : 100'), 'tools：步数上限按请求模型自适应（双保险）')
  ok(readManual('图片视频.md').includes('上限按模型自适应:Qwen-Image-Edit系最高50其余100自动降'), 'desc steps 参数自适应语义 → 手册 图片视频.md')
  // ② 润色三规则（hasRef 普通编辑分支）
  ok(agent.includes('【图内文字】需要出现在图片里的文字标注，一律精简为 2-8 字短语'), '润色【图内文字】：标注精简短语+最多3处（治"高槁内辫"乱码）')
  ok(agent.includes('长句文案、卖点解释类内容严禁写进图片'), '长文案严禁进图（转视觉表达）')
  ok(agent.includes('【人物手部】画面含人物时，明确写"手部姿态自然放松、五指结构正确、比例真实"'), '润色【人物手部】：正向约束（编辑接口无负面词）')
  ok(agent.includes('【布局结构】多区域拼接/多卖点展示时，显式描述版式'), '润色【布局结构】：显式版式（防模型自由发挥）')
  ok(agent.includes('220 字以内'), '编辑润色字数上限 150→220（装下布局+文字规则产出）')
  // ③ 文生图分支同步
  ok(agent.includes('用户要求图内出现文字标注时，精简为 2-8 字短语并注明位置（最多 3 处）'), '文生图润色同步文字精简规则')
  ok(agent.includes('画面含人物时写明手部姿态自然、五指结构正确'), '文生图润色同步手部约束')
  // ④ desc 同步
  ok(readManual('图片视频.md').includes('图内中文长文本是错字重灾区（"高腰"会画成"高槁"）'), 'desc 图内文字警示（AI 对话路径同步）→ 手册 图片视频.md')
  ok(readManual('图片视频.md').includes('步数上限按模型自适应：Qwen-Image-Edit 系 50、其余 100'), 'desc 注明编辑步数自适应上限 → 手册 图片视频.md')
}

// ===== v2.4.92：步数上限按模型自适应（老大追问：换支持高步数的编辑模型会被卡吗？会——改自适应）=====
{
  console.log('— v2.4.92 编辑步数上限模型自适应（Qwen-Edit 系 50 / 其他 100，换模型不被卡） —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  ok(agent.includes("String(this.getConfig().aiImageEditModel || 'Qwen/Qwen-Image-Edit-2509')"), 'agent 读配置的编辑模型名（含默认值兜底）')
  ok(agent.includes('if (refs.length) {\n        const editModelName'), '自适应仅编辑模式生效（文生图不受限）')
  ok(agent.includes('const editCap = /qwen-image-edit/i.test(editModelName) ? 50 : 100'), 'agent 判定规则：模型名含 Qwen-Image-Edit → 50，否则 100')
  ok(tools.includes('const stepsCap = /qwen-image-edit/i.test(model) ? 50 : 100'), 'tools 按实际请求模型同规则双保险')
  ok(tools.includes('const steps = Math.min(stepsCap, stepsRaw)'), 'steps = min(模型上限, 用户所选)——高步数模型完整享受高档位')
  ok(agent.includes('编辑模型 ${editModelName.split(\'/\').pop()} 最高 ${editCap} 步'), '降级提示带真实模型名与上限（换模型提示不撒谎）')
}

// ===== v2.4.86：提示词规范化（卷质量）——润色三分支 + 黑区语义重写 + 负面词 =====
{
  console.log('— v2.4.86 提示词规范化（遮罩编辑严格保真 + 结构化润色 + 负面词） —')
  const agent = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  // ① 润色三分支：遮罩编辑专门分支（修"全局措辞与黑区语义打架"真 bug）
  ok(agent.includes('const maskEdit = refs.some((p) => /iedit-tmp[\\\\/]编辑_/.test(p))'), 'generateMedia 检测参考图含遮罩编辑图')
  ok(agent.includes('polishImagePrompt(text, refs.length > 0, maskEdit, origRef)'), '润色透传 maskEdit + origRef（三分支路由+原貌感知）')
  ok(agent.includes('禁止出现"调整整张图/整体色调/全局优化"类措辞'), '遮罩润色禁止全局措辞（源头杜绝与黑区语义冲突）')
  ok(agent.includes('对「遮罩区域内最终画面」的精确描述'), '遮罩润色只描述遮罩区内画面')
  ok(agent.includes('严格按以下四行格式输出'), '文生图润色结构化输出（主体/环境/风格/光线分行）')
  ok(agent.includes('主体：<外观/动作/表情>'), '结构化模板四行齐全')
  ok(agent.includes('风格行自然带上高清/细节丰富等画质词'), '风格行带画质词引导')
  ok(agent.includes('逐条保留用户全部修改意图'), '普通编辑润色逐条保留意图（替换模糊的"不改变幅度"）')
  // ② 黑区语义重写：约束前置 + 三要素点名 + 黑色是标记 + 成品无遮罩
  ok(tools.includes('【图片局部重绘任务】'), '黑区语义任务头前置（扩散模型对首尾最敏感）')
  ok(tools.includes('只是位置标记，不是图片内容，严禁画成黑色物体'), '显式说明黑色是标记（防画成黑色物体）')
  ok(tools.includes('光照方向、色温、材质纹理、物体形态、构图透视、景深、噪点颗粒'), '未涂抹区还原清单点名（光照/色温/材质/形态/景深/噪点——老大三要素齐）')
  ok(tools.includes('严禁重绘、移动、缩放、增删、调色'), '未涂抹区禁止行为枚举')
  ok(tools.includes('成品中不保留黑色遮罩标记'), '成品不含遮罩标记（明确黑区会被替换）')
  ok(tools.includes('【硬性约束·最高优先级】'), '硬性约束收尾（首尾夹击）')
  // ③ 文生图负面词
  ok(tools.includes("const negPrompt = !imgPayload ? 'blurry, low quality"), '文生图固定负面词（Kolors negative_prompt）')
  ok(tools.includes('negative_prompt: negPrompt') && tools.includes('batch_size: wantCnt, negative_prompt: negPrompt'), '文生图 body 带负面词（v2.4.90：t2iBody×2+singleBody 三处共用）')
  ok(!/image: imgPayload[^}]*negative_prompt/.test(tools.slice(tools.indexOf('async generate_image'), tools.indexOf('async generate_video'))), '编辑模式不带负面词（Qwen-Image-Edit 不收，防干扰保留语义）')
  // ④ desc 强化（工具循环路径）→ 手册 图片视频.md
  ok(readManual('图片视频.md').includes('只重绘黑区对应位置的内容，遮罩外的光照、色温、材质、形态、构图必须与原图完全一致'), 'desc 黑区说明强化（工具循环路径同步新语义）→ 手册 图片视频.md')
}

// ===== v2.4.93：联网三件套（Scrapling 讨论落地：不引 Python，治它想治的病）——
// Readability 正文提取 + 四引擎搜索池 + Electron net 真 Chromium TLS 指纹 =====
{
  console.log('— v2.4.93 联网升级：Readability 正文提取 + 四引擎搜索 + net TLS 指纹 —')
  const tools = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  // ① C：Electron net 优先（TLS 握手指纹=真 Chrome，过"TLS 识别"型反爬），纯 Node 优雅降级
  ok(tools.includes('function netGet(url, timeoutMs, headers)') && tools.includes("net.request({ url, redirect: 'follow', headers })"), 'httpGet Electron net 分支（Chromium 网络栈）')
  ok(tools.includes("if (err && err.message === 'NET_UNAVAILABLE') return httpNodeGet(url, timeoutMs, 0, headers)"), 'NET_UNAVAILABLE → 原生 https 优雅降级')
  ok(tools.includes('function httpNodeGet(url, timeoutMs, redirectCount = 0, headers = null)') && tools.includes('function decompressBuf(buf, enc)'), '原生兜底分支 + 公共解压（返回结构对齐 status/contentType/headers/buf）')
  // ② A：Readability 正文提取（导航/页脚剔除，治"垃圾占满字数额度正文被截"）
  ok(pkg.dependencies['@mozilla/readability'] && pkg.dependencies['linkedom'], '依赖落盘：@mozilla/readability + linkedom（纯 JS 零原生编译）')
  ok(tools.includes('function extractArticleText(html, url, maxLen = 9000)') && tools.includes("require('@mozilla/readability').Readability"), 'extractArticleText（Readability + linkedom 延迟加载，缺包不炸）')
  ok(tools.includes('const article = extractArticleText(html, url, 9000)') && tools.includes('const text = article || htmlToText(html, 9000)'), 'web_fetch 正文双引擎：Readability 优先 + 旧版全页兜底')
  ok(tools.includes('（本页未能定位正文块，以上为全页文本'), '降级时带"未定位正文块"标注（AI 可感知质量）')
  // ③ B：四引擎池 + 百度 cookie 预取 + 竞速收口
  ok(tools.includes("{ name: '必应国内', run: (q) => bingSearch(q, 'cn.bing.com') }") && tools.includes("{ name: '必应国际', run: (q) => bingSearch(q, 'www.bing.com') }"), '引擎池：必应国内 + 必应国际（同解析器两主机）')
  ok(tools.includes("{ name: '百度', run: baiduSearch }") && tools.includes("{ name: 'DuckDuckGo', run: ddgSearch }"), '引擎池：百度 + DuckDuckGo')
  ok(tools.includes("await httpGet('https://www.baidu.com/', 8000)") && tools.includes('/^(BAIDUID|BIDUPSID|PSTM|H_PS_PSSID)/i.test(c)'), '百度 cookie 预取（治"安全验证"拦截，v2.4.93 实测生效）')
  ok(tools.includes('被百度安全验证拦截'), '百度被拦 → 明确报因（引擎级失败不拖累全局）')
  ok(tools.includes('const anyOk = new Promise((res) => { for (const p of engPs)') && tools.includes('await Promise.race([Promise.all(engPs), new Promise((r) => setTimeout(r, 1500))])'), '竞速收口：首引擎出结果 + 1.5s 宽限（防不可达引擎拖慢全场）')
  ok(tools.includes('html.duckduckgo.com/html/?q=') && tools.includes('kl=cn-zh'), 'DDG html 版 + 中国区权重（7s 快败超时）')
  ok(tools.includes('unwrapDDG') && tools.includes('[?&]uddg=([^&]+)'), 'DDG 跳转链解包 uddg → 真实地址')
  ok(tools.includes('group.push(`${total}. [${it.from}] ${it.title}'), '结果带 [引擎] 来源标注')
  // ④ 真跑：Readability 离线样张（导航/页脚剔除 + 标题带出 + 短页兜底）
  const { extractArticleText } = require(path.join(ROOT, 'ai/tools.js'))
  const artHtml = `<!doctype html><html><head><title>冒烟样张</title></head><body><nav><a href="/">首页</a><a href="/hot">热点</a></nav><article><h1>冒烟样张</h1><p>${'这是冒烟测试正文段落。'.repeat(40)}</p></article><footer><p>版权所有 | 备案号 | <a href="#">友链</a></p></footer></body></html>`
  const art = extractArticleText(artHtml, 'https://example.com/post/1', 9000)
  ok(!!art && art.includes('冒烟样张') && art.includes('冒烟测试正文段落'), 'Readability 真跑：正文+标题提取')
  ok(!!art && !art.includes('备案号') && !art.includes('友链'), 'Readability 真跑：页脚/导航垃圾剔除')
  ok(!extractArticleText('<div>x</div>', 'https://e.com', 9000), 'Readability 真跑：太短返回 null（走兜底）')
}

// ===== v2.4.94：Word 高保真预览+所见即所得编辑（docx-preview）+ xlsx 版式还原 + AI 写 Word 破框架 =====
{
  console.log('— v2.4.94 Word 保真视图 + xlsx 版式还原 + 破框架 —')
  const appJs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const preloadJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
  const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok(pkg.dependencies['docx-preview'], '依赖落盘：docx-preview（纯前端渲染，jsdom 仅 devDep 做测试）')
  // ① 渲染链路：主进程 buffer IPC + preload docx-preview 桥
  ok(mainJs.includes("ipcMain.handle('fs:docx-buffer'") && mainJs.includes("base64: fs.readFileSync(filePath).toString('base64')"), 'fs:docx-buffer IPC（20MB 上限）')
  ok(preloadJs.includes('renderDocxPreview: async (base64, hostId)') && preloadJs.includes("require('docx-preview')"), 'preload docx-preview 渲染桥（隔离世界操作共享 DOM）')
  ok(preloadJs.includes('useBase64URL: true'), '图片转 dataURI（blob: URL 主进程拿不到）')
  ok(preloadJs.includes('renderHeaders: true, renderFooters: true') && preloadJs.includes('ignoreLastRenderedPageBreak: false'), 'v2.5.1 页眉页脚照常渲染 + 遵循 Word 分页标记（WPS 观感对齐）')
  ok(appJs.includes(".docx-wrapper section.docx > article") && appJs.includes('页眉/页脚/脚注/尾注渲染出来是为了对齐 WPS 观感'), '保存链路只收 article 正文（页眉页脚渲染但不进保存）')
  // ② 编辑器：高保真渲染 + mammoth 降级兜底
  ok(appJs.includes('const bufResp = await _api.docxBuffer(item.path).catch(() => null)') && appJs.includes('await _api.renderDocxPreview(bufResp.base64, hostId)'), 'mountWbDocxRich 走 docx-preview 高保真渲染')
  ok(appJs.includes('let hiFi = false') && appJs.includes('ed.innerHTML = fallbackHtml'), '渲染失败降级 mammoth 起稿（双模式兜底）')
  ok(appJs.includes('共 ${rr.pages || 1} 页 · 高保真分页视图'), '页数角标（section.docx 计数）')
  // ③ 收集器：docx-preview DOM → 段落/runs 模型（新字段 size/font/shade）
  ok(appJs.includes('function wbCssColorToHex(css)') && appJs.includes('rgb\\(\\s*(\\d{1,3})'), 'rgb() → HEX 颜色提取（docx-preview 输出形态）')
  ok(appJs.includes('const hm = /docx_heading([1-6])/.exec(cls)') && appJs.includes('/\\bdocx_title\\b/.test(cls)'), '标题族 class 还原（docx_heading*/docx_title → h1/h2/h3）')
  ok(appJs.includes('if (/border-left\\s*:/.test(pst)) return emitWbBlock(n, \'quote\''), '引用块还原（p style border-left → quote）')
  ok(appJs.includes('nf.size = Math.round(parseFloat(sm[1]) * (sm[2] === \'px\' ? 1.5 : 2))'), '字号提取（pt/px → 半点）')
  ok(appJs.includes("for (const k of ['bold', 'italic', 'underline', 'strike', 'highlight', 'color', 'font', 'size', 'shade'])"), 'wbSplitRuns 合并键扩展（size/shade）')
  // ④ xlsx 版式还原
  ok(mainJs.includes('function xlsxDisplay(v, numFmt)') && mainJs.includes('merges'), 'fs:xlsx-sheet 带出列宽/合并/numFmt/样式')
  ok(appJs.includes('const covered = new Set()') && appJs.includes('td.rowSpan = mg.r2 - mg.r1 + 1'), '网格合并单元格渲染（rowspan/colspan + 覆盖跳过）')
  ok(appJs.includes("Math.min(420, Math.round(w * 7 + 5))"), '列宽还原（Excel 字符宽 → px）')
  ok(appJs.includes("(cell.t != null ? cell.t : cell.v)"), '显示值分层：编辑覆盖 > 公式 > numFmt 格式化 > 原始文本')
  // ⑤ office.js 新能力 + 破框架
  ok(officeJs.includes("r.shade ? { shading: { type: ShadingType.CLEAR, fill: r.shade } } : {}"), 'docxRun 支持 run 底纹（v2.5.68 改 CLEAR——SOLID 在 WPS 渲染成前景色实心=黑底看不清字）')
  ok(officeJs.includes("style === 'divider'") && officeJs.includes("if (/^\\s*(-{3,}|\\*{3,})\\s*$/.test(s)) out.push({ style: 'divider' })"), 'divider 分隔线（{style:divider} + --- 两种写法，空段不再被 normParagraphs 丢弃）')
  ok(readManual('word文档.md').includes('版式蓝图先行（破除千篇一律，每篇必做）') && readManual('word文档.md').includes('连续两篇同骨架=排版失败'), 'create_word desc 版式蓝图引导（骨架三选一打破路径依赖）→ 手册 word文档.md')
}

// ===== 收口（async）：webchat 页面脚本真语法校验 harness =====
// v2.4.80 真机实锤：executeJavaScript 模板字符串里的注释含 \n 转义，cook 成真实换行截断 //
// 注释、后半截变非法代码 → 整条页面脚本 SyntaxError → GUEST_VIEW_MANAGER_CALL "Script failed
// to execute"。字符串断言抓不到这种语法层炸——必须真的 cook 出页面脚本再 new Function 解析。
// 做法：Node 最小 DOM 桩装载 webchat.js，真跑两遍 send()（正文匹配 / 回显被吞走附件兜底），
// 让 fill/upload/clickSend/confirmSent/引导语全部模板真实 cook，逐条语法解析
;(async () => {
  try {
    const vm = require('vm')
    const scripts = []
    let echoMatch = true
    const PROMPT = '可以看到这个图片吗喵。\n\n引用位置：C:\\Users\\ars\\Desktop\\图\\鸣人_1920.png（本机）\n↑ 上面的引用位置就是这次操作的目标，请直接对我说的内容在该位置执行'
    const PROMPT2 = '【系统传递】你上一轮工具调用的执行结果、系统提醒与格式提醒，已作为附件《工具结果.md》上传。请先读取附件全部内容，再继续任务。'
    const fakeNode = () => ({
      id: '', className: '', textContent: '',
      classList: { add() {}, remove() {} },
      setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {},
      loadURL: async () => {},
      executeJavaScript: async (s) => { scripts.push(String(s)); return respond(String(s)) }
    })
    const sandbox = {
      window: {},
      console,
      setTimeout, clearTimeout, setInterval, clearInterval,
      document: {
        getElementById: (id) => (id === 'wbView' ? fakeNode() : null),
        createElement: () => fakeNode(),
        querySelector: () => null,
        querySelectorAll: () => []
      }
    }
    vm.createContext(sandbox)
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/js/webchat.js'), 'utf8'), sandbox)
    const wc = sandbox.window.WbWebChat
    ok(!!wc && typeof wc.send === 'function', 'webchat IIFE 可在 Node 桩环境装载（harness 前置）')
    let respond = (s) => {
      if (s.includes('__mswbTake')) return { events: [], state: 'idle', full: 'OK', gotChunk: true, url: 'https://chat.deepseek.com/a/chat/s/t' }
      if (s.includes('__mswbProbe')) return ''
      if (s.includes('userToken')) return { token: true, hasInput: true, url: 'https://chat.deepseek.com/a/chat/s/t' }
      if (s.includes('!!(document.querySelector')) return true
      if (s.includes('__mswbHook')) return 'armed'
      if (s.includes('__mswbReset')) return 'ok'
      if (s.includes('__mswbFingerprint')) return null
      if (s.includes('new File([')) return { ok: true }
      if (s.includes('【消息传递】')) return 'ok'
      if (s.includes('cntNow')) return { empty: true, cnt: 1, cntNow: echoMatch ? 1 : 0 }
      if (s.includes('preCnt')) return { ok: true, via: 'button', preCnt: 0, cnt0: 0 }
      if (s.includes('const text = ')) return { ok: true, echo: echoMatch ? PROMPT : '（回显被网页吞掉）' }
      if (s.includes('location.href')) return 'https://chat.deepseek.com/a/chat/s/t'
      return null
    }
    // 第一遍：正文回显匹配（fill→clickSend→confirmSent 全链路）
    const errors1 = []
    wc.send('deepseek', PROMPT, { onDelta() {}, onDone() {}, onError(m) { errors1.push(String(m)) }, onConvUrl() {} }, null, false, '')
    await new Promise((r) => setTimeout(r, 3500))
    ok(errors1.length === 0, `harness 第一遍发送无报错${errors1.length ? '：' + errors1[0] : ''}`)
    // 第二遍：回显被吞 → 走附件注入 + 引导语兜底（【系统传递】前缀免验证循环，跑得快）
    echoMatch = false
    wc.send('deepseek', PROMPT2, { onDelta() {}, onDone() {}, onError() {}, onConvUrl() {} }, null, false, '')
    await new Promise((r) => setTimeout(r, 3500))
    const cooked = scripts.join('\n')
    ok(scripts.some((s) => s.includes('preCnt')) && scripts.some((s) => s.includes('cntNow')), `harness 真跑到 clickSend/confirmSent（共 cook ${scripts.length} 条脚本）`)
    ok(cooked.includes('new File([') && cooked.includes('【消息传递】'), '兜底通道（附件注入 + 引导语）脚本也被 cook 覆盖')
    const bad = []
    for (const s of scripts) {
      try { new Function('return (' + s + ')') } catch (e) { bad.push(`「${s.slice(0, 60).replace(/\n/g, ' ')}…」${e.message}`) }
    }
    ok(bad.length === 0, `全部页面脚本 cook 后语法有效${bad.length ? '，炸点：' + bad.join(' | ') : ''}`)
  } catch (e) {
    ok(false, 'webchat 页面脚本语法校验 harness 异常：' + e.message)
  }

  // ===== v2.4.95：Word 全格式解析 + 参考 A 改 B（read_word_format / apply_word_format）=====
  {
    console.log('— v2.4.95 Word 全格式解析 + 参考 A 改 B —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    // ① 引擎落盘断言（零新依赖：复用 v2.4.93 的 linkedom）
    ok(officeJs.includes("parseFromString(String(xml), 'text/xml')") && officeJs.includes("require('linkedom')"), 'XML 解析用 linkedom text/xml 模式（OOXML 自闭合/命名前缀正确，零新依赖）')
    ok(officeJs.includes('function cascadeStyle(styleId, stylesCtx, kind)') && officeJs.includes('depth < 8') && officeJs.includes('seen.has(cur)'), '样式级联：pStyle → basedOn 链（深度≤8 + seen 防环）→ docDefaults')
    ok(officeJs.includes('/heading 1|标题 1/.test(name)') && officeJs.includes("pPr.numPr"), '角色识别：outlineLvl + 中英样式名（Heading/标题 1-3/quote/numPr）')
    ok(officeJs.includes('function fmtToPPrXml') && officeJs.includes('w:lineRule="auto"') && officeJs.includes('w:firstLineChars='), '格式对象 → OOXML（行距倍数/exact 磅值/首行缩进字符/对齐/颜色/字体）')
    ok(officeJs.includes('/<w:p(?:\\s[^>]*)?\\/>|<w:p(?:\\s[^>]*)?>[\\s\\S]*?<\\/w:p>/g') && officeJs.includes('tblDepth'), '段落块扫描含自闭合空段（防错位）+ tblDepth 表格追踪（表格内段落不参与角色映射）')
    ok(toolsJs.includes("name: 'read_word_format'") && toolsJs.includes("name: 'apply_word_format'"), '工具注册：read_word_format + apply_word_format')
    ok(toolsJs.includes('read_word_format 暂只支持本机文件') && toolsJs.includes('apply_word_format 暂只支持本机文件'), '远程 target 明确拒绝并引导 transfer_file（暂不支持远程）')
    // ② 真跑：造 A（格式源 modern/1.4 行距）+ B（目标默认格式）
    const os = require('os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke95-'))
    const aPath = path.join(dir, 'A源.docx')
    const bPath = path.join(dir, 'B目标.docx')
    const office = require(path.join(ROOT, 'ai/office.js'))
    await office.createDocx(aPath, { title: '格式参考文档', paragraphs: [{ text: '第一章 总则', style: 'h1' }, { text: '正文样本段落一，承载字体字号行距的格式样本。', style: 'normal' }, { text: '正文样本段落二。', style: 'normal' }], theme: { base: 'modern' }, lineSpacing: 1.4 })
    await office.createDocx(bPath, { title: '目标文档', fonts: { heading: '宋体', body: '宋体', western: 'Times New Roman' }, paragraphs: [{ text: '第一节 背景', style: 'h1' }, { text: '目标正文段落一。', style: 'normal' }, { text: '目标正文段落二。', style: 'normal' }] })
    // ③ 解析真跑：角色/级联格式/页面
    const parsed = await office.parseWordFormat(aPath)
    ok(parsed.paragraphs.length === 4 && parsed.paragraphs[0].role === 'title' && parsed.paragraphs[1].role === 'h1' && parsed.paragraphs[2].role === 'normal', `解析真跑：角色识别 title/h1/normal（共 ${parsed.paragraphs.length} 段）`)
    ok(parsed.page && Math.abs(parsed.page.widthCm - 21) < 0.3 && Math.abs(parsed.page.heightCm - 29.7) < 0.3, `页面设置解析（${parsed.page ? parsed.page.widthCm + '×' + parsed.page.heightCm + 'cm' : 'null'}）`)
    const h1Fmt = parsed.paragraphs[1].run
    ok(h1Fmt.sizePt === 16 && h1Fmt.bold === true && h1Fmt.color === '2E5E8C', `标题 run 级联格式（${h1Fmt.eastAsiaFont || h1Fmt.font} ${h1Fmt.sizePt}pt 粗${h1Fmt.bold} 色#${h1Fmt.color}）`)
    const bodyFmt = parsed.paragraphs[2]
    ok(bodyFmt.run.sizePt === 12 && bodyFmt.para.lineRatio && Math.abs(bodyFmt.para.lineRatio - 1.42) < 0.05, `正文 run+段落格式（${bodyFmt.run.eastAsiaFont || bodyFmt.run.font} ${bodyFmt.run.sizePt}pt 行距${bodyFmt.para.lineRatio}）`)
    const fp = office.wordFormatFingerprint(parsed)
    ok(fp.summary.includes('一级标题') && fp.summary.includes('正文') && fp.fingerprint.h1 && fp.fingerprint.body && fp.fingerprint.h1.sizePt === 16, '格式指纹聚合（可读摘要 + JSON，正文众数/标题代表）')
    // ④ 混合套用真跑：map(source) 批量 + picks 精准
    const r = await office.applyWordFormat(bPath, aPath, { map: { h1: 'source', body: 'source' }, picks: [{ match: '目标正文段落二', format: { color: 'FF0000', bold: true, sizePt: 14 } }] })
    ok(r.applied.length === 3 && r.missedPicks.length === 0, `套用真跑：${r.applied.length} 段命中（map 2 + picks 1），missed ${r.missedPicks.length}`)
    const bText = await office.readDocxText(bPath)
    ok(bText.includes('目标正文段落一。') && bText.includes('目标正文段落二。') && bText.includes('目标文档'), '套用后内容一字不动')
    const parsedB = await office.parseWordFormat(bPath)
    const bh1 = parsedB.paragraphs.find((p) => p.role === 'h1' && p.text)
    const bbody = parsedB.paragraphs.find((p) => p.text.includes('目标正文段落一'))
    const bpick = parsedB.paragraphs.find((p) => p.text.includes('目标正文段落二'))
    ok(bh1 && bh1.run.sizePt === 16 && bh1.run.color === '2E5E8C' && bh1.run.bold === true && (bh1.run.eastAsiaFont === '微软雅黑' || bh1.run.font === '微软雅黑'), `B 标题吃到 A 的 source 格式（${bh1 ? (bh1.run.eastAsiaFont || bh1.run.font) + ' ' + bh1.run.sizePt + 'pt' : '未命中'}，宋体→微软雅黑）`)
    ok(bbody && (bbody.run.eastAsiaFont === '等线' || bbody.run.font === '等线') && bbody.para.lineRatio && Math.abs(bbody.para.lineRatio - 1.42) < 0.05, `B 正文吃到 A 行距+字体（${bbody ? (bbody.run.eastAsiaFont || bbody.run.font) + ' 行距' + bbody.para.lineRatio : '未命中'}，宋体→等线）`)
    ok(bpick && bpick.run.color === 'FF0000' && bpick.run.sizePt === 14 && bpick.run.bold === true, 'picks 精准套用（#FF0000/14pt/加粗）')
    // ⑤ pPr 子元素 schema 顺序（ECMA-376：pStyle<spacing<ind<jc<outlineLvl<rPr，违规 Word 报损坏）
    const JSZip = require('jszip')
    const zB = await JSZip.loadAsync(fs.readFileSync(bPath))
    const xmlB = await zB.file('word/document.xml').async('string')
    const at = xmlB.indexOf('第一节')
    const sStart = Math.max(xmlB.lastIndexOf('<w:p>', at), xmlB.lastIndexOf('<w:p ', at))
    const blockB = xmlB.slice(sStart, xmlB.indexOf('</w:p>', at) + 6)
    const pPrB = blockB.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)[0]
    const orderTags = ['w:pStyle', 'w:spacing', 'w:ind', 'w:jc', 'w:outlineLvl', 'w:rPr'].filter((t) => pPrB.includes('<' + t))
    const orderPos = orderTags.map((t) => pPrB.indexOf('<' + t))
    ok(orderTags.length >= 3 && orderPos.every((v, i) => i === 0 || v > orderPos[i - 1]), `pPr 子元素顺序合规（${orderTags.join(' < ')}）`)
    // ⑥ 工具层真跑（经 createTools.execute，桩远程依赖）
    const toolsMod = require(path.join(ROOT, 'ai/tools.js'))
    const t = toolsMod.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'smoke95' }), snapshotDir: () => dir, register: () => {} },
      desktopDir: dir, tmpDir: dir, workspaceDir: dir,
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const rf = await t.execute('read_word_format', { path: aPath })
    ok(rf.ok && rf.message.includes('一级标题') && rf.message.includes('正文'), '工具真跑 read_word_format 指纹模式（可读摘要直出）')
    const rfFull = await t.execute('read_word_format', { path: aPath, mode: 'full' })
    ok(rfFull.ok && rfFull.message.includes('【全量格式清单】') && rfFull.message.includes('#2') && rfFull.message.includes('[h1]'), '工具真跑 read_word_format full 模式（逐段清单+角色标注）')
    const rApply = await t.execute('apply_word_format', { path: bPath, formatPath: aPath, rules: { picks: [{ match: '目标正文段落一', format: { sizePt: 18, color: '00B050' } }] } })
    ok(rApply.ok && rApply.message.includes('已套用 1 段') && rApply.message.includes('快照 smoke95'), `工具真跑 apply_word_format picks（${rApply.ok ? rApply.message.split('：')[0] : rApply.message}）`)
    const rMiss = await t.execute('apply_word_format', { path: bPath, formatPath: aPath, rules: { picks: [{ match: '不存在的文字XYZ', format: { sizePt: 9 } }] } })
    ok(!rMiss.ok && rMiss.message.includes('没有段落被套用') && rMiss.message.includes('不存在的文字XYZ'), 'picks 全未命中时报错引导（带 miss 明细 + 下一步提示）')
    const rNoRules = await t.execute('apply_word_format', { path: bPath })
    ok(!rNoRules.ok && rNoRules.message.includes('缺少 rules'), '缺 rules 报错引导（带两种形态示例）')
  }

  // ===== v2.4.96：screenshot 截图工具（webview/app/screen 三级，只截不看，AI 自主决定何时 view_image）=====
  {
    console.log('— v2.4.96 screenshot 截图工具 —')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    // ① 引擎落盘断言
    ok(toolsJs.includes('function captureWebviewShot') && toolsJs.includes("getWebContentsId()"), 'webview 截图：主窗口 executeJavaScript 找可见 webview → getWebContentsId（guest 内容级截图，后台标签也能截）')
    ok(toolsJs.includes('function captureAppShot') && toolsJs.includes('win.isMinimized()'), 'app 截图：主窗口 capturePage + 最小化检测（最小化截不到明确报错引导）')
    ok(toolsJs.includes('function captureScreenShot') && toolsJs.includes("types: ['screen']") && toolsJs.includes('getPrimaryDisplay'), 'screen 截图：desktopCapturer 抓一帧静态画面 + 主屏优先（用户无感知不干扰操作）')
    ok(toolsJs.includes('img.isEmpty()'), '空帧防御：capturePage 后 isEmpty 检查（未渲染完成/被隐藏给明确报错）')
    ok(toolsJs.includes('function shotElectron') && toolsJs.includes('typeof m === \'object\' && m.webContents && m.desktopCapturer'), '纯 Node 环境防御：require("electron") 拿到路径字符串时判非 API（返回 null 走降级报错）')
    ok(toolsJs.includes("name: 'screenshot'") && readManual('图片视频.md').includes('只截图不分析') && readManual('图片视频.md').includes('调 view_image 传这个 path'), '工具注册 + desc 明确"只截不看"（AI 自主决定何时 view_image）→ 手册 图片视频.md')
    ok(toolsJs.includes("case 'screenshot': return"), 'case 过程描述（截图 scope）')
    // ② 真跑：纯 Node 冒烟环境降级报错（真跑实锤工具链路通）
    const toolsMod = require(path.join(ROOT, 'ai/tools.js'))
    const t2 = toolsMod.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'smoke96' }), snapshotDir: () => '.', register: () => {} },
      desktopDir: '.', tmpDir: '.', workspaceDir: '.',
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const rDefault = await t2.execute('screenshot', {})
    ok(!rDefault.ok && rDefault.message.includes('应用内环境'), '真跑 screenshot 默认 scope：纯 Node 环境正确降级报错（链路通，非崩溃）')
    const rScreen = await t2.execute('screenshot', { scope: 'screen' })
    ok(!rScreen.ok && rScreen.message.includes('应用内环境'), '真跑 screenshot scope=screen：同样正确降级')
    const rWeird = await t2.execute('screenshot', { scope: '不存在的scope' })
    ok(!rWeird.ok && rWeird.message.includes('应用内环境'), 'scope 非法值容错：回落默认 webview 分支（环境错误先行）')
  }

  // ===== v2.4.97：update_notes 大记事本工具 + 智能检索 + 检查更新 + TTS + 定时任务 =====
  {
    console.log('— v2.4.97 大记事本/检查更新/TTS/定时任务 —')
    // ① update_notes 工具真跑（append 去重 / read / replace / 落盘验证）——独立实例+临时工作区
    const toolsMod97 = require(path.join(ROOT, 'ai/tools.js'))
    const ws97 = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-ws97-'))
    const t97 = toolsMod97.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'smoke97' }), snapshotDir: () => ws97, register: () => {} },
      desktopDir: ws97, tmpDir: ws97, workspaceDir: ws97,
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const notesFile = path.join(ws97, 'NOTES.md')
    try { fs.unlinkSync(notesFile) } catch {}
    const rApp1 = await t97.execute('update_notes', { mode: 'append', content: '老大喜欢紫色主题' })
    ok(rApp1.ok && rApp1.message.includes('已记入大记事本'), 'update_notes append：写入成功')
    ok(fs.existsSync(notesFile) && fs.readFileSync(notesFile, 'utf8').includes('老大喜欢紫色主题'), 'NOTES.md 落盘验证（workspace 目录）')
    const rApp2 = await t97.execute('update_notes', { mode: 'append', content: '老大喜欢紫色主题' })
    ok(rApp2.ok && rApp2.message.includes('已经有了'), 'update_notes append 去重：同内容跳过不重复记')
    const rRead = await t97.execute('update_notes', { mode: 'read' })
    ok(rRead.ok && rRead.message.includes('老大喜欢紫色主题'), 'update_notes read：读回已记内容')
    const rRep = await t97.execute('update_notes', { mode: 'replace', content: '# 重新开始\n- 2026-09-06 新的一页' })
    ok(rRep.ok && fs.readFileSync(notesFile, 'utf8').includes('新的一页') && !fs.readFileSync(notesFile, 'utf8').includes('紫色主题'), 'update_notes replace：整本重写生效')
    const rNoC = await t97.execute('update_notes', { mode: 'append' })
    ok(!rNoC.ok && rNoC.message.includes('缺少 content'), '缺 content 报错引导（带示例）')
    // ② extractRelevantNotes 智能检索真跑（WorkAgent 原型方法，无 this 依赖）
    const { WorkAgent } = require(path.join(ROOT, 'ai/agent.js'))
    ok(typeof WorkAgent.prototype.extractRelevantNotes === 'function', 'extractRelevantNotes 在 WorkAgent 原型（API/网页两模式共用）')
    const longNotes = Array.from({ length: 30 }, (_, i) => `## 区块${i}（主题${i}）\n- 这里是主题${i}的详细记录内容，用于验证相关性召回算法是否按块命中`).join('\n')
    const pick = WorkAgent.prototype.extractRelevantNotes.call({}, longNotes, '主题7 相关的问题', 800)
    ok(pick.includes('区块7') && !pick.includes('区块29'), '智能检索：命中相关块（区块7），无关块（区块29）被过滤')
    const pickNone = WorkAgent.prototype.extractRelevantNotes.call({}, longNotes, '完全无关查询词xyzq', 800)
    ok(pickNone.includes('更早的记录已截断'), '零命中回退：保底显示尾部（旧语义兼容）')
    const shortPick = WorkAgent.prototype.extractRelevantNotes.call({}, '短文本', '随便', 2500)
    ok(shortPick === '短文本', '短全文直出：≤2500 字不检索直接全文')
    // ③ main.js：检查更新 / TTS / 定时任务（源码断言）
    const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    ok(mainJs.includes("ipcMain.handle('app:check-update'") && mainJs.includes('repos/${repo}/releases/latest') && mainJs.includes('browser_download_url'), '检查更新 IPC：GitHub Releases latest API + exe 下载直链')
    ok(mainJs.includes('getSetting(\'updateRepo\')') && mainJs.includes('NO_REPO'), '更新源可配置（设置填 repo，空则引导）')
    ok(mainJs.includes("ipcMain.handle('ai:tts'") && mainJs.includes('/audio/speech') && mainJs.includes("response_format: 'mp3'"), 'TTS IPC：CosyVoice2 /audio/speech POST → mp3 base64')
    ok(mainJs.includes('resolveModelProvider(getSetting, \'tts\')'), 'TTS 运营商槽位解析（aiTtsProvider 独立配置）')
    ok(mainJs.includes('async function runSchedules') && mainJs.includes('schedLastRun.set(t.id, today)') && mainJs.includes('setInterval(() => { try { runSchedules(false) } catch {} }, 30000)'), '定时任务调度：30s 扫描 + 按天防重（lastRun map）')
    ok(mainJs.includes('runSchedules(true)') && mainJs.includes('错过补跑'), '错过补跑：启动 60s 后补今天已到时未跑的（消息注明）')
    ok(mainJs.includes("type: 'schedule_fired'"), '派发通知前端：schedule_fired 事件（toast 提示自动开工）')
    // ④ 前端三件套（index.html + app.js + preload）
    const idxHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
    ok(idxHtml.includes('aiTtsModelInput') && idxHtml.includes('aiTtsVoiceSelect') && idxHtml.includes('aiTtsTestBtn'), '设置 UI：语音合成第七栏（模型+音色下拉+试听按钮）')
    ok(idxHtml.includes('aiScheduleTime') && idxHtml.includes('aiScheduleTask') && idxHtml.includes('aiScheduleList'), '设置 UI：定时任务栏（时间/描述/会话/列表）')
    ok(idxHtml.includes('checkUpdateBtn') && idxHtml.includes('updateResultText'), '检查更新 UI（v2.4.99 起在全局设置-关于，更新源内置不填）')
    const appJs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
    ok(appJs.includes("['Tts', 'aiTtsProviderSelect']"), 'PROVIDER_SLOTS 加 Tts 槽位（运营商库联动）')
    ok(appJs.includes('async function ttsTestPlay') && appJs.includes('data:audio/mp3;base64,'), '试听逻辑：ttsSpeak → Audio 播放')
    ok(appJs.includes('async function addSchedule') && appJs.includes("setSetting('aiSchedules'"), '定时任务 UI 逻辑：添加/暂停/删除 → aiSchedules 设置')
    ok(appJs.includes("ev.type === 'schedule_fired'"), '前端 schedule_fired → toast（定时任务开工提示）')
    const preJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
    ok(preJs.includes('checkUpdate: () => ipcRenderer.invoke(\'app:check-update\')') && preJs.includes('ttsSpeak:'), 'preload 桥：checkUpdate + ttsSpeak')
    // ⑤ 工具表注册 + prompt 注入 + 记忆分工
    const toolsJs2 = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    ok(toolsJs2.includes("name: 'update_notes'") && toolsJs2.includes('工作台 NOTES.md，全局长期记忆'), 'update_notes 工具表注册（desc 说明记什么/不记什么）')
    ok(toolsJs2.includes("case 'update_notes': return"), 'case 过程描述（记/读/重写大记事本）')
    const promptJs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
    ok(promptJs.includes('if (ctx.bigNotes) parts.push'), 'system prompt 注入大记事本区块（API 模式此前不带）')
    ok(promptJs.includes('记忆分两层'), 'MEMORY_RULES 记忆分工说明（remember 内部库 vs update_notes 大记事本）')
  }

  // ===== v2.7.0：默认人设 v0.4（莫西/雷娜塔）内置 =====
  {
    console.log('— v2.7.0 默认人设 v0.4 内置 —')
    const promptJs270 = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
    ok(promptJs270.includes('PERSONA_DEFAULT'), 'prompt.js：PERSONA_DEFAULT 人设常量存在')
    ok(promptJs270.includes('默认人设 v0.4') && promptJs270.includes('雷娜塔（Renata）') && promptJs270.includes('莫西（Mosi）') && promptJs270.includes('性别：女'), '人设内容：v0.4 标识 + 双名（工作名莫西/真名雷娜塔）+ 性别女')
    ok(promptJs270.includes('parts.push(PERSONA_DEFAULT)'), 'assembleSystemPrompt 主链路注入人设')
    ok(promptJs270.includes("不要与用户寒暄。')\n  } else {\n    parts.push(PERSONA_DEFAULT)"), '子Agent 不注入人设（isChild 分支隔离）')
    ok(promptJs270.includes('用户自定义规则 > 你的表现层'), '人设优先级：用户规则 > 表现层')
  }

  // ===== v2.7.1：人设微调（称呼/声音）+ 工作台 SVG 源码乱码修复 =====
  {
    console.log('— v2.7.1 人设微调 + SVG 乱码修复 —')
    const promptJs271 = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
    ok(promptJs271.includes('默认称呼「你」，关怀句/收尾句用，不每句塞'), '人设：温度行尾补默认称呼用法（不每句塞「你」）')
    ok(promptJs271.includes('声音（说话体）：口语小词自然带（从/个/的），不播报腔'), '人设：新增「声音」小节（口语体不播报腔）')
    const appJs271 = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
    ok(appJs271.includes("$('wbViewIcon').innerHTML = itIcon(item)"), 'SVG 乱码修复：wbViewIcon 改 innerHTML（textContent 会显示 SVG 源码）')
    ok(!/textContent\s*=\s*(iconSvg|getFileIcon|itIcon)\(/.test(appJs271), 'SVG 乱码修复：无 textContent 赋值图标串残留')
    // 2.7.1 补修：iconSvg 串经变量/参数间接落 textContent 的全部点
    const iconVarPts = [
      ["icon.innerHTML = meta.icon // meta.icon 是 SVG 串", 2, '引用 chip 两处（输入框胶囊 + 用户消息胶囊）：icon.innerHTML = meta.icon'],
      ["b.innerHTML = txt", 1, '会话菜单 mkBtn（重命名/置顶/删除按钮）：innerHTML'],
      ["b.innerHTML = label", 2, '文件夹 bulk mkBtn + 富文本 fmtBtn：innerHTML'],
      ["btn.innerHTML = label", 1, '工作台页签右键菜单：innerHTML'],
      ["it.innerHTML = a.label", 1, '资源面板右键菜单 showWbFsMenu：innerHTML']
    ]
    for (const [frag, cnt, msg] of iconVarPts) {
      const n = appJs271.split(frag).length - 1
      ok(n >= cnt, `SVG 乱码补修：${msg}（${frag.slice(0, 30)}… ×${n}）`)
    }
    ok(!/textContent\s*=\s*(meta\.icon|a\.label)\b/.test(appJs271) && !/\.textContent\s*=\s*(txt|label)\b/.test(appJs271), 'SVG 乱码补修：无 textContent = 图标变量残留（防回归正则）')
  }

  // ===== v2.4.98：启动静默检查更新 + 顶部小提示条 =====
  {
    console.log('— v2.4.98 启动检查更新提示条 —')
    // ① UI 三件套：index.html 提示条元素 + main.css 样式
    const idxHtml98 = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
    ok(idxHtml98.includes('id="updateBanner"') && idxHtml98.includes('updateBannerText') && idxHtml98.includes('updateBannerDownload') && idxHtml98.includes('updateBannerClose'), 'index.html：更新提示条（文本+去下载+关闭）')
    const css98 = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')
    ok(css98.includes('.update-banner') && css98.includes('updateBannerIn'), 'main.css：提示条样式 + 滑入动画（fixed 顶部不挡操作）')
    // ② app.js：startupUpdateCheck 静默逻辑 + 关闭防重入 + 延迟启动挂载
    const appJs98 = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
    ok(appJs98.includes('async function startupUpdateCheck'), 'startupUpdateCheck：启动静默检查函数')
    ok(appJs98.includes('if (!r || r.error || !r.hasUpdate || _updateBannerDismissed) return'), '静默语义：无更新/未填仓库/网络失败/已关闭都不打扰')
    ok(appJs98.includes('catch { } // 静默：网络不通/未填仓库都不打扰'), 'checkUpdate 异常静默吞掉（不弹错误）')
    ok(appJs98.includes("_updateBannerDismissed = true // 本次启动不再提示"), '关闭按钮：标记后本次启动不再弹')
    ok(appJs98.includes("setTimeout(() => { try { startupUpdateCheck() } catch { } }, 10000)"), '启动挂载：init 末尾延迟 10 秒（不拖慢启动）')
    ok(appJs98.includes("updateBannerDownload").toString() === 'true' && !appJs98.includes('_updateBannerUrl'), '去下载按钮存在（v2.5.0 起改走应用内下载，外链 open 已删）')
    // ③ package.json 版本跟进（历史断言：不低于 2.4.98 即可，版本一直往前走）
    const pkg98 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const verGe = (v, w) => { const a = String(v).split('.'), b = String(w).split('.'); for (let i = 0; i < 3; i++) { const d = (+a[i] || 0) - (+b[i] || 0); if (d) return d > 0 } return true }
    ok(verGe(pkg98.version, '2.4.98'), `版本号不低于 2.4.98（当前 ${pkg98.version}）`)
  }

  // ===== v2.4.99：检查更新挪到全局设置-关于 + 更新源内置 =====
  {
    console.log('— v2.4.99 更新入口挪关于+内置更新源 —')
    const idxHtml99 = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
    ok(!idxHtml99.includes('updateRepoInput'), 'AI 设置：更新源输入框已移除（用户无需填写）')
    const aboutAt = idxHtml99.lastIndexOf('data-pane="about"') // 内容 pane 在导航按钮之后，取最后一次出现
    const aboutPane = idxHtml99.slice(aboutAt, aboutAt + 1200)
    ok(aboutPane.includes('checkUpdateBtn') && aboutPane.includes('updateResultText'), '全局设置-关于：检查更新按钮 + 结果区就位')
    const mainJs99 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    ok(mainJs99.includes("BUILTIN_UPDATE_REPO = 'Mosina1102/MSMate'"), '更新源内置：BUILTIN_UPDATE_REPO（设置可覆盖换源）')
    ok(mainJs99.includes("replace(/\\.git$/i, '')) || BUILTIN_UPDATE_REPO"), '空设置回落内置源（老用户清掉也不断链）')
    const appJs99 = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
    ok(!appJs99.includes("setSetting('updateRepo'"), 'AI 设置保存不再写 updateRepo（v2.4.98 老残留清理）')
    // 发版脚本（本地 token，不进包不进聊天）
    const relScript = path.join(ROOT, 'tools', 'release.ps1')
    ok(fs.existsSync(relScript) && fs.readFileSync(relScript, 'utf8').includes('release-token.txt'), '发版脚本 tools/release.ps1（打包+建 Release+传 exe 一键流）')
    const pkg99 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const verGe99 = (v, w) => { const a = String(v).split('.'), b = String(w).split('.'); for (let i = 0; i < 3; i++) { const d = (+a[i] || 0) - (+b[i] || 0); if (d) return d > 0 } return true }
    ok(verGe99(pkg99.version, '2.4.99'), `版本号不低于 2.4.99（当前 ${pkg99.version}）`)
  }

  // ===== v2.5.0：应用内下载更新闭环（进度条 → 重启安装 → 退出自动装） =====
  {
    console.log('— v2.5.0 应用内下载更新闭环 —')
    const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    const preJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
    const appJs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
    const idxHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
    const css = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8').replace(/\r\n/g, '\n')
    // 主进程：三件套 IPC + 下载流 + 自动安装
    ok(mainJs.includes("ipcMain.handle('update:download'") && mainJs.includes("ipcMain.handle('update:install'") && mainJs.includes("ipcMain.handle('update:get-state'"), '主进程：update download/install/get-state 三件套 IPC')
    ok(mainJs.includes('hooks.onProgress') === false && mainJs.includes('onProgress: (received, total)'), '主进程：下载进度回调（httpDownload onProgress → 节流推送）')
    ok(mainJs.includes("updateProgressPush") && mainJs.includes("webContents.send('update:dl-progress'"), '主进程：进度节流推送渲染层（≥600ms 间隔）')
    ok(mainJs.includes("finalPath + '.part'") && mainJs.includes("fs.renameSync(partPath, finalPath)"), '主进程：.part 半包保护，下完原子改名')
    ok(mainJs.includes("cmpVersions(v, app.getVersion()) > 0") && mainJs.includes('scanReadyUpdate'), '主进程：启动扫描已下完的包（旧包自动清理）')
    ok(mainJs.includes("spawn(updateState.file, ['/S']") && !mainJs.includes('ping -n 3') && !mainJs.includes("spawn('cmd.exe'"), '主进程：安装器直启 /S 静默安装（v2.5.2 去 cmd/ping/start 黑窗链）')
    ok(/update:install'[\s\S]*?installOnQuit = true/.test(mainJs) && /before-quit'[\s\S]*?readyToInstall[\s\S]*?installOnQuit = true/.test(mainJs), '主进程：install/before-quit 只置标记（v2.5.2 防文件锁竞争）')
    ok(/will-quit'[\s\S]*?installOnQuit[\s\S]*?spawnInstaller\(\)/.test(mainJs), '主进程：will-quit 统一启动安装器（主进程退干净才轮到安装器写文件）')
    ok(fs.existsSync(path.join(ROOT, 'assets/installer.nsh')) && (() => { const t = fs.readFileSync(path.join(ROOT, 'assets/installer.nsh'), 'utf8'); return t.includes('customInit') && t.includes('taskkill /f /im "${APP_EXECUTABLE_FILENAME}"') && !t.includes('"${APP_EXECUTABLE_FILENAME}" /t') })(), '安装器：installer.nsh 等旧进程退出 + 超时强杀兜底（v2.5.63 无 /t——/t 会连坐杀掉作为进度窗子进程的安装器自己）')
    ok(!mainJs.includes("spawn(process.execPath, ['--update-progress'") && !mainJs.includes('runUpdateProgressMode()'), '主进程：进度窗模式已下线（v2.5.6 直接静默安装+主窗口遮罩，锁旧 exe 的常驻进程不存在）')
    ok(mainJs.includes('function saveUpdateNotes') && mainJs.includes("setSetting('updateNotes'"), '主进程：Release 说明落盘（装完首次启动弹窗用）')
    ok(appJs.includes('showUpdateWelcome') && appJs.includes('updateNotesShown'), '前端：更新完成欢迎弹窗（只弹一次）')
    ok(appJs.includes('兼容模式 · 高保真渲染失败'), '前端：高保真失败原因亮在界面（不再静默回退）')
    ok(mainJs.includes("if (as == null) { applyAutoStart(true); setSetting('autoStart', true) }"), '主进程：默认开机自启（未设置过的用户默认开启）')
    ok(mainJs.includes('gotSize !== rel.assetSize'), '主进程：下载完整性校验（大小不符的半包直接作废）')
    ok(mainJs.indexOf('const updateState') >= 0 && mainJs.indexOf('const updateState') < mainJs.indexOf('function registerAIIPC'), '主进程：更新状态机在模块顶层（before-quit 可读，块内定义摸不到）')
    ok(mainJs.includes("require('child_process')"), '主进程：child_process.spawn（安装器启动）')
    // preload 桥
    ok(preJs.includes('updateDownload:') && preJs.includes('updateInstall:') && preJs.includes('updateGetState:') && preJs.includes('onUpdateDlProgress:'), 'preload：四个更新桥全部暴露')
    // 前端：banner 三态 + 进度条 + 事件流
    ok(idxHtml.includes('updateBannerBar') && idxHtml.includes('updateBannerFill') && idxHtml.includes('updateBannerInstall'), 'UI：banner 进度条元素 + 立即重启按钮')
    ok(css.includes('.update-banner-bar') && css.includes('.update-banner-fill'), 'CSS：进度条样式（主题变量，亮暗通吃）')
    ok(appJs.includes("function setUpdateBannerMode") && appJs.includes("'offer'") && appJs.includes("'progress'") && appJs.includes("'ready'"), '前端：banner 三态状态机（offer/progress/ready）')
    ok(appJs.includes('async function startInAppUpdate') && appJs.includes('async function installUpdateNow'), '前端：应用内下载 + 立即重启安装')
    ok(appJs.includes('_api.onUpdateDlProgress((d)'), '前端：进度事件流订阅（error/ready/downloading 三分支）')
    ok(appJs.includes('await _api.updateGetState()'), '前端：启动恢复本地状态（上次下完没装 → 直接提示重启更新）')
    ok(!appJs.includes('_updateBannerUrl'), '前端：外链打开逻辑已删干净（v2.4.98 的 openExternal 兜底不再需要）')
    ok(!appJs.includes("ob.onclick = () => window.api.openExternal ? window.api.openExternal(r.url)"), '前端：手动检查的“去下载”也走应用内下载')
    // v2.5.2：检测到新版自动下载（启动静默检查 + 设置手动检查都直接开下），无需用户同意
    ok(/startupUpdateCheck[\s\S]*?r\.hasUpdate[\s\S]*?startInAppUpdate\(\)/.test(appJs), '前端：启动检查发现新版 → 自动开始下载（v2.5.2）')
    ok(/checkAppUpdate[\s\S]*?已自动开始下载[\s\S]*?startInAppUpdate\(\)/.test(appJs), '前端：手动检查发现新版 → 自动开始下载（v2.5.2）')
    ok(appJs.includes('if (_updateBannerDismissed) return // v2.5.2'), '前端：用户关掉横幅后进度事件不再骚扰（下载照常后台走）')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const verGte = (a, b) => { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) } return true }
    ok(verGte(pkg.version, '2.5.6'), `版本号不低于 2.5.6（当前 ${pkg.version}，动态比较不再写死）`)
  }

  // ===== v2.5.5：论文套学校格式模板（applyWordTemplate 嫁接引擎 + apply_word_template 工具）=====
  {
    console.log('— v2.5.5 论文套学校格式模板 —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    // ① 引擎落盘断言（此前上下文丢失轮曾虚报，落盘断言防幻觉）
    ok(officeJs.includes("tplDoc.slice(tplDoc.lastIndexOf('</w:body>'))"), 'bodyTail 截取含 </w:body> 闭合标签（此前丢闭合）')
    ok(officeJs.includes('parts.push(lastSec.sectPr)'), '末节 sectPr 以 body 级收口（跳过节页设置不丢，中间节包段落）')
    ok(officeJs.includes("fillcolor=\"#[0-9A-Fa-f]{6}\"") && officeJs.includes('/<w:drawing|<w:object/.test(rInner)'), 'run 清洗覆盖 VML 图形（w:br 控制符 run + fillcolor 网页色→auto，真图片不动）')
    ok(officeJs.includes('hasEnAbstract') && officeJs.includes("t.replace(/^Abstract\\s*[:：]?\\s*/i, '')"), '英文摘要提取（合并段 Abstract: 内容不丢，仅扫正文前置区）')
    ok(officeJs.includes('<w:tcBorders><w:bottom w:val="single" w:color="auto" w:sz="6" w:space="0"/></w:tcBorders>'), '三线表首行栏目线 0.75 磅（tcBorders 按 schema 顺序注入）')
    ok(officeJs.includes(".replace(/<w:shd[^>]*\\/>/g, '')"), '单元格黑底填充(shd)/段落底纹全清')
    ok(toolsJs.includes("name: 'apply_word_template'") && toolsJs.includes("case 'apply_word_template':"), '工具注册：apply_word_template + 动词映射')
    ok(toolsJs.includes('apply_word_template 暂只支持本机文件'), '远程 target 明确拒绝并引导先拉回本机')
    // ② 真跑：模板骨架 + 带表格论文
    const os = require('os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke255-'))
    const tplPath = path.join(dir, '模板.docx')
    const paperPath = path.join(dir, '论文.docx')
    const outPath = path.join(dir, '成品.docx')
    const office = require(path.join(ROOT, 'ai/office.js'))
    await office.createDocx(tplPath, { title: '毕业论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '模板正文样本。', style: 'normal' }], fonts: { heading: '黑体', body: '宋体' } })
    await office.createDocx(paperPath, { title: '测试论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '论文正文段落一。', style: 'normal' }, { style: 'table', rows: [['特征', '表现'], ['数据', '要素']] }], fonts: { heading: '微软雅黑', body: '微软雅黑' } })
    const r = await office.applyWordTemplate(paperPath, tplPath, { outputPath: outPath, cover: { name: '测试员' } })
    ok(fs.existsSync(outPath) && r.size > 0, `嫁接真跑：输出落盘（${r.size} 字节）`)
    ok(r.paper.bodyBlocks > 0, `论文正文迁入（${r.paper.bodyBlocks} 块）`)
    const JSZip = require('jszip')
    const z = await JSZip.loadAsync(fs.readFileSync(outPath))
    const xml = await z.file('word/document.xml').async('string')
    ok(/<\/w:body>\s*<\/w:document>\s*$/.test(xml.trim()), '输出 document.xml 闭合完整（</w:body> 在）')
    ok(/(:?<\/w:p>|<w:p\/>)<w:sectPr[\s\S]*<\/w:sectPr><\/w:body>\s*<\/w:document>\s*$/.test(xml.trim()), 'body 级 sectPr 收尾（裸 sectPr 落尾；表格收尾时空段 <w:p/> 兜底合规）')
    ok(/<w:tblBorders><w:top w:val="single" w:color="auto" w:sz="12"/.test(xml), '论文表格三线化（顶/底线 1.5 磅）')
    ok(xml.includes('论文正文段落一。'), '论文内容迁入')
    ok(xml.includes('特征') && xml.includes('要素'), '论文表格单元格文字迁入（对象式 {style:table} 不再被 normParagraphs 吞）')
    ok(!xml.includes('微软雅黑'), '论文原字体清干净（模板字体接管）')
    // ③ 工具层真跑（经 createTools.execute，桩远程依赖）
    const toolsMod = require(path.join(ROOT, 'ai/tools.js'))
    const t = toolsMod.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'smoke255' }), snapshotDir: () => dir, register: () => {} },
      desktopDir: dir, tmpDir: dir, workspaceDir: dir,
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const rt = await t.execute('apply_word_template', { path: paperPath, templatePath: tplPath, cover: { name: '测试员' } })
    ok(rt.ok && rt.message.includes('已按模板重排') && rt.message.includes('更新域'), `工具真跑 apply_word_template（${rt.ok ? rt.message.split('。')[0] : rt.message}）`)
    const rtNoTpl = await t.execute('apply_word_template', { path: paperPath })
    ok(!rtNoTpl.ok && rtNoTpl.message.includes('缺少 templatePath'), '缺 templatePath 报错引导（别拿论文自己当模板）')
  }

  // ===== v2.5.6：更新失败修复三件套 + Word 批注 =====
  {
    console.log('— v2.5.6 更新三件套 + Word 批注 —')
    const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    const nsh = fs.readFileSync(path.join(ROOT, 'assets/installer.nsh'), 'utf8')
    const preloadJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
    const appJs = ['src/js/app.js', 'src/js/word-embed.js', 'src/js/word-rich.js', 'src/js/work.js'].map(p => fs.readFileSync(path.join(ROOT, p), 'utf8')).join('\n')
    // ① 进度窗进程下线（它从旧 exe 运行且全程存活，锁死安装目录导致升级卸旧必炸）
    ok(!mainJs.includes("'--update-progress'") && !mainJs.includes('runUpdateProgressMode()'), '进度窗进程模式整体下线（不再有锁旧 exe 的常驻进程）')
    // ② 同卷 TEMP（跨盘 Rename 必炸根因：$PLUGINSDIR 在 %TEMP%=C 盘，F 盘安装时卸载器原子改名跨卷失败）
    ok(mainJs.includes("path.join(path.dirname(process.execPath), '..', 'msmate-update-temp')") && mainJs.includes('TEMP: tmp, TMP: tmp'), '安装器注入同卷 TEMP/TMP（跨盘升级根治）')
    ok(mainJs.includes("fs.rmSync(legacyTmp, { recursive: true, force: true, maxRetries: 2 })"), '启动时清理 msmate-update-temp 残留')
    // ③ 卸载失败放行兜底（electron-builder handleUninstallResult 被 customUnInstallCheck 接管 → 不弹框不中止）
    ok(nsh.includes('!macro customUnInstallCheck') && nsh.includes('!macro customUnInstallCheckCurrentUser'), 'installer.nsh 卸载结果检查被兜底宏接管（卸载失败继续覆盖安装）')
    ok(nsh.includes('taskkill /f /im "${APP_EXECUTABLE_FILENAME}"') && !nsh.includes('APP_EXECUTABLE_FILENAME}" /t'), 'customInit 强杀无 /t（v2.5.63 连坐修复——/t 会杀掉作为进度窗子进程的安装器自己）')
    // ④ 前端遮罩（替代进度窗的"正在安装"感知）
    ok(appJs.includes("ov.id = 'msm-install-overlay'") && appJs.includes('setTimeout(r, 1200)'), 'installUpdateNow 先显遮罩 1.2 秒再退出（VS Code 式体验）')
    // ⑤ Word 批注：引擎落盘断言
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    ok(officeJs.includes('async function parseWordComments') && officeJs.includes('<w:commentRangeStart'), '批注解析引擎落盘（comments.xml + document.xml 锚定）')
    ok(preloadJs.includes('renderComments: true'), '内置 Word 浏览器开启批注气泡渲染')
    // ⑥ 批注真跑：构造带批注 docx → 引擎 + 工具链全通
    const os = require('os')
    const JSZip = require('jszip')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke256-'))
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const docx = path.join(dir, '带批注.docx')
    const z = new JSZip()
    z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
    z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p><w:r><w:t>这段说法不够严谨</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>路径单一</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p></w:body></w:document>`)
    z.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="0" w:author="王导师" w:date="2026-09-06T10:00:00Z"><w:p><w:r><w:t>补充案例</w:t></w:r></w:p></w:comment></w:comments>`)
    fs.writeFileSync(docx, await z.generateAsync({ type: 'nodebuffer' }))
    const office = require(path.join(ROOT, 'ai/office.js'))
    const cmts = await office.parseWordComments(docx)
    ok(cmts.length === 1 && cmts[0].author === '王导师' && cmts[0].text === '补充案例', '批注解析真跑（作者/内容）')
    ok(cmts[0].anchor === '路径单一', '批注锚定文本真跑（range 内文字）')
    const toolsMod = require(path.join(ROOT, 'ai/tools.js'))
    const t = toolsMod.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'x' }), snapshotDir: () => dir, register: () => {} },
      desktopDir: dir, tmpDir: dir, workspaceDir: dir,
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const rc = await t.execute('read_word', { path: docx })
    ok(rc.ok && rc.message.includes('文档批注（1 条') && rc.message.includes('→ 补充案例'), 'read_word 自动带出批注区（作者+锚定+内容）')
  }

  // ===== v2.5.61：正式包 linkedom require(ESM) 崩溃修复 =====
  {
    console.log('— v2.5.61 css-select ESM 雷修复 —')
    // 根因：css-select 7.0.0 是 ESM-only（无 .cjs、exports 无 require 条件），linkedom 的 cjs 构建
    // require 它在 Electron 22（Node 16 不支持 require(ESM)）必炸；开发机 Node 24 容忍 → 冒烟假阳性
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok(pkg.overrides && pkg.overrides['css-select'] === '5.2.2', 'package.json overrides 锁 css-select=5.2.2（纯 CJS，防 npm install 漂移回 7.x）')
    // 实际落位断言（overrides 后 css-select 被 dedupe 进 linkedom/node_modules）
    const cands = [path.join(ROOT, 'node_modules', 'css-select'), path.join(ROOT, 'node_modules', 'linkedom', 'node_modules', 'css-select')]
    const hit = cands.find((d) => fs.existsSync(path.join(d, 'package.json')))
    ok(!!hit, `css-select 实际落位（${hit ? hit.replace(ROOT, '') : '两处都不存在'}）`)
    if (hit) {
      const cp = JSON.parse(fs.readFileSync(path.join(hit, 'package.json'), 'utf8'))
      ok(cp.version === '5.2.2' && cp.main === 'lib/index.js' && !cp.type, `css-select 版本=5.2.2 纯 CJS（实际 v${cp.version} type=${cp.type || '-'}` + ` main=${cp.main}）`)
      ok(fs.existsSync(path.join(hit, 'lib', 'index.js')), 'css-select CJS 入口 lib/index.js 存在（Electron 16 require 兼容）')
    }
    // 金标准：Electron 22（与正式包同版本）真跑 linkedom 全链路探针——开发机 Node 24 会掩盖此类雷
    const { execSync } = require('child_process')
    try {
      const out = execSync(`"${path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')}" "${path.join(ROOT, 'test', 'electron-probe')}"`, { stdio: 'pipe', timeout: 60000 }).toString()
      ok(out.includes('ELECTRON_PROBE_OK'), `Electron 22 探针真跑 linkedom（${out.trim().split('\n').find((l) => l.includes('PROBE')) || out.trim()}）`)
    } catch (e) {
      ok(false, `Electron 22 探针真跑 linkedom（失败: ${(e.stdout || '').toString().includes('PROBE_FAIL') ? '链路报错' : e.message}）`)
    }
  }

  // ===== v2.5.62：论文格式模板蒸馏（read_paper_spec）=====
  {
    console.log('— v2.5.62 论文格式规范书蒸馏 —')
    const office = require(path.join(ROOT, 'ai/office.js'))
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    ok(officeJs.includes('function parseFormatRuleText') && officeJs.includes('function extractPaperFormatSpec'), '蒸馏引擎落盘（批注规则解析 + 规范书聚合）')
    ok(toolsJs.includes("name: 'read_paper_spec'") && toolsJs.includes('async read_paper_spec'), '工具注册：read_paper_spec')
    // 规则文本解析真跑（中文号数含"小二"这种键不带号的）
    const r1 = office.parseFormatRuleText('小二号，黑体，固定值20磅，居中')
    ok(r1 && r1.fmt.sizePt === 18 && r1.fmt.eastAsiaFont === '黑体' && r1.fmt.linePt === 20 && r1.fmt.align === 'center', '批注"小二号，黑体，固定值20磅，居中"→ sizePt18/黑体/固定20磅/居中')
    const r2 = office.parseFormatRuleText('四号，Times New Roman，1.5倍行距，居中，下同（所有数字及字母的字体均为Times New Roman）')
    ok(r2 && r2.fmt.sizePt === 14 && r2.fmt.font === 'Times New Roman' && r2.fmt.lineRatio === 1.5, '批注"四号，Times New Roman，1.5倍行距"→ sizePt14/Times/1.5倍')
    const r3 = office.parseFormatRuleText('此处签名要求手签，不得打印。')
    ok(r3 && r3.flags.includes('handwritten') && !r3.fmt, '批注"手签"→ handwritten 标记（不结构化）')
    // 端到端：合成带批注+红字+图片的模板 → read_paper_spec 工具
    const os = require('os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke262-'))
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const z = new (require('jszip'))()
    z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
    z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>` +
      `<w:p><w:r><w:color w:val="FF0000"/><w:t>页脚格式规范：页码居中，摘要页用罗马字母编页。</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>论文题目示范</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>摘  要</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>摘 要示范</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` +
      `<w:p><w:r><w:t>第一章 绪论</w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>第一章示范</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
    z.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}>` +
      `<w:comment w:id="0" w:author="教务处" w:date="2026-09-07T10:00:00Z"><w:p><w:r><w:t>小二号，黑体，固定值20磅，居中</w:t></w:r></w:p></w:comment>` +
      `<w:comment w:id="1" w:author="教务处" w:date="2026-09-07T10:01:00Z"><w:p><w:r><w:t>一级标题，三号，黑体，居中</w:t></w:r></w:p></w:comment>` +
      `</w:comments>`)
    z.file('word/media/image1.png', Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'))
    const tplPath = path.join(dir, '格式模板.docx')
    fs.writeFileSync(tplPath, await z.generateAsync({ type: 'nodebuffer' }))
    const assetsDir = path.join(dir, 'assets-out')
    const spec = await office.extractPaperFormatSpec(tplPath, { assetsDir })
    ok(spec.rules.length === 2 && spec.rules[0].fmt && spec.rules[0].fmt.sizePt === 18, '合成模板批注规则解析（2 条，sizePt 18）')
    ok(spec.redNotes.length === 1 && spec.redNotes[0].includes('页脚格式规范'), '红字说明书收录（原文给 AI 理解）')
    ok(spec.roles.abstractHead && spec.roles.abstractHead.sizePt === 18, '批注按锚定归属摘要排头角色')
    ok(fs.existsSync(path.join(assetsDir, 'image1.png')), '图片资产导出（校徽等可沿用）')
    ok(spec.summary.includes('论文格式规范书') && spec.summary.includes('不要出现在产出'), '规范书可读文本带排除警示')
    const toolsMod = require(path.join(ROOT, 'ai/tools.js'))
    const t = toolsMod.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'x' }), snapshotDir: () => dir, register: () => {} },
      desktopDir: dir, tmpDir: dir, workspaceDir: dir,
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const rs = await t.execute('read_paper_spec', { path: tplPath })
    ok(rs.ok && rs.message.includes('论文格式规范书') && rs.message.includes('模板批注规则'), 'read_paper_spec 工具真跑（规范书输出）')
  }

  // ===== v2.5.63：套模板产出净化 + 更新链路连坐修复 =====
  {
    console.log('— v2.5.63 套模板零批注/指纹防污染 + 更新强杀去 /t —')
    const nsh = fs.readFileSync(path.join(ROOT, 'assets/installer.nsh'), 'utf8')
    // ① 更新链路：/t 连坐杀安装器（进度窗是安装器父进程，/t 杀子进程连坐）→ 去掉
    ok(nsh.includes('taskkill /f /im "${APP_EXECUTABLE_FILENAME}"') && !nsh.includes('/t`'), 'installer.nsh 强杀去掉 /t（不再连坐杀安装器自己）')
    // ② 静默装完自动拉起新版（v2.5.6 下线进度窗后的缺口：装完没人拉）
    ok(nsh.includes('!macro customInstall') && nsh.includes('ExecShellAsUser') && nsh.includes('${If} ${Silent}'), 'customInstall 静默装完自动拉起新版（"重启更新"闭环）')
    // ③ 端到端：带批注+红字说明书的模板 → applyWordTemplate → 产出零批注零红字
    const os = require('os')
    const JSZip = require('jszip')
    const office = require(path.join(ROOT, 'ai/office.js'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke263-'))
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const z = new (require('jszip'))()
    z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
    z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    z.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`)
    // 模板：红字说明书 5 段（Arial 红字污染源）+ 批注锚点 + 排头/正文
    let tplBody = ''
    for (let i = 0; i < 5; i++) tplBody += `<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>页脚格式规范第${i}条说明文字内容足够长</w:t></w:r></w:p>`
    tplBody += `<w:p><w:r><w:t>摘  要</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>摘要示范文字</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` +
      `<w:p><w:r><w:t>模板正文示范段落，宋体。</w:t></w:r></w:p>`
    z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${tplBody}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
    z.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="0" w:author="教务处" w:date="2026-09-07T10:00:00Z"><w:p><w:r><w:t>小二号，黑体，固定值20磅，居中</w:t></w:r></w:p></w:comment></w:comments>`)
    const tplPath = path.join(dir, '模板.docx')
    fs.writeFileSync(tplPath, await z.generateAsync({ type: 'nodebuffer' }))
    // 论文：宋体正文（防污染对照——若指纹被红字污染，正文会被排成 Arial/红）
    const paperPath = path.join(dir, '论文.docx')
    await office.createDocx(paperPath, { title: '测试论文', paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '论文正文段落内容。', style: 'normal' }], fonts: { heading: '黑体', body: '宋体' } })
    const outPath = path.join(dir, '论文-套模板格式.docx')
    await office.applyWordTemplate(paperPath, tplPath, { outputPath: outPath })
    const z2 = await JSZip.loadAsync(fs.readFileSync(outPath))
    const outXml = await z2.file('word/document.xml').async('string')
    // 产出零批注
    ok(!/<w:commentRangeStart|<w:commentRangeEnd|<w:commentReference/.test(outXml), '产出 document.xml 零批注标记（RangeStart/End/Reference 全剥）')
    ok(!z2.file('word/comments.xml'), '产出不带 comments.xml 部件')
    const ctOut = await z2.file('[Content_Types].xml').async('string')
    ok(!ctOut.includes('/word/comments'), 'Content_Types 去 comments override')
    const relsOut = await z2.file('word/_rels/document.xml.rels').async('string')
    ok(!relsOut.includes('/comments'), 'rels 去 comments 关系')
    // 产出零红字（红字说明书段被节分类跳过 + 剥红系 color 双保险）
    ok(!/w:val="FF0000"/i.test(outXml), '产出零红字（红系 color 全剥）')
    ok(!outXml.includes('页脚格式规范'), '红字说明书内容不进产出')
    // 指纹防污染：论文正文字体是宋体（若指纹被 5 段 Arial 红字污染，正文会变成 Arial）
    ok(!outXml.includes('Arial'), '正文格式不被红字说明书污染（指纹众数剔红字段后无 Arial）')
    ok(outXml.includes('论文正文段落内容。'), '论文内容正常迁入')
  }

  // ===== v2.5.64：批注规则接进生成器 + 封面下划线 + numPr 转手动编号 =====
  {
    console.log('— v2.5.64 批注规则驱动排版 + 封面下划线 + 序号修复 —')
    const office = require(path.join(ROOT, 'ai/office.js'))
    // ① 规则文本角色词直接定角色（"二级标题，四号，黑体"→ h2——锚定目录条目误判 other 的根治）
    ok(office.anchorSpecRole('1.1研究背景', { paragraphs: [] }, '二级标题，四号，黑体，固定值20磅') === 'h2', 'anchorSpecRole：规则文本"二级标题"→ h2（角色词最可靠）')
    ok(office.anchorSpecRole('1  导  论', { paragraphs: [] }, '一级标题，小三号，黑体，居中') === 'h1', 'anchorSpecRole：规则文本"一级标题"→ h1')
    // ② 悬挂缩进解析（参考文献条目格式）
    const hang = office.parseFormatRuleText('五号，宋体，数字及字母为Times New Roman字体，悬挂缩进2字符')
    ok(hang && hang.fmt.indentHanging === 2 && hang.fmt.sizePt === 10.5, 'parseFormatRuleText：悬挂缩进2字符 → indentHanging=2')
    // ③ 封面字段值写进"值 run"（下划线 u:thick 在值 run rPr 上——此前写进标签 run 导致下划线丢失）
    const fieldPara = '<w:p><w:pPr><w:rPr><w:u w:val="single"/></w:rPr></w:pPr>' +
      '<w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>中文题目：</w:t></w:r>' +
      '<w:r><w:rPr><w:rFonts w:eastAsia="黑体"/><w:sz w:val="32"/><w:u w:val="thick"/></w:rPr><w:t>模板示范题目</w:t></w:r></w:p>'
    const rr = office.replaceCoverFields([{ xml: fieldPara, text: '中文题目：模板示范题目' }], { title: '新论文题目' })
    ok(rr.replaced.includes('title'), '封面字段命中 title')
    const outPara = rr.paras[0].xml
    ok(/<w:t[^>]*>中文题目：<\/w:t>/.test(outPara), '标签 run 文本原样（"中文题目："不被改写）')
    const valRunM = outPara.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<w:u w:val="thick"\/>(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/)
    ok(!!valRunM && valRunM[1] === '新论文题目', '新值写进带下划线的值 run（下划线保留）')
    // ④ numPr 转手动编号（numbering 引用迁移断链 → 序号混乱的根治）
    const nb = office.convertNumPrToText(
      [
        { type: 'p', text: '商业模式理论', xml: '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>商业模式理论：内容一</w:t></w:r></w:p>' },
        { type: 'p', text: '总体分析', xml: '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>总体分析：内容二</w:t></w:r></w:p>' }
      ],
      `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="7"/></w:num></w:numbering>`
    )
    ok(nb[0].xml.includes('1. 商业模式理论：内容一') && !nb[0].xml.includes('<w:numPr>'), 'numPr ①号转"1. "前缀并剥 numPr')
    ok(nb[1].xml.includes('2. 总体分析：内容二'), 'numPr ②号计数递增"2. "')
    // ⑤ 端到端：带"二级标题"批注的模板 → 套用后论文 h2 段落用黑体（批注规则生效）
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke264-'))
    const z4 = new (require('jszip'))()
    const W4 = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    z4.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
    z4.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    z4.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W4}><w:body>` +
      `<w:p><w:r><w:t>摘  要</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>模板正文示范。</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>1.1 研究背景</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>研究背景示范</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` +
      `<w:p><w:r><w:t>模板二级标题下正文。</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
    z4.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W4}><w:comment w:id="0" w:author="教务处" w:date="2026-09-07T10:00:00Z"><w:p><w:r><w:t>二级标题，四号，黑体，固定值20磅</w:t></w:r></w:p></w:comment></w:comments>`)
    const tpl4 = path.join(dir4, '模板.docx')
    fs.writeFileSync(tpl4, await z4.generateAsync({ type: 'nodebuffer' }))
    const paper4 = path.join(dir4, '论文.docx')
    await office.createDocx(paper4, { title: '测试论文', noTitle: true, paragraphs: [{ text: '第一章 绪论', style: 'h1' }, { text: '1.1 研究背景', style: 'h2' }, { text: '论文正文段落。', style: 'normal' }], fonts: { heading: '黑体', body: '宋体' } })
    const out4 = path.join(dir4, '论文-套模板格式.docx')
    await office.applyWordTemplate(paper4, tpl4, { outputPath: out4 })
    const z42 = await (require('jszip')).loadAsync(fs.readFileSync(out4))
    const xml4 = await z42.file('word/document.xml').async('string')
    // 产出 h2 段落应带黑体（批注"二级标题，四号，黑体"生效）
    const h2RunM = xml4.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*?1\.1 研究背景(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/)
    ok(!!h2RunM && h2RunM[0].includes('w:eastAsia="黑体"') && h2RunM[0].includes('w:val="28"'), '产出 h2 段用批注规则黑体四号（sz28 半点）')
    // 正文不居中（sanitizeBody 剥污染 center）
    const bodyRunM = xml4.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*?论文正文段落。(?:(?!<\/w:p>)[\s\S])*?<\/w:p>/)
    ok(!!bodyRunM && !bodyRunM[0].includes('<w:jc w:val="center"/>'), '产出正文段不居中（sanitizeBody 剥批注错判的 center）')
  }

  // ===== v2.5.65：产出体检（自我检查闭环）=====
  {
    console.log('— v2.5.65 产出体检 check_paper_format —')
    const office = require(path.join(ROOT, 'ai/office.js'))
    // 规则文本解析回归：角色词 + 悬挂缩进
    ok(office.anchorSpecRole('1.1研究背景', { paragraphs: [] }, '二级标题，四号，黑体') === 'h2', 'anchorSpecRole 角色词回归（二级标题→h2）')
    // 端到端：模板（批注规则）+ 故意带问题的"产出"（红字+示范占位+引用未上标+序号跳号+正文居中）→ 体检全中
    const os = require('os')
    const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke265-'))
    const W5 = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    const zt = new (require('jszip'))()
    zt.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`)
    zt.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    zt.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W5}><w:body>` +
      `<w:p><w:r><w:t>摘  要</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>1.1 研究背景</w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>研究背景示范</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>` +
      `<w:p><w:r><w:t>模板正文示范段落。</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`)
    zt.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W5}><w:comment w:id="0" w:author="教务处" w:date="2026-09-07T10:00:00Z"><w:p><w:r><w:t>二级标题，四号，黑体，固定值20磅</w:t></w:r></w:p></w:comment></w:comments>`)
    const tpl5 = path.join(dir5, '模板.docx')
    fs.writeFileSync(tpl5, await zt.generateAsync({ type: 'nodebuffer' }))
    // 故意带问题的"产出"：红字段落 + XXX 占位 + 引用[3]未上标 + 序号 1.→2.→4. 跳号 + 正文无缩进
    const badXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W5}><w:body>` +
      `<w:p><w:r><w:t>摘  要</w:t></w:r></w:p>` +
      `<w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>这段说明文字被错误标红。</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>学生姓名 XXX</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>正文里引用了文献[3]但没有上标，这是一段足够长的正文文字用于体检触发。</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>1. 第一条目内容</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>2. 第二条目内容</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>4. 第四条目内容（缺3）</w:t></w:r></w:p>` +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`
    const badPath = path.join(dir5, '产出-有问题.docx')
    const zb = new (require('jszip'))()
    zb.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zb.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    zb.file('word/document.xml', badXml)
    fs.writeFileSync(badPath, await zb.generateAsync({ type: 'nodebuffer' }))
    const chk = await office.checkPaperFormat(badPath, tpl5)
    const items = chk.issues.map((x) => x.item)
    ok(chk.issues.some((x) => x.item === '红字残留' && x.severity === 'high'), '体检命中：红字残留（high）')
    ok(chk.issues.some((x) => x.item === '示范占位符残留'), '体检命中：示范占位符 XXX')
    ok(chk.issues.some((x) => x.item === '正文引用未上标'), '体检命中：引用 [数字] 未上标')
    ok(chk.issues.some((x) => x.item === '序号跳号'), '体检命中：序号 1.→2.→4. 跳号')
    ok(chk.issues.every((x) => x.fix), '每条 issue 带修法提示')
    ok(chk.summary.includes('发现') && chk.issues.length >= 4, `体检 summary 输出（${chk.issues.length} 项）`)
    // 干净对照 → 0 项：完整结构论文（摘要/关键词/章标题/文献条目）套模板后的产出
    const fullPaper = path.join(dir5, '完整论文.docx')
    await office.createDocx(fullPaper, { title: '测试论文', noTitle: true, firstLine: true, paragraphs: [
      { text: '摘 要：这是测试论文的摘要内容，用于体检对照。', style: 'normal', font: '宋体' },
      { text: '关键词：测试；体检', style: 'normal', font: '宋体' },
      { text: '第一章 绪论', style: 'h1' },
      { text: '这是一段足够长的干净正文文字用于体检对照不应触发任何问题，字号字体均按模板规范。', style: 'normal', font: '宋体' },
      { text: '参考文献', style: 'h1' },
      { text: '[1] 王宝义. "新零售"的本质、成因及实践动向[J]. 中国流通经济, 2017.', style: 'normal', font: '宋体' }
    ], fonts: { heading: '黑体', body: '宋体' } })
    const cleanPath = path.join(dir5, '产出-干净.docx')
    await office.applyWordTemplate(fullPaper, tpl5, { outputPath: cleanPath })
    const chk2 = await office.checkPaperFormat(cleanPath, tpl5)
    ok(chk2.issues.length === 0, `干净产出 0 项（实际 ${chk2.issues.length}）`)
    // 工具层
    const toolsMod = require(path.join(ROOT, 'ai/tools.js'))
    const t5 = toolsMod.createTools({
      tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'x' }), snapshotDir: () => dir5, register: () => {} },
      desktopDir: dir5, tmpDir: dir5, workspaceDir: dir5,
      getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
    })
    const rt5 = await t5.execute('check_paper_format', { path: badPath, templatePath: tpl5 })
    ok(rt5.ok && rt5.message.includes('产出体检') && rt5.message.includes('修法'), 'check_paper_format 工具真跑（issue 清单+修法提示）')
  }

  // ===== v2.5.68：PDF 读取 + 表格底纹 WPS 黑底修复 + 预览自适应缩放 =====
  {
    console.log('— v2.5.68 PDF读取 + CLEAR底纹 + 分隔行放宽 —')
    const office = require(path.join(ROOT, 'ai/office.js'))
    const JSZip = require('jszip')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const preloadJs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
    // ① 底纹 WPS 兼容：SOLID 在 WPS 解释成前景色实心（w:color=auto→黑）→ 表头黑底看不清字；CLEAR 三端一致
    ok(officeJs.includes('ShadingType.CLEAR') && !officeJs.includes('ShadingType.SOLID'), '底纹全部 ShadingType.CLEAR（WPS 黑底看不清字根除）')
    ok(preloadJs.includes('const scale = Math.max(0.35, Math.min(1, ((host.clientWidth || 0) - 48) / 830))'), 'docx 预览按容器宽度自适应缩放（未全屏不再溢出）')
    // ② 分隔行放宽：AI 常写 |:-:| 单横线变体，此前被当数据行渲染进表格
    const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke268-'))
    const tblPath = path.join(dir6, '表格.docx')
    await office.createDocx(tblPath, { title: 'T', noTitle: true, paragraphs: ['| 项目 | 数量 |', '| :-: | :-: |', '| 导演 | 1 |'] })
    const zt6 = await JSZip.loadAsync(fs.readFileSync(tblPath))
    const xt6 = await zt6.file('word/document.xml').async('string')
    ok(!xt6.includes(':-:'), 'markdown 分隔行 |:-:| 不再被当数据行渲染进表格')
    ok(xt6.includes('导演'), '表格数据行正常')
    // ③ read_pdf 真跑（pdf-parse 自带样本 PDF）
    const samplePdf = path.join(ROOT, 'node_modules', 'pdf-parse', 'test', 'data', '05-versions-space.pdf')
    ok(fs.existsSync(samplePdf), 'pdf-parse 自带测试样本存在')
    if (fs.existsSync(samplePdf)) {
      const pdfText = await office.readPdfText(samplePdf)
      ok(typeof pdfText === 'string' && pdfText.length > 0, `readPdfText 真跑提取 ${pdfText.length} 字`)
      const toolsMod2 = require(path.join(ROOT, 'ai/tools.js'))
      const t6 = toolsMod2.createTools({
        tcpAgent: {}, snapshots: { backupLocal: () => ({ ok: true, id: 'x' }), snapshotDir: () => dir6, register: () => {} },
        desktopDir: dir6, tmpDir: dir6, workspaceDir: dir6,
        getSetting: () => null, setSetting: () => {}, log: () => {}, onDownloadProgress: () => {}, onWorkbenchOpen: () => {}
      })
      const rp = await t6.execute('read_pdf', { path: samplePdf })
      ok(rp.ok && rp.message.length > 0, 'read_pdf 工具真跑')
      // ⑦ pdf_to_image 真跑（WinRT 渲染 PNG）
      const rp2 = await t6.execute('pdf_to_image', { path: samplePdf, pages: 2 })
      ok(rp2.ok && rp2.files && rp2.files.length >= 1 && fs.existsSync(rp2.files[0]), `pdf_to_image 工具真跑（${rp2.ok ? rp2.files.length + ' 页' : rp2.message}）`)
      ok(rp2.ok && fs.statSync(rp2.files[0]).size > 1000, `渲染 PNG 有效（${rp2.ok ? Math.round(fs.statSync(rp2.files[0]).size / 1024) + 'KB' : '-'}）`)
    }
  }

  // ===== v2.5.70：Word 表格工具套件四件 =====
  {
    console.log('— v2.5.70 Word 表格套件 —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    ok(officeJs.includes('function scanWordTables') && officeJs.includes('function formatWordTable') && officeJs.includes('function addWordTable') && officeJs.includes('function editWordTable'), '表格引擎四件落盘（scan/format/add/edit）')
    ok(toolsJs.includes("'read_word_tables'") && toolsJs.includes("'format_word_table'") && toolsJs.includes("'add_word_table'") && toolsJs.includes("'edit_word_table'"), '工具注册四件（read/format/add/edit）')
    ok(officeJs.includes("tblOpen + newTblPr + gridXml + newRows.join('') + '</w:tbl>'"), '整表重组含 tbl 开闭标签（漏闭合=文档损坏）')
    // 子测试全流程真跑（read/format三线表斑马/edit setCell插行合并/add 定位插表）
    const { execSync } = require('child_process')
    try {
      const out = execSync(`node "${path.join(ROOT, 'test', 'word-table-test.js')}"`, { stdio: 'pipe', timeout: 120000, encoding: 'utf8', cwd: ROOT })
      ok(out.includes('ALL PASS'), '表格套件子测试全流程真跑（27 项断言）')
    } catch (e) {
      ok(false, `表格套件子测试失败: ${(e.stdout || e.message).toString().slice(-120)}`)
    }
  }

  // ===== v2.5.72：表格补欠四件（富文本 setCell / 斜线表头 / fix_paper_paging / svg_to_png）=====
  {
    console.log('— v2.5.72 表格补欠四件 —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok(officeJs.includes('const setCellRich') && officeJs.includes("op.op === 'diagHeader'") && officeJs.includes('async function fixPaperPaging') && officeJs.includes('async function svgToPng'), '引擎四件落盘（setCellRich/diagHeader/fixPaperPaging/svgToPng）')
    ok(officeJs.includes("module.exports") && /fixPaperPaging, svgToPng/.test(officeJs), 'office.js exports 含 fixPaperPaging/svgToPng')
    // defs 逐名强断言：{ name: 'xxx' 形式只有 TOOL_DEFS 条目有——handler 是 async xxx(、case 是 case 'xxx':，均不会误命中
    const defNames = ['read_word_tables', 'format_word_table', 'add_word_table', 'edit_word_table', 'fix_paper_paging', 'svg_to_png']
    ok(defNames.every((n) => toolsJs.includes(`{ name: '${n}'`)), `TOOL_DEFS 六件逐名注册（${defNames.join('/')}）`)
    ok(readManual('表格.md').includes('diagHeader') && readManual('表格.md').includes('paras:'), 'edit_word_table desc 带出 diagHeader/富文本用法（AI 可见）→ 手册 表格.md')
    ok(toolsJs.includes('async fix_paper_paging') && toolsJs.includes('await fixPaperPaging(') && toolsJs.includes('async svg_to_png') && toolsJs.includes('await svgToPng('), 'handlers 落盘且 await 异步引擎')
    ok(toolsJs.includes("case 'fix_paper_paging'") && toolsJs.includes("case 'svg_to_png'"), 'classify 汇总含新两件')
    // fixPaperPaging 必须 JSZip 模式（utf8 读写整包=zip 损坏，v2.5.70 老坑）
    const fixFn = officeJs.slice(officeJs.indexOf('async function fixPaperPaging'), officeJs.indexOf('svgToPng(svgPath'))
    ok(/loadAsync/.test(fixFn) && /generateAsync/.test(fixFn) && !/readFileSync\(paperPath,\s*'utf8'\)/.test(fixFn), 'fixPaperPaging 走 JSZip 解包回写（docx 是 zip，utf8 整包读写=损坏）')
    // setCellRich/diagHeader 重组保留 tc 标签
    ok(/tcOpen \+ tcPrNew \+ body \+ '<\/w:tc>'/.test(officeJs) && /return tcOpen \+ tcPr \+ spec\.paras/.test(officeJs), '单元格重组保留 <w:tc> 标签（漏闭合=表格消失老坑）')
  }

  // ===== v2.5.73：旧版 .doc（OLE2）全链路兼容 =====
  {
    console.log('— v2.5.73 旧版 .doc 兼容 —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const ps1Path = path.join(ROOT, 'ai', 'doc2docx.ps1')
    ok(fs.existsSync(ps1Path) && fs.readFileSync(ps1Path, 'utf8').includes('KWPS.Application') && fs.readFileSync(ps1Path, 'utf8').includes('SaveAs2'), 'doc2docx.ps1 落盘（WPS 优先 + SaveAs2 docx）')
    ok(officeJs.includes('function isLegacyDoc') && officeJs.includes('0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1') && /module\.exports[^\n]*isLegacyDoc/.test(officeJs), 'isLegacyDoc OLE2 魔数探测落盘并导出')
    ok(toolsJs.includes('async function docToDocx') && toolsJs.includes("doc2docx.ps1") && toolsJs.includes('async function ensureReadableDocx'), 'tools.js 转换器+读链兜底落盘')
    // 读链收口点位：readFull(read_word) + 5 个 handler 直接 ensure
    const ensureCount = (toolsJs.match(/await ensureReadableDocx\(/g) || []).length
    ok(ensureCount >= 6, `读链透明转换点位 ≥6（实际 ${ensureCount}：read_word/read_word_format/read_paper_spec/read_word_tables/check_paper_format×2/apply_word_template×2/apply_word_format formatPath）`)
    // 写链守卫：本机 args.path + 远程 temp 下载后都要拦
    const guardCount = (toolsJs.match(/legacyDocWriteBlock\(/g) || []).length
    ok(guardCount >= 10, `写链守卫点位 ≥10（实际 ${guardCount}，含远程下载后 temp 魔数复查）`)
    ok(toolsJs.includes('暂不支持原地修改') && toolsJs.includes('先 read_word 读它（会自动生成可编辑的 .docx 副本'), '写链报错带引导下一步（AI 可自愈）')
    ok(toolsJs.includes('这是旧版 .doc（Word 二进制），不是 PDF'), 'pdf_to_image 对 .doc 明确纠偏（防 AI 拿 .doc 空转）')
  }

  // ===== v2.5.74：COM 转换健壮化（用户机"Word 未能引发事件"修复）=====
  {
    console.log('— v2.5.74 COM 转换健壮化 —')
    const ps1 = fs.readFileSync(path.join(ROOT, 'ai', 'doc2docx.ps1'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok(/@\(\'KWPS\.Application\', \'Word\.Application\', \'WPS\.Application\'\)/.test(ps1), '引擎三候选（WPS 新旧 ProgID + Word）')
    ok(ps1.includes('for ($round = 1; $round -le 2; $round++)') && ps1.includes('Start-Sleep -Milliseconds 1500'), '每引擎 2 轮重试（busy 类 COM 错误重试即愈）')
    ok(ps1.includes("Open($Src, $false, $true)") && ps1.includes("Open($Src)"), 'Open 3 参失败 fallback 1 参（WPS 兼容层不稳的兜底）')
    ok(ps1.includes('CONVERT_FAIL') && ps1.includes('SaveAs2') && ps1.includes('SaveAs'), '失败带步骤标记 + SaveAs2/SaveAs 双通道')
    // 真跑转换链路（含全角括号中文路径用例；无 COM 环境输出 SKIP 不算失败）
    const { execSync } = require('child_process')
    try {
      const out = execSync(`node "${path.join(ROOT, 'test', 'doc-convert-test.js')}"`, { stdio: 'pipe', timeout: 300000, encoding: 'utf8', cwd: ROOT })
      ok(out.includes('ALL PASS') || out.includes('SKIP'), out.includes('SKIP') ? '转换链路本机无 COM 引擎，SKIP（用户机装 WPS 后生效）' : '.doc 转换链路真跑（COM 造样本→转回→内容一致，含全角括号路径）')
    } catch (e) {
      ok(false, `.doc 转换测试失败: ${(e.stdout || e.message).toString().slice(-120)}`)
    }
  }

  // ===== v2.5.75：COM 转换根因修复（正斜杠挂死）+ 转换缓存复用 =====
  {
    console.log('— v2.5.75 正斜杠根因 + 缓存 —')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    const ps1 = fs.readFileSync(path.join(ROOT, 'ai', 'doc2docx.ps1'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok(toolsJs.includes('srcPath = path.resolve(srcPath)'), 'docToDocx 正斜杠根因修复（path.resolve 规范化，WPS COM 对 C:/xxx 挂死）')
    ok(ps1.includes('Resolve-Path -LiteralPath $Src'), 'ps1 层 Resolve-Path 双保险')
    ok(toolsJs.includes('docConvInflight') && toolsJs.includes('st.mtimeMs >= fs.statSync(srcPath).mtimeMs'), '转换缓存复用（成功一次不再碰 COM；src 更新 mtime 失效）')
  }

  // ===== v2.5.76：说明书式模板嫁接修复（示范段剔除/节判定内容特征/工作流固化）=====
  {
    console.log('— v2.5.76 说明书式模板嫁接 —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok(officeJs.includes('function isFormatDemoPara') && officeJs.includes('function classifyTplSection'), '示范段识别+节判定引擎落盘')
    // 节判定预处理必须"清洗后重算 kind"（splitTplSections 切节时基于原始 paras 定 kind——不重算=白清洗）
    ok(/sec\.paras = kept[\s\S]{0,400}sec\.kind = classifyTplSection\(sec\.paras, prevKind\)/.test(officeJs), '清洗后重判节类型（kind 重算）')
    ok(officeJs.includes('/^注\\s*意\\s*事\\s*项/') && officeJs.includes('本科毕业论文.{0,8}(原创性声明|版权使用授权书)'), '注意事项剔除（"定稿删除此页"不进产出，声明标题段才解禁）')
    ok(/题\\s\*目/.test(toolsJs) === false && toolsJs.includes('改论文格式禁用本工具'), 'apply_word_format desc 论文场景警示（防拿另一篇论文当参考）')
    ok(readManual('Word排版.md').includes('校徽等封面图片、原创性声明/授权页自动迁入') && readManual('Word排版.md').includes('改论文格式必须走本工具'), 'apply_word_template desc 固化正确工作流 → 手册 Word排版.md')
    // 真跑套模板测试（含真素材全链路；素材缺失 SKIP）
    const { execSync } = require('child_process')
    try {
      const out = execSync(`node "${path.join(ROOT, 'test', 'tpl-graft-test.js')}"`, { stdio: 'pipe', timeout: 300000, encoding: 'utf8', cwd: ROOT })
      ok(out.includes('ALL PASS') || out.includes('SKIP'), out.includes('SKIP') ? '套模板测试 SKIP（素材不在）' : '套模板工作流真跑（示范段/节判定/封面图/TOC/体检 35 项）')
    } catch (e) {
      ok(false, `套模板测试失败: ${(e.stdout || e.message).toString().slice(-150)}`)
    }
  }

  // ===== v2.5.77：分段循环工作流（逐节对照进度表 + 工作流 desc 固化）=====
  {
    console.log('— v2.5.77 分段循环工作流 —')
    const officeJs = fs.readFileSync(path.join(ROOT, 'ai/office.js'), 'utf8')
    const toolsJs = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok(officeJs.includes('【逐节对照进度】') && officeJs.includes('已过，可进下一段'), 'checkPaperFormat 逐节对照进度表（每节显式 ✓/✗）')
    ok(officeJs.includes('secOf') && officeJs.includes('secDefs'), 'issue 按板块归类（封面/摘要/关键词/目录/正文/参考文献）')
    // 板块存在性判定与 classifyTplSection 内容特征对齐（说明书式模板无排头不再漏检）
    ok(officeJs.includes('hasTocSection: tplTexts.some') && officeJs.includes("abstract: tplTexts.some((t) => /^摘\\s*要/.test(t) || /^关键词[:：]/.test(t))") && officeJs.includes('refs: tplTexts.some'), '模板板块判定内容特征对齐（摘要=排头 OR 关键词行；目录=排头 OR 条目≥3；refs=排头 OR [1][2]≥2）')
    // 工作流 desc 固化（三个工具都写死分段循环）→ 手册 Word排版.md
    ok(readManual('Word排版.md').includes('宁可多步不可做错') && readManual('Word排版.md').includes('六节全 ✓ 才算完成'), 'check_paper_format desc 分段循环工作流（正确 > 速度）→ 手册 Word排版.md')
    ok(readManual('Word排版.md').includes('修一个板块复查一次') && readManual('Word排版.md').includes('禁止套完不验就交差'), 'apply_word_template desc 分段循环工作流 → 手册 Word排版.md')
    ok(readManual('Word排版.md').includes('逐段提取模板格式') && readManual('Word排版.md').includes('✓ 才进下一段'), 'read_paper_spec desc 规范书=逐段格式依据 → 手册 Word排版.md')
    const { execSync } = require('child_process')
    try {
      const out = execSync(`node "${path.join(ROOT, 'test', 'tpl-graft-test.js')}"`, { stdio: 'pipe', timeout: 300000, encoding: 'utf8', cwd: ROOT })
      ok(out.includes('ALL PASS') || out.includes('SKIP'), out.includes('SKIP') ? '套模板测试 SKIP（素材不在）' : '套模板工作流真跑（38 项含逐节对照断言）')
    } catch (e) {
      ok(false, `套模板测试失败: ${(e.stdout || e.message).toString().slice(-150)}`)
    }
    ok(pkg.version === '2.8.7', `package.json 版本 2.8.7（实际 ${pkg.version}）`)
  }

  // ===== v2.6.0：工具手册化（渐进式披露：主规则瘦身，深度说明迁 ai/manuals 六册）=====
  {
    console.log('— v2.6.0 工具手册化（渐进式披露） —')
    const promptjs = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
    const agentjs = fs.readFileSync(path.join(ROOT, 'ai/agent.js'), 'utf8')
    const toolsDef = fs.readFileSync(path.join(ROOT, 'ai/tools.js'), 'utf8')
    const mainjs2 = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
    // ① 手册七册落盘且非空
    const manualDir = path.join(ROOT, 'ai', 'manuals')
    const manualNames = ['word文档.md', 'Word排版.md', '表格.md', 'ppt文档.md', '图片视频.md', '设计.md', '网络下载.md', '跨设备协作.md', '格式转换.md', '电脑控制.md', '开发.md']
    ok(manualNames.every((n) => { try { return fs.statSync(path.join(manualDir, n)).size > 2000 } catch { return false } }), '手册十一册落盘且非空（>2KB，含 电脑控制/开发）')
    // ② TOOL_DEFS manual 字段计数（brief 瘦身 + 手册指向；行尾手册路径=双轨渲染）
    const manualCount = (toolsDef.match(/manual: '/g) || []).length
    ok(manualCount === 54, `TOOL_DEFS manual 字段计数 = 54（实际 ${manualCount}）`)
    ok(toolsDef.includes("case 'remove_bg': return") && toolsDef.includes("'抠图引擎（onnxruntime-node）不可用"), 'remove_bg 实现+审批+describe 三处注册（本地 u2netp 抠图）')
    ok(toolsDef.includes("name: 'merge_pdf'") && toolsDef.includes("name: 'split_pdf'") && toolsDef.includes('STRUCTURAL_ARRAY_PARAMS') && toolsDef.includes("'paths'"), 'PDF 合并/拆分工具注册（pdf-lib，paths 数组白名单）')
    ok(toolsDef.includes("manual: 'ppt文档'") && toolsDef.includes("name: 'create_pptx'") && toolsDef.includes("name: 'read_pptx'") && toolsDef.includes("name: 'edit_pptx'"), 'PPT 三件套注册（create_pptx/read_pptx/edit_pptx → 手册：ppt文档）')
    ok(toolsDef.includes('→ 手册：ai_manuals/'), 'buildToolPromptSection 双轨渲染（manual 工具行尾带手册路径）')

    // ===== 电脑控制三件套（v2.8.2：三档控制模式 + browser_* 网页填表 + desktop_* 桌面键鼠）=====
    {
      const workjs = fs.readFileSync(path.join(ROOT, 'src/js/work.js'), 'utf8')
      const indexHtml = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8')
      const maincss = fs.readFileSync(path.join(ROOT, 'src/styles/main.css'), 'utf8')
      const preloadjs = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
      const promptjs2 = fs.readFileSync(path.join(ROOT, 'ai/prompt.js'), 'utf8')
      const desktopCtlSrc = fs.readFileSync(path.join(ROOT, 'ai/desktop-control.js'), 'utf8')
      // ① 三档控制模式：unlimited 会话级（读档回落 auto）+ needApproval 短路 + 菜单两步确认
      ok(agentjs.includes('normalApprovalMode()') && agentjs.includes("if (m === 'unlimited') { this.setSetting('aiApprovalMode', 'auto'); return 'auto' }"), 'unlimited 会话级：读档回落 auto 并修正存档（重启防线复位）')
      ok(agentjs.includes("const needApproval = mode === 'unlimited'\n          ? false"), 'unlimited 档审批全放行（needApproval 短路）')
      ok(workjs.includes('function showApprovalMenu') && workjs.includes("classList.add('armed')") && workjs.includes('再次点击确认开启'), '控制模式三选菜单 + 无限制两步确认（armed 防误触）')
      ok(indexHtml.includes('id="aiApprovalMenu"') && indexHtml.includes('as-dot'), '控制模式胶囊（色点）+ 菜单容器落盘')
      ok(maincss.includes('.approval-switch.unlimited .as-dot') && maincss.includes('@keyframes approvalUnlimitedPulse'), '无限制档红色脉冲样式')
      // ② desktop_* 桌面键鼠引擎：PowerShell 常驻 + SendInput（零 npm 依赖）
      ok(desktopCtlSrc.includes('class DesktopControl') && desktopCtlSrc.includes("SendInput") && /msdesk-v\d/.test(desktopCtlSrc) && desktopCtlSrc.includes("'\\ufeff' + BOOTSTRAP"), '桌面控制引擎（PS 常驻+SendInput；引导脚本 UTF8 BOM 防 PS5.1 ANSI 乱码）')
      ok(mainjs2.includes("require('./ai/desktop-control')") && mainjs2.includes('desktop: desktopCtl'), 'main 注入 desktop 引擎到 createTools')
      ok(fs.existsSync(path.join(ROOT, 'test/desktop-engine-test.js')), '桌面引擎探针测试落盘（ping/光标/窗口枚举无副作用验证）')
      // ③ browser_* 网页控制：主进程请求-响应桥 + 受控页签 + ref 表
      ok(mainjs2.includes("ipcMain.on('ai:browser-ctl-result'") && mainjs2.includes('browserCtl,'), 'browser 桥：主进程 pending+回执 handler+注入')
      ok(preloadjs.includes('onAiBrowserCtl') && preloadjs.includes('browserCtlResult'), 'preload 双 API（桥请求接收+结果回执）')
      ok(workjs.includes('function initBrowserCtlBridge') && workjs.includes('initBrowserCtlBridge()') && workjs.includes('window.__msAiRefs') && workjs.includes("AI_WEB_PATH = 'url://ai-ctl'"), '渲染层受控页签执行器（AI 浏览页签+ref 表）')
      // ④ 工具注册四处 + 手册
      ok(toolsDef.includes("name: 'browser_navigate'") && toolsDef.includes("name: 'desktop_click'") && toolsDef.includes('name.startsWith(\'desktop_\')') && toolsDef.includes("'keys'"), '电脑控制十工具注册（DEFS/classify/数组白名单）')
      ok(promptjs2.includes("'电脑控制.md'") && fs.statSync(path.join(ROOT, 'ai/manuals/电脑控制.md')).size > 2000, '电脑控制手册注册+落盘（>2KB）')
      // ⑤ 开发三件套（对标 Trae：run_command/edit_file/search_file_content + 本地网页预览）
      ok(toolsDef.includes("name: 'run_command'") && toolsDef.includes('chcp 65001 >nul') && toolsDef.includes("new TextDecoder('gbk')"), 'run_command（exec+危险黑名单+GBK 智能解码零依赖）')
      ok(toolsDef.includes("name: 'edit_file'") && toolsDef.includes('old_string 在文件中找不到') && toolsDef.includes('replaceAll: true'), 'edit_file（old→new 精准替换+唯一性校验）')
      ok(toolsDef.includes("name: 'search_file_content'") && toolsDef.includes("'node_modules', '.git'"), 'search_file_content（内容搜索+噪声目录跳过）')
      ok(workjs.includes("if (/^[a-zA-Z]:[\\\\/]/.test(u)) u = 'file:///' + u.replace(/\\\\/g, '/')") && workjs.includes('/^(https?:\\/\\/|file:\\/\\/)/i'), 'browser_navigate 放行 file:// 本地预览（Windows 路径自动转 file:///）')
      ok(promptjs2.includes("'开发.md'") && fs.statSync(path.join(ROOT, 'ai/manuals/开发.md')).size > 2000, '开发手册注册+落盘（>2KB）')
      // ⑥ 内置截图（参考 QQ 截图：快捷键 + 选区标注 + 注入聊天）
      const captureJs = fs.readFileSync(path.join(ROOT, 'capture.js'), 'utf8')
      const captureHtml = fs.readFileSync(path.join(ROOT, 'src/capture.html'), 'utf8')
      const pkgJson2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      ok(captureJs.includes('createCaptureManager') && captureJs.includes('Ctrl+Shift+A') && captureJs.includes('desktopCapturer') && captureJs.includes('finishWithDataURL'), '截图主进程（快捷键+抓屏+完成管线）')
      ok(captureHtml.includes('captureDone') && captureHtml.includes("marks.pop()") && captureJs.includes("clipboard.writeImage"), '截图渲染层（标注撤销+导出）+ 剪贴板写入')
      ok(mainjs2.includes("require('./capture')") && mainjs2.includes('captureMgr.init()') && mainjs2.includes('captureMgr.destroy()'), 'main 挂截图模块（init+before-quit destroy 注销快捷键）')
      ok(preloadjs.includes('onCaptureBg') && preloadjs.includes('captureDone') && preloadjs.includes('onCaptureInject'), 'preload 截图五 API')
      ok(workjs.includes('chatCaptureBtn') && workjs.includes('_appendChatRef(path)'), 'Work 截图按钮 + 成品注入聊天引用')
      ok(pkgJson2.build.files.includes('capture.js'), 'build.files 含 capture.js（防 pet.js 漏打包坑复发）')
    }
    // ⑤ C 盘文档改稿工作流（modify_word 自动转工作台副本，原文件留作对比；classify 同步按副本路径免保护区审批）
    ok(toolsDef.includes('protectedDraftCopy') && toolsDef.includes('draftPathOf') && toolsDef.includes("'改稿'") && toolsDef.includes('protectedDraftTarget'), 'modify_word C 盘改稿自动转工作台副本（helper+classify 双注册）')
    // ③ releaseManualsTo 真跑：释放到临时目录，6 册非空
    try {
      const { releaseManualsTo } = require(path.join(ROOT, 'ai/prompt.js'))
      const tmpRelease = fs.mkdtempSync(path.join(os.tmpdir(), 'msmate-manuals-'))
      const dst = releaseManualsTo(tmpRelease)
      const released = fs.readdirSync(dst).filter((f) => f.endsWith('.md'))
      ok(released.length >= 6 && released.every((f) => fs.statSync(path.join(dst, f)).size > 0), `releaseManualsTo 真跑落盘 ${released.length} 册非空`)
    } catch (e) { ok(false, `releaseManualsTo 真跑异常: ${e.message}`) }
    // ④ prompt.js 四管道 + 索引段 + 网页版全文拼接
    ok(promptjs.includes('function manualsSourceDir') && promptjs.includes('function releaseManualsTo') && promptjs.includes('function loadManualsMarkdown') && promptjs.includes('function manualsIndexSection'), 'prompt.js 手册四管道（源目录/释放/网页版拼接/索引段）')
    ok(promptjs.includes('manualsIndexSection(ctx.manualsDir)'), 'assembleSystemPrompt 插入手册索引段')
    ok(promptjs.includes("if (!manualsDir) return ''") && promptjs.includes('statSync(manualsDir)'), '索引段空值/目录缺失兜底（不可用=整段省略）')
    ok(promptjs.includes('loadManualsMarkdown()') && promptjs.includes('工具手册全文'), 'assembleWebRulesDoc 网页版拼接手册全文')
    ok(promptjs.includes('禁止对 ai_manuals/ 路径发起 read_file'), '网页版防幻觉条款（手册不在工作区，禁 read_file）')
    // ⑤ 接线：agent 注入 manualsDir + main 启动释放
    ok(agentjs.includes("manualsDir: this.workspaceDir ? path.join(this.workspaceDir, 'ai_manuals') : ''"), 'agent 注入 manualsDir（工作区 ai_manuals/）')
    ok(mainjs2.includes("releaseManualsTo } = require('./ai/prompt')") && mainjs2.includes('releaseManualsTo(workspaceDir)'), 'main.js 启动释放手册（每次启动覆盖，升级即更新）')
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
