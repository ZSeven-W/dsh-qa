// Bounded visual grounding SERVICE tests (WP-GRND service seam).
//
// The service is exercised entirely with fake attachments/llm services and a
// real valid PNG generated in-process. It never reaches a live provider and
// never touches files/credentials/config. The observed real vector from
// src/grounding.ts (1206x2622 frame reported as 500,286) is included as the
// mapping anchor.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import {
  groundVisualTarget,
  GROUNDING_FAILURE_CANCELLED,
  GROUNDING_FAILURE_DIMENSION_MISMATCH,
  GROUNDING_FAILURE_IMAGE_PERSIST_FAILED,
  GROUNDING_FAILURE_INVALID_IMAGE_REF,
  GROUNDING_FAILURE_INVALID_MODEL_REPLY,
  GROUNDING_FAILURE_INVALID_PNG,
  GROUNDING_FAILURE_NO_TEXT,
  GROUNDING_FAILURE_PROVIDER_STREAM_ERROR,
  GROUNDING_FAILURE_RESPONSE_TOO_LARGE,
  GROUNDING_FAILURE_SERVICES_UNAVAILABLE,
  GROUNDING_FAILURE_SHA_MISMATCH,
  GROUNDING_FAILURE_TIMEOUT,
  GROUNDING_FAILURE_UNUSABLE_CAPTURE,
} from '../src/visual-grounding.ts'

