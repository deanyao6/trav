/**
 * Expense from chat text (T-010): a deterministic parser for the ways people
 * state a payment in a group chat. Pure: no I/O, no clock, no model. The flow
 * that logs, asks and remembers half-answered questions is `chatExpense.ts`.
 *
 *   parseExpenseText(text, ctx)   ⇒ none | no_log | unsure | drafts
 *   evaluateDrafts(drafts, ctx)   ⇒ ready (Expense-shaped, integer minor units)
 *                                  | clarify (exactly one question) | unsure
 *   mergeAnswer(drafts, answer)   ⇒ the drafts with the answered facts filled
 *
 * Rules (the parser's contract; `ingest/expenseText.test.ts` and
 * `fixtures/expenses/text.json` hold one labeled example of each):
 *
 * Statement. A message is an expense statement when it carries a payment cue
 * ("i paid", "Jordan got", "covered", "put/add/log", "split", "venmo me",
 * "owe(s)", "on me", "on my card"), or a weak cue ("was", "were", "came to",
 * "cost") next to an amount. Questions ("how much was dinner?", "who paid?")
 * and booking requests ("get the 5 of us tickets") are not statements.
 * "leave it off" / "don't log it" next to a payment ⇒ `no_log`.
 *
 * Amount. "€84", "84€", "84 €", "84 euros", "45 euro", "$40", "$40 USD",
 * "40 usd", "20 quid", "£12", "47.40", "46,50" (decimal comma), "1,500"
 * (thousands). A bare number counts only in a money position ("paid 84",
 * "84 for dinner", "venmo me 20 each", "dean owes 40", ", 84,"); headcounts
 * ("the 5 of us", "6 ways", "6x", "50/50", "2 waters") never do, and next to
 * a written amount a bare number needs a money verb ("bought 6 for sat, €156"
 * is €156). Amounts in parentheses, and an "each" figure beside a total
 * ("€28, €14 EACH"), are asides unless the message is an itemized list.
 * "6x €11.35 = 68.10" takes the total after "="; "6x €11.35" alone is the
 * product, in integer cents.
 *
 * Currency. The written symbol/word wins. A bare number is in the trip's
 * currency (the trip has one by construction, VOICE §3.4); with no trip
 * currency, or when the message points elsewhere ("venmo", "zelle", "cash
 * app" on a non-USD trip), the currency is a missing fact. An amount in a
 * currency other than the trip's is never converted here (no FX until T-031):
 * Trav asks for the amount in the trip currency.
 *
 * Payer. "i paid / i got / on me / on my card / venmo me / X owes me" ⇒ the
 * sender; "Jordan paid / got / covered" ⇒ Jordan; "i owe Dean €20 for X" ⇒
 * Dean paid €20 and the sender owes all of it. Otherwise the sender (the one
 * stating it). A payer who is not on the trip is a missing fact.
 *
 * Who is in (a money fact, never assumed; VOICE §4.11):
 *  - "everyone", "all of us", "evenly", "the 6 of us", "6 ways", "6x" (= the
 *    whole roster) ⇒ equal over every active member
 *  - "everyone but/except Henry", "everyone except me" ⇒ exclude
 *  - a name is in the split only inside a list: "for/with/between/among/just/
 *    only X", a run with "me"/"i" ("me and Sam", "jordan and i"), or a clause
 *    that is nothing but names (", me priya and sam"). "with/between X" puts
 *    the payer in too. Fixed-share and weight owners are in.
 *  - a name next to an absence cue ("henry wasn't there", "not henry",
 *    "henry's out", "maya skipped it", "without henry") is left out: everyone
 *    but them. "everyone else" means everyone but those named out (with
 *    nobody named out it is a question, unless fixed shares make it clear).
 *  - any other name ("dinner at maya's place", "henry already paid me his
 *    part") is a question: a stray name is never a guess at who pays.
 *  - "evenly"/"equally" say how, not who: everyone only when nobody is listed
 *  - "the 4 of us" / "4 ways" below the roster size ⇒ the names given, or an
 *    activity roster with exactly that many "in": the one named in the
 *    message ("from razz"), else the activity that just happened (≤ 18h ago),
 *    else the only one of that size around now; otherwise a question. Never a
 *    guess by count (SAFETY §2.5).
 *  - "the girls", "the guys", "some of us", "them" ⇒ a question
 *  - nothing said ⇒ a question, except on a family tab (one pot, VOICE §8)
 *    or a one-member group
 * Custom shares: "Sam pays 20", "Dean owes 40, Maya 30, rest is mine", "he
 * pays 10" (the member named just before), "they pay 15 each" ⇒ exact, the
 * rest split evenly over everyone else in (remainders to the payer, as in core
 * `ledger.computeShares`); "priya pays double" / "weighted: dean 1 maya 1 sam
 * 2" ⇒ weighted; "dinner was €90: i had the steak (€30), maya and priya split
 * the paella (€40), wine €20 for the three of us" ⇒ itemized.
 *
 * Several expenses. "84 for dinner and 20 for the cab" ⇒ two drafts, one per
 * amount with its own description; who's in, when said once, applies to all.
 *
 * Not a statement: questions, requests for Trav to do something ("book the
 * €18 tickets…", "can you get…") and plans ("how about…", "let's…").
 *
 * The one question (VOICE §4.11) covers every missing fact at once, except an
 * unknown payer, which is asked alone (who's in depends on who paid). An
 * answer only fills what was asked, and only when it is answer-shaped: not a
 * question, a request, or a new statement of its own.
 *
 * Amount checks: "€84 + €10 tip" is one total; a minus sign ("-€20") is
 * unsure; above €2,000 (`SANITY_MAX_CENTS`) the sender says the amount again
 * before it is logged ("yes" does not count, so a stray "yes" can never log
 * €84,000). "we paid" makes the payer a question.
 *
 * Accounting guard: every money-looking token lands in a draft (a total, a
 * share, a "+" part, a matching "6x" product, a per-person restatement or an
 * itemized line), or the message is `unsure`. "…and he owes me 15 for the
 * cab" beside another total is unsure, never folded into it.
 *
 * Anything with a cue and an amount that these rules cannot map (two payers
 * in one clause, a pronoun with no one before it, shares above the total) is
 * `unsure`: the flow asks the model, and failing that, the chat loop.
 */
import type {
  CurrencyCode,
  Expense,
  ExpenseCategory,
  IsoDateTime,
  MemberId,
  Money,
  SplitSpec,
} from '@trav/core';
import { formatMoney, ledger, money, parseDecimal } from '@trav/core';
import { stripInvisible } from '../untrusted.js';

// ---------- inputs and outputs ----------

export interface ParseMember {
  readonly memberId: MemberId;
  readonly displayName: string;
}

/** An activity's attendance, for "the 5 of us from razz". */
export interface ParseRoster {
  readonly activityId: string;
  readonly name: string;
  readonly venue?: string;
  readonly startsAt?: IsoDateTime;
  readonly inMemberIds: readonly MemberId[];
}

export interface ExpenseTextContext {
  readonly senderMemberId: MemberId;
  /** Active, non-guest members in group order (the split universe). */
  readonly members: readonly ParseMember[];
  /** The trip currency; `null` when the trip has none (then bare numbers need a currency). */
  readonly tripCurrency: CurrencyCode | null;
  /** Family tab (VOICE §8): one pot, so "who's in" is never a question. */
  readonly familyTab: boolean;
  readonly rosters?: readonly ParseRoster[];
  /** For "the only roster around now" (±18h). */
  readonly now?: IsoDateTime;
}

export type ParticipantSpec =
  | { readonly kind: 'everyone' }
  | { readonly kind: 'except'; readonly ids: readonly MemberId[] }
  | { readonly kind: 'list'; readonly ids: readonly MemberId[] }
  /** "the 4 of us" that no list or roster settles. */
  | { readonly kind: 'count'; readonly n: number }
  /** "me and the girls": a group nobody can name for them. */
  | { readonly kind: 'vague'; readonly phrase: string };

export interface DraftAmount {
  /** Plain decimal ("84", "16.80"); converted to minor units once the currency is known. */
  readonly decimal: string;
  /** As written; `undefined` for a bare number. */
  readonly currency?: CurrencyCode;
}

export interface ExpenseDraft {
  readonly description: string;
  readonly category: ExpenseCategory;
  readonly payer:
    | { readonly kind: 'member'; readonly memberId: MemberId }
    | { readonly kind: 'unknown'; readonly name: string };
  readonly amount?: DraftAmount;
  /** "venmo me 20 each": the amount is per person; the total is amount × participants. */
  readonly perPerson: boolean;
  /** The sender restated an amount above the sanity bound. */
  readonly amountConfirmed?: boolean;
  /** A word that points away from the trip currency ("venmo"), so a bare number's currency is asked. */
  readonly currencyDoubt?: string;
  readonly participants?: ParticipantSpec;
  /** Exact shares stated for some members ("Sam pays 20"). */
  readonly fixed: readonly { readonly memberId: MemberId; readonly decimal: string }[];
  /** Weights other than 1 ("priya pays double"). */
  readonly weights: readonly { readonly memberId: MemberId; readonly weight: number }[];
  /** "rest is mine": the payer is in and takes what the fixed shares leave. */
  readonly restToPayer: boolean;
  readonly lineItems?: readonly {
    readonly label: string;
    readonly decimal: string;
    readonly claimants: readonly MemberId[];
  }[];
}

export type ExpenseTextParse =
  | { readonly kind: 'none' }
  | { readonly kind: 'no_log' }
  | { readonly kind: 'unsure'; readonly reason: string }
  | { readonly kind: 'drafts'; readonly drafts: readonly ExpenseDraft[] };

/** A settled expense: everything `ExpenseRepository.create` needs except ids and times. */
export interface ParsedExpense {
  readonly description: string;
  readonly category: ExpenseCategory;
  readonly payer: MemberId;
  readonly amount: Money;
  readonly split: SplitSpec;
}

export type MissingFact =
  | 'amount'
  | 'currency'
  | 'trip_currency'
  | 'participants'
  | 'payer'
  /** Above `SANITY_MAX_CENTS`: the amount is said again before it is logged (r1 #9). */
  | 'confirm_amount';

/** €2,000 (or 2,000 of any two-decimal currency): above this, a typo costs real money. */
export const SANITY_MAX_CENTS = 200_000;

export type DraftsEvaluation =
  | { readonly kind: 'ready'; readonly expenses: readonly ParsedExpense[] }
  | {
      readonly kind: 'clarify';
      /** Per draft (same order), what is still missing. */
      readonly missing: readonly (readonly MissingFact[])[];
      /** One question, VOICE §4.11. */
      readonly question: string;
    }
  | { readonly kind: 'unsure'; readonly reason: string };

