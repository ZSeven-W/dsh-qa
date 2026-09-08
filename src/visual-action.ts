/**
 * Shared visual-action routing for the qa_act visual fallback.
 *
 * This module is used by BOTH tool surfaces (src/tools.ts and
 * src/mcp-server.ts) so the qa_act point binding, coordinate conversion,
 * grounding call, and approval fail-closed semantics cannot drift.
 *
 * The module intentionally does NOT know model dimensions: a model reply that
 * carries unexpected pixel/dimension schema is rejected upstream by
 * src/grounding.ts / src/visual-grounding.ts. Here we only convert
 * harness/model-visible image points using TRUSTED capture metadata recorded
 * by qa_evidence, or call the injected llm/attachments seam to ground a text
 * target on a FRESH capture.
 */

import type { QaAction, QaApprovalGate, QaVisualCapture } from './session/adapter.ts';
import type { QaSession } from './session/session.ts';
import { captureLatestVisual } from './session/session.ts';
import { groundVisualTarget } from './visual-grounding.ts';
import type { QaVisualServices } from './vision.ts';

/** One stored trusted capture for coordinate conversion. */
export interface QaTrustedVisualCaptureMetadata {
  sha256: string;
  observationId: string;
  /** Native captured PNG pixel dimensions (the driver's own capture). */
  pixelWidth: number;
  pixelHeight: number;
  /**
   * When the capture was persisted through the host attachments service, the
   * dimensions the model actually saw. Absent for MCP/native-file evidence,
   * where the delivered image coordinate space is the native file.
   */
  attachmentWidth?: number;
  attachmentHeight?: number;
}

/** Runtime point in the delivered/visible image, either attachment or native. */
export interface QaImagePoint {
  x: number;
  y: number;
}

/** Provenance carried with a visual action, never a semantic proof. */
export interface QaVisualGroundingProvenance {
  source: 'model-grounding' | 'harness-point' | 'replay-grounding';
  provider?: string;
  model?: string;
  /** Model-reported advisory confidence (0..1), not proof. */
  confidence?: number;
}

export type QaVisualOp = 'click' | 'drag' | 'scroll';
export type QaVisualDirection = 'up' | 'down';
export type QaVisualAmount = 'line' | 'page' | number;

export interface QaVisualToolArgs {
  op: QaVisualOp;
  targetDescription: string;
  toDescription?: string;
  direction?: QaVisualDirection;
  amount?: QaVisualAmount;
  observationId?: string;
  captureSha256?: string;
  point?: QaImagePoint;
  to?: QaImagePoint;
}

const HEX64 = /^[a-fA-F0-9]{64}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads finite numeric x/y with inclusive bounds against a trusted dimension. */
function imagePoint(value: unknown, label: string, width: number, height: number): QaImagePoint {
  if (!isPlainObject(value)) {
    throw new Error('qa_act visual ' + label + ' must be an object with numeric x and y');
  }
  const x = value.x;
  const y = value.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('qa_act visual ' + label + ' must carry finite numeric x and y');
  }
  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('qa_act visual ' + label + ' is outside the delivered image bounds; the visual action was not dispatched');
  }
  return { x, y };
}

/**
 * Convert a model/harness-delivered image point to NATIVE capture pixels using
 * only stored trusted capture metadata. When the capture has no attachment
 * metadata the delivered image is the native PNG file, so the mapping is the
 * identity. When attachment metadata exists the conversion is
 * native = round(image / attachmentScale), where attachmentScale =
 * attachmentDimension / nativeDimension. The model can never supply a scale.
 */
export function imageToNativePoint(
  point: QaImagePoint,
  metadata: QaTrustedVisualCaptureMetadata,
  label: string,
): { x: number; y: number } {
  const sourceWidth = metadata.attachmentWidth ?? metadata.pixelWidth;
  const sourceHeight = metadata.attachmentHeight ?? metadata.pixelHeight;
  const validated = imagePoint(point, label, sourceWidth, sourceHeight);
  const scaleX = sourceWidth / metadata.pixelWidth;
  const scaleY = sourceHeight / metadata.pixelHeight;
  const native = {
    x: Math.round(validated.x / scaleX),
    y: Math.round(validated.y / scaleY),
  };
  if (
    !Number.isSafeInteger(native.x) || !Number.isSafeInteger(native.y)
    || native.x < 0 || native.y < 0
    || native.x >= metadata.pixelWidth || native.y >= metadata.pixelHeight
  ) {
    throw new Error('qa_act visual ' + label + ' maps outside the native captured window bounds; the visual action was not dispatched');
  }
  return native;
}

