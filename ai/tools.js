// ============================================
// MSWork AI 工具层
// 把本地/远程（已配对设备）文件操作封装成 AI 可调用的工具
// 采用"文本协议"：AI 按 ```tool {...}``` 格式输出，agent 解析后调用这里
// 每个改动型操作都会返回 undo 撤销记录，供聊天检查点回滚使用
// ============================================
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { createDocx, readDocxText, readPdfText, parseWordComments, parseWordFormat, wordFormatFingerprint, parseFormatRuleText, extractPaperFormatSpec, checkPaperFormat, anchorSpecRole, convertNumPrToText, replaceCoverFields, scanWordTables, formatWordTable, addWordTable, editWordTable, fixPaperPaging, svgToPng, isLegacyDoc, applyWordFormat, applyWordTemplate, modifyDocx, createXlsx, appendXlsxRows, readXlsx, modifyXlsxCell, modifyXlsxCells, formatXlsx, listXlsxSheets, createPptx, readPptx, editPptx } = require('./office')

let JSZip
try { JSZip = require('jszip') } catch {}

const READ_LIMIT = 64 * 1024          // read_file 单段最大返回字节数（大文件自动分段）

// 旧版对端提示：未上报 appVersion = 旧版本（接收端缺少稳定性修复，可能卡死/崩溃）
function oldPeerNote(dev) {
  return dev && !dev.appVersion ? `\n（提示：${dev.name} 是旧版本，接收端稳定性有限，建议对方升级到最新版 MSMate）` : ''
}

const SEARCH_MAX_RESULTS = 30
const SEARCH_MAX_SCAN = 3000
const SEARCH_MAX_DEPTH = 8

function fmtSize(n) {
  if (n < 1024) return n + 'B'
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB'
  return (n / 1073741824).toFixed(2) + 'GB'
}

function genId(prefix) {
  return prefix + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex')
}

// ===== 网页会话记忆（v2.4.72）：跨轮去重搜索结果 + 重复抓取提醒 =====
// 老大担忧实锤：一轮读了 7 个网页，换词再搜还是那 7 个 → AI 又逐个重读，空转多轮。
// 10 分钟 TTL：覆盖"同一任务连续多轮"的典型窗口；跨任务最多误提一次提醒，代价可忽略
const WEB_SEEN_TTL = 10 * 60 * 1000
const webSeenUrls = new Map() // 去参数 URL -> 首见时间戳
function webSeenKey(u) { return String(u || '').replace(/[#?].*$/, '').replace(/\/+$/, '') }
function webSeenMark(u) { webSeenUrls.set(webSeenKey(u), Date.now()) }
function webSeenCheck(u) {
  const k = webSeenKey(u)
  const t = webSeenUrls.get(k)
  if (t === undefined) return false
  if (Date.now() - t > WEB_SEEN_TTL) { webSeenUrls.delete(k); return false }
  return true
}
function webSeenSweep() { const now = Date.now(); for (const [k, t] of webSeenUrls) if (now - t > WEB_SEEN_TTL) webSeenUrls.delete(k) }

// 工具定义（写入系统提示词，供 AI 选择调用）
// ⚠ manual 字段 = 该工具的详细说明在 ai/manuals/<值>.md 手册里（brief 只留目录级简述，深度教学全在手册）；
//   改 brief 参数简签时必须同步核对对应手册（一致性红线）；core 工具（无 manual 字段）说明全在主规则
const TOOL_DEFS = [
  { name: 'list_dir', params: 'path(目录路径,"root"列盘符), target(可选,"local"或设备名/ID)', desc: '列出目录内容' },
  { name: 'read_file', params: 'path(文件路径), offset(可选,字节偏移,续读大文件时传上段返回的offset), target(可选)', desc: '读取文本文件内容；超过64KB自动分段返回并附续读offset，按提示传offset可读完整大文件（二进制文件会拒绝）' },
  { name: 'write_file', params: 'path(文件完整路径), content(文本内容), target(可选)', desc: '创建或覆盖文本文件。覆盖前会自动备份原文件' },
  { name: 'create_folder', params: 'path(文件夹路径，可多级), target(可选)', desc: '创建文件夹' },
  { name: 'copy_path', params: 'src(源路径,支持数组批量), dest_dir(目标文件夹), target(可选)', desc: '在同一台电脑内复制文件/文件夹到目标文件夹内（src 传数组可一次复制多项）' },
  { name: 'move_path', params: 'src(源路径,支持数组批量), dest_dir(目标文件夹), target(可选)', desc: '在同一台电脑内移动文件/文件夹到目标文件夹内（src 传数组可一次移动多项）' },
  { name: 'transfer_file', params: 'src_path(源文件完整路径), src_target(源设备,可选默认local), dest_target(目标设备,可选默认local), dest_dir(目标文件夹的完整磁盘路径,如 C:\\Users\\<用户名>\\Desktop——禁止传"桌面"这类列表显示名)', desc: '跨设备复制文件（"把对方/远程电脑的文件复制过来/传过去"就用它；同设备用 copy_path）。dest_dir 必须完整路径禁传显示名，不确定对方用户名先 list_dir(path:"C:\\\\Users", target:设备) 探查。三步套路详见手册', manual: '跨设备协作' },
  { name: 'rename_path', params: 'path(原路径), new_name(新名称,仅文件名), target(可选)', desc: '重命名文件/文件夹' },
  { name: 'delete_path', params: 'path(路径), target(可选)', desc: '删除文件或文件夹。会先自动备份到快照缓存槽' },
  { name: 'search_files', params: 'dir(搜索起始目录), keyword(关键词), target(可选)', desc: '按名称搜索文件：本机含全部子目录递归搜；远程设备仅搜该目录一层，子目录需先 list_dir 再逐层搜' },
  { name: 'view_image', params: 'path(单图完整路径) 或 paths(多图路径数组,一次识多张更快,最多6张), question(可选,按用户意图写:想知道画面内容写"描述图片内容",要文字写"完整转录图中文字")', desc: '看图识图：分析本机图片（截图/照片/文档/表格），返回内容描述或文字转录。**多张图验证/对比场景必用 paths 一次传**（单请求总耗时≈单张，逐张调会慢好几倍）。png/jpg/jpeg/webp/gif/bmp，≤20MB 自动压缩。默认 Qwen3.6-35B-A3B（MoE 秒级）。远程图片先 transfer_file 拉到本机再看', manual: '图片视频' },
  { name: 'remove_bg', params: 'path(图片完整路径), out(可选,输出透明底PNG路径,默认原名-抠图.png 存原图旁)', desc: 'AI 抠图去背景：本地模型（首次自动下载 4.4MB 到应用数据，之后离线秒级）输出透明底 PNG。海报合成素材必备——抠完配 render_html（透明素材 <img> 直接叠加排版）。人像/宠物/产品/物体主体效果好；复杂发丝边缘偶有毛边，合成时加轻微阴影可弱化', manual: '图片视频' },
  { name: 'screenshot', params: 'scope(可选,默认webview:webview=工作台网页视图/app=应用窗口/screen=整屏), path(可选,保存路径), minimizeSelf(可选,bool,仅screen生效,默认true)', desc: '截图本机，**只截图不分析**——返回保存路径，要看内容再调 view_image。用户问"看看我屏幕/桌面上有啥"先 scope:"screen" 截全屏再看，禁止空想回答', manual: '图片视频' },
  { name: 'update_notes', params: 'mode(append=追加一条记录(默认)/read=查看现在记了什么/replace=整本重写(慎用)), content(append/replace 时的内容，markdown，一行一条)', desc: '读写大记事本（工作台 NOTES.md，全局长期记忆，所有对话共享）：用户说"记住XX/以后都XX/我喜欢XX"就 append 一条（带日期前缀）；用户问"你记了什么"用 read；重要习惯/偏好/常用路径/项目背景都值得记，但只记长期有效的信息（一次性任务不要记）' },
  { name: 'create_word', params: 'path(docx完整路径), title(文档标题), content(markdown正文:标题/加粗/列表/插图/表格行自动排版), paragraphs(可选,段落数组替代content), header/footer/pageNumbers/toc/theme/fonts/lineSpacing/firstLine/cover/tocLevels(可选,详见手册), target(可选)', desc: '创建 Word 文档(.docx)，markdown 一键排版。排版铁律（数据必须表格化/结论用callout）、插图大小对齐控制、版式蓝图先行详见手册', manual: 'word文档' },
  { name: 'read_word', params: 'path(docx完整路径), seg(可选,第几段,长文档分段逐段读), target(可选)', desc: '读 Word 文字内容，自动带出批注。超5000字自动分段防幻觉，逐段传 seg 读，禁止一次读完长文档', manual: 'word文档' },
  { name: 'read_pdf', params: 'path(pdf完整路径), target(可选)', desc: '读 PDF 文字内容（文本层提取）。返回"没有文本层"=扫描件/图片型，改用 pdf_to_image 转图后逐张 view_image 读', manual: 'word文档' },
  { name: 'pdf_to_image', params: 'path(pdf完整路径), pages(可选,默认前10页), target(可选)', desc: '把 PDF 每页渲染成 PNG 存工作区返回路径清单。扫描件 PDF 转图后逐张 view_image 读；也用于看 PDF 版面/表格结构', manual: 'word文档' },
  { name: 'read_word_format', params: 'path(docx完整路径), mode(可选,默认fingerprint格式指纹;full=逐段全量)', desc: '解析 Word 完整格式（字体/字号/行距/缩进/页边距等），样式级联已折算成每段实际生效格式。参考 A 改 B 的工作流详见手册', manual: '论文排版' },
  { name: 'read_paper_spec', params: 'path(格式模板docx完整路径), target(可选)', desc: '把学校论文格式模板蒸馏成几百字"格式规范书"（页面设置/各角色格式/批注规则/红字原文）。论文套模板闭环第一步，禁止 read_word 模板全文', manual: '论文排版' },
  { name: 'check_paper_format', params: 'path(套模板后的产出docx完整路径), templatePath(格式模板docx完整路径), target(可选)', desc: '论文产出体检：对照模板规范书逐项检查，返回逐节对照进度表（六节 ✓/✗）+ issue 清单。分段循环：一节 ✓ 才进下一节，禁止套完不验就交差', manual: '论文排版' },
  { name: 'apply_word_format', params: 'path(要改的docx完整路径), formatPath(格式参考A的docx,rules用"source"时必传), rules(套用规则:map角色批量套或picks单段精修), target(不支持远程)', desc: '内容一字不动只改格式。⚠改论文格式禁用本工具，必须走 apply_word_template 闭环。适合普通文档参考A改B、体检后picks精修。详见手册', manual: '论文排版' },
  { name: 'apply_word_template', params: 'path(论文docx完整路径), templatePath(学校格式模板docx完整路径), cover(可选封面字段对象:title题目/college学院/major专业/grade年级/studentId学号/name姓名/advisor指导教师/date日期), outputPath(可选输出路径,默认"论文名-套模板格式.docx"), target(不支持远程)', desc: '论文套学校格式模板：模板当骨架论文当血肉，封面校徽图片/页眉页脚/分节页码/目录域一步到位，产出零批注零红字。cover 建议必传。改论文格式必须走本工具，六节闭环详见手册', manual: '论文排版' },
  { name: 'modify_word', params: 'path(docx完整路径), mode(append=追加/replace=全量重写/edit=精准替换,默认append), paragraphs/content(append/replace时新内容,格式同create_word), replacements(edit必填:[{find:"旧文字",replace:"新文字",all?}]), title/header/toc/theme等(仅replace生效), target(可选)', desc: '修改已有 Word（自动备份）。append=追加；replace=重写；edit=精准替换改几处文字首选，不用重读重写全文', manual: 'word文档' },
  { name: 'read_word_tables', params: 'path(docx完整路径), target(可选)', desc: '列出 Word 里所有表格（行×列+前两行预览）。改表格前先看清单定位第几个表', manual: '表格' },
  { name: 'format_word_table', params: 'path(docx完整路径), index(第几个表格,1起)/near(附近文字), style(可选:threeline三线表/grid全边框/zebra斑马/light公文浅色/none无框线), colWidths/eastAsiaFont/sizePt/colAligns/colBold等按列参数(可选), headerRows/keepWithPrev/widthPct(可选), target(可选)', desc: 'Word 表格排版（内容不动只改格式）：五预设风格+按列参数（"金额列右对齐"传 colAligns 一步到位）。参数详见手册', manual: '表格' },
  { name: 'add_word_table', params: 'path(docx完整路径), rows(二维数组,第一行为表头), colWidths(可选,列宽cm数组), afterText(可选,插到该段文字之后,默认末尾), theme/eastAsiaFont/font/sizePt(可选), target(可选)', desc: '在 Word 文档里插入表格，afterText 定位段后插入。格式不满意可接着 format_word_table', manual: '表格' },
  { name: 'edit_word_table', params: 'path(docx完整路径), index(第几个表格,1起)/near(附近文字), ops(操作数组:setCell/insertRow/deleteRow/insertCol/deleteCol/mergeCells/diagHeader斜线表头/deleteTable)', desc: 'Word 表格内容级操作（改格/插删行列/合并单元格/斜线表头）。ops 语法详见手册。写操作自动快照可还原', manual: '表格' },
  { name: 'fix_paper_paging', params: 'path(docx完整路径), target(可选)', desc: '全文分页修复：表标题不与表格被分页拆开、长表格跨页自动重复表头。表格多/长的文档修完格式后跑一次', manual: '表格' },
  { name: 'svg_to_png', params: 'path(svg完整路径), out(可选,输出png路径), width/height(可选,像素), target(可选)', desc: 'SVG 转 PNG（应用内渲染，中文完美）。图表工作流：手写 SVG 存文件→本工具转 PNG→view_image 检查→插入 Word，零依赖可视化，详见手册', manual: '图片视频' },
  { name: 'create_table', params: 'path(xlsx完整路径), headers(表头数组)+rows(二维数组) 或 content(markdown表格文本) 或 sheets(多工作表对象), merges(可选,合并范围数组), styles(可选,范围样式数组:numFmt/align/wrap/rowHeight等), statusMap(可选,状态列条件配色), theme(可选:modern/classic/gov), target(可选)', desc: '创建 Excel(.xlsx) 自动美化，值以=开头写成公式。状态列配 statusMap 自动上色（ok绿/bad红/warn黄/info蓝）是精修灵魂。styles/merges 语法详见手册', manual: '表格' },
  { name: 'read_table', params: 'path(xlsx完整路径), sheet(可选,工作表名,默认第一个), target(可选)', desc: '读 Excel 内容返回二维数组；多工作表文件会提示全部表名', manual: '表格' },
  { name: 'append_table_rows', params: 'path(xlsx完整路径), rows(要追加的数据行二维数组), sheet(可选,工作表名), target(可选)', desc: '向 Excel 末尾追加数据行（自动备份；值支持 "=公式"）', manual: '表格' },
  { name: 'modify_table', params: 'path(xlsx完整路径), cell(单元格引用如 B2)+value(新值,数字/文本/"=公式") 或 cells(批量修改:{"B2":"新值","C3":"=SUM(B2:B3)"}), sheet(可选,工作表名), target(可选)', desc: '改 Excel 单元格的值（自动备份），=开头写成公式；多个格子用 cells 一次批量改，禁止拆成多次调用', manual: '表格' },
  { name: 'format_table', params: 'path(xlsx完整路径), theme(可选:modern(默认)/classic/gov), target(可选)', desc: '美化已有 Excel：主题化表头/自动列宽/冻结首行/细边框（首行视为表头，自动备份）', manual: '表格' },
  { name: 'create_pptx', params: 'path(pptx完整路径), title(演示标题,无#cover页时自动合成封面), subtitle(可选,封面副标题), content(PPT大纲:theme/style行+---分页+#cover/#toc/#section/#summary页型标记+##内容页标题,写法详见手册), target(可选)', desc: '创建 PPT 演示文稿(.pptx)自动排版：18套配色×4种风格×5种页型（封面/目录/章节页/内容/总结），页码徽标/防溢出/防同布局连用全自动。大纲写法与配色清单详见手册', manual: 'ppt文档' },
  { name: 'read_pptx', params: 'path(pptx完整路径), target(可选)', desc: '逐页读取 PPT 文字内容（【第X页】分页列出）。改 PPT 前先读确认原文', manual: 'ppt文档' },
  { name: 'edit_pptx', params: 'path(pptx完整路径), replacements([{find:"旧文字",replace:"新文字",all?}]), target(可选)', desc: '改已有 PPT 文字（自动备份），跨样式碎 run 的句子也能匹配。只改文字不动版式；大改版式建议 read_pptx 后用 create_pptx 重做', manual: 'ppt文档' },
  { name: 'remember', params: 'fact(要记住的内容,一句话)', desc: '写入长期记忆（跨会话生效）。三种情况必须记：①理解错被用户纠正→记正确含义；②用户讲解了你不懂的词/术语/黑话→记解释；③用户表达偏好/规则（"以后都这样"）→记成规则。其他值得记：文件习惯、项目背景、踩坑经验（如某网站要带 referer）' },
  { name: 'forget', params: 'fact(要删除的记忆条目原文)', desc: '删除一条过时或错误的记忆。fact 从系统提示词"长期记忆"清单里原样复制即可；没有可删的就不用调' },
  { name: 'web_search', params: 'query(搜索关键词,可用|分隔一次传2-3个不同角度的词)', desc: '上网搜索（四引擎并发，一次传2-3个明显不同角度的词一轮拿全，近似词只浪费引擎）。提示"全部重复"必须换思路，禁止相近 query 连搜', manual: '网络下载' },
  { name: 'web_fetch', params: 'url(网页地址,http/https), mode(可选:text正文默认/links页面直链/images渲染抓图/videos视频地址)', desc: '抓网页（找下载/图片链接用 links；JS 渲染图站用 images；视频地址用 videos）。重复抓近期读过的链接会带提醒。内置反反爬，被拦直接重试', manual: '网络下载' },
  { name: 'download_file', params: 'url(文件直链,http/https), save_path(完整保存路径,或目录则自动命名), referer(可选,来源页面URL,防盗链站点需要), target(固定为local,下载到本机)', desc: '从网上下载文件到本机（exe/脚本类需用户批准，上限2GB），一轮可多个并行下载。防盗链自动补 Referer。要给其他设备先下本机再 transfer_file。只有返回 ok:true 的文件才存在', manual: '网络下载' },
  { name: 'open_url', params: 'url(网址,http/https)', desc: '用默认浏览器打开网址给用户看（如"找到壁纸网站并打开"= web_search 挑靠谱结果 → open_url）。只打开不抓内容，要读内容用 web_fetch' },
  { name: 'open_path', params: 'path(文件或文件夹完整路径)', desc: '用系统默认程序打开本机文件/文件夹（文档/图片/音乐/目录等，如"打开桌面那份报告"）。exe/脚本类会弹出审批卡片，用户批准后才运行' },
  { name: 'zip_compress', params: 'src(源路径,单个或数组), zip_path(输出的zip完整路径)', desc: '把本机的文件/文件夹打包成 zip 压缩包' },
  { name: 'zip_extract', params: 'zip_path(zip完整路径), dest_dir(解压目标文件夹)', desc: '解压本机的 zip 压缩包到指定文件夹' },
  { name: 'delegate', params: 'title(子任务短名), task(完整自包含的任务描述)', desc: '把子任务委派给独立子Agent，可多个并行（最多4个）。有额外开销，小任务不要用' },
  { name: 'ask_user', params: 'questions(问题数组 [{question:问题, header:短标签(≤8字), options:[{label:选项, description:说明}], multiSelect:是否多选}])', desc: '中途向用户提问：关键信息不齐、方案分歧大时用，用户在卡片上点选/输入后你自动继续。一次问全（1~3 题），每题 2~4 个选项；开放题可不带 options 让用户直接打字。用户取消或超时你会收到"按最合理方案继续"的提示。能自己推断的别问，纯闲聊别问' },
  { name: 'generate_image', params: 'prompt(画面描述/修改指令,越具体越好:主体/风格/构图/光线/色调), image(可选,要编辑/参考的图:本地路径或URL,数组1-3张多图合成), size(可选,仅生新图,"宽x高"如1024x1024), batch(可选,张数1-4), steps(可选,1-100默认30), save_path(可选,默认工作区「MSMate生成/图片」)', desc: 'AI 生图+编辑：不传 image=文生图；传 image=按指令改图保构图；2-3张=多图合成。画幅换算/对话式反复修改循环/遮罩黑区规则详见手册', manual: '图片视频' },
  { name: 'generate_video', params: 'prompt(视频内容描述,一句话说清主体+动作+场景+镜头感), save_path(可选,默认工作区「MSMate生成/视频」)', desc: 'AI 文生视频（模型在设置里配置）：约5秒短视频，耗时2-10分钟勿重复调用；多数模型可能产生费用，调用前先告知用户', manual: '图片视频' },
  { name: 'task_plan', params: 'items(建立/替换清单:字符串数组，每项一个具体动作), doing(标记进行中:序号或序号数组), done(标记完成:序号或序号数组)', desc: '任务清单（≥3步任务必用）：开工前建清单，每完成一项立刻打勾并标记下一项进行中；系统会把进度附在每步结果里，照着"下一步"提示继续干，全部打勾再收尾。⚠️ 打勾=该步实际验证成功；工具报错/失败=没完成，严禁打勾，如实汇报失败；也严禁跳步（第2步没完成不许先勾第2步）' },
  { name: 'render_html', params: 'path(HTML完整路径), out(可选,输出png路径,默认同名.png), preset(可选画布:xhs=1080x1440小红书3:4/square=1080x1080微信分享/a4=1240x1754竖版海报/wide=2100x900横幅/wechat-cover=900x383公众号封面,默认a4), width/height(可选,像素,覆盖preset), scale(可选,1-4倍高清出图,默认1;高清用2且HTML按CSS尺寸写)', desc: 'HTML 渲染成 PNG（离屏窗口截图，中文/渐变/阴影完美）。设计工作流：write_file 写单文件 HTML（内嵌CSS按CSS尺寸写死）→ render_html → view_image 自检溢出/配色 → 改了重渲。海报/公众号封面/小红书卡片/简历/邀请函全靠它，设计原则详见手册', manual: '设计' }
]

function buildToolPromptSection() {
  const lines = TOOL_DEFS.map((t) => t.manual
    ? `- ${t.name}(${t.params})：${t.desc} → 手册：ai_manuals/${t.manual}.md`
    : `- ${t.name}(${t.params})：${t.desc}`)
  return lines.join('\n')
}

// ===== 上网辅助（Electron net 优先 = 真 Chromium 网络栈/TLS 指纹；纯 Node 环境降级原生 https）=====
const https = require('https')
const http = require('http')
const zlib = require('zlib')
const { browserHeaders, looksLikeAntiCrawl, renderPage } = require('./anticrawl')

// ===== 截图引擎（v2.4.96：screenshot 工具——webview/app/screen 三级，主进程直通零 IPC）=====
// 纯 Node 环境（冒烟/CLI）下 require('electron') 拿到的是路径字符串而非 API → shotElectron 返回 null，工具层给出明确报错
let _removeBgSession = null // u2netp 推理会话缓存（跨实例共享无害：同模型同路径）
function shotElectron() {
  try {
    const m = require('electron')
    if (m && typeof m === 'object' && m.webContents && m.desktopCapturer) return m
  } catch {}
  return null
}
function shotSavePath(el, scope, customPath) {
  if (customPath && String(customPath).trim()) {
    const p = path.resolve(String(customPath).trim())
    fs.mkdirSync(path.dirname(p), { recursive: true })
    return p
  }
  const dir = path.join(el.app.getPath('userData'), 'ai-captures')
  fs.mkdirSync(dir, { recursive: true })
  const t = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return path.join(dir, `截_${scope}_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.png`)
}
function shotSave(img, p) {
  const buf = img.toPNG()
  fs.writeFileSync(p, buf)
  const sz = img.getSize()
  return { path: p, width: sz.width, height: sz.height, size: buf.length }
}
// 主窗口页面里找当前可见的 webview 标签 → getWebContentsId()（guest 内容级截图，后台标签也能截）
async function captureWebviewShot(el) {
  const wins = el.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (!wins.length) throw new Error('应用窗口未就绪')
  const script = "(function(){try{const vs=[...document.querySelectorAll('webview')].filter(v=>v.style.display!=='none'&&!v.hidden);for(let i=vs.length-1;i>=0;i--){try{const id=vs[i].getWebContentsId();if(id)return id}catch(e){}}return 0}catch(e){return -1}})()"
  const gid = await wins[0].webContents.executeJavaScript(script, true)
  if (gid === -1) throw new Error('网页视图查询异常（webview 标签未就绪），等页面加载完再试')
  if (!gid) throw new Error('当前没有打开的网页视图：先在工作台打开网页再截，或改用 scope:"app" 截应用窗口 / scope:"screen" 截整个屏幕')
  const guest = el.webContents.fromId(gid)
  if (!guest || guest.isDestroyed()) throw new Error('网页视图已销毁，请重新打开页面再截')
  const img = await guest.capturePage()
  if (!img || img.isEmpty()) throw new Error('网页截图为空（页面可能未渲染完成），稍等一两秒再试')
  return { img, url: (() => { try { return guest.getURL() } catch { return '' } })() }
}
async function captureAppShot(el) {
  const wins = el.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  if (!wins.length) throw new Error('应用窗口未就绪')
  const win = wins[0]
  if (win.isMinimized()) throw new Error('应用窗口处于最小化，截不到画面——请先还原窗口再试')
  const img = await win.webContents.capturePage()
  if (!img || img.isEmpty()) throw new Error('应用窗口截图为空（窗口可能被隐藏），请把窗口带到前台再试')
  return { img, url: '' }
}
// desktopCapturer 抓一帧静态画面：无弹窗/不抢输入/用户无感知（非录屏，截完即止）
async function captureScreenShot(el) {
  const sources = await el.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2560, height: 1440 } })
  if (!sources.length) throw new Error('系统没有可用的屏幕源')
  let src = sources[0]
  try {
    const pri = el.screen && el.screen.getPrimaryDisplay ? el.screen.getPrimaryDisplay() : null
    const hit = pri && sources.find((s) => String(s.display_id) === String(pri.id()))
    if (hit) src = hit
  } catch {}
  const img = src.thumbnail
  if (!img || img.isEmpty()) throw new Error('屏幕抓帧为空（可能被系统策略限制）')
  return { img, url: '' }
}


