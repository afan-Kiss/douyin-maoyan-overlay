param(
  [string]$SrcIcoPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) '1.ico'),
  [string]$IcoPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'build\icon.ico'),
  [int]$Size = 256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $SrcIcoPath)) {
  throw "ICO not found: $SrcIcoPath"
}

$dir = Split-Path $IcoPath -Parent
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$srcIcon = New-Object System.Drawing.Icon $SrcIcoPath
$srcBmp = $srcIcon.ToBitmap()
$srcIcon.Dispose()

$bmp = New-Object System.Drawing.Bitmap $Size, $Size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($srcBmp, 0, 0, $Size, $Size)
$g.Dispose()
$srcBmp.Dispose()

$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create($IcoPath)
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()

Write-Output "SRC=$SrcIcoPath"
Write-Output "ICON=$IcoPath"
