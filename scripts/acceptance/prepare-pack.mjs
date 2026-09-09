// dsh-qa release acceptance — stage 1: pack.
//
// Builds the REAL payloads this acceptance installs:
//   - @zseven-w/dsh-qa via \`npm pack\` at the repo root. npm's prepack hook
//     runs the release gates (build + typecheck + full test suite), so this
//     tarball is exactly what \`npm publish\` would ship.
//   - the four local candidate drivers (browser / computer / android / ios)
//     via \`npm pack --ignore-scripts\` in each sibling checkout. The sibling
//     repos are READ-ONLY inputs here: prepack is skipped so their working
//     trees are never rebuilt, and the pack destination is outside the
//     workspace. Their lib/ output is gitignored built state; the evidence
//     file records the exact commit the payload was packed from plus the
//     contract markers found INSIDE the tarball, so a stale lib/ cannot
//     slip through silently.
//
// Usage: node scripts/acceptance/prepare-pack.mjs [--out DIR]
// Writes: <out>/evidence.json, <out>/<name>-<version>.tgz ...

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGINS_ROOT = join(ROOT, '..');
const outArg = process.argv.indexOf('--out');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT = outArg >= 0 ? process.argv[outArg + 1] : join('/private/tmp', 'qa-release-accept-' + stamp);
mkdirSync(OUT, { recursive: true });

const DRIVERS = ['dsh-browser', 'dsh-computer', 'dsh-android', 'dsh-ios'];

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function git(repoDir, args) {
  return run('git', args, { cwd: repoDir }).trim();
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function keyMembers(tarball) {
  const list = run('tar', ['-tzf', tarball], {}).split('\n').filter((l) => l.trim() !== '');
  return list.filter((l) => /^(lib\/|package\.json$)/.test(l)).sort();
}

function contractMarkers(tarball, pkgName) {
  const list = run('tar', ['-tzf', tarball], {}).split('\n');
  const files = list.filter((l) => /\.(js|d\.ts)$/.test(l) && !l.endsWith('/'));
  const haystack = {};
  for (const f of files) {
    haystack[f] = execFileSync('tar', ['-xOzf', tarball, f], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  }
  const out = {};
  const grep = (re, label) => {
    for (const [f, text] of Object.entries(haystack)) {
      const m = text.match(re);
      if (m) { out[label] = { file: f, value: m[1] ?? m[0] }; return; }
    }
    out[label] = null;
  };
  if (pkgName === 'dsh-browser') grep(/BROWSER_DRIVER_CONTRACT_VERSION\s*=\s*(\d+)/, 'browserDriverContractVersion');
  if (pkgName === 'dsh-computer') grep(/COMPUTER_DRIVER_CONTRACT_VERSION\s*=\s*(\d+)/, 'computerDriverContractVersion');
  if (pkgName === 'dsh-ios') {
    grep(/createIosQaBackend/, 'createIosQaBackend');
    grep(/fillTarget|typeTarget/, 'fillTypeTargetSeam');
  }
  if (pkgName === 'dsh-android') {
    grep(/createAndroidQaBackend/, 'createAndroidQaBackend');
    grep(/typeTarget|async type\(/, 'typeSeam');
  }
  return out;
}

const evidence = { outDir: OUT, packedAt: new Date().toISOString(), packages: {} };
const PACK_ENV = { ...process.env, npm_config_cache: join(OUT, 'npm-cache-pack') };
mkdirSync(PACK_ENV.npm_config_cache, { recursive: true });

// npm pack streams prepack script output over stdout before printing its
// JSON result LAST (single-line for small payloads, pretty-printed for
// large ones). Find the first line starting with '[' and parse from there.
function parsePackJson(stdout) {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter((l) => l !== '');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('[')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* try next candidate */ }
  }
  throw new Error('npm pack produced no JSON result block:\n' + stdout.slice(-800));
}

// 1. dsh-qa — full prepack gates (build + typecheck + test) run inside npm pack.
{
  const qaPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // npm pack names scoped tarballs by dropping the '@' and replacing the
  // scope separator: @zseven-w/dsh-qa -> zseven-w-dsh-qa-0.1.0.tgz
  let tarball = join(OUT, qaPkg.name.replace(/^@/, '').replace('/', '-') + '-' + qaPkg.version + '.tgz');
  if (existsSync(tarball)) {
    console.log('[prepare-pack] reusing ' + tarball + ' (prepack gates already passed when npm pack wrote it)');
  } else {
    console.log('[prepare-pack] npm pack @zseven-w/dsh-qa (prepack gates run inside) ...');
    const out = parsePackJson(run('npm', ['pack', '--json', '--pack-destination', OUT], { cwd: ROOT, env: PACK_ENV }));
    tarball = join(OUT, out[0].filename);
  }
  evidence.packages['@zseven-w/dsh-qa'] = {
    name: qaPkg.name,
    version: qaPkg.version,
    private: qaPkg.private,
    tarball,
    sha256: sha256(tarball),
    gitCommit: git(ROOT, ['rev-parse', 'HEAD']),
    gitDirty: git(ROOT, ['status', '--porcelain']),
    files: run('tar', ['-tzf', tarball], {}).trim().split('\n').map((l) => l.replace(/^package\//, '')).sort(),
  };
}

// 2. The four local candidate drivers — ordinary package payload, packed from
//    each sibling checkout's committed tree (prepack skipped: read-only here).
for (const d of DRIVERS) {
  const repoDir = join(PLUGINS_ROOT, d);
  const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
  const dirty = git(repoDir, ['status', '--porcelain']);
  if (dirty !== '') {
    console.error('[prepare-pack] REFUSING ' + d + ': working tree is not clean:\n' + dirty);
    process.exit(1);
  }
  console.log('[prepare-pack] npm pack ' + pkg.name + ' (ignore-scripts, read-only) ...');
  const out = parsePackJson(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', OUT], { cwd: repoDir, env: PACK_ENV }));
  const tarball = join(OUT, out[0].filename);
  evidence.packages[pkg.name] = {
    name: pkg.name,
    version: pkg.version,
    tarball,
    sha256: sha256(tarball),
    gitCommit: git(repoDir, ['rev-parse', 'HEAD']),
    gitDirty: '',
    // A snapshot made with lifecycle scripts disabled is not a current-build
    // verification. Downstream gates must keep this distinction explicit.
    buildVerification: 'not-verified (packed with --ignore-scripts)',
    memberCount: out[0].files.length,
    keyMembers: keyMembers(tarball),
    contractMarkers: contractMarkers(tarball, d),
  };
}

writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log('[prepare-pack] wrote ' + join(OUT, 'evidence.json'));
console.log(JSON.stringify(evidence, null, 2));
