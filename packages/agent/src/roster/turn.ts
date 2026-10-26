/**
 * The roster turn (T-030): "@trav who's in tonight?" and whole-message
 * overrides ("Henry's sick", "i'm out tonight", "count me in", "Sam's a
 * maybe for razzmatazz") are answered deterministically, never by the model.
 * The loop calls `handleRosterMessage` once the message is addressed to Trav
 * and the sender is a member; `undefined` means "not a roster message" and
 * the turn continues as usual.
 *
 * Conservative by design: an unknown name, or a named activity that is not on
 * the plan, is not treated as a roster message (the model, or silence, takes
 * it), so "@trav Sam is going to be late" never writes a row. The reason a
 * member is out is matched only to recognize the sentence and is dropped
 * before anything is written (`parseRosterUpdate` returns ids and statuses).
 */
import type {
  Activity,
  AttendanceStatus,
  GroupStore,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Trip,
} from '@trav/core';
import type { RosterChangeNotice } from '../approval/events.js';
import { sanitizeInline } from '../context/groupContext.js';
import {
  detectRollCall,
  parseRosterUpdate,
  renderAttendanceLine,
  renderRollCall,
  resolveActivity,
  resolveMemberName,
  rosterOf,
  setAttendance,
} from './index.js';

export interface RosterTurnInput {
  readonly group: GroupStore;
  readonly trip: Trip;
  readonly members: readonly Member[];
  /** The channel-resolved sender (an active, non-guest member). */
  readonly me: Member;
  readonly text: string;
  readonly messageId: MessageId;
  readonly now: IsoDateTime;
}

export type RosterTurn =
  | { readonly kind: 'roll_call'; readonly activity: Activity; readonly text: string }
  | {
      readonly kind: 'changed';
      readonly activity: Activity;
      readonly memberId: MemberId;
      readonly status: AttendanceStatus;
      readonly text: string;
      /** For `ApprovalHandler.rosterChanged`: ids and statuses only. */
      readonly notice: RosterChangeNotice;
    }
  | {
      readonly kind: 'unchanged';
      readonly activity: Activity;
      readonly memberId: MemberId;
      readonly status: AttendanceStatus;
      readonly text: string;
    }
  | { readonly kind: 'no_activity'; readonly text: string };

export function handleRosterMessage(input: RosterTurnInput): RosterTurn | undefined {
  const { group, trip, members, me, text, messageId, now } = input;
  const roll = detectRollCall(text);
  const update = roll === undefined ? parseRosterUpdate(text) : undefined;
  if (roll === undefined && update === undefined) return undefined;

  const hint = roll?.hint ?? update?.hint;
  const when = roll?.when ?? update?.when;
  const activity = resolveActivity(
    group.trips.listActivities(trip.tripId),
    trip.timeZone,
    now,
    hint,
    when,
  );
  if (activity === undefined) {
    // A named activity that is not on the plan is not ours to answer.
    if (hint !== undefined) return undefined;
    // "Henry's sick" / "Maya is out tomorrow" with nothing planned that
    // night: nothing to mark them out of, and never some other night's roster.
    if (update !== undefined && update.who !== 'me') return undefined;
    return { kind: 'no_activity', text: `nothing on the plan for ${when ?? 'tonight'} yet` };
  }

  if (roll !== undefined) {
    const roster = rosterOf(group.trips, activity.activityId, members, now);
    return {
      kind: 'roll_call',
      activity,
      text: renderRollCall(activity, roster, members, trip.timeZone, now),
    };
  }

  const memberId = update!.who === 'me' ? me.memberId : resolveMemberName(members, update!.who);
  if (memberId === undefined) return undefined;
  const status = update!.status;
  const write = setAttendance(
    group,
    {
      activityId: activity.activityId,
      memberId,
      status,
      setBy: me.memberId,
      sourceMessageId: messageId,
    },
    members,
    now,
    activity,
  );
  if (!write.changed) {
    const who = sanitizeInline(
      members.find((m) => m.memberId === memberId)?.displayName ?? memberId,
      40,
    );
    const label = sanitizeInline(activity.name, 40).toLowerCase();
    const state = status === 'maybe' ? 'a maybe' : status;
    return {
      kind: 'unchanged',
      activity,
      memberId,
      status,
      text: `${who} is already ${state} for ${label}. that's ${String(write.roster.inMemberIds.length)} in`,
    };
  }
  return {
    kind: 'changed',
    activity,
    memberId,
    status,
    text: renderAttendanceLine(activity, write.roster, members, memberId, status),
    notice: {
      groupId: activity.groupId,
      activityId: activity.activityId,
      changes: [{ memberId, status }],
      by: me.memberId,
      messageId,
    },
  };
}
