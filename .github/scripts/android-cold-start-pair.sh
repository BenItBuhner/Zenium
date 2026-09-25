#!/usr/bin/env bash
# The P0 rule's GATE for a change near the boot path: MainActivity's cold start under a BASE
# build and under the HEAD build on the same emulator boot – `am start -W` after `am force-stop`
# – judged on the PAIRED delta, mechanically. The record beside the judgement: the medians of
# TotalTime (the system's time from the start request to the activity's first frame) and
# WaitTime side by side, the chrome's own READY mark (`Fully drawn`), the splash's hold, the
# boot's marks and the boot's frame statistics (`dumpsys gfxinfo`: ruling 5's main-thread long
# tasks, none new) where a build has them. Runs on the workflow runner once the emulator has
# booted (android-emulator-demo.yml's `script`), like the demo drivers; the device is prepared
# the way android-gesture-demo.sh prepares it (the same display, three-button navigation, the
# bundled Google apps disabled) so the numbers are the recipe's own.
#
# Two ways in, each build (round 4): `direct` – the shell's `am start` at MainActivity, the pair
# as it was, a start no user makes – and `alias` – the launcher's own intent (MAIN/LAUNCHER,
# NEW_TASK | RESET_TASK_IF_NEEDED) at the enabled icon alias, the tap's path: the alias's target
# starts (the shortcuts' NoDisplay trampoline on a build before round 4, IconTapActivity under
# the splash theme from it) and forwards to MainActivity, one launch to the platform, so
# TotalTime and Fully drawn span the tap to MainActivity's frames. The alias rows are the P0
# rule's reading of the trampoline itself (alias − direct on the same build, and after − before
# on the alias).
#
# THE GATE (the root's ruling of 25 Sep on the null pair 36154411153: "inside the spread" would
# pass a 500 ms regression, so the verdict is the paired-median delta against a threshold). The
# record's `VERDICT delta (paired …)` lines are followed by the judgement, `P0 VERDICT: PASS` or
# `P0 VERDICT: FAIL — <measure> paired median +N ms on the <direct|alias> way, over the +T ms
# threshold` (a `::error::` with it and EXIT 1: the workflow goes red). TotalTime's paired median
# over the way's threshold fails – +TOTAL_THRESHOLD_MS on the direct way, the ruling's +100;
# +ALIAS_THRESHOLD_MS on the alias way, the same +100 since the null runs put the alias inside
# the band once the order alternated (the calibration below); Fully drawn – the chrome's READY,
# the boot.ts side of the boot path a TotalTime gate cannot see, and the noisier mark by four
# (its paired spread ≈ 450–600 ms against TotalTime's ≈ 120 direct / ≈ 340 alias) – is judged
# the same against FULLY_DRAWN_THRESHOLD_MS (direct, +300) and FULLY_DRAWN_ALIAS_THRESHOLD_MS
# (alias, +500), twice the larger |paired median| the three null runs read on that way rounded up
# to the next 50 ms; WaitTime is reported, not judged. A pair with a dash on either side is left
# out; a judged row with FEWER THAN half its pairs valid is INCONCLUSIVE, which fails too.
# The per-arm medians and the `delta (… the medians)` lines stand as round 1 left them, byte
# for byte; only the paired delta is judged.
#
# THE DESIGN, and why. A paired difference's median has a standard error near 1.25·σ/√N, and
# at the raw spread of one pair per install (σ ≈ 210 ms direct, ≈ 320 ms alias with heavy
# tails on the null pair 36154411153) a ±50 ms null band would want N in the hundreds – so the
# variance goes down first, then N goes up. (a) THE ARMS' ART STATE is read after every install
# (`dumpsys package`, the dexopt status of the code) and must agree from one install to the
# next, or the run fails. The ruling asked for both arms compiled ahead of time (`cmd package
# compile -m speed -f`), but ART Service downgrades whatever filter is asked for a DEBUGGABLE
# package to `verify` – no compiled code – the shell's command included (Dexopter.java,
# adjustCompilerFilter: "we force vmSafeMode on debuggable apps as well … applies to all
# compilations (even if they are done via adb shell commands)" – android14-release and
# android15-release alike, the recipe's two images), and the pair measures the debug APK, which
# is debuggable; on the recipe's image the install leaves it at `run-from-apk` (the dex loaded
# from the APK, no odex at all), as the null runs read on every install. So no AOT step exists
# for it – and none is needed for the ruling's purpose: a debuggable package has one state, so
# no dexopt can land mid-measurement on either arm, and the JIT is per process and the same on
# both. The check makes that a recorded fact per install instead of an assumption; the absolute
# numbers stay comparable with pairs 1–8 of #454 (the same state). AOT arms would take a
# non-debuggable build for the pair, which is not this tool's to make. (b) each install is
# measured P0_STARTS times by each way, not once: the run is P0_RUNS BLOCKS of two arms, k =
# P0_STARTS starts by each way per arm, the i-th start of a block's one arm paired with the i-th
# of its other, N = P0_RUNS × P0_STARTS pairs – the install and the settle start are paid once
# per k pairs (the k pairs of a block share an install, so N counts a little less than N
# independent pairs would; the null runs measure the band as it is). (c) THE ORDER ALTERNATES:
# odd blocks install the base first and the head second, even blocks the head first (A B / B A
# …). The first two null runs at N = 30 (36168310688, base first in every block) read the direct
# way at +1 / +15.5 ms and the alias way at +100 / +96 ms – a same-tree pair positive twice on
# the alias alone smelled of a POSITION effect (the second-installed arm paying for something in
# the trampoline's path), so the third run alternated the order and read the position: the
# POSITION READING in the record – the medians by the arm's position in its block,
# first-installed or second-installed, whatever the build, and the paired median second − first
# – found none on TotalTime (alias second − first +5 ms, paired +3.5; direct −9, paired −21.5)
# and one on Fully drawn (paired second − first +76.5 direct, +110 alias: the second-installed
# arm's READY comes later within its pair on both ways). Whatever the first two runs' alias
# excess was – that host pair's position cost or the tail of the alias's spread (the paired
# median's standard error is ≈ 75 ms there at N = 30, so +100 is 1.3 of them) – the alternated
# order cancels a position cost in the paired median, and the third run read the alias at
# +26.5. (d) the median stays (robust to the alias's tails; no trimming). Beside the numbers,
# each start records whether the launcher's process (com.google.android.apps.nexuslauncher) was
# alive before it and its pid (a launcher restarting on the intent was a plausible cost on the
# alias way; the third null run read it alive before all 120 starts, one pid), and the frames
# rendered when probed FRAMES_AT_S after the start request, beside the STATS_AT_S statistics –
# the clock's evidence: a count still growing between the probes and the statistics means the
# boot's frames were not over, and a count that is not says the clock can shorten (the third
# null run read the 8 s count equal to the 15 s count on all 120 starts, so STATS_AT_S 8 and
# NEXT_AT_S 15 would hold – ≈ 14 min less per run – once one null run at that cadence confirms
# the band; the clock stays as calibrated until then). N is CALIBRATED on null pairs (the same
# tree in both arms): the TotalTime paired median inside ±50 ms on both ways on consecutive
# null runs at one N is the stopping rule – met at N = 30: direct +1 / +15.5 / −21.5, alias
# +26.5 with the order alternated (36178688584) – and a measure whose null band is wider is
# gated at twice its larger |null paired median| rounded up to the next 50 ms: Fully drawn's
# −20 / +45.5 / −141.5 direct → +300, +236.5 / +83 / −56 alias → +500. The runs are in the PR
# body of #482 (H4, round 2); the workflow's defaults are these.
#
#   P0_BASE_APK   – the base build's debug APK (the caller's setup-script built it from the base ref)
#   P0_BASE_LABEL – how the base is named in the table (its commit), `base` by default
#   P0_HEAD_LABEL – how the head is named, `head` by default
#   P0_RUNS       – blocks, 15 by default: each installs one arm, reads its ART state, settles it
#                   (one discarded start) and measures it, then the other arm the same
#   P0_STARTS     – measured cold starts by each way per install, 2 by default; N = P0_RUNS × P0_STARTS
#   P0_TOTAL_THRESHOLD_MS, P0_ALIAS_THRESHOLD_MS, P0_FULLY_DRAWN_THRESHOLD_MS,
#   P0_FULLY_DRAWN_ALIAS_THRESHOLD_MS – the gate's thresholds, for a calibration run only; the
#                   defaults below are the gate
#   DEMO_OUT      – where the record goes (cold-start-pair.txt and the raw am start output)
#
# The arms are interleaved (seed 71): `adb install -r -d` of one build over the other (the same
# applicationId, so the profile stays and both boot the same state; -d since the base may carry
# the newer version code when main has moved past the branch), block after block on the one
# boot, so the boot's drift (627 ms across one pair's twenty starts measured arm after arm)
# falls on both arms of a pair alike. Every run keeps one clock for both builds (a build without
# the READY mark must not read its frame statistics later, nor start its next run later, than
# one with it): the mark is waited for up to READY_WAIT_S from the start request, the frames
# probed at FRAMES_AT_S, the statistics read STATS_AT_S after it whatever the wait found, and
# the next start comes NEXT_AT_S after it, the device quiet and the boot – the chrome and the
# core boot on after the first frame – long over on either. The table is written to the job
# summary too.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
activity=app.zen.chromium.MainActivity
alias=app.zen.chromium.icon.Indigo
launcher_id=com.google.android.apps.nexuslauncher
tap_flags=0x10200000
runs=${P0_RUNS:-15}
starts=${P0_STARTS:-2}
pairs=$((runs * starts))
# The gate's thresholds (ms, on the paired median; over = FAIL), per measure and way. TotalTime
# is the ruling's +100 on both ways (the three null runs' paired medians sit inside ±50 on each,
# the alias's once the order alternated); Fully drawn is twice the larger |paired median| the
# three null runs read on the way, rounded up to the next 50 ms (direct 141.5 → 300, alias
# 236.5 → 500) – the PR body of #482 has the runs.
TOTAL_THRESHOLD_MS=${P0_TOTAL_THRESHOLD_MS:-100}
ALIAS_THRESHOLD_MS=${P0_ALIAS_THRESHOLD_MS:-$TOTAL_THRESHOLD_MS}
FULLY_DRAWN_THRESHOLD_MS=${P0_FULLY_DRAWN_THRESHOLD_MS:-300}
FULLY_DRAWN_ALIAS_THRESHOLD_MS=${P0_FULLY_DRAWN_ALIAS_THRESHOLD_MS:-500}
READY_WAIT_S=12
FRAMES_AT_S="8 12"
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
# The frames the process has rendered since its start (`dumpsys gfxinfo`'s `Total frames rendered`),
# the one number the probes read; `-` when the process is gone.
frames_rendered() {
  adb shell dumpsys gfxinfo "$app_id" 2> /dev/null | tr -d '\r' | awk -F': ' '/^Total frames rendered:/ { print $2; found = 1 } END { if (!found) print "-" }'
}
# The launcher's process before a start: `alive <pid>` or `dead` (a launcher restarting on the intent
# would be a cost on the alias way, whose intent is the launcher's).
launcher_state() {
  local pid
  pid=$(adb shell pidof "$launcher_id" 2> /dev/null | tr -d '\r' | awk '{ print $1 }')
  if [ -n "$pid" ]; then echo "alive $pid"; else echo "dead"; fi
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

# The installed build's ART state: the dexopt status `dumpsys package` reports for its code
# (`verify` for a debuggable package whatever compilation was asked, see the header), the distinct
# values joined; empty when the dump has none.
dexopt_state() {
  adb shell dumpsys package "$app_id" 2> /dev/null | tr -d '\r' | grep -o 'status=[a-z-]*' | sed 's/status=//' | sort -u | tr '\n' ' ' | sed 's/ $//' || true
}
dexopt_ref=
# Install one build over the other (the profile stays: the same applicationId), read its ART state
# (the first install's is the reference; a later one that differs fails the run, the arms not in
# one state), then one discarded start by the direct way: it pays for the install's dexopt and the
# profile's first run, so the measured starts of either build come after the same warm-up.
install_build() {
  local name=$1 apk=$2 label=$3 state
  echo "== $name ($label): $apk"
  adb install -r -d -g "$apk"
  state=$(dexopt_state)
  echo "  dexopt: ${state:-?}"
  if [ -z "$dexopt_ref" ]; then
    dexopt_ref=${state:-?}
  elif [ "${state:-?}" != "$dexopt_ref" ]; then
    echo "::error::the arms are not in one ART state: $name ($label) installed at dexopt '${state:-?}', the first install read '$dexopt_ref'"
    exit 1
  fi
  to_launcher
  start_app direct > /dev/null
  sleep 8
  adb shell am force-stop "$app_id"
}
# One measured cold start of the installed build by way $2 (direct | alias) as run $3 under name
# $1, the arm in position $4 of its block (1 installed first, 2 second), appended to the name's
# arrays (`<name>_totals` and the rest, `-` for a dash in the table), to the position's
# (`pos<n>_<way>_totals`, `_drawn`, `_waits`: the position reading) and to `<name>-am-start.txt`
# (the am start answer, the launcher's state before it, the mark, the hold, the boot's marks, the
# frame statistics with the probes).
measure_one() {
  local name=$1 way=$2 i=$3 pos=$4
  local -n m_totals=${name}_totals m_waits=${name}_waits m_states=${name}_states m_drawn=${name}_drawn
  local -n m_helds=${name}_helds m_marks=${name}_marks m_fstats=${name}_fstats m_launchers=${name}_launchers
  local -n p_totals=pos${pos}_${way}_totals p_drawn=pos${pos}_${way}_drawn p_waits=pos${pos}_${way}_waits
  local seen started answer fully held marks_ stats_ total wait_ state launcher probes t
  to_launcher
  adb logcat -c > /dev/null 2>&1 || true
  seen=$(fully_drawn_count)
  launcher=$(launcher_state)
  started=$(date +%s)
  answer=$(start_app "$way")
  # One clock for both builds: the READY mark waited for (the boot's length where a build has
  # it), the frames probed FRAMES_AT_S after the start request (each probe records the second it
  # was read at – a wait that ran to its limit puts the earlier probes off their time), the log's
  # lines and the frame statistics read STATS_AT_S after it whether the wait found the mark or
  # not, the next start NEXT_AT_S after it.
  fully=$(fully_drawn_wait "$READY_WAIT_S" "$seen")
  probes=
  for t in $FRAMES_AT_S; do
    sleep_until $((started + t))
    probes+="${probes:+ }at${t}s=$(frames_rendered) read${t}=$(( $(date +%s) - started ))"
  done
  sleep_until $((started + STATS_AT_S))
  held=$(splash_held)
  marks_=$(boot_marks)
  stats_=$(frame_stats)
  stats_="${stats_% }"
  stats_="${stats_:+$stats_ }$probes"
  printf 'run %s\n%s\nLauncher: %s\nFullyDrawn: %s\nSplashHeld: %s\nBootMarks: %s\nFrameStats: %s\n\n' "$i" "$answer" "$launcher" "$fully" "$held" "$marks_" "$stats_" >> "$out/${name//_/-}-am-start.txt"
  total=$(printf '%s\n' "$answer" | sed -n 's/^TotalTime: *//p' | head -n 1)
  wait_=$(printf '%s\n' "$answer" | sed -n 's/^WaitTime: *//p' | head -n 1)
  state=$(printf '%s\n' "$answer" | sed -n 's/^LaunchState: *//p' | head -n 1)
  echo "  $name run $i ($way, position $pos): TotalTime ${total:-?} FullyDrawn $fully WaitTime ${wait_:-?} ${state:-?} launcher $launcher splash held $held${marks_:+; marks $marks_}${stats_:+; frames $stats_}"
  # A start the platform answered without a time (a build without the alias: `Error: Activity
  # class does not exist`) reads `-`, and the median leaves it out.
  m_totals+=("${total:--}")
  m_waits+=("${wait_:--}")
  m_states+=("${state:-?}")
  m_drawn+=("$fully")
  m_helds+=("$held")
  m_marks+=("$marks_")
  m_fstats+=("$stats_")
  m_launchers+=("$launcher")
  p_totals+=("${total:--}")
  p_drawn+=("$fully")
  p_waits+=("${wait_:--}")
  sleep_until $((started + NEXT_AT_S))
  adb shell am force-stop "$app_id"
}

# The median of the numbers among the arguments; `-` when none is a number (a build without the mark).
median() {
  local nums
  nums=$(printf '%s\n' "$@" | grep -E '^-?[0-9]+(\.[0-9]+)?$' || true)
  [ -n "$nums" ] || { echo "-"; return; }
  printf '%s\n' "$nums" | sort -n | awk '{ a[NR] = $1 } END { if (NR % 2) print a[(NR + 1) / 2]; else print (a[NR / 2] + a[NR / 2 + 1]) / 2 }'
}

# after - before, or `-` when either side has no number.
delta() {
  case "$1$2" in *-*) echo "-" ;; *) awk -v a="$1" -v b="$2" 'BEGIN { print a - b }' ;; esac
}

