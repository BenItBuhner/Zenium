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

# adbd restarted as root, judged by adbd's own word. `adb root` is racy: the daemon drops the
# connection while it restarts, and the client sometimes exits non-zero with "adb: unable to
# connect for root: closed" although adbd does come back as root – W6-D13's nightly run
# 36276326980 died on that line, under `set -e`, before the swap was attempted. So the request is
# best effort, the daemon waited for (bounded), and what counts is `adb shell id` saying uid=0,
# asked a few times while adbd comes back; a second round covers a request the restart swallowed.
# An image whose adbd cannot run as root (a production build) fails here, with its word in the
# log, and the caller decides (fatal for a demo that needs the snapshot engine, a warning for the
# sweeps).
become_root() {
  local round reply
  for round in 1 2; do
    reply=$(timeout 60 adb root 2>&1 || true)
    echo "adb root: ${reply:-(no reply)}"
    if echo "$reply" | grep -qi "cannot run as root"; then
      echo "adbd cannot run as root on this image; the swap needs a writable system partition"
      return 1
    fi
    sleep 3
    if ! timeout 60 adb wait-for-device; then
      echo "the device did not come back within 60s of adb root"
      return 1
    fi
    for _ in 1 2 3 4 5; do
      if adb shell id 2> /dev/null | tr -d '\r' | grep -q '^uid=0('; then
        echo "adbd running as root: $(adb shell id 2> /dev/null | tr -d '\r')"
        return 0
      fi
      sleep 2
    done
    echo "adbd not root after round $round: $(adb shell id 2> /dev/null | tr -d '\r' || echo 'no reply')"
  done
  echo "adbd did not come back as root"
  return 1
}

echo "webview before swap:"
adb shell dumpsys webviewupdate | tee "$out/webviewupdate-before.txt" | head -n 20 || true
adb shell getprop ro.debuggable
adb shell getprop ro.build.type

become_root

path=$(adb shell pm path com.android.webview | tr -d '\r' | sed 's/^package://' | head -n 1)
echo "preinstalled com.android.webview: ${path:-none}"

remount_output=$(adb remount 2>&1 || true)
echo "$remount_output"
if echo "$remount_output" | grep -qi "reboot"; then
  # Verity or overlayfs setup wants a reboot before the partition is writable.
  adb reboot
  sleep 5
  wait_for_boot
  become_root
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
