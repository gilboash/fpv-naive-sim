@echo off
rem Start (or restart) the fpvsim static server on the Windows desktop.
rem
rem Python, not Node: the box has no Node and does not need one. Every byte of
rem computation happens in the visitor's browser; this only hands over four
rem static files.
setlocal
set ROOT=%~dp0
set PORT=5180

rem Stop whatever is already on the port, so a redeploy does not end up with two
rem servers and the old build winning.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr :%PORT% ') do taskkill /F /PID %%p >nul 2>&1

rem Start detached via PowerShell. `start /b` from an SSH session dies with the
rem session; Start-Process does not.
powershell -NoProfile -Command ^
  "Start-Process -FilePath 'python' -ArgumentList '%ROOT%serve.py','--port','%PORT%','--root','%ROOT%dist' -WindowStyle Hidden -RedirectStandardError '%ROOT%server.log' -RedirectStandardOutput '%ROOT%server.out'"

echo started fpvsim on http://127.0.0.1:%PORT%/
