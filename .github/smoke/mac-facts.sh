#!/usr/bin/env bash
# Facts about a Zenium .app bundle on a macOS runner, before or after the smoke ran it: code
# signature and Gatekeeper verdict (an unsealed bundle is "damaged" on Apple Silicon), quarantine
# attributes, Info.plist, crash reports and leftover processes.
#   mac-facts.sh <path/to/Zenium.app> <out-dir> <label>
set -u
APP="$1"
OUT="$2"
LABEL="${3:-facts}"
BINARY="$APP/Contents/MacOS/Zenium"
mkdir -p "$OUT"
TXT="$OUT/$LABEL-facts.txt"
: > "$TXT"

section() { printf '\n### %s\n' "$1" | tee -a "$TXT"; }
run() {
  printf '$ %s\n' "$*" | tee -a "$TXT"
  "$@" 2>&1 | tee -a "$TXT"
  printf '[exit %s]\n' "${PIPESTATUS[0]}" | tee -a "$TXT"
}

section "OS"
run sw_vers
run uname -m
run spctl --status

section "Bundle"
printf 'APP=%s\n' "$APP" | tee -a "$TXT"
run ls -la "$APP/Contents/MacOS"
run du -sh "$APP"
run plutil -p "$APP/Contents/Info.plist"

section "Code signature"
run codesign -dv --verbose=4 "$APP"
run codesign --verify --deep --strict --verbose=2 "$APP"
run codesign -d --entitlements :- "$APP"

section "Gatekeeper assessment"
run spctl --assess --type execute --verbose=4 "$APP"

section "Extended attributes (quarantine)"
run xattr -l "$APP"
run xattr -l "$BINARY"

section "Crash reports (DiagnosticReports)"
ls -lat "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | head -20 | tee -a "$TXT"
for f in "$HOME"/Library/Logs/DiagnosticReports/*[Zz]enium* "$HOME"/Library/Logs/DiagnosticReports/*Electron*; do
  [ -e "$f" ] || continue
  printf -- '--- %s\n' "$f" | tee -a "$TXT"
  head -60 "$f" | tee -a "$TXT"
  cp "$f" "$OUT/" 2>/dev/null || true
done

section "Processes"
ps -axo pid,ppid,rss,%cpu,comm | grep -i '[Z]enium' | tee -a "$TXT"
exit 0
