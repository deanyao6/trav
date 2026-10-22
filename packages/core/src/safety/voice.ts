/**
 * Voice linter (docs/VOICE.md §1 voice rules, §3 length/format, §3.4 money,
 * §10 reviewer checklist; U-04). Pure and deterministic: the send path runs it
 * on every Trav message (a violation fails tests; production logs it).
 *
 * Rules:
 * - banned_phrase: VOICE §1 rule 6 plus the other phrases VOICE calls out
 *   (preambles, sign-offs, "i'm not able to", "great deal", "click here").
 * - exclamation: no `!` outside a quoted human phrase.
 * - emoji_count / emoji_set: ≤1 emoji (≤3 in Wrapped, 0 in errors/refusals),
 *   only from ALLOWED_EMOJI. 👍/👎 written as reply instructions ("👍 to book")
 *   are tapback references, not decoration, and are exempt.
 * - markdown: no headings, **, __, backticks, `- ` bullets, `>` quotes, links,
 *   or single-star or underscore emphasis.
 * - uppercase_start / capital_i: sentences start lowercase unless the first
 *   word is a proper noun (names, places, brands) or an acronym (QR, EUR, BOS);
 *   "i" is lowercase everywhere.
 * - too_many_lines / too_long: per template (VOICE §3.1).
 * - raw_money: money appears only in `formatMoney` shapes (`€84`, `€16.80`,
 *   `€2,340`, `-€12`, `CHF 12`): no `84€`, `€84.00`, `€2340`, `EUR 84`, `eur 84`,
 *   `84 euros`, `€-12`, `€12k`.
 */
import { blankQuoted, normalizeText, termRegex } from './text.js';

export const BANNED_PHRASES: readonly string[] = [
  'certainly',
  'great question',
  "i'd be happy to",
  'please note',
  'kindly',
  'unfortunately',
  'apologies for the inconvenience',
  'feel free to',
  'as an ai',
  'assist',
  'at this time',
  'rest assured',
  // Other phrases VOICE §1–§4 rules out.
  'assistance',
  'assisting',
  'assisted',
  'sure thing',
  'let me know if you need anything',
  'hope this helps',
  'was this helpful',
  "i'm not able to",
  'great deal',
  'click here',
  // VOICE §2 silence rules: never a message whose only content is that Trav exists.
  'just checking in',
  'reminder',
  'did you see this',
];

/** VOICE §1 rule 4 set, plus 🏆 (used by the Wrapped awards line, VOICE §4.8). */
export const ALLOWED_EMOJI: readonly string[] = [
  '✅',
  '🎟️',
  '☀️',
  '💸',
  '📸',
  '✈️',
  '🏠',
  '🎉',
  '👀',
  '🏆',
];

/** Tapback glyphs used as reply instructions ("👍 to book", "👎 to undo"); not counted as emoji. */
export const TAPBACK_GLYPHS: readonly string[] = ['👍', '👎'];

export type MessageKind =
  | 'reply'
  | 'proposal'
  | 'receipt'
  | 'expense'
  | 'recap'
  | 'settle_up'
  | 'wrapped'
  | 'error'
  | 'refusal'
  | 'dm';

export interface KindLimits {
  readonly maxLines: number;
  readonly maxChars: number;
  readonly maxEmoji: number;
}

/**
 * VOICE §3.1: ordinary reply 1–4 lines under 280 chars; proposal, confirmation,
 * expense up to 6 lines; recap and settle-up up to 10; Wrapped up to 14.
 * Errors are two lines max (§4.10). Char caps for the longer templates are
 * ~70 chars a line. DMs (tickets, "looks shared?" digests) get proposal size.
 */
export const KIND_LIMITS: Readonly<Record<MessageKind, KindLimits>> = {
  reply: { maxLines: 4, maxChars: 279, maxEmoji: 1 },
  proposal: { maxLines: 6, maxChars: 420, maxEmoji: 1 },
  receipt: { maxLines: 6, maxChars: 420, maxEmoji: 1 },
  expense: { maxLines: 6, maxChars: 420, maxEmoji: 1 },
  recap: { maxLines: 10, maxChars: 700, maxEmoji: 1 },
  settle_up: { maxLines: 10, maxChars: 700, maxEmoji: 1 },
  wrapped: { maxLines: 14, maxChars: 980, maxEmoji: 3 },
  error: { maxLines: 2, maxChars: 279, maxEmoji: 0 },
  refusal: { maxLines: 4, maxChars: 279, maxEmoji: 0 },
  dm: { maxLines: 6, maxChars: 420, maxEmoji: 1 },
};

