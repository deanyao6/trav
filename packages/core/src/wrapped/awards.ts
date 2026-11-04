/**
 * Trip Wrapped awards (T-016, IDEAS Seed B / I-03, VOICE §4.8). Pure: every
 * award is computed from group-visible facts only (the group ledger, completed
 * bookings, final rosters, consent-filtered album photos) and carries a
 * `basis` plus the ids (`trace`) of the rows that earned it, so each
 * superlative is defensible and never a vibe. Nothing here reads chat text.
 *
 * Rules:
 * - One award per person where possible: awards are assigned greedily in
 *   `AWARD_ORDER`; each goes to the best-ranked eligible member without an
 *   award yet, and only repeats (`repeat: true`) when nobody fresh has a
 *   non-zero stat.
 * - A member who opted out (`@trav no awards for me`) is skipped silently:
 *   no award, and their stats never rank.
 * - Members who left, guests and minors never enter the per-person pool. A
 *   minor can only get an event-neutral, positive "pick" (VOICE §4.8, §8):
 *   a completed, all-ages booking they asked for. Never anything about
 *   nights, spending or rides.
 * - Family mode: no nightlife-adjacent award (Night Owl) for anyone.
 * - Group awards (Big Night, Best Value Night) name nobody.
 *
 * Money is integer minor units throughout. Expenses in another currency than
 * the trip's are skipped (the ledger converts at log time, T-031).
 */
import type {
  ActivityId,
  BookingId,
  CurrencyCode,
  ExpenseId,
  IsoDate,
  IsoDateTime,
  MemberId,
} from '../primitives.js';
import type { ContentTag } from '../domain/trip.js';
import type { Expense } from '../domain/expense.js';
import type { Member } from '../domain/group.js';
import { formatMoney, money } from '../money.js';
import { formatClockTime, parseIso } from '../clock.js';
import { isMinor, isRestrictedContent, isRestrictedText } from '../safety/minors.js';
import type { TripWindow } from './nights.js';
import { morningOf, nightOf, nightOnTrip } from './nights.js';

export type AwardId =
  | 'mvp_spender'
  | 'planner'
  | 'uber_captain'
  | 'night_owl'
  | 'early_bird'
  | 'photographer'
  | 'always_in'
  | 'most_fronted';

/** Where an award's number comes from. `album` = consent-filtered shared album (T-029). */
export type AwardBasis = 'ledger' | 'booking' | 'attendance' | 'album';

/** Per-person awards in greedy assignment order (the fixture's order, Most Fronted last). */
export const AWARD_ORDER: readonly AwardId[] = [
  'mvp_spender',
  'planner',
  'uber_captain',
  'night_owl',
  'early_bird',
  'photographer',
  'always_in',
  'most_fronted',
];

export const AWARD_TITLES: Readonly<Record<AwardId, string>> = {
  mvp_spender: 'MVP Spender',
  planner: 'The Planner',
  uber_captain: 'Uber Captain',
  night_owl: 'Night Owl',
  early_bird: 'Early Bird',
  photographer: 'The Photographer',
  always_in: 'Always In',
  most_fronted: 'Most Fronted',
};

const AWARD_BASIS: Readonly<Record<AwardId, AwardBasis>> = {
  mvp_spender: 'ledger',
  planner: 'booking',
  uber_captain: 'ledger',
  night_owl: 'ledger',
  early_bird: 'ledger',
  photographer: 'album',
  always_in: 'attendance',
  most_fronted: 'ledger',
};

/** Awards whose stat is about nights out; never for a minor (they get none of these anyway). */
const NIGHTLIFE_ADJACENT: ReadonlySet<AwardId> = new Set<AwardId>(['night_owl']);

/** Ride expenses (fixture rule): transport category and a ride word in the description or merchant. */
export const RIDE_RE = /\b(uber|lyft|taxi|cab|bolt|cabify)\b/i;

