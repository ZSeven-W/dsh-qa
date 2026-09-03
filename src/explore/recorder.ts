import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectRedactedJsonValue, redactText } from '../redaction/index.ts';
import { toVisualCaptureInfo } from '../session/adapter.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import type {
  QaAction,
  QaActionReceipt,
  QaApprovalGate,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObserveOptions,
  QaSessionInfo,
  QaSettleReport,
  QaStartOptions,
  QaStopResult,
  QaVisualCapture,
  QaVisualObserveOptions,
} from '../session/adapter.ts';
import type {
  QaRecordedAction,
  QaTrajectoryEvent,
  QaTrajectorySnapshot,
} from './types.ts';

interface MutableAction extends QaRecordedAction {}

interface MutableTrajectory {
  driver: QaDriverAdapter['kind'];
  startedAt: string;
  launch: string;
  sequence: number;
  nextObservation: number;
  nextAction: number;
  nextEvidence: number;
  salt: Uint8Array;
  refAliases: Map<string, string>;
  nextRef: number;
  events: QaTrajectoryEvent[];
  observations: Map<string, QaObservation>;
  actions: MutableAction[];
  actionById: Map<string, MutableAction>;
  evidenceReferences: string[];
  recordingIssues: string[];
  lastObservationId: string | null;
  pendingActionId: string | null;
  /**
   * The action whose bounded settle window is still open. The FIRST
   * post-receipt observation opens it; every later observation of that window
   * re-binds the action's proof, so the SETTLED (last) observation is what the
   * exporter judges — never the first, racing one.
   */
  settlingActionId: string | null;
  /** The session's RESOLVED settle policy (recorded at start; see noteSettlePolicy). */
  settlePolicy: QaSettlePolicy | null;
}

interface Sanitized<T> {
  value: T;
  changed: boolean;
}

function cloneRedacted<T>(value: T): Sanitized<T> {
  const projected = projectRedactedJsonValue(value);
  return { value: projected as T, changed: !isDeepStrictEqual(value, projected) };
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw);
}

function launchFrom(options: QaStartOptions | undefined, info: QaSessionInfo, kind: QaDriverAdapter['kind']): string {
  if (kind === 'computer') return options?.bundleId ?? info.page.url;
  return options?.url || info.page.url;
}

/**
 * URLs are operational Replay selectors, not report prose. The text engine
 * deliberately replaces every complete URL with [REDACTED_URL], so retaining a
 * usable target needs this narrower fail-closed projection: credentials,
 * query/fragment data, non-http(s) schemes, malformed escapes, or any component
 * the normal redactor would change are rejected rather than stored.
 */
function projectReplayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Replay URL is malformed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Replay URL must use http(s)');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Replay URL must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('Replay URL must not contain a query or fragment');
  }
  const components = [url.hostname, url.port];
  for (const rawSegment of url.pathname.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new Error('Replay URL path contains a malformed escape');
    }
    components.push(decoded);
  }
  for (const component of components) {
    if (redactText(component) !== component) {
      throw new Error('Replay URL contains a component rejected by redaction');
    }
  }
  return url.toString();
}

/**
 * In-memory Explore trajectory recorder. Public capture methods never throw:
 * recording is observational and therefore cannot change driver/session behavior.
 * Every retained payload passes through the fail-closed redaction projection.
 */
export class QaTrajectoryRecorder {
  readonly #trajectories = new Map<string, MutableTrajectory>();

