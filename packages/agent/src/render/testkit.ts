/**
 * Synthetic fixtures for renderer and send-path tests (not exported from the
 * package index). The Barcelona flagship: six adults (VOICE §0 order: Dean,
 * Henry, Maya, Jordan, Priya, Sam), Henry out sick, five Razzmatazz tickets at
 * €18 on Dean's card. The audit trail is written through the real in-memory
 * AuditRepository (hash chain and private-key checks included) and the
 * decision comes from the real `approval.evaluate`.
 */
import type {
  AuditEvent,
  Booking,
  BookingProposal,
  ConsentFlags,
  ConsentLookup,
  Expense,
  Group,
  IdGenerator,
  Member,
  PolicyDecision,
  SimulatedClock,
  Stores,
  TicketArtifact,
  Trip,
} from '@trav/core';
import {
  DEFAULT_GROUP_SETTINGS,
  approval,
  createDeterministicIdGenerator,
  createSimulatedClock,
  defaultConsent,
  defaultSpendingPolicy,
  markPrivate,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type { RenderContext } from './common.js';

export const GROUP_ID = 'grp_barcelona';
export const TRIP_ID = 'trip_barcelona';
/** Thursday night, 20 minutes before the 10pm refund cutoff. */
export const NOW = '2026-03-12T21:40:00+01:00';
export const TZ = 'Europe/Madrid';

function adult(id: string, name: string, extra: Partial<Member> = {}): Member {
  return {
    memberId: id,
    groupId: GROUP_ID,
    displayName: name,
    role: 'member',
    active: true,
    senderId: `h_${name.toLowerCase()}`,
    birthDate: '2004-06-01',
    ageBand: 'adult',
    joinedAt: '2026-03-01T10:00:00+01:00',
    ...extra,
  };
}

export function barcelonaMembers(): Member[] {
  return [
    adult('mem_dean', 'Dean', { role: 'lead' }),
    adult('mem_henry', 'Henry'),
    adult('mem_maya', 'Maya'),
    adult('mem_jordan', 'Jordan'),
    adult('mem_priya', 'Priya'),
    adult('mem_sam', 'Sam'),
  ];
}

export const FIVE = ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'] as const;

export function barcelonaGroup(settings: Partial<Group['settings']> = {}): Group {
  return {
    groupId: GROUP_ID,
    name: 'barcelona',
    conversationId: 'conv_barcelona',
    channelKind: 'simulator',
    currency: 'EUR',
    settings: { ...DEFAULT_GROUP_SETTINGS, ...settings },
    spendingPolicy: defaultSpendingPolicy(GROUP_ID, 'EUR'),
    createdAt: '2026-03-01T10:00:00+01:00',
  };
}

export function barcelonaTrip(): Trip {
  return {
    tripId: TRIP_ID,
    groupId: GROUP_ID,
    name: 'barcelona',
    city: 'Barcelona',
    countryCode: 'ES',
    timeZone: TZ,
    startDate: '2026-03-12',
    endDate: '2026-03-17',
    currency: 'EUR',
    status: 'active',
    familyTab: false,
    createdBy: 'mem_dean',
    createdAt: '2026-03-01T10:00:00+01:00',
  };
}

/** Consent lookup: `roast` and `photos` for the listed members. */
export function consentFor(
  opts: { readonly roast?: readonly string[]; readonly photos?: readonly string[] } = {},
): ConsentLookup {
  return (memberId) => {
    const base: ConsentFlags = defaultConsent(memberId, GROUP_ID, '2026-03-01T10:00:00+01:00');
    return {
      ...base,
      roast: (opts.roast ?? []).includes(memberId),
      photos: (opts.photos ?? []).includes(memberId),
    };
  };
}

export function renderCtx(
  members: readonly Member[] = barcelonaMembers(),
  now = NOW,
  ids: IdGenerator = createDeterministicIdGenerator('r'),
): RenderContext {
  return { groupId: GROUP_ID, members, timeZone: TZ, now, ids };
}

export const RZ_EVENT = {
  name: 'Razzmatazz: Thursday club night',
  venue: 'Razzmatazz',
  address: 'Carrer dels Almogàvers 122',
  startsAt: '2026-03-13T00:00:00+01:00',
  doorsAt: '2026-03-13T00:00:00+01:00',
} as const;

export function razzmatazzProposal(over: Partial<BookingProposal> = {}): BookingProposal {
  return {
    proposalId: 'prop_rz',
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    activityId: 'act_rz',
    kind: 'ticket',
    provider: 'mock-tickets',
    itemRef: 'off_rzm_20260312_ga',
    description: 'Razzmatazz',
    city: 'Barcelona',
    totalMinor: 9000,
    currency: 'EUR',
    quotedAt: NOW,
    quoteRef: 'hold_rz_1',
    holdExpiresAt: '2026-03-12T21:55:00+01:00',
    payers: FIVE.map((memberId) => ({ memberId, shareMinor: 1800 })),
    attendees: [...FIVE],
    paidBy: { kind: 'member_card', memberId: 'mem_dean' },
    refundable: true,
    refundDeadline: '2026-03-12T22:00:00+01:00',
    eventDate: '2026-03-12',
    ageRestriction: 18,
    contentTags: ['nightlife', 'club'],
    requestedBy: 'mem_dean',
    requestedAt: NOW,
    sourceMessageId: 'sim_in_1',
    idempotencyKey: 'idem_rz',
    status: 'pending',
    ...over,
  };
}

export function decide(
  proposal: BookingProposal,
  members: readonly Member[] = barcelonaMembers(),
  policy = defaultSpendingPolicy(GROUP_ID, 'EUR'),
  now = NOW,
): PolicyDecision {
  return approval.evaluate(proposal, policy, {
    now,
    members: approval.toMemberViews(members, now),
    prefs: {},
    spentTodayMinor: 0,
    spentTripMinor: 0,
    existingBookingForKey: null,
  });
}

export interface RazzmatazzWorld {
  readonly clock: SimulatedClock;
  readonly ids: IdGenerator;
  readonly stores: Stores;
  readonly members: Member[];
  readonly group: Group;
  readonly trip: Trip;
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly booking: Booking;
  readonly expense: Expense;
  readonly events: readonly AuditEvent[];
  readonly tickets: readonly TicketArtifact[];
}

/**
 * The full approved-and-booked Razzmatazz lifecycle, audited in SAFETY §2.2
 * order: proposal.created → policy.evaluated → approval.requested →
 * approval.granted (Dean, button) → booking.attempted → booking.completed →
 * ledger.written. `skip` drops events to build broken trails.
 */
export function razzmatazzWorld(
  opts: {
    readonly skip?: readonly AuditEvent['type'][];
    readonly completedPayload?: Partial<Record<string, unknown>>;
    readonly split?: Expense['split'];
  } = {},
): RazzmatazzWorld {
  const clock = createSimulatedClock(NOW);
  const ids = createDeterministicIdGenerator('w');
  const stores = createMemoryStores({ clock, ids });
  const members = barcelonaMembers();
  const group = barcelonaGroup();
  const trip = barcelonaTrip();
  const proposal = razzmatazzProposal();
  const decision = decide(proposal, members);
  const skip = new Set(opts.skip ?? []);
  const actorTrav = { kind: 'trav', id: 'trav' } as const;
  const log = (
    type: AuditEvent['type'],
    payload: Record<string, unknown>,
    extra: { bookingId?: string; actor?: { kind: 'member' | 'trav' | 'system'; id: string } } = {},
  ): AuditEvent | undefined => {
    if (skip.has(type)) return undefined;
    return stores.group.audit.append({
      groupId: GROUP_ID,
      tripId: TRIP_ID,
      type,
      actor: extra.actor ?? actorTrav,
      visibility: 'group',
      proposalId: proposal.proposalId,
      ...(extra.bookingId !== undefined ? { bookingId: extra.bookingId } : {}),
      idempotencyKey: proposal.idempotencyKey,
      payload,
    });
  };

  log('proposal.created', {
    kind: proposal.kind,
    provider: proposal.provider,
    itemRef: proposal.itemRef,
    totalMinor: proposal.totalMinor,
    currency: proposal.currency,
    payers: proposal.payers,
    attendees: proposal.attendees,
    refundable: proposal.refundable,
    requestedBy: proposal.requestedBy,
    sourceMessageId: proposal.sourceMessageId,
  });
  log('policy.evaluated', {
    outcome: decision.outcome,
    reasons: decision.reasons,
    ruleIds: decision.ruleIds,
    approvalMode: decision.approvalMode,
    requiredApprovers: decision.requiredApprovers,
    expiresAt: decision.expiresAt,
    policySnapshot: decision.policySnapshot,
    spentTodayMinor: 0,
    spentTripMinor: 0,
  });
  log('approval.requested', {
    requiredApprovers: decision.requiredApprovers,
    approvalMode: decision.approvalMode,
    expiresAt: decision.expiresAt,
    cardMessageId: 'msg_proposal',
  });
  clock.advanceMs(60_000);
  log(
    'approval.granted',
    { memberId: 'mem_dean', via: 'button', messageId: 'sim_in_2', complete: true },
    { actor: { kind: 'member', id: 'mem_dean' } },
  );
  const bookingId = 'bk_rz';
  log(
    'booking.attempted',
    { idempotencyKey: proposal.idempotencyKey, quoteRef: proposal.quoteRef, grantId: 'grant_rz' },
    { bookingId },
  );
  const completed = log(
    'booking.completed',
    {
      providerRef: 'mock-tickets:RZ-48213',
      totalMinor: 9000,
      currency: 'EUR',
      payers: proposal.payers,
      attendees: proposal.attendees,
      refundable: true,
      ...(opts.completedPayload ?? {}),
    },
    { bookingId },
  );
  const expense: Expense = {
    expenseId: 'exp_rz',
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    description: 'razzmatazz tickets',
    merchantDisplay: 'Razzmatazz',
    category: 'tickets',
    amount: { amountMinor: 9000, currency: 'EUR' },
    paidBy: [{ memberId: 'mem_dean', amount: { amountMinor: 9000, currency: 'EUR' } }],
    split: opts.split ?? { method: 'equal', participants: [...FIVE] },
    source: 'booking',
    sourceRef: { kind: 'booking', id: bookingId },
    activityId: 'act_rz',
    occurredAt: clock.now(),
    createdAt: clock.now(),
    createdBy: 'mem_dean',
    status: 'logged',
  };
  log(
    'ledger.written',
    { expenseId: expense.expenseId, bookingId, splitMethod: expense.split.method },
    { bookingId },
  );

  const booking: Booking = {
    bookingId,
    proposalId: proposal.proposalId,
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    activityId: 'act_rz',
    kind: 'ticket',
    provider: 'mock-tickets',
    providerRef: 'mock-tickets:RZ-48213',
    orderRef: 'RZ-48213',
    description: RZ_EVENT.name,
    merchant: 'Razzmatazz',
    totalMinor: 9000,
    currency: 'EUR',
    payers: proposal.payers,
    attendees: proposal.attendees,
    paidBy: proposal.paidBy,
    refundable: true,
    refundDeadline: '2026-03-12T22:00:00+01:00',
    idempotencyKey: proposal.idempotencyKey,
    purchasedAt: clock.now(),
    status: 'confirmed',
    tickets: FIVE.map((m, i) => ({
      ticketId: `tkt_rz_${String(i + 1)}`,
      holderMemberId: m,
      deliveredToMemberId: m,
    })),
    expenseId: expense.expenseId,
    completedAuditEventId: completed?.id ?? 'aud_missing',
  };
  const tickets = FIVE.map((m, i) => ticketArtifact(m, `tkt_rz_${String(i + 1)}`));
  return {
    clock,
    ids,
    stores,
    members,
    group,
    trip,
    proposal,
    decision,
    booking,
    expense,
    events: stores.group.audit.listByGroup(GROUP_ID),
    tickets,
  };
}

export function ticketArtifact(
  owner: string,
  ticketId: string,
  deliveredTo: string = owner,
): TicketArtifact {
  const name = owner.replace(/^mem_/, '');
  return markPrivate({
    id: `priv_${ticketId}`,
    ownerMemberId: owner,
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    createdAt: NOW,
    ticketId,
    bookingId: 'bk_rz',
    holderName: name[0]!.toUpperCase() + name.slice(1),
    event: { ...RZ_EVENT },
    qrPayload: `RZ-48213:${ticketId}:SECRET`,
    qrDataUrl: `data:image/png;base64,QR${ticketId}`,
    deliveredToMemberId: deliveredTo,
  });
}
