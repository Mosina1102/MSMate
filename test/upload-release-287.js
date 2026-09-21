// v2.8.7 发布上传脚本（基于 upload-release-2718.js，三资产：exe + blockmap + latest.yml）
// 用法：node test/upload-release-285.js <exe路径> <blockmap路径> <latest.yml路径>
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')

const REPO = 'Mosina1102/MSMate'
const VER = '2.8.7'
const TAG = 'v' + VER
const NAME = `MSMate ${TAG} · AI 控制电脑可靠性大修`
const NOTES = `## 修复：AI 控制电脑此前完全不可用的问题
- **desktop_* 工具全瘫修复**：点击/输入/按键/窗口管理此前一直报错（this 丢失），本版起恢复可用
- **UIA 控件名册修复**：原生程序控件读不出的问题解决，AI 精准定位桌面按钮不再靠猜

## 新增：用户占用避让（人机不打架）
- AI 接管键鼠期间你动了鼠标 → **AI 自动停手**并询问是否继续，防止 AI 的字误打进你正在编辑的文档/表格
- 控制遮罩提示升级：「Mate 正在控制电脑 · **请勿操作鼠标键盘**」+ Ctrl+Shift+X 紧急停止
- 手册新增前台占用铁律：浏览器内任务一律走后台受控页签（browser_*），不碰真实键鼠

## 其他修复
- **desktop_click 双击/右键参数丢失**修复（此前 AI 想双击实际只会单击）
- **AI 浏览感知新窗口**：受控页签里点开的新网页在受控页签内打开，AI 的页面快照不再"失明"
- **会话自动命名**：新会话首条消息后自动取名（此前因默认名比对不一致从未生效）
- **GBK 中文注释乱码**修复（工作台打开代码文件注释变方块的真凶）

## 上个版本（2.8.6）回顾
- CodeMirror 全家桶（折叠/Ctrl+F/状态条/单词补全/缩进参考线/语义染色/选区负片）；开发三主件（报错行号直达/dev_server 长驻/git 底座）；回档完善（内嵌确认卡/回滚并重跑）；AI 改文件工作台自动刷新`

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


