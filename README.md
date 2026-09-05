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
- **Drivers** — `@zseven-w/dsh-browser` (BU, contract v8) and
  `@zseven-w/dsh-computer` (CU, contract v4). Driver safety semantics are
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

The native (Computer-driver) fixture `fixtures/native/` is **repository-only by
decision (QA-BL-042, 2026-09-05)**: it is a signed macOS app bundle built from
`main.swift` and is not in the published package. Build it from a checkout with
`node fixtures/native/build-fixture.mjs`, launch
`fixtures/native/build/DshQaFixture.app`, and stop it with
`pkill -x dsh-qa-fixture`. It is the only isolated target for demonstrating the
Computer driver's permanent secure-field rejection ("Secure password",
`fixture.securePassword`) and is exercised by `test/computer-integration.test.mjs`.

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

The Explore methodology ships as two artifacts: a human-readable copy at
`skills/qa-explore/SKILL.md` (included in the package `files`), and the playbook
the plugin actually registers through the optional skill service — the
`QA_SKILL_CONTENT` template literal in `src/skill.ts`, registered under the
name `qa-orchestration` via `ctx.inject(['skills'], …)`.

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
step intent when only a distant delta exists. A `fill`'s own value echo on its
target is masked from the change decision (it is expected, not evidence of a
downstream outcome), and the exporter proves the fill with a `node-value`
assertion on the target whenever the settled view shows it carrying the typed
text.

Configure it with `new QaToolHost({ settle: ... })`, `runScenario(..., { settle: ... })`,
or the `DSH_QA_SETTLE_BUDGET_MS` / `DSH_QA_SETTLE_QUIET_MS` / `DSH_QA_SETTLE_INTERVAL_MS`
environment overrides. Full rationale, both reproduced real-world failure modes,
and the regression fixtures: `docs/SETTLE.md`.

## A truncated view is incomplete, not empty

Observations are budget-limited and carry `truncated`. A node beyond the budget
still exists, so **an absence can never be proven from a truncated view**:
`node-absent` fails closed there instead of reporting a silent false green, and
any outcome that would rest on an incomplete view re-observes ONCE at
`QA_ESCALATED_NODE_BUDGET` before concluding. A claim that is still unprovable
against the fuller view carries `completeness.reason: "INCONCLUSIVE_TRUNCATED"`
— distinct from an ordinary failure — while a node that WAS returned remains
sound evidence of presence. Whenever truncation touched a decision, the
`completeness` block (budget, truncation state, escalation) is written into
`report.json`, `report.jsonl` and a "view completeness" line in `report.md`.
The replay runner resolves action targets the same way, and the exporter records
a truncated proof observation as a `Weak proof:` note in the step intent. Full
rationale: `docs/TRUNCATION.md`.

**Absence passes are SUSPENDED (QA-BL-052).** `node-absent` means "no
driver-OBSERVABLE semantic node" — the driver's projection excludes hidden and
zero-rect elements — and even a COMPLETE view (scoped or whole-page) cannot
currently prove an absence: closed shadow roots are neither pierced nor
counted and slot assignment may be unresolved, so a complete-looking view can
silently miss nodes. Until the deciding observation carries
`coverageVerified: true` (the driver's coverage probe, contract v9 Phase C —
no adapter reports it yet), an otherwise-passing absence fails closed with
`completeness.reason: "COVERAGE_UNVERIFIED"` and a detail saying the absence
is UNPROVEN, not "not present". A returned matching node still fails
`node-absent` normally, and `INCONCLUSIVE_TRUNCATED` semantics are unchanged.

## Scoped observation (browser driver contract v8)

The browser clamp stays at 100 nodes while real pages exceed it, so `qa_observe`
accepts `within_ref` — an opaque ref from the caller's CURRENT observation — and
observes only the composed subtree rooted at that element. Budgets, the byte
ceiling, the scan window, and the iframe marker become **subtree-relative**: a
container whose subtree fits reports `truncated: false` with no
`truncationReasons`, and a deep target unreachable in the whole-page window
becomes reachable. Scoping does NOT currently make `node-absent` pass: absence
stays UNPROVEN until the observation carries `coverageVerified` (see above).
The observation's `scope` field (`{ ref, role, name, tag }`) echoes the root
the driver observed; whole-page observations carry none. An unknown, expired,
consumed, non-element, or detached ref refuses the call with its driver code
(`REF_UNKNOWN` / `REF_EXPIRED` / `TARGET_CHANGED` / …) — never a whole-page
fallback, never a "not found". The computer driver does not support scoping and
refuses `within_ref`.

Scoped observations flow into Replay: a scenario assertion may carry
`scope: { role, name, tag? }` (an empty name kept literally); the runner
resolves that container in the whole-page view by UNIQUE predicate
(`TARGET_NOT_UNIQUE` when ambiguous, never a guess), and one match in a
TRUNCATED whole-page view is not proven uniqueness — it escalates the budget
once and refuses a still-truncated view with `INCONCLUSIVE_TRUNCATED` naming
the scope. It then observes within the container and decides the assertion
against that scoped view. The `completeness` block names the scope when the
deciding view was scoped, so "absent from this container" is never read as
"absent from the whole page" — and since QA-BL-052 neither passes until the
driver verifies coverage. Export records a scoped proof as a scoped assertion
ONLY when the container predicate is unique in a COMPLETE recorded baseline
observation; otherwise the step is excluded with `SCOPE_NOT_DURABLE` — never
silently exported as a whole-page proof. See `docs/TRUNCATION.md`.

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
  "services": ["tools", "attachments", "llm"],
  "typing": "structural"
}
```

The optional skill service is registered exclusively through
`ctx.inject(['skills'], cb)` and torn down with `fiber.dispose()`.

## Running the shipped example

The package ships a self-contained browser example:
`scenarios/examples/fixture-web.json` drives the `fixtures/web/` page. After
`npm pack` and a plain install, run it from the installed copy — no files from
this repository's working tree are needed:

```bash
node node_modules/@zseven-w/dsh-qa/scripts/run-example.mjs
```

(or, from inside the installed package directory, `npm run example`).

`run-example.mjs` serves `fixtures/web/` on an ephemeral loopback port (never
a hardcoded one), rebinds the scenario's `target.launch` to that origin, replays
it headlessly through the browser driver, and writes `report.json` / `report.md`
/ `report.jsonl`. A working install prints:

```
[example] status: pass
[example] report: <dir>/report.json
```

Exit code is `0` iff `status === "pass"`; pass `--output-dir <dir>` to choose
where reports go (default `./dsh-qa-example-report`). The browser driver is
host-provided in a DSH install; on a plain npm install, install
`@zseven-w/dsh-browser` alongside it. `scripts/smoke-pack.mjs` runs this exact
command from the packed tarball and asserts `status: "pass"`.

## Development

```bash
pnpm install
npm run build:mcp     # esbuild single-file bundle -> lib/server.mjs (committed)
npm run typecheck
npm test
npm run smoke:bundle  # real stdio handshake from a node_modules-free copy
npm run smoke:pack    # npm pack -> fresh-dir install -> handshake
```