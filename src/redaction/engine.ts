// Ported from dsh-driver-bench (read-only source) at commit a7af98d
// (branch feat/v0.1), file src/redaction/engine.ts. This is the fail-closed
// v2 redaction engine (docs/REDACTION_SPEC.md). The engine body is preserved
// verbatim; only this attribution header was added. It depends solely on
// node builtins and introduces no dsh-qa-specific coupling.
//
// dsh-qa-style redaction engine for the Task 4 reporters (split phase).
// This module carries the entire text-redaction pipeline exactly as it
// evolved through the Task 4 review rounds; src/reporters/json.ts keeps only
// the lossless JSON projection, the stable serializer, and renderJson. The
// spec-driven v2 rewrite (docs/REDACTION_SPEC.md) replaces this engine in a
// separate commit and re-organizes it into tokenizer/rules/api modules.

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { types } from 'node:util'


export interface RedactionRoots {
  workspace: string
  temp: string
  artifacts: string
}

type RootKey = keyof RedactionRoots

const ROOT_KEYS: readonly RootKey[] = ['workspace', 'temp', 'artifacts']

const ROOT_ALIAS_PREFIX = '\u0001'
const ROOT_ALIAS_PREFIX_CODE = 0x01

const ALIASES: Record<RootKey, string> = {
  workspace: `${ROOT_ALIAS_PREFIX}WORKSPACE`,
  temp: `${ROOT_ALIAS_PREFIX}TMP`,
  artifacts: `${ROOT_ALIAS_PREFIX}ARTIFACTS`,
}

// Validated roots carry every redaction alias for the same placeholder: the
// caller-supplied absolute spelling (after POSIX validation, before path
// normalization), the resolved normalized spelling, plus the filesystem
// canonical realpath when the root already exists. This lets a root configured
// through a symlink alias or a non-normalized absolute spelling redact both
// that spelling and the underlying real path without weakening longest-first
// matching.
interface RootAliases {
  workspace: readonly string[]
  temp: readonly string[]
  artifacts: readonly string[]
}

interface NormalizedRedactionRoots extends RedactionRoots {
  aliases: RootAliases
}

// Task 4B4: v0.1 roots are absolute POSIX paths only. Windows-native drive
// (`C:\...`, `C:/...`) and UNC (`\\server\share`) roots are deliberately NOT
// supported in v0.1: they are detected up front and rejected fail-closed with
// an explicit boundary error, before any report/event I/O, instead of being
// half-matched through cross-platform path/file-URL behavior. A bare drive
// letter (`C:`) or any other non-POSIX-absolute value still fails the generic
// non-empty absolute path check below.
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:[\\/]/
const WINDOWS_UNC_ROOT = /^\\\\/

// Root strings are matched after the same separator normalization as ordinary
// text, so a root containing NUL or another unsafe control/format character
// could never match the normalized path and would only be echoed as a
// sanitized fragment. Reject such roots fail-closed before any report/event I/O.
// Root validation deliberately uses a stricter predicate than text
// normalization: every C0 control, including LF and CR, is rejected here.
function isUnsafeRootControlCharCode(code: number): boolean {
  return (
    code < 0x20 || // all C0 controls, including LF/CR
    (code >= 0x7f && code <= 0x9f) // DEL and C1 controls
  )
}

function hasUnsafeRootCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeRootControlCharCode(value.charCodeAt(i)) || isFormatCharacterAt(value, i)) {
      return true
    }
  }
  return false
}

function assertAbsolutePath(value: string, key: RootKey): void {
  if (WINDOWS_DRIVE_ROOT.test(value) || WINDOWS_UNC_ROOT.test(value)) {
    throw new Error(
      `redactText: roots.${key} must be an absolute POSIX path (Windows drive/UNC roots are not supported in v0.1)`,
    )
  }
  if (hasUnsafeRootCharacter(value)) {
    throw new TypeError(`redactText: roots.${key} must not contain NUL, control, or format characters`)
  }
  if (value.length === 0 || !value.startsWith('/')) {
    throw new Error(`redactText: roots.${key} must be a non-empty absolute path`)
  }
}

function normalizeRoot(value: string): string {
  const resolved = path.resolve(value)
  // On POSIX v0.1 roots, backslash is an ordinary filename character. Strip
  // only trailing path separators, not trailing backslashes.
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved
}

function isFilesystemRoot(value: string): boolean {
  return value === path.parse(value).root
}

// Returns the canonical realpath when the resolved root already exists, or
// the resolved spelling itself when it does not. Non-existent roots therefore
// match only their literal resolved spelling, as documented.
function canonicalRootPath(resolved: string): string {
  try {
    return normalizeRoot(realpathSync(resolved))
  } catch {
    return resolved
  }
}

function buildRootAliases(normalized: RedactionRoots, supplied: RedactionRoots): RootAliases {
  const aliases = {} as RootAliases
  for (const key of ROOT_KEYS) {
    const resolved = normalized[key]
    const canonical = canonicalRootPath(resolved)
    const spelling = supplied[key]
    const unique = new Set<string>([resolved])
    if (canonical !== resolved) {
      unique.add(canonical)
    }
    if (spelling !== resolved) {
      unique.add(spelling)
    }
    aliases[key] = [...unique]
  }
  return aliases
}

function validateRoots(roots: unknown): NormalizedRedactionRoots {
  if (roots === null || typeof roots !== 'object') {
    throw new TypeError('redactText: roots must be an object')
  }
  // Reject caller-supplied Proxy roots before any trap can run. The roots
  // object is only a safe source when its own data descriptors can be read
  // without invoking user code, and util.types.isProxy performs no trap.
  if (types.isProxy(roots)) {
    throw new TypeError('redactText: roots must be a plain object, not a Proxy')
  }
  if (Array.isArray(roots)) {
    throw new TypeError('redactText: roots must be an object')
  }
  const record = roots as Record<RootKey, unknown>
  const normalized = {} as NormalizedRedactionRoots
  const supplied = {} as RedactionRoots
  for (const key of ROOT_KEYS) {
    // Read only the own property descriptor so inherited values are rejected
    // and accessor getters/setters are never invoked. Only a plain data
    // property is a safe root source; any accessor fails closed before I/O.
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor === undefined) {
      throw new TypeError(`redactText: roots.${key} must be a string`)
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(
        `redactText: roots.${key} must be a plain data property, not an accessor`,
      )
    }
    if (!('value' in descriptor)) {
      throw new TypeError(`redactText: roots.${key} must be a string`)
    }
    const value = descriptor.value
    if (typeof value !== 'string') {
      throw new TypeError(`redactText: roots.${key} must be a string`)
    }
    assertAbsolutePath(value, key)
    supplied[key] = value
    normalized[key] = normalizeRoot(value)
    if (isFilesystemRoot(normalized[key])) {
      throw new Error(`redactText: roots.${key} must not be a filesystem root`)
    }
  }
  const canonical = {} as RedactionRoots
  for (const key of ROOT_KEYS) {
    canonical[key] = canonicalRootPath(normalized[key])
  }
  if (canonical.workspace === canonical.temp) {
    throw new Error('redactText: ambiguous roots: roots.temp duplicates roots.workspace')
  }
  if (canonical.temp === canonical.artifacts) {
    throw new Error('redactText: ambiguous roots: roots.artifacts duplicates roots.temp')
  }
  if (canonical.workspace === canonical.artifacts) {
    throw new Error('redactText: ambiguous roots: roots.artifacts duplicates roots.workspace')
  }
  normalized.aliases = buildRootAliases(normalized, supplied)
  return normalized
}

// Unsafe control separators (C0 except LF, DEL/C1, line/paragraph
// separators, zero-width/BOM marks, and every other Unicode format
// character) are replaced with safe spaces before credential detection so
// that e.g. `Bearer<TAB>abc123`, `Bearer<ZWSP>abc123`, or
// `Bearer<SOFT HYPHEN>abc123` never concatenate into `Bearerabc123`.
// Inside an otherwise-intact http(s)/file URL token they are dropped instead,
// so a control cannot split the scheme/authority and leave userinfo in plain
// text. Ordinary newlines survive and CRLF is normalized to LF. Runs of unsafe
// separators (including any adjacent ordinary spaces) collapse to a single
// space without joining tokens, while plain prose spacing is untouched.
function isUnsafeControlCharCode(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a) || // C0 controls except LF (tab, CR, ESC, ...)
    (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x200b || // zero-width space
    code === 0x200c || // zero-width non-joiner
    code === 0x200d || // zero-width joiner
    code === 0xfeff // byte order mark / zero-width no-break space
  )
}

const FORMAT_CHARACTER = /\p{Cf}/u

// Internal stand-in for unsafe separators during the redaction pipeline.
// Normalization replaces unsafe controls/format characters with this sentinel
// (instead of a plain space) so scanners can treat it as token-joining
// material inside sensitive words, keys, schemes, and roots. The sentinel is
// mapped to the approved output spelling (a plain space) only at the very end
// of redactTextWithRoots, so final bytes keep today's normalization contract.
const SEPARATOR_SENTINEL = '\u0000'
const SEPARATOR_SENTINEL_CODE = 0

function isSeparatorSentinelCode(code: number): boolean {
  return code === SEPARATOR_SENTINEL_CODE
}

function isSeparatorSentinel(ch: string | undefined): boolean {
  return ch === SEPARATOR_SENTINEL
}

// Unicode format characters (\p{Cf}: soft hyphen, Arabic letter mark,
// Mongolian vowel separator, LRM/RLM, directional embeddings, word joiner,
// and every other zero-width format mark) are unsafe separators too. The
// property regex is evaluated per code point so supplementary format
// characters (surrogate pairs) are caught as well; ASCII is short-circuited
// to keep large plain-text scans allocation-free.
function isFormatCharacterAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  if (code < 0x80) {
    return false
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      const codePoint = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
      return FORMAT_CHARACTER.test(String.fromCodePoint(codePoint))
    }
    return false
  }
  if (code >= 0xdc00 && code <= 0xdfff) {
    return false
  }
  return FORMAT_CHARACTER.test(String.fromCharCode(code))
}

// URL-shape helpers retained from v1 for separator normalization only: they
// let normalizeSeparators DROP control bytes inside an intact URL token so
// R1 still recognizes the scheme:// shape (v2 redacts the whole span either
// way; dropping only prevents the scheme from being split before detection).
function isUrlSchemeGap(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 8), index).toLowerCase()
  const after = text.slice(index + 1, index + 9).toLowerCase()
  return (
    (before.endsWith('http') || before.endsWith('https') || before.endsWith('file')) &&
    after.startsWith('://')
  )
}

function isUrlSchemeComplete(recent: string): boolean {
  return recent.includes('http://') || recent.includes('https://') || recent.includes('file://')
}

function isUrlDelimiterCode(code: number): boolean {
  return (
    code === 0x22 ||
    code === 0x27 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x60 ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x7b ||
    code === 0x7d ||
    // Path separators delimit filesystem paths (root aliases and their
    // children are trusted output); credential blobs spanning slashes are
    // still caught segment-by-segment.
    code === 0x2f
  )
}

function normalizeSeparators(text: string): string {
  let result = ''
  let unsafeRun = false
  let urlActive = false
  let recent = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const ch = text[i] ?? ''
    if (code === 0x0a) {
      if (unsafeRun) {
        result += SEPARATOR_SENTINEL
        unsafeRun = false
      }
      urlActive = false
      result += '\n'
      recent = (recent + '\n').slice(-8)
    } else if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
      // CRLF: drop the CR, the LF is emitted on the next iteration.
      urlActive = false
    } else if (isUnsafeControlCharCode(code) || isFormatCharacterAt(text, i)) {
      // A control/format character inside a URL token is DROPPED (not
      // sentinel-ized) so R1 still sees the intact scheme:// shape; elsewhere
      // it becomes joining material via the sentinel run below.
      if (urlActive || isUrlSchemeGap(text, i)) {
        if (code >= 0xd800 && code <= 0xdbff) {
          i += 1
        }
      } else {
        unsafeRun = true
        if (code >= 0xd800 && code <= 0xdbff) {
          i += 1
        }
      }
    } else if (code === 0x20) {
      if (urlActive) {
        urlActive = false
      }
      if (!unsafeRun) {
        result += ch
        recent = (recent + ch).slice(-8)
      }
    } else {
      if (urlActive && isUrlDelimiterCode(code)) {
        urlActive = false
      }
      if (unsafeRun) {
        result += SEPARATOR_SENTINEL
        unsafeRun = false
      }
      result += ch
      recent = (recent + ch).slice(-8)
      if (!urlActive && isUrlSchemeComplete(recent)) {
        urlActive = true
      }
    }
  }
  if (unsafeRun) {
    result += SEPARATOR_SENTINEL
  }
  return result
}

// A split URL credential can hide when a delimiter (whitespace, quote,
// backtick, `<`/`>`) appears between non-empty userinfo and the `@` that
// completes the authority: the normal URL token scanners stop at that
// delimiter before ever seeing `@`, so `http://user:pass\nfoo@host/path` used
// to survive verbatim. This fail-closed pre-pass recognizes the scheme plus
// delimiter run plus non-empty userinfo plus the first `@` that still belongs
// to the same logical URL tail, including any intervening text after the
// delimiter. For http(s) it either replaces just the userinfo while preserving
// an immediate delimiter spelling, or drops intervening userinfo material and
// keeps the delimiter plus `@`; file URLs are rewritten as if the split were
// contiguous using the established file userinfo rules. The lookahead stops at
// the next `/`, `?`, `#`, or `://` scheme start, so complete URLs and ordinary
// prose are not swept into a later URL.
interface TrailingPunctuationSplit {
  core: string
  trailing: string
}

// Extracts the maximal trailing run of characters matching `isPunctuation`
// with a single backward scan and returns `{ core, trailing }`. The semantics
// match `/[class]+$/` exactly: when the final character is not in the class
// the trailing run is empty and the whole text is the core; otherwise the
// trailing run is the maximal suffix of in-class characters. A long in-class
// run followed by a non-class final character is scanned once from the end,
// so redaction stays linear instead of the anchored regex's quadratic
// backtracking, and no substring is ever rescanned from every position.
function splitTrailingPunctuation(
  text: string,
  isPunctuation: (code: number) => boolean,
): TrailingPunctuationSplit {
  let start = text.length
  while (start > 0 && isPunctuation(text.charCodeAt(start - 1))) {
    start -= 1
  }
  return { core: text.slice(0, start), trailing: text.slice(start) }
}

// Trailing prose delimiters are peeled from URL tokens so sentence
// punctuation stays outside the sanitized core. `?`/`#` are deliberately
// excluded: an empty query/fragment must never be reattached.
function isHexDigitCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x46) || // A-F
    (code >= 0x61 && code <= 0x66) // a-f
  )
}

// Best-effort percent-decoder used only for fail-closed authority analysis.
// It decodes valid percent-encoded octets, leaves malformed escapes literal,
// and drops NUL octets instead of failing the whole decode. This is bounded
// and linear: each valid percent-triplet run is decoded by decodeURIComponent,
// and any run that is not valid UTF-8 is copied verbatim.
function decodeBestEffort(value: string): string {
  let result = ''
  let i = 0
  while (i < value.length) {
    if (
      value.charCodeAt(i) === 0x25 && // %
      i + 2 < value.length &&
      isHexDigitCode(value.charCodeAt(i + 1)) &&
      isHexDigitCode(value.charCodeAt(i + 2))
    ) {
      const start = i
      let j = i + 3
      while (
        j + 2 < value.length &&
        value.charCodeAt(j) === 0x25 &&
        isHexDigitCode(value.charCodeAt(j + 1)) &&
        isHexDigitCode(value.charCodeAt(j + 2))
      ) {
        j += 3
      }
      const encoded = value.slice(start, j)
      let decoded = encoded
      try {
        decoded = decodeURIComponent(encoded)
      } catch {
        // Malformed UTF-8 stays literal; the next pass still sees the raw
        // percent-triplet run as non-secret and idempotent.
      }
      if (decoded.includes('\u0000')) {
        decoded = decoded.replaceAll('\u0000', '')
      }
      result += decoded
      i = j
    } else {
      result += value[i] ?? ''
      i += 1
    }
  }
  return result
}

// Finds the end of the last authority userinfo delimiter whether it is
// literal or percent-encoded as `%40`. `%40` has no case variants, but the
// decoded-form check below still runs through the bounded decoder so
// malformed escapes do not hide an encoded `@`.
function isRootAfterPeriodBoundary(code: number): boolean {
  return (
    isAuthWhitespaceCode(code) ||
    code === 0x22 || // "
    code === 0x27 || // '
    code === 0x60 || // `
    code === 0x3c || // <
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x3a || // :
    code === 0x21 || // !
    code === 0x3f || // ?
    code === 0x29 || // )
    code === 0x5d || // ]
    code === 0x7d // }
  )
}

// A root boundary may be a path separator, end of input, whitespace,
// quotes/backticks, Markdown emphasis/glob delimiters, or common
// closing/punctuation delimiters (including "#" and "<"). Any other character
// (a path-segment continuation) leaves the raw prefix untouched. Underscore is
// handled separately because it is also a word character: a `_` boundary is
// valid only when the run of underscores is not glued to a word character on
// its outside edge.
function isRootFollowingBoundaryChar(code: number): boolean {
  return (
    code === 0x2f || // /
    code === 0x23 || // #
    code === 0x27 || // '
    code === 0x22 || // "
    code === 0x60 || // `
    code === 0x2a || // *
    code === 0x7e || // ~
    code === 0x2b || // +
    isAuthWhitespaceCode(code) ||
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x3a || // :
    code === 0x21 || // !
    code === 0x3f || // ?
    code === 0x3c || // <
    code === 0x29 || // )
    code === 0x5d || // ]
    code === 0x7d || // }
    code === 0x3e // >
  )
}

function isRootFollowingBoundary(text: string, end: number): boolean {
  if (end >= text.length) {
    return true
  }
  const code = text.charCodeAt(end)
  if (code === 0x2e) {
    // A terminal "." redacts only when the char after it is terminal prose
    // punctuation or end of input (see isRootAfterPeriodBoundary).
    return end + 1 >= text.length || isRootAfterPeriodBoundary(text.charCodeAt(end + 1))
  }
  if (code === 0x5f) {
    // `_root_` and `__root__` are Markdown emphasis pairs, but `run_x` and
    // `run__x` are sibling path continuations. The whole underscore run must
    // not be directly followed by a word character.
    let p = end
    while (p < text.length && text.charCodeAt(p) === 0x5f) {
      p += 1
    }
    return p >= text.length || !isAsciiWordCharCode(text.charCodeAt(p))
  }
  return isRootFollowingBoundaryChar(code)
}

// Proven plain boundaries that may precede a root in plain text: whitespace,
// quotes/backticks, opening delimiters, Markdown emphasis/glob delimiters,
// `=`/`:` separators, plain-list separators (`,`/`;`), and closers (`)`, `]`,
// `}`, `>`). The caller only applies this to characters that are themselves
// outside every URL/file token (see redactRoots), so URL path content can
// never masquerade as a boundary.
function isRootPrecedingBoundary(code: number): boolean {
  return (
    isAuthWhitespaceCode(code) ||
    code === 0x22 || // "
    code === 0x27 || // '
    code === 0x60 || // `
    code === 0x2a || // *
    code === 0x7e || // ~
    code === 0x2b || // +
    code === 0x23 || // #
    code === 0x3f || // ?
    code === 0x21 || // !
    code === 0x28 || // (
    code === 0x5b || // [
    code === 0x7b || // {
    code === 0x3c || // <
    code === 0x3d || // =
    code === 0x3a || // :
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x29 || // )
    code === 0x5d || // ]
    code === 0x7d || // }
    code === 0x3e // >
  )
}

// Text-aware preceding boundary: `_root_` and `__root__` are valid Markdown
// pairs, but `x_root` or `x__root` are word-glued continuations. The whole
// underscore run must not be directly preceded by a word character, and it
// must not start before the current plain-text region (which would make the
// outside a protected URL/file token rather than proven plain text).
function isRootPrecedingBoundaryAt(text: string, index: number, regionStart: number): boolean {
  const code = text.charCodeAt(index)
  if (code !== 0x5f) {
    return isRootPrecedingBoundary(code)
  }
  let p = index
  while (p >= regionStart && text.charCodeAt(p) === 0x5f) {
    p -= 1
  }
  if (p < regionStart) {
    return regionStart === 0
  }
  return !isAsciiWordCharCode(text.charCodeAt(p))
}

