/**
 * Relaxation driver and result assembly.
 *
 * Constraint handling: first search with every constraint active. If nothing
 * is feasible, try relaxing subsets of constraints, smallest subsets first and
 * within a size in `RELAX_ORDER` (least painful first), and stop at the first
 * subset that yields an itinerary. Everything returned carries that subset in
 * `relaxed`, each with a concrete reason.
 */
import { TravError } from '../errors.js';
import { formatMoney, money } from '../money.js';
import type { Money } from '../money.js';
import { buildRationale, formatMinutes, joinNames } from './rationale.js';
import {
  breakdownOf,
  fairnessOffenders,
  fairnessPpm,
  medianTimes2,
  memberLevelOk,
  prepare,
} from './score.js';
import type { Cand, Prepared } from './score.js';
import {
  beamSearch,
  exactSearch,
  exhaustiveSearch,
  minArrivalSpreadMinutes,
  newSearchWork,
} from './search.js';
import type { Leaf, SearchWork } from './search.js';
import type {
  GroupItinerary,
  MemberTravel,
  OptimizerConstraints,
  OptimizerInput,
  OptimizerResult,
  RelaxedConstraint,
} from './types.js';

type ConstraintKey = keyof OptimizerConstraints;
type Strategy = 'auto' | 'exact' | 'beam' | 'exhaustive';

/** Relaxed first → last. The cap and fairness are the ones people set on purpose. */
const RELAX_ORDER: readonly ConstraintKey[] = [
  'maxArrivalSpreadMinutes',
  'refundableOnly',
  'fairnessMaxAboveMedian',
  'perPersonCap',
];

/** Combinations at or below this run the exact search unbounded in `auto` mode. */
export const EXACT_COMBINATION_LIMIT = 200_000;
/** Above the limit, `auto` still tries branch-and-bound but stops after this many expansions. */
export const EXACT_NODE_BUDGET = 400_000;
/** Beam width in `beam` mode; doubled twice if fairness filtered everything out. */
export const BEAM_WIDTH = 1_500;
const BEAM_RETRIES = 2;

function presentConstraints(c: OptimizerConstraints): ConstraintKey[] {
  return RELAX_ORDER.filter((k) =>
    k === 'refundableOnly' ? c.refundableOnly === true : c[k] !== undefined,
  );
}

/** Subsets of `keys` by size, then in `keys` order (lexicographic on positions). */
function* subsetsBySize(keys: readonly ConstraintKey[]): Generator<ConstraintKey[]> {
  const n = keys.length;
  for (let size = 0; size <= n; size += 1) {
    const idx = Array.from({ length: size }, (_, i) => i);
    for (;;) {
      yield idx.map((i) => keys[i] as ConstraintKey);
      // Next combination in lexicographic order.
      let pos = size - 1;
      while (pos >= 0 && (idx[pos] ?? 0) === n - size + pos) pos -= 1;
      if (pos < 0) break;
      idx[pos] = (idx[pos] ?? 0) + 1;
      for (let j = pos + 1; j < size; j += 1) idx[j] = (idx[j - 1] ?? 0) + 1;
    }
  }
}

function withoutConstraints(
  c: OptimizerConstraints,
  relaxed: readonly ConstraintKey[],
): OptimizerConstraints {
  const out: {
    perPersonCap?: Money;
    fairnessMaxAboveMedian?: number;
    maxArrivalSpreadMinutes?: number;
    refundableOnly?: boolean;
  } = {};
  if (c.perPersonCap !== undefined && !relaxed.includes('perPersonCap')) {
    out.perPersonCap = c.perPersonCap;
  }
  if (c.fairnessMaxAboveMedian !== undefined && !relaxed.includes('fairnessMaxAboveMedian')) {
    out.fairnessMaxAboveMedian = c.fairnessMaxAboveMedian;
  }
  if (c.maxArrivalSpreadMinutes !== undefined && !relaxed.includes('maxArrivalSpreadMinutes')) {
    out.maxArrivalSpreadMinutes = c.maxArrivalSpreadMinutes;
  }
  if (c.refundableOnly === true && !relaxed.includes('refundableOnly')) {
    out.refundableOnly = true;
  }
  return out;
}

