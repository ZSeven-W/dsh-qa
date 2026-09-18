// WP9 live-vision integration test. This is the ONE real-call seam: a real
// capture plus a real ctx.llm.stream call through the host's injectable
// `llm` and `attachments` services. Those services only exist inside the DSH
// host runtime; plain `pnpm test` runs in Node without them, so when they are
// absent this test skips with an honest reason instead of passing vacuously.
// The seam itself is fully exercised with a fake llm in test/visual.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateVisualQuestion } from '../src/vision.ts'

// The DSH host exposes `llm`/`attachments` through the Cordis context. A plain
// Node test process has no such context, so an explicit opt-in seam is used: a
// host-integrated runner may publish the live services on globalThis before
// importing this module. This never guesses or reads credential files.
function resolveHostVisionServices() {
  const host = globalThis.__DSH_QA_LIVE_VISION__
  if (host !== null && typeof host === 'object') {
    if (typeof host.llm?.stream === 'function' && typeof host.attachments?.saveImage === 'function') {
      return host
    }
  }
  return undefined
}

test('live vision: real capture + real ctx.llm.stream against the fixture', async (t) => {
  const services = resolveHostVisionServices()
  if (services === undefined) {
    t.skip('vision model host services (ctx.llm/attachments) are unavailable in this runtime; WP9 verification therefore reports "not verified" — the seam is covered by a fake llm in test/visual.test.mjs')
    return
  }
  // A DECODABLE 2x2 solid-red PNG, not just the 8-byte signature. The previous
  // fixture could not be decoded by any model, so nothing downstream of "the
  // request was accepted" was ever exercised.
  const SOLID_RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGO4IyICRAwQCgAfngQRsu1RiQAAAABJRU5ErkJggg=='
  const capture = {
    driver: 'browser',
    observationFingerprint: 'live',
    observationId: null,
    png: Uint8Array.from(Buffer.from(SOLID_RED_PNG_BASE64, 'base64')),
    width: 2,
    height: 2,
    sha256: 'live-sha',
    usable: true,
    marks: 0,
    omitted: 0,
  }
  const finding = await evaluateVisualQuestion('Is this image a single solid color?', capture, services)

  // The degradation path returns verdict 'unclear' with a receiptCode, so
  // accepting 'unclear' accepted a run in which the vision call FAILED. This
  // test exists to prove the live provider answered; anything else means the
  // gap it is supposed to close is still open.
  assert.equal(
    finding.receiptCode,
    undefined,
    'a degraded finding proves nothing about the live vision path: ' + JSON.stringify(finding),
  )
  assert.ok(
    finding.verdict === 'yes' || finding.verdict === 'no',
    'the model must have actually answered, not degraded to unclear: ' + JSON.stringify(finding),
  )
  assert.ok(typeof finding.confidence === 'number')
  assert.ok(typeof finding.reasoning === 'string')
  // The image really is one solid colour; a live model that says otherwise is
  // a finding worth failing on, not something to wave through.
  assert.equal(finding.verdict, 'yes', 'a 2x2 solid-red PNG is a single solid colour: ' + JSON.stringify(finding))
})

