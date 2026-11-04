@echo off
title Insula World - 30-day fast-forward AI test
cd /d "%~dp0"
echo.
echo  INSULA WORLD - fast-forward test: 30 island days in about 30 minutes
echo  -------------------------------------------------------------------
echo  All agents on AI brains, test money only (your devnet wallets aren't touched).
echo  It saves to data\fast.json and never touches your real world save.
echo.
findstr /r /c:"^ANTHROPIC_API_KEY=..*" .env >nul 2>nul
if errorlevel 1 ( echo No API key in .env - run insula-test.bat first. & pause & exit /b 1 )
echo Opening http://localhost:3000 in a few seconds. Leave this window open for about 35 minutes.
echo When Day 30 fireworks go off, press Ctrl+C to stop.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:3000"
call npm run fast
pause
