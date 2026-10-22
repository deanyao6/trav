import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  createSimulatedClock,
  createSystemClock,
  daysBetween,
  fixedClock,
  formatClockTime,
  formatDate,
  formatIso,
  formatTime,
  isAfter,
  localDate,
  localHour,
  parseIso,
  tripDayNumber,
  zoneOffsetMinutes,
  zonedWallTimeToMs,
} from './clock.js';
import { TravError } from './errors.js';

const MADRID = 'Europe/Madrid';
const GRAND_TURK = 'America/Grand_Turk';
const HOUR = 3_600_000;

describe('parseIso / formatIso', () => {
  it('parses offsets and Z, and formats back at the same offset', () => {
    expect(parseIso('2026-03-14T21:40:00+01:00')).toBe(Date.UTC(2026, 2, 14, 20, 40));
    expect(parseIso('2026-03-14T20:40:00Z')).toBe(Date.UTC(2026, 2, 14, 20, 40));
    expect(formatIso(Date.UTC(2026, 2, 14, 20, 40), 60)).toBe('2026-03-14T21:40:00+01:00');
    expect(formatIso(Date.UTC(2026, 2, 14, 20, 40), 0)).toBe('2026-03-14T20:40:00Z');
    expect(formatIso(Date.UTC(2026, 2, 14, 20, 40, 1, 250), -240)).toBe(
      '2026-03-14T16:40:01.250-04:00',
    );
  });

  it('rejects naive and malformed strings', () => {
    expect(() => parseIso('2026-03-14T21:40:00')).toThrow(TravError);
    expect(() => parseIso('not a date Z')).toThrow(TravError);
    expect(() => parseIso('2026-13-40T00:00:00Z')).toThrow(TravError);
  });
});

