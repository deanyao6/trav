/**
 * Repository interfaces (T-005). Two stores, two shapes:
 * - `GroupStore`: everything that may appear in the group chat.
 * - `PrivateStore`: every method takes `ownerMemberId` FIRST and scopes by it;
 *   there is no list-all (SAFETY C3). Values are `Private<...>` types.
 *
 * Methods are synchronous: `node:sqlite` is synchronous and the in-memory
 * implementation is trivially so; this keeps the shared repository test suite
 * and the pure core functions simple. The agent is async anyway.
 *
 * Both implementations (`packages/core/src/storage/memory/`, `.../sqlite/`)
 * must pass the same suite: `packages/core/src/storage/repository.suite.ts`.
 */
import type {
  ActivityId,
  AuditEventId,
  BookingId,
  ExpenseId,
  GrantId,
  GroupId,
  IdempotencyKey,
  IsoDateTime,
  MemberId,
  PrivateItemId,
  ProposalId,
  SenderId,
  TripId,
} from './primitives.js';
import type { Group, Member } from './domain/group.js';
import type { Activity, Attendance, Trip } from './domain/trip.js';
import type {
  Expense,
  ExpenseSourceRef,
  LedgerEntry,
  SettlementPayment,
} from './domain/expense.js';
import type { Booking, BookingProposal } from './domain/booking.js';
import type { ApprovalGrant, MemberSpendingPrefs, PolicyDecision } from './domain/approval.js';
import type { AuditEvent, AuditEventInput, AuditEventType } from './domain/audit.js';
import type { ConsentFlags } from './domain/consent.js';
import type { PaymentProfile } from './domain/payments.js';
import type { GroupMemoryFact, MemberMemoryFact } from './domain/memory.js';
import type {
  CardTransaction,
  EmailReceipt,
  PendingPrivateItem,
  PendingItemStatus,
  Private,
  ReceiptScan,
  TicketArtifact,
} from './privacy.js';
import type { ScheduledJobStore } from './clock.js';

// ---------- GroupStore ----------

export interface GroupRepository {
  create(group: Group): void;
  get(groupId: GroupId): Group | undefined;
  getByConversation(conversationId: string): Group | undefined;
  update(group: Group): void;
  list(): readonly Group[];
}

export interface MemberRepository {
  upsert(member: Member): void;
  get(memberId: MemberId): Member | undefined;
  /** Identity lookup: the channel's sender id for this group. */
  getBySenderId(groupId: GroupId, senderId: SenderId): Member | undefined;
  /** In join order; this is the "member order" used by splits and lists. */
  listByGroup(groupId: GroupId, opts?: { readonly activeOnly?: boolean }): readonly Member[];
}

export interface TripRepository {
  create(trip: Trip): void;
  get(tripId: TripId): Trip | undefined;
  update(trip: Trip): void;
  listByGroup(groupId: GroupId): readonly Trip[];
  /** The planning/active trip for the group, if any. */
  current(groupId: GroupId, now: IsoDateTime): Trip | undefined;

  upsertActivity(activity: Activity): void;
  getActivity(activityId: ActivityId): Activity | undefined;
  listActivities(
    tripId: TripId,
    range?: { readonly from: IsoDateTime; readonly to: IsoDateTime },
  ): readonly Activity[];

  /** Upsert by (activityId, memberId). */
  setAttendance(row: Attendance): void;
  listAttendance(activityId: ActivityId): readonly Attendance[];
}

