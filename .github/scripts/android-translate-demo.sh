#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: serves the translate demo's fixture
# pages (the Spanish and German test articles under the instrumentation assets) to the emulator,
# which reaches the runner's loopback as 10.0.2.2, then hands over to the shared demo driver with
# the translate instrumentation selected, and finally collects the driver's measurements
# (translate-results.json) next to the recording and the screenshots.
#
# TRANSLATE_SEQUENCE picks the driver: `engine` (default) speaks to the core through
# window.zen.invoke and measures the engine on its own; `ui` works the translate bar, the pill
# glyph, the options sheet and Settings > Languages in the phone chrome with real touches.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
fixtures=android/app/src/androidTest/assets/translate
case "${TRANSLATE_SEQUENCE:-engine}" in
  ui)
    export DEMO_CLASS=app.zen.chromium.TranslateUiDemo
    export DEMO_VIDEO=services-translate-android-ui-demo.mp4
    ;;
  *)
    export DEMO_CLASS=app.zen.chromium.TranslateDemo
    export DEMO_VIDEO=services-translate-android-demo.mp4
    ;;
esac
export DEMO_DIR=translate-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-translate-demo}
mkdir -p "$DEMO_OUT"
server_log=$PWD/$DEMO_OUT/fixtures-server.txt

(cd "$fixtures" && python3 -m http.server 8766 --bind 127.0.0.1 > "$server_log" 2>&1) &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8766/es.html > /dev/null; then break; fi
  sleep 0.25
done
curl -sf http://127.0.0.1:8766/de.html > /dev/null
echo "fixtures served on 127.0.0.1:8766 (10.0.2.2 inside the emulator)"

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

adb exec-out run-as "$app_id" cat "files/$DEMO_DIR/translate-results.json" > "$DEMO_OUT/translate-results.json" 2>/dev/null || true
grep -E "TranslateDemo|TranslateUiDemo|ZenTranslate|translate" "$DEMO_OUT/logcat.txt" | tail -n 300 > "$DEMO_OUT/translate-logcat.txt" || true
cat "$DEMO_OUT/translate-results.json" 2>/dev/null || echo "no translate-results.json"
exit "$status"
