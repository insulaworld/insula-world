@echo off
title Insula World - deploy the Open Borders bond contract
cd /d "%~dp0"
echo.
echo  INSULA WORLD - IslandBonds (Open Borders residency bonds) on Robinhood Chain
echo  ---------------------------------------------------------------------------
echo  Your private key is typed at a hidden prompt and never leaves this computer.
echo  First a dry run (nothing is deployed), then you choose whether to deploy.
echo.
call node scripts\deploy-bonds.mjs
if errorlevel 1 ( echo. & echo Dry run stopped. Nothing was deployed. & pause & exit /b 1 )
echo.
set /p GO=Deploy for real now? Type YES to deploy: 
if /i not "%GO%"=="YES" ( echo Nothing deployed. & pause & exit /b 0 )
call node scripts\deploy-bonds.mjs --go
echo.
pause
