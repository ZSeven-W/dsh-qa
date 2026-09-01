import { lstat, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  QaAssertion,
  QaNodePredicate,
  QaScenario,
  QaScenarioAction,
  QaStep,
} from '../contracts.ts';
import { projectArtifactPath, redactText } from '../redaction/index.ts';
import { evaluateAssertion, loadScenarioFromPath, validateScenario } from '../replay/index.ts';
import type { QaObservation, QaSemanticNode } from '../session/adapter.ts';
import type { QaTrajectoryRecorder } from './recorder.ts';
import type {
  QaExportExclusion,
  QaRecordedAction,
  QaRecordExportOptions,
  QaRecordExportResult,
  QaTrajectorySnapshot,
} from './types.ts';

interface DurableAction {
  action: QaScenarioAction;
  /** Semantic target predicate for ref-based actions; null for navigate and direction-scroll. */
  target: QaNodePredicate | null;
}

const OUTCOME_ROLE_PRIORITY = new Map<string, number>([
  ['alert', 0],
  ['status', 1],
  ['dialog', 2],
  ['heading', 3],
]);

function clean(value: string): string {
  return value.trim();
}

function containsRedactionMarker(value: string): boolean {
  return value.includes('[REDACTED');
}

function predicateFor(node: QaSemanticNode): QaNodePredicate | null {
  const role = clean(node.role);
  const name = clean(node.name);
  if (role === '' || name === '') return null;
  if (containsRedactionMarker(role) || containsRedactionMarker(name)) return null;
  return { role, name };
}

function matchesPredicate(node: QaSemanticNode, predicate: QaNodePredicate): boolean {
  return (predicate.role === undefined || node.role === predicate.role)
    && (predicate.name === undefined || node.name === predicate.name)
    && (predicate.tag === undefined || node.tag === predicate.tag);
}

function countMatches(observation: QaObservation, predicate: QaNodePredicate): number {
  return observation.nodes.filter((node) => matchesPredicate(node, predicate)).length;
}

function predicateName(predicate: QaNodePredicate): string {
  return predicate.name ?? predicate.role ?? predicate.tag ?? 'semantic target';
}

/** True when the node went from off-viewport (or absent) in `before` to in-viewport in `after`. */
function isRevealed(before: QaObservation, after: QaObservation, predicate: QaNodePredicate): boolean {
  const beforeNode = before.nodes.find((node) => matchesPredicate(node, predicate));
  const afterNode = after.nodes.find((node) => matchesPredicate(node, predicate));
  return afterNode !== undefined && afterNode.inViewport === true
    && (beforeNode === undefined || beforeNode.inViewport !== true);
}

/**
 * First durable (role+name unique) predicate whose node the scroll moved into
 * the viewport. Prefers nodes that were already present off-viewport (a
 * scroll reveals them by moving the viewport, not by creating them).
 */
function firstRevealedPredicate(before: QaObservation, after: QaObservation): QaNodePredicate | null {
  const present = after.nodes
    .filter((node) => node.inViewport === true)
    .map((node) => ({ node, predicate: predicateFor(node) }))
    .filter((item): item is { node: QaSemanticNode; predicate: QaNodePredicate } => (
      item.predicate !== null && countMatches(after, item.predicate) === 1
    ))
    .filter((item) => {
      const beforeNode = before.nodes.find((node) => matchesPredicate(node, item.predicate));
      return beforeNode !== undefined && beforeNode.inViewport !== true;
    });
  return present[0]?.predicate ?? null;
}

function exclusion(
  recorded: QaRecordedAction,
  reason: QaExportExclusion['reason'],
  detail: string,
): QaExportExclusion {
  return {
    actionId: recorded.actionId,
    reason,
    detail: redactText(detail),
    receipt: recorded.receipt,
  };
}

