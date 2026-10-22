/**
 * Pre-purchase consistency check (research/gaps.md G-02). Runs before
 * `evaluate()`; any problem means Trav asks a clarifying question instead of
 * posting a proposal card. Pure.
 */
import type { IsoDate, IsoDateTime, MemberId } from '../primitives.js';
import type { Member } from '../domain/group.js';
import type { Activity, ContentTag, Roster, Trip } from '../domain/trip.js';
import type { BookingProposal } from '../domain/booking.js';
import { localDate } from '../clock.js';
import { RESTRICTED_TAGS } from '../safety/index.js';
import { DEFAULT_APPROVAL_DEPS, isActiveMember, type ApprovalDeps } from './members.js';

export type ConsistencyProblem =
  | 'city_not_in_trip'
  | 'date_outside_trip'
  | 'quantity_not_roster'
  | 'attendee_not_member'
  | 'attendee_marked_out'
  | 'minor_on_restricted'
  | 'payers_not_attendees'
  | 'empty_roster';

export interface ConsistencyResult {
  readonly ok: boolean;
  readonly problems: readonly ConsistencyProblem[];
}

/**
 * First comma-separated segment ("Barcelona, Spain" → "Barcelona"), accents
 * stripped, case-folded, and reduced to letters and digits in any script, so
 * "São Paulo" ≈ "Sao Paulo" and "東京" ≠ "大阪".
 */
function normalizeCity(city: string): string {
  const head = city.split(',')[0] ?? city;
  return head
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Same city once normalized; a proposal city with no letters or digits can never be verified and does not match. */
function sameCity(proposalCity: string, tripCity: string): boolean {
  const a = normalizeCity(proposalCity);
  return a !== '' && a === normalizeCity(tripCity);
}

function hasRestrictedTag(tags: readonly ContentTag[]): boolean {
  return tags.some((t) => RESTRICTED_TAGS.includes(t));
}

/** Calendar date inside [start, end], all ISO dates (lexicographic order is chronological). */
function withinTrip(date: IsoDate, trip: Trip): boolean {
  return date >= trip.startDate && date <= trip.endDate;
}

/**
 * Problems, in order: empty roster/attendees; city ≠ trip city (only when the
 * proposal carries a city); event date or activity start outside the trip or
 * already past; attendee count ≠ roster "in" count; an attendee who is not an
 * active, non-guest member; an attendee not "in" on the roster (out, maybe, or
 * unanswered); a minor on an age-restricted / restricted-content / nightlife
 * item; a payer who neither attends nor guards a minor attendee.
 */
export function checkProposalConsistency(
  proposal: BookingProposal,
  trip: Trip,
  activity: Activity | null,
  roster: Roster | null,
  members: readonly Member[],
  now: IsoDateTime,
  deps: ApprovalDeps = DEFAULT_APPROVAL_DEPS,
): ConsistencyResult {
  const problems: ConsistencyProblem[] = [];
  const flag = (problem: ConsistencyProblem): void => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  const byId = new Map<MemberId, Member>(members.map((m) => [m.memberId, m]));
  const attendees = [...new Set(proposal.attendees)];
  const payerIds = [...new Set(proposal.payers.map((s) => s.memberId))];

  if (attendees.length === 0 || (roster !== null && roster.inMemberIds.length === 0)) {
    flag('empty_roster');
  }

  if (proposal.city !== undefined && !sameCity(proposal.city, trip.city)) flag('city_not_in_trip');

  const today = localDate(now, trip.timeZone);
  if (proposal.eventDate !== '') {
    if (!withinTrip(proposal.eventDate, trip) || proposal.eventDate < today) {
      flag('date_outside_trip');
    }
  }
  if (activity?.startsAt !== undefined) {
    const activityDate = localDate(activity.startsAt, trip.timeZone);
    if (!withinTrip(activityDate, trip) || activityDate < today) flag('date_outside_trip');
  }

  if (roster !== null) {
    if (attendees.length !== roster.inMemberIds.length) flag('quantity_not_roster');
    if (attendees.some((id) => !roster.inMemberIds.includes(id))) flag('attendee_marked_out');
  }

  const validMember = (id: MemberId): Member | undefined => {
    const m = byId.get(id);
    return m !== undefined && isActiveMember(m) && m.role !== 'guest' ? m : undefined;
  };
  if (attendees.some((id) => validMember(id) === undefined)) flag('attendee_not_member');

  const restricted =
    proposal.ageRestriction !== null ||
    hasRestrictedTag(proposal.contentTags) ||
    activity?.kind === 'nightlife' ||
    (activity !== null &&
      (activity.ageRestriction !== null || hasRestrictedTag(activity.contentTags)));
  const participants = [...new Set([...attendees, ...payerIds])];
  const minorIds = new Set(
    participants.filter((id) => {
      const m = byId.get(id);
      return m !== undefined && deps.isMinor(m, now);
    }),
  );
  if (restricted && minorIds.size > 0) flag('minor_on_restricted');

  const guardians = new Set(
    attendees
      .filter((id) => minorIds.has(id))
      .map((id) => byId.get(id)?.guardianMemberId)
      .filter((id): id is MemberId => id !== undefined),
  );
  if (payerIds.some((id) => !attendees.includes(id) && !guardians.has(id))) {
    flag('payers_not_attendees');
  }

  return { ok: problems.length === 0, problems };
}
