/**
 * Shared in-process plumbing for the iOS and Android QA adapters.
 *
 * Both mobile backends expose raw semantic trees and coordinate taps, not a
 * ref-based target store like the desktop/browser drivers. The adapters mint
 * per-observation opaque refs, keep them in a per-owner session cache with an
 * expiry, and NEVER trust a ref by itself: every coordinate-derived act first
 * reads a fresh native tree/foreground and refuses stale, ambiguous,
 * disabled, secure, changed, or out-of-bounds targets before dispatch.
 *
 * The lease registry here is deliberately in-process only. It is a defence
 * against two adapter instances controlling the same device in one process; it
 * is not a cluster-wide/distributed lock.
 */

import type {
  QaAction,
  QaActionReceipt,
  QaDriverAdapter,
  QaEvidence,
  QaObserveOptions,
  QaObservation,
  QaSemanticNode,
  QaSessionInfo,
  QaStartOptions,
  QaStopResult,
  QaVisualCapture,
  QaVisualObserveOptions,
} from '../session/adapter.ts';
import type { MobileObservedIdentity } from './mobile-types.ts';
import { QaCodeError } from './mobile-types.ts';

export type MobileKind = 'ios' | 'android';
export type MobileCoordinateSpace = 'point' | 'display-pixels';
export type MobileBackendKind = 'simulator' | 'physical' | 'emulator' | 'device';
export type MobileEvidenceBackendKind = MobileBackendKind | 'unknown';
export { QaCodeError } from './mobile-types.ts';

export const MOBILE_REF_TTL_MS = 30_000;

export interface MobileFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Backend-normalized tree node before the QA layer mints refs. Never contains
 * a path pseudo-identifier; `identifier` is present only when the backend gave
 * a native stable identifier.
 */
export interface MobileRawNode {
  identifier?: string;
  role: string;
  name: string;
  tag: string;
  frame: MobileFrame;
  enabled: boolean;
  disabled: boolean;
  editable: boolean;
  interactive: boolean;
  /** undefined = unknown (older backends); false is an explicit hidden claim. */
  visible?: boolean;
  focused: boolean | null;
  secure: boolean | null;
  value?: string | null;
  clickable: boolean;
  scrollable: boolean;
  children?: MobileRawNode[];
}

export interface MobileNativeObservation {
  deviceId: string;
  backendKind: MobileBackendKind;
  actualAppId?: string;
  /** Present when the backend exposed the native foreground process id. */
  appPid?: number;
  /** True only when the backend's native foreground evidence names the bound app. */
  verified: boolean;
  /** Extra forensic detail from the backend observation (raw/read error). */
  detail?: string;
  screen: { width: number; height: number };
  coordinateSpace: MobileCoordinateSpace;
  nodes: MobileRawNode[];
  truncated: boolean;
  maxNodes?: number;
  maxDepth?: number;
}

export type MobileTargetedTextMode = 'type' | 'fill';

/**
 * Internal target passed to platform-native element-bound text primitives
 * (iOS typeTarget/fillTarget). The native method chosen by `mode` supplies
 * append vs replace semantics; the QA layer never fabricates a mode.
 */
export interface MobileTargetedTextTarget {
  udid: string;
  bundleId: string;
  /**
   * Native stable accessibility identifier. Present exactly when the backend
   * exposed one on the fresh target; the existing identifier is ALWAYS
   * preferred over the semantic selector. Never a fabricated tree path.
   */
  identifier?: string;
  /**
   * iOS-only identifier-less selector: the exact nonempty observed
   * accessibility name plus the native semantic editable type
   * (TextField/TextView/SearchField). Rides only when no native identifier
   * exists; the frame stays a precondition, never the selector.
   */
  semantic?: { label: string; type: string };
  frame: MobileFrame;
  text: string;
  expectedPID?: number;
  secure?: boolean;
}

/**
 * Normalized result of a platform-native target-bound text primitive.
 * `dispatched:true` is always possibly-sent and maps to a QA unknown receipt,
 * never to a no-dispatch rejection.
 */
export interface MobileTargetedTextResult {
  status: 'unknown' | 'rejected';
  dispatched: boolean;
  nativeAccepted: boolean;
  code?: string;
  reason?: string;
}

export interface MobileForegroundResult {
  backendKind: MobileEvidenceBackendKind;
  verified: boolean;
  detail: string;
}

/** Device lease state shared by all adapter instances in this process. */
interface DeviceLease {
  key: string;
  kind: MobileKind;
  deviceId: string;
  owner: string;
  count: number;
}

