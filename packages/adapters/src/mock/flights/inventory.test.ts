import { describe, expect, it } from 'vitest';
import { TravError, createSimulatedClock, parseIso } from '@trav/core';
import { createMockFlights } from './adapter.js';
import { loadFixture } from '../fixtures.js';
import { toFlightChoice } from './toFlightChoice.js';
import {
  loadMockFlightInventory,
  localToIso,
  minutesToIsoDuration,
  parseMockFlightInventory,
} from './inventory.js';

const minutes = (a: string, b: string): number => (parseIso(b) - parseIso(a)) / 60_000;

const REAL_AIRLINE_WORDS =
  /\b(delta|united|american|iberia|vueling|lufthansa|british airways|aer lingus|tap|icelandair|klm|air france|jetblue|level|norse|alaska|southwest|ryanair|easyjet)\b/i;

describe('shared fixtures/flights/barcelona.json (any supported shape)', () => {
  const inv = loadMockFlightInventory();

  it('parses, and every carrier name is fictional', () => {
    expect(inv.templates.length).toBeGreaterThanOrEqual(12);
    for (const o of inv.templates) {
      expect(o.owner.name).not.toMatch(REAL_AIRLINE_WORDS);
      for (const s of o.slices) {
        for (const seg of s.segments)
          expect(seg.marketingCarrier.name).not.toMatch(REAL_AIRLINE_WORDS);
      }
    }
  });
});

