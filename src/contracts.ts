// Core dsh-qa v0.1 contracts. The scenario/step/assertion shapes are the
// Replay (WP4) schema: QaScenario = { meta, target, steps[], assertions[] },
// lossless JSON only. Every step carries the act plus the assertion that must
// hold on the FRESH observation after that act; assertions[] are the final
// assertions evaluated after all steps.

import type { QaActionReceipt, QaEvidence } from './session/adapter.ts';
import type { QaLoginStateConfig } from './loginState.ts';

export type QaDriverKind = 'browser' | 'computer';

/** Driver kinds dsh-qa v0.1 targets, in adapter registration order. */
export const QA_DRIVERS = ['browser', 'computer'] as const;

/** The MCP tool surface the Explore agent drives; fixed for v0.1. */
export const QA_TOOL_NAMES = [
  'qa_session_start',
  'qa_observe',
  'qa_act',
  'qa_assert',
  'qa_evidence',
  'qa_record_export',
  'qa_replay_run',
  'qa_session_stop',
] as const;

export interface QaScenarioMeta {
  name: string;
  description: string;
  driver: QaDriverKind;
  /** Creation timestamp of the scenario file (ISO 8601). */
  createdAt: string;
  /** Deterministic informational notes (Explore visual findings surfaced as notes). */
  notes?: string[];
}

export interface QaScenarioTarget {
  /** How the driver reaches the app under test (fixture URL or app bundle id). */
  launch: string;
  /** Browser-only: owner-authorized, scoped login-state injection (see loginState.ts). */
  loginState?: QaLoginStateConfig;
}

/** Semantic predicate a scenario action/assertion matches against observable nodes. */
export interface QaNodePredicate {
  role?: string;
  name?: string;
  tag?: string;
}

/**
 * A scenario action: the act plus a semantic target. Refs are opaque and
 * session-local, so scenarios address nodes semantically; the runner resolves
 * the target to a concrete ref from the current observation. Scroll has two
 * forms: scroll-to-target (semantic ref) and positional viewport scroll
 * (direction + optional amount); the exporter prefers the target form.
 */
export type QaScenarioAction =
  | { kind: 'click'; target: QaNodePredicate }
  | { kind: 'fill'; target: QaNodePredicate; text: string }
  | { kind: 'press'; target: QaNodePredicate; key: string }
  | { kind: 'navigate'; url: string }
  | { kind: 'scroll'; target: QaNodePredicate }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: 'page' | number }
  | { kind: 'select'; target: QaNodePredicate; option: string }
  | { kind: 'hover'; target: QaNodePredicate };

export type QaAssertionKind = 'node-present' | 'node-absent' | 'page-url' | 'node-in-viewport';

export interface QaAssertion {
  kind: QaAssertionKind;
  /** Expected observation fragment (lossless JSON only), interpreted by kind. */
  expected: unknown;
  description?: string;
}

/**
 * A visual assertion: ADVISORY in Replay (executed, recorded, never affects
 * pass/fail) and a first-class finding in Explore. Its model verdict is
 * inherently non-deterministic, so it lives in a dedicated schema field that
 * the determinism comparison excludes by schema — never by ad-hoc filtering.
 */
export interface QaVisualAssertion {
  kind: 'visual';
  question: string;
  description?: string;
}

/**
 * Trust label carried by every advisory `reasoning` string.
 *
 * Live evidence (deepseek-v4-flash-vision-exp, real capture of the current
 * Wikipedia header): asked whether a serif "WIKIPEDIA" wordmark was present the
 * model returned the CORRECT verdict 'yes' at confidence 1.00 — and then
 * narrated "...with the puzzle globe logo", a logo that is NOT on that page
 * (a separate assertion in the same session correctly answered 'no' to "is the
 * puzzle globe present" at 0.97). The verdict was right; the narration was
 * invented. Therefore `verdict` + `confidence` are the model's answer and the
 * only part a consumer may act on, while `reasoning` is unverified narration
 * that may contain fabricated detail and must never be quoted as observed fact.
 */
export const QA_ADVISORY_REASONING_TRUST = 'unverified-model-narration';

