/**
 * Pure computations behind the Morning After recap and the daily settle-up
 * (T-015, IDEAS Seed A / I-02, VOICE §4.6–4.7). Rendering (text, cards) lives
 * in packages/agent (`render/recap.ts`, `recaps/morningAfter.ts`). Trip
 * Wrapped's awards, totals and the photo highlight scorer are in `wrapped/`
 * (T-016); the recap reuses `wrapped.scoreHighlights`.
 *
 * Windows, all in the trip's zone, for the recap posted on the morning of `D`:
 *
 *   last night   D-1 12:00 → D 06:00   (what the full recap lists; the photos)
 *   yesterday    D-1 06:00 → D 06:00   (the family-mode "morning, day N" list)
 *   since recap  D-1 10:00 → D 10:00   (did the ledger change? quiet settle-up)
 *
 * Night-out signals (≥2 ⇒ full recap), inside last night:
 *   - a booked nightlife activity starting in the window
 *   - a group expense that happened 22:00 → 06:00
 *   - an opted-in album photo taken 23:00 → 06:00
 *   - a member's group chat message 00:00 → 06:00
 */
import type { IsoDate, IsoDateTime, TimeZone } from '../primitives.js';
import {
  addDays,
  daysBetween,
  formatIso,
  localDate,
  parseIso,
  zoneOffsetMinutes,
  zonedWallTimeToMs,
} from '../clock.js';

export interface NightSignals {
  readonly nightlifeBooking: boolean;
  readonly expenseAfter22: boolean;
  readonly photoAfter23: boolean;
  readonly chatAfterMidnight: boolean;
  /** Any ledger change since the last recap (for the quiet settle-up). */
  readonly balancesChanged: boolean;
}

export type RecapMode = 'full' | 'quiet' | 'silent';

/** Night-out signals needed for the full Morning After (IDEAS Seed A). */
export const NIGHT_OUT_MIN_SIGNALS = 2;
/** The recap posts at 10:00 trip time (VOICE §4.7). */
export const RECAP_HOUR = 10;

export function nightSignalCount(s: NightSignals): number {
  return [s.nightlifeBooking, s.expenseAfter22, s.photoAfter23, s.chatAfterMidnight].filter(Boolean)
    .length;
}

/**
 * ≥2 night-out signals ⇒ full; balances changed ⇒ quiet; else silent.
 * Family mode never uses "night out" framing (VOICE §8, IDEAS Seed A): it is
 * never `full`, only the quiet "morning, day N" when the ledger moved.
 */
export function decideRecapMode(signals: NightSignals, familyMode: boolean): RecapMode {
  if (!familyMode && nightSignalCount(signals) >= NIGHT_OUT_MIN_SIGNALS) return 'full';
  return signals.balancesChanged ? 'quiet' : 'silent';
}

export interface DayWindow {
  /** The recap's morning (local date). */
  readonly date: IsoDate;
  readonly tz: TimeZone;
  /** Inclusive. */
  readonly from: IsoDateTime;
  /** Exclusive. */
  readonly to: IsoDateTime;
}

function wall(date: IsoDate, hour: number, tz: TimeZone): IsoDateTime {
  const ms = zonedWallTimeToMs(date, hour, 0, tz);
  return formatIso(ms, zoneOffsetMinutes(ms, tz));
}

function windowOn(date: IsoDate, tz: TimeZone, fromHour: number, toHour: number): DayWindow {
  return { date, tz, from: wall(addDays(date, -1), fromHour, tz), to: wall(date, toHour, tz) };
}

/** "last night" for the recap on the morning of `morning`: 12:00 the day before → 06:00 (local). */
export function lastNightWindow(morning: IsoDateTime, tz: TimeZone): DayWindow {
  return windowOn(localDate(morning, tz), tz, 12, 6);
}

/** "yesterday" (family mode, VOICE §4.7 C): 06:00 the day before → 06:00 (local). */
export function yesterdayWindow(morning: IsoDateTime, tz: TimeZone): DayWindow {
  return windowOn(localDate(morning, tz), tz, 6, 6);
}

/** Since the previous recap: 10:00 the day before → 10:00 (local). */
export function sinceLastRecapWindow(morning: IsoDateTime, tz: TimeZone): DayWindow {
  return windowOn(localDate(morning, tz), tz, RECAP_HOUR, RECAP_HOUR);
}

export function inWindow(iso: IsoDateTime, w: Pick<DayWindow, 'from' | 'to'>): boolean {
  const t = parseIso(iso);
  return t >= parseIso(w.from) && t < parseIso(w.to);
}

export interface NightSignalInput {
  readonly morning: IsoDateTime;
  readonly timeZone: TimeZone;
  /** Logged group expenses (never a private item): when it happened and when it hit the ledger. */
  readonly expenses: readonly {
    readonly occurredAt: IsoDateTime;
    readonly createdAt: IsoDateTime;
  }[];
  /** Start times of nightlife activities that have a booking (or a booking-sourced expense). */
  readonly bookedNightlifeStarts: readonly IsoDateTime[];
  /** When each opted-in, visible album photo was taken (`takenAt ?? addedAt`). */
  readonly photoTimes: readonly IsoDateTime[];
  /** Members' group-lane message times (never guests, never DMs). */
  readonly chatTimes: readonly IsoDateTime[];
  /**
   * When a logged expense was undone or edited (audit `ledger.entry_deleted` /
   * `ledger.entry_edited`): an overnight undo moves the tab as much as a new one.
   */
  readonly ledgerChangeTimes?: readonly IsoDateTime[];
}

/** The five signals for the recap on `morning` (see the module comment for the windows). */
export function nightSignals(input: NightSignalInput): NightSignals {
  const tz = input.timeZone;
  const night = lastNightWindow(input.morning, tz);
  const prev = addDays(night.date, -1);
  const since = sinceLastRecapWindow(input.morning, tz);
  const after = (hourPrev: number | null): DayWindow =>
    hourPrev === null
      ? { ...night, from: wall(night.date, 0, tz) }
      : { ...night, from: wall(prev, hourPrev, tz) };
  return {
    nightlifeBooking: input.bookedNightlifeStarts.some((t) => inWindow(t, night)),
    expenseAfter22: input.expenses.some((e) => inWindow(e.occurredAt, after(22))),
    photoAfter23: input.photoTimes.some((t) => inWindow(t, after(23))),
    chatAfterMidnight: input.chatTimes.some((t) => inWindow(t, after(null))),
    balancesChanged:
      input.expenses.some((e) => inWindow(e.createdAt, since)) ||
      (input.ledgerChangeTimes ?? []).some((t) => inWindow(t, since)),
  };
}

/**
 * The mornings that get a recap job: the day after each trip night, i.e.
 * `startDate + 1 … endDate`. The morning after the last night is Wrapped's
 * (it carries the final settle), so it is not here.
 */
export function recapMornings(trip: {
  readonly startDate: IsoDate;
  readonly endDate: IsoDate;
}): IsoDate[] {
  const n = daysBetween(trip.startDate, trip.endDate);
  const out: IsoDate[] = [];
  for (let i = 1; i <= n; i++) out.push(addDays(trip.startDate, i));
  return out;
}

/** `wall(date, RECAP_HOUR)` in the trip zone: when the recap for `date` posts. */
export function recapTime(date: IsoDate, tz: TimeZone, hour: number = RECAP_HOUR): IsoDateTime {
  return wall(date, hour, tz);
}
