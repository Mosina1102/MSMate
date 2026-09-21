// v2.8.6 发布上传脚本（基于 upload-release-2718.js，三资产：exe + blockmap + latest.yml）
// 用法：node test/upload-release-285.js <exe路径> <blockmap路径> <latest.yml路径>
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')

const REPO = 'Mosina1102/MSMate'
const VER = '2.8.6'
const TAG = 'v' + VER
const NAME = `MSMate ${TAG} · AI 代码开发大版本`
const NOTES = `## 工作台编辑器：CodeMirror 全家桶（对标 Trae 手感）
- 代码折叠（函数块收起/展开）+ **Ctrl+F 搜索替换** + 状态条（行:列 · 语言 · 缩进档）+ 单词自动补全
- **缩进参考线**：按层级画竖线，层级结构一眼看清
- **语义染色**：类名/注解/函数定义独立配色，关键字加粗——颜色层次对齐专业 IDE
- **选区负片模式**：选中文字实心紫底深色字，清清楚楚
- 修复 GBK 中文注释乱码（"看不见注释"的真凶）；md 左编辑右预览、html 双模式同步升级

## AI 代码开发三主件
- **报错行号直达**：AI 跑命令报错 → 输出里的 文件:行号 可点击，直达工作台对应行（行号红标）——不用自己翻日志找
- **dev_server 长驻进程**：npm run dev 这类跑起来不退出的命令不再被超时掐断，日志尾部随时看
- **git 版本底座**：AI 改完代码可查看改动/提交（自动 add），项目版本留底
- AI 改动的文件，工作台打开着的页签**自动刷新**，永远看最新内容

## 回档（回退）完善
- 点击「回到此处」弹出**内嵌确认卡**：列出将撤销的每个文件（将被修改/将被删除/将移回），看清再动手
- 新增「**回滚并重跑**」：文件还原+对话撤回+自动重新执行，Trae 同款
- 回滚后工作台同步刷新，任务清单板一并重置——真实回退不打折

## 上个版本（2.8.5）回顾
- CodeMirror 编辑器（行号+语法高亮+括号补全，固定深色）；批量复制预检崩溃修复；UIA 控件树+控制遮罩+急停；AI 浏览器导航栏；edit_file 红绿 diff`

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

