// Smoke assertion for the bundled MCP server: the installed plugin is a plain
// directory copy with NO node_modules (Claude Code's directory marketplace
// copies the repo without installing anything). The bundle must therefore
// start and speak MCP over stdio with zero install-time dependencies.
//
//   npm run smoke:bundle
//
// Flow: rebuild lib/server.mjs from the current sources, copy the release
// payload (lib/server.mjs, package.json, .mcp.json) into a brand-new temp
// directory, start `node lib/server.mjs` there, and run a real MCP stdio
// handshake: initialize -> notifications/initialized -> tools/list.

import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_TOOLS = [
  'qa_session_start',
  'qa_observe',
  'qa_act',
  'qa_assert',
  'qa_evidence',
  'qa_record_export',
  'qa_replay_run',
  'qa_session_stop',
];

function fail(msg) {
  console.error('\nSMOKE FAILED: ' + msg);
  process.exit(1);
}

// 1. Rebuild from current sources.
console.log('[smoke:bundle] rebuilding lib/server.mjs from current sources ...');
await import('./build-mcp.mjs');
const bundlePath = join(ROOT, 'lib', 'server.mjs');
if (!existsSync(bundlePath)) fail('lib/server.mjs was not produced by build:mcp');

// 1b. Host-owned packages must never be inlined: the bundle may reference the
//     bare specifiers only (later work packages import them lazily).
const bundleText = readFileSync(bundlePath, 'utf8');
if (bundleText.includes('node_modules/.pnpm/@deepseek-ai')) fail('bundle contains inlined @deepseek-ai/* code');
if (bundleText.includes('@zseven-w/dsh-browser')) fail('bundle contains inlined @zseven-w/dsh-browser code');
if (bundleText.includes('@zseven-w/dsh-computer')) fail('bundle contains inlined @zseven-w/dsh-computer code');
console.log('[smoke:bundle] bundle assertions OK: no host-owned packages inlined');

// 2. Fresh temp dir - the installed plugin copy. Nothing but the payload.
const tmp = mkdtempSync(join(tmpdir(), 'dsh-qa-smoke-'));
let child = null;
let finished = false;
try {
  for (const f of ['lib/server.mjs', 'package.json', '.mcp.json']) {
    cpSync(join(ROOT, f), join(tmp, f), { recursive: true });
  }
  if (existsSync(join(tmp, 'node_modules'))) fail('temp copy unexpectedly has node_modules');
  console.log('[smoke:bundle] clean copy at ' + tmp + ' (no node_modules, ' + statSync(join(tmp, 'lib/server.mjs')).size + ' bytes)');

  // 3. Start the bundled server with cwd = the clean copy.
  child = spawn(process.execPath, ['lib/server.mjs'], { cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    if (!finished) fail('server exited early (code ' + code + ') - it could not start from a node_modules-free copy. stderr: ' + stderr.trim());
  });

  const pending = new Map();
  const responses = [];
  let buf = '';
  let nextId = 1;

  function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method + ' response (stderr: ' + stderr.trim() + ')')), 15000);
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

  const initParams = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-bundle', version: '0.0.0' } };
  console.log('--- initialize request ---');
  console.log(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: initParams }));

  const init = await request('initialize', initParams);
  console.log('--- initialize response (raw) ---');
  console.log(responses[responses.length - 1]);
  if (!init.result || !init.result.protocolVersion) fail('initialize result missing protocolVersion');
  if (!init.result.serverInfo || init.result.serverInfo.name !== 'dsh-qa') fail('initialize serverInfo.name is ' + JSON.stringify(init.result && init.result.serverInfo && init.result.serverInfo.name) + ', expected dsh-qa');
  console.log('[smoke:bundle] initialize OK: protocolVersion=' + init.result.protocolVersion + ', serverInfo=' + JSON.stringify(init.result.serverInfo));

  // Per the MCP spec the client must announce readiness before other calls.
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await request('tools/list', {});
  console.log('--- tools/list response (raw) ---');
  console.log(responses[responses.length - 1]);
  const names = (list.result && list.result.tools || []).map((t) => t.name).sort();
  const expected = EXPECTED_TOOLS.slice().sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail('tools/list returned ' + JSON.stringify(names) + ', expected ' + JSON.stringify(expected));
  }
  console.log('[smoke:bundle] tools/list OK: all ' + names.length + ' tools present: ' + names.join(', '));

  finished = true;
  child.kill();
  rmSync(tmp, { recursive: true, force: true });
  console.log('\nSMOKE PASSED: the bundled MCP server starts and serves initialize + tools/list from a node_modules-free copy.');
} catch (err) {
  finished = true;
  if (child) child.kill();
  rmSync(tmp, { recursive: true, force: true });
  fail(err && err.message ? err.message : String(err));
}