join() { local IFS=' '; echo "$*"; }

# The paired differences after_i - before_i of two arrays of the same length, one per line, in the
# pairs' order; a pair with a dash on either side gives none (the median leaves it out).
paired() {
  local -n pd_before=$1 pd_after=$2
  local i
  for i in "${!pd_before[@]}"; do
    case "${pd_before[$i]}${pd_after[$i]:--}" in *-*) ;; *) awk -v a="${pd_after[$i]}" -v b="${pd_before[$i]}" 'BEGIN { print a - b }' ;; esac
  done
}
# The verdict: the median of the paired differences, then the differences themselves in brackets.
paired_median() {
  local diffs
  diffs=$(paired "$1" "$2")
  # shellcheck disable=SC2086
  echo "$(median $diffs) ms (pairs $(join $diffs))"
}
# The position reading of one measure and way: the medians of the first-installed ($1) and the
# second-installed ($2) arm's arrays, second - first of them, and the paired median of second -
# first (the arrays are in the pairs' order, so paired() reads them as it reads the arms').
position_reading() {
  local -n pr_first=$1 pr_second=$2
  local first second diffs
  first=$(median "${pr_first[@]}")
  second=$(median "${pr_second[@]}")
  diffs=$(paired "$1" "$2")
  # shellcheck disable=SC2086
  echo "first $first, second $second, second - first $(delta "$second" "$first") ms (paired $(median $diffs) ms)"
}
# `alive N of M` for the launcher states given.
alive_count() {
  local s alive=0
  for s in "$@"; do case "$s" in alive*) alive=$((alive + 1)) ;; esac; done
  echo "$alive of $#"
}
# How many distinct pids the launcher states given carry.
distinct_pids() {
  printf '%s\n' "$@" | sed -n 's/^alive //p' | sort -u | grep -c . || true
}
# The arguments after the first joined by the first (`; `).
join_with() {
  local sep=$1 x joined=
  shift
  for x in "$@"; do joined+="${joined:+$sep}$x"; done
  echo "$joined"
}
# A number with its sign: `+61.5`, `-17`, `0`.
signed() {
  awk -v x="$1" 'BEGIN { printf (x > 0 ? "+%s" : "%s"), x }'
}
# THE GATE on one measure and way: $1 the measure's name, $2 the way, $3 and $4 the before and
# after arrays, $5 the threshold (ms). Appends the row's reading to `judged` and, when the row
# fails, its reason to `failures`: the paired median over the threshold, or INCONCLUSIVE when
# fewer than half the pairs are valid (a dash on either side leaves a pair out).
judged=()
failures=()
judge() {
  local measure=$1 way=$2 threshold=$5 diffs n med
  diffs=$(paired "$3" "$4")
  n=$(printf '%s\n' "$diffs" | grep -c . || true)
  # shellcheck disable=SC2086
  med=$(median $diffs)
  if [ $((n * 2)) -lt "$pairs" ]; then
    judged+=("$measure, $way: INCONCLUSIVE ($n of $pairs pairs valid)")
    failures+=("INCONCLUSIVE: $measure on the $way way has $n of $pairs pairs valid")
  elif awk -v m="$med" -v t="$threshold" 'BEGIN { exit !(m > t) }'; then
    judged+=("$measure, $way: $(signed "$med") ms, OVER the +$threshold ms threshold ($n of $pairs pairs valid)")
    failures+=("$measure paired median $(signed "$med") ms on the $way way, over the +$threshold ms threshold")
  else
    judged+=("$measure, $way: $(signed "$med") ms, threshold +$threshold ms ($n of $pairs pairs valid)")
  fi
}

