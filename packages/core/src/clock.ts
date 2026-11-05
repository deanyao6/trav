/**
 * Simulated clock and scheduler (docs/DECISIONS.md D-008).
 *
 * Rule: no `Date.now()` / `new Date()` without arguments anywhere under
 * the `src/` tree of any package or app except this file (enforced by an ESLint
 * `no-restricted-syntax` rule). Every function that needs "now" takes a `Clock`
 * or an explicit `IsoDateTime`. Recaps, proposal expiry, holds, offer expiry
 * and nudges all read the same clock, so the simulator's "+1 hour" and "next
 * morning" buttons move everything together.
 *
 * Time zones go through `Intl.DateTimeFormat` only (no date library).
 */
import type { GroupId, IsoDate, IsoDateTime, JobId, TimeZone, TripId } from './primitives.js';
import { TravError } from './errors.js';

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

// ---------- ISO parsing / formatting ----------

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Epoch ms of an ISO-8601 date-time that carries an offset (or `Z`). */
export function parseIso(iso: IsoDateTime): number {
  if (typeof iso !== 'string' || !ISO_OFFSET_RE.test(iso)) {
    throw new TravError(
      'invalid_argument',
      `expected ISO-8601 date-time with offset, got "${String(iso)}"`,
    );
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new TravError('invalid_argument', `invalid ISO-8601 date-time "${iso}"`);
  }
  return ms;
}

/** The offset (minutes east of UTC) written in an ISO string; `Z` ⇒ 0. */
function parseOffsetMinutes(iso: IsoDateTime): number {
  const match = ISO_OFFSET_RE.exec(iso);
  const suffix = match?.[1] ?? 'Z';
  if (suffix.toUpperCase() === 'Z') return 0;
  const sign = suffix.startsWith('-') ? -1 : 1;
  const digits = suffix.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  return sign * (hours * 60 + minutes);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'Z';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Render epoch ms as ISO-8601 at a fixed offset, e.g. `2026-03-14T21:40:00+01:00`. */
export function formatIso(ms: number, offsetMinutes: number): IsoDateTime {
  const shifted = new Date(ms + offsetMinutes * MS_PER_MINUTE);
  const base =
    `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}` +
    `T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
  const millis = shifted.getUTCMilliseconds();
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`;
  return `${base}${fraction}${formatOffset(offsetMinutes)}`;
}

// ---------- Intl helpers ----------

interface WallParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;
  readonly hour: number; // 0-23
  readonly minute: number;
  readonly second: number;
  readonly weekday: string; // "sat"
  readonly monthShort: string; // "mar"
}

const formatterCache = new Map<TimeZone, Intl.DateTimeFormat>();

