import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAssertion } from '../src/replay/index.ts'
import { renderReportJson, renderReportMarkdown } from '../src/reporters/index.ts'
import { QA_VALUE_SECURE, QA_VALUE_TRUNCATED, QA_VALUE_WITHHELD } from '../src/replay/index.ts'

// Adversarial flagged-value regression, ported from
// /tmp/qa-audit3-probes/probes/node-value.mjs (replay-eval-ignores-withheld-flags).
// Export already refuses to synthesize node-value for a withheld/secure/truncated
// control; replay evaluation must refuse too (defense in depth for hand-written
// scenarios): a flagged node can NEVER satisfy node-value, even when a leaked
// value field happens to carry the expected string. Each refusal carries a
// distinct machine reason.

const LAUNCH = 'http://127.0.0.1:7421/'

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status',
    editable: role === 'textbox',
    disabled: false,
    ...extra,
  }
}

test('a withheld node can never satisfy node-value even when a value field leaked', () => {
  const observation = {
    page: { url: LAUNCH, title: 'x' },
    nodes: [node('a', 'textbox', 'Secret', 'input', { value: 'hunter2', valueWithheld: true })],
    truncated: false,
  }
  const result = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Secret', value: 'hunter2' } },
    observation,
  )
  assert.equal(result.passed, false, 'a withheld node is never a node-value match')
  assert.equal(result.reason, QA_VALUE_WITHHELD, 'the refusal carries its distinct reason')
  assert.equal(result.inconclusive, false)
})

test('a secure node can never satisfy node-value even when a value field leaked', () => {
  const observation = {
    page: { url: LAUNCH, title: 'x' },
    nodes: [node('b', 'textbox', 'Secure', 'input', { value: 'hunter2', secure: true })],
    truncated: false,
  }
  const result = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Secure', value: 'hunter2' } },
    observation,
  )
  assert.equal(result.passed, false, 'a secure node is never a node-value match')
  assert.equal(result.reason, QA_VALUE_SECURE, 'the refusal carries its distinct reason')
  assert.equal(result.inconclusive, false)
})

test('a valueTruncated node can never satisfy node-value (prefix equality is invalid)', () => {
  const observation = {
    page: { url: LAUNCH, title: 'x' },
    nodes: [node('c', 'textbox', 'Long', 'input', { value: 'abcdefghij', valueTruncated: true })],
    truncated: false,
  }
  const result = evaluateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Long', value: 'abcdefghij' } },
    observation,
  )
  assert.equal(result.passed, false, 'a truncated value is never a node-value match')
  assert.equal(result.reason, QA_VALUE_TRUNCATED, 'the refusal carries its distinct reason')
  assert.equal(result.inconclusive, false)
})

test('the refusal reason surfaces in report.md and report.json', () => {
  const report = {
    schemaVersion: 1,
    scenario: 'flagged',
    driver: 'browser',
    status: 'fail',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    steps: [{
      index: 1,
      intent: 'fill',
      status: 'fail',
      action: { kind: 'fill', target: { role: 'textbox', name: 'Secret' }, text: 'hunter2' },
      receipt: { status: 'confirmed', dispatched: true },
      outcome: 'ok',
      assertion: { kind: 'node-value', expected: { role: 'textbox', name: 'Secret', value: 'hunter2' } },
      assertionPassed: false,
      observed: [{ role: 'textbox', name: 'Secret', tag: 'input', value: 'hunter2', valueWithheld: true }],
      expected: { role: 'textbox', name: 'Secret', value: 'hunter2' },
      reason: QA_VALUE_WITHHELD,
    }],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 1, unknown: 0, rejected: 0, failed: 0, total: 1 },
  }
  const md = renderReportMarkdown(report)
  const json = JSON.parse(renderReportJson(report))
  assert.match(md, new RegExp('- reason: ' + QA_VALUE_WITHHELD))
  assert.equal(json.steps[0].reason, QA_VALUE_WITHHELD)
})

