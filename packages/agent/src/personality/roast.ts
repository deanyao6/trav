/**
 * On-demand roast requests ("@trav roast Piotr for the kebabs", T-017;
 * VOICE §7.2–7.5, SAFETY §2.8). Rule-parsed and deterministic: the answer is
 * either a VOICE §7.5 refusal or ONE line built from the tab (amounts, counts,
 * times, patterns), never model prose. Order of checks:
 *
 *  1. DM lane: roasts never go to a DM.
 *  2. Target is a minor: "nope" (one word, any group, any mode).
 *  3. Topic (gate 2, `safety.roastTopicBlocked`) on every part of the ask: a
 *     forbidden part is refused in any mode; a mixed ask ("the ubers and his
 *     haircut") keeps only the allowed half and never mentions the rest.
 *     Someone outside the chat is refused as an outsider.
 *  4. Group gate (`safety.groupRoastBlock`): minor in the group / family mode,
 *     roast mode off, ages unconfirmed, trip over.
 *  5. Target gate: left the chat, opted out, never opted in (consent defaults false).
 *  6. One roast aside per trip day (VOICE §7.2), counted from `roast.generated`.
 *  7. A line from the tab, re-checked against the blocklist; none ⇒ "nothing to work with".
 *
 * The line is sent as `roast: true` with `roastLines: [line]`, so the outbound
 * screen runs gate 1 and gate 2 again on the way out (T-028).
 */
import type {
  ConsentLookup,
  Expense,
  Group,
  IsoDateTime,
  Member,
  MemberId,
  Trip,
} from '@trav/core';
import {
  addDays,
  daysBetween,
  formatClockTime,
  formatMoney,
  isOnboardingPending,
  localDate,
  ledger,
  localHour,
  parseIso,
  safety,
} from '@trav/core';
import { neutralDescription } from '../recaps/wrapped.js';
import { commandText, parseSettingsCommand } from '../settings/parse.js';
import {
  NOPE_TEXT,
  NOTHING_TO_ROAST_TEXT,
  REFUSE_BODY_TEXT,
  REFUSE_DAILY_TEXT,
  REFUSE_DM_TEXT,
  REFUSE_HANGOVER_TEXT,
  REFUSE_HARDSHIP_TEXT,
  REFUSE_HEALTH_TEXT,
  REFUSE_LEFT_TEXT,
  REFUSE_MODE_OFF_TEXT,
  REFUSE_OPTED_OUT_TEXT,
  REFUSE_PERSONAL_TEXT,
  ROAST_AGE_UNCONFIRMED_REQUEST_TEXT,
  ROAST_NEWCOMER_REQUEST_TEXT,
  ROAST_MINOR_TEXT,
  ROAST_TRIP_OVER_TEXT,
  SELF_NOT_OPTED_IN_TEXT,
  notOptedInText,
  refuseOutsiderText,
} from '../settings/text.js';

export interface RoastRequest {
  /** Who: a name, "me", "everyone", "the host, she is so annoying". */
  readonly targetText: string;
  /** What for ("the kebabs", "her outfit"); empty when the ask names no topic. */
  readonly topicText: string;
  /** The command text after "roast " (lowercased). */
  readonly rest: string;
}

