#!/usr/bin/env bash
# TEMPORARY – runs on the workflow runner once the emulator has booted. Installs the debug APK
# with the MCP server enabled, serves the fixture pages to the emulator, exposes the app's MCP
# socket through a free cloudflared quick tunnel and idles while a model harness elsewhere drives
# the browser. The tunnel URL is published encrypted (RSA-OAEP to harness.pub) in the job log and
# on a throwaway branch; only the holder of the private key can use it. No inference key is ever
# present here.
#
# Signals from the harness arrive as requests to the fixture server:
#   GET /__marker__/demo-start … /__marker__/demo-end   – screenrecord while between them
#   GET /__marker__/task-start-* … task-end-*           – a screenshot each
#   GET /__marker__/shutdown                             – collect artifacts and exit
set -euo pipefail

app_id=app.zen.chromium.debug
port=41735
lane=${LANE:-a}
out=artifacts/mcp-mobile-$lane
deadline_min=${DEADLINE_MIN:-330}
mkdir -p "$out/shots" "$out/video"

adb wait-for-device
nproc
free -m

# Host watchdog: memory every few seconds, and the kernel log when the emulator dies.
(
  while true; do
    {
      date +%T
      free -m | sed -n '2p'
      ps -o pid=,rss=,pcpu=,comm= -C qemu-system-x86_64 || true
    } >> "$out/host-monitor.txt"
    if ! pgrep -f qemu-system-x86_64 > /dev/null; then
      {
        echo "EMULATOR PROCESS GONE"
        sudo dmesg 2> /dev/null | tail -n 80 || true
      } >> "$out/host-monitor.txt"
      break
    fi
    sleep 10
  done
) &
monitor_pid=$!

# Same layout a Pixel 6 gets at 2.3x fewer pixels; everything renders through a software GPU.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
for pkg in \
  com.google.android.youtube com.google.android.apps.youtube.music com.google.android.gm \
  com.google.android.apps.messaging com.android.chrome com.google.android.apps.maps \
  com.google.android.videos com.google.android.apps.photos com.google.android.googlequicksearchbox \
  com.google.android.calendar com.google.android.apps.docs com.google.android.apps.wellbeing \
  com.google.android.projection.gearhead com.google.android.apps.tachyon com.google.android.talk \
  com.google.android.music com.google.android.apps.podcasts com.google.android.apps.nbu.files; do
  adb shell pm disable-user --user 0 "$pkg" > /dev/null 2>&1 || true
done
adb shell am kill-all || true
echo "letting the system settle"
sleep 30

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
echo "app: $apk"
adb install -r -g "$apk"
adb shell am force-stop "$app_id" || true
adb shell run-as "$app_id" mkdir -p "/data/data/$app_id/files/zen"
# A profile with onboarding done and the MCP server on, loopback only, agents auto-approved.
printf '%s' "{\"version\":2,\"settings\":{\"onboardingDone\":true,\"agents\":{\"enabled\":true,\"port\":$port,\"lan\":false,\"approveNewAgents\":false,\"approvedNames\":[],\"defaultMode\":\"foreground\",\"allowScripts\":true,\"showCursor\":true}}}" \
  | adb shell "run-as $app_id sh -c 'cat > /data/data/$app_id/files/zen/state.json'"
adb shell run-as "$app_id" cat "/data/data/$app_id/files/zen/state.json"
echo

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

adb shell am start -n "$app_id/app.zen.chromium.MainActivity"
adb forward "tcp:$port" "tcp:$port"
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"runner-probe","version":"0"}}}'
up=0
for i in $(seq 1 180); do
  if curl -s -m 5 -o "$out/mcp-init.json" -w '%{http_code}' -X POST "http://127.0.0.1:$port/mcp" \
      -H 'content-type: application/json' -H 'accept: application/json' -d "$init" | grep -q 200; then
    echo "MCP server up after ${i}s"
    up=1
    break
  fi
  sleep 1
done
if [ "$up" -ne 1 ]; then
  echo "::error::the MCP server never answered"
  adb exec-out screencap -p > "$out/shots/no-mcp.png" || true
  kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true
  exit 1
fi
head -c 600 "$out/mcp-init.json"
echo
adb exec-out screencap -p > "$out/shots/00-app-started.png" || true

# Fixture pages for the browser under test (the emulator reaches this host as 10.0.2.2).
python3 -m http.server 8765 --bind 0.0.0.0 --directory .github/mcp-mobile/fixtures > "$out/fixtures.log" 2>&1 &
fixtures_pid=$!

# Optional: does the WebView's own DevTools socket support captureBeyondViewport? (informational)
if [ -f .github/mcp-mobile/cdp-probe.mjs ]; then
  node .github/mcp-mobile/cdp-probe.mjs "$out" "$app_id" > "$out/cdp-probe.txt" 2>&1 || true
  tail -n 20 "$out/cdp-probe.txt" || true
fi

