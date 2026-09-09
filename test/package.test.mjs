// Package-level invariants: identity, the MCP wiring, and the tool roster
// that both smoke scripts assert over the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('sibling computer driver is a dev-only link dependency, never a runtime dep', () => {
  assert.equal(pkg.devDependencies?.['@zseven-w/dsh-computer'], 'link:../dsh-computer');
  assert.equal(pkg.dependencies?.['@zseven-w/dsh-computer'], undefined);
});

test('.mcp.json points the plugin at the committed bundle', () => {
  const entry = mcpJson.mcpServers['dsh-qa'];
  assert.ok(entry, 'mcpServers.dsh-qa present');
  assert.equal(entry.command, 'node');
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/lib/server.mjs']);
});

test('server registers the full v0.1 tool roster', () => {
  // The MCP tool registrations live in src/mcp-server.ts; src/server.mjs is the
  // thin stdio entrypoint that constructs createQaMcpServer().
  const src = readFileSync(join(ROOT, 'src', 'mcp-server.ts'), 'utf8');
  for (const name of QA_TOOL_NAMES) {
    assert.ok(src.includes(`'${name}'`), `mcp-server.ts must register ${name}`);
  }
});

test('qa_record_export is wired on MCP and the Explore playbook ships', () => {
  const src = readFileSync(join(ROOT, 'src', 'mcp-server.ts'), 'utf8');
  assert.ok(src.includes('exportRecordedScenario'));
  assert.ok(!src.includes("stubFor('qa_record_export'"));
  assert.ok(pkg.files.includes('skills'));
  assert.ok(existsSync(join(ROOT, 'skills', 'qa-explore', 'SKILL.md')));
});

test('main and exports resolve to files that exist inside the package', () => {
  assert.ok(pkg.main, 'package.json must declare main');
  const mainPath = join(ROOT, pkg.main);
  assert.ok(existsSync(mainPath), `main ${pkg.main} must exist on disk (${mainPath})`);

  const root = pkg.exports?.['.'];
  const entry = typeof root === 'string' ? root : root?.default;
  assert.ok(entry, 'exports["."] must resolve to an entry file');
  const entryPath = join(ROOT, entry);
  assert.ok(existsSync(entryPath), `exports["."] ${entry} must exist on disk (${entryPath})`);
  assert.equal(pkg.exports?.['./package.json'], './package.json', 'exports must expose ./package.json');

  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('lib'), 'files must ship lib/ (the compiled entry)');
});

test('the compiled plugin entry and MCP bundle both ship under lib/', () => {
  assert.ok(existsSync(join(ROOT, 'lib', 'index.js')), 'lib/index.js must be committed and present');
  assert.ok(existsSync(join(ROOT, 'lib', 'server.mjs')), 'lib/server.mjs must be committed and present');
});

test('cordis bundle patch and capabilities are declared consistently', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'cordis.patch.yml must exist');
  assert.ok(
    Array.isArray(pkg.dsh?.capabilities) && pkg.dsh.capabilities.includes('tool-registration'),
    'dsh.capabilities must declare tool-registration',
  );
  assert.ok(
    Array.isArray(pkg.dshHostRuntime?.services) && pkg.dshHostRuntime.services.includes('tools'),
    'dshHostRuntime.services must document tools',
  );
});

test('sibling drivers are absent from runtime dependencies', () => {
  for (const name of ['@zseven-w/dsh-browser', '@zseven-w/dsh-computer']) {
    assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
  }
});

test('the pack smoke gate is hooked to both pack and publish paths', () => {
  // npm pack runs prepack but NOT prepublishOnly; the plain-npm clean-install
  // gate (scripts/smoke-pack.mjs) must therefore be wired to BOTH so a pack
  // and a publish are each covered (references/publishing.md).
  assert.equal(pkg.scripts?.prepublishOnly, 'npm run smoke:pack', 'prepublishOnly must run the pack smoke');
});
