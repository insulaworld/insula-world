@echo off
title Insula World - check insulaworld.com
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
set /p APP=<.flyapp
flyctl certs check insulaworld.com -a %APP%
echo.
flyctl certs check www.insulaworld.com -a %APP%
echo.
echo If both say Ready / Issued, open https://insulaworld.com
pause
