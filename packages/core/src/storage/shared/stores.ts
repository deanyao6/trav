/**
 * The `Stores` facade over one backend (T-005): both stores, plus the
 * cross-store retention operations of SAFETY §2.9 ("forget this trip", and
 * T-170's "@trav leave" for a whole group).
 */
import type { Clock } from '../../clock.js';
import type { IdGenerator } from '../../ids.js';
import type { Stores } from '../../repositories.js';
import { isTombstone, tombstonePayload } from '../../audit/index.js';
import type { GroupId, TripId } from '../../primitives.js';
import type { Backend, Where } from './backend.js';
import {
  activitiesSpec,
  attendanceSpec,
  auditEventsSpec,
  bookingsSpec,
  cardTransactionsSpec,
  consentSpec,
  decisionsSpec,
  emailReceiptsSpec,
  expensesSpec,
  grantsSpec,
  groupMemorySpec,
  groupsSpec,
  ledgerEntriesSpec,
  memberMemorySpec,
  membersSpec,
  pendingItemsSpec,
  proposalsSpec,
  privateRuntimeStateSpec,
  receiptScansSpec,
  runtimeStateSpec,
  scheduledJobsSpec,
  settlementsSpec,
  ticketArtifactsSpec,
  tripsSpec,
} from './schema.js';
import { createGroupStore } from './groupRepositories.js';
import { createPrivateStore } from './privateStore.js';
import { requireId } from './util.js';

export interface StoreDeps {
  /** Audit `ts` comes from here (D-008). */
  readonly clock: Clock;
  /** Audit ids come from here (D-011). */
  readonly ids: IdGenerator;
}

/** Key in `deleteTrip` counts for the number of audit payloads redacted (rows are kept). */
export const AUDIT_REDACTED_COUNT_KEY = 'audit_events_redacted';