export type QaAdvisoryReasoningTrust = typeof QA_ADVISORY_REASONING_TRUST;

/**
 * One advisory visual finding recorded in a report. `reason` carries a stable
 * code when the verdict degraded (e.g. 'vision-model-unavailable'); the
 * question and reasoning pass through the redaction engine like any other
 * value.
 */
export interface QaAdvisoryResult {
  kind: 'visual';
  question: string;
  verdict: 'yes' | 'no' | 'unclear';
  confidence: number;
  reasoning: string;
  /**
   * Always QA_ADVISORY_REASONING_TRUST. This is an ADDITIVE field (schemaVersion
   * stays 1): `reasoning` keeps its name and meaning, and this adjacent flag
   * carries the warning semantics so a machine consumer of report.json /
   * report.jsonl cannot read narration as observed fact. See
   * docs/REDACTION_SPEC.md section 7.3.
   */
  reasoningTrust: QaAdvisoryReasoningTrust;
  reason?: string;
  description?: string;
  /** Structured reference to the captured PNG (projected through the whitelist). */
  artifact?: QaArtifact;
}

export interface QaStep {
  /** 1-based step ordinal; must equal its position in steps[]. */
  index: number;
  /** Natural-language intent recorded by Explore; Replay asserts on it. */
  intent: string;
  /** The act to perform. */
  action: QaScenarioAction;
  /** Assertion evaluated against the FRESH observation after this step's act. */
  assert: QaAssertion;
}

export interface QaScenario {
  meta: QaScenarioMeta;
  target: QaScenarioTarget;
  steps: QaStep[];
  /** Final assertions evaluated against the final observation (after all steps). */
  assertions: QaAssertion[];
  /** Advisory visual assertions, evaluated and recorded but never affecting status. */
  advisory?: QaVisualAssertion[];
}

export type QaRunStatus = 'pass' | 'fail' | 'blocked';

export interface QaObservedNode {
  role: string;
  name: string;
  tag: string;
}

export interface QaStepResult {
  index: number;
  intent: string;
  status: 'pass' | 'fail';
  action: QaScenarioAction;
  receipt: QaActionReceipt | null;
  /** Session-core outcome for the act: 'ok' | 'unknown' | 'failed'. */
  outcome: 'ok' | 'unknown' | 'failed';
  assertion: QaAssertion;
  assertionPassed: boolean;
  /** Observed fragment the assertion was evaluated against (lossless JSON). */
  observed: unknown;
  expected: unknown;
}

export interface QaAssertionResult {
  kind: QaAssertionKind;
  description?: string;
  passed: boolean;
  expected: unknown;
  observed: unknown;
}

export interface QaReproductionStep {
  index: number;
  intent: string;
  action: QaScenarioAction;
  observed: unknown;
  expected: unknown;
  receipt: QaActionReceipt | null;
}

export interface QaRunFailure {
  /** 1-based failing step index, or null when a final assertion failed. */
  stepIndex: number | null;
  message: string;
  reproduction: QaReproductionStep[];
}

/**
 * A structured artifact/evidence path in a QaRunReport. "path" is an absolute
 * filesystem path under a configured redaction root (workspace/temp/artifacts)
 * and is projected through the dedicated fail-closed path whitelist
 * (projectArtifactPath), not the free-text redaction engine. "kind" is a
 * free-text label (e.g. "screenshot", "trace", "evidence") that still passes
 * through the normal engine.
 */
export interface QaArtifact {
  path: string;
  kind: string;
}

export interface QaRunReport {
  schemaVersion: 1;
  scenario: string;
  driver: QaDriverKind;
  status: QaRunStatus;
  startedAt: string;
  finishedAt: string;
  steps: QaStepResult[];
  assertions: QaAssertionResult[];
  evidence: QaEvidence | null;
  /** Structured artifact/evidence paths (screenshot/trace/evidence). */
  artifacts?: QaArtifact[];
  /** Advisory visual findings (non-deterministic; excluded from determinism by schema). */
  advisory?: QaAdvisoryResult[];
  failure?: QaRunFailure;
}