interface RootEntry {
  key: RootKey
  path: string
}

interface RootMatch {
  key: RootKey
  end: number
}

function rootEntries(roots: NormalizedRedactionRoots): RootEntry[] {
  const entries: RootEntry[] = []
  for (const key of ROOT_KEYS) {
    for (const path of roots.aliases[key]) {
      entries.push({ key, path })
    }
  }
  return entries.sort((left, right) => right.path.length - left.path.length)
}

// Returns the exclusive end index when `text[position..]` starts with
// `prefix`, ignoring internal separator sentinels in the text. The sentinel
// is transparent inside a root path, so `/private\x00/tmp/run/x` still
// matches `/private/tmp/run`. Returns -1 when there is no match.
function startsWithIgnoringSentinelEndAt(text: string, position: number, prefix: string): number {
  let p = position
  for (let k = 0; k < prefix.length; k++) {
    while (p < text.length && isSeparatorSentinelCode(text.charCodeAt(p))) {
      p += 1
    }
    if (p >= text.length || text.charCodeAt(p) !== prefix.charCodeAt(k)) {
      return -1
    }
    p += 1
  }
  return p
}

// Tries every configured root at `position` (longest first, so nested roots
// redact deepest-first) and returns the longest match whose following
// boundary holds. One sentinel-aware prefix scan per candidate keeps the
// scan linear. The preceding boundary is checked by the caller, which knows
// whether the char before the root is proven plain text.
function findRootAt(text: string, position: number, entries: readonly RootEntry[]): RootMatch | null {
  for (const entry of entries) {
    const end = startsWithIgnoringSentinelEndAt(text, position, entry.path)
    if (
      end >= 0 &&
      isRootFollowingBoundary(text, end)
    ) {
      return { key: entry.key, end }
    }
  }
  return null
}

// Task 4A1-Q: redacts configured roots inside a decoded file URL pathname at
// exact root/child boundaries. The root must start at the pathname start or
// directly after a `/` and be followed by a child boundary (`/`, end of
// input, or safe trailing punctuation), so `/private/tmp/run/../x` redacts
// while sibling prefixes (`/private/tmp/run2/...`) and partial suffixes
// (`.txt`) never match, exactly like the plain-text guard. Longest-first
// matching mirrors the plain-text root pass, so nested roots redact
// deepest-first. One monotonic forward pass with one native `startsWith` per
// candidate per segment boundary keeps the scan linear in the pathname
// length.
function redactRoots(text: string, roots: NormalizedRedactionRoots): string {
  const entries = rootEntries(roots)
  let result = ''
  let lastCopied = 0
  let p = 0
  const length = text.length
  while (p < length) {
    if (text.charCodeAt(p) === 0x2f) {
      let boundaryOk = false
      if (p === 0) {
        boundaryOk = true // start of input
      } else {
        boundaryOk = isRootPrecedingBoundaryAt(text, p - 1, 0)
      }
      if (boundaryOk) {
        const match = findRootAt(text, p, entries)
        if (match !== null) {
          result += text.slice(lastCopied, p)
          result += ALIASES[match.key]
          p = match.end
          lastCopied = p
          continue
        }
      }
    }
    p += 1
  }
  result += text.slice(lastCopied)
  return result
}

// Case-insensitive bearer/basic schemes are located with a deterministic
// linear scanner: find the scheme word, advance a single index across
// whitespace, an optional ":" or "=" separator, and more whitespace, then
// consume the bounded token68 grammar (RFC 6750 `~` plus JWT dot segments
// and Basic base64, leaving sentence punctuation in place). When the
// candidate token is itself a bearer/basic scheme word that begins a valid
// following scheme phrase (`bearer Basic dXNlcjpwYXNz`), the scan resumes
// monotonically at the nested scheme word so the real token below it is
// redacted and the scheme word is never mistaken for the credential.
// Adjacent overlapping `\s+`/`\s*` quantifiers are never used, so
// pathological whitespace runs (e.g. `bearer` followed by 100,000 spaces)
// scan in linear
// time instead of backtracking quadratically.
const BEARER_SCHEMES: ReadonlyArray<readonly [scheme: string, length: number]> = [
  ['bearer', 6],
  ['basic', 5],
]

function matchesAsciiWordAt(text: string, index: number, word: string): boolean {
  const length = word.length
  if (index + length > text.length) {
    return false
  }
  for (let k = 0; k < length; k++) {
    const code = text.charCodeAt(index + k)
    const target = word.charCodeAt(k)
    // ASCII case-insensitive comparison.
    if (code !== target && code !== target - 0x20) {
      return false
    }
  }
  return true
}

// Sentinel-aware ASCII word matcher for sensitive scanner contexts (bearer/
// basic scheme phrases and authorization header keys). Unsafe controls were
// normalized to SEPARATOR_SENTINEL, so a sensitive word such as
// `Bea\x00rer` must still be recognized as `bearer`; the sentinel is
// transparent inside the word. Returns the exclusive end index after the
// matched word, including any skipped sentinels, or -1 when there is no
// match.
function matchesAsciiWordIgnoringSentinelEndAt(
  text: string,
  index: number,
  word: string,
  allowWhitespace = false,
): number {
  let p = index
  for (let k = 0; k < word.length; k++) {
    if (k > 0) {
      // Sentinels inside a word are transparent (`Bea\x00rer` -> `bearer`),
      // but a leading sentinel is a separator, not part of the word. With
      // allowWhitespace, ordinary whitespace is transparent too so an auth
      // scheme word split across inserted whitespace/newlines (`Bea  \n rer`)
      // still reassembles (spec 1.2 separator insertion inside auth phrases).
      while (
        p < text.length &&
        (allowWhitespace
          ? isAuthWhitespaceCode(text.charCodeAt(p))
          : isSeparatorSentinelCode(text.charCodeAt(p)))
      ) {
        p += 1
      }
    }
    if (p >= text.length) {
      return -1
    }
    const code = text.charCodeAt(p)
    const target = word.charCodeAt(k)
    if (code !== target && code !== target - 0x20) {
      return -1
    }
    p += 1
  }
  return p
}

function matchesAuthSchemeAt(text: string, index: number, scheme: string): boolean {
  return matchesAsciiWordIgnoringSentinelEndAt(text, index, scheme) >= 0
}

function authSchemeLengthAt(text: string, index: number): number {
  for (const entry of BEARER_SCHEMES) {
    const end = matchesAsciiWordIgnoringSentinelEndAt(text, index, entry[0], true)
    if (end >= 0) {
      return end - index
    }
  }
  return 0
}

function isAsciiWordCharCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  )
}

// Text-aware scheme boundary for Bearer/Basic scans. Ordinary word characters
// never precede a scheme. Underscore is a word character too, but it also
// starts Markdown emphasis/strong delimiters: `_Bearer secret_` and
// `__Bearer secret__` are legitimate wrapped schemes, while `my_Bearer secret`
// or `run__Bearer secret` are identifier/path continuations. A single `_` is a
// boundary only when a later non-glued `_` can close the emphasis pair; a
// doubled `__` opener is accepted on its own (matching the root redactor's
// underscore-run boundary semantics). Closing underscores are not considered
// valid when they are directly glued to a word character on their right.
function findSchemeClosingUnderscoreAt(text: string, index: number): number {
  if (index === 0 || text.charCodeAt(index - 1) !== 0x5f) {
    return -1
  }
  let p = index - 1
  while (p >= 0 && text.charCodeAt(p) === 0x5f) {
    p -= 1
  }
  if (p >= 0 && isAsciiWordCharCode(text.charCodeAt(p))) {
    return -1
  }
  const openerLength = index - 1 - p
  for (let q = index; q < text.length; q++) {
    if (text.charCodeAt(q) !== 0x5f) {
      continue
    }
    let r = q
    while (r < text.length && text.charCodeAt(r) === 0x5f) {
      r += 1
    }
    if (r < text.length && isAsciiWordCharCode(text.charCodeAt(r))) {
      continue
    }
    const runLength = r - q
    if (openerLength === 1 ? runLength === 1 : runLength >= 2) {
      return q
    }
  }
  return -1
}

function isSchemePrecedingBoundaryAt(text: string, index: number): boolean {
  if (index === 0) {
    return true
  }
  const code = text.charCodeAt(index - 1)
  if (code !== 0x5f) {
    return !isAsciiWordCharCode(code)
  }
  let p = index - 1
  while (p >= 0 && text.charCodeAt(p) === 0x5f) {
    p -= 1
  }
  if (p >= 0 && isAsciiWordCharCode(text.charCodeAt(p))) {
    return false
  }
  const runLength = index - 1 - p
  if (runLength >= 2) {
    return true
  }
  return findSchemeClosingUnderscoreAt(text, index) >= 0
}

function isAsciiKeyCharCode(code: number): boolean {
  return isAsciiWordCharCode(code) || code === 0x2d // -
}

// Hex value of an ASCII hex digit, or -1 for any other character.
function hexDigitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30 // 0-9
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10 // A-F
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10 // a-f
  }
  return -1
}

// Safe structural assignment boundaries/openers that may separate an encoded
// octet from a quoted key: `{`, `[`, `,`, `;`, `:` and the justified closers
// `}`, `]`, `)`. When URL canonicalization (or pre-encoded input) emits one of
// these as a complete `%HH` sequence directly before a quoted key
// (`http://m/x,token=abc{"token": ...` -> `...%7B"token": ...`), the encoded
// octet must act as a structural boundary, not as word glue. Any other decoded
// byte (letters, digits, quotes, spaces, ...) stays word glue and the quoted
// key is deliberately not recognized.
function isEncodedStructuralBoundaryAt(text: string, index: number): boolean {
  if (index < 3) {
    return false
  }
  const high = hexDigitValue(text.charCodeAt(index - 2))
  const low = hexDigitValue(text.charCodeAt(index - 1))
  if (high < 0 || low < 0 || text.charCodeAt(index - 3) !== 0x25) {
    return false // not a complete `%HH` ending at `index`
  }
  const byte = high * 16 + low
  return (
    byte === 0x7b || // {
    byte === 0x5b || // [
    byte === 0x2c || // ,
    byte === 0x3b || // ;
    byte === 0x3a || // :
    byte === 0x7d || // }
    byte === 0x5d || // ]
    byte === 0x29 // )
  )
}

// Matches the JavaScript `\s` character class exactly (tab, LF, VT, FF, CR,
// space, NBSP, Ogham space mark, en/em/quads, LS/PS, NNBSP, MMSP, ideographic
// space, and BOM) plus the internal separator sentinel. After separator
// normalization most of the JS whitespace is already collapsed to sentinels
// or plain spaces, but the scanner still honors the full class so behavior
// matches the previous regex; the sentinel acts as a space in separator/boundary
// positions while token scanners additionally consume it as joining material.
function isAuthWhitespaceCode(code: number): boolean {
  return (
    isSeparatorSentinelCode(code) ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0b ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

function skipAuthWhitespace(text: string, index: number): number {
  let i = index
  while (i < text.length && isAuthWhitespaceCode(text.charCodeAt(i))) {
    i += 1
  }
  return i
}

function isAuthTokenCharCode(code: number): boolean {
  return (
    isSeparatorSentinelCode(code) || // internal joining material
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x5f || // _
    code === 0x3d || // =
    code === 0x2d || // -
    code === 0x7e // ~ (RFC 6750 token68)
  )
}

// Consumes `[A-Za-z0-9+/_=~-]+(?:\.[A-Za-z0-9+/_=~-]+)*` and returns the end
// index (exclusive). A dot is only part of the token when a non-empty
// segment follows, mirroring the previous regex grammar.
function scanAuthToken(text: string, start: number): number {
  let i = start
  const length = text.length
  while (i < length && isAuthTokenCharCode(text.charCodeAt(i))) {
    i += 1
  }
  if (i === start) {
    return start
  }
  for (;;) {
    if (i >= length || text.charCodeAt(i) !== 0x2e) {
      return i
    }
    let j = i + 1
    while (j < length && isAuthTokenCharCode(text.charCodeAt(j))) {
      j += 1
    }
    if (j === i + 1) {
      return i // lone dot: leave it outside the token
    }
    i = j
  }
}

interface QuotedAuthTokenScan {
  end: number
  closed: boolean
}

// A character directly after a quoted credential's closing quote is a safe
// value boundary when it is whitespace, a quote, a chain/assignment or prose
// delimiter, a structural delimiter, or the proven outer container closer.
// Any other immediately following byte is glued to the credential unit and
// must be consumed with the redaction rather than echoed after the marker.
function isQuotedCredentialTailBoundaryCode(code: number, stopCode?: number): boolean {
  return (
    isAuthWhitespaceCode(code) ||
    code === 0x22 || // "
    code === 0x27 || // '
    isChainDelimiterCode(code) ||
    code === 0x5b || // [
    code === 0x5d || // ]
    code === 0x7b || // {
    code === 0x7d || // }
    code === 0x3e || // >
    isCredentialTrailingPunctuationCode(code) ||
    (stopCode !== undefined && code === stopCode)
  )
}

// Scans a quoted bearer/basic credential token starting at `start` (which is
// the opening quote). A backslash escapes the next character; an unescaped
// newline is ordinary quoted content and is crossed until the matching
// closing quote or the end of input, so no byte inside a multi-line quoted
// credential is ever left behind for a later scanner to echo. A quote that is
// immediately followed by a non-boundary byte (for example `"abc"def` or the
// apostrophe in `'it's secret'`) is not treated as the final closing quote:
// if a later matching quote is followed by a boundary it becomes the true
// closer; otherwise the first candidate closes and only its directly glued
// non-boundary tail is consumed, so whitespace- or separator-delimited
// following content stays outside the credential unit.
function scanQuotedAuthTokenEnd(text: string, start: number, quote: string): QuotedAuthTokenScan {
  const length = text.length
  let i = start + 1
  let candidateEnd = -1
  while (i < length) {
    const code = text.charCodeAt(i)
    if (code === 0x5c) {
      // Backslash escape: skip the escaped character.
      if (i + 1 < length) {
        i += 2
        continue
      }
      i += 1
      continue
    }
    if (text[i] === quote) {
      const afterQuote = i + 1
      if (
        afterQuote < length &&
        !isQuotedCredentialTailBoundaryCode(text.charCodeAt(afterQuote))
      ) {
        // This quote is followed by credential-shaped glue; remember the
        // first such candidate and keep looking for a true closing quote.
        if (candidateEnd === -1) {
          candidateEnd = afterQuote
        }
        i += 1
        continue
      }
      return { end: afterQuote, closed: true }
    }
    i += 1
  }
  if (candidateEnd !== -1) {
    // No later true closing quote: close at the first candidate and consume
    // only the directly glued non-boundary tail.
    let tailEnd = candidateEnd
    while (
      tailEnd < length &&
      !isQuotedCredentialTailBoundaryCode(text.charCodeAt(tailEnd))
    ) {
      tailEnd += 1
    }
    return { end: tailEnd, closed: false }
  }
  return { end: length, closed: false }
}

// Outside an explicit Authorization context a token looks like a secret when
// it contains a digit, a token character (".", "_", "~", "+", "/", "-", "="),
// or a genuinely mixed-class letter pattern: a lowercase run with an
// uppercase letter after the first position (camel/base64-style strings).
// Pure title-case words (one leading capital followed by lowercase, e.g.
// "Facts", "Training", "Alpha", "Obligations") and all-lowercase or all-caps
// words stay unchanged, however long. Length alone never marks a token, and
// no word denylist is used.
function isTokenShaped(token: string): boolean {
  let hasLower = false
  let hasInteriorUpper = false
  for (let i = 0; i < token.length; i++) {
    const ch = token[i] ?? ''
    if (ch >= 'a' && ch <= 'z') {
      hasLower = true
    } else if (ch >= 'A' && ch <= 'Z') {
      if (i > 0) {
        hasInteriorUpper = true
      }
    } else if (ch >= '0' && ch <= '9') {
      return true
    } else if (
      ch === '.' || ch === '_' || ch === '~' || ch === '+' || ch === '/' || ch === '-' || ch === '='
    ) {
      return true
    }
    // Any other character (e.g. a space inside a quoted phrase) is prose.
  }
  return hasLower && hasInteriorUpper
}

// Authorization context covers the header line itself and any whitespace-
// indented continuation line immediately following it (HTTP header folding),
// so a folded `Authorization:\n Bearer abc` redacts the short token while the
// same token in prose stays unchanged. A blank line terminates folding
// (`Authorization:\n\nBearer abc` is body prose) and a flush-left next line
// starts new prose too. The key must be an authorization header name
// (`authorization`, `x-authorization`, ...) followed by ":" or "=" and
// optional whitespace; an optional opening quote around the header value
// (`Authorization: "Bearer abc"`, `Authorization='Basic xyz'`) is accepted
// too, so quoted forms redact without echoing the credential.
//
// Instead of rescanning the line prefix for every bearer/basic occurrence
// (quadratic on long newline-free inputs), the scanner precomputes two byte
// maps once and then answers each lookup in O(1):
//   - direct[i]: position i starts a token directly after an
//     `(?:authorization|[\w-]+-authorization)\s*[=:]\s*["']?\s*` opener on
//     the same line.
//   - folded[i]: position i is the first token on an indented continuation
//     line of a folded header (after an optional opening quote and
//     horizontal whitespace). Consecutive indented lines stay in the same
//     header context: folding is only terminated by a blank line or a
//     flush-left next line.
// The context stays pending after ANY line that contains a recognized
// authorization header opener (key followed by `:`/`=`), not only after a
// line that ends at the opener: `Authorization: Bearer abc` followed by an
// indented ` Bearer def` is still one folded header (RFC obs-fold), so the
// continuation tokens redact too. Only a blank line or a flush-left line
// terminates the pending context. The maps are built with a deterministic
// per-line state machine, so the precompute pass is linear and uses no
// backtracking regex.
const AUTH_CONTEXT_NONE = 0
const AUTH_CONTEXT_AFTER_KEY = 1
const AUTH_CONTEXT_KEY_WS = 2
const AUTH_CONTEXT_SEP_WS = 3
const AUTH_CONTEXT_SEP_QUOTE = 4
const AUTH_CONTEXT_SEP_QUOTE_WS = 5

function isAuthContextDirectState(state: number): boolean {
  return (
    state === AUTH_CONTEXT_SEP_WS ||
    state === AUTH_CONTEXT_SEP_QUOTE ||
    state === AUTH_CONTEXT_SEP_QUOTE_WS
  )
}

function nextAuthContextState(state: number, code: number): number {
  switch (state) {
    case AUTH_CONTEXT_NONE:
      return AUTH_CONTEXT_NONE
    case AUTH_CONTEXT_AFTER_KEY:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_KEY_WS
      }
      if (code === 0x3a || code === 0x3d) {
        return AUTH_CONTEXT_SEP_WS
      }
      return AUTH_CONTEXT_NONE
    case AUTH_CONTEXT_KEY_WS:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_KEY_WS
      }
      if (code === 0x3a || code === 0x3d) {
        return AUTH_CONTEXT_SEP_WS
      }
      return AUTH_CONTEXT_NONE
    case AUTH_CONTEXT_SEP_WS:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_SEP_WS
      }
      if (code === 0x22 || code === 0x27) {
        return AUTH_CONTEXT_SEP_QUOTE
      }
      return AUTH_CONTEXT_NONE
    case AUTH_CONTEXT_SEP_QUOTE:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_SEP_QUOTE_WS
      }
      return AUTH_CONTEXT_NONE
    case AUTH_CONTEXT_SEP_QUOTE_WS:
      if (isAuthWhitespaceCode(code)) {
        return AUTH_CONTEXT_SEP_QUOTE_WS
      }
      return AUTH_CONTEXT_NONE
    default:
      return AUTH_CONTEXT_NONE
  }
}

interface AuthorizationContexts {
  direct: Uint8Array
  folded: Uint8Array
  quoted: Uint8Array
}

