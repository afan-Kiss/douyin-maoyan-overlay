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
  Write-Output 'Generating icon from Desktop\1.ico ...'
  & (Join-Path $PSScriptRoot 'make-icon.ps1')
  Write-Output 'Building portable EXE with electron-builder...'
  npx electron-builder --win portable --x64
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }

  $pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $verFull = [string]$pkg.version
  $ver = $verFull
  if ($ver -match '^(\d+\.\d+)\.0+$') { $ver = $Matches[1] }

  # electron-builder artifactName 产出 MaoyanOverlay-${version}.exe；
  # 禁止优先取 dist\MaoyanOverlay.exe（常是旧文件，会导致上传错包）
  $builtCandidates = @(
    (Join-Path $RepoRoot ("dist\MaoyanOverlay-" + $verFull + ".exe")),
    (Join-Path $RepoRoot ("dist\MaoyanOverlay-" + $ver + ".exe"))
  )
  $built = $builtCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $built) {
    $built = Get-ChildItem (Join-Path $RepoRoot 'dist') -Filter 'MaoyanOverlay*.exe' |
      Where-Object { $_.Name -match "MaoyanOverlay-$([regex]::Escape($verFull))\.exe|MaoyanOverlay-$([regex]::Escape($ver))\.exe" } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $built) {
    $built = Get-ChildItem (Join-Path $RepoRoot 'dist') -Filter 'MaoyanOverlay*.exe' |
      Where-Object { $_.Name -ne 'MaoyanOverlay.exe' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $built -or -not (Test-Path $built)) {
    throw "Build output missing: MaoyanOverlay*.exe under dist/"
  }

  if ((Resolve-FullPath $built) -ne $OutExe) {
    Copy-Item -Force $built $OutExe
  }

  $versionedExe = Join-Path $outDir ("MaoyanOverlay-" + $ver + ".exe")
  Copy-Item -Force $OutExe $versionedExe
  Set-Content -Path (Join-Path $outDir 'version.txt') -Value $ver -NoNewline -Encoding ascii

  $sizeMb = [math]::Round((Get-Item $OutExe).Length / 1MB, 2)
  $desktopExe = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MaoyanOverlay.exe'
  Copy-Item -Force $OutExe $desktopExe
  Write-Output "DESKTOP_EXE=$desktopExe"
  Write-Output "VERSION=v$ver"
  Write-Output "EXE=$OutExe"
  Write-Output "VERSIONED_EXE=$versionedExe"
  Write-Output "SIZE=${sizeMb}MB"
}
finally {
  Pop-Location
}
