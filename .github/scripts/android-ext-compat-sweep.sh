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
# The same server on the device's own localhost: Coinbase Wallet registers its provider scripts
# for `https://*/*` and `http://localhost/*` alone, so its row reads the fixture as
# http://localhost:8765/ (the driver's LOCALHOST_BASE).
adb reverse tcp:8765 tcp:8765 || echo "adb reverse failed; the localhost fixture rows read nothing" >&2

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

# The driver's files (results.json, rewritten after every row; the numbered screenshots; a row's
# text files) copied to the artifact as they appear, so an emulator that goes away under the
# driver (qemu gone, the guest frozen: run 35778999040's 113 job, 11 rows in) loses the row in
# flight alone and the rows before it keep their reading and their evidence. Every file once,
# results.json every time (every file again at the end, `pull_new all`, so a shot pulled while
# the driver was still writing it is whole); each adb call bounded, as a frozen guest answers
# nothing.
pull_new() {
  for name in $(timeout 60 adb shell run-as "$app_id" ls files/ext-compat-sweep 2> /dev/null | tr -d '\r'); do
    case "$name" in
      results.json) ;;
      *.png | *.json | *.txt) [ "${1:-}" != all ] && [ -s "$out/$name" ] && continue ;;
      *) continue ;;
    esac
    if timeout 60 adb exec-out run-as "$app_id" cat "files/ext-compat-sweep/$name" > "$out/$name.part" 2> /dev/null && [ -s "$out/$name.part" ]; then
      mv -f "$out/$name.part" "$out/$name"
    else
      rm -f "$out/$name.part"
    fi
  done
}

collect() {
  pull_new all
  adb exec-out run-as "$app_id" cat files/zen/extensions.json > "$out/extensions.json" 2> /dev/null || true
  adb shell run-as "$app_id" find files/zen/extensions -maxdepth 2 > "$out/install-tree.txt" 2> /dev/null || true
  adb shell run-as "$app_id" ls -la cache/ext-packages > "$out/package-cache.txt" 2> /dev/null || true
  grep -E 'CompatSweep|ZenExtStore|ZenPackageFetcher|\[zen\] extensions|ZenExt' "$out/logcat.txt" > "$out/sweep-log.txt" 2> /dev/null || true
}

# The emulator went away under the driver (adb has no device, or the guest answers nothing within
# 30 s: qemu alive with a frozen guest looks like a device to adb): the marker the shared workflow
# reads (its `emulator-died` output; a caller boots once more on that alone and sweeps the rows
# left, tmp-ext-android-13-sweep.yml), with what the host saw of the death.
note_emulator_death() {
  if [ "$(timeout 30 adb get-state 2> /dev/null || true)" != "device" ] || [ "$(timeout 30 adb shell echo alive 2> /dev/null | tr -d '\r' || true)" != "alive" ]; then
    {
      echo "adb lost the device before the driver was done ($(date +%T))"
      echo "== emulator process: $(pgrep -f qemu-system-x86_64 || echo gone)"
      echo "== host monitor, last lines"
      tail -n 12 "$out/host-monitor.txt" 2> /dev/null || true
      echo "== host kernel log"
      sudo dmesg 2> /dev/null | tail -n 40 || true
    } > "$out/emulator-died"
    echo "::warning::the emulator went away under the sweep driver (see emulator-died in the artifact)"
  fi
}

