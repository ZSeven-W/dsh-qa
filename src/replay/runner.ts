import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_ADVISORY_REASONING_TRUST, QA_INCONCLUSIVE_TRUNCATED, QA_INCONCLUSIVE_UNSTABLE, QA_NO_CONFIRMED_RECEIPTS_WARNING, QA_TARGET_NOT_UNIQUE } from '../contracts.ts';
import type {
  QaAdvisoryResult,
  QaArtifact,
  QaAssertionResult,
  QaEvidenceCollectionFailure,
  QaNodePredicate,
  QaReceiptSummary,
  QaReproductionStep,
  QaRunFailure,
  QaRunReport,
  QaScenario,
  QaScenarioAction,
  QaSettleWidening,
  QaStepResult,
  QaViewCompleteness,
} from '../contracts.ts';
import type { QaAction, QaActionReceipt, QaDriverAdapter, QaEvidence, QaObservation, QaVisualCapture } from '../session/adapter.ts';
import { captureLatestVisual, QaSession, type QaActResult } from '../session/session.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import { evaluateVisualQuestion, persistCaptureFile, type QaVisualServices } from '../vision.ts';
import {
  decideAssertionWithRetry,
  matchesNode,
  sessionReobserve,
  QA_ESCALATED_NODE_BUDGET,
  type QaAssertionDecision,
  type QaReobserve,
} from './assertions.ts';

export interface ReplayRunOptions {
  ownerId?: string;
  headless?: boolean;
  /** Override target.launch (e.g. a dynamically bound fixture port). */
  launchUrl?: string;
  /** Optional vision services for advisory visual assertions. */
  visual?: QaVisualServices;
  /**
   * Bounded settle policy for every verification observation. It MUST match the
   * policy Explore used at export time (both default to resolveSettlePolicy):
   * if one side settles and the other does not, they judge different views of
   * the same page and disagree by construction.
   */
  settle?: Partial<QaSettlePolicy>;
}

/** Deterministic, honest failure message for a view that never stabilized. */
function unsettledMessage(what: string, budgetMs: number): string {
  return 'the ' + what + ' observation never settled within the ' + String(budgetMs) + 'ms settle budget';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Error carrying a machine failure code into QaRunFailure.code. */
class QaCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QaCodeError';
    this.code = code;
  }
}

/** The failure code an error carries, when it carries one. */
function failureCodeFor(error: unknown): string | undefined {
  return error instanceof QaCodeError ? error.code : undefined;
}

/** Human-readable spelling of an action-target predicate, for failure messages. */
function describeTarget(target: QaNodePredicate): string {
  const parts: string[] = [];
  if (target.role !== undefined) parts.push('role "' + target.role + '"');
  if (target.name !== undefined) parts.push('name "' + target.name + '"');
  if (target.tag !== undefined) parts.push('tag "' + target.tag + '"');
  return parts.length === 0 ? 'no fields' : parts.join(', ');
}

function resolveRef(target: QaNodePredicate, observation: QaObservation): string {
  const matches = observation.nodes.filter((node) => matchesNode(node, target));
  if (matches.length === 0) {
    throw new Error('no observable node matches the action target');
  }
  if (matches.length > 1) {
    // Export refuses a non-unique (role, name) target; replay re-checks the
    // same uniqueness before dispatching. Acting on the FIRST of several
    // same-named nodes would be a guess — a twin that already holds the
    // recorded value would turn the step's node-value into a false green
    // while the recorded target stays empty. Fail closed instead.
    const first = matches[0];
    if (first === undefined) throw new Error('no observable node matches the action target');
    throw new QaCodeError(
      QA_TARGET_NOT_UNIQUE,
      QA_TARGET_NOT_UNIQUE + ': ' + String(matches.length) + ' nodes match the action target ('
      + describeTarget(target) + '); the recorded target is not uniquely identifiable, so no action was dispatched',
    );
  }
  const only = matches[0];
  if (only === undefined) throw new Error('no observable node matches the action target');
  return only.ref;
}

/** The semantic target an action resolves to a ref, or null when it needs none. */
function targetOf(action: QaScenarioAction): QaNodePredicate | null {
  if (action.kind === 'navigate') return null;
  if (action.kind === 'scroll' && !('target' in action)) return null;
  return action.target;
}

