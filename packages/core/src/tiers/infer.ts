/**
 * Spending tier (T-167, D-045): a soft read of how a member, or the people
 * going tonight, like to spend: `budget`, `mid` or `high`. It only ever shapes
 * and orders suggestions; it never blocks, refuses or filters out something a
 * member asked for, and it is never ApprovalPolicy (whose caps still gate
 * every purchase, unchanged).
 *
 * Pure and deterministic: signals in, a tier (or "ask") out. The agent
 * collects signals from what Trav already sees (bookings, the ledger, group
 * memory, a member's own stated budget) and these functions decide.
 *
 * Privacy (SAFETY §2.3): a member's own inference is input to the blend only.
 * Nothing here formats a tier as text; callers never say a tier about anyone.
 */
import type { CurrencyCode } from '../primitives.js';

export type SpendingTier = 'budget' | 'mid' | 'high';

export const SPENDING_TIERS: readonly SpendingTier[] = ['budget', 'mid', 'high'];

export const TIER_RANK: Readonly<Record<SpendingTier, 0 | 1 | 2>> = { budget: 0, mid: 1, high: 2 };

export function tierOfRank(rank: number): SpendingTier {
  return rank <= 0 ? 'budget' : rank >= 2 ? 'high' : 'mid';
}

/** What a signal was read from. `stated` is someone saying what they want. */
export type TierSignalSource = 'flight' | 'lodging' | 'spend' | 'described' | 'budget' | 'stated';

export interface TierSignal {
  readonly tier: SpendingTier;
  /** Evidence strength; stated signals always win over the rest regardless of weight. */
  readonly weight: number;
  readonly source: TierSignalSource;
  /** When it was seen (ISO); orders stated signals (latest wins). */
  readonly at?: string;
}

export type TierStatus = 'known' | 'conflict' | 'missing';

export interface TierInference {
  readonly status: TierStatus;
  /** Set when `status === 'known'`. */
  readonly tier?: SpendingTier;
  /** Summed evidence per tier (inferred signals only). */
  readonly weights: Readonly<Record<SpendingTier, number>>;
  /** True when a stated signal decided it. */
  readonly stated: boolean;
}

/** Less total evidence than this is "missing": Trav asks instead of guessing. */
export const MIN_EVIDENCE = 1;
/**
 * Budget and high evidence both at least `MIN_EVIDENCE` and the smaller at
 * least this share of the larger is a conflict (the Ritz and a 5-hour layover).
 */
export const CONFLICT_RATIO = 0.5;

function laterFirst(a: TierSignal, b: TierSignal): number {
  const at = a.at ?? '';
  const bt = b.at ?? '';
  return at === bt ? 0 : at > bt ? -1 : 1;
}

/**
 * One subject's tier from its signals:
 * 1. any `stated` signal ⇒ the latest one (people do what they say they want);
 * 2. less than `MIN_EVIDENCE` in total ⇒ `missing`;
 * 3. strong budget and strong high evidence of comparable weight ⇒ `conflict`;
 * 4. else the weighted mean rank (budget 0, mid 1, high 2), cut at ⅔ and 4⁄3.
 */
export function inferTier(signals: readonly TierSignal[]): TierInference {
  const weights = { budget: 0, mid: 0, high: 0 };
  const stated: TierSignal[] = [];
  signals.forEach((s) => {
    if (!(s.weight > 0) || !Number.isFinite(s.weight)) return;
    if (s.source === 'stated') stated.push(s);
    else weights[s.tier] += s.weight;
  });
  if (stated.length > 0) {
    // Stable: equal timestamps keep the later array position.
    const latest = stated
      .map((s, i) => ({ s, i }))
      .sort((a, b) => laterFirst(a.s, b.s) || b.i - a.i)[0]!.s;
    return { status: 'known', tier: latest.tier, weights, stated: true };
  }
  const total = weights.budget + weights.mid + weights.high;
  if (total < MIN_EVIDENCE) return { status: 'missing', weights, stated: false };
  const lo = Math.min(weights.budget, weights.high);
  const hi = Math.max(weights.budget, weights.high);
  if (lo >= MIN_EVIDENCE && lo / hi >= CONFLICT_RATIO) {
    return { status: 'conflict', weights, stated: false };
  }
  const mean = (weights.mid + 2 * weights.high) / total;
  const tier: SpendingTier = mean < 2 / 3 ? 'budget' : mean > 4 / 3 ? 'high' : 'mid';
  return { status: 'known', tier, weights, stated: false };
}

export interface TierBlend {
  readonly status: TierStatus;
  /** The price level to aim at: the most budget-conscious known tier of the people going. */
  readonly target?: SpendingTier;
  /** One step toward the rest of the group, when they lean higher (one alternate option). */
  readonly stretch?: SpendingTier;
}

