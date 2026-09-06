import { lstat, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  QaAssertion,
  QaNodePredicate,
  QaScenario,
  QaScenarioAction,
  QaScenarioAssertionScope,
  QaSettleOverride,
  QaStep,
} from '../contracts.ts';
import { QA_SCOPE_NOT_DURABLE, QA_SETTLE_SCHEMA_BUDGET_MAX, QA_TARGET_NOT_UNIQUE } from '../contracts.ts';
import { projectArtifactPath, redactText } from '../redaction/index.ts';
import { evaluateAssertion, loadScenarioFromPath, validateScenario } from '../replay/index.ts';
import type { QaObservation, QaSemanticNode } from '../session/adapter.ts';
import {
  normalizeObservableValue,
  QA_SETTLE_ADAPTIVE_BUDGET_MS,
  QA_SETTLE_BUDGET_MS,
  QA_SETTLE_INTERVAL_MS,
  QA_SETTLE_POST_CHANGE_QUIET_MS,
  QA_SETTLE_QUIET_MS,
} from '../session/settle.ts';
import type { QaSettlePolicy } from '../session/settle.ts';
import type { QaTrajectoryRecorder } from './recorder.ts';
import type {
  QaAssertionExportExclusion,
  QaExportExclusion,
  QaRecordedAction,
  QaRecordExportOptions,
  QaRecordExportResult,
  QaTrajectorySnapshot,
} from './types.ts';

interface DurableAction {
  action: QaScenarioAction;
  /** Semantic target predicate for ref-based actions; null for navigate and direction-scroll. */
  target: QaNodePredicate | null;
}

const OUTCOME_ROLE_PRIORITY = new Map<string, number>([
  ['alert', 0],
  ['status', 1],
  ['dialog', 2],
  ['heading', 3],
]);

function clean(value: string): string {
  return value.trim();
}

function containsRedactionMarker(value: string): boolean {
  return value.includes('[REDACTED');
}

function predicateFor(node: QaSemanticNode): QaNodePredicate | null {
  const role = clean(node.role);
  const name = clean(node.name);
  if (role === '' || name === '') return null;
  if (containsRedactionMarker(role) || containsRedactionMarker(name)) return null;
  return { role, name };
}

function matchesPredicate(node: QaSemanticNode, predicate: QaNodePredicate): boolean {
  return (predicate.role === undefined || node.role === predicate.role)
    && (predicate.name === undefined || node.name === predicate.name)
    && (predicate.tag === undefined || node.tag === predicate.tag);
}

function countMatches(observation: QaObservation, predicate: QaNodePredicate): number {
  return observation.nodes.filter((node) => matchesPredicate(node, predicate)).length;
}

function predicateName(predicate: QaNodePredicate): string {
  return predicate.name ?? predicate.role ?? predicate.tag ?? 'semantic target';
}

/** True when the node went from off-viewport (or absent) in `before` to in-viewport in `after`. */
function isRevealed(before: QaObservation, after: QaObservation, predicate: QaNodePredicate): boolean {
  const beforeNode = before.nodes.find((node) => matchesPredicate(node, predicate));
  const afterNode = after.nodes.find((node) => matchesPredicate(node, predicate));
  return afterNode !== undefined && afterNode.inViewport === true
    && (beforeNode === undefined || beforeNode.inViewport !== true);
}

/**
 * First durable (role+name unique) predicate whose node the scroll moved into
 * the viewport. Prefers nodes that were already present off-viewport (a
 * scroll reveals them by moving the viewport, not by creating them).
 */
function firstRevealedPredicate(before: QaObservation, after: QaObservation): QaNodePredicate | null {
  const present = after.nodes
    .filter((node) => node.inViewport === true)
    .map((node) => ({ node, predicate: predicateFor(node) }))
    .filter((item): item is { node: QaSemanticNode; predicate: QaNodePredicate } => (
      item.predicate !== null && countMatches(after, item.predicate) === 1
    ))
    .filter((item) => {
      const beforeNode = before.nodes.find((node) => matchesPredicate(node, item.predicate));
      return beforeNode !== undefined && beforeNode.inViewport !== true;
    });
  return present[0]?.predicate ?? null;
}

function exclusion(
  recorded: QaRecordedAction,
  reason: QaExportExclusion['reason'],
  detail: string,
): QaExportExclusion {
  return {
    actionId: recorded.actionId,
    reason,
    detail: redactText(detail),
    receipt: recorded.receipt,
  };
}

function durableAction(
  recorded: QaRecordedAction,
  before: QaObservation | null,
): DurableAction | QaExportExclusion {
  const action = recorded.action;
  if (action.kind === 'navigate') {
    return { action: { kind: 'navigate', url: action.url }, target: null };
  }
  if (action.kind === 'focus' || action.kind === 'type' || action.kind === 'key') {
    return exclusion(
      recorded,
      'UNSUPPORTED_REPLAY_ACTION',
      'Replay v0.1 has no scenario action for ' + action.kind + '; the step was not exported.',
    );
  }
  if (action.kind === 'scroll' && !('ref' in action)) {
    // Viewport direction-scroll: inherently positional. buildScenario resolves
    // it against the following proven action's target (or excludes it when no
    // in-viewport transition is observable).
    return {
      action: {
        kind: 'scroll',
        direction: action.direction,
        ...(action.amount === undefined ? {} : { amount: action.amount }),
      },
      target: null,
    };
  }
  if (before === null) {
    return exclusion(recorded, 'TARGET_OBSERVATION_MISSING', 'No observation preceded this action.');
  }
  const node = before.nodes.find((candidate) => candidate.ref === action.ref);
  if (node === undefined) {
    // Naming truncation matters for triage: a ref missing from a BUDGET-LIMITED
    // view may have fallen outside the window rather than never existed.
    return exclusion(
      recorded,
      'TARGET_REF_NOT_FOUND',
      before.truncated
        ? 'The action ref was not present in its preceding observation, which was truncated at the driver node budget, so the target may have fallen outside the returned window.'
        : 'The action ref was not present in its preceding observation.',
    );
  }
  const target = predicateFor(node);
  if (target === null) {
    return exclusion(
      recorded,
      'TARGET_HAS_NO_ACCESSIBLE_NAME',
      'Replay export requires a non-empty, unredacted role plus accessible name.',
    );
  }
  // QA-BL-064 (mirrors QA-BL-039's name-only discriminator for drifted
  // node-value assertions, now for the ACTION target): on a real page a
  // server-rendered control can be replaced by a hydrated component that
  // renders the same accessible name under a DIFFERENT role (Wikipedia's
  // search input: textbox -> combobox once Vector's Vue typeahead mounts over
  // it). A target pinned to the LIVE role can then match NOTHING on a fast
  // replay even though the same control is present. Whenever the accessible
  // name is non-empty and unique in the recorded baseline view, export the
  // action target NAME-only and keep the live role only as an advisory
  // roleHint (the loader accepts it and ignores it for matching). A name that
  // is empty or not unique keeps the role+name form — and its uniqueness
  // exclusion. The DurableAction.target stays the role+name predicate: proof
  // synthesis (node-value discriminator, scroll proof) still anchors on it.
  const name = target.name;
  const role = target.role;
  const nameOnly = name !== undefined && countMatches(before, { name }) === 1;
  const exportedTarget: QaNodePredicate = nameOnly && role !== undefined
    ? { name, roleHint: role }
    : target;
  if (!nameOnly && countMatches(before, target) !== 1) {
    return exclusion(
      recorded,
      QA_TARGET_NOT_UNIQUE,
      'Role plus accessible name did not uniquely identify the action target.',
    );
  }
  if (action.kind === 'click') return { action: { kind: 'click', target: exportedTarget }, target };
  if (action.kind === 'fill') {
    if (clean(action.text) === '') {
      return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay fill text must be non-empty.');
    }
    return { action: { kind: 'fill', target: exportedTarget, text: action.text }, target };
  }
  if (action.kind === 'select') {
    if (clean(action.option) === '') {
      return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay select option must be non-empty.');
    }
    return { action: { kind: 'select', target: exportedTarget, option: action.option }, target };
  }
  if (action.kind === 'hover') {
    return { action: { kind: 'hover', target: exportedTarget }, target };
  }
  if (action.kind === 'scroll') {
    return { action: { kind: 'scroll', target: exportedTarget }, target };
  }
  if (clean(action.key) === '') {
    return exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'Replay press key must be non-empty.');
  }
  return { action: { kind: 'press', target: exportedTarget, key: action.key }, target };
}