  start(ownerId: string, driver: QaDriverAdapter['kind'], options: QaStartOptions | undefined, info: QaSessionInfo): void {
    try {
      const safeOptions = cloneRedacted(options ?? {}).value;
      const safeInfo = cloneRedacted(info).value;
      const rawLaunch = launchFrom(options, info, driver);
      const safeLaunch = driver === 'browser' ? projectReplayUrl(rawLaunch) : cloneRedacted(rawLaunch).value;
      const trajectory: MutableTrajectory = {
        driver,
        startedAt: new Date().toISOString(),
        launch: safeLaunch,
        sequence: 0,
        nextObservation: 1,
        nextAction: 1,
        nextEvidence: 1,
        salt: randomBytes(32),
        refAliases: new Map(),
        nextRef: 1,
        events: [],
        observations: new Map(),
        actions: [],
        actionById: new Map(),
        evidenceReferences: [],
        recordingIssues: [],
        lastObservationId: null,
        pendingActionId: null,
        settlingActionId: null,
        settlePolicy: null,
      };
      this.#trajectories.set(ownerId, trajectory);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'start',
        driver,
        options: safeOptions,
        info: safeInfo,
      });
    } catch (error) {
      // A start-recording failure never interferes with the successful driver start.
      const issue = 'start recording failed: ' + safeReason(error);
      this.#trajectories.set(ownerId, this.#failedTrajectory(driver, issue));
    }
  }

  action(ownerId: string, action: QaAction): string | null {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return null;
    const actionId = 'action-' + trajectory.nextAction++;
    try {
      const aliased = this.#aliasAction(trajectory, action);
      const safe = action.kind === 'navigate'
        ? { value: aliased, changed: false }
        : cloneRedacted(aliased);
      trajectory.settlingActionId = null;
      const recorded: MutableAction = {
        actionId,
        action: safe.value,
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        afterObservationStable: null,
        payloadRedacted: safe.changed,
        recordingIssue: null,
      };
      trajectory.actions.push(recorded);
      trajectory.actionById.set(actionId, recorded);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'action',
        actionId,
        beforeObservationId: recorded.beforeObservationId,
        action: recorded.action,
        payloadRedacted: recorded.payloadRedacted,
      });
      return actionId;
    } catch (error) {
      const issue = 'action recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      trajectory.settlingActionId = null;
      const recorded: MutableAction = {
        actionId,
        action: { kind: 'navigate', url: 'about:recording-error' },
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        afterObservationStable: null,
        payloadRedacted: true,
        recordingIssue: issue,
      };
      trajectory.actions.push(recorded);
      trajectory.actionById.set(actionId, recorded);
      this.#recordingError(trajectory, 'action', issue, actionId);
      return actionId;
    }
  }

  receipt(ownerId: string, actionId: string | null, receipt: QaActionReceipt): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined || actionId === null) return;
    const action = trajectory.actionById.get(actionId);
    if (action === undefined) return;
    try {
      const safeReceipt = cloneRedacted(receipt).value;
      action.receipt = safeReceipt;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'receipt',
        actionId,
        receipt: safeReceipt,
      });
      trajectory.pendingActionId = safeReceipt.status === 'confirmed' || safeReceipt.status === 'unknown'
        ? actionId
        : null;
    } catch (error) {
      const issue = 'receipt recording failed: ' + safeReason(error);
      action.recordingIssue = issue;
      trajectory.recordingIssues.push(issue);
      trajectory.pendingActionId = null;
      this.#recordingError(trajectory, 'receipt', issue, actionId);
    }
  }

  observation(ownerId: string, observation: QaObservation): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    const observationId = 'observation-' + trajectory.nextObservation++;
    const afterActionId = trajectory.pendingActionId;
    try {
      const aliased = this.#aliasObservation(trajectory, observation);
      const safeObservation = cloneRedacted(aliased).value;
      if (trajectory.driver === 'browser') {
        safeObservation.page.url = projectReplayUrl(aliased.page.url);
      }
      trajectory.observations.set(observationId, safeObservation);
      trajectory.lastObservationId = observationId;
      trajectory.pendingActionId = null;
      if (afterActionId !== null) {
        const action = trajectory.actionById.get(afterActionId);
        if (action !== undefined) action.afterObservationId = observationId;
        // The settle window for this action is now open: later observations in
        // the same window re-bind the proof (see settle()).
        trajectory.settlingActionId = afterActionId;
      } else if (trajectory.settlingActionId !== null) {
        const action = trajectory.actionById.get(trajectory.settlingActionId);
        if (action !== undefined) action.afterObservationId = observationId;
      }
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'observation',
        observationId,
        afterActionId,
        observation: safeObservation,
      });
    } catch (error) {
      const issue = 'observation recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      trajectory.pendingActionId = null;
      if (afterActionId !== null) {
        const action = trajectory.actionById.get(afterActionId);
        if (action !== undefined) action.recordingIssue = issue;
      }
      this.#recordingError(trajectory, 'observation', issue, afterActionId);
    }
  }

  /**
   * Close the bounded settle window the session core just ran. The action's
   * proof is re-bound to the SETTLED observation and the window's stability is
   * recorded, so the exporter can refuse (fail closed) a view that never
   * stabilized instead of exporting an assertion on churn.
   */
  settle(ownerId: string, report: QaSettleReport): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    const actionId = trajectory.settlingActionId;
    trajectory.settlingActionId = null;
    try {
      const safeReport = cloneRedacted(report).value;
      if (actionId !== null) {
        const action = trajectory.actionById.get(actionId);
        if (action !== undefined) {
          if (trajectory.lastObservationId !== null) {
            action.afterObservationId = trajectory.lastObservationId;
          }
          action.afterObservationStable = safeReport.stable;
        }
      }
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'settle',
        actionId,
        observationId: trajectory.lastObservationId,
        stable: safeReport.stable,
        passes: safeReport.passes,
        budgetMs: safeReport.budgetMs,
      });
    } catch (error) {
      const issue = 'settle recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      if (actionId !== null) {
        const action = trajectory.actionById.get(actionId);
        if (action !== undefined) action.recordingIssue = issue;
      }
      this.#recordingError(trajectory, 'settle', issue, actionId);
    }
  }

  /** Passive: persist the session's resolved settle policy for meta.settle export. */
  recordSettlePolicy(ownerId: string, policy: QaSettlePolicy): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    try {
      trajectory.settlePolicy = cloneRedacted(policy).value;
    } catch {
      // Recording cannot alter session behavior; a failed record is a no-op.
    }
  }

  observationFailed(ownerId: string, error: unknown): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    // A failure anywhere inside a settle window invalidates that window's proof.
    const actionId = trajectory.pendingActionId ?? trajectory.settlingActionId;
    const issue = 'fresh observation failed: ' + safeReason(error);
    trajectory.recordingIssues.push(issue);
    trajectory.pendingActionId = null;
    trajectory.settlingActionId = null;
    if (actionId !== null) {
      const action = trajectory.actionById.get(actionId);
      if (action !== undefined) action.recordingIssue = issue;
    }
    this.#recordingError(trajectory, 'observation', issue, actionId);
  }

  actionFailed(ownerId: string, actionId: string | null, error: unknown): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    const issue = 'driver action threw: ' + safeReason(error);
    trajectory.recordingIssues.push(issue);
    if (actionId !== null) {
      const action = trajectory.actionById.get(actionId);
      if (action !== undefined) action.recordingIssue = issue;
    }
    this.#recordingError(trajectory, 'action', issue, actionId);
  }

  evidence(ownerId: string, evidence: QaEvidence): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    const evidenceId = 'evidence-' + trajectory.nextEvidence++;
    try {
      const safeEvidence = cloneRedacted(evidence).value;
      trajectory.evidenceReferences.push(evidenceId);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'evidence',
        evidenceId,
        evidence: safeEvidence,
      });
    } catch (error) {
      const issue = 'evidence recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, 'evidence', issue, null);
    }
  }

  visualCapture(ownerId: string, capture: QaVisualCapture): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    try {
      const safeCapture = cloneRedacted(toVisualCaptureInfo(capture)).value;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'visual-capture',
        capture: safeCapture,
      });
    } catch (error) {
      const issue = 'visual capture recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, 'visual', issue, null);
    }
  }

  visualFinding(
    ownerId: string,
    finding: { question: string; verdict: 'yes' | 'no' | 'unclear'; confidence: number; reasoning: string },
  ): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    try {
      const safe = cloneRedacted(finding).value;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'visual-finding',
        question: safe.question,
        verdict: safe.verdict,
        confidence: safe.confidence,
        reasoning: safe.reasoning,
      });
    } catch (error) {
      const issue = 'visual finding recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, 'visual', issue, null);
    }
  }

  stop(ownerId: string, result: QaStopResult): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    try {
      const safeResult = cloneRedacted(result).value;
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'stop',
        result: safeResult,
      });
    } catch (error) {
      const issue = 'stop recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, 'stop', issue, null);
    }
  }

  snapshot(ownerId: string): QaTrajectorySnapshot | null {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return null;
    const observations: Record<string, QaObservation> = {};
    for (const [key, value] of trajectory.observations) observations[key] = value;
    // Capture already performed redaction field-by-field. A second whole-tree
    // projection here would destroy the validated operational Replay URLs.
    const visualFindings = trajectory.events.filter(
      (event): event is import('./types.ts').QaTrajectoryVisualFindingEvent => event.kind === 'visual-finding',
    );
    return structuredClone({
      schemaVersion: 1 as const,
      driver: trajectory.driver,
      startedAt: trajectory.startedAt,
      launch: trajectory.launch,
      events: trajectory.events,
      observations,
      actions: trajectory.actions,
      evidenceReferences: trajectory.evidenceReferences,
      visualFindings,
      recordingIssues: trajectory.recordingIssues,
      settlePolicy: trajectory.settlePolicy,
    });
  }

  clear(): void {
    this.#trajectories.clear();
  }

  #aliasAction(trajectory: MutableTrajectory, action: QaAction): QaAction {
    if (action.kind === 'navigate') return { kind: 'navigate', url: projectReplayUrl(action.url) };
    if (action.kind === 'scroll') {
      if ('ref' in action && 'direction' in action) {
        return {
          kind: 'scroll',
          ref: this.#refAlias(trajectory, action.ref),
          direction: action.direction,
          ...(action.amount === undefined ? {} : { amount: action.amount }),
        };
      }
      if ('ref' in action) return { kind: 'scroll', ref: this.#refAlias(trajectory, action.ref) };
      return {
        kind: 'scroll',
        direction: action.direction,
        ...(action.amount === undefined ? {} : { amount: action.amount }),
      };
    }
    const ref = this.#refAlias(trajectory, action.ref);
    if (action.kind === 'click') return { kind: 'click', ref };
    if (action.kind === 'fill') return { kind: 'fill', ref, text: action.text };
    if (action.kind === 'press') return { kind: 'press', ref, key: action.key };
    if (action.kind === 'focus') return { kind: 'focus', ref };
    if (action.kind === 'type') return { kind: 'type', ref, text: action.text };
    if (action.kind === 'select') return { kind: 'select', ref, option: action.option };
    if (action.kind === 'hover') return { kind: 'hover', ref };
    return {
      kind: 'key',
      ref,
      key: action.key,
      ...(action.modifiers === undefined ? {} : { modifiers: [...action.modifiers] }),
    };
  }

  #aliasObservation(trajectory: MutableTrajectory, observation: QaObservation): QaObservation {
    return {
      ...observation,
      nodes: observation.nodes.map((node) => ({
        ...node,
        ref: this.#refAlias(trajectory, node.ref),
      })),
    };
  }

  #refAlias(trajectory: MutableTrajectory, rawRef: string): string {
    const digest = createHash('sha256').update(trajectory.salt).update(rawRef).digest('hex');
    let alias = trajectory.refAliases.get(digest);
    if (alias === undefined) {
      alias = 'ref-' + trajectory.nextRef++;
      trajectory.refAliases.set(digest, alias);
    }
    return alias;
  }

  #sequence(trajectory: MutableTrajectory): number {
    trajectory.sequence += 1;
    return trajectory.sequence;
  }

  #push(trajectory: MutableTrajectory, event: QaTrajectoryEvent): void {
    trajectory.events.push(event);
  }

  #recordingError(
    trajectory: MutableTrajectory,
    operation: 'start' | 'observation' | 'action' | 'receipt' | 'evidence' | 'stop' | 'visual' | 'settle',
    reason: string,
    actionId: string | null,
  ): void {
    this.#push(trajectory, {
      sequence: this.#sequence(trajectory),
      at: new Date().toISOString(),
      kind: 'recording-error',
      operation,
      reason,
      actionId,
    });
  }

  #failedTrajectory(driver: QaDriverAdapter['kind'], issue: string): MutableTrajectory {
    const trajectory: MutableTrajectory = {
      driver,
      startedAt: new Date().toISOString(),
      launch: '',
      sequence: 0,
      nextObservation: 1,
      nextAction: 1,
      nextEvidence: 1,
      salt: randomBytes(32),
      refAliases: new Map(),
      nextRef: 1,
      events: [],
      observations: new Map(),
      actions: [],
      actionById: new Map(),
      evidenceReferences: [],
      recordingIssues: [issue],
      lastObservationId: null,
      pendingActionId: null,
      settlingActionId: null,
      settlePolicy: null,
    };
    this.#recordingError(trajectory, 'start', issue, null);
    return trajectory;
  }
}

