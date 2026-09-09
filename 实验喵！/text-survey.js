// 应用文案普查（只读分析，不改任何文件）
// 规则：短（按钮≤6字）、结论先行、报错=原因+下一步、术语统一、去 emoji
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8')
const appjs = fs.readFileSync(path.join(root, 'src/js/app.js'), 'utf8')
const webchat = fs.readFileSync(path.join(root, 'src/js/webchat.js'), 'utf8')

// 1) index.html 可见文本（粗提：去标签、去注释、去 style/script）
const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
const texts = []
body.split('\n').forEach((line, i) => {
  const m = line.match(/>([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g) || []
  for (const seg of m) {
    const t = seg.slice(1, -1).trim()
    if (t) texts.push({ line: i + 1, t })
  }
})

console.log('===== index.html 静态文案（' + texts.length + ' 条）=====')
for (const { line, t } of texts) {
  const flags = []
  if (/[\u2190-\u2BFF\u{1F000}-\u{1FAFF}]/u.test(t)) flags.push('EMOJI')
  if (t.length > 20) flags.push('LONG')
  if (flags.length) console.log(`L${line} [${flags.join(',')}] ${t}`)
  else console.log(`L${line} ${t}`)
}

// 2) app.js / webchat.js 中文 UI 字符串（toast/标题/按钮/confirm）
console.log('\n===== JS 动态文案统计 =====')
const jsStats = {}
for (const [name, src] of [['app.js', appjs], ['webchat.js', webchat]]) {
  const cn = src.match(/['"`][^'"`]*[\u4e00-\u9fa5][^'"`]*['"`]/g) || []
  let toast = 0, confirm = 0, btn = 0, title = 0, long = 0
  const longSamples = []
  for (const s of cn) {
    const t = s.slice(1, -1)
    if (t.length > 40) { long++; if (longSamples.length < 8) longSamples.push(t.slice(0, 50)) }
    if (/showToast|toast\(/.test(t)) toast++
    if (/confirm|是否|确定/.test(t)) confirm++
    if (/textContent|button|按钮/.test(t)) btn++
    if (/title/.test(t)) title++
  }
  jsStats[name] = { total: cn.length, toast, confirm, btn, title, long }
  console.log(`${name}: 中文串 ${cn.length} 条 | 超40字长文案 ${long} 条`)
  longSamples.forEach(s => console.log(`   长文案例: ${s}…`))
}

// 3) 术语一致性粗查
console.log('\n===== 术语一致性 =====')
const terms = ['文件', '档案', '发送', '传送', '传输', '传文件', '设置', '配置', '设备', '机器', '目录', '文件夹', '图片', '图像', '视频', '影片', '聊天', '对话', '会话', '工作台', '工作区']
for (const t of terms) {
  const c1 = (appjs.match(new RegExp(t, 'g')) || []).length
  const c2 = (webchat.match(new RegExp(t, 'g')) || []).length
  const c3 = (body.match(new RegExp(t, 'g')) || []).length
  if (c1 + c2 + c3 > 0) console.log(`${t}: js=${c1} webchat=${c2} html=${c3}`)
}
