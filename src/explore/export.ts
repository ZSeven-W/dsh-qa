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

function countMatches(observation: QaObservation, predicate: QaNodePredicate): number {
  return observation.nodes.filter((node) => (
    (predicate.role === undefined || node.role === predicate.role)
    && (predicate.name === undefined || node.name === predicate.name)
    && (predicate.tag === undefined || node.tag === predicate.tag)
  )).length;
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
    return { action: { kind: 'navigate', url: action.url } };
  }
  if (action.kind === 'focus' || action.kind === 'type' || action.kind === 'key') {
    return exclusion(
      recorded,
      'UNSUPPORTED_REPLAY_ACTION',
      'Replay v0.1 has no scenario action for ' + action.kind + '; the step was not exported.',
    );
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
  if (action.kind === 'click') return { action: { kind: 'click', target } };
  if (action.kind === 'fill') {
    if (clean(action.text) === '') {
      return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay fill text must be non-empty.');
    }
    return { action: { kind: 'fill', target, text: action.text } };
  }
  if (clean(action.key) === '') {
    return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay press key must be non-empty.');
  }
  return { action: { kind: 'press', target, key: action.key } };
}

function semanticDelta(before: QaObservation | null, after: QaObservation): QaNodePredicate | null {
  if (before === null) return null;
  const candidates = after.nodes
    .map((node, order) => ({ node, order, predicate: predicateFor(node) }))
    .filter((item): item is { node: QaSemanticNode; order: number; predicate: QaNodePredicate } => (
      item.predicate !== null
      && countMatches(after, item.predicate) === 1
      && countMatches(before, item.predicate) === 0
    ));
  candidates.sort((left, right) => {
    const leftPriority = OUTCOME_ROLE_PRIORITY.get(left.node.role) ?? 10;
    const rightPriority = OUTCOME_ROLE_PRIORITY.get(right.node.role) ?? 10;
    return leftPriority - rightPriority || left.order - right.order;
  });
  return candidates[0]?.predicate ?? null;
}

function synthesizeAssertion(before: QaObservation | null, after: QaObservation): QaAssertion | null {
  if (before !== null && before.page.url !== after.page.url && clean(after.page.url) !== '') {
    return {
      kind: 'page-url',
      expected: { url: after.page.url },
      description: 'Fresh post-action observation reached the recorded URL.',
    };
  }
  const delta = semanticDelta(before, after);
  if (delta !== null) {
    return {
      kind: 'node-present',
      expected: delta,
      description: 'Fresh post-action observation exposed a new semantic state.',
    };
  }
  // Target persistence is not proof that any action landed, even for a
  // confirmed dispatch receipt. Every exported action needs a semantic delta
  // or URL change from the fresh observation above.
  return null;
}

function intentFor(action: QaScenarioAction): string {
  if (action.kind === 'navigate') return 'Navigate to the recorded URL.';
  const targetName = action.target.name ?? action.target.role ?? 'semantic target';
  if (action.kind === 'click') return 'Click "' + targetName + '".';
  if (action.kind === 'fill') return 'Fill "' + targetName + '".';
  return 'Press ' + action.key + ' on "' + targetName + '".';
}

function buildScenario(
  trajectory: QaTrajectorySnapshot,
  options: QaRecordExportOptions,
): { scenario: QaScenario | null; excluded: QaExportExclusion[] } {
  const excluded: QaExportExclusion[] = [];
  const steps: QaStep[] = [];

  for (const recorded of trajectory.actions) {
    const receipt = recorded.receipt;
    if (recorded.recordingIssue !== null) {
      excluded.push(exclusion(recorded, 'OBSERVATION_RECORDING_FAILED', recorded.recordingIssue));
      continue;
    }
    if (receipt === null) {
      excluded.push(exclusion(recorded, 'ACTION_RECEIPT_MISSING', 'No action receipt was recorded.'));
      continue;
    }
    if (receipt.status === 'rejected') {
      excluded.push(exclusion(
        recorded,
        'ACTION_REJECTED',
        'Rejected action was not exported' + (receipt.code === undefined ? '.' : ' (' + receipt.code + ').'),
      ));
      continue;
    }
    if (receipt.status === 'failed') {
      excluded.push(exclusion(recorded, 'ACTION_FAILED', 'Failed action was not exported.'));
      continue;
    }
    if (!receipt.dispatched) {
      excluded.push(exclusion(recorded, 'ACTION_NOT_DISPATCHED', 'The driver did not dispatch this action.'));
      continue;
    }
    if (recorded.payloadRedacted) {
      excluded.push(exclusion(
        recorded,
        'ACTION_PAYLOAD_REDACTED',
        'Redaction changed a replay-relevant action field, so replay would not be faithful.',
      ));
      continue;
    }
    if (recorded.afterObservationId === null) {
      excluded.push(exclusion(
        recorded,
        'FRESH_OBSERVATION_MISSING',
        'No immediate fresh post-action observation proved the outcome.',
      ));
      continue;
    }
    const before = recorded.beforeObservationId === null
      ? null
      : trajectory.observations[recorded.beforeObservationId] ?? null;
    const after = trajectory.observations[recorded.afterObservationId] ?? null;
    if (after === null) {
      excluded.push(exclusion(
        recorded,
        'OBSERVATION_RECORDING_FAILED',
        'The fresh observation reference has no recorded observation payload.',
      ));
      continue;
    }
    const durable = durableAction(recorded, before);
    if ('reason' in durable) {
      excluded.push(durable);
      continue;
    }
    const assertion = synthesizeAssertion(before, after);
    if (assertion === null || !evaluateAssertion(assertion, after).passed) {
      excluded.push(exclusion(
        recorded,
        'ASSERTION_NOT_PROVABLE',
        receipt.status === 'unknown'
          ? 'Unknown receipt had no semantic state change in the fresh observation.'
          : 'The fresh observation had no semantic state change or URL change proving the action outcome.',
      ));
      continue;
    }
    steps.push({
      index: steps.length + 1,
      intent: intentFor(durable.action),
      action: durable.action,
      assert: assertion,
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
