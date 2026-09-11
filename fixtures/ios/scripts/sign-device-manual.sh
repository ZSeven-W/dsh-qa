#!/bin/bash
# Offline manual re-sign of the UNSIGNED Release-iphoneos build using the
# existing local identity + an existing local provisioning profile. Fallback
# for Xcode-managed profiles, which xcodebuild refuses under
# CODE_SIGN_STYLE=Manual ("is Xcode managed" error).
# Uses ONLY existing local assets: no -allowProvisioningUpdates, no account
# modifications, no new signing assets. No device install/launch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DSHQAFixture"
UNSIGNED="$ROOT/build/device/Build/Products/Release-iphoneos/$APP_NAME.app"
[ -d "$UNSIGNED" ] || {
  echo "NEED: unsigned Release-iphoneos build first:" >&2
  echo "  xcodebuild -project DSHQAFixture.xcodeproj -scheme DSHQAFixture -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build/device CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build" >&2
  exit 2
}

ENV_OUT="$("$ROOT/scripts/signing-prereqs.sh" --env 2>/dev/null)" || {
  echo "BLOCKED: signing prerequisites not satisfied." >&2
  exit 2
}
eval "$ENV_OUT"
[ -n "${DSH_QA_PROFILE_SPECIFIER:-}" ] && [ -n "${DSH_QA_SIGN_IDENTITY:-}" ] || {
  echo "BLOCKED: prerequisite resolver returned no usable signing assets." >&2
  exit 2
}

PROFILE_DIRS=(
  "$HOME/Library/MobileDevice/Provisioning Profiles"
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
)
PROFILE_FILE=""
for dir in "${PROFILE_DIRS[@]}"; do
  [ -f "$dir/$DSH_QA_PROFILE_SPECIFIER.mobileprovision" ] && PROFILE_FILE="$dir/$DSH_QA_PROFILE_SPECIFIER.mobileprovision" && break
  [ -f "$dir/$DSH_QA_PROFILE_SPECIFIER.provisionprofile" ] && PROFILE_FILE="$dir/$DSH_QA_PROFILE_SPECIFIER.provisionprofile" && break
done
[ -n "$PROFILE_FILE" ] || { echo "BLOCKED: profile $DSH_QA_PROFILE_SPECIFIER not found on disk." >&2; exit 2; }

TMP="$ROOT/build/sign-device"
mkdir -p "$TMP"
if ! openssl cms -inform DER -in "$PROFILE_FILE" -verify -noverify -out "$TMP/profile.plist" 2>/dev/null; then
  echo "BLOCKED: could not decode profile $PROFILE_FILE" >&2
  exit 2
fi
plutil -extract Entitlements xml1 -o - "$TMP/profile.plist" > "$TMP/entitlements.xcent"

mkdir -p "$ROOT/dist"
rm -rf "$ROOT/dist/DSHQAFixture-device.app"
cp -R "$UNSIGNED" "$ROOT/dist/DSHQAFixture-device.app"
cp "$PROFILE_FILE" "$ROOT/dist/DSHQAFixture-device.app/embedded.mobileprovision"
codesign --force --sign "$DSH_QA_SIGN_IDENTITY" --entitlements "$TMP/entitlements.xcent" "$ROOT/dist/DSHQAFixture-device.app"
codesign --verify --strict --deep "$ROOT/dist/DSHQAFixture-device.app"
echo "DEVICE_APP=$ROOT/dist/DSHQAFixture-device.app"
echo "SIGNED_WITH=$DSH_QA_SIGN_IDENTITY profile=$DSH_QA_PROFILE_SPECIFIER ($DSH_QA_PROFILE_NAME)"
