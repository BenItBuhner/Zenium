#!/usr/bin/env bash
# The startup scene (W5-16: OS-26 the splash, OS-27 the cold start's speed), run on the workflow
# runner once the emulator has booted (android-emulator-demo.yml's `script`, or the nightly's
# shard). A cold start is a process death first, and an instrumentation shares the process: so
# the seed is the driver's (StartupDemo.kt, one act through `am instrument`) and the scene is
# this script's, per colour scheme:
#
#   seed        the driver boots the browser on the fixture page the runner serves here
#               (android-startup-demo-server.mjs on 127.0.0.1:$port, 10.0.2.2:$port from the
#               emulator), waits for its paint, goes home so Host.onPause writes the tab's
#               picture, reports the page slot's rectangle; its exit stops the process
#   cold start  the fixture's answer held for STARTUP_HOLD_MS (the restored tab's picture has
#               to stand alone under the chrome), `am start -W` from the launcher under
#               screenrecord: the splash still one second in (and the splash window in
#               `dumpsys window`), TotalTime / WaitTime / LaunchState from the answer, the
#               chrome's first real frame from the `Fully drawn` line (reportFullyDrawn at
#               READY) and the boot's marks, the restored picture still once READY has lifted
#               the splash, the painted still once the page's own paint took the picture down,
#               the order of the three `ZenStartup` lines (picture up, frame drawn, picture
#               down: painted) from their logcat times, the boot's frame statistics
#               (`dumpsys gfxinfo`: janky, slow UI thread, deadline missed – ruling 5's numbers)
#   hot start   home, then `am start -W` with the process alive and the activity behind the
#               launcher, the platform's window transitions cut for the act (the reader wants
#               the page's first frame, not its blend with the launcher): LaunchState HOT, no
#               splash window, the page on the first frame
#   warm start  (light only) `am start -W --activity-clear-task`: the activity re-created in the
#               living process – LaunchState WARM, the platform's starting window, the chrome
#               booting again under it; recorded for the record, judged by no rule
#   web app     the fixture web app's cold launch (PWA-06): the process gone, the app's launch
#               intent (the seed's `webapp-start:` line: the record as extras, as the tile's
#               trampoline sends it) fired as root under screenrecord with the `/webapp` answer
#               held for WEBAPP_HOLD_MS – the platform's plain window, the splash dressed at the
#               hand-over in the app's colour and tile (the design still), held to the page's
#               first frame (the `web app page painted` line, the page still), then the page
#
# The reach (round 4, the themes in STARTUP_REACH): the readings above start MainActivity and
# the app's window directly, as no user does. The user taps the icon, a link, a tile – each a
# trampoline's path – so the same acts run through them, on the same build and boot, with the
# reader's `lead:` (the start request to the first splash frame, and what showed until then):
#
#   cold, alias       the launcher's own intent (MAIN/LAUNCHER, NEW_TASK | RESET_TASK_IF_NEEDED)
#                     at the enabled icon alias – IconTapActivity's path, the tap as it is now
#   hot, alias        the same intent with the browser alive behind the launcher: the task
#                     forward, nothing added, no splash (the launcher's hot tap)
#   warm, alias open  the alias with NEW_TASK alone (what `getLaunchIntentForPackage` callers
#                     and a bare `am start` send) on the running browser: the trampoline added
#                     on top, its splash for the forward's length – the documented flash,
#                     recorded, not judged
#   cold, trampoline  the launcher's intent at the shortcuts' NoDisplay trampoline
#                     (LauncherIconActivity, as root: not exported) – the icon's path as it was
#                     before round 4, the BEFORE on the same build
#   cold, link        a VIEW of the fixture URL at LinkDispatchActivity, the process gone – the
#                     link's path (the caller's window stands until the browser's splash)
#   web app, tile     the pinned tile's own intent (the seed's `tile-start:` line, as root) –
#                     WebAppLauncherActivity's path to the app's window
#
# The recordings are read frame by frame (android-startup-frames.mjs: splash, restored picture,
# page, blank, in that order and never a blank slot after the splash; the hot start with no
# splash and no blank; the web app's launch: the tile on the ground, never a bare window before
# it, the page within the exit's motion of the last splash frame) and cut into a contact sheet
# each. Everything lands under DEMO_OUT: per scheme <theme>/ (the seed's notes and still, the am
# start answers, the stills under the round's names – android-startup-design-splash-<theme>.png,
# -design-restored-picture-<theme>.png, -page-painted-<theme>.png, -hot-<theme>.png,
# -design-webapp-splash-<theme>.png, -webapp-page-<theme>.png, the tiles
# android-startup-frames-cold-<theme>.png, -frames-warm-<theme>.png (the hot start's: the row's
# warm start is the process alive) and -frames-webapp-<theme>.png – the recordings, their frame
# findings, the logcat), startup-findings.txt (every verdict), startup-table.md (the numbers,
# also the job summary). STARTUP_ASSERT=true fails the run on a verdict that did not hold;
# anything else reports only.
#
#   DEMO_OUT          where the findings go (artifacts/android-startup-demo by default)
#   DEMO_PREPARED     1 when an earlier driver on this boot prepared the device (the nightly)
#   DEMO_DISPLAY      <w>x<h>@<density>, 720x1600@280 by default (the phone recipe)
#   STARTUP_THEMES    the schemes to run, `light dark` by default (the nightly runs light)
#   STARTUP_REACH     the schemes that also run the reach acts (the trampolines' paths), `light`
#                     by default; empty for none
#   STARTUP_HOLD_MS   how long the cold start's fixture answer is held, 7000 by default (under
#                     RestoredPictures' 10 s release, past READY on this emulator by 3 s)
#   WEBAPP_HOLD_MS    how long the web app's page answer is held, 4000 by default (the splash
#                     dressed and standing well past the hand-over, under StartupSplash's 10 s
#                     watchdog from it)
#   STARTUP_PORT      the fixture server's port, 18931 by default
#   STARTUP_ASSERT    true to fail on a verdict that did not hold
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
activity=app.zen.chromium.MainActivity
# The launcher entry (the enabled icon alias, IconTapActivity's path), the shortcuts' trampoline
# (the icon's path before round 4), the link's, and the launcher's flags for a tap
# (NEW_TASK | RESET_TASK_IF_NEEDED, what launchers and LauncherApps.startMainActivity send).
alias=app.zen.chromium.icon.Indigo
trampoline=app.zen.chromium.LauncherIconActivity
link_activity=app.zen.chromium.LinkDispatchActivity
tap_flags=0x10200000
tab=tab_startup
demo_dir=startup-demo
out=${DEMO_OUT:-artifacts/android-startup-demo}
port=${STARTUP_PORT:-18931}
hold_ms=${STARTUP_HOLD_MS:-7000}
webapp_hold_ms=${WEBAPP_HOLD_MS:-4000}
assert=${STARTUP_ASSERT:-false}
themes=${STARTUP_THEMES:-light dark}
reach=${STARTUP_REACH-light}
display=${DEMO_DISPLAY:-720x1600@280}
mkdir -p "$out"
findings=$out/startup-findings.txt
table=$out/startup-table.md
: > "$findings"
failures=0

