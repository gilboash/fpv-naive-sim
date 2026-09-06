#!/bin/bash
# Deploy fpvsim to the Windows desktop.
#
# The Mac builds; the Windows box only serves. It has no Node and needs none —
# the whole application is a handful of static files and all the computation happens
# the visitor's browser, so a stdlib Python server is the entire runtime.
#
#   SSHPASS=<win password> ./deploy-windows.sh
set -euo pipefail

WIN_USER="${WIN_USER:-gilboash@hotmail.com}"
WIN_HOST="${WIN_HOST:-192.168.7.54}"
WIN_DEST_BS='C:\Users\gilbo\fpvsim'
WIN_DEST_FS='C:/Users/gilbo'
# scp of a directory into a non-existent destination puts the *contents* there
# rather than nesting, so the staging root is the destination itself.
WIN_STAGE_BS='C:\Users\gilbo\_staging_fpvsim'
T="${WIN_USER}@${WIN_HOST}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${SSHPASS:-}" ]; then SSH="sshpass -e ssh"; SCP="sshpass -e scp"; else SSH="ssh"; SCP="scp"; fi
OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

echo "[1/4] building"
npm run build --silent 2>&1 | tail -1

echo "[2/4] staging"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/fpvsim"
cp -R "$HERE/dist" "$STAGE/fpvsim/dist"
cp "$HERE/tools/serve.py" "$STAGE/fpvsim/serve.py"
cp "$HERE/tools/admin.py" "$STAGE/fpvsim/admin.py"
cp "$HERE/tools/win/start-fpvsim.bat" "$STAGE/fpvsim/start-fpvsim.bat"
# The container. start-fpvsim.bat stays beside it as the way back to bare
# processes if Docker is ever the problem rather than the fix.
cp "$HERE/Dockerfile" "$STAGE/fpvsim/Dockerfile"
cp "$HERE/.dockerignore" "$STAGE/fpvsim/.dockerignore"
cp "$HERE/tools/win/docker-fpvsim.bat" "$STAGE/fpvsim/docker-fpvsim.bat"
# Reference-lap videos, if any have been generated. Served on demand from
# beside dist rather than bundled into it — a pilot who never presses play
# never fetches one.
if [ -d "$HERE/reference" ]; then
  cp -R "$HERE/reference" "$STAGE/fpvsim/reference"
  echo "      including $(ls -1 "$HERE/reference" | wc -l | tr -d ' ') reference video(s), $(du -sh "$HERE/reference" | cut -f1)"
fi

echo "[3/4] syncing to $T"
# Clear the staging directory first. scp -r of a directory nests it when the
# destination exists and unpacks it when it does not, so leaving the previous
# run's directory behind changes the layout of the next one — which is how a
# stray C:\Users\gilbo\fpvsim\fpvsim appeared on the first deploy.
$SSH "${OPTS[@]}" "$T" "rmdir /s /q C:\Users\gilbo\_staging_fpvsim" >/dev/null 2>&1 || true
$SCP "${OPTS[@]}" -r "$STAGE/fpvsim" "$T:$WIN_DEST_FS/_staging_fpvsim" >/dev/null
# /MIR so the content-hashed assets of a previous build are removed rather than
# accumulating.
#
# /XD data is load-bearing since the box started collecting usage summaries.
# The box now DOES hold state for this app, and a mirror deletes anything not
# present in the source — so without this line every deploy would silently erase
# the collected data. This is the genius-invester trap, and it is only safe here
# because the exclusion is explicit.
$SSH "${OPTS[@]}" "$T" "robocopy $WIN_STAGE_BS $WIN_DEST_BS /MIR /NFL /NDL /NJH /NJS /NP /XF server.log server.out admin.log admin.out /XD $WIN_DEST_BS\\data & if errorlevel 8 (exit /b 1) else (exit /b 0)"
$SSH "${OPTS[@]}" "$T" "rmdir /s /q C:\\Users\\gilbo\\_staging_fpvsim" >/dev/null 2>&1 || true
rm -rf "$STAGE"

echo "[4/4] rebuilding and restarting the containers"
# This call returns, and that is the difference. The old bat detached its
# servers with Start-Process and they held the SSH channel open behind them, so
# the deploy hung *having already succeeded* — it had to be backgrounded and
# killed after eight seconds. `docker run -d` detaches at the daemon, so the
# session closes on its own and the exit code is worth reading.
#
# Safe over SSH only because the base image is already on the box: a build that
# pulled from a registry would need Docker Desktop's credential helper, which
# needs an interactive logon session and does not have one here.
if ! $SSH "${OPTS[@]}" "$T" "$WIN_DEST_BS\\docker-fpvsim.bat" 2>&1 | tr -d '\r'; then
  echo "      container start failed — the collection in data\\ is untouched, it is a mount"
  exit 1
fi
echo "      verifying"
$SSH "${OPTS[@]}" "$T" "curl.exe -s -m 5 -o NUL -w \"      HTTP %{http_code}, %{size_download} bytes\n\" http://127.0.0.1:5180/" 2>&1 | tr -d '\r'
# The admin view answers only on localhost, which is why it needs checking from
# the box rather than from here: a deploy that leaves it down is invisible
# otherwise, since nothing a pilot does touches it.
$SSH "${OPTS[@]}" "$T" "curl.exe -s -m 5 -o NUL -w \"      admin HTTP %{http_code}\n\" http://127.0.0.1:5181/" 2>&1 | tr -d '\r'
echo
echo "      usage view: http://${WIN_HOST}:5181/ from the LAN, or"
echo "                  ssh -L 5181:127.0.0.1:5181 $T   then http://127.0.0.1:5181/"
