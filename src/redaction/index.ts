// Redaction seam for reporters. The full v2 redaction engine is being ported
// from dsh-driver-bench in WP3 (tracked separately); until it lands this module
// is a pass-through that still normalizes values to lossless JSON so reporter
// output is deterministic and serializable. Every reporter routes through
// redactText / projectRedactedJsonValue, so the WP3 swap replaces only this
// file and drops in the real engine behind the same signatures.

// WP3: replaced by the ported v2 engine.
import { toLosslessJson, type JsonValue } from '../session/lossless.ts';

/** Absolute POSIX paths the v2 engine redacts (workspace/temp/artifacts). */
export interface RedactionRoots {
  workspace: string;
  temp: string;
  artifacts: string;
}

// WP3: replaced by the ported v2 engine (redactTextWithRoots).
export function redactText(text: string, _roots?: RedactionRoots): string {
  return text;
}

// WP3: replaced by the ported v2 engine (lossless, key-aware projection).
export function projectRedactedJsonValue(value: unknown, _roots?: RedactionRoots): JsonValue {
  return toLosslessJson(value);
}
