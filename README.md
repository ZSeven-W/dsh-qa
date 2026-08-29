# dsh-qa

QA orchestrator plugin for DeepSeek Harness: an agent **explores** your App like a
real user (with evidence-backed findings), then the explored path is exported as a
deterministic **Replay** scenario that runs on every release.

- **Explore mode** — the agent drives the app through a tool surface
  (`qa_session_start` / `qa_observe` / `qa_act` / `qa_assert` / `qa_evidence` /
  `qa_record_export` / `qa_replay_run` / `qa_session_stop`) and documents what it sees.
- **Replay mode** — declarative `QaScenario` files (lossless JSON) executed
  deterministically with per-step re-observe assertions, producing redacted
  JSON / Markdown / JSONL reports.
- **Drivers** — `@zseven-w/dsh-browser` (BU, contract v1) and
  `@zseven-w/dsh-computer` (CU, contract v2). Driver safety semantics are
  inherited, never loosened: `EXTERNAL_COMMIT_TARGET` refused, secure fields
  permanently refused, approval gates passed through, `unknown` receipts require
  re-observation.

Status: **private, v0.1 in development** (WP1 scaffold).

## dshHostRuntime

This package declares **zero host packages** in `dependencies`/`peerDependencies`.
The DSH host provides the runtime services below itself; a plain
`npm i @zseven-w/dsh-qa` installs with no `@deepseek-ai/*` packages at all
(enforced by `scripts/smoke-pack.mjs`).

```json
"dshHostRuntime": {
  "services": ["tools"],
  "typing": "structural"
}
```

Plugin wire-ins planned for later work packages register optional cordis services
exclusively via the `ctx.inject(['skills'], cb)` form.

## Development

```bash
pnpm install
npm run build:mcp     # esbuild single-file bundle -> lib/server.mjs (committed)
npm run typecheck
npm test
npm run smoke:bundle  # real stdio handshake from a node_modules-free copy
npm run smoke:pack    # npm pack -> fresh-dir install -> handshake
```
