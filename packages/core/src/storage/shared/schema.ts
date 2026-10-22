/**
 * Table specs shared by both backends: primary key, indexed columns and unique
 * groups. The SQLite migrations (`../sqlite/migrations.ts`) create these exact
 * columns; `sqlite.test.ts` checks the two agree.
 */
import type { AuditEventId, ProposalId } from '../../primitives.js';
import type { Group, Member } from '../../domain/group.js';
import type { Activity, Attendance, Trip } from '../../domain/trip.js';
import type { Expense, ExpenseSourceRef, LedgerEntry } from '../../domain/expense.js';
import type { Booking, BookingProposal } from '../../domain/booking.js';
import type { ApprovalGrant, MemberSpendingPrefs, PolicyDecision } from '../../domain/approval.js';
import type { AuditEvent } from '../../domain/audit.js';
import type { ConsentFlags } from '../../domain/consent.js';
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
  card_transactions: cardTransactionsSpec as TableSpec<never>,
  email_receipts: emailReceiptsSpec as TableSpec<never>,
  receipt_scans: receiptScansSpec as TableSpec<never>,
  pending_private_items: pendingItemsSpec as TableSpec<never>,
  consent: consentSpec as TableSpec<never>,
  member_prefs: memberPrefsSpec as TableSpec<never>,
  member_memory: memberMemorySpec as TableSpec<never>,
  ticket_artifacts: ticketArtifactsSpec as TableSpec<never>,
};
