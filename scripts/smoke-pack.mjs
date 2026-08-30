// Smoke test for the packed tarball. It guards the packaging failure class
// that bit dsh-crew's early releases:
//
//   1. npm pack the REAL repository root (no sanitized copy, no manifest
//      rewriting) - the tarball is exactly what `npm pack` / `npm publish`
//      ships. The prepack gate (build + typecheck + test) is run explicitly
//      here instead of via npm's prepack hook;
//   2. install the tarball with plain npm into a brand-new empty directory;
//   3. the install must succeed with NO ERESOLVE, and must NOT pull any
//      @deepseek-ai/* package into node_modules (@deepseek-ai/* is host
//      runtime only - the DSH host provides it, plain npm never must);
//   4. the installed lib/server.mjs bundle must answer initialize +
//      tools/list with the full 8-tool roster.
//
//   npm run smoke:pack
//
// Deliberately NOT wired into prepack (npm pack runs prepack, and this
// script calls npm pack itself - that would recurse). Run it explicitly.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_NAME = '@zseven-w/dsh-qa';

const EXPECTED_TOOLS = [
  'qa_session_start',
  'qa_observe',
  'qa_act',
  'qa_assert',
  'qa_evidence',
  'qa_record_export',
  'qa_replay_run',
  'qa_session_stop',
].sort();

const tempDirs = [];
let child = null;

function cleanup() {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

function fail(msg) {
  if (child) { try { child.kill(); } catch {} }
  cleanup();
  console.error('\nSMOKE FAILED: ' + msg);
  process.exit(1);
}

function run(cmd, args, { cwd, timeoutMs = 300_000, env = {} } = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const tail = (s) => (s || '').slice(-4000);
    fail(cmd + ' ' + args.join(' ') + ' failed in ' + cwd +
      '\n--- stdout tail ---\n' + tail(err.stdout) +
      '\n--- stderr tail ---\n' + tail(err.stderr));
  }
}

async function handshake() {
  const serverPath = join(installDir, 'node_modules', PKG_NAME, 'lib', 'server.mjs');
  if (!existsSync(serverPath)) fail('installed ' + PKG_NAME + '/lib/server.mjs is missing after install');
  console.log('\n=== installed lib/server.mjs ===');
  console.log('$ node ' + serverPath);
  child = spawn(process.execPath, [serverPath], { cwd: installDir, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let finished = false;
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    if (!finished) fail('installed bundle exited early (code ' + code + ')\nstderr: ' + stderr.trim());
  });

  const pending = new Map();
  const responses = [];
  let buf = '';
  let nextId = 1;

  function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method + ' (stderr: ' + stderr.trim() + ')')), 15000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  function routeLine(line) {
    const raw = line.trim();
    if (!raw) return;
    let msg;
    try { msg = JSON.parse(raw); }
    catch { fail('non-JSON line on stdout (protocol broken): ' + raw.slice(0, 200)); }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.code + ': ' + msg.error.message));
      else p.resolve(msg);
    }
  }

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) { responses.push(line.trim()); routeLine(line); }
    }
  });

  const initParams = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-pack', version: '0.0.0' } };
  console.log('--- initialize request ---');
  console.log(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: initParams }));

  const init = await request('initialize', initParams);
  console.log('--- initialize response (raw) ---');
  console.log(responses[responses.length - 1]);
  const info = init.result && init.result.serverInfo;
  if (!info || info.name !== 'dsh-qa') fail('serverInfo.name is ' + JSON.stringify(info && info.name) + ', expected dsh-qa');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  console.log('--- tools/list response (raw) ---');
  console.log(responses[responses.length - 1]);
  const names = (list.result && list.result.tools || []).map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
    fail('tools/list returned ' + JSON.stringify(names) + ', expected ' + JSON.stringify(EXPECTED_TOOLS));
  }
  console.log('[smoke:pack] OK: ' + names.length + ' tools, serverInfo=' + JSON.stringify(info));

  finished = true;
  child.kill();
  child = null;
  return info;
}

