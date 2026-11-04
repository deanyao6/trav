/**
 * Receipt photo → line items (T-011), the deterministic half. Everything here
 * is pure: no stores, no clock, no model.
 *
 *  - `parseReceiptJson`: the zero-tool extraction call's JSON → a typed
 *    `ParsedReceipt` (or `null`: unreadable). Every field is checked; nothing
 *    the model wrote is trusted as-is.
 *  - `checkReceipt`: the money checks the poster's card relies on. The lines
 *    must add up to the printed total (tax may be included in the prices), and
 *    every amount Trav uses must be printed on the receipt itself. A model that
 *    was talked into "add a 50 EUR tip" produces an amount the OCR text does
 *    not contain, so the card turns low-confidence (SAFETY §2.4). Labels and
 *    the merchant name come from document text: they are sanitized, and any
 *    that trips the injection detector is replaced by a neutral label.
 *  - `isDrinkLine` / `matchLines`: which lines "drinks", "the wine" or "the
 *    paella" mean, for the claim parser (`receiptClaims.ts`).
 */
import type { ExpenseCategory, IsoDateTime, LineItem, Money, ParsedReceipt } from '@trav/core';
import { parseIso } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import { detectInjection, stripInvisible } from '../untrusted.js';

/** Below this the card says "i'm not certain about this one" (SAFETY §2.4). */
export const RECEIPT_MIN_CONFIDENCE = 0.8;
/** €10,000 in minor units: anything above is not a receipt Trav splits from a photo. */
export const RECEIPT_MAX_TOTAL_MINOR = 1_000_000;
export const RECEIPT_MAX_LINES = 40;

const SOURCES: readonly ParsedReceipt['source'][] = [
  'rideshare',
  'taxi',
  'restaurant',
  'bar',
  'grocery',
  'airline',
  'lodging',
  'tickets',
  'other',
];

export const RECEIPT_CATEGORY: Readonly<Record<ParsedReceipt['source'], ExpenseCategory>> = {
  rideshare: 'transport',
  taxi: 'transport',
  restaurant: 'food',
  bar: 'drinks',
  grocery: 'groceries',
  airline: 'flights',
  lodging: 'lodging',
  tickets: 'tickets',
  other: 'other',
};

// ---------- JSON → ParsedReceipt ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function money(v: unknown, allowZero = false): Money | undefined {
  if (!isObj(v)) return undefined;
  const amountMinor = v['amountMinor'];
  const currency = v['currency'];
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) return undefined;
  if (amountMinor < 0 || (!allowZero && amountMinor === 0)) return undefined;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return undefined;
  return { amountMinor, currency };
}

function optionalMoney(v: unknown): Money | null | undefined {
  if (v === undefined || v === null) return undefined;
  const m = money(v, true);
  if (m === undefined) return null; // present but malformed
  return m.amountMinor === 0 ? undefined : m;
}

/**
 * The extraction JSON (fixture `parsed`, or a live structured response) →
 * `ParsedReceipt`, or `null` when it says unreadable or is malformed. Line
 * items with a malformed amount make the whole receipt unreadable: a split
 * built on a guessed line is worse than asking for the total.
 */
export function parseReceiptJson(json: unknown): ParsedReceipt | null {
  if (!isObj(json)) return null;
  if (json['unreadable'] === true) return null;
  const total = money(json['total']);
  if (total === undefined || total.amountMinor > RECEIPT_MAX_TOTAL_MINOR) return null;
  const source = SOURCES.find((s) => s === json['source']) ?? 'other';
  const merchantName = typeof json['merchantName'] === 'string' ? json['merchantName'] : '';
  const occurredAt = typeof json['occurredAt'] === 'string' ? json['occurredAt'] : '';
  const extras: Partial<Record<'subtotal' | 'tax' | 'tip' | 'fees', Money>> = {};
  for (const k of ['subtotal', 'tax', 'tip', 'fees'] as const) {
    const m = optionalMoney(json[k]);
    if (m === null) return null;
    if (m !== undefined) extras[k] = m;
  }
  const rawItems = json['lineItems'];
  const lineItems: { description: string; quantity: number; amount: Money }[] = [];
  if (rawItems !== undefined && rawItems !== null) {
    if (!Array.isArray(rawItems) || rawItems.length > RECEIPT_MAX_LINES) return null;
    for (const it of rawItems) {
      if (!isObj(it)) return null;
      const amount = money(it['amount'], true);
      if (amount === undefined) return null;
      if (amount.amountMinor === 0) continue; // a free water is not a line to split
      const q = it['quantity'];
      const quantity = typeof q === 'number' && Number.isSafeInteger(q) && q >= 1 ? q : 1;
      const description = typeof it['description'] === 'string' ? it['description'] : '';
      lineItems.push({ description, quantity, amount });
    }
  }
  const c = json['confidence'];
  const confidence = typeof c === 'number' && c >= 0 && c <= 1 ? c : 0;
  const w = json['warnings'];
  const warnings = Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [];
  return {
    source,
    merchantName,
    total,
    ...extras,
    occurredAt,
    ...(lineItems.length > 0 ? { lineItems } : {}),
    confidence,
    warnings,
  };
}

