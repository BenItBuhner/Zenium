#!/usr/bin/env bash
# Runs the Settings tab preview demo in two acts around a process death, each through the shared
# driver script (android-gesture-demo.sh), because a driver shares the app's process and cannot
# outlive `am force-stop`:
#
#   act one   SettingsTabPreviewDemo: Settings from the app menu, Updates drilled in, the overview
#             and the Settings card's picture read for the section; a real touch on the card (the
#             page it lands on); Privacy and Security › See all site data for the drill-in page,
#             the overview and the card read for it, the tap, the round trip repeated (what the
#             tab keeps), a back to the section beneath; the tab left on the drill-in page;
#   the kill  `am force-stop` of the browser (the instrumentation's exit stops it already; this
#             makes the death explicit), the recording parts cleared;
#   act two   SettingsTabPreviewRestoreDemo: the profile and the cache kept, the restored tab
#             must be on the drill-in page, its card's picture read from disk for the page's
#             address, a tap on the card landing there, a back to the section beneath.
#
# Each act's video, screenshots, findings and logs land under act-1/ and act-2/ of DEMO_OUT. The
# run fails when either act's judgements did. Reinstalling the APKs keeps the app's data and
# cache, which is what act two is about.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-settings-tab-preview-demo}
mkdir -p "$out"

status=0
DEMO_CLASS=app.zen.chromium.SettingsTabPreviewDemo DEMO_DIR=settings-tab-preview-demo DEMO_OUT=$out/act-1 \
  DEMO_VIDEO=android-settings-tab-preview.mp4 bash .github/scripts/android-gesture-demo.sh || status=$?
if [ -f "$out/act-1/emulator-died" ]; then
  cp "$out/act-1/emulator-died" "$out/emulator-died"
  echo "::error::the emulator went away during act one"
  exit "$status"
fi
[ "$status" -eq 0 ] || echo "::error::act one's driver failed (status $status); act two runs on what it left"

echo "== the process death between the acts"
adb shell am force-stop "$app_id" || true
sleep 2
adb shell pidof "$app_id" && echo "::warning::the browser is still running after force-stop" || echo "browser process gone"
adb shell rm -f '/sdcard/demo-part-*.mp4' || true

status2=0
DEMO_CLASS=app.zen.chromium.SettingsTabPreviewRestoreDemo DEMO_DIR=settings-tab-preview-restore-demo DEMO_OUT=$out/act-2 \
  DEMO_VIDEO=android-settings-tab-preview-restore.mp4 bash .github/scripts/android-gesture-demo.sh || status2=$?
if [ -f "$out/act-2/emulator-died" ]; then
  cp "$out/act-2/emulator-died" "$out/emulator-died"
  echo "::error::the emulator went away during act two"
fi

for act in act-1 act-2; do
  if [ -f "$out/$act/settings-tab-preview-findings.txt" ]; then
    echo "== $act findings"
    cat "$out/$act/settings-tab-preview-findings.txt"
  fi
done

[ "$status" -eq 0 ] || exit "$status"
exit "$status2"
