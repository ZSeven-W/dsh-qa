// Real native computer acceptance test (WP5). This is the macOS acceptance
// flow from the 2026-08-25 report, reproduced on top of the QA session core
// + ComputerAdapter + the self-built isolated fixture app:
//
//   - ordinary text entry, confirmed by a FRESH re-observation
//   - secure password entry PERMANENTLY rejected (even with an approval gate)
//   - safe button accepted; its 'unknown' receipt is NOT success, a fresh
//     observation proves the PASS state
//   - 'Publish release' rejected without approval; dispatched exactly once
//     with an allowed-once decision; the fixture-only published state is
//     proven by a fresh observation
//   - window-only capture with Set-of-Mark labels, written and recorded as a
//     structured artifact (QaArtifact path)
//   - session cleanup verified (scope disposed, fixture terminated)
//
// This test FAILS LOUDLY (never skips, never passes vacuously) when the
// platform is not macOS or when the DSH Computer Helper lacks Accessibility
// or Screen Recording permission: a missing grant throws an actionable error
// naming the exact helper and the System Settings location to fix.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputerController, NativeHelper } from '@zseven-w/dsh-computer'
import { ComputerAdapter } from '../src/adapters/index.ts'
import { QaSession } from '../src/session/index.ts'
import {
  FIXTURE_BUNDLE_ID,
  FIXTURE_WINDOW_TITLE,
  buildFixture,
} from '../fixtures/native/build-fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NATIVE_TMP = join(HERE, '.tmp-native')
const OWNER = 'dsh-qa-native-integration'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

async function fixturePid() {
  const out = sh('pgrep', ['-x', 'dsh-qa-fixture'])
  if (!out) return null
  const pid = Number(out.split('\n')[0])
  return Number.isInteger(pid) ? pid : null
}

async function launchFixture(appPath) {
  sh('pkill', ['-x', 'dsh-qa-fixture'])
  execFileSync('open', [appPath], { stdio: 'ignore' })
  for (let i = 0; i < 100; i += 1) {
    const pid = await fixturePid()
    if (pid !== null) return pid
    await sleep(100)
  }
  throw new Error('fixture app did not register a process after launch')
}

async function terminateFixture() {
  sh('pkill', ['-x', 'dsh-qa-fixture'])
  for (let i = 0; i < 50; i += 1) {
    if ((await fixturePid()) === null) return
    await sleep(100)
  }
}

function assertHelperReady(status) {
  if (status.platform !== 'macos') {
    throw new Error('DSH Computer Helper reports platform ' + status.platform + '; native QA requires macOS')
  }
  if (status.accessibilityTrusted !== true) {
    throw new Error(
      'Accessibility permission is NOT granted to the DSH Computer Helper (' + status.helperExecutable + '). ' +
      'Enable that exact helper in System Settings > Privacy & Security > Accessibility, then re-run. ' +
      'This native acceptance path will not pass (or silently green) without it.'
    )
  }
  if (status.screenRecordingTrusted !== true) {
    throw new Error(
      'Screen Recording permission is NOT granted to the DSH Computer Helper (' + status.helperExecutable + '). ' +
      'Enable that exact helper in System Settings > Privacy & Security > Screen Recording, then re-run. ' +
      'Window-only capture cannot be verified without it.'
    )
  }
  if (status.interactiveSessionAvailable !== true) {
    throw new Error(
      'the macOS interactive desktop session is locked or unavailable; unlock the session and re-run',
    )
  }
}