export interface LintViolation {
  readonly rule:
    | 'banned_phrase'
    | 'exclamation'
    | 'emoji_count'
    | 'emoji_set'
    | 'markdown'
    | 'uppercase_start'
    | 'capital_i'
    | 'too_long'
    | 'too_many_lines'
    | 'raw_money';
  readonly detail: string;
}

export interface LintResult {
  readonly ok: boolean;
  readonly violations: readonly LintViolation[];
}

export interface LintOptions {
  readonly kind: MessageKind;
  /**
   * Names, places and brands that may start a sentence capitalized (member
   * display names, trip city, venues). When given, the capital-start rule is
   * strict: any other capitalized sentence start is a violation. When omitted,
   * only capitalized common words ("Sure", "The", "Your") are flagged.
   */
  readonly properNouns?: readonly string[];
}

/** Brands and places Trav names often; always allowed as a capitalized sentence start. */
export const DEFAULT_PROPER_NOUNS: readonly string[] = [
  'Uber',
  'Lyft',
  'Airbnb',
  'Venmo',
  'Barcelona',
  'Lisbon',
  'Turks',
  'Caicos',
  'Razzmatazz',
];

/** Common English words that are never proper nouns at a sentence start. */
const COMMON_STARTERS: ReadonlySet<string> = new Set(
  (
    "a an the this that these those there here it its it's i i'm i'd i'll i've we we're you your you're " +
    'he she they them their our my me us his her what when where who why how which ' +
    'yes yeah yep no nope ok okay sure great good nice cool awesome perfect absolutely definitely certainly ' +
    'thanks thank sorry please hi hey hello welcome just so and but or also then now today tonight tomorrow ' +
    'yesterday last next first all everyone everybody nobody nothing anyone someone something everything ' +
    'logged booked got done found saw read added split charged paid sent heads running final morning day ' +
    'tab total each per your let note unfortunately kindly feel rest as at in on for with from to of by ' +
    'if not only still because since after before while once'
  ).split(/\s+/),
);

function isAcronym(word: string): boolean {
  return /^[A-Z][A-Z0-9]+$/.test(word) || /^[A-Z][A-Z0-9]*[0-9][A-Z0-9]*$/.test(word);
}

// ---------- emoji ----------

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

