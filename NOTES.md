# MSMate 任务状态

## 2026-09-09 v2.7.12-wip：app.js 模块化拆分（8361 行 → 6 文件，为插件化铺路）

- **背景**：老大确认要走"账号体系 + 合作开发 + 插件化"路线。8361 行 app.js 单文件是两大障碍：多人协作必冲突、功能拆不出插件。本轮做纯物理拆分（零逻辑改动），沿用项目已有 `<script>` 顺序加载模式（icons.js/webchat.js 先例）
- **三刀拆分**（按依赖方向验证后从安全到复杂）：
  1. `work.js`（2877 行）：Work AI 助手整块（原 5817-8361）——AI_PROVIDERS/多会话/设置/消息渲染/AI 事件/markdown 渲染
  2. `word-embed.js`（525 行）：WPS/Word 内嵌 + 通用网页页签（原 889-1436）
  3. `word-rich.js`（4142 行）：Word 所见即所得引擎（原 1437-5808 巨块）
  - `app.js` 仅剩 830 行：互传核心（1-888）+ 全局错误处理 + DOMContentLoaded 启动段
- **安全性论证**：普通 script 顶层 let/const 在全局词法环境跨文件可见，函数互调不受拆分影响；拆前全文件扫描顶层立即执行语句仅 1 处（registerProcessor('ptt-capture')，同块自包含）；5 处顶层事件监听全为延迟回调，DOMContentLoaded 在全部 script 执行后才触发，加载顺序 = 原物理顺序（app → word-embed → word-rich → work）
- **冒烟同步**：workbench-smoke（21 处读取）/global-ui-smoke/md-render-smoke 全部改为四文件拼接读取——以后断言跨文件仍有效，防拆分漏检
- **验证矩阵**：4 文件 node --check 全过；workbench 1066 全绿 + global-ui 73 全绿 + md-render/session/transfer/pair/data-sync/history-persist/workspace-web 全过；真机启动 15 秒零脚本错误（MSC_USER_DATA 隔离 userData，不影响老大正开着的实例）
- **后续**：这是插件化阶段一（内部模块化）。阶段二 = 挑边界清晰的功能按插件接口试点；合作者各领一个文件域开发，冲突面归零

## 2026-09-08 v2.7.11：SVG 源码乱码全面清剿（间接赋值形态 7 处补修）

- **背景**：v2.7.1 发布后老大实测又抓到两处乱码（引用文件胶囊 / 删除会话按钮）——v2.7.1 只修了 `textContent = iconSvg(...)` 直接赋值，**iconSvg 串经变量/参数间接落到 textContent 的形态全漏了**。本轮全局清剿
- **补修 7 处（app.js）**：①输入框引用胶囊 renderChatRefs `icon.textContent = meta.icon` ②用户消息引用胶囊（appendUserMsg 链）同款 ③会话菜单 mkBtn（重命名/置顶/删除按钮）`b.textContent = txt` ④文件夹批量栏 mkBtn（加入工作台/引用AI/发送）⑤富文本编辑器 fmtBtn（引用块/清除格式）⑥工作台页签右键菜单 `btn.textContent = label` ⑦资源面板右键菜单 showWbFsMenu `it.textContent = a.label`（整个右键菜单全乱码）+ 翻页箭头 mk 统一 innerHTML 纪律
- **方法论固化**：直接赋值正则扫不出来时，要按**数据流**追——列出全部 `textContent =` 赋值行（144 处）人工核对右边是变量的，再追变量来源是否 iconSvg 串；冒烟新增 7 点 include 断言 + `textContent = (meta.icon|a.label|txt|label)` 防回归正则 → **1066 全绿**；global-ui 73 全绿
- **发布**：v2.7.11（老大定名），产物目录 release_build_v2711；probe-asar-v271.js 版本参数化（argv[3] 传期望版本，一脚本多版复用）

## 2026-09-08 v2.7.1：默认人设微调（称呼/声音）+ 工作台 SVG 源码乱码修复

- **人设微调（prompt.js PERSONA_DEFAULT）**：温度行尾补默认称呼用法——默认称呼「你」，关怀句/收尾句自然带出，不每句塞；新增「声音」小节——说话体口语小词自然带（从/个/的），不播报腔，像随口说话不像念稿
- **SVG 源码乱码修复（app.js 3 处）**：v2.7.0 emoji→Lucide 图标全量替换时，`wbViewIcon`（工作台预览顶栏文件图标）与文件夹网格 2 处图片加载失败回退仍用 `textContent` 赋值——SVG 字符串被当纯文本原样显示（工作台上方一行 `<!-- @license lucide-static...` 乱码）。统一改 `innerHTML`；全局正则扫描确认零残留
- **测试**：workbench-smoke 新增 v2.7.1 断言区（称呼/声音落盘 + innerHTML 修复 + textContent 残留正则扫描）→ **1060 全绿**；global-ui-smoke 73 全绿；语法检查过
- **发布**：package.json 2.7.1；产物目录 release_build_v271；GitHub Release v2.7.1

## 2026-09-08 v2.7.0：UI 大更新（新图标+执事风主题）+ 默认人设 v0.4（莫西/雷娜塔）

- **新图标全量换装**：老大提供的 M 形猫耳图（MSMate 紫负空间藏猫脸）→ `assets/icon.png`+`icon.ico`（16~256 六档）；generate-icons.js 从"程序化画图"改为"源图→缩放→ICO 打包"（`node generate-icons.js 源图.png` 一条命令换装）；UI 内 5 处 MS 字标（顶栏/关于/更新弹窗/AI 头像×2）全换 `<img>` 猫耳
- **CSS token 化**：main.css 4364 行全量走查——补定义 9 个一直静默回退的变量（--bg/--bg-card/--accent-weak 等）、6 组 rgb 三元组（透明底 rgba(var(--x-rgb),α) 化兼容 Chromium 108）、88 处 hex+55 处 rgba 收编、color-mix 8 处失效样式换 rgba 等价（正式包 Electron 22=Chromium 108 不支持 color-mix！）、圆角 15 档收 6 档（浅色大圆角/深色紧凑系）、画笔遮罩异色紫统一 MSMate 紫
- **三主题架构**（token 覆盖层组件零改动）：执事风（新默认：灰阶分层+输入框凹陷+用户气泡弱紫）/ 经典白（原样保留）/ 深色；设置双下拉三选一实时生效持久化；老存档 light 自动迁移 butler；index.html 头部脚本防闪烁
- **Lucide 图标全量替换**：icons.js 内联 SVG（0 新依赖，Electron 22 探针过）——emoji 图标钮/文件图标/页签/空态全量换 16px 线性风格；修 getFileIcon 返回图标名未包 iconSvg 的 bug（界面显示英文单词）
- **文案大厂化**：底部快捷键提示条整条删除（手册兜底）；弹窗长说明改「一句结论+了解更多折叠」；报错 9 处补「下一步」指引；术语统一「会话」；下载到→下载位置/磁盘信息去重/关于页补版权；UI 文案去"喵"（正文零电波纪律）
- **布局**：面板 header 减负（加入工作台/上级图标化+路径框弹性收缩）；Work 资源面板页签竖排字修复（nowrap+flex-shrink:0）
- **按钮纪律**：.btn-accent 从绿色改 MSMate 紫（配对/对讲/上传选中/发送对方归主色），绿色只留语义（在线/成功/进度）
- **默认人设 v0.4**：PERSONA_DEFAULT 常量进 prompt.js 角色段（工作名莫西/真名雷娜塔只被问才说/三无姐姐感/称呼用"你"+可取昵称+情境变称呼如"夜猫子"/寡言结论先行/用户规则>表现层/留白条款）；子Agent 不注入（isChild 隔离）；网页版走同链自动生效；正文带性格（推翻旧"正文零人设"定稿）
- **测试**：workbench-smoke 新增 5 条人设断言（常量/双名/主链注入/子Agent 隔离/优先级）→ **1056 全绿**；global-ui-smoke 73 全绿；Electron 22 探针过（无新依赖）；发布后 probe-asar-cssselect-post.js 抽查

## 2026-09-08 v2.6.0：工具手册化（渐进式披露，主规则瘦身 + ai/manuals 六册）

- **架构**：主规则只留工具目录简述（brief），深度说明/踩坑经验/标准工作流迁入 `ai/manuals/` 六册（word文档/论文排版/表格/图片视频/网络下载/跨设备协作）——AI 首次用某工具前先 read_file 对应手册再动手（对标 Agent Skills 渐进式披露，省 token + 逻辑清晰 + 加新工具只补一册）
- **TOOL_DEFS 改造（tools.js）**：29 个低频工具加 `manual` 字段，params/desc 瘦身为目录级简签；`buildToolPromptSection` 双轨渲染——core 工具全量行，manual 工具行尾带 `→ 手册：ai_manuals/<册>.md`
- **prompt.js 四管道**：`manualsSourceDir`（源目录）/ `releaseManualsTo`（启动释放到工作区 ai_manuals/，每次启动覆盖=升级即更新）/ `loadManualsMarkdown`（网页版全文拼接）/ `manualsIndexSection`（索引段，目录缺失整段省略）
- **接线**：main.js 启动调 `releaseManualsTo(workspaceDir)`；agent.js `buildSystemPrompt` 注入 `manualsDir`（工作区 ai_manuals/）
- **网页版**：`assembleWebRulesDoc` 把六册全文附在规则文档末尾（网页模型不能 read_file），并加防幻觉条款"禁止对 ai_manuals/ 路径发起 read_file"
- **EXPERIENCE/SOP 拆分**：工具域绑定的经验与流程挪进对应手册；主规则保留 15 条通用经验 + 8 条通用流程，"这就是全部"防编造条款保留
- **收益实测**：完整系统提示词 ≈6.6K tokens（工具清单 8207 字符 ≈2.7K）
- **测试**：workbench-smoke 24 处断言源随迁手册（readManual 助手）+ 新增 v2.6.0 手册化断言区（六册落盘非空/manual 字段计数=29/releaseManualsTo 真跑/索引段/网页版拼接/双端接线），1051/1051 全绿；`test/probe-asar-v260.js` 发布后抽查 asar 内六册手册
- 教训：**断言源跟代码走**——desc 内容迁到手册后，断言必须同步改读手册文件，否则静态冒烟出现"假失败"掩盖真问题

## 2026-09-03 v2.4.37：聊天记录拖拽 + 输入框动态增高 + WPS/Word 内嵌工作台

- ①**微信/QQ 拖文字进对话框=引用块**：dragover 放行 text/plain|text/html → drop 优先 Files/json，兜底取文字（text/html 剥壳：br/块级标签转换行+实体解码，空则退 plain）→ buildQuoteRef('聊天记录', text) 进 chip 体系+toast
- ②**chatInput 动态增高**：fitChatInput（input/resize 触发；height=auto→min(scrollHeight, max(110, 40vh))）；CSS 旧 max-height:110px 删除（改 JS 内联 maxHeight）；发送清空/回滚回填/语音插入三处程序化改值后补算（回滚和语音用 dispatchEvent('input') 触发）
- ③**WPS/Word 内嵌工作台（实验性，ai/winembed.js）**：
  - 探测：reg query UserChoice ProgId → kind（wps/word）→ HKCR ProgId shell open command → exe 路径；老大机器实测=WPS.Docx.6 + wps.exe
  - 帮手：长驻 PowerShell（Add-Type P/Invoke 一次，stdin 行协议 EMBED/MOVE/HIDE/SHOW/CLOSE/ALIVE/QUIT）；EMBED=Start-Process 开文档 → 轮询 8s 抓窗（双层：spawn PID 白名单进程名 + 标题前缀 baseName——后者覆盖 ksolaunch 启动器委托）→ 剥标题栏/加 WS_CHILD → SetParent 到主窗口 HWND（getNativeWindowHandle）→ MoveWindow
  - **响应匹配必须 FIFO**（waitersQ），seq 映射在多命令在途时会错位；帮手未 READY 要等（Add-Type 首编 2-4s，exec 内 10s 轮询）
  - 生命周期：切页签 wbEmbedSync→HIDE、切回页签 SHOW（不重挂）、移出页签/换会话/清空→CLOSE（WM_CLOSE，未保存 WPS 自己弹窗）、app before-quit→manager.quit()（帮手 EOF 把窗口 SetParent 回桌面+SW_RESTORE，文档不丢）
  - 渲染层 mountWbDocxRich 自动择优：handler 有 exe→mountWbDocxEmbed（占位条：状态+内置编辑按钮+wb-embed-host）；ResizeObserver 同步物理像素坐标（×devicePixelRatio）；ALIVE 3s 轮询（用户关窗→收尾提示）；**回退链=内嵌失败→外部打开+waitFileChange 300s 自动刷新→「内置编辑」按钮随时切内置（wbDocxForceBuiltin 单次豁免）**
  - 已知限制：WPS 多标签整合模式新文档进已有窗口抓不到→自动走回退；Word 受保护视图窗口可抓但标题可能不匹配→靠 PID 层
- 教训：**PowerShell 帮手协议要按"串行+FIFO 响应"设计**，别按 seq 匹配；抓窗口要同时准备 PID 层和标题层（启动器进程委托很常见）
- smoke workbench 210/210（winembed 纯函数真跑）+ 全套件通过

## 2026-09-03 v2.4.36：Word 打开即编辑（一体化）+ 保存报错修复 + 外部编辑兜底

