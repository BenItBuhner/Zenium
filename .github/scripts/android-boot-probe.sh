#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted (android-boot-probe.yml): the boot
# handoff's before / after measurement. The same instrumentation driver (BootHandoffProbe) runs
# against two APKs – the one built from main (BEFORE_APK, prepared by the workflow's setup script)
# and the one built from the branch – warming a profile up first (a first run installs the bundled
# lists and snapshots), then booting twice and measuring: the time to the chrome's `window.zen`,
# the host's storage writes during the boot, the request engine's rebuilds, and each transport
# replayed in the chrome (boot-probe.js). The two results are tabulated into summary.md and the
# step summary.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
out=artifacts/android-boot-probe
before_apk=${BEFORE_APK:-artifacts/before/app-debug.apk}
mkdir -p "$out"

adb wait-for-device
nproc
free -m

# Host watchdog: memory every few seconds, and the kernel log the moment the emulator process
# disappears (a silent death is most likely the OOM killer or a renderer crash).
(
  while true; do
    {
      date +%T
      free -m | sed -n '2p'
      ps -o pid=,rss=,pcpu=,comm= -C qemu-system-x86_64 || true
    } >> "$out/host-monitor.txt"
    if ! pgrep -f qemu-system-x86_64 > /dev/null; then
      {
        echo "EMULATOR PROCESS GONE"
        sudo dmesg 2> /dev/null | tail -n 80 || true
      } >> "$out/host-monitor.txt"
      break
    fi
    sleep 5
  done
) &
monitor_pid=$!

# The same 411 CSS px wide layout a Pixel 6 gets, at fewer pixels.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true

# The Google APIs image spends its first minutes starting every bundled Google app; none of them
# are needed and they fight the browser for the emulator's CPU and memory.
for pkg in \
  com.google.android.youtube com.google.android.apps.youtube.music com.google.android.gm \
  com.google.android.apps.messaging com.android.chrome com.google.android.apps.maps \
  com.google.android.videos com.google.android.apps.photos com.google.android.googlequicksearchbox \
  com.google.android.calendar com.google.android.apps.docs com.google.android.apps.wellbeing \
  com.google.android.projection.gearhead com.google.android.apps.tachyon com.google.android.talk \
  com.google.android.music com.google.android.apps.podcasts com.google.android.apps.nbu.files; do
  adb shell pm disable-user --user 0 "$pkg" > /dev/null 2>&1 || true
done
adb shell am kill-all || true
echo "letting the system settle"
sleep 40
free -m

after_apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "before: $before_apk ($(cat artifacts/before/sha.txt 2> /dev/null || echo 'sha unknown'))"
echo "after:  $after_apk ($(git rev-parse HEAD))"
echo "driver: $test_apk"
if [ ! -f "$before_apk" ]; then
  echo "::error::no APK built from main at $before_apk"
  kill "$monitor_pid" 2> /dev/null || true
  exit 1
fi

# One probe pass: install the APK, warm a profile up, then boot and measure twice.
probe() {
  local label=$1 apk=$2 run
  echo "=== $label: $apk"
  adb install -r -g "$apk"
  adb install -r -g "$test_apk"
  adb shell am force-stop "$app_id" || true
  adb shell pm clear "$app_id" > /dev/null || true
  adb logcat -c || true
  adb shell am instrument -w -e class app.zen.chromium.BootHandoffProbe -e phase warm "$runner" > "$out/instrument-$label-warm.txt" 2>&1 || true
  tail -n 3 "$out/instrument-$label-warm.txt"
  adb shell am force-stop "$app_id" || true
  sleep 3
  for run in 1 2; do
    adb shell am instrument -w -e class app.zen.chromium.BootHandoffProbe -e phase measure "$runner" > "$out/instrument-$label-$run.txt" 2>&1 || true
    tail -n 3 "$out/instrument-$label-$run.txt"
    adb exec-out run-as "$app_id" cat files/boot-probe/results.json > "$out/results-$label-$run.json" 2> /dev/null || true
    adb shell am force-stop "$app_id" || true
    sleep 3
  done
  adb logcat -d -v time > "$out/logcat-$label.txt" 2> /dev/null || true
  adb logcat -c || true
}

probe before "$before_apk"
probe after "$after_apk"

kill "$monitor_pid" 2> /dev/null || true

echo "--- results"
# The two heads the table compares, beside the results they came from.
cat artifacts/before/sha.txt > "$out/before-sha.txt" 2> /dev/null || echo "unknown" > "$out/before-sha.txt"
git rev-parse HEAD > "$out/after-sha.txt"
ls -la "$out"
node .github/scripts/android-boot-probe-table.mjs "$out" | tee "$out/summary.md"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$out/summary.md" >> "$GITHUB_STEP_SUMMARY"
fi
for f in "$out"/results-before-2.json "$out"/results-after-2.json; do
  if [ ! -s "$f" ]; then
    echo "::error::no results from the probe: $f"
    exit 1
  fi
done
