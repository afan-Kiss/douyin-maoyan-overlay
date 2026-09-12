$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $root "ui\index.html"))) {
  Write-Error "Project root not found: $root"
  exit 1
}
$baseline = Join-Path $root "backups\ui-baseline"
$manifestPath = Join-Path $baseline "MANIFEST.json"

if (-not (Test-Path $manifestPath)) {
  Write-Error "UI baseline backup not found: $baseline"
  exit 1
}

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($item in $manifest.files) {
  $src = Join-Path $baseline $item.from
  $dst = Join-Path $root $item.to
  if (-not (Test-Path $src)) {
    Write-Error "Missing backup file: $src"
    exit 1
  }
  $dir = Split-Path $dst -Parent
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  Copy-Item $src $dst -Force
  Write-Host "Restored $($item.to)"
}

Write-Host ""
Write-Host "UI restored from baseline: $($manifest.label) ($($manifest.createdAt))"
Write-Host "Restart the app (npm start) to see changes."
