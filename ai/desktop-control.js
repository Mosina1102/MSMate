// ============================================
// 桌面控制引擎（desktop_* 工具的执行层）：挂机办公
// 原理：常驻 PowerShell 子进程，Add-Type 编译 SendInput 键鼠封装（零 npm 依赖），
//       stdin/stdout 行式 JSON 协议；进程崩溃自动重启，命令带 id 超时兜底。
// 协议要点：含中文字段一律 base64（b64 解码），绕开 PS 5.1 重定向流编码坑。
// 坐标体系：物理像素（与 screenshot 的整屏截图同基准），主显示器为主。
// 审批归属：classify 层 destructive=true → 手动档弹卡 / 自动信任放行 / 无限制放行。
// ============================================
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { screen } = require('electron')

// 主屏物理尺寸（归一化坐标换算基准；npx/node 测试环境无 screen 时退 1920x1080）
function primaryPhysical() {
  try {
    const pri = screen.getPrimaryDisplay()
    return { w: Math.round(pri.size.width * pri.scaleFactor), h: Math.round(pri.size.height * pri.scaleFactor) }
  } catch { return { w: 1920, h: 1080 } }
}

// Electron 主进程才有 app；纯 Node 测试环境退化到 %APPDATA%（让引擎可独立探针验证）
function _userDataDir() {
  try {
    const app = require('electron').app
    if (app && app.getPath) return app.getPath('userData')
  } catch {}
  return process.env.APPDATA || '.'
}

