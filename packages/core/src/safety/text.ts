/**
 * Small, pure text helpers shared by the safety predicates, the roast blocklist
 * and the voice linter. No I/O.
 */

/**
 * Characters below are built from code points (never typed literally) so the
 * source stays free of invisible or look-alike characters (ESLint
 * no-irregular-whitespace; reviewers can read it).
 */
const cp = (n: number): string => String.fromCodePoint(n);

/** Invisible characters that split a word without changing how it reads: zero-width space/joiners (U+200B–U+200D), word joiner (U+2060), BOM (U+FEFF), soft hyphen (U+00AD). */
const INVISIBLE_RE = new RegExp(
  `[${cp(0x200b)}-${cp(0x200d)}${cp(0x2060)}${cp(0xfeff)}${cp(0x00ad)}]`,
  'g',
);

/**
 * Look-alike letters NFKC leaves alone, folded to ASCII so a Cyrillic "c" in
 * "certainly", a Greek upsilon in "drunk" or a dotless i in "certainly" still
 * hits the matchers. Every entry is a letter whose usual glyph is the Latin
 * twin (Unicode confusables, Cyrillic and Greek ranges).
 */
const CONFUSABLES: ReadonlyMap<string, string> = new Map<string, string>([
  [cp(0x0131), 'i'], // dotless i
  // Cyrillic lowercase
  [cp(0x0430), 'a'],
  [cp(0x0432), 'b'], // ve
  [cp(0x0435), 'e'],
  [cp(0x043a), 'k'],
  [cp(0x043c), 'm'],
  [cp(0x043d), 'h'], // en
  [cp(0x043e), 'o'],
  [cp(0x0440), 'p'], // er
  [cp(0x0441), 'c'], // es
  [cp(0x0442), 't'],
  [cp(0x0443), 'y'], // u
  [cp(0x0445), 'x'], // ha
  [cp(0x0455), 's'], // dze
  [cp(0x0456), 'i'], // byelorussian-ukrainian i
  [cp(0x0458), 'j'], // je
  [cp(0x0461), 'w'], // omega
  [cp(0x0475), 'v'], // izhitsa
  [cp(0x0501), 'd'], // komi de
  [cp(0x051b), 'q'], // qa
  // Cyrillic uppercase
  [cp(0x0410), 'A'],
  [cp(0x0412), 'B'],
  [cp(0x0415), 'E'],
  [cp(0x041a), 'K'],
  [cp(0x041c), 'M'],
  [cp(0x041d), 'H'],
  [cp(0x041e), 'O'],
  [cp(0x0420), 'P'],
  [cp(0x0421), 'C'],
  [cp(0x0422), 'T'],
  [cp(0x0423), 'Y'],
  [cp(0x0425), 'X'],
  [cp(0x0405), 'S'],
  [cp(0x0406), 'I'],
  [cp(0x0408), 'J'],
  // Greek lowercase
  [cp(0x03b1), 'a'], // alpha
  [cp(0x03b5), 'e'], // epsilon
  [cp(0x03b7), 'n'], // eta
  [cp(0x03b9), 'i'], // iota
  [cp(0x03ba), 'k'], // kappa
  [cp(0x03bd), 'v'], // nu
  [cp(0x03bf), 'o'], // omicron
  [cp(0x03c1), 'p'], // rho
  [cp(0x03c4), 't'], // tau
  [cp(0x03c5), 'u'], // upsilon
  [cp(0x03c7), 'x'], // chi
  // Greek uppercase
  [cp(0x0391), 'A'],
  [cp(0x0392), 'B'],
  [cp(0x0395), 'E'],
  [cp(0x0396), 'Z'],
  [cp(0x0397), 'H'],
  [cp(0x0399), 'I'],
  [cp(0x039a), 'K'],
  [cp(0x039c), 'M'],
  [cp(0x039d), 'N'],
  [cp(0x039f), 'O'],
  [cp(0x03a1), 'P'],
  [cp(0x03a4), 'T'],
  [cp(0x03a5), 'Y'],
  [cp(0x03a7), 'X'],
]);

const CONFUSABLE_RE = new RegExp(`[${[...CONFUSABLES.keys()].join('')}]`, 'g');

/**
 * Combining marks to strip after NFKD so "José" and "Jose", "Família" and
 * "Familia" fold to the same string. Emoji variation selectors (U+FE00–FE0F,
 * U+E0100–E01EF) and the keycap enclosure (U+20E3) are marks too but carry
 * meaning for the emoji rules, so they are kept.
 */
