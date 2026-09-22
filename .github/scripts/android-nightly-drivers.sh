#!/usr/bin/env bash
# The nightly all-drivers sweep's runner (android-nightly-drivers.yml): every driver of one shard of
# `.github/nightly-drivers.json`, in sequence on the one emulator boot, each through its own
# workflow's script (android-gesture-demo.sh with the workflow's environment, or the wrapper the
# workflow names), the device prepared once (DEMO_PREPARED after the first driver, as
# android-sheet-touch-audit.sh chains them). A driver that fails does not stop the ones after it;
# its findings stay. The chain stops only when the emulator itself went away (the shared script's
# emulator-died marker, or adb without a device), and the drivers left are written down as not run.
#
#   bash android-nightly-drivers.sh setup   – on the runner, before the emulator: the setup steps
#                                             the shard's drivers name in the manifest (a server, an
#                                             extension package, the WebView snapshot, ffmpeg)
#   bash android-nightly-drivers.sh         – once the emulator is up: the drivers
#
# Environment: NIGHTLY_SHARD (the shard), NIGHTLY_OUT (where the findings go, one directory per
# driver below it; the recipe uploads it), and whatever the recipe exports (JANK_GATE). What the
# shard leaves at the root of NIGHTLY_OUT: results.jsonl (one JSON line per driver: id, classes,
# result PASS / FAIL / SKIP, seconds, the counts the table shows, the reason), summary.txt (the same
# as a table for the log), shard.json (the shard, when it ran, how long, whether the emulator
# died), emulator-died (copied from the driver it went away under, so the recipe's output says so).
#
# Between two drivers the device is put back to the shard's baseline: the app's data cleared (the
# next driver starts from the fresh install its own workflow gives it; the shared script's
# `adb install -g` grants the permissions again, and any the driver had revoked are granted back
# here too), the recording's parts taken off /sdcard, the font scale, the accessibility services and
# the animation scales as the image boots with them, three-button navigation, the device PIN
# cleared, the display as the shard names it. What a driver needs beyond that is a `needs` word in
# its manifest entry: `pin` (a device PIN before it – its wrapper's own when it has one – cleared
# after), `browser-role` (Chrome enabled and holding the browser role for the choice, both put back
# after), `navigation` (gestural navigation its script sets, three-button put back after).
#
# The shard has a budget (the manifest's budget-minutes, from this script's start): a driver whose
# estimate no longer fits is skipped with that reason, and a driver still running at the end of the
# budget is cut. A driver is also cut at its own timeout (the manifest's `timeout`, 720 s unless
# said), which counts as a failure.
set -uo pipefail

app_id=io.github.benitbuhner.zenium.debug
helper=.github/scripts/android-nightly-drivers.mjs
shard=${NIGHTLY_SHARD:?NIGHTLY_SHARD names the shard}
out=${NIGHTLY_OUT:-artifacts/nightly/$shard}

# --- setup steps (before the emulator) ------------------------------------------------------------

setup_downloads_server() {
  mkdir -p "$out/downloads-demo"
  (setsid nohup node .github/scripts/downloads-demo-server.mjs 18923 > "$out/downloads-demo/server.log" 2>&1 &)
  sleep 2
  curl -sf -o /dev/null http://127.0.0.1:18923/page.html
  curl -sf -o /dev/null -H 'Range: bytes=1048576-' http://127.0.0.1:18923/flaky.bin
  echo "download test server answering on 18923"
}

setup_hardening_server() {
  # The demo's pages and, for the certificate chooser, a demo key pair (password `zenium`, as the
  # driver types it) made here: the repository ships none.
  mkdir -p "$out/services-hardening-demo"
  local dir=artifacts/hardening
  mkdir -p "$dir"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=Zenium demo' \
    -keyout "$dir/key.pem" -out "$dir/cert.pem" > /dev/null 2>&1
  openssl pkcs12 -export -inkey "$dir/key.pem" -in "$dir/cert.pem" -name 'Zenium demo' \
    -passout pass:zenium -out "$dir/client.p12"
  (DEMO_P12=$dir/client.p12 setsid nohup node android/app/src/androidTest/assets/services-hardening-demo-server.mjs \
    > "$out/services-hardening-demo/server.log" 2>&1 &)
  sleep 2
  curl -sf -o /dev/null http://127.0.0.1:8787/popups
  echo "services hardening server answering on 8787"
}

setup_ublock_zip() {
  mkdir -p artifacts/ext
  local tag
  tag=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/gorhill/uBlock/releases/latest)
  tag=${tag##*/}
  echo "uBlock Origin release $tag"
  curl -fsSL -o artifacts/ext/uBlock0.chromium.zip "https://github.com/gorhill/uBlock/releases/download/$tag/uBlock0_$tag.chromium.zip"
  unzip -l artifacts/ext/uBlock0.chromium.zip | tail -n 3
}