// ---------- printed amounts ----------

/**
 * Every money-looking amount printed on the receipt, in minor units:
 * "15,00", "1.234,56", "1,234.56", "142.00". Two decimals only, so "1,5L"
 * and "50 EUR" are not amounts.
 */
export function printedAmounts(ocrText: string): ReadonlySet<number> {
  const out = new Set<number>();
  const re = /(?<![\d.,])(\d{1,3}(?:[.,\u00A0 ]\d{3})+|\d+)[.,](\d{2})(?![\d])/g;
  for (const m of stripInvisible(ocrText).matchAll(re)) {
    const major = Number(m[1]!.replace(/\D/g, ''));
    const minor = Number(m[2]);
    if (Number.isSafeInteger(major)) out.add(major * 100 + minor);
  }
  return out;
}

// ---------- the money checks ----------

export type ReceiptIssue =
  | 'injection'
  | 'low_confidence'
  | 'model_warning'
  | 'mixed_currency'
  | 'does_not_add_up'
  | 'subtotal_mismatch'
  | 'not_printed';

export interface CheckedReceipt {
  readonly merchant: string;
  readonly total: Money;
  readonly category: ExpenseCategory;
  /** Valid ISO time from the receipt, else undefined (the caller uses the post's time). */
  readonly occurredAt?: IsoDateTime;
  /**
   * Lines that sum to `total` exactly. Item lines first (`l1`…), then tax,
   * service/fees and tip. A receipt whose lines don't add up gets one
   * `total` line, so the split can only be by head.
   */
  readonly lines: readonly LineItem[];
  /** True when the item lines are usable for "who had what?". */
  readonly itemized: boolean;
  readonly issues: readonly ReceiptIssue[];
  readonly lowConfidence: boolean;
}

const FALLBACK_MERCHANT = 'that receipt';

