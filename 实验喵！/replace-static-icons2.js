// index.html 静态 emoji 替换补丁 2（带存在性断言）
const fs = require('fs')
const p = 'f:/局域网互传2.6/src/index.html'
let html = fs.readFileSync(p, 'utf8')
let ok = 0, fail = []

const pairs = [
  ['title="发送前先用主模型把口语描述扩写成结构化提示词，生图更准（多几秒）">✨润色<', 'title="发送前先用主模型把口语描述扩写成结构化提示词，生图更准（多几秒）"><span data-icon="sparkles"></span>润色<'],
  ['<option value="">🌐 默认</option>', '<option value="">默认</option>'],
  ['<option value="">📌 我的常用模型（空：输入后点 ➕）</option>', '<option value="">我的常用模型（空：输入后点「添加」）</option>'],
  ['<option value="">📌 我的常用识图模型（空：输入后点 ➕）</option>', '<option value="">我的常用识图模型（空：输入后点「添加」）</option>'],
  ['<option value="">📌 我的常用语音模型（空：输入后点 ➕）</option>', '<option value="">我的常用语音模型（空：输入后点「添加」）</option>'],
  ['<option value="">🎵 音色：Alex（沉稳男声）</option>', '<option value="">音色：Alex（沉稳男声）</option>'],
  ['>🎵 Benjamin（磁性男声）<', '>Benjamin（磁性男声）<'],
  ['>🎵 Charles（活力男声）<', '>Charles（活力男声）<'],
  ['>🎵 David（阳光男声）<', '>David（阳光男声）<'],
  ['>🎵 Anna（温柔女声）<', '>Anna（温柔女声）<'],
  ['>🎵 Bella（甜美女声）<', '>Bella（甜美女声）<'],
  ['>🎵 Claire（知性女声）<', '>Claire（知性女声）<'],
  ['>🎵 Diana（活泼女声）<', '>Diana（活泼女声）<'],
  ['id="aiTtsTestBtn" class="btn btn-sm">▶ 试听<', 'id="aiTtsTestBtn" class="btn btn-sm" data-icon="play"><span>试听</span>'],
  ['启用后工作台出现 🌐 网页页签', '启用后工作台出现「网页」页签'],
  ['生图/视频模型用于 ✨ 生成模式和 AI 自主调用', '生图/视频模型用于「生成」模式和 AI 自主调用'],
  ['<label>⏰ 定时任务（每天到点自动给 AI 派活，应用开着才触发）：</label>', '<label><span data-icon="clock"></span> 定时任务（每天到点自动给 AI 派活，应用开着才触发）：</label>'],
  ['id="aiScheduleAddBtn">➕ 添加<', 'id="aiScheduleAddBtn" data-icon="plus"><span>添加</span>'],
  ['<h3>📦 快照缓存槽</h3>', '<h3><span data-icon="archive"></span>快照缓存槽</h3>'],
  ['<div class="empty-icon">📦</div>', '<div class="empty-icon" data-icon="archive"></div>'],
  ['<div class="menu-item" data-action="paste">📋 粘贴 (Ctrl+V)</div>', '<div class="menu-item" data-action="paste"><span data-icon="clipboard"></span> 粘贴 (Ctrl+V)</div>'],
  ['<div class="menu-item" data-action="to-workbench">🗂 加入工作台</div>', '<div class="menu-item" data-action="to-workbench"><span data-icon="folder-input"></span> 加入工作台</div>'],
  ['<div class="menu-item" data-action="new-folder">📁 新建文件夹</div>', '<div class="menu-item" data-action="new-folder"><span data-icon="folder-plus"></span> 新建文件夹</div>'],
  ['<div class="menu-item" data-action="new-txt">📄 新建文本文档</div>', '<div class="menu-item" data-action="new-txt"><span data-icon="file-text"></span> 新建文本文档</div>'],
  ['<div class="menu-item" data-action="new-docx">📝 新建 Word 文档</div>', '<div class="menu-item" data-action="new-docx"><span data-icon="file-pen"></span> 新建 Word 文档</div>'],
  ['<div class="menu-item" data-action="new-xlsx">📊 新建 Excel 表格</div>', '<div class="menu-item" data-action="new-xlsx"><span data-icon="table"></span> 新建 Excel 表格</div>'],
  ['<div class="menu-item" data-action="new-pptx">📈 新建 PPT 演示</div>', '<div class="menu-item" data-action="new-pptx"><span data-icon="presentation"></span> 新建 PPT 演示</div>'],
  ['<div class="menu-item" data-action="copy">📋 复制 (Ctrl+C)</div>', '<div class="menu-item" data-action="copy"><span data-icon="clipboard"></span> 复制 (Ctrl+C)</div>'],
  ['<div class="menu-item" data-action="cut">✂️ 剪切 (Ctrl+X)</div>', '<div class="menu-item" data-action="cut"><span data-icon="scissors"></span> 剪切 (Ctrl+X)</div>'],
]

for (const [oldS, newS] of pairs) {
  if (html.includes(oldS)) { html = html.split(oldS).join(newS); ok++ } else { fail.push(oldS.slice(0, 55)) }
}
fs.writeFileSync(p, html)
console.log(`替换 ${ok}/${pairs.length} 对`)
if (fail.length) { console.log('未命中：'); fail.forEach(f => console.log('  ' + f)) }

// 终查
const re = /[\u{1F000}-\u{1FAFF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}✨]/gu
const rest = [...new Set(html.match(re) || [])]
console.log('index.html 残留 emoji：', rest.length ? rest.join(' ') : '无')
