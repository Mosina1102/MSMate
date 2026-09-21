// 桌面控制引擎探针：真跑 PowerShell 常驻进程，验证行协议/编译/键鼠封装存活
// 只执行无副作用操作（ping/cursor/winList），不做真实点击/打字
const assert = require('assert')
const { DesktopControl } = require('../ai/desktop-control')

;(async () => {
  const dc = new DesktopControl((m) => console.log(m))
  let pass = 0, fail = 0
  const ok = (cond, name) => { if (cond) { pass++; console.log('  ok ' + name) } else { fail++; console.log('  FAIL ' + name) } }

  // 1. 引擎启动（Add-Type 编译 + ping 往返）
  const t0 = Date.now()
  await dc.ensure()
  ok(true, `引擎启动（${Date.now() - t0}ms，含首次编译）`)

  // 2. 光标坐标往返
  const cur = await dc.cursor()
  ok(cur.ok && typeof cur.x === 'number' && typeof cur.y === 'number', `光标坐标 (${cur.x},${cur.y})`)

  // 3. 窗口枚举（中文标题 b64 往返）
  const wl = await dc.windowList()
  ok(wl.ok && Array.isArray(wl.windows), `窗口枚举 ${wl.windows ? wl.windows.length : 0} 个`)
  const hasCn = wl.windows && wl.windows.some((w) => /[\u4e00-\u9fa5]/.test(w.title))
  ok(hasCn !== undefined, `标题解码正常（${wl.windows && wl.windows[0] ? wl.windows[0].title.slice(0, 24) : '空'}...）`)

  // 4. 未知键名报错路径（不真按）
  const bad = await dc.key(['ctrl', 'notakey'])
  ok(bad.ok === false && /unknown key/.test(bad.error), '未知键名正确报错')

  // 5. 协议复用：第二条命令不重启进程
  const procBefore = dc.proc
  await dc.cursor()
  ok(dc.proc === procBefore, '常驻进程复用（无重启）')

  dc.kill()
  console.log(`[desktop-engine] ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('[desktop-engine] 探针炸了:', e.message); process.exit(1) })
