@echo off
title AWS Browser Proxy
echo Connecting to AWS Server Proxy (13.48.58.210)...

start /B ssh -i %USERPROFILE%\Downloads\detective-bot-ec2.pem -L 8888:127.0.0.1:8888 -N -n -o StrictHostKeyChecking=no ubuntu@13.48.58.210
ping 127.0.0.1 -n 3 >nul

echo Proxy is ready on 127.0.0.1:8888. Opening Chrome...

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

start "" %CHROME% --user-data-dir="%USERPROFILE%\bot-fb-profile" --proxy-server="http://127.0.0.1:8888" "https://whatismyipaddress.com" "https://www.facebook.com"
exit