/**
 * How far (in document-ordered semantic nodes) a delta may sit from the action
 * target and still count as target-proximate evidence. A delta on the target
 * itself, in its subtree, or among the handful of nodes rendered next to it is
 * strong evidence that the action caused it; a delta on the far side of the
 * page is weak (late hydration renaming an unrelated element looks exactly
 * like that). Weak evidence is ranked BELOW strong evidence but never dropped
 * — dropping it would silently lose provable steps.
 */
const PROXIMATE_NODE_DISTANCE = 6;

/**
 * Accessible-name length beyond which a CONTENT-NAMED CONTAINER's delta proof is
 * treated as ordering-fragile. A name this long is the signature of an
 * auto-derived accessible name that concatenates every descendant's text
 * (Wikipedia's search container announces every suggestion in one ~180-character
 * name); a proof on that name can only replay when the remote content returns
 * in the same order, so it is never selected as a proof (see FRAGILE_PROOF_ONLY).
 * The cap applies only to container roles: a LEAF node's long accessible name
 * (e.g. a 92-character link label) is an authored label, not an aggregation, so
 * it stays a valid — if distant — proof.
 */
const FRAGILE_PROOF_NAME_CAP = 80;

/**
 * Roles whose accessible name the driver derives from CONTENTS (concatenated
 * descendant text) rather than an author-supplied label. Only a node with one
 * of these roles can carry an aggregated, order-dependent accessible name.
 */
const CONTENT_NAMED_CONTAINER_ROLES = new Set([
  'search', 'region', 'list', 'listbox', 'group', 'navigation', 'main', 'form', 'table', 'menu',
]);

/** Proximity of a candidate delta to the action target. */
type DeltaProximity = 'target-proximate' | 'distant' | 'not-applicable';

interface SemanticDelta {
  predicate: QaNodePredicate;
  proximity: DeltaProximity;
  /** Human-facing name of the delta, used when recording weak proof. */
  name: string;
}

/** Evidence the delta ranking produced for one action. */
interface DeltaEvidence {
  /** Best non-fragile delta, or null when none exists. */
  delta: SemanticDelta | null;
  /** Best fragile delta the proof rule rejected, when a fragile delta was the
   *  only kind available (named so the caller excludes the step rather than
   *  exporting an order-dependent proof). */
  rejectedFragile: { role: string; name: string } | null;
}

/** Document-order index of the action target, preferring the post-action view. */
function targetAnchor(
  before: QaObservation | null,
  after: QaObservation,
  target: QaNodePredicate | null,
): number | null {
  if (target === null) return null;
  const afterIndex = after.nodes.findIndex((node) => matchesPredicate(node, target));
  if (afterIndex >= 0) return afterIndex;
  if (before === null) return null;
  const beforeIndex = before.nodes.findIndex((node) => matchesPredicate(node, target));
  return beforeIndex >= 0 ? beforeIndex : null;
}

/**
 * True when a delta proof is ORDERING-fragile: the node's accessible name is a
 * concatenation of its children's text, so the proof can only replay when the
 * remote content returns in the same order (Wikipedia's suggestion container
 * re-concatenates on every keystroke, producing one ~180-character name).
 *
 * Only a content-named CONTAINER role can carry such an aggregated name — the
 * driver derives a container's accessible name from its contents, while a LEAF
 * node's long accessible name is an authored label, not an aggregation (the
 * distant-delta regression uses a 92-character link label that must stay
 * exportable). A name assembled from many children is necessarily long, so the
 * length cap is the concrete signal.
 */
function isFragileProofDelta(node: QaSemanticNode): boolean {
  if (!CONTENT_NAMED_CONTAINER_ROLES.has(clean(node.role))) return false;
  return clean(node.name).length > FRAGILE_PROOF_NAME_CAP;
}

function semanticDelta(
  before: QaObservation | null,
  after: QaObservation,
  target: QaNodePredicate | null,
): DeltaEvidence {
  if (before === null) return { delta: null, rejectedFragile: null };
  const anchor = targetAnchor(before, after, target);
  const candidates = after.nodes
    .map((node, order) => {
      const base = predicateFor(node);
      if (base === null || base.name === undefined) return null;
      // Role drift: when the node's accessible name existed in `before` under a
      // DIFFERENT role, the role changed within the trajectory (Wikipedia's
      // search input: textbox -> combobox). Prefer the name-only predicate for
      // the emitted proof when the name is unique in the settled view, exactly
      // like the node-value discriminator; "new" is still decided against the
      // role+name predicate, so a role drift stays a legitimate delta.
      const roleDrifted = before.nodes.some(
        (candidate) => candidate.name === base.name && candidate.role !== base.role,
      );
      const predicate = roleDrifted && countMatches(after, { name: base.name }) === 1
        ? { name: base.name }
        : base;
      return { node, order, base, predicate };
    })
    .filter((item): item is { node: QaSemanticNode; order: number; base: QaNodePredicate; predicate: QaNodePredicate } => (
      item !== null
      && countMatches(after, item.base) === 1
      && countMatches(before, item.base) === 0
    ))
    .map((item) => ({
      ...item,
      proximity: (anchor === null
        ? 'not-applicable'
        : Math.abs(item.order - anchor) <= PROXIMATE_NODE_DISTANCE ? 'target-proximate' : 'distant') as DeltaProximity,
    }));
  candidates.sort((left, right) => {
    // 1. evidence on/near the action target beats evidence anywhere else;
    // 2. then the outcome-announcing roles; 3. then document order.
    const leftProximity = left.proximity === 'distant' ? 1 : 0;
    const rightProximity = right.proximity === 'distant' ? 1 : 0;
    const leftPriority = OUTCOME_ROLE_PRIORITY.get(left.node.role) ?? 10;
    const rightPriority = OUTCOME_ROLE_PRIORITY.get(right.node.role) ?? 10;
    return leftProximity - rightProximity || leftPriority - rightPriority || left.order - right.order;
  });
  // Node-value on the target outranks every delta (decided by the caller);
  // among deltas, a short-named unique delta is the only sound proof. An
  // ordering-fragile container delta is skipped in favour of a sound one, and
  // when it is the ONLY delta it is reported back so the caller excludes the
  // step with FRAGILE_PROOF_ONLY instead of exporting an order-dependent proof.
  const best = candidates.find((item) => !isFragileProofDelta(item.node));
  if (best !== undefined) {
    return {
      delta: { predicate: best.predicate, proximity: best.proximity, name: predicateName(best.predicate) },
      rejectedFragile: null,
    };
  }
  const fragile = candidates.find((item) => isFragileProofDelta(item.node));
  if (fragile === undefined) return { delta: null, rejectedFragile: null };
  return {
    delta: null,
    rejectedFragile: { role: clean(fragile.node.role), name: predicateName(fragile.predicate) },
  };
}

