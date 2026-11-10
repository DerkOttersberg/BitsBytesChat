@echo off
cd /d "%~dp0transcription"
if exist "release\win-unpacked\BitsBytes Transcription.exe" (
  start "" "release\win-unpacked\BitsBytes Transcription.exe"
  exit /b
)
call npm start
if errorlevel 1 pause
