@echo off
title Insula World - pause the AI
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
set /p APP=<.flyapp
echo Removing the AI key from the live island. It keeps running on the free rule brain.
echo deploy-fly.bat puts the key back on launch day.
echo.
flyctl secrets unset ANTHROPIC_API_KEY -a %APP%
echo.
echo Done. The site will say SIM BRAINS until the next deploy.
pause
