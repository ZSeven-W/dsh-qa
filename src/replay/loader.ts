// Fail-closed scenario loader. Unknown fields, malformed steps, missing
// required fields, and non-lossless values are REJECTED with a deterministic
// error naming the structural position (never echoing value bytes). No
// "best effort" repair happens here: a scenario is either fully valid or it
// is refused.

import { readFileSync } from 'node:fs';
import { QA_SETTLE_SCHEMA_BUDGET_MAX } from '../contracts.ts';
import type {
  QaAssertion,
  QaAssertionKind,
  QaDriverKind,
  QaNodePredicate,
  QaScenario,
  QaScenarioAction,
  QaScenarioAssertionScope,
  QaScenarioMeta,
  QaScenarioTarget,
  QaSettleOverride,
  QaStep,
  QaVisualAssertion,
} from '../contracts.ts';
import { LoginStateError, validateLoginStateConfig, type QaLoginStateConfig } from '../loginState.ts';

export class ScenarioValidationError extends Error {
  readonly position: string;
  readonly reason: string;
  constructor(position: string, reason: string) {
    super('scenario validation failed at ' + position + ': ' + reason);
    this.name = 'ScenarioValidationError';
    this.position = position;
    this.reason = reason;
  }
}

function fail(position: string, reason: string): never {
  throw new ScenarioValidationError(position, reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectObject(value: unknown, position: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(position, 'expected an object');
  return value;
}

function expectArray(value: unknown, position: string): unknown[] {
  if (!Array.isArray(value)) fail(position, 'expected an array');
  return value;
}

function expectString(value: unknown, position: string): string {
  if (typeof value !== 'string') fail(position, 'expected a string');
  return value;
}

function expectNonEmptyString(value: unknown, position: string): string {
  const s = expectString(value, position);
  if (s.trim() === '') fail(position, 'expected a non-empty string');
  return s;
}

function assertKnownFields(obj: Record<string, unknown>, allowed: readonly string[], position: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(position, 'unexpected field');
  }
}

function assertLossless(value: unknown, position: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(position, 'number is not lossless JSON (non-finite or negative zero)');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertLossless(value[i], position + '[' + i + ']');
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) fail(position, 'object contains a key with an undefined value');
      assertLossless(child, position);
    }
    return;
  }
  fail(position, 'value is not lossless JSON');
}

const DRIVER_KINDS: readonly QaDriverKind[] = ['browser', 'computer'];
const ASSERTION_KINDS: readonly QaAssertionKind[] = ['node-present', 'node-absent', 'page-url', 'node-in-viewport', 'node-value'];
const ROOT_FIELDS = ['meta', 'target', 'steps', 'assertions', 'advisory'] as const;
const META_FIELDS = ['name', 'description', 'driver', 'createdAt', 'notes', 'settle'] as const;
const SETTLE_OVERRIDE_FIELDS = ['budgetMs', 'quietMs', 'postChangeQuietMs', 'intervalMs', 'adaptiveBudgetMs'] as const;
const TARGET_FIELDS = ['launch', 'loginState'] as const;
// QA-BL-067: the recorded record-time proof refusal rides on the step
// (additive; schemaVersion stays 1) so report.md step lines can surface it.
const STEP_FIELDS = ['index', 'intent', 'action', 'assert', 'escalationRefused'] as const;
const ASSERTION_FIELDS = ['kind', 'expected', 'description', 'scope'] as const;
const ASSERTION_SCOPE_FIELDS = ['role', 'name', 'tag', 'path'] as const;
const ASSERTION_SCOPE_PATH_ITEM_FIELDS = ['role', 'name'] as const;
const NODE_VALUE_EXPECTATION_FIELDS = ['role', 'name', 'tag', 'value'] as const;
const VISUAL_ASSERTION_FIELDS = ['kind', 'question', 'description'] as const;
// QA-BL-064: roleHint is the advisory live role the exporter recorded beside
// a NAME-only action target (role drift on real pages). The loader accepts it
// and replay IGNORES it for matching; it never counts toward the
// "at least one of role/name/tag" requirement.
const PREDICATE_FIELDS = ['role', 'name', 'tag', 'roleHint'] as const;

function isDriverKind(value: unknown): value is QaDriverKind {
  return typeof value === 'string' && DRIVER_KINDS.includes(value as QaDriverKind);
}

