/**
 * Booking-request parsing (T-081): the deterministic reading of a ticket ask
 * the offline model uses ("@trav get the 5 of us Razzmatazz tickets, Henry's
 * sick", "barça vs sevilla sunday mar 15, 6 tickets together, sideline",
 * "park güell friday 10am for 6"). Pure: no clock, no stores.
 *
 * What it reads, and nothing else:
 *  - the venue, from the ticket inventory's own names and `keywords` (aliases
 *    like "razz", "barça"), folded so "güell" = "guell". A term two venues
 *    share ("club", "gaudi") is generic: it only counts next to "tickets".
 *  - who: a headcount ("for 6", "6 tickets", "the 5 of us", "all 6"), everyone
 *    ("all of us", "get us"), the sender ("for me"), and who is out, through
 *    `parseRosterUpdate` per clause ("Henry's sick" ⇒ Henry) or "everyone but
 *    Henry". The reason is matched only to recognize the clause and is never
 *    part of the result, so it can't be repeated back.
 *  - the night ("tonight", "tomorrow", a weekday, "mar 15") as a canonical
 *    word the proposal service resolves against the trip clock.
 *  - a seat tier ("sideline", "vip mezzanine"), as words the offer's tier name
 *    must contain.
 * It never decides price, availability or approval: that is the proposal
 * service and `ApprovalPolicy`.
 */
import type { IsoDate } from '@trav/core';
import { addDays } from '@trav/core';
import { parseRosterUpdate } from '../roster/index.js';

/** The slice of a ticket inventory the parser reads (structurally `TicketInventory`). */
export interface InventoryLike {
  readonly events: readonly {
    readonly event: {
      readonly name: string;
      readonly venue: { readonly name: string; readonly city?: string };
    };
    readonly keywords: readonly string[];
    readonly offers: readonly { readonly offer: { readonly tierName: string } }[];
  }[];
}

export interface VenueEntry {
  /** Folded venue name, the grouping key. */
  readonly key: string;
  /** Folded search terms: venue name, event names, keywords. */
  readonly terms: readonly string[];
  /** Folded words from this venue's tier names ("vip", "mezzanine", "lateral"). */
  readonly tierWords: readonly string[];
}

export interface VenueIndex {
  readonly venues: readonly VenueEntry[];
  /** Terms that alone don't name one venue (shared by two or more, or a category word). */
  readonly generic: ReadonlySet<string>;
}

/** Lowercase, accents dropped ("Barça" ⇒ "barca", "Güell" ⇒ "guell"), curly quotes straightened. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").toLowerCase();
}

/** Category words that never name one venue on their own (also skipped when the service scores a query). */
export const CATEGORY_WORDS: ReadonlySet<string> = new Set([
  'club',
  'clubbing',
  'party',
  'techno',
  'show',
  'park',
  'match',
  'game',
  'football',
  'soccer',
  'futbol',
  'tour',
  'museum',
  'concert',
  'gig',
  'beach',
  'boat',
  'night',
  'evening',
  'session',
]);

/** Words from venue and event names that never identify a venue ("fado night with dinner" ⇒ only "fado"). */
const NAME_NOISE = new Set([
  ...CATEGORY_WORDS,
  'dinner',
  'lunch',
  'brunch',
  'breakfast',
  'food',
  'drinks',
  'with',
  'timed',
  'entry',
  'the',
  'and',
  'morning',
  'afternoon',
  'tonight',
  'today',
  'fictional',
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'closing',
]);

/** Tier-name words that say nothing about which seats ("General admission", "10:00 slot"). */
const TIER_NOISE = new Set([
  'general',
  'admission',
  'entry',
  'slot',
  'ticket',
  'tickets',
  'line',
  'zone',
  'show',
  'and',
  'the',
  'with',
]);

