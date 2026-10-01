#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the page-edge band demo. Makes sure
# another browser holds the role so the default-browser reminder has something to ask for, then
# hands over to the shared driver script with the BandDemo instrumentation as the sequence.
# Everything lands under $DEMO_OUT (artifacts/android-band-demo/ on the demo's own workflow; the
# nightly names the driver's directory).
set -euo pipefail

adb wait-for-device

# The shared script disables Chrome with the other Google apps; with no other browser installed
# Android hands Zenium the role by itself and the campaign stays silent – no banner, no band for
# the demo's first scene. Chrome stays enabled (it is never started) and holds the role
# throughout; the nightly runner puts both back after a driver that `needs` the browser role.
adb shell pm enable --user 0 com.android.chrome > /dev/null 2>&1 || true
adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER com.android.chrome || true
echo "browser role: $(adb shell cmd role get-role-holders --user 0 android.app.role.BROWSER 2>/dev/null || echo unknown)"

export DEMO_KEEP=com.android.chrome
export DEMO_CLASS=app.zen.chromium.BandDemo
export DEMO_DIR=band-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-band-demo}
export DEMO_VIDEO=${DEMO_VIDEO:-android-band-demo.mp4}
exec bash .github/scripts/android-gesture-demo.sh