test('computer native acceptance flow', { timeout: 600_000 }, async () => {
  if (process.platform !== 'darwin') {
    throw new Error('computer native tests require macOS (darwin); current platform is ' + process.platform)
  }

  // Keep the DSH Computer Helper's staged binary inside the workspace so the
  // run is hermetic. The helper builds into the system temporary directory and
  // window capture MUST write there too (the native helper refuses any capture
  // path outside the system temporary directory), so TMPDIR is left untouched.
  await mkdir(NATIVE_TMP, { recursive: true })

  const appPath = buildFixture()
  const native = new NativeHelper({ cacheRoot: join(NATIVE_TMP, 'helper-cache') })
  const driver = new ComputerController({ native })
  const adapter = new ComputerAdapter(driver)
  const session = new QaSession(adapter, OWNER)
  let pid = null

  try {
    // ---- helper preflight: permissions must be REAL, never assumed ------
    const preflight = await adapter.evidence(OWNER)
    assertHelperReady(preflight.computer.status)

    pid = await launchFixture(appPath)
    await sleep(500)
    const info = await session.start({ bundleId: FIXTURE_BUNDLE_ID, pid, windowTitle: FIXTURE_WINDOW_TITLE })
    assert.equal(info.headless, false)

    // ---- ordinary text entry, confirmed by re-observation --------------
    const initial = await session.observe()
    const plainField = initial.nodes.find((n) => n.tag === 'fixture.plainText')
    assert.ok(plainField, 'plain text field present')
    assert.equal(plainField.secure, false)
    const typed = await session.act({ kind: 'type', ref: plainField.ref, text: 'v1.0.0' })
    assert.equal(typed.outcome, 'ok')
    assert.equal(typed.receipt.status, 'confirmed')
    const reObserved = await session.observe()
    const plainAfter = reObserved.nodes.find((n) => n.tag === 'fixture.plainText')
    assert.equal(plainAfter.value, 'v1.0.0', 'typed value confirmed by a FRESH re-observation')

    // ---- secure field is permanently rejected, even with an approval gate ----
    const secureField = reObserved.nodes.find((n) => n.tag === 'fixture.securePassword')
    assert.ok(secureField, 'secure field present')
    assert.equal(secureField.secure, true)
    let secureGateCalls = 0
    const secureGate = { request: async () => { secureGateCalls += 1; return 'allowed-once' } }
    const secureResult = await session.act({ kind: 'type', ref: secureField.ref, text: 'hunter2' }, secureGate)
    assert.equal(secureResult.outcome, 'failed')
    assert.equal(secureResult.receipt.status, 'rejected')
    assert.equal(secureResult.receipt.code, 'secure-text')
    assert.equal(secureResult.receipt.dispatched, false)
    assert.equal(secureGateCalls, 0, 'a secure field never reaches the approval gate')
    const afterSecure = await session.observe()
    const secureAfter = afterSecure.nodes.find((n) => n.tag === 'fixture.securePassword')
    assert.equal(secureAfter.value, null, 'secure value is never exposed')

    // ---- safe button accepted; unknown receipt resolved by fresh observation ----
    const safeButton = afterSecure.nodes.find((n) => n.tag === 'fixture.safeAction')
    assert.ok(safeButton, 'safe button present')
    const safeResult = await session.act({ kind: 'click', ref: safeButton.ref })
    assert.equal(safeResult.outcome, 'unknown', 'a click receipt is never promoted to success')
    assert.equal(safeResult.receipt.status, 'unknown')
    const afterSafe = await session.observe()
    const statusNode = afterSafe.nodes.find((n) => n.tag === 'fixture.status')
    assert.equal(statusNode.value, 'PASS: CU complete flow', 'effect proven by a fresh observation, not the receipt')

    // ---- Publish release rejected without host approval --------------------
    const publishButton = afterSafe.nodes.find((n) => n.tag === 'fixture.publishRelease')
    assert.ok(publishButton, 'Publish release control present')
    const denied = await session.act({ kind: 'click', ref: publishButton.ref })
    assert.equal(denied.outcome, 'failed')
    assert.equal(denied.receipt.status, 'rejected')
    assert.equal(denied.receipt.code, 'APPROVAL_REQUIRED')
    assert.equal(denied.receipt.dispatched, false)

    // ---- allowed-once dispatches exactly once; fresh observation proves it ----
    const prePublish = await session.observe()
    const publishAgain = prePublish.nodes.find((n) => n.tag === 'fixture.publishRelease')
    assert.ok(publishAgain, 'Publish release control re-observed')
    let onceGateCalls = 0
    const onceGate = { request: async () => { onceGateCalls += 1; return 'allowed-once' } }
    const allowed = await session.act({ kind: 'click', ref: publishAgain.ref }, onceGate)
    assert.equal(allowed.receipt.status, 'unknown')
    assert.equal(allowed.receipt.dispatched, true)
    assert.equal(onceGateCalls, 1, 'an allowed-once decision is requested exactly once')
    const afterPublish = await session.observe()
    const publishState = afterPublish.nodes.find((n) => n.tag === 'fixture.publishState')
    assert.equal(publishState.value, 'PUBLISHED: 1', 'publish dispatched exactly once (not twice)')

    // ---- window-only capture with Set-of-Mark labels, recorded as an artifact ----
    const forVisual = await session.observe({ ttlMs: 30_000 })
    const capture = await adapter.visualObserve(OWNER, forVisual.observationId)
    assert.equal(capture.usable, true, 'window capture must be usable')
    assert.ok(capture.marks >= 1, 'capture must carry at least one Set-of-Mark label')
    assert.ok(capture.width > 0 && capture.height > 0, 'capture has pixel dimensions')
    const artifactsDir = join(NATIVE_TMP, 'artifacts')
    await mkdir(artifactsDir, { recursive: true })
    const pngPath = join(artifactsDir, 'computer-visual-observe.png')
    await writeFile(pngPath, capture.png)
    const capturedStat = await stat(pngPath)
    assert.ok(capturedStat.size > 0, 'capture PNG was written')
    const qaArtifact = { path: pngPath, kind: 'screenshot' }

    // ---- session cleanup verified ---------------------------------------
    const stop = await session.stop()
    assert.equal(stop.stopped, true)
    const postStop = await adapter.evidence(OWNER)
    assert.equal(postStop.computer.activeObservations, 0, 'driver scope has no residual observations')
    await adapter.dispose()

    // Report the structured artifact so the run is readable via the path
    // projection (never free text). This mirrors report.artifacts[].path.
    assert.ok(qaArtifact.path.startsWith(NATIVE_TMP), 'artifact path is the structured capture file')
  } finally {
    await session.stop().catch(() => {})
    await adapter.dispose().catch(() => {})
    await terminateFixture()
    await rm(NATIVE_TMP, { recursive: true, force: true }).catch(() => {})
  }
})
