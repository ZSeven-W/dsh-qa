import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser';
import { BrowserAdapter } from '../src/adapters/index.ts';
import { loadScenarioFromPath, runScenario } from '../src/replay/index.ts';
import { writeReports } from '../src/reporters/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_PATH = join(ROOT, 'scenarios', 'examples', 'fixture-web.json');
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'index.html');

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

test('example scenario replays twice with identical PASS results and three report artifacts', { timeout: 180_000 }, async (t) => {
  try {
    await discoverInstalledBrowser();
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message);
    return;
  }

  const scenario = loadScenarioFromPath(SCENARIO_PATH);
  const html = await readFile(FIXTURE_HTML, 'utf8');

  // Bind the fixture on a fresh port and override target.launch via
  // ReplayRunOptions.launchUrl (the committed scenario keeps a stable
  // placeholder URL; the override is how a harness injects its live fixture).
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/probe') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await listen(server, 0);
  const origin = 'http://127.0.0.1:' + server.address().port;

  const reports = [];
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-qa-replay-report-'));
  const drivers = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      const rootDir = await mkdtemp(join(tmpdir(), 'dsh-qa-replay-' + i + '-'));
      const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] });
      drivers.push(driver);
      const adapter = new BrowserAdapter(driver);
      const report = await runScenario(scenario, adapter, {
        ownerId: 'replay-' + i,
        launchUrl: origin,
      });
      reports.push(report);

      assert.equal(report.status, 'pass', 'run ' + (i + 1) + ' must PASS');
      assert.equal(report.steps.length, scenario.steps.length);
      for (const step of report.steps) {
        assert.equal(step.status, 'pass');
        assert.equal(step.assertionPassed, true);
      }
      for (const assertion of report.assertions) {
        assert.equal(assertion.passed, true);
      }

      await driver.dispose();
      assert.deepEqual(await readdir(rootDir), [], 'no temporary browser profile remains after run ' + (i + 1));
    }

    // Determinism: both runs PASS with identical semantic results (receipts
    // and evidence carry per-run timestamps, so compare the deterministic
    // projection).
    assert.equal(reports[0].status, 'pass');
    assert.equal(reports[1].status, 'pass');
    const projection = (r) => r.steps.map((s) => ({
      index: s.index,
      status: s.status,
      intent: s.intent,
      action: s.action,
      assertionPassed: s.assertionPassed,
      observed: s.observed,
      expected: s.expected,
    }));
    assert.deepEqual(projection(reports[0]), projection(reports[1]));
    assert.deepEqual(reports[0].assertions, reports[1].assertions);

    // Three report artifacts produced and structurally asserted.
    const paths = await writeReports(reports[0], { directory: outDir });
    const json = JSON.parse(await readFile(paths.json, 'utf8'));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.status, 'pass');
    assert.equal(json.steps.length, scenario.steps.length);
    assert.ok(Array.isArray(json.assertions));

    const md = await readFile(paths.markdown, 'utf8');
    assert.match(md, /# QA Replay:/);
    assert.match(md, /PASS/);

    const jsonl = await readFile(paths.jsonl, 'utf8');
    const lines = jsonl.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).status, 'pass');
  } finally {
    for (const driver of drivers) {
      await driver.dispose().catch(() => {});
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(outDir, { recursive: true, force: true });
  }
});