const GROUP_TARGET =
  /^(?:everyone|everybody|us|all of us|all of you|you all|y'?all|the group|the whole group|the squad|the gang|the crew)\b\s*(.*)$/u;

/** "@trav roast Piotr for the kebabs" → target "piotr", topic "the kebabs". */
export function parseRoastRequest(text: string): RoastRequest | undefined {
  const t = commandText(text);
  const m = /^(?:(?:can you|go|pls|please)\s+)?roast\s+(.+)$/u.exec(t);
  if (m === null) return undefined;
  const rest = m[1]!.trim();
  // "roast mode on" / "roast me (i can take it)" are settings and consent (settings/parse.ts).
  if (/^(?:mode|me$|ing mode)/u.test(rest) || parseSettingsCommand(text) !== undefined) {
    return undefined;
  }
  const group = GROUP_TARGET.exec(rest);
  if (group !== null) {
    return {
      targetText: 'everyone',
      topicText: group[1]!.replace(/^(?:for|about|over|on)\s+/u, '').trim(),
      rest,
    };
  }
  const possessive = /^([\p{L}][\p{L}-]{0,30})'s\s+(.+)$/u.exec(rest);
  if (possessive !== null && !/^(?:the|our|that|this)$/u.test(possessive[1]!)) {
    return { targetText: possessive[1]!, topicText: possessive[2]!.trim(), rest };
  }
  const split = /^(.+?)\s+(?:for|about|over|because|on)\s+(.+)$/u.exec(rest);
  if (split !== null) return { targetText: split[1]!.trim(), topicText: split[2]!.trim(), rest };
  return { targetText: rest, topicText: '', rest };
}

// ---------- answer ----------

export type RoastRefusalCause =
  | 'wrong_place'
  | 'minor_in_group'
  | 'topic_blocked'
  | 'mode_off'
  | 'age_unconfirmed'
  | 'trip_over'
  | 'target_inactive'
  | 'target_not_member'
  | 'member_opted_out'
  | 'line_limit';

export type RoastAnswer =
  | {
      readonly kind: 'refuse';
      readonly text: string;
      readonly cause: RoastRefusalCause;
      readonly topicCategory?: safety.RoastTopicCategory;
      readonly targets: readonly MemberId[];
    }
  | {
      readonly kind: 'roast';
      readonly line: string;
      readonly targets: readonly MemberId[];
      readonly topics: readonly string[];
      /** The forbidden half of a mixed ask, dropped silently (audited only). */
      readonly dropped?: safety.RoastTopicCategory;
    }
  | { readonly kind: 'nothing'; readonly text: string; readonly targets: readonly MemberId[] };

export interface RoastContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly me: Member;
  readonly lane: 'group' | 'dm';
  readonly now: IsoDateTime;
  /** Logged (not undone) expenses of the current trip. */
  readonly expenses: readonly Expense[];
  readonly consent: ConsentLookup;
  /** Did this member explicitly say "stop roasting me"? */
  readonly optedOut: (memberId: MemberId) => boolean;
  /** Roast asides already sent today (VOICE §7.2: max 1 per day). */
  readonly roastsToday: number;
}

type Target =
  | { readonly kind: 'group' }
  | { readonly kind: 'member'; readonly member: Member }
  | { readonly kind: 'outsider' };

function resolveTarget(req: RoastRequest, ctx: RoastContext): Target {
  if (req.targetText === 'everyone') return { kind: 'group' };
  const words = req.targetText.replace(/[,.].*$/u, '').trim();
  if (/^(?:me|myself)$/u.test(words)) return { kind: 'member', member: ctx.me };
  const first = words.split(/\s+/u)[0] ?? '';
  const found = ctx.members.find((m) => {
    const name = m.displayName.toLowerCase();
    return name === words || name === first || name.split(/\s+/u)[0] === first;
  });
  return found !== undefined ? { kind: 'member', member: found } : { kind: 'outsider' };
}

function pronounOf(text: string): 'she' | 'he' | 'they' {
  if (/\b(?:she|her|hers)\b/u.test(text)) return 'she';
  if (/\b(?:he|him|his)\b/u.test(text)) return 'he';
  return 'they';
}

