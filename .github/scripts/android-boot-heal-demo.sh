#!/usr/bin/env bash
# The boot heal scene (W6-HF2, after #490 and #503), run on the workflow runner once the emulator
# has booted (android-boot-heal-demo.yml's `script`, or the nightly's shard). Two holes of the
# phone's boot, each proved on the device per colour scheme, with `am start -W` cold starts from
# a dead process and the platform's own lines (`Fully drawn` is `reportFullyDrawn` at READY; the
# splash's hand-over line says whether READY or the 10 s watchdog lifted it):
#
#   the heal    a profile as v0.4.71–v0.4.76 wrote it – #490's `zen://blank` tab the space's one
#               tab, never navigated – seeded under `files/zen/state.json` after `pm clear`, then
#               the cold start: `Fully drawn`, the splash lifted by READY, the core's line
#               `closed the restored blank tab (#490)` in the chrome's console (ZenChrome), NO
#               page view in the window (`dumpsys activity top`: the space is empty, as before
#               #490), the profile on disk with no tab; the still once READY has lifted the splash
#               (android-boot-heal-empty-space-<theme>.png). Then the healed profile started
#               again: no heal line (nothing left to heal), READY again, still no page view.
#   the tour    `pm clear`, then the cold start THROUGH A LINK on the fresh profile (`am start -W
#               -a android.intent.action.VIEW -d https://example.com/` at LinkDispatchActivity,
#               the link's path): `Fully drawn` before the watchdog, the splash lifted by READY,
#               no watchdog line; the intent's page view in the window but GONE – the reporter
#               says the content is hidden while the phone's first-run tour stands, so the host
#               never places it and the page cannot cover the tour; the still with the tour
#               standing (android-boot-heal-tour-over-link-<theme>.png). Then the driver
#               (BootHealDemo.kt, `am instrument` on the SAME profile, kept): the tour over the
#               restored page again, walked to its end – the omnibox up in new-tab mode over the
#               page (the core's rule on a host without the new tab page, no tab made), the page's
#               view VISIBLE with the slot's size, a back closing the omnibox, the page standing
#               with its text in the accessibility tree; its stills pulled as
#               android-boot-heal-tour-restored-<theme>.png, -tour-ended-omnibox-<theme>.png,
#               -page-placed-<theme>.png, its claims in boot-heal-findings.txt.
#
# Everything lands under DEMO_OUT: per scheme <theme>/ (the am start answers, the stills, the
# logs, the driver's files), boot-heal-findings.txt (every verdict), boot-heal-table.md (the
# numbers, also the job summary). BOOT_HEAL_ASSERT=true fails the run on a verdict that did not
# hold; anything else reports only.
#
#   DEMO_OUT          where the findings go (artifacts/android-boot-heal-demo by default)
#   DEMO_PREPARED     1 when an earlier driver on this boot prepared the device (the nightly)
#   DEMO_DISPLAY      <w>x<h>@<density>, 720x1600@280 by default (the phone recipe)
#   BOOT_HEAL_THEMES  the schemes to run, `light dark` by default (the nightly runs light)
#   BOOT_HEAL_ASSERT  true to fail on a verdict that did not hold
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
activity=app.zen.chromium.MainActivity
link_activity=app.zen.chromium.LinkDispatchActivity
link=https://example.com/
demo_dir=boot-heal-demo
out=${DEMO_OUT:-artifacts/android-boot-heal-demo}
assert=${BOOT_HEAL_ASSERT:-false}
themes=${BOOT_HEAL_THEMES:-light dark}
display=${DEMO_DISPLAY:-720x1600@280}
mkdir -p "$out"
findings=$out/boot-heal-findings.txt
table=$out/boot-heal-table.md
: > "$findings"
failures=0

adb wait-for-device

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
cleanup() {
  kill "$monitor_pid" 2> /dev/null || true
}
trap cleanup EXIT

if [ "${DEMO_PREPARED:-0}" != 1 ]; then
  # The demos' device (android-gesture-demo.sh, the startup scene): the same display, no error
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

