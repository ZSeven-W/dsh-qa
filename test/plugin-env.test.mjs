// The DSH_ -> DSHPLUGIN_ migration contract (src/plugin-env.ts).
//
// The rules under test are not cosmetic. DSH refuses to load any .env file
// that sets a DSH_-prefixed variable and aborts the host before plugins load,
// so the legacy names exist only to keep working shell exports alive — and a
// fallback that fired on an EMPTY new value would silently resurrect a stale
// override the user had just tried to clear.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LEGACY_ENV_PREFIX,
  PLUGIN_ENV_PREFIX,
  legacyEnvName,
  pluginEnv,
  pluginEnvName,
  resetPluginEnvWarnings,
} from '../src/plugin-env.ts'

/** Collect warnings instead of writing them to stderr. */
function capture() {
  const lines = []
  return { lines, warn: message => lines.push(message) }
}

test('the new prefix does not collide with the reserved one', () => {
  // The whole point: DSH's blacklist matches every name STARTING WITH "DSH_".
  assert.equal(PLUGIN_ENV_PREFIX.startsWith(LEGACY_ENV_PREFIX), false)
  assert.equal(pluginEnvName('QA_SETTLE_BUDGET_MS'), 'DSHPLUGIN_QA_SETTLE_BUDGET_MS')
  assert.equal(legacyEnvName('QA_SETTLE_BUDGET_MS'), 'DSH_QA_SETTLE_BUDGET_MS')
})

test('the new name wins, the legacy name is the fallback, absence is undefined', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  assert.equal(
    pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSHPLUGIN_QA_SETTLE_BUDGET_MS: 'new', DSH_QA_SETTLE_BUDGET_MS: 'old' }, warn: sink.warn }),
    'new',
  )
  resetPluginEnvWarnings()
  assert.equal(pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSH_QA_SETTLE_BUDGET_MS: 'old' }, warn: sink.warn }), 'old')
  assert.equal(pluginEnv('QA_SETTLE_BUDGET_MS', { env: {}, warn: sink.warn }), undefined)
})

test('resolution is by presence, so an empty new value does NOT fall back', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  // "I deliberately want no override here" must not resurrect the legacy value.
  assert.equal(
    pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSHPLUGIN_QA_SETTLE_BUDGET_MS: '', DSH_QA_SETTLE_BUDGET_MS: 'stale' }, warn: sink.warn }),
    '',
  )
})

test('a legacy variable warns exactly once per process, naming both sides', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  const env = { DSH_QA_SETTLE_BUDGET_MS: 'old' }
  pluginEnv('QA_SETTLE_BUDGET_MS', { env, warn: sink.warn })
  pluginEnv('QA_SETTLE_BUDGET_MS', { env, warn: sink.warn })
  pluginEnv('QA_SETTLE_BUDGET_MS', { env, warn: sink.warn })
  assert.equal(sink.lines.length, 1)
  assert.match(sink.lines[0], /DSH_QA_SETTLE_BUDGET_MS/)
  assert.match(sink.lines[0], /DSHPLUGIN_QA_SETTLE_BUDGET_MS/)
  // The remedy must say REPLACE: adding the new name beside the old one in a
  // .env file still aborts the host, so "also set the new one" is wrong advice.
  assert.match(sink.lines[0], /REPLACE/)
})

test('the warning never prints the value', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSH_QA_SETTLE_BUDGET_MS: '12345-private-budget' }, warn: sink.warn })
  assert.equal(sink.lines.length, 1)
  assert.equal(sink.lines[0].includes('12345-private-budget'), false)
})

test('a legacy variable still warns when the new name overrides it', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSHPLUGIN_QA_SETTLE_BUDGET_MS: 'new', DSH_QA_SETTLE_BUDGET_MS: 'old' }, warn: sink.warn })
  assert.equal(sink.lines.length, 1)
  assert.match(sink.lines[0], /takes precedence/)
})

test('a new-only variable is silent', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSHPLUGIN_QA_SETTLE_BUDGET_MS: 'new' }, warn: sink.warn })
  assert.deepEqual(sink.lines, [])
})

test('the plugin attributes its own warning', () => {
  resetPluginEnvWarnings()
  const sink = capture()
  pluginEnv('QA_SETTLE_BUDGET_MS', { env: { DSH_QA_SETTLE_BUDGET_MS: 'old' }, warn: sink.warn })
  assert.match(sink.lines[0], /^dsh-qa: /)
})

test('the legacy settle names still drive the resolved policy end to end', async () => {
  // Dual-read has to work through the REAL resolver, not only the reader:
  // existing shell exports must keep steering settle until 1.0 removes them.
  const { resolveSettlePolicy } = await import('../src/session/settle.ts')
  const prior = process.env.DSH_QA_SETTLE_BUDGET_MS
  try {
    process.env.DSH_QA_SETTLE_BUDGET_MS = '900'
    assert.equal(resolveSettlePolicy().budgetMs, 900)
  } finally {
    if (prior === undefined) delete process.env.DSH_QA_SETTLE_BUDGET_MS
    else process.env.DSH_QA_SETTLE_BUDGET_MS = prior
  }
})
