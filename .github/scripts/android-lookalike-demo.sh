#!/usr/bin/env bash
# TEMPORARY – the lookalike demo's wrapper around android-gesture-demo.sh (see
# android-lookalike-demo.yml). The engine judges the registrable domain, so the scene's sites must
# be named gogle.com, paypa1.com and amazom.com and still reach the driver's loopback server: the
# WebView's command-line file (read when the WebView initialises, in ZenApplication.onCreate –
# before any test code runs, so the driver cannot write it itself) maps the three hosts to the
# server's port with Chromium's host-resolver rules. Removed after the run, as
# android-ntp-morph-demo.sh removes its own.
set -euo pipefail

cmdline_file=/data/local/tmp/webview-command-line
adb shell "echo '_ --host-resolver-rules=\"MAP gogle.com 127.0.0.1:18124,MAP paypa1.com 127.0.0.1:18124,MAP amazom.com 127.0.0.1:18124\"' > $cmdline_file"
echo "webview-command-line: $(adb shell cat $cmdline_file | tr -d '\r')"

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?
adb shell rm -f "$cmdline_file" > /dev/null 2>&1 || true
exit $status
