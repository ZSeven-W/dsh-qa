// Core dsh-qa v0.1 contracts. The scenario/step/assertion shapes are the
// Replay (WP4) schema: QaScenario = { meta, target, steps[], assertions[] },
// lossless JSON only. Every step carries the act plus the assertion that must
// hold on the FRESH observation after that act; assertions[] are the final
// assertions evaluated after all steps.

import type { QaActionReceipt, QaEvidence } from './session/adapter.ts';
import type { QaSettlePolicy } from './session/settle.ts';
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
  /**
   * Scenario-level settle override recorded by qa_record_export from the Explore
   * session's effective policy (present only when it differs from the defaults),
   * and applied by qa_replay_run so replay judges the page with the same settle
   * policy Explore used. All fields optional; the loader validates positive
   * integers and clamps budgetMs <= QA_SETTLE_SCHEMA_BUDGET_MAX and the others
   * <= budgetMs.
   */
  settle?: QaSettleOverride;
}

/** Upper clamp for a persisted scenario settle override budget (ms). */
export const QA_SETTLE_SCHEMA_BUDGET_MAX = 15_000;

/** Optional per-field settle override for a scenario (meta.settle). */
export interface QaSettleOverride {
  budgetMs?: number;
  quietMs?: number;
  postChangeQuietMs?: number;
  intervalMs?: number;
  /** Adaptive (once-per-session widening) budget; 0 disables adaptation. */
  adaptiveBudgetMs?: number;
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

export type QaAssertionKind = 'node-present' | 'node-absent' | 'page-url' | 'node-in-viewport' | 'node-value';

/**
 * Expected shape for a `node-value` assertion: the usual semantic predicate
 * plus the exact observable `value` the node must carry. Equality is EXACT
 * only — a contains/prefix form is deliberately NOT supported in v0.1: a
 * value is the driver-normalized current contents of a control, and a fill
 * proves itself by reproducing that exact value, so a weaker match would turn
 * a co-incidental substring (autocomplete, a shared prefix) into a false
 * green. The value is normalized exactly like the driver normalizes values
 * (trim, collapse whitespace, clip to 180) before comparison.
 */
export interface QaNodeValueExpectation extends QaNodePredicate {
  value: string;
}

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
  /**
   * Settle window the capture's observation was taken from (ADDITIVE, present
   * only when the capture was taken from a fresh settled observation — never
   * when the caller pinned an exact observation). `stable === false` means the
   * view never stopped changing inside the budget, so the advisory verdict sits
   * on an unstable view. Advisory semantics are unchanged either way.
   */
  settle?: { stable: boolean; passes: number; budgetMs: number };
  /**
   * Present exactly when `settle.stable === false`: the capture's observation
   * never settled, so the advisory verdict is over a view that proves nothing.
   * Rendered next to the verdict in report.md / report.json.
   */
  captureSettled?: false;
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

/**
 * Stable reason code recorded when an assertion's outcome could NOT be proven
 * because the observation it was decided against was truncated at its node
 * budget.
 *
 * Observations are budget-limited (QaObservation.truncated): a node that
 * genuinely exists can fall outside the returned window. "Not in the returned
 * nodes" therefore does not mean "not on the page", so a claim that depends on
 * having seen the WHOLE view — every node-absent claim, and any node-present /
 * node-in-viewport claim that found nothing — is unprovable against a truncated
 * view. Such a claim fails CLOSED and carries this code, which is deliberately
 * distinct from an ordinary failure: "we did not see it" is not "it is not
 * there", and reporting the first as the second is a silent false green.
 */
export const QA_INCONCLUSIVE_TRUNCATED = 'INCONCLUSIVE_TRUNCATED';

export type QaInconclusiveReason = typeof QA_INCONCLUSIVE_TRUNCATED;

/**
 * Stable reason code recorded when an assertion (or a post-action consequence)
 * could NOT be proven because the bounded settle window never reached a stable
 * view. It is the fail-closed twin of `QA_INCONCLUSIVE_TRUNCATED`: that code
 * means "the view was incomplete (truncated at its node budget)", this one
 * means "the view never stopped changing within the settle budget". Both are
 * honest non-results, never an ordinary failure, and never a pass.
 */
export const QA_INCONCLUSIVE_UNSTABLE = 'INCONCLUSIVE_UNSTABLE';

export type QaInconclusiveCode = typeof QA_INCONCLUSIVE_TRUNCATED | typeof QA_INCONCLUSIVE_UNSTABLE;

/**
 * Stable reason code for a REPLAY action target that matches more than one
 * observable node. Export already refuses to write such a scenario
 * (TARGET_NOT_UNIQUE exclusion); replay re-checks the same uniqueness before
 * dispatching, because acting on the FIRST of several same-named nodes would
 * be a guess, and a twin that already holds the recorded value would turn a
 * node-value assertion into a false green. Same vocabulary as export.
 */
export const QA_TARGET_NOT_UNIQUE = 'TARGET_NOT_UNIQUE';

/** Machine codes a run failure may carry (QaRunFailure.code); open for future codes. */
export type QaFailureCode =
  | typeof QA_INCONCLUSIVE_UNSTABLE
  | typeof QA_INCONCLUSIVE_TRUNCATED
  | typeof QA_TARGET_NOT_UNIQUE
  | (string & {});

/**
 * Completeness context of the view an assertion was decided against.
 *
 * This is an ADDITIVE field (schemaVersion stays 1) and is present ONLY when
 * truncation actually touched the decision, so a result taken from a complete
 * view is unchanged byte for byte. When it IS present, a human triaging
 * report.json / report.md / report.jsonl can tell "not present" apart from "we
 * could not see the whole page".
 */
export interface QaViewCompleteness {
  /** Whether the FINAL deciding view was still truncated at its node budget. */
  truncated: boolean;
  /**
   * Node budget requested for the deciding observation; null means the driver
   * default applied. Each driver clamps the request to its own maximum, so the
   * observation's own `truncated` flag — not this number — is the ground truth.
   */
  nodeBudget: number | null;
  /** Whether one bounded budget escalation was performed before deciding. */
  escalated: boolean;
  /** Whether this outcome depends on the view being complete (unproven if it is not). */
  outcomeDependsOnCompleteView: boolean;
  /** Present exactly when the outcome could not be proven from an incomplete view. */
  reason?: QaInconclusiveReason;
  /** Deterministic, human-readable explanation naming the budget. */
  detail: string;
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
  /** Completeness of the deciding view; present only when truncation touched the decision. */
  completeness?: QaViewCompleteness;
  /**
   * Stable machine code when the assertion was refused for a structural reason
   * (TARGET_NOT_UNIQUE, VALUE_WITHHELD / VALUE_SECURE / VALUE_TRUNCATED, ...)
   * rather than an ordinary value mismatch. ADDITIVE: schemaVersion stays 1.
   */
  reason?: string;
  /**
   * Bounded-retry accounting for a positive-existence assertion that was
   * re-observed: how many settled observations it was evaluated against, and
   * the wall-clock time that took. Present only when a retry actually ran
   * (attempts > 1). ADDITIVE: schemaVersion stays 1, and both fields are
   * excluded from the determinism projection (they are duration, not outcome).
   */
  attempts?: number;
  elapsedMs?: number;
}

export interface QaAssertionResult {
  kind: QaAssertionKind;
  description?: string;
  passed: boolean;
  expected: unknown;
  observed: unknown;
  /** Completeness of the deciding view; present only when truncation touched the decision. */
  completeness?: QaViewCompleteness;
  /**
   * Stable machine code when the assertion was refused for a structural reason
   * (TARGET_NOT_UNIQUE, VALUE_WITHHELD / VALUE_SECURE / VALUE_TRUNCATED, ...)
   * rather than an ordinary value mismatch. ADDITIVE: schemaVersion stays 1.
   */
  reason?: string;
  /**
   * Bounded-retry accounting (see QaStepResult.attempts). Present only when a
   * retry actually ran. ADDITIVE and excluded from the determinism projection.
   */
  attempts?: number;
  elapsedMs?: number;
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
  /**
   * Stable machine code when the failure is a recognized non-result or
   * structural refusal (INCONCLUSIVE_UNSTABLE, INCONCLUSIVE_TRUNCATED,
   * TARGET_NOT_UNIQUE, ...) instead of an ordinary assertion failure.
   * ADDITIVE: schemaVersion stays 1; ordinary failures omit it.
   */
  code?: QaFailureCode;
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

/**
 * Counts of step action receipts by driver status, plus a transparency warning
 * when zero receipts were confirmed. This is ADDITIVE (schemaVersion stays 1):
 * it is derived deterministically from steps[].receipt and lets a reader tell a
 * run that passed on a confirmed dispatch from one that passed only because the
 * settled observation decided an unknown/rejected receipt. It never changes the
 * run status (the decide-by-observation policy is unchanged).
 */
export interface QaReceiptSummary {
  confirmed: number;
  unknown: number;
  rejected: number;
  failed: number;
  /** Non-null receipt count across all steps (confirmed + unknown + rejected + failed). */
  total: number;
  /** Present only when zero receipts were confirmed but at least one was dispatched. */
  warning?: string;
}

/**
 * Fixed warning text emitted when a run dispatched at least one action but none
 * was confirmed by the driver — the outcomes were decided by settled observation
 * alone. Transparency, not a status change.
 */
export const QA_NO_CONFIRMED_RECEIPTS_WARNING =
  'no action dispatch was confirmed by the driver; outcomes were decided by settled observation only';

/**
 * Structured marker for a failed evidence collection, replacing the old silent
 * `evidence: null`. `reason` is the (redacted) error message.
 */
export interface QaEvidenceCollectionFailure {
  status: 'collection-failed';
  reason: string;
}
/**
 * The widening a run (or session) performed, recorded so report.json/report.md
 * can show whether/when the settle budget widened and why. `at` is the step
 * index where it happened, 'initial' when it happened on the run's initial
 * observation, or 'final' when a final assertion's retry widened it.
 */
export interface QaSettleWidening {
  fromMs: number;
  toMs: number;
  at: number | 'initial' | 'final';
  /**
   * Why the budget widened: 'unstable' (a settle window still churning at the
   * budget) or 'assertion-retry' (a positive-existence assertion retry that
   * exhausted its budget without finding its target). ADDITIVE: schemaVersion
   * stays 1.
   */
  cause: 'unstable' | 'assertion-retry';
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
  /** Driver evidence, or a structured marker when evidence collection failed. */
  evidence: QaEvidence | QaEvidenceCollectionFailure | null;
  /** Deterministic counts of step receipts by driver status. */
  receiptSummary: QaReceiptSummary;
  /** Structured artifact/evidence paths (screenshot/trace/evidence). */
  artifacts?: QaArtifact[];
  /** Advisory visual findings (non-deterministic; excluded from determinism by schema). */
  advisory?: QaAdvisoryResult[];
  failure?: QaRunFailure;
  /**
   * The effective settle policy this run applied (scenario meta.settle over
   * env/host defaults), reflecting the WIDENED budget when the run widened.
   * Printed in report.json / report.md so a reader can see which budget the run
   * actually judged the page under. Deterministic.
   */
  settle?: QaSettlePolicy;
  /**
   * Present exactly when the run widened its settle budget once (adaptation
   * enabled): the before/after budgets, where ('initial', a step index, or
   * 'final'), and why ('unstable' when a view was still churning at budgetMs,
   * 'assertion-retry' when a positive-existence assertion retry exhausted its
   * budget). Deterministic.
   */
  settleWidened?: QaSettleWidening;
}