/** Seat words members use that tier names spell differently. */
const TIER_ALIASES: readonly { readonly re: RegExp; readonly words: readonly string[] }[] = [
  { re: /\bside ?lines?\b|\bsideline seats?\b/, words: ['lateral', 'tribuna', 'sideline'] },
  { re: /\bbehind the goal\b|\bgoal end\b/, words: ['gol', 'goal'] },
  { re: /\bvip\b/, words: ['vip'] },
  { re: /\bfast[- ]?(?:line|track)\b|\bskip the line\b/, words: ['fast'] },
  { re: /\btowers?\b/, words: ['towers'] },
];

function eventHead(name: string): string {
  return (name.split(/[:·|]/)[0] ?? name).trim();
}

/** "Cais Club (fictional)" ⇒ "cais club". */
function nameTerm(name: string): string {
  return foldText(name)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameWords(term: string): string[] {
  return term
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !/\d/.test(w) && !NAME_NOISE.has(w));
}

/** Builds the venue index from ticket inventories (every bundled city; the service searches the trip's own). */
export function venueIndexFrom(inventories: readonly InventoryLike[]): VenueIndex {
  const byKey = new Map<string, { terms: Set<string>; tierWords: Set<string> }>();
  // A city is never a venue ("fc barcelona vs sevilla" must not claim every "barcelona").
  const cities = new Set<string>();
  for (const inv of inventories) {
    for (const e of inv.events) {
      if (e.event.venue.city !== undefined) cities.add(nameTerm(e.event.venue.city));
    }
  }
  for (const inv of inventories) {
    for (const e of inv.events) {
      const key = nameTerm(e.event.venue.name);
      const entry = byKey.get(key) ?? { terms: new Set<string>(), tierWords: new Set<string>() };
      const head = nameTerm(eventHead(e.event.name));
      entry.terms.add(key);
      entry.terms.add(head);
      // Single distinctive words, so "tile workshop" finds "azulejo tile-painting workshop".
      for (const w of [...nameWords(key), ...nameWords(head)]) {
        if (!cities.has(w)) entry.terms.add(w);
      }
      // The two-word lead of the name, so short words still find it: "jet ski
      // rental, 1 hour" ⇒ "jet ski" (T-081 r1 #8).
      const lead = head.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
      if (
        lead.length >= 2 &&
        lead.slice(0, 2).every((w) => w.length >= 3 && !/\d/.test(w) && !NAME_NOISE.has(w)) &&
        !cities.has(`${lead[0]!} ${lead[1]!}`)
      ) {
        entry.terms.add(`${lead[0]!} ${lead[1]!}`);
      }
      for (const k of e.keywords) entry.terms.add(foldText(k).trim());
      for (const o of e.offers) {
        for (const w of foldText(o.offer.tierName).split(/[^a-z0-9]+/)) {
          if (w.length >= 3 && !TIER_NOISE.has(w) && !/^\d+$/.test(w)) entry.tierWords.add(w);
        }
      }
      byKey.set(key, entry);
    }
  }
  const count = new Map<string, number>();
  for (const { terms } of byKey.values()) {
    for (const t of terms) count.set(t, (count.get(t) ?? 0) + 1);
  }
  const generic = new Set<string>();
  for (const [t, n] of count) if (n > 1 || CATEGORY_WORDS.has(t)) generic.add(t);
  const venues: VenueEntry[] = [...byKey].map(([key, v]) => ({
    key,
    terms: [...v.terms].filter((t) => t.length >= 3),
    tierWords: [...v.tierWords],
  }));
  return { venues, generic };
}

// ---------- numbers, days ----------

