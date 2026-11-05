/**
 * The shared repository suite (ARCHITECTURE §8, T-005). `memory.test.ts` and
 * `sqlite.test.ts` each call `runRepositorySuite`; any new repository method
 * gets its test HERE, not in one implementation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SimulatedClock } from '../clock.js';
import { createSimulatedClock } from '../clock.js';
import { createDeterministicIdGenerator } from '../ids.js';
import type { RuntimeStateEntry, Stores } from '../repositories.js';
import type { ScheduledJob, Scheduler } from '../clock.js';
import { createInMemoryScheduler, createStoredScheduler } from '../clock.js';
import type { Group, Member } from '../domain/group.js';
import { DEFAULT_GROUP_SETTINGS } from '../domain/group.js';
import type { Activity, Attendance, Trip } from '../domain/trip.js';
import type { Expense, LedgerEntry, SettlementPayment } from '../domain/expense.js';
import type { Booking, BookingProposal } from '../domain/booking.js';
import type { ApprovalGrant, PolicyDecision } from '../domain/approval.js';
import { defaultSpendingPolicy } from '../domain/approval.js';
import type { AuditEvent, AuditEventInput } from '../domain/audit.js';
import { AUDIT_GENESIS_HASH } from '../domain/audit.js';
import { defaultConsent } from '../domain/consent.js';
import type { GroupMemoryFact, MemberMemoryFact } from '../domain/memory.js';
import type {
  CardTransaction,
  EmailReceipt,
  PendingPrivateItem,
  ReceiptScan,
  TicketArtifact,
} from '../privacy.js';
import { markPrivate, promote } from '../privacy.js';
import { computeAuditHash, computePayloadHash, verifyAuditChain } from '../audit/index.js';
import { TravError } from '../errors.js';
import type { StoreDeps } from './shared/stores.js';
import { AUDIT_REDACTED_COUNT_KEY } from './shared/stores.js';

export type StoresFactory = (deps: StoreDeps) => Stores;

const T0 = '2026-03-14T21:40:00+01:00';
const G = 'grp_barcelona';
const G2 = 'grp_lisbon';
const TRIP = 'trip_bcn';
const TRIP2 = 'trip_bcn_next';
const DEAN = 'mem_dean';
const CHASE = 'mem_chase';
const HENRY = 'mem_henry';

// ---------- builders ----------

export function makeGroup(over: Partial<Group> = {}): Group {
  const groupId = over.groupId ?? G;
  return {
    groupId,
    name: 'barcelona crew',
    conversationId: `conv_${groupId}`,
    channelKind: 'simulator',
    currency: 'EUR',
    settings: DEFAULT_GROUP_SETTINGS,
    spendingPolicy: defaultSpendingPolicy(groupId, 'EUR'),
    createdAt: T0,
    ...over,
  };
}

export function makeMember(memberId: string, over: Partial<Member> = {}): Member {
  return {
    memberId,
    groupId: G,
    displayName: memberId.replace('mem_', ''),
    role: 'member',
    active: true,
    senderId: `sender_${memberId}`,
    ageBand: 'adult',
    joinedAt: T0,
    ...over,
  };
}

export function makeTrip(tripId: string, over: Partial<Trip> = {}): Trip {
  return {
    tripId,
    groupId: G,
    name: 'barcelona',
    city: 'Barcelona',
    countryCode: 'ES',
    timeZone: 'Europe/Madrid',
    startDate: '2026-03-12',
    endDate: '2026-03-16',
    currency: 'EUR',
    status: 'active',
    familyTab: false,
    createdBy: DEAN,
    createdAt: T0,
    ...over,
  };
}

function makeActivity(activityId: string, over: Partial<Activity> = {}): Activity {
  return {
    activityId,
    tripId: TRIP,
    groupId: G,
    kind: 'nightlife',
    name: 'razzmatazz',
    contentTags: ['nightlife', 'club'],
    ageRestriction: 18,
    createdAt: T0,
    ...over,
  };
}

function makeExpense(expenseId: string, over: Partial<Expense> = {}): Expense {
  return {
    expenseId,
    groupId: G,
    tripId: TRIP,
    description: 'dinner',
    category: 'food',
    amount: { amountMinor: 8400, currency: 'EUR' },
    paidBy: [{ memberId: DEAN, amount: { amountMinor: 8400, currency: 'EUR' } }],
    split: { method: 'equal', participants: [DEAN, CHASE] },
    source: 'chat',
    sourceRef: { kind: 'message', id: `msg_${expenseId}` },
    occurredAt: T0,
    createdAt: T0,
    createdBy: DEAN,
    status: 'logged',
    ...over,
  };
}

function entriesFor(e: Expense): LedgerEntry[] {
  const half = e.amount.amountMinor / 2;
  return [
    { expenseId: e.expenseId, tripId: e.tripId, memberId: DEAN, kind: 'paid', amount: e.amount },
    {
      expenseId: e.expenseId,
      tripId: e.tripId,
      memberId: DEAN,
      kind: 'owes',
      amount: { amountMinor: -half, currency: 'EUR' },
    },
    {
      expenseId: e.expenseId,
      tripId: e.tripId,
      memberId: CHASE,
      kind: 'owes',
      amount: { amountMinor: -half, currency: 'EUR' },
    },
  ];
}

function makeProposal(proposalId: string, over: Partial<BookingProposal> = {}): BookingProposal {
  return {
    proposalId,
    groupId: G,
    tripId: TRIP,
    kind: 'ticket',
    provider: 'mock-tickets',
    itemRef: 'evt_razz',
    description: 'razzmatazz x5',
    totalMinor: 12500,
    currency: 'EUR',
    quotedAt: T0,
    quoteRef: 'q_1',
    payers: [{ memberId: DEAN, shareMinor: 12500 }],
    attendees: [DEAN, CHASE],
    paidBy: { kind: 'member_card', memberId: DEAN },
    refundable: true,
    eventDate: '2026-03-14',
    ageRestriction: 18,
    contentTags: ['nightlife'],
    requestedBy: DEAN,
    requestedAt: T0,
    sourceMessageId: 'msg_req',
    idempotencyKey: `key_${proposalId}`,
    status: 'pending',
    ...over,
  };
}

function makeBooking(bookingId: string, over: Partial<Booking> = {}): Booking {
  return {
    bookingId,
    proposalId: 'prop_1',
    groupId: G,
    tripId: TRIP,
    kind: 'ticket',
    provider: 'mock-tickets',
    providerRef: `PR-${bookingId}`,
    orderRef: `ord_${bookingId}`,
    description: 'razzmatazz x5',
    merchant: 'razzmatazz',
    totalMinor: 12500,
    currency: 'EUR',
    payers: [{ memberId: DEAN, shareMinor: 12500 }],
    attendees: [DEAN, CHASE],
    paidBy: { kind: 'member_card', memberId: DEAN },
    refundable: true,
    idempotencyKey: `key_${bookingId}`,
    purchasedAt: T0,
    status: 'confirmed',
    tickets: [{ ticketId: 'tkt_1', holderMemberId: DEAN, deliveredToMemberId: DEAN }],
    completedAuditEventId: 'aud_x',
    ...over,
  };
}

function makeDecision(proposalId: string): PolicyDecision {
  return {
    proposalId,
    outcome: 'needs_confirmation',
    reasons: ['default_confirm'],
    ruleIds: ['C1'],
    approvalMode: 'any_one',
    requiredApprovers: [DEAN, CHASE],
    expiresAt: '2026-03-14T21:55:00+01:00',
    existingBookingId: null,
    policySnapshot: defaultSpendingPolicy(G, 'EUR'),
  };
}

function makeGrant(
  grantId: string,
  proposalId: string,
  over: Partial<ApprovalGrant> = {},
): ApprovalGrant {
  return {
    grantId,
    proposalId,
    decisionId: 'aud_eval',
    grantedBy: [],
    complete: false,
    status: 'pending',
    expiresAt: '2026-03-14T21:55:00+01:00',
    ...over,
  };
}

function auditInput(over: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    groupId: G,
    tripId: TRIP,
    type: 'proposal.created',
    actor: { kind: 'trav', id: 'trav' },
    visibility: 'group',
    payload: { totalMinor: 12500, currency: 'EUR' },
    ...over,
  };
}

function makeCard(id: string, owner: string, over: Partial<CardTransaction> = {}): CardTransaction {
  return markPrivate({
    id,
    ownerMemberId: owner,
    groupId: G,
    tripId: TRIP,
    createdAt: T0,
    providerTransactionId: `ptx_${id}`,
    accountId: 'acc_secret',
    last4: '4242',
    postedAt: T0,
    amount: { amountMinor: 4200, currency: 'EUR' },
    direction: 'debit' as const,
    pending: false,
    merchantRaw: 'SQ *BAR MARSELLA 0042',
    merchantDisplay: 'bar marsella',
    category: 'drinks' as const,
    ...over,
  }) as CardTransaction;
}

function makeEmail(id: string, owner: string, over: Partial<EmailReceipt> = {}): EmailReceipt {
  return markPrivate({
    id,
    ownerMemberId: owner,
    groupId: G,
    tripId: TRIP,
    createdAt: T0,
    emailId: `email_${id}`,
    receivedAt: T0,
    sender: 'receipts@ride.example',
    subject: 'your ride',
    bodyText: 'total 18.40 eur',
    parsed: null,
    injectionDetected: false,
    ...over,
  }) as EmailReceipt;
}

function makeScan(id: string, owner: string, over: Partial<ReceiptScan> = {}): ReceiptScan {
  return markPrivate({
    id,
    ownerMemberId: owner,
    groupId: G,
    tripId: TRIP,
    createdAt: T0,
    imageRef: 'img_sha',
    ocrText: 'TOTAL 84.00',
    parsed: null,
    injectionDetected: false,
    ...over,
  }) as ReceiptScan;
}

function makePending(
  id: string,
  owner: string,
  over: Partial<PendingPrivateItem> = {},
): PendingPrivateItem {
  return markPrivate({
    id,
    ownerMemberId: owner,
    groupId: G,
    tripId: TRIP,
    createdAt: T0,
    source: 'card' as const,
    sourceItemId: `priv_card_${id}`,
    status: 'pending' as const,
    amount: { amountMinor: 4200, currency: 'EUR' },
    occurredAt: T0,
    merchantDisplay: 'bar marsella',
    category: 'drinks' as const,
    lowConfidence: false,
    ...over,
  }) as PendingPrivateItem;
}

function makeTicket(id: string, owner: string, over: Partial<TicketArtifact> = {}): TicketArtifact {
  return markPrivate({
    id,
    ownerMemberId: owner,
    groupId: G,
    tripId: TRIP,
    createdAt: T0,
    ticketId: `tkt_${id}`,
    bookingId: 'bk_1',
    holderName: owner,
    event: { name: 'razzmatazz', venue: 'razzmatazz', startsAt: '2026-03-14T23:30:00+01:00' },
    qrPayload: `QR-${id}`,
    qrDataUrl: 'data:image/png;base64,AAAA',
    deliveredToMemberId: owner,
    ...over,
  }) as TicketArtifact;
}

function makeMemberFact(
  factId: string,
  owner: string,
  over: Partial<MemberMemoryFact> = {},
): MemberMemoryFact {
  return markPrivate({
    factId,
    ownerMemberId: owner,
    groupId: G,
    sourceTripId: TRIP,
    category: 'dietary' as const,
    text: 'vegetarian',
    sourceLane: 'private' as const,
    sourceMessageId: 'msg_dm',
    learnedAt: T0,
    ...over,
  }) as MemberMemoryFact;
}

function makePayment(paymentId: string, over: Partial<SettlementPayment> = {}): SettlementPayment {
  return {
    paymentId,
    groupId: G,
    tripId: TRIP,
    from: CHASE,
    to: DEAN,
    amount: { amountMinor: 26294, currency: 'EUR' },
    markedBy: CHASE,
    markedAt: T0,
    via: 'reaction',
    cardMessageId: `msg_card_${paymentId}`,
    status: 'marked_paid',
    ...over,
  };
}

function makeGroupFact(factId: string, over: Partial<GroupMemoryFact> = {}): GroupMemoryFact {
  return {
    factId,
    groupId: G,
    sourceTripId: TRIP,
    category: 'preference',
    text: 'the group likes late dinners',
    aboutMemberIds: [],
    sourceMessageId: 'msg_g',
    learnedAt: T0,
    ...over,
  };
}

function expectTravError(fn: () => unknown, code: TravError['code']): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TravError);
    expect((error as TravError).code).toBe(code);
    return;
  }
  throw new Error(`expected TravError(${code}), nothing was thrown`);
}

/** Every link in a stored chain points at the previous stored hash (SAFETY §2.9 "using the stored hashes"). */
function chainLinks(events: readonly AuditEvent[]): boolean {
  return events.every(
    (e, i) => e.prevHash === (i === 0 ? AUDIT_GENESIS_HASH : events[i - 1]?.hash),
  );
}