/**
 * Resolve an action's target, escalating the node budget ONCE when the target
 * is missing from a TRUNCATED view.
 *
 * Same blind spot as an assertion, opposite direction: "the target is not in
 * the returned nodes" does not mean the target is not on the page — it can
 * simply have fallen outside the budget (live evidence: after a scroll, the
 * scroll target was absent from the 60-node view and present at 100). Without
 * this, a scenario fails with a misleading "no observable node matches" and a
 * human has to raise max_nodes by hand.
 */
async function resolveActionWithBudget(
  action: QaScenarioAction,
  observation: QaObservation,
  reobserve: QaReobserve,
): Promise<{ resolved: QaAction; observation: QaObservation }> {
  const target = targetOf(action);
  let view = observation;
  let escalated = false;
  const missing = (candidate: QaObservation): boolean =>
    target !== null && !candidate.nodes.some((node) => matchesNode(node, target));
  if (missing(view) && view.truncated) {
    try {
      view = await reobserve({ maxNodes: QA_ESCALATED_NODE_BUDGET });
      escalated = true;
    } catch {
      // No fuller view: fall through and report honestly against the truncated one.
    }
  }
  if (missing(view)) {
    if (view.truncated) {
      // Same honesty rule as the completeness block: name the budget the
      // driver APPLIED (its own clamp), never the requested constant.
      const applied = escalated
        ? view.maxNodes === undefined
          ? 'the escalated budget (the driver did not report the budget it applied)'
          : 'the applied ' + String(view.maxNodes) + '-node escalated budget'
        : 'the driver-default budget';
      throw new Error(
        'no observable node matches the action target, and the view was still truncated at '
        + applied + ' (' + QA_INCONCLUSIVE_TRUNCATED
        + '): the target may exist outside the returned window rather than be missing from the page',
      );
    }
    throw new Error('no observable node matches the action target');
  }
  return { resolved: resolveAction(action, view), observation: view };
}

function resolveAction(action: QaScenarioAction, observation: QaObservation): QaAction {
  if (action.kind === 'navigate') return { kind: 'navigate', url: action.url };
  if (action.kind === 'click') return { kind: 'click', ref: resolveRef(action.target, observation) };
  if (action.kind === 'fill') {
    return { kind: 'fill', ref: resolveRef(action.target, observation), text: action.text };
  }
  if (action.kind === 'press') {
    return { kind: 'press', ref: resolveRef(action.target, observation), key: action.key };
  }
  if (action.kind === 'scroll') {
    if ('target' in action) return { kind: 'scroll', ref: resolveRef(action.target, observation) };
    return {
      kind: 'scroll',
      direction: action.direction,
      ...(action.amount === undefined ? {} : { amount: action.amount }),
    };
  }
  if (action.kind === 'select') {
    return { kind: 'select', ref: resolveRef(action.target, observation), option: action.option };
  }
  return { kind: 'hover', ref: resolveRef(action.target, observation) };
}

interface StepBase {
  index: number;
  intent: string;
  action: QaScenarioAction;
}

function buildStepResult(
  base: StepBase,
  assertion: QaScenario['steps'][number]['assert'],
  receipt: QaActionReceipt | null,
  outcome: 'ok' | 'unknown' | 'failed',
  assertionPassed: boolean,
  observed: unknown,
  completeness: QaViewCompleteness | null = null,
  reason?: string,
  attempts?: number,
  elapsedMs?: number,
): QaStepResult {
  return {
    index: base.index,
    intent: base.intent,
    status: assertionPassed ? 'pass' : 'fail',
    action: base.action,
    receipt,
    outcome,
    assertion,
    assertionPassed,
    observed,
    expected: assertion.expected,
    ...(completeness === null ? {} : { completeness }),
    ...(reason === undefined ? {} : { reason }),
    ...(attempts === undefined || attempts <= 1 ? {} : { attempts, elapsedMs: elapsedMs ?? 0 }),
  };
}

/**
 * Failure message for a decided assertion. An outcome that could not be proven
 * from an incomplete view is NEVER reported as an ordinary "failed": it names
 * QA_INCONCLUSIVE_TRUNCATED and the budget, so a human triaging the report can
 * tell "not present" from "we could not see the whole page".
 */
function assertionFailureMessage(what: string, decision: QaAssertionDecision): string {
  const completeness = decision.completeness;
  if (completeness?.reason === QA_INCONCLUSIVE_TRUNCATED) {
    return what + ' is ' + QA_INCONCLUSIVE_TRUNCATED + ': ' + completeness.detail;
  }
  if (decision.reason !== undefined) {
    return what + ' failed (' + decision.reason + ')';
  }
  return what + ' failed';
}

