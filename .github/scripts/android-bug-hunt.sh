#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs the debug APK with an empty
# profile and walks every surface of the phone chrome the way a user would, through adb (taps,
# swipes, typed text, system intents, rotation, dark mode, font scale, force-stop), screenshotting
# before and after every step while `screenrecord` rolls in 170-second segments and logcat is
# captured. Everything lands under artifacts/android-bug-hunt/:
#   shots/NNN-<step>-<what>.png   screenshots, numbered in the order they were taken
#   ui/NNN-<what>.xml             uiautomator dumps (accessibility tree) used to find controls
#   video/android-bughunt-segNN.mp4, segments.txt (epoch start of each segment)
#   timeline.txt                  every step and screenshot with its elapsed time
#   logcat.txt, dumpsys-*.txt, host-monitor.txt
# Controls are found by their accessible name (aria-label or text) in the uiautomator dump, with
# the computed Pixel-6-at-280-dpi layout as the fallback. Nothing here asserts: a missing control
# is logged as a finding and the walk carries on.
set -uo pipefail

app_id=app.zen.chromium.debug
activity=app.zen.chromium.debug/app.zen.chromium.MainActivity
out=artifacts/android-bug-hunt
shots=$out/shots
dumps=$out/ui
mkdir -p "$shots" "$dumps" "$out/video"

t0=$(date +%s)
shot_n=0

# --- logging, screenshots, tree dumps ---------------------------------------------------------

log() {
  printf '%s [%5ds] %s\n' "$(date +%T)" "$(( $(date +%s) - t0 ))" "$*" | tee -a "$out/timeline.txt"
}
step() { log "=== STEP $*"; }
finding() { log "FINDING: $*"; }

shot() {
  shot_n=$((shot_n + 1))
  local f
  f=$(printf '%03d-%s.png' "$shot_n" "$1")
  if ! adb exec-out screencap -p > "$shots/$f" 2> /dev/null || [ ! -s "$shots/$f" ]; then
    log "screencap failed for $f"
    rm -f "$shots/$f"
  fi
  log "shot $f"
}

# Dumps the accessibility tree of the active window to ui/ and prints the file path. Retries:
# uiautomator refuses to dump while the screen keeps animating.
dump() {
  local f
  f="$dumps/$(printf '%03d' "$shot_n")-$1.xml"
  local attempt
  for attempt in 1 2 3; do
    if adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 &&
      adb exec-out cat /sdcard/ui.xml > "$f" 2> /dev/null && [ -s "$f" ]; then
      echo "$f"
      return 0
    fi
    sleep 1
  done
  echo ""
  return 1
}