function formatterFor(tz: TimeZone): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(tz, fmt);
    return fmt;
  } catch (cause) {
    throw new TravError('invalid_argument', `unknown time zone "${tz}"`, {
      tz,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function wallParts(ms: number, tz: TimeZone): WallParts {
  const parts = formatterFor(tz).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const monthShort = get('month').toLowerCase().slice(0, 3);
  const month = MONTHS.indexOf(monthShort) + 1;
  if (month === 0) {
    throw new TravError('invariant_violation', `could not read month from Intl for ${tz}`);
  }
  return {
    year: Number(get('year')),
    month,
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: get('weekday').toLowerCase().slice(0, 3),
    monthShort,
  };
}

/** Minutes east of UTC that `tz` observes at instant `ms`. */
export function zoneOffsetMinutes(ms: number, tz: TimeZone): number {
  const w = wallParts(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Drop sub-second part of `ms` so the difference is a whole number of seconds.
  return Math.round((asUtc - (ms - (((ms % 1000) + 1000) % 1000))) / MS_PER_MINUTE);
}

/** Epoch ms of wall time `hour:minute` on `date` in `tz` (DST-aware; a gap resolves forward). */
export function zonedWallTimeToMs(
  date: IsoDate,
  hour: number,
  minute: number,
  tz: TimeZone,
): number {
  const { year, month, day } = parseIsoDate(date);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Find an offset that is self-consistent at the instant it produces.
  const o1 = zoneOffsetMinutes(guess, tz);
  const c1 = guess - o1 * MS_PER_MINUTE;
  if (zoneOffsetMinutes(c1, tz) === o1) return c1;
  const o2 = zoneOffsetMinutes(c1, tz);
  const c2 = guess - o2 * MS_PER_MINUTE;
  if (zoneOffsetMinutes(c2, tz) === o2) return c2;
  // Neither offset fits: the wall time is in a spring-forward gap. Reading it
  // with the pre-transition (smaller) offset lands just after the gap
  // (02:00 becomes 03:00) in both eastern and western zones.
  return guess - Math.min(o1, o2) * MS_PER_MINUTE;
}

function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  const match = ISO_DATE_RE.exec(date);
  if (!match) {
    throw new TravError(
      'invalid_argument',
      `expected ISO date (YYYY-MM-DD), got "${String(date)}"`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new TravError('invalid_argument', `invalid calendar date "${date}"`);
  }
  return { year, month, day };
}

function toIsoDate(year: number, month: number, day: number): IsoDate {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Whole days from `a` to `b` (both calendar dates). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) /
      MS_PER_DAY,
  );
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return toIsoDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

// ---------- clocks ----------

/** Wall clock. Only `apps/*` entry points and live-mode scripts construct this. */
export function createSystemClock(): Clock {
  return {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
}

/** Starts at `startIso` and only moves when told to. Tests and the simulator use this. */
export function createSimulatedClock(startIso: IsoDateTime): SimulatedClock {
  let ms = parseIso(startIso);
  let offsetMinutes = parseOffsetMinutes(startIso);

  const advanceMs = (delta: number): void => {
    if (!Number.isFinite(delta) || delta < 0) {
      throw new TravError(
        'invalid_argument',
        `advanceMs: expected a non-negative number, got ${String(delta)}`,
      );
    }
    ms += Math.round(delta);
  };

  return {
    now: () => formatIso(ms, offsetMinutes),
    nowMs: () => ms,
    set(iso) {
      ms = parseIso(iso);
      offsetMinutes = parseOffsetMinutes(iso);
    },
    advanceMs,
    advanceHours(hours) {
      if (!Number.isFinite(hours) || hours < 0) {
        throw new TravError(
          'invalid_argument',
          `advanceHours: expected a non-negative number, got ${String(hours)}`,
        );
      }
      advanceMs(hours * MS_PER_HOUR);
    },
    nextMorning(tz, hour = 10) {
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new TravError(
          'invalid_argument',
          `nextMorning: hour must be 0-23, got ${String(hour)}`,
        );
      }
      const tomorrow = addDays(localDate(formatIso(ms, offsetMinutes), tz), 1);
      ms = zonedWallTimeToMs(tomorrow, hour, 0, tz);
      offsetMinutes = zoneOffsetMinutes(ms, tz);
    },
  };
}

/** A fixed clock for pure-function tests. */
export function fixedClock(iso: IsoDateTime): Clock {
  const ms = parseIso(iso);
  return { now: () => iso, nowMs: () => ms };
}

// ---------- time helpers (pure; take explicit instants) ----------

/** Calendar date of `iso` in `tz`. */
export function localDate(iso: IsoDateTime, tz: TimeZone): IsoDate {
  const w = wallParts(parseIso(iso), tz);
  return toIsoDate(w.year, w.month, w.day);
}

/** Local hour (0-23) of `iso` in `tz`. */
export function localHour(iso: IsoDateTime, tz: TimeZone): number {
  return wallParts(parseIso(iso), tz).hour;
}

/** 1-based trip day number for `iso` given the trip's start date and tz; 0 before the trip. */
export function tripDayNumber(iso: IsoDateTime, tripStart: IsoDate, tz: TimeZone): number {
  const diff = daysBetween(tripStart, localDate(iso, tz));
  return diff < 0 ? 0 : diff + 1;
}

/** `9:30pm`, `12am`, `2:14am` (VOICE §3.9): lowercase, no leading zero, minutes dropped on the hour. */
export function formatClockTime(iso: IsoDateTime, tz: TimeZone): string {
  const w = wallParts(parseIso(iso), tz);
  const suffix = w.hour < 12 ? 'am' : 'pm';
  const hour12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return w.minute === 0 ? `${hour12}${suffix}` : `${hour12}:${pad2(w.minute)}${suffix}`;
}

/** `sat mar 14` (VOICE §3.9). */
export function formatDate(iso: IsoDateTime, tz: TimeZone): string {
  const w = wallParts(parseIso(iso), tz);
  return `${w.weekday} ${w.monthShort} ${w.day}`;
}

/** Hours before 05:00 belong to the previous evening's "night". */
const NIGHT_STARTS_AT = 18;
const NIGHT_ENDS_BEFORE = 5;

function isNightHour(hour: number): boolean {
  return hour >= NIGHT_STARTS_AT || hour < NIGHT_ENDS_BEFORE;
}

/** The calendar date whose evening an instant belongs to (2am Sunday ⇒ Saturday night). */
function nightDate(ms: number, tz: TimeZone): IsoDate {
  const w = wallParts(ms, tz);
  const date = toIsoDate(w.year, w.month, w.day);
  return w.hour < NIGHT_ENDS_BEFORE ? addDays(date, -1) : date;
}

/**
 * VOICE §3.9: `9:30pm`, `12am`; "tonight"/"tomorrow"/"last night" within 48h of
 * `relativeTo`, else `sat mar 14 9:30pm`. Without `relativeTo` only the clock time
 * is returned. Evening and small-hours instants (18:00–04:59) are phrased as
 * nights ("last night 2:14am" for the ride home); daytime ones as days
 * ("tomorrow 2pm"; same-day daytime is just the time).
 */
export function formatTime(iso: IsoDateTime, tz: TimeZone, relativeTo?: IsoDateTime): string {
  const time = formatClockTime(iso, tz);
  if (relativeTo === undefined) return time;

  const ms = parseIso(iso);
  const relMs = parseIso(relativeTo);
  const absolute = `${formatDate(iso, tz)} ${time}`;
  if (Math.abs(ms - relMs) > 48 * MS_PER_HOUR) return absolute;

  const hour = wallParts(ms, tz).hour;
  if (isNightHour(hour)) {
    const diff = daysBetween(nightDate(relMs, tz), nightDate(ms, tz));
    if (diff === 0) return `tonight ${time}`;
    if (diff === -1) return `last night ${time}`;
    if (diff === 1) return `tomorrow night ${time}`;
    return absolute;
  }
  const diff = daysBetween(localDate(relativeTo, tz), localDate(iso, tz));
  if (diff === 0) return time;
  if (diff === -1) return `yesterday ${time}`;
  if (diff === 1) return `tomorrow ${time}`;
  return absolute;
}

/** Adds minutes, preserving the offset written in `iso`. */
export function addMinutes(iso: IsoDateTime, minutes: number): IsoDateTime {
  if (!Number.isFinite(minutes)) {
    throw new TravError(
      'invalid_argument',
      `addMinutes: expected a finite number, got ${String(minutes)}`,
    );
  }
  return formatIso(parseIso(iso) + Math.round(minutes * MS_PER_MINUTE), parseOffsetMinutes(iso));
}

export function isAfter(a: IsoDateTime, b: IsoDateTime): boolean {
  return parseIso(a) > parseIso(b);
}

// ---------- scheduler ----------

export type ScheduledJobKind =
  | 'morning_after'
  | 'daily_settle'
  | 'wrapped'
  | 'proposal_expiry'
  | 'hold_expiry'
  | 'private_digest'
  /** T-067: one linked owner's card sync at a VOICE §2 digest slot (10:00 / 20:00 trip time); payload `{ ownerMemberId }`. */
  | 'card_import'
  | 'day_of_reminder'
  | 'budget_check'
  | 'retention_purge'
  /**
   * T-165: the end of a held ledger notice's ~60s window (VOICE §4.13): a
   * digest share still waiting on the rest of its digest, or a booking still
   * waiting on its receipt card. Payload `{ expenseIds }` (comma-separated).
   */
  | 'expense_notice';

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

interface QueueEntry {
  readonly job: ScheduledJob;
  readonly runAtMs: number;
  /** Insertion sequence: ties on `runAt` drain in the order they were (last) scheduled. */
  readonly seq: number;
}

function compareEntries(a: QueueEntry, b: QueueEntry): number {
  return a.runAtMs - b.runAtMs || a.seq - b.seq;
}

function assertJob(job: ScheduledJob): number {
  if (typeof job.jobId !== 'string' || job.jobId.length === 0) {
    throw new TravError('invalid_argument', 'schedule: jobId must be a non-empty string');
  }
  return parseIso(job.runAt);
}

/**
 * In-memory `Scheduler` (the only v0 implementation). `schedule` with an
 * existing `jobId` replaces the earlier entry (new runAt, new tie-break slot).
 * Order is `runAt` as an instant (offsets normalised), then scheduling order.
 */
export function createInMemoryScheduler(): Scheduler {
  const entries = new Map<JobId, QueueEntry>();
  let seq = 0;

  const sorted = (): QueueEntry[] => [...entries.values()].sort(compareEntries);

  return {
    schedule(job) {
      const runAtMs = assertJob(job);
      entries.delete(job.jobId);
      entries.set(job.jobId, { job, runAtMs, seq: seq++ });
    },
    cancel(jobId) {
      entries.delete(jobId);
    },
    drain(now) {
      const nowMs = parseIso(now);
      const due = sorted().filter((e) => e.runAtMs <= nowMs);
      for (const e of due) entries.delete(e.job.jobId);
      return due.map((e) => e.job);
    },
    peek() {
      return sorted()[0]?.job;
    },
    list() {
      return sorted().map((e) => e.job);
    },
  };
}

/**
 * Where a stored scheduler keeps its queue (T-185, D-054): the runtime state
 * repository (`GroupStore.runtime`) implements it on both storage backends.
 */
export interface ScheduledJobStore {
  /** Replaces by `jobId`; a replaced job moves to the back of the scheduling order. */
  putJob(job: ScheduledJob): void;
  /** No-op for an unknown id. */
  deleteJob(jobId: JobId): void;
  /** Every queued job, in scheduling order (the order they were last put). */
  listJobs(): readonly ScheduledJob[];
}

/**
 * A `Scheduler` over a `ScheduledJobStore` (T-185): the same semantics as
 * `createInMemoryScheduler` (runAt order, ties in scheduling order, replace by
 * jobId), but the queue survives a restart when the store is SQLite, so a
 * pending proposal's expiry or a held notice still runs after a crash.
 */
export function createStoredScheduler(store: ScheduledJobStore): Scheduler {
  const sorted = (): QueueEntry[] =>
    store
      .listJobs()
      .map((job, seq) => ({ job, runAtMs: parseIso(job.runAt), seq }))
      .sort(compareEntries);

  return {
    schedule(job) {
      assertJob(job);
      store.putJob(job);
    },
    cancel(jobId) {
      store.deleteJob(jobId);
    },
    drain(now) {
      const nowMs = parseIso(now);
      const due = sorted().filter((e) => e.runAtMs <= nowMs);
      for (const e of due) store.deleteJob(e.job.jobId);
      return due.map((e) => e.job);
    },
    peek() {
      return sorted()[0]?.job;
    },
    list() {
      return sorted().map((e) => e.job);
    },
  };
}

/**
 * The first instant strictly after `after` whose wall-clock time in `tz` is
 * `hour:00`. DST-aware: a non-existent hour (spring-forward gap) resolves
 * forward, like `SimulatedClock.nextMorning`. Rendered with the zone's offset
 * at that instant.
 */
export function nextDailyOccurrence(after: IsoDateTime, tz: TimeZone, hour: number): IsoDateTime {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new TravError(
      'invalid_argument',
      `nextDailyOccurrence: hour must be 0-23, got ${String(hour)}`,
    );
  }
  const afterMs = parseIso(after);
  const today = localDate(after, tz);
  // Today's slot only if `after` is still before `hour:00` on the wall clock;
  // otherwise start tomorrow. This stops a repeated fall-back hour (02:00+02:00
  // then 02:00+01:00) from firing twice on the same local date.
  const first = localHour(after, tz) < hour ? 0 : 1;
  // A third candidate day only guards odd zone transitions.
  for (let d = first; d <= first + 2; d++) {
    const ms = zonedWallTimeToMs(addDays(today, d), hour, 0, tz);
    if (ms > afterMs) return formatIso(ms, zoneOffsetMinutes(ms, tz));
  }
  throw new TravError(
    'invariant_violation',
    `nextDailyOccurrence: no slot found after ${after} in ${tz}`,
  );
}

/**
 * Re-schedule a recurring daily job (recaps, daily settle-up) for the next
 * `hour:00` local time in `tz` strictly after the later of `now` and the job's
 * own `runAt`, so a late drain never schedules into the past (no catch-up
 * copies for skipped days). Pass `clock.now()`. Same `jobId`, so it replaces
 * any pending copy. Returns the job that was scheduled.
 */
export function rescheduleDaily(
  scheduler: Scheduler,
  job: ScheduledJob,
  tz: TimeZone,
  hour: number,
  now: IsoDateTime,
): ScheduledJob {
  const after = parseIso(now) > parseIso(job.runAt) ? now : job.runAt;
  const next: ScheduledJob = { ...job, runAt: nextDailyOccurrence(after, tz, hour) };
  scheduler.schedule(next);
  return next;
}