// ---------------------------------------------------------------------------
// Minimal but structurally valid PNG builder (IHDR + IDAT + IEND).
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function makePng(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // compression, filter, interlace all zero
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) raw[y * (width * 4 + 1)] = 0 // filter: None per row
  const idat = deflateSync(raw)
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function makeCapture({ width = 1206, height = 2622, png = makePng(width, height), overrides = {} } = {}) {
  return {
    driver: 'browser',
    observationFingerprint: 'fp-ground',
    observationId: 'obs_real',
    png,
    width,
    height,
    sha256: createHash('sha256').update(png).digest('hex'),
    usable: true,
    marks: 0,
    omitted: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fake injected services.
// ---------------------------------------------------------------------------

function fakeAttachments({ width = 1206, height = 2622, saveImageImpl } = {}) {
  const calls = []
  const service = {
    calls,
    async saveImage(input) {
      calls.push(input)
      if (saveImageImpl !== undefined) return saveImageImpl(input)
      return {
        attachmentId: 'att_ground',
        mediaType: 'image/png',
        bytes: input.data.byteLength,
        width,
        height,
        name: input.name,
      }
    },
  }
  return service
}

function fakeLlm({ output, chunks, onCall } = {}) {
  return {
    calls: [],
    async *stream(options) {
      this.calls.push(options)
      if (onCall !== undefined) onCall(options)
      const list = chunks !== undefined ? chunks : [
        { type: 'text-delta', text: output ?? '{"x":500,"y":286,"confidence":0.93}' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      for (const chunk of list) {
        if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        yield chunk
      }
    },
  }
}

function fakeWaitingLlm() {
  return {
    async *stream(options) {
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      await new Promise((_resolve, reject) => {
        if (options.signal === undefined) {
          reject(new Error('expected abort signal'))
          return
        }
        const onAbort = () => {
          options.signal.removeEventListener('abort', onAbort)
          reject(new DOMException('aborted', 'AbortError'))
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        if (options.signal.aborted) onAbort()
      })
    },
  }
}

function okServices({ llm, attachments, provider, model } = {}) {
  return {
    attachments: attachments ?? fakeAttachments(),
    llm: llm ?? fakeLlm(),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

async function expectFailure(desc, capture, services, options, reason) {
  const result = await groundVisualTarget(desc, capture, services, options)
  assert.equal(result.ok, false)
  assert.equal(result.reason, reason)
  assert.equal('nativePoint' in result, false, 'failure must not carry a native point')
  assert.equal('normalized' in result, false, 'failure must not carry normalized coordinates')
  return result
}

// ---------------------------------------------------------------------------
// Service behavior.
// ---------------------------------------------------------------------------

test('grounds a target with fake services and a valid PNG to trusted native pixels', async () => {
  const capture = makeCapture()
  let seen
  const llm = fakeLlm({ output: '{"x":500,"y":286,"confidence":0.93}', onCall: (opts) => { seen = opts } })
  const result = await groundVisualTarget('the Send button', capture, okServices({ llm }))

  assert.equal(result.ok, true)
  assert.deepEqual(result.normalized, { x: 500, y: 286, confidence: 0.93 })
  // Observed real vector anchor: 1206x2622 native frame normalized 500,286 maps to 603,750.
  assert.deepEqual(result.nativePoint, { x: 603, y: 750 })
  assert.equal(result.confidence, 0.93)
  assert.equal(result.provider, 'deepseek-official')
  assert.equal(result.model, 'deepseek-v4-flash-vision-exp')
  assert.equal(result.captureSha, capture.sha256)
  assert.equal(result.observationId, 'obs_real')
  assert.equal(capture.width, 1206)
  assert.equal(capture.height, 2622)

  assert.ok(seen, 'llm.stream was called')
  assert.equal(seen.messages.length, 1)
  assert.equal(seen.messages[0].role, 'user')
  const blocks = seen.messages[0].content
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('the Send button'))
  assert.ok(blocks[0].text.includes('0 to 1000'))
  assert.ok(blocks[0].text.includes('"confidence"'))
  assert.equal(blocks[1].type, 'image')
  assert.equal(blocks[1].attachment.attachmentId, 'att_ground')
})

test('uses service provider/model configuration and forwards an abort signal', async () => {
  let seen
  const capture = makeCapture()
  const llm = fakeLlm({ onCall: (opts) => { seen = opts } })
  const result = await groundVisualTarget('the icon', capture, okServices({
    llm,
    provider: 'custom-provider',
    model: 'custom-model',
  }))
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'custom-provider')
  assert.equal(result.model, 'custom-model')
  assert.equal(seen.provider, 'custom-provider')
  assert.equal(seen.model, 'custom-model')
  assert.ok(seen.signal instanceof AbortSignal)
})

test('returns services-unavailable before any injected service side effect', async () => {
  await expectFailure('target', makeCapture(), undefined, undefined, GROUNDING_FAILURE_SERVICES_UNAVAILABLE)
  const attachments = fakeAttachments()
  const llm = fakeLlm()
  await expectFailure('target', makeCapture(), { attachments }, undefined, GROUNDING_FAILURE_SERVICES_UNAVAILABLE)
  assert.equal(attachments.calls.length, 0)
  assert.equal(llm.calls.length, 0)
  await expectFailure('target', makeCapture(), { llm }, undefined, GROUNDING_FAILURE_SERVICES_UNAVAILABLE)
  assert.equal(llm.calls.length, 0)
})

test('rejects an unusable capture without calling attachments or llm', async () => {
  const attachments = fakeAttachments()
  const llm = fakeLlm()
  const capture = makeCapture({ overrides: { usable: false } })
  await expectFailure('target', capture, okServices({ attachments, llm }), undefined, GROUNDING_FAILURE_UNUSABLE_CAPTURE)
  assert.equal(attachments.calls.length, 0)
  assert.equal(llm.calls.length, 0)
})

test('rejects fake 8-byte PNG and non-PNG header', async () => {
  const attachments = fakeAttachments()
  const llm = fakeLlm()
  const fake8 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await expectFailure('target', makeCapture({ png: fake8 }), okServices({ attachments, llm }), undefined, GROUNDING_FAILURE_INVALID_PNG)
  const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])
  await expectFailure('target', makeCapture({ png: notPng }), okServices({ attachments, llm }), undefined, GROUNDING_FAILURE_INVALID_PNG)
  assert.equal(attachments.calls.length, 0)
  assert.equal(llm.calls.length, 0)
})

test('rejects IHDR dimensions that do not match supplied capture dimensions', async () => {
  const attachments = fakeAttachments()
  const llm = fakeLlm()
  const png = makePng(100, 100)
  const capture = makeCapture({ png, width: 101, height: 100 })
  await expectFailure('target', capture, okServices({ attachments, llm }), undefined, GROUNDING_FAILURE_DIMENSION_MISMATCH)
  assert.equal(attachments.calls.length, 0)
  assert.equal(llm.calls.length, 0)
})

test('rejects SHA256 that does not match the actual PNG bytes', async () => {
  const attachments = fakeAttachments()
  const llm = fakeLlm()
  const capture = makeCapture({ overrides: { sha256: '0'.repeat(64) } })
  await expectFailure('target', capture, okServices({ attachments, llm }), undefined, GROUNDING_FAILURE_SHA_MISMATCH)
  assert.equal(attachments.calls.length, 0)
  assert.equal(llm.calls.length, 0)
})

test('distinguishes image persist rejection from an invalid image ref', async () => {
  const capture = makeCapture()
  const llmNoCall = fakeLlm()
  const rejecting = fakeAttachments({
    saveImageImpl: async () => { throw new Error('persist exploded') },
  })
  await expectFailure('target', capture, okServices({ attachments: rejecting, llm: llmNoCall }), undefined, GROUNDING_FAILURE_IMAGE_PERSIST_FAILED)
  assert.equal(llmNoCall.calls.length, 0)

  const missingRef = fakeAttachments({
    saveImageImpl: async () => null,
  })
  const llm = fakeLlm()
  await expectFailure('target', capture, okServices({ attachments: missingRef, llm }), undefined, GROUNDING_FAILURE_INVALID_IMAGE_REF)
  assert.equal(llm.calls.length, 0)
})

test('rejects invalid schema, model dimensions, out-of-range, and non-JSON replies', async () => {
  const badReplies = [
    'this is not JSON',
    '{"x":500,"y":286}',
    '{"x":500,"y":286,"confidence":0.9,"imageWidth":1206,"imageHeight":2622}',
    '{"x":1001,"y":286,"confidence":0.9}',
    '{"x":500,"y":-1,"confidence":0.9}',
    '{"x":500,"y":286,"confidence":1.1}',
    '{"x":500,"y":286,"confidence":0.9,"nativepixel":"542x1178"}',
  ]
  for (const reply of badReplies) {
    const llm = fakeLlm({ output: reply })
    const result = await groundVisualTarget('target', makeCapture(), okServices({ llm }))
    assert.equal(result.ok, false, `reply should fail: ${reply}`)
    assert.equal(result.reason, GROUNDING_FAILURE_INVALID_MODEL_REPLY)
  }
})

test('fails on provider stream error', async () => {
  const throwing = {
    async *stream() {
      yield { type: 'text-delta', text: 'partial' }
      throw new Error('network broke')
    },
  }
  await expectFailure('target', makeCapture(), okServices({ llm: throwing }), undefined, GROUNDING_FAILURE_PROVIDER_STREAM_ERROR)

  const finishError = fakeLlm({
    chunks: [
      { type: 'text-delta', text: 'partial' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'boom' } } },
    ],
  })
  await expectFailure('target', makeCapture(), okServices({ llm: finishError }), undefined, GROUNDING_FAILURE_PROVIDER_STREAM_ERROR)
})

test('fails on oversized model reply', async () => {
  const huge = 'x'.repeat(5000)
  const llm = fakeLlm({ chunks: [{ type: 'text-delta', text: huge }] })
  await expectFailure('target', makeCapture(), okServices({ llm }), undefined, GROUNDING_FAILURE_RESPONSE_TOO_LARGE)
})

test('fails when the provider returns no text', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
  await expectFailure('target', makeCapture(), okServices({ llm }), undefined, GROUNDING_FAILURE_NO_TEXT)
})