function buildAuthorizationContexts(text: string): AuthorizationContexts {
  const length = text.length
  const direct = new Uint8Array(length)
  const folded = new Uint8Array(length)
  const quoted = new Uint8Array(length)
  const keyEnd = new Uint8Array(length)

  let lineStart = 0
  let pendingAuth = false

  while (lineStart <= length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd === -1) {
      lineEnd = length
    }

    // Mark the end of every authorization header key in this line. Only
    // `authorization` itself or hyphen-prefixed names ending in
    // `-authorization` (X-Authorization, Proxy-Authorization, ...) count,
    // case-insensitively. Word-internal occurrences (`deauthorization`,
    // `reauthorization`, `authorizations`, `authorization-key`) never open a
    // header context. The check is O(1) per occurrence (no backward rescan),
    // so the whole pass stays linear.
    let cursor = lineStart
    while (cursor < lineEnd) {
      const end = matchesAsciiWordIgnoringSentinelEndAt(text, cursor, 'authorization')
      if (end >= 0) {
        const followedByKeyChar =
          end < lineEnd && isAsciiKeyCharCode(text.charCodeAt(end))
        if (!followedByKeyChar) {
          const before = cursor > 0 ? text.charCodeAt(cursor - 1) : -1
          const isExact = before === -1 || !isAsciiKeyCharCode(before)
          const isHyphenPrefixed =
            before === 0x2d &&
            cursor >= 2 &&
            isAsciiKeyCharCode(text.charCodeAt(cursor - 2))
          if ((isExact || isHyphenPrefixed) && end < length) {
            keyEnd[end] = 1
          }
        }
        cursor = end
      } else {
        cursor += 1
      }
    }

    // Run the opener state machine over the line and record direct starts,
    // whether the line ends with an opener, and the first non-blank position.
    // Any position marked direct proves the line contains a recognized
    // authorization header opener (key followed by `:`/`=`), so the folded
    // context stays pending after the line even when a value sits on it.
    let state = AUTH_CONTEXT_NONE
    let isBlank = true
    let firstNonWhitespace = lineEnd
    let lineHasAuthOpener = false
    let quoteCode = 0
    let escaped = false
    for (let p = lineStart; p < lineEnd; p++) {
      const code = text.charCodeAt(p)
      if (quoteCode !== 0) {
        // A quoted span (double, single, or backtick) is tracked so an
        // Authorization header embedded in a quoted string stops its unquoted
        // credential run before the matching closing quote instead of
        // swallowing it. The stored value is the active quote code, so an
        // unrelated quote of another type inside the string stays credential
        // material and is redacted too.
        quoted[p] = quoteCode
        if (escaped) {
          escaped = false
        } else if (code === 0x5c) {
          escaped = true
        } else if (code === quoteCode) {
          quoteCode = 0
        }
      } else if (code === 0x22 || code === 0x27 || code === 0x60) {
        quoteCode = code
      }
      if (!isAuthWhitespaceCode(code)) {
        if (firstNonWhitespace === lineEnd) {
          firstNonWhitespace = p
        }
        isBlank = false
      }
      if (keyEnd[p] === 1) {
        state = AUTH_CONTEXT_AFTER_KEY
      }
      if (isAuthContextDirectState(state)) {
        direct[p] = 1
        lineHasAuthOpener = true
      }
      state = nextAuthContextState(state, code)
    }
    const opensAuth = isAuthContextDirectState(state)

    if (isBlank) {
      // A blank line ends the previous header's folding window: the next
      // line is body prose, never a folded continuation.
      pendingAuth = false
    } else {
      // Only a line whose first content is indented with the same Unicode
      // whitespace class the opener state machine honors (space, tab, NBSP,
      // en/em/ideographic spaces, ...) can be a folded continuation (RFC
      // obs-fold); a flush-left line starts new body prose. The fold mark
      // lands on the first token, after an optional opening quote and any
      // Unicode whitespace that follows it.
      const startsIndented =
        lineStart < lineEnd && isAuthWhitespaceCode(text.charCodeAt(lineStart))
      if (pendingAuth && startsIndented) {
        let foldedAt = firstNonWhitespace
        if (foldedAt < lineEnd) {
          const quote = text[foldedAt]
          if (quote === '"' || quote === "'") {
            foldedAt += 1
            while (foldedAt < lineEnd && isAuthWhitespaceCode(text.charCodeAt(foldedAt))) {
              foldedAt += 1
            }
          }
          if (foldedAt < lineEnd) {
            folded[foldedAt] = 1
          }
        }
        // Every immediately consecutive indented line belongs to the same
        // folded header: the context survives this continuation line and
        // stays open for the next one. Only a blank line or a flush-left
        // next line terminates folding (handled below).
        pendingAuth = true
      } else {
        // A flush-left line is not a continuation: the folded context
        // survives only when this line itself opens a new (or continuing)
        // authorization header, either by ending at an opener or by
        // carrying an opener with a same-line value.
        pendingAuth = opensAuth || lineHasAuthOpener
      }
    }

    if (lineEnd === length) {
      break
    }
    lineStart = lineEnd + 1
  }

  return { direct, folded, quoted }
}

// A bearer/basic phrase needs a separator. Accepted forms, where the
// optional ":" or "=" may have whitespace on either side and is preserved
// verbatim in the output:
//   `:`              `Bearer:abc`, `Bearer : abc`
//   `=`              `Bearer=abc`, `Bearer =abc`, `Bearer = abc`
//   whitespace only  `Bearer abc`
// Anything else (`Bearer/foo`, `BearerXyz`) is not a scheme phrase. The
// first structural "=" after the scheme acts as the separator; a "=" inside
// or at the end of a whitespace-separated token (`Bearer abc=def`,
// `Bearer abc==`) is token68 padding, never a separator. Returns the index
// of the first token character, or -1 when the phrase is not a scheme
// phrase. Runs of whitespace are skipped with a single forward pass, so
// pathological runs stay linear.
function scanAuthSchemeSeparator(text: string, afterScheme: number): number {
  const length = text.length
  let j = afterScheme
  if (j < length && text.charCodeAt(j) === 0x3a) {
    // `:` directly after the scheme.
    j += 1
    return skipAuthWhitespace(text, j)
  }
  if (j < length && text.charCodeAt(j) === 0x3d) {
    // `=` directly after the scheme (`Bearer=abc123`).
    j += 1
    return skipAuthWhitespace(text, j)
  }
  if (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j = skipAuthWhitespace(text, j)
    if (j < length && text.charCodeAt(j) === 0x3a) {
      j += 1
      return skipAuthWhitespace(text, j)
    }
    if (j < length && text.charCodeAt(j) === 0x3d) {
      j += 1
      return skipAuthWhitespace(text, j)
    }
    return j
  }
  return -1
}

// When an Authorization header value is itself quoted (`Authorization:
// "Bearer secret passphrase"`, `Authorization:\n "Bearer=abc123"`), the whole
// quoted value is one credential unit. The bearer scanner normally reaches
// the `Bearer` scheme inside that quote with the quote sitting before the
// scheme rather than at the scheme's tokenStart; this helper finds that
// enclosing value-opening quote so the caller can redact the entire quoted
// contents instead of only the first token after `Bearer`.
function findAuthHeaderQuotedValueStart(text: string, schemeIndex: number): number {
  let p = schemeIndex - 1
  while (p >= 0 && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p -= 1
  }
  if (p < 0) {
    return -1
  }
  const quote = text[p] ?? ''
  if (quote !== '"' && quote !== "'") {
    return -1
  }
  let before = p - 1
  while (before >= 0 && isAuthWhitespaceCode(text.charCodeAt(before))) {
    before -= 1
  }
  if (before < 0) {
    return -1
  }
  const code = text.charCodeAt(before)
  return code === 0x3a || code === 0x3d ? p : -1 // : =
}

// In an explicit Authorization header, the whole remaining value is one
// credential unit once a scheme-bearing credential form is recognized. For an
// unquoted header this includes same-line extra tokens, comma/semicolon
// chains, and HTTP-folded continuation lines (subsequent non-blank lines
// beginning with space/tab); a flush-left or blank line is a true value
// boundary. When the credential lies inside an enclosing quoted string (for
// example `foo="Authorization: Bearer abc123"`), the run stops before the
// matching ASCII double/single/backtick quote so the closing quote is
// preserved instead of being consumed as credential material. Trailing
// punctuation is separated later by the caller, so a dot inside a JWT-style
// credential is still part of the run.
function scanAuthorizationHeaderValueEnd(
  text: string,
  start: number,
  stopAtQuoteCode = 0,
): number {
  const length = text.length
  let i = start

  if (stopAtQuoteCode !== 0) {
    while (i < length) {
      const code = text.charCodeAt(i)
      if (code === stopAtQuoteCode) {
        return i
      }
      if (code === 0x5c && i + 1 < length) {
        i += 2
        continue
      }
      i += 1
    }
    return length
  }

  while (i < length && text.charCodeAt(i) !== 0x0a) {
    i += 1
  }

  while (i < length && text.charCodeAt(i) === 0x0a) {
    const lineStart = i + 1
    let p = lineStart
    if (p >= length || !isAuthWhitespaceCode(text.charCodeAt(p))) {
      break
    }
    while (p < length && isAuthWhitespaceCode(text.charCodeAt(p))) {
      if (text.charCodeAt(p) === 0x0a) {
        return i
      }
      p += 1
    }
    if (p >= length || text.charCodeAt(p) === 0x0a) {
      return i
    }
    i = lineStart
    while (i < length && text.charCodeAt(i) !== 0x0a) {
      i += 1
    }
  }
  return i
}

// After a quoted bearer/basic token in an unquoted explicit Authorization
// header, decide whether the remainder is still part of the same credential
// value. A trailing punctuation run alone is a single-token boundary and is
// preserved; any other non-whitespace remainder (including comma/semicolon
// chains and folded continuation lines) is an extra token and must be consumed
// with the quoted token as one unit.
function hasAuthorizationExtraToken(text: string, start: number): boolean {
  const end = scanAuthorizationHeaderValueEnd(text, start, 0)
  let p = start
  while (p < end && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p += 1
  }
  if (p >= end) {
    return false
  }
  const tail = text.slice(p, end)
  const { core } = splitTrailingPunctuation(tail, isCredentialTrailingPunctuationCode)
  return core.length > 0
}

// Outside an explicit Authorization header, the ASCII token68 scanner may stop
// before a glued non-ASCII tail (`Bearer abc=def✓ghi`). When the ASCII prefix
// is token-shaped enough to redact, the non-ASCII tail and any ASCII token68
// characters after it belong to the same credential run and must be consumed
// too. The scan stops at the first ASCII non-token68 character (whitespace,
// punctuation, quotes, `<`/`>`, ...), matching the pure-ASCII token boundary.
function scanOutsideAuthCredentialTailEnd(text: string, start: number): number {
  let i = start
  const length = text.length
  while (i < length) {
    const code = text.charCodeAt(i)
    if (code < 0x80 && !isAuthTokenCharCode(code)) {
      return i
    }
    i += 1
  }
  return length
}

function redactBearerAndBasic(text: string): string {
  const contexts = buildAuthorizationContexts(text)
  const isAuthorizationContext = (offset: number): boolean =>
    contexts.direct[offset] === 1 || contexts.folded[offset] === 1

  const segments: string[] = []
  let resultLength = 0
  const append = (part: string): void => {
    if (part.length > 0) {
      segments.push(part)
      resultLength += part.length
    }
  }
  const truncateTo = (target: number): void => {
    while (resultLength > target) {
      const last = segments[segments.length - 1]
      if (last === undefined) {
        throw new Error('redactBearerAndBasic: output segment underflow')
      }
      const excess = resultLength - target
      if (last.length > excess) {
        segments[segments.length - 1] = last.slice(0, last.length - excess)
        resultLength = target
      } else {
        segments.pop()
        resultLength -= last.length
      }
    }
  }

  let i = 0
  const length = text.length
  // The context maps only mark the FIRST token after an authorization header
  // opener, so when a nested bearer/basic rescan resumes at the nested scheme
  // word that position has no marker of its own. `carriedAuth` propagates an
  // explicit Authorization context from the outer scheme occurrence into the
  // nested scheme position and through multiple nested hops, so the final
  // unshaped token (`Authorization: bearer basic password`) still redacts.
  // Ordinary prose outside an Authorization header never sets the flag, so
  // nested unshaped tokens stay byte-identical (prose false-positive guard).
  let carriedAuth = false
  while (i < length) {
    const schemeLength = authSchemeLengthAt(text, i)
    const schemeBoundary = isSchemePrecedingBoundaryAt(text, i)
    const closingUnderscoreStart = schemeBoundary
      ? findSchemeClosingUnderscoreAt(text, i)
      : -1
    if (schemeLength === 0 || !schemeBoundary) {
      append(text[i] ?? '')
      i += 1
      continue
    }
    const scheme = text.slice(i, i + schemeLength)
    const afterScheme = i + schemeLength
    const tokenStart = scanAuthSchemeSeparator(text, afterScheme)
    if (tokenStart < 0) {
      append(text[i] ?? '')
      i += 1
      continue
    }
    const quote = tokenStart < length ? text[tokenStart] : undefined
    const inHeaderContext: boolean = carriedAuth || isAuthorizationContext(i)

    // A quoted Authorization header value owns its entire contents: when
    // the scheme is inside such a quote, replace the complete quoted span
    // once rather than falling through to the single-token path.
    if (inHeaderContext) {
      const quotedHeaderStart = findAuthHeaderQuotedValueStart(text, i)
      if (quotedHeaderStart >= 0) {
        const headerQuote = text[quotedHeaderStart]!
        const scanned = scanQuotedAuthTokenEnd(text, quotedHeaderStart, headerQuote)
        const outputQuoteStart = resultLength - (i - quotedHeaderStart)
        truncateTo(outputQuoteStart)
        append(`${headerQuote}[REDACTED]${headerQuote}`)
        i = scanned.end
        carriedAuth = false
        continue
      }
    }

    // In an explicit Authorization header, once a Bearer/Basic phrase is
    // recognized the entire remaining value is one credential unit. This
    // includes same-line extra tokens, comma/semicolon chains, and
    // HTTP-folded continuation lines; the scanner does not stop at the first
    // token or rescan nested scheme words. Inside an enclosing quoted string
    // the same unit ends at the closing quote, which is preserved. A quoted
    // token on its own still goes through the quoted path below so
    // single-token quoted spellings stay byte-identical.
    if (inHeaderContext && quote !== '"' && quote !== "'") {
      const credentialEnd = scanAuthorizationHeaderValueEnd(
        text,
        tokenStart,
        contexts.quoted[tokenStart] ?? 0,
      )
      if (credentialEnd > tokenStart) {
        const separator = text.slice(afterScheme, tokenStart)
        const credential = text.slice(tokenStart, credentialEnd)
        const { core, trailing } = splitTrailingPunctuation(
          credential,
          isCredentialTrailingPunctuationCode,
        )
        if (core.length > 0) {
          append(`${scheme}${separator}[REDACTED]${trailing}`)
        } else {
          append(`${scheme}${separator}[REDACTED]`)
        }
        i = credentialEnd
        carriedAuth = false
        continue
      }
    }

    if (quote === '"' || quote === "'") {
      const scanned = scanQuotedAuthTokenEnd(text, tokenStart, quote)
      const quotedEnd =
        closingUnderscoreStart >= 0
          ? Math.min(scanned.end, closingUnderscoreStart)
          : scanned.end
      const token = scanned.closed
        ? text.slice(tokenStart + 1, quotedEnd - 1)
        : text.slice(tokenStart + 1, quotedEnd)
      if (token.length === 0) {
        // An empty quoted token carries no credential: copy the span verbatim
        // (this also keeps pathological `bearer + spaces + quote` inputs
        // byte-stable) and keep scanning.
        append(text.slice(i, quotedEnd))
        i = quotedEnd
        carriedAuth = false
        continue
      }
      const alreadyRedacted = scanned.closed && token === '[REDACTED]'
      const shouldRedact = scanned.closed
        ? inHeaderContext || isTokenShaped(token)
        : true // an unterminated quote always fails closed
      if (
        closingUnderscoreStart < 0 &&
        inHeaderContext &&
        contexts.quoted[tokenStart] === 0 &&
        hasAuthorizationExtraToken(text, scanned.end)
      ) {
        const credentialEnd = scanAuthorizationHeaderValueEnd(text, tokenStart, 0)
        if (credentialEnd > tokenStart) {
          const separator = text.slice(afterScheme, tokenStart)
          const credential = text.slice(tokenStart, credentialEnd)
          const { core, trailing } = splitTrailingPunctuation(
            credential,
            isCredentialTrailingPunctuationCode,
          )
          if (core.length > 0) {
            append(`${scheme}${separator}[REDACTED]${trailing}`)
          } else {
            append(`${scheme}${separator}[REDACTED]`)
          }
          i = credentialEnd
          carriedAuth = false
          continue
        }
      }
      if (alreadyRedacted) {
        append(text.slice(i, quotedEnd))
      } else if (shouldRedact) {
        const separator = text.slice(afterScheme, tokenStart)
        append(`${scheme}${separator}${quote}[REDACTED]${quote}`)
      } else {
        append(text.slice(i, quotedEnd))
      }
      i = quotedEnd
      carriedAuth = false
      continue
    }

    let tokenEnd = scanAuthToken(text, tokenStart)
    if (
      closingUnderscoreStart >= 0 &&
      closingUnderscoreStart > tokenStart &&
      closingUnderscoreStart < tokenEnd
    ) {
      tokenEnd = closingUnderscoreStart
    }
    const token = text.slice(tokenStart, tokenEnd)
    // When the candidate token is itself a bearer/basic scheme word and it
    // begins a valid following scheme phrase (`bearer Basic dXNlcjpwYXNz`,
    // `Bearer:Basic:dXNlcjpwYXNz`), the candidate is the nested scheme, not
    // the secret: copy the outer scheme/separator verbatim and rescan from
    // the nested scheme word so the real token below it is redacted and the
    // scheme word itself is never mistaken for the credential. The scan index
    // strictly increases (the nested scheme starts after the outer
    // separator), so chained nesting (`bearer basic bearer abc`) terminates
    // and stays monotonic; each whitespace run is walked at most twice, so
    // pathological runs stay linear. When the outer scheme occurrence is in
    // explicit Authorization context, that context is carried through the hop
    // so the nested scheme's own token is treated as header-valued too.
    const nestedSchemeLength = authSchemeLengthAt(text, tokenStart)
    if (nestedSchemeLength > 0) {
      const nestedTokenStart = scanAuthSchemeSeparator(text, tokenStart + nestedSchemeLength)
      if (nestedTokenStart >= 0) {
        const nestedQuote = nestedTokenStart < length ? text[nestedTokenStart] : undefined
        let nestedHasToken = false
        if (nestedQuote === '"' || nestedQuote === "'") {
          const nestedScan = scanQuotedAuthTokenEnd(text, nestedTokenStart, nestedQuote)
          nestedHasToken = nestedScan.end > nestedTokenStart + 2
        } else if (scanAuthToken(text, nestedTokenStart) > nestedTokenStart) {
          nestedHasToken = true
        } else if (text.startsWith('[REDACTED]', nestedTokenStart)) {
          // An already-redacted marker is a valid (non-secret) token, so a
          // second pass over `Bearer Basic [REDACTED]` stays idempotent.
          nestedHasToken = true
        }
        if (nestedHasToken) {
          append(text.slice(i, tokenStart))
          carriedAuth = inHeaderContext
          i = tokenStart
          continue
        }
      }
    }
    // In an explicit Authorization header inside an enclosing quoted string,
    // fail closed over the whole remaining quoted credential value. The
    // unquoted-header whole-value path above already handles the common
    // header form; this branch handles Authorization appearing mid-prose in a
    // quoted string (`foo="Authorization: Bearer abc123"`), preserving the
    // closing quote and only a safe trailing punctuation run.
    if (inHeaderContext) {
      const scannedCredentialEnd = scanAuthorizationHeaderValueEnd(
        text,
        tokenStart,
        contexts.quoted[tokenStart] ?? 0,
      )
      const credentialEnd =
        closingUnderscoreStart >= 0
          ? Math.min(scannedCredentialEnd, closingUnderscoreStart)
          : scannedCredentialEnd
      if (credentialEnd > tokenStart) {
        const separator = text.slice(afterScheme, tokenStart)
        const credential = text.slice(tokenStart, credentialEnd)
        const { core, trailing } = splitTrailingPunctuation(
          credential,
          isCredentialTrailingPunctuationCode,
        )
        if (core.length > 0) {
          append(`${scheme}${separator}[REDACTED]${trailing}`)
        } else {
          // A credential run made entirely of punctuation is still consumed
          // fail-closed so no part of the run can be reclassified later.
          append(`${scheme}${separator}[REDACTED]`)
        }
        i = credentialEnd
        carriedAuth = false
        continue
      }
    }
    if (token.length === 0) {
      // No token follows the scheme/separator: copy the span verbatim (this
      // also covers pathological whitespace runs) and keep scanning.
      append(text.slice(i, tokenEnd))
      i = tokenEnd
      carriedAuth = false
      continue
    }
    if (inHeaderContext || isTokenShaped(token)) {
      const separator = text.slice(afterScheme, tokenStart)
      const credentialEnd =
        closingUnderscoreStart >= 0
          ? closingUnderscoreStart
          : inHeaderContext
            ? tokenEnd
            : scanOutsideAuthCredentialTailEnd(text, tokenEnd)
      append(`${scheme}${separator}[REDACTED]`)
      i = credentialEnd
    } else {
      append(text.slice(i, tokenEnd))
      i = tokenEnd
    }
    carriedAuth = false
  }
  return segments.join('')
}