setup_ext_crx() {
  echo eimadpbcbfnmbkopoojfekhnkhdbieeh dbepggeogbaibhgnhhndojpepiihcmeb gebbhagfogifgggkldgodflihgfeippi clngdbkpkpeebahjckkjfobafhncgmne ddkjiahejlhfcafbddmgiahcphecmpfh | xargs node .github/scripts/fetch-crx.mjs artifacts/ext
  echo kbfnbcaeplbcioakkpcpgfkobkghlhen oldceeleldhonbafppcapldpdifcinji nngceckbapebfimnlniiiahkandclblb | xargs node .github/scripts/fetch-crx.mjs artifacts/ext-budget
}

setup_webview_snapshot() {
  # As the AOSP demos' workflows fetch it (android-private-demo.yml): the AndroidDesktop_x64
  # snapshot's SystemWebView.apk carries x86_64 native code.
  local base=https://commondatastorage.googleapis.com/chromium-browser-snapshots/AndroidDesktop_x64 rev
  rev=$(curl -fsSL "$base/LAST_CHANGE")
  echo "chromium snapshot revision $rev"
  curl -fsSL -o /tmp/chrome-android-desktop.zip "$base/$rev/chrome-android-desktop.zip"
  mkdir -p artifacts/webview
  unzip -j -o /tmp/chrome-android-desktop.zip chrome-android-desktop/apks/SystemWebView.apk -d artifacts/webview
  rm -f /tmp/chrome-android-desktop.zip
  curl -fsSL "$base/$rev/REVISIONS" > artifacts/webview/REVISIONS.json
  unzip -l artifacts/webview/SystemWebView.apk | grep -E "lib/[^/]+/libwebviewchromium.so"
}

setup_ffmpeg() {
  command -v ffmpeg > /dev/null 2>&1 && return 0
  sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ffmpeg
}

setup_perfetto_python() {
  python3 -m pip install --user -q perfetto
}

if [ "${1:-}" = setup ]; then
  mkdir -p "$out"
  while IFS= read -r step; do
    [ -n "$step" ] || continue
    echo "::group::setup: $step"
    case "$step" in
      downloads-server) setup_downloads_server ;;
      hardening-server) setup_hardening_server ;;
      ublock-zip) setup_ublock_zip ;;
      ext-crx) setup_ext_crx ;;
      webview-snapshot) setup_webview_snapshot ;;
      ffmpeg) setup_ffmpeg ;;
      perfetto-python) setup_perfetto_python ;;
      *) echo "::error::unknown setup step '$step'"; exit 1 ;;
    esac || { echo "::endgroup::"; echo "::error::setup step '$step' failed"; exit 1; }
    echo "::endgroup::"
  done < <(node "$helper" setup-steps "$shard")
  exit 0
fi

# --- the drivers -----------------------------------------------------------------------------------

mkdir -p "$out"
plan=$(mktemp -d)
node "$helper" plan "$shard" "$plan" > /dev/null
# shellcheck disable=SC1091
set -a; . "$plan/shard.env"; set +a
budget_s=${NIGHTLY_BUDGET_S:-4080}
display=${NIGHTLY_DISPLAY:-720x1600@280}
shard_started=$(date +%s)
results=$out/results.jsonl
summary=$out/summary.txt
: > "$results"
: > "$summary"
echo "== $NIGHTLY_TITLE ($shard): budget $((budget_s / 60)) min, display $display"

adb wait-for-device

device_alive() { [ "$(adb get-state 2> /dev/null | tr -d '\r' || true)" = device ]; }

# The shard's baseline between two drivers (see the header).
reset_device() {
  adb shell am force-stop "$app_id" > /dev/null 2>&1 || true
  adb shell pm clear "$app_id" > /dev/null 2>&1 || true
  adb shell rm -f '/sdcard/demo-part-*' > /dev/null 2>&1 || true
  adb shell settings put system font_scale 1.0 > /dev/null 2>&1 || true
  adb shell settings put secure enabled_accessibility_services '""' > /dev/null 2>&1 || true
  adb shell settings put secure accessibility_enabled 0 > /dev/null 2>&1 || true
  for setting in animator_duration_scale transition_animation_scale window_animation_scale; do
    adb shell settings put global "$setting" 1 > /dev/null 2>&1 || true
  done
  adb shell rm -f /data/local/tmp/webview-command-line > /dev/null 2>&1 || true
  adb shell cmd overlay disable com.android.internal.systemui.navbar.gestural > /dev/null 2>&1 || true
  adb shell cmd overlay enable com.android.internal.systemui.navbar.threebutton > /dev/null 2>&1 || true
  adb shell wm size "${display%@*}" > /dev/null 2>&1 || true
  adb shell wm density "${display#*@}" > /dev/null 2>&1 || true
  adb shell input keyevent KEYCODE_WAKEUP > /dev/null 2>&1 || true
  adb shell wm dismiss-keyguard > /dev/null 2>&1 || true
  adb shell am start -W -a android.intent.action.MAIN -c android.intent.category.HOME > /dev/null 2>&1 || true
}

