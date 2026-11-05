/**
 * Combined roster sentences (T-082): a headcount, one or more named changes
 * and an optional activity or venue name in one message.
 *
 *   "@trav it's the 5 of us tonight, henry's out"   (msg_bcn_0100)
 *   "all 6, henry's back. razzmatazz"               (msg_bcn_0164)
 *
 * Parsing is pure and conservative: every clause must be a headcount, an
 * attendance change, a night word or a short place name; anything else (a
 * request, "book razz", "Razzmatazz tickets", a question) makes the whole
 * message "not this form", so a booking ask like "@trav get the 5 of us
 * Razzmatazz tickets, Henry's sick" never comes here. The reason someone is
 * out ("sick") is matched only to recognize the clause and never leaves this
 * module: the result carries names as written and statuses, nothing else.
 *
 * A place that is not on the plan must also be a known venue name
 * (`isKnownPlace`), checked by the roster turn, before it is searched or
 * named back.
 *
 * `planParty` decides what the headcount means against the activity's
 * roster: the named changes alone, or the changes plus everyone who has not
 * answered yet; when neither gives the stated count, one question and no
 * write.
 */
import type { AttendanceStatus, IsoDate, Member, MemberId, Roster } from '@trav/core';
import { safety } from '@trav/core';
import { foldText, type VenueIndex } from '../booking/request.js';
import { sanitizeInline } from '../context/groupContext.js';
import { stripInvisible } from '../untrusted.js';
import { parseRosterUpdate, rosterMembers, type RosterWhen } from './index.js';

export interface CombinedChange {
  /** 'me' for first person; else the display name as written (resolved by the caller). */
  readonly who: 'me' | string;
  readonly status: AttendanceStatus;
}

export interface CombinedRoster {
  /** The stated headcount; undefined for "all of us" / "everyone" with no number. */
  readonly count?: number;
  /** "all 6", "all of us", "everyone": the headcount is meant as the whole group minus the named outs. */
  readonly all: boolean;
  readonly changes: readonly CombinedChange[];
  /** An activity or venue name ("razzmatazz"), 1 to 3 plain words. */
  readonly hint?: string;
  readonly when?: RosterWhen;
}

