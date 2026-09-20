#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: hands over to the shared demo driver
# with the text tools instrumentation selected (the spell check group on a WebView host, the page
# zoom steps and Force enable zoom, Apply dark theme to sites, a sleeping tab waking from the
# overview – every control inside a panel under a real finger), then collects the driver's
# findings (text-tools-results.json) and its logcat lines next to the recording and the stills.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
export DEMO_CLASS=app.zen.chromium.TextToolsUiDemo
export DEMO_VIDEO=services-text-tools-android-demo.mp4
export DEMO_DIR=text-tools-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-text-tools-demo}
# The dark theme for sites only acts under a dark chrome (WebView's algorithmic darkening).
export DEMO_THEME=${DEMO_THEME:-dark}
mkdir -p "$DEMO_OUT"

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

adb exec-out run-as "$app_id" cat "files/$DEMO_DIR/text-tools-results.json" > "$DEMO_OUT/text-tools-results.json" 2>/dev/null || true
grep -E "TextToolsUiDemo|TOUCH FAULT|probe:" "$DEMO_OUT/logcat.txt" | tail -n 300 > "$DEMO_OUT/text-tools-logcat.txt" || true
cat "$DEMO_OUT/text-tools-results.json" 2>/dev/null || echo "no text-tools-results.json"
exit "$status"
