#!/usr/bin/env bash
# Facts about a Zenium .app bundle on a macOS runner, before or after the smoke ran it: code
# signature and Gatekeeper verdict (an unsealed bundle is "damaged" on Apple Silicon), quarantine
# attributes, Info.plist, the URL schemes the bundle claims, LaunchServices' handlers for http and
# https (who the default web browser is; the default-browser scenario's request shows up here
# only once a user has said yes to the OS's dialog), crash reports and leftover processes; after
# the run, the unified log's LaunchServices lines about the request, bounded.
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

section "URL schemes the bundle claims (CFBundleURLTypes: electron-builder's protocols)"
run plutil -extract CFBundleURLTypes json -o - "$APP/Contents/Info.plist"

section "LaunchServices handlers for http and https (LSHandlers; no entry = the system default, Safari)"
# `defaults export` reads through cfprefsd (the file on disk may lag). The whole array goes to
# $LABEL-lshandlers.json; the web schemes' entries are what the text keeps.
LS_JSON="$OUT/$LABEL-lshandlers.json"
LS_ERR="$OUT/$LABEL-lshandlers.err"
printf '$ defaults export com.apple.LaunchServices/com.apple.launchservices.secure - | plutil -convert json -r -o - -\n' | tee -a "$TXT"
if defaults export com.apple.LaunchServices/com.apple.launchservices.secure - 2>"$LS_ERR" | plutil -convert json -r -o - - >"$LS_JSON" 2>>"$LS_ERR"; then
  printf 'written to %s (%s bytes)\n' "$LS_JSON" "$(wc -c <"$LS_JSON" | tr -d ' ')" | tee -a "$TXT"
  # The web schemes' entries with their neighbours (the pretty JSON puts one key per line).
  grep -B4 -A4 -iE '"LSHandlerURLScheme" *: *"https?"' "$LS_JSON" | tee -a "$TXT"
  printf '[web handlers above; none = Safari holds them]\n' | tee -a "$TXT"
else
  printf '[failed: %s]\n' "$(head -c 400 "$LS_ERR")" | tee -a "$TXT"
fi

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

if [ "$LABEL" = "after-run" ]; then
  # LaunchServices' own record of the bundle (name, displayName, identifier, the claimed
  # schemes): what the OS's dialog names the app from. `lsregister -dump` prints the whole
  # database, so only the first records naming the id are kept, and perl's alarm survives the
  # exec and ends the pipeline after 120 s.
  section "LaunchServices' record of the bundle (lsregister -dump, first records naming the id, 120 s bound)"
  LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  run perl -e 'alarm 120; exec @ARGV' -- sh -c "$LSREGISTER -dump 2>&1 | grep -m 3 -B12 -A40 'identifier: *io.github.benitbuhner.zenium'"
  # What LaunchServices and the prompt's agent logged about the default-browser request (the
  # smoke's default-browser scenario ran within the last minutes). `log show` can take long on a
  # runner: perl's alarm survives the exec and ends it after 120 s; whatever it printed by then
  # stays in the text.
  section "Unified log: LaunchServices and CoreServicesUIAgent on the default-browser request (last 15 min, 120 s bound)"
  run perl -e 'alarm 120; exec @ARGV' -- log show --last 15m --style compact \
    --predicate '(process == "lsd" OR process == "CoreServicesUIAgent" OR process == "launchservicesd" OR subsystem == "com.apple.launchservices") AND (eventMessage CONTAINS[c] "zenium" OR eventMessage CONTAINS[c] "default handler" OR eventMessage CONTAINS[c] "LSSetDefaultHandler" OR eventMessage CONTAINS[c] "default web browser" OR eventMessage CONTAINS[c] "io.github.benitbuhner")'
fi
exit 0
