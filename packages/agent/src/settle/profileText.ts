/**
 * Payment-profile words in a member's DM (T-166): "my venmo is @chase-w",
 * "venmo and zelle, venmo's my fave", "cash app mostly". Pure parsers, no
 * I/O, never the model. A handle is accepted only from an explicit "my venmo
 * is ..." / "venmo: ..." statement, never guessed from a bare word.
 */
import type { HandleRail, PaymentRail } from '@trav/core';
import { payments } from '@trav/core';

/** Rail words, longest first so "cash app" and "apple cash" never read as "cash". */
const RAIL_WORDS: readonly { readonly rail: PaymentRail; readonly re: RegExp }[] = [
  { rail: 'cashapp', re: /\bcash\s?app\b|\bcashtag\b|\bcash\.app\b/giu },
  { rail: 'apple_cash', re: /\bapple\s?(?:cash|pay)\b/giu },
  { rail: 'paypal', re: /\bpay\s?pal(?:\.me)?\b/giu },
  { rail: 'venmo', re: /\bvenmo\b/giu },
  { rail: 'zelle', re: /\bzelle\b/giu },
  { rail: 'cash', re: /\bcash\b/giu },
];

/** Rail mentions in order of appearance. */
function mentions(text: string): { rail: PaymentRail; index: number; end: number }[] {
  const out: { rail: PaymentRail; index: number; end: number }[] = [];
  const taken: [number, number][] = [];
  for (const { rail, re } of RAIL_WORDS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ rail, index: start, end });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export interface HandleStatement {
  readonly rail: HandleRail;
  /** Normalized (`payments.normalizeHandle`); absent when what followed isn't a valid handle. */
  readonly handle?: string;
  /** No handle, and maybe not a try at all ("my venmo is down"): hint gently. */
  readonly soft?: true;
}

/** Words between "my venmo" and the handle itself. */
const HANDLE_FILLER =
  /^(?:\s*(?:handle|username|user\s?name|user|name|tag|id|account|acct|email|e-mail|number|phone|is|it's|its|'s|’s|=|:|-|should\s+be|now))*\s*/iu;

/**
 * "my venmo is @chase-w", "venmo: @chase-w", "my cashtag is $chasew", "my
 * zelle is 617-555-0142". Needs "my <rail>" or "<rail>:" (so "venmo is down"
 * is not a handle). One statement per rail; the last one wins.
 */
