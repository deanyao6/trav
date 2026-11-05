import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMinutes, createSimulatedClock, formatIso, parseIso } from '@trav/core';
import type { Money, SimulatedClock } from '@trav/core';
import type { ApprovalProof, Result, Traveler } from '../../interfaces/common.js';
import type {
  CreateFlightOrderRequest,
  FlightOffer,
  FlightSearchRequest,
} from '../../interfaces/flights.js';
import { createMockFlights } from './adapter.js';
import type { MockFlightsAdapter } from './adapter.js';
import { loadMockFlightInventory } from './inventory.js';

/**
 * Pinned-value tests use the T-029-a-owned Duffel wire-shape fixture so they do
 * not depend on whichever shape `fixtures/flights/barcelona.json` currently has.
 */
const inventory = loadMockFlightInventory('barcelona-duffel');
const START = '2026-02-10T20:00:00+01:00';
const eur = (amountMinor: number): Money => ({ amountMinor, currency: 'EUR' });

function deanSearch(over: Partial<FlightSearchRequest> = {}): FlightSearchRequest {
  return {
    slices: [
      { origin: 'BOS', destination: 'BCN', departureDate: '2026-03-12' },
      { origin: 'BCN', destination: 'JFK', departureDate: '2026-03-17' },
    ],
    passengers: [{ memberId: 'mem_dean', type: 'adult' }],
    ...over,
  };
}

function traveler(memberId: string): Traveler {
  const name = memberId.replace('mem_', '');
  return { memberId, givenName: name[0]?.toUpperCase() + name.slice(1), familyName: 'Testperson' };
}

