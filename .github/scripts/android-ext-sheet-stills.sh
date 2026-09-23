#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the two native sheets of the
# extension platform as stills for the design gate, in the light and the dark scheme
# (ExtensionSheetStills, android/app/src/androidTest):
#
#   - the install prompt on the fallback path (ext/ExtensionPromptFallback.kt, a NativePromptSheet):
#     Dark Reader's unpacked folder zipped and handed to the activity's VIEW intent before the
#     chrome is up, so the store's start() installs it with no live window and the prompt is the
#     chassis's, not the renderer's sheet – ext-android-13-prompt-fallback-{light,dark}.png;
#   - the extension sheet (ext/ExtensionSheet.kt) hosting uBlock Origin Lite's popup (a seeded
#     install; Dark Reader's popup stays empty on the phone, its background admitting its own
#     pages by sender.url against runtime.getURL), with its one dp open-path hairline and the
#     token inks – ext-android-13-sheet-popup-{light,dark}.png.
#
# Standalone (a workflow job of its own) it prepares the device, installs the APKs and pushes the
# folders; at the end of android-ext-runtime-demo.sh it runs on the device that script prepared
# (DEVICE_PREPARED=1 SKIP_INSTALL=1). The seeded tab behind the sheets is the probe page
# (http://10.0.2.2:8765/probe.html, ext-demo-state.json), served from the runner here for the
# stills' own run. Environment: EXT_DIR (the unpacked extensions, default artifacts/ext; Dark
# Reader's and uBlock Origin Lite's folders are the ones it needs), STILLS_OUT (default
# artifacts/android-ext-sheet-stills), SOFT_FAIL=1 (report, never fail the job).
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
out=${STILLS_OUT:-artifacts/android-ext-sheet-stills}
ext_dir=${EXT_DIR:-artifacts/ext}
pages=.github/scripts/ext-demo-pages
dark_reader=eimadpbcbfnmbkopoojfekhnkhdbieeh
ubol=ddkjiahejlhfcafbddmgiahcphecmpfh
mkdir -p "$out"

fail() {
  if [ -n "${SOFT_FAIL:-}" ]; then
    echo "::warning::$1 (best effort, not failing the job)"
    exit 0
  fi
  echo "::error::$1"
  exit 1
}

adb wait-for-device

if [ -z "${DEVICE_PREPARED:-}" ]; then
  # The same 411 CSS px wide layout a Pixel 6 gets, at fewer pixels (as the runtime demo).
  adb shell wm size 720x1600
  adb shell wm density 280
  adb shell settings put global hide_error_dialogs 1 || true
  adb shell settings put system screen_off_timeout 2147483647 || true
  adb shell svc power stayon true || true
  adb shell input keyevent KEYCODE_WAKEUP || true
  adb shell wm dismiss-keyguard || true
  for pkg in \
    com.google.android.youtube com.google.android.apps.youtube.music com.google.android.gm \
    com.google.android.apps.messaging com.android.chrome com.google.android.apps.maps \
    com.google.android.videos com.google.android.apps.photos com.google.android.googlequicksearchbox \
    com.google.android.calendar com.google.android.apps.docs com.google.android.apps.wellbeing; do
    adb shell pm disable-user --user 0 "$pkg" > /dev/null 2>&1 || true
  done
  adb shell am kill-all || true
  echo "letting the system settle"
  sleep 30
fi
# The stills start in the light scheme whatever a driver before left.
adb shell cmd uimode night no || true

if [ -z "${SKIP_INSTALL:-}" ]; then
  apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
  test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
  echo "app: $apk"
  echo "driver: $test_apk"
  adb install -r -g "$apk"
  adb install -r -g "$test_apk"
fi

# Dark Reader's folder, flat, as the driver zips it, and uBlock Origin Lite's for the popup; a
# laid-out install a driver before left goes first.
[ -f "$ext_dir/$dark_reader/manifest.json" ] || fail "no unpacked Dark Reader under $ext_dir/$dark_reader (fetch-crx.mjs)"
[ -f "$ext_dir/$ubol/manifest.json" ] || fail "no unpacked uBlock Origin Lite under $ext_dir/$ubol (fetch-crx.mjs)"
adb shell am force-stop "$app_id" || true
adb shell run-as "$app_id" rm -rf "files/zen/extensions/$dark_reader" "files/zen/extensions/$ubol" files/ext-sheets || true
tar -C "$ext_dir" --exclude='*.crx' --exclude='*.zip' --exclude='fetch.json' -cf /tmp/ext-stills.tar "./$dark_reader" "./$ubol"
adb push /tmp/ext-stills.tar /data/local/tmp/ext-stills.tar
adb shell run-as "$app_id" mkdir -p files/zen/extensions
adb shell run-as "$app_id" tar -xf /data/local/tmp/ext-stills.tar -C files/zen/extensions
adb shell rm /data/local/tmp/ext-stills.tar || true

# The probe page behind the sheets, from the runner (the emulator's host loopback is 10.0.2.2);
# the runtime demo's own server is gone by the time it hands over to this script.
http_pid=
if ! curl -sf -o /dev/null http://127.0.0.1:8765/probe.html; then
  python3 -m http.server 8765 --bind 0.0.0.0 --directory "$pages" > "$out/http-server.txt" 2>&1 &
  http_pid=$!
fi

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

# Not recorded; the driver's handshake (files/ext-sheets/record) is answered as soon as it asks.
echo "sheet stills (ExtensionSheetStills)"
adb shell am instrument -w -e class app.zen.chromium.ExtensionSheetStills "$runner" > "$out/instrument.txt" 2>&1 &
driver_pid=$!
for _ in $(seq 1 1200); do
  if adb shell run-as "$app_id" test -f files/ext-sheets/record 2>/dev/null; then
    adb shell run-as "$app_id" touch files/ext-sheets/recording
    break
  fi
  if ! kill -0 "$driver_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
wait "$driver_pid" || true
sleep 2
kill "$logcat_pid" 2> /dev/null || true
[ -n "$http_pid" ] && kill "$http_pid" 2> /dev/null || true

for name in $(adb shell run-as "$app_id" ls files/ext-sheets 2>/dev/null | tr -d '\r'); do
  case "$name" in
    *.png | *.json | *.txt) adb exec-out run-as "$app_id" cat "files/ext-sheets/$name" > "$out/$name" ;;
  esac
done
adb shell cmd uimode night no || true
tail -n 8 "$out/instrument.txt"
if [ -f "$out/results.json" ]; then
  echo "== sheet stills (results.json)"
  cat "$out/results.json"
fi
ls -la "$out"
grep -q '^OK (' "$out/instrument.txt" || fail "the sheet stills driver did not finish cleanly (see instrument.txt)"
