import test from 'node:test'
import assert from 'node:assert/strict'
import {
  observeUntilStable,
  QaSession,
  resolveSettlePolicy,
} from '../src/session/index.ts'

// The post-change quiet rule (QA-BL-034). Once awaitChange has been satisfied
// by a non-echo delta, the quiet window required to conclude stable:true
// lengthens from quietMs to postChangeQuietMs (default 2x quietMs), measured
// from the last change. This closes the "one settle proves the whole outcome"
// hole: early unrelated churn (a sibling mirroring the typed value, a late
// hydration rename) used to satisfy awaitChange and then close the window after
// ONE quietMs, so a real outcome landing later (a suggestion list at ~400ms)
// was left out of the proof observation.
//
// The two Grok cases (duplicate-role-name-tag-masks-sibling-value and
// empty-name-echo-masks-all-textboxes) are ported here at a scale where the
// 400ms suggestion is genuinely observed under the DEFAULT 2x multiplier but
// genuinely missed under the old single-quietMs rule: quiet 200 -> postChange
// 400 means the old rule closes at ~80+200=280ms (miss), while the new rule
// holds to ~400+400=800ms (observe). The echo MASK correctness for the same
// shapes lives in test/echo-mask-regression.test.mjs at a smaller scale.

// sibling mirror at 80ms + suggestion at 400ms: the old quietMs=200 rule misses,
// the default 2x (postChange=400) observes. budget > 400+400 for the settle to
// finish.
const SCALE_400 = resolveSettlePolicy({ budgetMs: 1100, quietMs: 200, intervalMs: 15 })
const SMALL = resolveSettlePolicy({ budgetMs: 900, quietMs: 120, intervalMs: 15 }) // postChange 240

const SUGGEST_AT = 400
const MIRROR_AT = 80
const CHURN_AT = 20

function node(ref, role, name, tag, extra = {}) {
  return {
    ref,
    role,
    name,
    tag,
    interactive: role !== 'status' && role !== 'option',
    editable: role === 'textbox',
    disabled: false,
    ...extra,
  }
}

function observation({ url = 'https://example.test/', title = 'fixture', nodes = [] } = {}) {
  return { page: { url, title }, nodes, truncated: false }
}

function timedAdapter({ afterAct }) {
  let actedAt = null
  return {
    kind: 'browser',
    async start(_owner, options) {
      return { page: { url: options?.url ?? 'https://example.test/', title: 'fixture' }, headless: true }
    },
    async observe() {
      const since = actedAt === null ? null : Date.now() - actedAt
      return afterAct(since)
    },
    async act() {
      actedAt = Date.now()
      return { status: 'confirmed', dispatched: true }
    },
    async evidence() { return { console: [], network: [], bounded: true, dropped: { console: 0, network: 0 } } },
    async stop() { return { stopped: true, reason: 'requested' } },
  }
}

async function runAct(adapter, action, settle) {
  const session = new QaSession(adapter, 'post-change-' + action.kind, { settle })
  await session.start({ url: 'https://example.test/' })
  await session.observeSettled()
  const acted = await session.act(action)
  await session.stop()
  return acted
}

test('duplicate role/name/tag twins: the 80ms sibling mirror no longer cuts off the 400ms suggestion', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const aVal = since === null ? '' : 'typed'
      const bVal = since !== null && since >= MIRROR_AT ? 'mirror-of-typed' : ''
      const nodes = [
        node('a', 'textbox', 'Email', 'input', { value: aVal }),
        node('b', 'textbox', 'Email', 'input', { value: bVal }),
      ]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'a', text: 'typed' }, SCALE_400)
  const hasSuggest = acted.observation.nodes.some((n) => n.name === 'Async rendering')
  assert.equal(acted.settle.stable, true, JSON.stringify(acted.settle))
  assert.equal(hasSuggest, true, 'the suggestion must be inside the settled proof observation')
  assert.ok(acted.settle.elapsedMs >= SUGGEST_AT, 'the window must wait past the sibling mirror to the suggestion')
  assert.ok(acted.settle.elapsedMs < SCALE_400.budgetMs, 'but still conclude within the budget')
  assert.equal(acted.settle.quietRequiredMs, SCALE_400.postChangeQuietMs, 'the post-change quiet requirement applied')
})