// ---------- the suite ----------

export function runRepositorySuite(name: string, factory: StoresFactory): void {
  describe(`repository suite: ${name}`, () => {
    let clock: SimulatedClock;
    let stores: Stores;

    beforeEach(() => {
      clock = createSimulatedClock(T0);
      stores = factory({ clock, ids: createDeterministicIdGenerator('t') });
      return () => stores.close();
    });

    // ---------- groups ----------
    describe('groups', () => {
      it('creates, reads by id and conversation, updates, lists', () => {
        const g = makeGroup();
        stores.group.groups.create(g);
        expect(stores.group.groups.get(G)).toEqual(g);
        expect(stores.group.groups.getByConversation(g.conversationId)).toEqual(g);
        expect(stores.group.groups.getByConversation('nope')).toBeUndefined();
        const renamed = { ...g, name: 'bcn' };
        stores.group.groups.update(renamed);
        expect(stores.group.groups.get(G)?.name).toBe('bcn');
        stores.group.groups.create(makeGroup({ groupId: G2 }));
        expect(stores.group.groups.list().map((x) => x.groupId)).toEqual([G, G2]);
      });

      it('rejects duplicate ids and duplicate conversations; update of a missing group is not_found', () => {
        stores.group.groups.create(makeGroup());
        expectTravError(() => stores.group.groups.create(makeGroup()), 'duplicate');
        expectTravError(
          () => stores.group.groups.create(makeGroup({ groupId: G2, conversationId: `conv_${G}` })),
          'duplicate',
        );
        expectTravError(
          () => stores.group.groups.update(makeGroup({ groupId: 'grp_x' })),
          'not_found',
        );
      });

      it('returns detached copies (mutating a read does not change the store)', () => {
        stores.group.groups.create(makeGroup());
        const read = stores.group.groups.get(G) as { name: string };
        read.name = 'mutated';
        expect(stores.group.groups.get(G)?.name).toBe('barcelona crew');
      });
    });

    // ---------- members ----------
    describe('members', () => {
      it('upserts, reads by sender id, lists in join order, filters active', () => {
        stores.group.members.upsert(makeMember(CHASE, { joinedAt: '2026-03-01T10:00:00+01:00' }));
        stores.group.members.upsert(makeMember(DEAN, { joinedAt: '2026-02-01T10:00:00+01:00' }));
        stores.group.members.upsert(
          makeMember(HENRY, { joinedAt: '2026-03-02T10:00:00+01:00', active: false }),
        );
        expect(stores.group.members.listByGroup(G).map((m) => m.memberId)).toEqual([
          DEAN,
          CHASE,
          HENRY,
        ]);
        expect(
          stores.group.members.listByGroup(G, { activeOnly: true }).map((m) => m.memberId),
        ).toEqual([DEAN, CHASE]);
        expect(stores.group.members.getBySenderId(G, `sender_${CHASE}`)?.memberId).toBe(CHASE);
        expect(stores.group.members.getBySenderId(G2, `sender_${CHASE}`)).toBeUndefined();
        stores.group.members.upsert(makeMember(CHASE, { displayName: 'Chase R' }));
        expect(stores.group.members.get(CHASE)?.displayName).toBe('Chase R');
        expect(stores.group.members.listByGroup(G2)).toEqual([]);
      });

      it('one sender id maps to one member per group; members cannot move groups', () => {
        stores.group.members.upsert(makeMember(DEAN));
        expectTravError(
          () =>
            stores.group.members.upsert(makeMember('mem_impostor', { senderId: `sender_${DEAN}` })),
          'duplicate',
        );
        // The same sender may be a member of a different group.
        stores.group.members.upsert(
          makeMember('mem_dean_lis', { groupId: G2, senderId: `sender_${DEAN}` }),
        );
        expectTravError(
          () => stores.group.members.upsert(makeMember(DEAN, { groupId: G2 })),
          'invalid_argument',
        );
      });
    });

    // ---------- trips ----------
    describe('trips, activities, attendance', () => {
      it('creates, updates, lists and rejects duplicates', () => {
        stores.group.trips.create(makeTrip(TRIP));
        expectTravError(() => stores.group.trips.create(makeTrip(TRIP)), 'duplicate');
        stores.group.trips.update(makeTrip(TRIP, { status: 'ended' }));
        expect(stores.group.trips.get(TRIP)?.status).toBe('ended');
        expectTravError(() => stores.group.trips.update(makeTrip('trip_missing')), 'not_found');
        expect(stores.group.trips.listByGroup(G).map((t) => t.tripId)).toEqual([TRIP]);
        // A trip cannot be re-parented into another group.
        expectTravError(
          () => stores.group.trips.update(makeTrip(TRIP, { groupId: G2 })),
          'invalid_argument',
        );
        expect(stores.group.trips.get(TRIP)?.groupId).toBe(G);
        expect(stores.group.trips.listByGroup(G2)).toEqual([]);
      });

      it('current(): active covering today, else planning; ended trips never', () => {
        expect(stores.group.trips.current(G, T0)).toBeUndefined();
        stores.group.trips.create(makeTrip('trip_old', { status: 'ended' }));
        expect(stores.group.trips.current(G, T0)).toBeUndefined();
        stores.group.trips.create(
          makeTrip('trip_plan', {
            status: 'planning',
            startDate: '2026-06-01',
            endDate: '2026-06-05',
          }),
        );
        expect(stores.group.trips.current(G, T0)?.tripId).toBe('trip_plan');
        stores.group.trips.create(makeTrip(TRIP));
        expect(stores.group.trips.current(G, T0)?.tripId).toBe(TRIP);
        expect(stores.group.trips.current(G2, T0)).toBeUndefined();
      });

      it('activities: upsert, sorted by start, range filter inclusive', () => {
        stores.group.trips.upsertActivity(
          makeActivity('act_late', { startsAt: '2026-03-14T23:30:00+01:00' }),
        );
        stores.group.trips.upsertActivity(makeActivity('act_none'));
        stores.group.trips.upsertActivity(
          makeActivity('act_dinner', { startsAt: '2026-03-14T21:00:00+01:00' }),
        );
        expect(stores.group.trips.listActivities(TRIP).map((a) => a.activityId)).toEqual([
          'act_dinner',
          'act_late',
          'act_none',
        ]);
        // `to` is 22:30Z == 23:30+01:00: both ends inclusive.
        const range = { from: '2026-03-14T21:00:00+01:00', to: '2026-03-14T22:30:00Z' };
        expect(stores.group.trips.listActivities(TRIP, range).map((a) => a.activityId)).toEqual([
          'act_dinner',
          'act_late',
        ]);
        stores.group.trips.upsertActivity(
          makeActivity('act_late', { bookingId: 'bk_1', startsAt: '2026-03-14T23:30:00+01:00' }),
        );
        expect(stores.group.trips.getActivity('act_late')?.bookingId).toBe('bk_1');
        expectTravError(
          () => stores.group.trips.upsertActivity(makeActivity('act_late', { tripId: TRIP2 })),
          'invalid_argument',
        );
      });

      it('attendance upserts by (activity, member); "Henry is out" replaces "in"', () => {
        const row = (memberId: string, status: Attendance['status']): Attendance => ({
          activityId: 'act_razz',
          memberId,
          status,
          updatedAt: T0,
          sourceMessageId: 'msg_1',
          setBy: DEAN,
        });
        stores.group.trips.setAttendance(row(DEAN, 'in'));
        stores.group.trips.setAttendance(row(HENRY, 'in'));
        stores.group.trips.setAttendance(row(HENRY, 'out'));
        const list = stores.group.trips.listAttendance('act_razz');
        expect(list.map((a) => [a.memberId, a.status])).toEqual([
          [DEAN, 'in'],
          [HENRY, 'out'],
        ]);
        expect(stores.group.trips.listAttendance('act_other')).toEqual([]);
      });
    });

    // ---------- expenses ----------
    describe('expenses and ledger', () => {
      it('creates with entries and reads them back in order', () => {
        const e = makeExpense('exp_1');
        stores.group.expenses.create(e, entriesFor(e));
        expect(stores.group.expenses.get('exp_1')).toEqual(e);
        expect(stores.group.expenses.getBySourceRef(e.sourceRef)).toEqual(e);
        expect(stores.group.expenses.listEntries(TRIP)).toEqual(entriesFor(e));
        expect(stores.group.expenses.listByTrip(TRIP)).toEqual([e]);
      });

      it('rejects a duplicate sourceRef and writes nothing (idempotent booking/promotion writes)', () => {
        const e = makeExpense('exp_1', {
          sourceRef: { kind: 'booking', id: 'bk_1' },
          source: 'booking',
        });
        stores.group.expenses.create(e, entriesFor(e));
        const retry = makeExpense('exp_2', {
          sourceRef: { kind: 'booking', id: 'bk_1' },
          source: 'booking',
        });
        expectTravError(() => stores.group.expenses.create(retry, entriesFor(retry)), 'duplicate');
        expect(stores.group.expenses.get('exp_2')).toBeUndefined();
        expect(stores.group.expenses.listEntries(TRIP)).toHaveLength(3);
        // Same id of a different kind is a different source.
        const msg = makeExpense('exp_3', { sourceRef: { kind: 'message', id: 'bk_1' } });
        stores.group.expenses.create(msg, []);
        expect(stores.group.expenses.listByTrip(TRIP)).toHaveLength(2);
      });

      it('rejects a duplicate expenseId and entries for another expense', () => {
        const e = makeExpense('exp_1');
        stores.group.expenses.create(e, entriesFor(e));
        expectTravError(
          () =>
            stores.group.expenses.create(
              makeExpense('exp_1', { sourceRef: { kind: 'message', id: 'msg_other' } }),
              [],
            ),
          'duplicate',
        );
        const other = makeExpense('exp_9');
        expectTravError(
          () => stores.group.expenses.create(other, entriesFor(e)),
          'invalid_argument',
        );
        expect(stores.group.expenses.get('exp_9')).toBeUndefined();
      });

      it('a re-promoted private item cannot double-write (promote() + unique sourceRef)', () => {
        const card = makeCard('priv_1', DEAN);
        const confirmation = {
          senderId: `sender_${DEAN}`,
          memberId: DEAN,
          messageId: 'msg_ok',
          via: 'button' as const,
          at: T0,
        };
        const ctx = (expenseId: string) => ({
          expenseId,
          groupId: G,
          tripId: TRIP,
          tripCurrency: 'EUR',
          ownerSenderId: `sender_${DEAN}`,
          now: T0,
          defaultSplit: { method: 'equal' as const, participants: [DEAN, CHASE] },
        });
        const first = promote(card, confirmation, ctx('exp_p1'));
        stores.group.expenses.create(first, []);
        const second = promote(card, confirmation, ctx('exp_p2'));
        expectTravError(() => stores.group.expenses.create(second, []), 'duplicate');
        const stored = stores.group.expenses.getBySourceRef({ kind: 'private_item', id: 'priv_1' });
        expect(stored?.expenseId).toBe('exp_p1');
        expect(JSON.stringify(stored)).not.toContain('4242');
        expect(JSON.stringify(stored)).not.toContain('SQ *BAR');
      });

      it('replace (undo): hidden from listByTrip and balances, kept with includeUndone', () => {
        const a = makeExpense('exp_a');
        const b = makeExpense('exp_b');
        stores.group.expenses.create(a, entriesFor(a));
        stores.group.expenses.create(b, entriesFor(b));
        stores.group.expenses.replace({ ...a, status: 'undone' }, entriesFor(a));
        expect(stores.group.expenses.listByTrip(TRIP).map((e) => e.expenseId)).toEqual(['exp_b']);
        expect(
          stores.group.expenses.listByTrip(TRIP, { includeUndone: true }).map((e) => e.expenseId),
        ).toEqual(['exp_a', 'exp_b']);
        expect(stores.group.expenses.listEntries(TRIP).every((x) => x.expenseId === 'exp_b')).toBe(
          true,
        );
        // edit: fewer entries replace the old ones
        const edited = { ...b, amount: { amountMinor: 100, currency: 'EUR' } };
        const one: LedgerEntry[] = [
          { expenseId: 'exp_b', tripId: TRIP, memberId: DEAN, kind: 'paid', amount: edited.amount },
        ];
        stores.group.expenses.replace(edited, one);
        expect(stores.group.expenses.listEntries(TRIP)).toEqual(one);
        expect(stores.group.expenses.get('exp_b')?.amount.amountMinor).toBe(100);
      });

      it('replace: missing is not_found; stealing another expense sourceRef is duplicate', () => {
        expectTravError(() => stores.group.expenses.replace(makeExpense('exp_x'), []), 'not_found');
        const a = makeExpense('exp_a');
        const b = makeExpense('exp_b');
        stores.group.expenses.create(a, []);
        stores.group.expenses.create(b, []);
        expectTravError(
          () => stores.group.expenses.replace({ ...b, sourceRef: a.sourceRef }, []),
          'duplicate',
        );
        expect(stores.group.expenses.get('exp_b')?.sourceRef).toEqual(b.sourceRef);
      });

      it('onCreate (T-165): fires once per committed create, never for duplicates, replace or after unsubscribe', () => {
        const seen: string[] = [];
        const other: string[] = [];
        const off = stores.group.expenses.onCreate((e) => seen.push(e.expenseId));
        stores.group.expenses.onCreate((e) => other.push(e.expenseId));
        const a = makeExpense('exp_a', { sourceRef: { kind: 'booking', id: 'bk_1' } });
        stores.group.expenses.create(a, entriesFor(a));
        // duplicate sourceRef and duplicate id: nothing written, nothing announced
        const retry = makeExpense('exp_b', { sourceRef: { kind: 'booking', id: 'bk_1' } });
        expectTravError(() => stores.group.expenses.create(retry, []), 'duplicate');
        expectTravError(
          () =>
            stores.group.expenses.create(
              makeExpense('exp_a', { sourceRef: { kind: 'message', id: 'msg_x' } }),
              [],
            ),
          'duplicate',
        );
        // invalid entries: rejected before the write
        const bad = makeExpense('exp_bad');
        expectTravError(() => stores.group.expenses.create(bad, entriesFor(a)), 'invalid_argument');
        // replace (undo/edit) is not a create
        stores.group.expenses.replace({ ...a, status: 'undone' }, entriesFor(a));
        expect(seen).toEqual(['exp_a']);
        off();
        off();
        const c = makeExpense('exp_c');
        stores.group.expenses.create(c, entriesFor(c));
        expect(seen).toEqual(['exp_a']);
        expect(other).toEqual(['exp_a', 'exp_c']);
      });

      it('onUndo (T-165 r2): fires once when a logged expense is replaced as undone; never for an edit, a re-undo or after unsubscribe', () => {
        const seen: string[] = [];
        const off = stores.group.expenses.onUndo((e) => seen.push(`${e.expenseId}:${e.status}`));
        stores.group.expenses.onUndo(() => {
          throw new Error('listener boom');
        });
        const a = makeExpense('exp_a');
        stores.group.expenses.create(a, entriesFor(a));
        stores.group.expenses.replace({ ...a, description: 'edited' }, entriesFor(a));
        expect(seen).toEqual([]);
        expect(() =>
          stores.group.expenses.replace({ ...a, status: 'undone' }, entriesFor(a)),
        ).not.toThrow();
        expect(stores.group.expenses.get('exp_a')?.status).toBe('undone');
        stores.group.expenses.replace({ ...a, status: 'undone' }, entriesFor(a));
        expect(seen).toEqual(['exp_a:undone']);
        expectTravError(
          () => stores.group.expenses.replace({ ...makeExpense('exp_none'), status: 'undone' }, []),
          'not_found',
        );
        off();
        const b = makeExpense('exp_b');
        stores.group.expenses.create(b, entriesFor(b));
        stores.group.expenses.replace({ ...b, status: 'undone' }, entriesFor(b));
        expect(seen).toEqual(['exp_a:undone']);
      });

      it('onCreate (T-165): a throwing listener neither undoes the write nor stops the others', () => {
        const seen: string[] = [];
        stores.group.expenses.onCreate(() => {
          throw new Error('listener boom');
        });
        stores.group.expenses.onCreate((e) => seen.push(e.expenseId));
        const e = makeExpense('exp_1');
        expect(() => stores.group.expenses.create(e, entriesFor(e))).not.toThrow();
        expect(stores.group.expenses.get('exp_1')).toEqual(e);
        expect(seen).toEqual(['exp_1']);
      });
    });

    // ---------- bookings ----------
    describe('proposals, decisions, grants, bookings', () => {
      it('proposals: create, update, pending list; duplicates rejected', () => {
        stores.group.bookings.createProposal(makeProposal('prop_1'));
        stores.group.bookings.createProposal(makeProposal('prop_2'));
        expectTravError(
          () => stores.group.bookings.createProposal(makeProposal('prop_1')),
          'duplicate',
        );
        stores.group.bookings.updateProposal(makeProposal('prop_1', { status: 'approved' }));
        expect(stores.group.bookings.getProposal('prop_1')?.status).toBe('approved');
        expect(stores.group.bookings.listPendingProposals(G).map((p) => p.proposalId)).toEqual([
          'prop_2',
        ]);
        expectTravError(
          () => stores.group.bookings.updateProposal(makeProposal('prop_9')),
          'not_found',
        );
      });

      it('decisions and grants round-trip; latest grant per proposal wins', () => {
        stores.group.bookings.saveDecision(makeDecision('prop_1'), 'aud_eval');
        expect(stores.group.bookings.getDecision('prop_1')).toEqual({
          decision: makeDecision('prop_1'),
          auditEventId: 'aud_eval',
        });
        expect(stores.group.bookings.getDecision('prop_2')).toBeUndefined();
        stores.group.bookings.saveGrant(makeGrant('grant_1', 'prop_1'));
        stores.group.bookings.saveGrant(makeGrant('grant_2', 'prop_1'));
        stores.group.bookings.saveGrant(makeGrant('grant_1', 'prop_1', { status: 'invalidated' }));
        expect(stores.group.bookings.getGrant('grant_1')?.status).toBe('invalidated');
        expect(stores.group.bookings.getGrantForProposal('prop_1')?.grantId).toBe('grant_2');
        expect(stores.group.bookings.getGrantForProposal('prop_x')).toBeUndefined();
        expectTravError(
          () => stores.group.bookings.saveGrant(makeGrant('grant_1', 'prop_2')),
          'invalid_argument',
        );
      });

      it('createBooking rejects a duplicate idempotency key (and a duplicate id)', () => {
        stores.group.bookings.createBooking(makeBooking('bk_1', { idempotencyKey: 'k1' }));
        expectTravError(
          () => stores.group.bookings.createBooking(makeBooking('bk_2', { idempotencyKey: 'k1' })),
          'duplicate',
        );
        expectTravError(
          () => stores.group.bookings.createBooking(makeBooking('bk_1', { idempotencyKey: 'k2' })),
          'duplicate',
        );
        expect(stores.group.bookings.getBooking('bk_2')).toBeUndefined();
        expect(stores.group.bookings.getBookingByKey('k1')?.bookingId).toBe('bk_1');
        expect(stores.group.bookings.getBookingByKey('k2')).toBeUndefined();
        expect(stores.group.bookings.listByTrip(TRIP)).toHaveLength(1);
      });

      it('updateBooking: not_found for missing, the key is immutable', () => {
        stores.group.bookings.createBooking(makeBooking('bk_1', { idempotencyKey: 'k1' }));
        stores.group.bookings.updateBooking(
          makeBooking('bk_1', { idempotencyKey: 'k1', expenseId: 'exp_1' }),
        );
        expect(stores.group.bookings.getBooking('bk_1')?.expenseId).toBe('exp_1');
        expectTravError(
          () => stores.group.bookings.updateBooking(makeBooking('bk_1', { idempotencyKey: 'k9' })),
          'invalid_argument',
        );
        expectTravError(
          () => stores.group.bookings.updateBooking(makeBooking('bk_9')),
          'not_found',
        );
      });

      it('spentBetween sums confirmed bookings in [from, to] for the group only', () => {
        const at = (iso: string, over: Partial<Booking> = {}) => ({ purchasedAt: iso, ...over });
        stores.group.bookings.createBooking(
          makeBooking('bk_1', at('2026-03-14T10:00:00+01:00', { totalMinor: 1000 })),
        );
        stores.group.bookings.createBooking(
          makeBooking('bk_2', at('2026-03-14T20:00:00+01:00', { totalMinor: 2500 })),
        );
        stores.group.bookings.createBooking(
          makeBooking(
            'bk_3',
            at('2026-03-14T12:00:00+01:00', { totalMinor: 9999, status: 'cancelled' }),
          ),
        );
        stores.group.bookings.createBooking(
          makeBooking('bk_4', at('2026-03-13T12:00:00+01:00', { totalMinor: 7000 })),
        );
        stores.group.bookings.createBooking(
          makeBooking('bk_5', at('2026-03-14T12:00:00+01:00', { totalMinor: 50, groupId: G2 })),
        );
        // `to` is 19:00Z == 20:00+01:00: inclusive at exactly the boundary.
        expect(
          stores.group.bookings.spentBetween(
            G,
            '2026-03-14T00:00:00+01:00',
            '2026-03-14T19:00:00Z',
          ),
        ).toBe(3500);
        expect(
          stores.group.bookings.spentBetween(
            G,
            '2026-03-15T00:00:00+01:00',
            '2026-03-16T00:00:00+01:00',
          ),
        ).toBe(0);
        expect(
          stores.group.bookings.spentBetween(
            G2,
            '2026-03-14T00:00:00+01:00',
            '2026-03-15T00:00:00+01:00',
          ),
        ).toBe(50);
      });
    });

    // ---------- audit ----------
    describe('audit (append-only, hash-chained)', () => {
      it('assigns id, ts from the injected clock, prevHash and hash via computeAuditHash', () => {
        const first = stores.group.audit.append(auditInput());
        expect(first.id).toMatch(/^aud_/);
        expect(first.ts).toBe(T0);
        expect(first.prevHash).toBe(AUDIT_GENESIS_HASH);
        const { hash, ...rest } = first;
        expect(hash).toBe(computeAuditHash(rest));
        clock.advanceMs(60_000);
        const second = stores.group.audit.append(
          auditInput({
            type: 'policy.evaluated',
            proposalId: 'prop_1',
            payload: { outcome: 'needs_confirmation', reasons: ['default_confirm'] },
          }),
        );
        expect(second.ts).toBe('2026-03-14T21:41:00+01:00');
        // The lifecycle header is derived from the payload and hashed (D-016).
        expect(second.lifecycle).toEqual({ outcome: 'needs_confirmation' });
        expect(computeAuditHash(second)).toBe(second.hash);
        expect(second.prevHash).toBe(first.hash);
        expect(stores.group.audit.lastHash(G)).toBe(second.hash);
        expect(stores.group.audit.lastHash(G2)).toBe(AUDIT_GENESIS_HASH);
        expect(stores.group.audit.get(first.id)).toEqual(first);
        const all = stores.group.audit.listByGroup(G);
        expect(all).toEqual([first, second]);
        expect(verifyAuditChain(all, { expectedHeadHash: stores.group.audit.lastHash(G) }).ok).toBe(
          true,
        );
      });

      it('chains are per group', () => {
        const a1 = stores.group.audit.append(auditInput());
        const b1 = stores.group.audit.append(auditInput({ groupId: G2, tripId: null }));
        const a2 = stores.group.audit.append(auditInput());
        expect(b1.prevHash).toBe(AUDIT_GENESIS_HASH);
        expect(a2.prevHash).toBe(a1.hash);
        expect(verifyAuditChain(stores.group.audit.listByGroup(G)).ok).toBe(true);
        expect(verifyAuditChain(stores.group.audit.listByGroup(G2)).ok).toBe(true);
      });

      it('rejects PRIVATE_PAYLOAD_KEYS at any depth and appends nothing', () => {
        const before = stores.group.audit.lastHash(G);
        for (const payload of [
          { last4: '4242' },
          { item: { bodyText: 'x' } },
          { items: [{ ok: 1 }, { ocrText: 'TOTAL' }] },
          { qrPayload: 'QR' },
          { merchantRaw: 'SQ *BAR' },
        ]) {
          expectTravError(
            () => stores.group.audit.append(auditInput({ payload })),
            'invariant_violation',
          );
        }
        expect(stores.group.audit.lastHash(G)).toBe(before);
        expect(stores.group.audit.listByGroup(G)).toEqual([]);
      });

      it('owner-visibility events need ownerId and never show in group views', () => {
        expectTravError(
          () =>
            stores.group.audit.append(
              auditInput({ type: 'private.item_ingested', visibility: 'owner' }),
            ),
          'invariant_violation',
        );
        const owner = stores.group.audit.append(
          auditInput({
            type: 'private.item_ingested',
            visibility: 'owner',
            ownerId: DEAN,
            payload: { itemId: 'priv_1' },
          }),
        );
        const group = stores.group.audit.append(auditInput());
        expect(stores.group.audit.listGroupVisible(G).map((e) => e.id)).toEqual([group.id]);
        expect(stores.group.audit.listByGroup(G).map((e) => e.id)).toEqual([owner.id, group.id]);
      });

      it('filters by type, since, proposal and booking', () => {
        const a = stores.group.audit.append(
          auditInput({ type: 'proposal.created', proposalId: 'prop_1' }),
        );
        clock.advanceHours(1);
        const b = stores.group.audit.append(
          auditInput({
            type: 'policy.evaluated',
            proposalId: 'prop_1',
            lifecycle: { outcome: 'auto_approve' },
          }),
        );
        clock.advanceHours(1);
        const c = stores.group.audit.append(
          auditInput({ type: 'booking.completed', proposalId: 'prop_1', bookingId: 'bk_1' }),
        );
        stores.group.audit.append(auditInput({ type: 'proposal.created', proposalId: 'prop_2' }));
        expect(stores.group.audit.listByProposal('prop_1').map((e) => e.id)).toEqual([
          a.id,
          b.id,
          c.id,
        ]);
        expect(stores.group.audit.listByBooking('bk_1').map((e) => e.id)).toEqual([c.id]);
        expect(
          stores.group.audit
            .listByGroup(G, { types: ['policy.evaluated', 'booking.completed'] })
            .map((e) => e.id),
        ).toEqual([b.id, c.id]);
        expect(stores.group.audit.listByGroup(G, { since: b.ts }).map((e) => e.type)).toEqual([
          'policy.evaluated',
          'booking.completed',
          'proposal.created',
        ]);
      });

      it('the private store exposes exactly the PrivateStore methods (no list-all)', () => {
        expect(Object.keys(stores.private).sort()).toEqual(
          [
            'putCardTransaction',
            'getCardTransaction',
            'getCardTransactionByProviderId',
            'listCardTransactions',
            'putEmailReceipt',
            'getEmailReceipt',
            'listEmailReceipts',
            'putReceiptScan',
            'getReceiptScan',
            'putPendingItem',
            'getPendingItem',
            'listPendingItems',
            'getConsent',
            'putConsent',
            'getPrefs',
            'putPrefs',
            'putMemberMemory',
            'listMemberMemory',
            'putTicket',
            'listTickets',
            'getPaymentProfile',
            'putPaymentProfile',
            'putRuntimeState',
            'getRuntimeState',
            'listRuntimeState',
            'deleteRuntimeState',
            'deletePartition',
            'purgeRawInputs',
          ].sort(),
        );
      });

      it('exposes append and reads only (no update/delete at runtime)', () => {
        expect(Object.keys(stores.group.audit).sort()).toEqual(
          [
            'append',
            'get',
            'lastHash',
            'listByBooking',
            'listByGroup',
            'listByProposal',
            'listGroupVisible',
          ].sort(),
        );
      });

      it('a returned event is detached from the stored one', () => {
        const e = stores.group.audit.append(auditInput()) as { payload: Record<string, unknown> };
        e.payload.totalMinor = 1;
        const stored = stores.group.audit.listByGroup(G)[0];
        expect(stored?.payload.totalMinor).toBe(12500);
      });
    });

    // ---------- settlements (T-141) ----------
    describe('settlements', () => {
      it('records payments per trip in order; one per (card, from, to)', () => {
        stores.group.settlements.record(makePayment('pay_1'));
        stores.group.settlements.record(
          makePayment('pay_2', { from: HENRY, markedBy: HENRY, cardMessageId: 'msg_card_pay_1' }),
        );
        stores.group.settlements.record(makePayment('pay_3', { tripId: TRIP2 }));
        expect(stores.group.settlements.listByTrip(TRIP).map((p) => p.paymentId)).toEqual([
          'pay_1',
          'pay_2',
        ]);
        expect(stores.group.settlements.listByTrip(TRIP2).map((p) => p.paymentId)).toEqual([
          'pay_3',
        ]);
        // Same transfer ticked twice on the same card, or a reused id: duplicate.
        expectTravError(
          () =>
            stores.group.settlements.record(
              makePayment('pay_4', { cardMessageId: 'msg_card_pay_1' }),
            ),
          'duplicate',
        );
        expectTravError(
          () =>
            stores.group.settlements.record(makePayment('pay_1', { cardMessageId: 'msg_other' })),
          'duplicate',
        );
        expect(stores.group.settlements.listByTrip(TRIP)).toHaveLength(2);
      });

      it('refuses a self-payment and a non-positive or fractional amount', () => {
        expectTravError(
          () => stores.group.settlements.record(makePayment('pay_1', { to: CHASE })),
          'invalid_argument',
        );
        for (const [i, amountMinor] of [0, -5, 1.5].entries()) {
          expectTravError(
            () =>
              stores.group.settlements.record(
                makePayment(`pay_bad${String(i)}`, { amount: { amountMinor, currency: 'EUR' } }),
              ),
            'invalid_argument',
          );
        }
        expect(stores.group.settlements.listByTrip(TRIP)).toEqual([]);
      });

      it('T-166: update changes the state only, never who, what or which card', () => {
        stores.group.settlements.record(makePayment('pay_1', { status: 'sent', sentAt: T0 }));
        stores.group.settlements.update(
          makePayment('pay_1', {
            status: 'received',
            sentAt: T0,
            receivedAt: T0,
            receivedBy: DEAN,
          }),
        );
        expect(stores.group.settlements.listByTrip(TRIP)).toEqual([
          makePayment('pay_1', {
            status: 'received',
            sentAt: T0,
            receivedAt: T0,
            receivedBy: DEAN,
          }),
        ]);
        expectTravError(
          () => stores.group.settlements.update(makePayment('pay_nope')),
          'not_found',
        );
        for (const over of [
          { to: HENRY },
          { amount: { amountMinor: 1, currency: 'EUR' } },
          { cardMessageId: 'msg_other' },
        ] as const) {
          expectTravError(
            () => stores.group.settlements.update(makePayment('pay_1', over)),
            'invalid_argument',
          );
        }
        expect(stores.group.settlements.listByTrip(TRIP)[0]?.status).toBe('received');
      });
    });

    describe('payment profiles (T-166, owner-private)', () => {
      it('round-trips per owner; another owner can neither write nor see it', () => {
        expect(stores.private.getPaymentProfile(DEAN)).toBeUndefined();
        const p = {
          memberId: DEAN,
          apps: ['venmo', 'zelle'] as const,
          favourite: 'venmo' as const,
          handles: { venmo: 'dean-trav' },
          updatedAt: T0,
        };
        stores.private.putPaymentProfile(DEAN, p);
        expect(stores.private.getPaymentProfile(DEAN)).toEqual(p);
        expect(stores.private.getPaymentProfile(CHASE)).toBeUndefined();
        expect(() => stores.private.putPaymentProfile(CHASE, p)).toThrow();
        expect(stores.private.getPaymentProfile(DEAN)).toEqual(p);
      });
    });

    // ---------- group memory ----------
    describe('group memory', () => {
      it('upserts, filters by trip, limits to the most recent, deletes one fact', () => {
        stores.group.groupMemory.upsert(
          makeGroupFact('f_2', { learnedAt: '2026-03-14T10:00:00+01:00' }),
        );
        stores.group.groupMemory.upsert(
          makeGroupFact('f_1', { learnedAt: '2026-03-13T10:00:00+01:00' }),
        );
        stores.group.groupMemory.upsert(
          makeGroupFact('f_3', { learnedAt: '2026-03-15T10:00:00+01:00', sourceTripId: null }),
        );
        expect(stores.group.groupMemory.listByGroup(G).map((f) => f.factId)).toEqual([
          'f_1',
          'f_2',
          'f_3',
        ]);
        expect(
          stores.group.groupMemory.listByGroup(G, { tripId: TRIP }).map((f) => f.factId),
        ).toEqual(['f_1', 'f_2']);
        expect(stores.group.groupMemory.listByGroup(G, { limit: 2 }).map((f) => f.factId)).toEqual([
          'f_2',
          'f_3',
        ]);
        expect(stores.group.groupMemory.listByGroup(G, { limit: 0 })).toEqual([]);
        stores.group.groupMemory.upsert(
          makeGroupFact('f_1', { text: 'updated', learnedAt: '2026-03-13T10:00:00+01:00' }),
        );
        stores.group.groupMemory.delete('f_2');
        stores.group.groupMemory.delete('f_missing');
        expect(stores.group.groupMemory.listByGroup(G).map((f) => [f.factId, f.text])).toEqual([
          ['f_1', 'updated'],
          ['f_3', 'the group likes late dinners'],
        ]);
        expect(stores.group.groupMemory.listByGroup(G2)).toEqual([]);
      });
    });

    // ---------- private store ----------
    describe('private store (owner-scoped)', () => {
      it('reads are scoped by owner: another owner sees nothing', () => {
        stores.private.putCardTransaction(DEAN, makeCard('priv_c1', DEAN));
        stores.private.putEmailReceipt(DEAN, makeEmail('priv_e1', DEAN));
        stores.private.putReceiptScan(DEAN, makeScan('priv_s1', DEAN));
        stores.private.putPendingItem(DEAN, makePending('priv_p1', DEAN));
        stores.private.putMemberMemory(DEAN, makeMemberFact('mf_1', DEAN));
        stores.private.putTicket(DEAN, makeTicket('priv_t1', DEAN));
        stores.private.putPrefs(DEAN, {
          memberId: DEAN,
          perBookingShareCapMinor: 5000,
          dailyShareCapMinor: null,
        });
        stores.private.putConsent(DEAN, { ...defaultConsent(DEAN, G, T0), photos: true });

        expect(stores.private.getCardTransaction(DEAN, 'priv_c1')?.last4).toBe('4242');
        expect(stores.private.getCardTransaction(CHASE, 'priv_c1')).toBeUndefined();
        expect(stores.private.getCardTransactionByProviderId(CHASE, 'ptx_priv_c1')).toBeUndefined();
        expect(stores.private.listCardTransactions(CHASE, G)).toEqual([]);
        expect(stores.private.getEmailReceipt(CHASE, 'priv_e1')).toBeUndefined();
        expect(stores.private.listEmailReceipts(CHASE, G)).toEqual([]);
        expect(stores.private.getReceiptScan(CHASE, 'priv_s1')).toBeUndefined();
        expect(stores.private.getPendingItem(CHASE, 'priv_p1')).toBeUndefined();
        expect(stores.private.listPendingItems(CHASE, G)).toEqual([]);
        expect(stores.private.listMemberMemory(CHASE, G)).toEqual([]);
        expect(stores.private.listTickets(CHASE, 'bk_1')).toEqual([]);
        expect(stores.private.getPrefs(CHASE)).toBeUndefined();
        expect(stores.private.getConsent(CHASE, G)).toBeUndefined();

        expect(stores.private.getEmailReceipt(DEAN, 'priv_e1')?.bodyText).toBe('total 18.40 eur');
        expect(stores.private.getReceiptScan(DEAN, 'priv_s1')?.ocrText).toBe('TOTAL 84.00');
        expect(stores.private.listMemberMemory(DEAN, G)).toHaveLength(1);
        expect(stores.private.listTickets(DEAN, 'bk_1').map((t) => t.qrPayload)).toEqual([
          'QR-priv_t1',
        ]);
        expect(stores.private.getPrefs(DEAN)?.perBookingShareCapMinor).toBe(5000);
        expect(stores.private.getConsent(DEAN, G)?.photos).toBe(true);
        expect(stores.private.getConsent(DEAN, G2)).toBeUndefined();
      });

      it("writes refuse rows naming another owner and refuse to overwrite another owner's row", () => {
        expectTravError(
          () => stores.private.putCardTransaction(CHASE, makeCard('priv_c1', DEAN)),
          'not_owner',
        );
        expectTravError(
          () => stores.private.putEmailReceipt(CHASE, makeEmail('priv_e1', DEAN)),
          'not_owner',
        );
        expectTravError(
          () => stores.private.putReceiptScan(CHASE, makeScan('priv_s1', DEAN)),
          'not_owner',
        );
        expectTravError(
          () => stores.private.putPendingItem(CHASE, makePending('priv_p1', DEAN)),
          'not_owner',
        );
        expectTravError(
          () => stores.private.putMemberMemory(CHASE, makeMemberFact('mf_1', DEAN)),
          'not_owner',
        );
        expectTravError(
          () => stores.private.putTicket(CHASE, makeTicket('priv_t1', DEAN)),
          'not_owner',
        );
        expectTravError(
          () =>
            stores.private.putPrefs(CHASE, {
              memberId: DEAN,
              perBookingShareCapMinor: 0,
              dailyShareCapMinor: 0,
            }),
          'not_owner',
        );
        expectTravError(
          () => stores.private.putConsent(CHASE, defaultConsent(DEAN, G, T0)),
          'not_owner',
        );

        // The consent key is `<memberId>|<groupId>`, so ids containing `|` can alias: the read
        // must check the row's own memberId/groupId, and the aliased write must refuse to hijack.
        stores.private.putConsent('mem_a|grp', {
          ...defaultConsent('mem_a|grp', 'b', T0),
          photos: true,
        });
        expect(stores.private.getConsent('mem_a|grp', 'b')?.photos).toBe(true);
        expect(stores.private.getConsent('mem_a', 'grp|b')).toBeUndefined();
        expectTravError(
          () => stores.private.putConsent('mem_a', defaultConsent('mem_a', 'grp|b', T0)),
          'not_owner',
        );
        expect(stores.private.getConsent('mem_a|grp', 'b')?.memberId).toBe('mem_a|grp');

        stores.private.putPendingItem(DEAN, makePending('priv_p1', DEAN));
        // Chase re-using Dean's row id with Chase as owner must not hijack it.
        expectTravError(
          () => stores.private.putPendingItem(CHASE, makePending('priv_p1', CHASE)),
          'not_owner',
        );
        expect(stores.private.getPendingItem(DEAN, 'priv_p1')?.ownerMemberId).toBe(DEAN);
        expectTravError(() => stores.private.listPendingItems('', G), 'invalid_argument');
      });

      it('card transactions: pending → posted updates by providerTransactionId, no duplicates', () => {
        stores.private.putCardTransaction(DEAN, makeCard('priv_c1', DEAN, { pending: true }));
        const found = stores.private.getCardTransactionByProviderId(DEAN, 'ptx_priv_c1');
        expect(found?.id).toBe('priv_c1');
        stores.private.putCardTransaction(DEAN, makeCard('priv_c1', DEAN, { pending: false }));
        expect(stores.private.listCardTransactions(DEAN, G).map((t) => t.pending)).toEqual([false]);
        expectTravError(
          () =>
            stores.private.putCardTransaction(
              DEAN,
              makeCard('priv_c2', DEAN, { providerTransactionId: 'ptx_priv_c1' }),
            ),
          'duplicate',
        );
        // Another owner may have the same provider id (different account).
        stores.private.putCardTransaction(
          CHASE,
          makeCard('priv_m1', CHASE, { providerTransactionId: 'ptx_priv_c1' }),
        );
        expect(stores.private.listCardTransactions(CHASE, G)).toHaveLength(1);
      });

      it('pending queue: status filter, scoped per owner and group (no cross-owner count, T-112)', () => {
        stores.private.putPendingItem(DEAN, makePending('priv_p1', DEAN));
        stores.private.putPendingItem(DEAN, makePending('priv_p2', DEAN));
        stores.private.putPendingItem(DEAN, makePending('priv_p3', DEAN, { status: 'dismissed' }));
        stores.private.putPendingItem(CHASE, makePending('priv_p4', CHASE));
        stores.private.putPendingItem(CHASE, makePending('priv_p5', CHASE, { groupId: G2 }));
        stores.private.putPendingItem(HENRY, makePending('priv_p6', HENRY, { status: 'promoted' }));
        expect(stores.private.listPendingItems(DEAN, G).map((p) => p.id)).toEqual([
          'priv_p1',
          'priv_p2',
          'priv_p3',
        ]);
        expect(stores.private.listPendingItems(DEAN, G, 'pending').map((p) => p.id)).toEqual([
          'priv_p1',
          'priv_p2',
        ]);
        expect(stores.private.listPendingItems(CHASE, G, 'pending').map((p) => p.id)).toEqual([
          'priv_p4',
        ]);
        expect(stores.private.listPendingItems(CHASE, G2, 'pending').map((p) => p.id)).toEqual([
          'priv_p5',
        ]);
        expect(stores.private.listPendingItems(HENRY, G, 'pending')).toEqual([]);
        expect(stores.private.listPendingItems(DEAN, 'grp_none')).toEqual([]);
        expect('countPendingByOwner' in stores.private).toBe(false);
      });

      it('deletePartition removes one owner and reports per-table counts', () => {
        stores.private.putCardTransaction(DEAN, makeCard('priv_c1', DEAN));
        stores.private.putCardTransaction(DEAN, makeCard('priv_c2', DEAN));
        stores.private.putEmailReceipt(DEAN, makeEmail('priv_e1', DEAN));
        stores.private.putPendingItem(DEAN, makePending('priv_p1', DEAN));
        stores.private.putConsent(DEAN, defaultConsent(DEAN, G, T0));
        stores.private.putConsent(DEAN, defaultConsent(DEAN, G2, T0));
        stores.private.putPrefs(DEAN, {
          memberId: DEAN,
          perBookingShareCapMinor: null,
          dailyShareCapMinor: null,
        });
        stores.private.putMemberMemory(DEAN, makeMemberFact('mf_1', DEAN));
        stores.private.putTicket(DEAN, makeTicket('priv_t1', DEAN));
        stores.private.putPaymentProfile(DEAN, {
          memberId: DEAN,
          apps: ['venmo'],
          handles: { venmo: 'dean-trav' },
          updatedAt: T0,
        });
        stores.private.putCardTransaction(CHASE, makeCard('priv_m1', CHASE));
        stores.private.putPendingItem(CHASE, makePending('priv_p9', CHASE));

        expect(stores.private.deletePartition(DEAN)).toEqual({
          card_transactions: 2,
          email_receipts: 1,
          receipt_scans: 0,
          pending_private_items: 1,
          consent: 2,
          member_prefs: 1,
          member_memory: 1,
          ticket_artifacts: 1,
          payment_profiles: 1,
          private_runtime_state: 0,
        });
        expect(stores.private.getPaymentProfile(DEAN)).toBeUndefined();
        expect(stores.private.listCardTransactions(DEAN, G)).toEqual([]);
        expect(stores.private.getConsent(DEAN, G)).toBeUndefined();
        expect(stores.private.getPrefs(DEAN)).toBeUndefined();
        expect(stores.private.listCardTransactions(CHASE, G)).toHaveLength(1);
        expect(stores.private.listPendingItems(DEAN, G)).toEqual([]);
        expect(stores.private.listPendingItems(CHASE, G).map((p) => p.id)).toEqual(['priv_p9']);
      });

      it('purgeRawInputs blanks raw text of promoted/dismissed items older than the cutoff only', () => {
        const old = '2026-03-01T10:00:00+01:00';
        stores.private.putCardTransaction(DEAN, makeCard('priv_c1', DEAN, { createdAt: old }));
        stores.private.putEmailReceipt(DEAN, makeEmail('priv_e1', DEAN, { createdAt: old }));
        stores.private.putReceiptScan(DEAN, makeScan('priv_s1', DEAN, { createdAt: old }));
        stores.private.putCardTransaction(DEAN, makeCard('priv_c2', DEAN, { createdAt: old }));
        stores.private.putCardTransaction(DEAN, makeCard('priv_c3', DEAN, { createdAt: T0 }));
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p1', DEAN, { sourceItemId: 'priv_c1', status: 'promoted' }),
        );
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p2', DEAN, {
            source: 'email',
            sourceItemId: 'priv_e1',
            status: 'dismissed',
          }),
        );
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p3', DEAN, {
            source: 'receipt',
            sourceItemId: 'priv_s1',
            status: 'promoted',
          }),
        );
        // still pending ⇒ kept; too new ⇒ kept
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p4', DEAN, { sourceItemId: 'priv_c2' }),
        );
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p5', DEAN, { sourceItemId: 'priv_c3', status: 'promoted' }),
        );

        const cutoff = '2026-03-10T00:00:00+01:00';
        expect(stores.private.purgeRawInputs(DEAN, cutoff)).toBe(3);
        expect(stores.private.getCardTransaction(DEAN, 'priv_c1')?.merchantRaw).toBe('');
        expect(stores.private.getCardTransaction(DEAN, 'priv_c1')?.merchantDisplay).toBe(
          'bar marsella',
        );
        expect(stores.private.getEmailReceipt(DEAN, 'priv_e1')?.bodyText).toBe('');
        expect(stores.private.getEmailReceipt(DEAN, 'priv_e1')?.subject).toBe('');
        expect(stores.private.getReceiptScan(DEAN, 'priv_s1')?.ocrText).toBe('');
        expect(stores.private.getCardTransaction(DEAN, 'priv_c2')?.merchantRaw).toBe(
          'SQ *BAR MARSELLA 0042',
        );
        expect(stores.private.getCardTransaction(DEAN, 'priv_c3')?.merchantRaw).toBe(
          'SQ *BAR MARSELLA 0042',
        );
        // idempotent; other owners untouched
        expect(stores.private.purgeRawInputs(DEAN, cutoff)).toBe(0);
        expect(stores.private.purgeRawInputs(CHASE, cutoff)).toBe(0);
      });
    });

    // ---------- facade ----------
    describe('Stores facade: forget this trip', () => {
      const seedTrip = (tripId: string, suffix: string): void => {
        stores.group.trips.create(makeTrip(tripId));
        stores.group.trips.upsertActivity(makeActivity(`act_${suffix}`, { tripId }));
        stores.group.trips.setAttendance({
          activityId: `act_${suffix}`,
          memberId: DEAN,
          status: 'in',
          updatedAt: T0,
          sourceMessageId: 'msg_1',
          setBy: DEAN,
        });
        const e = makeExpense(`exp_${suffix}`, { tripId });
        stores.group.expenses.create(e, entriesFor(e));
        stores.group.bookings.createProposal(makeProposal(`prop_${suffix}`, { tripId }));
        stores.group.bookings.saveDecision(makeDecision(`prop_${suffix}`), 'aud_eval');
        stores.group.bookings.saveGrant(makeGrant(`grant_${suffix}`, `prop_${suffix}`));
        stores.group.bookings.createBooking(
          makeBooking(`bk_${suffix}`, { tripId, proposalId: `prop_${suffix}` }),
        );
        stores.group.groupMemory.upsert(makeGroupFact(`gf_${suffix}`, { sourceTripId: tripId }));
        stores.group.settlements.record(makePayment(`pay_${suffix}`, { tripId }));
        stores.private.putCardTransaction(DEAN, makeCard(`priv_c_${suffix}`, DEAN, { tripId }));
        stores.private.putEmailReceipt(CHASE, makeEmail(`priv_e_${suffix}`, CHASE, { tripId }));
        stores.private.putReceiptScan(DEAN, makeScan(`priv_s_${suffix}`, DEAN, { tripId }));
        stores.private.putPendingItem(CHASE, makePending(`priv_p_${suffix}`, CHASE, { tripId }));
        stores.private.putMemberMemory(
          DEAN,
          makeMemberFact(`mf_${suffix}`, DEAN, { sourceTripId: tripId }),
        );
        // one ticket linked by tripId, one only by bookingId
        stores.private.putTicket(
          DEAN,
          makeTicket(`priv_t_${suffix}`, DEAN, { tripId, bookingId: `bk_${suffix}` }),
        );
        stores.private.putTicket(
          CHASE,
          makeTicket(`priv_t2_${suffix}`, CHASE, { tripId: null, bookingId: `bk_${suffix}` }),
        );
        stores.group.audit.append(
          auditInput({ tripId, proposalId: `prop_${suffix}`, payload: { note: suffix } }),
        );
        stores.group.runtime.put({
          namespace: 'card',
          groupId: G,
          tripId,
          key: `msg_${suffix}`,
          value: { suffix },
        });
        stores.private.putRuntimeState(DEAN, {
          namespace: 'card',
          groupId: G,
          tripId,
          key: `dm_${suffix}`,
          value: { qr: `QR-${suffix}` },
        });
        stores.group.runtime.putJob({
          jobId: `morning_after:${suffix}`,
          groupId: G,
          tripId,
          kind: 'morning_after',
          runAt: T0,
          payload: {},
        });
        stores.group.audit.append(
          auditInput({
            tripId,
            type: 'private.item_ingested',
            visibility: 'owner',
            ownerId: DEAN,
            payload: { itemId: `priv_c_${suffix}`, amountMinor: 4200 },
          }),
        );
      };

      it('deletes every trip row in both stores, redacts its audit payloads, leaves other trips alone', () => {
        stores.group.groups.create(makeGroup());
        seedTrip(TRIP, 'a');
        seedTrip(TRIP2, 'b');
        stores.group.audit.append(auditInput({ tripId: null, payload: { note: 'group-level' } }));
        const auditBefore = stores.group.audit.listByGroup(G);

        const counts = stores.deleteTrip(TRIP);
        expect(counts).toEqual({
          attendance: 1,
          decisions: 1,
          grants: 1,
          ledger_entries: 3,
          expenses: 1,
          settlements: 1,
          bookings: 1,
          proposals: 1,
          activities: 1,
          group_memory: 1,
          trips: 1,
          card_transactions: 1,
          email_receipts: 1,
          receipt_scans: 1,
          pending_private_items: 1,
          member_memory: 1,
          ticket_artifacts: 2,
          scheduled_jobs: 1,
          runtime_state: 1,
          private_runtime_state: 1,
          [AUDIT_REDACTED_COUNT_KEY]: 2,
        });

        // Trip A: zero rows everywhere except audit; trip B's job and state are still there.
        expect(stores.group.runtime.listJobs().map((j) => j.jobId)).toEqual(['morning_after:b']);
        expect(stores.group.runtime.list('card').map((e) => [e.key, e.tripId])).toEqual([
          ['msg_b', TRIP2],
        ]);
        expect(stores.private.listRuntimeState(DEAN, 'card').map((e) => e.key)).toEqual(['dm_b']);
        expect(JSON.stringify(stores.private.listRuntimeState(DEAN, 'card'))).not.toContain('QR-a');
        expect(stores.group.trips.get(TRIP)).toBeUndefined();
        expect(stores.group.trips.getActivity('act_a')).toBeUndefined();
        expect(stores.group.trips.listAttendance('act_a')).toEqual([]);
        expect(stores.group.trips.listActivities(TRIP)).toEqual([]);
        expect(stores.group.expenses.listByTrip(TRIP, { includeUndone: true })).toEqual([]);
        expect(stores.group.expenses.listEntries(TRIP)).toEqual([]);
        expect(stores.group.bookings.getProposal('prop_a')).toBeUndefined();
        expect(stores.group.bookings.getDecision('prop_a')).toBeUndefined();
        expect(stores.group.bookings.getGrant('grant_a')).toBeUndefined();
        expect(stores.group.bookings.listByTrip(TRIP)).toEqual([]);
        expect(stores.group.groupMemory.listByGroup(G, { tripId: TRIP })).toEqual([]);
        expect(stores.group.settlements.listByTrip(TRIP)).toEqual([]);
        expect(stores.private.getCardTransaction(DEAN, 'priv_c_a')).toBeUndefined();
        expect(stores.private.getEmailReceipt(CHASE, 'priv_e_a')).toBeUndefined();
        expect(stores.private.getReceiptScan(DEAN, 'priv_s_a')).toBeUndefined();
        expect(stores.private.getPendingItem(CHASE, 'priv_p_a')).toBeUndefined();
        expect(stores.private.listMemberMemory(DEAN, G).map((f) => f.factId)).toEqual(['mf_b']);
        expect(stores.private.listTickets(DEAN, 'bk_a')).toEqual([]);
        expect(stores.private.listTickets(CHASE, 'bk_a')).toEqual([]);

        // Trip B untouched.
        expect(stores.group.trips.get(TRIP2)).toBeDefined();
        expect(stores.group.expenses.listEntries(TRIP2)).toHaveLength(3);
        expect(stores.group.settlements.listByTrip(TRIP2)).toHaveLength(1);
        expect(stores.private.listTickets(CHASE, 'bk_b')).toHaveLength(1);
        expect(stores.private.getPendingItem(CHASE, 'priv_p_b')).toBeDefined();

        // Audit: same rows, same hashes, trip A payloads tombstoned, chain links intact.
        const auditAfter = stores.group.audit.listByGroup(G);
        expect(auditAfter.map((e) => [e.id, e.hash, e.prevHash])).toEqual(
          auditBefore.map((e) => [e.id, e.hash, e.prevHash]),
        );
        const beforeById = new Map(auditBefore.map((e) => [e.id, e]));
        for (const e of auditAfter) {
          if (e.tripId === TRIP) {
            // Digest tombstone (D-016): the original payload's hash survives, nothing else.
            expect(e.payload).toEqual({
              redacted: true,
              payloadHash: computePayloadHash(beforeById.get(e.id)?.payload),
            });
          } else {
            expect(e.payload.redacted).toBeUndefined();
          }
        }
        expect(chainLinks(auditAfter)).toBe(true);
        // Full verification still passes: the hash committed to the payload through its digest.
        expect(verifyAuditChain(auditAfter).ok).toBe(true);
        expect(stores.group.audit.lastHash(G)).toBe(auditBefore[auditBefore.length - 1]?.hash);
        // New events still chain onto the stored head.
        const next = stores.group.audit.append(
          auditInput({
            type: 'data.deleted',
            tripId: null,
            payload: { scope: 'trip', tables: counts },
          }),
        );
        expect(next.prevHash).toBe(auditBefore[auditBefore.length - 1]?.hash);
      });

      it('deleteTrip removes a pending item and its source row together when only one carries the tripId', () => {
        // pending on the trip → its trip-less source card goes too
        stores.private.putCardTransaction(DEAN, makeCard('priv_c1', DEAN, { tripId: null }));
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p1', DEAN, { sourceItemId: 'priv_c1' }),
        );
        // source email on the trip → its trip-less pending item goes too
        stores.private.putEmailReceipt(CHASE, makeEmail('priv_e1', CHASE));
        stores.private.putPendingItem(
          CHASE,
          makePending('priv_p2', CHASE, { tripId: null, source: 'email', sourceItemId: 'priv_e1' }),
        );
        // unrelated trip-less pair stays
        stores.private.putCardTransaction(DEAN, makeCard('priv_c9', DEAN, { tripId: null }));
        stores.private.putPendingItem(
          DEAN,
          makePending('priv_p9', DEAN, { tripId: null, sourceItemId: 'priv_c9' }),
        );

        const counts = stores.deleteTrip(TRIP);
        expect(counts.card_transactions).toBe(1);
        expect(counts.email_receipts).toBe(1);
        expect(counts.pending_private_items).toBe(2);
        expect(stores.private.getCardTransaction(DEAN, 'priv_c1')).toBeUndefined();
        expect(stores.private.getPendingItem(DEAN, 'priv_p1')).toBeUndefined();
        expect(stores.private.getEmailReceipt(CHASE, 'priv_e1')).toBeUndefined();
        expect(stores.private.getPendingItem(CHASE, 'priv_p2')).toBeUndefined();
        expect(stores.private.getCardTransaction(DEAN, 'priv_c9')).toBeDefined();
        expect(stores.private.getPendingItem(DEAN, 'priv_p9')).toBeDefined();
      });

      it('deleteTrip of an unknown trip deletes nothing; redactAuditPayloads is idempotent', () => {
        seedTrip(TRIP, 'a');
        const counts = stores.deleteTrip('trip_unknown');
        expect(Object.values(counts).every((n) => n === 0)).toBe(true);
        expect(stores.redactAuditPayloads(TRIP)).toBe(2);
        expect(stores.redactAuditPayloads(TRIP)).toBe(0);
        expect(stores.group.trips.get(TRIP)).toBeDefined();
        expect(stores.group.audit.listByGroup(G).every((e) => e.payload.redacted === true)).toBe(
          true,
        );
        expect(verifyAuditChain(stores.group.audit.listByGroup(G)).ok).toBe(true);
        expectTravError(() => stores.deleteTrip(''), 'invalid_argument');
      });

      it('a tombstoned incomplete grant cannot launder a purchase (lifecycle header survives redaction)', () => {
        const flow = (complete: boolean): void => {
          stores.group.audit.append(
            auditInput({
              type: 'policy.evaluated',
              proposalId: 'prop_1',
              payload: { outcome: 'needs_confirmation' },
            }),
          );
          stores.group.audit.append(
            auditInput({
              type: 'approval.granted',
              proposalId: 'prop_1',
              payload: { memberId: DEAN, via: 'button', messageId: 'msg_1', complete },
            }),
          );
          stores.group.audit.append(
            auditInput({ type: 'booking.completed', proposalId: 'prop_1', bookingId: 'bk_1' }),
          );
        };
        flow(false);
        expect(
          verifyAuditChain(stores.group.audit.listByGroup(G)).problems.map((p) => p.problem),
        ).toEqual(['completed_without_grant']);
        expect(stores.redactAuditPayloads(TRIP)).toBe(3);
        const redacted = stores.group.audit.listByGroup(G);
        expect(redacted.map((e) => e.lifecycle)).toEqual([
          { outcome: 'needs_confirmation' },
          { complete: false },
          undefined,
        ]);
        expect(verifyAuditChain(redacted).problems.map((p) => p.problem)).toEqual([
          'completed_without_grant',
        ]);
      });
    });

    // ---------- runtime state (T-185, D-054) ----------
    describe('runtime state (T-185)', () => {
      const entry = (
        key: string,
        value: unknown,
        groupId: string | null = G,
        namespace = 'card',
      ): RuntimeStateEntry => ({ namespace, groupId, key, value });

      it('put/get round-trips JSON; an upsert keeps its place, a delete then put moves to the back', () => {
        const rt = stores.group.runtime;
        rt.put(entry('msg_1', { cardId: 'card_1', expiresAt: undefined, n: 1 }));
        rt.put(entry('msg_2', ['a', 'b']));
        rt.put(entry('msg_3', 'three'));
        expect(rt.get('card', G, 'msg_1')).toEqual(entry('msg_1', { cardId: 'card_1', n: 1 }));
        rt.put(entry('msg_1', { cardId: 'card_1', n: 2 }));
        expect(rt.list('card').map((e) => e.key)).toEqual(['msg_1', 'msg_2', 'msg_3']);
        expect(rt.get('card', G, 'msg_1')?.value).toEqual({ cardId: 'card_1', n: 2 });
        expect(rt.delete('card', G, 'msg_1')).toBe(true);
        expect(rt.delete('card', G, 'msg_1')).toBe(false);
        expect(rt.get('card', G, 'msg_1')).toBeUndefined();
        rt.put(entry('msg_1', 0));
        expect(rt.list('card').map((e) => e.key)).toEqual(['msg_2', 'msg_3', 'msg_1']);
        // A read is a detached copy.
        const got = rt.get('card', G, 'msg_2')?.value as string[];
        got.push('mutated');
        expect(rt.get('card', G, 'msg_2')?.value).toEqual(['a', 'b']);
      });

      it('namespaces and groups are separate; null is the runtime-wide scope', () => {
        const rt = stores.group.runtime;
        rt.put(entry('k', 'bcn', G));
        rt.put(entry('k', 'lis', G2));
        rt.put(entry('k', 'all', null));
        rt.put(entry('k', 'other ns', G, 'recent'));
        expect(rt.get('card', G, 'k')?.value).toBe('bcn');
        expect(rt.get('card', G2, 'k')?.value).toBe('lis');
        expect(rt.get('card', null, 'k')?.value).toBe('all');
        expect(rt.get('recent', G, 'k')?.value).toBe('other ns');
        expect(rt.list('card', { groupId: G }).map((e) => e.value)).toEqual(['bcn']);
        expect(rt.list('card', { groupId: null }).map((e) => e.value)).toEqual(['all']);
        expect(rt.list('card').map((e) => e.value)).toEqual(['bcn', 'lis', 'all']);
        expect(rt.list('nothing')).toEqual([]);
        // A composite key never collides through a separator in its parts.
        rt.put(entry('a|b', 1, 'g|x'));
        rt.put(entry('x|a|b', 2, 'g'));
        expect(rt.get('card', 'g|x', 'a|b')?.value).toBe(1);
        expect(rt.get('card', 'g', 'x|a|b')?.value).toBe(2);
      });

      it('tripId round-trips on both stores (absent or null ⇒ not stored) and an empty one is refused', () => {
        const rt = stores.group.runtime;
        rt.put({ namespace: 'card', groupId: G, tripId: TRIP, key: 't', value: 1 });
        rt.put({ namespace: 'card', groupId: G, tripId: null, key: 'n', value: 2 });
        expect(rt.get('card', G, 't')).toEqual({
          namespace: 'card',
          groupId: G,
          tripId: TRIP,
          key: 't',
          value: 1,
        });
        expect(Object.keys(rt.get('card', G, 'n') ?? {})).not.toContain('tripId');
        stores.private.putRuntimeState(DEAN, {
          namespace: 'card',
          groupId: G,
          tripId: TRIP,
          key: 'd',
          value: 3,
        });
        expect(stores.private.getRuntimeState(DEAN, 'card', G, 'd')?.tripId).toBe(TRIP);
        expectTravError(
          () => rt.put({ namespace: 'card', groupId: G, tripId: '', key: 'x', value: 1 }),
          'invalid_argument',
        );
        expectTravError(
          () =>
            stores.private.putRuntimeState(DEAN, {
              namespace: 'card',
              groupId: G,
              tripId: '',
              key: 'x',
              value: 1,
            }),
          'invalid_argument',
        );
      });

      it('rejects an empty namespace or group id and an undefined value', () => {
        const rt = stores.group.runtime;
        expectTravError(() => rt.put(entry('k', 1, G, '')), 'invalid_argument');
        expectTravError(() => rt.put(entry('k', 1, '')), 'invalid_argument');
        expectTravError(() => rt.put(entry('k', undefined)), 'invalid_argument');
        expectTravError(() => rt.list(''), 'invalid_argument');
      });

      it('seen keys: add is idempotent; past the cap the oldest key is dropped; sets are separate', () => {
        const seen = stores.group.runtime.seenKeys('agent', 3);
        expect(seen.has('e1')).toBe(false);
        seen.add('e1');
        seen.add('e1');
        seen.add('e2');
        seen.add('e3');
        expect(['e1', 'e2', 'e3'].map((k) => seen.has(k))).toEqual([true, true, true]);
        seen.add('e4');
        expect(['e1', 'e2', 'e3', 'e4'].map((k) => seen.has(k))).toEqual([false, true, true, true]);
        // Another handle on the same set sees the same keys; another set is separate.
        expect(stores.group.runtime.seenKeys('agent', 3).has('e4')).toBe(true);
        const relay = stores.group.runtime.seenKeys('relay', 3);
        expect(relay.has('e4')).toBe(false);
        relay.add('e4');
        expect(seen.has('e2')).toBe(true);
        // An evicted key can be seen again.
        seen.add('e1');
        expect(seen.has('e1')).toBe(true);
        expect(seen.has('e2')).toBe(false);
        expectTravError(() => stores.group.runtime.seenKeys('agent', 0), 'invalid_argument');
        expectTravError(() => stores.group.runtime.seenKeys('', 3), 'invalid_argument');
      });

      it('jobs: put replaces by id and moves it to the back; delete of an unknown id is a no-op', () => {
        const rt = stores.group.runtime;
        const job = (jobId: string, runAt = T0): ScheduledJob => ({
          jobId,
          groupId: G,
          tripId: TRIP,
          kind: 'proposal_expiry',
          runAt,
          payload: { proposalId: `prop_${jobId}` },
        });
        rt.putJob(job('a'));
        rt.putJob(job('b'));
        rt.putJob(job('a', '2026-03-15T10:00:00+01:00'));
        expect(rt.listJobs().map((j) => [j.jobId, j.runAt])).toEqual([
          ['b', T0],
          ['a', '2026-03-15T10:00:00+01:00'],
        ]);
        rt.deleteJob('b');
        rt.deleteJob('nope');
        expect(rt.listJobs().map((j) => j.jobId)).toEqual(['a']);
      });

      it('a stored scheduler on these stores behaves exactly like the in-memory scheduler', () => {
        const stored = createStoredScheduler(stores.group.runtime);
        const memory = createInMemoryScheduler();
        const job = (jobId: string, runAt: string): ScheduledJob => ({
          jobId,
          groupId: G,
          tripId: null,
          kind: 'morning_after',
          runAt,
          payload: {},
        });
        const ops: ((s: Scheduler) => unknown)[] = [
          (s) => s.schedule(job('a', '2026-03-15T10:00:00+01:00')),
          (s) => s.schedule(job('b', '2026-03-15T09:00:00+00:00')), // same instant as a
          (s) => s.schedule(job('c', '2026-03-14T23:00:00+01:00')),
          (s) => s.schedule(job('a', '2026-03-15T10:00:00+01:00')), // moves behind b
          (s) => s.peek(),
          (s) => s.list(),
          (s) => s.cancel('c'),
          (s) => s.schedule(job('d', '2026-03-16T10:00:00+01:00')),
          (s) => s.drain('2026-03-15T10:00:00+01:00'),
          (s) => s.list(),
          (s) => s.drain('2026-03-17T10:00:00+01:00'),
          (s) => s.peek(),
        ];
        for (const op of ops) expect(op(stored)).toEqual(op(memory));
        expect(() => stored.schedule(job('', T0))).toThrow(TravError);
        expect(() => stored.schedule(job('x', '2026-03-15T10:00:00'))).toThrow(TravError);
        expect(stores.group.runtime.listJobs()).toEqual([]);
      });

      it('private runtime state is owner-scoped, branded, and goes with the partition', () => {
        const p = stores.private;
        p.putRuntimeState(DEAN, entry('dm', [{ text: 'dean dm' }], G, 'recent'));
        p.putRuntimeState(DEAN, entry('dm', 'lisbon', G2, 'recent'));
        p.putRuntimeState(DEAN, entry('x', 1, null, 'recent'));
        p.putRuntimeState(CHASE, entry('dm', [{ text: 'chase dm' }], G, 'recent'));
        expect(p.getRuntimeState(DEAN, 'recent', G, 'dm')?.value).toEqual([{ text: 'dean dm' }]);
        expect(p.getRuntimeState(CHASE, 'recent', G, 'dm')?.value).toEqual([{ text: 'chase dm' }]);
        expect(p.getRuntimeState(HENRY, 'recent', G, 'dm')).toBeUndefined();
        expect(p.listRuntimeState(DEAN, 'recent').map((e) => e.value)).toEqual([
          [{ text: 'dean dm' }],
          'lisbon',
          1,
        ]);
        expect(p.listRuntimeState(DEAN, 'recent', { groupId: G2 }).map((e) => e.value)).toEqual([
          'lisbon',
        ]);
        expect(p.listRuntimeState(DEAN, 'recent', { groupId: null }).map((e) => e.key)).toEqual([
          'x',
        ]);
        // The entry shape is the GroupStore's: no owner column leaks into it.
        expect(Object.keys(p.getRuntimeState(DEAN, 'recent', G, 'dm') ?? {}).sort()).toEqual([
          'groupId',
          'key',
          'namespace',
          'value',
        ]);
        // Nothing of it is in the GroupStore's runtime state.
        expect(stores.group.runtime.list('recent')).toEqual([]);
        expect(p.deleteRuntimeState(CHASE, 'recent', G, 'x')).toBe(false);
        expect(p.deleteRuntimeState(DEAN, 'recent', null, 'x')).toBe(true);
        expect(p.deletePartition(DEAN).private_runtime_state).toBe(2);
        expect(p.listRuntimeState(DEAN, 'recent')).toEqual([]);
        expect(p.getRuntimeState(CHASE, 'recent', G, 'dm')?.value).toEqual([{ text: 'chase dm' }]);
        expectTravError(() => p.putRuntimeState('', entry('k', 1)), 'invalid_argument');
        expectTravError(() => p.listRuntimeState(DEAN, ''), 'invalid_argument');
      });
    });

    describe('lifecycle', () => {
      it('close() is idempotent and the store refuses use afterwards', () => {
        stores.close();
        stores.close();
        expectTravError(() => stores.group.groups.list(), 'invariant_violation');
        expectTravError(() => stores.group.audit.append(auditInput()), 'invariant_violation');
      });
    });
  });
}
