/**
 * The roster turn (T-030): "@trav who's in tonight?" and whole-message
 * overrides ("Henry's sick", "i'm out tonight", "count me in", "Crowley's a
 * maybe for razzmatazz") are answered deterministically, never by the model.
 * The loop calls `handleRosterMessage` once the message is addressed to Trav
 * and the sender is a member; `undefined` means "not a roster message" and
 * the turn continues as usual.
 *
 * Conservative by design: an unknown name, or a named activity that is not on
 * the plan, is not treated as a roster message (the model, or silence, takes
 * it), so "@trav Crowley is going to be late" never writes a row. The reason a
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
import { addDays } from '@trav/core';
import type { RosterChangeNotice } from '../approval/events.js';
import { bookedAttendees, nightOf } from '../booking/proposals.js';
import { sanitizeInline } from '../context/groupContext.js';
import { keptOffLine, parseCombinedRoster, planParty, type CombinedRoster } from './combined.js';
import {
  detectRollCall,
  keptOffFor,
  otherAdultPlansTonight,
  parseRosterUpdate,
  parseTicketForMe,
  renderAttendanceLine,
  renderRollCall,
  resolveActivity,
  resolveMemberName,
  rosterLabel,
  rosterOf,
  type RosterUpdate,
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
  /**
   * T-183 (D-047): the model's read of the message (`update_attendance`,
   * through `interpret/validate.ts`: a current, non-guest member, a status,
   * a plan name and night, never a reason). Used instead of the reader;
   * `text` is then not parsed at all.
   */
  readonly interpreted?: RosterUpdate;
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
      /**
       * The headcount disagrees with the named roster: one question, nothing
       * written, except a kept-off minor's stale in/maybe set to out (T-153,
       * `notice` is then set).
       */
      readonly kind: 'clarify';
      readonly activity: Activity;
      readonly text: string;
      readonly notice?: RosterChangeNotice;
    }
  | {
      /**
       * A minor named in (or a maybe) on an 18+ or alcohol plan (T-153,
       * SAFETY minors): no in or maybe is written, one "stays off" line. A
       * stale in/maybe row is set to out (`notice` is then set).
       */
      readonly kind: 'kept_off';
      readonly activity: Activity;
      readonly memberIds: readonly MemberId[];
      readonly text: string;
      readonly notice?: RosterChangeNotice;
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
  const interpreted = input.interpreted;
  if (input.expectInCount === undefined && interpreted === undefined) {
    const combined = parseCombinedRoster(text);
    if (combined !== undefined) return handleCombined(input, combined);
  }
  // T-183: a model read (already validated) replaces the reader; every rule
  // below (which plan, minors kept off, the headcount check) still applies.
  const roll = interpreted === undefined ? detectRollCall(text) : undefined;
  const parsed =
    interpreted !== undefined
      ? interpreted
      : roll === undefined
        ? parseRosterUpdate(text)
        : undefined;
  // "can i get one too" (T-137) is the sender's own "i'm in" for a plan the
  // others already have: the same write, then a separate add-on card.
  const ticket =
    roll === undefined &&
    parsed === undefined &&
    input.expectInCount === undefined &&
    interpreted === undefined
      ? parseTicketForMe(text)
      : undefined;
  const update: RosterUpdate | undefined =
    parsed ?? (ticket !== undefined ? { who: 'me', status: 'in', ...ticket } : undefined);
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
  if (ticket !== undefined) {
    // "one too" needs something the others have; otherwise the ask is the model's.
    if (activity === undefined) return undefined;
    const held = ticketHeld(input, activity);
    if (held === 'none') return undefined;
    if (held !== 'no') return held;
  }
  if (activity === undefined) {
    // A named activity that is not on the plan is not ours to answer.
    if (hint !== undefined) return undefined;
    // "Henry's sick" / "Chase is out tomorrow" with nothing planned that
    // night: nothing to mark them out of, and never some other night's roster.
    if (update !== undefined && update.who !== 'me') return undefined;
    return { kind: 'no_activity', text: `nothing on the plan for ${when ?? 'tonight'} yet` };
  }

  if (roll !== undefined) {
    const roster = rosterOf(group.trips, activity.activityId, members, now);
    // Never asks a member kept off an adult-only plan to answer (T-153).
    const call = renderRollCall(
      activity,
      roster,
      members,
      trip.timeZone,
      now,
      keptOffFor(group, activity, members, now),
      rosterLabel(group, activity, members, now),
    );
    // "who's in tonight?" in a family group with two adult-only plans that
    // night: one more line says the other exists (T-154 r1 #1), within the
    // 4-line roll call (VOICE §3.3).
    const others = hint === undefined ? otherAdultPlansTonight(group, activity, members, now) : [];
    const also =
      others.length === 0
        ? undefined
        : `also ${nightOf(activity.startsAt!, trip.timeZone) === nightOf(now, trip.timeZone) ? 'tonight' : 'that night'}: ${others.map((a) => rosterLabel(group, a, members, now)).join(', ')}`;
    return {
      kind: 'roll_call',
      activity,
      text: also === undefined ? call : withAlso(call, also),
    };
  }

  const memberId = update!.who === 'me' ? me.memberId : resolveMemberName(members, update!.who);
  if (memberId === undefined) return undefined;
  const status = update!.status;
  // "@trav crowley is in" for an adult-only plan with Crowley under 18: no in or
  // maybe is written, whatever the headcount tail says. "out" is always fine.
  const keptOff = keptOffFor(group, activity, members, now);
  if (status !== 'out' && keptOff.has(memberId)) {
    const outs = keepOff(input, activity, [{ memberId, status }]);
    const inCount = rosterOf(group.trips, activity.activityId, members, now).inMemberIds.filter(
      (id) => !keptOff.has(id),
    ).length;
    return {
      kind: 'kept_off',
      activity,
      memberIds: [memberId],
      text: `${keptOffLine([memberId], members)}. that's ${String(inCount)} in`,
      ...(outs.length > 0 ? { notice: noticeOf(input, activity, outs) } : {}),
    };
  }
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
  if (!write.changed && ticket !== undefined && write.status === 'in') {
    // Already marked in but holding no ticket and on no card (the booking left
    // them off): "can i get one too" still asks for their own add-on.
    return {
      kind: 'changed',
      activity,
      memberId,
      status,
      text: renderAttendanceLine(
        activity,
        write.roster,
        members,
        memberId,
        status,
        rosterLabel(group, activity, members, now),
      ),
      notice: {
        groupId: activity.groupId,
        activityId: activity.activityId,
        changes: [{ memberId, status }],
        by: me.memberId,
        messageId,
      },
    };
  }
  if (!write.changed) {
    const who = sanitizeInline(
      members.find((m) => m.memberId === memberId)?.displayName ?? memberId,
      40,
    );
    const label = rosterLabel(group, activity, members, now);
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
    text: renderAttendanceLine(
      activity,
      write.roster,
      members,
      memberId,
      status,
      rosterLabel(group, activity, members, now),
    ),
    notice: {
      groupId: activity.groupId,
      activityId: activity.activityId,
      changes: [{ memberId, status }],
      by: me.memberId,
      messageId,
    },
  };
}

