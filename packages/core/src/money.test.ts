import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TravError } from './errors.js';
import {
  abs,
  add,
  allocate,
  allocateEqual,
  compare,
  currencyExponent,
  equals,
  formatEach,
  formatMoney,
  formatShares,
  formatTransfer,
  isNegative,
  isPositive,
  isZero,
  money,
  multiply,
  negate,
  parseDecimal,
  subtract,
  sum,
  zero,
} from './money.js';

const eur = (n: number) => money(n, 'EUR');
const jpy = (n: number) => money(n, 'JPY');
const minors = (parts: readonly { amountMinor: number }[]) => parts.map((p) => p.amountMinor);

function expectTravError(fn: () => unknown, code: TravError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TravError);
  expect((caught as TravError).code).toBe(code);
}

describe('money()', () => {
  it('builds integer minor units and normalises -0', () => {
    expect(money(1680, 'EUR')).toEqual({ amountMinor: 1680, currency: 'EUR' });
    expect(Object.is(money(-0, 'EUR').amountMinor, 0)).toBe(true);
    expect(zero('USD')).toEqual({ amountMinor: 0, currency: 'USD' });
  });

  it('rejects floats, NaN, unsafe integers and bad currency codes', () => {
    expectTravError(() => money(16.8, 'EUR'), 'invalid_argument');
    expectTravError(() => money(Number.NaN, 'EUR'), 'invalid_argument');
    expectTravError(() => money(Number.MAX_SAFE_INTEGER + 1, 'EUR'), 'invalid_argument');
    expectTravError(() => money(1, 'eur'), 'invalid_argument');
    expectTravError(() => money(1, 'EURO'), 'invalid_argument');
    expectTravError(() => money(1, ''), 'invalid_argument');
  });

  it('knows currency exponents', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('BHD')).toBe(3);
    expect(currencyExponent('XYZ')).toBe(2);
  });
});

describe('arithmetic', () => {
  it('adds, subtracts, negates and sums', () => {
    expect(add(eur(8400), eur(1680))).toEqual(eur(10080));
    expect(subtract(eur(8400), eur(1680))).toEqual(eur(6720));
    expect(subtract(eur(0), eur(1200))).toEqual(eur(-1200));
    expect(negate(eur(1200))).toEqual(eur(-1200));
    expect(negate(eur(0))).toEqual(eur(0));
    expect(abs(eur(-1200))).toEqual(eur(1200));
    expect(sum([eur(100), eur(250), eur(-50)], 'EUR')).toEqual(eur(300));
    expect(sum([], 'EUR')).toEqual(eur(0));
  });

  it('throws currency_mismatch on mixed currencies', () => {
    expectTravError(() => add(eur(1), money(1, 'USD')), 'currency_mismatch');
    expectTravError(() => subtract(eur(1), money(1, 'USD')), 'currency_mismatch');
    expectTravError(() => compare(eur(1), money(1, 'USD')), 'currency_mismatch');
    expectTravError(() => sum([eur(1), money(1, 'USD')], 'EUR'), 'currency_mismatch');
    expectTravError(() => sum([money(1, 'USD')], 'EUR'), 'currency_mismatch');
  });

  it('compares and tests sign', () => {
    expect(compare(eur(1), eur(2))).toBe(-1);
    expect(compare(eur(2), eur(1))).toBe(1);
    expect(compare(eur(2), eur(2))).toBe(0);
    expect(equals(eur(2), eur(2))).toBe(true);
    expect(equals(eur(2), money(2, 'USD'))).toBe(false);
    expect(isZero(eur(0))).toBe(true);
    expect(isNegative(eur(-1))).toBe(true);
    expect(isPositive(eur(1))).toBe(true);
    expect(isPositive(eur(0))).toBe(false);
  });

  it('multiplies by integers, decimals and rationals exactly (half away from zero)', () => {
    expect(multiply(eur(1000), 3)).toEqual(eur(3000));
    expect(multiply(eur(1000), 0)).toEqual(eur(0));
    expect(multiply(eur(1005), 0.1)).toEqual(eur(101)); // 100.5 → 101, not 100.49999…
    expect(multiply(eur(-1005), 0.1)).toEqual(eur(-101)); // half away from zero
    expect(multiply(eur(1000), 0.15)).toEqual(eur(150));
    expect(multiply(eur(1000), { num: 1, den: 3 })).toEqual(eur(333));
    expect(multiply(eur(2000), { num: 1, den: 3 })).toEqual(eur(667));
    expect(multiply(eur(100), 1.1)).toEqual(eur(110));
    expect(multiply(eur(1), 1e-7)).toEqual(eur(0));
    expect(multiply(jpy(999), 0.5)).toEqual(jpy(500));
  });

  it('rejects non-finite and malformed factors', () => {
    expectTravError(() => multiply(eur(1), Number.NaN), 'invalid_argument');
    expectTravError(() => multiply(eur(1), Number.POSITIVE_INFINITY), 'invalid_argument');
    expectTravError(() => multiply(eur(1), { num: 1, den: 0 }), 'invalid_argument');
    expectTravError(() => multiply(eur(1), { num: 1.5, den: 2 }), 'invalid_argument');
  });
});

