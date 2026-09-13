// v2.7.18 发布上传脚本（Node 版，绕开 PowerShell 编码/参数绑定坑）
// 用法：node test/upload-release-2718.js <exe路径> <blockmap路径>
// 流程：建 Release（已存在则复用）→ 删同名旧资产 → 传 exe + blockmap（失败重试 5 次）
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')

const REPO = 'Mosina1102/MSMate'
// 用法：node test/upload-release-2718.js <exe路径> <blockmap路径> <版本号如 2.7.27>
const VER = process.argv[4] || '2.7.27'
const TAG = 'v' + VER
const NAME = `MSMate ${TAG} · 改文字行为矫正 + WPS 转换防打扰`
const NOTES = `## 修复：改个文字却"重新生成论文"导致格式全乱
- AI 行为矫正：**改文字一律精准替换（edit），禁止图省事重建整篇**——重建的文档没有你的封面/页眉/分节页码/样式表，格式必乱
- 新增「改动量分级铁律」：动的是"字"就用精准替换，动的是"篇"才谈重建
- 改 10 处也逐条替换，不再偷懒重写

## WPS 转 PDF 防打扰加固
- 文档转 PDF 的 WPS 自动化强制后台隐形（Visible=false），防个别版本带出主界面/广告窗

## 上个版本（2.7.26）回顾
- 格式转换大全 convert_file：图片互转 / 多图合成 PDF / docx→pdf / html→pdf / md 转 docx、pdf / 音视频转换（FFmpeg 自动下载）
- 改图模型升级 Qwen-Image-Edit-2511（未上架自动回落 2509）`

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
