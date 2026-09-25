#!/usr/bin/env bash
# The P0 rule's record for a change near the boot path: MainActivity's cold start under a BASE
# build and under the HEAD build on the same emulator boot – `am start -W` after `am force-stop`,
# P0_RUNS times each (five by default), the medians of TotalTime (the system's time from the
# start request to the activity's first frame) and WaitTime side by side, with the chrome's own
# READY mark (`Fully drawn`), the splash's hold, the boot's marks and the boot's frame statistics
# (`dumpsys gfxinfo`: ruling 5's main-thread long tasks, none new) where a build has them. Runs
# on the workflow runner once the emulator has booted (android-emulator-demo.yml's `script`), like the demo
# drivers; the device is prepared the way android-gesture-demo.sh prepares it (the same display,
# three-button navigation, the bundled Google apps disabled) so the numbers are the recipe's own.
#
# Two ways in, each build (round 4): `direct` – the shell's `am start` at MainActivity, the pair
# as it was, a start no user makes – and `alias` – the launcher's own intent (MAIN/LAUNCHER,
# NEW_TASK | RESET_TASK_IF_NEEDED) at the enabled icon alias, the tap's path: the alias's target
# starts (the shortcuts' NoDisplay trampoline on a build before round 4, IconTapActivity under
# the splash theme from it) and forwards to MainActivity, one launch to the platform, so
# TotalTime and Fully drawn span the tap to MainActivity's frames. The alias rows are the P0
# rule's reading of the trampoline itself (alias − direct on the same build, and after − before
# on the alias); the direct rows stay comparable with every pair before.
#
#   P0_BASE_APK   – the base build's debug APK (the caller's setup-script built it from the base ref)
#   P0_BASE_LABEL – how the base is named in the table (its commit), `base` by default
#   P0_HEAD_LABEL – how the head is named, `head` by default
#   P0_RUNS       – measured cold starts per build and way, 5 by default (one more, discarded,
#                   pays for the install's dexopt and the profile's first run)
#   DEMO_OUT      – where the record goes (cold-start-pair.txt and the raw am start output)
#
# Each build is installed over the other (`adb install -r -d`: the same applicationId, so the
# profile stays and both boot the same state; -d since the base may carry the newer version code
# when main has moved past the branch), then for each way started once to settle, force-stopped
# and started P0_RUNS times. Every run keeps one clock for both builds (a build without the
# READY mark must not read its frame statistics later, nor start its next run later, than one
# with it): the mark is waited for up to READY_WAIT_S from the start request, the statistics are
# read STATS_AT_S after it whatever the wait found, and the next start comes NEXT_AT_S after it,
# the device quiet and the boot – the chrome and the core boot on after the first frame – long
# over on either. The table is written to the job summary too.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
activity=app.zen.chromium.MainActivity
alias=app.zen.chromium.icon.Indigo
tap_flags=0x10200000
runs=${P0_RUNS:-5}
READY_WAIT_S=12
STATS_AT_S=15
NEXT_AT_S=22
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

# Where every cold start begins: the process gone, the launcher in front and settled.
to_launcher() {
  adb shell am force-stop "$app_id"
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
  sleep 3
}
# The start with -W by way $1 (direct | alias); the lines of its answer (Status, LaunchState,
# TotalTime, WaitTime). The alias is exported: a plain shell start, an APPLICATION launch source
# like the launcher's, with the launcher's flags.
start_app() {
  case "$1" in
    alias)
      adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f "$tap_flags" -n "$app_id/$alias" | tr -d '\r'
      ;;
    *)
      adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/$activity" | tr -d '\r'
      ;;
  esac
}
# Sleep until the shell's clock (`date +%s`) reads $1; nothing when it already does.
sleep_until() {
  local now
  now=$(date +%s)
  if [ "$now" -lt "$1" ]; then sleep $(($1 - now)); fi
}

