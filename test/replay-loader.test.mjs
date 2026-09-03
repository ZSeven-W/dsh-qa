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
  bad.steps[0].action = { kind: 'teleport', target: { role: 'button' } };
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

test('scroll/select/hover step shapes validate (closed schema)', () => {
  const scrollByTarget = validScenario();
  scrollByTarget.steps[0].action = { kind: 'scroll', target: { role: 'button', name: 'Menu' } };
  assert.equal(validateScenario(scrollByTarget).steps[0].action.kind, 'scroll');

  const scrollByDirection = validScenario();
  scrollByDirection.steps[0].action = { kind: 'scroll', direction: 'down', amount: 'page' };
  assert.deepEqual(validateScenario(scrollByDirection).steps[0].action, { kind: 'scroll', direction: 'down', amount: 'page' });

  const select = validScenario();
  select.steps[0].action = { kind: 'select', target: { role: 'combobox', name: 'Second select' }, option: 'Alpha' };
  assert.deepEqual(validateScenario(select).steps[0].action, {
    kind: 'select', target: { role: 'combobox', name: 'Second select' }, option: 'Alpha',
  });

  const hover = validScenario();
  hover.steps[0].action = { kind: 'hover', target: { role: 'button', name: 'Menu' } };
  assert.deepEqual(validateScenario(hover).steps[0].action, { kind: 'hover', target: { role: 'button', name: 'Menu' } });
});

test('select step without option is rejected', () => {
  const bad = validScenario();
  bad.steps[0].action = { kind: 'select', target: { role: 'combobox', name: 'Second select' } };
  expectPosition(() => validateScenario(bad), 'steps[0].action.option');
});

test('scroll with a bogus amount is rejected', () => {
  const bad = validScenario();
  bad.steps[0].action = { kind: 'scroll', direction: 'down', amount: 'line' };
  expectPosition(() => validateScenario(bad), 'steps[0].action.amount');

  const negative = validScenario();
  negative.steps[0].action = { kind: 'scroll', direction: 'down', amount: -5 };
  expectPosition(() => validateScenario(negative), 'steps[0].action.amount');
});

test('scroll must specify exactly one of target or direction', () => {
  const both = validScenario();
  both.steps[0].action = { kind: 'scroll', target: { role: 'button' }, direction: 'down' };
  expectPosition(() => validateScenario(both), 'steps[0].action');

  const neither = validScenario();
  neither.steps[0].action = { kind: 'scroll' };
  expectPosition(() => validateScenario(neither), 'steps[0].action');
});

test('node-in-viewport assertion validates and its expected is a predicate', () => {
  const assertion = validateAssertion(
    { kind: 'node-in-viewport', expected: { role: 'combobox', name: 'Second select' } },
    'qa_assert',
  );
  assert.equal(assertion.kind, 'node-in-viewport');
  assert.deepEqual(assertion.expected, { role: 'combobox', name: 'Second select' });
});

test('node-value assertion validates a predicate plus an exact value', () => {
  const assertion = validateAssertion(
    { kind: 'node-value', expected: { role: 'textbox', name: 'Release name', value: 'v1.0.0' } },
    'qa_assert',
  );
  assert.equal(assertion.kind, 'node-value');
  assert.deepEqual(assertion.expected, { role: 'textbox', name: 'Release name', value: 'v1.0.0' });
});

test('node-value rejects a missing, empty, or non-string value', () => {
  for (const expected of [{ role: 'textbox' }, { role: 'textbox', value: '  ' }, { role: 'textbox', value: 123 }]) {
    assert.throws(() => validateAssertion({ kind: 'node-value', expected }, 'qa_assert'), (error) => {
      assert.ok(error instanceof ScenarioValidationError);
      assert.equal(error.position, 'qa_assert.expected.value');
      return true;
    });
  }
});

test('node-value rejects a predicate with no role/name/tag or an unexpected field', () => {
  assert.throws(() => validateAssertion({ kind: 'node-value', expected: { value: 'x' } }, 'qa_assert'), (error) => {
    assert.ok(error instanceof ScenarioValidationError);
    assert.equal(error.position, 'qa_assert.expected');
    return true;
  });
  assert.throws(
    () => validateAssertion({ kind: 'node-value', expected: { role: 'textbox', value: 'x', extra: 1 } }, 'qa_assert'),
    (error) => {
      assert.ok(error instanceof ScenarioValidationError);
      assert.equal(error.position, 'qa_assert.expected');
      return true;
    },
  );
});

test('node-value accepts a role-less predicate (name + value)', () => {
  const assertion = validateAssertion(
    { kind: 'node-value', expected: { name: 'Search Wikipedia', value: 'DeepSeek' } },
    'qa_assert',
  );
  assert.equal(assertion.kind, 'node-value');
  assert.deepEqual(assertion.expected, { name: 'Search Wikipedia', value: 'DeepSeek' });
});

test('meta.settle validates, clamps, and rejects garbage', () => {
  const withSettle = validScenario();
  withSettle.meta.settle = { budgetMs: 6000, quietMs: 300 };
  assert.deepEqual(validateScenario(withSettle).meta.settle, { budgetMs: 6000, quietMs: 300 });

  // over-max budget clamps to the schema maximum
  const overBudget = validScenario();
  overBudget.meta.settle = { budgetMs: 20000 };
  assert.equal(validateScenario(overBudget).meta.settle.budgetMs, 15000);

  // the other fields clamp to <= the resolved budget
  const quietOver = validScenario();
  quietOver.meta.settle = { budgetMs: 1000, quietMs: 5000, intervalMs: 9000 };
  const clampedQuiet = validateScenario(quietOver).meta.settle;
  assert.equal(clampedQuiet.budgetMs, 1000);
  assert.equal(clampedQuiet.quietMs, 1000);
  assert.equal(clampedQuiet.intervalMs, 1000);

  // garbage fails closed at the named position
  for (const bad of [-5, 0, 1.5, '6000', null, NaN, Infinity]) {
    const g = validScenario();
    g.meta.settle = { budgetMs: bad };
    expectPosition(() => validateScenario(g), 'meta.settle.budgetMs');
  }

  // unknown settle field is rejected
  const unknown = validScenario();
  unknown.meta.settle = { budgetMs: 1000, bogus: 1 };
  expectPosition(() => validateScenario(unknown), 'meta.settle');

  // adaptiveBudgetMs: 0 disables, positive values clamp to the schema maximum,
  // and garbage (negative / fractional / non-number) fails closed.
  const adaptiveDisabled = validScenario();
  adaptiveDisabled.meta.settle = { budgetMs: 2500, adaptiveBudgetMs: 0 };
  assert.deepEqual(validateScenario(adaptiveDisabled).meta.settle, { budgetMs: 2500, adaptiveBudgetMs: 0 });
  const adaptiveClamp = validScenario();
  adaptiveClamp.meta.settle = { adaptiveBudgetMs: 20000 };
  assert.equal(validateScenario(adaptiveClamp).meta.settle.adaptiveBudgetMs, 15000);
  for (const bad of [-5, 1.5, '6000', null, NaN, Infinity]) {
    const g = validScenario();
    g.meta.settle = { adaptiveBudgetMs: bad };
    expectPosition(() => validateScenario(g), 'meta.settle.adaptiveBudgetMs');
  }
});
