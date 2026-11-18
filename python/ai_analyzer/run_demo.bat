@echo off
chcp 65001 >nul
title AI Detective Game Analyzer Demo
cd /d "C:\Users\moham\Downloads\detective-bot-merged\proj\python\ai_analyzer"

set PYTHON_EXE=C:\Users\moham\python311\python.exe
if not exist "%PYTHON_EXE%" set PYTHON_EXE=python

echo ==================================================
echo   AI Detective Game Analyzer Demo
echo ==================================================
echo.

"%PYTHON_EXE%" demo_analysis.py
echo.
pause
