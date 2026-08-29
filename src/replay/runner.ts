import type {
  QaAssertionResult,
  QaNodePredicate,
  QaReproductionStep,
  QaRunFailure,
  QaRunReport,
  QaScenario,
  QaScenarioAction,
  QaStepResult,
} from '../contracts.ts';
import type { QaAction, QaActionReceipt, QaDriverAdapter, QaEvidence, QaObservation } from '../session/adapter.ts';
import { QaSession, type QaActResult } from '../session/session.ts';
import { evaluateAssertion, matchesNode } from './assertions.ts';

export interface ReplayRunOptions {
  ownerId?: string;
  headless?: boolean;
  /** Override target.launch (e.g. a dynamically bound fixture port). */
  launchUrl?: string;
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
  return { kind: 'press', ref: resolveRef(action.target, observation), key: action.key };
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

// Executes a scenario step by step through the QA session core. An "unknown"
// receipt is NEVER a pass: only the fresh re-observation decides. On failure,
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

  const session = new QaSession(adapter, ownerId);
  const stepResults: QaStepResult[] = [];
  const assertionResults: QaAssertionResult[] = [];
  let evidence: QaEvidence | null = null;
  let failure: QaRunFailure | null = null;

  try {
    await session.start({
      url: launch,
      ...(options.headless === undefined ? {} : { headless: options.headless }),
    });
  } catch (error) {
    await session.stop().catch(() => {});
    return blockedReport(scenario, startedAt, 'failed to start driver: ' + errorMessage(error));
  }

  try {
    let current = await session.observe();

    for (const step of scenario.steps) {
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

      // confirmed OR unknown receipt: only the fresh re-observation decides.
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
      const finalObservation = await session.observe();
      for (let i = 0; i < scenario.assertions.length; i += 1) {
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
  };
  if (failure !== null) {
    report.failure = failure;
  }
  return report;
}
