@echo off
setlocal
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron is missing. Run npm install, then try again.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."

