@echo off
chcp 65001 >nul
cd /d "%~dp0"
node deploy\push-github.js
exit /b %ERRORLEVEL%
