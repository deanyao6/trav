/**
 * Trip Wrapped totals (T-016): total spent, average per person, spend by
 * category, the biggest trip day, the top category and the "by the numbers"
 * facts the stats lines are built from. Pure; group ledger only (never
 * private, unconfirmed items); integer minor units.
 */
import type { CurrencyCode, ExpenseId, IsoDate, IsoDateTime, MemberId } from '../primitives.js';
import type { Expense, ExpenseCategory } from '../domain/expense.js';
import type { Money } from '../money.js';
import { money } from '../money.js';
import { parseIso } from '../clock.js';
import type { TripWindow } from './nights.js';
import { nightOf, nightOnTrip, tripDayOf } from './nights.js';
import { isRide, wrappedExpenses } from './awards.js';

export interface WrappedTotalsInput {
  readonly trip: TripWindow & { readonly currency: CurrencyCode };
  readonly expenses: readonly Expense[];
  /** Headcount for the per-person average (active, non-guest members). Must be ≥ 1 to average. */
  readonly people: number;
}

export interface WrappedTotals {
  readonly spent: Money;
  /** Rounded average (half up); `0` when `people < 1`. */
  readonly perPerson: Money;
  /** Descending by amount, then category name. */
  readonly byCategory: readonly { readonly category: ExpenseCategory; readonly amount: Money }[];
  readonly topCategory: { readonly category: ExpenseCategory; readonly amount: Money } | null;
  /** The trip day (local date) with the highest total; pre-trip bookings are not a day. */
  readonly biggestDay: {
    readonly date: IsoDate;
    readonly amount: Money;
    readonly expenseIds: readonly ExpenseId[];
  } | null;
  readonly biggestExpense: {
    readonly expenseId: ExpenseId;
    readonly description: string;
    readonly amount: Money;
  } | null;
  /** The biggest food expense (a dinner, a lunch). */
  readonly biggestMeal: {
    readonly expenseId: ExpenseId;
    readonly description: string;
    readonly amount: Money;
  } | null;
  readonly rides: {
    readonly count: number;
    readonly amount: Money;
    readonly expenseIds: readonly ExpenseId[];
  };
  /** Trip nights with at least one expense between 18:00 and 06:00. */
  readonly nightsOnTab: number;
  /** The latest-in-the-night expense of the trip (02:14 beats 23:50). */
  readonly latestNightExpense: {
    readonly expenseId: ExpenseId;
    readonly occurredAt: IsoDateTime;
    readonly paidBy: MemberId | null;
  } | null;
  readonly expenseCount: number;
  readonly bookingCount: number;
}

function dayMinutesFromNightStart(iso: IsoDateTime, night: IsoDate): number {
  // Minutes since 00:00 UTC of the night's date; fine for ordering within one zone.
  return (parseIso(iso) - Date.parse(`${night}T00:00:00Z`)) / 60_000;
}

export function computeTotals(input: WrappedTotalsInput): WrappedTotals {
  const { trip } = input;
  const cur = trip.currency;
  const expenses = wrappedExpenses(input.expenses, cur);
  const spentMinor = expenses.reduce((s, e) => s + e.amount.amountMinor, 0);

  const byCat = new Map<ExpenseCategory, number>();
  for (const e of expenses)
    byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount.amountMinor);
  const byCategory = [...byCat.entries()]
    .filter(([, v]) => v !== 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([category, v]) => ({ category, amount: money(v, cur) }));

  const days = new Map<IsoDate, { minor: number; ids: ExpenseId[] }>();
  for (const e of expenses) {
    const d = tripDayOf(e.occurredAt, trip);
    if (d === null) continue;
    const row = days.get(d) ?? { minor: 0, ids: [] };
    row.minor += e.amount.amountMinor;
    row.ids.push(e.expenseId);
    days.set(d, row);
  }
  let biggestDay: WrappedTotals['biggestDay'] = null;
  for (const [date, row] of [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (row.minor > 0 && (biggestDay === null || row.minor > biggestDay.amount.amountMinor)) {
      biggestDay = { date, amount: money(row.minor, cur), expenseIds: row.ids };
    }
  }

  const biggestOf = (list: readonly Expense[]): WrappedTotals['biggestExpense'] => {
    let best: Expense | undefined;
    for (const e of list)
      if (best === undefined || e.amount.amountMinor > best.amount.amountMinor) best = e;
    return best === undefined || best.amount.amountMinor <= 0
      ? null
      : {
          expenseId: best.expenseId,
          description: best.merchantDisplay ?? best.description,
          amount: best.amount,
        };
  };

  const rideList = expenses.filter(isRide);
  const nights = new Set<IsoDate>();
  let latest: { e: Expense; key: number } | undefined;
  for (const e of expenses) {
    const night = nightOf(e.occurredAt, trip.timeZone);
    if (night === null || !nightOnTrip(night, trip)) continue;
    nights.add(night);
    const key = dayMinutesFromNightStart(e.occurredAt, night);
    if (latest === undefined || key > latest.key) latest = { e, key };
  }

  return {
    spent: money(spentMinor, cur),
    perPerson: money(input.people >= 1 ? Math.round(spentMinor / input.people) : 0, cur),
    byCategory,
    topCategory: byCategory[0] ?? null,
    biggestDay,
    biggestExpense: biggestOf(expenses),
    biggestMeal: biggestOf(expenses.filter((e) => e.category === 'food')),
    rides: {
      count: rideList.length,
      amount: money(
        rideList.reduce((s, e) => s + e.amount.amountMinor, 0),
        cur,
      ),
      expenseIds: rideList.map((e) => e.expenseId),
    },
    nightsOnTab: nights.size,
    latestNightExpense:
      latest === undefined
        ? null
        : {
            expenseId: latest.e.expenseId,
            occurredAt: latest.e.occurredAt,
            paidBy: latest.e.paidBy[0]?.memberId ?? null,
          },
    expenseCount: expenses.length,
    bookingCount: expenses.filter((e) => e.source === 'booking').length,
  };
}