export function parseHandleStatements(text: string): HandleStatement[] {
  const found = new Map<HandleRail, HandleStatement>();
  for (const m of mentions(text)) {
    if (!payments.railNeedsHandle(m.rail)) continue;
    const rail = m.rail;
    const before = text.slice(Math.max(0, m.index - 6), m.index);
    const after = text.slice(m.end);
    const owned = /\bmy\s+$/iu.test(before);
    const colon = /^\s*[:=]/u.test(after);
    const handleWord = /^\s*(?:handle|username|user\s?name|tag|id)\b/iu.test(after);
    // "paypal.me/chasew" says it all.
    const inline = rail === 'paypal' && /^\/[A-Za-z0-9]/u.test(after);
    if (!owned && !colon && !handleWord && !inline) continue;
    const rest = (inline ? after.slice(1) : after.replace(HANDLE_FILLER, '')).trim();
    if (rest.length === 0) continue;
    // Zelle: an email, or a phone number that may contain spaces.
    const zelleContact =
      rail === 'zelle'
        ? (/^[^\s,;]+@[^\s,;]+/u.exec(rest)?.[0] ?? /^\+?[\d(][\d\s().-]{8,}\d/u.exec(rest)?.[0])
        : undefined;
    const candidate =
      zelleContact ?? (rail === 'zelle' ? rest.split(/\s+/u)[0]! : rest.split(/[\s,;]+/u)[0]!);
    const tail = rest.slice(candidate.length);
    // The candidate must end the statement: "my paypal is chase w" or "my
    // venmo is acting up" is not a handle (T-166 r1 #2). A clause break or a
    // thanks may follow. A zelle email or phone number can't be a word of a
    // sentence, so words may follow it.
    const ends = zelleContact !== undefined || HANDLE_TAIL.test(tail);
    const sigil = hasSigil(rail, candidate, inline);
    // Without a sigil or a colon, a plain word ("broken", "frozen") is not a
    // handle: it must look like one (a digit, "-" or "_"), so a typo'd
    // sentence never becomes a one-tap link to a stranger's account.
    const shaped = sigil || colon || rail === 'zelle' || /[\d_-]/u.test(candidate);
    const handle = ends && shaped ? payments.normalizeHandle(rail, candidate) : undefined;
    if (handle !== undefined) {
      found.set(rail, { rail, handle });
    } else if (ends ? sigil || colon || handleWord || /\d|@/u.test(candidate) : sigil || colon) {
      // A try that isn't a handle ("my venmo is @x", "venmo: chase w"): say so.
      found.set(rail, { rail });
    } else if (ends && tail.trim().length === 0) {
      // One plain word to end the message: "my venmo is chasew" or "my venmo
      // is down". Never saved; the reply is an "if that was your handle" hint
      // that reads fine either way. "my venmo is down, use zelle" says nothing.
      found.set(rail, { rail, soft: true });
    }
  }
  return [...found.values()];
}

/** What may follow a handle: nothing, a clause break, "and ...", or a thanks. */
const HANDLE_TAIL =
  /^\s*(?:$|[,;.!?\n)]|(?:and|thanks|thx|ty|pls|please|lol|cheers)\b|[\p{Extended_Pictographic}])/iu;

/** The candidate carries its rail's sigil: venmo `@` or link, cash app `$` or link, paypal.me/. */
function hasSigil(rail: HandleRail, candidate: string, inline: boolean): boolean {
  switch (rail) {
    case 'venmo':
      return /^@|venmo\.com\//iu.test(candidate);
    case 'cashapp':
      return /^\$|cash\.app\//iu.test(candidate);
    case 'paypal':
      return inline || /paypal\.me\//iu.test(candidate);
    case 'zelle':
      return false;
  }
}

const FAVOURITE =
  /\b(?:fave|fav|favou?rite|prefer(?:red)?|go-?to|mostly|main|usually|first\s+choice|best)\b/iu;
const EXPLICIT =
  /\b(?:i\s+use|i\s+have|i've\s+got|i\s+got|i'm\s+on|im\s+on|my\s+apps?|fave|fav|favou?rite|prefer(?:red)?|go-?to)\b/iu;
/** Words an answer may carry besides rail names ("venmo and zelle, venmo's my fave pls"). */
const FILLER = new Set([
  'and',
  'or',
  'my',
  'is',
  's',
  'i',
  'use',
  'have',
  'got',
  've',
  'im',
  'm',
  'on',
  'the',
  'but',
  'also',
  'only',
  'just',
  'both',
  'all',
  'mostly',
  'main',
  'usually',
  'fave',
  'fav',
  'favourite',
  'favorite',
  'prefer',
  'preferred',
  'go',
  'to',
  'goto',
  'first',
  'choice',
  'best',
  'pls',
  'please',
  'ok',
  'okay',
  'sure',
  'yeah',
  'yes',
  'yep',
  'ya',
  'oh',
  'hmm',
  'apps',
  'app',
  'a',
  'too',
  'works',
  'fine',
  'then',
  'that',
  'thats',
  'it',
  'its',
  'one',
  'trav',
  'hey',
  'lol',
]);

const NEGATOR =
  /\b(?:no|not|never|nor|without|don['’]?t|do\s+not|haven['’]?t|can['’]?t|isn['’]?t|aren['’]?t|doesn['’]?t)\b/iu;
