// Shared internal vocabulary for the iOS/Android QA adapters. Nothing here is
// public schema; it is the adapter-internal stable identity cache entry that
// lets qa_observe refs be re-resolved against a FRESH backend tree before a
// coordinate-derived action.

export interface MobileObservedIdentity {
  /** Adapter-minted opaque ref for one observation. */
  ref: string;
  /** Stable identifier if the backend exposed one (iOS accessibilityIdentifier / Android resourceId). */
  identifier?: string;
  role: string;
  name: string;
  /** Mobile/computer convention: stable native identifier when present, otherwise empty. */
  tag?: string;
  frame: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  disabled: boolean;
  editable: boolean;
  interactive?: boolean;
  focused: boolean | null;
  secure: boolean | null;
  /** Bounded observable value when the backend exposed one and it is not secure. */
  value?: string | null;
  clickable?: boolean;
  scrollable?: boolean;
  /** Parent relationship within the SAME observation, not a durable path. */
  parentRef?: string | null;
  /** Backend-native metadata for coordinate mapping. */
  coordinateSpace: 'point' | 'display-pixels';
  screen: { width: number; height: number };
  observedAt: number;
}

/**
 * Native semantic editable types the iOS WDA element-bound text primitive
 * accepts as an identifier-less selector. This is the exact closed vocabulary
 * the sibling dsh-ios driver worker's `semantic.type` contract exposes; the
 * QA adapter never invents a type outside it and never maps a SecureTextField
 * into it.
 */
export type IosSemanticTextType = 'TextField' | 'TextView' | 'SearchField';

export const IOS_SEMANTIC_TEXT_TYPES: readonly IosSemanticTextType[] = [
  'TextField',
  'TextView',
  'SearchField',
];

export class QaCodeError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QaCodeError';
    this.code = code;
  }
}
