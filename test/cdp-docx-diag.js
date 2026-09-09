// CDP 诊断 v2：绕过 mountWbDocxRich，手动逐步执行等价链，抓真实失败点
const PORT = 9222
const DOCX = 'C:\\Users\\ars\\Desktop\\MSMate诊断-高保真验证.docx'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const expr = `(async () => {
  const out = {}
  out.apiKind = {
    docxBuffer: String(window.api.docxBuffer).slice(0, 80),
    renderDocxPreview: String(window.api.renderDocxPreview).slice(0, 80)
  }
  // ① docxBuffer
  try {
    const buf = await window.api.docxBuffer(${JSON.stringify(DOCX)})
    out.docxBuffer = buf && typeof buf === 'object'
      ? { keys: Object.keys(buf), base64Len: buf.base64 ? buf.base64.length : null, error: buf.error || null }
      : { raw: String(buf).slice(0, 100) }
    // ② renderDocxPreview（容器先挂载，复刻修复后的顺序）
    if (buf && buf.base64) {
      const host = document.createElement('div')
      host.id = 'cdp-probe-host'
      document.body.appendChild(host)
      try {
        const rr = await window.api.renderDocxPreview(buf.base64, 'cdp-probe-host')
        out.renderDocxPreview = rr
        out.sections = document.querySelectorAll('#cdp-probe-host section.docx').length
      } catch (e) {
        out.renderDocxPreview = { threw: e.message }
      }
    }
  } catch (e) {
    out.docxBuffer = { threw: e.message }
  }
  // ③ renderOffice（mammoth 兜底链）
  try {
    const r0 = await window.api.renderOffice(${JSON.stringify(DOCX)})
    out.renderOffice = r0 && typeof r0 === 'object'
      ? { keys: Object.keys(r0).slice(0, 6), htmlLen: r0.html ? r0.html.length : null, error: r0.error || null }
      : { raw: String(r0).slice(0, 100) }
  } catch (e) {
    out.renderOffice = { threw: e.message }
  }
  return out
})()`

async function main() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`)
  const targets = await res.json()
  const page = targets.filter((t) => t.type === 'page' && t.url.includes('index.html'))[0]
  if (!page) { console.log('FATAL no page target'); process.exit(1) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id
    pending.set(mid, resolve)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id) }
  }
  await new Promise((r) => { ws.onopen = r })
  await send('Runtime.enable', {})
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  console.log('RESULT ' + JSON.stringify(r.result && 'value' in r.result ? r.result.value : r, null, 2))
  ws.close()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL ' + (e.stack || e.message)); process.exit(1) })