test('empty-named echo must not mask a named sibling; the 80ms mirror no longer cuts off the 400ms suggestion', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const aVal = since === null ? '' : 'typed'
      const searchVal = since !== null && since >= MIRROR_AT ? 'live-query' : ''
      const nodes = [
        node('a', 'textbox', '', 'input', { value: aVal }),
        node('s', 'textbox', 'Search articles', 'input', { value: searchVal }),
      ]
      if (since !== null && since >= SUGGEST_AT) nodes.push(node('opt', 'option', 'Async rendering', 'li'))
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'a', text: 'typed' }, SCALE_400)
  const hasSuggest = acted.observation.nodes.some((n) => n.name === 'Async rendering')
  assert.equal(acted.settle.stable, true, JSON.stringify(acted.settle))
  assert.equal(hasSuggest, true, 'the suggestion must be inside the settled proof observation')
  assert.ok(acted.settle.elapsedMs >= SUGGEST_AT, 'the window must wait past the sibling mirror to the suggestion')
  assert.ok(acted.settle.elapsedMs < SCALE_400.budgetMs, 'but still conclude within the budget')
  assert.equal(acted.settle.quietRequiredMs, SCALE_400.postChangeQuietMs, 'the post-change quiet requirement applied')
})

test('an inert action (only the echo changes) still concludes under quietMs, not postChangeQuietMs', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      return observation({
        nodes: [node('in', 'textbox', 'Release name', 'input', { value: since === null ? '' : 'v1.0.0' })],
      })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'in', text: 'v1.0.0' }, SMALL)
  assert.equal(acted.settle.stable, true)
  // The echo is masked, so awaitChange is never satisfied: the quiet
  // requirement stays quietMs (not the 2x post-change window), and the window
  // spends its whole budget (the documented "nothing changed" path).
  assert.equal(acted.settle.quietRequiredMs, SMALL.quietMs, 'inert actions use the pre-change quiet window')
  assert.ok(acted.settle.elapsedMs >= SMALL.budgetMs - 50, 'an echo-only fill must not end the wait early')
})

test('unrelated early churn then no outcome concludes after the first delta + postChangeQuietMs', async () => {
  const adapter = timedAdapter({
    afterAct(since) {
      const churned = since !== null && since >= CHURN_AT
      const nodes = [
        node('far', 'link', churned ? 'Hydrated shortcut' : 'Shortcut [o]', 'a'),
        node('in', 'textbox', 'Search articles', 'input', { value: since === null ? '' : 'async' }),
      ]
      return observation({ nodes })
    },
  })
  const acted = await runAct(adapter, { kind: 'fill', ref: 'in', text: 'async' }, SMALL)
  assert.equal(acted.settle.stable, true, JSON.stringify(acted.settle))
  assert.equal(acted.settle.quietRequiredMs, SMALL.postChangeQuietMs, 'the post-change quiet requirement applied')
  assert.ok(
    acted.settle.elapsedMs >= CHURN_AT + SMALL.postChangeQuietMs - 50,
    'the window must wait one post-change quiet period after the first delta (elapsed ' + acted.settle.elapsedMs + 'ms)',
  )
  assert.ok(acted.settle.elapsedMs < SMALL.budgetMs, 'but still conclude within the budget')
})

test('continuous churn still yields stable:false at budget (unchanged)', async () => {
  const policy = SMALL
  const ticking = async () => ({
    page: { url: 'https://example.test/', title: 'fixture' },
    nodes: [node('clock', 'status', 'TICK ' + Date.now(), 'div')],
    truncated: false,
  })
  const settled = await observeUntilStable(ticking, policy, { awaitChange: true })
  assert.equal(settled.stable, false, 'a page that never holds still is never called settled')
  assert.ok(settled.elapsedMs >= policy.budgetMs - 20)
  assert.equal(settled.budgetMs, policy.budgetMs)
  // The churn is a non-echo delta, so awaitChange was satisfied and the
  // post-change quiet requirement applied — it just never held still for it.
  assert.equal(settled.quietRequiredMs, policy.postChangeQuietMs)
})

test('env var: valid override applied; below quietMs clamps up; above budget clamps down; garbage → default', () => {
  const defaults = resolveSettlePolicy()
  try {
    process.env.DSHPLUGIN_QA_SETTLE_POST_CHANGE_QUIET_MS = '500'
    assert.equal(resolveSettlePolicy().postChangeQuietMs, 500, 'valid override applied')
    process.env.DSHPLUGIN_QA_SETTLE_POST_CHANGE_QUIET_MS = '50'
    assert.equal(resolveSettlePolicy().postChangeQuietMs, defaults.quietMs, 'below quietMs clamps up to quietMs')
    process.env.DSHPLUGIN_QA_SETTLE_POST_CHANGE_QUIET_MS = '99999'
    assert.equal(resolveSettlePolicy().postChangeQuietMs, defaults.budgetMs, 'above budget clamps down to budgetMs')
    process.env.DSHPLUGIN_QA_SETTLE_POST_CHANGE_QUIET_MS = 'whenever'
    assert.equal(resolveSettlePolicy().postChangeQuietMs, 2 * defaults.quietMs, 'garbage → default (2 × quietMs)')
  } finally {
    delete process.env.DSHPLUGIN_QA_SETTLE_POST_CHANGE_QUIET_MS
  }
})
