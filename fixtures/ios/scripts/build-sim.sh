#!/bin/bash
# Simulator build for the dsh-qa iOS fixture.
# No provisioning profile, no network, no account access. All build outputs
# stay inside this fixture directory (build/ and dist/).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DSHQAFixture"
DERIVED="$ROOT/build/sim"
SCRATCH="$ROOT/build/tmp-sim"
mkdir -p "$SCRATCH"
export TMPDIR="$SCRATCH"

xcodebuild \
  -project "$ROOT/DSHQAFixture.xcodeproj" \
  -scheme DSHQAFixture \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  build

mkdir -p "$ROOT/dist"
rm -rf "$ROOT/dist/DSHQAFixture-simulator.app"
cp -R "$DERIVED/Build/Products/Debug-iphonesimulator/$APP_NAME.app" "$ROOT/dist/DSHQAFixture-simulator.app"
# Ad-hoc signature keeps parity with the original simulator fixture.
codesign --force --sign - "$ROOT/dist/DSHQAFixture-simulator.app"

echo "SIM_APP=$ROOT/dist/DSHQAFixture-simulator.app"
