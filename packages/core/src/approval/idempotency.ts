/**
 * Booking idempotency key (SAFETY §2.1 "Idempotency"). The same thing for the
 * same people on the same day is the same purchase, whoever asks and whenever.
 */
import type { CurrencyCode, GroupId, IdempotencyKey, MemberId, TripId } from '../primitives.js';
import type { BookingKind } from '../domain/booking.js';
import { TravError } from '../errors.js';
import { sha256Hex } from '../audit/index.js';

export interface IdempotencyInput {
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly kind: BookingKind;
  readonly provider: string;
  readonly itemRef: string;
  readonly eventDate: string;
  readonly payerIds: readonly MemberId[];
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  /** Only for an explicit "buy it again" (SAFETY §2.1); audited as booking.duplicate_override. */
  readonly nonce?: string;
}

const SEPARATOR = '|';

/**
 * sha256(groupId|tripId|kind|provider|itemRef|eventDate|sortedPayerIds.join(',')|totalMinor|currency[|nonce]).hex
 * Deliberately excludes requestedAt, sourceMessageId and requestedBy.
 */
export function deriveIdempotencyKey(input: IdempotencyInput): IdempotencyKey {
  if (!Number.isInteger(input.totalMinor)) {
    throw new TravError('invalid_argument', 'idempotency: totalMinor must be an integer', {
      totalMinor: input.totalMinor,
    });
  }
  const fields = [
    input.groupId,
    input.tripId,
    input.kind,
    input.provider,
    input.itemRef,
    input.eventDate,
    [...new Set(input.payerIds)].sort().join(','),
    String(input.totalMinor),
    input.currency,
  ];
  for (const field of fields) {
    if (field.includes(SEPARATOR)) {
      throw new TravError('invalid_argument', `idempotency: field contains "${SEPARATOR}"`);
    }
  }
  if (input.nonce !== undefined && input.nonce !== '') fields.push(input.nonce);
  return sha256Hex(fields.join(SEPARATOR));
}
