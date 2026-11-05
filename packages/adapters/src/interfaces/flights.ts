/**
 * Flight provider adapter. Shaped after Duffel's offers/orders model (the only
 * self-serve booking API with a test mode as of 2026-10; Amadeus Self-Service
 * closed 2026-07-17). Multi-origin group search = one `search` per origin; the
 * optimizer in packages/core combines the results.
 */
import type {
  AdapterInfo,
  AirportCode,
  ApprovalProof,
  GroupId,
  IdempotencyKey,
  IsoDate,
  IsoDateTime,
  IsoDuration,
  MemberId,
  Money,
  Result,
  TimeZone,
  Traveler,
} from './common.js';

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';
export type PassengerType = 'adult' | 'child' | 'infant_without_seat';

export interface FlightSearchSlice {
  readonly origin: AirportCode;
  readonly destination: AirportCode;
  readonly departureDate: IsoDate;
  /** Optional local-time window, e.g. { from: "06:00", to: "14:00" }. */
  readonly departureWindow?: { readonly from: string; readonly to: string };
}

export interface FlightSearchRequest {
  /** One slice for one-way, two for round trip, more for open-jaw. */
  readonly slices: readonly FlightSearchSlice[];
  readonly passengers: readonly { readonly memberId: MemberId; readonly type: PassengerType }[];
  readonly cabinClass?: CabinClass;
  /** 0 = nonstop only. */
  readonly maxConnections?: number;
  /** Preferred display currency; providers may still return their own. */
  readonly currency?: string;
}

export interface Carrier {
  readonly iataCode: string;
  readonly name: string;
}

export interface FlightSegment {
  readonly origin: AirportCode;
  readonly destination: AirportCode;
  /** Local wall-clock time at origin, with offset. */
  readonly departingAt: IsoDateTime;
  readonly departureTimeZone: TimeZone;
  /** Local wall-clock time at destination, with offset. */
  readonly arrivingAt: IsoDateTime;
  readonly arrivalTimeZone: TimeZone;
  readonly marketingCarrier: Carrier;
  readonly operatingCarrier?: Carrier;
  readonly flightNumber: string;
  readonly duration: IsoDuration;
}

export interface FlightSlice {
  readonly origin: AirportCode;
  readonly destination: AirportCode;
  readonly duration: IsoDuration;
  readonly segments: readonly FlightSegment[];
}

export interface ChangeOrRefundCondition {
  readonly allowed: boolean;
  readonly penalty?: Money;
}

export interface FlightOffer {
  readonly offerId: string;
  readonly provider: string;
  /** Total for all passengers on the offer, incl. taxes. */
  readonly totalAmount: Money;
  readonly baseAmount?: Money;
  readonly taxAmount?: Money;
  readonly owner: Carrier;
  readonly slices: readonly FlightSlice[];
  readonly passengerIds: readonly MemberId[];
  readonly conditions: {
    readonly refundBeforeDeparture: ChangeOrRefundCondition;
    readonly changeBeforeDeparture: ChangeOrRefundCondition;
  };
  readonly paymentRequirements: {
    readonly requiresInstantPayment: boolean;
    readonly priceGuaranteeExpiresAt?: IsoDateTime;
    readonly paymentRequiredBy?: IsoDateTime;
  };
  /** Offers go stale; must be re-fetched with getOffer before ordering. */
  readonly expiresAt: IsoDateTime;
}

/**
 * A passenger on a flight order (D-040). v0 keeps no legal names, so the
 * family name is sent only when the member's display name has one; nothing
 * is ever invented. The MOCK provider books under the given name alone (a
 * demo, nobody flies); a real adapter must refuse a traveler without a
 * family name (`invalid_request`): an airline ticket needs the full name as
 * on the passport (docs/QUESTIONS.md, traveler profile).
 */
export interface FlightTraveler extends Omit<Traveler, 'familyName'> {
  readonly familyName?: string;
}

export interface CreateFlightOrderRequest {
  /**
   * The group the flights are booked for. Must equal `approval.groupId`;
   * a proof for another group is refused with `approval_invalid` (D-020).
   */
  readonly groupId: GroupId;
  readonly offerId: string;
  /** One traveler per passengerId on the offer. */
  readonly travelers: readonly FlightTraveler[];
  /** The total the group approved; must equal the re-priced offer total. */
  readonly expectedTotal: Money;
  readonly idempotencyKey: IdempotencyKey;
  readonly approval: ApprovalProof;
}

export type FlightOrderStatus = 'confirmed' | 'pending_payment' | 'cancelled';

export interface FlightOrder {
  readonly orderId: string;
  /** Airline booking reference (PNR), e.g. "RZPNQ3". */
  readonly bookingReference: string;
  readonly status: FlightOrderStatus;
  readonly totalAmount: Money;
  readonly travelers: readonly FlightTraveler[];
  /** Snapshot of the offer as booked. */
  readonly offer: FlightOffer;
  readonly createdAt: IsoDateTime;
  readonly approvalId: string;
}

export interface CancellationQuote {
  readonly quoteId: string;
  readonly orderId: string;
  readonly refundAmount: Money;
  readonly expiresAt: IsoDateTime;
}

export interface FlightsAdapter {
  readonly info: AdapterInfo;

  /** Search offers for one itinerary (one origin). Read-only; never spends money. */
  search(request: FlightSearchRequest): Promise<Result<readonly FlightOffer[]>>;

  /**
   * Re-fetch a single offer to get its current price and availability. Must be
   * called before createOrder; returns "offer_expired" or "price_changed" (with
   * newAmount) when applicable.
   */
  getOffer(offerId: string): Promise<Result<FlightOffer>>;

  /**
   * Book an offer. Rejects with "approval_invalid"/"approval_exceeded" if the
   * ApprovalProof is expired, for another group, or below the total; with
   * "price_changed" if expectedTotal no longer matches. Same idempotencyKey
   * returns the original order instead of booking twice.
   *
   * TODO(real adapter, D-040): a group set is one order per traveler, so a
   * real provider can leave a set half-booked. Only a definite refusal means
   * "not charged"; a timeout or a 5xx after the request was sent must come back
   * as `provider_unavailable` (outcome unknown), and the adapter must support
   * finding the order by `idempotencyKey` so the executor can compensate (keep
   * it, or cancel it through the approval path) before telling the group.
   * The same holds when the *first* order fails as `provider_unavailable`:
   * the executor's no-landed path still says "no charge went through", which
   * is only true for the in-process mock.
   */
  createOrder(request: CreateFlightOrderRequest): Promise<Result<FlightOrder>>;

  /** Fetch an existing order. */
  getOrder(orderId: string): Promise<Result<FlightOrder>>;

  /** Quote what a cancellation would refund. Read-only. */
  quoteCancellation(orderId: string): Promise<Result<CancellationQuote>>;

  /**
   * Confirm a previously quoted cancellation. Requires an ApprovalProof because
   * forfeiting a penalty is a spend decision.
   */
  confirmCancellation(
    quoteId: string,
    approval: ApprovalProof,
    idempotencyKey: IdempotencyKey,
  ): Promise<Result<FlightOrder>>;
}