// ---------------------------------------------------------------------------
// 1. Build, typecheck, and test (the prepack gate, run explicitly here).
console.log('[smoke:pack] 1/5 build + typecheck + test (prepack gate) ...');
run('npm', ['run', 'build'], { cwd: ROOT });
run('npm', ['run', 'typecheck'], { cwd: ROOT });
run('npm', ['run', 'test'], { cwd: ROOT });

// ---------------------------------------------------------------------------
// 2. Pack the REAL repository root. The tarball is what `npm publish` (or a
//    plain `npm pack`) actually ships: no manifest rewriting, no subset copy.
//    A `link:` spec in devDependencies (@zseven-w/dsh-browser) is legal here:
//    devDependencies of an installed package are never fetched, so the install
//    below proves the real artifact installs cleanly.
console.log('\n[smoke:pack] 2/5 npm pack the real repository root (no sanitized copy) ...');
const packDir = mkdtempSync(join(tmpdir(), 'dsh-qa-pack-'));
tempDirs.push(packDir);
// Hermetic npm cache: a shared ~/.npm cache can be stale or hold leftovers,
// which would fail this test with EPERM instead of testing the tarball.
const cacheDir = mkdtempSync(join(tmpdir(), 'dsh-qa-npm-cache-'));
tempDirs.push(cacheDir);
const packOut = run('npm', ['pack', '--ignore-scripts', '--cache', cacheDir, '--pack-destination', packDir], { cwd: ROOT, env: { npm_config_cache: cacheDir } });
console.log(packOut.split('\n').slice(-6).join('\n'));
const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
if (tarballs.length !== 1) fail('expected exactly one tarball in ' + packDir + ', found ' + JSON.stringify(tarballs));
const tarballPath = join(packDir, tarballs[0]);
console.log('[smoke:pack] tarball: ' + tarballPath + ' (' + statSync(tarballPath).size + ' bytes)');

// ---------------------------------------------------------------------------
// 3. Install into a brand-new empty directory.
console.log('\n[smoke:pack] 3/5 npm init -y && npm i ' + tarballPath);
const installDir = mkdtempSync(join(tmpdir(), 'dsh-qa-install-'));
tempDirs.push(installDir);
console.log(run('npm', ['init', '-y', '--cache', cacheDir], { cwd: installDir, env: { npm_config_cache: cacheDir } }).split('\n').slice(0, 3).join('\n'));
const installOut = run('npm', ['i', tarballPath, '--cache', cacheDir], { cwd: installDir, timeoutMs: 600_000, env: { npm_config_cache: cacheDir } });
console.log(installOut.split('\n').slice(-12).join('\n'));
if (/ERESOLVE/.test(installOut)) fail('npm i printed ERESOLVE - host packages must never be declared as (optional) peers');

// ---------------------------------------------------------------------------
// 4. No @deepseek-ai/* may land in node_modules. The DSH host owns them.
console.log('\n[smoke:pack] 4/5 asserting no @deepseek-ai/* in node_modules');
const nmDir = join(installDir, 'node_modules');
if (!existsSync(nmDir)) fail('node_modules missing after install');
if (existsSync(join(nmDir, '@deepseek-ai'))) {
  fail('node_modules/@deepseek-ai exists: ' + readdirSync(join(nmDir, '@deepseek-ai')).join(', '));
}
console.log('[smoke:pack] node_modules/@deepseek-ai absent. top level: ' + readdirSync(nmDir).sort().join(', '));

