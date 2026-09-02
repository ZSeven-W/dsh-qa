<!--
PROVENANCE: This document originated in dsh-driver-bench at commit a7af98d
(branch feat/v0.1), file docs/REDACTION_SPEC.md. It was ported verbatim into
dsh-qa as the normative specification for the fail-closed v2 redaction engine
in src/redaction/. The body below is preserved unchanged from the source.
-->

# Redaction Specification — v2 (Phase 1 draft)

- Repository: `dsh-driver-bench`
- Branch: `feat/v0.1` · base commit: `fb180fd`
- Scope of this phase: **specification only.** This document produces no code changes. Implementation (Phase 2) is forbidden until the owner approves this spec at the manual review gate.
- Status: **DRAFT — awaiting owner review.**

The v1 blacklist-style engine in `src/reporters/json.ts` went through 32 adversarial rounds without
converging. The owner-approved v2 direction is **fail-closed whole-value redaction**: instead of
parsing URLs and credentials to preserve the "safe" remainder, v2 replaces every suspicious span
with one unparameterized marker and never re-emits suspect bytes.

---

## 1. Threat Model

### 1.1 What the reporter protects

The redaction layer is the last trust boundary before bench artifacts leave the process. It protects
everything that flows to the three reporter sinks:

- **JSON report** — `renderJson` (`src/reporters/json.ts`): serializes a `BenchRun` (environment,
  results, summary, failure messages, artifact paths, driver metadata, run identity) to a report file.
- **JSONL event log** — `appendEvent` (`src/reporters/events.ts`): appends one compact JSON object
  per runtime event.
- **Markdown report** — `renderMarkdown` (`src/reporters/markdown.ts`): renders the projected run as
  a byte-stable Markdown document.

All three sinks project their input through `projectRedactedJsonValue` (`json.ts`), which is built
on the text primitive `redactText`. Rules R1–R5 apply uniformly at that projection layer, so all
three report formats inherit the same guarantees.

### 1.2 Adversary capabilities

Reporter inputs (event payloads, environment, scenario fields, failure messages, hard violations,
artifact paths, driver/commit metadata) are attacker-influenced strings. The adversary may embed, in
any value:

- **Credential material** — API keys, passwords, tokens, `Authorization` header values, `Bearer` /
  `Basic` / `Digest` / unknown auth schemes, AWS-style compound keys.
- **Encodings** — percent-encoding (upper/lower/mixed hex), standard and URL-safe base64 (padded and
  unpadded), non-ASCII and mixed-script characters, control and Unicode format characters (NUL, tab,
  NBSP, soft hyphen, zero-width marks, lone surrogates).
- **Line breaks and inserted whitespace** — CR/LF, CRLF, and separator insertion inside scheme
  spellings, sensitive keys, auth phrases, and URL authorities so the secret reassembles only after
  normalization (`http://user:pass\n@host/path`).
- **Quote nesting** — embedded quotes in quoted credentials (`token='it's secret'`), tails after the
  closing quote (`token="abc"def456`), multiline quoted values.
- **URL forms** — `http(s)://` and `file://` with userinfo, percent-encoded userinfo
  (`user%3Apass%40host`), percent-encoded scheme spellings (`http%3A%2F%2F…` — currently **leaks
  verbatim in v1**), split/stranded authorities, nested schemes, encoded query/fragment separators,
  glued URLs (`abchttp://…`).
- **Key spellings** — sensitive keys with camelCase, plurals, separators (`_`, `-`, `.`, `/`,
  `:`, whitespace, controls), percent-encoded key bytes, flattened dotted keys, id-suffixed
  credential keys (`AWS_SECRET_ACCESS_KEY_ID`).

### 1.3 Trust boundary

Reporter inputs are **untrusted**. Nothing at or below the redaction layer may be serialized
verbatim. The engine's contract is per-value containment: for every projected string leaf and every
projected value subtree, either the output is byte-identical to input that the engine has classified
as safe, or the entire value/span is replaced by a marker. There is no "best effort" fallback that
re-emits bytes the engine failed to understand (R4).

---

## 2. Core Rules (v2 baseline)

Principles: **fail-closed** (when in doubt, redact the whole span), **prefer over-redaction**
(replacing too much is a spec-compliant bug; leaking one byte is a violation), **no parsing of URLs**
(R1 replaces the entire token; parsing-based preservation is deferred to v2.1).

### 2.0 Retained v1 baseline (unchanged by v2)

The following v1 behaviors carry over verbatim and remain normative; v2 removes or replaces only
what R1–R5 explicitly say it does:

- **Root validation and aliasing** — `RedactionRoots` must be plain data objects (Proxy rejected
  before any trap fires), absolute POSIX paths, free of NUL/control/format characters, non-duplicate
  after canonicalization; Windows drive/UNC spellings rejected; symlink aliases and non-normalized
  spellings (`/tmp/./ws`) are registered so the canonical real path redacts too. Plain-text root
  paths are replaced by `$WORKSPACE` / `$TMP` / `$ARTIFACTS`.
- **Separator normalization** — C0 controls except LF, DEL/C1, line/paragraph separators, and all
  Unicode format characters become safe spaces (internal sentinel) before scanning; CRLF is
  normalized to LF; runs collapse without joining tokens. (URL-adjacent controls were dropped inside
  URLs in v1; under v2 the whole URL span is redacted anyway.)
- **Structural validation** — `normalizeJsonValue`-style rejection of undefined, non-finite numbers,
  bigints, functions, symbols, accessors, sparse/non-plain objects, Proxies (including revoked),
  cycles, and excessive depth; errors are deterministic and never echo key spellings or value bytes
  (this clause resolves round-32 finding 2, see §4 rows 99).
- **Key segmentation infrastructure** — `splitKeySegments` (percent-decode for classification,
  boundary separators `.` `/` `:` whitespace/controls/format chars, `_`/`-` splits, camelCase
  splits, lowercase), `stripSensitiveKeyIgnorables` merge pass, `decodePercentForClassification`.
- **Serializers** — deterministic compact JSON with code-unit-lexical key order
  (`serializeJsonValue`), lone surrogates rendered as visible `\uXXXX` escapes (never raw bytes),
  Markdown escaping, `__proto__`/`constructor` own data keys read through descriptors only, single
  trailing LF.
