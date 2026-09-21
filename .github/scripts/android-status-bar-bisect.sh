#!/usr/bin/env bash
# Bisect the status-bar clipping (Bennett's P0 on 0.3.79) by RELEASE: install each release APK
# the workflow's setup-script downloaded (RELEASE_VERSIONS, space separated), seed a finished
# profile through root (the release build is not debuggable, so no run-as; the Google APIs image
# allows `adb root`), start the browser on Settings > Updates (Bennett's page) and take full-frame
# screenshots with the bar docked top and bottom, light and dark, plus the top and bottom 200 px
# of each frame. Leaves everything under artifacts/android-status-bar-bisect/<version>/ with a
# `dumpsys window` excerpt (the window's insets state) and the version's logcat.
set -euo pipefail

app_id=io.github.benitbuhner.zenium
activity=$app_id/app.zen.chromium.MainActivity
apk_dir=${APK_DIR:-artifacts/apks}
out=${BISECT_OUT:-artifacts/android-status-bar-bisect}
versions=${RELEASE_VERSIONS:?RELEASE_VERSIONS is required}
settle=${LAUNCH_SETTLE_SECONDS:-14}
mkdir -p "$out"

adb wait-for-device
nproc
free -m

if adb root 2>&1 | grep -qi "cannot run as root"; then
  echo "::error::adbd cannot run as root on this image; the profile cannot be seeded"
  exit 1
fi
sleep 3
adb wait-for-device
echo "adbd running as root: $(adb shell id | tr -d '\r')"

# Host watchdog, as the other drivers keep: the emulator's death leaves a marker the workflow reads.
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
# Gesture navigation, as on Bennett's phone: the bottom inset is the gesture bar's.
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
adb shell wm size > "$out/display.txt" || true
adb shell wm density >> "$out/display.txt" || true
adb shell dumpsys webviewupdate | grep -E "Current WebView package" | tee -a "$out/display.txt" || true

# A finished profile (onboarding done, the updates check off) with one tab, the bar at `edge`,
# the colour scheme following the system so `cmd uimode night` flips the chrome.
state_json() {
  local edge=$1
  cat << EOF
{"version":2,"activeSpaceId":"space_work","spaces":[{"id":"space_work","name":"Work","icon":"W","containerId":"default","theme":{"type":"gradient","colors":[{"c":[96,110,235],"x":0.3,"y":0.35,"isPrimary":true},{"c":[214,92,160],"x":0.7,"y":0.65}],"opacity":0.55,"texture":0,"algorithm":"floating","monochrome":false,"rotation":40},"tabIds":["tab_example"],"activeTabId":"tab_example","pinnedCollapsed":false}],"folders":[],"tabs":[{"id":"tab_example","spaceId":"space_work","containerId":"default","folderId":null,"url":"https://example.com/","title":"Example Domain","pinned":false,"essential":false}],"essentialTabIds":[],"containers":[],"splitGroups":[],"settings":{"onboardingDone":true,"colorScheme":"system","phoneBarPosition":"$edge","updates":{"autoCheck":false,"autoDownload":false,"channel":"stable"}},"shortcutOverrides":{},"windows":[{"id":"window_main","bounds":null,"maximized":false,"activeSpaceId":"space_work","selection":{"space_work":"tab_example"},"compact":false}]}
EOF
}

seed_profile() {
  local edge=$1 uid
  local dir="/data/data/$app_id/files/zen"
  uid=$(adb shell stat -c '%u' "/data/data/$app_id" | tr -d '\r')
  adb shell "mkdir -p $dir && rm -f $dir/state.json $dir/state.json.bak"
  state_json "$edge" | adb shell "cat > $dir/state.json"
  adb shell "chown -R $uid:$uid /data/data/$app_id/files && restorecon -R /data/data/$app_id/files" || true
  adb shell "ls -la $dir" | tr -d '\r'
}

# Start the browser fresh on Bennett's page and let the chrome boot and paint.
launch() {
  adb shell am force-stop "$app_id" || true
  sleep 1
  adb shell am start -W -n "$activity" > /dev/null
  sleep "$settle"
  # Settings > Updates through the page alias the manifest's zenium filter takes (zenium://).
  adb shell am start -n "$activity" -a android.intent.action.VIEW -d "zenium://settings/updates" > /dev/null || true
  sleep 6
}

night() {
  adb shell cmd uimode night "$1" > /dev/null || true
  sleep 5
}

# A full frame plus its top and bottom 200 px, named <version>-<edge>-<scheme>[-<take>].
shoot() {
  local dir=$1 name=$2
  adb exec-out screencap -p > "$dir/$name.png"
  if command -v convert > /dev/null 2>&1; then
    convert "$dir/$name.png" -gravity North -crop x200+0+0 +repage "$dir/$name-top200.png" || true
    convert "$dir/$name.png" -gravity South -crop x200+0+0 +repage "$dir/$name-bottom200.png" || true
  fi
  {
    echo "== $name"
    adb shell dumpsys window | grep -E "InsetsState|InsetsSource|mFocusedApp|statusBars|navigationBars|frame=|visible=" | head -n 40
  } >> "$dir/window-insets.txt" 2>&1 || true
}

for version in $versions; do
  dir="$out/$version"
  mkdir -p "$dir"
  apk="$apk_dir/zenium-$version.apk"
  echo "==== $version: $apk"
  if [ ! -f "$apk" ]; then
    echo "::error::$apk is missing"
    continue
  fi
  adb uninstall "$app_id" > /dev/null 2>&1 || true
  if ! adb install -g "$apk"; then
    echo "::error::could not install $apk"
    continue
  fi
  adb shell dumpsys package "$app_id" | grep -E "versionName|versionCode" | head -n 2 | tee "$dir/version.txt" || true

  adb logcat -c || true
  adb logcat -v time > "$dir/logcat.txt" &
  logcat_pid=$!

  # Bar docked at the top (Bennett's dock), light then dark, twice from a cold start: the
  # symptom may be a race, so one launch is not a verdict.
  night no
  seed_profile top
  launch
  shoot "$dir" "$version-top-light"
  night yes
  shoot "$dir" "$version-top-dark"
  night no
  launch
  shoot "$dir" "$version-top-light-relaunch"

  # Bar docked at the bottom: the gesture bar's inset is the one to keep.
  seed_profile bottom
  launch
  shoot "$dir" "$version-bottom-light"
  night yes
  shoot "$dir" "$version-bottom-dark"
  night no

  adb shell am force-stop "$app_id" || true
  sleep 1
  kill "$logcat_pid" 2> /dev/null || true
  wait "$logcat_pid" 2> /dev/null || true
  grep -E "ZenChrome|ZenHost|insets|Insets" "$dir/logcat.txt" | head -n 400 > "$dir/logcat-chrome.txt" || true
done

kill "$monitor_pid" 2> /dev/null || true
ls -R "$out" | head -n 120
