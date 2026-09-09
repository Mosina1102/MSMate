# doc2docx.ps1 - Convert legacy Word .doc (OLE2 binary) to .docx via COM automation.
# Engine candidates: WPS Writer (KWPS.Application) -> MS Word (Word.Application) -> legacy WPS (WPS.Application).
# Each engine gets 2 rounds: v2.5.73 real-world failure "Word could not fire event" (COMException) on user machines
# is a busy/event-pump error - retry after a short sleep plus minimal-arg Open fallback fixes the majority.
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
        try { $doc.SaveAs2($Dst, 16); $saved = $true } catch { $saved = $false }
        if (-not $saved) {
          try { $doc.SaveAs($Dst, 16); $saved = $true } catch { $steps += ('{0}:SAVE r{1}' -f $id, $round) }
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
