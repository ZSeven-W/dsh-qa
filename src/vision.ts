// Visual-assertion seam for dsh-qa (WP9). This module never imports
// @deepseek-ai/* — it compiles and ships against a structural subset of the
// host's `llm` and `attachments` services, exactly like dsh-computer's
// vision.ts. The host supplies both services lazily via ctx.get(name); when
// either is genuinely absent the verdict degrades to 'unclear' with a stable
// reason instead of throwing.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QaVisualCapture } from './session/adapter.ts';

/** Defaults come from configuration, never hardcoded inline in the call site. */
export const DEFAULT_VISION_PROVIDER = 'deepseek-official';
export const DEFAULT_VISION_MODEL = 'deepseek-v4-flash-vision-exp';

export const VISION_MODEL_UNAVAILABLE = 'vision-model-unavailable';

export type QaVisualVerdict = 'yes' | 'no' | 'unclear';

export interface QaImageRef {
  attachmentId: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/** Structural subset of the host attachment service (dsh-attachment). */
export interface StructuralAttachmentStore {
  saveImage(input: { data: Uint8Array; mediaType: 'image/png'; name?: string }): Promise<unknown>;
}

/** Structural subset of the host llm service stream chunk. */
export interface StructuralLlmStreamChunk {
  type?: unknown;
  text?: unknown;
  blockType?: unknown;
  block?: unknown;
  reason?: { kind?: unknown; failure?: unknown };
}

/** Structural subset of the host llm service (LlmRuntime.stream). */
export interface StructuralLlmService {
  stream(options: {
    provider: string;
    model: string;
    messages: unknown[];
    signal?: AbortSignal;
    system?: string;
    temperature?: number;
    maxTokens?: number;
  }): AsyncIterable<unknown>;
}

/** Everything a visual assertion needs to capture + judge one frame. */
export interface QaVisualServices {
  attachments?: StructuralAttachmentStore;
  llm?: StructuralLlmService;
  provider?: string;
  model?: string;
  /** Directory for writing a PNG when the driver did not already persist one. */
  capturesDir?: string;
}

/** Parsed visual verdict. Never a fabricated 'yes': unparseable output -> 'unclear'. */
export interface QaVisualFinding {
  verdict: QaVisualVerdict;
  confidence: number;
  reasoning: string;
  /** Stable reason code when the verdict degraded (e.g. vision-model-unavailable). */
  reason?: string;
}

const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;

function buildPrompt(question: string): string {
  return (
    question +
    '\n\nAnswer with exactly one JSON object and nothing else. The object must have exactly ' +
    'these three fields: "verdict" is one of "yes", "no", or "unclear"; "confidence" is a ' +
    'number between 0 and 1; "reasoning" is a short string explaining the verdict.'
  );
}

/** Strips a leading/trailing markdown code fence from model output. */
function stripFence(text: string): string {
  let candidate = text.trim();
  if (candidate.startsWith(FENCE)) {
    const firstNewline = candidate.indexOf('\n');
    if (firstNewline !== -1) {
      candidate = candidate.slice(firstNewline + 1);
    } else {
      candidate = candidate.slice(FENCE.length);
    }
    if (candidate.endsWith(FENCE)) candidate = candidate.slice(0, -FENCE.length);
    candidate = candidate.trim();
  }
  return candidate;
}

/** Extracts a JSON object from possibly markdown-fenced model output. */
function extractJsonObject(text: string): string {
  const candidate = stripFence(text);
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Defensive verdict parser: any unparseable output becomes 'unclear'. */
export function parseVerdict(text: string): QaVisualFinding {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { verdict: 'unclear', confidence: 0, reasoning: '', reason: 'empty-response' };
  }
  let value: unknown;
  try {
    value = JSON.parse(extractJsonObject(trimmed));
  } catch {
    return { verdict: 'unclear', confidence: 0, reasoning: trimmed, reason: 'unparseable-output' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { verdict: 'unclear', confidence: 0, reasoning: trimmed, reason: 'unparseable-output' };
  }
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== 'yes' && verdict !== 'no' && verdict !== 'unclear') {
    const reasoning = typeof record.reasoning === 'string' ? record.reasoning : trimmed;
    return { verdict: 'unclear', confidence: 0, reasoning, reason: 'invalid-verdict' };
  }
  const rawConfidence = record.confidence;
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? clampConfidence(rawConfidence)
      : verdict === 'unclear'
        ? 0
        : 0.5;
  const reasoning = typeof record.reasoning === 'string' ? record.reasoning : '';
  return { verdict, confidence, reasoning };
}

function normalizeImageRef(value: unknown): QaImageRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('attachment service returned no image reference');
  }
  const ref = value as Record<string, unknown>;
  if (typeof ref.attachmentId !== 'string' || ref.attachmentId === '') {
    throw new Error('attachment service returned an invalid attachmentId');
  }
  const mediaType = ref.mediaType;
  if (mediaType !== 'image/png' && mediaType !== 'image/jpeg' && mediaType !== 'image/webp' && mediaType !== 'image/gif') {
    throw new Error('attachment service returned an unsupported image mediaType');
  }
  const bytes = ref.bytes;
  const width = ref.width;
  const height = ref.height;
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) throw new Error('attachment bytes must be a positive safe integer');
  if (!Number.isSafeInteger(width) || (width as number) <= 0) throw new Error('attachment width must be a positive safe integer');
  if (!Number.isSafeInteger(height) || (height as number) <= 0) throw new Error('attachment height must be a positive safe integer');
  return {
    attachmentId: ref.attachmentId,
    mediaType,
    bytes: bytes as number,
    width: width as number,
    height: height as number,
    ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
  };
}