# The chrome's first real frame: `reportFullyDrawn()` at the chrome's READY (MainActivity.onChromeReady,
# OS-27) puts `ActivityTaskManager: Fully drawn <component>: +1s234ms` in logcat, the time from the
# same start as TotalTime's; TotalTime is the plain window's first frame, under the splash. A build
# without the mark (main before it) reads `-`. The duration is the platform's own format
# (`+987ms`, `+1s234ms`, `+1m2s345ms`); milliseconds out.
fully_drawn_count() {
  adb logcat -d -s ActivityTaskManager:I 2> /dev/null | tr -d '\r' | grep -c "Fully drawn $app_id/$activity" || true
}
duration_ms() {
  local s=${1#+}
  [[ $s =~ ^(([0-9]+)m)?(([0-9]+)s)?(([0-9]+)ms)?$ ]] || { echo "-"; return; }
  echo $(( 10#${BASH_REMATCH[2]:-0} * 60000 + 10#${BASH_REMATCH[4]:-0} * 1000 + 10#${BASH_REMATCH[6]:-0} ))
}
# Wait up to $1 seconds for a new Fully drawn line past the $2 seen before the start; echo its ms or `-`.
fully_drawn_wait() {
  local limit=$1 seen=$2 waited=0 line
  while [ "$waited" -lt "$limit" ]; do
    if [ "$(fully_drawn_count)" -gt "$seen" ]; then
      line=$(adb logcat -d -s ActivityTaskManager:I 2> /dev/null | tr -d '\r' | grep "Fully drawn $app_id/$activity" | tail -n 1)
      duration_ms "$(printf '%s\n' "$line" | sed -n 's/.*Fully drawn [^:]*: *+\([0-9smh]*\).*/\1/p')"
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "-"
}
# The splash's hold as the head logs it (`ZenStartup: … splash held N ms, lifted by X`), the last such line; `-` without one.
splash_held() {
  adb logcat -d -s ZenStartup:I 2> /dev/null | tr -d '\r' | grep -o 'splash held [0-9-]* ms, lifted by [a-z]*' | tail -n 1 | sed 's/splash held \([0-9-]*\) ms, lifted by \([a-z]*\)/\1 (\2)/' | grep . || echo "-"
}
# The boot's marks as the build logs them at the chrome's first frame (`ZenStartup: boot marks:
# app=41 activity=312 … frame=2890`, ms since the process start; BootMarks.kt), the last such line;
# empty for a build without them (a grep with nothing to find exits 1, which under pipefail would
# be the script's end – the readers of a build without the line must not be).
boot_marks() {
  adb logcat -d -s ZenStartup:I 2> /dev/null | tr -d '\r' | grep -o 'boot marks: .*' | tail -n 1 | sed 's/^boot marks: //' || true
}
# Ruling 5: the process's frame statistics since its start (`dumpsys gfxinfo`, the render thread's
# own count), read at the same point of every run – STATS_AT_S after the start request – as `name=value` words:
# frames rendered, janky, the UI thread slow (the main thread's long tasks during the boot), the
# frame deadline missed, the 90th and 99th percentile frame times (ms). Empty when the process is gone.
frame_stats() {
  adb shell dumpsys gfxinfo "$app_id" 2> /dev/null | tr -d '\r' | awk -F': ' '
    /^Total frames rendered:/ { printf "frames=%s ", $2 }
    /^Janky frames:/ { split($2, a, " "); printf "janky=%s ", a[1] }
    /^Number Slow UI thread:/ { printf "slowui=%s ", $2 }
    /^Number Frame deadline missed:/ { printf "missed=%s ", $2 }
    /^90th percentile:/ { sub(/ms/, "", $2); printf "p90=%s ", $2 }
    /^99th percentile:/ { sub(/ms/, "", $2); printf "p99=%s ", $2 }' || true
}
# The names in the given marks lines, in order of first appearance, one per line.
mark_names() {
  printf '%s\n' "$@" | tr ' ' '\n' | sed -n 's/=.*//p' | awk 'NF && !seen[$0]++'
}
# One mark's value out of each of the given lines, one per line (a line without it gives none).
mark_values() {
  local name=$1 line
  shift
  for line in "$@"; do printf '%s\n' "$line" | tr ' ' '\n' | sed -n "s/^$name=//p"; done
}

# Install one build over the other (the profile stays: the same applicationId).
install_build() {
  local name=$1 apk=$2 label=$3
  echo "== $name ($label): $apk"
  adb install -r -d -g "$apk"
}
# Measure the installed build by way $2 (direct | alias) under name $1: settle on one discarded
# start, then $runs measured cold starts. Writes `<name>-am-start.txt` (every am start answer)
# and fills the totals, waits, states, drawn, helds, marks and fstats arrays.
measure() {
  local name=$1 way=$2
  echo "== $name: $runs cold starts, $way"
  : > "$out/$name-am-start.txt"
  to_launcher
  start_app "$way" > /dev/null
  sleep 8
  adb shell am force-stop "$app_id"
  totals=()
  waits=()
  states=()
  drawn=()
  helds=()
  marks=()
  fstats=()
  for i in $(seq 1 "$runs"); do
    to_launcher
    adb logcat -c > /dev/null 2>&1 || true
    seen=$(fully_drawn_count)
    started=$(date +%s)
    answer=$(start_app "$way")
    # One clock for both builds: the READY mark waited for (the boot's length where a build has
    # it), the log's lines and the frame statistics read STATS_AT_S after the start request
    # whether the wait found the mark or not, the next start NEXT_AT_S after it.
    fully=$(fully_drawn_wait "$READY_WAIT_S" "$seen")
    sleep_until $((started + STATS_AT_S))
    held=$(splash_held)
    marks_=$(boot_marks)
    stats_=$(frame_stats)
    printf 'run %s\n%s\nFullyDrawn: %s\nSplashHeld: %s\nBootMarks: %s\nFrameStats: %s\n\n' "$i" "$answer" "$fully" "$held" "$marks_" "$stats_" >> "$out/$name-am-start.txt"
    total=$(printf '%s\n' "$answer" | sed -n 's/^TotalTime: *//p' | head -n 1)
    wait_=$(printf '%s\n' "$answer" | sed -n 's/^WaitTime: *//p' | head -n 1)
    state=$(printf '%s\n' "$answer" | sed -n 's/^LaunchState: *//p' | head -n 1)
    echo "  run $i: TotalTime ${total:-?} FullyDrawn $fully WaitTime ${wait_:-?} ${state:-?} splash held $held${marks_:+; marks $marks_}${stats_:+; frames $stats_}"
    # A start the platform answered without a time (a build without the alias: `Error: Activity
    # class does not exist`) reads `-`, and the median leaves it out.
    totals+=("${total:--}")
    waits+=("${wait_:--}")
    states+=("${state:-?}")
    drawn+=("$fully")
    helds+=("$held")
    marks+=("$marks_")
    fstats+=("$stats_")
    sleep_until $((started + NEXT_AT_S))
  done
  adb shell am force-stop "$app_id"
}

# The median of the numbers among the arguments; `-` when none is a number (a build without the mark).
median() {
  local nums
  nums=$(printf '%s\n' "$@" | grep -E '^[0-9]+(\.[0-9]+)?$' || true)
  [ -n "$nums" ] || { echo "-"; return; }
  printf '%s\n' "$nums" | sort -n | awk '{ a[NR] = $1 } END { if (NR % 2) print a[(NR + 1) / 2]; else print (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}

# after - before, or `-` when either side has no number.
delta() {
  case "$1$2" in *-*) echo "-" ;; *) awk -v a="$1" -v b="$2" 'BEGIN { print a - b }' ;; esac
}

join() { local IFS=' '; echo "$*"; }

# Keep the last measurement's arrays under prefix $1 (`<prefix>_totals` and the rest).
keep() {
  local p=$1
  eval "${p}_totals=(\"\${totals[@]}\"); ${p}_waits=(\"\${waits[@]}\"); ${p}_states=(\"\${states[@]}\"); ${p}_drawn=(\"\${drawn[@]}\"); ${p}_helds=(\"\${helds[@]}\"); ${p}_marks=(\"\${marks[@]}\"); ${p}_fstats=(\"\${fstats[@]}\")"
}

# One build, both ways: the direct start first (the pair as it was), then the launcher's.
install_build before "$base_apk" "${P0_BASE_LABEL:-base}"
measure before direct
keep before
measure before-alias alias
keep before_alias
install_build after "$head_apk" "${P0_HEAD_LABEL:-head}"
measure after direct
keep after
measure after-alias alias
keep after_alias

before_total=$(median "${before_totals[@]}")
after_total=$(median "${after_totals[@]}")
before_wait=$(median "${before_waits[@]}")
after_wait=$(median "${after_waits[@]}")
before_fully=$(median "${before_drawn[@]}")
after_fully=$(median "${after_drawn[@]}")
before_alias_total=$(median "${before_alias_totals[@]}")
after_alias_total=$(median "${after_alias_totals[@]}")
before_alias_wait=$(median "${before_alias_waits[@]}")
after_alias_wait=$(median "${after_alias_waits[@]}")
before_alias_fully=$(median "${before_alias_drawn[@]}")
after_alias_fully=$(median "${after_alias_drawn[@]}")

# The medians table of `name=value` lines (the boot's marks, the frame statistics) for the two
# builds by one way: $1 the column's name, $2 and $3 the names of the arrays holding the before
# and after lines. Nothing when neither build has the lines.
values_table() {
  local column=$1
  local -n vt_before=$2 vt_after=$3
  local names n bm am
  names=$(mark_names "${vt_before[@]}" "${vt_after[@]}")
  [ -n "$names" ] || return 0
  echo
  echo "| $column | before median | after median | delta | before runs | after runs |"
  echo "| --- | --- | --- | --- | --- | --- |"
  for n in $names; do
    # shellcheck disable=SC2046
    bm=$(median $(mark_values "$n" "${vt_before[@]}"))
    # shellcheck disable=SC2046
    am=$(median $(mark_values "$n" "${vt_after[@]}"))
    # shellcheck disable=SC2046
    echo "| $n | $bm | $am | $(delta "$am" "$bm") | $(join $(mark_values "$n" "${vt_before[@]}")) | $(join $(mark_values "$n" "${vt_after[@]}")) |"
  done
}

{
  echo "MainActivity's cold start, \`am start -W\` after \`am force-stop\`, $runs runs per build and way on one emulator boot (medians in ms): direct, the shell's start of MainActivity (the pair as it was, a start no user makes), and through the icon alias, the launcher's tap."
  # wm size / density answer two lines once overridden (Physical, Override): the last is the one in force.
  echo "device: $(adb shell getprop ro.build.fingerprint | tr -d '\r'); display $(adb shell wm size | tr -d '\r' | tail -n 1 | sed 's/.*: //') at $(adb shell wm density | tr -d '\r' | tail -n 1 | sed 's/.*: //') dpi"
  echo "TotalTime: the app window's first frame under the splash (a plain window on a build before the boot theme, the splash's colour with it); on the alias rows from the alias's start to MainActivity's first frame – the trampoline's run in between (one launch to the platform). Fully drawn: the chrome's first real frame, reportFullyDrawn() at READY, from the same start; - for a build without the mark. Method: every start with the process gone (\`am force-stop\`) and the launcher in front, by \`am start -W\` from the shell – the direct rows at MainActivity with MAIN/LAUNCHER, the alias rows with the launcher's own intent (MAIN/LAUNCHER, NEW_TASK | RESET_TASK_IF_NEEDED) at the enabled icon alias, whose target (the shortcuts' NoDisplay trampoline on a build before round 4, IconTapActivity under the splash theme from it) forwards to MainActivity; READY waited for up to $READY_WAIT_S s, the log's lines and the frame statistics read $STATS_AT_S s after the start request, the next start $NEXT_AT_S s after it – one clock for both builds and ways."
  echo
  echo "| build, way | TotalTime median | Fully drawn median | WaitTime median | TotalTime runs | Fully drawn runs | LaunchState | splash held (by) |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
  echo "| before (${P0_BASE_LABEL:-base}), direct | $before_total | $before_fully | $before_wait | $(join "${before_totals[@]}") | $(join "${before_drawn[@]}") | $(join "${before_states[@]}") | $(join "${before_helds[@]}") |"
  echo "| after (${P0_HEAD_LABEL:-head}), direct | $after_total | $after_fully | $after_wait | $(join "${after_totals[@]}") | $(join "${after_drawn[@]}") | $(join "${after_states[@]}") | $(join "${after_helds[@]}") |"
  echo "| before (${P0_BASE_LABEL:-base}), alias | $before_alias_total | $before_alias_fully | $before_alias_wait | $(join "${before_alias_totals[@]}") | $(join "${before_alias_drawn[@]}") | $(join "${before_alias_states[@]}") | $(join "${before_alias_helds[@]}") |"
  echo "| after (${P0_HEAD_LABEL:-head}), alias | $after_alias_total | $after_alias_fully | $after_alias_wait | $(join "${after_alias_totals[@]}") | $(join "${after_alias_drawn[@]}") | $(join "${after_alias_states[@]}") | $(join "${after_alias_helds[@]}") |"
  echo
  echo "delta (after - before), direct: TotalTime $(delta "$after_total" "$before_total") ms, Fully drawn $(delta "$after_fully" "$before_fully") ms, WaitTime $(delta "$after_wait" "$before_wait") ms"
  echo "delta (after - before), alias: TotalTime $(delta "$after_alias_total" "$before_alias_total") ms, Fully drawn $(delta "$after_alias_fully" "$before_alias_fully") ms, WaitTime $(delta "$after_alias_wait" "$before_alias_wait") ms"
  echo "the trampoline's cost (alias - direct, the same build): before TotalTime $(delta "$before_alias_total" "$before_total") ms, Fully drawn $(delta "$before_alias_fully" "$before_fully") ms; after TotalTime $(delta "$after_alias_total" "$after_total") ms, Fully drawn $(delta "$after_alias_fully" "$after_fully") ms"
  # The boot's marks, where a build logs them: one row per name, the medians over the runs, each way.
  if [ -n "$(mark_names "${before_marks[@]}" "${after_marks[@]}" "${before_alias_marks[@]}" "${after_alias_marks[@]}")" ]; then
    echo
    echo "boot marks (BootMarks.kt): ms since the process start, medians over the runs; app ZenApplication.onCreate done, activity MainActivity.onCreate begins (on the alias rows after the trampoline's own create, in the same process), host the Host built, content setContentView done, load the chrome's document asked for, created onCreate done, boot the core's boot call answered, ready chrome.ready heard, frame that frame drawn (the splash lifts). - for a build without the mark."
    values_table "mark, direct" before_marks after_marks
    values_table "mark, alias" before_alias_marks after_alias_marks
  fi
  # Ruling 5: the boot's frame statistics, the medians over the runs, the same helpers (name=value words), each way.
  if [ -n "$(mark_names "${before_fstats[@]}" "${after_fstats[@]}" "${before_alias_fstats[@]}" "${after_alias_fstats[@]}")" ]; then
    echo
    echo "frame statistics (dumpsys gfxinfo, the process since its start, read $STATS_AT_S s after the start request on either build): frames rendered, janky, slowui the UI thread slow (the main thread's long tasks during the boot), missed the frame deadline missed, p90 / p99 the frame time percentiles in ms; medians over the runs."
    values_table "statistic, direct" before_fstats after_fstats
    values_table "statistic, alias" before_alias_fstats after_alias_fstats
  fi
} | tee "$out/cold-start-pair.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### MainActivity cold start, before / after"; echo; cat "$out/cold-start-pair.txt"; } >> "$GITHUB_STEP_SUMMARY"
fi
