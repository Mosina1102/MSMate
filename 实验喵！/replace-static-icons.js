// index.html 静态 emoji → Lucide data-icon 批量替换（带存在性断言）
const fs = require('fs')
const p = 'f:/局域网互传2.6/src/index.html'
let html = fs.readFileSync(p, 'utf8')
let ok = 0, fail = []

// [原文, 新文] 精确对
const pairs = [
  // 顶栏
  ['<button id="helpBtn" class="btn btn-ghost btn-sm" title="操作手册与功能说明">\n          <span>？</span>\n        </button>',
   '<button id="helpBtn" class="btn btn-ghost btn-sm" title="操作手册与功能说明">\n          <span data-icon="circle-help"></span>\n        </button>'],
  // 会话栏
  ['<span class="session-bar-caret">▼</span>', '<span class="session-bar-caret" data-icon="chevron-down"></span>'],
  ['id="aiNewChatBtn" title="新建会话（多项目可并行推进）">＋<', 'id="aiNewChatBtn" title="新建会话（多项目可并行推进）" data-icon="plus"><'],
  ['<span>＋文</span>', '<span data-icon="file-plus"></span><span>文件</span>'],
  ['<span>＋夹</span>', '<span data-icon="folder-plus"></span><span>文件夹</span>'],
  // 顶栏状态区
  ['<span class="relay-icon">🌐</span>', '<span class="relay-icon" data-icon="globe"></span>'],
  ['id="relaySettingsBtn" title="互联网模式设置">⚙<', 'id="relaySettingsBtn" title="互联网模式设置" data-icon="settings"><'],
  ['<span class="relay-icon">📡</span>', '<span class="relay-icon" data-icon="radio-tower"></span>'],
  // AI 设置齿轮 → 滑杆（与全局设置齿轮区分）
  ['id="aiSettingsBtn" title="AI 设置（模型 / API Key）">⚙<', 'id="aiSettingsBtn" title="AI 设置（模型 / API Key）" data-icon="sliders-horizontal"><'],
  // 生成菜单
  ['<span class="gi">🖼</span>', '<span class="gi" data-icon="image"></span>'],
  ['<span class="gi">🎬</span>', '<span class="gi" data-icon="video"></span>'],
  ['id="chatGenPolish" title="发送前先用主模型把口语描述扩写成结构化提示词，生图更准">✨ 润色<', 'id="chatGenPolish" title="发送前先用主模型把口语描述扩写成结构化提示词，生图更准"><span data-icon="sparkles"></span> 润色<'],
  // 工作台/面板
  ['<span class="wb-view-icon" id="wbViewIcon">📄</span>', '<span class="wb-view-icon" id="wbViewIcon" data-icon="file-text"></span>'],
  ['<span class="panel-icon">💻</span>', '<span class="panel-icon" data-icon="laptop"></span>'],
  ['<span class="panel-icon">🌐</span>', '<span class="panel-icon" data-icon="globe"></span>'],
  // 空状态
  ['<div class="empty-icon">📡</div>', '<div class="empty-icon" data-icon="radio-tower"></div>'],
  ['<div class="empty-icon">📋</div>', '<div class="empty-icon" data-icon="clipboard"></div>'],
  ['<div class="empty-icon">📜</div>', '<div class="empty-icon" data-icon="file-text"></div>'],
  ['<div class="empty-icon">🗂</div>', '<div class="empty-icon" data-icon="folder-open"></div>'],
  ['<div class="empty-icon">📂</div>', '<div class="empty-icon" data-icon="folder-open"></div>'],
  ['<div class="empty-icon">🔗</div>', '<div class="empty-icon" data-icon="link"></div>'],
  // 对讲
  ['<span>🎙 对讲</span>', '<span data-icon="mic"></span><span>对讲</span>'],
  ['id="pttHotkeyHint" title="按住喊话，松开结束；右键远程面板「对讲」按钮可设置">🎙 对讲<', 'id="pttHotkeyHint" title="按住喊话，松开结束；右键远程面板「对讲」按钮可设置" data-icon="mic"><span>对讲</span>'],
  ['<span>🔊 <span id="pttIncomingName">对方</span> 正在喊话…</span>', '<span data-icon="volume-2"></span> <span id="pttIncomingName">对方</span> 正在喊话…'],
  // 弹窗标题
  ['<h3>🎙 对讲机设置</h3>', '<h3><span data-icon="mic"></span>对讲机设置</h3>'],
  ['<h3>📡 IPv6 直连</h3>', '<h3><span data-icon="radio-tower"></span>IPv6 直连</h3>'],
  ['<h3>🌐 互联网模式</h3>', '<h3><span data-icon="globe"></span>互联网模式</h3>'],
  ['<h3>📖 操作手册与功能说明</h3>', '<h3><span data-icon="book-open"></span>操作手册与功能说明</h3>'],
  // 手册节标题
  ['<h4>🔗 连接设备</h4>', '<h4><span data-icon="link"></span>连接设备</h4>'],
  ['<h4>📂 浏览文件</h4>', '<h4><span data-icon="folder-open"></span>浏览文件</h4>'],
  ['<strong>🖥️ 桌面</strong>', '<strong><span data-icon="monitor"></span> 桌面</strong>'],
  ['<h4>📤 传输文件</h4>', '<h4><span data-icon="send"></span>传输文件</h4>'],
  ['<h4>✏️ 编辑与新建</h4>', '<h4><span data-icon="square-pen"></span>编辑与新建</h4>'],
  ['<h4>📋 复制 / 剪切 / 粘贴</h4>', '<h4><span data-icon="clipboard"></span>复制 / 剪切 / 粘贴</h4>'],
  ['<h4>🗑 删除与同步</h4>', '<h4><span data-icon="trash-2"></span>删除与同步</h4>'],
  ['<h4>💻 设备备注与改名</h4>', '<h4><span data-icon="laptop"></span>设备备注与改名</h4>'],
  ['<strong>✏️</strong> 按钮可修改本机设备名称', '<strong><span data-icon="square-pen"></span></strong> 按钮可修改本机设备名称'],
  ['<h4>⌨️ 快捷键</h4>', '<h4><span data-icon="keyboard"></span>快捷键</h4>'],
  ['<h4>🎙 对讲机</h4>', '<h4><span data-icon="mic"></span>对讲机</h4>'],
  ['<strong>「🎙 对讲」</strong>', '<strong>「对讲」</strong>'],
  ['<h4>🔔 通知</h4>', '<h4><span data-icon="bell"></span>通知</h4>'],
  // 设备右键菜单
  ['<div class="menu-item" data-action="device-remark">📝 添加/修改备注</div>', '<div class="menu-item" data-action="device-remark"><span data-icon="file-pen"></span> 添加/修改备注</div>'],
  ['<div class="menu-item" data-action="device-clear-remark">🗑 清除备注</div>', '<div class="menu-item" data-action="device-clear-remark"><span data-icon="trash-2"></span> 清除备注</div>'],
  // 设置页：服务商/模型按钮
  ['<option value="">📌 已存服务商（空：下面填写后点 💾 存入）</option>', '<option value="">已存服务商（空：下面填写后点「存入」）</option>'],
  ['id="aiProviderLibDelBtn" class="ai-model-btn" title="删除选中的服务商">🗑<', 'id="aiProviderLibDelBtn" class="ai-model-btn" title="删除选中的服务商" data-icon="trash-2"><'],
  ['id="aiProviderLibSaveBtn" class="ai-model-btn" title="保存/更新到服务商库">💾<', 'id="aiProviderLibSaveBtn" class="ai-model-btn" title="保存/更新到服务商库" data-icon="save"><'],
  ['id="aiModelAddBtn" class="ai-model-btn" title="把上面输入框里的模型加进常用">➕<', 'id="aiModelAddBtn" class="ai-model-btn" title="把上面输入框里的模型加进常用" data-icon="plus"><'],
  ['id="aiModelDelBtn" class="ai-model-btn" title="删除选中的常用模型">🗑<', 'id="aiModelDelBtn" class="ai-model-btn" title="删除选中的常用模型" data-icon="trash-2"><'],
  ['id="aiVisionModelAddBtn" class="ai-model-btn" title="把上面输入框里的识图模型加进常用">➕<', 'id="aiVisionModelAddBtn" class="ai-model-btn" title="把上面输入框里的识图模型加进常用" data-icon="plus"><'],
  ['id="aiVisionModelDelBtn" class="ai-model-btn" title="删除选中的常用识图模型">🗑<', 'id="aiVisionModelDelBtn" class="ai-model-btn" title="删除选中的常用识图模型" data-icon="trash-2"><'],
  ['id="aiVoiceModelAddBtn" class="ai-model-btn" title="把上面输入框里的语音模型加进常用">➕<', 'id="aiVoiceModelAddBtn" class="ai-model-btn" title="把上面输入框里的语音模型加进常用" data-icon="plus"><'],
  ['id="aiVoiceModelDelBtn" class="ai-model-btn" title="删除选中的常用语音模型">🗑<', 'id="aiVoiceModelDelBtn" class="ai-model-btn" title="删除选中的常用语音模型" data-icon="trash-2"><'],
  ['<option value="">📌 我的常用</option>', '<option value="">我的常用</option>'],
  ['<option value="">📌 我的常用识图模型</option>', '<option value="">我的常用识图模型</option>'],
  ['<option value="">📌 我的常用语音模型</option>', '<option value="">我的常用语音模型</option>'],
  // 数据导出/导入
  ['id="aiExportDataBtn">⬆ 导出数据<', 'id="aiExportDataBtn" data-icon="upload"><span>导出数据</span>'],
  ['id="aiImportDataBtn">⬇ 导入数据<', 'id="aiImportDataBtn" data-icon="download"><span>导入数据</span>'],
  // 上级按钮（⌫ → 箭头）
  ['<span title="上级目录">⌫</span>', '<span title="上级目录" data-icon="arrow-up-left"></span>'],
]

for (const [oldS, newS] of pairs) {
  if (html.includes(oldS)) {
    html = html.split(oldS).join(newS)
    ok++
  } else {
    fail.push(oldS.slice(0, 60))
  }
}
fs.writeFileSync(p, html)
console.log(`替换 ${ok}/${pairs.length} 对`)
if (fail.length) { console.log('未命中：'); fail.forEach(f => console.log('  ' + f)) }

// 残留 emoji 复查
const re = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}]/gu
const rest = [...new Set(html.match(re) || [])]
console.log('残留符号：', rest.join(' '))
