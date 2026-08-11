@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 没有检测到 Node.js，正在打开安装引导……
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-bootstrap.ps1"
)

where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 仍不可用。请安装当前 LTS 版本并重新双击本文件。
  pause
  exit /b 1
)

node scripts\launch.mjs
if errorlevel 1 pause
endlocal
