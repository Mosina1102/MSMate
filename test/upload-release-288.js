// v2.8.8 发布上传脚本（基于 upload-release-2718.js，三资产：exe + blockmap + latest.yml）
// 用法：node test/upload-release-285.js <exe路径> <blockmap路径> <latest.yml路径>
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')

const REPO = 'Mosina1102/MSMate'
const VER = '2.8.8'
const TAG = 'v' + VER
const NAME = `MSMate ${TAG} · AI 控制电脑技能补齐`
const NOTES = `## 新增：键鼠技能补齐（用户会的它都会）
- **鼠标拖拽（desktop_drag）**：按住左键从起点平滑拖到终点——拖文件到文件夹、拖滑块调音量、选中一段文字、框选元素、移动窗口位置，全部支持；起终点可传归一化坐标（视觉模型输出最准）
- **悬停（desktop_move）**：鼠标移动到位置但不点击——悬停显示 tooltip、展开悬停菜单后再截图操作
- **横向滚轮**：desktop_scroll 加 horizontal 参数，宽表格/时间轴横向滚动
- **修饰键按住点击**：desktop_click 加 hold_keys（如 ["ctrl"] 点击 = 多选文件，["shift"] 点击 = 范围选择）
- 键鼠引擎升级（msdesk-v5）：拖拽为分步平滑移动（很多程序只认连续移动不认瞬移）

## 上个版本（2.8.7）回顾
- AI 控制电脑可靠性大修：desktop_* 全瘫修复 + UIA 控件名册修复 + 用户占用避让（你动鼠标 AI 自动停手）+ 遮罩提示升级 + 会话自动命名 + GBK 注释乱码修复`

const exePath = process.argv[2]
const blockPath = process.argv[3]
const ymlPath = process.argv[4] || 'release_build_v2715/latest.yml'
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

  // ② 删同名旧资产 → ③ 上传（exe + blockmap + latest.yml 三件）
  for (const f of [exePath, blockPath, ymlPath].filter(Boolean)) {
    if (!fs.existsSync(f)) { console.log(`跳过不存在：${f}`); continue }
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



