/**
 * Age predicates and the restricted-content rule (docs/SAFETY.md §2.7, VOICE §8,
 * D-012). These are the ONLY place a member's age is interpreted.
 *
 * - `isMinor`: birthDate says under 18, OR ageBand === 'under18'. Either signal
 *   is enough (fail safe). Unknown age is NOT a minor for content rules, but it
 *   is not a confirmed adult either, so roast mode stays blocked
 *   (`groupAgeUnconfirmed`) until a lead confirms "everyone 18+".
 * - Only ACTIVE members count for group-level checks (SAFETY §2.7 "any active member").
 */
import type { IsoDateTime, MemberId } from '../primitives.js';
import type { Group, Member } from '../domain/group.js';
import type { ContentTag } from '../domain/trip.js';
import { TravError } from '../errors.js';
import { normalizeText, termRegex, termsRegex } from './text.js';

export const ADULT_AGE = 18;

export const RESTRICTED_TAGS: readonly ContentTag[] = [
  'nightlife',
  'club',
  'bar',
  'alcohol',
  '18+',
  '21+',
  'gambling',
  'cannabis',
  'adult',
];

const RESTRICTED_SET: ReadonlySet<ContentTag> = new Set(RESTRICTED_TAGS);

interface YMD {
  readonly y: number;
  readonly m: number;
  readonly d: number;
}

function parseYmd(s: string): YMD | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) return undefined;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  // Reject impossible days (e.g. 2026-02-30) without touching the wall clock.
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return undefined;
  }
  return { y, m, d };
}

function parseNow(now: IsoDateTime): YMD {
  const ymd = parseYmd(now);
  if (ymd === undefined) {
    throw new TravError('invalid_argument', `safety: invalid now "${String(now)}"`);
  }
  return ymd;
}

/**
 * Whole years between birthDate and the calendar date of `now` (the date part
 * of the ISO string, i.e. the local date it was written in). Someone turns 18
 * ON their 18th birthday; a Feb 29 birthday turns over on Mar 1 in common years.
 * Returns undefined for a missing, malformed or future birthDate.
 */
export function ageOn(member: Member, now: IsoDateTime): number | undefined {
  const today = parseNow(now);
  if (member.birthDate === undefined) return undefined;
  const born = parseYmd(member.birthDate);
  if (born === undefined) return undefined;
  const beforeBirthday = today.m < born.m || (today.m === born.m && today.d < born.d);
  const age = today.y - born.y - (beforeBirthday ? 1 : 0);
  return age < 0 ? undefined : age;
}

/** birthDate set and age < 18, or ageBand === 'under18'. Unknown age ⇒ false (but roast stays blocked). */
export function isMinor(member: Member, now: IsoDateTime): boolean {
  const age = ageOn(member, now);
  if (age !== undefined && age < ADULT_AGE) return true;
  return member.ageBand === 'under18';
}

/** Known to be 18+: a valid birthDate says so, or ageBand 'adult' with no contradicting signal. */
export function isConfirmedAdult(member: Member, now: IsoDateTime): boolean {
  if (isMinor(member, now)) return false;
  const age = ageOn(member, now);
  if (age !== undefined) return age >= ADULT_AGE;
  return member.ageBand === 'adult';
}

/** Age is not known from either signal (no valid birthDate and ageBand 'unknown'). */
export function isAgeUnknown(member: Member): boolean {
  if (member.ageBand !== 'unknown') return false;
  if (member.birthDate === undefined) return true;
  return parseYmd(member.birthDate) === undefined;
}

function activeMembers(members: readonly Member[]): readonly Member[] {
  return members.filter((m) => m.active && m.leftAt === undefined);
}

export function groupHasMinor(members: readonly Member[], now: IsoDateTime): boolean {
  return activeMembers(members).some((m) => isMinor(m, now));
}

/** True if any member's age is unknown and the group has not confirmed everyone is 18+. */
export function groupAgeUnconfirmed(group: Group, members: readonly Member[]): boolean {
  if (group.settings.allAdultsConfirmed) return false;
  return activeMembers(members).some((m) => isAgeUnknown(m));
}

/**
 * Does this audience include a minor? Fails closed: an id that is not a known
 * member of the group counts as a possible minor, because we cannot verify it.
 */
export function audienceIncludesMinor(
  audience: readonly MemberId[],
  members: readonly Member[],
  now: IsoDateTime,
): boolean {
  return audience.some((id) => {
    const m = members.find((x) => x.memberId === id);
    return m === undefined || isMinor(m, now);
  });
}

export function isRestrictedContent(tags: readonly ContentTag[]): boolean {
  return tags.some((t) => RESTRICTED_SET.has(t));
}

/** Family mode: derived from members, or forced in settings (VOICE §8). */
export function isFamilyMode(group: Group, members: readonly Member[], now: IsoDateTime): boolean {
  return group.settings.familyModeForced || groupHasMinor(members, now);
}

// ---------- text → content tags ----------

/**
 * Deterministic keyword tagger for draft text and card fields. It is a backstop
 * for drafts whose `contentTags` were not supplied; it errs toward tagging
 * (a false positive only suppresses a suggestion in a family group, which is
 * the safe direction). Words are matched whole ("bar" ≠ "barça").
 */
