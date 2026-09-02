import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderReportMarkdown } from '../src/reporters/index.ts'
import { exportRecordedScenario, QaTrajectoryRecorder, RecordingQaDriverAdapter } from '../src/explore/index.ts'
import { QaSession } from '../src/session/index.ts'

// report.md structural-soundness (forgery). A page-controlled string (a button
// name, a fill option, a scenario name) must never be able to inject a fake
// bullet, heading, or status line into a report. Redaction runs FIRST, so a
// secret that sits next to a newline is still redacted — escaping must never
// split the token the redactor needs to see whole.

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

function stepBulletLines(md) {
  return md.split('\n').filter((line) => line.startsWith('- [PASS] step') || line.startsWith('- [FAIL] step'))
}

test('injected intent cannot add a fake bullet or status line (probe B1)', () => {
  const maliciousIntent = 'Click "Submit"\n- [PASS] step 99: injected by the page\n- **Status**: pass (injected)'
  const md = renderReportMarkdown(makeRun({
    steps: [failedStep({ intent: maliciousIntent })],
    failure: { stepIndex: 1, message: 'real failure message', reproduction: [] },
  }))

  const statusLines = md.split('\n').filter((line) => line.includes('- **Status**:'))
  assert.equal(statusLines.length, 1, 'exactly one - **Status**: line')
  assert.equal(statusLines[0], '- **Status**: fail', 'the true status line is unforgeable')

  assert.equal(stepBulletLines(md).length, 1, 'exactly one step bullet')
  assert.equal(md.split('\n').filter((line) => line.startsWith('- [PASS] step 99')).length, 0, 'no forged bullet line')
  assert.equal(md.includes('\n- [PASS] step 99'), false, 'no raw newline before the injected marker')
  assert.equal(md.includes('- **Status**: pass (injected)'), false, 'the injected status spelling is escaped away')
})

test('a hostile node name flows through export and still cannot forge report.md (probe B2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-injection-'))
  try {
    const PAGE_CONTROLLED_NAME = 'Go\n- [PASS] step 99: page-injected'
    const views = {
      before: {
        page: { url: 'https://example.com/', title: 'Example' },
        nodes: [
          { ref: 'r1', role: 'button', name: PAGE_CONTROLLED_NAME, tag: 'BUTTON', interactive: true, editable: false, disabled: false, inViewport: true },
        ],
        truncated: false,
      },
      after: {
        page: { url: 'https://example.com/', title: 'Example' },
        nodes: [
          { ref: 'r1', role: 'button', name: PAGE_CONTROLLED_NAME, tag: 'BUTTON', interactive: true, editable: false, disabled: false, inViewport: true },
          { ref: 'r2', role: 'status', name: 'Done', tag: 'DIV', interactive: false, editable: false, disabled: false, inViewport: true },
        ],
        truncated: false,
      },
    }
    let after = false
    const adapter = {
      kind: 'browser',
      async start() { return { page: { url: 'https://example.com/', title: 'Example' }, headless: true } },
      async observe() { return structuredClone(after ? views.after : views.before) },
      async act() { after = true; return { status: 'confirmed', dispatched: true, reason: 'ok' } },
      async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
      async stop() { return { stopped: true, reason: 'ok' } },
    }
    const recorder = new QaTrajectoryRecorder()
    const session = new QaSession(new RecordingQaDriverAdapter(adapter, recorder), 'probe-b2', {
      settle: { budgetMs: 120, quietMs: 40, intervalMs: 10 },
    })
    await session.start({ url: 'https://example.com/' })
    await session.observe()
    await session.act({ kind: 'click', ref: 'r1' })
    await session.stop()

    const exported = await exportRecordedScenario(recorder, 'probe-b2', { outputPath: join(dir, 'scenario.json') })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const step = exported.scenario.steps[0]
    assert.equal(step.intent.includes('\n'), false, 'raw newline normalized at export')
    assert.equal(step.action.target.name, PAGE_CONTROLLED_NAME, 'the matching target is never normalized')

    const md = renderReportMarkdown(makeRun({
      steps: [{
        index: 1,
        intent: step.intent,
        status: 'pass',
        action: step.action,
        receipt: { status: 'confirmed', dispatched: true, reason: 'ok' },
        outcome: 'ok',
        assertion: step.assert,
        assertionPassed: true,
        observed: [{ role: 'status', name: 'Done', tag: 'DIV' }],
        expected: step.assert.expected,
      }],
      status: 'pass',
      failure: undefined,
    }))
    assert.equal(md.split('\n').filter((line) => line.startsWith('- [PASS] step 99')).length, 0, 'no forged bullet from the exported name')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('N steps with hostile intents yield exactly N step bullets and one status line', () => {
  const md = renderReportMarkdown(makeRun({
    steps: [
      failedStep({ index: 1, intent: 'a\n- [PASS] step 99: x\n# fake heading' }),
      failedStep({ index: 2, intent: 'b\n> - **Status**: pass (injected)' }),
    ],
    failure: { stepIndex: 1, message: 'real failure', reproduction: [] },
  }))
  assert.equal(stepBulletLines(md).length, 2, 'exactly two step bullets')
  assert.equal(md.split('\n').filter((line) => line.includes('- **Status**:')).length, 1, 'exactly one status line')
  assert.equal(md.split('\n').filter((line) => line.startsWith('# ')).length, 1, 'exactly one top-level heading')
})

test('a secret placed next to a newline is still redacted (redaction runs before escaping)', () => {
  const md = renderReportMarkdown(makeRun({ scenario: 'see https://user:hunter2\n@evil.example/path' }))
  assert.equal(md.includes('hunter2'), false, 'the password must not reach report.md')
  assert.equal(md.includes('user:hunter2'), false)
})
