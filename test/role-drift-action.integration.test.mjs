import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager, discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { BrowserAdapter } from '../src/adapters/index.ts'
import {
  loadScenarioFromPath,
  normalizeReportForDeterminism,
  runScenario,
  validateScenario,
} from '../src/replay/index.ts'
import {
  exportRecordedScenario,
  QaTrajectoryRecorder,
  RecordingQaDriverAdapter,
} from '../src/explore/index.ts'
import { QaSession } from '../src/session/index.ts'
import { QA_TARGET_NOT_UNIQUE } from '../src/contracts.ts'

// QA-BL-064 end-to-end role-drift regression against a REAL browser and a real
// page whose search <input> (accessible name "Search site") is replaced after
// a configurable delay by a hydrated component rendering the same-named
// element with role="combobox" — the Wikipedia Vector typeahead story
// (textbox -> combobox), the owner's release blocker.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRIFT_FIXTURE = join(ROOT, 'fixtures', 'web', 'role-drift.html')
const AMBIGUOUS_FIXTURE = join(ROOT, 'fixtures', 'web', 'role-drift-ambiguous.html')
const SETTLE = { budgetMs: 2000, quietMs: 100, postChangeQuietMs: 200, intervalMs: 25, adaptiveBudgetMs: 0 }

async function startFixtureServer(html) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: 'http://127.0.0.1:' + server.address().port }
}

