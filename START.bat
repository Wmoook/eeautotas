@echo off
title EE Auto TAS
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  EE Auto TAS needs Node.js (free^). Opening the download page...
  echo  Install the LTS version, then double-click START.bat again.
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)
echo.
echo  EE Auto TAS is starting - your browser will open.
echo  Keep this window open while it optimizes. Close it to stop (it resumes next time).
echo.
node src\server.js --open
pause
