// download_file 下载工具冒烟测试（真实联网）
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-dl-'))
  const events = []
  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试不备份' }) },
    desktopDir: 'D:\\非存在桌面路径占位',
    tmpDir: base,
    workspaceDir: base,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {},
    onDownloadProgress: (info) => events.push(info)
  })

  // 1) 下载到指定目录（自动命名）— example.com 根路径没有文件名 → download.bin 兜底
  const dir = path.join(base, 'down')
  fs.mkdirSync(dir, { recursive: true })
  const r1 = await tools.execute('download_file', { url: 'https://example.com', save_path: dir })
  ok('下载到目录(自动命名)', r1.ok && fs.readdirSync(dir).length === 1, r1.message)

  // 2) 下载到完整文件路径（目录形式 + 头部命名不适用）
  const file2 = path.join(base, 'page.html')
  const r2 = await tools.execute('download_file', { url: 'https://example.com', save_path: file2 })
  ok('下载到完整路径', r2.ok && fs.existsSync(file2) && fs.statSync(file2).size > 500, r2.message)

  // 3) 目标已存在 → 走备份分支（测试快照桩返回失败则取消）
  const r3 = await tools.execute('download_file', { url: 'https://example.com', save_path: file2 })
  ok('已存在且备份失败时取消', !r3.ok && /备份/.test(r3.message), r3.message)

  // 4) 非 http 协议拒绝
  const r4 = await tools.execute('download_file', { url: 'file:///C:/Windows/win.ini', save_path: base })
  ok('拒绝非 http 协议', !r4.ok, r4.message)

  // 5) 404 报错清晰
  const r5 = await tools.execute('download_file', { url: 'https://example.com/nonexistent-file-404', save_path: base })
  ok('404 明确报错', !r5.ok && /404/.test(r5.message), r5.message)

  // 6) 远程 target 拒绝（download 仅本机）
  const r6 = await tools.execute('download_file', { url: 'https://example.com', save_path: base, target: '不存在设备' })
  ok('未知设备拒绝', !r6.ok && /设备不存在/.test(r6.message), r6.message)

  // 7) classify：exe 需审批
  const cls = await tools.classify('download_file', { url: 'https://example.com/setup.exe', save_path: path.join(base, 'setup.exe') })
  ok('exe 下载标记为需审批', cls.destructive && /可执行/.test(cls.note), cls.note)

  // 8) classify：普通文件 + 目标不存在 → 不需审批
  const cls2 = await tools.classify('download_file', { url: 'https://example.com/a.pdf', save_path: path.join(base, 'a.pdf') })
  ok('普通下载不需审批', !cls2.destructive, cls2.note)

  // 9) referer 防盗链：本地服务器校验 Referer 头（无 → 403，有 → 200）
  const http = require('http')
  const srv = http.createServer((req, res) => {
    if (req.headers.referer === 'https://wall.example.com/page') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      res.end('JPEGDATA')
    } else {
      res.writeHead(403)
      res.end('denied')
    }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const dir2 = path.join(base, 'wall')
  fs.mkdirSync(dir2, { recursive: true })
  const r10 = await tools.execute('download_file', { url: `http://127.0.0.1:${port}/img.jpg`, save_path: dir2 })
  ok('无 referer 403 报错带指引', !r10.ok && /403/.test(r10.message) && /referer/i.test(r10.message), r10.message)
  const r11 = await tools.execute('download_file', { url: `http://127.0.0.1:${port}/img.jpg`, save_path: dir2, referer: 'https://wall.example.com/page' })
  ok('带 referer 下载成功', r11.ok && fs.readFileSync(path.join(dir2, 'img.jpg')).toString() === 'JPEGDATA', r11.message)
  srv.close()

  // 10) 反引号/引号包裹的 URL 自动清洗（模型常见输出毛病）
  const r12 = await tools.execute('download_file', { url: '`https://example.com`', save_path: path.join(base, 'clean.html') })
  ok('反引号 URL 自动清洗', r12.ok && fs.existsSync(path.join(base, 'clean.html')) && fs.statSync(path.join(base, 'clean.html')).size > 500, r12.message)

  // 11) web_fetch mode=links 提取页面图片/文件直链
  const srv2 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body><img src="/wallpapers/one.jpg"><img data-src="https://cdn.example.com/two.webp"><img src="/favicon.ico"><a href="/files/big.zip">下载</a><p>正文文字</p></body></html>')
  })
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r))
  const port2 = srv2.address().port
  const r13 = await tools.execute('web_fetch', { url: `http://127.0.0.1:${port2}/`, mode: 'links' })
  ok('links 模式提取直链', r13.ok
    && r13.message.includes(`http://127.0.0.1:${port2}/wallpapers/one.jpg`)
    && r13.message.includes('cdn.example.com/two.webp')
    && r13.message.includes(`/files/big.zip`)
    && !r13.message.includes('favicon'),
    r13.message)
  const r14 = await tools.execute('web_fetch', { url: `http://127.0.0.1:${port2}/` })
  ok('默认仍是正文模式', r14.ok && r14.message.includes('正文文字') && !r13.message.includes('正文文字'), r14.message)
  srv2.close()

  // 12) 进度事件流：前面的下载应已产生 start/progress/end(ok)
  ok('进度事件流 start/progress/end', events.some((e) => e.type === 'start') && events.some((e) => e.type === 'progress') && events.some((e) => e.type === 'end' && e.ok), `events=${events.length}`)

  // 13) 慢速大文件：进度回调 + 用户取消 → 半截文件清理
  const srv3 = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(2 * 1024 * 1024) })
    const chunk = Buffer.alloc(16 * 1024, 7)
    const timer = setInterval(() => { res.write(chunk) }, 20)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise((r) => srv3.listen(0, '127.0.0.1', r))
  const cancelPath = path.join(base, 'big.bin')
  const pCancel = tools.execute('download_file', { url: `http://127.0.0.1:${srv3.address().port}/big.bin`, save_path: cancelPath })
  await new Promise((r) => setTimeout(r, 500))
  const startEv = events.find((e) => e.type === 'start' && e.fileName === 'big.bin')
  const cancelRes = tools.cancelDownload(startEv ? startEv.id : 'none')
  const rCancel = await pCancel
  await new Promise((r) => setTimeout(r, 300)) // 等写句柄 close 后 unlink 完成
  ok('用户取消下载', cancelRes.ok && !rCancel.ok && /取消/.test(rCancel.message), rCancel.message)
  ok('半截文件已清理', !fs.existsSync(cancelPath))
  ok('取消事件已推送', events.some((e) => e.type === 'end' && e.cancelled && e.fileName === 'big.bin'))
  srv3.close()

  console.log(`\n${pass}/${pass + fail} 通过`)
  fs.rmSync(base, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
