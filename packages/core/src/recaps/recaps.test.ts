/**
 * T-015 core: the recap windows, the four night-out signals and the
 * full / quiet / silent decision, at their edges (inclusive starts, exclusive
 * ends), across a DST change, and in family mode.
 */
import { describe, expect, it } from 'vitest';
import * as recaps from './index.js';

const TZ = 'Europe/Madrid';
const MORNING = '2026-03-15T10:00:00+01:00';

function signals(over: Partial<recaps.NightSignalInput> = {}): recaps.NightSignals {
  return recaps.nightSignals({
    morning: MORNING,
    timeZone: TZ,
    expenses: [],
    bookedNightlifeStarts: [],
    photoTimes: [],
    chatTimes: [],
    ...over,
  });
}

const NONE: recaps.NightSignals = {
  nightlifeBooking: false,
  expenseAfter22: false,
  photoAfter23: false,
  chatAfterMidnight: false,
  balancesChanged: false,
};

describe('recap windows (local trip time)', () => {
  it('last night is 12:00 the day before → 06:00; yesterday 06:00 → 06:00; since-recap 10:00 → 10:00', () => {
    expect(recaps.lastNightWindow(MORNING, TZ)).toMatchObject({
      date: '2026-03-15',
      from: '2026-03-14T12:00:00+01:00',
      to: '2026-03-15T06:00:00+01:00',
    });
    expect(recaps.yesterdayWindow(MORNING, TZ)).toMatchObject({
      from: '2026-03-14T06:00:00+01:00',
      to: '2026-03-15T06:00:00+01:00',
    });
    expect(recaps.sinceLastRecapWindow(MORNING, TZ)).toMatchObject({
      from: '2026-03-14T10:00:00+01:00',
      to: '2026-03-15T10:00:00+01:00',
    });
  });

  it('inWindow: the start is in, the end is out', () => {
    const w = recaps.lastNightWindow(MORNING, TZ);
    expect(recaps.inWindow('2026-03-14T12:00:00+01:00', w)).toBe(true);
    expect(recaps.inWindow('2026-03-15T05:59:59+01:00', w)).toBe(true);
    expect(recaps.inWindow('2026-03-15T06:00:00+01:00', w)).toBe(false);
    expect(recaps.inWindow('2026-03-14T11:59:59+01:00', w)).toBe(false);
  });

  it('a DST night (Madrid springs forward on 29 mar) keeps local wall times', () => {
    const w = recaps.lastNightWindow('2026-03-29T10:00:00+02:00', TZ);
    expect(w.from).toBe('2026-03-28T12:00:00+01:00');
    expect(w.to).toBe('2026-03-29T06:00:00+02:00');
    expect(recaps.recapTime('2026-03-29', TZ)).toBe('2026-03-29T10:00:00+02:00');
  });
});

describe('night-out signals', () => {
  it('nothing happened: no signal, silent', () => {
    const s = signals();
    expect(s).toEqual(NONE);
    expect(recaps.nightSignalCount(s)).toBe(0);
    expect(recaps.decideRecapMode(s, false)).toBe('silent');
  });

  it('an expense at exactly 22:00 counts; 21:59 does not; 06:00 the next day does not', () => {
    const at = (occurredAt: string) =>
      signals({ expenses: [{ occurredAt, createdAt: occurredAt }] }).expenseAfter22;
    expect(at('2026-03-14T22:00:00+01:00')).toBe(true);
    expect(at('2026-03-14T21:59:00+01:00')).toBe(false);
    expect(at('2026-03-15T05:59:00+01:00')).toBe(true);
    expect(at('2026-03-15T06:00:00+01:00')).toBe(false);
  });

  it('photos count from 23:00, chat from 00:00, a nightlife booking anywhere in last night', () => {
    expect(signals({ photoTimes: ['2026-03-14T22:59:00+01:00'] }).photoAfter23).toBe(false);
    expect(signals({ photoTimes: ['2026-03-14T23:00:00+01:00'] }).photoAfter23).toBe(true);
    expect(signals({ chatTimes: ['2026-03-14T23:59:00+01:00'] }).chatAfterMidnight).toBe(false);
    expect(signals({ chatTimes: ['2026-03-15T00:00:00+01:00'] }).chatAfterMidnight).toBe(true);
    expect(signals({ bookedNightlifeStarts: ['2026-03-15T00:00:00+01:00'] }).nightlifeBooking).toBe(
      true,
    );
    // Tonight's booking is tomorrow's recap.
    expect(signals({ bookedNightlifeStarts: ['2026-03-15T23:00:00+01:00'] }).nightlifeBooking).toBe(
      false,
    );
  });

  it('balances changed: an expense logged since the last recap, whenever it happened', () => {
    const s = signals({
      expenses: [
        { occurredAt: '2026-03-13T11:40:00+01:00', createdAt: '2026-03-15T08:40:00+01:00' },
      ],
    });
    expect(s.balancesChanged).toBe(true);
    expect(s.expenseAfter22).toBe(false);
    expect(recaps.decideRecapMode(s, false)).toBe('quiet');
    // Logged before yesterday's recap: already reported.
    expect(
      signals({
        expenses: [
          { occurredAt: '2026-03-14T09:00:00+01:00', createdAt: '2026-03-14T09:30:00+01:00' },
        ],
      }).balancesChanged,
    ).toBe(false);
  });

  it('one signal is not a night out; two are; family mode is never a night out', () => {
    const one: recaps.NightSignals = { ...NONE, chatAfterMidnight: true, balancesChanged: true };
    expect(recaps.decideRecapMode(one, false)).toBe('quiet');
    const two: recaps.NightSignals = { ...one, photoAfter23: true };
    expect(recaps.nightSignalCount(two)).toBe(recaps.NIGHT_OUT_MIN_SIGNALS);
    expect(recaps.decideRecapMode(two, false)).toBe('full');
    const all: recaps.NightSignals = {
      nightlifeBooking: true,
      expenseAfter22: true,
      photoAfter23: true,
      chatAfterMidnight: true,
      balancesChanged: true,
    };
    expect(recaps.decideRecapMode(all, true)).toBe('quiet');
    expect(recaps.decideRecapMode({ ...all, balancesChanged: false }, true)).toBe('silent');
    // Two signals but the tab never moved: still a full recap (the night happened).
    expect(recaps.decideRecapMode({ ...two, balancesChanged: false }, false)).toBe('full');
  });
});

describe('recap mornings', () => {
  it('the mornings after each trip night, not the first morning, the last day included', () => {
    expect(recaps.recapMornings({ startDate: '2026-03-12', endDate: '2026-03-17' })).toEqual([
      '2026-03-13',
      '2026-03-14',
      '2026-03-15',
      '2026-03-16',
      '2026-03-17',
    ]);
    expect(recaps.recapMornings({ startDate: '2026-03-12', endDate: '2026-03-12' })).toEqual([]);
  });

  it('recapTime is 10:00 in the trip zone', () => {
    expect(recaps.recapTime('2026-06-24', 'America/Grand_Turk')).toBe('2026-06-24T10:00:00-04:00');
  });
});
