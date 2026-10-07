@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ASAR="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start BitsBytesChat.ps1"
set "BITSBYTES_RESULT=%ERRORLEVEL%"
if not "%BITSBYTES_RESULT%"=="0" pause
exit /b %BITSBYTES_RESULT%
