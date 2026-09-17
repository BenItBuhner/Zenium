#!/usr/bin/env bash
# Temporary: runs on the workflow runner once the emulator has booted. Serves the demo pages
# (reachable from the emulator as 10.0.2.2:8787), records the ServicesHardeningDemo driver through
# the gesture-demo script, then checks what the system thinks of the app's backup eligibility.
set -uo pipefail

out=artifacts/android-services-hardening-demo
mkdir -p "$out"
app_id=io.github.benitbuhner.zenium.debug

node .github/scripts/services-hardening-demo-server.mjs > "$out/server.log" 2>&1 &
server_pid=$!
sleep 1
curl -fsS -o /dev/null http://127.0.0.1:8787/ && echo "demo server up"

DEMO_CLASS=app.zen.chromium.ServicesHardeningDemo \
DEMO_DIR=services-hardening-demo \
DEMO_OUT="$out" \
DEMO_VIDEO=services-hardening-android-demo.mp4 \
  bash .github/scripts/android-gesture-demo.sh
demo_status=$?

for name in $(adb shell run-as "$app_id" ls files/services-hardening-demo | tr -d '\r'); do
  case "$name" in
    *.txt) adb exec-out run-as "$app_id" cat "files/services-hardening-demo/$name" > "$out/$name" ;;
  esac
done

{
  echo "== dumpsys package (backup flags)"
  adb shell dumpsys package "$app_id" | grep -iE "allowBackup|ALLOW_BACKUP|backup|flags=" || true
  echo
  echo "== bmgr"
  adb shell bmgr enabled || true
  adb shell bmgr enable true || true
  adb shell bmgr transport com.android.localtransport/.LocalTransport || true
  adb shell bmgr list transports || true
  adb shell bmgr backupnow "$app_id" || true
  echo
  echo "== dumpsys backup (this app)"
  adb shell dumpsys backup | grep -iE "$app_id|not eligible|allowBackup|BackupNotAllowed" || true
} > "$out/backup-check.txt" 2>&1
cat "$out/backup-check.txt"

kill "$server_pid" 2> /dev/null || true
exit "$demo_status"
