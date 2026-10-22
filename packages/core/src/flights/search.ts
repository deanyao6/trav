/**
 * Search strategies over one choice per member. All three return complete,
 * feasible (for the ACTIVE group-level constraints) assignments sorted by
 * `compareLeaves`, at most `k` of them.
 *
 * - `exactSearch`      depth-first branch-and-bound; exact.
 * - `beamSearch`       keeps the `width` best partial assignments per member;
 *                      seeded with the cheapest feasible pick per member so it
 *                      is never worse than that baseline.
 * - `exhaustiveSearch` plain cartesian product; the oracle for property tests.
 *
 * Member-level constraints (cap, refundable, fairness bound) are applied by the
 * caller when it builds `lists`. Group-level ones (max arrival spread, fairness)
 * are checked here: arrival spread is monotone so partials can be pruned;
 * fairness needs the full median so it is checked at the leaves.
 */
import { TravError } from '../errors.js';
import { EMPTY_AGG, combine, extendAgg, fairnessOffenders, fairnessPpm, termsOf } from './score.js';
import type { Agg, Cand, Prepared, Terms } from './score.js';
import type { OptimizerConstraints } from './types.js';

export interface Leaf {
  /** One per prepared member, in `Prepared.members` order. */
  readonly picks: readonly Cand[];
  readonly terms: Terms;
  readonly score: number;
  /** Offer ids joined in member order; the final deterministic tie-break. */
  readonly key: string;
}

