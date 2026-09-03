import { projectRedactedJsonValue, projectArtifactPath, redactText, type RedactionRoots } from '../redaction/index.ts';
import type { QaEvidenceCollectionFailure, QaRunReport, QaViewCompleteness } from '../contracts.ts';

// Backtick character for inline code spans (built from a code point so the
// source stays free of markdown-confusable delimiters).
const TICK = String.fromCharCode(96);

function inline(value: unknown, roots?: RedactionRoots): string {
  return JSON.stringify(projectRedactedJsonValue(value, roots));
}

function escapeControlCodeUnit(code: number): string {
  return '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
}

// Renders every lone (unpaired) UTF-16 surrogate as a visible \uXXXX escape so
// no raw surrogate code unit can reach report.md (spec R4, corpus r11 contract:
// \uDBFF appears, the raw surrogate does not). Valid surrogate pairs survive
// as-is. Redaction runs first; this escaping runs on the redacted text only.
function escapeLoneSurrogates(text: string): string {
  let result = '';
  let index = 0;
  const length = text.length;
  while (index < length) {
    const code = text.charCodeAt(index);
    const ch = text[index] as string;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < length ? text.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += ch + (text[index + 1] as string);
        index += 2;
      } else {
        result += escapeControlCodeUnit(code);
        index += 1;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += escapeControlCodeUnit(code);
      index += 1;
    } else {
      result += ch;
      index += 1;
    }
  }
  return result;
}

/**
 * One line of view-completeness context. It is rendered only for assertions
 * truncation actually touched, and it is what lets a human tell "not present"
 * from "we could not see the whole page".
 */
function completenessLine(completeness: QaViewCompleteness): string {
  return (completeness.reason === undefined ? '' : completeness.reason + ' — ')
    + 'view truncated: ' + String(completeness.truncated)
    + ', node budget: ' + (completeness.nodeBudget === null ? 'driver default' : String(completeness.nodeBudget))
    + ', budget escalated: ' + String(completeness.escalated)
    + ', outcome depends on a complete view: ' + String(completeness.outcomeDependsOnCompleteView)
    + '. ' + completeness.detail;
}

/** The visible glyph every collapsed line terminator becomes (never a real newline). */
const NEWLINE_MARK = '\u23CE';

/** Collapse every Unicode line terminator into one visible glyph. */
function collapseLineTerminators(text: string): string {
  return text
    .replace(/\r\n/gu, '\n')
    .replace(/[\r\n\u000B\u000C\u0085\u2028\u2029]/gu, NEWLINE_MARK);
}

/**
 * Render a prose value so it can only ever appear as inline text, never as
 * Markdown structure. This is the structural-soundness baseline for every
 * page-/model-/scenario-controlled string: redaction runs FIRST (so escaping
 * can never split a secret token the redactor would otherwise miss), and this
 * pass runs on the redacted text only.
 *
 * Beyond the Markdown delimiters it also closes the two HTML-side breaks:
 * raw HTML tags (<br>, <details>, <img onerror>, <script>, <iframe> — a GFM
 * renderer would emit them as live elements) are entity-escaped, and link
 * syntax ([...](...)) is neutralized so a javascript: destination can never be
 * formed. Machine codes stay verbatim on purpose: nothing here escapes
 * underscores (INCONCLUSIVE_TRUNCATED) or plain words (qa_observe, max_nodes).
 */
