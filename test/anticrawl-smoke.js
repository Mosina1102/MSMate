// 反反爬冒烟测试：请求头伪装 + 反爬识别 + 换身份重试 + 渲染兜底降级 + 防盗链自动 Referer
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { createTools } = require('../ai/tools')
const { browserHeaders, looksLikeAntiCrawl, renderPage } = require('../ai/anticrawl')

function startServer(routes) {
  const hits = {}
  const srv = http.createServer((req, res) => {
    const key = req.url.split('?')[0]
    hits[key] = (hits[key] || 0) + 1
    for (const r of routes) {
      const m = r.match(key, req)
      if (m) return r.reply(res, m, req)
    }
    res.writeHead(404)
    res.end('not found')
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, hits })))
}

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // ===== 1. 单元：请求头伪装 =====
  const h0 = browserHeaders(0), h1 = browserHeaders(1), h5 = browserHeaders(5)
  ok('请求头含 UA/Accept/Accept-Language', h0['User-Agent'] && h0['Accept'] && h0['Accept-Language'])
  ok('不同序号身份不同（轮换）', h0['User-Agent'] !== h1['User-Agent'])
  ok('序号循环取（5 == 2 组）', h5['User-Agent'] === browserHeaders(2)['User-Agent'])

  // ===== 2. 单元：反爬识别 =====
  ok('403 判定为反爬', looksLikeAntiCrawl(403, '') === true)
  ok('429/503 判定为反爬', looksLikeAntiCrawl(429, '') && looksLikeAntiCrawl(503, ''))
  ok('Cloudflare 挑战页判定为反爬', looksLikeAntiCrawl(200, '<html><title>Just a moment...</title><body>Checking your browser</body></html>'))
  ok('JS 必需的空壳页判定为反爬', looksLikeAntiCrawl(200, '<html><body><noscript>请开启 JavaScript</noscript><div id="app"></div></body></html>'))
  ok('404 不算反爬', looksLikeAntiCrawl(404, 'not found') === false)
  ok('空内容不算反爬', looksLikeAntiCrawl(200, '') === false)
  const legitBig = '<html><head><noscript>请开启 JavaScript 以获得最佳体验</noscript></head><body>' + '<p>这是一篇很长的正常文章。</p>'.repeat(200) + '</body></html>'
  ok('带 noscript 提示的正常页面不误判', looksLikeAntiCrawl(200, legitBig) === false)
  const captchaArticle = '<html><body>' + '<p>聊聊验证码的历史：从验证码到人机身份验证的演变。</p>'.repeat(300) + '</body></html>'
  ok('讨论验证码的正常长文不误判', looksLikeAntiCrawl(200, captchaArticle) === false)

  // ===== 3. 渲染兜底：纯 Node 环境优雅降级 =====
  let renderErr = null
  try { await renderPage('http://127.0.0.1:1/') } catch (e) { renderErr = e }
  ok('非 Electron 环境 RENDER_UNAVAILABLE', renderErr && renderErr.message === 'RENDER_UNAVAILABLE', renderErr && renderErr.message)

  // ===== 4. 集成：web_fetch / download_file =====
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-ac-'))
  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试不备份' }) },
    desktopDir: 'D:\\非存在桌面路径占位',
    tmpDir: base,
    workspaceDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })

  const { srv, hits } = await startServer([
    // 前两次 403，第三次放行 → web_fetch 应靠换身份重试拿到内容
    {
      match: (k) => k === '/flaky', reply: (res, m, req) => {
        if (hits['/flaky'] <= 2) { res.writeHead(403); res.end('blocked') }
        else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<html><body><p>重试成功正文</p></body></html>') }
      }
    },
    // 永远返回 Cloudflare 挑战页 → 重试耗尽 + 渲染兜底不可用 → 友好报错
    {
      match: (k) => k === '/cf', reply: (res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><title>Just a moment...</title><body>Checking your browser before accessing</body></html>')
      }
    },
    // 防盗链图：仅当 Referer == 本站 origin 时给图
    {
      match: (k) => k === '/img.png', reply: (res, m, req) => {
        if (req.headers.referer === 'http://wall.test/page') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('PNGDATA') }
        else { res.writeHead(403); res.end('hotlink denied') }
      }
    },
    // 同源防盗链图：Referer == 自身 origin 即可（download_file 自动补 origin 兜底）
    {
      match: (k) => k === '/sameorigin.png', reply: (res, m, req) => {
        if (/^http:\/\/127\.0\.0\.1:\d+\/$/.test(req.headers.referer || '')) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('OKPNG') }
        else { res.writeHead(403); res.end('need same-origin referer') }
      }
    }
  ])
  const port = srv.address().port // startServer 内部已 listen 完成后再 resolve，port 直接可用
  const origin = `http://127.0.0.1:${port}`

  // 4.1 换身份重试成功
  const r1 = await tools.execute('web_fetch', { url: `${origin}/flaky` })
  ok('web_fetch 403 后换身份重试成功', r1.ok && r1.message.includes('重试成功正文'), r1.message.slice(0, 120))
  ok('重试确实发了多次请求', hits['/flaky'] >= 2, `hits=${hits['/flaky']}`)

  // 4.2 全被拦 + 渲染兜底不可用 → 友好报错带建议
  const r2 = await tools.execute('web_fetch', { url: `${origin}/cf` })
  ok('挑战页耗尽重试 → 反爬友好报错', !r2.ok && /反爬/.test(r2.message) && /换/.test(r2.message), r2.message)
  ok('报错提到尝试过的手段', /重试/.test(r2.message) && /渲染/.test(r2.message), r2.message)

  // 4.3 404 不走重试直接报错
  const r3 = await tools.execute('web_fetch', { url: `${origin}/no-such-page` })
  ok('404 直接报错不走反爬流程', !r3.ok && /HTTP 404/.test(r3.message), r3.message)

  // 4.4 防盗链：AI 没传 referer，第一次 403 后自动补 origin；本站校验严格 referer → 最终报错带指引
  const r4 = await tools.execute('download_file', { url: `${origin}/img.png`, save_path: path.join(base, 'a.png') })
  ok('严格防盗链全失败 → 报错含 403+referer 指引', !r4.ok && /403/.test(r4.message) && /referer/i.test(r4.message) && /自动/.test(r4.message), r4.message)
  const r5 = await tools.execute('download_file', { url: `${origin}/img.png`, save_path: path.join(base, 'b.png'), referer: 'http://wall.test/page' })
  ok('传 referer 首次即成功', r5.ok && fs.readFileSync(path.join(base, 'b.png')).toString() === 'PNGDATA', r5.message)

  // 4.5 同源防盗链：不传 referer，靠自动补 origin 重试成功
  const r6 = await tools.execute('download_file', { url: `${origin}/sameorigin.png`, save_path: path.join(base, 'c.png') })
  ok('同源防盗链自动补 Referer 成功', r6.ok && fs.readFileSync(path.join(base, 'c.png')).toString() === 'OKPNG', r6.message)

  srv.close()
  fs.rmSync(base, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'} (${pass}/${pass + fail})`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