export function createStoresOnBackend(backend: Backend, deps: StoreDeps): Stores {
  const group = createGroupStore(backend, deps.clock, deps.ids);
  const priv = createPrivateStore(backend);

  const groups = backend.table(groupsSpec);
  const members = backend.table(membersSpec);
  const trips = backend.table(tripsSpec);
  const activities = backend.table(activitiesSpec);
  const attendance = backend.table(attendanceSpec);
  const expenses = backend.table(expensesSpec);
  const ledger = backend.table(ledgerEntriesSpec);
  const settlements = backend.table(settlementsSpec);
  const proposals = backend.table(proposalsSpec);
  const decisions = backend.table(decisionsSpec);
  const grants = backend.table(grantsSpec);
  const bookings = backend.table(bookingsSpec);
  const groupMemory = backend.table(groupMemorySpec);
  const audit = backend.table(auditEventsSpec);
  const cards = backend.table(cardTransactionsSpec);
  const emails = backend.table(emailReceiptsSpec);
  const scans = backend.table(receiptScansSpec);
  const pending = backend.table(pendingItemsSpec);
  const consent = backend.table(consentSpec);
  const memberMemory = backend.table(memberMemorySpec);
  const tickets = backend.table(ticketArtifactsSpec);
  const jobs = backend.table(scheduledJobsSpec);
  const runtimeState = backend.table(runtimeStateSpec);
  const privateRuntimeState = backend.table(privateRuntimeStateSpec);

  /**
   * Rewrites payloads to `{ redacted: true, payloadHash }` (SAFETY §2.9, D-016).
   * The stored `hash` is NOT recomputed: it committed to the payload through
   * that same digest, so the chain still verifies in full, header included.
   */
  const redactWhere = (where: Where): number => {
    let changed = 0;
    for (const event of audit.find(where)) {
      if (isTombstone(event.payload)) continue;
      audit.upsert({ ...event, payload: tombstonePayload(event.payload) });
      changed += 1;
    }
    return changed;
  };
  const redact = (tripId: TripId): number => redactWhere({ trip_id: tripId });

  const sumOver = (keys: readonly string[], del: (key: string) => number): number =>
    keys.reduce((n, key) => n + del(key), 0);

  /** Every row of one trip in both stores; runs inside the caller's transaction. */
  const deleteTripRows = (tripId: TripId): Record<string, number> => {
    const byTrip = { trip_id: tripId };
    const activityIds = activities.find(byTrip).map((a) => a.activityId);
    const proposalIds = proposals.find(byTrip).map((p) => p.proposalId);
    const bookingIds = bookings.find(byTrip).map((b) => b.bookingId);

    const counts: Record<string, number> = {};
    // Children first, then parents (no FKs, but keep the order honest).
    counts.attendance = sumOver(activityIds, (id) => attendance.deleteWhere({ activity_id: id }));
    counts.decisions = sumOver(proposalIds, (id) => decisions.deleteWhere({ proposal_id: id }));
    counts.grants = sumOver(proposalIds, (id) => grants.deleteWhere({ proposal_id: id }));
    counts.ledger_entries = ledger.deleteWhere(byTrip);
    counts.expenses = expenses.deleteWhere(byTrip);
    counts.settlements = settlements.deleteWhere(byTrip);
    counts.bookings = bookings.deleteWhere(byTrip);
    counts.proposals = proposals.deleteWhere(byTrip);
    counts.activities = activities.deleteWhere(byTrip);
    counts.group_memory = groupMemory.deleteWhere({ source_trip_id: tripId });
    counts.trips = trips.deleteKey(tripId) ? 1 : 0;
    // T-185: the trip's queued jobs (recaps, expiries) never run on a forgotten trip.
    counts.scheduled_jobs = jobs.deleteWhere(byTrip);
    // T-185 r1 #1: the agent's state filed under the trip (its cards), every owner.
    counts.runtime_state = runtimeState.deleteWhere(byTrip);
    counts.private_runtime_state = privateRuntimeState.deleteWhere(byTrip);
    // Private rows of every owner linked to the trip (SAFETY §2.9 "all owners").
    // A pending item and its source row are one unit: if either is on the
    // trip, both go, so no raw text survives behind a half-deleted pair.
    const linkedSourceIds = new Set(pending.find(byTrip).map((p) => p.sourceItemId));
    const tripSourceIds = new Set([
      ...cards.find(byTrip).map((r) => r.id),
      ...emails.find(byTrip).map((r) => r.id),
      ...scans.find(byTrip).map((r) => r.id),
    ]);
    const deleteSources = (table: typeof cards | typeof emails | typeof scans): number =>
      table.deleteWhere(byTrip) +
      sumOver([...linkedSourceIds], (id) => (table.deleteKey(id) ? 1 : 0));
    counts.card_transactions = deleteSources(cards);
    counts.email_receipts = deleteSources(emails);
    counts.receipt_scans = deleteSources(scans);
    counts.pending_private_items =
      pending.deleteWhere(byTrip) +
      sumOver([...tripSourceIds], (id) => pending.deleteWhere({ source_item_id: id }));
    counts.member_memory = memberMemory.deleteWhere({ source_trip_id: tripId });
    // Tickets match by trip or by one of the trip's bookings (a ticket row may carry tripId null).
    counts.ticket_artifacts =
      tickets.deleteWhere(byTrip) +
      sumOver(bookingIds, (id) => tickets.deleteWhere({ booking_id: id }));
    counts[AUDIT_REDACTED_COUNT_KEY] = redact(tripId);
    return counts;
  };

  /** Every row of one group in both stores (T-170 "@trav leave"); inside the caller's transaction. */
  const deleteGroupRows = (groupId: GroupId): Record<string, number> => {
    const counts: Record<string, number> = {};
    const add = (part: Readonly<Record<string, number>>): void => {
      for (const [k, n] of Object.entries(part)) counts[k] = (counts[k] ?? 0) + n;
    };
    const byGroup = { group_id: groupId };
    for (const t of trips.find(byGroup)) add(deleteTripRows(t.tripId));
    // Each member's whole private partition: consent, prefs, payment profile,
    // memory, tickets, DM-lane state. A member id belongs to one group only.
    const memberIds = members.find(byGroup).map((m) => m.memberId);
    for (const id of memberIds) add(priv.deletePartition(id));
    // Rows of the group not tied to a trip (or tied to a trip row already gone).
    const proposalIds = proposals.find(byGroup).map((p) => p.proposalId);
    const activityIds = activities.find(byGroup).map((a) => a.activityId);
    const expenseIds = expenses.find(byGroup).map((e) => e.expenseId);
    add({
      attendance: sumOver(activityIds, (id) => attendance.deleteWhere({ activity_id: id })),
      decisions: sumOver(proposalIds, (id) => decisions.deleteWhere({ proposal_id: id })),
      grants: sumOver(proposalIds, (id) => grants.deleteWhere({ proposal_id: id })),
      ledger_entries: sumOver(expenseIds, (id) => ledger.deleteWhere({ expense_id: id })),
      expenses: expenses.deleteWhere(byGroup),
      settlements: settlements.deleteWhere(byGroup),
      bookings: bookings.deleteWhere(byGroup),
      proposals: proposals.deleteWhere(byGroup),
      activities: activities.deleteWhere(byGroup),
      group_memory: groupMemory.deleteWhere(byGroup),
      scheduled_jobs: jobs.deleteWhere(byGroup),
      runtime_state: runtimeState.deleteWhere(byGroup),
      private_runtime_state: privateRuntimeState.deleteWhere(byGroup),
      card_transactions: cards.deleteWhere(byGroup),
      email_receipts: emails.deleteWhere(byGroup),
      receipt_scans: scans.deleteWhere(byGroup),
      pending_private_items: pending.deleteWhere(byGroup),
      consent: consent.deleteWhere(byGroup),
      member_memory: memberMemory.deleteWhere(byGroup),
      members: members.deleteWhere(byGroup),
      groups: groups.deleteKey(groupId) ? 1 : 0,
    });
    counts[AUDIT_REDACTED_COUNT_KEY] =
      (counts[AUDIT_REDACTED_COUNT_KEY] ?? 0) + redactWhere(byGroup);
    return counts;
  };

  let closed = false;

  return {
    group,
    private: priv,

    deleteTrip(tripId) {
      requireId(tripId, 'tripId');
      return backend.transaction(() => deleteTripRows(tripId));
    },

    deleteGroup(groupId) {
      requireId(groupId, 'groupId');
      return backend.transaction(() => deleteGroupRows(groupId));
    },

    redactAuditPayloads(tripId) {
      requireId(tripId, 'tripId');
      return backend.transaction(() => redact(tripId));
    },

    close() {
      if (closed) return;
      closed = true;
      backend.close();
    },
  };
}
