/**
 * Ordering suggestions by price level (T-167, D-045). Pure: a catalog in, the
 * few places to show out. A budget only orders (in-budget first) and marks
 * what is over it; nothing a member asked for is ever dropped because of a
 * budget. Places a minor can't go to are the caller's filter (SAFETY minors),
 * not a price decision.
 */
import type { SpendingTier } from './infer.js';

export type PriceLevel = 1 | 2 | 3 | 4;

export interface PricedPlace {
  readonly placeId: string;
  readonly priceLevel: PriceLevel;
  /** Typical spend per person, integer minor units of the catalog currency. */
  readonly perPersonMinor: number;
}

/** Where each tier aims on the 1–4 scale (budget ⇒ 1 then 2; high ⇒ 4 then 3). */
export const TIER_IDEAL_LEVEL: Readonly<Record<SpendingTier, number>> = {
  budget: 1.25,
  mid: 2.5,
  high: 3.75,
};

/** The tier a per-person figure reads as, for an ask that says one ("under €30 a head"). */
export function tierForPerPerson(perPersonMinor: number): SpendingTier {
  return perPersonMinor <= 2500 ? 'budget' : perPersonMinor <= 6000 ? 'mid' : 'high';
}

export interface RankOptions {
  readonly target: SpendingTier;
  /** One alternate a step up (the blend's stretch). */
  readonly stretch?: SpendingTier;
  /** A figure someone said for this ask: in-budget places first; the rest marked. */
  readonly perPersonBudgetMinor?: number;
  /** How many to show (default 3). */
  readonly count?: number;
}

export interface RankedPlace<P extends PricedPlace> {
  readonly place: P;
  /** Over the figure someone said for this ask (shown, never dropped). */
  readonly overBudget: boolean;
  /** The blend's one step-up alternate. */
  readonly stepUp: boolean;
}

function scorer<P extends PricedPlace>(
  tier: SpendingTier,
  budget: number | undefined,
  order: ReadonlyMap<string, number>,
): (a: P, b: P) => number {
  const ideal = TIER_IDEAL_LEVEL[tier];
  return (a, b) => {
    if (budget !== undefined) {
      const ia = a.perPersonMinor <= budget ? 0 : 1;
      const ib = b.perPersonMinor <= budget ? 0 : 1;
      if (ia !== ib) return ia - ib;
    }
    const da = Math.abs(a.priceLevel - ideal);
    const db = Math.abs(b.priceLevel - ideal);
    if (da !== db) return da - db;
    return (order.get(a.placeId) ?? 0) - (order.get(b.placeId) ?? 0);
  };
}

/**
 * The places to suggest, closest to the target price level first (catalog
 * order breaks ties, so the same inputs always give the same list), plus one
 * `stretch` alternate when the blend has one and there is room.
 */
export function rankPlaces<P extends PricedPlace>(
  places: readonly P[],
  opts: RankOptions,
): readonly RankedPlace<P>[] {
  const count = Math.max(1, opts.count ?? 3);
  const order = new Map(places.map((p, i) => [p.placeId, i] as const));
  const budget = opts.perPersonBudgetMinor;
  const byTarget = [...places].sort(scorer<P>(opts.target, budget, order));
  const wantStretch = opts.stretch !== undefined && opts.stretch !== opts.target && count > 1;
  const main = byTarget.slice(0, wantStretch ? count - 1 : count);
  const chosen = new Set(main.map((p) => p.placeId));
  const out: RankedPlace<P>[] = main.map((place) => ({
    place,
    overBudget: budget !== undefined && place.perPersonMinor > budget,
    stepUp: false,
  }));
  if (wantStretch) {
    const top = Math.max(0, ...main.map((p) => p.priceLevel));
    const alt = [...places]
      .filter((p) => !chosen.has(p.placeId) && p.priceLevel > top)
      .sort(scorer<P>(opts.stretch!, undefined, order))[0];
    const fill = alt ?? byTarget.find((p) => !chosen.has(p.placeId));
    if (fill !== undefined) {
      out.push({
        place: fill,
        overBudget: budget !== undefined && fill.perPersonMinor > budget,
        stepUp: alt !== undefined,
      });
    }
  }
  return out;
}
