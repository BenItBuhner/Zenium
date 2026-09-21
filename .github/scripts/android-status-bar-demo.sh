#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs a debug APK and the status
# bar driver (the StatusBarDemo instrumentation), records the screen while the driver boots the
# chrome on a profile with a boot document over the inline limit (the condition of Bennett's
# 0.3.79 report), flips the dock and the scheme, leaves a fullscreen video, turns the screen off
# and on and scales the system font, and collects the recording, the stills, the driver's notes
# and the logs under artifacts/android-status-bar-demo/<take>/.
#
# Two takes when BEFORE_APK_DIR names a directory with an APK built from main (the workflow's
# setup-script builds it): `before` (that APK, notes only) and `after` (this checkout's APK).
# STATUS_BAR_ASSERT=true makes the driver fail the `after` take when a claim does not hold (the
# regression check); anything else only reports.
#
# Handshake with the driver, through files in the app's private storage (readable via run-as):
#   files/media-demo/record     – written by the driver once the browser is up
#   files/media-demo/recording  – written here once screenrecord is rolling
#   files/media-demo/done       – written by the driver when the sequence is over
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
demo_dir=media-demo
out=artifacts/android-status-bar-demo
mkdir -p "$out"

adb wait-for-device
nproc
free -m

# Host watchdog: the emulator's death leaves a marker the workflow reads (the shared recipe).
(
  while true; do
    if ! pgrep -f qemu-system-x86_64 > /dev/null; then
      echo "qemu gone at $(date +%T)" > "$out/emulator-died"
      break
    fi
    sleep 5
  done
) &
monitor_pid=$!

adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
# Gesture navigation, as on Bennett's phone: the bottom inset is the gesture bar's.
adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural || true
sleep 2
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
adb shell wm size | tee "$out/display.txt" || true
adb shell wm density | tee -a "$out/display.txt" || true
adb shell dumpsys webviewupdate | grep -E "Current WebView package" | tee -a "$out/display.txt" || true

test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "driver: $test_apk"

# Install `apk`, run the driver with `assert` while recording into `take`'s directory.
run_take() {
  local take=$1 apk=$2 assert=$3
  local dir="$out/$take" video="android-status-bar-$take.mp4"
  mkdir -p "$dir"
  echo "==== take $take: $apk (assert=$assert)"
  # -d: the before take may carry a lower versionCode than this checkout's.
  if ! adb install -r -d -g "$apk" || ! adb install -r -d -g "$test_apk"; then
    echo "::error::could not install the APKs for the $take take"
    return 1
  fi
  adb shell dumpsys package "$app_id" | grep -E "versionName|versionCode" | head -n 2 | tee "$dir/version.txt" || true

  adb logcat -c || true
  adb logcat -v time > "$dir/logcat.txt" &
  local logcat_pid=$!

  adb shell run-as "$app_id" rm -rf "files/$demo_dir" || true

  adb shell am instrument -w -e class app.zen.chromium.StatusBarDemo -e assert "$assert" "$runner" > "$dir/instrument.txt" 2>&1 &
  local driver_pid=$!

  local ready=0
  for _ in $(seq 1 1200); do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/record" 2> /dev/null; then
      ready=1
      break
    fi
    if ! kill -0 "$driver_pid" 2> /dev/null; then
      break
    fi
    sleep 0.25
  done
  if [ "$ready" -ne 1 ]; then
    echo "::error::the status bar driver never reached the recording handshake ($take)"
    cat "$dir/instrument.txt" || true
    kill "$logcat_pid" 2> /dev/null || true
    return 1
  fi

  adb shell screenrecord --bit-rate 6000000 --time-limit 180 "/sdcard/$video" &
  local recorder_pid=$!
  sleep 1
  adb shell run-as "$app_id" touch "files/$demo_dir/recording"

  for _ in $(seq 1 1600); do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/done" 2> /dev/null; then
      break
    fi
    if ! kill -0 "$driver_pid" 2> /dev/null; then
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
  for name in $(adb shell run-as "$app_id" ls "files/$demo_dir" | tr -d '\r'); do
    case "$name" in
      *.png | *.txt) adb exec-out run-as "$app_id" cat "files/$demo_dir/$name" > "$dir/$name" ;;
    esac
  done
  grep -E "StatusBarDemo|ZenChrome|ZenHost|zen-safebrowsing|zen-blocking|wm_on_(stop|start|resume|paused|destroy|create)_called" \
    "$dir/logcat.txt" > "$dir/status-bar-logcat.txt" || true

  echo "---- notes ($take)"
  cat "$dir/android-status-bar-notes.txt" || true
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
run_take after "$apk" "${STATUS_BAR_ASSERT:-false}" || status=$?

kill "$monitor_pid" 2> /dev/null || true
grep -q '^OK (' "$out/after/instrument.txt"
exit "$status"
