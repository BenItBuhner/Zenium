#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs the debug APK with an empty
# profile and walks every surface of the phone chrome the way a user would, through adb (taps,
# swipes, typed text, system intents, rotation, dark mode, font scale, force-stop), screenshotting
# before and after every step while `screenrecord` rolls in 170-second segments and logcat is
# captured. Everything lands under artifacts/android-bug-hunt/:
#   shots/NNN-<step>-<what>.png   screenshots, numbered in the order they were taken
#   ui/NNN-<what>.xml             uiautomator dumps (accessibility tree) used to find controls
#   video/android-bughunt-segNN.mp4, segments.txt (epoch start of each segment)
#   timeline.txt                  every step, tap and screenshot with its elapsed time
#   logcat.txt, dumpsys-*.txt, host-monitor.txt
# Controls are found by their accessible name (aria-label or text) in the uiautomator dump, with
# the computed Pixel-6-at-280-dpi layout as the fallback. Test pages (long-press targets, a video,
# a download) are served from the runner over `adb reverse`, so they need no network. Nothing here
# asserts: a missing control is logged as a finding and the walk carries on.
set -uo pipefail

app_id=app.zen.chromium.debug
activity=app.zen.chromium.debug/app.zen.chromium.MainActivity
out=artifacts/android-bug-hunt
shots=$out/shots
dumps=$out/ui
www=$out/www
port=8765
mkdir -p "$shots" "$dumps" "$out/video" "$www/download"

t0=$(date +%s)
shot_n=0

# --- logging, screenshots, tree dumps ---------------------------------------------------------

log() {
  printf '%s [%5ds] %s\n' "$(date +%T)" "$(( $(date +%s) - t0 ))" "$*" | tee -a "$out/timeline.txt"
}
step() {
  log "=== STEP $*"
  check_emu "step $*" || true
}
# A finding recorded while the emulator is offline says nothing about the app.
finding() {
  if emu_alive; then log "FINDING: $*"; else log "UNVERIFIED (emulator offline): $*"; fi
}

# --- emulator watchdog --------------------------------------------------------------------------
# The software-rendered emulator process itself has died mid-run on this runner (twice, both
# times while a Google results page was rendering), taking every later step with it. When adb
# loses the device, the emulator is started again from the same AVD (userdata persists without
# -wipe-data, so the app and its state survive), prepared again, and the app relaunched.

