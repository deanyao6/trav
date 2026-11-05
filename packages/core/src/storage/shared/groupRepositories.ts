/**
 * GroupStore repositories, written once against `Backend` (T-005). Everything
 * here may appear in the group chat (ARCHITECTURE §3).
 */
import type { Clock } from '../../clock.js';
import { localDate, parseIso } from '../../clock.js';
import type { IdGenerator } from '../../ids.js';
import type { Expense, LedgerEntry } from '../../domain/expense.js';
import type { Trip } from '../../domain/trip.js';
import type {
  BookingRepository,
  ExpenseRepository,
  GroupMemoryRepository,
  GroupRepository,
  GroupStore,
  MemberRepository,
  SettlementRepository,
  TripRepository,
} from '../../repositories.js';
import { TravError } from '../../errors.js';
import type { Backend } from './backend.js';
import {
  activitiesSpec,
  attendanceSpec,
  bookingsSpec,
  decisionsSpec,
  expensesSpec,
  grantsSpec,
  groupMemorySpec,
  groupsSpec,
  ledgerEntriesSpec,
  membersSpec,
  proposalsSpec,
  settlementSourceKey,
  settlementsSpec,
  sourceRefKey,
  tripsSpec,
} from './schema.js';
import { createAuditRepository } from './auditRepository.js';
import { createRuntimeStateRepository } from './runtimeState.js';
import { requireId, sortByInstant } from './util.js';

function notFound(what: string, id: string): TravError {
  return new TravError('not_found', `${what} not found`, { what, id });
}

function duplicate(what: string, details: Readonly<Record<string, unknown>>): TravError {
  return new TravError('duplicate', `${what} already exists`, { what, ...details });
}

// ---------- groups / members ----------

function createGroupRepository(backend: Backend): GroupRepository {
  const groups = backend.table(groupsSpec);
  return {
    create(group) {
      requireId(group.groupId, 'groupId');
      if (groups.get(group.groupId) !== undefined) {
        throw duplicate('group', { groupId: group.groupId });
      }
      if (groups.count({ conversation_id: group.conversationId }) > 0) {
        throw duplicate('group for conversation', { groupId: group.groupId });
      }
      groups.insert(group);
    },
    get: (groupId) => groups.get(groupId),
    getByConversation: (conversationId) => groups.find({ conversation_id: conversationId })[0],
    update(group) {
      if (groups.get(group.groupId) === undefined) throw notFound('group', group.groupId);
      groups.upsert(group);
    },
    list: () => groups.find({}),
  };
}

function createMemberRepository(backend: Backend): MemberRepository {
  const members = backend.table(membersSpec);
  return {
    upsert(member) {
      requireId(member.memberId, 'memberId');
      requireId(member.groupId, 'groupId');
      requireId(member.senderId, 'senderId');
      const existing = members.get(member.memberId);
      if (existing !== undefined && existing.groupId !== member.groupId) {
        throw new TravError('invalid_argument', 'a member cannot move to another group', {
          memberId: member.memberId,
        });
      }
      // Identity is the channel sender id (SAFETY §2.5): one sender ⇒ one member per group.
      const sameSender = members.find({ group_id: member.groupId, sender_id: member.senderId });
      if (sameSender.some((m) => m.memberId !== member.memberId)) {
        throw duplicate('member with this senderId', {
          memberId: member.memberId,
          groupId: member.groupId,
        });
      }
      members.upsert(member);
    },
    get: (memberId) => members.get(memberId),
    getBySenderId: (groupId, senderId) =>
      members.find({ group_id: groupId, sender_id: senderId })[0],
    listByGroup(groupId, opts) {
      const rows = members
        .find({ group_id: groupId })
        .filter((m) => opts?.activeOnly !== true || m.active);
      return sortByInstant(rows, (m) => m.joinedAt);
    },
  };
}

// ---------- trips / activities / attendance ----------

/** Lower is better: an active trip covering today, then any active, then planning trips. */
function currentRank(trip: Trip, now: string): number {
  const today = localDate(now, trip.timeZone);
  const inRange = trip.startDate <= today && today <= trip.endDate;
  if (trip.status === 'active') return inRange ? 0 : 1;
  if (inRange) return 2;
  return today < trip.startDate ? 3 : 4;
}

