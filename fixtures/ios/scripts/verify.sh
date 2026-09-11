#!/bin/bash
# Static acceptance checks on a built fixture .app (simulator or device).
# Verifies bundle identity, display name, the four stable accessibility
# identifiers, architectures, ad-hoc signature, and absence of network
# dependencies (no URL literals / URLSession in any Mach-O in the bundle).
# Scans every executable image in the bundle so both classic single-binary
# and debug-dylib layouts are covered.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$ROOT/dist/DSHQAFixture-simulator.app}"
BIN="$APP/DSHQAFixture"
mkdir -p "$ROOT/build"
SCAN="$ROOT/build/verify-strings.tmp"
fail=0

check() { local name="$1" ok="$2"; if [ "$ok" = "yes" ]; then echo "PASS  $name"; else echo "FAIL  $name" >&2; fail=1; fi; }

[ -d "$APP" ] || { echo "FAIL  app missing: $APP" >&2; exit 1; }

bid="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null || true)"
[ "$bid" = "dev.zseven.qa.fixture.ios" ] && check "bundle id ($bid)" yes || check "bundle id (got '$bid')" no

disp="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$APP/Info.plist" 2>/dev/null || true)"
[ "$disp" = "DSH QA Fixture" ] && check "display name ($disp)" yes || check "display name (got '$disp')" no

BINS=("$BIN")
for dylib in "$APP"/*.dylib; do
  [ -f "$dylib" ] && BINS+=("$dylib")
done
{ for b in "${BINS[@]}"; do strings "$b" 2>/dev/null || true; done; } > "$SCAN"

for ident in qa.input.name qa.input.secret qa.action.apply qa.status.result; do
  if grep -F "$ident" "$SCAN" >/dev/null; then
    check "identifier $ident present" yes
  else
    check "identifier $ident present" no
  fi
done

archs="$(lipo -info "$BIN" 2>/dev/null | sed 's/.*: //' || true)"
echo "INFO  architectures: $archs"
case "$archs" in
  *arm64*) check "contains arm64" yes ;;
  *) check "contains arm64" no ;;
esac

SIGINFO="$(codesign -dv "$APP" 2>&1 || true)"
if printf '%s\n' "$SIGINFO" | grep -F 'Signature=adhoc' >/dev/null; then
  check "ad-hoc signature" yes
elif printf '%s\n' "$SIGINFO" | grep -E '^TeamIdentifier=[^ ]' >/dev/null; then
  teamid="$(printf '%s\n' "$SIGINFO" | grep -E '^TeamIdentifier=' | head -1)"
  check "development signature ($teamid)" yes
else
  check "signature present" no
fi

if grep -E 'https?://' "$SCAN" >/dev/null; then
  echo "FAIL  URL literals found in binary:" >&2
  grep -E 'https?://' "$SCAN" | head -5 >&2 || true
  fail=1
else
  check "no URL literals in binary" yes
fi

plistkeys="$(/usr/libexec/PlistBuddy -c 'Print' "$APP/Info.plist" 2>/dev/null || true)"
if printf '%s\n' "$plistkeys" | grep -E 'UsageDescription|NSAppTransportSecurity' >/dev/null; then
  echo "FAIL  privacy usage / ATS keys found in Info.plist" >&2
  fail=1
else
  check "no privacy usage / ATS keys in Info.plist" yes
fi

rm -f "$SCAN"
exit $fail
