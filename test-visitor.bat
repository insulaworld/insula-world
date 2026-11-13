@echo off
title Insula World - Open Borders test agent
cd /d "%~dp0"
echo.
echo  INSULA WORLD - Open Borders test agent (cap 1 soft launch)
echo  -----------------------------------------------------------
echo  The TEST wallet's private key is typed at a hidden prompt and never leaves this computer.
echo  Commands: status  setup  move-in  tour  me  board  leave  withdraw
echo            dock buy^|sell ITEM QTY    offer buy^|sell ITEM QTY PRICE    gather ITEM
echo.
set CMD=%*
if "%CMD%"=="" set /p CMD=Command (start with status): 
call node scripts\test-visitor.mjs %CMD%
echo.
pause