describe('createSimulatedClock', () => {
  it('starts where told, reports the same instant, and moves only when advanced', () => {
    const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
    expect(clock.now()).toBe('2026-03-14T21:40:00+01:00');
    expect(clock.nowMs()).toBe(Date.UTC(2026, 2, 14, 20, 40));
    expect(clock.now()).toBe('2026-03-14T21:40:00+01:00');
    clock.advanceHours(1);
    expect(clock.now()).toBe('2026-03-14T22:40:00+01:00');
    clock.advanceHours(2.5);
    expect(clock.now()).toBe('2026-03-15T01:10:00+01:00');
    clock.advanceMs(30_000);
    expect(clock.now()).toBe('2026-03-15T01:10:30+01:00');
    clock.set('2026-03-20T09:00:00-04:00');
    expect(clock.now()).toBe('2026-03-20T09:00:00-04:00');
  });

  it('rejects negative or non-finite advances', () => {
    const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
    expect(() => clock.advanceHours(-1)).toThrow(TravError);
    expect(() => clock.advanceMs(Number.NaN)).toThrow(TravError);
    expect(() => clock.nextMorning(MADRID, 24)).toThrow(TravError);
  });

  it('nextMorning jumps to 10:00 local the next calendar day (default hour)', () => {
    const clock = createSimulatedClock('2026-03-14T21:40:00+01:00');
    clock.nextMorning(MADRID);
    expect(clock.now()).toBe('2026-03-15T10:00:00+01:00');
    expect(localHour(clock.now(), MADRID)).toBe(10);
    clock.nextMorning(MADRID, 8);
    expect(clock.now()).toBe('2026-03-16T08:00:00+01:00');
  });

  it('nextMorning uses the calendar day in the given zone, not in the ISO offset', () => {
    // 23:30 in Madrid on the 14th is 18:30 in Grand Turk on the 14th: next morning there is the 15th.
    const clock = createSimulatedClock('2026-03-14T23:30:00+01:00');
    clock.nextMorning(GRAND_TURK);
    expect(clock.now()).toBe('2026-03-15T10:00:00-04:00');
    // 02:00 Madrid on the 15th is still the 14th in Grand Turk, so next morning is still the 15th.
    const late = createSimulatedClock('2026-03-15T02:00:00+01:00');
    late.nextMorning(GRAND_TURK);
    expect(late.now()).toBe('2026-03-15T10:00:00-04:00');
    // but in Madrid it's already the 15th, so next morning is the 16th.
    const madrid = createSimulatedClock('2026-03-15T02:00:00+01:00');
    madrid.nextMorning(MADRID);
    expect(madrid.now()).toBe('2026-03-16T10:00:00+01:00');
  });

  it('nextMorning crosses the Europe/Madrid spring-forward (2026-03-29) correctly', () => {
    const clock = createSimulatedClock('2026-03-28T23:00:00+01:00');
    const before = clock.nowMs();
    clock.nextMorning(MADRID);
    expect(clock.now()).toBe('2026-03-29T10:00:00+02:00');
    expect(localHour(clock.now(), MADRID)).toBe(10);
    expect(localDate(clock.now(), MADRID)).toBe('2026-03-29');
    // 23:00 CET → 10:00 CEST is only 10 real hours, not 11.
    expect(clock.nowMs() - before).toBe(10 * HOUR);
  });

  it('nextMorning crosses the Europe/Madrid fall-back (2026-10-25) correctly', () => {
    const clock = createSimulatedClock('2026-10-24T23:00:00+02:00');
    const before = clock.nowMs();
    clock.nextMorning(MADRID);
    expect(clock.now()).toBe('2026-10-25T10:00:00+01:00');
    expect(clock.nowMs() - before).toBe(12 * HOUR);
  });

  it('nextMorning crosses the America/Grand_Turk spring-forward (2026-03-08) correctly', () => {
    const clock = createSimulatedClock('2026-03-07T22:00:00-05:00');
    const before = clock.nowMs();
    clock.nextMorning(GRAND_TURK);
    expect(clock.now()).toBe('2026-03-08T10:00:00-04:00');
    expect(clock.nowMs() - before).toBe(11 * HOUR);
  });

  it('advanceHours keeps the written offset even across DST (helpers use the zone, not the offset)', () => {
    const clock = createSimulatedClock('2026-03-29T01:30:00+01:00');
    clock.advanceHours(1);
    expect(clock.now()).toBe('2026-03-29T02:30:00+01:00');
    expect(localHour(clock.now(), MADRID)).toBe(3); // 02:30 CET is 03:30 CEST
  });
});

describe('fixedClock / createSystemClock', () => {
  it('fixedClock never moves', () => {
    const clock = fixedClock('2026-03-14T21:40:00+01:00');
    expect(clock.now()).toBe('2026-03-14T21:40:00+01:00');
    expect(clock.nowMs()).toBe(Date.UTC(2026, 2, 14, 20, 40));
  });

  it('createSystemClock returns a parseable instant consistent with nowMs', () => {
    const clock = createSystemClock();
    const iso = clock.now();
    expect(Math.abs(parseIso(iso) - clock.nowMs())).toBeLessThan(5_000);
  });
});