const COUNT_WORDS: Readonly<Record<string, number>> = {
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
const COUNT = String.raw`\d{1,2}|${Object.keys(COUNT_WORDS).join('|')}`;
const WHEN_WORDS = String.raw`tonight|tn|tonite|today|tomorrow|tmrw|this evening`;
const WHEN_TAIL = String.raw`(?:\s+(?:for\s+)?(?<when>${WHEN_WORDS}))?`;
const PLACE_TAIL = String.raw`(?:\s+(?:for|at|to)\s+(?<hint>[\p{L}][\p{L}\s-]{1,38}?))?`;
const LEAD = String.raw`^(?:(?:so|ok|okay|yeah|yep|and)\s+)?(?:(?:it'?s|its|we'?re|we are|it'?ll be|it will be|gonna be|that'?s|thats)\s+)?(?:just\s+)?`;

/** "it's the 5 of us tonight", "all 6", "we're five", "6 of us for razzmatazz". Never "make it 6" (T-066 owns that). */
const HEADCOUNT = new RegExp(
  String.raw`${LEAD}(?<all>all\s+)?(?:the\s+)?(?<n>${COUNT})(?:\s+of\s+us)?${PLACE_TAIL}${WHEN_TAIL}$`,
  'iu',
);
/** "all of us", "everyone's in", "everybody": the whole group, no number. */
const EVERYONE = new RegExp(
  String.raw`${LEAD}(?:all of us|everyone|everybody)(?:'s|s| is| are)?(?:\s+(?:in|coming|going))?${PLACE_TAIL}${WHEN_TAIL}$`,
  'iu',
);
const WHEN_ONLY = new RegExp(String.raw`^(?:for\s+)?(?<when>${WHEN_WORDS})$`, 'i');

// A name ends with a letter, so "Henry's" splits into the name and the "'s".
const NAME = String.raw`[\p{L}](?:[\p{L}'-]{0,29}[\p{L}])?`;
const RETURN_TAIL = String.raw`(?:\s+in)?(?:\s+(?:too|again|after all))?${WHEN_TAIL}$`;
/** "henry's back", "henry is back in": a return. Only inside a combined message ("back" alone is ambiguous). */
const OTHER_BACK = new RegExp(String.raw`^(?<name>${NAME})(?:'s| is)\s+back${RETURN_TAIL}`, 'iu');
const ME_BACK = new RegExp(String.raw`^(?:i'?m|im|i am)\s+back${RETURN_TAIL}`, 'iu');
/** "henry and maya are out", "sam & jordan are back". */
const PAIR = new RegExp(
  String.raw`^(?<a>${NAME})\s+(?:and|&)\s+(?<b>${NAME})\s+(?:are|'re)\s+(?<what>out|in|back|not coming|staying in|coming)${WHEN_TAIL}$`,
  'iu',
);
const SELF_WORDS = new Set(['i', "i'm", 'im', 'me', 'myself', 'we', 'us', 'he', 'she', 'they']);

/**
 * Words a place name never contains. Requests and ticket words mean the
 * message is an ask for the model or the booking path; reasons someone is
 * out are never searched for or echoed (SAFETY §2.8).
 */
const NOT_A_PLACE = new Set([
  // requests, questions, ticket words
  'book',
  'booking',
  'get',
  'grab',
  'buy',
  'log',
  'add',
  'pay',
  'paid',
  'split',
  'settle',
  'cancel',
  'drop',
  'ticket',
  'tickets',
  'can',
  'could',
  'would',
  'will',
  'you',
  'u',
  'pls',
  'plz',
  'please',
  'what',
  'who',
  'whos',
  'how',
  'when',
  'where',
  'why',
  'which',
  'is',
  'are',
  'was',
  'do',
  'does',
  'did',
  'want',
  'need',
  'tab',
  'it',
  'him',
  'her',
  'them',
  'he',
  'she',
  'they',
  'we',
  'us',
  'me',
  'i',
  'my',
  'our',
  'not',
  'no',
  'nah',
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'lol',
  'lmao',
  'haha',
  'thanks',
  'thx',
  'ty',
  'too',
  'again',
  'now',
  'then',
  'so',
  'and',
  'or',
  'but',
  'of',
  'all',
  'everyone',
  // night words are `when`, never a place
  'tonight',
  'tn',
  'tonite',
  'today',
  'tomorrow',
  'tmrw',
  'evening',
  // reasons (never searched for, never echoed)
  'sick',
  'ill',
  'unwell',
  'hungover',
  'fever',
  'covid',
  'flu',
  'tired',
  'beat',
  'injured',
  'hurt',
  'pregnant',
  'migraine',
]);

function whenOf(w: string | undefined): RosterWhen | undefined {
  const t = w?.trim().toLowerCase();
  if (t === undefined || t.length === 0) return undefined;
  return t === 'tomorrow' || t === 'tmrw' ? 'tomorrow' : 'tonight';
}

/** A place name of 1 to 3 plain words, or undefined. */
function placeName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const words = raw
    .trim()
    .replace(/^the\s+/i, '')
    .split(/\s+/);
  if (words.length === 0 || words.length > 3) return undefined;
  for (const w of words) {
    if (!/^[\p{L}][\p{L}-]*$/u.test(w)) return undefined;
    if (NOT_A_PLACE.has(w.toLowerCase())) return undefined;
  }
  const name = words.join(' ');
  return name.length >= 3 && name.length <= 40 ? name : undefined;
}

const PLACE_CLAUSE = new RegExp(
  String.raw`^(?:(?:for|at|to)\s+)?(?<hint>[\p{L}][\p{L}\s-]{1,40}?)${WHEN_TAIL}$`,
  'iu',
);

const AT_TRAV_ANYWHERE = /(^|[^\w@])@trav(?![\w-])\s*[,:]?/gi;
const VOCATIVE = /^\s*(?:(?:hey|hi|yo|ok|okay|yeah)\s+)?trav\s*[,:]\s*/i;

function clausesOf(text: string): string[] | undefined {
  const t = stripInvisible(text)
    .replace(AT_TRAV_ANYWHERE, '$1')
    .replace(/\s+/g, ' ')
    .replace(VOCATIVE, '')
    .replace(/[\s!.?]+$/u, '')
    .trim();
  if (t.length === 0 || t.length > 140 || /\?/.test(t)) return undefined;
  const parts = t
    .split(/\s*(?:[,;.!]+|\s-\s)\s*/u)
    .map((c) => c.replace(/^(?:(?:so|and|but|plus)\s+)+/i, '').trim())
    .filter((c) => c.length > 0);
  return parts.length >= 2 && parts.length <= 5 ? parts : undefined;
}

