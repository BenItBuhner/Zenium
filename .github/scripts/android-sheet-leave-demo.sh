#!/usr/bin/env bash
# Runs the sheet leave demo (SheetLeaveDemo: the sheets whose request goes before they do – the
# app menu sent `menu.hide` by a second popup, the icon picker cancelled, the lower sheet of a
# stack closed by the host, a core-owned prompt withdrawn by its page) through the shared driver
# script, then cuts the recording into frames around every event the driver marked and reads the
# whole recording at the recorder's frame rate with the recede demo's judge
# (android-sheet-recede-frames.mjs): the page band's darkness against the progress swatch the
# driver put into the chrome, and never the window gradient where the page should be. The
# driver's own judgement – the chrome's poses read while each leave ran (leave-findings.txt) –
# is what tells a leave from a vanish; the video judge tells the page keeping step with its
# sheets. The driver's `marks.txt` gives the time of each event from the start of its sequence,
# which begins about 2.5 s into the video (see android-sheet-recede-demo.sh). The run fails when
# the driver's judgement did, or when the video shows a frame of the window gradient or the page
# out of step with its sheets.
set -euo pipefail

export DEMO_CLASS=app.zen.chromium.SheetLeaveDemo
export DEMO_DIR=sheet-leave-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-sheet-leave-demo}
export DEMO_VIDEO=${DEMO_VIDEO:-android-motion-sheets-leave.mp4}

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

video=$DEMO_OUT/$DEMO_VIDEO
if [ -f "$video" ] && [ -f "$DEMO_OUT/marks.txt" ] && command -v ffmpeg > /dev/null; then
  mkdir -p "$DEMO_OUT/frames"
  while read -r ms name _kind; do
    [ -n "${ms:-}" ] && [ -n "${name:-}" ] || continue
    start=$(awk -v ms="$ms" 'BEGIN { s = (ms + 2500) / 1000 - 0.5; if (s < 0) s = 0; printf "%.2f", s }')
    # -nostdin: ffmpeg would otherwise read the rest of marks.txt as its console.
    ffmpeg -nostdin -loglevel error -ss "$start" -t 7 -i "$video" -vf fps=10 "$DEMO_OUT/frames/$name-%03d.jpg" || true
  done < "$DEMO_OUT/marks.txt"
  ls "$DEMO_OUT/frames" | wc -l
  if [ -f "$DEMO_OUT/geometry.txt" ]; then
    node .github/scripts/android-sheet-recede-frames.mjs "$video" "$DEMO_OUT/marks.txt" "$DEMO_OUT/geometry.txt" \
      "$DEMO_OUT/video-findings.txt" || { echo "::error::the recording shows the swap, or the page out of step with its sheets (see video-findings.txt)"; status=1; }
    tail -n 40 "$DEMO_OUT/video-findings.txt" || true
  fi
fi
if [ -f "$DEMO_OUT/leave-findings.txt" ]; then
  echo "== the driver's poses (leave-findings.txt), last lines"
  tail -n 60 "$DEMO_OUT/leave-findings.txt" || true
fi
exit $status