type Row = { readonly memberId: MemberId; readonly status: AttendanceStatus };

/**
 * For "can i get one too" (T-137): `none` when nothing on this plan is booked
 * or waiting (not a roster message), `no` when the sender holds no ticket and
 * is on no pending card (go on: write them in, the add-on follows), else the
 * one line that says they already have one.
 */
/**
 * The roll call plus the "also tonight" line inside the 4-line cap (VOICE §3.3):
 * the maybe line gives way first, so "haven't said" (the nudge) always stays
 * (T-154 r2 review #1).
 */
export function withAlso(call: string, also: string): string {
  let lines = call.split('\n');
  if (lines.length >= 4) lines = lines.filter((l) => !l.startsWith('maybe:'));
  return [...lines.slice(0, 3), also].join('\n');
}

function ticketHeld(input: RosterTurnInput, activity: Activity): RosterTurn | 'none' | 'no' {
  const { group, trip, me } = input;
  const booked = bookedAttendees(group, trip, activity.activityId);
  const pending = group.bookings
    .listPendingProposals(activity.groupId)
    .filter((p) => p.activityId === activity.activityId);
  if (booked.size === 0 && pending.length === 0) return 'none';
  const label = rosterLabel(group, activity, input.members, input.now);
  const name = sanitizeInline(me.displayName, 40);
  const card = label.startsWith('the ') ? label : `the ${label}`;
  const base = { kind: 'unchanged', activity, memberId: me.memberId, status: 'in' } as const;
  if (booked.has(me.memberId)) {
    return { ...base, text: `you've already got a ticket for ${label}, ${name}` };
  }
  if (pending.some((p) => p.attendees.includes(me.memberId))) {
    return { ...base, text: `you're already on ${card} card, ${name}` };
  }
  return 'no';
}