/**
 * Transparent adapter decorator used by both MCP and host tool surfaces.
 * Delegate results/errors are returned verbatim; recorder failures are ignored.
 */
export class RecordingQaDriverAdapter implements QaDriverAdapter {
  readonly kind: QaDriverAdapter['kind'];
  readonly #delegate: QaDriverAdapter;
  readonly #recorder: QaTrajectoryRecorder;

  constructor(delegate: QaDriverAdapter, recorder: QaTrajectoryRecorder) {
    this.#delegate = delegate;
    this.#recorder = recorder;
    this.kind = delegate.kind;
  }

  async start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo> {
    const info = await this.#delegate.start(ownerId, options);
    this.#safe(() => this.#recorder.start(ownerId, this.kind, options, info));
    return info;
  }

  async observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation> {
    try {
      const observation = await this.#delegate.observe(ownerId, options);
      this.#safe(() => this.#recorder.observation(ownerId, observation));
      return observation;
    } catch (error) {
      this.#safe(() => this.#recorder.observationFailed(ownerId, error));
      throw error;
    }
  }

  async act(ownerId: string, action: QaAction, approval?: QaApprovalGate): Promise<QaActionReceipt> {
    const actionId = this.#safeValue(() => this.#recorder.action(ownerId, action), null);
    try {
      const receipt = await this.#delegate.act(ownerId, action, approval);
      this.#safe(() => this.#recorder.receipt(ownerId, actionId, receipt));
      return receipt;
    } catch (error) {
      this.#safe(() => this.#recorder.actionFailed(ownerId, actionId, error));
      throw error;
    }
  }

