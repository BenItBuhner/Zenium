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
  # Written before the launch experiments so the downstream smoke still finds the copy if one of
  # them hangs (Gatekeeper's modal keeps `open` from returning).
  printf '%s\n' "$APP" > "$OUT/dmg-app-path.txt"
fi
hdiutil detach "$MOUNT" -force 2>&1 | tee -a "$TXT"

# Read every window of the given processes through UI scripting: title, static texts, buttons.
dialog_facts() {
  osascript - "$@" <<'EOS' 2>&1
on run argv
  with timeout of 20 seconds
    set out to {}
    tell application "System Events"
      repeat with pname in argv
        try
          repeat with w in (windows of process pname)
            set end of out to ("[" & pname & "] window: '" & (name of w as text) & "' role " & (role description of w as text) & " subrole " & (subrole of w as text))
            try
              repeat with t in (static texts of w)
                set end of out to ("  text: " & (value of t as text))
              end repeat
            end try
            try
              repeat with b in (buttons of w)
                set end of out to ("  button: " & (name of b as text))
              end repeat
            end try
            try
              repeat with e in (entire contents of w)
                try
                  if class of e is static text then set end of out to ("  text(deep): " & (value of e as text))
                  if class of e is button then set end of out to ("  button(deep): " & (name of e as text))
                  if class of e is progress indicator then set end of out to ("  progress indicator")
                end try
              end repeat
            on error errMsg
              set end of out to ("  entire contents failed: " & errMsg)
            end try
          end repeat
        on error errMsg
          set end of out to ("[" & pname & "] windows failed: " & errMsg)
        end try
      end repeat
    end tell
    set AppleScript's text item delimiters to linefeed
    return out as text
  end timeout
end run
EOS
}

# Click the first matching button in any window of the given process, Escape as the fallback.
dismiss_dialog() {
  local proc="$1"; shift
  osascript - "$proc" "$@" <<'EOS' 2>&1
on run argv
  with timeout of 20 seconds
    set pname to item 1 of argv
    tell application "System Events"
      repeat with i from 2 to count of argv
        set wanted to item i of argv
        try
          repeat with w in (windows of process pname)
            try
              repeat with b in (buttons of w)
                if (name of b as text) is wanted then
                  click b
                  return "clicked " & wanted
                end if
              end repeat
            end try
            repeat with e in (entire contents of w)
              try
                if class of e is button and (name of e as text) is wanted then
                  click e
                  return "clicked " & wanted & " (deep)"
                end if
              end try
            end repeat
          end repeat
        end try
      end repeat
      try
        set frontmost of process pname to true
        key code 53
        return "sent Escape"
      end try
    end tell
    return "nothing to dismiss"
  end timeout
end run
EOS
}

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
  # Gatekeeper answers with a modal that keeps `open` from returning: run it in the background,
  # photograph the "Verifying" progress window, wait (up to 60 s) for the verdict dialog to
  # replace it, read its text and buttons, then dismiss it without choosing "Move to Trash".
  ( open -a "$QAPP" >>"$TXT" 2>&1; log "open exit (quarantined copy): $?" ) &
  OPEN_PID=$!
  sleep 6
  ps -axo pid,args | grep -i '[Z]en.app/Contents/MacOS' | tee -a "$TXT"
  screencapture -x "$OUT/dmg-open-a-quarantined.png" 2>&1 | tee -a "$TXT"
  log "--- Gatekeeper dialog after 6 s (UI scripting)"
  FACTS="$(dialog_facts CoreServicesUIAgent Finder Zen)"
  printf '%s\n' "$FACTS" | tee -a "$TXT"
  WAITED=6
  while [ "$WAITED" -lt 60 ]; do
    case "$FACTS" in
      *button:*) break ;;
    esac
    sleep 3
    WAITED=$((WAITED + 3))
    FACTS="$(dialog_facts CoreServicesUIAgent Finder Zen)"
  done
  log "--- Gatekeeper dialog after ${WAITED} s (UI scripting)"
  printf '%s\n' "$FACTS" | tee -a "$TXT"
  screencapture -x "$OUT/dmg-open-a-quarantined-verdict.png" 2>&1 | tee -a "$TXT"
  ps -axo pid,args | grep -i '[Z]en.app/Contents/MacOS' | tee -a "$TXT"
  log "--- dismiss: $(dismiss_dialog CoreServicesUIAgent Done OK Cancel)"
  sleep 3
  screencapture -x "$OUT/dmg-open-a-quarantined-after-dismiss.png" 2>&1 | tee -a "$TXT"
  log "quarantined copy processes after dismiss: $(ps -axo pid,args | grep -i '[Z]en.app/Contents/MacOS' | tr '\n' ' ')"
  # A translocated launch runs from /private/var/folders/.../AppTranslocation/<uuid>/d/Zen.app.
  osascript -e 'with timeout of 10 seconds' -e 'tell application "Zen" to quit' -e 'end timeout' >/dev/null 2>&1 || true
  sleep 2
  kill "$OPEN_PID" 2>/dev/null || true
  pkill -f "open -a $QAPP" 2>/dev/null || true
  pkill -9 -f "$QAPP/Contents/MacOS/Zen" 2>/dev/null || true
  pkill -9 -f "AppTranslocation/.*/Zen.app/Contents/MacOS/Zen" 2>/dev/null || true
  log "processes after cleanup: $(ps -axo pid,args | grep -i '[Z]en.app/Contents/MacOS' | tr '\n' ' ')"
fi
exit 0
