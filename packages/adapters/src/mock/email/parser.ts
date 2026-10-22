/**
 * Offline `ReceiptEmailParser` (T-029-b): a deterministic, rule-based stand-in
 * for the zero-tool extraction model call, covering the fictional fixture
 * formats in `fixtures/emails/` (rideshare ride summaries, restaurant checks,
 * order/booking receipts; text or HTML bodies).
 *
 * Safety (SAFETY §2.4):
 * - The output is built field by field from typed values: core `ParsedReceipt`
 *   fields plus `emailId`/`ownerMemberId`. It never carries the subject, the
 *   sender or any body text; short extracted strings (merchant, line item
 *   descriptions, pickup/dropoff areas) are sanitised and length-capped.
 * - Instructions in the email are never acted on. Amounts come only from
 *   "label  €12.34" lines in VISIBLE text; hidden HTML is read only to flag it.
 * - Instruction-like text (the SAFETY §2.4 heuristic) caps `confidence` at
 *   0.4 and adds a fixed warning. Hidden text, totals that disagree, and line
 *   amounts that don't add up also lower confidence with a fixed warning.
 *   Warnings are fixed strings, never excerpts.
 * - An email that claims to come from Trav is rejected: Trav never emails
 *   approvals or receipts.
 *
 * Returns `invalid_request` for anything that isn't a receipt (no total line).
 * Pure: no clock (falls back to `receivedAt`), no network, no I/O.
 */
import {
  formatIso,
  parseDecimal,
  parseIso,
  sanitizeDisplayText,
  zoneOffsetMinutes,
  zonedWallTimeToMs,
} from '@trav/core';
import type { Money, ParsedLineItem, ReceiptSourceKind } from '@trav/core';
import type { AdapterError, Result } from '../../interfaces/common.js';
import type {
  InboundEmail,
  ParsedEmailReceipt,
  ReceiptEmailParser,
} from '../../interfaces/emailReceipts.js';
import { deepFreeze } from '../transactions/fixtureFiles.js';
import { htmlToText } from './html.js';
import { detectInjectionPatterns, isInstructionLike, stripInvisible } from './injection.js';

// ---------- fixed warning strings (the only free text a parse result carries besides extracted fields) ----------

export const EMAIL_WARNINGS = {
  injection: 'instruction-like text in email body',
  injectionHidden: 'instruction-like text in email body (hidden)',
  hiddenText: 'hidden text in email body',
  link: 'link in email body',
  totalsDisagree: 'receipt shows more than one total',
  doesNotAddUp: "line amounts don't add up to the total",
  mixedCurrency: 'more than one currency on the receipt',
  dateAfterReceipt: 'receipt date is after the email arrived',
  unknownMerchant: 'merchant name not found',
  itemsTruncated: 'too many line items; only the first ones are listed',
} as const;

const INJECTION_CONFIDENCE_CAP = 0.4;
const DOUBT_CONFIDENCE_CAP = 0.5;
const MAX_LINE_ITEMS = 50;
/** Aggregate budget for all line-item descriptions in one result. */
const MAX_ITEM_TEXT = 1200;
const MAX_ITEM_DESCRIPTION = 80;
const MAX_PLACE = 60;
const MAX_MERCHANT = 60;
/** Bodies longer than this are not receipts we can parse offline. */
const MAX_BODY_CHARS = 50_000;
/** Raw (pre-conversion) size cap, so HTML conversion and scanning stay cheap. */
const MAX_RAW_CHARS = 200_000;
/** Receipt amount lines are short; longer lines are never read for amounts. */
const MAX_MONEY_LINE = 200;

// ---------- result helpers ----------

function invalid(message: string): { ok: false; error: AdapterError } {
  return { ok: false, error: { code: 'invalid_request', message, retryable: false } };
}

function capped(text: string, max: number): string {
  const clean = sanitizeDisplayText(text);
  return clean.length > max ? clean.slice(0, max).trimEnd() : clean;
}

// ---------- money lines ----------

