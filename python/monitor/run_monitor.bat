@echo off
chcp 65001 >nul
title Detective Bot - Server Monitor
cd /d "C:\Users\moham\Downloads\detective-bot-merged\proj\python\monitor"

set PYTHON_EXE=C:\Users\moham\python311\python.exe
if not exist "%PYTHON_EXE%" set PYTHON_EXE=python

echo ==================================================
echo   Detective Bot Server Monitor
echo ==================================================
echo.

"%PYTHON_EXE%" monitor.py
pause
