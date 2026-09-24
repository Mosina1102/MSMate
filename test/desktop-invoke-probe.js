// desktop_invoke / windowShot 真实调用链探针（纯 Node，无需 Electron GUI）
// 流程：起记事本 → uiaTree 拿名册 → uiaInvoke 后台触发控件 → winshot 窗口截图 → 输出结果
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DesktopControl } = require('../ai/desktop-control')

function fail(msg) { console.error('PROBE_FAIL: ' + msg); process.exit(1) }

async function main() {
  // ① 起记事本（打开带标记的临时文件，靠标题找真实 pid——Win11 新版记事本 spawn pid 是桥接进程）
  const tmp = path.join(__dirname, 'probe-note.txt')
  fs.writeFileSync(tmp, 'MSMate invoke probe')
  const np = spawn('notepad.exe', [tmp], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2200))

  const dc = new DesktopControl(console.log)
  let pid = 0
  try {
    await dc.ensure()
    console.log('[1] 引擎就绪（msdesk-v7 引导通过）')
    const wl = await dc.windowList()
    if (!wl.ok) fail('winList 失败: ' + wl.error)
    const hit = wl.windows.find((w) => w.title.includes('probe-note'))
    if (!hit) fail('winList 未找到记事本窗口: ' + JSON.stringify(wl.windows.slice(0, 5)))
    pid = hit.pid
    console.log(`[2] 记事本窗口 pid=${pid} [${hit.proc}] ${hit.title}`)

    // ③ uiaTree 名册
    const tree = await dc.uiaTree(pid)
    if (!tree.ok) fail('uiaTree 失败: ' + tree.error)
    const inv = tree.elements.find((e) => (e.patterns || '').includes('Invoke'))
    const val = tree.elements.find((e) => (e.patterns || '').includes('Value'))
    console.log(`[3] 名册 ${tree.elements.length} 条，可Invoke: ${inv ? '#' + inv.n + ' ' + inv.name : '无'}，可Value: ${val ? '#' + val.n + ' ' + val.name : '无'}`)

    // ④ uiaInvoke 后台触发（优先 Invoke 控件；没有就用 Value 填空）
    if (inv) {
      const r = await dc.uiaInvoke({ pid, n: inv.n, action: 'invoke' })
      if (!r.ok) fail('uiaInvoke invoke 失败: ' + r.error)
      console.log(`[4] 后台 invoke 成功 →「${r.name}」[${r.type}]`)
    } else if (val) {
      const r = await dc.uiaInvoke({ pid, n: val.n, action: 'setValue', value: 'MSMate 探针' })
      if (!r.ok) fail('uiaInvoke setValue 失败: ' + r.error)
      console.log(`[4] 后台 setValue 成功 →「${r.name}」值「${r.value}」`)
    } else {
      console.log('[4] 名册无 Invoke/Value 控件（跳过操作验证，引擎语法已验证）')
    }

    // ⑤ 不支持 pattern 的控件应得到友好错误
    const bad = await dc.uiaInvoke({ pid, n: 1, action: 'toggle' })
    console.log(`[5] 错误路径验证: ${bad.ok ? '意外成功(控件恰好支持 toggle?)' : '友好报错: ' + bad.error.slice(0, 60)}`)

    // ⑥ winshot 窗口截图
    const out = path.join(__dirname, 'probe-winshot.png')
    const shot = await dc.windowShot(pid, out)
    if (!shot.ok) fail('windowShot 失败: ' + shot.error)
    if (shot.black) {
      console.log(`[6] 窗口截图: DirectComposition 渲染（black），降级路径可用 rect=(${shot.x},${shot.y} ${shot.w}×${shot.h})`)
    } else {
      const sz = fs.statSync(out).size
      if (sz < 1000) fail('截图文件异常小: ' + sz)
      console.log(`[6] 窗口截图成功: ${out}（${Math.round(sz / 1024)}KB）`)
    }

    console.log('\nPROBE_OK')
  } finally {
    try { dc.kill() } catch {}
    try { execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' }) } catch {}
    try { execSync(`taskkill /IM notepad.exe /F`, { stdio: 'ignore' }) } catch {}
    try { fs.unlinkSync(tmp) } catch {}
    try { fs.unlinkSync(path.join(__dirname, 'probe-winshot.png')) } catch {}
  }
}

main().catch((e) => fail(e.stack || e.message))