function isAssertionKind(value: unknown): value is QaAssertionKind {
  return typeof value === 'string' && ASSERTION_KINDS.includes(value as QaAssertionKind);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateMeta(value: unknown, position: string): QaScenarioMeta {
  const obj = expectObject(value, position);
  assertKnownFields(obj, META_FIELDS, position);
  const name = expectNonEmptyString(obj.name, position + '.name');
  const description = expectString(obj.description, position + '.description');
  const driver = obj.driver;
  if (!isDriverKind(driver)) fail(position + '.driver', 'unsupported driver');
  const createdAt = expectNonEmptyString(obj.createdAt, position + '.createdAt');
  if (Number.isNaN(Date.parse(createdAt))) fail(position + '.createdAt', 'expected an ISO 8601 timestamp');
  let notes: string[] | undefined;
  if (obj.notes !== undefined) {
    notes = expectArray(obj.notes, position + '.notes').map((item, i) =>
      expectNonEmptyString(item, position + '.notes[' + i + ']'),
    );
  }
  let settle: QaSettleOverride | undefined;
  if (obj.settle !== undefined) settle = validateSettleOverride(obj.settle, position + '.settle');
  return {
    name,
    description,
    driver,
    createdAt,
    ...(notes === undefined ? {} : { notes }),
    ...(settle === undefined ? {} : { settle }),
  };
}

/**
 * Validates and clamps one scenario settle override: a positive integer in
 * milliseconds, clamped to `ceiling` (budgetMs to QA_SETTLE_SCHEMA_BUDGET_MAX,
 * the other fields to the resolved budgetMs). Non-finite / non-integer /
 * non-positive values fail closed; out-of-range values are clamped, never
 * trusted.
 */
function validateSettleMs(value: unknown, position: string, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    fail(position, 'expected a positive integer number of milliseconds');
  }
  return Math.min(value, ceiling);
}

function validateSettleOverride(value: unknown, position: string): QaSettleOverride {
  const obj = expectObject(value, position);
  assertKnownFields(obj, SETTLE_OVERRIDE_FIELDS, position);
  const budgetMs = obj.budgetMs === undefined
    ? undefined
    : validateSettleMs(obj.budgetMs, position + '.budgetMs', QA_SETTLE_SCHEMA_BUDGET_MAX);
  const ceiling = budgetMs ?? QA_SETTLE_SCHEMA_BUDGET_MAX;
  const out: QaSettleOverride = {};
  if (budgetMs !== undefined) out.budgetMs = budgetMs;
  if (obj.quietMs !== undefined) out.quietMs = validateSettleMs(obj.quietMs, position + '.quietMs', ceiling);
  if (obj.postChangeQuietMs !== undefined) {
    out.postChangeQuietMs = validateSettleMs(obj.postChangeQuietMs, position + '.postChangeQuietMs', ceiling);
  }
  if (obj.intervalMs !== undefined) out.intervalMs = validateSettleMs(obj.intervalMs, position + '.intervalMs', ceiling);
  if (obj.adaptiveBudgetMs !== undefined) {
    // Unlike the other fields, 0 is valid: it disables adaptation. Clamped to
    // the schema maximum; the [budgetMs, max] floor is applied later by
    // resolveSettlePolicy when replay builds the session.
    const adaptive = obj.adaptiveBudgetMs;
    if (typeof adaptive !== 'number' || !Number.isFinite(adaptive) || !Number.isInteger(adaptive) || adaptive < 0) {
      fail(position + '.adaptiveBudgetMs', 'expected a non-negative integer number of milliseconds');
    }
    out.adaptiveBudgetMs = Math.min(adaptive, QA_SETTLE_SCHEMA_BUDGET_MAX);
  }
  return out;
}

function validateTarget(value: unknown, position: string, driver: QaDriverKind): QaScenarioTarget {
  const obj = expectObject(value, position);
  assertKnownFields(obj, TARGET_FIELDS, position);
  const launch = expectNonEmptyString(obj.launch, position + '.launch');
  if (driver === 'browser' && !isValidHttpUrl(launch)) {
    fail(position + '.launch', 'expected an http(s) URL');
  }
  let loginState: QaLoginStateConfig | undefined;
  if (obj.loginState !== undefined) {
    if (driver !== 'browser') fail(position + '.loginState', 'browser-only field');
    try {
      loginState = validateLoginStateConfig(obj.loginState, position + '.loginState');
    } catch (error) {
      if (error instanceof LoginStateError) fail(position + '.loginState', error.message);
      throw error;
    }
  }
  return { launch, ...(loginState === undefined ? {} : { loginState }) };
}

