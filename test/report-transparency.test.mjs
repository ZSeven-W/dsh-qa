// Report-transparency regression tests (QA-BL-017). A run whose every receipt
// is 'unknown' still renders status PASS (the decide-by-observation policy is
// documented and stays), but the report must now be HONEST about it:
//
//   1. report.md renders each step's outcome (ok / unknown / failed);
//   2. report.json + report.md carry a run-level receipt census and, when zero
//      receipts were confirmed, an explicit warning line;
//   3. an evidence() exception renders as a structured collection-failed marker
//      (redacted) in both json and md, never a silent null.
//
// The adapter below is ported from /tmp/qa-audit-probes/probeE-unknown-pass.mjs
// (a frozen snapshot that reproduced the defect).

import test from 'node:test'
import assert from 'node:assert/strict'
import { runScenario, normalizeReportForDeterminism } from '../src/replay/index.ts'
import { renderReportJson, renderReportMarkdown } from '../src/reporters/index.ts'
import { QA_NO_CONFIRMED_RECEIPTS_WARNING } from '../src/contracts.ts'

const SETTLE = { budgetMs: 200, quietMs: 40, intervalMs: 10 }

const before = {
  page: { url: 'https://example.com/', title: 'Example' },
  nodes: [
    { ref: 'r1', role: 'button', name: 'Go', tag: 'BUTTON', interactive: true, editable: false, disabled: false, inViewport: true },
  ],
  truncated: false,
}

const afterView = {
  page: { url: 'https://example.com/', title: 'Example' },
  nodes: [
    { ref: 'r1', role: 'button', name: 'Go', tag: 'BUTTON', interactive: true, editable: false, disabled: false, inViewport: true },
    { ref: 'r2', role: 'status', name: 'Done', tag: 'DIV', interactive: false, editable: false, disabled: false, inViewport: true },
  ],
  truncated: false,
}

function unknownReceiptAdapter() {
  let after = false
  return {
    kind: 'browser',
    async start() { return { page: { url: 'https://example.com/', title: 'Example' }, headless: true } },
    async observe() { return structuredClone(after ? afterView : before) },
    async act() { after = true; return { status: 'unknown', reason: 'AXPress attempted; visible outcome is unknown', dispatched: true } },
    async evidence() { throw new Error('evidence collection failed (simulated)') },
    async stop() { return { stopped: true, reason: 'ok' } },
  }
}

const scenario = {
  meta: { name: 'unknown-receipt-run', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
  target: { launch: 'https://example.com/' },
  steps: [{
    index: 1,
    intent: 'Click "Go".',
    action: { kind: 'click', target: { role: 'button', name: 'Go' } },
    assert: { kind: 'node-present', expected: { role: 'status', name: 'Done' } },
  }],
  assertions: [],
}

test('an all-unknown run stays PASS but reports its receipt census and outcome honestly', async () => {
  const report = await runScenario(scenario, unknownReceiptAdapter(), { ownerId: 'probe-e', settle: SETTLE })

  assert.equal(report.status, 'pass')
  assert.equal(report.steps[0].status, 'pass')
  assert.equal(report.steps[0].outcome, 'unknown', 'step.outcome is recorded, not dropped')
  assert.equal(report.steps[0].receipt.status, 'unknown')

  assert.deepEqual(report.receiptSummary, {
    confirmed: 0,
    unknown: 1,
    rejected: 0,
    failed: 0,
    total: 1,
    warning: QA_NO_CONFIRMED_RECEIPTS_WARNING,
  })

  assert.deepEqual(report.evidence, {
    status: 'collection-failed',
    reason: 'evidence collection failed (simulated)',
  })

  const json = JSON.parse(renderReportJson(report))
  assert.equal(json.receiptSummary.confirmed, 0)
  assert.equal(json.receiptSummary.unknown, 1)
  assert.equal(json.receiptSummary.warning, QA_NO_CONFIRMED_RECEIPTS_WARNING)
  assert.equal(json.evidence.status, 'collection-failed')
  assert.equal(json.evidence.reason, 'evidence collection failed (simulated)')
})

test('report.md renders per-step outcome, the receipt census, the warning, and the evidence failure', async () => {
  const report = await runScenario(scenario, unknownReceiptAdapter(), { ownerId: 'probe-e-md', settle: SETTLE })
  const md = renderReportMarkdown(report)

  assert.match(md, /- outcome: unknown/)
  assert.match(md, /0 confirmed, 1 unknown, 0 rejected, 0 failed/)
  assert.match(md, /no action dispatch was confirmed by the driver; outcomes were decided by settled observation only/)
  assert.match(md, /## Evidence/)
  assert.match(md, /- collection: failed \(evidence collection failed \(simulated\)\)/)
})

test('receiptSummary is deterministic while the evidence failure reason stays excluded by schema', async () => {
  const run1 = await runScenario(scenario, unknownReceiptAdapter(), { ownerId: 'det-a', settle: SETTLE })
  const run2 = await runScenario(scenario, unknownReceiptAdapter(), { ownerId: 'det-b', settle: SETTLE })
  const p1 = normalizeReportForDeterminism(run1)
  const p2 = normalizeReportForDeterminism(run2)
  assert.deepEqual(p1, p2, 'deterministic projection must be byte-identical')
  assert.deepEqual(p1.receiptSummary, run1.receiptSummary, 'receiptSummary is deterministic and included')
  assert.equal(p1.evidence, undefined, 'evidence (and its failure reason) is excluded by schema')
})