- ①**docx 打开即编辑**：openPreview docx 分支直进 mountWbDocxRich，✏️编辑/📝所见即所得双按钮+只读 iframe 预览整链删除（wbOfficeToIframe/attachWbDocxEdit/attachWbDocxRich/attachWbIframeQuote/fs:word-edit IPC 全删）；编辑器工具条 = 🔍查找替换(面板) + ¶H1-3/BIUS/❝/列表/🧹 + 🖥外部编辑 + 保存；查找替换=TreeWalker 遍历文本节点 DOM 替换（同段落内匹配，Enter/按钮触发，替换后标脏）；编辑器 attachWbTextQuote(ed) 划词胶囊保留
- ②**保存报错真因**=文件被 WPS/Word 独占锁（node 复现引擎链路 create→replace→readback 全对，排除引擎问题）；修法=fs:word-rich-save 写前 docxLockError 探测（openSync r+ 探 EPERM/EBUSY/EACCES→"请先关闭 WPS/Word 里的文档"）+ catch 兜底同文案（编辑器内容还在，关了再 Ctrl+S 即可）
- ③**外部编辑路线**（老大点名"引用默认打开软件"）：🖥外部编辑按钮 = fileMtime 记基线 → openFile 交系统默认程序（WPS/Office 内核保真 100%）→ fs:wait-file-change 轮询 mtime（800ms×180s）→ 变化自动重新载入编辑器；脏标记 = input 事件→保存键加 ●；带未保存修改去外部编辑先 confirm
- 教训：**"保存失败"先分清引擎 vs 环境**——文件锁类报错（EPERM/EBUSY）要在写前探测给人话，不要让裸 err.message 去猜
- smoke workbench 177/177 + 全套件通过

## 2026-09-03 v2.4.35：会话切换工作台隔离 + 双击自动入台

- ①切换/清空会话后工作台预览残留+清单串会话（三个真 bug）：
  - **残留根因**=renderWbView 提前返回条件 `wbRenderedKey === wbActiveKey` 在两者同为 null 时误判 → 加 `it &&` 前置（无激活项强制重绘出空状态）
  - **串写根因**=wbPersist 定时器触发时才读 work.active，300ms 内切会话把旧清单写进新会话的 workbench.json（"工作台没存到聊天项目记录"的真凶）→ 修法=排程时锁定 wbPersistSid + 触发时 `work.active !== wbPersistSid` 直接作废 + activateSession 开头 `await wbPersistFlush()` 把待写清单落回旧会话
  - **加载竞态**=loadWorkbench 无守卫，快速切换旧结果覆盖新会话 → wbLoadSeq 序号守卫（wbGet 后+fsExists 循环后双校验）
- ②文件夹双击本地文件=**自动 addToWorkbench 并激活页签**（已在台内直接 wbActiveKey=wk 重绘，不重复 toast）；文件夹内临时预览通道 renderWbFolderFile/nav.previewPath/◀▶切图 整链删除（能力在文件页签全保留），死样式 .wb-fs-file-view/.wb-fs-file-body/.wb-fs-navbtns/.wb-fs-count 一并清掉
- ③顺带修复 navs 持久化断链：preload wbSet 只传 items、main wb:set 丢 navs、wb:get 只回 items → 现在全链透传（wb:get 返回 {items, navs}，app.js loadWorkbench 本来就认这个格式）
- 教训：**防串写要用"排程时锁定归属+触发时校验"**，只靠触发时读当前状态在异步定时器场景必串；loadWorkbench 这类"异步加载+渲染"必须有代际守卫
- smoke workbench 176/176

## 2026-09-03 v2.4.34：划选引用胶囊体系 + docx 划词 + Word 所见即所得

- ①「添加到对话」全走引用胶囊体系：点击划词胶囊 → `work._appendChatRef(buildQuoteRef(文件名, 选文))`，ref 格式=`[来自文件 xxx 的划选]\n> 逐行`；输入框上方出现 📝 chip（悬停 title 看全文，×可删，Backspace 兜底），发送后聊天记录 appendUserMsg 收拢标记行+后续 > 行渲染成同款胶囊卡片（AI 收到原文不变）
- ②划词范围扩展：chatInput/chatList 也挂 attachWbTextQuote（来源标「聊天记录」，div 分支带 contains 判定防误弹）；**docx 预览 iframe 内划词**=attachWbIframeQuote（srcdoc 同源绑 contentDocument mouseup，坐标+iframe rect 换算回父页面；iframe mousedown 也要隐藏胶囊）
- ③Word 所见即所得（高保真路线）：docx 页签/文件夹预览加「📝 所见即所得」→ mountWbDocxRich（contenteditable 贴 mammoth HTML + 工具条 ¶/H1-3/B/I/U/S/引用/列表/清格式，execCommand+mousedown preventDefault 保选区）→ Ctrl+S：htmlToWordParas DOM 走块级递归（emitWbBlock/emitWbStructured），**run 级样式直传**（bold/italic/underline/strike/highlight/color/font），表格→markdown 行字符串、图片→`![](data:URI)` 字符串（**normParagraphs 对象路径不收 image/table 段，必须走字符串通道**）→ IPC fs:word-rich-save（data URI base64 落临时文件 wbimg-* + 快照 wb-edit-* + modifyDocx(replace)）
- 引擎小改：createDocx 支持 **noTitle**（编辑已有文档不再自动插文件名标题段）
- 功能验证：noTitle+runs+表格 markdown→docx→readDocxText 全对；smoke workbench 164/164
- 保真边界：mammoth 起稿时已丢失的样式（原文档主题色/字体模板）不会恢复，保存按排版主题重排；这正是"高保真"在现有引擎下的上限，快照兜底

## 2026-09-03 v2.4.33：卡片进工作台 + 资源管理器定位 + 划词胶囊 + 阅读加固

- ①聊天文件卡片点击：系统打开 → **加入工作台预览**（fsExists 先确认在，失效路径 toast 不入台；非 Work 模式自动 modeWork.click() 切换）；卡片右侧 📂 原样保留
- ②工作台工具条加「资源管理器」按钮（wbLocateBtn → shell.showItemInFolder 定位当前浏览文件；远程文件隐藏+提示先取回）
- ③**划词胶囊**：工作台文本编辑器（含 md）+ 文件夹内文本预览，选中文字松开左键浮出「➕ 添加到对话」（.wb-quote-cap 固定定位跟随鼠标），点击往 chatInput 追加 `[来自文件 xxx 的划选]\n> 逐行引用` 块（>2000 字截断）；**胶囊是单例**（mountWbEditor 每次切页重建 textarea，多份胶囊+document 监听会泄漏）
- ④阅读加固：prompt.js 规则 9 追加「只为知道内容时纯文本直读，禁止解析成 HTML/markdown 再读」——read_word 本来就是剥壳纯文本，这是防模型多此一举的条款
- smoke workbench 143/143

## 2026-09-03 v2.4.32：工作台 Word 精准编辑 + 本轮增强全家桶

- **Word 编辑（老大选的精准修改路线）**：docx 页签和文件夹内预览都挂「✏️ 编辑」条 → 查找/替换多行表单（＋一组/留空=删除）→ IPC `fs:word-edit` → 复用 ai/office `modifyDocx(edit)` 两层引擎（同 run 内替换完整保格式；跨 run 段落重建保 pPr+首 run 格式）；覆盖前快照 wb-edit-*；替换成功自动刷新预览，未找到的词明确上报
- 本轮其余：Excel 网格编辑器（单元格写回+公式+多 Sheet+快照）、文件夹网格图片缩略图、多选批量条、文件夹内 ←/→ 切图+滚轮缩放、目录过滤、快速访问磁贴、新建文件/文件夹、wbFolderNav 位置记忆持久化、md 分屏预览、资源面板防挤没（flex 1 1 300px）
- smoke workbench 129/129；功能验证：真建 docx→替换→读回校验通过（replaced=2、missed 上报正确）
- 远程文件不挂编辑条（本机引擎读不到远程路径，取回本地再改）

## 2026-09-03 v2.4.31 补2：资源面板防挤没 + 文件夹图片缩略图

- ①资源面板被挤没真因：dual-pane overflow hidden + 工作台 flex-shrink 0 不让步，总 min 宽超出时资源面板整体溢出被裁掉。修法=工作台 `flex: 0 1 58%`（空间不足先缩自己）+ 资源面板 `flex: 1 1 300px`
- ②文件夹网格本地图片出缩略图（.wb-fs-thumb 48px cover + lazy loading，加载失败回落表情图标；远程图片文件路径本机无效故仍用图标）
- smoke 116 项；打包到 release_2431b\win-unpacked（release_2431 被运行中的新版锁住）
- 工作台完善方案（快速访问/新建文件/标签右键+排序/目录过滤/图片切换缩放/多选批量/位置记忆/md 预览）已列给老大挑选

## 2026-09-03 v2.4.31 补：分割条错位修复 + 占比反转 + 文件夹内嵌浏览器

- 老大实测反馈两连：①切 Work 没动画/工作台拖不动资源面板/资源面板占比不该最大 ②文件夹也要能在工作台里打开浏览
- **①拖不动的真凶（2.4.30 就有）**：#splitWorkbench 在 DOM 里排在 resourcePanel **后面**——Work 模式下本地/远程 section 被搬进资源面板后，分割条悬到最右边去了，永远拖不到。修法=index.html 里把分割条挪到 workbenchPanel 与 resourcePanel **之间**（smoke 加了 DOM 顺序断言防回归）
- ②占比反转：工作台默认 flex-basis 42%→**58%**（资源面板变最小，保底 min-width 300px）；**一次性作废旧 localStorage msmate_wb_workbench_w**（ver 标记 msmate_wb_workbench_w_ver=31，旧值是分割条错位时代存的垃圾，不清会盖掉新默认）
- ③文件夹内嵌浏览器：openPreview 遇 isDir → renderWbFolder=资源管理器大图标网格（.wb-fs-grid auto-fill 96px 列，文件夹优先+中文排序）；导航态 wbFolderNav[key]={cwd,stack,sel,previewPath}；单击选中、双击文件夹进入（stack 支持上级回退）、双击文件内嵌预览（renderWbFolderFile 带「← 返回」回网格）；本地走 listLocalDirectory、远程走 listRemoteDirectory（设备离线提示）；文本只读 pre（文件夹内文件不进 wbEditors 编辑态）
- ④顺手修：远程文件标签预览原来是坏图坏链（file:// 指向远程路径本机没有）→ 统一兜底「远程文件不直接预览，点发送取回本机」；docx/xlsx iframe 样式抽 wbOfficeToIframe、媒体嵌入抽 wbMediaHTML（预览区/文件夹内预览共用）
- 回归：workbench-smoke 扩到 115 项全过；重打包 release_2431\win-unpacked（release_build 仍被运行中的旧版锁着）

## 2026-09-03 v2.4.31：工作台标签页 + 内嵌预览/编辑器（一次到位）

- 老大四连需求：①Work 开启时工作台向右挤开的入场动画（同侧栏聊天框丝滑过渡）②工作台顶端加标签栏，加文件后自动切换预览 ③预览一律在工作台内打开，废除独立弹窗 ④界面分布对齐图二（标签栏+工具条+预览编辑区+底部统计）
- **标签页替代清单**（用户三选一定稿）：#wbTabs-bar=横向滚动页签（图标+名称+×移出，active 高亮同 res-tab 风格，dirty 未保存圆点）；#wbView=工具条（图标/名/meta + 保存(Ctrl+S)/引用AI/发送/系统打开）+ #wbViewBody 预览编辑区
- 预览内嵌：原 #previewModal 弹窗及 CSS 全删；openPreview 渲染进 #wbViewBody，统一包 `<div class="wb-view-content">`（wbRenderedKey+querySelector 判断复用防重渲染闪屏；iframe/媒体场景 content 高度 100%）
- **纯文本可编辑**：text 类不再只读 pre，改为 textarea.wb-editor；编辑态 wbEditors[key]={saved,content,dirty,timer}切页保留；Ctrl+S 保存（编辑器内+document 双拦截）+ 停顿 1.5s 自动保存；Tab 键插 4 空格不丢焦点；保存走新 IPC fs:write-text-file（preload writeTextFile），**覆盖前自动快照到 mswork_snapshots/wb-edit-***（危险操作备份铁律）；>2MB 拒写引导系统打开
- 标签交互：addToWorkbench 后自动激活新加入第一项（自动切换预览定稿）；移出有 dirty 内容 confirm 确认；清空统计 dirty 数提示；removeWbItem 后自动落最后一项；激活页签 scrollIntoView
- 布局：工作台默认宽 34%→42%，min-width 240→320，**去 55% 上限**（拖拽上限改=rect.width-300 保底资源面板）；分割条 6px→10px 加宽+线条常显（::after 常驻 border-light 色，hover 变 accent）；入场动画=@keyframes wbIn（from flex-basis:160px+opacity:.35，动画到自然值，body.work-mode 挂类触发，display:none→显示自动重放）
- 换会话 loadWorkbench 重置 wbActiveKey/wbRenderedKey/wbEditors（未保存内容不跨会话带）
- 回归：workbench-smoke 重写扩到 102 项（新增标签/编辑器/writeTextFile/动画/旧样式清除断言）全过；其余 20 个冒烟全过（selfcontain/transfer/zip 需沙箱外跑——写 D 盘随机临时目录）
- 打包坑复现：app.asar 又被运行中的 MSMate 锁死，产物在 release_2431\win-unpacked（旧版还开着挪不动，关掉后挪回 release_build）
- 安装包 release_2431\win-unpacked\MSMate.exe（目录版，nsis 待挪后打）

## 2026-09-03 v2.4.30：Work 工作台 + 资源面板页签 + 内置预览