function durableAction(
  recorded: QaRecordedAction,
  before: QaObservation | null,
): DurableAction | QaExportExclusion {
  const action = recorded.action;
  if (action.kind === 'navigate') {
    return { action: { kind: 'navigate', url: action.url }, target: null };
  }
  if (action.kind === 'focus' || action.kind === 'type' || action.kind === 'key') {
    return exclusion(
      recorded,
      'UNSUPPORTED_REPLAY_ACTION',
      'Replay v0.1 has no scenario action for ' + action.kind + '; the step was not exported.',
    );
  }
  if (action.kind === 'scroll' && !('ref' in action)) {
    // Viewport direction-scroll: inherently positional. buildScenario resolves
    // it against the following proven action's target (or excludes it when no
    // in-viewport transition is observable).
    return {
      action: {
        kind: 'scroll',
        direction: action.direction,
        ...(action.amount === undefined ? {} : { amount: action.amount }),
      },
      target: null,
    };
  }
  if (before === null) {
    return exclusion(recorded, 'TARGET_OBSERVATION_MISSING', 'No observation preceded this action.');
  }
  const node = before.nodes.find((candidate) => candidate.ref === action.ref);
  if (node === undefined) {
    return exclusion(recorded, 'TARGET_REF_NOT_FOUND', 'The action ref was not present in its preceding observation.');
  }
  const target = predicateFor(node);
  if (target === null) {
    return exclusion(
      recorded,
      'TARGET_HAS_NO_ACCESSIBLE_NAME',
      'Replay export requires a non-empty, unredacted role plus accessible name.',
    );
  }
  if (countMatches(before, target) !== 1) {
    return exclusion(
      recorded,
      'TARGET_NOT_UNIQUE',
      'Role plus accessible name did not uniquely identify the action target.',
    );
  }
  if (action.kind === 'click') return { action: { kind: 'click', target }, target };
  if (action.kind === 'fill') {
    if (clean(action.text) === '') {
      return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay fill text must be non-empty.');
    }
    return { action: { kind: 'fill', target, text: action.text }, target };
  }
  if (action.kind === 'select') {
    if (clean(action.option) === '') {
      return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay select option must be non-empty.');
    }
    return { action: { kind: 'select', target, option: action.option }, target };
  }
  if (action.kind === 'hover') {
    return { action: { kind: 'hover', target }, target };
  }
  if (action.kind === 'scroll') {
    return { action: { kind: 'scroll', target }, target };
  }
  if (clean(action.key) === '') {
    return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay press key must be non-empty.');
  }
  return { action: { kind: 'press', target, key: action.key }, target };
}

/**
 * How far (in document-ordered semantic nodes) a delta may sit from the action
 * target and still count as target-proximate evidence. A delta on the target
 * itself, in its subtree, or among the handful of nodes rendered next to it is
 * strong evidence that the action caused it; a delta on the far side of the
 * page is weak (late hydration renaming an unrelated element looks exactly
 * like that). Weak evidence is ranked BELOW strong evidence but never dropped
 * — dropping it would silently lose provable steps.
 */
const PROXIMATE_NODE_DISTANCE = 6;

/** Proximity of a candidate delta to the action target. */
type DeltaProximity = 'target-proximate' | 'distant' | 'not-applicable';

interface SemanticDelta {
  predicate: QaNodePredicate;
  proximity: DeltaProximity;
  /** Human-facing name of the delta, used when recording weak proof. */
  name: string;
}

/** Document-order index of the action target, preferring the post-action view. */
function targetAnchor(
  before: QaObservation | null,
  after: QaObservation,
  target: QaNodePredicate | null,
): number | null {
  if (target === null) return null;
  const afterIndex = after.nodes.findIndex((node) => matchesPredicate(node, target));
  if (afterIndex >= 0) return afterIndex;
  if (before === null) return null;
  const beforeIndex = before.nodes.findIndex((node) => matchesPredicate(node, target));
  return beforeIndex >= 0 ? beforeIndex : null;
}

