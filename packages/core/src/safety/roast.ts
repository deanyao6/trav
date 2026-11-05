/**
 * Roast guardrails (docs/SAFETY.md §2.8, VOICE §7, CLAUDE.md §2).
 *
 * Gate 1 (`roastAllowed`, `groupRoastBlock`): deterministic group/target rules.
 * Gate 2 (`roastTopicBlocked`): a deterministic term blocklist over the draft
 * line. It runs regardless of the classifier call in the agent package. The
 * canonical list lives here as `DEFAULT_ROAST_BLOCKLIST` (core is pure and
 * cannot read `fixtures/`); callers may pass extra terms.
 */
import type { IsoDateTime } from '../primitives.js';
import type { Group, Member } from '../domain/group.js';
import type { Trip } from '../domain/trip.js';
import type { ConsentLookup } from '../domain/consent.js';
import { groupAgeUnconfirmed, groupHasMinor, isFamilyMode, isMinor } from './minors.js';
import { termRegex, termsRegex, normalizeText } from './text.js';

export type RoastBlockCause =
  | 'mode_off'
  | 'minor_in_group'
  | 'family_mode'
  | 'age_unconfirmed'
  | 'member_opted_out'
  | 'target_not_member'
  | 'target_inactive'
  | 'trip_over';

export type RoastGate =
  { readonly allowed: true } | { readonly allowed: false; readonly cause: RoastBlockCause };

/** Roasts are allowed this many days after the trip's endDate (Wrapped lands the day after). */
export const ROAST_GRACE_DAYS = 7;

function dayNumber(isoDate: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return undefined;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
}

/**
 * "tripIsActiveOrJustEnded" (SAFETY §2.8). No trip ⇒ nothing to roast.
 * `planning` is deliberately NOT allowed: SAFETY says active or just ended, and
 * every roast surface (Morning After, Wrapped, the post-expense aside) is about
 * spend that happens on the trip. `ended` gets ROAST_GRACE_DAYS so Wrapped,
 * which lands the day after the last departure, can still carry its lines.
 */
export function tripAllowsRoast(trip: Trip | null, now: IsoDateTime): boolean {
  if (trip === null) return false;
  if (trip.status !== 'active' && trip.status !== 'ended') return false;
  const today = dayNumber(now);
  const end = dayNumber(trip.endDate);
  if (today === undefined || end === undefined) return false;
  return today <= end + ROAST_GRACE_DAYS;
}

/** Group-level part of gate 1: everything that does not depend on the target. */
export function groupRoastBlock(
  group: Group,
  members: readonly Member[],
  trip: Trip | null,
  now: IsoDateTime,
): RoastBlockCause | null {
  if (group.settings.roastMode !== true) return 'mode_off';
  if (groupHasMinor(members, now)) return 'minor_in_group';
  if (isFamilyMode(group, members, now)) return 'family_mode';
  if (groupAgeUnconfirmed(group, members)) return 'age_unconfirmed';
  if (!tripAllowsRoast(trip, now)) return 'trip_over';
  return null;
}

/**
 * Gate 1 (SAFETY §2.8): roast mode on, no minor (and not family mode), every
 * member's age known or confirmed 18+, trip active or just ended, and the target
 * is a current, non-guest, adult member who opted in (`consent.roast === true`;
 * consent defaults false, SAFETY §2.6). The target is re-read from `members` by
 * id so a stale object cannot bypass a leave/opt-out.
 */
export function roastAllowed(
  group: Group,
  members: readonly Member[],
  target: Member,
  consent: ConsentLookup,
  trip: Trip | null,
  now: IsoDateTime,
): RoastGate {
  const groupBlock = groupRoastBlock(group, members, trip, now);
  if (groupBlock !== null) return { allowed: false, cause: groupBlock };
  const current = members.find((m) => m.memberId === target.memberId);
  if (current === undefined || current.groupId !== group.groupId || current.role === 'guest') {
    return { allowed: false, cause: 'target_not_member' };
  }
  if (isMinor(current, now) || isMinor(target, now))
    return { allowed: false, cause: 'minor_in_group' };
  if (!current.active || current.leftAt !== undefined) {
    return { allowed: false, cause: 'target_inactive' };
  }
  const flags = consent(current.memberId);
  if (flags?.roast !== true) return { allowed: false, cause: 'member_opted_out' };
  return { allowed: true };
}

