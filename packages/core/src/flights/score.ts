/**
 * Objective and constraint math shared by the search strategies, the brute
 * force oracle and the public `scoreItinerary`. Pure; integer minor units for
 * money, epoch ms for times, float only for the final weighted score.
 */
import { parseIso } from '../clock.js';
import { TravError } from '../errors.js';
import { currencyExponent, money, zero } from '../money.js';
import type { CurrencyCode, MemberId } from '../primitives.js';
import type {
  FlightChoice,
  MemberTravel,
  OptimizerConstraints,
  OptimizerInput,
  OptimizerWeights,
  ScoreBreakdown,
} from './types.js';

const MS_PER_MINUTE = 60_000;

/** A choice with its times pre-parsed so the search never touches ISO strings. */
export interface Cand {
  readonly choice: FlightChoice;
  readonly memberIndex: number;
  /** Minor units. */
  readonly price: number;
  /** Landing at the destination, epoch ms. */
  readonly arr: number;
  /** Leaving the destination (inbound departure), epoch ms; null for one-way. */
  readonly dep: number | null;
  /** Landing back home (inbound arrival), epoch ms; null for one-way. */
  readonly ret: number | null;
  readonly layover: number;
}

/** Running aggregates of a (partial or complete) assignment. */
export interface Agg {
  readonly arrMin: number;
  readonly arrMax: number;
  readonly depMin: number;
  readonly depMax: number;
  readonly retMin: number;
  readonly retMax: number;
  readonly costMinor: number;
  readonly layover: number;
}

export const EMPTY_AGG: Agg = {
  arrMin: Infinity,
  arrMax: -Infinity,
  depMin: Infinity,
  depMax: -Infinity,
  retMin: Infinity,
  retMax: -Infinity,
  costMinor: 0,
  layover: 0,
};

export function extendAgg(a: Agg, c: Cand): Agg {
  return {
    arrMin: Math.min(a.arrMin, c.arr),
    arrMax: Math.max(a.arrMax, c.arr),
    depMin: c.dep === null ? a.depMin : Math.min(a.depMin, c.dep),
    depMax: c.dep === null ? a.depMax : Math.max(a.depMax, c.dep),
    retMin: c.ret === null ? a.retMin : Math.min(a.retMin, c.ret),
    retMax: c.ret === null ? a.retMax : Math.max(a.retMax, c.ret),
    costMinor: a.costMinor + c.price,
    layover: Math.max(a.layover, c.layover),
  };
}

/** Whole minutes between the extremes; 0 when nothing has been added. */
export function spreadMinutes(min: number, max: number): number {
  if (max === -Infinity) return 0;
  return Math.round((max - min) / MS_PER_MINUTE);
}

export interface Terms {
  readonly arrivalSpreadMinutes: number;
  readonly departureSpreadMinutes: number;
  readonly returnSpreadMinutes: number;
  readonly costMinor: number;
  readonly worstLayoverMinutes: number;
}

export function termsOf(a: Agg): Terms {
  return {
    arrivalSpreadMinutes: spreadMinutes(a.arrMin, a.arrMax),
    departureSpreadMinutes: spreadMinutes(a.depMin, a.depMax),
    returnSpreadMinutes: spreadMinutes(a.retMin, a.retMax),
    costMinor: a.costMinor,
    worstLayoverMinutes: a.layover,
  };
}

/**
 * The one place the weighted objective is computed, so the search's lower
 * bounds, the leaf scores and `scoreItinerary` are bit-for-bit identical.
 * Every term is monotone non-decreasing as members are added, which is what
 * makes a partial assignment's score a valid lower bound.
 */
export function combine(t: Terms, w: OptimizerWeights, exponent: number): number {
  const costMajor = t.costMinor / 10 ** exponent;
  return (
    w.arrivalSpread * t.arrivalSpreadMinutes +
    w.departureSpread * t.departureSpreadMinutes +
    w.returnSpread * t.returnSpreadMinutes +
    w.totalCost * costMajor +
    w.worstLayover * t.worstLayoverMinutes
  );
}

// ---------- fairness (exact integer arithmetic) ----------

const PPM = 1_000_000n;

/** `fairnessMaxAboveMedian` as parts-per-million, so the comparison is exact. */
export function fairnessPpm(maxAboveMedian: number): bigint {
  return BigInt(Math.round(maxAboveMedian * 1_000_000));
}

