import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TravError, createSimulatedClock, fixedClock } from '@trav/core';
import type { Result } from '../../interfaces/common.js';
import type { FxRate } from '../../interfaces/context.js';
import { readRepoFixtureJson } from '../flights/fixturePath.js';
import { createMockFxRates, loadMockFxTable, parseMockFxTable } from './index.js';

/**
 * Pinned-value tests use the T-029-a-owned table (`reference-table.json`) so
 * they hold whatever shape the shared `rates.json` has.
 */
const raw = readRepoFixtureJson('fx', 'reference-table') as {
  base: string;
  rates: Record<string, Record<string, string>>;
};
const table = loadMockFxTable('reference-table');
const rateOn = (date: string, code: string): string => {
  const v = raw.rates[date]?.[code];
  if (v === undefined) throw new Error(`fixture has no ${code} on ${date}`);
  return v;
};

function unwrap(r: Result<FxRate>): FxRate {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}
function code(r: Result<FxRate>): string {
  if (r.ok) throw new Error('expected error');
  return r.error.code;
}

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network access attempted in a mock adapter test');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// Saturday night of the Barcelona trip.
const SAT = '2026-03-14T21:40:00+01:00';

interface Label {
  query: { base: string; quote: string; on: string };
  expectAsOf?: string;
  expectRate?: string;
  expectError?: string;
}

describe('fixtures', () => {
  it.each(['rates', 'reference-table'])(
    '%s.json: business days only, weekend lookups resolve to Friday',
    async (name) => {
      const t = loadMockFxTable(name);
      expect(t.base).toBe('EUR');
      for (const d of t.dates) {
        const day = new Date(`${d}T12:00:00Z`).getUTCDay();
        expect(day === 0 || day === 6, d).toBe(false);
      }
      expect(t.pairs.has('2026-04-03')).toBe(false);
      expect(t.pairs.has('2026-04-06')).toBe(false);
      const fx = createMockFxRates({ table: t, clock: fixedClock(SAT) });
      expect(unwrap(await fx.getRate('EUR', 'USD', '2026-03-14')).asOf).toBe('2026-03-13');
    },
  );

  it.each(['rates', 'reference-table'])('%s.json: every labeled query matches', async (name) => {
    const labels = (readRepoFixtureJson('fx', name) as { labels?: Label[] }).labels ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(3);
    const fx = createMockFxRates({
      table: loadMockFxTable(name),
      clock: fixedClock('2026-12-31T12:00:00+01:00'),
      maxStaleDays: 7,
    });
    for (const l of labels) {
      const r = await fx.getRate(l.query.base, l.query.quote, l.query.on);
      if (l.expectError !== undefined) {
        expect(code(r), JSON.stringify(l.query)).toBe(l.expectError);
      } else {
        expect(unwrap(r), JSON.stringify(l.query)).toMatchObject({
          asOf: l.expectAsOf,
          rate: l.expectRate,
        });
      }
    }
  });
});