adb wait-for-device
nproc
free -m

# Host watchdog: the emulator's death leaves a marker the workflow reads (the shared recipe).
(
  while true; do
    if ! pgrep -f qemu-system-x86_64 > /dev/null; then
      echo "qemu gone at $(date +%T)" > "$out/emulator-died"
      break
    fi
    sleep 5
  done
) &
monitor_pid=$!

# The fixture, served from the runner: still here after the browser's process is gone.
hold_file=$(mktemp -u "${RUNNER_TEMP:-/tmp}/startup-hold.XXXXXX")
node .github/scripts/android-startup-demo-server.mjs "$port" "$hold_file" > "$out/server.log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" "$monitor_pid" 2> /dev/null || true
  rm -f "$hold_file"
}
trap cleanup EXIT
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$port/health" > /dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$port/health" > /dev/null || { echo "::error::the fixture server did not come up on $port"; exit 1; }
echo "fixture server on 127.0.0.1:$port (10.0.2.2:$port inside the emulator)"

if [ "${DEMO_PREPARED:-0}" != 1 ]; then
  # The demos' device (android-gesture-demo.sh, the cold start pair): the same display, no error
  # dialogs, three-button navigation, the bundled Google apps out of the way, the system settled.
  echo "display: ${display%@*} at density ${display#*@}"
  adb shell wm size "${display%@*}"
  adb shell wm density "${display#*@}"
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
fi
adb shell getprop ro.build.fingerprint | tr -d '\r' | tee "$out/device.txt"
adb shell wm size | tr -d '\r' | tail -n 1 | tee -a "$out/device.txt"
adb shell wm density | tr -d '\r' | tail -n 1 | tee -a "$out/device.txt"
adb shell dumpsys webviewupdate | grep -E "Current WebView package" | tee -a "$out/device.txt" || true

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "app: $apk"
echo "driver: $test_apk"
adb install -r -d -g "$apk"
adb install -r -d -g "$test_apk"
adb shell dumpsys package "$app_id" | grep -E "versionName|versionCode" | head -n 2 | tee "$out/version.txt" || true

# --- the log's readings ------------------------------------------------------------------------

# The ZenStartup and ActivityTaskManager lines since the last `logcat -c`, with epoch seconds first.
startup_log() {
  adb logcat -d -v epoch -s ZenStartup:I ActivityTaskManager:I 2> /dev/null | tr -d '\r'
}
# The epoch seconds of the first line matching $1 (extended regex), or nothing.
line_at() {
  startup_log | grep -E -m 1 "$1" | awk '{ print $1 }' || true
}
# Wait up to $2 seconds for a line matching $1; echoes it (or nothing).
wait_line() {
  local waited=0 line
  while [ "$waited" -lt "$(( $2 * 4 ))" ]; do
    line=$(startup_log | grep -E -m 1 "$1" || true)
    if [ -n "$line" ]; then printf '%s\n' "$line"; return; fi
    sleep 0.25
    waited=$((waited + 1))
  done
}
# `+1s234ms` (the platform's own format) in milliseconds; `-` for anything else.
duration_ms() {
  local s=${1#+}
  [ -n "$s" ] || { echo "-"; return; }
  [[ $s =~ ^(([0-9]+)m)?(([0-9]+)s)?(([0-9]+)ms)?$ ]] || { echo "-"; return; }
  echo $(( 10#${BASH_REMATCH[2]:-0} * 60000 + 10#${BASH_REMATCH[4]:-0} * 1000 + 10#${BASH_REMATCH[6]:-0} ))
}
# `1537 (ready)` from the hand-over line's `splash held 1537 ms, lifted by ready`; `-` without one.
held_by() {
  local held
  held=$(startup_log | grep -o 'splash held [0-9-]* ms, lifted by [a-z]*' | head -n 1 \
    | sed 's/splash held \([0-9-]*\) ms, lifted by \([a-z]*\)/\1 (\2)/' || true)
  echo "${held:--}"
}
# ms from epoch seconds $1 to $2 (decimals), or `-` when either is missing.
ms_between() {
  if [ -z "$1" ] || [ -z "$2" ]; then echo "-"; return; fi
  awk -v a="$1" -v b="$2" 'BEGIN { printf "%d", (b - a) * 1000 + 0.5 }'
}
# How many splash starting windows of the app the window manager has right now.
splash_windows() {
  adb shell dumpsys window windows 2> /dev/null | tr -d '\r' | grep -c "Splash Screen $app_id" || true
}
# The platform's window transitions at scale $1 (0 for cuts, 1 for the device's own). The hot
# start runs under cuts: its open transition (a fade and a scale of the resumed task over the
# launcher) would otherwise blend the launcher into the page's first frames and the reader would
# see them as neither. The app's own animators (`animator_duration_scale`) are left alone – the
# WebView reads that scale into `prefers-reduced-motion`, and the splash's exit follows it.
window_transitions() {
  adb shell settings put global transition_animation_scale "$1" || true
  adb shell settings put global window_animation_scale "$1" || true
}
# The `am start -W` answer's field $1 (TotalTime, WaitTime, LaunchState) from the text in $2.
field() {
  printf '%s\n' "$2" | sed -n "s/^$1: *//p" | head -n 1
}
# ruling 5: the frame statistics of the process since its start, on one line.
frame_stats() {
  adb shell dumpsys gfxinfo "$app_id" 2> /dev/null | tr -d '\r' \
    | awk -F': ' '/^Total frames rendered|^Janky frames|^Number Slow UI thread|^Number Frame deadline missed|^90th percentile|^99th percentile/ { gsub(/^ +/, "", $1); printf "%s %s; ", $1, $2 }'
}

verdict() {
  local holds=$1 rule=$2 detail=$3
  if [ "$holds" = true ]; then
    echo "PASS: $rule ($detail)" | tee -a "$findings"
  else
    echo "FAIL: $rule ($detail)" | tee -a "$findings"
    failures=$((failures + 1))
  fi
}

# How many of the frames script's verdicts failed: its FAIL lines, or one when it exited without a word.
frame_failures() {
  local file=$1 status=$2 n
  n=$(grep -c '^FAIL:' "$file" 2> /dev/null || true)
  n=${n:-0}
  if [ "$status" -ne 0 ] && [ "$n" -eq 0 ]; then n=1; fi
  echo "$n"
}

# The reader's hand-over gap line (`gap: N frames (M ms): ...`) for the table, `-` without one.
gap_reading() {
  local line
  line=$(sed -n 's/^gap: //p' "$1" 2> /dev/null | head -n 1 || true)
  echo "${line:--}"
}

# --- the acts -----------------------------------------------------------------------------------

rows=()
webapp_rows=()

# The seed: the driver's one act, the handshake answered without a recorder. Leaves the notes
# (the slot's rectangle, the web app's launch arguments) and the still in $1/; the process is
# gone after it.
seed() {
  local theme=$1 dir=$2
  echo "== seed ($theme)"
  rm -f "$hold_file"
  adb shell run-as "$app_id" rm -rf "files/$demo_dir" || true
  adb logcat -c || true
  adb shell am instrument -w -e class app.zen.chromium.StartupDemo -e theme "$theme" -e assert "$assert" \
    -e fixture "http://10.0.2.2:$port/fixture" "$runner" > "$dir/seed-instrument.txt" 2>&1 &
  local driver_pid=$!
  for _ in $(seq 1 480); do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/record" 2> /dev/null; then
      adb shell run-as "$app_id" touch "files/$demo_dir/recording"
      break
    fi
    kill -0 "$driver_pid" 2> /dev/null || break
    sleep 0.25
  done
  for _ in $(seq 1 480); do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/done" 2> /dev/null; then break; fi
    kill -0 "$driver_pid" 2> /dev/null || break
    sleep 0.25
  done
  local status=0
  wait "$driver_pid" || status=$?
  for name in $(adb shell run-as "$app_id" ls "files/$demo_dir" 2> /dev/null | tr -d '\r'); do
    case "$name" in
      *.png | *.txt) adb exec-out run-as "$app_id" cat "files/$demo_dir/$name" > "$dir/$name" || true ;;
    esac
  done
  adb logcat -d -v time > "$dir/seed-logcat.txt" 2> /dev/null || true
  echo "---- seed notes ($theme)"
  cat "$dir/android-startup-notes.txt" 2> /dev/null || echo "(no notes)"
  verdict "$([ "$status" -eq 0 ] && grep -q '^OK (' "$dir/seed-instrument.txt" && echo true || echo false)" \
    "the seed act ran through ($theme)" "instrumentation status $status"
  # The instrumentation's exit stops the process; said explicitly, and made sure of.
  adb shell am force-stop "$app_id" || true
  sleep 2
  if adb shell pidof "$app_id" > /dev/null 2>&1; then echo "::warning::the browser is still running after the seed"; fi
}

# The start request for way $1 (direct | alias | trampoline), run in the background with `-W`,
# its answer to $2. The alias is exported (a plain shell start, uid 2000: an APPLICATION launch
# source); the shortcuts' trampoline is not, so root – the launcher's flags on both.
start_request() {
  local way=$1 answer_file=$2
  case "$way" in
    direct)
      adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/$activity" > "$answer_file" 2>&1 &
      ;;
    alias)
      adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f "$tap_flags" -n "$app_id/$alias" > "$answer_file" 2>&1 &
      ;;
    trampoline)
      adb shell su 0 am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -f "$tap_flags" -n "$app_id/$trampoline" > "$answer_file" 2>&1 &
      ;;
    *) echo "::error::unknown way $way"; exit 2 ;;
  esac
}
# The way's name in a row and a rule.
way_label() {
  case "$1" in
    direct) echo "" ;;
    alias) echo ", the launcher's tap through the alias" ;;
    trampoline) echo ", the icon's path before round 4 (NoDisplay trampoline)" ;;
    *) echo ", $1" ;;
  esac
}
# The reader's `lead:` line from $1, `-` without one.
lead_reading() {
  local line
  line=$(sed -n 's/^lead: //p' "$1" 2> /dev/null | head -n 1 || true)
  echo "${line:--}"
}

