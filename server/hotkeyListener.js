// 全局热键监听（支持按住/松开检测）
// Electron 的 globalShortcut 只能检测按下、无法检测松开，且原生键盘钩子模块有 Win7 兼容风险。
// 这里用 PowerShell 轮询 GetAsyncKeyState（Win7 自带，零依赖），对每个配置的组合键上报 DOWN/UP。
const { spawn } = require('child_process')
const { EventEmitter } = require('events')

// VK 码表
const VK_TOKENS = {
  'CTRL': 0x11, 'CONTROL': 0x11,
  'ALT': 0x12, 'MENU': 0x12,
  'SHIFT': 0x10,
  // 区分左右修饰键（单键热键用）
  'LCTRL': 0xA2, 'RCTRL': 0xA3,
  'LALT': 0xA4, 'RALT': 0xA5,
  'LSHIFT': 0xA0, 'RSHIFT': 0xA1,
  'SUPER': 0x5B, 'WIN': 0x5B, 'META': 0x5B, 'CMD': 0x5B,
  'LSUPER': 0x5B, 'RSUPER': 0x5C,
  'SPACE': 0x20, 'ENTER': 0x0D, 'TAB': 0x09,
  'BACKSPACE': 0x08, 'DELETE': 0x2E, 'INSERT': 0x2D,
  'HOME': 0x24, 'END': 0x23, 'PAGEUP': 0x21, 'PAGEDOWN': 0x22,
  'UP': 0x26, 'DOWN': 0x28, 'LEFT': 0x25, 'RIGHT': 0x27,
  'ESC': 0x1B, 'ESCAPE': 0x1B,
  // 鼠标侧键（GetAsyncKeyState 同样支持鼠标 VK）
  'MOUSE4': 0x05, 'XBUTTON1': 0x05, 'MOUSE5': 0x06, 'XBUTTON2': 0x06,
  'CAPSLOCK': 0x14, 'SCROLLLOCK': 0x91, 'NUMLOCK': 0x90,
  'PRINTSCREEN': 0x2C, 'PAUSE': 0x13,
  'NUMADD': 0x6B, 'NUMSUB': 0x6D, 'NUMMULT': 0x6A, 'NUMDIV': 0x6F, 'NUMDEC': 0x6E,
  'NUM0': 0x60, 'NUM1': 0x61, 'NUM2': 0x62, 'NUM3': 0x63, 'NUM4': 0x64,
  'NUM5': 0x65, 'NUM6': 0x66, 'NUM7': 0x67, 'NUM8': 0x68, 'NUM9': 0x69,
  // 符号键（OEM）
  '`': 0xC0, '-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, '\\': 0xDC,
  ';': 0xBA, "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF
}

function tokenToVK(token) {
  const t = token.toUpperCase()
  if (VK_TOKENS[t] !== undefined) return VK_TOKENS[t]
  if (/^[A-Z]$/.test(t)) return 0x41 + t.charCodeAt(0) - 65
  if (/^[0-9]$/.test(t)) return 0x30 + parseInt(t, 10)
  const fkey = t.match(/^F([1-9]|1[0-9]|2[0-4])$/)
  if (fkey) return 0x70 + parseInt(fkey[1], 10) - 1
  return null
}

// 解析 "Ctrl+Alt+V" → VK 数组；无法解析返回 null
function parseAccelerator(accel) {
  if (!accel || typeof accel !== 'string') return null
  const parts = accel.split('+').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const vks = []
  for (const p of parts) {
    const vk = tokenToVK(p)
    if (vk === null) return null
    vks.push(vk)
  }
  return vks
}

class HotkeyListener extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.accel = null
  }

  start(accel) {
    this.stop()
    const vks = parseAccelerator(accel)
    if (!vks || vks.length === 0) {
      this.emit('error', new Error(`无法解析快捷键: ${accel}`))
      return false
    }
    this.accel = accel

    const keysArr = vks.join(',')
    // PowerShell 轮询 GetAsyncKeyState：全部按下→DOWN，任一松开→UP
    const script = [
      `Add-Type -Namespace HK -Name P -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);'`,
      `$keys = @(${keysArr})`,
      `$down = $false`,
      `while($true) {`,
      `  Start-Sleep -Milliseconds 25`,
      `  $pressed = $true`,
      `  foreach($k in $keys) { $st = [HK.P]::GetAsyncKeyState($k); if(($st -band 0x8000) -eq 0) { $pressed = $false; break } }`,
      `  if($pressed -and -not $down) { $down = $true; [Console]::Out.WriteLine('DOWN'); [Console]::Out.Flush() }`,
      `  elseif((-not $pressed) -and $down) { $down = $false; [Console]::Out.WriteLine('UP'); [Console]::Out.Flush() }`,
      `}`
    ].join('\r\n')

    try {
      this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      this.emit('error', err)
      return false
    }

    let buf = ''
    this.child.stdout.on('data', (data) => {
      buf += data.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line === 'DOWN') this.emit('down')
        else if (line === 'UP') this.emit('up')
      }
    })
    this.child.stderr.on('data', () => {})
    this.child.on('exit', () => { this.child = null })
    this.child.on('error', (err) => {
      this.emit('error', err)
      this.child = null
    })
    this.emit('log', `全局热键已注册: ${accel}`)
    return true
  }

  stop() {
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
    this.accel = null
  }
}

module.exports = { HotkeyListener, parseAccelerator }