// 公共解压（gzip/deflate/brotli），失败原样返回
function decompressBuf(buf, enc) {
  const e = String(enc || '').toLowerCase()
  try {
    if (e === 'gzip') return zlib.gunzipSync(buf)
    if (e === 'deflate') return zlib.inflateSync(buf)
    if (e === 'br') return zlib.brotliDecompressSync(buf)
  } catch {}
  return buf
}

// Electron net 分支：Chromium 网络栈发出的 TLS 握手/HTTP2 指纹与真浏览器一致，
// 过"TLS 指纹识别"型反爬（Node 原生 https 的指纹一看就是脚本）。重定向由 Chromium 跟随。
function netGet(url, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    let electronMod = null
    try { electronMod = require('electron') } catch {}
    const net = electronMod && electronMod.net
    if (!net || typeof net.request !== 'function') return reject(new Error('NET_UNAVAILABLE'))
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; try { clearTimeout(timer) } catch {} fn(v) } }
    const timer = setTimeout(() => { try { req.abort() } catch {} done(reject, new Error('请求超时')) }, timeoutMs)
    const req = net.request({ url, redirect: 'follow', headers })
    const chunks = []
    let size = 0
    req.on('response', (res) => {
      const hs = res.headers || {}
      res.on('data', (c) => {
        size += c.length
        if (size > 2 * 1024 * 1024) { try { req.abort() } catch {}; done(reject, new Error('响应内容过大')) }
        else chunks.push(c)
      })
      res.on('end', () => done(resolve, {
        status: res.statusCode,
        contentType: hs['content-type'] || hs['Content-Type'] || '',
        headers: hs,
        buf: decompressBuf(Buffer.concat(chunks), hs['content-encoding'] || hs['Content-Encoding'] || '')
      }))
      res.on('error', (err) => done(reject, err))
    })
    req.on('error', (err) => done(reject, err))
    req.end()
  })
}

// 原生 https/http 兜底（纯 Node 测试环境 / net 不可用时）：手写跟随重定向 + 同款解压
function httpNodeGet(url, timeoutMs, redirectCount = 0, headers = null) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向次数过多'))
    let u
    try { u = new URL(url) } catch { return reject(new Error('URL 格式无效')) }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('仅支持 http/https'))
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get(url, {
      headers: { ...browserHeaders(redirectCount), 'Accept-Encoding': 'gzip, deflate', ...(headers || {}) }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        const next = new URL(res.headers.location, url).href
        return resolve(httpNodeGet(next, timeoutMs, redirectCount + 1))
      }
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > 2 * 1024 * 1024) { req.destroy(); reject(new Error('响应内容过大')) }
        else chunks.push(c)
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          headers: res.headers,
          buf: decompressBuf(Buffer.concat(chunks), res.headers['content-encoding'])
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('请求超时')) })
  })
}

// 统一入口：默认先走 Electron net（真浏览器指纹），NET_UNAVAILABLE（纯 Node/异常）降级原生实现。
// redirectCount>0 说明已进入兜底分支的重定向递归，不再反复尝试 net。
function httpGet(url, timeoutMs, redirectCount = 0, headers = null) {
  if (redirectCount > 0) return httpNodeGet(url, timeoutMs, redirectCount, headers)
  const merged = { ...browserHeaders(0), 'Accept-Encoding': 'gzip, deflate', ...(headers || {}) }
  return netGet(url, timeoutMs, merged).catch((err) => {
    if (err && err.message === 'NET_UNAVAILABLE') return httpNodeGet(url, timeoutMs, 0, headers)
    throw err
  })
}

function bufToText(buf, contentType) {
  const m = /charset=([\w-]+)/i.exec(contentType || '')
  if (m && !/utf-?8/i.test(m[1])) {
    try { return new TextDecoder(m[1].toLowerCase()).decode(buf) } catch {}
  }
  try { return new TextDecoder('utf-8').decode(buf) } catch { return buf.toString('utf8') }
}

// 可执行/脚本类扩展名：下载前必须经用户批准（防 AI 被网页诱导下木马）
const EXECUTABLE_EXTS = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'jar', 'apk', 'dll', 'reg',
  'chm', 'hta', 'msp', 'mst', 'gadget', 'lnk'
])

function pathExt(p) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(p))
  return m ? m[1].toLowerCase() : ''
}

// 从 URL 或 Content-Disposition 推断文件名
function fileNameFromDisposition(cd) {
  if (!cd) return ''
  const m1 = /filename\*=(?:UTF-8''|utf-8'')([^;]+)/.exec(cd)
  if (m1) { try { return decodeURIComponent(m1[1].trim().replace(/^"|"$/g, '')) } catch {} }
  const m2 = /filename="?([^";]+)"?/i.exec(cd)
  return m2 ? m2[1].trim() : ''
}

