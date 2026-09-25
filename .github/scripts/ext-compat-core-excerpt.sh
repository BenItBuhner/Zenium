#!/usr/bin/env bash
# The crashing thread's stack out of a `coredumpctl info` text, for the emulator-death file.
#
# android-ext-compat-sweep.sh's note_emulator_death writes `coredumpctl -1 info <pid>` into
# host-emulator-core-info.txt whenever a qemu core is listed (ec4004a0f, every lane), and the
# death file wants the part of it a reader needs first: the dump's account (pid, signal, time,
# executable, storage) and the FIRST trace systemd wrote – the crashing thread's – whole. The
# journal's tail used to stand there and cut it (compat round 18's AFTER 113 death: six idle
# render threads' traces, not the faulting one's), and a fixed head of the info text cuts a deep
# trace the same way (systemd unwinds up to 64 frames per thread). So: from the `Message:` line
# to the end of the first `Stack trace of thread` block, the module lines between dropped, the
# other threads left to the file (their count said), each line cut at 300 columns.
#
#   bash .github/scripts/ext-compat-core-excerpt.sh <host-emulator-core-info.txt>
#
# Never fails: the death path runs under pipefail and a failing command there would end the
# driver before `collect`.
set -u
info=${1:-}
if [ -z "$info" ] || [ ! -s "$info" ]; then
  echo "(no coredumpctl info text${info:+ at $info})"
  exit 0
fi
grep -E '^ *(PID|Signal|Timestamp|Executable|Storage|Size on Disk):' "$info" 2> /dev/null | cut -c1-300 || true
threads=$(grep -c 'Stack trace of thread' "$info" 2> /dev/null || true)
name=$(basename "$info")
case "${threads:-0}" in
  0) echo "-- no thread's trace in $name (systemd wrote the message alone)" ;;
  1) echo "-- one thread's trace in $name:" ;;
  *) echo "-- $threads threads' traces in $name; the first, the crashing thread's:" ;;
esac
awk '
  /^ *Message:/ { on = 1 }
  !on { next }
  /^ *(Found module|Module) / { next }
  /^ *Stack trace of thread/ { if (++threads == 2) exit }
  { print }
' "$info" 2> /dev/null | head -n 90 | sed '${/^ *$/d;}' | cut -c1-300 || true
exit 0