/** Construct the runtime QaAction (native pixels, exact capture binding). */
export function buildVisualRuntimeAction(
  op: QaVisualOp,
  capture: QaVisualCapture,
  targetDescription: string,
  nativePoint: { x: number; y: number },
  options: {
    toDescription?: string;
    nativeTo?: { x: number; y: number };
    direction?: QaVisualDirection;
    amount?: QaVisualAmount;
    provenance?: QaVisualGroundingProvenance;
  } = {},
): QaAction {
  if (capture.observationId === null || capture.observationId === '') {
    throw new Error('qa_act visual action requires a computer capture with a non-empty observationId');
  }
  return buildVisualRuntimeActionFromMetadata(op, {
    sha256: capture.sha256,
    observationId: capture.observationId,
    pixelWidth: capture.width,
    pixelHeight: capture.height,
  }, targetDescription, nativePoint, options);
}

/** Same as buildVisualRuntimeAction but for the stored trusted metadata path. */
export function buildVisualRuntimeActionFromMetadata(
  op: QaVisualOp,
  metadata: QaTrustedVisualCaptureMetadata,
  targetDescription: string,
  nativePoint: { x: number; y: number },
  options: {
    toDescription?: string;
    nativeTo?: { x: number; y: number };
    direction?: QaVisualDirection;
    amount?: QaVisualAmount;
    provenance?: QaVisualGroundingProvenance;
  } = {},
): QaAction {
  const observationId = metadata.observationId;
  if (observationId === '' ) {
    throw new Error('qa_act visual action requires a computer capture with a non-empty observationId');
  }
  const base = {
    targetDescription,
    observationId,
    captureSha256: metadata.sha256,
    point: nativePoint,
    ...(options.provenance === undefined ? {} : { grounding: options.provenance }),
  };
  if (op === 'click') return { kind: 'visual_click', ...base };
  if (op === 'drag') {
    if (options.nativeTo === undefined || options.toDescription === undefined) {
      throw new Error('qa_act visual drag requires a destination description and point');
    }
    return {
      kind: 'visual_drag',
      ...base,
      toDescription: options.toDescription,
      to: options.nativeTo,
    };
  }
  if (options.direction === undefined) {
    throw new Error('qa_act visual scroll requires direction');
  }
  return {
    kind: 'visual_scroll',
    ...base,
    direction: options.direction,
    ...(options.amount === undefined ? {} : { amount: options.amount }),
  };
}

export function validateVisualToolArgs(value: unknown): QaVisualToolArgs {
  if (!isPlainObject(value)) throw new Error('qa_act visual arguments must be an object');
  const actionValue = value.action;
  const opValue = value.op;
  let op: QaVisualOp;
  if (opValue === 'click' || opValue === 'drag' || opValue === 'scroll') {
    op = opValue;
  } else if (actionValue === 'visual_click' || actionValue === 'visual_drag' || actionValue === 'visual_scroll') {
    op = actionValue.slice('visual_'.length) as QaVisualOp;
  } else {
    throw new Error('qa_act visual op must be click, drag, or scroll');
  }
  const targetDescription = value.target_description;
  if (typeof targetDescription !== 'string' || targetDescription.trim() === '') {
    throw new Error('qa_act visual action requires a non-empty target_description');
  }
  let direction: QaVisualDirection | undefined;
  if (op === 'scroll') {
    if (value.direction !== 'up' && value.direction !== 'down') {
      throw new Error('qa_act visual scroll requires direction "up" or "down"');
    }
    direction = value.direction;
  }
  let amount: QaVisualAmount | undefined;
  if (value.amount !== undefined) {
    if (value.amount !== 'line' && value.amount !== 'page'
      && (typeof value.amount !== 'number' || !Number.isFinite(value.amount) || value.amount <= 0)) {
      throw new Error('qa_act visual amount must be line, page, or a positive number');
    }
    amount = value.amount;
  }
  const toDescription = value.to_description;
  if (op === 'drag' && (typeof toDescription !== 'string' || toDescription.trim() === '')) {
    throw new Error('qa_act visual drag requires a non-empty to_description');
  }
  const point = value.point;
  const to = value.to;
  const observationId = value.observation_id;
  const captureSha256 = value.capture_sha256;
  const trimmedToDescription = typeof toDescription === 'string' && toDescription.trim() !== ''
    ? toDescription.trim()
    : undefined;
  return {
    op,
    targetDescription: targetDescription.trim(),
    ...(trimmedToDescription === undefined ? {} : { toDescription: trimmedToDescription }),
    ...(direction === undefined ? {} : { direction }),
    ...(amount === undefined ? {} : { amount }),
    ...(isPlainObject(point) ? { point: point as unknown as QaImagePoint } : {}),
    ...(isPlainObject(to) ? { to: to as unknown as QaImagePoint } : {}),
    ...(typeof observationId === 'string' && observationId !== '' ? { observationId } : {}),
    ...(typeof captureSha256 === 'string' && HEX64.test(captureSha256) ? { captureSha256 } : {}),
  };
}

