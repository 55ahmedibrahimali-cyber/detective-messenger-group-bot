@echo off
chcp 65001 >nul
title متصفح السيرفر المباشر (13.48.58.210)
color 0A

echo ===================================================================
echo     جاري تشغيل نفق البروكسي الآمن إلى سيرفر AWS (13.48.58.210)...
echo ===================================================================

:: تشغيل نفق SSH للمنفذ 8888 في الخلفية
tasklist /fi "imagename eq ssh.exe" | findstr /i "ssh.exe" >nul
if errorlevel 1 (
    start /min "" ssh -i "%USERPROFILE%\Downloads\detective-bot-ec2.pem" -L 8888:127.0.0.1:8888 -N -C -o StrictHostKeyChecking=no -o ServerAliveInterval=30 ubuntu@13.48.58.210
    timeout /t 3 /nobreak >nul
)

echo.
echo ===================================================================
echo     جاري فتح Google Chrome عبر بروكسي السيرفر...
echo     IP المتصفح الآن هو: 13.48.58.210 (نفس سيرفر البوت تماماً)
echo ===================================================================

set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME_PATH% (
    set CHROME_PATH="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

start "" %CHROME_PATH% --user-data-dir="%USERPROFILE%\bot-fb-profile" --proxy-server="http://127.0.0.1:8888" https://whatismyipaddress.com https://www.facebook.com

echo.
echo تم فتح المتصفح بنجاح! يمكنك الآن تسجيل الدخول لحساب البوت.
timeout /t 5 >nul
exit