describe('localDate / localHour', () => {
  it('resolves the calendar date and hour in Europe/Madrid and America/Grand_Turk', () => {
    const iso = '2026-03-14T23:00:00Z';
    expect(localDate(iso, MADRID)).toBe('2026-03-15');
    expect(localHour(iso, MADRID)).toBe(0);
    expect(localDate(iso, GRAND_TURK)).toBe('2026-03-14');
    expect(localHour(iso, GRAND_TURK)).toBe(19);
    expect(localDate('2026-01-15T03:30:00Z', GRAND_TURK)).toBe('2026-01-14');
    expect(localHour('2026-01-15T03:30:00Z', GRAND_TURK)).toBe(22);
  });

  it('reads the offset-carrying input correctly regardless of its own offset', () => {
    expect(localDate('2026-03-14T20:00:00-04:00', MADRID)).toBe('2026-03-15');
    expect(localHour('2026-03-14T20:00:00-04:00', MADRID)).toBe(1);
  });

  it('rejects unknown zones', () => {
    expect(() => localDate('2026-03-14T23:00:00Z', 'Mars/Olympus')).toThrow(TravError);
  });

  it('zoneOffsetMinutes reflects DST', () => {
    expect(zoneOffsetMinutes(Date.UTC(2026, 0, 15), MADRID)).toBe(60);
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 15), MADRID)).toBe(120);
    expect(zoneOffsetMinutes(Date.UTC(2026, 0, 15), GRAND_TURK)).toBe(-300);
    expect(zoneOffsetMinutes(Date.UTC(2026, 6, 15), GRAND_TURK)).toBe(-240);
  });

  it('zonedWallTimeToMs resolves a DST gap forward', () => {
    // 02:30 on 2026-03-29 does not exist in Madrid; resolve to a real instant at or after it.
    const ms = zonedWallTimeToMs('2026-03-29', 2, 30, MADRID);
    expect(ms).toBeGreaterThanOrEqual(Date.UTC(2026, 2, 29, 1, 0));
    expect(localDate(formatIso(ms, 0), MADRID)).toBe('2026-03-29');
  });
});

describe('tripDayNumber', () => {
  const start = '2026-03-13';

  it('is 1-based from the trip start in trip time, 0 before the trip', () => {
    expect(tripDayNumber('2026-03-13T08:00:00+01:00', start, MADRID)).toBe(1);
    expect(tripDayNumber('2026-03-14T23:00:00Z', start, MADRID)).toBe(3); // 00:00 on the 15th
    expect(tripDayNumber('2026-03-14T23:00:00Z', start, GRAND_TURK)).toBe(2);
    expect(tripDayNumber('2026-03-12T23:59:00+01:00', start, MADRID)).toBe(0);
    expect(tripDayNumber('2026-03-12T23:30:00Z', start, MADRID)).toBe(1); // 00:30 on the 13th
    expect(tripDayNumber('2026-03-01T12:00:00Z', start, MADRID)).toBe(0);
  });

  it('counts calendar days across the Madrid DST change, not 24h blocks', () => {
    expect(tripDayNumber('2026-03-29T10:00:00+02:00', '2026-03-28', MADRID)).toBe(2);
    expect(tripDayNumber('2026-03-30T00:30:00+02:00', '2026-03-28', MADRID)).toBe(3);
  });

  it('rejects a malformed trip start', () => {
    expect(() => tripDayNumber('2026-03-14T23:00:00Z', '3/13/2026', MADRID)).toThrow(TravError);
    expect(() => tripDayNumber('2026-03-14T23:00:00Z', '2026-02-30', MADRID)).toThrow(TravError);
  });
});

