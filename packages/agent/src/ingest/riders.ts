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
 *    thread that night that they had left (`leftTheGroup`) leaves exactly
 *    that many, owner included ⇒ those people, listed by name on the card
 *    (Priya's 4 of the 5 out in El Born: Maya lost the others);
 *  - anything else ⇒ no guess. The plan has no participants and carries
 *    `askRiders`, and the card asks the owner, in their DM, who rode
 *    (`ridersQuestion`). Money facts are never assumed (VOICE §4.11): a
 *    split Trav works out is only ever proposed, and only the owner's 👍
 *    puts it on the tab.
 * In the first three cases the plan carries `riders` (the count): the card
 * then also says "or tell me who rode", and a names answer replaces the
 * proposed split (`parseRiderNames` with that split as the base).
 *
 * "Left the group" is read conservatively, so a wrong read can only make the
 * card ask: the member's own line, first person ("heading back", "im out",
 * "getting my own cab"), or a line that is only "where r u guys"; never a line
 * about someone else (another member's name, he/she/they/we/you), a negation,
 * any other question, or something in the past ("last night"). A line from
 * the same member saying they are back with the others ("omw", "coming",
 * "found you", "here") cancels it, including on the same line.
 *
 * The owner's answer is a DM naming the others ("dean, jordan and sam",
 * "everyone but maya", "maya not jordan"); `parseRiderNames` reads it
 * strictly: only active, non-guest members of the group, unambiguous names,
 * and nothing else but joining words, so an ordinary DM is never taken for an
 * answer.
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
  /**
   * The group thread, oldest first: members' own words, no DMs. The loop
   * passes its per-group ride buffer (the last `LEFT_LOOKBACK_MIN` of member
   * lines, capped), so a busy night doesn't push the signal out.
   */
  readonly groupMessages?: readonly GroupMessageSummary[];
  /** The group's members, so a line naming someone else is never read as the sender leaving. */
  readonly members?: readonly Member[];
}

/**
 * How far back a "left the group" line counts: one night out. How close to
 * the ride end it may be: within the last hour "heading back" is most likely
 * the ride itself; a bare "where r u guys" says the sender was apart from the
 * others, so it may be closer (30 min), and any later "omw"/"coming"/"here"
 * from them cancels it.
 */
export const LEFT_LOOKBACK_MIN = 4 * 60;
export const LEFT_MIN_LEAD_MIN = 60;
export const LOST_MIN_LEAD_MIN = 30;

