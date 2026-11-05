/**
 * Personal budgets and money-trouble reasons (T-134, SAFETY §2.3). A member's
 * budget is kept as the figure they stated (bound, amount, period), never as
 * their words: why someone is on a budget is theirs alone, so it is never
 * stored for anyone, in any scope (fail closed).
 *
 * Pure text helpers, shared by the offline DM responder (which builds the
 * fact) and the `remember` tool (which screens what any model sends it and
 * says the figure back to its owner).
 */
import { formatMoney, parseDecimal } from '@trav/core';
import type { CurrencyCode } from '@trav/core';

/** Lowercase, accents and curly apostrophes folded, whitespace collapsed. */
export function foldBudgetText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- money-trouble reasons ----------

const Q = String.raw`(?:really|pretty|very|so|super|kinda|kind of|a bit|a little|a lil|bit|way|too|extra|real)`;
const MONEY_NOUN = String.raw`(?:money|cash|funds|finances|the bank account|my bank account|my account)`;

/**
 * Money-trouble reasons (SAFETY roast blocklist "financial hardship").
 * "broke", "loans" and "struggling" count only in a money sense ("i broke my
 * phone", "a loan of his charger", "struggling with spanish" don't).
 */
const HARDSHIP_PATTERNS: readonly RegExp[] = [
  new RegExp(
    String.raw`\b${MONEY_NOUN}(?:'s|s)?(?: (?:is|are|r|has been|have been|been|was|were|getting|gets|got|feels?|looking))?(?: ${Q})* (?:tight|rough|bad|low|short|thin|scarce|a mess|a struggle)\b`,
  ),
  new RegExp(
    String.raw`\b(?:things|budget|budgets|wallet)(?:'s|s)?(?: (?:is|are|r|has been|have been|been|getting|feels?))?(?: ${Q})* tight\b`,
  ),
  /\b(?:tight|short|low) (?:on|with|for) (?:money|cash|funds)\b/,
  /\b(?:cash[- ]strapped|strapped for (?:cash|money)|skint|overdrawn|overdraft|hardship|tuition|unemployed|laid off|between jobs|in debt|debts?)\b/,
  /\b(?:\w+'s|i'?m|i am|im|i've been|he'?s|she'?s|they'?re|we'?re|you'?re|is|are|am|been|being|go|going|gone|went|flat|dead|totally|basically|so|pretty|kinda|super|very|too|stone|piss) broke\b/,
  /\bbroke (?:af|asf|rn|right now|this (?:month|week|semester|year)|lately|these days|until|till|til)\b/,
  /\bpoor (?:this (?:month|week|semester|year)|right now|rn|at the moment|lately|these days)\b/,
  /\b(?:student|bank|payday|personal|car) loans?\b|\bloan payments?\b|\b(?:paying (?:off|back)|took out|take out|taking out) (?:a |my |the |his |her |their )?loans?\b|\b(?:my|his|her|their) loans\b/,
  /\bstruggling (?:financially|with (?:money|cash|rent|bills|funds|finances|debt)|to (?:pay|afford|make rent|get by))\b/,
  /\b(?:can'?t|cannot|couldn'?t|can not) afford\b/,
  /\bcut (?:me|him|her|them) off\b/,
  /\bstudent budget\b|\bon a (?:tight|shoestring) budget\b/,
  /\brent(?:'s| is)? (?:due|late|overdue)\b|\bbehind on (?:rent|bills|payments)\b/,
  /\b(?:paycheck|payday|financial (?:aid|troubles?|hardship|stress|problems?|issues?|situation)|money (?:troubles?|problems?|issues?|stress|situation))\b/,
  // T-134 r2 #1: job loss and other reasons the first list missed.
  /\b(?:lost (?:my|his|her|their|a|the) job|(?:got|been|was|were|get|getting) (?:fired|sacked|let go)|out of work|jobless|furlough(?:ed)?|strapped|paychecks?)\b/,
  /\b(?:i'?m|im|i am|we'?re|he'?s|she'?s|they'?re) (?:so |pretty |kinda |super |dirt )?poor\b|\bbroke (?:student|college kid|af)\b/,
  /\b(?:tight|small|limited|low) budget\b|\bon a budget\b|\bsaving (?:up )?for (?:rent|bills|tuition)\b/,
  /\b(?:out of|no|zero|not much|barely any) (?:money|cash|funds)\b|\b(?:don'?t|do not|doesn'?t) have (?:the |enough |any )?(?:money|cash|funds)\b/,
  /\b(?:card|payment) (?:got |was |keeps getting )?declined\b|\bmaxed (?:out )?(?:my|his|her|their|the) cards?\b|\bmaxed out\b/,
  /\bowe (?:my |his |her |their |the )?\w+ (?:money|cash)\b|\b(?:a (?:little|bit|lil) )?short this (?:month|week)\b/,
  /\bbarely (?:getting by|scraping by|making it|afford)\b|\bcan'?t swing (?:it|that|this)\b|\bbills (?:are )?(?:piling|stacking) up\b|\bbehind on (?:my |his |her |the )?\w+ payments?\b/,
];

/** A bare "tight" only counts on a budget fact ("tight connection" is logistics). */
export function isHardship(text: string, category: string): boolean {
  const t = foldBudgetText(text);
  return (
    HARDSHIP_PATTERNS.some((re) => re.test(t)) || (category === 'budget' && /\btight\b/.test(t))
  );
}

// ---------- the figure ----------

export type BudgetBound = 'under' | 'at_most' | 'around';
export type BudgetPeriod = 'day' | 'night' | 'week' | 'trip';

export interface BudgetFigure {
  readonly bound: BudgetBound;
  /** `€80`, `£1,000`, or a bare `80` when no currency is known. */
  readonly amount: string;
  readonly period?: BudgetPeriod;
}

const BOUND_SRC = String.raw`(?<bound>under|below|less than|no more than|at most|at or under|max(?:imum)?|tops|up to|around|about|roughly|to|at)`;
/** 1,000 · 1.000 · 1,000.50 · 1.000,50 · 80 · 50.50 · 80,5 */
const NUM_SRC = String.raw`(?<num>\d{1,3}(?<sep>[,.])\d{3}(?:\k<sep>\d{3})*(?:(?!\k<sep>)[.,]\d{1,2})?|\d{1,6}(?:[.,]\d{1,2})?)`;
const CODE_SRC = String.raw`(?<code>eur|euros?|usd|dollars?|bucks|gbp|pounds?|quid)`;
const PER_SRC = String.raw`(?<per>(?:a|per|each|every|\/)\s*(?:day|night|week)|daily|nightly|weekly|for the (?:whole |entire )?trip|(?:in )?total)`;
/** A figure followed by a non-money unit is not a budget ("20 minutes", "2 nights", "3 people"). */
const NON_MONEY_UNIT =
  /^\s*(?:mins?|minutes?|hours?|hrs?|h|secs?|seconds?|nights?|days?|weeks?|months?|years?|people|persons?|ppl|of us|tickets?|drinks?|beers?|shots?|rounds?|bags?|km|kms|miles?|mi|am|pm|%|x|times?|stops?|steps?|floors?|rooms?|beds?)\b/;

const FIGURE_RE = new RegExp(
  String.raw`^\s*(?:${BOUND_SRC}\s+)?(?<sym>[€$£])?\s?${NUM_SRC}(?![\d:])(?:\s?(?<symAfter>[€$£]))?(?:\s*${CODE_SRC}\b)?(?:\s*${PER_SRC})?`,
);

/**
 * What may not follow a figure (T-134 r2 #3-#5): never guess, decline instead.
 * A digit or separator (malformed "1,0000", "1.000.50"), a multiplier ("1.5k",
 * "80 thousand"), a currency Trav doesn't read ("80 chf"), or a period it
 * doesn't keep ("a month", "for the weekend").
 */
const UNSAFE_AFTER =
  /^(?:\d|[.,]\d)|^\s*(?:k|K|thousand|grand|mil|million|m)\b|^\s*(?:chf|jpy|yen|cad|aud|nzd|mxn|sek|nok|dkk|pln|czk|huf|try|inr|cny|yuan|rupees?|francs?|pesos?|kron(?:a|or|er|e)|zloty|lira|reais|real|won|baht)\b|^\s*(?:(?:a|per|each|every|\/)\s*(?:month|year|weekend|semester)|monthly|yearly|annually|for the weekend|this (?:month|year|weekend|semester))\b/;

const SYMBOL_CURRENCY: Readonly<Record<string, string>> = { '€': 'EUR', $: 'USD', '£': 'GBP' };
const WORD_CURRENCY: Readonly<Record<string, string>> = {
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  bucks: 'USD',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
};

function boundOf(word: string | undefined): BudgetBound {
  if (word === undefined) return 'at_most';
  if (/^(?:under|below|less than)$/.test(word)) return 'under';
  if (/^(?:around|about|roughly)$/.test(word)) return 'around';
  return 'at_most';
}

function periodOf(per: string | undefined): BudgetPeriod | undefined {
  if (per === undefined) return undefined;
  if (/day|daily/.test(per)) return 'day';
  if (/night/.test(per)) return 'night';
  if (/week/.test(per)) return 'week';
  return 'trip';
}

/** "1,000" ⇒ "1000", "1.000,50" ⇒ "1000.50", "80,5" ⇒ "80.5". */
function plainDecimal(num: string, sep: string | undefined): string {
  if (sep !== undefined) {
    const noGroups = num.split(sep).join('');
    return noGroups.replace(/[.,]/, '.');
  }
  return num.replace(',', '.');
}

export interface ParseFigureOptions {
  /** The tab's currency, for a figure with no symbol or code. */
  readonly tabCurrency?: string;
  /** "i can only spend 20" is not a budget: require a currency or a period. */
  readonly requireMoneyMarker?: boolean;
  /** The bound the caller already read ("don't let my share go over" ⇒ under). */
  readonly bound?: BudgetBound;
}

/**
 * The first budget figure at the start of `clause` (after an optional bound
 * word), or undefined. Never a non-money quantity, never zero.
 */
export function parseBudgetFigure(
  clause: string,
  opts: ParseFigureOptions = {},
): BudgetFigure | undefined {
  const c = foldBudgetText(clause);
  const m = FIGURE_RE.exec(c);
  const g = m?.groups;
  if (m === null || g?.['num'] === undefined) return undefined;
  const after = c.slice(m.index + m[0].length);
  if (NON_MONEY_UNIT.test(after) && g['per'] === undefined) {
    return undefined;
  }
  if (UNSAFE_AFTER.test(after)) return undefined;
  // "0.001" style leading zeros with grouping are no budget either.
  if (g['sep'] !== undefined && /^0/.test(g['num'])) return undefined;
  const sym = g['sym'] ?? g['symAfter'];
  const code = g['code'];
  const marked = sym !== undefined || code !== undefined;
  if (opts.requireMoneyMarker === true && !marked && g['per'] === undefined) return undefined;
  const currency =
    (sym !== undefined ? SYMBOL_CURRENCY[sym] : undefined) ??
    (code !== undefined ? WORD_CURRENCY[code] : undefined) ??
    opts.tabCurrency;
  const decimal = plainDecimal(g['num'], g['sep']);
  if (!(Number(decimal) > 0)) return undefined;
  let amount = decimal;
  if (currency !== undefined) {
    try {
      amount = formatMoney(parseDecimal(decimal, currency as CurrencyCode));
    } catch {
      amount = `${decimal} ${currency}`;
    }
  }
  const period = periodOf(g['per']);
  return {
    bound: opts.bound ?? boundOf(g['bound']),
    amount,
    ...(period !== undefined ? { period } : {}),
  };
}

const BOUND_WORDS: Readonly<Record<BudgetBound, string>> = {
  under: 'under',
  at_most: 'at or under',
  around: 'around',
};
const PERIOD_WORDS: Readonly<Record<BudgetPeriod, string>> = {
  day: 'a day',
  night: 'a night',
  week: 'a week',
  trip: 'for the trip',
};

/** "under €80 a day", "at or under £1,000 for the trip". */
export function budgetPhrase(f: BudgetFigure): string {
  return `${BOUND_WORDS[f.bound]} ${f.amount}${f.period === undefined ? '' : ` ${PERIOD_WORDS[f.period]}`}`;
}

/**
 * The first figure anywhere in a stored budget fact, for saying it back to
 * its owner ("henry wants to keep his share under €80 a day" ⇒ under €80 a day).
 */
export function findBudgetFigure(text: string, tabCurrency?: string): BudgetFigure | undefined {
  const t = foldBudgetText(text);
  const at = t.search(/[€$£]?\d/);
  if (at < 0) return undefined;
  const before = t.slice(0, at).trimEnd();
  const boundWord =
    /(?:under|below|less than|no more than|at most|at or under|max(?:imum)?|tops|up to|around|about|roughly)$/.exec(
      before,
    )?.[0];
  const clause = boundWord === undefined ? t.slice(at) : `${boundWord} ${t.slice(at)}`;
  return parseBudgetFigure(clause, tabCurrency !== undefined ? { tabCurrency } : {});
}
