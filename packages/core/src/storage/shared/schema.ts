/**
 * Table specs shared by both backends: primary key, indexed columns and unique
 * groups. The SQLite migrations (`../sqlite/migrations.ts`) create these exact
 * columns; `sqlite.test.ts` checks the two agree.
 */
import type { AuditEventId, MemberId, ProposalId } from '../../primitives.js';
import type { ScheduledJob } from '../../clock.js';
import type { RuntimeStateEntry } from '../../repositories.js';
import type { Group, Member } from '../../domain/group.js';
import type { Activity, Attendance, Trip } from '../../domain/trip.js';
import type {
  Expense,
  ExpenseSourceRef,
  LedgerEntry,
  SettlementPayment,
} from '../../domain/expense.js';
import type { Booking, BookingProposal } from '../../domain/booking.js';
import type { ApprovalGrant, MemberSpendingPrefs, PolicyDecision } from '../../domain/approval.js';
import type { AuditEvent } from '../../domain/audit.js';
import type { ConsentFlags } from '../../domain/consent.js';
import type { PaymentProfile } from '../../domain/payments.js';
import type { GroupMemoryFact, MemberMemoryFact } from '../../domain/memory.js';
import type {
  CardTransaction,
  EmailReceipt,
  PendingPrivateItem,
  ReceiptScan,
  TicketArtifact,
} from '../../privacy.js';
import type { TableName, TableSpec } from './backend.js';

/** Stored ledger entries carry their position so `replace` keeps the caller's order. */
export interface StoredLedgerEntry {
  readonly position: number;
  readonly entry: LedgerEntry;
}

export interface StoredDecision {
  readonly proposalId: ProposalId;
  readonly decision: PolicyDecision;
  readonly auditEventId: AuditEventId;
}

export function sourceRefKey(ref: ExpenseSourceRef): string {
  return `${ref.kind}:${ref.id}`;
}

export const groupsSpec: TableSpec<Group> = {
  name: 'groups',
  key: (g) => g.groupId,
  columns: { conversation_id: (g) => g.conversationId },
  unique: [['conversation_id']],
};

export const membersSpec: TableSpec<Member> = {
  name: 'members',
  key: (m) => m.memberId,
  columns: { group_id: (m) => m.groupId, sender_id: (m) => m.senderId },
  // One channel identity maps to exactly one member per group (SAFETY §2.5).
  unique: [['group_id', 'sender_id']],
};

export const tripsSpec: TableSpec<Trip> = {
  name: 'trips',
  key: (t) => t.tripId,
  columns: { group_id: (t) => t.groupId },
};

export const activitiesSpec: TableSpec<Activity> = {
  name: 'activities',
  key: (a) => a.activityId,
  columns: { trip_id: (a) => a.tripId, group_id: (a) => a.groupId },
};

export const attendanceSpec: TableSpec<Attendance> = {
  name: 'attendance',
  key: (a) => `${a.activityId}|${a.memberId}`,
  columns: { activity_id: (a) => a.activityId, member_id: (a) => a.memberId },
};

export const expensesSpec: TableSpec<Expense> = {
  name: 'expenses',
  key: (e) => e.expenseId,
  columns: {
    trip_id: (e) => e.tripId,
    group_id: (e) => e.groupId,
    source_key: (e) => sourceRefKey(e.sourceRef),
  },
  unique: [['source_key']],
};

export const ledgerEntriesSpec: TableSpec<StoredLedgerEntry> = {
  name: 'ledger_entries',
  key: (r) => `${r.entry.expenseId}|${String(r.position)}`,
  columns: { expense_id: (r) => r.entry.expenseId, trip_id: (r) => r.entry.tripId },
};

export const proposalsSpec: TableSpec<BookingProposal> = {
  name: 'proposals',
  key: (p) => p.proposalId,
  columns: {
    group_id: (p) => p.groupId,
    trip_id: (p) => p.tripId,
    status: (p) => p.status,
  },
};

export const decisionsSpec: TableSpec<StoredDecision> = {
  name: 'decisions',
  key: (d) => d.proposalId,
  columns: { proposal_id: (d) => d.proposalId },
};

export const grantsSpec: TableSpec<ApprovalGrant> = {
  name: 'grants',
  key: (g) => g.grantId,
  columns: { proposal_id: (g) => g.proposalId },
};

