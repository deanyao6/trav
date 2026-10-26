/**
 * Mock BookingPaymentsAdapter (T-008-a, identity per T-059). Records charges in
 * memory; moves no money and makes no network calls. Shaped like a test-mode
 * PaymentIntent API.
 *
 * Rules enforced on every new charge (SAFETY §2.1, ARCHITECTURE §10.3):
 * - a valid, unexpired `ApprovalProof` in the charge currency with
 *   `maxAmount >= amount` (see `checkApprovalProof`), granted in the request's
 *   `groupId` (`checkRequestGroup`, D-020);
 * - the payer must be one of `approval.approvedBy` (nobody is charged on a
 *   proof they did not sign);
 * - one approval funds one action: reusing an `approvalId` for another charge
 *   or refund (a different idempotency key) is `approval_invalid`;
 * - idempotent per `idempotencyKey`: a retry with the same key and the same
 *   parameters returns the original intent and `chargeCount()` stays put; the
 *   same key with different parameters is `duplicate` and charges nothing.
 *
 * Refunds carry the same identity (D-020): an `ApprovalProof` for the charge's
 * group that covers the refund amount, and a `requestedBy` member who is one of
 * `approval.approvedBy`. A refund missing either is rejected as a typed result.
 * Nothing here throws for a bad request.
 *
 * Only the factory is exported; there is no bare charge function (D-004).
 */
import type { Clock, IdempotencyKey, MemberId, Money } from '@trav/core';
import { equals, money, subtract } from '@trav/core';
import type { AdapterError, AdapterInfo, Result } from '../../interfaces/common.js';
import type {
  BookingPaymentsAdapter,
  ChargeRequest,
  PaymentIntent,
} from '../../interfaces/payments.js';
import {
  checkApprovalCovers,
  checkApprovalProof,
  checkApprovalProofShape,
  checkApprovalProofValidity,
  checkRequestGroup,
} from './proof.js';

export {
  checkApprovalCovers,
  checkApprovalProof,
  checkApprovalProofShape,
  checkApprovalProofValidity,
  checkRequestGroup,
} from './proof.js';

export interface MockBookingPaymentsOptions {
  readonly clock: Clock;
  /**
   * Members with a saved (mock) payment method. Omit to give every member one.
   * An empty list means nobody can be charged.
   */
  readonly membersWithPaymentMethod?: readonly MemberId[];
  /** Overrides `info.provider` (default `mock-payments`). */
  readonly provider?: string;
}

/** The adapter plus test hooks. The executor only sees `BookingPaymentsAdapter`. */
export interface MockBookingPayments extends BookingPaymentsAdapter {
  /** Number of charges actually recorded (idempotent replays do not count). */
  chargeCount(): number;
  /** Number of refunds actually recorded (idempotent replays do not count). */
  refundCount(): number;
  /** Snapshot of every recorded intent, in creation order. */
  listCharges(): readonly PaymentIntent[];
}

interface ChargeRecord {
  readonly key: IdempotencyKey;
  readonly request: Pick<ChargeRequest, 'groupId' | 'payerMemberId' | 'amount' | 'reference'>;
  readonly approvalId: string;
  readonly intentId: string;
}

interface RefundRecord {
  readonly intentId: string;
  readonly amount: Money | undefined;
  readonly approvalId: string;
  readonly requestedBy: MemberId;
  readonly result: PaymentIntent;
}

