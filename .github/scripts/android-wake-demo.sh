#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs a debug APK and the wake
# driver (the WakeDemo instrumentation), records the screen while the driver turns the screen off
# and on, swipes the lock screen away, sends the app home under memory trims, forces Doze, has the
# WebView renderer killed and hangs it, and collects the recording, the screenshots, the driver's
# report and the logs under artifacts/android-wake-demo/<take>/.
#
# Two takes when BEFORE_APK_DIR names a directory with an APK built from main (the workflow's
# setup-script builds it): `before` (that APK, report only) and `after` (this checkout's APK).
# WAKE_ASSERT=true makes the driver fail the `after` take when the chrome is not painted or does
# not answer after a scenario (the regression check); anything else only reports.
#
# Handshake with the driver, through files in the app's private storage (readable via run-as):
#   files/wake-demo/record             – written by the driver once the browser is up
#   files/wake-demo/recording          – written here once screenrecord is rolling
#   files/wake-demo/kill-renderer-N    – the driver asks for the WebView renderer to be killed
#   files/wake-demo/renderer-killed-N  – written here once that is done (or could not be)
#   files/wake-demo/done               – written by the driver when the sequence is over
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
out=artifacts/android-wake-demo
mkdir -p "$out"

adb wait-for-device
nproc
free -m

# The WebView renderer is an isolated process of the WebView provider: only root can kill it the
# way the low-memory killer does. Google APIs images allow it; without it the driver falls back to
# the renderer's own chrome://kill.
rooted=0
if adb root 2>&1 | grep -qi "cannot run as root"; then
  echo "adbd stays unprivileged: renderer kills fall back to chrome://kill"
else
  sleep 3
  adb wait-for-device
  rooted=1
  echo "adbd running as root: $(adb shell id | tr -d '\r')"
fi

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

# The same 411 CSS px wide layout a Pixel 6 gets, at 2.3x fewer pixels: the emulator renders,
# snapshots and records through a software GPU, and every pixel costs.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3
# Three-button navigation: no system gesture zone under the bar, so no accidental home swipes.
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
sleep 45
free -m
adb shell dumpsys webviewupdate | grep -E "Current WebView package" || true

test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "driver: $test_apk"

# SIGKILL every sandboxed WebView renderer (isolated uid) and answer the driver's request `n`.
kill_renderer() {
  local n=$1 pids answer failed=0
  pids=$(adb shell ps -A -o PID,USER,NAME | tr -d '\r' | awk '$3 ~ /sandboxed_process/ && $2 ~ /^u0_i/ { print $1 }')
  if [ -z "$pids" ]; then
    answer="no sandboxed renderer process found"
  elif [ "$rooted" -ne 1 ]; then
    answer="not root; cannot kill $(echo "$pids" | tr '\n' ' ')"
  else
    for pid in $pids; do
      if adb shell kill -9 "$pid" 2>&1 | grep -q .; then failed=1; fi
    done
    if [ "$failed" -eq 0 ]; then answer="killed $(echo "$pids" | tr '\n' ' ')"; else answer="kill refused"; fi
  fi
  echo "renderer kill $n: $answer"
  adb shell "echo '$answer' | run-as $app_id tee files/wake-demo/renderer-killed-$n > /dev/null"
}