export const bookingsSpec: TableSpec<Booking> = {
  name: 'bookings',
  key: (b) => b.bookingId,
  columns: {
    group_id: (b) => b.groupId,
    trip_id: (b) => b.tripId,
    proposal_id: (b) => b.proposalId,
    idempotency_key: (b) => b.idempotencyKey,
  },
  unique: [['idempotency_key']],
};

export const auditEventsSpec: TableSpec<AuditEvent> = {
  name: 'audit_events',
  key: (e) => e.id,
  columns: {
    group_id: (e) => e.groupId,
    trip_id: (e) => e.tripId,
    type: (e) => e.type,
    visibility: (e) => e.visibility,
    proposal_id: (e) => e.proposalId ?? null,
    booking_id: (e) => e.bookingId ?? null,
  },
};

export const groupMemorySpec: TableSpec<GroupMemoryFact> = {
  name: 'group_memory',
  key: (f) => f.factId,
  columns: { group_id: (f) => f.groupId, source_trip_id: (f) => f.sourceTripId },
};

export function settlementSourceKey(
  p: Pick<SettlementPayment, 'cardMessageId' | 'from' | 'to'>,
): string {
  return `${p.cardMessageId}|${p.from}|${p.to}`;
}

/** T-141 (D-034): transfers a member said they paid. One per (card, from, to). */
export const settlementsSpec: TableSpec<SettlementPayment> = {
  name: 'settlements',
  key: (p) => p.paymentId,
  columns: {
    trip_id: (p) => p.tripId,
    group_id: (p) => p.groupId,
    source_key: (p) => settlementSourceKey(p),
  },
  unique: [['source_key']],
};

// ---------- private ----------

export const cardTransactionsSpec: TableSpec<CardTransaction> = {
  name: 'card_transactions',
  key: (t) => t.id,
  columns: {
    owner_member_id: (t) => t.ownerMemberId,
    group_id: (t) => t.groupId,
    trip_id: (t) => t.tripId,
    provider_transaction_id: (t) => t.providerTransactionId,
  },
  unique: [['owner_member_id', 'provider_transaction_id']],
};

export const emailReceiptsSpec: TableSpec<EmailReceipt> = {
  name: 'email_receipts',
  key: (e) => e.id,
  columns: {
    owner_member_id: (e) => e.ownerMemberId,
    group_id: (e) => e.groupId,
    trip_id: (e) => e.tripId,
  },
};

export const receiptScansSpec: TableSpec<ReceiptScan> = {
  name: 'receipt_scans',
  key: (s) => s.id,
  columns: {
    owner_member_id: (s) => s.ownerMemberId,
    group_id: (s) => s.groupId,
    trip_id: (s) => s.tripId,
  },
};

export const pendingItemsSpec: TableSpec<PendingPrivateItem> = {
  name: 'pending_private_items',
  key: (p) => p.id,
  columns: {
    owner_member_id: (p) => p.ownerMemberId,
    group_id: (p) => p.groupId,
    trip_id: (p) => p.tripId,
    status: (p) => p.status,
    source_item_id: (p) => p.sourceItemId,
  },
};

export const consentSpec: TableSpec<ConsentFlags> = {
  name: 'consent',
  key: (c) => `${c.memberId}|${c.groupId}`,
  columns: { owner_member_id: (c) => c.memberId, group_id: (c) => c.groupId },
};

export const memberPrefsSpec: TableSpec<MemberSpendingPrefs> = {
  name: 'member_prefs',
  key: (p) => p.memberId,
  columns: { owner_member_id: (p) => p.memberId },
};

export const memberMemorySpec: TableSpec<MemberMemoryFact> = {
  name: 'member_memory',
  key: (f) => f.factId,
  columns: {
    owner_member_id: (f) => f.ownerMemberId,
    group_id: (f) => f.groupId,
    source_trip_id: (f) => f.sourceTripId,
  },
};

export const ticketArtifactsSpec: TableSpec<TicketArtifact> = {
  name: 'ticket_artifacts',
  key: (t) => t.id,
  columns: {
    owner_member_id: (t) => t.ownerMemberId,
    trip_id: (t) => t.tripId,
    booking_id: (t) => t.bookingId,
  },
};

