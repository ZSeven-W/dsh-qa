// dsh-qa release acceptance — stage 2: plain-npm clean install matrix.
//
// The gates from references/distribution.md, measured for real:
//   1. \`npm i <dsh-qa.tgz>\` into a brand-new empty dir must succeed with
//      NO ERESOLVE and must pull ZERO @deepseek-ai/* packages (the DSH host
//      supplies that stack; plain npm never must).
//   2. The installed lib/server.mjs must answer a real MCP stdio handshake
//      (initialize -> notifications/initialized -> tools/list) with the full
//      8-tool roster, from the installed payload only.
//   3. The installed package's "./package.json" subpath export must resolve.
//   4. qa + each of the four local driver tarballs is installed into its own
//      fresh dir and the outcome recorded verbatim (driver-side host-peer
//      declarations belong to the sibling repos; this gate MEASURES them and
//      reports, it never rewrites them).
//
// Usage: node scripts/acceptance/plain-install.mjs --evidence <evidence.json>
// Writes: <out>/plain-install.json

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const evidenceArg = process.argv.indexOf('--evidence');
if (evidenceArg < 0) { console.error('usage: plain-install.mjs --evidence <evidence.json>'); process.exit(1); }
const EVIDENCE = JSON.parse(readFileSync(process.argv[evidenceArg + 1], 'utf8'));
const OUT = EVIDENCE.outDir;
if (!OUT || !EVIDENCE.packages) { console.error('invalid evidence: outDir/packages required'); process.exit(1); }
const qa = EVIDENCE.packages['@zseven-w/dsh-qa'];
const DRIVERS = ['@zseven-w/dsh-browser', '@zseven-w/dsh-computer', '@zseven-w/dsh-android', '@zseven-w/dsh-ios'];

const EXPECTED_TOOLS = [
  'qa_session_start', 'qa_observe', 'qa_act', 'qa_assert',
  'qa_evidence', 'qa_record_export', 'qa_replay_run', 'qa_session_stop',
].sort();

function run(cmd, args, opts = {}) {
  try {
    return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }) };
  } catch (err) {
    return { ok: false, code: err.status ?? null, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

function redact(text) {
  return String(text ?? '').replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password)(\s*[=:]\s*)([^\s,}]+)/gi, '$1$2[REDACTED]');
}

async function mcpHandshake(installDir) {
  const serverPath = join(installDir, 'node_modules', '@zseven-w', 'dsh-qa', 'lib', 'server.mjs');
  if (!existsSync(serverPath)) return { handshakeOk: false, tools: [], errors: ['installed lib/server.mjs missing'] };
  const child = spawn(process.execPath, [serverPath], { cwd: installDir, stdio: ['pipe', 'pipe', 'pipe'] });
  const errors = [];
  const tools = [];
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  const finishPending = (reason) => {
    errors.push(reason);
    for (const { resolve } of pending.values()) resolve(undefined);
    pending.clear();
  };
  const timer = setTimeout(() => { finishPending('handshake timeout'); child.kill(); }, 30000);
  child.on('error', () => finishPending('MCP process could not start'));
  child.stdin.on('error', () => finishPending('MCP input pipe failed'));
  child.on('close', () => { if (pending.size > 0) finishPending('MCP exited before answering'); });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { errors.push('non-JSON line: ' + line.slice(0, 120)); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) errors.push(msg.error.code + ': ' + msg.error.message);
        p.resolve(msg);
      }
    }
  });
  child.stderr.on('data', () => {});
  const exited = new Promise((resolve) => child.on('close', resolve));
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plain-install-accept', version: '0.0.0' } });
  if (!init) { child.kill(); await exited; clearTimeout(timer); return { handshakeOk: false, tools, errors }; }
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request('tools/list', {});
  if (listed?.result?.tools) tools.push(...listed.result.tools.map((t) => t.name).sort());
  child.kill();
  await exited;
  clearTimeout(timer);
  return { handshakeOk: errors.length === 0, tools, errors };
}

