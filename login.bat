@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MAOYAN_LOGIN_AUTO=1
node server/login.js
if errorlevel 1 pause