- **`appendEvent` file discipline** — regular files only, `O_WRONLY|O_APPEND|O_CREAT` with
  O_NONBLOCK, per-inode serialization queue, LF separation of pre-existing content, no mode widening.
- **Marker idempotence** — an existing `[REDACTED]` / `[REDACTED_URL]` in the input is a trusted
  boundary and passes through byte-identical (§2.6).

### 2.1 R1 — URL whole-token redaction

**Any token with a `scheme://` shape is replaced ENTIRELY by `[REDACTED_URL]`.** No parsing, no
preserved host/path/query/fragment, no userinfo stripping, no WHATWG canonicalization.

- **Scheme shape**: `[A-Za-z][A-Za-z0-9+.-]*://` (case-insensitive), including percent-encoded
  scheme spellings where `%3A`/`%3a` decodes to `:` and `%2F`/`%2f` decodes to `/`
  (classification-only decode; the raw bytes remain inside the span). Glued spellings
  (`abchttp://…`) are in scope: the span starts at the first byte of the maximal scheme run.
- **Reassembly across inserted whitespace/newlines**: when the scheme shape is followed by separator
  material and the text after the separators continues the URL shape (userinfo, `@`, authority,
  path/query/fragment), the separators are INSIDE the span. The whole extended span — scheme through
  the next trusted boundary — becomes ONE `[REDACTED_URL]`.
- **Anomalies inside the span** (embedded `"`/`'`/`<`/`>`/`\`` before authority
  completion, nested `://` schemes, `@` ambiguity, encoded query/fragment starts, `%00` octets,
  malformed escapes, lone surrogates): fail closed over the whole span — one `[REDACTED_URL]`, no
  byte of the span survives. Prose delimiters that terminate a URL token (surrounding quotes,
  markdown `<…>`, balanced container closers) stay OUTSIDE the marker:
  `see "https://u:p@h/x" here` → `see "[REDACTED_URL]" here`.
- **`file://`** URLs are treated exactly like every other scheme: whole token → `[REDACTED_URL]`.
  The v1 behavior of decoding the pathname and aliasing a configured root inside a preserved
  `file://` token is **removed**; root aliasing now applies only to plain-text paths (§2.0).
- **Note for v2.1 (explicitly deferred)**: a pure-host whitelist (URL parses cleanly AND no userinfo
  AND no query/fragment AND pure-ASCII host/path) that would preserve a benign URL is **out of scope
  for v2**. v2 redacts all `scheme://` tokens; v2.1 may re-insert the whitelist on top of the R1
  span machinery without changing the fail-closed baseline.
- **Protocol-relative userinfo (DECIDED, Open Question 3)**: a token starting with `//` that
  contains `@` BEFORE the first path slash (userinfo shape, e.g. `//user:pass@host/path`) is
  redacted ENTIRELY as `[REDACTED_URL]`; no byte of the authority survives. All other
  protocol-relative and localhost-relative forms (`//host/path`, `//host/path@x` where the `@`
  sits after the first path slash) stay plain text (root aliasing still applies inside them).
- Out of R1's shape: scheme-only forms without `//` (`mailto:…`).

This is the central simplification of v2 and the main behavior change versus v1: v1 preserved
host/path and stripped userinfo/query/fragment; v2 replaces the whole token (§4, all Δ=YES rows).

### 2.2 R2 — Sensitive key/value whole-value redaction

Keep the existing normalized segmented key matching exactly as implemented in v1, and on match
replace the **ENTIRE value** with `[REDACTED]`.

- **Classifier inventory (verbatim, v1 semantics retained)**:
  - `SECRET_TERMINALS`: `key`, `keys`, `token`, `tokens`, `secret`, `secrets`,
    `password`, `passwords`, `passphrase`, `passphrases`, `passwd`.
  - `SECRET_KEY_QUALIFIERS`: `secret`, `access`, `api`, `private`, `public`, `session`,
    `client`, `consumer`, `app`, `auth`, `id`, `refresh`, `bearer`, `aws`.
  - `SECRET_PAIRS`: `[api,key]`, `[api,keys]`, `[access,token]`, `[refresh,token]`,
    `[client,secret]`, `[db,password]`.
  - `SENSITIVE_KEY_NORM_BASES`: `privatekey`, `secretkey`, `accesskey`, `credential`, `jwt`,
    `authtoken`, `idtoken`, `sessiontoken`, `sessionkey`, `passphrase`, `apikey`,
    `password`, `clientsecret`, `accesstoken`, `refreshtoken`, `dbpassword`.
  - `SENSITIVE_KEY_NORMS`: `{authorization, bearer}` ∪ every base ∪ every base + `s`.
  - Classification rules (rounds 17/28/29 generalization): a key is sensitive when its normalized
    segment sequence (after segmentation, percent-decode-for-classification, camelCase splitting, and
    the ignorable-merge pass) satisfies any of: whole-sequence `apikey`; last segment
    `authorization`; whole sequence in `SENSITIVE_KEY_NORMS`; last segment in
    `SECRET_TERMINALS` where `key`/`keys` additionally requires a recognized qualifier earlier
    in the sequence; last two segments in `SECRET_PAIRS`.
- **Text forms** (free text `redactText`): `key=value`, `key: value`, quoted forms
  (`key="value"`, `key='value'`, multiline quoted values, embedded quotes, tails after the closing
  quote), repeated/malformed separators (`==`, `= =`, `: :`), spaced keys (`api key = v`,
  `"my password" = v`), punctuated keys (`password! = v`), keys with embedded controls/tabs/NBSP/
  soft hyphens, percent-encoded key bytes, flattened dotted/slashed keys (`api.key=`,
  `api/key=`, `user.password`). The **key spelling is preserved**; only the value is replaced.
- **Auth-scheme forms** (subset of R2, v1 contract retained): `Authorization: <scheme> <token>` for
  `Bearer`, `Basic`, `Digest` (with parameters), and any unknown scheme; continuation tokens
  (space/comma/newline-separated); underscore-wrapped phrases (`_Bearer S3CR3T_`); control-split
  scheme words (`Bea\x00rer abc123`); non-ASCII tokens and suffixes; quoted tokens with tails. On
  match: `Authorization: Bearer [REDACTED]` — the scheme word and surrounding quotes survive, the
  entire credential value becomes `[REDACTED]` (for `Digest`/unknown schemes the whole parameter
  tail becomes `[REDACTED]`, so the output is `Authorization: [REDACTED]`).