# Free quick tunnel to the forwarded MCP socket. The Host header must stay an address literal
# for the server's DNS-rebinding check.
curl -sSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /tmp/cloudflared
/tmp/cloudflared tunnel --url "http://127.0.0.1:$port" --http-host-header "127.0.0.1:$port" --no-autoupdate > "$out/cloudflared.log" 2>&1 &
tunnel_pid=$!
url=""
for _ in $(seq 1 90); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$out/cloudflared.log" | head -n 1 || true)
  [ -n "$url" ] && break
  sleep 2
done
if [ -z "$url" ]; then
  echo "::error::no tunnel URL"
  cat "$out/cloudflared.log"
  kill "$logcat_pid" "$monitor_pid" "$fixtures_pid" "$tunnel_pid" 2> /dev/null || true
  exit 1
fi
enc=$(printf '%s' "$url" | openssl pkeyutl -encrypt -pubin -inkey .github/mcp-mobile/harness.pub -pkeyopt rsa_padding_mode:oaep | base64 -w0)
echo "TUNNEL-ENC $enc"
# Second channel in case in-progress job logs are not readable: a throwaway branch.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  rm -rf /tmp/signal && mkdir -p /tmp/signal && cd /tmp/signal
  printf '%s\n' "$enc" > tunnel-url.enc
  git init -q
  git -c user.name=runner -c user.email=runner@users.noreply.github.com add tunnel-url.enc
  git -c user.name=runner -c user.email=runner@users.noreply.github.com commit -qm "mcp mobile lane $lane tunnel (encrypted)"
  git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:refs/heads/zz-mcp-mobile-signal-$lane" || echo "signal push failed"
  cd "$GITHUB_WORKSPACE"
fi

# Idle: react to markers in the fixture log until shutdown or the deadline.
start=$(date +%s)
seen=0
recording=0
segment=0
recorder_pid=""
last_shot=0
shot_n=1
shutdown=0
while true; do
  now=$(date +%s)
  if [ $(( (now - start) / 60 )) -ge "$deadline_min" ]; then
    echo "deadline reached"
    break
  fi
  if ! kill -0 "$tunnel_pid" 2> /dev/null; then
    echo "tunnel died; restarting"
    /tmp/cloudflared tunnel --url "http://127.0.0.1:$port" --http-host-header "127.0.0.1:$port" --no-autoupdate >> "$out/cloudflared.log" 2>&1 &
    tunnel_pid=$!
  fi
  total=$(grep -c '__marker__' "$out/fixtures.log" || true)
  if [ "$total" -gt "$seen" ]; then
    mapfile -t new < <(grep '__marker__' "$out/fixtures.log" | tail -n "$(( total - seen ))" | grep -oE '__marker__/[A-Za-z0-9._-]+' | sed 's#__marker__/##')
    seen=$total
    for ev in "${new[@]}"; do
      echo "$(date +%T) marker: $ev"
      case "$ev" in
        demo-start) recording=1 ;;
        demo-end) recording=0 ;;
        shutdown) shutdown=1 ;;
        restart-app)
          # Cold start with the persisted session, to look at what a restored tab does.
          adb shell am force-stop "$app_id" || true
          sleep 2
          adb shell am start -n "$app_id/app.zen.chromium.MainActivity" || true
          sleep 8
          adb forward "tcp:$port" "tcp:$port" || true
          ;;
      esac
      case "$ev" in
        task-*|demo-*|suite-*)
          sleep 1
          adb exec-out screencap -p > "$out/shots/$(printf '%03d' "$shot_n")-$ev.png" || true
          shot_n=$((shot_n + 1))
          ;;
      esac
    done
  fi
  if [ "$recording" -eq 1 ] && [ -z "$recorder_pid" ]; then
    segment=$((segment + 1))
    adb shell screenrecord --bit-rate 6000000 --time-limit 180 "/sdcard/demo-$(printf '%02d' "$segment").mp4" &
    recorder_pid=$!
    echo "$(date +%T) recording segment $segment"
  fi
  if [ -n "$recorder_pid" ] && ! kill -0 "$recorder_pid" 2> /dev/null; then
    recorder_pid=""
  fi
  if [ "$recording" -eq 0 ] && [ -n "$recorder_pid" ]; then
    adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
    wait "$recorder_pid" || true
    recorder_pid=""
  fi
  if [ $((now - last_shot)) -ge 60 ]; then
    adb exec-out screencap -p > "$out/shots/periodic-$(date +%H%M%S).png" || true
    last_shot=$now
  fi
  if [ "$shutdown" -eq 1 ]; then
    break
  fi
  sleep 3
done

if [ -n "$recorder_pid" ]; then
  adb shell pkill -INT screenrecord || true
  wait "$recorder_pid" || true
fi
sleep 2
for i in $(seq 1 "$segment"); do
  adb pull "/sdcard/demo-$(printf '%02d' "$i").mp4" "$out/video/" || true
done
if [ "$segment" -gt 0 ]; then
  (cd "$out/video" && for f in demo-*.mp4; do echo "file '$f'"; done > list.txt && ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -c copy demo.mp4) || true
fi
kill "$logcat_pid" "$monitor_pid" "$fixtures_pid" "$tunnel_pid" 2> /dev/null || true
ls -la "$out" "$out/shots" "$out/video" || true
