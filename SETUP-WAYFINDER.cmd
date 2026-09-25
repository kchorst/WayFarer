@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"

echo WAYFINDER local setup (optional; settings are also available inside the app)
echo Leave any item blank to use its default or leave that feature unconfigured.
echo.
set /p "AI_ENDPOINT=Local AI endpoint [blank = auto-detect 8080/1234/11434]: "
set /p "AI_MODEL=Local AI model name [auto-detect]: "
set /p "REFERENCE_ENDPOINT=Kiwix/reference endpoint [http://127.0.0.1:8091]: "
set /p "MAPQUEST_KEY=MapQuest API key [optional]: "
set /p "PBF_ROOT=Existing offline .osm.pbf library folder [optional]: "

echo @echo off>"WAYFINDER-LOCAL-SETTINGS.cmd"
if defined AI_ENDPOINT echo set "WAYFINDER_AI_ENDPOINT=%AI_ENDPOINT%">>"WAYFINDER-LOCAL-SETTINGS.cmd"
if defined AI_MODEL echo set "WAYFINDER_AI_MODEL=%AI_MODEL%">>"WAYFINDER-LOCAL-SETTINGS.cmd"
if defined REFERENCE_ENDPOINT echo set "WAYFINDER_REFERENCE_ENDPOINT=%REFERENCE_ENDPOINT%">>"WAYFINDER-LOCAL-SETTINGS.cmd"
if defined MAPQUEST_KEY echo set "WAYFINDER_MAPQUEST_KEY=%MAPQUEST_KEY%">>"WAYFINDER-LOCAL-SETTINGS.cmd"
if defined PBF_ROOT echo set "WAYFINDER_PBF_ROOT=%PBF_ROOT%">>"WAYFINDER-LOCAL-SETTINGS.cmd"

echo.
echo Settings saved locally to WAYFINDER-LOCAL-SETTINGS.cmd.
echo Run WAYFINDER.cmd next.
pause
