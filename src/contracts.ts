// Core dsh-qa v0.1 contracts. The scenario/step/assertion shapes are the
// Replay (WP4) schema: QaScenario = { meta, target, steps[], assertions[] },
// lossless JSON only. Every step carries the act plus the assertion that must
// hold on the FRESH observation after that act; assertions[] are the final
// assertions evaluated after all steps.

import type { QaActionReceipt, QaEvidence } from './session/adapter.ts';

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
}

export interface QaScenarioTarget {
  /** How the driver reaches the app under test (fixture URL or app bundle id). */
  launch: string;
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
 * the target to a concrete ref from the current observation.
 */
export type QaScenarioAction =
  | { kind: 'click'; target: QaNodePredicate }
  | { kind: 'fill'; target: QaNodePredicate; text: string }
  | { kind: 'press'; target: QaNodePredicate; key: string }
  | { kind: 'navigate'; url: string };

export type QaAssertionKind = 'node-present' | 'node-absent' | 'page-url';

export interface QaAssertion {
  kind: QaAssertionKind;
  /** Expected observation fragment (lossless JSON only), interpreted by kind. */
  expected: unknown;
  description?: string;
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
  failure?: QaRunFailure;
}