describe('allocate / allocateEqual', () => {
  it('splits €10.00 three ways as 3.34 / 3.33 / 3.33, extra cent to the lowest index', () => {
    expect(minors(allocateEqual(eur(1000), 3))).toEqual([334, 333, 333]);
    expect(minors(allocate(eur(1000), [1, 1, 1]))).toEqual([334, 333, 333]);
  });

  it('is deterministic: the same call always yields the same parts', () => {
    const a = allocateEqual(eur(1000), 3);
    const b = allocateEqual(eur(1000), 3);
    expect(a).toEqual(b);
    expect(minors(allocateEqual(eur(1001), 3))).toEqual([334, 334, 333]);
    expect(minors(allocateEqual(eur(1002), 3))).toEqual([334, 334, 334]);
  });

  it('allocates negative totals as the mirror of positive ones', () => {
    expect(minors(allocateEqual(eur(-1000), 3))).toEqual([-334, -333, -333]);
    expect(minors(allocate(eur(-7), [2, 1]))).toEqual([-5, -2]);
  });

  it('allocates zero to everything when the total is zero', () => {
    expect(minors(allocateEqual(eur(0), 4))).toEqual([0, 0, 0, 0]);
    expect(minors(allocate(eur(0), [3, 0, 2]))).toEqual([0, 0, 0]);
  });

  it('handles JPY (0 decimals) and one part', () => {
    expect(minors(allocateEqual(jpy(1000), 3))).toEqual([334, 333, 333]);
    expect(minors(allocateEqual(jpy(1000), 1))).toEqual([1000]);
    expect(allocateEqual(jpy(1000), 1)[0]?.currency).toBe('JPY');
  });

  it('respects weights, puts remainders where the fractional part is largest, zero weights get 0', () => {
    expect(minors(allocate(eur(100), [1, 2]))).toEqual([33, 67]); // 33.33 / 66.67
    expect(minors(allocate(eur(100), [3, 0, 2]))).toEqual([60, 0, 40]);
    expect(minors(allocate(eur(1), [0, 1]))).toEqual([0, 1]);
    expect(minors(allocate(eur(1), [0, 1, 1]))).toEqual([0, 1, 0]);
    expect(minors(allocate(eur(1000), [1.5, 1]))).toEqual([600, 400]);
    expect(minors(allocate(eur(500), [1, 1, 1, 1, 1]))).toEqual([100, 100, 100, 100, 100]);
  });

  it('rejects empty, negative, non-finite and all-zero weights, and bad part counts', () => {
    expectTravError(() => allocate(eur(100), []), 'invalid_argument');
    expectTravError(() => allocate(eur(100), [1, -1]), 'invalid_argument');
    expectTravError(() => allocate(eur(100), [0, 0]), 'invalid_argument');
    expectTravError(() => allocate(eur(100), [Number.NaN]), 'invalid_argument');
    expectTravError(() => allocateEqual(eur(100), 0), 'invalid_argument');
    expectTravError(() => allocateEqual(eur(100), 2.5), 'invalid_argument');
  });

  it('property: parts sum to the total, have the right length, never differ by more than 1 for equal splits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 40 }),
        (total, parts) => {
          const out = allocateEqual(eur(total), parts);
          expect(out).toHaveLength(parts);
          expect(out.reduce((acc, m) => acc + m.amountMinor, 0)).toBe(total);
          const values = minors(out);
          expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
          // Remainder units go to the lowest indexes, so magnitudes never increase
          // left to right (negative totals mirror positive ones).
          for (let i = 1; i < values.length; i += 1) {
            expect(Math.abs(values[i - 1] ?? 0)).toBeGreaterThanOrEqual(Math.abs(values[i] ?? 0));
          }
          // And the allocation is the exact mirror of its negation.
          expect(minors(allocateEqual(eur(-total), parts))).toEqual(
            values.map((v) => (v === 0 ? 0 : -v)),
          );
        },
      ),
    );
  });

  it('property: weighted parts sum to the total and are within one unit of the exact share', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 12 })
          .filter((w) => w.some((x) => x > 0)),
        (total, weights) => {
          const out = allocate(eur(total), weights);
          expect(out.reduce((acc, m) => acc + m.amountMinor, 0)).toBe(total);
          const weightSum = weights.reduce((a, b) => a + b, 0);
          out.forEach((m, i) => {
            const exact = (total * (weights[i] ?? 0)) / weightSum;
            expect(Math.abs(m.amountMinor - exact)).toBeLessThan(1);
            if (weights[i] === 0) expect(m.amountMinor).toBe(0);
          });
        },
      ),
    );
  });
});

