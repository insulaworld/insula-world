@echo off
title Insula World - Robinhood testnet rehearsal
cd /d "%~dp0"
echo.
echo  INSULA WORLD - LAUNCH REHEARSAL ON ROBINHOOD TESTNET
echo  ----------------------------------------------------
echo  Runs the whole launch on testnet in a throwaway copy: your real wallets are never touched.
echo  Takes about 6 minutes once the rehearsal wallet has testnet ETH.
echo.
call npm install --no-audit --no-fund >nul 2>nul
node test/rehearse-robinhood.mjs
echo.
echo  The result is saved in rehearsal-result.txt. Tell Claude when it's done.
pause