type Clause =
  | {
      readonly kind: 'count';
      readonly count?: number;
      readonly all: boolean;
      readonly hint?: string;
      readonly when?: RosterWhen;
    }
  | {
      readonly kind: 'change';
      readonly changes: readonly CombinedChange[];
      readonly hint?: string;
      readonly when?: RosterWhen;
    }
  | { readonly kind: 'when'; readonly when: RosterWhen }
  | { readonly kind: 'place'; readonly hint: string; readonly when?: RosterWhen };

function countOf(raw: string): number | undefined {
  const r = raw.toLowerCase();
  const n = /^\d+$/.test(r) ? Number(r) : COUNT_WORDS[r];
  return n !== undefined && n >= 1 && n <= 30 ? n : undefined;
}

/** Hint/when captured inside a clause; a captured hint that is not a plain place name voids the clause. */
function extras(
  g: Record<string, string | undefined> | undefined,
): { hint?: string; when?: RosterWhen } | undefined {
  const raw = g?.['hint'];
  const hint = raw === undefined ? undefined : placeName(raw);
  if (raw !== undefined && hint === undefined) return undefined;
  const when = whenOf(g?.['when']);
  return { ...(hint !== undefined ? { hint } : {}), ...(when !== undefined ? { when } : {}) };
}

function classify(c: string): Clause | undefined {
  const w = WHEN_ONLY.exec(c);
  if (w !== null) return { kind: 'when', when: whenOf(w.groups?.['when'])! };

  const h = HEADCOUNT.exec(c);
  if (h !== null) {
    const count = countOf(h.groups!['n']!);
    const x = extras(h.groups);
    if (count === undefined || x === undefined) return undefined;
    return { kind: 'count', count, all: h.groups?.['all'] !== undefined, ...x };
  }
  const e = EVERYONE.exec(c);
  if (e !== null) {
    const x = extras(e.groups);
    return x === undefined ? undefined : { kind: 'count', all: true, ...x };
  }

  const one = parseRosterUpdate(c);
  if (one !== undefined) {
    // parseRosterUpdate's own hint is any short phrase; here it must be a place name.
    const hint = one.hint === undefined ? undefined : placeName(one.hint);
    if (one.hint !== undefined && hint === undefined) return undefined;
    return {
      kind: 'change',
      changes: [{ who: one.who, status: one.status }],
      ...(hint !== undefined ? { hint } : {}),
      ...(one.when !== undefined ? { when: one.when } : {}),
    };
  }
  const back = OTHER_BACK.exec(c) ?? ME_BACK.exec(c);
  if (back !== null) {
    const name = back.groups?.['name'];
    if (name !== undefined && SELF_WORDS.has(name.toLowerCase())) return undefined;
    const when = whenOf(back.groups?.['when']);
    return {
      kind: 'change',
      changes: [{ who: name ?? 'me', status: 'in' }],
      ...(when !== undefined ? { when } : {}),
    };
  }
  const pair = PAIR.exec(c);
  if (pair !== null) {
    const a = pair.groups!['a']!;
    const b = pair.groups!['b']!;
    if (SELF_WORDS.has(a.toLowerCase()) || SELF_WORDS.has(b.toLowerCase())) return undefined;
    const what = pair.groups!['what']!.toLowerCase();
    const status: AttendanceStatus =
      what === 'in' || what === 'back' || what === 'coming' ? 'in' : 'out';
    const when = whenOf(pair.groups?.['when']);
    return {
      kind: 'change',
      changes: [
        { who: a, status },
        { who: b, status },
      ],
      ...(when !== undefined ? { when } : {}),
    };
  }

  const p = PLACE_CLAUSE.exec(c);
  if (p !== null) {
    const hint = placeName(p.groups?.['hint']);
    if (hint === undefined) return undefined;
    const when = whenOf(p.groups?.['when']);
    return { kind: 'place', hint, ...(when !== undefined ? { when } : {}) };
  }
  return undefined;
}

/**
 * One headcount clause, at least one change, at most one place and one night.
 * Anything else in the message ⇒ undefined (not a combined roster sentence).
 */