function proofFor(
  clock: SimulatedClock,
  maxAmount: Money,
  over: Partial<ApprovalProof> = {},
): ApprovalProof {
  return {
    approvalId: 'grant_t000001',
    proposalId: 'prop_t000001',
    groupId: 'grp_barcelona',
    approvedBy: ['mem_dean'],
    approvedAt: clock.now(),
    expiresAt: addMinutes(clock.now(), 15),
    maxAmount,
    auditEventId: 'aud_t000001',
    ...over,
  };
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function errorCode<T>(r: Result<T>): string {
  if (r.ok) throw new Error('expected an error result');
  return r.error.code;
}

function byTemplate(offers: readonly FlightOffer[], templateId: string): FlightOffer {
  const o = offers.find((x) => x.offerId.endsWith(`_${templateId}`));
  if (!o) throw new Error(`no offer for ${templateId}`);
  return o;
}

let clock: SimulatedClock;
let flights: MockFlightsAdapter;

beforeEach(() => {
  // Any network attempt fails the test loudly.
  vi.stubGlobal('fetch', () => {
    throw new Error('network access attempted in a mock adapter test');
  });
  clock = createSimulatedClock(START);
  flights = createMockFlights({ clock, inventory, groupId: 'grp_barcelona' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('search', () => {
  it('returns Duffel-shaped round-trip offers sorted by price, expiring on the clock', async () => {
    const offers = unwrap(await flights.search(deanSearch()));
    expect(flights.info).toEqual({ provider: 'mock-flights', mode: 'mock' });
    expect(offers.map((o) => o.offerId.replace(/^off_mock_\d+_/, ''))).toEqual([
      'bos-jfk-2',
      'bos-jfk-3',
      'bos-jfk-4',
      'bos-jfk-1',
    ]);
    const o = byTemplate(offers, 'bos-jfk-1');
    expect(o.totalAmount).toEqual(eur(41200));
    expect(o.taxAmount).toEqual(eur(6600));
    expect(o.baseAmount).toEqual(eur(34600));
    expect(o.passengerIds).toEqual(['mem_dean']);
    expect(o.expiresAt).toBe('2026-02-10T20:30:00+01:00');
    expect(o.owner).toEqual({ iataCode: 'XA', name: 'Larkspur Atlantic' });
    expect(o.slices.map((s) => `${s.origin}-${s.destination}`)).toEqual(['BOS-BCN', 'BCN-JFK']);
    expect(o.conditions.refundBeforeDeparture).toEqual({ allowed: true, penalty: eur(7500) });
    expect(o.paymentRequirements.requiresInstantPayment).toBe(false);
    expect(byTemplate(offers, 'bos-jfk-2').conditions.refundBeforeDeparture.allowed).toBe(false);
    expect(byTemplate(offers, 'bos-jfk-2').slices[0]?.segments).toHaveLength(2);
  });

  it('honors exact dates when dateFlexDays is 0, maxConnections, and departure windows', async () => {
    const exact = createMockFlights({ clock, inventory, dateFlexDays: 0 });
    const exactIds = unwrap(await exact.search(deanSearch())).map((o) => o.offerId.slice(-9));
    expect(exactIds.sort()).toEqual(['bos-jfk-1', 'bos-jfk-4']);

    const nonstop = unwrap(await flights.search(deanSearch({ maxConnections: 0 })));
    expect(nonstop.every((o) => o.slices.every((s) => s.segments.length === 1))).toBe(true);
    expect(nonstop).toHaveLength(3);

    const morning = unwrap(
      await flights.search(
        deanSearch({
          slices: [
            {
              origin: 'BOS',
              destination: 'BCN',
              departureDate: '2026-03-12',
              departureWindow: { from: '06:00', to: '09:00' },
            },
            { origin: 'BCN', destination: 'JFK', departureDate: '2026-03-17' },
          ],
        }),
      ),
    );
    expect(morning.map((o) => o.slices[0]?.segments[0]?.departingAt)).toEqual([
      '2026-03-12T07:10:00-04:00',
      '2026-03-12T07:10:00-04:00',
    ]);
  });

  it('prices per passenger and scales penalties for multi-passenger offers', async () => {
    const offers = unwrap(
      await flights.search(
        deanSearch({
          passengers: [
            { memberId: 'mem_dean', type: 'adult' },
            { memberId: 'mem_maya', type: 'adult' },
            { memberId: 'mem_sam', type: 'adult' },
          ],
        }),
      ),
    );
    const o = byTemplate(offers, 'bos-jfk-1');
    expect(o.totalAmount).toEqual(eur(3 * 41200));
    expect(o.conditions.refundBeforeDeparture.penalty).toEqual(eur(3 * 7500));
  });

  it('issues fresh offer ids per search and returns nothing for other cabins or routes', async () => {
    const a = unwrap(await flights.search(deanSearch()));
    const b = unwrap(await flights.search(deanSearch()));
    expect(new Set([...a, ...b].map((o) => o.offerId)).size).toBe(8);
    expect(unwrap(await flights.search(deanSearch({ cabinClass: 'business' })))).toEqual([]);
    const oneWay = deanSearch({
      slices: [{ origin: 'BOS', destination: 'BCN', departureDate: '2026-03-12' }],
    });
    expect(unwrap(await flights.search(oneWay))).toEqual([]);
  });

  it('finds options for all six Barcelona travelers', async () => {
    const routes: [string, string, string][] = [
      ['mem_dean', 'BOS', 'JFK'],
      ['mem_maya', 'SFO', 'LAX'],
      ['mem_jordan', 'ORD', 'ORD'],
      ['mem_priya', 'JFK', 'IAD'],
      ['mem_sam', 'LAX', 'SEA'],
      ['mem_henry', 'MIA', 'ATL'],
    ];
    for (const [memberId, origin, home] of routes) {
      const offers = unwrap(
        await flights.search({
          slices: [
            { origin, destination: 'BCN', departureDate: '2026-03-12' },
            { origin: 'BCN', destination: home, departureDate: '2026-03-17' },
          ],
          passengers: [{ memberId, type: 'adult' }],
        }),
      );
      expect(offers.length, memberId).toBe(4);
    }
  });

  it('default inventory (shared fixtures/flights/barcelona.json, either shape) serves all 6 travelers', async () => {
    const shared = loadMockFlightInventory();
    const adapter = createMockFlights({ clock });
    expect(shared.travelers).toHaveLength(6);
    expect(new Set(shared.travelers.map((t) => t.origin)).size).toBe(6);
    expect(shared.travelers.filter((t) => t.origin !== t.returnTo).length).toBeGreaterThan(0);
    for (const t of shared.travelers) {
      const offers = unwrap(
        await adapter.search({
          slices: [
            { origin: t.origin, destination: 'BCN', departureDate: '2026-03-12' },
            { origin: 'BCN', destination: t.returnTo, departureDate: '2026-03-17' },
          ],
          passengers: [{ memberId: t.memberId, type: 'adult' }],
        }),
      );
      expect(offers.length, t.memberId).toBeGreaterThanOrEqual(3);
      expect(
        offers.some((o) => o.conditions.refundBeforeDeparture.allowed),
        t.memberId,
      ).toBe(true);
      expect(
        offers.some((o) => !o.conditions.refundBeforeDeparture.allowed),
        t.memberId,
      ).toBe(true);
      for (const o of offers) {
        expect(o.passengerIds).toEqual([t.memberId]);
        expect(parseIso(o.expiresAt)).toBeGreaterThan(clock.nowMs());
      }
    }
  });

  it('rejects malformed requests with invalid_request', async () => {
    const bad: FlightSearchRequest[] = [
      deanSearch({ passengers: [] }),
      deanSearch({
        passengers: [
          { memberId: 'mem_dean', type: 'adult' },
          { memberId: 'mem_dean', type: 'adult' },
        ],
      }),
      deanSearch({ slices: [] }),
      deanSearch({ slices: [{ origin: 'bos', destination: 'BCN', departureDate: '2026-03-12' }] }),
      deanSearch({ slices: [{ origin: 'BOS', destination: 'BCN', departureDate: '2026-02-30' }] }),
      deanSearch({ slices: [{ origin: 'BCN', destination: 'BCN', departureDate: '2026-03-12' }] }),
      deanSearch({ maxConnections: -1 }),
    ];
    for (const req of bad) expect(errorCode(await flights.search(req))).toBe('invalid_request');
  });
});

describe('getOffer', () => {
  it('returns the offer until it expires on the injected clock', async () => {
    const offer = byTemplate(unwrap(await flights.search(deanSearch())), 'bos-jfk-1');
    clock.advanceMs(30 * 60_000 - 1);
    expect(unwrap(await flights.getOffer(offer.offerId)).totalAmount).toEqual(eur(41200));
    clock.advanceMs(1); // exactly expiresAt
    expect(errorCode(await flights.getOffer(offer.offerId))).toBe('offer_expired');
    expect(errorCode(await flights.getOffer('off_nope'))).toBe('not_found');
  });

  it('honors a per-offer short expiry from the fixture', async () => {
    const offers = unwrap(
      await flights.search({
        slices: [
          { origin: 'JFK', destination: 'BCN', departureDate: '2026-03-12' },
          { origin: 'BCN', destination: 'IAD', departureDate: '2026-03-17' },
        ],
        passengers: [{ memberId: 'mem_priya', type: 'adult' }],
      }),
    );
    const short = byTemplate(offers, 'jfk-iad-4');
    expect(short.expiresAt).toBe(addMinutes(START, 5));
    clock.advanceMs(5 * 60_000);
    expect(errorCode(await flights.getOffer(short.offerId))).toBe('offer_expired');
  });

  it('re-prices after the fixture delay: price_changed once with newAmount, then the new price', async () => {
    const offer = byTemplate(unwrap(await flights.search(deanSearch())), 'bos-jfk-4');
    expect(offer.totalAmount).toEqual(eur(37900));
    clock.advanceMs(9 * 60_000);
    expect(unwrap(await flights.getOffer(offer.offerId)).totalAmount).toEqual(eur(37900));
    clock.advanceMs(60_000);
    const changed = await flights.getOffer(offer.offerId);
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error.code).toBe('price_changed');
      expect(changed.error.newAmount).toEqual(eur(40900));
      expect(changed.error.retryable).toBe(true);
    }
    const again = unwrap(await flights.getOffer(offer.offerId));
    expect(again.totalAmount).toEqual(eur(40900));
    expect(again.taxAmount).toEqual(eur(6100));
    expect(again.baseAmount).toEqual(eur(34800));
  });
});

describe('createOrder', () => {
  async function searchOne(templateId = 'bos-jfk-1'): Promise<FlightOffer> {
    return byTemplate(unwrap(await flights.search(deanSearch())), templateId);
  }

  it('books after getOffer with a valid proof; a retry with the same key returns the same order (counter = 1)', async () => {
    const offer = await searchOne();
    const fresh = unwrap(await flights.getOffer(offer.offerId));
    const request = {
      groupId: 'grp_barcelona',
      offerId: fresh.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: fresh.totalAmount,
      idempotencyKey: 'key-1',
      approval: proofFor(clock, eur(50000)),
    };
    const order = unwrap(await flights.createOrder(request));
    expect(order.status).toBe('confirmed');
    expect(order.totalAmount).toEqual(eur(41200));
    expect(order.approvalId).toBe('grant_t000001');
    expect(order.bookingReference).toMatch(/^[A-Z2-9]{6}$/);
    expect(order.createdAt).toBe(clock.now());
    expect(order.offer.offerId).toBe(offer.offerId);
    expect(flights.purchaseCount()).toBe(1);

    clock.advanceMs(60_000);
    const retry = unwrap(await flights.createOrder(request));
    expect(retry).toBe(order);
    expect(flights.purchaseCount()).toBe(1);
    expect(unwrap(await flights.getOrder(order.orderId))).toEqual(order);
    expect(errorCode(await flights.getOrder('ord_nope'))).toBe('not_found');
  });

  it('two simultaneous calls with the same key book once', async () => {
    const offer = await searchOne();
    const request = {
      groupId: 'grp_barcelona',
      offerId: offer.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: offer.totalAmount,
      idempotencyKey: 'key-dup',
      approval: proofFor(clock, eur(41200)),
    };
    const [a, b] = await Promise.all([flights.createOrder(request), flights.createOrder(request)]);
    expect(unwrap(a).orderId).toBe(unwrap(b).orderId);
    expect(flights.purchaseCount()).toBe(1);
  });

  it('refuses to reuse a key for another offer, and refuses to book an offer twice under a new key', async () => {
    const offers = unwrap(await flights.search(deanSearch()));
    const one = byTemplate(offers, 'bos-jfk-1');
    const three = byTemplate(offers, 'bos-jfk-3');
    const approval = proofFor(clock, eur(50000));
    unwrap(
      await flights.createOrder({
        groupId: 'grp_barcelona',
        offerId: one.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: one.totalAmount,
        idempotencyKey: 'k',
        approval,
      }),
    );
    const sameKey = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: three.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: three.totalAmount,
      idempotencyKey: 'k',
      approval,
    });
    expect(errorCode(sameKey)).toBe('duplicate');
    const newKey = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: one.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: one.totalAmount,
      idempotencyKey: 'k2',
      approval: proofFor(clock, eur(50000), { approvalId: 'grant_t000002' }),
    });
    expect(errorCode(newKey)).toBe('duplicate');
    // One approval funds one action: the first order's approval cannot book another offer.
    const reused = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: three.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: three.totalAmount,
      idempotencyKey: 'k3',
      approval,
    });
    expect(errorCode(reused)).toBe('approval_invalid');
    expect(flights.purchaseCount()).toBe(1);
    expect(flights.purchaseCount()).toBe(1);
  });

  it('fails with offer_expired once the offer is past expiresAt', async () => {
    const offer = await searchOne();
    clock.advanceHours(1);
    const r = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: offer.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: offer.totalAmount,
      idempotencyKey: 'k',
      approval: proofFor(clock, eur(50000)),
    });
    expect(errorCode(r)).toBe('offer_expired');
    expect(flights.purchaseCount()).toBe(0);
  });

  it('fails with price_changed (and newAmount) when the price moved since approval, then books at the new price', async () => {
    const offer = await searchOne('bos-jfk-4');
    clock.advanceMs(12 * 60_000);
    const stale = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: offer.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: offer.totalAmount,
      idempotencyKey: 'k-stale',
      approval: proofFor(clock, eur(50000)),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('price_changed');
      expect(stale.error.newAmount).toEqual(eur(40900));
    }
    expect(flights.purchaseCount()).toBe(0);
    // Re-approved at the new price (new key, new proof): books.
    const order = unwrap(
      await flights.createOrder({
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: eur(40900),
        idempotencyKey: 'k-new',
        approval: proofFor(clock, eur(40900), { approvalId: 'grant_t000002' }),
      }),
    );
    expect(order.totalAmount).toEqual(eur(40900));
    expect(flights.purchaseCount()).toBe(1);
  });

  it('price_changed also covers an expectedTotal in the wrong currency', async () => {
    const offer = await searchOne();
    const r = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: offer.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: { amountMinor: 41200, currency: 'USD' },
      idempotencyKey: 'k',
      approval: proofFor(clock, eur(50000)),
    });
    expect(errorCode(r)).toBe('price_changed');
  });

  describe('ApprovalProof', () => {
    type Case = [string, (offer: FlightOffer) => ApprovalProof | undefined, string];
    const cases: Case[] = [
      ['missing proof', () => undefined, 'approval_invalid'],
      [
        'expired proof',
        () =>
          proofFor(clock, eur(50000), {
            expiresAt: addMinutes(clock.now(), -1),
            approvedAt: addMinutes(clock.now(), -20),
          }),
        'approval_invalid',
      ],
      [
        'approved in the future',
        () => proofFor(clock, eur(50000), { approvedAt: addMinutes(clock.now(), 5) }),
        'approval_invalid',
      ],
      [
        'expires before approved',
        () =>
          proofFor(clock, eur(50000), {
            approvedAt: addMinutes(clock.now(), -1),
            expiresAt: addMinutes(clock.now(), -2),
          }),
        'approval_invalid',
      ],
      [
        'malformed expiry',
        () => proofFor(clock, eur(50000), { expiresAt: 'tomorrow' }),
        'approval_invalid',
      ],
      ['no approvers', () => proofFor(clock, eur(50000), { approvedBy: [] }), 'approval_invalid'],
      [
        'blank approval id',
        () => proofFor(clock, eur(50000), { approvalId: ' ' }),
        'approval_invalid',
      ],
      [
        'missing audit event',
        () => proofFor(clock, eur(50000), { auditEventId: '' }),
        'approval_invalid',
      ],
      [
        'another group',
        () => proofFor(clock, eur(50000), { groupId: 'grp_lisbon' }),
        'approval_invalid',
      ],
      [
        'other currency',
        () => proofFor(clock, { amountMinor: 50000, currency: 'USD' }),
        'approval_invalid',
      ],
      [
        'float maxAmount',
        () => proofFor(clock, { amountMinor: 412.5, currency: 'EUR' }),
        'approval_invalid',
      ],
      [
        'one cent under the total',
        (o) => proofFor(clock, eur(o.totalAmount.amountMinor - 1)),
        'approval_exceeded',
      ],
    ];
    it.each(cases)('rejects %s without booking', async (_name, makeProof, code) => {
      const offer = await searchOne();
      const r = await flights.createOrder({
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: offer.totalAmount,
        idempotencyKey: 'k',
        approval: makeProof(offer) as ApprovalProof,
      });
      expect(errorCode(r)).toBe(code);
      expect(flights.purchaseCount()).toBe(0);
    });

    it('accepts a proof exactly at the cap one ms before expiry; expired AT expiresAt (shared rule)', async () => {
      const offer = await searchOne();
      const approval = proofFor(clock, offer.totalAmount);
      const request = {
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: offer.totalAmount,
        idempotencyKey: 'k',
        approval,
      };
      clock.set(approval.expiresAt);
      expect(errorCode(await flights.createOrder(request))).toBe('approval_invalid');
      expect(flights.purchaseCount()).toBe(0);
      clock.set(formatIso(parseIso(approval.expiresAt) - 1, 60));
      const order = unwrap(await flights.createOrder(request));
      expect(order.status).toBe('confirmed');
      expect(flights.purchaseCount()).toBe(1);
    });

    it('a bad proof is rejected before the offer is even looked up', async () => {
      const r = await flights.createOrder({
        groupId: 'grp_barcelona',
        offerId: 'off_does_not_exist',
        travelers: [traveler('mem_dean')],
        expectedTotal: eur(1),
        idempotencyKey: 'k',
        approval: proofFor(clock, eur(1), { groupId: 'grp_other' }),
      });
      expect(errorCode(r)).toBe('approval_invalid');
    });
  });

  it('requires travelers to match the offer passengers exactly', async () => {
    const offer = await searchOne();
    const base = {
      groupId: 'grp_barcelona',
      offerId: offer.offerId,
      expectedTotal: offer.totalAmount,
      idempotencyKey: 'k',
      approval: proofFor(clock, eur(50000)),
    };
    for (const travelers of [
      [],
      [traveler('mem_henry')],
      [traveler('mem_dean'), traveler('mem_henry')],
      [{ memberId: 'mem_dean', givenName: '', familyName: 'X' }],
      [{ memberId: 'mem_dean', givenName: '   ' }],
      [{ memberId: 'mem_dean', givenName: 'Dean', familyName: ' ' }],
    ]) {
      expect(errorCode(await flights.createOrder({ ...base, travelers }))).toBe('invalid_request');
    }
    expect(
      errorCode(
        await flights.createOrder({
          ...base,
          idempotencyKey: '',
          travelers: [traveler('mem_dean')],
        }),
      ),
    ).toBe('invalid_request');
    expect(flights.purchaseCount()).toBe(0);
  });

  it('D-040: the mock books under the given name alone (a v0 member has no family name); the order keeps exactly that', async () => {
    const offer = await searchOne();
    const order = unwrap(
      await flights.createOrder({
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [{ memberId: 'mem_dean', givenName: 'Dean' }],
        expectedTotal: offer.totalAmount,
        idempotencyKey: 'k-given-only',
        approval: proofFor(clock, eur(50000), { approvalId: 'grant_given_only' }),
      }),
    );
    expect(order.travelers).toEqual([{ memberId: 'mem_dean', givenName: 'Dean' }]);
    expect(flights.purchaseCount()).toBe(1);
  });
});

