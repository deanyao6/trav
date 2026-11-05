/**
 * Activity roster (T-030; ARCHITECTURE Flow 2 step 1; SAFETY §2.5 "attendance
 * vs payers", §2.8 health). The roster is the single source of truth for who a
 * booking is for: quantity, attendees and payers all derive from the members
 * marked `in`, so they cannot diverge. "maybe" counts as out at booking time.
 *
 * The reason someone is out ("Henry's sick") is never stored: `AttendanceChange`
 * has no field for it, the audit payload carries ids and statuses only, and
 * the roll-call text never repeats it. `parseRosterUpdate` drops the reason on
 * the floor by construction (it returns ids and statuses).
 */
import type {
  Activity,
  Attendance,
  AttendanceStatus,
  BookingProposal,
  GroupStore,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Roster,
} from '@trav/core';
import { addDays, formatTime, parseIso, safety } from '@trav/core';
import { nightOf } from '../booking/proposals.js';
import { payersFor, type PayerRule } from '../booking/payers.js';
import { sanitizeInline } from '../context/groupContext.js';
import { stripInvisible } from '../untrusted.js';

/** One roster change. Deliberately no `reason`, `note` or free text of any kind. */
export interface AttendanceChange {
  readonly activityId: string;
  readonly memberId: MemberId;
  readonly status: AttendanceStatus;
  /** Who said it (channel-resolved member), for `Attendance.setBy`. */
  readonly setBy: MemberId;
  /** The group message that caused the change (ids only). */
  readonly sourceMessageId: MessageId;
}

export interface AttendanceWrite {
  /** A row was written (for a refused change: the stale in/maybe set to out). */
  readonly changed: boolean;
  readonly previous: AttendanceStatus | undefined;
  readonly roster: Roster;
  /**
   * The change asked for an in or maybe the plan does not allow (a minor, or
   * an unconfirmed age, on an 18+/alcohol plan; T-153). Nothing but an "out"
   * is ever written for them; `changed` says whether that happened.
   */
  readonly refused?: true;
  /** The status actually on the row now. */
  readonly status: AttendanceStatus | undefined;
}

/**
 * Who stays off this activity (SAFETY minors, §2.7, T-153): on a plan that is
 * 18+ or tagged alcohol/nightlife, every minor, and every member of unknown
 * age while the group has not confirmed everyone is 18+. On any other plan,
 * nobody. The one test the headcount fill, the roster turn and the
 * `set_attendance` tool all use.
 */
export function keptOffMembers(
  activity: Activity,
  members: readonly Member[],
  now: IsoDateTime,
  allAdultsConfirmed: boolean,
): ReadonlySet<MemberId> {
  const adultOnly =
    (activity.ageRestriction ?? 0) >= 18 || safety.isRestrictedContent(activity.contentTags);
  if (!adultOnly) return new Set();
  return new Set(
    members
      .filter((m) => safety.isMinor(m, now) || (!allAdultsConfirmed && safety.isAgeUnknown(m)))
      .map((m) => m.memberId),
  );
}

/** `keptOffMembers` with the group's own attestation read from the store. */
export function keptOffFor(
  group: GroupStore,
  activity: Activity,
  members: readonly Member[],
  now: IsoDateTime,
): ReadonlySet<MemberId> {
  const confirmed = group.groups.get(activity.groupId)?.settings.allAdultsConfirmed ?? false;
  return keptOffMembers(activity, members, now, confirmed);
}

/** Active, non-guest members in group (join) order: the member order for rosters and splits. */
export function rosterMembers(members: readonly Member[]): Member[] {
  return members.filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
}

/**
 * The roster of an activity in member order. Members without a row are in
 * none of the lists ("unanswered"); `maybe` is listed separately and counts as
 * out for booking (`bookingParty`).
 */
export function rosterOf(
  trips: Pick<GroupStore['trips'], 'listAttendance'>,
  activityId: string,
  members: readonly Member[],
  asOf: IsoDateTime,
): Roster {
  const status = new Map<MemberId, AttendanceStatus>(
    trips.listAttendance(activityId).map((r) => [r.memberId, r.status] as const),
  );
  const pick = (s: AttendanceStatus): MemberId[] =>
    rosterMembers(members)
      .map((m) => m.memberId)
      .filter((id) => status.get(id) === s);
  return {
    activityId,
    inMemberIds: pick('in'),
    outMemberIds: pick('out'),
    maybeMemberIds: pick('maybe'),
    asOf,
  };
}