// PowerShell 引导脚本：Add-Type 编译 C# 键鼠类 + stdin 循环执行 op
// 注意：C# 代码块用单引号 here-string（@'...'@），内部不能出现行首 '@
const BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$src = @'
using System;
using System.Runtime.InteropServices;
public static class MSDesk {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; public uint unused1; public uint unused2; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint KUP = 2;
  public const uint KUNI = 4;
  public const uint LDOWN = 2;
  public const uint LUP = 4;
  public const uint RDOWN = 8;
  public const uint RUP = 16;
  public const uint MDOWN = 32;
  public const uint MUP = 64;
  public const uint WHEELF = 2048;
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static string Click(int x, int y, int btn, int clicks, int wheel) {
    if (x >= 0 && y >= 0) SetCursorPos(x, y);
    if (wheel != 0) {
      INPUT[] a = new INPUT[1];
      a[0].type = INPUT_MOUSE; a[0].U.mi.dwFlags = WHEELF; a[0].U.mi.mouseData = unchecked((uint)wheel);
      SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
      return "ok";
    }
    uint df; uint uf;
    if (btn == 2) { df = RDOWN; uf = RUP; } else if (btn == 1) { df = MDOWN; uf = MUP; } else { df = LDOWN; uf = LUP; }
    INPUT[] s = new INPUT[clicks * 2];
    for (int i = 0; i < clicks; i++) {
      s[i * 2].type = INPUT_MOUSE; s[i * 2].U.mi.dwFlags = df;
      s[i * 2 + 1].type = INPUT_MOUSE; s[i * 2 + 1].U.mi.dwFlags = uf;
    }
    SendInput((uint)s.Length, s, Marshal.SizeOf(typeof(INPUT)));
    return "ok";
  }
  public static ushort VkOf(string k) {
    k = k.ToLower();
    int fn;
    if (k == "ctrl" || k == "control") return 0x11;
    if (k == "alt") return 0x12;
    if (k == "shift") return 0x10;
    if (k == "win" || k == "meta") return 0x5B;
    if (k == "enter" || k == "return") return 0x0D;
    if (k == "tab") return 0x09;
    if (k == "esc" || k == "escape") return 0x1B;
    if (k == "space") return 0x20;
    if (k == "backspace") return 0x08;
    if (k == "delete" || k == "del") return 0x2E;
    if (k == "insert") return 0x2D;
    if (k == "home") return 0x24;
    if (k == "end") return 0x23;
    if (k == "pageup") return 0x21;
    if (k == "pagedown") return 0x22;
    if (k == "up") return 0x26;
    if (k == "down") return 0x28;
    if (k == "left") return 0x25;
    if (k == "right") return 0x27;
    if (k == "printscreen") return 0x2C;
    if (k.Length == 1 && k[0] >= 'a' && k[0] <= 'z') return (ushort)('A' + (k[0] - 'a'));
    if (k.Length == 1 && k[0] >= '0' && k[0] <= '9') return (ushort)k[0];
    if (k.Length >= 2 && k[0] == 'f' && int.TryParse(k.Substring(1), out fn) && fn >= 1 && fn <= 24) return (ushort)(0x6F + fn);
    return 0;
  }
  public static string Combo(string[] keys) {
    ushort[] vks = new ushort[keys.Length];
    for (int i = 0; i < keys.Length; i++) { vks[i] = VkOf(keys[i]); if (vks[i] == 0) return "unknown key: " + keys[i]; }
    INPUT[] s = new INPUT[keys.Length * 2];
    for (int i = 0; i < keys.Length; i++) { s[i].type = INPUT_KEYBOARD; s[i].U.ki.wVk = vks[i]; }
    for (int i = 0; i < keys.Length; i++) { s[keys.Length + i].type = INPUT_KEYBOARD; s[keys.Length + i].U.ki.wVk = vks[keys.Length - 1 - i]; s[keys.Length + i].U.ki.dwFlags = KUP; }
    SendInput((uint)s.Length, s, Marshal.SizeOf(typeof(INPUT)));
    return "ok";
  }
  public static string TypeText(string text) {
    // UNICODE SendInput 逐字符（支持中文/全角）；每 120 字符一批防部分程序丢字
    for (int base0 = 0; base0 < text.Length; base0 += 120) {
      int n = Math.Min(120, text.Length - base0);
      INPUT[] s = new INPUT[n * 2];
      for (int i = 0; i < n; i++) {
        char c = text[base0 + i];
        s[i * 2].type = INPUT_KEYBOARD; s[i * 2].U.ki.wScan = c; s[i * 2].U.ki.dwFlags = KUNI;
        s[i * 2 + 1].type = INPUT_KEYBOARD; s[i * 2 + 1].U.ki.wScan = c; s[i * 2 + 1].U.ki.dwFlags = KUNI | KUP;
      }
      SendInput((uint)s.Length, s, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(12);
    }
    return "ok";
  }
}
'@
Add-Type -TypeDefinition $src
function B64Dec([string]$s) { if (-not $s) { return '' } [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($s)) }
function B64Enc([string]$s) { [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$s)) }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $null
  $id = 0
  try {
    $cmd = $line | ConvertFrom-Json
    $id = [int]$cmd.id
    $op = [string]$cmd.op
    switch ($op) {
      'ping' { $resp = @{ id = $id; ok = $true } }
      'click' { [void][MSDesk]::Click([int]$cmd.x, [int]$cmd.y, [int]$cmd.button, [int]$cmd.clicks, 0); $resp = @{ id = $id; ok = $true } }
      'scroll' { [void][MSDesk]::Click([int]$cmd.x, [int]$cmd.y, 0, 0, [int]$cmd.amount); $resp = @{ id = $id; ok = $true } }
      'type' { $t = B64Dec $cmd.text; [void][MSDesk]::TypeText($t); $resp = @{ id = $id; ok = $true } }
      'key' {
        $ks = @($cmd.keys | ForEach-Object { B64Dec ([string]$_) })
        $r = [MSDesk]::Combo([string[]]$ks)
        if ($r -eq 'ok') { $resp = @{ id = $id; ok = $true } } else { $resp = @{ id = $id; ok = $false; err = (B64Enc $r) } }
      }
      'cursor' {
        $p = New-Object MSDesk+POINT
        [void][MSDesk]::GetCursorPos([ref]$p)
        $resp = @{ id = $id; ok = $true; x = $p.X; y = $p.Y }
      }
      'winList' {
        $wins = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { @{ pid = $_.Id; t = (B64Enc $_.MainWindowTitle); proc = $_.ProcessName } })
        $resp = @{ id = $id; ok = $true; wins = $wins }
      }
      'winAct' {
        $p = Get-Process -Id ([int]$cmd.pid) -ErrorAction Stop
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
          [void][MSDesk]::ShowWindow($p.MainWindowHandle, 9)   # 9 = SW_RESTORE（最小化也拉起）
          [void][MSDesk]::SetForegroundWindow($p.MainWindowHandle)
          Start-Sleep -Milliseconds 180                          # 焦点切换落定，随后键鼠才可靠
          $resp = @{ id = $id; ok = $true }
        } else { $resp = @{ id = $id; ok = $false; err = (B64Enc '该进程没有可交互的主窗口') } }
      }
      'winMin' { $p = Get-Process -Id ([int]$cmd.pid) -ErrorAction Stop; [void][MSDesk]::ShowWindow($p.MainWindowHandle, 6); $resp = @{ id = $id; ok = $true } }   # 6 = SW_MINIMIZE
      'winMax' { $p = Get-Process -Id ([int]$cmd.pid) -ErrorAction Stop; [void][MSDesk]::ShowWindow($p.MainWindowHandle, 3); $resp = @{ id = $id; ok = $true } }   # 3 = SW_MAXIMIZE
      'winClose' {
        $p = Get-Process -Id ([int]$cmd.pid) -ErrorAction Stop
        $r = $p.CloseMainWindow()
        $resp = @{ id = $id; ok = [bool]$r }
      }
      'uiatree' {
        # UIA 控件树：读原生程序的"控件名册"（名字/类型/坐标/可操作），AI 拿坐标直接 desktop_click——不用视觉猜
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $AE = [System.Windows.Automation.AutomationElement]
        $target = $null
        if ($cmd.pid) {
          $p = Get-Process -Id ([int]$cmd.pid) -ErrorAction Stop
          if ($p.MainWindowHandle -eq [IntPtr]::Zero) { throw '该进程没有主窗口' }
          $target = $AE::FromHandle($p.MainWindowHandle)
        } else {
          $sig = 'using System; using System.Runtime.InteropServices; public static class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }'
          if (-not ('FG' -as [type])) { Add-Type -TypeDefinition $sig }
          $h = [FG]::GetForegroundWindow()
          if ($h -eq [IntPtr]::Zero) { throw '取前台窗口失败' }
          $target = $AE::FromHandle($h)
        }
        $els = $target.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $items = @()
        $i = 0
        $kw = if ($cmd.filter) { B64Dec $cmd.filter } else { '' }
        foreach ($el in $els) {
          if ($items.Count -ge 150) { break }
          try {
            $c = $el.Current
            if (-not $c.IsEnabled) { continue }
            $r = $c.BoundingRectangle
            if ($r.Width -le 1 -or $r.Height -le 1) { continue }
            $nm = $c.Name
            if ($kw -and $nm -and ($nm.IndexOf($kw, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) { continue }
            $i++
            $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName.Split('.')[0] })
            $items += @{ n = $i; t = (B64Enc $c.LocalizedControlType); nm = (B64Enc $nm); x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; p = ($pats -join ',') }
          } catch {}
        }
        $resp = @{ id = $id; ok = $true; els = $items }
      }
      default { $resp = @{ id = $id; ok = $false; err = (B64Enc "unknown op: $op") } }
    }
  } catch {
    $resp = @{ id = $id; ok = $false; err = (B64Enc $_.Exception.Message) }
  }
  [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress -Depth 4))
}
`

const BOOT_VER = 'msdesk-v4' // 改引导脚本必升版本：旧文件靠 includes 判定不重写（v4：修 TrueCondition 取错类导致 UIA 名册全挂）

class DesktopControl {
  constructor(log) {
    this.log = log || (() => {})
    this.proc = null
    this.pending = new Map()   // id -> { resolve, timer }
    this.reqId = 0
    this.starting = null
    this._lastMouse = null     // 上次键鼠 op 落点（用户占用避让的基线）
  }

  // 引导脚本落盘（userData 内；内容版本没变就复用，避免每次启动重写）
  _bootstrapFile() {
    const dir = _userDataDir()
    const p = path.join(dir, 'desktop-bootstrap.ps1')
    try {
      const cur = fs.readFileSync(p, 'utf8')
      if (cur.includes(BOOT_VER)) return p
    } catch {}
    // UTF8 必须带 BOM：PS 5.1 对无 BOM 脚本按 ANSI 解析，中文全部乱码（真机实锤）
    fs.writeFileSync(p, '\ufeff' + BOOTSTRAP, 'utf8')
    return p
  }

  ensure() {
    if (this.proc && !this.proc.killed) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      try {
        const ps1 = this._bootstrapFile()
        const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
        this.proc = proc
        this._buf = ''
        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (d) => {
          this._buf += d
          let idx
          while ((idx = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, idx).trim()
            this._buf = this._buf.slice(idx + 1)
            if (!line) continue
            let msg = null
            try { msg = JSON.parse(line) } catch { continue }
            const pend = this.pending.get(msg.id)
            if (pend) {
              clearTimeout(pend.timer)
              this.pending.delete(msg.id)
              pend.resolve(msg)
            }
          }
        })
        proc.stderr.on('data', (d) => this.log('[desktop] stderr: ' + String(d).slice(0, 300)))
        proc.on('exit', () => {
          this.proc = null
          for (const [, pend] of this.pending) {
            clearTimeout(pend.timer)
            pend.resolve({ id: pend.id, ok: false, err: b64('桌面控制进程已退出') })
          }
          this.pending.clear()
        })
        // ping 等编译完成（首次 Add-Type 约 1-3 秒）
        const t = setTimeout(() => reject(new Error('桌面控制引擎启动超时')), 15000)
        this._exec('ping', {}, 14000).then((r) => {
          clearTimeout(t)
          if (r.ok) resolve()
          else reject(new Error(b64dec(r.err) || '引擎启动失败'))
        }).catch((e) => { clearTimeout(t); reject(e) })
      } catch (e) {
        reject(e)
      }
    })
    return this.starting.finally(() => { this.starting = null })
  }

  _exec(op, params = {}, timeoutMs = 10000) {
    const id = ++this.reqId
    const line = JSON.stringify(Object.assign({ id, op }, params))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`桌面操作超时（${op}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        this.proc.stdin.write(line + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('桌面控制进程不可用: ' + e.message))
      }
    })
  }

  async _run(op, params, timeoutMs) {
    await this.ensure()
    return this._exec(op, params, timeoutMs)
  }

  // 用户占用避让（老大场景实锤：用户全屏 WPS 办公时 AI 同时接管键鼠 → 互相打架，AI 的字可能灌进用户表格）。
  // 键鼠 op 前对比鼠标位置与上次 AI 操作落点：动了 = 用户在操作 → 拒绝执行并把新位置记为基线
  // （用户停手后 AI 重试即放行，不死锁）。AI 自己的 click/scroll 会更新基线，不会自我误判
  async _checkUserBusy() {
    try {
      const r = await this._exec('cursor', {}, 3000)
      if (!r.ok) return false
      const cur = { x: r.x, y: r.y }
      const last = this._lastMouse
      this._lastMouse = cur
      if (!last) return false // 首次无基线（本次只是建档）
      return Math.abs(cur.x - last.x) + Math.abs(cur.y - last.y) > 24
    } catch { return false }
  }

  // 以下方法返回统一错误体（tools.js 直接透传给 AI）
  // 归一化坐标优先（nx/ny 0-1000，Anthropic computer-use 同款协议）：视觉模型输出归一化坐标
  // 是其强项，绝对像素易受截图缩放/DPI 影响——nx/ny × 主屏物理尺寸 = 精确定位
  async click(params) {
    if (await this._checkUserBusy()) return { ok: false, userBusy: true, error: '检测到鼠标正在移动（用户可能正在操作电脑）。已暂停本次键鼠操作避免互相干扰。用户停手后重试即可；连续出现请 ask_user 询问用户是否在用电脑' }
    const { x, y, button = 'left', double = false, nx, ny } = params || {}
    let cx = x, cy = y
    if (nx != null || ny != null) {
      const { w, h } = primaryPhysical()
      if (nx != null) cx = Math.round((Number(nx) / 1000) * w)
      if (ny != null) cy = Math.round((Number(ny) / 1000) * h)
    }
    cx = Math.round(cx); cy = Math.round(cy)
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx < 0 || cy < 0) return { ok: false, error: '坐标非法' }
    const r = await this._run('click', { x: cx, y: cy, button: button === 'right' ? 2 : (button === 'middle' ? 1 : 0), clicks: double ? 2 : 1 })
    if (r.ok) { this._lastMouse = { x: cx, y: cy }; return { ok: true, x: cx, y: cy } }
    return { ok: false, error: b64dec(r.err) || '点击失败' }
  }

  async type(text) {
    if (await this._checkUserBusy()) return { ok: false, userBusy: true, error: '检测到鼠标正在移动（用户可能正在操作电脑）。已暂停本次键鼠操作避免互相干扰。用户停手后重试即可；连续出现请 ask_user 询问用户是否在用电脑' }
    const r = await this._run('type', { text: b64(String(text || '')) }, 30000)
    return r.ok ? { ok: true } : { ok: false, error: b64dec(r.err) || '输入失败' }
  }

  async key(keys) {
    if (await this._checkUserBusy()) return { ok: false, userBusy: true, error: '检测到鼠标正在移动（用户可能正在操作电脑）。已暂停本次键鼠操作避免互相干扰。用户停手后重试即可；连续出现请 ask_user 询问用户是否在用电脑' }
    // 键名逐个 b64 传输（PS 侧解码后进 Combo），如 ["ctrl","s"]
    const arr = (Array.isArray(keys) ? keys : [keys]).map((k) => b64(String(k).trim()))
    const r = await this._run('key', { keys: arr }, 10000)
    return r.ok ? { ok: true } : { ok: false, error: b64dec(r.err) || '按键失败' }
  }

  async scroll(x, y, amount) {
    if (await this._checkUserBusy()) return { ok: false, userBusy: true, error: '检测到鼠标正在移动（用户可能正在操作电脑）。已暂停本次键鼠操作避免互相干扰。用户停手后重试即可；连续出现请 ask_user 询问用户是否在用电脑' }
    // amount: 正=向上滚，负=向下滚（WHEEL delta 单位，一格≈120）
    const r = await this._run('scroll', { x: Math.round(x), y: Math.round(y), amount: Math.round(amount) })
    if (r.ok) { this._lastMouse = { x: Math.round(x), y: Math.round(y) }; return { ok: true } }
    return { ok: false, error: b64dec(r.err) || '滚动失败' }
  }

  async cursor() {
    const r = await this._run('cursor', {})
    return r.ok ? { ok: true, x: r.x, y: r.y } : { ok: false, error: b64dec(r.err) || '取坐标失败' }
  }

  async windowList() {
    const r = await this._run('winList', {}, 15000)
    if (!r.ok) return { ok: false, error: b64dec(r.err) || '枚举窗口失败' }
    const wins = (r.wins || []).map((w) => ({ pid: w.pid, title: b64dec(w.t), proc: w.proc }))
    return { ok: true, windows: wins }
  }

  async _winOp(op, pid) {
    const r = await this._run(op, { pid: Number(pid) || 0 })
    return r.ok ? { ok: true } : { ok: false, error: b64dec(r.err) || '窗口操作失败' }
  }
  windowActivate(pid) { return this._winOp('winAct', pid) }
  windowMinimize(pid) { return this._winOp('winMin', pid) }
  windowMaximize(pid) { return this._winOp('winMax', pid) }
  windowClose(pid) { return this._winOp('winClose', pid) }

  // UIA 控件树：读原生程序控件名册（名字/类型/坐标/可操作 pattern），AI 拿坐标直接 desktop_click
  async uiaTree(pid, filter) {
    const r = await this._run('uiatree', { pid: Number(pid) || 0, filter: filter ? b64(String(filter)) : '' }, 20000)
    if (!r.ok) return { ok: false, error: b64dec(r.err) || '控件树读取失败' }
    const els = (r.els || []).map((e) => ({ n: e.n, type: b64dec(e.t), name: b64dec(e.nm), x: e.x, y: e.y, w: e.w, h: e.h, patterns: e.p }))
    return { ok: true, elements: els }
  }

  kill() {
    if (this.proc) { try { this.proc.kill() } catch {} this.proc = null }
  }
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64') }
function b64dec(s) { try { return s ? Buffer.from(String(s), 'base64').toString('utf8') : '' } catch { return '' } }

module.exports = { DesktopControl, b64, b64dec }