# The cold start of the seeded session, recorded; the stills, the numbers, the order of the
# lines. $3 is the way in: `direct` (the harness's `am start` at MainActivity – every reading
# before round 4), `alias` (the launcher's own intent at the enabled icon alias:
# IconTapActivity's path, the tap as it is now), or `trampoline` (the same intent at the
# shortcuts' NoDisplay trampoline: the icon's path as it was before round 4, on the same build).
# The direct way's stills carry the round's names; the others keep their splash still under the
# way's name. Every way is read for the same rules, and for the lead from the request.
cold_start() {
  local theme=$1 dir=$2 way=${3:-direct}
  local tag=cold
  [ "$way" = direct ] || tag="cold-$way"
  local slot
  slot=$(sed -n 's/^slot: //p' "$dir/android-startup-notes.txt" 2> /dev/null | head -n 1 || true)
  echo "== cold start ($theme, $way); slot ${slot:-unknown}"
  adb shell am force-stop "$app_id" || true
  echo "$hold_ms" > "$hold_file"
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
  sleep 3
  adb logcat -c || true
  adb shell screenrecord --bit-rate 6000000 --time-limit 60 "/sdcard/startup-$tag-$theme.mp4" &
  local recorder_pid=$!
  sleep 1.5
  start_request "$way" "$dir/am-start-$tag.txt"
  local am_pid=$!
  # One second in: the splash is up (the starting window comes before the process does, the
  # hold keeps it to READY at about 3.5 s here) – the design still, and the window manager's word.
  sleep 1
  local splash_seen
  splash_seen=$(splash_windows)
  local splash_still=$dir/android-startup-design-splash-$theme.png
  [ "$way" = direct ] || splash_still=$dir/android-startup-$tag-splash-$theme.png
  adb exec-out screencap -p > "$splash_still" || true
  wait "$am_pid" || true
  local answer
  answer=$(tr -d '\r' < "$dir/am-start-$tag.txt")
  local total wait_ state
  total=$(field TotalTime "$answer")
  wait_=$(field WaitTime "$answer")
  state=$(field LaunchState "$answer")
  # READY: the chrome's first real frame drawn, the splash lifting. Then the departure's 180 ms,
  # and the picture stands under the chrome while the runner still holds the page.
  local ready_line
  ready_line=$(wait_line "chrome ready: frame drawn" 25)
  sleep 0.7
  local picture_still=$dir/android-startup-design-restored-picture-$theme.png page_still=$dir/android-startup-page-painted-$theme.png
  if [ "$way" = direct ]; then adb exec-out screencap -p > "$picture_still" || true; fi
  local splash_after
  splash_after=$(splash_windows)
  wait_line "restored picture down for $tab: painted" $(( hold_ms / 1000 + 15 )) > /dev/null
  sleep 0.7
  if [ "$way" = direct ]; then adb exec-out screencap -p > "$page_still" || true; fi
  local stats
  stats=$(frame_stats || true)
  stats=${stats:--}
  sleep 1
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  adb pull "/sdcard/startup-$tag-$theme.mp4" "$dir/startup-$tag-$theme.mp4" > /dev/null || true
  startup_log > "$dir/$tag-startup-log.txt" || true
  adb logcat -d -v time > "$dir/$tag-logcat.txt" 2> /dev/null || true
  rm -f "$hold_file"

  # The numbers: the platform's, and the lines' order on the log's own clock. The start request
  # is the FIRST START line (a trampoline's, on its ways); the forward is the second (MainActivity's).
  local fully held marks started forward_at up_at frame_at down_at up_ms frame_ms down_ms fully_ms forward_ms displayed_ms webview_path
  fully_ms=$(duration_ms "$(startup_log | grep -m 1 "Fully drawn $app_id/" | sed -n 's/.*Fully drawn [^:]*: *+\([0-9smh]*\).*/\1/p' || true)")
  displayed_ms=$(duration_ms "$(startup_log | grep -m 1 "Displayed $app_id/" | sed -n 's/.*Displayed [^:]*: *+\([0-9smh]*\).*/\1/p' || true)")
  held=$(held_by)
  marks=$(startup_log | grep -o 'boot marks: .*' | head -n 1 | sed 's/^boot marks: //' || true)
  webview_path=$(startup_log | grep -o 'webview start-up: .*' | head -n 1 | sed 's/^webview start-up: //' || true)
  started=$(line_at "ActivityTaskManager: START u0 .*cmp=$app_id/")
  forward_at=$(line_at "ActivityTaskManager: START u0 .*cmp=$app_id/$activity")
  up_at=$(line_at "restored picture up for $tab")
  frame_at=$(line_at "chrome ready: frame drawn")
  down_at=$(line_at "restored picture down for $tab: painted")
  up_ms=$(ms_between "$started" "$up_at")
  frame_ms=$(ms_between "$started" "$frame_at")
  down_ms=$(ms_between "$started" "$down_at")
  forward_ms=$(ms_between "$started" "$forward_at")
  [ "$way" = direct ] && forward_ms=0
  echo "  TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}; Displayed $displayed_ms; Fully drawn $fully_ms; splash held $held; splash windows one second in: $splash_seen, after READY: $splash_after"
  echo "  forward to MainActivity +$forward_ms ms, picture up +$up_ms ms, READY frame +$frame_ms ms, page painted +$down_ms ms (from the start request); marks $marks"
  echo "  webview start-up: ${webview_path:-no line}; frames: $stats"
  {
    echo "cold start ($theme, $way): $answer"
    echo "Displayed: $displayed_ms ms; Fully drawn: $fully_ms ms; splash held: $held; splash windows one second in: $splash_seen, after READY: $splash_after"
    echo "forward to MainActivity: +$forward_ms ms; restored picture up: +$up_ms ms; READY frame: +$frame_ms ms; page painted: +$down_ms ms"
    echo "boot marks: $marks"
    echo "webview start-up: ${webview_path:-no line}"
    echo "frame statistics: $stats"
  } > "$dir/$tag-numbers.txt"

  local label
  label=$(way_label "$way")
  verdict "$([ "${state:-}" = COLD ] && echo true || echo false)" "the start was cold ($theme$label)" "LaunchState ${state:-?}"
  verdict "$([ "$splash_seen" -gt 0 ] && echo true || echo false)" "the splash window was up one second into the cold start ($theme$label)" "$splash_seen splash window(s)"
  verdict "$([ -n "$ready_line" ] && echo true || echo false)" "the chrome's first real frame was reported (READY, Fully drawn) ($theme$label)" "Fully drawn $fully_ms ms; ${ready_line:-no chrome ready line}"
  verdict "$(case "$held" in *"(ready)") echo true ;; *) echo false ;; esac)" "READY lifted the splash, not the watchdog ($theme$label)" "splash held $held"
  verdict "$([ "$splash_after" -eq 0 ] && echo true || echo false)" "the splash window was gone after READY ($theme$label)" "$splash_after splash window(s)"
  verdict "$([ -n "$up_at" ] && echo true || echo false)" "the restored tab's picture went up ($theme$label)" "restored picture up at +$up_ms ms"
  verdict "$([ "$up_ms" != - ] && [ "$frame_ms" != - ] && [ "$up_ms" -lt "$frame_ms" ] && echo true || echo false)" \
    "the picture was up before the chrome's first frame ($theme$label)" "picture +$up_ms ms, frame +$frame_ms ms"
  verdict "$([ "$frame_ms" != - ] && [ "$down_ms" != - ] && [ "$frame_ms" -lt "$down_ms" ] && echo true || echo false)" \
    "the page's own paint took the picture down after the chrome's first frame ($theme$label)" "frame +$frame_ms ms, painted +$down_ms ms"
  if [ "$way" = direct ]; then
    verdict "$([ -n "$webview_path" ] && echo true || echo false)" "the WebView start-up path was logged ($theme)" "${webview_path:-no webview start-up line}"
  fi

  # The recording and the stills, read for their sequence (ruling 2); the hand-over gap – the
  # frames of the splash's run that were not the splash – is the reader's `gap:` line, the lead
  # from the request its `lead:` line (READY's distance from the request as the anchor).
  local gap=- lead=-
  if [ -n "$slot" ] && command -v ffmpeg > /dev/null 2>&1; then
    local status=0
    local stills=(--still "splash=$splash_still")
    [ "$way" = direct ] && stills+=(--still "picture=$picture_still" --still "page=$page_still")
    local anchor=()
    [ "$frame_ms" != - ] && anchor=(--anchor "ready=$frame_ms")
    node .github/scripts/android-startup-frames.mjs cold "$dir/startup-$tag-$theme.mp4" "$slot" "${display%@*}" "$dir/$tag-frames.txt" \
      "${stills[@]}" "${anchor[@]}" --tile "$dir/android-startup-frames-$tag-$theme.png" || status=$?
    grep -E '^(PASS|FAIL):' "$dir/$tag-frames.txt" | sed "s/)$/; $theme$label recording)/" >> "$findings" || true
    gap=$(gap_reading "$dir/$tag-frames.txt")
    lead=$(lead_reading "$dir/$tag-frames.txt")
    echo "hand-over gap ($theme$label): $gap" >> "$findings"
    echo "lead ($theme$label): $lead" >> "$findings"
    failures=$((failures + $(frame_failures "$dir/$tag-frames.txt" "$status")))
  else
    verdict false "the cold start's recording was read ($theme$label)" "$([ -z "$slot" ] && echo 'no slot from the seed' || echo 'no ffmpeg')"
  fi
  rows+=("| cold$label ($theme) | ${state:-?} | ${total:-?} | ${wait_:-?} | $displayed_ms | $fully_ms | $held | $splash_seen / $splash_after | +$forward_ms | +$up_ms | +$frame_ms | +$down_ms | $gap | ${lead%%;*} | $stats |")
  echo "marks ($theme$label): $marks" >> "$findings"
  echo "webview start-up ($theme$label): ${webview_path:-no line}" >> "$findings"
}