/** Category → the VOICE §7.5 refusal line. */
function refusalFor(category: safety.RoastTopicCategory, text: string): string {
  switch (category) {
    case 'body':
      if (/\bhung\s?over\b|\bhangovers?\b/u.test(text)) return REFUSE_HANGOVER_TEXT;
      if (/\b(?:sleep|slept|asleep|nap|tired)\b/u.test(text)) return REFUSE_HEALTH_TEXT;
      return REFUSE_BODY_TEXT;
    case 'health':
      return /\bhung\s?over\b|\bhangovers?\b/u.test(text) ? REFUSE_HANGOVER_TEXT : REFUSE_HEALTH_TEXT;
    case 'hardship':
      return REFUSE_HARDSHIP_TEXT;
    case 'minor':
      return NOPE_TEXT;
    case 'outsider':
      return refuseOutsiderText(pronounOf(text));
    case 'left_member':
      return REFUSE_LEFT_TEXT;
    default:
      return REFUSE_PERSONAL_TEXT;
  }
}

const PIECE_SPLIT = /\s*(?:,|&|\+|\band\b|\bplus\b|\balso\b|\bor\b)\s*/u;

function pieces(topic: string): string[] {
  return topic
    .split(PIECE_SPLIT)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Only the tab's money facts are roastable; this never reads private stores. */
export function answerRoast(req: RoastRequest, ctx: RoastContext): RoastAnswer {
  const target = resolveTarget(req, ctx);
  const targets = target.kind === 'member' ? [target.member.memberId] : [];
  const refuse = (
    text: string,
    cause: RoastRefusalCause,
    topicCategory?: safety.RoastTopicCategory,
  ): RoastAnswer => ({
    kind: 'refuse',
    text,
    cause,
    targets,
    ...(topicCategory !== undefined ? { topicCategory } : {}),
  });

  // 1. never in a DM (VOICE §7.2).
  if (ctx.lane === 'dm') return refuse(REFUSE_DM_TEXT, 'wrong_place');
  // 2. a minor, ever, in any group (VOICE §7.4): one word.
  if (target.kind === 'member' && safety.isMinor(target.member, ctx.now)) {
    return refuse(NOPE_TEXT, 'minor_in_group', 'minor');
  }

  // 3. topic, in any mode. Someone outside the chat is the topic itself.
  if (target.kind === 'outsider') {
    const category = safety.roastTopicBlocked(req.rest) ?? 'outsider';
    return refuse(
      category === 'outsider' ? refuseOutsiderText(pronounOf(req.rest)) : refusalFor(category, req.rest),
      'topic_blocked',
      category,
    );
  }
  const parts = pieces(req.topicText);
  const blocked = parts
    .map((p) => ({ p, category: safety.roastTopicBlocked(p) }))
    .filter((x): x is { p: string; category: safety.RoastTopicCategory } => x.category !== null);
  const allowed = parts.filter((p) => safety.roastTopicBlocked(p) === null);
  if (blocked.length > 0 && allowed.length === 0) {
    const first = blocked[0]!;
    return refuse(refusalFor(first.category, req.topicText), 'topic_blocked', first.category);
  }
  const dropped = blocked[0]?.category;

  // 4. group gate (SAFETY §2.8 gate 1, group half).
  const groupBlock = safety.groupRoastBlock(ctx.group, ctx.members, ctx.trip, ctx.now);
  if (groupBlock === 'minor_in_group' || groupBlock === 'family_mode') {
    return refuse(ROAST_MINOR_TEXT, 'minor_in_group');
  }
  if (groupBlock === 'mode_off') return refuse(REFUSE_MODE_OFF_TEXT, 'mode_off');
  if (groupBlock === 'age_unconfirmed') {
    // T-170: "everyone's 18+" can't cover a newcomer still in setup, so don't suggest it.
    if (ctx.members.some(isOnboardingPending))
      return refuse(ROAST_NEWCOMER_REQUEST_TEXT, 'age_unconfirmed');
    return refuse(ROAST_AGE_UNCONFIRMED_REQUEST_TEXT, 'age_unconfirmed');
  }
  if (groupBlock === 'trip_over') return refuse(ROAST_TRIP_OVER_TEXT, 'trip_over');

  // 5. target gate (SAFETY §2.8 gate 1, target half; consent defaults false).
  if (target.kind === 'member') {
    const gate = safety.roastAllowed(
      ctx.group,
      ctx.members,
      target.member,
      ctx.consent,
      ctx.trip,
      ctx.now,
    );
    if (!gate.allowed) {
      if (gate.cause === 'target_inactive') return refuse(REFUSE_LEFT_TEXT, 'target_inactive');
      if (gate.cause === 'target_not_member') {
        return refuse(refuseOutsiderText('they'), 'target_not_member', 'outsider');
      }
      if (gate.cause === 'minor_in_group') return refuse(NOPE_TEXT, 'minor_in_group', 'minor');
      return ctx.optedOut(target.member.memberId)
        ? refuse(REFUSE_OPTED_OUT_TEXT, 'member_opted_out')
        : refuse(
            target.member.memberId === ctx.me.memberId
              ? SELF_NOT_OPTED_IN_TEXT
              : notOptedInText(target.member.displayName),
            'member_opted_out',
          );
    }
  }

  // 6. one aside per day.
  if (ctx.roastsToday >= 1) return refuse(REFUSE_DAILY_TEXT, 'line_limit');

  // 7. the line, from the tab only.
  const trip = ctx.trip;
  if (trip === null) return { kind: 'nothing', text: NOTHING_TO_ROAST_TEXT, targets };
  const line =
    target.kind === 'group'
      ? groupLine(ctx.expenses, trip)
      : memberLine(target.member, allowed, ctx, trip);
  if (line === undefined || safety.roastTopicBlocked(line.text) !== null) {
    return { kind: 'nothing', text: NOTHING_TO_ROAST_TEXT, targets };
  }
  return {
    kind: 'roast',
    line: line.text,
    targets,
    topics: [line.topic],
    ...(dropped !== undefined ? { dropped } : {}),
  };
}

// ---------- lines from the tab (VOICE §7.3) ----------

interface Line {
  readonly text: string;
  readonly topic: 'rides' | 'pattern' | 'single' | 'biggest' | 'total';
}

const RIDE_WORDS = /\b(?:ubers?|taxis?|cabs?|rides?|lyfts?|bolts?|cars?|transport)\b/u;
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'all',
  'those',
  'these',
  'that',
  'this',
  'his',
  'her',
  'their',
  'my',
  'your',
  'from',
  'at',
  'of',
  'on',
  'in',
  'for',
  'about',
  'last',
  'night',
  'tonight',
  'yesterday',
  'today',
  'again',
  'way',
  'too',
  'many',
  'much',
  'so',
  'every',
  'single',
  'one',
  'ones',
]);

