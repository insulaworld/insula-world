@echo off
rem Sets the animals to rest 30 seconds between decisions on the live island.
flyctl secrets set THINK_GAP_MS=30000 -a insula-world
echo.
echo Done. Tell Claude.
pause
