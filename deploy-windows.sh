#!/bin/bash
# Deploy fpvsim to the Optiplex (C:\services\fpvsim).
#
# The Mac builds; the Optiplex only serves. It has no Node and needs none: the
# whole application is a handful of static files and the computation happens in
# the visitor's browser, so a stdlib Python server in a container is the entire
# runtime. (The old Windows box at 192.168.7.54 is retired.)
#
#   ./deploy-windows.sh                  key login, as for the portal
#   WIN_HOST=... WIN_USER=... ./deploy-windows.sh      another box
#   DRY_RUN=1 ./deploy-windows.sh        stage and LIST what the mirror would
#                                        copy and delete; changes nothing live
#
# The box's SSH shell is PowerShell, so every remote command below is PowerShell
# (the old script used cmd syntax: rmdir /s /q, `if errorlevel`). Before it
# changes anything it backs up the collected data and keeps the previous build:
#   C:\services\fpvsim\backup\sessions-<time>.jsonl   the usage records
#   C:\services\fpvsim\dist.prev                      the previous dist
#   docker image fpvsim:prev                          the previous image
set -euo pipefail

WIN_USER="${WIN_USER:-DELL}"
WIN_HOST="${WIN_HOST:-192.168.7.195}"
APP_BS='C:\services\fpvsim'
STAGE_BS='C:\services\_staging_fpvsim'
STAGE_FS='C:/services/_staging_fpvsim'
CFG_BS='C:\services\_dockercfg_fpvsim'
T="${WIN_USER}@${WIN_HOST}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${SSHPASS:-}" ]; then SSH="sshpass -e ssh"; SCP="sshpass -e scp"; else SSH="ssh"; SCP="scp"; fi
OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
remote() { $SSH "${OPTS[@]}" "$T" "$1" 2>&1 | tr -d '\r'; }

echo "[1/6] building"
npm run build --silent 2>&1 | tail -1

echo "[2/6] staging"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/fpvsim"
cp -R "$HERE/dist" "$STAGE/fpvsim/dist"
cp "$HERE/tools/serve.py" "$STAGE/fpvsim/serve.py"
cp "$HERE/tools/admin.py" "$STAGE/fpvsim/admin.py"
cp "$HERE/Dockerfile" "$STAGE/fpvsim/Dockerfile"
cp "$HERE/.dockerignore" "$STAGE/fpvsim/.dockerignore"
cp "$HERE/tools/win/docker-fpvsim.bat" "$STAGE/fpvsim/docker-fpvsim.bat"
echo "      zip: $(ls "$STAGE/fpvsim/dist/downloads" | tr '\n' ' ')"
echo "      maps in it: $(unzip -Z1 "$STAGE/fpvsim/dist/downloads/NacoSim-latest.zip" | grep -c 'maps/.*\.map')"

MIRROR_FLAGS="/MIR /NFL /NDL /NJH /NJS /NP"
if [ -n "${DRY_RUN:-}" ]; then
  echo "[dry run] what the mirror would do (nothing is changed):"
  remote "Remove-Item -Recurse -Force $STAGE_BS -ErrorAction SilentlyContinue" >/dev/null || true
  $SCP "${OPTS[@]}" -r "$STAGE/fpvsim" "$T:$STAGE_FS" >/dev/null
  remote "robocopy $STAGE_BS $APP_BS /MIR /L /NJH /NJS /NP /NDL /XF server.log server.out admin.log admin.out start-fpvsim.bat /XD $APP_BS\\data $APP_BS\\reference $APP_BS\\backup $APP_BS\\dist.prev | Out-String -Width 200; exit 0"
  remote "Remove-Item -Recurse -Force $STAGE_BS -ErrorAction SilentlyContinue" >/dev/null || true
  rm -rf "$STAGE"
  echo "[dry run] done: no backup taken, nothing synced, no restart."
  exit 0
fi

