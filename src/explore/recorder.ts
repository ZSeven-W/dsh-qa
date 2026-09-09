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
  QaScrollProofRefusal,
  QaSessionInfo,
  QaSettleReport,
  QaStartOptions,
  QaStopResult,
  QaVisualCapture,
  QaVisualObserveOptions,
} from '../session/adapter.ts';
import type { QaAssertion } from '../contracts.ts';
import type {
  QaRecordedAction,
  QaRecordedAssertion,
  QaTrajectoryEvent,
  QaTrajectorySnapshot,
} from './types.ts';

interface MutableAction extends QaRecordedAction {}

interface MutableTrajectory {
  driver: QaDriverAdapter['kind'];
  startedAt: string;
  launch: string;
  /** Computer-only durable window title recorded at start (null otherwise). */
  windowTitle: string | null;
  /** Mobile-only explicit device routing id recorded at start (null otherwise). */
  deviceId: string | null;
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
  /**
   * The action whose proof settle window closed most recently (set by every
   * settle() that bound an action). bindEscalatedScrollProof re-binds ONLY an
   * action whose passed action id equals this: an escalation notification for
   * any other action (e.g. one a concurrent act on the same owner settled in
   * between) is refused and recorded as a recording issue instead of silently
   * re-binding the wrong action.
   */
  lastSettledActionId: string | null;
  /** The session's RESOLVED settle policy (recorded at start; see noteSettlePolicy). */
  settlePolicy: QaSettlePolicy | null;
  /**
   * Recorded deterministic qa_assert decisions (QA-BL-066). Binding is
   * IDENTICAL for scoped and unscoped assertions: the deciding observation is
   * the last recorded one when the decision completes, and the baseline is
   * the latest recorded WHOLE-PAGE observation (see lastWholePageObservationId).
   */
  assertions: QaRecordedAssertion[];
  /**
   * The latest recorded WHOLE-PAGE observation id: the QA-BL-054 durability
   * gate for a scoped assertion needs whole-page uniqueness, which a scoped
   * observation can never prove. Updated only by observations without a
   * scope, so a scoped observe/assert never shadows it.
   */
  lastWholePageObservationId: string | null;
}

interface Sanitized<T> {
  value: T;
  changed: boolean;
}

function cloneRedacted<T>(value: T): Sanitized<T> {
  const projected = projectRedactedJsonValue(value);
  return { value: projected as T, changed: !isDeepStrictEqual(value, projected) };
}

type VisualRuntimeAction = Extract<QaAction, { kind: 'visual_click' | 'visual_drag' | 'visual_scroll' }>;

/**
 * Visual actions carry two different classes of data. The description and
 * grounding are durable replay prose and must pass the redaction projection;
 * observationId/captureSha256/point/to are ephemeral dispatch bindings and
 * are intentionally not scenario selectors. Comparing the whole runtime
 * object here made a redaction of a transient field exclude an otherwise
 * replayable visual step.
 */
function projectVisualAction(action: VisualRuntimeAction): Sanitized<VisualRuntimeAction> {
  const durable = action.kind === 'visual_click'
    ? {
        kind: action.kind,
        targetDescription: action.targetDescription,
        ...(action.grounding === undefined ? {} : { grounding: action.grounding }),
      }
    : action.kind === 'visual_drag'
      ? {
          kind: action.kind,
          targetDescription: action.targetDescription,
          toDescription: action.toDescription,
          ...(action.grounding === undefined ? {} : { grounding: action.grounding }),
        }
      : {
          kind: action.kind,
          targetDescription: action.targetDescription,
          direction: action.direction,
          ...(action.amount === undefined ? {} : { amount: action.amount }),
          ...(action.grounding === undefined ? {} : { grounding: action.grounding }),
        };
  const safeDurable = projectRedactedJsonValue(durable) as typeof durable;
  return {
    value: {
      ...action,
      ...safeDurable,
    } as VisualRuntimeAction,
    changed: !isDeepStrictEqual(durable, safeDurable),
  };
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactText(raw);
}

