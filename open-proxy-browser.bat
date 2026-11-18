@echo off
title متصفح البوت بالبروكسي
echo ========================================================
echo   جاري فتح متصفح Chrome مخصص ومربوط ببروكسي السيرفر...
echo ========================================================
echo.

set CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME_PATH% (
    set CHROME_PATH="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
)

start "" %CHROME_PATH% --user-data-dir="%USERPROFILE%\bot-fb-profile" --proxy-server="socks5://127.0.0.1:1080" https://whatismyipaddress.com https://www.facebook.com
exit
