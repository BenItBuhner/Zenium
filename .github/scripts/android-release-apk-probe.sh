#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted (android-release-apk-probe.yml): does
# a REAL tap on the phone URL pill open the address field in the published release APKs?
#
# For every APK under $PROBE_APKS/<tag>/: install (fresh profile), then two scenes, FRESH (the
# first launch, onboarding tapped through if it shows) and SEEDED (a second launch of the same
# profile with the same page loaded). In each scene three taps through the input pipeline
# (`input tap`): the pill's centre, its URL text (the centre of the node's left third) and its
# leading glyph (22 dp in from the pill's left edge), each with a still and a uiautomator tree
# before and after, plus the IME state (dumpsys input_method mInputShown). Everything lands under
# $PROBE_OUT: stills/, trees/, table.md (the step summary), notes.txt, the app's logcat.
#
# Never fails early: a scene that finds no pill is written down as such and the probe goes on.
set -uo pipefail

pkg=io.github.benitbuhner.zenium
apks=${PROBE_APKS:-apks}
out=${PROBE_OUT:-artifacts/p0-pill-tap-probe}
mkdir -p "$out/stills" "$out/trees"
table="$out/table.md"
notes="$out/notes.txt"
: > "$notes"
printf '| tag | scene | tap | pill (button) bounds | tap point | field open? | IME shown? | after the tap |\n|---|---|---|---|---|---|---|---|\n' > "$table"

# To stderr, so a function whose stdout is captured can still take notes.
note() { echo "$(date +%T) $*" | tee -a "$notes" >&2; }

adb wait-for-device
nproc
free -m

# The display and the navigation mode, as android-gesture-demo.sh sets them.
adb shell wm size 720x1600
adb shell wm density 280
adb shell settings put global hide_error_dialogs 1 || true
sleep 2
adb shell am force-stop com.google.android.apps.nexuslauncher || true
sleep 3
adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true

for p in \
  com.google.android.youtube com.google.android.apps.youtube.music com.google.android.gm \
  com.google.android.apps.messaging com.android.chrome com.google.android.apps.maps \
  com.google.android.videos com.google.android.apps.photos com.google.android.googlequicksearchbox \
  com.google.android.calendar com.google.android.apps.docs com.google.android.apps.wellbeing \
  com.google.android.projection.gearhead com.google.android.apps.tachyon com.google.android.talk \
  com.google.android.music com.google.android.apps.podcasts com.google.android.apps.nbu.files; do
  adb shell pm disable-user --user 0 "$p" > /dev/null 2>&1 || true
done
adb shell am kill-all || true
note "letting the system settle"
sleep 45
free -m
adb shell wm size
adb shell wm density
adb shell getprop ro.build.version.release
adb shell dumpsys package com.google.android.webview 2> /dev/null | grep -m1 versionName || true

adb logcat -c || true
adb logcat -v time > "$out/logcat-full.txt" &
logcat_pid=$!
pids=()

# --- tree helpers -------------------------------------------------------------------------------

dump_tree() { # $1 = file; a few tries, uiautomator refuses while the UI is not idle
  local f=$1 i
  for i in 1 2 3 4 5 6; do
    if adb shell uiautomator dump /sdcard/probe-tree.xml > /dev/null 2>&1 \
      && adb exec-out cat /sdcard/probe-tree.xml > "$f" 2> /dev/null && grep -q '<node' "$f"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Prints "x1 y1 x2 y2 <content-desc>" of the pill: the button whose content-desc starts with
# "Address," (the URL in it), else the group labelled "Address"; nothing when there is none.
pill_node() {
  python3 - "$1" "${2:-button}" << 'PY'
import re, sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(0)
want = sys.argv[2]
button = group = None
for n in root.iter('node'):
    d = n.get('content-desc') or ''
    if d.startswith('Address,') and button is None:
        button = n
    elif d == 'Address' and group is None:
        group = n
n = group if want == 'group' else button
if n is None:
    n = button if button is not None else group
if n is None:
    sys.exit(0)
m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds') or '')
if m:
    print(*m.groups(), n.get('content-desc'))
PY
}

# One line about the field after a tap: focused EditText? how many EditTexts? an omnibox label?
field_state() {
  python3 - "$1" << 'PY'
import sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    print('tree unreadable'); sys.exit(0)
edits = [n for n in root.iter('node') if n.get('class') == 'android.widget.EditText']
focused = [n for n in edits if n.get('focused') == 'true']
labels = [n for n in root.iter('node')
          if 'Search or enter address' in (n.get('content-desc') or '') + (n.get('text') or '')
          or (n.get('content-desc') or '').startswith('Search with ')]
focused_any = [n for n in root.iter('node') if n.get('focused') == 'true']
def name(n):
    return (n.get('content-desc') or n.get('text') or n.get('class') or '?')[:60]
print('focusedEditText=%s editTexts=%d omniboxLabel=%s focused=[%s]' % (
    'yes' if focused else 'no', len(edits), 'yes' if labels else 'no',
    ' | '.join(name(n) for n in focused_any)[:200]))
PY
}

# Prints "x y" of the first clickable node whose text or content-desc is one of the onboarding
# buttons, so a fresh profile's first run can be tapped through.
onboarding_button() {
  python3 - "$1" << 'PY'
import re, sys, xml.etree.ElementTree as ET
try:
    root = ET.parse(sys.argv[1]).getroot()
except Exception:
    sys.exit(0)
labels = {'Get started', 'Continue', 'Start browsing', 'Not now', 'Skip', 'Done', 'Allow',
          'While using the app', 'Only this time', 'OK', 'Got it', 'Maybe later', 'No thanks'}
for n in root.iter('node'):
    t = (n.get('text') or '').strip(); d = (n.get('content-desc') or '').strip()
    if t in labels or d in labels:
        m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', n.get('bounds') or '')
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2, t or d)
            break
PY
}

