// dsh-qa artifact-path projection tests (dsh-qa-specific addition — see
// docs/REDACTION_SPEC.md §7). These pin the fail-closed whitelist contract for
// report.artifacts[].path: a configured-root path stays readable (aliased, no
// R3 pass), an unconfigured path is redacted whole, and a traversal can never
// escape into a readable alias.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectArtifactPath } from '../src/redaction/index.ts'
import { writeReports } from '../src/reporters/index.ts'

const roots = { workspace: '/ws', temp: '/private/tmp/run', artifacts: '/art' } as const

test('projectArtifactPath emits a readable alias for a long high-entropy path tail', () => {
  // The measured upstream failure: the tail 'qa-full-2026-08-25/computer-visual-
  // observe.png' is >= 20 code points and >= 4.0 bits/char, so the free-text R3
  // heuristic would swallow it. The path projection must not.
  const p = '/art/qa-full-2026-08-25/computer-visual-observe.png'
  assert.equal(projectArtifactPath(p, roots), '$ARTIFACTS/qa-full-2026-08-25/computer-visual-observe.png')
})

test('projectArtifactPath redacts an unconfigured path whole', () => {
  assert.equal(projectArtifactPath('/etc/passwd', roots), '[REDACTED]')
  assert.equal(projectArtifactPath('/other/dir/evidence.png', roots), '[REDACTED]')
  // A relative path is not under any absolute root: redacted whole.
  assert.equal(projectArtifactPath('artifacts/x.png', roots), '[REDACTED]')
})

test('projectArtifactPath aliases (does not redact) an embedded token-shaped segment under a root', () => {
  // Documented decision (spec §7.1): the path projection performs NO R3 pass, so a
  // token-shaped high-entropy segment under a configured root is ALIASED readably,
  // not redacted. The whitelist's fail-closed boundary is containment, not content
  // screening; re-introducing R3 would re-eat benign descriptive filenames.
  const secret = 'S5SuLfXMO3+5kBEReV51oeMX1hciACz6Xg'
  assert.equal(projectArtifactPath('/art/' + secret, roots), '$ARTIFACTS/' + secret)
})

test('projectArtifactPath redacts traversal attempts whole', () => {
  // '..' is resolved before the containment check: the path normalizes outside the
  // root and is redacted whole.
  assert.equal(projectArtifactPath('/art/../../etc/passwd', roots), '[REDACTED]')
  // The literal alias-shaped string is not an absolute path: redacted whole.
  assert.equal(projectArtifactPath('$ARTIFACTS/../../etc/passwd', roots), '[REDACTED]')
})

test('projectArtifactPath is fail-closed when no roots are configured', () => {
  assert.equal(projectArtifactPath('/art/x.png', undefined), '[REDACTED]')
})

