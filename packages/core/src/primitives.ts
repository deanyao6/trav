/**
 * Primitive aliases shared by every package. Plain strings on purpose: ids are
 * opaque, prefixed strings (see `ids.ts`), times are ISO-8601 strings produced
 * by the injected `Clock` (see `clock.ts`), never by `Date.now()`.
 */

/** ISO 4217 currency code, e.g. "EUR", "USD", "JPY". */
export type CurrencyCode = string;
/** ISO-8601 date-time with offset, e.g. "2026-03-14T21:40:00+01:00". */
export type IsoDateTime = string;
/** ISO-8601 calendar date, e.g. "2026-03-14". */
export type IsoDate = string;
/** ISO-8601 duration, e.g. "PT2H26M". */
export type IsoDuration = string;
/** IANA time zone, e.g. "Europe/Madrid". */
export type TimeZone = string;
/** ISO 3166-1 alpha-2 country code. */
export type CountryCode = string;
/** IATA airport code, e.g. "BCN". */
export type AirportCode = string;

/** Opaque ids. Each carries the prefix listed in `ID_PREFIXES` (`ids.ts`). */
export type GroupId = string;
export type MemberId = string;
export type TripId = string;
export type ActivityId = string;
export type ExpenseId = string;
export type ProposalId = string;
export type BookingId = string;
export type GrantId = string;
export type AuditEventId = string;
export type MessageId = string;
export type CardId = string;
export type PrivateItemId = string;
export type JobId = string;

/**
 * Identity assigned by the channel adapter from channel metadata (simulator
 * participant id, iMessage handle, WhatsApp id). The only source of identity for
 * authorization decisions. Display names are labels, never identities.
 */
export type SenderId = string;

/** sha256 hex of the fields listed in SAFETY §2.1 "Idempotency". */
export type IdempotencyKey = string;