// ---------- gate 2: topic blocklist ----------

export type RoastTopicCategory =
  | 'body'
  | 'romance'
  | 'outsider'
  | 'protected_trait'
  | 'health'
  | 'intoxication'
  | 'hardship'
  | 'legal'
  | 'minor'
  | 'left_member'
  | 'private_data';

export interface RoastBlocklistEntry {
  readonly term: string;
  readonly category: RoastTopicCategory;
}

/**
 * "host"/"driver" only when the line is about the person, not the purchase:
 * VOICE §7.3 allows "the €180 Sintra driver, worth it per both of you" (and
 * §4.8 B "the Sintra driver, €180"), while "the driver couldn't find the
 * airbnb" and "the host was so annoying" are about someone outside the chat.
 */
function personTargeting(noun: string): string[] {
  const after = [
    'was',
    'is',
    'were',
    'are',
    "wasn't",
    "isn't",
    "couldn't",
    'could not',
    "didn't",
    'did not',
    "wouldn't",
    'would not',
    "won't",
    'never',
    'got',
    'had',
    'kept',
    'took',
    'said',
    'asked',
    'charged',
    'forgot',
    'lost',
    'made',
    'showed',
    'looked',
    'seemed',
    'smelled',
    'who',
    'that',
  ];
  const before = ['our', 'your', 'his', 'her', 'their', 'annoying', 'rude', 'creepy', 'weird'];
  return [
    `${noun}'s`,
    ...after.map((w) => `${noun} ${w}`),
    ...after.map((w) => `${noun}s ${w}`),
    ...before.map((w) => `${w} ${noun}`),
    ...before.map((w) => `${w} ${noun}s`),
  ];
}

/**
 * Idioms that contain a blocklisted word but are not about the topic. Blanked
 * before matching so "asleep at the wheel of this trip" (VOICE §7.3 group
 * indecision) is not a sleep/body roast. No "looks shared" carve-out: the
 * recap's pending-items line that needed one is gone (T-099), and a bare
 * "looks shared" would also blank "Crowley's looks shared the spotlight".
 */
export const ROAST_IDIOMS: readonly string[] = ['asleep at the wheel', 'face value'];

