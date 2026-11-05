/**
 * `get_roster` and `set_attendance` ("who's in tonight"). The roster is the
 * single source of truth for booking quantity and split participants; the
 * reason someone is out is never stored (SAFETY §2.8 health).
 */
import type { Activity, AttendanceStatus, MemberId } from '@trav/core';
import { TravError } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import { keptOffLine } from '../roster/combined.js';
import { keptOffFor, setAttendance } from '../roster/index.js';
import type { ToolContext, ToolDefinition } from './registry.js';
import {
  activeMembers,
  asRecord,
  messageIdOf,
  nameOf,
  optEnum,
  optString,
  reqString,
  requireMember,
  requireTrip,
  resolveMemberRef,
} from './shared.js';

export interface RosterView {
  readonly activityId: string;
  readonly name: string;
  readonly kind: string;
  readonly startsAt: string | null;
  readonly in: readonly { readonly memberId: MemberId; readonly name: string }[];
  readonly out: readonly { readonly memberId: MemberId; readonly name: string }[];
  readonly maybe: readonly { readonly memberId: MemberId; readonly name: string }[];
  readonly unanswered: readonly { readonly memberId: MemberId; readonly name: string }[];
}

export function rosterView(ctx: ToolContext, activity: Activity): RosterView {
  const members = activeMembers(ctx);
  const rows = ctx.stores.group.trips.listAttendance(activity.activityId);
  const status = new Map(rows.map((r) => [r.memberId, r.status] as const));
  const pick = (s: AttendanceStatus | undefined) =>
    members
      .filter((m) => status.get(m.memberId) === s)
      .map((m) => ({ memberId: m.memberId, name: sanitizeInline(m.displayName, 40) }));
  return {
    activityId: activity.activityId,
    name: sanitizeInline(activity.name, 80),
    kind: activity.kind,
    startsAt: activity.startsAt ?? null,
    in: pick('in'),
    out: pick('out'),
    maybe: pick('maybe'),
    unanswered: pick(undefined),
  };
}

export const getRosterTool: ToolDefinition<
  { readonly activityId?: string },
  { readonly rosters: readonly RosterView[] }
> = {
  name: 'get_roster',
  description:
    "Who is in, out, maybe or unanswered for one activity (activityId) or for every planned activity on the trip. Use before booking: quantity and the split both come from who is 'in'.",
  inputSchema: {
    type: 'object',
    properties: { activityId: { type: 'string' } },
    additionalProperties: false,
  },
  parse(raw) {
    const id = optString(asRecord(raw), 'activityId', 80);
    return id === undefined ? {} : { activityId: id };
  },
  async handler(input, ctx) {
    const trip = requireTrip(ctx);
    const trips = ctx.stores.group.trips;
    const activities =
      input.activityId === undefined
        ? trips.listActivities(trip.tripId)
        : [trips.getActivity(input.activityId)].filter(
            (a): a is Activity => a !== undefined && a.tripId === trip.tripId,
          );
    if (input.activityId !== undefined && activities.length === 0) {
      throw new TravError('not_found', `no activity ${input.activityId} on this trip`);
    }
    return { rosters: activities.map((a) => rosterView(ctx, a)) };
  },
};

export interface SetAttendanceInput {
  readonly activityId: string;
  readonly member: string;
  readonly status: AttendanceStatus;
}

export const setAttendanceTool: ToolDefinition<
  SetAttendanceInput,
  {
    /** `kept_off`: the member can't be in or a maybe for this plan; nothing but an out was written. */
    readonly kind: 'attendance_set' | 'kept_off';
    readonly roster: RosterView;
    readonly text: string;
  }
> = {
  name: 'set_attendance',
  description:
    "Mark a member in, out or maybe for an activity ('Henry's sick' ⇒ out; 'maybe' counts as out at booking time). Only members may change the roster. Never pass the reason; it is not stored. One call per member. kind 'kept_off' means that member stays off this plan: say the returned line, never why.",
  inputSchema: {
    type: 'object',
    properties: {
      activityId: { type: 'string' },
      member: { type: 'string', description: 'member id or display name' },
      status: { type: 'string', enum: ['in', 'out', 'maybe'] },
    },
    required: ['activityId', 'member', 'status'],
    additionalProperties: false,
  },
  parse(raw) {
    const r = asRecord(raw);
    const status = optEnum(r, 'status', ['in', 'out', 'maybe'] as const);
    if (status === undefined) throw new TravError('invalid_argument', 'status is required');
    return {
      activityId: reqString(r, 'activityId', 80),
      member: reqString(r, 'member', 80),
      status,
    };
  },
  async handler(input, ctx) {
    const me = requireMember(ctx);
    const trip = requireTrip(ctx);
    const activity = ctx.stores.group.trips.getActivity(input.activityId);
    if (activity === undefined || activity.tripId !== trip.tripId) {
      throw new TravError('not_found', `no activity ${input.activityId} on this trip`);
    }
    const members = activeMembers(ctx);
    const memberId = resolveMemberRef(members, input.member);
    if (memberId === undefined)
      throw new TravError('not_found', `no member "${input.member}" on this trip`);
    // One write path (`roster/index.ts` `setAttendance`): an in or maybe for
    // a member kept off an 18+/alcohol plan is never written (T-153); a stale
    // in/maybe of theirs is set to out. One audited event per real change.
    const write = setAttendance(
      ctx.stores.group,
      {
        activityId: activity.activityId,
        memberId,
        status: input.status,
        setBy: me.memberId,
        sourceMessageId: messageIdOf(ctx),
      },
      members,
      ctx.now,
      activity,
    );
    const roster = rosterView(ctx, activity);
    if (write.refused === true) {
      const keptOff = keptOffFor(ctx.stores.group, activity, members, ctx.now);
      const inCount = roster.in.filter((m) => !keptOff.has(m.memberId)).length;
      return {
        kind: 'kept_off',
        roster,
        text: `${keptOffLine([memberId], members)}. that's ${String(inCount)} in`,
      };
    }
    const who = nameOf(members, memberId);
    const label = sanitizeInline(activity.name, 40).toLowerCase();
    const text =
      input.status === 'in'
        ? `${who} is in for ${label}. that's ${roster.in.length} now`
        : input.status === 'out'
          ? `${who} is out for ${label}. that leaves ${roster.in.length}`
          : `${who} is a maybe for ${label}. maybes count as out when i book`;
    return { kind: 'attendance_set', roster, text };
  },
};
