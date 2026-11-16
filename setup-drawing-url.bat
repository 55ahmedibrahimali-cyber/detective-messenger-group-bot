@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-drawing-url.ps1"
if errorlevel 1 (
  echo.
  echo Drawing URL setup failed.
)
echo.
pause