/** A line from the member saying they are with the others (again). Checked first, same line too. */
const BACK =
  /\b(?:found (?:u|you|y'?all|you guys|everyone|everybody|the group|them)|omw|on my way|coming|here|outside|almost there|be there|see (?:u|you|y'?all)|with (?:u|you|y'?all|you guys|the group|everyone)|joining)\b/;

/** A line that is only "where are you guys" / "can't find you": the sender lost the others. */
const LOST_ONLY =
  /^(?:(?:guys|yo|hey|uh|um|ok|okay|wait)\s+)*(?:where(?:'d| did| r| are|'re)? (?:u|you|y'?all|you guys|you all|everyone|everybody)(?: guys| all)?(?: at| go| went)?|where(?:'?s| is) (?:everyone|everybody)(?: at)?|(?:i )?(?:lost|can'?t find|cant find|cannot find) (?:u|you|y'?all|you guys|everyone|everybody|the group))(?: guys)?[\s?!.]*$/;

const NEGATION =
  /\b(?:not|no|never|don'?t|dont|didn'?t|didnt|isn'?t|isnt|won'?t|wont|nah|nope|can'?t|cant|cannot|aren'?t)\b/;
const PAST = /\b(?:last night|yesterday|earlier|this morning|the other night|before)\b/;
/** Sarcasm or a joke: "sure, im going home. totally" is no signal. */
const SARCASM = /^(?:sure|yeah right)\b|\b(?:totally|jk|jkjk|kidding|as if|lmao)\b/;
/** Someone other than the sender as the subject. */
const OTHER_SUBJECT =
  /\b(?:he|she|they|he's|she's|they're|hes|shes|theyre|we|we're|were|us|you|u|y'?all|ur|your)\b/;

/** Words that may come before the leaving verb in a first-person clause. */
const LEAD =
  "(?:i|i'm|im|i am|i'll|ill|ima|imma|gonna|ok|okay|so|ya|yeah|yep|alright|k|lol|ugh|welp|think|prob|probably|just|actually|also|now|guys|ok guys)";
/** The leaving itself, first person. */
const DEPART =
  "(?:(?:heading|headed|going|gone|head) (?:home|back)(?: to (?:the )?(?:hotel|apartment|apt|flat|airbnb|room|place))?|(?:getting|grabbing|taking|took|got|calling) (?:my own|a separate) (?:cab|taxi|uber|lyft|ride|car)|(?:i'?m|im|i am) (?:out|done|calling it|going to bed|off to bed|home|crashing|bailing)|calling it(?: a night)?|(?:made it|got) home)";
const TAIL = '(?: (?:now|lol|guys|gn|night|xx?|for (?:the )?(?:night|tonight)|early|safe))*';
const DEPART_CLAUSE = new RegExp(`^(?:${LEAD} )*${DEPART}${TAIL}$`);

function lineOf(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsName(line: string, names: readonly string[]): boolean {
  return names.some((n) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'u').test(line),
  );
}

export type LineSignal = 'back' | 'lost' | 'left' | undefined;

/**
 * One group-thread line, read as the sender's own whereabouts (rules in the
 * module comment). `otherNames`: lowercase display names of the other members.
 */
export function readLeftSignal(text: string, otherNames: readonly string[] = []): LineSignal {
  const line = lineOf(text);
  if (line === '') return undefined;
  if (BACK.test(line)) return 'back';
  if (mentionsName(line, otherNames)) return undefined;
  if (LOST_ONLY.test(line)) return 'lost';
  if (line.includes('?') || NEGATION.test(line) || PAST.test(line) || SARCASM.test(line)) {
    return undefined;
  }
  if (OTHER_SUBJECT.test(line)) return undefined;
  const clauses = line
    .split(/[,;.!]+|\s+-\s+/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
  return clauses.some((c) => DEPART_CLAUSE.test(c)) ? 'left' : undefined;
}

/**
 * Members (among `candidates`, never the owner) whose own group-thread line,
 * inside the lookback and at least the lead time before the ride ended, said
 * they had left (or lost) the others, with no later line from them saying they
 * were back. Trav's messages and marker lines (pasted text, guests) never
 * count: their `senderMemberId` is null or the text is a marker.
 */
export function leftTheGroup(
  messages: readonly GroupMessageSummary[],
  candidates: readonly MemberId[],
  ownerMemberId: MemberId,
  occurredAt: IsoDateTime,
  members: readonly Member[] = [],
): Set<MemberId> {
  const end = parseIso(occurredAt);
  const from = end - LEFT_LOOKBACK_MIN * 60_000;
  const leftBy = end - LEFT_MIN_LEAD_MIN * 60_000;
  const lostBy = end - LOST_MIN_LEAD_MIN * 60_000;
  const leftAt = new Map<MemberId, number>();
  const sorted = [...messages]
    .filter((m) => !m.fromTrav && m.senderMemberId !== null)
    .map((m) => ({ m, t: parseIso(m.at) }))
    .filter(({ t }) => Number.isFinite(t) && t >= from && t <= end)
    .sort((a, b) => a.t - b.t);
  for (const { m, t } of sorted) {
    const who = m.senderMemberId!;
    if (who === ownerMemberId || !candidates.includes(who)) continue;
    const others = members
      .filter((x) => x.memberId !== who)
      .map((x) => x.displayName.trim().toLowerCase())
      .filter((n) => n.length >= 2);
    const signal = readLeftSignal(m.text, others);
    if (signal === 'back') leftAt.delete(who);
    else if (signal === 'left' && t <= leftBy) leftAt.set(who, t);
    else if (signal === 'lost' && t <= lostBy) leftAt.set(who, t);
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
  if (plan.participants.length === riders) return { ...plan, riders };
  if (ctx !== undefined && riders >= 2 && plan.participants.length > riders) {
    const left = leftTheGroup(
      ctx.groupMessages ?? [],
      plan.participants,
      ctx.ownerMemberId,
      ctx.occurredAt,
      ctx.members ?? [],
    );
    const rode = plan.participants.filter((id) => !left.has(id));
    if (rode.length === riders && rode.includes(ctx.ownerMemberId)) {
      // No label ("the 5 who went" is no longer true): the card lists the names.
      return {
        participants: rode,
        riders,
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

/** VOICE §4.11: one question, stating the mismatch; nothing is logged until the owner answers. */
export function ridersMismatchText(receiptRiders: number, named: number): string {
  const r = `${String(receiptRiders)} ${receiptRiders === 1 ? 'rider' : 'riders'}`;
  return `the receipt says ${r}, you named ${String(named)}. log it ${String(named)} ways anyway? 👍 yes, or send me the right names`;
}

/** Words allowed around the names in an answer. */
const FILLER = new Set([
  'and',
  'or',
  'nor',
  'n',
  'plus',
  'with',
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
  'actually',
  'wait',
  'sorry',
]);
const NEGATORS = new Set(['not', 'minus', 'without', 'except', 'but', 'insteadof']);
const SELF = new Set(['me', 'i', 'myself']);

export type RiderNames =
  /** Who rode, owner included, group order. */
  | { readonly kind: 'names'; readonly memberIds: readonly MemberId[] }
  /** Not an answer naming riders. */
  | { readonly kind: 'none' };

/**
 * Reads a DM as "these people rode with me" (owner always included).
 * - A plain list ("dean, jordan and sam") is the riders.
 * - "everyone" / "everyone but maya and henry" / "all except henry": the
 *   active group, minus the names after the negator.
 * - Removals only ("not maya", "minus jordan"): `base` (the card's proposed
 *   split) minus them, or the whole active group when the card proposed none.
 * - A correction ("maya not jordan", "no it was maya instead of jordan"):
 *   `base` minus the removed plus the added (no base: the added names).
 * Returns `none` unless every word is a name or a joining word, unless
 * someone besides the owner rode, and when the owner takes themself out
 * ("all except me": the owner paid and is on the receipt).
 */
export function parseRiderNames(
  text: string,
  members: readonly Member[],
  ownerMemberId: MemberId,
  base?: readonly MemberId[],
): RiderNames {
  const none = { kind: 'none' } as const;
  // "wait was it dean jordan and maya?" is a question, never a split (VOICE §4.11).
  if (text.includes('?')) return none;
  // Active, non-guest members (`activeMembers` in pending.ts; inlined: pending.ts imports this module).
  const active = members.filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
  const order = active.map((m) => m.memberId);
  let low = ` ${text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[&+]/g, ' and ')
    .replace(/[,;]+/g, ' , ')
    .replace(/[.!?:/()"]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  if (low.trim() === '') return none;
  low = low
    .replace(/ instead of /g, ' insteadof ')
    .replace(/ (?:other than|apart from) /g, ' except ')
    .replace(/ (?:all of us|the whole group|the group|everybody) /g, ' everyone ');

  // Names: longest first, so "mary jo" wins over "mary"; a name two members share is no answer.
  const byName = new Map<string, MemberId[]>();
  for (const m of active) {
    const name = m.displayName.trim().toLowerCase();
    if (name === '') continue;
    byName.set(name, [...(byName.get(name) ?? []), m.memberId]);
  }
  const slots: MemberId[] = [];
  for (const name of [...byName.keys()].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}'])${escapeRe(name)}(?:'s)?(?![\\p{L}\\p{N}])`, 'gu');
    if (!re.test(low)) continue;
    const ids = byName.get(name)!;
    if (ids.length !== 1) return none;
    slots.push(ids[0]!);
    low = low.replace(re, ` #${String(slots.length - 1)} `);
  }

  const words = low.split(' ').filter((w) => w !== '');
  const added = new Set<MemberId>();
  const removed = new Set<MemberId>();
  let everyone = false;
  let neg = false;
  // A negator before a comma in a plain list: "dean, not jordan, sam" is mixed, so no answer.
  let negListed = false;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (w.startsWith('#')) {
      const memberId = slots[Number(w.slice(1))]!;
      if (memberId === ownerMemberId) {
        if (neg) return none;
        continue;
      }
      if (negListed && added.size > 0) return none;
      (neg ? removed : added).add(memberId);
    } else if (w === 'everyone' || w === 'all') {
      everyone = true;
    } else if (NEGATORS.has(w)) {
      neg = true;
    } else if (w === 'no' || w === 'nah' || w === 'nope') {
      // "no maya" takes Maya out; "no it was maya" is just a lead-in.
      if (words[i + 1]?.startsWith('#') === true) neg = true;
    } else if (w === ',') {
      // A list separator: "all except henry, maya" keeps both out.
      if (neg && !everyone) negListed = true;
    } else if (SELF.has(w)) {
      if (neg) return none;
    } else if (!FILLER.has(w)) {
      return none;
    }
  }

  let riders: Set<MemberId>;
  if (everyone) {
    riders = new Set([...order.filter((id) => !removed.has(id)), ...added]);
  } else if (removed.size > 0 && added.size === 0) {
    riders = new Set((base ?? order).filter((id) => !removed.has(id)));
  } else if (removed.size > 0) {
    riders = new Set([...(base ?? []).filter((id) => !removed.has(id)), ...added]);
  } else {
    riders = new Set(added);
  }
  if (!everyone && added.size === 0 && removed.size === 0) return none;
  // A trailing negator ("jordan not") says nothing about whom it applies to.
  if (NEGATORS.has(words[words.length - 1] ?? '')) return none;
  riders.add(ownerMemberId);
  if (riders.size < 2) return none; // only the owner: "just me" is the keep answer
  return { kind: 'names', memberIds: order.filter((id) => riders.has(id)) };
}