# find_in <xml> <exact|prefix|contains> <needle> [index] → "cx cy x1 y1 x2 y2" of the match.
find_in() {
  python3 - "$@" << 'PY'
import re, sys
import xml.etree.ElementTree as ET
path, mode, needle = sys.argv[1], sys.argv[2], sys.argv[3]
index = int(sys.argv[4]) if len(sys.argv) > 4 else 0
try:
    root = ET.parse(path).getroot()
except Exception:
    sys.exit(1)
def ok(v):
    if not v:
        return False
    if mode == 'exact':
        return v == needle
    if mode == 'prefix':
        return v.startswith(needle)
    return needle.lower() in v.lower()
hits = []
for node in root.iter('node'):
    if ok(node.get('content-desc')) or ok(node.get('text')):
        m = re.match(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', node.get('bounds', ''))
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        if x2 - x1 <= 0 or y2 - y1 <= 0:
            continue
        hits.append((x1, y1, x2, y2))
if index < len(hits):
    x1, y1, x2, y2 = hits[index]
    print((x1 + x2) // 2, (y1 + y2) // 2, x1, y1, x2, y2)
    sys.exit(0)
sys.exit(1)
PY
}

# texts_in <xml> → every distinct text / content-desc in the tree, one per line (for the log).
texts_in() {
  python3 - "$1" << 'PY'
import sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(0)
seen = []
for node in root.iter('node'):
    for key in ('content-desc', 'text'):
        v = node.get(key)
        if v and v not in seen:
            seen.append(v)
print(' | '.join(seen)[:1500])
PY
}

# Where the tab WebView is (the smaller WebView; the chrome's fills the window).
webview_bounds() {
  python3 - "$1" << 'PY'
import re, sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(1)
best = None
for node in root.iter('node'):
    if node.get('class') != 'android.webkit.WebView':
        continue
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not m:
        continue
    x1, y1, x2, y2 = map(int, m.groups())
    area = (x2 - x1) * (y2 - y1)
    if area <= 0:
        continue
    if best is None or area < best[0]:
        best = (area, x1, y1, x2, y2)
if best is None:
    sys.exit(1)
print(*best[1:])
PY
}

tap() { adb shell input tap "$1" "$2"; }
key() { adb shell input keyevent "$1"; }
swipe() { adb shell input swipe "$1" "$2" "$3" "$4" "${5:-300}"; }
long_press() { adb shell input swipe "$1" "$2" "$1" "$2" 1200; }
# Spaces become %s; the argument is single-quoted for the device shell, so no quotes inside.
type_text() { adb shell input text "'${1// /%s}'"; }

# tap_label <mode> <needle> [index] → taps the control, returns 1 (and logs) when it is missing.
# The WebView builds its accessibility tree only once uiautomator connects, so a first dump can
# come back without the chrome's controls: look twice before giving up.
tap_label() {
  local mode=$1 needle=$2 index=${3:-0} xml pos attempt
  for attempt in 1 2; do
    xml=$(dump "find-${needle//[^A-Za-z0-9]/_}") || true
    pos=$(find_in "$xml" "$mode" "$needle" "$index") || pos=""
    [ -n "$pos" ] && break
    sleep 1
  done
  if [ -z "$pos" ]; then
    log "not found: '$needle' (tree: $(texts_in "$xml"))"
    return 1
  fi
  # shellcheck disable=SC2086
  set -- $pos
  log "tap '$needle' at $1,$2"
  tap "$1" "$2"
}

# wait_label <mode> <needle> <seconds> → 0 as soon as the control exists.
wait_label() {
  local deadline=$(( $(date +%s) + $3 )) xml
  while [ "$(date +%s)" -lt "$deadline" ]; do
    xml=$(dump "wait-${2//[^A-Za-z0-9]/_}") || true
    if [ -n "$xml" ] && find_in "$xml" "$1" "$2" > /dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

has_label() {
  local xml
  xml=$(dump "has-${2//[^A-Za-z0-9]/_}") || true
  [ -n "$xml" ] && find_in "$xml" "$1" "$2" > /dev/null
}

# What the "Tabs (N)" button says, or "?" when the bar is not in the tree.
tabs_count() {
  local xml
  xml=$(dump "tabs") || true
  python3 - "$xml" << 'PY'
import re, sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    print('?'); sys.exit(0)
for node in root.iter('node'):
    m = re.match(r'Tabs \((\d+|∞)\)', node.get('content-desc') or '')
    if m:
        print(m.group(1)); sys.exit(0)
print('?')
PY
}

top_window() {
  adb shell dumpsys window 2> /dev/null | grep -E 'mCurrentFocus|mFocusedApp' | head -2 | tr -s ' ' | tr '\n' ' '
}

# Pixel 6 layout at wm size 720x1600 / density 280 with three-button navigation: the bar's
# buttons are 44 dp squares from the edges, the pill sits between them, 28 dp above the nav bar.
px() { python3 -c "print(round($1 * 1.75))"; }
W=720
H=1600
NAV=$(px 48)
PILL_Y=$((H - NAV - $(px 28)))
PILL_L=$(px 56)
PILL_R=$(px 259)
PILL_X=$(( (PILL_L + PILL_R) / 2 ))
BACK_X=$(px 30)
NEWTAB_X=$(px 285)
TABS_X=$(px 333)
MENU_X=$(px 381)

# The pill, from the tree when possible (its position depends on the nav bar and the keyboard).
pill_pos() {
  local xml pos
  xml=$(dump "pill") || true
  pos=$(find_in "$xml" exact Address) || pos=""
  if [ -n "$pos" ]; then echo "$pos"; else echo "$PILL_X $PILL_Y $PILL_L $((PILL_Y - 38)) $PILL_R $((PILL_Y + 38))"; fi
}
tap_pill() {
  # shellcheck disable=SC2046
  set -- $(pill_pos)
  log "tap pill at $1,$2"
  tap "$1" "$2"
}
tap_menu() { tap_label exact Menu || tap "$MENU_X" "$PILL_Y"; }
tap_tabs() { tap_label prefix 'Tabs (' || tap "$TABS_X" "$PILL_Y"; }
tap_newtab() { tap_label exact 'New tab' || tap "$NEWTAB_X" "$PILL_Y"; }

# Open the omnibox, type, submit. Screenshots the keyboard state and the suggestions.
navigate() {
  local url=$1 name=$2
  tap_pill
  sleep 1.5
  shot "$name-omnibox-open"
  type_text "$url"
  sleep 1.5
  shot "$name-typed"
  key KEYCODE_ENTER
  sleep 1
  shot "$name-loading-1s"
}

# A percent-encoded data: URL for a test page (no whitespace: the omnibox would search it).
data_url() {
  python3 -c 'import sys, urllib.parse; print("data:text/html," + urllib.parse.quote(sys.stdin.read().strip(), safe="/:,=?"))'
}

# Close whatever the last action opened. Panels and the find bar carry a "Close (Esc)" button:
# try system back first (Chrome closes its sheets and pages with it), then the button. A system
# activity (print, a chooser) in front gets a back too. Nothing open: nothing pressed, so back
# cannot silently navigate the tab.
recover() {
  local what=${1:-panel}
  if has_label contains 'Close (Esc)'; then
    key KEYCODE_BACK
    sleep 1.2
    shot "after-back-from-$what"
    if has_label contains 'Close (Esc)'; then
      finding "system back did not close the $what; using its close button"
      tap_label contains 'Close (Esc)' || true
      sleep 1
    fi
  elif ! top_window | grep -q "$app_id"; then
    log "another window is in front after $what: $(top_window)"
    key KEYCODE_BACK
    sleep 1.5
    shot "after-back-from-$what"
    top_window | grep -q "$app_id" || { adb shell am start -n "$activity" > /dev/null 2>&1 || true; sleep 2; }
  else
    log "nothing to close after $what"
  fi
}

# Pick an item in the three-dot menu (scrolling the sheet when the item is below the fold).
menu_pick() {
  local item=$1 name=$2
  tap_menu
  sleep 1.5
  if ! tap_label exact "$item"; then
    swipe $((W / 2)) $((H - 300)) $((W / 2)) $((H - 900)) 400
    sleep 1
    if ! tap_label exact "$item"; then
      finding "menu item '$item' not reachable"
      shot "menu-missing-${name}"
      key KEYCODE_BACK
      sleep 1
      return 1
    fi
  fi
  return 0
}

# --- emulator preparation (as in android-gesture-demo.sh) --------------------------------------

adb wait-for-device
nproc
free -m
df -h / /tmp

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

# The same 411 CSS px wide layout a Pixel 6 gets, at 2.3x fewer pixels: the emulator renders,
# snapshots and records through a software GPU, and every pixel costs.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3
# Three-button navigation: no system gesture zone under the bar, so no accidental home swipes.
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
# Predictive back system animations are a developer option on API 34.
adb shell settings put global enable_back_animation 1 || true

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
free -m

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
echo "app: $apk"
adb uninstall "$app_id" > /dev/null 2>&1 || true
adb install -r -g "$apk"
adb shell dumpsys package "$app_id" | grep -E 'versionName|firstInstallTime' | head -2 > "$out/dumpsys-package.txt" || true

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

# --- recording: back-to-back 170-second segments until the stop file appears --------------------

(
  n=0
  while [ ! -f "$out/stop-recording" ]; do
    n=$((n + 1))
    name=$(printf 'android-bughunt-seg%02d.mp4' "$n")
    echo "$(date +%s) $name" >> "$out/segments.txt"
    adb shell screenrecord --bit-rate 2500000 --time-limit 170 "/sdcard/$name" || true
  done
) &
recorder_pid=$!
sleep 1.5

# ==============================================================================================
# 1. Cold start with an empty profile: onboarding, first tab, bottom bar
# ==============================================================================================
step "1 cold start"
shot "01-before-launch"
adb shell am start -W -n "$activity" > "$out/am-start-cold.txt" 2>&1 || true
cat "$out/am-start-cold.txt"
sleep 1; shot "01-cold-1s"
sleep 1; shot "01-cold-2s"
sleep 2; shot "01-cold-4s"
sleep 4; shot "01-cold-8s"
if wait_label exact 'Continue' 40; then log "onboarding visible"; else finding "no onboarding after 48 s"; fi
xml=$(dump "01-onboarding") || true
log "onboarding tree: $(texts_in "$xml")"

for i in 1 2 3 4 5 6 7 8; do
  xml=$(dump "01-onboarding-$i") || true
  shot "01-onboarding-step$i"
  if [ "$i" = 2 ]; then
    # Second step is the look: try the dark scheme (its button text is the lowercase value).
    tap_label exact 'dark' || true
    sleep 1
    shot "01-onboarding-look-dark"
    tap_label exact 'Follow system' || true
    sleep 0.6
  fi
  if [ "$i" = 4 ]; then
    tap_label exact 'GitHub' || tap_label contains 'Git' || true
    sleep 0.6
  fi
  if find_in "$xml" exact 'Start browsing' > /dev/null; then
    tap_label exact 'Start browsing' || true
    sleep 2
    shot "01-onboarding-finished"
    break
  elif find_in "$xml" exact 'Continue' > /dev/null; then
    tap_label exact 'Continue' || true
    sleep 1.2
  else
    finding "onboarding step $i shows neither Continue nor Start browsing (tree: $(texts_in "$xml"))"
    # Maybe the card is taller than the screen: try scrolling it.
    swipe $((W / 2)) $((H - 400)) $((W / 2)) 400 500
    sleep 1
    shot "01-onboarding-scrolled$i"
    if ! tap_label exact 'Continue' && ! tap_label exact 'Start browsing'; then
      if [ "$i" -ge 3 ]; then
        finding "onboarding cannot be completed by touch; seeding onboardingDone and relaunching"
        adb shell am force-stop "$app_id"
        adb shell run-as "$app_id" sh -c 'mkdir -p files/zen && printf "{\"version\":2,\"settings\":{\"onboardingDone\":true}}" > files/zen/state.json'
        adb shell am start -W -n "$activity" > /dev/null 2>&1 || true
        sleep 6
        break
      fi
    fi
    sleep 1.2
  fi
done
sleep 2
shot "01-first-tab"
xml=$(dump "01-first-tab") || true
log "first tab tree: $(texts_in "$xml")"
log "tabs count after onboarding: $(tabs_count)"
log "top window: $(top_window)"

# ==============================================================================================
# 2. The URL pill: keyboard, typing a query, suggestions, submit, progress, pill label
# ==============================================================================================
step "2 omnibox search"
shot "02-before-pill"
tap_pill
sleep 0.3; shot "02-pill-tapped-300ms"
sleep 1.2; shot "02-omnibox-open"
adb shell dumpsys input_method | grep -E 'mInputShown|mImeWindowVis|isInputViewShown' | head -3 > "$out/dumpsys-ime-after-pill.txt" || true
log "ime after pill tap: $(tr -s ' ' < "$out/dumpsys-ime-after-pill.txt" | tr '\n' ' ')"
type_text "android emulator"
sleep 2
shot "02-typed-query-suggestions"
xml=$(dump "02-suggestions") || true
log "suggestions tree: $(texts_in "$xml")"
key KEYCODE_ENTER
sleep 0.5; shot "02-submitted-500ms"
sleep 1; shot "02-loading-1500ms"
sleep 2; shot "02-loading-3500ms"
sleep 6; shot "02-loaded"
log "pill after search: $(texts_in "$(dump "02-loaded")")"

# ==============================================================================================
# 3. Three real pages, system back after each, predictive back, back at the first entry
# ==============================================================================================
step "3 navigation and back"
navigate "https://en.wikipedia.org/wiki/Android_(operating_system)" "03-wikipedia"
sleep 2; shot "03-wikipedia-loading-3s"
sleep 10; shot "03-wikipedia-loaded"
navigate "https://developer.android.com" "03-devsite"
sleep 2; shot "03-devsite-loading-3s"
sleep 10; shot "03-devsite-loaded"
navigate "https://news.ycombinator.com" "03-hn"
sleep 8; shot "03-hn-loaded"

# System back (three-button) from HN → dev site → Wikipedia → search → whatever the first tab
# was, then once more at the first history entry: does the app background itself?
for i in 1 2 3 4 5; do
  key KEYCODE_BACK
  sleep 0.4; shot "03-back$i-400ms"
  sleep 2.5; shot "03-back$i-settled"
  log "after back $i: tabs=$(tabs_count) top=$(top_window)"
  if ! top_window | grep -q "$app_id"; then
    finding "back number $i left the app (top: $(top_window)); Chrome only leaves at the first history entry of a tab it did not open itself"
    adb shell am start -n "$activity" > /dev/null 2>&1 || true
    sleep 4
    shot "03-relaunched-after-background"
    break
  fi
done

# Predictive back with gesture navigation: hold an edge swipe half-way, then commit.
step "3b predictive back gesture"
adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural || true
adb shell cmd overlay disable com.android.internal.systemui.navbar.threebutton || true
sleep 3
shot "03b-gesture-nav-bar"
navigate "https://developer.android.com" "03b-devsite"
sleep 10; shot "03b-devsite-loaded"
adb shell "input motionevent DOWN 2 900; input motionevent MOVE 30 900; input motionevent MOVE 90 902; input motionevent MOVE 170 905; input motionevent MOVE 240 908" || true
shot "03b-predictive-back-held"
adb shell "input motionevent MOVE 300 910; input motionevent MOVE 360 912; input motionevent UP 360 912" || true
sleep 0.4; shot "03b-predictive-back-released-400ms"
sleep 2.5; shot "03b-predictive-back-settled"
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
adb shell cmd overlay disable com.android.internal.systemui.navbar.gestural || true
sleep 3
shot "03b-three-button-again"

# ==============================================================================================
# 4. Tab overview: button and pill pull, morph, thumbnails, close, undo; pill swipes
# ==============================================================================================
step "4 tab overview"
# Two more tabs so the grid has something to show.
tap_newtab
sleep 1.5
shot "04-newtab-pressed"
type_text "https://developer.android.com/about"
key KEYCODE_ENTER
sleep 8
shot "04-second-tab"
tap_newtab
sleep 1.5
type_text "https://news.ycombinator.com/newest"
key KEYCODE_ENTER
sleep 8
shot "04-third-tab"
log "tabs count: $(tabs_count)"

for i in 1 2 3; do
  tap_tabs
  sleep 0.15; shot "04-overview-open$i-150ms"
  sleep 0.35; shot "04-overview-open$i-500ms"
  sleep 1.5; shot "04-overview-open$i-settled"
  tap_tabs
  sleep 0.15; shot "04-overview-close$i-150ms"
  sleep 1.5; shot "04-overview-close$i-settled"
done

# Pull the pill up towards the middle of the screen.
# shellcheck disable=SC2046
set -- $(pill_pos)
swipe "$1" "$2" "$1" $(( $2 - 700 )) 700
sleep 0.3; shot "04-pill-pull-300ms"
sleep 2; shot "04-pill-pull-settled"
xml=$(dump "04-overview") || true
log "overview tree: $(texts_in "$xml")"
# Close a tab with its X, look for an undo affordance.
if tap_label exact 'Close tab' 1 || tap_label exact 'Close tab' 0; then
  sleep 0.3; shot "04-tab-closed-300ms"
  sleep 1.5; shot "04-tab-closed-settled"
  if has_label contains 'Undo'; then
    tap_label contains 'Undo' || true
    sleep 1.5
    shot "04-undo-tapped"
  else
    finding "no undo after closing a tab in the overview (Chrome shows an undo snackbar)"
  fi
else
  finding "no 'Close tab' control found in the overview"
fi
shot "04-overview-after-close"
# Leave the overview by picking the first card.
tap_label exact 'Hacker News' || tap_label contains 'Hacker' || tap_tabs
sleep 2
shot "04-overview-left"

# Swipe the pill left and right to switch tabs.
# shellcheck disable=SC2046
set -- $(pill_pos)
px_l=$3; px_r=$5; py=$2
swipe $((px_r - 10)) "$py" $((px_r - 10 - W * 45 / 100)) "$py" 250
sleep 0.4; shot "04-pill-swipe-left-400ms"
sleep 2.5; shot "04-pill-swipe-left-settled"
swipe $((px_l + 10)) "$py" $((px_l + 10 + W * 45 / 100)) "$py" 250
sleep 0.4; shot "04-pill-swipe-right-400ms"
sleep 2.5; shot "04-pill-swipe-right-settled"
log "pill after swipes: $(texts_in "$(dump "04-swiped")")"

# ==============================================================================================
# 5. The three-dot menu: every item, every submenu, then pick each one
# ==============================================================================================
step "5 menu"
navigate "https://en.wikipedia.org/wiki/Android_(operating_system)" "05-wikipedia"
sleep 12; shot "05-wikipedia-loaded"
tap_menu
sleep 0.12; shot "05-menu-120ms"
sleep 0.25; shot "05-menu-370ms"
sleep 1.2; shot "05-menu-open"
xml=$(dump "05-menu") || true
menu_texts="$(texts_in "$xml")"
log "menu items visible: $menu_texts"
swipe $((W / 2)) $((H - 250)) $((W / 2)) $((H - 850)) 500
sleep 1
shot "05-menu-scrolled"
xml=$(dump "05-menu-scrolled") || true
menu_texts="$menu_texts | $(texts_in "$xml")"
log "menu items after scroll: $(texts_in "$xml")"
# Chrome and Edge menu items with no counterpart here.
for want in 'Incognito' 'Share' 'Desktop site' 'Home screen' 'Translate' 'Recent tabs' 'Help' 'Refresh' 'Forward'; do
  case ${menu_texts,,} in
    *${want,,}*) ;;
    *) finding "menu has no '$want' item (Chrome and Edge do)" ;;
  esac
done
if tap_label exact 'Zoom'; then
  sleep 1; shot "05-menu-zoom-submenu"
  tap_label exact 'Zoom In' || true
  sleep 1.5; shot "05-zoom-in-applied"
fi
# Does system back close the sheet (Chrome: yes)? Then dismiss by tapping the scrim.
if ! has_label exact 'Zen'; then tap_menu; sleep 1.5; fi
key KEYCODE_BACK
sleep 1.2; shot "05-menu-after-back"
if has_label exact 'Zen'; then
  finding "system back does not close the menu sheet"
else
  tap_menu; sleep 1.5
fi
tap $((W / 2)) 200
sleep 0.12; shot "05-menu-dismiss-120ms"
sleep 1; shot "05-menu-dismissed"

for entry in \
  'New Tab|newtab' 'New Space…|newspace' 'Bookmarks|bookmarks' 'History|history' 'Downloads|downloads' \
  'Add-ons and Themes|addons' 'Compact Mode|compact' 'Change Theme…|theme' 'Fullscreen|fullscreen' \
  'Find in Page…|find' 'Reader View|reader' 'Print…|print' 'Save Page As…|savepage' \
  'Take Screenshot|screenshot' 'Keyboard Shortcuts|shortcuts' 'Settings|settings'; do
  item=${entry%%|*}; name=${entry##*|}
  menu_pick "$item" "$name" || continue
  sleep 0.3; shot "05-$name-300ms"
  sleep 2; shot "05-$name-settled"
  xml=$(dump "05-$name") || true
  log "after '$item': $(texts_in "$xml") | top=$(top_window)"
  case $name in
    find)
      type_text "android"
      sleep 1.5; shot "05-find-typed"
      ;;
    compact)
      menu_pick 'Compact Mode' compact-off || true
      sleep 1.5; shot "05-compact-off"
      continue
      ;;
    fullscreen)
      log "fullscreen window: $(adb shell dumpsys window | grep -E 'isFullscreen|mSystemUiVisibility|InsetsSource.*statusBars' | head -3 | tr -s ' ' | tr '\n' ' ')"
      key KEYCODE_BACK
      sleep 1.5; shot "05-fullscreen-after-back"
      if ! has_label exact Menu; then
        finding "menu bar not visible after Fullscreen + back"
        adb shell am start -n "$activity" > /dev/null 2>&1 || true
        sleep 2
      else
        # Toggle it off again if it is still on.
        menu_pick 'Fullscreen' fullscreen-off || true
        sleep 1.5; shot "05-fullscreen-off"
      fi
      continue
      ;;
    reader)
      key KEYCODE_BACK
      sleep 2; shot "05-reader-after-back"
      continue
      ;;
    newtab)
      key KEYCODE_BACK
      sleep 1.2; shot "05-newtab-after-back"
      continue
      ;;
    print)
      key KEYCODE_BACK
      sleep 2; shot "05-print-after-back"
      if ! top_window | grep -q "$app_id"; then
        adb shell am start -n "$activity" > /dev/null 2>&1 || true
        sleep 2
      fi
      continue
      ;;
    settings)
      # Kept open: step 6 starts inside it.
      continue
      ;;
  esac
  recover "$name"
