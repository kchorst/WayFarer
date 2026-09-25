@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
call npm run release:check
if errorlevel 1 (
  echo.
  echo Verification failed.
  pause
  exit /b 1
)
echo.
echo Release Manager verification passed.
pause