ime_shown() {
  local s
  s=$(adb shell dumpsys input_method 2> /dev/null | tr -d '\r' | grep -m1 -o 'mInputShown=[a-z]*')
  case "$s" in *true) echo yes ;; *false) echo no ;; *) echo "? ($s)" ;; esac
}

still() { adb exec-out screencap -p > "$out/stills/$1.png" 2> /dev/null || note "screencap failed: $1"; }

launch() {
  adb shell am start -W -a android.intent.action.VIEW -d https://example.org "$pkg" > /dev/null 2>&1 || true
  sleep 3
  local pid
  pid=$(adb shell pidof "$pkg" 2> /dev/null | tr -d '\r ')
  [ -n "$pid" ] && pids+=("$pid")
}

# Waits up to ~75 s for the pill to carry example.org, tapping onboarding buttons on the way.
# Prints the button node's line; returns 1 when no pill came (the tree of the last look is kept).
wait_pill() { # $1 = tree file
  local f=$1 i line btn
  line=""
  for i in $(seq 1 25); do
    if dump_tree "$f"; then
      line=$(pill_node "$f" button)
      case "$line" in *example.org*) echo "$line"; return 0 ;; esac
      btn=$(onboarding_button "$f")
      if [ -n "$btn" ]; then
        note "onboarding: tapping '${btn#* * }' at ${btn% *}"
        # shellcheck disable=SC2086
        adb shell input tap ${btn% *}
        sleep 2
        continue
      fi
    fi
    sleep 2
  done
  echo "$line"
  [ -n "$line" ]
}

# Presses back until the field is closed and the pill is back (a field left open would taint the
# next tap); relaunches when the app went away instead.
restore() { # $1 = tree file
  local f=$1 i st
  for i in 1 2 3; do
    dump_tree "$f" || true
    st=$(field_state "$f")
    if [ "$(ime_shown)" = no ] && [[ $st == focusedEditText=no* ]] && [ -n "$(pill_node "$f" button)" ]; then
      return 0
    fi
    adb shell input keyevent KEYCODE_BACK
    sleep 1.5
  done
  dump_tree "$f" || true
  if [ -z "$(pill_node "$f" button)" ]; then
    note "the pill did not come back after BACK; relaunching"
    launch
    wait_pill "$f" > /dev/null || true
  fi
}

# --- one tap ------------------------------------------------------------------------------------

