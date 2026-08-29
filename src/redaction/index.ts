// dsh-qa redaction seam (WP3): the fail-closed v2 redaction engine, ported
// from dsh-driver-bench at commit a7af98d (branch feat/v0.1). Reporters import
// redactText / projectRedactedJsonValue / RedactionRoots from this module
// only, so this is a drop-in replacement for the temporary pass-through seam.
//
// Port provenance:
//   - ./engine.ts                       <- dsh-driver-bench src/redaction/engine.ts @ a7af98d
//   - projectRedactedJsonValue (below)  <- dsh-driver-bench src/reporters/json.ts @ a7af98d,
//                                          adapted to dsh-qa's lossless layer.
//
// Type-system reconciliation (task 2): dsh-qa's src/session/lossless.ts is the
// single lossless-JSON layer (JsonValue + toLosslessJson). The projection below
// reuses it directly - no competing JsonValue definition and no second
// normalization path is introduced. The three lossless-JSON invariants hold
// exactly: no undefined-valued keys, no NaN/Infinity, negative zero normalized.

import { types } from 'node:util';
import { toLosslessJson, type JsonValue } from '../session/lossless.ts';
import {
  redactText,
  redactTextWithRoots,
  validateRoots,
  isSensitiveKey,
  configureHighEntropyThresholds,
  type RedactionRoots,
  type NormalizedRedactionRoots,
} from './engine.ts';

export {
  redactText,
  redactTextWithRoots,
  validateRoots,
  isSensitiveKey,
  configureHighEntropyThresholds,
};
export type { RedactionRoots, NormalizedRedactionRoots };

// Fail-closed structural guard (spec R4 / corpus r14 + r16): a Proxy is not a
// lossless JSON value, so it is rejected before any trap can fire - exactly as
// the engine's validateRoots rejects Proxy roots. util.types.isProxy performs
// no trap and also recognizes revoked proxies, so the deterministic error below
// covers both live and revoked proxies.
function rejectProxyValue(value: unknown): void {
  if (types.isProxy(value)) {
    throw new TypeError(
      'projectRedactedJsonValue: non-plain object is not lossless JSON (Proxy rejected)',
    );
  }
}

// Structural-only error paths (spec R4 / corpus row 99): never echo any key
// spelling - a sensitive value used as a key must not surface through a thrown
// message.
function joinProjectionPath(parent: string, _key: string): string {
  return parent + '["<key>"]';
}

// Key-aware, lossless redacted JSON projection (ported from
// dsh-driver-bench src/reporters/json.ts). The input tree is already
// normalized by toLosslessJson, so every object is a plain object with own
// enumerable data properties. The projection is one recursive pass:
//   - every string VALUE and every object KEY runs through redactTextWithRoots;
//   - when a key's redacted text differs from the original key, or the key
//     classifies sensitive by the same isSensitiveKey classifier, the ENTIRE
//     value subtree is replaced by "[REDACTED]" (fail closed);
//   - object keys are re-sorted by deterministic code-unit order, arrays keep
//     order, and +0 survives the normalizer;
//   - two distinct original keys that project to the same key fail closed with
//     a deterministic error carrying only the safe structural path;
//   - own enumerable __proto__/constructor data keys are preserved via
//     defineProperty, so nothing is ever written through the prototype chain.
function projectJsonValue(
  value: JsonValue,
  roots: NormalizedRedactionRoots | undefined,
  path: string,
): JsonValue {
  if (typeof value === 'string') {
    return redactTextWithRoots(value, roots);
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = new Array<JsonValue>(value.length);
    for (let index = 0; index < value.length; index++) {
      result[index] = projectJsonValue(value[index]!, roots, path + '[' + index + ']');
    }
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const entries: Array<readonly [key: string, value: JsonValue]> = [];
    const projected = new Set<string>();
    for (const originalKey of Object.keys(value)) {
      const projectedKey = redactTextWithRoots(originalKey, roots);
      if (projected.has(projectedKey)) {
        // Deterministic fail-closed collision: the message carries only the
        // safe structural path of the colliding object and never either
        // original key or any value.
        throw new TypeError('projectRedactedJsonValue: key collision at ' + path);
      }
      projected.add(projectedKey);
      // The tree was already normalized, so every key is an own enumerable
      // data property (descriptor.value is a JsonValue and never undefined);
      // reading through the descriptor keeps __proto__/constructor own data
      // keys off the prototype chain.
      const descriptor = Object.getOwnPropertyDescriptor(value, originalKey);
      const child = descriptor === undefined ? undefined : descriptor.value;
      const projectedValue: JsonValue =
        isSensitiveKey(originalKey) || projectedKey !== originalKey
          ? '[REDACTED]'
          : projectJsonValue(child as JsonValue, roots, joinProjectionPath(path, projectedKey));
      entries.push([projectedKey, projectedValue]);
    }
    entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    const result: Record<string, JsonValue> = {};
    for (const [key, value] of entries) {
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

// Reporter-facing projection: losslessly normalizes `value` through dsh-qa's
// toLosslessJson first, then projects the redacted JSON tree. Supplied roots
// are validated exactly once up front (even when the tree has no string
// leaves); omitted roots still apply every non-path redactText security pass.
export function projectRedactedJsonValue(value: unknown, roots?: RedactionRoots): JsonValue {
  rejectProxyValue(value);
  const normalized = toLosslessJson(value);
  const validatedRoots = roots === undefined ? undefined : validateRoots(roots);
  return projectJsonValue(normalized, validatedRoots, '$');
}
