/**
 * Events, tickets, attractions and tours adapter. Shaped after a
 * reserve-then-purchase flow (Ticketmaster Partner API: reserve -> cart ->
 * purchase) with one issued ticket per holder so Trav can DM each member their
 * own QR code. Providers without a purchase API (SeatGeek, Fever, DICE, venue
 * sites) declare `purchaseMode: "redirect_only"` and only return checkout links.
 *
 * Covers nightlife (Razzmatazz), sports (Barca), attractions (Sagrada Familia,
 * Park Guell) and tours (Viator/GetYourGuide-style).
 */
import type { ContentTag } from '@trav/core';
import type {
  AdapterInfo,
  ApprovalProof,
  IdempotencyKey,
  IsoDate,
  IsoDateTime,
  MemberId,
  Money,
  Place,
  RefundPolicy,
  Result,
} from './common.js';

export type EventCategory =
  'nightlife' | 'concert' | 'sports' | 'attraction' | 'tour' | 'theatre' | 'food_drink' | 'other';

/** Content flags used by the minors/safety rules; core's `ContentTag`, so `safety.isRestrictedContent()` reads them directly. */
export type ContentFlag = ContentTag;

export interface EventSearchRequest {
  readonly city: string;
  readonly dateFrom: IsoDate;
  readonly dateTo: IsoDate;
  readonly query?: string;
  readonly categories?: readonly EventCategory[];
  /** Number of tickets needed together. */
  readonly quantity?: number;
  /** Max price per ticket incl. fees. */
  readonly maxUnitPrice?: Money;
}

export interface TicketEvent {
  readonly eventId: string;
  readonly provider: string;
  readonly name: string;
  readonly category: EventCategory;
  readonly venue: Place;
  readonly startsAt: IsoDateTime;
  readonly endsAt?: IsoDateTime;
  readonly doorsAt?: IsoDateTime;
  /** Minimum attendee age enforced by the venue (18 for most clubs). */
  readonly minimumAge?: number;
  readonly contentFlags: readonly ContentFlag[];
  readonly imageUrl?: string;
  readonly url?: string;
}

export type DeliveryMethod =
  'per_person_qr' | 'single_group_qr' | 'mobile_app_transfer' | 'will_call' | 'redirect';

export interface TicketOffer {
  readonly offerId: string;
  readonly eventId: string;
  /** e.g. "General admission", "Fast-line presale", "Tribuna Lateral". */
  readonly tierName: string;
  readonly unitPrice: Money;
  /** Per-ticket service fees. */
  readonly unitFees: Money;
  readonly available: number;
  readonly maxPerOrder: number;
  readonly refundPolicy: RefundPolicy;
  readonly deliveryMethod: DeliveryMethod;
  /** Provider requires each ticket to carry the holder's name. */
  readonly requiresHolderNames: boolean;
  readonly purchaseMode: 'api' | 'redirect_only';
  /** For redirect_only offers: where members buy it themselves. */
  readonly checkoutUrl?: string;
}

export interface TicketHold {
  readonly holdId: string;
  readonly offerId: string;
  readonly quantity: number;
  readonly subtotal: Money;
  readonly fees: Money;
  readonly taxes: Money;
  readonly total: Money;
  /** Seats are released after this time if not purchased. */
  readonly expiresAt: IsoDateTime;
}

export interface TicketHolder {
  readonly memberId: MemberId;
  readonly name: string;
  readonly email?: string;
}

export interface PurchaseTicketsRequest {
  readonly holdId: string;
  /** Exactly `quantity` holders; one ticket is issued per holder. */
  readonly holders: readonly TicketHolder[];
  readonly expectedTotal: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly approval: ApprovalProof;
}

export interface TicketBarcode {
  readonly format: 'qr' | 'pdf417' | 'code128';
  /** Value encoded in the barcode. Mocks use a fake, clearly non-scannable payload. */
  readonly payload: string;
}

export interface IssuedTicket {
  readonly ticketId: string;
  readonly holderMemberId: MemberId;
  readonly holderName: string;
  readonly barcode: TicketBarcode;
  readonly section?: string;
  readonly seat?: string;
  /** e.g. entry before 01:30 for presale fast-line. */
  readonly entryBefore?: IsoDateTime;
  readonly transferable: boolean;
}

export interface ReceiptLine {
  readonly description: string;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly amount: Money;
}

export type TicketOrderStatus = 'confirmed' | 'refunded' | 'partially_refunded' | 'cancelled';

export interface TicketOrder {
  readonly orderId: string;
  readonly event: TicketEvent;
  readonly offer: TicketOffer;
  readonly status: TicketOrderStatus;
  readonly total: Money;
  readonly receipt: {
    readonly receiptNumber: string;
    readonly issuedAt: IsoDateTime;
    readonly lines: readonly ReceiptLine[];
  };
  /** One per holder. */
  readonly tickets: readonly IssuedTicket[];
  readonly createdAt: IsoDateTime;
  readonly approvalId: string;
}

export interface TicketsAdapter {
  readonly info: AdapterInfo;

  /** Search events/attractions. Read-only. */
  searchEvents(request: EventSearchRequest): Promise<Result<readonly TicketEvent[]>>;

  /** List purchasable ticket tiers for an event that have at least `quantity` available. */
  getOffers(eventId: string, quantity: number): Promise<Result<readonly TicketOffer[]>>;

  /**
   * Temporarily reserve `quantity` tickets so the price is locked while the
   * group approves. Does not spend money. "sold_out" if not enough remain;
   * "not_supported" for redirect_only offers.
   */
  hold(
    offerId: string,
    quantity: number,
    idempotencyKey: IdempotencyKey,
  ): Promise<Result<TicketHold>>;

  /** Release a hold early (e.g. the group declined). */
  releaseHold(holdId: string): Promise<Result<void>>;

  /**
   * Purchase a held set of tickets. Enforces the ApprovalProof and
   * expectedTotal, requires holders.length === hold.quantity, and is idempotent
   * per idempotencyKey (a retry returns the same order, never a second one).
   * Returns "hold_expired" if the hold lapsed.
   */
  purchase(request: PurchaseTicketsRequest): Promise<Result<TicketOrder>>;

  /** Fetch an existing order with its issued tickets. */
  getOrder(orderId: string): Promise<Result<TicketOrder>>;

  /**
   * Get the single ticket belonging to one holder, for private delivery to
   * that member. Never returns other holders' barcodes.
   */
  getTicketForHolder(orderId: string, memberId: MemberId): Promise<Result<IssuedTicket>>;

  /**
   * Refund some or all tickets of an order (e.g. someone got sick before
   * entry). Requires approval; "not_supported" if the refund policy forbids it.
   */
  refund(
    orderId: string,
    ticketIds: readonly string[],
    approval: ApprovalProof,
    idempotencyKey: IdempotencyKey,
  ): Promise<Result<TicketOrder>>;
}
