// v2.7.11 GitHub 发布（token 从环境变量 GH_TOKEN 读取，绝不落盘）
const https = require('https')
const fs = require('fs')
const path = require('path')

const TOKEN = process.env.GH_TOKEN
if (!TOKEN) { console.log('FAIL 未设置 GH_TOKEN'); process.exit(1) }
const REPO = 'Mosina1102/MSMate'
const TAG = 'v2.7.11'
const DIR = path.join(__dirname, '..', 'release_build_v2711')
const BODY = `## MSMate v2.7.11 — SVG 乱码全面清剿

v2.7.1 修复了工作台顶栏图标乱码，但同类问题还有 7 处潜伏在"图标经变量间接赋值"的角落。本轮按数据流全局清剿：

### 本轮修复
- 引用文件胶囊（输入框上方 + 聊天消息内）显示 SVG 源码
- 会话菜单「重命名 / 置顶 / 删除会话」按钮乱码
- 文件夹批量操作栏「加入工作台 / 引用 AI / 发送」按钮乱码
- 富文本编辑器「引用块 / 清除格式」按钮乱码
- 工作台页签右键菜单、资源面板右键菜单整单乱码
- 冒烟新增 7 点断言 + 防回归正则（textContent = 图标变量），同类问题绝不再犯

**下载**：MSMate.Setup.2.7.11.exe（Windows x64）`

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
      if (r.tag_name === TAG) { await api('DELETE', `/repos/${REPO}/releases/${r.id}`); console.log('已删除旧 release', r.id) }
    }
  }
  const rel = await api('POST', `/repos/${REPO}/releases`, {
    tag_name: TAG, target_commitish: 'main', name: 'MSMate v2.7.11 — SVG 乱码全面清剿',
    body: BODY, draft: false, prerelease: false })
  if (rel.status !== 201) { console.log('FAIL 创建 release', rel.status, JSON.stringify(rel.json).slice(0, 300)); process.exit(1) }
  console.log('release 创建 OK id=', rel.json.id, 'upload_url 拿到')
  for (const f of ['MSMate.Setup.2.7.11.exe', 'MSMate.Setup.2.7.11.exe.blockmap']) {
    const up = await upload(rel.json.upload_url, f, path.join(DIR, f))
    console.log(f, up.status === 201 ? '上传 OK' : `FAIL ${up.status}`)
    if (up.status !== 201) process.exit(1)
  }
  console.log(`发布完成: ${rel.json.html_url}`)
})().catch(e => { console.log('FAIL', e.message); process.exit(1) })
