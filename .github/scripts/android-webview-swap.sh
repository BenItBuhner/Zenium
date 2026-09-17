#!/usr/bin/env bash
# Replaces the emulator's preinstalled WebView with a Chromium snapshot build so the probe and the
# demo run on a current Chromium (isolated-world injection needs 146+; the API 34 images bundle
# something much older). Usage: android-webview-swap.sh <SystemWebView.apk> <out dir>
#
# Only works on an AOSP ("default") image booted with -writable-system: the snapshot APK is the
# package the image preinstalls (com.android.webview) but signed with another key, and the
# package manager refuses such an update even on a debuggable build. So the preinstalled copy is
# removed from the (remounted) system partition, the framework restarted so the package list is
# rescanned, the snapshot installed as an ordinary app, and the WebView update service pointed at
# it (on userdebug builds it does not check provider signatures). Best effort: any failure leaves
# the image's own WebView in place and the caller carries on.
set -euo pipefail

apk=$1
out=$2

boot_completed() {
  [ "$(adb shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = "1" ]
}

wait_for_boot() {
  adb wait-for-device
  for _ in $(seq 1 120); do
    if boot_completed; then return 0; fi
    sleep 2
  done
  echo "boot did not complete"
  return 1
}

echo "webview before swap:"
adb shell dumpsys webviewupdate | tee "$out/webviewupdate-before.txt" | head -n 20 || true
adb shell getprop ro.debuggable
adb shell getprop ro.build.type

adb root
sleep 3
adb wait-for-device

path=$(adb shell pm path com.android.webview | tr -d '\r' | sed 's/^package://' | head -n 1)
echo "preinstalled com.android.webview: ${path:-none}"

remount_output=$(adb remount 2>&1 || true)
echo "$remount_output"
if echo "$remount_output" | grep -qi "reboot"; then
  # Verity or overlayfs setup wants a reboot before the partition is writable.
  adb reboot
  sleep 5
  wait_for_boot
  adb root
  sleep 3
  adb wait-for-device
  adb remount
fi

if [ -n "$path" ]; then
  dir=$(dirname "$path")
  echo "removing $dir"
  adb shell rm -rf "$dir"
  # Restart the framework so the package manager forgets the removed system app.
  adb shell "setprop sys.boot_completed 0; stop; sleep 2; start"
  sleep 5
  wait_for_boot
  sleep 10
fi

adb install -r -g "$apk"
adb shell cmd webviewupdate set-webview-implementation com.android.webview || true
sleep 5
echo "webview after swap:"
adb shell dumpsys webviewupdate | tee "$out/webviewupdate-after.txt" | head -n 20
adb shell dumpsys webviewupdate | grep -qi "current webview package.*com.android.webview"
