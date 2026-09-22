#!/usr/bin/env bash
# Runs the Cookies and site data UI demo in two acts around a process death, each through the
# shared driver script (android-gesture-demo.sh), because a driver shares the app's process and
# cannot outlive `am force-stop`:
#
#   act one   SiteDataUiDemo: a loopback page that sets two cookies with every visit and says
#             what the request carried; the site-information sheet's cookies level for it;
#             Settings › Privacy and Security › Cookies and site data – the default's picker
#             (Block all cookies, browser-wide, and back), the never list's Add sheet with the
#             site's host typed in, the row it makes; the page reloaded and asking with no
#             cookies; the sheet's cookies level reading the never state and its picker moving
#             the site to "Clear when Zenium closes"; the allow list's Add and a row's Remove;
#             the viewer with a row's Clear and Clear all's prompt cancelled; the on-exit type
#             "Browsing history" switched on; the page holding its cookies again, the jar flushed
#             and the app sent home – the pending-clear marker written by the core on the way;
#   the kill  `am force-stop` of the browser (the instrumentation's exit stops it already; this
#             makes the death explicit), the recording parts cleared;
#   act two   SiteDataRestoreDemo: the profile kept, the cold start with the marker and the
#             restored session – the first request the restored page makes must carry no cookie,
#             the document must hold none, the control site on no list keeps its cookies, no
#             history entry from before the close remains, the marker is consumed; the sheet's
#             cookies level after the restore.
#
# Both acts hold the core's startup sweeps (`-e holdBackgroundWork true`, #313) so the filter
# lists' and Safe Browsing feeds' downloads do not land in the measured sheet scenes. Each act's
# video, screenshots, findings and frame statistics land under act-1/ and act-2/ of DEMO_OUT (the
# shared workflow renders every frames.jsonl under the artifact path). The run fails when either
# act's judgements did. A second invocation of the shared script repeats its device setup (about
# a minute and a half); reinstalling the APKs keeps the app's data, which is what act two is about.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-site-data-ui-demo}
mkdir -p "$out"

status=0
# DEMO_DIR is each act's handshake directory: the one its driver class names (SiteDataUiDemo.kt).
DEMO_CLASS=app.zen.chromium.SiteDataUiDemo DEMO_DIR=site-data-ui-demo DEMO_OUT=$out/act-1 \
  DEMO_VIDEO=services-site-data-android-ui.mp4 DEMO_ARGS="-e holdBackgroundWork true" \
  bash .github/scripts/android-gesture-demo.sh || status=$?
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
echo "== the marker the core left (files/zen/sitedata.json)"
adb shell run-as "$app_id" cat files/zen/sitedata.json 2> /dev/null | tee "$out/sitedata-between-acts.json" || echo "(no sitedata.json)"
echo
adb shell rm -f '/sdcard/demo-part-*.mp4' || true

status2=0
DEMO_CLASS=app.zen.chromium.SiteDataRestoreDemo DEMO_DIR=site-data-restore-demo DEMO_OUT=$out/act-2 \
  DEMO_VIDEO=services-site-data-android-restore.mp4 DEMO_ARGS="-e holdBackgroundWork true" \
  bash .github/scripts/android-gesture-demo.sh || status2=$?
if [ -f "$out/act-2/emulator-died" ]; then
  cp "$out/act-2/emulator-died" "$out/emulator-died"
  echo "::error::the emulator went away during act two"
fi

for act in act-1 act-2; do
  for notes in "$out/$act"/*-notes.txt; do
    [ -f "$notes" ] || continue
    echo "== $act $(basename "$notes")"
    cat "$notes"
  done
done

[ "$status" -eq 0 ] || exit "$status"
exit "$status2"
