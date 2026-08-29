// Defensive lossless-JSON normalizer for every value that crosses the MCP
// tool boundary. The DSH host rejects tool results that carry keys with an
// undefined value, non-finite numbers (NaN/Infinity), or negative zero, so
// this returns a clean value instead: undefined-valued keys are dropped,
// non-finite numbers become null, and -0 is normalized to +0.

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
