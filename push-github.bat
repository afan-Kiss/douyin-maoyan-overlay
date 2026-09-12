@echo off
chcp 65001 >nul
cd /d "%~dp0"

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content -Raw 'deploy\github.json' | ConvertFrom-Json).token"`) do set GH_TOKEN=%%i
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content -Raw 'deploy\github.json' | ConvertFrom-Json).owner"`) do set GH_OWNER=%%i
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content -Raw 'deploy\github.json' | ConvertFrom-Json).repo"`) do set GH_REPO=%%i
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content -Raw 'deploy\github.json' | ConvertFrom-Json).branch"`) do set GH_BRANCH=%%i

if "%GH_TOKEN%"=="" (
  echo [错误] deploy\github.json 中未配置 token
  exit /b 1
)

set "REMOTE_URL=https://%GH_TOKEN%@github.com/%GH_OWNER%/%GH_REPO%.git"

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "%REMOTE_URL%"
) else (
  git remote set-url origin "%REMOTE_URL%"
)

echo 正在推送到 GitHub: %GH_OWNER%/%GH_REPO% (%GH_BRANCH%)
git push -u origin %GH_BRANCH%
if errorlevel 1 (
  echo [失败] 推送失败
  exit /b 1
)

echo [完成] 已推送到 GitHub
exit /b 0