// Declaration guard: the host-runtime stack is documented in the inert
// dshHostRuntime field, never in peerDependencies.
const installedPkg = JSON.parse(readFileSync(join(installDir, 'node_modules', PKG_NAME, 'package.json'), 'utf8'));
// The manifest must be the REAL one, not a sanitized copy: the dev-only
// `link:` driver specifier is still present in devDependencies, and plain npm
// still installed the tarball cleanly (a dependency's devDependencies are
// never fetched).
if (installedPkg.devDependencies?.['@zseven-w/dsh-browser'] !== 'link:../dsh-browser') {
  fail('installed devDependencies is missing the @zseven-w/dsh-browser link: spec - the manifest was sanitized (pack the real tree)');
}
if (installedPkg.dependencies?.['@zseven-w/dsh-browser'] !== undefined) {
  fail('@zseven-w/dsh-browser must not be a runtime dependency (it is a dev/test-only linkage)');
}
if (installedPkg.devDependencies?.['@zseven-w/dsh-computer'] !== 'link:../dsh-computer') {
  fail('installed devDependencies is missing the @zseven-w/dsh-computer link: spec - the manifest was sanitized (pack the real tree)');
}
if (installedPkg.dependencies?.['@zseven-w/dsh-computer'] !== undefined) {
  fail('@zseven-w/dsh-computer must not be a runtime dependency (it is a dev/test-only linkage)');
}
for (const name of Object.keys(installedPkg.peerDependencies || {})) {
  if (name.startsWith('@deepseek-ai/')) {
    fail('peer ' + name + ' is still in peerDependencies - @deepseek-ai/* must be host runtime only (see dshHostRuntime)');
  }
}
if (!installedPkg.dshHostRuntime || !Array.isArray(installedPkg.dshHostRuntime.services)) {
  fail('dshHostRuntime.services missing - keep documenting the host runtime in the package.json field');
}
console.log('[smoke:pack] package.json guard OK: 0 @deepseek-ai/* peers; dshHostRuntime.services=' +
  JSON.stringify(installedPkg.dshHostRuntime.services) + '; version=' + installedPkg.version);

// ---------------------------------------------------------------------------
// 5. The installed bundle must serve the full roster from the installed copy.
await handshake();
const manifestPath = join(installDir, 'node_modules', PKG_NAME, '.claude-plugin', 'plugin.json');
let manifestVersion;
try {
  manifestVersion = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
} catch (err) {
  fail('cannot read .claude-plugin/plugin.json from the installed copy: ' + err.message);
}
if (manifestVersion !== installedPkg.version) {
  fail('version mismatch: .claude-plugin/plugin.json says ' + manifestVersion + ' but package.json says ' + installedPkg.version);
}
console.log('[smoke:pack] version guard OK: package.json and plugin.json both report ' + installedPkg.version);

// ---------------------------------------------------------------------------
// 6. Prove the package ENTRY resolves and loads from the installed copy: import
//    the package name (exercising main/exports — the original
//    ERR_UNSUPPORTED_DIR_IMPORT blocker) and assert the Cordis plugin shape
//    plus the surviving library exports.
console.log('\n[smoke:pack] 6/6 import the installed package entry via main/exports');
const entryCheckPath = join(installDir, '_dshqa-entry-check.mjs');
writeFileSync(entryCheckPath, [
  `import * as m from '${PKG_NAME}'`,
  `if (m.name !== 'dsh-qa') throw new Error('entry name is ' + JSON.stringify(m.name))`,
  `if (typeof m.apply !== 'function') throw new Error('entry apply is not a function')`,
  `if (!Array.isArray(m.inject) || !m.inject.includes('tools')) throw new Error('entry inject must include tools: ' + JSON.stringify(m.inject))`,
  `if (typeof m.QaSession !== 'function') throw new Error('entry lost the library export QaSession')`,
  `if (typeof m.toLosslessJson !== 'function') throw new Error('entry lost the library export toLosslessJson')`,
  `if (typeof m.createQaTools !== 'function') throw new Error('entry lost the plugin export createQaTools')`,
  `console.log('ENTRY_OK name=' + m.name + ' inject=' + m.inject.join(','))`,
].join('\n') + '\n');
const entryOut = run('node', [entryCheckPath], { cwd: installDir });
console.log(entryOut.trim());
if (!/ENTRY_OK/.test(entryOut)) fail('installed entry did not report ENTRY_OK');
console.log('[smoke:pack] entry OK: installed ' + PKG_NAME + ' resolves and loads its plugin entry');

cleanup();
console.log('\nSMOKE PASSED: the packed tarball installs with plain npm (no ERESOLVE), pulls zero @deepseek-ai/* packages, the installed lib/server.mjs serves initialize + tools/list with all ' + EXPECTED_TOOLS.length + ' tools, and the installed package entry (name/apply/inject) loads.');
