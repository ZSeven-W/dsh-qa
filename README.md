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
directory, synthesizes every step assertion from the SETTLED fresh observation
after that action, writes a scenario, and reads the exact bytes back through the
existing fail-closed loader. Rejected/failed actions, actions without a fresh
observation, and actions whose view never settled are returned in
`excludedActions`, never silently promoted to steps.

Selector durability is intentionally strict: an action is exportable only when its
target resolves uniquely in the preceding observation by non-empty **role plus
accessible name**. Indices, coordinates, observation ids, generated ids, duplicate
names, unnamed nodes, and ephemeral refs are refused instead of guessed. An
`unknown` receipt additionally needs an observable semantic delta or URL change;
the old target merely remaining present is not proof.

The bundled Explore methodology lives at `skills/qa-explore/SKILL.md` and is
registered through the existing optional skill-service path.

## Bounded settle (asynchronous UIs)

Real UIs are asynchronous, so a single proof observation taken immediately after
an action is a race: it can miss the outcome that has not rendered yet, or catch
unrelated late hydration churn and mistake it for the outcome. `src/session/settle.ts`
replaces that single-shot read with a bounded settle: observe until the semantic
projection (refs and other session-local identity excluded) has held still for
`QA_SETTLE_QUIET_MS`, bounded by `QA_SETTLE_BUDGET_MS`, and — right after an
action — never conclude from silence alone.

The SAME policy is applied by the session core to Explore's proof observations
and Replay's verification observations, so the two sides can never judge
different views of the same page. A view that never settles is honestly
unprovable: export excludes the step (`ASSERTION_NOT_PROVABLE`) and replay fails
the step. Nothing is widened to make an unstable page pass. Assertion synthesis
prefers evidence on or near the action target and records the weakness in the
step intent when only a distant delta exists.

Configure it with `new QaToolHost({ settle: ... })`, `runScenario(..., { settle: ... })`,
or the `DSH_QA_SETTLE_BUDGET_MS` / `DSH_QA_SETTLE_QUIET_MS` / `DSH_QA_SETTLE_INTERVAL_MS`
environment overrides. Full rationale, both reproduced real-world failure modes,
and the regression fixtures: `docs/SETTLE.md`.

## Visual assertions (advisory)

`qa_assert kind:"visual"` captures the current screen and asks the host vision
model one question. The verdict is **advisory**: it is recorded in the report and
excluded from the determinism comparison by schema, and it never changes a run's
pass/fail.

Two rules come from live use against `deepseek-v4-flash-vision-exp`:

- **Trust `verdict` and `confidence`; never quote `reasoning` as observed fact.**
  In a real run the model correctly answered `yes` (confidence 1.00) to "is the
  serif WIKIPEDIA wordmark present" and then narrated "with the puzzle globe
  logo" — a logo that was not on the page. The reasoning is kept as triage
  context, but every advisory record carries
  `reasoningTrust: "unverified-model-narration"` in `report.json` /
  `report.jsonl` and the `qa_assert` result, and `report.md` renders it under a
  `## Advisory (model-generated; never affects pass/fail)` heading as a labelled
  "model narration" blockquote. Rationale and the full decision:
  `docs/REDACTION_SPEC.md` section 7.3.
- **A capture is always bound to a fresh observation.** Both drivers refuse a
  capture bound to a stale observation (the browser driver: "the semantic
  observation expired; observe again before visual capture"), because the
  Set-of-Mark annotations and the pixels must describe the same view. Rather than
  weakening that rule or reusing an older frame, `captureLatestVisual` takes a
  fresh settled observation immediately before every capture, for both drivers —
  so `qa_assert` visual and `qa_evidence visual:true` work directly after
  `qa_act` or each other, with no manual `qa_observe` in between. A capture the
  caller pinned explicitly (browser `visual_fingerprint`, computer
  `observationId`) is never silently refreshed: the pin is honored and a stale
  pin is refused by the driver, by design.

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
