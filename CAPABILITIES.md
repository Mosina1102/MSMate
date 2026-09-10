# MSMate 电脑版能力全景（v2.7.16）

> 2026-09-11 整理，全部功能基于源码实证（tools.js 工具表 / IPC 清单 / 测试断言），未落盘的不写。
> 一句话定位：**一台能听懂人话、能上网、能操作文件、能产出文档的 Windows 电脑管家**——你说目标，它动手。

## 一、文件互传与设备互联（互联模式）

| 功能 | 用途 |
|---|---|
| 局域网自动发现 | 同一 WiFi/网线下的设备 3 秒内自动出现，无需配置 |
| 双面板文件管理器 | 左边我的电脑、右边对方电脑，像操作本地一样跨机浏览 |
| 文件/文件夹互传 | 单发、批量、整文件夹递归，断点续传，传输中心看进度 |
| 远程文件操作 | 在对方电脑上直接删除/重命名/移动/新建文件夹/搜索文件 |
| 好友通讯录 | 添加对方 IP 或设备 ID 存为好友，之后一键直连，可删除 |
| 四条连接通道 | 局域网直连 / IP 直连（IPv4+IPv6）/ 互联网桥接（服务器撮合）/ IPv6 邀请串（对方无需公网 IP） |
| 设备 ID 直连 | 只填对方设备 ID：在线走桥接，登录态自动查 presence 换公网 IP 直连 |
| 对讲机（PTT） | 两台电脑语音对讲，全局按键说话（Win7 兼容热键） |
| 传输额度 | 互联网链路每日 2GB 防滥用；局域网不计量；登录后 P2P 不限速 |

## 二、Work AI 助手（对话与生成）

| 功能 | 说明 |
|---|---|
| 多会话 | 多窗口对话，历史留存，重载不丢 |
| 内置模型（扣积分） | DeepSeek V4 Flash（日常主力）/ Qwen3.6 35B（超值）/ GLM-4.5V（视觉）/ GLM-5.3 旗舰（深度思考），卡片式选择+一键设默认 |
| 自定义模型（免费） | 填自己的 API Key，OpenAI 兼容服务商全支持，走自己额度 |
| 流式输出 + 深度思考 | 逐字出答案，思考过程折叠可展开 |
| 积分透明 | 每次回复标注消耗积分，余额常驻；签到送 50/日 |
| 语音输入 / 语音合成 | 说话转文字（免费）；文字读出来（TTS） |
| 生视频 | 文生视频约 5 秒（配了视频模型就能用） |
| 长期记忆 | AI 跨会话记住你的偏好/项目背景/踩坑经验（remember/forget + 共享大记事本） |
| 任务清单 | ≥3 步任务自动建清单，逐项打勾报进度 |
| 子 Agent 并行 | 最多 4 个独立子任务并行调研，结果汇总 |
| 中途提问 | 信息不齐时 AI 主动弹选项卡片问你，不打哑谜 |

## 三、AI 操作电脑（50 个工具，六大类）

### ① 文件系统（本机 + 远程设备，全部带快照兜底可还原）
`list_dir 列目录 · read_file 读文件（大文件分段续读）· write_file 写文件 · create_folder 建目录 · copy_path/move_path 复制移动（批量）· rename_path 重命名 · delete_path 删除（先自动备份）· search_files 按名搜索 · zip_compress/zip_extract 压缩解压 · transfer_file 跨设备搬运`

### ② 视觉与截图
`view_image 看图识图/OCR 转文字 · screenshot 截屏（网页视图/应用窗口/整屏，看完自动分析）· svg_to_png 图表渲染`

### ③ 网络四件套
`web_search 搜索（必应国内/必应国际/百度/DuckDuckGo 四引擎并发）· web_fetch 抓网页（正文/链接/图片/视频地址，带反反爬：UA 伪装+指纹一致性+Cloudflare 挑战页自动等待）· download_file 下载文件（防盗链补 Referer，上限 2GB）· open_url 打开网址给人看`

### ④ Word 全套（13 个工具，含论文排版闭环）
`create_word 生成（标题/图片/表格/页眉页脚/目录自动排版）· read_word 读内容 · modify_word 追加/重写/精准替换 · **论文流水线**：read_paper_spec 读格式模板 → apply_word_template 套模板（含封面字段）→ check_paper_format 逐节体检 → fix_paper_paging 分页修复 · read_word_format 读格式 → apply_word_format 参考改格式 · read_word_tables/add_word_table/edit_word_table/format_word_table 表格增删改合并斜线表头三线表`

