import { describe, expect, it } from 'vitest';
import {
  createInMemoryScheduler,
  createSimulatedClock,
  localDate,
  localHour,
  nextDailyOccurrence,
  parseIso,
  rescheduleDaily,
  type ScheduledJob,
} from './clock.js';
import { TravError } from './errors.js';

const MADRID = 'Europe/Madrid';

function job(jobId: string, runAt: string, extra: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    jobId,
    groupId: 'grp_barcelona',
    tripId: 'trip_barcelona',
    kind: 'morning_after',
    runAt,
    payload: {},
    ...extra,
  };
}

const ids = (jobs: readonly ScheduledJob[]): string[] => jobs.map((j) => j.jobId);

describe('createInMemoryScheduler', () => {
  it('starts empty', () => {
    const s = createInMemoryScheduler();
    expect(s.list()).toEqual([]);
    expect(s.peek()).toBeUndefined();
    expect(s.drain('2030-01-01T00:00:00Z')).toEqual([]);
  });

  it('drain returns only due jobs (runAt <= now), in runAt order, and removes them', () => {
    const s = createInMemoryScheduler();
    s.schedule(job('job_c', '2026-03-15T10:00:00+01:00'));
    s.schedule(job('job_a', '2026-03-14T22:00:00+01:00'));
    s.schedule(job('job_late', '2026-03-16T10:00:00+01:00'));
    s.schedule(job('job_b', '2026-03-15T09:00:00+01:00'));

    const due = s.drain('2026-03-15T10:00:00+01:00'); // exactly at job_c's runAt: due
    expect(ids(due)).toEqual(['job_a', 'job_b', 'job_c']);
    expect(ids(s.list())).toEqual(['job_late']);
    expect(s.drain('2026-03-15T10:00:00+01:00')).toEqual([]);
    expect(ids(s.drain('2026-03-16T10:00:00+01:00'))).toEqual(['job_late']);
    expect(s.list()).toEqual([]);
  });

  it('orders by instant, not by string, across different offsets', () => {
    const s = createInMemoryScheduler();
    // 09:30Z is later than 10:00+01:00 (= 09:00Z) despite sorting earlier as a string.
    s.schedule(job('job_utc', '2026-03-15T09:30:00Z'));
    s.schedule(job('job_madrid', '2026-03-15T10:00:00+01:00'));
    expect(ids(s.list())).toEqual(['job_madrid', 'job_utc']);
    expect(ids(s.drain('2026-03-15T09:15:00Z'))).toEqual(['job_madrid']);
  });

  it('ties on runAt drain in scheduling order (stable)', () => {
    const s = createInMemoryScheduler();
    const at = '2026-03-15T10:00:00+01:00';
    s.schedule(job('job_z', at));
    s.schedule(job('job_a', at));
    s.schedule(job('job_m', '2026-03-15T09:00:00Z')); // same instant, different offset
    expect(ids(s.drain(at))).toEqual(['job_z', 'job_a', 'job_m']);
  });

  it('scheduling the same jobId twice keeps one entry (the latest)', () => {
    const s = createInMemoryScheduler();
    s.schedule(job('job_1', '2026-03-15T10:00:00+01:00', { payload: { v: 1 } }));
    s.schedule(job('job_2', '2026-03-15T11:00:00+01:00'));
    s.schedule(job('job_1', '2026-03-15T12:00:00+01:00', { payload: { v: 2 } }));
    expect(s.list()).toHaveLength(2);
    expect(ids(s.list())).toEqual(['job_2', 'job_1']);
    // The old 10:00 slot is gone.
    expect(s.drain('2026-03-15T10:30:00+01:00')).toEqual([]);
    const due = s.drain('2026-03-15T12:00:00+01:00');
    expect(ids(due)).toEqual(['job_2', 'job_1']);
    expect(due[1]?.payload).toEqual({ v: 2 });
  });

  it('re-scheduling a tied jobId moves it to the back of the tie', () => {
    const s = createInMemoryScheduler();
    const at = '2026-03-15T10:00:00+01:00';
    s.schedule(job('job_a', at));
    s.schedule(job('job_b', at));
    s.schedule(job('job_a', at));
    expect(ids(s.list())).toEqual(['job_b', 'job_a']);
  });

  it('peek returns the earliest pending job without removing it', () => {
    const s = createInMemoryScheduler();
    s.schedule(job('job_2', '2026-03-15T11:00:00+01:00'));
    s.schedule(job('job_1', '2026-03-15T10:00:00+01:00'));
    expect(s.peek()?.jobId).toBe('job_1');
    expect(s.list()).toHaveLength(2);
  });

  it('cancel removes a job; cancelling an unknown id is a no-op', () => {
    const s = createInMemoryScheduler();
    s.schedule(job('job_1', '2026-03-15T10:00:00+01:00'));
    s.schedule(job('job_2', '2026-03-15T11:00:00+01:00'));
    s.cancel('job_1');
    s.cancel('job_missing');
    expect(ids(s.list())).toEqual(['job_2']);
    expect(ids(s.drain('2026-03-20T00:00:00Z'))).toEqual(['job_2']);
  });

  it('list is a snapshot; mutating it does not touch the queue', () => {
    const s = createInMemoryScheduler();
    s.schedule(job('job_1', '2026-03-15T10:00:00+01:00'));
    const snapshot = s.list() as ScheduledJob[];
    snapshot.pop();
    expect(s.list()).toHaveLength(1);
  });

  it('rejects a runAt without an offset, an empty jobId, and a bad drain instant', () => {
    const s = createInMemoryScheduler();
    expect(() => s.schedule(job('job_1', '2026-03-15T10:00:00'))).toThrow(TravError);
    expect(() => s.schedule(job('', '2026-03-15T10:00:00Z'))).toThrow(TravError);
    expect(() => s.drain('not a date')).toThrow(TravError);
    expect(s.list()).toEqual([]);
  });

  it('works with a simulated clock: advance, drain, nothing early', () => {
    const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
    const s = createInMemoryScheduler();
    s.schedule(job('job_recap', '2026-03-15T10:00:00+01:00'));
    s.schedule(job('job_expiry', '2026-03-14T22:10:00+01:00', { kind: 'proposal_expiry' }));
    clock.advanceHours(0.25);
    expect(s.drain(clock.now())).toEqual([]);
    clock.advanceHours(0.25);
    expect(ids(s.drain(clock.now()))).toEqual(['job_expiry']);
    clock.nextMorning(MADRID);
    expect(ids(s.drain(clock.now()))).toEqual(['job_recap']);
  });
});