/** Twice the median (so even counts need no fraction). Input need not be sorted. */
export function medianTimes2(values: readonly number[]): number {
  if (values.length === 0) {
    throw new TravError('invariant_violation', 'medianTimes2 of an empty list');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const hi = sorted[mid] ?? 0;
  if (n % 2 === 1) return 2 * hi;
  const lo = sorted[mid - 1] ?? 0;
  return lo + hi;
}

/** `price > median × (1 + x)` with no float rounding; equality is allowed. */
export function exceedsFairness(priceMinor: number, medianX2: number, ppm: bigint): boolean {
  return BigInt(2 * priceMinor) * PPM > BigInt(medianX2) * (PPM + ppm);
}

/** Members (indexes) who break the fairness limit without having opted out. */
export function fairnessOffenders(
  prices: readonly number[],
  members: readonly MemberTravel[],
  ppm: bigint,
): number[] {
  if (prices.length === 0) return [];
  const m2 = medianTimes2(prices);
  const out: number[] = [];
  prices.forEach((p, i) => {
    if (members[i]?.fairnessOptOut === true) return;
    if (exceedsFairness(p, m2, ppm)) out.push(i);
  });
  return out;
}

// ---------- preparation ----------

export interface Prepared {
  readonly input: OptimizerInput;
  readonly currency: CurrencyCode;
  readonly exponent: number;
  /** Members with at least one choice, in input order. */
  readonly members: readonly MemberTravel[];
  readonly missing: readonly MemberId[];
  /** Aligned with `members`; each sorted by price asc, then offerId. */
  readonly cands: readonly (readonly Cand[])[];
}

function assertFiniteNonNegative(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TravError('invalid_argument', `${what} must be a finite number >= 0`, {
      what,
      value,
    });
  }
}

export function inputCurrency(input: OptimizerInput): CurrencyCode {
  return input.choices[0]?.price.currency ?? input.constraints.perPersonCap?.currency ?? 'EUR';
}

export function compareCands(a: Cand, b: Cand): number {
  if (a.price !== b.price) return a.price - b.price;
  return a.choice.offerId < b.choice.offerId ? -1 : a.choice.offerId > b.choice.offerId ? 1 : 0;
}

/** Validates the input and pre-parses every choice. Throws `TravError` on bad input. */
export function prepare(input: OptimizerInput): Prepared {
  const w = input.weights;
  assertFiniteNonNegative(w.arrivalSpread, 'weights.arrivalSpread');
  assertFiniteNonNegative(w.departureSpread, 'weights.departureSpread');
  assertFiniteNonNegative(w.returnSpread, 'weights.returnSpread');
  assertFiniteNonNegative(w.totalCost, 'weights.totalCost');
  assertFiniteNonNegative(w.worstLayover, 'weights.worstLayover');
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1) {
    throw new TravError('invalid_argument', `maxResults must be an integer >= 1`, {
      maxResults: input.maxResults,
    });
  }
  const c = input.constraints;
  if (c.fairnessMaxAboveMedian !== undefined) {
    assertFiniteNonNegative(c.fairnessMaxAboveMedian, 'constraints.fairnessMaxAboveMedian');
  }
  if (c.maxArrivalSpreadMinutes !== undefined) {
    assertFiniteNonNegative(c.maxArrivalSpreadMinutes, 'constraints.maxArrivalSpreadMinutes');
  }

  const currency = inputCurrency(input);
  const exponent = currencyExponent(currency);
  if (c.perPersonCap !== undefined && c.perPersonCap.currency !== currency) {
    throw new TravError(
      'currency_mismatch',
      `perPersonCap is ${c.perPersonCap.currency}, choices are ${currency}`,
    );
  }
  if (c.perPersonCap !== undefined) {
    // Safe-integer minor units, same check as `money()`; then no negative caps.
    money(c.perPersonCap.amountMinor, c.perPersonCap.currency);
    if (c.perPersonCap.amountMinor < 0) {
      throw new TravError('invalid_argument', 'constraints.perPersonCap must be >= 0', {
        amountMinor: c.perPersonCap.amountMinor,
      });
    }
  }

  const indexByMember = new Map<MemberId, number>();
  input.members.forEach((m, i) => {
    if (indexByMember.has(m.memberId)) {
      throw new TravError('duplicate', `member ${m.memberId} listed twice`, {
        memberId: m.memberId,
      });
    }
    indexByMember.set(m.memberId, i);
  });

  const perMember: Cand[][] = input.members.map(() => []);
  const seen = new Set<string>();
  for (const choice of input.choices) {
    const memberIndex = indexByMember.get(choice.memberId);
    if (memberIndex === undefined) {
      throw new TravError('invalid_argument', `choice ${choice.offerId} is for unknown member`, {
        memberId: choice.memberId,
        offerId: choice.offerId,
      });
    }
    if (choice.price.currency !== currency) {
      throw new TravError(
        'currency_mismatch',
        `choice ${choice.offerId} is ${choice.price.currency}, expected ${currency}`,
      );
    }
    // Validate the amount (safe integer) the same way `money()` does.
    money(choice.price.amountMinor, currency);
    if (choice.price.amountMinor < 0) {
      throw new TravError('invalid_argument', `choice ${choice.offerId} has a negative price`);
    }
    assertFiniteNonNegative(
      choice.outbound.longestLayoverMinutes,
      'outbound.longestLayoverMinutes',
    );
    if (choice.inbound !== undefined) {
      assertFiniteNonNegative(
        choice.inbound.longestLayoverMinutes,
        'inbound.longestLayoverMinutes',
      );
    }
    const dupKey = `${choice.memberId}\u0000${choice.offerId}`;
    if (seen.has(dupKey)) continue; // the same offer sent twice is one option
    seen.add(dupKey);
    perMember[memberIndex]?.push({
      choice,
      memberIndex,
      price: choice.price.amountMinor,
      arr: parseIso(choice.outbound.arriveAt),
      dep: choice.inbound === undefined ? null : parseIso(choice.inbound.departAt),
      ret: choice.inbound === undefined ? null : parseIso(choice.inbound.arriveAt),
      layover: Math.max(
        choice.outbound.longestLayoverMinutes,
        choice.inbound?.longestLayoverMinutes ?? 0,
      ),
    });
  }

  const members: MemberTravel[] = [];
  const missing: MemberId[] = [];
  const cands: Cand[][] = [];
  input.members.forEach((m, i) => {
    const list = perMember[i] ?? [];
    if (list.length === 0) {
      missing.push(m.memberId);
      return;
    }
    const memberIndex = members.length;
    members.push(m);
    cands.push(list.map((cand) => ({ ...cand, memberIndex })).sort(compareCands));
  });

  return { input, currency, exponent, members, missing, cands };
}