# A short reason for a failed driver, from what its instrumentation printed (the first telling line).
failure_reason() { # dir
  local file
  for file in $(find "$1" -name 'instrument*.txt' 2> /dev/null | sort); do
    grep -m1 -E 'check\(s\) failed|touch\(es\) did not take|REDUCED_MOTION|did not take|Process crashed|INSTRUMENTATION_ABORTED|shortMsg=|Error|Exception|never reached' "$file" 2> /dev/null \
      | sed -E 's/^INSTRUMENTATION_(STATUS|RESULT): (stack|stream|shortMsg)=//' | tr -d '\r' | head -c 300 && return 0
  done
  return 1
}

count_in() { # pattern, files...
  local pattern=$1 n=0 f
  shift
  for f in "$@"; do n=$((n + $(grep -c -- "$pattern" "$f" 2> /dev/null || true))); done
  echo "$n"
}

write_result() { # id, classes, result, seconds, reason, dir
  local id=$1 classes=$2 result=$3 seconds=$4 reason=$5 dir=$6
  local scenes=0 touches=0 faults=0 shots=0 videos=0
  if [ -d "$dir" ]; then
    mapfile -t logs < <(find "$dir" -name 'logcat*.txt' 2> /dev/null)
    mapfile -t frames < <(find "$dir" -name 'frames.jsonl' 2> /dev/null)
    [ "${#frames[@]}" -gt 0 ] && scenes=$(count_in '"scene"' "${frames[@]}")
    if [ "${#logs[@]}" -gt 0 ]; then
      touches=$(count_in "the touch on '" "${logs[@]}")
      faults=$(count_in 'TOUCH FAULT' "${logs[@]}")
    fi
    shots=$(find "$dir" \( -name '*.png' -o -name '*.jpg' \) 2> /dev/null | wc -l | tr -d ' ')
    videos=$(find "$dir" -name '*.mp4' 2> /dev/null | wc -l | tr -d ' ')
  fi
  jq -cn --arg id "$id" --arg classes "$classes" --arg shard "$shard" --arg result "$result" \
    --argjson seconds "$seconds" --arg reason "$reason" --argjson scenes "$scenes" --argjson touches "$touches" \
    --argjson touchFaults "$faults" --argjson shots "$shots" --argjson videos "$videos" \
    '{id: $id, classes: ($classes | split(",")), shard: $shard, result: $result, seconds: $seconds, reason: $reason,
      scenes: $scenes, touches: $touches, touchFaults: $touchFaults, shots: $shots, videos: $videos}' >> "$results"
  printf '%-22s %-4s %5ss  %s\n' "$id" "$result" "$seconds" "$reason" | tee -a "$summary"
}

read_env_file() { # file: exports its NAME=value lines
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    export "${line?}"
  done < "$1"
}