done

# ==============================================================================================
# 6. Settings: every section, theme toggles, phone layout
# ==============================================================================================
step "6 settings"
if ! has_label exact 'Settings'; then
  menu_pick 'Settings' settings || true
  sleep 2
fi
shot "06-settings-open"
for section in 'Look and Feel' 'Compact Mode' 'Tab Management' 'Search' 'Space Routing' 'Containers' 'Boosts' 'Mods' 'AI Agents' 'Keyboard Shortcuts' 'Updates' 'About'; do
  slug=${section// /-}
  if tap_label exact "$section"; then
    sleep 1.5
    shot "06-settings-${slug}"
    xml=$(dump "06-settings-${slug}") || true
    log "section '$section': $(texts_in "$xml")"
    # Scroll the content column and look again.
    swipe $((W * 3 / 4)) $((H - 400)) $((W * 3 / 4)) 350 500
    sleep 1.2
    shot "06-settings-${slug}-scrolled"
    swipe $((W * 3 / 4)) 350 $((W * 3 / 4)) $((H - 400)) 300
    sleep 0.8
  else
    finding "settings section '$section' not reachable by tap"
  fi
done
# Colour scheme: system → dark → light → system, watching the chrome and the page.
tap_label exact 'Look and Feel' || true
sleep 1.2
if tap_label exact 'Follow system'; then
  sleep 1.2; shot "06-scheme-select-open"
  tap_label exact 'Dark' || true
  sleep 2; shot "06-scheme-dark"
  tap_label exact 'Dark' || true
  sleep 1.2
  tap_label exact 'Light' || true
  sleep 2; shot "06-scheme-light"
  tap_label exact 'Light' || true
  sleep 1.2
  tap_label exact 'Follow system' || true
  sleep 2; shot "06-scheme-system"
else
  finding "colour scheme control not found in Look and Feel (tree: $(texts_in "$(dump "06-look")"))"
fi
recover settings
shot "06-settings-closed"

# ==============================================================================================
# 7. History, bookmarks, downloads: add a bookmark, download a small file
# ==============================================================================================
step "7 history bookmarks downloads"
menu_pick 'History' history && { sleep 2; shot "07-history"; xml=$(dump "07-history") || true; log "history: $(texts_in "$xml")"; recover history; }
menu_pick 'Bookmarks' bookmarks && {
  sleep 2; shot "07-bookmarks-empty"
  if tap_label exact 'Bookmark current'; then
    sleep 1.5; shot "07-bookmark-added"
  else
    finding "no 'Bookmark current' action in the bookmarks panel"
  fi
  recover bookmarks
}
# A tiny release asset: GitHub serves it as application/octet-stream, so the WebView downloads it.
navigate "https://github.com/BenItBuhner/Zenium/releases/download/v0.2.0/SHA256SUMS.txt" "07-download"
sleep 1.5; shot "07-download-2.5s"
sleep 3; shot "07-download-5.5s"
adb shell cmd statusbar expand-notifications || true
sleep 2; shot "07-notification-shade"
adb shell cmd statusbar collapse || true
sleep 1
menu_pick 'Downloads' downloads && {
  sleep 2; shot "07-downloads-panel"
  xml=$(dump "07-downloads") || true
  log "downloads panel: $(texts_in "$xml")"
  tap_label contains 'SHA256SUMS' || true
  sleep 2.5; shot "07-download-open-tapped"
  log "top after opening download: $(top_window)"
  if ! top_window | grep -q "$app_id"; then
    key KEYCODE_BACK; sleep 1.5
  fi
  recover downloads
}
adb shell dumpsys notification --noredact 2> /dev/null | grep -iE 'pkg=|tickerText|android.title' | grep -iA2 "$app_id\|download" | head -20 > "$out/dumpsys-notification.txt" || true

# ==============================================================================================
# 8. Long-press a link, an image and text
# ==============================================================================================
step "8 long press"
page=$(data_url << 'HTML'
<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:sans-serif}a{display:block;height:160px;line-height:160px;text-align:center;font-size:32px;background:#d8f3dc;color:#1b4332}img{display:block;width:100%;height:240px;object-fit:contain;background:#ffe8d6}p{font-size:24px;padding:16px;margin:0;height:220px;background:#edf2fb}</style></head><body><a href="https://example.com/">A link to example.com</a><img src="https://developer.android.com/static/images/brand/Android_Robot.png" alt="Android robot"><p>Some selectable text to long press for the selection handles and the action bar. More words here.</p></body></html>
HTML
)
navigate "$page" "08-testpage"
sleep 5; shot "08-testpage-loaded"
xml=$(dump "08-testpage") || true
# shellcheck disable=SC2046
if wv=$(webview_bounds "$xml"); then
  set -- $wv; wx1=$1; wy1=$2; wx2=$3
else
  wx1=$(px 8); wy1=$(px 32); wx2=$((W - wx1))
fi
log "tab webview at $wx1,$wy1-$wx2"
cx=$(( (wx1 + wx2) / 2 ))
long_press "$cx" $((wy1 + $(px 80)))
sleep 1.5; shot "08-longpress-link"
xml=$(dump "08-link-menu") || true
log "after link long-press: $(texts_in "$xml")"
key KEYCODE_BACK; sleep 1
long_press "$cx" $((wy1 + $(px 280)))
sleep 1.5; shot "08-longpress-image"
xml=$(dump "08-image-menu") || true
log "after image long-press: $(texts_in "$xml")"
if tap_label contains 'Save Image' || tap_label contains 'Download Image' || tap_label contains 'Save image'; then
  sleep 3; shot "08-image-saved"
else
  key KEYCODE_BACK; sleep 1
fi
long_press "$cx" $((wy1 + $(px 440)))
sleep 1.5; shot "08-longpress-text"
xml=$(dump "08-text-selection") || true
log "after text long-press: $(texts_in "$xml")"
key KEYCODE_BACK; sleep 1
shot "08-after-selection-back"

# ==============================================================================================
# 9. Landscape and back; system dark mode
# ==============================================================================================
step "9 rotation and dark mode"
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 3.5; shot "09-landscape"
tap_pill
sleep 2; shot "09-landscape-omnibox"
key KEYCODE_BACK; sleep 1
tap_tabs
sleep 2; shot "09-landscape-overview"
tap_tabs; sleep 1.5
tap_menu
sleep 1.5; shot "09-landscape-menu"
key KEYCODE_BACK; sleep 1
adb shell settings put system user_rotation 0
sleep 3.5; shot "09-portrait-again"
adb shell cmd uimode night yes
sleep 3.5; shot "09-system-dark"
tap_menu
sleep 1.5; shot "09-system-dark-menu"
key KEYCODE_BACK; sleep 1
tap_tabs
sleep 2; shot "09-system-dark-overview"
tap_tabs; sleep 1.5
adb shell cmd uimode night no
sleep 3.5; shot "09-system-light-again"

# ==============================================================================================
# 10. Font scale 1.3
# ==============================================================================================
step "10 font scale"
adb shell settings put system font_scale 1.3
sleep 4; shot "10-font-1.3-chrome"
tap_menu
sleep 1.5; shot "10-font-1.3-menu"
key KEYCODE_BACK; sleep 1
tap_tabs
sleep 2; shot "10-font-1.3-overview"
tap_tabs; sleep 1.5
menu_pick 'Settings' settings-font && { sleep 2; shot "10-font-1.3-settings"; recover settings; }
adb shell settings put system font_scale 1.0
sleep 4; shot "10-font-1.0-again"

# ==============================================================================================
# 11. Intents: VIEW from the background and the foreground, SEND, WEB_SEARCH
# ==============================================================================================
step "11 intents"
log "tabs before intents: $(tabs_count)"
key KEYCODE_HOME
sleep 2.5; shot "11-home"
adb shell am start -a android.intent.action.VIEW -d "https://example.com/" > /dev/null 2>&1 || true
sleep 1; shot "11-view-from-background-1s"
sleep 2.5; shot "11-view-from-background-settled"
log "top after VIEW without component: $(top_window)"
if ! top_window | grep -q "$app_id"; then
  finding "VIEW https from the shell did not land in the app (top: $(top_window)); a chooser or another browser took it"
  shot "11-view-chooser"
  key KEYCODE_BACK; sleep 1
  adb shell am start -a android.intent.action.VIEW -d "https://example.com/" -n "$activity" > /dev/null 2>&1 || true
  sleep 3.5; shot "11-view-explicit"
fi
log "tabs after background VIEW: $(tabs_count)"
adb shell am start -a android.intent.action.VIEW -d "https://www.wikipedia.org/" -n "$activity" > /dev/null 2>&1 || true
sleep 0.5; shot "11-view-foreground-500ms"
sleep 3; shot "11-view-foreground-settled"
log "tabs after foreground VIEW: $(tabs_count)"
# Extras are quoted for the device shell, which splits the joined command line again.
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "'Look at this https://developer.android.com/about/versions'" -n "$activity" > /dev/null 2>&1 || true
sleep 3.5; shot "11-send-url"
log "tabs after SEND url: $(tabs_count) pill: $(texts_in "$(dump "11-send-url")")"
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "'plain text shared from another app'" -n "$activity" > /dev/null 2>&1 || true
sleep 3.5; shot "11-send-text"
log "tabs after SEND text: $(tabs_count)"
adb shell am start -a android.intent.action.WEB_SEARCH --es query "'kotlin coroutines'" > /dev/null 2>&1 || true
sleep 3.5; shot "11-web-search"
log "tabs after WEB_SEARCH: $(tabs_count) top=$(top_window)"
if ! top_window | grep -q "$app_id"; then
  finding "WEB_SEARCH from the shell did not land in the app (top: $(top_window))"
  key KEYCODE_BACK; sleep 1
  adb shell am start -a android.intent.action.WEB_SEARCH --es query "'kotlin coroutines'" -n "$activity" > /dev/null 2>&1 || true
  sleep 3.5; shot "11-web-search-explicit"
fi

# ==============================================================================================
# 12. Fullscreen video
# ==============================================================================================
step "12 fullscreen video"
video=$(data_url << 'HTML'
<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;background:#111;color:#eee;font-family:sans-serif}video{display:block;width:100%;background:#000}button{display:block;width:100%;height:120px;font-size:28px;margin-top:16px}</style></head><body><video id=v controls playsinline src="https://www.w3schools.com/html/mov_bbb.mp4"></video><button onclick="v.play();v.requestFullscreen()">Go fullscreen</button></body></html>
HTML
)
navigate "$video" "12-videopage"
sleep 6; shot "12-videopage-loaded"
xml=$(dump "12-videopage") || true
# shellcheck disable=SC2046
if wv=$(webview_bounds "$xml"); then set -- $wv; wx1=$1; wy1=$2; wx2=$3; fi
# The native controls' fullscreen button sits at the bottom right of the 16:9 video.
vh=$(( (wx2 - wx1) * 9 / 16 ))
tap $(( (wx1 + wx2) / 2 )) $(( wy1 + vh / 2 ))
sleep 1; shot "12-video-controls"
tap $(( wx2 - $(px 22) )) $(( wy1 + vh - $(px 22) ))
sleep 2.5; shot "12-native-fullscreen-button"
log "fullscreen top: $(top_window)"
if ! has_label exact Menu; then
  log "in fullscreen (bar gone); rotating"
  adb shell settings put system user_rotation 1
  sleep 3.5; shot "12-fullscreen-landscape"
  adb shell settings put system user_rotation 0
  sleep 3.5; shot "12-fullscreen-portrait"
  key KEYCODE_BACK
  sleep 0.3; shot "12-fullscreen-back-300ms"
  sleep 2; shot "12-fullscreen-exited"
else
  finding "tapping the video's fullscreen control did not enter fullscreen; trying requestFullscreen from a button"
  tap_label exact 'Go fullscreen' || tap $(( (wx1 + wx2) / 2 )) $(( wy1 + vh + $(px 76) ))
  sleep 2.5; shot "12-js-fullscreen"
  adb shell settings put system user_rotation 1
  sleep 3.5; shot "12-fullscreen-landscape"
  adb shell settings put system user_rotation 0
  sleep 3.5; shot "12-fullscreen-portrait"
  key KEYCODE_BACK
  sleep 0.3; shot "12-fullscreen-back-300ms"
  sleep 2; shot "12-fullscreen-exited"
fi
if ! has_label exact Menu; then
  finding "bar still missing after leaving fullscreen"
  key KEYCODE_BACK; sleep 2; shot "12-second-back"
fi

# ==============================================================================================
# 13. Drawer sidebar (spaces, essentials)
# ==============================================================================================
step "13 drawer"
tap_tabs
sleep 2
if tap_label exact 'Open sidebar'; then
  sleep 0.15; shot "13-drawer-150ms"
  sleep 1.5; shot "13-drawer-open"
  xml=$(dump "13-drawer") || true
  log "drawer: $(texts_in "$xml")"
  tap $((W - 40)) $((H / 2))
  sleep 0.15; shot "13-drawer-closing-150ms"
  sleep 1.5; shot "13-drawer-closed"
else
  finding "no 'Open sidebar' button in the overview"
fi
if has_label exact 'Open sidebar'; then tap_tabs; sleep 1.5; fi
shot "13-after-drawer"

# ==============================================================================================
# 14. Kill and relaunch: session restore and time to interactive
# ==============================================================================================
step "14 restart"
log "tabs before kill: $(tabs_count) pill: $(texts_in "$(dump "14-before")")"
shot "14-before-kill"
adb shell am force-stop "$app_id"
sleep 2
adb shell am start -W -n "$activity" > "$out/am-start-warm.txt" 2>&1 || true
cat "$out/am-start-warm.txt"
sleep 1; shot "14-relaunch-1s"
sleep 1; shot "14-relaunch-2s"
sleep 2; shot "14-relaunch-4s"
sleep 4; shot "14-relaunch-8s"
log "tabs after relaunch: $(tabs_count) pill: $(texts_in "$(dump "14-after")")"
tap_tabs
sleep 2; shot "14-relaunch-overview"
tap_tabs; sleep 1.5

# ==============================================================================================
# 15. Error pages, a very long URL, a data: URL
# ==============================================================================================
step "15 error pages"
navigate "https://nonexistent.invalid/" "15-dns-error"
sleep 6; shot "15-dns-error-page"
log "dns error tree: $(texts_in "$(dump "15-dns")")"
navigate "http://localhost:1/" "15-refused"
sleep 6; shot "15-connection-refused-page"
longurl="https://example.com/?q=$(python3 -c 'print("abcdefghij" * 45)')&end=1"
navigate "$longurl" "15-long-url"
sleep 6; shot "15-long-url-loaded"
tap_pill
sleep 1.5; shot "15-long-url-omnibox"
key KEYCODE_BACK; sleep 1
navigate "data:text/html,%3Ch1%3EHello%20from%20a%20data%20URL%3C/h1%3E" "15-data-url"
sleep 4; shot "15-data-url-loaded"
log "pill for data url: $(texts_in "$(dump "15-data")")"

# ==============================================================================================
# 16. Odds and ends: back closes the omnibox, the + button, the overview's new-tab card
# ==============================================================================================
step "16 odds and ends"
tap_pill
sleep 1.5
key KEYCODE_BACK
sleep 1.2; shot "16-back-closes-omnibox"
tap_newtab
sleep 1.5; shot "16-plus-button"
key KEYCODE_BACK
sleep 1.2; shot "16-plus-then-back"
tap_tabs
sleep 2
tap_label exact 'New Tab' || tap_label contains 'New tab' || true
sleep 1.5; shot "16-overview-newtab-card"
key KEYCODE_BACK; sleep 1.2
shot "16-final"
log "final tabs: $(tabs_count) top=$(top_window)"
# Last: what does the menu's Quit do on a phone (Chrome has no such item)?
if menu_pick 'Quit' quit; then
  sleep 2.5; shot "16-after-quit"
  log "top after Quit: $(top_window); process: $(adb shell pidof "$app_id" || echo none)"
fi

# --- wrap up ----------------------------------------------------------------------------------
adb shell dumpsys meminfo "$app_id" 2> /dev/null | head -40 > "$out/dumpsys-meminfo.txt" || true
adb shell dumpsys gfxinfo "$app_id" 2> /dev/null | head -60 > "$out/dumpsys-gfxinfo.txt" || true
adb shell dumpsys window 2> /dev/null | grep -E 'mCurrentFocus|mFocusedApp|DisplayFrames|cutout' | head -10 > "$out/dumpsys-window.txt" || true

touch "$out/stop-recording"
adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
wait "$recorder_pid" 2> /dev/null || true
sleep 2
kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true

for name in $(adb shell ls /sdcard/android-bughunt-seg*.mp4 2> /dev/null | tr -d '\r'); do
  adb pull "$name" "$out/video/" || true
done
ls -la "$out" "$out/video" "$out/shots" | head -400
du -sh "$out"