// Credential assignments: the key is matched as one full identifier and
// classified by its snake/kebab/camel segments. A key is sensitive when its
// final segment is a secret terminal (singular or plural
// token/secret/password/passwd) or its last two segments form a recognized
// pair (api-key, access-token, refresh-token, client-secret, db-password,
// and their plural endings); the legacy single-segment `apikey` spelling
// stays sensitive too. Identifiers may start with a letter, digit, or
// underscore, so environment-style keys (`_TOKEN`) and numeric prefixes
// (`2fa_token`) are covered. Keys may be bare, single-quoted (`'token'`), or
// double-quoted (`"token"`); JSON/Python/Ruby-style dicts (`{"token": "abc"}`,
// `{'token': 'abc'}`) therefore redact like bare assignments. Values may be
// quoted with backslash escapes (including newline) or bare single tokens:
// internal commas/parens stay secret, and only final prose delimiters (".", ",",
// ";", ":", "!", "?", ")", "]", "}", ">") are preserved. Whitespace terminates
// an unquoted value. An unterminated quoted value still redacts from its
// opening quote to the end of the line/input so truncated logs (`token="abc`,
// `{'token': 'abc`) never echo the value.
//
// A sensitive key whose value opens a structured literal (`[`/`{`) has the
// WHOLE balanced structure consumed and replaced by `[REDACTED]`: nested
// arrays/objects, single- and double-quoted strings with backslash escapes,
// and raw newlines (JSON/Python/log forms) are scanned with one forward pass
// and an explicit bracket stack. A structure that never closes or whose
// closer mismatches its opener fails closed through a safe line/input
// boundary, so a bare `[`/`{` is never redacted while the remainder of the
// value is echoed. After a structure closes, any adjacent non-whitespace/
// non-quote scalar tail that is still part of the assignment value is
// consumed too (`token=[a,b]c`, `api_key=[abc]XYZ`, `token=[a,b],c` never
// echo `c`, `XYZ`, or `,c`); the full safe terminal delimiter run survives
// only at a safe boundary (whitespace/quote/end or a proven structural outer
// closer), so multi-character punctuation runs stay byte-identical across
// passes. A non-sensitive key whose value opens
// a structured literal is never swallowed whole: the scanner copies the
// key/separator and continues inside the container, so nested sensitive
// assignments inside non-sensitive containers (`data={token=abc}`,
// `env={TOKEN: "abc123"}`) are still found and redacted while the container
// bytes are preserved, and the scan stays a single monotonic O(n) pass.
// A non-sensitive key whose value is a bare scalar is never swallowed
// either: the scanner copies the key/separator and resumes at the value
// start, so a nested sensitive assignment inside the scalar
// (`key:password=hunter2`, `user:token=xyz`) redacts while unrelated bytes
// stay byte-identical and the resume index strictly increases.
// A sensitive nested assignment may also hide at the value start of ANY
// assignment (`config: "api_key" = "S3CR3T"`, `password: "token" =
// "hunter2"`, `ab: token = hunter2`): when the value start begins a valid
// bare/single/double quoted SENSITIVE key, optional approved whitespace, and
// then `:`/`=`, the outer key/separator is preserved and the scanner resumes
// at the nested key so the normal rules redact its real scalar/quoted/
// structured value (see isNestedSensitiveAssignmentStart). Non-sensitive
// nested-looking keys never split: inside a sensitive value they fail closed
// by redacting the outer value instead.
// Bare scalar values keep their approved rules except that the ambiguous
// closing punctuation `]`, `}`, and `>` fail closed instead of being
// preserved as if they were always prose delimiters.
//
// Assignments chain: after a value, a `,`, `;`, or `:` followed by
// `key<ws>[=:]` (bare or quoted key, approved JS whitespace on either side
// of the separator) is an independent next assignment, never part of the
// current value. The first value redacts, the delimiter is preserved, and
// the outer scanner re-scans the next assignment so `token=[1,2],api_key =
// secret`, `token=abc;api_key = secret`, and quoted-key variants redact
// every value without dropping keys; non-sensitive chained keys/values are
// preserved byte-identically. The chain lookahead decides only from the
// delimiter + key + separator shape — it never parses the candidate value,
// so a structured/scalar `:` or `=` inside the next value cannot reject or
// force a split (`token=abc,password ={pw:hunter2}` splits at the comma and
// the structured value redacts whole), and plain prose fragments after a
// delimiter are never split.
//
// Instead of a global backtracking regex (whose `\s*[=:]\s*` separator and
// greedy key quantifier rescan long key-shaped runs quadratically), a single
// deterministic forward scanner finds each assignment. A match is
// `key + (\s*[=:]\s*) + value` where the key is a maximal run of
// `[A-Za-z0-9_-]` chars starting with `[A-Za-z0-9_]` and ending on an ASCII
// alphanumeric (optionally wrapped in matching quotes). Only the longest key
// ending can ever be followed by the separator: any shorter key end is
// followed by a key character, never whitespace or `=`/`:`. So each run needs
// exactly one forward scan, and after a failed run the scanner jumps past the
// whole run instead of rescanning it from every interior position, keeping the
// whole pass linear.
function isAsciiAlnumCharCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) // a-z
  )
}

// Credential key runs additionally include the internal separator sentinel so
// a control/format character embedded in a key (`pass\x00word`) is scanned as
// one key and later classified on its sentinel-stripped form. A literal `%` is
// also part of the run so percent-encoded credential keys (`foo%3Atoken=abc`,
// `api%5Fkey=S3CR3T`) are scanned as one key; classification then decodes the
// encoded bytes only for segment matching and the original key bytes are
// preserved in the rendered output. Dot and slash are also accepted as
// flattened-key separators (`api.key`, `api/key`); colon is deliberately left
// out of the general run so existing colon-as-assignment-separator behavior
// (`token:abc=def`) stays byte-identical. Colon-flattened keys are handled by
// the dedicated flattened scanner used by redactCredentialAssignments.
function isCredentialKeyRunCharCode(code: number): boolean {
  return (
    isAsciiKeyCharCode(code) ||
    isSeparatorSentinelCode(code) ||
    code === 0x25 || // %
    code === 0x2e || // .
    code === 0x2f // /
  )
}

// Flattened credential key runs used for the text-side assignment scanner
// also accept colon as a segment boundary. Unlike the general run, this is
// only used as a candidate when the flattened key classifies as sensitive, so
// ordinary colon assignments (`token:abc=def`) still fall back to the
// existing scanner and keep their approved byte-for-byte behavior.
function isFlattenedCredentialKeyRunCharCode(code: number): boolean {
  return isCredentialKeyRunCharCode(code) || code === 0x3a // :
}

// A small bounded set of punctuation that may sit between a bare credential
// key identifier and its assignment separator (`password! = x`). Only a
// single trailing character is tolerated, and only when the following bytes
// are an actual `=`/`:` assignment; prose without that separator stays
// byte-identical.
function isCredentialKeySuffixPunctuationCode(code: number): boolean {
  return (
    code === 0x21 || // !
    code === 0x3f || // ?
    code === 0x2e || // .
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x3a || // :
    code === 0x27 || // '
    code === 0x22 // "
  )
}

function stripSingleCredentialKeySuffixPunctuation(key: string): string {
  if (key.length === 0) {
    return key
  }
  const last = key.charCodeAt(key.length - 1)
  return isCredentialKeySuffixPunctuationCode(last) ? key.slice(0, -1) : key
}

// Returns the value start when the character at `punctuationPos` is an
// approved single suffix punctuation byte followed by whitespace and then a
// real `=`/`:` separator. Requiring whitespace after the punctuation keeps
// existing false-positive guards intact (`token"=abc` stays unchanged) while
// still supporting `password! = hunter2` and `password: = hunter2`.
function scanCredentialKeySuffixSeparator(text: string, punctuationPos: number): number {
  if (
    punctuationPos >= text.length ||
    punctuationPos + 1 >= text.length ||
    !isCredentialKeySuffixPunctuationCode(text.charCodeAt(punctuationPos)) ||
    !isAuthWhitespaceCode(text.charCodeAt(punctuationPos + 1))
  ) {
    return -1
  }
  return scanCredentialSeparator(text, punctuationPos + 1)
}

interface CredentialKeyRun {
  runEnd: number
  lastAlnum: number
}

// Scans the maximal run of `[A-Za-z0-9_-]` chars plus internal sentinels
// starting at `start` (whose first char is known to be `[A-Za-z0-9_]`) and
// reports the run's exclusive end plus the last ASCII alphanumeric position
// inside it (the longest key ending, since a key must end on `[A-Za-z0-9]`).
function scanCredentialKeyRun(text: string, start: number): CredentialKeyRun {
  const length = text.length
  let runEnd = start + 1
  let lastAlnum = isAsciiAlnumCharCode(text.charCodeAt(start)) ? start : -1
  while (runEnd < length && isCredentialKeyRunCharCode(text.charCodeAt(runEnd))) {
    if (isAsciiAlnumCharCode(text.charCodeAt(runEnd))) {
      lastAlnum = runEnd
    }
    runEnd += 1
  }
  return { runEnd, lastAlnum }
}

// Scans the maximal run including flattened separators (dot, slash, and
// colon). The caller uses this as a sensitive-only candidate so a colon that
// is really an assignment separator (`token:abc=def`) still falls through to
// the original scanner.
function scanCredentialKeyRunFlattened(text: string, start: number): CredentialKeyRun {
  const length = text.length
  let runEnd = start + 1
  let lastAlnum = isAsciiAlnumCharCode(text.charCodeAt(start)) ? start : -1
  while (runEnd < length && isFlattenedCredentialKeyRunCharCode(text.charCodeAt(runEnd))) {
    if (isAsciiAlnumCharCode(text.charCodeAt(runEnd))) {
      lastAlnum = runEnd
    }
    runEnd += 1
  }
  return { runEnd, lastAlnum }
}

// When a flattened candidate contains a colon, preserve the approved
// colon-as-assignment-separator interpretation whenever a colon-separated
// prefix is itself sensitive (`token:secret=v` stays `token:[REDACTED]`,
// not `token:secret=[REDACTED]`). The flattened scanner is then skipped and
// the normal scanner handles the colon as the assignment separator.
function hasSensitiveColonPrefix(keyText: string): boolean {
  let segmentStart = 0
  for (let i = 0; i < keyText.length; i++) {
    if (keyText[i] === ':') {
      const prefix = keyText.slice(segmentStart, i)
      if (isSensitiveKey(prefix)) {
        return true
      }
      segmentStart = i + 1
    }
  }
  return false
}

const MAX_CREDENTIAL_KEY_SPACED_SEGMENTS = 4
const MAX_CREDENTIAL_KEY_SPACED_WHITESPACE = 32

// The spaced-key scanner treats the same non-line-breaking whitespace the
// sensitive-key classifier strips as transparent inside a candidate key.
// ASCII space and NBSP are the primary cases; the other Unicode space
// characters are included for consistency with isSensitiveKeyIgnorableAt.
// Newlines and line/paragraph separators remain hard boundaries so a value on
// one line is never merged into a key on the next line.
function isCredentialKeySpacedSeparatorCode(code: number): boolean {
  return (
    code === 0x20 || // space
    code === 0xa0 || // NBSP
    code === 0x1680 || // Ogham space mark
    (code >= 0x2000 && code <= 0x200a) || // en/em/quad spaces
    code === 0x202f || // narrow no-break space
    code === 0x205f || // medium mathematical space
    code === 0x3000 // ideographic space
  )
}

// Like scanCredentialKeyRun, but also tolerates bounded ordinary-space
// segments between words inside a candidate key (`api key`, `pass word`).
// Non-line-breaking Unicode whitespace (notably NBSP) is treated the same as
// an ASCII space because the classifier already treats it as transparent;
// newlines and line/paragraph separators remain hard boundaries so a value on
// one line is never merged into a key on the next line. The run stops at the
// last alphanumeric before a separator or after a small number of word
// segments, so prose leads are not swept into an unbounded key-shaped run.
// This is only used for assignment lookahead and for sensitive-key
// classification; the contiguous scanner remains the fallback that lets
// trailing sensitive segments (`the password = x`) still redact.
function scanCredentialKeyRunSpaced(text: string, start: number, allowNewlines = false): CredentialKeyRun {
  const length = text.length
  let runEnd = start + 1
  let lastAlnum = isAsciiAlnumCharCode(text.charCodeAt(start)) ? start : -1
  let segmentCount = 1
  let whitespaceStart = -1
  while (runEnd < length) {
    const code = text.charCodeAt(runEnd)
    if (isCredentialKeyRunCharCode(code)) {
      if (whitespaceStart !== -1) {
        if (segmentCount >= MAX_CREDENTIAL_KEY_SPACED_SEGMENTS) {
          return { runEnd: whitespaceStart, lastAlnum }
        }
        segmentCount += 1
        whitespaceStart = -1
      }
      if (isAsciiAlnumCharCode(code)) {
        lastAlnum = runEnd
      }
      runEnd += 1
    } else if (isCredentialKeySpacedSeparatorCode(code) || (allowNewlines && code === 0x0a)) {
      if (segmentCount >= MAX_CREDENTIAL_KEY_SPACED_SEGMENTS) {
        break
      }
      if (whitespaceStart === -1) {
        whitespaceStart = runEnd
      }
      runEnd += 1
      if (runEnd - whitespaceStart > MAX_CREDENTIAL_KEY_SPACED_WHITESPACE) {
        return { runEnd: whitespaceStart, lastAlnum }
      }
    } else {
      break
    }
  }
  if (whitespaceStart !== -1) {
    return { runEnd: whitespaceStart, lastAlnum }
  }
  return { runEnd, lastAlnum }
}

// Scans `\s*[=:]\s*` starting at `start` (after the key or its closing quote).
// Returns the first value character, or -1 when no `=`/`:` separator follows.
// The whole `\s` class is honored (including newlines), mirroring the previous
// regex, and the whitespace run is walked once.
function scanCredentialSeparator(text: string, start: number): number {
  const length = text.length
  let j = start
  while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1
  }
  if (j >= length) {
    return -1
  }
  const code = text.charCodeAt(j)
  if (code !== 0x3a && code !== 0x3d) {
    return -1
  }
  j += 1
  while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1
  }
  return j
}

// Scans a malformed repeated credential separator run starting at `start`,
// which must already be on a `=`/`:` byte that follows the first approved
// separator. The run may contain any mix of `=` and `:` with arbitrary
// approved whitespace between them, e.g. `==`, `= =`, `: :`, `:=`, or `=:`.
// Returns the first byte after the whole run, including optional whitespace
// after the final separator so the credential value (bare or quoted) starts
// at the returned index.
function scanRepeatedCredentialSeparatorEnd(text: string, start: number): number {
  const length = text.length
  let j = start
  while (j < length) {
    const code = text.charCodeAt(j)
    if (code !== 0x3a && code !== 0x3d) {
      break
    }
    j += 1
    while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
      j += 1
    }
  }
  return j
}

// Chain delimiters that can separate one credential assignment from the next
// in the same scalar/structured expression: `,`, `;`, `:`. A delimiter is a
// chain boundary only when a `key` (bare or quoted) followed by approved JS
// whitespace and then `=`/`:` starts after it; otherwise it stays inside the
// current value and the value is consumed whole.
function isChainDelimiterCode(code: number): boolean {
  return code === 0x2c || code === 0x3b || code === 0x3a // , ; :
}

// Looks one assignment ahead starting at `delimiterPos` (which must hold a
// chain delimiter). Returns true when `key<ws>[=:]` follows the delimiter,
// meaning the delimiter separates two independent assignments and the outer
// scanner must handle the second one itself instead of swallowing `,key` and
// leaving ` = value` behind. Approved/JS whitespace (the full `\s` class) may
// sit between the delimiter and the key and between the key and the
// separator; quoted keys (`'key'`/`"key"`) are accepted too. The candidate
// VALUE is deliberately never inspected: a chain decision depends only on the
// delimiter + key + separator shape, and the outer scanner owns value parsing
// (structured literals, quoted values, scalar tails). A `:`/`=` inside the
// candidate value's structure or scalar therefore never rejects or accepts a
// split, so `token=abc,password ={pw:hunter2}` still splits at the comma and
// the structured value redacts whole. The lookahead is one deterministic
// forward pass with no recursion: a failed candidate key run is walked again
// by the caller at most once, so the whole scan stays monotonic O(n), and
// plain prose fragments (a delimiter followed by text with no `=`/`:` after
// the key) are never split.
function isChainedAssignmentLookahead(text: string, delimiterPos: number): boolean {
  const length = text.length
  if (!isChainDelimiterCode(text.charCodeAt(delimiterPos))) {
    return false
  }
  let j = delimiterPos + 1
  while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1
  }
  if (j >= length) {
    return false
  }
  const quote = text[j] ?? ''
  if (quote === '"' || quote === "'") {
    // Quoted key: a word run followed by the matching closing quote.
    const keyStart = j + 1
    if (keyStart >= length || !isAsciiWordCharCode(text.charCodeAt(keyStart))) {
      return false
    }
    const run = scanCredentialKeyRunSpaced(text, keyStart)
    if (run.lastAlnum < keyStart + 1) {
      return false
    }
    const closingQuote = run.lastAlnum + 1
    if (closingQuote >= length || text.charCodeAt(closingQuote) !== text.charCodeAt(j)) {
      return false
    }
    j = closingQuote + 1
  } else if (isAsciiWordCharCode(text.charCodeAt(j))) {
    const run = scanCredentialKeyRunSpaced(text, j)
    if (run.lastAlnum < j + 1) {
      return false
    }
    j = run.lastAlnum + 1
  } else {
    return false
  }
  while (j < length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1
  }
  if (j >= length) {
    return false
  }
  const code = text.charCodeAt(j)
  return code === 0x3d || code === 0x3a
}

// A sensitive nested assignment can hide at another assignment's value
// start: `config: "api_key" = "S3CR3T"`, `password: "token" = "hunter2"`,
// `ab: 'token' = 'xyz'`, `ab: token = hunter2`. Before the outer scanner
// consumes the value, check whether the bytes at the value start instead
// begin a valid bare or single/double quoted SENSITIVE key, optional
// approved whitespace, then `:`/`=`. When they do, the outer key must not
// swallow that key as its scalar value: the caller preserves the outer
// prefix and resumes at the nested key so the normal scanner redacts the
// nested assignment's real scalar/quoted/structured value. The lookahead is
// one deterministic forward pass (key run, optional closing quote,
// whitespace, one separator check) that shares the chain lookahead's shape,
// so a failed candidate is walked again by the caller at most once and the
// whole scan stays monotonic O(n). Non-sensitive nested-looking keys are
// deliberately ignored: inside a sensitive value they fail closed by
// redacting the outer value instead of being split (splitting would copy the
// nested non-sensitive value verbatim and could echo a real secret), and a
// non-sensitive outer value keeps its ordinary quoted/bare handling
// (`config: "hello"`, `note='token=abc'`).
interface NestedSensitiveAssignmentStart {
  keyQuote: string
  keyText: string
  separator: string
  valueStart: number
}

