/**
 * Small bounded grounding helper for the future visual-action seam (WP-GRND).
 *
 * This module is deliberately host/provider free and owns no side effects: it
 * only turns a model's *grounding reply* into a strict normalized point and,
 * separately, maps a validated normalized point onto trusted native-pixel
 * coordinates supplied by the caller (a real captured frame, never the model).
 *
 * Why the strictness matters:
 *  - Model-reported image dimensions are unreliable. A real 1206x2622 native
 *    frame was reported by a model as "542x1178 native pixels" when it was
 *    asked for native pixels. So no model width/height/scale is ever read or
 *    trusted here; only the caller-provided `trustedCapture` dimensions are.
 *  - Confidence is the model's own self-assessment and is NOT proof that the
 *    grounding succeeded. We carry it through parse only, never as authority.
 */

/** Maximum raw reply length we are willing to parse (bounding hostile/huge output). */
export const MAX_GROUNDING_REPLY_LENGTH = 4096;

/** Normalized coordinate domain is inclusive 0..1000 (matches prompt schema). */
export const GROUNDING_MAX = 1000;
/** Confidence is a normalized 0..1 degree-of-belief (repo convention). */
export const CONFIDENCE_MAX = 1;

/** Stable error codes exported so callers/tests can branch without regexing messages. */
export const GROUNDING_ERR_INPUT_TOO_LARGE = 'GROUNDING_INPUT_TOO_LARGE';
export const GROUNDING_ERR_PARSE = 'GROUNDING_PARSE';
export const GROUNDING_ERR_SCHEMA = 'GROUNDING_SCHEMA';
export const GROUNDING_ERR_NON_FINITE = 'GROUNDING_NON_FINITE';
export const GROUNDING_ERR_OUT_OF_RANGE = 'GROUNDING_OUT_OF_RANGE';
export const GROUNDING_ERR_CAPTURE = 'GROUNDING_CAPTURE_DIMENSIONS';

export type GroundingErrorCode =
  | typeof GROUNDING_ERR_INPUT_TOO_LARGE
  | typeof GROUNDING_ERR_PARSE
  | typeof GROUNDING_ERR_SCHEMA
  | typeof GROUNDING_ERR_NON_FINITE
  | typeof GROUNDING_ERR_OUT_OF_RANGE
  | typeof GROUNDING_ERR_CAPTURE;

/** Stable, inspectable error thrown on every invalid grounding input. */
export class GroundingError extends Error {
  readonly code: GroundingErrorCode;

