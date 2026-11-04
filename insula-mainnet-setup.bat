@echo off
setlocal EnableDelayedExpansion
title Insula World - mainnet setup (launch day)
cd /d "%~dp0"
echo.
echo  INSULA WORLD - MAINNET SETUP (launch day)
echo  -----------------------------------------
echo  Makes fresh mainnet wallets for the bank and the agents, reads your coin,
echo  and gives the founders their starting coins from the bank.
echo  Your devnet wallets are moved to .keys-devnet, not deleted.
echo.
where node >nul 2>nul
if errorlevel 1 ( echo Node.js is missing. Run insula-test.bat once first. & pause & exit /b 1 )
if not exist node_modules ( call npm install )

findstr /b "INSULA_MINT=" .env >nul 2>nul
if errorlevel 1 (
  echo Paste your coin's mint address ^(the contract address on the pump.fun page^), then press Enter:
  set /p MINT=^> 
  echo INSULA_MINT=!MINT!>> .env
)
findstr /b "MAINNET_RPC_URL=" .env >nul 2>nul
if errorlevel 1 (
  echo.
  echo Paste your Helius mainnet RPC URL ^(https://mainnet.helius-rpc.com/?api-key=...^), or just press Enter to skip:
  set "RPC="
  set /p RPC=^> 
  if not "!RPC!"=="" echo MAINNET_RPC_URL=!RPC!>> .env
)
echo.
call npm run setup:mainnet
echo.
echo If it asked you to fund the bank: send the SOL and coins from your wallet, then run this file again.
echo When it says "Mainnet setup done", run deploy-fly.bat.
pause
