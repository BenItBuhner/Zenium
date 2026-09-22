#!/usr/bin/env bash
# Companion of the SyncHistoryDemo driver (android/app/src/androidTest/.../SyncHistoryDemo.kt):
# the shared demo script runs the driver – Settings › Sync set up, two other devices' open tabs
# landing, the Tabs from other devices sheet and a tab opened from it, the Send to your devices
# picker and a send, a tab the laptop sent arriving as a Sharing card and its tap from the
# FOREGROUND, the channel beside the Sites group in the app's notification settings, and a second
# card staged on the shade (cold-start.json beside the stills) – and then the shell plays the one
# scene an instrumentation cannot: that card tapped from a COLD START.
#
# Why the shell: the instrumentation runs inside the app's process, so a process that is gone has
# no driver in it. The instrumentation's exit is itself the kill – AMS force-stops the target
# package when `am instrument` finishes (finishInstrumentationLocked → forceStopPackageLocked,
# the nine-argument one) WITHOUT the ACTION_PACKAGE_RESTARTED broadcast that `am force-stop`
# adds (finishForceStopPackageLocked), and it is that broadcast on which NotificationManager
# cancels a package's cards. So the staged card outlives the process; this script checks that
# it did, opens the shade (`cmd statusbar expand-notifications`), finds the card by its title in
# `uiautomator dump`, taps its centre with `input tap`, and reads the outcome where the process's
# absence leaves it: the new process (`pidof`), the activity in front (`dumpsys activity`), and
# the profile's `files/zen/state.json` (the core writes it 400 ms after a change) for ONE new tab
# with the card's URL, active, in a regular container. Never `am force-stop` here: it would take
# the card with it.
#
# Environment: the shared script's (DEMO_CLASS, DEMO_DIR, DEMO_OUT, DEMO_VIDEO ...); the workflow
# sets them. What the scene leaves in DEMO_OUT: cold-start-notes.txt (the findings, one line
# each, `PASS` / `FAIL`), cold-start-01-shade.png and -02-opened.png, the short recording
# services-sync-history-ui-android-cold-start.mp4, logcat-cold-start.txt, and the dumps read.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-sync-history-demo}
demo_dir=${DEMO_DIR:-sync-history-demo}
mkdir -p "$out"

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?
echo "the driver's run ended with status $status"

notes=$out/cold-start-notes.txt
failures=0
say() { echo "$*" | tee -a "$notes"; }
pass() { say "PASS $*"; }
fail() { say "FAIL $*"; failures=$((failures + 1)); }

: > "$notes"
say "cold start: the staged Sharing card tapped from the shade with the app's process gone ($(date -u +%FT%TZ))"

# The driver may not have got as far as the staging (a claim before it failed, the emulator went
# away): then there is no cold-start scene to play, and the driver's status is the run's.
staged=$out/cold-start.json
if [ ! -f "$staged" ]; then
  adb exec-out run-as "$app_id" cat "files/$demo_dir/cold-start.json" > "$staged" 2> /dev/null || true
fi
if [ ! -s "$staged" ]; then
  fail "the driver left no cold-start.json: nothing was staged for the cold start"
  exit "$(( status > 0 ? status : 1 ))"
fi
read_staged() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=s[process.argv[2]];console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$staged" "$1"; }
title=$(read_staged title)
url=$(read_staged url)
channel=$(read_staged channel)
tabs_before=$(read_staged tabsBefore)
say "staged: card '$title' → $url on channel $channel; $tabs_before tabs held when it was posted"

adb logcat -c || true
adb logcat -v time > "$out/logcat-cold-start.txt" &
logcat_pid=$!
cleanup() { kill "$logcat_pid" 2> /dev/null || true; }
trap cleanup EXIT

# 1. The process must be gone. The instrumentation's exit force-stops the package; the wait is
#    for AMS to have done so. A process still there after that is signalled as itself (run-as is
#    the app's own uid; a SIGKILL from it is a crash-like death, not a force-stop, so the card
#    stays) – noted, since it says the exit did not take the process as expected.
for _ in $(seq 1 40); do
  [ -z "$(adb shell pidof "$app_id" 2> /dev/null | tr -d '\r')" ] && break
  sleep 0.5
done
pid=$(adb shell pidof "$app_id" 2> /dev/null | tr -d '\r' || true)
if [ -n "$pid" ]; then
  say "the app's process $pid outlived the instrumentation's exit; killing it as the app's own uid"
  adb shell run-as "$app_id" kill -9 "$pid" || true
  sleep 2
  pid=$(adb shell pidof "$app_id" 2> /dev/null | tr -d '\r' || true)