/** T-166 (D-043): a member's payment apps, favourite and handles. Owner-private. */
export const paymentProfilesSpec: TableSpec<PaymentProfile> = {
  name: 'payment_profiles',
  key: (p) => p.memberId,
  columns: { owner_member_id: (p) => p.memberId },
};

// ---------- runtime state (T-185, D-054) ----------

/** One seen key of a named set (agent dedupe, relay provider ids). */
export interface StoredSeenKey {
  readonly namespace: string;
  readonly key: string;
}

/** A DM-lane runtime entry in its owner's partition. */
export interface StoredPrivateRuntimeEntry extends RuntimeStateEntry {
  readonly ownerMemberId: MemberId;
}

/** The composite keys are JSON arrays, so no separator inside a part can collide. */
export function runtimeStateKey(namespace: string, groupId: string | null, key: string): string {
  return JSON.stringify([namespace, groupId, key]);
}

export function privateRuntimeStateKey(
  ownerMemberId: string,
  namespace: string,
  groupId: string | null,
  key: string,
): string {
  return JSON.stringify([ownerMemberId, namespace, groupId, key]);
}

export function seenKeyKey(namespace: string, key: string): string {
  return JSON.stringify([namespace, key]);
}

export const runtimeStateSpec: TableSpec<RuntimeStateEntry> = {
  name: 'runtime_state',
  key: (e) => runtimeStateKey(e.namespace, e.groupId, e.key),
  columns: { state_ns: (e) => e.namespace, group_id: (e) => e.groupId },
};

export const seenKeysSpec: TableSpec<StoredSeenKey> = {
  name: 'seen_keys',
  key: (s) => seenKeyKey(s.namespace, s.key),
  columns: { state_ns: (s) => s.namespace },
};

export const scheduledJobsSpec: TableSpec<ScheduledJob> = {
  name: 'scheduled_jobs',
  key: (j) => j.jobId,
  // trip_id: "forget this trip" drops the trip's queued jobs (SAFETY §2.9).
  columns: { group_id: (j) => j.groupId, trip_id: (j) => j.tripId },
};

export const privateRuntimeStateSpec: TableSpec<StoredPrivateRuntimeEntry> = {
  name: 'private_runtime_state',
  key: (e) => privateRuntimeStateKey(e.ownerMemberId, e.namespace, e.groupId, e.key),
  columns: {
    owner_member_id: (e) => e.ownerMemberId,
    state_ns: (e) => e.namespace,
    group_id: (e) => e.groupId,
  },
};

/** Every spec, keyed by table name (the SQLite schema test iterates this). */
export const ALL_SPECS: Readonly<Record<TableName, TableSpec<never>>> = {
  groups: groupsSpec as TableSpec<never>,
  members: membersSpec as TableSpec<never>,
  trips: tripsSpec as TableSpec<never>,
  activities: activitiesSpec as TableSpec<never>,
  attendance: attendanceSpec as TableSpec<never>,
  expenses: expensesSpec as TableSpec<never>,
  ledger_entries: ledgerEntriesSpec as TableSpec<never>,
  proposals: proposalsSpec as TableSpec<never>,
  decisions: decisionsSpec as TableSpec<never>,
  grants: grantsSpec as TableSpec<never>,
  bookings: bookingsSpec as TableSpec<never>,
  audit_events: auditEventsSpec as TableSpec<never>,
  group_memory: groupMemorySpec as TableSpec<never>,
  settlements: settlementsSpec as TableSpec<never>,
  card_transactions: cardTransactionsSpec as TableSpec<never>,
  email_receipts: emailReceiptsSpec as TableSpec<never>,
  receipt_scans: receiptScansSpec as TableSpec<never>,
  pending_private_items: pendingItemsSpec as TableSpec<never>,
  consent: consentSpec as TableSpec<never>,
  member_prefs: memberPrefsSpec as TableSpec<never>,
  member_memory: memberMemorySpec as TableSpec<never>,
  ticket_artifacts: ticketArtifactsSpec as TableSpec<never>,
  payment_profiles: paymentProfilesSpec as TableSpec<never>,
  runtime_state: runtimeStateSpec as TableSpec<never>,
  seen_keys: seenKeysSpec as TableSpec<never>,
  scheduled_jobs: scheduledJobsSpec as TableSpec<never>,
  private_runtime_state: privateRuntimeStateSpec as TableSpec<never>,
};
