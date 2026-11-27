@echo off
title Insula World - make a Fly deploy token
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
echo.
echo  Makes an Insula-only Fly deploy token and saves it in this folder (.fly-token).
echo  After this, deploy-fly.bat and restart-fly.bat work whichever Fly account you are signed into.
echo  Run this ONCE, while signed into the Fly account that owns insula-world.
echo.
flyctl auth logout >nul 2>nul
flyctl auth login
flyctl tokens create deploy -a insula-world -x 8760h > .fly-token
if errorlevel 1 ( del .fly-token 2^>nul & echo. & echo Could not make the token. Are you signed into the account that owns insula-world? & pause & exit /b 1 )
echo.
echo Saved. Never share or commit .fly-token. It lasts one year.
pause
