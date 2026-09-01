import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QA_ADVISORY_REASONING_TRUST } from '../contracts.ts';
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
} from '../contracts.ts';
import type { QaAction, QaActionReceipt, QaDriverAdapter, QaEvidence, QaObservation, QaVisualCapture } from '../session/adapter.ts';
import { captureLatestVisual, QaSession, type QaActResult } from '../session/session.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import { evaluateVisualQuestion, persistCaptureFile, type QaVisualServices } from '../vision.ts';
import { evaluateAssertion, matchesNode } from './assertions.ts';

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
  };
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
        resolved = resolveAction(step.action, current);
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

      // confirmed OR unknown receipt: only the fresh SETTLED re-observation decides.
      const evaluation = evaluateAssertion(step.assert, result.observation);
      stepResults.push(
        buildStepResult(base, step.assert, result.receipt, result.outcome, evaluation.passed, evaluation.observed),
      );
      current = result.observation;
      if (!evaluation.passed) {
        failure = {
          stepIndex: step.index,
          message: 'assertion ' + step.assert.kind + ' failed',
          reproduction: toReproduction(stepResults),
        };
        break;
      }
    }

    if (failure === null) {
      const finalSettle = await session.observeSettled();
      const finalObservation = finalSettle.observation;
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
        const evaluation = evaluateAssertion(assertion, finalObservation);
        assertionResults.push({
          kind: assertion.kind,
          ...(assertion.description === undefined ? {} : { description: assertion.description }),
          passed: evaluation.passed,
          expected: assertion.expected,
          observed: evaluation.observed,
        });
        if (!evaluation.passed) {
          failure = {
            stepIndex: null,
            message: 'final assertion ' + (i + 1) + ' (' + assertion.kind + ') failed',
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