- **JSON projection**: when an object key classifies sensitive (same `isSensitiveKey` classifier, no
  duplicate key list) — or when the key's own redacted text differs from the original key (the key
  itself carried credential material) — the **ENTIRE value subtree** (scalar, array, or nested
  object, whatever its depth) is replaced by the string `"[REDACTED]"`. Only leaf values under
  non-sensitive keys are recursed into.

Round-32 finding 1 (`AWS_SECRET_ACCESS_KEY_ID`) is **not covered** by this inventory — the terminal
`id` is not in `SECRET_TERMINALS`. Resolution is Open Question 1.

### 2.3 R3 — High-entropy bare tokens

A bare token (one not already claimed by an R1 span, an R2 credential/key span, or a root-alias
replacement) is replaced by `[REDACTED]` when **both**:

1. its length is **≥ 20 code points** (after separator normalization; token boundaries are the same
   tokenizer boundaries as R1: whitespace, quotes, backticks, `<`, `>`, controls, format chars), and
2. its Shannon entropy is **≥ 4.0 bits per code point**, computed over the token's code-point
   frequencies: `H = −Σ p(i) · log₂ p(i)`.

**Thresholds (compile-time constants):** `HIGH_ENTROPY_TOKEN_MIN_LENGTH = 20`,
`HIGH_ENTROPY_TOKEN_MIN_ENTROPY_BITS_PER_CHAR = 4.0`. They are fixed constants, not a runtime
configuration surface: a deterministic reporter must never mutate its redaction thresholds at
runtime, so there is no configuration setter and no module-global mutable state.

Notes:
- The corpus record-only secret `AKIAIOSFODNN7EXAMPLE` measures ≈ 3.90 bits/code point (20 code
  points, 14 distinct symbols), so it is **deliberately below** the proposed R3 threshold; its
  redaction depends on R2 (Open Question 1), not R3.
- The markers themselves (`[REDACTED]` = 10, `[REDACTED_URL]` = 14 code points) are below the
  length floor, so R3 can never re-redact engine output (idempotence, §2.6).
- R3 is fail-closed at the margin: entropy computed over the normalized token, and any token at or
  above both thresholds is redacted even when it is plausibly benign (see Open Question 4 for the
  documented over-redaction consequences, e.g. standard-base64 blobs measure ≥ 4.0 bits/char). A
  40-hex commit hash does **not** reach this floor: its bits/char measures ≈ 3.68–3.88 in practice
  (maximum 3.971, since 40 is not divisible by 16), so it is never redacted by R3.

### 2.4 R4 — Fail-closed semantics

Any parse failure, encoding ambiguity, or structural anomaly replaces the **entire suspicious span**.
The engine never falls back to emitting suspect bytes verbatim.

**"Span" for text** — a maximal contiguous region of the normalized text that the engine must not
echo, starting at the first byte of the suspicious region (scheme run for R1; credential value start
for R2; first byte after the last trusted boundary for an anomaly) and ending at the **next trusted
boundary**. Trusted boundaries are: start/end of input; an existing `[REDACTED]` /
`[REDACTED_URL]` marker (idempotent re-entry); ordinary ASCII whitespace, quotes, backticks,
`<`/`>`, and proven prose container closers (`)` `]` `}` with a matching prose opener) when
they do not sit inside a suspicious region; a root-alias replacement. Inserted separators that
reassemble a suspicious region (R1 split URLs, R2 control-split keys/auth phrases) are INSIDE the
span: the engine emits exactly one marker per span and preserves no byte from within it. When the
span cannot be delimited unambiguously (nested scheme, delimiter before authority completion,
unterminated quote, `%00`/malformed escape, lone surrogate, mixed encodings), the span extends
forward to the next trusted boundary and everything in between is replaced.

**"Span" for JSON** — the value subtree rooted at the matched key, replaced by `"[REDACTED]"`.
Structural anomalies (non-plain objects, Proxies including revoked, accessors, sparse arrays, cycles,
non-finite numbers, excessive depth, projected-key collisions, invalid roots) fail the **whole**
projection with a deterministic error whose message carries only structural positions (indices or a
`<key>` placeholder) — never a key spelling and never value bytes (round-32 finding 2).

**Encoding ambiguity**: a `%`-escape error, lone surrogate, or mixed-encoding byte sequence inside
a suspicious span fails closed to the span marker. Outside any suspicious span, lone surrogates and
controls are never emitted raw by any reporter: JSON/JSONL render them as visible `\uXXXX` escapes
and Markdown renders the escaped form (round-11 contract: `\uDBFF` appears, the raw surrogate does
not).

### 2.5 R5 — Out of scope

v2 does **not** promise defense against a secret deliberately split across multiple unrelated report
fields (e.g. half the secret in `environment.FOO` and half in `results[0].message`) or reassembled
post-hoc by the report consumer.

**Reasoning**: the engine's containment boundary is a single projected value — one string leaf or one
value subtree. R2/R4 replace whole values precisely so that boundary is well-defined; defending
cross-field reassembly would require correlating unrelated fields, which is arbitrary program
composition the reporter cannot distinguish from legitimate data and would force redacting entire
reports. The owner-approved scope is single-value containment.

### 2.6 Rule precedence and idempotence

Processing order per value (a fixed pipeline, never a loop):

1. validation of roots/normalization (reject before any scan),
2. R1 URL spans → `[REDACTED_URL]`,
3. R2 credential/auth-scheme and sensitive-key spans → `[REDACTED]`,
4. root aliasing on remaining plain text → `$WORKSPACE`/`$TMP`/`$ARTIFACTS`,
5. R3 bare high-entropy tokens → `[REDACTED]`,
6. final separator-sentinel rendering (sentinel → space).

Markers are trusted on every later stage and on re-entry: for any engine output `y`,
`redactText(y)` must equal `y` (two-pass fixed point; corpus r21 asserts this invariant).

---

## 3. Output Vocabulary

The complete set of replacement tokens, with exact byte spellings:

| Token | Bytes (hex) | Used by | Semantics |
| --- | --- | --- | --- |
| `[REDACTED]` | `5B 52 45 44 41 43 54 45 44 5D` | R2 value redaction, R3 bare tokens | generic redaction marker |
| `[REDACTED_URL]` | `5B 52 45 44 41 43 54 45 44 5F 55 52 4C 5D` | R1 only | URL-span redaction marker |
| `$WORKSPACE` | `24 57 4F 52 4B 53 50 41 43 45` | retained v1 root aliasing | workspace root alias |
| `$TMP` | `24 54 4D 50` | retained v1 root aliasing | temp root alias |
| `$ARTIFACTS` | `24 41 52 54 49 46 41 43 54 53` | retained v1 root aliasing | artifacts root alias |

Contract for all markers:

- ASCII only, case-sensitive, unparameterized — never `[REDACTED:…]`, never a count, never a
  fragment of the original bytes.
- Both redaction markers are shorter than R3's length floor, so no marker can ever be re-redacted.
- A marker appearing in input is a trusted boundary: it passes through byte-identical (idempotence).
- No other replacement tokens exist. Visible `\uXXXX` / JSON escape forms are serializer output,
  not redaction markers.

---

## 4. Corpus Expectation Table

This table is the **acceptance oracle for Phase 2**. It covers every case in
`test/redaction-corpus.test.ts` at `fb180fd` — **100 `test()` declarations in total: 97 active
(fixed-and-green) plus 3 skipped RECORD-ONLY placeholders from round 32.** The count was verified by
counting `test(` declarations in the file (100, of which 3 carry `skip:`).

Columns:

- **Surface** — the entry point each case exercises: `redactText` (free text),
  `projectRedactedJsonValue` (projection), `renderJson`, `renderMarkdown`, `appendEvent`
  (JSONL), or a structural/rejection contract.
- **v1 current** — the exact current-engine output (probed at `fb180fd`) or the current contract.
- **v2 expected** — the exact expected output under this spec, or a precise derivation rule where the
  input is dynamic. Where a rule is ambiguous, the fail-closed default was chosen and is noted.
- **Δ** — `YES` = output bytes change under v2; `ACTIVATE` = RECORD-ONLY placeholder becomes an
  active assertion in Phase 2; `no` = byte-identical to v1.

All quoted outputs are single strings; `\n` denotes a literal newline byte. In the `v1 current`
column, `$TMP` etc. are the root aliases for the roots the test supplies.

