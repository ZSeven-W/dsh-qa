/**
 * Bounded visual grounding SERVICE (WP-GRND service seam).
 *
 * This module owns the service-shaped part of visual grounding:
 *  1. validates that a caller-provided capture is genuinely usable and is a
 *     real PNG whose IHDR dimensions/hash match the supplied metadata,
 *  2. persists that PNG through the injected `attachments.saveImage`,
 *  3. sends the exact text+image message shape already used by src/vision.ts,
 *  4. aborts/cleans up the provider stream on caller abort or timeout,
 *  5. parses the strict JSON grounding reply and maps it ONLY onto the trusted
 *     caller-supplied capture dimensions.
 *
 * It never performs clicks, approvals, authority claims, window/session
 * freshness checks, file/credential/config reads, or side effects beyond the
 * injected attachments.saveImage + llm.stream service calls. It never logs raw
 * image bytes, base64, or credentials.
 */

import { createHash } from 'node:crypto';
import type { QaVisualCapture } from './session/adapter.ts';
import {
  buildGroundingPrompt,
  groundingToNativePoint,
  MAX_GROUNDING_REPLY_LENGTH,
  parseGroundingReply,
  type GroundingNativePoint,
  type GroundingReply,
} from './grounding.ts';
import {
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROVIDER,
  normalizeImageRef,
  type QaImageRef,
  type QaVisualServices,
  type StructuralLlmStreamChunk,
} from './vision.ts';

/** Default timeout for a grounding provider round trip. */
export const GROUNDING_SERVICE_DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum raw model text we accumulate before failing as response-too-large. */
export const GROUNDING_SERVICE_MAX_REPLY_LENGTH = MAX_GROUNDING_REPLY_LENGTH;

/** Stable failure vocabulary (no coordinates are ever fabricated on these). */
export const GROUNDING_FAILURE_SERVICES_UNAVAILABLE = 'services-unavailable';
export const GROUNDING_FAILURE_UNUSABLE_CAPTURE = 'unusable-capture';
export const GROUNDING_FAILURE_INVALID_PNG = 'invalid-png';
export const GROUNDING_FAILURE_DIMENSION_MISMATCH = 'dimension-mismatch';
export const GROUNDING_FAILURE_SHA_MISMATCH = 'sha-mismatch';
export const GROUNDING_FAILURE_IMAGE_PERSIST_FAILED = 'image-persist-failed';
export const GROUNDING_FAILURE_INVALID_IMAGE_REF = 'invalid-image-ref';
export const GROUNDING_FAILURE_PROVIDER_STREAM_ERROR = 'provider-stream-error';
export const GROUNDING_FAILURE_INVALID_MODEL_REPLY = 'invalid-model-reply';
export const GROUNDING_FAILURE_RESPONSE_TOO_LARGE = 'response-too-large';
export const GROUNDING_FAILURE_NO_TEXT = 'no-text';
export const GROUNDING_FAILURE_TIMEOUT = 'timeout';
export const GROUNDING_FAILURE_CANCELLED = 'cancelled';

export type GroundVisualFailureReason =
  | typeof GROUNDING_FAILURE_SERVICES_UNAVAILABLE
  | typeof GROUNDING_FAILURE_UNUSABLE_CAPTURE
  | typeof GROUNDING_FAILURE_INVALID_PNG
  | typeof GROUNDING_FAILURE_DIMENSION_MISMATCH
  | typeof GROUNDING_FAILURE_SHA_MISMATCH
  | typeof GROUNDING_FAILURE_IMAGE_PERSIST_FAILED
  | typeof GROUNDING_FAILURE_INVALID_IMAGE_REF
  | typeof GROUNDING_FAILURE_PROVIDER_STREAM_ERROR
  | typeof GROUNDING_FAILURE_INVALID_MODEL_REPLY
  | typeof GROUNDING_FAILURE_RESPONSE_TOO_LARGE
  | typeof GROUNDING_FAILURE_NO_TEXT
  | typeof GROUNDING_FAILURE_TIMEOUT
  | typeof GROUNDING_FAILURE_CANCELLED;

