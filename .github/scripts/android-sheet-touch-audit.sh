#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: the demo drivers whose sheet flows put
# a real finger on a control and assert what it did (the rule in DemoHarness.kt), one after the
# other on the one boot, each through android-gesture-demo.sh, so that one dispatch covers them
# all. Each driver's recording, screenshots and logs land under its own directory of the artifact;
# summary.txt at the root says which passed, and the script fails when any did not.
#
# Between two drivers the app's data is cleared (`pm clear`: the next driver starts from the fresh
# install its own workflow gives it; the shared script's `adb install -g` grants the permissions
# again) and the recording's parts are taken off /sdcard. The device is prepared once, by the
# first run of the shared script (DEMO_PREPARED, see its header).
#
# The list below names the drivers (class, handshake directory, colour scheme), the most telling
# first: a boot lost late in the chain still leaves the earlier results in the artifact. A driver
# that failed does not stop the ones after it; the chain stops only when the emulator itself went
# away (the shared script's emulator-died marker, copied to the artifact's root so the workflow
# can boot once more).
#
#   AUDIT_OUT – where the artifacts go (a directory per driver below it)
set -uo pipefail

out=${AUDIT_OUT:-artifacts/android-sheet-touch-audit}
app_id=io.github.benitbuhner.zenium.debug
mkdir -p "$out"

# class, handshake directory under the app's files/, colour scheme (the driver's own workflow's).
drivers=(
  "PullToRefreshDemo ptr-demo light"
  "PageControlsDemo pagecontrols-demo dark"
  "HistoryBookmarksDemo history-bookmarks-demo light"
  "SettingsTabDemo settings-tab-demo light"
  "ErrorPagesDemo errors-demo light"
  "ShareDemo share-demo light"
  "MenuSheetDemo menu-demo light"
  "SiteInfoDemo siteinfo-demo light"
  "CustomTabsDemo customtabs-demo light"
  "BlockingDemo blocking-demo light"
  "SiteControlsDemo site-controls-demo light"
  "ZoomSheetDemo zoom-demo dark"
  "TouchFixDemo touchfix-demo light"
  "NewTabDemo newtab-demo light"
  "PwaDemo pwa-demo light"
  "InputBackDemo input-back-demo light"
  "SwipeReorderDemo swipe-demo light"
  "DownloadsDemo downloads-demo light"
)

summary=$out/summary.txt
: > "$summary"
failed=0
prepared=0
for spec in "${drivers[@]}"; do
  read -r class dir theme <<< "$spec"
  started=$(date +%s)
  echo "::group::$class"
  DEMO_CLASS=app.zen.chromium.$class DEMO_DIR=$dir DEMO_OUT=$out/$dir DEMO_VIDEO=$dir.mp4 \
    DEMO_THEME=$theme DEMO_PREPARED=$prepared bash .github/scripts/android-gesture-demo.sh
  status=$?
  echo "::endgroup::"
  prepared=1
  took=$(( $(date +%s) - started ))
  if [ -f "$out/$dir/emulator-died" ]; then
    printf '%-22s DIED  %4ds  the emulator went away under the driver\n' "$class" "$took" | tee -a "$summary"
    cp "$out/$dir/emulator-died" "$out/emulator-died"
    failed=1
    break
  fi
  if [ "$status" -eq 0 ]; then
    printf '%-22s PASS  %4ds\n' "$class" "$took" | tee -a "$summary"
  else
    failed=1
    reason=$(grep -m1 -E 'did not take|Error|Exception|never reached' "$out/$dir/instrument.txt" 2> /dev/null \
      | sed -E 's/^INSTRUMENTATION_STATUS: (stack|stream)=//' | head -c 300)
    printf '%-22s FAIL  %4ds  %s\n' "$class" "$took" "${reason:-see $dir/instrument.txt}" | tee -a "$summary"
    echo "::error::$class did not pass: ${reason:-see $dir/instrument.txt}"
  fi
  # The next driver starts as its own workflow would: the app's data cleared (the shared script
  # reinstalls with -g, so the permissions come back) and the recording's parts gone.
  adb shell pm clear "$app_id" > /dev/null 2>&1 || true
  adb shell rm -f '/sdcard/demo-part-*' > /dev/null 2>&1 || true
done

echo "== sheet touch audit: the drivers on this boot"
cat "$summary"
exit "$failed"
