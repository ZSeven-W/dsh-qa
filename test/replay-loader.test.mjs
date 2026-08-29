import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ScenarioValidationError,
  loadScenarioFromPath,
  parseScenario,
  validateAssertion,
  validateScenario,
} from '../src/replay/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'scenarios', 'examples', 'fixture-web.json');

function validScenario() {
  return {
    meta: { name: 't', description: 'd', driver: 'browser', createdAt: '2026-01-01T00:00:00.000Z' },
    target: { launch: 'http://127.0.0.1:1/' },
    steps: [
      {
        index: 1,
        intent: 'do it',
        action: { kind: 'click', target: { role: 'button' } },
        assert: { kind: 'node-present', expected: { role: 'button' } },
      },
    ],
    assertions: [],
  };
}

function expectPosition(fn, position) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ScenarioValidationError, 'expected ScenarioValidationError, got ' + error);
    assert.equal(error.position, position);
    return true;
  });
}

test('the committed example scenario validates and loads', () => {
  const scenario = loadScenarioFromPath(EXAMPLE);
  assert.equal(scenario.meta.driver, 'browser');
  assert.equal(scenario.steps.length, 2);
  assert.equal(scenario.steps[0].index, 1);
  assert.equal(scenario.steps[0].action.kind, 'fill');
  assert.equal(scenario.steps[1].index, 2);
  assert.equal(scenario.steps[1].action.kind, 'click');
  assert.equal(scenario.assertions.length, 2);
});

test('unknown top-level field is rejected without echoing the field or value bytes', () => {
  const secret = 'Bearer topsecret_9xYzZz';
  const bad = { ...validScenario(), token: secret };
  assert.throws(() => validateScenario(bad), (error) => {
    assert.ok(error instanceof ScenarioValidationError);
    assert.equal(error.position, '$');
    assert.doesNotMatch(error.message, /topsecret/);
    assert.doesNotMatch(error.message, /token/);
    return true;
  });
});

test('unknown step field is rejected at the step position', () => {
  const bad = validScenario();
  bad.steps[0].extra = 'x';
  expectPosition(() => validateScenario(bad), 'steps[0]');
});

test('missing required field is rejected at its position', () => {
  const bad = validScenario();
  delete bad.steps[0].assert;
  expectPosition(() => validateScenario(bad), 'steps[0].assert');
});

test('non-sequential step index is rejected', () => {
  const bad = validScenario();
  bad.steps[0].index = 2;
  expectPosition(() => validateScenario(bad), 'steps[0].index');
});

test('malformed action kind is rejected', () => {
  const bad = validScenario();
  bad.steps[0].action = { kind: 'hover', target: { role: 'button' } };
  expectPosition(() => validateScenario(bad), 'steps[0].action.kind');
});

test('non-lossless values are rejected (NaN and undefined-valued keys)', () => {
  const nan = validScenario();
  nan.steps[0].assert.expected = { role: 'status', name: NaN };
  expectPosition(() => validateScenario(nan), 'steps[0].assert.expected');

  const undef = validScenario();
  undef.steps[0].assert.expected = { role: 'status', name: undefined };
  expectPosition(() => validateScenario(undef), 'steps[0].assert.expected');
});

test('browser scenario requires an http(s) launch URL', () => {
  const bad = validScenario();
  bad.target.launch = 'not-a-url';
  expectPosition(() => validateScenario(bad), 'target.launch');
});

test('invalid JSON is rejected with a character position, never value bytes', () => {
  // Unterminated object: JSON.parse fails, and the raw text contains a secret
  // that the error must never echo.
  assert.throws(() => parseScenario('{ "meta": "Bearer secret_x9" ', 'test.json'), (error) => {
    assert.ok(error instanceof ScenarioValidationError);
    assert.match(error.message, /invalid JSON/);
    assert.doesNotMatch(error.message, /secret_x9/);
    return true;
  });
});

test('validateAssertion rejects an ambiguous page-url expected', () => {
  assert.throws(
    () => validateAssertion({ kind: 'page-url', expected: { url: 'x', contains: 'y' } }, 'qa_assert'),
    (error) => {
      assert.ok(error instanceof ScenarioValidationError);
      assert.equal(error.position, 'qa_assert.expected');
      return true;
    },
  );
});

test('validateAssertion accepts a well-formed node-present assertion', () => {
  const assertion = validateAssertion(
    { kind: 'node-present', expected: { role: 'status', name: 'PASS' } },
    'qa_assert',
  );
  assert.equal(assertion.kind, 'node-present');
  assert.deepEqual(assertion.expected, { role: 'status', name: 'PASS' });
});
