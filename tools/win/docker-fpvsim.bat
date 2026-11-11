@echo off
rem ===================================================================
rem  fpvsim : build the image and (re)start the two containers.
rem
rem  Runs from the folder it lives in (the Optiplex: C:\services\fpvsim),
rem  so it needs no path edited when the app moves. It is safe over SSH:
rem  the base image is alpine and already on the box, so nothing is pulled
rem  from a registry and Docker Desktop's credential helper, which needs an
rem  interactive logon session, is never involved.
rem
rem  It only ever touches things named fpvsim. The other containers on the
rem  box (naco-portal, genius-invester) are never referenced.
rem ===================================================================
setlocal
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "DATA=%APP%\data"
set "REFERENCE=%APP%\reference"
set PORT=5180
set ADMINPORT=5181

rem Publish address for the page. 0.0.0.0 so both the LAN and the Cloudflare
rem tunnel reach it: the tunnel connects to 127.0.0.1 on this box.
set BIND=0.0.0.0

rem Publish address for the usage view. THIS IS THE ACCESS CONTROL: the page has
rem no password, and inside the container admin.py binds 0.0.0.0 regardless, so
rem the line below is the only thing deciding who can read the collected data.
rem   0.0.0.0     the house network too (current)
rem   127.0.0.1   this box alone; reach it with ssh -L 5181:127.0.0.1:5181
rem The Cloudflare tunnel forwards 5180 and only 5180, so this port has no route
rem from the internet whichever of the two it is.
set ADMIN_BIND=0.0.0.0

if not exist "%DATA%" mkdir "%DATA%"
rem Always present so the mount never has to be conditional. Normally empty.
if not exist "%REFERENCE%" mkdir "%REFERENCE%"

echo [1/5] stopping any bare python servers from the pre-container era
rem Matched on the command line rather than on who owns the port. Once the
rem containers are up the port is held by Docker's proxy, and killing the owner
rem of port 5180 would then take down the thing this script just started.
powershell -NoProfile -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*fpvsim*serve.py*' -or $_.CommandLine -like '*fpvsim*admin.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo [2/5] building the image (the previous one is kept as fpvsim:prev, to roll back to)
cd /d "%APP%"
docker tag fpvsim:latest fpvsim:prev >nul 2>&1
docker build -t fpvsim:latest . || goto :failed

echo [3/5] replacing any previous containers
docker rm -f fpvsim fpvsim-admin >nul 2>&1

echo [4/5] starting
rem --restart unless-stopped is the entire point: it comes back by itself after
rem a reboot, which the python launcher never did.
docker run -d ^
  --name fpvsim ^
  --restart unless-stopped ^
  -p %BIND%:%PORT%:5180 ^
  -v "%DATA%:/data" ^
  -v "%REFERENCE%:/app/reference:ro" ^
  fpvsim:latest || goto :failed

rem The usage view, from the same image with a different command. Its data mount
rem is READ-ONLY: the page only ever reads sessions.jsonl, and making that
rem structural means a bug in the reader cannot corrupt the collection. The
rem writer is the other container.
rem
rem The healthcheck has to be overridden, not inherited. The image's own probes
rem port 5180, which is right for the page and wrong here: this container
rem listens on 5181, so the baked-in check failed three times and settled on
rem "unhealthy" while the admin page was answering perfectly well.
docker run -d ^
  --name fpvsim-admin ^
  --restart unless-stopped ^
  -p %ADMIN_BIND%:%ADMINPORT%:5181 ^
  -v "%DATA%:/data:ro" ^
  --health-cmd "wget -q -O /dev/null http://127.0.0.1:5181/ || exit 1" ^
  --health-interval 30s --health-timeout 5s --health-start-period 10s --health-retries 3 ^
  fpvsim:latest ^
  python3 /app/admin.py --port 5181 --host 0.0.0.0 --data /data || goto :failed

echo [5/5] waiting for them to answer
rem Start-Sleep, not `timeout`: timeout.exe reads the console and over an SSH
rem session there is none, so it returns immediately and leaves the checks
rem below racing the containers they are meant to be waiting for.
powershell -NoProfile -Command "Start-Sleep -Seconds 6"
curl.exe -s -m 5 -o NUL -w "      page  HTTP %%{http_code}, %%{size_download} bytes\n" http://127.0.0.1:%PORT%/
curl.exe -s -m 5 -o NUL -w "      admin HTTP %%{http_code}\n" http://127.0.0.1:%ADMINPORT%/
docker ps --filter name=fpvsim --format "      {{.Names}}  {{.Status}}  {{.Ports}}"
exit /b 0

:failed
echo.
echo FAILED - see the output above. The collection in %DATA% is untouched:
echo it is a mount, so nothing this script does can rewrite it.
echo   docker logs fpvsim
echo   docker logs fpvsim-admin
echo   roll back: docker tag fpvsim:prev fpvsim:latest, then run this script's docker run lines
exit /b 1
