#!/usr/bin/env bash
# The performance program's menu sheet profile (perf-program.md, PERF-2): runs MenuSheetPerfDemo
# through the shared driver script, then reads what it captured into one Markdown report.
#
# Before the driver: the Perfetto config (android-perf-trace.pbtxt) goes to
# /data/misc/perfetto-configs (the one directory the shell may write and `perfetto` may read;
# under /data/local/tmp SELinux refused perfetto the file, silently: run 35540328965), where the
# instrumentation starts `perfetto` on it around its scenes. The driver runs its
# measured scenes in the warm-up, before the recorder rolls, so the handshake is given the time
# they take (DEMO_HANDSHAKE_S); the recorded part is the short sequence for the media.
#
# After the driver: the shared script has pulled the `.txt` files (framestats-<scene>.txt, the
# probe's chrome-<scene>.json.txt, scenes.txt, the findings); this one pulls the WebView traces
# (webview-<scene>.json.gz) and the Perfetto trace (/data/misc/perfetto-traces), and runs the
# readers: android-framestats.mjs (HWUI's frames per scene and half-cycle), android-webview-
# trace.mjs (the chrome renderer's main thread per motion and frame) and android-perf-trace.py
# (the frame timeline, HWUI's threads, binder, CPU per thread). The report lands in
# $DEMO_OUT/menu-perf-report.md and in the job summary. A reader that fails leaves its note in
# the report without failing the run; the run's status is the driver's.
#
# Environment (all optional): DEMO_OUT, DEMO_VIDEO, DEMO_THEME, DEMO_ARGS (`-e cycles 3 -e live 0`).
set -euo pipefail

export DEMO_CLASS=app.zen.chromium.MenuSheetPerfDemo
export DEMO_DIR=menu-perf-demo
export DEMO_OUT=${DEMO_OUT:-artifacts/android-menu-perf}
export DEMO_VIDEO=${DEMO_VIDEO:-android-menu-perf.mp4}
export DEMO_HANDSHAKE_S=${DEMO_HANDSHAKE_S:-1800}
app_id=io.github.benitbuhner.zenium.debug
mkdir -p "$DEMO_OUT"

adb wait-for-device
adb shell rm -f /data/local/tmp/menu-perf.pbtxt || true
adb push .github/scripts/android-perf-trace.pbtxt /data/misc/perfetto-configs/menu-perf.pbtxt \
  || echo "the Perfetto config could not be pushed to /data/misc/perfetto-configs; the driver falls back to the atrace form"
adb shell ls -l /data/misc/perfetto-configs/ || true
# A stale trace from an earlier boot must not pass for this run's.
adb shell rm -f /data/misc/perfetto-traces/menu-perf.perfetto-trace || true
adb shell getprop ro.build.version.release > "$DEMO_OUT/android-version.txt" 2>&1 || true
adb shell dumpsys webviewupdate 2> /dev/null | grep -E 'Current WebView package|versionName' | head -n 3 > "$DEMO_OUT/webview-version.txt" || true

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

# What the shared script does not pull: the traces.
for name in $(adb shell run-as "$app_id" ls "files/$DEMO_DIR" 2> /dev/null | tr -d '\r'); do
  case "$name" in
    *.gz | *.json) adb exec-out run-as "$app_id" cat "files/$DEMO_DIR/$name" > "$DEMO_OUT/$name" || true ;;
  esac
done
adb pull /data/misc/perfetto-traces/menu-perf.perfetto-trace "$DEMO_OUT/menu-perf.perfetto-trace" 2>&1 || echo "no Perfetto trace to pull"
ls -la "$DEMO_OUT"

report=$DEMO_OUT/menu-perf-report.md
{
  echo "# Zenium Android menu sheet profile"
  echo
  echo "Emulator (software GPU: composite and swap cost more than on a phone; the before / after on this one recipe is the evidence, the main thread's work is representative)."
  echo "Android $(cat "$DEMO_OUT/android-version.txt" 2> /dev/null | tr -d '\r'); WebView: $(tr -d '\r' < "$DEMO_OUT/webview-version.txt" 2> /dev/null | tr '\n' ' ')"
  echo
  if [ -f "$DEMO_OUT/menu-perf-findings.txt" ]; then
    echo '## The driver'
    echo
    echo '```'
    cat "$DEMO_OUT/menu-perf-findings.txt"
    echo '```'
    echo
  fi
  echo '## HWUI frames (dumpsys gfxinfo framestats)'
  echo
  node .github/scripts/android-framestats.mjs "$DEMO_OUT" --json "$DEMO_OUT/framestats.json" 2>&1 || echo "_the framestats reader failed_"
  echo
  echo '## The chrome renderer (WebView trace)'
  echo
  node --max-old-space-size=8192 .github/scripts/android-webview-trace.mjs "$DEMO_OUT" --json "$DEMO_OUT/webview-trace.json" 2>&1 || echo "_the WebView trace reader failed_"
  echo
  echo '## The system (Perfetto)'
  echo
  if [ -s "$DEMO_OUT/menu-perf.perfetto-trace" ]; then
    python3 .github/scripts/android-perf-trace.py "$DEMO_OUT/menu-perf.perfetto-trace" "$DEMO_OUT/scenes.txt" --json "$DEMO_OUT/perfetto.json" 2>&1 || echo "_the Perfetto reader failed_"
  else
    echo "_no Perfetto trace_"
  fi
} > "$report" 2>&1 || true
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >> "$GITHUB_STEP_SUMMARY" || true
fi
tail -n 120 "$report" || true
exit $status
