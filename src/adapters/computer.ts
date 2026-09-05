import type {
  ComputerAction,
  ComputerActionReceipt,
  ComputerDriver,
  ComputerDriverContext,
  ComputerEvidence,
  ComputerModifier,
  ComputerObservation,
  ComputerObserveRequest,
  ComputerTarget,
} from '@zseven-w/dsh-computer';
import type {
  QaAction,
  QaActionReceipt,
  QaApprovalGate,
  QaComputerAppIdentity,
  QaComputerEvidence,
  QaDriverAdapter,
  QaEvidence,
  QaEvidenceOptions,
  QaObservation,
  QaObserveOptions,
  QaSemanticNode,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
  QaVisualCapture,
  QaVisualObserveOptions,
} from '../session/adapter.ts';

/**
 * Adapts the @zseven-w/dsh-computer ComputerDriver to the QA session adapter
 * interface. This is a thin, NON-WEAKENING passthrough that preserves every
 * driver safety semantic:
 *
 *  - secure text fields are PERMANENTLY rejected by the driver (hard-deny,
 *    code "secure-text") and this adapter never retries, reroutes, or widens
 *    that decision — it forwards the rejection verbatim even when an approval
 *    gate is supplied;
 *  - the approval gate is forwarded to the driver context VERBATIM; an
 *    'allowed-once' decision is consumed by the driver exactly once per act
 *    (the driver binds the grant to a single action with a nonce), and this
 *    adapter issues exactly one driver.act call per QaAction;
 *  - an 'unknown' receipt is NEVER promoted to success here — the session core
 *    re-observes and only a fresh observation decides the app-level outcome;
 *  - strong identity binding is asserted, not assumed: every observation must
 *    carry a launch identity, window number, and window frame, and must match
 *    the selectors bound at start() (bundle id, PID, window number, title);
 *  - helper status is surfaced unmodified through evidence, so a missing
 *    Accessibility / Screen Recording grant is visible to callers and must be
 *    asserted (never silently green).
 */

interface Binding {
  bundleId?: string;
  pid?: number;
  windowNumber?: number;
  windowTitle?: string;
}

const EDITABLE_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField']);

function receiptCode(receipt: ComputerActionReceipt): string | undefined {
  // The computer receipt has no structured code field; derive the stable
  // safety code from the driver's reason where it is deterministic. Every
  // reason string below is matched verbatim against dsh-computer's
  // src/controller.ts (see the line citations in computer-adapter.test.mjs).
  if (receipt.reason.includes('secure text entry')) return 'secure-text';
  if (receipt.reason.includes('host approval')) return 'APPROVAL_REQUIRED';
  if (receipt.reason.includes('approval was not granted')
    || receipt.reason.includes('approval unavailable')
    || receipt.reason.includes('approval cancelled')) {
    return 'APPROVAL_REQUIRED';
  }
  // v4: the bounded observation ring can evict a still-TTL-valid observation
  // (memory ceiling); the driver reports it with a distinct structured code
  // instead of a false "unknown reference". Preserve that code verbatim.
  if (receipt.reason.includes('OBSERVATION_EVICTED')) return 'OBSERVATION_EVICTED';
  if (receipt.status === 'rejected' && receipt.reason.includes('unknown reference')) return 'UNKNOWN_REF';
  // TTL-first eviction: both the generic "stale observation" and the
  // approval-path "observation expired before action dispatch" spelling are
  // the SAME expiry condition and must keep their structured code.
  if (receipt.reason.includes('stale')) return 'STALE_OBSERVATION';
  if (receipt.reason.includes('observation expired before action dispatch')) return 'STALE_OBSERVATION';
  // A locked (or otherwise unavailable) interactive desktop session fails the
  // preflight and surfaces as "<code>: <message>"; the structured code must
  // survive instead of collapsing to prose.
  if (receipt.reason.includes('session_locked')) return 'SESSION_LOCKED';
  if (receipt.reason.includes('live application identity changed')
    || receipt.reason.includes('live window identity changed')
    || receipt.reason.includes('live target identity changed')
    || receipt.reason.includes('live observation fingerprint changed')) {
    return 'IDENTITY_CHANGED';
  }
  return undefined;
}

