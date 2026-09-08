// Builds lib/server.mjs: a self-contained bundle of the MCP stdio server.
// Only the third-party packages the MCP protocol itself needs - the MCP SDK
// and zod - are inlined, so the plugin works from a plain directory copy with
// no node_modules (Claude Code's directory marketplace copies the repo
// without installing anything).
//
// Host-owned packages stay external: @deepseek-ai/* (DSH host runtime) and the
// sibling driver packages @zseven-w/dsh-browser / @zseven-w/dsh-computer /
// @zseven-w/dsh-ios / @zseven-w/dsh-android are resolved lazily and are never
// inlined here.
//
// Equivalent esbuild CLI:
//   esbuild src/server.mjs --bundle --platform=node --format=esm --packages=bundle \
//     --external:@deepseek-ai/* --external:@zseven-w/dsh-browser --external:@zseven-w/dsh-computer --external:@zseven-w/dsh-ios --external:@zseven-w/dsh-android \
//     --target=node24 --outfile=lib/server.mjs

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'lib'), { recursive: true });

await build({
  entryPoints: [join(ROOT, 'src', 'server.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'bundle',
  external: [
    '@deepseek-ai/*',
    '@zseven-w/dsh-browser',
    '@zseven-w/dsh-computer',
    '@zseven-w/dsh-ios',
    '@zseven-w/dsh-android',
  ],
  target: 'node24',
  outfile: join(ROOT, 'lib', 'server.mjs'),
  logLevel: 'info',
});
