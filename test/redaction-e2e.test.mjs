import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReports } from '../src/reporters/index.ts';

// End-to-end redaction proof (WP3): a synthetic bearer credential and a URL
// with userinfo, injected into a replay run's scenario name, failure message,
// step intent/action/observed, and evidence fields, must not appear in any of
// the three report artifacts (report.json / report.md / report.jsonl) in any
// form: raw, percent-encoded per UTF-8 byte, or base64 (standard + URL-safe,
// padded + unpadded).

function secretForms(secret) {
  const bytes = Buffer.from(secret, 'utf8');
  const forms = [secret];
  forms.push(
    Array.from(bytes, (byte) => '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join(''),
    Array.from(bytes, (byte) => '%' + byte.toString(16).padStart(2, '0')).join(''),
  );
  const base64 = bytes.toString('base64');
  const base64NoPad = base64.replace(/=+$/, '');
  const urlSafe = base64.replace(/\+/g, '-').replace(/\//g, '_');
  const urlSafeNoPad = urlSafe.replace(/=+$/, '');
  forms.push(base64, base64NoPad, urlSafe, urlSafeNoPad);
  return Array.from(new Set(forms));
}

function assertSecretsAbsent(output, label, secrets) {
  for (const secret of secrets) {
    assert.ok(secret.length > 0);
    for (const form of secretForms(secret)) {
      assert.ok(
        !output.includes(form),
        label + ' leaked secret form ' + JSON.stringify(form),
      );
    }
  }
}

test('report.json/.md/.jsonl never leak a bearer credential or URL userinfo', async () => {
  const bearerToken = 'S3CR3T-BEARER-TOKEN-9f8e7d';
  const urlPassword = 'S3CR3T-URL-PASS-1234';
  const userinfoUrl = 'https://alice:' + urlPassword + '@example.internal/admin';

  const report = {
    schemaVersion: 1,
    scenario: 'Authorization: Bearer ' + bearerToken,
    driver: 'browser',
    status: 'fail',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    steps: [
      {
        index: 1,
        intent: 'navigate to ' + userinfoUrl,
        status: 'fail',
        action: { kind: 'navigate', url: userinfoUrl },
        receipt: null,
        outcome: 'failed',
        assertion: { kind: 'page-url', expected: { url: userinfoUrl } },
        assertionPassed: false,
        observed: { page: { url: userinfoUrl, title: 'admin' } },
        expected: { url: userinfoUrl },
      },
    ],
    assertions: [
      {
        kind: 'page-url',
        passed: false,
        expected: { url: userinfoUrl },
        observed: { page: { url: userinfoUrl, title: 'admin' } },
      },
    ],
    evidence: {
      console: [{ level: 'error', message: 'Authorization: Bearer ' + bearerToken }],
      network: [{ url: userinfoUrl, status: 401 }],
      bounded: true,
      dropped: { console: 0, network: 0 },
    },
    failure: {
      stepIndex: 1,
      message: 'failed to reach ' + userinfoUrl,
      reproduction: [],
    },
  };

  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-redaction-e2e-'));
  try {
    const paths = await writeReports(report, { directory: dir });
    const json = await readFile(paths.json, 'utf8');
    const markdown = await readFile(paths.markdown, 'utf8');
    const jsonl = await readFile(paths.jsonl, 'utf8');

    const secrets = [bearerToken, urlPassword, userinfoUrl];
    assertSecretsAbsent(json, 'report.json', secrets);
    assertSecretsAbsent(markdown, 'report.md', secrets);
    assertSecretsAbsent(jsonl, 'report.jsonl', secrets);

    // The redaction markers must actually be present (fail-closed, not silent).
    assert.ok(json.includes('[REDACTED]'), 'report.json must carry a redaction marker');
    assert.ok(markdown.includes('[REDACTED]'), 'report.md must carry a redaction marker');
    assert.ok(jsonl.includes('[REDACTED]'), 'report.jsonl must carry a redaction marker');
    assert.ok(json.includes('[REDACTED_URL]'), 'report.json must redact the URL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
