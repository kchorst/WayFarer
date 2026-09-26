@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
call npm run package:verify
if errorlevel 1 (
  echo.
  echo Package verification failed.
  pause
  exit /b 1
)
echo.
echo Local package verification passed.
echo Final release qualification is produced by the frozen GitHub Windows release workflow.
pause