  constructor(code: GroundingErrorCode, message: string) {
    super(message);
    this.name = 'GroundingError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Parsed model grounding reply: x/y are normalized 0..1000, confidence 0..1. */
export interface GroundingReply {
  x: number;
  y: number;
  confidence: number;
}

/** Normalized point accepted by groundingToNativePoint (x/y only required). */
export interface GroundingPointLike {
  x: number;
  y: number;
  confidence?: number;
}

/** Native-pixel coordinate in the trusted capture's space. Always integers. */
export interface GroundingNativePoint {
  x: number;
  y: number;
}

/** Capture dimensions that are trusted because they come from the caller, never the model. */
export interface TrustedCapture {
  width: number;
  height: number;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * Strips AT MOST one whole markdown/tilde code fence that encloses the entire
 * trimmed input (```json ... ```, ``` ... ```, or ~~~ ... ~~~).
 *
 * Deliberately does NOT slice a JSON substring out of surrounding prose: if
 * there is prose outside a single whole-enclosing fence, or prose inside the
 * fence, JSON.parse below is the only decoder and it will reject.
 */
function stripSingleWholeFence(text: string): string {
  const trimmed = text.trim();
  const open = /^(`{3,}|~{3,})/.exec(trimmed);
  const openFence = open?.[1];
  if (!openFence) return text; // not fenced at the very start; leave as-is
  if (!trimmed.endsWith(openFence)) return text; // not entirely enclosed
  const bare = trimmed.slice(openFence.length, trimmed.length - openFence.length);

  // Multiline form: optional info string on its own first line:
  //   ```json
  //   { ... }
  //   ```
  const firstNewline = bare.indexOf('\n');
  if (firstNewline !== -1) {
    const firstLine = bare.slice(0, firstNewline).trim();
    if (/^[A-Za-z0-9_+.-]*$/.test(firstLine)) {
      const body = bare.slice(firstLine.length).trim();
      return body;
    }
  }

  // Inline/whole-fence form:  ```<lang?> { ... }```  (no required newline).
  const inline = bare.trim().match(/^[A-Za-z0-9_+.-]*(?:[ \t]+)?([\s\S]*)$/);
  return (inline?.[1] ?? bare).trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNormalizedNumber(
  source: Record<string, unknown>,
  field: string,
  maxInclusive: number,
): number {
  const value = source[field];
  if (typeof value !== 'number') {
    throw new GroundingError(
      GROUNDING_ERR_SCHEMA,
      `grounding field "${field}" must be a JSON number`,
    );
  }
  if (!Number.isFinite(value)) {
    throw new GroundingError(GROUNDING_ERR_NON_FINITE, `grounding field "${field}" must be finite`);
  }
  if (value < 0 || value > maxInclusive) {
    throw new GroundingError(
      GROUNDING_ERR_OUT_OF_RANGE,
      `grounding field "${field}" must be between 0 and ${maxInclusive} inclusive`,
    );
  }
  return normalizeZero(value);
}

function requireNumber(
  record: Record<string, unknown>,
  field: string,
  errorCode: GroundingErrorCode,
): number | undefined {
  if (!(field in record)) return undefined;
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GroundingError(errorCode, `point field "${field}" must be a finite number`);
  }
  return value;
}

function assertInRange(field: string, value: number, maxInclusive: number): void {
  if (value < 0 || value > maxInclusive) {
    throw new GroundingError(
      GROUNDING_ERR_OUT_OF_RANGE,
      `point field "${field}" must be between 0 and ${maxInclusive} inclusive`,
    );
  }
}

function validatePointLike(point: unknown): GroundingPointLike {
  if (!isPlainObject(point)) {
    throw new GroundingError(GROUNDING_ERR_SCHEMA, 'grounding point must be an object with x and y');
  }
  const xVal = requireNumber(point, 'x', GROUNDING_ERR_SCHEMA);
  const yVal = requireNumber(point, 'y', GROUNDING_ERR_SCHEMA);
  if (xVal === undefined) throw new GroundingError(GROUNDING_ERR_SCHEMA, 'grounding point is missing "x"');
  if (yVal === undefined) throw new GroundingError(GROUNDING_ERR_SCHEMA, 'grounding point is missing "y"');

  assertInRange('x', xVal, GROUNDING_MAX);
  assertInRange('y', yVal, GROUNDING_MAX);

  let confidence: number | undefined;
  if ('confidence' in point) {
    const confidenceVal = requireNumber(point, 'confidence', GROUNDING_ERR_SCHEMA);
    if (confidenceVal === undefined || !Number.isFinite(confidenceVal) || confidenceVal < 0 || confidenceVal > CONFIDENCE_MAX) {
      throw new GroundingError(
        GROUNDING_ERR_OUT_OF_RANGE,
        `point field "confidence" must be between 0 and ${CONFIDENCE_MAX} inclusive`,
      );
    }
    confidence = normalizeZero(confidenceVal);
  }

  if (confidence === undefined) {
    return { x: normalizeZero(xVal), y: normalizeZero(yVal) };
  }
  return { x: normalizeZero(xVal), y: normalizeZero(yVal), confidence };
}

function validateCapture(trustedCapture: unknown): TrustedCapture {
  if (!isPlainObject(trustedCapture)) {
    throw new GroundingError(GROUNDING_ERR_CAPTURE, 'trustedCapture must be an object with width and height');
  }
  const { width, height } = trustedCapture;
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GroundingError(GROUNDING_ERR_CAPTURE, `trustedCapture.${name} must be a finite number`);
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new GroundingError(
        GROUNDING_ERR_CAPTURE,
        `trustedCapture.${name} must be a positive safe integer; got ${String(value)}`,
      );
    }
  }
  return { width: width as number, height: height as number };
}

/**
 * Parse a strict grounding reply.
 *
 * Accepts either:
 *   - plain JSON text: `{"x":500,"y":286,"confidence":0.97}`
 *   - the same content wrapped in exactly ONE whole enclosing code fence
 *
 * Rejects arrays, null, primitive JSON, missing/extra fields (notably any
 * imageWidth/imageHeight/nativepixel schema), non-number / non-finite values,
 * out-of-range coordinates, and oversized input. Prose is never mined for an
 * embedded JSON object.
 */
export function parseGroundingReply(text: string): GroundingReply {
  if (typeof text !== 'string') {
    throw new GroundingError(GROUNDING_ERR_PARSE, 'parseGroundingReply expects a string input');
  }
  if (text.length > MAX_GROUNDING_REPLY_LENGTH) {
    throw new GroundingError(
      GROUNDING_ERR_INPUT_TOO_LARGE,
      `grounding reply exceeds ${MAX_GROUNDING_REPLY_LENGTH} characters; refusing to parse oversized input`,
    );
  }

  const candidate = stripSingleWholeFence(text).trim();
  if (candidate === '') {
    throw new GroundingError(GROUNDING_ERR_PARSE, 'grounding reply is empty after trimming');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new GroundingError(
      GROUNDING_ERR_PARSE,
      'grounding reply is not valid strict JSON (and no JSON was extracted from surrounding prose)',
    );
  }

  if (!isPlainObject(parsed)) {
    throw new GroundingError(GROUNDING_ERR_SCHEMA, 'grounding reply must be a JSON object, not array/null/primitive');
  }

  const keys = Object.keys(parsed).sort();
  const expected = ['confidence', 'x', 'y'];
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new GroundingError(
      GROUNDING_ERR_SCHEMA,
      `grounding reply must have exactly the three fields x, y, confidence; got ${JSON.stringify(Object.keys(parsed))}`,
    );
  }

  const x = readNormalizedNumber(parsed, 'x', GROUNDING_MAX);
  const y = readNormalizedNumber(parsed, 'y', GROUNDING_MAX);
  const confidence = readNormalizedNumber(parsed, 'confidence', CONFIDENCE_MAX);

  return { x, y, confidence };
}

/**
 * Map an already-normalized point (x/y in inclusive 0..1000) onto the native
 * pixel space of a caller-supplied, trusted capture.
 *
 * Mapping: round(x / 1000 * (width - 1)), likewise y, so endpoint 0 maps to
 * pixel 0 and endpoint 1000 maps to the last pixel (width-1) — both valid.
 *
 * The source point is validated AGAIN here. Dimensions come ONLY from
 * `trustedCapture`; model width/height/scale fields are never read. This
 * function performs no mutation, click, model call, or authority claim.
 */
export function groundingToNativePoint(
  point: GroundingPointLike,
  trustedCapture: TrustedCapture,
): GroundingNativePoint {
  const normalized = validatePointLike(point);
  const { width, height } = validateCapture(trustedCapture);

  const nativeX = Math.round((normalized.x / GROUNDING_MAX) * (width - 1));
  const nativeY = Math.round((normalized.y / GROUNDING_MAX) * (height - 1));
  return { x: nativeX, y: nativeY };
}

/** Optional convenience builder for a target-description prompt (no LLM here). */
export function buildGroundingPrompt(targetDescription: string, instruction = 'Return JSON.'): string {
  return (
    `Look at the provided screenshot and find the exact center of: ${String(targetDescription).trim()}\n` +
    `Reply with exactly one JSON object and nothing else. The object must have exactly three fields: ` +
    `"x" and "y" are the normalized coordinates of that center from 0 to 1000 inclusive ` +
    `(0 is the left/top edge, 1000 is the right/bottom edge), and "confidence" is a number from 0 to 1 ` +
    `expressing how sure you are. Do not include an image size, nativepixel, imageWidth, or imageHeight field. ` +
    `Confidence does not prove the tap succeeded. ${instruction}`
  );
}