test('projectArtifactPath canonicalizes symlinked roots and inputs', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-qa-path-sym-'))
  try {
    const real = join(base, 'real')
    await mkdir(join(real, 'art'), { recursive: true })
    const link = join(base, 'art-link')
    await symlink(join(real, 'art'), link)
    await writeFile(join(real, 'art', 'shot.png'), 'x')
    const symRoots = { workspace: join(base, 'ws'), temp: join(base, 'tmp'), artifacts: link }
    // Input spelled through the symlink alias.
    assert.equal(projectArtifactPath(join(link, 'shot.png'), symRoots), '$ARTIFACTS/shot.png')
    // Input spelled through the canonical real path.
    assert.equal(projectArtifactPath(join(real, 'art', 'shot.png'), symRoots), '$ARTIFACTS/shot.png')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('projectArtifactPath redacts a symlink under a root that points outside it', async () => {
  // Regression (Medium, coverage-only): the happy-path symlink test above proves
  // aliasing of a symlinked ROOT; this pins the escape case. A symlink placed
  // UNDER the artifacts root that realpaths OUTSIDE it must project to
  // [REDACTED] whole. projectArtifactPath realpaths the candidate before the
  // containment check, so this is already the behavior - the test just makes
  // sure a regression that kept the happy path green cannot drop it silently.
  const base = await mkdtemp(join(tmpdir(), 'dsh-qa-path-escape-'))
  try {
    const artifacts = join(base, 'artifacts')
    const outside = join(base, 'outside')
    await mkdir(artifacts, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'x')
    const roots = { workspace: join(base, 'ws'), temp: join(base, 'tmp'), artifacts }

    // A file symlink under the artifacts root pointing at an outside file.
    const fileLink = join(artifacts, 'escape-link')
    await symlink(join(outside, 'secret.txt'), fileLink)
    assert.equal(projectArtifactPath(fileLink, roots), '[REDACTED]')

    // A directory symlink under the artifacts root pointing at the outside dir.
    const dirLink = join(artifacts, 'escape-dir')
    await symlink(outside, dirLink)
    assert.equal(projectArtifactPath(join(dirLink, 'secret.txt'), roots), '[REDACTED]')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

function makeReport(artifacts) {
  return {
    schemaVersion: 1,
    scenario: 'artifact-path-run',
    driver: 'computer',
    status: 'pass',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    steps: [],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0, total: 0 },
    artifacts,
  }
}

test('configured-root long path stays readable in report.json/.md/.jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-e2e-'))
  try {
    const artifactsRoot = join(dir, 'artifacts')
    await mkdir(artifactsRoot, { recursive: true })
    const longPath = join(artifactsRoot, 'qa-full-2026-08-25', 'computer-visual-observe.png')
    const report = makeReport([
      { path: longPath, kind: 'screenshot' },
      { path: join(artifactsRoot, 'trace.json'), kind: 'trace' },
    ])
    const roots = { workspace: join(dir, 'ws'), temp: join(dir, 'tmp'), artifacts: artifactsRoot }
    const paths = await writeReports(report, { directory: join(dir, 'out'), roots })
    const json = await readFile(paths.json, 'utf8')
    const md = await readFile(paths.markdown, 'utf8')
    const jsonl = await readFile(paths.jsonl, 'utf8')

    const alias = '$ARTIFACTS/qa-full-2026-08-25/computer-visual-observe.png'
    assert.ok(json.includes(alias), 'report.json must contain the readable alias')
    assert.ok(md.includes(alias), 'report.md must contain the readable alias')
    assert.ok(jsonl.includes(alias), 'report.jsonl must contain the readable alias')
    assert.ok(!json.includes(longPath), 'report.json must not leak the raw path')
    assert.ok(!md.includes(longPath), 'report.md must not leak the raw path')
    assert.ok(!jsonl.includes(longPath), 'report.jsonl must not leak the raw path')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('unconfigured path becomes [REDACTED] whole in report.json/.md/.jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-path-e2e2-'))
  try {
    const artifactsRoot = join(dir, 'artifacts')
    await mkdir(artifactsRoot, { recursive: true })
    const outsidePath = join(dir, 'outside', 'evidence.png')
    const report = makeReport([{ path: outsidePath, kind: 'evidence' }])
    const roots = { workspace: join(dir, 'ws'), temp: join(dir, 'tmp'), artifacts: artifactsRoot }
    const paths = await writeReports(report, { directory: join(dir, 'out'), roots })
    const json = await readFile(paths.json, 'utf8')
    const md = await readFile(paths.markdown, 'utf8')
    const jsonl = await readFile(paths.jsonl, 'utf8')

    assert.ok(json.includes('[REDACTED]'), 'report.json must redact the unconfigured path')
    assert.ok(md.includes('[REDACTED]'), 'report.md must redact the unconfigured path')
    assert.ok(jsonl.includes('[REDACTED]'), 'report.jsonl must redact the unconfigured path')
    assert.ok(!json.includes(outsidePath), 'report.json must not leak the raw path')
    assert.ok(!md.includes(outsidePath), 'report.md must not leak the raw path')
    assert.ok(!jsonl.includes(outsidePath), 'report.jsonl must not leak the raw path')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
