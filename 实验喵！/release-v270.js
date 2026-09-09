// v2.7.0 GitHub 发布（token 从环境变量 GH_TOKEN 读取，绝不落盘）
const https = require('https')
const fs = require('fs')
const path = require('path')

const TOKEN = process.env.GH_TOKEN
if (!TOKEN) { console.log('FAIL 未设置 GH_TOKEN'); process.exit(1) }
const REPO = 'Mosina1102/MSMate'
const DIR = path.join(__dirname, '..', 'release_build_v270')
const BODY = `## MSMate v2.7.0 — UI 大更新 · 默认人设上线

### 全新视觉
- 全新 M 形猫耳图标（MSMate 紫负空间藏猫脸），应用内品牌位全量换装
- **执事风主题**（新默认）：灰阶分层 / 1px 分隔线 / 输入框浅灰凹陷 / 用户气泡 MSMate 弱紫；新增「经典白」「深色」主题切换（设置 → 主题）
- 全应用图标统一为 Lucide 线性风格；按钮主色回归 MSMate 紫，绿色只表达在线/成功

### 文案与布局
- 底部快捷键提示条移除（操作手册兜底）；弹窗长说明收敛为「结论 + 了解更多」
- 报错信息统一补「下一步」指引；术语统一「会话」
- 文件面板操作图标化、路径框弹性收缩，窄面板不再拥挤；修复 Work 模式页签竖排显示

### 内置 AI 人设 v0.4
- 默认人设「莫西（Mosi）」：三无姐姐感，外冷内热，寡言但把活干完；真名「雷娜塔（Renata）」只有你问了才说
- 会记住你的习惯与上线时间：熬夜会提醒、好习惯会夸；用户自定义规则始终优先于她的表现层

### 修复
- 文件列表图标显示异常；图片编辑器画笔颜色统一 MSMate 紫
- Electron 22（Chromium 108）color-mix 兼容修复；正式包 CSS 变量静默回退清欠

**下载**：MSMate.Setup.2.7.0.exe（Windows x64）`

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const req = https.request({ host: 'api.github.com', path: p, method,
      headers: { 'User-Agent': 'msmate-release', 'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } },
      res => { let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf) } catch { return buf } })() })) })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function upload(url, name, file) {
  return new Promise((resolve, reject) => {
    const u = new URL(url.split('{')[0] + `?name=${name}`)
    const data = fs.readFileSync(file)
    const req = https.request({ host: u.host, path: u.pathname + u.search, method: 'POST',
      headers: { 'User-Agent': 'msmate-release', 'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/octet-stream', 'Content-Length': data.length } },
      res => { let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(buf) } catch { return buf } })() })) })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

;(async () => {
  // 幂等：删同 tag 旧 release（草稿/正式都查）
  const existing = await api('GET', `/repos/${REPO}/releases`)
  if (Array.isArray(existing.json)) {
    for (const r of existing.json) {
      if (r.tag_name === 'v2.7.0') { await api('DELETE', `/repos/${REPO}/releases/${r.id}`); console.log('已删除旧 release', r.id) }
    }
  }
  const rel = await api('POST', `/repos/${REPO}/releases`, {
    tag_name: 'v2.7.0', target_commitish: 'main', name: 'MSMate v2.7.0 — UI 大更新 · 默认人设上线',
    body: BODY, draft: false, prerelease: false })
  if (rel.status !== 201) { console.log('FAIL 创建 release', rel.status, JSON.stringify(rel.json).slice(0, 300)); process.exit(1) }
  console.log('release 创建 OK id=', rel.json.id, 'upload_url 拿到')
  for (const f of ['MSMate.Setup.2.7.0.exe', 'MSMate.Setup.2.7.0.exe.blockmap']) {
    const up = await upload(rel.json.upload_url, f, path.join(DIR, f))
    console.log(f, up.status === 201 ? '上传 OK' : `FAIL ${up.status}`)
    if (up.status !== 201) process.exit(1)
  }
  console.log(`发布完成: ${rel.json.html_url}`)
})().catch(e => { console.log('FAIL', e.message); process.exit(1) })
