#!/usr/bin/env bash
# Runs on the workflow runner once the emulator has booted: installs the debug APK and a demo
# driver (an instrumentation class such as GestureDemo), records the screen while the driver
# performs its sequence, and collects the recording, the screenshots and the logs under the
# artifacts directory.
#
# Which demo runs is chosen through the environment (defaults are the URL-pill gesture demo):
#   DEMO_CLASS  – instrumentation class to run
#   DEMO_DIR    – handshake directory under the app's files/
#   DEMO_OUT    – where the artifacts go
#   DEMO_VIDEO  – file name of the recording
#   DEMO_THEME  – colour scheme a driver seeds its profile with (`light` or `dark`), passed to
#                 the instrumentation as the `theme` argument; drivers without a theme ignore it
#   DEMO_KEEP   – bundled packages (space separated) to leave enabled; the rest of the Google
#                 apps are disabled so they do not compete with the browser for the emulator
#   DEMO_PREPARED – `1` when the device was prepared by an earlier run of this script on the same
#                 boot (android-sheet-touch-audit.sh chains several drivers): the display, the
#                 navigation mode, the bundled apps and the settling pause are then skipped
#
# Handshake with the driver, through files in the app's private storage (readable via run-as):
#   files/<DEMO_DIR>/record     – written by the driver once its warm-up is done
#   files/<DEMO_DIR>/recording  – written here once screenrecord is rolling
#   files/<DEMO_DIR>/done       – written by the driver when the sequence is over
set -euo pipefail

# applicationId of the debug build (android/app/build.gradle.kts); the instrumentation APK is
# "<applicationId>.test" and the driver classes keep the Kotlin package app.zen.chromium.
app_id=io.github.benitbuhner.zenium.debug
runner=io.github.benitbuhner.zenium.debug.test/androidx.test.runner.AndroidJUnitRunner
demo_class=${DEMO_CLASS:-app.zen.chromium.GestureDemo}
demo_dir=${DEMO_DIR:-gesture-demo}
out=${DEMO_OUT:-artifacts/android-gesture-demo}
video=${DEMO_VIDEO:-android-gestures-device-demo.mp4}
mkdir -p "$out"

# The hosted runners' nested emulator dies silently now and then, a minute or two into a demo
# (every guest process stops logging at once, adb reports the device offline, the qemu process
# exits a minute later with nothing in the host kernel log; seen across programs' demos). A
# marker tells such a death from a driver failure, so the workflow can boot once more for the
# former and never for the latter.
#
# The death has a shape: the emulator process first hangs (no CPU, no output; adb no longer
# answers, the guest's own logging stops), then goes away without a word some forty seconds
# later. A crash inside it would look just like that – Crashpad writes a minidump and re-raises
# the signal, and a background job of a non-interactive shell dies silently – so the hang is
# caught while it lasts (every thread's state and kernel stack, gdb's user-space stacks where the
# runner has gdb) and the crash-dump directory and the host kernel's log are read after the
# process is gone. All of it lands in the artifact next to the host monitor.
dump_dir=$HOME/.android/breakpad
emulator_pid() { pgrep -f qemu-system-x86_64 | head -n 1; }