interface Lists {
  /** Filtered by the member-level constraints in `active` (cap, refundable). Used for reasons. */
  readonly base: readonly (readonly Cand[])[];
  /** `base` further pruned by the fairness bound; what the search runs on. */
  readonly pruned: readonly (readonly Cand[])[];
}

/**
 * Per-member candidate lists under `active`. Returns null when some member has
 * nothing left. The fairness bound is a sound pruning (see `memberLevelOk`),
 * iterated to a fixpoint since pruning lowers the per-member maxima; it is
 * skipped for the exhaustive oracle so the oracle stays independent of it.
 */
function filterLists(
  p: Prepared,
  active: OptimizerConstraints,
  useFairnessBound: boolean,
): Lists | null {
  const base = p.cands.map((list, i) =>
    list.filter((c) => memberLevelOk(c, p.members[i] as MemberTravel, active, null)),
  );
  if (base.some((l) => l.length === 0)) return null;
  let pruned = base;
  const x = active.fairnessMaxAboveMedian;
  if (useFairnessBound && x !== undefined) {
    const ppm = fairnessPpm(x);
    for (;;) {
      const maxes = pruned.map((l) => (l[l.length - 1] as Cand).price);
      const bound = { maxMedianX2: medianTimes2(maxes), ppm };
      const next = pruned.map((list, i) =>
        list.filter((c) =>
          memberLevelOk(c, p.members[i] as MemberTravel, { fairnessMaxAboveMedian: x }, bound),
        ),
      );
      if (next.some((l) => l.length === 0)) return null;
      const changed = next.some((l, i) => l.length !== (pruned[i] as readonly Cand[]).length);
      pruned = next;
      if (!changed) break;
    }
  }
  return { base, pruned };
}

function combinationCount(lists: readonly (readonly Cand[])[]): number {
  return lists.reduce((acc, l) => acc * l.length, 1);
}

function runBeam(
  p: Prepared,
  lists: readonly (readonly Cand[])[],
  active: OptimizerConstraints,
  k: number,
  seeds: readonly Leaf[],
  work: SearchWork,
): Leaf[] {
  let width = BEAM_WIDTH;
  for (let attempt = 0; ; attempt += 1) {
    const leaves = beamSearch(p, lists, active, k, width, seeds, work);
    if (leaves.length > 0 || attempt === BEAM_RETRIES) return leaves;
    width *= 2;
  }
}

function runStrategy(
  strategy: Strategy,
  p: Prepared,
  lists: readonly (readonly Cand[])[],
  active: OptimizerConstraints,
  k: number,
  work: SearchWork,
): Leaf[] {
  switch (strategy) {
    case 'exact':
      return exactSearch(p, lists, active, k, Infinity, work).leaves;
    case 'exhaustive':
      return exhaustiveSearch(p, lists, active, k, work);
    case 'beam':
      return runBeam(p, lists, active, k, [], work);
    case 'auto': {
      // Small: exact, unbounded. Large: exact under a node budget (branch-and-
      // bound usually finishes in milliseconds), then the beam seeded with
      // whatever the exact run found if the budget ran out.
      const small = combinationCount(lists) <= EXACT_COMBINATION_LIMIT;
      const exact = exactSearch(p, lists, active, k, small ? Infinity : EXACT_NODE_BUDGET, work);
      if (exact.complete) return exact.leaves;
      return runBeam(p, lists, active, k, exact.leaves, work);
    }
    default:
      throw new TravError('invalid_argument', `unknown search mode ${String(strategy)}`);
  }
}

// ---------- relax reasons ----------

function nameOf(m: MemberTravel): string {
  return m.name ?? m.memberId;
}

/**
 * A percentage in tenths, as text: 100 → "10%", 125 → "12.5%". Integer input
 * so there is no float formatting drift.
 */
function pctText(tenths: bigint): string {
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? `${whole}%` : `${whole}.${frac}%`;
}

/**
 * The fairness limit shown to people, rounded *down* to a tenth of a percent,
 * and an overshoot rounded *up*. Together they guarantee that anyone named as
 * over the limit reads as strictly above it ("10.1% above (limit 10%)"), never
 * equal to it.
 */
function fairnessLimitTenths(ppm: bigint): bigint {
  return ppm / 1000n;
}