echo "[3/6] backing up on the box"
remote "if (-not (Test-Path $APP_BS\\backup)) { New-Item -ItemType Directory $APP_BS\\backup | Out-Null }; \$ts = Get-Date -Format yyyyMMdd-HHmmss; Copy-Item $APP_BS\\data\\sessions.jsonl $APP_BS\\backup\\sessions-\$ts.jsonl; if (Test-Path $APP_BS\\dist.prev) { Remove-Item -Recurse -Force $APP_BS\\dist.prev }; if (Test-Path $APP_BS\\dist) { Copy-Item -Recurse $APP_BS\\dist $APP_BS\\dist.prev }; \"      sessions: \$((Get-Content $APP_BS\\data\\sessions.jsonl | Measure-Object -Line).Lines) lines, backed up as sessions-\$ts.jsonl\""

echo "[4/6] syncing to $T"
# scp -r of a directory nests it when the destination exists and unpacks it
# when it does not, so the staging directory is cleared first.
remote "Remove-Item -Recurse -Force $STAGE_BS -ErrorAction SilentlyContinue" >/dev/null || true
$SCP "${OPTS[@]}" -r "$STAGE/fpvsim" "$T:$STAGE_FS" >/dev/null
# /MIR so the content-hashed assets of a previous build are removed rather than
# accumulating. /XD data is load-bearing: the box holds state for this app (the
# collected usage records), and a mirror deletes anything not in the source.
# reference, backup and dist.prev are the box's own; start-fpvsim.bat is the old
# bare-process launcher, left alone. robocopy exits 0-7 on success, 8+ on error.
remote "robocopy $STAGE_BS $APP_BS /MIR /NFL /NDL /NJH /NJS /NP /XF server.log server.out admin.log admin.out start-fpvsim.bat /XD $APP_BS\\data $APP_BS\\reference $APP_BS\\backup $APP_BS\\dist.prev | Out-Null; if (\$LASTEXITCODE -ge 8) { exit 1 } else { exit 0 }"
remote "Remove-Item -Recurse -Force $STAGE_BS -ErrorAction SilentlyContinue" >/dev/null || true
rm -rf "$STAGE"

echo "[5/6] rebuilding and restarting the containers"
# Over SSH there is no interactive logon session, so Docker Desktop's credential
# helper fails ("A specified logon session does not exist") the moment BuildKit
# looks up the base image, even though Alpine is public and needs no login. Two
# things avoid it, both only for this build: a copy of Docker's config with the
# credential helper removed, and the classic builder (DOCKER_BUILDKIT=0), which
# ignores the helper for a public image. Verified on the Optiplex 2026-11-11:
# BuildKit with the clean config still failed; the classic builder with it built.
PREP_CFG='$src = "$env:USERPROFILE\.docker"; $dst = "C:\services\_dockercfg_fpvsim"; Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue; New-Item -ItemType Directory $dst | Out-Null; foreach ($d in "contexts","buildx","cli-plugins") { if (Test-Path "$src\$d") { Copy-Item -Recurse "$src\$d" $dst } }; $j = Get-Content "$src\config.json" -Raw | ConvertFrom-Json; $j.PSObject.Properties.Remove("credsStore"); $j.PSObject.Properties.Remove("credHelpers"); ($j | ConvertTo-Json -Depth 10) | Set-Content "$dst\config.json" -Encoding ascii'
if ! remote "$PREP_CFG; \$env:DOCKER_CONFIG = '$CFG_BS'; \$env:DOCKER_BUILDKIT = '0'; cmd /c $APP_BS\\docker-fpvsim.bat"; then
  echo "      container start failed. The collection in data\\ is untouched (it is a mount)."
  echo "      roll back: ssh $T 'docker tag fpvsim:prev fpvsim:latest'  and run docker-fpvsim.bat's docker run lines"
  exit 1
fi

echo "[6/6] verifying"
remote "foreach (\$p in '/','/web','/rc','/downloads/NacoSim-latest.zip') { curl.exe -s -m 5 -o NUL -w \"      \$p HTTP %{http_code}, %{size_download} bytes\`n\" http://127.0.0.1:5180\$p }"
remote "curl.exe -s -m 5 -o NUL -w \"      admin HTTP %{http_code}\`n\" http://127.0.0.1:5181/"
remote "\"      sessions after: \$((Get-Content $APP_BS\\data\\sessions.jsonl | Measure-Object -Line).Lines) lines\""
echo
echo "      check the live site:  node tools/rc-check.mjs http://${WIN_HOST}:5180   (or your public address)"
echo "      usage view: http://${WIN_HOST}:5181/ from the LAN"
