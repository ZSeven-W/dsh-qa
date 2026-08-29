import { projectRedactedJsonValue, projectArtifactPath, redactText, type RedactionRoots } from '../redaction/index.ts';
import type { QaRunReport } from '../contracts.ts';

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

/** Deterministic, redacted report.md content (human-readable). */
export function renderReportMarkdown(report: QaRunReport, roots?: RedactionRoots): string {
  const md = (text: string) => escapeLoneSurrogates(redactText(text, roots));
  const lines: string[] = [];
  lines.push('# QA Replay: ' + md(report.scenario));
  lines.push('');
  lines.push('- **Status**: ' + md(report.status));
  lines.push('- **Driver**: ' + md(report.driver));
  lines.push('- **Schema**: ' + String(report.schemaVersion));
  lines.push('- **Started**: ' + md(report.startedAt));
  lines.push('- **Finished**: ' + md(report.finishedAt));
  lines.push('');
  lines.push('## Steps');
  if (report.steps.length === 0) lines.push('- (none)');
  for (const step of report.steps) {
    const mark = step.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push('- [' + mark + '] step ' + String(step.index) + ': ' + md(step.intent));
    lines.push('  - action: ' + TICK + md(inline(step.action, roots)) + TICK);
    lines.push('  - receipt: ' + md(step.receipt === null ? 'none' : step.receipt.status));
    lines.push('  - assertion: ' + md(step.assertion.kind) + ' -> ' + (step.assertionPassed ? 'PASS' : 'FAIL'));
    lines.push('  - observed: ' + TICK + md(inline(step.observed, roots)) + TICK);
  }
  lines.push('');
  lines.push('## Final assertions');
  if (report.assertions.length === 0) lines.push('- (none)');
  for (const assertion of report.assertions) {
    lines.push(
      '- ' + md(assertion.kind) + ' -> ' + (assertion.passed ? 'PASS' : 'FAIL') +
      ' (observed: ' + TICK + md(inline(assertion.observed, roots)) + TICK + ')',
    );
  }
  if (report.failure !== undefined) {
    lines.push('');
    lines.push('## Failure');
    lines.push('- step: ' + (report.failure.stepIndex === null ? 'final assertion' : String(report.failure.stepIndex)));
    lines.push('- message: ' + md(report.failure.message));
    lines.push('- reproduction: ' + String(report.failure.reproduction.length) + ' step(s)');
  }
  if (report.artifacts !== undefined && report.artifacts.length > 0) {
    lines.push('');
    lines.push('## Artifacts');
    for (const artifact of report.artifacts) {
      // Artifact paths are STRUCTURED fields: projected through the dedicated
      // fail-closed path whitelist (readable alias, no R3 pass), never the
      // free-text engine. The kind label still passes through the engine.
      const projectedPath = projectArtifactPath(artifact.path, roots);
      lines.push('- ' + md(artifact.kind) + ': ' + TICK + escapeLoneSurrogates(projectedPath) + TICK);
    }
  }
  lines.push('');
  return lines.join('\n');
}