const BLOCKLIST_TERMS: Readonly<Record<RoastTopicCategory, readonly string[]>> = {
  body: [
    'body',
    'fat',
    'skinny',
    'weight',
    'chubby',
    'ugly',
    'looks',
    'face',
    'hair',
    'bald',
    'belly',
    'gut',
    'abs',
    'gym',
    'outfit',
    'clothes',
    'shirt',
    'shoes',
    'dressed',
    'sweaty',
    'smelly',
    'hangover',
    'hungover',
    'asleep',
    'sleep',
    'slept',
    'nap',
    'tired',
  ],
  romance: [
    'dating',
    'date night',
    'a date',
    'his date',
    'her date',
    'their date',
    'first date',
    'tinder',
    'hinge',
    'bumble',
    'hookup',
    'hook up',
    'hooked up',
    'went home with',
    'go home with',
    'going home with',
    'making out',
    'made out',
    'flirt',
    'flirting',
    'crush',
    'girlfriend',
    'boyfriend',
    'ex',
    'kiss',
    'kissed',
    'romance',
    'romantic',
    'sex',
    // "single" only as a relationship status: "a single €14 water" and
    // "every single uber" are spending material (VOICE §7.3).
    'is single',
    'was single',
    'still single',
    'single and',
    'single again',
    'newly single',
    'being single',
    'single now',
    "he's single",
    "she's single",
    'talking to',
  ],
  outsider: [
    ...personTargeting('host'),
    ...personTargeting('driver'),
    'waiter',
    'waitress',
    'bartender',
    'bouncer',
    'staff',
    'cashier',
    'stranger',
    'that guy',
    'that girl',
    'some guy',
    'some girl',
    'the locals',
    'your mom',
    'your dad',
    'his mom',
    'her mom',
    'his dad',
    'her dad',
    'his wife',
    'her husband',
  ],
  protected_trait: [
    'racial',
    'racist',
    'ethnicity',
    'ethnic',
    'nationality',
    'accent',
    'immigrant',
    'foreigner',
    'gringo',
    'religion',
    'religious',
    'muslim',
    'jewish',
    'christian',
    'hindu',
    'catholic',
    'gay',
    'lesbian',
    'bisexual',
    'trans',
    'queer',
    'gender',
    'disabled',
    'disability',
    'wheelchair',
    'autistic',
    'old man',
    'boomer',
    'grandpa',
    'too old',
    'where he is from',
    "where he's from",
    "where she's from",
    "where they're from",
  ],
  health: [
    'sick',
    'ill',
    'illness',
    'flu',
    'fever',
    'covid',
    'hospital',
    'doctor',
    'injury',
    'injured',
    'puked',
    'puke',
    'vomit',
    'vomited',
    'threw up',
    'throwing up',
    'food poisoning',
    'allergic',
    'allergy',
    'meds',
    'medication',
    'therapy',
    'therapist',
    'depressed',
    'depression',
    'anxiety',
    'anxious',
    'adhd',
    'mental health',
    'panic attack',
    'diet',
  ],
  intoxication: [
    'drunk',
    'wasted',
    'tipsy',
    'hammered',
    'blackout',
    'blacked out',
    'smashed',
    'plastered',
    'stoned',
    'got high',
    'was high',
    'sober',
    'sobered',
  ],
  hardship: [
    'broke',
    'poor',
    "can't afford",
    'cannot afford',
    'cant afford',
    'cheap',
    'cheapskate',
    'stingy',
    'in debt',
    'debt',
    'overdraft',
    'overdrawn',
    'maxed out',
    'unemployed',
    'jobless',
    'saving money',
    'paycheck',
  ],
  legal: [
    'arrested',
    'police',
    'cops',
    'jail',
    'prison',
    'lawyer',
    'court',
    'fined',
    'warrant',
    'illegal',
    'deported',
    'mugshot',
  ],
  minor: [
    'kid',
    'child',
    'children',
    'teen',
    'teenager',
    'underage',
    'year-old',
    'year old',
    'minor',
  ],
  left_member: ['left the chat', 'left the group', 'former member'],
  private_data: [
    'card statement',
    'bank statement',
    'bank account',
    'your card',
    'his card',
    'her card',
    'their card',
    'transaction',
    'inbox',
    'email',
    'venmo history',
  ],
};

export const DEFAULT_ROAST_BLOCKLIST: readonly RoastBlocklistEntry[] = (
  Object.keys(BLOCKLIST_TERMS) as RoastTopicCategory[]
).flatMap((category) => BLOCKLIST_TERMS[category].map((term) => ({ term, category })));

const compiledCache = new WeakMap<
  readonly RoastBlocklistEntry[],
  readonly { readonly re: RegExp; readonly category: RoastTopicCategory }[]
>();

function compile(
  blocklist: readonly RoastBlocklistEntry[],
): readonly { readonly re: RegExp; readonly category: RoastTopicCategory }[] {
  const hit = compiledCache.get(blocklist);
  if (hit !== undefined) return hit;
  // One regex per run of consecutive same-category entries (T-181). The first
  // run that matches holds the first matching entry, because every entry in an
  // earlier run did not match, so the category returned is the same as testing
  // each entry's `termRegex` in list order.
  const runs: { terms: string[]; category: RoastTopicCategory }[] = [];
  for (const e of blocklist) {
    if (e.term.trim().length === 0) continue;
    const last = runs.at(-1);
    if (last !== undefined && last.category === e.category) last.terms.push(e.term);
    else runs.push({ terms: [e.term], category: e.category });
  }
  const compiled = runs.flatMap((r) => {
    const re = termsRegex(r.terms);
    return re === null ? [] : [{ re, category: r.category }];
  });
  compiledCache.set(blocklist, compiled);
  return compiled;
}

const COMPILED_IDIOMS = ROAST_IDIOMS.map((p) => new RegExp(termRegex(p).source, 'giu'));

/** Deterministic blocklist over a draft roast line. Returns the first matching category, or null. */
export function roastTopicBlocked(
  line: string,
  blocklist: readonly RoastBlocklistEntry[] = DEFAULT_ROAST_BLOCKLIST,
): RoastTopicCategory | null {
  let text = normalizeText(line);
  for (const re of COMPILED_IDIOMS) text = text.replace(re, ' ');
  for (const c of compile(blocklist)) {
    if (c.re.test(text)) return c.category;
  }
  return null;
}
