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
    const candidate =
      rail === 'zelle'
        ? (/^[^\s,;]+@[^\s,;]+/u.exec(rest)?.[0] ??
          /^\+?[\d(][\d\s().-]{8,}\d/u.exec(rest)?.[0] ??
          rest.split(/\s+/u)[0]!)
        : rest.split(/[\s,;]+/u)[0]!;
    const handle = payments.normalizeHandle(rail, candidate);
    if (handle !== undefined) {
      found.set(rail, { rail, handle });
    } else if (/^[@$+(]|\d|@/u.test(candidate) || colon || handleWord) {
      // Looked like a handle and isn't one ("my venmo is @x"): say so. "my venmo is down" isn't a try.
      found.set(rail, { rail });
    }
  }
  return [...found.values()];
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

/** Non-rail, non-filler words an explicit "i use ..." statement may carry and still be about apps. */
const MAX_EXTRA_WORDS = 2;

export interface AppsAnswer {
  /** In the order said, no repeats. */
  readonly apps: readonly PaymentRail[];
  readonly favourite?: PaymentRail;
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
  const apps: PaymentRail[] = [];
  for (const m of all) if (!apps.includes(m.rail)) apps.push(m.rail);
  let favourite: PaymentRail | undefined;
  // Clauses: split on punctuation and "but" so "mostly venmo but zelle works" keeps venmo.
  const clauses = text.split(/[,;.!?\n]+|\bbut\b/iu);
  for (const clause of clauses) {
    if (!FAVOURITE.test(clause)) continue;
    const inClause = [...new Set(mentions(clause).map((m) => m.rail))];
    if (inClause.length === 1) {
      favourite = inClause[0];
      break;
    }
  }
  if (favourite === undefined && apps.length === 1) favourite = apps[0];
  let rest = text.toLowerCase();
  for (const { re } of RAIL_WORDS) rest = rest.replace(re, ' ');
  const words = rest
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w.length > 0 && !FILLER.has(w));
  return {
    apps,
    ...(favourite !== undefined ? { favourite } : {}),
    // "i use venmo, zelle if i have to" yes; "i have cash for the taxi tonight" no.
    explicit: EXPLICIT.test(text) && words.length <= MAX_EXTRA_WORDS,
    bare: words.length === 0,
  };
}
