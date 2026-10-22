/**
 * Pure computations behind the Morning After recap (T-015) and Trip Wrapped
 * (T-016). Rendering (text, cards) lives in packages/agent.
 */
import type { IsoDate, IsoDateTime, MemberId, TimeZone } from '../primitives.js';
import type { Money } from '../money.js';
import type { Activity, Attendance } from '../domain/trip.js';
import type { Booking } from '../domain/booking.js';
import type { Expense } from '../domain/expense.js';
import type { Member } from '../domain/group.js';
import { notImplemented } from '../errors.js';

export interface NightSignals {
  readonly nightlifeBooking: boolean;
  readonly expenseAfter22: boolean;
  readonly photoAfter23: boolean;
  readonly chatAfterMidnight: boolean;
  /** Any ledger change since the last recap (for the quiet settle-up). */
  readonly balancesChanged: boolean;
}

export type RecapMode = 'full' | 'quiet' | 'silent';

/** ≥2 signals ⇒ full; balances changed only ⇒ quiet; else silent. Family mode never uses "night out" framing. */
export function decideRecapMode(signals: NightSignals, familyMode: boolean): RecapMode {
  return notImplemented(`decideRecapMode(${signals.balancesChanged}, ${familyMode})`);
}

export interface DayWindow {
  readonly date: IsoDate;
  readonly tz: TimeZone;
  /** "last night" = 21:00 previous day .. 06:00 this day (local). */
  readonly from: IsoDateTime;
  readonly to: IsoDateTime;
}

export function lastNightWindow(morning: IsoDateTime, tz: TimeZone): DayWindow {
  return notImplemented(`lastNightWindow(${morning}, ${tz})`);
}

export interface AwardInput {
  readonly members: readonly Member[];
  readonly expenses: readonly Expense[];
  readonly bookings: readonly Booking[];
  readonly activities: readonly Activity[];
  readonly attendance: readonly Attendance[];
  readonly photoCounts: Readonly<Record<MemberId, number>>;
  readonly optedOut: readonly MemberId[];
  readonly minors: readonly MemberId[];
  readonly tz: TimeZone;
}

export type AwardTitle =
  | 'MVP Spender'
  | 'Most Fronted'
  | 'Uber Captain'
  | 'Night Owl'
  | 'Early Bird'
  | 'The Photographer'
  | 'Always In'
  | 'The Planner'
  | 'Best Value Night'
  | "Lily's pick";

export interface Award {
  readonly title: AwardTitle | string;
  readonly memberId: MemberId;
  /** "11 of 23 ubers", derived from data only. */
  readonly evidence: string;
  readonly basis: 'ledger' | 'booking' | 'attendance';
  /** True for nightlife-adjacent awards; never given to minors. */
  readonly nightlifeAdjacent: boolean;
}

/** One award per person where possible; opted-out members get none; minors only event-neutral positive ones. */
export function computeAwards(input: AwardInput): Award[] {
  return notImplemented(`computeAwards(${input.members.length})`);
}

export interface TripTotals {
  readonly spent: Money;
  readonly perPerson: Money;
  readonly byCategory: readonly { readonly category: string; readonly amount: Money }[];
  readonly biggestDay: { readonly date: IsoDate; readonly amount: Money } | null;
  readonly stats: readonly { readonly label: string; readonly value: string }[];
}

export function computeTripTotals(
  expenses: readonly Expense[],
  members: readonly Member[],
  currency: string,
  tz: TimeZone,
): TripTotals {
  return notImplemented(
    `computeTripTotals(${expenses.length}, ${members.length}, ${currency}, ${tz})`,
  );
}

export interface PhotoCandidate {
  readonly photoId: string;
  readonly byMemberId: MemberId;
  readonly takenAt?: IsoDateTime;
  readonly qualityTag?: 'good' | 'ok' | 'bad' | 'screenshot' | 'receipt' | 'blurry';
  readonly hidden: boolean;
}

/** Rank photos for a recap/Wrapped: spread across members and times, skip hidden/bad. Consent is filtered upstream. */
export function scoreHighlights(
  photos: readonly PhotoCandidate[],
  limit: number,
): PhotoCandidate[] {
  return notImplemented(`scoreHighlights(${photos.length}, ${limit})`);
}