export class ComputerAdapter implements QaDriverAdapter {
  readonly kind = 'computer' as const;
  readonly #driver: ComputerDriver;
  #binding: Binding | null = null;

  constructor(driver: ComputerDriver) {
    this.#driver = driver;
  }

  async start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo> {
    void ownerId;
    this.#binding = {
      ...(options?.bundleId === undefined ? {} : { bundleId: options.bundleId }),
      ...(options?.pid === undefined ? {} : { pid: options.pid }),
      ...(options?.windowNumber === undefined ? {} : { windowNumber: options.windowNumber }),
      ...(options?.windowTitle === undefined ? {} : { windowTitle: options.windowTitle }),
    };
    // The computer driver has no launch/start step: the app under test is
    // launched externally (through LaunchServices) and bound on observe.
    return {
      page: { url: options?.bundleId ?? '', title: options?.windowTitle ?? '' },
      headless: false,
    };
  }

  async observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation> {
    // Scoped observation is a browser-only capability (browser driver contract
    // v8). A withinRef here is REFUSED — never silently ignored, and never
    // mapped onto some other computer-driver mechanism: a silent drop would
    // make the caller believe the returned view is the scoped container when
    // it is the whole accessibility tree.
    if (options?.withinRef !== undefined) {
      throw new Error(
        'the computer driver does not support scoped observation (withinRef); '
        + 'observe the whole accessibility tree or narrow it with maxDepth instead',
      );
    }
    // Browser driver contract v9 requests are handled EXPLICITLY (never by
    // omission), and both are IGNORED on purpose: the accessibility tree has
    // no shadow-DOM boundary — nothing like a closed root can hide a node
    // from the OS accessibility walk, so there is nothing a coverage probe
    // could verify that the tree itself does not already assert, and there is
    // no browser element handle to anchor. Refusing them would only break the
    // shared terminal-absence re-read; ignoring them keeps computer absence
    // provable on complete views (see #projectObservation's vacuous coverage).
    void options?.verifyCoverage;
    void options?.anchorLastAction;
    const binding = this.#binding;
    const request: ComputerObserveRequest = {
      ...(binding !== null && (binding.bundleId !== undefined || binding.pid !== undefined)
        ? {
            app: {
              ...(binding.bundleId === undefined ? {} : { bundleId: binding.bundleId }),
              ...(binding.pid === undefined ? {} : { pid: binding.pid }),
            },
          }
        : {}),
      ...(binding !== null && (binding.windowNumber !== undefined || binding.windowTitle !== undefined)
        ? {
            window: {
              ...(binding.windowNumber === undefined ? {} : { number: binding.windowNumber }),
              ...(binding.windowTitle === undefined ? {} : { title: binding.windowTitle }),
            },
          }
        : {}),
      ...(options?.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      ...(options?.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
      ...(options?.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    };
    const observation = await this.#driver.observe(request, { scopeId: ownerId });
    this.#assertBinding(observation);
    return this.#projectObservation(observation);
  }

  async act(ownerId: string, action: QaAction, approval?: QaApprovalGate): Promise<QaActionReceipt> {
    const computerAction = this.#mapAction(action);
    const context: ComputerDriverContext = {
      scopeId: ownerId,
      ...(approval === undefined ? {} : { approval }),
    };
    // Exactly one driver.act call: never retried around any rejection/unknown.
    const receipt = await this.#driver.act(computerAction, context);
    const code = receiptCode(receipt);
    return {
      status: receipt.status,
      ...(code === undefined ? {} : { code }),
      ...(receipt.reason === '' ? {} : { reason: receipt.reason }),
      dispatched: receipt.nativeAccepted || receipt.status === 'confirmed' || receipt.status === 'unknown',
    };
  }

  /**
   * Window-only visual observation with native Set-of-Mark labels. The PNG is
   * returned as bytes so callers can persist it as a structured artifact; only
   * the metadata (dimensions, digest, mark count) belongs in JSON. The computer
   * driver binds its capture to an exact observation id, so one is required.
   */
  async visualObserve(ownerId: string, options?: QaVisualObserveOptions): Promise<QaVisualCapture> {
    const observationId = options?.observationId;
    if (observationId === undefined || observationId === '') {
      throw new Error('computer visual capture requires an exact observation id');
    }
    const capture = await this.#driver.visualObserve(
      { observationId, ...(options?.maxMarks === undefined ? {} : { maxMarks: options.maxMarks }) },
      { scopeId: ownerId },
    );
    return {
      driver: 'computer',
      observationFingerprint: capture.observationFingerprint,
      observationId: capture.observationId,
      png: capture.png,
      width: capture.capture.pixelWidth,
      height: capture.capture.pixelHeight,
      sha256: capture.capture.artifact.sha256,
      usable: capture.capture.quality.usable,
      marks: capture.marks.length,
      omitted: capture.omitted.length,
    };
  }

  async evidence(ownerId: string, options?: QaEvidenceOptions): Promise<QaEvidence> {
    const evidence: ComputerEvidence = await this.#driver.evidence(
      { scopeId: ownerId },
      options?.maxReceipts === undefined ? {} : { limit: options.maxReceipts },
    );
    // Honest receipt accounting, never fabricated zeros. The computer driver
    // has NO console/network buffers, so `dropped` is omitted (it is a
    // browser-only field). Whether receipts were evicted from the bounded
    // ring is told by the v4 per-receipt counters, which older drivers do not
    // expose: then the counters are null and the reason says so, so a reader
    // can tell "did not look" from "looked and found none".
    const raw = evidence as ComputerEvidence & {
      receipts_total?: number;
      receipts_dropped?: number;
      receipts_returned?: number;
      bounded?: boolean;
    };
    const hasReceiptCounters =
      typeof raw.receipts_total === 'number'
      && typeof raw.receipts_dropped === 'number'
      && typeof raw.receipts_returned === 'number';
    return {
      console: [],
      network: [],
      bounded: true,
      computer: {
        contractVersion: evidence.contractVersion,
        scope: evidence.scope,
        status: evidence.status,
        activeObservations: evidence.activeObservations,
        activeNativeRequests: evidence.activeNativeRequests,
        receipts: evidence.receipts,
        ...(hasReceiptCounters
          ? {
              receiptsTotal: raw.receipts_total,
              receiptsDropped: raw.receipts_dropped,
              receiptsReturned: raw.receipts_returned,
              receiptsBounded: raw.bounded === true,
            }
          : {
              receiptsTotal: null,
              receiptsDropped: null,
              receiptsReturned: null,
              receiptsBounded: null,
              receiptsCountersUnavailableReason:
                'the computer driver contract is older than v4 and does not expose per-receipt counters; receipt truncation is unknown',
            }),
      } satisfies QaComputerEvidence,
    };
  }

  async stop(ownerId: string): Promise<QaStopResult> {
    await this.#driver.disposeScope(ownerId);
    return { stopped: true, reason: 'scope-disposed' };
  }

  async dispose(): Promise<void> {
    await this.#driver.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  #mapAction(action: QaAction): ComputerAction {
    switch (action.kind) {
      case 'click':
        return { kind: 'click', ref: action.ref };
      case 'focus':
        return { kind: 'focus', ref: action.ref };
      case 'type':
        return { kind: 'type', ref: action.ref, text: action.text };
      case 'key':
        return {
          kind: 'key',
          ref: action.ref,
          key: action.key,
          ...(action.modifiers === undefined ? {} : { modifiers: [...action.modifiers] as ComputerModifier[] }),
        };
      case 'scroll': {
        if ('ref' in action && 'direction' in action) {
          return {
            kind: 'scroll',
            ref: action.ref,
            direction: action.direction,
            ...(action.amount === undefined ? {} : { amount: action.amount }),
          };
        }
        throw new Error(
          'computer driver scroll requires both ref and direction (the browser-only ref-only or direction-only scroll shapes are not computer actions)',
        );
      }
      case 'fill':
        throw new Error('computer driver does not support the browser "fill" action; use "type"');
      case 'press':
        throw new Error('computer driver does not support the browser "press" action; use "key"');
      case 'navigate':
        throw new Error('computer driver does not support the "navigate" action');
      case 'select':
        throw new Error('computer driver does not support the "select" action (browser-only)');
      case 'hover':
        throw new Error('computer driver does not support the "hover" action (browser-only)');
    }
  }

  #assertBinding(observation: ComputerObservation): void {
    const binding = this.#binding;
    if (binding !== null) {
      if (binding.bundleId !== undefined && observation.app.bundleId !== binding.bundleId) {
        throw new Error(
          'observed app bundle id "' + observation.app.bundleId + '" does not match bound "' + binding.bundleId + '"',
        );
      }
      if (binding.pid !== undefined && observation.app.pid !== binding.pid) {
        throw new Error(
          'observed app PID ' + observation.app.pid + ' does not match bound ' + binding.pid,
        );
      }
      if (binding.windowNumber !== undefined && observation.window.number !== binding.windowNumber) {
        throw new Error(
          'observed window number ' + observation.window.number + ' does not match bound ' + binding.windowNumber,
        );
      }
      if (binding.windowTitle !== undefined && observation.window.title !== binding.windowTitle) {
        throw new Error(
          'observed window title does not match the bound title "' + binding.windowTitle + '"',
        );
      }
    }
    // Strong identity binding must be asserted, never assumed.
    if (observation.app.launchIdentity === null) {
      throw new Error('observed app has no launch identity; strong identity binding cannot be asserted');
    }
    if (observation.window.number === null) {
      throw new Error('observed window has no Accessibility window number; strong identity binding cannot be asserted');
    }
    if (observation.window.frame === null) {
      throw new Error('observed window has no frame; strong identity binding cannot be asserted');
    }
  }

  #projectNode(target: ComputerTarget): QaSemanticNode {
    const editable = EDITABLE_ROLES.has(target.role) && target.enabled !== false;
    return {
      ref: target.ref,
      role: target.role,
      name: target.name ?? '',
      tag: target.identifier ?? '',
      interactive: target.enabled !== false && (target.actions.length > 0 || editable),
      editable,
      disabled: target.enabled === false,
      secure: target.secure,
      value: target.value,
    };
  }

  #projectObservation(observation: ComputerObservation): QaObservation {
    return {
      page: { url: observation.app.bundleId, title: observation.window.title ?? '' },
      nodes: observation.targets.map((target) => this.#projectNode(target)),
      truncated: observation.truncated,
      // The budget the driver ACTUALLY applied (its own 1..500 clamp). The
      // computer driver reports no truncation-reason vocabulary, so no
      // truncationReasons field is synthesized here.
      maxNodes: observation.limits.maxNodes,
      observationId: observation.observationId,
      fingerprint: observation.fingerprint,
      // Vacuously verified coverage (browser driver contract v9 shape):
      // the computer driver's accessibility projection has NO shadow-DOM
      // boundary, so zero closed shadow roots can hide content from it. The
      // tree's own truncated flag remains the completeness gate. probedNodes
      // is honestly 0 — no probe ever runs, and none is needed.
      coverage: { verified: true, closedShadowRoots: 0, probedNodes: 0 },
      app: {
        bundleId: observation.app.bundleId,
        pid: observation.app.pid,
        launchIdentity: observation.app.launchIdentity,
        name: observation.app.name,
      } satisfies QaComputerAppIdentity,
      window: {
        number: observation.window.number,
        role: observation.window.role,
        subrole: observation.window.subrole,
        title: observation.window.title,
        frame: observation.window.frame === null
          ? null
          : {
              x: observation.window.frame.x,
              y: observation.window.frame.y,
              width: observation.window.frame.width,
              height: observation.window.frame.height,
            },
        identity: observation.window.identity,
      },
    };
  }
}