const NUMBER_WORDS: Readonly<Record<string, number>> = {
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
const NUM = String.raw`(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

function toCount(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s];
  return n !== undefined && n >= 1 && n <= 50 ? n : undefined;
}

export const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const WEEKDAY_RE =
  /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;

/**
 * The night a request names, canonical: `tonight`, `tomorrow`, a weekday
 * (`friday`), or `MM-DD` for a calendar date ("mar 15", "15 march"). A date
 * wins over a weekday ("sunday mar 15" ⇒ `03-15`).
 */
export function parseDayWord(folded: string): string | undefined {
  const md =
    new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b`).exec(folded) ?? undefined;
  const dm =
    md === undefined
      ? (new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}`).exec(folded) ??
        undefined)
      : undefined;
  const month = md?.[1] ?? dm?.[2];
  const day = md?.[2] ?? dm?.[1];
  if (month !== undefined && day !== undefined) {
    const m = MONTHS.indexOf(month.slice(0, 3)) + 1;
    const d = Number(day);
    if (m >= 1 && d >= 1 && d <= 31)
      return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const wd = WEEKDAY_RE.exec(folded)?.[1];
  if (wd !== undefined) {
    const full = WEEKDAYS.find((w) => w.startsWith(wd.slice(0, 3)));
    if (full !== undefined) return full;
  }
  if (/\b(?:tonight|tonite|tn|today|this evening)\b/.test(folded)) return 'tonight';
  if (/\b(?:tomorrow|tmrw|tmr)\b/.test(folded)) return 'tomorrow';
  return undefined;
}

function weekdayOf(date: IsoDate): Weekday {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

/** Weekday name of a calendar date ("2026-03-13" ⇒ "friday"). */
export function weekdayName(date: IsoDate): Weekday {
  return weekdayOf(date);
}

/**
 * Resolves a `parseDayWord` result to a calendar night. `tonight` is the
 * current night; a weekday is the first such night from `base` (tonight, or
 * the trip's first night when the trip hasn't started); `MM-DD` takes the
 * trip's year. Unknown words ⇒ undefined (the caller treats it as unsaid).
 */
export function resolveNight(
  day: string,
  tonight: IsoDate,
  trip?: { readonly startDate: IsoDate; readonly endDate: IsoDate },
): IsoDate | undefined {
  const w = day.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  if (w === 'tonight' || w === 'today') return tonight;
  if (w === 'tomorrow') return addDays(tonight, 1);
  const wd = WEEKDAYS.find((x) => x === w);
  if (wd !== undefined) {
    const base = trip !== undefined && trip.startDate > tonight ? trip.startDate : tonight;
    for (let i = 0; i < 7; i++) {
      const d = addDays(base, i);
      if (weekdayOf(d) === wd) return d;
    }
    return undefined;
  }
  const md = /^(\d{2})-(\d{2})$/.exec(w);
  if (md !== null) {
    const startYear = (trip?.startDate ?? tonight).slice(0, 4);
    const endYear = (trip?.endDate ?? tonight).slice(0, 4);
    const first = `${startYear}-${md[1]}-${md[2]}`;
    if (trip !== undefined && first < trip.startDate && endYear !== startYear) {
      return `${endYear}-${md[1]}-${md[2]}`;
    }
    return first;
  }
  return undefined;
}

// ---------- the request ----------

export interface BookingRequest {
  readonly kind: 'ticket';
  /** What the ticket search matches: the venue terms the member used, plus "tickets". */
  readonly query: string;
  /** Headcount the member stated ("for 6", "the 5 of us"); absent ⇒ everyone who's in. */
  readonly quantity?: number;
  /** Display names said to be out ("Henry's sick" ⇒ Henry). Never the reason. */
  readonly excludedNames: readonly string[];
  /** Exactly who is going, when the member said ("for me"). */
  readonly attendeeNames?: readonly string[];
  /** `parseDayWord` result. */
  readonly day?: string;
  /** Words the offer's tier name must contain ("lateral", "vip"). */
  readonly tier?: readonly string[];
  readonly requestText: string;
}

const BOOK_VERB = /\b(?:get|grab|book|buy|reserve|snag|score|order|lock in|sort)\b/;
const TICKET_WORD = /\b(?:tickets?|tix|passes|entry|entries|spots)\b/;
/** Logging, not booking: an amount, or something already paid for. */
const EXPENSE_CUE =
  /[€$£]\s?\d|\b\d+(?:[.,]\d+)?\s?(?:eur|euros?|usd|dollars|bucks)\b|\b(?:paid|bought|spent|covered|put it on|on the tab|log|logged|owe)\b/;
const BUDGET_RE =
  /\b(?:under|below|max|less than|up to|at most|no more than)\s*[€$£]?\s?\d+(?:[.,]\d+)?\s?(?:eur|euros?|usd|dollars)?(?:\s*(?:each|a head|per person|pp|total))?/;
const APPROVAL_CLAIM =
  /\b(?:approv\w*|ok'?d|okay(?:ed|ing)?|sign(?:ed|ing)? off|on (?:his|her|their) behalf|said (?:it'?s )?(?:fine|ok|yes)|vouch\w*)\b|\bthe \S+(?: \S+)? ones\b/;
const CANCEL_CUE = /\b(?:cancel|drop|nvm|never ?mind|don'?t book|scrap|forget)\b/;
/**
 * Not asking for anything (T-081 r1 #3): "don't get razz tickets", "hold off
 * on razz". Only counts when it comes before the booking verb (or the venue)
 * in the booking's own clause (T-148 #3): "get razz tickets, don't count
 * henry" and "…, henry doesn't want to come" are still asks.
 */
const NEGATION_CUE =
  /\b(?:don'?t|dont|do not|doesn'?t|no need|not (?:yet|now|getting|buying|booking)|hold off|wait on|no (?:tickets|tix)|never)\b/;
/** A later clause that takes the whole ask back: "get razz tickets… actually don't". */
const RETRACTION =
  /^(?:(?:actually|nah|no|wait|jk|hmm|or|ok|okay)\s+)*(?:don'?t|dont|do not)(?:\s+(?:do it|bother|(?:get|book|buy|grab) (?:them|those|it|any)))?$/;
/**
 * A question about tickets, not an ask for them: "how much are razz tickets",
 * "did anyone get razz tickets". Checked on the booking's own sentence
 * (T-148 #3), so "anyone else want in? get razz tickets for all of us" and
 * "do it, get razz tickets" are asks.
 */
const QUESTION_LEAD =
  /^(?:(?:ok|okay|so|hey|yo|wait|hmm|and|but|also|btw)[\s,]+)*(?:how|what|whats|which|who|whos|whose|when|where|why|did|does|do(?!\s+(?:it|that|this)\b)|is|are|was|were|has|have|had|should|shall|anyone|anybody|any)\b/;
const QUESTION_ANYWHERE =
  /\b(?:should we|do we|did (?:you|we|anyone|anybody)|has (?:anyone|anybody)|how much|how many|who has|who got|anyone (?:got|have|has|get))\b/;
/** A question about what's on offer (price, info), answerable with a search (T-148 #8). */
const INFO_QUESTION =
  /\b(?:how much|price|prices|pricing|cost|costs|should we|shall we|could we|can we|is there|are there|any good|worth it|what about|how about|what time|when is|when are)\b/;
/** A question about tickets someone already has: never a price reply. */
const HELD_QUESTION =
  /\b(?:who (?:has|got|is)|whos|did (?:you|we|anyone|anybody)|has (?:anyone|anybody)|anyone (?:got|have|has|get))\b/;
/** Sentence breaks (questions end at "?"), and clause breaks within a sentence. */
const SENTENCE_SPLIT = /[.?!;]+|\s+-\s+/;
const CLAUSE_SPLIT = /[,.?!;]+|\s+-\s+/;
/** Words that end a "for me and …" list without being a name ("for me, tonight"). */
const LIST_STOP = new Set([
  'tonight',
  'tonite',
  'today',
  'tomorrow',
  'tmrw',
  'pls',
  'please',
  'thanks',
  'thx',
  'too',
]);
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\bat \d{1,2}(?::\d{2})?\b/g;
const NOT_NAME = new Set([
  // Pronouns ("everyone but Henry, he's sick" names Henry once, not "He").
  'he',
  'she',
  'they',
  'we',
  'i',
  'us',
  'me',
  'you',
  'him',
  'her',
  'his',
  'them',
  'their',
  'my',
  'our',
  'your',
  'not',
  'no',
  'the',
  'a',
  'an',
  'that',
  'this',
  'it',
  'tickets',
  'ticket',
  'tix',
  'everyone',
  'all',
  'one',
]);

function termRe(term: string): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`);
}