### ⑤ Excel / PPT / PDF
`create_table 建 Excel（多表/公式/合并/样式）· read_table 读 · append_table_rows 追加 · modify_table 改格子（支持公式）· format_table 美化（现代/经典/政务主题）· create_pptx 生成 PPT（18 套配色 × 4 风格 × 封面/目录/章节/内容/总结页型自动排版）· read_pptx 逐页读 · edit_pptx 精准改字 · read_pdf 读 PDF 文字层 · pdf_to_image PDF 转图（扫描件 OCR 前置）`
> Word 生成后有结构校验关卡：文件坏了当场报错自愈，不交付坏件

### ⑥ 本机交互
`open_path 用默认程序打开文件/文件夹 · open_url 开浏览器 · ask_user 弹问题卡片 · task_plan 任务清单 · delegate 派子 Agent`

**安全机制**：危险操作（删除/覆盖/移动/exe 运行）弹审批卡片人工确认；删除覆盖前自动快照，一键还原；undo 记录可回滚。

## 四、复合工作流（能力串联的真实用法）

1. **城市介绍 PPT**（你说的场景）：`web_search 搜重庆资料 → web_fetch 抓两篇攻略正文 → generate_image 生成配图 + download_file 下载实景图 → view_image 挑图 → create_pptx 按大纲排版出稿`——全程一句话驱动
2. **毕业论文排版闭环**：拿到学校模板 docx + 论文 docx → `read_paper_spec 蒸馏格式规范 → apply_word_template 套用 → check_paper_format 体检 → 逐节修到全绿 → fix_paper_paging`——格式不过关重来的噩梦终结者
3. **数据报告三件套**：Excel 数据 → `read_table 读 → 分析 → svg_to_png 画图表 → create_word/ create_pptx 出图文报告`
4. **扫描件转电子档**：PDF 扫描件 → `pdf_to_image 逐页转图 → view_image 逐张 OCR → create_word 汇总成文`
5. **全网图片收集**："把重庆洪崖洞的高清图收 20 张存桌面" → `web_search 找图站 → web_fetch images 模式抓直链 → download_file 批量并行下载`
6. **跨电脑搬运**："把这个安装包下载后直接传到我朋友那台电脑" → `download_file 下本机 → transfer_file 跨设备直传`
7. **桌面大扫除**："桌面太乱了，按类型归档到文件夹" → `screenshot 看现状 → search_files/list_dir 摸底 → move_path 批量归类（每步快照可还原）`
8. **多线并行调研**："帮我对比 5 款 NAS 的参数" → `delegate 派 4 个子 Agent 各查各的 → 主 Agent 汇总成对比表`
9. **截图答疑**："我这屏幕上的报错咋回事" → `screenshot 截全屏 → view_image 分析报错 → 给方案`
10. **改字不动版式**：领导发来的 PPT 只改三处文字 → `read_pptx 定位 → edit_pptx 精准替换`（跨样式碎句也能匹配）
11. **对讲机**：同一局域网两台电脑按住说话实时对讲（测试喊话/同好联机）
12. **定时整理**（配合长期记忆）："以后每天下载的新文件按周归档" → AI 记住规则，随叫随整理

## 五、应用本体

| 功能 | 说明 |
|---|---|
| 账号体系 | 邮箱注册/登录（密码全程 RSA 加密传输），找回密码 |
| 积分经济 | 余额/签到/充值（六档位+收款码+凭证审核）/消费明细，AI 消耗透明计费 |
| 云同步 | 设置/会话/工作台跨设备同步（换电脑即迁） |
| 自动更新 | 检查 GitHub Release 一键升级 |
| 三主题 | 执事风（默认）/ 经典白 / 深色，实时切换持久化 |
| 应用内反馈 | 问题/建议直达开发者（ntfy 实时通知）+ GitHub Issues |
| 下载进度 | 内置浏览器下载实时进度浮条 |
| 托盘常驻 + 开机自启 | 关窗口不退出，随叫随到 |

## 六、诚实的边界（当前做不到）

- 不操作浏览器登录态（要登录的网站内容抓不到，只能抓公开页）
- 不执行任意系统命令/脚本（只开箱工具集，exe 运行需人工批准）
- 不实时监听系统事件（"每天自动"类需求需要你来喊它，无定时器）
- 互联网大文件传输受 2GB/日额度与服务器带宽限制（局域网直连无限制）
- 生视频 2-10 分钟/条，不能批量；生图 45 积分/张
