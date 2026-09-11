#!/bin/bash
# Read-only inspection of LOCAL signing prerequisites for a physical-device
# build of the dsh-qa iOS fixture (bundle dev.zseven.qa.fixture.ios).
#
# This script NEVER modifies keychains, accounts, profiles, or devices and
# never talks to Apple services. A profile is acceptable only if:
#   1. its application-identifier is <TEAM>.dev.zseven.qa.fixture.ios,
#      <TEAM>.dev.zseven.*, or <TEAM>.*
#   2. the target device UDID is in its ProvisionedDevices
#   3. at least one of its developer certificates matches a valid identity in
#      the local keychain (so the private key exists)
#
# Usage:
#   scripts/signing-prereqs.sh          -> report + exit 0 when satisfied, 2 otherwise
#   scripts/signing-prereqs.sh --env    -> print source-able DSH_QA_* assignments
set -uo pipefail

BUNDLE_ID="dev.zseven.qa.fixture.ios"
DEVICE_UDID="${DSH_QA_DEVICE_UDID:-}"
if [ -z "$DEVICE_UDID" ]; then
  echo "SIGNING-NEED: set DSH_QA_DEVICE_UDID to the target device UDID (xcrun devicectl list devices)" >&2
  exit 2
fi
MODE="${1:-report}"
PROFILE_DIRS=(
  "$HOME/Library/MobileDevice/Provisioning Profiles"
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
)
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"

needs() { echo "SIGNING-NEED: $*" >&2; }

decode() { # $1 profile file, $2 output plist
  openssl cms -inform DER -in "$1" -verify -noverify -out "$2" 2>/dev/null && return 0
  openssl smime -inform DER -in "$1" -verify -noverify -out "$2" 2>/dev/null && return 0
  security cms -D -i "$1" > "$2" 2>/dev/null && return 0
  return 1
}

# scan_match: sets MATCH_* globals, returns 0 when a usable profile exists.
scan_match() {
  MATCH_UUID=""; MATCH_APPID=""; MATCH_TEAM=""; MATCH_CN=""; MATCH_EXP=""
  local dir f p appid prefix team exp devices raw cn i
  for dir in "${PROFILE_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    for f in "$dir"/*; do
      [ -f "$f" ] || continue
      p="$(mktemp /private/tmp/dsh-qa-prof.XXXXXX)" || continue
      decode "$f" "$p" || { rm -f "$p"; continue; }
      appid="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:application-identifier' "$p" 2>/dev/null || true)"
      [ -n "$appid" ] || { rm -f "$p"; continue; }
      prefix="${appid%%.*}"
      case "$appid" in
        "$prefix.$BUNDLE_ID"|"$prefix.dev.zseven.*"|"$prefix.*") ;;
        *) rm -f "$p"; continue ;;
      esac
      devices="$(/usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' "$p" 2>/dev/null || true)"
      if ! printf '%s\n' "$devices" | grep -q "$DEVICE_UDID"; then
        if [ "$MODE" != "--env" ]; then
          needs "profile $appid ($(basename "$f")) covers the bundle id but target device $DEVICE_UDID is not in ProvisionedDevices"
        fi
        rm -f "$p"; continue
      fi
      team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$p" 2>/dev/null || true)"
      exp="$(/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$p" 2>/dev/null || true)"
      i=0
      while :; do
        raw="$(plutil -extract "DeveloperCertificates.$i" raw -o - "$p" 2>/dev/null || true)"
        [ -n "$raw" ] || break
        cn="$(printf '%s' "$raw" | base64 -D 2>/dev/null | openssl x509 -inform DER -noout -subject 2>/dev/null | sed -n 's/^subject=.*CN=\([^,]*\).*/\1/p')"
        if [ -n "$cn" ] && printf '%s\n' "$IDENTITIES" | grep -Fq "$cn"; then
          MATCH_UUID="$(basename "$f")"; MATCH_UUID="${MATCH_UUID%.mobileprovision}"; MATCH_UUID="${MATCH_UUID%.provisionprofile}"
          MATCH_NAME="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$p" 2>/dev/null || true)"
          MATCH_APPID="$appid"; MATCH_TEAM="$team"; MATCH_CN="$cn"; MATCH_EXP="$exp"
          rm -f "$p"; return 0
        fi
        i=$((i+1))
      done
      if [ "$MODE" != "--env" ]; then
        needs "profile $appid ($(basename "$f")) covers bundle id and device, but none of its developer certificates matches a local keychain identity"
      fi
      rm -f "$p"
    done
  done
  return 1
}

if [ "$MODE" = "--env" ]; then
  if scan_match; then
    printf 'DSH_QA_SIGN_IDENTITY=%q\n' "$MATCH_CN"
    printf 'DSH_QA_TEAM=%s\n' "$MATCH_TEAM"
    printf 'DSH_QA_PROFILE_SPECIFIER=%s\n' "$MATCH_UUID"
    printf 'DSH_QA_PROFILE_APPID=%s\n' "$MATCH_APPID"
    printf 'DSH_QA_PROFILE_NAME=%q\n' "$MATCH_NAME"
    exit 0
  fi
  needs "no installed provisioning profile covers $BUNDLE_ID (exact, dev.zseven.*, or team wildcard) whose developer certificate is present in the local keychain and whose ProvisionedDevices includes $DEVICE_UDID"
  needs "required asset: an iOS App Development provisioning profile for app id $BUNDLE_ID exported for device $DEVICE_UDID, installed under ~/Library/MobileDevice/Provisioning Profiles (this fixture performs no provisioning updates and creates no signing assets)"
  exit 2
fi

echo "BUNDLE_ID=$BUNDLE_ID"
echo "DEVICE_UDID=$DEVICE_UDID"
echo "--- local signing identities ---"
printf '%s\n' "$IDENTITIES"
echo "--- profile directories ---"
for dir in "${PROFILE_DIRS[@]}"; do
  if [ -d "$dir" ]; then echo "scanning $dir ($(ls "$dir" | wc -l | tr -d ' ') files)"; else echo "missing  $dir"; fi
done
if scan_match; then
  echo "SIGNING-OK uuid=$MATCH_UUID appid=$MATCH_APPID team=$MATCH_TEAM cert=$MATCH_CN exp=$MATCH_EXP"
  exit 0
fi
echo "SIGNING-BLOCKED (see SIGNING-NEED lines above)"
exit 2
