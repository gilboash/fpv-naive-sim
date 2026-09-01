@echo off
rem Start (or restart) the fpvsim servers on the Windows desktop.
rem
rem Python, not Node: the box has no Node and does not need one. Every byte of
rem flight computation happens in the visitor's browser; these only hand over
rem static files and keep a log of who flew.
setlocal
set ROOT=%~dp0
set PORT=5180
set ADMINPORT=5181
rem Bind address. 0.0.0.0 so the box is reachable from the LAN, which is how you
rem test with a phone or another machine before any tunnel exists. Pass 127.0.0.1
rem as the first argument to go back to localhost-only.
set HOST=%1
if "%HOST%"=="" set HOST=0.0.0.0

if not exist "%ROOT%data" mkdir "%ROOT%data"

rem Stop whatever is already on either port, so a redeploy does not end up with
rem two servers and the old build winning.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr :%PORT% ') do taskkill /F /PID %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr :%ADMINPORT% ') do taskkill /F /PID %%p >nul 2>&1

rem Start detached via PowerShell. `start /b` from an SSH session dies with the
rem session; Start-Process does not.
powershell -NoProfile -Command ^
  "Start-Process -FilePath 'python' -ArgumentList '%ROOT%serve.py','--port','%PORT%','--host','%HOST%','--root','%ROOT%dist','--data','%ROOT%data' -WindowStyle Hidden -RedirectStandardError '%ROOT%server.log' -RedirectStandardOutput '%ROOT%server.out'"

rem The usage view, on the same bind address as the page. The Cloudflare tunnel
rem forwards 5180 and only 5180, so this port has no route from the internet
rem whatever it binds — which is the entire protection, since the page has no
rem password. On 0.0.0.0 it is readable by anything on the house network; pass
rem 127.0.0.1 as this script's argument to put it back to the box alone and
rem reach it with  ssh -L 5181:127.0.0.1:5181 <this box>
powershell -NoProfile -Command ^
  "Start-Process -FilePath 'python' -ArgumentList '%ROOT%admin.py','--port','%ADMINPORT%','--host','%HOST%','--data','%ROOT%data' -WindowStyle Hidden -RedirectStandardError '%ROOT%admin.log' -RedirectStandardOutput '%ROOT%admin.out'"

echo started fpvsim on %HOST%:%PORT%, usage view on %HOST%:%ADMINPORT%