function scanNestedSensitiveAssignmentStart(
  text: string,
  valueStart: number,
): NestedSensitiveAssignmentStart | null {
  const length = text.length
  if (valueStart >= length) {
    return null
  }
  const first = text[valueStart] ?? ''
  let keyText: string
  let afterKey: number
  if (first === '"' || first === "'") {
    // Quoted key: an identifier of at least two characters and the matching
    // closing quote, mirroring the outer scanner's quoted-key rules so the
    // resume index always lands on a key the scanner recognizes.
    const keyStart = valueStart + 1
    if (keyStart >= length || !isAsciiWordCharCode(text.charCodeAt(keyStart))) {
      return null
    }
    const run = scanCredentialKeyRun(text, keyStart)
    if (run.lastAlnum < keyStart + 1) {
      return null
    }
    const closingQuote = run.lastAlnum + 1
    if (closingQuote >= length || text.charCodeAt(closingQuote) !== text.charCodeAt(valueStart)) {
      return null
    }
    keyText = text.slice(keyStart, run.lastAlnum + 1)
    afterKey = closingQuote + 1
  } else if (isAsciiWordCharCode(text.charCodeAt(valueStart))) {
    // Bare key: the maximal key run ending on an ASCII alphanumeric.
    const run = scanCredentialKeyRun(text, valueStart)
    if (run.lastAlnum < valueStart + 1) {
      return null
    }
    keyText = text.slice(valueStart, run.lastAlnum + 1)
    afterKey = run.lastAlnum + 1
  } else {
    return null
  }
  const keyQuote = first === '"' || first === "'" ? first : ''
  if (!isCredentialAssignmentSensitiveKey(keyText, keyQuote)) {
    return null
  }
  const nestedValueStart = scanCredentialSeparator(text, afterKey)
  if (nestedValueStart < 0) {
    return null
  }
  return {
    keyQuote,
    keyText,
    separator: text.slice(afterKey, nestedValueStart),
    valueStart: nestedValueStart,
  }
}

function isNestedSensitiveAssignmentStart(text: string, valueStart: number): boolean {
  return scanNestedSensitiveAssignmentStart(text, valueStart) !== null
}

interface CredentialValueScan {
  end: number
  value: string
}

// A possible closing quote at `quotePos` inside a quoted value may be the
// SOLE opener/boundary of an immediately following sensitive key assignment
// instead. Closing there would leave that assignment's quoted key/value glued
// to the redacted span and echo the secret on the next scan:
//   - forward: the quote opens a quoted SENSITIVE key glued right after it
//     (`token='abc{'api_key': 'SECRET'}`: the `'` after `{` opens `'api_key'`
//     and closing it leaves `api_key': 'SECRET'}` broken);
//   - backward: a sensitive bare key + `[ws]*[=:][ws]*` ends right before the
//     quote AND a matching quote closes a quoted value later on the same
//     line, so the quote opens that value (`token='abc;api_key='SECRET'`: the
//     `'` before `SECRET'` opens `'SECRET'` and closing it echoes `SECRET`).
// A valid closed value whose content merely CONTAINS `key=` text
// (`token='x;api_key=' and more`) is untouched: no matching quote follows on
// the line, so the quote is a genuine closer and the value closes normally.
function isSensitiveQuoteBoundary(text: string, quotePos: number, quote: string): boolean {
  const length = text.length
  // Forward: the quote opens a glued quoted SENSITIVE key.
  if (quotePos + 1 < length && isAsciiWordCharCode(text.charCodeAt(quotePos + 1))) {
    const run = scanCredentialKeyRun(text, quotePos + 1)
    if (run.lastAlnum >= quotePos + 2) {
      const closingQuote = run.lastAlnum + 1
      if (
        closingQuote < length &&
        text.charCodeAt(closingQuote) === text.charCodeAt(quotePos) &&
        isSensitiveKey(text.slice(quotePos + 1, run.lastAlnum + 1)) &&
        scanCredentialSeparator(text, closingQuote + 1) >= 0
      ) {
        return true
      }
    }
  }
  // Backward: the quote opens the quoted value of a sensitive assignment that
  // ends right before it, and a matching quote closes that value later on the
  // same line.
  let p = quotePos - 1
  while (p >= 0 && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p -= 1
  }
  if (p < 0) {
    return false
  }
  const separatorCode = text.charCodeAt(p)
  if (separatorCode !== 0x3d && separatorCode !== 0x3a) {
    return false // = :
  }
  const keyEnd = p
  p -= 1
  while (p >= 0 && isAuthWhitespaceCode(text.charCodeAt(p))) {
    p -= 1
  }
  const keyLast = p
  while (p >= 0 && isCredentialKeyRunCharCode(text.charCodeAt(p))) {
    p -= 1
  }
  const keyStart = p + 1
  if (
    keyStart >= keyEnd ||
    keyLast < keyStart ||
    !isAsciiWordCharCode(text.charCodeAt(keyStart)) ||
    !isAsciiAlnumCharCode(text.charCodeAt(keyLast)) ||
    !isCredentialAssignmentSensitiveKey(text.slice(keyStart, keyEnd), '')
  ) {
    return false
  }
  const lineEnd = text.indexOf('\n', quotePos)
  const searchEnd = lineEnd === -1 ? length : lineEnd
  const nextQuote = text.indexOf(quote, quotePos + 1)
  return nextQuote !== -1 && nextQuote < searchEnd
}

// Scans a credential value starting at `start`. Quoted values honor backslash
// escapes (any character, including newline and the quote itself) and close at
// the matching quote or at end of input; a lone trailing backslash with
// nothing to escape makes the quoted value unable to close, so the scan fails
// closed through end of input and the caller renders a canonical quoted
// marker. In a SENSITIVE key's quoted value (`guardSensitiveBoundary` true),
// unescaped newlines are ordinary content and are crossed until the matching
// closing quote or the end of input, so no byte after a newline inside a
// multi-line credential is ever echoed. Non-sensitive quoted values remain
// fail-closed at an unescaped newline so later lines stay available to the
// scanner for nested sensitive assignments. Bare values are `[^\s"']+`: one or
// more non-whitespace, non-quote characters, stopping early at `stopCode` when
// one is given. `stopCode` is the expected closing delimiter of the innermost
// structured container the outer scanner is currently walking, so a bare value
// inside a non-sensitive container (`data={token=abc}`) never swallows the
// container's own closer: the scanner can prove from the structural context
// that the closer lies outside the value and preserves it as a syntactic outer
// delimiter.
//
// When `guardSensitiveBoundary` is set (a SENSITIVE key's value), a possible
// closing quote that is also the sole opener/boundary of an immediately
// following sensitive key assignment (see isSensitiveQuoteBoundary) makes the
// value unable to close: the scan fails closed through the next safe
// line/input boundary so neither the truncated credential nor the following
// secret is ever echoed. Non-sensitive quoted values are opaque data and never
// trigger the guard.
function scanCredentialValue(
  text: string,
  start: number,
  stopCode?: number,
  guardSensitiveBoundary = false,
): CredentialValueScan | null {
  const length = text.length
  if (start >= length) {
    return null
  }
  const quote = text[start] ?? ''
  if (quote === '"' || quote === "'") {
    let i = start + 1
    let candidateEnd = -1
    while (i < length) {
      const code = text.charCodeAt(i)
      if (code === 0x0a) {
        if (!guardSensitiveBoundary) {
          return { end: i, value: text.slice(start, i) }
        }
        i += 1
        continue
      }
      if (code === 0x5c) {
        if (i + 1 >= length) {
          // A lone trailing backslash has nothing to escape, so the quoted
          // value cannot close: fail closed through end of input. The caller
          // renders a canonical quoted `[REDACTED]`, so the truncated secret
          // is never echoed.
          return { end: length, value: text.slice(start, length) }
        }
        i += 2
        continue
      }
      if (text[i] === quote) {
        if (guardSensitiveBoundary && isSensitiveQuoteBoundary(text, i, quote)) {
          // The "closing" quote actually opens an immediately following
          // sensitive key assignment: the value cannot close here, so fail
          // closed through the next newline or end of input and never echo
          // the truncated credential or the following secret.
          const lineEnd = text.indexOf('\n', i)
          const end = lineEnd === -1 ? length : lineEnd
          return { end, value: text.slice(start, end) }
        }
        const afterQuote = i + 1
        if (
          guardSensitiveBoundary &&
          afterQuote < length &&
          !isQuotedCredentialTailBoundaryCode(text.charCodeAt(afterQuote), stopCode)
        ) {
          // This quote is followed by credential-shaped glue; remember the
          // first such candidate and keep looking for a true closing quote.
          if (candidateEnd === -1) {
            candidateEnd = afterQuote
          }
          i += 1
          continue
        }
        return { end: afterQuote, value: text.slice(start, afterQuote) }
      }
      i += 1
    }
    if (candidateEnd !== -1) {
      // No later true closing quote: close at the first candidate and consume
      // only the directly glued non-boundary tail. Whitespace- or
      // separator-delimited following content stays outside the credential.
      let tailEnd = candidateEnd
      while (
        tailEnd < length &&
        !isQuotedCredentialTailBoundaryCode(text.charCodeAt(tailEnd), stopCode)
      ) {
        tailEnd += 1
      }
      return { end: tailEnd, value: text.slice(start, tailEnd) }
    }
    return { end: length, value: text.slice(start, length) }
  }
  if (isAuthWhitespaceCode(text.charCodeAt(start))) {
    return null // bare values need at least one non-whitespace character
  }
  let i = start
  while (i < length) {
    const code = text.charCodeAt(i)
    if (
      isAuthWhitespaceCode(code) ||
      code === 0x22 ||
      code === 0x27 ||
      (stopCode !== undefined && code === stopCode) ||
      // A chain delimiter followed by `key<ws>[=:]` starts an independent
      // next assignment: stop the value at the delimiter so the outer
      // scanner redacts the second assignment on its own (and so the first
      // value is redacted without swallowing `,key` or leaking ` = value`).
      (isChainDelimiterCode(code) && isChainedAssignmentLookahead(text, i))
    ) {
      break
    }
    i += 1
  }
  return { end: i, value: text.slice(start, i) }
}

interface StructuredCredentialValueScan {
  // Exclusive index where the outer scanner resumes: just past the closing
  // bracket of a balanced structure (possibly a chain of immediately
  // adjacent/comma-adjacent literals), or a fail-closed boundary (end of the
  // line on which the scan gave up, or end of input) when the structure
  // cannot be confirmed complete. The caller additionally consumes any
  // adjacent scalar tail (see consumeStructuredValueTail) so a closed
  // structure never leaks a continuation.
  end: number
}

function isOpenStructureCharCode(code: number): boolean {
  return code === 0x5b || code === 0x7b // [ {
}

function isCloseStructureCharCode(code: number): boolean {
  return code === 0x5d || code === 0x7d // ] }
}

function matchesStructureCloser(open: number, close: number): boolean {
  return (open === 0x5b && close === 0x5d) || (open === 0x7b && close === 0x7d)
}

// Consumes a structured value (`[...]` or `{...}`) that starts at `start`
// with a single deterministic forward pass and an explicit bracket stack (no
// recursion, so arbitrarily deep nesting cannot overflow the call stack).
// Inside the structure, both single- and double-quoted strings are skipped
// with backslash escapes (any character, including quotes and newlines), and
// raw newlines are allowed both inside strings and between elements, so JSON,
// Python, and log forms scan in linear time. Returns the exclusive index
// where scanning resumes:
//   - balanced: just past the matching closer (chaining immediately adjacent
//     `[a][b]`/`{a}{b}` literals and comma-adjacent `[a],[b]` literals as
//     one structured expression, mirroring the previous bare-token coverage
//     so a second value segment is never echoed);
//   - unterminated (end of input without a close): end of input;
//   - mismatched (a closer that does not match its opener): end of the line
//     on which the mismatch occurred (or end of input).
// The caller replaces `text.slice(start, end)` with `[REDACTED]`, so a
// fail-closed structure never echoes any remainder.
function scanStructuredCredentialValue(text: string, start: number): StructuredCredentialValueScan {
  const length = text.length
  let i = start
  let end = -1
  for (;;) {
    const open = text.charCodeAt(i)
    if (!isOpenStructureCharCode(open)) {
      break // comma chaining found no following structure
    }
    const stack: number[] = [open]
    let j = i + 1
    let closed = false
    while (j < length) {
      const code = text.charCodeAt(j)
      if (code === 0x22 || code === 0x27) {
        const quote = code
        j += 1
        for (;;) {
          if (j >= length) {
            return { end: length } // unterminated string: input boundary
          }
          const inner = text.charCodeAt(j)
          if (inner === 0x5c) {
            if (j + 1 >= length) {
              return { end: length } // trailing backslash: cannot close
            }
            j += 2
            continue
          }
          if (inner === quote) {
            break
          }
          j += 1
        }
        j += 1
        continue
      }
      if (isOpenStructureCharCode(code)) {
        stack.push(code)
        j += 1
        continue
      }
      if (isCloseStructureCharCode(code)) {
        const top = stack[stack.length - 1]
        if (top !== undefined && matchesStructureCloser(top, code)) {
          stack.pop()
          if (stack.length === 0) {
            closed = true
            break
          }
          j += 1
          continue
        }
        // Mismatched closer: the structure is malformed. Fail closed through
        // the end of the line on which the mismatch appeared so no remainder
        // is echoed.
        const lineEnd = text.indexOf('\n', j)
        return { end: lineEnd === -1 ? length : lineEnd }
      }
      j += 1
    }
    if (!closed) {
      // Unterminated structure: fail closed through the end of input.
      return { end: length }
    }
    end = j + 1
    // Chain an immediately adjacent structure or a comma directly followed
    // by a structure as part of the same structured expression. The
    // fail-closed `[REDACTED_URL]` marker is deliberately NOT chained: the
    // tail pass can emit it right after a chain delimiter that a previous
    // pass preserved, so it must stay outside the value where the outer
    // scanner (and the structured-tail boundary rules) handle it
    // identically on every pass.
    if (
      isOpenStructureCharCode(text.charCodeAt(end)) &&
      !text.startsWith('[REDACTED_URL]', end)
    ) {
      i = end
      continue
    }
    if (
      text.charCodeAt(end) === 0x2c &&
      isOpenStructureCharCode(text.charCodeAt(end + 1)) &&
      !text.startsWith('[REDACTED_URL]', end + 1)
    ) {
      i = end + 1
      continue
    }
    break
  }
  return { end }
}

// A safe terminal delimiter run may be preserved only when the character
// after it is a safe boundary: end of input, JS whitespace, a quote, or the
// proven structural outer closer of the container the scanner is walking
// (stopCode). Any other following character makes the run fail closed
// (consumed), so bare-value trailing punctuation and already-redacted
// structured-marker tails agree on every pass and stay byte-identical.
function isTerminalDelimiterRunBoundary(followingCode: number, stopCode?: number): boolean {
  return (
    followingCode === -1 ||
    isAuthWhitespaceCode(followingCode) ||
    followingCode === 0x22 ||
    followingCode === 0x27 ||
    (stopCode !== undefined && followingCode === stopCode)
  )
}

// Safe terminal prose delimiters that may remain after a closed sensitive
// structured value. `]`, `}`, and `>` are deliberately excluded: they are
// ambiguous closing punctuation that may be credential material, so they
// fail closed and are never echoed. `,` is included so a bare-value tail
// (`token=abc,!`) and an already-redacted structured-marker tail
// (`token=[REDACTED],!`) preserve the exact same run on every pass; a comma
// survives only when the full run ends at a proven safe boundary, so a
// comma followed by credential-shaped material still fails closed.
const SAFE_STRUCTURED_TAIL_DELIMITERS = new Set<number>([
  0x2e, // .
  0x2c, // ,
  0x3b, // ;
  0x3a, // :
  0x21, // !
  0x3f, // ?
  0x29, // )
])

function isSafeTerminalDelimiterRun(tail: string): boolean {
  if (tail.length === 0) {
    return false
  }
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i] ?? ''
    if (
      ch !== '.' &&
      ch !== ',' &&
      ch !== ';' &&
      ch !== ':' &&
      ch !== '!' &&
      ch !== '?' &&
      ch !== ')'
    ) {
      return false
    }
  }
  return true
}

// Consumes any non-whitespace, non-quote scalar tail that immediately
// follows a closed sensitive structured value (`[a,b]c`, `[a,b],c`,
// `[a,b];x`). A tail that is exactly one unambiguous terminal prose
// delimiter (`.`, `;`, `:`, `!`, `?`, `)`) followed by whitespace or end of
// input is preserved; a comma is additionally preserved when it is followed
// by whitespace/end or by a new assignment (`[1,2],api_key=[3,4]`,
// `[1,2],api_key = [3,4]`) so the outer scanner can still redact that later
// assignment. `;` and `:` are chain delimiters too, so a whitespace- or
// colon-separated chained assignment after a structured value is never
// swallowed. Every other adjacent tail (comma+secret, alphanumeric
// continuation, ambiguous `]`/`}`/`>`) is consumed so it is never echoed.
// Whitespace and quotes terminate the tail (a quoted fragment after a
// structure is outside the assignment value). `stopCode` is the expected
// closer of the innermost container the outer scanner is walking; it
// terminates the tail too, so a syntactic outer delimiter is never swallowed
// (`{"token":[1,2]}` keeps its `}`).
// Returns the exclusive index where the outer scanner resumes.
function consumeStructuredValueTail(text: string, end: number, stopCode?: number): number {
  const length = text.length
  if (end >= length) {
    return end
  }
  const code = text.charCodeAt(end)
  if (stopCode !== undefined && code === stopCode) {
    return end // the container's own closer is outside the value
  }
  if (isAuthWhitespaceCode(code) || code === 0x22 || code === 0x27) {
    return end
  }
  if (isChainDelimiterCode(code)) {
    const next = end + 1
    if (next >= length) {
      return end // chain delimiter followed by end: unambiguous prose
    }
    const nextCode = text.charCodeAt(next)
    if (isAuthWhitespaceCode(nextCode) || nextCode === 0x22 || nextCode === 0x27) {
      // Delimiter before whitespace/end or a quote: a prose delimiter or a
      // structural separator before a quoted fragment (`{"token":[1,2],"x":3}`).
      return end
    }
    if (isChainedAssignmentLookahead(text, end)) {
      // Delimiter + `key<ws>[=:]`: a new assignment starts here, so the
      // outer scanner must redact it independently; the delimiter itself is
      // preserved as plain prose.
      return end
    }
    if (text.startsWith('[REDACTED_URL]', next)) {
      // A fail-closed URL marker directly after a chain delimiter is safe
      // boundary material: the tail pass emits such a marker where the
      // delimiter was already preserved as a chain boundary, so keeping the
      // delimiter and the marker outside the value lets a second pass see
      // exactly the same boundary and stay byte-identical.
      return end
    }
    if (SAFE_STRUCTURED_TAIL_DELIMITERS.has(code)) {
      // `;`/`:` are safe terminal delimiters too: preserve the full run at a
      // safe boundary (whitespace, quote, end, or the proven outer closer),
      // and consume it fail-closed otherwise.
      let runEnd = end + 1
      while (
        runEnd < length &&
        SAFE_STRUCTURED_TAIL_DELIMITERS.has(text.charCodeAt(runEnd))
      ) {
        runEnd += 1
      }
      const following = runEnd >= length ? -1 : text.charCodeAt(runEnd)
      if (isTerminalDelimiterRunBoundary(following, stopCode)) {
        return end
      }
    }
    return consumeStructuredValueScalarTail(text, end, stopCode) // delimiter+secret
  }
  if (SAFE_STRUCTURED_TAIL_DELIMITERS.has(code)) {
    // The full safe terminal delimiter run (`[.,;:!?)]+`) is preserved only
    // when it ends at a safe boundary (whitespace, quote, end of input, or
    // the proven structural outer closer); otherwise the whole run is
    // consumed fail-closed so a punctuation run is never split differently
    // between passes. Returning `end` leaves the run in the output, where
    // the outer scanner copies it verbatim.
    let runEnd = end + 1
    while (runEnd < length && SAFE_STRUCTURED_TAIL_DELIMITERS.has(text.charCodeAt(runEnd))) {
      runEnd += 1
    }
    const following = runEnd >= length ? -1 : text.charCodeAt(runEnd)
    if (isTerminalDelimiterRunBoundary(following, stopCode)) {
      return end
    }
    return consumeStructuredValueScalarTail(text, end, stopCode)
  }
  return consumeStructuredValueScalarTail(text, end, stopCode)
}

