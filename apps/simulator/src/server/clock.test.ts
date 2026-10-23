import { describe, expect, it } from 'vitest';
import type { ScheduledJob } from '@trav/core';
import { clockLabel as uiClockLabel } from '../ui/logic.js';
import { clockLabel, clockStatus, clockTarget } from './clock.js';
import { BARCELONA, TURKS_AND_CAICOS } from './groups.js';

const job = (kind: ScheduledJob['kind'], runAt: string): ScheduledJob => ({
  jobId: `${kind}:1`,
  groupId: BARCELONA.groupId,
  tripId: 'trip_barcelona',
  kind,
  runAt,
  payload: {},
});

describe('clockTarget', () => {
  it('+1 hour is exactly an hour later, in the trip zone', () => {
    expect(clockTarget({ step: 'hour' }, '2026-03-14T21:41:00+01:00', BARCELONA)).toBe(
      '2026-03-14T22:41:00+01:00',
    );
  });

  it('next morning: 9:41pm ⇒ 10am tomorrow; 2:14am after the club ⇒ 10am that same day', () => {
    expect(clockTarget({ step: 'morning' }, '2026-03-14T21:41:00+01:00', BARCELONA)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
    expect(clockTarget({ step: 'morning' }, '2026-03-15T02:14:00+01:00', BARCELONA)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
    // Exactly 10am: the next one, never "now" (the clock always moves forward).
    expect(clockTarget({ step: 'morning' }, '2026-03-15T10:00:00+01:00', BARCELONA)).toBe(
      '2026-03-16T10:00:00+01:00',
    );
  });

  it('next morning uses the trip zone, not the ISO offset of now', () => {
    // 11:30pm in Madrid is 6:30pm in Grand Turk: next 10am there is the 15th, at -04:00.
    expect(clockTarget({ step: 'morning' }, '2026-03-14T23:30:00+01:00', TURKS_AND_CAICOS)).toBe(
      '2026-03-15T10:00:00-04:00',
    );
  });

  it('end of trip: 10am the day after the last day (Wrapped time); never backwards', () => {
    expect(clockTarget({ step: 'end_of_trip' }, '2026-03-14T21:41:00+01:00', BARCELONA)).toBe(
      '2026-03-18T10:00:00+01:00',
    );
    expect(clockTarget({ step: 'end_of_trip' }, '2026-03-18T10:00:00+01:00', BARCELONA)).toBe(
      undefined,
    );
    expect(clockTarget({ step: 'end_of_trip' }, '2026-03-20T09:00:00+01:00', BARCELONA)).toBe(
      undefined,
    );
  });

  it('exact instants (replay clock lines) only move forward', () => {
    const now = '2026-03-14T21:41:00+01:00';
    expect(clockTarget({ to: '2026-03-15T10:00:00+01:00' }, now, BARCELONA)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
    // Same instant written in another offset: rendered in the trip zone.
    expect(clockTarget({ to: '2026-03-15T09:00:00Z' }, now, BARCELONA)).toBe(
      '2026-03-15T10:00:00+01:00',
    );
    expect(clockTarget({ to: '2026-02-03T20:00:00-05:00' }, now, BARCELONA)).toBeUndefined();
    expect(clockTarget({ to: now }, now, BARCELONA)).toBeUndefined();
  });
});

describe('clockLabel', () => {
  it('matches the UI label: weekday, date, time, day number; "trip over" after the last day', () => {
    for (const at of [
      '2026-03-14T21:41:00+01:00',
      '2026-03-15T10:00:00+01:00',
      '2026-03-18T10:00:00+01:00',
      '2026-02-03T20:00:00-05:00',
    ]) {
      expect(clockLabel(at, BARCELONA)).toBe(uiClockLabel(at, BARCELONA));
    }
    expect(clockLabel('2026-03-14T21:41:00+01:00', BARCELONA)).toBe('sat mar 14 · 9:41pm · day 3');
    expect(clockLabel('2026-03-17T23:00:00+01:00', BARCELONA)).toBe('tue mar 17 · 11pm · day 6');
    expect(clockLabel('2026-03-18T10:00:00+01:00', BARCELONA)).toBe('wed mar 18 · 10am · trip over');
    // Before the trip: no day counter.
    expect(clockLabel('2026-02-04T02:00:00+01:00', BARCELONA)).toBe('wed feb 4 · 2am');
  });
});

describe('clockStatus', () => {
  const base = {
    group: BARCELONA,
    now: '2026-03-15T10:00:00+01:00',
    moved: true,
    scheduler: true,
  };

  it('says nothing when Trav posted something (the post speaks for itself)', () => {
    expect(
      clockStatus({
        ...base,
        request: { step: 'morning' },
        jobs: [job('morning_after', base.now)],
        results: [{ silent: false, note: 'scheduled:morning_after' }],
      }),
    ).toBeUndefined();
  });

  it('next morning with no Morning After job: names T-015, never invents a recap', () => {
    const s = clockStatus({ ...base, request: { step: 'morning' }, jobs: [], results: [] });
    expect(s).toBe('clock → sun mar 15 · 10am · day 4 · nothing was scheduled · no Morning After yet: the recap job lands with T-015');
  });

  it('a job that ran but is not handled yet is reported with its note', () => {
    const s = clockStatus({
      ...base,
      request: { step: 'morning' },
      jobs: [job('morning_after', base.now)],
      results: [{ silent: true, note: 'scheduled:morning_after:not_handled' }],
    });
    expect(s).toContain('1 job ran, trav stayed quiet (scheduled:morning_after:not_handled)');
    expect(s).toContain('T-015');
  });

  it('end of trip without Wrapped names T-016; already over says so and moves nothing', () => {
    expect(
      clockStatus({
        ...base,
        now: '2026-03-18T10:00:00+01:00',
        request: { step: 'end_of_trip' },
        jobs: [],
        results: [],
      }),
    ).toContain('no Wrapped yet: the Wrapped job lands with T-016');
    expect(
      clockStatus({
        ...base,
        now: '2026-03-18T10:00:00+01:00',
        moved: false,
        request: { step: 'end_of_trip' },
        jobs: [],
        results: [],
      }),
    ).toBe('the trip is already over (clock at wed mar 18 · 10am · trip over)');
  });

  it('+1 hour that expired a proposal silently still reports the job', () => {
    const s = clockStatus({
      ...base,
      request: { step: 'hour' },
      jobs: [job('proposal_expiry', base.now)],
      results: [{ silent: true, note: 'scheduled:proposal_expiry:not_pending' }],
    });
    expect(s).toContain('1 job ran');
    expect(s).not.toContain('T-015');
  });

  it('a backend without a scheduler says so', () => {
    expect(
      clockStatus({ ...base, scheduler: false, request: { step: 'hour' }, jobs: [], results: [] }),
    ).toContain('no scheduler');
  });

  it('replay clock lines stay quiet unless a job ran', () => {
    const request = { to: base.now };
    expect(clockStatus({ ...base, request, jobs: [], results: [] })).toBeUndefined();
    expect(clockStatus({ ...base, request, moved: false, jobs: [], results: [] })).toBeUndefined();
    expect(
      clockStatus({
        ...base,
        request,
        jobs: [job('proposal_expiry', base.now)],
        results: [{ silent: true, note: 'scheduled:proposal_expiry:not_pending' }],
      }),
    ).toContain('1 job ran');
  });

  it('a replay clock line that expects Morning After / Wrapped names the missing task', () => {
    const morning = clockStatus({
      ...base,
      request: { to: base.now, expectJob: 'morning_after' },
      jobs: [],
      results: [],
    });
    expect(morning).toBe(
      'clock → sun mar 15 · 10am · day 4 · nothing was scheduled · no Morning After yet: the recap job lands with T-015',
    );
    expect(
      clockStatus({
        ...base,
        now: '2026-03-18T10:00:00+01:00',
        request: { to: '2026-03-18T10:00:00+01:00', expectJob: 'wrapped' },
        jobs: [],
        results: [],
      }),
    ).toContain('T-016');
    // Once the job runs and Trav posts, the line goes away.
    expect(
      clockStatus({
        ...base,
        request: { to: base.now, expectJob: 'morning_after' },
        jobs: [job('morning_after', base.now)],
        results: [{ silent: false, note: 'scheduled:morning_after' }],
      }),
    ).toBeUndefined();
    // An expected job with no placeholder text (e.g. daily_settle) stays quiet.
    expect(
      clockStatus({ ...base, request: { to: base.now, expectJob: 'daily_settle' }, jobs: [], results: [] }),
    ).toBeUndefined();
  });

  it('status lines carry no amounts or merchants', () => {
    const s = clockStatus({ ...base, request: { step: 'morning' }, jobs: [], results: [] })!;
    expect(s).not.toMatch(/€|\$|uber/i);
  });
});
