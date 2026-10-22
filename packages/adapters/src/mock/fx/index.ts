/**
 * Mock `FxRatesAdapter` (T-029-a) over a fixed reference table
 * (`fixtures/fx/<name>.json`). Shaped like a daily reference-rate service:
 *
 * - A date with no usable row (weekend, table holiday) resolves to the latest
 *   earlier business day; the returned `asOf` is the date actually used.
 * - "Latest" (no `on`) means the clock's current date in `timeZone`
 *   (default Europe/Berlin, where daily reference rates are fixed).
 * - Rates dated after the clock's date are never visible (no future rates).
 * - Nothing within `maxStaleDays` (default 7) of the requested date ⇒
 *   `not_found` rather than a silently stale rate.
 * - Lookup order per date: same currency ⇒ "1"; a listed pair; the inverse of a
 *   listed pair; a cross via the table's pivot currency. Computed rates use
 *   exact BigInt math rounded half-up to 6 decimals. Rates stay decimal strings.
 *
 * Two fixture shapes are accepted (auto-detected):
 * - date map: `{ base: "EUR", rates: { "2026-03-13": { "USD": "1.0840" } } }`
 * - row list: `{ rates: [{ base, quote, rate, asOf }] }` (pivot = `base` field,
 *   else EUR).
 *
 * No network, no `Date.now()`.
 */
import { TravError, addDays, daysBetween, localDate } from '@trav/core';
import type { Clock, CurrencyCode, IsoDate, TimeZone } from '@trav/core';
import type { AdapterError, AdapterInfo, Result } from '../../interfaces/common.js';
import type { FxRate, FxRatesAdapter } from '../../interfaces/context.js';
import { readRepoFixtureJson } from '../flights/fixturePath.js';

export interface MockFxTable {
  readonly source: string;
  /** Pivot currency for cross rates (the date-map shape's `base`). */
  readonly base: CurrencyCode;
  /** Ascending dates that have at least one rate. */
  readonly dates: readonly IsoDate[];
  /** date → "BASE/QUOTE" → decimal string (units of QUOTE per 1 BASE). */
  readonly pairs: ReadonlyMap<IsoDate, ReadonlyMap<string, string>>;
}

export interface MockFxOptions {
  readonly clock: Clock;
  /** Defaults to `loadMockFxTable('rates')`. */
  readonly table?: MockFxTable;
  readonly timeZone?: TimeZone;
  readonly maxStaleDays?: number;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_RE = /^\d+(?:\.\d+)?$/;
const ZERO_RE = /^0+(?:\.0+)?$/;
const COMPUTED_DECIMALS = 6;

function fail(path: string, msg: string): never {
  throw new TravError('invalid_argument', `fx fixture ${path}: ${msg}`);
}

function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  try {
    addDays(d, 0);
    return true;
  } catch {
    return false;
  }
}

const pairKey = (base: CurrencyCode, quote: CurrencyCode): string => `${base}/${quote}`;

function checkCurrency(v: unknown, path: string): CurrencyCode {
  if (typeof v !== 'string' || !CURRENCY_RE.test(v)) fail(path, 'bad currency');
  return v;
}

function checkRate(v: unknown, path: string): string {
  if (typeof v !== 'string' || !RATE_RE.test(v) || ZERO_RE.test(v)) {
    fail(path, 'rate must be a positive decimal string');
  }
  return v;
}

/** Validates a `fixtures/fx/*.json` object of either shape. Throws `TravError('invalid_argument')`. */
export function parseMockFxTable(raw: unknown): MockFxTable {
  if (typeof raw !== 'object' || raw === null) fail('$', 'expected object');
  const root = raw as Record<string, unknown>;
  const source = typeof root['source'] === 'string' ? root['source'] : 'mock-fx';
  const pairs = new Map<IsoDate, Map<string, string>>();
  const row = (date: string): Map<string, string> => {
    let r = pairs.get(date);
    if (!r) {
      r = new Map();
      pairs.set(date, r);
    }
    return r;
  };

  const rawRates = root['rates'];
  let base: CurrencyCode;
  if (Array.isArray(rawRates)) {
    base = root['base'] === undefined ? 'EUR' : checkCurrency(root['base'], '$.base');
    rawRates.forEach((r: unknown, i) => {
      const path = `$.rates[${i}]`;
      if (typeof r !== 'object' || r === null) fail(path, 'expected object');
      const o = r as Record<string, unknown>;
      const b = checkCurrency(o['base'], `${path}.base`);
      const q = checkCurrency(o['quote'], `${path}.quote`);
      const asOf = o['asOf'];
      if (typeof asOf !== 'string' || !isValidDate(asOf)) fail(`${path}.asOf`, 'bad date');
      row(asOf).set(pairKey(b, q), checkRate(o['rate'], `${path}.rate`));
    });
  } else {
    base = checkCurrency(root['base'], '$.base');
    if (typeof rawRates !== 'object' || rawRates === null) fail('$.rates', 'expected object');
    for (const [date, quotes] of Object.entries(rawRates as Record<string, unknown>)) {
      if (!isValidDate(date)) fail(`$.rates.${date}`, 'bad date');
      if (typeof quotes !== 'object' || quotes === null) fail(`$.rates.${date}`, 'expected object');
      for (const [code, value] of Object.entries(quotes as Record<string, unknown>)) {
        checkCurrency(code, `$.rates.${date}.${code}`);
        row(date).set(pairKey(base, code), checkRate(value, `$.rates.${date}.${code}`));
      }
    }
  }
  const dates = [...pairs.keys()].sort();
  if (dates.length === 0) fail('$.rates', 'empty table');
  return { source, base, dates, pairs };
}