| # | Corpus test | Surface | v1 current | v2 expected | Δ |
| --- | --- | --- | --- | --- | --- |
| 1 | r01 non-ASCII first char in Bearer | redactText | `Authorization: Bearer [REDACTED]` | same | no |
| 2 | r01 non-ASCII suffix after ASCII token | redactText | `Authorization: Bearer [REDACTED]` | same | no |
| 3 | r01 appendEvent non-ASCII auth headers | appendEvent | `{"header":"Authorization: Bearer [REDACTED]","header2":"Authorization: Bearer [REDACTED]"}` + LF | same | no |
| 4 | r06 quoted Authorization closing quote | redactText | `foo="Authorization: Bearer [REDACTED]"` (closing quote preserved) | same | no |
| 5 | r06 quoted Basic closing quote | redactText | `"Authorization: Basic [REDACTED]"` | same | no |
| 6 | r06 percent-encoded remote file userinfo | redactText | `[REDACTED_URL]` | same | no |
| 7 | r06 percent-encoded local file userinfo | redactText | `file://localhost/$TMP/x` | `[REDACTED_URL]` (whole token; root alias no longer visible inside URL) | YES |
| 8 | r07 multiline quoted token value | redactText | `token="[REDACTED]"` | same | no |
| 9 | r07 multiline quoted Authorization Bearer | redactText | `Authorization: "[REDACTED]"` | same | no |
| 10 | r07 projection multiline credentials | projection | `{"note":"Authorization: \"[REDACTED]\""}` | same | no |
| 11 | r08 control byte in sensitive word | redactText | `pass word=[REDACTED]` | same | no |
| 12 | r08 control byte in sensitive object key | projection | key normalized to `token `, value `"[REDACTED]"` | same | no |
| 13 | r08 control byte in root path | redactText | `$TMP/x` | same | no |
| 14 | r08 control byte in Bearer scheme | redactText | `Bea rer [REDACTED]` | same | no |
| 15 | r08 non-ASCII suffix after Bearer (no header) | redactText | `Bearer [REDACTED]` | same | no |
| 16 | r08 non-ASCII suffix after Basic (no header) | redactText | `Basic [REDACTED]` | same | no |
| 17 | r09 soft-hyphen separated JSON key | projection | `{"pass word":"[REDACTED]"}` | same | no |
| 18 | r09 deeply nested credential chain | redactText | `password=` × 3999 then final `password=[REDACTED]` | same (derivation rule; linear, no crash) | no |
| 19 | r09 renderMarkdown redacted summary metrics | renderMarkdown | first line `Overall: PASS`; `token` metric value redacted (`"[REDACTED]"`), rendered | same | no |
| 20 | r09 appendEvent separates file w/o trailing LF | appendEvent | pre-existing `{"old":1}` then `{"old":1}\n{"new":2}\n` | same | no |
| 21 | r09 roots with NUL/control rejected | redactText | throws `/control\|NUL\|format/` before scanning | same | no |
| 22 | r10 tab inside sensitive key (text) | redactText | `foo password=[REDACTED]` | same | no |
| 23 | r10 tab inside sensitive key (projection) | projection | `{"foo password":"[REDACTED]"}` | same | no |
| 24 | r10 split URL userinfo, newline before @ | redactText | `http://[REDACTED]\n@host/path` | `[REDACTED_URL]` (reassembled span, one marker) | YES |
| 25 | r10 split URL userinfo, angle delimiter | redactText | `http://[REDACTED] <@host/path` | `[REDACTED_URL]` | YES |
| 26 | r10 split file URL userinfo before @ | redactText | `file://localhost/$TMP/x` | `[REDACTED_URL]` | YES |
| 27 | r11 POSIX root ending in backslash | redactText | `$WORKSPACE/x` (exact raw spelling) | same | no |
| 28 | r11 renderMarkdown lone surrogate | renderMarkdown | output contains `\uDBFF`, raw surrogate absent | same (visible escape contract, R4) | no |
| 29 | r12 split userinfo, newline + text | redactText | `http://[REDACTED]\n@host/path` | `[REDACTED_URL]` | YES |
| 30 | r12 split userinfo, space + text | redactText | `http://[REDACTED] @host/path` | `[REDACTED_URL]` | YES |
| 31 | r12 spaced sensitive key (raw text) | redactText | `api key = [REDACTED]` | same | no |
| 32 | r12 spaced sensitive key (embedded JSON) | redactText | `{"api key": "[REDACTED]"}` | same | no |
| 33 | r13 assignment inside quoted non-sensitive value | redactText | `data="password=[REDACTED]"` | same | no |
| 34 | r13 appendEvent write-only existing file | appendEvent | appends `{"new":2}\n`, old bytes untouched | same | no |
| 35 | r14 unknown Authorization scheme | redactText | `Authorization: [REDACTED]` | same | no |
| 36 | r14 Digest Authorization parameters | redactText | `Authorization: [REDACTED]` (whole parameter tail) | same | no |
| 37 | r14 stranded userinfo with nested http(s) | redactText | `[REDACTED_URL]` | same | no |
| 38 | r14 stranded file userinfo with nested http(s) | redactText | `[REDACTED_URL]` | same | no |
| 39 | r14 NBSP-separated sensitive key (text) | redactText | `pass\u00a0word=[REDACTED]` | same | no |
| 40 | r14 NBSP-separated sensitive key (JSON) | redactText | `{"pass\u00a0word":"[REDACTED]"}` | same | no |
| 41 | r14 Proxy run values rejected | projection | throws `/non-plain\|proxy/i`, 0 traps fired | same | no |
| 42 | r15 Bearer continuation token | redactText | `Authorization: Bearer [REDACTED]` | same | no |
| 43 | r15 comma-separated Bearer continuation | redactText | `Authorization: Bearer [REDACTED]` | same | no |
| 44 | r15 newline-separated Bearer continuation | redactText | `Authorization: Bearer [REDACTED]` | same | no |
| 45 | r15 Proxy redaction roots rejected | redactText | throws `/Proxy\|plain object/`, 0 traps fired | same | no |
| 46 | r16 quoted credential tail after quote | redactText | `token="[REDACTED]"` | same | no |
| 47 | r16 single-quoted credential, embedded quote | redactText | `token='[REDACTED]'` | same | no |
| 48 | r16 Bearer quoted token tail | redactText | `Bearer "[REDACTED]"` | same | no |
| 49 | r16 revoked proxy fails closed | projection | throws `/non-plain\|proxy\|lossless/i` | same | no |
| 50 | r17 camelCase passWord key | redactText | `passWord=[REDACTED]` | same | no |
| 51 | r17 plural apikeys key | redactText | `apikeys=[REDACTED]` | same | no |
| 52 | r17 plural secretKeys key | redactText | `secretKeys=[REDACTED]` | same | no |
| 53 | r17 assignment-shaped object key | projection | `{"token: [REDACTED]":"[REDACTED]"}` | same | no |
| 54 | r17 Authorization-shaped object key | projection | `{"Authorization: Bearer [REDACTED]":"[REDACTED]"}` | same | no |
| 55 | r17 renderMarkdown own __proto__ metric | renderMarkdown | renders without invoking `__proto__` setter | same | no |
| 56 | r18 repeated `==` separator | redactText | `token =[REDACTED]` | same | no |
| 57 | r18 spaced `= =` separator | redactText | `token = [REDACTED]` | same | no |
| 58 | r18 repeated `: :` separator | redactText | `token : [REDACTED]` | same | no |
| 59 | r18 repeated separator, quoted secret | redactText | `password ="[REDACTED]"` | same | no |
| 60 | r19 quoted spaced sensitive key | redactText | `"my password" = [REDACTED]` | same | no |
| 61 | r19 structured spaced sensitive key | projection | `{"my password":"[REDACTED]"}` | same | no |
| 62 | r19 roots containing newline rejected | redactText | throws `/control\|NUL\|format/` | same | no |
| 63 | r20 symlink-canonicalized root alias | redactText | canonical real path redacted via alias (`$WORKSPACE/secret.txt`) | same | no |
| 64 | r21 delimiter tail before @ (userinfo) | redactText | `https://[REDACTED]"@evil` | `[REDACTED_URL]` (whole span incl. `"@evil`) | YES |
| 65 | r21 delimiter tail before @ (root) | redactText | `[REDACTED_URL]` | same | no |
| 66 | r21 split URL sanitization two-pass stable | redactText | once = `https://[REDACTED]"@evil`, twice equal | once = `[REDACTED_URL]`, twice equal (idempotence invariant kept) | YES |
| 67 | r21 dotted flattened key (projection) | projection | `{"user.password":"[REDACTED]"}` | same | no |
| 68 | r21 renderJson dotted flattened key | renderJson | `user.password` key preserved, value `"[REDACTED]"` | same | no |
| 69 | r21 punctuated sensitive key | redactText | `password! = [REDACTED]` | same | no |
| 70 | r22 percent-encoded colon in key (text) | redactText | `foo%3Atoken=[REDACTED]` | same | no |
| 71 | r22 percent-encoded underscore in key | projection | `{"api%5Fkey":"[REDACTED]"}` | same | no |
| 72 | r22 percent-encoded URL query fragment | redactText | `https://example.com/path` | `[REDACTED_URL]` (whole token; no partial preservation) | YES |
| 73 | r23 doubled-slash file URL traversal | redactText | `file:///x/$TMP/../y` | `[REDACTED_URL]` | YES |
| 74 | r24 Markdown bold-wrapped root | redactText | `**$TMP**` | same | no |
| 75 | r26 single-underscore Bearer | redactText | `_Bearer [REDACTED]_` | same | no |
| 76 | r26 single-underscore Basic | redactText | `_Basic [REDACTED]_` | same | no |
| 77 | r26 double-underscore Bearer | redactText | `__Bearer [REDACTED]__` | same | no |
| 78 | r26 appendEvent rejects non-regular target | appendEvent | rejects `/regular file/` (`/dev/null`) | same | no |
| 79 | r27 hash-preceded root | redactText | `#$TMP/x` | same | no |
| 80 | r27 question-mark-preceded root | redactText | `?$TMP/y` | same | no |
| 81 | r27 exclamation-preceded root | redactText | `!$TMP/z` | same | no |
| 82 | r28 dot-flattened api.key | redactText | `api.key=[REDACTED]` | same | no |
| 83 | r28 slash-flattened api/key | redactText | `api/key=[REDACTED]` | same | no |
| 84 | r28 dot-flattened key in embedded JSON | redactText | `{"api.key":"[REDACTED]"}` | same | no |
| 85 | r29 AWS_SECRET_ACCESS_KEY text | redactText | `AWS_SECRET_ACCESS_KEY=[REDACTED]` | same | no |
| 86 | r29 AWS_SECRET_ACCESS_KEY structured | projection | `{"environment":{"AWS_SECRET_ACCESS_KEY":"[REDACTED]"}}` | same | no |
| 87 | r29 renderJson AWS compound key | renderJson | value `"[REDACTED]"` inside `environment` | same | no |
| 88 | r29 stranded split URL before nested http(s) | redactText | `[REDACTED_URL]\nhttp://example.com/path` | `[REDACTED_URL]\n[REDACTED_URL]` (both tokens whole-redacted) | YES |
| 89 | r29 stranded split URL before slash path | redactText | `[REDACTED_URL]\n/foo@example.com/path` | same — the scheme-less tail `/foo@example.com/path` has no `scheme://` shape and stays; fail-closed applies to suspicious spans only | no |
| 90 | r29 non-normalized root spelling | redactText | `$WORKSPACE/file` | same | no |
| 91 | r30 encoded http(s) userinfo | redactText | `http://example.com/path` | `[REDACTED_URL]` | YES |
| 92 | r30 encoded file userinfo with NUL prefix | redactText | `file://localhost/$WORKSPACE/path` | `[REDACTED_URL]` | YES |
| 93 | r30 scheme-adjacent split http | redactText | `http://[REDACTED] @host/path` | `[REDACTED_URL]` | YES |
| 94 | r30 scheme-adjacent split https | redactText | `https://[REDACTED]\n@host/path` | `[REDACTED_URL]` | YES |
| 95 | r30 scheme-adjacent split file | redactText | `file://localhost/$WORKSPACE/path` | `[REDACTED_URL]` | YES |
| 96 | r30 write-only JSONL append separator | appendEvent | pre-existing `{"old":1}` then `{"old":1}\n{"a":1}\n` | same | no |
| 97 | r31 split URL query/fragment after split userinfo | redactText | `https://[REDACTED]\n@example.com/path` | `[REDACTED_URL]` (query `?session=abc123` swallowed with the span) | YES |
| 98 | r32 RECORD-ONLY finding 1: id-suffixed credential keys | redactText | SKIPPED; v1 leaks `AWS_SECRET_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE` verbatim | `AWS_SECRET_ACCESS_KEY_ID=[REDACTED]` via R2, per the Open Question 1 recommended option (qualified `id` terminal); depends on the owner's answer to Q1 (and would also redact via R3 only if Q2 lowers the entropy floor ≤ 3.9) | ACTIVATE |
| 99 | r32 RECORD-ONLY finding 2: error paths echo identifier-shaped keys | projection | SKIPPED; v1 throws `projectRedactedJsonValue: key collision at $.hunter2` (leaks the identifier-shaped key in the path) | projection of `{ hunter2: { 'token: a': 1, 'token: b': 2 } }` still fails closed with a key collision (both inner keys project to `token: [REDACTED]`), but the error path is structural-only — it never contains `hunter2` or any other key spelling (R4 JSON span) | ACTIVATE |
| 100 | r32 RECORD-ONLY finding 3: renderMarkdown inherited getters | renderMarkdown | SKIPPED; inherited `summary` getter fires | renderMarkdown reads own enumerable data descriptors only; no inherited getter ever fires (`calls` stays `[]`) | ACTIVATE |

