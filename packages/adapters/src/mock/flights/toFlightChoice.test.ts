import { describe, expect, it } from 'vitest';
import { TravError, createSimulatedClock, parseIso, sum } from '@trav/core';
import type { Money } from '@trav/core';
import type { FlightOffer, FlightSegment } from '../../interfaces/flights.js';
import { createMockFlights } from './adapter.js';
import { loadMockFlightInventory } from './inventory.js';
import { sliceToLeg, toFlightChoice } from './toFlightChoice.js';

const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });
const XB = { iataCode: 'XB', name: 'Bluefin Air' };
const XD = { iataCode: 'XD', name: 'Cobalt Coast Airlines' };

function seg(
  origin: string,
  destination: string,
  departingAt: string,
  arrivingAt: string,
  flightNumber: string,
  carrier = XB,
): FlightSegment {
  return {
    origin,
    destination,
    departingAt,
    departureTimeZone: 'UTC',
    arrivingAt,
    arrivalTimeZone: 'UTC',
    marketingCarrier: carrier,
    flightNumber,
    duration: 'PT0M',
  };
}

/** SFO → JFK → BCN (110 min connection at JFK), back BCN → LHR → LAX on two carriers. */
const twoSegmentOffer: FlightOffer = {
  offerId: 'off_test_1',
  provider: 'mock-flights',
  totalAmount: eur(100001),
  owner: XB,
  passengerIds: ['mem_chase', 'mem_crowley', 'mem_arjun'],
  slices: [
    {
      origin: 'SFO',
      destination: 'BCN',
      duration: 'PT15H10M',
      segments: [
        seg('SFO', 'JFK', '2026-03-11T22:30:00-07:00', '2026-03-12T06:55:00-04:00', 'XB52'),
        seg('JFK', 'BCN', '2026-03-12T08:45:00-04:00', '2026-03-12T21:40:00+01:00', 'XB880'),
      ],
    },
    {
      origin: 'BCN',
      destination: 'LAX',
      duration: 'PT16H20M',
      segments: [
        seg('BCN', 'LHR', '2026-03-17T10:00:00+01:00', '2026-03-17T11:05:00Z', 'XD341', XD),
        seg('LHR', 'LAX', '2026-03-17T13:20:00Z', '2026-03-17T17:20:00-07:00', 'XD95', XD),
      ],
    },
  ],
  conditions: {
    refundBeforeDeparture: { allowed: true, penalty: eur(9000) },
    changeBeforeDeparture: { allowed: true },
  },
  paymentRequirements: { requiresInstantPayment: false },
  expiresAt: '2026-02-10T20:30:00+01:00',
};

