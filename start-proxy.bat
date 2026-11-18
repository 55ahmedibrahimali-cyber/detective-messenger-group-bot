@echo off
chcp 65001 >nul
title بروكسي السيرفر (AWS EC2)
color 0A

echo ===================================================================
echo     جاري تجهيز الصلاحيات والاتصال بسيرفر AWS...
echo ===================================================================
echo.

set KEY_PATH="%USERPROFILE%\Downloads\detective-bot-ec2.pem"

if not exist %KEY_PATH% (
    color 0C
    echo [خطأ] لم يتم العثور على ملف المفتاح: %KEY_PATH%
    echo تأكد من وجود ملف detective-bot-ec2.pem في مجلد Downloads.
    pause
    exit /b
)

:: إصلاح صلاحيات المفتاح في ويندوز (مهم جداً لـ OpenSSH)
icacls %KEY_PATH% /reset >nul 2>&1
icacls %KEY_PATH% /grant:r "%USERNAME%:(R)" >nul 2>&1
icacls %KEY_PATH% /inheritance:r >nul 2>&1

set /p SERVER_IP="أدخل IP السيرفر (اضغط Enter لاستخدام 13.48.58.210): "
if "%SERVER_IP%"=="" set SERVER_IP=13.48.58.210

echo.
echo ===================================================================
echo  جاري تشغيل البروكسي على: %SERVER_IP% ...
echo  المنفذ المحلي: SOCKS5 127.0.0.1:1080
echo  [تنبيه]: اترك هذه النافذة مفتوحة طوال فترة تصفح الحساب.
echo ===================================================================
echo.

ssh -i %KEY_PATH% -D 1080 -N -C -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=30 -v ubuntu@%SERVER_IP%

echo.
color 0C
echo ===================================================================
echo  توقف الاتصال بالسيرفر!
echo  انظر السطور الإنجليزية أعلاه لمعرفة سبب الرفض:
echo  1- هل الـ IP صحيح والسيرفر شغال (Running في لوحة AWS)؟
echo  2- هل المنفذ 22 (SSH) مفتوح في Security Group على AWS؟
echo ===================================================================
pause