const leases = new Map<string, DeviceLease>();

function leaseKey(kind: MobileKind, deviceId: string): string {
  return `${kind}:${deviceId}`;
}

function acquireLease(kind: MobileKind, deviceId: string, ownerId: string): void {
  const key = leaseKey(kind, deviceId);
  const existing = leases.get(key);
  if (existing !== undefined && existing.owner !== ownerId) {
    throw new Error(
      `device ${deviceId} is already leased by QA owner ${existing.owner} in this process; ` +
        'stop that session first. This lease is in-process only and is not a cluster-wide guarantee.',
    );
  }
  if (existing === undefined) {
    leases.set(key, { key, kind, deviceId, owner: ownerId, count: 1 });
    return;
  }
  existing.count += 1;
}

function releaseLease(kind: MobileKind, deviceId: string, ownerId: string): void {
  const key = leaseKey(kind, deviceId);
  const existing = leases.get(key);
  if (existing === undefined || existing.owner !== ownerId) return;
  existing.count -= 1;
  if (existing.count <= 0) leases.delete(key);
}

function frameKey(frame: MobileFrame): string {
  return [Math.round(frame.x), Math.round(frame.y), Math.round(frame.width), Math.round(frame.height)].join('x');
}

/** Small tolerance for a semantic target whose bounds shifted between two reads. */
const MAX_BOUNDS_SHIFT = 2;

function framesClose(a: MobileFrame, b: MobileFrame): boolean {
  return Math.abs(a.x - b.x) <= MAX_BOUNDS_SHIFT
    && Math.abs(a.y - b.y) <= MAX_BOUNDS_SHIFT
    && Math.abs(a.width - b.width) <= MAX_BOUNDS_SHIFT
    && Math.abs(a.height - b.height) <= MAX_BOUNDS_SHIFT;
}

function pointInside(frame: MobileFrame, screen: { width: number; height: number }): boolean {
  return frame.x >= 0
    && frame.y >= 0
    && frame.width > 0
    && frame.height > 0
    && frame.x + frame.width <= screen.width
    && frame.y + frame.height <= screen.height;
}

