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
// single lossless-JSON layer (JsonValue + normalizeJsonValue). The projection
// below reuses its fail-closed structural normalizer directly - no competing
// JsonValue definition and no second normalization path. Accessors, non-plain
// objects, sparse arrays, cycles, non-finite numbers, and excessive depth all
// reject with deterministic structural-only errors (spec R4).

import { normalizeJsonValue, type JsonValue } from '../session/lossless.ts';
import {
  redactText,
  redactTextWithRoots,
  validateRoots,
  isSensitiveKey,
  projectArtifactPath as projectArtifactPathWithRoots,
  type RedactionRoots,
  type NormalizedRedactionRoots,
} from './engine.ts';

export {
  redactText,
  redactTextWithRoots,
  validateRoots,
  isSensitiveKey,
};
export type { RedactionRoots, NormalizedRedactionRoots };

// Public dsh-qa path projection (see engine.projectArtifactPath): validates
// roots once and projects one structured artifact path through the fail-closed
// whitelist. The reporter-facing projection routes report.artifacts[].path
// through this automatically; this export is for direct callers (the Markdown
// reporter) that render artifact paths outside the full JSON projection.
export function projectArtifactPath(value: string, roots?: RedactionRoots): string {
  if (typeof value !== 'string') {
    throw new TypeError('projectArtifactPath: value must be a string');
  }
  const normalized = roots === undefined ? undefined : validateRoots(roots);
  return projectArtifactPathWithRoots(value, normalized);
}

// Structural-only error paths (spec R4 / corpus row 99): never echo any key
// spelling - a sensitive value used as a key must not surface through a thrown
// message.
function joinProjectionPath(parent: string, _key: string): string {
  return parent + '["<key>"]';
}

type ProjectionSegment = string | number;

const ANDROID_IDENTIFIER_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ANDROID_RESOURCE_SEPARATOR = ':id/';

/**
 * NARROW typed structural projection for real Android resource IDs.
 *
 * A fully qualified Android resource ID is `package.name:id/resourceName`.
 * The generic free-text redactor treats `dev.zseven.qa.fixture.android:id/qa_input_name`
 * as a URI/credential-shaped token and replaces the whole string, which makes
 * the stable resourceId unusable as a durable Replay selector. This projection
 * preserves ONLY strings that:
 *
 *   1. occur under a stable-identifier/tag JSON key (mobile observations,
 *      predicates, assertions; never arbitrary prose),
 *   2. match the Android resource-id grammar exactly,
 *   3. contain no credential-shaped component (password/token/secret/...).
 *
 * Everything else keeps the existing fail-closed redaction path.
 */
function androidResourceShape(value: string): { pkg: string; resource: string; packageSegments: string[] } | null {
  const marker = value.indexOf(ANDROID_RESOURCE_SEPARATOR);
  if (marker <= 0) return null;
  if (value.indexOf(ANDROID_RESOURCE_SEPARATOR, marker + 1) !== -1) return null;
  const pkg = value.slice(0, marker);
  const resource = value.slice(marker + ANDROID_RESOURCE_SEPARATOR.length);
  if (pkg === '' || resource === '') return null;
  if (pkg.includes('/') || resource.includes('/') || resource.includes('.')) return null;
  const packageSegments = pkg.split('.');
  for (const segment of packageSegments) {
    if (!ANDROID_IDENTIFIER_SEGMENT.test(segment)) return null;
  }
  if (!ANDROID_IDENTIFIER_SEGMENT.test(resource)) return null;
  return { pkg, resource, packageSegments };
}

export function isAndroidResourceId(value: string): boolean {
  const shape = androidResourceShape(value);
  if (shape === null) return false;
  for (const segment of shape.packageSegments) {
    if (isSensitiveKey(segment)) return false;
  }
  if (isSensitiveKey(shape.resource)) return false;
  return true;
}

/** True only for an otherwise-valid Android resource ID shape that must be redacted (credential-shaped). */
function isRejectedAndroidResourceId(value: string): boolean {
  const shape = androidResourceShape(value);
  if (shape === null) return false;
  for (const segment of shape.packageSegments) {
    if (isSensitiveKey(segment)) return true;
  }
  return isSensitiveKey(shape.resource);
}

function isStableIdentifierPosition(segments: readonly ProjectionSegment[]): boolean {
  const last = segments[segments.length - 1];
  return last === 'identifier' || last === 'tag';
}

// dsh-qa-specific: the ONLY structured artifact-path positions in QaRunReport
// are report.artifacts[].path and report.advisory[].artifact.path. These route
// through the fail-closed path projection (projectArtifactPath) instead of the
// free-text engine. Every other string leaf — including free-text occurrences
// of paths inside messages, console output, and evidence blobs — keeps going
// through the normal engine with R3 enabled.
function isArtifactPathPosition(segments: readonly ProjectionSegment[]): boolean {
  if (
    segments.length === 3 &&
    segments[0] === 'artifacts' &&
    typeof segments[1] === 'number' &&
    segments[2] === 'path'
  ) {
    return true;
  }
  return (
    segments.length === 4 &&
    segments[0] === 'advisory' &&
    typeof segments[1] === 'number' &&
    segments[2] === 'artifact' &&
    segments[3] === 'path'
  );
}

// Key-aware, lossless redacted JSON projection (ported from
// dsh-driver-bench src/reporters/json.ts). The input tree is already
// normalized by normalizeJsonValue, so every object is a plain object with
// own enumerable data properties. The projection is one recursive pass:
//   - every string VALUE and every object KEY runs through redactTextWithRoots
//     (except report.artifacts[].path, which runs through the path projection);
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
  segments: readonly ProjectionSegment[] = [],
): JsonValue {
  if (typeof value === 'string') {
    if (isArtifactPathPosition(segments)) {
      return projectArtifactPathWithRoots(value, roots);
    }
    if (isStableIdentifierPosition(segments)) {
      if (isAndroidResourceId(value)) {
        // Android resource IDs are operational stable selectors, not prose or
        // credentials. The typed grammar check above refuses credential-shaped
        // components, so this is not a broad identifier/tag bypass.
        return value;
      }
      if (isRejectedAndroidResourceId(value)) {
        // A structurally Android resource-shaped value whose package or
        // resource name is credential-shaped fails closed to a full redaction,
        // never a partial echo of the stable selector.
        return '[REDACTED]';
      }
    }
    return redactTextWithRoots(value, roots);
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = new Array<JsonValue>(value.length);
    for (let index = 0; index < value.length; index++) {
      result[index] = projectJsonValue(value[index]!, roots, path + '[' + index + ']', [...segments, index]);
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
          : projectJsonValue(child as JsonValue, roots, joinProjectionPath(path, projectedKey), [...segments, originalKey]);
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

// Reporter-facing projection: fail-closed normalization through dsh-qa's
// normalizeJsonValue first (rejecting accessors, non-plain objects, sparse
// arrays, cycles, non-finite numbers, and excessive depth with structural-only
// errors), then projects the redacted JSON tree. Supplied roots are validated
// exactly once up front (even when the tree has no string leaves); omitted
// roots still apply every non-path redactText security pass.
export function projectRedactedJsonValue(value: unknown, roots?: RedactionRoots): JsonValue {
  const normalized = normalizeJsonValue(value);
  const validatedRoots = roots === undefined ? undefined : validateRoots(roots);
  return projectJsonValue(normalized, validatedRoots, '$');
}