# The app's process silent in logcat for HANG_SILENCE_S (default 300) while the driver runs and
# its `done` file is not written: run 35787391495's 113 job, where Redux DevTools' package was
# fetched and verified, its install prompt due, and then the process wrote nothing for two hours
# (no frame, no GC, no line of the driver's, whose own timeouts never fired: its thread was in a
# synchronous call to the main thread, an ANR without the dialog, `hide_error_dialogs` being set)
# until the system died under the step's cap, with no stack anywhere. The silence is the gap
# between the process's last line and the guest's last line (the guest keeps logging; the two
# clocks need not agree with the host's), and the driver's longest legitimate silence is a core
# wait of 45 s at the speed factor's cap of x4. Once it is reached, the stacks are taken before
# the cap: SIGQUIT to the process (ART's signal catcher writes every thread's trace to
# /data/anr/), adbd as root (the images are debug-keyed) to read that trace and debuggerd's
# native backtrace, the driver's own dumps pulled (CompatSweep's MainThreadWatch writes
# hang-main-thread-N.txt once the main thread has not answered it for 90 s), then the app is
# stopped so the driver ends and the second boot grades the rows left, this row last:
# `app-hung` in the artifact says what happened, and `emulator-died` is left as well, the marker
# the shared workflow turns into the output the second boot keys on (the emulator itself is up).
hang_silence_s=${HANG_SILENCE_S:-300}
hung=0
logcat_epoch() {
  # "MM-DD hh:mm:ss.mmm" (logcat -v time) to seconds; the year is the host's.
  date -d "$(date +%Y)-${1:0:5} ${1:6:12}" +%s 2> /dev/null || echo 0
}
app_silence() {
  # The seconds between the app process's last logcat line (the driver's HANG lines left out:
  # they are the watch's own) and the guest's last line; 0 when either is missing.
  local pid=$1 last_app last_any
  last_app=$(grep -E "\( *${pid}\)" "$out/logcat.txt" 2> /dev/null | grep -v 'CompatSweep.*HANG' | tail -n 1 | cut -c1-18 || true)
  last_any=$(tail -n 1 "$out/logcat.txt" 2> /dev/null | cut -c1-18 || true)
  if [ -z "$last_app" ] || [ -z "$last_any" ]; then echo 0; return; fi
  echo $(( $(logcat_epoch "$last_any") - $(logcat_epoch "$last_app") ))
}
dump_hang() {
  local pid=$1 silence=$2 inflight
  hung=1
  inflight=$(grep -E 'I/CompatSweep\( *[0-9]+\): (ROW|.* install [PF])' "$out/logcat.txt" | tail -n 1 | sed -E 's/^.*CompatSweep\( *[0-9]+\): //')
  echo "::warning::the app's process $pid wrote nothing to logcat for ${silence}s under the driver (last: $inflight); taking its stacks"
  {
    echo "the app's process $pid silent in logcat for ${silence}s at $(date +%T) (the emulator up, the guest logging); the driver's last lines:"
    grep -E 'I/CompatSweep' "$out/logcat.txt" | tail -n 6
    echo "== SIGQUIT (ART writes every thread's trace to /data/anr/)"
    timeout 30 adb shell run-as "$app_id" kill -3 "$pid" 2>&1 || echo "kill -3 failed"
  } > "$out/app-hung"
  sleep 6
  pull_new
  if timeout 60 adb root >> "$out/app-hung" 2>&1 && timeout 60 adb wait-for-device; then
    sleep 3
    # adbd's restart ended the logcat stream; a new one carries on into the same file from the last line seen.
    last_seen=$(tail -n 1 "$out/logcat.txt" | cut -c1-18)
    adb logcat -v time -T "$last_seen" >> "$out/logcat.txt" 2> /dev/null &
    logcat_pid=$!
    for trace in $(timeout 30 adb shell ls -t /data/anr 2> /dev/null | tr -d '\r' | head -n 3); do
      timeout 60 adb exec-out cat "/data/anr/$trace" > "$out/hang-anr-$trace.txt" 2> /dev/null || rm -f "$out/hang-anr-$trace.txt"
    done
    timeout 120 adb shell debuggerd -b "$pid" > "$out/hang-debuggerd-$pid.txt" 2>&1 || echo "debuggerd -b failed" >> "$out/hang-debuggerd-$pid.txt"
    echo "== traces pulled: $(ls "$out" | grep -E '^hang-' | tr '\n' ' ')" >> "$out/app-hung"
  else
    echo "== adb root refused; ART's trace stays in /data/anr on the device, the driver's own dump (hang-main-thread-*.txt) is what the artifact holds" >> "$out/app-hung"
  fi
  echo "== the app stopped so the driver ends and the second boot grades the rows left ($(date +%T))" >> "$out/app-hung"
  timeout 30 adb shell am force-stop "$app_id" || true
  echo "the app hung under the driver (the emulator itself up): see app-hung and hang-*.txt ($(date +%T))" > "$out/emulator-died"
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

# Progress in the job log while the driver runs: one line per graded row, and the driver's
# files pulled as they land (pull_new); the app's silence watched (dump_hang).
seen=0
while kill -0 "$driver_pid" 2> /dev/null; do
  sleep 30
  rows=$(grep -cE 'I/CompatSweep\( *[0-9]+\): ROW ' "$out/logcat.txt" 2> /dev/null || true)
  rows=${rows:-0}
  if [ "$rows" -gt "$seen" ]; then
    grep -E 'I/CompatSweep\( *[0-9]+\): ROW ' "$out/logcat.txt" | tail -n $((rows - seen)) | sed -E 's/^.*CompatSweep\( *[0-9]+\): /  /'
    seen=$rows
    pull_new
  fi
  if timeout 60 adb shell run-as "$app_id" test -f files/ext-compat-sweep/done 2> /dev/null; then break; fi
  if [ "$hung" -eq 0 ]; then
    # `pidof` exits 1 while the app is dead (a crash the instrumentation is still winding down):
    # under pipefail that would end the driver here, before `note_emulator_death` and `collect`.
    app_pid=$(timeout 30 adb shell pidof "$app_id" 2> /dev/null | tr -d '\r' | awk '{print $1}' || true)
    if [ -n "$app_pid" ]; then
      silence=$(app_silence "$app_pid")
      if [ "${silence:-0}" -ge "$hang_silence_s" ]; then dump_hang "$app_pid" "$silence"; fi
    fi
  fi
done
wait "$driver_pid" || true
sleep 2
kill "$logcat_pid" "$monitor_pid" "$http_pid" "$memory_pid" 2> /dev/null || true

note_emulator_death
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
