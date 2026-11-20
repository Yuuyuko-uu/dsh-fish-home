@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-fish-home.ps1" %*
set "UPDATE_EXIT=%ERRORLEVEL%"
pause
exit /b %UPDATE_EXIT%
