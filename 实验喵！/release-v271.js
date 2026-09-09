// v2.7.1 GitHub 发布（token 从环境变量 GH_TOKEN 读取，绝不落盘）
const https = require('https')
const fs = require('fs')
const path = require('path')

const TOKEN = process.env.GH_TOKEN
if (!TOKEN) { console.log('FAIL 未设置 GH_TOKEN'); process.exit(1) }
const REPO = 'Mosina1102/MSMate'
const DIR = path.join(__dirname, '..', 'release_build_v271')
const BODY = `## MSMate v2.7.1 — 人设微调 · 乱码修复

### 内置 AI 人设微调（莫西）
- 称呼更自然：默认称呼「你」，只在关怀句/收尾句自然带出，不每句塞
- 新增「声音」小节：说话体口语小词自然带，不播报腔——像随口说话，不像念稿

### 修复
- 工作台预览顶栏图标显示 SVG 源码乱码（@license lucide-static 注释开头那段）——图标改用 HTML 渲染，全局排查零残留
- 文件夹网格图标同类隐患一并修复

**下载**：MSMate.Setup.2.7.1.exe（Windows x64）`

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
      if (r.tag_name === 'v2.7.1') { await api('DELETE', `/repos/${REPO}/releases/${r.id}`); console.log('已删除旧 release', r.id) }
    }
  }
  const rel = await api('POST', `/repos/${REPO}/releases`, {
    tag_name: 'v2.7.1', target_commitish: 'main', name: 'MSMate v2.7.1 — 人设微调 · 乱码修复',
    body: BODY, draft: false, prerelease: false })
  if (rel.status !== 201) { console.log('FAIL 创建 release', rel.status, JSON.stringify(rel.json).slice(0, 300)); process.exit(1) }
  console.log('release 创建 OK id=', rel.json.id, 'upload_url 拿到')
  for (const f of ['MSMate.Setup.2.7.1.exe', 'MSMate.Setup.2.7.1.exe.blockmap']) {
    const up = await upload(rel.json.upload_url, f, path.join(DIR, f))
    console.log(f, up.status === 201 ? '上传 OK' : `FAIL ${up.status}`)
    if (up.status !== 201) process.exit(1)
  }
  console.log(`发布完成: ${rel.json.html_url}`)
})().catch(e => { console.log('FAIL', e.message); process.exit(1) })