function nodeModulesPackages(installDir) {
  const names = [];
  const root = join(installDir, 'node_modules');
  if (!existsSync(root)) return names;
  for (const scope of readdirSync(root)) {
    const dir = join(root, scope);
    if (scope.startsWith('@')) {
      for (const inner of readdirSync(dir)) names.push(scope + '/' + inner);
    } else names.push(scope);
  }
  return names.sort();
}

const results = { npmVersion: run('npm', ['--version']).stdout.trim(), rows: {} };

function installRow(label, tgzs) {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(OUT, 'plain-' + label.replace(/[^a-z0-9-]/gi, '-') + '-'));
  const cache = join(OUT, 'npm-cache-plain');
  mkdirSync(cache, { recursive: true });
  const args = ['install', '--no-audit', '--no-fund', '--cache', cache, ...tgzs];
  const res = run('npm', args, { cwd: dir, timeout: 300000 });
  const pkgs = nodeModulesPackages(dir);
  const hostStack = pkgs.filter((n) => n.startsWith('@deepseek-ai/'));
  return {
    dir,
    row: {
      label, tgzs, dir,
      ok: res.ok,
      exitCode: res.code,
      eresolve: (res.stdout + (res.stderr ?? '')).includes('ERESOLVE'),
      stdoutTail: redact(res.stdout).slice(-1500),
      stderrTail: redact(res.stderr).slice(-1500),
      nodeModules: pkgs,
      hostStackPulled: hostStack,
    },
  };
}

// Row 1: dsh-qa alone — the hard gate.
{
  const { dir, row } = installRow('qa-alone', [qa.tarball]);
  const mcp = await mcpHandshake(dir);
  row.mcp = mcp;
  const pkgJsonResolve = run(process.execPath, ['-e', "import('@zseven-w/dsh-qa/package.json',{with:{type:'json'}}).then(m=>console.log(m.default.name+'@'+m.default.version)).catch(e=>{console.error('RESOLVE_FAIL');process.exit(1)})"], { cwd: dir });
  row.subpathPackageJson = { ok: pkgJsonResolve.ok, out: pkgJsonResolve.stdout.trim() || pkgJsonResolve.stderr.trim() };
  results.rows['qa-alone'] = row;
}

// Rows 2-5: qa + each local driver tarball (measuring, not rewriting).
for (const driverName of DRIVERS) {
  const pkg = EVIDENCE.packages[driverName];
  if (!pkg) { results.rows['qa+' + driverName] = { error: 'no packed tarball for ' + driverName }; continue; }
  const { row } = installRow('qa+' + driverName, [qa.tarball, pkg.tarball]);
  results.rows['qa+' + driverName] = row;
}

writeFileSync(join(OUT, 'plain-install.json'), JSON.stringify(results, null, 2) + '\n');

const qaRow = results.rows['qa-alone'];
const verdict = {
  qaAloneInstalls: qaRow?.ok === true,
  noEresolve: qaRow?.eresolve === false,
  noHostStack: (qaRow?.hostStackPulled?.length ?? -1) === 0,
  mcpHandshake: qaRow?.mcp?.handshakeOk === true,
  fullToolRoster: JSON.stringify(qaRow?.mcp?.tools) === JSON.stringify(EXPECTED_TOOLS),
  subpathPackageJson: qaRow?.subpathPackageJson?.ok === true,
  driverInstalls: DRIVERS.every(name => results.rows['qa+' + name]?.ok === true
    && results.rows['qa+' + name]?.eresolve === false),
  driversNoHostStack: DRIVERS.every(name => results.rows['qa+' + name]?.hostStackPulled?.length === 0),
};
const driverSummaries = {};
for (const [k, v] of Object.entries(results.rows)) {
  if (k === 'qa-alone') continue;
  driverSummaries[k] = { ok: v.ok, exitCode: v.exitCode, eresolve: v.eresolve, hostStackPulled: v.hostStackPulled };
}
console.log(JSON.stringify({ verdict, driverRows: driverSummaries }, null, 2));
// The QA row and requested driver install rows are hard gates. Never leave a failed assertion with
// exit status 0: callers may otherwise treat the JSON as a release approval.
process.exitCode = Object.values(verdict).every(Boolean) ? 0 : 1;
