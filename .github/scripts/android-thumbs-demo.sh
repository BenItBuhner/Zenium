#!/usr/bin/env bash
# Runs the tab card thumbnails demo in two acts around a process death, each through the shared
# driver script (android-gesture-demo.sh), because a driver shares the app's process and cannot
# outlive `am force-stop`:
#
#   act one   ThumbsDemo: three one-colour pages visited by pill flings, the overview's cards read
#             against the pages' colours, a card tapped with a real touch, a background tab
#             navigated (its card must show the placeholder, never the page it left: BH-14), the
#             navigated tab shown and left (its card refreshed), home and back (the picture on
#             the way to the background), the cost of every picture in the log and the process's
#             memory before and after;
#   the kill  `am force-stop` of the browser (the instrumentation's exit stops it already; this
#             makes the death explicit), the recording parts cleared;
#   act two   ThumbsRestoreDemo: the profile and the cache kept, the pages answered 40 s late, the
#             restored overview pulled in before any page could have painted – the cards must
#             already show their pictures from disk (BH-33; the files stamped with their
#             documents), a file of another page planted under a live tab's id must be refused
#             and then replaced once the page was seen – and a stale picture planted under an id
#             the session lacks must be gone (the sweep at boot).
#
# Each act's video, screenshots, findings and logs land under act-1/ and act-2/ of DEMO_OUT; the
# lines the browser logs for each picture (size, bytes, copy and encode time) are gathered into
# capture-cost.txt. The run fails when either act's judgements did. A second invocation of the
# shared script repeats its device setup (about a minute and a half); reinstalling the APKs keeps
# the app's data and cache, which is what act two is about.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-thumbs-demo}
mkdir -p "$out"

status=0
DEMO_CLASS=app.zen.chromium.ThumbsDemo DEMO_DIR=thumbs-demo DEMO_OUT=$out/act-1 \
  DEMO_VIDEO=android-thumbs-cards.mp4 bash .github/scripts/android-gesture-demo.sh || status=$?
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
DEMO_CLASS=app.zen.chromium.ThumbsRestoreDemo DEMO_DIR=thumbs-restore-demo DEMO_OUT=$out/act-2 \
  DEMO_VIDEO=android-thumbs-restore.mp4 bash .github/scripts/android-gesture-demo.sh || status2=$?
if [ -f "$out/act-2/emulator-died" ]; then
  cp "$out/act-2/emulator-died" "$out/emulator-died"
  echo "::error::the emulator went away during act two"
fi

{
  echo "== act one"
  grep -h 'thumbnail of' "$out/act-1/logcat.txt" 2> /dev/null || echo "(no picture logged)"
  echo "== act two"
  grep -h 'thumbnail of' "$out/act-2/logcat.txt" 2> /dev/null || echo "(no picture logged)"
} > "$out/capture-cost.txt"
for act in act-1 act-2; do
  if [ -f "$out/$act/thumbs-findings.txt" ]; then
    echo "== $act findings"
    cat "$out/$act/thumbs-findings.txt"
  fi
done
echo "== pictures"
cat "$out/capture-cost.txt"

[ "$status" -eq 0 ] || exit "$status"
exit "$status2"
