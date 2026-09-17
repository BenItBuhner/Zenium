#!/usr/bin/env bash
# Mount a Zenium DMG, copy the app out, unmount, and record what a user would see when opening it:
# `open -a` on the curl-downloaded copy (no quarantine flag) and on a copy carrying the quarantine
# flag Safari/Finder downloads get (this is the Gatekeeper path Bennett-like testers hit).
#   mac-dmg.sh <file.dmg> <dest-dir> <out-dir>
set -u
DMG="$1"
DEST="$2"
OUT="$3"
mkdir -p "$DEST" "$OUT"
TXT="$OUT/dmg-facts.txt"
: > "$TXT"
log() { printf '%s\n' "$*" | tee -a "$TXT"; }

log "DMG: $DMG ($(du -h "$DMG" | cut -f1))"
log "xattr on dmg: $(xattr -l "$DMG" 2>&1 | tr '\n' ' ')"
MOUNT_OUT="$(hdiutil attach -nobrowse -readonly -noautoopen "$DMG" 2>&1)"
log "$MOUNT_OUT"
MOUNT="$(printf '%s\n' "$MOUNT_OUT" | grep -o '/Volumes/.*' | tail -1)"
if [ -z "$MOUNT" ]; then
  log "mount failed"
  exit 1
fi
log "mounted at: $MOUNT"
ls -la "$MOUNT" | tee -a "$TXT"
APP_IN_DMG="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"
log "app in dmg: $APP_IN_DMG"
if [ -n "$APP_IN_DMG" ]; then
  # Finder shows the DMG window with the app and an Applications alias; record the layout files.
  ls -la "$MOUNT/.background" 2>/dev/null | tee -a "$TXT"
  [ -e "$MOUNT/.DS_Store" ] && log "has .DS_Store (custom window layout)"
  [ -L "$MOUNT/Applications" ] && log "has Applications symlink -> $(readlink "$MOUNT/Applications")"
  cp -R "$APP_IN_DMG" "$DEST/"
  APP="$DEST/$(basename "$APP_IN_DMG")"
  log "copied to: $APP"
fi
hdiutil detach "$MOUNT" -force 2>&1 | tee -a "$TXT"

if [ -n "${APP:-}" ]; then
  log ""
  log "### open -a on the copy without quarantine (curl / gh download path)"
  open -a "$APP" 2>&1 | tee -a "$TXT"
  log "open exit: ${PIPESTATUS[0]}"
  sleep 8
  ps -axo pid,comm | grep -i '[Z]en' | tee -a "$TXT"
  screencapture -x "$OUT/dmg-open-a-no-quarantine.png" 2>&1 | tee -a "$TXT"
  osascript -e 'with timeout of 10 seconds' -e 'tell application "Zen" to quit' -e 'end timeout' >/dev/null 2>&1 || true
  sleep 2
  pkill -9 -f "$APP/Contents/MacOS/Zen" 2>/dev/null || true

  log ""
  log "### open -a on a copy WITH the quarantine flag (Safari/Finder download path)"
  Q="$DEST/quarantined"
  rm -rf "$Q"
  mkdir -p "$Q"
  cp -R "$APP" "$Q/"
  QAPP="$Q/$(basename "$APP")"
  xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$QAPP"
  log "xattr: $(xattr -l "$QAPP" 2>&1 | tr '\n' ' ')"
  spctl --assess --type execute --verbose=4 "$QAPP" 2>&1 | tee -a "$TXT"
  open -a "$QAPP" 2>&1 | tee -a "$TXT"
  log "open exit: ${PIPESTATUS[0]}"
  sleep 8
  ps -axo pid,comm | grep -i '[Z]en' | tee -a "$TXT"
  screencapture -x "$OUT/dmg-open-a-quarantined.png" 2>&1 | tee -a "$TXT"
  pkill -9 -f "$QAPP/Contents/MacOS/Zen" 2>/dev/null || true
  printf '%s\n' "$APP" > "$OUT/dmg-app-path.txt"
fi
exit 0