function overshootTenths(priceMinor: number, medianX2: number): bigint {
  const num = (BigInt(2 * priceMinor) - BigInt(medianX2)) * 1000n;
  const den = BigInt(medianX2);
  return (num + den - 1n) / den; // ceil for num > 0, den > 0
}

/**
 * The tightest arrival spread among combos that satisfy every constraint in
 * `active` (fairness included, which `minArrivalSpreadMinutes` cannot see).
 * Re-runs the same search with an arrival-spread-only objective.
 */
function closestSpreadUnder(
  strategy: Strategy,
  p: Prepared,
  lists: readonly (readonly Cand[])[],
  active: OptimizerConstraints,
  work: SearchWork,
): number | null {
  const spreadOnly: Prepared = {
    ...p,
    input: {
      ...p.input,
      weights: {
        arrivalSpread: 1,
        departureSpread: 0,
        returnSpread: 0,
        totalCost: 0,
        worstLayover: 0,
      },
    },
  };
  const top = runStrategy(strategy, spreadOnly, lists, active, 1, work)[0];
  return top === undefined ? null : top.terms.arrivalSpreadMinutes;
}

function reasonFor(
  key: ConstraintKey,
  p: Prepared,
  active: OptimizerConstraints,
  lists: Lists,
  leaves: readonly Leaf[],
  strategy: Strategy,
  work: SearchWork,
): string {
  const c = p.input.constraints;
  const fmt = (minor: number): string => formatMoney(money(minor, p.currency));
  switch (key) {
    case 'perPersonCap': {
      const cap = c.perPersonCap?.amountMinor ?? 0;
      const over = lists.base
        .map((list, i) => ({
          member: p.members[i] as MemberTravel,
          cheapest: (list[0] as Cand).price,
        }))
        .filter((x) => x.cheapest > cap);
      if (over.length === 0) return `no combo under ${fmt(cap)}/person fits the other limits`;
      // `lists` already honour the other member-level limits, so say which "cheapest" this is.
      const what = active.refundableOnly === true ? 'cheapest refundable' : 'cheapest';
      const who = over.map((x) => `${nameOf(x.member)}'s ${what} is ${fmt(x.cheapest)}`);
      return `over the ${fmt(cap)}/person cap: ${joinNames(who)}`;
    }
    case 'refundableOnly': {
      const none = lists.base
        .map((list, i) => ({ member: p.members[i] as MemberTravel, list }))
        .filter((x) => !x.list.some((cand) => cand.choice.refundable))
        .map((x) => nameOf(x.member));
      if (none.length === 0) return 'no all-refundable combo fits the other limits';
      return `no refundable fare for ${joinNames(none)}`;
    }
    case 'fairnessMaxAboveMedian': {
      const ppm = fairnessPpm(c.fairnessMaxAboveMedian ?? 0);
      const pct = pctText(fairnessLimitTenths(ppm));
      const top = leaves[0];
      if (top === undefined) return `no combo keeps everyone within ${pct} of the median`;
      const prices = top.picks.map((cand) => cand.price);
      const offenders = fairnessOffenders(prices, p.members, ppm);
      if (offenders.length === 0) return `no combo keeps everyone within ${pct} of the median`;
      const m2 = medianTimes2(prices);
      const who = offenders.map((i) => {
        const price = prices[i] ?? 0;
        const name = nameOf(p.members[i] as MemberTravel);
        // A €0 median (free fares) has no meaningful percentage.
        if (m2 === 0) return `${name} pays ${fmt(price)} while the median is ${fmt(0)}`;
        return `${name} pays ${fmt(price)}, ${pctText(overshootTenths(price, m2))} above the median`;
      });
      return `${joinNames(who)} (limit ${pct})`;
    }
    case 'maxArrivalSpreadMinutes': {
      const max = c.maxArrivalSpreadMinutes ?? 0;
      const window = formatMinutes(max);
      // Ignores fairness (a group-level limit), honours the member-level ones.
      const raw = minArrivalSpreadMinutes(lists.base);
      if (active.fairnessMaxAboveMedian === undefined) {
        return `no combo lands everyone within ${window}; closest is ${formatMinutes(raw)}`;
      }
      const fair = closestSpreadUnder(strategy, p, lists.pruned, active, work) ?? raw;
      if (raw <= max) {
        return `the only combos landing everyone within ${window} break the fairness limit; closest fair one is ${formatMinutes(fair)}`;
      }
      if (fair > raw) {
        return `no combo lands everyone within ${window}; closest is ${formatMinutes(raw)}, closest fair one is ${formatMinutes(fair)}`;
      }
      return `no combo lands everyone within ${window}; closest is ${formatMinutes(raw)}`;
    }
    default:
      throw new TravError('invariant_violation', `unknown constraint ${String(key)}`);
  }
}