export interface PlannerBooking {
  readonly bookingId: BookingId;
  /** Who asked Trav for it (the proposal's `requestedBy`). */
  readonly requestedBy: MemberId;
  /** Short name for a "pick" ("snorkel tour"). */
  readonly description: string;
  /** Only completed bookings count; cancelled/refunded ones are ignored. */
  readonly status: 'confirmed' | 'cancelled' | 'refunded' | 'partially_refunded';
  readonly contentTags: readonly ContentTag[];
  readonly ageRestriction: number | null;
}

export interface ActivityRoster {
  readonly activityId: ActivityId;
  /** Members "in" on the final roster. */
  readonly inMemberIds: readonly MemberId[];
}

export interface AlbumPhotoFact {
  readonly photoId: string;
  readonly ownerMemberId: MemberId;
  readonly qualityTag?: string;
  readonly mimeType?: string;
}

export interface WrappedAwardsInput {
  readonly trip: TripWindow & { readonly currency: CurrencyCode };
  /** Every group member, in group order (tie-breaks use this order). */
  readonly members: readonly Member[];
  readonly now: IsoDateTime;
  /** The group ledger (logged expenses; undone ones are ignored). Never private items. */
  readonly expenses: readonly Expense[];
  readonly bookings: readonly PlannerBooking[];
  readonly rosters: readonly ActivityRoster[];
  /** Album photos visible right now: consent-filtered upstream (owner opted in), not hidden. */
  readonly photos: readonly AlbumPhotoFact[];
  /** Members who said "no awards for me". */
  readonly optedOut: readonly MemberId[];
  /** Family mode (VOICE §8): no nightlife-adjacent award for anyone, no "night out" framing. */
  readonly familyMode?: boolean;
}

export interface WrappedAward {
  readonly id: AwardId | 'pick';
  readonly title: string;
  readonly memberId: MemberId;
  /** The stat that earned it (minor units for MVP Spender, counts otherwise). */
  readonly value: number;
  /** Short, data-only phrase shown with the award ("€2,065.20", "3 rides"). */
  readonly evidence: string;
  readonly basis: AwardBasis;
  /** Ids of the expenses / bookings / activities / photos behind `value`. */
  readonly trace: readonly string[];
  /** True when nobody without an award had a non-zero stat, so a winner repeats. */
  readonly repeat: boolean;
  readonly nightlifeAdjacent: boolean;
}

export interface AwardStat {
  readonly memberId: MemberId;
  readonly value: number;
}

/** The full standings for one award, for tests and evals (eligible members only). */
export interface AwardStanding {
  readonly id: AwardId;
  readonly basis: AwardBasis;
  readonly stats: readonly AwardStat[];
  /** Everyone tied at the top with a value > 0, ranked. */
  readonly topHolders: readonly MemberId[];
}

export interface WrappedAwardsResult {
  /** Per-person awards in `AWARD_ORDER`, then minors' picks. */
  readonly awards: readonly WrappedAward[];
  readonly standings: readonly AwardStanding[];
}

interface Tally {
  value: number;
  /** Secondary sort key (ride total for Uber Captain); higher wins. */
  tiebreak: number;
  trace: string[];
}

/** The payer who fronted the most of an expense (first listed on a tie). */
function mainPayer(e: Expense): MemberId | undefined {
  let best: Expense['paidBy'][number] | undefined;
  for (const p of e.paidBy)
    if (best === undefined || p.amount.amountMinor > best.amount.amountMinor) best = p;
  return best?.memberId;
}

export function isRide(e: Pick<Expense, 'category' | 'description' | 'merchantDisplay'>): boolean {
  return e.category === 'transport' && RIDE_RE.test(`${e.description} ${e.merchantDisplay ?? ''}`);
}

/** Logged, trip-currency expenses: the only ones any Wrapped number reads. */
export function wrappedExpenses(expenses: readonly Expense[], currency: CurrencyCode): Expense[] {
  // A row listed twice (same expenseId) counts once.
  const seen = new Set<string>();
  return expenses.filter((e) => {
    if (e.status !== 'logged' || e.amount.currency !== currency || seen.has(e.expenseId)) {
      return false;
    }
    seen.add(e.expenseId);
    return true;
  });
}

