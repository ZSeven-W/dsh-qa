# Observation truncation and assertion soundness

Every observation is budget-limited. `QaObservation.truncated` is true when the
driver returned fewer nodes than the page/app actually exposes (the browser
driver defaults to 60 nodes and clamps a request to 100; the computer driver
defaults to 200 and clamps to 500, and both also enforce a byte ceiling).

A truncated view is **incomplete, not empty**. That single fact decides what an
assertion may conclude from it.

## The rule

| claim | truncated view | why |
| --- | --- | --- |
| a node WAS returned | sound | the driver returned it, so it exists |
| `node-absent` and nothing matched | **unprovable** | the node may exist outside the window |
| `node-present` / `node-in-viewport` and nothing matched | **unprovable** | same reason, opposite direction |
| `node-value` and EXACTLY ONE unflagged node with the expected value was returned | sound | the node and its value were both reported |
| `node-value` and nothing matched | **unprovable** | the node (and its value) may exist outside the window |
| `node-value` and several nodes match, or the match is flagged | refused, not a pass | a twin holding the value proves nothing about the recorded target (`TARGET_NOT_UNIQUE`); a `valueWithheld`/`secure`/`valueTruncated` node can never satisfy it (`VALUE_WITHHELD` / `VALUE_SECURE` / `VALUE_TRUNCATED`) — both fail closed with their code, in a complete or truncated view alike |
| `page-url` | sound | the URL is carried by every observation |

Evidence of presence is sound; absence of evidence is not evidence of absence.

## What the code does

1. **`node-absent` can never pass on a truncated observation.**
   `evaluateAssertion` (src/replay/assertions.ts) fails it closed, and the
   result is marked `inconclusive` rather than silently converted into an
   ordinary "not present".

2. **One bounded budget escalation before concluding.** When an outcome would
   be decided against a truncated view — any absent-claim, or a present /
   in-viewport / value claim that found nothing — `decideAssertion` re-observes ONCE at
   `QA_ESCALATED_NODE_BUDGET` (500, clamped by each driver to its own maximum)
   and decides against that fuller view. It never loops, never escalates twice,
   and a present-claim that already found its match never escalates at all. The
   escalated observation is SETTLED like every other proof observation; an
   unsettled one is refused and the decision falls back, still fail-closed.

3. **Still truncated ⇒ fail closed with a distinct reason.** The result carries
   `completeness.reason: "INCONCLUSIVE_TRUNCATED"` and a detail naming the
   budget, and the runner's failure message says so instead of "assertion
   node-absent failed".

4. **The report explains itself.** Whenever truncation touched a decision, the
   step / assertion result carries `completeness` (`truncated`, `nodeBudget`,
   `escalated`, `outcomeDependsOnCompleteView`, `reason`, `detail`) into
   report.json, report.jsonl, and a "view completeness" line in report.md. A
   human triaging a failure can tell "not present" from "we could not see the
   whole page". The field is additive: `schemaVersion` stays 1, and a result
   decided against a complete view is unchanged.

5. **The same blind spot elsewhere.**
   - The replay runner resolves an action target the same way: a target missing
     from a truncated view triggers the same single escalation, and the failure
     message names `INCONCLUSIVE_TRUNCATED` instead of claiming the target is
     not on the page. This is the live scroll case: after a scroll the target
     was absent from the 60-node view and present at 100. A target whose
     predicate matches SEVERAL nodes never escalates (a fuller view can only
     add more matches): it fails closed with `TARGET_NOT_UNIQUE` — acting on
     the first match would be a guess.
   - The Explore exporter cannot re-observe a recorded trajectory, so when a
     proof observation was truncated it records the weakness in the step intent
     ("Weak proof: the proof observation was truncated at the driver node
     budget …") exactly like the existing distant-delta weakness. A "new" node
     may have been there all along, and a target that looks unique may have a
     twin outside the window.
   - An action ref missing from a truncated preceding observation is excluded
     with a detail that says the target may have fallen outside the window.

## Budget

`QA_ESCALATED_NODE_BUDGET` is a named constant in src/replay/assertions.ts.
Raising it is a deliberate, bounded change; escalation stays single-shot because
an unbounded retry loop would turn an honest "I cannot see the whole page" into
an expensive one.