function soloPayer(e: Expense, memberId: MemberId): boolean {
  return e.paidBy.length === 1 && e.paidBy[0]!.memberId === memberId;
}

function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|x|ss)es$/u.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function plural(word: string): string {
  if (/(?:ch|sh|x|ss)$/u.test(word)) return `${word}es`;
  return word.endsWith('s') ? word : `${word}s`;
}

/** The date whose night an instant belongs to (before 5am counts as the night before). */
function nightOf(iso: IsoDateTime, tz: string): string {
  const date = localDate(iso, tz);
  return localHour(iso, tz) >= 5 ? date : addDays(date, -1);
}

function consecutive(dates: readonly string[]): boolean {
  const days = [...new Set(dates)].sort();
  return days.every((d, i) => i === 0 || daysBetween(days[i - 1]!, d) === 1);
}

function memberLine(
  member: Member,
  topics: readonly string[],
  ctx: RoastContext,
  trip: Trip,
): Line | undefined {
  const name = member.displayName;
  // Trip currency only: a $90 charge must not outrank €80 by raw minor units.
  const mine = ctx.expenses.filter(
    (e) => soloPayer(e, member.memberId) && e.amount.currency === trip.currency,
  );
  const rides = ctx.expenses.filter((e) => e.category === 'transport');
  const ridesLine = (): Line | undefined => {
    const myRides = rides.filter((e) => soloPayer(e, member.memberId));
    if (myRides.length >= 2) {
      return {
        text: `${name} has paid for ${String(myRides.length)} of the ${String(rides.length)} rides. walking is free`,
        topic: 'rides',
      };
    }
    if (myRides.length === 1) {
      return {
        text: `${formatMoney(myRides[0]!.amount)} ride on ${name} at ${formatClockTime(myRides[0]!.occurredAt, trip.timeZone)}. walking is free`,
        topic: 'rides',
      };
    }
    return undefined;
  };
  const wordLine = (word: string): Line | undefined => {
    const hits = mine.filter((e) => e.description.toLowerCase().includes(word));
    if (hits.length === 0) return undefined;
    const nights = hits.map((e) => nightOf(e.occurredAt, trip.timeZone));
    const count = new Set(nights).size;
    if (count >= 2) {
      return {
        text: consecutive(nights)
          ? `${name} has paid for ${plural(word)} ${String(count)} nights running. the tab remembers`
          : `${name} has paid for ${plural(word)} on ${String(count)} different nights. the tab remembers`,
        topic: 'pattern',
      };
    }
    const one = [...hits].sort((a, b) => b.amount.amountMinor - a.amount.amountMinor)[0]!;
    const what = neutralDescription(one.description, ctx.members, false);
    if (what === null) return undefined;
    return {
      text: `${formatMoney(one.amount)} for ${what.toLowerCase()} at ${formatClockTime(one.occurredAt, trip.timeZone)}, on ${name}. the tab remembers`,
      topic: 'single',
    };
  };

  for (const topic of topics) {
    if (RIDE_WORDS.test(topic)) {
      const l = ridesLine();
      if (l !== undefined) return l;
      continue;
    }
    const words = topic
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map(singular);
    for (const w of words) {
      const l = wordLine(w);
      if (l !== undefined) return l;
    }
  }
  if (topics.length > 0) return undefined;
  // No topic: the most roastable fact on the tab.
  const r = ridesLine();
  if (r !== undefined && r.topic === 'rides' && /has paid for/u.test(r.text)) return r;
  const biggest = [...mine].sort((a, b) => b.amount.amountMinor - a.amount.amountMinor)[0];
  if (biggest !== undefined) {
    const what = neutralDescription(biggest.description, ctx.members, false);
    if (what !== null) {
      return {
        text: `${name} fronted ${formatMoney(biggest.amount)} for ${what.toLowerCase()}. bold`,
        topic: 'biggest',
      };
    }
  }
  return r;
}

