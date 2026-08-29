@echo off
rem Start (or restart) the fpvsim static server on the Windows desktop.
rem
rem Python, not Node: the box has no Node and does not need one. Every byte of
rem computation happens in the visitor's browser; this only hands over four
rem static files.
setlocal
set ROOT=%~dp0
set PORT=5180
rem Bind address. 0.0.0.0 so the box is reachable from the LAN, which is how you
rem test with a phone or another machine before any tunnel exists. Pass 127.0.0.1
rem as the first argument to go back to localhost-only.
set HOST=%1
if "%HOST%"=="" set HOST=0.0.0.0

rem Stop whatever is already on the port, so a redeploy does not end up with two
rem servers and the old build winning.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr :%PORT% ') do taskkill /F /PID %%p >nul 2>&1

rem Start detached via PowerShell. `start /b` from an SSH session dies with the
rem session; Start-Process does not.
powershell -NoProfile -Command ^
  "Start-Process -FilePath 'python' -ArgumentList '%ROOT%serve.py','--port','%PORT%','--host','%HOST%','--root','%ROOT%dist' -WindowStyle Hidden -RedirectStandardError '%ROOT%server.log' -RedirectStandardOutput '%ROOT%server.out'"

echo started fpvsim on %HOST%:%PORT%
