// Bounded "settle until stable" observation policy.
//
// Real UIs are asynchronous: the semantic view immediately after an action is a
// race. A single-shot proof observation loses that race in BOTH directions —
// it can miss an async outcome that has not rendered yet, and it can catch
// unrelated late hydration churn and mistake it for the outcome.
//
// This module is the ONE policy both sides of the Explore -> Replay loop use:
// the exporter proves an action outcome against a settled observation, and the
// replay runner verifies it against a settled observation taken exactly the
// same way. If the two sides settled differently they would disagree by
// construction, which is the defect this policy exists to remove.
//
// It is NOT a fixed sleep. It polls the semantic view and returns as soon as
// that view has been UNCHANGED for a short quiet window (quietMs), or gives up
// when a bounded budget (budgetMs) is exhausted. A page that never stabilizes
// is honestly unprovable: the caller receives stable=false and must fail closed
// (never widen a comparison, never accept churn as proof).
//
// Two rules make that honest instead of merely quick:
//
//  1. A quiet WINDOW, not just "two consecutive equal observations". Two
//     back-to-back reads of a view whose async change has not started yet are
//     equal, so the weaker rule would call a racing page stable and lose the
//     very outcome it was supposed to wait for. Holding still for quietMs
//     subsumes consecutive agreement (several observations must agree).
//
//  2. awaitChange for PROOF observations. Right after an action, "nothing has
//     changed yet" is indistinguishable from "nothing will change" — so a
//     window that has seen no change at all keeps polling until the budget is
//     spent instead of concluding early. A view that never changed is still
//     stable (the action simply proved nothing, which the exporter already
//     refuses); a view still churning at the deadline is NOT stable.
//
// Consequence, deliberately documented: this policy can prove an async outcome
// that lands up to roughly (budgetMs - quietMs) after the action. A slower page
// needs a bigger configured budget — it is never silently accepted.

import type { QaObservation, QaSemanticNode, QaSettleReport } from './adapter.ts';
import type { QaNodePredicate } from '../contracts.ts';

/**
 * Default wall-clock budget for one settle window, in milliseconds.
 *
 * Sized for ordinary async UI work (a suggestion list, a fetch-backed status,
 * a late hydration pass) while keeping suites fast. It is only ever fully spent
 * by a view that genuinely keeps changing; a view that quiets down returns as
 * soon as it does.
 */
export const QA_SETTLE_BUDGET_MS = 2_500;

/**
 * How long the semantic projection must stay UNCHANGED before the view counts
 * as settled, in milliseconds. It is the longest silence this policy accepts
 * as "finished": a follow-up change arriving within quietMs of the previous
 * one keeps the window open (bounded by budgetMs), which is what lets one
 * window cover late hydration churn AND the slower real outcome behind it.
 * It is also the cost of a settled observation on a page where nothing moves.
 */
export const QA_SETTLE_QUIET_MS = 300;

/**
 * Delay between two consecutive observations inside a settle window, in
 * milliseconds. This is a POLL interval, not a settle delay: the window ends as
 * soon as the view has held still for quietMs, never later than budgetMs.
 */
export const QA_SETTLE_INTERVAL_MS = 50;

/** Hard clamps; a configured value outside these is corrected, never trusted. */
const BUDGET_MIN_MS = 20;
const BUDGET_MAX_MS = 60_000;
const QUIET_MIN_MS = 10;
const QUIET_MAX_MS = 10_000;
const INTERVAL_MIN_MS = 1;
const INTERVAL_MAX_MS = 1_000;

export interface QaSettlePolicy {
  /** Total wall-clock budget for one settle window. */
  budgetMs: number;
  /** How long the semantic view must hold still to count as settled. */
  quietMs: number;
  /** Delay between consecutive observations inside the window. */
  intervalMs: number;
}