/** A line about the whole group names nobody (VOICE §7.1: the group, not one person). */
function groupLine(all: readonly Expense[], trip: Trip): Line | undefined {
  // Amounts are only summed in the trip currency (a €-tab with one $ charge never adds the two).
  const expenses = all.filter((e) => e.amount.currency === trip.currency);
  const rides = expenses.filter((e) => e.category === 'transport');
  if (rides.length >= 3) {
    return {
      text: `${String(rides.length)} rides on the tab so far, ${formatMoney(ledger.totalSpent(rides, trip.currency))}. walking is free`,
      topic: 'rides',
    };
  }
  if (expenses.length >= 2) {
    const late = expenses.filter((e) => {
      const h = localHour(e.occurredAt, trip.timeZone);
      return h < 5;
    });
    if (late.length >= 2) {
      const latest = [...late].sort((a, b) => parseIso(b.occurredAt) - parseIso(a.occurredAt))[0]!;
      return {
        text: `${String(late.length)} things on the tab after midnight, latest at ${formatClockTime(latest.occurredAt, trip.timeZone)}. the tab remembers`,
        topic: 'pattern',
      };
    }
    return {
      text: `${formatMoney(ledger.totalSpent(expenses, trip.currency))} on the tab across ${String(expenses.length)} things so far. nobody's slowing down`,
      topic: 'total',
    };
  }
  return undefined;
}
