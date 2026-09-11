#!/bin/bash
# Physical-device Release build for the dsh-qa iOS fixture.
#
# Signing policy: MANUAL signing with existing local assets ONLY.
#   - never passes -allowProvisioningUpdates
#   - never touches accounts, keychains, or provisioning profiles
#   - never creates or downloads signing assets
# If local prerequisites are missing, exits 2 with a precise need.
# Pass --force-attempt to run xcodebuild anyway purely to capture the
# canonical xcodebuild error (still fully offline, manual style).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="DSHQAFixture"
mkdir -p "$ROOT/build"
rm -rf "$ROOT/dist/DSHQAFixture-device.app"

if [ "${1:-}" != "--force-attempt" ]; then
  PREREQ_ERR="$ROOT/build/prereq-err.txt"
  ENV_OUT="$("$ROOT/scripts/signing-prereqs.sh" --env 2>"$PREREQ_ERR")" || {
    echo "BLOCKED: signing prerequisites not satisfied." >&2
    cat "$PREREQ_ERR" >&2
    exit 2
  }
  eval "$ENV_OUT"
  [ -n "${DSH_QA_PROFILE_SPECIFIER:-}" ] && [ -n "${DSH_QA_TEAM:-}" ] || {
    echo "BLOCKED: prerequisite resolver returned no usable signing assets." >&2
    exit 2
  }
else
  echo "force-attempt: running xcodebuild for diagnosis despite missing prerequisites." >&2
fi

SCRATCH="$ROOT/build/tmp-device"
mkdir -p "$SCRATCH"
export TMPDIR="$SCRATCH"

xcodebuild \
  -project "$ROOT/DSHQAFixture.xcodeproj" \
  -scheme DSHQAFixture \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/build/device" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="${DSH_QA_SIGN_IDENTITY:-Apple Development: 114361190@qq.com (76Q534U32J)}" \
  PROVISIONING_PROFILE_SPECIFIER="${DSH_QA_PROFILE_SPECIFIER:-dev.zseven.qa.fixture.ios}" \
  DEVELOPMENT_TEAM="${DSH_QA_TEAM:-5CHT5RB9C3}" \
  build

mkdir -p "$ROOT/dist"
APP="$ROOT/build/device/Build/Products/Release-iphoneos/$APP_NAME.app"
if [ -d "$APP" ]; then
  rm -rf "$ROOT/dist/DSHQAFixture-device.app"
  cp -R "$APP" "$ROOT/dist/DSHQAFixture-device.app"
  echo "DEVICE_APP=$ROOT/dist/DSHQAFixture-device.app"
fi
