/**
 * Lodging provider adapter. Shaped after hotel/apartment wholesalers
 * (Hotelbeds APItude: search -> recheck -> book; Expedia Rapid: shop -> price
 * check -> book). Airbnb has no public guest booking or host messaging API, so
 * `messageProperty` exists for providers that support it and returns
 * "not_supported" otherwise.
 */
import type {
  AdapterInfo,
  ApprovalProof,
  GeoPoint,
  GroupId,
  IdempotencyKey,
  IsoDate,
  IsoDateTime,
  MemberId,
  Money,
  Place,
  RefundPolicy,
  Result,
  Traveler,
} from './common.js';

export type PropertyKind = 'hotel' | 'apartment' | 'hostel' | 'vacation_rental';

export interface LodgingSearchRequest {
  /** Either a city/neighbourhood name or a point + radius. */
  readonly near: { readonly city: string } | { readonly geo: GeoPoint; readonly radiusKm: number };
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly adults: number;
  readonly childrenAges?: readonly number[];
  /** Prefer a single unit sleeping the whole group (the "6-person Airbnb" case). */
  readonly wholeUnitForGroup?: boolean;
  readonly minBedrooms?: number;
  readonly kinds?: readonly PropertyKind[];
  /** Upper bound on the stay total; providers may ignore, mocks must honor. */
  readonly maxTotal?: Money;
  readonly refundableOnly?: boolean;
}

export interface LodgingProperty {
  readonly propertyId: string;
  readonly provider: string;
  readonly name: string;
  readonly kind: PropertyKind;
  readonly place: Place;
  /** 0-5 stars or category, if applicable. */
  readonly starRating?: number;
  /** 0-10 normalized guest review score. */
  readonly reviewScore?: number;
  readonly amenities: readonly string[];
  readonly photoUrls: readonly string[];
  readonly bedrooms?: number;
  readonly maxOccupancy: number;
  /** External listing URL for "see it yourself" deep links. */
  readonly url?: string;
}

export interface LodgingRate {
  /** Opaque rate token (Hotelbeds rateKey, Expedia rate id). */
  readonly rateId: string;
  readonly propertyId: string;
  readonly roomName: string;
  readonly sleeps: number;
  /** Total payable now for the whole stay incl. taxes and provider fees. */
  readonly totalAmount: Money;
  /** Taxes/fees payable at the property (e.g. city tax), not included in totalAmount. */
  readonly payAtProperty?: Money;
  readonly refundPolicy: RefundPolicy;
  readonly boardBasis?: 'room_only' | 'breakfast' | 'half_board' | 'full_board' | 'all_inclusive';
  /** True if the rate must be rechecked before booking (Hotelbeds "RECHECK"). */
  readonly needsRecheck: boolean;
  readonly expiresAt?: IsoDateTime;
}

export interface LodgingSearchResult {
  readonly property: LodgingProperty;
  readonly rates: readonly LodgingRate[];
}

/**
 * The guest the stay is booked under (D-037). Hotels and hostels need the
 * family name; a whole-home rental (`vacation_rental` or `apartment`, the
 * Airbnb-style case) is booked under the lead guest's given name, which is
 * all its host sees.
 * v0 keeps no legal names, so the family name is present only when the
 * member's display name has one; nothing is ever invented. A real adapter
 * whose provider requires a surname for every kind must refuse without one.
 */
export interface LeadGuest extends Omit<Traveler, 'familyName'> {
  readonly familyName?: string;
}

export interface BookLodgingRequest {
  /**
   * The group the stay is booked for. Must equal `approval.groupId`;
   * a proof for another group is refused with `approval_invalid` (D-020).
   */
  readonly groupId: GroupId;
  readonly rateId: string;
  readonly leadGuest: LeadGuest;
  /** All members staying, for occupancy and the ledger split. */
  readonly guestMemberIds: readonly MemberId[];
  readonly expectedTotal: Money;
  readonly specialRequests?: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly approval: ApprovalProof;
}

export type LodgingBookingStatus = 'confirmed' | 'on_request' | 'cancelled';

export interface LodgingBooking {
  readonly bookingId: string;
  readonly confirmationCode: string;
  readonly status: LodgingBookingStatus;
  readonly property: LodgingProperty;
  readonly rate: LodgingRate;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly guestMemberIds: readonly MemberId[];
  /** Check-in instructions if the provider supplies them. */
  readonly checkInInstructions?: string;
  readonly createdAt: IsoDateTime;
  readonly approvalId: string;
}

export interface PropertyMessage {
  readonly from: 'guest' | 'property';
  readonly text: string;
  readonly sentAt: IsoDateTime;
}

export interface LodgingAdapter {
  readonly info: AdapterInfo;

  /** Search properties with bookable rates. Read-only. */
  search(request: LodgingSearchRequest): Promise<Result<readonly LodgingSearchResult[]>>;

  /**
   * Re-validate a rate's price and availability right before booking. Returns
   * the current rate, or "price_changed"/"sold_out"/"offer_expired".
   */
  recheckRate(rateId: string): Promise<Result<LodgingRate>>;

  /**
   * Book a rate. Enforces the ApprovalProof (group, expiry, max amount) and
   * expectedTotal; idempotent per idempotencyKey.
   */
  book(request: BookLodgingRequest): Promise<Result<LodgingBooking>>;

  /** Fetch an existing booking. */
  getBooking(bookingId: string): Promise<Result<LodgingBooking>>;

  /**
   * Cancel a booking. Requires approval because non-refundable or penalty
   * cancellations forfeit money.
   */
  cancel(
    bookingId: string,
    approval: ApprovalProof,
    idempotencyKey: IdempotencyKey,
  ): Promise<Result<LodgingBooking>>;

  /**
   * Send a message to the property/host about a booking (e.g. late check-in).
   * Returns "not_supported" for providers without host messaging (Airbnb has
   * no public API for this).
   */
  messageProperty(bookingId: string, text: string): Promise<Result<PropertyMessage>>;

  /** Read the message thread with the property/host. "not_supported" if unavailable. */
  listPropertyMessages(bookingId: string): Promise<Result<readonly PropertyMessage[]>>;
}
