// ============================================
// Win32 文档窗口嵌入引擎（实验性）
// 目标：本机装了 WPS/MS Word 时，把文档窗口 SetParent 进应用顶层窗口，
//       在工作台内直接用 WPS/Word 内核编辑（保真 100%）。
// 链路：detectDocxHandler（注册表探测 .docx 默认程序）
//      → EmbedManager 长驻 PowerShell 帮手（stdin 行协议，一次 Add-Type 常驻）
//      → 抓不到窗口（WPS 多标签整合模式会委托已有实例）→ FAIL → 渲染层自动降级外部打开
// 帮手协议（一行一命令，响应一行）：
//   EMBED|parentPtr|exePath|filePath|x|y|w|h  → OK|FAIL|原因   （启动 exe 开文档→抓窗口→SetParent→MoveWindow）
//   MOVE|x|y|w|h  → OK / FAIL|dead             （子窗口坐标=父客户区坐标，物理像素）
//   HIDE / SHOW   → OK / FAIL|dead             （ShowWindow）
//   CLOSE         → OK / FAIL|dead             （PostMessage WM_CLOSE，WPS 有未保存会自己弹窗）
//   ALIVE         → YES / NO                   （IsWindow 轮询用）
//   QUIT          → （进程退出；退出前把窗口 SetParent 回桌面并显示，避免文档丢失）
// ============================================
const { spawn } = require('child_process')

// ===== 纯函数（冒烟直测） =====

// ProgId → 程序种类
function progIdToKind(progId) {
  const p = String(progId || '')
  if (/wps|kingsoft|kwps/i.test(p)) return 'wps'
  if (/word\.document|winword/i.test(p)) return 'word'
  return null
}

// reg query 输出 → 值（取最后一列）
function regValueOf(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.includes('REG_SZ'))
  if (!lines.length) return ''
  return lines[lines.length - 1].split('REG_SZ').pop().trim()
}

// 关联命令串 → exe 路径（"C:\a b\wps.exe" /u "%1" → C:\a b\wps.exe）
function exeFromCommand(cmdStr) {
  const s = String(cmdStr || '').trim()
  if (!s) return ''
  const m = /^"([^"]+)"/.exec(s)
  if (m) return m[1]
  const sp = s.indexOf(' ')
  return sp > 0 ? s.slice(0, sp) : s
}

