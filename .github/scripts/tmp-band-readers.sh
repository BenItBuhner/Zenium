#!/usr/bin/env bash
# TEMPORARY (W6-S26-d, the review fold of PR #735): the four §9.33 readers migrated onto the
# page-edge band – ReaderEntryDemo, OfflineHungDemo, PwaDemo, FirstRunDemo – on one emulator boot,
# each through its own workflow's script and environment (the nightly manifest's entries, by hand:
# the manifest and its shards are not edited for this run), the device put back to the shard's
# baseline between them as the nightly runner does (android-nightly-drivers.sh). The first-run
# demo goes last: its wrapper enables Chrome and hands it the browser role, and with Chrome holding
# the role the default-browser reminder (a state band, which outranks an offer) would stand in the
# other three drivers' way. Removed with its workflow before the PR is final.
set -uo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${TMP_OUT:-artifacts/tmp-band-readers}
display=720x1600@280
mkdir -p "$out"
results=$out/results.txt
: > "$results"

adb wait-for-device
echo "the device: $(adb shell getprop ro.build.fingerprint | tr -d '\r')"

device_alive() { [ "$(adb get-state 2> /dev/null | tr -d '\r' || true)" = device ]; }

reset_device() {
  adb shell am force-stop "$app_id" > /dev/null 2>&1 || true
  adb shell pm clear "$app_id" > /dev/null 2>&1 || true
  adb shell rm -f '/sdcard/demo-part-*' > /dev/null 2>&1 || true
  adb shell settings put system font_scale 1.0 > /dev/null 2>&1 || true
  adb shell settings put secure enabled_accessibility_services '""' > /dev/null 2>&1 || true
  adb shell settings put secure accessibility_enabled 0 > /dev/null 2>&1 || true
  for setting in animator_duration_scale transition_animation_scale window_animation_scale; do
    adb shell settings put global "$setting" 1 > /dev/null 2>&1 || true
  done
  adb shell rm -f /data/local/tmp/webview-command-line > /dev/null 2>&1 || true
  adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton > /dev/null 2>&1 || true
  adb shell wm size "${display%@*}" > /dev/null 2>&1 || true
  adb shell wm density "${display#*@}" > /dev/null 2>&1 || true
  adb shell input keyevent KEYCODE_WAKEUP > /dev/null 2>&1 || true
  adb shell wm dismiss-keyguard > /dev/null 2>&1 || true
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
}

failure_reason() { # dir
  local file
  for file in $(find "$1" -name 'instrument*.txt' 2> /dev/null | sort); do
    { grep -m1 -E '^(java|kotlin|org|android)\.[A-Za-z0-9_.$]+(Error|Exception)\b' "$file" 2> /dev/null \
      || grep -m1 -E 'check\(s\) failed|touch\(es\) did not take|did not take|Process crashed|INSTRUMENTATION_ABORTED|shortMsg=|Error|Exception' "$file" 2> /dev/null; } \
      | sed -E 's/^INSTRUMENTATION_(STATUS|RESULT): (stack|stream|shortMsg)=//' | tr -d '\r' | head -c 300 | grep . && return 0
  done
  return 1
}

prepared=0
failed=0

run_driver() { # id, script, cap-seconds, relocate-dir-or-empty, NAME=value...
  local id=$1 script=$2 cap=$3 relocate=$4
  shift 4
  local dir=$out/$id
  mkdir -p "$dir"
  [ -n "$relocate" ] && rm -rf "$relocate"
  echo "::group::$id ($script; up to $((cap / 60)) min)"
  local started status took
  started=$(date +%s)
  (
    export DEMO_OUT=$dir DEMO_PREPARED=$prepared DEMO_DISPLAY=$display JANK_GATE=soft DEMO_THEME=light
    local kv
    for kv in "$@"; do export "${kv?}"; done
    timeout -k 30 "$cap" bash "$script"
  )
  status=$?
  took=$(( $(date +%s) - started ))
  echo "::endgroup::"
  if [ -n "$relocate" ] && [ -d "$relocate" ]; then
    cp -a "$relocate/." "$dir/" && rm -rf "$relocate"
  fi
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    adb shell am force-stop "$app_id" > /dev/null 2>&1 || true
    adb shell pkill -INT screenrecord > /dev/null 2>&1 || true
  fi
  local verdict=PASS reason=
  if [ -f "$dir/emulator-died" ] || ! device_alive; then
    verdict=FAIL
    reason="the emulator went away under the driver"
    cp "$dir/emulator-died" "$out/emulator-died" 2> /dev/null || echo "adb lost the device after $id" > "$out/emulator-died"
  elif [ "$status" -ne 0 ]; then
    verdict=FAIL
    reason=$(failure_reason "$dir" || echo "exit status $status")
  fi
  local checks fails
  checks=$(find "$dir" -name '*findings*.txt' -exec cat {} + 2> /dev/null | grep -c -E '\b(PASS|FAIL)\b' || true)
  fails=$(find "$dir" -name '*findings*.txt' -exec cat {} + 2> /dev/null | grep -c -E '\bFAIL\b' || true)
  printf '%-14s %-4s %5ss  findings: %s lines with a verdict, %s FAIL  %s\n' "$id" "$verdict" "$took" "$checks" "$fails" "$reason" | tee -a "$results"
  [ "$verdict" = PASS ] || failed=1
  prepared=1
  if [ -f "$out/emulator-died" ]; then
    echo "::error::$id: the emulator went away; the drivers after it are not run"
    return 3
  fi
  reset_device
  return 0
}

run_driver reader-entry .github/scripts/android-gesture-demo.sh 720 '' \
  DEMO_CLASS=app.zen.chromium.ReaderEntryDemo DEMO_DIR=reader-entry-demo DEMO_VIDEO=reader-entry.mp4 || exit 3
run_driver offline-hung .github/scripts/android-gesture-demo.sh 900 '' \
  DEMO_CLASS=app.zen.chromium.OfflineHungDemo DEMO_DIR=offline-hung-demo DEMO_VIDEO=offline-hung.mp4 || exit 3
run_driver pwa .github/scripts/android-gesture-demo.sh 720 '' \
  DEMO_CLASS=app.zen.chromium.PwaDemo DEMO_DIR=pwa-demo DEMO_VIDEO=pwa.mp4 || exit 3
# The first-run wrapper names its own class, directory, output and DEMO_KEEP, and enables Chrome
# for the browser role; the role is put back after it (the nightly's `browser-role`).
run_driver firstrun .github/scripts/android-firstrun-demo.sh 720 artifacts/android-firstrun-demo || exit 3
adb shell pm disable-user --user 0 com.android.chrome > /dev/null 2>&1 || true
adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER > /dev/null 2>&1 || true

echo "== the four readers on this boot"
cat "$results"
exit "$failed"
