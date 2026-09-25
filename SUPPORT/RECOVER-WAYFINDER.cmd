@echo off
setlocal
cd /d "%~dp0.."
if exist "WAYFINDER-LOCAL-SETTINGS.cmd" call "WAYFINDER-LOCAL-SETTINGS.cmd"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. End the stuck WAYFINDER node.exe process in Task Manager.
  pause
  exit /b 1
)
node wayfinder-control.mjs stop
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