function validatePredicate(value: unknown, position: string): QaNodePredicate {
  const obj = expectObject(value, position);
  assertKnownFields(obj, PREDICATE_FIELDS, position);
  const out: QaNodePredicate = {};
  if (obj.role !== undefined) out.role = expectNonEmptyString(obj.role, position + '.role');
  if (obj.name !== undefined) out.name = expectNonEmptyString(obj.name, position + '.name');
  if (obj.tag !== undefined) out.tag = expectNonEmptyString(obj.tag, position + '.tag');
  // QA-BL-064: validated as a non-empty string and CARRIED on the predicate,
  // but never used for matching (matchesNode reads role/name/tag only).
  if (obj.roleHint !== undefined) out.roleHint = expectNonEmptyString(obj.roleHint, position + '.roleHint');
  if (out.role === undefined && out.name === undefined && out.tag === undefined) {
    fail(position, 'expected at least one of role/name/tag');
  }
  return out;
}

/** Validates a `node-value` expectation: predicate fields plus a required exact value. */
function validateNodeValueExpectation(value: unknown, position: string): { role?: string; name?: string; tag?: string; value: string } {
  const obj = expectObject(value, position);
  assertKnownFields(obj, NODE_VALUE_EXPECTATION_FIELDS, position);
  const out: { role?: string; name?: string; tag?: string; value: string } = {
    value: expectNonEmptyString(obj.value, position + '.value'),
  };
  if (obj.role !== undefined) out.role = expectNonEmptyString(obj.role, position + '.role');
  if (obj.name !== undefined) out.name = expectNonEmptyString(obj.name, position + '.name');
  if (obj.tag !== undefined) out.tag = expectNonEmptyString(obj.tag, position + '.tag');
  if (out.role === undefined && out.name === undefined && out.tag === undefined) {
    fail(position, 'expected at least one of role/name/tag');
  }
  return out;
}

function validateAction(value: unknown, position: string): QaScenarioAction {
  const obj = expectObject(value, position);
  const kind = expectNonEmptyString(obj.kind, position + '.kind');
  if (kind === 'click') {
    assertKnownFields(obj, ['kind', 'target'], position);
    return { kind: 'click', target: validatePredicate(obj.target, position + '.target') };
  }
  if (kind === 'fill') {
    assertKnownFields(obj, ['kind', 'target', 'text'], position);
    return {
      kind: 'fill',
      target: validatePredicate(obj.target, position + '.target'),
      text: expectNonEmptyString(obj.text, position + '.text'),
    };
  }
  if (kind === 'press') {
    assertKnownFields(obj, ['kind', 'target', 'key'], position);
    return {
      kind: 'press',
      target: validatePredicate(obj.target, position + '.target'),
      key: expectNonEmptyString(obj.key, position + '.key'),
    };
  }
  if (kind === 'navigate') {
    assertKnownFields(obj, ['kind', 'url'], position);
    return { kind: 'navigate', url: expectNonEmptyString(obj.url, position + '.url') };
  }
  if (kind === 'scroll') {
    const hasTarget = obj.target !== undefined;
    const hasDirection = obj.direction !== undefined;
    if (hasTarget === hasDirection) {
      fail(position, 'scroll must specify exactly one of target (scroll-to-target) or direction (viewport scroll)');
    }
    if (hasTarget) {
      assertKnownFields(obj, ['kind', 'target'], position);
      return { kind: 'scroll', target: validatePredicate(obj.target, position + '.target') };
    }
    assertKnownFields(obj, ['kind', 'direction', 'amount'], position);
    const direction = expectNonEmptyString(obj.direction, position + '.direction');
    if (direction !== 'up' && direction !== 'down') {
      fail(position + '.direction', 'expected "up" or "down"');
    }
    const amount = validateScrollAmount(obj.amount, position + '.amount');
    return { kind: 'scroll', direction, ...(amount === undefined ? {} : { amount }) };
  }
  if (kind === 'select') {
    assertKnownFields(obj, ['kind', 'target', 'option'], position);
    return {
      kind: 'select',
      target: validatePredicate(obj.target, position + '.target'),
      option: expectNonEmptyString(obj.option, position + '.option'),
    };
  }
  if (kind === 'hover') {
    assertKnownFields(obj, ['kind', 'target'], position);
    return { kind: 'hover', target: validatePredicate(obj.target, position + '.target') };
  }
  fail(position + '.kind', 'unsupported action kind');
}