**Change summary (state the numbers):**

- Corpus size: **100 cases** — 97 active, 3 RECORD-ONLY skips.
- Cases whose output bytes change under v2: **17** of the 97 active cases (rows 7, 24, 25, 26, 29,
  30, 64, 66, 72, 73, 88, 91, 92, 93, 94, 95, 97). Every one of them is an R1 whole-token URL
  redaction replacing v1's partial preservation; all still satisfy their secret-absence assertions.
- Cases byte-identical to v1: **80** active cases.
- RECORD-ONLY cases activated in Phase 2: **3** (rows 98–100), pending the owner's answers to Open
  Questions 1 and 2 (row 98) — the other two are resolved directly by R4 (rows 99, 100).
- Where the v1 column says `same`, Phase 2 must produce byte-identical output to today's engine;
  any deviation is a spec violation.

---

## 5. Open Questions for Owner Review

The following decisions block Phase 2 and must be made at the manual review gate.

1. **(a) Round-32 finding 1 — `id`-suffixed credential keys (`AWS_SECRET_ACCESS_KEY_ID`).**
   Should `id`/`ids` become a new terminal under R2, and if so with what reach? Options:
   - **Recommended (adopted as the provisional default in row 98):** add `id`/`ids` to
     `SECRET_TERMINALS` but only classify when an earlier segment of the same key is already
     credential-shaped (a `SECRET_KEY_QUALIFIERS` member or another terminal appears before it), so
     `AWS_SECRET_ACCESS_KEY_ID` redacts while plain `runId`, `scenarioId`, `driverId` stay
     visible.
   - Add `id`/`ids` as an unconditional terminal — maximum fail-closed, but every `*Id` field in
     every report (including the bench's own `runId`) becomes `[REDACTED]`.
   - Defer to v2.1 and keep the case skipped.
2. **(b) R3 entropy thresholds.** Confirm the proposed defaults — token length ≥ **20 code points**
   AND Shannon entropy ≥ **4.0 bits/code point** — or pick alternatives (e.g. 4.5 spares uniform-hex
   tokens such as 40-char commit hashes; ≤ 3.9 makes R3 alone cover
   `AKIAIOSFODNN7EXAMPLE`). The thresholds are compile-time constants (§2.3); there is no runtime
   configuration surface to confirm.
3. **(c) Protocol-relative and bare localhost-relative URLs — DECIDED.** A protocol-relative token
   starting with `//` that contains `@` BEFORE the first path slash (userinfo shape, e.g.
   `//user:pass@host/path`) is redacted ENTIRELY as `[REDACTED_URL]`. All other protocol-relative
   and localhost-relative forms (`//host/path`, and `//host/path@x` where the `@` sits after the
   first path slash) stay plain text (root aliasing still applies inside them). This exception is
   codified in §2.1 R1.
4. **(d) Over-redaction that might be too aggressive** (each is a deliberate fail-closed choice in
   this spec; owner may soften via the v2.1 whitelist):
   - Benign `http(s)://` URLs with no userinfo are now fully redacted (rows 72, 88, 91; v1 kept
     `https://example.com/path`). Rationale: R1 forbids parsing; the v2.1 pure-host whitelist is the
     designated restoration path.
   - Local `file://` URLs lose root aliasing and become `[REDACTED_URL]` wholesale (rows 7, 26, 73,
     92, 95). Rationale: no parsing in v2; the `$TMP` alias previously shown inside the URL no
     longer appears.
   - Split/stranded URL tails (`\n@host/path`, ` <@host/path`, query tails) are swallowed with
     the span (rows 24, 25, 29, 30, 93, 94, 97). Rationale: preserving any tail byte risks a later
     pass re-reading it as URL/credential material.
   - R3 at 4.0 bits/char redacts base64 blobs that appear as bare tokens under non-sensitive keys,
     but not 40-hex commit hashes (which measure ≈ 3.68–3.88 bits/char, at most 3.971, so they stay
     below the floor). Rationale: fail-closed prefers over-redaction; Q2 can raise the floor.
   - If Q1's recommended option is approved, qualified `id` terminals redact
     `aws_access_key_id`-style keys everywhere, including in free text.
   - **DECIDED — commit identity:** bench-generated report metadata must present commit identity
     as a git **short hash** (≤ 12 chars). A full 40-hex commit hash is **not** redacted by R3 (it
     measures ≈ 3.68–3.88 bits/char, at most 3.971, below the 4.0 floor); the short-hash spelling is
     required as a standalone formatting decision. Reporters must emit the short hash; no engine
     change is required for this.
5. **(e) Marker vocabulary.** Keep the two-marker vocabulary (`[REDACTED]` vs `[REDACTED_URL]`)
   as specified in §3? Recommended: yes — the distinct URL marker preserves the class of the redacted
   material and is the hook for the v2.1 whitelist.
6. **(f) R2 key spelling in text output.** Confirm that sensitive key spellings remain visible in
   text output (`token=[REDACTED]`), with only the value replaced — the v1 contract the corpus's
   exact-output assertions (rows 4, 5) depend on.

---

## DoD checklist

- [x] `docs/REDACTION_SPEC.md` created; sections 1–5 complete; code identifiers verbatim.
- [x] Expectation table covers all 100 corpus cases (97 active + 3 RECORD-ONLY); count stated in §4
      and cross-checked against `test/redaction-corpus.test.ts`.
- [ ] `pnpm typecheck && pnpm test` fully green (spec-only change; run as proof before commit).
- [ ] Committed as ONE commit with the exact message `docs: draft redaction spec v2`.
- [ ] Phase 2 (implementation) is FORBIDDEN until the owner approves this spec manually.

---

## 7. dsh-qa-specific additions (DIVERGES from the frozen upstream)

This section is **dsh-qa-specific** and is **not** present in
dsh-driver-bench's `docs/REDACTION_SPEC.md` at the frozen base `a7af98d` (nor in
the synced fixes `23b0546` / `4642e38`). It is the normative contract for a seam
that exists only in dsh-qa.