/** Score asc, then cheaper, then tighter arrivals, then offer-id key. */
export function compareLeaves(a: Leaf, b: Leaf): number {
  if (a.score !== b.score) return a.score - b.score;
  if (a.terms.costMinor !== b.terms.costMinor) return a.terms.costMinor - b.terms.costMinor;
  if (a.terms.arrivalSpreadMinutes !== b.terms.arrivalSpreadMinutes) {
    return a.terms.arrivalSpreadMinutes - b.terms.arrivalSpreadMinutes;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

interface GroupChecks {
  readonly maxArrival: number | undefined;
  readonly ppm: bigint | null;
}

function groupChecks(active: OptimizerConstraints): GroupChecks {
  return {
    maxArrival: active.maxArrivalSpreadMinutes,
    ppm:
      active.fairnessMaxAboveMedian === undefined
        ? null
        : fairnessPpm(active.fairnessMaxAboveMedian),
  };
}

function leafOf(picks: readonly Cand[], p: Prepared): Leaf {
  let agg: Agg = EMPTY_AGG;
  for (const c of picks) agg = extendAgg(agg, c);
  const terms = termsOf(agg);
  return {
    picks,
    terms,
    score: combine(terms, p.input.weights, p.exponent),
    key: picks.map((c) => c.choice.offerId).join('|'),
  };
}

function fairnessOk(picks: readonly Cand[], p: Prepared, checks: GroupChecks): boolean {
  if (checks.ppm === null) return true;
  return (
    fairnessOffenders(
      picks.map((c) => c.price),
      p.members,
      checks.ppm,
    ).length === 0
  );
}

/** Cheapest-first member order: fewest options first keeps the tree narrow at the top. */
function memberOrder(lists: readonly (readonly Cand[])[]): number[] {
  return lists
    .map((list, i) => i)
    .sort((a, b) => (lists[a]?.length ?? 0) - (lists[b]?.length ?? 0) || a - b);
}

/** sufMin[d] = sum of the cheapest fare of every member from order position d onward. */
function suffixMinCost(lists: readonly (readonly Cand[])[], order: readonly number[]): number[] {
  const suf = new Array<number>(order.length + 1).fill(0);
  for (let d = order.length - 1; d >= 0; d -= 1) {
    const first = lists[order[d] ?? -1]?.[0];
    if (first === undefined) throw new TravError('invariant_violation', 'empty candidate list');
    suf[d] = (suf[d + 1] ?? 0) + first.price;
  }
  return suf;
}

function insertTopK(top: Leaf[], leaf: Leaf, k: number): void {
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareLeaves(top[mid] as Leaf, leaf) <= 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= k) return;
  top.splice(lo, 0, leaf);
  if (top.length > k) top.pop();
}

export interface ExactResult {
  readonly leaves: Leaf[];
  /** False when `nodeBudget` ran out; `leaves` are then the best seen so far. */
  readonly complete: boolean;
}

/**
 * Depth-first branch-and-bound. Exact when it completes. `nodeBudget` caps the
 * number of partial assignments expanded so the worst case (many near-ties)
 * still terminates; `Infinity` means run to completion.
 */
export function exactSearch(
  p: Prepared,
  lists: readonly (readonly Cand[])[],
  active: OptimizerConstraints,
  k: number,
  nodeBudget = Infinity,
): ExactResult {
  const n = lists.length;
  const order = memberOrder(lists);
  const sufMin = suffixMinCost(lists, order);
  const checks = groupChecks(active);
  const w = p.input.weights;
  const exponent = p.exponent;
  const top: Leaf[] = [];
  const assigned: Cand[] = new Array<Cand>(n);
  let nodes = 0;
  let exhausted = false;

  const rec = (depth: number, agg: Agg): void => {
    if (depth === n) {
      const picks = assigned.slice();
      if (!fairnessOk(picks, p, checks)) return;
      insertTopK(top, leafOf(picks, p), k);
      return;
    }
    const memberIndex = order[depth] ?? 0;
    const list = lists[memberIndex] ?? [];
    const remaining = sufMin[depth + 1] ?? 0;
    for (const cand of list) {
      if (exhausted) return;
      nodes += 1;
      if (nodes > nodeBudget) {
        exhausted = true;
        return;
      }
      const next = extendAgg(agg, cand);
      const terms = termsOf(next);
      if (checks.maxArrival !== undefined && terms.arrivalSpreadMinutes > checks.maxArrival) {
        continue;
      }
      const lowerBound = combine({ ...terms, costMinor: terms.costMinor + remaining }, w, exponent);
      // Strictly greater: equal-score leaves may still win on the tie-break.
      if (top.length === k && lowerBound > (top[k - 1] as Leaf).score) continue;
      assigned[memberIndex] = cand;
      rec(depth + 1, next);
    }
  };

  rec(0, EMPTY_AGG);
  return { leaves: top, complete: !exhausted };
}

interface BeamState {
  readonly agg: Agg;
  /** Picks so far, aligned with `order[0..depth)`. */
  readonly picks: readonly Cand[];
  readonly lowerBound: number;
  readonly key: string;
}

function compareStates(a: BeamState, b: BeamState): number {
  if (a.lowerBound !== b.lowerBound) return a.lowerBound - b.lowerBound;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * `seeds` are already-feasible leaves (e.g. from a budget-limited exact run)
 * merged into the final pool, so the beam is never worse than them.
 */
export function beamSearch(
  p: Prepared,
  lists: readonly (readonly Cand[])[],
  active: OptimizerConstraints,
  k: number,
  width: number,
  seeds: readonly Leaf[] = [],
): Leaf[] {
  const n = lists.length;
  const order = memberOrder(lists);
  const sufMin = suffixMinCost(lists, order);
  const checks = groupChecks(active);
  const w = p.input.weights;
  const exponent = p.exponent;

  let states: BeamState[] = [{ agg: EMPTY_AGG, picks: [], lowerBound: 0, key: '' }];
  for (let depth = 0; depth < n; depth += 1) {
    const list = lists[order[depth] ?? 0] ?? [];
    const remaining = sufMin[depth + 1] ?? 0;
    const next: BeamState[] = [];
    for (const s of states) {
      for (const cand of list) {
        const agg = extendAgg(s.agg, cand);
        const terms = termsOf(agg);
        if (checks.maxArrival !== undefined && terms.arrivalSpreadMinutes > checks.maxArrival) {
          continue;
        }
        next.push({
          agg,
          picks: [...s.picks, cand],
          lowerBound: combine({ ...terms, costMinor: terms.costMinor + remaining }, w, exponent),
          key: `${s.key}|${cand.choice.offerId}`,
        });
      }
    }
    next.sort(compareStates);
    states = next.slice(0, width);
  }

  // Re-align picks from search order to member order.
  const toMemberOrder = (picksInOrder: readonly Cand[]): Cand[] => {
    const out = new Array<Cand>(n);
    picksInOrder.forEach((cand, d) => {
      out[order[d] ?? 0] = cand;
    });
    return out;
  };

  const leaves = new Map<string, Leaf>();
  for (const seed of seeds) leaves.set(seed.key, seed);
  for (const s of states) {
    const picks = toMemberOrder(s.picks);
    if (!fairnessOk(picks, p, checks)) continue;
    const leaf = leafOf(picks, p);
    leaves.set(leaf.key, leaf);
  }
  // Seed: the cheapest feasible pick per member, so the beam never loses to it.
  const seed = lists.map((list) => list[0]);
  if (seed.every((c): c is Cand => c !== undefined)) {
    const leaf = leafOf(seed, p);
    const arrivalOk =
      checks.maxArrival === undefined || leaf.terms.arrivalSpreadMinutes <= checks.maxArrival;
    if (arrivalOk && fairnessOk(seed, p, checks)) leaves.set(leaf.key, leaf);
  }
  return [...leaves.values()].sort(compareLeaves).slice(0, k);
}

/** Every combination, no pruning, no bounds. The oracle. */
export function exhaustiveSearch(
  p: Prepared,
  lists: readonly (readonly Cand[])[],
  active: OptimizerConstraints,
  k: number,
): Leaf[] {
  const n = lists.length;
  const checks = groupChecks(active);
  const all: Leaf[] = [];
  const idx = new Array<number>(n).fill(0);
  for (;;) {
    const picks = lists.map((list, i) => list[idx[i] ?? 0] as Cand);
    const leaf = leafOf(picks, p);
    const arrivalOk =
      checks.maxArrival === undefined || leaf.terms.arrivalSpreadMinutes <= checks.maxArrival;
    if (arrivalOk && fairnessOk(picks, p, checks)) all.push(leaf);
    // Odometer increment.
    let pos = n - 1;
    while (pos >= 0) {
      idx[pos] = (idx[pos] ?? 0) + 1;
      if ((idx[pos] ?? 0) < (lists[pos]?.length ?? 0)) break;
      idx[pos] = 0;
      pos -= 1;
    }
    if (pos < 0) break;
  }
  return all.sort(compareLeaves).slice(0, k);
}

/** Smallest window of arrival times that contains one choice per member (sliding window). */
export function minArrivalSpreadMinutes(lists: readonly (readonly Cand[])[]): number {
  const events: { arr: number; member: number }[] = [];
  lists.forEach((list, member) => list.forEach((c) => events.push({ arr: c.arr, member })));
  events.sort((a, b) => a.arr - b.arr);
  const need = lists.length;
  const counts = new Array<number>(need).fill(0);
  let covered = 0;
  let best = Infinity;
  let left = 0;
  for (let right = 0; right < events.length; right += 1) {
    const e = events[right] as { arr: number; member: number };
    if ((counts[e.member] ?? 0) === 0) covered += 1;
    counts[e.member] = (counts[e.member] ?? 0) + 1;
    while (covered === need) {
      const l = events[left] as { arr: number; member: number };
      best = Math.min(best, e.arr - l.arr);
      counts[l.member] = (counts[l.member] ?? 0) - 1;
      if ((counts[l.member] ?? 0) === 0) covered -= 1;
      left += 1;
    }
  }
  return best === Infinity ? 0 : Math.round(best / 60_000);
}
