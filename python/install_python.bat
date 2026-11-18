@echo off
chcp 65001 >nul
title تثبيت بايثون تلقائياً
echo ==================================================
echo   تثبيت لغة Python على جهازك تلقائياً
echo ==================================================
echo.

echo جارٍ التحقق من تثبيت Python...
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Python مثبت بالفعل على جهازك!
    python --version
    pause
    exit /b 0
)

echo جارٍ تحميل وتثبيت Python 3.11 عبر winget...
winget install -e --id Python.Python.3.11 --accept-source-agreements --accept-package-agreements

echo.
echo يرجى إغلاق هذه النافذة وإعادة فتحها لتحديث المسارات (PATH).
pause