describe('T-029-a Duffel wire-shape fixture (barcelona-duffel.json)', () => {
  const inv = loadMockFlightInventory('barcelona-duffel');

  it('has 6 travelers from 6 distinct US origins, most flying home somewhere else', () => {
    expect(inv.travelers).toHaveLength(6);
    expect(new Set(inv.travelers.map((t) => t.origin)).size).toBe(6);
    const different = inv.travelers.filter((t) => t.origin !== t.returnTo);
    expect(different.length).toBeGreaterThanOrEqual(4);
    expect(inv.currency).toBe('EUR');
  });

  it('gives every traveler several round-trip options BCN and back to their return city', () => {
    for (const t of inv.travelers) {
      const options = inv.templates.filter(
        (o) =>
          o.slices[0]?.origin === t.origin &&
          o.slices[0]?.destination === 'BCN' &&
          o.slices[1]?.origin === 'BCN' &&
          o.slices[1]?.destination === t.returnTo,
      );
      expect(options.length, t.name).toBeGreaterThanOrEqual(3);
      expect(
        options.some((o) => o.refundBeforeDeparture.allowed),
        t.name,
      ).toBe(true);
      expect(
        options.some((o) => !o.refundBeforeDeparture.allowed),
        t.name,
      ).toBe(true);
    }
  });

  it('mixes nonstop and 1-stop slices (1–2 segments), with sane durations and layovers', () => {
    const segCounts = new Set(inv.templates.flatMap((o) => o.slices.map((s) => s.segments.length)));
    expect([...segCounts].sort()).toEqual([1, 2]);
    for (const o of inv.templates) {
      for (const s of o.slices) {
        for (const seg of s.segments) {
          const m = minutes(seg.departingAt, seg.arrivingAt);
          expect(m, `${o.templateId} ${seg.flightNumber}`).toBeGreaterThanOrEqual(60);
          expect(m, `${o.templateId} ${seg.flightNumber}`).toBeLessThanOrEqual(16 * 60);
          // Offsets are explicit and the time zone is IANA.
          expect(seg.departingAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
          expect(seg.arrivingAt).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
          expect(seg.departureTimeZone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
        }
        for (let i = 1; i < s.segments.length; i += 1) {
          const prev = s.segments[i - 1];
          const next = s.segments[i];
          if (!prev || !next) throw new Error('unreachable');
          const layover = minutes(prev.arrivingAt, next.departingAt);
          expect(layover, o.templateId).toBeGreaterThanOrEqual(45);
          expect(layover, o.templateId).toBeLessThanOrEqual(12 * 60);
        }
      }
    }
  });

  it('includes mock re-price and short-expiry offers', () => {
    expect(inv.templates.filter((o) => o.reprice !== undefined).length).toBeGreaterThanOrEqual(2);
    expect(inv.templates.some((o) => o.ttlMinutes < 30)).toBe(true);
  });

  it('uses fictional carriers only', () => {
    const raw = loadFixture('flights', 'barcelona-duffel') as {
      carriers: { iata_code: string; name: string }[];
    };
    for (const c of raw.carriers) {
      expect(c.iata_code).toMatch(/^X[A-Z]$/);
      expect(c.name).not.toMatch(REAL_AIRLINE_WORDS);
    }
    for (const o of inv.templates) {
      for (const s of o.slices) {
        for (const seg of s.segments) expect(seg.flightNumber.startsWith('X')).toBe(true);
      }
    }
  });

  it('converts Duffel-style local times to offsets across DST (US on DST, Spain not yet)', () => {
    const dean = inv.templates.find((o) => o.templateId === 'bos-jfk-1');
    const seg = dean?.slices[0]?.segments[0];
    expect(seg?.departingAt).toBe('2026-03-12T07:10:00-04:00');
    expect(seg?.arrivingAt).toBe('2026-03-12T19:35:00+01:00');
    expect(seg?.duration).toBe('PT7H25M');
  });
});

describe('parseMockFlightInventory validation', () => {
  const base = () => ({
    currency: 'EUR',
    default_offer_ttl_minutes: 30,
    carriers: [{ iata_code: 'XA', name: 'Larkspur Atlantic' }],
    offers: [
      {
        id: 'a',
        owner: 'XA',
        base_amount: '80.00',
        tax_amount: '20.00',
        total_amount: '100.00',
        conditions: {
          refund_before_departure: { allowed: false },
          change_before_departure: { allowed: false },
        },
        payment_requirements: { requires_instant_payment: true },
        slices: [
          {
            segments: [
              {
                origin: 'BOS',
                destination: 'BCN',
                departing_at: '2026-03-12T07:10:00',
                departure_time_zone: 'America/New_York',
                arriving_at: '2026-03-12T19:35:00',
                arrival_time_zone: 'Europe/Madrid',
                marketing_carrier: 'XA',
                flight_number: 'XA1',
              },
            ],
          },
        ],
      },
    ] as Record<string, unknown>[],
  });

  it('accepts a minimal valid inventory', () => {
    const inv = parseMockFlightInventory(base());
    expect(inv.templates[0]?.perPassengerTotal).toEqual({ amountMinor: 10000, currency: 'EUR' });
    expect(inv.travelers).toEqual([]);
    expect(inv.provider).toBe('mock-flights');
  });

  it('rejects base + tax != total', () => {
    const raw = base();
    (raw.offers[0] as Record<string, unknown>)['tax_amount'] = '21.00';
    expect(() => parseMockFlightInventory(raw)).toThrow(TravError);
  });

  it('rejects unknown carriers and duplicate ids', () => {
    const raw = base();
    (raw.offers[0] as Record<string, unknown>)['owner'] = 'ZZ';
    expect(() => parseMockFlightInventory(raw)).toThrow(/unknown carrier/);
    const dup = base();
    dup.offers.push({ ...(dup.offers[0] as Record<string, unknown>) });
    expect(() => parseMockFlightInventory(dup)).toThrow(/duplicate offer id/);
  });

  it('rejects a segment that lands before it departs', () => {
    const raw = base();
    const seg = (
      (raw.offers[0] as { slices: { segments: Record<string, unknown>[] }[] }).slices[0]
        ?.segments as Record<string, unknown>[]
    )[0] as Record<string, unknown>;
    seg['arriving_at'] = '2026-03-12T07:00:00';
    expect(() => parseMockFlightInventory(raw)).toThrow(/arrives before/);
  });

  it('rejects malformed money (sub-cent precision)', () => {
    const raw = base();
    (raw.offers[0] as Record<string, unknown>)['total_amount'] = '100.001';
    expect(() => parseMockFlightInventory(raw)).toThrow(TravError);
  });
});

describe('normalized (synthetic-data) shape', () => {
  const carrier = { iataCode: 'XQ', name: 'Gull Coast Air' };
  const s = (o: string, d: string, dep: string, arr: string, n: string) => ({
    origin: o,
    destination: d,
    departingAt: dep,
    departureTimeZone: 'UTC',
    arrivingAt: arr,
    arrivalTimeZone: 'UTC',
    marketingCarrier: carrier,
    flightNumber: n,
    duration: 'PT1H',
  });
  const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR' });
  const offer = (offerId: string, total: number, refundable: boolean) => ({
    offerId,
    provider: 'mock-flights',
    totalAmount: eur(total),
    baseAmount: eur(total - 1800),
    taxAmount: eur(1800),
    owner: carrier,
    slices: [
      {
        segments: [
          s('MIA', 'BCN', '2026-03-11T19:00:00-04:00', '2026-03-12T09:50:00+01:00', 'XQ81'),
        ],
      },
      {
        segments: [
          s('BCN', 'MAD', '2026-03-17T08:00:00+01:00', '2026-03-17T09:25:00+01:00', 'XQ3005'),
          s('MAD', 'DFW', '2026-03-17T11:45:00+01:00', '2026-03-17T16:20:00-05:00', 'XQ617'),
          s('DFW', 'AUS', '2026-03-17T17:45:00-05:00', '2026-03-17T18:50:00-05:00', 'XQ2214'),
        ],
      },
    ],
    passengerIds: ['mem_crowley'],
    conditions: {
      refundBeforeDeparture: refundable ? { allowed: true, penalty: eur(0) } : { allowed: false },
      changeBeforeDeparture: { allowed: true, penalty: eur(7500) },
    },
    paymentRequirements: {
      requiresInstantPayment: true,
      priceGuaranteeExpiresAt: '2026-02-03T20:42:30-05:00',
    },
    expiresAt: '2026-02-03T20:42:30-05:00',
  });
  const raw = () => ({
    fixtureVersion: 1,
    destination: 'BCN',
    currency: 'EUR',
    provider: 'mock-flights',
    members: [{ memberId: 'mem_crowley', origin: 'MIA', returnTo: 'AUS' }],
    offers: [
      offer('off_fl_crowley_a', 45500, false),
      offer('off_fl_crowley_d', 61000, true),
    ] as Record<string, unknown>[],
    mockHints: {
      off_fl_crowley_a: { expiresInMinutes: 30, priceOnRecheck: eur(46900) },
      off_fl_crowley_d: { expiresInMinutes: 3 },
    },
    groundTruth: { ignored: true },
  });

  it('maps offers, hints and members into templates', () => {
    const inv = parseMockFlightInventory(raw());
    expect(inv.travelers).toEqual([{ memberId: 'mem_crowley', origin: 'MIA', returnTo: 'AUS' }]);
    const [a, d] = inv.templates;
    expect(a?.templateId).toBe('off_fl_crowley_a');
    expect(a?.perPassengerTotal).toEqual(eur(45500));
    expect(a?.perPassengerTax).toEqual(eur(1800));
    expect(a?.reprice).toEqual({ afterMinutes: 0, perPassengerTotal: eur(46900) });
    expect(a?.ttlMinutes).toBe(30);
    expect(d?.ttlMinutes).toBe(3);
    expect(d?.refundBeforeDeparture).toEqual({ allowed: true, penaltyPerPassenger: eur(0) });
    // Durations are recomputed from the instants, not trusted from the fixture.
    expect(a?.slices[1]?.segments[1]?.duration).toBe('PT10H35M');
    expect(a?.slices[1]?.duration).toBe('PT16H50M');
  });

  it('drives the adapter: hints control expiry and re-price on first re-check', async () => {
    const clock = createSimulatedClock('2026-02-03T20:12:30-05:00');
    const flights = createMockFlights({ clock, inventory: parseMockFlightInventory(raw()) });
    const r = await flights.search({
      slices: [
        { origin: 'MIA', destination: 'BCN', departureDate: '2026-03-12' },
        { origin: 'BCN', destination: 'AUS', departureDate: '2026-03-17' },
      ],
      passengers: [{ memberId: 'mem_crowley', type: 'adult' }],
    });
    if (!r.ok) throw new Error(r.error.message);
    const a = r.value.find((o) => o.offerId.endsWith('off_fl_crowley_a'));
    const d = r.value.find((o) => o.offerId.endsWith('off_fl_crowley_d'));
    if (!a || !d) throw new Error('missing offers');
    expect(a.totalAmount).toEqual(eur(45500));
    const recheck = await flights.getOffer(a.offerId);
    expect(recheck.ok ? 'ok' : recheck.error.newAmount).toEqual(eur(46900));
    clock.advanceMs(3 * 60_000);
    const expired = await flights.getOffer(d.offerId);
    expect(expired.ok ? 'ok' : expired.error.code).toBe('offer_expired');
    // A 3-segment slice maps to 2 stops.
    expect(toFlightChoice(a, 'mem_crowley').inbound?.stops).toBe(2);
  });

  it('rejects totals that do not split evenly and wrong currencies', () => {
    const odd = raw();
    (odd.offers[0] as Record<string, unknown>)['passengerIds'] = ['mem_crowley', 'mem_dean'];
    (odd.offers[0] as Record<string, unknown>)['totalAmount'] = eur(45501);
    expect(() => parseMockFlightInventory(odd)).toThrow(/divide evenly/);
    const usd = raw();
    (usd.offers[0] as Record<string, unknown>)['totalAmount'] = { amountMinor: 1, currency: 'USD' };
    expect(() => parseMockFlightInventory(usd)).toThrow(TravError);
  });
});

describe('time helpers', () => {
  it('localToIso refuses wall times that do not exist (DST gap)', () => {
    // US clocks jump 02:00 → 03:00 on 2026-03-08.
    expect(() => localToIso('2026-03-08T02:30:00', 'America/New_York')).toThrow(/does not exist/);
    expect(localToIso('2026-03-08T03:30:00', 'America/New_York')).toBe('2026-03-08T03:30:00-04:00');
  });

  it('minutesToIsoDuration', () => {
    expect(minutesToIsoDuration(0)).toBe('PT0M');
    expect(minutesToIsoDuration(45)).toBe('PT45M');
    expect(minutesToIsoDuration(120)).toBe('PT2H');
    expect(minutesToIsoDuration(445)).toBe('PT7H25M');
    expect(() => minutesToIsoDuration(-1)).toThrow(TravError);
  });
});
