// Package-level invariants: identity, the MCP wiring, and the tool roster
// that both smoke scripts assert over the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const mcpJson = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));

export const QA_TOOL_NAMES = [
  'qa_session_start',
  'qa_observe',
  'qa_act',
  'qa_assert',
  'qa_evidence',
  'qa_record_export',
  'qa_replay_run',
  'qa_session_stop',
].sort();

test('package identity is the private dsh-qa plugin', () => {
  assert.equal(pkg.name, '@zseven-w/dsh-qa');
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.private, true, 'v0.1 starts private');
  assert.equal(pkg.license, 'MIT');
});

test('zero host packages in dependencies or peerDependencies', () => {
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      assert.ok(!name.startsWith('@deepseek-ai/'), `${field} must not contain host package ${name}`);
    }
  }
  assert.ok(Array.isArray(pkg.dshHostRuntime?.services), 'dshHostRuntime.services documents the host runtime');
});

test('sibling browser driver is a dev-only link dependency, never a runtime dep', () => {
  assert.equal(pkg.devDependencies?.['@zseven-w/dsh-browser'], 'link:../dsh-browser');
  assert.equal(pkg.dependencies?.['@zseven-w/dsh-browser'], undefined);
});

test('.mcp.json points the plugin at the committed bundle', () => {
  const entry = mcpJson.mcpServers['dsh-qa'];
  assert.ok(entry, 'mcpServers.dsh-qa present');
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/lib/server.mjs']);
});

test('server registers the full v0.1 tool roster', () => {
  const src = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
  for (const name of QA_TOOL_NAMES) {
    assert.ok(src.includes(`'${name}'`), `server.mjs must register ${name}`);
  }
});
