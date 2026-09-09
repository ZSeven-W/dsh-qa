// dsh-qa release acceptance — stage 1b: fill pack gaps, incl. dirty siblings.
//
// prepare-pack.mjs REFUSES a sibling checkout whose working tree has
// uncommitted concurrent work (it must never ship someone's WIP). This
// companion completes the evidence set for exactly those cases, without
// touching the sibling repos:
//   - dirty tree, src/ clean  -> detached git worktree at HEAD, lib/ rebuilt
//     from HEAD src by tsc, packed there, worktree removed;
//   - dirty tree incl. src/   -> the PUBLISHED registry payload for the same
//     version (that is the released candidate), local dirtiness recorded.
// It is idempotent: only packages missing from evidence.json are packed.
//
// Usage: node scripts/acceptance/prepare-drivers-extra.mjs --evidence <evidence.json>
// Writes: updates <out>/evidence.json

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceArg = process.argv.indexOf('--evidence');
if (evidenceArg < 0) { console.error('usage: prepare-drivers-extra.mjs --evidence <evidence.json>'); process.exit(1); }
const EVIDENCE_PATH = process.argv[evidenceArg + 1];
const EVIDENCE = existsSync(EVIDENCE_PATH) ? JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) : { outDir: dirname(EVIDENCE_PATH), packedAt: new Date().toISOString(), packages: {} };
const OUT = EVIDENCE.outDir;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGINS_ROOT = join(ROOT, '..');
const DRIVERS = ['dsh-browser', 'dsh-computer', 'dsh-android', 'dsh-ios'];
const PACK_ENV = { ...process.env, npm_config_cache: join(OUT, 'npm-cache-pack') };
mkdirSync(PACK_ENV.npm_config_cache, { recursive: true });

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}
function git(repoDir, args) { return run('git', args, { cwd: repoDir }).trim(); }
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function parsePackJson(stdout) {
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter((l) => l !== '');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('[')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* try next */ }
  }
  throw new Error('npm pack produced no JSON result block:\n' + stdout.slice(-800));
}
function keyMembers(tarball) {
  const list = run('tar', ['-tzf', tarball], {}).split('\n').filter((l) => l.trim() !== '');
  return list.filter((l) => /^(lib\/|package\.json$)/.test(l)).sort();
}
function contractMarkers(tarball, pkgName) {
  const files = run('tar', ['-tzf', tarball], {}).split('\n').filter((l) => /\.(js|d\.ts)$/.test(l) && !l.endsWith('/'));
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
  if (pkgName === 'dsh-ios') { grep(/createIosQaBackend/, 'createIosQaBackend'); grep(/fillTarget|typeTarget/, 'fillTypeTargetSeam'); }
  if (pkgName === 'dsh-android') { grep(/createAndroidQaBackend/, 'createAndroidQaBackend'); grep(/typeTarget|async type\(/, 'typeSeam'); }
  return out;
}

// Ensure the dsh-qa record too, so this script alone can produce a complete
// evidence set (npm pack naming: @zseven-w/dsh-qa -> zseven-w-dsh-qa-0.1.0.tgz).
{
  const qaPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const qaName = '@zseven-w/dsh-qa';
  let qaTarball = join(OUT, qaPkg.name.replace(/^@/, '').replace('/', '-') + '-' + qaPkg.version + '.tgz');
  if (!(EVIDENCE.packages[qaName]?.tarball && existsSync(EVIDENCE.packages[qaName].tarball))) {
    if (!existsSync(qaTarball)) {
      console.log('[prepare-drivers-extra] npm pack ' + qaName + ' (prepack gates run inside) ...');
      const out = parsePackJson(run('npm', ['pack', '--json', '--pack-destination', OUT], { cwd: ROOT, env: PACK_ENV }));
      qaTarball = join(OUT, out[0].filename);
    } else {
      console.log('[prepare-drivers-extra] reusing ' + qaTarball + ' (prepack gates already passed when npm pack wrote it)');
    }
    EVIDENCE.packages[qaName] = {
      name: qaName, version: qaPkg.version, private: qaPkg.private, tarball: qaTarball, sha256: sha256(qaTarball),
      gitCommit: git(ROOT, ['rev-parse', 'HEAD']), gitDirty: git(ROOT, ['status', '--porcelain']),
      files: run('tar', ['-tzf', qaTarball], {}).trim().split('\n').map((l) => l.replace(/^package\//, '')).sort(),
    };
  }
}

for (const d of DRIVERS) {
  const pkgName = '@zseven-w/' + d;
  if (EVIDENCE.packages[pkgName]?.tarball && existsSync(EVIDENCE.packages[pkgName].tarball)) {
    console.log('[prepare-drivers-extra] skip ' + pkgName + ' (already packed)');
    continue;
  }
  const repoDir = join(PLUGINS_ROOT, d);
  const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
  const dirty = git(repoDir, ['status', '--porcelain']);
  const commit = git(repoDir, ['rev-parse', 'HEAD']);
  const srcDirty = dirty.split('\n').some((l) => l.includes('src/') || l.includes('lib/'));
  const excluded = dirty.split('\n').filter((l) => l.trim() !== '');

  if (dirty === '') {
    console.log('[prepare-drivers-extra] npm pack ' + pkgName + ' (clean, ignore-scripts) ...');
    const out = parsePackJson(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', OUT], { cwd: repoDir, env: PACK_ENV }));
    const tarball = join(OUT, out[0].filename);
    EVIDENCE.packages[pkgName] = {
      name: pkgName, version: pkg.version, tarball, sha256: sha256(tarball),
      gitCommit: commit, gitDirty: '',
      buildVerification: 'not-verified (packed with --ignore-scripts)',
      memberCount: out[0].files.length, keyMembers: keyMembers(tarball), contractMarkers: contractMarkers(tarball, d),
    };
  } else if (!srcDirty) {
    console.log('[prepare-drivers-extra] ' + d + ' dirty (concurrent work), src/ clean — packing git-archive of ' + commit.slice(0, 12) + ' with a fresh tsc build ...');
    const wt = join(OUT, 'wt-' + d);
    mkdirSync(wt, { recursive: true });
    // git archive reads ONLY the committed tree (the dirty WIP is excluded by
    // construction) and never writes into the sibling repo's .git.
    const archive = wt + '.tar';
    run('git', ['-C', repoDir, 'archive', '--format=tar', '--output=' + archive, commit]);
    run('tar', ['-xf', archive, '-C', wt]);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', PACK_ENV.npm_config_cache], { cwd: wt, timeout: 600000 });
    run('node', [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: wt, timeout: 600000 });
    const out = parsePackJson(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', OUT], { cwd: wt, env: PACK_ENV }));
    const tarball = join(OUT, out[0].filename);
    EVIDENCE.packages[pkgName] = {
      name: pkgName, version: pkg.version, tarball, sha256: sha256(tarball),
      gitCommit: commit, gitDirty: dirty,
      buildVerification: 'lib/ rebuilt from HEAD src by tsc inside a git-archive extraction',
      memberCount: out[0].files.length, keyMembers: keyMembers(tarball), contractMarkers: contractMarkers(tarball, d),
      notes: { packedFrom: 'git-archive-at-' + commit, excludedDirtyChanges: excluded },
    };
  } else {
    // src/ dirty: the committed HEAD may still carry the QA backend (the WIP
    // is uncommitted deltas on top). Try a git-archive of HEAD with a fresh
    // build; only if that build fails fall back to the published registry
    // payload (which may predate the QA backend entirely).
    console.log('[prepare-drivers-extra] ' + d + ' dirty INCLUDING src/ — trying git-archive of ' + commit.slice(0, 12) + ' + fresh build ...');
    const wt = join(OUT, 'wt-' + d);
    mkdirSync(wt, { recursive: true });
    const archive = wt + '.tar';
    let built = false;
    try {
      run('git', ['-C', repoDir, 'archive', '--format=tar', '--output=' + archive, commit]);
      run('tar', ['-xf', archive, '-C', wt]);
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', PACK_ENV.npm_config_cache], { cwd: wt, timeout: 900000 });
      run('npm', ['run', 'build'], { cwd: wt, timeout: 900000 });
      built = true;
    } catch (err) {
      console.error('[prepare-drivers-extra] archive build failed for ' + d + ': ' + String(err).slice(0, 300) + ' — falling back to registry payload');
    }
    if (built) {
      const out = parsePackJson(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', OUT], { cwd: wt, env: PACK_ENV }));
      const tarball = join(OUT, out[0].filename);
      EVIDENCE.packages[pkgName] = {
        name: pkgName, version: pkg.version, tarball, sha256: sha256(tarball),
        gitCommit: commit, gitDirty: dirty,
        buildVerification: 'lib/ rebuilt from HEAD src by the repo build script inside a git-archive extraction',
        memberCount: out[0].files.length, keyMembers: keyMembers(tarball), contractMarkers: contractMarkers(tarball, d),
        notes: { packedFrom: 'git-archive-at-' + commit, excludedDirtyChanges: excluded },
      };
    } else {
      const published = JSON.parse(run('npm', ['view', pkgName, 'version', '--json', '--cache', PACK_ENV.npm_config_cache], { timeout: 120000 }));
      const out = parsePackJson(run('npm', ['pack', pkgName + '@' + published, '--ignore-scripts', '--json', '--pack-destination', OUT], { env: PACK_ENV }));
      const tarball = join(OUT, out[0].filename);
      EVIDENCE.packages[pkgName] = {
        name: pkgName, version: pkg.version, tarball, sha256: sha256(tarball),
        gitCommit: commit, gitDirty: dirty,
        buildVerification: 'registry payload @ ' + published + ' (archive build failed; local src/ has uncommitted concurrent work)',
        memberCount: out[0].files.length, keyMembers: keyMembers(tarball), contractMarkers: contractMarkers(tarball, d),
        notes: { packedFrom: 'registry:' + pkgName + '@' + published, excludedDirtyChanges: excluded },
      };
    }
  }
}

EVIDENCE.packedAt = new Date().toISOString();
writeFileSync(EVIDENCE_PATH, JSON.stringify(EVIDENCE, null, 2) + '\n');
console.log('[prepare-drivers-extra] evidence updated: ' + EVIDENCE_PATH);
console.log(JSON.stringify(Object.fromEntries(Object.entries(EVIDENCE.packages).map(([k, v]) => [k, { tarball: v.tarball, version: v.version, gitCommit: v.gitCommit, buildVerification: v.buildVerification }])), null, 2));
