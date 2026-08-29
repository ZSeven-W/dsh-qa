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

Status: **private, v0.1 in development** (WP1 scaffold, WP2 QA session core +
browser adapter + web fixture, WP4 deterministic Replay runner + reporters).

## Session core (WP2)

`src/session/` implements the QA loop `observe -> act -> re-observe -> evaluate ->
evidence -> cleanup` on top of a driver adapter interface, with these hard rules:

- an `unknown` action receipt is never treated as success — the outcome is decided
  only by a fresh observation;
- `rejected` / `failed` receipts propagate as step failures with the receipt
  attached as evidence;
- every session cleans up (`driver.stop`) even on failure.

`src/adapters/browser.ts` adapts `@zseven-w/dsh-browser` (declared as a
`link:../dsh-browser` dev-only `devDependencies` linkage, never a runtime
dependency and never vendored) to that interface
without weakening any driver safety semantics. `fixtures/web/index.html` is a
self-contained loopback fixture that reproduces the 2026-08-25 acceptance flow.

## Replay (WP4)

Declarative `QaScenario` files (lossless JSON, `{ meta, target, steps[],
assertions[] }`) are executed deterministically by `src/replay/runner.ts` on
top of the session core. Every step carries the act plus the assertion that
must hold on the FRESH observation after it; an `unknown` receipt is never a
pass — only the re-observation decides. The fail-closed loader
(`src/replay/loader.ts`) rejects unknown fields, malformed steps, missing
fields, and non-lossless values without echoing value bytes. Reporters emit
redacted `report.json` / `report.md` / append-only `report.jsonl` through
the `src/redaction` seam (a pass-through until the v2 engine lands in WP3).
See `scenarios/examples/` and `qa_assert` / `qa_replay_run`.

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
