// v2.8.5 发布上传脚本（基于 upload-release-2718.js，三资产：exe + blockmap + latest.yml）
// 用法：node test/upload-release-285.js <exe路径> <blockmap路径> <latest.yml路径>
const { execSync } = require('child_process')
const fs = require('fs')
const https = require('https')

const REPO = 'Mosina1102/MSMate'
const VER = '2.8.5'
const TAG = 'v' + VER
const NAME = `MSMate ${TAG} · 代码编辑器大升级 + 控制电脑精准化`
const NOTES = `## 工作台：代码编辑器大升级（对标 Trae 手感）
- **CodeMirror 内核**替换纯文本框：行号 + 语法高亮（Java/JS/TS/Python/CSS/HTML/MD/SQL/Shell 等 10 系）+ 括号自动补全/匹配高亮 + 当前行高亮 + 智能缩进
- **固定深色配色**（Mocha 色板）：黑码/白纸分区——文档预览永远是白纸，代码永远是深色 IDE
- 保存链路不变：1.5s 防抖自动保存 + Ctrl+S；划词"添加到对话"保留；md 左编辑右预览、html 编辑源码同步升级

## 修复：AI 批量复制文件时崩溃
- 修复"复制主页为多个新页面"这类批量任务直接报错（The "path" argument must be of type string）且任务卡死的问题
- 预检异常不再中断整轮任务，自动降级为人工确认

## AI 控制电脑：更准更安全
- 新增 **UIA 控件树**（desktop_uia）：原生程序按钮/输入框按名册精准定位，不再靠视觉猜坐标
- 控制时全屏半透明遮罩提示「Mate 正在控制电脑」，鼠标穿透随时可抢回，**Ctrl+Shift+X 紧急停止**
- 截图按屏幕真实分辨率取图 + 支持归一化坐标，点击命中率大幅提升
- 归一化坐标（0-1000）协议，视觉模型定位更稳

## AI 浏览器 & 开发体验
- 内置浏览器导航栏：后退 / 前进 / 刷新 / 地址栏（webview 引擎，本地文件也支持历史导航）
- edit_file 修改卡片改红绿 diff 展示；run_command 卡片终端风格（退出码染色）
- 命令工作目录默认工作区，AI 不再瞎猜路径
- 任务完成播放提示音；Bug 三次修不动必须主动问人

## 上个版本（2.8.4）回顾
- tool_call 标签第四层解析（Qwen/GLM 系不再漏正文）；聊天框 Ctrl+V 粘贴图片；工作台 html 渲染预览⇄编辑源码双模式`

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