function semanticDelta(
  before: QaObservation | null,
  after: QaObservation,
  target: QaNodePredicate | null,
): SemanticDelta | null {
  if (before === null) return null;
  const anchor = targetAnchor(before, after, target);
  const candidates = after.nodes
    .map((node, order) => ({ node, order, predicate: predicateFor(node) }))
    .filter((item): item is { node: QaSemanticNode; order: number; predicate: QaNodePredicate } => (
      item.predicate !== null
      && countMatches(after, item.predicate) === 1
      && countMatches(before, item.predicate) === 0
    ))
    .map((item) => ({
      ...item,
      proximity: (anchor === null
        ? 'not-applicable'
        : Math.abs(item.order - anchor) <= PROXIMATE_NODE_DISTANCE ? 'target-proximate' : 'distant') as DeltaProximity,
    }));
  candidates.sort((left, right) => {
    // 1. evidence on/near the action target beats evidence anywhere else;
    // 2. then the outcome-announcing roles; 3. then document order.
    const leftProximity = left.proximity === 'distant' ? 1 : 0;
    const rightProximity = right.proximity === 'distant' ? 1 : 0;
    const leftPriority = OUTCOME_ROLE_PRIORITY.get(left.node.role) ?? 10;
    const rightPriority = OUTCOME_ROLE_PRIORITY.get(right.node.role) ?? 10;
    return leftProximity - rightProximity || leftPriority - rightPriority || left.order - right.order;
  });
  const best = candidates[0];
  if (best === undefined) return null;
  return { predicate: best.predicate, proximity: best.proximity, name: predicateName(best.predicate) };
}

interface SynthesizedAssertion {
  assertion: QaAssertion;
  /** Non-null when the proof is weak, for the human-readable step intent. */
  weakness: string | null;
}

function synthesizeAssertion(
  before: QaObservation | null,
  after: QaObservation,
  target: QaNodePredicate | null,
): SynthesizedAssertion | null {
  if (before !== null && before.page.url !== after.page.url && clean(after.page.url) !== '') {
    return {
      assertion: {
        kind: 'page-url',
        expected: { url: after.page.url },
        description: 'Settled post-action observation reached the recorded URL.',
      },
      weakness: null,
    };
  }
  const delta = semanticDelta(before, after, target);
  if (delta !== null) {
    const distant = delta.proximity === 'distant';
    return {
      assertion: {
        kind: 'node-present',
        expected: delta.predicate,
        description: distant
          ? 'Settled post-action observation exposed a new semantic state, but only away from the action target.'
          : 'Settled post-action observation exposed a new semantic state.',
      },
      weakness: distant
        ? 'the only observable change was away from the action target ("' + delta.name + '")'
        : null,
    };
  }
  // Target persistence is not proof that any action landed, even for a
  // confirmed dispatch receipt. Every exported action needs a semantic delta
  // or URL change from the SETTLED observation above.
  return null;
}

/** Assertion proving a scroll made the target reachable (in-viewport). */
function synthesizeScrollAssertion(target: QaNodePredicate): QaAssertion {
  return {
    kind: 'node-in-viewport',
    expected: target,
    description: 'Settled post-scroll observation placed the target in the viewport.',
  };
}

function intentFor(action: QaScenarioAction): string {
  if (action.kind === 'navigate') return 'Navigate to the recorded URL.';
  if (action.kind === 'scroll') {
    if ('target' in action) return 'Scroll to "' + predicateName(action.target) + '".';
    return 'Scroll the viewport ' + action.direction + (action.amount === undefined ? '.' : ' by ' + String(action.amount) + '.');
  }
  const targetName = action.target.name ?? action.target.role ?? 'semantic target';
  if (action.kind === 'click') return 'Click "' + targetName + '".';
  if (action.kind === 'fill') return 'Fill "' + targetName + '".';
  if (action.kind === 'select') return 'Select option "' + action.option + '" on "' + targetName + '".';
  if (action.kind === 'hover') return 'Hover "' + targetName + '".';
  return 'Press ' + action.key + ' on "' + targetName + '".';
}

interface Candidate {
  recorded: QaRecordedAction;
  before: QaObservation | null;
  after: QaObservation | null;
  exclusion: QaExportExclusion | null;
  /** Durable scenario action; null for excluded and direction-scroll candidates. */
  action: QaScenarioAction | null;
  /** Semantic target predicate for ref-based actions; null otherwise. */
  target: QaNodePredicate | null;
}

interface ResolvedScrollStep {
  intent: string;
  action: QaScenarioAction;
  assert: QaAssertion;
}

