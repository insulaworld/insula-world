@echo off
title Insula World - stop the website
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
set /p APP=<.flyapp
echo Stopping the live island (%APP%). The save disk is kept.
echo deploy-fly.bat brings it back on launch night.
echo.
flyctl scale count 0 -a %APP% --yes
echo.
flyctl status -a %APP%
echo.
echo Done. insulaworld.com is offline until you run deploy-fly.bat.
pause
