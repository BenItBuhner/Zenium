#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the first-run demo. Installs the
# debug APK and clears its profile (`pm clear`: the first run starts from nothing, and a fresh
# emulator has nothing to clear, but the recording should not have to take that on trust), makes
# sure another browser holds the role so Zenium has something to ask for, then hands over to the
# shared driver script with the FirstRunDemo instrumentation as the sequence. Everything lands
# under artifacts/android-firstrun-demo/.
set -euo pipefail

# applicationId of the debug build (android/app/build.gradle.kts).
app_id=io.github.benitbuhner.zenium.debug

adb wait-for-device
apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
echo "app: $apk"
adb install -r -g "$apk"
adb shell pm clear "$app_id"

# The shared script disables Chrome with the other Google apps; with no other browser installed
# Android hands Zenium the role by itself and there is no dialog to record. Chrome stays enabled
# (it is never started) and holds the role when the demo begins.
adb shell pm enable --user 0 com.android.chrome > /dev/null 2>&1 || true
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER com.android.chrome || true
echo "browser role: $(adb shell cmd role get-role-holders --user 0 android.app.role.BROWSER 2>/dev/null || echo unknown)"

export DEMO_KEEP=com.android.chrome
export DEMO_CLASS=app.zen.chromium.FirstRunDemo
export DEMO_DIR=firstrun-demo
export DEMO_OUT=artifacts/android-firstrun-demo
export DEMO_VIDEO=android-firstrun-demo.mp4
exec bash .github/scripts/android-gesture-demo.sh