const SYMBOL_CURRENCY: Readonly<Record<string, string>> = { '€': 'EUR', $: 'USD', '£': 'GBP' };
const CODE_RE = '(?:EUR|USD|GBP)';
const NUM_RE = '\\d[\\d.,]*';
/** `label  €12.34`, `label  12,34 €`, `label  EUR 12.34`. The amount ends the line. */
const MONEY_LINE_RES: readonly RegExp[] = [
  new RegExp(`^(.*?\\S)\\s*:?\\s+([€$£])\\s?(${NUM_RE})$`),
  new RegExp(`^(.*?\\S)\\s*:?\\s+(${NUM_RE})\\s?([€$£])$`),
  new RegExp(`^(.*?\\S)\\s*:?\\s+(${CODE_RE})\\s?(${NUM_RE})$`),
];

interface MoneyLine {
  readonly label: string;
  readonly amount: Money;
}

/** Decimal string with `.` as the separator, or undefined if ambiguous/malformed. */
function normalizeNumber(raw: string): string | undefined {
  const s = raw.replace(/[.,]$/, '');
  if (/^\d+$/.test(s)) return s;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    const [intPart = '', frac = ''] = s.split(dec);
    if (s.split(dec).length !== 2 || !new RegExp(`^\\d{1,3}(\\${thou}\\d{3})+$`).test(intPart))
      return undefined;
    return /^\d{1,2}$/.test(frac) ? `${intPart.split(thou).join('')}.${frac}` : undefined;
  }
  const sep = lastDot >= 0 ? '.' : ',';
  if (new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s)) return s.split(sep).join('');
  if (new RegExp(`^\\d+\\${sep}\\d{1,2}$`).test(s)) return s.replace(sep, '.');
  return undefined;
}

