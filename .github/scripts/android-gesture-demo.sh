#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs the debug APK and the gesture
# driver (the GestureDemo instrumentation), records the screen while the driver performs the
# gestures, and collects the recording, the screenshots and the logs under
# artifacts/android-gesture-demo/.
#
# Handshake with the driver, through files in the app's private storage (readable via run-as):
#   files/gesture-demo/record     – written by the driver once its warm-up is done
#   files/gesture-demo/recording  – written here once screenrecord is rolling
#   files/gesture-demo/done       – written by the driver when the sequence is over
set -euo pipefail

app_id=app.zen.chromium.debug
runner=app.zen.chromium.debug.test/androidx.test.runner.AndroidJUnitRunner
out=artifacts/android-gesture-demo
video=android-gestures-device-demo.mp4
mkdir -p "$out"

adb wait-for-device
# Three-button navigation: no system gesture zone under the bar, so no accidental home swipes.
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
sleep 2

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "app: $apk"
echo "driver: $test_apk"
adb install -r -g "$apk"
adb install -r -g "$test_apk"

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

adb shell am instrument -w -e class app.zen.chromium.GestureDemo "$runner" > "$out/instrument.txt" 2>&1 &
driver_pid=$!

ready=0
for _ in $(seq 1 1200); do
  if adb shell run-as "$app_id" test -f files/gesture-demo/record 2>/dev/null; then
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
  kill "$logcat_pid" 2>/dev/null || true
  exit 1
fi

# The display is scaled to 720 px wide to keep the file small; the aspect ratio is the device's.
adb shell screenrecord --size 720x1600 --bit-rate 6000000 --time-limit 170 "/sdcard/$video" &
recorder_pid=$!
sleep 1
adb shell run-as "$app_id" touch files/gesture-demo/recording

# Stop recording when the driver says it is done (it stays alive a little longer so the app is
# still on screen), or when it dies.
for _ in $(seq 1 720); do
  if adb shell run-as "$app_id" test -f files/gesture-demo/done 2>/dev/null; then
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
kill "$logcat_pid" 2>/dev/null || true

adb pull "/sdcard/$video" "$out/$video"
for name in $(adb shell run-as "$app_id" ls files/gesture-demo | tr -d '\r'); do
  case "$name" in
    *.png) adb exec-out run-as "$app_id" cat "files/gesture-demo/$name" > "$out/$name" ;;
  esac
done

cat "$out/instrument.txt"
ls -la "$out"
grep -q '^OK (' "$out/instrument.txt"