dump_emulator_stacks() {
  pid=$(emulator_pid)
  [ -n "$pid" ] || return 0
  [ -f "$out/qemu-threads.txt" ] && return 0
  {
    date +%T
    sudo cat "/proc/$pid/status" 2> /dev/null | grep -E '^(State|Threads|VmRSS|VmSwap):' || true
    for task in "/proc/$pid"/task/*; do
      tid=$(basename "$task")
      printf '%s %-24s %s %s\n' "$tid" "$(sudo cat "$task/comm" 2> /dev/null)" \
        "$(sudo cut -d' ' -f3 "$task/stat" 2> /dev/null)" "$(sudo cat "$task/wchan" 2> /dev/null)"
      sudo cat "$task/stack" 2> /dev/null | sed 's/^/    /' || true
    done
  } > "$out/qemu-threads.txt" 2>&1 || true
  if command -v gdb > /dev/null; then
    sudo gdb -p "$pid" -batch -ex 'set pagination off' -ex 'thread apply all bt 30' \
      > "$out/qemu-stacks.txt" 2>&1 || true
  fi
}

note_emulator_death() {
  if [ "$(adb get-state 2> /dev/null || true)" != "device" ]; then
    echo "adb lost the device before the driver was done" > "$out/emulator-died"
    dump_emulator_stacks
    # Give the process the minute it takes to go, so the log and the dumps are of the death.
    for _ in $(seq 1 60); do
      [ -n "$(emulator_pid)" ] || break
      sleep 1
    done
    {
      echo "== $(date +%T) emulator process: $(emulator_pid || true)"
      echo "== host kernel log"
      sudo dmesg 2> /dev/null | tail -n 60 || true
      echo "== crash dumps under $dump_dir"
      ls -laR "$dump_dir" 2>&1 || true
    } >> "$out/emulator-died"
    find "$dump_dir" -name '*.dmp' -exec cp {} "$out/" \; 2> /dev/null || true
  fi
}
trap note_emulator_death EXIT

adb wait-for-device
nproc
free -m
df -h / /tmp

# Host watchdog: memory and the emulator's CPU seconds every few seconds, a thread dump the
# second time in a row adb gets no answer from a living emulator (the hang above, caught while
# it lasts), and the kernel log the moment the emulator process disappears (a silent death is
# most likely the OOM killer or a renderer crash).
(
  stalls=0
  while true; do
    {
      date +%T
      free -m | sed -n '2p'
      ps -o pid=,rss=,pcpu=,cputimes=,comm= -C qemu-system-x86_64 || true
    } >> "$out/host-monitor.txt"
    if ! pgrep -f qemu-system-x86_64 > /dev/null; then
      {
        echo "EMULATOR PROCESS GONE"
        sudo dmesg 2> /dev/null | tail -n 80 || true
        ls -laR /tmp/android-runner 2>&1 || true
      } >> "$out/host-monitor.txt"
      break
    fi
    if timeout 4 adb shell true > /dev/null 2>&1; then
      stalls=0
    else
      stalls=$((stalls + 1))
      echo "adb got no answer from the emulator ($stalls in a row)" >> "$out/host-monitor.txt"
      [ "$stalls" -ge 2 ] && dump_emulator_stacks
    fi
    sleep 5
  done
) &
monitor_pid=$!

if [ "${DEMO_PREPARED:-0}" != 1 ]; then
# The same 411 CSS px wide layout a Pixel 6 gets, at 2.3x fewer pixels: the emulator renders,
# snapshots and records through a software GPU, and every pixel costs.
adb shell wm size 720x1600
adb shell wm density 280
# No "isn't responding" dialogs over the browser (the launcher re-inflating at the new density
# is slow enough to trigger one); restart it cleanly instead.
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

# The Google APIs image spends its first minutes starting every bundled Google app; none of them
# are needed and they fight the browser for the emulator's CPU and memory.
for pkg in \
  com.google.android.youtube com.google.android.apps.youtube.music com.google.android.gm \
  com.google.android.apps.messaging com.android.chrome com.google.android.apps.maps \
  com.google.android.videos com.google.android.apps.photos com.google.android.googlequicksearchbox \
  com.google.android.calendar com.google.android.apps.docs com.google.android.apps.wellbeing \
  com.google.android.projection.gearhead com.google.android.apps.tachyon com.google.android.talk \
  com.google.android.music com.google.android.apps.podcasts com.google.android.apps.nbu.files; do
  case " ${DEMO_KEEP:-} " in *" $pkg "*) continue ;; esac
  adb shell pm disable-user --user 0 "$pkg" > /dev/null 2>&1 || true
done
adb shell am kill-all || true
echo "letting the system settle"
sleep 45
free -m
fi

apk=$(find android/app/build/outputs/apk/debug -name '*.apk' -print -quit)
test_apk=$(find android/app/build/outputs/apk/androidTest/debug -name '*.apk' -print -quit)
echo "app: $apk"
echo "driver: $test_apk"
adb install -r -g "$apk"
adb install -r -g "$test_apk"

adb logcat -c || true
adb logcat -v time > "$out/logcat.txt" &
logcat_pid=$!

adb shell am instrument -w -e class "$demo_class" -e theme "${DEMO_THEME:-light}" "$runner" > "$out/instrument.txt" 2>&1 &
driver_pid=$!

ready=0
for _ in $(seq 1 1200); do
  if adb shell run-as "$app_id" test -f "files/$demo_dir/record" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$driver_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "::error::the gesture driver never reached the recording handshake"
  cat "$out/instrument.txt" || true
  sleep 6
  kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true
  cat "$out/host-monitor.txt" || true
  exit 1
fi

# screenrecord stops itself after three minutes: record in parts of 170 s until the driver says
# it is done (it stays alive a little longer so the app is still on screen) or dies, and join
# the parts afterwards. A demo within one part gets its one file, as before.
(
  part=0
  while [ "$part" -lt 5 ]; do
    if adb shell run-as "$app_id" test -f "files/$demo_dir/done" 2>/dev/null; then break; fi
    if ! kill -0 "$driver_pid" 2>/dev/null; then break; fi
    part=$((part + 1))
    adb shell screenrecord --bit-rate 8000000 --time-limit 170 "/sdcard/demo-part-$part.mp4" &
    rec=$!
    if [ "$part" -eq 1 ]; then
      sleep 1
      adb shell run-as "$app_id" touch "files/$demo_dir/recording"
    fi
    while kill -0 "$rec" 2>/dev/null; do
      if adb shell run-as "$app_id" test -f "files/$demo_dir/done" 2>/dev/null || ! kill -0 "$driver_pid" 2>/dev/null; then
        adb shell pkill -INT screenrecord || adb shell "kill -2 \$(pidof screenrecord)" || true
        sleep 2
        break
      fi
      sleep 0.5
    done
    wait "$rec" || true
  done
) &
recorder_pid=$!

wait "$recorder_pid" || true
wait "$driver_pid" || true
sleep 2
kill "$logcat_pid" "$monitor_pid" 2> /dev/null || true

parts=()
for name in $(adb shell ls /sdcard/ 2>/dev/null | tr -d '\r' | grep '^demo-part-' | sort -V); do
  adb pull "/sdcard/$name" "$out/$name"
  parts+=("$out/$name")
done
if [ "${#parts[@]}" -eq 1 ]; then
  mv "${parts[0]}" "$out/$video"
elif [ "${#parts[@]}" -gt 1 ]; then
  # The runner image has no ffmpeg; a recording in parts is the one thing here that needs it.
  if ! command -v ffmpeg > /dev/null 2>&1 && command -v apt-get > /dev/null 2>&1; then
    sudo -n apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null 2>&1 \
      || { sudo -n apt-get update -qq > /dev/null 2>&1 && sudo -n apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null 2>&1; } \
      || true
  fi
  : > "$out/parts.txt"
  for p in "${parts[@]}"; do echo "file '$(realpath "$p")'" >> "$out/parts.txt"; done
  if command -v ffmpeg > /dev/null 2>&1 && ffmpeg -loglevel error -f concat -safe 0 -i "$out/parts.txt" -c copy "$out/$video"; then
    rm -f "${parts[@]}" "$out/parts.txt"
  else
    echo "::warning::the recording's parts could not be joined; they are in the artifact as they are"
  fi
fi
# Screenshots, and whatever else a driver writes down next to them (an accessibility tree dump).
for name in $(adb shell run-as "$app_id" ls "files/$demo_dir" | tr -d '\r'); do
  case "$name" in
    *.png | *.jpg | *.txt) adb exec-out run-as "$app_id" cat "files/$demo_dir/$name" > "$out/$name" ;;
  esac
done

cat "$out/instrument.txt"
ls -la "$out"
grep -q '^OK (' "$out/instrument.txt"