# The ZenStartup and ActivityTaskManager lines since the last `logcat -c`.
startup_log() {
  adb logcat -d -v epoch -s ZenStartup:I ActivityTaskManager:I 2> /dev/null | tr -d '\r'
}
# The chrome's console since the last `logcat -c` (the core's `console.*` through ChromeWebView).
chrome_log() {
  adb logcat -d -v time -s ZenChrome:D 2> /dev/null | tr -d '\r'
}
# Wait up to $2 seconds for a startup line matching $1 (extended regex); echoes it (or nothing).
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
# The platform's `Fully drawn` for the app, ms after the start request; `-` without one.
fully_drawn_ms() {
  duration_ms "$(startup_log | grep -m 1 "Fully drawn $app_id/" | sed -n 's/.*Fully drawn [^:]*: *+\([0-9smh]*\).*/\1/p' || true)"
}
# `1537 (ready)` from the hand-over line's `splash held 1537 ms, lifted by ready`; `-` without one.
held_by() {
  local held
  held=$(startup_log | grep -o 'splash held [0-9-]* ms, lifted by [a-z]*' | head -n 1 \
    | sed 's/splash held \([0-9-]*\) ms, lifted by \([a-z]*\)/\1 (\2)/' || true)
  echo "${held:--}"
}
# The `am start -W` answer's field $1 (TotalTime, WaitTime, LaunchState) from the text in $2.
field() {
  printf '%s\n' "$2" | sed -n "s/^$1: *//p" | head -n 1
}
# The host's page views in the top activity's window, one per line as `<V|I|G> <l,t-r,b>`
# (`dumpsys activity top`: the view hierarchy, each view's flags – the first is its visibility –
# and its frame). Nothing when the window has none.
page_views() {
  adb shell dumpsys activity top 2> /dev/null | tr -d '\r' \
    | grep -oE 'TabWebView\{[0-9a-f]+ [VIG][^ ]* [^ ]* [0-9]+,[0-9]+-[0-9]+,[0-9]+' \
    | sed -E 's/TabWebView\{[0-9a-f]+ ([VIG])[^ ]* [^ ]* ([0-9,-]+)/\1 \2/' || true
}
# How many tabs the profile on disk holds (`files/zen/state.json`), `-` when it cannot be read.
persisted_tabs() {
  local json
  json=$(adb exec-out run-as "$app_id" cat files/zen/state.json 2> /dev/null || true)
  [ -n "$json" ] || { echo "-"; return; }
  printf '%s' "$json" | node -e '
    let text = "";
    process.stdin.on("data", (c) => (text += c));
    process.stdin.on("end", () => {
      try {
        const s = JSON.parse(text);
        const tabs = Array.isArray(s.tabs) ? s.tabs.map((t) => t.url) : [];
        console.log(`${tabs.length}${tabs.length ? " " + tabs.join(" ") : ""}`);
      } catch {
        console.log("-");
      }
    });
  '
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

# --- the profiles -------------------------------------------------------------------------------

# A profile as v0.4.71–v0.4.76 wrote it on the phone: #490's blank tab the space's one tab, never
# navigated (no history, no back/forward stack), the first run done. $1 is the colour scheme.
blank_tab_profile() {
  cat <<EOF
{
  "version": 2,
  "activeSpaceId": "space_main",
  "spaces": [
    {
      "id": "space_main",
      "name": "Browse",
      "icon": "🧭",
      "containerId": "default",
      "tabIds": ["tab_blank"],
      "activeTabId": "tab_blank",
      "pinnedCollapsed": false
    }
  ],
  "folders": [],
  "tabs": [
    {
      "id": "tab_blank",
      "spaceId": "space_main",
      "containerId": "default",
      "folderId": null,
      "url": "zen://blank",
      "title": "New tab",
      "pinned": false,
      "essential": false
    }
  ],
  "essentialTabIds": [],
  "containers": [],
  "splitGroups": [],
  "settings": {
    "onboardingDone": true,
    "colorScheme": "$1",
    "gestureHintDone": true,
    "fullscreenHintDone": true,
    "updates": { "autoCheck": false, "autoDownload": false, "channel": "stable" }
  },
  "shortcutOverrides": {},
  "bookmarks": [],
  "windows": [
    {
      "id": "window_main",
      "bounds": null,
      "maximized": false,
      "activeSpaceId": "space_main",
      "selection": { "space_main": "tab_blank" },
      "compact": false
    }
  ]
}
EOF
}

# The app's data cleared, then $1 (a file) written as the profile's `files/zen/state.json`
# through run-as (the app's own uid; `pm clear` leaves nothing, the directories included).
seed_profile() {
  adb shell pm clear "$app_id" > /dev/null
  adb push "$1" /data/local/tmp/boot-heal-state.json > /dev/null
  adb shell chmod 644 /data/local/tmp/boot-heal-state.json
  adb shell run-as "$app_id" mkdir -p files/zen
  adb shell run-as "$app_id" cp /data/local/tmp/boot-heal-state.json files/zen/state.json
  adb shell rm -f /data/local/tmp/boot-heal-state.json || true
  echo "seeded: $(adb exec-out run-as "$app_id" wc -c files/zen/state.json | tr -d '\r') bytes of state.json"
}

# --- the acts -----------------------------------------------------------------------------------

rows=()

# A cold start of MainActivity (the harness's direct way), the process gone: the answer to $1,
# READY waited for, then a moment for the chrome's first frames to settle.
cold_start_main() {
  adb shell am force-stop "$app_id" || true
  sleep 1
  adb logcat -c || true
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$app_id/$activity" > "$1" 2>&1 || true
  wait_line "chrome ready: frame drawn|did not report ready" 25 > /dev/null
  sleep 2.5
}

# The heal ($1 the scheme, $2 its directory): the seeded profile's cold start, the still, the
# readings; then the healed profile's second start.
heal_act() {
  local theme=$1 dir=$2
  echo "== the heal ($theme): #490's blank tab restored as the space's one tab"
  local seed=$dir/seed-state.json
  blank_tab_profile "$theme" > "$seed"
  seed_profile "$seed"
  cold_start_main "$dir/am-start-heal.txt"
  adb exec-out screencap -p > "$dir/android-boot-heal-empty-space-$theme.png" || true
  local answer state fully held heal_line views persisted
  answer=$(tr -d '\r' < "$dir/am-start-heal.txt")
  state=$(field LaunchState "$answer")
  fully=$(fully_drawn_ms)
  held=$(held_by)
  heal_line=$(chrome_log | grep -F -m 1 'closed the restored blank tab (#490)' || true)
  views=$(page_views)
  sleep 1
  persisted=$(persisted_tabs)
  startup_log > "$dir/heal-startup-log.txt" || true
  chrome_log > "$dir/heal-chrome-log.txt" || true
  adb logcat -d -v time > "$dir/heal-logcat.txt" 2> /dev/null || true
  echo "  $answer" | tr '\n' ' '; echo
  echo "  Fully drawn $fully ms; splash held $held; heal line: ${heal_line:-none}; page views: ${views:-none}; on disk: $persisted tab(s)"
  verdict "$([ "${state:-}" = COLD ] && echo true || echo false)" "the heal's start was cold ($theme)" "LaunchState ${state:-?}"
  verdict "$([ "$fully" != - ] && echo true || echo false)" "the chrome reported its first real frame on the seeded profile (READY, Fully drawn) ($theme)" "Fully drawn $fully ms"
  verdict "$(case "$held" in *"(ready)") echo true ;; *) echo false ;; esac)" "READY lifted the splash, not the watchdog, on the seeded profile ($theme)" "splash held $held"
  verdict "$([ -n "$heal_line" ] && echo true || echo false)" "the boot closed the restored blank tab (#490) ($theme)" "${heal_line:-no heal line in the chrome console}"
  verdict "$([ -z "$views" ] && echo true || echo false)" "the space is empty after the heal: no page view in the window ($theme)" "page views: ${views:-none}"
  verdict "$([ "${persisted%% *}" = 0 ] && echo true || echo false)" "the healed profile on disk holds no tab ($theme)" "state.json tabs: $persisted"
  rows+=("| the heal, seeded profile ($theme) | ${state:-?} | $(field TotalTime "$answer") | $fully | $held | $([ -n "$heal_line" ] && echo yes || echo no) | ${views:-none} | ${persisted%% *} |")

  echo "== the heal ($theme): the healed profile started again"
  cold_start_main "$dir/am-start-healed.txt"
  answer=$(tr -d '\r' < "$dir/am-start-healed.txt")
  state=$(field LaunchState "$answer")
  fully=$(fully_drawn_ms)
  held=$(held_by)
  heal_line=$(chrome_log | grep -F -m 1 'closed the restored blank tab (#490)' || true)
  views=$(page_views)
  startup_log > "$dir/healed-startup-log.txt" || true
  chrome_log > "$dir/healed-chrome-log.txt" || true
  echo "  Fully drawn $fully ms; splash held $held; heal line: ${heal_line:-none}; page views: ${views:-none}"
  verdict "$([ -z "$heal_line" ] && echo true || echo false)" "the healed profile heals no further on its next start ($theme)" "${heal_line:-no heal line}"
  verdict "$(case "$held" in *"(ready)") echo true ;; *) echo false ;; esac)" "READY lifted the splash on the healed profile's next start ($theme)" "splash held $held; Fully drawn $fully ms"
  verdict "$([ -z "$views" ] && echo true || echo false)" "the space is still empty on the healed profile's next start ($theme)" "page views: ${views:-none}"
  rows+=("| the healed profile again ($theme) | ${state:-?} | $(field TotalTime "$answer") | $fully | $held | $([ -n "$heal_line" ] && echo yes || echo no) | ${views:-none} | - |")
  adb shell am force-stop "$app_id" || true
}

# The tour ($1 the scheme, $2 its directory): the fresh profile's cold start through the link, the
# still with the tour standing, the readings; then the driver's act on the same profile.
tour_act() {
  local theme=$1 dir=$2
  echo "== the tour ($theme): a fresh profile's first launch from a link"
  adb shell am force-stop "$app_id" || true
  adb shell pm clear "$app_id" > /dev/null
  sleep 1
  adb logcat -c || true
  adb shell am start -W -a android.intent.action.VIEW -d "$link" -n "$app_id/$link_activity" > "$dir/am-start-link.txt" 2>&1 || true
  wait_line "chrome ready: frame drawn|did not report ready" 25 > /dev/null
  sleep 2.5
  adb exec-out screencap -p > "$dir/android-boot-heal-tour-over-link-$theme.png" || true
  local answer state fully held watchdog views
  answer=$(tr -d '\r' < "$dir/am-start-link.txt")
  state=$(field LaunchState "$answer")
  fully=$(fully_drawn_ms)
  held=$(held_by)
  watchdog=$(startup_log | grep -F -m 1 'did not report ready' || true)
  views=$(page_views)
  startup_log > "$dir/link-startup-log.txt" || true
  chrome_log > "$dir/link-chrome-log.txt" || true
  adb logcat -d -v time > "$dir/link-logcat.txt" 2> /dev/null || true
  echo "  $answer" | tr '\n' ' '; echo
  echo "  Fully drawn $fully ms; splash held $held; watchdog: ${watchdog:-none}; page views: ${views:-none}"
  verdict "$([ "${state:-}" = COLD ] && echo true || echo false)" "the start through the link was cold ($theme)" "LaunchState ${state:-?}"
  verdict "$([ "$fully" != - ] && echo true || echo false)" "the chrome reported its first real frame under the tour (READY, Fully drawn) ($theme)" "Fully drawn $fully ms"
  verdict "$(case "$held" in *"(ready)") echo true ;; *) echo false ;; esac)" "READY lifted the splash before the watchdog on the link's first launch ($theme)" "splash held $held"
  verdict "$([ -z "$watchdog" ] && echo true || echo false)" "the splash's watchdog did not fire on the link's first launch ($theme)" "${watchdog:-no watchdog line}"
  local views_n=0
  [ -n "$views" ] && views_n=$(printf '%s\n' "$views" | grep -c . || true)
  verdict "$([ "$views_n" = 1 ] && [ "${views%% *}" = G ] && echo true || echo false)" \
    "the intent's page view is in the window but hidden under the tour, never placed over it ($theme)" "page views: ${views:-none}"
  rows+=("| the tour, fresh profile through the link ($theme) | ${state:-?} | $(field TotalTime "$answer") | $fully | $held | - | ${views:-none} | - |")

  echo "== the tour ($theme): the driver walks it to its end over the restored page"
  adb shell am force-stop "$app_id" || true
  sleep 1
  adb shell run-as "$app_id" rm -rf "files/$demo_dir" || true
  adb logcat -c || true
  adb shell am instrument -w -e class app.zen.chromium.BootHealDemo -e theme "$theme" "$runner" > "$dir/driver-instrument.txt" 2>&1 &
  local driver_pid=$!
  for _ in $(seq 1 480); do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/record" 2> /dev/null; then
      adb shell run-as "$app_id" touch "files/$demo_dir/recording"
      break
    fi
    kill -0 "$driver_pid" 2> /dev/null || break
    sleep 0.25
  done
  for _ in $(seq 1 720); do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/done" 2> /dev/null; then break; fi
    kill -0 "$driver_pid" 2> /dev/null || break
    sleep 0.25
  done
  local status=0
  wait "$driver_pid" || status=$?
  local pull_dir=$dir/driver
  mkdir -p "$pull_dir"
  for name in $(adb shell run-as "$app_id" ls "files/$demo_dir" 2> /dev/null | tr -d '\r'); do
    case "$name" in
      *.png | *.txt) adb exec-out run-as "$app_id" cat "files/$demo_dir/$name" > "$pull_dir/$name" || true ;;
    esac
  done
  adb logcat -d -v time > "$dir/driver-logcat.txt" 2> /dev/null || true
  # The driver's stills under the scene's names (a name claims exactly what it shows).
  [ -f "$pull_dir/boot-heal-01-tour-over-page.png" ] && cp "$pull_dir/boot-heal-01-tour-over-page.png" "$dir/android-boot-heal-tour-restored-$theme.png"
  [ -f "$pull_dir/boot-heal-02-tour-ended-omnibox.png" ] && cp "$pull_dir/boot-heal-02-tour-ended-omnibox.png" "$dir/android-boot-heal-tour-ended-omnibox-$theme.png"
  [ -f "$pull_dir/boot-heal-03-page-placed.png" ] && cp "$pull_dir/boot-heal-03-page-placed.png" "$dir/android-boot-heal-page-placed-$theme.png"
  echo "---- driver findings ($theme)"
  cat "$pull_dir/boot-heal-findings.txt" 2> /dev/null || echo "(no findings)"
  verdict "$([ "$status" -eq 0 ] && grep -q '^OK (' "$dir/driver-instrument.txt" && echo true || echo false)" \
    "the driver's act ran through ($theme)" "instrumentation status $status"
  # The driver's own claims, counted with the script's.
  if [ -f "$pull_dir/boot-heal-findings.txt" ]; then
    while IFS= read -r line; do
      case "$line" in
        *" FAIL"*) echo "FAIL: $line ($theme, the driver's act)" >> "$findings"; failures=$((failures + 1)) ;;
        *" PASS"*) echo "PASS: $line ($theme, the driver's act)" >> "$findings" ;;
      esac
    done < "$pull_dir/boot-heal-findings.txt"
  fi
  adb shell am force-stop "$app_id" || true
}

