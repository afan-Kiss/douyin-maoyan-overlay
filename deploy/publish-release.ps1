param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$ServerUrl = '',
  [string]$AuthToken = $env:ADMIN_TOKEN,
  [string]$Platform = '',
  [string]$ReleaseNotes = '',
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

function Resolve-FullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
  return [System.IO.Path]::GetFullPath($Path)
}

$RepoRoot = Resolve-FullPath $RepoRoot
$credPath = Join-Path $PSScriptRoot 'aliyun.json'
if (Test-Path $credPath) {
  $cred = Get-Content $credPath -Raw | ConvertFrom-Json
  if (-not $ServerUrl) { $ServerUrl = [string]$cred.updateServerUrl }
  if (-not $Platform) { $Platform = [string]$cred.platform }
  if (-not $AuthToken -and $cred.adminToken) { $AuthToken = [string]$cred.adminToken }
}

if (-not $ServerUrl) { $ServerUrl = 'https://xiangyuzhubao.xyz' }
if (-not $Platform) { $Platform = 'maoyan-win-x64' }

$Version = $Version.Trim().TrimStart('v', 'V')
if ($Version -notmatch '^\d+(\.\d+)+$') {
  throw 'Invalid version format, use 1.0 / 1.1 / 9.9'
}

if (-not $AuthToken) {
  throw 'Set -AuthToken or ADMIN_TOKEN env var, or fill deploy/aliyun.json adminToken'
}

$exePath = Resolve-FullPath (Join-Path $RepoRoot 'dist\MaoyanOverlay.exe')
if (-not $SkipBuild) {
  $buildScript = Resolve-FullPath (Join-Path $PSScriptRoot 'build-release.ps1')
  & $buildScript -RepoRoot $RepoRoot -OutExe $exePath
}
if (-not (Test-Path $exePath)) {
  throw "EXE not found: $exePath"
}

$base = $ServerUrl.TrimEnd('/')
$headers = @{ Authorization = "Bearer $AuthToken" }

Write-Output "Creating draft v$Version ..."
$createBody = @{
  version      = $Version
  platform     = $Platform
  releaseNotes = $ReleaseNotes
} | ConvertTo-Json -Compress
$draft = Invoke-RestMethod -Method Post -Uri "$base/api/releases" -Headers $headers -ContentType 'application/json' -Body $createBody
$releaseId = $draft.id
Write-Output "releaseId=$releaseId"

Write-Output 'Uploading EXE...'
$uploadUri = "$base/api/releases/$releaseId/upload"
curl.exe -sS -X POST $uploadUri -H "Authorization: Bearer $AuthToken" -F "file=@$exePath" | Write-Output

Write-Output 'Publishing...'
$published = Invoke-RestMethod -Method Post -Uri "$base/api/releases/$releaseId/publish" -Headers $headers
Write-Output ($published | ConvertTo-Json -Depth 5)
Write-Output "Published MaoyanOverlay v$Version ($Platform)"
Write-Output "LOCAL_EXE=$exePath"
