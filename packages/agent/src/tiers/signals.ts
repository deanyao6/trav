/**
 * Spending-tier signals from what Trav already sees (T-167, D-045). Pure over
 * its inputs: the caller reads the stores and hands the rows in.
 *
 * Sources, per member:
 * - travel: a flight (cabin, airline, layover) or a stay (name, kind,
 *   bedrooms for how many, price per person per night). From lodging bookings
 *   and the trip's flight/lodging activities, plus any structured facts.
 * - group memory: a fact that describes price ("we're at the Ritz", "TAP with
 *   a 5-hour layover") or says what someone wants ("keep it cheap"). A fact
 *   about nobody in particular is about everyone.
 * - the ledger: each member's share of food, drinks, activities and tickets.
 * - members' own group-thread lines ("can we keep it cheap tonight").
 * - a member's own private notes (their budget figure, a stated preference):
 *   read for that member's tier only. The figure never leaves this module;
 *   only the tier does, and only into a blend (SAFETY §2.3).
 *
 * Day vibes ("the group said casual for 2026-03-14") are not signals here:
 * they answer one night, and the suggestion flow reads them directly.
 */
import { daysBetween, tiers } from '@trav/core';
import type {
  Activity,
  Booking,
  CurrencyCode,
  Expense,
  GroupMemoryFact,
  IsoDateTime,
  LedgerEntry,
  Member,
  MemberId,
  MemberMemoryFact,
  TierSignal,
  Trip,
} from '@trav/core';
import { findBudgetFigure } from '../memory/budget.js';
import type { BudgetFigure } from '../memory/budget.js';

/** A flight or stay Trav knows about in structured form. */
export type TravelFact =
  | {
      readonly kind: 'flight';
      readonly memberId: MemberId;
      readonly cabin?: string;
      readonly airline?: string;
      readonly layoverMinutes?: number;
      readonly at?: string;
    }
  | {
      readonly kind: 'lodging';
      readonly memberIds: readonly MemberId[];
      readonly name?: string;
      readonly propertyKind?: string;
      readonly bedrooms?: number;
      readonly guests?: number;
      readonly totalMinor?: number;
      readonly nights?: number;
      readonly currency?: CurrencyCode;
      readonly at?: string;
    };

/** One member's share of one restaurant, bar, activity or ticket spend. */
export interface SpendShare {
  readonly memberId: MemberId;
  readonly category: string;
  readonly shareMinor: number;
  readonly currency: CurrencyCode;
  readonly at?: string;
}

export interface GroupLine {
  readonly memberId: MemberId;
  readonly text: string;
  readonly at: IsoDateTime;
  /** The thread message it came from (answers to "fancy or casual?" are left out of the tier). */
  readonly messageId?: string;
}

export interface TierSources {
  readonly trip: Trip;
  /** Members whose tiers are wanted (the group's roster, or one member in a DM). */
  readonly members: readonly Member[];
  readonly groupFacts: readonly GroupMemoryFact[];
  readonly activities?: readonly Activity[];
  readonly bookings?: readonly Booking[];
  readonly expenses?: readonly Expense[];
  readonly entries?: readonly LedgerEntry[];
  readonly travel?: readonly TravelFact[];
  /** Already-resolved shares of food, drinks, activities or tickets (fixtures, imports). */
  readonly shares?: readonly SpendShare[];
  readonly groupLines?: readonly GroupLine[];
  /**
   * One member's own private notes. Called once per member in `members`;
   * nothing it returns is copied into the output except that member's
   * signals.
   */
  readonly privateFacts?: (memberId: MemberId) => readonly MemberMemoryFact[];
}

const SPEND_CATEGORIES: ReadonlySet<string> = new Set(['food', 'drinks', 'activities', 'tickets']);