for theme in $themes; do
  dir=$out/$theme
  mkdir -p "$dir"
  case "$theme" in
    dark) adb shell cmd uimode night yes > /dev/null || true ;;
    *) adb shell cmd uimode night no > /dev/null || true ;;
  esac
  sleep 2
  heal_act "$theme" "$dir"
  tour_act "$theme" "$dir"
  sleep 2
done
adb shell cmd uimode night no > /dev/null || true

{
  echo "The phone's boot on two profiles, \`am start -W\` from a dead process; ms. The heal: a profile as v0.4.71–v0.4.76 wrote it (#490's \`zen://blank\` tab the space's one tab, never navigated), then the healed profile again. The tour: a fresh profile's first launch through a link (a VIEW of $link at LinkDispatchActivity). TotalTime: the platform's, the start request to the first frame of the activity it waited for. Fully drawn: the platform's line, the chrome's first real frame (reportFullyDrawn at READY) from the request. Splash held (by): the hand-over line – READY or the 10 s watchdog lifted the splash. Heal line: the core's \`closed the restored blank tab (#490)\` in the chrome's console. Page views: the host's page views in the window once READY has lifted the splash, visibility (V/I/G) and frame, from \`dumpsys activity top\` – none after the heal (the space is empty), one GONE under the tour (hidden, never placed over it). On disk: the tabs in state.json after the heal."
  echo
  echo "device: $(head -n 1 "$out/device.txt"); display $(sed -n 2p "$out/device.txt" | sed 's/.*: //') at $(sed -n 3p "$out/device.txt" | sed 's/.*: //') dpi; $(grep -m 1 'Current WebView' "$out/device.txt" || true)"
  echo
  echo "| start | LaunchState | TotalTime | Fully drawn | splash held (by) | heal line | page views | tabs on disk |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
  for row in "${rows[@]}"; do echo "$row"; done
  echo
  echo "verdicts: $(grep -c '^PASS' "$findings" || true) held, $failures did not"
} | tee "$table"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Boot heal scene"; echo; cat "$table"; echo; echo '```'; cat "$findings"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
echo "---- findings"
cat "$findings"

if [ "$failures" -gt 0 ]; then
  if [ "$assert" = true ]; then
    echo "::error::$failures verdict(s) did not hold (see boot-heal-findings.txt)"
    exit 1
  fi
  echo "::warning::$failures verdict(s) did not hold (see boot-heal-findings.txt)"
fi
exit 0