function toReproduction(steps: QaStepResult[]): QaReproductionStep[] {
  return steps.map((s) => ({
    index: s.index,
    intent: s.intent,
    action: s.action,
    observed: s.observed,
    expected: s.expected,
    receipt: s.receipt,
  }));
}

/**
 * Deterministic receipt census over the steps that dispatched an action. A
 * step whose action failed to resolve (receipt null) is not an action dispatch
 * and is not counted. `failed` is a distinct driver status from `rejected` and
 * is counted separately so neither is silently dropped.
 */
function summarizeReceipts(steps: QaStepResult[]): QaReceiptSummary {
  const summary: QaReceiptSummary = { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 };
  for (const step of steps) {
    const receipt = step.receipt;
    if (receipt === null) continue;
    summary.total += 1;
    if (receipt.status === 'confirmed') summary.confirmed += 1;
    else if (receipt.status === 'unknown') summary.unknown += 1;
    else if (receipt.status === 'rejected') summary.rejected += 1;
    else summary.failed += 1;
  }
  if (summary.confirmed === 0 && summary.total > 0) {
    summary.warning = QA_NO_CONFIRMED_RECEIPTS_WARNING;
  }
  return summary;
}
function blockedReport(scenario: QaScenario, startedAt: string, message: string): QaRunReport {
  return {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    status: 'blocked',
    startedAt,
    finishedAt: new Date().toISOString(),
    steps: [],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 },
    failure: { stepIndex: null, message, reproduction: [] },
  };
}