/** Validates a browser viewport-scroll amount: undefined, "page", or a finite non-negative pixel count. */
function validateScrollAmount(value: unknown, position: string): 'page' | number | undefined {
  if (value === undefined) return undefined;
  if (value === 'page') return 'page';
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Object.is(value, -0)) {
    return value;
  }
  fail(position, 'expected "page" or a finite non-negative number');
}

/**
 * Validates the recorded ancestor PATH of a scoped container (QA-BL-062),
 * fail-closed like every other schema field: a non-empty array of { role,
 * name } items, outermost ancestor first. The role must be a non-empty
 * string; the name may be the EMPTY STRING (an unnamed ancestor is an
 * exact-match predicate value). Unknown fields on an item are rejected, so a
 * fabricated or partially hand-edited path can never reach the runner.
 */
function validateScopePath(value: unknown, position: string): { role: string; name: string }[] {
  const items = expectArray(value, position);
  if (items.length === 0) fail(position, 'expected at least one path item (an empty path proves nothing)');
  return items.map((item, index) => {
    const itemPosition = position + '[' + index + ']';
    const obj = expectObject(item, itemPosition);
    assertKnownFields(obj, ASSERTION_SCOPE_PATH_ITEM_FIELDS, itemPosition);
    return {
      role: expectNonEmptyString(obj.role, itemPosition + '.role'),
      name: expectString(obj.name, itemPosition + '.name'),
    };
  });
}

function validateAssertionScope(value: unknown, position: string): QaScenarioAssertionScope {
  const obj = expectObject(value, position);
  assertKnownFields(obj, ASSERTION_SCOPE_FIELDS, position);
  // Fail closed exactly like every other schema field: the container predicate
  // needs a non-empty role. QA-BL-054: the accessible NAME may be the EMPTY
  // STRING — an unnamed container is the common case and the empty name is an
  // exact-match predicate value, never a missing one. An optional TAG may
  // disambiguate the predicate ("role+name, plus tag when needed"); when
  // present it must be a non-empty string.
  const role = expectNonEmptyString(obj.role, position + '.role');
  const name = expectString(obj.name, position + '.name');
  const out: QaScenarioAssertionScope = { role, name };
  if (obj.tag !== undefined) {
    out.tag = expectNonEmptyString(obj.tag, position + '.tag');
  }
  // QA-BL-062: an optional ancestor PATH, validated fail-closed when present.
  if (obj.path !== undefined) {
    out.path = validateScopePath(obj.path, position + '.path');
  }
  return out;
}

/** Validates an assertion object (also used by the qa_assert MCP tool). */
export function validateAssertion(value: unknown, position = 'assertion'): QaAssertion {
  const obj = expectObject(value, position);
  assertKnownFields(obj, ASSERTION_FIELDS, position);
  const rawKind = obj.kind;
  if (!isAssertionKind(rawKind)) fail(position + '.kind', 'unsupported assertion kind');
  const kind: QaAssertionKind = rawKind;
  if (obj.expected === undefined) fail(position + '.expected', 'required');
  assertLossless(obj.expected, position + '.expected');
  if (kind === 'node-present' || kind === 'node-absent' || kind === 'node-in-viewport') {
    validatePredicate(obj.expected, position + '.expected');
  } else if (kind === 'node-value') {
    validateNodeValueExpectation(obj.expected, position + '.expected');
  } else {
    const expected = expectObject(obj.expected, position + '.expected');
    assertKnownFields(expected, ['url', 'contains'], position + '.expected');
    const hasUrl = expected.url !== undefined;
    const hasContains = expected.contains !== undefined;
    if (hasUrl === hasContains) {
      fail(position + '.expected', 'expected exactly one of url or contains');
    }
    if (hasUrl) expectNonEmptyString(expected.url, position + '.expected.url');
    else expectNonEmptyString(expected.contains, position + '.expected.contains');
  }
  const out: QaAssertion = { kind, expected: obj.expected };
  if (obj.description !== undefined) {
    out.description = expectNonEmptyString(obj.description, position + '.description');
  }
  if (obj.scope !== undefined) {
    out.scope = validateAssertionScope(obj.scope, position + '.scope');
  }
  return out;
}