// Consumes a run of non-whitespace, non-quote characters starting at
// `start` (inclusive) and returns its exclusive end, stopping early at
// `stopCode` when one is given so a container closer is never swallowed, and
// stopping at a chain delimiter that begins a new independent assignment so
// the outer scanner still redacts it. Used to swallow credential-shaped
// scalar tails so their bytes are never echoed.
function consumeStructuredValueScalarTail(
  text: string,
  start: number,
  stopCode?: number,
): number {
  const length = text.length
  let i = start
  while (i < length) {
    const code = text.charCodeAt(i)
    if (
      isAuthWhitespaceCode(code) ||
      code === 0x22 ||
      code === 0x27 ||
      (stopCode !== undefined && code === stopCode) ||
      (isChainDelimiterCode(code) && isChainedAssignmentLookahead(text, i))
    ) {
      break
    }
    i += 1
  }
  return i
}

interface CredentialAssignmentMatch {
  keyQuote: string
  keyText: string
  separator: string
  value: string
}

interface CredentialValueConsumption {
  rendered: string
  end: number
}

function isBareAuthSchemeOwnedValue(
  text: string,
  keyQuote: string,
  keyText: string,
  valueStart: number,
): boolean {
  if (keyQuote !== '' || !isAuthorizationFamilyKey(keyText)) {
    return false
  }
  const schemeLength = authSchemeLengthAt(text, valueStart)
  if (schemeLength === 0) {
    return false
  }
  return scanAuthSchemeSeparator(text, valueStart + schemeLength) >= 0
}

// An explicit Authorization-family value with more than one whitespace token
// is not a scheme-less scalar: unknown scheme names and all parameters are
// credential material, so the generic single-token redaction must not leave a
// second token (`Authorization: Custom abc123`) or a later parameter
// (`Authorization: Digest ... response="abc123"`) in plain text. The
// approved Bearer/Basic scanner owns those scheme phrases; a single
// whitespace-free scheme-less scalar keeps the round-3 trailing-punctuation
// behavior.
function isMultiTokenAuthorizationValue(
  text: string,
  keyQuote: string,
  keyText: string,
  valueStart: number,
  stopCode?: number,
  ignoreBareAuthSchemeOwnedValue = false,
): boolean {
  if (keyQuote !== '' || !isAuthorizationFamilyKey(keyText)) {
    return false
  }
  if (!ignoreBareAuthSchemeOwnedValue && isBareAuthSchemeOwnedValue(text, keyQuote, keyText, valueStart)) {
    return false
  }
  const first = text[valueStart] ?? ''
  if (first === '"' || first === "'" || first === '[' || first === '{') {
    return false
  }
  const scanned = scanCredentialValue(text, valueStart, stopCode)
  if (scanned === null) {
    return false
  }
  let j = scanned.end
  while (j < text.length && isAuthWhitespaceCode(text.charCodeAt(j))) {
    j += 1
  }
  if (j >= text.length) {
    return false
  }
  if (isChainDelimiterCode(text.charCodeAt(j)) && isChainedAssignmentLookahead(text, j)) {
    // A delimiter followed by an independent assignment is a chain boundary,
    // not another token of this Authorization value. The normal scanner
    // redacts that next assignment separately.
    return false
  }
  return true
}

// Consumes an unquoted multi-token Authorization value to the end of its
// line (or the containing structural closer), so no unknown scheme name,
// parameter, quote, comma, or trailing credential is ever echoed. The
// separator/key prefix is rendered by the caller.
function scanAuthorizationWholeValueEnd(
  text: string,
  start: number,
  stopCode?: number,
): number {
  const length = text.length
  let i = start
  let openQuote = ''
  while (i < length) {
    const code = text.charCodeAt(i)
    if (openQuote === '' && (code === 0x22 || code === 0x27)) {
      openQuote = text[i] ?? ''
      i += 1
      continue
    }
    if (openQuote !== '' && code === text.charCodeAt(i)) {
      openQuote = ''
      i += 1
      continue
    }
    if (code === 0x5c && openQuote !== '') {
      i += 2
      continue
    }
    if (code === 0x0a) {
      // HTTP folded continuation (`\n `/`\n\t`), split scheme words
      // (`CustomSc\nheme`), an inserted newline before a flush-left token
      // (`CustomScheme \nsecret`), and an UNTERMINATED quoted credential
      // crossing the newline are all still credential material inside an
      // explicit Authorization value: fail closed across them. A newline
      // followed by a non-word byte (blank line, punctuation) ends the
      // value.
      const next = i + 1 < length ? text.charCodeAt(i + 1) : -1
      if (openQuote !== '' || next === 0x20 || next === 0x09 || isAsciiWordCharCode(next)) {
        i += 1
        continue
      }
      break
    }
    if (openQuote === '' && stopCode !== undefined && code === stopCode) {
      break
    }
    i += 1
  }
  return i
}

// Consumes and renders the value of an assignment whose key and separator
// are already known. When the bytes at the value start instead begin a
// sensitive nested assignment (`config: "api_key" = "S3CR3T"`,
// `password: "token" = "hunter2"`, `ab: token = hunter2`), the nested key is
// never consumed as the outer assignment's scalar value: the outer
// key/separator prefix is preserved verbatim and the scan resumes at the
// nested key so the normal scanner redacts its real
// scalar/quoted/structured value. This applies to sensitive and
// non-sensitive outer keys alike; a non-sensitive nested-looking key never
// splits (ambiguous cases fail closed by redacting the outer sensitive
// value). A sensitive key whose value opens a structured literal
// (`[`/`{`) consumes the whole balanced structure (plus any adjacent scalar
// tail) and renders a single `[REDACTED]`; a non-sensitive key whose value
// opens a structured literal copies the key/separator and resumes inside the
// container so nested sensitive assignments are still found and redacted
// without swallowing the container. A non-sensitive key with a bare scalar
// value copies the key/separator and resumes at the value start too, so the
// remaining scalar is never swallowed: a nested sensitive assignment inside
// it (`key:password=hunter2`, `user:token=xyz`, `Bearer abc:api_key=SECRET`)
// is still found and redacted while unrelated non-sensitive bytes are copied
// back byte-identically, and the resume index is strictly monotonic so the
// whole scan stays O(n). A non-sensitive quoted value is opaque data and is
// consumed verbatim. Every other value keeps the approved scalar rules.
// Returns null when no value can be consumed at all (e.g. end of input).
// `stopCode` is the expected closer of the innermost container being walked
// (see redactCredentialAssignments); it bounds bare values and structured
// tails so syntactic outer delimiters are preserved.
function consumeCredentialValue(
  text: string,
  valueStart: number,
  keyQuote: string,
  keyText: string,
  separator: string,
  stopCode?: number,
): CredentialValueConsumption | null {
  let currentValueStart = valueStart
  let currentKeyQuote = keyQuote
  let currentKeyText = keyText
  let currentSeparator = separator
  let outerKeyQuote = keyQuote
  let outerKeyText = keyText
  let outerSeparator = separator
  let advancedThroughNestedSensitive = false
  let malformedSensitiveValue = false

  const finish = (rendered: string, end: number): CredentialValueConsumption => {
    if (!advancedThroughNestedSensitive) {
      return { rendered, end }
    }
    const outerKey = outerKeyQuote === '' ? outerKeyText : `${outerKeyQuote}${outerKeyText}${outerKeyQuote}`
    return { rendered: `${outerKey}${outerSeparator}[REDACTED]`, end }
  }

  while (true) {
    if (currentValueStart >= text.length) {
      return null
    }
    const first = text[currentValueStart] ?? ''
    const key = currentKeyQuote === '' ? currentKeyText : `${currentKeyQuote}${currentKeyText}${currentKeyQuote}`
    const credentialSensitive =
      (malformedSensitiveValue ||
        isCredentialAssignmentSensitiveKey(currentKeyText, currentKeyQuote)) &&
      (malformedSensitiveValue ||
        !isBareAuthSchemeOwnedValue(text, currentKeyQuote, currentKeyText, currentValueStart))
    // A malformed repeated separator after a SENSITIVE key (`token == abc`,
    // `token = = abc`, `token := abc`) must not leave the second separator as
    // a bare value and then echo the real credential. Collapse the whole run
    // into the already-consumed first separator and continue at the following
    // value; non-sensitive keys keep the existing byte-for-byte behavior.
    if (
      credentialSensitive &&
      currentValueStart < text.length &&
      (text.charCodeAt(currentValueStart) === 0x3d ||
        text.charCodeAt(currentValueStart) === 0x3a)
    ) {
      malformedSensitiveValue = true
      const afterRun = scanRepeatedCredentialSeparatorEnd(text, currentValueStart)
      if (afterRun >= text.length) {
        return finish(`${key}${currentSeparator}[REDACTED]`, afterRun)
      }
      currentValueStart = afterRun
      continue
    }
    // The value actually begins a sensitive nested assignment. For a
    // non-sensitive outer key the nested key is preserved and the scanner
    // resumes at it so the real nested value is redacted (`config: "api_key"
    // = "S3CR3T"`). For a sensitive outer key the whole nested region is
    // already part of the outer credential value: consume it and replace the
    // ENTIRE region atomically, never preserving a leading token as if it
    // were a nested key (`token=SECRET=value`, `token="SECRET" = "value"`).
    const nestedStart = scanNestedSensitiveAssignmentStart(text, currentValueStart)
    if (nestedStart !== null) {
      if (credentialSensitive) {
        if (!advancedThroughNestedSensitive) {
          outerKeyQuote = currentKeyQuote
          outerKeyText = currentKeyText
          outerSeparator = currentSeparator
          advancedThroughNestedSensitive = true
        }
        currentKeyQuote = nestedStart.keyQuote
        currentKeyText = nestedStart.keyText
        currentSeparator = nestedStart.separator
        currentValueStart = nestedStart.valueStart
        continue
      }
      return { rendered: `${key}${currentSeparator}`, end: currentValueStart }
    }
    if (
      credentialSensitive &&
      isMultiTokenAuthorizationValue(text, currentKeyQuote, currentKeyText, currentValueStart, stopCode, malformedSensitiveValue)
    ) {
      // Unknown/multi-token Authorization-family values fail closed as one
      // unit. The approved Bearer/Basic scanner already owns those scheme
      // phrases; this branch prevents the generic scalar path from redacting
      // only the first whitespace-delimited token and leaving the rest.
      const end = scanAuthorizationWholeValueEnd(text, currentValueStart, stopCode)
      return finish(`${key}${currentSeparator}[REDACTED]`, end)
    }
    if (first === '[' || first === '{') {
      if (credentialSensitive) {
        const structured = scanStructuredCredentialValue(text, currentValueStart)
        // After the structure closes, consume any adjacent scalar tail that is
        // still part of the assignment value (`[a,b]c` never leaves `c`
        // behind), preserving only an unambiguous terminal prose delimiter
        // run followed by whitespace/end. A container closer (stopCode) is
        // never swallowed: it is a syntactic outer delimiter.
        const end = consumeStructuredValueTail(text, structured.end, stopCode)
        return finish(`${key}${currentSeparator}[REDACTED]`, end)
      }
      // Non-sensitive container: never swallow it whole. Copy the
      // key/separator and resume at the opening delimiter so the container
      // bytes are preserved while the scanner keeps walking its interior and
      // still finds nested sensitive assignments.
      return { rendered: `${key}${currentSeparator}`, end: currentValueStart }
    }
    if (!credentialSensitive) {
      // Non-sensitive scalar value: never swallow the remaining scalar. A
      // quoted value is no longer blindly opaque: its interior is scanned by
      // the same nested sensitive-assignment machinery and rebuilt with the
      // outer quote characters preserved, so assignments hidden inside a
      // quoted scalar (`data="password=hunter2"`, `data='{"token":"abc"}'`)
      // still redact while unrelated quoted bytes stay byte-identical. A bare
      // value is left in place and the scan resumes at its start so any
      // nested sensitive assignment inside the scalar still redacts while
      // unrelated bytes stay byte-identical.
      if (first === '"' || first === "'") {
        const value = scanCredentialValue(text, currentValueStart, stopCode)
        if (value === null) {
          return null
        }
        const quote = value.value[0] ?? ''
        const closed =
          value.value.length >= 2 && value.value[value.value.length - 1] === quote
        const interior = closed ? value.value.slice(1, -1) : value.value.slice(1)
        const redactedInterior = redactCredentialAssignments(interior)
        return finish(
          `${key}${currentSeparator}${quote}${redactedInterior}${closed ? quote : ''}`,
          value.end,
        )
      }
      return { rendered: `${key}${currentSeparator}`, end: currentValueStart }
    }
    const value = scanCredentialValue(text, currentValueStart, stopCode, true)
    if (value === null) {
      return null
    }
    const followingCode = value.end >= text.length ? -1 : text.charCodeAt(value.end)
    return finish(
      renderCredentialAssignment(
        {
          keyQuote: currentKeyQuote,
          keyText: currentKeyText,
          separator: currentSeparator,
          value: value.value,
        },
        followingCode,
        stopCode,
      ),
      value.end,
    )
  }
}

// Renders one matched assignment with the approved scalar replacement rules:
// sensitive keys redact the value (quoted values keep their quotes, bare
// values keep only final prose delimiters), already-redacted values stay
// verbatim, and non-sensitive keys are copied back byte-identically. A bare
// value's full safe terminal delimiter run survives only when the character
// after the value is a safe boundary (whitespace, quote, end of input, or
// the proven structural outer closer); otherwise the run is consumed
// fail-closed, so bare-value trailing punctuation and already-redacted
// structured-marker tails agree on every pass and never drift.
// `followingCode` is the char code just past the value (-1 at end of input).
function renderCredentialAssignment(
  match: CredentialAssignmentMatch,
  followingCode: number,
  stopCode?: number,
): string {
  const { keyQuote, keyText, separator, value } = match
  if (!isCredentialAssignmentSensitiveKey(keyText, keyQuote)) {
    return `${keyQuote}${keyText}${keyQuote}${separator}${value}`
  }
  const key = keyQuote === '' ? keyText : `${keyQuote}${keyText}${keyQuote}`
  const quote = value[0] ?? ''
  if (quote === '"' || quote === "'") {
    // Terminated and unterminated quotes redact identically: the marker
    // sits inside the quotes so truncated logs are closed off too.
    return `${key}${separator}${quote}[REDACTED]${quote}`
  }
  if (value.startsWith('[REDACTED]')) {
    // Already redacted (defensive: sensitive structured values are consumed
    // by the structured scanner before they reach this path). Keep the
    // marker and a safe terminal delimiter run verbatim only when the run is
    // at a safe boundary; ambiguous closers (`]`, `}`, `>`) and other
    // credential-shaped tails are never echoed.
    const tail = value.slice('[REDACTED]'.length)
    if (
      isSafeTerminalDelimiterRun(tail) &&
      isTerminalDelimiterRunBoundary(followingCode, stopCode)
    ) {
      return `${key}${separator}[REDACTED]${tail}`
    }
    return `${key}${separator}[REDACTED]`
  }
  const { core, trailing } = splitTrailingPunctuation(
    value,
    isCredentialTrailingPunctuationCode,
  )
  if (core.length === 0) {
    // The whole value was punctuation; redact it all.
    return `${key}${separator}[REDACTED]`
  }
  if (trailing.length > 0 && !isTerminalDelimiterRunBoundary(followingCode, stopCode)) {
    // The punctuation run is not at a safe boundary: consume it fail-closed.
    return `${key}${separator}[REDACTED]`
  }
  return `${key}${separator}[REDACTED]${trailing}`
}

