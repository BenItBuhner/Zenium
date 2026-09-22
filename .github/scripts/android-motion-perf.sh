#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the motion profile (MotionPerfDemo,
# the measured scenes first on a fresh boot, nothing warm before them) and then the functional
# drivers of the surfaces it profiles – the pill's gestures (GestureDemo's `record`) and the
# overview (OverviewDemo) – one after the other on the one boot, each through
# android-gesture-demo.sh, so that one dispatch both measures a head and keeps its surfaces'
# drivers green (perf-program.md: each surface's functional drivers stay green under a perf PR).
# Each driver's recording, screenshots and logs land under its own directory of the artifact
# (the profile's at the root, where the jank report and the release dry-run read it; the report
# walks every frames.jsonl below it); summary.txt at the root says which passed, and the script
# fails when any did not.
#
# Between two drivers the app's data is cleared (`pm clear`: the next driver starts from the
# fresh install its own workflow gives it; the shared script's `adb install -g` grants the
# permissions again) and the recording's parts are taken off /sdcard. The device is prepared once,
# by the first run of the shared script (DEMO_PREPARED, see its header). A driver that failed does
# not stop the ones after it; the chain stops only when the emulator itself went away (the shared
# script's emulator-died marker, copied to the artifact's root so the workflow can boot once more).
#
#   PERF_OUT     – where the artifacts go (the profile's at this root, a directory per functional
#                  driver below it)
#   DEMO_THEME, DEMO_SCENES, DEMO_ARGS, DEMO_HANDSHAKE_S, DEMO_VIDEO – the profile's, as
#                  android-motion-perf.yml sets them
#   PERF_FUNCTIONAL – `0` skips the functional drivers (the profile alone, as the runs before
#                  this script had it)
set -uo pipefail
out=${PERF_OUT:-artifacts/android-motion-perf}
app_id=io.github.benitbuhner.zenium.debug
mkdir -p "$out"
summary=$out/summary.txt
: > "$summary"
failed=0

run_driver() {
  local class=$1 dir=$2 target=$3 video=$4 prepared=$5 args=$6 handshake=$7
  local started status took reason
  started=$(date +%s)
  echo "::group::$class"
  DEMO_CLASS=app.zen.chromium.$class DEMO_DIR=$dir DEMO_OUT=$target DEMO_VIDEO=$video \
    DEMO_THEME=${DEMO_THEME:-light} DEMO_SCENES=${DEMO_SCENES:-all} DEMO_ARGS=$args \
    DEMO_HANDSHAKE_S=$handshake DEMO_PREPARED=$prepared bash .github/scripts/android-gesture-demo.sh
  status=$?
  echo "::endgroup::"
  took=$(( $(date +%s) - started ))
  if [ -f "$target/emulator-died" ]; then
    printf '%-24s DIED  %4ds  the emulator went away under the driver\n' "$class" "$took" | tee -a "$summary"
    [ "$target" != "$out" ] && cp "$target/emulator-died" "$out/emulator-died"
    failed=1
    return 1
  fi
  if [ "$status" -eq 0 ]; then
    printf '%-24s PASS  %4ds\n' "$class" "$took" | tee -a "$summary"
  else
    failed=1
    reason=$(grep -m1 -E 'did not take|Error|Exception|never reached' "$target/instrument.txt" 2> /dev/null \
      | sed -E 's/^INSTRUMENTATION_STATUS: (stack|stream)=//' | head -c 300)
    printf '%-24s FAIL  %4ds  %s\n' "$class" "$took" "${reason:-see $target/instrument.txt}" | tee -a "$summary"
    echo "::error::$class did not pass: ${reason:-see $target/instrument.txt}"
  fi
  # The next driver starts as its own workflow would: the app's data cleared (the shared script
  # reinstalls with -g, so the permissions come back) and the recording's parts gone.
  adb shell pm clear "$app_id" > /dev/null 2>&1 || true
  adb shell rm -f '/sdcard/demo-part-*' > /dev/null 2>&1 || true
  return 0
}

# The profile first: its scenes are measured on the boot's first minutes, before any driver has
# warmed the WebView or left a page behind. Its artifacts at the root, as before this script.
run_driver MotionPerfDemo perf-motion "$out" "${DEMO_VIDEO:-android-perf-motion-light.mp4}" 0 \
  "${DEMO_ARGS:-}" "${DEMO_HANDSHAKE_S:-600}" || { cat "$summary"; exit 1; }

if [ "${PERF_FUNCTIONAL:-1}" != "0" ]; then
  # The surfaces' functional drivers (their own workflows' drivers, their own handshake
  # directories; a class#method picks the sequence). GestureDemo's `record` is the pill's swipe,
  # fling and the overview's pull; OverviewDemo the overview's grid, cards and groups. They run
  # under the shared recipe's three-button navigation, as their own workflows have it: the profile
  # switches the system to gesture navigation for the overview's back scenes and switches it back
  # in its own teardown; this is the guard for a profile that never reached it.
  adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
  run_driver 'GestureDemo#record' gesture-demo "$out/gesture-demo" gesture-demo.mp4 1 "" 300 \
    || { cat "$summary"; exit 1; }
  run_driver OverviewDemo overview-demo "$out/overview-demo" overview-demo.mp4 1 "" 300 \
    || { cat "$summary"; exit 1; }
fi

echo "== motion perf: the drivers on this boot"
cat "$summary"
exit "$failed"