describe('formatTime (VOICE §3.9)', () => {
  it('renders lowercase 12-hour times without leading zeros, dropping :00', () => {
    expect(formatClockTime('2026-03-14T21:30:00+01:00', MADRID)).toBe('9:30pm');
    expect(formatClockTime('2026-03-15T00:00:00+01:00', MADRID)).toBe('12am');
    expect(formatClockTime('2026-03-15T02:14:00+01:00', MADRID)).toBe('2:14am');
    expect(formatClockTime('2026-03-15T12:00:00+01:00', MADRID)).toBe('12pm');
    expect(formatClockTime('2026-03-15T12:05:00+01:00', MADRID)).toBe('12:05pm');
    expect(formatClockTime('2026-03-15T09:00:00+01:00', MADRID)).toBe('9am');
    expect(formatTime('2026-03-14T21:30:00+01:00', MADRID)).toBe('9:30pm');
    expect(formatTime('2026-03-14T21:30:00+01:00', GRAND_TURK)).toBe('4:30pm');
  });

  it('formats dates as `sat mar 14`', () => {
    expect(formatDate('2026-03-14T21:30:00+01:00', MADRID)).toBe('sat mar 14');
    expect(formatDate('2026-03-14T23:30:00+01:00', GRAND_TURK)).toBe('sat mar 14');
    expect(formatDate('2026-03-15T00:30:00+01:00', MADRID)).toBe('sun mar 15');
    expect(formatDate('2026-07-04T12:00:00Z', GRAND_TURK)).toBe('sat jul 4');
  });

  it('uses tonight / last night / tomorrow within 48h of relativeTo', () => {
    const morning = '2026-03-15T10:00:00+01:00'; // Morning After, day after the Razzmatazz night
    expect(formatTime('2026-03-15T02:14:00+01:00', MADRID, morning)).toBe('last night 2:14am');
    expect(formatTime('2026-03-14T21:30:00+01:00', MADRID, morning)).toBe('last night 9:30pm');
    expect(formatTime('2026-03-15T21:30:00+01:00', MADRID, morning)).toBe('tonight 9:30pm');
    expect(formatTime('2026-03-16T01:00:00+01:00', MADRID, morning)).toBe('tonight 1am');
    expect(formatTime('2026-03-16T21:30:00+01:00', MADRID, morning)).toBe('tomorrow night 9:30pm');
    expect(formatTime('2026-03-15T14:00:00+01:00', MADRID, morning)).toBe('2pm');
    expect(formatTime('2026-03-16T14:00:00+01:00', MADRID, morning)).toBe('tomorrow 2pm');
    expect(formatTime('2026-03-14T14:00:00+01:00', MADRID, morning)).toBe('yesterday 2pm');
  });

  it('late at night, "tonight" still means the evening that started yesterday', () => {
    const lateNight = '2026-03-15T01:30:00+01:00';
    expect(formatTime('2026-03-14T21:30:00+01:00', MADRID, lateNight)).toBe('tonight 9:30pm');
    expect(formatTime('2026-03-15T21:30:00+01:00', MADRID, lateNight)).toBe(
      'tomorrow night 9:30pm',
    );
  });

  it('falls back to the date beyond 48h or outside the adjacent days', () => {
    const now = '2026-03-15T10:00:00+01:00';
    expect(formatTime('2026-03-20T21:30:00+01:00', MADRID, now)).toBe('fri mar 20 9:30pm');
    expect(formatTime('2026-03-13T09:00:00+01:00', MADRID, now)).toBe('fri mar 13 9am');
    expect(formatTime('2026-03-17T09:30:00+01:00', MADRID, now)).toBe('tue mar 17 9:30am');
  });

  it('relative words follow the zone (Grand Turk evening vs Madrid morning)', () => {
    const now = '2026-03-15T10:00:00-04:00';
    expect(formatTime('2026-03-15T23:00:00+01:00', GRAND_TURK, now)).toBe('tonight 6pm');
  });
});

describe('addMinutes / isAfter / date arithmetic', () => {
  it('adds minutes preserving the written offset', () => {
    expect(addMinutes('2026-03-14T23:50:00+01:00', 20)).toBe('2026-03-15T00:10:00+01:00');
    expect(addMinutes('2026-03-14T23:50:00Z', -60)).toBe('2026-03-14T22:50:00Z');
    expect(addMinutes('2026-03-14T23:50:00-04:00', 0)).toBe('2026-03-14T23:50:00-04:00');
    expect(() => addMinutes('2026-03-14T23:50:00Z', Number.NaN)).toThrow(TravError);
  });

  it('compares instants across offsets', () => {
    expect(isAfter('2026-03-14T23:00:00+01:00', '2026-03-14T22:30:00Z')).toBe(false);
    expect(isAfter('2026-03-14T23:00:00+01:00', '2026-03-14T21:30:00Z')).toBe(true);
    expect(isAfter('2026-03-14T23:00:00+01:00', '2026-03-14T22:00:00Z')).toBe(false);
  });

  it('daysBetween and addDays work on calendar dates', () => {
    expect(daysBetween('2026-03-13', '2026-03-15')).toBe(2);
    expect(daysBetween('2026-03-15', '2026-03-13')).toBe(-2);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