- 老大设计（经三轮对齐定稿）：**工作台=用户自己汇集文件的暂存台**（不是 AI workspace 目录）；右侧面板变「本地(默认)|远程」页签资源面板；选中/拖拽收进工作台；三面板可拖拽调宽；内置预览图片/文本/视频/音频/PDF/网页/Word/Excel；一次到位
- **布局重构核心技巧**：本地/远程两个 `<section class="panel">` 在 Work 模式下 appendChild 搬进 #resLocalHome/#resRemoteHome（DOM 移动保留全部事件监听，列表面板零复写）；切回互联模式搬回 .dual-pane。body.work-mode 类控制工作台/资源面板/分割条/加入按钮显隐
- 工作台数据：state.wbItems=[{path,name,isDir,size,origin('local'|deviceId),originName,_missing}]；按会话持久化到 userData/ai-chat/sessions/<id>/workbench.json（IPC wb:get/wb:set，activateSession 时 loadWorkbench 加载+本地项 fsExists 存在性检查）；去重键 origin|path
- 四个入口：面板头部「加入工作台」按钮（仅 Work 模式显示）、右键菜单 to-workbench（仅 Work 模式显示）、文件拖进工作台列表（remote 拖入必须置 remoteDragConsumed=true 防触发拖出下载）、全部带选中批量
- 预览（#previewModal）：图片/视频/音频=file:// URL（fileToUrl 处理中文/#/? 转义）；PDF/本地 html=iframe；文本=IPC fs:read-text-file（>1MB 引导系统打开）；**docx=mammoth、xlsx=exceljs 在主进程渲染 HTML，前端 iframe srcdoc+内联样式隔离**（新依赖 mammoth）；pptx 等返回 fallback:true 自动转系统默认程序打开；previewCurrent 防换文件后旧渲染覆盖；关闭时 pause 媒体
- 操作：👁预览（仅可预览类型）/💬引用（work._appendChatRef 暴露闭包内 appendChatRef，格式 [引用文件:] / [引用远程文件: 名|deviceId|路径]）/↗系统打开（夹=openInExplorer）/×移出；底部「发送对方」=本地项→uploadFile 到 connectedDeviceId+remotePath，远程项→downloadFile 回本机（origin≠当前连接设备则提示）；清空带 confirm 不删文件本体
- 三面板拖宽：#splitSidebar（main-content 里 sidebar 与 dual-pane 之间）+ #splitWorkbench（dual-pane 里工作台与资源面板之间），仅 body.work-mode 显示；拖拽中 body.splitting 关过渡动画；宽度存 localStorage msmate_wb_sidebar_w / msmate_wb_workbench_w，进 Work 模式恢复
- 踩坑：远程列表 dragstart 的 items 只有 {path,isDir} 没有 name——工作台收件时 name 从 path 兜底解析；PowerShell 5 不支持 && 分隔符（用 ;）；electron-builder 输出目录参数必须带引号防 PowerShell 拆词
- 回归：新增 test/workbench-smoke.js（81 项静态一致性）全过；global-ui 73/loop-guard/session/data-sync 冒烟全过
- 安装包 release_build\MSMate Setup 2.4.30.exe

## 2026-09-03 v2.4.29：顶栏本机卡优化 + 全局设置 + 自定义背景图层

- 用户三连需求：①顶栏"本机名/IP"裸文字不好看 ②要全局设置（大而全）③自定义背景图（滑块+模糊+缩放可调）
- ①顶栏：info-item 双行裸文字+✏️表情按钮 → `.local-device-pill` 胶囊卡（显示器 SVG 图标+设备名粗体+IP 等宽字体，bg-panel+边框+sm 阴影，同 Work 会话条厚度）；修改设备名入口移入全局设置→设备页（showEditDeviceNameModal 与 confirmRename 的 own-name 分支已删）；顶栏新增⚙全局设置按钮（SVG 齿轮，Work 模式 AI 设置⚙保留）
- ②全局设置弹窗 #globalSettingsModal：样式复用 ai-settings-layout（左导航+右面板+取消/保存 footer），但导航用独立 .gs-nav-item 类——**不挂 ai-nav-item**（AI 设置的导航 querySelectorAll('.ai-nav-item') 是全局的，混挂会互相打断 active 态）。四页签：
  - 外观：主题（与 AI 设置共用 msmate_theme 存储，双向联动）+ 背景自定义（缩略图/选图/清除 + 5 滑块：背景不透明度/模糊度/缩放度/遮罩暗化/面板透明度）
  - 互联与传输：默认下载目录（复用 changeDownloadDir）/ 设备扫描频率（udpDiscovery.setBroadcastInterval 钳 1-10s，settings:set 热更新+启动加载）/ 启动页面（跟随上次=localStorage msmate_last_mode，setMode 时记录）
  - 设备：本机设备名（setDeviceName）+ IP 只读
  - 关于：版本+操作手册
- ③背景图层：body 直下 #appBackground（fixed z0，#app 升 z1）= .app-bg-img（background cover + opacity/blur/scale CSS 变量）+ .app-bg-mask（黑色遮罩 opacity 变量）；has-bg 类切主面板半透明 `rgba(var(--panel-rgb), var(--panel-alpha))`——**Electron 22=Chrome 108 没有 color-mix**，所以 JS 按 theme 设 --panel-rgb（dark=37,37,55/light=255,255,255），applyTheme 里同步刷
- 主进程：ui:pick-background（nativeImage 长边 2560 JPEG 82 压缩，存 userData/ui-background.jpg 返 dataUrl）/ ui:get-background / ui:clear-background
- 交互细节：滑块 input 即时预览，打开弹窗时快照，取消/点遮罩还原；保存写 uiAppearance + scanIntervalMs + startupMode
- 回归：新增 test/global-ui-smoke.js（扫描频率钳制 7 项 + gs* ID/绑定/CSS 规则静态一致性 66 项=73 全过）；loop-guard/session/data-sync/device-resolve/plan 冒烟全过
- 踩坑：release_build\win-unpacked\app.asar 被系统进程锁死删不掉（无窗口进程查不到），绕路 `-c.directories.output=release_build29` 打包后把 exe 挪回 release_build（PowerShell 传 `-c.x=y` 必须加引号防拆词）
- 安装包 release_build\MSMate Setup 2.4.29.exe

## 2026-09-03 v2.4.28：小模型"回一句就结束"三层护栏（小咪扒歌案例）

- 真机案例（另一台电脑，2.4.27）：用户"以后叫你小咪+扒凹凸世界主题曲"→ Qwen3-8B 长篇 think 跑题后只回"称呼用户为小咪"7 个字就结束回合。非崩溃：后端零工具零清单走"普通回复结束"出口被放行，体感=卡死/早停
- 三层修复（agent.js runLoop）：
  ①光说不练拦截：任务型消息（长度≥12 或含任务动词）+首轮零工具零清单+净正文意向词/≤20 字碎片/<think> 剥空 → 点名"禁止只说不做立刻真调用"（lazyNudged 每轮 1 次）
  ②纯思考空正文点名：分离式 reasoning 输出后 content 为空 → 原直接报错"AI 返回了空内容"结束；改先点名"停止长篇思考直接行动"（emptyNudged 每轮 1 次），再犯才报错
  ③净正文判定剥 <think>（含未闭合截断形态），防思考里的首先/然后误触发意向判断
- 定性：触发源=模型侧（长思考小模型输出病，与裸清单/假进度同族），接不住=本地护栏缺口（已补）
- 回归：loop-guard-smoke 新增 2.12 光说不练/2.13 误伤校验（闲聊+完整长回答）/2.14 内联 think 无闭合/2.15 分离式 reasoning 空正文；全部通过
- 安装包 release_build\MSMate Setup 2.4.28.exe

## 2026-09-03 v2.4.27：裸清单自愈两连修（引号逗号切碎 + 建板后重发绕圈）

- 用户真机案例：小模型吐 `items: ["…下载到桌面，否则告知用户无合法下载渠道"] doing:[1]`——两层问题
- ①引号内逗号切碎：tryRepairBarePlan 按逗号硬切数组内容，项内含中文逗号被切成两个半句（板建了但项是碎的）→ 含引号时改按引号对提取整项（/["'][^"']+["']/g），无引号维持逗号切
- ②建板后重发绕圈：tryRepairBarePlan 开头 if(this.plan) return false，板已存在时模型再吐裸清单 → 不自愈不拦截 → 当普通回复收尾 → 用户点"继续"又原样重发 → 原地绕圈。修复=runLoop 无 calls 路径新增"裸清单重发拦截"（plan 存在+行首 items:/doing:/done: → 点名"清单早建好了，去干活用 task_plan 传 done:N"，barePlanReNudged 计数拦 2 次防烧轮次，2 次后放行防死循环）
- 回归：loop-guard-smoke 新增 2.10（引号逗号场景板恰好 2 项+内嵌逗号完整+doing 解析）/2.11（重发被点名纠正+不误判收尾）；安装包 release_build\MSMate Setup 2.4.27.exe

## 2026-09-03 v2.4.26：限流提示贴底 + 提问卡片简化

- 限流提示位置修复（用户反馈"在 AI 消息顶部得爬楼"）：v2.4.24 追加式提示行从不移除、被后续轮次埋楼上；v2.4.25 复用元素但没挪位置——修复=showRetryWait 每次显示都 list.appendChild(el)（对已挂载元素=移动到末尾），永远贴着最新消息
- 提问卡片（ask_user）简洁大气版：头部 ❓emoji+"AI 想先问清楚再动手"长文案 → 「AI 提问」紫色胶囊徽章+题数+待回答状态pill；问题字号 12.5→13.5px+行高 1.5+break-word；选项去重边框改浅底色块（hover/picked 才上 accent 边）；按钮 btn-xs→btn-sm 且右对齐（.ask-actions 补了缺失的基础布局样式）；卡片加padding 12x14+accent 淡边
- 兼容：statusEl(.tool-card-status) 保留在 ask-head 内，setToolStatus/tool_done 兜底逻辑不受影响
- 安装包 release_build\MSMate Setup 2.4.26.exe

## 2026-09-03 v2.4.25：429 无限重试 + "模型繁忙"等待转圈

- 用户定稿方案：429 不再有次数上限——提示"（转圈）模型繁忙，正在等待…"，60 秒一轮跨分钟窗口无限重试，直到成功或用户手动停止，不主动打断任务进程
- agent.js：重试循环重构 while(true)（原 for attempt<=3 装不下无限）——429 走 wait429 计数无限等，非 429 维持 fastFails<2 快重试；新增 _sleepAbortable(ms)（abort signal 打断 sleep，点停止立即生效不干等满 60 秒）；提示文案带"已等待 N 次，点发送键可停止"
- UI：tool_parse_error → showRetryWait 单条复用元素（转圈+黄色左边线 .retry-waiting，无限重试不刷屏，挂 work._ctx._retryNotice 按会话隔离）；content_delta/reasoning_delta/error/run_done/chat_cleared 五处 hideRetryWait 撤提示；appendRetryNotice（v2.4.24 一次性版）已删
- 回归：loop-guard-smoke 新增 2.9.1（一直 429 → abort 立即生效 <5s、不再发新请求、无 error 事件）；安装包 release_build\MSMate Setup 2.4.25.exe

## 2026-09-03 v2.4.24：429 限流重试修复（真机"直接停止回复"）

- 根因两条：①UI 把 tool_parse_error 直接 break 吞掉——重试全程静默，用户只看到卡 25 秒然后报错停止，以为重试没工作；②等待 25 秒不够——TPM 是**每分钟**窗口，25 秒还在同一个耗尽的窗口里，重试必再撞 429，3 次烧完彻底停
- 修复：agent.js 重试加档 30s→60s→60s（最多 4 试 3 重试，跨分钟窗口），等待秒数写进提示文案；retry429Waits 实例属性为测试缝（loop-guard-smoke 注入 [20,20,20] 免真等）
- UI：tool_parse_error → appendRetryNotice 轻提示行（复用 steps-notice 样式）；**不能 finalizeAssistant**——assistant_start 每轮只发一次、content_delta 在无气泡时直接丢内容，关了气泡重试成功后流没地方写
- 回归：loop-guard-smoke 新增 2.9 场景（前 2 次抛 429→第 3 次成功+UI 收到 2 次提示），15 项全过；安装包 release_build\MSMate Setup 2.4.24.exe
- 备注：截图里 402 是账户余额不足（非限流），不可重试属正确行为，充值即恢复

## 2026-09-03 v2.4.23：语音模型可配置 + 发送键图标化

- 语音模型可配置（对齐识图模型模式）：设置里新增"语音模型"输入框+常用清单下拉（➕添加/🗑删除，voiceModelList 独立维护）；config 键 aiVoiceModel（agent.js getConfig/setConfig 允许清空回退默认）；主进程 voice-transcribe 改读 getSetting('aiVoiceModel')，空则默认 FunAudioLLM/SenseVoiceSmall
- 发送键图标化：文字按钮改紫色圆角方块+白色向上箭头 SVG（.chat-send align-self:stretch 与文本框同高、--accent 底、active 缩放）；运行中=箭头翻转朝下+变红（.aborting，CSS transform 控制）兼做停止按钮
- 接线五处：app.js 事件监听/openAiSettings 回显/fillModelSelects 常用清单/saveAiSettings 保存；数据同步打包 settings.json 自动覆盖 aiVoiceModel 无需额外处理
- 回归：office-smoke/loop-guard/session-smoke 全过；安装包 release_build\MSMate Setup 2.4.23.exe
- 教训：PowerShell Set-Content 会给 package.json 加 BOM 导致 electron-builder "Error reading package.json"，改版本号后用 node JSON.stringify 重写去 BOM

## 2026-09-03 v2.4.22：Ctrl+Enter 换行 + 语音输入 + ➕引用按钮