fi
if [ -z "$pid" ]; then pass "the app's process is gone before the tap (pidof $app_id is empty)"; else fail "the app's process $pid is still alive; no cold start"; fi

# The task too, when it can go: a fresh task's root intent is then the card's own, so the tap is
# the activity's onCreate, not an onNewIntent into a recreated task. `am stack remove` is the
# shell's way; a system that refuses leaves the task in recents, which is a cold start still
# (the process is what "cold" is about) and is noted as such.
adb shell am stack list > "$out/cold-start-stacks-before.txt" 2>&1 || true
root_ids=$(awk -v app="$app_id" '/^RootTask id=/{id=$2; sub("id=","",id)} $0 ~ ("taskId=[0-9]+: " app "/") {print id}' "$out/cold-start-stacks-before.txt" | sort -u)
if [ -n "$root_ids" ]; then
  for id in $root_ids; do adb shell am stack remove "$id" > /dev/null 2>&1 || true; done
  sleep 1
  adb shell am stack list > "$out/cold-start-stacks-after.txt" 2>&1 || true
  if grep -q "$app_id/" "$out/cold-start-stacks-after.txt"; then
    say "the app's task stayed in recents (am stack remove $root_ids did not take): the tap recreates it"
  else
    say "the app's task is gone from recents too (am stack remove $root_ids): the tap makes a fresh task"
  fi
else
  say "no task of the app's in recents before the tap"
fi

# 2. The card must still be on the shade after the kill (the app's records out of the dump, each
#    `NotificationRecord(` block up to the next – as the driver's sharingRecords() reads them).
adb shell dumpsys notification --noredact > "$out/cold-start-shade-before.txt" 2> /dev/null || true
card_records() {
  node -e '
    const fs = require("fs");
    const [file, app] = process.argv.slice(1);
    for (const rec of fs.readFileSync(file, "utf8").split("NotificationRecord(").slice(1)) {
      if (rec.includes("pkg=" + app)) console.log("NotificationRecord(" + rec);
    }
  ' "$1" "$app_id"
}
if card_records "$out/cold-start-shade-before.txt" | grep -q "$channel" && card_records "$out/cold-start-shade-before.txt" | grep -qF "android.title=String ($title)"; then
  pass "the card '$title' is still on the shade after the process's death (dumpsys notification: channel $channel)"
else
  fail "the card '$title' is not on the shade after the process's death"
  card_records "$out/cold-start-shade-before.txt" | grep -E "pkg=|mId=|android.title=" | head -n 12 | sed 's/^/  /' | tee -a "$notes" || true
  exit "$(( status > 0 ? status : 1 ))"
fi

# 3. Home, so the launcher is what the shade opens over; a short recording of the scene.
adb shell input keyevent KEYCODE_HOME || true
sleep 2
adb shell screenrecord --bit-rate 8000000 --time-limit 90 /sdcard/cold-start.mp4 &
rec=$!
sleep 1

# 4. The shade opened, the card found by its title (uiautomator's tree of SystemUI's window; the
#    dump refuses now and then while the shade still moves, so it is asked up to three times), a
#    still, the tap on its centre.
adb shell cmd statusbar expand-notifications || true
sleep 3
bounds=
for attempt in 1 2 3; do
  adb shell rm -f /sdcard/cold-start-shade.xml > /dev/null 2>&1 || true
  adb shell uiautomator dump /sdcard/cold-start-shade.xml > /dev/null 2>&1 || true
  adb pull /sdcard/cold-start-shade.xml "$out/cold-start-shade.xml" > /dev/null 2>&1 || true
  bounds=$(grep -o "<node[^>]*text=\"$title\"[^>]*>" "$out/cold-start-shade.xml" 2> /dev/null | head -n 1 \
    | sed -nE 's/.*bounds="(\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\])".*/\1/p' || true)
  [ -n "$bounds" ] && break
  echo "the shade's tree did not show '$title' (attempt $attempt)"
  sleep 2
done
adb exec-out screencap -p > "$out/cold-start-01-shade.png" || true
if [ -z "$bounds" ]; then
  fail "the shade's tree has no node reading '$title' (cold-start-shade.xml)"
  adb shell cmd statusbar collapse || true
  adb shell pkill -INT screenrecord || true
  exit "$(( status > 0 ? status : 1 ))"
fi
# bounds reads [l,t][r,b]
l=$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1/')
t=$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\2/')
r=$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\3/')
b=$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\4/')
x=$(( (l + r) / 2 ))
y=$(( (t + b) / 2 ))
say "the card's title on the shade at $bounds; tapping ($x, $y)"
tap_at=$(date +%s)
adb shell input tap "$x" "$y"

