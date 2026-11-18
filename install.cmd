@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -UsePrebuilt -SkipTests
if errorlevel 1 goto failed
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\CodexQuotaGuard\app\scripts\start-monitor.ps1"
if errorlevel 1 goto failed
exit /b 0

:failed
echo Codex Quota Guard setup failed. See the error above.
pause
exit /b 1
