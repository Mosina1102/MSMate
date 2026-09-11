// v2.7.18 发布上传脚本（Node 版，绕开 PowerShell 编码/参数绑定坑）
// 用法：node test/upload-release-2718.js <exe路径> <blockmap路径>
// 流程：建 Release（已存在则复用）→ 删同名旧资产 → 传 exe + blockmap（失败重试 5 次）
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')

const REPO = 'Mosina1102/MSMate'
const TAG = 'v2.7.18'
const NAME = 'MSMate v2.7.18 · AI 设计板块（海报/封面排版出图）'
const NOTES = `## 新增：AI 设计板块
- **render_html 工具**：AI 写 HTML 排版 → 高保真渲染 PNG。五种画布预设：A4 海报/简历/邀请函、小红书 3:4、微信方图 1:1、横幅 21:9、公众号封面，支持 2-4 倍高清出图
- **设计手册**：Editorial 编辑风 / Swiss 网格风双设计系统、版式骨架速查、出图自检清单（文字溢出/对比度/空洞/对齐）
- 文字全部为真实排版渲染，**中文零乱码**；改字改色改 HTML 重渲即可

## 修复
- 高画布（A4 竖版 1754px）离屏渲染被屏幕工作区裁切的问题

> 示例见仓库 test/fixtures/design-demo.png（重庆火锅节海报，三版收敛全过程）`

const exePath = process.argv[2]
const blockPath = process.argv[3]
if (!exePath || !fs.existsSync(exePath)) { console.error('缺少 exe：', exePath); process.exit(1) }

// token 从 remote URL 取（不回显）
let remote
try { remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim() } catch {}
if (!remote || !remote.startsWith('http')) remote = execSync('"C:\\Program Files\\Git\\cmd\\git.exe" remote get-url origin', { encoding: 'utf8' }).trim()
const m = remote.match(/^https:\/\/[^:]+:([^@]+)@/)
if (!m) { console.error('remote URL 无内嵌 token'); process.exit(1) }
const TOKEN = m[1]

function req(method, host, path, data, headers = {}, attempt = 1) {
  return new Promise((resolve, reject) => {
    const body = data != null ? (Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data), 'utf8')) : null
    const r = https.request({ host, path, method, headers: {
      'User-Agent': 'msm-release', Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Length': body.length } : {}), ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(text) } catch { return null } })(), text })
        else reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`))
      })
    })
    r.on('error', reject)
    r.setTimeout(600000, () => r.destroy(new Error('请求超时')))
    if (body) r.write(body)
    r.end()
  }).catch(async (e) => {
    if (attempt < 5) {
      console.log(`  重试 ${attempt + 1}/5（${String(e.message).slice(0, 80)}）`)
      await new Promise((res) => setTimeout(res, 6000))
      return req(method, host, path, data, headers, attempt + 1)
    }
    throw e
  })
}

async function main() {
  // ① 建 Release（422=已存在则取现有）
  let rel
  try {
    const res = await req('POST', 'api.github.com', `/repos/${REPO}/releases`,
      { tag_name: TAG, target_commitish: 'master', name: NAME, body: NOTES, draft: false, prerelease: false })
    rel = res.json
    console.log(`Release 已创建 id=${rel.id}`)
  } catch (e) {
    if (String(e.message).includes('422')) {
      const res = await req('GET', 'api.github.com', `/repos/${REPO}/releases/tags/${TAG}`)
      rel = res.json
      console.log(`Release 已存在，复用 id=${rel.id}`)
      // 同步标题与说明（PATCH）
      await req('PATCH', 'api.github.com', `/repos/${REPO}/releases/${rel.id}`, { name: NAME, body: NOTES })
      console.log('标题与说明已更新')
    } else throw e
  }

  // ② 删同名旧资产 → ③ 上传
  for (const f of [exePath, blockPath].filter(Boolean)) {
    const fname = require('path').basename(f)
    const old = (rel.assets || []).find((a) => a.name === fname)
    if (old) { await req('DELETE', 'api.github.com', `/repos/${REPO}/releases/assets/${old.id}`); console.log(`已删旧资产 ${fname}`) }
    console.log(`上传 ${fname}（${Math.round(fs.statSync(f).size / 1048576)}MB）...`)
    const res = await req('POST', 'uploads.github.com', `/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(fname)}`,
      fs.readFileSync(f), { 'Content-Type': 'application/octet-stream' })
    console.log(`完成 → ${res.json.browser_download_url}`)
  }
  console.log('\nRELEASE_UPLOAD_OK')
}

main().catch((e) => { console.error('RELEASE_UPLOAD_FAIL:', e.message); process.exit(1) })