tap_probe() { # $1 tag, $2 scene, $3 tap name, $4 x, $5 y, $6 pill line, $7 trees prefix
  local tag=$1 scene=$2 name=$3 x=$4 y=$5 pill=$6 id=$7 st ime after
  still "$id-before"
  adb shell input tap "$x" "$y"
  sleep 1.5
  still "$id-after"
  dump_tree "$out/trees/$id-after.xml" || note "no tree after $id"
  st=$(field_state "$out/trees/$id-after.xml")
  ime=$(ime_shown)
  adb shell dumpsys input_method 2> /dev/null | tr -d '\r' | grep -E 'mInputShown|mImeWindowVis|mCurFocusedWindow|mShowRequested' > "$out/trees/$id-ime.txt" || true
  local open=no
  case "$st" in focusedEditText=yes*) open=yes ;; esac
  case "$st" in *omniboxLabel=yes*) [ "$open" = yes ] || open="no (omnibox label present)" ;; esac
  after=$(pill_node "$out/trees/$id-after.xml" button)
  [ -n "$after" ] || after="no Address node"
  note "$tag $scene $name at ($x,$y): $st ime=$ime"
  printf '| %s | %s | %s | %s | %s,%s | %s | %s | %s |\n' \
    "$tag" "$scene" "$name" "[${pill%% *},$(echo "$pill" | cut -d' ' -f2)][$(echo "$pill" | cut -d' ' -f3),$(echo "$pill" | cut -d' ' -f4)]" \
    "$x" "$y" "$open" "$ime" "$(echo "$st" | sed 's/|/\//g'); pill: $(echo "${after#* * * * }" | sed 's/|/\//g')" >> "$table"
  restore "$out/trees/$id-restore.xml"
}

scene() { # $1 tag, $2 scene name
  local tag=$1 scene=$2 id line group x1 y1 x2 y2 gx1 gy1 gx2 gy2 cx cy
  id="$tag-$scene"
  launch
  if ! line=$(wait_pill "$out/trees/$id-arrival.xml"); then
    note "$tag $scene: NO PILL after the launch (tree: trees/$id-arrival.xml)"
    still "$id-no-pill"
    printf '| %s | %s | - | no Address node | - | - | %s | %s |\n' "$tag" "$scene" "$(ime_shown)" "$(field_state "$out/trees/$id-arrival.xml" | sed 's/|/\//g')" >> "$table"
    return
  fi
  note "$tag $scene: pill button: $line"
  read -r x1 y1 x2 y2 _ <<< "$line"
  group=$(pill_node "$out/trees/$id-arrival.xml" group)
  if [ -n "$group" ]; then
    read -r gx1 gy1 gx2 gy2 _ <<< "$group"
    note "$tag $scene: pill group: $group"
  else
    gx1=$x1; gy1=$y1; gx2=$x2; gy2=$y2
  fi
  cx=$(( (x1 + x2) / 2 )); cy=$(( (y1 + y2) / 2 ))
  tap_probe "$tag" "$scene" centre "$cx" "$cy" "$line" "$id-1-centre"
  # The URL text: the centre of the button's left third.
  tap_probe "$tag" "$scene" url-text $(( x1 + (x2 - x1) / 6 )) "$cy" "$line" "$id-2-url-text"
  # The leading glyph: 22 dp (38 px at 280 dpi) in from the pill's left edge.
  tap_probe "$tag" "$scene" leading-glyph $(( gx1 + 38 )) $(( (gy1 + gy2) / 2 )) "$line" "$id-3-leading-glyph"
  # The whole pill's centre (the group labelled "Address"): where a driver aiming at the first
  # node that starts with "Address" lands when the group comes before the button.
  if [ -n "$group" ]; then
    tap_probe "$tag" "$scene" group-centre $(( (gx1 + gx2) / 2 )) $(( (gy1 + gy2) / 2 )) "$line" "$id-4-group-centre"
  fi
}

# --- the APKs -----------------------------------------------------------------------------------

for dir in "$apks"/*/; do
  tag=$(basename "$dir")
  apk=$(find "$dir" -name '*.apk' -print -quit)
  if [ -z "$apk" ]; then note "$tag: no APK"; continue; fi
  note "== $tag: $apk"
  adb uninstall "$pkg" > /dev/null 2>&1 || true
  if ! adb install -r -g "$apk"; then
    note "$tag: install failed"
    printf '| %s | - | - | install failed | - | - | - | - |\n' "$tag" >> "$table"
    continue
  fi
  adb shell pm clear "$pkg" > /dev/null 2>&1 || true
  adb shell dumpsys package "$pkg" | tr -d '\r' | grep -m1 versionName | tee -a "$notes"
  scene "$tag" fresh
  adb shell am force-stop "$pkg"
  sleep 2
  scene "$tag" seeded
  adb shell am force-stop "$pkg"
  sleep 2
  adb shell pm clear "$pkg" > /dev/null 2>&1 || true
done

sleep 1
kill "$logcat_pid" 2> /dev/null || true
if [ "${#pids[@]}" -gt 0 ]; then
  pat=$(IFS='|'; echo "${pids[*]}")
  grep -E "\( *(${pat})\)" "$out/logcat-full.txt" > "$out/logcat-app.txt" || true
  printf '%s\n' "${pids[@]}" > "$out/app-pids.txt"
fi
cat "$table"
ls -la "$out" "$out/stills"
