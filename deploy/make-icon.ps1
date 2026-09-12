param(
  [string]$PngPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) '1.png'),
  [string]$IcoPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'build\icon.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $PngPath)) {
  throw "PNG not found: $PngPath"
}

$dir = Split-Path $IcoPath -Parent
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$img = [System.Drawing.Image]::FromFile($PngPath)
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($img, 0, 0, $size, $size)
$g.Dispose()
$img.Dispose()

$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create($IcoPath)
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()

Write-Output "ICON=$IcoPath"