function err<T>(code: AdapterError['code'], message: string, retryable = false): Result<T> {
  return { ok: false, error: { code, message, retryable } };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fromError<T>(error: AdapterError): Promise<Result<T>> {
  return Promise.resolve({ ok: false, error });
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as { amountMinor?: unknown; currency?: unknown };
  return (
    typeof m.amountMinor === 'number' &&
    Number.isSafeInteger(m.amountMinor) &&
    m.amountMinor > 0 &&
    typeof m.currency === 'string' &&
    /^[A-Z]{3}$/.test(m.currency)
  );
}

function sameRefundAmount(a: Money | undefined, b: Money | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return isPositiveMoney(b) && equals(a, b);
}

export function createMockBookingPayments(
  options: MockBookingPaymentsOptions,
): MockBookingPayments {
  const { clock } = options;
  const info: AdapterInfo = { provider: options.provider ?? 'mock-payments', mode: 'mock' };
  const cardHolders =
    options.membersWithPaymentMethod === undefined
      ? undefined
      : new Set<MemberId>(options.membersWithPaymentMethod);

  const intents = new Map<string, PaymentIntent>();
  const chargesByKey = new Map<IdempotencyKey, ChargeRecord>();
  /** The group each charge was made in; refund proofs must match it. */
  const groupByIntent = new Map<string, string>();
  /** approvalId ⇒ the action that consumed it (`charge:<key>` / `refund:<key>`). */
  const approvalUse = new Map<string, string>();
  const refundsByKey = new Map<IdempotencyKey, RefundRecord>();
  let chargeCounter = 0;
  let refundCounter = 0;

  const hasMethod = (memberId: MemberId): boolean =>
    memberId.length > 0 && (cardHolders === undefined || cardHolders.has(memberId));

  return {
    info,

    hasPaymentMethod(memberId) {
      if (typeof memberId !== 'string' || memberId.length === 0) {
        return Promise.resolve(err('invalid_request', 'memberId is required'));
      }
      return Promise.resolve(ok(hasMethod(memberId)));
    },

    charge(request) {
      if (typeof request !== 'object' || (request as unknown) === null) {
        return Promise.resolve(err('invalid_request', 'request is required'));
      }
      // Idempotent replay first: same key ⇒ the original intent, nothing new is
      // recorded. The proof must still be well-formed and be the same approval.
      const prior = chargesByKey.get(request.idempotencyKey);
      if (prior) {
        const shapeError = checkApprovalProofShape(request.approval);
        if (shapeError) return fromError(shapeError);
        const same =
          prior.approvalId === request.approval.approvalId &&
          prior.request.groupId === request.groupId &&
          prior.request.payerMemberId === request.payerMemberId &&
          prior.request.reference === request.reference &&
          isPositiveMoney(request.amount) &&
          equals(prior.request.amount, request.amount);
        if (!same) {
          return Promise.resolve(
            err('duplicate', 'idempotency key already used for a different charge'),
          );
        }
        const intent = intents.get(prior.intentId);
        if (!intent) throw new Error(`mock-payments: lost intent ${prior.intentId}`);
        return Promise.resolve(ok(intent));
      }

      if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
        return Promise.resolve(err('invalid_request', 'idempotencyKey is required'));
      }
      if (!isPositiveMoney(request.amount)) {
        return Promise.resolve(
          err('invalid_request', 'amount must be a positive integer of minor units'),
        );
      }
      if (typeof request.reference !== 'string' || request.reference.length === 0) {
        return Promise.resolve(err('invalid_request', 'reference is required'));
      }
      const proofError = checkApprovalProof(request.approval, request.amount, clock.nowMs());
      if (proofError) return fromError(proofError);
      const groupError = checkRequestGroup(request.groupId, request.approval);
      if (groupError) return fromError(groupError);
      if (!request.approval.approvedBy.includes(request.payerMemberId)) {
        return Promise.resolve(
          err('approval_invalid', 'payer is not among the members who approved'),
        );
      }
      const usedBy = approvalUse.get(request.approval.approvalId);
      if (usedBy !== undefined && usedBy !== `charge:${request.idempotencyKey}`) {
        return Promise.resolve(err('approval_invalid', 'approval already used for another action'));
      }
      if (!hasMethod(request.payerMemberId)) {
        return Promise.resolve(err('not_configured', 'payer has no saved payment method'));
      }

      chargeCounter += 1;
      const intent: PaymentIntent = {
        intentId: `pi_mock_${String(chargeCounter).padStart(6, '0')}`,
        payerMemberId: request.payerMemberId,
        amount: money(request.amount.amountMinor, request.amount.currency),
        status: 'succeeded',
        reference: request.reference,
        createdAt: clock.now(),
        approvalId: request.approval.approvalId,
      };
      intents.set(intent.intentId, intent);
      chargesByKey.set(request.idempotencyKey, {
        key: request.idempotencyKey,
        request: {
          groupId: request.groupId,
          payerMemberId: request.payerMemberId,
          amount: intent.amount,
          reference: request.reference,
        },
        approvalId: request.approval.approvalId,
        intentId: intent.intentId,
      });
      groupByIntent.set(intent.intentId, request.groupId);
      approvalUse.set(request.approval.approvalId, `charge:${request.idempotencyKey}`);
      return Promise.resolve(ok(intent));
    },

    refund(request) {
      if (typeof request !== 'object' || (request as unknown) === null) {
        return Promise.resolve(err('invalid_request', 'request is required'));
      }
      const { intentId, idempotencyKey, amount, requestedBy, approval } = request;
      if (!nonEmpty(idempotencyKey)) {
        return Promise.resolve(err('invalid_request', 'idempotencyKey is required'));
      }

      // Idempotent replay: same key + same refund ⇒ the original result.
      const prior = refundsByKey.get(idempotencyKey);
      if (prior) {
        const shapeError = checkApprovalProofShape(approval);
        if (shapeError) return fromError(shapeError);
        const same =
          prior.intentId === intentId &&
          prior.approvalId === approval.approvalId &&
          prior.requestedBy === requestedBy &&
          sameRefundAmount(prior.amount, amount);
        if (!same) {
          return Promise.resolve(
            err('duplicate', 'idempotency key already used for a different refund'),
          );
        }
        return Promise.resolve(ok(prior.result));
      }

      // Identity: who asked, and a live proof for the charge's group they signed.
      if (!nonEmpty(requestedBy)) {
        return Promise.resolve(err('invalid_request', 'requestedBy is required'));
      }
      const validity = checkApprovalProofValidity(approval, clock.nowMs());
      if (validity) return fromError(validity);
      const intent = typeof intentId === 'string' ? intents.get(intentId) : undefined;
      const chargeGroup = typeof intentId === 'string' ? groupByIntent.get(intentId) : undefined;
      if (!intent || chargeGroup === undefined) {
        return Promise.resolve(err('not_found', `no charge ${String(intentId)}`));
      }
      const groupError = checkRequestGroup(chargeGroup, approval);
      if (groupError) return fromError(groupError);
      if (!approval.approvedBy.includes(requestedBy)) {
        return Promise.resolve(
          err('approval_invalid', 'requestedBy is not among the members who approved'),
        );
      }
      const usedBy = approvalUse.get(approval.approvalId);
      if (usedBy !== undefined && usedBy !== `refund:${idempotencyKey}`) {
        return Promise.resolve(err('approval_invalid', 'approval already used for another action'));
      }

      // Amount.
      if (intent.status !== 'succeeded' && intent.status !== 'partially_refunded') {
        return Promise.resolve(err('invalid_request', `charge is ${intent.status}`));
      }
      const alreadyRefunded = intent.refundedAmount ?? money(0, intent.amount.currency);
      const remaining = subtract(intent.amount, alreadyRefunded);
      const refundAmount = amount ?? remaining;
      if (!isPositiveMoney(refundAmount)) {
        return Promise.resolve(err('invalid_request', 'refund amount must be positive'));
      }
      if (refundAmount.currency !== intent.amount.currency) {
        return Promise.resolve(err('invalid_request', 'refund currency differs from the charge'));
      }
      if (refundAmount.amountMinor > remaining.amountMinor) {
        return Promise.resolve(err('invalid_request', 'refund exceeds the remaining charge'));
      }
      const covers = checkApprovalCovers(approval, refundAmount);
      if (covers) return fromError(covers);

      const refundedTotal = money(
        alreadyRefunded.amountMinor + refundAmount.amountMinor,
        intent.amount.currency,
      );
      const updated: PaymentIntent = {
        ...intent,
        status: equals(refundedTotal, intent.amount) ? 'refunded' : 'partially_refunded',
        refundedAmount: refundedTotal,
      };
      refundCounter += 1;
      intents.set(intentId, updated);
      refundsByKey.set(idempotencyKey, {
        intentId,
        amount: amount === undefined ? undefined : money(amount.amountMinor, amount.currency),
        approvalId: approval.approvalId,
        requestedBy,
        result: updated,
      });
      approvalUse.set(approval.approvalId, `refund:${idempotencyKey}`);
      return Promise.resolve(ok(updated));
    },

    getCharge(intentId) {
      const intent = intents.get(intentId);
      return Promise.resolve(intent ? ok(intent) : err('not_found', `no charge ${intentId}`));
    },

    chargeCount: () => chargeCounter,
    refundCount: () => refundCounter,
    listCharges: () => [...intents.values()],
  };
}