- Ctrl+Enter 换行修复：原 keydown 只区分 shift，Ctrl+Enter 也会发送；现在 Ctrl/Shift+Enter 都是换行（光标处插入），Enter 发送
- 语音输入：输入区麦克风按钮（SVG 线条图标）+ Work 聊天界面按住 V 说话（微信式，松开转文字）；链路=MediaRecorder(webm/opus)→IPC ai:voice-transcribe→主进程手工 multipart POST baseUrl/audio/transcriptions（模型 FunAudioLLM/SenseVoiceSmall，读 settings 的 aiApiKey/aiBaseUrl，Electron22 无全局 fetch 故用 https.request）→文本 insertAtCursor 进输入框
  - V 键护栏：仅 work.mode==='work' 且 workSection 可见；isComposing（拼音组词）不抢键；焦点在其它输入框不抢键；e.repeat/Ctrl/Alt/Meta 忽略；窗口失焦自动停止
  - UI：录音=红色脉冲，识别中=蓝色脉冲；<600ms 当误触丢弃；无 Key 明确报错
- ➕按钮：输入区左侧，点击 selectFiles 多选文件 → appendChatRef 引用胶囊（与拖拽等价）
- 全文件语法过

## 2026-09-03 v2.4.21：中文首行缩进教学补位

- 用户问"写 word 知道正文空两格吗"——引擎早支持（firstLine:true，normal 段 indent firstLine=480twips=2 字符，标题/列表/表格不缩进），但 desc 只在"公文/论文标准件"里带过，一般报告/解析模型不会传
- 教学：create_word desc 新增"**中文版式**：报告/解析/论文/公文类传 firstLine:true——正文首行缩进2字符（'一、标题'下正文空两格的传统版式），现代风策划可不缩进"；prompt.js SOP 第 5 条同步
- office-smoke 回归过

## 2026-09-03 v2.4.20：聊天区主模型快捷切换 + 审批滑块

- 聊天输入区 meta 行新增主模型快捷下拉（chatModelQuick）：选项=用户常用清单（chatModelList）+ 当前模型（不在清单也置顶显示）；切换即 aiSetConfig({model}) 立即生效（agent 每轮读 cfg.model），识图模型不参与；清单增删（fillModelSelects）和设置保存后自动同步刷新
- 审批按钮改滑块开关（approval-switch）：左手动批准(黄)/右自动信任(绿)，knob 滑动动画；updateApprovalTag 适配 .as-label
- 64KB 读取限制答复：read_file 分段可续读（offset），read_word/read_table 尾部硬截断——只影响"读超长文档再改写"场景；生成质量取决于模型+排版教学，与该限制无关；提高上限会吹爆上下文（429 限流元凶），维持现状

## 2026-09-03 v2.4.19：Word 排版五连修（目录/段落层次/图片控制/行距）

用户对罪恶王冠解析提 5 条：①目录空白 ②段落无层次感 ③图片不可控 ④正文拥挤 ⑤美感
- ①目录：域其实生成了（dirty TOC + updateFields），但打开不更新域就是空白——修法：Packer 后处理 document.xml 在 separate/end 域之间**预填静态条目**（标题+点线制表位+h1 加粗/h2h3 缩进），打开即见目录，F9 后变带页码超链接版；失败自动退回纯域
- ②层次感：非标题段落统一 spacing after=120 + line=340（1.4 倍呼吸行距），标题仍走 HEADING_SPACING 前大后小节奏；图片段落也加了 before/after 间距
- ③图片：markdown 语法扩展 ![注](路径 =400) 指定宽度像素等比缩放（上限 2 倍页宽防爆版）、{align:left|right} 控对齐（图注跟随）；loadImage 兼容尖括号路径；modify_word append 同步支持 width
- ④行距：默认 1.4 倍+段后距，desc/prompt 教"嫌挤 1.6 嫌松 1.3"
- ⑤美感：v2.4.18 排版素养条款已覆盖（表格/callout/禁符号）
- word-toc-smoke 12/12 + office/word-upgrade/plan 回归全过

## 2026-09-03 v2.4.18：排版教学去限定词（真机两份 AI 文档暴露"四件套只用于策划书"）

- 用户反馈自家 AI 产的两份文档（罪恶王冠剧情解析/重庆天气报告）与手搓参考差距大；拆 XML 诊断：新引擎能力其实都生效了（标题间距/callout/封面都在），但模型把"四件套"理解成"策划/方案类专用"——解析/报告类退化成大段文字+默认蓝：罪恶王冠 93 段仅 1 表格、天气报告 0 表格（七天预报没用表格！）+ 用 ❖✦ unicode 符号装点门面
- 修复（教学三处）：tools.js create_word desc"SOW 排版素养（任何类型文档都遵守）"+ prompt.js 操作规范第 5 条"排版铁律"（表格强制/callout/cover/accent/禁 unicode 装饰）+ SOP 写文档条目（数据必须表格、大段数据不许裸奔）；去掉"策划/方案类才用"的限定词
- 回归 office-smoke/plan-smoke 全过

## 2026-09-03 v2.4.17：Excel wrap 换行 + rowHeight 行高（对标预算表样例）

- 用户喂第三份手搓样例：拼豆耗材预算表（朴素但灵魂=27 处区块合并 A1:P1 大标题/K51:O52 区块卡 + 备注长文本自动换行 + 行高变化 + 红字强调）
- 查引擎：merges/statusMap/styles 大部分已有；缺 styles 的 wrap（wrapText）和 rowHeight（行高）
- 升级（office.js applyXlsxStyles）：styles 新增 wrap:true（wrapText+valign top 兜底）、valign、rowHeight（range 解析单行/多行设行高）；tools.js desc 教"备注长文本 wrap:true、大标题 merges+行高加粗居中"
- 三份样例学习收官：Trea 策划书（Word 品牌色/信息卡/表格分节）、定岗方案（引擎已覆盖）、结款表（statusMap/日期格式）、预算表（wrap/rowHeight/区块合并）——Office 引擎对齐人工精修，全部有冒烟覆盖
- xlsx-status-smoke 12/12 + office-smoke 76 全过

## 2026-09-03 v2.4.16：Excel 状态条件配色 + 日期格式（对标结款表样例）

- 用户又喂两份样例：定岗方案 docx（手工 5.7KB styles，字段卡排版+克制蓝灰配色——引擎能力已覆盖，靠 2.4.15 四件套教学对齐）+ 论文通结款表 xlsx（人工精修：状态列红绿黄经典三色 + yyyy-mm-dd + 冻结/合并/列宽）
- 查引擎：merges/freeze/autoWidth/zebra 已有；缺①状态条件配色②日期 numFmt
- 升级（office.js）：STATUS_STYLES 经典四色（ok 绿 C6EFCE/006100、bad 红 FFC7CE/9C0006、warn 黄 FFEB9C/9C6500、info 蓝 DDEBF7/1F4E79）+ buildSheet statusMap {"列名或列号":{"值":"ok|bad|warn|info"}} 命中整格上色（粗体深字，覆盖斑马纹）+ Date/yyyy-mm-dd 字符串自动 numFmt；通路补齐 tools.js create_table（args.statusMap + sheets 内嵌 statusMap）→ createXlsx → buildSheet
- tools.js desc 教"状态列务必配 statusMap"；xlsx-status-smoke 9/9 + office-smoke 76 全过

## 2026-09-03 v2.4.15：Word 引擎对标升级（拆解 Trea Work 参考配方）

- 用户给了 Trea Work 做的策划书 docx 对比：拆 XML 得其配方=939 段+43 表格（信息全表格化）+121 处底纹（彩色卡）+品牌定制色（橙 C95716/深棕/灰）+12 级字号+丰富段距节奏（before 480 做分区）
- 我们差距：①只有 3 套固定主题色没法上品牌色 ②无信息卡块型 ③标题无间距节奏显得挤 ④提示词没教"方案类文档用表格分节+品牌色"
- 升级（office.js）：①normTheme 支持对象 {base:"modern", accent:"C95716", 或任意色键单改}——accent 派生到 h1/h2/h3/引用条/表头(白字)/页眉线 ②新段落样式 callout {tone:info|ok|warm|danger}=浅底+左竖线+深字，规则/注意事项/关键结论用 ③HEADING_SPACING 标题前大后小（h1 360/160，h2 260/130，h3 200/110 twips）④tools.js create_word 描述教"策划/方案四件套：accent 品牌色+表格分节+callout+cover"
- word-upgrade-smoke 10/10（accent 派生/三色 callout/间距/单键覆盖/gov 回归）；office-smoke 76 全过

## 2026-09-03 v2.4.14：模糊反馈先问再改（反"闷头猜"偏向）

- 用户反馈：对成果说"不喜欢，再修改修改"，模型（连 DeepSeek-V4-Flash 大模型）不 ask_user 问方向，瞎猜着重做——半月来"防一步一停"提示词（禁止停、直接执行到底、只在"不可推断分歧"才许问）矫枉过正，把模型练成从不提问；"不喜欢"被它自判为"可推断"（换个格式就是）钻了窄缝
- 修复（prompt.js P0 行动原则新增第 4 条）：模糊反馈（不满意却说不出哪里）→ 禁止瞎猜重做，ask_user 列具体维度（格式风格/详略/结构/换模板）一次问清再改；明确说了改哪里→照做不问；执行中小决策（临时文件放哪/叫什么）不在此列
- ask-user / plan 冒烟回归全绿（护栏侧不用改：ask_user 本就是收尾护栏的合法出口）

## 2026-09-03 v2.4.13：设备 target 模糊匹配（昵称/截断 id）

- 真机："把文件传给顾夕的桌面"——小模型不会脑补"顾夕"→「顾夕杀杀杀」，且系统提示词给的 deviceId 与 resolveDevice 全等匹配对不上直接报"设备不存在"，提示词与工具行为自相矛盾
- 修复（tools.js resolveDevice 两级匹配）：①精确 deviceId/设备名/主机名（原行为）；②模糊=互相包含即候选（昵称"顾夕"⊂"顾夕杀杀杀"、deviceId 截断前缀），key≥2 字才模糊防误匹配，唯一命中才采用，多台命中返回 _ambiguous 歧义拒绝（传输目标必须无歧义）；deviceNotFoundMsg 统一 17 处报错：歧义点名候选、不存在带可用清单（含 deviceId）+昵称提示
- prompt.js 跨设备规范第 4 条补昵称说明：用户原词直接填 target，报多台用完整 deviceId，报不存在用清单准确名
- 新增 device-resolve-smoke 8/8（昵称/截断/精确×3/歧义/不存在带清单/单字不模糊）；transfer/fileref/plan 回归全绿

## 2026-09-03 v2.4.12：打转护栏分级（报到循环变体）

- 真机（查重庆天气写 word）：模型每轮带相同 task_plan"报到"+ 同轮照常 web_fetch 干活 → 打转护栏硬拒绝 → 它困惑又重发 → 每轮浪费一次、观感像卡死
- 修复（agent.js）：applyPlan 加 ctx.workingRound（同轮是否有非 task_plan 的 approved 调用）——有真工具 → 相同清单返回 ok:true 温和提示"重复上报已忽略，完成一项再传 done:序号"；纯重发不干活 → 维持原地打转硬拒绝
- plan-smoke 新增场景 7（33/33）：混合轮软通过+真工具照常执行、单独重发硬拒、最终 2/2；loop-guard / session 26 / data-sync 12 回归全绿

## 2026-09-03 v2.4.11：429 限流自动退避 + 等待转圈

- 真机报错"API 429: TPM limit reached"：肥任务（30+ 轮、29 图下载日志堆历史）每轮携带几万 token，把硅基流动按分钟的 token 配额打满
- 429 兜底（agent.js 流式重试循环）：限流单独放宽 3 次重试、每次等 25 秒（分钟窗口），通知"限流中，25 秒后自动重试 x/x"；其它网络错误维持 2 次 1.5 秒快速重试；重试循环上限从 2 提到 3
- 等待转圈（app.js + main.css）：①消息发出→模型开轮前、②每轮工具执行间隙→下轮开轮前，聊天底部显示 `.chat-waiting` 行（.ai-spin 转圈 + "MSMate 正在思考与执行…"）；assistant_start 时撤掉 + 气泡 content 内置转圈直至首个 delta；guard: work.running=false 不显示防残留
- 教训：限流重试必须区分错误类型定等待时长（429 按分钟窗口等长间隔 vs 网络瞬断快重试）；UI 空窗期（事件间隙）要有加载指示，"执行操作中"纯文字体感像卡死

## 2026-09-03 v2.4.10：全局右键菜单

- 用户反馈：Work 工作区和 Work 设置里右键没有复制/粘贴菜单
- 根因：Electron 默认不提供右键菜单，必须主进程挂 context-menu handler（网页默认行为在 Electron 里被禁）
- 修复（main.js）：window 级 context-menu 全局挂——输入框（isEditable）弹撤销/重做/剪切/粘贴/全选，选中文字弹复制，两者兼有合并；空白处不弹。全界面一次覆盖（Work 工作区/设置表单/聊天框/互联模式输入框）
- 教训：Electron 应用每个"网页理所当然"的小功能（右键菜单、拖拽、选中）都要显式实现，打包前该过一遍基础交互清单

## 2026-09-03 v2.4.9：假进度行拦截 + 收尾护栏两次制

- 真机变体续报（Qwen3-8B）：不调 task_plan，在正文里手写"[任务清单 1/2：…完成。任务结束。]"模仿系统 planLine 格式假装打卡——板子是系统渲染的，正文写多少都不会动
- 修复（agent.js runLoop 普通回复路径）：检测正文含"任务清单 x/x"格式且清单有未完成项 → 点名"这是模仿系统提示的假状态，进度只认 task_plan 工具调用"+指名该传的 done:N（fakePlanNudged 每代理一次，防死循环）
- 收尾护栏从拦 1 次放宽为拦 2 次：第二次消息前缀【最后警告】（finishNudged 改计数器）
- 回归：loop-guard 新增 2.8 假进度行场景，plan-smoke（打卡护栏）全过