export function parseCombinedRoster(text: string): CombinedRoster | undefined {
  const parts = clausesOf(text);
  if (parts === undefined) return undefined;
  let head: Extract<Clause, { kind: 'count' }> | undefined;
  const changes: CombinedChange[] = [];
  const hints: string[] = [];
  const whens: RosterWhen[] = [];
  for (const part of parts) {
    const c = classify(part);
    if (c === undefined) return undefined;
    if (c.kind === 'count') {
      if (head !== undefined) return undefined;
      head = c;
    } else if (c.kind === 'change') changes.push(...c.changes);
    if ('hint' in c && c.hint !== undefined) hints.push(c.hint);
    if ('when' in c && c.when !== undefined) whens.push(c.when);
  }
  if (head === undefined || changes.length === 0) return undefined;
  const hint = [...new Set(hints.map((h) => h.toLowerCase()))];
  const when = [...new Set(whens)];
  if (hint.length > 1 || when.length > 1) return undefined;
  return {
    ...(head.count !== undefined ? { count: head.count } : {}),
    all: head.all,
    changes,
    ...(hints.length > 0 ? { hint: hints[0]! } : {}),
    ...(when.length > 0 ? { when: when[0]! } : {}),
  };
}

// ---------- what the headcount means ----------

export type PartyPlan =
  | {
      readonly kind: 'write';
      /** Rows to set, in member order (named changes plus any fill). */
      readonly rows: readonly { readonly memberId: MemberId; readonly status: AttendanceStatus }[];
    }
  | {
      readonly kind: 'mismatch';
      readonly text: string;
      /** Minors this text already says stay off the adult-only plan (absent ⇒ it names none). */
      readonly keptOff?: readonly MemberId[];
    };

/**
 * "Sam stays off this plan, it's not all-ages" (VOICE §4.12 C, §8): names the
 * minors so the adults know whose plan changes, never an age or a reason.
 * Positive "all-ages" phrasing (VOICE §8 wording rules): "adults only" is an
 * 18+ term the outbound screen suppresses in a group with a minor, so a line
 * carrying it would never reach the chat (T-153).
 */
export function keptOffLine(ids: readonly MemberId[], members: readonly Member[]): string {
  const list = names(ids, members).replace(/, ([^,]*)$/, ' and $1');
  return `${list} ${ids.length === 1 ? 'stays' : 'stay'} off this plan, it's not all-ages`;
}

export interface PlanInput {
  readonly members: readonly Member[];
  readonly roster: Roster;
  readonly changes: readonly { readonly memberId: MemberId; readonly status: AttendanceStatus }[];
  readonly count?: number;
  readonly all: boolean;
  /** Members never filled in by the headcount (minors for an 18+/alcohol activity); naming them still works. */
  readonly noFill?: ReadonlySet<MemberId>;
  /**
   * Members of `noFill` the message named in (or a maybe) and the turn
   * refused (T-153): kept off like an unanswered minor, whatever their row
   * says, so a short count gets the "stays off" line and never "who else is in?".
   */
  readonly refused?: ReadonlySet<MemberId>;
}

function names(ids: readonly MemberId[], members: readonly Member[]): string {
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  return ids.map((id) => sanitizeInline(byId.get(id)?.displayName ?? id, 40)).join(', ');
}

/**
 * The stated count against the roster. First the named changes alone (the
 * people already in stay in); if that is not the count, the changes plus
 * every member who has not answered for this activity (a recorded "out" or
 * "maybe" is never overridden by a headcount). Neither ⇒ one question, no
 * write. "all" without a number means everyone on the roster minus the named
 * outs.
 */