# Home, then the start again with the process alive: the task back as it is. $3 is the way
# (direct | alias): through the alias with the launcher's flags, the platform's resetTask branch
# brings the task forward and adds nothing – the trampoline never runs (IconTapActivity).
hot_start() {
  local theme=$1 dir=$2 way=${3:-direct}
  local tag=hot
  [ "$way" = direct ] || tag="hot-$way"
  local slot
  slot=$(sed -n 's/^slot: //p' "$dir/android-startup-notes.txt" 2> /dev/null | head -n 1 || true)
  echo "== hot start ($theme, $way)"
  window_transitions 0
  adb shell input keyevent KEYCODE_HOME || true
  sleep 3
  adb logcat -c || true
  adb shell screenrecord --bit-rate 6000000 --time-limit 30 "/sdcard/startup-$tag-$theme.mp4" &
  local recorder_pid=$!
  sleep 1.5
  start_request "$way" "$dir/am-start-$tag.txt"
  wait "$!" || true
  local answer
  answer=$(tr -d '\r' < "$dir/am-start-$tag.txt")
  local splash_seen
  splash_seen=$(splash_windows)
  adb exec-out screencap -p > "$dir/android-startup-$tag-$theme.png" || true
  sleep 1.5
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  window_transitions 1
  adb pull "/sdcard/startup-$tag-$theme.mp4" "$dir/startup-$tag-$theme.mp4" > /dev/null || true
  startup_log > "$dir/$tag-startup-log.txt" || true
  local total wait_ state startup_lines trampoline_starts label
  label=$(way_label "$way")
  total=$(field TotalTime "$answer")
  wait_=$(field WaitTime "$answer")
  state=$(field LaunchState "$answer")
  startup_lines=$(grep -c "ZenStartup" "$dir/$tag-startup-log.txt" || true)
  # A START line naming MainActivity would be the trampoline's forward: on the launcher's hot
  # tap there is none (the task came forward, nothing was added).
  trampoline_starts=$(grep -c "START u0 .*cmp=$app_id/$activity" "$dir/$tag-startup-log.txt" || true)
  echo "  TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}; splash windows right after: $splash_seen; ZenStartup lines: $startup_lines; forwards to MainActivity: $trampoline_starts"
  verdict "$([ "${state:-}" = HOT ] && echo true || echo false)" "the start with the process alive was hot ($theme$label)" "LaunchState ${state:-?}"
  verdict "$([ "$splash_seen" -eq 0 ] && echo true || echo false)" "no splash window on the hot start ($theme$label)" "$splash_seen splash window(s)"
  verdict "$([ "$startup_lines" -eq 0 ] && echo true || echo false)" "no splash hand-over and no restored picture on the hot start ($theme$label)" "$startup_lines ZenStartup line(s)"
  if [ "$way" = alias ]; then
    verdict "$([ "$trampoline_starts" -eq 0 ] && echo true || echo false)" "the launcher's hot tap brought the task forward without running the trampoline ($theme)" "$trampoline_starts START line(s) naming MainActivity"
  fi
  if [ -n "$slot" ] && command -v ffmpeg > /dev/null 2>&1; then
    local status=0 tile=$dir/android-startup-frames-warm-$theme.png
    [ "$way" = direct ] || tile=$dir/android-startup-frames-$tag-$theme.png
    node .github/scripts/android-startup-frames.mjs hot "$dir/startup-$tag-$theme.mp4" "$slot" "${display%@*}" "$dir/$tag-frames.txt" \
      --still page="$dir/android-startup-$tag-$theme.png" --tile "$tile" || status=$?
    grep -E '^(PASS|FAIL):' "$dir/$tag-frames.txt" | sed "s/)$/; $theme$label hot recording)/" >> "$findings" || true
    failures=$((failures + $(frame_failures "$dir/$tag-frames.txt" "$status")))
  fi
  rows+=("| hot$label ($theme) | ${state:-?} | ${total:-?} | ${wait_:-?} | - | - | - | $splash_seen / - | - | - | - | - | - | - | - |")
}