# 5. The outcome: a new process, the activity in front, the tab in the profile's state.
new_pid=
for _ in $(seq 1 60); do
  new_pid=$(adb shell pidof "$app_id" 2> /dev/null | tr -d '\r' || true)
  [ -n "$new_pid" ] && break
  sleep 0.5
done
if [ -n "$new_pid" ]; then pass "a new process $new_pid started for the tap (${pid:+the old one was $pid; }cold)"; else fail "no process of the app's within 30 s of the tap"; fi

state_check() {
  adb exec-out run-as "$app_id" cat files/zen/state.json 2> /dev/null > "$out/cold-start-state.json" || return 1
  node -e '
    const fs = require("fs");
    const [file, url, before] = process.argv.slice(1);
    let s; try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(2); }
    const tabs = Array.isArray(s.tabs) ? s.tabs : Object.values(s.tabs || {});
    const hits = tabs.filter((t) => t.url === url);
    if (hits.length === 0) process.exit(1);
    const tab = hits[0];
    const win = (s.windows || [])[0] || {};
    const selected = Object.values(win.selection || {}).includes(tab.id);
    const container = tab.containerId || "default";
    console.log(JSON.stringify({ id: tab.id, title: tab.title, container, selected, tabs: tabs.length, hits: hits.length, before: Number(before) }));
  ' "$out/cold-start-state.json" "$url" "$tabs_before"
}
verdict=
for _ in $(seq 1 120); do
  if verdict=$(state_check); then break; fi
  verdict=
  sleep 0.5
done
if [ -n "$verdict" ]; then
  say "state.json $(( $(date +%s) - tap_at )) s after the tap: $verdict"
  container=$(echo "$verdict" | node -e 'process.stdin.on("data",(d)=>console.log(JSON.parse(d).container))')
  selected=$(echo "$verdict" | node -e 'process.stdin.on("data",(d)=>console.log(JSON.parse(d).selected))')
  hits=$(echo "$verdict" | node -e 'process.stdin.on("data",(d)=>console.log(JSON.parse(d).hits))')
  count=$(echo "$verdict" | node -e 'process.stdin.on("data",(d)=>console.log(JSON.parse(d).tabs))')
  pass "the tap opened $url as a tab of the profile"
  if [ "$container" != "private" ]; then pass "the tab is a regular one (container $container)"; else fail "the tab opened in the private container"; fi
  if [ "$selected" = "true" ]; then pass "the tab is the window's active one"; else fail "the tab is not the window's active one"; fi
  if [ "$hits" = 1 ] && [ "$count" = "$((tabs_before + 1))" ]; then pass "exactly one new tab ($tabs_before -> $count)"; else fail "the tab count went $tabs_before -> $count with $hits tab(s) of the URL"; fi
else
  fail "no tab with $url in files/zen/state.json within 60 s of the tap"
fi
sleep 3
adb exec-out screencap -p > "$out/cold-start-02-opened.png" || true

adb shell dumpsys activity activities > "$out/cold-start-activities.txt" 2>&1 || true
if grep -qE "(topResumedActivity|mResumedActivity|ResumedActivity).*$app_id/app.zen.chromium.MainActivity" "$out/cold-start-activities.txt"; then
  pass "MainActivity is the resumed activity after the tap"
else
  fail "MainActivity is not the resumed activity after the tap (cold-start-activities.txt)"
fi
if grep -q "act=app.zen.chromium.WEB_NOTIFICATION" "$out/cold-start-activities.txt"; then
  say "the task's intent is the card's (act=app.zen.chromium.WEB_NOTIFICATION)"
fi
if grep -E "Start proc [0-9]+:$app_id" "$out/logcat-cold-start.txt" | head -n 1 | grep -q .; then
  say "logcat: $(grep -E "Start proc [0-9]+:$app_id" "$out/logcat-cold-start.txt" | head -n 1 | sed -E 's/^[0-9-]+ //')"
fi

adb shell dumpsys notification --noredact > "$out/cold-start-shade-after.txt" 2> /dev/null || true
if card_records "$out/cold-start-shade-after.txt" | grep -q "android.title=String ($title)"; then
  fail "the tapped card is still on the shade (no auto-cancel)"
else
  pass "the tapped card left the shade"
fi

adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
sleep 3
wait "$rec" 2> /dev/null || true
adb pull /sdcard/cold-start.mp4 "$out/services-sync-history-ui-android-cold-start.mp4" > /dev/null 2>&1 || true

say "cold start: $failures finding(s) failed"
echo "--- cold-start-notes.txt"
cat "$notes"
if [ "$failures" -gt 0 ] && [ "$status" -eq 0 ]; then status=1; fi
exit "$status"
