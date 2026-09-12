param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutExe = ''
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
  return [System.IO.Path]::GetFullPath($Path)
}

$RepoRoot = Resolve-FullPath $RepoRoot
if ([string]::IsNullOrWhiteSpace($OutExe)) {
  $OutExe = Join-Path $RepoRoot 'dist\MaoyanOverlay.exe'
}
$OutExe = Resolve-FullPath $OutExe
$outDir = Resolve-FullPath (Split-Path -Parent $OutExe)
if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

Push-Location $RepoRoot
try {
  Write-Output 'Installing dependencies...'
  npm install --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  Write-Output 'Building portable EXE with electron-builder...'
  npx electron-builder --win portable --x64
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }

  $built = Join-Path $RepoRoot 'dist\MaoyanOverlay.exe'
  if (-not (Test-Path $built)) {
    throw "Build output missing: $built"
  }

  $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $ver = [string]$pkg.version
  if ($ver -match '^(\d+\.\d+)\.0+$') { $ver = $Matches[1] }

  if ((Resolve-FullPath $built) -ne $OutExe) {
    Copy-Item -Force $built $OutExe
  }

  $versionedExe = Join-Path $outDir ("MaoyanOverlay-" + $ver + ".exe")
  Copy-Item -Force $OutExe $versionedExe
  Set-Content -Path (Join-Path $outDir 'version.txt') -Value $ver -NoNewline -Encoding ascii

  $sizeMb = [math]::Round((Get-Item $OutExe).Length / 1MB, 2)
  Write-Output "VERSION=v$ver"
  Write-Output "EXE=$OutExe"
  Write-Output "VERSIONED_EXE=$versionedExe"
  Write-Output "SIZE=${sizeMb}MB"
}
finally {
  Pop-Location
}