### 7.1 Artifact-path projection (fail-closed whitelist)

A QA report's whole job is to tell a human where the screenshot, the trace, and
the evidence live. Routing those paths through the free-text R3 heuristic makes
the report useless: a long, high-entropy path tail such as
`$ARTIFACTS/qa-full-2026-08-25/computer-visual-observe.png` measures ≥ 4.0
bits/code point and is swallowed whole as `$ARTIFACTS[REDACTED]`.

Artifact paths in a `QaRunReport` are **structured fields with known positions**
(`report.artifacts[].path`), not free text. They are projected through a
dedicated **path projection** (`projectArtifactPath` in `src/redaction/engine.ts`,
re-exported from `src/redaction/index.ts`) rather than the free-text engine.
Only `report.artifacts[].path` and `report.advisory[].artifact.path` are routed
this way (both are structured fields with known positions in `QaRunReport`);
every other string leaf —
including free-text occurrences of paths inside messages, console output, and
evidence blobs — keeps going through the normal engine with R3 enabled
(over-redaction there stays acceptable).

The path projection is a **whitelist that is still fail-closed**:

1. Normalize the path (POSIX resolution), then canonicalize it through
   `realpath` when it exists, exactly as the engine canonicalizes configured
   roots (symlink/alias spellings are covered by the root alias set).
2. If the canonical/resolved path sits **under** a configured redaction root
   (`$WORKSPACE` / `$TMP` / `$ARTIFACTS`), emit the aliased readable form
   (`$ARTIFACTS/qa-full-2026-08-25/computer-visual-observe.png`) with **no R3
   pass** over it.
3. Otherwise — the path does not resolve under a configured root, or any
   normalization/validation step fails (relative path, Windows drive/UNC,
   NUL/control/format characters, non-string, no configured roots) — emit
   `[REDACTED]` for the **whole** path. A partially-preserved unknown path is
   never emitted.

**Embedded credential decision (documented):** a path under a configured root
whose segments contain a credential-shaped value (e.g. a token-shaped
high-entropy segment) is **aliased readably, not redacted**. Rationale against
fail-closed: the path projection's fail-closed boundary is *containment* — it
emits a value only when the path provably resolves under a configured root and
otherwise redacts the whole path — not *content screening*. Re-introducing R3
(or any entropy heuristic) over path segments would defeat the projection's
purpose, because R3 cannot distinguish a token-shaped segment from a benign
descriptive filename (`computer-visual-observe.png` itself measures ≥ 4.0
bits/char). The structured path field is tool-owned (produced by dsh-qa's own
artifact writer, not attacker-influenced free text), and the adversarial
free-text surface remains fully covered by the normal engine with R3 enabled.

**Traversal:** canonicalization resolves `..` before the containment check, so
`<root>/../../etc/passwd` normalizes outside the root and is `[REDACTED]` whole;
the literal alias-shaped string `$ARTIFACTS/../../etc/passwd` is not an absolute
path and is `[REDACTED]` whole. A traversal can never escape into a readable
alias.

### 7.2 Schema

`QaRunReport.artifacts` is an optional array of `{ path, kind }` records
(`src/contracts.ts`). `path` is the structured artifact path routed through the
projection above; `kind` is a free-text label (`screenshot` / `trace` /
`evidence`) that still passes through the normal engine.