// ===== 注册表探测 .docx 默认打开程序 =====
const { execFile } = require('child_process')
function regQuery(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''))
    })
  })
}
async function detectDocxHandler() {
  try {
    // 1) 用户实际选择（UserChoice 优先，Explorer 文件关联即它）
    let progId = regValueOf(await regQuery(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.docx\\UserChoice', '/v', 'ProgId']))
    // 2) 兜底：HKCR\.docx 默认值（ProgId）→ 直接判 kind
    if (!progId) progId = regValueOf(await regQuery(['query', 'HKCR\\.docx', '/ve']))
    const kind = progIdToKind(progId)
    if (!kind) return { kind: null }
    // 3) ProgId → open command → exe 路径
    const cmdOut = await regQuery(['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'])
    const exe = exeFromCommand(regValueOf(cmdOut))
    if (!exe || !/\.exe$/i.test(exe)) return { kind, progId, exe: '' }
    return { kind, progId, exe }
  } catch {
    return { kind: null }
  }
}

// ===== PowerShell 帮手脚本 =====
// 说明：全部 Win32 调用走 Add-Type P/Invoke；窗口抓取双层策略（PID 白名单 + 标题前缀白名单进程名），
// 覆盖 ksolaunch 启动器委托（PID 会变）与 Word 直开两种形态。
function helperScript() {
  return [
    "$ErrorActionPreference='Continue'",
    // 关键修复：Node 写 stdin 是 UTF-8，中文系统下 PowerShell 控制台默认按 GBK 读
    // → 中文文件名变乱码 → WPS 弹「不是有效的文件」+ 窗口标题匹配失败（no-window）
    "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }",
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class WEmbed {',
    '  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);',
    '  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);',
    '  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int idx, int val);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);',
    '  public static string Title(IntPtr h) { int n = GetWindowTextLength(h); if (n <= 0) return ""; var sb = new StringBuilder(n + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }',
    '}',
    "'@",
    "function Find-Target([uint32]$pidWant, [string]$baseName) {",
    "  $found = [IntPtr]::Zero",
    "  $cb = {",
    "    param([IntPtr]$h, [IntPtr]$l)",
    "    if ($found -eq [IntPtr]::Zero -and [WEmbed]::IsWindowVisible($h) -and [WEmbed]::GetParent($h) -eq [IntPtr]::Zero) {",
    "      $tp = [uint32]0",
    "      [void][WEmbed]::GetWindowThreadProcessId($h, [ref]$tp)",
    "      if ($tp -eq 0) { return $true }",
    "      $t = [WEmbed]::Title($h)",
    // 主匹配：标题必须含文件名（不限进程）——WPS 新版进程名多变（wpsoffice/kwps...），白名单会漏；
    // pidWant 不再单独匹配（启动器窗口标题是"WPS Office"不含文件名，会误抓启动页）
    "      if ($baseName -and $t -and $t.Contains($baseName)) { $found = $h; return $false }",
    "    }",
    "    return $true",
    "  }",
    "  [void][WEmbed]::EnumWindows($cb, [IntPtr]::Zero)",
    "  return $found",
    "}",
    "$child = [IntPtr]::Zero",
    // 中文路径传输通道：Node 写 stdin 是 UTF-8，但中文系统 PowerShell 控制台默认 GBK 解码
    // → [Console]::In.ReadLine() 读中文文件名必乱码（WPS 弹「不是有效的文件」+ 窗口标题匹配失败）。
    // [Console]::InputEncoding=UTF8 在重定向 stdin 下不生效，必须用 StreamReader 显式按 UTF-8 解码。
    "$sr = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)",
    "$sw = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))",
    "$sw.AutoFlush = $true",
    "function Reply([string]$s) { $sw.WriteLine($s) }",
    "Reply 'READY'",
    "while ($true) {",
    "  $line = $sr.ReadLine()",
    "  if ($null -eq $line) { break }",
    "  $p = $line.Split('|')",
    "  $cmd = $p[0]",
    "  try {",
    "    if ($cmd -eq 'QUIT') { break }",
    "    elseif ($cmd -eq 'PING') { Reply 'PONG' }",
    "    elseif ($cmd -eq 'EMBED') {",
    "      $parent = [IntPtr][long]$p[1]",
    "      $exe = $p[2]",
    "      $doc = $p[3]",
    "      $base = [System.IO.Path]::GetFileNameWithoutExtension($doc)",
    "      $proc = Start-Process -FilePath $exe -ArgumentList ('\"' + $doc + '\"') -PassThru",
    // 12 秒：WPS 冷启动较慢，且可能短暂启动器进程退出后复用已有 Office 进程开窗
    "      $deadline = (Get-Date).AddSeconds(12)",
    "      while ((Get-Date) -lt $deadline) {",
    "        Start-Sleep -Milliseconds 300",
    // 启动器进程退出 ≠ 失败：WPS 常复用已有 Office 进程开窗（标题含文件名），继续按 baseName 找
    "        $h = Find-Target ([uint32]$proc.Id) $base",
    "        if ($h -ne [IntPtr]::Zero) {",
    "          $style = [WEmbed]::GetWindowLong($h, -16)",
    "          $style = ($style -band (-bnot 0x80000000)) -band (-bnot 0x00C00000) -band (-bnot 0x00040000) -band (-bnot 0x00080000)",
    "          $style = $style -bor 0x40000000 -bor 0x10000000",
    "          [void][WEmbed]::SetWindowLong($h, -16, $style)",
    "          $ex = [WEmbed]::GetWindowLong($h, -20)",
    "          $ex = ($ex -band (-bnot 0x00040000)) -bor 0x00000080",
    "          [void][WEmbed]::SetWindowLong($h, -20, $ex)",
    "          [void][WEmbed]::SetParent($h, $parent)",
    "          [void][WEmbed]::MoveWindow($h, [int]$p[4], [int]$p[5], [int]$p[6], [int]$p[7], $true)",
    "          $child = $h",
    "          break",
    "        }",
    "      }",
    "      if ($child -ne [IntPtr]::Zero) { Reply 'OK' } else {",
    // 诊断：失败时枚举所有可见顶层窗口标题（不限进程，前 8 个）回传——进程名白名单会漏新版 WPS
    "        $cands = @()",
    "        $cb2 = {",
    "          param([IntPtr]$h, [IntPtr]$l)",
    "          if ($cands.Count -lt 8 -and [WEmbed]::IsWindowVisible($h) -and [WEmbed]::GetParent($h) -eq [IntPtr]::Zero) {",
    "            $t2 = [WEmbed]::Title($h)",
    "            if ($t2) { $cands += $t2 }",
    "          }",
    "          return $true",
    "        }",
    "        [void][WEmbed]::EnumWindows($cb2, [IntPtr]::Zero)",
    "        Reply ('FAIL|no-window;windows=' + ($cands -join ' || '))",
    "      }",
    "    }",
    "    elseif ($cmd -eq 'MOVE') {",
    "      if ($child -eq [IntPtr]::Zero -or -not [WEmbed]::IsWindow($child)) { Reply 'FAIL|dead' }",
    "      else { [void][WEmbed]::MoveWindow($child, [int]$p[1], [int]$p[2], [int]$p[3], [int]$p[4], $true); Reply 'OK' }",
    "    }",
    "    elseif ($cmd -eq 'HIDE') {",
    "      if ($child -eq [IntPtr]::Zero -or -not [WEmbed]::IsWindow($child)) { Reply 'FAIL|dead' }",
    "      else { [void][WEmbed]::ShowWindow($child, 0); Reply 'OK' }",
    "    }",
    "    elseif ($cmd -eq 'SHOW') {",
    "      if ($child -eq [IntPtr]::Zero -or -not [WEmbed]::IsWindow($child)) { Reply 'FAIL|dead' }",
    "      else { [void][WEmbed]::ShowWindow($child, 5); Reply 'OK' }",
    "    }",
    "    elseif ($cmd -eq 'CLOSE') {",
    "      if ($child -eq [IntPtr]::Zero -or -not [WEmbed]::IsWindow($child)) { Reply 'FAIL|dead' }",
    "      else { [void][WEmbed]::PostMessage($child, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); $child = [IntPtr]::Zero; Reply 'OK' }",
    "    }",
    "    elseif ($cmd -eq 'ALIVE') {",
    "      if ($child -ne [IntPtr]::Zero -and [WEmbed]::IsWindow($child)) { Reply 'YES' } else { Reply 'NO' }",
    "    }",
    "    else { Reply 'FAIL|unknown' }",
    "  } catch { Reply ('FAIL|' + $_.Exception.Message) }",
    "}",
    "if ($child -ne [IntPtr]::Zero -and [WEmbed]::IsWindow($child)) {",
    "  try {",
    "    [void][WEmbed]::SetParent($child, [IntPtr]::Zero)",
    "    [void][WEmbed]::ShowWindow($child, 9)",
    "  } catch { }",
    "}",
    "$host.SetShouldExit(0)"
  ].join('\n')
}

// ===== 帮手管理（长驻 + 串行命令队列 + 掉线重拉） =====
class EmbedManager {
  constructor() {
    this.proc = null
    this.ready = false
    this.queue = []          // 待发命令（帮手未 READY 前排队）
    this.waitersQ = []       // FIFO 等待队列：响应严格按命令顺序到达（协议串行）
    this.buf = ''
    this.spawning = false
  }

  _spawn() {
    if (this.proc || this.spawning) return
    this.spawning = true
    try {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', helperScript()], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      })
      this.proc = proc
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        this.buf += chunk
        let idx
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx).trim()
          this.buf = this.buf.slice(idx + 1)
          if (!line) continue
          if (line === 'READY') { this.ready = true; this._flush(); continue }
          const w = this.waitersQ.shift() // 串行协议：响应与命令 FIFO 对应
          if (w) { clearTimeout(w.timer); w.resolve(line) }
        }
      })
      const die = () => {
        this.proc = null
        this.ready = false
        this.spawning = false
        for (const w of this.waitersQ) { clearTimeout(w.timer); w.resolve('FAIL|helper-exited') }
        this.waitersQ = []
      }
      proc.on('exit', die)
      proc.on('error', die)
    } catch {
      this.spawning = false
    }
  }

  _flush() {
    while (this.ready && this.queue.length) {
      const cmd = this.queue.shift()
      try { this.proc.stdin.write(cmd + '\n') } catch { this.ready = false }
    }
  }

  // 发命令并等响应（帮手未 READY 时等它就绪（Add-Type 首编要 2-4s），串行队列）
  exec(cmd, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const start = Date.now()
      const attempt = () => {
        if (this.proc && this.ready) {
          const timer = setTimeout(() => {
            const i = this.waitersQ.indexOf(entry)
            if (i >= 0) this.waitersQ.splice(i, 1)
            resolve('FAIL|timeout')
          }, timeoutMs)
          const entry = { resolve, timer }
          this.waitersQ.push(entry)
          try { this.proc.stdin.write(cmd + '\n') } catch { clearTimeout(timer); const i = this.waitersQ.indexOf(entry); if (i >= 0) this.waitersQ.splice(i, 1); resolve('FAIL|helper-exited') }
          return
        }
        if (Date.now() - start > 10000) return resolve('FAIL|helper-unavailable')
        if (!this.proc) this._spawn()
        setTimeout(attempt, 200)
      }
      attempt()
    })
  }

  async embed(parentHwnd, exe, filePath, rect) {
    // exe/filePath 含空格没问题（协议按 | 分段，不按空格）；路径里不该有 |，有就拒
    if (/[|\r\n]/.test(exe) || /[|\r\n]/.test(filePath)) return 'FAIL|bad-path'
    return this.exec(['EMBED', parentHwnd, exe, filePath, rect.x, rect.y, rect.w, rect.h].join('|'), 20000)
  }
  move(rect) { return this.exec(['MOVE', rect.x, rect.y, rect.w, rect.h].join('|'), 5000) }
  hide() { return this.exec('HIDE', 5000) }
  show() { return this.exec('SHOW', 5000) }
  close() { return this.exec('CLOSE', 5000) }
  alive() { return this.exec('ALIVE', 5000) }
  quit() {
    if (!this.proc) return
    try { this.proc.stdin.write('QUIT\n') } catch {}
    setTimeout(() => { try { this.proc && this.proc.kill() } catch {} }, 1500)
    this.proc = null
    this.ready = false
  }
}

const manager = new EmbedManager()

module.exports = { progIdToKind, regValueOf, exeFromCommand, detectDocxHandler, manager, helperScript }
