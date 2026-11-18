@echo off
chcp 65001 >nul
title Detective Bot Dashboard
cd /d "C:\Users\moham\Downloads\detective-bot-merged\proj\python\dashboard"

set PYTHON_EXE=C:\Users\moham\python311\python.exe
if not exist "%PYTHON_EXE%" set PYTHON_EXE=python

echo =======================================================
echo   تشغيل لوحة تحكم بوت المحقق (Detective Bot Dashboard)
echo =======================================================
echo.
echo [*] جارٍ فتح المتصفح على: http://localhost:5000 ...
start "" "http://localhost:5000"

echo [*] تشغيل الخادم...
"%PYTHON_EXE%" app.py
pause
