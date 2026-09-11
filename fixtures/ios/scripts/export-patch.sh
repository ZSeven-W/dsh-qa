#!/bin/bash
# Export this fixture subtree as ONE additive unified patch, suitable for
# apply_patch-compatible application. Paths are relative to the dsh-qa
# repository root: apply from dsh-qa/ with
#   patch -p0 -i <patch-file>
# or feed the patch file to an apply_patch tool. Read-only: never modifies
# the working tree, never stages anything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GITROOT="$(cd "$ROOT" && git rev-parse --show-toplevel)"
OUT="${1:-/private/tmp/qa-ios-fixture-20260908-ios-fixture.patch}"

: > "$OUT"
(
  cd "$GITROOT"
  git ls-files --others --exclude-standard fixtures/ios | sort | while IFS= read -r f; do
    [ -f "$f" ] || continue
    diff -u /dev/null "$f" >> "$OUT" || true
  done
)
echo "PATCH=$OUT lines=$(wc -l < "$OUT" | tr -d ' ')"
