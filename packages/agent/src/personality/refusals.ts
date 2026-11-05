/**
 * Deterministic guardrail refusals that do not need the model (T-017):
 *
 * - VOICE §4.12 D: "what did Sam's card get charged" ⇒ that's Sam's. The
 *   group lane never answers about another member's card, email or bank;
 *   the answer comes from the rule, so no prompt ever carries the question.
 * - VOICE §4.12 C / §8 / SAFETY §2.7 rule 1: in family mode, a request for
 *   nightlife or alcohol whose audience includes the minor (or names no
 *   adult-only audience) gets the family options from the trip plan plus
 *   "@ me separately and i'll keep Lily off that plan". An adult asking for a
 *   named adult-only audience ("dad and i want a quiet bar after lily's
 *   asleep") is not intercepted: that goes on to the model and the screen.
 */
import type { Activity, ContentTag, Group, IsoDateTime, Member, Trip } from '@trav/core';
import { formatTime, parseIso, safety } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import { commandText } from '../settings/parse.js';
import { keepMinorOffText, privateDataRefusalText } from '../settings/text.js';

// ---------- someone else's private data (VOICE §4.12 D) ----------

const PRIVATE_NOUNS = String.raw`(?:card|cards|credit card|debit card|bank|bank account|account|statement|statements|email|emails|inbox|transactions?|charges?|venmo|card charges?|purchases)`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The member whose private data the message asks about, if any: "Sam's card",
 * "what did Sam's card get charged", "what's on Jordan's statement", "what
 * did Sam spend on his card". The sender's own data is not "someone else's".
 */
export function privateDataSubject(
  text: string,
  members: readonly Member[],
  me: Member,
): Member | undefined {
  const t = commandText(text);
  for (const m of members) {
    if (m.memberId === me.memberId) continue;
    const name = escapeRe(m.displayName.toLowerCase());
    const possessive = new RegExp(
      String.raw`(?<![\p{L}])${name}'s\s+(?:\p{L}+\s+){0,2}?${PRIVATE_NOUNS}(?![\p{L}])`,
      'u',
    );
    const spent = new RegExp(
      String.raw`(?<![\p{L}])${name}\s+(?:spend|spent|buy|bought|charge|charged|pay|paid)\b.*\bon\s+(?:his|her|their)\s+(?:card|account)\b`,
      'u',
    );
    if (possessive.test(t) || spent.test(t)) return m;
  }
  return undefined;
}

export function privateDataRefusal(subject: Member): string {
  return privateDataRefusalText(subject.displayName);
}

// ---------- nightlife with a minor (VOICE §4.12 C) ----------

