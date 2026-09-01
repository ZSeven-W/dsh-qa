import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_ADVISORY_REASONING_TRUST, QA_INCONCLUSIVE_TRUNCATED } from '../contracts.ts';
import type {
  QaAdvisoryResult,
  QaArtifact,
  QaAssertionResult,
  QaNodePredicate,
  QaReproductionStep,
  QaRunFailure,
  QaRunReport,
  QaScenario,
  QaScenarioAction,
  QaStepResult,
  QaViewCompleteness,
} from '../contracts.ts';
import type { QaAction, QaActionReceipt, QaDriverAdapter, QaEvidence, QaObservation, QaVisualCapture } from '../session/adapter.ts';
import { captureLatestVisual, QaSession, type QaActResult } from '../session/session.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import { evaluateVisualQuestion, persistCaptureFile, type QaVisualServices } from '../vision.ts';
import {
  decideAssertion,
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

function resolveRef(target: QaNodePredicate, observation: QaObservation): string {
  const node = observation.nodes.find((n) => matchesNode(n, target));
  if (node === undefined) {
    throw new Error('no observable node matches the action target');
  }
  return node.ref;
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
      throw new Error(
        'no observable node matches the action target, and the view was still truncated at the '
        + (escalated ? String(QA_ESCALATED_NODE_BUDGET) + '-node escalated' : 'driver-default')
        + ' budget (' + QA_INCONCLUSIVE_TRUNCATED
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
  try {
    capture = await captureLatestVisual(session);
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

  const session = new QaSession(adapter, ownerId, {
    ...(options.settle === undefined ? {} : { settle: options.settle }),
  });
  const stepResults: QaStepResult[] = [];
  const assertionResults: QaAssertionResult[] = [];
  const artifacts: QaArtifact[] = [];
  const advisoryResults: QaAdvisoryResult[] = [];
  let evidence: QaEvidence | null = null;
  let failure: QaRunFailure | null = null;

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
    let current = initial.observation;
    if (!initial.stable) {
      failure = { stepIndex: null, message: unsettledMessage('initial', initial.budgetMs), reproduction: [] };
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
        failure = {
          stepIndex: step.index,
          message: errorMessage(error),
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
          reproduction: toReproduction(stepResults),
        };
        break;
      }

      // confirmed OR unknown receipt: only the fresh SETTLED re-observation
      // decides — and never a TRUNCATED one when the outcome depends on having
      // seen the whole view (see decideAssertion).
      const decision = await decideAssertion(step.assert, result.observation, reobserve);
      stepResults.push(
        buildStepResult(
          base,
          step.assert,
          result.receipt,
          result.outcome,
          decision.passed,
          decision.observed,
          decision.completeness,
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
      // Reassigned when a decision escalated the node budget: the remaining
      // final assertions are then judged against that fuller view instead of
      // paying for the same escalation again.
      let finalObservation = finalSettle.observation;
      if (!finalSettle.stable) {
        failure = {
          stepIndex: null,
          message: unsettledMessage('final', finalSettle.budgetMs),
          reproduction: toReproduction(stepResults),
        };
      }
      for (let i = 0; failure === null && i < scenario.assertions.length; i += 1) {
        const assertion = scenario.assertions[i];
        if (assertion === undefined) continue;
        const decision = await decideAssertion(assertion, finalObservation, reobserve);
        assertionResults.push({
          kind: assertion.kind,
          ...(assertion.description === undefined ? {} : { description: assertion.description }),
          passed: decision.passed,
          expected: assertion.expected,
          observed: decision.observed,
          ...(decision.completeness === null ? {} : { completeness: decision.completeness }),
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
    } catch {
      evidence = null;
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
    steps: stepResults,
    assertions: assertionResults,
    evidence,
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(advisoryResults.length === 0 ? {} : { advisory: advisoryResults }),
  };
  if (failure !== null) {
    report.failure = failure;
  }
  return report;
}
