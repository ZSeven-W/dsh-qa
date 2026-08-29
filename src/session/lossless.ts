// The single unified lossless-JSON layer for dsh-qa.
//
// Two contracts share one JsonValue type and live side by side:
//
//   1. toLosslessJson — the MCP tool-boundary COERCER. The DSH host rejects
//      tool results that carry keys with an undefined value, non-finite
//      numbers (NaN/Infinity), or negative zero, so this returns a clean value
//      instead: undefined-valued keys are dropped, non-finite numbers become
//      null, and -0 is normalized to +0. It is lossy by design and must never
//      be used where fail-closed rejection is required.
//
//   2. normalizeJsonValue — the fail-closed STRUCTURAL VALIDATOR used by the
//      redaction projection (src/redaction/index.ts). It is a faithful port of
//      dsh-driver-bench's normalizeJsonValue (src/contracts/bench.ts @
//      a7af98d): undefined, non-finite numbers, bigints, functions, symbols,
//      symbol keys, accessors, sparse/non-plain objects, Proxies (including
//      revoked), cycles, and excessive depth all throw a deterministic error
//      whose message carries only structural positions (an index or a "<key>"
//      placeholder) — never a key spelling and never value bytes (spec §2.0 /
//      R4, corpus row 99). Getters are never invoked: accessors are rejected
//      by reading own property descriptors only. Cycles are detected with a
//      WeakSet visited guard, not recursion-until-the-stack-dies.

import { types } from 'node:util';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function toLosslessJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toLosslessJson(item));
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      result[key] = toLosslessJson(child);
    }
    return result;
  }
  // bigint, function, symbol, and undefined are not lossless JSON.
  return null;
}

// ---------------------------------------------------------------------------
// Fail-closed structural normalization (ported from dsh-driver-bench
// src/contracts/bench.ts @ a7af98d). Used by the redaction projection only.
// ---------------------------------------------------------------------------

function isPlainObject(value: object): boolean {
  if (types.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectSymbolKeys(value: object, path: string): void {
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    throw new TypeError(path + '["<symbol>"]: symbol-keyed property is not lossless JSON');
  }
}

function rejectNonPlainPrototype(value: object, path: string): void {
  if (!isPlainObject(value)) {
    throw new TypeError(path + ': non-plain object is not lossless JSON');
  }
}

const MAX_NESTING_DEPTH = 256;

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

function isCanonicalArrayIndexKey(key: string, length: number): boolean {
  return CANONICAL_ARRAY_INDEX.test(key) && Number(key) < length;
}

function joinPath(
  parent: string,
  key: string,
  isCanonicalArrayIndex: boolean,
): string {
  if (isCanonicalArrayIndex) {
    return parent + '[' + key + ']';
  }
  // Structural-only error paths (spec R4 / corpus row 99): never echo any
  // key spelling — a sensitive value used as a key must not surface through
  // a thrown message.
  return parent + '["<key>"]';
}

function rejectAccessors(value: object, path: string, isArray: boolean): void {
  const length = Array.isArray(value) ? value.length : 0;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
      const label = typeof key === 'symbol' ? '<symbol>' : key;
      const isCanonicalIndex =
        isArray && typeof key === 'string' && isCanonicalArrayIndexKey(key, length);
      throw new TypeError(
        joinPath(path, label, isCanonicalIndex) + ': accessor property is not lossless JSON',
      );
    }
  }
}

function normalize(
  value: unknown,
  path: string,
  stack: WeakSet<object>,
  depth: number,
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(path + ': non-finite number is not finite lossless JSON');
    }
    return value === 0 ? 0 : value;
  }

  if (typeof value === 'object') {
    if (depth > MAX_NESTING_DEPTH) {
      throw new TypeError(path + ': exceeds the maximum nesting depth of ' + MAX_NESTING_DEPTH);
    }

    if (stack.has(value)) {
      throw new TypeError(path + ': cyclic value is not lossless JSON');
    }

    // Reject proxies before Array.isArray can invoke the revoked-proxy
    // internal TypeError. A revoked proxy cannot be inspected to determine
    // whether it was an array, so it fails closed as a non-plain object; live
    // proxy arrays still receive the established non-plain-array message.
    if (types.isProxy(value)) {
      let isArray = false;
      try {
        isArray = Array.isArray(value);
      } catch {
        // Revoked proxy: util.types.isProxy is safe, but IsArray is not.
      }
      if (isArray) {
        throw new TypeError(path + ': non-plain array is not lossless JSON');
      }
      throw new TypeError(path + ': non-plain object is not lossless JSON');
    }

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(path + ': non-plain array is not lossless JSON');
      }

      rejectSymbolKeys(value, path);
      rejectAccessors(value, path, true);
      stack.add(value);
      try {
        const length = value.length;
        const result: JsonValue[] = new Array<JsonValue>(length);

        for (let index = 0; index < length; index++) {
          const indexPath = joinPath(path, String(index), true);
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined) {
            throw new TypeError(indexPath + ': sparse array is not lossless JSON');
          }
          if (!descriptor.enumerable) {
            throw new TypeError(indexPath + ': non-enumerable property is not lossless JSON');
          }
          if (descriptor.value === undefined) {
            throw new TypeError(indexPath + ': undefined is not JSON');
          }
          result[index] = normalize(descriptor.value, indexPath, stack, depth + 1);
        }

        for (const key of Object.getOwnPropertyNames(value)) {
          if (key === 'length') {
            continue;
          }
          if (!isCanonicalArrayIndexKey(key, length)) {
            throw new TypeError(
              joinPath(path, key, false) + ': array property is not lossless JSON',
            );
          }
        }

        return result;
      } finally {
        stack.delete(value);
      }
    }

    rejectNonPlainPrototype(value, path);
    rejectSymbolKeys(value, path);
    rejectAccessors(value, path, false);
    stack.add(value);
    try {
      const result: Record<string, JsonValue> = {};

      const names = Object.getOwnPropertyNames(value);
      names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

      for (const key of names) {
        const childPath = joinPath(path, key, false);
        const descriptor = Object.getOwnPropertyDescriptor(value, key) as PropertyDescriptor;
        if (!descriptor.enumerable) {
          throw new TypeError(childPath + ': non-enumerable property is not lossless JSON');
        }
        const child = descriptor.value;
        if (child === undefined) {
          throw new TypeError(childPath + ': undefined is not JSON');
        }
        Object.defineProperty(result, key, {
          value: normalize(child, childPath, stack, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }

      return result;
    } finally {
      stack.delete(value);
    }
  }

  const kind =
    typeof value === 'bigint'
      ? 'bigint'
      : typeof value === 'function'
        ? 'function'
        : typeof value === 'symbol'
          ? 'symbol'
          : typeof value === 'undefined'
            ? 'undefined'
            : 'unsupported';

  throw new TypeError(path + ': ' + kind + ' is not lossless JSON');
}

export function normalizeJsonValue(value: unknown, path = '$'): JsonValue {
  return normalize(value, path, new WeakSet<object>(), 1);
}