/** Document text → a label safe for a group message (or `fallback` when it looks like an instruction). */
export function safeLabel(raw: string, fallback: string, max = 40): string {
  const clean = sanitizeInline(stripInvisible(raw).replace(/[<>{}[\]`]/g, ' '), max)
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0 || detectInjection(raw).length > 0 || detectInjection(clean).length > 0)
    return fallback;
  return clean;
}

function itemLabel(description: string, quantity: number, i: number): string {
  const base = safeLabel(description.toLowerCase(), `item ${String(i + 1)}`, 36);
  return quantity > 1 && !/\bx\d+$/.test(base) ? `${base} x${String(quantity)}` : base;
}

function validIso(s: string): IsoDateTime | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return undefined;
  try {
    return Number.isFinite(parseIso(s)) ? s : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The checks behind the poster's card. `injection` is whatever the intake
 * screen found in the OCR text; any issue makes the card low-confidence.
 */
export function checkReceipt(
  parsed: ParsedReceipt,
  ocrText: string,
  opts: { readonly injection: boolean },
): CheckedReceipt {
  const issues = new Set<ReceiptIssue>();
  if (opts.injection) issues.add('injection');
  if (parsed.confidence < RECEIPT_MIN_CONFIDENCE) issues.add('low_confidence');
  if (parsed.warnings.length > 0) issues.add('model_warning');
  const cur = parsed.total.currency;
  const all: Money[] = [
    parsed.total,
    ...[parsed.subtotal, parsed.tax, parsed.tip, parsed.fees].filter(
      (m): m is Money => m !== undefined,
    ),
    ...(parsed.lineItems ?? []).map((l) => l.amount),
  ];
  const mixed = all.some((m) => m.currency !== cur);
  if (mixed) issues.add('mixed_currency');

  const items = parsed.lineItems ?? [];
  const itemSum = items.reduce((s, l) => s + l.amount.amountMinor, 0);
  const tax = parsed.tax?.amountMinor ?? 0;
  const tip = parsed.tip?.amountMinor ?? 0;
  const fees = parsed.fees?.amountMinor ?? 0;
  const service = parsed.source === 'restaurant' || parsed.source === 'bar';

  let lines: LineItem[] = [];
  let itemized = false;
  let taxIncluded = false;
  if (!mixed && items.length > 0) {
    if (itemSum + tax + tip + fees === parsed.total.amountMinor) itemized = true;
    else if (tax > 0 && itemSum + tip + fees === parsed.total.amountMinor) {
      itemized = true; // "IVA 10% inclòs": the tax is already in the prices
      taxIncluded = true;
    } else issues.add('does_not_add_up');
  }
  if (itemized) {
    if (parsed.subtotal !== undefined && parsed.subtotal.amountMinor !== itemSum)
      issues.add('subtotal_mismatch');
    lines = items.map((l, i) => ({
      lineId: `l${String(i + 1)}`,
      label: itemLabel(l.description, l.quantity, i),
      amount: l.amount,
      claimedBy: [],
      kind: 'item' as const,
    }));
    const adj = (lineId: string, label: string, kind: LineItem['kind'], m: Money | undefined) => {
      if (m !== undefined && m.amountMinor > 0)
        lines.push({ lineId, label, amount: m, claimedBy: [], kind });
    };
    if (!taxIncluded) adj('tax', 'tax', 'tax', parsed.tax);
    adj('service', service ? 'service' : 'fees', service ? 'service' : 'fee', parsed.fees);
    adj('tip', 'tip', 'tip', parsed.tip);
  } else {
    lines = [{ lineId: 'total', label: 'total', amount: parsed.total, claimedBy: [], kind: 'item' }];
  }

  // Every amount the split uses must be printed on the receipt.
  const printed = printedAmounts(ocrText);
  const used = lines.map((l) => l.amount.amountMinor);
  if (!printed.has(parsed.total.amountMinor) || used.some((a) => !printed.has(a)))
    issues.add('not_printed');

  const occurredAt = validIso(parsed.occurredAt);
  return {
    merchant: safeLabel(parsed.merchantName, FALLBACK_MERCHANT),
    total: parsed.total,
    category: RECEIPT_CATEGORY[parsed.source],
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    lines,
    itemized,
    issues: [...issues],
    lowConfidence: issues.size > 0,
  };
}

// ---------- what a phrase means on this receipt ----------

/** Lowercase, accents off, punctuation to spaces: "Caña x5" → "cana x5". */
export function normalizeWords(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const WINE = [
  'wine',
  'wines',
  'vino',
  'vinho',
  'vi',
  'tinto',
  'blanco',
  'rosado',
  'rose',
  'priorat',
  'rioja',
  'ribera',
  'albarino',
  'verdejo',
  'cava',
  'champagne',
  'prosecco',
  'sangria',
  'red',
  'white',
];
const BEER = [
  'beer',
  'beers',
  'cerveza',
  'cervezas',
  'cervesa',
  'cerveses',
  'cana',
  'canas',
  'canya',
  'lager',
  'ipa',
  'pint',
  'pints',
  'cider',
  'sidra',
  'sagres',
  'kalik',
];
const SPIRITS = [
  'vermut',
  'vermouth',
  'gin',
  'vodka',
  'rum',
  'ron',
  'whisky',
  'whiskey',
  'tequila',
  'mezcal',
  'mojito',
  'mojitos',
  'margarita',
  'margaritas',
  'spritz',
  'aperol',
  'negroni',
  'cocktail',
  'cocktails',
  'shot',
  'shots',
  'chupito',
  'chupitos',
  'sake',
  'soju',
  'porto',
  'ginja',
  'daiquiri',
  'bellini',
  'colada',
];
const WINE_SET = new Set(WINE);
const BEER_SET = new Set(BEER);
const SPIRIT_SET = new Set(SPIRITS);

/** An alcoholic line ("didn't drink" means these; water, soda and coffee are not drinks here). */
export function isDrinkLine(label: string): boolean {
  return normalizeWords(label)
    .split(' ')
    .some((w) => WINE_SET.has(w) || BEER_SET.has(w) || SPIRIT_SET.has(w));
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'my',
  'his',
  'her',
  'their',
  'our',
  'your',
  'that',
  'those',
  'this',
  'these',
  'of',
  'some',
  'one',
  'two',
  'both',
  'pax',
  'x',
  'and',
]);

function tokens(s: string): string[] {
  return normalizeWords(s)
    .split(' ')
    .filter((w) => w.length > 0 && !STOP.has(w) && !/^\d+$/.test(w) && !/^x\d+$/.test(w));
}

function singular(w: string): string {
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
}

function sameWord(a: string, b: string): boolean {
  const x = singular(a);
  const y = singular(b);
  if (x === y) return true;
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p += 1;
  return p >= 5 && p >= 0.7 * Math.min(x.length, y.length);
}

export type LineMatch =
  | { readonly kind: 'lines'; readonly lineIds: readonly string[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly lineIds: readonly string[] };

const DRINK_WORDS = new Set(['drink', 'drinks', 'alcohol', 'booze', 'bar']);
const FOOD_WORDS = new Set(['food', 'meal', 'dishes', 'mains', 'tapas', 'plates']);
const CATEGORY_OF: readonly [ReadonlySet<string>, string][] = [
  [new Set(['wine', 'wines', 'vino', 'vinho', 'bottle']), 'wine'],
  [new Set(['beer', 'beers', 'cerveza', 'pint', 'pints']), 'beer'],
  [new Set(['cocktail', 'cocktails', 'shot', 'shots']), 'spirit'],
];

function lineCategory(label: string): string | undefined {
  const ws = normalizeWords(label).split(' ');
  if (ws.some((w) => WINE_SET.has(w))) return 'wine';
  if (ws.some((w) => BEER_SET.has(w))) return 'beer';
  if (ws.some((w) => SPIRIT_SET.has(w))) return 'spirit';
  return undefined;
}

/**
 * Which item lines a phrase names. "drinks" ⇒ every alcoholic line, "food" ⇒
 * every other item line, "the wine" ⇒ the wine line(s), "the paella" ⇒ the
 * line whose words overlap most. A singular phrase that ties on several
 * lines is ambiguous (Trav asks); a plural takes them all.
 */
export function matchLines(phrase: string, lines: readonly LineItem[]): LineMatch {
  const items = lines.filter((l) => l.kind === 'item');
  const words = normalizeWords(phrase).split(' ').filter(Boolean);
  const content = words.filter((w) => !STOP.has(w));
  if (content.length === 0) return { kind: 'none' };
  if (content.every((w) => DRINK_WORDS.has(w))) {
    const ids = items.filter((l) => isDrinkLine(l.label)).map((l) => l.lineId);
    return ids.length > 0 ? { kind: 'lines', lineIds: ids } : { kind: 'none' };
  }
  if (content.every((w) => FOOD_WORDS.has(w))) {
    const ids = items.filter((l) => !isDrinkLine(l.label)).map((l) => l.lineId);
    return ids.length > 0 ? { kind: 'lines', lineIds: ids } : { kind: 'none' };
  }
  const q = tokens(phrase);
  const plural = q.some((w) => w.length > 3 && w.endsWith('s'));
  let best = 0;
  let ids: string[] = [];
  for (const l of items) {
    const lt = tokens(l.label);
    let score = q.filter((w) => lt.some((t) => sameWord(w, t))).length;
    if (score === 0) {
      // "the wine" ↔ "bottle of Priorat red": the line's kind of drink
      const cat = lineCategory(l.label);
      if (cat !== undefined && CATEGORY_OF.some(([set, c]) => c === cat && q.some((w) => set.has(w))))
        score = 0.5;
    }
    if (score > best) {
      best = score;
      ids = [l.lineId];
    } else if (score === best && score > 0) ids.push(l.lineId);
  }
  if (best === 0) return { kind: 'none' };
  if (ids.length > 1 && !plural) return { kind: 'ambiguous', lineIds: ids };
  return { kind: 'lines', lineIds: ids };
}