emu_alive() { [ "$(adb get-state 2> /dev/null | tr -d '\r')" = "device" ]; }
emu_restarts=0
restart_emulator() {
  emu_restarts=$((emu_restarts + 1))
  log "EMULATOR: the emulator process died during '$1' (qemu gone, host memory fine); restart #$emu_restarts"
  pkill -f qemu-system-x86_64 || true
  sleep 3
  rm -rf "$HOME/.android/avd/${AVD_NAME:-test}.avd/"*.lock
  local emu="${ANDROID_HOME:-/usr/local/lib/android/sdk}/emulator/emulator"
  # The same command line the emulator runner action used, taken from its job log.
  nohup "$emu" -port 5554 -avd "${AVD_NAME:-test}" -no-window -gpu swiftshader_indirect -no-snapshot \
    -noaudio -no-boot-anim -camera-back none -camera-front none \
    > "$out/emulator-restart-$emu_restarts.log" 2>&1 &
  local waited=0
  until [ "$(adb shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = "1" ]; do
    sleep 5
    waited=$((waited + 5))
    if [ $waited -ge 300 ]; then
      log "EMULATOR: did not boot again within 300 s"
      return 1
    fi
  done
  log "EMULATOR: booted again after ${waited}s"
  sleep 5
  adb shell input keyevent 82 || true
  prepare_device
  adb shell am force-stop com.google.android.apps.nexuslauncher || true
  sleep 2
  adb shell am start -n "$activity" > /dev/null 2>&1 || true
  sleep 6
  shot "after-emulator-restart-$emu_restarts"
}
# Called wherever a dead emulator would otherwise turn the rest of the run into noise.
check_emu() { emu_alive || restart_emulator "$1"; }

shot() {
  shot_n=$((shot_n + 1))
  local f
  f=$(printf '%03d-%s.png' "$shot_n" "$1")
  if ! timeout 25 adb exec-out screencap -p > "$shots/$f" 2> /dev/null || [ ! -s "$shots/$f" ]; then
    log "screencap failed for $f"
    rm -f "$shots/$f"
    if ! emu_alive; then
      restart_emulator "shot $1" || true
      return 0
    fi
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
    if timeout 25 adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 &&
      timeout 25 adb exec-out cat /sdcard/ui.xml > "$f" 2> /dev/null && [ -s "$f" ]; then
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

# texts_in <xml> → every distinct text / content-desc in the tree, joined (for the log).
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

# webview_bounds <xml> [largest] → "x1 y1 x2 y2" of the smallest WebView (the tab's), or of the
# largest (the chrome's, which fills the window).
webview_bounds() {
  python3 - "$1" "${2:-smallest}" << 'PY'
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
    better = best is None or (area > best[0] if sys.argv[2] == 'largest' else area < best[0])
    if better:
        best = (area, x1, y1, x2, y2)
if best is None:
    sys.exit(1)
print(*best[1:])
PY
}

# The text inside the first focused text field (the omnibox input while it is open).
edit_text() {
  python3 - "$1" << 'PY'
import sys
import xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    print('<no tree>'); sys.exit(0)
fields = [n for n in root.iter('node') if n.get('class') == 'android.widget.EditText']
focused = [n for n in fields if n.get('focused') == 'true']
pick = (focused or fields or [None])[0]
print('<no field>' if pick is None else repr(pick.get('text')))
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
  # A control the tree places under the portrait navigation bar cannot be tapped: the system
  # bar takes the touch (a menu item there sent the app home in run 3). The caller may scroll.
  if [ "${guard_navbar:-0}" = 1 ] && [ "$2" -ge $((H - NAV)) ] && [ "$6" -le $((H + 1)) ]; then
    log "'$needle' sits under the system navigation bar (y=$2, bar from $((H - NAV))); not tapping"
    return 1
  fi
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
    for key in ('content-desc', 'text'):
        m = re.match(r'Tabs \((\d+|∞)\)', node.get(key) or '')
        if m:
            print(m.group(1)); sys.exit(0)
print('?')
PY
}

# The resumed activity ("pkg/cls"), from the activity manager: the window manager's focused app
# is not reliable on this emulator (it kept naming the launcher while the app was in front).
top_activity() {
  local a
  a=$(adb shell dumpsys activity activities 2> /dev/null | grep -m1 -E 'ResumedActivity' |
    grep -oE '[A-Za-z0-9_.]+/[A-Za-z0-9_.]+' | head -1)
  [ -n "$a" ] || a=$(adb shell dumpsys activity top 2> /dev/null | grep -oE 'ACTIVITY [^ ]+' | tail -1 | cut -d' ' -f2)
  echo "$a"
}
app_in_front() { top_activity | grep -q "^$app_id/"; }
ensure_app() {
  check_emu "$1" || true
  if ! app_in_front; then
    log "app not in front before $1 (top: $(top_activity)); relaunching"
    adb shell am start -n "$activity" > /dev/null 2>&1 || true
    sleep 3
  fi
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

# The menu sheet is open when its items are in the tree (the chrome's document is always called
# "Zen", so the sheet's header cannot tell).
menu_open() { has_label exact 'Add-ons and Themes' || has_label exact 'Take Screenshot'; }
close_menu() {
  if menu_open; then
    key KEYCODE_BACK
    sleep 1
    if menu_open; then
      finding "system back does not close the menu sheet (Chrome closes it)"
      tap $((W / 2)) 200
      sleep 1
    fi
  fi
}

# Fullscreen means the top window hides the system bars; the display policy says so. (The chrome
# draws edge to edge behind the bars at all times, so window bounds cannot tell.) The raw dump is
# kept once per call site for anyone who needs to check the reading.
in_fullscreen() {
  local w
  w=$(adb shell dumpsys window 2> /dev/null)
  echo "$w" | grep -E 'TopIsFullscreen|mForceStatusBar|InsetsSource.*(statusBars|navigationBars)' | head -6 > "$out/dumpsys-window-fullscreen-$shot_n.txt"
  if echo "$w" | grep -q 'mTopIsFullscreen=true'; then return 0; fi
  if echo "$w" | grep -q 'mTopIsFullscreen=false'; then return 1; fi
  # No such field: fall back to the system's own "Viewing full screen" bubble.
  has_label exact 'Got it'
}

# Whether an accessibility tree holds Zen's page context menu (link or image items).
ctx_menu_in() {
  local label
  for label in 'Open Link' 'Copy Link' 'Copy Image' 'Save Image' 'Open in new tab' 'Download image'; do
    find_in "$1" contains "$label" > /dev/null && return 0
  done
  return 1
}

# Open the omnibox, type, submit. Screenshots the keyboard state and the suggestions.
navigate() {
  local url=$1 name=$2
  ensure_app "navigate $name"
  # An omnibox left open (its engine chip is in the tree) would be closed by a tap on the pill's
  # spot, which is scrim by then; its text is selected, so typing replaces it.
  if has_label prefix 'Search engine:'; then
    log "omnibox already open; typing into it"
    adb shell input keycombination 113 29 > /dev/null 2>&1 || true
  else
    tap_pill
    sleep 1.5
  fi
  shot "$name-omnibox-open"
  if ! has_label exact 'Address' && [ -z "$(adb shell dumpsys input_method | grep -o 'mInputShown=true')" ]; then
    log "omnibox did not open on the first tap; tapping the pill again"
    tap_pill
    sleep 1.5
  fi
  type_text "$url"
  sleep 1.5
  shot "$name-typed"
  key KEYCODE_ENTER
  sleep 1
  shot "$name-loading-1s"
}

# Close whatever the last action opened. Panels and the find bar carry a "Close (Esc)" button:
# system back should close them (Chrome closes its sheets and pages with it); the first back only
# closes the keyboard when a field is focused, so allow two. Nothing open: nothing pressed, so back
# cannot silently navigate the tab.
recover() {
  local what=${1:-panel} n=0
  while [ $n -lt 2 ] && has_label contains 'Close (Esc)'; do
    n=$((n + 1))
    key KEYCODE_BACK
    sleep 1.2
    shot "after-back$n-from-$what"
  done
  if has_label contains 'Close (Esc)'; then
    finding "two system backs did not close the $what; using its close button"
    tap_label contains 'Close (Esc)' || true
    sleep 1
  elif [ $n -eq 2 ]; then
    log "the $what took two backs to close (the first one dismissed the keyboard)"
  elif [ $n -eq 0 ] && has_label exact 'Cancel'; then
    # A dialog without the panels' close button: try back once, then its Cancel.
    key KEYCODE_BACK
    sleep 1.2
    shot "after-back-from-$what"
    if has_label exact 'Cancel'; then
      finding "system back does not close the $what dialog; using Cancel"
      tap_label exact 'Cancel' || true
      sleep 1
    fi
  fi
  ensure_app "$what"
}

# Pick an item in the three-dot menu (scrolling the sheet when the item is below the fold).
menu_pick() {
  local item=$1 name=$2 mode=${menu_pick_mode:-exact}
  ensure_app "menu $name"
  if ! menu_open; then
    tap_menu
    sleep 1.5
  fi
  if ! guard_navbar=1 tap_label "$mode" "$item"; then
    swipe $((W / 2)) $((H - 300)) $((W / 2)) $((H - 900)) 400
    sleep 1
    if ! guard_navbar=1 tap_label "$mode" "$item"; then
      if find_in "$(dump "menu-$name")" "$mode" "$item" > /dev/null 2>&1; then
        finding "menu item '$item' stays under the system navigation bar even with the sheet scrolled to its end (unreachable by touch)"
      else
        finding "menu item '$item' not reachable"
      fi
      shot "menu-missing-${name}"
      close_menu
      return 1
    fi
  fi
  return 0
}

# Leave the tab overview if it is open (its header names the space and counts the tabs).
leave_overview() {
  if has_label exact 'Open sidebar'; then
    tap_tabs
    sleep 1.5
  fi
}

# --- test pages served from the runner ---------------------------------------------------------

cat > "$www/longpress.html" << 'HTML'
<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Long-press targets</title>
<style>body{margin:0;font-family:sans-serif}section{height:150px;display:flex;align-items:center;justify-content:center;font-size:26px}
a{color:#1b4332}#link{background:#d8f3dc}#blank{background:#fff3b0}#img{background:#ffe8d6;height:180px}img{height:150px}
#text{background:#edf2fb;font-size:22px;padding:0 16px;text-align:center}#field{background:#e2e2e2}input,select{font-size:22px;height:56px;width:80%}</style></head>
<body><section id=link><a href="/second.html">A link to a second page</a></section>
<section id=blank><a href="/second.html" target=_blank rel=opener>Opens in a new tab</a></section>
<section id=img><img src="/zen-sample.png" alt="A robot picture"></section>
<section id=text>Some selectable text to long press for the selection handles and the action bar.</section>
<section id=field><input placeholder="A text field in the page"></section>
<section id=select><select><option>Option one<option>Option two<option>Option three</select></section>
</body></html>
HTML
cat > "$www/second.html" << 'HTML'
<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Second page</title>
<style>body{margin:0;background:#cfe1b9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;font-size:34px}</style></head>
<body>Second page</body></html>
HTML
# A colour-bar clip with a tone, so the video has frames to judge fullscreen by.
video_src=/clip.mp4
if ! ffmpeg -loglevel error -y -f lavfi -i testsrc2=duration=15:size=640x360:rate=24 \
  -f lavfi -i sine=frequency=440:sample_rate=44100:duration=15 \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -shortest "$www/clip.mp4" 2> /dev/null; then
  video_src=https://www.w3schools.com/html/mov_bbb.mp4
fi
cat > "$www/video.html" << HTML
<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Video page</title>
<style>body{margin:0;background:#111;color:#eee;font-family:sans-serif}video{display:block;width:100%;background:#000}
button{display:block;width:100%;height:110px;font-size:28px;margin-top:14px}</style></head>
<body><video id=v controls playsinline src="$video_src"></video>
<button id=play onclick="v.play()">Play</button>
<button id=fs onclick="v.play();(v.requestFullscreen||v.webkitEnterFullscreen).call(v)">Go fullscreen</button>
</body></html>
HTML
if ! curl -fsSL -o "$www/zen-sample.png" https://developer.android.com/static/images/brand/Android_Robot.png; then
  ffmpeg -loglevel error -y -f lavfi -i testsrc=size=320x240:rate=1 -frames:v 1 "$www/zen-sample.png" 2> /dev/null || true
fi
cp "$www/zen-sample.png" "$www/download/zen-sample.png" 2> /dev/null || head -c 120000 /dev/urandom > "$www/download/zen-sample.png"
ls -la "$www" "$www/download"

# /download/* is served with Content-Disposition: attachment so the WebView hands it to the
# download listener instead of rendering it.
python3 - "$port" "$www" << 'PY' &
import functools, http.server, os, sys
port, root = int(sys.argv[1]), sys.argv[2]
class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.startswith('/download/'):
            self.send_header('Content-Disposition', 'attachment; filename="%s"' % os.path.basename(self.path))
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *args):
        pass
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=root)).serve_forever()
PY
www_pid=$!

# --- emulator preparation (as in android-gesture-demo.sh) --------------------------------------

adb wait-for-device
nproc
free -m
df -h / /tmp

(
  gone=0
  while [ ! -f "$out/stop-recording" ]; do
    {
      date +%T
      free -m | sed -n '2p'
      ps -o pid=,rss=,pcpu=,comm= -C qemu-system-x86_64 || true
    } >> "$out/host-monitor.txt"
    if pgrep -f qemu-system-x86_64 > /dev/null; then
      gone=0
    elif [ $gone -eq 0 ]; then
      gone=1
      {
        echo "EMULATOR PROCESS GONE"
        sudo dmesg 2> /dev/null | tail -n 40 || true
      } >> "$out/host-monitor.txt"
    fi
    sleep 5
  done
) &
monitor_pid=$!

# Everything the device needs before the app runs; also run after an emulator restart. The same
# 411 CSS px wide layout a Pixel 6 gets, at 2.3x fewer pixels: the emulator renders, snapshots
# and records through a software GPU, and every pixel costs.
prepare_device() {
  adb reverse "tcp:$port" "tcp:$port" || true
  adb shell wm size 720x1600
  adb shell wm density 280
  adb shell settings put global hide_error_dialogs 1 || true
  sleep 2
  # Three-button navigation: no system gesture zone under the bar, so no accidental home swipes.
  adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
  adb shell settings put system screen_off_timeout 2147483647 || true
  adb shell svc power stayon true || true
  adb shell input keyevent KEYCODE_WAKEUP || true
  adb shell wm dismiss-keyguard || true
  # Predictive back system animations are a developer option on API 34.
  adb shell settings put global enable_back_animation 1 || true
}
prepare_device
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3

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
# logcat exits with the device; the loop picks it up again once the emulator is back.
(
  while [ ! -f "$out/stop-recording" ]; do
    adb logcat -v time >> "$out/logcat.txt" 2> /dev/null || true
    sleep 5
  done
) &
logcat_pid=$!

# --- recording: back-to-back 170-second segments until the stop file appears --------------------
# Each finished segment is pulled straight away, so a dying emulator loses at most one segment,
# and the loop waits out an emulator restart instead of giving up. Recorded at 3/4 of the
# display's size: the encoder's frames go through the same software GPU as everything else.

(
  n=0
  quick=0
  while [ ! -f "$out/stop-recording" ] && [ $n -lt 40 ]; do
    if ! emu_alive; then
      sleep 10
      continue
    fi
    n=$((n + 1))
    name=$(printf 'android-bughunt-seg%02d.mp4' "$n")
    started=$(date +%s)
    echo "$started $name" >> "$out/segments.txt"
    adb shell screenrecord --size 540x1200 --bit-rate 2000000 --time-limit 170 "/sdcard/$name" || true
    if [ $(( $(date +%s) - started )) -lt 5 ]; then
      quick=$((quick + 1))
      if [ $quick -ge 5 ]; then
        echo "screenrecord failing on a live device; pausing 60 s" >> "$out/segments.txt"
        sleep 60
        quick=0
      else
        sleep 5
      fi
    else
      quick=0
    fi
    adb pull "/sdcard/$name" "$out/video/" > /dev/null 2>&1 && adb shell rm -f "/sdcard/$name" || true
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
    # Second step is the look: try the dark scheme, then back to the system one.
    tap_label exact 'Dark' || tap_label exact 'dark' || true
    sleep 1.2
    shot "01-onboarding-look-dark"
    tap_label exact 'Follow System' || tap_label exact 'Follow system' || true
    sleep 0.8
    # Scroll the card in case it is taller than the screen (the gradient swatches).
    swipe $((W / 2)) $((H - 500)) $((W / 2)) $((H - 900)) 400
    sleep 0.8
    shot "01-onboarding-look-scrolled"
  fi
  if [ "$i" = 4 ]; then
    tap_label exact 'GitHub' || tap_label contains 'Git' || true
    sleep 0.6
  fi
  if find_in "$xml" exact 'Start browsing' > /dev/null; then
    tap_label exact 'Start browsing' || true
    sleep 0.4; shot "01-onboarding-finishing-400ms"
    sleep 2; shot "01-onboarding-finished"
    break
  elif find_in "$xml" exact 'Continue' > /dev/null; then
    tap_label exact 'Continue' || true
    sleep 1.2
  else
    finding "onboarding step $i shows neither Continue nor Start browsing (tree: $(texts_in "$xml"))"
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
log "top activity: $(top_activity)"

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
log "omnibox open tree: $(texts_in "$(dump "02-omnibox-open")")"
# Type in two halves and read the field back, so dropped characters show up here and not only as
# a wrong search.
type_text "android emu"
sleep 1
log "field after first half: $(edit_text "$(dump "02-typed-half")")"
type_text "lator"
sleep 2
shot "02-typed-query-suggestions"
xml=$(dump "02-suggestions") || true
log "field after typing: $(edit_text "$xml"); suggestions tree: $(texts_in "$xml")"
key KEYCODE_ENTER
sleep 0.3; shot "02-submitted-300ms"
sleep 0.5; shot "02-submitted-800ms"
sleep 0.7; shot "02-loading-1500ms"
sleep 1; shot "02-loading-2500ms"
sleep 1; shot "02-loading-3500ms"
sleep 6; shot "02-loaded"
log "pill after search: $(texts_in "$(dump "02-loaded")" | cut -c1-300)"
log "tabs after search: $(tabs_count)"

# ==============================================================================================
# 3. Three real pages, system back after each, predictive back, back at the first entry
# ==============================================================================================
step "3 navigation and back"
navigate "https://en.wikipedia.org/wiki/Android_(operating_system)" "03-wikipedia"
sleep 1; shot "03-wikipedia-loading-2s"
sleep 1; shot "03-wikipedia-loading-3s"
sleep 10; shot "03-wikipedia-loaded"
log "pill: $(texts_in "$(dump "03-wikipedia")" | cut -c1-200)"
navigate "https://developer.android.com" "03-devsite"
sleep 2; shot "03-devsite-loading-3s"
sleep 10; shot "03-devsite-loaded"
navigate "https://news.ycombinator.com" "03-hn"
sleep 8; shot "03-hn-loaded"
log "tabs before backs: $(tabs_count)"

# System back (three-button) from HN → dev site → Wikipedia → search → whatever came before it.
# Chrome leaves the app at the first history entry; count how many presses that takes here.
left_at=""
for i in 1 2 3 4 5 6; do
  key KEYCODE_BACK
  sleep 0.3; shot "03-back$i-300ms"
  sleep 0.5; shot "03-back$i-800ms"
  sleep 2; shot "03-back$i-settled"
  log "after back $i: tabs=$(tabs_count) top=$(top_activity)"
  if ! app_in_front; then
    left_at=$i
    log "back number $i left the app (top: $(top_activity))"
    break
  fi
done
if [ -z "$left_at" ]; then
  finding "six system backs never left the app (Chrome moves the task to the back at the first history entry)"
else
  # Return: does the task come back where it was?
  adb shell am start -n "$activity" > /dev/null 2>&1 || true
  sleep 4
  shot "03-relaunched-after-background"
  log "after relaunch: tabs=$(tabs_count) pill: $(texts_in "$(dump "03-relaunched")" | cut -c1-200)"
fi

# Predictive back with gesture navigation: hold an edge swipe half-way, then commit.
step "3b predictive back gesture"
adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural || true
adb shell cmd overlay disable com.android.internal.systemui.navbar.threebutton || true
sleep 1; shot "03b-gesture-nav-1s"
sleep 2.5; shot "03b-gesture-nav-bar"
log "after nav-mode change: tabs=$(tabs_count) tree: $(texts_in "$(dump "03b-navmode")" | cut -c1-300)"
# The omnibox under gesture navigation: open, type in pieces, read the field back.
tap_pill
sleep 1.5; shot "03b-omnibox-gesture-nav"
type_text "abc"
sleep 1
log "gesture-nav field after 'abc': $(edit_text "$(dump "03b-typed-abc")")"
type_text "def"
sleep 1
xml=$(dump "03b-typed-abcdef") || true
log "gesture-nav field after 'def': $(edit_text "$xml") tree: $(texts_in "$xml" | cut -c1-300)"
shot "03b-omnibox-typed"
key KEYCODE_BACK; sleep 1
key KEYCODE_BACK; sleep 1
shot "03b-omnibox-closed"
navigate "https://developer.android.com" "03b-devsite"
sleep 10; shot "03b-devsite-loaded"
adb shell "input motionevent DOWN 2 900; input motionevent MOVE 30 900; input motionevent MOVE 90 902; input motionevent MOVE 170 905; input motionevent MOVE 240 908" || true
shot "03b-predictive-back-held"
adb shell "input motionevent MOVE 300 910; input motionevent MOVE 360 912; input motionevent UP 360 912" || true
sleep 0.4; shot "03b-predictive-back-released-400ms"
sleep 2.5; shot "03b-predictive-back-settled"
log "after gesture back: pill: $(texts_in "$(dump "03b-after-gesture")" | cut -c1-200)"
# At the root of the tab's history, a held edge swipe should preview the return to the launcher
# (the whole window shrinks); Chrome shows that once it has nothing left to go back to.
for i in 1 2 3 4; do
  key KEYCODE_BACK
  sleep 1.5
  app_in_front || break
done
if app_in_front; then
  shot "03b-at-root"
  adb shell "input motionevent DOWN 2 900; input motionevent MOVE 40 900; input motionevent MOVE 120 902; input motionevent MOVE 220 905; input motionevent MOVE 300 908" || true
  shot "03b-root-predictive-held"
  sleep 0.5; shot "03b-root-predictive-held-500ms"
  adb shell "input motionevent MOVE 200 906; input motionevent MOVE 60 902; input motionevent MOVE 5 900; input motionevent UP 5 900" || true
  sleep 1.5; shot "03b-root-predictive-cancelled"
else
  log "backs at the root left the app before the held-swipe test"
fi
ensure_app "3b end"
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
adb shell cmd overlay disable com.android.internal.systemui.navbar.gestural || true
sleep 3
shot "03b-three-button-again"
ensure_app "step 4"

# ==============================================================================================
# 4. Tab overview: button and pill pull, morph, thumbnails, close, undo; pill swipes
# ==============================================================================================
step "4 tab overview"
# Two more tabs so the grid has something to show; watch what "+" does first.
tap_newtab
sleep 0.3; shot "04-newtab-300ms"
sleep 0.7; shot "04-newtab-1s"
sleep 1.5; shot "04-newtab-2500ms"
xml=$(dump "04-newtab") || true
log "after +: tabs=$(tabs_count) field=$(edit_text "$xml") tree: $(texts_in "$xml" | cut -c1-300)"
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
  sleep 0.1; shot "04-overview-open$i-100ms"
  sleep 0.2; shot "04-overview-open$i-300ms"
  sleep 0.3; shot "04-overview-open$i-600ms"
  sleep 1.5; shot "04-overview-open$i-settled"
  tap_tabs
  sleep 0.1; shot "04-overview-close$i-100ms"
  sleep 0.2; shot "04-overview-close$i-300ms"
  sleep 1.5; shot "04-overview-close$i-settled"
done

# Pull the pill up towards the middle of the screen, slowly, so the drag itself is recorded.
# shellcheck disable=SC2046
set -- $(pill_pos)
swipe "$1" "$2" "$1" $(( $2 - 700 )) 900
sleep 0.3; shot "04-pill-pull-300ms"
sleep 2; shot "04-pill-pull-settled"
xml=$(dump "04-overview") || true
log "overview tree: $(texts_in "$xml")"
# The card's X sits in its 40 dp title row; the card is exposed under its title, the X is not
# (it is a button inside a role=button), so aim at the row's right end.
close_card() {
  local xml pos
  xml=$(dump "04-card") || true
  pos=$(find_in "$xml" contains "$1") || return 1
  # shellcheck disable=SC2086
  set -- $pos
  log "close card '$1' via X at $(( $5 - $(px 20) )),$(( $4 + $(px 20) ))"
  tap $(( $5 - $(px 20) )) $(( $4 + $(px 20) ))
}
if close_card 'Hacker News' || close_card 'newest' || close_card 'Android'; then
  sleep 0.3; shot "04-tab-closed-300ms"
  sleep 1.5; shot "04-tab-closed-settled"
  xml=$(dump "04-after-close") || true
  log "after closing a card: $(texts_in "$xml")"
  if find_in "$xml" contains 'Undo' > /dev/null; then
    tap_label contains 'Undo' || true
    sleep 1.5
    shot "04-undo-tapped"
  else
    finding "no undo after closing a tab in the overview (Chrome shows an undo snackbar)"
  fi
else
  finding "no tab card found to close in the overview"
fi
shot "04-overview-after-close"
# Scroll the grid, then leave the overview by picking a card.
swipe $((W / 2)) $((H - 500)) $((W / 2)) 500 500
sleep 1; shot "04-overview-scrolled"
swipe $((W / 2)) 500 $((W / 2)) $((H - 500)) 500
sleep 1
tap_label contains 'Android' || tap_label contains 'Hacker' || tap_tabs
sleep 0.3; shot "04-overview-pick-300ms"
sleep 2; shot "04-overview-left"
log "tabs after overview: $(tabs_count)"

# Swipe the pill left and right to switch tabs.
# shellcheck disable=SC2046
set -- $(pill_pos)
px_l=$3; px_r=$5; py=$2
swipe $((px_r - 10)) "$py" $((px_r - 10 - W * 45 / 100)) "$py" 250
sleep 0.2; shot "04-pill-swipe-left-200ms"
sleep 0.3; shot "04-pill-swipe-left-500ms"
sleep 2; shot "04-pill-swipe-left-settled"
swipe $((px_l + 10)) "$py" $((px_l + 10 + W * 45 / 100)) "$py" 250
sleep 0.2; shot "04-pill-swipe-right-200ms"
sleep 0.3; shot "04-pill-swipe-right-500ms"
sleep 2; shot "04-pill-swipe-right-settled"
log "pill after swipes: $(texts_in "$(dump "04-swiped")" | cut -c1-200)"

# ==============================================================================================
# 5. The three-dot menu: every item, every submenu, then pick each one
# ==============================================================================================
step "5 menu"
navigate "https://en.wikipedia.org/wiki/Android_(operating_system)" "05-wikipedia"
sleep 12; shot "05-wikipedia-loaded"
# Is the overview thumbnail of this tab fresh after the navigation?
tap_tabs
sleep 2; shot "05-overview-thumbnail-after-nav"
leave_overview
tap_menu
sleep 0.08; shot "05-menu-80ms"
sleep 0.15; shot "05-menu-230ms"
sleep 0.2; shot "05-menu-430ms"
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
# Chrome and Edge menu items with no counterpart here (only judged from a menu that did open).
if menu_open || [[ "$menu_texts" == *Settings* ]]; then
  for want in 'Incognito' 'Share' 'Desktop site' 'Home screen' 'Translate' 'Recent tabs' 'Help' 'Refresh' 'Forward'; do
    case ${menu_texts,,} in
      *${want,,}*) ;;
      *) finding "menu has no '$want' item (Chrome and Edge do)" ;;
    esac
  done
else
  log "menu did not open; skipping the missing-item comparison"
fi
# Submenu: Zoom.
if tap_label exact 'Zoom'; then
  sleep 0.15; shot "05-menu-zoom-150ms"
  sleep 1; shot "05-menu-zoom-submenu"
  log "zoom submenu: $(texts_in "$(dump "05-zoom")")"
  tap_label exact 'Zoom In' || true
  sleep 1.5; shot "05-zoom-in-applied"
  log "after zoom in: menu open=$(menu_open && echo yes || echo no)"
  menu_pick 'Zoom' zoom2 && { sleep 1; tap_label exact 'Reset Zoom' || true; sleep 1.5; shot "05-zoom-reset"; }
fi
# Does system back close the sheet (Chrome: yes)? Then dismiss by tapping the scrim.
if ! menu_open; then tap_menu; sleep 1.5; fi
key KEYCODE_BACK
sleep 0.15; shot "05-menu-back-150ms"
sleep 1; shot "05-menu-after-back"
if menu_open; then
  finding "system back does not close the menu sheet (Chrome closes it)"
  tap $((W / 2)) 200
  sleep 1
fi
tap_menu; sleep 1.5
tap $((W / 2)) 200
sleep 0.1; shot "05-menu-scrim-dismiss-100ms"
sleep 0.25; shot "05-menu-scrim-dismiss-350ms"
sleep 1; shot "05-menu-dismissed"
log "after scrim tap: menu open=$(menu_open && echo yes || echo no)"

# Opens each 'Label|name' menu item in turn, records what it did and returns to the page. The
# items that leave the app's own windows (Reader View, Print, Fullscreen) run last in the walk:
# in run 3 the print dialog left the chrome deaf to touch for the rest of the run.
walk_menu_items() {
local entry item name xml
for entry in "$@"; do
  item=${entry%%|*}; name=${entry##*|}
  if [ "$name" = about ]; then
    menu_pick_mode=prefix
  else
    menu_pick_mode=exact
  fi
  menu_pick "$item" "$name" || continue
  menu_pick_mode=exact
  sleep 0.3; shot "05-$name-300ms"
  sleep 2; shot "05-$name-settled"
  xml=$(dump "05-$name") || true
  log "after '$item': $(texts_in "$xml" | cut -c1-600) | top=$(top_activity) tabs=$(tabs_count)"
  case $name in
    newtab)
      log "field after menu New Tab: $(edit_text "$xml")"
      key KEYCODE_BACK
      sleep 1.2; shot "05-newtab-after-back1"
      key KEYCODE_BACK
      sleep 1.2; shot "05-newtab-after-back2"
      log "after two backs: tabs=$(tabs_count) tree: $(texts_in "$(dump "05-newtab-closed")" | cut -c1-200)"
      ensure_app newtab
      continue
      ;;
    find)
      type_text "android"
      sleep 1.5; shot "05-find-typed"
      log "find bar: $(texts_in "$(dump "05-find-typed")" | cut -c1-300)"
      key KEYCODE_ENTER
      sleep 1; shot "05-find-next"
      ;;
    compact)
      shot "05-compact-on"
      menu_pick 'Compact Mode' compact-off || true
      sleep 1.5; shot "05-compact-off"
      continue
      ;;
    reader)
      key KEYCODE_BACK
      sleep 2; shot "05-reader-after-back"
      ensure_app reader
      continue
      ;;
    print | savepage)
      sleep 2; shot "05-$name-4s"
      log "$name top: $(top_activity)"
      key KEYCODE_BACK
      sleep 2; shot "05-$name-after-back"
      ensure_app "$name"
      # Run 3: after the print dialog the bar, pill and menu no longer reacted to touch.
      tap_menu
      sleep 1.5
      shot "05-$name-menu-after"
      if menu_open; then
        log "the chrome still responds after $name"
        close_menu
      else
        finding "after the $name dialog the chrome no longer responds to touch (menu button dead; only a restart recovers)"
        # What is on top of the app and where does input go? (The a11y tree still listed the bar.)
        adb shell dumpsys window windows > "$out/dumpsys-window-after-$name.txt" 2> /dev/null || true
        adb shell dumpsys input > "$out/dumpsys-input-after-$name.txt" 2> /dev/null || true
        adb shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp|mTopIsFullscreen|imeInputTarget' \
          > "$out/dumpsys-focus-after-$name.txt" 2> /dev/null || true
        log "focus after $name: $(tr '\n' ' ' < "$out/dumpsys-focus-after-$name.txt" | tr -s ' ' | cut -c1-300)"
        # Does the page WebView still take touches? Scroll it and compare screenshots.
        shot "05-$name-page-before-scroll"
        swipe $((W / 2)) $((H / 2 + 200)) $((W / 2)) $((H / 2 - 200)) 300
        sleep 1.5
        shot "05-$name-page-after-scroll"
        # Does a second back, or a tap on the page, revive the chrome?
        key KEYCODE_BACK; sleep 1.5
        ensure_app "$name"
        tap_menu; sleep 1.5
        if menu_open; then
          log "a second back revived the chrome after $name"
          close_menu
          continue
        fi
        adb shell am force-stop "$app_id"
        sleep 1
        adb shell am start -n "$activity" > /dev/null 2>&1 || true
        sleep 6
        shot "05-$name-after-restart"
      fi
      continue
      ;;
    screenshot)
      sleep 2; shot "05-screenshot-4s"
      log "files after Take Screenshot: $(adb shell ls -la /sdcard/Pictures /sdcard/Download 2> /dev/null | tr -s ' ' | tail -6 | tr '\n' ';')"
      ensure_app screenshot
      continue
      ;;
    fullscreen)
      log "fullscreen: in_fullscreen=$(in_fullscreen && echo yes || echo no)"
      if tap_label exact 'Got it'; then sleep 1; shot "05-fullscreen-got-it"; fi
      key KEYCODE_BACK
      sleep 1.5; shot "05-fullscreen-after-back"
      if in_fullscreen; then
        finding "system back does not leave the menu's Fullscreen mode (the system bars stay hidden)"
        menu_pick 'Fullscreen' fullscreen-off && { sleep 2; shot "05-fullscreen-off"; }
      fi
      if in_fullscreen; then
        finding "Fullscreen could not be toggled off from the menu; restarting the app"
        adb shell am force-stop "$app_id"
        sleep 1
        adb shell am start -n "$activity" > /dev/null 2>&1 || true
        sleep 6
      fi
      continue
      ;;
  esac
  recover "$name"
