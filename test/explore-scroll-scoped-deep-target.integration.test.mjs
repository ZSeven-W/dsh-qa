// QA-BL-050 -> QA-BL-055 (pinned exclusion until contract v9 identity
// anchor — QA-BL-055): the SCOPED record-time escalation that used to prove a
// deep scroll target (whole-page position 102) was RETIRED because a
// container-heuristic root plus a same-identity twin can satisfy the proof
// without the acted element actually being inside the container. The
// whole-page escalation (QA-BL-045/047) remains, and it cannot reach the
// target (the driver clamps maxNodes to 100). This real-browser test now pins
// the HONEST outcome: the deep target is NOT proven, qa_act shows NO
// proofEscalated, and export EXCLUDES the scroll step with the scroll-specific
// detail (NO_PROVEN_STEPS). The fixture STAYS so Phase B (contract v9 identity
// anchor, QA-BL-055) can restore the capability with identity-safe evidence.
//
// Explore flow: whole-page observe (find the container) -> scoped observe
// within the container (find the target's ref) -> scroll to the ref -> the
// whole-page escalation fails to return the target -> the settled observation
// stays the proof -> export excludes the scroll step.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverInstalledBrowser } from '@zseven-w/dsh-browser'
import { createQaTools, QaToolHost } from '../src/tools.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_HTML = join(ROOT, 'fixtures', 'web', 'scoped-deep-target.html')

const TARGET = { role: 'link', name: 'Deep Target' }
const CONTAINER = { role: 'region', name: 'Deep zone' }

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server.address().port
}

test('deep scroll target beyond the whole-page clamp -> pinned exclusion until the v9 identity anchor (QA-BL-055)', { timeout: 300_000 }, async (t) => {
  try {
    await discoverInstalledBrowser()
  } catch (error) {
    t.skip('installed Chrome/Edge/Chromium unavailable: ' + error.message)
    return
  }

  const html = await readFile(FIXTURE_HTML, 'utf8')
  let port = 0
  const fixture = createServer((req, res) => {
    void req
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  port = await listen(fixture)
  const origin = 'http://127.0.0.1:' + port
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scoped-deep-scroll-'))
  const scenarioPath = join(dir, 'explored.json')
  const host = new QaToolHost()
  const tools = createQaTools(host)
  const call = (definition, args) => definition.execute(args, { agent: { id: 'scoped-deep-scroll-agent' } })

  try {
    const owner = 'scoped-deep-scroll-explore'
    const started = await call(tools.qaSessionStart, { owner, driver: 'browser', url: origin, headless: true })
    assert.equal(started.headless, true)

    // 1. The defect precondition, observed for real: NO whole-page budget can
    //    return the target. The default window is truncated without it, and
    //    the clamped 100-node window is truncated without it too — this is the
    //    case the (now whole-page-only) escalation can never prove.
    const initial = await call(tools.qaObserve, { owner })
    assert.equal(initial.truncated, true, 'the fixture must exceed the default 60-node budget')
    assert.equal(
      initial.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the target sits beyond the default window',
    )
    const wide = await call(tools.qaObserve, { owner, max_nodes: 100 })
    assert.equal(wide.truncated, true, 'the fixture also exceeds the clamped 100-node budget')
    assert.equal(
      wide.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the target sits beyond the clamped 100-node whole-page window: no whole-page escalation can prove it',
    )

    // 2. The container IS inside the default window: scope to it and read the
    //    target's ref (exactly like a scoped Explore read). The within ref must
    //    come from the CURRENT (latest) observation — the wide observe above
    //    consumed the initial one's refs.
    const containerNode = wide.nodes.find(
      (item) => item.role === CONTAINER.role && item.name === CONTAINER.name,
    )
    assert.ok(containerNode, 'the container must be inside the whole-page windows')
    const scoped = await call(tools.qaObserve, { owner, within_ref: containerNode.ref, max_nodes: 100 })
    assert.deepEqual(
      scoped.scope === undefined ? undefined : { role: scoped.scope.role, name: scoped.scope.name },
      CONTAINER,
      'the scoped observe echoes the container root',
    )
    assert.equal(scoped.truncated, false, 'the container subtree fits the subtree budget completely')
    const target = scoped.nodes.find((item) => item.role === TARGET.role && item.name === TARGET.name)
    assert.ok(target, 'the scoped view returns the unique target')
    assert.equal(target.inViewport, false, 'the target starts below the fold')

    // 3. Scroll to the target's ref. CHANGED (QA-BL-055): the retired scoped
    //    escalation is gone, and the ONE whole-page escalation (clamped to
    //    100 nodes) cannot return the target at position 102 — so the proof is
    //    NOT escalated and the deep target is NOT proven. qa_act must show no
    //    proofEscalated and keep the settled whole-page observation.
    const scrolled = await call(tools.qaAct, { owner, action: 'scroll', ref: target.ref })
    assert.equal(scrolled.outcome, 'ok')
    assert.equal(scrolled.receipt.status, 'confirmed')
    assert.equal(scrolled.proofEscalated, undefined, 'the record-time escalation was NOT accepted: the deep target stays unproven')
    assert.equal(scrolled.observation.scope, undefined, 'the proof stays the settled WHOLE-PAGE view')
    assert.equal(scrolled.observation.truncated, true, 'the proof stays the settled truncated view')
    assert.equal(
      scrolled.observation.nodes.some((item) => item.name === 'Deep Target'),
      false,
      'the deep target never appears in the whole-page proof view',
    )

    // 4. Export: the scroll step is NOT proven, so it is EXCLUDED with the
    //    scroll-specific detail (and, with no other step, the export refuses
    //    with NO_PROVEN_STEPS). It is never exported unscoped — and it is
    //    never exported as proven when it is not.
    const exported = await call(tools.qaRecordExport, {
      owner,
      output_path: scenarioPath,
      name: 'fixture-scoped-deep-scroll',
    })
    assert.equal(exported.ok, false, 'the unproven scroll cannot export a scenario')
    assert.equal(exported.code, 'NO_PROVEN_STEPS', JSON.stringify(exported))
    assert.equal(exported.excludedActions.length, 1, JSON.stringify(exported.excludedActions))
    const exclusion = exported.excludedActions[0]
    assert.equal(exclusion.reason, 'ASSERTION_NOT_PROVABLE')
    assert.match(
      exclusion.detail,
      /truncated at the driver node budget and did not return the scroll target "Deep Target"/,
      'the exclusion names the actual scroll cause, never the click/fill wording',
    )
    assert.match(exclusion.detail, /scroll outcome is unproven/)

    await call(tools.qaSessionStop, { owner })
  } finally {
    await host.dispose()
    fixture.closeAllConnections?.()
    await new Promise((resolve) => fixture.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
