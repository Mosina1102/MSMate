// 工作台豁免 + 上网工具冒烟测试
const path = require('path')
const fs = require('fs')
const os = require('os')
const { createTools } = require('../ai/tools')

async function main() {
  let pass = 0, fail = 0
  const ok = (name, cond, extra) => { console.log((cond ? '✅ ' : '❌ ') + name + (cond ? '' : ' | ' + (extra || ''))); cond ? pass++ : fail++ }

  // 工作台放 C 盘（模拟真实 userData），验证保护区豁免
  const wsBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mswork-ws-'))
  const tools = createTools({
    tcpAgent: { getConnectedDevices: () => [] },
    snapshots: { backupLocal: () => ({ ok: false, reason: '测试' }) },
    desktopDir: 'D:\\非存在桌面路径占位',
    tmpDir: wsBase,
    workspaceDir: wsBase,
    getSetting: () => null,
    setSetting: () => {},
    log: () => {}
  })

  // 1) 工作台内写文件（C 盘保护区豁免）
  const notePath = path.join(wsBase, 'NOTES.md')
  const r1 = await tools.execute('write_file', { path: notePath, content: '# 工作台记事本\n\n测试内容' })
  ok('工作台内写入（C盘豁免）', r1.ok && fs.existsSync(notePath), r1.message)

  // 2) 工作台内读回（read_file 的内容在 message 字段）
  const r2 = await tools.execute('read_file', { path: notePath })
  ok('工作台内读取', r2.ok && /测试内容/.test(r2.message), r2.message)

  // 3) 工作台内 list_dir
  const r3 = await tools.execute('list_dir', { path: wsBase })
  ok('工作台列目录', r3.ok, r3.message)

  // 4) C 盘保护区仍拦截（非工作台）
  const r4 = await tools.execute('write_file', { path: 'C:\\Windows\\temp-test-ai.txt', content: 'x' })
  ok('C盘保护区仍拦截', !r4.ok, r4.message)

  // 5) web_search 真实联网
  const r5 = await tools.execute('web_search', { query: '电子表发明人' })
  ok('web_search 联网搜索', r5.ok && /搜索结果/.test(r5.message), String(r5.message).slice(0, 120))

  // 6) web_fetch 真实抓网页
  const r6 = await tools.execute('web_fetch', { url: 'https://example.com' })
  ok('web_fetch 抓取网页', r6.ok && /example/i.test(r6.message), String(r6.message).slice(0, 120))

  // 7) web_fetch 拒绝非 http
  const r7 = await tools.execute('web_fetch', { url: 'file:///C:/Windows/win.ini' })
  ok('web_fetch 拒绝非http', !r7.ok, r7.message)

  fs.rmSync(wsBase, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'} (${pass}/${pass + fail})`)
  process.exitCode = fail === 0 ? 0 : 1
}
main().catch((e) => { console.error('测试异常:', e); process.exitCode = 1 })
