#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: hands over to the shared demo driver
# with the import instrumentation selected (Settings > Import's two file rows under real fingers,
# the system's document picker, the Last import group, the bookmarks overlay on the imported
# folder, the URL field listing an imported bookmark), then collects the driver's findings
# (import-results.json, with the frame stats of every gesture scene under `frames`) and its
# logcat lines next to the recording, the stills and the driver's own text files – the frames
# table (services-import-android-frames.txt) and the raw gfxinfo dumps
# (services-import-android-framestats.txt), which the shared script pulls with the stills.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
export DEMO_CLASS=app.zen.chromium.ImportDemo
export DEMO_VIDEO=services-import-android-demo.mp4
export DEMO_DIR=import-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-import-demo}
mkdir -p "$DEMO_OUT"

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

adb exec-out run-as "$app_id" cat "files/$DEMO_DIR/import-results.json" > "$DEMO_OUT/import-results.json" 2>/dev/null || true
grep -E "ImportDemo|TOUCH FAULT|CLAIM FAILED|FRAMES|closeUrlField|ImportService|TextFiles" "$DEMO_OUT/logcat.txt" | tail -n 400 > "$DEMO_OUT/import-logcat.txt" || true
cat "$DEMO_OUT/import-results.json" 2>/dev/null || echo "no import-results.json"
cat "$DEMO_OUT/services-import-android-frames.txt" 2>/dev/null || echo "no frames table"
exit "$status"
