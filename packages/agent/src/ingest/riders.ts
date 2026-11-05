/**
 * Ride receipts split by riders (T-135, closes T-075; VOICE §4.5 C, §4.11).
 *
 * A ride receipt can say how many people rode ("Riders on this trip: 4").
 * `applyRiders` puts that count next to the split `sharePlan` picked (that
 * night's roster, else everyone):
 *  - no usable count (absent, not 1..12, or dropped because the email was
 *    flagged) ⇒ the plan as it was;
 *  - the plan already has exactly that many people (owner included) ⇒ the
 *    plan as it was: the count and the roster agree on who rode;
 *  - the plan has more people, and taking out the ones who said in the group
 *    thread that night that they had left ("heading back", "where r u guys",
 *    `leftTheGroup`) leaves exactly that many, owner included ⇒ those people,
 *    listed by name on the card (Priya's 4 of the 5 out in El Born: Maya
 *    went looking for the others and took her own cab);
 *  - anything else ⇒ no guess. The plan has no participants and carries
 *    `askRiders`, and the card asks the owner, in their DM, who rode
 *    (`ridersQuestion`). Money facts are never assumed (VOICE §4.11): a
 *    split Trav works out is only ever proposed, and only the owner's 👍
 *    puts it on the tab.
 *
 * The owner's answer is a DM naming the others ("dean, jordan and sam",
 * "everyone but maya"); `parseRiderNames` reads it strictly: only active,
 * non-guest members of the group, unambiguous names, and nothing else but
 * joining words, so an ordinary DM is never taken for an answer.
 */
import type { GroupMessageSummary, IsoDateTime, Member, MemberId } from '@trav/core';
import { parseIso } from '@trav/core';
import { ridersQuestion } from '../render/expenseConfirm.js';
import type { SharePlan } from './pending.js';

/** A rider count outside 1..this is not believed (the parser and `rideDetail` use the same cap). */
export const MAX_RIDERS = 12;

export function validRiders(n: number | undefined): n is number {
  return n !== undefined && Number.isSafeInteger(n) && n >= 1 && n <= MAX_RIDERS;
}

/** What the group thread said that night, for `applyRiders`. */
export interface RiderContext {
  readonly ownerMemberId: MemberId;
  /** When the ride ended (the receipt's time). */
  readonly occurredAt: IsoDateTime;
  /** The group thread, oldest first (the loop's transcript: members' own words, no DMs). */
  readonly groupMessages?: readonly GroupMessageSummary[];
}

/**
 * How far back a "left the group" line counts: one night out. And how close
 * to the ride it may be: within the last hour, "heading back" is most likely
 * the ride itself, so it says nothing about who was not in it.
 */
export const LEFT_LOOKBACK_MIN = 4 * 60;
export const LEFT_MIN_LEAD_MIN = 60;