  async evidence(ownerId: string, options?: QaEvidenceOptions): Promise<QaEvidence> {
    const evidence = await this.#delegate.evidence(ownerId, options);
    this.#safe(() => this.#recorder.evidence(ownerId, evidence));
    return evidence;
  }

  /** Passive: binds the SETTLED observation as the pending action's proof. */
  noteSettle(ownerId: string, report: QaSettleReport): void {
    this.#safe(() => this.#recorder.settle(ownerId, report));
  }

  /** Passive: persists the session's resolved settle policy for meta.settle export. */
  noteSettlePolicy(ownerId: string, policy: QaSettlePolicy): void {
    this.#safe(() => this.#recorder.recordSettlePolicy(ownerId, policy));
  }

  async visualObserve(ownerId: string, options?: QaVisualObserveOptions): Promise<QaVisualCapture> {
    if (typeof this.#delegate.visualObserve !== 'function') {
      throw new Error('the ' + this.kind + ' driver does not support visual capture');
    }
    const capture = await this.#delegate.visualObserve(ownerId, options);
    this.#safe(() => this.#recorder.visualCapture(ownerId, capture));
    return capture;
  }

  async stop(ownerId: string): Promise<QaStopResult> {
    const result = await this.#delegate.stop(ownerId);
    this.#safe(() => this.#recorder.stop(ownerId, result));
    return result;
  }

  async dispose(): Promise<void> {
    await this.#delegate.dispose?.();
  }

  #safe(fn: () => void): void {
    try { fn(); } catch { /* Recording cannot alter session behavior. */ }
  }

  #safeValue<T>(fn: () => T, fallback: T): T {
    try { return fn(); } catch { return fallback; }
  }
}
