/**
 * The `Stores` facade over one backend (T-005): both stores, plus the two
 * cross-store retention operations of SAFETY §2.9.
 */
import type { Clock } from '../../clock.js';
import type { IdGenerator } from '../../ids.js';
import type { Stores } from '../../repositories.js';
import { isTombstone, tombstonePayload } from '../../audit/index.js';
import type { TripId } from '../../primitives.js';
import type { Backend } from './backend.js';
import {
  activitiesSpec,
  attendanceSpec,
  auditEventsSpec,
  bookingsSpec,
  cardTransactionsSpec,
  decisionsSpec,
  emailReceiptsSpec,
  expensesSpec,
  grantsSpec,
  groupMemorySpec,
  ledgerEntriesSpec,
  memberMemorySpec,
  pendingItemsSpec,
  proposalsSpec,
  receiptScansSpec,
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
  const memberMemory = backend.table(memberMemorySpec);
  const tickets = backend.table(ticketArtifactsSpec);

  /**
   * Rewrites payloads to `{ redacted: true, payloadHash }` (SAFETY §2.9, D-016).
   * The stored `hash` is NOT recomputed: it committed to the payload through
   * that same digest, so the chain still verifies in full, header included.
   */
  const redact = (tripId: TripId): number => {
    let changed = 0;
    for (const event of audit.find({ trip_id: tripId })) {
      if (isTombstone(event.payload)) continue;
      audit.upsert({ ...event, payload: tombstonePayload(event.payload) });
      changed += 1;
    }
    return changed;
  };

  let closed = false;

  return {
    group,
    private: priv,

    deleteTrip(tripId) {
      requireId(tripId, 'tripId');
      return backend.transaction(() => {
        const byTrip = { trip_id: tripId };
        const activityIds = activities.find(byTrip).map((a) => a.activityId);
        const proposalIds = proposals.find(byTrip).map((p) => p.proposalId);
        const bookingIds = bookings.find(byTrip).map((b) => b.bookingId);
        const sumOver = (keys: readonly string[], del: (key: string) => number): number =>
          keys.reduce((n, key) => n + del(key), 0);

        const counts: Record<string, number> = {};
        // Children first, then parents (no FKs, but keep the order honest).
        counts.attendance = sumOver(activityIds, (id) =>
          attendance.deleteWhere({ activity_id: id }),
        );
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
      });
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
