/**
 * Money: integer minor units + ISO 4217 code. Never floats. Field name is
 * `amountMinor` (matches the adapter interfaces and SAFETY.md's `*Minor`
 * convention; VOICE §3.4's `amount` is the same thing).
 *
 * All arithmetic throws `TravError('currency_mismatch')` when currencies differ.
 * `formatMoney` is the ONLY path to a money string (VOICE §3.4).
 */
import type { CurrencyCode } from './primitives.js';
import { notImplemented } from './errors.js';

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

/** Number of minor-unit digits for a currency: EUR/USD 2, JPY 0, etc. Unknown currencies default to 2. */
export function currencyExponent(currency: CurrencyCode): number {
  return notImplemented(`currencyExponent(${currency})`);
}

/** Construct Money; throws `invalid_argument` on non-integer amounts. */
export function money(amountMinor: number, currency: CurrencyCode): Money {
  return notImplemented(`money(${amountMinor}, ${currency})`);
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  return notImplemented(`add(${a.currency}, ${b.currency})`);
}

export function subtract(a: Money, b: Money): Money {
  return notImplemented(`subtract(${a.currency}, ${b.currency})`);
}

export function negate(a: Money): Money {
  return notImplemented(`negate(${a.currency})`);
}

/** Multiply by an integer or rational factor, rounding half away from zero. */
export function multiply(a: Money, factor: number): Money {
  return notImplemented(`multiply(${a.currency}, ${factor})`);
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  return notImplemented(`sum(${items.length}, ${currency})`);
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

/** -1, 0, 1. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  return notImplemented(`compare(${a.currency}, ${b.currency})`);
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/**
 * Split `total` into `weights.length` parts proportional to the weights, so the
 * parts sum exactly to `total`. Remainder minor units go, one each, to the
 * parts with the largest fractional remainder; ties resolve by lowest index
 * (deterministic). `allocateEqual(total, n)` is `allocate(total, Array(n).fill(1))`.
 * The ledger adds a rule on top: remainders go to the payer (VOICE §4.4).
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  return notImplemented(`allocate(${total.currency}, ${weights.length})`);
}

export function allocateEqual(total: Money, parts: number): Money[] {
  return notImplemented(`allocateEqual(${total.currency}, ${parts})`);
}

/**
 * VOICE §3.4: symbol before number (`€84`, `$23.40`, `£12`), whole amounts drop
 * cents (`€90`), otherwise two decimals (`€16.80`), thousands comma (`€2,340`),
 * negative as `-€12`. Unknown currency symbols fall back to the ISO code with a
 * space (`CHF 12`).
 */
export function formatMoney(m: Money): string {
  return notImplemented(`formatMoney(${m.currency})`);
}

/** `€18 each` / `€16.80 each` (VOICE §3.4). */
export function formatEach(m: Money): string {
  return `${formatMoney(m)} each`;
}

/** `Maya → Dean €31.60` (debtor first; VOICE §3.4). Names are display names. */
export function formatTransfer(fromName: string, toName: string, m: Money): string {
  return `${fromName} → ${toName} ${formatMoney(m)}`;
}

/** Parse a decimal string ("45.00") into Money using the currency's exponent. Adapter-edge helper. */
export function parseDecimal(decimal: string, currency: CurrencyCode): Money {
  return notImplemented(`parseDecimal(${decimal}, ${currency})`);
}
