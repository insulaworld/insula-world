@echo off
setlocal EnableDelayedExpansion
title Insula World - Robinhood Chain setup (launch day)
cd /d "%~dp0"
echo.
echo  INSULA WORLD - ROBINHOOD CHAIN SETUP (launch day)
echo  -------------------------------------------------
echo  Makes fresh wallets for the bank and the agents, reads your Pons token,
echo  and gives the founders their starting coins from the bank.
echo  Your earlier wallets (Solana) are moved to a .keys-... folder, not deleted.
echo.
where node >nul 2>nul
if errorlevel 1 ( echo Node.js is missing. Run insula-test.bat once first. & pause & exit /b 1 )
call npm install --no-audit --no-fund >nul 2>nul

findstr /b "INSULA_TOKEN=" .env >nul 2>nul
if errorlevel 1 (
  echo Paste your token's contract address ^(0x... from the Pons page^), then press Enter:
  set /p TOKEN=^> 
  echo INSULA_TOKEN=!TOKEN!>> .env
)
findstr /b "INSULA_BUY_URL=" .env >nul 2>nul
if errorlevel 1 (
  echo.
  echo Paste the link to your token's page on Pons ^(for the site's BUY button^), then press Enter:
  set /p BUY=^> 
  if not "!BUY!"=="" echo INSULA_BUY_URL=!BUY!>> .env
)
echo.
call npm run setup:robinhood
echo.
echo If it asked you to fund the bank: send the ETH and tokens on Robinhood Chain, then run this file again.
echo When it says "Robinhood Chain setup done", run deploy-fly.bat.
pause