/**
 * Resolve a positional scroll-by-direction step against the following proven
 * action's target. A direction-scroll is inherently positional, so the
 * exported scenario prefers the durable scroll-by-target form: it scrolls to
 * the same off-viewport element the exploration actually reached next. When
 * that is not derivable, it keeps the positional direction form but proves it
 * with a node-in-viewport assertion against any node the scroll moved into
 * view, and records the positional nature in the step intent. It never
 * silently drops a scroll: a scroll with no observable in-viewport transition
 * is excluded with an explicit reason.
 */
function resolveDirectionScroll(candidates: Candidate[], index: number): ResolvedScrollStep | null {
  const candidate = candidates[index];
  if (candidate === undefined || candidate.before === null || candidate.after === null || candidate.action === null) {
    return null;
  }
  const { before, after } = candidate;
  const positional = candidate.action as { kind: 'scroll'; direction: 'up' | 'down'; amount?: 'page' | number };
  for (let j = index + 1; j < candidates.length; j += 1) {
    const next = candidates[j];
    if (next === undefined || next.exclusion !== null || next.target === null) continue;
    if (isRevealed(before, after, next.target)) {
      return {
        intent: 'Scroll to "' + predicateName(next.target) + '".',
        action: { kind: 'scroll', target: next.target },
        assert: synthesizeScrollAssertion(next.target),
      };
    }
  }
  const anyRevealed = firstRevealedPredicate(before, after);
  if (anyRevealed !== null) {
    return {
      intent: 'Scroll the viewport ' + positional.direction
        + (positional.amount === undefined ? ' (positional).' : ' by ' + String(positional.amount) + ' (positional)')
        + ' to reveal "' + predicateName(anyRevealed) + '".',
      action: positional,
      assert: synthesizeScrollAssertion(anyRevealed),
    };
  }
  return null;
}

