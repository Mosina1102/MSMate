# Word 文档工具手册

> 手册版本随应用发布。经验条目以本册为准，禁止编造"第N条"不存在的规则。

## 何时读我

要创建、修改、读取 Word（.docx）或读取 PDF 时先读本册——含全部参数文档、排版铁律和标准工作流。只用 write_file 写 txt/md 不需要本册。

## 工具详解

### create_word

**params**: path(docx完整路径), title(文档标题), paragraphs(段落数组,元素为字符串或{text,style,runs,align,color,size,bold,italic,font,tone}), content(正文,支持markdown：#/##/### 标题、**加粗**、*斜体*、__下划线__、~~删除线~~、==高亮==、`代码`、> 引用、- 列表、![图注](图片路径)插图、|a|b|表格自动转Word表格), header(可选,页眉文字), footer(可选,页脚文字), pageNumbers(可选,bool,页脚页码), toc(可选,bool,自动目录——生成后目录条目立即可见，页码在Word里Ctrl+A后F9刷新), tocLevels(可选,"1-2"或"1-3"), theme(可选,主题:modern(默认,现代蓝)/classic(经典公文蓝)/gov(红头公文)；也可传对象换品牌色 {base:"modern", accent:"C95716"} 一键把标题/引用条/表头全换成强调色), fonts(可选,{heading:标题字体,body:正文字体,western:西文字体}), lineSpacing(可选,行距倍数如1.5；不传时正文自带1.4倍呼吸行距+段后距), firstLine(可选,bool,正文首行缩进2字符), cover(可选,{title,subtitle,org,author,date}封面页), target(可选)

**desc**: 创建 Word 文档(.docx)。content 直接写聊天里那种优质 markdown，标题/加粗/斜体/下划线/删除线/高亮/代码/列表自动排版，markdown 表格行（| 姓名 | 数量 |）自动转成带边框底色的 Word 表格。**图片三合一控制**：![图注](C:\...\图.png) 默认居中自适应页宽；指定大小写 ![图注](C:\...\图.png =400)（宽度像素等比缩放，小图放小不拉伸）；对齐写 ![图注](C:\...\图.png =400) {align:left} 或 {align:right}（图注跟随）。**排版素养（任何类型文档都遵守）**：①凡枚举/数据/对比/清单型信息（天气数据、角色设定、时间线、参数、优缺点对比）**一律 markdown 表格**，写成大段文字=排版失败 ②关键结论/金句/注意事项用 callout 信息卡 {text:"...",style:"callout",tone:"info|ok|warm|danger"} ③正式文档配 cover 封面页 ④有主题的（动漫/品牌/活动）传 theme:{accent:"主题色"}（如罪恶王冠可用 "8B2F3F"）⑤**禁止用 ❖✦◆ 之类 unicode 符号装点标题和段落**——视觉层次只靠标题层级/表格/信息卡/颜色，符号凑数一眼廉价 ⑥正文已自带呼吸行距+段后距，嫌挤传 lineSpacing:1.6、嫌松传 1.3。论文/正式报告传 toc:true + pageNumbers:true + header 页眉文字；**中文版式**：报告/解析/论文/公文类传 firstLine:true——正文首行自动缩进2字符（标题/列表/表格不缩进），就是"一、标题"下面正文空两格的传统版式，现代风策划/海报可不缩进；标准件组合：fonts:{heading:"黑体",body:"仿宋",western:"Times New Roman"} + lineSpacing:1.5 + firstLine:true + cover 封面页。**版式蓝图先行（破除千篇一律，每篇必做）**：动笔前先在心里定三件事——①文档气质（活泼/严肃/学术/商务提案/红头公文）→ 定 theme 主色 accent 和 fonts 搭配 ②读者在哪看（打印上交/屏幕阅读/投屏汇报）→ 定要不要 cover 封面、header 页眉、pageNumbers 页码 ③骨架三选一**别固化**：策划案骨架=cover 封面+金句引用开场+数据表格+callout 卡片穿插+分隔线分章；教程骨架=无封面直接 ## 步骤标题+callout 提示+列表清单；公文骨架=gov 主题+firstLine:true+纯段落无表格。发现上一篇也是这个结构就换一个——连续两篇同骨架=排版失败；markdown 里 `---` 独占一行会渲染成细灰分隔线（章节间轻分区，比密集 h2 更轻的节奏工具）

### read_word

**params**: path(docx完整路径), seg(可选,第几段——长文档自动分段后逐段读), target(可选)

**desc**: 读取 Word 文档(.docx)的文字内容。**自动带出文档批注**（作者+被批注的原文+批注内容）。**长文档自动分段防幻觉**：超过 5000 字自动按段落边界切段返回"第 X/Y 段"，逐段传 seg 读取、逐段修改——不要试图一次读完长文档

### modify_word

**params**: path(docx完整路径), mode(append=追加到末尾/replace=全量重写/edit=精准替换,默认append), paragraphs/content(append/replace时的新内容,格式同create_word,支持样式/插图/markdown表格), replacements(edit模式必填,替换数组 [{find:"旧文字", replace:"新文字", all?}] ,all默认true), title(可选,仅replace时替换标题), header/footer/pageNumbers/toc/fonts/lineSpacing/firstLine/cover/theme(可选,仅replace时生效), target(可选)

**desc**: 修改已有 Word 文档（自动备份原文件）。三种模式：append=追加内容（插图、表格也支持）；replace=全量重写；edit=只改几处文字时用精准替换 replacements:[{find:"错别字", replace:"正确字"}]，不用重读重写全文，改几个词首选这个。**C 盘保护区文档自动转工作台改稿副本**：目标在 C:\Users 等保护区（工作台/桌面除外）时，工具自动把原文件复制到工作台「改稿」文件夹，在副本上修改，原文件全程不动留作对比参考——流程：改副本 → read_word 自检副本 → 满意后 copy_path 把副本复制回原路径（写回用户目录弹一次审批，属正常，向用户说明即可）；要多轮修改就继续操作同一副本（工具会智能沿用，不会丢进度），别反复对原路径空转

### read_pdf

**params**: path(pdf完整路径), target(可选)

**desc**: 读取 PDF 文件的文字内容（文本层提取）。**返回"没有文本层"提示时说明是扫描件/图片型 PDF——改用 pdf_to_image 转图片后逐张 view_image 识图读取**

### pdf_to_image

**params**: path(pdf完整路径), pages(可选,默认前10页), target(可选)

**desc**: **把 PDF 每页渲染成 PNG 图片**（Windows 系统自带渲染引擎，每页一张存到工作区并返回图片路径清单）。用途：扫描件/图片型 PDF（read_pdf 读不出文本层时）转图片后逐张 view_image 识图读取；或者需要看 PDF 版面/表格结构时用

## 本册经验（原主规则经验手册条目，遇到直接套用）

- 【经验·原第5条】**创建 Word**：create_word，把你在聊天里写优质回答时的 markdown **原样**放进 content——#/##/### 标题层级、**加粗**、*斜体*、__下划线__、~~删除线~~、==高亮==、`代码`（行内重点如"这是**最重要**的一点"）、> 引用、- 列表，排版引擎自动转换；**插图**：写一行 ![图注](C:\完整路径\图.png)，图片居中嵌入并带图注；**控大小**：路径后加 =400（宽度像素等比缩放）；**控对齐**：行尾加 {align:left} 或 {align:right}。**排版铁律（任何类型文档都遵守）**：①凡枚举/数据/对比/清单型信息（天气数据、角色设定、时间线、参数、优缺点）**一律写 markdown 表格行**，禁止堆成大段文字——大段文字=排版失败 ②关键结论/金句/注意事项用 callout 信息卡：{"text":"...","style":"callout","tone":"info|ok|warm|danger"} ③正式文档配 cover:{title,subtitle,org,author,date} 封面页 ④有主题的文档（动漫/品牌/活动）传 theme:{base:"modern",accent:"主题色十六进制"}（如罪恶王冠可用 "8B2F3F"）⑤**禁止用 ❖✦◆ 之类 unicode 符号装点标题段落**——视觉层次只靠标题/表格/信息卡/颜色。**论文/正式报告**加参数：toc:true（自动目录，生成后立即可见）+ pageNumbers:true（页脚页码）+ header:"页眉文字"。**中文版式**：报告/解析/论文/公文类传 firstLine:true——正文首行自动缩进2字符（"一、标题"下面正文空两格的传统版式，标题/列表/表格不缩进），现代风策划可不缩进。**整体换风格**传 theme：modern（默认现代蓝）/classic（经典公文蓝）/gov（红头公文）。正文已自带呼吸行距+段后距；用户嫌挤传 lineSpacing:1.6、嫌松传 1.3。**禁止偷懒缩水**：交付到 Word 的内容丰富度必须 ≥ 你聊天回复的水准，禁止写成流水账，禁止用 write_file 写 txt/md 顶替 Word 成品。
- 【经验·原第6条】**修改 Word**：只改几处文字 → modify_word(mode=edit, replacements:[{find:"旧词", replace:"新词"}]) 精准替换（首选，不用重读重写全文）；补内容 → modify_word(mode=append) 追加（同样支持 markdown 样式和 ![图](路径) 插图）；大改先 read_word 读原文再 modify_word(mode=replace) 全量重写（replace 时可重设 toc/pageNumbers/header/footer/theme）。**禁止为"修改"而自己新建第二个文件糊弄**——C 盘文档工具会自动转工作台改稿副本（见 modify_word desc），那是工具的中转流程，最终必须 copy_path 回写原路径才算交付；其他盘符原地改。
- 【经验·原第9条】**二进制文件必须用专用工具**：.docx 用 read_word、.xlsx 用 read_table，read_file 会拒绝二进制；反过来 .txt/.md/.json/.js 等文本用 read_file，不要用 read_word。**只为知道内容时纯文本直读**：read_file/read_word/read_table 返回的内容读到就直接用，禁止为了"看懂"把文档解析/转换成 HTML、markdown 或富文本再读一遍（纯属浪费）——只有要改格式/排版/表格结构时才需要关心样式信息。

## 本册标准流程（原主规则 SOP 条目）

- **写文档/报告/论文**：思考里先列内容大纲 → create_word（markdown 原样传 content；行内重点用 **加粗**/*斜体*/__下划线__/==高亮== 等写法；需要插图写 ![图注](图片路径) 行；**数据/对比/清单型信息必须写 markdown 表格行**（| 日期 | 天气 | 气温 |），会自动转成带主题底色的 Word 表格；关键结论用 callout 信息卡 {style:"callout",tone:...}；有主题色的传 theme:{accent:...}，正式的配 cover 封面；论文/正式报告加 toc:true + pageNumbers:true + header）→ 汇报完整路径和内容概要。**成品排版必须对齐你聊天回复的水准**：层级标题、加粗重点、列表引用一个不少，**大段数据不许裸奔**。
- **论文/公文排版标准件**：用户要求论文格式、公文格式、双面打印规范时 → create_word 全套传：fonts:{heading:"黑体",body:"仿宋",western:"Times New Roman"}（或用户指定的字体）+ lineSpacing:1.5 + firstLine:true + cover:{title,subtitle,org,author,date} 封面页 + toc:true + pageNumbers:true。红头公文直接 theme:"gov"。字体参数用户没指定就按此默认，不必问。（按学校模板改论文格式另有专用闭环，见 论文排版.md）
- **文档排版**：用户要求排版/美化 Word 时 → read_word 读全文 → modify_word(mode=replace) 重写，段落用样式对象：{"text":"标题","style":"h1"}（支持 h1/h2/h3/bold/center/quote，普通段用字符串或 {"text":"..."}；单段可加 align/color/size/font 覆盖；表格用 markdown 行）。
- **修改 C 盘已有文档（改稿闭环）**：modify_word 直接管原路径（工具自动转工作台「改稿」副本，原文件不动）→ read_word 自检副本 → 不满意继续改同一副本（禁止反复对原路径空转，会重复建副本丢进度）→ 满意后 copy_path(源=副本路径, 目标=原路径) 回写（弹一次审批，提前跟用户说"改好了，确认写回原文件"）→ 汇报：原文件路径 + 改了什么。全文对比参考 = 原文件一直在原位。

## 册内工作流

- **创建闭环**：定版式蓝图（气质/读者/骨架三选一）→ create_word → 汇报完整路径和内容概要。
- **修改闭环**：小改 modify_word(edit) 首选，不重读重写全文；大改 read_word → modify_word(replace)。禁止为"修改"新建第二个文件。
- **PDF 三级链路**：read_pdf → 返回"没有文本层" → pdf_to_image 转图 → 逐张 view_image 识图读取。
- **同名文件**：write_file 会覆盖；但用户重要文件先 read_file 看内容再决定是否覆盖。