/** Per-call settle behaviour (the policy itself stays global and configured). */
export interface QaSettleCallOptions {
  /**
   * True for a PROOF observation taken right after an action: the window must
   * not conclude from silence alone, because an outcome still in flight is
   * indistinguishable from no outcome. It then polls until the view has
   * changed (relative to baselineView, or to the window's own first
   * observation when there is none) and quieted down, or until the budget is
   * spent.
   */
  awaitChange?: boolean;
  /**
   * Semantic projection of the view BEFORE the action, so an outcome that
   * already landed synchronously counts as the awaited change instead of
   * costing the whole budget. When `echo` is set this MUST be the ECHO-MASKED
   * projection (see `projectSemanticView(observation, echo)`), so the action's
   * own echo is not mistaken for the awaited change.
   */
  baselineView?: string;
  /**
   * The action's own direct echo on its target, expressed as the target's
   * SEMANTIC predicate (role/name/tag, NOT the session-local ref: the browser
   * driver re-mints a ref every observation, so a ref can never be matched
   * across two observations). Any node matching this predicate has its `value`
   * masked from the `awaitChange` decision — the value the action itself just
   * wrote is expected and must not by itself end the wait — while value changes
   * on every OTHER node remain legitimate evidence. The quiet window still uses
   * the full projection, so the view is only settled once the echo AND any
   * downstream consequences have all held still.
   */
  echo?: QaNodePredicate;
}