/**
 * The people going, blended, leaning to the most budget-conscious (T-167):
 * - anyone's own signals in conflict ⇒ `conflict` (ask);
 * - nobody with a known tier ⇒ `missing` (ask);
 * - else `target` = the lowest known tier, and `stretch` = the rounded mean
 *   of the known tiers when it sits above the target (capped one step up).
 * Members with no signals don't pull the blend either way.
 */
export function blendTiers(people: readonly TierInference[]): TierBlend {
  if (people.some((p) => p.status === 'conflict')) return { status: 'conflict' };
  const ranks: number[] = people.filter((p) => p.tier !== undefined).map((p) => TIER_RANK[p.tier!]);
  if (ranks.length === 0) return { status: 'missing' };
  const min = Math.min(...ranks);
  const mean = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  const up = Math.min(min + 1, Math.round(mean));
  return {
    status: 'known',
    target: tierOfRank(min),
    ...(up > min ? { stretch: tierOfRank(up) } : {}),
  };
}

// ---------- signals from structured facts ----------

/**
 * Money thresholds are per person in major units of a euro-scale currency.
 * Other currencies give no money-based signal (never a guess across scales).
 */
const EURO_SCALE: ReadonlySet<string> = new Set(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD']);

function major(amountMinor: number, currency: CurrencyCode | string): number | undefined {
  if (!EURO_SCALE.has(currency) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return undefined;
  }
  return amountMinor / 100;
}

function byBands(value: number, budgetAtMost: number, highAtLeast: number): SpendingTier {
  return value <= budgetAtMost ? 'budget' : value >= highAtLeast ? 'high' : 'mid';
}

export type SpendCategory = 'food' | 'drinks' | 'activities' | 'tickets';

/** Per-person share bands (major units): at or under ⇒ budget, at or over ⇒ high. */
export const SPEND_BANDS: Readonly<Record<SpendCategory, readonly [number, number]>> = {
  food: [20, 60],
  drinks: [12, 40],
  activities: [20, 80],
  tickets: [20, 80],
};

/** One member's share of one restaurant, bar or activity expense. */
export function spendSignal(input: {
  readonly category: string;
  readonly shareMinor: number;
  readonly currency: CurrencyCode | string;
  readonly at?: string;
}): TierSignal | undefined {
  const bands = SPEND_BANDS[input.category as SpendCategory] as
    readonly [number, number] | undefined;
  if (bands === undefined) return undefined;
  const v = major(input.shareMinor, input.currency);
  if (v === undefined) return undefined;
  return {
    tier: byBands(v, bands[0], bands[1]),
    weight: 1,
    source: 'spend',
    ...(input.at !== undefined ? { at: input.at } : {}),
  };
}

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

const PREMIUM_CARRIERS =
  /\b(?:emirates|qatar|singapore airlines|etihad|cathay|ana|japan airlines|jal|lufthansa first)\b/;
const LOW_COST_CARRIERS =
  /\b(?:ryanair|easyjet|easy jet|wizz|spirit|frontier|vueling|norse|play|level|flair|allegiant|volotea|transavia)\b/;
/** A layover at or over this many minutes reads as the cheap routing. */
export const LONG_LAYOVER_MINUTES = 180;

/**
 * A flight the member took or booked: cabin first (first/business ⇒ high,
 * premium economy ⇒ mid), then the routing (a 3h+ layover or a low-cost
 * carrier ⇒ budget), then a premium carrier in economy (a weak mid).
 */
export function flightSignal(input: {
  readonly cabin?: CabinClass | string;
  readonly airline?: string;
  readonly layoverMinutes?: number;
  readonly at?: string;
}): TierSignal | undefined {
  const at = input.at !== undefined ? { at: input.at } : {};
  const cabin = (input.cabin ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const airline = (input.airline ?? '').toLowerCase();
  if (cabin === 'first' || cabin === 'business') {
    return { tier: 'high', weight: 2, source: 'flight', ...at };
  }
  if (cabin === 'premium_economy') return { tier: 'mid', weight: 1, source: 'flight', ...at };
  const layover = input.layoverMinutes ?? 0;
  if (layover >= LONG_LAYOVER_MINUTES || LOW_COST_CARRIERS.test(airline)) {
    return { tier: 'budget', weight: 1.5, source: 'flight', ...at };
  }
  if (PREMIUM_CARRIERS.test(airline)) return { tier: 'mid', weight: 0.5, source: 'flight', ...at };
  return undefined;
}

/** Lodging per person per night (major units): at or under ⇒ budget, at or over ⇒ high. */
export const LODGING_BANDS: readonly [number, number] = [45, 150];

/**
 * A stay: the kind and name first (a hostel ⇒ budget; a luxury hotel name ⇒
 * high), then a whole home with far fewer bedrooms than guests (a 1-bedroom
 * for 6 ⇒ budget), then the price per person per night.
 */
export function lodgingSignal(input: {
  readonly name?: string;
  readonly kind?: string;
  readonly bedrooms?: number;
  readonly guests?: number;
  readonly totalMinor?: number;
  readonly nights?: number;
  readonly currency?: CurrencyCode | string;
  readonly at?: string;
}): TierSignal | undefined {
  const at = input.at !== undefined ? { at: input.at } : {};
  const described = describedTier(`${input.name ?? ''} ${input.kind ?? ''}`);
  if (described !== undefined) return { tier: described, weight: 1.5, source: 'lodging', ...at };
  const guests = input.guests ?? 0;
  if (input.bedrooms !== undefined && guests >= 4 && input.bedrooms * 3 < guests) {
    return { tier: 'budget', weight: 1.5, source: 'lodging', ...at };
  }
  if (
    input.totalMinor !== undefined &&
    input.currency !== undefined &&
    guests > 0 &&
    (input.nights ?? 0) > 0
  ) {
    const v = major(Math.round(input.totalMinor / guests / input.nights!), input.currency);
    if (v !== undefined) {
      return {
        tier: byBands(v, LODGING_BANDS[0], LODGING_BANDS[1]),
        weight: 1.5,
        source: 'lodging',
        ...at,
      };
    }
  }
  return undefined;
}

/** Bands for a member's own stated budget, per day (major units). */
export const DAILY_BUDGET_BANDS: readonly [number, number] = [60, 200];

/**
 * A member's own stated budget figure ("under €80 a day") as a tier. A trip
 * total is spread over the trip's days; a week over 7. No period ⇒ no signal.
 * The figure itself never leaves the caller; only this tier feeds a blend.
 */
export function budgetFigureSignal(input: {
  readonly amountMinor: number;
  readonly currency: CurrencyCode | string;
  readonly period: 'day' | 'night' | 'week' | 'trip' | undefined;
  readonly tripDays?: number;
  readonly at?: string;
}): TierSignal | undefined {
  const v = major(input.amountMinor, input.currency);
  if (v === undefined || input.period === undefined) return undefined;
  const days =
    input.period === 'week' ? 7 : input.period === 'trip' ? Math.max(1, input.tripDays ?? 0) : 1;
  if (input.period === 'trip' && (input.tripDays ?? 0) < 1) return undefined;
  return {
    tier: byBands(v / days, DAILY_BUDGET_BANDS[0], DAILY_BUDGET_BANDS[1]),
    weight: 2,
    source: 'budget',
    ...(input.at !== undefined ? { at: input.at } : {}),
  };
}

// ---------- signals from words ----------

/** Lowercase, accents folded, curly quotes straightened, whitespace collapsed. */
export function foldTierText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const HIGH_DESCRIBED =
  /\b(?:first[- ]class|business[- ]class|lie[- ]flat|ritz|four seasons|mandarin oriental|w hotel|five[- ]star|5[- ]star|luxury|michelin|tasting menu|penthouse|private (?:driver|chef|tour|jet)|bottle service|vip table|yacht)\b|\bfirst on (?:emirates|qatar|etihad|singapore)\b/;
const BUDGET_DESCRIBED =
  /\b(?:hostels?|dorm(?:itory)?|bunk ?beds?|budget airline|ryanair|easyjet|spirit airlines|red[- ]eye|(?:1|one)[- ]bed(?:room)?|studio for (?:4|5|6|four|five|six)|couch ?surf\w*|kebabs?|street food|menu del dia|supermarket|picnic)\b|\b(?:[3-9]|1[0-9]|three|four|five|six|seven|eight|nine|ten)[- ]?(?:hours?|hrs?|h) layover\b|\blayover of (?:[3-9]|1[0-9]) ?(?:hours?|hrs?|h)\b/;

/**
 * What a description says about price ("first-class Emirates", "the Ritz",
 * "TAP with a 5-hour layover", "a 1-bedroom Airbnb for 6", "kebabs"), or
 * undefined. High and budget words together say nothing.
 */
export function describedTier(text: string): SpendingTier | undefined {
  const t = foldTierText(text);
  const high = HIGH_DESCRIBED.test(t);
  const budget = BUDGET_DESCRIBED.test(t);
  if (high === budget) return undefined;
  return high ? 'high' : 'budget';
}

/** A description as a weak signal (a memory fact, an expense line). */
export function describedSignal(text: string, at?: string): TierSignal | undefined {
  const tier = describedTier(text);
  return tier === undefined
    ? undefined
    : { tier, weight: 1, source: 'described', ...(at !== undefined ? { at } : {}) };
}

const MID_STATED =
  /\b(?:mid[- ]?range|middle of the road|nothing (?:too )?crazy|not too (?:fancy|cheap|pricey|expensive|bougie)|nothing too (?:fancy|pricey|expensive|bougie)|in between|in the middle|moderate(?:ly priced)?|reasonabl[ey](?: priced)?)\b/;
const BUDGET_STATED =
  /\b(?:keep(?:ing)? (?:it|things|costs?|spend(?:ing)?) (?:cheap|low|down|casual|chill)|cheap(?:er)?(?: eats| spots?| places?| options?| tonight| night)?|on a budget|budget[- ]friendly|nothing fancy|not fancy|no fancy|don'?t need (?:anything )?fancy|casual|low[- ]key|inexpensive|affordable|save (?:some )?money|saving money|not (?:trying|looking) to spend (?:a lot|much)|don'?t want to spend (?:a lot|much))\b/;
const HIGH_STATED =
  /\b(?:treat (?:ourselves|yourselves|myself|us)|splurge|splash out|fancy|bougie|boujee|ball(?:ing)? out|go(?:ing)? all out|something nice|somewhere nice|nice dinner|upscale|high[- ]end|fine dining|classy|money'?s no object|no budget|price is no object)\b/;

/**
 * Someone saying what they want: "keep it cheap", "let's treat ourselves",
 * "nothing too fancy" ⇒ a tier; undefined when it says nothing about price.
 * Mid phrases are read first ("not too fancy" is mid, not high), then budget
 * ("nothing fancy" is budget), then high.
 */
export function statedTier(text: string): SpendingTier | undefined {
  const t = foldTierText(text);
  if (MID_STATED.test(t)) return 'mid';
  if (BUDGET_STATED.test(t)) return 'budget';
  if (HIGH_STATED.test(t)) return 'high';
  return undefined;
}

/**
 * An answer to "fancy or casual tonight?" that is only that answer
 * ("casual", "fancy pls", "let's treat ourselves", "either"), else undefined.
 * Longer messages are asks, not answers: their stated words go through
 * `statedTier` on the ask itself.
 */
export function vibeAnswer(text: string): SpendingTier | undefined {
  const t = foldTierText(text)
    .replace(/@trav\b/g, ' ')
    .replace(/^(?:trav|hey trav)[,:]?\s+/, '')
    .replace(/[.!?,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length === 0 || t.split(' ').length > 6) return undefined;
  const filler =
    /^(?:(?:um+|uh+|hmm+|ok(?:ay)?|honestly|i think|i'?d say|let'?s go|let'?s do|let'?s|go|we want|we'?re thinking|probably|def(?:initely)?|prob)\s+)*/;
  const core = t
    .replace(filler, '')
    .replace(
      /\s+(?:pls|please|tonight|today|for tonight|this time|then|i think|lol|haha|tbh)$/g,
      '',
    )
    .replace(
      /\s+(?:pls|please|tonight|today|for tonight|this time|then|i think|lol|haha|tbh)$/g,
      '',
    )
    .trim();
  if (
    /^(?:either|either one|whatever|both|in between|somewhere in between|mid|middle|a bit of both)$/.test(
      core,
    )
  ) {
    return 'mid';
  }
  if (
    /^(?:casual|cheap|keep it cheap|keep it casual|chill|low[- ]key|nothing fancy|cheap and cheerful)$/.test(
      core,
    )
  ) {
    return 'budget';
  }
  if (
    /^(?:fancy|treat ourselves|splurge|something nice|nice|bougie|boujee|ball out|go all out|upscale)$/.test(
      core,
    )
  ) {
    return 'high';
  }
  return undefined;
}

// ---------- the answer, kept in group memory ----------

const VIBE_WORD: Readonly<Record<SpendingTier, string>> = {
  budget: 'casual',
  mid: 'in between',
  high: 'fancy',
};

/** The words Trav uses for a tier in the group: about the night, never about a person. */
export function vibeWord(tier: SpendingTier): string {
  return VIBE_WORD[tier];
}

const VIBE_FACT_RE = /^the group (?:wants|said) (casual|in between|fancy) for (\d{4}-\d{2}-\d{2})$/;

/** Group-memory text for an answered (or stated) vibe on one local date. */
export function formatVibeFact(tier: SpendingTier, localDate: string): string {
  return `the group said ${VIBE_WORD[tier]} for ${localDate}`;
}

/** Inverse of `formatVibeFact`; undefined for any other fact. */
export function parseVibeFact(
  text: string,
): { readonly tier: SpendingTier; readonly localDate: string } | undefined {
  const m = VIBE_FACT_RE.exec(foldTierText(text));
  if (m === null) return undefined;
  const tier = (Object.keys(VIBE_WORD) as SpendingTier[]).find((k) => VIBE_WORD[k] === m[1]);
  return tier === undefined ? undefined : { tier, localDate: m[2]! };
}