function createTripRepository(backend: Backend): TripRepository {
  const trips = backend.table(tripsSpec);
  const activities = backend.table(activitiesSpec);
  const attendance = backend.table(attendanceSpec);
  return {
    create(trip) {
      requireId(trip.tripId, 'tripId');
      if (trips.get(trip.tripId) !== undefined) throw duplicate('trip', { tripId: trip.tripId });
      trips.insert(trip);
    },
    get: (tripId) => trips.get(tripId),
    update(trip) {
      const existing = trips.get(trip.tripId);
      if (existing === undefined) throw notFound('trip', trip.tripId);
      if (existing.groupId !== trip.groupId) {
        throw new TravError('invalid_argument', 'a trip cannot move to another group', {
          tripId: trip.tripId,
        });
      }
      trips.upsert(trip);
    },
    listByGroup: (groupId) => trips.find({ group_id: groupId }),
    current(groupId, now) {
      parseIso(now);
      const candidates = trips
        .find({ group_id: groupId })
        .filter((t) => t.status === 'active' || t.status === 'planning')
        .map((trip, index) => ({ trip, index, rank: currentRank(trip, now) }));
      candidates.sort(
        (a, b) =>
          a.rank - b.rank ||
          (a.trip.startDate < b.trip.startDate
            ? -1
            : a.trip.startDate > b.trip.startDate
              ? 1
              : 0) ||
          a.index - b.index,
      );
      return candidates[0]?.trip;
    },

    upsertActivity(activity) {
      requireId(activity.activityId, 'activityId');
      const existing = activities.get(activity.activityId);
      if (existing !== undefined && existing.tripId !== activity.tripId) {
        throw new TravError('invalid_argument', 'an activity cannot move to another trip', {
          activityId: activity.activityId,
        });
      }
      activities.upsert(activity);
    },
    getActivity: (activityId) => activities.get(activityId),
    listActivities(tripId, range) {
      const rows = activities.find({ trip_id: tripId });
      if (range === undefined) return sortByInstant(rows, (a) => a.startsAt);
      const from = parseIso(range.from);
      const to = parseIso(range.to);
      return sortByInstant(
        rows.filter((a) => {
          if (a.startsAt === undefined) return false;
          const ms = parseIso(a.startsAt);
          return ms >= from && ms <= to;
        }),
        (a) => a.startsAt,
      );
    },

    setAttendance(row) {
      requireId(row.activityId, 'activityId');
      requireId(row.memberId, 'memberId');
      attendance.upsert(row);
    },
    listAttendance: (activityId) => attendance.find({ activity_id: activityId }),
  };
}

// ---------- expenses / ledger ----------

function checkEntries(expense: Expense, entries: readonly LedgerEntry[]): void {
  for (const entry of entries) {
    if (entry.expenseId !== expense.expenseId || entry.tripId !== expense.tripId) {
      throw new TravError('invalid_argument', 'ledger entry does not belong to this expense', {
        expenseId: expense.expenseId,
        entryExpenseId: entry.expenseId,
      });
    }
  }
}

function createExpenseRepository(backend: Backend): ExpenseRepository {
  const expenses = backend.table(expensesSpec);
  const ledger = backend.table(ledgerEntriesSpec);

  const writeEntries = (expense: Expense, entries: readonly LedgerEntry[]): void => {
    ledger.deleteWhere({ expense_id: expense.expenseId });
    entries.forEach((entry, position) => ledger.insert({ position, entry }));
  };
  type Listener = (expense: Expense) => void;
  const createListeners = new Set<Listener>();
  const undoListeners = new Set<Listener>();
  const subscribe =
    (set: Set<Listener>) =>
    (listener: Listener): (() => void) => {
      // One wrapper per subscription: subscribing the same function twice is two subscriptions.
      const entry: Listener = (e) => listener(e);
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    };
  // Called after the transaction committed, so a listener never sees a rolled-back write.
  const notify = (set: Set<Listener>, expense: Expense): void => {
    for (const listener of [...set]) {
      try {
        listener(expense);
      } catch {
        // A notice listener must never turn a committed ledger write into an error.
      }
    }
  };

  return {
    onCreate: subscribe(createListeners),
    onUndo: subscribe(undoListeners),
    create(expense, entries) {
      requireId(expense.expenseId, 'expenseId');
      requireId(expense.sourceRef.id, 'sourceRef.id');
      checkEntries(expense, entries);
      backend.transaction(() => {
        if (expenses.get(expense.expenseId) !== undefined) {
          throw duplicate('expense', { expenseId: expense.expenseId });
        }
        const existing = expenses.find({ source_key: sourceRefKey(expense.sourceRef) })[0];
        if (existing !== undefined) {
          throw duplicate('expense for this source', {
            expenseId: expense.expenseId,
            existingExpenseId: existing.expenseId,
            sourceKind: expense.sourceRef.kind,
          });
        }
        expenses.insert(expense);
        writeEntries(expense, entries);
      });
      notify(createListeners, expense);
    },
    get: (expenseId) => expenses.get(expenseId),
    getBySourceRef: (ref) => expenses.find({ source_key: sourceRefKey(ref) })[0],
    replace(expense, entries) {
      checkEntries(expense, entries);
      let undone = false;
      backend.transaction(() => {
        const prior = expenses.get(expense.expenseId);
        if (prior === undefined) {
          throw notFound('expense', expense.expenseId);
        }
        const clash = expenses
          .find({ source_key: sourceRefKey(expense.sourceRef) })
          .find((e) => e.expenseId !== expense.expenseId);
        if (clash !== undefined) {
          throw duplicate('expense for this source', {
            expenseId: expense.expenseId,
            existingExpenseId: clash.expenseId,
          });
        }
        expenses.upsert(expense);
        writeEntries(expense, entries);
        undone = prior.status === 'logged' && expense.status === 'undone';
      });
      if (undone) notify(undoListeners, expense);
    },
    listByTrip(tripId, opts) {
      const rows = expenses.find({ trip_id: tripId });
      return opts?.includeUndone === true ? rows : rows.filter((e) => e.status !== 'undone');
    },
    /** Entries of the trip's live expenses; an undone expense contributes nothing to balances. */
    listEntries(tripId) {
      const live = new Set(
        expenses
          .find({ trip_id: tripId })
          .filter((e) => e.status !== 'undone')
          .map((e) => e.expenseId),
      );
      return ledger
        .find({ trip_id: tripId })
        .filter((r) => live.has(r.entry.expenseId))
        .map((r) => r.entry);
    },
  };
}