describe('mock FX getRate', () => {
  it('weekend ⇒ previous business day, and returns the rate date used', async () => {
    const fx = createMockFxRates({ table, clock: fixedClock(SAT) });
    expect(fx.info).toEqual({ provider: 'mock-fx', mode: 'mock' });
    const latest = unwrap(await fx.getRate('EUR', 'USD'));
    expect(latest).toEqual({
      base: 'EUR',
      quote: 'USD',
      rate: rateOn('2026-03-13', 'USD'),
      asOf: '2026-03-13',
      source: 'mock-fx',
    });
    expect(unwrap(await fx.getRate('EUR', 'USD', '2026-03-15')).asOf).toBe('2026-03-13');
    expect(unwrap(await fx.getRate('EUR', 'USD', '2026-03-14')).asOf).toBe('2026-03-13');
    const weekday = unwrap(await fx.getRate('EUR', 'GBP', '2026-03-11'));
    expect(weekday).toMatchObject({ asOf: '2026-03-11', rate: rateOn('2026-03-11', 'GBP') });
  });

  it('holidays fall back too (Good Friday + Easter Monday ⇒ Thursday)', async () => {
    const fx = createMockFxRates({ table, clock: fixedClock('2026-04-07T09:00:00+02:00') });
    expect(unwrap(await fx.getRate('EUR', 'USD', '2026-04-06')).asOf).toBe('2026-04-02');
    expect(unwrap(await fx.getRate('EUR', 'USD', '2026-04-04')).asOf).toBe('2026-04-02');
    expect(unwrap(await fx.getRate('EUR', 'USD')).asOf).toBe('2026-04-07');
  });

  it('never reveals rates dated after the clock', async () => {
    const clock = createSimulatedClock(SAT);
    const fx = createMockFxRates({ table, clock });
    expect(unwrap(await fx.getRate('EUR', 'USD', '2026-03-20')).asOf).toBe('2026-03-13');
    clock.nextMorning('Europe/Madrid', 9); // Sunday
    clock.nextMorning('Europe/Madrid', 9); // Monday
    expect(unwrap(await fx.getRate('EUR', 'USD', '2026-03-20')).asOf).toBe('2026-03-16');
  });

  it('"latest" uses the reference time zone, not UTC', async () => {
    // 23:30 UTC Sunday is already Monday in Berlin.
    const fx = createMockFxRates({ table, clock: fixedClock('2026-03-15T23:30:00Z') });
    expect(unwrap(await fx.getRate('EUR', 'USD')).asOf).toBe('2026-03-16');
    const utc = createMockFxRates({
      table,
      clock: fixedClock('2026-03-15T23:30:00Z'),
      timeZone: 'UTC',
    });
    expect(unwrap(await utc.getRate('EUR', 'USD')).asOf).toBe('2026-03-13');
  });

  it('computes inverse and cross rates exactly, rounded half-up to 6 decimals', async () => {
    const fx = createMockFxRates({ table, clock: fixedClock(SAT) });
    const usd = rateOn('2026-03-13', 'USD');
    const gbp = rateOn('2026-03-13', 'GBP');
    const div = (a: string, b: string): string => {
      // Independent reference: scale to 1e12 with integer math, then round to 6 dp.
      const scale = (s: string): bigint => {
        const [i = '0', f = ''] = s.split('.');
        return BigInt(i + f.padEnd(12, '0').slice(0, 12));
      };
      const q = (scale(a) * 10n ** 7n) / scale(b); // 7 dp, truncated
      const rounded = (q + 5n) / 10n;
      const str = rounded.toString().padStart(7, '0');
      return `${str.slice(0, -6)}.${str.slice(-6)}`;
    };
    const inv = unwrap(await fx.getRate('USD', 'EUR'));
    expect(inv.rate).toBe(div('1', usd));
    expect(inv).toMatchObject({ base: 'USD', quote: 'EUR', asOf: '2026-03-13' });
    const cross = unwrap(await fx.getRate('USD', 'GBP'));
    expect(cross.rate).toBe(div(gbp, usd));
    expect(cross.rate).toMatch(/^\d+\.\d{6}$/);
    expect(unwrap(await fx.getRate('USD', 'USD')).rate).toBe('1');
    expect(unwrap(await fx.getRate('EUR', 'JPY')).rate).toBe(rateOn('2026-03-13', 'JPY'));
  });

  it('errors: bad codes or dates ⇒ invalid_request; unknown currency, too early, or stale ⇒ not_found', async () => {
    const fx = createMockFxRates({ table, clock: fixedClock(SAT) });
    expect(code(await fx.getRate('usd', 'EUR'))).toBe('invalid_request');
    expect(code(await fx.getRate('EUR', 'USD', '2026-02-30'))).toBe('invalid_request');
    expect(code(await fx.getRate('EUR', 'USD', '14/03/2026'))).toBe('invalid_request');
    expect(code(await fx.getRate('EUR', 'XYZ'))).toBe('not_found');
    expect(code(await fx.getRate('EUR', 'USD', '2026-01-15'))).toBe('not_found');

    const late = createMockFxRates({ table, clock: fixedClock('2026-05-20T12:00:00+02:00') });
    expect(code(await late.getRate('EUR', 'USD'))).toBe('not_found');
    const longWeekend = createMockFxRates({
      table,
      clock: fixedClock('2026-05-03T12:00:00+02:00'),
    });
    expect(unwrap(await longWeekend.getRate('EUR', 'USD')).asOf).toBe('2026-04-30');
  });

  it('parseMockFxTable rejects bad tables', () => {
    expect(() => parseMockFxTable({ base: 'EUR', rates: {} })).toThrow(TravError);
    expect(() =>
      parseMockFxTable({ base: 'eur', rates: { '2026-03-13': { USD: '1.1' } } }),
    ).toThrow(TravError);
    expect(() =>
      parseMockFxTable({ base: 'EUR', rates: { '2026-02-30': { USD: '1.1' } } }),
    ).toThrow(TravError);
    expect(() => parseMockFxTable({ base: 'EUR', rates: { '2026-03-13': { USD: 1.1 } } })).toThrow(
      TravError,
    );
    expect(() =>
      parseMockFxTable({ base: 'EUR', rates: { '2026-03-13': { USD: '0.0' } } }),
    ).toThrow(TravError);
    expect(() =>
      parseMockFxTable({ base: 'EUR', rates: { '2026-03-13': { USD: '-1.1' } } }),
    ).toThrow(TravError);
    const ok = parseMockFxTable({ base: 'EUR', rates: { '2026-03-13': { USD: '1.1' } } });
    expect(ok.source).toBe('mock-fx');
    expect(() =>
      parseMockFxTable({ rates: [{ base: 'EUR', quote: 'USD', rate: '1.1', asOf: '2026-3-13' }] }),
    ).toThrow(TravError);
  });

  it('row-list shape: listed pairs win (both directions), weekend fallback, missing pair ⇒ not_found', async () => {
    const listTable = parseMockFxTable({
      source: 'fixture-ecb-like',
      rates: [
        { base: 'EUR', quote: 'USD', rate: '1.0850', asOf: '2026-03-12' },
        { base: 'USD', quote: 'EUR', rate: '0.9217', asOf: '2026-03-12' },
        { base: 'EUR', quote: 'USD', rate: '1.0861', asOf: '2026-03-13' },
        { base: 'USD', quote: 'EUR', rate: '0.9207', asOf: '2026-03-13' },
        { base: 'EUR', quote: 'CHF', rate: '0.9400', asOf: '2026-03-12' },
      ],
    });
    const fx = createMockFxRates({ table: listTable, clock: fixedClock(SAT) });
    expect(unwrap(await fx.getRate('USD', 'EUR', '2026-03-14'))).toEqual({
      base: 'USD',
      quote: 'EUR',
      rate: '0.9207',
      asOf: '2026-03-13',
      source: 'fixture-ecb-like',
    });
    expect(code(await fx.getRate('USD', 'GBP', '2026-03-12'))).toBe('not_found');
    // CHF only exists on the 12th: the lookup walks back past the 13th for that pair.
    expect(unwrap(await fx.getRate('EUR', 'CHF'))).toMatchObject({
      rate: '0.9400',
      asOf: '2026-03-12',
    });
    // Cross via the EUR pivot: CHF per USD on the 12th = 0.94 / 1.085.
    expect(unwrap(await fx.getRate('USD', 'CHF', '2026-03-12')).rate).toBe('0.866359');
  });
});
