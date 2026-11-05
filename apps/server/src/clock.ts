/**
 * The server's clocks (T-188). The only file in `apps/server` that reads the
 * wall clock (D-008; the lint rule exempts files named `clock.ts`).
 *
 * - Production: `createSystemClock()` from `@trav/core`, the real clock.
 * - `--demo=barcelona`: `createShiftedClock(BARCELONA_NOW)`, real time that
 *   started at the Razzmatazz moment, so the seeded March trip is "now" and
 *   its Morning After fires on schedule. It ticks at wall-clock speed.
 */
import type { Clock, IsoDateTime } from '@trav/core';
import { createSystemClock, formatIso, parseIso } from '@trav/core';

export { createSystemClock };

/** Wall-clock time, shifted so that boot is `startIso`. Keeps `startIso`'s UTC offset. */
export function createShiftedClock(startIso: IsoDateTime, wallMs: () => number = Date.now): Clock {
  const start = parseIso(startIso);
  const offsetMatch = /([+-])(\d{2}):?(\d{2})$/.exec(startIso);
  const offsetMinutes =
    offsetMatch === null
      ? 0
      : (offsetMatch[1] === '-' ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  const bootedAt = wallMs();
  const nowMs = (): number => start + (wallMs() - bootedAt);
  return { nowMs, now: () => formatIso(nowMs(), offsetMinutes) };
}

/** Milliseconds of real time, for durations in logs (never for domain time). */
export function monotonicMs(): number {
  return performance.now();
}
