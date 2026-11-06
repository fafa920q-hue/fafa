@echo off
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0infra\scripts\start-windows.ps1"
set "FAFA_START_EXIT=%ERRORLEVEL%"
pause
exit /b %FAFA_START_EXIT%
