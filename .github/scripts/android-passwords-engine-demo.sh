#!/usr/bin/env bash
# Temporary driver for the services-passwords engine branch (removed with its caller workflow):
# gives the emulator a device PIN, runs the shared demo script with the PasswordsEngineDemo
# instrumentation, then checks what the engine left behind: the exported CSV in Downloads and a
# vault document that carries no plaintext secret.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-services-passwords-engine}
mkdir -p "$out"

adb wait-for-device
# A device credential, so the vault key can be authentication-bound and BiometricPrompt has
# something to fall back to (the emulator has no enrolled biometrics).
adb shell locksettings set-pin 1234
adb shell locksettings get-disabled || true
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

echo "--- exported CSV in Downloads"
adb shell ls -la /sdcard/Download | tee "$out/downloads-listing.txt" || true
exported=$(adb shell run-as "$app_id" cat files/passwords-demo/exported-name.txt 2>/dev/null | tr -d '\r\n' || true)
echo "exported as: ${exported:-<none>}"
if [ -n "$exported" ]; then
  adb exec-out cat "/sdcard/Download/$exported" > "$out/exported.csv" || true
  echo "--- exported.csv (header and row count)"
  head -n 1 "$out/exported.csv" || true
  wc -l < "$out/exported.csv" || true
fi

echo "--- vault document: ciphertext only"
adb exec-out run-as "$app_id" cat files/zen/passwords.json > "$out/vault-passwords.json" || true
head -c 600 "$out/vault-passwords.json" || true
echo
if grep -q -e 'correct horse battery staple' -e 'Tr0ub4dor' -e 'ada.lovelace' "$out/vault-passwords.json"; then
  echo "::error::plaintext from a login found in the vault document"
  status=1
fi

exit "$status"
