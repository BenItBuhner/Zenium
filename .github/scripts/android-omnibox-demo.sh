#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: records the phone chrome's omnibox and
# the long-press that carries the address bar between the edges of the screen, in two takes –
# the build the workflow was given as "before" (the keyboard bug) and the build under test – and
# joins them into one video under artifacts/android-omnibox-demo/.
#
# Same handshake as android-gesture-demo.sh, through files in the app's private storage:
#   files/gesture-demo/record     – written by the driver once its warm-up is done
#   files/gesture-demo/recording  – written here once screenrecord is rolling
#   files/gesture-demo/done       – written by the driver when the sequence is over
#
# BEFORE_APK_DIR names the directory holding the "before" debug APK (skipped when unset or empty).
set -euo pipefail

# applicationId of the debug build (android/app/build.gradle.kts); the instrumentation APK is
# "<applicationId>.test" and the driver classes keep the Kotlin package app.zen.chromium.
app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
test_class=app.zen.chromium.GestureDemo#omnibox
out=artifacts/android-omnibox-demo
video=omnibox-relocation-demo.mp4
mkdir -p "$out"

adb wait-for-device
nproc
free -m
df -h / /tmp

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

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
before_apk=""
if [ -n "${BEFORE_APK_DIR:-}" ]; then
  before_apk=$(find "$BEFORE_APK_DIR" -name '*.apk' -print -quit || true)
fi
echo "app: $apk"
echo "before: ${before_apk:-none}"
echo "driver: $test_apk"

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

# One take: run the omnibox sequence of the installed build as `scenario`, recording between the
# driver's handshake and its `done`, then collect the video and screenshots.
take() {
  local scenario=$1 limit=$2 clip="$out/take-$1.mp4"
  adb shell run-as "$app_id" rm -rf files/gesture-demo 2> /dev/null || true
  adb shell am instrument -w -e class "$test_class" -e scenario "$scenario" "$runner" > "$out/instrument-$scenario.txt" 2>&1 &
  local driver_pid=$!
  local ready=0
  for _ in $(seq 1 1200); do
    if adb shell run-as "$app_id" test -f files/gesture-demo/record 2> /dev/null; then
      ready=1
      break
    fi
    if ! kill -0 "$driver_pid" 2> /dev/null; then
      break
    fi
    sleep 0.25
  done
  if [ "$ready" -ne 1 ]; then
    echo "::error::the $scenario driver never reached the recording handshake"
    cat "$out/instrument-$scenario.txt" || true
    return 1
  fi
  adb shell screenrecord --bit-rate 8000000 --time-limit "$limit" "/sdcard/take-$scenario.mp4" &
  local recorder_pid=$!
  sleep 1
  adb shell run-as "$app_id" touch files/gesture-demo/recording
  for _ in $(seq 1 800); do
    if adb shell run-as "$app_id" test -f files/gesture-demo/done 2> /dev/null; then
      break
    fi
    if ! kill -0 "$driver_pid" 2> /dev/null; then
      break
    fi
    sleep 0.25
  done
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  wait "$driver_pid" || true
  sleep 2
  adb pull "/sdcard/take-$scenario.mp4" "$clip"
  for name in $(adb shell run-as "$app_id" ls files/gesture-demo | tr -d '\r'); do
    case "$name" in
      *.png) adb exec-out run-as "$app_id" cat "files/gesture-demo/$name" > "$out/$name" ;;
    esac
  done
  cat "$out/instrument-$scenario.txt"
  grep -q '^OK (' "$out/instrument-$scenario.txt"
}

adb install -r -g "$test_apk"
clips=()
if [ -n "$before_apk" ]; then
  adb install -r -d -g "$before_apk"
  take before 60
  clips+=("$out/take-before.mp4")
fi
# The fixed build upgrades the "before" install in place (same debug signer, same profile).
adb install -r -d -g "$apk"
take after 170
clips+=("$out/take-after.mp4")

sleep 2
kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true

# One video: the bug, then the fix and the relocation gestures.
list="$out/clips.txt"
: > "$list"
for clip in "${clips[@]}"; do
  echo "file '$(realpath "$clip")'" >> "$list"
done
ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -c copy "$out/$video" || cp "${clips[-1]}" "$out/$video"
ls -la "$out"