const NEGATOR_FILLER = ['no', 'not', 'never', 'nor', 'without', 'don', 'dont', 't', 'do'];
for (const w of NEGATOR_FILLER) FILLER.add(w);

/**
 * Rails said NOT to be used (T-166 r1 #3): a mention with a negator between it
 * and the start of its clause or the previous rail ("i have no venmo",
 * "zelle, never venmo", "venmo not paypal"), and the rails listed right after
 * one with "or" / "nor" ("i don't have venmo or zelle"). A comma ends the
 * negation: "i have no venmo, zelle" keeps zelle.
 */
function negatedRails(text: string): Set<PaymentRail> {
  const out = new Set<PaymentRail>();
  const all = mentions(text);
  let prevEnd = 0;
  let prevNegated: boolean = false;
  for (const m of all) {
    const gap = text.slice(prevEnd, m.index);
    const parts = gap.split(/[,;.!?\n]|\bbut\b/iu);
    const inClause = parts.at(-1) ?? '';
    const carried: boolean =
      parts.length === 1 && prevNegated && /^\s*(?:or|nor|\/)?\s*$/iu.test(gap);
    const neg: boolean = NEGATOR.test(inClause) || carried;
    if (neg) out.add(m.rail);
    prevNegated = neg;
    prevEnd = m.end;
  }
  return out;
}

/** Non-rail, non-filler words an explicit "i use ..." statement may carry and still be about apps. */
const MAX_EXTRA_WORDS = 2;

export interface AppsAnswer {
  /** In the order said, no repeats. */
  readonly apps: readonly PaymentRail[];
  /** Named with a "fave / prefer / mostly" word in its own clause. */
  readonly favourite?: PaymentRail;
  /**
   * Exactly one app named, with no favourite word. It becomes the favourite
   * only when it answers Trav's ask or the member has none yet
   * (`applyProfileWords`), so "i use venmo for dinner" never replaces one.
   */
  readonly onlyApp?: PaymentRail;
  /** Said as a statement about their apps ("i use", "my fave"), not just a bare list. */
  readonly explicit: boolean;
  /** Nothing but rail names and filler: safe to take as the answer to Trav's one ask. */
  readonly bare: boolean;
}

/**
 * Which apps a member says they use and which they like best. `undefined` if
 * no rail is named. The favourite is the one rail in a clause with a
 * "fave / prefer / mostly / go-to" word; a single app is the favourite.
 */
export function parseAppsAnswer(text: string): AppsAnswer | undefined {
  const all = mentions(text);
  if (all.length === 0) return undefined;
  const negated = negatedRails(text);
  const apps: PaymentRail[] = [];
  for (const m of all) if (!apps.includes(m.rail) && !negated.has(m.rail)) apps.push(m.rail);
  if (apps.length === 0) return undefined;
  let favourite: PaymentRail | undefined;
  // Clauses: split on punctuation and "but" so "mostly venmo but zelle works" keeps venmo.
  const clauses = text.split(/[,;.!?\n]+|\bbut\b/iu);
  for (const clause of clauses) {
    if (!FAVOURITE.test(clause)) continue;
    const inClause = [
      ...new Set(
        mentions(clause)
          .map((m) => m.rail)
          .filter((r) => apps.includes(r)),
      ),
    ];
    if (inClause.length === 1) {
      favourite = inClause[0];
      break;
    }
  }
  let rest = text.toLowerCase();
  for (const { re } of RAIL_WORDS) rest = rest.replace(re, ' ');
  const words = rest
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !FILLER.has(w));
  return {
    apps,
    ...(favourite !== undefined ? { favourite } : {}),
    // One app named: the caller decides whether it becomes the favourite (r1 #5).
    ...(apps.length === 1 ? { onlyApp: apps[0]! } : {}),
    // "i use venmo, zelle if i have to" yes; "i have cash for the taxi tonight" no.
    explicit: EXPLICIT.test(text) && words.length <= MAX_EXTRA_WORDS,
    bare: words.length === 0,
  };
}
