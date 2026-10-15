#!/usr/bin/env bash
# build-signed-apk.sh — the signed Android release (AASC-22, AASC-35).
#
# Builds the shell, syncs Capacitor with the release flags (AASC_RELEASE=1: no web inspector,
# no debug logging), then assembles the release APK signed with the upload key. The key stays
# outside the repository; its password is read from the macOS Keychain and never printed.
#
#   mobile/scripts/build-signed-apk.sh
#   → mobile/android/app/build/outputs/apk/release/app-release.apk
#
# Settings (defaults in brackets):
#   AASC_UPLOAD_STORE_FILE  [~/.aasc/android/aasc-upload.jks]
#   AASC_UPLOAD_KEY_ALIAS   [aasc-upload]
#   Keychain item           service "AASC Android upload key", account "aasc-upload"
#   JAVA_HOME               [/opt/homebrew/opt/openjdk]
#   ANDROID_HOME            [/opt/homebrew/share/android-commandlinetools]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # mobile/
export AASC_UPLOAD_STORE_FILE="${AASC_UPLOAD_STORE_FILE:-$HOME/.aasc/android/aasc-upload.jks}"
export AASC_UPLOAD_KEY_ALIAS="${AASC_UPLOAD_KEY_ALIAS:-aasc-upload}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"

if [[ ! -f "$AASC_UPLOAD_STORE_FILE" ]]; then
  echo "No upload key at $AASC_UPLOAD_STORE_FILE (see AASC-35)." >&2
  exit 1
fi
if ! AASC_UPLOAD_STORE_PASSWORD="$(security find-generic-password -s 'AASC Android upload key' -a aasc-upload -w 2>/dev/null)"; then
  echo "No Keychain item 'AASC Android upload key' / aasc-upload (see AASC-35)." >&2
  exit 1
fi
export AASC_UPLOAD_STORE_PASSWORD

cd "$here"
npm run -s shell:build
AASC_RELEASE=1 npx cap sync android
(cd android && ./gradlew assembleRelease)

apk="$here/android/app/build/outputs/apk/release/app-release.apk"
build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | tail -1)"
"$build_tools/apksigner" verify --print-certs "$apk" | grep -E 'SHA-256 digest|DN:'
echo "Signed: $apk"
echo "Note: the next debug build needs 'npx cap sync android' first (the release sync turned the inspector off)."