/** Members with no row yet, in member order. */
export function unanswered(roster: Roster, members: readonly Member[]): MemberId[] {
  const answered = new Set([
    ...roster.inMemberIds,
    ...roster.outMemberIds,
    ...roster.maybeMemberIds,
  ]);
  return rosterMembers(members)
    .map((m) => m.memberId)
    .filter((id) => !answered.has(id));
}

export interface BookingParty {
  /** Who the tickets are for. */
  readonly attendees: readonly MemberId[];
  /** Who is charged: the attendees, with a minor's share on their guardian (`booking/payers.ts`). */
  readonly payers: readonly MemberId[];
  readonly quantity: number;
}

/**
 * Quantity, attendees and payers from one roster: the `in` members, nobody
 * else ("maybe" is out). `alreadyBooked` (members holding a confirmed ticket
 * for the activity) are left out too: a proposal after the booking is an
 * add-on for the others.
 */
export function bookingParty(
  roster: Roster,
  alreadyBooked: Iterable<MemberId> = [],
  payerRule?: PayerRule,
): BookingParty {
  const booked = new Set(alreadyBooked);
  const attendees = roster.inMemberIds.filter((id) => !booked.has(id));
  return { attendees, payers: payersFor(attendees, payerRule), quantity: attendees.length };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** True when the roster's party no longer matches who the proposal is for (quantity, attendees or payers). */
export function rosterDiverged(
  roster: Roster,
  proposal: BookingProposal,
  alreadyBooked: Iterable<MemberId> = [],
  payerRule?: PayerRule,
): boolean {
  const party = bookingParty(roster, alreadyBooked, payerRule);
  return (
    !sameSet(party.attendees, proposal.attendees) ||
    !sameSet(
      party.payers,
      proposal.payers.map((p) => p.memberId),
    ) ||
    party.quantity !== proposal.attendees.length
  );
}

/**
 * Upsert one member's attendance and write one `roster.changed` event (ids
 * and statuses only) when it actually changed. Guests and members who left are
 * refused by the caller (`requireMember`); this function trusts `setBy`.
 */
export function setAttendance(
  group: GroupStore,
  change: AttendanceChange,
  members: readonly Member[],
  now: IsoDateTime,
  activity: Activity,
): AttendanceWrite {
  const previous = group.trips
    .listAttendance(change.activityId)
    .find((r) => r.memberId === change.memberId)?.status;
  // The write choke point (T-153): an in or maybe for someone kept off this
  // plan is never written. A stale in/maybe row is set to out so the roster
  // matches the reply.
  const refused =
    change.status !== 'out' && keptOffFor(group, activity, members, now).has(change.memberId);
  const status: AttendanceStatus = refused ? 'out' : change.status;
  if (previous === status || (refused && previous === undefined)) {
    return {
      changed: false,
      previous,
      status: previous,
      roster: rosterOf(group.trips, change.activityId, members, now),
      ...(refused ? { refused: true as const } : {}),
    };
  }
  const row: Attendance = {
    activityId: change.activityId,
    memberId: change.memberId,
    status,
    updatedAt: now,
    sourceMessageId: change.sourceMessageId,
    setBy: change.setBy,
  };
  group.trips.setAttendance(row);
  group.audit.append({
    groupId: activity.groupId,
    tripId: activity.tripId,
    type: 'roster.changed',
    actor: { kind: 'member', id: change.setBy },
    visibility: 'group',
    payload: {
      activityId: change.activityId,
      changes: [{ memberId: change.memberId, status }],
      sourceMessageId: change.sourceMessageId,
    },
  });
  return {
    changed: true,
    previous,
    status,
    roster: rosterOf(group.trips, change.activityId, members, now),
    ...(refused ? { refused: true as const } : {}),
  };
}

// ---------- which activity ----------

/** The night a roll call or override names: "tonight"/"today"/"this evening", or "tomorrow"/"tmrw". */
export type RosterWhen = 'tonight' | 'tomorrow';

/**
 * Activities that are not over yet (an `endsAt` still ahead, or started less
 * than an hour ago when no end is known), earliest start first.
 */
export function upcomingActivities(activities: readonly Activity[], now: IsoDateTime): Activity[] {
  const nowMs = parseIso(now);
  const stillOn = (a: Activity): boolean =>
    a.startsAt !== undefined &&
    (a.endsAt !== undefined
      ? parseIso(a.endsAt) > nowMs
      : parseIso(a.startsAt) > nowMs - 60 * 60_000);
  return activities.filter(stillOn).sort((a, b) => parseIso(a.startsAt!) - parseIso(b.startsAt!));
}

/**
 * The activity a roll call or "I'm out" refers to: by name/venue when a hint
 * is given; else by the night the message names ("tonight", "tomorrow"),
 * with nothing planned that night ⇒ `undefined`, never the other night; else
 * tonight's activity (earliest start), else the next upcoming one. An
 * activity that is over (past `endsAt`, or an hour past its start when no
 * end is known) is never picked.
 */
export function resolveActivity(
  activities: readonly Activity[],
  tz: string,
  now: IsoDateTime,
  hint?: string,
  when?: RosterWhen,
): Activity | undefined {
  const upcoming = upcomingActivities(activities, now);
  const h = hint
    ?.trim()
    .toLowerCase()
    .replace(/\btickets?\b/g, '')
    .trim();
  if (h !== undefined && h.length > 0) {
    const words = h.split(/\s+/).filter((w) => w.length > 2);
    const match = (a: Activity): boolean => {
      const hay = `${a.name} ${a.venue ?? ''}`.toLowerCase();
      return words.length > 0 && words.every((w) => hay.includes(w));
    };
    return upcoming.find(match) ?? activities.find(match);
  }
  const tonight = nightOf(now, tz);
  const onNight = (night: string): Activity | undefined =>
    upcoming.find((a) => nightOf(a.startsAt!, tz) === night);
  if (when === 'tomorrow') return onNight(addDays(tonight, 1));
  if (when === 'tonight') return onNight(tonight);
  return onNight(tonight) ?? upcoming[0];
}

// ---------- natural language ----------

const TRAV_PREFIX = /^\s*(?:@trav\b\s*[,:]?\s*|(?:hey |hi |yo |ok |okay |yeah )?trav\s*[,:]\s*)/i;

/** The message without its "@trav" / "hey trav," prefix, whitespace collapsed, trailing punctuation dropped. */
export function stripTravPrefix(text: string): string {
  return stripInvisible(text)
    .replace(/\s+/g, ' ')
    .replace(TRAV_PREFIX, '')
    .replace(/[\s!.?]+$/u, '')
    .trim();
}

export interface RollCall {
  /** Activity name hint ("razzmatazz"), if the message named one. */
  readonly hint?: string;
  /** The night the message named ("tonight", "tomorrow"), if any. */
  readonly when?: RosterWhen;
}

const WHEN_WORDS = String.raw`tonight|tn|tonite|today|tomorrow|tmrw|this evening`;
/**
 * The time words a roll call or override may end with, with or without "for"
 * ("who's in for tonight?"); captured so "tomorrow" never means tonight.
 */
const WHEN = String.raw`(?:\s+(?:for\s+)?(?<when>${WHEN_WORDS}))?`;
/** An activity hint ("razzmatazz", "the sagrada tour"); never a bare time word, which is `when`. */
const HINT = String.raw`(?!(?:${WHEN_WORDS})\s*$)(?<hint>[\w' ]{2,40}?)`;

function whenOf(groups: Record<string, string | undefined> | undefined): RosterWhen | undefined {
  const w = groups?.['when']?.trim().toLowerCase();
  if (w === undefined || w.length === 0) return undefined;
  return w === 'tomorrow' || w === 'tmrw' ? 'tomorrow' : 'tonight';
}

const ROLL_CALL = new RegExp(
  String.raw`^(?:so\s+)?who(?:'s|s| is| are| all is| all are)\s+(?:all\s+)?(?:in|coming|going|down|up)(?:\s+(?:for|to)\s+${HINT})?${WHEN}$`,
  'i',
);

/** "@trav who's in tonight?", "who's coming to razzmatazz?", "who is going" ⇒ a roll call. */
export function detectRollCall(text: string): RollCall | undefined {
  const t = stripTravPrefix(text);
  const m = ROLL_CALL.exec(t);
  if (m === null) return undefined;
  const hint = m.groups?.['hint']?.trim();
  const when = whenOf(m.groups);
  return {
    ...(hint !== undefined && hint.length > 0 ? { hint } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

export interface RosterUpdate {
  /** 'me' for first person; else the display name as written (resolved by the caller). */
  readonly who: 'me' | string;
  readonly status: AttendanceStatus;
  readonly hint?: string;
  /** The night the message named ("tonight", "tomorrow"), if any. */
  readonly when?: RosterWhen;
}

const OUT_WORDS = String.raw`(?:sick|ill|out|not coming|not going|staying in|staying home|skipping|can't make it|cant make it|not feeling it|gonna pass|passing|done for tonight|out tonight)`;
const IN_WORDS = String.raw`(?:in|coming|going|down|up for it|keen)`;
const MAYBE_WORDS = String.raw`(?:a maybe|maybe|not sure|undecided|50\/50|on the fence)`;
const FOR = String.raw`(?:\s+(?:for|to|on)\s+${HINT})?${WHEN}`;
// A name ends with a letter, so "Henry's" splits into the name and the "'s" that follows.
const NAME = String.raw`(?<name>[\p{L}](?:[\p{L}'-]{0,29}[\p{L}])?)`;

const ME_OUT = new RegExp(String.raw`^(?:i'?m|i am|im)\s+${OUT_WORDS}${FOR}$`, 'iu');
const ME_IN = new RegExp(
  String.raw`^(?:(?:i'?m|i am|im)\s+${IN_WORDS}|count me in|i'?ll come|i'?ll be there)${FOR}$`,
  'iu',
);
const ME_MAYBE = new RegExp(String.raw`^(?:(?:i'?m|i am|im)\s+${MAYBE_WORDS}|maybe)${FOR}$`, 'iu');
const OTHER_OUT = new RegExp(
  String.raw`^${NAME}(?:'s|s| is|'?s not)\s+${OUT_WORDS}${FOR}$|^(?:count\s+)?${NAME}\s+(?:out|is out)${FOR}$`,
  'iu',
);
const OTHER_IN = new RegExp(
  String.raw`^${NAME}(?:'s| is)\s+${IN_WORDS}${FOR}$|^(?:count\s+)?${NAME}\s+in${FOR}$|^add\s+${NAME}${FOR}$`,
  'iu',
);
const OTHER_MAYBE = new RegExp(String.raw`^${NAME}(?:'s| is)\s+${MAYBE_WORDS}${FOR}$`, 'iu');
const SELF_WORDS = new Set(['i', "i'm", 'im', 'me', 'myself']);

/**
 * A whole-message roster override: "Henry's sick", "i'm out tonight", "count
 * me in", "Sam's a maybe for razzmatazz". Returns who and the new status; the
 * reason ("sick") is matched only to recognize the sentence and is not part
 * of the result. Anything longer than one such sentence is not an override.
 */
export function parseRosterUpdate(text: string): RosterUpdate | undefined {
  const t = stripTravPrefix(text);
  if (t.length === 0 || t.length > 80) return undefined;
  const pick = (
    re: RegExp,
    status: AttendanceStatus,
    who: 'me' | 'name',
  ): RosterUpdate | undefined => {
    const m = re.exec(t);
    if (m === null) return undefined;
    const hint = m.groups?.['hint']?.trim();
    const name = m.groups?.['name']?.trim();
    const when = whenOf(m.groups);
    if (who === 'name' && (name === undefined || SELF_WORDS.has(name.toLowerCase()))) {
      return undefined;
    }
    return {
      who: who === 'me' ? 'me' : name!,
      status,
      ...(hint !== undefined && hint.length > 0 ? { hint } : {}),
      ...(when !== undefined ? { when } : {}),
    };
  };
  return (
    pick(ME_OUT, 'out', 'me') ??
    pick(ME_IN, 'in', 'me') ??
    pick(ME_MAYBE, 'maybe', 'me') ??
    pick(OTHER_OUT, 'out', 'name') ??
    pick(OTHER_IN, 'in', 'name') ??
    pick(OTHER_MAYBE, 'maybe', 'name')
  );
}

// ---------- "can i get one too" (T-137) ----------

export interface TicketForMe {
  /** Activity name hint ("razzmatazz"), if the ask named one. */
  readonly hint?: string;
  /** The night the ask named ("tonight", "tomorrow"), if any. */
  readonly when?: RosterWhen;
}

const TICKET_ASK = String.raw`(?:(?:can|could|may)\s+i\s+(?:get|grab|have)|(?:can|could)\s+(?:you|u)\s+(?:get|grab|book)\s+me|(?:get|grab|book)\s+me|i'?ll\s+take|i\s+(?:want|need)|i'?d\s+(?:like|take))`;
const TICKET_WORD = String.raw`(?:one|a ticket|a tix|a spot|1)`;
/**
 * The sender asking for a ticket of their own on something the others have
 * ("can i get one too", "grab me a ticket for razz too pls"). An "in case …"
 * / "if …" tail is matched only to recognize the sentence: it often carries
 * a health reason ("in case i feel better later") and is never returned.
 * The tail is one clause (no "," or ";" inside it).
 */
const ME_TICKET = new RegExp(
  String.raw`^(?:(?:ok|okay|wait|hey|actually|pls|please)\s+)*${TICKET_ASK}\s+${TICKET_WORD}(?:\s+(?:for|to)\s+${HINT})?${WHEN}\s+(?:too|as well)(?:\s+(?:pls|plz|please))?(?:,?\s+(?:just\s+)?(?:in case|if|for later|for when)\b(?<tail>[^,;]{0,60}))?$`,
  'iu',
);
/**
 * A tail that is more than a reason (T-137 r1 #2): a second request ("and
 * book sam a vip table"), a joiner word, or a condition on who pays or how
 * it splits ("if dean pays"). Such an ask is the model's, never a card.
 */
const TAIL_NOT_A_REASON =
  /\b(?:and|also|plus|then|but|or|(?:book|get|grab|buy|add|log|split|cancel|drop|pay|paid|cover|card|charg|venmo|owe|owing|table|vip|ticket)\w*)\b|[€$£\d@]/iu;

/**
 * "@trav can i get one too in case i feel better later" ⇒ the sender wants
 * a ticket for the plan the others already have (or are about to have).
 * Returns the activity hint and night only; the reason is dropped here.
 */
export function parseTicketForMe(text: string): TicketForMe | undefined {
  const t = stripTravPrefix(text);
  if (t.length === 0 || t.length > 120) return undefined;
  const m = ME_TICKET.exec(t);
  if (m === null) return undefined;
  if (TAIL_NOT_A_REASON.test(m.groups?.['tail'] ?? '')) return undefined;
  const hint = m.groups?.['hint']?.trim();
  const when = whenOf(m.groups);
  return {
    ...(hint !== undefined && hint.length > 0 ? { hint } : {}),
    ...(when !== undefined ? { when } : {}),
  };
}

/** "Henry" (case-insensitive, one match) or a member id. */
export function resolveMemberName(members: readonly Member[], ref: string): MemberId | undefined {
  const exact = members.find((m) => m.memberId === ref);
  if (exact !== undefined) return exact.memberId;
  const lower = ref.trim().toLowerCase();
  const hits = rosterMembers(members).filter((m) => m.displayName.trim().toLowerCase() === lower);
  return hits.length === 1 ? hits[0]!.memberId : undefined;
}

// ---------- roll call ("@trav who's in tonight?") ----------

/** " tonight" for the current night, else VOICE §3.9 relative/absolute time ("tomorrow 10am", "mon mar 16 12:30am"). */
function whenPhrase(activity: Activity, tz: string, now: IsoDateTime): string {
  if (activity.startsAt === undefined) return '';
  if (nightOf(activity.startsAt, tz) === nightOf(now, tz)) return ' tonight';
  return ` ${formatTime(activity.startsAt, tz, now)}`;
}

function names(ids: readonly MemberId[], members: readonly Member[]): string {
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  return ids.map((id) => sanitizeInline(byId.get(id)?.displayName ?? id, 40)).join(', ');
}

/**
 * VOICE §3.1/§3.3 roll call, at most 4 lines: who is in, who is out, maybes
 * (flagged as out for booking) and who has not said. Never a reason.
 */
export function renderRollCall(
  activity: Activity,
  roster: Roster,
  members: readonly Member[],
  tz: string,
  now: IsoDateTime,
  /** Members a following line already says stay off this plan (T-153): not listed as "haven't said". */
  keptOff?: ReadonlySet<MemberId>,
): string {
  const label = sanitizeInline(activity.name, 40).toLowerCase();
  const lines: string[] = [];
  const inCount = roster.inMemberIds.length;
  if (inCount === 0) lines.push(`${label}${whenPhrase(activity, tz, now)}: nobody marked in yet`);
  else {
    lines.push(
      `${label}${whenPhrase(activity, tz, now)}: ${String(inCount)} in · ${names(roster.inMemberIds, members)}`,
    );
  }
  if (roster.outMemberIds.length > 0) lines.push(`out: ${names(roster.outMemberIds, members)}`);
  if (roster.maybeMemberIds.length > 0) {
    lines.push(`maybe: ${names(roster.maybeMemberIds, members)} (counts as out when i book)`);
  }
  const open = unanswered(roster, members).filter((id) => keptOff?.has(id) !== true);
  if (open.length > 0) lines.push(`haven't said: ${names(open, members)}`);
  return lines.slice(0, 4).join('\n');
}

/** One line after a roster change (VOICE §3.1), never the reason. */
export function renderAttendanceLine(
  activity: Activity,
  roster: Roster,
  members: readonly Member[],
  memberId: MemberId,
  status: AttendanceStatus,
): string {
  const who = names([memberId], members);
  const label = sanitizeInline(activity.name, 40).toLowerCase();
  const n = String(roster.inMemberIds.length);
  if (status === 'in') return `${who} is in for ${label}. that's ${n} now`;
  if (status === 'out') return `${who} is out for ${label}. that leaves ${n}`;
  return `${who} is a maybe for ${label}. maybes count as out when i book`;
}
