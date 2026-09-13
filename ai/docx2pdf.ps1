# docx2pdf.ps1 - Convert Word .docx/.doc to PDF via COM automation.
# Engine candidates: WPS Writer (KWPS.Application) -> MS Word (Word.Application) -> legacy WPS (WPS.Application).
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
# Prints "OK <dst> engine=... size=..." on success; "CONVERT_FAIL <steps>" + exit 1 on failure.
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dst
)
$ErrorActionPreference = 'Stop'

# v2.5.75 root-cause fix: WPS COM hangs forever on forward-slash paths ("C:/x/y.doc").
# Normalize to absolute backslash form before touching the COM layer (double safety with Node-side resolve).
if (Test-Path -LiteralPath $Src) { $Src = (Resolve-Path -LiteralPath $Src).Path }

$ids = @('KWPS.Application', 'Word.Application', 'WPS.Application')
$steps = @()

# stale half-written output from a previous failed round must go
if (Test-Path -LiteralPath $Dst) { try { Remove-Item -LiteralPath $Dst -Force } catch { } }

foreach ($id in $ids) {
  for ($round = 1; $round -le 2; $round++) {
    $app = $null
    try { $app = New-Object -ComObject $id } catch { $app = $null }
    if (-not $app) { $steps += ('{0}:LAUNCH' -f $id); continue }

    try {
      try { $app.DisplayAlerts = 0 } catch { }
      # defensive: force invisible automation (no window stealing focus on the user's screen)
      try { $app.Visible = $false } catch { }
      # try read-only 3-arg Open first; on COMException fall back to minimal 1-arg Open (max WPS compat)
      $doc = $null
      try { $doc = $app.Documents.Open($Src, $false, $true) } catch { $doc = $null }
      if (-not $doc) {
        Start-Sleep -Milliseconds 1200
        try { $doc = $app.Documents.Open($Src) } catch { $doc = $null }
      }
      if (-not $doc) {
        $steps += ('{0}:OPEN r{1}' -f $id, $round)
      } else {
        $saved = $false
        # wdExportFormatPDF = 17; magic check guards against WPS "fake success" writing docx (PK zip) back
        try { $doc.ExportAsFixedFormat($Dst, 17); $saved = $true } catch { $saved = $false }
        if (-not $saved) {
          # WPS KWPS: some versions silently reject the 2-arg form -> full-signature retry
          try { $doc.ExportAsFixedFormat($Dst, 17, $false, 0, 0, 1, 1, 0, $true, $true, 0, $true, $true, $false); $saved = $true } catch { $saved = $false }
        }
        if ($saved -and (Test-Path -LiteralPath $Dst)) {
          $fs2 = [IO.File]::OpenRead($Dst); $m2 = New-Object byte[] 4; [void]$fs2.Read($m2, 0, 4); $fs2.Close()
          if ($m2[0] -ne 0x25 -or $m2[1] -ne 0x50) { try { Remove-Item -LiteralPath $Dst -Force } catch { }; $saved = $false; $steps += ('{0}:NOTPDF r{1}' -f $id, $round) }
        }
        if (-not $saved) {
          try { $doc.SaveAs2($Dst, 17); $saved = $true } catch {
            try { $doc.SaveAs($Dst, 17); $saved = $true } catch { $steps += ('{0}:EXPORT r{1}' -f $id, $round) }
          }
          if ($saved -and (Test-Path -LiteralPath $Dst)) {
            $fs3 = [IO.File]::OpenRead($Dst); $m3 = New-Object byte[] 4; [void]$fs3.Read($m3, 0, 4); $fs3.Close()
            if ($m3[0] -ne 0x25 -or $m3[1] -ne 0x50) { try { Remove-Item -LiteralPath $Dst -Force } catch { }; $steps += ('{0}:NOTPDF r{1}' -f $id, $round); $saved = $false }
          }
        }
        try { $doc.Close($false) } catch { }
        if ($saved) {
          if (-not (Test-Path -LiteralPath $Dst)) { $steps += ('{0}:NOOUTPUT r{1}' -f $id, $round) }
          else {
            $sz = (Get-Item -LiteralPath $Dst).Length
            if ($sz -lt 1000) { $steps += ('{0}:TOOSMALL r{1} sz{2}' -f $id, $round, $sz) }
            else {
              Write-Output ('OK ' + $Dst + ' engine=' + $id + ' size=' + $sz)
              exit 0
            }
          }
        }
      }
    } finally {
      try { $app.Quit() } catch { }
      try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
    }
    Start-Sleep -Milliseconds 1500
  }
}
Write-Output ('CONVERT_FAIL ' + ($steps -join ' | '))
exit 1