# The arms' arrays (measure_one appends by nameref: `<name>_<measure>`), one set per arm and way,
# and the positions' (`pos<1|2>_<way>_<measure>`); declared by name so the readers below are known.
before_totals=() before_waits=() before_states=() before_drawn=() before_helds=() before_marks=() before_fstats=() before_launchers=()
before_alias_totals=() before_alias_waits=() before_alias_states=() before_alias_drawn=() before_alias_helds=() before_alias_marks=() before_alias_fstats=() before_alias_launchers=()
after_totals=() after_waits=() after_states=() after_drawn=() after_helds=() after_marks=() after_fstats=() after_launchers=()
after_alias_totals=() after_alias_waits=() after_alias_states=() after_alias_drawn=() after_alias_helds=() after_alias_marks=() after_alias_fstats=() after_alias_launchers=()
# The positions' arrays are reached by name alone (measure_one's namerefs, position_reading's).
# shellcheck disable=SC2034
pos1_direct_totals=() pos1_direct_drawn=() pos1_direct_waits=() pos1_alias_totals=() pos1_alias_drawn=() pos1_alias_waits=()
# shellcheck disable=SC2034
pos2_direct_totals=() pos2_direct_drawn=() pos2_direct_waits=() pos2_alias_totals=() pos2_alias_drawn=() pos2_alias_waits=()
for name in before before_alias after after_alias; do
  : > "$out/${name//_/-}-am-start.txt"
