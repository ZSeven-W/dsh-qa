// Fail-closed scenario loader. Unknown fields, malformed steps, missing
// required fields, and non-lossless values are REJECTED with a deterministic
// error naming the structural position (never echoing value bytes). No
// "best effort" repair happens here: a scenario is either fully valid or it
// is refused.

import { readFileSync } from 'node:fs';
import type {
  QaAssertion,
  QaAssertionKind,
  QaDriverKind,
  QaNodePredicate,
  QaScenario,
  QaScenarioAction,
  QaScenarioMeta,
  QaScenarioTarget,
  QaStep,
} from '../contracts.ts';

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
const ASSERTION_KINDS: readonly QaAssertionKind[] = ['node-present', 'node-absent', 'page-url'];
const ROOT_FIELDS = ['meta', 'target', 'steps', 'assertions'] as const;
const META_FIELDS = ['name', 'description', 'driver', 'createdAt'] as const;
const TARGET_FIELDS = ['launch'] as const;
const STEP_FIELDS = ['index', 'intent', 'action', 'assert'] as const;
const ASSERTION_FIELDS = ['kind', 'expected', 'description'] as const;
const PREDICATE_FIELDS = ['role', 'name', 'tag'] as const;

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
  return { name, description, driver, createdAt };
}

function validateTarget(value: unknown, position: string, driver: QaDriverKind): QaScenarioTarget {
  const obj = expectObject(value, position);
  assertKnownFields(obj, TARGET_FIELDS, position);
  const launch = expectNonEmptyString(obj.launch, position + '.launch');
  if (driver === 'browser' && !isValidHttpUrl(launch)) {
    fail(position + '.launch', 'expected an http(s) URL');
  }
  return { launch };
}

function validatePredicate(value: unknown, position: string): QaNodePredicate {
  const obj = expectObject(value, position);
  assertKnownFields(obj, PREDICATE_FIELDS, position);
  const out: QaNodePredicate = {};
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
  fail(position + '.kind', 'unsupported action kind');
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
  if (kind === 'node-present' || kind === 'node-absent') {
    validatePredicate(obj.expected, position + '.expected');
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
  return out;
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
  return { index: indexValue, intent, action, assert };
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
  return { meta, target, steps, assertions };
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
