/**
 * Payments. Two separate concerns:
 *
 * 1. BookingPaymentsAdapter: charging the payer of a booking Trav makes
 *    (Stripe PaymentIntent-shaped; test mode only, ever, in v0).
 * 2. SettleUpAdapter: friends paying each other back. Trav never moves money
 *    between members (Venmo's API is closed to new developers, and P2P transfers
 *    raise money-transmitter issues). It creates payment *requests* with deep
 *    links and tracks "marked paid" / "confirmed received".
 */
import type {
  AdapterInfo,
  ApprovalProof,
  GroupId,
  IdempotencyKey,
  IsoDateTime,
  MemberId,
  Money,
  Result,
  TripId,
} from './common.js';

// ---------- Booking payments ----------

export type PaymentIntentStatus =
  'requires_payment_method' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';

export interface PaymentIntent {
  readonly intentId: string;
  readonly payerMemberId: MemberId;
  readonly amount: Money;
  readonly status: PaymentIntentStatus;
  /** What was bought, e.g. "booking:tkt_ord_123". */
  readonly reference: string;
  readonly createdAt: IsoDateTime;
  readonly approvalId: string;
  readonly refundedAmount?: Money;
}

export interface ChargeRequest {
  /** The member whose saved (test) payment method fronts the booking. */
  readonly payerMemberId: MemberId;
  readonly amount: Money;
  readonly reference: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly approval: ApprovalProof;
}

export interface BookingPaymentsAdapter {
  readonly info: AdapterInfo;

  /** Whether the member has a saved payment method Trav may charge after approval. */
  hasPaymentMethod(memberId: MemberId): Promise<Result<boolean>>;

  /**
   * Charge a member for an approved booking. Rejects if the ApprovalProof is
   * invalid, expired, or below `amount`. Idempotent per idempotencyKey.
   */
  charge(request: ChargeRequest): Promise<Result<PaymentIntent>>;

  /** Refund all or part of a charge (defaults to the full remaining amount). */
  refund(
    intentId: string,
    idempotencyKey: IdempotencyKey,
    amount?: Money,
  ): Promise<Result<PaymentIntent>>;

  /** Fetch a charge. */
  getCharge(intentId: string): Promise<Result<PaymentIntent>>;
}

// ---------- Settle-up between friends ----------

export type PaymentMethodKind =
  'venmo' | 'paypal' | 'revolut' | 'bizum' | 'monzo' | 'cash_app' | 'bank_transfer' | 'cash';

/** A member's payout handle, shared only with members who owe them. */
export interface PayoutHandle {
  readonly memberId: MemberId;
  readonly method: PaymentMethodKind;
  /** e.g. "@henry-b" or a PayPal.me username. Not a bank account number. */
  readonly handle: string;
}

export interface PaymentLink {
  readonly method: PaymentMethodKind;
  readonly label: string;
  /** Prefilled deep link where the method supports one; absent for cash/bank. */
  readonly url?: string;
}

export type PaymentRequestStatus =
  'pending' | 'marked_paid' | 'confirmed' | 'disputed' | 'cancelled';

export interface PaymentRequest {
  readonly requestId: string;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly fromMemberId: MemberId;
  readonly toMemberId: MemberId;
  readonly amount: Money;
  readonly note: string;
  readonly links: readonly PaymentLink[];
  readonly status: PaymentRequestStatus;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface CreatePaymentRequestInput {
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly fromMemberId: MemberId;
  readonly toMemberId: MemberId;
  readonly amount: Money;
  readonly note: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface SettleUpAdapter {
  readonly info: AdapterInfo;

  /** Save or replace a member's payout handle for one method. */
  setPayoutHandle(handle: PayoutHandle): Promise<Result<void>>;

  /** Payout handles for a member (the payee). */
  getPayoutHandles(memberId: MemberId): Promise<Result<readonly PayoutHandle[]>>;

  /**
   * Create a request for `fromMemberId` to pay `toMemberId`, with deep links
   * built from the payee's handles. Moves no money. Idempotent.
   */
  createRequest(input: CreatePaymentRequestInput): Promise<Result<PaymentRequest>>;

  /** The payer says they paid ("paid Dean back on Venmo"). */
  markPaid(requestId: string, byMemberId: MemberId): Promise<Result<PaymentRequest>>;

  /** The payee confirms receipt; only then is the ledger transfer recorded as settled. */
  confirmReceived(requestId: string, byMemberId: MemberId): Promise<Result<PaymentRequest>>;

  /** Either party flags a problem (wrong amount, never arrived). */
  dispute(requestId: string, byMemberId: MemberId, reason: string): Promise<Result<PaymentRequest>>;

  /** Cancel a request (e.g. the ledger changed and transfers were recomputed). */
  cancel(requestId: string): Promise<Result<PaymentRequest>>;

  /** All requests for a trip, for daily settle-up and Wrapped. */
  listForTrip(tripId: TripId): Promise<Result<readonly PaymentRequest[]>>;
}