## 2026-09-03 v2.4.8：干完活不打卡护栏

- 用户用 Qwen/Qwen3-8B 跑通罪恶王冠任务（29 张图下载成功），但暴露新变体：下载完后重发一模一样的清单标 doing:1,2，而不是给已完成项打 done——"不知道自己完成了"，板子永远到不了 2/2
- 修复（applyPlan）：①重发相同 items 且零新打勾 → 点名"这次调用毫无意义，做完的活传 done:序号，禁止用 doing 重标已完成"；②自上次清单更新执行 ≥3 次工具零打勾 → "随干随勾，禁止堆到最后补"（toolsSincePlan 计数，applyPlan 时归零）
- 用户另观察到"第二轮才建板"——实际是第 1 轮探路（search_files 查重）+ 第 2 轮 task_plan/web_search 同轮并行，符合设计，不强改
- 回归：plan-smoke 新增场景 6（空转提醒+重发提醒+最终 2/2），loop-guard/session(26) 全过

## 2026-09-03 v2.4.7：正文清单自愈——教不改就帮它建板

- 真机案例（罪恶王冠任务第二轮）：2.4.6 的教学提示模型收到了（思考里复述了"必须先输出 task_plan"），但输出还是错——连 task_plan( 前缀都没有，光秃秃 `items: [...]` 三行，清单板依旧没建起来
- 结论：对这只小模型（用户实际用 THUDM/GLM-Z1-9B-0414，9B 推理系），"教学重写"类护栏对格式固执无效，必须自愈
- 修复（agent.js tryRepairBarePlan）：plan 为空时直接解析正文清单文本（`task_plan(items:[...])` 函数风格 / 光秃 `items:` 行两种），中文项 ≥2 才救，顺带解析 doing/done 序号数组 → 直接 applyPlan 建板 + 告知"已自动解析帮你建板，下次用正确格式"；同轮合法调用不受影响；calls 里已有 task_plan 时跳过（防重复建板）
- 语义升级：2.4.6 的"混合轮次教学"被自愈取代（函数风格现在直接建板），2.6 场景断言同步更新
- 回归：loop-guard 新增 2.7 自愈场景，plan/loop-guard/session(26) 全过
- 教训：护栏设计要分两层——能自愈的（无副作用内部操作如 task_plan）直接代劳+告知，只有有副作用的（文件/网络）才教学重写；对 9B 级小模型"教学"期望要低

## 2026-09-03 v2.4.6：裸调用检测补"函数风格"盲区 + 混合轮次兜底

- 真机案例：罪恶王冠图片任务，模型把 task_plan 写成正文函数调用 `task_plan(items:[...])`（非协议格式），同轮又有合法 web_search 块 → 清单板没建起来、模型空搜两轮，用户问"板子是不是没建成"
- 两个盲区：①detectBareToolCall 只认 `name{` 和 `{"name":...}` 两种风格，不认函数风格；②裸调用检测只在"整条回复没有任何合法 tool 块"时运行，混合轮次（裸文本+合法块并存）不触发
- 修复（agent.js）：①新增函数风格正则（行首工具名+半角括号+参数样首字符，正文提及"格式是 xxx(...)"不误判）；②混合轮次分支（else if !plan）：合法调用照常执行 + 插教学提示让模型下轮用正确格式补发
- 回归：loop-guard 新增混合轮次场景+函数风格单测（defs 桩补 task_plan），plan/session(26)/data-sync(12) 全过
- 教训：①新护栏分支插进 if/else 链时先看清原块的 return/continue 边界（曾把收尾护栏挤出作用域导致孤立 continue 语法错）；②测试桩 defs 要和生产对齐（缺 task_plan 导致检测永远匹配不到）

## 2026-09-03 v2.4.5：建清单时机优化——省掉"先干一步再补板"的空烧轮

- 用户观察：新任务来了模型先干第一步、被系统提醒后才补建清单板，多烧一轮对话
- 优化：①P0 行动原则第 3 条明确"第一轮回复就输出 task_plan，可与第一个工具调用同轮并行（协议支持 task_plan 内联+其余进并行管线），禁止等提醒补建、禁止为建清单单独空烧一轮"；②planNudged 提醒文案同步改为"这一轮就和后续工具调用一起并行输出"
- 验证：task_plan 在 runLoop 本就单独内联处理（不进并行管线），混合轮次安全；plan/loop-guard/session(26) 回归全过
- 教训：教协议时要把"允许多工具块同轮"说透（尤其内部工具如 task_plan/ask_user 与真工具混发），小模型不会自己联想到并行输出能省轮次

## 2026-09-03 v2.4.4：清单"原地打转"护栏——干完活不打卡导致反复重做

- 真机故障：整理壁纸任务，移动 18+6 个文件全部成功，但清单板停在 1/4"第 2 项进行中"，AI 反复重发相同清单状态、反复 list_dir 验证，看起来在"重新移动"
- 根因（提示词指引陷阱）：applyPlan/planLine 的"下一步"提示对进行中的项也说"开工时传 doing:N"——模型照字面执行，对着已完成的活反复"开工"；且参数微调（doing:2 → doing:[2]）可绕过原样重复护栏
- 修复（agent.js）：①原地打转护栏——lastPlanSig 记录上次状态签名，task_plan 状态无任何变化时返回 ok:false + 强警告（指出该打勾的项和 done:N 写法）；②进行中项的提示改为"已做完就立刻传 done:N 打勾推进，严禁重复执行已做过的工作"（applyPlan 下一步提示 + planLine 进度行双处）
- plan-smoke 新增场景 5（打转警告/打勾指引/进行中提示文案），回归：loop-guard/session(26)/data-sync(12)/download(17) 全过
- 教训：给小模型的指令提示必须区分状态（未开工→教开工；进行中→教打勾），一刀切的"下一步"提示会变成循环指令；护栏要防"参数微调绕过"

## 2026-09-03 v2.4.3：AI 卡死修复（流式请求无超时）+ 设置 UI 打磨

- 真机故障：找壁纸任务 web_search+建清单后永远"执行操作中"卡死。根因：siliconflow.js chatStream 全程无超时——连接挂起/服务端断流时 for await 永久等待，UI 转圈到天荒地老（公司网络/代理空闲断连高发）；修复：①req.setTimeout(60s) 空闲兜底；②agent runLoop 对流中断自动重试 1 次（历史未落盘前重试安全），仍失败才报错给用户
- 附带发现：小模型会把 tool 调用重复写成正文 JSON（渲染成裸文本），观感像卡死的一部分；detectBareToolCall 只在"无合法块"时触发，有合法块并存时不拦——显示层面可后续优化
- 设置 UI 打磨（用户反馈：要专业、参考 TraeWork）：导航去表情只留文字（含标题"AI 设置"）；四个页签固定等高（height:440px 不塌陷）；右侧留白加大（padding 右 24px）；弹窗加宽 760px
- 回归：plan/loop-guard/session(26)/data-sync(12) 全过
- 教训：SSE/长连接必须双保险——socket 空闲超时 + 上层重试；"卡死"优先查无超时的 await，而不是护栏逻辑

## 2026-09-03 v2.4.2：提示词分区抽离 + 设置界面分组导航 + 数据同步（跨设备物理迁移）

- 三连需求：①用户感觉提示词太乱要归类分级；②Work 设置界面杂乱要重组（参考 TraeWork 左侧导航布局）；③设置里加导出/导入数据，在家推进、公司续接
- 提示词抽离 ai/prompt.js：P0 铁律（工具协议/行动原则/记忆硬触发/防重复）/ P1 操作规范（跨设备套路/工作台/委派/SOP）/ P2 背景知识（能力边界/经验手册）三区分区维护，assembleSystemPrompt(ctx) 组装动态数据（角色/规则/记忆/设备表）；agent.js buildSystemPrompt 只负责收集动态 ctx，正文全在 prompt.js
- 设置界面重组：单列长滚动 → 左侧四组导航（⚡模型服务/💬对话偏好/📋规则与记忆/💾数据同步）+ 右侧内容面板（.ai-settings-layout/.ai-nav-item/.ai-pane，tab 切换纯前端不刷新）
- 数据同步 ai/data-sync.js：导出 = packData 打包 settings.json（含 AI 配置/规则/记忆/常用模型/设备备注）+ ai-chat（所有会话）+ workspace（工作台含 NOTES.md）成 zip（manifest.json 记版本时间）；导入 = 白名单顶层过滤 + posix 规范化防路径穿越（双保险 resolve 前缀校验）→ 先备份现有数据到 mswork_snapshots/data-import-<ts> → 清空白名单区再写入 → app.relaunch 重启生效
- IPC：ai:export-data / ai:import-data / ai:restart-app；preload 对应 aiExportData/aiImportData/aiRestartApp；UI 在"数据同步"页两个按钮 + confirm 弹窗
- data-sync-smoke 12/12（打包计数/全量还原/备份可回/穿越过滤/白名单外拒绝/空包报错）；main/preload/app/data-sync 语法全过
- 教训：①核心逻辑必须抽离成可 require 的模块（main.js IPC 壳只留弹窗），否则冒烟测试没法写；②async 函数里用 await 要自查函数签名（applyImport 初版漏 async，node --check 抓不到语义错误但运行必炸）；③改 package.json 禁用 PowerShell Set-Content（默认 UTF-16/BOM 会写坏 JSON，electron-builder 报"Error reading package.json"），用 node fs.writeFileSync utf8
- 打包备注：release_build\win-unpacked\app.asar 被系统进程锁死（无明确占用者，疑似 Defender/残留句柄），本次用 `-c.directories.output=release_v242` 绕开产出 Setup 2.4.2.exe；PowerShell 传 electron-builder 配置参数必须整体加引号（"--c.xxx=yyy"）否则被拆成文件路径

## 2026-09-03 v2.4.1：记忆/记事本可见性——用户"找不到也触发不了"反馈修复

- 用户问"记忆和大记事本还是没有？没找到位置/没法触发/条件太苛刻？"——诊断：①NOTES.md 一直在工作且写得勤（本机实测 9.6KB），但入口埋在 设置→AI设置→打开工作台 里，用户找不到；②长期记忆 0 条，remember 是纯模型自觉调用、无任何兜底，小模型基本不触发
- 修复（用户拍板：提示词强化，不做硬拦截）：
  - 提示词钉死固定动作：用户说"记住/记一下/以后都这样/帮我记着/别再xx"→ 本轮必须真调 remember，空口答应=失忆比不答应更糟；大笔记本写完必须在汇报里提"已写进工作台记事本"
  - 设置页 AI 工作台行加"看记事本"按钮：IPC ai:openNotes 直达 workspace/NOTES.md（不存在则先创建带说明的骨架）
  - remember/forget 执行成功时聊天里弹 toast（"已记住：xxx"），记忆积累可视化
- 教训：功能做了 ≠ 用户能用。藏在 userData 深处的文件必须有 UI 直达入口；纯模型自觉的软触发对小模型等于没有，起码要在提示词里钉成固定动作序列

## 2026-09-03 v2.4.0：文档引擎大版本——主题系统 + 行内富文本 + 精准编辑 + 批量 cells

- 用户反馈："表格和 word 比不过很多做文档的——编辑能力弱、模板美感不够、改不了字体、排版固定像套模板"。方案全做：主题系统（modern 新默认）+ 行内富文本 + 段落级覆盖 + edit 精准替换 + Excel 批量 cells
- office.js 主题系统：THEMES 三套（modern 现代蓝=新默认/classic 经典公文蓝/gov 红头公文），标题色系/引用块(竖线+浅底)/表格表头色/斑马纹/边框/默认行距全套走主题；createDocx 接线 c.theme（此前主题定义了但没传参的坑）；封面标题也吃 theme.titleColor
- 行内富文本：*斜体* __下划线__ ~~删除线~~ ==高亮== \`代码\`(Consolas+浅底) 全支持，inlineRuns 拆 runs；段落级覆盖 {align,color,size,bold,italic,font} 与 runs 直传（每字可指定字体字号颜色）——normParagraphs 此前会丢覆盖字段，已修（保留 {...p} 且 text 空但有 runs 也保留）
- Word edit 模式：modifyDocx(mode='edit', {replacements:[{find,replace,all?}]})——层1 同 w:t 内直接替换（格式全保留），层2 跨 run 匹配（加粗拆 run 的句子也能命中）整段重建（保留 pPr+首 run rPr）；找不到返回 missed 列表，tools 层 replaced=0 时明确报错引导 read_word 确认
- Excel 主题联动：XLSX_THEMES（modern 深蓝表头白字+斑马纹+等线/classic 浅蓝/gov 红棕），create_table/format_table 传 theme 即换装；追加路径 mdTableXml 同步 modern 配色（此前写死 D9E2F3）
- modify_table 批量：cells={"B2":值,...} 或 [{cell,value}]，modifyXlsxCells 一次读写（先全量校验引用格式再写入，避免改一半报错）；单个 cell/value 用法不变
- 数组参数护栏白名单：STRUCTURAL_ARRAY_PARAMS（src/headers/rows/styles/merges/sheets/paragraphs/replacements/cells/questions）——护栏此前一刀切拦所有数组，office 工具的结构化数组参数全被误伤（create_table 带 headers/rows/styles 直接报"不能传数组"）；白名单内参数跳过净化，.impl 自己校验
- tools.js/agent.js 提示词同步：create_word/modify_word/create_table/modify_table/format_table 五个 TOOL_DEFS 重写（theme/replacements/cells 全进参数表），SOP 第 5/6/7 条 + 写文档/论文/排版/美化流程更新；教训：往 agent.js 模板字符串里写 markdown 行内代码时反引号必须转义（\`），否则整个文件语法炸
- office-smoke 76/76（新增 27 例：三主题/行内富文本/段落覆盖/edit 三态/Excel 主题斑马纹/批量 cells/错误引用）；全量 19 个冒烟套件全过
- 教训：①"参数别传数组"护栏加批量语义参数时必须同步白名单，否则误伤先于功能到达；②提示词与工具描述的一致性红线再+1：数组语义参数要么白名单要么换名，不能让护栏和实现各说各话

## 2026-09-03 v2.3.4（二）：反反爬——web_fetch/download_file 全套（伪装+重试+渲染兜底）

- 用户需求："它扒网页容易被反爬，有没有办法反反爬？"确认方案：全套 = 浏览器请求头伪装 + 失败换身份重试 + Electron 无头渲染兜底；web_fetch 和 download_file 都要
- 新增 ai/anticrawl.js：①browserHeaders(i) 三组真实浏览器身份（Chrome/Edge/Firefox）轮换；②looksLikeAntiCrawl(status, body)——403/429/503/501 直接算，页面剥离标签后正文 <1500 字且命中强特征（Just a moment/安全验证等）算，正文 <300 字且"请开启 JavaScript"算（防 noscript 常规提示和"讨论验证码的文章"误判，正文长=真内容）；③renderPage(url)——Electron offscreen 隐藏窗口真 Chromium 渲染拿最终 DOM（超时 stop 后抓已有 DOM、非 Electron 环境 RENDER_UNAVAILABLE 优雅降级）
- web_fetch：换身份最多试 3 次 → 全被拦走渲染兜底（成功内容标注"经无头浏览器渲染获取"）→ 兜底也不行给友好报错（换图源/open_url 建议）；404 等非反爬错误不重试
- download_file：403/429/503 自动换 UA+补 Referer 重试 3 次（referer 未传时用来源 origin 兜底同源防盗链），仍败在错误信息里注明"已自动换 3 组身份+Referer"；其他失败不重试
- httpGet/httpDownload 固定 UA 全部换成 browserHeaders 轮换（HTTP_UA 删除）；TOOL_DEFS 两工具描述、agent.js 能力边界第 4 条 SOP 同步（一致性红线）
- anticrawl-smoke 20/20（本地 http 服务器模拟反爬）；download 17/17、workspace-web 7/7、plan 19/19、loop-guard 17/17 回归过
- 教训：反爬"误判比漏判"伤害大——正常页面误判会白白渲染兜底拖慢任务，所以判定必须"强特征+正文短"双条件

## 2026-09-03 v2.3.4（一）：收尾护栏——清单没勾完不许停机（真机第二变体）

- 用户贴真机日志：干一步 search_files（还搜错了地方——在目标文件夹内部搜关键词）→ 建 task_plan（3 项全 pending）→ 下一轮普通回复"汇报进度"直接停机。新变体：**把建清单/阶段性汇报当成收尾动作**
- 修复：runLoop 普通回复出口前加收尾护栏——`didToolWork && plan 有未完成项 && 未拦过` → 注入【系统提醒】（指出第 N 项没做 + 必须继续执行 + ask_user 逃生口）并 continue；`finishNudged` 每轮用户消息重置，只拦一次防死循环
- 护栏条件用 didToolWork 而非 plan 存在：plan 设计上跨消息保留（"接着干"续做），纯问答轮不该被误拦
- plan-smoke 19/19（新增收尾拦截场景 5 例）；loop-guard 17/17、session 26/26 回归过
- 教训：一步一停的变体会随护栏增加而演化（菜单收尾→建清单收尾），收尾出口必须按"清单状态"而非"有无输出"判断

## 2026-09-03 v2.3.3：反"空想+一步一停"三连修复

- 用户贴真机日志：模型思考空转几千字（可能A可能B打转）→ 没建 task_plan → 干一步 list_dir 就用正文列①②③菜单停下来问用户
- 三处修复：① 行动原则0 加"思考短而果断，禁止罗列可能性空转"；② 行动原则3 加"工具结果回来后清单没勾完必须继续下一轮；禁止正文列菜单（要用 ask_user）；目标可推断直接执行到底"；③ **系统级兜底**：一轮工具结果后若无 plan 且未提醒过 → 自动注入【系统提醒】（补 task_plan + 别一步一停），每轮用户消息只提醒一次（planNudged）
- plan-smoke 14/14（新增提醒场景 3 例）；loop-guard 回归过；打包 2.3.3
- 教训：光靠提示词"必须建清单"小模型不执行，系统层兜底（结果注入+一次性提醒）才是硬约束

## 2026-09-03 v2.3.2：裸 JSON 调用兜底（真机卡死真凶）

- 用户贴的卡死日志结尾是 `{"name":"web_search",...}` 裸 JSON 直写正文——旧 detectBareToolCall 只认 `web_search{...}` 变体，JSON 变体漏网 → 被当普通回复结束 → 每轮重复 → 表现为"卡死"
- 修复：detectBareToolCall 加第二个正则 `^\s*{\s*"name":\s*"(真实工具名)"`（限行首防误判句中讲解）；纠正消息改为明说"JSON 直写也不行"+ 多步任务先 task_plan
- 副产物：普通 ``` 围栏里的调用现在也会被抓（旧版放任卡死），单元用例语义已更新为"教它换 tool 围栏"
- SOP 行动原则 3 补："继续/接着干"的续做任务第一步也是 task_plan（建或对齐清单），禁止不经工具空想一整轮
- loop-guard 19/19（新增裸 JSON 场景 3 例）；plan、ask-user 回归过；打包 2.3.2
- 教训：给"防X"写正则时必须穷举模型实际会写出的**所有变体**（用户贴日志是唯一可靠的需求来源）

## 2026-09-03 v2.3.1：记忆/大笔记本触发率提升 + 上限放宽

- 用户反馈：记忆和大记事本几乎不触发。根因：提示词只给"自主判断"没给硬触发场景，小模型不会主动用
- 记忆提示词加"三条硬触发"：①被用户纠正理解→记正确含义 ②用户讲解术语/黑话→记解释 ③用户新偏好/规则→记规则；再加"收尾自查"（汇报前检查本轮有无触发）
- 上限放宽：remember 硬上限 50→200（setConfig slice 同步），回顾阈值 30→150；NOTES.md 回顾阈值 40→100，内容类型加踩坑经验/术语解释
- remember 工具描述同步三种硬触发（红线：提示词与工具描述一致）
- 坑：改 slice(0,50) 时切错文件——tools.js 里同名 slice 是网页链接提取上限（应为 50），已回退；**改"顺手的小上限"前必须先确认数值属于哪个功能**
- 回归：loop-guard、plan 11/11、download 17/17 全过

## 2026-09-03 v2.3.0：task_plan 任务清单 + 步数上限 100

- 用户观察：小模型批量下载卡在 web_search 迷路；提议"做任务表让它看进度"——对症
- task_plan 工具：items 建清单（≤20 项）/ doing / done 序号打勾（支持数组）；agent 循环里单独拦截不进并行管线，applyPlan 返回"下一步：第N项"提示；每次更新 send plan 事件（items/done/total 全量快照）
- 防迷路双通道：① 每个工具结果尾部注入一行 `[任务清单 X/Y 完成，下一步:第N项 xxx]`（planLine）——小模型每步都看得见进度；② SOP 行动原则第 3 条：≥3 步任务必须先建清单、随干随勾、没勾完禁止收尾
- UI：upsertPlanCard 一张卡实时更新（📋 标题+进度条+逐项 ⬜🔄✅，done 划线），work.planEl 挂会话上下文
- 步数上限 20→100（批量下载余量；防空转靠重复护栏，100 只是烧 token 急刹）
- 测试：plan-smoke 11/11（建/勾/进度注入/无清单拒绝/越界序号）；loop-guard、ask-user、delegate 回归全过
- 用例教训：写场景自己漏勾一项导致 2 例红——先核对场景再怀疑代码

## 2026-09-03 v2.2.9：聊天排版打磨（对齐 Trae Work 观感）

- 用户拿 Trae Work 截图对标：正文 14px/1.7 行高/宽松段距的阅读舒适感
- 改动（纯 CSS）：.chat-msg 12.5px→13.5px、line-height 1.72、letter-spacing 0.2px；.chat-list 内边距 14/16、消息间距 12；AI 正文 max-width 900px（宽窗限行长）；用户气泡 padding 8/12
- markdown 排版升级：段距 9px、标题 14px 上距 + 17/15.5/14.5 分级、li 间距 4px + ::marker 变灰、嵌套列表缩进、引用块 6/12、代码 12.5px、表格单元格 5/10、链接 medium 字重
- 教训复刻：old_string 手滑带前缀导致 Edit 两次 miss → 大段替换前先 Read 精确内容、拆小块逐条改

## 2026-09-03 v2.2.8：模型清单改用户自管 + 工具参数数组净化

- 用户反馈 1：模型下拉栏不要预设，让用户自己加 → 拆掉 AI_PROVIDERS.models 和 VISION_MODELS 硬编码预设；下拉栏/输入联想数据源改为 settings（chatModelList / visionModelList），➕ 把输入框当前值加进清单、🗑 删除选中项，打开设置回显当前值
- 用户反馈 2：下壁纸报 `The "path" argument must be of type string. Received Array` → 小模型把多张图的路径塞进数组。tools.execute 入口统一净化：单元素标量数组自动拆包，多元素数组拒绝并教正确用法（"发多个 download_file 并行，各传各的参数"）
- 大坑（二次踩）：同一条消息里对 package.json 发两个 Edit 会相互覆盖——后一个基于旧内容整体写回，前一个 version 改动被吞，2.2.8 打成了 2.2.7。教训：**同一文件的多次编辑必须拆开逐条发**，打包前必先 node -p 验版本
- 回归：open-smoke 16/16、md-render 15/15、app.js/tools.js 语法 OK

## 2026-09-03 v2.2.7：聊天 markdown 渲染（网页端观感）

- 用户吐槽：AI 回复里 **加粗**、- 列表全是裸符号——content_delta 只做 escapeHtml 纯文本渲染，从未支持 markdown
- 新增 renderMarkdownFrag/appendInline/emitItalic（DOM API 构建、内容全走 textContent，天然防注入）：行内 code/**加粗**/*斜体*/[链接](http)；块级 代码块/标题h1-h6/ul/ol(1. 1、1))/引用/表格/分隔线/段落（换行靠 .chat-content 的 pre-wrap，不造 <br>）
- linkifyFilePaths 重写：先 markdown 渲染成 fragment，再 TreeWalker 遍历文本节点把 Windows 路径替换成文件名片——markdown 结构与路径卡片共存；4 个调用点（历史重建/tool_result/ask答案/最终回复）自动全走新渲染
- CSS：.chat-content 内 p/h1-h6/ul/ol/blockquote/code/pre/table(th 边框底色)/a/hr 网页端排版，贴主题变量
- 测试：md-render-smoke 15/15——从 app.js 抽取渲染器源码 + 迷你 DOM 垫片在 Node 跑结构断言（防注入 <script> 是重点）；垫片 tagName 大写，断言要统一大写比较
- 流式期间全量重渲 + 光标挂进最后一个块级元素（PRE/TABLE/UL/OL/HR 除外）

## 2026-09-03 v2.2.6：识图大图自动压缩

- 用户问：图片太大会不会看不了？→ 分辨率大模型方自带缩放没问题；真正卡点是本机 20MB 闸门 / 服务商请求体上限（413）/ 慢网上传超时
- 方案（用户拍板加）：view_image 发送前 >8MB 用 Electron 自带 nativeImage 缩到长边 2048 转 JPEG 85（不加依赖）；plain node 测试环境 require('electron') 无 nativeImage 自动跳过用原图；压缩结果必须更小才采用，MIME 随载荷切 image/jpeg
- 坑：Edit 替换时把 apiKey 声明两行吞掉，语法检查前被及时发现补回——大段替换后必须通读上下文
- 打包 v2.2.6 子目录绕锁，Setup 已挪回 release_build 根目录，配置已还原
- 本包同时含：经验手册"禁编造规则"+第21条（失败转述真实错误、用户要求重试必须重试）、折叠行对齐深度思考、exe 强制审批、open_url/open_path 工具

## 2026-09-03 识图"假规则拒绝用户"修复

- 现象：view_image 失败 2 次后 AI 编造"经验手册第17条：连续3次失败强制停止"拒绝用户再试——第17条实际是"文件放路径"，**规则是 AI 幻觉**
- 修复：手册标题声明"共21条，禁止编造第N条拒绝用户"；新增第21条（失败要转述真实错误原文、用户说再试必须再试、不存在强制停止机制）；view_image 失败消息同步加"禁止编造成服务中断/强制停止，用户要求重试不得拒绝"
- 教训：小模型会把"少重试"类措辞内化成自我设限甚至虚构权威规则；给工具的失败消息要明确写"该说什么/该做什么"，不写它就会自由发挥
- 待观察：cat2.jpg 识图连败的真实原因在【HTTP xxx】里（很可能 429 限流，DeepSeek-OCR 限免），AI 修好后会把原因带出来

## 2026-09-03 折叠行对齐"已深度思考" + exe 审批放行

- 用户反馈 2：回看过程要跟"已深度思考"一样 → 删掉上轮的"回看锚点+flash"，折叠行改挂进最终回复内部（头像行正下方 head.after(fold)），CSS 完全镜像 .chat-thinking（11px 灰字行、无边框面板、collapsed 收 margin）；appendProcessFold 同步改，chevron 旋转全部交给 CSS 类；无过程时本轮不出现折叠行（alive.length<=1 早退）
- 用户反馈 3（纠正+升级）：WPS 文档本来就能 open_path 开，被拦的只是 exe/bat/js；用户提"AI 评估白名单" → 否决（AI 自己是被网页诱导的对象，不能既当防线的裁判），改为 **exe 打开强制审批**：classify 返回 forceApproval，agent.js needApproval 追加 forceApproval 判断（任何审批模式都弹卡），批准后注入 args.__approved 放行执行层，未审批直接调 execute 一律拒绝（防绕过）
- SOP 矛盾修复：能力 6"运行程序做不到"与能力 4 冲突 → 改为"运行本机程序走 open_path + 审批"
- open-smoke 16/16（新增审批后放行 + classify forceApproval 用例；放行用例用"不存在的 exe"验证到存在性校验即止，零副作用）；app.js 语法 OK；loop-guard 13/13 回归

## 2026-09-03 v2.2.5：open_url / open_path 打开类工具

- 方案讨论结论（用户拍板）：打开网址/文件 → 做；QQ 收发（NapCat，小号）→ 先不做；微信 → 不做（封号风险）
- 新工具：open_url（仅 http/https，file://、javascript:、自定义协议全拒）；open_path（默认程序打开本机文件/文件夹，路径存在性校验，**exe/bat/js 等可执行脚本类直接拒绝——打开等于运行**，C 盘保护区沿用）
- 审批：classify 默认非破坏性免审批（打开本身无破坏，危险扩展名在执行层就拒了）
- SOP：能力 4 加"找网站打开=open_url / 打开文件=open_path"教学；TOOL_DEFS/summarize/TOOL_ICONS(🌐🚀) 三处同步
- open-smoke 14/14（校验类全测，真实打开用 OPEN_SMOKE_REAL=1 门控）
- 打包小坑：同消息批量 Edit package.json 后 version 改动被环境吞掉（output 改动留住）——打包前先 node -p 验版本号
- 打包走 v2.2.5 子目录绕幽灵锁，已挪回根目录，配置已还原

## 2026-09-03 v2.2.4：设置加常用模型下拉栏

- 需求：换模型不用重新打字 → AI 设置弹窗"模型"和"识图模型"输入框下方各加一个下拉栏，选中即填入，输入框仍可自定义
- 实现：applyProviderUI 按服务商填充对话模型清单（硅基流动补了 Qwen3-8B/GLM-4-9B 等免费款）；VISION_MODELS 常量（PaddleOCR-VL-1.5 默认 / DeepSeek-OCR 限免）替换掉 HTML 里已停服的旧预设；syncModelSelect 打开弹窗时回显当前值（在清单里就选中，自定义值保持占位）
- 教训：识图旧预设里 Qwen2.5-VL-72B/GLM-4.1V 已停服——预设清单要跟着平台上下架维护
- 打包走 v2.2.4 子目录绕幽灵锁，Setup 已挪回 release_build 根目录，配置已还原

## 2026-09-03 折叠块"被覆盖"修复 + IPv6 真因确认

- 用户观察修正：折叠块不是样式隐形，是**长回复把它顶出视野**（自动滚动钉底部）→ 在最终回复末尾加"⚙️ 回看本轮 N 步操作过程"锚点（虚线框 accent 色），点击 scrollIntoView + 自动展开 + flash 高亮 1.8s
- IPv6"还是老样子"真因：用户用**另一台旧版电脑**测试的——修复只在新版里，两台都装 2.2.3 才有效
- 识图"看内容"确认：默认 question 已是描述优先（先说整体+画面主体，文字如实转录注明水印），能力 5 教了按意图传 question
- app.js 诊断零报错

## 2026-09-03 三连修复 + 2.2.3 重打包

1. **折叠块"消失"**：折叠摘要条原本 11px 灰字近透明背景毫无存在感，用户以为步骤丢了 → 改为带边框面板样式 12px，摘要条直接列出前 3 个工具摘要（"已折叠 5 步操作：搜索 · 下载×3…点击展开"）
2. **识图脑补**：无字照片硬凑出"Stybanose/日文名/药品"联想 → 默认 question 加"无文字就说无文字，不要硬凑"；能力 5 加"识图结果只转述，禁止脑补含义"
3. **识图失败瞎猜**：失败只返回"识别失败"→ AI 编出"文心OCR/read_table" → 失败现在带具体原因（【HTTP 401/404/429】/超时/网络错误 + 服务端错误信息），并给 AI 状态码对照表
4. **IPv6 "还是自己"真相**：读本机 app.log 发现最后启动版本还是 **2.2.1**（安装目录 F:\MS\MSConnect），2.2.2/2.2.3 从未运行过 → 修复没生效是必然，**两台设备都装 2.2.3 并重启**后再验证；装完日志应出现 [安全] 自净化行
- 2.2.3 已重打包（含以上全部），配置已还原

## 2026-09-03 v2.2.3 打包

- 内容：IPv6 自污染五道防线 + 启动自净化、AI 循环空转护栏（重复拦截/裸调用兜底/步数提示）、聊天框外部拖文件（热区扩大+路径修复）、识图修复（DeepSeek-OCR `<image>` 前缀/魔数校验/意图提示词）
- 打包撞 win-unpacked 幽灵锁 → 按预案改输出目录 release_build/v2.2.3 绕过，Setup exe 已挪回 release_build 根目录，配置已还原

## 2026-09-03 识图幻觉修复（用户换用 deepseek-ai/DeepSeek-OCR 后）

- 现象：猫猫照片识别出"细胞质/细胞膜"幻觉 + 版权水印行被当故障 + read_file 读图片报二进制被当异常
- 根因：① DeepSeek-OCR 官方要求文本提示以 `<image>\n` 开头，没加模型对不上图就幻觉 ② 无魔数校验，改名/损坏文件直塞给视觉模型 ③ 提示词没教"图片禁用 read_file"
- 修复：① tools.js view_image 检测 DeepSeek-OCR 自动加 `<image>\n` 前缀 ② 加图片魔数校验（jpeg/png/gif/bmp/webp），不符直接明确报"不是有效图片" ③ 能力 5 补：图片只用 view_image、二进制报错属正常勿汇报、水印/域名是正常内容如实转述
- 回归：语法 OK、loop-guard 13/13、office 53/53

## 2026-09-03 识图意图理解 + 聊天框外部拖文件

**问题 1：发猫猫照片问"认得到不"→ AI 只 OCR 出文字还反问要不要写进 docx、自建缓存文件**
- 用户明确：**不换识图模型**（PaddleOCR-VL-1.5 保持默认）
- 修复（纯提示词层）：① 能力 5 教 question 按用户意图写（看画面→描述内容；要文字→完整转录；表格→按行列转录）② 闲聊式看图 → 直接自然语言回答，禁止建缓存/存档、禁止反问"要不要写入文档" ③ 普通照片如实描述、别编造 ④ view_image 默认 question 加"先说整体是什么再描述内容"；工具描述同步
**问题 2：窗口外拖文件进不了对话框（只能从资源面板拖）**
- 根因：drop 只挂在 #chatInput（textarea 本体）+ 外部拖入的路径插值用的是对象 ${p}（会变 [object Object]）
- 修复：热区扩大到整个输入行（.chat-input-row）+ 聊天消息区（#chatList），drag-over 高亮整个输入行；路径取 p.path；内部面板拖拽/外部 Files 都能引成胶囊
- 验证：语法 OK、loop-guard 13/13 回归过、app.js 诊断零报错

## 2026-09-03 修复：IPv6 设备表自我污染 + AI 循环空转

**问题 1：IPv6 连过的设备过段时间变自己 ID 且连不上**
- 根因：旧版本对端把收到的 hello 原样当 hello-ack 回显 → 本机把"自己的 ID + 自己的 IPv6"当对方学进 ipv6Peers/设备表
- 修复（五道防线）：① tcpAgent handleHelloAck 顶部自连拦截（回显/回环直接断开）② activateConnection 拒绝自己 ③ connectByIP 拒绝本机自己的地址 ④ main.js connect-invite 拒绝自己的邀请码 + peer-learned/saveIpv6Peer 守卫 ⑤ 启动自净化：清 ipv6Peers 里的本机历史脏条目
- 教训：凡"学习/注册对端信息"的入口（hello、hello-ack、invite、peer-learned）都必须有 self 守卫，一个都不能漏

**问题 2：AI 卡住空转（如搜图循环）最后自己停了只能回滚重发**
- 根因 A：小模型原样重复调用（同名同参数），烧满 20 步，每轮超长思考体感卡死
- 根因 B：模型把工具调用写成裸文本 `web_search{...}`（没围栏），解析不到就当普通回复草草结束
- 修复：① 原样重复护栏——上一轮同名单参数调用再出现直接拦截，喂"换策略/换关键词/提问/收尾"指令 ② 裸调用兜底——detectBareToolCall（已知工具名+紧跟{ 才判，JSON 讲解不误判）命中则教正确围栏格式重写 ③ steps_exhausted 事件 → 聊天里显示"步数达上限已停止"轻提示
- 测试：loop-guard-smoke 13/13（重复拦截/裸调用兜底/误判单元/tcpAgent 自连防线），ask-user 9/9、office 53/53、delegate、session 26/26 回归全过

## 2026-09-03 v2.2.2 打包发布

- 版本 2.2.1 → 2.2.2；按打包绕法临时把输出指到 release_build/v2.2.2，一次打包成功（未遇幽灵锁），Setup exe 已挪回 release_build 根目录，配置已还原
- 本版包含：办公引擎 v2（docx/exceljs 重写）、Word 排版标准件（字体/行距/缩进/封面/文档内表格）、Excel 范围样式、ask_user 中途提问、复杂任务拆分 + 跨设备创建三步套路 SOP

## 2026-09-03 提示词：复杂任务拆分 + 跨设备创建三步套路

- SOP 首条新增"复杂任务先拆步骤清单再动手"：跨设备/多文件任务先在思考里列步骤（工具+target+完整路径），串行小步、上步确认成功才走下步
- SOP 新增"跨设备创建文件固定三步套路"：①本机先做出来（target 不传）②list_dir 对方 root 找"桌面"探真实路径（用户名不同，禁猜）③transfer_file 传过去+list_dir 验证；"建过去不留"=确认成功后 delete_path 删原件；远程建文件夹=路径确认后 create_folder(target)；纯文本小文件 write_file 直接 target 仅限路径已探明时
- 操作规范区新增第 8 条呼应（标准动作=本机做好→传过去，禁猜远程路径）
- 提示词纯文案改动，agent.js 语法校验 OK，ask-user-smoke 9/9 回归通过

## 2026-09-03 ask_user 中途提问功能

- AI 信息不齐时可在任务中途向用户发起提问，用户在聊天里的提问卡片点选/输入后 AI 自动继续跑
- **协议**：新工具 ask_user，questions 数组 [{question, header, options:[{label,description}], multiSelect}]
- **agent.js**：pendingAsks + waitAsk/resolveAsk（复用审批流的暂停/恢复模式，10 分钟超时）；执行循环里 ask_user 在审批后、工具执行前逐个等待；回答格式化成"问题 → 选项；其他：xxx"写进历史；取消/超时提示"按最合理方案继续、说明假设、勿重复提问"；abort/rejectAllAsks 联动；子 Agent 提问沿 childAgents 链转发
- **UI**：Trae 风格提问卡片（ask-card）：问题标题 + 分页（‹ 1/2 ›）+ 选项行（单选◉/多选☑，label+说明，选中高亮）+ 其他输入框（0/500 计数）+ 取消/下一题→提交回答；答完卡片显示答案摘要，输入框 Escape=取消
- 提示词 SOP 新增"信息不齐先问再干"（1~3 题问全、能推断的别问、别当开场白）
- 测试：ask-user-smoke 9/9（mock client 跑真实循环：回答/取消/abort/子Agent转发），office 53/53、delegate、session 26/26 回归全过

## 2026-09-03 Word 排版标准件 + 文档内表格 + Excel 范围样式

- **字体族**：create_word/modify_word(replace) 新增 fonts:{heading,body,western}，默认标题黑体/正文宋体/西文 Times New Roman（w:eastAsia + w:ascii 分开管）
- **行距/首行缩进**：lineSpacing(倍数如 1.5 → w:line=360 写默认样式)、firstLine:true → 正文段 firstLine=480（2字符）
- **封面页**：cover:{title,subtitle,org,author,date} 居中排版自动分页
- **Word 内插表格**：content 里 markdown 表格行（| a | b |）自动转 w:tbl（首行表头加粗+D9E2F3 底色+边框），append 也支持（JSZip 注入 mdTableXml）
- **Excel styles**：create_table 新增 styles:[{sheet?,range,bold,italic,font,size,color,bg,numFmt,align}]，范围样式（A2:C10 或单格）
- SOP 新增"论文/公文排版标准件"条目（字体未指定按默认，不必问）
- 修复：normParagraphs 数组元素里的多行字符串（整块 markdown 表格）没按行拆 → flatMap 统一拆行
- 已知限制：exceljs 不支持生成原生 Excel 图表（库里没有该能力），图表需求暂无法满足
- 测试：office-smoke 53/53 全绿

## 2026-09-03 办公引擎 v2（docx + exceljs）

- **Word**：office.js 换 docx 引擎重写——markdown 直传（标题层级/行内加粗/引用/列表）、`![图注](路径)` 自动嵌图并居中、页眉/页脚/页码、toc:true 自动目录（打开时提示更新域）、modify_word append/replace 均支持插图，改前自动快照
- **Excel**：换 exceljs 引擎——多 sheets（{表名: markdown 或 {headers,rows}}）、merges 合并单元格、`=SUM(...)` 公式、表头样式/自动列宽/冻结首行/边框；format_table 美化后数据与合并原样保留
- **SOP 同步**：agent.js 教"截图→view_image 转录→create_table（merges/sheets）"、"论文 toc+pageNumbers+header"；tools.js 描述与新参数一致
- 测试：office-smoke 39/39 全绿（含嵌图/目录/页眉页脚/多表/合并/公式/AA 远列）

## 2026-09-02 提示词"自吓点"排查

- **假工具名**：经验手册 14/18 写了不存在的 move_file/copy_file（实际 move_path/copy_path）→ 小模型对清单找不到会慌
- **限额矛盾**：download_file 描述写 500MB，SOP 写 2GB → 统一 2GB
- **"逐个 download_file"**（web_fetch 描述）与 SOP"一次性批量"矛盾 → 统一批量
- **forget"必须完全一致"** 缓解为"从记忆清单复制原文"
- 新增能力边界第 7 条"别自己吓自己"：ok:false≠任务失败 / 等待中别重发 / 拒绝审批别偷偷换路 / 无隐藏数量上限
- 自救表补"用户拒绝了此操作"行；手册 19 的 modify_word 绕口令捋直
- search_files 描述明确"本机递归/远程仅一层"

## 2026-09-02 识图默认模型更换

- Qwen/Qwen2.5-VL-32B-Instruct 已下线 → 默认改 PaddlePaddle/PaddleOCR-VL-1.5（tools.js 兜底 + 设置界面 placeholder/预置列表首位）

## 2026-09-02 九连修（老大实测反馈）

1. **配对后显示"连接了自己的设备"（#1/#7/#9）**：sendPairVerifyCode 只修了键没修值——res.deviceInfo 是"对方眼里的本机"（name/hostname/ip 全是本机），spread 进信任表和连接注册 → 显示自己名字，刷新（走 _deviceInfo）才恢复。修复：handleHelloAck 记录 socket._deviceInfo（对端 ack 自述），sendPairVerifyCode 一律用它
2. **AI 看见设备备注**：原来看不见（备注只在本地设置）。现 buildSystemPrompt 的设备清单附"用户备注"，AI 能听懂"传给小黑"这种备注称呼
3. **完成通知**：后台会话 run_done toast 加 document.hasFocus() 门控，最小化/失焦才弹
4. **远程 search_files**：本来就有 30s 超时（不是死卡）；失败文案改为带原因和后续动作指引，经验手册明确"远程只搜一层，子目录 list_dir 逐层"
5. **识图**：新 view_image 工具（本地图片 base64 → 视觉模型），默认 Qwen/Qwen2.5-VL-32B-Instruct（硅基流动免费），AI 设置可改；远程图片先 transfer_file
6. **下载分批困惑**：SOP 明确"一轮可并行任意多个 download_file，禁止分批等待"
8. **对讲机鼠标侧键**：hotkeyListener 加 VK 0x05/0x06（GetAsyncKeyState 本身支持鼠标键），录制框支持 mousedown 捕获 Mouse4/Mouse5（可配修饰键）
- 测试：pair-test 25、chain 6、download 17、office 22、session 26、history-persist 5 全绿

## 2026-09-02 打包 v2.2.1

- 安装包：`release_build\MSMate Setup 2.2.1.exe`（66.4MB）= v2.2.0 + 聊天记录持久化修复 + UI 减负 + 大小笔记本
- 部署提醒：2.2.0 期间聊过的内容因从未写盘无法找回；2.2.1 起正常持久化
- 打包：win-unpacked 仍被占用，沿用子目录输出绕法（release_build/v2.2.1 打包后挪回根目录，配置已还原）

## 2026-09-02 修复重启后聊天记录丢失

- **根因**：多会话版 saveHistory 写 `sessions/<id>/mswork_chat.json` 但不建目录 → 会话子目录不存在时 writeFileSync ENOENT **静默失败**（app.log 里全是"会话历史保存失败"），历史从未落盘，重启即空
- **修复**：saveHistory 写前 mkdirSync(recursive)；SessionStore.create 建索引时同步建目录（双保险）
- 新增 history-persist-smoke.js（5 项：create 建目录/落盘/重启恢复/小笔记/删会话连小笔记清除）
- 注意：修复前聊过的内容已无法找回（从未写盘）

## 2026-09-02 UI 减负 + 大小笔记本

- **顶栏只留一条会话长条**：📦快照按钮移除（有回滚机制兜底；快照弹窗代码保留休眠，AI 覆盖/删除前仍自动备份）；🛡审批模式胶囊挪到输入区右上角（发送键上方，紧凑样式）
- **大笔记本（工作台 NOTES.md）**：只记跨对话长期内容（用户习惯/项目背景/环境规律）；写前必读必清（过时/冲突条目删除或改写），超 40 条强制回顾——治"只记不删"
- **小笔记本（会话目录 notes.md）**：任务进度自动记录从全局 NOTES.md 改到每会话文件，删对话自动清除；切回对话自动注入系统提示词（截尾 2500 字符），AI 免读文件就能接着干
- remember/forget（长期记忆）机制不变：去重 + 30 条回顾规则 + 50 条上限

## 2026-09-02 UI 修复：用户气泡对齐 + Work 顶栏重排

- **气泡左对齐 bug**：多会话重构后消息外多了一层 `.chat-session`（display:block），`.chat-msg.user` 的 `align-self:flex-end` 失效 → `.chat-session` 改为纵向 flex（gap 10px），空状态加 `flex:1` 垂直居中
- **Work 顶栏重排**（用户反馈"乱、不优雅"）：改两行布局——上行工具（快照/审批模式 左，设置 右），下行**会话长条**整行铺满（运行点+标题+▼，＋ 贴条尾圆角 8px）；下拉菜单宽度跟随长条
- **隐藏 bug**：`#chatList` 里写死的初始空状态在会话容器挂载后不消失，与新会话空状态叠两层 → curChatEl 挂载时 `:scope > .empty-state` 清除

## 2026-09-02 打包 v2.2.0

- 安装包：`release_build\MSMate Setup 2.2.0.exe`（66.4MB）
- 包含：Work 模式多会话（多项目并行、后台运行、toast 通知）、Word/Excel markdown 富文本直传（行内加粗解析 + 提示词硬标准）、配对"连接到自己"真凶修复 + 信任表自净化 + 自连全链路拦截
- 测试：pair-test 9 组、chain-smoke 12 项、session 26、office 22、transfer/parallel/readfile-segment/fileref 全绿
- 部署要求：**所有设备（A/B/C）都装 2.2.0**，A 的脏信任数据靠新版启动自净化清除；装完首次需重新输一次配对码
- 打包备注：release_build\win-unpacked 曾被未知进程锁死（沙盒内枚举不到占用者），临时改输出目录 release_build/v2.2.0 完成打包后恢复默认配置；后续遇到同样问题可直接套用此绕法

## 2026-09-02 修复配对"连接到自己"/重复要码/自连一系列问题

**用户现象**：A 输 B 配对码后提示"已连接A自己的电脑"；B 完全连不上 A；A 再连 B 又要配对码；A 列表里出现自己。

**根因（三个叠加）**：
1. **真凶**：`sendPairVerifyCode` 激活连接时用了对方回传的 deviceInfo——那里面是"对方眼里的本机信息"（deviceId=本机）→ 发起方把"连 B 的连接"注册在**自己的 id** 名下 → UI 显示"已连接自己的电脑"、远程文件对不上号。测试只断言数量没断言键名，一直被掩盖
2. 旧版本 bug 把"自己"写进 trust-list.json 的脏数据长期残留（收码方信任表里是自己的 id，真设备的信任反而缺失）→ 重复要配对码
3. 设备列表可能混入本机条目（中转在线列表回显等）→ 点/自动连自己引发配对混乱

**修复**：
- tcpAgent.js：sendPairVerifyCode 激活强制用目标 deviceId（`{...info, deviceId}`）；handleHello 首行自连/空 id 拦截（destroy，不配对不激活）
- authManager.js：setOwnDeviceId 启动自净化（清掉信任表里的"自己"）；isDeviceTrusted(自己)恒 false；addTrustedDevice(自己)拒绝；getTrustedDevices 过滤自己
- main.js：中转 device-list / getConnectedDevices 过滤本机条目；connection:connect / relay:connect 自连拒绝
- 测试基建：pair-child.js 原来同机两子进程 deviceId 相同（没设 MSC_DEVICE_ID），测试一直靠对称性蒙混 → 按 ROLE 区分；pair-test 升级到 9 组场景全过，新增"连接注册在 B 的 id 名下"键名断言、自连拦截、信任表自净化用例

**注意**：新包必须 A、B 两台都装（A 的脏信任数据靠启动自净化清除）。

**兼容性验证**：新增 chain-smoke.js（A-B + A-C 链式连接 12 项全过：连接表键名正确、B/C 无信任交叉、断 B 不影响 A-C）；1.0 直连分支（无 ipv6 字段→自动信任+直接激活）未被本次改动触碰，自连拦截只对"id=本机"生效。

## 2026-09-02 新增 Work 模式多会话（多项目并行推进）

**需求**：用户要求会话管理 + 多个 AI 同时跑。UI 定位：顶栏左侧快照/审批，中间会话条，右侧＋新对话/设置（🗑 清除对话改为 ＋ 新对话）。

**实现**：
- ai/sessions.js 新建 SessionStore：`userData/ai-chat/sessions/<id>/mswork_chat.json` 每会话独立历史+检查点，`sessions.json` 索引（title/createdAt/updatedAt/pinned）；旧单历史文件自动迁移为第一个会话；create 保证 updatedAt 严格递增（同毫秒排序稳定）
- main.js：Agent 工厂懒创建（Map 缓存，每会话一个 WorkAgent），事件 send 包装注入 sessionId；IPC 全部按 sessionId 路由（send/abort/approve/clear/history/rollback）；新增 ai:sessions/create/rename/pin/delete；同时运行上限 4 个（MAX_CONCURRENT_RUNS）；apiKey/baseUrl 每轮发送前从设置刷新 → 多实例自动共享配置
- preload.js：会话 API 扩展，原有 API 加可选 sessionId（向后兼容）
- app.js：work 对象改为多会话架构——sessions Map + 活动会话 + `_ctx` 渲染上下文；SESS_KEYS 属性代理（curAssistant/running/toolCards 等）让旧渲染函数零改动；事件按 sessionId 用 withSession 路由，后台会话实时渲染到自己的隐藏容器，完成时 toast 提示；新对话首条消息自动取标题（前 20 字）；每会话容器 `.chat-session` 切换=显隐；发送按钮只反映当前查看会话状态；回滚/审批按会话路由
- main.css：session-bar（居中胶囊按钮+运行指示点脉冲动画）/下拉菜单（切换/重命名✏/置顶📌/删除🗑二次确认）/行内重命名输入框
- 顺带修复 appendProcessFold 引用未声明 chatList 的潜在 ReferenceError

**测试**：session-smoke 26/26 全过（CRUD/迁移/目录隔离/持久化）；office 22、readfile-segment 11、selfcontain 5、zip 6、fileref/delegate/transfer/parallel/pair 全绿。

## 2026-09-02 修复 Word/Excel 成品排版简陋问题

**现象**：模型用 create_word/create_table 生成的成品比它聊天里的回复简陋（层级有但行内加粗丢失、内容缩水）。

**根因**：① office.js 排版引擎只认整行级 markdown，行内 `**加粗**` 不解析（paraXml 单 run），聊天里最常用的行内重点直接变纯文本；② 提示词经验手册第 5 条只教了"换行分段 + ## 小节"，等于教模型按最低标准写。

**修复**：office.js 新增 inlineRuns 行内 markdown 解析（**加粗**拆多 run，标题/引用/列表样式下的行内加粗也生效，#### 归入 h3）；agent.js 经验手册/SOP 改为"内容丰富度必须 ≥ 聊天回复水准，markdown 原样传参"；tools.js create_word 工具描述同步。

**测试**：office-smoke 扩展至 22 项全过（新增行内加粗 run、星号不残留、#### 转 h3 等断言）。

## 2026-09-02 修复配对连接双向不同步 bug

**现象**：A 连 B、输码成功后 A 显示已连接但无法访问 B 的文件，B 显示未连接；且每次重连都要求重新配对。

**根因（两个 bug 叠加）**：
1. B 端 `onPairVerifyCode` 照抄消息里的 deviceId 写信任表，而真实渲染层传的是目标设备自己的 id → B 把"自己"写进信任列表而不是 A → 每次重连都要重新配对。
2. 单向信任（A 信任 B、B 不信任 A）时，A 收到 hello 立即激活，收到 hello-ack(trusted:false) 后又被打回未验证，但 UI 不回退 → A 假连接、业务消息全被 B 白名单拦截。

**修复**（server/tcpAgent.js）：
- 2.0 设备连接必须在 hello-ack 双向确认信任后才 `activateConnection`（1.0 旧版免配对直连分支不变，多设备链式连接不受影响）
- `onPairVerifyCode`/`onPairRequest` 一律以 socket 对端真实身份（`socket._deviceId`）写信任
- `connectToDevice` 移除 TCP 一通就抢先写入 connections 表；`disconnectDevice` 补充清理 pending 连接

**测试**：test/pair-test.js 扩展至 7 组场景 25 项断言全部通过（含回归：B 丢信任后重连不许假连接、传错 deviceId 也写入正确信任对象、修复后重连秒连免配对）；transfer/selfcontain/parallel 冒烟全绿。

**状态**：代码已修复，未打包。老大数据目录无需迁移，已在旧版本配对过的设备对建议在新版本上重新输一次码即可恢复正常。
