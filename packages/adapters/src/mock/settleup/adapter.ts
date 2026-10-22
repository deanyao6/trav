/**
 * Mock `SettleUpAdapter` (T-008-b). Friends paying each other back: Trav
 * creates payment *requests* with mock pay links and tracks what members say
 * happened. It moves no money, holds no balances, charges nothing, and makes
 * no network calls (Venmo's API is closed; P2P transfers would make Trav a
 * money transmitter; research/connectors.md).
 *
 * State machine (anything not listed is `invalid_request`, nothing changes):
 *
 *   pending     --markPaid(payer)-------> marked_paid
 *   pending     --confirmReceived(payee)-> confirmed     (cash in hand, no "I paid" first)
 *   pending     --dispute(either)-------> disputed       ("that's the wrong amount")
 *   pending     --cancel()--------------> cancelled      (ledger changed, transfers recomputed)
 *   marked_paid --confirmReceived(payee)-> confirmed
 *   marked_paid --dispute(either)-------> disputed       ("it never arrived")
 *   disputed    --markPaid(payer)-------> marked_paid    (paid again / resent)
 *   disputed    --confirmReceived(payee)-> confirmed     (found it)
 *   disputed    --cancel()--------------> cancelled
 *
 * `confirmed` and `cancelled` are terminal. Once the payer marks a request
 * paid it cannot be cancelled until the PAYEE confirms or disputes: someone
 * says money moved, and a silent cancel would lose a real payment from the
 * ledger. A dispute by the payer does not lift this (markPaid → payer dispute
 * → cancel is refused); a payee dispute ("it never arrived") does, including
 * on a request the payer already put in `disputed`. Repeating the
 * transition that produced the current state (markPaid on `marked_paid` by the
 * payer, confirm on `confirmed` by the payee, dispute on `disputed` by a
 * party, cancel on `cancelled`) is an idempotent no-op that returns the
 * request unchanged, so double taps and retried tool calls are safe.
 *
 * Only the payer may mark paid and only the payee may confirm receipt.
 * `createRequest` is idempotent per `idempotencyKey` (same key + same fields ⇒
 * the original request; same key + different fields ⇒ `duplicate`).
 *
 * Only the factory is exported from the package root (D-004).
 */
import type { Clock, IdempotencyKey, MemberId, Money, TripId } from '@trav/core';
import { equals, money } from '@trav/core';
import type { AdapterError, AdapterInfo, Result } from '../../interfaces/common.js';
import type {
  CreatePaymentRequestInput,
  PaymentRequest,
  PaymentRequestStatus,
  PayoutHandle,
  SettleUpAdapter,
} from '../../interfaces/payments.js';
import { buildPaymentLinks, handleProblem, isPaymentMethod } from './links.js';

export interface MockSettleUpOptions {
  readonly clock: Clock;
  /** Overrides `info.provider` (default `mock-settleup`). */
  readonly provider?: string;
}

export type SettleUpAction = 'created' | 'mark_paid' | 'confirm_received' | 'dispute' | 'cancel';

/** One recorded transition, for the audit log and tests. */
export interface PaymentRequestEvent {
  readonly requestId: string;
  readonly action: SettleUpAction;
  readonly from: PaymentRequestStatus | null;
  readonly to: PaymentRequestStatus;
  /** Who did it; absent for `created` and `cancel` (system actions). */
  readonly byMemberId?: MemberId;
  /** Dispute reason as the member wrote it. Untrusted text. */
  readonly reason?: string;
  readonly at: string;
}

/** The adapter plus test hooks. Tools only see `SettleUpAdapter`. */
export interface MockSettleUp extends SettleUpAdapter {
  /** Requests actually created (idempotent replays do not count). */
  requestCount(): number;
  /** Every transition of one request, oldest first (empty for unknown ids). */
  history(requestId: string): readonly PaymentRequestEvent[];
  /** The latest dispute reason, if the request was ever disputed. */
  disputeReason(requestId: string): string | undefined;
}

export const MAX_NOTE_CHARS = 140;
export const MAX_DISPUTE_REASON_CHARS = 280;

interface RequestRecord {
  request: PaymentRequest;
  readonly key: IdempotencyKey;
  readonly events: PaymentRequestEvent[];
  disputeReason?: string;
  /**
   * The payer said they paid and the payee has not answered (confirm or
   * dispute). While true the request cannot be cancelled, whatever its status:
   * a payer dispute after marking paid must not open a path to a silent cancel.
   */
  paidClaimed: boolean;
}