describe('toFlightChoice', () => {
  it('maps a 2-segment itinerary: layover minutes, instants, stops, per-person cost', () => {
    const choice = toFlightChoice(twoSegmentOffer, 'mem_arjun');
    expect(choice.memberId).toBe('mem_arjun');
    expect(choice.offerId).toBe('off_test_1');
    expect(choice.provider).toBe('mock-flights');
    expect(choice.refundable).toBe(true);

    expect(choice.outbound).toEqual({
      origin: 'SFO',
      destination: 'BCN',
      departAt: '2026-03-11T22:30:00-07:00',
      arriveAt: '2026-03-12T21:40:00+01:00',
      stops: 1,
      // 05:30Z → 20:40Z.
      durationMinutes: 910,
      // JFK: lands 06:55, departs 08:45 (same zone).
      longestLayoverMinutes: 110,
      carrier: 'Bluefin Air',
      flightNumbers: ['XB52', 'XB880'],
    });
    // Instants survive the mapping exactly.
    expect(parseIso(choice.outbound.arriveAt)).toBe(Date.UTC(2026, 2, 12, 20, 40));

    expect(choice.inbound).toEqual({
      origin: 'BCN',
      destination: 'LAX',
      departAt: '2026-03-17T10:00:00+01:00',
      arriveAt: '2026-03-17T17:20:00-07:00',
      stops: 1,
      // 09:00Z → 00:20Z next day.
      durationMinutes: 920,
      // LHR: lands 11:05Z, departs 13:20Z.
      longestLayoverMinutes: 135,
      carrier: 'Cobalt Coast Airlines',
      flightNumbers: ['XD341', 'XD95'],
    });

    // €1,000.01 / 3: the extra cents go to the first passengers; shares sum exactly.
    const shares = twoSegmentOffer.passengerIds.map(
      (m) => toFlightChoice(twoSegmentOffer, m).price,
    );
    expect(shares).toEqual([eur(33334), eur(33334), eur(33333)]);
    expect(sum(shares, 'EUR')).toEqual(twoSegmentOffer.totalAmount);
    expect(choice.price).toEqual(eur(33333));
  });

  it('computes layovers across a time-zone change (instant arithmetic, not wall clock)', () => {
    // Lands LIS 04:55 (UTC+0), next leg departs 07:30 LIS: 155 min.
    const leg = sliceToLeg({
      origin: 'BOS',
      destination: 'BCN',
      duration: 'PT11H50M',
      segments: [
        seg('BOS', 'LIS', '2026-03-11T18:40:00-04:00', '2026-03-12T04:55:00Z', 'XC204'),
        seg('LIS', 'BCN', '2026-03-12T07:30:00Z', '2026-03-12T10:30:00+01:00', 'XC1450', XD),
      ],
    });
    expect(leg.longestLayoverMinutes).toBe(155);
    // 22:40Z → 09:30Z next day.
    expect(leg.durationMinutes).toBe(10 * 60 + 50);
    expect(leg.carrier).toBe('Bluefin Air + Cobalt Coast Airlines');
  });

  it('nonstop legs have 0 stops and 0 layover; one-way offers have no inbound', () => {
    const oneWay: FlightOffer = {
      ...twoSegmentOffer,
      passengerIds: ['mem_dean'],
      totalAmount: eur(41200),
      conditions: {
        refundBeforeDeparture: { allowed: false },
        changeBeforeDeparture: { allowed: false },
      },
      slices: [
        {
          origin: 'BOS',
          destination: 'BCN',
          duration: 'PT7H25M',
          segments: [
            seg('BOS', 'BCN', '2026-03-12T07:10:00-04:00', '2026-03-12T19:35:00+01:00', 'XA110'),
          ],
        },
      ],
    };
    const choice = toFlightChoice(oneWay, 'mem_dean');
    expect(choice.outbound.stops).toBe(0);
    expect(choice.outbound.longestLayoverMinutes).toBe(0);
    expect(choice.outbound.durationMinutes).toBe(445);
    expect(choice.inbound).toBeUndefined();
    expect('inbound' in choice).toBe(false);
    expect(choice.price).toEqual(eur(41200));
    expect(choice.refundable).toBe(false);
  });

  it('throws for a member who is not on the offer, and for malformed offers', () => {
    expect(() => toFlightChoice(twoSegmentOffer, 'mem_henry')).toThrow(TravError);
    expect(() => toFlightChoice({ ...twoSegmentOffer, slices: [] }, 'mem_chase')).toThrow(
      /no slices/,
    );
    const first = twoSegmentOffer.slices[0];
    if (!first) throw new Error('unreachable');
    expect(() =>
      toFlightChoice({ ...twoSegmentOffer, slices: [first, first, first] }, 'mem_chase'),
    ).toThrow(/more than two/);
    expect(() => sliceToLeg({ ...first, segments: [] })).toThrow(TravError);
    const [a, b] = first.segments;
    if (!a || !b) throw new Error('unreachable');
    expect(() => sliceToLeg({ ...first, segments: [b, a] })).toThrow(TravError);
  });

  it('maps every mock fixture offer for a traveler into a valid FlightChoice', async () => {
    const flights = createMockFlights({
      clock: createSimulatedClock('2026-02-10T20:00:00+01:00'),
      inventory: loadMockFlightInventory('barcelona-duffel'),
    });
    const r = await flights.search({
      slices: [
        { origin: 'SFO', destination: 'BCN', departureDate: '2026-03-12' },
        { origin: 'BCN', destination: 'LAX', departureDate: '2026-03-17' },
      ],
      passengers: [{ memberId: 'mem_chase', type: 'adult' }],
    });
    if (!r.ok) throw new Error(r.error.message);
    const choices = r.value.map((o) => toFlightChoice(o, 'mem_chase'));
    expect(choices).toHaveLength(4);
    for (const c of choices) {
      expect(c.outbound.destination).toBe('BCN');
      expect(c.inbound?.destination).toBe('LAX');
      expect(c.outbound.stops).toBeLessThanOrEqual(1);
      expect(c.price.currency).toBe('EUR');
    }
    const viaJfk = choices.find((c) => c.outbound.flightNumbers.join() === 'XB52,XB880');
    expect(viaJfk?.outbound.longestLayoverMinutes).toBe(110);
    expect(viaJfk?.outbound.arriveAt).toBe('2026-03-12T21:40:00+01:00');
    expect(viaJfk?.price).toEqual(eur(53800));
  });
});
