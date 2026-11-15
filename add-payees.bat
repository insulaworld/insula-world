@echo off
title Insula World - add the newer animals as bond payees
cd /d "%~dp0"
echo.
echo  INSULA WORLD - add newer animals (like Gus) as IslandBonds payees
echo  -----------------------------------------------------------------
echo  Deploy the watchdog update FIRST, or queueing a payee closes Open Borders.
echo  Your private key is typed at a hidden prompt and never leaves this computer.
echo.
call node scripts\add-payees.mjs %*
if errorlevel 1 ( echo. & echo Stopped. Nothing was sent. & pause & exit /b 1 )
if /i "%1"=="--activate" ( pause & exit /b 0 )
echo.
set /p GO=Queue the missing animals now? Type YES to send: 
if /i not "%GO%"=="YES" ( echo Nothing sent. & pause & exit /b 0 )
call node scripts\add-payees.mjs --go
echo.
pause
