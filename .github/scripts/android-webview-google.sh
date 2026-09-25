#!/usr/bin/env bash
# A current Android System WebView for the API 33 Google APIs emulator (seed 69).
#
# The API 33 image ships com.google.android.webview 109.0.5414.123, a WebView without profiles
# (WebViewFeature.MULTI_PROFILE came later), so on it the core offers no private tabs and the
# share demo's private-tab check reads N/A. Chromium's own snapshots cannot go on that image: its
# provider is Google's package under Google's "webview" certificate, and the package manager
# takes an update of a system package only from the same signer (the AOSP images' swap,
# android-webview-swap.sh, removes the provider from a -writable-system partition instead – the
# Google APIs images have no such partition). What the image DOES take is a newer build of the
# same package by the same signer: Google's later system images carry one. The pin below is the
# WebViewGoogle.apk out of Google's own `system-images;android-37.0;google_apis;x86_64`
# revision 6 – the SDK repository's index (sys-img2-4.xml under
# https://dl.google.com/android/repository/sys-img/google_apis/) names the archive and its sha1 –
# com.google.android.webview 145.0.7632.218 (versionCode 763221809, minSdkVersion 32, a
# standalone WebView carrying lib/x86_64/libwebviewchromium.so, no Trichrome library to install
# first), signed by the certificate the API 33 image's 109 is signed by (SHA-256
# 6faf3c41…6fe5, `apksigner verify --print-certs` on both), so `adb install -r -d -g` upgrades
# the image's provider in place and the WebView update service takes it up.
#
# Usage:
#   android-webview-google.sh fetch [<dir>]             the APK into <dir> (artifacts/webview-google
#                                                       by default) with VERSION and SHA256SUMS; a
#                                                       no-op when <dir> already holds the pinned APK
#                                                       (actions/cache keeps it between runs: the
#                                                       zip is 2.2 GB, the APK 200 MB)
#   android-webview-google.sh install [<dir>] [<out>]   `adb install -r -d -g` on the booted device,
#                                                       then the provider verified through `dumpsys
#                                                       webviewupdate` (its before / after under <out>
#                                                       when given); fails when the device does not
#                                                       report the pinned version as its WebView
#
# The fetch: the zip comes down (WEBVIEW_GOOGLE_ZIP names a local copy instead), its size and sha1
# are checked against the index's, `unzip -p` streams system.img through android-super-carve.py
# (the product logical partition out of the GPT disk's super partition, never the 4.4 GB disk on
# disk), debugfs dumps /app/WebViewGoogle/WebViewGoogle.apk.gz off that ext4 image, gunzip gives
# the APK, and its sha256 must be the pinned one. What the SDK's own tools could tell (aapt2's
# badging, apksigner's certificate) is printed when the build-tools are at hand, for the log.
set -euo pipefail

ZIP_URL=https://dl.google.com/android/repository/sys-img/google_apis/x86_64-37.0_r06.zip
ZIP_SHA1=629e507fd5b737c2c836b12b52c81cd0e3b12399
ZIP_SIZE=2234615040
IMAGE_PACKAGE='system-images;android-37.0;google_apis;x86_64 (revision 6; ro.build.id CE2A.260420.019)'
IMAGE_MEMBER=x86_64/system.img
APK_IN_PRODUCT=/app/WebViewGoogle/WebViewGoogle.apk.gz
WEBVIEW_PACKAGE=com.google.android.webview
WEBVIEW_VERSION=145.0.7632.218
WEBVIEW_VERSION_CODE=763221809
APK_SHA256=fbecca2ebb7f369237db9e178655980639b24ace1684283f25ef88ac7f27448f
SIGNER_SHA256=6faf3c4140407473400934d117815a21af1cfefc5c0bee61c858bc3d72ba6fe5

verb=${1:-}
dir=${2:-artifacts/webview-google}
apk=$dir/WebViewGoogle.apk
here=$(cd "$(dirname "$0")" && pwd)

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

# The first build-tools directory's tool $1, or nothing (the runner has build-tools;35.0.0).
sdk_tool() {
  local root=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
  [ -n "$root" ] || return 0
  find "$root/build-tools" -maxdepth 2 -name "$1" -type f 2> /dev/null | sort | tail -n 1
}

write_record() {
  {
    echo "package=$WEBVIEW_PACKAGE"
    echo "version=$WEBVIEW_VERSION"
    echo "versionCode=$WEBVIEW_VERSION_CODE"
    echo "source=$ZIP_URL"
    echo "source_sha1=$ZIP_SHA1"
    echo "source_image=$IMAGE_PACKAGE"
    echo "source_path=$IMAGE_MEMBER:product$APK_IN_PRODUCT"
    echo "apk_sha256=$APK_SHA256"
    echo "signer_sha256=$SIGNER_SHA256"
  } > "$dir/VERSION"
  (cd "$dir" && sha256sum WebViewGoogle.apk > SHA256SUMS)
}

