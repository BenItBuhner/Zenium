#!/usr/bin/env bash
# TEMPORARY (removed before the PR is marked ready). The before/after stills of the status-bar
# fix under the condition the release bisect (run 35547672129) reproduced seven times in seven:
# a cold process start of a profile whose first session has seeded the Safe Browsing feed
# documents (deferred boot documents) and whose parsed snapshot (`safebrowsing/tables.bin`) is
# not there, so the host parses the feeds at boot while the chrome fetches them. Each APK in
# APKS (`<label>=<path or directory>=<applicationId>`, space separated) is installed in turn; for every dock and scheme the
# profile is seeded through root (its active tab Settings > Updates, Bennett's page), the
# snapshot removed, the app started cold and a full frame taken as <label>-<scheme>-<dock>.png under
# artifacts/android-status-bar-stills/.
set -euo pipefail

apks=${APKS:?APKS is required}
out=${STILLS_OUT:-artifacts/android-status-bar-stills}
settle=${LAUNCH_SETTLE_SECONDS:-16}
mkdir -p "$out"

adb wait-for-device
if adb root 2>&1 | grep -qi "cannot run as root"; then
  echo "::error::adbd cannot run as root on this image; the profile cannot be seeded"
  exit 1
fi
sleep 3
adb wait-for-device

(
  while true; do
    if ! pgrep -f qemu-system-x86_64 > /dev/null; then
      echo "qemu gone at $(date +%T)" > "$out/emulator-died"
      break
    fi
    sleep 5
  done
) &
monitor_pid=$!

adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
adb shell cmd overlay enable com.android.internal.systemui.navbar.gestural || true
sleep 2
for pkg in \
  com.google.android.youtube com.google.android.apps.youtube.music com.google.android.gm \
  com.google.android.apps.messaging com.android.chrome com.google.android.apps.maps \
  com.google.android.videos com.google.android.apps.photos com.google.android.googlequicksearchbox \
  com.google.android.calendar com.google.android.apps.docs com.google.android.apps.wellbeing \
  com.google.android.projection.gearhead com.google.android.apps.tachyon com.google.android.talk \
  com.google.android.music com.google.android.apps.podcasts com.google.android.apps.nbu.files; do
  adb shell pm disable-user --user 0 "$pkg" > /dev/null 2>&1 || true
done
adb shell am kill-all || true
echo "letting the system settle"
sleep 30
adb shell wm size | tee "$out/display.txt" || true
adb shell wm density | tee -a "$out/display.txt" || true

state_json() {
  local edge=$1
  cat << EOF
{"version":2,"activeSpaceId":"space_work","spaces":[{"id":"space_work","name":"Work","icon":"W","containerId":"default","theme":{"type":"gradient","colors":[{"c":[96,110,235],"x":0.3,"y":0.35,"isPrimary":true},{"c":[214,92,160],"x":0.7,"y":0.65}],"opacity":0.55,"texture":0,"algorithm":"floating","monochrome":false,"rotation":40},"tabIds":["tab_example","tab_settings"],"activeTabId":"tab_settings","pinnedCollapsed":false}],"folders":[],"tabs":[{"id":"tab_example","spaceId":"space_work","containerId":"default","folderId":null,"url":"https://example.com/","title":"Example Domain","pinned":false,"essential":false},{"id":"tab_settings","spaceId":"space_work","containerId":"default","folderId":null,"url":"zen://settings/updates","title":"Settings","pinned":false,"essential":false}],"essentialTabIds":[],"containers":[],"splitGroups":[],"settings":{"onboardingDone":true,"colorScheme":"system","phoneBarPosition":"$edge","gestureHintDone":true,"updates":{"autoCheck":false,"autoDownload":false,"channel":"stable"}},"shortcutOverrides":{},"windows":[{"id":"window_main","bounds":null,"maximized":false,"activeSpaceId":"space_work","selection":{"space_work":"tab_settings"},"compact":false}]}
EOF
}

seed_profile() {
  local app_id=$1 edge=$2 uid
  local dir="/data/data/$app_id/files/zen"
  uid=$(adb shell stat -c '%u' "/data/data/$app_id" | tr -d '\r')
  adb shell "mkdir -p $dir && rm -f $dir/state.json $dir/state.json.bak"
  state_json "$edge" | adb shell "cat > $dir/state.json"
  adb shell "chown -R $uid:$uid /data/data/$app_id/files && restorecon -R /data/data/$app_id/files" || true
}

# A cold process start; the seeded session's active tab is Bennett's page (Settings > Updates),
# so its view is created at boot. Nothing opens a tab afterwards: a WebView attached once the
# chrome is up makes Android dispatch the insets again, which hid the loss behind the bisect's
# deep link whenever that link had a new tab to create.
launch() {
  local app_id=$1
  adb shell am force-stop "$app_id" || true
  sleep 1
  adb shell am start -W -n "$app_id/app.zen.chromium.MainActivity" > /dev/null
  sleep "$settle"
}

for entry in $apks; do
  IFS='=' read -r label apk app_id <<< "$entry"
  if [ -d "$apk" ]; then apk=$(find "$apk" -name '*.apk' -print -quit); fi
  echo "==== $label: $apk ($app_id)"
  if [ -z "$apk" ] || [ ! -f "$apk" ]; then
    echo "::error::no APK for $label"
    continue
  fi
  adb uninstall "$app_id" > /dev/null 2>&1 || true
  adb install -g "$apk"
  adb shell dumpsys package "$app_id" | grep -E "versionName" | head -n 1 | tee "$out/$label-version.txt" || true
  adb logcat -c || true
  adb logcat -v time > "$out/$label-logcat.txt" &
  logcat_pid=$!

  # The first session: the engine seeds its feed documents into the profile.
  adb shell cmd uimode night no > /dev/null || true
  seed_profile "$app_id" top
  launch "$app_id"
  adb exec-out screencap -p > "$out/$label-first-start.png"
  adb shell am force-stop "$app_id" || true
  sleep 1
  adb shell "ls -la /data/data/$app_id/files/zen/safebrowsing" | tr -d '\r' | tee "$out/$label-safebrowsing.txt" || true

  for scheme in light dark; do
    if [ "$scheme" = dark ]; then adb shell cmd uimode night yes > /dev/null; else adb shell cmd uimode night no > /dev/null; fi
    sleep 2
    for dock in top bottom; do
      seed_profile "$app_id" "$dock"
      # The second start's condition, every time: the feeds parsed at boot.
      adb shell "rm -f /data/data/$app_id/files/zen/safebrowsing/tables.bin" || true
      launch "$app_id"
      adb exec-out screencap -p > "$out/$label-$scheme-$dock.png"
      {
        echo "== $label-$scheme-$dock"
        adb shell dumpsys window | grep -E "InsetsSource|statusBars|navigationBars" | head -n 12
      } >> "$out/$label-window-insets.txt" 2>&1 || true
      adb shell am force-stop "$app_id" || true
      sleep 1
    done
  done
  adb shell cmd uimode night no > /dev/null || true
  kill "$logcat_pid" 2> /dev/null || true
  wait "$logcat_pid" 2> /dev/null || true
  grep -E "ZenChrome|zen-safebrowsing|\[zen\] boot" "$out/$label-logcat.txt" | head -n 300 > "$out/$label-logcat-chrome.txt" || true
done

kill "$monitor_pid" 2> /dev/null || true
ls -la "$out"