function advisoryUnclear(question: string, reasoning: string, reason: string, description?: string): QaAdvisoryResult {
  return {
    kind: 'visual',
    question,
    verdict: 'unclear',
    confidence: 0,
    reasoning,
    reasoningTrust: QA_ADVISORY_REASONING_TRUST,
    reason,
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Execute advisory visual assertions against the final state. This never
 * throws and never changes the run status: capture failures and an absent
 * vision model degrade each finding to 'unclear' with a stable reason.
 */
async function executeAdvisory(
  scenario: QaScenario,
  session: QaSession,
  services: QaVisualServices | undefined,
  capturesDir: string,
): Promise<{ artifacts: QaArtifact[]; advisory: QaAdvisoryResult[] }> {
  const advisory = scenario.advisory ?? [];
  const artifacts: QaArtifact[] = [];
  const results: QaAdvisoryResult[] = [];
  if (advisory.length === 0) return { artifacts, advisory: results };

  let capture: QaVisualCapture;
  let captureSettle: { stable: boolean; passes: number; budgetMs: number } | null;
  try {
    const latest = await captureLatestVisual(session);
    capture = latest.capture;
    captureSettle = latest.settle;
  } catch (error) {
    for (const assertion of advisory) {
      results.push(advisoryUnclear(assertion.question, errorMessage(error), 'visual-capture-failed', assertion.description));
    }
    return { artifacts, advisory: results };
  }

  let artifactPath: string;
  try {
    artifactPath = await persistCaptureFile(capture, capturesDir);
  } catch (error) {
    for (const assertion of advisory) {
      results.push(advisoryUnclear(assertion.question, errorMessage(error), 'visual-capture-failed', assertion.description));
    }
    return { artifacts, advisory: results };
  }
  const artifact: QaArtifact = { path: artifactPath, kind: 'screenshot' };
  artifacts.push(artifact);

  for (const assertion of advisory) {
    const finding = await evaluateVisualQuestion(assertion.question, capture, services);
    results.push({
      kind: 'visual',
      question: assertion.question,
      verdict: finding.verdict,
      confidence: finding.confidence,
      reasoning: finding.reasoning,
      reasoningTrust: QA_ADVISORY_REASONING_TRUST,
      ...(finding.reason === undefined ? {} : { reason: finding.reason }),
      ...(assertion.description === undefined ? {} : { description: assertion.description }),
      // The capture's settle window travels beside the advisory verdict
      // (additive, excluded from determinism by schema): stable === false means
      // the view never stopped changing, so the advisory verdict is over an
      // unstable view and is marked as such in report.md / report.json.
      ...(captureSettle === null ? {} : {
        settle: captureSettle,
        ...(captureSettle.stable ? {} : { captureSettled: false as const }),
      }),
      artifact,
    });
  }
  return { artifacts, advisory: results };
}

// Executes a scenario step by step through the QA session core. An "unknown"
// receipt is NEVER a pass: only the fresh SETTLED re-observation decides (the
// same bounded settle policy Explore proved the scenario with). On failure,
// evidence plus reproduction steps (index, action, observed vs expected) are
// captured. The driver is always stopped, even when a step fails.
export async function runScenario(
  scenario: QaScenario,
  adapter: QaDriverAdapter,
  options: ReplayRunOptions = {},
): Promise<QaRunReport> {
  if (adapter.kind !== scenario.meta.driver) {
    throw new Error(
      'scenario driver (' + scenario.meta.driver + ') does not match adapter driver (' + adapter.kind + ')',
    );
  }
  const ownerId = options.ownerId ?? 'dsh-qa-replay';
  const launch = options.launchUrl ?? scenario.target.launch;
  const startedAt = new Date().toISOString();

  // The scenario's recorded meta.settle (the exact policy Explore used) wins
  // over the env/host defaults the tool layer passed in options.settle; a
  // scenario without meta.settle keeps the env/host defaults.
  const session = new QaSession(adapter, ownerId, {
    settle: { ...(options.settle ?? {}), ...(scenario.meta.settle ?? {}) },
  });
  // The report prints the FINAL effective policy (reflecting a widening) plus a
  // widening record (where it happened), so neither is captured up front.
  const stepResults: QaStepResult[] = [];
  const assertionResults: QaAssertionResult[] = [];
  const artifacts: QaArtifact[] = [];
  const advisoryResults: QaAdvisoryResult[] = [];
  let evidence: QaEvidence | QaEvidenceCollectionFailure | null = null;
  let failure: QaRunFailure | null = null;
  let settleWidened: QaSettleWidening | null = null;

  try {
    await session.start({
      url: launch,
      ...(options.headless === undefined ? {} : { headless: options.headless }),
      ...(scenario.target.loginState === undefined ? {} : { loginState: scenario.target.loginState }),
    });
  } catch (error) {
    await session.stop().catch(() => {});
    return blockedReport(scenario, startedAt, 'failed to start driver: ' + errorMessage(error));
  }

  // One bounded budget escalation per decision, taken the same SETTLED way as
  // every other verification observation (an unsettled escalated view is
  // refused, so the decision falls back and fails closed).
  const reobserve = sessionReobserve(session);

  try {
    // Symmetry with export: every verification observation is SETTLED, and an
    // unstable view is a failure, never a silent pass.
    const initial = await session.observeSettled();
    if (settleWidened === null && initial.widened !== null) {
      settleWidened = { ...initial.widened, at: 'initial' };
    }
    let current = initial.observation;
    if (!initial.stable) {
      failure = {
        stepIndex: null,
        message: unsettledMessage('initial', initial.budgetMs),
        code: QA_INCONCLUSIVE_UNSTABLE,
        reproduction: [],
      };
    }

    for (const step of scenario.steps) {
      // Fail closed: an unsettled view before the first step proves nothing.
      if (failure !== null) break;
      const base: StepBase = { index: step.index, intent: step.intent, action: step.action };

      let resolved: QaAction;
      try {
        const resolution = await resolveActionWithBudget(step.action, current, reobserve);
        resolved = resolution.resolved;
        current = resolution.observation;
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, null, 'failed', false, null));
        const code = failureCodeFor(error);
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          ...(code === undefined ? {} : { code }),
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      let result: QaActResult;
      try {
        result = await session.act(resolved);
      } catch (error) {
        stepResults.push(buildStepResult(base, step.assert, null, 'failed', false, null));
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
          reproduction: toReproduction(stepResults),
        };
        break;
      }
      if (settleWidened === null && result.settle !== null && result.settle.widened !== null) {
        settleWidened = { ...result.settle.widened, at: step.index };
      }

      if (result.outcome === 'failed' || result.observation === null) {
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        failure = {
          stepIndex: step.index,
          message:
            'action receipt ' +
            result.receipt.status +
            (result.receipt.code !== undefined ? ' (' + result.receipt.code + ')' : ''),
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      if (result.settle !== null && !result.settle.stable) {
        // The post-action view kept changing: nothing observed in it can be
        // attributed to this action, so the step fails honestly.
        stepResults.push(buildStepResult(base, step.assert, result.receipt, result.outcome, false, null));
        failure = {
          stepIndex: step.index,
          message: unsettledMessage('post-action', result.settle.budgetMs),
          code: QA_INCONCLUSIVE_UNSTABLE,
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      // confirmed OR unknown receipt: only the fresh SETTLED re-observation
      // decides — and never a TRUNCATED one when the outcome depends on having
      // seen the whole view (see decideAssertion). A positive-existence "not
      // found" is retried within the settle budget (see decideAssertionWithRetry)
      // so a slow page's late node/role is not mistaken for absence.
      const decision = await decideAssertionWithRetry(step.assert, result.observation, reobserve, session);
      if (settleWidened === null && decision.widened !== null) {
        settleWidened = { ...decision.widened, at: step.index };
      }
      stepResults.push(
        buildStepResult(
          base,
          step.assert,
          result.receipt,
          result.outcome,
          decision.passed,
          decision.observed,
          decision.completeness,
          decision.reason,
          decision.attempts,
          decision.elapsedMs,
        ),
      );
      current = decision.observation;
      if (!decision.passed) {
        failure = {
          stepIndex: step.index,
          message: assertionFailureMessage('assertion ' + step.assert.kind, decision),
          reproduction: toReproduction(stepResults),
        };
        break;
      }
    }

    if (failure === null) {
      const finalSettle = await session.observeSettled();
      if (settleWidened === null && finalSettle.widened !== null) {
        settleWidened = { ...finalSettle.widened, at: 'final' };
      }
      // Reassigned when a decision escalated the node budget: the remaining
      // final assertions are then judged against that fuller view instead of
      // paying for the same escalation again.
      let finalObservation = finalSettle.observation;
      if (!finalSettle.stable) {
        failure = {
          stepIndex: null,
          message: unsettledMessage('final', finalSettle.budgetMs),
          code: QA_INCONCLUSIVE_UNSTABLE,
          reproduction: toReproduction(stepResults),
        };
      }
      for (let i = 0; failure === null && i < scenario.assertions.length; i += 1) {
        const assertion = scenario.assertions[i];
        if (assertion === undefined) continue;
        const decision = await decideAssertionWithRetry(assertion, finalObservation, reobserve, session);
        if (settleWidened === null && decision.widened !== null) {
          settleWidened = { ...decision.widened, at: 'final' };
        }
        assertionResults.push({
          kind: assertion.kind,
          ...(assertion.description === undefined ? {} : { description: assertion.description }),
          passed: decision.passed,
          expected: assertion.expected,
          observed: decision.observed,
          ...(decision.completeness === null ? {} : { completeness: decision.completeness }),
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          ...(decision.attempts <= 1 ? {} : { attempts: decision.attempts, elapsedMs: decision.elapsedMs }),
        });
        finalObservation = decision.observation;
        if (!decision.passed) {
          failure = {
            stepIndex: null,
            message: assertionFailureMessage('final assertion ' + (i + 1) + ' (' + assertion.kind + ')', decision),
            reproduction: toReproduction(stepResults),
          };
          break;
        }
      }
    }

    try {
      evidence = await session.evidence();
    } catch (error) {
      // A failed evidence collection must be a visible, redacted marker — never
      // a silent null a reader mistakes for "no evidence was collected".
      evidence = { status: 'collection-failed', reason: errorMessage(error) };
    }

    // Advisory visual assertions: executed and recorded, never changing status.
    try {
      const outcome = await executeAdvisory(
        scenario,
        session,
        options.visual,
        options.visual?.capturesDir ?? join(tmpdir(), 'dsh-qa-visual-captures'),
      );
      artifacts.push(...outcome.artifacts);
      advisoryResults.push(...outcome.advisory);
    } catch {
      // Advisory execution must never fail the run.
    }
  } catch (error) {
    // An unexpected error mid-run (not a step failure) still fails the run.
    failure = {
      stepIndex: null,
      message: errorMessage(error),
      reproduction: toReproduction(stepResults),
    };
  } finally {
    await session.stop().catch(() => {});
  }

  const report: QaRunReport = {
    schemaVersion: 1,
    scenario: scenario.meta.name,
    driver: scenario.meta.driver,
    status: failure === null ? 'pass' : 'fail',
    startedAt,
    finishedAt: new Date().toISOString(),
    settle: session.settlePolicy,
    steps: stepResults,
    assertions: assertionResults,
    evidence,
    receiptSummary: summarizeReceipts(stepResults),
    ...(settleWidened === null ? {} : { settleWidened }),
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(advisoryResults.length === 0 ? {} : { advisory: advisoryResults }),
  };
  if (failure !== null) {
    report.failure = failure;
  }
  return report;
}