function buildScenario(
  trajectory: QaTrajectorySnapshot,
  options: QaRecordExportOptions,
): { scenario: QaScenario | null; excluded: QaExportExclusion[] } {
  const excluded: QaExportExclusion[] = [];
  const steps: QaStep[] = [];

  // Pass 1: resolve each action into a durable candidate (or an exclusion)
  // without ordering assumptions, so pass 2 can look ahead past a
  // scroll-by-direction step to the following proven action's target.
  const candidates: Candidate[] = [];
  for (const recorded of trajectory.actions) {
    const receipt = recorded.receipt;
    let early: QaExportExclusion | null = null;
    if (recorded.recordingIssue !== null) {
      early = exclusion(recorded, 'OBSERVATION_RECORDING_FAILED', recorded.recordingIssue);
    } else if (receipt === null) {
      early = exclusion(recorded, 'ACTION_RECEIPT_MISSING', 'No action receipt was recorded.');
    } else if (receipt.status === 'rejected') {
      early = exclusion(
        recorded,
        'ACTION_REJECTED',
        'Rejected action was not exported' + (receipt.code === undefined ? '.' : ' (' + receipt.code + ').'),
      );
    } else if (receipt.status === 'failed') {
      early = exclusion(recorded, 'ACTION_FAILED', 'Failed action was not exported.');
    } else if (!receipt.dispatched) {
      early = exclusion(recorded, 'ACTION_NOT_DISPATCHED', 'The driver did not dispatch this action.');
    } else if (recorded.payloadRedacted) {
      early = exclusion(
        recorded,
        'ACTION_PAYLOAD_REDACTED',
        'Redaction changed a replay-relevant action field, so replay would not be faithful.',
      );
    } else if (recorded.afterObservationId === null) {
      early = exclusion(
        recorded,
        'FRESH_OBSERVATION_MISSING',
        'No immediate fresh post-action observation proved the outcome.',
      );
    } else if (recorded.afterObservationStable !== true) {
      // Fail closed: the bounded settle window never reached two consecutive
      // identical semantic views, so nothing in the post-action observation can
      // be attributed to the action. An unstable page is honestly unprovable.
      early = exclusion(
        recorded,
        'ASSERTION_NOT_PROVABLE',
        recorded.afterObservationStable === null
          ? 'No settle window was recorded for the post-action observation, so its view is unproven.'
          : 'The post-action view never stabilized within the settle budget, so no observation proves the outcome.',
      );
    }
    if (early !== null) {
      candidates.push({ recorded, before: null, after: null, exclusion: early, action: null, target: null });
      continue;
    }
    const before = recorded.beforeObservationId === null
      ? null
      : trajectory.observations[recorded.beforeObservationId] ?? null;
    const afterObservationId = recorded.afterObservationId;
    if (afterObservationId === null) {
      // Unreachable after the early FRESH_OBSERVATION_MISSING guard; refuse fail-closed.
      candidates.push({
        recorded,
        before,
        after: null,
        exclusion: exclusion(
          recorded,
          'FRESH_OBSERVATION_MISSING',
          'No immediate fresh post-action observation proved the outcome.',
        ),
        action: null,
        target: null,
      });
      continue;
    }
    const after = trajectory.observations[afterObservationId] ?? null;
    if (after === null) {
      candidates.push({
        recorded,
        before,
        after: null,
        exclusion: exclusion(
          recorded,
          'OBSERVATION_RECORDING_FAILED',
          'The fresh observation reference has no recorded observation payload.',
        ),
        action: null,
        target: null,
      });
      continue;
    }
    const durable = durableAction(recorded, before);
    if ('reason' in durable) {
      candidates.push({ recorded, before, after, exclusion: durable, action: null, target: null });
      continue;
    }
    candidates.push({
      recorded,
      before,
      after,
      exclusion: null,
      action: durable.action,
      target: durable.target,
    });
  }

  // Pass 2: assemble steps in order, resolving scroll-by-direction steps
  // against the following proven action's target.
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    if (candidate.exclusion !== null) {
      excluded.push(candidate.exclusion);
      continue;
    }
    const recorded = candidate.recorded;
    const receipt = recorded.receipt;
    const isDirectionScroll = candidate.action !== null
      && candidate.action.kind === 'scroll'
      && 'direction' in candidate.action;
    if (isDirectionScroll) {
      const resolved = resolveDirectionScroll(candidates, i);
      if (resolved === null) {
        excluded.push(exclusion(
          recorded,
          'ASSERTION_NOT_PROVABLE',
          'Scroll-by-direction had no observable in-viewport transition in the fresh observation.',
        ));
        continue;
      }
      steps.push({ index: steps.length + 1, intent: resolved.intent, action: resolved.action, assert: resolved.assert });
      continue;
    }
    const after = candidate.after;
    if (after === null) {
      // Unreachable for a durable candidate; refuse fail-closed rather than guessing.
      excluded.push(exclusion(
        recorded,
        'OBSERVATION_RECORDING_FAILED',
        'The fresh observation reference has no recorded observation payload.',
      ));
      continue;
    }
    const stepAction = candidate.action;
    if (stepAction === null) {
      // Unreachable for a durable candidate; refuse fail-closed rather than guessing.
      excluded.push(exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'The action had no durable replay form.'));
      continue;
    }
    const synthesized = stepAction.kind === 'scroll' && candidate.target !== null
      ? { assertion: synthesizeScrollAssertion(candidate.target), weakness: null }
      : synthesizeAssertion(candidate.before, after, candidate.target);
    if (synthesized === null || !evaluateAssertion(synthesized.assertion, after).passed) {
      excluded.push(exclusion(
        recorded,
        'ASSERTION_NOT_PROVABLE',
        receipt?.status === 'unknown'
          ? 'Unknown receipt had no semantic state change in the settled observation.'
          : 'The settled observation had no semantic state change or URL change proving the action outcome.',
      ));
      continue;
    }
    // A distant delta is still exported (dropping it would silently lose the
    // step), but the weakness is recorded in the intent so a human can see why
    // the assertion looks unrelated to the action.
    const intent = synthesized.weakness === null
      ? intentFor(stepAction)
      : intentFor(stepAction) + ' Weak proof: ' + synthesized.weakness + ' — verify manually.';
    steps.push({
      index: steps.length + 1,
      intent,
      action: stepAction,
      assert: synthesized.assertion,
    });
  }

  if (steps.length === 0) return { scenario: null, excluded };
  const fallbackName = 'explore-' + trajectory.driver + '-' + trajectory.startedAt.slice(0, 10);
  // Explore visual findings are informational notes, never blocking assertions:
  // only the deterministic question text is surfaced, so the exported scenario
  // replays byte-identically without a vision model available.
  const visualNotes = trajectory.visualFindings.map((finding) => 'visual finding: ' + finding.question);
  const rawScenario: QaScenario = {
    meta: {
      name: redactText(options.name?.trim() || fallbackName),
      description: redactText(
        options.description?.trim()
          || 'Scenario exported from an evidence-backed Explore trajectory.',
      ),
      driver: trajectory.driver,
      createdAt: new Date().toISOString(),
      ...(visualNotes.length === 0 ? {} : { notes: visualNotes }),
    },
    target: { launch: trajectory.launch },
    steps,
    assertions: [steps[steps.length - 1]!.assert],
  };
  // Every free-text field above already came from the recorder's redacted
  // projection (or redactText for generated metadata); operational URLs came
  // through the recorder's stricter component-wise Replay URL projection.
  return { scenario: validateScenario(rawScenario), excluded };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function safeOutputPath(options: QaRecordExportOptions): Promise<{
  actual: string;
  projected: string;
}> {
  if (typeof options.outputPath !== 'string' || options.outputPath.trim() === '') {
    throw new TypeError('qa_record_export output_path must be a non-empty string');
  }
  const requested = resolve(options.outputPath);
  if (!requested.endsWith('.json')) throw new Error('qa_record_export output_path must end in .json');
  const parent = await realpath(dirname(requested));
  const workspace = await realpath(resolve(options.workspaceRoot ?? process.cwd()));
  let temp = await realpath(resolve(options.tempRoot ?? tmpdir()));
  if (temp === workspace) temp = join(workspace, '.dsh-qa-temp-root');
  if (!inside(workspace, parent) && !inside(temp, parent)) {
    throw new Error('qa_record_export output_path must be under the current workspace or temporary directory');
  }
  const actual = join(parent, basename(requested));
  try {
    const existing = await lstat(actual);
    if (existing.isSymbolicLink()) throw new Error('qa_record_export refuses a symbolic-link output file');
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw error;
  }
  const artifacts = join(workspace, '.dsh-qa-artifacts-root');
  const projected = projectArtifactPath(actual, { workspace, temp, artifacts });
  return { actual, projected };
}