describe('nextDailyOccurrence', () => {
  it('same day if the hour is still ahead, next day otherwise (strictly after)', () => {
    expect(nextDailyOccurrence('2026-03-14T08:00:00+01:00', MADRID, 10)).toBe(
      '2026-03-14T10:00:00+01:00',
    );
    expect(nextDailyOccurrence('2026-03-14T10:00:00+01:00', MADRID, 10)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
    expect(nextDailyOccurrence('2026-03-14T23:59:00+01:00', MADRID, 10)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
  });

  it('uses the zone, not the offset of the input', () => {
    // 23:30Z on the 14th is 00:30 on the 15th in Madrid; 10:00 Madrid on the 15th is next.
    expect(nextDailyOccurrence('2026-03-14T23:30:00Z', MADRID, 10)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
  });

  it('rejects an hour outside 0-23', () => {
    expect(() => nextDailyOccurrence('2026-03-14T08:00:00Z', MADRID, 24)).toThrow(TravError);
    expect(() => nextDailyOccurrence('2026-03-14T08:00:00Z', MADRID, 9.5)).toThrow(TravError);
  });
});

describe('DST crossings in Europe/Madrid', () => {
  it('nextMorning across spring-forward (2026-03-29): 10:00 CEST, 23h later', () => {
    const clock = createSimulatedClock('2026-03-28T11:00:00+01:00');
    clock.nextMorning(MADRID);
    expect(clock.now()).toBe('2026-03-29T10:00:00+02:00');
    expect(localHour(clock.now(), MADRID)).toBe(10);
  });

  it('nextMorning across fall-back (2026-10-25): 10:00 CET', () => {
    const clock = createSimulatedClock('2026-10-24T11:00:00+02:00');
    clock.nextMorning(MADRID);
    expect(clock.now()).toBe('2026-10-25T10:00:00+01:00');
    expect(localHour(clock.now(), MADRID)).toBe(10);
  });

  it('rescheduleDaily across spring-forward keeps 10:00 local (23h gap)', () => {
    const s = createInMemoryScheduler();
    const first = job('job_morning_after', '2026-03-28T10:00:00+01:00');
    s.schedule(first);
    const [ran] = s.drain('2026-03-28T10:00:00+01:00');
    expect(ran).toBeDefined();
    const next = rescheduleDaily(s, ran as ScheduledJob, MADRID, 10, '2026-03-28T10:00:00+01:00');
    expect(next.runAt).toBe('2026-03-29T10:00:00+02:00');
    expect(parseIso(next.runAt) - parseIso(first.runAt)).toBe(23 * 3_600_000);
    expect(s.list()).toEqual([next]);
    expect(next.jobId).toBe(first.jobId);
    expect(next.kind).toBe('morning_after');
  });

  it('rescheduleDaily across fall-back keeps 10:00 local (25h gap)', () => {
    const s = createInMemoryScheduler();
    const next = rescheduleDaily(
      s,
      job('job_settle', '2026-10-24T10:00:00+02:00'),
      MADRID,
      10,
      '2026-10-24T10:00:00+02:00',
    );
    expect(next.runAt).toBe('2026-10-25T10:00:00+01:00');
    expect(parseIso(next.runAt) - parseIso('2026-10-24T10:00:00+02:00')).toBe(25 * 3_600_000);
    expect(localDate(next.runAt, MADRID)).toBe('2026-10-25');
  });

  it('an hour inside the spring-forward gap (02:00 on 2026-03-29) resolves forward to a real instant', () => {
    const at = nextDailyOccurrence('2026-03-28T03:00:00+01:00', MADRID, 2);
    expect(localDate(at, MADRID)).toBe('2026-03-29');
    expect(at).toBe('2026-03-29T03:00:00+02:00');
  });

  it('an hour repeated at fall-back (02:00 on 2026-10-25) is scheduled once', () => {
    const at = nextDailyOccurrence('2026-10-24T03:00:00+02:00', MADRID, 2);
    expect(localDate(at, MADRID)).toBe('2026-10-25');
    expect(localHour(at, MADRID)).toBe(2);
    // From that instant the next 02:00 is on the 26th, not the repeated hour.
    expect(localDate(nextDailyOccurrence(at, MADRID, 2), MADRID)).toBe('2026-10-26');
  });

  it('a job at the first 02:00 (CEST) is not re-fired at the repeated 02:00 (CET) an hour later', () => {
    const next = nextDailyOccurrence('2026-10-25T02:00:00+02:00', MADRID, 2);
    expect(next).toBe('2026-10-26T02:00:00+01:00');
    // Same from anywhere inside the repeated hour, either copy.
    expect(nextDailyOccurrence('2026-10-25T02:30:00+02:00', MADRID, 2)).toBe(
      '2026-10-26T02:00:00+01:00',
    );
    expect(nextDailyOccurrence('2026-10-25T02:00:00+01:00', MADRID, 2)).toBe(
      '2026-10-26T02:00:00+01:00',
    );
    const s = createInMemoryScheduler();
    const j = job('job_night', '2026-10-25T02:00:00+02:00');
    s.schedule(j);
    const [ran] = s.drain(j.runAt);
    rescheduleDaily(s, ran as ScheduledJob, MADRID, 2, j.runAt);
    expect(s.drain('2026-10-25T02:59:59+01:00')).toEqual([]);
    expect(s.peek()?.runAt).toBe('2026-10-26T02:00:00+01:00');
  });
});

describe('DST crossings in America/Grand_Turk (western zone)', () => {
  const TC = 'America/Grand_Turk';

  it('02:00 inside the spring-forward gap (2026-03-08) resolves forward to 03:00 EDT', () => {
    expect(nextDailyOccurrence('2026-03-07T03:00:00-05:00', TC, 2)).toBe(
      '2026-03-08T03:00:00-04:00',
    );
    // From just before the gap on the same day, the gap day is not skipped.
    expect(nextDailyOccurrence('2026-03-08T01:30:00-05:00', TC, 2)).toBe(
      '2026-03-08T03:00:00-04:00',
    );
    const clock = createSimulatedClock('2026-03-07T11:00:00-05:00');
    clock.nextMorning(TC, 2);
    expect(clock.now()).toBe('2026-03-08T03:00:00-04:00');
    expect(localHour(clock.now(), TC)).toBe(3);
  });

  it('10:00 local on the spring-forward day (23h gap)', () => {
    const s = createInMemoryScheduler();
    const at = '2026-03-07T10:00:00-05:00';
    const next = rescheduleDaily(s, job('job_tc', at), TC, 10, at);
    expect(next.runAt).toBe('2026-03-08T10:00:00-04:00');
    expect(parseIso(next.runAt) - parseIso(at)).toBe(23 * 3_600_000);
  });

  it('10:00 local on the fall-back day (2026-11-01, 25h gap)', () => {
    const s = createInMemoryScheduler();
    const at = '2026-10-31T10:00:00-04:00';
    const next = rescheduleDaily(s, job('job_tc', at), TC, 10, at);
    expect(next.runAt).toBe('2026-11-01T10:00:00-05:00');
    expect(parseIso(next.runAt) - parseIso(at)).toBe(25 * 3_600_000);
    const clock = createSimulatedClock(at);
    clock.nextMorning(TC);
    expect(clock.now()).toBe('2026-11-01T10:00:00-05:00');
  });

  it('the repeated 01:00 at fall-back (2026-11-01) is scheduled once', () => {
    const at = nextDailyOccurrence('2026-10-31T03:00:00-04:00', TC, 1);
    expect(localDate(at, TC)).toBe('2026-11-01');
    expect(localHour(at, TC)).toBe(1);
    expect(localDate(nextDailyOccurrence(at, TC, 1), TC)).toBe('2026-11-02');
    expect(nextDailyOccurrence('2026-11-01T01:00:00-04:00', TC, 1)).toBe(
      '2026-11-02T01:00:00-05:00',
    );
  });
});

describe('rescheduleDaily', () => {
  it('replaces a pending copy of the same jobId', () => {
    const s = createInMemoryScheduler();
    const j = job('job_daily', '2026-03-14T10:00:00+01:00');
    s.schedule(j);
    rescheduleDaily(s, j, MADRID, 10, j.runAt);
    expect(s.list()).toHaveLength(1);
    expect(s.peek()?.runAt).toBe('2026-03-15T10:00:00+01:00');
  });

  it('after a late drain, schedules strictly after now, never in the past', () => {
    const s = createInMemoryScheduler();
    const j = job('job_daily', '2026-03-14T10:00:00+01:00');
    // The simulator jumped three days; the job is drained at 2026-03-17 12:00.
    const next = rescheduleDaily(s, j, MADRID, 10, '2026-03-17T12:00:00+01:00');
    expect(next.runAt).toBe('2026-03-18T10:00:00+01:00');
  });

  it('an earlier `now` than runAt still schedules after runAt', () => {
    const s = createInMemoryScheduler();
    const j = job('job_daily', '2026-03-14T10:00:00+01:00');
    const next = rescheduleDaily(s, j, MADRID, 10, '2026-03-13T09:00:00+01:00');
    expect(next.runAt).toBe('2026-03-15T10:00:00+01:00');
  });

  it('a drain-then-reschedule loop after a multi-day jump fires once, no catch-up copies', () => {
    const clock = createSimulatedClock('2026-03-14T09:00:00+01:00');
    const s = createInMemoryScheduler();
    s.schedule(job('job_daily', '2026-03-14T10:00:00+01:00'));
    clock.advanceHours(24 * 3 + 3); // 2026-03-17 12:00
    const fired: string[] = [];
    for (let i = 0; i < 10; i++) {
      const due = s.drain(clock.now());
      if (due.length === 0) break;
      for (const d of due) {
        fired.push(d.runAt);
        rescheduleDaily(s, d, MADRID, 10, clock.now());
      }
    }
    expect(fired).toEqual(['2026-03-14T10:00:00+01:00']);
    expect(s.peek()?.runAt).toBe('2026-03-18T10:00:00+01:00');
  });

  it('`now` is required by the type', () => {
    const s = createInMemoryScheduler();
    const j = job('job_daily', '2026-03-14T10:00:00+01:00');
    // @ts-expect-error now is required
    expect(() => rescheduleDaily(s, j, MADRID, 10)).toThrow(TravError);
  });

  it('does not mutate the input job', () => {
    const s = createInMemoryScheduler();
    const j = job('job_daily', '2026-03-14T10:00:00+01:00');
    rescheduleDaily(s, j, MADRID, 10, j.runAt);
    expect(j.runAt).toBe('2026-03-14T10:00:00+01:00');
  });
});
