/**
 * The top-bar clock (VOICE §9.1): where each button moves the simulated
 * clock, and the muted status line a clock step leaves when Trav posts
 * nothing. Pure: the backend owns the clock and the scheduler.
 *
 *   +1 hour       now + 60 min
 *   next morning  the next 10:00 in the trip's zone (2am after the club ⇒
 *                 10am that same day, the Morning After; 9pm ⇒ 10am tomorrow)
 *   end of trip   10:00 the day after the trip's last day (when Wrapped is due)
 *
 * The clock only ever moves forward, so a scheduled job can never fire twice
 * and a replayed script cannot rewind the agent's stores.
 */
import type { IsoDateTime, ScheduledJob, ScheduledJobKind } from '@trav/core';
import {
  addDays,
  formatClockTime,
  formatDate,
  formatIso,
  nextDailyOccurrence,
  parseIso,
  tripDayNumber,
  zoneOffsetMinutes,
  zonedWallTimeToMs,
} from '@trav/core';
import type { TurnResult } from '@trav/agent';
import type { ClockRequest, ClockStep, SimGroup } from '../shared/types.js';

/**
 * `sun mar 15 · 10am · day 4`; `· trip over` after the last day. Same format
 * as the UI's top bar (`ui/logic.ts` `clockLabel`; the server build does not
 * include UI files, so it is repeated here and both are tested).
 */
export function clockLabel(now: IsoDateTime, group: SimGroup): string {
  const base = `${formatDate(now, group.timeZone)} · ${formatClockTime(now, group.timeZone)}`;
  const day = tripDayNumber(now, group.tripStart, group.timeZone);
  const last = tripDayNumber(`${group.tripEnd}T12:00:00Z`, group.tripStart, 'UTC');
  if (day > last) return `${base} · trip over`;
  return day > 0 ? `${base} · day ${String(day)}` : base;
}

/** Recap and Wrapped hour (ARCHITECTURE §4: `clock.nextMorning(trip.timeZone, 10)`). */
export const MORNING_HOUR = 10;
const HOUR_MS = 3_600_000;

function inZone(ms: number, group: SimGroup): IsoDateTime {
  return formatIso(ms, zoneOffsetMinutes(ms, group.timeZone));
}

/**
 * Where a clock request moves the clock, or `undefined` if that would not be
 * forward (already past the end of the trip; a replay line in the past).
 */
export function clockTarget(
  request: ClockRequest,
  now: IsoDateTime,
  group: SimGroup,
): IsoDateTime | undefined {
  const nowMs = parseIso(now);
  let target: number;
  if ('to' in request) {
    target = parseIso(request.to);
  } else {
    switch (request.step) {
      case 'hour':
        target = nowMs + HOUR_MS;
        break;
      case 'morning':
        target = parseIso(nextDailyOccurrence(now, group.timeZone, MORNING_HOUR));
        break;
      case 'end_of_trip':
        target = zonedWallTimeToMs(addDays(group.tripEnd, 1), MORNING_HOUR, 0, group.timeZone);
        break;
    }
  }
  return target > nowMs ? inZone(target, group) : undefined;
}

/** The job kinds a step exists to show (VOICE §9.5 states 5 and 6). */
const EXPECTED_KIND: Readonly<Partial<Record<ClockStep, ScheduledJobKind>>> = {
  morning: 'morning_after',
  end_of_trip: 'wrapped',
};

/**
 * What the demo is waiting on when an expected job never ran (backlog task
 * ids). The Morning After (T-015) is built: a morning with no job is simply a
 * morning with nothing scheduled, and a quiet recap reports its own note.
 */
const NOT_BUILT: Readonly<Partial<Record<ScheduledJobKind, string>>> = {
  wrapped: 'no Wrapped yet: the Wrapped job lands with T-016',
};

export interface ClockOutcomeInput {
  readonly request: ClockRequest;
  readonly group: SimGroup;
  /** Where the clock ended up (unchanged if the request was not forward). */
  readonly now: IsoDateTime;
  readonly moved: boolean;
  /** The jobs that were due, in drain order. */
  readonly jobs: readonly ScheduledJob[];
  /** Trav's turn for each job (same order). Empty when there is no scheduler. */
  readonly results: readonly Pick<TurnResult, 'silent' | 'note'>[];
  /** False when the backend has no scheduler to drain. */
  readonly scheduler: boolean;
}

/**
 * The muted status line after a clock move, or `undefined` when Trav posted
 * something (the post speaks for itself) or a replay `to` line changed
 * nothing worth saying. Never a Trav message; never names an amount.
 */
export function clockStatus(input: ClockOutcomeInput): string | undefined {
  const { request, group } = input;
  if (input.results.some((r) => !r.silent)) return undefined;
  const replayLine = 'to' in request;
  if (!input.moved) {
    if (replayLine) return undefined;
    return request.step === 'end_of_trip'
      ? `the trip is already over (clock at ${clockLabel(input.now, group)})`
      : `clock did not move (${clockLabel(input.now, group)})`;
  }
  const parts: string[] = [`clock → ${clockLabel(input.now, group)}`];
  if (!input.scheduler) {
    parts.push('this backend has no scheduler, so nothing ran');
    return parts.join(' · ');
  }
  if (input.jobs.length === 0) {
    parts.push('nothing was scheduled');
  } else {
    const notes = input.results.map((r) => r.note).filter((n) => n !== '');
    parts.push(
      `${String(input.jobs.length)} job${input.jobs.length === 1 ? '' : 's'} ran, trav stayed quiet` +
        (notes.length > 0 ? ` (${[...new Set(notes)].join(', ')})` : ''),
    );
  }
  const expected = replayLine ? request.expectJob : EXPECTED_KIND[request.step];
  let missing = false;
  if (expected !== undefined) {
    const ran = input.jobs.some((j) => j.kind === expected);
    const unhandled = input.results.some((r) => r.note === `scheduled:${expected}:not_handled`);
    const note = NOT_BUILT[expected];
    if ((!ran || unhandled) && note !== undefined) {
      parts.push(note);
      missing = true;
    }
  }
  // A replay line that moved the clock with nothing to report stays quiet.
  if (replayLine && input.jobs.length === 0 && !missing) return undefined;
  return parts.join(' · ');
}
