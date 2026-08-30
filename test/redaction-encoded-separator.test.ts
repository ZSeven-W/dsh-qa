// Regression tests for the CONFIRMED R2 encoded-separator leak (independent
// audit). R2 only recognized literal '=' / ':' as assignment / Authorization
// separators, so an encoded separator (password%3D..., Authorization%3A%20Bearer%20...)
// hid the credential from R2 entirely and it leaked verbatim into report.json /
// report.md / report.jsonl. These pin the fix: separator recognition now
// percent-decodes %3D/%3A (and double-encoded %253D/%253A) plus %20/%09
// whitespace around them, applied to both the assignment form and the
// Authorization/auth-scheme form (spec 2.2, R4 fail-closed).

import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText, projectRedactedJsonValue } from '../src/redaction/index.ts';
import { renderReportJson, renderReportJsonl, renderReportMarkdown } from '../src/reporters/index.ts';

const SECRET = 'hunter2hunter2hunter2';

test('R2: literal assignment separator stays byte-identical (audit reproducer 1)', () => {
  assert.equal(redactText('password=' + SECRET), 'password=[REDACTED]');
});

test('R2: percent-encoded assignment separator cannot hide the credential (audit reproducer 2)', () => {
  assert.equal(redactText('password%3D' + SECRET), 'password%3D[REDACTED]');
});

test('R2: percent-encoded Authorization separator cannot hide the bearer token (audit reproducer 3)', () => {
  assert.equal(
    redactText('Authorization%3A%20Bearer%20' + SECRET),
    'Authorization%3A%20Bearer%20[REDACTED]',
  );
});

test('R2: literal Authorization separator stays byte-identical (audit reproducer 4)', () => {
  assert.equal(redactText('Authorization: Bearer ' + SECRET), 'Authorization: Bearer [REDACTED]');
});

test('R2: mixed-case hex and tab padding are decoded for separator recognition', () => {
  assert.equal(redactText('password%3dhunter2'), 'password%3d[REDACTED]');
  assert.equal(redactText('token%3A%20hunter2'), 'token%3A%20[REDACTED]');
  assert.equal(redactText('password%20%3D%20hunter2'), 'password%20%3D%20[REDACTED]');
  assert.equal(redactText('password%09%3Dhunter2'), 'password%09%3D[REDACTED]');
});

test('R2: double-encoded separator is decoded for separator recognition', () => {
  assert.equal(redactText('password%253Dhunter2'), 'password%253D[REDACTED]');
  assert.equal(redactText('password%253dhunter2'), 'password%253d[REDACTED]');
  assert.equal(redactText('token%253Ahunter2'), 'token%253A[REDACTED]');
});

test('R2: malformed/repeated encoded separators collapse without leaking the value', () => {
  assert.equal(redactText('password%3D%3Dhunter2'), 'password%3D[REDACTED]');
  assert.equal(redactText('password%3A%3Ahunter2'), 'password%3A[REDACTED]');
  assert.equal(redactText('token %3A%3D hunter2'), 'token %3A[REDACTED]');
});

test('R2: encoded Authorization separator redacts low-entropy, Digest, and unknown schemes', () => {
  // A low-entropy token R3 provably cannot catch (below 4.0 bits/char): only R2
  // can redact it, and only when the encoded separator is recognized.
  assert.equal(
    redactText('Authorization%3A%20Bearer%20mypassword'),
    'Authorization%3A%20Bearer%20[REDACTED]',
  );
  assert.equal(
    redactText('Authorization%3A%20Digest%20username%3D%22x%22'),
    'Authorization%3A%20[REDACTED]',
  );
  assert.equal(
    redactText('Authorization%3A%20Custom%20hunter2'),
    'Authorization%3A%20[REDACTED]',
  );
  assert.equal(
    redactText('Authorization%253A%20Bearer%20hunter2'),
    'Authorization%253A%20Bearer%20[REDACTED]',
  );
});

test('R2: encoded separator credential never reaches report.json/.md/.jsonl', () => {
  const report = {
    schemaVersion: 1 as const,
    scenario: 'password%3D' + SECRET,
    driver: 'browser' as const,
    status: 'fail' as const,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    steps: [],
    assertions: [],
    evidence: null,
    failure: {
      stepIndex: null,
      message: 'Authorization%3A%20Bearer%20' + SECRET,
      reproduction: [],
    },
  };

  const json = renderReportJson(report);
  const jsonl = renderReportJsonl(report);
  const markdown = renderReportMarkdown(report);
  for (const [label, output] of [
    ['report.json', json],
    ['report.jsonl', jsonl],
    ['report.md', markdown],
  ] as const) {
    assert.ok(!output.includes(SECRET), label + ' leaked the encoded-separator credential');
    assert.ok(output.includes('[REDACTED]'), label + ' must carry a redaction marker');
  }
});

test('R2: encoded separator is redacted through the JSON projection too', () => {
  const projected = projectRedactedJsonValue({
    note: 'password%3D' + SECRET,
    auth: 'Authorization%3A%20Bearer%20' + SECRET,
  }) as { note: string; auth: string };
  assert.equal(projected.note, 'password%3D[REDACTED]');
  assert.equal(projected.auth, 'Authorization%3A%20Bearer%20[REDACTED]');
});