export interface GroundVisualTargetOptions {
  /** Max ms to wait for a grounding reply. Defaults to 30_000. */
  timeoutMs?: number;
  /** Caller cancellation signal; propagated to the injected llm stream. */
  signal?: AbortSignal;
}

export interface GroundVisualTargetSuccess {
  ok: true;
  /** Model-reported normalized coordinate (0..1000) plus advisory confidence. */
  normalized: GroundingReply;
  /** The same point mapped onto the trusted capture's native pixel space. */
  nativePoint: GroundingNativePoint;
  /** Advisory self-assessment, not proof that a later action succeeded. */
  confidence: number;
  provider: string;
  model: string;
  captureSha: string;
  observationId: string | null;
}

export interface GroundVisualTargetFailure {
  ok: false;
  reason: GroundVisualFailureReason;
}

export type GroundVisualTargetResult = GroundVisualTargetSuccess | GroundVisualTargetFailure;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(reason: GroundVisualFailureReason): GroundVisualTargetFailure {
  return { ok: false, reason };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Reads IHDR width/height from actual PNG bytes, or null when not a real PNG. */
function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 8) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (bytes.byteLength < 24) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLength = view.getUint32(8, false);
  if (ihdrLength < 13) return null;
  if (bytes.byteLength < 16 + ihdrLength) return null;

  const type0 = bytes[12];
  const type1 = bytes[13];
  const type2 = bytes[14];
  const type3 = bytes[15];
  if (type0 !== 0x49 || type1 !== 0x48 || type2 !== 0x44 || type3 !== 0x52) return null;

  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function isValidCaptureMetadata(capture: unknown): capture is QaVisualCapture {
  if (!isRecord(capture)) return false;
  if (capture.usable !== true) return false;
  if (!(capture.png instanceof Uint8Array) || capture.png.byteLength === 0) return false;
  const { width, height, sha256, observationId } = capture;
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0) return false;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0) return false;
  if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) return false;
  if (observationId !== null && typeof observationId !== 'string') return false;
  return true;
}

function captureFailureReason(capture: unknown): GroundVisualFailureReason {
  if (!isRecord(capture)) return GROUNDING_FAILURE_UNUSABLE_CAPTURE;
  if (capture.usable !== true) return GROUNDING_FAILURE_UNUSABLE_CAPTURE;
  if (!(capture.png instanceof Uint8Array) || capture.png.byteLength === 0) return GROUNDING_FAILURE_INVALID_PNG;
  return GROUNDING_FAILURE_INVALID_PNG;
}

/**
 * Ground a natural-language visual target description to a normalized model
 * point and its trusted native-pixel mapping.
 *
 * Success (`ok: true`) never comes from fabricated or model-reported capture
 * dimensions. Failure (`ok: false`) carries a stable reason and never carries
 * a point.
 */
