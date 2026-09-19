#!/usr/bin/env bash
# Companion of the PasswordsUiDemo driver: gives the emulator a device PIN, so the vault key is
# authentication-bound and BiometricPrompt has a credential to fall back to, then runs the shared
# demo script with the driver and collects its step log, the checkup result and the vault
# document, which must carry no plaintext secret.
#
# The Keystore takes the new PIN as a fresh authentication for the key's five-minute validity;
# the driver waits for that to lapse before the recording starts, so the recorded unlock shows
# the credential prompt. The pause here moves the driver's start later, which gives its wait room
# inside the shared script's handshake budget; the screen is kept on meanwhile, or the new PIN
# would lock the emulator before the browser is launched.
set -euo pipefail

app_id=io.github.benitbuhner.zenium.debug
out=${DEMO_OUT:-artifacts/android-services-passwords-ui}
demo_dir=${DEMO_DIR:-passwords-ui-demo}
mkdir -p "$out"

adb wait-for-device
adb shell settings put system screen_off_timeout 2147483647 || true
adb shell svc power stayon true || true
adb shell locksettings set-pin 1234
adb shell input keyevent KEYCODE_WAKEUP || true
adb shell wm dismiss-keyguard || true
echo "device PIN set; letting its authentication age before the driver starts"
sleep 75

status=0
bash .github/scripts/android-gesture-demo.sh || status=$?

echo "--- the driver's step log and checkup result"
for name in $(adb shell run-as "$app_id" ls "files/$demo_dir" | tr -d '\r'); do
  case "$name" in
    *.txt | *.json) adb exec-out run-as "$app_id" cat "files/$demo_dir/$name" > "$out/$name" || true ;;
  esac
done
cat "$out/services-passwords-android-ui-steps.txt" 2> /dev/null || echo "(no step log)"

echo "--- vault document: ciphertext only"
adb exec-out run-as "$app_id" cat files/zen/passwords.json > "$out/vault-passwords.json" || true
head -c 600 "$out/vault-passwords.json" || true
echo
if grep -q -e 'correct horse battery staple' -e 'Tr0ub4dor' -e 'grace.hopper' -e 'orbit-lantern' "$out/vault-passwords.json"; then
  echo "::error::plaintext from a login or the passphrase found in the vault document"
  status=1
fi

exit "$status"