interface SynthesizedAssertion {
  assertion: QaAssertion;
  /** Non-null when the proof is weak, for the human-readable step intent. */
  weakness: string | null;
}

/**
 * The MOST STABLE discriminator for a node-value assertion whose target's role
 * the fill rewrote. A role that changes over time (Wikipedia's search input:
 * `textbox` -> `combobox` once the lazy typeahead module loads) must never be
 * the only thing the predicate binds to, because a fast replay can observe the
 * pre-switch role and then never find the node. Prefer the accessible name
 * alone when it is unique among ALL nodes in the settled view; fall back to
 * role+name only when the name alone is ambiguous (and only when role+name is
 * itself unique — the one case where the changed role is the only unique key).
 */
interface ValueDiscriminator {
  predicate: QaNodePredicate;
  explanation: string;
}

function valueDiscriminator(
  after: QaObservation,
  node: QaSemanticNode,
  target: QaNodePredicate,
  roleChanged: boolean,
): ValueDiscriminator | null {
  const role = clean(node.role);
  const name = clean(node.name);
  if (!roleChanged) {
    // Role stable: role+name is the natural identity (mirrors predicateFor).
    if (role === '' || name === '') return null;
    if (countMatches(after, { role, name }) !== 1) return null;
    return {
      predicate: { role, name },
      explanation: 'role+name: the role stayed stable across the action, so the predicate keeps the role.',
    };
  }
  // Role changed: prefer name-only, which needs only a non-empty unique name.
  if (name !== '' && countMatches(after, { name }) === 1) {
    return {
      predicate: { name },
      explanation: 'name-only: the role changed from "' + (target.role ?? '') + '" to "' + role
        + '" during the action, and the accessible name is unique among all nodes, so the role is omitted '
        + 'to keep replay stable across the role switch.',
    };
  }
  if (name !== '' && role !== '' && countMatches(after, { role, name }) === 1) {
    return {
      predicate: { role, name },
      explanation: 'role+name: the role changed from "' + (target.role ?? '') + '" to "' + role
        + '" during the action and the accessible name is ambiguous, so role+name is the only unique key '
        + '(the changed role is used only because nothing else uniquely identifies the node).',
    };
  }
  return null;
}

/**
 * Prove a fill by its OWN target's value: the most proximate, most durable
 * evidence possible. The target node in the settled observation must carry the
 * typed text (driver-normalized), and the value must not be withheld (secret),
 * truncated (equality against a prefix is invalid), or absent (non-editable /
 * driver without value support). Only then is a `node-value` assertion on the
 * TARGET synthesized; it outranks every delta candidate, including a closer-
 * scoring distant delta.
 */
function synthesizeValueAssertion(
  after: QaObservation,
  target: QaNodePredicate | null,
  action: QaScenarioAction | null,
): SynthesizedAssertion | null {
  // Only a fill writes a value on its own target. The computer `type` verb is
  // not replayable (durableAction excludes it), so it never reaches export.
  if (action === null || action.kind !== 'fill' || target === null) return null;
  const expected = normalizeObservableValue(action.text);
  const node = after.nodes.find((candidate) => matchesPredicate(candidate, target));
  if (node === undefined) {
    // Identity drift: the fill rewrote the target's accessible name or role (a
    // label derived from the current value, or "textbox" -> "combobox" once the
    // suggestions open), so the pre-action predicate no longer matches the same
    // node. Fall back to the SAME identity rule the echo mask uses
    // (settle.ts, isEchoMasked rule 2): a node whose value equals the written
    // text, matching by NAME (role-agnostic) OR by ROLE (name-agnostic), and
    // unique among such candidates. Bind the assertion to that node's CURRENT
    // predicate — the proof stays the target's own value, never node-present of
    // the renamed field alone. Several candidates holding the value with no
    // unique identity fall through (no guess); a flagged
    // (withheld/secure/truncated) value is never asserted.
    const candidates = after.nodes.filter((candidate) =>
      typeof candidate.value === 'string'
      && candidate.value === expected
      && candidate.valueWithheld !== true
      && candidate.secure !== true
      && candidate.valueTruncated !== true
      && (
        (target.name !== undefined && candidate.name === target.name)
        || (target.role !== undefined && candidate.role === target.role)
      ));
    if (candidates.length !== 1) return null;
    const renamed = candidates[0];
    if (renamed === undefined) return null;
    // A role that changed between the pre- and post-action observation is the
    // very thing a fast replay cannot re-match, so the predicate must be the
    // MOST STABLE discriminator, never a re-pinned role (see valueDiscriminator).
    const roleChanged = target.role !== undefined && clean(renamed.role) !== target.role;
    const discriminator = valueDiscriminator(after, renamed, target, roleChanged);
    if (discriminator === null) return null;
    const description = roleChanged
      ? 'Settled post-action observation confirmed the typed value on the action target. Discriminator: ' + discriminator.explanation
      : 'Settled post-action observation confirmed the typed value on the action target, whose accessible name the fill rewrote.';
    return {
      assertion: {
        kind: 'node-value',
        expected: { ...discriminator.predicate, value: expected },
        description,
      },
      weakness: null,
    };
  }
  if (node.valueWithheld === true || node.secure === true) return null;
  if (node.valueTruncated === true) return null;
  if (typeof node.value !== 'string') return null;
  if (node.value !== expected) return null;
  return {
    assertion: {
      kind: 'node-value',
      expected: { ...target, value: expected },
      description: 'Settled post-action observation confirmed the typed value on the action target.',
    },
    weakness: null,
  };
}

/** What synthesizeAssertion resolved for one action. */
interface SynthesisResult {
  /** The synthesized proof assertion, or null when none was derivable. */
  assertion: SynthesizedAssertion | null;
  /** Present exactly when the ONLY observable change was an ordering-fragile
   *  container delta; the step is excluded with FRAGILE_PROOF_ONLY instead of
   *  exporting that delta. */
  fragileOnly: { role: string; name: string } | null;
}

function synthesizeAssertion(
  before: QaObservation | null,
  after: QaObservation,
  target: QaNodePredicate | null,
  action: QaScenarioAction | null,
): SynthesisResult {
  // A fill proven by its own value outranks every other candidate.
  const valueAssertion = synthesizeValueAssertion(after, target, action);
  if (valueAssertion !== null) return { assertion: valueAssertion, fragileOnly: null };
  if (before !== null && before.page.url !== after.page.url && clean(after.page.url) !== '') {
    return {
      assertion: {
        assertion: {
          kind: 'page-url',
          expected: { url: after.page.url },
          description: 'Settled post-action observation reached the recorded URL.',
        },
        weakness: null,
      },
      fragileOnly: null,
    };
  }
  const evidence = semanticDelta(before, after, target);
  if (evidence.delta !== null) {
    const delta = evidence.delta;
    const distant = delta.proximity === 'distant';
    return {
      assertion: {
        assertion: {
          kind: 'node-present',
          expected: delta.predicate,
          description: distant
            ? 'Settled post-action observation exposed a new semantic state, but only away from the action target.'
            : 'Settled post-action observation exposed a new semantic state.',
        },
        weakness: distant
          ? 'the only observable change was away from the action target ("' + delta.name + '")'
          : null,
      },
      fragileOnly: null,
    };
  }
  if (evidence.rejectedFragile !== null) {
    return { assertion: null, fragileOnly: evidence.rejectedFragile };
  }
  // Target persistence is not proof that any action landed, even for a
  // confirmed dispatch receipt. Every exported action needs a semantic delta
  // or URL change from the SETTLED observation above.
  return { assertion: null, fragileOnly: null };
}