const ASK_WORDS =
  /\?|\b(?:book|get|find|any|suggest|recommend|recs?|ideas?|where|what'?s good|take|bring|go to|going to|hit|plan|options?)\b/u;

const ADULTS_PHRASE =
  /\b(?:just|only) (?:the )?(?:adults|grown[- ]?ups|parents)\b|\bfor the (?:adults|grown[- ]?ups|parents)\b|\badults?[- ]only\b|\bwe'?re both (?:18|21)\+?/u;

const WHOLE_GROUP =
  /\b(?:all of us|everyone|everybody|whole family|the family|all (?:four|five|six|three) of us|the (?:two|three|four|five|six) of us|\d+ of us|(?:two|three|four|five|six) of us|all of you|the kids?)\b/u;

const SELF_WORDS = /\b(?:i|me|we'?re both|both of us|the two of us)\b/u;

function minorExcluded(t: string, name: string): boolean {
  const n = escapeRe(name.toLowerCase());
  return new RegExp(
    String.raw`\b(?:after|once|while|when)\s+${n}(?:'s|\s+is|\s+goes)?\s+(?:asleep|in bed|sleeping|gone to bed|goes to bed|to bed|down)\b|\bwithout\s+${n}\b|\b${n}(?:'s|\s+is)?\s+(?:staying|stays)\b|\bnot\s+${n}\b|\bminus\s+${n}\b`,
    'u',
  ).test(t);
}

/**
 * Who an explicit adult-only request is for, or undefined when the message
 * does not name an adult-only audience (SAFETY §2.7 rule 1: the reply must
 * name it). Fails closed: any inclusive mention of a minor, or of the whole
 * group, means it is not adult-only.
 */
export function explicitAdultAudience(
  text: string,
  members: readonly Member[],
  me: Member,
  now: IsoDateTime,
): readonly Member[] | undefined {
  const t = commandText(text);
  const active = members.filter((m) => m.active && m.role !== 'guest');
  const minors = active.filter((m) => safety.isMinor(m, now));
  const adults = active.filter((m) => !safety.isMinor(m, now));
  for (const m of minors) {
    if (safety.mentionsName(t, m.displayName) && !minorExcluded(t, m.displayName)) return undefined;
  }
  if (safety.minorReferentIncluded(t) || WHOLE_GROUP.test(t)) return undefined;
  if (ADULTS_PHRASE.test(t)) return adults;
  const named = adults.filter(
    (a) => a.memberId !== me.memberId && safety.mentionsName(t, a.displayName),
  );
  if (named.length === 0 || !SELF_WORDS.test(t)) return undefined;
  return [me, ...named.filter((a) => a.memberId !== me.memberId)];
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function familySafe(a: Activity, minors: readonly Member[], now: IsoDateTime): boolean {
  if (a.kind === 'nightlife') return false;
  if (safety.isRestrictedContent(a.contentTags)) return false;
  if (safety.isRestrictedText(`${a.name} ${a.venue ?? ''}`)) return false;
  if (a.ageRestriction !== null) {
    for (const m of minors) {
      const age = safety.ageOn(m, now);
      if (age === undefined || age < a.ageRestriction) return false;
    }
  }
  return true;
}

export interface MinorNightlifeRefusal {
  readonly text: string;
  readonly cause: 'minor_nightlife' | 'minor_alcohol';
  readonly tags: readonly ContentTag[];
}

/**
 * VOICE §4.12 C for a family-mode group lane: undefined unless the message
 * asks for restricted content (nightlife, bars, alcohol, 18+/21+, gambling)
 * and names no adult-only audience.
 */
export function minorNightlifeRefusal(input: {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly activities: readonly Activity[];
  readonly me: Member;
  readonly text: string;
  readonly now: IsoDateTime;
}): MinorNightlifeRefusal | undefined {
  const { group, members, trip, me, now } = input;
  if (!safety.isFamilyMode(group, members, now)) return undefined;
  const t = commandText(input.text);
  const tags = safety.detectContentTags(t);
  if (!safety.isRestrictedContent(tags)) return undefined;
  if (!ASK_WORDS.test(`${t}${input.text.includes('?') ? '?' : ''}`)) return undefined;
  if (explicitAdultAudience(input.text, members, me, now) !== undefined) return undefined;

  const active = members.filter((m) => m.active && m.role !== 'guest');
  const minors = active.filter((m) => safety.isMinor(m, now));
  const tz = trip?.timeZone;
  const options =
    tz === undefined
      ? []
      : input.activities
          .filter((a) => a.startsAt !== undefined && parseIso(a.startsAt) >= parseIso(now))
          .filter((a) => familySafe(a, minors, now))
          .sort((a, b) => parseIso(a.startsAt!) - parseIso(b.startsAt!))
          .slice(0, 2)
          .map((a) => `${sanitizeInline(a.name, 40)} ${formatTime(a.startsAt!, tz, now)}`);
  const who = `the ${countWord(active.length)} of you`;
  const first =
    options.length > 0
      ? `for ${who}: ${options.join(', or ')}`
      : `nothing on the plan for ${who} that fits yet`;
  const names = minors.map((m) => m.displayName);
  const alcoholOnly = tags.includes('alcohol') && !tags.some((x) => x !== 'alcohol');
  return {
    text: `${first}\n${keepMinorOffText(names.length > 0 ? names : ['the kids'])}`,
    cause: alcoholOnly ? 'minor_alcohol' : 'minor_nightlife',
    tags,
  };
}