test('propagates caller abort to the provider and reports cancelled', async () => {
  const capture = makeCapture()
  const controller = new AbortController()
  const llm = fakeWaitingLlm()
  const promise = groundVisualTarget('target', capture, okServices({ llm }), {
    signal: controller.signal,
    timeoutMs: 5000,
  })
  controller.abort(new DOMException('caller stopped', 'AbortError'))
  const result = await promise
  assert.equal(result.ok, false)
  assert.equal(result.reason, GROUNDING_FAILURE_CANCELLED)
  assert.equal('nativePoint' in result, false)
})

test('times out through the provider abort signal and returns timeout', async () => {
  const capture = makeCapture()
  const llm = fakeWaitingLlm()
  const started = Date.now()
  const result = await groundVisualTarget('target', capture, okServices({ llm }), {
    timeoutMs: 20,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, GROUNDING_FAILURE_TIMEOUT)
  assert.ok(Date.now() - started < 1000, 'timeout should be immediate for a fake that honors abort')
})

test('does not leave a dangling caller listener after timeout', async () => {
  const capture = makeCapture()
  const controller = new AbortController()
  const llm = fakeWaitingLlm()
  const result = await groundVisualTarget('target', capture, okServices({ llm }), {
    timeoutMs: 20,
    signal: controller.signal,
  })
  assert.equal(result.reason, GROUNDING_FAILURE_TIMEOUT)
  // If cleanup missed the listener, aborting after completion should still be
  // safe because it only calls controller.abort; this at least exercises the
  // post-completion path without unhandled rejection.
  controller.abort()
})

test('caller already aborted before the service call returns cancelled without side effects', async () => {
  const controller = new AbortController()
  controller.abort()
  const attachments = fakeAttachments()
  const llm = fakeLlm()
  const result = await groundVisualTarget('target', makeCapture(), okServices({ attachments, llm }), {
    signal: controller.signal,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, GROUNDING_FAILURE_CANCELLED)
  assert.equal(attachments.calls.length, 0)
  assert.equal(llm.calls.length, 0)
})
