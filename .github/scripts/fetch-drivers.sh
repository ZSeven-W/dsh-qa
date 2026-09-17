#!/usr/bin/env bash
# Materialize ../dsh-browser, ../dsh-computer, ../dsh-ios and ../dsh-android
# from their published tarballs, so the `link:../dsh-*` dev dependencies in
# package.json resolve on a runner that only checked out this repository.
#
# Published tarballs already contain a built `lib/`, which is the point: this
# avoids needing each driver's own toolchain (Swift for dsh-computer, the
# client bundlers for the mobile pair) and pins CI to the same driver bytes a
# user gets from `npm install`.
#
# The siblings land NEXT TO the checkout. On GitHub runners that is
# /home/runner/work/<repo>/, which is writable; `actions/checkout` could not
# place them there because its `path:` must stay inside the workspace.
set -euo pipefail

# Which dist-tag to pull. `latest` is what a user resolves by default; override
# to pin an exact combination when reproducing a failure.
DRIVER_TAG="${DRIVER_TAG:-latest}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="$(dirname "$here")"

for name in browser computer ios android; do
  dir="$parent/dsh-$name"
  spec="@zseven-w/dsh-$name@$DRIVER_TAG"

  if [ -d "$dir" ]; then
    echo "==> dsh-$name already present at $dir — leaving it alone"
    continue
  fi

  echo "==> fetching $spec into $dir"
  work="$(mktemp -d)"
  ( cd "$work" && npm pack "$spec" --silent >/dev/null )

  tarball="$(find "$work" -maxdepth 1 -name '*.tgz' -print -quit)"
  if [ -z "$tarball" ]; then
    echo "npm pack produced no tarball for $spec" >&2
    exit 1
  fi

  mkdir -p "$dir"
  tar -xzf "$tarball" --strip-components=1 -C "$dir"
  rm -rf "$work"

  # pnpm resolves a `link:` dependency to this directory but does NOT install
  # what the linked package itself depends on — locally those directories are
  # dev checkouts with their own node_modules. An unpacked tarball has none, so
  # dsh-browser would load and then die on `Cannot find package
  # 'playwright-core'` deep inside a test.
  #
  # Installing here is NOT what a consumer does: `npm install @zseven-w/dsh-ios`
  # in your own project never looks at that package's devDependencies, but
  # `npm install` INSIDE its directory does — and dsh-ios keeps the mutually
  # pinned @deepseek-ai/* host stack there, which ERESOLVEs against itself
  # (`peer @deepseek-ai/dsh-session@"^0.1.5-rc.2" from dsh-sandbox@0.1.5-rc.2`
  # vs. the rc.1 the manifest pins). --omit=dev does not help: npm still
  # resolves the dev tree to validate peers.
  #
  # So drop devDependencies from this scratch copy first. That does not weaken
  # anything — it makes the directory match what a consumer actually resolves,
  # which is the manifest's `dependencies` and nothing else. --legacy-peer-deps
  # would have been the other way out, and it would have papered over a real
  # conflict instead of removing an artificial one.
  if [ "$(node -p "Object.keys(require('$dir/package.json').dependencies || {}).length")" != "0" ]; then
    node -e "
      const fs = require('fs')
      const file = '$dir/package.json'
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      delete pkg.devDependencies
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
    "
    ( cd "$dir" && npm install --ignore-scripts --no-audit --no-fund --silent )
  fi

  # A driver whose entry is missing would surface much later as a confusing
  # module-resolution error inside a test, so fail here instead.
  entry="$(node -p "const p=require('$dir/package.json'); p.main || (p.exports && p.exports['.'] && (p.exports['.'].default || p.exports['.'])) || ''")"
  if [ -z "$entry" ] || [ ! -f "$dir/$entry" ]; then
    echo "dsh-$name tarball has no usable entry (looked for '${entry:-<none>}')" >&2
    exit 1
  fi
  echo "    $(node -p "require('$dir/package.json').version") — entry $entry ok"
done
