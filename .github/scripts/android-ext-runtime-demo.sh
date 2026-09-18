#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted. Two instrumentation runs:
#
#   1. EngineProbe – what the system WebView is (provider version, androidx.webkit feature flags,
#      reflection dump, chrome-extension:// behaviour, an https origin served only through
#      shouldInterceptRequest). Writes files/ext-probe/engine-probe.json.
#   2. ExtensionDemo – the demo extensions laid out as store installs, run on the runtime and
#      recorded. The runner serves the local probe pages (reachable from the emulator as
#      10.0.2.2) and the driver writes files/ext-demo/results.json plus screenshots.
#
# Handshake with the demo driver, through files in the app's private storage (via run-as):
#   files/ext-demo/record     – written by the driver once the extensions are configured
#   files/ext-demo/recording  – written here once screenrecord is rolling
#   files/ext-demo/done       – written by the driver when the visible sequence is over
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
out=artifacts/android-ext-runtime-demo
video=ext-android-runtime-demo.mp4
ext_dir=${EXT_DIR:-artifacts/ext}
pages=.github/scripts/ext-demo-pages
mkdir -p "$out"

# SOFT_FAIL=1: a best-effort run (the swapped-WebView job) reports what it found and never fails
# the workflow; a job calling a reusable workflow cannot set continue-on-error.
fail() {
  if [ -n "${SOFT_FAIL:-}" ]; then
    echo "::warning::$1 (best effort, not failing the job)"
    exit 0
  fi
  echo "::error::$1"
  exit 1
}

# What the run was fed, next to what it produced.
cp -f "$ext_dir/fetch.json" "$out/fetch.json" 2> /dev/null || true
cp -f artifacts/webview/REVISIONS.json "$out/webview-REVISIONS.json" 2> /dev/null || true

adb wait-for-device
nproc
free -m
df -h / /tmp

# Optional: run everything on a Chromium snapshot WebView instead of the image's own (see
# android-webview-swap.sh; needs an AOSP image booted with -writable-system). Best effort.
if [ -n "${WEBVIEW_APK:-}" ]; then
  if ! bash .github/scripts/android-webview-swap.sh "$WEBVIEW_APK" "$out"; then
    echo "::warning::WebView swap failed; continuing with the image's WebView"
  fi
fi
adb shell dumpsys webviewupdate > "$out/webviewupdate.txt" 2>&1 || true

# Host watchdog: memory every few seconds, and the kernel log the moment the emulator process
# disappears (a silent death is most likely the OOM killer or a renderer crash).
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

# The probe pages, served from the runner; the emulator's host loopback is 10.0.2.2.
python3 -m http.server 8765 --bind 0.0.0.0 --directory "$pages" > "$out/http-server.txt" 2>&1 &
http_pid=$!

# The same 411 CSS px wide layout a Pixel 6 gets, at fewer pixels: the emulator renders and
# records through a software GPU.
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

# --- 1. Engine probe --------------------------------------------------------------------------
echo "engine probe"
adb shell am instrument -w -e class app.zen.chromium.EngineProbe "$runner" > "$out/instrument-engine-probe.txt" 2>&1 || true
adb exec-out run-as "$app_id" cat files/ext-probe/engine-probe.json > "$out/engine-probe.json" || true
tail -n 5 "$out/instrument-engine-probe.txt"
adb shell am force-stop "$app_id" || true

# --- 2. Sideload the demo extensions ----------------------------------------------------------
# One tar through /data/local/tmp (readable by every uid), unpacked by the app's own uid so the
# files end up owned by it under files/zen/extensions/<id>/.
if [ -d "$ext_dir" ]; then
  tar -C "$ext_dir" --exclude='*.crx' --exclude='*.zip' --exclude='fetch.json' -cf /tmp/ext.tar .
  ls -la /tmp/ext.tar
  adb push /tmp/ext.tar /data/local/tmp/ext.tar
  adb shell run-as "$app_id" mkdir -p files/zen/extensions
  adb shell run-as "$app_id" tar -xf /data/local/tmp/ext.tar -C files/zen/extensions
  adb shell run-as "$app_id" ls files/zen/extensions
  adb shell rm /data/local/tmp/ext.tar || true
else
  echo "::warning::no unpacked extensions under $ext_dir; the demo runs with the probe extension only"
fi

# --- 3. The recorded demo ---------------------------------------------------------------------
adb shell am instrument -w -e class app.zen.chromium.ExtensionDemo "$runner" > "$out/instrument.txt" 2>&1 &
driver_pid=$!

ready=0
for _ in $(seq 1 1600); do
  if adb shell run-as "$app_id" test -f files/ext-demo/record 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$driver_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  cat "$out/instrument.txt" || true
  adb exec-out run-as "$app_id" cat files/ext-demo/results.json > "$out/results.json" 2>/dev/null || true
  sleep 4
  kill "$logcat_pid" "$monitor_pid" "$http_pid" 2> /dev/null || true
  fail "the demo driver never reached the recording handshake"
fi

# screenrecord stops itself after three minutes; record in parts until the driver is done and
# join them afterwards.
(
  part=0
  while [ "$part" -lt 5 ]; do
    if adb shell run-as "$app_id" test -f files/ext-demo/done 2>/dev/null; then break; fi
    if ! kill -0 "$driver_pid" 2>/dev/null; then break; fi
    part=$((part + 1))
    adb shell screenrecord --bit-rate 6000000 --time-limit 180 "/sdcard/ext-part-$part.mp4" &
    rec=$!
    if [ "$part" -eq 1 ]; then
      sleep 1
      adb shell run-as "$app_id" touch files/ext-demo/recording
    fi
    while kill -0 "$rec" 2>/dev/null; do
      if adb shell run-as "$app_id" test -f files/ext-demo/done 2>/dev/null || ! kill -0 "$driver_pid" 2>/dev/null; then
        adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
        sleep 2
        break
      fi
      sleep 1
    done
    wait "$rec" || true
  done
) &
recorder_pid=$!

wait "$recorder_pid" || true
wait "$driver_pid" || true
sleep 2
kill "$logcat_pid" "$monitor_pid" "$http_pid" 2> /dev/null || true

# Collect: the recording parts (joined), the screenshots and the results.
parts=()
for name in $(adb shell ls /sdcard/ 2>/dev/null | tr -d '\r' | grep '^ext-part-' | sort -V); do
  adb pull "/sdcard/$name" "$out/$name"
  parts+=("$out/$name")
done
if [ "${#parts[@]}" -eq 1 ]; then
  mv "${parts[0]}" "$out/$video"
elif [ "${#parts[@]}" -gt 1 ]; then
  : > "$out/parts.txt"
  for p in "${parts[@]}"; do echo "file '$(realpath "$p")'" >> "$out/parts.txt"; done
  ffmpeg -loglevel error -f concat -safe 0 -i "$out/parts.txt" -c copy "$out/$video" && rm -f "${parts[@]}" "$out/parts.txt" || true
fi
for name in $(adb shell run-as "$app_id" ls files/ext-demo 2>/dev/null | tr -d '\r'); do
  case "$name" in
    *.png | *.json) adb exec-out run-as "$app_id" cat "files/ext-demo/$name" > "$out/$name" ;;
  esac
done

cat "$out/instrument.txt"
ls -la "$out"
grep -q '^OK (' "$out/instrument.txt" || fail "the demo driver did not finish cleanly"
