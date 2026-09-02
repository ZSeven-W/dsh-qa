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
// Consequence, deliberately documented: once the awaited change has been seen,
// this policy can prove an async outcome that lands up to roughly
// (budgetMs - postChangeQuietMs) after the action; before any change is seen it
// keeps polling until the budget is spent. A slower page needs a bigger
// configured budget — it is never silently accepted.

import type { QaObservation, QaSemanticNode, QaSettleReport } from './adapter.ts';
import type { QaNodePredicate } from '../contracts.ts';

/**
 * Normalize an intended value write exactly like the browser driver normalizes
 * an observable value (dsh-browser contract v5/v6, unchanged): bound the raw string, collapse
 * whitespace runs to single spaces, trim, then clip to 180 characters. Both the
 * echo mask and the export-side node-value synthesis compare against this
 * normalization, so a fill is recognized as its own echo only when the observed
 * node.value carries exactly this form; anything else (a page transform, a
 * truncation) is not the echo.
 */
export function normalizeObservableValue(raw: string): string {
  return raw.slice(0, 720).replace(/\s+/gu, ' ').trim().slice(0, 180);
}

/**
 * The action's own direct echo, as the stable cross-observation identity of the
 * node the action wrote its value onto.
 *
 * The browser driver re-mints a node ref on every observation, so a ref can
 * never be matched across two observations; the mask therefore identifies the
 * echo by the value the action wrote, anchored by the pre-action predicate.
 * ref is the EXACT pre-action identity inside the baseline observation only
 * (the one observation that still contains the action's own ref).
 */
export interface QaEchoMask {
  /**
   * The full pre-action predicate: role/name/tag exactly as observed, EMPTY
   * STRINGS KEPT (an empty name must match literally, not act as a wildcard).
   * All three fields are always present here; a node whose three fields are
   * all empty can never be echo-masked.
   */
  predicate: QaNodePredicate;
  /** Exact pre-action ref of the echo target (identity inside the baseline only). */
  ref: string;
  /**
   * Driver-normalized value the action wrote (fill/type text, select option).
   * Null when the written value is unknowable ahead of time (key/press):
   * the mask then degrades to the unique-predicate rule and the exact ref.
   */
  value: string | null;
}

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
 * How long the semantic projection must stay UNCHANGED after the first
 * (unmasked) change has been observed before the view counts as settled, in
 * milliseconds. The default is twice quietMs (600ms with the default quiet
 * window): once awaitChange has been satisfied by a non-echo delta, a single
 * quietMs of stillness no longer concludes the window, so an outcome that
 * lands shortly after early unrelated churn (a sibling mirroring the typed
 * value, a late hydration rename) is still observed. Before any change is seen
 * the requirement stays quietMs, so an inert action and the "nothing changed"
 * path are unchanged.
 */
export const QA_SETTLE_POST_CHANGE_QUIET_MS = 2 * QA_SETTLE_QUIET_MS;

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
  /**
   * How long the semantic view must hold still AFTER the awaited (unmasked)
   * change has been observed, before it counts as settled. Defaults to
   * 2 * quietMs; clamped to [quietMs, budgetMs]. Before any change is seen the
   * quiet requirement stays quietMs (unchanged inert/nothing-changed path).
   */
  postChangeQuietMs: number;
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
   * The action's own direct echo on its target, as the stable cross-observation
   * identity built from the pre-action observation (see QaEchoMask). A node's
   * value AND accessible name are masked from the awaitChange decision exactly
   * when the masking rule below identifies it as the echo target — the value the
   * action itself just wrote (and a name the fill itself rewrote) is expected
   * and must not by itself end the wait — while changes on every OTHER node
   * remain legitimate evidence. The quiet window still uses
   * the full projection, so the view is only settled once the echo AND any
   * downstream consequences have all held still.
   */
  echo?: QaEchoMask;
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
 * DSH_QA_SETTLE_BUDGET_MS / DSH_QA_SETTLE_QUIET_MS /
 * DSH_QA_SETTLE_POST_CHANGE_QUIET_MS / DSH_QA_SETTLE_INTERVAL_MS environment
 * overrides, then the named defaults. Every value is clamped, the quiet window
 * can never exceed the budget, the post-change quiet window is clamped to
 * [quietMs, budgetMs], and the poll interval can never exceed the quiet window
 * (so a window always gets several observations).
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
  // The post-change quiet requirement defaults to 2x the RESOLVED quietMs (so a
  // custom quietMs scales the post-change window too) and is clamped to
  // [quietMs, budgetMs]: it can never be shorter than the pre-change quiet
  // window nor longer than the budget. Garbage falls back to the default.
  const postChangeRaw = options?.postChangeQuietMs
    ?? fromEnv('DSH_QA_SETTLE_POST_CHANGE_QUIET_MS')
    ?? 2 * quietMs;
  const postChangeQuietMs = clamp(
    Number.isFinite(postChangeRaw) ? postChangeRaw : 2 * quietMs,
    quietMs,
    budgetMs,
  );
  return { budgetMs, quietMs, postChangeQuietMs, intervalMs };
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
/** True when the node matches every defined predicate field (empty strings must match literally). */
function matchesEchoPredicate(node: QaSemanticNode, predicate: QaNodePredicate): boolean {
  if (predicate.role !== undefined && node.role !== predicate.role) return false;
  if (predicate.name !== undefined && node.name !== predicate.name) return false;
  if (predicate.tag !== undefined && node.tag !== predicate.tag) return false;
  return true;
}

