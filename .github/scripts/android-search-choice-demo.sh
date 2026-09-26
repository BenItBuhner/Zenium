#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the EEA search-engine choice screen
# demo (OMN-26). Installs the debug APK and clears its profile (`pm clear`: the first run starts
# from nothing), then hands over to the shared driver script with the SearchChoiceDemo
# instrumentation as the sequence. The driver places the device in Germany itself through the
# tester's override (`debug.zenium.region DE`, DeviceRegion.kt) before its first launch and puts
# "no region" back when its sequence ends; this wrapper puts it back as well when the driver
# never got that far (a timeout cut it), so a driver after this one on the same boot – the
# nightly's shards – meets the device as it was. Everything lands under
# artifacts/android-search-choice-demo/.
set -uo pipefail

# applicationId of the debug build (android/app/build.gradle.kts).
app_id=io.github.benitbuhner.zenium.debug
region_property=debug.zenium.region

reset_region() {
  adb shell setprop "$region_property" - > /dev/null 2>&1 || true
}
trap reset_region EXIT TERM INT

adb wait-for-device
apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
echo "app: $apk"
adb install -r -g "$apk"
adb shell pm clear "$app_id"

export DEMO_CLASS=app.zen.chromium.SearchChoiceDemo
export DEMO_DIR=search-choice-demo
export DEMO_OUT=artifacts/android-search-choice-demo
export DEMO_VIDEO=android-w6-13-search-choice-run.mp4
bash .github/scripts/android-gesture-demo.sh
status=$?
echo "region override after the driver: $(adb shell getprop "$region_property" 2> /dev/null | tr -d '\r')"
exit "$status"
