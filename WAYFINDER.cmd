@echo off
setlocal
cd /d "%~dp0"

if exist "WAYFINDER-LOCAL-SETTINGS.cmd" call "WAYFINDER-LOCAL-SETTINGS.cmd"

where node >nul 2>nul
if errorlevel 1 (
  echo WAYFINDER requires Node.js 20 or newer.
  echo Install Node.js, then run WAYFINDER.cmd again.
  pause
  exit /b 1
)

for /f %%V in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 20 (
  echo WAYFINDER requires Node.js 20 or newer. Detected Node %NODE_MAJOR%.
  pause
  exit /b 1
)

if not defined WAYFINDER_PORT set "WAYFINDER_PORT=4198"
node wayfinder-control.mjs launch
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo WAYFINDER could not open.
  echo If an older WAYFINDER process is stuck, use SUPPORT\RECOVER-WAYFINDER.cmd once.
  pause
)
exit /b %RC%
