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
  // A real capture is a browser/computer driver concern; here we exercise the
  // exact model seam with a tiny in-memory PNG so a host-integrated run proves
  // the provider route accepts an image block end to end.
  const capture = {
    driver: 'browser',
    observationFingerprint: 'live',
    observationId: null,
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    width: 1,
    height: 1,
    sha256: 'live-sha',
    usable: true,
    marks: 0,
    omitted: 0,
  }
  const finding = await evaluateVisualQuestion('Is this a solid color?', capture, services)
  assert.ok(['yes', 'no', 'unclear'].includes(finding.verdict))
  assert.ok(typeof finding.confidence === 'number')
  assert.ok(typeof finding.reasoning === 'string')
})

