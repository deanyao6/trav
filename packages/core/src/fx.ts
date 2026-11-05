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
import type { LineItem, SplitSpec } from './domain/expense.js';

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

/**
 * A split stated in the original currency carried over to the converted total
 * (T-084, T-156): fixed shares and line items by `convertParts`, so they sum
 * exactly to `convertedTotal`; equal, exclude and weighted splits carry no
 * money and come back unchanged.
 */
export function convertSplit(split: SplitSpec, convertedTotal: Money): SplitSpec {
  if (split.method === 'exact') {
    const parts = convertParts(
      split.amounts.map((a) => a.amount),
      convertedTotal,
    );
    return {
      method: 'exact',
      amounts: split.amounts.map((a, i) => ({ memberId: a.memberId, amount: parts[i]! })),
    };
  }
  if (split.method === 'itemized') {
    return { ...split, lineItems: convertLineItems(split.lineItems, convertedTotal) };
  }
  return split;
}

/**
 * Line items carried over so their SIGNED total (discounts subtract, whatever
 * sign is stored; see `ledger/splits.ts` `lineContribution`) equals
 * `convertedTotal` exactly. The positive lines' sum P is scaled by
 * converted / original total (half away from zero) to P'; the discounts get
 * D' = P' − converted. Each group is then spread over its own lines in
 * proportion (largest remainder), and every line keeps the sign it was stored
 * with. Throws `invalid_argument` when the original signed total is not
 * positive (nothing to scale from).
 */
function convertLineItems(lines: readonly LineItem[], convertedTotal: Money): LineItem[] {
  const isDiscount = (l: LineItem): boolean => l.kind === 'discount';
  const mag = (l: LineItem): bigint => BigInt(Math.abs(l.amount.amountMinor));
  const pos = lines.filter((l) => !isDiscount(l)).reduce((a, l) => a + mag(l), 0n);
  const disc = lines.filter(isDiscount).reduce((a, l) => a + mag(l), 0n);
  const original = pos - disc;
  if (original <= 0n) {
    throw new TravError('invalid_argument', 'convertSplit: line items must total more than zero');
  }
  const target = BigInt(convertedTotal.amountMinor);
  // P' = round(P × converted / original), half away from zero (all terms ≥ 0 here)
  const num = pos * target;
  const q = num / original;
  const posNew = (num % original) * 2n >= original ? q + 1n : q;
  const discNew = posNew - target; // ≥ 0: P ≥ original ⇒ P' ≥ converted
  const spread = (group: readonly LineItem[], total: bigint): Money[] => {
    if (group.length === 0) return [];
    if (total === 0n || group.every((l) => mag(l) === 0n)) {
      return group.map(() => money(0, convertedTotal.currency));
    }
    return allocate(
      money(Number(total), convertedTotal.currency),
      group.map((l) => Number(mag(l))),
    );
  };
  const posParts = spread(
    lines.filter((l) => !isDiscount(l)),
    posNew,
  );
  const discParts = spread(lines.filter(isDiscount), discNew);
  let pi = 0;
  let di = 0;
  return lines.map((l) => {
    const part = isDiscount(l) ? discParts[di++]! : posParts[pi++]!;
    const signed = l.amount.amountMinor < 0 ? -part.amountMinor : part.amountMinor;
    return { ...l, amount: money(signed, convertedTotal.currency) };
  });
}
