@echo off
setlocal EnableDelayedExpansion
title Insula World - deploy to Fly.io
cd /d "%~dp0"
echo.
echo  INSULA WORLD - deploy to Fly.io (see HOSTING.md)
echo  ------------------------------------------------
echo.

rem 1. Fly's command line tool
set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
where flyctl >nul 2>nul
if errorlevel 1 (
  echo Installing the Fly.io command line tool...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://fly.io/install.ps1 -useb | iex"
  set "PATH=%USERPROFILE%\.fly\bin;%PATH%"
)
where flyctl >nul 2>nul
if errorlevel 1 ( echo Could not install flyctl. See https://fly.io/docs/flyctl/install/ & pause & exit /b 1 )

rem 2. Sign in (opens your browser)
flyctl auth whoami >nul 2>nul
if errorlevel 1 (
  echo.
  echo Your browser will open to sign in to Fly.io. Come back here when it says you're signed in.
  flyctl auth login
)

rem 3. Pack the wallets and settings into Fly secrets (never uploaded as files)
call npm run secrets
if errorlevel 1 ( pause & exit /b 1 )
(for /f "usebackq eol=# tokens=*" %%L in (".env") do echo %%L) > fly-secrets.txt
type deploy-secrets.txt >> fly-secrets.txt

rem 4. Create the app (first time only). Fly names are global, so try a few.
set APP=
if exist .flyapp ( set /p APP=<.flyapp )
if "!APP!"=="" (
  for %%N in (insula-world insula-island insulaworld-sol insula-agents) do (
    if "!APP!"=="" (
      flyctl apps create %%N >nul 2>nul && set APP=%%N
    )
  )
  if "!APP!"=="" ( echo Could not create an app name. Run: flyctl apps create YOURNAME & pause & exit /b 1 )
  echo !APP!> .flyapp
  echo Created app !APP!
  echo Creating the 1 GB disk for the save file...
  flyctl volumes create insula_data --size 1 --region iad --yes -a !APP!
)

echo Setting secrets...
flyctl secrets import -a !APP! --stage < fly-secrets.txt
del fly-secrets.txt

echo.
echo Building and deploying (this takes a few minutes the first time)...
flyctl deploy -a !APP! --ha=false
if errorlevel 1 ( echo Deploy failed - send Claude a screenshot of this window. & pause & exit /b 1 )

echo.
echo Live at: https://!APP!.fly.dev
start "" https://!APP!.fly.dev
echo Logs: flyctl logs -a !APP!
pause