function describeFailure(reason: unknown): string {
  if (reason === null || typeof reason !== 'object') return String(reason);
  const failure = (reason as Record<string, unknown>).failure;
  if (failure === null || typeof failure !== 'object') return JSON.stringify(reason);
  const code = (failure as Record<string, unknown>).code;
  const message = (failure as Record<string, unknown>).message;
  return String(code ?? '') + (message === undefined ? '' : ': ' + String(message));
}

/**
 * Capture the model's verdict for one frame + question. Returns 'unclear' (never
 * throws, never a fabricated 'yes') when the services are absent, persistence
 * fails, the stream errors, or the output is unparseable.
 */
export async function evaluateVisualQuestion(
  question: string,
  capture: QaVisualCapture,
  services: QaVisualServices | undefined,
): Promise<QaVisualFinding> {
  const attachments = services?.attachments;
  const llm = services?.llm;
  if (
    attachments === undefined ||
    llm === undefined ||
    typeof attachments.saveImage !== 'function' ||
    typeof llm.stream !== 'function'
  ) {
    return { verdict: 'unclear', confidence: 0, reasoning: 'vision model unavailable', reason: VISION_MODEL_UNAVAILABLE };
  }

  let ref: QaImageRef;
  try {
    ref = normalizeImageRef(await attachments.saveImage({ data: capture.png, mediaType: 'image/png', name: 'dsh-qa-visual.png' }));
  } catch (error) {
    return {
      verdict: 'unclear',
      confidence: 0,
      reasoning: 'could not persist the captured image: ' + (error instanceof Error ? error.message : String(error)),
      reason: 'image-persist-failed',
    };
  }

  const provider = services?.provider ?? DEFAULT_VISION_PROVIDER;
  const model = services?.model ?? DEFAULT_VISION_MODEL;
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: buildPrompt(question) },
        { type: 'image', attachment: ref },
      ],
    },
  ];

  let text = '';
  try {
    const stream = llm.stream({ provider, model, messages });
    for await (const raw of stream) {
      const chunk = raw as StructuralLlmStreamChunk;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
      } else if (chunk.type === 'finish' && chunk.reason !== undefined) {
        const reason = chunk.reason as { kind?: unknown };
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          throw new Error('vision model stream ' + reason.kind + ': ' + describeFailure(chunk.reason));
        }
      }
    }
  } catch (error) {
    return {
      verdict: 'unclear',
      confidence: 0,
      reasoning: 'vision model call failed: ' + (error instanceof Error ? error.message : String(error)),
      reason: 'vision-model-error',
    };
  }
  return parseVerdict(text);
}

/**
 * Resolve an on-disk artifact path for a capture. The browser driver already
 * wrote its PNG to the session captures dir, so its path is reused; a computer
 * capture is in memory and is written into capturesDir.
 */
export async function persistCaptureFile(capture: QaVisualCapture, capturesDir: string): Promise<string> {
  if (capture.artifactPath !== undefined && capture.artifactPath !== '') {
    return capture.artifactPath;
  }
  await mkdir(capturesDir, { recursive: true });
  const path = join(capturesDir, 'dsh-qa-visual-' + capture.sha256.slice(0, 16) + '.png');
  await writeFile(path, capture.png);
  return path;
}
