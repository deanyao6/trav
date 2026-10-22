/**
 * BookingExecutor: THE single purchase call site (SAFETY §2.1; D-004).
 *
 * This file (`packages/agent/src/booking/executor.ts`) is the only non-test
 * file in `packages/` and `apps/` that may call a provider's `purchase(`,
 * `createOrder(`, `book(` or the payments adapter's `charge(`. The
 * architectural grep test (T-054) asserts exactly one call site per method.
 *
 * `execute()` order, each step idempotent and each audit event written before
 * the next step runs:
 *  1. load proposal, decision, grant; `checkGrant()` (match, complete, unexpired, not denied)
 *  2. `bookings.getBookingByKey(idempotencyKey)` hit ⇒ `booking.duplicate_suppressed`, return existing
 *  3. audit `booking.attempted`
 *  4. re-price with the provider (hold/offer/rate recheck); price or payer change ⇒
 *     `invalidateGrant`, audit `approval.invalidated`, return `refused`
 *  5. provider purchase with `idempotencyKey` + `ApprovalProof` (same key ⇒ same order)
 *  6. `bookings.createBooking` (duplicate key ⇒ treat as step 2)
 *  7. audit `booking.completed`
 *  8. ledger: `Expense{ sourceRef: { kind: 'booking', id } }` via `expenses.create` (idempotent on sourceRef); audit `ledger.written`
 *  9. ticket artifacts → `PrivateStore.putTicket(holder, …)` (QR never touches GroupStore)
 * Any provider failure ⇒ audit `booking.failed`, return `failed` with `moneyMoved: false`.
 */
import type {
  ApprovalGrant,
  AuditEventId,
  Booking,
  BookingProposal,
  Clock,
  Expense,
  GrantId,
  IdGenerator,
  PolicyDecision,
  ProposalId,
  Stores,
} from '@trav/core';
import { notImplemented } from '@trav/core';
import type {
  ApprovalProof,
  BookingPaymentsAdapter,
  FlightsAdapter,
  LodgingAdapter,
  TicketsAdapter,
} from '@trav/adapters';

export interface ProviderRegistry {
  readonly tickets: TicketsAdapter;
  readonly flights: FlightsAdapter;
  readonly lodging: LodgingAdapter;
  readonly payments: BookingPaymentsAdapter;
}

export interface BookingExecutorDeps {
  readonly stores: Stores;
  readonly providers: ProviderRegistry;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type ExecuteResult =
  | {
      readonly kind: 'completed';
      readonly booking: Booking;
      readonly expense: Expense;
      readonly auditEventIds: readonly AuditEventId[];
    }
  | { readonly kind: 'duplicate'; readonly booking: Booking }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'proposal_mismatch'
        | 'incomplete'
        | 'expired'
        | 'wrong_status'
        | 'decision_denied'
        | 'decision_mismatch'
        | 'price_changed'
        | 'payers_changed'
        | 'proposal_not_pending'
        | 'consistency';
      /** The replacement proposal when a re-quote was needed. */
      readonly reproposalId?: ProposalId;
    }
  | {
      readonly kind: 'failed';
      readonly errorCode: string;
      readonly retriable: boolean;
      readonly moneyMoved: false;
    };

export interface BookingExecutor {
  /** Throws `TravError('grant_invalid')` only on programmer misuse (unknown ids); every policy outcome is a returned value. */
  execute(proposalId: ProposalId, grantId: GrantId): Promise<ExecuteResult>;
}

export function createBookingExecutor(deps: BookingExecutorDeps): BookingExecutor {
  return notImplemented(`createBookingExecutor(${typeof deps.stores})`);
}

/** Maps a complete core grant + decision into the opaque proof provider adapters require. */
export function toApprovalProof(
  grant: ApprovalGrant,
  decision: PolicyDecision,
  proposal: BookingProposal,
  grantedAuditEventId: AuditEventId,
): ApprovalProof {
  return notImplemented(
    `toApprovalProof(${grant.grantId}, ${decision.proposalId}, ${proposal.proposalId}, ${grantedAuditEventId})`,
  );
}