function bump(
  t: Map<MemberId, Tally>,
  id: MemberId,
  by: number,
  trace: string,
  tiebreak = 0,
): void {
  const cur = t.get(id) ?? { value: 0, tiebreak: 0, trace: [] };
  cur.value += by;
  cur.tiebreak += tiebreak;
  if (!cur.trace.includes(trace)) cur.trace.push(trace);
  t.set(id, cur);
}

/** Who fronted the latest expense of each trip night (18:00–06:00). */
export function latestByNight(
  expenses: readonly Expense[],
  trip: TripWindow,
): Map<IsoDate, { readonly expense: Expense; readonly memberId: MemberId }> {
  const out = new Map<IsoDate, { expense: Expense; memberId: MemberId }>();
  for (const e of expenses) {
    const night = nightOf(e.occurredAt, trip.timeZone);
    if (night === null || !nightOnTrip(night, trip)) continue;
    const payer = mainPayer(e);
    if (payer === undefined) continue;
    const cur = out.get(night);
    if (cur === undefined || parseIso(e.occurredAt) > parseIso(cur.expense.occurredAt)) {
      out.set(night, { expense: e, memberId: payer });
    }
  }
  return out;
}

/** Who fronted the first expense of each trip day between 06:00 and 14:00. */
export function firstByMorning(
  expenses: readonly Expense[],
  trip: TripWindow,
): Map<IsoDate, { readonly expense: Expense; readonly memberId: MemberId }> {
  const out = new Map<IsoDate, { expense: Expense; memberId: MemberId }>();
  for (const e of expenses) {
    const day = morningOf(e.occurredAt, trip);
    if (day === null) continue;
    const payer = mainPayer(e);
    if (payer === undefined) continue;
    const cur = out.get(day);
    if (cur === undefined || parseIso(e.occurredAt) < parseIso(cur.expense.occurredAt)) {
      out.set(day, { expense: e, memberId: payer });
    }
  }
  return out;
}

const NOT_A_PHOTO = new Set(['screenshot', 'receipt']);

function tallies(
  input: WrappedAwardsInput,
  expenses: readonly Expense[],
): Record<AwardId, Map<MemberId, Tally>> {
  const t: Record<AwardId, Map<MemberId, Tally>> = {
    mvp_spender: new Map(),
    planner: new Map(),
    uber_captain: new Map(),
    night_owl: new Map(),
    early_bird: new Map(),
    photographer: new Map(),
    always_in: new Map(),
    most_fronted: new Map(),
  };
  for (const e of expenses) {
    for (const p of e.paidBy) {
      if (p.amount.amountMinor <= 0) continue;
      bump(t.mvp_spender, p.memberId, p.amount.amountMinor, e.expenseId);
      bump(t.most_fronted, p.memberId, 1, e.expenseId);
    }
    const payer = mainPayer(e);
    if (payer !== undefined && isRide(e))
      bump(t.uber_captain, payer, 1, e.expenseId, e.amount.amountMinor);
  }
  for (const [night, { expense, memberId }] of latestByNight(expenses, input.trip)) {
    // Ties go to the later night, not member order (T-016 review #4): how far
    // past that night's 18:00 the last expense landed (the zone offset is the
    // same for every night, so it cancels out in the comparison).
    const late = Math.max(0, parseIso(expense.occurredAt) - Date.parse(`${night}T18:00:00Z`));
    bump(t.night_owl, memberId, 1, expense.expenseId, Math.round(late / 60_000));
  }
  for (const { expense, memberId } of firstByMorning(expenses, input.trip).values()) {
    bump(t.early_bird, memberId, 1, expense.expenseId);
  }
  for (const b of input.bookings) {
    if (b.status !== 'confirmed' && b.status !== 'partially_refunded') continue;
    bump(t.planner, b.requestedBy, 1, b.bookingId);
  }
  for (const r of input.rosters) {
    for (const m of new Set(r.inMemberIds)) bump(t.always_in, m, 1, r.activityId);
  }
  for (const p of input.photos) {
    if (p.qualityTag !== undefined && NOT_A_PHOTO.has(p.qualityTag)) continue;
    // "N photos" counts photos only, never videos (T-016 review #5)
    if (p.mimeType !== undefined && !p.mimeType.startsWith('image/')) continue;
    bump(t.photographer, p.ownerMemberId, 1, p.photoId);
  }
  return t;
}