export function requireVisualPointBinding(
  args: QaVisualToolArgs,
  metadata: QaTrustedVisualCaptureMetadata,
): { point: { x: number; y: number }; to?: { x: number; y: number } } {
  if (args.point === undefined) {
    throw new Error('qa_act visual point route requires point for the supplied capture');
  }
  const point = imageToNativePoint(args.point, metadata, 'point');
  if (args.to === undefined) return { point };
  return { point, to: imageToNativePoint(args.to, metadata, 'to') };
}

/** Metadata for qa_evidence output; additive and safe. */
export interface QaVisualCaptureEvidenceInfo {
  driver: string;
  observationFingerprint: string | null;
  observationId: string | null;
  width: number;
  height: number;
  sha256: string;
  usable: boolean;
  marks: number;
  omitted: number;
  artifactPath?: string;
  /** Same as width/height for compatibility; both are native capture pixels. */
  nativeWidth: number;
  nativeHeight: number;
  attachmentWidth?: number;
  attachmentHeight?: number;
  coordinateSpace: 'native' | 'attachment';
}

export function visualCaptureMetadata(capture: QaVisualCapture): QaTrustedVisualCaptureMetadata {
  if (capture.observationId === null || capture.observationId === '') {
    throw new Error('visual capture is not bound to a computer observation; cannot use it for visual action routing');
  }
  return {
    sha256: capture.sha256,
    observationId: capture.observationId,
    pixelWidth: capture.width,
    pixelHeight: capture.height,
  };
}

/** Store trusted capture metadata keyed by SHA-256. */
export class QaVisualCaptureStore {
  readonly #metadata = new Map<string, QaTrustedVisualCaptureMetadata>();

  put(metadata: QaTrustedVisualCaptureMetadata): void {
    this.#metadata.set(metadata.sha256.toLowerCase(), metadata);
  }

  get(sha256: string): QaTrustedVisualCaptureMetadata | undefined {
    return this.#metadata.get(sha256.toLowerCase());
  }

  has(sha256: string): boolean {
    return this.get(sha256) !== undefined;
  }

  clear(): void {
    this.#metadata.clear();
  }
}

/** Bind a fresh settled visual capture, then ground a textual description. */
export async function captureAndGroundVisualTarget(
  session: QaSession,
  targetDescription: string,
  services: QaVisualServices | undefined,
  signal?: AbortSignal,
): Promise<{ capture: QaVisualCapture; nativePoint: { x: number; y: number }; grounding: QaVisualGroundingProvenance }> {
  const { capture } = await captureLatestVisual(session);
  const result = await groundVisualTarget(
    targetDescription,
    capture,
    services,
    signal === undefined ? {} : { signal },
  );
  if (!result.ok) {
    throw new Error('qa_act visual grounding failed: ' + result.reason);
  }
  return {
    capture,
    nativePoint: result.nativePoint,
    grounding: {
      source: 'model-grounding',
      ...(result.provider === '' ? {} : { provider: result.provider }),
      ...(result.model === '' ? {} : { model: result.model }),
      ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
    },
  };
}

/** Build a one-call approval gate from a trusted host approval service, if any. */
export interface QaHostApprovalService {
  request(input: {
    agent: unknown;
    toolName: string;
    callId?: string;
    reason?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface QaHostApprovalContext {
  getService?: (name: 'llm' | 'attachments' | 'approval') => unknown;
}

export function approvalGateFromHost(
  host: QaHostApprovalContext,
  exec: { agent?: { id?: unknown }; callId?: unknown; signal?: AbortSignal },
  toolName: string,
): QaApprovalGate | undefined {
  const callId = exec.callId;
  if (typeof callId !== 'string' || callId === '') return undefined;
  const raw = host.getService?.('approval');
  const service = raw as QaHostApprovalService | undefined;
  if (service === undefined || typeof service.request !== 'function') return undefined;
  const agent = exec.agent;
  return {
    async request(reason) {
      try {
        const outcome = await service.request({
          agent,
          toolName,
          callId,
          reason,
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        });
        if (outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable') {
          return outcome;
        }
        return 'unavailable';
      } catch {
        return 'unavailable';
      }
    },
  };
}

/** Validates that capture metadata was stored with a matching observation. */
export function assertCaptureBinding(
  metadata: QaTrustedVisualCaptureMetadata,
  observationId: string,
): void {
  if (metadata.observationId !== observationId) {
    throw new Error('qa_act visual capture_sha256 is not bound to observation_id ' + observationId + '; run qa_evidence visual again for the current observation');
  }
}