/**
 * Weakness recorded when the observation a proof rests on was TRUNCATED at its
 * node budget.
 *
 * Export reasons over node membership in two ways that a truncated view cannot
 * support: a "new" node (present in `after`, absent from `before`) may simply
 * have fallen outside `before`'s budget, and a target that looks unique may
 * have a twin outside the window. The step is still exported — dropping it
 * would silently lose provable work — but the weakness is recorded in the
 * intent exactly like the distant-delta weakness, so a truncated proof
 * observation never silently produces a confident-looking assertion.
 */
const TRUNCATED_PROOF_WEAKNESS =
  'the proof observation was truncated at the driver node budget, so nodes outside the returned window were never seen '
  + '(an apparently new node may have been there all along, and the semantic target may not be unique)';

/** True when either view this step's proof rests on was budget-truncated. */
function proofWasTruncated(before: QaObservation | null, after: QaObservation): boolean {
  return before?.truncated === true || after.truncated === true;
}

/** One { role, name } hop of a recorded semantic ancestor path (QA-BL-062). */
interface ScopePathItem {
  role: string;
  name: string;
}

/**
 * The semantic ancestor path of `node` inside `view`: every EMITTED ancestor
 * on its parentRef chain (composed-tree ancestry, driver contract v9),
 * outermost first. Null when the node has NO emitted ancestor in this view —
 * a parentRef:null root means "no emitted ancestor here", never "document
 * top", so a path is NEVER manufactured from it — or when any hop does not
 * resolve inside the SAME observation (fail closed: a partial chain is not
 * faithful ancestry).
 */
function ancestorPathOf(view: QaObservation, node: QaSemanticNode): ScopePathItem[] | null {
  const byRef = new Map(view.nodes.map((candidate) => [candidate.ref, candidate]));
  const chain: ScopePathItem[] = [];
  let current = node;
  for (let hops = 0; hops <= view.nodes.length; hops += 1) {
    const parentRef = typeof current.parentRef === 'string' && current.parentRef !== '' ? current.parentRef : null;
    if (parentRef === null) {
      return chain.length === 0 ? null : chain.reverse();
    }
    const parent = byRef.get(parentRef);
    if (parent === undefined) return null;
    chain.push({ role: clean(parent.role), name: clean(parent.name) });
    current = parent;
  }
  return null;
}

/**
 * The recorded ancestor path of a scoped container, searched over EVERY
 * recorded observation (the action's baseline first, then chronological
 * order): the FIRST observation that contains the container as a NON-root
 * node with a fully resolvable parentRef chain supplies the path. A scoped
 * observation whose root IS the container can never contribute (its
 * parentRef:null does not mean document top), and a chain that does not
 * resolve is skipped. Null when no recorded observation has real ancestry
 * for the container — the export then omits scope.path.
 */
function recordedContainerPath(
  observations: Readonly<Record<string, QaObservation>>,
  baseline: QaObservation | null,
  role: string,
  name: string,
  tag: string,
): ScopePathItem[] | null {
  const seen = new Set<QaObservation>();
  const sources = [baseline, ...Object.values(observations)];
  for (const observation of sources) {
    if (observation === null || seen.has(observation)) continue;
    seen.add(observation);
    for (const node of observation.nodes) {
      if (node.role !== role || node.name !== name) continue;
      if (tag !== '' && node.tag !== tag) continue;
      const path = ancestorPathOf(observation, node);
      if (path !== null) return path;
    }
  }
  return null;
}

/**
 * True when the recorded action is an IDENTITY-ANCHORED scoped scroll proof:
 * a scroll-by-ref whose recorded proof observation is a SCOPED view carrying
 * the driver's truthful identity anchor. hub-107's recording is the
 * re-bind: the recording adapter re-bound the action's proof to the escalated
 * scoped read ONLY on anchor acceptance (a refused anchor keeps the settled
 * whole-page observation), so an anchor-truthful scoped proof observation IS
 * the acceptance marker. anchor.contained is null for whole-page reads, which
 * makes the check exact.
 */
function anchoredScrollProof(recorded: QaRecordedAction, proof: QaObservation | null): boolean {
  if (proof === null || proof.scope === undefined) return false;
  if (recorded.action.kind !== 'scroll' || !('ref' in recorded.action)) return false;
  const anchor = proof.anchor;
  return anchor !== undefined && anchor.connected === true && anchor.contained === true && anchor.ref !== null;
}

/** The ancestor path for a proof observation's scope, or null when none applies. */
function scopePathFor(
  trajectory: QaTrajectorySnapshot,
  proof: QaObservation | null,
  baseline: QaObservation | null,
): ScopePathItem[] | null {
  if (proof === null || proof.scope === undefined) return null;
  const echo = proof.scope;
  return recordedContainerPath(
    trajectory.observations,
    baseline,
    clean(echo.role),
    clean(echo.name),
    clean(echo.tag),
  );
}

/**
 * The durability verdict for a scoped proof observation's container
 * (QA-BL-054).
 *
 * A scoped proof is exported as DURABLE only when the container predicate is
 * PROVEN unique: role+name (plus tag when needed to disambiguate) must match
 * EXACTLY ONE node in the recorded BASELINE observation, that baseline must
 * be complete (truncated:false), and the baseline must NOT be the container's
 * OWN scoped subtree — a scoped baseline whose root is the container proves
 * nothing, because the container is trivially its own root there (the
 * scoped-complete-baseline trick QA-BL-062 closes). An empty accessible NAME
 * is a legitimate predicate value and is kept LITERALLY (`name: ''`).
 *
 * QA-BL-062: when uniqueness is UNPROVEN and the recorded action is an
 * identity-anchored scroll proof (see anchoredScrollProof), the scope is
 * exported EXPLICITLY PROVISIONAL instead — the assertion carries the scope
 * (with the recorded ancestor path when available) and the step intent
 * carries the provisional weakness, so replay reports INCONCLUSIVE_SCOPE
 * unless it proves the container unique at replay time. Every other scoped
 * assertion with unproven uniqueness is EXCLUDED with SCOPE_NOT_DURABLE — a
 * scoped proof is never silently exported as if it were a whole-page proof.
 *
 * Null means the proof is whole-page (no scope to carry) — only then is the
 * assertion exported unscoped.
 */
type ProofScopeVerdict =
  | { durable: true; scope: QaScenarioAssertionScope; weakness: null }
  | {
      durable: false;
      detail: string;
      provisional: { scope: QaScenarioAssertionScope; weakness: string } | null;
    };

