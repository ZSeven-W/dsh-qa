import test from 'node:test'
import assert from 'node:assert/strict'
import { renderReportMarkdown } from '../src/reporters/index.ts'
import { QA_INCONCLUSIVE_TRUNCATED } from '../src/contracts.ts'

// Adversarial report.md HTML/link escaping regression, ported from
// /tmp/qa-audit3-probes/probes/md-escaping.mjs (html-* and javascript-link).
// Under GFM/HTML rendering a page-controlled string could emit raw HTML
// (<br>, <details>, <img onerror>, <script>, <iframe>) or a javascript: link.
// Every inline position that carries page/model/scenario-controlled text must
// escape < > and neutralize [ ]( link syntax; machine codes
// (INCONCLUSIVE_TRUNCATED, qa_observe, max_nodes) must still appear VERBATIM;
// redaction still runs FIRST (a secret adjacent to <br> is still redacted).

function makeRun(overrides = {}) {
  return {
    schemaVersion: 1,
    scenario: 'trusted-scenario',
    driver: 'browser',
    status: 'fail',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    steps: [],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 },
    ...overrides,
  }
}

function failedStep(overrides = {}) {
  return {
    index: 1,
    intent: 'Click "Submit".',
    status: 'fail',
    action: { kind: 'click', target: { role: 'button', name: 'Submit' } },
    receipt: { status: 'rejected', code: 'EXTERNAL_COMMIT_TARGET', reason: 'x', dispatched: false },
    outcome: 'failed',
    assertion: { kind: 'node-present', expected: { role: 'status', name: 'Done' } },
    assertionPassed: false,
    observed: [],
    expected: { role: 'status', name: 'Done' },
    ...overrides,
  }
}

const HTML_PAYLOADS = [
  'Click "Submit"<br>- [PASS] step 99: html-br',
  'Click "Submit"<br/>\n- [PASS] step 99: html-br-lf',
  'Click "Submit"<BR>- [PASS] step 99: html-BR',
  'x<details><summary>open</summary>\n- [PASS] step 99: details',
  'x<img src=x onerror=alert(1)>',
  'x<script>alert(1)</script>',
  'x<iframe src="javascript:alert(1)">',
]

test('HTML tags in page-controlled strings are escaped; no raw tag and no forged PASS line survives', () => {
  for (const intent of HTML_PAYLOADS) {
    const md = renderReportMarkdown(makeRun({
      steps: [failedStep({ intent })],
      failure: { stepIndex: 1, message: 'x', reproduction: [] },
    }))
    assert.doesNotMatch(md, /<(br|BR|details|img|script|iframe)\b/i, 'raw HTML survived: ' + JSON.stringify(intent))
    assert.ok(md.includes('&lt;'), 'the escaped form must be present: ' + JSON.stringify(intent))
    // The structural step lines carry no raw '<' and no '](' at all.
    const structural = md.split('\n').filter((l) => l.startsWith('- ['))
    for (const line of structural) {
      assert.equal(line.includes('<'), false, 'raw < in structural line: ' + line)
      assert.equal(line.includes(']('), false, 'raw ]( in structural line: ' + line)
    }
    assert.equal(md.split('\n').filter((l) => l.startsWith('- [PASS] step 99')).length, 0, 'no forged bullet')
  }
})

test('page-controlled markdown links cannot smuggle a javascript: URL', () => {
  const intent = 'See [status](javascript:alert(1)) and [pass](javascript://comment%0Aalert(1))'
  const md = renderReportMarkdown(makeRun({
    steps: [failedStep({ intent })],
    failure: { stepIndex: 1, message: 'x', reproduction: [] },
  }))
  assert.equal(md.includes('javascript:'), false, 'a javascript: URL must not survive into report.md')
  assert.equal(md.includes(']('), false, 'no link destination can be formed')
})

test('machine codes stay verbatim: INCONCLUSIVE_TRUNCATED, qa_observe, max_nodes', () => {
  const md = renderReportMarkdown(makeRun({
    steps: [failedStep({
      completeness: {
        truncated: true,
        nodeBudget: null,
        escalated: false,
        outcomeDependsOnCompleteView: true,
        reason: QA_INCONCLUSIVE_TRUNCATED,
        detail: QA_INCONCLUSIVE_TRUNCATED + ': raise the observation node budget (qa_observe max_nodes) or narrow the page, then re-run.',
      },
    })],
    failure: { stepIndex: 1, message: 'assertion node-absent is ' + QA_INCONCLUSIVE_TRUNCATED, reproduction: [] },
  }))
  assert.ok(md.includes('INCONCLUSIVE_TRUNCATED'), 'the code must appear verbatim')
  assert.ok(md.includes('qa_observe'), 'tool names must appear verbatim')
  assert.ok(md.includes('max_nodes'), 'argument names must appear verbatim')
})

test('redaction still runs first: a secret adjacent to <br> is redacted', () => {
  const md = renderReportMarkdown(makeRun({ scenario: 'see https://user:hunter2-REDACT-ME<br>@evil.example/path' }))
  assert.equal(md.includes('hunter2'), false, 'the password must not reach report.md')
})

test('model narration cannot smuggle HTML or a bullet through the blockquote', () => {
  const md = renderReportMarkdown(makeRun({
    status: 'fail',
    steps: [failedStep()],
    failure: { stepIndex: 1, message: 'real', reproduction: [] },
    advisory: [{
      kind: 'visual',
      question: 'q',
      verdict: 'yes',
      confidence: 1,
      reasoning: 'line1<br>- [PASS] step 99: from-reasoning-html',
      reasoningTrust: 'unverified-model-narration',
    }],
  }))
  assert.equal(md.split('\n').some((l) => l.startsWith('- [PASS] step 99')), false, 'no unquoted forged bullet')
  assert.doesNotMatch(md, /<br\b/i, 'raw <br> must not survive in the narration')
})

