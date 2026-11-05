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
import { isVerbWord } from '../roster/nameVerbs.js';

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
export const TIER_NOISE: ReadonlySet<string> = new Set([
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
  /** The start time the member asked for, as `askedTime` reads it ("3pm", "10:30am", "3"), T-143. */
  readonly time?: string;
  readonly requestText: string;
}

/**
 * The start time in an ask (T-143 r1 #3): "3pm", "at 10:30am", "at 3".
 * Returns a canonical label: `<h>[:mm](am|pm)`, or a bare `<h>[:mm]` when the
 * member gave no am/pm (then both are read, the closer one wins).
 */
export function askedTime(folded: string): string | undefined {
  const m =
    /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)\b/.exec(folded) ??
    // "at 3" is a time unless a price, a per-person phrase or a date follows it
    // ("at 3€ each", "at 3 per person", "at 3/14"); "10.30" is 10:30 (T-143 r2 #2).
    /\bat (\d{1,2})(?:[:.](\d{2}))?\b(?![.,/]\d)(?!\s*(?:of us|of them|people|ppl|tickets|tix|each|per\b|a head|a pop|apiece|€|eur\b|euros?\b|\$|usd\b|dollars?\b|bucks\b|£|gbp\b|pounds?\b|quid\b))/.exec(
      folded,
    );
  if (m === null) return undefined;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return undefined;
  return `${String(h)}${min === 0 ? '' : `:${String(min).padStart(2, '0')}`}${m[3] ?? ''}`;
}

/** Minutes after midnight an `askedTime` label can mean (two for a bare hour); [] when it isn't one. */
export function askedMinutes(label: string): number[] {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(label.trim().toLowerCase());
  if (m === null) return [];
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h < 1 || h > 12 || min > 59) return [];
  const am = (h % 12) * 60 + min;
  const pm = am + 12 * 60;
  if (m[3] === 'am') return [am];
  if (m[3] === 'pm') return [pm];
  return [am, pm];
}

/** Verbs that, next to a venue, ask Trav to buy (T-081). */
// "get in", "get there", "get home" are about moving, not buying (T-158).
const BOOK_VERBS = String.raw`(?:get(?!\s+(?:in|into|inside|there|home|back|ready|going|to)\b)|grab|book|buy|purchase|reserve|snag|score|order|secure|lock in)`;
const BOOK_VERB = new RegExp(String.raw`\b${BOOK_VERBS}\b`);
const TICKET_WORD = /\b(?:tickets?|tix|passes|entry|entries|spots)\b/;
/**
 * Softer asks (T-158): "we need razz entry", "pick up razz passes", "sort us
 * razz tix", "line up razz tickets for tonight". None of these verbs names a
 * purchase on its own ("we need a nap before razz", "sort the razz photos",
 * "pick up henry from razz"), so one counts only in a clause where every
 * other word is accounted for (`softAskIndex`, T-158 r1 #2): a plural ticket
 * word after it (`SOFT_ASK`) or the venue and the whole party (`SOFT_PARTY`),
 * with only venue words and a count in between and only a night, the party
 * and who's out after. So "we need razz passes printed", "need razz passes
 * from crowley" and "we need razz tickets lol jk" are chat, not asks.
 */
const SOFT_VERB = String.raw`(?:need|pick(?: us| me)? up|sort(?: us| me)?(?: out)?|line(?: us| me)? up|set (?:us|me) up|hook (?:us|me) up|organi[sz]e|arrange|could use)`;
/**
 * "we want razz tickets" is a wish, not yet an ask: a want counts only with
 * a headcount, the party ("for us", "all of us", named people) or a "please"
 * in its clause (T-158 r1 #3: "we want razz tickets but henry wants apolo").
 */
const WANT_VERB = String.raw`(?:(?:we|i) (?:want|wanna)|(?:we|i)'?d like|(?:we|i) would like)`;
const ANY_SOFT = String.raw`(?:${SOFT_VERB}|${WANT_VERB})`;
const WANT_RE = new RegExp(String.raw`^${WANT_VERB}$`);
/**
 * A soft verb, then at most four words, then a plural ticket word. Never
 * "need to …" (that's another verb's job), never through a determiner or
 * possessive ("need my razz ticket", "sort the razz tickets": tickets someone
 * holds), never "a"/"one" (one ticket is not the group's), and never a ticket
 * word that is about something else ("razz entry info", "entry time").
 */
const SOFT_GAP = String.raw`(?:\s+(?!(?:my|our|your|his|her|their|the|those|these|that|this|a|an|one|them|it|any|than|instead|rather|vs|versus|more|less|not|no)\b)[a-z0-9'-]+)`;
const SOFT_ASK = new RegExp(
  String.raw`\b(?<verb>${ANY_SOFT})(?!\s+to\b)(?<gap>${SOFT_GAP}{0,4}?)\s+(?:tickets|tix|passes|entry|entries|spots|wristbands)\b(?<tail>.*)$`,
);
/**
 * A soft verb, the venue, then the whole party (T-158): "sort razzmatazz for
 * us tonight", "line up razz for everyone". The caller checks the words in
 * between name the venue (`aboutSomethingElse` keeps "sort the uber to razz
 * for us" out).
 */
const SOFT_PARTY = new RegExp(
  String.raw`\b(?<verb>${ANY_SOFT})(?!\s+to\b)(?<gap>${SOFT_GAP}{1,4}?)\s+for\s+(?:us|all of us|us all|everyone|everybody|the group|the whole group|the crew|(?:the\s+|all\s+)?${NUM}(?:\s+of us)?)\b(?<tail>.*)$`,
);
/** Words a soft verb may have before its ticket word, besides venue words and a count ("sort us out with razz"). */
const SOFT_GAP_OK: ReadonlySet<string> = new Set(['us', 'me', 'out', 'with', 'up', 'of', 'all']);
/** Words a soft ask may end with: a night, the party, who's out, "please". */
const SOFT_TAIL_OK: ReadonlySet<string> = new Set([
  'tonight',
  'tonite',
  'today',
  'tomorrow',
  'tmrw',
  'pls',
  'please',
  'plz',
  'thanks',
  'thx',
  'ty',
  'too',
  'asap',
  'now',
  'rn',
  'right',
  'on',
  'this',
  'next',
  'night',
  'for',
  'us',
  'all',
  'of',
  'everyone',
  'everybody',
  'the',
  'group',
  'whole',
  'crew',
  'rest',
  'me',
  'myself',
  'and',
  '&',
  '+',
  'minus',
  'except',
  'excluding',
  'without',
  'sans',
  'not',
  'other',
  'than',
  'apart',
]);
/** After these, a soft ask's tail may name people ("for chase and me", "minus henry"). */
const SOFT_NAME_LEAD: ReadonlySet<string> = new Set([
  'for',
  'minus',
  'except',
  'excluding',
  'without',
  'sans',
  'not',
  'than',
  'from',
  'and',
  '&',
  '+',
  'me',
]);
/**
 * What a ticket verb can take that is not a ticket (T-158): "get us a taxi to
 * razz", "grab drinks at razz", "sort the razz photos". In a clause with no
 * ticket word one of these makes it chat, not an ask. A word the venue's own
 * name or tiers use ("table" at a venue that sells tables) doesn't count.
 */
const NOT_A_TICKET =
  /\b(?:taxis?|cabs?|ubers?|lyfts?|rides?|lifts?|cars?|photos?|pics?|pictures?|videos?|playlists?|directions|address|nap|outfits?|drinks|shots|snacks|food|tables?)\b/g;
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
 * on razz", and anywhere else in the message too (T-148 r1 #1): "…, but don't
 * buy them yet", "…, hold off till henry confirms", "…, not yet though". The
 * one exemption is a negation that governs a member's name ("don't count
 * henry", "henry doesn't want to come"): that is an exclusion, and it is
 * removed (`withoutNameNegations`) before this is tested.
 */