/** One settle window outcome, including the observation the caller must use. */
export interface QaSettleResult extends QaSettleReport {
  /**
   * The settled observation: the second of the two consecutive observations
   * that agreed, or (when the budget was exhausted) the last one taken. It is
   * the deterministic artifact — settling changes duration, not outcome.
   */
  observation: QaObservation;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  // Fail-safe, not fail-open: garbage falls back to the default constant.
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

/**
 * Resolve the settle policy: explicit options first, then the
 * DSH_QA_SETTLE_BUDGET_MS / DSH_QA_SETTLE_QUIET_MS / DSH_QA_SETTLE_INTERVAL_MS
 * environment overrides, then the named defaults. Every value is clamped, the
 * quiet window can never exceed the budget, and the poll interval can never
 * exceed the quiet window (so a window always gets several observations).
 */
export function resolveSettlePolicy(options?: Partial<QaSettlePolicy>): QaSettlePolicy {
  const budgetRaw = options?.budgetMs ?? fromEnv('DSH_QA_SETTLE_BUDGET_MS') ?? QA_SETTLE_BUDGET_MS;
  const quietRaw = options?.quietMs ?? fromEnv('DSH_QA_SETTLE_QUIET_MS') ?? QA_SETTLE_QUIET_MS;
  const intervalRaw = options?.intervalMs ?? fromEnv('DSH_QA_SETTLE_INTERVAL_MS') ?? QA_SETTLE_INTERVAL_MS;
  const budgetMs = clamp(Number.isFinite(budgetRaw) ? budgetRaw : QA_SETTLE_BUDGET_MS, BUDGET_MIN_MS, BUDGET_MAX_MS);
  const quietMs = Math.min(
    clamp(Number.isFinite(quietRaw) ? quietRaw : QA_SETTLE_QUIET_MS, QUIET_MIN_MS, QUIET_MAX_MS),
    budgetMs,
  );
  const intervalMs = Math.min(
    clamp(Number.isFinite(intervalRaw) ? intervalRaw : QA_SETTLE_INTERVAL_MS, INTERVAL_MIN_MS, INTERVAL_MAX_MS),
    quietMs,
  );
  return { budgetMs, quietMs, intervalMs };
}

/**
 * Normalized semantic projection of an observation, as a comparable string.
 *
 * Session-local and per-observation identity (node refs, observation ids,
 * fingerprints, process ids, window numbers, and window geometry) is EXCLUDED:
 * those change between two observations of an unchanged view and would make
 * every page look unstable. Everything a scenario can address or assert on
 * (URL, title, and each node's role/name/tag/state/href/viewport membership,
 * in document order) is INCLUDED, so a real semantic change is never hidden.
 */
function matchesEcho(node: QaSemanticNode, echo: QaNodePredicate): boolean {
  if (echo.role !== undefined && node.role !== echo.role) return false;
  if (echo.name !== undefined && node.name !== echo.name) return false;
  if (echo.tag !== undefined && node.tag !== echo.tag) return false;
  return true;
}

export function projectSemanticView(observation: QaObservation, echo?: QaNodePredicate): string {
  return JSON.stringify({
    url: observation.page.url,
    title: observation.page.title,
    truncated: observation.truncated,
    app: observation.app === undefined
      ? null
      : { bundleId: observation.app.bundleId, name: observation.app.name },
    window: observation.window === undefined
      ? null
      : {
          role: observation.window.role,
          subrole: observation.window.subrole,
          title: observation.window.title,
          identity: observation.window.identity,
        },
    nodes: observation.nodes.map((node) => [
      node.role,
      node.name,
      node.tag,
      node.interactive,
      node.editable,
      node.disabled,
      node.href ?? null,
      node.inViewport ?? null,
      node.secure ?? null,
      echo !== undefined && matchesEcho(node, echo) ? null : node.value ?? null,
    ]),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Observe until the semantic view has held still for the policy's quiet window,
 * or until the budget is exhausted.
 *
 * Every observation inside the window is a real observation of the live target;
 * the returned one is the last (and, when stable, one of several consecutive
 * observations with an identical projection). The caller decides what an
 * unstable result means; this function never pretends an unsettled view
 * settled, and it never widens the comparison to make one "agree".
 */
export async function observeUntilStable(
  observe: () => Promise<QaObservation>,
  policy: QaSettlePolicy = resolveSettlePolicy(),
  options: QaSettleCallOptions = {},
): Promise<QaSettleResult> {
  const awaitChange = options.awaitChange === true;
  const echo = options.echo;
  const startedAt = Date.now();
  let latest = await observe();
  // FULL projection drives the quiet window (the echo must hold still too).
  let projection = projectSemanticView(latest);
  // ECHO-MASKED projection drives awaitChange: the action's own echo is
  // expected and never satisfies "the view changed", so only a change on some
  // OTHER node (a downstream consequence) counts. When there is no echo the
  // two projections are identical and the behaviour is unchanged.
  let changedProjection = projectSemanticView(latest, echo);
  /** When the CURRENT projection was first seen; the quiet window starts here. */
  let unchangedSince = Date.now();
  // An outcome that landed before this window even opened (a synchronous UI)
  // is already the awaited change: compare against the pre-action baseline.
  let changed = options.baselineView !== undefined && options.baselineView !== changedProjection;
  let passes = 1;
  for (;;) {
    const now = Date.now();
    const quiet = now - unchangedSince >= policy.quietMs;
    // A proof window may not conclude from silence alone: an outcome still in
    // flight looks exactly like no outcome at all.
    if (quiet && (changed || !awaitChange)) {
      return {
        observation: latest,
        stable: true,
        passes,
        elapsedMs: now - startedAt,
        budgetMs: policy.budgetMs,
      };
    }
    const remaining = policy.budgetMs - (now - startedAt);
    if (remaining <= 0) {
      return {
        observation: latest,
        // Quiet at the deadline: the view is stable, it simply never moved.
        // Still moving at the deadline: honestly unstable.
        stable: quiet,
        passes,
        elapsedMs: now - startedAt,
        budgetMs: policy.budgetMs,
      };
    }
    await sleep(Math.min(policy.intervalMs, remaining));
    const next = await observe();
    passes += 1;
    const nextProjection = projectSemanticView(next);
    const nextChangedProjection = projectSemanticView(next, echo);
    if (nextChangedProjection !== changedProjection) {
      // A non-echo change (or the echo re-appearing) counts as the awaited
      // change and keeps the proof window able to conclude once quiet.
      changedProjection = nextChangedProjection;
      changed = true;
    }
    if (nextProjection !== projection) {
      // The view moved (echo included): the quiet window restarts.
      projection = nextProjection;
      unchangedSince = Date.now();
    }
    latest = next;
  }
}
