// Report files are written to a path the CALLER chooses (qa_replay_run's
// output directory). docs/REDACTION_SPEC.md has always required the sinks to
// be regular files opened append-only without widening their mode — but that
// clause described dsh-driver-bench's `appendEvent`, a function this package
// does not have. QA's writers used plain writeFile/appendFile, which follow a
// symlink and will happily open a FIFO.
//
// The redaction engine decides what bytes are safe to emit. This decides WHERE
// they are allowed to land. A report containing screenshots paths, URLs and
// observed values must not be delivered through a symlink into somewhere else,
// and must not block forever on a FIFO nobody reads.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, symlink, readFile, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeReports } from '../src/reporters/index.ts'

function report() {
  return {
    schemaVersion: 1,
    scenario: 'write discipline',
    driver: 'browser',
    status: 'pass',
    startedAt: '2026-09-18T05:00:00.000Z',
    finishedAt: '2026-09-18T05:00:01.000Z',
    steps: [],
    assertions: [],
    evidence: null,
    receiptSummary: { confirmed: 0, unknown: 0, rejected: 0, failed: 0 },
  }
}

test('reports are written as regular files with an owner-only mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-write-ok-'))
  try {
    const paths = await writeReports(report(), { directory: dir })
    for (const path of [paths.json, paths.markdown, paths.jsonl]) {
      const info = await stat(path)
      assert.ok(info.isFile(), path + ' must be a regular file')
      assert.equal(info.mode & 0o077, 0, path + ' must not be group/world accessible: ' + info.mode.toString(8))
    }
    const jsonl = await readFile(paths.jsonl, 'utf8')
    assert.ok(jsonl.endsWith('\n'), 'the JSONL sink stays newline-terminated')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the JSONL sink appends to an existing file instead of truncating it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-write-append-'))
  try {
    const jsonlPath = join(dir, 'report.jsonl')
    await writeFile(jsonlPath, '{"old":1}\n', 'utf8')
    await writeReports(report(), { directory: dir })
    const after = await readFile(jsonlPath, 'utf8')
    assert.match(after, /^\{"old":1\}\n/, 'pre-existing bytes must survive untouched')
    assert.ok(after.length > '{"old":1}\n'.length, 'the new run is appended after them')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a report path that is a SYMLINK is refused, and the link target is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-write-symlink-'))
  try {
    const outside = join(dir, 'outside.txt')
    await writeFile(outside, 'ORIGINAL', 'utf8')
    await writeFile(join(dir, 'placeholder'), '', 'utf8')
    const outDir = join(dir, 'out')
    await mkdtemp(outDir).catch(() => undefined)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(outDir, { recursive: true })
    await symlink(outside, join(outDir, 'report.json'))

    await assert.rejects(
      () => writeReports(report(), { directory: outDir }),
      (error) => {
        assert.match(String(error.message), /regular file|symlink/i)
        return true
      },
    )
    assert.equal(await readFile(outside, 'utf8'), 'ORIGINAL', 'the symlink target must not be written through')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a report path that is a FIFO is refused instead of blocking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-qa-write-fifo-'))
  try {
    const outDir = join(dir, 'out')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(outDir, { recursive: true })
    // node has no mkfifo; mknod via the shell is the portable-enough route here.
    execFileSync('/usr/bin/mkfifo', [join(outDir, 'report.jsonl')])

    await assert.rejects(
      () => writeReports(report(), { directory: outDir }),
      (error) => {
        assert.match(String(error.message), /regular file|fifo/i)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
