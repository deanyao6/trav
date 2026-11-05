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
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  Trip,
} from '@trav/core';
import { addDays, safety } from '@trav/core';
import type { RosterChangeNotice } from '../approval/events.js';
import { nightOf } from '../booking/proposals.js';
import { sanitizeInline } from '../context/groupContext.js';
import { parseCombinedRoster, planParty, type CombinedRoster } from './combined.js';
import {
  detectRollCall,
  parseRosterUpdate,
  renderAttendanceLine,
  renderRollCall,
  resolveActivity,
  resolveMemberName,
  rosterOf,
  setAttendance,
  upcomingActivities,
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
  /**
   * The headcount the message asked for ("henry's in, make it 7" ⇒ 7, T-066).
   * When set, only an attendance update whose resulting in-count equals it is
   * handled; anything else (a mismatch, a roll call, nothing on the plan)
   * returns `undefined` before any write, and the loop sends the whole
   * message to the model.
   */
  readonly expectInCount?: number;
  /**
   * Whether a place named in a combined sentence (T-082) is a known venue
   * (`isKnownPlace` over the ticket inventory). A place that is not on the
   * plan and not known (or with no predicate) makes the message not a
   * combined roster sentence: the member's words could be a reason, and
   * they are never searched for or echoed.
   */
  readonly isKnownPlace?: (hint: string) => boolean;
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
  | {
      /**
       * A combined sentence (T-082): headcount + named changes (+ a place).
       * `changes` are the rows that actually changed; `notice` is set when
       * any did. `venue` is a place the message named that is not this
       * night's plan: the loop checks it with `search_events` and adds one
       * line (`renderVenueCheck`).
       */
      readonly kind: 'party';
      readonly activity: Activity;
      readonly changes: readonly {
        readonly memberId: MemberId;
        readonly status: AttendanceStatus;
      }[];
      readonly text: string;
      readonly notice?: RosterChangeNotice;
      readonly venue?: VenueAsk;
    }
  | {
      /** The headcount disagrees with the named roster: one question, nothing written. */
      readonly kind: 'clarify';
      readonly activity: Activity;
      readonly text: string;
    }
  | { readonly kind: 'no_activity'; readonly text: string };

/** A place named in a combined sentence that is not on the plan for that night. */
export interface VenueAsk {
  /** The place as written (a plain 1-3 word name, never a reason). */
  readonly query: string;
  readonly night: IsoDate;
  readonly quantity: number;
}

export function handleRosterMessage(input: RosterTurnInput): RosterTurn | undefined {
  const { group, trip, members, me, text, messageId, now } = input;
  if (input.expectInCount === undefined) {
    const combined = parseCombinedRoster(text);
    if (combined !== undefined) return handleCombined(input, combined);
  }
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
  if (
    input.expectInCount !== undefined &&
    activity === undefined &&
    roll === undefined &&
    hint === undefined &&
    when !== undefined
  ) {
    // A "make it N" tail ("henry's in tonight, make it 6") with nothing
    // planned tonight: say there is nothing to count them against. Nothing is written, never another night's roster.
    return { kind: 'no_activity', text: `nothing on the plan for ${when} yet` };
  }
  if (input.expectInCount !== undefined && (roll !== undefined || activity === undefined)) {
    return undefined;
  }
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
  if (input.expectInCount !== undefined) {
    const inIds = new Set(rosterOf(group.trips, activity.activityId, members, now).inMemberIds);
    if (status === 'in') inIds.add(memberId);
    else inIds.delete(memberId);
    if (inIds.size !== input.expectInCount) return undefined;
  }
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

/**
 * "@trav it's the 5 of us tonight, henry's out" / "all 6, henry's back.
 * razzmatazz" (T-082). The activity is the named one when it is on the plan
 * and not over, else that night's plan (tonight unless the message says
 * tomorrow), never another night. An unknown name ⇒ undefined (not ours).
 */
function handleCombined(input: RosterTurnInput, parsed: CombinedRoster): RosterTurn | undefined {
  const { group, trip, members, me, messageId, now } = input;
  const changes: { memberId: MemberId; status: AttendanceStatus }[] = [];
  for (const c of parsed.changes) {
    const memberId = c.who === 'me' ? me.memberId : resolveMemberName(members, c.who);
    if (memberId === undefined) return undefined;
    const seen = changes.find((x) => x.memberId === memberId);
    if (seen !== undefined && seen.status !== c.status) return undefined;
    if (seen === undefined) changes.push({ memberId, status: c.status });
  }
  // A "place" that is a member's name ("5 of us, henry") is not a place.
  if (parsed.hint !== undefined && resolveMemberName(members, parsed.hint) !== undefined) {
    return undefined;
  }

  const when = parsed.when ?? 'tonight';
  const activities = group.trips.listActivities(trip.tripId);
  const tz = trip.timeZone;
  const tonight = nightOf(now, tz);
  const night = when === 'tomorrow' ? addDays(tonight, 1) : tonight;
  const named =
    parsed.hint === undefined
      ? undefined
      : resolveActivity(upcomingActivities(activities, now), tz, now, parsed.hint);
  // Named and on the plan, but not on the night the message says: not ours.
  if (named !== undefined && parsed.when !== undefined && nightOf(named.startsAt!, tz) !== night) {
    return undefined;
  }
  // Not on the plan: searched and named back only when it is a known venue.
  if (
    parsed.hint !== undefined &&
    named === undefined &&
    input.isKnownPlace?.(parsed.hint) !== true
  ) {
    return undefined;
  }
  const activity = named ?? resolveActivity(activities, tz, now, undefined, when);
  if (activity === undefined) {
    return { kind: 'no_activity', text: `nothing on the plan for ${when} yet` };
  }

  const roster = rosterOf(group.trips, activity.activityId, members, now);
  // A headcount never fills a minor into an 18+ or alcohol plan (SAFETY minors).
  const adultOnly =
    (activity.ageRestriction ?? 0) >= 18 || safety.isRestrictedContent(activity.contentTags);
  const noFill = new Set(
    adultOnly ? members.filter((m) => safety.isMinor(m, now)).map((m) => m.memberId) : [],
  );
  const plan = planParty({
    members,
    roster,
    changes,
    ...(parsed.count !== undefined ? { count: parsed.count } : {}),
    all: parsed.all,
    noFill,
  });
  if (plan.kind === 'mismatch') return { kind: 'clarify', activity, text: plan.text };

  const changed: { memberId: MemberId; status: AttendanceStatus }[] = [];
  let after = roster;
  for (const row of plan.rows) {
    const write = setAttendance(
      group,
      {
        activityId: activity.activityId,
        memberId: row.memberId,
        status: row.status,
        setBy: me.memberId,
        sourceMessageId: messageId,
      },
      members,
      now,
      activity,
    );
    after = write.roster;
    if (write.changed) changed.push(row);
  }
  const venue: VenueAsk | undefined =
    parsed.hint !== undefined && named === undefined
      ? {
          query: parsed.hint,
          night: nightOf(activity.startsAt!, tz),
          quantity: Math.max(1, after.inMemberIds.length),
        }
      : undefined;
  return {
    kind: 'party',
    activity,
    changes: changed,
    text: renderRollCall(activity, after, members, tz, now),
    ...(changed.length > 0
      ? {
          notice: {
            groupId: activity.groupId,
            activityId: activity.activityId,
            changes: changed,
            by: me.memberId,
            messageId,
          },
        }
      : {}),
    ...(venue !== undefined ? { venue } : {}),
  };
}
