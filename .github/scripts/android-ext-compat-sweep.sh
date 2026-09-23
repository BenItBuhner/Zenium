#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the top-30 extension compatibility
# sweep (CompatSweep, android/app/src/androidTest). The driver installs every extension of the
# desktop sweep's list from its store through the chrome's command API, grades install /
# background / popup / options / core function with the concrete outcome and disables it again
# before the next; the runner serves the fixture pages (reachable from the emulator as 10.0.2.2)
# and collects files/ext-compat-sweep/results.json plus the numbered screenshots and the driver's text files (a row's bridge trace). No screen
# recording: two hours of installs are not a demo; the screenshots are the evidence.
#
# Environment:
#   WEBVIEW_APK   – a SystemWebView.apk to swap in before the run (android-webview-swap.sh; needs an
#                   AOSP image booted with -writable-system); the image's own WebView otherwise
#   SOFT_FAIL=1   – report what was found and never fail the job (the swapped-WebView job)
#   SWEEP_ONLY    – comma-separated extension ids: run those rows alone (the driver's `only`)
#   SWEEP_LAST    – comma-separated extension ids to run after every other row (the driver's `last`;
#                   uBlock Origin MV2 when unset)
#   SWEEP_OUT     – artifact directory (default artifacts/android-ext-compat-sweep)
#
# Handshake with the driver, through files in the app's private storage (via run-as):
#   files/ext-compat-sweep/record     – written by the driver once its warm-up is done
#   files/ext-compat-sweep/recording  – written here at once (no recorder to wait for)
#   files/ext-compat-sweep/done       – written by the driver when the sweep is over
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
out=${SWEEP_OUT:-artifacts/android-ext-compat-sweep}
pages=.github/scripts/ext-demo-pages
mkdir -p "$out"

fail() {
  if [ -n "${SOFT_FAIL:-}" ]; then
    echo "::warning::$1 (best effort, not failing the job)"
    exit 0
  fi
  echo "::error::$1"
  exit 1
}

cp -f artifacts/webview/REVISIONS.json "$out/webview-REVISIONS.json" 2> /dev/null || true

adb wait-for-device
nproc
free -m
df -h / /tmp

# Optional: run everything on a Chromium snapshot WebView instead of the image's own.
if [ -n "${WEBVIEW_APK:-}" ]; then
  if ! bash .github/scripts/android-webview-swap.sh "$WEBVIEW_APK" "$out"; then
    echo "::warning::WebView swap failed; continuing with the image's WebView"
  fi
fi
adb shell dumpsys webviewupdate > "$out/webviewupdate.txt" 2>&1 || true

# Host watchdog: memory every few seconds, the kernel log the moment the emulator disappears.
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
    sleep 5
  done
) &
monitor_pid=$!

# RSS of every Zenium process every 5 s: the app and the WebView renderers.
(
  while true; do
    stamp=$(date +%T)
    adb shell ps -A -o PID,RSS,NAME 2> /dev/null | grep "$app_id" | sed "s/^/$stamp /" >> "$out/memory-samples.txt" || true
    sleep 5
  done
) &
memory_pid=$!

# The fixture pages, served from the runner; the emulator's host loopback is 10.0.2.2. The
# server is http.server plus `/echo-headers` (the request headers as the server received them)
# and the HLS media types (ext-fixture-server.py).
python3 .github/scripts/ext-fixture-server.py 8765 "$pages" > "$out/http-server.txt" 2>&1 &
http_pid=$!

# The same 411 CSS px wide layout a Pixel 6 gets, at fewer pixels.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3
# Exclusive within the navbar category (android-gesture-demo.sh says why a plain enable left the gestural insets).
adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true

# The Google APIs image spends its first minutes starting every bundled Google app; none of them
# are needed and they fight the browser for the emulator's CPU and memory.
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
sleep 40
free -m

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "app: $apk"
echo "driver: $test_apk"
adb install -r -g "$apk"
adb install -r -g "$test_apk"

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

