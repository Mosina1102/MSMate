// generate-icons.js — 应用图标生成（assets/icon.png + assets/icon.ico）
// 用法：node generate-icons.js [源图路径]   默认源图：图标.png
// 流程：PowerShell System.Drawing 高质量缩放（32bppArgb 保留透明，TileFlipXY 防边缘光晕）
//       → Node 打包多尺寸 ICO（PNG 条目格式，Vista+ / Electron 通用）
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = __dirname
const srcArg = process.argv[2]
const src = srcArg ? path.resolve(root, srcArg) : path.join(root, '图标.png')
const assetsDir = path.join(root, 'assets')
const tmpDir = path.join(root, '实验喵！', 'icon_tmp')
const sizes = [16, 32, 48, 64, 128, 256]

if (!fs.existsSync(src)) {
  console.error('未找到源图：' + src)
  console.error('请把图标原图放到项目根目录命名为 图标.png，或用参数指定：node generate-icons.js 路径.png')
  process.exit(1)
}
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

// 1) PowerShell 缩放六档 PNG
const psScript = `
Add-Type -AssemblyName System.Drawing
$srcPath = $env:MSM_ICON_SRC
$tmpDir = $env:MSM_ICON_TMP
$src = [System.Drawing.Image]::FromFile($srcPath)
foreach ($s in @(16,32,48,64,128,256)) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $imgAttr = New-Object System.Drawing.Imaging.ImageAttributes
  $imgAttr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $destRect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $g.DrawImage($src, $destRect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $imgAttr)
  $g.Dispose()
  $out = Join-Path $tmpDir ("icon_" + $s + ".png")
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("OK " + $s)
}
$src.Dispose()
`

execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
  env: { ...process.env, MSM_ICON_SRC: src, MSM_ICON_TMP: tmpDir },
  stdio: 'inherit'
})

// 2) 打包 ICO（PNG 条目：6 字节头 + 16 字节目录项 × N + 各 PNG 数据）
const pngs = sizes.map(s => fs.readFileSync(path.join(tmpDir, `icon_${s}.png`)))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)              // reserved
header.writeUInt16LE(1, 2)              // type: icon
header.writeUInt16LE(sizes.length, 4)   // count
const entries = []
let offset = 6 + 16 * sizes.length
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16)
  const s = sizes[i]
  e[0] = s >= 256 ? 0 : s               // width（256 写 0）
  e[1] = s >= 256 ? 0 : s               // height
  e[2] = 0                              // 色板数
  e[3] = 0                              // reserved
  e.writeUInt16LE(1, 4)                 // color planes
  e.writeUInt16LE(32, 6)                // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8)    // 数据大小
  e.writeUInt32LE(offset, 12)           // 数据偏移
  offset += pngs[i].length
  entries.push(e)
}
const ico = Buffer.concat([header, ...entries, ...pngs])
const icoPath = path.join(assetsDir, 'icon.ico')
fs.writeFileSync(icoPath, ico)

// 3) 256 档 → assets/icon.png（窗口/托盘用）
const pngPath = path.join(assetsDir, 'icon.png')
fs.writeFileSync(pngPath, pngs[sizes.indexOf(256)])

// 4) 自校验：ico 头 + 产物存在
const check = fs.readFileSync(icoPath)
const icoOk = check.readUInt16LE(2) === 1 && check.readUInt16LE(4) === sizes.length
if (!icoOk) { console.error('ICO 头校验失败'); process.exit(1) }

console.log('图标生成完成：')
console.log('  ' + pngPath + ' (' + fs.statSync(pngPath).size + ' bytes, 256x256)')
console.log('  ' + icoPath + ' (' + fs.statSync(icoPath).size + ' bytes, ' + sizes.join('/') + ')')