function launchFrom(options: QaStartOptions | undefined, info: QaSessionInfo, kind: QaDriverAdapter['kind']): string {
  if (kind === 'computer') return options?.bundleId ?? info.page.url;
  if (kind === 'ios') return options?.bundleId ?? info.page.url;
  if (kind === 'android') return options?.packageName ?? options?.bundleId ?? info.page.url;
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
      // The computer window title is a DURABLE selector (the fixture/owner
      // window); the window number, PID, and geometry are deliberately NOT
      // recorded. An empty title is recorded as null, never as a selector.
      const rawWindowTitle = driver === 'computer'
        ? (safeOptions.windowTitle ?? safeInfo.page.title ?? '')
        : '';
      const safeWindowTitle = rawWindowTitle.trim() === '' ? null : rawWindowTitle;
      // The mobile device id is recorded only as an exact routing selector
      // from this session's explicit start option. Replay can override it;
      // it is never claimed as a globally durable device identity.
      const rawDeviceId = driver === 'ios' || driver === 'android'
        ? (safeOptions.deviceId ?? '')
        : '';
      const safeDeviceId = rawDeviceId.trim() === '' ? null : rawDeviceId;
      const trajectory: MutableTrajectory = {
        driver,
        startedAt: new Date().toISOString(),
        launch: safeLaunch,
        windowTitle: safeWindowTitle,
        deviceId: safeDeviceId,
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
        lastSettledActionId: null,
        settlePolicy: null,
        assertions: [],
        lastWholePageObservationId: null,
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
        : action.kind === 'visual_click' || action.kind === 'visual_drag' || action.kind === 'visual_scroll'
          ? projectVisualAction(aliased as VisualRuntimeAction)
          : cloneRedacted(aliased);
      trajectory.settlingActionId = null;
      const recorded: MutableAction = {
        actionId,
        action: safe.value,
        beforeObservationId: trajectory.lastObservationId,
        receipt: null,
        afterObservationId: null,
        afterObservationStable: null,
        scrollProofRefusal: null,
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
        scrollProofRefusal: null,
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
      // QA-BL-066: the scope-durability baseline for a recorded assertion is
      // the latest WHOLE-PAGE observation — whole-page uniqueness is what the
      // QA-BL-054 gate proves, so a scoped observation never shadows it.
      if (observation.scope === undefined) {
        trajectory.lastWholePageObservationId = observationId;
      }
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
    // A standalone settle (no action) never shadows the most recently proven
    // action: the scroll-proof escalation re-binds exactly that action.
    if (actionId !== null) trajectory.lastSettledActionId = actionId;
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

  /**
   * Re-bind EXACTLY the named action's proof observation to the last recorded
   * observation. The session core calls this exactly once per action
   * (synchronously inside act) when it accepted the ONE bounded
   * budget-escalated observation as the scroll-by-ref proof, passing the
   * exact action id this recorder stamped onto the receipt: the escalated
   * window's observations are already recorded, and the last of them is the
   * settled fuller view. The recorded observation keeps whatever truncated
   * flag the driver reported — nothing here claims or alters any budget.
   *
   * The re-bind is fail-closed: a null id, an unknown id, an action without a
   * recorded receipt, or an action that is NOT the most recently settled one
   * (a concurrent act on the same owner settled in between) is refused and
   * recorded as a recording issue instead of silently re-binding the wrong
   * action.
   */
  bindEscalatedScrollProof(ownerId: string, actionId: string | null): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    const refuse = (issue: string): void => {
      trajectory.recordingIssues.push(issue);
      const recorded = actionId === null ? undefined : trajectory.actionById.get(actionId);
      if (recorded !== undefined) recorded.recordingIssue = issue;
      this.#recordingError(trajectory, 'observation', issue, actionId);
    };
    if (actionId === null) {
      refuse('scroll-proof escalation could not be bound: the session core did not pass the recorded action id');
      return;
    }
    const action = trajectory.actionById.get(actionId);
    if (action === undefined) {
      refuse('scroll-proof escalation could not be bound: unknown action id "' + actionId + '"');
      return;
    }
    if (action.receipt === null) {
      refuse('scroll-proof escalation could not be bound: action "' + actionId + '" has no recorded receipt');
      return;
    }
    if (trajectory.lastSettledActionId !== actionId) {
      refuse('scroll-proof escalation could not be bound: action "' + actionId + '" is not the most recently settled action');
      return;
    }
    if (trajectory.lastObservationId === null) {
      refuse('scroll-proof escalation could not be bound: no observation has been recorded yet');
      return;
    }
    try {
      action.afterObservationId = trajectory.lastObservationId;
    } catch (error) {
      refuse('scroll-proof escalation recording failed: ' + safeReason(error));
    }
  }

  /**
   * Attach the FINAL record-time proof refusal (QA-BL-067) to EXACTLY the
   * named recorded action. The session core calls this exactly once per act
   * whose final proof state carries an escalationRefused disclosure, passing
   * the exact action id this recorder stamped onto the receipt. Export then
   * carries the refusal on the step (additive `escalationRefused`) and
   * report.md prints it on the step line.
   *
   * The attachment is fail-closed: a null id, an unknown id, an action without
   * a recorded receipt, or an action that is NOT the most recently settled one
   * is refused and recorded as a recording issue instead of silently tagging
   * the wrong action.
   */
  recordScrollProofRefusal(ownerId: string, actionId: string | null, refusal: QaScrollProofRefusal): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    const refuse = (issue: string): void => {
      trajectory.recordingIssues.push(issue);
      const recorded = actionId === null ? undefined : trajectory.actionById.get(actionId);
      if (recorded !== undefined) recorded.recordingIssue = issue;
      this.#recordingError(trajectory, 'settle', issue, actionId);
    };
    if (actionId === null) {
      refuse('scroll-proof refusal could not be recorded: the session core did not pass the recorded action id');
      return;
    }
    const action = trajectory.actionById.get(actionId);
    if (action === undefined) {
      refuse('scroll-proof refusal could not be recorded: unknown action id "' + actionId + '"');
      return;
    }
    if (action.receipt === null) {
      refuse('scroll-proof refusal could not be recorded: action "' + actionId + '" has no recorded receipt');
      return;
    }
    if (trajectory.lastSettledActionId !== actionId) {
      refuse('scroll-proof refusal could not be recorded: action "' + actionId + '" is not the most recently settled action');
      return;
    }
    try {
      action.scrollProofRefusal = cloneRedacted(refusal).value;
    } catch (error) {
      refuse('scroll-proof refusal recording failed: ' + safeReason(error));
    }
  }

  /**
   * QA-BL-067: the scoped proof attempt for the named action was REFUSED by
   * the driver — a HANDLED refusal (disclosed as escalationRefused, never a
   * recording failure) — and the session core fell back to the whole-page
   * proof read. The refused attempt's failed observation therefore cleared
   * the settle-window state: re-arm it so the FALLBACK settle binds exactly
   * this action's proof (pendingActionId -> first observation -> settle), and
   * clear the handled refusal from the action's own issue marker so the
   * exporter never excludes the action over it.
   */
  rearmSettleWindowAfterScopedProofFallback(ownerId: string, actionId: string | null): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined || actionId === null) return;
    const action = trajectory.actionById.get(actionId);
    if (action === undefined) return;
    if (action.recordingIssue !== null && action.recordingIssue.startsWith('fresh observation failed:')) {
      action.recordingIssue = null;
    }
    trajectory.pendingActionId = actionId;
    trajectory.settlingActionId = null;
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

  /**
   * Record one deterministic qa_assert decision (QA-BL-066). The binding is
   * IDENTICAL for scoped and unscoped assertions: the tool layer calls this
   * AFTER the decision completed, when the last recorded observation IS the
   * deciding observation (the settle polls, the one bounded escalation, and
   * the terminal probed coverage read all record through the session core in
   * the same flow), and the baseline is the latest recorded WHOLE-PAGE
   * observation — the QA-BL-054 durability gate needs whole-page uniqueness,
   * which a scoped observation can never prove. Recording is passive: no
   * trajectory (or a failed record) never changes the tool result.
   */
  assertion(ownerId: string, assertion: QaAssertion, passed: boolean): void {
    const trajectory = this.#trajectories.get(ownerId);
    if (trajectory === undefined) return;
    try {
      const safeAssertion = cloneRedacted(assertion).value;
      const recorded: QaRecordedAssertion = {
        assertion: safeAssertion,
        passed,
        actionId: trajectory.lastSettledActionId,
        decidingObservationId: trajectory.lastObservationId,
        baselineObservationId: trajectory.lastWholePageObservationId,
      };
      trajectory.assertions.push(recorded);
      this.#push(trajectory, {
        sequence: this.#sequence(trajectory),
        at: new Date().toISOString(),
        kind: 'assertion',
        assertion: recorded.assertion,
        passed: recorded.passed,
        actionId: recorded.actionId,
        decidingObservationId: recorded.decidingObservationId,
        baselineObservationId: recorded.baselineObservationId,
      });
    } catch (error) {
      const issue = 'assertion recording failed: ' + safeReason(error);
      trajectory.recordingIssues.push(issue);
      this.#recordingError(trajectory, 'observation', issue, null);
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
      windowTitle: trajectory.windowTitle,
      deviceId: trajectory.deviceId,
      events: trajectory.events,
      observations,
      actions: trajectory.actions,
      assertions: trajectory.assertions,
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
    if (action.kind === 'visual_click') {
      return {
        kind: 'visual_click',
        targetDescription: action.targetDescription,
        observationId: action.observationId,
        captureSha256: action.captureSha256,
        point: { ...action.point },
        ...(action.grounding === undefined ? {} : { grounding: { ...action.grounding } }),
      };
    }
    if (action.kind === 'visual_drag') {
      return {
        kind: 'visual_drag',
        targetDescription: action.targetDescription,
        toDescription: action.toDescription,
        observationId: action.observationId,
        captureSha256: action.captureSha256,
        point: { ...action.point },
        to: { ...action.to },
        ...(action.grounding === undefined ? {} : { grounding: { ...action.grounding } }),
      };
    }
    if (action.kind === 'visual_scroll') {
      return {
        kind: 'visual_scroll',
        targetDescription: action.targetDescription,
        observationId: action.observationId,
        captureSha256: action.captureSha256,
        point: { ...action.point },
        direction: action.direction,
        ...(action.amount === undefined ? {} : { amount: action.amount }),
        ...(action.grounding === undefined ? {} : { grounding: { ...action.grounding } }),
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
        // QA-BL-062: parentRef names another node of the SAME observation, so
        // it must be aliased through the SAME deterministic map — otherwise
        // the recorded parentRef chains point at raw driver refs while node
        // refs are aliased, and the exporter's ancestry walk (scope.path)
        // could never resolve a single hop. Aliasing both sides keeps the
        // RELATIONSHIPS intact and still hides session-local identity.
        ...(node.parentRef === null || node.parentRef === undefined
          ? {}
          : { parentRef: this.#refAlias(trajectory, node.parentRef) }),
      })),
      // A scoped observation's root refs are driver refs like every node ref:
      // alias them so no session-local identity ever enters the trajectory.
      // role/name/tag pass through and are what export records as the scope.
      ...(observation.scope === undefined
        ? {}
        : {
            scope: {
              ...observation.scope,
              ref: this.#refAlias(trajectory, observation.scope.ref),
              ...(typeof observation.scope.rootRef === 'string' && observation.scope.rootRef !== ''
                ? { rootRef: this.#refAlias(trajectory, observation.scope.rootRef) }
                : {}),
            },
          }),
      // The identity anchor's ref names the anchored node of the SAME
      // observation: alias it too (export reads only its truth, never the raw
      // ref, but the trajectory must not leak session-local identity).
      ...(observation.anchor === undefined
        ? {}
        : {
            anchor: {
              ...observation.anchor,
              ...(observation.anchor.ref === null ? {} : { ref: this.#refAlias(trajectory, observation.anchor.ref) }),
            },
          }),
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
      windowTitle: null,
      deviceId: null,
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
      lastSettledActionId: null,
      settlePolicy: null,
      assertions: [],
      lastWholePageObservationId: null,
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
      // The RECORDED receipt keeps the delegate's shape (no internal identity
      // leaks into the trajectory); the receipt returned to the session
      // carries the recorder's exact action id so the scroll-proof escalation
      // can pass it back through noteEscalatedScrollProof and the recorder
      // re-binds exactly THIS action, never whatever settled most recently.
      this.#safe(() => this.#recorder.receipt(ownerId, actionId, receipt));
      return actionId === null ? receipt : { ...receipt, actionId };
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

  /**
   * Passive: re-binds EXACTLY the named recorded action's proof to the
   * escalated observation the session core just accepted (see QaSession.act).
   * Its presence on this adapter is the capability gate the session core
   * checks before taking the ONE bounded scroll-proof escalation.
   */
  noteEscalatedScrollProof(ownerId: string, actionId: string | null): void {
    this.#safe(() => this.#recorder.bindEscalatedScrollProof(ownerId, actionId));
  }

  /**
   * Passive (QA-BL-067): attaches the FINAL record-time proof refusal to
   * exactly the named recorded action, so export carries it on the step and
   * report.md prints it on the step line. Recording can never alter session
   * behavior.
   */
  noteScrollProofRefusal(ownerId: string, actionId: string | null, refusal: QaScrollProofRefusal): void {
    this.#safe(() => this.#recorder.recordScrollProofRefusal(ownerId, actionId, refusal));
  }

  /**
   * Passive (QA-BL-067): re-arms the settle-window state after a REFUSED
   * scoped proof attempt so the fallback whole-page settle binds exactly this
   * action's proof. Recording can never alter session behavior.
   */
  noteScopedProofFallback(ownerId: string, actionId: string | null): void {
    this.#safe(() => this.#recorder.rearmSettleWindowAfterScopedProofFallback(ownerId, actionId));
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