// ---------- driver ----------

interface Solved {
  readonly leaves: readonly Leaf[];
  readonly relaxed: readonly RelaxedConstraint[];
}

function solve(p: Prepared, strategy: Strategy, work: SearchWork): Solved {
  if (p.members.length === 0) return { leaves: [], relaxed: [] };
  const k = p.input.maxResults;
  const present = presentConstraints(p.input.constraints);
  for (const subset of subsetsBySize(present)) {
    const active = withoutConstraints(p.input.constraints, subset);
    const lists = filterLists(p, active, strategy !== 'exhaustive');
    if (lists === null) continue;
    const leaves = runStrategy(strategy, p, lists.pruned, active, k, work);
    if (leaves.length === 0) continue;
    return {
      leaves,
      relaxed: subset.map((constraint) => ({
        constraint,
        reason: reasonFor(constraint, p, active, lists, leaves, strategy, work),
      })),
    };
  }
  // Unreachable: with every constraint relaxed each member keeps all choices.
  throw new TravError('invariant_violation', 'no itinerary even with all constraints relaxed');
}

function toItinerary(
  leaf: Leaf,
  rank: number,
  p: Prepared,
  relaxed: readonly RelaxedConstraint[],
  cheapestTotalMinor: number,
): GroupItinerary {
  const picks = leaf.picks.map((c) => c.choice);
  const refundableCount = picks.filter((c) => c.refundable).length;
  return {
    rank,
    picks,
    breakdown: breakdownOf(leaf.terms, p),
    perPerson: picks.map((c) => ({ memberId: c.memberId, price: c.price })),
    allRefundable: refundableCount === picks.length,
    rationale: buildRationale({
      memberCount: picks.length,
      arrivalSpreadMinutes: leaf.terms.arrivalSpreadMinutes,
      departureSpreadMinutes: leaf.terms.departureSpreadMinutes,
      hasInbound: picks.some((c) => c.inbound !== undefined),
      worstLayoverMinutes: leaf.terms.worstLayoverMinutes,
      perPersonMinor: picks.map((c) => c.price.amountMinor),
      refundableCount,
      cheapestTotalMinor,
      currency: p.currency,
      relaxed,
    }),
    relaxed,
  };
}

function run(
  input: OptimizerInput,
  strategy: Strategy,
  work: SearchWork = newSearchWork(),
): OptimizerResult {
  const p = prepare(input);
  const { leaves, relaxed } = solve(p, strategy, work);
  const cheapestTotalMinor = p.cands.reduce((s, list) => s + (list[0] as Cand).price, 0);
  return {
    itineraries: leaves.map((leaf, i) => toItinerary(leaf, i + 1, p, relaxed, cheapestTotalMinor)),
    missing: p.missing,
  };
}

/** Returns ≤ `maxResults` ranked itineraries. Runs < 2s on the 6-origin fixture. */
export function optimizeGroupFlights(input: OptimizerInput): OptimizerResult {
  return run(input, input.search ?? 'auto');
}

/** Exhaustive oracle for small inputs (≤4 members × ≤4 choices); used by the property test. */
export function bruteForceOptimize(input: OptimizerInput): OptimizerResult {
  return run(input, 'exhaustive');
}

/**
 * `optimizeGroupFlights` plus the work its searches did (T-181). For tests:
 * the worst case is bounded by node and extension counts, which do not depend
 * on machine load. Not exported from the package index.
 */
export function optimizeGroupFlightsWithWork(input: OptimizerInput): {
  readonly result: OptimizerResult;
  readonly work: Readonly<SearchWork>;
} {
  const work = newSearchWork();
  const result = run(input, input.search ?? 'auto', work);
  return { result, work };
}
