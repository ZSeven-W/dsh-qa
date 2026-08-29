import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReportJson, renderReportJsonl, renderReportMarkdown, writeReports } from '../src/reporters/index.ts';

const report = {
  schemaVersion: 1,
  scenario: 'example',
  driver: 'browser',
  status: 'pass',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  steps: [
    {
      index: 1,
      intent: 'fill it',
      status: 'pass',
      action: { kind: 'fill', target: { role: 'textbox', name: 'Release name' }, text: 'v1.0.0' },
      receipt: { status: 'confirmed', dispatched: true },
      outcome: 'ok',
      assertion: { kind: 'node-present', expected: { role: 'button', name: 'Run validation' } },
      assertionPassed: true,
      observed: [{ role: 'button', name: 'Run validation', tag: 'button' }],
      expected: { role: 'button', name: 'Run validation' },
    },
  ],
  assertions: [
    {
      kind: 'node-present',
      passed: true,
      expected: { role: 'status', name: 'PASS' },
      observed: [{ role: 'status', name: 'PASS', tag: 'div' }],
    },
  ],
  evidence: { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } },
};

test('renderReportJson produces stable, parseable JSON', () => {
  const json = renderReportJson(report);
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.status, 'pass');
  assert.equal(parsed.steps[0].status, 'pass');
  assert.deepEqual(parsed.steps[0].observed, [{ role: 'button', name: 'Run validation', tag: 'button' }]);
});

test('renderReportMarkdown includes headings, scenario name and PASS', () => {
  const md = renderReportMarkdown(report);
  assert.match(md, /# QA Replay: example/);
  assert.match(md, /\*\*Status\*\*: pass/);
  assert.match(md, /## Steps/);
  assert.match(md, /## Final assertions/);
  assert.match(md, /\[PASS\]/);
});

test('renderReportJsonl emits one compact line with a trailing LF', () => {
  const line = renderReportJsonl(report);
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.trim().split('\n').length, 1);
  const parsed = JSON.parse(line);
  assert.equal(parsed.status, 'pass');
});

test('writeReports emits report.json, report.md and an append-only report.jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-reporters-'));
  try {
    const paths = await writeReports(report, { directory: dir });
    const json = JSON.parse(await readFile(paths.json, 'utf8'));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.status, 'pass');

    const md = await readFile(paths.markdown, 'utf8');
    assert.match(md, /QA Replay/);

    const first = (await readFile(paths.jsonl, 'utf8')).trim();
    assert.equal(first.split('\n').length, 1);

    // append-only: a second write appends a second line, never truncates.
    await writeReports(report, { directory: dir });
    const second = (await readFile(paths.jsonl, 'utf8')).trim();
    assert.equal(second.split('\n').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
