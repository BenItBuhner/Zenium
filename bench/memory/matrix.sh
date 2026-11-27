#!/bin/sh
# Run the benchmark matrix: every browser x preset, RUNS times, rounds interleaved so that a
# slow patch of network hits every browser alike; then the 512 MB capped runs at 200 tabs.
#   BROWSERS="zenium chromium firefox edge" PRESETS="50 100 200" RUNS=3 CAP_PRESET=200 sh matrix.sh
set -u
cd "$(dirname "$0")/../.."
BROWSERS=${BROWSERS:-"zenium chromium firefox edge"}
PRESETS=${PRESETS:-"50 100 200"}
RUNS=${RUNS:-3}
CAP_PRESET=${CAP_PRESET:-200}
OUT=${OUT:-bench/memory/results}
export FIREFOX_EXTRA_CA=${FIREFOX_EXTRA_CA:-}
for r in $(seq 1 "$RUNS"); do
  for p in $PRESETS; do
    for b in $BROWSERS; do
      echo "round $r preset $p $b"
      node bench/memory/run.mjs --browser "$b" --preset "$p" --out "$OUT" ${EXTRA:-}
      sleep 5
    done
  done
  if [ -n "$CAP_PRESET" ]; then
    for b in $BROWSERS; do
      echo "round $r preset $CAP_PRESET $b capped 512"
      node bench/memory/run.mjs --browser "$b" --preset "$CAP_PRESET" --cap 512 --out "$OUT" ${EXTRA:-}
      sleep 5
    done
  fi
done