function fileNameFromUrl(u) {
  try {
    const p = new URL(u).pathname
    const base = decodeURIComponent(p.split('/').pop() || '').trim()
    if (base && /\.[A-Za-z0-9]{1,8}$/.test(base)) return base.replace(/[\\/:*?"<>|]/g, '_')
  } catch {}
  return ''
}

// 模型抠链接常把 markdown 反引号/引号/尖括号带进来，统一剥掉
function cleanUrl(u) {
  return String(u || '').trim().replace(/^[`'"<\s]+|[`'">\s,.]+$/g, '')
}

// 解析 markdown 表格文本（AI 直接丢 | a | b | 过来的场景）：返回 {headers, rows} 或 null
function parseMarkdownTable(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows = []
  for (const ln of lines) {
    if (!ln.includes('|')) continue
    if (/^[\s|:\-]+$/.test(ln)) continue // |---|---| 分隔行
    rows.push(ln.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
  }
  if (!rows.length || !rows[0].length) return null
  return { headers: rows[0], rows: rows.slice(1) }
}

// 从 HTML 提取图片/文件直链（绝对化、去重、过滤 favicon/logo 等杂图）——"浏览器另存为"看到的 src 就是这些
function extractPageLinks(html, baseUrl) {
  const out = []
  const push = (u) => {
    u = cleanUrl(u)
    if (!u || u.startsWith('data:') || u.startsWith('#') || u.startsWith('javascript:')) return
    try {
      const abs = new URL(u, baseUrl).href
      if (!/^https?:/.test(abs)) return
      if (!out.includes(abs)) out.push(abs)
    } catch {}
  }
  const tagRe = /<img\b[^>]*>/gi
  let m
  while ((m = tagRe.exec(html))) {
    const tag = m[0]
    const attr = (name) => {
      const x = new RegExp(`\\s${name}=["']([^"']+)["']`, 'i').exec(tag)
      return x ? x[1] : ''
    }
    push(attr('src'))
    push(attr('data-src'))
    push(attr('data-original'))
    push(attr('data-lazy-src'))
    const srcset = attr('srcset')
    if (srcset) push(srcset.split(',')[0].trim().split(/\s+/)[0])
  }
  const aRe = /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>/gi
  while ((m = aRe.exec(html))) {
    const h = m[1]
    if (/\.(png|jpe?g|webp|gif|bmp|svg|zip|rar|7z|exe|msi|pdf|docx?|xlsx?|pptx?|apk|mp4|mp3)(\?|#|$)/i.test(h)) push(h)
  }
  const filtered = out.filter((u) => !/(?:favicon|logo|icon\d?|avatar|emoji|spacer|blank\.|\b1x1\b)\.[a-z0-9]+(?:$|\?)/i.test(u))
  return (filtered.length ? filtered : out).slice(0, 50)
}

// JSON 请求（生图/视频 API 用）：返回解析后的 JSON 对象
function httpJson(method, url, apiKey, bodyStr, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(new Error('URL 无效')) }
    const mod = u.protocol === 'https:' ? https : http
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || ''}` }
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr)
    const req = mod.request({
      method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers, timeout: timeoutMs
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c; if (text.length > 1024 * 1024) res.destroy() })
      res.on('end', () => {
        try { resolve(JSON.parse(text)) } catch { reject(new Error(`HTTP ${res.statusCode} 响应非 JSON：${text.slice(0, 200)}`)) }
      })
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.on('error', reject)
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// 流式下载到文件（重定向≤5，2GB 上限，空闲60s/总时长30min 双超时，不控制 Content-Length 直接断）
// extraHeaders: 防盗链站点需要传 { Referer: '来源页面URL' }
// hooks: { onReq(req)=拿到底层请求用于取消, onProgress(received,total)=进度回调（total 未知时为0） }
function httpDownload(url, filePath, maxBytes = 2 * 1024 * 1024 * 1024, redirectCount = 0, extraHeaders = {}, hooks = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('重定向次数过多'))
    let u
    try { u = new URL(url) } catch { return reject(new Error('URL 格式无效')) }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('仅支持 http/https'))
    // 总时长上限：防慢速滴流服务器把下载挂死（idle 超时拦不住）；30 分钟足够 2GB 走完
    const deadline = setTimeout(() => {
      try { req.destroy() } catch {}
      reject(new Error('下载超时（总时长超过 30 分钟，已中止）'))
    }, 1800000)
    const settle = (fn, val) => {
      clearTimeout(deadline)
      fn(val)
    }
    const mod = u.protocol === 'https:' ? https : http
    let out = null
    let settled = false // promise 定局标志：成功/失败/重定向后，屏蔽后续错误处理（防误删已成功文件）
    const cleanupPartial = () => {
      try { if (out) out.destroy() } catch {}
      const doUnlink = () => { try { fs.unlinkSync(filePath) } catch {} }
      // Windows：句柄真正关闭（close 事件）后才能删；已销毁的直接删
      if (out && !out.destroyed) out.once('close', doUnlink)
      else doUnlink()
    }
    const bail = (err) => {
      const first = !settled
      settle(reject, err)
      if (first) cleanupPartial()
    }
    const req = mod.get(url, { headers: { ...browserHeaders(redirectCount), 'Accept': '*/*', ...extraHeaders } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        clearTimeout(deadline) // 重定向后重新计时
        settled = true // 本层定局：后续旧连接的错误不再触发清理
        return resolve(httpDownload(new URL(res.headers.location, url).href, filePath, maxBytes, redirectCount + 1, extraHeaders, hooks))
      }
      if (res.statusCode === 403) {
        res.resume()
        return settle(reject, new Error(`HTTP 403（服务器拒绝访问：可能有防盗链，试试带 referer 参数传图片来源页面；也可能链接需要登录）`))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return settle(reject, new Error(`HTTP ${res.statusCode}（链接可能已失效或需要登录）`))
      }
      const declared = parseInt(res.headers['content-length'] || '0', 10)
      if (declared > maxBytes) {
        res.resume()
        return settle(reject, new Error(`文件过大（${(declared / 1048576).toFixed(1)}MB），超过 2GB 上限`))
      }
      out = fs.createWriteStream(filePath)
      let received = 0
      res.on('data', (c) => {
        received += c.length
        if (received > maxBytes) { req.destroy(); bail(new Error('文件超过 2GB 上限，已中止并清理')) }
        if (hooks.onProgress) { try { hooks.onProgress(received, declared || 0) } catch {} }
      })
      res.on('error', bail)
      out.on('error', bail)
      out.on('finish', () => {
        settle(resolve, { contentType: res.headers['content-type'] || '', dispositionName: fileNameFromDisposition(res.headers['content-disposition']) })
      })
      res.pipe(out)
    })
    req.on('error', bail)
    if (hooks.onReq) { try { hooks.onReq(req) } catch {} }
    req.setTimeout(60000, () => { req.destroy(new Error('下载超时（60 秒无数据）')) })
  })
}

// word 内容统一化：paragraphs 数组（支持 {text,style} 对象、![alt](图片路径) 插图）优先，其次 content 字符串
function wordContentOf(args) {
  const paras = Array.isArray(args.paragraphs) && args.paragraphs.length
    ? args.paragraphs
    : String(args.content || '').split(/\r?\n/)
  const total = paras.reduce((n, p) => n + String(typeof p === 'object' ? (p && p.text) : p).length + 16, 0)
  if (total > 512 * 1024) return null
  return {
    title: args.title,
    paragraphs: paras,
    header: args.header ? String(args.header) : undefined,
    footer: args.footer ? String(args.footer) : undefined,
    pageNumbers: !!args.pageNumbers,
    toc: !!args.toc,
    fonts: args.fonts && typeof args.fonts === 'object' ? args.fonts : undefined,
    lineSpacing: args.lineSpacing != null ? Number(args.lineSpacing) : undefined,
    firstLine: !!args.firstLine,
    cover: args.cover && typeof args.cover === 'object' ? args.cover : undefined,
    theme: args.theme ? String(args.theme) : undefined
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function htmlToText(html, maxLen = 12000) {
  let s = String(html)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').replace(/^\s+|\s+$/g, '')
  if (s.length > maxLen) s = s.slice(0, maxLen) + `\n…（内容过长已截断）`
  return s
}

// Readability 正文提取（v2.4.93）：Firefox 阅读模式同款算法——定位主内容块，导航/页脚/侧栏/广告剔除，
// 治旧版"全页剥标签"把导航垃圾混进正文、垃圾占满 9000 字额度后真正文反被截断的顽疾。
// linkedom 提供轻量 DOM（Node 环境没有原生 DOMParser）；解析失败/正文太短返回 null，调用方回退 htmlToText。
let _readabilityMods = null
function extractArticleText(html, url, maxLen = 9000) {
  try {
    if (!_readabilityMods) {
      // 延迟加载：纯 Node 测试环境缺包时优雅降级，不炸主流程
      _readabilityMods = {
        parseHTML: require('linkedom').parseHTML,
        Readability: require('@mozilla/readability').Readability
      }
    }
    const doc = _readabilityMods.parseHTML(String(html || '')).document
    if (!doc || !doc.documentElement) return null
    let base = url
    try { base = new URL(url).href } catch {}
    const reader = new _readabilityMods.Readability(doc, { charThreshold: 200 })
    const article = reader.parse()
    const text = article && htmlToText(article.content || '', maxLen)
    // 正文太短（导航壳/懒加载站）不算成功，让调用方走旧逻辑兜底
    if (!text || text.length < 200) return null
    const title = String(article.title || '').trim()
    return title ? `【${title}】\n${text}` : text
  } catch { return null }
}

function createTools({ tcpAgent, snapshots, desktopDir, tmpDir, workspaceDir, getSetting, setSetting, log, onDownloadProgress, onWorkbenchOpen }) {
  log = log || (() => {})
  // 活跃下载任务：id -> { req, fileName }（进度条 UI + 用户取消的支撑）
  const activeDownloads = new Map()
  let lastProgressSent = 0
  const emitDownload = (info) => {
    try { if (onDownloadProgress) onDownloadProgress(info) } catch {}
  }
  const emitProgressThrottled = (info) => {
    const now = Date.now()
    if (now - lastProgressSent < 300) return
    lastProgressSent = now
    emitDownload(info)
  }

  // ===== 本地辅助 =====
  function localDrives() {
    const entries = []
    try {
      const dp = desktopDir
      if (dp && fs.existsSync(dp)) entries.push({ name: '桌面', path: dp, isDirectory: true })
    } catch {}
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (const ch of letters) {
      const p = ch + ':\\'
      try { fs.accessSync(p); entries.push({ name: p, path: p, isDirectory: true }) } catch {}
    }
    return entries
  }

  function isProtectedLocal(p) {
    if (!p || process.platform !== 'win32') return false
    const norm = path.normalize(String(p)).toLowerCase()
    if (!norm.startsWith('c:')) return false
    // AI 工作台豁免（助理的专属文件区，即使在 C 盘 userData 下也可读写）
    if (workspaceDir && norm.startsWith(path.normalize(workspaceDir).toLowerCase())) return false
    if (desktopDir && norm.startsWith(path.normalize(desktopDir).toLowerCase())) return false
    return true
  }

  // 保护区（C 盘非工作台/桌面）文档改稿：把原文件复制到工作台「改稿」区，在副本上改。
  // 工作流：原文件全程不动（对比参考+防改坏），副本免审批随便折腾，自检满意后再 copy_path 回原位。
  // 副本智能复用：副本比原文件新 = 上次改稿会话的延续，直接沿用（多轮修改不丢进度）；
  // 原文件更新 = 用户外部改过或上次已回写，重拷新起点。
  function draftPathOf(p) { return path.join(workspaceDir, '改稿', path.basename(p)) }
  function protectedDraftTarget(p) { try { return !!(isProtectedLocal(p) && fs.existsSync(p)) } catch { return false } }
  function protectedDraftCopy(p) {
    try {
      if (!protectedDraftTarget(p)) return null
      const draftPath = draftPathOf(p)
      fs.mkdirSync(path.dirname(draftPath), { recursive: true })
      if (fs.existsSync(draftPath) && fs.statSync(draftPath).mtimeMs >= fs.statSync(p).mtimeMs) return draftPath
      fs.copyFileSync(p, draftPath)
      return draftPath
    } catch { return null }
  }

  // 防自包含：目标与源相同，或目标在源目录内部（复制/移动会导致无限递归）
  function selfContainError(src, destPath) {
    const norm = (x) => path.normalize(String(x)).toLowerCase().replace(/[\\/]+$/, '')
    const s = norm(src)
    const d = norm(destPath)
    if (s === d) return '源和目标是同一位置，无需操作'
    if (d.startsWith(s + path.sep)) return '不能把文件夹移动/复制到它自己的内部（会无限嵌套）'
    return null
  }

  function copyRecursive(src, dest) {
    let count = 0
    const walk = (s, d) => {
      if (++count > 20000) throw new Error('文件数量超过上限（20000），已中止')
      const st = fs.statSync(s)
      if (st.isDirectory()) {
        fs.mkdirSync(d, { recursive: true })
        for (const e of fs.readdirSync(s, { withFileTypes: true })) {
          walk(path.join(s, e.name), path.join(d, e.name))
        }
      } else {
        fs.mkdirSync(path.dirname(d), { recursive: true })
        fs.copyFileSync(s, d)
      }
    }
    walk(src, dest)
  }

  function formatEntries(entries, max = 200) {
    if (!entries.length) return '（空目录）'
    const shown = entries.slice(0, max)
    const lines = shown.map((e) => {
      const tag = e.isDirectory ? '[目录]' : fmtSize(e.size || 0)
      // root 快捷入口（如"桌面"）自带真实完整路径：必须展示出来——真机实锤网页模型会把
      // 显示名"桌面"当 dest_dir 传给 transfer_file，对方写盘崩进程。喂了真实路径模型就不会传错
      return e.path ? `${e.name}  ${tag}  完整路径: ${e.path}` : `${e.name}  ${tag}`
    })
    if (entries.length > max) lines.push(`...共 ${entries.length} 项，仅显示前 ${max} 项`)
    return lines.join('\n')
  }

  // ===== 远程辅助 =====
  function resolveDevice(target) {
    const list = tcpAgent.getConnectedDevices ? tcpAgent.getConnectedDevices() : []
    if (!target || target === 'local') return null // null = 本机
    const key = String(target).trim().toLowerCase()
    // 1) 精确匹配：deviceId / 设备名 / 主机名
    const dev = list.find((d) => d.deviceId.toLowerCase() === key || String(d.name).toLowerCase() === key || String(d.hostname).toLowerCase() === key)
    if (dev) return dev
    if (key.length < 2) return { _notFound: true, available: list } // 太短的词不做模糊，防误匹配
    // 2) 模糊匹配（真机场景：用户用昵称"顾夕"指代设备「顾夕杀杀杀」，或 deviceId 被截断）：
    //    互相包含即候选；唯一命中才采用，多个命中报歧义（传输目标必须无歧义）
    const hits = list.filter((d) => {
      const name = String(d.name).toLowerCase()
      const host = String(d.hostname || '').toLowerCase()
      const id = String(d.deviceId).toLowerCase()
      if (!name) return false
      return (name.includes(key) || key.includes(name)) ||
        (host.length >= 2 && (host.includes(key) || key.includes(host))) ||
        (id.includes(key) || key.includes(id))
    })
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return { _notFound: true, _ambiguous: hits, available: list }
    return { _notFound: true, available: list }
  }

  // 设备未找到的统一报错：带可用设备清单（含 deviceId），歧义时点名多台候选
  function deviceNotFoundMsg(dev) {
    const avail = (dev.available || []).map((d) => `「${d.name}」(deviceId: ${d.deviceId})`).join('、') || '无'
    if (dev._ambiguous && dev._ambiguous.length) {
      return `目标匹配到多台设备：${dev._ambiguous.map((d) => `「${d.name}」`).join('、')}——请用完整设备名或完整 deviceId 指定。当前可用设备：${avail}`
    }
    return `设备不存在或未连接。当前可用设备：${avail}（用户常用昵称指代设备，如"顾夕"→「顾夕杀杀杀」，用名称的一部分即可，唯一匹配会自动解析）`
  }

  // ===== v2.5.73：旧版 .doc（OLE2 二进制）全链路兼容 =====
  // COM 转换 .doc → .docx（WPS 优先、Word 兜底）。asar 内 ps1 不能直接执行——copyFileSync 到 tmpDir 再跑（同 pdf2png 模式）
  // v2.5.75：转换结果缓存复用——COM busy 是间歇性的（同一文件这次成功下次可能炸），
  // 成功一次的副本按 src 路径 md5 命名躺在 tmpDir，后续调用直接复用不再碰 COM（src 更新会因 mtime 失效重转）
  const docConvInflight = new Map() // 同一 src 并发转换防竞态：第二个调用等第一个的结果
  async function docToDocx(srcPath) {
    // v2.5.75 根因修复：WPS COM 对正斜杠路径挂死（"Word 未能引发事件"/超时的真凶）——
    // AI 传路径常带 C:/xxx 正斜杠，必须 path.resolve 规范化为反斜杠绝对路径再交给 COM
    srcPath = path.resolve(srcPath)
    const tag = crypto.createHash('md5').update(srcPath).digest('hex').slice(0, 6)
    const dst = path.join(tmpDir, `${path.basename(srcPath).replace(/\.doc$/i, '')}.${tag}.docx`)
    try {
      const st = fs.statSync(dst)
      if (st.size > 1000 && st.mtimeMs >= fs.statSync(srcPath).mtimeMs) return dst
    } catch { }
    if (docConvInflight.has(srcPath)) return docConvInflight.get(srcPath)
    const job = (async () => {
      const { execFile } = require('child_process')
      const ps1 = path.join(tmpDir, 'doc2docx.ps1')
      fs.copyFileSync(path.join(__dirname, 'doc2docx.ps1'), ps1)
      await new Promise((resolve, reject) => {
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Src', srcPath, '-Dst', dst], { timeout: 120000, windowsHide: true, encoding: 'utf8' }, (err, so, se) => {
          if (err) {
            const out = String((so || '') + (se || '') + (err.message || '')).slice(-260)
            if (/NO_COM_ENGINE/.test(out)) return reject(new Error('本机没有可用的转换引擎（需要安装 WPS 或 MS Word）'))
            if (/CONVERT_FAIL/.test(out)) return reject(new Error(`COM 转换失败（重试 3 引擎×2 轮均未成功：${out.replace(/^[\s\S]*?CONVERT_FAIL/, '').trim()}）。常见原因：WPS/Word 正忙（如正在打开其他文档）——关闭 WPS/Word 窗口后重试即可`))
            return reject(new Error(`COM 转换失败: ${out}`))
          }
          resolve(dst)
        })
      })
      return dst
    })()
    docConvInflight.set(srcPath, job)
    try { return await job } finally { docConvInflight.delete(srcPath) }
  }
  // 读链路透明兜底：旧版 .doc 自动转可编辑 .docx 副本（原件不动），返回 { path, converted }
  async function ensureReadableDocx(p) {
    if (!isLegacyDoc(p)) return { path: p, converted: false }
    const out = await docToDocx(p)
    return { path: out, converted: true }
  }
  const DOC_CONV_NOTE = '（旧版 .doc 已自动转换为可编辑副本——要修改/排版请操作这个副本路径，原文件保持不动）'
  // 写链路守卫：写目标必须是真 .docx（.doc 原地修改明确报引导）
  function legacyDocWriteBlock(p) {
    return isLegacyDoc(p)
      ? '这是旧版 .doc 二进制格式，暂不支持原地修改。推荐流程：先 read_word 读它（会自动生成可编辑的 .docx 副本并返回路径），之后的修改/排版都针对副本进行；或用 WPS/Word 另存为 .docx 后重试'
      : null
  }

  // ===== 分类（决定是否需要审批）=====
  // 返回 { destructive, note, paths: [本地绝对路径] }
  async function classify(name, args) {
    const target = args.target || 'local'
    if (name === 'open_path') {
      // 可执行/脚本类：打开等于运行 → 无论何种审批模式都强制弹审批（用户就是白名单）
      const isExec = EXECUTABLE_EXTS.has(pathExt(args.path || ''))
      return isExec
        ? { destructive: true, forceApproval: true, note: `打开可执行/脚本类文件 ${args.path}（打开等于运行，请确认来源可信）`, paths: [] }
        : { destructive: false, note: '', paths: [] }
    }
    if (name === 'delete_path') {
      return { destructive: true, note: '删除操作（已自动备份到快照槽）', paths: target === 'local' ? [args.path] : [] }
    }
    if (name === 'write_file') {
      const exists = await targetExists(args.path, target)
      return {
        destructive: exists,
        note: exists ? `覆盖已有文件 ${args.path}（原文件会先备份）` : '新建文件',
        paths: target === 'local' ? [args.path] : []
      }
    }
    if (name === 'move_path') return { destructive: true, note: '移动操作', paths: target === 'local' ? [args.src] : [] }
    if (name === 'rename_path') return { destructive: true, note: '重命名操作', paths: target === 'local' ? [args.path] : [] }
    if (name === 'copy_path') {
      const destExists = await targetExists(args.dest_dir ? path.join(args.dest_dir, path.basename(args.src || '')) : '', target)
      return { destructive: destExists, note: destExists ? '目标存在同名文件，将被覆盖' : '复制操作', paths: [] }
    }
    if (name === 'create_word') {
      const exists = await targetExists(args.path, target)
      return {
        destructive: exists,
        note: exists ? `覆盖已有 Word 文档 ${args.path}（原文件会先备份）` : '新建 Word 文档',
        paths: target === 'local' ? [args.path] : []
      }
    }
    if (name === 'render_html') {
      const outP = args.out ? path.resolve(String(args.out)) : path.resolve(String(args.path)).replace(/\.html?$/i, '.png')
      const outExists = fs.existsSync(outP)
      return { destructive: outExists, note: outExists ? `覆盖已有图片 ${outP}` : '渲染新图片', paths: [] }
    }
    if (name === 'create_pptx') {
      const exists = await targetExists(args.path, target)
      return {
        destructive: exists,
        note: exists ? `覆盖已有 PPT 演示文稿 ${args.path}（原文件会先备份）` : '新建 PPT 演示文稿',
        paths: target === 'local' ? [args.path] : []
      }
    }
    if (name === 'edit_pptx') {
      const exists = await targetExists(args.path, target)
      return {
        destructive: exists,
        note: exists ? `修改已有 PPT ${args.path}（原文件会先备份）` : '目标文件不存在',
        paths: target === 'local' ? [args.path] : []
      }
    }
    if (name === 'remove_bg') {
      const outP = args.out ? path.resolve(String(args.out)) : String(args.path || '').replace(/\.[^.]+$/, '') + '-抠图.png'
      const exists = outP && fs.existsSync(outP)
      return { destructive: exists, note: exists ? `覆盖已有抠图 ${outP}` : '生成透明底抠图（新文件）', paths: [outP] }
    }
    if (name === 'modify_word' || name === 'append_table_rows' || name === 'modify_table' || name === 'format_table') {
      const exists = await targetExists(args.path, target)
      // C 盘保护区目标（仅 modify_word 已实现自动转工作台改稿副本）：审批按副本路径算——不再弹保护区审批
      const draftMode = name === 'modify_word' && target === 'local' && exists && protectedDraftTarget(args.path)
      const effPath = draftMode ? draftPathOf(args.path) : args.path
      return {
        destructive: exists,
        note: draftMode
          ? `修改 C 盘文档：自动转工作台改稿副本（${effPath}），原文件不动留作对比`
          : (exists ? `修改已有文件 ${args.path}（原文件会先备份）` : '目标文件不存在'),
        paths: target === 'local' ? [effPath] : []
      }
    }
    if (name === 'create_table') {
      const exists = await targetExists(args.path, target)
      return {
        destructive: exists,
        note: exists ? `覆盖已有表格 ${args.path}（原文件会先备份）` : '新建 Excel 表格',
        paths: target === 'local' ? [args.path] : []
      }
    }
    if (name === 'download_file') {
      const urlName = fileNameFromUrl(args.url || '')
      const sp = String(args.save_path || '')
      let isDir = false
      try { isDir = fs.statSync(sp).isDirectory() } catch {}
      const outPath = isDir || /[\\/]$/.test(sp) ? path.join(sp, urlName || 'download.bin') : sp
      const isExec = EXECUTABLE_EXTS.has(pathExt(outPath))
      let exists = false
      try { exists = fs.existsSync(outPath) } catch {}
      const notes = []
      if (isExec) notes.push(`下载可执行文件 ${path.basename(outPath)}，请确认来源可信`)
      if (exists) notes.push(`覆盖已有文件 ${outPath}（原文件会先备份）`)
      return { destructive: isExec || exists, note: notes.join('；'), paths: exists ? [outPath] : [] }
    }
    return { destructive: false, note: '', paths: [] }
  }

  async function targetExists(p, target) {
    try {
      if (!p) return false
      if (!target || target === 'local') return fs.existsSync(p)
      const dev = resolveDevice(target)
      if (!dev || dev._notFound) return false
      const parent = path.dirname(p)
      const res = await tcpAgent.listRemoteDirectory(dev.deviceId, parent)
      if (!res || !res.success) return false
      return res.entries.some((e) => e.name === path.basename(p))
    } catch {
      return false
    }
  }

  // ===== 工具实现 =====
  // 所有改动型操作成功后返回 undo 撤销记录，供检查点回滚
  const impl = {
    async list_dir(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        const p = args.path || 'root'
        if (p === 'root' || p === 'This PC') return { ok: true, message: '本机盘符（桌面路径见"桌面"项）：\n' + formatEntries(localDrives()) }
        try {
          const entries = fs.readdirSync(p, { withFileTypes: true }).map((e) => {
            const full = path.join(p, e.name)
            let size = 0
            try { if (e.isFile()) size = fs.statSync(full).size } catch {}
            return { name: e.name, isDirectory: e.isDirectory(), size }
          })
          return { ok: true, message: `${p}：\n` + formatEntries(entries) }
        } catch (err) {
          return { ok: false, message: `列出目录失败: ${err.message}` }
        }
      }
      const res = await tcpAgent.listRemoteDirectory(dev.deviceId, args.path || 'root')
      if (!res || !res.success) return { ok: false, message: `列出远程目录失败: ${(res && res.error) || '未知错误'}` }
      return { ok: true, message: `${dev.name} 的 ${res.path || args.path || 'root'}：\n` + formatEntries(res.entries || []) }
    },

    async read_file(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const offset = Math.max(0, parseInt(args.offset, 10) || 0)

      // 二进制检测：只看文件头 4096 字节是否含 \0
      const headHasZero = (fd) => {
        const head = Buffer.alloc(4096)
        const n = fs.readSync(fd, head, 0, head.length, 0)
        return head.slice(0, n).includes(0)
      }
      // 从 fd 的 [offset, offset+64KB) 段拼装分段读取结果
      const readSegment = (fd) => {
        const st = fs.fstatSync(fd)
        if (offset > st.size) return { ok: false, message: `offset 超出文件大小（${st.size} 字节）` }
        if (offset === 0 && headHasZero(fd)) return { ok: false, message: '疑似二进制文件，拒绝读取' }
        const len = Math.min(READ_LIMIT, st.size - offset)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, offset)
        const start = offset
        const end = offset + len
        if (st.size <= READ_LIMIT && offset === 0) return { ok: true, message: buf.toString('utf8') }
        const head = offset === 0 ? `（大文件共 ${fmtSize(st.size)}，以下为第 ${start}-${end} 字节）\n` : `（第 ${start}-${end} 字节 / 共 ${st.size} 字节）\n`
        const tail = end < st.size ? `\n（内容未完，续读传 offset: ${end}）` : `\n（已到文件末尾）`
        return { ok: true, message: head + buf.toString('utf8') + tail }
      }

      if (!dev) {
        let fd = null
        try {
          fd = fs.openSync(args.path, 'r')
          const st = fs.fstatSync(fd)
          if (st.isDirectory()) return { ok: false, message: '这是文件夹，请用 list_dir' }
          return readSegment(fd)
        } catch (err) {
          return { ok: false, message: `读取失败: ${err.message}` }
        } finally {
          try { if (fd !== null) fs.closeSync(fd) } catch {}
        }
      }
      const temp = path.join(tmpDir, `ai_read_${Date.now()}_${path.basename(args.path)}`)
      let fd = null
      try {
        const r = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!r || !r.success) return { ok: false, message: `下载远程文件失败: ${(r && r.error) || '未知错误'}` }
        fd = fs.openSync(temp, 'r')
        return readSegment(fd)
      } catch (err) {
        return { ok: false, message: `读取失败: ${err.message}` }
      } finally {
        try { if (fd !== null) fs.closeSync(fd) } catch {}
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async write_file(args) {
      if (typeof args.content !== 'string') return { ok: false, message: 'content 必须是文本内容' }
      if (args.content.length > 1024 * 1024) return { ok: false, message: '内容超过 1MB，请拆分' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (isProtectedLocal(args.path)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
          const existed = fs.existsSync(args.path)
          let snapId = null
          if (existed) {
            const snap = snapshots.backupLocal(args.path)
            if (!snap.ok) return { ok: false, message: `已取消写入：原文件备份失败（${snap.reason}）` }
            snapId = snap.id
          }
          fs.mkdirSync(path.dirname(args.path), { recursive: true })
          fs.writeFileSync(args.path, args.content, 'utf8')
          return {
            ok: true,
            message: `已${existed ? '覆盖' : '创建'} ${args.path}（${fmtSize(Buffer.byteLength(args.content))}）`,
            undo: existed
              ? { type: 'restore_snap', snapId }
              : { type: 'delete_local', path: args.path }
          }
        } catch (err) {
          return { ok: false, message: `写入失败: ${err.message}` }
        }
      }
      // 远程写入：先快照已有文件 → 临时文件 → 上传覆盖
      const parent = path.dirname(args.path)
      const base = path.basename(args.path)
      try {
        const existed = await targetExists(args.path, args.target)
        let snapId = null
        if (existed) {
          snapId = genId('snap_')
          const savePath = path.join(snapshots.snapshotDir(snapId), 'data', base)
          fs.mkdirSync(path.dirname(savePath), { recursive: true })
          const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, savePath, null, true)
          const ok = !!(dl && dl.success)
          snapshots.register(snapId, {
            id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
            deviceId: dev.deviceId, isDirectory: false,
            size: ok ? fs.statSync(savePath).size : 0,
            ok, reason: ok ? '' : '远程原文件备份失败'
          })
          if (!ok) return { ok: false, message: '已取消写入：远程原文件备份失败' }
        }
        const temp = path.join(tmpDir, `ai_write_${Date.now()}_${base}`)
        fs.writeFileSync(temp, args.content, 'utf8')
        try {
          const up = await tcpAgent.uploadFile(dev.deviceId, temp, parent, true, null, base)
          if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
          return {
            ok: true,
            message: `已${existed ? '覆盖' : '创建'} ${dev.name} 的 ${args.path}`,
            undo: existed
              ? { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
              : { type: 'delete_remote', deviceId: dev.deviceId, path: args.path }
          }
        } finally {
          try { fs.unlinkSync(temp) } catch {}
        }
      } catch (err) {
        return { ok: false, message: `远程写入失败: ${err.message}` }
      }
    },

    async create_folder(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (isProtectedLocal(args.path)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
          const existed = fs.existsSync(args.path)
          fs.mkdirSync(args.path, { recursive: true })
          return {
            ok: true,
            message: existed ? `文件夹已存在 ${args.path}` : `已创建文件夹 ${args.path}`,
            undo: existed ? null : { type: 'delete_local', path: args.path, isDir: true }
          }
        } catch (err) {
          return { ok: false, message: `创建失败: ${err.message}` }
        }
      }
      // 远程 mkdir 不支持多级，逐级创建
      let cur = ''
      const norm = String(args.path).replace(/\//g, '\\')
      const parts = norm.split('\\').filter(Boolean)
      if (/^[a-zA-Z]:/.test(norm)) cur = parts.shift() + '\\'
      for (const part of parts) {
        cur = cur ? path.join(cur, part) : part
        const res = await tcpAgent.createRemoteFolder(dev.deviceId, cur)
        if (!res || !res.success) {
          const already = await targetExists(cur, args.target)
          if (!already) return { ok: false, message: `创建失败于 ${cur}: ${(res && res.error) || '未知错误'}` }
        }
      }
      return {
        ok: true,
        message: `已在 ${dev.name} 创建文件夹 ${args.path}`,
        undo: { type: 'delete_remote', deviceId: dev.deviceId, path: args.path, isDir: true }
      }
    },

    async copy_path(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const srcs = Array.isArray(args.src) ? args.src : [args.src]
      if (!srcs.length || srcs.filter(Boolean).length !== srcs.length) return { ok: false, message: 'src 为空或含空值' }
      if (!args.dest_dir) return { ok: false, message: '缺少 dest_dir' }
      if (!dev) {
        const results = []
        let done = 0
        try {
          for (const s of srcs) {
            const dest = path.join(args.dest_dir, path.basename(s))
            const bad = selfContainError(s, dest)
            if (bad) { results.push(`跳过 ${s}：${bad}`); continue }
            if (isProtectedLocal(dest)) return { ok: false, message: `拒绝：目标在 C 盘保护区（${dest}）` }
            copyRecursive(s, dest)
            results.push(`已复制 ${path.basename(s)}`)
            done++
          }
          return { ok: done > 0, message: done > 0 ? `已复制 ${done}/${srcs.length} 项 → ${args.dest_dir}\n${results.join('\n')}` : `全部跳过：\n${results.join('\n')}`, undo: null }
        } catch (err) {
          return { ok: false, message: `复制失败: ${err.message}` }
        }
      }
      const results = []
      let done = 0
      let lastUndo = null
      for (const s of srcs) {
        const dest = path.join(args.dest_dir, path.basename(s))
        const bad = selfContainError(s, dest)
        if (bad) { results.push(`跳过 ${path.basename(s)}：${bad}`); continue }
        const res = await tcpAgent.copyRemoteFile(dev.deviceId, s, args.dest_dir)
        if (!res || !res.success) {
          const errText = (res && res.error) || '未知错误'
          // 高频误用纠正：copy_path 只操作目标设备自己的文件，本机→远程必须用 transfer_file
          const hint = /ENOENT|no such file/i.test(errText)
            ? `（copy_path 只能复制 ${dev.name} 自己的文件；若源在本机，跨设备请改用 transfer_file 并指定 dest_target）`
            : ''
          results.push(`失败 ${path.basename(s)}: ${errText}${hint}`)
          continue
        }
        results.push(`已复制 ${path.basename(s)}`)
        done++
        lastUndo = { type: 'delete_remote', deviceId: dev.deviceId, path: dest }
      }
      return { ok: done > 0, message: done > 0 ? `已在 ${dev.name} 复制 ${done}/${srcs.length} 项 → ${args.dest_dir}\n${results.join('\n')}` : `全部失败：\n${results.join('\n')}`, undo: lastUndo }
    },

    // 跨设备复制：远程→本机 / 本机→远程 / 远程→远程 / 同设备自动降级为 copy_path
    async transfer_file(args) {
      if (!args.src_path || !args.dest_dir) return { ok: false, message: '缺少 src_path 或 dest_dir' }
      const srcDev = (args.src_target && args.src_target !== 'local') ? resolveDevice(args.src_target) : null
      if (args.src_target && args.src_target !== 'local' && (!srcDev || srcDev._notFound)) return { ok: false, message: `源设备不存在或未连接：${args.src_target}` }
      const dstDev = (args.dest_target && args.dest_target !== 'local') ? resolveDevice(args.dest_target) : null
      if (args.dest_target && args.dest_target !== 'local' && (!dstDev || dstDev._notFound)) return { ok: false, message: `目标设备不存在或未连接：${args.dest_target}` }
      // dest_dir 必须是目标电脑上的完整磁盘路径：真机实锤——网页模型会照抄 list_dir 结果里的
      // 显示名"桌面"当 dest_dir 传过去，对方 path.join("桌面", 文件名) = 相对路径 → 写盘目录
      // 不存在 → 接收端 writeStream ENOENT 无 error 监听 → 对方主进程 uncaughtException 闪退
      //（本地这边还显示"跨设备复制成功"）。报错引导模型用 list_dir 探真实路径后自动重试
      const cleanDir = String(args.dest_dir).replace(/[`"']/g, '').trim()
      if (cleanDir !== args.dest_dir) args.dest_dir = cleanDir
      if ((dstDev || srcDev) && !path.isAbsolute(args.dest_dir)) {
        return { ok: false, message: `dest_dir "${args.dest_dir}" 不是完整路径（"桌面"这类是列表显示名，不是磁盘路径）。请先 list_dir(path:"C:\\\\", target:设备) 找到目标目录的真实完整路径（如 C:\\\\Users\\\\<用户名>\\\\Desktop）再传` }
      }
      const fileName = path.basename(args.src_path)
      const destPath = path.join(args.dest_dir, fileName)
      const sameDevice = srcDev === dstDev || (srcDev && dstDev && srcDev.deviceId === dstDev.deviceId)

      // 同设备：降级为设备内复制
      if (sameDevice) {
        if (!srcDev) {
          try {
            if (isProtectedLocal(destPath)) return { ok: false, message: '拒绝：目标在 C 盘保护区' }
            copyRecursive(args.src_path, destPath)
            return { ok: true, message: `已复制 ${args.src_path} → ${destPath}`, undo: { type: 'delete_local', path: destPath } }
          } catch (err) {
            return { ok: false, message: `复制失败: ${err.message}` }
          }
        }
        const res = await tcpAgent.copyRemoteFile(srcDev.deviceId, args.src_path, args.dest_dir)
        if (!res || !res.success) return { ok: false, message: `远程复制失败: ${(res && res.error) || '未知错误'}` }
        return { ok: true, message: `已在 ${srcDev.name} 复制 ${args.src_path} → ${args.dest_dir}${oldPeerNote(srcDev)}`, undo: { type: 'delete_remote', deviceId: srcDev.deviceId, path: destPath } }
      }

      // 远程 → 本机
      if (srcDev && !dstDev) {
        try {
          if (isProtectedLocal(destPath)) return { ok: false, message: '拒绝：目标在 C 盘保护区' }
          if (!fs.existsSync(args.dest_dir)) fs.mkdirSync(args.dest_dir, { recursive: true })
          let undo
          if (fs.existsSync(destPath)) {
            const snap = snapshots.backupLocal(destPath)
            if (!snap.ok) return { ok: false, message: `目标文件已存在且备份失败（${snap.reason}），已取消传输` }
            undo = { type: 'restore_snap', snapId: snap.id }
          } else {
            undo = { type: 'delete_local', path: destPath }
          }
          const r = await tcpAgent.downloadFile(srcDev.deviceId, args.src_path, destPath, null, true)
          if (!r || !r.success) return { ok: false, message: `从 ${srcDev.name} 下载失败: ${(r && r.error) || '未知错误'}` }
          return { ok: true, message: `已把 ${srcDev.name} 的 ${args.src_path} 复制到本机 ${destPath}（${fmtSize(fs.statSync(destPath).size)}）${oldPeerNote(srcDev)}`, undo }
        } catch (err) {
          return { ok: false, message: `跨设备复制失败: ${err.message}` }
        }
      }

      // 本机 → 远程
      if (!srcDev && dstDev) {
        try {
          if (!fs.existsSync(args.src_path)) return { ok: false, message: `源文件不存在：${args.src_path}` }
          if (!fs.statSync(args.src_path).isFile()) return { ok: false, message: 'transfer_file 只支持单个文件，整个文件夹请在互联面板拖拽传输' }
          const up = await tcpAgent.uploadFile(dstDev.deviceId, args.src_path, args.dest_dir, true)
          if (!up || !up.success) return { ok: false, message: `上传到 ${dstDev.name} 失败: ${(up && up.error) || '未知错误'}` }
          return { ok: true, message: `已把本机 ${args.src_path} 复制到 ${dstDev.name} 的 ${destPath}${fs.existsSync(destPath) ? '（若已有同名文件则已被覆盖）' : ''}${oldPeerNote(dstDev)}`, undo: null }
        } catch (err) {
          return { ok: false, message: `跨设备复制失败: ${err.message}` }
        }
      }

      // 远程 → 远程：中转（下载到本机临时区再上传）
      const temp = path.join(tmpDir, `ai_xfer_${Date.now()}_${fileName}`)
      try {
        const dl = await tcpAgent.downloadFile(srcDev.deviceId, args.src_path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `从 ${srcDev.name} 下载失败: ${(dl && dl.error) || '未知错误'}` }
        const up = await tcpAgent.uploadFile(dstDev.deviceId, temp, args.dest_dir, true, null, fileName)
        if (!up || !up.success) return { ok: false, message: `上传到 ${dstDev.name} 失败: ${(up && up.error) || '未知错误'}` }
        return { ok: true, message: `已把 ${srcDev.name} 的 ${args.src_path} 复制到 ${dstDev.name} 的 ${destPath}${oldPeerNote(dstDev)}`, undo: null }
      } catch (err) {
        return { ok: false, message: `跨设备复制失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async move_path(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const srcs = Array.isArray(args.src) ? args.src : [args.src]
      if (!srcs.length || srcs.filter(Boolean).length !== srcs.length) return { ok: false, message: 'src 为空或含空值' }
      if (!args.dest_dir) return { ok: false, message: '缺少 dest_dir' }
      if (!dev) {
        const results = []
        let done = 0
        for (const s of srcs) {
          const dest = path.join(args.dest_dir, path.basename(s))
          const bad = selfContainError(s, dest)
          if (bad) { results.push(`跳过 ${path.basename(s)}：${bad}`); continue }
          if (isProtectedLocal(dest)) return { ok: false, message: `拒绝：目标在 C 盘保护区（${dest}）` }
          try {
            try {
              fs.renameSync(s, dest)
            } catch {
              // 跨盘移动：复制后删除
              copyRecursive(s, dest)
              fs.rmSync(s, { recursive: true, force: true })
            }
            results.push(`已移动 ${path.basename(s)}`)
            done++
          } catch (err) {
            results.push(`失败 ${path.basename(s)}: ${err.message}`)
          }
        }
        return { ok: done > 0, message: done > 0 ? `已移动 ${done}/${srcs.length} 项 → ${args.dest_dir}\n${results.join('\n')}` : `全部跳过：\n${results.join('\n')}`, undo: null }
      }
      const results = []
      let done = 0
      let lastUndo = null
      for (const s of srcs) {
        const dest = path.join(args.dest_dir, path.basename(s))
        const bad = selfContainError(s, dest)
        if (bad) { results.push(`跳过 ${path.basename(s)}：${bad}`); continue }
        const res = await tcpAgent.moveRemoteFile(dev.deviceId, s, args.dest_dir)
        if (!res || !res.success) {
          const errText = (res && res.error) || '未知错误'
          const hint = /ENOENT|no such file/i.test(errText)
            ? `（move_path 只能移动 ${dev.name} 自己的文件；若源在本机，跨设备请改用 transfer_file，移动=先 transfer 再删源）`
            : ''
          results.push(`失败 ${path.basename(s)}: ${errText}${hint}`)
          continue
        }
        results.push(`已移动 ${path.basename(s)}`)
        done++
        lastUndo = { type: 'move_back', src: dest, dest: args.dest_dir, deviceId: dev.deviceId }
      }
      return { ok: done > 0, message: done > 0 ? `已在 ${dev.name} 移动 ${done}/${srcs.length} 项 → ${args.dest_dir}\n${results.join('\n')}` : `全部失败：\n${results.join('\n')}`, undo: lastUndo }
    },

    async rename_path(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (args.new_name && /[\\/:*?"<>|]/.test(args.new_name)) return { ok: false, message: '新名称不能包含 \\ / : * ? " < > |' }
      const oldPath = args.path
      if (!dev) {
        try {
          const newPath = path.join(path.dirname(oldPath), args.new_name)
          if (isProtectedLocal(newPath)) return { ok: false, message: '拒绝：目标在 C 盘保护区' }
          fs.renameSync(oldPath, newPath)
          return { ok: true, message: `已重命名 ${oldPath} → ${args.new_name}`, undo: { type: 'rename_back', newPath, oldPath, deviceId: null } }
        } catch (err) {
          return { ok: false, message: `重命名失败: ${err.message}` }
        }
      }
      const res = await tcpAgent.renameRemoteFile(dev.deviceId, oldPath, args.new_name)
      if (!res || !res.success) return { ok: false, message: `远程重命名失败: ${(res && res.error) || '未知错误'}` }
      const newPath = path.join(path.dirname(oldPath), args.new_name)
      return {
        ok: true,
        message: `已在 ${dev.name} 重命名 ${oldPath} → ${args.new_name}`,
        undo: { type: 'rename_back', newPath, oldPath, deviceId: dev.deviceId }
      }
    },

    async delete_path(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          const st = fs.statSync(args.path)
          if (isProtectedLocal(args.path)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
          const snap = snapshots.backupLocal(args.path)
          if (!snap.ok) return { ok: false, message: `已取消删除：快照备份失败（${snap.reason}）。可让用户手动批准后重试` }
          fs.rmSync(args.path, { recursive: true, force: true })
          return {
            ok: true,
            message: `已删除 ${args.path}（快照 ${snap.id} 可还原）`,
            undo: { type: 'restore_snap', snapId: snap.id }
          }
        } catch (err) {
          return { ok: false, message: `删除失败: ${err.message}` }
        }
      }
      // 远程删除：文件先备份，文件夹跳过备份
      let snapNote = ''
      try {
        const parent = path.dirname(args.path)
        const resList = await tcpAgent.listRemoteDirectory(dev.deviceId, parent)
        const entry = resList && resList.success ? (resList.entries || []).find((e) => e.name === path.basename(args.path)) : null
        let snapId = null
        if (entry && !entry.isDirectory) {
          snapId = genId('snap_')
          const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
          fs.mkdirSync(path.dirname(savePath), { recursive: true })
          const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, savePath, null, true)
          const ok = !!(dl && dl.success)
          snapshots.register(snapId, {
            id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
            deviceId: dev.deviceId, isDirectory: false,
            size: ok ? fs.statSync(savePath).size : 0, ok,
            reason: ok ? '' : '远程原文件备份失败'
          })
          if (!ok) return { ok: false, message: '已取消删除：远程原文件备份失败，可让用户手动批准后重试' }
          snapNote = `（快照 ${snapId} 可还原）`
        } else {
          snapNote = '（远程文件夹未备份，无法撤销）'
        }
        const res = await tcpAgent.deleteRemoteFile(dev.deviceId, args.path)
        if (!res || !res.success) return { ok: false, message: `远程删除失败: ${(res && res.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已删除 ${dev.name} 的 ${args.path}${snapNote}`,
          undo: snapId ? { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path } : null
        }
      } catch (err) {
        return { ok: false, message: `远程删除失败: ${err.message}` }
      }
    },

    async search_files(args) {
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const kw = String(args.keyword || '').toLowerCase()
      if (!kw) return { ok: false, message: 'keyword 不能为空' }
      if (!dev) {
        const hits = []
        let scanned = 0
        const walk = (p, depth) => {
          if (depth > SEARCH_MAX_DEPTH || hits.length >= SEARCH_MAX_RESULTS || scanned > SEARCH_MAX_SCAN) return
          let entries
          try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch { return }
          for (const e of entries) {
            scanned++
            if (scanned > SEARCH_MAX_SCAN || hits.length >= SEARCH_MAX_RESULTS) return
            const full = path.join(p, e.name)
            if (e.name.toLowerCase().includes(kw)) hits.push(full + (e.isDirectory() ? '  [目录]' : ''))
            if (e.isDirectory()) walk(full, depth + 1)
          }
        }
        walk(args.dir, 0)
        return { ok: true, message: hits.length ? `找到 ${hits.length} 项：\n` + hits.join('\n') : '未找到匹配文件' }
      }
      const list = await tcpAgent.scanRemoteFolder(dev.deviceId, args.dir)
      if (!list) return { ok: false, message: '远程扫描失败（30 秒无响应：对方可能离线、版本过旧或正忙，不要原样重试，可先 list_dir 确认连接）' }
      const hits = list.filter((e) => path.basename(e.path).toLowerCase().includes(kw)).slice(0, SEARCH_MAX_RESULTS)
      const note = hits.length ? '' : `（该目录共 ${list.length} 项，仅搜索了这一层；有子目录时用 list_dir 逐层找）`
      return { ok: true, message: hits.length ? `找到 ${hits.length} 项：\n` + hits.map((e) => e.path + (e.isDirectory ? '  [目录]' : '')).join('\n') : `未找到匹配文件${note}` }
    },

    async view_image(args) {
      // 多图模式：paths 数组一次请求识多张（单请求总耗时≈单张，素材批量验证必用以省时）；兼容单图 path
      const list = (Array.isArray(args.paths) ? args.paths : (typeof args.paths === 'string' ? args.paths.split(/[;\n]/) : [])).map((p) => String(p || '').trim()).filter(Boolean)
      const files = [...new Set(list.length ? list : (args.path ? [String(args.path)] : []))]
      if (!files.length) return { ok: false, message: '缺少 path（单图完整路径）或 paths（多图路径数组，一次识多张更快）' }
      if (files.length > 6) return { ok: false, message: `一次最多 6 张（收到 ${files.length} 张，图太多 token 爆炸），分批来` }
      const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }
      const images = []
      const skipped = []
      for (const p of files) {
        const ext = path.extname(p).toLowerCase()
        if (!MIME[ext]) { skipped.push(`${path.basename(p)}（格式 ${ext || '无扩展名'} 不支持）`); continue }
        let buf
        try { buf = fs.readFileSync(p) } catch { skipped.push(`${path.basename(p)}（不存在或无法读取）`); continue }
        if (buf.length > 20 * 1024 * 1024) { skipped.push(`${path.basename(p)}（超 20MB）`); continue }
        if (buf.length < 100) { skipped.push(`${path.basename(p)}（文件太小，可能不是图片）`); continue }
        // 图片魔数校验：扩展名对但内容不对（改名文件/损坏文件/网页另存失败）早点说清，别让视觉模型对着乱码幻觉
        const magicOk =
          (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||                    // jpeg
          (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) || // png
          (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ||                    // gif
          (buf[0] === 0x42 && buf[1] === 0x4d) ||                                       // bmp
          (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[8] === 0x57)    // webp(RIFF...WEBP)
        if (!magicOk) { skipped.push(`${path.basename(p)}（内容与扩展名不符，损坏或改名文件）`); continue }
        let mime = MIME[ext]
        // 大图自动压缩：>1MB 就用 Electron 自带 nativeImage 缩到长边 1800 转 JPEG（不加依赖；plain node 测试环境没有 nativeImage，自动跳过用原图）。
        // 识图不需要原始分辨率：桌面原图 PNG 常 2-5MB/几千 px，直发上游处理上万 tokens 轻松超 60s（实测踩雷），压后几百 KB 秒级返回
        if (buf.length > 1024 * 1024) {
          try {
            const electron = require('electron')
            const nativeImage = electron && electron.nativeImage
            if (nativeImage) {
              const img = nativeImage.createFromBuffer(buf)
              if (!img.isEmpty()) {
                const size = img.getSize()
                const long = Math.max(size.width, size.height)
                const resized = long > 1800
                  ? img.resize({ width: Math.round(size.width * 1800 / long), height: Math.round(size.height * 1800 / long) })
                  : img
                const jpeg = resized.toJPEG(82)
                if (jpeg && jpeg.length > 0 && jpeg.length < buf.length) { buf = jpeg; mime = 'image/jpeg' }
              }
            }
          } catch { /* 压缩不可用就用原图直发 */ }
        }
        images.push({ name: path.basename(p), url: `data:${mime};base64,${buf.toString('base64')}` })
      }
      if (!images.length) return { ok: false, message: '没有可用图片：' + skipped.join('；') }
      // 识图模型配置：默认硅基流动免费视觉模型，可在 AI 设置里改。
      // 优先级（v2.7.14）：显式视觉槽位服务商 > 主模型内置时走 MSMate 代理（扣积分）> 旧全局 Key > 未登录时回落内置代理
      const pv = resolveModelProvider(getSetting, 'vision')
      let apiKey = (pv && pv.apiKey) || ''
      let baseUrl = (pv && pv.baseUrl) || ''
      const builtinMain = isBuiltinMain(getSetting)
      if (!apiKey && builtinMain) {
        const m = resolveMsmateProvider(getSetting)
        if (m) { apiKey = m.apiKey; baseUrl = m.baseUrl }
      }
      if (!apiKey) apiKey = getSetting('aiVisionApiKey') || getSetting('aiApiKey') || ''
      if (!baseUrl) baseUrl = (getSetting('aiVisionBaseUrl') || getSetting('aiBaseUrl') || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
      if (!apiKey && !builtinMain) {
        const m = resolveMsmateProvider(getSetting)
        if (m) { apiKey = m.apiKey; baseUrl = m.baseUrl }
      }
      if (!apiKey) return { ok: false, message: '未配置 API Key（AI 设置里设置后才能识图；登录 MSMate 账号可直接用内置看图）' }
      // 走内置代理时模型钳到内置视觉清单（旧存档里可能存着自定义视觉模型名，内置清单没有会 400）
      // 默认 Qwen3.6-35B-A3B：MoE 只激活 3B 参数，识图比 27B 稠密快 ~10 倍（实测 1.5s vs 15.5s）且同价，2026-09-12 换默认
      let model = getSetting('aiVisionModel') || 'Qwen/Qwen3.6-35B-A3B'
      if (apiKey === ((resolveMsmateProvider(getSetting) || {}).apiKey)) {
        if (!/zai-org\/GLM-4\.5V|PaddlePaddle\/PaddleOCR|Qwen\/Qwen3\.[368]/i.test(model)) model = 'Qwen/Qwen3.6-35B-A3B'
      }
      let question = String(args.question || '').trim() || '请识别这张图片：先用一句话说明它整体是什么（照片/截图/文档/表格等），再描述画面主要内容（主体、场景、界面元素、图表结构）。图中如有文字（含水印、域名、版权行）请如实转录并注明位置；如果图中没有文字，直接说"图中无文字"并描述画面即可，不要硬凑或猜测文字内容。'
      if (images.length > 1) {
        question = `共 ${images.length} 张图（顺序：${images.map((im, i) => `${i + 1}.${im.name}`).join('、')}）。请按编号逐一说明每张图，不要混淆：\n${question}`
      }
      // DeepSeek-OCR 官方要求文本以 <image> 标记开头，否则模型对不上图会幻觉输出
      if (/DeepSeek-OCR/i.test(model)) question = '<image>\n' + question
      const body = JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            ...images.map((im) => ({ type: 'image_url', image_url: { url: im.url } }))
          ]
        }],
        // 多图按张数放大输出预算（每张描述都需要空间）
        max_tokens: Math.min(8192, 2048 * images.length),
        // 显式非流式：解析要整段 JSON（不传的话内置代理默认按流式强转，view_image 拿到的是 SSE 无法解析）
        stream: false,
        // Qwen3 系（3.6/3.8）默认开思考模式：识图不需要推理链，关掉省积分提速；上游不认该参数会忽略
        ...( /^Qwen\/Qwen3\./i.test(model) ? { enable_thinking: false } : {})
      })
      // 失败时带出具体原因（状态码/错误信息/超时），AI 才不会瞎猜"服务中断"
      const answer = await new Promise((resolve) => {
        let u
        try { u = new URL(baseUrl + '/chat/completions') } catch { return resolve('【配置错误】baseUrl 无效：' + baseUrl) }
        // MSMate 内置代理是 http（IP 直连），按协议选模块
        const req = (u.protocol === 'http:' ? http : https).request({
          method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
          timeout: 60000
        }, (res) => {
          let text = ''
          res.on('data', (c) => { text += c; if (text.length > 512 * 1024) res.destroy() })
          res.on('end', () => {
            try {
              const j = JSON.parse(text)
              const msg = j.choices && j.choices[0] && j.choices[0].message
              // reasoning 系模型兜底：content 为空时取 reasoning_content（思考型模型偶尔把描述写进思考区）
              if (msg && (msg.content || msg.reasoning_content)) return resolve(String(msg.content || msg.reasoning_content))
              const apiMsg = j.error && (j.error.message || j.error.code)
              resolve(`【HTTP ${res.statusCode}】${apiMsg || text.slice(0, 200)}`)
            } catch { resolve(`【HTTP ${res.statusCode}】响应非 JSON：${text.slice(0, 200)}`) }
          })
          res.on('error', (e) => resolve(`【网络错误】${e.message}`))
        })
        req.on('timeout', () => { req.destroy(); resolve('【超时】识图请求 60 秒无响应（图片可能太大或服务繁忙）') })
        req.on('error', (e) => resolve(`【网络错误】${e.message}`))
        req.write(body)
        req.end()
      })
      if (!answer || answer.startsWith('【')) return { ok: false, message: `识图失败：${answer || '模型无响应'}（模型 ${model}）。请把【】里的真实原因原样告知用户，禁止编造成"服务中断"或"系统强制停止"；401/403=API Key 问题，404=模型名不存在，429=限流稍后再试，5xx=服务端问题。用户要求重试时应照做（可换更简短的问题措辞），不得拒绝` }
      const skipNote = skipped.length ? `\n（已跳过 ${skipped.length} 张不可用图片：${skipped.join('；')}）` : ''
      return { ok: true, message: `识图结果（${model}${images.length > 1 ? `，${images.length} 张` : ''}）：\n${answer}${skipNote}` }
    },

    async remove_bg(args) {
      if (!args.path) return { ok: false, message: '缺少 path（图片完整路径）' }
      const el = shotElectron()
      if (!el) return { ok: false, message: 'remove_bg 需在应用内使用（当前环境无 Electron）' }
      let buf
      try { buf = fs.readFileSync(args.path) } catch { return { ok: false, message: `图片不存在或无法读取：${args.path}` } }
      const img = el.nativeImage.createFromBuffer(buf)
      if (img.isEmpty()) return { ok: false, message: '不是有效图片（PNG/JPG，webp/gif/bmp 也支持）' }
      const sz = img.getSize()
      let ort
      try { ort = require('onnxruntime-node') } catch { return { ok: false, message: '抠图引擎（onnxruntime-node）不可用，可能安装不完整，请重装应用' } }
      const modelDir = path.join(el.app.getPath('userData'), 'ai-models')
      fs.mkdirSync(modelDir, { recursive: true })
      const modelPath = path.join(modelDir, 'u2netp.onnx')
      // 模型按需下载（4.4MB，多源容错，下好终身离线用）
      if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 1000000) {
        const urls = [
          'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
          'https://gh-proxy.com/https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
          'https://mirror.ghproxy.com/https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
          'https://hf-mirror.com/tomjackson2023/rembg/resolve/main/u2netp.onnx',
          'https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx'
        ]
        const dl = (u) => new Promise((resolve, reject) => {
          const mod = u.startsWith('http:') ? http : https
          const get = (u2, redirects) => mod.get(u2, (r2) => {
            if (r2.statusCode >= 300 && r2.statusCode < 400 && r2.headers.location && redirects < 5) return get(r2.headers.location, redirects + 1)
            if (r2.statusCode !== 200) return reject(new Error('HTTP ' + r2.statusCode))
            const chunks = []
            r2.on('data', (c) => chunks.push(c))
            r2.on('end', () => resolve(Buffer.concat(chunks)))
            r2.on('error', reject)
          }).on('error', reject)
          get(u, 0)
        })
        let got = null
        for (const u of urls) {
          try { const b = await dl(u); if (b.length > 1000000) { fs.writeFileSync(modelPath, b); got = b; break } } catch { /* 换下一个源 */ }
        }
        if (!got) return { ok: false, message: '抠图模型首次下载失败（4.4MB，多个源都不通）。请检查网络后重试；下载成功后即可离线使用' }
      }
      // 预处理：缩到模型输入 320×320，BGRA→RGB float + rembg 标准 normalize；推理（session 缓存）；mask 放大合成透明 PNG
      try {
        const IN = 320
        const small = img.resize({ width: IN, height: IN })
        const bmp = small.toBitmap() // BGRA
        const px = IN * IN
        const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]
        const data = new Float32Array(3 * px)
        for (let i = 0; i < px; i++) {
          data[i] = (bmp[i * 4 + 2] / 255 - mean[0]) / std[0]
          data[px + i] = (bmp[i * 4 + 1] / 255 - mean[1]) / std[1]
          data[2 * px + i] = (bmp[i * 4 + 0] / 255 - mean[2]) / std[2]
        }
        if (!_removeBgSession) _removeBgSession = await ort.InferenceSession.create(modelPath)
        const session = _removeBgSession
        const tensor = new ort.Tensor('float32', data, [1, 3, IN, IN])
        const feeds = {}
        feeds[session.inputNames[0]] = tensor
        const out = await session.run(feeds)
        const mask = out[session.outputNames[0]].data
        const mbuf = Buffer.alloc(px * 4)
        for (let i = 0; i < px; i++) {
          const v = Math.max(0, Math.min(255, Math.round(mask[i] * 255)))
          mbuf[i * 4] = v; mbuf[i * 4 + 1] = v; mbuf[i * 4 + 2] = v; mbuf[i * 4 + 3] = 255
        }
        const maskBig = el.nativeImage.createFromBitmap(mbuf, { width: IN, height: IN }).resize({ width: sz.width, height: sz.height })
        const mbmp = maskBig.toBitmap()
        const origBmp = img.toBitmap()
        const outBuf = Buffer.alloc(sz.width * sz.height * 4)
        for (let i = 0; i < sz.width * sz.height; i++) {
          outBuf[i * 4] = origBmp[i * 4]
          outBuf[i * 4 + 1] = origBmp[i * 4 + 1]
          outBuf[i * 4 + 2] = origBmp[i * 4 + 2]
          outBuf[i * 4 + 3] = mbmp[i * 4 + 2] // mask 亮度作 alpha
        }
        const outImg = el.nativeImage.createFromBitmap(outBuf, { width: sz.width, height: sz.height })
        const outPath = args.out ? path.resolve(String(args.out)) : args.path.replace(/\.[^.]+$/, '') + '-抠图.png'
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, outImg.toPNG())
        return { ok: true, message: `抠图完成（透明底 PNG，${sz.width}×${sz.height}）→ ${outPath}。可直接用于 render_html 合成海报（<img> 叠加排版），或 view_image 查看效果`, path: outPath }
      } catch (err) {
        return { ok: false, message: `抠图失败：${err.message}` }
      }
    },

    async screenshot(args) {
      const scope = ['webview', 'app', 'screen'].includes(String(args.scope || '').trim().toLowerCase()) ? String(args.scope).trim().toLowerCase() : 'webview'
      const el = shotElectron()
      if (!el) return { ok: false, message: '截图需要 MSMate 应用内环境（当前是纯 Node/无 GUI 环境），无法截图' }
      // v2.5.3：screen 全屏截图默认自动最小化 MSMate 主窗口（不然截出来的桌面被自己挡住），截完自动还原；
      // AI 可传 minimizeSelf:false 关闭（比如就想连 MSMate 界面一起截下来）
      let restoreWin = null
      if (scope === 'screen' && args.minimizeSelf !== false) {
        try {
          const mainWin = el.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
          if (mainWin && mainWin.isVisible() && !mainWin.isMinimized()) {
            mainWin.minimize()
            restoreWin = mainWin
            await new Promise((r) => setTimeout(r, 700)) // 等最小化动画走完、桌面完全露出
          }
        } catch {}
      }
      try {
        const cap = scope === 'app' ? await captureAppShot(el) : scope === 'screen' ? await captureScreenShot(el) : await captureWebviewShot(el)
        const p = shotSavePath(el, scope, args.path)
        const info = shotSave(cap.img, p)
        return {
          ok: true,
          message: `已截图（${scope}${cap.url ? '：' + cap.url.slice(0, 80) : ''}）→ ${info.path}（${info.width}×${info.height}px，${fmtSize(info.size)}）\n图片还没"看"：要看画面内容/找东西/确认结果，就调 view_image 传 path:"${info.path}"`
        }
      } catch (err) {
        return { ok: false, message: `截图失败: ${err.message}` }
      } finally {
        if (restoreWin) {
          try { restoreWin.restore() } catch {}
          try { restoreWin.show() } catch {} // 截完自动把 MSMate 弹回桌面（老大拍板：最小化之后又自动打开）
        }
      }
    },

    async update_notes(args) {
      const mode = ['append', 'read', 'replace'].includes(String(args.mode || '').trim().toLowerCase()) ? String(args.mode).trim().toLowerCase() : 'append'
      const file = path.join(workspaceDir || tmpDir, 'NOTES.md')
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        if (mode === 'read') {
          let cur = ''
          try { cur = fs.readFileSync(file, 'utf8').trim() } catch {}
          if (!cur) return { ok: true, message: '大记事本目前是空的（还没有记录任何长期信息）' }
          return { ok: true, message: `大记事本内容（${cur.length} 字）：\n${cur.length > 4000 ? cur.slice(0, 4000) + '\n（…已截断，完整内容在工作台 NOTES.md）' : cur}` }
        }
        const content = String(args.content || '').trim()
        if (!content) return { ok: false, message: '缺少 content（要记的内容）。示例：update_notes {mode:"append", content:"老大喜欢紫色主题"}' }
        if (mode === 'replace') {
          fs.writeFileSync(file, content, 'utf8')
          return { ok: true, message: `大记事本已整本重写（${content.length} 字）。旧版本可在快照里找回（如有）` }
        }
        // append：逐行去重（同一句话不重复记）
        let cur = ''
        try { cur = fs.readFileSync(file, 'utf8').trim() } catch {}
        const date = new Date().toISOString().slice(0, 10)
        const addLines = content.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/^\d{4}-\d{2}-\d{2}/.test(l) ? l : `- ${date} ${l}`))
        const curLines = new Set(cur.split('\n').map((l) => l.replace(/^-\s*\d{4}-\d{2}-\d{2}\s*/, '').trim()).filter(Boolean))
        const fresh = addLines.filter((l) => !curLines.has(l.replace(/^-\s*\d{4}-\d{2}-\d{2}\s*/, '').trim()))
        if (!fresh.length) return { ok: true, message: '这些内容大记事本里已经有了，跳过（未重复记录）' }
        const next = (cur ? cur + '\n' : '') + fresh.join('\n')
        fs.writeFileSync(file, next, 'utf8')
        return { ok: true, message: `已记入大记事本（新增 ${fresh.length} 条，共 ${next.length} 字）：\n${fresh.join('\n')}` }
      } catch (err) {
        return { ok: false, message: `大记事本读写失败: ${err.message}` }
      }
    },

    async create_word(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      if (!/\.docx$/i.test(args.path)) args.path = args.path + '.docx'
      const content = wordContentOf(args)
      if (!content || !String(content.paragraphs.map((p) => (typeof p === 'object' ? p.text : p)).join('')).trim()) {
        return { ok: false, message: '内容不能为空（content 字符串或 paragraphs 数组）' }
      }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (isProtectedLocal(args.path)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
          const existed = fs.existsSync(args.path)
          let snapId = null
          if (existed) {
            const snap = snapshots.backupLocal(args.path)
            if (!snap.ok) return { ok: false, message: `已取消写入：原文件备份失败（${snap.reason}）` }
            snapId = snap.id
          }
          fs.mkdirSync(path.dirname(args.path), { recursive: true })
          const size = await createDocx(args.path, content)
          return {
            ok: true,
            message: `已${existed ? '覆盖' : '创建'} Word 文档 ${args.path}（${fmtSize(size)}）`,
            undo: existed ? { type: 'restore_snap', snapId } : { type: 'delete_local', path: args.path }
          }
        } catch (err) {
          return { ok: false, message: `创建 Word 失败: ${err.message}` }
        }
      }
      // 远程创建：本地生成 → 快照远程原文件 → 上传覆盖
      const temp = path.join(tmpDir, `ai_docx_${Date.now()}_${path.basename(args.path)}`)
      try {
        await createDocx(temp, content)
        const existed = await targetExists(args.path, args.target)
        let snapId = null
        if (existed) {
          snapId = genId('snap_')
          const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
          fs.mkdirSync(path.dirname(savePath), { recursive: true })
          const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, savePath, null, true)
          const ok = !!(dl && dl.success)
          snapshots.register(snapId, {
            id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
            deviceId: dev.deviceId, isDirectory: false,
            size: ok ? fs.statSync(savePath).size : 0, ok,
            reason: ok ? '' : '远程原文件备份失败'
          })
          if (!ok) return { ok: false, message: '已取消写入：远程原文件备份失败' }
        }
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已${existed ? '覆盖' : '创建'} ${dev.name} 的 Word 文档 ${args.path}`,
          undo: existed
            ? { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
            : { type: 'delete_remote', deviceId: dev.deviceId, path: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程创建 Word 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async read_word(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      // v2.5.6：文本 + 批注一起出——导师批注（作者+被批注原文+批注内容）AI 直接可见，改论文逐条落实
      const fmtComments = (cmts) => {
        if (!cmts || !cmts.length) return ''
        return '===== 文档批注（' + cmts.length + ' 条，修改时请逐条落实）=====\n' +
          cmts.map((c, i) => `[批注${i + 1}] ${c.author || '匿名'}${c.date ? ' ' + String(c.date).slice(0, 10) : ''}: "${c.anchor || '（未锚定到选中文本）'}" → ${c.text}`).join('\n') + '\n\n'
      }
      // v2.5.71：长文档分段——按段落边界切块防幻觉（AI 逐段读逐段改，每步基于程序返回的事实）
      const SEG_SIZE = 5000
      const segmentText = (full, seg) => {
        const lines = full.split('\n')
        const chunks = []
        let cur = [], curLen = 0
        for (const ln of lines) {
          if (curLen + ln.length > SEG_SIZE && cur.length) { chunks.push(cur.join('\n')); cur = []; curLen = 0 }
          cur.push(ln); curLen += ln.length + 1
        }
        if (cur.length) chunks.push(cur.join('\n'))
        if (!chunks.length) chunks.push(full)
        const idx = Math.min(Math.max(parseInt(seg, 10) || 1, 1), chunks.length) - 1
        return { chunks, idx }
      }
      const segWrap = (full, seg) => {
        if (!full) return '（文档内容为空）'
        const { chunks, idx } = segmentText(full, seg)
        if (chunks.length === 1) return chunks[0]
        return `【第 ${idx + 1}/${chunks.length} 段】\n` + chunks[idx] + (idx + 1 < chunks.length ? `\n\n（长文档已分段防幻觉——逐段处理：传 seg:${idx + 2} 读下一段）` : '\n\n（已是最后一段）')
      }
      const readFull = async (file) => {
        // v2.5.73：旧版 .doc 透明转换（本机/远程统一收口）——OLE2 二进制先转可编辑 docx 副本再读
        const rd = await ensureReadableDocx(file)
        const text = await readDocxText(rd.path)
        let cmts = []
        try { cmts = await parseWordComments(rd.path) } catch {}
        // 批注拼在最前（分段后 AI 第一时间看到）
        const body = ((cmts.length ? fmtComments(cmts) : '') + (text || '')).trim()
        return rd.converted ? body + '\n\n' + DOC_CONV_NOTE + '\n副本路径: ' + rd.path : body
      }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
          const full = await readFull(args.path)
          return { ok: true, message: segWrap(full, args.seg) }
        } catch (err) {
          return { ok: false, message: `读取 Word 失败: ${err.message}` }
        }
      }
      const temp = path.join(tmpDir, `ai_read_docx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const r = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!r || !r.success) return { ok: false, message: `下载远程文件失败: ${(r && r.error) || '未知错误'}` }
        const full = await readFull(temp)
        return { ok: true, message: segWrap(full, args.seg) }
      } catch (err) {
        return { ok: false, message: `远程读取 Word 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    // v2.5.68：PDF 文本提取（AI 读不了 PDF 文件的补位）
    async read_pdf(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const readFull = async (file) => {
        const text = await readPdfText(file)
        return text
      }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
          const text = await readFull(args.path)
          if (!text) return { ok: true, message: '（该 PDF 没有文本层——多为扫描件/图片型 PDF。请让用户把关键页转成图片（截图即可），再用 view_image 识图读取）' }
          return { ok: true, message: text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) + '\n...(内容过长已截断)' : text }
        } catch (err) {
          return { ok: false, message: `读取 PDF 失败: ${err.message}（加密/损坏的 PDF 不支持，请用户提供密码或重新导出）` }
        }
      }
      const temp = path.join(tmpDir, `ai_read_pdf_${Date.now()}_${path.basename(args.path)}`)
      try {
        const r = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!r || !r.success) return { ok: false, message: `下载远程文件失败: ${(r && r.error) || '未知错误'}` }
        const text = await readFull(temp)
        if (!text) return { ok: true, message: '（该 PDF 没有文本层——多为扫描件/图片型 PDF。请让用户把关键页转成图片，再用 view_image 识图读取）' }
        return { ok: true, message: text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) + '\n...(内容过长已截断)' : text }
      } catch (err) {
        return { ok: false, message: `远程读取 PDF 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    // v2.5.69：PDF → PNG（Windows 自带 WinRT 渲染，零新依赖）——扫描件 PDF 转图片后 view_image 识图
    async pdf_to_image(args) {
      if (!args.path) return { ok: false, message: '缺少 path（pdf 完整路径）' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'pdf_to_image 暂只支持本机文件（target 远程不支持）。远程 PDF 先 transfer_file 拉到本机' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        if (isLegacyDoc(args.path)) return { ok: false, message: '这是旧版 .doc（Word 二进制），不是 PDF，本工具处理不了。读它的内容用 read_word（会自动转换为可编辑 .docx）；要 PDF 转图片请先确认传的是 .pdf 文件' }
        const { execFile } = require('child_process')
        const os = require('os')
        const ps1Src = path.join(__dirname, 'pdf2png.ps1')
        // asar 内的 ps1 无法被 powershell 直接执行——先拷到临时目录
        const ps1 = path.join(tmpDir, 'pdf2png.ps1')
        fs.copyFileSync(ps1Src, ps1)
        const base = path.basename(args.path, '.pdf').replace(/[\\/:*?"<>|]/g, '_')
        const outDir = path.join(workspaceDir || tmpDir, 'ai-pdf-pages', base)
        fs.rmSync(outDir, { recursive: true, force: true })
        fs.mkdirSync(outDir, { recursive: true })
        const maxPages = Math.min(Math.max(parseInt(args.pages, 10) || 10, 1), 30)
        const stdout = await new Promise((resolve, reject) => {
          execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-PdfPath', args.path, '-OutDir', outDir, '-MaxPages', String(maxPages)], { timeout: 180000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, so, se) => {
            if (err) return reject(new Error(String(se || so || err.message).trim().split('\n')[0]))
            resolve(String(so || ''))
          })
        })
        const files = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z]:\\.+\.png$/i.test(l))
        if (!files.length) return { ok: false, message: 'PDF 渲染失败：没有产出任何页面（加密/损坏的 PDF 不支持，或页面数为 0）' }
        return { ok: true, message: `已渲染 ${files.length} 页（${path.basename(args.path)}）→ 逐张用 view_image 看内容：\n` + files.map((f, i) => `  第${i + 1}页: ${f}`).join('\n'), files }
      } catch (err) {
        return { ok: false, message: `PDF 转图片失败: ${err.message}（加密/损坏的 PDF 不支持）` }
      }
    },

    async read_word_format(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'read_word_format 暂只支持本机文件（target 远程不支持）。远程文档先 transfer_file 拉到本机再解析' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        const rd = await ensureReadableDocx(args.path)
        const parsed = await parseWordFormat(rd.path)
        const convNote = rd.converted ? `\n\n${DOC_CONV_NOTE}\n副本路径: ${rd.path}` : ''
        if (!parsed.paragraphs.length) return { ok: true, message: '（文档无段落内容）' + convNote }
        if (args.mode === 'full') {
          const fmtLine = (p) => {
            const para = []
            if (p.para.lineRatio) para.push(`行距${p.para.lineRatio}倍`)
            else if (p.para.linePt) para.push(`行距${p.para.linePt}`)
            if (p.para.beforePt != null) para.push(`段前${p.para.beforePt}pt`)
            if (p.para.afterPt != null) para.push(`段后${p.para.afterPt}pt`)
            if (p.para.indentFirstLine) para.push(`首行缩进${p.para.indentFirstLine}字符`)
            if (p.para.align) para.push(`对齐${p.para.align}`)
            const run = []
            const f = p.run.eastAsiaFont || p.run.font
            if (f) run.push(`字体${f}`)
            if (p.run.sizePt) run.push(`${p.run.sizePt}pt`)
            if (p.run.bold) run.push('加粗')
            if (p.run.italic) run.push('斜体')
            if (p.run.color) run.push(`#${p.run.color}`)
            if (p.run.shade) run.push(`底纹#${p.run.shade}`)
            return `段[${para.join(' ')}] 字[${run.join(' ')}]`
          }
          const CAP = 200
          const shown = parsed.paragraphs.slice(0, CAP)
          const lines = shown.map((p) => {
            const label = p.tag === 'table' ? `[表格首段·${p.role}]` : `[${p.role}]`
            const txt = p.text ? p.text.slice(0, 30) + (p.text.length > 30 ? '…' : '') : '（空段）'
            return `#${p.idx} ${label} "${txt}" ${fmtLine(p)}`
          })
          if (parsed.paragraphs.length > CAP) lines.push(`...(共 ${parsed.paragraphs.length} 段，仅显示前 ${CAP} 段)`)
          return { ok: true, message: `【全量格式清单】\n${lines.join('\n')}\n\n页面：${parsed.page ? `${parsed.page.widthCm}×${parsed.page.heightCm}cm 边距上${parsed.page.marginTopCm}/下${parsed.page.marginBottomCm}/左${parsed.page.marginLeftCm}/右${parsed.page.marginRightCm}cm` : '未显式定义'}${parsed.hasHeader ? ' 有页眉' : ''}${parsed.hasFooter ? ' 有页脚' : ''}` + convNote }
        }
        const fp = wordFormatFingerprint(parsed)
        return { ok: true, message: fp.summary + '\n\n（要逐段全量格式传 mode:"full"；要把这份格式套到别的文档用 apply_word_format）' + convNote }
      } catch (err) {
        return { ok: false, message: `解析 Word 格式失败: ${err.message}` }
      }
    },

    // v2.5.62：论文格式模板 → 蒸馏成格式规范书（批注=权威规则自动解析、红字=说明书原文、图片资产导出）
    async read_paper_spec(args) {
      if (!args.path) return { ok: false, message: '缺少 path（格式模板 docx 完整路径）' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'read_paper_spec 暂只支持本机文件（target 远程不支持）。远程模板先 transfer_file 拉到本机再蒸馏' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        const rd = await ensureReadableDocx(args.path)
        const base = path.basename(rd.path, '.docx').replace(/[\\/:*?"<>|]/g, '_')
        const spec = await extractPaperFormatSpec(rd.path, { assetsDir: path.join(workspaceDir, 'ai-spec-assets', base) })
        const convNote = rd.converted ? `\n\n${DOC_CONV_NOTE}\n副本路径: ${rd.path}` : ''
        if (!spec.roles && !spec.rules.length && !spec.redNotes.length) return { ok: true, message: '（该文档没有可蒸馏的格式信息——不是带批注/红字说明的格式模板？用 read_word_format 看格式指纹）' + convNote }
        return { ok: true, message: spec.summary + '\n\n（按此规范书理解后再动手：产出按规范直接生成，模板的红字/批注/说明书等说明性内容一个不要带进产出；规范书不够明确的版面细节，把模板拖进工作台 screenshot 截图 + view_image 识图补齐理解）' + convNote }
      } catch (err) {
        return { ok: false, message: `蒸馏论文格式规范失败: ${err.message}` }
      }
    },

    // v2.5.65：产出论文体检——程序对照规范书逐项检查，issue 清单给 AI 逐条修正（自我检查闭环）
    async check_paper_format(args) {
      if (!args.path) return { ok: false, message: '缺少 path（套模板后的产出 docx 完整路径）' }
      if (!args.templatePath) return { ok: false, message: '缺少 templatePath（格式模板 docx 完整路径）' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'check_paper_format 暂只支持本机文件（target 远程不支持）' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '产出文件不存在' }
        if (!fs.existsSync(args.templatePath)) return { ok: false, message: '模板文件不存在' }
        // v2.5.73：论文/模板任一是旧版 .doc 都自动转换后体检
        const rdP = await ensureReadableDocx(args.path)
        const rdT = await ensureReadableDocx(args.templatePath)
        const r = await checkPaperFormat(rdP.path, rdT.path)
        const tail = r.issues.length
          ? `\n\n修法提示：格式类用 apply_word_format picks（match 用段落开头文字）逐条改；内容类（引用上标/序号措辞）用 modify_word edit。修完再跑一次本工具复查。`
          : `\n\n0 项问题，格式体检通过。`
        return { ok: true, message: r.summary + tail, issues: r.issues }
      } catch (err) {
        return { ok: false, message: `产出体检失败: ${err.message}` }
      }
    },

    // ===== v2.5.70：Word 表格工具套件四件 =====
    async read_word_tables(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'read_word_tables 暂只支持本机文件' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        const rd = await ensureReadableDocx(args.path)
        const JSZipL = require('jszip')
        const zl = await JSZipL.loadAsync(fs.readFileSync(rd.path))
        const docXml = await zl.file('word/document.xml').async('string')
        const tables = scanWordTables(docXml)
        const convNote = rd.converted ? `\n\n${DOC_CONV_NOTE}\n副本路径: ${rd.path}` : ''
        if (!tables.length) return { ok: true, message: '文档里没有表格' + convNote }
        const lines = tables.map((t, i) => {
          const trs = (t.xml.match(/<w:tr(?:\s[^>]*)?>/g) || []).length
          const firstTr = (t.xml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/) || [''])[0]
          const cols = (firstTr.match(/<w:tc(?:\s[^>]*)?>/g) || []).length
          const rowPreview = (t.xml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || []).slice(0, 2).map((tr) =>
            (tr.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || []).map((tc) =>
              (tc.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || []).map((x) => x[0].replace(/<[^>]+>/g, '')).join('').trim().slice(0, 10)).join(' | ')).join(' // ')
          return `表格${i + 1}：${trs}行×${cols}列 | 预览：${rowPreview}`
        })
        return { ok: true, message: `文档共 ${tables.length} 个表格：\n` + lines.join('\n') + '\n\n（改格式用 format_word_table，改内容用 edit_word_table，插表用 add_word_table——定位都支持 index 序号或 near 附近文字）' + convNote }
      } catch (err) {
        return { ok: false, message: `读取表格失败: ${err.message}` }
      }
    },

    async format_word_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'format_word_table 暂只支持本机文件' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        const blk = legacyDocWriteBlock(args.path)
        if (blk) return { ok: false, message: blk }
        const snap = snapshots.backupLocal(args.path)
        if (!snap.ok) return { ok: false, message: `已取消：备份失败（${snap.reason}）` }
        const r = formatWordTable(args.path, args)
        const detail = [`风格 ${r.style}`, `表 ${r.index}/${r.total}`, `${r.rows} 行`].filter(Boolean).join('，')
        return { ok: true, message: `表格格式化完成（${detail}）。可用 read_word_tables 复查，或 check_paper_format 全文体检`, undo: { type: 'restore_snap', snapId: snap.id } }
      } catch (err) {
        return { ok: false, message: `表格格式化失败: ${err.message}` }
      }
    },

    async add_word_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'add_word_table 暂只支持本机文件' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        if (!Array.isArray(args.rows) || !args.rows.length) return { ok: false, message: '缺少 rows（二维数组，第一行为表头，如 [["项目","数量"],["导演",1]]）' }
        const blk = legacyDocWriteBlock(args.path)
        if (blk) return { ok: false, message: blk }
        const snap = snapshots.backupLocal(args.path)
        if (!snap.ok) return { ok: false, message: `已取消：备份失败（${snap.reason}）` }
        const r = await addWordTable(args.path, args)
        return { ok: true, message: `已插入 ${r.rows}行×${r.cols}列表格${args.afterText ? `（"${String(args.afterText).slice(0, 15)}"之后）` : '（文档末尾）'}，现共 ${r.total} 个表格。格式不满意可用 format_word_table 调`, undo: { type: 'restore_snap', snapId: snap.id } }
      } catch (err) {
        return { ok: false, message: `插表失败: ${err.message}` }
      }
    },

    async edit_word_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'edit_word_table 暂只支持本机文件' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        if (!args.ops) return { ok: false, message: '缺少 ops（操作数组）：[{op:"setCell",row,col,text} / {op:"insertRow",at,cells:[...]} / {op:"deleteRow",at} / {op:"insertCol",at} / {op:"deleteCol",at} / {op:"mergeCells",r1,c1,r2,c2} / {op:"deleteTable"}]' }
        const blk = legacyDocWriteBlock(args.path)
        if (blk) return { ok: false, message: blk }
        const snap = snapshots.backupLocal(args.path)
        if (!snap.ok) return { ok: false, message: `已取消：备份失败（${snap.reason}）` }
        const r = editWordTable(args.path, args)
        return { ok: true, message: `表格编辑完成（共 ${r.done.length} 项操作）：${r.done.join('；')}`, undo: { type: 'restore_snap', snapId: snap.id } }
      } catch (err) {
        return { ok: false, message: `表格编辑失败: ${err.message}（含合并单元格的表暂不支持整列插删）` }
      }
    },

    // v2.5.72：全文分页修复（keepNext 全局联动）+ SVG 转图片（AI 手写 SVG 图表渲染）
    async fix_paper_paging(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'fix_paper_paging 暂只支持本机文件' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        const blk = legacyDocWriteBlock(args.path)
        if (blk) return { ok: false, message: blk }
        const snap = snapshots.backupLocal(args.path)
        if (!snap.ok) return { ok: false, message: `已取消：备份失败（${snap.reason}）` }
        const r = await fixPaperPaging(args.path)
        return { ok: true, message: `全文分页修复完成：${r.tables} 个表格，${r.keepNextAdded} 处表前段补 keepNext（标题不与表格拆页），${r.headerRepeated} 个表首行补跨页重复表头`, undo: { type: 'restore_snap', snapId: snap.id } }
      } catch (err) {
        return { ok: false, message: `分页修复失败: ${err.message}` }
      }
    },

    async svg_to_png(args) {
      if (!args.path) return { ok: false, message: '缺少 path（svg 完整路径）' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'svg_to_png 暂只支持本机文件' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        const out = args.out || args.path.replace(/\.svg$/i, '.png')
        const r = await svgToPng(args.path, out, { width: args.width, height: args.height })
        return { ok: true, message: `SVG 已渲染为 PNG（${r.width}×${r.height}，${Math.round(r.size / 1024)}KB）→ ${out}。可用 view_image 检查效果，或 modify_word 插入文档`, path: out }
      } catch (err) {
        return { ok: false, message: `SVG 转图片失败: ${err.message}` }
      }
    },

    async render_html(args) {
      if (!args.path) return { ok: false, message: '缺少 path（HTML 完整路径）' }
      const el = shotElectron()
      if (!el) return { ok: false, message: 'render_html 需在应用内使用（当前环境无 Electron）' }
      const htmlPath = path.resolve(String(args.path))
      if (!fs.existsSync(htmlPath)) return { ok: false, message: 'HTML 文件不存在，先用 write_file 写出单文件 HTML（内嵌 CSS）' }
      // 画布预设（学 guizang-social-card-skill：小红书/微信/海报场景全覆盖）
      const PRESETS = {
        'xhs': [1080, 1440],
        'square': [1080, 1080],
        'a4': [1240, 1754],
        'wide': [2100, 900],
        'wechat-cover': [900, 383]
      }
      let w = 1240, h = 1754
      if (args.preset && PRESETS[String(args.preset).toLowerCase()]) [w, h] = PRESETS[String(args.preset).toLowerCase()]
      if (+args.width > 0) w = Math.round(+args.width)
      if (+args.height > 0) h = Math.round(+args.height)
      const scale = Math.max(1, Math.min(4, Math.round(+args.scale || 1)))
      const out = args.out ? path.resolve(String(args.out)) : htmlPath.replace(/\.html?$/i, '.png')
      let win = null
      try {
        // 离屏渲染：物理窗口 = CSS 尺寸 × scale，zoomFactor = scale → capturePage 输出高清 PNG，
        // HTML 内 CSS 始终按 w×h 的 CSS 尺寸写（设计画布与输出分辨率解耦）。
        // ⚠ 构造函数里的宽高会被屏幕工作区钳制（如 1440 屏→高最多 1392，A4 竖版必被砍），
        //   必须先小窗创建、再 setContentSize 才能突破（Electron 22 实测，见 test/render-clamp-exp.js）
        win = new el.BrowserWindow({
          width: Math.min(w * scale, 800),
          height: Math.min(h * scale, 600),
          useContentSize: true,
          show: false,
          frame: false,
          webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: true }
        })
        try { win.webContents.setAudioMuted(true) } catch {}
        try { win.webContents.setZoomFactor(scale) } catch {}
        // 创建后 setContentSize 突破屏幕工作区钳制，保证 capturePage 全画布出图
        win.setContentSize(w * scale, h * scale)
        await win.loadFile(htmlPath)
        // 等字体 + 图片就绪（轮询最长 ~6s，防漏图）
        await win.webContents.executeJavaScript(
          "(function(){return new Promise(function(res){var n=0;(function tick(){var fontsOk=true,imgsOk=true;try{fontsOk=document.fonts.status==='loaded'}catch(e){}try{imgsOk=[].every.call(document.images,function(i){return i.complete})}catch(e){}if((fontsOk&&imgsOk)||n>55){setTimeout(function(){res(1)},100)}else{n++;setTimeout(tick,100)}})()})})()",
          true
        ).catch(() => {})
        const img = await win.webContents.capturePage()
        if (!img || img.isEmpty()) return { ok: false, message: '渲染结果为空：HTML 可能没有可见内容（检查 body 高度/背景）' }
        const buf = img.toPNG()
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, buf)
        const sz = img.getSize()
        return {
          ok: true,
          message: `已渲染 PNG（${sz.width}×${sz.height} 物理像素 = CSS ${w}×${h}${scale > 1 ? ` × ${scale}` : ''}，${Math.round(buf.length / 1024)}KB）→ ${out}。下一步必须 view_image 自检：文字溢出/对比度/空洞/对齐，有问题改 HTML 重渲`,
          path: out
        }
      } catch (err) {
        return { ok: false, message: `渲染失败: ${err.message}` }
      } finally {
        try { if (win && !win.isDestroyed()) win.destroy() } catch {}
      }
    },

    async apply_word_format(args) {
      if (!args.path) return { ok: false, message: '缺少 path（要改格式的文档）' }
      if (!args.rules) return { ok: false, message: '缺少 rules：传 { map:{ h1:"source", body:"source" } }（按角色批量，需 formatPath）或 { picks:[{ match:"段落文字", format:{sizePt:16,bold:true,color:"FF0000"} }] }（单段精准），两种可混用' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'apply_word_format 暂只支持本机文件（target 远程不支持）。远程文档先拉到本机，改完再传回去' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
        if (args.formatPath && !fs.existsSync(args.formatPath)) return { ok: false, message: 'formatPath 格式参考文档不存在' }
        const blk = legacyDocWriteBlock(args.path)
        if (blk) return { ok: false, message: blk }
        // v2.5.73：formatPath 是只读参考——旧版 .doc 自动转换
        const rdF = args.formatPath ? await ensureReadableDocx(args.formatPath) : { path: args.formatPath }
        const snap = snapshots.backupLocal(args.path)
        if (!snap.ok) return { ok: false, message: `已取消套用：原文件备份失败（${snap.reason}）` }
        const r = await applyWordFormat(args.path, rdF.path, args.rules)
        const detail = r.applied.map((a) => `${a.role}:"${a.text.slice(0, 15)}"`).slice(0, 8).join('、')
        return {
          ok: true,
          message: `已套用 ${r.applied.length} 段格式到 ${args.path}（${fmtSize(r.size)}）：${detail}${r.applied.length > 8 ? ' 等' : ''}${r.missedPicks.length ? `\n⚠ 未匹配的 picks：${r.missedPicks.join('、')}（match 要用段落开头连续文字，可先 read_word 核对）` : ''}（快照 ${snap.id} 可还原）`,
          undo: { type: 'restore_snap', snapId: snap.id }
        }
      } catch (err) {
        return { ok: false, message: `套用格式失败: ${err.message}` }
      }
    },

    async apply_word_template(args) {
      if (!args.path) return { ok: false, message: '缺少 path（论文 docx 完整路径）' }
      if (!args.templatePath) return { ok: false, message: '缺少 templatePath（学校格式模板 docx 完整路径）。让用户提供模板文件，别拿论文自己当模板' }
      const dev = resolveDevice(args.target)
      if (dev) return { ok: false, message: 'apply_word_template 暂只支持本机文件（target 远程不支持）。远程文档先拉到本机，改完再传回去' }
      try {
        if (!fs.existsSync(args.path)) return { ok: false, message: `论文文件不存在：${args.path}。先用 search_files 找到它` }
        if (!fs.existsSync(args.templatePath)) return { ok: false, message: `模板文件不存在：${args.templatePath}` }
        // v2.5.73：论文/模板任一是旧版 .doc 都自动转换后套用（产出始终是新 .docx，原件不动）
        const rdP = await ensureReadableDocx(args.path)
        const rdT = await ensureReadableDocx(args.templatePath)
        let undo
        if (args.outputPath && fs.existsSync(args.outputPath)) {
          const snap = snapshots.backupLocal(args.outputPath)
          if (!snap.ok) return { ok: false, message: `已取消：输出文件已存在且备份失败（${snap.reason}）` }
          undo = { type: 'restore_snap', snapId: snap.id }
        }
        const r = await applyWordTemplate(rdP.path, rdT.path, { cover: args.cover, outputPath: args.outputPath })
        const secs = (r.sections || []).map((s) => `${s.kind}${s.skipped ? '(跳)' : ''}`).join('→')
        // v2.5.66：结构完整性警告——论文缺板块时先补齐再重套，否则产出天生残缺
        const warn = (r.warnings || []).length ? `\n\n⚠ 结构检查（先补齐这些再重新套模板，产出才会完整）：\n${r.warnings.map((w) => `- ${w}`).join('\n')}\n⚠ 补齐后必跑 check_paper_format 体检产出并逐条修正` : `\n⚠ 套完后跑 check_paper_format 体检产出，按 issue 逐条修正`
        return {
          ok: true,
          message: `已按模板重排 → ${r.outputPath}（${fmtSize(r.size)}）。分节：${secs}；摘要 ${r.paper.abstractParas} 段/关键词${r.paper.keywords ? '已提取' : '未提取'}/正文 ${r.paper.bodyBlocks} 块${r.imagesMigrated ? `/图片 ${r.imagesMigrated} 张` : ''}。⚠ 打开文档后右键目录选「更新域」生成目录页码${warn}`,
          undo
        }
      } catch (err) {
        return { ok: false, message: `套模板失败: ${err.message}。确认两份都是 .docx（老 .doc 格式先转存），模板需含分节结构` }
      }
    },

    async modify_word(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const mode = ['replace', 'append', 'edit'].includes(args.mode) ? args.mode : 'append'
      // edit 模式：精准替换，content = { replacements: [{find, replace, all?}] }
      const editContent = mode === 'edit'
        ? (() => {
            const reps = Array.isArray(args.replacements) ? args.replacements : (args.replacements && typeof args.replacements === 'object' && args.replacements.find != null ? [args.replacements] : null)
            if (!reps) return null
            return { replacements: reps }
          })()
        : null
      if (mode === 'edit' && !editContent) return { ok: false, message: 'edit 模式缺少 replacements：传 [{find:"旧文字", replace:"新文字", all?}]（all 默认 true 全部替换）' }
      const content = mode === 'edit' ? editContent : wordContentOf(args)
      if (!content) return { ok: false, message: mode === 'edit' ? 'replacements 格式错误' : '内容过长，请拆分为多次操作' }
      if (mode !== 'edit' && !String(content.paragraphs.map((p) => (typeof p === 'object' ? p.text : p)).join('')).trim()) {
        return { ok: false, message: '内容不能为空（content 字符串或 paragraphs 数组）' }
      }
      const describeEdit = (r) => r.replaced
        ? `替换 ${r.replaced} 处` + (r.missed.length ? `；未找到：${r.missed.join('、')}` : '')
        : `未找到替换目标：${r.missed.join('、')}`
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: `文件不存在：${args.path}。先用 create_word 创建，或用 search_files 找到它` }
          const blk = legacyDocWriteBlock(args.path)
          if (blk) return { ok: false, message: blk }
          // C 盘保护区（用户文档区等）：不在原地改——自动转工作台「改稿」副本，原文件全程不动留作对比参考，
          // 副本免审批随便改+自检；AI 确认无误后再 copy_path 回写原位（那一跳写用户目录，弹一次审批合理）
          const draft = protectedDraftCopy(args.path)
          if (draft) {
            const snap = snapshots.backupLocal(draft)
            if (!snap.ok) return { ok: false, message: `已取消修改：副本备份失败（${snap.reason}）` }
            const result = await modifyDocx(draft, content, mode)
            if (mode === 'edit' && !result.replaced) {
              return { ok: false, message: `${describeEdit(result)}，副本未改动。可先 read_word 副本确认原文措辞` }
            }
            const what = mode === 'edit' ? describeEdit(result) : (mode === 'replace' ? '重写' : '追加')
            return {
              ok: true,
              message: `原文件未动（留作对比参考）。已在工作台副本上完成${what}：${draft}（原文件：${args.path}）。流程：先 read_word 自检副本 → 有问题继续在副本上改 → 满意后用 copy_path 把 ${draft} 复制回 ${args.path}（写回用户目录会弹一次审批，向用户说明即可）`,
              path: draft,
              undo: { type: 'restore_snap', snapId: snap.id }
            }
          }
          const snap = snapshots.backupLocal(args.path)
          if (!snap.ok) return { ok: false, message: `已取消修改：原文件备份失败（${snap.reason}）` }
          const result = await modifyDocx(args.path, content, mode)
          if (mode === 'edit' && !result.replaced) {
            return { ok: false, message: `${describeEdit(result)}，文档未改动。可先 read_word 确认原文措辞（跨加粗/斜体的句子也能匹配）` }
          }
          const what = mode === 'edit' ? describeEdit(result) : (mode === 'replace' ? '重写' : '追加')
          return {
            ok: true,
            message: `已${what}${mode === 'edit' ? '：' : ' Word 文档 '}${mode === 'edit' ? args.path : args.path + `（${fmtSize(result)}）`}，可用 read_word 检查结果`,
            undo: { type: 'restore_snap', snapId: snap.id }
          }
        } catch (err) {
          return { ok: false, message: `修改 Word 失败: ${err.message}` }
        }
      }
      // 远程：下载 → 本地修改 → 备份并上传
      const temp = path.join(tmpDir, `ai_mod_docx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `下载远程文件失败: ${(dl && dl.error) || '未知错误'}` }
        const blk = legacyDocWriteBlock(temp)
        if (blk) return { ok: false, message: '远程文件是旧版 .doc：' + blk }
        const snapId = genId('snap_')
        const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        fs.copyFileSync(temp, savePath)
        snapshots.register(snapId, {
          id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
          deviceId: dev.deviceId, isDirectory: false, size: fs.statSync(savePath).size, ok: true, reason: ''
        })
        const resultRemote = await modifyDocx(temp, content, mode)
        if (mode === 'edit' && !resultRemote.replaced) {
          return { ok: false, message: `${describeEdit(resultRemote)}，文档未改动。可先 read_word 确认原文措辞` }
        }
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        const what = mode === 'edit' ? describeEdit(resultRemote) : (mode === 'replace' ? '重写' : '追加')
        return {
          ok: true,
          message: `已${what}${mode === 'edit' ? '：' : ' '}${dev.name} 的 Word 文档 ${args.path}`,
          undo: { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程修改 Word 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async create_pptx(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      if (!/\.pptx$/i.test(args.path)) args.path = args.path + '.pptx'
      const content = { title: String(args.title || ''), subtitle: String(args.subtitle || ''), content: String(args.content || '') }
      if (!content.content.trim()) return { ok: false, message: '内容不能为空：content 是用 --- 独占一行分页的 PPT 大纲（#cover/#toc/#section/#summary 标记页型，内容页 ## 标题 + - 要点，详见手册）' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (isProtectedLocal(args.path)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
          const existed = fs.existsSync(args.path)
          let snapId = null
          if (existed) {
            const snap = snapshots.backupLocal(args.path)
            if (!snap.ok) return { ok: false, message: `已取消写入：原文件备份失败（${snap.reason}）` }
            snapId = snap.id
          }
          fs.mkdirSync(path.dirname(args.path), { recursive: true })
          const size = await createPptx(args.path, content)
          return {
            ok: true,
            message: `已${existed ? '覆盖' : '创建'} PPT 演示文稿 ${args.path}（${fmtSize(size)}），可用 open_path 打开演示`,
            undo: existed ? { type: 'restore_snap', snapId } : { type: 'delete_local', path: args.path }
          }
        } catch (err) {
          return { ok: false, message: `创建 PPT 失败: ${err.message}` }
        }
      }
      // 远程创建：本地生成 → 快照远程原文件 → 上传覆盖（与 create_word 同套路）
      const temp = path.join(tmpDir, `ai_pptx_${Date.now()}_${path.basename(args.path)}`)
      try {
        await createPptx(temp, content)
        const existed = await targetExists(args.path, args.target)
        let snapId = null
        if (existed) {
          snapId = genId('snap_')
          const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
          fs.mkdirSync(path.dirname(savePath), { recursive: true })
          const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, savePath, null, true)
          const okDl = !!(dl && dl.success)
          snapshots.register(snapId, {
            id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
            deviceId: dev.deviceId, isDirectory: false,
            size: okDl ? fs.statSync(savePath).size : 0, ok: okDl,
            reason: okDl ? '' : '远程原文件备份失败'
          })
          if (!okDl) return { ok: false, message: '已取消写入：远程原文件备份失败' }
        }
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已${existed ? '覆盖' : '创建'} ${dev.name} 的 PPT 演示文稿 ${args.path}`,
          undo: existed
            ? { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
            : { type: 'delete_remote', deviceId: dev.deviceId, path: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程创建 PPT 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async read_pptx(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const doRead = async (p) => {
        const r = await readPptx(p)
        return { ok: true, message: `共 ${r.count} 页：\n\n${r.text}` }
      }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: `文件不存在：${args.path}。可用 search_files 找到它` }
          return await doRead(args.path)
        } catch (err) {
          return { ok: false, message: `读取 PPT 失败: ${err.message}` }
        }
      }
      const temp = path.join(tmpDir, `ai_read_pptx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `下载远程文件失败: ${(dl && dl.error) || '未知错误'}` }
        return await doRead(temp)
      } catch (err) {
        return { ok: false, message: `远程读取 PPT 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async edit_pptx(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const reps = Array.isArray(args.replacements) ? args.replacements : (args.replacements && typeof args.replacements === 'object' && args.replacements.find != null ? [args.replacements] : null)
      if (!reps) return { ok: false, message: '缺少 replacements：传 [{find:"旧文字", replace:"新文字", all?}]（all 默认 true 全部替换）' }
      const describeEdit = (r) => r.replaced
        ? `替换 ${r.replaced} 处` + (r.missed.length ? `；未找到：${r.missed.join('、')}` : '')
        : `未找到替换目标：${r.missed.join('、')}`
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: `文件不存在：${args.path}。先用 create_pptx 创建，或用 search_files 找到它` }
          const snap = snapshots.backupLocal(args.path)
          if (!snap.ok) return { ok: false, message: `已取消修改：原文件备份失败（${snap.reason}）` }
          const result = await editPptx(args.path, { replacements: reps })
          if (!result.replaced) {
            return { ok: false, message: `${describeEdit(result)}，文件未改动。可先 read_pptx 确认原文措辞（跨样式碎 run 的句子也能匹配）` }
          }
          return {
            ok: true,
            message: `已精准替换 PPT ${args.path}：${describeEdit(result)}，可用 read_pptx 检查结果`,
            undo: { type: 'restore_snap', snapId: snap.id }
          }
        } catch (err) {
          return { ok: false, message: `修改 PPT 失败: ${err.message}` }
        }
      }
      // 远程：下载 → 本地修改 → 备份并上传
      const temp = path.join(tmpDir, `ai_edit_pptx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `下载远程文件失败: ${(dl && dl.error) || '未知错误'}` }
        const snapId = genId('snap_')
        const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        fs.copyFileSync(temp, savePath)
        snapshots.register(snapId, {
          id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
          deviceId: dev.deviceId, isDirectory: false, size: fs.statSync(savePath).size, ok: true, reason: ''
        })
        const resultRemote = await editPptx(temp, { replacements: reps })
        if (!resultRemote.replaced) {
          return { ok: false, message: `${describeEdit(resultRemote)}，文件未改动。可先 read_pptx 确认原文措辞` }
        }
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已替换 ${dev.name} 的 PPT ${args.path}：${describeEdit(resultRemote)}`,
          undo: { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程修改 PPT 失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async create_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      let headers = Array.isArray(args.headers) ? args.headers : []
      let rows = Array.isArray(args.rows) ? args.rows : []
      let sheets = null
      let merges = Array.isArray(args.merges) ? args.merges.map((m) => String(m)) : []
      const styles = Array.isArray(args.styles) ? args.styles.filter((s) => s && s.range) : []
      // 多工作表：sheets = { 表名: markdown表格文本 或 {headers,rows,merges} }
      if (args.sheets && typeof args.sheets === 'object' && !Array.isArray(args.sheets) && Object.keys(args.sheets).length) {
        sheets = {}
        for (const [name, data] of Object.entries(args.sheets)) {
          if (data && typeof data === 'object' && !Array.isArray(data) && (Array.isArray(data.headers) || Array.isArray(data.rows))) {
            sheets[name] = { headers: data.headers || [], rows: Array.isArray(data.rows) ? data.rows : [], merges: Array.isArray(data.merges) ? data.merges : [], statusMap: data.statusMap || {} }
          } else {
            const md = parseMarkdownTable(typeof data === 'string' ? data : JSON.stringify(data))
            if (md) sheets[name] = { headers: md.headers, rows: md.rows, merges: [] }
            else sheets[name] = { headers: [], rows: [[String(data)]], merges: [] }
          }
        }
      }
      const statusMap = args.statusMap && typeof args.statusMap === 'object' && !Array.isArray(args.statusMap) ? args.statusMap : {}
      // AI 没给结构化数据但给了 markdown 表格文本时自动解析
      if (!headers.length && !rows.length && !sheets) {
        const md = parseMarkdownTable(args.content || args.text || args.markdown || '')
        if (md) { headers = md.headers; rows = md.rows }
      }
      if (!headers.length && !rows.length && !sheets) return { ok: false, message: '缺少表格数据：传 headers+rows 数组，markdown 表格文本放 content，或 sheets 多工作表对象' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (isProtectedLocal(args.path)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
          const existed = fs.existsSync(args.path)
          let snapId = null
          if (existed) {
            const snap = snapshots.backupLocal(args.path)
            if (!snap.ok) return { ok: false, message: `已取消写入：原文件备份失败（${snap.reason}）` }
            snapId = snap.id
          }
          fs.mkdirSync(path.dirname(args.path), { recursive: true })
          const size = await createXlsx(args.path, { headers, rows, sheets, merges, styles, statusMap, theme: args.theme })
          const desc = sheets ? `${Object.keys(sheets).length} 个工作表（${Object.keys(sheets).join('、')}）` : `${headers.length}列 × ${rows.length + (headers.length ? 1 : 0)}行`
          return {
            ok: true,
            message: `已${existed ? '覆盖' : '创建'} Excel 表格 ${args.path}（${desc}${merges.length ? `，合并 ${merges.length} 处` : ''}${styles.length ? `，样式 ${styles.length} 组` : ''}）`,
            undo: existed ? { type: 'restore_snap', snapId } : { type: 'delete_local', path: args.path }
          }
        } catch (err) {
          return { ok: false, message: `创建表格失败: ${err.message}` }
        }
      }
      // 远程
      const temp = path.join(tmpDir, `ai_xlsx_${Date.now()}_${path.basename(args.path)}`)
      try {
        await createXlsx(temp, { headers, rows, sheets, merges, styles, statusMap, theme: args.theme })
        const existed = await targetExists(args.path, args.target)
        let snapId = null
        if (existed) {
          snapId = genId('snap_')
          const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
          fs.mkdirSync(path.dirname(savePath), { recursive: true })
          const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, savePath, null, true)
          const ok = !!(dl && dl.success)
          snapshots.register(snapId, {
            id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
            deviceId: dev.deviceId, isDirectory: false,
            size: ok ? fs.statSync(savePath).size : 0, ok,
            reason: ok ? '' : '远程原文件备份失败'
          })
          if (!ok) return { ok: false, message: '已取消写入：远程原文件备份失败' }
        }
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已${existed ? '覆盖' : '创建'} ${dev.name} 的 Excel 表格 ${args.path}`,
          undo: existed
            ? { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
            : { type: 'delete_remote', deviceId: dev.deviceId, path: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程创建表格失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async read_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      const render = (table) => {
        if (!table.length) return '（表格为空）'
        const lines = table.map((row) => row.map((c) => String(c ?? '')).join(' | '))
        const text = lines.join('\n')
        return text.length > READ_LIMIT ? text.slice(0, READ_LIMIT) + '\n...(内容过长已截断)' : text
      }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: '文件不存在' }
          const names = await listXlsxSheets(args.path)
          const sheetName = args.sheet || names[0]
          const table = await readXlsx(args.path, sheetName)
          const sheetNote = names.length > 1 ? `（工作表：${names.join('、')}，当前显示"${sheetName}"，读其他表传 sheet 参数）` : ''
          return { ok: true, message: render(table) + sheetNote }
        } catch (err) {
          return { ok: false, message: `读取表格失败: ${err.message}` }
        }
      }
      const temp = path.join(tmpDir, `ai_read_xlsx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const r = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!r || !r.success) return { ok: false, message: `下载远程文件失败: ${(r && r.error) || '未知错误'}` }
        const table = await readXlsx(temp, args.sheet)
        return { ok: true, message: render(table) }
      } catch (err) {
        return { ok: false, message: `远程读取表格失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async append_table_rows(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const rows = Array.isArray(args.rows) ? args.rows : []
      if (!rows.length) return { ok: false, message: '缺少 rows（要追加的数据行）' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: `文件不存在：${args.path}。先用 create_table 创建` }
          const snap = snapshots.backupLocal(args.path)
          if (!snap.ok) return { ok: false, message: `已取消追加：原文件备份失败（${snap.reason}）` }
          await appendXlsxRows(args.path, rows, args.sheet)
          return {
            ok: true,
            message: `已向 ${args.path} 追加 ${rows.length} 行，可用 read_table 检查结果`,
            undo: { type: 'restore_snap', snapId: snap.id }
          }
        } catch (err) {
          return { ok: false, message: `追加表格行失败: ${err.message}` }
        }
      }
      const temp = path.join(tmpDir, `ai_app_xlsx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `下载远程文件失败: ${(dl && dl.error) || '未知错误'}` }
        const blk = legacyDocWriteBlock(temp)
        if (blk) return { ok: false, message: '远程文件是旧版 .doc：' + blk }
        const snapId = genId('snap_')
        const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        fs.copyFileSync(temp, savePath)
        snapshots.register(snapId, {
          id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
          deviceId: dev.deviceId, isDirectory: false, size: fs.statSync(savePath).size, ok: true, reason: ''
        })
        await appendXlsxRows(temp, rows)
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已向 ${dev.name} 的 ${args.path} 追加 ${rows.length} 行`,
          undo: { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程追加表格行失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async modify_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      // 批量：cells = {"B2": 值, ...} 或 [{cell, value}]；单个：cell + value
      const cells = (args.cells && typeof args.cells === 'object' && !Array.isArray(args.cells) && Object.keys(args.cells).length)
        ? args.cells
        : (Array.isArray(args.cells) && args.cells.length ? args.cells : null)
      if (!cells && !args.cell) return { ok: false, message: '缺少 cell（单元格引用如 B2）或 cells（批量对象/数组）' }
      if (!cells && args.value === undefined) return { ok: false, message: '缺少 value（新值）' }
      const cellCount = cells ? (Array.isArray(cells) ? cells.length : Object.keys(cells).length) : 0
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: `文件不存在：${args.path}。先用 create_table 创建` }
          const snap = snapshots.backupLocal(args.path)
          if (!snap.ok) return { ok: false, message: `已取消修改：原文件备份失败（${snap.reason}）` }
          if (cells) await modifyXlsxCells(args.path, cells, args.sheet)
          else await modifyXlsxCell(args.path, args.cell, args.value, args.sheet)
          return {
            ok: true,
            message: cells
              ? `已批量修改 ${args.path} 的 ${cellCount} 个单元格，可用 read_table 检查结果`
              : `已把 ${args.path} 的 ${String(args.cell).toUpperCase()} 改为 ${String(args.value)}，可用 read_table 检查结果`,
            undo: { type: 'restore_snap', snapId: snap.id }
          }
        } catch (err) {
          return { ok: false, message: `修改单元格失败: ${err.message}` }
        }
      }
      const temp = path.join(tmpDir, `ai_mod_xlsx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `下载远程文件失败: ${(dl && dl.error) || '未知错误'}` }
        const blk = legacyDocWriteBlock(temp)
        if (blk) return { ok: false, message: '远程文件是旧版 .doc：' + blk }
        const snapId = genId('snap_')
        const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        fs.copyFileSync(temp, savePath)
        snapshots.register(snapId, {
          id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
          deviceId: dev.deviceId, isDirectory: false, size: fs.statSync(savePath).size, ok: true, reason: ''
        })
        if (cells) await modifyXlsxCells(temp, cells, args.sheet)
        else await modifyXlsxCell(temp, args.cell, args.value)
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: cells
            ? `已批量修改 ${dev.name} 的 ${args.path} 的 ${cellCount} 个单元格`
            : `已修改 ${dev.name} 的 ${args.path} 单元格 ${String(args.cell).toUpperCase()}`,
          undo: { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程修改单元格失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    async format_table(args) {
      if (!args.path) return { ok: false, message: '缺少 path' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (!dev) {
        try {
          if (!fs.existsSync(args.path)) return { ok: false, message: `文件不存在：${args.path}` }
          const snap = snapshots.backupLocal(args.path)
          if (!snap.ok) return { ok: false, message: `已取消美化：原文件备份失败（${snap.reason}）` }
          await formatXlsx(args.path, { theme: args.theme })
          return {
            ok: true,
            message: `已美化 ${args.path}（主题表头/自动列宽/冻结首行/边框${args.theme ? `/${args.theme} 主题` : ''}），可用 read_table 检查内容是否完好`,
            undo: { type: 'restore_snap', snapId: snap.id }
          }
        } catch (err) {
          return { ok: false, message: `美化表格失败: ${err.message}` }
        }
      }
      const temp = path.join(tmpDir, `ai_fmt_xlsx_${Date.now()}_${path.basename(args.path)}`)
      try {
        const dl = await tcpAgent.downloadFile(dev.deviceId, args.path, temp, null, true)
        if (!dl || !dl.success) return { ok: false, message: `下载远程文件失败: ${(dl && dl.error) || '未知错误'}` }
        const blk = legacyDocWriteBlock(temp)
        if (blk) return { ok: false, message: '远程文件是旧版 .doc：' + blk }
        const snapId = genId('snap_')
        const savePath = path.join(snapshots.snapshotDir(snapId), 'data', path.basename(args.path))
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        fs.copyFileSync(temp, savePath)
        snapshots.register(snapId, {
          id: snapId, time: Date.now(), originalPath: args.path, target: args.target,
          deviceId: dev.deviceId, isDirectory: false, size: fs.statSync(savePath).size, ok: true, reason: ''
        })
        await formatXlsx(temp, { theme: args.theme })
        const up = await tcpAgent.uploadFile(dev.deviceId, temp, path.dirname(args.path), true, null, path.basename(args.path))
        if (!up || !up.success) return { ok: false, message: `上传失败: ${(up && up.error) || '未知错误'}` }
        return {
          ok: true,
          message: `已美化 ${dev.name} 的 ${args.path}`,
          undo: { type: 'restore_snap_remote', snapId, deviceId: dev.deviceId, remotePath: args.path }
        }
      } catch (err) {
        return { ok: false, message: `远程美化表格失败: ${err.message}` }
      } finally {
        try { fs.unlinkSync(temp) } catch {}
      }
    },

    // ===== 上网能力 =====
    async web_search(args) {
      const raw = String(args.query || '').trim()
      if (!raw) return { ok: false, message: '缺少 query（搜索关键词，可用 | 分隔一次传 2-3 个不同角度的词，如「我的世界壁纸|我的世界高清图片下载|minecraft wallpaper」）' }
      const qs = [...new Set(raw.split('|').map((s) => s.trim()).filter(Boolean))].slice(0, 3)
      // ===== 四引擎池（v2.4.93）：单家被拦/改版不拖累全局，跨引擎按链接去重合并 =====
      const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
      const bingParse = (html) => {
        // count=20 + 每引擎上限 15 条（老大拍板）：别搞关键词过滤的花活——AI 自己分辨哪个结果有用，
        // 比脆弱的正则规则可靠（真机实测 Bing 会把"我（汉语汉字）"词条混进结果，靠数量稀释+AI 自辨）
        const out = []
        const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)(?=<li class="b_algo"|<\/ol>|$)/g
        let m
        while ((m = re.exec(html)) && out.length < 15) {
          const title = stripTags(m[2])
          // 摘要 120 字（原 220）：链接+标题已够 AI 判断要不要 web_fetch。本地模型每轮 prefill 吃全部
          // 工具结果，条数 × 长摘要会让多轮任务越跑越慢（老大实测"找图变慢"主因之一），瘦身不减判断力
          const snip = stripTags(m[3]).slice(0, 120)
          if (title) out.push({ title, url: m[1], snip })
        }
        return out
      }
      const bingSearch = async (q, host) => {
        const { status, contentType, buf } = await httpGet(`https://${host}/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=20`, 15000)
        if (status !== 200) throw new Error(`HTTP ${status}`)
        return bingParse(bufToText(buf, contentType))
      }
      const baiduSearch = async (q) => {
        // 百度 /s 对无 cookie 请求常弹"安全验证"：先访问首页领 BAIDUID 等 cookie，带着 cookie 再搜（v2.4.93 实测被拦后加的）
        let cookie = ''
        try {
          const home = await httpGet('https://www.baidu.com/', 8000)
          const sc = home.headers && home.headers['set-cookie']
          const list = Array.isArray(sc) ? sc : (sc ? [sc] : [])
          cookie = list.map((c) => String(c).split(';')[0]).filter((c) => /^(BAIDUID|BIDUPSID|PSTM|H_PS_PSSID)/i.test(c)).join('; ')
        } catch {}
        const { status, contentType, buf } = await httpGet(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20`, 10000, 0, cookie ? { Cookie: cookie } : null)
        if (status !== 200) throw new Error(`HTTP ${status}`)
        const html = bufToText(buf, contentType)
        if (/百度安全验证|wappass\.baidu\.com/.test(html.slice(0, 3000))) throw new Error('被百度安全验证拦截')
        const out = []
        // 结果块：<h3><a href>标题</a></h3> 摘要随行；href 多为百度跳转链（web_fetch 会自动跟随 302 到真实地址）
        const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>([\s\S]*?)(?=<h3|<div id="page"|<div class="page[^"]*"$|$)/g
        let m
        while ((m = re.exec(html)) && out.length < 15) {
          const title = stripTags(m[2])
          const snip = stripTags(m[3]).slice(0, 120)
          if (title && /^https?:\/\//i.test(m[1])) out.push({ title, url: m[1], snip })
        }
        return out
      }
      // DDG 跳转链 //duckduckgo.com/l/?uddg=<编码后的真实地址> → 解出真实地址
      const unwrapDDG = (u) => {
        try {
          if (/duckduckgo\.com\/l\//i.test(u)) {
            const m = /[?&]uddg=([^&]+)/.exec(u)
            if (m) return decodeURIComponent(m[1])
          }
        } catch {}
        return u
      }
      const ddgSearch = async (q) => {
        // 7s 超时：DDG 在国内网络环境普遍不可达（需代理），快败快放手，别拖累整个搜索的竞速窗口
        const { status, contentType, buf } = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=cn-zh`, 7000)
        if (status !== 200) throw new Error(`HTTP ${status}`)
        const html = bufToText(buf, contentType)
        const out = []
        const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<div class="nav-link"|$)/g
        let m
        while ((m = re.exec(html)) && out.length < 15) {
          const url = unwrapDDG(String(m[1]).trim())
          const title = stripTags(m[2])
          const snip = stripTags(m[3]).slice(0, 120)
          if (title && /^https?:\/\//i.test(url)) out.push({ title, url, snip })
        }
        return out
      }
      const ENGINES = [
        { name: '必应国内', run: (q) => bingSearch(q, 'cn.bing.com') },
        { name: '必应国际', run: (q) => bingSearch(q, 'www.bing.com') },
        { name: '百度', run: baiduSearch },
        { name: 'DuckDuckGo', run: ddgSearch }
      ]
      try {
        // 多词 × 多引擎并发（v2.4.62 多词方案 + v2.4.93 四引擎）：一次调用最多 3 词 × 4 引擎全并发，
        // 按链接去重合并——中文内容靠必应国内/百度，国际/英文靠必应国际/DuckDuckGo，单家被拦静默跳过不拖累。
        // 竞速收口：首个引擎出结果后只给慢引擎 1.5s 宽限——防不可达引擎（如无代理时的 DDG）白等拖慢全场
        const results = await Promise.all(qs.map(async (q) => {
          const engResults = ENGINES.map(() => null)
          const engPs = ENGINES.map(async (eng, i) => {
            try { engResults[i] = { name: eng.name, items: await eng.run(q), err: null } }
            catch (err) { engResults[i] = { name: eng.name, items: [], err: err.message } }
          })
          const anyOk = new Promise((res) => { for (const p of engPs) p.then((r) => { if (r && !r.err && r.items.length) res(true) }).catch(() => {}) })
          await Promise.race([anyOk, Promise.all(engPs)])
          await Promise.race([Promise.all(engPs), new Promise((r) => setTimeout(r, 1500))])
          const engines = engResults.filter(Boolean)
          // 引擎顺序合并 + 跨引擎去重，每条结果带来源引擎标注
          const seenEng = new Set()
          const items = []
          for (const eng of engines) {
            for (const it of eng.items) {
              const key = String(it.url).replace(/[#?].*$/, '')
              if (seenEng.has(key)) continue
              seenEng.add(key)
              items.push({ ...it, from: eng.name })
            }
          }
          const failed = engines.filter((e) => e.err).map((e) => `${e.name}（${e.err}）`)
          return { q, items, failed }
        }))
        const seen = new Set()
        const lines = []
        const failedNotes = []
        let total = 0
        let stale = 0 // 近期轮次已出现过的重复链接数（v2.4.72 跨轮去重）
        webSeenSweep()
        for (const r of results) {
          if (r.failed.length) failedNotes.push(`【${r.q}】${r.failed.join('、')}`)
          if (!r.items.length) { lines.push(`【${r.q}】四路引擎都无结果`); continue }
          const cap = qs.length > 1 ? 8 : 15 // 多词每组 8 条控总量，单词保持 15
          const group = []
          for (const it of r.items) {
            const key = String(it.url).replace(/[#?].*$/, '')
            if (seen.has(key)) continue
            seen.add(key)
            // 跨轮去重：换词搜出旧面孔是常态（老大担忧实锤），直接滤掉不占名额，逼 AI 只看新结果
            if (webSeenCheck(it.url)) { stale++; continue }
            total++
            group.push(`${total}. [${it.from}] ${it.title}\n   链接: ${it.url}${it.snip ? '\n   摘要: ' + it.snip : ''}`)
            if (group.length >= cap) break
          }
          if (group.length) lines.push(`【${r.q}】\n${group.join('\n')}`)
        }
        if (!total) {
          if (stale) return { ok: false, message: `「${qs.join('、')}」搜到的 ${stale} 条链接全部与近期搜索结果重复（已过滤）。这些词的角度引擎已经给过了——请换明显不同的关键词（换核心词/换语种/换图源站名/加 site: 定向），或直接 web_fetch 已知网站，禁止再用近似词连搜` }
          const failLine = failedNotes.length ? `\n引擎故障明细：${failedNotes.join('；')}` : ''
          return { ok: false, message: `「${qs.join('、')}」四路引擎（必应国内/必应国际/百度/DuckDuckGo）都没解析出结果（引擎页面结构可能变化或网络受限）。可改用 web_fetch 直接访问已知网站查询${failLine}` }
        }
        // 返回前把新链接标记进记忆，供下一轮去重（含本轮因 cap 被截断的）
        for (const r of results) for (const it of r.items) if (!webSeenCheck(it.url)) webSeenMark(it.url)
        const staleNote = stale ? `，另过滤 ${stale} 条近期已出现过的重复链接` : ''
        const failNote = failedNotes.length ? `\n\n（部分引擎本次故障，结果可能不全：${failedNotes.join('；')}）` : ''
        const header = qs.length > 1 ? `多词 × 四引擎搜索（${qs.join(' | ')}），已按链接去重合并${staleNote}：` : `「${qs[0]}」四引擎搜索结果${staleNote}：`
        return { ok: true, message: `${header}\n${lines.filter(Boolean).join('\n\n')}${failNote}\n\n（结果仅按引擎排序参考，[引擎名] 标注来源；请自行判断哪些与任务真正相关；如需阅读某个结果，用 web_fetch 抓取其链接）` }
      } catch (err) {
        return { ok: false, message: `搜索失败: ${err.message}。可稍后重试或改用 web_fetch 直接访问已知网站` }
      }
    },

    async web_fetch(args) {
      const url = cleanUrl(args.url)
      if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'url 必须以 http:// 或 https:// 开头' }
      const linksMode = /^links?$/i.test(String(args.mode || ''))
      const imagesMode = /^(images?|pics?)$/i.test(String(args.mode || ''))
      const videosMode = /^(videos?|movie|film)$/i.test(String(args.mode || ''))
      // 重复抓取提醒（v2.4.72）：近期读过的链接再抓会带提醒头——不阻断（页面可能更新/历史可能被截断），
      // 但让 AI 意识到自己在空转，优先读未读链接
      const repeatFetch = webSeenCheck(url)
      const noteRepeat = (msg) => repeatFetch
        ? `⚠ 该链接近期已抓取过（重复提醒）：若内容没有新意请勿在此空转，优先处理其他未读过的链接或换资源源。\n\n${msg}`
        : msg
      // 图片直链模式（v2.4.69）：百度图片等 JS 动态站点静态 HTML 里只有占位符，直接走无头渲染——
      // 真浏览器加载 + 滚动触发懒加载后，从 img 属性/网络请求记录里抓真实直链
      if (imagesMode) {
        try {
          const list = await renderPage(url, { mode: 'images' })
          webSeenMark(url)
          const lines = list.map((x, i) => `${i + 1}. ${x.u}${x.w ? `（宽约${x.w}px）` : ''}`)
          return { ok: true, message: noteRepeat(`渲染页面「${url}」抓到 ${list.length} 个图片直链（JS 渲染后的真实地址，按可信度排序）：\n${lines.join('\n')}\n\n提示：直链可能有防盗链/时效性，download_file 失败就换下一个；搜图类站点多为缩略图或中图，对分辨率不满意就换高清图源`) }
        } catch (err) {
          const why = err.message === 'RENDER_UNAVAILABLE' ? '当前环境无渲染能力' : err.message === 'RENDER_NO_IMAGES' ? '渲染后页面上没抓到图片直链' : '渲染失败'
          return { ok: false, message: `图片直链抓取失败（${why}）。建议：①换图源网站 ②改用 mode:links 提取 ③open_url 让用户在浏览器里手动看` }
        }
      }
      // 视频直链模式（v2.4.73）：与 images 同款无头渲染，抓 video/source 标签+网络请求里的视频地址
      if (videosMode) {
        try {
          const list = await renderPage(url, { mode: 'videos' })
          webSeenMark(url)
          const lines = list.map((x, i) => `${i + 1}. ${x.u}${x.tag ? `（${x.tag}）` : ''}`)
          return { ok: true, message: noteRepeat(`渲染页面「${url}」抓到 ${list.length} 个视频地址（JS 渲染后的真实地址）：\n${lines.join('\n')}\n\n提示：①.mp4/.webm 直链可直接 download_file 下载；②.m3u8/.m4s/.ts 是 HLS 切片流不是完整文件，download_file 下不了（只能下到索引/切片），别反复尝试；③带防盗链的直链失败就换下一个；④页面若要点击/登录后才出视频，open_url 让用户手动看`) }
        } catch (err) {
          const why = err.message === 'RENDER_UNAVAILABLE' ? '当前环境无渲染能力' : err.message === 'RENDER_NO_VIDEOS' ? '渲染后页面上没抓到视频地址' : '渲染失败'
          return { ok: false, message: `视频地址抓取失败（${why}）。建议：①换视频源站 ②改用 mode:links 提取页面全部链接 ③open_url 让用户在浏览器里手动看` }
        }
      }
      // 抓到内容后的统一处理（普通请求和无头渲染兜底共用）
      const processResp = async (contentType, html) => {
        const isHtml = /text\/html|application\/xhtml/i.test(contentType || '')
        if (linksMode) {
          if (!isHtml) return { ok: false, message: `该链接不是网页（类型: ${(contentType || '').split(';')[0]}），无法提取链接` }
          const links = extractPageLinks(html, url)
          if (links.length) return { ok: true, message: `页面「${url}」提取到 ${links.length} 个链接：\n${links.join('\n')}` }
          // 静态 HTML 没链接 → 八成是 JS 动态渲染站（老大实锤百度图片类）：无头渲染后再提一轮
          try {
            const html2 = await renderPage(url) // UA 由 renderPage 默认走引擎对齐 engineUA（过盾一致性）
            const links2 = extractPageLinks(html2, url)
            if (links2.length) return { ok: true, message: `页面「${url}」是 JS 动态渲染站（静态抓取无链接），经无头浏览器渲染后提取到 ${links2.length} 个链接：\n${links2.join('\n')}` }
          } catch {}
          return { ok: false, message: '页面上没有提取到图片/文件链接。若是图片站可改用 mode:images 走渲染抓直链，或换个图源' }
        }
        if (!isHtml && !/text\/plain|application\/(json|xml)/i.test(contentType || '')) {
          return { ok: false, message: `该链接不是网页（类型: ${(contentType || '').split(';')[0]}），无法读取内容` }
        }
        // 正文提取双引擎（v2.4.93）：先 Readability 定位主内容块（导航/页脚/广告剔除，正文完整不被垃圾挤掉），
        // 解析失败/正文太短回退旧版全页剥标签（懒加载壳站兜底）
        const article = extractArticleText(html, url, 9000)
        const text = article || htmlToText(html, 9000)
        if (!text) return { ok: false, message: '网页内容为空或无法提取正文' }
        const modeNote = article ? '' : '\n（本页未能定位正文块，以上为全页文本，前段可能是导航/菜单）'
        return { ok: true, message: `网页「${url}」的内容：\n${text}${modeNote}` }
      }
      // 反反爬：换浏览器身份最多试 3 次；全被拦 → 无头渲染兜底（真 Chromium 内核）
      let blockedNote = ''
      for (let i = 0; i < 3; i++) {
        let resp
        try {
          resp = await httpGet(url, 20000, 0, browserHeaders(i))
        } catch (err) {
          return { ok: false, message: `网页抓取失败: ${err.message}` }
        }
        const { status, contentType, buf } = resp
        const html = bufToText(buf, contentType)
        if (status !== 200) {
          if (!looksLikeAntiCrawl(status, html)) return { ok: false, message: `网页请求失败: HTTP ${status} ${url}` }
          blockedNote = `HTTP ${status} 拦截`
          continue
        }
        // 200 但内容是反爬/验证页 → 也算被拦，换身份重试
        if (/text\/html|application\/xhtml/i.test(contentType) && looksLikeAntiCrawl(200, html)) {
          blockedNote = '返回的是反爬/验证页'
          continue
        }
        const rr = await processResp(contentType, html)
        if (rr.ok) webSeenMark(url)
        return rr.ok ? { ...rr, message: noteRepeat(rr.message) } : rr
      }
      try {
        const html = await renderPage(url) // UA 由 renderPage 默认走引擎对齐 engineUA（过盾一致性）
        const r = await processResp('text/html', html)
        if (!r.ok) return r
        webSeenMark(url)
        return { ...r, message: noteRepeat(r.message) + '\n（该站有反爬，以上内容经无头浏览器渲染获取）' }
      } catch (err) {
        const why = err.message === 'RENDER_UNAVAILABLE' ? '当前环境无渲染兜底' : err.message === 'RENDER_EMPTY' ? '渲染兜底拿到空页面' : '渲染兜底也失败'
        return { ok: false, message: `网页被反爬拦截（${blockedNote || '未知原因'}），换身份重试和${why}都没成功。建议：①换别的网站/图源 ②用 open_url 让用户在浏览器里手动看` }
      }
    },

    // ===== 网页文件下载（本机；远程设备请下载后用 transfer_file）=====
    async download_file(args) {
      const url = cleanUrl(args.url)
      if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'url 必须以 http:// 或 https:// 开头（下载文件要传文件直链，网页地址请先用 web_fetch 解析出里面的下载链接）' }
      const sp = String(args.save_path || '').trim()
      if (!sp) return { ok: false, message: '缺少 save_path（完整文件路径或已存在的目录）' }
      const dev = resolveDevice(args.target)
      if (dev && dev._notFound) return { ok: false, message: deviceNotFoundMsg(dev) }
      if (dev) {
        return { ok: false, message: 'download_file 只能下载到本机。要给其他设备：先 download_file 存到本机（如工作台），再用 transfer_file 传过去' }
      }
      // 保存路径：目录则自动命名（响应头文件名 > URL 文件名 > download.bin）
      let outPath = sp
      try { if (fs.statSync(sp).isDirectory()) outPath = '' } catch {}
      if (!outPath || /[\\/]$/.test(sp)) {
        if (outPath) fs.mkdirSync(sp, { recursive: true })
        else fs.mkdirSync(path.dirname(sp), { recursive: true })
        outPath = path.join(sp || outPath, fileNameFromUrl(url) || 'download.bin')
      }
      const isExec = EXECUTABLE_EXTS.has(pathExt(outPath))
      let snap = null
      // 注册活跃下载任务（进度条 UI / 用户取消）
      const dlId = `dl_${Date.now()}_${Math.floor(Math.random() * 10000)}`
      const displayName = path.basename(outPath)
      activeDownloads.set(dlId, { req: null, fileName: displayName })
      emitDownload({ type: 'start', id: dlId, fileName: displayName, url })
      try {
        if (fs.existsSync(outPath)) {
          snap = snapshots.backupLocal(outPath)
          if (!snap.ok) {
            activeDownloads.delete(dlId)
            emitDownload({ type: 'end', id: dlId, ok: false, fileName: displayName, message: '目标已存在且备份失败' })
            return { ok: false, message: `已取消下载：目标已存在且备份失败（${snap.reason}）` }
          }
        }
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        // 反反爬：403/429 类失败自动换浏览器身份 + 补 Referer（防盗链）重试，最多 3 次
        let originRef = ''
        try { originRef = new URL(url).origin + '/' } catch {}
        const dlPlans = [
          { headers: browserHeaders(0), referer: args.referer ? String(args.referer) : '' },
          { headers: browserHeaders(1), referer: String(args.referer || originRef) },
          { headers: browserHeaders(2), referer: String(args.referer || originRef) }
        ]
        const runDl = (plan) => httpDownload(url, outPath, undefined, 0, plan.referer ? { ...plan.headers, Referer: plan.referer } : plan.headers, {
          onReq: (req) => {
            const a = activeDownloads.get(dlId)
            if (!a) return
            a.req = req
            if (a.cancelPending) { try { req.destroy(new Error('下载已被用户取消')) } catch {} }
          },
          onProgress: (received, total) => emitProgressThrottled({ type: 'progress', id: dlId, received, total, fileName: displayName })
        })
        let contentType = '', dispositionName = ''
        try {
          try {
            ;({ contentType, dispositionName } = await runDl(dlPlans[0]))
          } catch (err1) {
            if (!/HTTP (403|429|503)/.test(err1.message)) throw err1 // 非反爬类失败不重试
            // 换身份+补 Referer 再试两次，仍失败则带说明抛给外层
            ;({ contentType, dispositionName } = await runDl(dlPlans[1]).catch((err2) => {
              if (!/HTTP (403|429|503)/.test(err2.message)) throw err2
              return runDl(dlPlans[2])
            }))
          }
        } catch (err) {
          if (/HTTP (403|429|503)/.test(err.message)) {
            err.message = `${err.message}——已自动换 3 组浏览器身份+Referer 绕过仍被拒，该站防盗链较严`
          }
          throw err
        }
        // 响应头指定了文件名且用户给的是目录 → 以头里的名字为准
        let finalPath = outPath
        if (dispositionName && /[\\/]$/.test(String(sp))) {
          const renamed = path.join(path.dirname(outPath), dispositionName.replace(/[\\/:*?"<>|]/g, '_'))
          if (renamed.toLowerCase() !== outPath.toLowerCase()) {
            try { if (fs.existsSync(renamed)) fs.unlinkSync(renamed); fs.renameSync(outPath, renamed); finalPath = renamed } catch {}
          }
        }
        const size = fs.statSync(finalPath).size
        const sizeText = size > 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`
        const warn = isExec ? '。可执行文件已下载，运行前建议用户自行确认安全性' : ''
        activeDownloads.delete(dlId)
        emitDownload({ type: 'end', id: dlId, ok: true, fileName: path.basename(finalPath), size })
        return {
          ok: true,
          message: `已下载 ${path.basename(finalPath)}（${sizeText}，类型 ${contentType.split(';')[0] || '未知'}）→ ${finalPath}${warn}`,
          undo: snap && snap.ok ? { type: 'restore_snap', snapId: snap.id } : { type: 'delete_local', path: finalPath }
        }
      } catch (err) {
        activeDownloads.delete(dlId)
        const cancelled = /取消/.test(err.message)
        emitDownload({ type: 'end', id: dlId, ok: false, fileName: displayName, message: err.message, cancelled })
        return { ok: false, message: cancelled ? '下载已被用户取消' : `下载失败: ${err.message}` }
      }
    },

    // ===== 压缩/解压（本地）=====
    async zip_compress(args) {
      if (!JSZip) return { ok: false, message: '压缩组件不可用' }
      let srcs = Array.isArray(args.src) ? args.src : [args.src]
      srcs = srcs.filter(Boolean)
      if (!srcs.length) return { ok: false, message: '缺少 src（要打包的文件或文件夹）' }
      let zipPath = String(args.zip_path || '')
      if (!zipPath) return { ok: false, message: '缺少 zip_path' }
      if (!/\.zip$/i.test(zipPath)) zipPath += '.zip'
      try {
        for (const s of srcs) {
          if (isProtectedLocal(s)) return { ok: false, message: `拒绝：${s} 在 C 盘保护区` }
          if (!fs.existsSync(s)) return { ok: false, message: `源不存在: ${s}` }
        }
        if (isProtectedLocal(zipPath)) return { ok: false, message: '拒绝：目标在 C 盘保护区' }
        const existed = fs.existsSync(zipPath)
        let snapId = null
        if (existed) {
          const snap = snapshots.backupLocal(zipPath)
          if (!snap.ok) return { ok: false, message: `目标 zip 已存在且备份失败（${snap.reason}），已取消` }
          snapId = snap.id
        }
        const zip = new JSZip()
        const added = new Set()
        const addDir = (dir, zipName) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const zp = `${zipName}/${e.name}`
            const full = path.join(dir, e.name)
            if (e.isDirectory()) addDir(full, zp)
            else if (!added.has(zp)) { added.add(zp); zip.file(zp, fs.readFileSync(full)) }
          }
        }
        for (const s of srcs) {
          const st = fs.statSync(s)
          if (st.isDirectory()) addDir(s, path.basename(s))
          else {
            const bn = path.basename(s)
            if (!added.has(bn)) { added.add(bn); zip.file(bn, fs.readFileSync(s)) }
          }
        }
        const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
        fs.mkdirSync(path.dirname(zipPath), { recursive: true })
        fs.writeFileSync(zipPath, buf)
        return {
          ok: true,
          message: `已打包 ${srcs.length} 个源（共 ${added.size} 个文件）→ ${zipPath}（${fmtSize(buf.length)}）`,
          undo: existed ? { type: 'restore_snap', snapId } : { type: 'delete_local', path: zipPath }
        }
      } catch (err) {
        return { ok: false, message: `压缩失败: ${err.message}` }
      }
    },

    async zip_extract(args) {
      if (!JSZip) return { ok: false, message: '解压组件不可用' }
      const zipPath = String(args.zip_path || '')
      const dest = String(args.dest_dir || '')
      if (!zipPath || !dest) return { ok: false, message: '缺少 zip_path 或 dest_dir' }
      try {
        if (isProtectedLocal(dest)) return { ok: false, message: '拒绝：目标在 C 盘保护区' }
        if (!fs.existsSync(zipPath)) return { ok: false, message: `找不到压缩包: ${zipPath}` }
        const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
        const names = Object.keys(zip.files)
        if (names.some((n) => n.split(/[/\\]/).includes('..'))) return { ok: false, message: 'zip 内含不安全路径，已拒绝解压' }
        fs.mkdirSync(dest, { recursive: true })
        let count = 0
        for (const n of names) {
          const entry = zip.files[n]
          const out = path.join(dest, n)
          if (entry.dir) { fs.mkdirSync(out, { recursive: true }); continue }
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, await entry.async('nodebuffer'))
          count++
        }
        return { ok: true, message: `已解压 ${count} 个文件 → ${dest}`, undo: null }
      } catch (err) {
        return { ok: false, message: `解压失败: ${err.message}` }
      }
    },

    async open_url(args) {
      const url = cleanUrl(args.url)
      if (!/^https?:\/\//i.test(url)) return { ok: false, message: '拒绝：仅支持 http/https 网址（file:// 等其他协议不安全）' }
      try {
        // 工作台通道存在 → 通知渲染层在工作台开网页页签（用户在 Work 模式看的是工作台，不是系统浏览器）
        if (typeof onWorkbenchOpen === 'function') {
          onWorkbenchOpen({ kind: 'url', url })
          return { ok: true, message: `已在工作台打开网页 ${url}` }
        }
        require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
        return { ok: true, message: `已在默认浏览器打开 ${url}` }
      } catch (err) {
        return { ok: false, message: `打开失败: ${err.message}` }
      }
    },

    async open_path(args) {
      const p = String(args.path || '').trim()
      if (!p) return { ok: false, message: '缺少 path' }
      if (isProtectedLocal(p)) return { ok: false, message: '拒绝：C 盘（除桌面）为保护区' }
      const isExec = EXECUTABLE_EXTS.has(pathExt(p))
      // 可执行/脚本类必须经用户审批（__approved 由审批流批准后注入，直接调用一律拒绝）
      if (isExec && args.__approved !== true) {
        return { ok: false, message: `拒绝：打开可执行/脚本类文件（${path.basename(p)}）需要用户在审批卡片上批准` }
      }
      try {
        const st = fs.statSync(p) // 存在性校验，不存在直接报错
        // 文件（非 exe、非文件夹）→ 工作台页签预览；文件夹/exe 仍走系统（文件夹要资源管理器，exe 是运行）
        if (!st.isDirectory() && !isExec && typeof onWorkbenchOpen === 'function') {
          onWorkbenchOpen({ kind: 'file', path: p, name: path.basename(p), size: st.size })
          return { ok: true, message: `已在工作台打开 ${p}` }
        }
        require('child_process').spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' }).unref()
        return { ok: true, message: `已${isExec ? '运行' : '用默认程序打开'} ${p}${st.isDirectory() ? '（文件夹）' : ''}` }
      } catch (err) {
        if (err.code === 'ENOENT') return { ok: false, message: `路径不存在: ${p}` }
        return { ok: false, message: `打开失败: ${err.message}` }
      }
    },

    async remember(args) {
      const fact = String(args.fact || '').trim().slice(0, 300)
      if (!fact) return { ok: false, message: 'fact 不能为空' }
      if (!getSetting || !setSetting) return { ok: false, message: '记忆功能不可用' }
      let list = []
      try { list = JSON.parse(getSetting('aiMemory') || '[]') } catch {}
      if (list.some((m) => m.fact === fact)) return { ok: true, message: `已有相同记忆，无需重复记录：${fact}` }
      if (list.length >= 200) return { ok: false, message: '记忆已达 200 条上限，请先用 forget 清理低价值、重复、过时的记忆后再记录' }
      list.push({ fact, time: Date.now() })
      setSetting('aiMemory', JSON.stringify(list))
      return { ok: true, message: `已记住：${fact}（共 ${list.length} 条记忆）` }
    },

    async forget(args) {
      const fact = String(args.fact || '').trim()
      if (!fact) return { ok: false, message: 'fact 不能为空' }
      if (!getSetting || !setSetting) return { ok: false, message: '记忆功能不可用' }
      let list = []
      try { list = JSON.parse(getSetting('aiMemory') || '[]') } catch {}
      const next = list.filter((m) => m.fact !== fact)
      if (next.length === list.length) {
        // 精确匹配失败时尝试包含匹配（仅当唯一命中时删除）
        const hits = list.filter((m) => m.fact.includes(fact))
        if (hits.length === 1) {
          const kept = list.filter((m) => m !== hits[0])
          setSetting('aiMemory', JSON.stringify(kept))
          return { ok: true, message: `已忘记：${hits[0].fact}` }
        }
        if (hits.length > 1) return { ok: false, message: `有 ${hits.length} 条记忆包含该内容：\n${hits.map((h) => h.fact).join('\n')}\n请用完整的记忆内容重试` }
        return { ok: false, message: '没有找到这条记忆' }
      }
      setSetting('aiMemory', JSON.stringify(next))
      return { ok: true, message: `已忘记：${fact}（剩 ${next.length} 条记忆）` }
    },

    // ===== AI 生成（生图免费 / 生视频付费）=====
    // v2.4.75 图片编辑：args.image 传本地图路径或 URL → 走「图片编辑」模型（图生图，按指令改图保留构图）；
    // 对话式反复修改=每轮把上一轮结果图再传回来（模型无需记忆，客户端闭环）
    async generate_image(args) {
      const prompt = String(args.prompt || '').trim()
      if (!prompt) return { ok: false, message: '缺少 prompt（画面描述）' }
      // 图片编辑模式判定：传了 image 就是改图（v2.4.84：image 支持数组 1-3 张多图合成，第一张=主图）
      const imgRaw = Array.isArray(args.image) ? args.image : (args.image ? [args.image] : [])
      let imgs = imgRaw.map((x) => String(x || '').trim()).filter(Boolean)
      let droppedMulti = 0
      if (imgs.length > 3) { droppedMulti = imgs.length - 3; imgs = imgs.slice(0, 3) }
      let imgPayload = null // 硅基流动 image 参数：http(s) URL、base64 data URI 或其数组（多图）
      if (imgs.length) {
        const payloads = []
        for (const imgIn of imgs) {
          if (/^https?:\/\//i.test(imgIn)) { payloads.push(imgIn); continue }
          const ip = imgIn.replace(/^file:\/\//, '')
          if (!fs.existsSync(ip)) return { ok: false, message: `image 路径不存在：${ip}（传本地图完整路径或 http URL）` }
          const stat = fs.statSync(ip)
          if (stat.size > 10 * 1024 * 1024) return { ok: false, message: '图片超过 10MB，编辑模型不收。建议先压缩或转小图再改' }
          payloads.push(`data:image/${/\.(jpe?g)$/i.test(ip) ? 'jpeg' : /\.(webp)$/i.test(ip) ? 'webp' : 'png'};base64,${fs.readFileSync(ip).toString('base64')}`)
        }
        imgPayload = payloads.length === 1 ? payloads[0] : payloads
      }
      const pvI = resolveModelProvider(getSetting, imgPayload ? 'imageEdit' : 'image')
      let apiKey = (pvI && pvI.apiKey) || getSetting('aiApiKey') || ''
      let baseUrl = (pvI && pvI.baseUrl) || (getSetting('aiBaseUrl') || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
      let model = imgPayload
        ? (getSetting('aiImageEditModel') || 'Qwen/Qwen-Image-Edit-2509')
        : (getSetting('aiImageModel') || 'Kwai-Kolors/Kolors')
      // 主模型是内置 → 生图/改图默认走内置代理（扣积分，与主模型同口径），显式选了图片服务商才走自定义。
      // 内置模型参数固定为服务端内置清单里的生图/改图（自定义的 Kolors 等不经过我们代理）
      if (!pvI && isBuiltinMain(getSetting)) {
        const m = resolveMsmateProvider(getSetting)
        if (m) {
          apiKey = m.apiKey
          baseUrl = m.baseUrl
          model = imgPayload ? 'Qwen/Qwen-Image-Edit-2509' : 'Tongyi-MAI/Z-Image-Turbo'
        }
      }
      if (!apiKey) return { ok: false, message: '未配置 API Key（AI 设置里设置后才能生图）' }
      // size 严格校验（真机变体：模型传了 size:1024 这种非法格式 → 硅基流动 50507 Unknown error）
      // 编辑模式不传 image_size（跟随原图尺寸，Qwen-Image-Edit 类模型要求）
      const size = /^\d{2,4}\s*[xX×]\s*\d{2,4}$/.test(String(args.size || '')) ? String(args.size).replace(/[X×]/i, 'x').replace(/\s+/g, '') : '1024x1024'
      // 来自图片编辑器的合成图（iedit-tmp「编辑_」开头）：纯黑区域=用户涂选位置，自动补黑区语义
      // 老大定调（v2.4.78）：未涂抹区必须原样保留，涂抹区的修改要与周围风格自然融合（好好P图）
      // v2.4.86 卷质量重写（老大拍板）：①核心约束前置（扩散模型对提示词首尾最敏感）；②未涂抹区
      // 忠实还原清单点名 光照/色温/材质/形态/景深/噪点（旧版只到构图颜色纹理，模型没被点名就自由发挥）；
      // ③显式说明黑色是标记不是内容（防画成黑色物体）+ 成品不含遮罩标记；④多图指明第几张带遮罩
      const editorIdx = imgs.findIndex((p) => /iedit-tmp[\\/]编辑_/.test(p))
      const fromEditor = editorIdx >= 0
      // v2.4.87 参考原图（老大拍板）：编辑器勾「参考原图」时带「原_」配对文件（同 base 时间戳）——
      // AI 能看到遮罩区原内容：微调类指令（改色/改细节/改表情）保持原主体形态身份，替换/删除类不受原貌约束。
      // 配对判定：存在「编辑_」+ 存在「原_」（iedit-tmp 编辑器专用目录，误判率≈0）
      const origRefIdx = fromEditor ? imgs.findIndex((p, i) => i !== editorIdx && /iedit-tmp[\\/]原_/.test(p)) : -1
      const hasOrigRef = origRefIdx >= 0
      const baseIdx = editorIdx >= 0 ? editorIdx + 1 : 1
      const baseRef = imgs.length > 1 ? `第 ${baseIdx} 张基准图` : '原图'
      const finalPrompt = imgPayload && fromEditor
        ? `【图片局部重绘任务】${imgs.length > 1 ? `用户提供了 ${imgs.length} 张图：第 ${editorIdx + 1} 张是编辑基准图（纯黑色区域为用户标注的遮罩，只是位置标记，不是图片内容，严禁画成黑色物体），只允许修改该遮罩区域，其余可见图像必须原样保留。${hasOrigRef ? `第 ${origRefIdx + 1} 张是遮罩区域修改前的原貌参考图：供理解遮罩区原有内容——若指令是保留原主体的微调（改颜色/材质/细节/表情等），必须保持原主体的形态、结构与身份特征，仅在指令要求的维度上修改；若指令是替换或删除，按指令执行，不受原貌约束。` : `其余张为多图合成素材。`}` : '图中纯黑色区域是用户标注的遮罩（只是位置标记，不是图片内容，严禁画成黑色物体），只允许修改该区域；其余可见图像是必须原样保留的原图。'}\n【修改要求（仅作用于黑色遮罩区域）】${prompt}\n【硬性约束·最高优先级】1. 遮罩外区域忠实还原：光照方向、色温、材质纹理、物体形态、构图透视、景深、噪点颗粒必须与${baseRef}完全一致，严禁重绘、移动、缩放、增删、调色；2. 遮罩区内新内容与四周原图无缝衔接：色调、光影方向、质感、透视、清晰度保持一致，边缘过渡自然，无拼贴痕迹；3. 输出完整单张图片，成品中不保留黑色遮罩标记`
        : prompt
      // 张数（v2.4.85 文生图 batch_size → v2.4.90 全路径生效，老大反馈：4张+参考图仍出1张）：
      // 文生图优先走接口 batch_size（Kolors 原生）；编辑模式接口不收 batch_size → 首张 + 逐张补齐循环；
      // T2I 模型静默忽略 batch_size 时（如 Qwen-Image）同样由补齐循环兜底，保证交付数=要求数
      const wantCnt = Math.min(4, Math.max(1, parseInt(args.batch, 10) || 1))
      // 负面提示词（v2.4.86 老大拍板）：仅文生图（Kolors 原生支持 negative_prompt，纯白嫖的质量提升）；
      // 编辑模式不传（Qwen-Image-Edit 接口不收，且负面词可能干扰"保留原图"语义）
      const negPrompt = !imgPayload ? 'blurry, low quality, low resolution, deformed, disfigured, extra limbs, bad hands, bad feet, watermark, text artifacts, jpeg artifacts' : ''
      // 推理步数（v2.4.88 治噪点白斑：API 默认 20 步收敛不完全→暗部亮部出白斑、文字被啃花）；
      // v2.4.89 老大拍板可选档位：✨菜单 低30/中50/高100 + 工具 steps 参数，没传默认 30，钳 1-100
      // v2.4.91 老大实测：Qwen-Image-Edit 系最高 50 步；v2.4.92 老大追问换模型兼容——
      // 上限按模型自适应（模型名含 Qwen-Image-Edit → 50，其余编辑/文生图模型 100），换高步数模型不被卡
      const stepsRaw = Math.min(100, Math.max(1, parseInt(args.steps, 10) || 30))
      const stepsCap = /qwen-image-edit/i.test(model) ? 50 : 100
      const steps = Math.min(stepsCap, stepsRaw)
      const editBody = { model, prompt: finalPrompt, image: imgPayload, num_inference_steps: steps }
      const t2iBody = wantCnt > 1
        ? { model, prompt, image_size: size, batch_size: wantCnt, negative_prompt: negPrompt, num_inference_steps: steps }
        : { model, prompt, image_size: size, negative_prompt: negPrompt, num_inference_steps: steps }
      const singleBody = imgPayload ? editBody : { model, prompt, image_size: size, negative_prompt: negPrompt, num_inference_steps: steps }
      // 内置 Z-Image-Turbo（蒸馏模型）：negative_prompt/num_inference_steps 是 Kolors 系参数，走内置时剥掉用上游默认，防不兼容
      if (model === 'Tongyi-MAI/Z-Image-Turbo') {
        delete t2iBody.negative_prompt
        delete t2iBody.num_inference_steps
        delete singleBody.negative_prompt
        delete singleBody.num_inference_steps
      }
      const prog = (msg) => { if (typeof args.progress === 'function') args.progress(msg) }
      let resp
      try {
        resp = await httpJson('POST', `${baseUrl}/images/generations`, apiKey, JSON.stringify(imgPayload ? editBody : t2iBody))
      } catch (err) {
        return { ok: false, message: `${imgPayload ? '图片编辑' : '生图'}请求失败：${err.message}（模型 ${model}）` }
      }
      const urls = (resp && Array.isArray(resp.images) ? resp.images : []).map((x) => x && x.url).filter(Boolean)
      // 补齐循环（v2.4.90）：接口实回张数短于要求数（编辑模式固定单张 / batch_size 被静默忽略）→ 逐张补齐
      let extraFails = 0
      let guard = 0
      while (urls.length < wantCnt && guard < wantCnt) {
        guard++
        prog(`\n⏳ 已出 ${urls.length}/${wantCnt} 张，正在补生成第 ${Math.min(urls.length + 1, wantCnt)} 张…\n`)
        try {
          const more = await httpJson('POST', `${baseUrl}/images/generations`, apiKey, JSON.stringify(singleBody))
          const mu = ((more && Array.isArray(more.images) ? more.images : []).map((x) => x && x.url).filter(Boolean))
          if (mu.length) urls.push(...mu.slice(0, wantCnt - urls.length))
          else extraFails++
        } catch (err) { extraFails++ }
        if (urls.length >= wantCnt || extraFails >= 2) break // 补齐达标或连续失败 2 次止损（保留已出的）
      }
      if (!urls.length) {
        const detail = JSON.stringify(resp || {}).slice(0, 260)
        const hint = resp && resp.code ? '（可能是描述触发内容风控、参数不合法、账户无该模型权限或已欠费：换个描述/不传 size 重试，或到硅基流动控制台确认账户状态）' : ''
        return { ok: false, message: `${imgPayload ? '图片编辑' : '生图'}失败${resp && resp.code ? `（错误码 ${resp.code}）` : ''}：${resp && resp.message ? resp.message : detail}${hint}` }
      }
      // 多张（batch>1）：按序号 _1/_2/… 命名全部下载；单张保持原名（含编辑结果）
      const savedPaths = []
      const failUrls = []
      for (let i = 0; i < urls.length; i++) {
        let savePath = String(args.save_path || '').trim()
        if (!savePath) {
          const dir = path.join(workspaceDir || desktopDir, 'MSMate生成', '图片')
          fs.mkdirSync(dir, { recursive: true })
          savePath = path.join(dir, `${imgPayload ? 'edit' : 'img'}_${Date.now()}.png`)
        } else if (!/\.(png|jpe?g|webp)$/i.test(savePath)) savePath += '.png'
        if (urls.length > 1) {
          const dot = savePath.lastIndexOf('.')
          savePath = dot > 0 ? savePath.slice(0, dot) + `_${i + 1}` + savePath.slice(dot) : savePath + `_${i + 1}`
        }
        try {
          fs.mkdirSync(path.dirname(savePath), { recursive: true })
          await httpDownload(urls[i], savePath, 50 * 1024 * 1024)
          savedPaths.push(savePath)
        } catch (err) { failUrls.push(urls[i]) }
      }
      if (!savedPaths.length) {
        return { ok: true, message: `图片已生成但下载失败。原始链接：${failUrls.join('、')}（可用 download_file 重试）` }
      }
      const imgMd = savedPaths.map((p) => `![${urls.length > 1 ? '生成图片' : (imgPayload ? '编辑结果' : '生成图片')}](${p})`).join('\n')
      if (imgPayload) {
        const multiNote = (droppedMulti ? `；参考图超 3 张上限，已只取前 3 张（丢弃 ${droppedMulti} 张）` : '')
        return { ok: true, message: `图片已编辑并保存：${savedPaths.join('、')}\n${imgMd}\n（编辑模型 ${model}${imgs.length > 1 ? `；多图合成 ${imgs.length} 张` : ''}${urls.length > 1 ? `；同一指令连续生成 ${urls.length} 张变体` : ''}${multiNote}；用户要继续改就把这张新图作为 image 再传）` }
      }
      return { ok: true, message: `图片已生成并保存${urls.length > 1 ? `（${savedPaths.length} 张）` : ''}：${savedPaths.join('、')}\n${imgMd}\n（模型 ${model}${urls.length > 1 ? `；batch ${urls.length} 张` : ''}${failUrls.length ? `；${failUrls.length} 张下载失败可用 download_file 重试` : ''}）` }
    },

    async generate_video(args) {
      const prompt = String(args.prompt || '').trim()
      if (!prompt) return { ok: false, message: '缺少 prompt（视频内容描述）' }
      const pvV = resolveModelProvider(getSetting, 'video')
      const apiKey = (pvV && pvV.apiKey) || getSetting('aiApiKey') || ''
      if (!apiKey) return { ok: false, message: '未配置 API Key（AI 设置里设置后才能生视频）' }
      const baseUrl = (pvV && pvV.baseUrl) || (getSetting('aiBaseUrl') || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
      const model = getSetting('aiVideoModel') || 'Wan-AI/Wan2.2-T2V-A14B'
      let sub
      try {
        sub = await httpJson('POST', `${baseUrl}/video/submit`, apiKey, JSON.stringify({ model, prompt }))
      } catch (err) {
        return { ok: false, message: `视频任务提交失败：${err.message}（模型 ${model}）` }
      }
      const reqId = sub && (sub.requestId || sub.id)
      if (!reqId) return { ok: false, message: `视频任务提交没有返回 requestId：${JSON.stringify(sub || {}).slice(0, 200)}` }
      // 轮询状态：每 6 秒一次，最长 12 分钟
      const deadline = Date.now() + 12 * 60 * 1000
      let url = null
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000))
        let st
        try {
          st = await httpJson('GET', `${baseUrl}/video/status?id=${encodeURIComponent(reqId)}`, apiKey, null)
        } catch (err) {
          continue // 单次状态查询失败不打断（网络抖动），继续等下一轮
        }
        if (String(st.status) === 'Succeed') {
          url = st.results && st.results.videos && st.results.videos[0] && st.results.videos[0].url
          if (!url) return { ok: false, message: '视频生成完成但没拿到下载链接' }
          break
        }
        if (String(st.status) === 'Failed') return { ok: false, message: `视频生成失败：${JSON.stringify(st).slice(0, 200)}（内容或参数可能触发风控，换个描述试试）` }
      }
      if (!url) return { ok: false, message: '视频生成超时（12 分钟无结果），任务可能仍在队列中，请稍后重试' }
      let savePath = String(args.save_path || '').trim()
      if (!savePath) {
        const dir = path.join(workspaceDir || desktopDir, 'MSMate生成', '视频')
        fs.mkdirSync(dir, { recursive: true })
        savePath = path.join(dir, `video_${Date.now()}.mp4`)
      } else if (!/\.(mp4|webm|mov)$/i.test(savePath)) savePath += '.mp4'
      try {
        fs.mkdirSync(path.dirname(savePath), { recursive: true })
        await httpDownload(url, savePath, 200 * 1024 * 1024)
      } catch (err) {
        return { ok: true, message: `视频已生成但下载失败：${err.message}。原始链接：${url}（可用 download_file 重试）` }
      }
      return { ok: true, message: `视频已生成并保存：${savePath}\n[▶ 播放生成视频](${savePath})\n（模型 ${model}）` }
    },

    // delegate 由 agent 层调度（execDelegate），正常不会走到这里
    async delegate() {
      return { ok: false, message: 'delegate 由系统调度，请直接输出 tool 块调用' }
    }
  }

  // 结构化数组参数白名单：这些参数本来就是数组语义（批量/表格行/样式组），不受"参数别传数组"护栏拦截
  const STRUCTURAL_ARRAY_PARAMS = new Set(['src', 'headers', 'rows', 'styles', 'merges', 'sheets', 'paragraphs', 'replacements', 'cells', 'questions'])

  async function execute(name, args) {
    const fn = impl[name]
    if (!fn) return { ok: false, message: `未知工具: ${name}` }
    // 参数数组净化（小模型常见误用：把多个值塞进数组）——单元素数组自动拆包，多元素数组拒绝并教学
    const clean = {}
    const badArr = []
    for (const [k, v] of Object.entries(args || {})) {
      if (Array.isArray(v) && !STRUCTURAL_ARRAY_PARAMS.has(k)) {
        if (v.length === 1 && ['string', 'number', 'boolean'].includes(typeof v[0])) clean[k] = v[0]
        else badArr.push(k)
      } else {
        clean[k] = v
      }
    }
    if (badArr.length) {
      return { ok: false, message: `参数 ${badArr.join('、')} 不能传数组（只接受单个值）。要批量操作（如下载多张图）就发多个 ${name} 调用，一轮里可以同时发多个并行执行，每个调用各传各的参数` }
    }
    try {
      return await fn(clean)
    } catch (err) {
      log(`工具 ${name} 执行异常: ${err.message}`)
      return { ok: false, message: `执行异常: ${err.message}` }
    }
  }

  // ===== 撤销执行器（检查点回滚用）=====
  async function applyUndo(record) {
    if (!record) return { ok: true, message: '（无可撤销内容）' }
    try {
      switch (record.type) {
        case 'delete_local': {
          // 撤销"新建/复制"：删除新增的文件或文件夹
          if (!fs.existsSync(record.path)) return { ok: true, message: '（已不存在，跳过）' }
          fs.rmSync(record.path, { recursive: true, force: true })
          return { ok: true, message: `已删除新增的 ${record.path}` }
        }
        case 'restore_snap': {
          const r = snapshots.restore(record.snapId)
          return { ok: r.success, message: r.success ? `已从快照还原` : `快照还原失败: ${r.error}` }
        }
        case 'restore_snap_remote': {
          const meta = snapshots.list().find((m) => m.id === record.snapId)
          if (!meta || !meta.ok) return { ok: false, message: '快照不存在，无法还原远程文件' }
          const dataDir = path.join(snapshots.dir, record.snapId, 'data')
          const files = fs.readdirSync(dataDir)
          if (!files.length) return { ok: false, message: '快照数据为空' }
          const localFile = path.join(dataDir, files[0])
          const parent = path.dirname(record.remotePath)
          const up = await tcpAgent.uploadFile(record.deviceId, localFile, parent, true, null, path.basename(record.remotePath))
          if (!up || !up.success) return { ok: false, message: `远程还原上传失败: ${(up && up.error) || '未知错误'}` }
          return { ok: true, message: '已从快照还原远程文件' }
        }
        case 'delete_remote': {
          const res = await tcpAgent.deleteRemoteFile(record.deviceId, record.path)
          if (!res || !res.success) return { ok: false, message: `远程删除失败: ${(res && res.error) || ''}` }
          return { ok: true, message: `已删除新增的远程文件 ${record.path}` }
        }
        case 'move_back': {
          const target = path.join(record.dest, path.basename(record.src))
          if (record.deviceId) {
            const res = await tcpAgent.moveRemoteFile(record.deviceId, record.src, record.dest)
            if (!res || !res.success) return { ok: false, message: `远程移回失败: ${(res && res.error) || ''}` }
            return { ok: true, message: `已移回 ${record.src} → ${record.dest}` }
          }
          try {
            fs.renameSync(record.src, target)
          } catch {
            copyRecursive(record.src, target)
            fs.rmSync(record.src, { recursive: true, force: true })
          }
          return { ok: true, message: `已移回 ${record.src} → ${record.dest}` }
        }
        case 'rename_back': {
          const oldName = path.basename(record.oldPath)
          const target = path.join(path.dirname(record.newPath), oldName)
          if (record.deviceId) {
            const res = await tcpAgent.renameRemoteFile(record.deviceId, record.newPath, oldName)
            if (!res || !res.success) return { ok: false, message: `远程改回失败: ${(res && res.error) || ''}` }
            return { ok: true, message: `已改回 ${oldName}` }
          }
          fs.renameSync(record.newPath, target)
          return { ok: true, message: `已改回 ${oldName}` }
        }
        default:
          return { ok: false, message: `未知撤销类型: ${record.type}` }
      }
    } catch (err) {
      return { ok: false, message: `撤销异常: ${err.message}` }
    }
  }

  // 生成给用户看的操作摘要
  function summarize(name, args = {}) {
    const t = args.target && args.target !== 'local' ? `[${args.target}] ` : ''
    switch (name) {
      case 'list_dir': return `${t}浏览目录 ${args.path || 'root'}`
      case 'read_file': return `${t}读取文件 ${args.path}`
      case 'write_file': return `${t}写入文件 ${args.path}`
      case 'create_folder': return `${t}创建文件夹 ${args.path}`
      case 'copy_path': return `${t}复制 ${args.src} → ${args.dest_dir}`
      case 'move_path': return `${t}移动 ${args.src} → ${args.dest_dir}`
      case 'transfer_file': return `${t}跨设备复制 ${args.src_path}（${args.src_target || 'local'} → ${args.dest_target || 'local'}）`
      case 'rename_path': return `${t}重命名 ${args.path} → ${args.new_name}`
      case 'delete_path': return `${t}删除 ${args.path}`
      case 'search_files': return `${t}搜索 ${args.dir} 中的 "${args.keyword}"`
      case 'view_image': return `${t}识图：${args.paths ? `${Array.isArray(args.paths) ? args.paths.length : String(args.paths).split(/[;\n]/).filter(Boolean).length} 张图` : args.path}${args.question ? `（${args.question}）` : ''}`
      case 'remove_bg': return `${t}抠图去背景：${args.path}`
      case 'screenshot': return `${t}截图（${args.scope || 'webview'}）`
      case 'update_notes': return `${t}${args.mode === 'read' ? '读大记事本' : args.mode === 'replace' ? '重写大记事本' : '记大记事本'}`
      case 'generate_image': return args.image ? `AI 编辑图片：${String(args.prompt || '').slice(0, 40)}` : `AI 生图：${String(args.prompt || '').slice(0, 40)}`
      case 'generate_video': return `AI 生视频：${String(args.prompt || '').slice(0, 40)}`
      case 'create_word': return `${t}创建 Word 文档 ${args.path}`
      case 'read_word': return `${t}读取 Word 文档 ${args.path}`
      case 'read_pdf': return `${t}读取 PDF 文档 ${args.path}`
      case 'read_word_tables': return `${t}读取 Word 表格清单 ${args.path}`
      case 'format_word_table': return `${t}格式化 Word 表格 ${args.path}`
      case 'add_word_table': return `${t}插入 Word 表格 ${args.path}`
      case 'edit_word_table': return `${t}编辑 Word 表格 ${args.path}`
      case 'pdf_to_image': return `${t}PDF 转图片 ${args.path}`
      case 'fix_paper_paging': return `${t}全文分页修复 ${args.path}`
      case 'svg_to_png': return `${t}SVG 转图片 ${args.path}`
      case 'read_word_format': return `${t}解析 Word 格式 ${args.path}${args.mode === 'full' ? '（逐段全量）' : '（格式指纹）'}`
      case 'read_paper_spec': return `${t}蒸馏论文模板格式规范书 ${args.path}`
      case 'check_paper_format': return `${t}体检产出论文 ${args.path}`
      case 'apply_word_format': return `${t}套用格式到 ${args.path}`
      case 'apply_word_template': return `${t}按学校模板重排 ${args.path}`
      case 'modify_word': {
        const w = args.mode === 'replace' ? '重写' : (args.mode === 'edit' ? '精准替换' : '修改')
        const n = args.mode === 'edit' && Array.isArray(args.replacements) ? `（${args.replacements.length} 处）` : ''
        return `${t}${w} Word 文档 ${args.path}${n}`
      }
      case 'create_pptx': return `${t}创建 PPT 演示文稿 ${args.path}`
      case 'read_pptx': return `${t}读取 PPT 内容 ${args.path}`
      case 'edit_pptx': {
        const n = Array.isArray(args.replacements) ? `（${args.replacements.length} 处）` : ''
        return `${t}替换 PPT 文字 ${args.path}${n}`
      }
      case 'create_table': return `${t}创建 Excel 表格 ${args.path}`
      case 'render_html': return `${t}渲染 ${args.path} 为图片`
      case 'read_table': return `${t}读取 Excel 表格 ${args.path}`
      case 'append_table_rows': return `${t}向 ${args.path} 追加表格行`
      case 'modify_table': return args.cells
        ? `${t}批量修改 ${args.path} 的 ${Array.isArray(args.cells) ? args.cells.length : Object.keys(args.cells).length} 个单元格`
        : `${t}修改 ${args.path} 的单元格 ${args.cell}`
      case 'format_table': return `${t}美化表格 ${args.path} 的格式`
      case 'remember': return `记住偏好：${args.fact}`
      case 'forget': return `忘记偏好：${args.fact}`
      case 'web_search': return `联网搜索：${args.query}`
      case 'web_fetch': return `读取网页：${args.url}`
      case 'download_file': return `下载文件：${args.url} → ${args.save_path || '默认位置'}`
      case 'open_url': return `打开网址：${args.url}`
      case 'open_path': return `打开 ${args.path}`
      case 'zip_compress': return `压缩打包 → ${args.zip_path}`
      case 'zip_extract': return `解压 ${args.zip_path}`
      case 'delegate': return `委派子任务：${args.title || String(args.task || '').slice(0, 30)}`
      case 'ask_user': return `向用户提问：${String((args.questions && args.questions[0] && args.questions[0].question) || '').slice(0, 40)}`
      default: return `${t}${name}`
    }
  }

  // 取消下载任务（进度条 UI 的取消按钮 / agent abort 联动都走这里）
  function cancelDownload(id) {
    const a = activeDownloads.get(id)
    if (!a) return { ok: false, message: '没有这个下载任务' }
    if (a.req) {
      try { a.req.destroy(new Error('下载已被用户取消')) } catch {}
      return { ok: true, message: '已取消' }
    }
    // 请求还没建立：标记，让建立后立即自毁
    a.cancelPending = true
    return { ok: true, message: '已标记取消' }
  }

  return {
    defs: TOOL_DEFS,
    toolPromptSection: buildToolPromptSection(),
    execute,
    classify,
    summarize,
    applyUndo,
    isProtectedLocal,
    cancelDownload,
    activeDownloads
  }
}

// 多运营商解析（v2.4.61）：设置顶部维护"服务商库"（aiProviderList: [{id,name,baseUrl,apiKey}]），
// 每个模型槽位（main/vision/image/video/voice）可独立选运营商（aiXxxProvider 存 id）；空=沿用旧全局配置
function resolveModelProvider(getSetting, ability) {
  const pid = String(getSetting(`ai${ability.charAt(0).toUpperCase()}${ability.slice(1)}Provider`) || '').trim()
  if (!pid) return null
  let list = []
  try { list = JSON.parse(getSetting('aiProviderList') || '[]') || [] } catch {}
  const p = list.find((x) => x && x.id === pid)
  if (!p || !String(p.baseUrl || '').trim() || !String(p.apiKey || '').trim()) return null
  return { baseUrl: String(p.baseUrl).trim().replace(/\/+$/, ''), apiKey: String(p.apiKey).trim() }
}

// 内置主模型判定 + 内置代理解析（v2.7.14）：主模型是 [内置] 前缀时，生图/看图默认走 MSMate 内置代理
// （扣积分，和主模型同一计费口径），用户显式给槽位选了自定义服务商才走自定义
function isBuiltinMain(getSetting) {
  return String(getSetting('aiModel') || '').startsWith('[内置]')
}
function resolveMsmateProvider(getSetting) {
  try {
    const list = JSON.parse(getSetting('aiProviderList') || '[]') || []
    const m = list.find((x) => x && x.id === 'msmate' && x.apiKey && x.baseUrl)
    return m ? { baseUrl: String(m.baseUrl).trim().replace(/\/+$/, ''), apiKey: String(m.apiKey).trim() } : null
  } catch { return null }
}

module.exports = { createTools, resolveModelProvider, httpJson, httpDownload, extractArticleText, httpGet }