/** Validates one advisory visual assertion (never a blocking assertion). */
export function validateVisualAssertion(value: unknown, position = 'advisory'): QaVisualAssertion {
  const obj = expectObject(value, position);
  assertKnownFields(obj, VISUAL_ASSERTION_FIELDS, position);
  if (obj.kind !== 'visual') fail(position + '.kind', 'expected kind "visual"');
  const question = expectNonEmptyString(obj.question, position + '.question');
  const out: QaVisualAssertion = { kind: 'visual', question };
  if (obj.description !== undefined) {
    out.description = expectNonEmptyString(obj.description, position + '.description');
  }
  return out;
}

function validateAdvisory(value: unknown, position: string): QaVisualAssertion[] {
  const arr = expectArray(value, position);
  return arr.map((item, i) => validateVisualAssertion(item, position + '[' + i + ']'));
}

function validateStep(value: unknown, position: string): QaStep {
  const obj = expectObject(value, position);
  assertKnownFields(obj, STEP_FIELDS, position);
  const indexValue = obj.index;
  if (typeof indexValue !== 'number' || !Number.isInteger(indexValue) || indexValue < 1) {
    fail(position + '.index', 'expected a positive integer');
  }
  const intent = expectNonEmptyString(obj.intent, position + '.intent');
  const action = validateAction(obj.action, position + '.action');
  const assert = validateAssertion(obj.assert, position + '.assert');
  // QA-BL-067: the recorded record-time proof refusal is additive — accepted
  // structurally (reason string, optional driver code) and returned verbatim
  // so report.md step lines can surface it.
  let escalationRefused: QaStep['escalationRefused'];
  if (obj.escalationRefused !== undefined) {
    const refusal = expectObject(obj.escalationRefused, position + '.escalationRefused');
    assertKnownFields(refusal, ['reason', 'code'], position + '.escalationRefused');
    escalationRefused = {
      reason: expectNonEmptyString(refusal.reason, position + '.escalationRefused.reason'),
      ...(refusal.code === undefined ? {} : { code: expectString(refusal.code, position + '.escalationRefused.code') }),
    };
  }
  return { index: indexValue, intent, action, assert, ...(escalationRefused === undefined ? {} : { escalationRefused }) };
}

function validateSteps(value: unknown, position: string): QaStep[] {
  const arr = expectArray(value, position);
  if (arr.length === 0) fail(position, 'expected at least one step');
  return arr.map((item, i) => {
    const step = validateStep(item, position + '[' + i + ']');
    if (step.index !== i + 1) {
      fail(position + '[' + i + '].index', 'expected the 1-based step index to match its position');
    }
    return step;
  });
}

function validateAssertions(value: unknown, position: string): QaAssertion[] {
  const arr = expectArray(value, position);
  return arr.map((item, i) => validateAssertion(item, position + '[' + i + ']'));
}

export function validateScenario(value: unknown): QaScenario {
  const root = expectObject(value, '$');
  assertKnownFields(root, ROOT_FIELDS, '$');
  const meta = validateMeta(root.meta, 'meta');
  const target = validateTarget(root.target, 'target', meta.driver);
  const steps = validateSteps(root.steps, 'steps');
  const assertions = validateAssertions(root.assertions, 'assertions');
  const advisory = root.advisory === undefined ? undefined : validateAdvisory(root.advisory, 'advisory');
  return { meta, target, steps, assertions, ...(advisory === undefined ? {} : { advisory }) };
}

function jsonPosition(error: unknown): string {
  if (error instanceof Error) {
    const m = /position (\d+)/.exec(error.message);
    if (m !== null && m[1] !== undefined) return ' at character ' + m[1];
  }
  return '';
}

/** Parses and validates scenario JSON text; `source` is a file path/label. */
export function parseScenario(text: string, source: string): QaScenario {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ScenarioValidationError(source, 'invalid JSON' + jsonPosition(error));
  }
  try {
    return validateScenario(value);
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw new ScenarioValidationError(source + ':' + error.position, error.reason);
    }
    throw error;
  }
}

export function loadScenarioFromPath(path: string): QaScenario {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ScenarioValidationError(path, 'cannot read file');
  }
  return parseScenario(text, path);
}