function redactCredentialAssignments(text: string): string {
  let result = ''
  let i = 0
  const length = text.length
  // Stack of expected closing delimiters for every structured container the
  // outer scanner is currently walking (plain `[`/`{` characters and
  // non-sensitive container values). While the stack is non-empty the
  // scanner can prove from structural context that a matching `]`/`}` is a
  // syntactic outer delimiter outside any assignment value, so bare values
  // and structured tails stop there instead of swallowing or echoing it.
  const containerClosers: number[] = []
  while (i < length) {
    const code = text.charCodeAt(i)
    const ch = text[i] ?? ''
    const topCloser = containerClosers[containerClosers.length - 1]

    if (ch === '"' || ch === "'") {
      // Quoted key candidate: a matching quote, an identifier of at least two
      // characters, and the same quote before the separator. The longest key
      // inside the quotes is the only one that can be followed by the closing
      // quote (a shorter key is followed by a key character), so one forward
      // scan suffices. The key must not be preceded by an identifier
      // character, EXCEPT when that character is the final hex digit of a
      // complete `%HH` sequence whose decoded octet is a safe structural
      // assignment boundary/opener (`{`, `[`, `,`, `;`, `:`, `}`, `]`, `)`):
      // URL canonicalization emits such a sequence directly before a quoted
      // key (`http://m/x,token=abc{"token": ...` -> `...%7B"token": ...`), and
      // treating the encoded octet as word glue would hide the quoted SENSITIVE
      // key and echo its value. Non-sensitive keys behind an encoded boundary
      // are deliberately not recognized (the relaxation applies only to
      // sensitive keys, matching the boundary's structural role).
      const precededByWordChar = i > 0 && isAsciiWordCharCode(text.charCodeAt(i - 1))
      const encodedBoundary = precededByWordChar && isEncodedStructuralBoundaryAt(text, i)
      const keyStart = i + 1
      if (keyStart < length && isAsciiWordCharCode(text.charCodeAt(keyStart))) {
        // Spaced sensitive keys first (`"api key": "hunter2"`). The spaced
        // run is only accepted when the whole quoted key is sensitive, so
        // non-sensitive prose quoted keys keep the existing byte-for-byte
        // behavior and trailing sensitive segments still work.
        const spacedRun = scanCredentialKeyRunSpaced(text, keyStart, true)
        const spacedClosingQuote = spacedRun.lastAlnum + 1
        if (
          spacedRun.lastAlnum >= keyStart + 1 &&
          spacedClosingQuote < length &&
          text.charCodeAt(spacedClosingQuote) === code
        ) {
          const afterKey = spacedClosingQuote + 1
          const valueStart = scanCredentialSeparator(text, afterKey)
          if (valueStart >= 0) {
            const keyText = text.slice(keyStart, spacedClosingQuote)
            if (isSensitiveKey(keyText)) {
              const consumed = consumeCredentialValue(
                text,
                valueStart,
                ch,
                keyText,
                text.slice(afterKey, valueStart),
                topCloser,
              )
              if (consumed !== null) {
                result += consumed.rendered
                i = consumed.end
                continue
              }
            }
          }
        }

        // Flattened sensitive keys first (`"api.key": "abc123"`). This
        // candidate includes dot/slash/colon as segment separators and is
        // accepted only when the whole flattened key is sensitive; otherwise
        // the existing run below preserves all approved non-sensitive and
        // colon-separator behavior.
        const flattenedRun = scanCredentialKeyRunFlattened(text, keyStart)
        const flattenedClosingQuote = flattenedRun.lastAlnum + 1
        if (
          flattenedRun.lastAlnum >= keyStart + 1 &&
          flattenedClosingQuote < length &&
          text.charCodeAt(flattenedClosingQuote) === code
        ) {
          const afterKey = flattenedClosingQuote + 1
          const valueStart = scanCredentialSeparator(text, afterKey)
          if (valueStart >= 0) {
            const keyText = text.slice(keyStart, flattenedClosingQuote)
            if (!hasSensitiveColonPrefix(keyText) && isSensitiveKey(keyText)) {
              const consumed = consumeCredentialValue(
                text,
                valueStart,
                ch,
                keyText,
                text.slice(afterKey, valueStart),
                topCloser,
              )
              if (consumed !== null) {
                result += consumed.rendered
                i = consumed.end
                continue
              }
            }
          }
        }

        const run = scanCredentialKeyRun(text, keyStart)
        const closingQuote = run.lastAlnum + 1
        if (
          run.lastAlnum >= keyStart + 1 &&
          closingQuote < length &&
          text.charCodeAt(closingQuote) === code
        ) {
          const afterKey = closingQuote + 1
          const valueStart = scanCredentialSeparator(text, afterKey)
          if (valueStart >= 0) {
            const keyText = text.slice(keyStart, closingQuote)
            const sensitive = isSensitiveKey(keyText)
            // Task 4A1-Q: a quoted valid SENSITIVE key immediately followed
            // by approved whitespace and an explicit `:`/`=` separator is a
            // high-confidence assignment even when its opening quote is
            // word-glued (`/private/tmp/run/b'password'='SECRET'`,
            // `x-token=abc'password'='SECRET'`). The generic word-boundary
            // rule (no identifier char before the opening quote, or a
            // URL-canonicalized encoded structural boundary) is relaxed only
            // for sensitive keys with a real separator; non-sensitive quoted
            // word-glue and ordinary quoted prose stay byte-identical.
            if (!precededByWordChar || encodedBoundary || sensitive) {
              if (!encodedBoundary || sensitive) {
                const consumed = consumeCredentialValue(
                  text,
                  valueStart,
                  ch,
                  keyText,
                  text.slice(afterKey, valueStart),
                  topCloser,
                )
                if (consumed !== null) {
                  result += consumed.rendered
                  i = consumed.end
                  continue
                }
              }
            }
          }
        }
      }
      result += ch
      i += 1
      continue
    }

    if (isAsciiWordCharCode(code)) {
      // The key must not be preceded by an identifier character.
      if (i > 0 && isAsciiWordCharCode(text.charCodeAt(i - 1))) {
        result += ch
        i += 1
        continue
      }
      // Spaced sensitive keys first (`api key = hunter2`). The spaced run is
      // only accepted when the whole key is sensitive; otherwise the existing
      // contiguous run is used so `the password = x` still redacts through
      // the trailing `password` segment instead of being consumed as one
      // non-sensitive prose phrase.
      const spacedRun = scanCredentialKeyRunSpaced(text, i, true)
      if (spacedRun.lastAlnum >= i + 1) {
        const identifierEnd = spacedRun.lastAlnum + 1
        let keyEnd = identifierEnd
        let spacedValueStart = -1
        if (
          keyEnd < length &&
          isCredentialKeySuffixPunctuationCode(text.charCodeAt(keyEnd))
        ) {
          const suffixedValueStart = scanCredentialKeySuffixSeparator(text, keyEnd)
          if (suffixedValueStart >= 0) {
            keyEnd += 1
            spacedValueStart = suffixedValueStart
          }
        }
        if (spacedValueStart < 0) {
          spacedValueStart = scanCredentialSeparator(text, identifierEnd)
        }
        if (spacedValueStart >= 0) {
          const keyText = text.slice(i, keyEnd)
          if (isSensitiveKey(stripSingleCredentialKeySuffixPunctuation(keyText))) {
            const consumed = consumeCredentialValue(
              text,
              spacedValueStart,
              '',
              keyText,
              text.slice(keyEnd, spacedValueStart),
              topCloser,
            )
            if (consumed !== null) {
              result += consumed.rendered
              i = consumed.end
              continue
            }
          }
        }
      }

      // Flattened sensitive keys first (`api.key=abc123`, `api:key=abc123`).
      // This candidate includes dot/slash/colon as segment separators and is
      // accepted only when the whole flattened key is sensitive and no colon
      // prefix is itself sensitive (which would mean the colon is the
      // approved assignment separator, e.g. `token:abc=def`).
      const flattenedRun = scanCredentialKeyRunFlattened(text, i)
      if (flattenedRun.lastAlnum >= i + 1) {
        const identifierEnd = flattenedRun.lastAlnum + 1
        let keyEnd = identifierEnd
        let flattenedValueStart = -1
        if (
          keyEnd < length &&
          isCredentialKeySuffixPunctuationCode(text.charCodeAt(keyEnd))
        ) {
          const suffixedValueStart = scanCredentialKeySuffixSeparator(text, keyEnd)
          if (suffixedValueStart >= 0) {
            keyEnd += 1
            flattenedValueStart = suffixedValueStart
          }
        }
        if (flattenedValueStart < 0) {
          flattenedValueStart = scanCredentialSeparator(text, identifierEnd)
        }
        if (flattenedValueStart >= 0) {
          const keyText = text.slice(i, keyEnd)
          if (
            !hasSensitiveColonPrefix(keyText) &&
            isSensitiveKey(stripSingleCredentialKeySuffixPunctuation(keyText))
          ) {
            const consumed = consumeCredentialValue(
              text,
              flattenedValueStart,
              '',
              keyText,
              text.slice(keyEnd, flattenedValueStart),
              topCloser,
            )
            if (consumed !== null) {
              result += consumed.rendered
              i = consumed.end
              continue
            }
          }
        }
      }

      const run = scanCredentialKeyRun(text, i)
      if (run.lastAlnum >= i + 1) {
        // A single trailing punctuation byte from the approved bounded set
        // may sit between the key identifier and the assignment separator
        // (`password! = x`). Prefer that interpretation when the bytes after
        // the punctuation form a real separator; otherwise fall back to the
        // established contiguous key/separator scan (`password: x` still
        // treats `:` as the separator itself).
        const identifierEnd = run.lastAlnum + 1
        let keyEnd = identifierEnd
        let valueStart = -1
        if (
          keyEnd < length &&
          isCredentialKeySuffixPunctuationCode(text.charCodeAt(keyEnd))
        ) {
          const suffixedValueStart = scanCredentialKeySuffixSeparator(text, keyEnd)
          if (suffixedValueStart >= 0) {
            keyEnd += 1
            valueStart = suffixedValueStart
          }
        }
        if (valueStart < 0) {
          valueStart = scanCredentialSeparator(text, identifierEnd)
        }
        if (valueStart >= 0) {
          const keyText = text.slice(i, keyEnd)
          const consumed = consumeCredentialValue(
            text,
            valueStart,
            '',
            keyText,
            text.slice(keyEnd, valueStart),
            topCloser,
          )
          if (consumed !== null) {
            result += consumed.rendered
            i = consumed.end
            continue
          }
        }
      }
      // No separator (or no value) after this run's longest key, and no
      // shorter key inside the run can be followed by one either: copy the
      // whole run verbatim and skip it so interior positions are never
      // rescanned.
      result += text.slice(i, run.runEnd)
      i = run.runEnd
      continue
    }

    // Plain structural character: opening delimiters enter the container
    // stack (their matching closer is then provably syntactic), and a closer
    // that matches the innermost open container closes it. Mismatched or
    // unmatched closers are plain prose and stay byte-identical.
    if (isOpenStructureCharCode(code)) {
      containerClosers.push(code === 0x5b ? 0x5d : 0x7d)
    } else if (isCloseStructureCharCode(code) && topCloser !== undefined && topCloser === code) {
      containerClosers.pop()
    }
    result += ch
    i += 1
  }
  return result
}
const SECRET_TERMINALS = new Set([
  'key',
  'keys',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'passphrase',
  'passphrases',
  'passwd',
])

// A compound is credential-shaped when a sensitive terminal is preceded by
// one of these recognized qualifiers. The set is deliberately broad and
// case-insensitive (segments are normalized to lowercase), so arbitrary
// stacks such as `aws/secret/access/key` classify without hand-listing every
// compound. Existing dedicated pair/norm spellings remain in force.
const SECRET_KEY_QUALIFIERS = new Set([
  'secret',
  'access',
  'api',
  'private',
  'public',
  'session',
  'client',
  'consumer',
  'app',
  'auth',
  'id',
  'refresh',
  'bearer',
  'aws',
])

const SECRET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['api', 'key'],
  ['api', 'keys'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['client', 'secret'],
  ['db', 'password'],
]

// High-confidence standard credential key spellings. Keys are compared by the
// same normalization used for the existing terminal/pair rules, so underscore,
// hyphen, camelCase, and single-segment spellings all classify together while
// unrelated lookalikes remain untouched. The set is built from singular bases
// and their systematic `s` plurals so every approved compound also recognizes
// the plural spelling without hand-listing each variant. `authorization` and
// `bearer` stay singular-only because approved lookalike behavior keeps
// `authorizations` and bearer-word prose non-sensitive.
const SENSITIVE_KEY_NORM_BASES = [
  'privatekey',
  'secretkey',
  'accesskey',
  'credential',
  'jwt',
  'authtoken',
  'idtoken',
  'sessiontoken',
  'sessionkey',
  'passphrase',
  'apikey',
  'password',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'dbpassword',
] as const

const SENSITIVE_KEY_NORMS = new Set<string>(['authorization', 'bearer'])
for (const base of SENSITIVE_KEY_NORM_BASES) {
  SENSITIVE_KEY_NORMS.add(base)
  SENSITIVE_KEY_NORMS.add(`${base}s`)
}

function isSensitiveKeyIgnorableAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return (
    isSeparatorSentinelCode(code) ||
    isUnsafeControlCharCode(code) ||
    isAuthWhitespaceCode(code) ||
    isFormatCharacterAt(text, index)
  )
}

// Separators (unsafe control/format characters, the internal sentinel,
// ordinary whitespace, and the flattened-key punctuation `.`/`/`/`:`) are
// classification boundaries: a key like `foo\tpassword` or `my password`
// must be recognized through its sensitive segment instead of being merged
// into a non-sensitive compound. Flattened object spellings such as
// `user.password`, `request.headers.authorization`, `data.api_key`,
// `foo/token`, and `data:api_key` therefore classify through the same
// segment rules as their nested counterparts. Segments are still re-joined
// by the existing whole-key comparison below, so `pass word` and
// `pass\u00a0word` still normalize to `password`.
function isSensitiveKeyBoundaryAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return (
    isSeparatorSentinelCode(code) ||
    isUnsafeControlCharCode(code) ||
    isAuthWhitespaceCode(code) ||
    isFormatCharacterAt(text, index) ||
    code === 0x2e || // .
    code === 0x2f || // /
    code === 0x3a // :
  )
}

// Removes every unsafe separator, whitespace, format, and control character
// from a key before the round-9 merged sensitive-key comparison.
function stripSensitiveKeyIgnorables(key: string): string {
  let result = ''
  for (let i = 0; i < key.length; i++) {
    if (isSensitiveKeyIgnorableAt(key, i)) {
      if (
        key.charCodeAt(i) >= 0xd800 &&
        key.charCodeAt(i) <= 0xdbff &&
        isFormatCharacterAt(key, i)
      ) {
        // A supplementary format character spans two code units; consume the
        // low surrogate so it is never copied as a lone surrogate.
        i += 1
      }
      continue
    }
    result += key[i] ?? ''
  }
  return result
}

// Percent-decodes complete `%HH` sequences for credential-key classification
// only. Unlike the file-URL decoder this is intentionally byte-oriented and
// never throws: every valid `%HH` becomes its corresponding Latin-1 code unit,
// while an incomplete or malformed `%` is copied literally. Classification can
// therefore see `%3A` as `:`, `%5F` as `_`, or `%2D` as `-` (segment
// boundaries) without changing the original key bytes that scanners render.
function decodePercentForClassification(key: string): string {
  if (!key.includes('%')) {
    return key
  }
  let result = ''
  for (let i = 0; i < key.length; i++) {
    const ch = key[i] ?? ''
    if (ch === '%' && i + 2 < key.length) {
      const high = hexDigitValue(key.charCodeAt(i + 1))
      const low = hexDigitValue(key.charCodeAt(i + 2))
      if (high >= 0 && low >= 0) {
        result += String.fromCharCode(high * 16 + low)
        i += 2
        continue
      }
    }
    result += ch
  }
  return result
}

function splitKeySegments(key: string): string[] {
  // Percent-decode only for classification, so an encoded separator has the
  // same segment meaning as its decoded character.
  key = decodePercentForClassification(key)
  // Replace every sensitive-key ignorable/separator boundary with an explicit
  // word separator, including ordinary whitespace. The later whole-key
  // comparison still re-joins segments, preserving the approved
  // `pass word`/`pass\u00a0word` behavior.
  let normalized = ''
  for (let i = 0; i < key.length; i++) {
    if (isSensitiveKeyBoundaryAt(key, i)) {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '_') {
        normalized += '_'
      }
      if (
        key.charCodeAt(i) >= 0xd800 &&
        key.charCodeAt(i) <= 0xdbff &&
        isFormatCharacterAt(key, i)
      ) {
        // A supplementary format character spans two code units; consume the
        // low surrogate so it is never copied as a lone surrogate.
        i += 1
      }
    } else {
      normalized += key[i] ?? ''
    }
  }
  const segments: string[] = []
  for (const raw of normalized.split(/[_-]+/)) {
    let word = ''
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i] ?? ''
      const prev = raw[i - 1] ?? ''
      const next = raw[i + 1] ?? ''
      const upper = ch >= 'A' && ch <= 'Z'
      const prevUpper = prev >= 'A' && prev <= 'Z'
      const nextLower = next >= 'a' && next <= 'z'
      if (word.length > 0 && upper && (!prevUpper || nextLower)) {
        segments.push(word.toLowerCase())
        word = ch
      } else {
        word += ch
      }
    }
    if (word.length > 0) {
      segments.push(word.toLowerCase())
    }
  }
  return segments
}

// The dedicated bearer/basic scanner owns bare `bearer` text assignments
// (`Bearer=abc`, `bearer=Basic=...`). Bare authorization-family keys now use
// the normal credential-assignment path too, so scheme-less values redact;
// when the value is a Bearer/Basic phrase the caller detects that ownership
// and keeps the already-approved auth output byte-identical.
function isAuthorizationFamilyKey(key: string): boolean {
  const cleaned = stripSingleCredentialKeySuffixPunctuation(key)
  const segments = splitKeySegments(cleaned)
  if ((segments[segments.length - 1] ?? '') === 'authorization') {
    return true
  }
  // A sentinel/whitespace/format split inside the key
  // (\`Proxy-Authori\\x00zation\`) must still classify as authorization:
  // strip the ignorables and re-check the merged spelling.
  const merged = splitKeySegments(stripSensitiveKeyIgnorables(cleaned))
  return (merged[merged.length - 1] ?? '') === 'authorization'
}

function isCredentialAssignmentSensitiveKey(keyText: string, keyQuote: string): boolean {
  // Bare assignment keys may carry a single approved trailing punctuation
  // byte between the identifier and the separator (`password! = x`). The
  // classifier looks through that suffix; the scanner preserves it in the
  // rendered key bytes.
  const classifiedKey =
    keyQuote === '' ? stripSingleCredentialKeySuffixPunctuation(keyText) : keyText
  if (!isSensitiveKey(classifiedKey)) {
    return false
  }
  if (keyQuote === '') {
    const norm = splitKeySegments(classifiedKey).join('')
    return norm !== 'bearer'
  }
  return true
}

function isSensitiveKeySegments(segments: readonly string[]): boolean {
  if (segments.join('') === 'apikey') {
    // Legacy single-segment spelling: `apikey` with no separators or camel
    // boundaries still counts as an api-key credential.
    return true
  }
  const last = segments[segments.length - 1] ?? ''
  if (last === 'authorization') {
    return true
  }
  if (SENSITIVE_KEY_NORMS.has(segments.join(''))) {
    return true
  }
  if (SECRET_TERMINALS.has(last)) {
    if (last === 'key' || last === 'keys') {
      // A bare key/keys is not enough (`key`, `keys`, `keynote` stay benign),
      // but any recognized qualifier earlier in the same segment sequence
      // makes the compound sensitive. This covers `secret_access_key`,
      // `AWS_SECRET_ACCESS_KEY`, `client_secret_key`, `public_key`, and
      // arbitrary qualifier stacks without hand-listing each spelling.
      for (const segment of segments) {
        if (segment !== last && SECRET_KEY_QUALIFIERS.has(segment)) {
          return true
        }
      }
    } else {
      return true
    }
  }
  if (last === 'id' || last === 'ids') {
    // Round-32 finding 1 (spec row 98): `id`/`ids` is a terminal ONLY when
    // an earlier segment is already credential-shaped (a qualifier or a
    // terminal), so `AWS_SECRET_ACCESS_KEY_ID` redacts while plain `runId`,
    // `scenarioId`, `driverId` stay visible.
    for (const segment of segments) {
      if (segment !== last && (SECRET_KEY_QUALIFIERS.has(segment) || SECRET_TERMINALS.has(segment))) {
        return true
      }
    }
  }
  if (segments.length >= 2) {
    const head = segments[segments.length - 2] ?? ''
    for (const [first, second] of SECRET_PAIRS) {
      if (head === first && last === second) {
        return true
      }
    }
  }
  return false
}

function isSensitiveKey(key: string): boolean {
  // Segment-based classification first: an unsafe separator boundary can hide
  // a high-confidence sensitive segment inside a non-sensitive compound
  // (`foo\tpassword` -> `foo`, `password`).
  const segments = splitKeySegments(key)
  if (isSensitiveKeySegments(segments)) {
    return true
  }
  // Keep the round-9 separator-tolerant comparison too, so merging a boundary
  // into an already-sensitive word (`pass\tword` -> `password`) remains
  // redacted exactly as approved.
  const mergedSegments = splitKeySegments(stripSensitiveKeyIgnorables(key))
  return isSensitiveKeySegments(mergedSegments)
}

// Safe terminal prose punctuation kept after a redacted bare scalar value.
// Ambiguous bare closing punctuation (`]`, `}`, `>`) may be credential
// material, so those closers fail closed and are never echoed; `)` stays as
// clearly safe sentence punctuation.
function isCredentialTrailingPunctuationCode(code: number): boolean {
  return (
    code === 0x2e || // .
    code === 0x2c || // ,
    code === 0x3b || // ;
    code === 0x3a || // :
    code === 0x21 || // !
    code === 0x3f || // ?
    code === 0x29 // )
  )
}

// The transform pipeline is a fixed sequence of independent single-pass stages,
// each linear in the input length, so redaction is O(n) with a small constant
// factor and never loops (no stage feeds its own output back into itself).
// redactTextWithRoots runs them in this order (spec 2.6):
//
//   1. normalizeSeparators          -- one forward pass replacing unsafe C0/DEL/
//                                      C1 controls, line/paragraph separators,
//                                      and Unicode format characters with the
//                                      internal separator sentinel, and
//                                      normalizing CRLF to LF (spec 2.0).
//   2. redactUrlSpans               -- R1: replace every scheme-shaped token
//                                      (raw or percent-encoded scheme spelling,
//                                      plus protocol-relative userinfo) with one
//                                      [REDACTED_URL] marker (spec 2.1).
//   3. redactBearerAndBasic         -- R2 auth-scheme forms: Authorization /
//                                      Bearer / Basic / Digest / unknown-scheme
//                                      credentials (spec 2.2).
//   4. redactCredentialAssignments  -- R2 sensitive-key/value assignments
//                                      (key=value, key: value, quoted forms)
//                                      (spec 2.2).
//   5. redactRoots                  -- replace configured absolute POSIX roots
//                                      with the 0x01-prefixed WORKSPACE/TMP/
//                                      ARTIFACTS aliases (spec 2.0 / 2.6 step 4).
//   6. redactHighEntropyTokens      -- R3: replace bare high-entropy tokens
//                                      (at least 20 code points, Shannon entropy
//                                      at least 4.0 bits/code point, token
//                                      boundaries = R1 boundaries plus brackets)
//                                      with [REDACTED] (spec 2.3).
//   7. sentinel/alias rendering     -- map the separator sentinel to a space and
//                                      the 0x01 alias prefix to "$" (spec 2.6
//                                      step 6).
//
// redactText validates the caller-facing roots once and delegates to
// redactTextWithRoots; projectRedactedJsonValue validates roots ONCE up front
// even when the tree has no string leaves and reuses the same internal stages.

// ---------------------------------------------------------------------------
// R1 — URL whole-token redaction (spec §2.1)
//
// Any scheme://-shaped token (raw or percent-encoded scheme spelling) is
// replaced ENTIRELY by [REDACTED_URL]. No parsing, no preserved host/path/
// query, no userinfo stripping. A span starts at the first byte of the scheme
// run (glued spellings included) and ends at the next trusted boundary;
// separator runs that reassemble the URL (userinfo split across a newline or
// space, a quote with a tail that continues the authority) are INSIDE the
// span, so exactly one marker covers the whole span and no suspect byte
// survives. Fail-closed anomalies are subsumed: whatever the span contains,
// only the marker is emitted.
// ---------------------------------------------------------------------------

const URL_SPAN_SCHEME_RAW = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

// Percent-encoded scheme spellings: the raw run must decode to scheme://.
// Both hex cases are accepted; the raw bytes stay inside the redacted span.
const URL_SPAN_SCHEME_ENCODED = /^[A-Za-z][A-Za-z0-9+.-]*%3[aA]%2[fF]%2[fF]/

let lastSchemeMatchHadGap = false