describe('formatMoney (VOICE §3.4)', () => {
  it('matches every VOICE example', () => {
    expect(formatMoney(eur(8400))).toBe('€84');
    expect(formatMoney(money(2340, 'USD'))).toBe('$23.40');
    expect(formatMoney(money(1200, 'GBP'))).toBe('£12');
    expect(formatMoney(eur(9000))).toBe('€90');
    expect(formatMoney(eur(1680))).toBe('€16.80');
    expect(formatMoney(eur(234000))).toBe('€2,340');
    expect(formatMoney(eur(3160))).toBe('€31.60');
    expect(formatMoney(eur(1800))).toBe('€18');
    expect(formatMoney(eur(2160))).toBe('€21.60');
    expect(formatMoney(eur(-1200))).toBe('-€12');
  });

  it('handles zero, small, large and negative fractional amounts', () => {
    expect(formatMoney(eur(0))).toBe('€0');
    expect(formatMoney(eur(5))).toBe('€0.05');
    expect(formatMoney(eur(50))).toBe('€0.50');
    expect(formatMoney(eur(123456789))).toBe('€1,234,567.89');
    expect(formatMoney(eur(-1250))).toBe('-€12.50');
    expect(formatMoney(eur(100000))).toBe('€1,000');
  });

  it('formats zero- and three-decimal currencies', () => {
    expect(formatMoney(jpy(1200))).toBe('¥1,200');
    expect(formatMoney(jpy(0))).toBe('¥0');
    expect(formatMoney(jpy(-5))).toBe('-¥5');
    expect(formatMoney(money(12345, 'BHD'))).toBe('BHD 12.345');
    expect(formatMoney(money(12000, 'BHD'))).toBe('BHD 12');
  });

  it('falls back to the ISO code with a space for unknown symbols', () => {
    expect(formatMoney(money(1200, 'CHF'))).toBe('CHF 12');
    expect(formatMoney(money(-1250, 'CHF'))).toBe('-CHF 12.50');
    expect(formatMoney(money(150000, 'SEK'))).toBe('SEK 1,500');
  });

  it('composes each / transfer / shares strings', () => {
    expect(formatEach(eur(1800))).toBe('€18 each');
    expect(formatEach(eur(1680))).toBe('€16.80 each');
    expect(formatTransfer('Chase', 'Dean', eur(3160))).toBe('Chase → Dean €31.60');
    expect(
      formatShares([
        { name: 'Dean', amount: eur(4000) },
        { name: 'Chase', amount: eur(2200) },
        { name: 'Crowley', amount: eur(2200) },
      ]),
    ).toBe('Dean €40 · Chase €22 · Crowley €22');
  });

  it('refuses to format a float amount (never a path to a money string with fractions of a cent)', () => {
    expectTravError(() => formatMoney({ amountMinor: 16.8, currency: 'EUR' }), 'invalid_argument');
  });
});

describe('parseDecimal', () => {
  it('parses decimals at the currency exponent', () => {
    expect(parseDecimal('45.00', 'EUR')).toEqual(eur(4500));
    expect(parseDecimal('45', 'EUR')).toEqual(eur(4500));
    expect(parseDecimal('0.5', 'EUR')).toEqual(eur(50));
    expect(parseDecimal('-12.5', 'USD')).toEqual(money(-1250, 'USD'));
    expect(parseDecimal(' 23.40 ', 'USD')).toEqual(money(2340, 'USD'));
    expect(parseDecimal('1200', 'JPY')).toEqual(jpy(1200));
    expect(parseDecimal('1200.0', 'JPY')).toEqual(jpy(1200));
    expect(parseDecimal('12.345', 'BHD')).toEqual(money(12345, 'BHD'));
    expect(parseDecimal('45.000', 'EUR')).toEqual(eur(4500));
  });

  it('rejects malformed text and excess precision', () => {
    expectTravError(() => parseDecimal('€45', 'EUR'), 'invalid_argument');
    expectTravError(() => parseDecimal('1,234.56', 'EUR'), 'invalid_argument');
    expectTravError(() => parseDecimal('45.005', 'EUR'), 'invalid_argument');
    expectTravError(() => parseDecimal('12.5', 'JPY'), 'invalid_argument');
    expectTravError(() => parseDecimal('', 'EUR'), 'invalid_argument');
    expectTravError(() => parseDecimal('abc', 'EUR'), 'invalid_argument');
  });

  it('property: parseDecimal(formatted plain decimal) round-trips', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), (n) => {
        const text = `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;
        expect(parseDecimal(text, 'EUR')).toEqual(eur(n));
      }),
    );
  });
});
