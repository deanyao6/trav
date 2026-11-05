/**
 * Currency conversion at a stated reference rate (T-084). Pure and exact:
 * BigInt math on the rate's decimal string, never floats.
 *
 * Rate convention (same as `Expense.original.rate` and `fixtures/fx/rates.json`):
 * `rate` is units of the ORIGINAL currency per 1 unit of the TARGET (trip)
 * currency, e.g. "1.0928" = 1.0928 USD per 1 EUR. So `$36 → €` is
 * `36 / 1.0928 = €32.94`. Keeping the table's own number (no inverse) means no
 * second rounding.
 *
 * Rounding: half away from zero to the target currency's minor unit, so the
 * same amount, rate and currencies always give the same minor units.
 */
import { TravError } from './errors.js';
import { allocate, currencyExponent, money } from './money.js';
import type { Money } from './money.js';
import type { CurrencyCode } from './primitives.js';

const RATE_RE = /^\d+(?:\.\d+)?$/;

/** A rate and where it came from, as recorded on an expense. */
export interface FxQuote {
  /** Units of the original currency per 1 unit of the trip currency (decimal string). */
  readonly rate: string;
  /** The table date the rate is for (a weekend falls back to the previous business day). */
  readonly rateDate: string;
  /** Who published it, e.g. `mock-fx`. */
  readonly source: string;
}

function parseRate(rate: string): { readonly num: bigint; readonly scale: number } {
  if (!RATE_RE.test(rate) || !/[1-9]/.test(rate)) {
    throw new TravError(
      'invalid_argument',
      `fx rate must be a positive decimal string, got "${rate}"`,
    );
  }
  const [i = '0', f = ''] = rate.split('.');
  return { num: BigInt(`${i}${f}`), scale: f.length };
}

/**
 * `amount` (in its own currency) converted to `to` at `rate` (units of
 * `amount.currency` per 1 `to`). Same currency ⇒ the amount unchanged (the
 * rate must then be "1"). Throws `invalid_argument` on a bad rate.
 */
export function convertMoney(amount: Money, to: CurrencyCode, rate: string): Money {
  const r = parseRate(rate);
  if (amount.currency === to) {
    if (r.num !== 10n ** BigInt(r.scale)) {
      throw new TravError('invalid_argument', 'fx rate between one currency and itself must be 1');
    }
    return amount;
  }
  const fromExp = currencyExponent(amount.currency);
  const toExp = currencyExponent(to);
  // minor_to = minor_from × 10^toExp / (rate × 10^fromExp), rate = num / 10^scale
  let num = BigInt(amount.amountMinor) * 10n ** BigInt(toExp + r.scale);
  const den = r.num * 10n ** BigInt(fromExp);
  const negative = num < 0n;
  if (negative) num = -num;
  const q = num / den;
  const rounded = (num % den) * 2n >= den ? q + 1n : q;
  const out = negative ? -rounded : rounded;
  if (out > BigInt(Number.MAX_SAFE_INTEGER) || out < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TravError('invalid_argument', 'convertMoney: result overflows safe integer range');
  }
  return money(Number(out), to);
}

/**
 * Parts of an original-currency amount carried over to an already converted
 * total, so they sum EXACTLY to it: `convertedTotal` is allocated in
 * proportion to the original parts (largest remainder, ties to the lowest
 * index; see `money.allocate`). Used for fixed shares and line items.
 * Every part must be ≥ 0 and at least one positive.
 */
export function convertParts(parts: readonly Money[], convertedTotal: Money): Money[] {
  if (parts.length === 0) return [];
  for (const p of parts) {
    if (p.amountMinor < 0) {
      throw new TravError('invalid_argument', 'convertParts: parts must be >= 0');
    }
  }
  return allocate(
    convertedTotal,
    parts.map((p) => p.amountMinor),
  );
}
