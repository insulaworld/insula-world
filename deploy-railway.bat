@echo off
title Insula World - deploy to Railway
cd /d "%~dp0"
echo.
echo  INSULA WORLD - deploy to Railway (see HOSTING.md)
echo  ------------------------------------------------
echo.
call npm run secrets
if errorlevel 1 ( pause & exit /b 1 )

where railway >nul 2>nul
if errorlevel 1 (
  echo Installing the Railway command line tool...
  call npm install -g @railway/cli
)
echo.
echo Signing in to Railway (your browser will open)...
call railway whoami >nul 2>nul || call railway login
echo.
call railway status >nul 2>nul || (
  echo Creating the Railway project. Pick any name when asked.
  call railway init
)
echo.
echo Uploading the code (your .env, wallets and save file stay on this PC)...
call railway up -d
echo.
echo Done uploading. Now finish step 3 in HOSTING.md in the dashboard:
echo   1. Variables - Raw Editor: paste your .env lines and the line from deploy-secrets.txt
echo   2. Add a volume with mount path /app/data
echo   3. Settings - Networking - Generate Domain
call railway open
pause
