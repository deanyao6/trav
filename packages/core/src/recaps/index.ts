/**
 * Pure computations behind the Morning After recap (T-015). Rendering (text,
 * cards) lives in packages/agent. Trip Wrapped's awards, totals and the photo
 * highlight scorer are in `wrapped/` (T-016); recaps can reuse
 * `wrapped.scoreHighlights`.
 */
import type { IsoDate, IsoDateTime, TimeZone } from '../primitives.js';
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