const NEGATION_CUE =
  /\b(?:don'?t|dont|do not|doesn'?t|no need|not (?:yet|now|getting|buying|booking|gonna|going to)|hold off|wait on|no (?:tickets|tix)|never|can'?t|cant|cannot|can not|couldn'?t|won'?t|wont|wouldn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|shouldn'?t|haven'?t|hasn'?t|no way)\b/;
/** "never been (here)": about the venue, not the booking (T-148 #3). A whole clause only. */
const NEVER_BEEN = /(?:^|[,.;!?]\s*)never been(?:\s+(?:here|there|before))?\s*(?=[,.;!?]|$)/g;
/**
 * Negated phrases that never take the ask back (T-148 r2 #1, #3): "don't count
 * me out" (an inclusion), "we've never been", "don't care which tier",
 * "doesn't matter which night", "no need for vip", "don't wait (on henry)".
 */
const HARMLESS_NEGATIONS =
  /\b(?:(?:don'?t|dont|do not)\s+(?:count|leave)\s+(?:[a-z][a-z'-]*\s+(?:and|or|&)\s+)?[a-z][a-z'-]*\s+out|(?:(?:we'?ve|i'?ve|we have|i have|weve|ive)\s+)?never been(?:\s+(?:here|there|before))?|(?:don'?t|dont|do not)\s+care(?:\s+(?:about|which|what))?|(?:doesn'?t|does not|don'?t|dont)\s+matter|no need for|(?:can'?t|cant|cannot)\s+wait|(?:don'?t|dont|do not)\s+wait(?:\s+(?:on|for)\s+[a-z][a-z'-]*)?)\b/g;
/** `folded` without the negated phrases that never take an ask back. */
function withoutHarmlessNegations(folded: string): string {
  return folded.replace(HARMLESS_NEGATIONS, ' ');
}
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

/** Short words a "don't count X" / "but not X" pattern can catch that are never names. */
const NOT_NAME_FILLER = new Set([
  'on',
  'in',
  'at',
  'to',
  'for',
  'out',
  'up',
  'yet',
  'now',
  'any',
  'those',
  'these',
  'anyone',
  'anybody',
  'everybody',
  'nobody',
  'night',
  'morning',
  'afternoon',
  'evening',
  'weekend',
  'week',
  'yesterday',
  // Tier and add-on words (T-148 r2 #4): "but not vip", "dont add tax".
  'vip',
  'general',
  'premium',
  'tax',
  'taxes',
  'drinks',
  'fees',
  'fee',
  'extras',
  'tip',
  // "…. not sure", "not really", "not again" (T-158: "not X" now reads after any sentence end).
  'sure',
  'really',
  'quite',
  'exactly',
  'necessarily',
  'bad',
  'great',
  'ideal',
  'cheap',
  'much',
  'many',
  'again',
  'ok',
  'okay',
  'too',
  'so',
  'that',
  'this',
  'there',
  'here',
  'tho',
  'though',
]);

const NAME = String.raw`([a-z][a-z'-]{1,29})`;
/** Words for the whole group (T-173): "everyone", "all of us", "the whole crew", "all 6". */
const GROUP_WORD = String.raw`(?:everyone|everybody|all of us|us all|all (?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: of us)?|all|us|the group|(?:the )?whole (?:group|crew|gang|squad|lot)|the (?:crew|gang|squad|lot of us)|(?:the )?rest of us)`;
/** The same, as a test on a whole message ("everyone else" is the rest, not the group). */
const GROUP_WORD_RE = new RegExp(
  String.raw`\b(?:everyone|everybody|all of us|us all|all (?:\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|(?:the )?whole (?:group|crew|gang|squad|lot)|the (?:group|crew|gang|squad|lot of us))\b(?!\s+else)`,
);
/** A word that, right before "for", makes the "for …" an exclusion, never the party ("save for henry"). */
const CONNECTIVE_BEFORE_FOR =
  /\b(?:except|save|bar|but|aside|apart|besides|other than|minus|without|excluding|sans|not|leaving|leave|skip|skipping|ignoring|barring)\s+$/;

/**
 * Could `word` (folded) be a member's name in an exclusion (T-148 r1 #2)?
 * Never a pronoun, a list stop, a day word ("but not tonight", "but not
 * friday") or a filler ("dont count on it"). "me" is the sender's own name.
 */
function exclusionName(word: string | undefined, sender: string | undefined): string | undefined {
  const w = word?.trim().toLowerCase();
  if (w === undefined || w.length < 2) return undefined;
  if (w === 'me' || w === 'myself') return sender;
  if (NOT_NAME.has(w) || LIST_STOP.has(w) || NOT_NAME_FILLER.has(w)) return undefined;
  // "dont count henry and don't buy yet": a negation is never a name (T-148 r2 #2).
  if (/^(?:don'?t|dont|not|no|never|doesn'?t|won'?t|can'?t)$/.test(w)) return undefined;
  if (
    parseDayWord(w) !== undefined ||
    /^(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)$/.test(w)
  ) {
    return undefined;
  }
  return w;
}

/** Negations that govern a name: "don't count henry (or chase)", "henry doesn't want to come". */
const NAME_NEGATIONS: readonly string[] = [
  String.raw`\b(?:don'?t|dont|do not)\s+(?:count|include|add)\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?(?:\s+(?:in|out))?`,
  String.raw`\bnot\s+(?:counting|including)\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
  String.raw`\b${NAME}\s+(?:doesn'?t|does not|didn'?t|won'?t|will not|can'?t|cant|cannot|isn'?t|is not|aren'?t)\s+(?:want to\s+|wanna\s+|going to\s+|gonna\s+)?(?:come|go|join|make it|coming|going|joining|be there|be coming|be joining|feeling (?:it|well|great|good|100|up to it)|up for it)\b`,
];

/**
 * `folded` without the negations that govern a real name (and a whole-clause
 * "never been"), so any `NEGATION_CUE` left is about the booking itself.
 * Only spans whose every captured word is a name are removed: "dont count on
 * it" stays, so it still reads as a no.
 */
function withoutNameNegations(folded: string, sender: string | undefined): string {
  let out = withoutHarmlessNegations(folded).replace(NEVER_BEEN, ' ');
  for (const re of NAME_NEGATIONS) {
    out = out.replace(new RegExp(re, 'g'), (span: string, ...args: unknown[]) => {
      // The capture groups come before the numeric offset.
      const groups = args.slice(
        0,
        args.findIndex((x) => typeof x === 'number'),
      );
      const names = groups.filter((g): g is string => typeof g === 'string');
      return names.every((w) => exclusionName(w, sender ?? 'me') !== undefined) ? ' ' : span;
    });
  }
  return out;
}

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
  // "razz tickets x5", "get razz x 5", "5x razz tickets" (T-173): a count
  // suffix, only next to a ticket word or a buy verb ("water 1L x2" is a
  // receipt line, never a headcount).
  if (TICKET_WORD.test(t) || BOOK_VERB.test(t)) {
    for (const re of [
      /(?:^|[\s,])x\s?(\d{1,2})(?!\d|[:/x]|[.,]\d)/,
      /(?:^|\s)(\d{1,2})\s?x\s+(?=[a-z])/,
    ]) {
      const n = toCount(re.exec(t)?.[1]);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

/** Ways a member is out for the night (T-158). Matched only to recognize the clause, never kept. */
const OUT_REASON = String.raw`(?:sick|ill|unwell|poorly|rough|under the weather|hungover|wrecked|wiped(?: out)?|knackered|exhausted|out|out tonight|staying (?:in|home|back)|sitting (?:this one|it|tonight) out|bailing|bailed|skipping(?: it| tonight| this one)?|passing|not (?:coming|going|joining|in|up for it|feeling (?:it|well|great|good|100))|can'?t (?:come|make it|go)|cannot (?:come|make it|go)|isn'?t (?:coming|going)|won'?t (?:come|make it|be there))`;
/**
 * A clause that only says a member (or two) is out: "henry's feeling rough",
 * "henry is under the weather", "and henry's not coming", "since henry is
 * sick", "chase and henry are sick". The names are groups 1 and 2.
 */
const OUT_CLAUSE = new RegExp(
  String.raw`^(?:(?:and|but|also|plus|oh|btw|since|because|cause|cuz|as)\s+)*(i'?m|i am|i'?ve been|[a-z][a-z-]{1,29})(?:\s+(?:and|&)\s+([a-z][a-z-]{1,29}))?(?:'s|\s+is|\s+are|\s+were|\s+has been|\s+have been|'s been)?\s+(?:(?:feeling|looking|a bit|a little|kinda|kind of|so|too|pretty|really|super|still|very|totally|completely)\s+)*${OUT_REASON}(?:\s+(?:and\s+)?${OUT_REASON})*(?:\s+(?:tonight|today|rn|right now|again|lol|tho|though))*$`,
);

function exclusions(
  original: string,
  rawFolded: string,
  sender: string | undefined,
  skip: ReadonlySet<string>,
  roster?: ReadonlyMap<string, string>,
): string[] {
  // "don't count me out" includes the sender (T-148 r2 #1).
  const folded = withoutHarmlessNegations(rawFolded);
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    const n = name?.trim();
    if (n === undefined || n.length < 2 || NOT_NAME.has(n.toLowerCase())) return;
    // "razz is out tonight" is about the venue, never a member (T-158).
    if (skip.has(foldText(n))) return;
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
  for (const m of folded.matchAll(
    new RegExp(
      // "but" excludes only after a whole-group word ("everyone but Henry");
      // "Henry's out but Chase might join" names no one else out (T-081 r1 #9).
      // T-173: every common exclusion connective, so an unknown one can't
      // leave the excluded member as the party ("save for henry", "bar
      // henry" after a whole-group word, "aside from", "besides").
      String.raw`(?:\b${GROUP_WORD}\s+but|\b${GROUP_WORD}(?:\s+[a-z']+){0,4}?,?\s+(?:bar|save)(?:\s+for)?|\b(?:except(?: for)?|save for|minus|without|excluding|sans|other than|apart from|aside from|besides))\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
      'g',
    ),
  )) {
    for (const w of [m[1], m[2]]) {
      if (w === 'me' || w === 'myself') add(sender);
      else if (exclusionName(w, sender) !== undefined) add(w);
    }
  }
  // "…, not henry", "tonight? not henry, he's feeling rough", "not henry
  // though": a whole clause or sentence that is only "not <name>" (T-158).
  for (const m of folded.matchAll(
    new RegExp(
      String.raw`(?:^|[,;.!?]\s*)not\s+${NAME}(?:\s+(?:or|and|&)\s+${NAME})?(?:\s+(?:though|tho|this time|tonight|either))?\s*(?=[,;.!?]|$|-\s)`,
      'g',
    ),
  )) {
    for (const w of [m[1], m[2]]) {
      if (w === 'me' || w === 'myself') add(sender);
      else if (exclusionName(w, sender) !== undefined) add(w);
    }
  }
  // "henry's feeling rough", "henry is under the weather", "henry's not
  // coming": a clause about one member being out (T-158). The reason is
  // only matched to recognize the clause and is never kept.
  // "henry is under the weather so we need 5 razz tickets": a reason clause
  // also ends at "so", "because", "since", "but", or an "and" before
  // "<name>'s" / "<name> is" ("chase and henry are sick" stays whole).
  for (const clause of folded.split(
    /[,.;!?]|\s+-\s+|\s+(?:so|and so|because|since|but)\s+|\s+and\s+(?=\S+(?:'s|\s+is|\s+has)\s)/,
  )) {
    const m = OUT_CLAUSE.exec(clause.trim());
    if (m === null) continue;
    for (const who of [m[1], m[2]]) {
      if (who === undefined) continue;
      // "i'm feeling rough", "me and henry are out": the sender is out.
      if (/^i(?:'?m| am|'?ve been)$/.test(who) || who === 'me') add(sender);
      else if (!skip.has(who) && exclusionName(who, sender) !== undefined) add(who);
    }
  }
  // T-148: "for us but not henry", "don't count henry", "leave henry out",
  // "henry doesn't want to come" (the reason is never kept, only the name).
  // T-148 r1 #2: day words and fillers are never names ("but not tonight",
  // "dont count on it"); "dont count me" / "leave me out" is the sender.
  const OUT_PATTERNS = [
    String.raw`\bbut\s+not\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
    ...NAME_NEGATIONS,
    String.raw`\b(?:leave|leaving|count)\s+${NAME}\s+out\b`,
    String.raw`\b(?:leave|leaving|count)\s+out\s+${NAME}(?:\s+(?:and|or|&)\s+${NAME})?`,
  ];
  for (const re of OUT_PATTERNS) {
    for (const m of folded.matchAll(new RegExp(re, 'g'))) {
      for (const w of [m[1], m[2]]) {
        const lower = w?.toLowerCase();
        if (lower === 'me' || lower === 'myself') add(sender);
        else if (exclusionName(w, sender) !== undefined) add(w);
      }
    }
  }
  // "…, crowley already has one": they don't need one bought (T-173, T-158 r2 #6).
  for (const m of folded.matchAll(
    new RegExp(
      String.raw`\b${NAME}(?:'s|\s+has|\s+have)?\s+(?:already\s+(?:has|have|got|bought|booked)|already got|got|has got)\s+(?:one|a ticket|a pass|a spot|theirs|his|hers|their own|his own|her own)\b`,
      'g',
    ),
  )) {
    const w = m[1]!.replace(/'s$/, '');
    if (exclusionName(w, sender) !== undefined && !NOT_IN_LIST.has(w)) add(w);
  }
  // "for chase and crowley henry sick": a member right before why they're
  // out, no verb (T-173, T-158 r2 #5). Only a known member: "tickets sold
  // out" has no name in it.
  if (roster !== undefined) {
    for (const m of folded.matchAll(
      /\b([a-z][a-z'-]*)\s+(?:sick|ill|unwell|hungover|out sick)(?=\s*(?:[,.;!?]|$))/g,
    )) {
      if (roster.has(m[1]!)) add(roster.get(m[1]!));
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
 * "for me and Chase", "for just me and Crowley", "for me, chase and crowley", "get me
 * and mom …" ⇒ the sender plus those names (T-081 r1 #2). A plain "for me" ⇒
 * just the sender. Something after "and" that isn't a name ("for me and the
 * kids") ⇒ `ambiguous`: no guess, so the ask isn't taken. A comma followed by
 * a new clause ("for me, henry's out") ends the list.
 */
function attendeeList(
  t: string,
  ctx: Reading,
  /** The ask from its own clause on: where a "for <names>" list is read (see `namedList`). */
  clause: string,
): { readonly names: readonly string[] } | 'ambiguous' | undefined {
  const { sender } = ctx;
  const head =
    /\b(?:for\s+(?:just\s+|only\s+)?me|(?:get|grab|book|buy|reserve|snag)\s+(?:just\s+)?me)(?![a-z'])/.exec(
      t,
    );
  const single = /\b(?:me one|one for me|get me (?:a |one\b|in\b)|for myself|just me)\b/.test(t);
  // "everyone except for me": the sender is out, never the party (T-173).
  if (head === null || CONNECTIVE_BEFORE_FOR.test(t.slice(0, head.index))) {
    if (single && sender !== undefined) return { names: [sender] };
    return namedList(clause, ctx);
  }
  let rest = t.slice(head.index + head[0].length);
  const names: string[] = [];
  for (;;) {
    const m = /^(\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)([a-z][a-z'’-]*)/.exec(rest);
    if (m === null) break;
    const comma = m[1]!.includes(',');
    const andSep = /and|&|\+/.test(m[1]!);
    const word = m[2]!;
    const after = rest.slice(m[0].length);
    // "for me, henry is sick": a comma into a new clause ends the list (T-158 r1 #1).
    // "for me, zed and chase": a non-member mid-list is kept so the service asks (T-173).
    if (!personWord(word, after, ctx) && !unknownMember(word, after, ctx, comma)) {
      // "… and chase henry for his share": a verb starts a new clause; the list ended.
      if (isVerbWord(word, '', after)) break;
      if (andSep && !comma && !LIST_STOP.has(word) && parseDayWord(word) === undefined) {
        return 'ambiguous';
      }
      break;
    }
    if (!names.includes(word)) names.push(word);
    rest = after;
  }
  if (sender === undefined) return names.length > 0 ? 'ambiguous' : undefined;
  return { names: withSender(sender, names, ctx) };
}

function withSender(sender: string, names: readonly string[], ctx: Reading): string[] {
  const self = foldText(sender);
  return [
    sender,
    ...names
      .filter((n) => n !== self && ctx.roster?.get(n) !== sender)
      .map((n) => displayName(n, ctx)),
  ];
}

/** What the parser reads an ask with: the venue's own words, who sent it, and (when known) the roster. */
interface Reading {
  /** Words that name the thing asked for, never a person (`venueWords`). */
  readonly skip: ReadonlySet<string>;
  readonly sender: string | undefined;
  /**
   * Folded first name or full display name ⇒ display name, for every
   * member (T-158 r1 #1). When set, only these words can be named attendees.
   */
  readonly roster: ReadonlyMap<string, string> | undefined;
}

function rosterMap(names: readonly string[] | undefined): ReadonlyMap<string, string> | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const out = new Map<string, string>();
  const firsts = new Map<string, number>();
  for (const n of names) {
    const f = foldText(n).trim().split(/\s+/)[0];
    if (f !== undefined && f.length > 0) firsts.set(f, (firsts.get(f) ?? 0) + 1);
  }
  for (const n of names) {
    const folded = foldText(n).trim();
    if (folded.length === 0) continue;
    if (/^[a-z][a-z'-]*$/.test(folded)) out.set(folded, n);
    const f = folded.split(/\s+/)[0]!;
    // Two members called Crowley: "crowley" names neither (the service would ask anyway).
    if (firsts.get(f) === 1 && !out.has(f)) out.set(f, n);
  }
  return out;
}

function displayName(word: string, ctx: Reading): string {
  return ctx.roster?.get(word) ?? word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Words that are never a person in a list: a reason someone is out, a verb,
 * a pronoun, a laugh (T-158 r1 #1: "for chase and crowley, henry is sick" must
 * never name "Is" or "Sick").
 */
const NOT_IN_LIST: ReadonlySet<string> = new Set([
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'has',
  'have',
  'had',
  'can',
  'will',
  'would',
  'should',
  'might',
  'sick',
  'ill',
  'unwell',
  'poorly',
  'rough',
  'hungover',
  'tired',
  'exhausted',
  'wrecked',
  'knackered',
  'wiped',
  'out',
  'home',
  'feeling',
  'coming',
  'going',
  'joining',
  'staying',
  'sitting',
  'bailing',
  'skipping',
  'passing',
  'resting',
  'sleeping',
  'he',
  'she',
  'they',
  'him',
  'her',
  'them',
  'it',
  'we',
  'you',
  'who',
  'lol',
  'lmao',
  'haha',
  'jk',
  'tho',
  // A conjunction starts the next clause ("for chase and crowley since henry is sick").
  'since',
  'because',
  'cause',
  'cuz',
  'cos',
  'coz',
  'as',
  'so',
  'while',
  'then',
  'if',
  'when',
  'or',
  'but',
  'with',
  'plus',
]);

/** A name followed by one of these starts its own clause ("henry is sick", "henry's out"). */
const CLAUSE_VERB =
  /^(?:is|are|was|were|has|have|had|isn'?t|aren'?t|can'?t|cannot|won'?t|doesn'?t|didn'?t|will|would|should|might|may|feels?|feeling|needs?|wants?|says|said|got|gets|seems|looks|went|stays|staying|left|bailed|bailing|skipping|passed|passing|prefers|already)$/;

/** A reason someone is out, right after a word: that word is the subject of "henry sick" (no verb). */
const REASON_NEXT =
  /^\s+(?:sick|ill|unwell|poorly|rough|hungover|wrecked|knackered|exhausted|tired|under the weather|out|home|bailing|bailed|skipping)(?![a-z'])/;

function nextWord(after: string): string | undefined {
  return /^\s*([a-z][a-z'’]*)/.exec(after)?.[1];
}

function startsClause(after: string): boolean {
  const w = nextWord(after);
  return w !== undefined && CLAUSE_VERB.test(w);
}

/**
 * Can `word` be a person named in a "for …" list? Never a venue or reason
 * word, never a clause's subject ("henry" in "henry is sick"), never "may"
 * before a number ("for may 15"), and, with the roster known, only a member.
 */
function personWord(word: string, after: string, ctx: Reading): boolean {
  if (!/^[a-z][a-z-]{1,29}$/.test(word)) return false;
  // "for may 15": a word right before a number is a date, never a name.
  if (startsClause(after) || /^\s*\d/.test(after)) return false;
  // "for chase and crowley henry sick": a name right before why they're out
  // is that clause's subject, never an attendee (T-173, T-158 r2 #5).
  if (REASON_NEXT.test(after)) return false;
  // "… and chase henry for his share": the verb, not member Chase (T-173).
  if (isVerbWord(word, '', after)) return false;
  if (ctx.roster !== undefined) return ctx.roster.has(word);
  return (
    !NOT_IN_LIST.has(word) &&
    !NOT_NAME.has(word) &&
    !LIST_STOP.has(word) &&
    !NOT_NAME_FILLER.has(word) &&
    !NOT_A_PERSON.has(word) &&
    !ctx.skip.has(word) &&
    NUMBER_WORDS[word] === undefined &&
    exclusionName(word, ctx.sender) !== undefined
  );
}

/**
 * With the roster known, a name-like word that isn't a member, in a list
 * (T-173, T-158 r2 #1): "for chase, zed and me", "for zed and chase", "for
 * chase, piotr, zed". It is kept so the proposal service asks who that is
 * (`resolveParty` ⇒ `unknown_name`), never dropped (the rest booked without
 * them) and never read as "no list" (the whole group booked). Only where the
 * list carries on into a member or "me" after it, or, when `endOk` (after a
 * comma or right after "for"), where the sentence ends.
 */
function unknownMember(word: string, after: string, ctx: Reading, endOk: boolean): boolean {
  if (ctx.roster === undefined || ctx.roster.has(word)) return false;
  if (/ly$/.test(word) || !personWord(word, after, { ...ctx, roster: undefined })) return false;
  const next = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)([a-z][a-z'-]*)/.exec(after);
  if (next !== null) {
    const w = next[1]!;
    return w === 'me' || w === 'myself' || ctx.roster.has(w);
  }
  return endOk && /^\s*(?:[.!?;]|$)/.test(after);
}

/** Words after "for" that are never a person ("for real", "for later", "for march"). */
const NOT_A_PERSON = new Set([
  'real',
  'sure',
  'once',
  'fun',
  'free',
  'cheap',
  'cheaper',
  'less',
  'later',
  'after',
  'before',
  'both',
  'each',
  'every',
  'like',
  'about',
  'around',
  'sale',
  'tomorrow',
  'sat',
  'next',
  'this',
  'last',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'and',
  'or',
  'minus',
  'except',
  'without',
  'excluding',
  'but',
  'please',
  'pls',
  'asap',
  'tho',
  'though',
  'guys',
  'yall',
  'people',
  'ppl',
  'everyone',
  'folks',
  'friends',
  'group',
  'crew',
  'squad',
  'gang',
  'adults',
  'kids',
]);

/**
 * Words that name the thing asked for, never a person in it: the words of the
 * venue terms the member used and of the named venue's own terms and tiers
 * ("razz", "razzmatazz", "vip", "mezzanine"), plus category and tier noise.
 * Only this ask's venue: another city's "grace bay dock" must not make a
 * member called Grace unreadable.
 */
function venueWords(match: VenueMatch): ReadonlySet<string> {
  const out = new Set<string>([...CATEGORY_WORDS, ...NAME_NOISE, ...TIER_NOISE]);
  const words = (s: string) => s.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  for (const term of match.terms) for (const w of words(term)) out.add(w);
  if (match.venue !== undefined) {
    for (const term of match.venue.terms) for (const w of words(term)) out.add(w);
    for (const w of match.venue.tierWords) out.add(w);
  }
  return out;
}

/**
 * The people a "for …" names when it doesn't start with "me" (T-158): "for
 * dean chase piotr crowley and me", "for chase and crowley", "for chase, crowley and me".
 * Names may be joined by commas, "and", "&", "+" or plain spaces; "me" is
 * the sender. Undefined when "for" isn't followed by a name ("for all of us",
 * "for 5", "for tonight", "for real"). A list whose "and" leads to a non-name
 * ("for chase and the kids") is `ambiguous`: no guess. Every name still has to
 * match the roster in the proposal service, which asks when one doesn't.
 * `t` is the ask from its own clause on; the first "for" that names a party
 * ("for us", "for all 6") settles it, so "get razz tickets for us, save one
 * for henry" is not a list. Only a night ("for tonight for …") is skipped.
 *
 * The list ends at the first word that isn't a person (T-158 r1 #1): a
 * reason word ("sick", "is"), a word that starts a new clause ("henry is
 * sick": a name followed by a verb is that clause's subject), or, with the
 * roster known, anything not on it. A comma that leads into anything but more
 * names ends the list at the comma: "for chase and crowley, henry is sick" is
 * Chase and Crowley, never Henry, "Is" or "Sick".
 */
function namedList(
  t: string,
  ctx: Reading,
): { readonly names: readonly string[] } | 'ambiguous' | undefined {
  const { sender, skip } = ctx;
  for (const at of t.matchAll(/\bfor\s+(?:just\s+|only\s+)?/g)) {
    // "except for henry", "save for henry": who's out, never the party (T-173).
    if (CONNECTIVE_BEFORE_FOR.test(t.slice(0, at.index))) continue;
    let rest = t.slice(at.index + at[0].length);
    let names: string[] = [];
    let me = false;
    let first = true;
    // The list as it stood before the last comma.
    let kept: { names: string[]; me: boolean } = { names: [], me: false };
    for (;;) {
      const m = first
        ? /^()([a-z][a-z'’-]*)/.exec(rest)
        : /^(\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*|\s+)([a-z][a-z'’-]*)/.exec(rest);
      if (m === null) break;
      const sep = m[1]!;
      const word = m[2]!;
      const after = rest.slice(m[0].length);
      const comma = sep.includes(',');
      const joined = /and|&|\+/.test(sep);
      if (comma) kept = { names: [...names], me };
      if ((word === 'me' || word === 'myself') && !startsClause(after)) {
        me = true;
      } else if (personWord(word, after, ctx)) {
        if (!names.includes(word)) names.push(word);
      } else if ((first || comma || joined) && unknownMember(word, after, ctx, first || comma)) {
        // "for chase, zed and me": kept, so the service asks who Zed is (T-173).
        if (!names.includes(word)) names.push(word);
      } else {
        if (comma) {
          // ", henry is sick", ", he's out": a new clause, the list ended at the comma.
          names = kept.names;
          me = kept.me;
          break;
        }
        if (
          !first &&
          joined &&
          !isVerbWord(word, '', after) &&
          !LIST_STOP.has(word) &&
          parseDayWord(word) === undefined
        ) {
          return 'ambiguous';
        }
        break;
      }
      first = false;
      rest = after;
    }
    if (names.length === 0) {
      const next = /^[a-z]+/.exec(t.slice(at.index + at[0].length))?.[0];
      if (
        next !== undefined &&
        (LIST_STOP.has(next) || skip.has(next) || parseDayWord(next) !== undefined)
      ) {
        continue;
      }
      return undefined;
    }
    if (!me) return { names: names.map((n) => displayName(n, ctx)) };
    if (sender === undefined) return 'ambiguous';
    return { names: withSender(sender, names, ctx) };
  }
  return undefined;
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
 * Where a soft ask starts in `clause`, or -1 (T-158). Not when someone else
 * is the subject ("you need razz tickets to get in", "they need razz
 * passes", "can someone sort razz tix") unless it's put to Trav ("can you
 * pick up razz passes"), and not inside a condition ("if we need razz
 * tickets lmk"). Every word around it must be accounted for (T-158 r1 #2):
 * between the verb and the ticket word only venue words and a count, after
 * it only a night, the party and who's out; "we want …" also needs the party,
 * a headcount or a "please" (r1 #3).
 */
function softAskIndex(clause: string, re: RegExp, ctx: Reading): number {
  const m = re.exec(clause);
  if (m === null) return -1;
  const { verb = '', gap = '', tail = '' } = m.groups ?? {};
  const gapWords = gap.split(/\s+/).filter((w) => w.length > 0);
  if (gapWords.some((w) => !ctx.skip.has(w) && !SOFT_GAP_OK.has(w) && !isCountWord(w))) return -1;
  if (!softTailOk(tail, ctx)) return -1;
  if (
    WANT_RE.test(verb) &&
    re !== SOFT_PARTY &&
    headcount(clause) === undefined &&
    !/\b(?:for (?:us|me)|all of us|us all|everyone|everybody|pls|please|plz)\b/.test(clause) &&
    namedList(clause, ctx) === undefined
  ) {
    return -1;
  }
  const before = clause.slice(0, m.index);
  if (/\b(?:if|whether|unless|in case|when|whenever|once)\b/.test(before)) return -1;
  const polite = /\b(?:can|could|would|will|pls|please)\s+(?:you|u|ya)\s+(?:[a-z']+\s+)?$/.test(
    before,
  );
  if (
    !polite &&
    /\b(?:you|u|ya|they|he|she|it|people|one|someone|somebody|anyone|anybody)\s+(?:[a-z']+\s+)?$/.test(
      before,
    )
  ) {
    return -1;
  }
  return m.index;
}

function isCountWord(w: string): boolean {
  return /^\d{1,2}$/.test(w) || NUMBER_WORDS[w] !== undefined;
}

/** What follows a soft ask's ticket word (or party) is only a night, the party, who's out, "please". */
function softTailOk(tail: string, ctx: Reading): boolean {
  const words = tail.split(/\s+/).filter((w) => w.length > 0);
  let prev = '';
  let prevPerson = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const lead =
      prevPerson ||
      (SOFT_NAME_LEAD.has(prev) && prev !== 'from') ||
      (prev === 'from' && words[i - 2] === 'apart') ||
      prev === 'but';
    let person = false;
    if (w === 'from') {
      if (prev !== 'apart') return false;
    } else if (w === 'but') {
      // "everyone but henry", "for us but not henry"; never "but henry wants apolo".
      if (words[i + 1] !== 'not' && !['everyone', 'everybody', 'us', 'all'].includes(prev)) {
        return false;
      }
    } else if (
      SOFT_TAIL_OK.has(w) ||
      ctx.skip.has(w) ||
      isCountWord(w) ||
      parseDayWord(w) !== undefined
    ) {
      // a night, the party, a venue word
    } else if (lead && personWord(w, ' ' + words.slice(i + 1).join(' '), ctx)) {
      person = true;
    } else {
      return false;
    }
    prevPerson = person;
    prev = w;
  }
  return true;
}

/** The sender doing it themselves ("i'll sort razz tickets", "let me grab razz tix"): not an ask for Trav. */
const SELF_DOING = new RegExp(
  String.raw`\b(?:i'?ll|ill|i will|imma|i'?m gonna|im gonna|i'?m going to|im going to|let me|lemme)\s+(?:just\s+|probably\s+|go\s+|try (?:and|to)\s+)?(?:${BOOK_VERBS}|${SOFT_VERB})\b`,
);

/** Where the ask's verb starts in `clause`: a booking verb, or a soft verb with its ticket word (T-158). */
function verbIndex(clause: string, ctx: Reading): number {
  const at = [
    firstIndex(BOOK_VERB, clause),
    softAskIndex(clause, SOFT_ASK, ctx),
    softAskIndex(clause, SOFT_PARTY, ctx),
  ].filter((i) => i >= 0);
  return at.length === 0 ? -1 : Math.min(...at);
}

/**
 * The booking's own clause and sentence (T-148 #3): the first clause with a
 * booking verb and the venue or a ticket word, else the first with a verb,
 * else the first naming the venue. Questions are judged on its sentence.
 */
function anchorOf(
  t: string,
  terms: readonly string[],
  ctx: Reading,
): { readonly sentence: string; readonly clause: string } | undefined {
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
      rows.push({ sentence: sentence.trim(), clause, verb: verbIndex(clause, ctx), thing });
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
  return { sentence: row.sentence, clause: row.clause };
}

/** Did the member end `sentence` with a "?" ("we need razz tickets?")? */
function endsInQuestionMark(t: string, sentence: string): boolean {
  const at = t.indexOf(sentence);
  return at >= 0 && /^\s*\?/.test(t.slice(at + sentence.length));
}

/** A request phrased as a question ("can you pick up razz passes?"): still an ask. */
const POLITE_ASK =
  /^(?:(?:ok|okay|so|hey|yo|pls|please)[\s,]+)*(?:can|could|would|will) (?:you|u|ya)\b/;

/** "lol jk", "just kidding": anything said in jest is never an ask (T-158 r1 #2). */
const JOKE_CUE = /\b(?:jk|j\/k|just kidding|just joking|kidding|joking|jokes aside|lol no)\b/;
/**
 * A hedge ("maybe later", "probably", "idk", "thinking about"): not a
 * decision yet, so never an ask Trav could buy on (T-158; precision first:
 * T-168 auto-buys explicit asks under the cap).
 */
const HEDGE_CUE =
  /\b(?:maybe|perhaps|idk|dunno|not sure|eventually|at some point|some ?day|thinking (?:about|of)|probably|possibly|might)\b/;
/**
 * `t` without hedges about one member coming ("chase might join", "crowley
 * maybe comes later"): that's who's in, not whether to book (T-081 r1 #9).
 */
function withoutMemberHedges(t: string): string {
  return t.replace(
    /\b[a-z][a-z'-]+\s+(?:might|maybe|probably|possibly)\s+(?:join|come|comes|be there|go|show|make it|turn up|tag along)\b/g,
    ' ',
  );
}
/** Someone holds the tickets already ("crowley has them", "henry's got the passes"), T-158 r1 #2. */
const HELD_CUE =
  /\b(?:has|have|got|holds|holding|already (?:has|have|got|bought))\s+(?:them|em|'em|those|ours|yours|(?:the|our|your|their|his|her)\s+(?:razz\s+)?(?:tickets?|tix|passes|entry|wristbands))\b|\b(?:'s|has|have)\s+got\s+(?:them|em|the\s+\w+)\b/;
/**
 * A ticket word followed by what happens to tickets someone has already:
 * printed, sent, forwarded, scanned, from someone, back (T-158 r1 #2).
 */
const NOT_BUYING =
  /\b(?:tickets?|tix|passes|entry|entries|spots|wristbands)\s+(?:printed|print|sent|send|emailed|email|forwarded|forward|transferred|transfer|scanned|scan|refunded|refund|back|sorted|done|in hand|out of|downloaded|screenshotted|on (?:my|your|his|her|their) phones?)\b/;

/**
 * "need razz passes from crowley", "grab the tix off henry": tickets handed over
 * by someone, never bought (T-158 r1 #2). Only a person-like word counts, so
 * "from the box office" isn't caught here (the determiner rule keeps it out).
 */
function fromSomeone(clause: string, ctx: Reading): boolean {
  // Only after the ticket word: "crowley's friend from madrid 👋 book 7 barça
  // tickets" is about who is asking, not where tickets come from.
  const at = firstIndex(TICKET_WORD, clause);
  if (at < 0) return false;
  // "apart from henry", "aside from henry" exclude him (T-173), they hand nothing over.
  for (const m of clause
    .slice(at)
    .matchAll(/\b(?<!(?:apart|aside)\s)(?:from|off)\s+([a-z][a-z'-]*)/g)) {
    const w = m[1]!;
    if (w === 'me' || w === 'him' || w === 'her' || w === 'them') return true;
    if (!ctx.skip.has(w) && personWord(w, '', ctx)) return true;
  }
  return false;
}

/** A clause about something other than tickets ("get us a taxi to razz"), T-158. */
function aboutSomethingElse(clause: string, venue: VenueEntry | undefined): boolean {
  if (TICKET_WORD.test(clause)) return false;
  for (const m of clause.matchAll(NOT_A_TICKET)) {
    const w = m[0];
    const own =
      venue !== undefined &&
      (venue.tierWords.includes(w) || venue.terms.some((term) => termRe(w).test(term)));
    if (!own) return true;
  }
  return false;
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

// ---------- not a decision to buy (T-173) ----------
//
// T-168 buys an explicit ask under the cap, so everything below errs toward
// "no ask": missing one costs a retype, buying on one of these costs money.

/**
 * A condition on the buy (T-173): "once henry confirms", "unless henry
 * objects", "if it's not sold out", "after we eat", "later". "if possible" and
 * "if you can" are manners, not conditions (`POLITE_IF`).
 */
const CONDITION_CUE =
  /\b(?:if|unless|once|when|whenever|after|in case|as long as|provided|assuming|later|until|till)\b/;
const POLITE_IF = /\bif (?:possible|poss|you can|u can|you could|u could)\b/g;
/**
 * Not a real ask (T-173): "imagine if trav could…", "we could get…", "worth
 * getting…?", "the plan was to get…". "we could use razz tickets" is the
 * soft verb "could use", not "we could".
 */
const HYPOTHETICAL_CUE =
  /\b(?:imagine|imagining|hypothetically|in theory|theoretically|(?:we|you|u) could(?! use)|could(?:'ve| have)|would(?:'ve| have)|should(?:'ve| have)|wish|wishing|the plan (?:was|is)|plan was|idea was|(?:was|were) (?:going to|gonna)|supposed to|meant to|worth (?:it|getting|buying|booking|grabbing)|considering|tempted|pretend|what if)\b/;
/**
 * Someone else is buying, or the buy is up for grabs (T-173, T-158 r2 #3):
 * "crowley's buying", "crowley is on it", "who wants to buy", "someone
 * should book them", "i'm on it".
 */
const HANDOFF_CUE = new RegExp(
  [
    String.raw`\b(?:[a-z][a-z'-]*'s|[a-z][a-z'-]*\s+(?:is|will|can|could|should|has))\s+(?:buying|booking|paying|getting (?:them|those|these|it|the)|grabbing (?:them|those|it|the)|sorting (?:it|them|that|this)|handling (?:it|them|that|this)|on it|on that|on this|got (?:it|this|that)|buy (?:them|those|it)|book (?:them|those|it))\b`,
    String.raw`\b(?:i'?m|im|i'?ll|ill|i will|i'?ve got|ive got|i got)\s+(?:buying|booking|paying|on it|got it|got this|it|this|buy (?:them|those|it)|book (?:them|those|it)|get (?:them|those|it)|grab (?:them|those|it))(?![a-z'])`,
    String.raw`\bwho(?:'?s| is| wants to| will| can| should| gets to)\s+(?:buy|book|get|grab|sort|pay|order|buying|booking|getting|grabbing|sorting|paying|handling|on it|in charge)\b`,
    String.raw`\b(?:someone|somebody|anyone|anybody)\s+(?:else\s+)?(?:should|needs? to|has to|can|could|wanna|want to|pls|please|go)\s+(?:buy|book|get|grab|sort|pay|order|pick)\b`,
  ].join('|'),
);
/**
 * The member takes it back or isn't sure (T-173, T-158 r2 #3): a trailing
 * "… not" / "sarcasm" / "whatever" / "nah", "/s", "scratch that", or a choice
 * left open ("… or tomorrow", "for 5 or 6", "or something").
 */
const RETRACT_CUE = new RegExp(
  [
    String.raw`(?:^|[,.;!?…\s])(?:not|sarcasm|yeah right|as if|said no ?one(?: ever)?|nah|nope|scratch that|whatever|whatevs|meh|idc|or not)\s*[.!?…]*\s*$`,
    String.raw`\b(?:sarcasm|sarcastic|scratch that|on second thought|said no ?one|yeah right)\b|(?:^|\s)\/s(?![a-z])`,
    String.raw`\bor\s+(?:maybe\s+|on\s+)?(?:tonight|tonite|today|tomorrow|tmrw|tmr|another (?:night|day|time)|next (?:week|time)|not|something|whatever|so|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b`,
    String.raw`\b${NUM}\s+or\s+${NUM}\b`,
  ].join('|'),
);
/** A buy that already happened, or a state of the tickets (T-173): "crowley got razz tickets for all 6", "i booked razz", "sold out". */
const PAST_CUE =
  /\b(?:got|booked|bought|grabbed|reserved|snagged|scored|ordered|secured|purchased|picked up|locked in|already|have(?! to)|has(?! to)|had|sold out)\b/;
/** A clause with no buy verb whose own verb says it's a description ("razz tickets for all 6 are sold out"). */
const DESCRIPTIVE_VERB =
  /\b(?:is|are|was|were|been|be|sold|cost|costs|look|looks|looked|seem|seems|went|go|goes|going|gone|love|loved|like|liked|hate|hated|said|says|think|thought|know|knew|lands?)\b/;
/** Telling another member to buy (T-173): "i told crowley to get…", "ask henry to book…". */
const TOLD_TO = new RegExp(
  String.raw`\b(?:told|tell|telling|asked|ask|asking|get|getting|got|have|having|had|let|letting|make|made|want|wanted|need|needed|remind|reminded)\s+([a-z][a-z'-]+)\s+to\s+(?:${BOOK_VERBS}|${SOFT_VERB}|pay|sort|deal|handle|pick)\b`,
  'g',
);
/** A sentence that opens by addressing someone and goes straight to a buy verb: "crowley, get…", "chase can you book…". */
const VOCATIVE = new RegExp(
  String.raw`^(?:(?:hey|hi|yo|oi|ok|okay|so|and|also)[\s,]+)*@?([a-z][a-z'-]+)(\s*[,:]\s*|\s+)((?:can|could|would|will) (?:you|u) |pls |please |just )?(?:${BOOK_VERBS}|${SOFT_VERB})\b`,
);
/** Words that open a sentence with a comma without addressing anyone ("ok, get…", "guys, get…"). */
const VOCATIVE_FILLER: ReadonlySet<string> = new Set([
  'trav',
  'ok',
  'okay',
  'so',
  'right',
  'alright',
  'guys',
  'folks',
  'everyone',
  'everybody',
  'all',
  'yes',
  'yeah',
  'yep',
  'yup',
  'cool',
  'great',
  'perfect',
  'fine',
  'sure',
  'please',
  'pls',
  'also',
  'and',
  'btw',
  'actually',
  'honestly',
  'anyway',
  'anyways',
  'um',
  'hmm',
  'oh',
  'wait',
  'then',
  'k',
  'kk',
  'done',
  'deal',
  'team',
  'lads',
  'fam',
  'babe',
  'mate',
  'bro',
  'dude',
  'yo',
  'hey',
  'hi',
]);

/** Is a member (not Trav) told to do the buying, by name? */
function toldSomeoneElse(t: string, ctx: Reading): boolean {
  for (const m of t.matchAll(TOLD_TO)) {
    if (!['trav', 'you', 'u', 'ya'].includes(m[1]!)) return true;
  }
  for (const raw of t.split(SENTENCE_SPLIT)) {
    const m = VOCATIVE.exec(raw.trim());
    if (m === null) continue;
    const who = m[1]!;
    // Without the roster a name needs a comma or a "can you" after it ("crowley can you book…").
    const marked = /[,:]/.test(m[2]!) || /^(?:can|could|would|will)/.test(m[3] ?? '');
    if (VOCATIVE_FILLER.has(who)) continue;
    if (ctx.roster !== undefined ? ctx.roster.has(who) : marked && personWord(who, '', ctx)) {
      return true;
    }
  }
  return false;
}

/** The checks above, on the folded text (times removed) and the ask's own clause. */
function uncommitted(t: string, clause: string, ctx: Reading): boolean {
  if (CONDITION_CUE.test(t.replace(POLITE_IF, ' '))) return true;
  if (HYPOTHETICAL_CUE.test(t) || HANDOFF_CUE.test(t) || RETRACT_CUE.test(t)) return true;
  if (/\bsold out\b/.test(t) || toldSomeoneElse(t, ctx)) return true;
  if (PAST_CUE.test(clause)) return true;
  return verbIndex(clause, ctx) < 0 && DESCRIPTIVE_VERB.test(clause);
}

/**
 * `t` without a guess at why someone is out, right after saying so (T-173,
 * T-158 r2 #4): "henry's sick, probably the paella". Only a short noun phrase
 * after a hedge, never a deferral ("henry's sick, maybe later" stays a hedge).
 */
function withoutReasonGuesses(t: string): string {
  const parts = t.split(/(,)/);
  for (let i = 2; i < parts.length; i += 2) {
    const prev = parts[i - 2]!.trim();
    const cur = parts[i]!.trim();
    if (OUT_CLAUSE.exec(prev) === null && !/'s\s+(?:sick|ill|unwell|hungover|out)$/.test(prev)) {
      continue;
    }
    const m =
      /^(?:probably|prob|maybe|possibly|must be|might be|likely|i think|i guess)\s+((?:[a-z']+\s+){0,2}[a-z']+)$/.exec(
        cur.replace(/[.!?]+$/, ''),
      );
    if (m === null) continue;
    const words = m[1]!.split(/\s+/);
    if (
      words.some(
        (w) =>
          parseDayWord(w) !== undefined ||
          /^(?:later|not|no|next|another|wait|instead|tickets?|tix|passes|book|get|buy|go|come|join|soon)$/.test(
            w,
          ),
      )
    ) {
      continue;
    }
    parts[i] = ' ';
  }
  return parts.join('');
}

// The SAFETY A9 safeguards on who an ask is for (T-173): an exclusion worded
// in a way this reader doesn't know must never come back as the party, so
// "the whole group except X" can't propose (or, with T-168, buy) X alone.

/** Everyone named is also said to be out ("for henry, henry is sick"): no party. */
function onlyTheOut(attendees: readonly string[], excludedNames: readonly string[]): boolean {
  const out = new Set(excludedNames.map((n) => foldText(n)));
  return attendees.length > 0 && attendees.every((a) => out.has(foldText(a)));
}

/**
 * A connective-like word before "for <name>" ("save for henry", "leaving
 * aside for henry") is skipped as a party (`namedList`). If the exclusion
 * reader didn't turn that name into an exclusion either, the reading is
 * unsure, so no ask (T-173, SAFETY A9): never a party that silently keeps
 * someone the member may have left out.
 */
function connectiveUnread(
  t: string,
  excludedNames: readonly string[],
  sender: string | undefined,
  skip: ReadonlySet<string>,
): boolean {
  const out = new Set(excludedNames.map((n) => foldText(n)));
  const re = new RegExp(String.raw`${CONNECTIVE_BEFORE_FOR.source.slice(0, -1)}for\s+${NAME}`, 'g');
  for (const m of t.matchAll(re)) {
    const w = m[1]!;
    // "we leave for razz", "save it for tonight": not a person.
    if (skip.has(w) || exclusionName(w, sender) === undefined) continue;
    const who = w === 'me' || w === 'myself' ? sender : w;
    if (who === undefined || !out.has(foldText(who))) return true;
  }
  return false;
}

/**
 * The message speaks of the whole group ("everyone", "all of us", "the whole
 * crew", "all 6") but the named list is a strict minority of it (no roster:
 * two names or fewer): the two readings disagree, so no ask, never a
 * confident guess. `named` is false for the sender-alone "i need razz tickets".
 */
function minorityOfGroup(
  t: string,
  named: boolean,
  attendees: readonly string[],
  ctx: Reading,
): boolean {
  if (!named || !GROUP_WORD_RE.test(t)) return false;
  const size = ctx.roster === undefined ? undefined : new Set(ctx.roster.values()).size;
  return size === undefined ? attendees.length <= 2 : attendees.length * 2 < size;
}

/** First-person soft asks (T-173, T-158 r2 #2): "i need…", "i could use…", "hook me up with…". */
const FIRST_PERSON_SOFT =
  /\b(?:i\s+(?:really\s+|just\s+|also\s+|still\s+|kinda\s+)?(?:need|could use|want|wanna|would like)|i'?d like|(?:pick|sort|line|set|hook) me\b)/;

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
  const anchor = anchorOf(t, v.terms, {
    skip: venueWords(v),
    sender: undefined,
    roster: undefined,
  });
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
  options: {
    /**
     * Every member's display name (T-158 r1 #1). When given, a "for …" list
     * only ever names members: any other word ends it.
     */
    readonly roster?: readonly string[] | undefined;
  } = {},
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
  // Two venues ("we want razz tickets but henry wants apolo", "razz or
  // apolo"): which one is the member's call, never a mixed query (T-158 r1 #3).
  if (v.specificCount > 1) return undefined;
  // "lol jk", "crowley has them already", "maybe later": not an ask, whatever the verb (r1 #2).
  // A guess at why someone is out ("henry's sick, probably the paella") is no hedge (T-173).
  if (
    JOKE_CUE.test(t) ||
    HELD_CUE.test(t) ||
    HEDGE_CUE.test(withoutReasonGuesses(withoutMemberHedges(t)))
  ) {
    return undefined;
  }
  const ctx: Reading = { skip: venueWords(v), sender, roster: rosterMap(options.roster) };

  // ---- questions and negations (r1 #3, T-148 #3) ----
  // Only the booking's own sentence can make it a question. Any negation
  // anywhere takes it back ("…, but don't buy them yet", "…, not yet
  // though", T-148 r1 #1) unless it governs a name: "don't count henry" is
  // an exclusion, not a no. Missing an ask is safe; booking a "not yet" isn't.
  const anchor = anchorOf(t, terms, ctx);
  if (anchor === undefined || isQuestion(anchor.sentence)) return undefined;
  if (NEGATION_CUE.test(withoutNameNegations(t, sender))) return undefined;
  // Not (yet) a decision to buy, or not Trav's to make (T-173): a condition,
  // a hypothetical, a handoff or retraction, an instruction to another
  // member, or a buy that already happened.
  if (uncommitted(t, anchor.clause, ctx)) return undefined;

  // ---- a booking signal ----
  // A booking verb, a headcount, "for all of us" or "for me (and X)": a
  // ticket word alone ("who has the razz tickets") is never an ask (r1 #3).
  // "get us a taxi to razz", "grab drinks at razz": the verb's object is not a ticket.
  if (aboutSomethingElse(anchor.clause, venue)) return undefined;
  if (SELF_DOING.test(anchor.clause)) return undefined;
  // "get razz passes printed", "grab the razz tix from crowley": tickets that
  // exist already, being handled or handed over (T-158 r1 #2).
  if (NOT_BUYING.test(anchor.clause) || fromSomeone(anchor.clause, ctx)) return undefined;
  const quantity = headcount(t);
  // A "for <names>" list is read from the ask's own clause to the end of its
  // sentence, so a list with commas ("for chase, crowley and me") stays whole.
  const askOn = anchor.sentence.slice(Math.max(0, anchor.sentence.indexOf(anchor.clause)));
  const list = attendeeList(t, ctx, askOn);
  if (list === 'ambiguous') return undefined;
  const everyone =
    /\b(?:all of us|everyone|everybody|us all|the group|whole group|all of you)\b/.test(t) ||
    // "the whole crew", "the gang", "the squad" (T-173: the same group words as `GROUP_WORD_RE`).
    /\b(?:(?:the )?whole (?:crew|gang|squad|lot)|the (?:crew|gang|squad|lot of us))\b/.test(t) ||
    /\b(?:get|grab|book|buy|reserve|snag)\s+us\b/.test(t);
  // A soft verb ("we need razz entry") alone, ending in "?" ("we need razz
  // tickets?"), is a question unless it is a request ("can you pick up …?").
  const namesVenue = terms.some((term) => termRe(term).test(anchor.clause));
  const soft =
    (softAskIndex(anchor.clause, SOFT_ASK, ctx) >= 0 ||
      (namesVenue && softAskIndex(anchor.clause, SOFT_PARTY, ctx) >= 0)) &&
    (!endsInQuestionMark(t, anchor.sentence) || POLITE_ASK.test(anchor.sentence));
  // A clause whose verb is a soft one that didn't read as an ask is chat even
  // with a count or a party in it ("we need 5 razz passes printed", r1 #2):
  // a headcount never turns a wish into a purchase.
  const softVerbed = new RegExp(String.raw`\b${ANY_SOFT}\b`).test(anchor.clause);
  if (softVerbed && !soft && !BOOK_VERB.test(anchor.clause)) return undefined;
  if (!BOOK_VERB.test(t) && !soft && quantity === undefined && !everyone && list === undefined) {
    return undefined;
  }

  // "i need razz tickets", "hook me up with razz tickets": the sender alone,
  // unless they named the party (T-173, T-158 r2 #2). No sender, no ask.
  const groupParty =
    everyone ||
    /\b(?:for us|us all|for (?:the )?(?:group|crew|rest|lot of us))\b/.test(t) ||
    /\b(?:pick|sort|line|set|hook) us\b/.test(t);
  let attendees = list?.names;
  if (
    attendees === undefined &&
    quantity === undefined &&
    !groupParty &&
    FIRST_PERSON_SOFT.test(anchor.clause)
  ) {
    if (sender === undefined) return undefined;
    attendees = [sender];
  }
  const excludedNames = exclusions(original, folded, sender, ctx.skip, ctx.roster);
  if (connectiveUnread(t, excludedNames, sender, ctx.skip)) return undefined;
  if (
    attendees !== undefined &&
    (onlyTheOut(attendees, excludedNames) || minorityOfGroup(t, list !== undefined, attendees, ctx))
  ) {
    return undefined;
  }
  const day = parseDayWord(t);
  const tier = tierWords(t, venue);
  const time = askedTime(folded);
  return {
    kind: 'ticket',
    query: `${terms.join(' ')} tickets`,
    ...(quantity !== undefined ? { quantity } : {}),
    excludedNames,
    // Named attendees go to the service, which resolves every name before any
    // roster write and asks when one doesn't match (never a guess).
    ...(attendees !== undefined ? { attendeeNames: attendees } : {}),
    ...(day !== undefined ? { day } : {}),
    ...(tier.length > 0 ? { tier } : {}),
    ...(time !== undefined ? { time } : {}),
    requestText: original,
  };
}