export async function exportRecordedScenario(
  recorder: QaTrajectoryRecorder,
  ownerId: string,
  options: QaRecordExportOptions,
): Promise<QaRecordExportResult> {
  const trajectory = recorder.snapshot(ownerId);
  if (trajectory === null) {
    return {
      ok: false,
      code: 'NO_TRAJECTORY',
      error: 'No Explore trajectory exists for this owner; start and explore a session first.',
      excludedActions: [],
    };
  }
  if (trajectory.driver !== 'browser') {
    return {
      ok: false,
      code: 'DRIVER_NOT_REPLAYABLE',
      error: 'Replay v0.1 supports browser scenarios only; the computer trajectory was retained but not exported.',
      excludedActions: [],
    };
  }
  const built = buildScenario(trajectory, options);
  if (built.scenario === null) {
    return {
      ok: false,
      code: 'NO_PROVEN_STEPS',
      error: 'No action had both a durable semantic target and an outcome proven by a fresh observation; no file was written.',
      excludedActions: built.excluded,
    };
  }
  const output = await safeOutputPath(options);
  await writeFile(
    output.actual,
    JSON.stringify(built.scenario, null, 2) + '\n',
    { encoding: 'utf8', flag: options.overwrite === true ? 'w' : 'wx' },
  );
  // Read the exact bytes back through the existing fail-closed loader. Export
  // has no private parser, repair path, or special-case schema.
  const loaded = loadScenarioFromPath(output.actual);
  return {
    ok: true,
    artifact: { path: output.projected, kind: 'scenario' },
    scenario: loaded,
    trajectory: {
      events: trajectory.events.length,
      observations: Object.keys(trajectory.observations).length,
      actions: trajectory.actions.length,
      evidenceReferences: trajectory.evidenceReferences,
    },
    excludedActions: built.excluded,
  };
}