# Install `apk`, run the driver with `assert` while recording into `take`'s directory.
run_take() {
  local take=$1 apk=$2 assert=$3
  local dir="$out/$take" video="wake-$take.mp4"
  mkdir -p "$dir"
  echo "==== take $take: $apk (assert=$assert)"
  # -d: the second take may carry a lower versionCode than the first (a branch behind main).
  # Checked by hand: called through `||`, this function runs with `set -e` suspended.
  if ! adb install -r -d -g "$apk" || ! adb install -r -d -g "$test_apk"; then
    echo "::error::could not install the APKs for the $take take"
    return 1
  fi
  adb shell dumpsys package "$app_id" | grep -E "versionName|versionCode" | head -n 2 || true

  adb logcat -c || true
  # Every buffer: the events log carries the activity lifecycle (wm_on_stop_called and friends)
  # and the process deaths the scenarios are about.
  adb logcat -b all -v time > "$dir/logcat.txt" &
  local logcat_pid=$!

  # The previous take's handshake files would be read as this take's before its driver has even
  # seeded its profile: an old `record` starts the recorder and an old `done` stops it at once.
  adb shell run-as "$app_id" rm -rf files/wake-demo || true

  adb shell am instrument -w -e class app.zen.chromium.WakeDemo -e assert "$assert" "$runner" > "$dir/instrument.txt" 2>&1 &
  local driver_pid=$!

  local ready=0
  for _ in $(seq 1 1200); do
    if adb shell run-as "$app_id" test -f files/wake-demo/record 2>/dev/null; then
      ready=1
      break
    fi
    if ! kill -0 "$driver_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  if [ "$ready" -ne 1 ]; then
    echo "::error::the wake driver never reached the recording handshake ($take)"
    cat "$dir/instrument.txt" || true
    kill "$logcat_pid" 2> /dev/null || true
    return 1
  fi

  adb shell screenrecord --bit-rate 8000000 --time-limit 175 "/sdcard/$video" &
  local recorder_pid=$!
  sleep 1
  adb shell run-as "$app_id" touch files/wake-demo/recording

  # Until the driver says it is done (it stays alive a little longer so the last frames are of the
  # browser) or dies; renderer kills are served along the way.
  local listing
  for _ in $(seq 1 1000); do
    listing=$(adb shell run-as "$app_id" ls files/wake-demo 2>/dev/null | tr -d '\r' || true)
    if grep -qx done <<< "$listing"; then
      break
    fi
    for request in $(grep -o 'kill-renderer-[0-9]*' <<< "$listing"); do
      n=${request#kill-renderer-}
      if ! grep -qx "renderer-killed-$n" <<< "$listing"; then
        kill_renderer "$n"
      fi
    done
    if ! kill -0 "$driver_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  local driver_status=0
  wait "$driver_pid" || driver_status=$?
  sleep 2
  kill "$logcat_pid" 2> /dev/null || true

  adb pull "/sdcard/$video" "$dir/$video" || true
  for name in $(adb shell run-as "$app_id" ls files/wake-demo | tr -d '\r'); do
    case "$name" in
      *.png | *.txt) adb exec-out run-as "$app_id" cat "files/wake-demo/$name" > "$dir/$name" ;;
    esac
  done

  # What the app, the WebView and the system saw, for the record.
  grep -E "WakeDemo|ZenChrome|ZenHost|ZenTab|ZenBridge|chromium|cr_ChildProcess|RenderProcess|wm_on_(stop|start|resume|paused|restart|destroy|create)_called|LifecycleMonitor|am_kill|am_proc_died|am_proc_start|lowmemorykiller|Killing|zenium|deviceidle|DeviceIdle|screen_toggled|Keyguard" \
    "$dir/logcat.txt" > "$dir/wake-logcat.txt" || true

  echo "---- report ($take)"
  cat "$dir/report.txt" || true
  echo "---- instrumentation ($take)"
  cat "$dir/instrument.txt"
  ls -la "$dir"
  return "$driver_status"
}

status=0
if [ -n "${BEFORE_APK_DIR:-}" ]; then
  before_apk=$(find "$BEFORE_APK_DIR" -name '*.apk' -print -quit)
  if [ -z "$before_apk" ]; then
    echo "::error::no APK under $BEFORE_APK_DIR for the before take"
    exit 1
  fi
  echo "before: $before_apk"
  run_take before "$before_apk" false || echo "the before take reported failures (expected where the bug reproduces)"
  adb shell am force-stop "$app_id" || true
  sleep 2
fi

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
echo "app: $apk"
run_take after "$apk" "${WAKE_ASSERT:-false}" || status=$?

kill "$monitor_pid" 2> /dev/null || true
grep -q '^OK (' "$out/after/instrument.txt"
exit "$status"