function proofScope(
  proof: QaObservation | null,
  baseline: QaObservation | null,
  anchored: boolean,
  path: ScopePathItem[] | null,
): ProofScopeVerdict | null {
  if (proof === null || proof.scope === undefined) return null;
  const echo = proof.scope;
  const role = clean(echo.role);
  const name = clean(echo.name);
  if (role === '') {
    return {
      durable: false,
      detail: 'the scoped proof\'s container has no role, so the scope cannot be recorded durably.',
      provisional: null,
    };
  }
  const tag = clean(echo.tag);
  const describe = 'the container role "' + role + '" named "' + name + '"'
    + (tag === '' ? '' : ' (tag "' + tag + '")');
  // The tag stays a DISAMBIGUATOR (role+name, plus tag when needed): it rides
  // on the exported scope only when role+name alone was ambiguous in the
  // baseline and the tag resolved it to exactly one node. Unproven exports
  // never add it (no disambiguation was established).
  const scopeValue = (withTag: boolean): QaScenarioAssertionScope => ({
    role,
    name,
    ...(withTag ? { tag } : {}),
    ...(path === null ? {} : { path }),
  });
  const provisionalWeakness = (why: string): string =>
    'the scope is PROVISIONAL: ' + why
    + ' The step is an identity-anchored scroll proof, so the scope is exported explicitly provisional;'
    + ' replay reports INCONCLUSIVE_SCOPE (scopeResolution provisional) unless it proves the container unique at replay time.';
  const unproven = (why: string): ProofScopeVerdict => {
    if (!anchored) {
      return {
        durable: false,
        detail: why + ' — uniqueness is unproven, so the scope is never silently dropped.',
        provisional: null,
      };
    }
    return {
      durable: false,
      detail: why + ' — uniqueness is unproven.',
      provisional: { scope: scopeValue(false), weakness: provisionalWeakness(why) },
    };
  };
  if (baseline === null || baseline.truncated) {
    return unproven(baseline === null
      ? 'no recorded baseline observation precedes the scoped proof, so the uniqueness of ' + describe + ' cannot be proven'
      : 'the recorded baseline observation was truncated at the driver node budget, so ' + describe + ' may have a twin outside the returned window');
  }
  // QA-BL-062: the scoped-complete-baseline trick. A scoped baseline whose
  // root IS the container proves nothing about whole-page uniqueness (it was
  // disclosed only via scopedPrecedingViewWeakness before, which a replay
  // could still green).
  const baselineIsOwnSubtree = baseline.scope !== undefined
    && baseline.scope.role === role
    && baseline.scope.name === name;
  if (baselineIsOwnSubtree) {
    return unproven(
      'the recorded baseline IS ' + describe + '\'s own scoped subtree, where the container is trivially its own root — that view proves nothing about uniqueness',
    );
  }
  const byRoleName = baseline.nodes.filter((node) => node.role === role && node.name === name);
  if (byRoleName.length === 1) return { durable: true, scope: scopeValue(false), weakness: null };
  // role+name is ambiguous: the driver's scope-echo tag may disambiguate the
  // predicate (role+name, plus tag when needed).
  if (byRoleName.length > 1 && tag !== '') {
    const byRoleNameTag = baseline.nodes.filter(
      (node) => node.role === role && node.name === name && node.tag === tag,
    );
    if (byRoleNameTag.length === 1) return { durable: true, scope: scopeValue(true), weakness: null };
  }
  return unproven(describe + ' matches ' + String(byRoleName.length) + ' nodes in the recorded baseline observation');
}

/**
 * Attach the proof observation's scope to a synthesized assertion, so a scoped
 * proof is never exported as if it were a whole-page proof (browser driver
 * contract v8): Replay then re-derives the container, observes within it, and
 * decides the assertion against that scoped view. `page-url` is deliberately
 * NOT scoped — the URL travels on every observation whatever the scope did.
 *
 * QA-BL-054 / QA-BL-062: when the scope is not proven durable against the
 * recorded baseline (see proofScope) and the step is not an identity-anchored
 * scroll proof, the caller EXCLUDES the step with SCOPE_NOT_DURABLE; an
 * identity-anchored scroll proof is exported PROVISIONAL with the recorded
 * ancestor path when available and the weakness named for the step intent.
 */
function withProofScope(
  assertion: QaAssertion,
  proof: QaObservation | null,
  baseline: QaObservation | null,
  anchored: boolean,
  path: ScopePathItem[] | null,
): { assertion: QaAssertion; notDurable: string | null; weakness: string | null } {
  if (assertion.kind === 'page-url') return { assertion, notDurable: null, weakness: null };
  const verdict = proofScope(proof, baseline, anchored, path);
  if (verdict === null) return { assertion, notDurable: null, weakness: null };
  if (verdict.durable) return { assertion: { ...assertion, scope: verdict.scope }, notDurable: null, weakness: null };
  if (verdict.provisional === null) return { assertion, notDurable: verdict.detail, weakness: null };
  return {
    assertion: { ...assertion, scope: verdict.provisional.scope },
    notDurable: null,
    weakness: verdict.provisional.weakness,
  };
}

/**
 * Weakness recorded when the action's PRECEDING observation was scoped: the
 * target predicate and its uniqueness were verified inside the container only,
 * while Replay resolves the action target in the whole-page view.
 */
function scopedPrecedingViewWeakness(before: QaObservation | null): string | null {
  if (before === null || before.scope === undefined) return null;
  const role = clean(before.scope.role);
  if (role === '') return null;
  const name = clean(before.scope.name);
  return 'the action\'s preceding observation was scoped to the ' + role + ' named "'
    + name + '", so the action target\'s whole-page uniqueness was not verified at export '
    + '(Replay resolves the target in the whole-page view) — verify manually.';
}

/**
 * Whether a truncated proof observation can actually WEAKEN this assertion.
 * Truncation weakens a delta-derived presence claim — the "apparently new node"
 * may have been there all along, outside `before`'s window — but it cannot
 * weaken a `page-url` (the URL travels on every observation) or a `node-value`
 * on a FOUND target (a returned node really carries the value the driver
 * reported; see docs/TRUNCATION.md). The weakness note is attached only when
 * truncation can actually weaken the proof.
 */
function truncationWeakensProof(assertion: QaAssertion): boolean {
  return assertion.kind === 'node-present' || assertion.kind === 'node-in-viewport';
}

/** Step intent plus every recorded proof weakness, in one "Weak proof:" note. */
function intentWithWeaknesses(base: string, weaknesses: readonly string[]): string {
  if (weaknesses.length === 0) return base;
  return base + ' Weak proof: ' + weaknesses.join('; ') + ' — verify manually.';
}

/** Assertion proving a scroll made the target reachable (in-viewport). */
function synthesizeScrollAssertion(target: QaNodePredicate): QaAssertion {
  return {
    kind: 'node-in-viewport',
    expected: target,
    description: 'Settled post-scroll observation placed the target in the viewport.',
  };
}

/**
 * Scroll-specific ASSERTION_NOT_PROVABLE detail for a scroll-by-target step
 * whose synthesized node-in-viewport proof failed against the recorded
 * post-action observation. It names the ACTUAL cause — the target was not
 * returned by that observation (and whether the view was truncated, so it may
 * simply have fallen outside the returned window), or it was returned but not
 * in the viewport — never the click/fill wording about "semantic state change
 * or URL change", which is meaningless for a scroll (a scroll by design
 * changes no semantic state and no URL).
 */
function scrollProofFailureDetail(target: QaNodePredicate, after: QaObservation): string {
  const name = predicateName(target);
  const returned = after.nodes.some((node) => matchesPredicate(node, target));
  if (returned) {
    return 'The settled post-action observation returned the scroll target "' + name
      + '" but did not place it in the viewport, so the scroll outcome is unproven.';
  }
  if (after.truncated) {
    return 'The settled post-action observation was truncated at the driver node budget and did not return the '
      + 'scroll target "' + name + '", so the target may have fallen outside the returned window and the scroll '
      + 'outcome is unproven.';
  }
  return 'The settled post-action observation was complete but did not return the scroll target "' + name
    + '", so the scroll outcome is unproven.';
}

/**
 * Normalize line terminators out of a display-only intent string. The intent
 * is prose for the scenario file and the report; the semantic target Replay
 * matches against is stored separately in `action`/`assert`, so flattening
 * newlines here never affects replay matching. This is a source-level hardening
 * on top of the renderer's own Markdown escaping (mandatory regardless): a
 * page-controlled node name must never smuggle a newline into report.md.
 */
function normalizeIntent(value: string): string {
  return value.replace(/\r\n|\r|\n|\u000B|\u000C|\u0085|\u2028|\u2029/gu, '\u23CE');
}