function escapeMarkdownInline(text: string): string {
  let out = collapseLineTerminators(text);
  // Escape bold and code delimiters so prose cannot become bold or a code span.
  // Single asterisk / underscore are left alone: they only italicize inline
  // text and never create report structure, while escaping every underscore
  // would corrupt machine codes (INCONCLUSIVE_TRUNCATED) and snake_case text.
  out = out.replace(/\*\*/gu, '\\*\\*');
  out = out.replace(/`/gu, '\\`');
  // A leading list/heading marker is escaped defensively (it only matters if a
  // caller ever places the value at the start of a rendered line).
  out = out.replace(/^(\s*)([-+])(?=\s|$)/u, '$1\\$2');
  out = out.replace(/^(\s*)(#{1,6})(?=\s|$)/u, '$1\\$2');
  out = out.replace(/^(\s*)(\d+)([.)])(?=\s|$)/u, '$1$2\\$3');
  // HTML: ampersand FIRST (so the entities emitted below are never
  // double-escaped, and a page-controlled "&lt;" cannot smuggle a raw "<" past
  // this pass), then the angle brackets themselves.
  out = out.replace(/&/gu, '&amp;');
  out = out.replace(/</gu, '&lt;');
  out = out.replace(/>/gu, '&gt;');
  // Dangerous URI scheme: "javascript:alert(1)" has no "//" so R1 URL
  // redaction leaves it in the text. Even inert text must not read as a URL.
  out = out.replace(/javascript:/giu, 'javascript&#58;');
  // Link syntax: an escaped "[" can never open a link label, and the "]("
  // pair — the only place a destination can attach — gets a backslash BETWEEN
  // the brackets so the two characters can never be adjacent again. Plain
  // parentheses elsewhere are left alone (they are inert text).
  out = out.replace(/\]\(/gu, ']\\(');
  out = out.replace(/\[/gu, '\\[');
  out = out.replace(/\]/gu, '\\]');
  // Our OWN redaction markers are trusted output: restore them so a human
  // still reads [REDACTED] / [REDACTED_URL] — but never when the marker is
  // directly followed by "(" (a page-controlled paren would turn the restored
  // marker into a link label; the escaped form renders identically and cannot).
  out = out.replace(/\\\[REDACTED\\\](?!\()/gu, '[REDACTED]');
  out = out.replace(/\\\[REDACTED_URL\\\](?!\()/gu, '[REDACTED_URL]');
  return out;
}

/**
 * Render already-redacted text inside a backtick code span. The fence is one
 * backtick longer than the longest run of backticks inside, so embedded
 * backticks can never close the span early, and line terminators are collapsed
 * first so the value can never break out of the span either.
 */
function fencedCode(text: string): string {
  const flat = collapseLineTerminators(text);
  let maxRun = 0;
  for (const match of flat.matchAll(/`+/gu)) {
    if (match[0].length > maxRun) maxRun = match[0].length;
  }
  const fence = TICK.repeat(maxRun + 1);
  return fence + flat + fence;
}

/** Narrow the run report's evidence union to the structured collection-failure marker. */
function isEvidenceCollectionFailure(value: QaRunReport['evidence']): value is QaEvidenceCollectionFailure {
  return value !== null && (value as { status?: unknown }).status === 'collection-failed';
}

/** Deterministic, redacted report.md content (human-readable). */
export function renderReportMarkdown(report: QaRunReport, roots?: RedactionRoots): string {
  // Redaction runs FIRST, then lone-surrogate escaping, then (for structural
  // positions) Markdown escaping. Never the other way around: escaping a
  // control character before redaction could split a secret token the redactor
  // needs to see whole.
  const redact = (text: string) => escapeLoneSurrogates(redactText(text, roots));
  const mdInline = (text: string) => escapeMarkdownInline(redact(text));
  const mdCode = (text: string) => fencedCode(redact(text));
  const mdPath = (path: string) => fencedCode(escapeLoneSurrogates(path));
  const lines: string[] = [];
  lines.push('# QA Replay: ' + mdInline(report.scenario));
  lines.push('');
  lines.push('- **Status**: ' + mdInline(report.status));
  lines.push('- **Driver**: ' + mdInline(report.driver));
  lines.push('- **Schema**: ' + String(report.schemaVersion));
  lines.push('- **Started**: ' + mdInline(report.startedAt));
  lines.push('- **Finished**: ' + mdInline(report.finishedAt));
  const receipts = report.receiptSummary;
  lines.push('- **Receipts**: ' + String(receipts.confirmed) + ' confirmed, ' + String(receipts.unknown) + ' unknown, ' + String(receipts.rejected) + ' rejected, ' + String(receipts.failed) + ' failed');
  if (receipts.warning !== undefined) {
    lines.push('- **Warning**: ' + mdInline(receipts.warning));
  }
  if (report.settle !== undefined) {
    const settle = report.settle;
    lines.push(
      '- **Settle policy**: budget ' + String(settle.budgetMs) + 'ms, quiet ' + String(settle.quietMs)
      + 'ms, post-change quiet ' + String(settle.postChangeQuietMs) + 'ms, interval ' + String(settle.intervalMs) + 'ms',
    );
  }
  lines.push('');
  lines.push('## Steps');
  if (report.steps.length === 0) lines.push('- (none)');
  for (const step of report.steps) {
    const mark = step.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push('- [' + mark + '] step ' + String(step.index) + ': ' + mdInline(step.intent));
    lines.push('  - action: ' + mdCode(inline(step.action, roots)));
    lines.push('  - receipt: ' + mdInline(step.receipt === null ? 'none' : step.receipt.status));
    lines.push('  - outcome: ' + mdInline(step.outcome));
    lines.push('  - assertion: ' + mdInline(step.assertion.kind) + ' -> ' + (step.assertionPassed ? 'PASS' : 'FAIL'));
    lines.push('  - observed: ' + mdCode(inline(step.observed, roots)));
    if (step.attempts !== undefined) {
      lines.push('  - assertion retries: ' + String(step.attempts) + ' attempt(s) over ' + String(step.elapsedMs ?? 0) + 'ms');
    }
    if (step.reason !== undefined) {
      lines.push('  - reason: ' + mdInline(step.reason));
    }
    if (step.completeness !== undefined) {
      lines.push('  - view completeness: ' + mdInline(completenessLine(step.completeness)));
    }
  }
  lines.push('');
  lines.push('## Final assertions');
  if (report.assertions.length === 0) lines.push('- (none)');
  for (const assertion of report.assertions) {
    lines.push(
      '- ' + mdInline(assertion.kind) + ' -> ' + (assertion.passed ? 'PASS' : 'FAIL') +
      ' (observed: ' + mdCode(inline(assertion.observed, roots)) + ')',
    );
    if (assertion.attempts !== undefined) {
      lines.push('  - assertion retries: ' + String(assertion.attempts) + ' attempt(s) over ' + String(assertion.elapsedMs ?? 0) + 'ms');
    }
    if (assertion.reason !== undefined) {
      lines.push('  - reason: ' + mdInline(assertion.reason));
    }
    if (assertion.completeness !== undefined) {
      lines.push('  - view completeness: ' + mdInline(completenessLine(assertion.completeness)));
    }
  }
  if (report.advisory !== undefined && report.advisory.length > 0) {
    lines.push('');
    // The whole section is MODEL-GENERATED output, and its narration is not
    // observed fact: a live vision run returned the correct verdict and then
    // described a logo that was not on the page. The heading says the section
    // is model-generated and advisory; each reasoning string is rendered as a
    // labelled blockquote so a human triaging the report cannot mistake
    // narration for something the run observed.
    lines.push('## Advisory (model-generated; never affects pass/fail)');
    lines.push('');
    lines.push(
      'Model-generated output from the host vision model. Trust **verdict** and **confidence**; ' +
      'every "model narration" block below is UNVERIFIED model narration that may contain ' +
      'fabricated detail and must never be quoted as observed fact.',
    );
    lines.push('');
    for (const item of report.advisory) {
      lines.push('- question: ' + mdInline(item.question));
      lines.push('  - verdict: ' + mdInline(item.verdict) + ' (confidence ' + String(item.confidence) + ')');
      if (item.captureSettled === false) {
        lines.push('  - capture settled: false (the advisory verdict is over a view that never stopped changing within the settle budget)');
      }
      lines.push('  - model narration (unverified; may contain fabricated detail):');
      const narration = redact(item.reasoning);
      // Redaction runs first (redact), then Markdown/HTML escaping, then the
      // blockquote prefix is applied per line so a multi-line narration cannot
      // break out of the quote and cannot smuggle HTML or a link inside it.
      for (const line of narration === '' ? ['(none)'] : narration.split('\n')) {
        lines.push('    > ' + escapeMarkdownInline(line));
      }
      if (item.reason !== undefined) lines.push('  - reason: ' + mdInline(item.reason));
      if (item.artifact !== undefined) {
        const projectedPath = projectArtifactPath(item.artifact.path, roots);
        lines.push('  - artifact: ' + mdPath(projectedPath));
      }
    }
  }
  if (report.failure !== undefined) {
    lines.push('');
    lines.push('## Failure');
    lines.push('- step: ' + (report.failure.stepIndex === null ? 'final assertion' : String(report.failure.stepIndex)));
    lines.push('- message: ' + mdInline(report.failure.message));
    if (report.failure.code !== undefined) {
      lines.push('- code: ' + mdInline(report.failure.code));
    }
    lines.push('- reproduction: ' + String(report.failure.reproduction.length) + ' step(s)');
  }
  if (report.evidence !== null) {
    lines.push('');
    lines.push('## Evidence');
    const evidence = report.evidence;
    if (isEvidenceCollectionFailure(evidence)) {
      lines.push('- collection: failed (' + mdInline(evidence.reason) + ')');
    } else {
      lines.push('- console: ' + String(evidence.console.length) + ' record(s)');
      lines.push('- network: ' + String(evidence.network.length) + ' record(s)');
      lines.push('- bounded: ' + String(evidence.bounded));
      if (evidence.dropped !== undefined) {
        lines.push('- dropped: console ' + String(evidence.dropped.console) + ', network ' + String(evidence.dropped.network));
      }
      if (evidence.computer !== undefined) {
        const computer = evidence.computer;
        lines.push('- computer helper: ' + mdInline(computer.status.helper) + ' (platform ' + mdInline(computer.status.platform) + ')');
        if (computer.receiptsTotal === null) {
          lines.push('- receipt counters: unavailable (' + mdInline(computer.receiptsCountersUnavailableReason ?? 'unknown') + ')');
        } else {
          lines.push('- receipts: ' + String(computer.receiptsReturned) + ' returned (of ' + String(computer.receiptsTotal) + ' total; ' + String(computer.receiptsDropped) + ' dropped by the bounded ring)');
        }
      }
    }
  }
  if (report.artifacts !== undefined && report.artifacts.length > 0) {
    lines.push('');
    lines.push('## Artifacts');
    for (const artifact of report.artifacts) {
      // Artifact paths are STRUCTURED fields: projected through the dedicated
      // fail-closed path whitelist (readable alias, no R3 pass), never the
      // free-text engine. The kind label still passes through the engine.
      const projectedPath = projectArtifactPath(artifact.path, roots);
      lines.push('- ' + mdInline(artifact.kind) + ': ' + mdPath(projectedPath));
    }
  }
  lines.push('');
  return lines.join('\n');
}