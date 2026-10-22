/**
 * Provider offer → core `flights.FlightChoice` (the optimizer never sees
 * provider types). Works for any `FlightOffer` (mock or a future Duffel adapter).
 *
 * - `outbound` = first slice, `inbound` = second slice (if any).
 * - Leg instants come from the segments' offset-carrying ISO strings, so
 *   durations and layovers are real elapsed minutes across time zones.
 * - `price` is this member's share of the offer total: `allocateEqual` over
 *   `passengerIds` (remainder cents go to the earliest passengers), so the
 *   shares of every passenger sum exactly to `totalAmount`.
 */
import { TravError, allocateEqual, parseIso } from '@trav/core';
import type { MemberId, flights } from '@trav/core';
import type { FlightOffer, FlightSlice } from '../../interfaces/flights.js';

function minutes(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso) - parseIso(fromIso)) / 60_000);
}

/** Maps one provider slice to a core `Leg`. Throws on an empty or inconsistent slice. */
export function sliceToLeg(slice: FlightSlice): flights.Leg {
  const segs = slice.segments;
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (!first || !last) {
    throw new TravError(
      'invalid_argument',
      `slice ${slice.origin}-${slice.destination} has no segments`,
    );
  }
  let longestLayoverMinutes = 0;
  for (let i = 1; i < segs.length; i += 1) {
    const prev = segs[i - 1];
    const next = segs[i];
    if (!prev || !next) continue;
    const layover = minutes(prev.arrivingAt, next.departingAt);
    if (layover < 0) {
      throw new TravError(
        'invalid_argument',
        `segment ${next.flightNumber} departs before ${prev.flightNumber} lands`,
      );
    }
    longestLayoverMinutes = Math.max(longestLayoverMinutes, layover);
  }
  const durationMinutes = minutes(first.departingAt, last.arrivingAt);
  if (durationMinutes <= 0) {
    throw new TravError(
      'invalid_argument',
      `slice ${slice.origin}-${slice.destination} has non-positive duration`,
    );
  }
  const carriers = [...new Set(segs.map((s) => s.marketingCarrier.name))];
  return {
    origin: first.origin,
    destination: last.destination,
    departAt: first.departingAt,
    arriveAt: last.arrivingAt,
    stops: segs.length - 1,
    durationMinutes,
    longestLayoverMinutes,
    carrier: carriers.join(' + '),
    flightNumbers: segs.map((s) => s.flightNumber),
  };
}

/**
 * Maps `offer` to the `FlightChoice` for `memberId`. Throws
 * `TravError('invalid_argument')` if the member is not a passenger on the offer
 * or the offer has no slices / more than two (multi-city is out of scope).
 */
export function toFlightChoice(offer: FlightOffer, memberId: MemberId): flights.FlightChoice {
  const index = offer.passengerIds.indexOf(memberId);
  if (index < 0) {
    throw new TravError(
      'invalid_argument',
      `member ${memberId} is not a passenger on ${offer.offerId}`,
    );
  }
  const [outSlice, inSlice, extra] = offer.slices;
  if (!outSlice) throw new TravError('invalid_argument', `offer ${offer.offerId} has no slices`);
  if (extra) {
    throw new TravError('invalid_argument', `offer ${offer.offerId} has more than two slices`);
  }
  const shares = allocateEqual(offer.totalAmount, offer.passengerIds.length);
  const price = shares[index];
  if (!price) throw new TravError('invariant_violation', 'allocateEqual returned too few shares');
  const choice: flights.FlightChoice = {
    memberId,
    offerId: offer.offerId,
    provider: offer.provider,
    outbound: sliceToLeg(outSlice),
    price,
    refundable: offer.conditions.refundBeforeDeparture.allowed,
  };
  return inSlice ? { ...choice, inbound: sliceToLeg(inSlice) } : choice;
}