done
}

walk_menu_items \
  'New Tab|newtab' 'New Space…|newspace' 'Bookmarks|bookmarks' 'History|history' 'Downloads|downloads' \
  'Add-ons and Themes|addons' 'Compact Mode|compact' 'Change Theme…|theme' \
  'Find in Page…|find' 'Save Page As…|savepage' 'Take Screenshot|screenshot' \
  'Keyboard Shortcuts|shortcuts' 'About Zen|about'

# ==============================================================================================
# 6. Settings: every section, theme toggles, phone layout
# ==============================================================================================
step "6 settings"
ensure_app settings
menu_pick 'Settings' settings || true
sleep 0.3; shot "06-settings-300ms"
sleep 2; shot "06-settings-open"
xml=$(dump "06-settings") || true
log "settings tree: $(texts_in "$xml")"
for section in 'Look and Feel' 'Compact Mode' 'Tab Management' 'Search' 'Space Routing' 'Containers' 'Boosts' 'Mods' 'AI Agents' 'Keyboard Shortcuts' 'Updates' 'About'; do
  slug=${section// /-}
  if tap_label exact "$section"; then
    sleep 1.5
    shot "06-settings-${slug}"
    xml=$(dump "06-settings-${slug}") || true
    log "section '$section': $(texts_in "$xml")"
    # Scroll the content and look again.
    swipe $((W * 3 / 4)) $((H - 400)) $((W * 3 / 4)) 350 500
    sleep 1.2
    shot "06-settings-${slug}-scrolled"
    swipe $((W * 3 / 4)) 350 $((W * 3 / 4)) $((H - 400)) 300
    sleep 0.8
    # A phone settings panel may show one section at a time with a back control.
    if ! has_label exact 'Look and Feel' && ! has_label exact 'About'; then
      tap_label contains 'Back' || key KEYCODE_BACK
      sleep 1
    fi
  else
    finding "settings section '$section' not reachable by tap"
  fi
done
# Colour scheme: system → dark → light → system, watching the chrome and the page.
tap_label exact 'Look and Feel' || true
sleep 1.2
xml=$(dump "06-look") || true
log "look and feel: $(texts_in "$xml")"
if tap_label contains 'Follow system'; then
  sleep 1.2; shot "06-scheme-select-open"
  log "scheme control: $(texts_in "$(dump "06-scheme")" | cut -c1-300)"
  tap_label exact 'Dark' || tap_label contains 'Dark' || true
  sleep 0.3; shot "06-scheme-dark-300ms"
  sleep 2; shot "06-scheme-dark"
  tap_label exact 'Dark' || tap_label contains 'Dark' || true
  sleep 1.2
  tap_label exact 'Light' || tap_label contains 'Light' || true
  sleep 2; shot "06-scheme-light"
  tap_label exact 'Light' || tap_label contains 'Light' || true
  sleep 1.2
  tap_label contains 'Follow system' || true
  sleep 2; shot "06-scheme-system"
else
  finding "colour scheme control not found in Look and Feel"
fi
recover settings
shot "06-settings-closed"

# ==============================================================================================
# 7. History, bookmarks, downloads: add a bookmark, download a small file
# ==============================================================================================
step "7 history bookmarks downloads"
menu_pick 'History' history && { sleep 2; shot "07-history"; xml=$(dump "07-history") || true; log "history: $(texts_in "$xml" | cut -c1-500)"; recover history; }
menu_pick 'Bookmarks' bookmarks && {
  sleep 2; shot "07-bookmarks-empty"
  if tap_label exact 'Bookmark current'; then
    sleep 0.3; shot "07-bookmark-added-300ms"
    sleep 1.5; shot "07-bookmark-added"
    log "bookmarks after adding: $(texts_in "$(dump "07-bookmarked")" | cut -c1-400)"
  else
    finding "no 'Bookmark current' action in the bookmarks panel"
  fi
  recover bookmarks
}
# Served with Content-Disposition: attachment, so the WebView must hand it to the downloader.
navigate "http://localhost:$port/download/zen-sample.png" "07-download"
sleep 0.5; shot "07-download-1500ms"
sleep 1; shot "07-download-2500ms"
sleep 3; shot "07-download-5500ms"
xml=$(dump "07-download") || true
log "after download navigation: tabs=$(tabs_count) tree: $(texts_in "$xml" | cut -c1-400)"
adb shell cmd statusbar expand-notifications || true
sleep 2; shot "07-notification-shade"
log "notifications: $(texts_in "$(dump "07-shade")" | cut -c1-400)"
adb shell cmd statusbar collapse || true
sleep 1
menu_pick 'Downloads' downloads && {
  sleep 2; shot "07-downloads-panel"
  xml=$(dump "07-downloads") || true
  log "downloads panel: $(texts_in "$xml" | cut -c1-400)"
  if tap_label contains 'zen-sample'; then
    sleep 2.5; shot "07-download-open-tapped"
    log "top after opening download: $(top_activity)"
    log "open tree: $(texts_in "$(dump "07-open")" | cut -c1-300)"
    if ! app_in_front; then key KEYCODE_BACK; sleep 1.5; shot "07-download-open-back"; fi
  else
    finding "the downloaded file is not listed in the downloads panel"
  fi
  recover downloads
}
log "files in Download: $(adb shell ls -la /sdcard/Download 2> /dev/null | tr -s ' ' | tail -5 | tr '\n' ';')"
adb shell dumpsys notification --noredact 2> /dev/null | grep -iE 'pkg=|tickerText|android.title|android.text' | grep -iA3 "$app_id\|download" | head -30 > "$out/dumpsys-notification.txt" || true

# ==============================================================================================
# 8. Long-press a link, an image and text; a child tab and back
# ==============================================================================================
step "8 long press"
navigate "http://localhost:$port/longpress.html" "08-testpage"
sleep 4; shot "08-testpage-loaded"
xml=$(dump "08-testpage") || true
# shellcheck disable=SC2046
if wv=$(webview_bounds "$xml"); then
  set -- $wv; wx1=$1; wy1=$2; wx2=$3
else
  wx1=$(px 8); wy1=$(px 32); wx2=$((W - wx1))
fi
log "tab webview at $wx1,$wy1-$wx2"
cx=$(( (wx1 + wx2) / 2 ))
# Sections are 150 css px tall (the image one 180): link 0-150, blank-target 150-300,
# image 300-480, text 480-630, field 630-780, select 780-930.
long_press "$cx" $((wy1 + $(px 75)))
sleep 0.3; shot "08-longpress-link-300ms"
sleep 1.2; shot "08-longpress-link"
xml=$(dump "08-link-menu") || true
log "after link long-press: $(texts_in "$xml" | cut -c1-400)"
if ctx_menu_in "$xml"; then
  key KEYCODE_BACK; sleep 1; shot "08-link-menu-after-back"
  xml=$(dump "08-link-menu-back") || true
  if ctx_menu_in "$xml"; then
    finding "system back does not dismiss the link context menu"
    tap $((wx1 + 20)) $((wy1 + $(px 390))); sleep 1
  fi
else
  finding "long-pressing a link shows no context menu (Chrome: open in new tab, incognito, copy link, share, download)"
fi
ensure_app "link long-press"
long_press "$cx" $((wy1 + $(px 390)))
sleep 1.5; shot "08-longpress-image"
xml=$(dump "08-image-menu") || true
log "after image long-press: $(texts_in "$xml" | cut -c1-400)"
if ctx_menu_in "$xml"; then
  key KEYCODE_BACK; sleep 1
  ctx_menu_in "$(dump "08-image-menu-back")" && { tap $((wx1 + 20)) $((wy1 + $(px 390))); sleep 1; }
else
  finding "long-pressing an image shows no context menu (Chrome: open, download, copy, share, search)"
fi
ensure_app "image long-press"
long_press "$cx" $((wy1 + $(px 555)))
sleep 1.5; shot "08-longpress-text"
xml=$(dump "08-text-selection") || true
log "after text long-press: $(texts_in "$xml" | cut -c1-400)"
if ! find_in "$xml" exact 'Copy' > /dev/null && ! find_in "$xml" contains 'Select all' > /dev/null; then
  finding "long-pressing text shows no selection action bar (Chrome: copy, share, select all, web search)"
fi
# Clear the selection with a tap on the image section's empty margin (no link there).
tap $((wx1 + 20)) $((wy1 + $(px 390)))
sleep 1; shot "08-selection-cleared"
# A field in the page: does the keyboard push the bar up, and does back close it?
tap "$cx" $((wy1 + $(px 705)))
sleep 1.5; shot "08-page-field-focused"
log "ime with page field: $(adb shell dumpsys input_method | grep -oE 'mInputShown=[a-z]+' | head -1) tree: $(texts_in "$(dump "08-field")" | cut -c1-300)"
type_text "typed into the page"
sleep 1; shot "08-page-field-typed"
key KEYCODE_BACK; sleep 1; shot "08-page-field-after-back"
# A select: the WebView's native picker.
tap "$cx" $((wy1 + $(px 855)))
sleep 1.5; shot "08-select-open"
log "select picker: $(texts_in "$(dump "08-select")" | cut -c1-300)"
key KEYCODE_BACK; sleep 1
ensure_app "select"
# A link with target=_blank: a new tab; back should close it and return to the parent (Chrome).
tabs_before=$(tabs_count)
tap "$cx" $((wy1 + $(px 225)))
sleep 0.3; shot "08-child-tab-300ms"
sleep 2.5; shot "08-child-tab"
log "child tab: tabs $tabs_before → $(tabs_count) pill: $(texts_in "$(dump "08-child")" | cut -c1-200)"
key KEYCODE_BACK
sleep 0.3; shot "08-child-back-300ms"
sleep 2; shot "08-child-back-settled"
log "after back from child: tabs=$(tabs_count) top=$(top_activity) pill: $(texts_in "$(dump "08-child-back")" | cut -c1-200)"
if ! app_in_front; then
  finding "back on a tab opened by a link backgrounds the app instead of closing the tab and returning to its opener (Chrome does the latter)"
  adb shell am start -n "$activity" > /dev/null 2>&1 || true
  sleep 3
fi

# ==============================================================================================
# 9. Landscape and back; system dark mode
# ==============================================================================================
step "9 rotation and dark mode"
ensure_app rotation
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 1; shot "09-landscape-1s"
sleep 2.5; shot "09-landscape"
log "landscape tree: $(texts_in "$(dump "09-landscape")" | cut -c1-300)"
tap_pill
sleep 2; shot "09-landscape-omnibox"
key KEYCODE_BACK; sleep 1; key KEYCODE_BACK; sleep 1
tap_tabs
sleep 2; shot "09-landscape-overview"
leave_overview
tap_menu
sleep 1.5; shot "09-landscape-menu"
close_menu
adb shell settings put system user_rotation 0
sleep 1; shot "09-portrait-1s"
sleep 2.5; shot "09-portrait-again"
adb shell cmd uimode night yes
sleep 1; shot "09-system-dark-1s"
sleep 2.5; shot "09-system-dark"
tap_menu
sleep 1.5; shot "09-system-dark-menu"
close_menu
tap_tabs
sleep 2; shot "09-system-dark-overview"
leave_overview
tap_pill
sleep 1.5; shot "09-system-dark-omnibox"
key KEYCODE_BACK; sleep 1; key KEYCODE_BACK; sleep 1
adb shell cmd uimode night no
sleep 3.5; shot "09-system-light-again"

# ==============================================================================================
# 10. Font scale 1.3
# ==============================================================================================
step "10 font scale"
ensure_app "font scale"
adb shell settings put system font_scale 1.3
sleep 4; shot "10-font-1.3-chrome"
tap_pill
sleep 1.5; shot "10-font-1.3-omnibox"
key KEYCODE_BACK; sleep 1; key KEYCODE_BACK; sleep 1
tap_menu
sleep 1.5; shot "10-font-1.3-menu"
close_menu
tap_tabs
sleep 2; shot "10-font-1.3-overview"
leave_overview
menu_pick 'Settings' settings-font && { sleep 2; shot "10-font-1.3-settings"; recover settings; }
adb shell settings put system font_scale 1.0
sleep 4; shot "10-font-1.0-again"

# ==============================================================================================
# 11. Intents: VIEW from the background and the foreground, SEND, WEB_SEARCH
# ==============================================================================================
step "11 intents"
ensure_app intents
log "tabs before intents: $(tabs_count)"
key KEYCODE_HOME
sleep 2.5; shot "11-home"
adb shell am start -a android.intent.action.VIEW -d "https://example.com/" > /dev/null 2>&1 || true
sleep 0.5; shot "11-view-from-background-500ms"
sleep 0.5; shot "11-view-from-background-1s"
sleep 2.5; shot "11-view-from-background-settled"
log "top after VIEW without component: $(top_activity)"
if ! app_in_front; then
  finding "VIEW https from the shell did not land in the app (top: $(top_activity)); a chooser or another browser took it"
  shot "11-view-chooser"
  key KEYCODE_BACK; sleep 1
  adb shell am start -a android.intent.action.VIEW -d "https://example.com/" -n "$activity" > /dev/null 2>&1 || true
  sleep 3.5; shot "11-view-explicit"
fi
log "tabs after background VIEW: $(tabs_count) pill: $(texts_in "$(dump "11-view")" | cut -c1-200)"
adb shell am start -a android.intent.action.VIEW -d "https://www.wikipedia.org/" -n "$activity" > /dev/null 2>&1 || true
sleep 0.5; shot "11-view-foreground-500ms"
sleep 3; shot "11-view-foreground-settled"
log "tabs after foreground VIEW: $(tabs_count)"
# Extras are quoted for the device shell, which splits the joined command line again.
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "'Look at this https://developer.android.com/about/versions'" -n "$activity" > /dev/null 2>&1 || true
sleep 3.5; shot "11-send-url"
log "tabs after SEND url: $(tabs_count) pill: $(texts_in "$(dump "11-send-url")" | cut -c1-200)"
adb shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "'plain text shared from another app'" -n "$activity" > /dev/null 2>&1 || true
sleep 3.5; shot "11-send-text"
log "tabs after SEND text: $(tabs_count) pill: $(texts_in "$(dump "11-send-text")" | cut -c1-200)"
adb shell am start -a android.intent.action.WEB_SEARCH --es query "'kotlin coroutines'" > /dev/null 2>&1 || true
sleep 3.5; shot "11-web-search"
log "tabs after WEB_SEARCH: $(tabs_count) top=$(top_activity) pill: $(texts_in "$(dump "11-web-search")" | cut -c1-200)"
if ! app_in_front; then
  finding "WEB_SEARCH from the shell did not land in the app (top: $(top_activity))"
  key KEYCODE_BACK; sleep 1
  adb shell am start -a android.intent.action.WEB_SEARCH --es query "'kotlin coroutines'" -n "$activity" > /dev/null 2>&1 || true
  sleep 3.5; shot "11-web-search-explicit"
fi

# ==============================================================================================
# 12. Fullscreen video
# ==============================================================================================
step "12 fullscreen video"
ensure_app video
navigate "http://localhost:$port/video.html" "12-videopage"
sleep 4; shot "12-videopage-loaded"
xml=$(dump "12-videopage") || true
# shellcheck disable=SC2046
if wv=$(webview_bounds "$xml"); then set -- $wv; wx1=$1; wy1=$2; wx2=$3; fi
vh=$(( (wx2 - wx1) * 9 / 16 ))
tap_label exact 'Play' || tap $(( (wx1 + wx2) / 2 )) $(( wy1 + vh + $(px 55) ))
sleep 2; shot "12-video-playing"
# The native controls' fullscreen button sits at the bottom right of the 16:9 video.
tap $(( (wx1 + wx2) / 2 )) $(( wy1 + vh / 2 ))
sleep 0.8; shot "12-video-controls"
tap $(( wx2 - $(px 22) )) $(( wy1 + vh - $(px 22) ))
sleep 0.3; shot "12-fullscreen-enter-300ms"
sleep 2.2; shot "12-native-fullscreen-button"
log "fullscreen: in_fullscreen=$(in_fullscreen && echo yes || echo no) tree: $(texts_in "$(dump "12-fs")" | cut -c1-300)"
if ! in_fullscreen; then
  log "the controls' fullscreen button did not enter fullscreen; trying requestFullscreen from a button"
  tap_label exact 'Go fullscreen' || tap $(( (wx1 + wx2) / 2 )) $(( wy1 + vh + $(px 180) ))
  sleep 0.3; shot "12-js-fullscreen-300ms"
  sleep 2.2; shot "12-js-fullscreen"
  log "fullscreen via api: in_fullscreen=$(in_fullscreen && echo yes || echo no)"
fi
if in_fullscreen; then
  if tap_label exact 'Got it'; then sleep 1; shot "12-fullscreen-got-it"; fi
  adb shell settings put system user_rotation 1
  sleep 3.5; shot "12-fullscreen-landscape"
  adb shell settings put system user_rotation 0
  sleep 3.5; shot "12-fullscreen-portrait"
  key KEYCODE_BACK
  sleep 0.3; shot "12-fullscreen-back-300ms"
  sleep 2; shot "12-fullscreen-exited"
  if in_fullscreen; then
    finding "system back does not leave video fullscreen (Chrome exits fullscreen on back)"
    key KEYCODE_BACK; sleep 2; shot "12-second-back"
  fi
else
  finding "the video never entered fullscreen (neither the native control nor requestFullscreen)"
fi
if in_fullscreen; then
  finding "still fullscreen after two backs; restarting the app"
  adb shell am force-stop "$app_id"; sleep 1
  adb shell am start -n "$activity" > /dev/null 2>&1 || true
  sleep 6
fi
ensure_app "after video"

# ==============================================================================================
# 13. Drawer sidebar (spaces, essentials)
# ==============================================================================================
step "13 drawer"
tap_tabs
sleep 2
if tap_label exact 'Open sidebar'; then
  sleep 0.15; shot "13-drawer-150ms"
  sleep 0.3; shot "13-drawer-450ms"
  sleep 1.5; shot "13-drawer-open"
  xml=$(dump "13-drawer") || true
  log "drawer: $(texts_in "$xml")"
  swipe $((W / 3)) $((H - 400)) $((W / 3)) 400 500
  sleep 1; shot "13-drawer-scrolled"
  tap $((W - 40)) $((H / 2))
  sleep 0.15; shot "13-drawer-closing-150ms"
  sleep 1.5; shot "13-drawer-closed"
  if has_label contains 'Essentials'; then
    key KEYCODE_BACK; sleep 1.5; shot "13-drawer-after-back"
  fi
else
  finding "no 'Open sidebar' button in the overview"
fi
leave_overview
shot "13-after-drawer"

# ==============================================================================================
# 14. Kill and relaunch: session restore and time to interactive
# ==============================================================================================
step "14 restart"
ensure_app restart
log "tabs before kill: $(tabs_count) pill: $(texts_in "$(dump "14-before")" | cut -c1-200)"
shot "14-before-kill"
adb shell am force-stop "$app_id"
sleep 2
adb shell am start -W -n "$activity" > "$out/am-start-warm.txt" 2>&1 || true
cat "$out/am-start-warm.txt"
sleep 1; shot "14-relaunch-1s"
sleep 1; shot "14-relaunch-2s"
sleep 2; shot "14-relaunch-4s"
sleep 4; shot "14-relaunch-8s"
log "tabs after relaunch: $(tabs_count) pill: $(texts_in "$(dump "14-after")" | cut -c1-300)"
tap_tabs
sleep 2; shot "14-relaunch-overview"
log "restored overview: $(texts_in "$(dump "14-overview")" | cut -c1-400)"
leave_overview

# ==============================================================================================
# 15. Error pages, a very long URL, a data: URL
# ==============================================================================================
step "15 error pages"
navigate "https://nonexistent.invalid/" "15-dns-error"
sleep 6; shot "15-dns-error-page"
log "dns error tree: $(texts_in "$(dump "15-dns")" | cut -c1-400)"
navigate "http://localhost:1/" "15-refused"
sleep 6; shot "15-connection-refused-page"
log "refused tree: $(texts_in "$(dump "15-refused")" | cut -c1-400)"
if tap_label contains 'Try again' || tap_label contains 'Reload' || tap_label contains 'Retry'; then sleep 3; shot "15-error-retry"; fi
longurl="https://example.com/?q=$(python3 -c 'print("abcdefghij" * 45)')&end=1"
navigate "$longurl" "15-long-url"
sleep 6; shot "15-long-url-loaded"
tap_pill
sleep 1.5; shot "15-long-url-omnibox"
log "long url field: $(edit_text "$(dump "15-long")" | cut -c1-120)"
key KEYCODE_BACK; sleep 1; key KEYCODE_BACK; sleep 1
navigate "data:text/html,%3Ch1%3EHello%20from%20a%20data%20URL%3C/h1%3E" "15-data-url"
sleep 4; shot "15-data-url-loaded"
log "pill for data url: $(texts_in "$(dump "15-data")" | cut -c1-300)"

# ==============================================================================================
# 16. Odds and ends: back closes the omnibox, the overview's new-tab card, Quit
# ==============================================================================================
step "16 odds and ends"
ensure_app "odds and ends"
tap_pill
sleep 1.5
key KEYCODE_BACK
sleep 1.2; shot "16-back1-omnibox"
key KEYCODE_BACK
sleep 1.2; shot "16-back2-omnibox"
log "after two backs on the omnibox: pill: $(texts_in "$(dump "16-omnibox")" | cut -c1-200)"
tap_tabs
sleep 2
tap_label exact 'New Tab' || tap_label contains 'New tab' || true
sleep 0.3; shot "16-overview-newtab-300ms"
sleep 1.5; shot "16-overview-newtab-card"
key KEYCODE_BACK; sleep 1.2
key KEYCODE_BACK; sleep 1.2
shot "16-final"
log "final tabs: $(tabs_count) top=$(top_activity)"

# The menu items that hand over to other windows, on a real article so Reader View is enabled.
step "16b menu items that leave the app"
navigate "https://en.wikipedia.org/wiki/Android_(operating_system)" "16-wikipedia"
sleep 12; shot "16-wikipedia-loaded"
walk_menu_items 'Reader View|reader' 'Print…|print' 'Fullscreen|fullscreen'

# Last: what does the menu's Quit do on a phone (Chrome has no such item)?
ensure_app quit
if menu_pick 'Quit' quit; then
  sleep 0.5; shot "16-after-quit-500ms"
  sleep 2; shot "16-after-quit"
  log "top after Quit: $(top_activity); process: $(adb shell pidof "$app_id" || echo none)"
fi

# --- wrap up ----------------------------------------------------------------------------------
adb shell dumpsys meminfo "$app_id" 2> /dev/null | head -40 > "$out/dumpsys-meminfo.txt" || true
adb shell dumpsys gfxinfo "$app_id" 2> /dev/null | head -60 > "$out/dumpsys-gfxinfo.txt" || true
adb shell dumpsys window 2> /dev/null | grep -E 'mCurrentFocus|mFocusedApp|DisplayFrames|cutout' | head -10 > "$out/dumpsys-window.txt" || true

touch "$out/stop-recording"
adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
wait "$recorder_pid" 2> /dev/null || true
sleep 2
pkill -P "$logcat_pid" 2> /dev/null || true
kill "$logcat_pid" "$monitor_pid" "$www_pid" 2> /dev/null || true

for name in $(adb shell ls /sdcard/android-bughunt-seg*.mp4 2> /dev/null | tr -d '\r'); do
  adb pull "$name" "$out/video/" || true
done
rm -rf "$www"
log "emulator restarts during the run: $emu_restarts"
# The emulator's own crash reports, when small enough to ship.
for db in /tmp/android-runner/emu-crash-*.db; do
  [ -d "$db" ] || continue
  if [ "$(du -sm "$db" | cut -f1)" -le 40 ]; then cp -r "$db" "$out/emu-crash" 2> /dev/null || true; fi
  du -sh "$db" >> "$out/host-monitor.txt" 2> /dev/null || true
done
ls -la "$out" "$out/video" "$out/shots" | head -500
du -sh "$out"