fetch() {
  mkdir -p "$dir"
  if [ -f "$apk" ] && [ "$(sha256_of "$apk")" = "$APK_SHA256" ]; then
    echo "$apk is the pinned $WEBVIEW_PACKAGE $WEBVIEW_VERSION already (sha256 $APK_SHA256)"
    [ -f "$dir/VERSION" ] || write_record
    return 0
  fi
  local work zip
  work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/webview-google.XXXXXX")
  if [ -n "${WEBVIEW_GOOGLE_ZIP:-}" ]; then
    zip=$WEBVIEW_GOOGLE_ZIP
    echo "the image zip: $zip (local)"
  else
    zip=$work/image.zip
    echo "fetching $ZIP_URL ($ZIP_SIZE bytes)"
    curl -fL --retry 5 --retry-delay 15 --retry-all-errors -C - -o "$zip" "$ZIP_URL"
  fi
  local size sha1
  size=$(stat -c %s "$zip")
  [ "$size" = "$ZIP_SIZE" ] || { echo "::error::the zip is $size bytes, the index says $ZIP_SIZE"; return 1; }
  sha1=$(sha1sum "$zip" | cut -d' ' -f1)
  [ "$sha1" = "$ZIP_SHA1" ] || { echo "::error::the zip's sha1 is $sha1, the index says $ZIP_SHA1"; return 1; }
  echo "the zip checks out: $ZIP_SIZE bytes, sha1 $ZIP_SHA1"
  echo "carving the product partition out of $IMAGE_MEMBER"
  unzip -p "$zip" "$IMAGE_MEMBER" | python3 "$here/android-super-carve.py" product "$work/product.img"
  [ -n "${WEBVIEW_GOOGLE_ZIP:-}" ] || rm -f "$zip"
  echo "dumping $APK_IN_PRODUCT"
  debugfs -R "dump $APK_IN_PRODUCT $work/WebViewGoogle.apk.gz" "$work/product.img"
  [ -s "$work/WebViewGoogle.apk.gz" ] || { echo "::error::debugfs left no $APK_IN_PRODUCT"; return 1; }
  rm -f "$work/product.img"
  gunzip -c "$work/WebViewGoogle.apk.gz" > "$work/WebViewGoogle.apk"
  local got
  got=$(sha256_of "$work/WebViewGoogle.apk")
  [ "$got" = "$APK_SHA256" ] || { echo "::error::the APK's sha256 is $got, the pin is $APK_SHA256"; return 1; }
  mv -f "$work/WebViewGoogle.apk" "$apk"
  rm -rf "$work"
  write_record
  echo "$apk: $WEBVIEW_PACKAGE $WEBVIEW_VERSION (versionCode $WEBVIEW_VERSION_CODE), sha256 $APK_SHA256"
  local aapt2 apksigner
  aapt2=$(sdk_tool aapt2)
  [ -z "$aapt2" ] || "$aapt2" dump badging "$apk" 2> /dev/null | grep -E "^(package|sdkVersion|targetSdkVersion|native-code)" || true
  apksigner=$(sdk_tool apksigner)
  [ -z "$apksigner" ] || "$apksigner" verify --print-certs "$apk" 2> /dev/null | grep -E "certificate (DN|SHA-256)" || true
}

# The device's current provider line (`Current WebView package (name, version): (…)`), or nothing.
current_provider() {
  adb shell dumpsys webviewupdate 2> /dev/null | tr -d '\r' | grep -m1 -i 'current webview package' || true
}

install() {
  local out=${3:-}
  [ -f "$apk" ] || { echo "::error::no $apk; run fetch first"; return 1; }
  [ "$(sha256_of "$apk")" = "$APK_SHA256" ] || { echo "::error::$apk is not the pinned APK"; return 1; }
  adb wait-for-device
  echo "webview before: $(current_provider)"
  [ -z "$out" ] || adb shell dumpsys webviewupdate > "$out/webviewupdate-before.txt" 2>&1 || true
  # -r over the image's provider, -d since a lower versionCode would be refused, -g as every demo APK.
  adb install -r -d -g "$apk"
  # The update service switches providers as the package changes; a slow service is asked once.
  local line="" i
  for i in $(seq 1 30); do
    line=$(current_provider)
    case "$line" in *"$WEBVIEW_VERSION"*) break ;; esac
    [ "$i" != 10 ] || adb shell cmd webviewupdate set-webview-implementation "$WEBVIEW_PACKAGE" > /dev/null 2>&1 || true
    sleep 2
  done
  echo "webview after: $line"
  [ -z "$out" ] || adb shell dumpsys webviewupdate > "$out/webviewupdate-after.txt" 2>&1 || true
  case "$line" in
    *"$WEBVIEW_VERSION"*) echo "the device runs $WEBVIEW_PACKAGE $WEBVIEW_VERSION" ;;
    *) echo "::error::the device's WebView is not $WEBVIEW_VERSION after the install: '${line:-no provider line}'"; return 1 ;;
  esac
}

case "$verb" in
  fetch) fetch ;;
  install) install "$@" ;;
  *) echo "usage: $0 fetch [<dir>] | install [<dir>] [<out>]"; exit 2 ;;
esac
