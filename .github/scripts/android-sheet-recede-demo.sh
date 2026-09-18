#!/usr/bin/env bash
# Runs the sheet recede demo (SheetRecedeDemo) through the shared driver script, then cuts the
# recording into frames around every event the driver marked and measures the page band in the
# video at the recorder's own, finer frame rate (android-sheet-recede-frames.mjs), the way the
# driver measured its screenshots. The driver's `marks.txt` gives the time of each event from
# the start of its sequence, which begins about 2.5 s into the video: the recorder starts, a
# second later the handshake file appears, the driver waits another 1.5 s. Each window of cut
# frames runs from 0.6 s before the event to 3 s after it, at 20 frames a second (50 ms steps).
# The run fails when the driver's own judgement did, or when the video shows what the driver's
# screenshots were too slow to catch: a frame of the window gradient where the page or its
# picture should be, or a step in the page's brightness that no spring made.
set -euo pipefail

export DEMO_CLASS=app.zen.chromium.SheetRecedeDemo
export DEMO_DIR=sheet-recede-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-sheet-recede-demo}
export DEMO_VIDEO=${DEMO_VIDEO:-android-motion-sheets.mp4}

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

video=$DEMO_OUT/$DEMO_VIDEO
if [ -f "$video" ] && [ -f "$DEMO_OUT/marks.txt" ] && command -v ffmpeg > /dev/null; then
  mkdir -p "$DEMO_OUT/frames"
  while read -r ms name _kind; do
    [ -n "${ms:-}" ] && [ -n "${name:-}" ] || continue
    start=$(awk -v ms="$ms" 'BEGIN { s = (ms + 2500) / 1000 - 0.6; if (s < 0) s = 0; printf "%.2f", s }')
    # -nostdin: ffmpeg would otherwise read the rest of marks.txt as its console.
    ffmpeg -nostdin -loglevel error -ss "$start" -t 3.6 -i "$video" -vf fps=20 "$DEMO_OUT/frames/$name-%03d.jpg" || true
  done < "$DEMO_OUT/marks.txt"
  ls "$DEMO_OUT/frames" | wc -l
  if [ -f "$DEMO_OUT/geometry.txt" ]; then
    node .github/scripts/android-sheet-recede-frames.mjs "$video" "$DEMO_OUT/marks.txt" "$DEMO_OUT/geometry.txt" \
      "$DEMO_OUT/video-findings.txt" || { echo "::error::the recording shows the swap or a pop (see video-findings.txt)"; status=1; }
    tail -n 40 "$DEMO_OUT/video-findings.txt" || true
  fi
fi
exit $status