function center(frame: MobileFrame): { x: number; y: number } {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

function isWithinScreen(point: { x: number; y: number }, screen: { width: number; height: number }): boolean {
  return point.x >= 0 && point.x <= screen.width && point.y >= 0 && point.y <= screen.height;
}

function nativeIdentifier(node: MobileRawNode): string | undefined {
  const value = node.identifier?.trim();
  return value !== undefined && value !== '' ? value : undefined;
}

/** Internal per-owner state. */
export interface MobileOwnerSession {
  ownerId: string;
  kind: MobileKind;
  deviceId: string;
  appId: string;
  epoch: number;
  observedAt: number;
  entries: Map<string, MobileObservedIdentity>;
  previousEntries: Map<string, MobileObservedIdentity>;
  lastObservation?: QaObservation;
}

function emptySession(ownerId: string, kind: MobileKind, deviceId: string, appId: string): MobileOwnerSession {
  return {
    ownerId,
    kind,
    deviceId,
    appId,
    epoch: 0,
    observedAt: 0,
    entries: new Map(),
    previousEntries: new Map(),
  };
}

export function rejectReceipt(code: string, reason: string): QaActionReceipt {
  return { status: 'rejected', code, reason, dispatched: false };
}

export function acceptedDispatchReceipt(code: string | undefined, reason: string): QaActionReceipt {
  return {
    status: 'unknown',
    ...(code === undefined ? {} : { code }),
    reason,
    dispatched: true,
  };
}

export abstract class MobileAdapterBase implements QaDriverAdapter {
  abstract readonly kind: MobileKind;
  readonly #sessions = new Map<string, MobileOwnerSession>();
  #disposed = false;

  protected abstract appIdFromOptions(options?: QaStartOptions): string;
  protected abstract launchApp(deviceId: string, appId: string): Promise<void>;
  protected abstract readNativeObservation(
    deviceId: string,
    options: QaObserveOptions,
    session: MobileOwnerSession,
  ): Promise<MobileNativeObservation>;
  protected abstract readNativeForeground(deviceId: string, appId: string): Promise<MobileForegroundResult>;
  protected abstract nativeTap(deviceId: string, x: number, y: number): Promise<void>;
  protected abstract nativeType(deviceId: string, text: string): Promise<void>;
  protected abstract nativeScroll(deviceId: string, direction: 'up' | 'down', amount?: number): Promise<void>;
  protected abstract nativeKey(deviceId: string, key: string): Promise<void>;
  /** Whether this platform has a safe way to type into a known focused target. */
  protected abstract canTypeSafely(session: MobileOwnerSession): boolean;

  /** Whether platform-native element-bound text is available for this mode. */
  protected supportsTargetedText(_mode: MobileTargetedTextMode): boolean {
    return false;
  }

  /**
   * Platform hook for the identifier-less selector used by target-bound text.
   * Returns the exact nonempty observed accessibility name plus a NATIVE
   * semantic editable type for a fresh unique app-owned visible nonsecure
   * editable match, or undefined when the platform/target cannot carry a
   * semantic selector. The base returns undefined: only iOS overrides this
   * (Android never reaches target-bound text), and the QA layer never
   * fabricates an identifier or falls back to coordinates/global typing.
   */
  protected semanticTextSelector(
    _fresh: MobileRawNode,
    _original: MobileObservedIdentity,
  ): { label: string; type: string } | undefined {
    return undefined;
  }

  /** Runs the platform-native element-bound text primitive selected by mode. */
  protected async runTargetedText(
    _mode: MobileTargetedTextMode,
    _target: MobileTargetedTextTarget,
  ): Promise<MobileTargetedTextResult> {
    return {
      status: 'rejected',
      dispatched: false,
      nativeAccepted: false,
      code: 'TYPING_PRIMITIVE_UNAVAILABLE',
      reason: `${this.kind} backend does not expose a native element-bound text primitive`,
    };
  }

  /**
   * Per-owner cleanup before a stop releases the lease. Implementations must
   * release exactly their own device/session scope; a failure propagates and
   * leaves the in-process device lease busy so the caller can retry stop.
   */
  protected async cleanupDeviceForStop(_session: MobileOwnerSession): Promise<void> {
    // Android/non-iOS has no per-device runtime lease to release.
  }

  protected session(ownerId: string): MobileOwnerSession | undefined {
    return this.#sessions.get(ownerId);
  }

  protected requireStarted(ownerId: string): MobileOwnerSession {
    const session = this.#sessions.get(ownerId);
    if (session === undefined) {
      const crossOwner = [...this.#sessions.values()].some((other) => other.ownerId !== ownerId && other.entries.size > 0);
      throw new QaCodeError(
        crossOwner ? 'CROSS_OWNER' : 'NOT_STARTED',
        crossOwner
          ? `no QA session is started for owner ${ownerId}; refs belong to another owner`
          : `no QA session is started for owner ${ownerId}; call start() first`,
      );
    }
    return session;
  }

  protected get disposed(): boolean {
    return this.#disposed;
  }

  async start(ownerId: string, options?: QaStartOptions): Promise<QaSessionInfo> {
    this.#assertUsable();
    const owner = ownerId.trim();
    if (owner === '') throw new TypeError('owner id must be a non-empty string');
    const deviceId = options?.deviceId?.trim() ?? '';
    if (deviceId === '') {
      throw new Error('mobile sessions require an explicit deviceId; refusing to choose a default device');
    }
    const appId = this.appIdFromOptions(options);
    const existing = this.#sessions.get(owner);
    if (existing !== undefined) {
      throw new Error(`QA owner ${owner} already has a ${this.kind} session; stop it before starting another`);
    }
    acquireLease(this.kind, deviceId, owner);
    try {
      await this.launchApp(deviceId, appId);
      this.#sessions.set(owner, emptySession(owner, this.kind, deviceId, appId));
      return { page: { url: appId, title: appId }, headless: false };
    } catch (error) {
      releaseLease(this.kind, deviceId, owner);
      throw error;
    }
  }

  async observe(ownerId: string, options?: QaObserveOptions): Promise<QaObservation> {
    this.#assertUsable();
    if (options?.withinRef !== undefined) {
      throw new Error(`the ${this.kind} driver does not support scoped observation (withinRef)`);
    }
    const session = this.requireStarted(ownerId);
    const native = await this.readNativeObservation(session.deviceId, options ?? {}, session);
    session.epoch += 1;
    session.observedAt = Date.now();
    const entries = this.#entriesFromNative(native.nodes, session.ownerId, session.epoch, session.observedAt, native.coordinateSpace, native.screen);
    session.previousEntries = new Map([...session.previousEntries, ...session.entries]);
    session.entries = entries.byRef;
    const projected = this.#projectObservation(session, native, entries.byIndex);
    session.lastObservation = projected;
    return projected;
  }

  async act(ownerId: string, action: QaAction, _approval?: never): Promise<QaActionReceipt> {
    this.#assertUsable();
    try {
      return await this.#act(ownerId, action);
    } catch (error) {
      if (error instanceof QaCodeError) {
        return rejectReceipt(error.code, error.message);
      }
      throw error;
    }
  }

  async evidence(ownerId: string, _options?: unknown): Promise<QaEvidence> {
    this.#assertUsable();
    const session = this.requireStarted(ownerId);
    let foreground: MobileForegroundResult;
    try {
      foreground = await this.readNativeForeground(session.deviceId, session.appId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      foreground = { backendKind: 'unknown', verified: false, detail: `foreground read failed: ${detail}` };
    }
    return {
      console: [],
      network: [],
      bounded: true,
      mobile: {
        kind: this.kind,
        deviceId: session.deviceId,
        appId: session.appId,
        backend: foreground.backendKind,
        foregroundVerified: foreground.verified,
        detail: foreground.detail,
      },
    };
  }

  async visualObserve(ownerId: string, options?: QaVisualObserveOptions): Promise<QaVisualCapture> {
    this.#assertUsable();
    const session = this.requireStarted(ownerId);
    const png = await this.capturePng(session.deviceId);
    return {
      driver: this.kind,
      observationFingerprint: null,
      observationId: null,
      png: png.png,
      width: png.width,
      height: png.height,
      sha256: png.sha256,
      usable: true,
      marks: 0,
      omitted: 0,
      artifactPath: png.artifactPath,
      ...(options?.fingerprint === undefined ? {} : { observationFingerprint: options.fingerprint }),
    };
  }

  async stop(ownerId: string): Promise<QaStopResult> {
    const session = this.#sessions.get(ownerId);
    if (session === undefined) return { stopped: false, reason: 'not-running' };
    try {
      await this.cleanupDeviceForStop(session);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new QaCodeError(
        `${this.kind === 'ios' ? 'IOS_STOP_CLEANUP_FAILED' : 'MOBILE_STOP_CLEANUP_FAILED'}`,
        `${this.kind} stop cleanup failed for device ${session.deviceId} (owner ${session.ownerId}): ${detail}. The in-process lease is still held; retry qa_session_stop.`,
      );
    }
    this.#sessions.delete(ownerId);
    releaseLease(this.kind, session.deviceId, session.ownerId);
    return { stopped: true, reason: 'mobile-scope-released' };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of [...this.#sessions.values()]) {
      releaseLease(this.kind, session.deviceId, session.ownerId);
    }
    this.#sessions.clear();
    await this.disposeBackend();
  }

  protected abstract capturePng(deviceId: string): Promise<{ png: Uint8Array; width: number; height: number; sha256: string; artifactPath: string }>;
  protected abstract disposeBackend(): Promise<void>;

  #assertUsable(): void {
    if (this.#disposed) throw new Error(`the ${this.kind} adapter has been disposed`);
  }

  async #act(ownerId: string, action: QaAction): Promise<QaActionReceipt> {
    const owner = ownerId.trim();
    const session = this.requireStarted(owner);
    if (session.kind !== this.kind) {
      return rejectReceipt('CROSS_OWNER', `owner ${owner} is bound to a ${session.kind} session, not this ${this.kind} adapter`);
    }
    switch (action.kind) {
      case 'navigate':
      case 'select':
      case 'hover':
        throw new Error(`the ${this.kind} driver does not support the "${action.kind}" action`);
      case 'fill':
        return this.#fillAction(session, action);
      case 'type':
        return this.#typeAction(session, action);
      case 'click':
        return this.#clickAction(session, action);
      case 'scroll':
        return this.#scrollAction(session, action);
      case 'key':
      case 'press':
        return this.#keyAction(session, action);
      case 'focus':
        return rejectReceipt('FOCUS_UNSUPPORTED', `the ${this.kind} driver has no target-bound focus action; tap the target and re-observe instead`);
      default:
        throw new Error(`unsupported ${this.kind} action kind`);
    }
  }

  #requireCurrentEntry(session: MobileOwnerSession, ref: string): MobileObservedIdentity {
    const entry = session.entries.get(ref);
    if (entry === undefined) {
      if (session.previousEntries.has(ref)) {
        throw new QaCodeError('STALE_OBSERVATION', 'the ref is from an earlier observation epoch; call observe() to re-resolve it');
      }
      const otherOwner = [...this.#sessions.values()].find((other) =>
        other !== session && (other.entries.has(ref) || other.previousEntries.has(ref)),
      );
      if (otherOwner !== undefined) {
        throw new QaCodeError('CROSS_OWNER', `the ref belongs to owner ${otherOwner.ownerId}; mobile refs are not shareable across owners`);
      }
      throw new QaCodeError('UNKNOWN_REF', 'the ref is not in the current observation');
    }
    if (Date.now() - entry.observedAt > MOBILE_REF_TTL_MS) {
      throw new QaCodeError('STALE_OBSERVATION', 'the mobile observation expired; call observe() again');
    }
    return entry;
  }

  #projectObservation(
    session: MobileOwnerSession,
    native: MobileNativeObservation,
    entries: readonly MobileObservedIdentity[],
  ): QaObservation {
    const pageTitle = native.actualAppId ?? session.appId;
    const nodes: QaSemanticNode[] = entries.map((entry) => {
      const node: QaSemanticNode = {
        ref: entry.ref,
        role: entry.role,
        name: entry.name,
        tag: entry.tag ?? '',
        ...(entry.identifier === undefined ? {} : { identifier: entry.identifier }),
        interactive: entry.interactive ?? false,
        editable: entry.editable,
        disabled: entry.disabled,
        ...(entry.parentRef === undefined ? {} : { parentRef: entry.parentRef }),
        ...(entry.secure === null ? {} : { secure: entry.secure }),
        ...(entry.value === undefined ? {} : { value: entry.value }),
      };
      return node;
    });
    return {
      page: { url: session.appId, title: pageTitle },
      nodes,
      truncated: native.truncated,
      mobile: {
        deviceId: session.deviceId,
        appId: session.appId,
        kind: this.kind,
        backend: native.backendKind,
        verified: native.verified,
        coordinateSpace: native.coordinateSpace,
        screen: { ...native.screen },
      },
      ...(native.maxNodes === undefined ? {} : { maxNodes: native.maxNodes }),
    };
  }

  #entriesFromNative(
    nodes: readonly MobileRawNode[],
    ownerId: string,
    epoch: number,
    observedAt: number,
    coordinateSpace: MobileCoordinateSpace,
    screen: { width: number; height: number },
  ): { byRef: Map<string, MobileObservedIdentity>; byIndex: MobileObservedIdentity[] } {
    const byRef = new Map<string, MobileObservedIdentity>();
    const byIndex: MobileObservedIdentity[] = [];
    const walk = (items: readonly MobileRawNode[], parentRef?: string): void => {
      for (const node of items) {
        const index = byIndex.length;
        const ref = `mob:${this.kind}:${ownerId}:${epoch}:${index}`;
        const identifier = nativeIdentifier(node);
        const identity: MobileObservedIdentity = {
          ref,
          ...(identifier === undefined ? {} : { identifier }),
          role: node.role,
          name: node.name,
          tag: node.tag,
          frame: { ...node.frame },
          enabled: node.enabled,
          disabled: node.disabled,
          editable: node.editable,
          interactive: node.interactive,
          focused: node.focused,
          secure: node.secure,
          ...(node.value === undefined ? {} : { value: node.value }),
          clickable: node.clickable,
          scrollable: node.scrollable,
          ...(parentRef === undefined ? {} : { parentRef }),
          coordinateSpace,
          screen: { ...screen },
          observedAt,
        };
        byRef.set(ref, identity);
        byIndex.push(identity);
        if (node.children !== undefined && node.children.length > 0) {
          walk(node.children, ref);
        }
      }
    };
    walk(nodes);
    return { byRef, byIndex };
  }

  #clickAction(session: MobileOwnerSession, action: Extract<QaAction, { kind: 'click' }>): Promise<QaActionReceipt> {
    return this.#coordinateAction(session, action.ref, async (deviceId, point) => {
      await this.nativeTap(deviceId, point.x, point.y);
      return acceptedDispatchReceipt(undefined, `native tap dispatched to ${this.kind} device ${deviceId}; outcome requires re-observation`);
    });
  }

  #fillAction(session: MobileOwnerSession, action: Extract<QaAction, { kind: 'fill' }>): Promise<QaActionReceipt> {
    if (this.supportsTargetedText('fill')) {
      return this.#targetedTextAction(session, action, 'fill');
    }
    return Promise.resolve(rejectReceipt(
      'FILL_PRIMITIVE_UNAVAILABLE',
      `${this.kind} mobile adapter has no safe replace primitive: native backend text input appends and cannot implement fill (replace) semantics, and no safe target-bound replace primitive is available.`,
    ));
  }

  #typeAction(session: MobileOwnerSession, action: Extract<QaAction, { kind: 'type' }>): Promise<QaActionReceipt> {
    if (this.supportsTargetedText('type')) {
      return this.#targetedTextAction(session, action, 'type');
    }
    this.#requireCurrentEntry(session, action.ref);
    if (!this.canTypeSafely(session)) {
      return Promise.resolve(rejectReceipt(
        'TYPING_PRIMITIVE_UNAVAILABLE',
        `${this.kind} mobile adapter has no safe target-bound typing primitive: raw ${this.kind === 'ios' ? 'AXe' : 'uiautomator'} observations do not prove the text will land in the requested field. Type after tapping only when focus can be verified, or use a backend primitive that binds text to a native target.`,
      ));
    }
    // Fresh tree read and re-resolution happens here before any coordinate use.
    return this.#coordinateAction(session, action.ref, async (deviceId, point) => {
      // The Android focused flag is real; this branch is reached only on
      // Android adapters. If the field is already focused the type is safe.
      // Otherwise tap first and verify with another fresh tree that the SAME
      // target is actually focused before typing.
      const before = await this.readNativeObservation(deviceId, {}, session);
      const beforeTarget = this.#findFreshTarget(session, before, action.ref);
      if (beforeTarget.secure === true) {
        throw new QaCodeError('SECURE_TARGET', 'refusing to type into a secure field');
      }
      if (beforeTarget.focused === true && !beforeTarget.disabled) {
        await this.nativeType(deviceId, action.text);
        return acceptedDispatchReceipt(undefined, `native type dispatched to focused ${this.kind} target; outcome requires re-observation`);
      }
      if (beforeTarget.focused !== false) {
        throw new QaCodeError('FOCUS_UNVERIFIED', 'the backend did not expose a known focused flag for the target; refusing unverifiable typing');
      }
      // Only Android reaches this: raw uiautomator exposes focused. Tap to focus
      // and verify with a fresh native observation before typing.
      await this.nativeTap(deviceId, point.x, point.y);
      const after = await this.readNativeObservation(deviceId, {}, session);
      const afterTarget = this.#findFreshTarget(session, after, action.ref);
      if (afterTarget.focused !== true || afterTarget.disabled || afterTarget.secure === true) {
        throw new QaCodeError('FOCUS_NOT_ESTABLISHED', 'tap was dispatched but the requested target is not verifiably focused; no text was typed');
      }
      await this.nativeType(deviceId, action.text);
      return acceptedDispatchReceipt(undefined, `native type dispatched to verified focused ${this.kind} target; outcome requires re-observation`);
    });
  }

  /**
   * Fresh owner/app/ref/unique/frame/secure validation, then a platform-native
   * target-bound text mutation. The native target carries the fresh stable
   * identifier when one exists (always preferred); only an identifier-less iOS
   * target may instead carry the exact nonempty observed accessibility name
   * plus a native semantic editable type (TextField/TextView/SearchField). No
   * fake identifier, no coordinate-only selector, no raw global type fallback.
   * This is the ONLY iOS type/fill route when the native methods are present;
   * it never sets focus.
   */
  async #targetedTextAction(
    session: MobileOwnerSession,
    action: Extract<QaAction, { kind: 'type' | 'fill' }>,
    mode: MobileTargetedTextMode,
  ): Promise<QaActionReceipt> {
    this.#requireCurrentEntry(session, action.ref);
    const native = await this.readNativeObservation(session.deviceId, {}, session);
    this.#assertNativeSession(session, native);
    const fresh = this.#findFreshTarget(session, native, action.ref);
    const original = session.entries.get(action.ref);
    if (original === undefined) throw new QaCodeError('UNKNOWN_REF', 'the ref is not in the current observation');
    if (!framesClose(original.frame, fresh.frame)) {
      throw new QaCodeError('TARGET_CHANGED', `target bounds changed from ${frameKey(original.frame)} to ${frameKey(fresh.frame)} between observations; refusing stale target`);
    }
    if (!pointInside(fresh.frame, native.screen)) {
      throw new QaCodeError('TARGET_OUT_OF_BOUNDS', `target frame ${frameKey(fresh.frame)} is not inside screen ${native.screen.width}x${native.screen.height}`);
    }
    if (!isWithinScreen(center(fresh.frame), native.screen)) {
      throw new QaCodeError('TARGET_OUT_OF_BOUNDS', 'target center is outside the device screen');
    }
    // The fresh native identifier is ALWAYS preferred. An original identifier
    // already survived #findFreshTarget (it matched by identifier or failed
    // with TARGET_CHANGED); an identifier that appeared since the observation
    // is adopted over any semantic selector. Only when NO fresh identifier
    // exists may the platform hook offer the iOS semantic selector — an exact
    // nonempty observed accessibility name plus a native semantic editable
    // type. Never a fabricated identifier, never a coordinate-only selector,
    // never a raw global typing fallback.
    const identifier = nativeIdentifier(fresh);
    const semantic = identifier === undefined ? this.semanticTextSelector(fresh, original) : undefined;
    if (identifier === undefined && semantic === undefined) {
      const code = mode === 'fill' ? 'FILL_PRIMITIVE_UNAVAILABLE' : 'TYPING_PRIMITIVE_UNAVAILABLE';
      throw new QaCodeError(
        code,
        `${this.kind} target-bound text requires a native stable accessibility identifier or, on iOS, an exact nonempty accessible name with a TextField/TextView/SearchField native semantic type; this target has none, so the primitive is unavailable and no raw fallback is used.`,
      );
    }
    const target: MobileTargetedTextTarget = {
      udid: session.deviceId,
      bundleId: session.appId,
      ...(identifier === undefined ? {} : { identifier }),
      ...(semantic === undefined ? {} : { semantic }),
      frame: { ...fresh.frame },
      text: action.text,
      ...(native.appPid === undefined ? {} : { expectedPID: native.appPid }),
      ...(fresh.secure === true ? { secure: true } : fresh.secure === false ? { secure: false } : {}),
    };
    let result: MobileTargetedTextResult;
    try {
      result = await this.runTargetedText(mode, target);
    } catch {
      throw new Error(
        `${this.kind} native target-bound text invocation failed with unknown dispatch state; treating it as thrown, not as a no-dispatch rejection`,
      );
    }
    return this.#targetedTextReceipt(result);
  }

  #targetedTextReceipt(result: MobileTargetedTextResult): QaActionReceipt {
    if (result.dispatched) {
      // Once a mutation may have been sent the QA receipt must stay unknown and
      // dispatched; never downgrade it to a no-dispatch rejection.
      return {
        status: 'unknown',
        dispatched: true,
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    }
    if (result.status === 'rejected') {
      return rejectReceipt(
        result.code ?? 'TARGETED_TEXT_REJECTED',
        result.reason ?? 'native target-bound text mutation was rejected before dispatch',
      );
    }
    return rejectReceipt(
      'TARGETED_TEXT_UNKNOWN_WITHOUT_DISPATCH',
      result.reason ?? 'native result reported neither dispatch nor an explicit no-dispatch rejection',
    );
  }

  #scrollAction(session: MobileOwnerSession, action: Extract<QaAction, { kind: 'scroll' }>): Promise<QaActionReceipt> {
    if (!('direction' in action) || action.direction === undefined) {
      return Promise.resolve(rejectReceipt(
        'UNSUPPORTED_ACTION',
        `${this.kind} mobile scroll requires a screen direction; ref-only scroll-into-view is not supported`,
      ));
    }
    if ('ref' in action && action.ref !== undefined) {
      return Promise.resolve(rejectReceipt(
        'UNSUPPORTED_ACTION',
        `${this.kind} mobile driver has no target-bound scroll primitive; use direction-only scroll`,
      ));
    }
    const direction = action.direction === 'up' ? 'up' as const : 'down' as const;
    const amount = 'amount' in action && typeof action.amount === 'number' ? action.amount : undefined;
    return this.#validatedSessionAction(session, async (deviceId) => {
      await this.nativeScroll(deviceId, direction, amount);
      return acceptedDispatchReceipt(undefined, `native scroll (${direction}) dispatched to ${this.kind} device ${deviceId}; outcome requires re-observation`);
    });
  }

  #keyAction(session: MobileOwnerSession, action: Extract<QaAction, { kind: 'key' | 'press' }>): Promise<QaActionReceipt> {
    // Key is device-level, not a coordinate-derived tree action, but it still
    // belongs to the current observation context: an action ref from another
    // owner or an expired/previous epoch is refused rather than guessed.
    this.#requireCurrentEntry(session, action.ref);
    return this.#validatedSessionAction(session, async (deviceId) => {
      await this.nativeKey(deviceId, action.key);
      return acceptedDispatchReceipt(undefined, `native key ${action.key} dispatched to ${this.kind} device ${deviceId}; outcome requires re-observation`);
    });
  }

  /**
   * Fresh native read + app/device validation, then run a coordinate-based
   * dispatch against the resolved fresh target's center.
   */
  async #coordinateAction(
    session: MobileOwnerSession,
    ref: string,
    run: (deviceId: string, point: { x: number; y: number }) => Promise<QaActionReceipt>,
  ): Promise<QaActionReceipt> {
    this.#requireCurrentEntry(session, ref);
    const native = await this.readNativeObservation(session.deviceId, {}, session);
    this.#assertNativeSession(session, native);
    const fresh = this.#findFreshTarget(session, native, ref);
    const original = session.entries.get(ref);
    if (original === undefined) throw new QaCodeError('UNKNOWN_REF', 'the ref is not in the current observation');
    if (!framesClose(original.frame, fresh.frame)) {
      throw new QaCodeError('TARGET_CHANGED', `target bounds changed from ${frameKey(original.frame)} to ${frameKey(fresh.frame)} between observations; refusing stale coordinates`);
    }
    if (!pointInside(fresh.frame, native.screen)) {
      throw new QaCodeError('TARGET_OUT_OF_BOUNDS', `target frame ${frameKey(fresh.frame)} is not inside screen ${native.screen.width}x${native.screen.height}`);
    }
    const point = center(fresh.frame);
    if (!isWithinScreen(point, native.screen)) {
      throw new QaCodeError('TARGET_OUT_OF_BOUNDS', 'target center is outside the device screen');
    }
    return run(session.deviceId, point);
  }

  /**
   * Fresh native foreground/read validation for non-coordinate actions (key).
   */
  async #validatedSessionAction(
    session: MobileOwnerSession,
    run: (deviceId: string) => Promise<QaActionReceipt>,
  ): Promise<QaActionReceipt> {
    const native = await this.readNativeObservation(session.deviceId, {}, session);
    this.#assertNativeSession(session, native);
    return run(session.deviceId);
  }

  #assertNativeSession(session: MobileOwnerSession, native: MobileNativeObservation): void {
    if (native.deviceId !== session.deviceId) {
      throw new QaCodeError('DEVICE_CHANGED', `backend observed ${native.deviceId} but session is bound to ${session.deviceId}`);
    }
    if (!native.verified) {
      const detail = native.detail === undefined ? 'no native app identity' : native.detail;
      throw new QaCodeError('APP_IDENTITY_UNVERIFIED', detail);
    }
  }

  #findFreshTarget(session: MobileOwnerSession, native: MobileNativeObservation, ref: string): MobileRawNode {
    const original = session.entries.get(ref);
    if (original === undefined) throw new QaCodeError('UNKNOWN_REF', 'the ref is not in the current observation');
    const flat: MobileRawNode[] = [];
    const flatten = (items: readonly MobileRawNode[]): void => {
      for (const item of items) {
        flat.push(item);
        if (item.children !== undefined) flatten(item.children);
      }
    };
    flatten(native.nodes);
    const stable = original.identifier;
    // Identifier-less re-resolution is the exact observed role+name pair from
    // the session's own app-owned fresh tree, never coordinates; an explicit
    // hidden claim (visible === false) disqualifies a candidate. A fabricated
    // identifier is never minted here.
    const candidates = stable === undefined
      ? flat.filter((node) => node.role === original.role && node.name === original.name && node.visible !== false)
      : flat.filter((node) => node.identifier === stable);
    if (candidates.length === 0) {
      throw new QaCodeError('TARGET_CHANGED', 'the requested target was not found in the fresh native tree');
    }
    if (candidates.length > 1) {
      throw new QaCodeError('TARGET_NOT_UNIQUE', 'the requested target is ambiguous in the fresh native tree; refusing to guess');
    }
    const fresh = candidates[0] as MobileRawNode;
    if (fresh.disabled) throw new QaCodeError('TARGET_DISABLED', 'the target is disabled in the fresh native tree');
    if (fresh.secure === true) throw new QaCodeError('SECURE_TARGET', 'refusing a coordinate-derived action on a secure field');
    return fresh;
  }
}