// ---------- proposals / decisions / grants / bookings ----------

function createBookingRepository(backend: Backend): BookingRepository {
  const proposals = backend.table(proposalsSpec);
  const decisions = backend.table(decisionsSpec);
  const grants = backend.table(grantsSpec);
  const bookings = backend.table(bookingsSpec);
  return {
    createProposal(p) {
      requireId(p.proposalId, 'proposalId');
      if (proposals.get(p.proposalId) !== undefined) {
        throw duplicate('proposal', { proposalId: p.proposalId });
      }
      proposals.insert(p);
    },
    getProposal: (proposalId) => proposals.get(proposalId),
    updateProposal(p) {
      if (proposals.get(p.proposalId) === undefined) throw notFound('proposal', p.proposalId);
      proposals.upsert(p);
    },
    listPendingProposals: (groupId) => proposals.find({ group_id: groupId, status: 'pending' }),

    saveDecision(decision, auditEventId) {
      requireId(decision.proposalId, 'proposalId');
      requireId(auditEventId, 'auditEventId');
      decisions.upsert({ proposalId: decision.proposalId, decision, auditEventId });
    },
    getDecision(proposalId) {
      const row = decisions.get(proposalId);
      return row === undefined
        ? undefined
        : { decision: row.decision, auditEventId: row.auditEventId };
    },

    saveGrant(grant) {
      requireId(grant.grantId, 'grantId');
      const existing = grants.get(grant.grantId);
      if (existing !== undefined && existing.proposalId !== grant.proposalId) {
        throw new TravError('invalid_argument', 'a grant cannot move to another proposal', {
          grantId: grant.grantId,
        });
      }
      grants.upsert(grant);
    },
    getGrant: (grantId) => grants.get(grantId),
    /** The most recently created grant for the proposal. */
    getGrantForProposal: (proposalId) => grants.last({ proposal_id: proposalId }),

    createBooking(b) {
      requireId(b.bookingId, 'bookingId');
      requireId(b.idempotencyKey, 'idempotencyKey');
      backend.transaction(() => {
        if (bookings.get(b.bookingId) !== undefined) {
          throw duplicate('booking', { bookingId: b.bookingId });
        }
        const existing = bookings.find({ idempotency_key: b.idempotencyKey })[0];
        if (existing !== undefined) {
          throw duplicate('booking for this idempotency key', {
            bookingId: b.bookingId,
            existingBookingId: existing.bookingId,
          });
        }
        bookings.insert(b);
      });
    },
    getBooking: (bookingId) => bookings.get(bookingId),
    getBookingByKey: (key) => bookings.find({ idempotency_key: key })[0],
    updateBooking(b) {
      const existing = bookings.get(b.bookingId);
      if (existing === undefined) throw notFound('booking', b.bookingId);
      if (existing.idempotencyKey !== b.idempotencyKey) {
        throw new TravError('invalid_argument', "a booking's idempotency key cannot change", {
          bookingId: b.bookingId,
        });
      }
      bookings.upsert(b);
    },
    listByTrip: (tripId) => bookings.find({ trip_id: tripId }),
    /**
     * Counts `confirmed` and `partially_refunded` bookings. `Booking` carries no
     * refunded amount, so a partial refund still counts its full total
     * (conservative: it can only make the cap stricter). `cancelled` and
     * `refunded` bookings free the cap: no money stayed spent.
     */
    spentBetween(groupId, from, to) {
      const fromMs = parseIso(from);
      const toMs = parseIso(to);
      let total = 0;
      for (const b of bookings.find({ group_id: groupId })) {
        if (b.status !== 'confirmed' && b.status !== 'partially_refunded') continue;
        const ms = parseIso(b.purchasedAt);
        if (ms >= fromMs && ms <= toMs) total += b.totalMinor;
      }
      return total;
    },
  };
}