function rawUrlSpanSchemeLengthAt(text: string, index: number): number {
  lastSchemeMatchHadGap = false
  // Hand-rolled scheme:// matcher with sentinel transparency: separator
  // normalization leaves sentinels inside control-split schemes
  // (`https:\u0000//user:pass@host`), and R1 must still recognize the shape
  // so the whole span is redacted (round-4 contract).
  const length = text.length
  let i = index
  if (i >= length) return 0
  let c = text.charCodeAt(i)
  if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) return 0
  i += 1
  // Whitespace/sentinels are transparent inside the `://` tail (spec §1.2
  // "separator insertion inside scheme spellings"; corpus r04 shape), but a
  // break inside the scheme NAME itself does not reassemble.
  const isSchemeTailGapCode = (code: number): boolean =>
    isSeparatorSentinelCode(code) || code === 0x20 || code === 0x0a

  let sawColon = false
  let slashes = 0
  let schemeChars = 0
  while (i < length) {
    c = text.charCodeAt(i)
    if (isSchemeTailGapCode(c)) {
      if (sawColon || slashes > 0) {
        // Gaps reassemble only the `://` authority separator. Inside the
        // scheme NAME a gap terminates: prose words must never bridge
        // across spaces into a later real scheme.
        lastSchemeMatchHadGap = true
        i += 1
        continue
      }
      // Gap before the colon: only a gap between the complete scheme NAME and
      // its `://` separator reassembles (`ftp  \n ://`), matching spec 1.2
      // "separator insertion inside scheme spellings". A gap inside the name
      // (`ft p://`) has a non-':' next byte and terminates (prose never
      // bridges across spaces).
      let peek = i
      while (peek < length && isSchemeTailGapCode(text.charCodeAt(peek))) {
        peek += 1
      }
      if (peek < length && text.charCodeAt(peek) === 0x3a) {
        lastSchemeMatchHadGap = true
        i = peek
        continue
      }
      return 0
    }
    if (!sawColon) {
      if (c === 0x3a) {
        sawColon = true
        i += 1
        continue
      }
      if (
        (c >= 0x41 && c <= 0x5a) ||
        (c >= 0x61 && c <= 0x7a) ||
        (c >= 0x30 && c <= 0x39) ||
        c === 0x2b ||
        c === 0x2d ||
        c === 0x2e
      ) {
        schemeChars += 1
        // Bounded scheme-name run: without a cap, a long letter run makes the
        // per-position scan quadratic. Real schemes are far shorter.
        if (schemeChars > 24) return 0
        i += 1
        continue
      }
      return 0
    }
    if (c === 0x2f) {
      slashes += 1
      i += 1
      if (slashes === 2) return i - index
      continue
    }
    return 0
  }
  return 0
}

function encodedUrlSpanSchemeLengthAt(text: string, index: number): number {
  if (index >= text.length || text[index] !== '%') {
    // The scheme name itself is raw letters; only the :// part is encoded.
    const match = URL_SPAN_SCHEME_ENCODED.exec(text.slice(index, index + 32))
    return match === null ? 0 : match[0].length
  }
  return 0
}

function isUrlSpanSchemeStartAt(text: string, index: number): boolean {
  return rawUrlSpanSchemeLengthAt(text, index) > 0 || encodedUrlSpanSchemeLengthAt(text, index) > 0
}

// Protocol-relative URL with userinfo shape (spec 2.1 Open Question 3):
// `//user:pass@host/path` carries credential userinfo with no scheme:// and
// redacts ENTIRELY. The `@` must appear BEFORE the first path slash or any
// trusted boundary; `//host/path` and `//host/path@x` (the @ sits in the
// path) stay plain text. Only a `//` at a token start (not glued to a
// preceding word or a `://` scheme) is a candidate.
function hasProtocolRelativeUserinfoAt(text: string, index: number): boolean {
  const length = text.length
  if (index + 2 > length || text.charCodeAt(index) !== 0x2f || text.charCodeAt(index + 1) !== 0x2f) {
    return false
  }
  if (index > 0 && isAsciiWordCharCode(text.charCodeAt(index - 1))) {
    return false
  }
  let i = index + 2
  while (i < length) {
    const code = text.charCodeAt(i)
    if (code === 0x40) return true
    if (code === 0x2f || isUrlSpanBoundaryCode(code)) return false
    i += 1
  }
  return false
}

// Trusted boundaries for a URL span: whitespace (spaces and newlines; other
// controls are already separator sentinels and join the span), quotes,
// backticks, and angle brackets. Prose delimiters stay OUTSIDE the marker;
// a tail that continues the URL shape (leading @, or non-path text whose
// window reaches an @) is swallowed INTO the span.
function isUrlSpanBoundaryCode(code: number): boolean {
  return (
    isSeparatorSentinelCode(code) ||
    code === 0x20 ||
    code === 0x0a ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x60 ||
    code === 0x3c ||
    code === 0x3e
  )
}

// Pre-@ authority reassembly (spec 2.1/2.4): after a scheme:// span the
// userinfo may be split across inserted whitespace/newlines, including
// percent-encoded userinfo reassembled across several gaps. Scan forward from
// the first post-boundary fragment, across whitespace-separated fragments, for
// the authority completion (@) or a strong userinfo signal (a ':' separator or
// a percent-escape). A quote/grave/angle delimiter, a path/query/fragment
// start, a new scheme://, or end of input without any such signal ends the
// reassembly. The return gives the next scan position so the caller continues
// without re-scanning the internal gaps (keeps pathological inputs linear).
function scanUrlAuthorityReassembly(
  text: string,
  from: number,
  gapStart: number,
  seenAt: boolean,
): { swallow: boolean; next: number; seenAt: boolean } {
  const length = text.length
  let k = from
  let lastGap = -1
  let sawColon = false
  // A dangling '%' right before the gap continues an escape split from its
  // own hex ('%' + whitespace + '74'); treat it as percent-encoded material.
  let sawPercent = gapStart > 0 && text.charCodeAt(gapStart - 1) === 0x25
  while (k < length) {
    while (k < length && !isUrlSpanBoundaryCode(text.charCodeAt(k))) {
      const code = text.charCodeAt(k)
      if (code === 0x40) {
        return { swallow: true, next: k + 1, seenAt: true }
      }
      if (code === 0x3a) sawColon = true
      if (code === 0x25) sawPercent = true
      k += 1
    }
    if (k >= length) break
    const boundary = text.charCodeAt(k)
    if (boundary !== 0x20 && boundary !== 0x0a && !isSeparatorSentinelCode(boundary)) {
      // Quote/grave/angle delimiter: prose boundary, not reassembly.
      break
    }
    lastGap = k
    while (
      k < length &&
      (text.charCodeAt(k) === 0x20 ||
        text.charCodeAt(k) === 0x0a ||
        isSeparatorSentinelCode(text.charCodeAt(k)))
    ) {
      k += 1
    }
    if (k >= length) break
    const nextCode = text.charCodeAt(k)
    if (nextCode === 0x2f || nextCode === 0x3f || nextCode === 0x23) break
    if (isUrlSpanSchemeStartAt(text, k)) break
  }
  if (!seenAt && (sawColon || sawPercent)) {
    // Stranded/percent-encoded userinfo: swallow the reassembled fragments but
    // resume at the whitespace before a hard terminator so the caller's
    // boundary handling still decides path/query/new-scheme termination.
    return { swallow: true, next: lastGap >= 0 ? lastGap : k, seenAt: false }
  }
  return { swallow: false, next: 0, seenAt: false }
}
function findUrlSpanEnd(text: string, start: number, schemeLength: number): number {
  const length = text.length
  let seenAt = false
  // The scheme (including any gap-reassembled spelling) is already matched
  // and is unconditionally inside the span; scan from just after it so its
  // internal separator gaps never read as span boundaries.
  let i = start + schemeLength
  while (i < length) {
    const code = text.charCodeAt(i)
    if (!isUrlSpanBoundaryCode(code)) {
      if (code === 0x40) seenAt = true
      i += 1
      continue
    }
    // Boundary reached. Decide whether the tail after the boundary run
    // reassembles this span (fail closed: swallow it) or terminates it.
    let j = i
    while (j < length && isUrlSpanBoundaryCode(text.charCodeAt(j))) j += 1
    if (j >= length) return i
    const tailCode = text.charCodeAt(j)
    if (tailCode === 0x40) {
      // Tail starts with @ (r21/r65/r66): authority reassembly continues.
      i = j
      seenAt = true
      continue
    }
    if (tailCode === 0x2f || tailCode === 0x3f || tailCode === 0x23) {
      // Path/query/fragment shape after the boundary: not authority
      // reassembly; the span terminates here (r89).
      return i
    }
    if (isUrlSpanSchemeStartAt(text, j)) {
      // A new scheme starts after the boundary: independent spans (r88).
      return i
    }
    // Reassembly (spec 2.1/2.4): userinfo split across inserted
    // whitespace/newlines. scanUrlAuthorityReassembly looks across
    // whitespace-separated fragments for the authority completion (@) or a
    // strong userinfo signal (':' separator or a percent-escape). The @-found
    // swallow is unconditional (a later @ in the window still reassembles the
    // authority fail-closed); the ':'/percent swallow applies only before the
    // authority completed (after @, a colon window is prose key:value).
    const reassembly = scanUrlAuthorityReassembly(text, j, i, seenAt)
    if (reassembly.swallow) {
      i = reassembly.next
      seenAt = reassembly.seenAt
      continue
    }
    return i
  }
  return length
}

// Prose punctuation that directly follows a URL span stays OUTSIDE the
// marker (`[REDACTED_URL].` keeps its period), matching the v1 trailing
// punctuation contract for URL tokens.
function isUrlSpanTrailingPunctuationCode(code: number): boolean {
  return (
    code === 0x21 || // !
    code === 0x2c || // ,
    code === 0x2e || // .
    code === 0x3a || // :
    code === 0x3b || // ;
    code === 0x3f || // ?
    code === 0x29 || // )
    code === 0x5d || // ]
    code === 0x7d // }
  )
}

function redactUrlSpans(text: string): string {
  let result = ''
  let cursor = 0
  const length = text.length
  for (;;) {
    let start = -1
    let startSchemeLength = 0
    let scan = cursor
    while (scan < length) {
      // Cheap letter pre-check: a scheme run always starts with an ASCII
      // letter, so non-letter positions skip both matchers (linear scan with
      // a tiny constant; required for multi-hundred-KB event payloads).
      const c0 = text.charCodeAt(scan)
      if ((c0 >= 0x41 && c0 <= 0x5a) || (c0 >= 0x61 && c0 <= 0x7a)) {
        const rawLength = rawUrlSpanSchemeLengthAt(text, scan)
        const schemeLength = rawLength > 0 ? rawLength : encodedUrlSpanSchemeLengthAt(text, scan)
        if (schemeLength > 0) {
          start = scan
          startSchemeLength = schemeLength
          break
        }
      } else if (c0 === 0x2f && hasProtocolRelativeUserinfoAt(text, scan)) {
        // Protocol-relative userinfo token (`//user:pass@host/path`).
        start = scan
        startSchemeLength = 2
        break
      }
      scan += 1
    }
    if (start === -1) {
      result += text.slice(cursor)
      return result
    }
    result += text.slice(cursor, start)
    let end = findUrlSpanEnd(text, start, startSchemeLength)
    while (end > start && isUrlSpanTrailingPunctuationCode(text.charCodeAt(end - 1))) {
      end -= 1
    }
    result += '[REDACTED_URL]'
    cursor = end
  }
}

// ---------------------------------------------------------------------------
// R3 — high-entropy bare tokens (spec §2.3)
//
// A bare token (not inside any R1/R2 span, not a root alias, not a marker)
// whose code-point length is >= HIGH_ENTROPY_TOKEN_MIN_LENGTH and whose
// Shannon entropy over code-point frequencies is >=
// HIGH_ENTROPY_TOKEN_MIN_ENTROPY_BITS_PER_CHAR becomes [REDACTED]. The
// thresholds are compile-time constants (spec §2.3): a deterministic reporter
// must never mutate its redaction thresholds at runtime, so there is no
// configuration surface and no module-global mutable state.
// ---------------------------------------------------------------------------

const HIGH_ENTROPY_TOKEN_MIN_LENGTH = 20
const HIGH_ENTROPY_TOKEN_MIN_ENTROPY_BITS_PER_CHAR = 4.0

function isHighEntropyTokenBoundaryCode(code: number): boolean {
  // Spec §2.3: R3 token boundaries are "the same tokenizer boundaries as R1:
  // whitespace, quotes, backticks, <, >, controls, format chars" — i.e.
  // isUrlSpanBoundaryCode (which folds controls/format chars into the
  // separator sentinel on normalized text). "/" is deliberately NOT a
  // boundary: a standard base64 secret containing "/" must remain one token
  // so it reaches the length and entropy thresholds instead of splitting into
  // sub-20-code-point segments. Bracketing characters are additionally kept
  // as boundaries so R3 never swallows a whole non-sensitive structured
  // container (JSON-ish value, markdown link, function call) into one
  // high-entropy token; the corpus's "non-sensitive containers stay
  // byte-identical" cases depend on this. Root-alias output and redaction
  // markers are handled as trusted atoms by the scanner (see
  // redactHighEntropyTokens), not as part of this boundary predicate.
  return (
    isUrlSpanBoundaryCode(code) ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x7b ||
    code === 0x7d
  )
}

function shannonEntropyBitsPerChar(token: string): number {
  const counts = new Map<string, number>()
  let total = 0
  for (const ch of token) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1)
    total += 1
  }
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / total
    entropy -= p * Math.log2(p)
  }
  return entropy
}

function markerLengthAt(text: string, index: number): number {
  if (text.startsWith('[REDACTED_URL]', index)) return 14
  if (text.startsWith('[REDACTED]', index)) return 10
  return 0
}

// Root-alias atoms are trusted output (pipeline step 4 runs before R3, step 5,
// and §2.3 excludes "a root-alias replacement" from bare-token candidacy).
// R3 copies the whole atom verbatim and treats it as a boundary so the alias
// never glues into a bare-token scan. Two spellings are recognized: the
// internal 0x01 + NAME form emitted during root aliasing, and the rendered
// "$" + NAME form present in engine output on re-entry (§3 lists $WORKSPACE/
// $TMP/$ARTIFACTS as replacement tokens, and §2.6 requires two-pass
// idempotence). Recognizing both keeps an aliased path byte-identical on the
// second pass.
function rootAliasLengthAt(text: string, index: number): number {
  const code = text.charCodeAt(index)
  if (code !== ROOT_ALIAS_PREFIX_CODE && code !== 0x24) return 0
  const next = index + 1
  if (text.startsWith('WORKSPACE', next)) return 1 + 'WORKSPACE'.length
  if (text.startsWith('ARTIFACTS', next)) return 1 + 'ARTIFACTS'.length
  if (text.startsWith('TMP', next)) return 1 + 'TMP'.length
  return 0
}

// Combined trusted-atom length: a redaction marker or a root alias, whichever
// (if any) starts at the given index. Both are copied verbatim and terminate
// any bare-token scan around them (spec §2.3/§2.6/§3 idempotence).
function trustedAtomLengthAt(text: string, index: number): number {
  return markerLengthAt(text, index) || rootAliasLengthAt(text, index)
}

function redactHighEntropyTokens(text: string): string {
  let result = ''
  let cursor = 0
  const length = text.length
  while (cursor < length) {
    // Markers and root aliases are trusted boundaries (spec §3/§2.6): they
    // pass through byte-identical and terminate any bare-token scan around
    // them, so an emitted marker/alias can never be re-redacted and never
    // glues a preceding assignment into one long high-entropy token.
    const atom = trustedAtomLengthAt(text, cursor)
    if (atom > 0) {
      result += text.slice(cursor, cursor + atom)
      cursor += atom
      continue
    }
    if (isHighEntropyTokenBoundaryCode(text.charCodeAt(cursor))) {
      result += text[cursor]
      cursor += 1
      continue
    }
    let end = cursor
    while (end < length && !isHighEntropyTokenBoundaryCode(text.charCodeAt(end))) {
      if (trustedAtomLengthAt(text, end) > 0) break
      end += 1
    }
    const token = text.slice(cursor, end)
    let codePoints = 0
    for (const _ of token) codePoints += 1
    if (codePoints >= HIGH_ENTROPY_TOKEN_MIN_LENGTH && shannonEntropyBitsPerChar(token) >= HIGH_ENTROPY_TOKEN_MIN_ENTROPY_BITS_PER_CHAR) {
      result += '[REDACTED]'
    } else {
      result += token
    }
    cursor = end
  }
  return result
}

// ---------------------------------------------------------------------------
// Fixed pipeline (spec §2.6): validation/normalization, R1 URL spans, R2
// credential/auth spans, root aliasing, R3 bare tokens, sentinel rendering.
// ---------------------------------------------------------------------------

function redactTextWithRoots(text: string, normalized: NormalizedRedactionRoots | undefined): string {
  let result = normalizeSeparators(text)
  result = redactUrlSpans(result)
  result = redactBearerAndBasic(result)
  result = redactCredentialAssignments(result)
  if (normalized !== undefined) {
    result = redactRoots(result, normalized)
  }
  result = redactHighEntropyTokens(result)
  return result.replaceAll(SEPARATOR_SENTINEL, ' ').replaceAll(ROOT_ALIAS_PREFIX, '$')
}

export function redactText(text: string, roots?: RedactionRoots): string {
  if (typeof text !== 'string') {
    throw new TypeError('redactText: text must be a string')
  }
  const normalized = roots === undefined ? undefined : validateRoots(roots)
  return redactTextWithRoots(text, normalized)
}

// ---------------------------------------------------------------------------
// dsh-qa artifact-path projection (dsh-qa-specific addition — diverges from
// the frozen upstream engine; see docs/REDACTION_SPEC.md §7). Artifact/evidence
// paths in a QaRunReport are STRUCTURED fields with known positions, not free
// text: a QA report exists to tell a human where the screenshot, the trace, and
// the evidence live. Routing those paths through the free-text R3 heuristic
// would swallow long high-entropy path tails (e.g.
// /repo/artifacts/qa-full-2026-08-25/computer-visual-observe.png ->
// $ARTIFACTS[REDACTED]), making the report useless.
//
// This is a WHITELIST that is still fail-closed:
//   - if the path resolves (after normalization and symlink/alias
//     canonicalization consistent with the engine's root handling) UNDER a
//     configured redaction root, emit the aliased readable form with NO R3
//     pass over it (an embedded token-shaped segment is therefore ALIASED, not
//     redacted — see the spec for the fail-closed rationale);
//   - otherwise, or on any normalization/validation failure, emit '[REDACTED]'
//     for the WHOLE path. A partially-preserved unknown path is never emitted,
//     and a traversal (.. resolved before the containment check) can never
//     escape into a readable alias.
// Free-text occurrences of paths keep going through the normal engine, R3
// included.
// ---------------------------------------------------------------------------

const ROOT_ALIAS_RENDERED: Record<RootKey, string> = {
  workspace: '$WORKSPACE',
  temp: '$TMP',
  artifacts: '$ARTIFACTS',
}

function isPathWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + '/')
}

export function projectArtifactPath(value: string, normalized: NormalizedRedactionRoots | undefined): string {
  if (normalized === undefined) {
    return '[REDACTED]'
  }
  if (typeof value !== 'string' || value.length === 0) {
    return '[REDACTED]'
  }
  if (WINDOWS_DRIVE_ROOT.test(value) || WINDOWS_UNC_ROOT.test(value)) {
    return '[REDACTED]'
  }
  if (hasUnsafeRootCharacter(value) || !value.startsWith('/')) {
    return '[REDACTED]'
  }
  let resolved: string
  try {
    resolved = normalizeRoot(value)
  } catch {
    return '[REDACTED]'
  }
  // Canonicalize through realpath when the path exists on disk (resolves
  // symlinks and aliases exactly as the engine canonicalizes configured
  // roots); fall back to the resolved spelling when it does not exist yet.
  let candidate: string
  try {
    candidate = normalizeRoot(realpathSync(resolved))
  } catch {
    candidate = resolved
  }
  for (const key of ROOT_KEYS) {
    for (const alias of normalized.aliases[key]) {
      if (isPathWithin(alias, candidate)) {
        const relative = candidate.slice(alias.length).replace(/^\/+/, '')
        return relative.length === 0 ? ROOT_ALIAS_RENDERED[key] : ROOT_ALIAS_RENDERED[key] + '/' + relative
      }
    }
  }
  return '[REDACTED]'
}

export { validateRoots, redactTextWithRoots, isSensitiveKey }
export type { NormalizedRedactionRoots }