function intentFor(action: QaScenarioAction): string {
  if (action.kind === 'navigate') return 'Navigate to the recorded URL.';
  if (action.kind === 'scroll') {
    if ('target' in action) return 'Scroll to "' + predicateName(action.target) + '".';
    return 'Scroll the viewport ' + action.direction + (action.amount === undefined ? '.' : ' by ' + String(action.amount) + '.');
  }
  const targetName = action.target.name ?? action.target.role ?? 'semantic target';
  if (action.kind === 'click') return 'Click "' + targetName + '".';
  if (action.kind === 'fill') return 'Fill "' + targetName + '".';
  if (action.kind === 'select') return 'Select option "' + action.option + '" on "' + targetName + '".';
  if (action.kind === 'hover') return 'Hover "' + targetName + '".';
  return 'Press ' + action.key + ' on "' + targetName + '".';
}

interface Candidate {
  recorded: QaRecordedAction;
  before: QaObservation | null;
  after: QaObservation | null;
  exclusion: QaExportExclusion | null;
  /** Durable scenario action; null for excluded and direction-scroll candidates. */
  action: QaScenarioAction | null;
  /** Semantic target predicate for ref-based actions; null otherwise. */
  target: QaNodePredicate | null;
}

interface ResolvedScrollStep {
  intent: string;
  action: QaScenarioAction;
  assert: QaAssertion;
}

/**
 * Resolve a positional scroll-by-direction step against the following proven
 * action's target. A direction-scroll is inherently positional, so the
 * exported scenario prefers the durable scroll-by-target form: it scrolls to
 * the same off-viewport element the exploration actually reached next. When
 * that is not derivable, it keeps the positional direction form but proves it
 * with a node-in-viewport assertion against any node the scroll moved into
 * view, and records the positional nature in the step intent. It never
 * silently drops a scroll: a scroll with no observable in-viewport transition
 * is excluded with an explicit reason.
 */
function resolveDirectionScroll(candidates: Candidate[], index: number): ResolvedScrollStep | null {
  const candidate = candidates[index];
  if (candidate === undefined || candidate.before === null || candidate.after === null || candidate.action === null) {
    return null;
  }
  const { before, after } = candidate;
  const positional = candidate.action as { kind: 'scroll'; direction: 'up' | 'down'; amount?: 'page' | number };
  for (let j = index + 1; j < candidates.length; j += 1) {
    const next = candidates[j];
    if (next === undefined || next.exclusion !== null || next.target === null) continue;
    if (isRevealed(before, after, next.target)) {
      return {
        intent: 'Scroll to "' + predicateName(next.target) + '".',
        action: { kind: 'scroll', target: next.target },
        assert: synthesizeScrollAssertion(next.target),
      };
    }
  }
  const anyRevealed = firstRevealedPredicate(before, after);
  if (anyRevealed !== null) {
    return {
      intent: 'Scroll the viewport ' + positional.direction
        + (positional.amount === undefined ? ' (positional).' : ' by ' + String(positional.amount) + ' (positional)')
        + ' to reveal "' + predicateName(anyRevealed) + '".',
      action: positional,
      assert: synthesizeScrollAssertion(anyRevealed),
    };
  }
  return null;
}

/** The pure default settle policy, against which export detects a non-default session policy. */
function defaultSettlePolicy(): QaSettlePolicy {
  return {
    budgetMs: QA_SETTLE_BUDGET_MS,
    quietMs: QA_SETTLE_QUIET_MS,
    postChangeQuietMs: QA_SETTLE_POST_CHANGE_QUIET_MS,
    intervalMs: QA_SETTLE_INTERVAL_MS,
    adaptiveBudgetMs: QA_SETTLE_ADAPTIVE_BUDGET_MS,
  };
}

/**
 * The scenario-schema settle override for a session's effective policy, or
 * undefined when the policy equals the defaults. When a non-default policy is
 * recorded it is written IN FULL (all four fields) so replay reproduces exactly
 * the policy Explore used; values are clamped to the schema bounds
 * (budgetMs <= QA_SETTLE_SCHEMA_BUDGET_MAX, the others <= budgetMs) so the file
 * always round-trips through the loader's own validation.
 */
function scenarioSettleOverride(policy: QaSettlePolicy | null): QaSettleOverride | undefined {
  if (policy === null) return undefined;
  const defaults = defaultSettlePolicy();
  if (
    policy.budgetMs === defaults.budgetMs
    && policy.quietMs === defaults.quietMs
    && policy.postChangeQuietMs === defaults.postChangeQuietMs
    && policy.intervalMs === defaults.intervalMs
    && policy.adaptiveBudgetMs === defaults.adaptiveBudgetMs
  ) {
    return undefined;
  }
  const budgetMs = Math.min(Math.max(1, Math.round(policy.budgetMs)), QA_SETTLE_SCHEMA_BUDGET_MAX);
  const quietMs = Math.min(Math.max(1, Math.round(policy.quietMs)), budgetMs);
  const postChangeQuietMs = Math.min(Math.max(1, Math.round(policy.postChangeQuietMs)), budgetMs);
  const intervalMs = Math.min(Math.max(1, Math.round(policy.intervalMs)), budgetMs);
  // 0 (adaptation disabled) persists as 0, not clamped up to a positive value.
  const adaptiveBudgetMs = policy.adaptiveBudgetMs === 0
    ? 0
    : Math.min(Math.max(1, Math.round(policy.adaptiveBudgetMs)), QA_SETTLE_SCHEMA_BUDGET_MAX);
  return { budgetMs, quietMs, postChangeQuietMs, intervalMs, adaptiveBudgetMs };
}