function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${String(n)} ${n === 1 ? noun : pluralNoun}`;
}

function evidenceFor(
  id: AwardId,
  tally: Tally,
  input: WrappedAwardsInput,
  expenses: readonly Expense[],
): string {
  switch (id) {
    case 'mvp_spender':
      return formatMoney(money(tally.value, input.trip.currency));
    case 'planner':
      return plural(tally.value, 'booking');
    case 'uber_captain':
      return plural(tally.value, 'ride');
    case 'night_owl': {
      if (tally.value > 1) return plural(tally.value, 'late night');
      const e = expenses.find((x) => x.expenseId === tally.trace[0]);
      return e === undefined
        ? '1 late night'
        : `last one ${formatClockTime(e.occurredAt, input.trip.timeZone)}`;
    }
    case 'early_bird':
      return plural(tally.value, 'morning');
    case 'photographer':
      return plural(tally.value, 'photo');
    case 'always_in':
      return `${String(tally.value)} of ${String(input.rosters.length)}`;
    case 'most_fronted':
      return plural(tally.value, 'tab');
  }
}

/** A booking a minor can be credited with: completed, all ages, nothing nightlife or alcohol. */
function pickable(b: PlannerBooking): boolean {
  if (b.status !== 'confirmed' && b.status !== 'partially_refunded') return false;
  if (b.ageRestriction !== null && b.ageRestriction >= 18) return false;
  if (isRestrictedContent(b.contentTags) || b.contentTags.includes('late_night')) return false;
  return !isRestrictedText(b.description);
}

export function computeAwards(input: WrappedAwardsInput): WrappedAwardsResult {
  const expenses = wrappedExpenses(input.expenses, input.trip.currency);
  const optedOut = new Set(input.optedOut);
  const order = new Map(input.members.map((m, i) => [m.memberId, i] as const));
  const present = (m: Member): boolean => m.active && m.leftAt === undefined && m.role !== 'guest';
  const eligible = new Set(
    input.members
      .filter((m) => present(m) && !optedOut.has(m.memberId) && !isMinor(m, input.now))
      .map((m) => m.memberId),
  );
  const t = tallies(input, expenses);

  const standings: AwardStanding[] = [];
  const awards: WrappedAward[] = [];
  const given = new Set<MemberId>();
  for (const id of AWARD_ORDER) {
    if (input.familyMode === true && NIGHTLIFE_ADJACENT.has(id)) continue;
    const tally = t[id];
    const rank = (a: MemberId, b: MemberId): number => {
      const x = tally.get(a);
      const y = tally.get(b);
      return (
        (y?.value ?? 0) - (x?.value ?? 0) ||
        (y?.tiebreak ?? 0) - (x?.tiebreak ?? 0) ||
        (order.get(a) ?? 0) - (order.get(b) ?? 0)
      );
    };
    const pool = input.members.map((m) => m.memberId).filter((m) => eligible.has(m));
    const stats = pool.map((memberId) => ({ memberId, value: tally.get(memberId)?.value ?? 0 }));
    const ranked = pool.filter((m) => (tally.get(m)?.value ?? 0) > 0).sort(rank);
    const top = ranked.length > 0 ? tally.get(ranked[0]!)!.value : 0;
    standings.push({
      id,
      basis: AWARD_BASIS[id],
      stats,
      topHolders: ranked.filter((m) => tally.get(m)!.value === top),
    });
    const fresh = ranked.find((m) => !given.has(m));
    const winner = fresh ?? ranked[0];
    if (winner === undefined) continue;
    given.add(winner);
    const w = tally.get(winner)!;
    awards.push({
      id,
      title: AWARD_TITLES[id],
      memberId: winner,
      value: w.value,
      evidence: evidenceFor(id, w, input, expenses),
      basis: AWARD_BASIS[id],
      trace: [...w.trace],
      repeat: fresh === undefined,
      nightlifeAdjacent: NIGHTLIFE_ADJACENT.has(id),
    });
  }

  // Minors: at most one "pick" each, from an all-ages booking they asked for.
  for (const m of input.members) {
    if (!present(m) || optedOut.has(m.memberId) || !isMinor(m, input.now)) continue;
    const mine = input.bookings.filter((b) => b.requestedBy === m.memberId && pickable(b));
    const first = mine[0];
    if (first === undefined) continue;
    awards.push({
      id: 'pick',
      title: `${m.displayName}'s pick`,
      memberId: m.memberId,
      value: mine.length,
      evidence: first.description,
      basis: 'booking',
      trace: [first.bookingId],
      repeat: false,
      nightlifeAdjacent: false,
    });
  }
  return { awards, standings };
}

