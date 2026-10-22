/**
 * Builders for approval/audit tests: a Barcelona-shaped group (Dean, Sam, Ava,
 * Maya, Leo, Henry; a minor "Kid" under Dean; a guest "Stranger"), the
 * Razzmatazz proposal and the default policy. Fictional data only.
 */
import type { IsoDateTime, MemberId } from '../primitives.js';
import type { Member } from '../domain/group.js';
import type { Activity, Roster, Trip } from '../domain/trip.js';
import type { BookingProposal } from '../domain/booking.js';
import type {
  ApprovalSignature,
  GroupSpendingPolicy,
  MemberView,
  PolicyContext,
} from '../domain/approval.js';
import { defaultSpendingPolicy } from '../domain/approval.js';
import type { ApprovalDeps } from './members.js';
import { toMemberViews } from './members.js';

export const NOW: IsoDateTime = '2026-03-14T21:40:00+01:00';
export const GROUP = 'grp_barcelona';
export const TRIP = 'trip_barcelona';
export const ACTIVITY = 'act_razzmatazz';

/** Age from `ageBand` only, so tests never depend on T-028's date arithmetic. */
export const ageBandDeps: ApprovalDeps = {
  isMinor: (m) => m.ageBand === 'under18',
};

export const FIVE: readonly MemberId[] = ['mem_dean', 'mem_sam', 'mem_ava', 'mem_maya', 'mem_leo'];

export function member(id: string, overrides: Partial<Member> = {}): Member {
  const name = id.replace(/^mem_/, '');
  return {
    memberId: id,
    groupId: GROUP,
    displayName: name[0]?.toUpperCase() + name.slice(1),
    role: 'member',
    active: true,
    senderId: `sim:${name}`,
    ageBand: 'adult',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

export function barcelonaMembers(): Member[] {
  return [
    member('mem_dean', { role: 'lead' }),
    member('mem_sam'),
    member('mem_ava'),
    member('mem_maya'),
    member('mem_leo'),
    member('mem_henry'),
    member('mem_kid', { ageBand: 'under18', guardianMemberId: 'mem_dean' }),
    member('mem_stranger', { role: 'guest' }),
    member('mem_gone', { active: false, leftAt: '2026-03-01T00:00:00Z' }),
  ];
}

export function views(members: readonly Member[] = barcelonaMembers()): readonly MemberView[] {
  return toMemberViews(members, NOW, ageBandDeps);
}

export function policy(overrides: Partial<GroupSpendingPolicy> = {}): GroupSpendingPolicy {
  return { ...defaultSpendingPolicy(GROUP, 'EUR'), ...overrides };
}

export function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: NOW,
    members: views(),
    prefs: {},
    spentTodayMinor: 0,
    spentTripMinor: 0,
    existingBookingForKey: null,
    ...overrides,
  };
}

export function equalShares(ids: readonly MemberId[], shareMinor: number) {
  return ids.map((memberId) => ({ memberId, shareMinor }));
}

/** 5 Razzmatazz tickets at €18 = €90.00, Henry out, charged to Dean's card. */
export function razzmatazz(overrides: Partial<BookingProposal> = {}): BookingProposal {
  return {
    proposalId: 'prop_razz',
    groupId: GROUP,
    tripId: TRIP,
    activityId: ACTIVITY,
    kind: 'ticket',
    provider: 'mock-tickets',
    itemRef: 'evt_razzmatazz_0314',
    description: 'Razzmatazz, sat mar 14, 5 tickets',
    city: 'Barcelona',
    totalMinor: 9000,
    currency: 'EUR',
    quotedAt: '2026-03-14T21:38:00+01:00',
    quoteRef: 'q_razz_1',
    payers: equalShares(FIVE, 1800),
    attendees: [...FIVE],
    paidBy: { kind: 'member_card', memberId: 'mem_dean' },
    refundable: true,
    eventDate: '2026-03-14',
    ageRestriction: 18,
    contentTags: ['nightlife', 'club'],
    requestedBy: 'mem_dean',
    requestedAt: '2026-03-14T21:39:00+01:00',
    sourceMessageId: 'msg_razz_req',
    idempotencyKey: 'k_razz',
    status: 'pending',
    ...overrides,
  };
}

export function barcelonaTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    tripId: TRIP,
    groupId: GROUP,
    name: 'Barcelona',
    city: 'Barcelona',
    countryCode: 'ES',
    timeZone: 'Europe/Madrid',
    startDate: '2026-03-12',
    endDate: '2026-03-16',
    currency: 'EUR',
    status: 'active',
    familyTab: false,
    createdBy: 'mem_dean',
    createdAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

export function razzmatazzActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    activityId: ACTIVITY,
    tripId: TRIP,
    groupId: GROUP,
    kind: 'nightlife',
    name: 'Razzmatazz',
    startsAt: '2026-03-14T23:30:00+01:00',
    contentTags: ['nightlife', 'club'],
    ageRestriction: 18,
    createdAt: '2026-03-14T20:00:00+01:00',
    ...overrides,
  };
}

export function razzmatazzRoster(overrides: Partial<Roster> = {}): Roster {
  return {
    activityId: ACTIVITY,
    inMemberIds: [...FIVE],
    outMemberIds: ['mem_henry'],
    maybeMemberIds: [],
    asOf: NOW,
    ...overrides,
  };
}

export function signature(
  memberId: MemberId,
  overrides: Partial<ApprovalSignature> = {},
): ApprovalSignature {
  return {
    memberId,
    senderId: `sim:${memberId.replace(/^mem_/, '')}`,
    via: 'button',
    messageId: `msg_${memberId}_yes`,
    at: NOW,
    ...overrides,
  };
}
