@echo off
title Insula World - devnet test
cd /d "%~dp0"
echo.
echo  INSULA WORLD - real devnet money + AI brains test
echo  ------------------------------------------------
echo.

rem 1. Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo Installing Node.js LTS. Click Yes if Windows asks for permission...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;C:\Program Files\nodejs"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js could not be installed automatically. Install the LTS version from https://nodejs.org
  echo then double-click this file again.
  pause
  exit /b 1
)
for /f %%v in ('node -v') do echo Node %%v

rem 2. Packages
if not exist node_modules (
  echo Installing packages, this takes a minute...
  call npm install --no-fund --no-audit
  if errorlevel 1 ( echo npm install failed. & pause & exit /b 1 )
)

rem 3. Settings and AI key
if not exist .env copy .env.example .env >nul
findstr /r /c:"^ANTHROPIC_API_KEY=..*" .env >nul
if errorlevel 1 (
  echo.
  echo Notepad is opening your settings. Paste your Anthropic API key right after
  echo ANTHROPIC_API_KEY=  then save with Ctrl+S and close Notepad.
  notepad .env
)
findstr /r /c:"^ANTHROPIC_API_KEY=..*" .env >nul
if errorlevel 1 echo No API key found: the agents will use rule-based brains this time.

rem 4. Devnet wallets and test token
if not exist .keys\setup-done (
  echo.
  echo Creating devnet wallets and the test token...
  call npm run setup
)
if not exist .keys\setup-done (
  echo.
  echo Setup isn't finished. Get free devnet SOL at https://faucet.solana.com for the bank
  echo address shown above, then double-click this file again.
  pause
  exit /b 1
)

rem 5. Start the world
echo.
echo Starting Insula World. Your browser will open http://localhost:3000 in a few seconds.
echo Leave this window open. Close it to stop the world (it saves automatically).
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3000"
call npm start
pause
