/**
 * Shared primitive types for Trav adapter interfaces.
 *
 * Types only, with no runtime logic. These are defined locally so the adapters
 * package does not depend on other packages; `packages/core` may define richer
 * equivalents and map to/from these at the boundary.
 *
 * Conventions:
 * - Money is always integer minor units + ISO 4217 code. Real APIs that return
 *   decimal strings (Duffel) or doubles (Plaid) are converted at the adapter edge.
 * - Timestamps are ISO-8601 strings. Local wall-clock times (flight departures,
 *   event start times) carry an explicit IANA time zone alongside.
 */

/** ISO 4217 currency code, e.g. "EUR", "USD". */
export type CurrencyCode = string;

/** Amount in integer minor units (cents for EUR/USD, whole yen for JPY). */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

/** ISO-8601 date-time string with offset, e.g. "2026-10-22T23:30:00+02:00". */
export type IsoDateTime = string;
/** ISO-8601 calendar date, e.g. "2026-10-22". */
export type IsoDate = string;
/** ISO-8601 duration, e.g. "PT2H26M". */
export type IsoDuration = string;
/** IANA time zone name, e.g. "Europe/Madrid". */
export type TimeZone = string;
/** ISO 3166-1 alpha-2 country code, e.g. "ES". */
export type CountryCode = string;
/** IATA airport code, e.g. "BCN". */
export type AirportCode = string;

/** Trav-internal identifiers (opaque strings). */
export type GroupId = string;
export type TripId = string;
export type MemberId = string;

/**
 * A member's address on a specific channel (phone number in E.164, WhatsApp id,
 * Telegram user id, or simulator handle). Never shown to other members unless
 * the channel already exposes it.
 */
export type ChannelHandle = string;

/** Caller-supplied key that makes a mutating call safe to retry without double effects. */
export type IdempotencyKey = string;

/** Which backend an adapter talks to. Only "mock" is permitted in v0. */
export type AdapterMode = 'mock' | 'sandbox' | 'live';

/** Static description of an adapter instance. */
export interface AdapterInfo {
  /** Stable provider name, e.g. "mock-tickets", "duffel", "sendblue". */
  readonly provider: string;
  readonly mode: AdapterMode;
}

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface Place {
  readonly name: string;
  readonly address?: string;
  readonly city: string;
  readonly countryCode: CountryCode;
  readonly geo?: GeoPoint;
  readonly timeZone?: TimeZone;
}

/** Cancellation/refund terms, normalized across providers. */
export interface RefundPolicy {
  readonly refundable: boolean;
  /** Last moment a full or partial refund is possible. */
  readonly refundableUntil?: IsoDateTime;
  /** Fee charged on refund/cancellation, if any. */
  readonly penalty?: Money;
  /** Short provider wording, already summarized (never raw HTML). */
  readonly summary?: string;
}

/** A traveler as needed by booking providers. Minimal PII; passport data is out of scope for v0. */
export interface Traveler {
  readonly memberId: MemberId;
  readonly givenName: string;
  readonly familyName: string;
  readonly dateOfBirth?: IsoDate;
  readonly email?: string;
  readonly phone?: string;
}

/**
 * Proof that Trav's ApprovalPolicy approved a spend. Every money-moving adapter
 * method requires one; adapters must reject calls whose total exceeds
 * `maxAmount`, whose currency differs, or that arrive after `expiresAt`.
 * Produced only by the core ApprovalPolicy; adapters treat it as opaque evidence.
 */
export interface ApprovalProof {
  readonly approvalId: string;
  readonly groupId: GroupId;
  /** Members who approved (the requester plus any required co-approvers). */
  readonly approvedBy: readonly MemberId[];
  readonly approvedAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  /** Upper bound on the total the adapter may commit, including fees. */
  readonly maxAmount: Money;
  /** Audit log entry that recorded this approval. */
  readonly auditEventId: string;
}

export type AdapterErrorCode =
  | 'not_found'
  | 'invalid_request'
  | 'sold_out'
  | 'price_changed'
  | 'offer_expired'
  | 'hold_expired'
  | 'approval_invalid'
  | 'approval_exceeded'
  | 'consent_required'
  | 'not_supported'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'duplicate';

export interface AdapterError {
  readonly code: AdapterErrorCode;
  /** Developer-facing message; Trav rewrites it in its own voice before showing users. */
  readonly message: string;
  readonly retryable: boolean;
  /** For "price_changed": the new price. */
  readonly newAmount?: Money;
}

/** Adapters return results instead of throwing for expected failures. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AdapterError };

/** Function returned by subscriptions; call to stop receiving events. */
export type Unsubscribe = () => void;
