#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the new tab page morph drivers
# (FakeboxMorphDemoBase.kt), two on the one boot, each through android-gesture-demo.sh, so that one
# job records the motion and its reduced-motion form on the same engine. Each driver's recording,
# stills, findings and per-frame rows land under its own directory of the artifact; summary.txt at
# the root says which passed, and the script fails when any did not.
#
#   MORPH_ACT   – which act this boot records:
#                 `space`   FakeboxMorphDemo then FakeboxMorphReducedDemo (the space page in
#                           portrait, on the image's own WebView, as the other phone demos run);
#                 `private` FakeboxMorphScrubDemo then FakeboxMorphScrubReducedDemo (the private
#                           page in landscape, which needs the Chromium snapshot WebView: private
#                           tabs need MULTI_PROFILE, which the API 34 image's WebView 113 lacks)
#   MORPH_OUT   – where the artifacts go (a directory per driver below it)
#   WEBVIEW_APK – the snapshot SystemWebView.apk for the private act, swapped in by the shared
#                 script on the first driver (an AOSP image booted with -writable-system)
#
# Reduced motion. Chromium reads Android's animator duration scale into `prefers-reduced-motion`
# ONCE per process (ui/android's Animation.prefersReducedMotion, cached; the loading demo saw a
# live change ignored), so the reduced driver runs in a fresh process: the scale is set to 0 after
# the first driver's data is cleared (`pm clear` stops the process) and put back to 1 after. The
# driver refuses to record when the WebView still reports the query unmatched
# (REDUCED_MOTION_NOT_REPORTED in instrument.txt, before the recording handshake); this script
# then forces the query through the WebView's command-line file (/data/local/tmp/webview-command-line,
# read on the emulator's userdebug images) and runs the driver once more, keeping the first
# attempt's output beside it. The file is removed afterwards either way.
#
# Between the two drivers the app's data is cleared and the recording's parts are taken off
# /sdcard; the device is prepared once, by the first run of the shared script (DEMO_PREPARED). A
# driver that failed does not stop the one after it; the chain stops when the emulator itself
# went away (the shared script's emulator-died marker, copied to the artifact's root so the
# workflow can boot once more).
set -uo pipefail

act=${MORPH_ACT:-space}
out=${MORPH_OUT:-artifacts/android-ntp-morph-demo}
app_id=io.github.benitbuhner.zenium.debug
cmdline_file=/data/local/tmp/webview-command-line
mkdir -p "$out"

# class, handshake directory under the app's files/, whether it runs under reduced motion.
case "$act" in
  space)
    drivers=(
      "FakeboxMorphDemo ntp-morph-demo 0"
      "FakeboxMorphReducedDemo ntp-morph-reduced-demo 1"
    )
    ;;
  private)
    drivers=(
      "FakeboxMorphScrubDemo ntp-morph-scrub-demo 0"
      "FakeboxMorphScrubReducedDemo ntp-morph-scrub-reduced-demo 1"
    )
    ;;
  *)
    echo "::error::MORPH_ACT must be 'space' or 'private', not '$act'"
    exit 1
    ;;
esac

# The three scales `disable-animations` would set for a whole job, set here for one driver.
animation_scales() {
  for setting in animator_duration_scale transition_animation_scale window_animation_scale; do
    adb shell settings put global "$setting" "$1" > /dev/null 2>&1 || true
  done
}

# The app as its own workflow would start it: data cleared (the shared script reinstalls with -g,
# so the permissions come back), no process, the recording's parts gone.
fresh_app() {
  adb shell pm clear "$app_id" > /dev/null 2>&1 || true
  adb shell rm -f '/sdcard/demo-part-*' > /dev/null 2>&1 || true
}

run_driver() { # class, handshake directory
  DEMO_CLASS=app.zen.chromium.$1 DEMO_DIR=$2 DEMO_OUT=$out/$2 DEMO_VIDEO=$2.mp4 DEMO_THEME=light \
    DEMO_PREPARED=$prepared WEBVIEW_APK=${WEBVIEW_APK:-} bash .github/scripts/android-gesture-demo.sh
}

summary=$out/summary.txt
: > "$summary"
echo "new tab page morph, act '$act'" >> "$summary"
failed=0
prepared=0
for spec in "${drivers[@]}"; do
  read -r class dir reduced <<< "$spec"
  note=""
  if [ "$reduced" = 1 ]; then
    animation_scales 0
    echo "animator, transition and window animation scales set to 0 for $class"
  fi
  started=$(date +%s)
  echo "::group::$class"
  run_driver "$class" "$dir"
  status=$?
  echo "::endgroup::"
  prepared=1
  if [ "$reduced" = 1 ] && [ "$status" -ne 0 ] && [ ! -f "$out/$dir/emulator-died" ] \
    && grep -q REDUCED_MOTION_NOT_REPORTED "$out/$dir/instrument.txt" 2> /dev/null; then
    echo "::warning::$class: the WebView did not report prefers-reduced-motion under animator_duration_scale 0; forcing the query through $cmdline_file and running once more"
    mv "$out/$dir" "$out/$dir-scale-only"
    adb shell "echo '_ --force-prefers-reduced-motion' > $cmdline_file"
    fresh_app
    echo "::group::$class (forced prefers-reduced-motion)"
    run_driver "$class" "$dir"
    status=$?
    echo "::endgroup::"
    note="  (prefers-reduced-motion forced through the WebView's command-line file: the animator scale alone was not read)"
  fi
  if [ "$reduced" = 1 ]; then
    animation_scales 1
    adb shell rm -f "$cmdline_file" > /dev/null 2>&1 || true
  fi
  took=$(( $(date +%s) - started ))
  if [ -f "$out/$dir/emulator-died" ]; then
    printf '%-30s DIED  %4ds  the emulator went away under the driver\n' "$class" "$took" | tee -a "$summary"
    cp "$out/$dir/emulator-died" "$out/emulator-died"
    failed=1
    break
  fi
  if [ "$status" -eq 0 ]; then
    printf '%-30s PASS  %4ds%s\n' "$class" "$took" "$note" | tee -a "$summary"
  else
    failed=1
    reason=$(grep -m1 -E 'check\(s\) failed|touch\(es\) did not take|REDUCED_MOTION|did not take|Error|Exception|never reached' "$out/$dir/instrument.txt" 2> /dev/null \
      | sed -E 's/^INSTRUMENTATION_STATUS: (stack|stream)=//' | head -c 400)
    printf '%-30s FAIL  %4ds  %s%s\n' "$class" "$took" "${reason:-see $dir/instrument.txt}" "$note" | tee -a "$summary"
    echo "::error::$class did not pass: ${reason:-see $dir/instrument.txt}"
  fi
  # The verdict lines, one per check, are the run's result: surface them in the job log.
  for findings in "$out/$dir"/*-findings.txt; do
    [ -f "$findings" ] || continue
    echo "::group::$class findings"
    cat "$findings"
    echo "::endgroup::"
  done
  fresh_app
done

echo "== new tab page morph: the drivers on this boot"
cat "$summary"
exit "$failed"
