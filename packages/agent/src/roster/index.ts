/**
 * Activity roster (T-030; ARCHITECTURE Flow 2 step 1; SAFETY §2.5 "attendance
 * vs payers", §2.8 health). The roster is the single source of truth for who a
 * booking is for: quantity, attendees and payers all derive from the members
 * marked `in`, so they cannot diverge. "maybe" counts as out at booking time.
 *
 * The reason someone is out ("Henry's sick") is never stored: `AttendanceChange`
 * has no field for it, the audit payload carries ids and statuses only, and
 * the roll-call text never repeats it.
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
import { formatClockTime, localDate } from '@trav/core';
import { nightOf } from '../booking/proposals.js';
import { sanitizeInline } from '../context/groupContext.js';

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
  readonly changed: boolean;
  readonly previous: AttendanceStatus | undefined;
  readonly roster: Roster;
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
  /** Who is charged. Always the same list as `attendees` (SAFETY §2.5). */
  readonly payers: readonly MemberId[];
  readonly quantity: number;
}

/** Quantity, attendees and payers from one roster: the `in` members, nobody else ("maybe" is out). */
export function bookingParty(roster: Roster): BookingParty {
  const attendees = [...roster.inMemberIds];
  return { attendees, payers: [...attendees], quantity: attendees.length };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** True when the roster's `in` list no longer matches who the proposal is for (quantity, attendees or payers). */
export function rosterDiverged(roster: Roster, proposal: BookingProposal): boolean {
  const party = bookingParty(roster);
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
  if (previous === change.status) {
    return {
      changed: false,
      previous,
      roster: rosterOf(group.trips, change.activityId, members, now),
    };
  }
  const row: Attendance = {
    activityId: change.activityId,
    memberId: change.memberId,
    status: change.status,
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
      changes: [{ memberId: change.memberId, status: change.status }],
      sourceMessageId: change.sourceMessageId,
    },
  });
  return {
    changed: true,
    previous,
    roster: rosterOf(group.trips, change.activityId, members, now),
  };
}

// ---------- roll call ("@trav who's in tonight?") ----------

function whenPhrase(activity: Activity, tz: string, now: IsoDateTime): string {
  if (activity.startsAt === undefined) return '';
  if (nightOf(activity.startsAt, tz) === nightOf(now, tz)) return ' tonight';
  return ` ${localDate(activity.startsAt, tz)} ${formatClockTime(activity.startsAt, tz)}`;
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
  const open = unanswered(roster, members);
  if (open.length > 0) lines.push(`haven't said: ${names(open, members)}`);
  return lines.slice(0, 4).join('\n');
}
