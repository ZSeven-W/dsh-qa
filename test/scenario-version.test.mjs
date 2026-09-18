// The scenario file is a published contract: users commit QaScenario JSON and
// expect it to keep meaning the same thing. Before this, it carried NO version
// at all — the `schemaVersion: 1` in the codebase belongs to QaRunReport, and
// the loader REJECTED a scenario that tried to declare one.
//
// "The loader is fail-closed, so old scenarios break loudly" was not true for
// the case that matters. The loader validates SYNTAX. It cannot notice that
// unchanged JSON now means something different because target resolution or
// proof selection changed — which is exactly what a driver contract bump does.
//
// The rules pinned here:
//   - export always writes schemaVersion;
//   - a scenario with no schemaVersion is accepted as the legacy version 1,
//     because such files are already in the wild;
//   - a FUTURE schemaVersion is refused loudly instead of being replayed under
//     today's semantics, which is the only direction that fails closed.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadScenarioFromPath,
  validateScenario,
  ScenarioValidationError,
  QA_SCENARIO_SCHEMA_VERSION,
} from '../src/replay/index.ts'

const LAUNCH = 'http://127.0.0.1:7502/'

function baseScenario(extra = {}) {
  const assertion = { kind: 'node-present', expected: { role: 'button', name: 'Submit' } }
  return {
    meta: { name: 'versioned', description: 'd', driver: 'browser', createdAt: '2026-09-18T04:00:00.000Z' },
    target: { launch: LAUNCH },
    steps: [{
      index: 1,
      intent: 'Click "Submit".',
      action: { kind: 'click', target: { role: 'button', name: 'Submit' } },
      assert: assertion,
    }],
    assertions: [assertion],
    ...extra,
  }
}

test('the current scenario schema version is exported as a constant', () => {
  assert.equal(typeof QA_SCENARIO_SCHEMA_VERSION, 'number')
  assert.ok(QA_SCENARIO_SCHEMA_VERSION >= 1)
})

test('a scenario declaring the current schemaVersion is accepted', () => {
  const scenario = validateScenario(baseScenario({ schemaVersion: QA_SCENARIO_SCHEMA_VERSION }))
  assert.equal(scenario.schemaVersion, QA_SCENARIO_SCHEMA_VERSION)
})

test('a scenario with NO schemaVersion is accepted as the legacy version', () => {
  // Files exported before versioning existed are already committed in user
  // repositories. Refusing them would break the contract this change exists to
  // protect.
  const scenario = validateScenario(baseScenario())
  assert.equal(scenario.schemaVersion, undefined, 'the absent field is left absent, not silently rewritten')
})

test('a FUTURE schemaVersion is refused, never replayed under current semantics', () => {
  // The whole point: a newer writer may mean something different by the same
  // JSON. Replaying it with today's rules would produce a confident verdict
  // about a scenario this build does not understand.
  assert.throws(
    () => validateScenario(baseScenario({ schemaVersion: QA_SCENARIO_SCHEMA_VERSION + 1 })),
    (error) => {
      assert.ok(error instanceof ScenarioValidationError, 'refusal is the loader-level error type')
      assert.match(String(error.message), /schemaVersion/)
      return true
    },
  )
})

test('a non-integer or zero schemaVersion is refused', () => {
  for (const bad of [0, -1, 1.5, '1', null, true]) {
    assert.throws(
      () => validateScenario(baseScenario({ schemaVersion: bad })),
      ScenarioValidationError,
      'schemaVersion ' + JSON.stringify(bad) + ' must be refused',
    )
  }
})

test('a future schemaVersion is refused by the file loader too, with the file path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-scenario-version-'))
  try {
    const path = join(dir, 'future.json')
    await writeFile(path, JSON.stringify(baseScenario({ schemaVersion: QA_SCENARIO_SCHEMA_VERSION + 5 })), 'utf8')
    assert.throws(
      () => loadScenarioFromPath(path),
      (error) => {
        assert.match(String(error.message), /schemaVersion/)
        assert.match(String(error.message), /future\.json/, 'the refusal names the offending file')
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
