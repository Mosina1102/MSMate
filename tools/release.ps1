﻿# MSMate 一键发版脚本（v2.4.99）
# 用法：
#   .\tools\release.ps1                     # 打包 + 建 Release + 传 exe（版本号取 package.json）
#   .\tools\release.ps1 -SkipBuild          # 跳过打包，直接上传已有 exe
#   .\tools\release.ps1 -Notes "更新内容"   # 自定义 Release 说明
# token：读 %APPDATA%\MSMate\release-token.txt（GitHub PAT，勾 repo 权限即可）
param(
  [switch]$SkipBuild,
  [string]$Notes = ''
)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# ① 版本号 + 输出目录自动对齐（package.json build.directories.output 跟着版本走）
$pkgPath = Join-Path $root 'package.json'
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$wantDir = "release_build_v" + ($version -replace '\.', '')
$pkgRaw = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8)
if ($pkgRaw -notmatch [regex]::Escape('"output": "' + $wantDir + '"')) {
  $pkgRaw = [regex]::Replace($pkgRaw, '"output": "release_build_v\d+"', ('"output": "' + $wantDir + '"'))
  [IO.File]::WriteAllText($pkgPath, $pkgRaw, [Text.UTF8Encoding]::new($false))
  Write-Host "输出目录已自动切到 $wantDir"
}
Write-Host "发版版本: v$version"

# ② token
$tokenFile = Join-Path $env:APPDATA 'MSMate\release-token.txt'
if (-not (Test-Path $tokenFile)) { Write-Host "ERR: 找不到 token 文件 $tokenFile（把 GitHub PAT 存进去，勾 repo 权限）"; exit 1 }
$token = (Get-Content $tokenFile -Raw).Trim()
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'MSMate-Release' }

# ③ 打包（可跳过）
if (-not $SkipBuild) {
  Write-Host '打包中（npm run build）…'
  Push-Location $root
  try { npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build 失败（exit $LASTEXITCODE）" } } finally { Pop-Location }
}
$exe = Join-Path $root "$wantDir\MSMate.Setup.$version.exe"
if (-not (Test-Path $exe)) { Write-Host "ERR: 找不到安装包 $exe"; exit 1 }
$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "安装包: $exe ($mb MB)"

# ④ 建 Release（同 tag 存在则复用，幂等）
$rel = $null
try {
  $rel = Invoke-RestMethod -Method Get -Uri ('https://api.github.com/repos/Mosina1102/MSMate/releases/tags/v' + $version) -Headers $headers
  Write-Host "Release v$version 已存在，复用"
} catch {
  if (-not $Notes) {
    $Notes = "MSMate v$version 安装包。`n`n更新内容见软件内「全局设置 → 关于 → 检查更新」。"
  }
  $body = @{ tag_name = ('v' + $version); name = ('MSMate v' + $version); body = $Notes } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/repos/Mosina1102/MSMate/releases' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
  Write-Host ('Release 已创建: id=' + $rel.id + ' tag=' + $rel.tag_name)
}

# ⑤ 传 exe（同名旧 asset 先删，可重复发）
$assetName = "MSMate.Setup.$version.exe"
foreach ($a in @($rel.assets | Where-Object { $_.name -eq $assetName })) {
  Invoke-RestMethod -Method Delete -Uri ('https://api.github.com/repos/Mosina1102/MSMate/releases/assets/' + $a.id) -Headers $headers | Out-Null
  Write-Host ('已删除旧 asset: ' + $a.name)
}
$uploadUri = ($rel.upload_url -replace '\{\?.*$', '') + '?name=' + [uri]::EscapeDataString($assetName)
$sw = [Diagnostics.Stopwatch]::StartNew()
$asset = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -ContentType 'application/octet-stream' -InFile $exe -TimeoutSec 900
$sw.Stop()
Write-Host ('上传完成: ' + $asset.name + ' ' + [math]::Round($asset.size / 1MB, 1) + 'MB 耗时 ' + [int]$sw.Elapsed.TotalSeconds + 's')
Write-Host ('下载直链: ' + $asset.browser_download_url)
Write-Host ('Release 页: https://github.com/Mosina1102/MSMate/releases/tag/v' + $version)
