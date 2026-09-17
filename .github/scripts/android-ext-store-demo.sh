#!/usr/bin/env bash
# Driver for the extension store demo (android-ext-store-demo.yml): puts uBlock Origin's
# .chromium.zip, fetched by the workflow's setup-script, into the app's private storage for the
# sideload step, samples the memory of every Zenium process (the app and the WebView renderers)
# while the shared demo script records ExtensionStoreDemo, then collects what the engine left
# behind: the driver's results.json, the registry document, the install tree, the package cache
# and the store's log lines.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-ext-store-demo}
zip=${SIDELOAD_ZIP:-artifacts/ext/uBlock0.chromium.zip}
mkdir -p "$out"

adb wait-for-device

# run-as needs the (debuggable) app installed; the shared script installs it again with -r,
# which keeps the app's data and with it the pushed package.
apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
adb install -r -g "$apk"
adb push "$zip" /data/local/tmp/uBlock0.chromium.zip
adb shell run-as "$app_id" mkdir -p files/ext-store-input
adb shell run-as "$app_id" cp /data/local/tmp/uBlock0.chromium.zip files/ext-store-input/uBlock0.chromium.zip
adb shell run-as "$app_id" ls -la files/ext-store-input

# RSS of every Zenium process every 2 s: the app (Kotlin streams packages to disk) and the
# chrome's renderer (the core holds a package's bytes while it verifies and reads them).
(
  while true; do
    stamp=$(date +%T)
    adb shell ps -A -o PID,RSS,NAME 2> /dev/null | grep "$app_id" | sed "s/^/$stamp /" >> "$out/memory-samples.txt" || true
    sleep 2
  done
) &
memory_pid=$!

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?
kill "$memory_pid" 2> /dev/null || true

echo "--- peak RSS per process (KB)"
awk '{ if ($3 + 0 > peak[$4] + 0) peak[$4] = $3 } END { for (p in peak) printf "%10d KB  %s\n", peak[p], p }' \
  "$out/memory-samples.txt" | sort -rn | tee "$out/memory-peaks.txt" || true

echo "--- results.json"
adb exec-out run-as "$app_id" cat files/ext-store-demo/results.json > "$out/results.json" || true
cat "$out/results.json" || true
echo
echo "--- files/zen/extensions.json"
adb exec-out run-as "$app_id" cat files/zen/extensions.json > "$out/extensions.json" || true
cat "$out/extensions.json" || true
echo
echo "--- files/zen/extensions"
adb shell run-as "$app_id" find files/zen/extensions -maxdepth 2 | tee "$out/install-tree.txt" || true
echo "--- cache/ext-packages (should be empty after the run)"
adb shell run-as "$app_id" ls -la cache/ext-packages | tee "$out/package-cache.txt" || true
echo "--- store log lines"
grep -E 'ZenExtStore|ZenPackageFetcher|\[zen\] extensions' "$out/logcat.txt" > "$out/store-log.txt" || true
cat "$out/store-log.txt" || true

exit "$status"