done

# One arm of a block: install the build (its ART state read), settle it, measure it k = $starts
# times by each way (direct, alias, direct, alias …) as pairs (block − 1)·k + 1 … block·k, in
# position $4 of the block. $1 the arm's name (before | after), $2 its APK, $3 its label, $5 the block.
measure_arm() {
  local arm=$1 apk=$2 label=$3 pos=$4 b=$5 s j
  install_build "$arm" "$apk" "$label"
  for s in $(seq 1 "$starts"); do
    j=$(( (b - 1) * starts + s ))
    measure_one "$arm" direct "$j" "$pos"
    measure_one "${arm}_alias" alias "$j" "$pos"
  done
}

# The arms interleaved in blocks over $runs blocks on the one boot (seed 71: the boot drifts –
# 627 ms across one pair's twenty starts – and two arms measured back to back read the drift as
# a difference; a pair's two arms measured minutes apart at most do not). Each block installs
# one arm, reads its ART state, starts it once to settle, measures it k = $starts times by each
# way, then the other arm the same; the i-th start of a block by a way is pair (block − 1)·k + i
# with the other arm's i-th – the arrays' order, which paired() reads. THE ORDER ALTERNATES: odd
# blocks base then head (A B), even blocks head then base (B A), so an effect of the position in
# the block – whatever the second-installed arm pays that the first did not – falls on both arms
# alike over the run and cancels in the paired median (the position reading measures it; the
# pairing by index is unchanged). The medians per arm and way stand as before; the verdict is
# the median of the paired differences. Each block's wall clock is logged (the workflow's timeout).
for b in $(seq 1 "$runs"); do
  block_started=$(date +%s)
  if [ $((b % 2)) -eq 1 ]; then
    echo "== block $b of $runs (pairs $(( (b - 1) * starts + 1 ))–$((b * starts)) of $pairs; base first, head second)"
    measure_arm before "$base_apk" "${P0_BASE_LABEL:-base}" 1 "$b"
    measure_arm after "$head_apk" "${P0_HEAD_LABEL:-head}" 2 "$b"
  else
    echo "== block $b of $runs (pairs $(( (b - 1) * starts + 1 ))–$((b * starts)) of $pairs; head first, base second)"
    measure_arm after "$head_apk" "${P0_HEAD_LABEL:-head}" 1 "$b"
    measure_arm before "$base_apk" "${P0_BASE_LABEL:-base}" 2 "$b"
  fi
  echo "== block $b done in $(( $(date +%s) - block_started )) s"