const DIACRITIC_RE = new RegExp(
  `(?![${cp(0xfe00)}-${cp(0xfe0f)}${cp(0x20e3)}${cp(0xe0100)}-${cp(0xe01ef)}])\\p{M}`,
  'gu',
);

/**
 * NFKD (fullwidth, ligatures, compatibility forms → plain; letters split from
 * their accents), diacritics stripped, NFC, invisible characters stripped,
 * confusables folded, curly quotes and apostrophes → ASCII, so "Henry’s"
 * matches "henry's", "José" matches "Jose" and "cer<ZWSP>tainly" matches
 * "certainly". NOT length-preserving; use `findNormalized` to map a match back
 * to the original.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(DIACRITIC_RE, '')
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
    .replace(CONFUSABLE_RE, (c) => CONFUSABLES.get(c) ?? c)
    .replace(/[‘’ʼ′]/g, "'")
    .replace(/[“”″]/g, '"');
}

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

export interface TextSpan {
  /** Offsets into the ORIGINAL string. */
  readonly start: number;
  readonly end: number;
}

/**
 * Find `needle` in `hay` after normalizing both, returning the span in the
 * original `hay` so callers can splice the original (curly quotes elsewhere
 * untouched). Grapheme-by-grapheme normalization keeps an offset map. Null if absent.
 */
export function findNormalized(hay: string, needle: string): TextSpan | null {
  const n = normalizeText(needle);
  if (n.length === 0) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  let folded = '';
  for (const { segment, index } of GRAPHEMES.segment(hay)) {
    const f = normalizeText(segment);
    for (let i = 0; i < f.length; i += 1) {
      starts.push(index);
      ends.push(index + segment.length);
    }
    folded += f;
  }
  const at = folded.indexOf(n);
  if (at < 0) return null;
  const start = starts[at];
  const end = ends[at + n.length - 1];
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TERM_BEFORE = '(?<![\\p{L}\\p{N}])';
const TERM_AFTER = '(?![\\p{L}\\p{N}])';

/**
 * Case-insensitive whole-term matcher. Terms may be phrases ("can't afford");
 * whitespace inside a term matches any run of whitespace or hyphens. A term
 * matches only when not glued to another letter/digit on either side (so "bar"
 * hits "Bar del Pla" and "bars" but not "barça" or "barely"). Purely
 * alphabetic terms also match a plural `s`/`es` suffix.
 */
export function termRegex(term: string): RegExp {
  return new RegExp(`${TERM_BEFORE}${termBody(term)}${TERM_AFTER}`, 'iu');
}

/** The pattern for one term between the two boundary checks (see `termRegex`). */
function termBody(term: string): string {
  const t = normalizeText(term).trim().toLowerCase();
  const body = t
    .split(/\s+/)
    .map((part) => escapeRegExp(part))
    .join('[\\s\\-]+');
  const plural = /^[a-z]+$/.test(t.split(/\s+/).at(-1) ?? '') ? '(?:e?s)?' : '';
  return `${body}${plural}`;
}

/**
 * One matcher for a whole list of terms: it matches exactly where at least one
 * `termRegex(term)` would match (same boundaries, plurals and flags), so
 * `termsRegex(ts).test(x) === ts.some((t) => termRegex(t).test(x))`.
 *
 * Why it exists (T-181): each `termRegex` carries two Unicode `\p{L}\p{N}`
 * lookarounds, which V8 compiles lazily on first use at about 1 ms per regex.
 * The roast blocklist alone has ~380 terms, so the first screened roast line
 * paid ~0.5 s, enough to time out a test under full-suite load. One
 * alternation per list puts the boundary classes in the pattern once.
 * Returns null for an empty list (nothing can match).
 */
export function termsRegex(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  return new RegExp(`${TERM_BEFORE}(?:${terms.map(termBody).join('|')})${TERM_AFTER}`, 'iu');
}

/** First term (in list order) found in `text`, or null. */
export function findTerm(
  text: string,
  compiled: readonly { readonly term: string; readonly re: RegExp }[],
): string | null {
  const t = normalizeText(text);
  for (const c of compiled) {
    if (c.re.test(t)) return c.term;
  }
  return null;
}

/**
 * The strings that count as naming a member: the full display name plus each
 * whitespace token of it that has at least two characters and a letter
 * ("Piotr Kim" → "Piotr Kim", "Piotr", "Kim"), so a first-name roast cannot
 * dodge a gate keyed on a full display name. A token shared by two members
 * matches both, so both gates run (fail closed).
 */
export function nameTokens(name: string): string[] {
  const full = normalizeText(name).trim();
  if (full.length === 0) return [];
  const out = new Set<string>([full]);
  for (const raw of full.split(/\s+/)) {
    const part = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (part.length >= 2 && /\p{L}/u.test(part)) out.add(part);
  }
  return [...out];
}

function wordRegex(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'iu');
}

