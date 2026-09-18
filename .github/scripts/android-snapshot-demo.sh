#!/usr/bin/env bash
# Runs the snapshot-swap demo (SnapshotSwapDemo) through the shared driver script, then cuts the
# recording into frames around every surface the driver opened. The driver's `marks.txt` gives
# the time of each tap from the start of its sequence, which begins about 2.5 s into the video:
# the recorder starts, a second later the handshake file appears, the driver waits another 1.5 s.
# Each window runs from 0.6 s before the tap to 3 s after it, at 20 frames a second (50 ms steps).
set -euo pipefail

export DEMO_CLASS=app.zen.chromium.SnapshotSwapDemo
export DEMO_DIR=snapshot-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-snapshot-demo}
export DEMO_VIDEO=${DEMO_VIDEO:-android-chassis-snapshot-swap.mp4}

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

video=$DEMO_OUT/$DEMO_VIDEO
if [ -f "$video" ] && [ -f "$DEMO_OUT/marks.txt" ] && command -v ffmpeg > /dev/null; then
  mkdir -p "$DEMO_OUT/frames"
  while read -r ms name; do
    [ -n "${ms:-}" ] && [ -n "${name:-}" ] || continue
    start=$(awk -v ms="$ms" 'BEGIN { s = (ms + 2500) / 1000 - 0.6; if (s < 0) s = 0; printf "%.2f", s }')
    # -nostdin: ffmpeg would otherwise read the rest of marks.txt as its console.
    ffmpeg -nostdin -loglevel error -ss "$start" -t 3.6 -i "$video" -vf fps=20 "$DEMO_OUT/frames/$name-%03d.jpg" || true
  done < "$DEMO_OUT/marks.txt"
  ls "$DEMO_OUT/frames" | wc -l
fi
exit $status
