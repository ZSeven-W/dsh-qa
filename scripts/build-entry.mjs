// Builds lib/index.js: the loadable Cordis plugin entry, bundled from
// src/plugin.ts into one self-contained ESM file so the host can activate the
// plugin from a plain directory copy with no node_modules.
//
// Host-owned packages stay external: @deepseek-ai/* (DSH host runtime) and the
// sibling driver packages @zseven-w/dsh-browser / @zseven-w/dsh-computer are
// never inlined — the drivers are imported lazily at runtime with a clear error
// when absent. The library itself uses only node builtins, so the entry carries
// no third-party code.
//
// Equivalent esbuild CLI:
//   esbuild src/plugin.ts --bundle --platform=node --format=esm \
//     --external:@deepseek-ai/* --external:@zseven-w/dsh-browser --external:@zseven-w/dsh-computer \
//     --target=node24 --outfile=lib/index.js

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(ROOT, 'lib'), { recursive: true })

await build({
  entryPoints: [join(ROOT, 'src', 'plugin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: [
    '@deepseek-ai/*',
    '@zseven-w/dsh-browser',
    '@zseven-w/dsh-computer',
  ],
  target: 'node24',
  outfile: join(ROOT, 'lib', 'index.js'),
  logLevel: 'info',
})