done

# The gate, judged before the record is written (the exit status follows it).
judge TotalTime direct before_totals after_totals "$TOTAL_THRESHOLD_MS"
judge TotalTime alias before_alias_totals after_alias_totals "$ALIAS_THRESHOLD_MS"
judge "Fully drawn" direct before_drawn after_drawn "$FULLY_DRAWN_THRESHOLD_MS"
judge "Fully drawn" alias before_alias_drawn after_alias_drawn "$FULLY_DRAWN_ALIAS_THRESHOLD_MS"
if [ ${#failures[@]} -eq 0 ]; then
  verdict="P0 VERDICT: PASS"
else
  verdict="P0 VERDICT: FAIL — $(join_with '; ' "${failures[@]}")"
fi

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
  echo "MainActivity's cold start, \`am start -W\` after \`am force-stop\`, $pairs starts per build and way on one emulator boot in $runs blocks of $starts, the arms interleaved and the order alternated (odd blocks base then head, even blocks head then base: each block installs one arm, reads its ART state (dexopt ${dexopt_ref:-?}: ART Service leaves a debuggable package no compiled code whatever is asked, so both arms boot in the one state the install leaves), starts it once to settle, measures it $starts times by each way, then the other arm the same; the i-th start of a block's one arm pairs with the i-th of its other; medians in ms): direct, the shell's start of MainActivity (the pair as it was, a start no user makes), and through the icon alias, the launcher's tap. THE GATE is the median of the paired differences (after − before within each pair), which the boot's drift across the run does not enter: TotalTime's paired median over +$TOTAL_THRESHOLD_MS ms on the direct way or +$ALIAS_THRESHOLD_MS ms on the alias way fails, Fully drawn's over +$FULLY_DRAWN_THRESHOLD_MS ms (direct) or +$FULLY_DRAWN_ALIAS_THRESHOLD_MS ms (alias) fails, a row with fewer than half its pairs valid is INCONCLUSIVE and fails; WaitTime is reported, not judged. The per-arm medians and their deltas are the record beside it; the position reading (the arm installed first in its block against the arm installed second, whatever the build) says what the order alone costs."
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
  echo "delta (after - before, the medians), direct: TotalTime $(delta "$after_total" "$before_total") ms, Fully drawn $(delta "$after_fully" "$before_fully") ms, WaitTime $(delta "$after_wait" "$before_wait") ms"
  echo "delta (after - before, the medians), alias: TotalTime $(delta "$after_alias_total" "$before_alias_total") ms, Fully drawn $(delta "$after_alias_fully" "$before_alias_fully") ms, WaitTime $(delta "$after_alias_wait" "$before_alias_wait") ms"
  echo "VERDICT delta (paired: the median of after - before within each pair), direct: TotalTime $(paired_median before_totals after_totals), Fully drawn $(paired_median before_drawn after_drawn), WaitTime $(paired_median before_waits after_waits)"
  echo "VERDICT delta (paired: the median of after - before within each pair), alias: TotalTime $(paired_median before_alias_totals after_alias_totals), Fully drawn $(paired_median before_alias_drawn after_alias_drawn), WaitTime $(paired_median before_alias_waits after_alias_waits)"
  echo "P0 gate (the paired medians against the thresholds, $pairs pairs): $(join_with '; ' "${judged[@]}")"
  echo "$verdict"
  echo "the trampoline's cost (alias - direct, the same build): before TotalTime $(delta "$before_alias_total" "$before_total") ms, Fully drawn $(delta "$before_alias_fully" "$before_fully") ms; after TotalTime $(delta "$after_alias_total" "$after_total") ms, Fully drawn $(delta "$after_alias_fully" "$after_fully") ms"
  echo "position (the arm installed FIRST in its block against the arm installed SECOND, whatever the build – the base in the odd blocks, the head in the even – the medians over $pairs starts each, second - first of the medians, and in brackets the median of second - first within each pair): direct TotalTime $(position_reading pos1_direct_totals pos2_direct_totals), Fully drawn $(position_reading pos1_direct_drawn pos2_direct_drawn), WaitTime $(position_reading pos1_direct_waits pos2_direct_waits); alias TotalTime $(position_reading pos1_alias_totals pos2_alias_totals), Fully drawn $(position_reading pos1_alias_drawn pos2_alias_drawn), WaitTime $(position_reading pos1_alias_waits pos2_alias_waits)"
  echo "launcher ($launcher_id) before the start, alive of the starts: before direct $(alive_count "${before_launchers[@]}"), alias $(alive_count "${before_alias_launchers[@]}"); after direct $(alive_count "${after_launchers[@]}"), alias $(alive_count "${after_alias_launchers[@]}"); $(distinct_pids "${before_launchers[@]}" "${before_alias_launchers[@]}" "${after_launchers[@]}" "${after_alias_launchers[@]}") distinct launcher pid(s) over the run (a second one is a restart)"
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
    echo "frame statistics (dumpsys gfxinfo, the process since its start, read $STATS_AT_S s after the start request on either build): frames rendered, janky, slowui the UI thread slow (the main thread's long tasks during the boot), missed the frame deadline missed, p90 / p99 the frame time percentiles in ms; medians over the runs. at<N>s: the frames rendered when probed N s after the start request (read<N>: the second the probe was read at – a READY wait that ran to its limit puts it later) – the clock's evidence: a count still growing from the probes to frames means the boot's frames were not over at the probe."
    values_table "statistic, direct" before_fstats after_fstats
    values_table "statistic, alias" before_alias_fstats after_alias_fstats
  fi
} | tee "$out/cold-start-pair.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### MainActivity cold start, before / after"; echo; cat "$out/cold-start-pair.txt"; } >> "$GITHUB_STEP_SUMMARY"
fi
# The gate's exit: a FAIL is the workflow's red (the record above is written and uploaded first).
if [ ${#failures[@]} -ne 0 ]; then
  echo "::error::$verdict"
  exit 1
fi
