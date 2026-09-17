#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs the debug APK and a demo
# driver (an instrumentation class such as GestureDemo), records the screen while the driver
# performs its sequence, and collects the recording, the screenshots and the logs under the
# artifacts directory.
#
# Which demo runs is chosen through the environment (defaults are the URL-pill gesture demo):
#   DEMO_CLASS  – instrumentation class to run
#   DEMO_DIR    – handshake directory under the app's files/
#   DEMO_OUT    – where the artifacts go
#   DEMO_VIDEO  – file name of the recording
#   DEMO_THEME  – colour scheme a driver seeds its profile with (`light` or `dark`), passed to
#                 the instrumentation as the `theme` argument; drivers without a theme ignore it
#
# Handshake with the driver, through files in the app's private storage (readable via run-as):
#   files/<DEMO_DIR>/record     – written by the driver once its warm-up is done
#   files/<DEMO_DIR>/recording  – written here once screenrecord is rolling
#   files/<DEMO_DIR>/done       – written by the driver when the sequence is over
set -euo pipefail

# applicationId of the debug build (android/app/build.gradle.kts); the instrumentation APK is
# "<applicationId>.test" and the driver classes keep the Kotlin package app.zen.chromium.
app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
demo_class=${DEMO_CLASS:-app.zen.chromium.GestureDemo}
demo_dir=${DEMO_DIR:-gesture-demo}
out=${DEMO_OUT:-artifacts/android-gesture-demo}
video=${DEMO_VIDEO:-android-gestures-device-demo.mp4}
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
        ls -laR /tmp/android-runner 2>&1 || true
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
# No "isn't responding" dialogs over the browser (the launcher re-inflating at the new density
# is slow enough to trigger one); restart it cleanly instead.
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
echo "app: $apk"
echo "driver: $test_apk"
adb install -r -g "$apk"
adb install -r -g "$test_apk"

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

adb shell am instrument -w -e class "$demo_class" -e theme "${DEMO_THEME:-light}" "$runner" > "$out/instrument.txt" 2>&1 &
driver_pid=$!

ready=0
for _ in $(seq 1 1200); do
  if adb shell run-as "$app_id" test -f "files/$demo_dir/record" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$driver_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "::error::the gesture driver never reached the recording handshake"
  cat "$out/instrument.txt" || true
  sleep 6
  kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true
  cat "$out/host-monitor.txt" || true
  exit 1
fi

adb shell screenrecord --bit-rate 8000000 --time-limit 170 "/sdcard/$video" &
recorder_pid=$!
sleep 1
adb shell run-as "$app_id" touch "files/$demo_dir/recording"

# Stop recording when the driver says it is done (it stays alive a little longer so the app is
# still on screen), or when it dies.
for _ in $(seq 1 720); do
  if adb shell run-as "$app_id" test -f "files/$demo_dir/done" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$driver_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
wait "$recorder_pid" || true
wait "$driver_pid" || true
sleep 2
kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true

adb pull "/sdcard/$video" "$out/$video"
for name in $(adb shell run-as "$app_id" ls "files/$demo_dir" | tr -d '\r'); do
  case "$name" in
    *.png) adb exec-out run-as "$app_id" cat "files/$demo_dir/$name" > "$out/$name" ;;
  esac
done

cat "$out/instrument.txt"
ls -la "$out"
grep -q '^OK (' "$out/instrument.txt"
