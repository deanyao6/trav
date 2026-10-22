/**
 * Shared types for Trav adapter interfaces. Primitives (`Money`, ids, ISO
 * strings, `Clock`, `Scheduler`) come from `@trav/core` and are re-exported
 * here so the provider interfaces stay readable; adapter-specific shapes
 * (`AdapterInfo`, `ApprovalProof`, `AdapterError`, `Result`) are defined here.
 *
 * Conventions:
 * - Money is always integer minor units + ISO 4217 code. Real APIs that return
 *   decimal strings (Duffel) or doubles (Plaid) are converted at the adapter edge
 *   (`parseDecimal` in @trav/core).
 * - Timestamps are ISO-8601 strings. Local wall-clock times (flight departures,
 *   event start times) carry an explicit IANA time zone alongside.
 * - Mocks read the injected `Clock` for expiries (holds, offers); never `Date.now()`.
 * - Expected failures are returned as `Result`, never thrown (D-010).
 */
import type { Money } from '@trav/core';

export type {
  AirportCode,
  Clock,
  CountryCode,
  CurrencyCode,
  GroupId,
  IdempotencyKey,
  IsoDate,
  IsoDateTime,
  IsoDuration,
  MemberId,
  Money,
  Scheduler,
  ScheduledJob,
  SimulatedClock,
  TimeZone,
  TripId,
} from '@trav/core';

/**
 * A member's address on a specific channel (phone number in E.164, WhatsApp id,
 * Telegram user id, or simulator handle). Never shown to other members unless
 * the channel already exposes it. Becomes `SenderId` in core once resolved.
 */
export type ChannelHandle = string;

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
  readonly countryCode: string;
  readonly geo?: GeoPoint;
  readonly timeZone?: string;
}

/** Cancellation/refund terms, normalized across providers. */
export interface RefundPolicy {
  readonly refundable: boolean;
  /** Last moment a full or partial refund is possible. */
  readonly refundableUntil?: string;
  /** Fee charged on refund/cancellation, if any. */
  readonly penalty?: Money;
  /** Short provider wording, already summarized (never raw HTML). Untrusted text. */
  readonly summary?: string;
}

/** A traveler as needed by booking providers. Minimal PII; passport data is out of scope for v0. */
export interface Traveler {
  readonly memberId: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly dateOfBirth?: string;
  readonly email?: string;
  readonly phone?: string;
}

/**
 * Proof that Trav's ApprovalPolicy approved a spend. Every money-moving adapter
 * method requires one; adapters must reject calls whose total exceeds
 * `maxAmount`, whose currency differs, or that arrive after `expiresAt`.
 * Produced only by `toApprovalProof()` in the BookingExecutor from a complete
 * core `ApprovalGrant`; adapters treat it as opaque evidence.
 */
export interface ApprovalProof {
  /** The core `grantId`. */
  readonly approvalId: string;
  readonly proposalId: string;
  readonly groupId: string;
  /** Members who approved (the requester plus any required co-approvers). */
  readonly approvedBy: readonly string[];
  readonly approvedAt: string;
  readonly expiresAt: string;
  /** Upper bound on the total the adapter may commit, including fees. */
  readonly maxAmount: Money;
  /** The `approval.granted` audit event id that completed the grant. */
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
  | 'not_configured'
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
