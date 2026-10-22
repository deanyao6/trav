import { describe, expect, it } from 'vitest';
import { TravError, equals, money } from '@trav/core';
import { TICKET_INVENTORY_NAMES, loadTicketInventory, parseTicketInventory } from './inventory.js';

describe('ticket inventory fixtures', () => {
  it('bundles barcelona and loads deterministically', () => {
    expect(TICKET_INVENTORY_NAMES).toContain('barcelona');
    expect(loadTicketInventory('barcelona')).toEqual(loadTicketInventory('barcelona'));
  });

  it('throws not_found for an unknown fixture', () => {
    expect(() => loadTicketInventory('atlantis')).toThrow(TravError);
  });

  const inv = loadTicketInventory('barcelona');
  const offer = (id: string) =>
    inv.events.flatMap((e) => e.offers).find((o) => o.offer.offerId === id)?.offer;
  const byName = (re: RegExp) => inv.events.filter((e) => re.test(e.event.name));

  it('has the Barcelona inventory the demo needs', () => {
    expect(inv.currency).toBe('EUR');
    expect(inv.holdMinutes).toBe(15);
    expect(byName(/Razzmatazz/).length).toBeGreaterThanOrEqual(3);
    expect(byName(/FC Barcelona/)).toHaveLength(1);
    expect(byName(/Sagrada/)).toHaveLength(1);
    expect(byName(/Park Güell/)).toHaveLength(1);

    // Tonight's GA: €18, refundable until 10pm (VOICE §4.1 Example A).
    const ga = offer('off_rzm_20260314_ga');
    expect(ga && equals(ga.unitPrice, money(1800, 'EUR'))).toBe(true);
    expect(ga?.refundPolicy).toMatchObject({
      refundable: true,
      refundableUntil: '2026-03-14T22:00:00+01:00',
    });
    expect(ga?.deliveryMethod).toBe('per_person_qr');

    // A sold-out night.
    expect(offer('off_rzm_20260315_ga')?.available).toBe(0);

    // VIP is over a €60/person cap (and the €50 default per-person cap), non-refundable.
    const vip = offer('off_rzm_20260314_vip');
    expect(vip).toBeDefined();
    if (vip) {
      expect(vip.unitPrice.amountMinor + vip.unitFees.amountMinor).toBeGreaterThan(6000);
      expect(vip.refundPolicy.refundable).toBe(false);
    }

    // A redirect-only item with a checkout link.
    const redirect = inv.events
      .flatMap((e) => e.offers)
      .filter((o) => o.offer.purchaseMode === 'redirect_only');
    expect(redirect.length).toBeGreaterThanOrEqual(1);
    expect(redirect.every((o) => o.offer.checkoutUrl?.startsWith('https://'))).toBe(true);

    // Clubs are 18+ and flagged for the minors rule.
    for (const e of byName(/Razzmatazz|Apolo/)) {
      expect(e.event.minimumAge).toBe(18);
      expect(e.event.contentFlags).toEqual(expect.arrayContaining(['nightlife', '18+']));
    }
  });

  it('stores all money as integer minor units', () => {
    for (const e of inv.events) {
      for (const o of e.offers) {
        expect(Number.isSafeInteger(o.offer.unitPrice.amountMinor)).toBe(true);
        expect(Number.isSafeInteger(o.offer.unitFees.amountMinor)).toBe(true);
      }
    }
  });

  it('uses only mock checkout hosts (no real ticketing sites)', () => {
    for (const e of inv.events) {
      if (e.event.url) expect(new URL(e.event.url).hostname).toBe('tickets.example');
      for (const o of e.offers) {
        if (o.offer.checkoutUrl) {
          expect(new URL(o.offer.checkoutUrl).hostname).toBe('tickets.example');
        }
      }
    }
  });
});

describe('parseTicketInventory mapper', () => {
  const venue = { name: 'V', city: 'Lisbon', countryCode: 'PT', timeZone: 'Europe/Lisbon' };
  const baseOffer = {
    offerId: 'off_1',
    tierName: 'GA',
    available: 10,
    maxPerOrder: 4,
    refundPolicy: { refundable: false },
    deliveryMethod: 'per_person_qr',
    requiresHolderNames: true,
    purchaseMode: 'api',
  };

  it('accepts a flat offers[] with *Minor amounts', () => {
    const parsed = parseTicketInventory({
      name: 'lisbon',
      currency: 'EUR',
      events: [
        {
          eventId: 'evt_slb',
          name: 'Benfica vs Porto',
          category: 'sports',
          venue,
          startsAt: '2026-05-02T20:30:00+01:00',
          contentFlags: [],
        },
      ],
      offers: [{ ...baseOffer, eventId: 'evt_slb', unitPriceMinor: 4500, unitFeesMinor: 250 }],
    });
    expect(parsed.provider).toBe('mock-tickets');
    expect(parsed.holdMinutes).toBe(15);
    const o = parsed.events[0]?.offers[0]?.offer;
    expect(o?.unitPrice).toEqual({ amountMinor: 4500, currency: 'EUR' });
    expect(o?.unitFees).toEqual({ amountMinor: 250, currency: 'EUR' });
    expect(o?.eventId).toBe('evt_slb');
    expect(parsed.events[0]?.salesEndAt).toBe('2026-05-02T20:30:00+01:00');
  });

  const minimal = (
    offerOverrides: Record<string, unknown>,
    root: Record<string, unknown> = {},
  ) => ({
    name: 'x',
    currency: 'EUR',
    events: [
      {
        eventId: 'evt_1',
        name: 'E',
        category: 'concert',
        venue,
        startsAt: '2026-05-02T20:30:00+01:00',
        offers: [{ ...baseOffer, unitPriceMinor: 100, ...offerOverrides }],
      },
    ],
    ...root,
  });

  it.each([
    ['missing currency', minimal({}, { currency: undefined })],
    ['float price', minimal({ unitPriceMinor: 18.5 })],
    ['negative stock', minimal({ available: -1 })],
    ['redirect without url', minimal({ purchaseMode: 'redirect_only' })],
    ['unknown delivery', minimal({ deliveryMethod: 'carrier_pigeon' })],
    ['money in another currency', minimal({ unitPrice: { amountMinor: 100, currency: 'USD' } })],
    [
      'startsAt without offset',
      minimal(
        {},
        {
          events: [
            {
              eventId: 'e',
              name: 'E',
              category: 'concert',
              venue,
              startsAt: '2026-05-02T20:30:00',
              offers: [],
            },
          ],
        },
      ),
    ],
    [
      'unknown content flag',
      minimal(
        {},
        {
          events: [
            {
              eventId: 'e',
              name: 'E',
              category: 'concert',
              venue,
              startsAt: '2026-05-02T20:30:00Z',
              contentFlags: ['spicy'],
            },
          ],
        },
      ),
    ],
  ])('rejects %s', (_label, json) => {
    expect(() => parseTicketInventory(json)).toThrow(TravError);
  });

  it('rejects duplicate offer ids across events', () => {
    const json = minimal({});
    const ev = json.events[0];
    const dup = { ...json, events: [ev, { ...ev, eventId: 'evt_2' }] };
    expect(() => parseTicketInventory(dup)).toThrow(/duplicate offerId/);
  });

  it('rejects a flat offer pointing at an unknown event', () => {
    const json = {
      ...minimal({}),
      offers: [{ ...baseOffer, offerId: 'off_x', eventId: 'evt_nope', unitPriceMinor: 1 }],
    };
    expect(() => parseTicketInventory(json)).toThrow(/unknown event/);
  });
});
