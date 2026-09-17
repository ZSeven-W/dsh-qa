// Test runner with one explicit, named exclusion.
//
// `npm test` runs everything and is the acceptance command: it requires macOS,
// a granted DSH Computer Helper (Accessibility + Screen Recording), and a
// system Chrome. `npm run test:ci` runs the same suites MINUS the one file
// that cannot pass on a hosted runner.
//
// The exclusion is a list of file names, not a pattern, and every entry states
// the prerequisite it needs. That keeps a hosted-CI green honest: it says
// "everything except this named suite passed", never "the suite passed" when
// the suite never ran. test/computer-integration.test.mjs deliberately fails
// loudly rather than skipping when the grant is missing (see its header), so
// it has to be named here instead of guarded inside the test.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = fileURLToPath(new URL('../test/', import.meta.url))

/** file name -> the prerequisite a hosted runner cannot provide */
const REQUIRES_LOCAL_GRANT = new Map([
  [
    'computer-integration.test.mjs',
    'macOS + DSH Computer Helper with Accessibility and Screen Recording granted',
  ],
])

const excludeNative = process.argv.includes('--exclude-native')

const all = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs') || name.endsWith('.test.ts'))
  .sort()

const excluded = excludeNative ? all.filter((name) => REQUIRES_LOCAL_GRANT.has(name)) : []
const selected = all.filter((name) => !excluded.includes(name))

if (excluded.length > 0) {
  console.log('Excluded from this run (hosted runners cannot satisfy the prerequisite):')
  for (const name of excluded) console.log(`  ${name} — needs ${REQUIRES_LOCAL_GRANT.get(name)}`)
  console.log(`Run \`npm test\` on a granted macOS machine to cover ${excluded.length} more file(s).\n`)
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...selected.map((name) => join(TEST_DIR, name))],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