describe('cancellation', () => {
  async function book(templateId: string): Promise<string> {
    const offer = byTemplate(unwrap(await flights.search(deanSearch())), templateId);
    const order = unwrap(
      await flights.createOrder({
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: offer.totalAmount,
        idempotencyKey: `book-${templateId}`,
        approval: proofFor(clock, eur(50000), { approvalId: `grant_book_${templateId}` }),
      }),
    );
    return order.orderId;
  }

  it('quotes total minus penalty for refundable fares and 0 for non-refundable', async () => {
    const refundable = await book('bos-jfk-1');
    const q = unwrap(await flights.quoteCancellation(refundable));
    expect(q.refundAmount).toEqual(eur(41200 - 7500));
    expect(q.expiresAt).toBe(addMinutes(clock.now(), 15));
    const nonRefundable = await book('bos-jfk-3');
    expect(unwrap(await flights.quoteCancellation(nonRefundable)).refundAmount).toEqual(eur(0));
    expect(errorCode(await flights.quoteCancellation('ord_nope'))).toBe('not_found');
  });

  it('confirmCancellation needs a proof covering the forfeited amount and is idempotent', async () => {
    const orderId = await book('bos-jfk-1');
    const q = unwrap(await flights.quoteCancellation(orderId));
    // Forfeits the €75 penalty.
    expect(
      errorCode(await flights.confirmCancellation(q.quoteId, proofFor(clock, eur(7499)), 'c1')),
    ).toBe('approval_exceeded');
    expect(
      errorCode(
        await flights.confirmCancellation(
          q.quoteId,
          proofFor(clock, eur(7500), {
            expiresAt: addMinutes(clock.now(), -1),
            approvedAt: addMinutes(clock.now(), -9),
          }),
          'c1',
        ),
      ),
    ).toBe('approval_invalid');
    expect(flights.cancellationCount()).toBe(0);

    const proof = proofFor(clock, eur(7500));
    const cancelled = unwrap(await flights.confirmCancellation(q.quoteId, proof, 'c1'));
    expect(cancelled.status).toBe('cancelled');
    expect(unwrap(await flights.confirmCancellation(q.quoteId, proof, 'c1'))).toBe(cancelled);
    expect(flights.cancellationCount()).toBe(1);
    expect(unwrap(await flights.getOrder(orderId)).status).toBe('cancelled');
    expect(errorCode(await flights.quoteCancellation(orderId))).toBe('invalid_request');
  });

  it('one approval funds one action: the booking approval cannot cancel; a cancel approval cannot be reused', async () => {
    const orderId = await book('bos-jfk-1');
    const q = unwrap(await flights.quoteCancellation(orderId));
    const bookingApproval = proofFor(clock, eur(50000), { approvalId: 'grant_book_bos-jfk-1' });
    expect(errorCode(await flights.confirmCancellation(q.quoteId, bookingApproval, 'c1'))).toBe(
      'approval_invalid',
    );
    expect(flights.cancellationCount()).toBe(0);

    const cancelApproval = proofFor(clock, eur(7500), { approvalId: 'grant_cancel_1' });
    unwrap(await flights.confirmCancellation(q.quoteId, cancelApproval, 'c1'));
    const other = await book('bos-jfk-3');
    const q2 = unwrap(await flights.quoteCancellation(other));
    expect(errorCode(await flights.confirmCancellation(q2.quoteId, cancelApproval, 'c2'))).toBe(
      'approval_invalid',
    );
    // ...nor fund a new booking.
    const offer = byTemplate(unwrap(await flights.search(deanSearch())), 'bos-jfk-1');
    const r = await flights.createOrder({
      groupId: 'grp_barcelona',
      offerId: offer.offerId,
      travelers: [traveler('mem_dean')],
      expectedTotal: offer.totalAmount,
      idempotencyKey: 'k-new',
      approval: proofFor(clock, eur(50000), { approvalId: 'grant_cancel_1' }),
    });
    expect(errorCode(r)).toBe('approval_invalid');
    expect(flights.cancellationCount()).toBe(1);
  });

  it('a cancellation replay must carry a well-formed proof, the same approval and the same group', async () => {
    const orderId = await book('bos-jfk-1');
    const q = unwrap(await flights.quoteCancellation(orderId));
    const proof = proofFor(clock, eur(7500), { approvalId: 'grant_cancel_1' });
    const cancelled = unwrap(await flights.confirmCancellation(q.quoteId, proof, 'c1'));
    expect(
      errorCode(
        await flights.confirmCancellation(q.quoteId, undefined as unknown as ApprovalProof, 'c1'),
      ),
    ).toBe('approval_invalid');
    expect(
      errorCode(
        await flights.confirmCancellation(
          q.quoteId,
          proofFor(clock, eur(7500), { approvalId: 'grant_cancel_2' }),
          'c1',
        ),
      ),
    ).toBe('duplicate');
    expect(
      errorCode(
        await flights.confirmCancellation(
          q.quoteId,
          proofFor(clock, eur(7500), { approvalId: 'grant_cancel_1', groupId: 'grp_lisbon' }),
          'c1',
        ),
      ),
    ).toBe('duplicate');
    expect(unwrap(await flights.confirmCancellation(q.quoteId, proof, 'c1'))).toBe(cancelled);
    expect(flights.cancellationCount()).toBe(1);
  });

  it('rejects an expired quote and a proof from another group', async () => {
    const orderId = await book('bos-jfk-1');
    const q = unwrap(await flights.quoteCancellation(orderId));
    const otherGroupAdapterProof = proofFor(clock, eur(50000), { groupId: 'grp_lisbon' });
    expect(
      errorCode(await flights.confirmCancellation(q.quoteId, otherGroupAdapterProof, 'c1')),
    ).toBe('approval_invalid');
    clock.advanceMs(15 * 60_000);
    expect(
      errorCode(await flights.confirmCancellation(q.quoteId, proofFor(clock, eur(50000)), 'c2')),
    ).toBe('offer_expired');
    expect(flights.cancellationCount()).toBe(0);
  });

  it('binds cancellations to the booking group even without a group-scoped adapter', async () => {
    const open = createMockFlights({ clock, inventory });
    const offer = byTemplate(unwrap(await open.search(deanSearch())), 'bos-jfk-1');
    const order = unwrap(
      await open.createOrder({
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: offer.totalAmount,
        idempotencyKey: 'k',
        approval: proofFor(clock, eur(50000)),
      }),
    );
    const q = unwrap(await open.quoteCancellation(order.orderId));
    const r = await open.confirmCancellation(
      q.quoteId,
      proofFor(clock, eur(50000), { groupId: 'grp_other' }),
      'c',
    );
    expect(errorCode(r)).toBe('approval_invalid');
    expect(open.cancellationCount()).toBe(0);
  });
});

