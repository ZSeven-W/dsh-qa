import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'

// QA-BL-066: qa_assert within_ref over the REAL MCP stdio surface. A scoped
// deciding observation is what makes scoped absence reachable from Explore:
// the assertion is decided INSIDE the container (completeness.scope names it,
// the terminal coverage probe runs over the SUBTREE), a present target still
// fails with observed, a closed shadow root keeps the absence UNPROVEN, a
// ref from an EARLIER observation is refused as itself (never a whole-page
// decision), and without within_ref the decision stays whole-page with no
// scope.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'assert-scoped.html')

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

function valueFrom(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text
  assert.equal(typeof text, 'string')
  return JSON.parse(text)
}

test('qa_assert within_ref decides inside the container over the real MCP surface', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }
  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const fixture = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-assert-scoped-'))
  const scenarioPath = join(dir, 'assert-scoped-explored.json')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.mjs'],
    cwd: ROOT,
    env: { ...getDefaultEnvironment(), TMPDIR: tmpdir() },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-qa-assert-scoped-acceptance', version: '0.1.0' })
  const call = async (name, args) => valueFrom(await client.callTool({ name, arguments: args }))

  const ABSENT_TARGET = { role: 'link', name: 'Deep scoped target' }
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const assertTool = listed.tools.find((tool) => tool.name === 'qa_assert')
    assert.ok(assertTool, 'qa_assert must be listed')
    assert.ok(
      assertTool.inputSchema.properties && 'within_ref' in assertTool.inputSchema.properties,
      'qa_assert must advertise within_ref: ' + JSON.stringify(assertTool.inputSchema.properties),
    )

    const owner = 'assert-scoped-loop'
    await call('qa_session_start', { owner, driver: 'browser', url: origin, headless: true })
    // Every observe REPLACES the driver's current observation, so each scoped
    // qa_assert below starts from a FRESH whole-page qa_observe and takes its
    // container ref from THAT observation (a ref from an earlier observation
    // would be refused — see section 6).
    const containers = async () => {
      const observed = await call('qa_observe', { owner })
      const clean = observed.nodes.find((item) => item.role === 'region' && item.name === 'Clean container')
      const holder = observed.nodes.find((item) => item.role === 'region' && item.name === 'Target container')
      const shadowed = observed.nodes.find((item) => item.role === 'region' && item.name === 'Shadow container')
      assert.ok(clean && holder && shadowed, 'the fixture must expose all three containers: ' + JSON.stringify(observed.nodes.map((node) => node.name)))
      return { clean, holder, shadowed }
    }

    // 1. Scoped absence on a container that does NOT hold the target: the
    //    deciding observation is SCOPED, so the result passes with the scope
    //    named and the coverage probe verified over the subtree.
    const clean1 = (await containers()).clean
    const absent = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: clean1.ref })
    assert.equal(absent.ok, true, JSON.stringify(absent))
    assert.equal(absent.passed, true, JSON.stringify(absent))
    assert.equal(absent.kind, 'node-absent')
    assert.deepEqual(
      absent.completeness.scope,
      { role: 'region', name: 'Clean container' },
      'the completeness block must name the container the decision was scoped to: ' + JSON.stringify(absent.completeness),
    )
    assert.equal(absent.completeness.truncated, false, JSON.stringify(absent.completeness))
    assert.equal(absent.completeness.coverage.verified, true, JSON.stringify(absent.completeness))
    assert.match(absent.completeness.detail, /within the region named "Clean container"/)
    assert.match(absent.completeness.detail, /coverage verified/)

    // 2. The SAME assertion on the container that HOLDS the target: a
    //    returned matching node is sound evidence of presence, so it fails
    //    with observed — never a scoped "absent".
    const holder2 = (await containers()).holder
    const present = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: holder2.ref })
    assert.equal(present.ok, true, JSON.stringify(present))
    assert.equal(present.passed, false, JSON.stringify(present))
    assert.deepEqual(present.observed, { role: 'link', name: 'Deep scoped target', tag: 'a' })

    // 3. A container with a CLOSED shadow root: the coverage probe finds it,
    //    so the absence stays UNPROVEN and the reason names closed-shadow-root.
    const shadowed3 = (await containers()).shadowed
    const shadowy = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: shadowed3.ref })
    assert.equal(shadowy.ok, true, JSON.stringify(shadowy))
    assert.equal(shadowy.passed, false, JSON.stringify(shadowy))
    assert.ok(
      shadowy.completeness.reason === 'INCONCLUSIVE_TRUNCATED' || shadowy.completeness.reason === 'COVERAGE_UNVERIFIED',
      JSON.stringify(shadowy.completeness),
    )
    assert.ok(
      (shadowy.completeness.truncationReasons ?? []).includes('closed-shadow-root'),
      'the closed shadow root must be named: ' + JSON.stringify(shadowy.completeness),
    )
    assert.match(shadowy.completeness.detail, /closed-shadow-root/)

    // 4. WITHOUT within_ref the decision is whole-page (today's behaviour):
    //    the target is present on the page, and the result must make the
    //    whole-page decision visible — no scope anywhere.
    const whole = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET })
    assert.equal(whole.ok, true, JSON.stringify(whole))
    assert.equal(whole.passed, false, JSON.stringify(whole))
    assert.deepEqual(whole.observed, { role: 'link', name: 'Deep scoped target', tag: 'a' })
    assert.equal('scope' in (whole.completeness ?? {}), false, JSON.stringify(whole.completeness))

    // 5. The scoped-absence headline: a link missing from the ENTIRE page
    //    still cannot pass whole-page (the closed shadow root keeps it
    //    INCONCLUSIVE_TRUNCATED) — while the scoped assertion on the clean
    //    container proves the same absence.
    const wholeMissing = await call('qa_assert', { owner, kind: 'node-absent', expected: { role: 'link', name: 'Genuinely missing link' } })
    assert.equal(wholeMissing.ok, true, JSON.stringify(wholeMissing))
    assert.equal(wholeMissing.passed, false, JSON.stringify(wholeMissing))
    assert.equal(wholeMissing.completeness.reason, 'INCONCLUSIVE_TRUNCATED', JSON.stringify(wholeMissing.completeness))
    assert.ok(
      (wholeMissing.completeness.truncationReasons ?? []).includes('closed-shadow-root'),
      JSON.stringify(wholeMissing.completeness),
    )
    const clean5 = (await containers()).clean
    const scopedMissing = await call('qa_assert', { owner, kind: 'node-absent', expected: { role: 'link', name: 'Genuinely missing link' }, within_ref: clean5.ref })
    assert.equal(scopedMissing.ok, true, JSON.stringify(scopedMissing))
    assert.equal(scopedMissing.passed, true, JSON.stringify(scopedMissing))
    assert.deepEqual(scopedMissing.completeness.scope, { role: 'region', name: 'Clean container' })
    assert.equal(scopedMissing.completeness.coverage.verified, true)

    // 6. The refs an agent may pass after an intervening observe: after a
    //    SCOPED qa_observe the driver's latest observation is the scoped
    //    one, so only ITS refs resolve — the echoed scope.rootRef works,
    //    while a container ref from the EARLIER whole-page observation is
    //    stale and REFUSED as itself, never degraded into a whole-page
    //    decision.
    const wholeAgain = await call('qa_observe', { owner })
    const cleanRef = wholeAgain.nodes.find((item) => item.role === 'region' && item.name === 'Clean container')
    assert.ok(cleanRef)
    const scopedObserve = await call('qa_observe', { owner, within_ref: cleanRef.ref })
    assert.equal(scopedObserve.scope.name, 'Clean container', JSON.stringify(scopedObserve.scope))
    assert.ok(typeof scopedObserve.scope.rootRef === 'string' && scopedObserve.scope.rootRef.length > 0, JSON.stringify(scopedObserve.scope))
    const viaRootRef = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: scopedObserve.scope.rootRef })
    assert.equal(viaRootRef.ok, true, JSON.stringify(viaRootRef))
    assert.equal(viaRootRef.passed, true, JSON.stringify(viaRootRef))
    assert.deepEqual(viaRootRef.completeness.scope, { role: 'region', name: 'Clean container' })

    const stale = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: cleanRef.ref })
    assert.equal(stale.ok, false, JSON.stringify(stale))
    assert.equal(stale.code, 'REF_UNKNOWN', 'a ref from an observation the scoped observe replaced must be refused as REF_UNKNOWN: ' + JSON.stringify(stale))
    const bogus = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: 'br_bogus_ref' })
    assert.equal(bogus.ok, false, JSON.stringify(bogus))
    assert.equal(bogus.code, 'REF_UNKNOWN', JSON.stringify(bogus))

    // 7. Explore -> Export -> Replay: the scoped qa_assert is recorded with
    //    its deciding (scoped) observation and exports as a SCOPED final
    //    assertion; the replay passes it against the re-derived container.
    const beforeClick = await call('qa_observe', { owner })
    const trigger = beforeClick.nodes.find((item) => item.role === 'button' && item.name === 'Trigger check')
    assert.ok(trigger, JSON.stringify(beforeClick.nodes.map((node) => node.name)))
    const clicked = await call('qa_act', { owner, action: 'click', ref: trigger.ref })
    assert.ok(clicked.observation.nodes.some((item) => item.role === 'status' && item.name === 'PASS'), JSON.stringify(clicked.observation))
    const freshClean = clicked.observation.nodes.find((item) => item.role === 'region' && item.name === 'Clean container')
    assert.ok(freshClean, 'the post-action observation must carry a fresh clean-container ref')
    const finalAssert = await call('qa_assert', { owner, kind: 'node-absent', expected: ABSENT_TARGET, within_ref: freshClean.ref })
    assert.equal(finalAssert.ok, true, JSON.stringify(finalAssert))
    assert.equal(finalAssert.passed, true, JSON.stringify(finalAssert))

    const exported = await call('qa_record_export', {
      owner,
      output_path: scenarioPath,
      name: 'assert-scoped-explore-loop',
    })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    assert.equal(exported.scenario.steps.length, 1, JSON.stringify(exported.scenario.steps))
    const exportedScoped = exported.scenario.assertions.find(
      (item) => item.kind === 'node-absent' && item.scope !== undefined,
    )
    assert.ok(exportedScoped, 'the scoped qa_assert must export as a scoped final assertion: ' + JSON.stringify(exported.scenario.assertions))
    assert.deepEqual(exportedScoped.scope, { role: 'region', name: 'Clean container' })
    assert.deepEqual(exportedScoped.expected, ABSENT_TARGET)

    const replay = await call('qa_replay_run', {
      scenario: scenarioPath,
      owner: 'assert-scoped-replay',
      headless: true,
    })
    assert.equal(replay.status, 'pass', JSON.stringify(replay.failure))
    assert.ok(replay.steps.every((step) => step.assertionPassed === true))
    const replayedScoped = replay.assertions.find((item) => item.kind === 'node-absent')
    assert.equal(replayedScoped.passed, true, JSON.stringify(replayedScoped))
    assert.equal(replayedScoped.scopeResolution, 'proven', JSON.stringify(replayedScoped))
    assert.deepEqual(replayedScoped.scope, { role: 'region', name: 'Clean container' })
    await call('qa_session_stop', { owner })
  } finally {
    await client.close().catch(() => {})
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