export function planParty(input: PlanInput): PartyPlan {
  const { members, roster, changes } = input;
  const order = rosterMembers(members).map((m) => m.memberId);
  const named = new Map(changes.map((c) => [c.memberId, c.status] as const));
  const outs = [...named].filter(([, s]) => s !== 'in').length;
  const want = input.count ?? (input.all ? order.length - outs : undefined);
  if (want === undefined) return { kind: 'mismatch', text: 'how many of you are in?' };

  const applied = new Set(roster.inMemberIds);
  for (const [id, s] of named) {
    if (s === 'in') applied.add(id);
    else applied.delete(id);
  }
  const rows = (fill: readonly MemberId[]): PartyPlan => ({
    kind: 'write',
    rows: order
      .filter((id) => named.has(id) || fill.includes(id))
      .map((id) => ({ memberId: id, status: named.get(id) ?? 'in' })),
  });
  if (applied.size === want) return rows([]);

  const answered = new Set([
    ...roster.inMemberIds,
    ...roster.outMemberIds,
    ...roster.maybeMemberIds,
  ]);
  const fill = order.filter(
    (id) => !answered.has(id) && !named.has(id) && input.noFill?.has(id) !== true,
  );
  const filled = order.filter((id) => applied.has(id) || fill.includes(id));
  if (filled.length === want) return rows(fill);

  const n = String(want);
  if (filled.length === 0) {
    return { kind: 'mismatch', text: `you said ${n}, but i've got nobody in yet. who's in?` };
  }
  const list = names(filled, members);
  const k = String(filled.length);
  // Short only because minors are kept off an adult-only plan: say so, and
  // never ask "who else is in?", whose only answer would be the minor.
  const keptOff = order.filter(
    (id) =>
      input.noFill?.has(id) === true &&
      !applied.has(id) &&
      ((!answered.has(id) && !named.has(id)) || input.refused?.has(id) === true),
  );
  if (filled.length < want && keptOff.length > 0 && filled.length + keptOff.length >= want) {
    return {
      kind: 'mismatch',
      text: `that's ${k} for this one: ${list}. ${keptOffLine(keptOff, members)}`,
      keptOff,
    };
  }
  return filled.length > want
    ? { kind: 'mismatch', text: `you said ${n}, but that's ${k}: ${list}. who else is out?` }
    : { kind: 'mismatch', text: `you said ${n}, but i've only got ${k}: ${list}. who else is in?` };
}

// ---------- the place that is not on the plan ----------

/**
 * Whether a place a combined sentence named is one venue the ticket
 * inventory knows by that exact name or alias ("razzmatazz", "razz",
 * "apolo"). A place that is not on the plan is searched for and named back
 * only when this holds: free text after "henry's out" can be a reason ("has
 * a cold", "food poisoning") and a denylist can't catch them all, so the
 * member's own words are never sent to a search or repeated unless they are
 * a known venue name (SAFETY §2.8).
 */
export function isKnownPlace(index: VenueIndex, hint: string): boolean {
  const h = foldText(hint).replace(/\s+/g, ' ').trim();
  if (h.length < 3 || index.generic.has(h)) return false;
  return index.venues.filter((v) => v.terms.includes(h)).length === 1;
}

/** The place as people write it: each word capitalized (VOICE §1 rule 1, places keep capitals). */
export function placeLabel(hint: string): string {
  return sanitizeInline(hint, 40)
    .split(' ')
    .map((w) => (w.length === 0 ? w : `${w[0]!.toUpperCase()}${w.slice(1)}`))
    .join(' ');
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "monday" for 2026-03-16. */
export function weekdayOf(night: IsoDate): string {
  return WEEKDAYS[new Date(`${night}T12:00:00Z`).getUTCDay()]!;
}

/** The parts of a `search_events` result this line reads (tool output: structured, sanitized). */
export interface VenueSearchResult {
  readonly events: readonly {
    readonly startsAt: string;
    readonly adultsOnly: boolean;
    readonly bookable: boolean;
    readonly from: { readonly text: string } | null;
  }[];
  readonly note?: string;
  readonly familyMode?: boolean;
}

/**
 * One line on the named place for the roster's night (VOICE §4.10: say
 * whether anything was booked; never invent an event). `nightOfEvent` maps
 * an event start to its trip-local night.
 */
export function renderVenueCheck(
  hint: string,
  night: IsoDate,
  result: VenueSearchResult | undefined,
  nightOfEvent: (startsAt: string) => IsoDate,
): string {
  // The place is the member's own words: if naming it would break the voice
  // rules (a banned word, say), the line does not name it.
  const label = placeLabel(hint);
  const place =
    safety.lintVoice(`nothing at ${label}`, { kind: 'reply', properNouns: [label] }).violations
      .length === 0
      ? label
      : 'that place';
  const day = `${weekdayOf(night)} night`;
  if (result === undefined || result.note !== undefined) {
    return `couldn't check that just now, nothing's booked. @ me again in a bit`;
  }
  const hit = result.events.find(
    (e) => e.bookable && e.from !== null && nightOfEvent(e.startsAt) === night,
  );
  // A family group never sees an adults-only place named (VOICE §8): the
  // line names neither the place nor anyone's age.
  if (result.familyMode === true && (hit === undefined || hit.adultsOnly)) {
    return `nothing all-ages there ${day}, so nothing's booked`;
  }
  if (hit === undefined) return `nothing at ${place} ${day}, so nothing's booked`;
  // Lowercase start (VOICE §1 rule 1): the place name never opens the line.
  return `${day} at ${place}: from ${hit.from!.text} each. nothing's booked yet`;
}