// ---------- public helpers ----------

export function breakdownOf(terms: Terms, p: Prepared): ScoreBreakdown {
  return {
    arrivalSpreadMinutes: terms.arrivalSpreadMinutes,
    departureSpreadMinutes: terms.departureSpreadMinutes,
    returnSpreadMinutes: terms.returnSpreadMinutes,
    totalCost: money(terms.costMinor, p.currency),
    worstLayoverMinutes: terms.worstLayoverMinutes,
    score: combine(terms, p.input.weights, p.exponent),
  };
}

/** Score one complete assignment (exported so tests and brute force share it). */
export function scoreItinerary(
  picks: readonly FlightChoice[],
  input: OptimizerInput,
): ScoreBreakdown {
  const currency = inputCurrency(input);
  const exponent = currencyExponent(currency);
  let agg = EMPTY_AGG;
  for (const choice of picks) {
    if (choice.price.currency !== currency) {
      throw new TravError(
        'currency_mismatch',
        `choice ${choice.offerId} is ${choice.price.currency}, expected ${currency}`,
      );
    }
    agg = extendAgg(agg, {
      choice,
      memberIndex: -1,
      price: choice.price.amountMinor,
      arr: parseIso(choice.outbound.arriveAt),
      dep: choice.inbound === undefined ? null : parseIso(choice.inbound.departAt),
      ret: choice.inbound === undefined ? null : parseIso(choice.inbound.arriveAt),
      layover: Math.max(
        choice.outbound.longestLayoverMinutes,
        choice.inbound?.longestLayoverMinutes ?? 0,
      ),
    });
  }
  const terms = termsOf(agg);
  return {
    arrivalSpreadMinutes: terms.arrivalSpreadMinutes,
    departureSpreadMinutes: terms.departureSpreadMinutes,
    returnSpreadMinutes: terms.returnSpreadMinutes,
    totalCost: picks.length === 0 ? zero(currency) : money(terms.costMinor, currency),
    worstLayoverMinutes: terms.worstLayoverMinutes,
    score: combine(terms, input.weights, exponent),
  };
}

/**
 * The naive baseline: each member's cheapest offer, ignoring every constraint
 * and everyone else's times. Members without choices are skipped. Used by the
 * rationale ("+€140 vs cheapest") and by the fixture test.
 */
export function cheapestPerPerson(input: OptimizerInput): FlightChoice[] {
  const p = prepare(input);
  return p.cands.map((list) => {
    const first = list[0];
    if (first === undefined) {
      throw new TravError('invariant_violation', 'prepared member without choices');
    }
    return first.choice;
  });
}

/** Per-member constraint checks that do not depend on the other picks. */
export function memberLevelOk(
  cand: Cand,
  member: MemberTravel,
  active: OptimizerConstraints,
  fairnessBound: { readonly maxMedianX2: number; readonly ppm: bigint } | null,
): boolean {
  if (active.perPersonCap !== undefined && cand.price > active.perPersonCap.amountMinor)
    return false;
  if (active.refundableOnly === true && !cand.choice.refundable) return false;
  if (
    fairnessBound !== null &&
    member.fairnessOptOut !== true &&
    exceedsFairness(cand.price, fairnessBound.maxMedianX2, fairnessBound.ppm)
  ) {
    // No itinerary can have a median above the median of per-member maxima,
    // so a fare above (1 + x) × that can never be fair.
    return false;
  }
  return true;
}
