#!/usr/bin/env bash
# macOS facts for a Zenium .app bundle: code signature, Gatekeeper verdict, quarantine, Info.plist,
# Launch Services registration, user defaults, crash logs, OS and display facts.
#   mac-facts.sh <path/to/Zen.app> <out-dir> <label>
set -u
APP="$1"
OUT="$2"
LABEL="${3:-facts}"
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
run id -un
printf 'HOME=%s\n' "$HOME" | tee -a "$TXT"
run spctl --status
run csrutil status

section "Display"
system_profiler SPDisplaysDataType 2>/dev/null | sed -n '1,40p' | tee -a "$TXT"

section "Bundle"
printf 'APP=%s\n' "$APP" | tee -a "$TXT"
run ls -la "$APP/Contents"
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
run xattr -l "$APP/Contents/MacOS/Zen"

section "Launch Services registration"
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$LSREG" ]; then
  "$LSREG" -dump 2>/dev/null | grep -i -A3 'app.zen-browser.chromium\|zenium' | head -60 | tee -a "$TXT"
fi

section "User defaults"
run defaults read app.zen-browser.chromium
run defaults read -g AppleInterfaceStyle

section "Application Support / Logs"
run ls -la "$HOME/Library/Application Support/Zen"
run ls -la "$HOME/Library/Logs/Zen"
run ls -la "$HOME/Library/Preferences" | grep -i zen

section "Crash logs (DiagnosticReports)"
ls -lat "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | head -20 | tee -a "$TXT"
for f in "$HOME"/Library/Logs/DiagnosticReports/*[Zz]en*; do
  [ -e "$f" ] || continue
  printf -- '--- %s\n' "$f" | tee -a "$TXT"
  head -60 "$f" | tee -a "$TXT"
  cp "$f" "$OUT/" 2>/dev/null || true
done

section "Notification center registration"
run sqlite3 "$(getconf DARWIN_USER_DIR)com.apple.notificationcenter/db2/db" "select app_id from app;"

section "Processes"
ps -axo pid,ppid,rss,%cpu,comm | grep -i '[Z]en' | tee -a "$TXT"
exit 0