// ---------- group memory ----------

function createGroupMemoryRepository(backend: Backend): GroupMemoryRepository {
  const facts = backend.table(groupMemorySpec);
  return {
    upsert(fact) {
      requireId(fact.factId, 'factId');
      facts.upsert(fact);
    },
    /** Chronological by `learnedAt`; `limit` keeps the most recent N. */
    listByGroup(groupId, opts) {
      const where =
        opts?.tripId === undefined
          ? { group_id: groupId }
          : { group_id: groupId, source_trip_id: opts.tripId };
      const rows = sortByInstant(facts.find(where), (f) => f.learnedAt);
      if (opts?.limit === undefined) return rows;
      if (!Number.isInteger(opts.limit) || opts.limit < 0) {
        throw new TravError('invalid_argument', 'limit must be a non-negative integer', {
          limit: opts.limit,
        });
      }
      return opts.limit === 0 ? [] : rows.slice(-opts.limit);
    },
    delete(factId) {
      facts.deleteKey(factId);
    },
  };
}

// ---------- settlements (T-141, D-034) ----------

function createSettlementRepository(backend: Backend): SettlementRepository {
  const rows = backend.table(settlementsSpec);
  return {
    record(payment) {
      requireId(payment.paymentId, 'paymentId');
      requireId(payment.tripId, 'tripId');
      requireId(payment.cardMessageId, 'cardMessageId');
      if (payment.from === payment.to) {
        throw new TravError('invalid_argument', 'a member cannot pay themselves', {
          memberId: payment.from,
        });
      }
      if (!Number.isSafeInteger(payment.amount.amountMinor) || payment.amount.amountMinor <= 0) {
        throw new TravError('invalid_argument', 'payment amount must be a positive integer', {
          paymentId: payment.paymentId,
        });
      }
      backend.transaction(() => {
        if (rows.get(payment.paymentId) !== undefined) {
          throw duplicate('settlement payment', { paymentId: payment.paymentId });
        }
        if (rows.count({ source_key: settlementSourceKey(payment) }) > 0) {
          throw duplicate('settlement payment for this transfer', {
            paymentId: payment.paymentId,
            cardMessageId: payment.cardMessageId,
          });
        }
        rows.insert(payment);
      });
    },
    update(payment) {
      requireId(payment.paymentId, 'paymentId');
      backend.transaction(() => {
        const existing = rows.get(payment.paymentId);
        if (existing === undefined) throw notFound('settlement payment', payment.paymentId);
        const same =
          existing.tripId === payment.tripId &&
          existing.groupId === payment.groupId &&
          existing.from === payment.from &&
          existing.to === payment.to &&
          existing.cardMessageId === payment.cardMessageId &&
          existing.amount.amountMinor === payment.amount.amountMinor &&
          existing.amount.currency === payment.amount.currency;
        if (!same) {
          throw new TravError(
            'invalid_argument',
            'a settlement update may change its state only, not who, what or which card',
            { paymentId: payment.paymentId },
          );
        }
        rows.upsert(payment);
      });
    },
    listByTrip: (tripId) => rows.find({ trip_id: tripId }),
  };
}

export function createGroupStore(backend: Backend, clock: Clock, ids: IdGenerator): GroupStore {
  return {
    groups: createGroupRepository(backend),
    members: createMemberRepository(backend),
    trips: createTripRepository(backend),
    expenses: createExpenseRepository(backend),
    settlements: createSettlementRepository(backend),
    bookings: createBookingRepository(backend),
    audit: createAuditRepository(backend, clock, ids),
    groupMemory: createGroupMemoryRepository(backend),
    runtime: createRuntimeStateRepository(backend),
  };
}