function buildScenario(
  trajectory: QaTrajectorySnapshot,
  options: QaRecordExportOptions,
): { scenario: QaScenario | null; excluded: QaExportExclusion[]; excludedAssertions: QaAssertionExportExclusion[] } {
  const excluded: QaExportExclusion[] = [];
  const excludedAssertions: QaAssertionExportExclusion[] = [];
  const steps: QaStep[] = [];

  // Pass 1: resolve each action into a durable candidate (or an exclusion)
  // without ordering assumptions, so pass 2 can look ahead past a
  // scroll-by-direction step to the following proven action's target.
  const candidates: Candidate[] = [];
  for (const recorded of trajectory.actions) {
    const receipt = recorded.receipt;
    let early: QaExportExclusion | null = null;
    if (recorded.recordingIssue !== null) {
      early = exclusion(recorded, 'OBSERVATION_RECORDING_FAILED', recorded.recordingIssue);
    } else if (receipt === null) {
      early = exclusion(recorded, 'ACTION_RECEIPT_MISSING', 'No action receipt was recorded.');
    } else if (receipt.status === 'rejected') {
      early = exclusion(
        recorded,
        'ACTION_REJECTED',
        'Rejected action was not exported' + (receipt.code === undefined ? '.' : ' (' + receipt.code + ').'),
      );
    } else if (receipt.status === 'failed') {
      early = exclusion(recorded, 'ACTION_FAILED', 'Failed action was not exported.');
    } else if (!receipt.dispatched) {
      early = exclusion(recorded, 'ACTION_NOT_DISPATCHED', 'The driver did not dispatch this action.');
    } else if (recorded.payloadRedacted) {
      early = exclusion(
        recorded,
        'ACTION_PAYLOAD_REDACTED',
        'Redaction changed a replay-relevant action field, so replay would not be faithful.',
      );
    } else if (recorded.afterObservationId === null) {
      early = exclusion(
        recorded,
        'FRESH_OBSERVATION_MISSING',
        'No immediate fresh post-action observation proved the outcome.',
      );
    } else if (recorded.afterObservationStable !== true) {
      // Fail closed: the bounded settle window never reached two consecutive
      // identical semantic views, so nothing in the post-action observation can
      // be attributed to the action. An unstable page is honestly unprovable.
      early = exclusion(
        recorded,
        'ASSERTION_NOT_PROVABLE',
        recorded.afterObservationStable === null
          ? 'No settle window was recorded for the post-action observation, so its view is unproven.'
          : 'The post-action view never stabilized within the settle budget, so no observation proves the outcome.',
      );
    }
    if (early !== null) {
      candidates.push({ recorded, before: null, after: null, exclusion: early, action: null, target: null });
      continue;
    }
    const before = recorded.beforeObservationId === null
      ? null
      : trajectory.observations[recorded.beforeObservationId] ?? null;
    const afterObservationId = recorded.afterObservationId;
    if (afterObservationId === null) {
      // Unreachable after the early FRESH_OBSERVATION_MISSING guard; refuse fail-closed.
      candidates.push({
        recorded,
        before,
        after: null,
        exclusion: exclusion(
          recorded,
          'FRESH_OBSERVATION_MISSING',
          'No immediate fresh post-action observation proved the outcome.',
        ),
        action: null,
        target: null,
      });
      continue;
    }
    const after = trajectory.observations[afterObservationId] ?? null;
    if (after === null) {
      candidates.push({
        recorded,
        before,
        after: null,
        exclusion: exclusion(
          recorded,
          'OBSERVATION_RECORDING_FAILED',
          'The fresh observation reference has no recorded observation payload.',
        ),
        action: null,
        target: null,
      });
      continue;
    }
    const durable = durableAction(recorded, before);
    if ('reason' in durable) {
      candidates.push({ recorded, before, after, exclusion: durable, action: null, target: null });
      continue;
    }
    candidates.push({
      recorded,
      before,
      after,
      exclusion: null,
      action: durable.action,
      target: durable.target,
    });
  }

  // Pass 2: assemble steps in order, resolving scroll-by-direction steps
  // against the following proven action's target.
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    if (candidate.exclusion !== null) {
      excluded.push(candidate.exclusion);
      continue;
    }
    const recorded = candidate.recorded;
    const receipt = recorded.receipt;
    const isDirectionScroll = candidate.action !== null
      && candidate.action.kind === 'scroll'
      && 'direction' in candidate.action;
    if (isDirectionScroll) {
      const resolved = resolveDirectionScroll(candidates, i);
      if (resolved === null) {
        excluded.push(exclusion(
          recorded,
          'ASSERTION_NOT_PROVABLE',
          'Scroll-by-direction had no observable in-viewport transition in the fresh observation.',
        ));
        continue;
      }
      const scopedBeforeWeakness = scopedPrecedingViewWeakness(candidate.before);
      const anchored = anchoredScrollProof(recorded, candidate.after);
      const scopePath = scopePathFor(trajectory, candidate.after, candidate.before);
      const scopedStep = withProofScope(resolved.assert, candidate.after, candidate.before, anchored, scopePath);
      if (scopedStep.notDurable !== null) {
        // QA-BL-054: a scoped proof whose container is not proven durable (and
        // is not an identity-anchored scroll proof) is EXCLUDED, never
        // silently exported as an unscoped assertion.
        excluded.push(exclusion(recorded, QA_SCOPE_NOT_DURABLE, scopedStep.notDurable));
        continue;
      }
      steps.push({
        index: steps.length + 1,
        intent: normalizeIntent(intentWithWeaknesses(
          resolved.intent,
          [
            ...(candidate.after !== null
              && proofWasTruncated(candidate.before, candidate.after)
              && truncationWeakensProof(resolved.assert)
              ? [TRUNCATED_PROOF_WEAKNESS]
              : []),
            ...(scopedBeforeWeakness === null ? [] : [scopedBeforeWeakness]),
            ...(scopedStep.weakness === null ? [] : [scopedStep.weakness]),
          ],
        )),
        action: resolved.action,
        assert: scopedStep.assertion,
        // QA-BL-067: the recorded record-time proof refusal rides on the step
        // (additive) so report.md step lines surface it.
        ...(candidate.recorded.scrollProofRefusal === null
          ? {}
          : { escalationRefused: candidate.recorded.scrollProofRefusal }),
      });
      continue;
    }
    const after = candidate.after;
    if (after === null) {
      // Unreachable for a durable candidate; refuse fail-closed rather than guessing.
      excluded.push(exclusion(
        recorded,
        'OBSERVATION_RECORDING_FAILED',
        'The fresh observation reference has no recorded observation payload.',
      ));
      continue;
    }
    const stepAction = candidate.action;
    if (stepAction === null) {
      // Unreachable for a durable candidate; refuse fail-closed rather than guessing.
      excluded.push(exclusion(recorded, 'UNSUPPORTED_REPLAY_ACTION', 'The action had no durable replay form.'));
      continue;
    }
    const synthesized: SynthesisResult = stepAction.kind === 'scroll' && candidate.target !== null
      ? { assertion: { assertion: synthesizeScrollAssertion(candidate.target), weakness: null }, fragileOnly: null }
      : synthesizeAssertion(candidate.before, after, candidate.target, stepAction);
    if (synthesized.fragileOnly !== null) {
      // The only observable change was an ordering-fragile container whose
      // accessible name concatenates its children's text. Exporting it would
      // make replay depend on remote content order, so the step is excluded
      // rather than proven by a name that only matches by luck.
      excluded.push(exclusion(
        recorded,
        'FRAGILE_PROOF_ONLY',
        'The only observable change was the container role "' + synthesized.fragileOnly.role
          + '" named "' + synthesized.fragileOnly.name + '", whose accessible name concatenates child '
          + 'text and depends on remote content order.',
      ));
      continue;
    }
    if (synthesized.assertion === null || !evaluateAssertion(synthesized.assertion.assertion, after).passed) {
      // A scroll-by-target step whose node-in-viewport proof failed must say
      // WHY (target outside the window, or returned but not in the viewport):
      // the click/fill "no semantic state change or URL change" wording would
      // be wrong for a scroll, which by design changes neither.
      excluded.push(exclusion(
        recorded,
        'ASSERTION_NOT_PROVABLE',
        stepAction.kind === 'scroll' && candidate.target !== null
          ? scrollProofFailureDetail(candidate.target, after)
          : receipt?.status === 'unknown'
            ? 'Unknown receipt had no semantic state change in the settled observation.'
            : 'The settled observation had no semantic state change or URL change proving the action outcome.',
      ));
      continue;
    }
    // A distant delta is still exported (dropping it would silently lose the
    // step), but the weakness is recorded in the intent so a human can see why
    // the assertion looks unrelated to the action. A proof observation that was
    // truncated at the node budget is recorded the same honest way — but only
    // when truncation can actually weaken the assertion kind (see
    // truncationWeakensProof). A scoped preceding observation is recorded too:
    // the target's whole-page uniqueness was never verified at export.
    const scopedBeforeWeakness = scopedPrecedingViewWeakness(candidate.before);
    const anchored = anchoredScrollProof(recorded, after);
    const scopePath = scopePathFor(trajectory, after, candidate.before);
    const scopedStep = withProofScope(synthesized.assertion.assertion, after, candidate.before, anchored, scopePath);
    if (scopedStep.notDurable !== null) {
      // QA-BL-054: a scoped proof whose container is not proven durable (and
      // is not an identity-anchored scroll proof) is EXCLUDED, never
      // silently exported as an unscoped assertion.
      excluded.push(exclusion(recorded, QA_SCOPE_NOT_DURABLE, scopedStep.notDurable));
      continue;
    }
    const intent = normalizeIntent(intentWithWeaknesses(intentFor(stepAction), [
      ...(synthesized.assertion.weakness === null ? [] : [synthesized.assertion.weakness]),
      ...(proofWasTruncated(candidate.before, after) && truncationWeakensProof(synthesized.assertion.assertion)
        ? [TRUNCATED_PROOF_WEAKNESS]
        : []),
      ...(scopedBeforeWeakness === null ? [] : [scopedBeforeWeakness]),
      ...(scopedStep.weakness === null ? [] : [scopedStep.weakness]),
    ]));
    steps.push({
      index: steps.length + 1,
      intent,
      action: stepAction,
      // A scoped proof observation exports as a scoped assertion — never as if
      // it were a whole-page proof (browser driver contract v8).
      assert: scopedStep.assertion,
      // QA-BL-067: the recorded record-time proof refusal rides on the step
      // (additive) so report.md step lines surface it.
      ...(candidate.recorded.scrollProofRefusal === null
        ? {}
        : { escalationRefused: candidate.recorded.scrollProofRefusal }),
    });
  }

  if (steps.length === 0) return { scenario: null, excluded, excludedAssertions };

  // QA-BL-066: recorded deterministic qa_assert decisions become the
  // scenario's final assertions. A PASSED scoped assertion carries its scope
  // through the SAME withProofScope path as step proofs (QA-BL-054 rules
  // unchanged: a scope not proven durable against a complete whole-page
  // baseline is EXCLUDED with SCOPE_NOT_DURABLE, never silently dropped or
  // exported as a whole-page assertion). Failed decisions were already
  // surfaced live and are not exported — the scenario re-proves the proven
  // trajectory. When no passed assertion was recorded, the final assertion
  // stays the last step's proof copy, exactly as before.
  const recordedAssertions: QaAssertion[] = [];
  for (const recorded of trajectory.assertions) {
    if (!recorded.passed) continue;
    const deciding = recorded.decidingObservationId === null
      ? null
      : trajectory.observations[recorded.decidingObservationId] ?? null;
    if (deciding === null) {
      excludedAssertions.push({
        reason: 'OBSERVATION_RECORDING_FAILED',
        detail: 'the assertion decision has no recorded deciding observation, so its scope cannot be proven durable.',
      });
      continue;
    }
    const baseline = recorded.baselineObservationId === null
      ? null
      : trajectory.observations[recorded.baselineObservationId] ?? null;
    const scopePath = scopePathFor(trajectory, deciding, baseline);
    const scoped = withProofScope(recorded.assertion, deciding, baseline, false, scopePath);
    if (scoped.notDurable !== null) {
      // QA-BL-054: a scoped proof whose container is not proven durable is
      // EXCLUDED, never silently exported as an unscoped assertion.
      excludedAssertions.push({ reason: QA_SCOPE_NOT_DURABLE, detail: scoped.notDurable });
      continue;
    }
    recordedAssertions.push(scoped.assertion);
  }

  const fallbackName = 'explore-' + trajectory.driver + '-' + trajectory.startedAt.slice(0, 10);
  // Explore visual findings are informational notes, never blocking assertions:
  // only the deterministic question text is surfaced, so the exported scenario
  // replays byte-identically without a vision model available.
  const visualNotes = trajectory.visualFindings.map((finding) => 'visual finding: ' + finding.question);
  // Persist the Explore session's effective settle policy so replay judges the
  // page with the same budget/quiet windows (omitted when it is the default).
  const settleOverride = scenarioSettleOverride(trajectory.settlePolicy);
  const rawScenario: QaScenario = {
    meta: {
      name: redactText(options.name?.trim() || fallbackName),
      description: redactText(
        options.description?.trim()
          || 'Scenario exported from an evidence-backed Explore trajectory.',
      ),
      driver: trajectory.driver,
      createdAt: new Date().toISOString(),
      ...(visualNotes.length === 0 ? {} : { notes: visualNotes }),
      ...(settleOverride === undefined ? {} : { settle: settleOverride }),
    },
    target: { launch: trajectory.launch },
    steps,
    // The recorded (passed) qa_assert decisions replace the synthesized
    // steps-copy when any were exported; otherwise the final assertion stays
    // the last step's proof copy, exactly as before QA-BL-066.
    assertions: recordedAssertions.length > 0 ? recordedAssertions : [steps[steps.length - 1]!.assert],
  };
  // Every free-text field above already came from the recorder's redacted
  // projection (or redactText for generated metadata); operational URLs came
  // through the recorder's stricter component-wise Replay URL projection.
  return { scenario: validateScenario(rawScenario), excluded, excludedAssertions };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function safeOutputPath(options: QaRecordExportOptions): Promise<{
  actual: string;
  projected: string;
}> {
  if (typeof options.outputPath !== 'string' || options.outputPath.trim() === '') {
    throw new TypeError('qa_record_export output_path must be a non-empty string');
  }
  const requested = resolve(options.outputPath);
  if (!requested.endsWith('.json')) throw new Error('qa_record_export output_path must end in .json');
  const parent = await realpath(dirname(requested));
  const workspace = await realpath(resolve(options.workspaceRoot ?? process.cwd()));
  let temp = await realpath(resolve(options.tempRoot ?? tmpdir()));
  if (temp === workspace) temp = join(workspace, '.dsh-qa-temp-root');
  if (!inside(workspace, parent) && !inside(temp, parent)) {
    throw new Error('qa_record_export output_path must be under the current workspace or temporary directory');
  }
  const actual = join(parent, basename(requested));
  try {
    const existing = await lstat(actual);
    if (existing.isSymbolicLink()) throw new Error('qa_record_export refuses a symbolic-link output file');
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw error;
  }
  const artifacts = join(workspace, '.dsh-qa-artifacts-root');
  const projected = projectArtifactPath(actual, { workspace, temp, artifacts });
  return { actual, projected };
}