/** Whole nights between the trip's start and end dates (at least 1). */
export function tripNights(trip: Trip): number {
  const n = daysBetween(trip.startDate, trip.endDate);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Days of the trip, both ends included (at least 1). */
export function tripDays(trip: Trip): number {
  return tripNights(trip) + 1;
}

const SYMBOL: Readonly<Record<string, CurrencyCode>> = {
  '€': 'EUR' as CurrencyCode,
  $: 'USD' as CurrencyCode,
  '£': 'GBP' as CurrencyCode,
};

/**
 * A stored budget figure's amount in minor units (`€80` ⇒ 8000 EUR, `£1,000`
 * ⇒ 100000 GBP, a bare `80` in the tab currency). Undefined when it can't be
 * read exactly.
 */
export function budgetFigureMoney(
  f: BudgetFigure,
  tabCurrency: CurrencyCode,
): { readonly amountMinor: number; readonly currency: CurrencyCode } | undefined {
  const m = /^([€$£])?\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?(?:\s([A-Z]{3}))?$/.exec(
    f.amount.trim(),
  );
  if (m === null) return undefined;
  const currency =
    m[1] !== undefined ? SYMBOL[m[1]] : ((m[4] as CurrencyCode | undefined) ?? tabCurrency);
  if (currency === undefined) return undefined;
  const whole = Number(m[2]!.replace(/,/g, ''));
  const cents = m[3] === undefined ? 0 : Number(m[3].padEnd(2, '0'));
  const amountMinor = whole * 100 + cents;
  return Number.isSafeInteger(amountMinor) && amountMinor > 0
    ? { amountMinor, currency }
    : undefined;
}

/** The member's own budget figure from their private notes (latest wins), for their DM only. */
export function ownBudget(
  facts: readonly MemberMemoryFact[],
  tabCurrency: CurrencyCode,
):
  | {
      readonly figure: BudgetFigure;
      readonly amountMinor: number;
      readonly currency: CurrencyCode;
      readonly at: string;
    }
  | undefined {
  const sorted = facts
    .filter((f) => f.category === 'budget')
    .slice()
    .sort((a, b) => (a.learnedAt < b.learnedAt ? 1 : a.learnedAt > b.learnedAt ? -1 : 0));
  for (const f of sorted) {
    const figure = findBudgetFigure(f.text, tabCurrency);
    if (figure === undefined) continue;
    const m = budgetFigureMoney(figure, tabCurrency);
    if (m !== undefined) return { figure, ...m, at: f.learnedAt };
  }
  return undefined;
}

function push(map: Map<MemberId, TierSignal[]>, ids: readonly MemberId[], s: TierSignal): void {
  for (const id of ids) map.get(id)?.push(s);
}

function textSignal(text: string, at: string): TierSignal | undefined {
  const stated = tiers.statedTier(text);
  if (stated !== undefined) return { tier: stated, weight: 1, source: 'stated', at };
  return tiers.describedSignal(text, at);
}

/** Every member in `members` mapped to their signals (possibly none). */
export function collectTierSignals(src: TierSources): Map<MemberId, TierSignal[]> {
  const out = new Map<MemberId, TierSignal[]>(src.members.map((m) => [m.memberId, []] as const));
  const everyone = src.members.map((m) => m.memberId);
  const known = (ids: readonly MemberId[]): MemberId[] => ids.filter((id) => out.has(id));

  // Travel facts (structured).
  for (const t of src.travel ?? []) {
    if (t.kind === 'flight') {
      const s = tiers.flightSignal({
        ...(t.cabin !== undefined ? { cabin: t.cabin } : {}),
        ...(t.airline !== undefined ? { airline: t.airline } : {}),
        ...(t.layoverMinutes !== undefined ? { layoverMinutes: t.layoverMinutes } : {}),
        ...(t.at !== undefined ? { at: t.at } : {}),
      });
      if (s !== undefined) push(out, known([t.memberId]), s);
    } else {
      const s = tiers.lodgingSignal({
        ...(t.name !== undefined ? { name: t.name } : {}),
        ...(t.propertyKind !== undefined ? { kind: t.propertyKind } : {}),
        ...(t.bedrooms !== undefined ? { bedrooms: t.bedrooms } : {}),
        ...(t.guests !== undefined ? { guests: t.guests } : {}),
        ...(t.totalMinor !== undefined ? { totalMinor: t.totalMinor } : {}),
        ...(t.nights !== undefined ? { nights: t.nights } : {}),
        ...(t.currency !== undefined ? { currency: t.currency } : {}),
        ...(t.at !== undefined ? { at: t.at } : {}),
      });
      if (s !== undefined) push(out, known(t.memberIds), s);
    }
  }

  // Lodging bookings Trav made: the stay's name, then its price per person per night.
  for (const b of src.bookings ?? []) {
    // Only bookings that stand count.
    if (b.status === 'cancelled' || b.status === 'refunded') continue;
    if (b.kind === 'lodging') {
      const s = tiers.lodgingSignal({
        name: b.description,
        guests: b.attendees.length,
        totalMinor: b.totalMinor,
        nights: tripNights(src.trip),
        currency: b.currency,
        at: b.purchasedAt,
      });
      if (s !== undefined) push(out, known(b.attendees), s);
    } else if (b.kind === 'flight') {
      const s = tiers.describedSignal(b.description, b.purchasedAt);
      if (s !== undefined) push(out, known(b.attendees), { ...s, source: 'flight' });
    }
  }

  // The trip's own flight and lodging plans ("Eixample 3br apartment").
  for (const a of src.activities ?? []) {
    if (a.kind !== 'lodging' && a.kind !== 'flight') continue;
    const s = tiers.describedSignal(`${a.name} ${a.venue ?? ''}`, a.createdAt);
    if (s !== undefined) {
      push(out, everyone, { ...s, source: a.kind === 'flight' ? 'flight' : 'lodging' });
    }
  }

  // Group memory: described or stated; a fact about nobody is about everyone.
  for (const f of src.groupFacts) {
    if (tiers.parseVibeFact(f.text) !== undefined) continue;
    const s = textSignal(f.text, f.learnedAt);
    if (s === undefined) continue;
    push(out, f.aboutMemberIds.length > 0 ? known(f.aboutMemberIds) : everyone, s);
  }

  // The ledger: each member's own share of what they ate, drank and did.
  const byExpense = new Map<string, Expense>();
  for (const e of src.expenses ?? []) {
    if (e.status === 'logged' && SPEND_CATEGORIES.has(e.category)) byExpense.set(e.expenseId, e);
  }
  for (const entry of src.entries ?? []) {
    if (entry.kind !== 'owes' || !out.has(entry.memberId)) continue;
    const e = byExpense.get(entry.expenseId);
    if (e === undefined) continue;
    const s = tiers.spendSignal({
      category: e.category,
      shareMinor: entry.amount.amountMinor,
      currency: entry.amount.currency,
      at: e.occurredAt,
    });
    if (s !== undefined) out.get(entry.memberId)!.push(s);
  }
  for (const sh of src.shares ?? []) {
    if (!out.has(sh.memberId)) continue;
    const s = tiers.spendSignal({
      category: sh.category,
      shareMinor: sh.shareMinor,
      currency: sh.currency,
      ...(sh.at !== undefined ? { at: sh.at } : {}),
    });
    if (s !== undefined) out.get(sh.memberId)!.push(s);
  }

  // Members' own words in the group thread: what they want ("keep it cheap"),
  // else what they describe of their own trip ("first class on Emirates",
  // "TAP with a 5 hour layover"), credited to the speaker only.
  for (const line of src.groupLines ?? []) {
    if (!out.has(line.memberId)) continue;
    const s = textSignal(line.text, line.at);
    if (s !== undefined) out.get(line.memberId)!.push(s);
  }

  // Each member's own private notes: their figure and their stated preference.
  if (src.privateFacts !== undefined) {
    for (const id of everyone) {
      const facts = src.privateFacts(id);
      const mine = out.get(id)!;
      const budget = ownBudget(facts, src.trip.currency);
      if (budget !== undefined && budget.figure.period !== undefined) {
        const s = tiers.budgetFigureSignal({
          amountMinor: budget.amountMinor,
          currency: budget.currency,
          period: budget.figure.period,
          tripDays: tripDays(src.trip),
          at: budget.at,
        });
        if (s !== undefined) mine.push(s);
      }
      for (const f of facts) {
        if (f.category !== 'preference' && f.category !== 'budget') continue;
        const stated = tiers.statedTier(f.text);
        if (stated !== undefined) {
          mine.push({ tier: stated, weight: 1, source: 'stated', at: f.learnedAt });
        }
      }
    }
  }
  return out;
}
