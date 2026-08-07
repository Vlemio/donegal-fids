@echo off
title Donegal FIDS

:: Start the Node server in the background
start "" /min node "%~dp0server.js"

:: Wait 3 seconds for the server to come up
timeout /t 3 /nobreak >nul

:: Launch Chrome in kiosk mode (tries standard install paths)
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

start "" %CHROME% ^
  --kiosk ^
  --disable-pinch ^
  --overscroll-history-navigation=0 ^
  --noerrdialogs ^
  --disable-infobars ^
  --disable-session-crashed-bubble ^
  --disable-restore-session-state ^
  --disable-features=TranslateUI ^
  "http://localhost:8080"