# The alias with NEW_TASK alone on the running browser behind the launcher – what a bare
# `am start` and callers of `getLaunchIntentForPackage` (Settings' Open) send: the platform adds
# the trampoline on top of the browser and draws its splash until the forward's clear-top
# finishes it (IconTapActivity's documented edge). Recorded for its length, not judged.
alias_open() {
  local theme=$1 dir=$2
  local slot
  slot=$(sed -n 's/^slot: //p' "$dir/android-startup-notes.txt" 2> /dev/null | head -n 1 || true)
  echo "== warm launch through the alias with NEW_TASK alone ($theme)"
  window_transitions 0
  adb shell input keyevent KEYCODE_HOME || true
  sleep 3
  adb logcat -c || true
  adb shell screenrecord --bit-rate 6000000 --time-limit 30 "/sdcard/startup-alias-open-$theme.mp4" &
  local recorder_pid=$!
  sleep 1.5
  local answer
  answer=$(adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/$alias" 2>&1 | tr -d '\r' || true)
  local splash_seen
  splash_seen=$(splash_windows)
  sleep 2
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  window_transitions 1
  adb pull "/sdcard/startup-alias-open-$theme.mp4" "$dir/startup-alias-open-$theme.mp4" > /dev/null || true
  startup_log > "$dir/alias-open-startup-log.txt" || true
  printf '%s\n' "$answer" > "$dir/am-start-alias-open.txt"
  local total wait_ state forwards splash_frames=-
  total=$(field TotalTime "$answer")
  wait_=$(field WaitTime "$answer")
  state=$(field LaunchState "$answer")
  forwards=$(grep -c "START u0 .*cmp=$app_id/$activity" "$dir/alias-open-startup-log.txt" || true)
  if [ -n "$slot" ] && command -v ffmpeg > /dev/null 2>&1; then
    node .github/scripts/android-startup-frames.mjs lead "$dir/startup-alias-open-$theme.mp4" "$slot" "${display%@*}" "$dir/alias-open-frames.txt" \
      --tile "$dir/android-startup-frames-alias-open-$theme.png" > /dev/null || true
    splash_frames=$(sed -n 's/^splash frames: //p' "$dir/alias-open-frames.txt" | head -n 1 || true)
    splash_frames=${splash_frames:--}
  fi
  echo "  TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}; splash windows right after: $splash_seen; forwards to MainActivity: $forwards; $splash_frames"
  echo "warm launch through the alias with NEW_TASK alone ($theme): LaunchState ${state:-?}, TotalTime ${total:-?}, splash windows right after $splash_seen, forwards to MainActivity $forwards; recording: $splash_frames (recorded, not judged: the trampoline's splash on a launch the launcher never sends)" >> "$findings"
  rows+=("| warm, the alias with NEW_TASK alone ($theme) | ${state:-?} | ${total:-?} | ${wait_:-?} | - | - | - | $splash_seen / - | - | - | - | - | - | ${splash_frames%%;*} | - |")
}

# A link's cold start: the process gone, a VIEW of the fixture URL at LinkDispatchActivity (the
# caller's task here is the shell's own new one), the answer not held – read for the lead alone:
# how long the launcher stood between the request and the browser's splash.
link_start() {
  local theme=$1 dir=$2
  local slot
  slot=$(sed -n 's/^slot: //p' "$dir/android-startup-notes.txt" 2> /dev/null | head -n 1 || true)
  echo "== cold start through a link ($theme)"
  adb shell am force-stop "$app_id" || true
  rm -f "$hold_file"
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
  sleep 3
  adb logcat -c || true
  adb shell screenrecord --bit-rate 6000000 --time-limit 40 "/sdcard/startup-link-$theme.mp4" &
  local recorder_pid=$!
  sleep 1.5
  adb shell am start -W -a android.intent.action.VIEW -d "http://10.0.2.2:$port/fixture" -n "$app_id/$link_activity" > "$dir/am-start-link.txt" 2>&1 &
  local am_pid=$!
  sleep 1
  local splash_seen
  splash_seen=$(splash_windows)
  adb exec-out screencap -p > "$dir/android-startup-link-splash-$theme.png" || true
  wait "$am_pid" || true
  local answer
  answer=$(tr -d '\r' < "$dir/am-start-link.txt")
  local ready_line
  ready_line=$(wait_line "chrome ready: frame drawn" 25)
  sleep 2
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  adb pull "/sdcard/startup-link-$theme.mp4" "$dir/startup-link-$theme.mp4" > /dev/null || true
  startup_log > "$dir/link-startup-log.txt" || true
  local total wait_ state started forward_at frame_at forward_ms frame_ms lead=-
  total=$(field TotalTime "$answer")
  wait_=$(field WaitTime "$answer")
  state=$(field LaunchState "$answer")
  started=$(line_at "ActivityTaskManager: START u0 .*cmp=$app_id/")
  forward_at=$(line_at "ActivityTaskManager: START u0 .*cmp=$app_id/$activity")
  frame_at=$(line_at "chrome ready: frame drawn")
  forward_ms=$(ms_between "$started" "$forward_at")
  frame_ms=$(ms_between "$started" "$frame_at")
  verdict "$([ "${state:-}" = COLD ] && echo true || echo false)" "the start through the link was cold ($theme)" "LaunchState ${state:-?}"
  verdict "$([ "$splash_seen" -gt 0 ] && echo true || echo false)" "the splash window was up one second into the link's cold start ($theme)" "$splash_seen splash window(s)"
  verdict "$([ -n "$ready_line" ] && echo true || echo false)" "the chrome's first real frame was reported on the link's cold start ($theme)" "${ready_line:-no chrome ready line}"
  if [ -n "$slot" ] && command -v ffmpeg > /dev/null 2>&1; then
    local anchor=()
    [ "$frame_ms" != - ] && anchor=(--anchor "ready=$frame_ms")
    node .github/scripts/android-startup-frames.mjs lead "$dir/startup-link-$theme.mp4" "$slot" "${display%@*}" "$dir/link-frames.txt" \
      --still splash="$dir/android-startup-link-splash-$theme.png" "${anchor[@]}" --tile "$dir/android-startup-frames-link-$theme.png" > /dev/null || true
    grep -E '^(PASS|FAIL):' "$dir/link-frames.txt" | sed "s/)$/; $theme link recording)/" >> "$findings" || true
    lead=$(lead_reading "$dir/link-frames.txt")
    echo "lead ($theme, the link's path): $lead" >> "$findings"
  fi
  echo "  TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}; forward to MainActivity +$forward_ms ms; READY +$frame_ms ms; lead: $lead"
  rows+=("| cold, the link's path ($theme) | ${state:-?} | ${total:-?} | ${wait_:-?} | - | - | - | $splash_seen / - | +$forward_ms | - | +$frame_ms | - | - | ${lead%%;*} | - |")
  adb shell am force-stop "$app_id" || true
  adb shell rm -f "/sdcard/startup-link-$theme.mp4" || true
}

# The activity re-created in the living process (`--activity-clear-task`, the relaunch demo's
# kind of start): for the record – the platform shows its starting window for a created
# activity, and the chrome boots again under it, so the hold applies as on a cold start.
warm_start() {
  local theme=$1 dir=$2
  echo "== warm start, the activity re-created ($theme)"
  adb logcat -c || true
  adb shell am start -W --activity-clear-task -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/$activity" \
    > "$dir/am-start-warm.txt" 2>&1 &
  local am_pid=$!
  sleep 1
  local splash_seen
  splash_seen=$(splash_windows)
  wait "$am_pid" || true
  local answer
  answer=$(tr -d '\r' < "$dir/am-start-warm.txt")
  local total wait_ state fully held
  total=$(field TotalTime "$answer")
  wait_=$(field WaitTime "$answer")
  state=$(field LaunchState "$answer")
  wait_line "chrome ready: frame drawn" 25 > /dev/null
  fully=$(duration_ms "$(startup_log | grep -m 1 "Fully drawn $app_id/$activity" | sed -n 's/.*Fully drawn [^:]*: *+\([0-9smh]*\).*/\1/p' || true)")
  held=$(held_by)
  startup_log > "$dir/warm-startup-log.txt" || true
  echo "  TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}; Fully drawn $fully; splash held $held; splash windows one second in: $splash_seen"
  echo "warm start ($theme), the activity re-created: LaunchState ${state:-?}, TotalTime ${total:-?}, Fully drawn $fully, splash held $held, splash windows one second in $splash_seen (recorded, not judged)" >> "$findings"
  rows+=("| warm, activity re-created ($theme) | ${state:-?} | ${total:-?} | ${wait_:-?} | - | $fully | $held | $splash_seen / - | - | - | - | - | - | - | - |")
}

# The web app's design still under $1: a screencap 0.5 s in, read by the frames script on its own
# (the whole display the slot, as the recording is read), taken again until it reads as the
# dressed splash or the attempts (3, about 3 s – the page's answer is held 4 s past the dress)
# are spent; the last taken stays, and the reader's verdict on it comes with the recording's.
dressed_still() {
  local png=$1 attempts=3 k=1 reading
  local size=${display%@*}
  while :; do
    sleep 0.5
    adb exec-out screencap -p > "$png" || true
    if ! command -v ffmpeg > /dev/null 2>&1; then return; fi
    reading=$(node .github/scripts/android-startup-frames.mjs webapp - "0 0 ${size%x*} ${size#*x}" "$size" /dev/null --still "splash=$png" 2> /dev/null \
      | sed -n 's/.*: \([a-z]*\) (left .*/\1/p' | tail -n 1 || true)
    echo "  design still: screencap $k reads ${reading:-nothing}"
    if [ "${reading:-}" = splash ] || [ "$k" -ge "$attempts" ]; then return; fi
    k=$((k + 1))
  done
}

# The system bars' state at the dressed splash, from the window manager: each window's requested
# appearance (`apr=`, the LIGHT_*_BARS bits the app asked for), the policy's last appearance and
# the window it colours the navigation bar for – the read-back of SystemBarInk's write, into $1.
bars_dump() {
  local file=$1
  {
    echo "# dumpsys window windows: each window's requested appearance"
    adb shell dumpsys window windows 2> /dev/null | tr -d '\r' \
      | awk '/^ *Window #/ { name=$0; sub(/^ *Window #[0-9]* /, "", name) } /apr=/ { match($0, /apr=[A-Z_|]*/); print name ": " substr($0, RSTART, RLENGTH) }'
    echo "# dumpsys window displays: the policy's bars"
    adb shell dumpsys window displays 2> /dev/null | tr -d '\r' \
      | grep -E "mLastAppearance|mLastNavBarAppearance|mNavBarColorWindowCandidate|mLastStatusBarAppearanceRegions|mFocusedWindow=|mTopFullscreenOpaqueWindowState|mNavigationBarLetterboxDetails" | sed 's/^ *//'
  } > "$file" 2>&1 || true
}

# The web app's cold launch (PWA-06): the process gone, the app's launch intent fired as root
# (the window is not exported; the tile's trampoline is the only other way in), the page's answer
# held so the dressed splash stands to be seen, the page's first frame lifting it. $3 is the
# way: `direct` (the app's own launch intent, the seed's `webapp-start:` line – every reading
# before round 4) or `tile` (the pinned tile's intent at WebAppLauncherActivity, the seed's
# `tile-start:` line: the tap on the home screen, less the launcher).
webapp_launch() {
  local theme=$1 dir=$2 way=${3:-direct}
  local tag=webapp key='webapp-start'
  if [ "$way" = tile ]; then tag='webapp-tile'; key='tile-start'; fi
  local label=""
  [ "$way" = direct ] || label=", the tile's path"
  local args
  args=$(sed -n "s/^$key: //p" "$dir/android-startup-notes.txt" 2> /dev/null | head -n 1 || true)
  if [ -z "$args" ]; then
    verdict false "the web app's launch arguments came from the seed ($theme$label)" "no $key line in the notes"
    return
  fi
  echo "== web app cold launch ($theme, $way)"
  adb shell am force-stop "$app_id" || true
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
  sleep 3
  echo "$webapp_hold_ms" > "$hold_file"
  adb logcat -c || true
  adb shell screenrecord --bit-rate 6000000 --time-limit 40 "/sdcard/startup-$tag-$theme.mp4" &
  local recorder_pid=$!
  sleep 1.5
  adb shell "su 0 am start -W $args" > "$dir/am-start-$tag.txt" 2>&1 &
  local am_pid=$!
  wait "$am_pid" || true
  local answer
  answer=$(tr -d '\r' < "$dir/am-start-$tag.txt")
  local total wait_ state
  total=$(field TotalTime "$answer")
  wait_=$(field WaitTime "$answer")
  state=$(field LaunchState "$answer")
  # The window's first frame is drawn (the answer came) and the hand-over dressed the splash (its
  # line). The dress's first VISIBLE frame waits on the main thread, which the hand-over frame
  # itself can hold for most of a second on this emulator (run 36070182862's light launch: a
  # 954 ms frame at the hand-over, the dress on screen about a second after its line, and a
  # screencap 0.8 s after the line caught the fixed ground) – so the design still is the first
  # screencap that reads as the dressed splash, within the held page's window.
  local dressed_line
  dressed_line=$(wait_line "web app splash: dressed at the hand-over" 10)
  local splash_still=$dir/android-startup-design-webapp-splash-$theme.png
  [ "$way" = direct ] || splash_still=$dir/android-startup-$tag-splash-$theme.png
  dressed_still "$splash_still"
  # The bars as the window manager has them while the dressed splash stands.
  bars_dump "$dir/$tag-bars-dressed.txt"
  local painted_line
  painted_line=$(wait_line "web app page painted: first frame" $(( webapp_hold_ms / 1000 + 15 )))
  sleep 0.8
  local page_still=$dir/android-startup-webapp-page-$theme.png
  if [ "$way" = direct ]; then adb exec-out screencap -p > "$page_still" || true; fi
  sleep 1
  adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
  wait "$recorder_pid" || true
  adb pull "/sdcard/startup-$tag-$theme.mp4" "$dir/startup-$tag-$theme.mp4" > /dev/null || true
  startup_log > "$dir/$tag-startup-log.txt" || true
  adb logcat -d -v time > "$dir/$tag-logcat.txt" 2> /dev/null || true
  rm -f "$hold_file"

  local held started forward_at dressed_at painted_at forward_ms dressed_ms painted_ms fully_ms displayed_ms app_bars
  held=$(held_by)
  fully_ms=$(duration_ms "$(startup_log | grep -m 1 "Fully drawn $app_id/" | sed -n 's/.*Fully drawn [^:]*: *+\([0-9smh]*\).*/\1/p' || true)")
  displayed_ms=$(duration_ms "$(startup_log | grep -m 1 "Displayed $app_id/" | sed -n 's/.*Displayed [^:]*: *+\([0-9smh]*\).*/\1/p' || true)")
  started=$(line_at "ActivityTaskManager: START u0 .*cmp=$app_id/")
  forward_at=$(line_at "ActivityTaskManager: START u0 .*cmp=$app_id/app.zen.chromium.WebAppActivity")
  dressed_at=$(line_at "web app splash: dressed at the hand-over")
  painted_at=$(line_at "web app page painted: first frame")
  forward_ms=$(ms_between "$started" "$forward_at")
  [ "$way" = direct ] && forward_ms=0
  dressed_ms=$(ms_between "$started" "$dressed_at")
  painted_ms=$(ms_between "$started" "$painted_at")
  app_bars=$(grep -m 1 "WebAppActivity" "$dir/$tag-bars-dressed.txt" 2> /dev/null | sed 's/.*: //' || true)
  echo "  TotalTime ${total:-?} WaitTime ${wait_:-?} ${state:-?}; Displayed $displayed_ms; Fully drawn $fully_ms; forward +$forward_ms ms, splash dressed +$dressed_ms ms, page painted +$painted_ms ms (from the start request); splash held $held"
  echo "  ${dressed_line:-no dressed line}"
  echo "  bars at the dress: the app window asked ${app_bars:-nothing on record}"
  {
    echo "web app cold launch ($theme, $way): $answer"
    echo "Displayed: $displayed_ms ms; Fully drawn: $fully_ms ms; forward: +$forward_ms ms; splash dressed: +$dressed_ms ms; page painted: +$painted_ms ms; splash held: $held"
    echo "${dressed_line:-no dressed line}"
    echo "${painted_line:-no page painted line}"
    echo "bars at the dress (dumpsys window): the app window asked ${app_bars:-nothing on record}"
  } > "$dir/$tag-numbers.txt"

  verdict "$([ "${state:-}" = COLD ] && echo true || echo false)" "the web app's launch was cold ($theme$label)" "LaunchState ${state:-?}"
  verdict "$(case "$dressed_line" in *"icon on"*) echo true ;; *) echo false ;; esac)" \
    "the splash was dressed at the hand-over with the tile already decoded ($theme$label)" "${dressed_line:-no dressed line}"
  verdict "$([ -n "$painted_line" ] && echo true || echo false)" "the page's first frame was reported ($theme$label)" "${painted_line:-no page painted line}; Fully drawn $fully_ms ms"
  verdict "$(case "$held" in *"(ready)") echo true ;; *) echo false ;; esac)" "the page's first frame lifted the web app's splash, not the watchdog ($theme$label)" "splash held $held"
  verdict "$([ "$dressed_ms" != - ] && [ "$painted_ms" != - ] && [ "$dressed_ms" -lt "$painted_ms" ] && echo true || echo false)" \
    "the splash was dressed before the page's first frame ($theme$label)" "dressed +$dressed_ms ms, painted +$painted_ms ms"
  # The written tone, as the window manager holds it for the app's window: both LIGHT bits
  # controlled, neither set over the fixture's dark ground (white glyphs on both bars).
  verdict "$(case "$app_bars" in *LIGHT_NAVIGATION_BARS*) echo false ;; "") echo false ;; *) echo true ;; esac)" \
    "the app window's requested navigation glyphs are light over the dressed splash (dumpsys window) ($theme$label)" "the app window asked ${app_bars:-nothing on record}"
  local gap=- lead=-
  if command -v ffmpeg > /dev/null 2>&1; then
    # The whole display is the slot: the edges read the app's ground, the centre its tile, the
    # status bar the app's own window (its theme colour) before the splash view covers it.
    local status=0 size=${display%@*}
    local stills=(--still "splash=$splash_still")
    [ "$way" = direct ] && stills+=(--still "page=$page_still")
    local anchor=()
    [ "$painted_ms" != - ] && anchor=(--anchor "ready=$painted_ms")
    node .github/scripts/android-startup-frames.mjs webapp "$dir/startup-$tag-$theme.mp4" "0 0 ${size%x*} ${size#*x}" "$size" "$dir/$tag-frames.txt" \
      "${stills[@]}" "${anchor[@]}" --tile "$dir/android-startup-frames-$tag-$theme.png" || status=$?
    grep -E '^(PASS|FAIL):' "$dir/$tag-frames.txt" | sed "s/)$/; $theme$label web app recording)/" >> "$findings" || true
    gap=$(gap_reading "$dir/$tag-frames.txt")
    lead=$(lead_reading "$dir/$tag-frames.txt")
    echo "web app gap to the tile ($theme$label): $gap" >> "$findings"
    echo "web app hand-over ($theme$label): $(sed -n 's/^hand-over: //p' "$dir/$tag-frames.txt" | head -n 1)" >> "$findings"
    echo "web app lead ($theme$label): $lead" >> "$findings"
    grep -E '^nav ' "$dir/$tag-frames.txt" | sed "s/^/web app ($theme$label) /" >> "$findings" || true
    failures=$((failures + $(frame_failures "$dir/$tag-frames.txt" "$status")))
  else
    verdict false "the web app launch's recording was read ($theme$label)" "no ffmpeg"
  fi
  webapp_rows+=("| web app cold launch$label ($theme) | ${state:-?} | ${total:-?} | ${wait_:-?} | $displayed_ms | $fully_ms | +$forward_ms | +$dressed_ms | +$painted_ms | $held | $gap | ${lead%%;*} | ${app_bars:--} |")
  adb shell am force-stop "$app_id" || true
  adb shell rm -f "/sdcard/startup-$tag-$theme.mp4" || true
}

for theme in $themes; do
  dir=$out/$theme
  mkdir -p "$dir"
  if [ "$theme" = dark ]; then adb shell cmd uimode night yes > /dev/null || true; else adb shell cmd uimode night no > /dev/null || true; fi
  sleep 2
  seed "$theme" "$dir"
  cold_start "$theme" "$dir"
  hot_start "$theme" "$dir"
  if [ "$theme" = light ]; then warm_start "$theme" "$dir"; fi
  # The reach: the same session through the trampolines' paths, on this build and boot. The
  # link's start comes last of the browser's acts – it opens the fixture in a tab of its own and
  # the seeded session (one tab, its picture) is what the cold starts before it restore.
  case " $reach " in
    *" $theme "*)
      cold_start "$theme" "$dir" alias
      hot_start "$theme" "$dir" alias
      alias_open "$theme" "$dir"
      cold_start "$theme" "$dir" trampoline
      link_start "$theme" "$dir"
      ;;
  esac
  webapp_launch "$theme" "$dir"
  case " $reach " in
    *" $theme "*) webapp_launch "$theme" "$dir" tile ;;
  esac
  adb shell am force-stop "$app_id" || true
  adb shell "rm -f /sdcard/startup-*-$theme.mp4" || true
  sleep 2