export interface ExpenseRepository {
  /** Throws `duplicate` on an existing expenseId or an existing `sourceRef` (idempotent booking/promotion writes). */
  create(expense: Expense, entries: readonly LedgerEntry[]): void;
  get(expenseId: ExpenseId): Expense | undefined;
  getBySourceRef(ref: ExpenseSourceRef): Expense | undefined;
  /** Replaces the expense and its entries (undo, edit). */
  replace(expense: Expense, entries: readonly LedgerEntry[]): void;
  listByTrip(tripId: TripId, opts?: { readonly includeUndone?: boolean }): readonly Expense[];
  listEntries(tripId: TripId): readonly LedgerEntry[];
  /**
   * T-165: subscribe to committed `create`s (after the write; never for a
   * `duplicate` or a failed write; `replace` is not a create). Listeners run
   * synchronously in subscription order; one that throws neither undoes the
   * write nor stops the others. This is the single hook the agent's group
   * expense notices hang off, so a new ingestion path cannot forget to
   * announce itself. Returns the unsubscribe function.
   */
  onCreate(listener: (expense: Expense) => void): () => void;
  /**
   * T-165 r2: subscribe to committed undos: a `replace` that turns a `logged`
   * expense `undone` (after the write; never for an edit that stays logged,
   * an already-undone row, or a failed write). Same listener rules as
   * `onCreate`. The agent posts a correction for an expense its notice
   * already announced. Returns the unsubscribe function.
   */
  onUndo(listener: (expense: Expense) => void): () => void;
}

/**
 * Settle-up transfers members said they paid (T-141, D-034). Append-only in
 * v0 (T-037 adds confirm/dispute/cancel). Unique on (cardMessageId, from, to):
 * a second tick of the same transfer on the same card is a `duplicate`.
 */
export interface SettlementRepository {
  /** Throws `duplicate` on an existing paymentId or the same (cardMessageId, from, to). */
  record(payment: SettlementPayment): void;
  /**
   * T-166: replace a recorded payment's state (Sent → Got it, undo). Same
   * paymentId, trip and (cardMessageId, from, to, amount); `not_found` for an
   * unknown id, `invalid_argument` if any of those changed.
   */
  update(payment: SettlementPayment): void;
  /** In the order they were recorded. */
  listByTrip(tripId: TripId): readonly SettlementPayment[];
}

export interface BookingRepository {
  createProposal(p: BookingProposal): void;
  getProposal(proposalId: ProposalId): BookingProposal | undefined;
  updateProposal(p: BookingProposal): void;
  listPendingProposals(groupId: GroupId): readonly BookingProposal[];

  saveDecision(decision: PolicyDecision, auditEventId: AuditEventId): void;
  getDecision(
    proposalId: ProposalId,
  ): { readonly decision: PolicyDecision; readonly auditEventId: AuditEventId } | undefined;

  saveGrant(grant: ApprovalGrant): void;
  getGrant(grantId: GrantId): ApprovalGrant | undefined;
  getGrantForProposal(proposalId: ProposalId): ApprovalGrant | undefined;

  /** Throws `duplicate` on an existing bookingId or idempotencyKey. */
  createBooking(b: Booking): void;
  getBooking(bookingId: BookingId): Booking | undefined;
  getBookingByKey(key: IdempotencyKey): Booking | undefined;
  updateBooking(b: Booking): void;
  listByTrip(tripId: TripId): readonly Booking[];
  /** Σ totalMinor of confirmed bookings purchased in [from, to], for the daily/trip caps. */
  spentBetween(groupId: GroupId, from: IsoDateTime, to: IsoDateTime): number;
}

/**
 * Append-only. No update, no delete (SAFETY B2; grep test). The repository
 * assigns id/ts/prevHash/hash and rejects payloads with private keys.
 * Redaction (§2.9) is a separate `redactPayloads(tripId)` on the store facade,
 * which rewrites `payload` to the tombstone `{ redacted: true, payloadHash }` (D-016) and leaves hashes untouched.
 */
export interface AuditRepository {
  append(input: AuditEventInput): AuditEvent;
  get(id: AuditEventId): AuditEvent | undefined;
  listByGroup(
    groupId: GroupId,
    opts?: { readonly types?: readonly AuditEventType[]; readonly since?: IsoDateTime },
  ): readonly AuditEvent[];
  listByProposal(proposalId: ProposalId): readonly AuditEvent[];
  listByBooking(bookingId: BookingId): readonly AuditEvent[];
  /** Group-visible only (visibility === 'group'); the simulator audit panel uses this. */
  listGroupVisible(groupId: GroupId): readonly AuditEvent[];
  lastHash(groupId: GroupId): string;
}