// ---------- group awards (nobody's name on them) ----------

export interface NightTotal {
  readonly night: IsoDate;
  readonly spentMinor: number;
  readonly expenseIds: readonly ExpenseId[];
  /** Group chat messages that night, when the caller has them. */
  readonly groupMessages?: number;
}

export interface GroupAwards {
  /** The trip night (18:00–06:00) with the highest group-ledger total. */
  readonly bigNight: (NightTotal & { readonly basis: 'ledger' }) | null;
  /**
   * The night with the most group chat messages per €10 spent (IDEAS asks for
   * reactions per euro; v0 has no reaction counts). `null` without message times.
   */
  readonly bestValueNight:
    | (NightTotal & {
        readonly groupMessages: number;
        readonly messagesPerTen: number;
        readonly basis: 'ledger';
      })
    | null;
  readonly nights: readonly NightTotal[];
}

export interface GroupAwardsInput {
  readonly trip: TripWindow & { readonly currency: CurrencyCode };
  readonly expenses: readonly Expense[];
  /** Timestamps of members' group-lane messages (not Trav's), if known. */
  readonly groupMessageTimes?: readonly IsoDateTime[];
}

export function computeGroupAwards(input: GroupAwardsInput): GroupAwards {
  const expenses = wrappedExpenses(input.expenses, input.trip.currency);
  const byNight = new Map<IsoDate, { spentMinor: number; expenseIds: ExpenseId[] }>();
  for (const e of expenses) {
    const night = nightOf(e.occurredAt, input.trip.timeZone);
    if (night === null || !nightOnTrip(night, input.trip)) continue;
    const cur = byNight.get(night) ?? { spentMinor: 0, expenseIds: [] };
    cur.spentMinor += e.amount.amountMinor;
    cur.expenseIds.push(e.expenseId);
    byNight.set(night, cur);
  }
  const messages = new Map<IsoDate, number>();
  for (const at of input.groupMessageTimes ?? []) {
    const night = nightOf(at, input.trip.timeZone);
    if (night === null || !nightOnTrip(night, input.trip)) continue;
    messages.set(night, (messages.get(night) ?? 0) + 1);
  }
  const withMessages = input.groupMessageTimes !== undefined;
  const nights: NightTotal[] = [...byNight.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([night, v]) => ({
      night,
      spentMinor: v.spentMinor,
      expenseIds: v.expenseIds,
      ...(withMessages ? { groupMessages: messages.get(night) ?? 0 } : {}),
    }));
  let big: NightTotal | null = null;
  for (const n of nights) if (big === null || n.spentMinor > big.spentMinor) big = n;
  let best: (NightTotal & { groupMessages: number; messagesPerTen: number }) | null = null;
  if (withMessages) {
    for (const n of nights) {
      if (n.spentMinor <= 0) continue;
      const groupMessages = n.groupMessages ?? 0;
      // messages per €10 = messages × 1000 / minor units (exact rational compare below).
      const perTen = (groupMessages * 1000) / n.spentMinor;
      const better =
        best === null ||
        groupMessages * 1000 * best.spentMinor > best.groupMessages * 1000 * n.spentMinor;
      if (groupMessages > 0 && better) best = { ...n, groupMessages, messagesPerTen: perTen };
    }
  }
  return {
    bigNight: big === null ? null : { ...big, basis: 'ledger' },
    bestValueNight: best === null ? null : { ...best, basis: 'ledger' },
    nights,
  };
}