describe('request identity (T-059): groupId must match the proof, even on an open adapter', () => {
  async function openBase(): Promise<{ open: MockFlightsAdapter; base: CreateFlightOrderRequest }> {
    const open = createMockFlights({ clock, inventory });
    const offer = byTemplate(unwrap(await open.search(deanSearch())), 'bos-jfk-1');
    return {
      open,
      base: {
        groupId: 'grp_barcelona',
        offerId: offer.offerId,
        travelers: [traveler('mem_dean')],
        expectedTotal: offer.totalAmount,
        idempotencyKey: 'k',
        approval: proofFor(clock, eur(50000)),
      },
    };
  }

  const cases: [string, () => Partial<CreateFlightOrderRequest>, string][] = [
    [
      'a proof granted in another group',
      () => ({ approval: proofFor(clock, eur(50000), { groupId: 'grp_lisbon' }) }),
      'approval_invalid',
    ],
    ['a request for another group', () => ({ groupId: 'grp_lisbon' }), 'approval_invalid'],
    ['an empty groupId', () => ({ groupId: '' }), 'invalid_request'],
    ['no groupId', () => ({ groupId: undefined as unknown as string }), 'invalid_request'],
  ];

  it.each(cases)('refuses %s and books nothing', async (_label, over, code) => {
    const { open, base } = await openBase();
    expect(errorCode(await open.createOrder({ ...base, ...over() }))).toBe(code);
    expect(open.purchaseCount()).toBe(0);
    // The same offer still books for the right group.
    unwrap(await open.createOrder({ ...base, idempotencyKey: 'fresh' }));
    expect(open.purchaseCount()).toBe(1);
  });

  it('a same-key replay naming another group is duplicate, not the original order', async () => {
    const { open, base } = await openBase();
    unwrap(await open.createOrder(base));
    const r = await open.createOrder({
      ...base,
      groupId: 'grp_lisbon',
      approval: proofFor(clock, eur(50000), { groupId: 'grp_lisbon' }),
    });
    expect(errorCode(r)).toBe('duplicate');
    expect(open.purchaseCount()).toBe(1);
  });

  it('a same-key replay with different travelers or a different total is duplicate, not the original order', async () => {
    const { open, base } = await openBase();
    const order = unwrap(await open.createOrder(base));
    const otherName = await open.createOrder({
      ...base,
      travelers: [{ memberId: 'mem_dean', givenName: 'Other', familyName: 'Name' }],
    });
    expect(errorCode(otherName)).toBe('duplicate');
    const otherTotal = await open.createOrder({ ...base, expectedTotal: eur(1) });
    expect(errorCode(otherTotal)).toBe('duplicate');
    expect(unwrap(await open.createOrder(base))).toBe(order);
    expect(open.purchaseCount()).toBe(1);
  });

  it('a same-key replay whose proof names another group is duplicate, even with the same approvalId', async () => {
    const { open, base } = await openBase();
    const order = unwrap(await open.createOrder(base));
    const r = await open.createOrder({
      ...base,
      approval: proofFor(clock, eur(50000), { groupId: 'grp_lisbon' }),
    });
    expect(errorCode(r)).toBe('duplicate');
    expect(unwrap(await open.createOrder(base))).toBe(order);
    expect(open.purchaseCount()).toBe(1);
  });

  it('a missing request is a typed result, never a throw', async () => {
    expect(
      errorCode(await flights.createOrder(undefined as unknown as CreateFlightOrderRequest)),
    ).toBe('invalid_request');
  });
});
