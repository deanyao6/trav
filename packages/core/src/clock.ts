/**
 * Simulated clock and scheduler (docs/DECISIONS.md D-008).
 *
 * Rule: no `Date.now()` / `new Date()` without arguments anywhere under
 * the `src/` tree of any package or app except this file (enforced by an ESLint
 * `no-restricted-syntax` rule). Every function that needs "now" takes a `Clock`
 * or an explicit `IsoDateTime`. Recaps, proposal expiry, holds, offer expiry
 * and nudges all read the same clock, so the simulator's "+1 hour" and "next
 * morning" buttons move everything together.
 */
import type { GroupId, IsoDate, IsoDateTime, JobId, TimeZone, TripId } from './primitives.js';
import { notImplemented } from './errors.js';

export interface Clock {
  /** ISO-8601 with offset. */
  now(): IsoDateTime;
  /** Milliseconds since epoch; use for arithmetic. */
  nowMs(): number;
}

export interface SimulatedClock extends Clock {
  set(iso: IsoDateTime): void;
  advanceMs(ms: number): void;
  advanceHours(hours: number): void;
  /** Jump to `hour` (default 10:00) local time on the next calendar day in `tz` (the "next morning" button). */
  nextMorning(tz: TimeZone, hour?: number): void;
}

/** Wall clock. Only `apps/*` entry points and live-mode scripts construct this. */
export function createSystemClock(): Clock {
  return notImplemented('createSystemClock');
}

/** Starts at `startIso` and only moves when told to. Tests and the simulator use this. */
export function createSimulatedClock(startIso: IsoDateTime): SimulatedClock {
  return notImplemented(`createSimulatedClock(${startIso})`);
}

/** A fixed clock for pure-function tests. */
export function fixedClock(iso: IsoDateTime): Clock {
  return notImplemented(`fixedClock(${iso})`);
}

// ---------- time helpers (pure; take explicit instants) ----------

/** Calendar date of `iso` in `tz`. */
export function localDate(iso: IsoDateTime, tz: TimeZone): IsoDate {
  return notImplemented(`localDate(${iso}, ${tz})`);
}

/** Local hour (0-23) of `iso` in `tz`. */
export function localHour(iso: IsoDateTime, tz: TimeZone): number {
  return notImplemented(`localHour(${iso}, ${tz})`);
}

/** 1-based trip day number for `iso` given the trip's start date and tz; 0 before the trip. */
export function tripDayNumber(iso: IsoDateTime, tripStart: IsoDate, tz: TimeZone): number {
  return notImplemented(`tripDayNumber(${iso}, ${tripStart}, ${tz})`);
}

/** VOICE §3.9: `9:30pm`, `12am`; "tonight"/"tomorrow"/"last night" within 48h, else `sat mar 14`. */
export function formatTime(iso: IsoDateTime, tz: TimeZone, relativeTo?: IsoDateTime): string {
  return notImplemented(`formatTime(${iso}, ${tz}, ${relativeTo ?? ''})`);
}

export function addMinutes(iso: IsoDateTime, minutes: number): IsoDateTime {
  return notImplemented(`addMinutes(${iso}, ${minutes})`);
}

export function isAfter(a: IsoDateTime, b: IsoDateTime): boolean {
  return notImplemented(`isAfter(${a}, ${b})`);
}

// ---------- scheduler ----------

export type ScheduledJobKind =
  | 'morning_after'
  | 'daily_settle'
  | 'wrapped'
  | 'proposal_expiry'
  | 'hold_expiry'
  | 'private_digest'
  | 'day_of_reminder'
  | 'budget_check'
  | 'retention_purge';

export interface ScheduledJob {
  readonly jobId: JobId;
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly kind: ScheduledJobKind;
  readonly runAt: IsoDateTime;
  /** Small, serializable, never private data. e.g. `{ proposalId }`. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * Time-ordered job queue driven by whoever owns the clock (simulator, CLI,
 * evals): after advancing the clock, call `drain(clock.now())` and hand each job
 * to `TravAgent.runScheduled`. Scheduling the same `jobId` twice replaces the
 * earlier entry (idempotent re-scheduling).
 */
export interface Scheduler {
  schedule(job: ScheduledJob): void;
  cancel(jobId: JobId): void;
  /** Jobs with `runAt <= now`, in runAt order, removed from the queue. */
  drain(now: IsoDateTime): ScheduledJob[];
  /** Earliest pending runAt, for "+1 hour" style UIs. */
  peek(): ScheduledJob | undefined;
  list(): readonly ScheduledJob[];
}

export function createInMemoryScheduler(): Scheduler {
  return notImplemented('createInMemoryScheduler');
}
