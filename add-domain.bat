@echo off
setlocal EnableDelayedExpansion
title Insula World - connect insulaworld.com
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
set /p APP=<.flyapp
set DOMAIN=insulaworld.com
echo.
echo  Connecting %DOMAIN% and www.%DOMAIN% to the Fly app !APP!
echo  ------------------------------------------------------------
echo.
flyctl ips list -a !APP!
echo.
flyctl certs add %DOMAIN% -a !APP!
echo.
flyctl certs add www.%DOMAIN% -a !APP!
echo.
echo  Screenshot this whole window and send it to Claude.
echo  It shows the DNS records to paste into Porkbun.
pause