/** A member's own line saying they are not with the others (anymore). */
const LEFT_PATTERNS: readonly RegExp[] = [
  // "where r u guys", "where are you all", "where'd everyone go", "where is everyone"
  /\bwhere(?:'d| did| r| are)? (?:u|you|y'?all|you all|everyone|everybody)\b/,
  /\bwhere(?:'?s| is) (?:everyone|everybody)\b/,
  /\b(?:lost|can'?t find|cant find|cannot find) (?:u|you|y'?all|you guys|everyone|everybody|the group)\b/,
  // "heading back", "going home now", "headed back to the hotel" (but not "going back to the bar")
  /\b(?:heading|headed|going|gone|went|head) (?:home|back)(?: to (?:the )?(?:hotel|apartment|apt|flat|airbnb|room|place))?(?: now)?(?:$|[.!,;]| (?:lol|guys|night|gn|xx?)\b)/,
  /\b(?:my own|a separate|separate) (?:cab|taxi|uber|lyft|ride|car)\b/,
  /\b(?:i'?m|im|i am) (?:out|done|calling it|going to bed|off to bed)(?:$|[.!,;]| for (?:the )?(?:night|tonight)\b)/,
  /\bcalling it(?: a night)?\b/,
  /\b(?:made it|got|i'?m|im) home\b/,
];

/** A later line from the same member saying they found the others again. */
const BACK_PATTERNS: readonly RegExp[] = [
  /\bfound (?:u|you|y'?all|you guys|everyone|everybody|the group)\b/,
  /\b(?:omw|on my way)\b/,
  /\b(?:i'?m|im|i am) (?:here|outside|with (?:u|you|y'?all))\b/,
  /\bsee (?:u|you|y'?all)\b/,
  /\bbe there in\b/,
];

function lineOf(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * Members (among `candidates`, never the owner) whose own group-thread line,
 * between `LEFT_LOOKBACK_MIN` and `LEFT_MIN_LEAD_MIN` before the ride ended,
 * said they had left the others, with no later line from them saying they
 * were back. Trav's messages and marker lines (pasted text, guests) never
 * count: their `senderMemberId` is null or the text is a marker.
 */
export function leftTheGroup(
  messages: readonly GroupMessageSummary[],
  candidates: readonly MemberId[],
  ownerMemberId: MemberId,
  occurredAt: IsoDateTime,
): Set<MemberId> {
  const end = parseIso(occurredAt);
  const from = end - LEFT_LOOKBACK_MIN * 60_000;
  const lastLeftBy = end - LEFT_MIN_LEAD_MIN * 60_000;
  const leftAt = new Map<MemberId, number>();
  const sorted = [...messages]
    .filter((m) => !m.fromTrav && m.senderMemberId !== null)
    .map((m) => ({ m, t: parseIso(m.at) }))
    .filter(({ t }) => Number.isFinite(t) && t >= from && t <= end)
    .sort((a, b) => a.t - b.t);
  for (const { m, t } of sorted) {
    const who = m.senderMemberId!;
    if (who === ownerMemberId || !candidates.includes(who)) continue;
    const line = lineOf(m.text);
    if (t <= lastLeftBy && LEFT_PATTERNS.some((re) => re.test(line))) leftAt.set(who, t);
    else if (leftAt.has(who) && BACK_PATTERNS.some((re) => re.test(line))) leftAt.delete(who);
  }
  return new Set(leftAt.keys());
}

/** The split plan with the receipt's rider count applied (rule in the module comment). */
export function applyRiders(
  plan: SharePlan,
  riders: number | undefined,
  ctx?: RiderContext,
): SharePlan {
  if (!validRiders(riders)) return plan;
  if (plan.participants.length === riders) return plan;
  if (ctx !== undefined && riders >= 2 && plan.participants.length > riders) {
    const left = leftTheGroup(
      ctx.groupMessages ?? [],
      plan.participants,
      ctx.ownerMemberId,
      ctx.occurredAt,
    );
    const rode = plan.participants.filter((id) => !left.has(id));
    if (rode.length === riders && rode.includes(ctx.ownerMemberId)) {
      // No label ("the 5 who went" is no longer true): the card lists the names.
      return {
        participants: rode,
        ...(plan.guess !== undefined ? { guess: plan.guess } : {}),
        ...(plan.activityId !== undefined ? { activityId: plan.activityId } : {}),
      };
    }
  }
  return {
    participants: [],
    askRiders: riders,
    ...(plan.activityId !== undefined ? { activityId: plan.activityId } : {}),
  };
}

/** The card's question (`render/expenseConfirm.ts`), re-exported for the answer path. */
export { ridersQuestion };

/** A typed answer that names nobody Trav can match (it was a reply to the card). */
export const RIDERS_UNCLEAR_TEXT =
  "i couldn't match those names. send just the names of who rode, or 👎 to keep it just yours";

/** Words allowed around the names in an answer. */
const FILLER = new Set([
  'and',
  'or',
  'nor',
  'n',
  'plus',
  'with',
  'me',
  'i',
  'myself',
  'also',
  'too',
  'just',
  'only',
  'it',
  'its',
  "it's",
  'was',
  'were',
  'rode',
  'us',
  'both',
  'of',
  'ok',
  'okay',
  'oh',
  'um',
]);

const EVERYONE = /^(?:everyone|everybody|all of us|all|the whole group|the group)\b/;
const EXCEPT = /^(?:but|except|minus|without|other than|apart from|not)\b/;
const LEADING_NOT = /^(?:not|no|minus|without)\b/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type RiderNames =
  /** Who rode, owner included, group order. */
  | { readonly kind: 'names'; readonly memberIds: readonly MemberId[] }
  /** Not an answer naming riders. */
  | { readonly kind: 'none' };

/**
 * Reads a DM as "these people rode with me" (owner always included). The
 * card names no one, so "not maya" / "everyone but maya" mean every active
 * member but Maya. Returns `none` unless every word is a name or a joining
 * word, and unless someone besides the owner rode.
 */
export function parseRiderNames(
  text: string,
  members: readonly Member[],
  ownerMemberId: MemberId,
): RiderNames {
  const none = { kind: 'none' } as const;
  // Active, non-guest members (`activeMembers` in pending.ts; inlined: pending.ts imports this module).
  const active = members.filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
  const order = active.map((m) => m.memberId);
  let low = ` ${text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[.,!?;:&+/()"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  if (low.trim() === '') return none;

  // "everyone but maya" / "all except henry and maya" / "not maya"
  let base: MemberId[] | undefined;
  const lead = low.trim();
  const every = EVERYONE.exec(lead);
  if (every !== null) {
    base = order;
    const rest = lead.slice(every[0].length).trim();
    if (rest !== '') {
      const ex = EXCEPT.exec(rest);
      if (ex === null) return none;
      low = ` ${rest.slice(ex[0].length).trim()} `;
    } else {
      low = ' ';
    }
  } else {
    const not = LEADING_NOT.exec(lead);
    if (not !== null) {
      base = order;
      low = ` ${lead.slice(not[0].length).trim()} `;
    }
  }

  // Names: longest first, so "mary jo" wins over "mary"; a name two members share is no answer.
  const byName = new Map<string, MemberId[]>();
  for (const m of active) {
    const name = m.displayName.trim().toLowerCase();
    if (name === '') continue;
    byName.set(name, [...(byName.get(name) ?? []), m.memberId]);
  }
  const named: MemberId[] = [];
  for (const name of [...byName.keys()].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRe(name)}(?:'s)?(?![\\p{L}\\p{N}])`, 'gu');
    if (!re.test(low)) continue;
    const ids = byName.get(name)!;
    if (ids.length !== 1) return none;
    named.push(ids[0]!);
    low = low.replace(re, ' ');
  }
  const leftover = low.split(' ').filter((w) => w !== '');
  if (leftover.some((w) => !FILLER.has(w))) return none;

  let riders: Set<MemberId>;
  if (base !== undefined) {
    if (named.length === 0 && every === null) return none; // a bare "no" is a keep answer, not this
    riders = new Set(base.filter((id) => !named.includes(id)));
  } else {
    riders = new Set(named);
  }
  riders.add(ownerMemberId);
  if (riders.size < 2) return none; // only the owner: "just me" is the keep answer
  return { kind: 'names', memberIds: order.filter((id) => riders.has(id)) };
}