export interface GroupMemoryRepository {
  upsert(fact: GroupMemoryFact): void;
  listByGroup(
    groupId: GroupId,
    opts?: { readonly tripId?: TripId; readonly limit?: number },
  ): readonly GroupMemoryFact[];
  delete(factId: string): void;
}

/**
 * T-185 (D-054): one entry of the agent runtime's own state (the pending card
 * index, recent group lines, who was asked what, dedupe keys…), so a restart
 * keeps it. `value` is any JSON value; it is stored as JSON (undefined fields
 * dropped, no object identity). GroupStore entries hold ids and group-lane
 * state only; a member's DM-lane state goes to `PrivateStore.putRuntimeState`.
 */
export interface RuntimeStateEntry {
  /** What the entry is, e.g. `'card'`, `'recent'`. */
  readonly namespace: string;
  /** The group it belongs to; `null` for runtime-wide entries. */
  readonly groupId: GroupId | null;
  /**
   * The trip it belongs to, if any (T-185 r1 #1): `Stores.deleteTrip` deletes
   * the entry with the trip. Absent or `null` ⇒ not tied to a trip.
   */
  readonly tripId?: TripId | null;
  readonly key: string;
  readonly value: unknown;
}

/**
 * A bounded set of keys already handled (inbound dedupe: the agent's event
 * keys, a relay's provider message ids). Keys only, never text. Structurally
 * the relay channel's `RelaySeenStore` (T-187), so a channel can take one.
 */
export interface SeenKeyStore {
  has(key: string): boolean;
  /** Adds the key (no-op when present); past the cap, the oldest key is dropped. */
  add(key: string): void;
}

export interface RuntimeStateRepository extends ScheduledJobStore {
  /** Upsert by (namespace, groupId, key); an existing entry keeps its position in `list`. */
  put(entry: RuntimeStateEntry): void;
  get(namespace: string, groupId: GroupId | null, key: string): RuntimeStateEntry | undefined;
  /**
   * Entries of a namespace in first-put order (a delete then put moves an
   * entry to the back). `groupId` limits it to one group (`null`: the
   * runtime-wide ones); omitted ⇒ all.
   */
  list(
    namespace: string,
    opts?: { readonly groupId?: GroupId | null },
  ): readonly RuntimeStateEntry[];
  /** Returns whether an entry was deleted. */
  delete(namespace: string, groupId: GroupId | null, key: string): boolean;
  /** The seen-key set named `namespace` (e.g. `'agent'`, `'relay'`), at most `cap` keys. */
  seenKeys(namespace: string, cap: number): SeenKeyStore;
}

export interface GroupStore {
  readonly groups: GroupRepository;
  readonly members: MemberRepository;
  readonly trips: TripRepository;
  readonly expenses: ExpenseRepository;
  readonly settlements: SettlementRepository;
  readonly bookings: BookingRepository;
  readonly audit: AuditRepository;
  readonly groupMemory: GroupMemoryRepository;
  /** T-185: the agent runtime's state, dedupe keys and scheduled jobs. */
  readonly runtime: RuntimeStateRepository;
}

// ---------- PrivateStore ----------

/** Every method: `ownerMemberId` first. No cross-owner reads exist. */
export interface PrivateStore {
  // raw ingested items
  putCardTransaction(ownerMemberId: MemberId, tx: CardTransaction): void;
  getCardTransaction(ownerMemberId: MemberId, id: PrivateItemId): CardTransaction | undefined;
  /** Match on providerTransactionId so pending → posted updates rather than duplicates. */
  getCardTransactionByProviderId(
    ownerMemberId: MemberId,
    providerTransactionId: string,
  ): CardTransaction | undefined;
  listCardTransactions(ownerMemberId: MemberId, groupId: GroupId): readonly CardTransaction[];

