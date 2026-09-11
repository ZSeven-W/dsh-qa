# dsh-qa iOS fixture (physical-device acceptance)

Dedicated UIKit fixture app for dsh-qa iOS driver acceptance on real hardware.
Owned exclusively by this directory: 'dsh-qa/fixtures/ios/**'.

## Identity

| Surface | Value |
| --- | --- |
| Bundle id | `dev.zseven.qa.fixture.ios` |
| Display name | `DSH QA Fixture` |
| Minimum iOS | 16.0 |
| Target device (read-only) | `$DSH_QA_DEVICE_UDID` (required; `xcrun devicectl list devices`) |

## Stable accessibility identifiers

- `qa.input.name` — plain text field
- `qa.input.secret` — secure text field
- `qa.action.apply` — button; writes a local result into `qa.status.result`
- `qa.status.result` — status label ("Hello <name>")
- Supporting: `qa.state.marker`, `qa.scroll.container`, `qa.item.last`

The app performs NO network requests and reads NO personal data (no privacy
usage descriptions, no URLSession, no third-party code).

## Layout

    fixtures/ios/
      project.yml                    xcodegen spec (source of truth for the project)
      DSHQAFixture.xcodeproj/        generated, committed — builds without xcodegen
      DSHQAFixture/main.swift        UIKit fixture (reused from the prior simulator fixture)
      DSHQAFixture/Info.plist        reused from the prior simulator fixture
      scripts/build-sim.sh           simulator build (scoped outputs in build/, dist/)
      scripts/build-device.sh        physical-device Release build (manual signing only)
      scripts/signing-prereqs.sh     read-only local signing prerequisite check
      scripts/verify.sh              static acceptance checks on a built .app
      scripts/sign-device-manual.sh   offline manual re-sign for Xcode-managed profiles
      scripts/export-patch.sh        emits one additive unified patch of this subtree

## Build

    # 1. Simulator (no signing assets needed)
    bash scripts/build-sim.sh
    bash scripts/verify.sh dist/DSHQAFixture-simulator.app

    # 2. Physical device (manual signing, existing local assets ONLY)
    bash scripts/signing-prereqs.sh          # report mode
    bash scripts/build-device.sh             # exits 2 with a precise need if blocked

## Signing policy (hard constraints)

- Manual signing only. `-allowProvisioningUpdates` is never passed.
- No account modifications, no new signing assets, no keychain writes.
- Only an already-installed local provisioning profile covering
  `dev.zseven.qa.fixture.ios` (exact / `dev.zseven.*` / team wildcard),
  listing the target UDID, with a developer certificate matching a local
  keychain identity, is accepted.
- The fixture never borrows another project's bundle identity (e.g. Rish's
  harness probe). If prerequisites are missing, `build-device.sh` exits 2
  and states the exact need.
- Xcode-managed profiles are refused by xcodebuild under manual signing;
  `scripts/sign-device-manual.sh` re-signs an unsigned Release-iphoneos
  build with the existing local identity + profile via codesign only (still
  no provisioning updates, no account changes).

## Notes

- Build outputs are scoped to `build/` and `dist/` (gitignored); scripts
  never delete outside this directory.
- No commit/push/publish is performed by the fixture tooling.
- Apply this subtree elsewhere with the patch from `scripts/export-patch.sh`
  (additive only).
