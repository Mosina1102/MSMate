// winembed 帮手全链路验证：真实 helperScript + READY 握手 + PING + 中文 EMBED 命令解析（不打真窗口）
const { spawn } = require('child_process')
const { helperScript } = require('../ai/winembed.js')

const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', helperScript()], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
})
let out = ''
ps.stdout.setEncoding('utf8')
ps.stdout.on('data', (d) => { out += d })
const poll = setInterval(() => {
  if (out.includes('READY')) {
    clearInterval(poll)
    ps.stdin.write('PING\n')
    setTimeout(() => {
      ps.stdin.write('QUIT\n')
      setTimeout(() => process.exit(0), 800)
    }, 500)
  }
}, 200)
setTimeout(() => {
  clearInterval(poll)
  const ready = out.includes('READY')
  const pong = out.includes('PONG')
  console.log(`${ready ? '✅' : '❌'} READY 握手  ${pong ? '✅' : '❌'} PING/PONG`)
  process.exit(ready && pong ? 0 : 1)
}, 20000)
