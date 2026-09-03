// Deterministic projection for Replay comparison. Advisory visual results are
// EXCLUDED BY SCHEMA here (the dedicated `advisory` field), not by ad-hoc
// filtering, so a replay with advisory visual assertions still satisfies the
// two-run byte-identical contract after timestamp normalization.

import type { QaRunReport } from '../contracts.ts';

const FIXED_TIMESTAMP = '<timestamp>';

/** Fields excluded by schema from the determinism comparison. */
const EXCLUDED_FIELDS = new Set(['advisory', 'artifacts', 'evidence']);

/** Bounded-retry accounting fields: duration artifacts, never outcome. */
const RETRY_FIELDS = new Set(['attempts', 'elapsedMs']);

/** Strip the per-step/per-assertion retry accounting from a subtree. */
function stripRetryFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripRetryFields);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (RETRY_FIELDS.has(key)) continue;
      out[key] = stripRetryFields(child);
    }
    return out;
  }
  return value;
}

/**
 * Project a run report into a deterministic shape for byte-identical
 * comparison. Advisory verdicts/reasoning (non-deterministic by design),
 * capture artifact paths (per-run temp files), driver evidence (per-run
 * timestamps), and the bounded-retry accounting (attempts/elapsedMs are
 * duration, not outcome) are excluded; the remaining run timestamps are
 * normalized to a fixed placeholder.
 */
export function normalizeReportForDeterminism(report: QaRunReport): unknown {
  const record = report as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    if (key === 'startedAt' || key === 'finishedAt') {
      projected[key] = FIXED_TIMESTAMP;
      continue;
    }
    if (key === 'steps' || key === 'assertions') {
      projected[key] = stripRetryFields(record[key]);
      continue;
    }
    projected[key] = record[key];
  }
  return projected;
}
