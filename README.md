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

Status: **private, v0.1 in development** (WP1 scaffold, WP2 QA session core,
WP4 deterministic Replay, WP5 Computer driver, WP6 Explore→Replay loop).

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
the fail-closed v2 engine in `src/redaction`.
See `scenarios/examples/` and `qa_assert` / `qa_replay_run`.

## Explore → Replay (WP6)

`src/explore/` wraps the existing driver adapter as a passive recorder. It records
ordered observations, actions, receipts, and evidence references after applying the
fail-closed redaction projection; the session core itself is unchanged. Ephemeral
driver refs are replaced by per-session correlation aliases and never enter the
trajectory.

`qa_record_export` accepts an `output_path` under the current workspace or temporary
directory, synthesizes every step assertion from the immediate fresh observation
after that action, writes a scenario, and reads the exact bytes back through the
existing fail-closed loader. Rejected/failed actions or actions without a fresh
observation are returned in `excludedActions`, never silently promoted to steps.

Selector durability is intentionally strict: an action is exportable only when its
target resolves uniquely in the preceding observation by non-empty **role plus
accessible name**. Indices, coordinates, observation ids, generated ids, duplicate
names, unnamed nodes, and ephemeral refs are refused instead of guessed. An
`unknown` receipt additionally needs an observable semantic delta or URL change;
the old target merely remaining present is not proof.

The bundled Explore methodology lives at `skills/qa-explore/SKILL.md` and is
registered through the existing optional skill-service path.

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

The optional skill service is registered exclusively through
`ctx.inject(['skills'], cb)` and torn down with `fiber.dispose()`.

## Development

```bash
pnpm install
npm run build:mcp     # esbuild single-file bundle -> lib/server.mjs (committed)
npm run typecheck
npm test
npm run smoke:bundle  # real stdio handshake from a node_modules-free copy
npm run smoke:pack    # npm pack -> fresh-dir install -> handshake
```
