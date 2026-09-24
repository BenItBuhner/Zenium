#!/usr/bin/env bash
# The P0 rule's record for a change near the boot path: MainActivity's cold start under a BASE
# build and under the HEAD build on the same emulator boot – `am start -W` after `am force-stop`,
# P0_RUNS times each (five by default), the medians of TotalTime (the system's time from the
# start request to the activity's first frame) and WaitTime side by side. Runs on the workflow
# runner once the emulator has booted (android-emulator-demo.yml's `script`), like the demo
# drivers; the device is prepared the way android-gesture-demo.sh prepares it (the same display,
# three-button navigation, the bundled Google apps disabled) so the numbers are the recipe's own.
#
#   P0_BASE_APK   – the base build's debug APK (the caller's setup-script built it from the base ref)
#   P0_BASE_LABEL – how the base is named in the table (its commit), `base` by default
#   P0_HEAD_LABEL – how the head is named, `head` by default
#   P0_RUNS       – measured cold starts per build, 5 by default (one more, discarded, pays for
#                   the install's dexopt and the profile's first run)
#   DEMO_OUT      – where the record goes (cold-start-pair.txt and the raw am start output)
#
# Each build is installed over the other (`adb install -r -d`: the same applicationId, so the
# profile stays and both boot the same state; -d since the base may carry the newer version code
# when main has moved past the branch), started once to settle, then force-stopped and started
# P0_RUNS times. The table is written to the job summary too.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
activity=app.zen.chromium.MainActivity
runs=${P0_RUNS:-5}
out=${DEMO_OUT:-artifacts/android-cold-start-pair}
base_apk=${P0_BASE_APK:?P0_BASE_APK must name the APK of the base build}
head_apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
mkdir -p "$out"
[ -f "$base_apk" ] || { echo "::error::no base APK at $base_apk"; exit 1; }
[ -n "$head_apk" ] || { echo "::error::no head APK under android/app/build/outputs/apk/debug"; exit 1; }
echo "base: $base_apk ($(sha256sum "$base_apk" | cut -c1-12))"
echo "head: $head_apk ($(sha256sum "$head_apk" | cut -c1-12))"

adb wait-for-device
if [ "$(adb get-state 2> /dev/null || true)" != "device" ]; then
  echo "adb lost the device before the pair ran" > "$out/emulator-died"
  exit 1
fi

# The demos' device (android-gesture-demo.sh): the same display, no error dialogs, the buttons.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3
adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
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
sleep 45

# One cold start: the process gone, the launcher in front, then the start with -W; the lines of
# its answer (Status, LaunchState, TotalTime, WaitTime).
cold_start() {
  adb shell am force-stop "$app_id"
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
  sleep 3
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/$activity" | tr -d '\r'
}

# Measure one build: install, settle on one discarded start, then $runs measured cold starts.
# Writes `<name>.txt` (every am start answer) and echoes the TotalTime and WaitTime lists.
measure() {
  local name=$1 apk=$2 label=$3
  echo "== $name ($label): $apk"
  adb install -r -d -g "$apk"
  : > "$out/$name-am-start.txt"
  cold_start > /dev/null
  sleep 8
  adb shell am force-stop "$app_id"
  totals=()
  waits=()
  states=()
  for i in $(seq 1 "$runs"); do
    answer=$(cold_start)
    printf 'run %s\n%s\n\n' "$i" "$answer" >> "$out/$name-am-start.txt"
    total=$(printf '%s\n' "$answer" | sed -n 's/^TotalTime: *//p' | head -n 1)
    wait_=$(printf '%s\n' "$answer" | sed -n 's/^WaitTime: *//p' | head -n 1)
    state=$(printf '%s\n' "$answer" | sed -n 's/^LaunchState: *//p' | head -n 1)
    echo "  run $i: TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}"
    totals+=("${total:-0}")
    waits+=("${wait_:-0}")
    states+=("${state:-?}")
    # The chrome and the core boot on after the first frame: let them, so the next start is cold
    # from a quiet device rather than from a boot still in flight.
    sleep 10
  done
  adb shell am force-stop "$app_id"
}

median() {
  printf '%s\n' "$@" | sort -n | awk '{ a[NR] = $1 } END { if (NR % 2) print a[(NR + 1) / 2]; else print (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}

join() { local IFS=' '; echo "$*"; }

measure before "$base_apk" "${P0_BASE_LABEL:-base}"
before_totals=("${totals[@]}"); before_waits=("${waits[@]}"); before_states=("${states[@]}")
measure after "$head_apk" "${P0_HEAD_LABEL:-head}"
after_totals=("${totals[@]}"); after_waits=("${waits[@]}"); after_states=("${states[@]}")

before_total=$(median "${before_totals[@]}")
after_total=$(median "${after_totals[@]}")
before_wait=$(median "${before_waits[@]}")
after_wait=$(median "${after_waits[@]}")

{
  echo "MainActivity cold start, am start -W after am force-stop, $runs runs each on one emulator boot (medians in ms)"
  echo "device: $(adb shell getprop ro.build.fingerprint | tr -d '\r'); display $(adb shell wm size | tr -d '\r' | sed 's/.*: //') at $(adb shell wm density | tr -d '\r' | sed 's/.*: //') dpi"
  echo
  echo "| build | TotalTime median | WaitTime median | TotalTime runs | LaunchState |"
  echo "| --- | --- | --- | --- | --- |"
  echo "| before (${P0_BASE_LABEL:-base}) | $before_total | $before_wait | $(join "${before_totals[@]}") | $(join "${before_states[@]}") |"
  echo "| after (${P0_HEAD_LABEL:-head}) | $after_total | $after_wait | $(join "${after_totals[@]}") | $(join "${after_states[@]}") |"
  echo
  echo "delta (after - before): TotalTime $(awk -v a="$after_total" -v b="$before_total" 'BEGIN { print a - b }') ms, WaitTime $(awk -v a="$after_wait" -v b="$before_wait" 'BEGIN { print a - b }') ms"
} | tee "$out/cold-start-pair.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### MainActivity cold start, before / after"; echo; cat "$out/cold-start-pair.txt"; } >> "$GITHUB_STEP_SUMMARY"
fi