  putEmailReceipt(ownerMemberId: MemberId, email: EmailReceipt): void;
  getEmailReceipt(ownerMemberId: MemberId, id: PrivateItemId): EmailReceipt | undefined;
  listEmailReceipts(ownerMemberId: MemberId, groupId: GroupId): readonly EmailReceipt[];

  putReceiptScan(ownerMemberId: MemberId, scan: ReceiptScan): void;
  getReceiptScan(ownerMemberId: MemberId, id: PrivateItemId): ReceiptScan | undefined;

  // the "looks shared?" queue
  putPendingItem(ownerMemberId: MemberId, item: PendingPrivateItem): void;
  getPendingItem(ownerMemberId: MemberId, id: PrivateItemId): PendingPrivateItem | undefined;
  listPendingItems(
    ownerMemberId: MemberId,
    groupId: GroupId,
    status?: PendingItemStatus,
  ): readonly PendingPrivateItem[];
  // No cross-owner query, not even a count (T-112, SAFETY §2.3 "even a count
  // is the owner's"): every read is scoped to one owner.

  // consent, prefs, memory
  getConsent(ownerMemberId: MemberId, groupId: GroupId): ConsentFlags | undefined;
  putConsent(ownerMemberId: MemberId, consent: ConsentFlags): void;
  getPrefs(ownerMemberId: MemberId): MemberSpendingPrefs | undefined;
  putPrefs(ownerMemberId: MemberId, prefs: MemberSpendingPrefs): void;
  putMemberMemory(ownerMemberId: MemberId, fact: MemberMemoryFact): void;
  listMemberMemory(ownerMemberId: MemberId, groupId: GroupId): readonly MemberMemoryFact[];

  // tickets
  putTicket(ownerMemberId: MemberId, ticket: TicketArtifact): void;
  listTickets(ownerMemberId: MemberId, bookingId: BookingId): readonly TicketArtifact[];

  // payment profile (T-166): apps, favourite, handles. Owner-only like the rest.
  getPaymentProfile(ownerMemberId: MemberId): PaymentProfile | undefined;
  putPaymentProfile(ownerMemberId: MemberId, profile: PaymentProfile): void;

  // runtime state of the owner's DM lane (T-185, D-054): their DM lines, the
  // cards and questions Trav sent them. Same entry shape as GroupStore.runtime.
  /** Upsert by (namespace, groupId, key) within the owner's partition. */
  putRuntimeState(ownerMemberId: MemberId, entry: RuntimeStateEntry): void;
  getRuntimeState(
    ownerMemberId: MemberId,
    namespace: string,
    groupId: GroupId | null,
    key: string,
  ): Private<RuntimeStateEntry> | undefined;
  /** The owner's entries of a namespace in first-put order; `groupId` limits it to one group. */
  listRuntimeState(
    ownerMemberId: MemberId,
    namespace: string,
    opts?: { readonly groupId?: GroupId | null },
  ): readonly Private<RuntimeStateEntry>[];
  deleteRuntimeState(
    ownerMemberId: MemberId,
    namespace: string,
    groupId: GroupId | null,
    key: string,
  ): boolean;

  // retention (SAFETY §2.9)
  /** Deletes the whole partition; returns per-table row counts for `data.deleted`. */
  deletePartition(ownerMemberId: MemberId): Readonly<Record<string, number>>;
  /** Drops raw inputs (bodyText/ocrText/merchantRaw) for promoted/dismissed items older than `before`. */
  purgeRawInputs(ownerMemberId: MemberId, before: IsoDateTime): number;
}

// ---------- facade ----------

export interface Stores {
  readonly group: GroupStore;
  readonly private: PrivateStore;
  /** "forget this trip": one transaction across both stores; returns per-table counts. */
  deleteTrip(tripId: TripId): Readonly<Record<string, number>>;
  /** Rewrites audit payloads for a trip to the tombstone `{ redacted: true, payloadHash }` (D-016) without touching hashes. */
  redactAuditPayloads(tripId: TripId): number;
  close(): void;
}

export interface StoreFactoryOptions {
  /** `':memory:'` or a path under `.trav/`. */
  readonly sqlitePath?: string;
}
