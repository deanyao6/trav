/**
 * Money: integer minor units + ISO 4217 code. Never floats. Field name is
 * `amountMinor` (matches the adapter interfaces and SAFETY.md's `*Minor`
 * convention; VOICE §3.4's `amount` is the same thing).
 *
 * All arithmetic throws `TravError('currency_mismatch')` when currencies differ.
 * `formatMoney` is the ONLY path to a money string (VOICE §3.4).
 *
 * Implementation notes:
 * - Every operation that could produce a fraction (`multiply`, `allocate`) runs
 *   on BigInt rationals, so results are exact and independent of float
 *   representation (1005 × 0.1 is 100.5 → 101, not 100.49999…).
 * - Rounding is half away from zero; allocation uses the largest-remainder
 *   method with ties broken by lowest index, so the same inputs always produce
 *   the same parts.
 */
import type { CurrencyCode } from './primitives.js';
import { TravError } from './errors.js';

export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

/** Exact fraction for `multiply` when a float literal would be lossy (e.g. a third). */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BHD',
  'IQD',
  'JOD',
  'KWD',
  'LYD',
  'OMR',
  'TND',
]);

/** Symbols that go directly before the number (VOICE §3.4). Anything else uses `CODE 12`. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  JPY: '¥',
  INR: '₹',
  KRW: '₩',
  BRL: 'R$',
  AUD: 'A$',
  CAD: 'CA$',
  MXN: 'MX$',
  NZD: 'NZ$',
};

const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

function assertCurrency(currency: CurrencyCode): void {
  if (typeof currency !== 'string' || !CURRENCY_CODE_RE.test(currency)) {
    throw new TravError('invalid_argument', `invalid currency code "${String(currency)}"`, {
      currency,
    });
  }
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  if (a.currency !== b.currency) {
    throw new TravError('currency_mismatch', `${op}: ${a.currency} vs ${b.currency}`, {
      op,
      left: a.currency,
      right: b.currency,
    });
  }
}

function assertSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new TravError('invalid_argument', `${what} must be a safe integer, got ${String(n)}`, {
      what,
      value: n,
    });
  }
}

/** Number of minor-unit digits for a currency: EUR/USD 2, JPY 0, etc. Unknown currencies default to 2. */
export function currencyExponent(currency: CurrencyCode): number {
  assertCurrency(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

/** Construct Money; throws `invalid_argument` on non-integer amounts. */
export function money(amountMinor: number, currency: CurrencyCode): Money {
  assertCurrency(currency);
  assertSafeInteger(amountMinor, 'amountMinor');
  // Normalise -0 so equals()/formatMoney never see a negative zero.
  return { amountMinor: amountMinor === 0 ? 0 : amountMinor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'add');
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'subtract');
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function abs(a: Money): Money {
  return money(Math.abs(a.amountMinor), a.currency);
}

// ---------- exact rational helpers (BigInt) ----------

interface BigRational {
  readonly num: bigint;
  readonly den: bigint; // always > 0
}

/**
 * Convert a JS number to an exact rational using its shortest decimal
 * representation, so `0.1` becomes 1/10 rather than its binary approximation.
 */
function toBigRational(value: number | Rational, what: string): BigRational {
  if (typeof value === 'object') {
    assertSafeInteger(value.num, `${what}.num`);
    assertSafeInteger(value.den, `${what}.den`);
    if (value.den === 0) {
      throw new TravError('invalid_argument', `${what}.den must not be 0`);
    }
    const sign = value.den < 0 ? -1n : 1n;
    return { num: BigInt(value.num) * sign, den: BigInt(Math.abs(value.den)) };
  }
  if (!Number.isFinite(value)) {
    throw new TravError('invalid_argument', `${what} must be finite, got ${String(value)}`);
  }
  if (Number.isInteger(value)) {
    assertSafeInteger(value, what);
    return { num: BigInt(value), den: 1n };
  }
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (!match) {
    throw new TravError('invalid_argument', `${what} is not a supported number: ${text}`);
  }
  const [, sign, intPart, fracPart = '', expPart = '0'] = match;
  const exp = Number(expPart);
  let num = BigInt(`${intPart}${fracPart}`);
  let den = 10n ** BigInt(fracPart.length);
  if (exp > 0) num *= 10n ** BigInt(exp);
  else if (exp < 0) den *= 10n ** BigInt(-exp);
  if (sign === '-') num = -num;
  return { num, den };
}

/** Round num/den to the nearest integer, half away from zero. */
function roundHalfAwayFromZero(num: bigint, den: bigint): bigint {
  const negative = num < 0n;
  const n = negative ? -num : num;
  const q = n / den;
  const r = n % den;
  const rounded = r * 2n >= den ? q + 1n : q;
  return negative ? -rounded : rounded;
}

function fromBigInt(value: bigint, currency: CurrencyCode, what: string): Money {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TravError('invalid_argument', `${what} overflows safe integer range`);
  }
  return money(Number(value), currency);
}

/**
 * Multiply by an integer, decimal or rational factor, rounding half away from
 * zero. `multiply(m, 1.1)` and `multiply(m, { num: 11, den: 10 })` are the same.
 */
export function multiply(a: Money, factor: number | Rational): Money {
  const f = toBigRational(factor, 'factor');
  const rounded = roundHalfAwayFromZero(BigInt(a.amountMinor) * f.num, f.den);
  return fromBigInt(rounded, a.currency, 'multiply');
}

export function sum(items: readonly Money[], currency: CurrencyCode): Money {
  let total = zero(currency);
  for (const item of items) {
    assertSameCurrency(total, item, 'sum');
    total = add(total, item);
  }
  return total;
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0;
}

/** -1, 0, 1. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, 'compare');
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
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
 *
 * Weights must be finite, non-negative numbers (1, 1.5, 2); integer weights must
 * be safe integers, decimal weights are read exactly from their shortest decimal
 * form. At least one weight must be positive; NaN, ±Infinity, negatives and
 * unsafe integers throw `invalid_argument`. A zero-weight part always gets
 * exactly 0. Negative totals are
 * allocated as the negation of the positive allocation, so `-€10` three ways is
 * `-3.34 / -3.33 / -3.33`.
 */
export function allocate(total: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) {
    throw new TravError('invalid_argument', 'allocate: weights must not be empty');
  }
  const rationals = weights.map((w, i) => {
    if (!Number.isFinite(w) || w < 0) {
      throw new TravError(
        'invalid_argument',
        `allocate: weight[${i}] must be >= 0, got ${String(w)}`,
      );
    }
    return toBigRational(w, `weight[${i}]`);
  });
  // Bring every weight onto a common denominator so they become integers.
  const commonDen = rationals.reduce((acc, r) => (acc * r.den) / gcd(acc, r.den), 1n);
  const intWeights = rationals.map((r) => r.num * (commonDen / r.den));
  const weightSum = intWeights.reduce((acc, w) => acc + w, 0n);
  if (weightSum === 0n) {
    throw new TravError('invalid_argument', 'allocate: at least one weight must be positive');
  }

  const negative = total.amountMinor < 0;
  const magnitude = BigInt(Math.abs(total.amountMinor));

  const bases: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  for (let i = 0; i < intWeights.length; i += 1) {
    const scaled = magnitude * (intWeights[i] ?? 0n);
    const base = scaled / weightSum;
    bases.push(base);
    remainders.push({ index: i, remainder: scaled % weightSum });
    allocated += base;
  }

  let leftover = magnitude - allocated;
  // Largest remainder first; ties by lowest index. (sort is stable; we sort by
  // remainder desc only, and the input order is index asc.)
  remainders.sort((a, b) => (a.remainder === b.remainder ? 0 : a.remainder > b.remainder ? -1 : 1));
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    bases[index] = (bases[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return bases.map((b) => fromBigInt(negative ? -b : b, total.currency, 'allocate'));
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function allocateEqual(total: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new TravError(
      'invalid_argument',
      `allocateEqual: parts must be >= 1, got ${String(parts)}`,
    );
  }
  return allocate(total, new Array<number>(parts).fill(1));
}

// ---------- formatting ----------

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * VOICE §3.4: symbol before number (`€84`, `$23.40`, `£12`), whole amounts drop
 * cents (`€90`), otherwise two decimals (`€16.80`), thousands comma (`€2,340`),
 * negative as `-€12`. Unknown currency symbols fall back to the ISO code with a
 * space (`CHF 12`). Zero-decimal currencies never show a fraction (`¥1,200`).
 */
export function formatMoney(m: Money): string {
  assertCurrency(m.currency);
  assertSafeInteger(m.amountMinor, 'amountMinor');
  const exponent = currencyExponent(m.currency);
  const negative = m.amountMinor < 0;
  const digits = String(Math.abs(m.amountMinor)).padStart(exponent + 1, '0');
  const intPart = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const fracPart = exponent === 0 ? '' : digits.slice(digits.length - exponent);
  const showFraction = /[1-9]/.test(fracPart);
  const number = `${groupThousands(intPart)}${showFraction ? `.${fracPart}` : ''}`;
  const symbol = CURRENCY_SYMBOLS[m.currency];
  const body = symbol === undefined ? `${m.currency} ${number}` : `${symbol}${number}`;
  return negative ? `-${body}` : body;
}

/** `€18 each` / `€16.80 each` (VOICE §3.4). */
export function formatEach(m: Money): string {
  return `${formatMoney(m)} each`;
}

/** `Maya → Dean €31.60` (debtor first; VOICE §3.4). Names are display names. */
export function formatTransfer(fromName: string, toName: string, m: Money): string {
  return `${fromName} → ${toName} ${formatMoney(m)}`;
}

/** `Dean €40 · Maya €22 · Sam €22` (unequal shares; VOICE §3.4). */
export function formatShares(
  shares: readonly { readonly name: string; readonly amount: Money }[],
): string {
  return shares.map((s) => `${s.name} ${formatMoney(s.amount)}`).join(' · ');
}

/**
 * Parse a decimal string ("45.00", "-12.5", "1200") into Money using the
 * currency's exponent. Adapter-edge helper. Throws `invalid_argument` when the
 * text is not a plain decimal or has more precision than the currency carries.
 */
export function parseDecimal(decimal: string, currency: CurrencyCode): Money {
  const exponent = currencyExponent(currency);
  const match = /^\s*([-+]?)(\d+)(?:\.(\d*))?\s*$/.exec(decimal);
  if (!match) {
    throw new TravError('invalid_argument', `parseDecimal: "${decimal}" is not a decimal amount`);
  }
  const [, sign, intPart, fracRaw = ''] = match;
  if (fracRaw.length > exponent && /[1-9]/.test(fracRaw.slice(exponent))) {
    throw new TravError(
      'invalid_argument',
      `parseDecimal: "${decimal}" has more precision than ${currency} allows`,
    );
  }
  const frac = fracRaw.slice(0, exponent).padEnd(exponent, '0');
  const minor = BigInt(`${intPart}${frac}`);
  return fromBigInt(sign === '-' ? -minor : minor, currency, 'parseDecimal');
}