export async function groundVisualTarget(
  targetDescription: string,
  capture: QaVisualCapture,
  services: QaVisualServices | undefined,
  options: GroundVisualTargetOptions = {},
): Promise<GroundVisualTargetResult> {
  const attachments = services?.attachments;
  const llm = services?.llm;
  if (
    attachments === undefined ||
    llm === undefined ||
    typeof attachments.saveImage !== 'function' ||
    typeof llm.stream !== 'function'
  ) {
    return failure(GROUNDING_FAILURE_SERVICES_UNAVAILABLE);
  }

  const callerSignal = options.signal;
  if (isAborted(callerSignal)) {
    return failure(GROUNDING_FAILURE_CANCELLED);
  }

  if (!isValidCaptureMetadata(capture)) {
    return failure(captureFailureReason(capture));
  }

  // Validate actual bytes BEFORE any injected service side effect.
  const dims = readPngDimensions(capture.png);
  if (dims === null) return failure(GROUNDING_FAILURE_INVALID_PNG);
  if (dims.width !== capture.width || dims.height !== capture.height) {
    return failure(GROUNDING_FAILURE_DIMENSION_MISMATCH);
  }

  const hash = createHash('sha256').update(capture.png).digest('hex');
  if (hash !== capture.sha256.toLowerCase()) return failure(GROUNDING_FAILURE_SHA_MISMATCH);

  let saved: unknown;
  try {
    saved = await attachments.saveImage({
      data: capture.png,
      mediaType: 'image/png',
      name: 'dsh-qa-visual.png',
    });
  } catch {
    if (isAborted(callerSignal)) {
      return failure(GROUNDING_FAILURE_CANCELLED);
    }
    return failure(GROUNDING_FAILURE_IMAGE_PERSIST_FAILED);
  }

  if (isAborted(callerSignal)) {
    return failure(GROUNDING_FAILURE_CANCELLED);
  }

  let ref: QaImageRef;
  try {
    ref = normalizeImageRef(saved);
  } catch {
    return failure(GROUNDING_FAILURE_INVALID_IMAGE_REF);
  }

  const provider = services?.provider ?? DEFAULT_VISION_PROVIDER;
  const model = services?.model ?? DEFAULT_VISION_MODEL;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: buildGroundingPrompt(targetDescription) },
        { type: 'image', attachment: ref },
      ],
    },
  ];

  const timeoutMs =
    options.timeoutMs === undefined
      ? GROUNDING_SERVICE_DEFAULT_TIMEOUT_MS
      : Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : GROUNDING_SERVICE_DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => {
    controller.abort(new DOMException('The grounding caller aborted the request', 'AbortError'));
  };
  if (callerSignal !== undefined) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Grounding provider timed out', 'AbortError'));
  }, timeoutMs);

  let text = '';
  try {
    const stream = llm.stream({ provider, model, messages, signal: controller.signal });
    for await (const raw of stream) {
      if (controller.signal.aborted) {
        return timedOut
          ? failure(GROUNDING_FAILURE_TIMEOUT)
          : failure(GROUNDING_FAILURE_CANCELLED);
      }
      const chunk = raw as StructuralLlmStreamChunk;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
        if (text.length > GROUNDING_SERVICE_MAX_REPLY_LENGTH) {
          controller.abort(new DOMException('Grounding provider response is too large', 'AbortError'));
          return failure(GROUNDING_FAILURE_RESPONSE_TOO_LARGE);
        }
      } else if (chunk.type === 'finish' && chunk.reason !== undefined) {
        const reason = chunk.reason as { kind?: unknown };
        if (reason.kind === 'error') {
          if (controller.signal.aborted) {
            return timedOut
              ? failure(GROUNDING_FAILURE_TIMEOUT)
              : failure(GROUNDING_FAILURE_CANCELLED);
          }
          return failure(GROUNDING_FAILURE_PROVIDER_STREAM_ERROR);
        }
        if (reason.kind === 'aborted') {
          if (controller.signal.aborted) {
            return timedOut
              ? failure(GROUNDING_FAILURE_TIMEOUT)
              : failure(GROUNDING_FAILURE_CANCELLED);
          }
          return failure(GROUNDING_FAILURE_PROVIDER_STREAM_ERROR);
        }
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return timedOut
        ? failure(GROUNDING_FAILURE_TIMEOUT)
        : failure(GROUNDING_FAILURE_CANCELLED);
    }
    void error;
    return failure(GROUNDING_FAILURE_PROVIDER_STREAM_ERROR);
  } finally {
    clearTimeout(timer);
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  if (controller.signal.aborted) {
    return timedOut
      ? failure(GROUNDING_FAILURE_TIMEOUT)
      : failure(GROUNDING_FAILURE_CANCELLED);
  }
  if (text.trim() === '') {
    return failure(GROUNDING_FAILURE_NO_TEXT);
  }

  let parsed: GroundingReply;
  try {
    parsed = parseGroundingReply(text);
  } catch {
    return failure(GROUNDING_FAILURE_INVALID_MODEL_REPLY);
  }

  const nativePoint = groundingToNativePoint(parsed, { width: capture.width, height: capture.height });
  return {
    ok: true,
    normalized: parsed,
    nativePoint,
    confidence: parsed.confidence,
    provider,
    model,
    captureSha: capture.sha256,
    observationId: capture.observationId,
  };
}
