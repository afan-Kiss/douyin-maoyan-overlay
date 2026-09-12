@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   猫眼票房直播展示
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo 首次运行，请先执行 setup.bat 安装依赖
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在补全 Electron...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install --registry=https://registry.npmmirror.com
)

echo 正在检查更新（打包版 EXE 将自动更新）...
call npm start