function parseMoneyLine(line: string): MoneyLine | undefined {
  if (line.length > MAX_MONEY_LINE) return undefined;
  for (const [i, re] of MONEY_LINE_RES.entries()) {
    const m = re.exec(line);
    if (m === null) continue;
    const label = (m[1] ?? '').trim();
    const curRaw = i === 1 ? m[3] : m[2];
    const numRaw = i === 1 ? m[2] : m[3];
    const currency = curRaw === undefined ? undefined : (SYMBOL_CURRENCY[curRaw] ?? curRaw);
    const num = numRaw === undefined ? undefined : normalizeNumber(numRaw);
    if (currency === undefined || num === undefined || label === '') return undefined;
    try {
      return { label, amount: parseDecimal(num, currency) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

type LineKind = 'total' | 'subtotal' | 'tax' | 'tip' | 'fee' | 'base' | 'item';

function classify(label: string): LineKind {
  const l = label.toLowerCase().replace(/[*:]+/g, ' ').trim();
  if (/^(?:grand )?total(?: paid| charged| due)?$|^amount (?:paid|charged)$/.test(l))
    return 'total';
  if (/^sub-?total\b|^food (?:&|and) drinks?$/.test(l)) return 'subtotal';
  if (/^(?:tax|taxes|vat|iva|igic|sales tax)\b/.test(l)) return 'tax';
  if (/^(?:tip|tips|propina|gorjeta)\b/.test(l)) return 'tip';
  if (/\b(?:fees?|surge|surcharge|tolls?|gratuity|service charge|airport)\b/.test(l)) return 'fee';
  if (/\b(?:fare|ride|service)$|^trip fare\b/.test(l)) return 'base';
  return 'item';
}

function sumMoney(list: readonly Money[], currency: string): Money | undefined {
  if (list.length === 0) return undefined;
  return { amountMinor: list.reduce((acc, m) => acc + m.amountMinor, 0), currency };
}

function lineItemFrom(label: string, amount: Money): ParsedLineItem | undefined {
  let description = label;
  let quantity = 1;
  const suffix = /^(.*\S)\s+x\s?(\d{1,3})$/i.exec(label);
  const prefix = /^(\d{1,3})\s?x\s+(.*\S)$/i.exec(label);
  if (suffix !== null) {
    description = suffix[1] ?? label;
    quantity = Number(suffix[2]);
  } else if (prefix !== null) {
    description = prefix[2] ?? label;
    quantity = Number(prefix[1]);
  }
  const clean = capped(description, MAX_ITEM_DESCRIPTION);
  if (clean === '' || quantity < 1) return undefined;
  return { description: clean, quantity, amount };
}

// ---------- dates and times ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE}\\s+(\\d{4})\\b`, 'i');
const MONTH_DAY_YEAR = new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i');
const SLASH_DMY = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
const ISO_YMD = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const TIME_RE = /\b(\d{1,2}):(\d{2})(?:\s?([ap])\.?m\.?)?(?![\d:])/gi;

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}
interface WallTime {
  readonly hour: number;
  readonly minute: number;
}

function validDate(year: number, month: number, day: number): CalendarDate | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100)
    return undefined;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}

function findDate(line: string): CalendarDate | undefined {
  let m = DAY_MONTH_YEAR.exec(line);
  if (m !== null)
    return validDate(Number(m[3]), MONTHS.indexOf((m[2] ?? '').toLowerCase()) + 1, Number(m[1]));
  m = MONTH_DAY_YEAR.exec(line);
  if (m !== null)
    return validDate(Number(m[3]), MONTHS.indexOf((m[1] ?? '').toLowerCase()) + 1, Number(m[2]));
  m = ISO_YMD.exec(line);
  if (m !== null) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = SLASH_DMY.exec(line); // European receipts: day first.
  if (m !== null) return validDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return undefined;
}

function toWallTime(m: RegExpExecArray): WallTime | undefined {
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3]?.toLowerCase();
  if (ampm !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (ampm === 'p' ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : undefined;
}

/** First time on the line, or the end of a range ("14:00–20:00"). */
function findTime(line: string): WallTime | undefined {
  const all = [...line.matchAll(TIME_RE)];
  if (all.length === 0) return undefined;
  const first = all[0];
  const second = all[1];
  if (first !== undefined && second !== undefined) {
    const between = line.slice((first.index ?? 0) + first[0].length, second.index ?? 0);
    if (/^\s*(?:[-–—]|to)\s*$/i.test(between)) return toWallTime(second);
  }
  return first === undefined ? undefined : toWallTime(first);
}

/** Place names in the fixture formats → IANA zone, so the offset is right for that day. */
const PLACE_ZONES: readonly (readonly [RegExp, string])[] = [
  [/\b(?:barcelona|madrid|eixample|gràcia|el born)\b/i, 'Europe/Madrid'],
  [/\b(?:lisboa|lisbon|sintra|porto)\b/i, 'Europe/Lisbon'],
  [/\b(?:san francisco|sfo|oakland)\b/i, 'America/Los_Angeles'],
  [/\b(?:new york|jfk|manhattan|brooklyn|lga)\b/i, 'America/New_York'],
  [/\b(?:providenciales|grace bay|turks and caicos)\b/i, 'America/Grand_Turk'],
  [/\b(?:london|heathrow)\b/i, 'Europe/London'],
];

function zoneFor(text: string): string | undefined {
  let best: { index: number; zone: string } | undefined;
  for (const [re, zone] of PLACE_ZONES) {
    const m = re.exec(text);
    if (m !== null && (best === undefined || m.index < best.index)) best = { index: m.index, zone };
  }
  return best?.zone;
}

function offsetOfIso(iso: string): number {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (m === null) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function wallToIso(
  date: CalendarDate,
  time: WallTime,
  zone: string | undefined,
  fallbackOffset: number,
): string {
  if (zone !== undefined) {
    const isoDate = `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
    const ms = zonedWallTimeToMs(isoDate, time.hour, time.minute, zone);
    return formatIso(ms, zoneOffsetMinutes(ms, zone));
  }
  const ms =
    Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute) - fallbackOffset * 60_000;
  return formatIso(ms, fallbackOffset);
}

// ---------- merchant and kind ----------

function displayName(from: string): { name: string; address: string; domain: string } {
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  const address = (angle?.[2] ?? from).trim().toLowerCase();
  const domain = address.includes('@') ? (address.split('@')[1] ?? '') : '';
  return { name: (angle?.[1] ?? '').trim(), address, domain };
}

/** A forwarded "Trav" card is never a receipt (SAFETY T6: Trav never emails approvals). */
function claimsToBeTrav(from: string): boolean {
  const { name, domain } = displayName(from);
  return (
    /^trav\b/i.test(stripInvisible(name)) || /(?:^|\.)trav(?:-[a-z0-9-]+)?\./.test(`.${domain}`)
  );
}

const SENDER_NOISE =
  /\s+(?:ride\s+)?(?:receipts?|rides?|orders?|registration|bookings?|billing|no-?reply|notifications?)$/i;

interface MerchantGuess {
  readonly name: string;
  /**
   * Text that became `name` without already being scanned (the subject and
   * display name are scanned elsewhere): the domain label, with `-_.` read as
   * spaces, when the label fallback is used. Empty otherwise.
   */
  readonly unscanned: string;
}

function merchantFrom(email: InboundEmail): MerchantGuess {
  const subject = stripInvisible(email.subject);
  const fromSubject = /\b(?:receipt|check|bill|invoice|order) from\s+(.{2,80}?)\s*$/i.exec(subject);
  if (fromSubject?.[1] !== undefined) {
    const name = capped(fromSubject[1], MAX_MERCHANT);
    if (name !== '') return { name, unscanned: '' };
  }
  const { name, domain } = displayName(email.from.slice(0, MAX_RAW_CHARS));
  let n = stripInvisible(name);
  for (let i = 0; i < 3 && SENDER_NOISE.test(n); i += 1) n = n.replace(SENDER_NOISE, '');
  const cleaned = capped(n, MAX_MERCHANT);
  if (cleaned !== '') return { name: cleaned, unscanned: '' };
  const label = domain.split('.')[0] ?? '';
  return {
    name: capped(label.charAt(0).toUpperCase() + label.slice(1), MAX_MERCHANT),
    unscanned: label.replace(/[-_.]+/g, ' '),
  };
}

function kindOf(text: string, merchant: string): ReceiptSourceKind {
  const t = text.toLowerCase();
  if (
    /\b(?:thanks for riding|ride summary|riders on this trip|passengers?)\b/.test(t) ||
    /^(?:uber|lyft|bolt|cabify)$/i.test(merchant)
  ) {
    return 'rideshare';
  }
  if (/\btaxi\b/.test(t)) return 'taxi';
  if (
    /\b(?:table \d+|guests? \d+|menu|propina|gratuity|food (?:&|and) drinks?|restaurant)\b/.test(t)
  )
    return 'restaurant';
  if (/\b(?:boarding pass|flight \w+|airline)\b/.test(t)) return 'airline';
  if (/\b(?:\d+ nights?|check-in|check-out)\b/.test(t)) return 'lodging';
  if (/\b(?:e-?tickets?|admission)\b/.test(t)) return 'tickets';
  if (/\b(?:supermarket|grocer(?:y|ies)|mercado)\b/.test(t)) return 'grocery';
  return 'other';
}

// ---------- rides ----------

function simplifyPlace(address: string): string {
  const parts = address
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  // "Street, Neighbourhood, City" → the neighbourhood (coarse on purpose).
  if (parts.length >= 3) return capped(parts[parts.length - 2] ?? '', MAX_PLACE);
  const last = (parts[parts.length - 1] ?? '')
    .replace(/\s+[A-Z]{2}$/, '')
    .replace(/\s+terminal\s+\w+$/i, '');
  return capped([...parts.slice(0, -1), last].join(', '), MAX_PLACE);
}

interface RideFacts {
  readonly pickup?: string;
  readonly dropoff?: string;
  readonly riders?: number;
  readonly dropoffTime?: WallTime;
}

function rideFacts(lines: readonly string[]): RideFacts {
  let pickup: string | undefined;
  let dropoff: string | undefined;
  let riders: number | undefined;
  let dropoffTime: WallTime | undefined;
  const time = '(\\d{1,2}:\\d{2}(?:\\s?[ap]\\.?m\\.?)?)';
  const leading = new RegExp(`^(pickup|dropoff|drop-off)\\s+${time}\\s+(.+)$`, 'i');
  const trailing = new RegExp(`^(from|to):\\s+(.+?)\\s+${time}$`, 'i');
  for (const line of lines) {
    const r =
      /\briders on this trip:\s*(\d{1,2})\b/i.exec(line) ?? /^(\d{1,2})\s+passengers?$/i.exec(line);
    if (r !== null && riders === undefined) riders = Number(r[1]);
    let which: 'pickup' | 'dropoff' | undefined;
    let place: string | undefined;
    let at: string | undefined;
    const a = leading.exec(line);
    const b = trailing.exec(line);
    if (a !== null) {
      which = (a[1] ?? '').toLowerCase() === 'pickup' ? 'pickup' : 'dropoff';
      at = a[2];
      place = a[3];
    } else if (b !== null) {
      which = (b[1] ?? '').toLowerCase() === 'from' ? 'pickup' : 'dropoff';
      place = b[2];
      at = b[3];
    }
    if (which === undefined || place === undefined) continue;
    const simple = simplifyPlace(place);
    if (which === 'pickup' && pickup === undefined && simple !== '') pickup = simple;
    if (which === 'dropoff' && dropoff === undefined) {
      if (simple !== '') dropoff = simple;
      const t = at === undefined ? undefined : findTime(at);
      if (t !== undefined) dropoffTime = t;
    }
  }
  return {
    ...(pickup === undefined ? {} : { pickup }),
    ...(dropoff === undefined ? {} : { dropoff }),
    ...(riders === undefined || riders < 1 ? {} : { riders }),
    ...(dropoffTime === undefined ? {} : { dropoffTime }),
  };
}

// ---------- the parser ----------

const RECEIPT_SUBJECT =
  /\b(?:receipt|ride summary|your (?:ride|trip|check|bill|order)|order \S+ (?:delivered|confirmed|shipped)|registration confirmed|booking confirmed|invoice)\b/i;
const RECEIPT_SENDER =
  /^(?:receipts?|rides?|orders?|billing|bookings|registration|noreply|no-reply)@/i;

/** Text views of the email: visible text for amounts, everything for the injection scan. */
function bodies(email: InboundEmail): { visible: string; hidden: string; links: string } {
  const text = email.textBody === undefined ? '' : stripInvisible(email.textBody);
  const html =
    email.htmlBody === undefined ? undefined : htmlToText(stripInvisible(email.htmlBody));
  // Prefer the text part; hidden HTML parts are flagged either way.
  return {
    visible: text.trim() !== '' ? text : (html?.visible ?? ''),
    hidden: html?.hidden ?? '',
    links: html?.links ?? '',
  };
}

/**
 * The sender's display name: free text that becomes `merchantName`, so it is
 * scanned like the subject. The address itself is a routing token (no spaces,
 * so no pattern but `@trav` could match it, and that one would fire on every
 * legitimate `@trav…` domain); it is checked by `claimsToBeTrav` instead.
 */
function senderText(email: InboundEmail): string {
  // Plus the domain label when it had to stand in for the merchant name.
  return [displayName(email.from.slice(0, MAX_RAW_CHARS)).name, merchantFrom(email).unscanned].join(
    '\n',
  );
}

/**
 * Injection scan over everything a model would see (subject, text body, all
 * HTML text incl. hidden parts). Pattern names only. The ingestion caller uses
 * this to write `injection.detected` even when `parse` rejects the email.
 */
export function scanEmailForInjection(email: InboundEmail): readonly string[] {
  const rawHtml = email.htmlBody?.slice(0, MAX_RAW_CHARS);
  const html = rawHtml === undefined ? undefined : htmlToText(stripInvisible(rawHtml));
  const parts = [
    senderText(email),
    email.subject.slice(0, MAX_RAW_CHARS),
    (email.textBody ?? '').slice(0, MAX_RAW_CHARS),
    html?.visible ?? '',
    html?.hidden ?? '',
    html?.links ?? '',
  ];
  return detectInjectionPatterns(parts.join('\n'));
}

export function createOfflineReceiptEmailParser(): ReceiptEmailParser {
  return {
    canParse(email) {
      if (claimsToBeTrav(email.from)) return false;
      return (
        RECEIPT_SUBJECT.test(stripInvisible(email.subject)) ||
        RECEIPT_SENDER.test(displayName(email.from).address)
      );
    },

    parse(email) {
      return Promise.resolve(parseEmail(email));
    },
  };
}

function parseEmail(email: InboundEmail): Result<ParsedEmailReceipt> {
  if (claimsToBeTrav(email.from)) return invalid('not a receipt: the sender claims to be Trav');
  if (
    (email.textBody?.length ?? 0) + (email.htmlBody?.length ?? 0) + email.subject.length >
    MAX_RAW_CHARS
  ) {
    return invalid('not a receipt: email too large');
  }
  const { visible, hidden, links } = bodies(email);
  if (visible.trim() === '') return invalid('not a receipt: empty body');
  if (visible.length > MAX_BODY_CHARS) return invalid('not a receipt: body too long');

  const lines = visible
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l !== '');

  const totals: Money[] = [];
  const subtotals: Money[] = [];
  const taxes: Money[] = [];
  const tips: Money[] = [];
  const fees: Money[] = [];
  const bases: Money[] = [];
  const items: { label: string; amount: Money }[] = [];
  const currencies = new Set<string>();
  for (const line of lines) {
    const ml = parseMoneyLine(line);
    if (ml === undefined) continue;
    currencies.add(ml.amount.currency);
    const kind = classify(ml.label);
    if (kind === 'total') totals.push(ml.amount);
    else if (kind === 'subtotal') subtotals.push(ml.amount);
    else if (kind === 'tax') taxes.push(ml.amount);
    else if (kind === 'tip') tips.push(ml.amount);
    else if (kind === 'fee') fees.push(ml.amount);
    else if (kind === 'base') bases.push(ml.amount);
    else items.push(ml);
  }
  // The last NON-zero total: "Total due €0.00" after a paid total is a balance
  // line. Only zero totals (promo credit, cancelled order) means nothing to share.
  const nonZeroTotals = totals.filter((t) => t.amountMinor !== 0);
  const total = nonZeroTotals[nonZeroTotals.length - 1];
  if (total === undefined) return invalid('not a receipt: no total found');

  const warnings: string[] = [];
  let confidence = 0.95;
  const doubt = (warning: string, cap: number): void => {
    if (!warnings.includes(warning)) warnings.push(warning);
    confidence = Math.min(confidence, cap);
  };

  const currency = total.currency;
  if (currencies.size > 1) doubt(EMAIL_WARNINGS.mixedCurrency, DOUBT_CONFIDENCE_CAP);
  const same = (list: readonly Money[]): Money[] => list.filter((m) => m.currency === currency);
  if (nonZeroTotals.some((t) => t.currency !== currency || t.amountMinor !== total.amountMinor)) {
    doubt(EMAIL_WARNINGS.totalsDisagree, DOUBT_CONFIDENCE_CAP);
  }

  const subtotal = sumMoney(same(subtotals), currency);
  const tax = sumMoney(same(taxes), currency);
  const tip = sumMoney(same(tips), currency);
  const fee = sumMoney(same(fees), currency);
  const base = sumMoney(same(bases), currency);
  const itemLines = items.filter((i) => i.amount.currency === currency);
  const itemsSum = sumMoney(
    itemLines.map((i) => i.amount),
    currency,
  );

  // A single priced line equal to the total is the description, not an itemization.
  const candidates =
    itemLines.length >= 2
      ? itemLines
          .map((i) => lineItemFrom(i.label, i.amount))
          .filter((i): i is ParsedLineItem => i !== undefined)
      : [];
  // Budget: at most MAX_LINE_ITEMS items and MAX_ITEM_TEXT description chars in total.
  const lineItems: ParsedLineItem[] = [];
  let itemText = 0;
  for (const item of candidates) {
    if (lineItems.length >= MAX_LINE_ITEMS || itemText + item.description.length > MAX_ITEM_TEXT)
      break;
    lineItems.push(item);
    itemText += item.description.length;
  }
  if (lineItems.length < candidates.length)
    doubt(EMAIL_WARNINGS.itemsTruncated, DOUBT_CONFIDENCE_CAP);
  const derivedSubtotal =
    subtotal ??
    (lineItems.length >= 2 && itemsSum !== undefined && itemsSum.amountMinor !== total.amountMinor
      ? itemsSum
      : undefined);

  // Reconcile: (subtotal or items) + base + fees + tax + tip must equal the total.
  const goods = subtotal ?? itemsSum;
  const parts = [goods, base, fee, tax, tip].filter((m): m is Money => m !== undefined);
  if (parts.length > 0) {
    const sum = parts.reduce((acc, m) => acc + m.amountMinor, 0);
    if (sum !== total.amountMinor) doubt(EMAIL_WARNINGS.doesNotAddUp, DOUBT_CONFIDENCE_CAP);
  }

  const merchantName = merchantFrom(email).name;
  if (merchantName === '') doubt(EMAIL_WARNINGS.unknownMerchant, DOUBT_CONFIDENCE_CAP);
  const source = kindOf(visible, merchantName);
  const ride = source === 'rideshare' || source === 'taxi' ? rideFacts(lines) : undefined;

  // occurredAt: the ride's dropoff time, else the time on the date line, on the receipt's date.
  const receivedMs = parseIso(email.receivedAt);
  const fallbackOffset = offsetOfIso(email.receivedAt);
  const zone = zoneFor(visible);
  let occurredAt = email.receivedAt;
  const dateLineIndex = lines.findIndex((l) => findDate(l) !== undefined);
  const dateLine = dateLineIndex >= 0 ? lines[dateLineIndex] : undefined;
  const date = dateLine === undefined ? undefined : findDate(dateLine);
  if (date === undefined) {
    confidence = Math.min(confidence, 0.85);
  } else {
    const time = ride?.dropoffTime ?? (dateLine === undefined ? undefined : findTime(dateLine));
    if (time === undefined) confidence = Math.min(confidence, 0.85);
    occurredAt = wallToIso(date, time ?? { hour: 12, minute: 0 }, zone, fallbackOffset);
    if (parseIso(occurredAt) > receivedMs + 60 * 60_000)
      doubt(EMAIL_WARNINGS.dateAfterReceipt, DOUBT_CONFIDENCE_CAP);
  }
  // Injection heuristic over visible and hidden text separately.
  const visiblePatterns = detectInjectionPatterns(
    [senderText(email), email.subject, visible, links].join('\n'),
  );
  const hiddenPatterns = hidden.trim() === '' ? [] : detectInjectionPatterns(hidden);
  if (isInstructionLike(visiblePatterns)) doubt(EMAIL_WARNINGS.injection, INJECTION_CONFIDENCE_CAP);
  if (isInstructionLike(hiddenPatterns))
    doubt(EMAIL_WARNINGS.injectionHidden, INJECTION_CONFIDENCE_CAP);
  else if (hidden.trim() !== '') doubt(EMAIL_WARNINGS.hiddenText, DOUBT_CONFIDENCE_CAP);
  if ([...visiblePatterns, ...hiddenPatterns].includes('url')) warnings.push(EMAIL_WARNINGS.link);

  const rideOut =
    ride === undefined ||
    (ride.pickup === undefined && ride.dropoff === undefined && ride.riders === undefined)
      ? undefined
      : {
          ...(ride.pickup === undefined ? {} : { pickup: ride.pickup }),
          ...(ride.dropoff === undefined ? {} : { dropoff: ride.dropoff }),
          ...(ride.riders === undefined ? {} : { riders: ride.riders }),
        };

  // Built field by field: nothing from the email is spread in.
  const parsed: ParsedEmailReceipt = {
    emailId: email.emailId,
    ownerMemberId: email.ownerMemberId,
    source,
    merchantName: merchantName === '' ? 'Unknown merchant' : merchantName,
    total: { amountMinor: total.amountMinor, currency },
    ...(derivedSubtotal === undefined ? {} : { subtotal: derivedSubtotal }),
    ...(tax === undefined ? {} : { tax }),
    ...(tip === undefined ? {} : { tip }),
    ...(fee === undefined ? {} : { fees: fee }),
    occurredAt,
    ...(lineItems.length === 0 ? {} : { lineItems }),
    ...(rideOut === undefined ? {} : { ride: rideOut }),
    confidence: Math.round(confidence * 100) / 100,
    warnings,
  };
  return { ok: true, value: deepFreeze(parsed) };
}
