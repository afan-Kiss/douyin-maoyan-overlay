@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   猫眼票房直播展示 - 环境安装
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js
  pause
  exit /b 1
)

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 (
  echo npm 安装失败
  pause
  exit /b 1
)

echo.
echo 正在安装 Playwright 浏览器组件...
call npx playwright install chromium
if errorlevel 1 (
  echo Playwright 安装失败，请检查网络
  pause
  exit /b 1
)

echo.
echo 安装完成！双击 start.bat 启动软件。
pause