function pressScenario() {
  return validateScenario({
    meta: {
      name: 'role-drift-press',
      description: 'hand-written QA-BL-064 probe: recorded role combobox, live role textbox',
      driver: 'browser',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    target: { launch: 'http://127.0.0.1:0/' },
    steps: [{
      index: 1,
      intent: 'Press Enter on "Search site".',
      action: { kind: 'press', target: { role: 'combobox', name: 'Search site' }, key: 'Enter' },
      // The driver scrubs query/fragment from the reported page URL, so the
      // press proof is the visible status node the fixture renders on Enter.
      assert: { kind: 'node-present', expected: { role: 'status', name: 'PRESSED' } },
    }],
    assertions: [{ kind: 'node-present', expected: { role: 'status', name: 'PRESSED' } }],
  })
}

async function withDriver(rootDir, origin, fn) {
  const driver = new BrowserManager({ rootDir, allowedOrigins: [origin] })
  try {
    return await fn(driver)
  } finally {
    await driver.dispose().catch(() => {})
  }
}

test('a press recorded against the live combobox role replays on the pre-swap textbox via the name-only fallback (and passes strictly after the swap)', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(DRIFT_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-rd-action-'))
  try {
    // -----------------------------------------------------------------
    // (a) BEFORE the swap (swapMs large): the deciding view still shows the
    //     textbox, so the recorded combobox+name predicate has ZERO matches.
    //     The name-only fallback resolves the press, discloses
    //     targetResolution, and the run passes — twice, deterministically.
    // -----------------------------------------------------------------
    const beforeSwap = []
    for (const run of [1, 2]) {
      const report = await withDriver(join(dir, 'before-' + run), origin, (driver) =>
        runScenario(pressScenario(), new BrowserAdapter(driver), {
          ownerId: 'rd-before-swap-' + run,
          launchUrl: origin + '?swapMs=10000',
          settle: SETTLE,
          headless: true,
        }))
      assert.equal(report.status, 'pass', 'before-swap run ' + run + ': ' + JSON.stringify(report.failure ?? {}))
      assert.equal(report.steps[0].assertionPassed, true)
      assert.deepEqual(
        report.steps[0].targetResolution,
        { mode: 'name-only', recordedRole: 'combobox', observedRole: 'textbox' },
        'before-swap run ' + run + ': the fallback resolves by name and discloses the drift',
      )
      beforeSwap.push(report)
    }
    assert.deepEqual(
      normalizeReportForDeterminism(beforeSwap[0]),
      normalizeReportForDeterminism(beforeSwap[1]),
      'the two before-swap runs are deterministic',
    )

    // -----------------------------------------------------------------
    // (a) AFTER the swap (swapMs 0): the deciding view already shows the
    //     combobox, so the strict role+name match resolves with NO
    //     disclosure — twice, deterministically.
    // -----------------------------------------------------------------
    const afterSwap = []
    for (const run of [1, 2]) {
      const report = await withDriver(join(dir, 'after-' + run), origin, (driver) =>
        runScenario(pressScenario(), new BrowserAdapter(driver), {
          ownerId: 'rd-after-swap-' + run,
          launchUrl: origin + '?swapMs=0',
          settle: SETTLE,
          headless: true,
        }))
      assert.equal(report.status, 'pass', 'after-swap run ' + run + ': ' + JSON.stringify(report.failure ?? {}))
      assert.equal(report.steps[0].assertionPassed, true)
      assert.equal(report.steps[0].targetResolution, undefined, 'a strict match needs no disclosure')
      afterSwap.push(report)
    }
    assert.deepEqual(
      normalizeReportForDeterminism(afterSwap[0]),
      normalizeReportForDeterminism(afterSwap[1]),
      'the two after-swap runs are deterministic',
    )
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('two same-named nodes of different roles refuse the name-only fallback with the ambiguous-role wording', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(AMBIGUOUS_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-rd-ambiguous-'))
  try {
    const report = await withDriver(dir, origin, (driver) =>
      runScenario(pressScenario(), new BrowserAdapter(driver), {
        ownerId: 'rd-ambiguous-real',
        launchUrl: origin,
        settle: SETTLE,
        headless: true,
      }))
    assert.equal(report.status, 'fail')
    assert.equal(report.failure?.code, QA_TARGET_NOT_UNIQUE, 'the refusal carries the machine code')
    assert.match(
      report.failure?.message ?? '',
      /present under a different role: recorded "combobox", observed "textbox", "button"/,
      'wording (a): the target is present, but under ambiguous roles',
    )
    assert.match(report.failure?.message ?? '', /name-only fallback was refused rather than guessed/)
    assert.equal(report.steps[0].receipt, null, 'never a guess: no action was dispatched')
    assert.equal(report.steps[0].assertionPassed, false)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('explore -> export on the role-drift fixture yields a NAME-only action target with roleHint', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(DRIFT_FIXTURE, 'utf8')
  const { server, origin } = await startFixtureServer(html)
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-rd-export-'))
  try {
    const outputPath = join(dir, 'role-drift-export.json')
    let exportedScenario = null
    await withDriver(join(dir, 'driver'), origin, async (driver) => {
      const recorder = new QaTrajectoryRecorder()
      const session = new QaSession(
        new RecordingQaDriverAdapter(new BrowserAdapter(driver), recorder),
        'rd-export-real',
        { settle: SETTLE },
      )
      // /slow: the recorded launch URL must be query-free (the recorder
      // rejects query/fragment URLs), so the 10s swap delay rides the path.
      await session.start({ url: origin + '/slow', headless: true })
      const before = await session.observeSettled()
      const input = before.observation.nodes.find((item) => item.name === 'Search site')
      assert.ok(input, 'the fixture must expose the search input')
      assert.equal(input.role, 'textbox', 'the recorded baseline still shows the server-rendered textbox')
      await session.act({ kind: 'fill', ref: input.ref, text: 'DeepSeek' })
      await session.stop()
      const exported = await exportRecordedScenario(recorder, 'rd-export-real', { outputPath })
      assert.equal(exported.ok, true, JSON.stringify(exported))
      assert.equal(exported.excludedActions.length, 0, JSON.stringify(exported.excludedActions))
      const step = exported.scenario.steps[0]
      assert.equal(step.action.kind, 'fill')
      assert.deepEqual(
        step.action.target,
        { name: 'Search site', roleHint: 'textbox' },
        'the action target is NAME-only; the live baseline role rides as an advisory roleHint',
      )
      exportedScenario = exported.scenario
    })
    const loaded = loadScenarioFromPath(outputPath)
    assert.deepEqual(loaded, exportedScenario, 'roleHint survives the fail-closed loader')
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
