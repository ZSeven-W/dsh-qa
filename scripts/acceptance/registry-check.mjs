// dsh-qa release acceptance — stage 3: READ-ONLY registry verification.
//
// No publish, no tag, no login side effects: every call here is a GET
// (npm view / npm pack from the public registry into a local tmp dir).
// Establishes, with actual-source evidence:
//   - which of the five candidates exist on the registry and at which
//     versions / dist-tags;
//   - whether the published android/ios payloads carry the /driver subpath
//     exports and the exact QA backend seams dsh-qa's adapters require
//     (fillTarget/typeTarget for iOS; append-faithful type for Android);
//   - whether the host-peer packages the drivers pin are reachable on the
//     public registry at the pinned versions;
//   - the exact required driver version constraints (from dsh-qa source and
//     the packed local evidence) and which published candidates satisfy
//     them / which are missing.
//
// Usage: node scripts/acceptance/registry-check.mjs --evidence <evidence.json>
// Writes: <out>/registry-check.json

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const evidenceArg = process.argv.indexOf('--evidence');
if (evidenceArg < 0) { console.error('usage: registry-check.mjs --evidence <evidence.json>'); process.exit(1); }
const EVIDENCE = JSON.parse(readFileSync(process.argv[evidenceArg + 1], 'utf8'));
const OUT = EVIDENCE.outDir;
if (!OUT || !EVIDENCE.packages) { console.error('invalid evidence: outDir/packages required'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const CANDIDATES = ['@zseven-w/dsh-qa', '@zseven-w/dsh-browser', '@zseven-w/dsh-computer', '@zseven-w/dsh-android', '@zseven-w/dsh-ios'];

function run(cmd, args, opts = {}) {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }) };
  } catch (err) {
    return { ok: false, code: err.status ?? null, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

function viewJson(pkg, fields = []) {
  const args = ['view', pkg, ...fields, '--json', '--cache', join(OUT, 'npm-cache-registry')];
  const res = run('npm', args, { timeout: 120000 });
  if (!res.ok) return { error: (res.stderr.match(/npm error code (\w+)/)?.[1] ?? 'fail'), detail: res.stderr.slice(0, 300) };
  try { return JSON.parse(res.stdout); } catch { return { raw: res.stdout }; }
}

const report = { registryBase: 'https://registry.npmjs.org/', checkedAt: new Date().toISOString(), candidates: {}, publishedPayloadChecks: {}, hostPeerReachability: {} };

for (const pkg of CANDIDATES) {
  const versions = viewJson(pkg, ['versions']);
  const distTags = viewJson(pkg, ['dist-tags']);
  const time = viewJson(pkg, ['time']);
  const latest = distTags.latest;
  const exports = latest ? viewJson(pkg + '@' + latest, ['exports']) : undefined;
  report.candidates[pkg] = {
    exists: Array.isArray(versions),
    versions: Array.isArray(versions) ? versions : undefined,
    distTags,
    time: time && typeof time === 'object' ? Object.fromEntries(Object.entries(time).filter(([k, v]) => k === 'created' || k === 'modified' || (typeof v === 'string' && k.startsWith('0.')))) : undefined,
    latest,
    exports,
  };
}

// Download + verify published payloads for the two published candidates.
async function verifyPublishedPayload(pkg, version) {
  if (!version || version === '?') return { ok: false, error: 'no published latest version' };
  const res = run('npm', ['pack', pkg + '@' + version, '--ignore-scripts', '--json', '--pack-destination', OUT, '--cache', join(OUT, 'npm-cache-registry')], { timeout: 120000 });
  if (!res.ok) return { ok: false, error: res.stderr.slice(0, 300) };
  let packed;
  try { packed = JSON.parse(res.stdout); } catch { return { ok: false, error: 'npm pack returned invalid JSON' }; }
  const filename = packed[0]?.filename;
  if (!filename) return { ok: false, error: 'npm pack returned no filename' };
  const tarball = join(OUT, filename);
  const list = run('tar', ['-tzf', tarball], {});
  const members = list.stdout.split('\n').filter((l) => l.trim() !== '');
  const extractDir = join(OUT, 'published-' + pkg.replace('/', '-') + '-' + version);
  mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', extractDir], {});
  const pkgJson = JSON.parse(readFileSync(join(extractDir, 'package', 'package.json'), 'utf8'));
  const files = {};
  for (const subpath of ['.', './driver', './client', './package.json']) {
    const target = pkgJson.exports?.[subpath]?.default ?? pkgJson.exports?.[subpath];
    if (typeof target !== 'string') { files[subpath] = { target: null }; continue; }
    const rel = target.replace(/^\.\//, '');
    files[subpath] = { target, exists: existsSync(join(extractDir, 'package', rel)) };
  }
  const driverTarget = pkgJson.exports?.['./driver']?.default ?? pkgJson.exports?.['./driver'];
  let driverText = '';
  if (typeof driverTarget === 'string') {
    const p = join(extractDir, 'package', driverTarget.replace(/^\.\//, ''));
    if (existsSync(p)) driverText = readFileSync(p, 'utf8');
  }
  const seams = {
    createIosQaBackend: /createIosQaBackend/.test(driverText),
    createAndroidQaBackend: /createAndroidQaBackend/.test(driverText),
    fillTarget: /fillTarget/.test(driverText),
    typeTarget: /typeTarget/.test(driverText),
    appendType: /async type\(/.test(driverText),
  };
  return { ok: true, tarball, memberCount: members.length, exports: pkgJson.exports, subpathFiles: files, seams, version: pkgJson.version };
}

report.publishedPayloadChecks['@zseven-w/dsh-ios@' + (report.candidates['@zseven-w/dsh-ios'].latest ?? '?')] =
  await verifyPublishedPayload('@zseven-w/dsh-ios', report.candidates['@zseven-w/dsh-ios'].latest);
report.publishedPayloadChecks['@zseven-w/dsh-android@' + (report.candidates['@zseven-w/dsh-android'].latest ?? '?')] =
  await verifyPublishedPayload('@zseven-w/dsh-android', report.candidates['@zseven-w/dsh-android'].latest);

// Host-peer reachability: the android/ios manifests pin these on the public
// registry. Measure whether the public registry actually has them.
const HOST_PEERS = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-sandbox-policy', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-session'];
for (const pkg of HOST_PEERS) {
  report.hostPeerReachability[pkg] = viewJson(pkg, ['versions', 'dist-tags']);
}

// Required driver version constraints — grounded in dsh-qa source (what the
// adapters actually import and rely on) + the packed local evidence.
const local = EVIDENCE.packages;
report.requiredDriverConstraints = {
  source: 'dsh-qa src/adapters/*.ts lazy loaders + contract markers in packed driver tarballs',
  browser: {
    specifier: '@zseven-w/dsh-browser',
    required: 'driver exposing BROWSER_DRIVER_CONTRACT_VERSION 9 (scoped observe v8 + coverage-verified absence v9)',
    localCandidate: local['@zseven-w/dsh-browser'].version + ' @ ' + local['@zseven-w/dsh-browser'].gitCommit,
    localContract: local['@zseven-w/dsh-browser'].contractMarkers.browserDriverContractVersion,
    published: report.candidates['@zseven-w/dsh-browser'].exists,
  },
  computer: {
    specifier: '@zseven-w/dsh-computer',
    required: 'driver exposing COMPUTER_DRIVER_CONTRACT_VERSION 5',
    localCandidate: local['@zseven-w/dsh-computer'].version + ' @ ' + local['@zseven-w/dsh-computer'].gitCommit,
    localContract: local['@zseven-w/dsh-computer'].contractMarkers.computerDriverContractVersion,
    published: report.candidates['@zseven-w/dsh-computer'].exists,
  },
  ios: {
    specifier: '@zseven-w/dsh-ios/driver',
    required: 'createIosQaBackend with native element-bound fillTarget/typeTarget text seams',
    localCandidate: local['@zseven-w/dsh-ios'].version + ' @ ' + local['@zseven-w/dsh-ios'].gitCommit,
    localSeams: local['@zseven-w/dsh-ios'].contractMarkers,
    published: report.candidates['@zseven-w/dsh-ios'].exists,
    publishedLatest: report.candidates['@zseven-w/dsh-ios'].latest,
  },
  android: {
    specifier: '@zseven-w/dsh-android/driver',
    required: 'createAndroidQaBackend with append-faithful type (no fill alias)',
    localCandidate: local['@zseven-w/dsh-android'].version + ' @ ' + local['@zseven-w/dsh-android'].gitCommit,
    localSeams: local['@zseven-w/dsh-android'].contractMarkers,
    published: report.candidates['@zseven-w/dsh-android'].exists,
    publishedLatest: report.candidates['@zseven-w/dsh-android'].latest,
  },
};

writeFileSync(join(OUT, 'registry-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
const candidateFailures = Object.values(report.candidates).some((v) => !Array.isArray(v.versions));
const payloadFailures = Object.values(report.publishedPayloadChecks).some((v) => v?.ok !== true);
// Registry observations are read-only, but a missing/erroring observation is
// still a failed gate; never let a partial network result look publishable.
process.exitCode = candidateFailures || payloadFailures ? 1 : 0;