failed=0
prepared=0
died=0
for env_file in "$plan"/[0-9]*.env; do
  # Each driver in its own environment: what one exports must not reach the next.
  (
    read_env_file "$env_file"
    id=$NIGHTLY_ID
    dir=$out/$id
    mkdir -p "$dir"
    export DEMO_OUT=$dir DEMO_PREPARED=$prepared
    elapsed=$(( $(date +%s) - shard_started ))
    remaining=$(( budget_s - elapsed ))
    if [ "$died" -eq 1 ]; then
      write_result "$id" "$NIGHTLY_CLASSES" SKIP 0 "the emulator went away earlier on this shard" "$dir"
      exit 0
    fi
    if [ "$remaining" -lt "$NIGHTLY_ESTIMATE_S" ] || [ "$remaining" -lt 60 ]; then
      write_result "$id" "$NIGHTLY_CLASSES" SKIP 0 "shard budget: $((remaining / 60)) min left, the driver takes about $((NIGHTLY_ESTIMATE_S / 60)) min" "$dir"
      exit 0
    fi
    cap=$NIGHTLY_TIMEOUT
    [ "$cap" -gt "$remaining" ] && cap=$remaining

    echo "::group::$id ($NIGHTLY_CLASSES; mirrors $NIGHTLY_MIRRORS; up to $((cap / 60)) min)"
    # Before: the state the driver needs (see the header).
    browser_role_before=
    for need in $NIGHTLY_NEEDS; do
      case "$need" in
        pin)
          # A wrapper sets the PIN itself; the shared script does not.
          if [ "$NIGHTLY_SCRIPT" = .github/scripts/android-gesture-demo.sh ]; then
            adb shell locksettings set-pin 1234 || true
            adb shell input keyevent KEYCODE_WAKEUP || true
            adb shell wm dismiss-keyguard || true
          fi
          ;;
        browser-role)
          browser_role_before=$(adb shell cmd role get-role-holders --user 0 android.app.role.BROWSER 2> /dev/null | tr -d '\r' || true)
          ;;
      esac
    done
    [ -n "$NIGHTLY_RELOCATE" ] && rm -rf "$NIGHTLY_RELOCATE"

    started=$(date +%s)
    timeout -k 30 "$cap" bash "$NIGHTLY_SCRIPT"
    status=$?
    took=$(( $(date +%s) - started ))
    echo "::endgroup::"

    # A script with a fixed output path: its findings into the driver's directory.
    if [ -n "$NIGHTLY_RELOCATE" ] && [ -d "$NIGHTLY_RELOCATE" ]; then
      cp -a "$NIGHTLY_RELOCATE/." "$dir/" && rm -rf "$NIGHTLY_RELOCATE"
    fi
    # The device-side instrumentation outlives a cut client: stop it before the next driver.
    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      adb shell am force-stop "$app_id" > /dev/null 2>&1 || true
      adb shell pkill -INT screenrecord > /dev/null 2>&1 || true
    fi

    if [ -f "$dir/emulator-died" ] || ! device_alive; then
      [ -f "$dir/emulator-died" ] || echo "adb lost the device after the driver" > "$dir/emulator-died"
      cp "$dir/emulator-died" "$out/emulator-died"
      write_result "$id" "$NIGHTLY_CLASSES" FAIL "$took" "the emulator went away under the driver" "$dir"
      echo "::error::$id: the emulator went away; the drivers after it on this shard are not run"
      exit 3
    fi
    if [ "$status" -eq 0 ]; then
      write_result "$id" "$NIGHTLY_CLASSES" PASS "$took" "" "$dir"
    elif [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
      write_result "$id" "$NIGHTLY_CLASSES" FAIL "$took" "cut after $took s (the driver's cap is $cap s)" "$dir"
      echo "::error::$id did not finish within $cap s"
    else
      reason=$(failure_reason "$dir" || true)
      write_result "$id" "$NIGHTLY_CLASSES" FAIL "$took" "${reason:-exit status $status, see $shard/$id/}" "$dir"
      echo "::error::$id did not pass: ${reason:-exit status $status}"
    fi

    # After: the state back, then the baseline.
    for need in $NIGHTLY_NEEDS; do
      case "$need" in
        pin) adb shell locksettings clear --old 1234 > /dev/null 2>&1 || true ;;
        browser-role)
          adb shell pm disable-user --user 0 com.android.chrome > /dev/null 2>&1 || true
          if [ -n "$browser_role_before" ]; then
            adb shell cmd role add-role-holder --user 0 android.app.role.BROWSER "$browser_role_before" > /dev/null 2>&1 || true
          else
            adb shell cmd role clear-role-holders --user 0 android.app.role.BROWSER > /dev/null 2>&1 || true
          fi
          ;;
        navigation) adb shell settings delete global enable_back_animation > /dev/null 2>&1 || true ;;
      esac
    done
    for permission in ${DEMO_REVOKE:-}; do
      adb shell pm grant "$app_id" "$permission" > /dev/null 2>&1 || true
    done
    reset_device
    [ "$status" -eq 0 ] && exit 0
    exit 1
  )
  case $? in
    0) ;;
    3) failed=1; died=1 ;;
    *) failed=1 ;;
  esac
  prepared=1
done

shard_seconds=$(( $(date +%s) - shard_started ))
jq -cn --arg shard "$shard" --arg title "${NIGHTLY_TITLE:-$shard}" --argjson seconds "$shard_seconds" \
  --argjson died "$died" --arg sha "${GITHUB_SHA:-}" --arg run "${GITHUB_RUN_ID:-}" \
  '{shard: $shard, title: $title, seconds: $seconds, emulatorDied: ($died == 1), sha: $sha, run: $run}' > "$out/shard.json"
echo "== $shard: the drivers on this boot ($((shard_seconds / 60)) min)"
cat "$summary"
rm -rf "$plan"
exit "$failed"