export async function exportRecordedScenario(
  recorder: QaTrajectoryRecorder,
  ownerId: string,
  options: QaRecordExportOptions,
): Promise<QaRecordExportResult> {
  const trajectory = recorder.snapshot(ownerId);
  if (trajectory === null) {
    return {
      ok: false,
      code: 'NO_TRAJECTORY',
      error: 'No Explore trajectory exists for this owner; start and explore a session first.',
      excludedActions: [],
      excludedAssertions: [],
    };
  }
  if (trajectory.driver !== 'browser') {
    return {
      ok: false,
      code: 'DRIVER_NOT_REPLAYABLE',
      error: 'Replay v0.1 supports browser scenarios only; the computer trajectory was retained but not exported.',
      excludedActions: [],
      excludedAssertions: [],
    };
  }
  const built = buildScenario(trajectory, options);
  if (built.scenario === null) {
    return {
      ok: false,
      code: 'NO_PROVEN_STEPS',
      error: 'No action had both a durable semantic target and an outcome proven by a fresh observation; no file was written.',
      excludedActions: built.excluded,
      excludedAssertions: built.excludedAssertions,
    };
  }
  const output = await safeOutputPath(options);
  await writeFile(
    output.actual,
    JSON.stringify(built.scenario, null, 2) + '\n',
    { encoding: 'utf8', flag: options.overwrite === true ? 'w' : 'wx' },
  );
  // Read the exact bytes back through the existing fail-closed loader. Export
  // has no private parser, repair path, or special-case schema.
  const loaded = loadScenarioFromPath(output.actual);
  return {
    ok: true,
    artifact: { path: output.projected, kind: 'scenario' },
    scenario: loaded,
    trajectory: {
      events: trajectory.events.length,
      observations: Object.keys(trajectory.observations).length,
      actions: trajectory.actions.length,
      evidenceReferences: trajectory.evidenceReferences,
    },
    excludedActions: built.excluded,
    excludedAssertions: built.excludedAssertions,
  };
}
