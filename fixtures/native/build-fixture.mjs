// Builds the isolated dsh-qa native macOS fixture: compiles main.swift with
// the Swift toolchain, assembles a proper .app bundle, and ad-hoc signs it
// with the repository-owned bundle id dev.zseven-w.dsh-qa.fixture. No
// third-party application or non-platform bundle id is ever referenced.
//
// Used by test/computer-integration.test.mjs to produce the app under test.
//
//   node fixtures/native/build-fixture.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'build');
const APP_NAME = 'DshQaFixture.app';
const EXECUTABLE = 'dsh-qa-fixture';
export const FIXTURE_BUNDLE_ID = 'dev.zseven-w.dsh-qa.fixture';
export const FIXTURE_WINDOW_TITLE = 'dsh-qa native fixture';

export function fixtureAppPath() {
  return join(BUILD, APP_NAME);
}

export function isFixtureBuilt() {
  return existsSync(join(fixtureAppPath(), 'Contents', 'MacOS', EXECUTABLE));
}

export function buildFixture({ force = false } = {}) {
  const appPath = fixtureAppPath();
  if (!force && isFixtureBuilt()) return appPath;

  rmSync(BUILD, { recursive: true, force: true });
  const contents = join(appPath, 'Contents');
  const macOSDir = join(contents, 'MacOS');
  mkdirSync(macOSDir, { recursive: true });

  // The Swift/clang toolchain writes module caches under $TMPDIR by default,
  // which can sit outside the repository. Redirect both the process temp dir
  // and the explicit module cache paths into the build directory so the build
  // is hermetic and stays inside the workspace.
  const scratch = join(BUILD, '.scratch');
  mkdirSync(scratch, { recursive: true });
  const executable = join(macOSDir, EXECUTABLE);
  execFileSync('swiftc', [
    '-O',
    '-module-cache-path', join(scratch, 'ModuleCache'),
    '-Xcc', '-fmodules-cache-path=' + join(scratch, 'clang-module-cache'),
    '-o', executable,
    join(ROOT, 'main.swift'),
  ], {
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
  });

  writeFileSync(join(contents, 'Info.plist'), plist());
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????');

  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', FIXTURE_BUNDLE_ID, appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  return appPath;
}

function plist() {
  // The committed Info.plist is the single source of truth; reuse it verbatim
  // so the built app never drifts from what the repository declares.
  return readFileSync(join(ROOT, 'Info.plist'), 'utf8');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const appPath = buildFixture();
  process.stdout.write(appPath + '\n');
}