done
adb shell cmd uimode night no > /dev/null || true

{
  echo "The browser's starts on the seeded session (one fixture tab, its picture on disk), \`am start -W\`; ms. The plain rows start MainActivity directly (the harness's way, no user's); the rows that name a way start it as the user does – the launcher's intent (MAIN/LAUNCHER, NEW_TASK | RESET_TASK_IF_NEEDED) at the icon alias (IconTapActivity's path) or at the shortcuts' NoDisplay trampoline (the icon's path before round 4, on the same build), a VIEW of the fixture URL at LinkDispatchActivity (the link's path). TotalTime: the platform's, the start request to the first frame of the activity it waited for (on a trampoline's path, the trampoline's start to MainActivity's first frame). Displayed / Fully drawn: the platform's lines – the window's first frame, the chrome's first real frame (reportFullyDrawn at READY), both from the request (a trampoline's sequence is one launch to the platform). Forward: the trampoline's START of MainActivity, ms after the request (0 on a direct start). Then the three moments, ms after the request on logcat's clock: the restored picture up, the READY frame drawn, the page's own paint taking the picture down. Splash windows: in \`dumpsys window\` one second in / after READY. Hand-over gap: the recording's frames of the splash's run that were not the splash – the app window's own first frame(s) between the platform's starting window and the transferred splash view – blank (a plain window) or ground (the boot theme's, the splash's colour). Lead: the recording's ms from the start request to the first splash frame (the request placed by READY's distance from it on the log's clock; short by up to two frames, 100 ms) – what the user sees between the tap and the splash, and for how long (the reader's \`lead:\` line in the findings names it: the launcher standing, black, a plain window)."
  echo
  echo "device: $(head -n 1 "$out/device.txt"); display $(sed -n 2p "$out/device.txt" | sed 's/.*: //') at $(sed -n 3p "$out/device.txt" | sed 's/.*: //') dpi; $(grep -m 1 'Current WebView' "$out/device.txt" || true)"
  echo
  echo "| start | LaunchState | TotalTime | WaitTime | Displayed | Fully drawn | splash held (by) | splash windows | forward | picture up | READY frame | page painted | hand-over gap | lead | frame statistics since the process start |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  for row in "${rows[@]}"; do echo "$row"; done
  echo
  echo "The fixture web app's cold launch (PWA-06, WebAppActivity, the process gone, the page's answer held $webapp_hold_ms ms): the plain row fires the app's own launch intent (the harness's way); the tile's row fires the pinned tile's intent at WebAppLauncherActivity (NoDisplay, the tap on the home screen less the launcher), its forward the START of WebAppActivity ms after the request. TotalTime the platform's window (the fixed ground); Displayed / Fully drawn the platform's lines from the request; the moments are ms after the request on logcat's clock – the splash dressed in the app's colour and tile at the hand-over, the page's first frame (reportFullyDrawn, the splash lifting). Gap to the tile: the recording's frames from the first frame of the app's window (the platform's fixed ground) to the first frame of the dressed splash – plain (the fixed ground) and the hand-over's own (ground: the page view's background standing in for the splash's; bare: the page view white) – the whole of what stands before the tile. Lead: as above, the request to the first frame of the app's window (the page's first frame the anchor). App window bars: the LIGHT_*_BARS bits the app's window asked the window manager for while the dressed splash stood (\`dumpsys window\`, \`apr=\`; both bits absent = light glyphs on both bars over the fixture's dark ground)."
  echo
  echo "| launch | LaunchState | TotalTime | WaitTime | Displayed | Fully drawn | forward | splash dressed | page painted | splash held (by) | gap to the tile | lead | app window bars |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  for row in "${webapp_rows[@]}"; do echo "$row"; done
  echo
  echo "verdicts: $(grep -c '^PASS' "$findings" || true) held, $failures did not"
} | tee "$table"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Startup scene"; echo; cat "$table"; echo; echo '```'; cat "$findings"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
echo "---- findings"
cat "$findings"

if [ "$failures" -gt 0 ]; then
  if [ "$assert" = true ]; then
    echo "::error::$failures verdict(s) did not hold (see startup-findings.txt)"
    exit 1
  fi
  echo "::warning::$failures verdict(s) did not hold (see startup-findings.txt)"
fi
exit 0
