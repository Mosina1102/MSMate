# pdf2png.ps1 - Render PDF pages to PNG via Windows.Data.Pdf (WinRT, built-in on Windows 10+)
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.
# Output: one PNG per page, "pageNN.png" written to OutDir; prints full paths to stdout.
param(
  [Parameter(Mandatory = $true)][string]$PdfPath,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$MaxPages = 10,
  [double]$Scale = 2.0
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]

# WinRT IAsyncOperation/Action -> await helper (standard PowerShell projection trick)
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}
function AwaitAction($WinRtAction) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  $netTask = $asTask.Invoke($null, @($WinRtAction))
  $netTask.Wait(-1) | Out-Null
}

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
$count = [Math]::Min([int]$pdf.PageCount, $MaxPages)
$made = @()
for ($i = 0; $i -lt $count; $i++) {
  $page = $pdf.GetPage([uint32]$i)
  try {
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]([Math]::Max(320.0, $page.Size.Width * $Scale))
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    $inputStream = $stream.GetInputStreamAt(0)
    $reader = New-Object Windows.Storage.Streams.DataReader -ArgumentList $inputStream
    $byteCount = Await ($reader.LoadAsync($stream.Size)) ([UInt32])
    $bytes = New-Object byte[] $byteCount
    $reader.ReadBytes($bytes)
    $null = $reader.DetachStream() # DetachStream 返回 IInputStream——不捕获会被 PowerShell 回显污染 stdout
    $outFile = Join-Path $OutDir ("page{0:d2}.png" -f ($i + 1))
    [IO.File]::WriteAllBytes($outFile, $bytes)
    $made += $outFile
    $reader.DetachStream()
  } finally {
    if ($stream) { $stream.Dispose() }
    $page.Dispose()
  }
}
if ($made.Count -eq 0) { Write-Output 'NO_PAGES'; exit 1 }
Write-Output ($made -join "`n")