/**
 * The echo-masking rule, decided per node against the WHOLE observation
 * (predicateMatchCount is how many nodes of that observation match the full
 * pre-action predicate). A node is the echo target — and its value is masked
 * from the awaitChange decision — exactly when:
 *
 *  1. it carries the echo's exact pre-action ref (the baseline observation
 *     only; the browser driver re-mints refs on every later observation), or
 *  2. its value equals the driver-normalized value the action wrote, and it
 *     matches the full pre-action predicate OR its role/tag match the
 *     pre-action target (name-agnostic: covers a fill that REWRITES the
 *     target's accessible name, e.g. "Search" -> "Search: async"), or
 *  3. its role/tag match the pre-action target and its (new) name CONTAINS the
 *     written value — a renamed target that announces the value in its name
 *     is still the echo even when its value is withheld, or
 *  4. it is the ONLY node in the observation matching the full predicate: a
 *     unique target is the echo whatever its value is (a page transform of the
 *     echo, a withheld value, an echo that has not landed yet, or a key/press
 *     whose written value is unknowable ahead of time), or
 *  5. it matches the predicate AND its value is still empty: with SEVERAL
 *     predicate matches only the twin carrying the written value is masked, but
 *     an empty-valued twin is either the pre-write target state or a
 *     not-yet-changed sibling — masking it keeps a late echo from unblocking
 *     awaitChange. A sibling's NON-EMPTY value that differs from the written
 *     value is never masked: that change is legitimate evidence.
 */
function isEchoMasked(node: QaSemanticNode, echo: QaEchoMask, predicateMatchCount: number): boolean {
  // 1. Exact identity inside the baseline observation.
  if (node.ref === echo.ref) return true;
  const matches = matchesEchoPredicate(node, echo.predicate);
  if (echo.value !== null) {
    const roleTag = echo.predicate.role !== undefined && echo.predicate.tag !== undefined
      && node.role === echo.predicate.role && node.tag === echo.predicate.tag;
    // 2. The node carrying the written value, by predicate or name-agnostic role/tag.
    if (node.value === echo.value && (matches || roleTag)) return true;
    // 3. A renamed pre-action target whose new name announces the written value.
    if (roleTag && node.name.includes(echo.value)) return true;
  }
  // 4. A unique predicate match is the target no matter what its value is.
  if (matches && predicateMatchCount === 1) return true;
  // 5. Empty-valued predicate matches (the pre-write state; see the doc above).
  if (matches && (node.value === undefined || node.value === null || node.value === '')) return true;
  return false;
}

export function projectSemanticView(observation: QaObservation, echo?: QaEchoMask): string {
  // The mask is decided per observation: how many nodes match the full
  // pre-action predicate decides whether the unique-target rule applies, and
  // the written value decides which twin is the echo when several match.
  const predicateMatchCount = echo === undefined
    ? 0
    : observation.nodes.reduce(
        (count, node) => count + (matchesEchoPredicate(node, echo.predicate) ? 1 : 0),
        0,
      );
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
    nodes: observation.nodes.map((node) => {
      const masked = echo !== undefined && isEchoMasked(node, echo, predicateMatchCount);
      return [
        node.role,
        // The echo target's accessible NAME is masked together with its value:
        // a fill that rewrites the target's name as part of its own echo
        // ("Search" -> "Search: async") must not satisfy awaitChange through
        // the name drift either. The full (quiet-window) projection still
        // carries the real name, so the rename restarts the quiet window.
        masked ? null : node.name,
        node.tag,
        node.interactive,
        node.editable,
        node.disabled,
        node.href ?? null,
        node.inViewport ?? null,
        node.secure ?? null,
        masked ? null : node.value ?? null,
      ];
    }),
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
    // The quiet window required to conclude stable: quietMs before any
    // (unmasked) change has been observed, postChangeQuietMs once awaitChange
    // has been satisfied by a non-echo delta (each further change restarts the
    // window, so the longer requirement is measured from the LAST change).
    const quietRequiredMs = changed ? policy.postChangeQuietMs : policy.quietMs;
    const quiet = now - unchangedSince >= quietRequiredMs;
    // A proof window may not conclude from silence alone: an outcome still in
    // flight looks exactly like no outcome at all.
    if (quiet && (changed || !awaitChange)) {
      return {
        observation: latest,
        stable: true,
        passes,
        elapsedMs: now - startedAt,
        budgetMs: policy.budgetMs,
        quietRequiredMs,
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
        quietRequiredMs,
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