/**
 * Refused in/maybe changes go through `setAttendance`, which writes nothing
 * for them except an "out" over a stale in/maybe row (T-153). Returns the
 * rows that were written (all "out").
 */
function keepOff(input: RosterTurnInput, activity: Activity, refused: readonly Row[]): Row[] {
  const written: Row[] = [];
  for (const c of refused) {
    const write = setAttendance(
      input.group,
      {
        activityId: activity.activityId,
        memberId: c.memberId,
        status: c.status,
        setBy: input.me.memberId,
        sourceMessageId: input.messageId,
      },
      input.members,
      input.now,
      activity,
    );
    if (write.changed && write.status !== undefined) {
      written.push({ memberId: c.memberId, status: write.status });
    }
  }
  return written;
}

function noticeOf(
  input: RosterTurnInput,
  activity: Activity,
  changes: readonly Row[],
): RosterChangeNotice {
  return {
    groupId: activity.groupId,
    activityId: activity.activityId,
    changes,
    by: input.me.memberId,
    messageId: input.messageId,
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

  // A headcount never fills a minor into an 18+ or alcohol plan, and naming
  // one in ("5 of us, crowley's in") writes no in or maybe for them (SAFETY
  // minors, T-153). A stale in/maybe row of theirs is set to out first, so
  // the count and the reply agree.
  const noFill = keptOffFor(group, activity, members, now);
  const refused = changes.filter((c) => c.status !== 'out' && noFill.has(c.memberId));
  const outs = keepOff(input, activity, refused);
  const roster = rosterOf(group.trips, activity.activityId, members, now);
  const plan = planParty({
    members,
    roster,
    changes: changes.filter((c) => !refused.includes(c)),
    ...(parsed.count !== undefined ? { count: parsed.count } : {}),
    all: parsed.all,
    noFill,
    refused: new Set(refused.map((c) => c.memberId)),
  });
  // The refused minors the plan's line does not already name get one line.
  const stillUnsaid = refused
    .map((c) => c.memberId)
    .filter((id) => plan.kind !== 'mismatch' || plan.keptOff?.includes(id) !== true);
  const keptOff = stillUnsaid.length > 0 ? `\n${keptOffLine(stillUnsaid, members)}` : '';
  if (plan.kind === 'mismatch') {
    return {
      kind: 'clarify',
      activity,
      text: `${plan.text}${keptOff}`,
      ...(outs.length > 0 ? { notice: noticeOf(input, activity, outs) } : {}),
    };
  }

  const changed: Row[] = [...outs];
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
    if (write.changed && write.status !== undefined) {
      changed.push({ memberId: row.memberId, status: write.status });
    }
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
    text: `${renderRollCall(activity, after, members, tz, now, new Set(stillUnsaid), rosterLabel(group, activity, members, now))}${keptOff}`,
    ...(changed.length > 0 ? { notice: noticeOf(input, activity, changed) } : {}),
    ...(venue !== undefined ? { venue } : {}),
  };
}