### 7.3 Advisory narration provenance (`QaAdvisoryResult.reasoning`)

An advisory visual finding carries the vision model's `verdict`, its
`confidence`, and a free-text `reasoning` string. The two are **not** equally
trustworthy, and that is a measured fact, not a precaution.

**Live evidence.** Against a real capture of the current Wikipedia header,
`deepseek-v4-flash-vision-exp` was asked whether a serif "WIKIPEDIA" wordmark
was present. It answered the CORRECT verdict `yes` at confidence 1.00, and then
narrated "...with the puzzle globe logo" — a logo that is **not** on that page
(the header currently shows the wordmark plus a numeric 25th-anniversary puzzle
piece). A separate assertion in the same session asked whether the puzzle globe
was present and correctly answered `no` at 0.97. The verdict was reliable; the
narration around it was fabricated.

**Decision.** The reasoning is KEPT — it is useful triage context — but every
artifact must mark it as model narration rather than observation:

1. **Schema (`report.json` / `report.jsonl`).** The field `reasoning` keeps its
   name and meaning (no silent rename, no broken consumer), and every
   `QaAdvisoryResult` carries the ADJACENT flag
   `reasoningTrust: "unverified-model-narration"`
   (`QA_ADVISORY_REASONING_TRUST` in `src/contracts.ts`). The flag is additive:
   `schemaVersion` stays `1`, because an added field cannot break a reader of
   the previous shape, while a rename would. A machine consumer that reads
   `reasoning` sees the trust code sitting beside it in the same record — in
   `report.json`, in each `report.jsonl` line, and in the `qa_assert` visual tool
   result.
2. **`report.md`.** The section heading is
   `## Advisory (model-generated; never affects pass/fail)`, followed by a
   notice that `verdict` and `confidence` are the model's answer while every
   narration block is unverified. Each finding renders its reasoning under
   `model narration (unverified; may contain fabricated detail):` as a
   blockquote, one `> ` prefix per line, so it is visually distinct from the
   observed, deterministic facts above it. The per-line Markdown/HTML
   escaping of §7.4 is applied to each narration line BEFORE the `> ` prefix
   (on the already-redacted text), so a narration cannot smuggle HTML or a
   link inside the quote either.
3. **Redaction is unchanged.** `question`, `reasoning`, and `reason` remain
   ordinary free-text leaves: they pass through the normal engine (R1–R4, R3
   enabled) in every artifact, exactly like before. The blockquote prefix is
   applied to the ALREADY-REDACTED text, per line, so labelling can never
   reorder or bypass redaction, and a secret placed in the model's reasoning
   still cannot reach `report.md`, `report.json`, or `report.jsonl`.
4. **Determinism is unchanged.** `advisory` stays excluded from
   `normalizeReportForDeterminism` by schema (`src/replay/determinism.ts`), so
   the new field cannot affect a determinism comparison.

### 7.4 Markdown structural escaping (`report.md`)

§2.0's retained-v1 "Markdown escaping" baseline is implemented in dsh-qa by
`src/reporters/markdown.ts`, and it is stronger than the upstream sentence
implies: it is a **structural-soundness** pass, not just surrogate hygiene.

Every page-/model-/scenario-controlled string rendered into a structural
position — scenario name, step intent, node name/role/tag (inside the `action`
and `observed` JSON), assertion kind, failure message, advisory
question/verdict, artifact kind labels — is escaped so it **cannot** create a
new line, a heading, a list item, or a `**Status**` / `[PASS]` / `[FAIL]` line.
Concretely:

1. **Line terminators** (CR, LF, CRLF, U+000B, U+000C, U+0085, U+2028, U+2029)
   are collapsed to a single visible glyph (`⏎`, U+23CE), so a value can never
   start a new Markdown line.
2. **Emphasis/code delimiters** (`*`, `_`, backtick) are backslash-escaped in
   inline prose positions, so a value can never become bold/italic/code.
3. **Leading list/heading markers** (`-`, `+`, `#`, `N.` / `N)`) are
   backslash-escaped defensively, in case a caller ever places a value at the
   start of a rendered line.
4. **Code-span positions** (the redacted JSON for `action` / `observed`, and
   artifact paths) are wrapped in a backtick fence one backtick longer than the
   longest run of backticks inside, so an embedded backtick can never close the
   span early.
5. **HTML.** `&` is entity-escaped first, then `<` and `>` become `&lt;` /
   `&gt;`, so page/model-controlled text can never emit a live HTML element
   (`<br>`, `<details>`, `<img onerror>`, `<script>`, `<iframe>`) when
   `report.md` is rendered as HTML, and a page-controlled `&lt;` cannot smuggle
   a raw `<` past the pass. The `javascript:` URI scheme is neutralized
   (`javascript:alert(1)` has no `//`, so R1 URL redaction leaves it) so it can
   never read as a URL even as inert text.
6. **Link syntax.** `[` and `]` are backslash-escaped, and a `](` pair gets the
   backslash BETWEEN the brackets, so a link label can never open and a
   destination can never attach — page text can never form a link, and the two
   characters `]` and `(` can never be adjacent in the output. The engine's OWN
   trusted redaction markers are then restored (`[REDACTED]`,
   `[REDACTED_URL]`) so reports stay human-readable — but only when the marker
   is not directly followed by `(`, so a restored marker can never become a
   link label. Machine codes stay verbatim: underscores are never escaped
   (`INCONCLUSIVE_TRUNCATED`), and plain words like `qa_observe` / `max_nodes`
   are untouched.

**Ordering invariant.** Redaction runs FIRST, then lone-surrogate escaping, then
Markdown escaping — never the other way around. Escaping a control character
before redaction could split a secret token the redactor needs to see whole;
this is locked by a test (a secret embedded next to a newline is still
redacted). The advisory-narration blockquote (§7.3) applies the same escaping
per line, then its `> ` prefix, on the already-redacted text, so a multi-line
narration cannot break out of the quote.

**Source hardening.** `intentFor` / the exported step intent in
`src/explore/export.ts` additionally normalizes line terminators to `⏎` at
export time, so a page-controlled node name cannot smuggle a raw newline into
the scenario file's `intent`. This is in ADDITION to the renderer escaping,
which is mandatory regardless; the semantic target used for Replay matching is
stored separately in `action` / `assert` and is never normalized.
