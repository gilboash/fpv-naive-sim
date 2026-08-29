#!/bin/bash
# Deploy fpvsim to the Windows desktop.
#
# The Mac builds; the Windows box only serves. It has no Node and needs none —
# the whole application is four static files and all the computation happens in
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
cp "$HERE/tools/win/start-fpvsim.bat" "$STAGE/fpvsim/start-fpvsim.bat"

echo "[3/4] syncing to $T"
# Clear the staging directory first. scp -r of a directory nests it when the
# destination exists and unpacks it when it does not, so leaving the previous
# run's directory behind changes the layout of the next one — which is how a
# stray C:\Users\gilbo\fpvsim\fpvsim appeared on the first deploy.
$SSH "${OPTS[@]}" "$T" "rmdir /s /q C:\Users\gilbo\_staging_fpvsim" >/dev/null 2>&1 || true
$SCP "${OPTS[@]}" -r "$STAGE/fpvsim" "$T:$WIN_DEST_FS/_staging_fpvsim" >/dev/null
# /MIR so the content-hashed assets of a previous build are removed rather than
# accumulating. Nothing here is user data — the box holds no state for this app
# at all — so mirroring is safe in a way it explicitly is not for genius-invester.
$SSH "${OPTS[@]}" "$T" "robocopy $WIN_STAGE_BS $WIN_DEST_BS /MIR /NFL /NDL /NJH /NJS /NP /XF server.log server.out & if errorlevel 8 (exit /b 1) else (exit /b 0)"
$SSH "${OPTS[@]}" "$T" "rmdir /s /q C:\\Users\\gilbo\\_staging_fpvsim" >/dev/null 2>&1 || true
rm -rf "$STAGE"

echo "[4/4] restarting the server"
$SSH "${OPTS[@]}" "$T" "$WIN_DEST_BS\\start-fpvsim.bat"
sleep 2
echo "      verifying"
$SSH "${OPTS[@]}" "$T" "curl.exe -s -m 5 -o NUL -w \"      HTTP %{http_code}, %{size_download} bytes\n\" http://127.0.0.1:5180/" 2>&1 | tr -d '\r'