collect() {
  for name in $(adb shell run-as "$app_id" ls files/ext-compat-sweep 2> /dev/null | tr -d '\r'); do
    case "$name" in
      *.png | *.json | *.txt) adb exec-out run-as "$app_id" cat "files/ext-compat-sweep/$name" > "$out/$name" 2> /dev/null || true ;;
    esac
  done
  adb exec-out run-as "$app_id" cat files/zen/extensions.json > "$out/extensions.json" 2> /dev/null || true
  adb shell run-as "$app_id" find files/zen/extensions -maxdepth 2 > "$out/install-tree.txt" 2> /dev/null || true
  adb shell run-as "$app_id" ls -la cache/ext-packages > "$out/package-cache.txt" 2> /dev/null || true
  grep -E 'CompatSweep|ZenExtStore|ZenPackageFetcher|\[zen\] extensions|ZenExt' "$out/logcat.txt" > "$out/sweep-log.txt" 2> /dev/null || true
}

# --- The sweep --------------------------------------------------------------------------------
args=()
if [ -n "${SWEEP_ONLY:-}" ]; then args+=(-e only "$SWEEP_ONLY"); fi
if [ -n "${SWEEP_LAST:-}" ]; then args+=(-e last "$SWEEP_LAST"); fi
adb shell am instrument -w -e class app.zen.chromium.CompatSweep "${args[@]}" "$runner" > "$out/instrument.txt" 2>&1 &
driver_pid=$!

ready=0
for _ in $(seq 1 1600); do
  if adb shell run-as "$app_id" test -f files/ext-compat-sweep/record 2> /dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$driver_pid" 2> /dev/null; then
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  cat "$out/instrument.txt" || true
  collect
  sleep 2
  kill "$logcat_pid" "$monitor_pid" "$http_pid" "$memory_pid" 2> /dev/null || true
  fail "the sweep driver never reached its handshake"
fi
adb shell run-as "$app_id" touch files/ext-compat-sweep/recording

# Progress in the job log while the driver runs: one line per graded row.
seen=0
while kill -0 "$driver_pid" 2> /dev/null; do
  sleep 30
  rows=$(grep -c 'CompatSweep: ROW ' "$out/logcat.txt" 2> /dev/null || true)
  rows=${rows:-0}
  if [ "$rows" -gt "$seen" ]; then
    grep 'CompatSweep: ROW ' "$out/logcat.txt" | tail -n $((rows - seen)) | sed 's/^.*CompatSweep: /  /'
    seen=$rows
  fi
  if adb shell run-as "$app_id" test -f files/ext-compat-sweep/done 2> /dev/null; then break; fi
done
wait "$driver_pid" || true
sleep 2
kill "$logcat_pid" "$monitor_pid" "$http_pid" "$memory_pid" 2> /dev/null || true

collect
echo "--- peak RSS per process (KB)"
awk '{ if ($3 + 0 > peak[$4] + 0) peak[$4] = $3 } END { for (p in peak) printf "%10d KB  %s\n", peak[p], p }' \
  "$out/memory-samples.txt" 2> /dev/null | sort -rn | tee "$out/memory-peaks.txt" || true

echo "--- the table"
if [ -f "$out/results.json" ]; then
  python3 - "$out/results.json" <<'PY' || true
import json, sys
r = json.load(open(sys.argv[1]))
print("webView:", r.get("webView"), "isolatedWorlds:", r.get("isolatedWorlds"))
for row in r.get("rows", []):
    stages = " ".join(f"{s}={row.get(s, {}).get('verdict', '?')}" for s in ("install", "background", "popup", "options", "core"))
    print(f"{row.get('name', '?'):36} {stages}  {row.get('ms', 0) // 1000}s")
PY
fi

cat "$out/instrument.txt"
ls -la "$out"
grep -q '^OK (' "$out/instrument.txt" || fail "the sweep driver did not finish cleanly"