/** Loads `fixtures/fx/<name>.json` (default `rates`). */
export function loadMockFxTable(name = 'rates'): MockFxTable {
  return parseMockFxTable(readRepoFixtureJson('fx', name));
}

// ---------- exact decimal arithmetic ----------

interface Dec {
  readonly int: bigint;
  readonly scale: number;
}

function toDec(s: string): Dec {
  const [i = '0', f = ''] = s.split('.');
  return { int: BigInt(`${i}${f}`), scale: f.length };
}

/** a / b rounded half-up to `places` decimals (a, b > 0). */
function divide(a: string, b: string, places: number): string {
  const da = toDec(a);
  const db = toDec(b);
  const num = da.int * 10n ** BigInt(db.scale + places);
  const den = db.int * 10n ** BigInt(da.scale);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  const digits = q.toString().padStart(places + 1, '0');
  return `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`;
}

function failResult<T>(code: AdapterError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

/** Rate for base→quote from one date's pairs, or undefined if not derivable. */
function rateFrom(
  pairs: ReadonlyMap<string, string>,
  pivot: CurrencyCode,
  base: CurrencyCode,
  quote: CurrencyCode,
): string | undefined {
  if (base === quote) return '1';
  const direct = pairs.get(pairKey(base, quote));
  if (direct !== undefined) return direct;
  const reverse = pairs.get(pairKey(quote, base));
  if (reverse !== undefined) return divide('1', reverse, COMPUTED_DECIMALS);
  const perPivot = (code: CurrencyCode): string | undefined => {
    if (code === pivot) return '1';
    const d = pairs.get(pairKey(pivot, code));
    if (d !== undefined) return d;
    const r = pairs.get(pairKey(code, pivot));
    return r === undefined ? undefined : divide('1', r, 12);
  };
  const b = perPivot(base);
  const q = perPivot(quote);
  if (b === undefined || q === undefined) return undefined;
  return divide(q, b, COMPUTED_DECIMALS);
}

export function createMockFxRates(options: MockFxOptions): FxRatesAdapter {
  const table = options.table ?? loadMockFxTable('rates');
  const tz = options.timeZone ?? 'Europe/Berlin';
  const maxStale = options.maxStaleDays ?? 7;
  const info: AdapterInfo = { provider: 'mock-fx', mode: 'mock' };

  return {
    info,
    getRate(base, quote, on) {
      if (!CURRENCY_RE.test(base) || !CURRENCY_RE.test(quote)) {
        return Promise.resolve(failResult('invalid_request', 'currency codes must be ISO 4217'));
      }
      if (on !== undefined && !isValidDate(on)) {
        return Promise.resolve(failResult('invalid_request', `bad date "${on}"`));
      }
      const today = localDate(options.clock.now(), tz);
      const requested = on === undefined || on > today ? today : on;
      // Latest table date ≤ requested (within the stale window) that can price the pair.
      for (let i = table.dates.length - 1; i >= 0; i -= 1) {
        const date = table.dates[i];
        if (date === undefined || date > requested) continue;
        if (daysBetween(date, requested) > maxStale) break;
        const pairs = table.pairs.get(date);
        const rate = pairs === undefined ? undefined : rateFrom(pairs, table.base, base, quote);
        if (rate !== undefined) {
          const value: FxRate = { base, quote, rate, asOf: date, source: table.source };
          return Promise.resolve({ ok: true, value });
        }
      }
      return Promise.resolve(
        failResult('not_found', `no ${base}/${quote} reference rate on or before ${requested}`),
      );
    },
  };
}