/** Whole-word, case-insensitive name match on the full name or any of its tokens, possessive-friendly ("Henry's"). */
export function mentionsName(text: string, name: string): boolean {
  const t = normalizeText(text);
  return nameTokens(name).some((tok) => wordRegex(tok).test(t));
}

/**
 * Words that, within three words of a name, mean the person is being kept OFF
 * a plan ("Lily's not on this one", "keep Lily off that plan", "without Lily").
 */
const EXCLUSION_WORDS = new Set([
  'not',
  'no',
  'without',
  'minus',
  'except',
  'excluding',
  'excluded',
  'skip',
  'skips',
  'skipping',
  'off',
  'out',
  'stay',
  'stays',
  'staying',
  'sit',
  'sits',
  'sitting',
  'leave',
  'leaving',
  'nope',
]);

const INCLUSION_WINDOW = 3;

/** Lowercased words of a phrase, apostrophes trimmed and possessive `'s` dropped. */
function phraseWords(phrase: string): string[] {
  return normalizeText(phrase)
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter((w) => w.length > 0);
}

/**
 * True when some whole-word occurrence of one of `phrases` (each a word list)
 * in `text` has no exclusion word within three words of it in the same
 * sentence. Fails closed: a bare mention counts as included.
 */
function phraseIncluded(text: string, phrases: readonly (readonly string[])[]): boolean {
  const usable = phrases.filter((p) => p.length > 0);
  if (usable.length === 0) return false;
  for (const sentence of normalizeText(text).split(/[\n.?!]+/)) {
    const words = phraseWords(sentence);
    for (let i = 0; i < words.length; i += 1) {
      for (const phrase of usable) {
        if (phrase.some((w, k) => words[i + k] !== w)) continue;
        const lo = Math.max(0, i - INCLUSION_WINDOW);
        const hi = Math.min(words.length - 1, i + phrase.length - 1 + INCLUSION_WINDOW);
        let excluded = false;
        for (let j = lo; j <= hi; j += 1) {
          const w = words[j] ?? '';
          if (EXCLUSION_WORDS.has(w) || w.endsWith("n't")) excluded = true;
        }
        if (!excluded) return true;
      }
    }
  }
  return false;
}

/**
 * True when `text` names `name` as PART of a plan: some mention of the name
 * (full display name or any of its tokens) has no exclusion word within three
 * words of it in the same sentence. Fails closed: a bare mention counts as
 * included.
 */
export function namedAsIncluded(text: string, name: string): boolean {
  return phraseIncluded(
    text,
    nameTokens(name).map((t) => phraseWords(t)),
  );
}

/**
 * Words that refer to a minor without naming them (VOICE §8: "no nightlife or
 * alcohol in any suggestion that includes the minor"). Checked by the outbound
 * screen whenever the group has a minor, so "for the adults and the kid: the
 * bar" is treated like naming the minor.
 */
export const MINOR_REFERENT_TERMS: readonly string[] = [
  'kid',
  'kids',
  'child',
  'children',
  'daughter',
  'daughters',
  'son',
  'sons',
  'teen',
  'teens',
  'teenager',
  'teenagers',
  'little one',
  'little ones',
  'under 18',
  'under 18s',
  'under eighteen',
  'the minor',
  'the minors',
];

const MINOR_REFERENT_PHRASES = MINOR_REFERENT_TERMS.map((t) => phraseWords(t));

/** `namedAsIncluded` for the words in `MINOR_REFERENT_TERMS`. */
export function minorReferentIncluded(text: string): boolean {
  return phraseIncluded(text, MINOR_REFERENT_PHRASES);
}

/**
 * Replace quoted human phrases with spaces of the same length so rules that
 * exempt quotes (exclamation marks, banned phrases, capitals) skip them while
 * offsets stay stable. Handles "double", “curly” (normalized first) and
 * 'single' quotes when the single quote opens after whitespace/start (so
 * apostrophes in "Henry's" are not treated as quotes).
 */
export function blankQuoted(text: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return normalizeText(text)
    .replace(/"[^"\n]*"/g, blank)
    .replace(
      /(^|[\s(])('[^'\n]+')(?=[\s.,;:!?)]|$)/gm,
      (_m, pre: string, q: string) => pre + blank(q),
    );
}