// ---------- vocabulary ----------

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const COUNT_WORD = `(\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;

const CURRENCY_WORD = 'usd|eur|gbp|euros?|dollars?|bucks|quid|pounds?|(?:us )?dollars?';

function currencyOf(token: string): CurrencyCode | undefined {
  const t = token.trim().toLowerCase();
  if (t === '€' || t === 'eur' || t.startsWith('euro')) return 'EUR';
  if (t === '$' || t === 'usd' || t.includes('dollar') || t === 'bucks') return 'USD';
  if (t === '£' || t === 'gbp' || t === 'quid' || t.startsWith('pound')) return 'GBP';
  return undefined;
}

/** "Venmo" etc. are US apps: a bare number next to them may well be dollars. */
const CURRENCY_DOUBT = /\b(venmo|zelle|cash ?app)\b/;

const CATEGORY_WORDS: readonly (readonly [ExpenseCategory, RegExp])[] = [
  ['flights', /\b(flights?|plane tickets?|airfare)\b/],
  ['lodging', /\b(airbnb|hotel|hostel|lodging|cleaning fee|apartment|villa|room)\b/],
  [
    'activities',
    /\b(tours?|show|boat|guides?|museum|sagrada|park g[uü]ell|flamenco|cruise|kayak|surf|lesson|class|excursion|snorkel)\b/,
  ],
  ['tickets', /\b(tickets?|entry|cover charge|match|game|concert|club entry)\b/],
  [
    'transport',
    /\b(taxi|cab|uber|lyft|bolt|metro|bus|train|tram|driver|transfer|ferry|scooters?|parking|gas|petrol|tolls?|rides?)\b/,
  ],
  ['groceries', /\b(groceries|grocery|supermarket|mercadona|market run)\b/],
  [
    'drinks',
    /\b(drinks?|beers?|cava|wine|cocktails?|shots?|waters?|bar|bottles?|sangria|vermut|vermouth|rounds?)\b/,
  ],
  [
    'food',
    /\b(dinner|lunch|breakfast|brunch|food|kebabs?|tapas|paella|pizza|ice cream|gelato|coffees?|snacks?|burgers?|churros|meal|smoothies?|sushi|tacos?|bakery|pastries|croissants?)\b/,
  ],
];

function categoryFor(text: string): ExpenseCategory {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return cat;
  return 'other';
}

/** The description decides ("dinner" beats "henry only had a drink"); the whole text otherwise. */
function categoryOf(description: string | undefined, text: string): ExpenseCategory {
  const fromDesc = description === undefined ? 'other' : categoryFor(description);
  return fromDesc !== 'other' ? fromDesc : categoryFor(text);
}

/** A noun the no-amount form may follow ("i paid for dinner", "Jordan got the taxi"). */
function isSpendNoun(text: string): boolean {
  return categoryFor(text) !== 'other' || /\b(laundr\w*|tab|bill|round)\b/.test(text);
}

const VAGUE_GROUP =
  /\b(?:the |my |those |these )?(girls|guys|boys|lads|ladies|dudes|bros|others|crew|gang|squad|roommates|couple of us|some of us|a few of us|few of us|rest of them|them|those two|these two)\b/;

const STRONG_CUE =
  /\b(paid|pay for|covered|got|grabbed|bought|picked up|spent|fronted|treated|put|add|log|split|venmo me|zelle me|owes?|on me|on my card|my card|tab)\b/;
const WEAK_CUE = /\b(was|were|is|came to|comes to|cost|costs|totall?ed)\b/;
const NO_LOG =
  /\b(leave it off|keep it off|don'?t (?:log|add|put|count)|do not (?:log|add|put)|not on the tab|off the tab|i'?ll expense it|expensing it)\b/;
const QUESTION_START =
  /^(?:how much|how many|what|whats|what's|who|whos|who's|did|does|do|is|are|was|were|when|where|why|which|should)\b/;
/** "book the €18 tickets…", "can you get…": a request for Trav to do something, not a payment made. */
const REQUEST_START =
  /^(?:(?:can|could|would|will) you\s+|(?:pls|please|plz)\s+)?(?:get|book|buy|reserve|grab|order|find|search|look|check|show|tell|remind|send|hold)\b/;
/** "how about €18 tickets", "let's do the €25 boat": a plan, nothing paid yet. */
const SUGGESTION_START =
  /^(?:how about|what about|should we|shall we|can we|could we|let'?s|lets|maybe|wanna|want to|we should|we could|thinking)\b/;

// ---------- normalization ----------

function cleanText(text: string): string {
  return stripInvisible(text)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(^|[^\w@])@trav(?![\w-])\s*[,:]?/gi, '$1 ')
    .replace(/^\s*(?:(?:hey|hi|yo|ok|okay|yeah)\s+)?trav\b\s*[,:]?\s*/i, '')
    .replace(/\bw\/\s*/gi, 'with ')
    .replace(/(^|\s)w(?=\s)/gi, '$1with')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Plain decimal from "1,500", "46,50", "68.10", "84"; `undefined` when it isn't one. */
export function normalizeDecimal(raw: string): string | undefined {
  if (/^\d+$/.test(raw)) return String(Number(raw));
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw)) return raw.replace(/,/g, '');
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw))
    return raw.replace(/\./g, '').replace(',', '.');
  if (/^\d+[.,]\d{1,2}$/.test(raw)) return raw.replace(',', '.');
  return undefined;
}

/** "11.35" ⇒ 1135, "84" ⇒ 8400: exact, from the digits (never a float multiply). */
export function decimalToCents(decimal: string): number {
  const [int = '0', frac = ''] = decimal.split('.');
  return Number(int) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

/** 6810 ⇒ "68.10". */
export function centsToDecimal(cents: number): string {
  return `${String(Math.trunc(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

// ---------- members ----------

interface NameHit {
  readonly memberId: MemberId;
  readonly start: number;
  readonly end: number;
}

function memberPattern(m: ParseMember): RegExp | undefined {
  const name = m.displayName.trim().toLowerCase();
  if (name.length === 0) return undefined;
  return new RegExp(`(?<![\\w])${escapeRe(name)}(?:'s|s')?(?![\\w])`, 'g');
}

function findNames(low: string, members: readonly ParseMember[]): NameHit[] {
  const hits: NameHit[] = [];
  for (const m of members) {
    const re = memberPattern(m);
    if (re === undefined) continue;
    for (const x of low.matchAll(re)) {
      hits.push({ memberId: m.memberId, start: x.index, end: x.index + x[0].length });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

function memberByWord(word: string, members: readonly ParseMember[]): MemberId | undefined {
  const w = word
    .trim()
    .toLowerCase()
    .replace(/'s$|s'$/, '');
  const hits = members.filter((m) => m.displayName.trim().toLowerCase() === w);
  return hits.length === 1 ? hits[0]!.memberId : undefined;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

// ---------- amounts ----------

type Role = 'total' | 'share' | 'paren' | 'operand' | 'unit' | 'weight';

interface AmountTok {
  readonly start: number;
  readonly end: number;
  readonly decimal: string;
  readonly currency?: CurrencyCode;
  readonly explicit: boolean;
  readonly inParens: boolean;
  role: Role;
  each: boolean;
  /** Written with a minus sign ("-€20"). */
  readonly negative: boolean;
  /** Folded into another token ("€84 + €10 tip" is one total). */
  merged?: boolean;
  /** For role 'share': who it belongs to. */
  owners?: MemberId[];
}

function parenRanges(low: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\(([^()]*)\)/g;
  for (const m of low.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

const MONEY_BEFORE =
  /(?:owes? me(?: back)?|paid|pay|pays|paying|owe|owes|owed|was|were|is|are|cost|costs|came to|comes to|total(?:l?ed)?|log|add|put|spent|venmo me|zelle me|cash ?app me|pay me|send me|give me|charged?|=|split)\s*$/;
const MONEY_AFTER = /^\s*(?:for|each|total|in total|on (?:the|my|me)|split|between|with)\b/;
const NOT_MONEY_AFTER =
  /^\s*(?:of\s+(?:us|you|them)|ways?\b|x\b|×|people|ppl|persons?|times|pm\b|am\b|h\b|hrs?\b|hours?|mins?\b|minutes?|%|\/|-\d|th\b|st\b|nd\b|rd\b|nights?|days?|tickets?\b|beers?|drinks?|waters?|rounds?|coffees?|shots?|bottles?|kebabs?|of the)/;

function scanAmounts(low: string, members: readonly ParseMember[]): AmountTok[] {
  const parens = parenRanges(low);
  const inParens = (i: number): boolean => parens.some(([a, b]) => i > a && i < b);
  const toks: AmountTok[] = [];
  const taken = (s: number, e: number): boolean => toks.some((t) => s < t.end && e > t.start);
  const push = (s: number, e: number, raw: string, cur: string | undefined): void => {
    if (taken(s, e)) return;
    const decimal = normalizeDecimal(raw);
    if (decimal === undefined) return;
    const currency = cur === undefined ? undefined : currencyOf(cur);
    toks.push({
      start: s,
      end: e,
      decimal,
      ...(currency !== undefined ? { currency } : {}),
      explicit: currency !== undefined,
      inParens: inParens(s),
      role: 'total',
      each: false,
      negative: /(?:^|[^\d\w])[-−]\s*$/.test(low.slice(0, s)),
    });
  };
  const NUM = '(\\d+(?:[.,]\\d+)*)';
  // €84 / $40 USD / £12
  for (const m of low.matchAll(
    new RegExp(`([€$£])\\s?${NUM}(?:\\s?(${CURRENCY_WORD})\\b)?`, 'g'),
  )) {
    push(m.index, m.index + m[0].length, m[2]!, m[3] ?? m[1]);
  }
  // 84€ / 46,50 € / 45 euros / 20 quid
  for (const m of low.matchAll(new RegExp(`${NUM}\\s?([€$£]|(?:${CURRENCY_WORD})\\b)`, 'g'))) {
    push(m.index, m.index + m[0].length, m[1]!, m[2]);
  }
  // usd 40
  for (const m of low.matchAll(new RegExp(`\\b(usd|eur|gbp)\\s?${NUM}`, 'g'))) {
    push(m.index, m.index + m[0].length, m[2]!, m[1]);
  }
  // bare numbers in a money position
  const namesRe = members
    .map((m) => escapeRe(m.displayName.trim().toLowerCase()))
    .filter((n) => n.length > 0);
  const nameBefore =
    namesRe.length > 0 ? new RegExp(`(?:^|[\\s,])(?:${namesRe.join('|')})\\s*$`) : undefined;
  const weakBare: { s: number; e: number; raw: string }[] = [];
  for (const m of low.matchAll(/(?<![\w.,/])(\d+(?:[.,]\d+)*)(?![\w/]|[.,]\d)/g)) {
    const s = m.index;
    const e = s + m[0].length;
    if (taken(s, e)) continue;
    const before = low.slice(0, s);
    const after = low.slice(e);
    if (NOT_MONEY_AFTER.test(after)) continue;
    if (/\d\s*[x×*]\s*$/.test(before) || /[/:]\s*$/.test(before) || /\d\s*-\s*$/.test(before))
      continue;
    if (/\bthe\s*$/.test(before) && /^\s*of\b/.test(after)) continue;
    const hasDecimals = /[.,]\d{1,2}$/.test(m[1]!);
    const standalone = /(?:^|[,;:])\s*$/.test(before) && /^\s*(?:[,;.]|$)/.test(after);
    // "84 plus 10 tip", "tipped 10": the second figure is money too (T-010 r2 #3)
    const extraFigure =
      (toks.length > 0 && /(?:\+|\bplus|\btipped|\btip(?:ped)? of)\s*$/.test(before)) ||
      /^\s*(?:tips?|tax|vat|service|gratuity)\b/.test(after);
    const strongBefore =
      MONEY_BEFORE.test(before) || extraFigure || (nameBefore?.test(before) ?? false);
    if (strongBefore || hasDecimals) push(s, e, m[1]!, undefined);
    else if (MONEY_AFTER.test(after) || standalone) weakBare.push({ s, e, raw: m[1]! });
  }
  // "bought 6 for sat, €156": next to a written amount, a count of things
  // bought ("bought 6", "got 6") is a headcount, not money. "and 20 for the
  // cab" stays money (r1 #5).
  const written = toks.some((t) => t.explicit);
  for (const w of weakBare) {
    const quantity = /\b(?:bought|got|grabbed|booked|ordered|picked up|have|had)\s*$/.test(
      low.slice(0, w.s),
    );
    if (!(written && quantity)) push(w.s, w.e, w.raw, undefined);
  }
  return toks.sort((a, b) => a.start - b.start);
}

// ---------- the parser ----------

interface Scan {
  readonly orig: string;
  readonly low: string;
  readonly ctx: ExpenseTextContext;
  readonly names: readonly NameHit[];
  readonly amounts: AmountTok[];
}

const PRONOUN = /^(he|she|they|him|her|them)$/;

/** Member(s) a pronoun at `at` refers to: those named in its clause before it. */
function resolvePronoun(scan: Scan, pronoun: string, at: number): MemberId[] | undefined {
  const before = scan.low.slice(0, at);
  const clauseStart = Math.max(
    before.lastIndexOf(','),
    before.lastIndexOf(';'),
    before.lastIndexOf('.'),
    before.lastIndexOf(':'),
  );
  let hits = scan.names.filter((h) => h.start > clauseStart && h.end <= at);
  if (hits.length === 0) hits = scan.names.filter((h) => h.end <= at);
  if (hits.length === 0) return undefined;
  if (pronoun === 'they' || pronoun === 'them') {
    // the last "X and Y" run
    const last = hits[hits.length - 1]!;
    const run = [last];
    for (let i = hits.length - 2; i >= 0; i -= 1) {
      const gap = scan.low.slice(hits[i]!.end, run[0]!.start);
      if (/^\s*(?:,|and|&|,\s*and)\s*$/.test(gap)) run.unshift(hits[i]!);
      else break;
    }
    return uniq(run.map((h) => h.memberId));
  }
  return [hits[hits.length - 1]!.memberId];
}

/** Subject words right before a verb ending at `at`: "sam and henry", "he", "dean". */
function subjectBefore(scan: Scan, at: number): MemberId[] | undefined {
  const before = scan.low.slice(0, at);
  const two = /([a-z']+)\s+(?:and|&)\s+([a-z']+)(?:\s+(?:both|each|all))?\s*$/.exec(before);
  const one = /([a-z']+)(?:\s+(?:both|each|all))?\s*$/.exec(before);
  if (one === null) return undefined;
  const known = (w: string): boolean =>
    PRONOUN.test(w) || w === 'i' || w === 'me' || memberByWord(w, scan.ctx.members) !== undefined;
  const words = two !== null && known(two[1]!) && known(two[2]!) ? [two[1]!, two[2]!] : [one[1]!];
  const ids: MemberId[] = [];
  for (const w of words) {
    if (PRONOUN.test(w)) {
      const r = resolvePronoun(scan, w, before.lastIndexOf(w));
      if (r === undefined) return undefined;
      ids.push(...r);
    } else if (w === 'i' || w === 'me') {
      ids.push(scan.ctx.senderMemberId);
    } else {
      const id = memberByWord(w, scan.ctx.members);
      if (id === undefined) return undefined;
      ids.push(id);
    }
  }
  return ids.length > 0 ? uniq(ids) : undefined;
}

const SHARE_VERB =
  /\b(?:owes?|pays?|paying|covers?|will pay|'ll pay|should pay|can pay|gives? me|venmos? me|sends? me)\s+(?:me\s+)?(?:back\s+)?$/;

interface Roles {
  readonly unsure?: string;
  readonly payer?: ExpenseDraft['payer'];
  readonly oweTotal?: boolean;
  readonly weightsCtx: boolean;
  readonly weights: { memberId: MemberId; weight: number }[];
}

/** Assigns each amount a role (total, share, aside…) and finds owe-style payers. */
function assignRoles(scan: Scan): Roles {
  const { low, amounts, ctx } = scan;
  const weightsCtx = /\b(weighted|weights?|by weight|ratio)\b/.test(low);
  const weights: { memberId: MemberId; weight: number }[] = [];
  let payer: ExpenseDraft['payer'] | undefined;
  let oweTotal = false;

  // "6x €11.35 = 68.10": the operand and the unit are asides once a total follows "=".
  const hasEquals = /=\s*[€$£]?\s*\d/.test(low);
  for (const t of amounts) {
    const before = low.slice(0, t.start);
    const after = low.slice(t.end);
    if (t.inParens) t.role = 'paren';
    else if (/\d\s*[x×*]\s*$/.test(before)) t.role = hasEquals ? 'operand' : 'unit';
    else if (/^\s*[x×*]\s*\d/.test(after) || (hasEquals && /^\s*=/.test(after))) t.role = 'operand';
    if (/^\s*each\b/i.test(after)) t.each = true;
  }

  // weights: "dean 1 maya 1 sam 2" (only with a weights word) and "priya pays double"
  if (weightsCtx) {
    for (const t of amounts) {
      if (t.explicit || t.role !== 'total') continue;
      const before = low.slice(0, t.start);
      const who = /([a-z']+)\s*$/.exec(before)?.[1];
      const id =
        who === undefined
          ? undefined
          : who === 'me' || who === 'i'
            ? ctx.senderMemberId
            : memberByWord(who, ctx.members);
      if (id !== undefined && Number(t.decimal) > 0 && Number(t.decimal) <= 20) {
        t.role = 'weight';
        weights.push({ memberId: id, weight: Number(t.decimal) });
      }
    }
  }
  for (const m of low.matchAll(
    /\b(pays?|covers?|takes?)\s+(double|twice|triple|2x|3x|x2|x3|two shares|three shares)\b/g,
  )) {
    const who = subjectBefore(scan, m.index);
    if (who === undefined) return { unsure: 'weight_subject', weightsCtx, weights };
    const w = /triple|3x|x3|three/.test(m[2]!) ? 3 : 2;
    for (const id of who) weights.push({ memberId: id, weight: w });
  }

  // "i owe dean €20 for the tickets": Dean paid, all of it is the sender's.
  const oweTo = /\bi\s+owe\s+([a-z']+)\s+(?:you\s+)?$/;
  // "sam owes me 20": the sender paid; Sam's share.
  for (const t of amounts) {
    if (t.role !== 'total') continue;
    const before = low.slice(0, t.start);
    const owe = oweTo.exec(before);
    if (owe !== null) {
      const id = memberByWord(owe[1]!, ctx.members);
      if (id === undefined) return { unsure: 'owe_unknown_member', weightsCtx, weights };
      payer = { kind: 'member', memberId: id };
      t.role = 'share';
      t.owners = [ctx.senderMemberId];
      oweTotal = true;
      continue;
    }
    if (SHARE_VERB.test(before)) {
      const verbAt = before.search(SHARE_VERB);
      const who = subjectBefore(scan, verbAt);
      if (who === undefined) {
        // "venmo me 20 each" has no subject: that's a per-person total.
        if (/\b(?:venmo|zelle|pay|send|give)\s+me\s*$/.test(before)) continue;
        return { unsure: 'share_subject', weightsCtx, weights };
      }
      t.role = 'share';
      t.owners = who;
      if (/\bowes?\s+me\s+(?:back\s+)?$/.test(before))
        payer ??= { kind: 'member', memberId: ctx.senderMemberId };
      continue;
    }
    // "Dean owes 40, Maya 30": a name right before a bare amount is that member's share.
    if (!t.explicit || /,\s*[a-z']+\s+$/.test(before)) {
      const who = /(?:^|[\s,])([a-z']+)\s+$/.exec(before)?.[1];
      const id = who === undefined ? undefined : memberByWord(who, ctx.members);
      if (
        id !== undefined &&
        !/\b(?:paid|got|covered|spent)\s*$/.test(before.slice(0, -(who!.length + 1)))
      ) {
        t.role = 'share';
        t.owners = [id];
      }
    }
  }
  // "sam owes me 20" with nothing else: that IS the expense.
  const totals = amounts.filter((t) => t.role === 'total');
  if (totals.length === 0) {
    const shares = amounts.filter((t) => t.role === 'share');
    if (shares.length === 1 && (oweTotal || /\bowes?\s+me\b/.test(low))) {
      oweTotal = true;
      payer ??= { kind: 'member', memberId: ctx.senderMemberId };
    }
  }
  return {
    ...(payer !== undefined ? { payer } : {}),
    oweTotal,
    weightsCtx,
    weights,
  };
}

const PAYER_VERB = '(?:paid|covered|got|grabbed|bought|picked up|fronted|put|spent|treated)';

function findPayer(scan: Scan, segment?: [number, number]): ExpenseDraft['payer'] {
  const { low, orig, ctx } = scan;
  const [a, b] = segment ?? [0, low.length];
  const text = low.slice(a, b);
  const mine = new RegExp(`\\b(?:i|i've|ive|i just|just)\\s+${PAYER_VERB}\\b`);
  const iAt = text.search(mine);
  let named: { at: number; payer: ExpenseDraft['payer'] } | undefined;
  for (const m of text.matchAll(new RegExp(`([a-z']+)\\s+(?:just\\s+)?${PAYER_VERB}\\b`, 'g'))) {
    const word = m[1]!;
    if (/^(i|i've|ive|just|we|you|who|trav|and|so|then|also|me)$/.test(word)) continue;
    const id = memberByWord(word, ctx.members);
    if (id !== undefined) {
      named = { at: m.index, payer: { kind: 'member', memberId: id } };
      break;
    }
    // A capitalized word that is not a member ("Alex paid") is a payer we can't put on the tab.
    const raw = orig.slice(a + m.index, a + m.index + word.length);
    if (/^[A-Z][a-z]+$/.test(raw) && !/^(The|My|Our|We|They|He|She|It|Dinner|Lunch)$/.test(raw)) {
      named = { at: m.index, payer: { kind: 'unknown', name: raw } };
      break;
    }
  }
  if (named !== undefined && (iAt < 0 || named.at < iAt)) return named.payer;
  // "we paid €84": several people paid, so who goes on the tab is a question (r1 #11)
  if (iAt < 0 && new RegExp(`\\bwe\\s+(?:just\\s+|all\\s+|both\\s+)?${PAYER_VERB}\\b`).test(text)) {
    return { kind: 'unknown', name: '' };
  }
  return { kind: 'member', memberId: ctx.senderMemberId };
}

/** Text spans that name the payer or the creditor; names there are not "who's in". */
function payerSpans(low: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of low.matchAll(new RegExp(`([a-z']+)\\s+(?:just\\s+)?${PAYER_VERB}\\b`, 'g'))) {
    out.push([m.index, m.index + m[1]!.length]);
  }
  for (const m of low.matchAll(/\bi\s+owe\s+([a-z']+)/g)) {
    const s = m.index + m[0].length - m[1]!.length;
    out.push([s, s + m[1]!.length]);
  }
  return out;
}

function countOf(word: string): number {
  return WORD_NUMBERS[word] ?? Number(word);
}

/** "the 5 of us from razz": an activity named in the text, or the only roster near now. */
function rosterFor(scan: Scan, n: number): MemberId[] | undefined {
  const rosters = (scan.ctx.rosters ?? []).filter((r) => r.inMemberIds.length === n);
  if (rosters.length === 0) return undefined;
  const words = (scan.low.match(/[a-z]{3,}/g) ?? []).filter(
    (w) =>
      !/^(the|and|for|from|with|was|were|our|all|but|just|only|dinner|lunch|tonight|last|night)$/.test(
        w,
      ),
  );
  const named = rosters.filter((r) => {
    const label = `${r.name} ${r.venue ?? ''}`.toLowerCase();
    const parts = label.match(/[a-z]{3,}/g) ?? [];
    return words.some((w) => parts.some((p) => p.startsWith(w)));
  });
  const pick = (rs: readonly ParseRoster[]): MemberId[] | undefined => {
    const sets = uniq(rs.map((r) => [...r.inMemberIds].sort().join(',')));
    return sets.length === 1 ? [...rs[0]!.inMemberIds] : undefined;
  };
  if (named.length > 0) return pick(named);
  const now = scan.ctx.now;
  if (now === undefined) return undefined;
  const t = Date.parse(now);
  const window = 18 * 3600_000;
  const at = (r: ParseRoster): number => Date.parse(r.startsAt ?? '');
  // The activity that just happened (any headcount): "the 5 of us" right after
  // Razzmatazz is the Razzmatazz roster, if it has exactly 5 in.
  const latest = (scan.ctx.rosters ?? [])
    .filter((r) => at(r) <= t && t - at(r) <= window)
    .sort((a, b) => at(b) - at(a))[0];
  if (latest !== undefined && latest.inMemberIds.length === n) return [...latest.inMemberIds];
  // Otherwise only one unambiguous roster of that size around now.
  const near = rosters.filter((r) => Math.abs(at(r) - t) <= window);
  return near.length > 0 ? pick(near) : undefined;
}

interface ParticipantResult {
  readonly spec?: ParticipantSpec;
  readonly restToPayer: boolean;
}

interface PersonRun {
  /** list: a list construction; absent: next to an absence cue; stray: anything else. */
  readonly kind: 'list' | 'absent' | 'stray';
  readonly ids: readonly MemberId[];
  /** "with/between/among X": the payer is in too. */
  readonly withPayer: boolean;
}

/**
 * "wasn't there", "not", "without", "sick", "left", "skipped"… A member who
 * "already paid me his part" was in but settled directly: that is not an
 * absence (excluding them would overcharge the rest), so it stays a question.
 */
const ABSENCE_CUE =
  /\b(?:not|without|wasn'?t|isn'?t|didn'?t|did not|was not|is not|out|sick|left|leaving|skipped|skip|missed|bailed|stayed (?:in|home|back)|went home|asleep|no show|no-show)\b/;
const SETTLED_CUE = /\b(?:already paid|paid (?:me )?(?:back|his|her|their)|paid me)\b/;
/** True when a clause holds only names, "i"/"me", joiners and "too"/"as well". */
function onlyNames(clause: string, members: readonly ParseMember[]): boolean {
  const words = clause
    .replace(/\bas well\b/g, ' ')
    .split(/[\s&+]+/)
    .filter((w) => w.length > 0);
  return words.every(
    (w) => /^(?:and|i|me|myself|too|also)$/.test(w) || memberByWord(w, members) !== undefined,
  );
}

/** What may sit right before a list: "for", "with", "between", "just", "only"… */
const LIST_LEAD =
  /\b(?:for|with|between|among|amongst|just|only|including|incl|plus|and also)\s+(?:the\s+)?$/;
const WITH_LEAD = /\b(?:with|between|among|amongst)\s+(?:the\s+)?$/;

/**
 * Groups the people a span names into runs ("me, maya and sam", "jordan and
 * i", "henry") and classifies each (T-010 r1 #1, #4). Payers ("Jordan got")
 * and creditors ("i owe Dean") are not people in the split and are skipped.
 * "i" counts only inside a run of two or more ("jordan and i").
 */
function personRuns(scan: Scan, span: [number, number]): PersonRun[] {
  const { ctx } = scan;
  const low = scan.low;
  const spans = payerSpans(low);
  type Tok = { start: number; end: number; id: MemberId; self: boolean; word: string };
  const toks: Tok[] = scan.names
    .filter((h) => h.start >= span[0] && h.end <= span[1])
    .filter((h) => !spans.some(([a, b]) => h.start >= a && h.end <= b + 2))
    .map((h) => ({ start: h.start, end: h.end, id: h.memberId, self: false, word: 'name' }));
  for (const m of low.slice(span[0], span[1]).matchAll(/\b(me|myself|i)\b/g)) {
    const start = span[0] + m.index;
    toks.push({ start, end: start + m[0].length, id: ctx.senderMemberId, self: true, word: m[1]! });
  }
  toks.sort((a, b) => a.start - b.start);
  const groups: Tok[][] = [];
  for (const t of toks) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    const gap = low.slice(prev?.end ?? 0, t.start);
    // "me maya and sam, henry wasn't there": past a comma, a name whose own
    // clause says they were out starts a new run instead of joining the list.
    const ownClause = low.slice(t.end).split(/[,;.:()]|\sbut\s/)[0] ?? '';
    const absentAfterComma =
      /,/.test(gap) && (ABSENCE_CUE.test(ownClause) || /n't\b/.test(ownClause));
    // "with maya, henry's paying next time": past a comma, a name joins the
    // list only when its own clause is more names ("and i", "too"), never a
    // clause of its own (T-010 r2 #1).
    const clauseAfterComma = /,/.test(gap) && !onlyNames(ownClause, ctx.members);
    if (
      prev !== undefined &&
      !last!.some((x) => x.id === t.id) && // "me and sam, sam wasn't there": a new clause
      !absentAfterComma &&
      !clauseAfterComma &&
      /^\s*(?:,\s*(?:and\s+)?|and|&|\+|)\s*$/.test(gap)
    ) {
      last!.push(t);
    } else groups.push([t]);
  }
  const out: PersonRun[] = [];
  for (const g of groups) {
    // a lone "i"/"me" is the speaker talking ("i paid", "on me"), not a list
    const names = g.filter((t) => !t.self);
    const selves = g.filter((t) => t.self);
    if (names.length === 0 && (selves.length === 0 || selves.some((t) => t.word === 'i'))) continue;
    const start = g[0]!.start;
    const end = g[g.length - 1]!.end;
    // "i" right before a payment verb ("jordan and i paid") is a payer, handled elsewhere
    const before = low.slice(0, start);
    const after = low.slice(end);
    const clauseStart = Math.max(
      ...[',', ';', '.', ':', '('].map((c) => before.lastIndexOf(c)),
      before.lastIndexOf(' but '),
    );
    const nextStop = after.search(/[,;.:()]|\sbut\s/);
    const clause = low.slice(clauseStart + 1, nextStop < 0 ? low.length : end + nextStop);
    const runText = low.slice(start, end);
    const trimmed = clause.trim().replace(/^(?:and|just|only|plus|so)\s+/, '');
    const clauseOnly = trimmed.replace(/\s+(?:too|as well|also)$/, '') === runText.trim();
    // "maya too": adds to the payer, never the whole list (T-010 r2 #2)
    const adds = clauseOnly && /\s(?:too|as well|also)$/.test(trimmed);
    const ids = uniq(g.map((t) => t.id));
    const hasSelf = selves.length > 0;
    if (names.length === 0) {
      // "for me", "just me": the speaker alone, only after a list lead
      if (LIST_LEAD.test(before))
        out.push({ kind: 'list', ids, withPayer: WITH_LEAD.test(before) });
      continue;
    }
    if (LIST_LEAD.test(before) || clauseOnly || (hasSelf && g.length >= 2)) {
      out.push({ kind: 'list', ids, withPayer: adds || WITH_LEAD.test(before) });
    } else if (!SETTLED_CUE.test(clause) && (ABSENCE_CUE.test(clause) || /n't\b/.test(clause))) {
      out.push({ kind: 'absent', ids: names.map((t) => t.id), withPayer: false });
    } else {
      out.push({ kind: 'stray', ids: names.map((t) => t.id), withPayer: false });
    }
  }
  return out;
}

/** Who is in, from one span of the text (the whole message or one expense's part of it). */
function parseParticipants(
  scan: Scan,
  span: [number, number],
  payer: ExpenseDraft['payer'],
  shareOwners: readonly MemberId[],
): ParticipantResult {
  const { ctx } = scan;
  const low = scan.low.slice(span[0], span[1]);
  const sender = ctx.senderMemberId;
  const all = ctx.members.map((m) => m.memberId);
  const size = all.length;
  const restToPayer =
    /\b(?:the )?rest(?: of it)? (?:is|'s|on) (?:mine|me)\b|\bi'?ll (?:cover|take|pay) the rest\b|\brest is on me\b/.test(
      low,
    );
  const payerId = payer.kind === 'member' ? payer.memberId : undefined;

  const vague = VAGUE_GROUP.exec(low);
  if (vague !== null && !/\beveryone else\b/.test(low)) {
    return { spec: { kind: 'vague', phrase: vague[0].trim() }, restToPayer };
  }

  // except
  const except =
    /\b(?:everyone|everybody|all(?: of us)?|the (?:whole )?group|the rest of us)\s+(?:but|except(?: for)?|minus|other than|apart from|besides|excluding|without|bar)\s+(.+?)(?=$|[,.;(]|\s(?:so|since|because|for|split|and then)\s)|\b(?:except(?: for)?|excluding|minus)\s+(.+?)(?=$|[,.;(]|\s(?:so|since|because|for|split)\s)|\(\s*not\s+(.+?)\s*\)/.exec(
      low,
    );
  if (except !== null) {
    const list = except[1] ?? except[2] ?? except[3] ?? '';
    const ids: MemberId[] = [];
    for (const w of list.split(/\s*(?:,|\band\b|&|\bor\b)\s*/).filter((x) => x.length > 0)) {
      const word = w.replace(/^(?:the|just)\s+/, '').trim();
      if (word === 'me' || word === 'myself') ids.push(sender);
      else {
        const id = memberByWord(word, ctx.members);
        if (id === undefined) return { spec: { kind: 'vague', phrase: w }, restToPayer };
        ids.push(id);
      }
    }
    if (ids.length > 0 && ids.length < size)
      return { spec: { kind: 'except', ids: uniq(ids) }, restToPayer };
  }

  // counts
  let n: number | undefined;
  const countRe = new RegExp(
    `\\b(?:the|all|us|just the|only the)?\\s*${COUNT_WORD}\\s+of\\s+(?:us|you)\\b|\\b(?:split\\s+(?:it\\s+)?)?${COUNT_WORD}\\s+ways\\b|\\b(\\d{1,2})\\s*[x×]\\s*[€$£]?\\d|\\ball\\s+${COUNT_WORD}\\b`,
  );
  const cm = countRe.exec(low);
  if (cm !== null) n = countOf(cm[1] ?? cm[2] ?? cm[3] ?? cm[4] ?? '');
  if (
    /\b(?:half each|50\s*\/\s*50|50-50|fifty fifty|halves|half and half|in half|both of us|the two of us|us two)\b/.test(
      low,
    )
  ) {
    n ??= 2;
  }

  // Who the message names, and how (T-010 r1 #1): a name is in the split only
  // inside a list construction; a name next to an absence cue is left out; a
  // name anywhere else is a question, never a guess.
  const runs = personRuns(scan, span);
  const listed: MemberId[] = [];
  const absent: MemberId[] = [];
  const stray: MemberId[] = [];
  let withPayer = false;
  for (const run of runs) {
    if (run.kind === 'list') {
      listed.push(...run.ids);
      if (run.withPayer) withPayer = true;
    } else if (run.kind === 'absent') absent.push(...run.ids);
    else stray.push(...run.ids);
  }
  const owners = uniq(shareOwners);
  const listIds = uniq([
    ...listed,
    ...owners,
    ...(/\b(?:both of us|the two of us|us two)\b/.test(low) ? [sender] : []),
    ...(withPayer && payerId !== undefined ? [payerId] : []),
    ...(restToPayer && (listed.length > 0 || owners.length > 0) && payerId !== undefined
      ? [payerId]
      : []),
  ]);
  const known = new Set([...listIds, ...(payerId !== undefined ? [payerId] : [])]);
  const unexplained = uniq(stray).filter((id) => !known.has(id));
  const absentIds = uniq(absent).filter((id) => !owners.includes(id));
  if (unexplained.length > 0) {
    return { spec: { kind: 'vague', phrase: 'names' }, restToPayer };
  }
  if (absentIds.some((id) => listIds.includes(id))) {
    return { spec: { kind: 'vague', phrase: 'names' }, restToPayer };
  }

  const everyElse = /\beveryone else\b|\beverybody else\b|\bthe rest of us\b/.test(low);
  const everyoneWord =
    /\b(?:everyone|everybody|all of us|all of you|the whole group|whole group|the group|split it all|for all|every one of us)\b/.test(
      low,
    );
  // "evenly"/"equally" says how, not who: everyone only when nobody is listed (r1 #2)
  const evenly = /\b(?:evenly|equally)\b/.test(low) && listIds.length === 0;
  if (absentIds.length > 0) {
    // "henry wasn't there", "everyone else", "not henry": everyone but them
    if (listIds.length > 0) return { spec: { kind: 'list', ids: listIds }, restToPayer };
    if (n === undefined || n === size - absentIds.length) {
      return absentIds.length < size
        ? { spec: { kind: 'except', ids: absentIds }, restToPayer }
        : { spec: { kind: 'vague', phrase: 'names' }, restToPayer };
    }
    return { spec: { kind: 'vague', phrase: 'names' }, restToPayer };
  }
  if (everyElse) {
    // "everyone else" without anyone left out by name (r1 #3): only with
    // fixed shares ("Dean pays 20, everyone else splits the rest") is it everyone.
    return owners.length > 0
      ? { spec: { kind: 'everyone' }, restToPayer }
      : { spec: { kind: 'vague', phrase: 'everyone else' }, restToPayer };
  }
  const everyone = everyoneWord || evenly || (n !== undefined && n === size);

  if (everyone) return { spec: { kind: 'everyone' }, restToPayer };
  if (n !== undefined) {
    if (listIds.length === n) return { spec: { kind: 'list', ids: listIds }, restToPayer };
    if (listIds.length === 0 || listIds.length < n) {
      const roster = rosterFor(scan, n);
      if (roster !== undefined && listIds.every((id) => roster.includes(id))) {
        return { spec: { kind: 'list', ids: roster }, restToPayer };
      }
    }
    return { spec: { kind: 'count', n }, restToPayer };
  }
  if (listIds.length > 0) return { spec: { kind: 'list', ids: listIds }, restToPayer };
  return { restToPayer };
}

const DESC_STOP =
  /\s*(?:,|;|:|\.|\(|\?|!|\s(?:(?:and|with|without|minus|excluding|not|split|between|among|but|except|so|since|because|on|for|me|just|only|each|was|were|is|cost|came|i|we|plus|then|x|evenly|equally|everyone|everybody|half|the \d+ of us)(?=\s|$|[,.;:!?])|=|50\/50|\d|[€$£]))/;
const ARTICLE = /^(?:the|a|an|our|my|some|his|her|their|us)\s+/;
const NOT_DESC =
  /^(?:me|us|you|everyone|everybody|all|the group|both|each|it|that|this|them|him|her|the tab|tab|my card|my|i|the \d+ of us|\d+ of us|today|tonight|tomorrow|yesterday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|later|earlier|before|after|tip|tips|tax|vat|service|gratuity|fee|fees)\b/;

function phraseAt(text: string): string | undefined {
  let t = text.trimStart().replace(ARTICLE, '');
  const countLead = new RegExp(`^(?:the\\s+)?${COUNT_WORD}\\s+of\\s+us(?:\\s+|$)`);
  t = t.replace(countLead, '');
  // "2 waters at razz": a leading count stays with its noun (r1 #10)
  const count = /^(\d{1,2})\s+(?=[a-z])/.exec(t);
  if (count !== null) t = t.slice(count[0].length);
  const stop = DESC_STOP.exec(` ${t}`);
  let phrase = (stop === null ? t : ` ${t}`.slice(1, stop.index)).trim();
  // "dinner at 9", "the uber tonight": no dangling preposition or time word
  for (;;) {
    const trimmed = phrase.replace(DESC_TAIL, '').trim();
    if (trimmed === phrase) break;
    phrase = trimmed;
  }
  if (phrase.length === 0 || !/[a-z]/.test(phrase) || NOT_DESC.test(phrase)) return undefined;
  const words = phrase.split(/\s+/).slice(0, 4);
  if (words.length === 0 || /^\d/.test(words[0]!)) return undefined;
  return `${count !== null ? `${count[1]!} ` : ''}${words.join(' ')}`;
}

const DESC_TAIL =
  /\s+(?:at|in|on|from|to|of|the|a|an|by|near|tonight|today|yesterday|last|night|earlier|this|morning|afternoon|evening|again|too)$/;

/** The noun that set the category ("cab", "cava"), for when nothing better was said. */
function categoryWord(text: string): string | undefined {
  for (const [, re] of CATEGORY_WORDS) {
    const m = re.exec(text);
    if (m !== null) return m[1];
  }
  return undefined;
}

/** What the expense was for, from its part of the message. */
function describe(low: string, scan: Scan): string | undefined {
  const isMember = (p: string): boolean =>
    p.split(/\s+/).every((w) => memberByWord(w, scan.ctx.members) !== undefined);
  const tries: (string | undefined)[] = [];
  for (const m of low.matchAll(/\bfor\s+/g)) tries.push(phraseAt(low.slice(m.index + m[0].length)));
  // "the taxi was €32", "kebabs were on me"
  const was =
    /(?:^|[,;:]\s*|\s)((?:the |our |my )?(?:\d{1,2} )?[a-z][a-z' ]{1,40}?)\s+(?:was|were|is|came to|cost|costs)\b/.exec(
      low,
    );
  if (was !== null) {
    const p = was[1]!
      .replace(ARTICLE, '')
      .trim()
      .split(/\s+/)
      .slice(/^\d/.test(was[1]!.replace(ARTICLE, '')) ? 0 : -4)
      .slice(0, 5)
      .join(' ');
    const cleaned = p.replace(/^(?:and|so|then|ok|okay|yeah)\s+/, '');
    tries.push(cleaned.length > 0 && !NOT_DESC.test(cleaned) ? cleaned : undefined);
  }
  // "kebabs on me", "dinner's on my card"
  const onMe =
    /^(?:the |our )?([a-z][a-z' ]{1,30}?)(?:'s|\s+(?:is|was|were|are))?\s+on (?:me|my card)\b/.exec(
      low,
    );
  if (onMe !== null) tries.push(NOT_DESC.test(onMe[1]!) ? undefined : onMe[1]!.trim());
  // "got the metro cards", "got everyone coffee", "covered groceries at the supermarket"
  for (const m of low.matchAll(
    /\b(?:got|bought|covered|grabbed|picked up|paid for|split|treated (?:everyone|us) to)\s+(?:everyone\s+|us\s+|the group\s+|all of us\s+)?/g,
  )) {
    tries.push(phraseAt(low.slice(m.index + m[0].length).replace(/\s+at\s+.*$/, '')));
  }
  // "the €25 laundromat", "€18.50 ice cream for", "$142 dinner at conch corner"
  for (const t of scan.amounts) {
    if (t.start < 0 || t.merged === true) continue; // "+ €10 tip" describes nothing on its own
    const rel = low.indexOf(scan.low.slice(t.start, t.end));
    if (rel < 0) continue;
    const after = low.slice(rel + (t.end - t.start));
    if (/^\s*(?:for|on|each|split|with|between|to|in|euros?|eur|usd)\b/.test(after)) continue;
    tries.push(phraseAt(after));
  }
  // "split the airbnb cleaning fee €60", "taxi €18 split"
  for (const t of scan.amounts) {
    const rel = low.indexOf(scan.low.slice(t.start, t.end));
    if (rel < 0) continue;
    const before = low.slice(0, rel).trimEnd();
    const m = /(?:^|[\s,])(?:split|add|put|log|for)?\s*(?:the\s+)?([a-z][a-z' ]{1,40})$/.exec(
      before,
    );
    if (m === null) continue;
    const words = m[1]!
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    const kept: string[] = [];
    for (let i = words.length - 1; i >= 0 && kept.length < 4; i -= 1) {
      const w = words[i]!;
      if (
        /^(?:paid|i|me|was|were|is|for|the|split|add|put|log|on|and|with|of|tab|weighted|a|an|venmo|trav|plus|then|also)$/.test(
          w,
        )
      )
        break;
      kept.unshift(w);
    }
    if (kept.length > 0) tries.push(kept.join(' '));
  }
  for (const p of tries) if (p !== undefined && !isMember(p)) return p;
  return undefined;
}

function cleanDescription(d: string | undefined, low: string): string {
  const base = (d ?? '').replace(/\s+/g, ' ').trim();
  if (base.length > 0 && /[a-z]/.test(base)) return base.slice(0, 40);
  // the noun the sender used, never the category name ("€32 transport", r1 #10)
  return categoryWord(low) ?? 'expense';
}

/** Splits "84 for dinner and 20 for the cab" at the separator before each later total. */
function segmentsFor(low: string, totals: readonly AmountTok[]): [number, number][] {
  const cuts: number[] = [0];
  for (let i = 1; i < totals.length; i += 1) {
    const prev = totals[i - 1]!;
    const cur = totals[i]!;
    const between = low.slice(prev.end, cur.start);
    let best = -1;
    for (const m of between.matchAll(/\s+and\s+|\s*[,;]\s*|\s+plus\s+|\s+then\s+|\s*&\s*/g))
      best = m.index;
    cuts.push(best < 0 ? cur.start : prev.end + best);
  }
  cuts.push(low.length);
  const out: [number, number][] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) out.push([cuts[i]!, cuts[i + 1]!]);
  return out;
}

function itemized(scan: Scan, total: AmountTok): ExpenseDraft['lineItems'] | 'unsure' | undefined {
  const { low, ctx } = scan;
  const colon = low.indexOf(':', total.start);
  if (colon < 0 || colon - total.end > 3) return undefined;
  const body = low.slice(colon + 1);
  const clauses = body.split(/\s*[,;]\s*/).filter((c) => c.trim().length > 0);
  const lines: { label: string; decimal: string; claimants: MemberId[]; countN?: number }[] = [];
  for (const clause of clauses) {
    const offset = colon + 1 + body.indexOf(clause);
    const toks = scan.amounts.filter(
      (t) => t.role !== 'weight' && t.start >= offset && t.end <= offset + clause.length,
    );
    if (toks.length === 0) return undefined;
    if (toks.length > 1) return 'unsure';
    const tok = toks[0]!;
    const claimants: MemberId[] = [];
    if (/(?:^|\s)(?:i|me|my|mine)(?:\s|$)/.test(clause)) claimants.push(ctx.senderMemberId);
    for (const h of scan.names)
      if (h.start >= offset && h.end <= offset + clause.length) claimants.push(h.memberId);
    const count = new RegExp(`\\b(?:the|all)?\\s*${COUNT_WORD}\\s+of\\s+us\\b`).exec(clause);
    const everyone = /\b(?:everyone|all of us|everybody|shared|the table)\b/.test(clause);
    const label = clause
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[€$£]\s?\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*\s?(?:[€$£]|euros?)?/g, ' ')
      .replace(new RegExp(`\\b(?:the|all)?\\s*${COUNT_WORD}\\s+of\\s+us\\b`, 'g'), ' ')
      .replace(
        /\b(?:i|me|my|mine|had|got|split|shared|ordered|and|for|the|a|an|was|were|is|everyone|all of us)\b/g,
        ' ',
      )
      .replace(
        new RegExp(
          `\\b(?:${ctx.members.map((m) => escapeRe(m.displayName.toLowerCase())).join('|') || 'zzz'})\\b`,
          'g',
        ),
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();
    lines.push({
      label: label.length > 0 ? label.split(' ').slice(0, 3).join(' ') : 'item',
      decimal: tok.decimal,
      claimants: uniq(claimants),
      ...(count !== null ? { countN: countOf(count[1]!) } : everyone ? { countN: -1 } : {}),
    });
  }
  if (lines.length < 2) return undefined;
  const union = uniq(lines.flatMap((l) => l.claimants));
  const out = [];
  for (const l of lines) {
    let claimants = l.claimants;
    if (l.countN !== undefined) {
      if (l.countN === -1 || l.countN === union.length) claimants = union;
      else if (l.countN === ctx.members.length) claimants = ctx.members.map((m) => m.memberId);
      else return 'unsure';
    }
    if (claimants.length === 0) return 'unsure';
    out.push({ label: l.label, decimal: l.decimal, claimants });
  }
  const sum = out.reduce((a, l) => a + decimalToCents(l.decimal), 0);
  if (sum !== decimalToCents(total.decimal)) return 'unsure';
  for (const l of out) {
    const tok = scan.amounts.find((t) => t.decimal === l.decimal && t.start > colon);
    if (tok !== undefined) tok.role = 'paren';
  }
  return out;
}

/** Parses one message. `text` is the sender's own words (quoted lines already removed). */
export function parseExpenseText(text: string, ctx: ExpenseTextContext): ExpenseTextParse {
  if (ctx.members.length === 0) return { kind: 'none' };
  const orig = cleanText(text);
  const low = orig.toLowerCase();
  if (low.length === 0 || low.length > 600) return { kind: 'none' };
  const names = findNames(low, ctx.members);
  const amounts = scanAmounts(low, ctx.members);
  const scan: Scan = { orig, low, ctx, names, amounts };
  const noParens = low.replace(/\([^)]*\)/g, ' ');

  const strong = STRONG_CUE.test(noParens);
  const weak = WEAK_CUE.test(noParens) && amounts.length > 0;
  // "€18.50 ice cream for me and priya": the message leads with an amount and says who it's for.
  const forWhom =
    amounts.length > 0 &&
    amounts[0]!.start <= 30 &&
    (names.length > 0 ||
      /\b(?:me and|for me|for us|everyone|everybody|all of us|of us|ways)\b/.test(noParens));
  if (!strong && !weak && !forWhom) return { kind: 'none' };
  if (QUESTION_START.test(low) || REQUEST_START.test(low) || SUGGESTION_START.test(low)) {
    return { kind: 'none' };
  }
  if (
    /\?/.test(noParens) &&
    !/\b(?:i|we)\s+(?:paid|got|covered|bought|spent)\b|\b(?:put|add|log|split)\b/.test(noParens)
  ) {
    return { kind: 'none' };
  }
  if (
    /\b(?:get|book|buy|reserve|find)\s+(?:us|me|the \d+ of us|\d+|some|a|an|tickets?)\b/.test(
      low,
    ) &&
    !/\b(?:paid|got|covered|bought|spent|owe)\b/.test(low)
  ) {
    return { kind: 'none' };
  }
  if (amounts.length === 0) {
    // "i paid for dinner" / "Jordan got the taxi": a statement with the amount missing.
    const m =
      /\b(?:paid for|covered|got|grabbed|bought|picked up)\s+(?:the |a |an |everyone |us |our )?([a-z][a-z' ]{1,30})/.exec(
        low,
      );
    if (
      m === null ||
      !isSpendNoun(m[1]!) ||
      !/\b(?:paid|covered|got|grabbed|bought|picked up)\b/.test(low)
    ) {
      return { kind: 'none' };
    }
  }
  if (NO_LOG.test(low)) return { kind: 'no_log' };

  // "-€20": a refund or a correction, not something to log blind (r1 #9).
  if (amounts.some((t) => t.negative)) return { kind: 'unsure', reason: 'negative_amount' };
  // "for !!!", "for ...": a description that is only punctuation (r1 #6)
  if (/\b(?:for|on)\s+\p{P}+\s*(?:[,;]|$)/u.test(low))
    return { kind: 'unsure', reason: 'punctuation_description' };
  const roles = assignRoles(scan);
  if (roles.unsure !== undefined) return { kind: 'unsure', reason: roles.unsure };
  const doubt = CURRENCY_DOUBT.exec(low)?.[1];
  const shares = amounts.filter((t) => t.role === 'share');
  let totals = amounts.filter((t) => t.role === 'total');
  // "were €28, €14 EACH": a per-person figure next to the total restates it.
  // It is checked against the headcount once that is known (T-010 r2 #4).
  const restated: AmountTok[] = [];
  if (totals.some((t) => !t.each) && totals.some((t) => t.each)) {
    for (const t of totals) {
      if (!t.each) continue;
      t.role = 'paren';
      restated.push(t);
    }
    totals = totals.filter((t) => !t.each);
  }
  // "€84 + tip", "€84 +", "€84 for dinner + tip": an extra with no amount is a
  // money fact missing, never logged as the first figure alone (r1 #6, r2 #6).
  for (const t of totals) {
    if (/^\s*(?:\+|plus\b)\s*(?:$|[,;.!?)]|(?:the |a |an )?[a-z])/.test(low.slice(t.end)))
      return { kind: 'unsure', reason: 'unstated_extra' };
  }
  if (/(?:\+|\bplus)\s*(?:the |a |an )?(?:tips?|tax|vat|service|gratuity)\b/.test(low))
    return { kind: 'unsure', reason: 'unstated_extra' };
  // "dinner €84 + €10 tip", "€84 for dinner plus €10 tip": one total (r1 #6).
  // The second figure folds in only when nothing describes it as its own thing.
  const EXTRA = /^\s*(?:(?:the|a|an)\s+)?(?:tips?|tax|vat|service(?: charge)?|gratuity|fees?)\b/;
  for (let i = totals.length - 1; i > 0; i -= 1) {
    const a = totals[i - 1]!;
    const b = totals[i]!;
    const gap = low.slice(a.end, b.start);
    const afterB = low.slice(b.end);
    // "84 for dinner and 10 tip", "…and tipped 10": the extra folds in too (r2 #3)
    const tipJoin = /\btipped\s*$/.test(gap) || (/\band\s*$/.test(gap) && EXTRA.test(afterB));
    if (!/(?:\+|\bplus)\s*$/.test(gap) && !tipJoin) continue;
    const extraOnly = EXTRA.test(afterB) || /^\s*(?:$|[,;.!?)]|(?:for|on)\b)/.test(afterB);
    if (!extraOnly) {
      // "€84 + €20 cab": two things joined by a plus is past these rules
      if (/^\s*(?:\+|plus)\s*$/.test(gap)) return { kind: 'unsure', reason: 'plus_two_things' };
      continue; // "84 for dinner plus 20 for the cab": two expenses, split below
    }
    if (!/^\s*(?:\+|plus)\s*$/.test(gap) && /^\s*(?:for|on)\b/.test(afterB)) continue;
    if (a.currency !== undefined && b.currency !== undefined && a.currency !== b.currency) {
      return { kind: 'unsure', reason: 'mixed_currencies' };
    }
    const sum = centsToDecimal(decimalToCents(a.decimal) + decimalToCents(b.decimal));
    const cur = a.currency ?? b.currency;
    a.merged = true;
    totals[i - 1] = {
      ...a,
      end: b.end,
      decimal: sum,
      ...(cur !== undefined ? { currency: cur } : {}),
      explicit: a.explicit || b.explicit,
    };
    b.merged = true;
    totals.splice(i, 1);
  }
  // "…and he owes me 15 for the cab" beside another total is its own expense,
  // not a share of that one: past these rules (r1 #5).
  if (
    totals.length > 0 &&
    shares.some((s) =>
      /^\s*(?:each\s+)?(?:for|on)\s+(?:the\s+|a\s+|my\s+)?[a-z]/.test(low.slice(s.end)),
    )
  ) {
    return { kind: 'unsure', reason: 'owed_for_something_else' };
  }

  // "me and sam paid €30": two payers in one clause is past these rules.
  for (const m of low.matchAll(
    /\b([a-z']+)\s+(?:and|&)\s+([a-z']+)\s+(?:both\s+)?(?:paid|covered|fronted|bought|split the bill)\b/g,
  )) {
    const isPerson = (w: string): boolean =>
      w === 'me' || w === 'i' || memberByWord(w, ctx.members) !== undefined;
    if (isPerson(m[1]!) && isPerson(m[2]!)) return { kind: 'unsure', reason: 'two_payers' };
  }

  // "6x €11.35" with no "=": the total is the product (in integer cents).
  const unit = amounts.find((t) => t.role === 'unit');
  let unitTotal: DraftAmount | undefined;
  if (totals.length === 0 && unit !== undefined) {
    const mult = /(\d+)\s*[x×*]\s*$/.exec(low.slice(0, unit.start));
    if (mult !== null) {
      unitTotal = {
        decimal: centsToDecimal(decimalToCents(unit.decimal) * Number(mult[1])),
        ...(unit.currency !== undefined ? { currency: unit.currency } : {}),
      };
    }
  }
  // "i owe dean €20" / "sam owes me 20": the one share is the whole expense.
  if (totals.length === 0 && roles.oweTotal && shares.length === 1) {
    const s = shares[0]!;
    const payer = roles.payer ?? { kind: 'member' as const, memberId: ctx.senderMemberId };
    const owners = s.owners ?? [];
    return {
      kind: 'drafts',
      drafts: [
        {
          description: cleanDescription(describe(low, scan), low),
          category: categoryOf(describe(low, scan), low),
          payer,
          amount: {
            decimal: s.decimal,
            ...(s.currency !== undefined ? { currency: s.currency } : {}),
          },
          perPerson: false,
          ...(doubt !== undefined ? { currencyDoubt: doubt } : {}),
          participants: { kind: 'list', ids: owners },
          fixed: owners.map((id) => ({ memberId: id, decimal: s.decimal })),
          weights: [],
          restToPayer: false,
        },
      ],
    };
  }
  if (totals.length === 0 && shares.length > 0)
    return { kind: 'unsure', reason: 'shares_without_total' };

  // itemized: "dinner was €90: i had the steak (€30), …"
  let lineItems: ExpenseDraft['lineItems'];
  if (totals.length >= 1) {
    const it = itemized(scan, totals[0]!);
    if (it === 'unsure') return { kind: 'unsure', reason: 'itemized' };
    if (it !== undefined) {
      lineItems = it;
      totals = [totals[0]!];
    }
  }

  // Accounting guard (r1 #5): every money-looking token lands in a draft, or
  // the message is unsure. Allowed asides: a per-person restatement ("€14
  // each"), an itemized line, a "+" part, arithmetic that matches its total.
  if (lineItems === undefined) {
    for (const t of amounts) {
      if (t.role === 'total' && !totals.includes(t) && !t.merged) {
        return { kind: 'unsure', reason: 'unaccounted_amount' };
      }
      if (t.role === 'paren' && t.explicit && !t.each && t.inParens) {
        return { kind: 'unsure', reason: 'unaccounted_amount' };
      }
      if (t.role === 'operand' || t.role === 'unit') {
        const mult = /(\d+)\s*[x×*]\s*$/.exec(low.slice(0, t.start));
        if (mult === null) continue; // the "6" in "6x": a count
        const product = decimalToCents(t.decimal) * Number(mult[1]);
        const matches =
          totals.some((x) => decimalToCents(x.decimal) === product) ||
          (totals.length === 0 && t.role === 'unit');
        if (!matches) return { kind: 'unsure', reason: 'arithmetic_mismatch' };
      }
    }
  }

  const segments: [number, number][] =
    totals.length <= 1 ? [[0, low.length]] : segmentsFor(low, totals);
  const shareOwners = uniq(shares.flatMap((s) => s.owners ?? []));
  const parts = segments.map((seg, i) => {
    const segLow = low.slice(seg[0], seg[1]);
    const payer = roles.payer ?? findPayer(scan, totals.length <= 1 ? undefined : seg);
    const p = parseParticipants(
      scan,
      seg,
      payer,
      totals.length <= 1 ? uniq([...shareOwners, ...roles.weights.map((w) => w.memberId)]) : [],
    );
    return { seg, segLow, payer, p, total: totals[i] };
  });
  // Several expenses: who's in, said once, applies to all.
  if (parts.length > 1) {
    // A later figure is its own expense only when it is phrased as one: a
    // payment verb, "<amount> for/on …", "<thing> was <amount>", or
    // "<thing> <amount>". "i have €5 left lol" is not (r1 #5).
    for (const x of parts.slice(1)) {
      const t = x.total;
      if (t === undefined) continue;
      const after = low.slice(t.end, x.seg[1]);
      const before = low.slice(x.seg[0], t.start);
      const shaped =
        new RegExp(`\\b${PAYER_VERB}\\b`).test(x.segLow) ||
        /^\s*(?:each\s+)?(?:for|on)\b/.test(after) ||
        /\b(?:was|were|is|came to|cost|costs)\s*$/.test(before) ||
        (/^\s*(?:(?:and|plus|then|&|,)\s+)?(?:the\s+)?[a-z][a-z' ]{1,30}\s*$/.test(before) &&
          !/\b(?:i|we|you|he|she|they|it|have|has|had|still|only|just|and|plus|then)\s*$/.test(
            before,
          ));
      if (!shaped || /\b(?:btw|lol|haha|lmao|left|remaining|budget)\b/.test(x.segLow))
        return { kind: 'unsure', reason: 'aside_amount' };
    }
    // "€84 for dinner, everyone, room was €200": who's in, said before a later
    // amount, is not carried forward to it (r1 #5).
    const firstStated = parts.findIndex((x) => x.p.spec !== undefined);
    if (firstStated >= 0 && parts.slice(firstStated + 1).some((x) => x.p.spec === undefined))
      return { kind: 'unsure', reason: 'participants_before_amount' };
    const stated = parts.filter((x) => x.p.spec !== undefined);
    const specs = uniq(stated.map((x) => JSON.stringify(x.p.spec)));
    if (stated.length > 0 && stated.length < parts.length) {
      if (specs.length !== 1) return { kind: 'unsure', reason: 'participants_per_expense' };
      for (const x of parts) if (x.p.spec === undefined) x.p = stated[0]!.p;
    }
    if (shares.length > 0) return { kind: 'unsure', reason: 'shares_with_several_expenses' };
  }

  const drafts: ExpenseDraft[] = [];
  for (const x of parts) {
    const amount: DraftAmount | undefined =
      x.total !== undefined
        ? {
            decimal: x.total.decimal,
            ...(x.total.currency !== undefined ? { currency: x.total.currency } : {}),
          }
        : unitTotal;
    const desc = describe(parts.length > 1 ? x.segLow : low, scan);
    if (parts.length > 1 && desc === undefined)
      return { kind: 'unsure', reason: 'expense_without_description' };
    const fixed =
      parts.length > 1
        ? []
        : shares.flatMap((s) =>
            (s.owners ?? []).map((id) => ({ memberId: id, decimal: s.decimal })),
          );
    // Currencies must agree within one expense.
    const curs = uniq(
      [x.total, ...(parts.length > 1 ? [] : shares)]
        .filter((t): t is AmountTok => t !== undefined)
        .map((t) => t.currency)
        .filter((c): c is CurrencyCode => c !== undefined),
    );
    if (curs.length > 1) return { kind: 'unsure', reason: 'mixed_currencies' };
    drafts.push({
      description: cleanDescription(desc, parts.length > 1 ? x.segLow : low),
      category: categoryOf(desc, parts.length > 1 ? x.segLow : low),
      payer: x.payer,
      ...(amount !== undefined
        ? {
            amount:
              amount.currency === undefined && curs[0] !== undefined
                ? { ...amount, currency: curs[0] }
                : amount,
          }
        : {}),
      perPerson: x.total?.each === true,
      ...(doubt !== undefined ? { currencyDoubt: doubt } : {}),
      ...(x.p.spec !== undefined ? { participants: x.p.spec } : {}),
      fixed,
      weights: roles.weights,
      restToPayer: x.p.restToPayer,
      ...(lineItems !== undefined ? { lineItems } : {}),
    });
  }
  // "€84 for everyone, 15 each": the each figure restates the total only when
  // the arithmetic agrees (to a cent a head); otherwise ask (T-010 r2 #4).
  if (restated.length > 0) {
    const d = drafts[0];
    const p = d?.participants;
    const n =
      d === undefined || p === undefined || p.kind === 'vague'
        ? 0
        : p.kind === 'count'
          ? p.n
          : participantsOf(d, ctx).length;
    if (drafts.length !== 1) return { kind: 'unsure', reason: 'each_mismatch' };
    // with nobody named yet, the participants question comes first
    if (d?.amount !== undefined && n > 0) {
      const total = decimalToCents(d.amount.decimal);
      for (const r of restated) {
        if (Math.abs(decimalToCents(r.decimal) * n - total) > n)
          return { kind: 'unsure', reason: 'each_mismatch' };
      }
    }
  }
  return { kind: 'drafts', drafts };
}

// ---------- settling ----------

function memberIds(ctx: ExpenseTextContext): MemberId[] {
  return ctx.members.map((m) => m.memberId);
}

function nameOf(ctx: ExpenseTextContext, id: MemberId): string {
  return ctx.members.find((m) => m.memberId === id)?.displayName ?? id;
}

function missingOf(d: ExpenseDraft, ctx: ExpenseTextContext): MissingFact[] {
  const out: MissingFact[] = [];
  if (d.payer.kind === 'unknown') out.push('payer');
  if (d.amount === undefined) out.push('amount');
  else if (d.amount.currency === undefined) {
    if (ctx.tripCurrency === null || d.currencyDoubt !== undefined) out.push('currency');
  } else if (ctx.tripCurrency !== null && d.amount.currency !== ctx.tripCurrency) {
    out.push('trip_currency');
  }
  if (
    d.amount !== undefined &&
    d.amountConfirmed !== true &&
    decimalToCents(d.amount.decimal) > SANITY_MAX_CENTS
  ) {
    out.push('confirm_amount');
  }
  const p = d.participants;
  const single = ctx.members.length === 1;
  if (d.lineItems !== undefined) {
    // an itemized list names who had what
  } else if (p === undefined) {
    if (!ctx.familyTab && !single) out.push('participants');
  } else if (p.kind === 'count' || p.kind === 'vague') {
    out.push('participants');
  } else if (p.kind === 'list' && p.ids.length === 0) {
    out.push('participants');
  }
  return out;
}

function participantsOf(d: ExpenseDraft, ctx: ExpenseTextContext): MemberId[] {
  const all = memberIds(ctx);
  const p = d.participants;
  if (d.lineItems !== undefined) return uniq(d.lineItems.flatMap((l) => l.claimants));
  if (p === undefined || p.kind === 'everyone') return all;
  if (p.kind === 'except') return all.filter((id) => !p.ids.includes(id));
  if (p.kind === 'list') return all.filter((id) => p.ids.includes(id));
  return [];
}

/** One settled expense, or why not. Shares are computed exactly as the ledger will. */
function settle(d: ExpenseDraft, ctx: ExpenseTextContext): ParsedExpense | { unsure: string } {
  if (d.payer.kind !== 'member' || d.amount === undefined) return { unsure: 'incomplete' };
  const currency = d.amount.currency ?? ctx.tripCurrency;
  if (currency === null) return { unsure: 'incomplete' };
  const payer = d.payer.memberId;
  const all = memberIds(ctx);
  if (!all.includes(payer)) return { unsure: 'payer_not_member' };
  let participants = participantsOf(d, ctx);
  if (participants.length === 0) return { unsure: 'no_participants' };
  let unitAmount: Money;
  try {
    unitAmount = parseDecimal(d.amount.decimal, currency);
  } catch {
    return { unsure: 'amount' };
  }
  const amount = d.perPerson
    ? money(unitAmount.amountMinor * participants.length, currency)
    : unitAmount;
  if (amount.amountMinor <= 0) return { unsure: 'zero_amount' };
  const description = d.description;
  const category = d.category;

  if (d.lineItems !== undefined) {
    const split: SplitSpec = {
      method: 'itemized',
      participants,
      lineItems: d.lineItems.map((l, i) => ({
        lineId: `li${String(i + 1)}`,
        label: l.label,
        amount: parseDecimal(l.decimal, currency),
        claimedBy: l.claimants,
        kind: 'item',
      })),
    };
    return { description, category, payer, amount, split };
  }

  if (d.fixed.length > 0) {
    const fixed = new Map<MemberId, number>();
    for (const f of d.fixed) {
      let minor: number;
      try {
        minor = parseDecimal(f.decimal, currency).amountMinor;
      } catch {
        return { unsure: 'share_amount' };
      }
      fixed.set(f.memberId, minor);
    }
    if (d.restToPayer && !participants.includes(payer))
      participants = all.filter((id) => participants.includes(id) || id === payer);
    for (const id of fixed.keys())
      if (!participants.includes(id))
        participants = all.filter((x) => participants.includes(x) || x === id);
    const fixedSum = [...fixed.values()].reduce((a, b) => a + b, 0);
    const rest = amount.amountMinor - fixedSum;
    if (rest < 0) return { unsure: 'shares_over_total' };
    const others = participants.filter((id) => !fixed.has(id));
    const amounts: { memberId: MemberId; amount: Money }[] = [];
    for (const [id, minor] of fixed) amounts.push({ memberId: id, amount: money(minor, currency) });
    if (others.length === 0) {
      if (rest !== 0) return { unsure: 'rest_unassigned' };
    } else if (rest > 0) {
      // The rest is an equal split over everyone else: same rounding as the ledger.
      const probe: Expense = {
        expenseId: 'probe',
        groupId: 'probe',
        tripId: 'probe',
        description,
        category,
        amount: money(rest, currency),
        paidBy: [{ memberId: payer, amount: money(rest, currency) }],
        split: { method: 'equal', participants: others },
        source: 'chat',
        sourceRef: { kind: 'message', id: 'probe' },
        occurredAt: '1970-01-01T00:00:00Z',
        createdAt: '1970-01-01T00:00:00Z',
        createdBy: payer,
        status: 'logged',
      };
      for (const s of ledger.computeShares(probe, {
        memberOrder: all,
        participantsUniverse: all,
      })) {
        if (s.amount.amountMinor > 0) amounts.push({ memberId: s.memberId, amount: s.amount });
      }
    }
    const order = new Map(all.map((id, i) => [id, i] as const));
    amounts.sort((a, b) => (order.get(a.memberId) ?? 0) - (order.get(b.memberId) ?? 0));
    return { description, category, payer, amount, split: { method: 'exact', amounts } };
  }

  if (d.weights.length > 0) {
    const w = new Map(d.weights.map((x) => [x.memberId, x.weight] as const));
    for (const id of w.keys())
      if (!participants.includes(id))
        participants = all.filter((x) => participants.includes(x) || x === id);
    return {
      description,
      category,
      payer,
      amount,
      split: {
        method: 'weighted',
        weights: participants.map((id) => ({ memberId: id, weight: w.get(id) ?? 1 })),
      },
    };
  }

  const p = d.participants;
  if (p?.kind === 'except')
    return { description, category, payer, amount, split: { method: 'exclude', excluded: p.ids } };
  return { description, category, payer, amount, split: { method: 'equal', participants } };
}

/** Settles every draft, or builds the one question for what's missing (VOICE §4.11). */
export function evaluateDrafts(
  drafts: readonly ExpenseDraft[],
  ctx: ExpenseTextContext,
): DraftsEvaluation {
  if (drafts.length === 0) return { kind: 'unsure', reason: 'no_drafts' };
  const missing = drafts.map((d) => missingOf(d, ctx));
  if (missing.some((m) => m.length > 0)) {
    if (missing.filter((m) => m.includes('amount')).length > 1)
      return { kind: 'unsure', reason: 'several_amounts_missing' };
    return { kind: 'clarify', missing, question: questionFor(drafts, missing, ctx) };
  }
  const expenses: ParsedExpense[] = [];
  for (const d of drafts) {
    const s = settle(d, ctx);
    if ('unsure' in s) return { kind: 'unsure', reason: s.unsure };
    expenses.push(s);
  }
  return { kind: 'ready', expenses };
}

// ---------- the question (VOICE §4.11) ----------

/**
 * The facts `questionFor` puts in its one question: an unknown payer is asked
 * on its own (who's in depends on who paid); otherwise every missing fact.
 */
export function askedFacts(missing: readonly (readonly MissingFact[])[]): MissingFact[] {
  const all = [...new Set(missing.flat())];
  if (all.includes('payer')) return ['payer'];
  if (all.includes('confirm_amount')) return ['confirm_amount'];
  return all;
}

const MEALS = /^(?:dinner|lunch|breakfast|brunch|drinks|groceries|coffee|food)$/;

function theThing(d: ExpenseDraft): string {
  return MEALS.test(d.description) || d.description === 'expense'
    ? d.description === 'expense'
      ? 'it'
      : d.description
    : `the ${d.description}`;
}

function shown(
  d: ExpenseDraft,
  ctx: ExpenseTextContext,
  currency?: CurrencyCode,
): string | undefined {
  if (d.amount === undefined) return undefined;
  const cur = currency ?? d.amount.currency ?? ctx.tripCurrency;
  if (cur === null) return d.amount.decimal;
  try {
    return formatMoney(parseDecimal(d.amount.decimal, cur));
  } catch {
    return d.amount.decimal;
  }
}

function labelOf(d: ExpenseDraft, ctx: ExpenseTextContext): string {
  const amt =
    (d.amount !== undefined && d.amount.currency !== undefined) ||
    (d.amount !== undefined && d.currencyDoubt === undefined && ctx.tripCurrency !== null)
      ? shown(d, ctx)
      : undefined;
  if (amt === undefined) return theThing(d);
  return d.description === 'expense'
    ? `the ${amt}`
    : `the ${amt}${d.perPerson ? ' each' : ''} ${d.description.replace(/^\d+\s+/, '')}`;
}

const CURRENCY_NAMES: Readonly<Record<string, string>> = {
  EUR: 'euros',
  USD: 'dollars',
  GBP: 'pounds',
};

function questionFor(
  drafts: readonly ExpenseDraft[],
  missing: readonly (readonly MissingFact[])[],
  ctx: ExpenseTextContext,
): string {
  const all = new Set(missing.flat());
  const idx = Math.max(
    0,
    missing.findIndex((m) => m.length > 0),
  );
  const d = drafts[idx]!;
  const parts: string[] = [];
  if (all.has('payer')) {
    // asked alone (see `askedFacts`); anything else missing is the next question
    if (d.payer.kind === 'unknown' && d.payer.name.length === 0) {
      return `who paid for ${theThing(d)}? i put each one on one person`;
    }
    const who = d.payer.kind === 'unknown' ? `, not ${d.payer.name}` : '';
    return `who paid for ${theThing(d)}? i can only put it on someone on this trip${who}`;
  }
  if (all.has('confirm_amount')) {
    const cd = drafts[missing.findIndex((m) => m.includes('confirm_amount'))]!;
    return `${shown(cd, ctx) ?? cd.amount?.decimal ?? 'that'} for ${theThing(cd)}? say the amount again and i'll log it`;
  }
  // currency first: "was that €20 or $20?"
  if (all.has('currency') && d.amount !== undefined) {
    const trip = ctx.tripCurrency ?? 'EUR';
    const other = trip === 'USD' ? 'EUR' : 'USD';
    const a = shown(d, ctx, trip) ?? d.amount.decimal;
    const b = shown(d, ctx, other) ?? d.amount.decimal;
    parts.push(`was that ${a} or ${b}${d.perPerson ? ' each' : ''}`);
  }
  if (all.has('trip_currency') && d.amount !== undefined && ctx.tripCurrency !== null) {
    const said = shown(d, ctx) ?? d.amount.decimal;
    const word = CURRENCY_NAMES[ctx.tripCurrency] ?? ctx.tripCurrency;
    const thing = d.description === 'expense' ? 'it' : `the ${d.description}`;
    parts.push(
      `what was ${thing} in ${word}? the tab's in ${ctx.tripCurrency} and i can't convert ${said} yet`,
    );
    // That line is a question followed by the reason; keep it the only part when alone.
    if (!all.has('amount') && !all.has('participants')) return parts[0]!;
  }
  if (all.has('amount')) {
    const label =
      drafts.length > 1
        ? theThing(drafts[missing.findIndex((m) => m.includes('amount'))]!)
        : theThing(d);
    parts.push(`how much was ${label}`);
  }
  if (all.has('participants')) {
    const pd = drafts[missing.findIndex((m) => m.includes('participants'))]!;
    const label =
      drafts.length > 1
        ? drafts.map((x) => labelOf(x, ctx)).join(' and ')
        : parts.length > 0
          ? 'it'
          : labelOf(pd, ctx);
    const p = pd.participants;
    if (p?.kind === 'count') parts.push(`which ${String(p.n)} are in on ${label}`);
    else if (p?.kind === 'vague') parts.push(`who's in on ${label}, by name`);
    else if (parts.length === 0) parts.push(`who's in on ${label}, everyone or just some of you`);
    else parts.push(`who's in on ${label}`);
  }
  if (parts.length === 0) return 'what should i put on the tab?';
  if (all.has('trip_currency') && parts.length > 1) {
    // the currency line carries its own reason; drop it into a lighter form
    parts[0] = `what was ${d.description === 'expense' ? 'it' : `the ${d.description}`} in ${CURRENCY_NAMES[ctx.tripCurrency ?? ''] ?? ctx.tripCurrency ?? 'the trip currency'}`;
  }
  const q =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]!}`;
  return `${q}?`;
}

// ---------- answers ----------

/**
 * Fills what a question asked for from the sender's reply ("84", "euros",
 * "€55", "me maya and sam", "everyone"). `undefined` when the reply answers
 * none of it (it is then treated as a new message).
 */
export function mergeAnswer(
  drafts: readonly ExpenseDraft[],
  missing: readonly (readonly MissingFact[])[],
  answer: string,
  ctx: ExpenseTextContext,
): ExpenseDraft[] | undefined {
  const orig = cleanText(answer);
  const low = orig.toLowerCase();
  if (low.length === 0 || low.length > 300) return undefined;
  // Only an answer-shaped reply: not a question, not a request, not a plan,
  // and not a new statement of its own ("i paid €20 for the cab, everyone"
  // is a second expense, never the first one's amount).
  if (
    /\?/.test(low) ||
    QUESTION_START.test(low) ||
    REQUEST_START.test(low) ||
    SUGGESTION_START.test(low) ||
    low.split(/\s+/).length > 15
  ) {
    return undefined;
  }
  const fresh = parseExpenseText(answer, ctx);
  if (fresh.kind === 'no_log' || fresh.kind === 'unsure') return undefined;
  if (fresh.kind === 'drafts' && fresh.drafts.some((d) => d.description !== 'expense')) {
    return undefined;
  }
  const scan: Scan = { orig, low, ctx, names: findNames(low, ctx.members), amounts: [] };
  // In an answer any number is money unless it is a headcount.
  const amounts = scanAmounts(low, ctx.members);
  for (const m of low.matchAll(/(?<![\w.,/])(\d+(?:[.,]\d+)*)(?![\w/]|[.,]\d)/g)) {
    if (amounts.some((t) => m.index >= t.start && m.index < t.end)) continue;
    if (NOT_MONEY_AFTER.test(low.slice(m.index + m[0].length))) continue;
    const decimal = normalizeDecimal(m[1]!);
    if (decimal === undefined) continue;
    amounts.push({
      start: m.index,
      end: m.index + m[0].length,
      decimal,
      explicit: false,
      inParens: false,
      role: 'total',
      each: false,
      negative: false,
    });
  }
  if (amounts.some((t) => t.negative)) return undefined;
  scan.amounts.push(...amounts);
  const currencyWord =
    /(?:^|[\s,])([€$£]|euros?|eur|dollars?|usd|bucks|quid|pounds?|gbp)(?=$|[\s,.])/.exec(low);
  const wordCurrency = currencyWord !== null ? currencyOf(currencyWord[1]!) : undefined;
  const p = parseParticipants(scan, [0, low.length], drafts[0]!.payer, []);

  let filled = false;
  const out = drafts.map((d, i) => {
    const need = missing[i] ?? [];
    let next: ExpenseDraft = d;
    if (need.includes('amount') && amounts.length === 1) {
      const a = amounts[0]!;
      next = {
        ...next,
        amount: {
          decimal: a.decimal,
          ...(a.currency !== undefined ? { currency: a.currency } : {}),
        },
      };
      filled = true;
    }
    if (need.includes('trip_currency') && amounts.length === 1 && ctx.tripCurrency !== null) {
      const a = amounts[0]!;
      if (a.currency === undefined || a.currency === ctx.tripCurrency) {
        next = { ...next, amount: { decimal: a.decimal, currency: ctx.tripCurrency } };
        filled = true;
      }
    }
    if (need.includes('currency')) {
      const cur = wordCurrency ?? (amounts.length === 1 ? amounts[0]!.currency : undefined);
      if (cur !== undefined && next.amount !== undefined) {
        const decimal =
          amounts.length === 1 && amounts[0]!.currency !== undefined
            ? amounts[0]!.decimal
            : next.amount.decimal;
        const { currencyDoubt: _doubt, ...rest } = next;
        next = { ...rest, amount: { decimal, currency: cur } };
        filled = true;
      }
    }
    if (
      need.includes('participants') &&
      p.spec !== undefined &&
      p.spec.kind !== 'vague' &&
      p.spec.kind !== 'count'
    ) {
      next = { ...next, participants: p.spec };
      filled = true;
    }
    if (need.includes('confirm_amount') && amounts.length === 1) {
      // the amount said again (or a corrected one) is the confirmation; "yes" is not
      const a = amounts[0]!;
      next = {
        ...next,
        amount: {
          decimal: a.decimal,
          ...(a.currency !== undefined
            ? { currency: a.currency }
            : next.amount?.currency !== undefined
              ? { currency: next.amount.currency }
              : {}),
        },
        amountConfirmed: true,
      };
      filled = true;
    }
    if (need.includes('payer')) {
      const self = /^(?:(?:it was |that was )?me|i did|i paid|mine|i)\b/.test(low);
      if (scan.names.length === 1 && !self) {
        next = { ...next, payer: { kind: 'member', memberId: scan.names[0]!.memberId } };
        filled = true;
      } else if (self && scan.names.length === 0) {
        next = { ...next, payer: { kind: 'member', memberId: ctx.senderMemberId } };
        filled = true;
      }
    }
    return next;
  });
  return filled ? out : undefined;
}

// ---------- the model fallback's JSON (prompts/expenseText.ts) ----------

const CATEGORIES: readonly ExpenseCategory[] = [
  'tickets',
  'flights',
  'lodging',
  'food',
  'drinks',
  'transport',
  'groceries',
  'activities',
  'other',
];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Turns the extraction call's JSON into drafts, applying the same member and
 * amount rules as the parser: unknown names make "who's in" a question, a null
 * amount or currency is a missing fact, and nothing here is trusted beyond
 * its shape. `undefined` when it is not an expense or the JSON is malformed.
 */
export function draftsFromModelJson(
  json: unknown,
  ctx: ExpenseTextContext,
): ExpenseDraft[] | undefined {
  if (!isObj(json) || json['isExpense'] !== true || !Array.isArray(json['expenses']))
    return undefined;
  const items = json['expenses'] as unknown[];
  if (items.length === 0 || items.length > 4) return undefined;
  const who = (ref: unknown): MemberId | undefined => {
    if (typeof ref !== 'string') return undefined;
    const r = ref.trim().toLowerCase();
    if (r === 'me' || r === 'i' || r === 'myself') return ctx.senderMemberId;
    return memberByWord(r, ctx.members);
  };
  const drafts: ExpenseDraft[] = [];
  for (const raw of items) {
    if (!isObj(raw)) return undefined;
    const description =
      typeof raw['description'] === 'string'
        ? raw['description']
            .replace(/[^\p{L}\p{N}' &-]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()
            .slice(0, 40)
        : '';
    const category = CATEGORIES.includes(raw['category'] as ExpenseCategory)
      ? (raw['category'] as ExpenseCategory)
      : categoryFor(description);
    const decimal =
      typeof raw['amount'] === 'string' ? normalizeDecimal(raw['amount'].trim()) : undefined;
    const curRaw = typeof raw['currency'] === 'string' ? raw['currency'].trim().toUpperCase() : '';
    const currency = /^[A-Z]{3}$/.test(curRaw) ? curRaw : undefined;
    const payerId = who(raw['paidBy']);
    const payer: ExpenseDraft['payer'] =
      payerId !== undefined
        ? { kind: 'member', memberId: payerId }
        : typeof raw['paidBy'] === 'string' && raw['paidBy'].trim().length > 0
          ? { kind: 'unknown', name: raw['paidBy'].trim().slice(0, 30) }
          : { kind: 'member', memberId: ctx.senderMemberId };
    const split = isObj(raw['split']) ? raw['split'] : {};
    const refs = Array.isArray(split['members']) ? (split['members'] as unknown[]) : [];
    const ids = refs.map(who);
    let participants: ParticipantSpec | undefined;
    if (ids.some((id) => id === undefined)) participants = { kind: 'vague', phrase: 'names' };
    else if (split['kind'] === 'everyone') participants = { kind: 'everyone' };
    else if (split['kind'] === 'except' && ids.length > 0)
      participants = { kind: 'except', ids: uniq(ids as MemberId[]) };
    else if (split['kind'] === 'list' && ids.length > 0)
      participants = { kind: 'list', ids: uniq(ids as MemberId[]) };
    const fixed: { memberId: MemberId; decimal: string }[] = [];
    for (const s of Array.isArray(raw['shares']) ? (raw['shares'] as unknown[]) : []) {
      if (!isObj(s)) return undefined;
      const id = who(s['member']);
      const d = typeof s['amount'] === 'string' ? normalizeDecimal(s['amount'].trim()) : undefined;
      if (id === undefined || d === undefined) return undefined;
      fixed.push({ memberId: id, decimal: d });
    }
    const weights: { memberId: MemberId; weight: number }[] = [];
    for (const w of Array.isArray(raw['weights']) ? (raw['weights'] as unknown[]) : []) {
      if (!isObj(w)) return undefined;
      const id = who(w['member']);
      const weight = w['weight'];
      if (id === undefined || typeof weight !== 'number' || !(weight > 0) || weight > 20)
        return undefined;
      weights.push({ memberId: id, weight });
    }
    drafts.push({
      description: description.length > 0 ? description : cleanDescription(undefined, ''),
      category,
      payer,
      ...(decimal !== undefined
        ? { amount: { decimal, ...(currency !== undefined ? { currency } : {}) } }
        : {}),
      perPerson: false,
      ...(participants !== undefined ? { participants } : {}),
      fixed,
      weights,
      restToPayer: false,
    });
  }
  return drafts;
}

/** Members as the parser sees them, by display name (tests and the flow). */
export function displayNameOf(ctx: ExpenseTextContext, id: MemberId): string {
  return nameOf(ctx, id);
}