function fail<T>(code: AdapterError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message, retryable: false } };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function done<T>(r: Result<T>): Promise<Result<T>> {
  return Promise.resolve(r);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPositiveMoney(v: unknown): v is Money {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as { amountMinor?: unknown; currency?: unknown };
  return (
    typeof m.amountMinor === 'number' &&
    Number.isSafeInteger(m.amountMinor) &&
    m.amountMinor > 0 &&
    typeof m.currency === 'string' &&
    /^[A-Z]{3}$/.test(m.currency)
  );
}

function validateCreate(input: CreatePaymentRequestInput): string | undefined {
  if (typeof input !== 'object' || input === null) return 'input required';
  for (const field of ['groupId', 'tripId', 'fromMemberId', 'toMemberId'] as const) {
    if (!nonEmpty(input[field])) return `${field} required`;
  }
  if (input.fromMemberId === input.toMemberId) return 'a member cannot pay themselves';
  if (!isPositiveMoney(input.amount)) {
    return 'amount must be a positive integer of minor units';
  }
  if (typeof input.note !== 'string' || input.note.length > MAX_NOTE_CHARS) {
    return `note must be text up to ${MAX_NOTE_CHARS} characters`;
  }
  return undefined;
}

function sameCreate(a: PaymentRequest, b: CreatePaymentRequestInput): boolean {
  return (
    a.groupId === b.groupId &&
    a.tripId === b.tripId &&
    a.fromMemberId === b.fromMemberId &&
    a.toMemberId === b.toMemberId &&
    isPositiveMoney(b.amount) &&
    equals(a.amount, b.amount) &&
    a.note === b.note
  );
}

export function createMockSettleUp(options: MockSettleUpOptions): MockSettleUp {
  const { clock } = options;
  const info: AdapterInfo = { provider: options.provider ?? 'mock-settleup', mode: 'mock' };

  /** memberId ⇒ method ⇒ handle (Map keeps the payee's order; replace keeps position). */
  const handles = new Map<MemberId, Map<string, PayoutHandle>>();
  const requests = new Map<string, RequestRecord>();
  const byKey = new Map<IdempotencyKey, RequestRecord>();
  let seq = 0;

  const record = (
    rec: RequestRecord,
    action: SettleUpAction,
    to: PaymentRequestStatus,
    byMemberId?: MemberId,
    reason?: string,
  ): PaymentRequest => {
    const at = clock.now();
    const from = rec.request.status;
    rec.request = { ...rec.request, status: to, updatedAt: at };
    rec.events.push({
      requestId: rec.request.requestId,
      action,
      from,
      to,
      ...(byMemberId !== undefined ? { byMemberId } : {}),
      ...(reason !== undefined ? { reason } : {}),
      at,
    });
    return rec.request;
  };

  const find = (requestId: unknown): RequestRecord | undefined =>
    typeof requestId === 'string' ? requests.get(requestId) : undefined;

  const notFound = <T>(requestId: unknown): Promise<Result<T>> =>
    done(fail<T>('not_found', `no payment request ${String(requestId)}`));

  const illegal = <T>(rec: RequestRecord, what: string): Promise<Result<T>> =>
    done(
      fail<T>(
        'invalid_request',
        `cannot ${what} a payment request that is ${rec.request.status.replace('_', ' ')}`,
      ),
    );

  const adapter: MockSettleUp = {
    info,

    setPayoutHandle(handle) {
      if (typeof handle !== 'object' || handle === null) {
        return done(fail('invalid_request', 'handle required'));
      }
      if (!nonEmpty(handle.memberId)) return done(fail('invalid_request', 'memberId required'));
      if (!isPaymentMethod(handle.method)) {
        return done(fail('invalid_request', `unknown payment method ${String(handle.method)}`));
      }
      const problem = handleProblem(handle.handle);
      if (problem) return done(fail('invalid_request', problem));
      let mine = handles.get(handle.memberId);
      if (!mine) {
        mine = new Map();
        handles.set(handle.memberId, mine);
      }
      mine.set(handle.method, {
        memberId: handle.memberId,
        method: handle.method,
        handle: handle.handle.trim(),
      });
      return done(ok(undefined));
    },

    getPayoutHandles(memberId) {
      if (!nonEmpty(memberId)) return done(fail('invalid_request', 'memberId required'));
      return done(ok([...(handles.get(memberId)?.values() ?? [])]));
    },

    createRequest(input) {
      if (typeof input !== 'object' || input === null) {
        return done(fail('invalid_request', 'input required'));
      }
      if (!nonEmpty(input.idempotencyKey)) {
        return done(fail('invalid_request', 'idempotencyKey required'));
      }
      const prior = byKey.get(input.idempotencyKey);
      if (prior) {
        return done(
          sameCreate(prior.request, input)
            ? ok(prior.request)
            : fail('duplicate', 'idempotency key already used for a different payment request'),
        );
      }
      const problem = validateCreate(input);
      if (problem) return done(fail('invalid_request', problem));

      seq += 1;
      const requestId = `pr_mock_${String(seq).padStart(6, '0')}`;
      const amount = money(input.amount.amountMinor, input.amount.currency);
      const now = clock.now();
      const payeeHandles = [...(handles.get(input.toMemberId)?.values() ?? [])];
      const request: PaymentRequest = {
        requestId,
        groupId: input.groupId,
        tripId: input.tripId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amount,
        note: input.note,
        links: buildPaymentLinks(payeeHandles, amount, input.note),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      const rec: RequestRecord = {
        request,
        key: input.idempotencyKey,
        paidClaimed: false,
        events: [{ requestId, action: 'created', from: null, to: 'pending', at: now }],
      };
      requests.set(requestId, rec);
      byKey.set(input.idempotencyKey, rec);
      return done(ok(request));
    },

    markPaid(requestId, byMemberId) {
      const rec = find(requestId);
      if (!rec) return notFound(requestId);
      if (byMemberId !== rec.request.fromMemberId) {
        return done(fail('invalid_request', 'only the member who owes can mark this paid'));
      }
      const s = rec.request.status;
      if (s === 'marked_paid') return done(ok(rec.request));
      if (s !== 'pending' && s !== 'disputed') return illegal(rec, 'mark paid');
      rec.paidClaimed = true;
      return done(ok(record(rec, 'mark_paid', 'marked_paid', byMemberId)));
    },

    confirmReceived(requestId, byMemberId) {
      const rec = find(requestId);
      if (!rec) return notFound(requestId);
      if (byMemberId !== rec.request.toMemberId) {
        return done(fail('invalid_request', 'only the member being paid can confirm receipt'));
      }
      const s = rec.request.status;
      if (s === 'confirmed') return done(ok(rec.request));
      if (s === 'cancelled') return illegal(rec, 'confirm');
      return done(ok(record(rec, 'confirm_received', 'confirmed', byMemberId)));
    },

    dispute(requestId, byMemberId, reason) {
      const rec = find(requestId);
      if (!rec) return notFound(requestId);
      const { fromMemberId, toMemberId } = rec.request;
      if (byMemberId !== fromMemberId && byMemberId !== toMemberId) {
        return done(fail('invalid_request', 'only the two members involved can dispute'));
      }
      if (!nonEmpty(reason) || reason.length > MAX_DISPUTE_REASON_CHARS) {
        return done(
          fail('invalid_request', `reason must be 1-${MAX_DISPUTE_REASON_CHARS} characters`),
        );
      }
      const s = rec.request.status;
      const byPayee = byMemberId === toMemberId;
      if (s === 'disputed') {
        // The payee answering an open "I paid" claim is a real step (it lifts
        // the cancel block); anything else on a disputed request is a no-op.
        if (!(byPayee && rec.paidClaimed)) return done(ok(rec.request));
      } else if (s !== 'pending' && s !== 'marked_paid') {
        return illegal(rec, 'dispute');
      }
      // Only the payee can answer the payer's "I paid"; a payer dispute keeps it open.
      if (byPayee) rec.paidClaimed = false;
      rec.disputeReason = reason;
      return done(ok(record(rec, 'dispute', 'disputed', byMemberId, reason)));
    },

    cancel(requestId) {
      const rec = find(requestId);
      if (!rec) return notFound(requestId);
      const s = rec.request.status;
      if (s === 'cancelled') return done(ok(rec.request));
      if (rec.paidClaimed) {
        return done(
          fail(
            'invalid_request',
            'the payer marked this paid; the payee must confirm or dispute before it can be cancelled',
          ),
        );
      }
      if (s !== 'pending' && s !== 'disputed') return illegal(rec, 'cancel');
      return done(ok(record(rec, 'cancel', 'cancelled')));
    },

    listForTrip(tripId: TripId) {
      if (!nonEmpty(tripId)) return done(fail('invalid_request', 'tripId required'));
      return done(
        ok([...requests.values()].map((r) => r.request).filter((r) => r.tripId === tripId)),
      );
    },

    requestCount: () => seq,
    history: (requestId) => [...(find(requestId)?.events ?? [])],
    disputeReason: (requestId) => find(requestId)?.disputeReason,
  };
  return adapter;
}