/** "Dean: @trav get …" ⇒ { sender: "Dean", text: "get …" } (the loop prefixes the display name). */
export function splitSender(raw: string): { readonly sender?: string; readonly text: string } {
  const m = /^([^:\n]{1,40}):\s([\s\S]*)$/.exec(raw);
  const sender = m?.[1]?.trim();
  const text = (m === null ? raw : m[2]!)
    .replace(/(^|[^\w@])@trav(?![\w-])\s*[,:]?/gi, '$1')
    .replace(/^\s*(?:(?:hey|hi|yo|ok|okay)\s+)?trav\s*[,:]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sender === undefined || sender.length === 0 ? { text } : { sender, text };
}

function headcount(t: string): number | undefined {
  const patterns = [
    new RegExp(String.raw`\b(?:the|all)\s+${NUM}\s+of\s+us\b`),
    new RegExp(String.raw`\b${NUM}\s+of\s+us\b`),
    new RegExp(String.raw`\ball\s+${NUM}\b`),
    new RegExp(String.raw`\b${NUM}\s+(?:tickets?|tix|passes|spots|people|ppl|of them)\b`),
    // "2 razz tickets", "6 vip mezzanine tix" (never a date: "mar 15 barça tickets").
    new RegExp(
      String.raw`(?<!\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s)\b${NUM}\s+(?:[a-z][a-z'-]*\s+){1,3}(?:tickets?|tix|passes|spots)\b`,
    ),
    new RegExp(
      String.raw`\bfor\s+(?:the\s+)?${NUM}\b(?!\s*(?:nights?|days?|hours?|h\b|euros?|eur\b))`,
    ),
  ];
  for (const re of patterns) {
    const n = toCount(re.exec(t)?.[1]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function exclusions(original: string, folded: string, sender: string | undefined): string[] {
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    const n = name?.trim();
    if (n === undefined || n.length < 2 || NOT_NAME.has(n.toLowerCase())) return;
    if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  };
  for (const clause of original.split(/[,.;!?]|\s+-\s+|\band\b(?=\s+\S+(?:'s|\s+is)\s)/i)) {
    const c = clause.trim();
    if (c.length === 0) continue;
    const u = parseRosterUpdate(c);
    if (u === undefined || u.status !== 'out') continue;
    add(u.who === 'me' ? sender : u.who);
  }
  // A capitalized name mid-sentence ("…Razzmatazz tickets Henry's sick", a
  // line break the chat flattened): only the name is kept, never the reason.
  for (const m of original.matchAll(
    /\b([A-Z][a-z'-]{1,29})(?:'s|’s| is)\s+(?:sick|ill|out|not coming|not going|staying in|staying home)\b/g,
  )) {
    if (!/^(?:It|That|He|She|There|What|Who|This|Everyone|Everybody)$/.test(m[1]!)) add(m[1]);
  }
  const NAME = String.raw`([a-z][a-z'-]{1,29})`;
  for (const m of folded.matchAll(
    new RegExp(
      // "but" excludes only after a whole-group word ("everyone but Henry");
      // "Henry's out but Maya might join" names no one else out (T-081 r1 #9).
      String.raw`(?:\b(?:everyone|everybody|all(?: of us)?|all \d{1,2}|us|the group|whole group)\s+but|\b(?:except|minus|without))\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
      'g',
    ),
  )) {
    add(m[1]);
    add(m[2]);
  }
  for (const m of folded.matchAll(
    new RegExp(String.raw`(?:^|[,;]\s*)not\s+${NAME}\s*(?=[,;.!?]|$)`, 'g'),
  )) {
    add(m[1]);
  }
  // T-148: "for us but not henry", "don't count henry", "leave henry out",
  // "henry doesn't want to come" (the reason is never kept, only the name).
  const OUT_PATTERNS = [
    String.raw`\bbut\s+not\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
    String.raw`\b(?:don'?t|dont|do not)\s+(?:count|include|add)\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
    String.raw`\bnot\s+(?:counting|including)\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
    String.raw`\b(?:leave|leaving|count)\s+${NAME}\s+out\b`,
    String.raw`\b${NAME}\s+(?:doesn'?t|does not|won'?t|will not|can'?t|cannot|isn'?t)\s+(?:want to\s+|wanna\s+|going to\s+|gonna\s+)?(?:come|go|join|make it|coming|going|joining)\b`,
  ];
  for (const re of OUT_PATTERNS) {
    for (const m of folded.matchAll(new RegExp(re, 'g'))) {
      add(m[1]);
      add(m[2]);
    }
  }
  // Names keep the member's own capitalization when they typed one.
  return out.map((n) => {
    const hit = new RegExp(`\\b(${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i').exec(
      original,
    );
    const typed = hit?.[1] ?? n;
    return typed.charAt(0).toUpperCase() + typed.slice(1);
  });
}

/**
 * "for me and Maya", "for just me and Sam", "for me, maya and sam", "get me
 * and mom …" ⇒ the sender plus those names (T-081 r1 #2). A plain "for me" ⇒
 * just the sender. Something after "and" that isn't a name ("for me and the
 * kids") ⇒ `ambiguous`: no guess, so the ask isn't taken. A comma followed by
 * a new clause ("for me, henry's out") ends the list.
 */
function attendeeList(
  t: string,
  sender: string | undefined,
): { readonly names: readonly string[] } | 'ambiguous' | undefined {
  const head =
    /\b(?:for\s+(?:just\s+|only\s+)?me|(?:get|grab|book|buy|reserve|snag)\s+(?:just\s+)?me)(?![a-z'])/.exec(
      t,
    );
  const single = /\b(?:me one|one for me|get me (?:a |one\b|in\b)|for myself|just me)\b/.test(t);
  if (head === null) {
    return single && sender !== undefined ? { names: [sender] } : undefined;
  }
  let rest = t.slice(head.index + head[0].length);
  const names: string[] = [];
  for (;;) {
    const m = /^(\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)([a-z][a-z'’-]*)/.exec(rest);
    if (m === null) break;
    const andSep = !/^\s*,\s*$/.test(m[1]!);
    const word = m[2]!;
    const isName = /^[a-z][a-z-]{1,29}$/.test(word) && !NOT_NAME.has(word) && !LIST_STOP.has(word);
    if (!isName) {
      if (andSep && !LIST_STOP.has(word)) return 'ambiguous';
      break;
    }
    if (!names.includes(word)) names.push(word);
    rest = rest.slice(m[0].length);
  }
  if (sender === undefined) return names.length > 0 ? 'ambiguous' : undefined;
  return {
    names: [
      sender,
      ...names
        .filter((n) => n !== sender.toLowerCase())
        .map((n) => n.charAt(0).toUpperCase() + n.slice(1)),
    ],
  };
}

function tierWords(folded: string, venue: VenueEntry | undefined): string[] {
  // "sideline not behind the goal": a seat the member ruled out is not a wish.
  const wanted = folded.replace(/\b(?:not|no)\s+(?:the\s+)?[^,.;!?]*/g, ' ');
  const words = new Set<string>();
  for (const a of TIER_ALIASES) if (a.re.test(wanted)) for (const w of a.words) words.add(w);
  if (venue !== undefined) {
    for (const w of venue.tierWords) {
      if (venue.terms.includes(w)) continue;
      if (termRe(w).test(wanted)) words.add(w);
    }
  }
  return [...words];
}

/**
 * A ticket ask, or undefined when the message isn't one (no venue term, no
 * booking signal, a logging or cancel sentence, a generic word without
 * "tickets"). `sender` is the display name the loop prefixed ("Dean").
 */
interface VenueMatch {
  /** The one venue named specifically, if exactly one was. */
  readonly venue: VenueEntry | undefined;
  /** The terms the member used, in the order they wrote them. */
  readonly terms: readonly string[];
  readonly specificCount: number;
}

/** The venue terms in `t`, or undefined when nothing names a venue (a generic word needs "tickets"). */
function matchVenue(t: string, index: VenueIndex): VenueMatch | undefined {
  const matched: { venue: VenueEntry; term: string; specific: boolean }[] = [];
  for (const venue of index.venues) {
    for (const term of venue.terms) {
      if (termRe(term).test(t)) matched.push({ venue, term, specific: !index.generic.has(term) });
    }
  }
  if (matched.length === 0) return undefined;
  const specificVenues = new Set(matched.filter((m) => m.specific).map((m) => m.venue.key));
  if (specificVenues.size === 0 && !TICKET_WORD.test(t)) return undefined;
  const venue = specificVenues.size === 1 ? matched.find((m) => m.specific)!.venue : undefined;
  // A term inside a longer one is dropped, so the search text reads like theirs.
  const used = [
    ...new Set(
      matched
        .filter((m) =>
          venue !== undefined
            ? m.venue.key === venue.key && m.specific
            : specificVenues.size === 0 || m.specific,
        )
        .map((m) => m.term),
    ),
  ];
  const terms = used
    .filter((x) => !used.some((y) => y !== x && y.includes(x)))
    .sort((a, b) => t.search(termRe(a)) - t.search(termRe(b)));
  return { venue, terms, specificCount: specificVenues.size };
}

function firstIndex(re: RegExp, s: string): number {
  const m = re.exec(s);
  return m === null ? -1 : m.index;
}

/**
 * The booking's own clause and sentence (T-148 #3): the first clause with a
 * booking verb and the venue or a ticket word, else the first with a verb,
 * else the first naming the venue. `at` is where the verb (else the venue
 * term, else the ticket word) starts in that clause.
 */
function anchorOf(
  t: string,
  terms: readonly string[],
):
  | {
      readonly sentence: string;
      readonly clause: string;
      readonly at: number;
      readonly later: readonly string[];
    }
  | undefined {
  const rows: { sentence: string; clause: string; verb: number; thing: number }[] = [];
  for (const sentence of t.split(SENTENCE_SPLIT)) {
    for (const raw of sentence.split(CLAUSE_SPLIT)) {
      const clause = raw.trim();
      if (clause.length === 0) continue;
      const venueAt = terms
        .map((term) => {
          const m = termRe(term).exec(clause);
          return m === null ? -1 : m.index;
        })
        .filter((i) => i >= 0);
      const ticketAt = firstIndex(TICKET_WORD, clause);
      const thing = venueAt.length > 0 ? Math.min(...venueAt) : ticketAt;
      rows.push({ sentence: sentence.trim(), clause, verb: firstIndex(BOOK_VERB, clause), thing });
    }
  }
  const pick =
    rows.findIndex((r) => r.verb >= 0 && r.thing >= 0) >= 0
      ? rows.findIndex((r) => r.verb >= 0 && r.thing >= 0)
      : rows.findIndex((r) => r.verb >= 0) >= 0
        ? rows.findIndex((r) => r.verb >= 0)
        : rows.findIndex((r) => r.thing >= 0);
  const row = rows[pick];
  if (row === undefined) return undefined;
  return {
    sentence: row.sentence,
    clause: row.clause,
    at: row.verb >= 0 ? row.verb : row.thing,
    later: rows.slice(pick + 1).map((r) => r.clause),
  };
}

function isQuestion(sentence: string): boolean {
  return QUESTION_LEAD.test(sentence) || QUESTION_ANYWHERE.test(sentence);
}

/** Clears the cues that make a message something other than an ask (logging, cancelling, a budget, an approval claim). */
function notAnAsk(folded: string): boolean {
  // "under €60 a head" is a budget this reading can't honor (no price filter
  // yet), so it isn't taken: proposing €72 to someone who said €60 is wrong.
  if (BUDGET_RE.test(folded)) return true;
  if (EXPENSE_CUE.test(folded) || CANCEL_CUE.test(folded)) return true;
  // "just book the barça ones, i'm approving for everyone" is an approval
  // claim about a card, never a fresh ask (SAFETY E3: the loop audits it).
  return APPROVAL_CLAIM.test(folded);
}

export interface VenueQuestion {
  /** What the ticket search matches ("snorkel tour tickets"). */
  readonly query: string;
  /** Headcount, when they said one ("tickets for 4"). */
  readonly quantity?: number;
}

/**
 * A price or info question about one named venue (T-148 #8): "how much is
 * the snorkel tour", "should we get snorkel tickets for monday?". Never an
 * ask, never about tickets someone already holds ("who has the razz tickets").
 */
export function parseVenueQuestion(text: string, index: VenueIndex): VenueQuestion | undefined {
  const original = text.replace(/\s+/g, ' ').trim();
  if (original.length === 0 || original.length > 300) return undefined;
  const folded = foldText(original);
  if (notAnAsk(folded)) return undefined;
  const t = folded.replace(TIME_RE, ' ');
  const v = matchVenue(t, index);
  if (v?.venue === undefined) return undefined;
  const anchor = anchorOf(t, v.terms);
  if (anchor === undefined || !isQuestion(anchor.sentence)) return undefined;
  if (!INFO_QUESTION.test(anchor.sentence) || HELD_QUESTION.test(anchor.sentence)) return undefined;
  const quantity = headcount(t);
  return {
    query: `${v.terms.join(' ')} tickets`,
    ...(quantity !== undefined ? { quantity } : {}),
  };
}

export function parseBookingRequest(
  text: string,
  index: VenueIndex,
  sender?: string,
): BookingRequest | undefined {
  const original = text.replace(/\s+/g, ' ').trim();
  if (original.length === 0 || original.length > 300) return undefined;
  const folded = foldText(original);
  if (notAnAsk(folded)) return undefined;
  const t = folded.replace(TIME_RE, ' ');

  // ---- the venue ----
  const v = matchVenue(t, index);
  if (v === undefined) return undefined;
  const { venue, terms } = v;

  // ---- questions and negations (r1 #3, T-148 #3) ----
  // Only the booking's own sentence can make it a question, and only a
  // negation ahead of the verb in its own clause, or a later "actually
  // don't", takes it back; "don't count henry" is an exclusion, not a no.
  const anchor = anchorOf(t, terms);
  if (anchor === undefined || isQuestion(anchor.sentence)) return undefined;
  const neg = firstIndex(NEGATION_CUE, anchor.clause);
  if (neg >= 0 && neg < anchor.at) return undefined;
  if (anchor.later.some((c) => RETRACTION.test(c))) return undefined;

  // ---- a booking signal ----
  // A booking verb, a headcount, "for all of us" or "for me (and X)": a
  // ticket word alone ("who has the razz tickets") is never an ask (r1 #3).
  const quantity = headcount(t);
  const list = attendeeList(t, sender);
  if (list === 'ambiguous') return undefined;
  const everyone =
    /\b(?:all of us|everyone|everybody|us all|the group|whole group|all of you)\b/.test(t) ||
    /\b(?:get|grab|book|buy|reserve|snag)\s+us\b/.test(t);
  if (!BOOK_VERB.test(t) && quantity === undefined && !everyone && list === undefined) {
    return undefined;
  }

  const excludedNames = exclusions(original, folded, sender);
  const day = parseDayWord(t);
  const tier = tierWords(t, venue);
  return {
    kind: 'ticket',
    query: `${terms.join(' ')} tickets`,
    ...(quantity !== undefined ? { quantity } : {}),
    excludedNames,
    // Named attendees go to the service, which resolves every name before any
    // roster write and asks when one doesn't match (never a guess).
    ...(list !== undefined ? { attendeeNames: list.names } : {}),
    ...(day !== undefined ? { day } : {}),
    ...(tier.length > 0 ? { tier } : {}),
    requestText: original,
  };
}