function canonicalEmoji(e: string): string {
  return e.replace(/[️︎]/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

const ALLOWED_CANON: ReadonlySet<string> = new Set(ALLOWED_EMOJI.map(canonicalEmoji));
const TAPBACK_CANON: ReadonlySet<string> = new Set(TAPBACK_GLYPHS.map(canonicalEmoji));

/** Every emoji grapheme in `text`, in order (tapback glyphs included). */
export function extractEmoji(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    if (PICTOGRAPHIC.test(segment)) out.push(segment);
  }
  return out;
}

// ---------- money ----------

/** Symbols `formatMoney` emits (money.ts CURRENCY_SYMBOLS), longest first; US$ is never emitted. */
const SYMBOLS = ['CA$', 'MX$', 'NZ$', 'US$', 'A$', 'R$', '€', '$', '£', '¥', '₹', '₩'];
const ZERO_DECIMAL_SYMBOLS: ReadonlySet<string> = new Set(['¥', '₩']);
const SYMBOL_CODES = ['EUR', 'USD', 'GBP', 'JPY', 'INR', 'KRW', 'BRL', 'AUD', 'CAD', 'MXN', 'NZD'];

const SYMBOL_ALT = SYMBOLS.map((s) => s.replace(/\$/g, '\\$')).join('|');
const PREFIX_MONEY_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${SYMBOL_ALT})([ \\u00A0]*)(\\d+(?:,\\d+)*(?:\\.\\d+)?)(?![\\d])`,
  'gu',
);
const SUFFIX_SYMBOL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.,])\\d+(?:,\\d+)*(?:\\.\\d+)?[ \\u00A0]?(?:€|£|\\$|¥|₹|₩)`,
  'gu',
);
const WORD_CURRENCY_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.,])\\d+(?:,\\d+)*(?:\\.\\d+)?[ \\u00A0]?(?:${SYMBOL_CODES.join('|')}|euros?|dollars?|bucks|pounds|quid|cents)(?![\\p{L}])`,
  'giu',
);
/** `EUR 84`, `eur 84`, `Eur84`: formatMoney writes the symbol for these currencies. */
const CODE_PREFIX_RE = new RegExp(
  `(?<![\\p{L}])(?:${SYMBOL_CODES.join('|')})[ \\u00A0]?\\d`,
  'giu',
);
/** `€-12` / `€−12`: the sign goes before the symbol (`-€12`). */
const SYMBOL_THEN_SIGN_RE = new RegExp(`(?:${SYMBOL_ALT})[ \\u00A0]?[-−–][ \\u00A0]?\\d`, 'gu');
/** `€12k`, `$1.5m`: abbreviated magnitudes are never a formatMoney shape. */
const ABBREVIATED_RE = new RegExp(
  `(?:${SYMBOL_ALT})[ \\u00A0]?\\d+(?:[.,]\\d+)?[ \\u00A0]?[kKmMbB](?![\\p{L}\\p{N}])`,
  'gu',
);

function validAmount(num: string, symbol: string): boolean {
  if (ZERO_DECIMAL_SYMBOLS.has(symbol)) return /^(0|[1-9]\d{0,2}(,\d{3})*)$/.test(num);
  const m = /^(0|[1-9]\d{0,2}(?:,\d{3})*)(?:\.(\d{2}))?$/.exec(num);
  if (!m) return false;
  return m[2] !== '00';
}

function moneyViolations(text: string): LintViolation[] {
  const out: LintViolation[] = [];
  for (const m of text.matchAll(PREFIX_MONEY_RE)) {
    const [whole, symbol = '', space = '', num = ''] = m;
    if (symbol === 'US$' || space.length > 0 || !validAmount(num, symbol)) {
      out.push({ rule: 'raw_money', detail: `"${whole}" is not a formatMoney shape` });
    }
  }
  for (const re of [
    SUFFIX_SYMBOL_RE,
    WORD_CURRENCY_RE,
    CODE_PREFIX_RE,
    SYMBOL_THEN_SIGN_RE,
    ABBREVIATED_RE,
  ]) {
    for (const m of text.matchAll(re)) {
      out.push({ rule: 'raw_money', detail: `"${m[0]}" is not a formatMoney shape` });
    }
  }
  return out;
}

// ---------- markdown ----------

const MARKDOWN_RULES: readonly { readonly re: RegExp; readonly what: string }[] = [
  { re: /^\s{0,3}#{1,6}\s/m, what: 'heading' },
  { re: /\*\*|__/, what: 'bold' },
  { re: /`/, what: 'backtick' },
  { re: /^\s*[-*+•]\s/m, what: 'bullet' },
  { re: /^\s*>\s/m, what: 'blockquote' },
  { re: /\[[^\]\n]+\]\([^)\n]+\)/, what: 'link' },
  { re: /(^|[\s(])\*[^*\s][^*\n]*\*(?=$|[\s).,;:?])/m, what: 'emphasis' },
  { re: /(^|[\s(])_[^_\s][^_\n]*_(?=$|[\s).,;:?])/m, what: 'emphasis' },
];

// ---------- capitals ----------

/** Sentence starts: each line, and after `.`/`?`/`!` + whitespace within a line. */
function sentenceStarts(blanked: string): string[] {
  const starts: string[] = [];
  for (const line of blanked.split('\n')) {
    for (const sentence of line.split(/(?<=[.?!])\s+/)) starts.push(sentence);
  }
  return starts;
}