export const CONTENT_TERMS: readonly {
  readonly tag: ContentTag;
  readonly terms: readonly string[];
}[] = [
  {
    tag: 'adult',
    terms: ['strip club', 'stripper', 'adult entertainment', 'red light district', 'sex show'],
  },
  {
    tag: 'nightlife',
    terms: [
      'nightlife',
      'nightclub',
      'club',
      'clubbing',
      'rave',
      'disco',
      'night out',
      'nights out',
      'pub crawl',
      'bar crawl',
      'bar hopping',
      'bar hop',
      'afterparty',
      'after party',
      'after-party',
      'bottle service',
      'vip table',
      'dj set',
      'dance floor',
      'boat party',
      'party boat',
    ],
  },
  {
    tag: 'bar',
    terms: [
      'bar',
      'pub',
      'speakeasy',
      'tavern',
      'brewery',
      'taproom',
      'beer garden',
      'happy hour',
      'winery',
      'distillery',
    ],
  },
  {
    tag: 'alcohol',
    terms: [
      'alcohol',
      'alcoholic',
      'booze',
      'beer',
      'wine',
      'cocktail',
      'sangria',
      'vermouth',
      'vermut',
      'vermuteria',
      'cava',
      'champagne',
      'prosecco',
      'tequila',
      'vodka',
      'rum',
      'rum punch',
      'whiskey',
      'whisky',
      'gin',
      'mezcal',
      'margarita',
      'mojito',
      'shots',
      'jello shots',
      'wine tasting',
      'open bar',
      'drinking',
      'drinks tonight',
      'rooftop drinks',
      'grab drinks',
      'get drinks',
      'for drinks',
      'drinks at',
      'drinks by',
      'bottomless brunch',
      'second bottle',
    ],
  },
  { tag: '21+', terms: ['21+', 'over 21', '21 and over', '21 and up'] },
  {
    tag: '18+',
    terms: [
      '18+',
      'over 18',
      '18 and over',
      '18 and up',
      'adults only',
      'adults-only',
      'adult only',
    ],
  },
  {
    tag: 'gambling',
    terms: ['casino', 'gambling', 'poker', 'blackjack', 'roulette', 'slot machine', 'betting'],
  },
  { tag: 'cannabis', terms: ['cannabis', 'weed', 'marijuana', 'dispensary', 'edibles'] },
];

// One matcher per tag (T-181): same hits as testing each term's `termRegex`,
// without compiling a Unicode-boundary regex per term on first use.
const COMPILED_CONTENT_TERMS = CONTENT_TERMS.map((g) => ({
  tag: g.tag,
  re: termsRegex(g.terms),
}));

/**
 * Family-safe phrases that contain a restricted word. They are blanked before
 * tagging so "kids' club" or "non-alcoholic" do not suppress a family suggestion.
 */
export const BENIGN_PHRASES: readonly string[] = [
  "kids' club",
  'kids club',
  "kid's club",
  'golf club',
  'book club',
  'fan club',
  'club sandwich',
  'snack bar',
  'juice bar',
  'salad bar',
  'candy bar',
  'granola bar',
  'chocolate bar',
  'root beer',
  'ginger beer',
  'non-alcoholic',
  'non alcoholic',
  'alcohol-free',
  'alcohol free',
  'no alcohol',
];

const COMPILED_BENIGN = BENIGN_PHRASES.map((p) => new RegExp(termRegex(p).source, 'giu'));

/** Restricted tags implied by the words in `text` (deduped, in CONTENT_TERMS order). */
export function detectContentTags(text: string): ContentTag[] {
  let cleaned = normalizeText(text);
  for (const re of COMPILED_BENIGN) cleaned = cleaned.replace(re, ' ');
  const tags: ContentTag[] = [];
  for (const g of COMPILED_CONTENT_TERMS) {
    if (g.re !== null && g.re.test(normalizeText(cleaned))) tags.push(g.tag);
  }
  return tags;
}

/** Text-level convenience: restricted if the words alone imply a restricted tag. */
export function isRestrictedText(text: string): boolean {
  return isRestrictedContent(detectContentTags(text));
}

export interface RestrictedContentInput {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly now: IsoDateTime;
  readonly tags: readonly ContentTag[];
  /** Who the suggestion is for. Empty/omitted ⇒ the whole (active) group. */
  readonly audience?: readonly MemberId[];
  /** An adult explicitly asked for adult-only content for a named adult audience. */
  readonly explicitAdultRequest?: boolean;
}

/**
 * SAFETY §2.7 rule 1, verbatim:
 * `allowed = !isRestrictedContent(tags) || !familyMode || (explicitAdultRequest && !audienceIncludesMinor(audience))`.
 * Family mode (derived or forced) is used rather than `groupHasMinor` alone, so
 * a lead forcing family mode gets the same content filter (VOICE §8). A missing
 * audience means the whole group, which includes the minor.
 */
export function restrictedContentAllowed(input: RestrictedContentInput): boolean {
  if (!isRestrictedContent(input.tags)) return true;
  if (!isFamilyMode(input.group, input.members, input.now)) return true;
  if (input.explicitAdultRequest !== true) return false;
  const audience =
    input.audience !== undefined && input.audience.length > 0
      ? input.audience
      : activeMembers(input.members).map((m) => m.memberId);
  return !audienceIncludesMinor(audience, input.members, input.now);
}
