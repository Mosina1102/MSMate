// 聊天 markdown 渲染器冒烟测试：从 app.js 抽取 renderMarkdownFrag/appendInline 源码，
// 配迷你 DOM 垫片在 Node 里跑，断言渲染结构（加粗/列表/表格/代码块/防注入/路径名片兼容）
const fs = require('fs')
const path = require('path')

// ===== 迷你 DOM 垫片 =====
class TextNode {
  constructor(text) { this.nodeType = 3; this.nodeValue = String(text) }
  get textContent() { return this.nodeValue }
}
class Element {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {} }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  replaceChild(nu, old) { const i = this.children.indexOf(old); if (i >= 0) this.children[i] = nu; nu.parentNode = this }
  set textContent(v) { this.children = []; if (v !== '') this.children.push(new TextNode(v)) }
  get textContent() { return this.children.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('') }
  get lastElementChild() { for (let i = this.children.length - 1; i >= 0; i--) if (this.children[i].nodeType === 1) return this.children[i]; return null }
}
class Frag extends Element {
  constructor() { super('#frag') }
}
const document = {
  createElement: (t) => new Element(t),
  createTextNode: (t) => new TextNode(t),
  createDocumentFragment: () => new Frag()
}

// ===== 从渲染层源码抽取渲染器（appendInline/emitItalic/renderMarkdownFrag；v2.7.12 拆分后在 work.js）=====
const appSrc = ['app.js', 'word-embed.js', 'word-rich.js', 'work.js'].map(p => fs.readFileSync(path.join(__dirname, '../src/js', p), 'utf8')).join('\n')
const start = appSrc.indexOf('function appendInline')
const end = appSrc.indexOf('// 文件名片：图标 + 文件名 + 所在目录')
if (start < 0 || end < 0) { console.error('❌ 未能从 app.js 定位渲染器源码'); process.exit(1) }
const rendererSrc = appSrc.slice(start, end)
const { renderMarkdownFrag } = new Function('document', rendererSrc + '; return { renderMarkdownFrag }')(document)

// 结构断言助手
const textsOf = (el) => el.children.filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('')
// 结构断言助手（垫片 tagName 为大写，统一转大写比较）
const kids = (el, tag) => el.children.filter((c) => c.tagName === String(tag).toUpperCase())

async function main() {
  let pass = true
  const check = (label, cond) => {
    console.log((cond ? '✅' : '❌') + ' ' + label)
    if (!cond) pass = false
  }

  // 1. 行内加粗（截图里的翻车样例）
  const f1 = renderMarkdownFrag('**"E路护航"**（中国建设银行）已保存到您的桌面')
  const p1 = f1.children[0]
  check('**加粗** 渲染为 <strong>', kids(p1, 'strong').length === 1 && kids(p1, 'strong')[0].textContent === '"E路护航"')
  check('加粗外文字保留', textsOf(p1).includes('（中国建设银行）已保存到您的桌面'))

  // 2. 标题 + 列表（AI 常见输出）
  const f2 = renderMarkdownFrag('## 说明：\n- 这是从官网下载的安装程序\n- 文件是 exe 可执行程序\n\n1. 第一步\n2. 第二步')
  check('## 渲染为 <h2>', kids(f2, 'h2').length === 1 && kids(f2, 'h2')[0].textContent === '说明：')
  const ul = kids(f2, 'ul')[0]
  check('- 列表渲染为 <ul><li>', !!ul && kids(ul, 'li').length === 2 && kids(ul, 'li')[0].textContent.includes('官网下载'))
  const ol = kids(f2, 'ol')[0]
  check('1. 列表渲染为 <ol><li>', !!ol && kids(ol, 'li').length === 2)

  // 3. 代码块
  const f3 = renderMarkdownFrag('看这个：\n```js\nconst a = 1\n```')
  const pre = kids(f3, 'pre')[0]
  check('``` 代码块渲染为 <pre><code>', !!pre && kids(pre, 'code').length === 1 && kids(pre, 'code')[0].textContent === 'const a = 1')

  // 4. 防注入：<script> 必须是文本节点而不是元素
  const f4 = renderMarkdownFrag('hello <script>alert(1)</script> world')
  const f4Tags = []
  ;(function walk(el) { for (const c of el.children) { if (c.nodeType === 1) { f4Tags.push(c.tagName); walk(c) } } })(f4)
  check('<script> 不产生任何元素（防注入）', !f4Tags.includes('SCRIPT'))

  // 5. 表格
  const f5 = renderMarkdownFrag('| 姓名 | 数量 |\n|---|---|\n| 苹果 | 3 |\n| 香蕉 | 12 |')
  const table = kids(f5, 'table')[0]
  check('markdown 表格渲染为 <table>', !!table)
  if (table) {
    const thead = kids(table, 'thead')[0]
    check('表头两列', !!thead && kids(kids(thead, 'tr')[0], 'th').length === 2)
    const tbody = kids(table, 'tbody')[0]
    check('两行数据', !!tbody && kids(tbody, 'tr').length === 2)
  }

  // 6. 链接（http 才放行）
  const f6 = renderMarkdownFrag('[官网](https://example.com) 和 [坏的](javascript:alert(1))')
  const p6 = f6.children[0]
  check('http 链接渲染为 <a>', kids(p6, 'a').length === 1)

  // 7. 引用 + 分隔线 + 段内换行
  const f7 = renderMarkdownFrag('> 引用一句\n\n第一行\n第二行')
  check('> 引用渲染为 <blockquote>', kids(f7, 'blockquote').length === 1)
  const p7 = f7.children.filter((c) => c.tagName === 'P').pop()
  check('段内换行保留（pre-wrap 文本节点）', !!p7 && textsOf(p7).includes('\n'))

  // 8. 常规无 markdown 文本不变形
  const f8 = renderMarkdownFrag('已下载完成！')
  check('纯文本正常成段', f8.children.length === 1 && f8.children[0].tagName === 'P' && f8.children[0].textContent === '已下载完成！')
  // 9. 用户截图样例全量回归：加粗+说明+列表混排
  const f9 = renderMarkdownFrag('**说明：**\n- 这是从官网下载的安装程序\n- 双击即可运行安装')
  const p9first = f9.children[0]
  check('首段加粗+列表组合', kids(p9first, 'STRONG').length === 1 && kids(f9, 'UL').length === 1)

  console.log(pass ? '\n全部通过' : '\n存在失败项')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