/** The first word of a sentence if it starts with a letter (skips emoji, arrows, middots); else null. */
function firstWord(sentence: string): string | null {
  for (const token of sentence.trim().split(/\s+/)) {
    if (token.length === 0) continue;
    const cleaned = token.replace(/^[("'([]+/, '');
    if (cleaned.length === 0) continue;
    const ch = cleaned[0] ?? '';
    if (/\p{L}/u.test(ch)) {
      const word = /^[\p{L}\p{M}'.-]+/u.exec(cleaned)?.[0] ?? cleaned;
      return word.replace(/'s$/, '').replace(/[.'-]+$/, '');
    }
    if (ch === '@') return null;
    if (/[\p{N}\p{Sc}]/u.test(ch)) return null;
    // Emoji, arrows, middots and other symbols: keep looking.
  }
  return null;
}

function capitalViolations(
  blanked: string,
  properNouns: readonly string[] | undefined,
): LintViolation[] {
  const out: LintViolation[] = [];
  const nounWords = new Set(
    [...DEFAULT_PROPER_NOUNS, ...(properNouns ?? [])].flatMap((n) => normalizeText(n).split(/\s+/)),
  );
  for (const sentence of sentenceStarts(blanked)) {
    const word = firstWord(sentence);
    if (word === null || word.length === 0) continue;
    const first = word[0] ?? '';
    if (first === first.toLowerCase()) continue;
    if (word === 'I' || /^I'/.test(word)) continue; // reported by capital_i
    if (isAcronym(word) || nounWords.has(word)) continue;
    const strict = properNouns !== undefined;
    if (strict || COMMON_STARTERS.has(word.toLowerCase())) {
      out.push({ rule: 'uppercase_start', detail: `sentence starts with "${word}"` });
    }
  }
  for (const m of blanked.matchAll(/(?<![\p{L}\p{N}'])I(?:'(?:m|d|ll|ve))?(?![\p{L}\p{N}])/gu)) {
    out.push({ rule: 'capital_i', detail: `"${m[0]}" should be lowercase` });
  }
  return out;
}

// ---------- main ----------

const BANNED_COMPILED = BANNED_PHRASES.map((p) => ({ phrase: p, re: termRegex(p) }));

export function lintVoice(text: string, kindOrOptions: MessageKind | LintOptions): LintResult {
  const opts: LintOptions =
    typeof kindOrOptions === 'string' ? { kind: kindOrOptions } : kindOrOptions;
  const limits = KIND_LIMITS[opts.kind];
  const violations: LintViolation[] = [];
  const normalized = normalizeText(text);
  const blanked = blankQuoted(normalized);

  for (const b of BANNED_COMPILED) {
    if (b.re.test(blanked)) violations.push({ rule: 'banned_phrase', detail: b.phrase });
  }

  if (blanked.includes('!')) violations.push({ rule: 'exclamation', detail: 'exclamation mark' });

  const emoji = extractEmoji(normalized).filter((e) => !TAPBACK_CANON.has(canonicalEmoji(e)));
  for (const e of emoji) {
    if (!ALLOWED_CANON.has(canonicalEmoji(e))) {
      violations.push({ rule: 'emoji_set', detail: `${e} is not in the allowed set` });
    }
  }
  if (emoji.length > limits.maxEmoji) {
    violations.push({
      rule: 'emoji_count',
      detail: `${String(emoji.length)} emoji, max ${String(limits.maxEmoji)} for ${opts.kind}`,
    });
  }

  for (const r of MARKDOWN_RULES) {
    if (r.re.test(blanked)) violations.push({ rule: 'markdown', detail: r.what });
  }

  violations.push(...capitalViolations(blanked, opts.properNouns));

  const lines = normalized.replace(/\n+$/, '').split('\n');
  if (lines.length > limits.maxLines) {
    violations.push({
      rule: 'too_many_lines',
      detail: `${String(lines.length)} lines, max ${String(limits.maxLines)} for ${opts.kind}`,
    });
  }
  const chars = [...normalized.trim()].length;
  if (chars > limits.maxChars) {
    violations.push({
      rule: 'too_long',
      detail: `${String(chars)} chars, max ${String(limits.maxChars)} for ${opts.kind}`,
    });
  }

  violations.push(...moneyViolations(normalized));

  return { ok: violations.length === 0, violations };
}
