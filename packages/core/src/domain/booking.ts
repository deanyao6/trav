/**
 * BookingProposal (what the model may create) and Booking (what the executor
 * wrote after a purchase). Shapes follow docs/SAFETY.md §2.1.
 */
import type {
  ActivityId,
  AuditEventId,
  BookingId,
  CurrencyCode,
  ExpenseId,
  GroupId,
  IdempotencyKey,
  IsoDate,
  IsoDateTime,
  MemberId,
  MessageId,
  ProposalId,
  TripId,
} from '../primitives.js';
import type { ContentTag } from './trip.js';

export type BookingKind = 'ticket' | 'flight' | 'lodging' | 'transport' | 'other';

/**
 * Who fronts the money (D-005). v0 default is `member_card`: the requester's
 * mock card pays and the total is split on the tab. `per_person_cards` is kept
 * so flights (each on their own card) can be expressed; the ledger then records
 * nothing to split.
 */
export type PaidBy =
  | { readonly kind: 'member_card'; readonly memberId: MemberId }
  | { readonly kind: 'per_person_cards' };

export interface ProposalPayer {
  readonly memberId: MemberId;
  readonly shareMinor: number;
}

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'executing'
  | 'completed'
  | 'failed';

export interface BookingProposal {
  readonly proposalId: ProposalId;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly activityId?: ActivityId;
  readonly kind: BookingKind;
  /** Adapter id, e.g. 'mock-tickets'. */
  readonly provider: string;
  /** Provider inventory id (eventId / offerId / rateId). */
  readonly itemRef: string;
  /** Human text for the chat card. Provider text passes through `wrapUntrusted` before any model sees it. */
  readonly description: string;
  /** City from provider metadata; `checkProposalConsistency` compares it with the trip city (G-02). */
  readonly city?: string;
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  /** The price is locked to this quote. */
  readonly quotedAt: IsoDateTime;
  /** Provider quote/hold id; purchase must present it. */
  readonly quoteRef: string;
  /** Provider hold expiry if shorter than the approval TTL. */
  readonly holdExpiresAt?: IsoDateTime;
  /** Who is charged; shares must sum to totalMinor. */
  readonly payers: readonly ProposalPayer[];
  /** Who the item is for (QR recipients); usually == payers. */
  readonly attendees: readonly MemberId[];
  readonly paidBy: PaidBy;
  readonly refundable: boolean;
  readonly refundDeadline?: IsoDateTime;
  /** Local event date for the idempotency key, '' if none. */
  readonly eventDate: IsoDate | '';
  readonly ageRestriction: number | null;
  readonly contentTags: readonly ContentTag[];
  readonly requestedBy: MemberId;
  readonly requestedAt: IsoDateTime;
  readonly sourceMessageId: MessageId;
  readonly idempotencyKey: IdempotencyKey;
  readonly status: ProposalStatus;
  /** Set when a `not me` or roster change produced a replacement. */
  readonly supersededBy?: ProposalId;
}

export type BookingStatus = 'confirmed' | 'cancelled' | 'refunded' | 'partially_refunded';

/** Reference to a ticket whose artifact (QR payload) lives in the owner's PrivateStore. */
export interface TicketRef {
  readonly ticketId: string;
  readonly holderMemberId: MemberId;
  /** Guardian for minors (VOICE §8). */
  readonly deliveredToMemberId: MemberId;
}

export interface Booking {
  readonly bookingId: BookingId;
  readonly proposalId: ProposalId;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly activityId?: ActivityId;
  readonly kind: BookingKind;
  readonly provider: string;
  /** Provider order id / PNR / confirmation code. */
  readonly providerRef: string;
  readonly orderRef: string;
  readonly description: string;
  readonly merchant: string;
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  readonly payers: readonly ProposalPayer[];
  readonly attendees: readonly MemberId[];
  readonly paidBy: PaidBy;
  readonly refundable: boolean;
  readonly refundDeadline?: IsoDateTime;
  readonly idempotencyKey: IdempotencyKey;
  readonly purchasedAt: IsoDateTime;
  readonly status: BookingStatus;
  /** No barcode payloads here, ever (SAFETY T5). */
  readonly tickets: readonly TicketRef[];
  /** Set by the executor after the ledger write. */
  readonly expenseId?: ExpenseId;
  readonly completedAuditEventId: AuditEventId;
}
