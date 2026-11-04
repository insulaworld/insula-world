@echo off
title Insula World - multi-hour soak test on Robinhood testnet
cd /d "%~dp0"
echo.
echo  INSULA WORLD - SOAK TEST ON ROBINHOOD TESTNET
echo  ---------------------------------------------
echo  Runs the island for hours on testnet with what's left in the rehearsal wallet.
echo  Your real wallets are never touched, and it uses the free rule brain (no AI credit).
echo  Keep this window open and the PC awake. Status every 10 minutes in soak-result.txt.
echo.
set HOURS=%1
if "%HOURS%"=="" set HOURS=3
node test/soak-robinhood.mjs %HOURS%
echo.
echo  Done. Tell Claude, it can read soak-result.txt.
pause
