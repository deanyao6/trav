import { describe, expect, it } from 'vitest';
import { TravError, equals, money } from '@trav/core';
import {
  TICKET_INVENTORY_NAMES,
  loadAllTicketInventories,
  loadTicketInventory,
  parseTicketInventory,
} from './inventory.js';

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
    // No city, no prefixes: no trip cities, default "TK".
    expect(parsed.cities).toEqual([]);
    expect(parsed.events[0]?.orderPrefix).toBe('TK');
    expect(parsed.events[0]?.offers[0]?.orderPrefix).toBeUndefined();
  });

  it('resolves receipt prefixes offer > offer hint > event > event hint > root, and trip cities', () => {
    const ev = (eventId: string, extra: Record<string, unknown> = {}) => ({
      eventId,
      name: eventId,
      category: 'sports',
      venue,
      startsAt: '2026-05-02T20:30:00+01:00',
      ...extra,
    });
    const parsed = parseTicketInventory({
      name: 'x',
      currency: 'EUR',
      city: 'Lisbon',
      tripCities: ['Sintra', 'Lisbon'],
      orderPrefix: 'LIS',
      events: [ev('e1'), ev('e2', { orderPrefix: 'EV' }), ev('e3')],
      offers: [
        { ...baseOffer, offerId: 'o1', eventId: 'e1', unitPriceMinor: 1, orderPrefix: 'OF' },
        { ...baseOffer, offerId: 'o2', eventId: 'e1', unitPriceMinor: 1 },
        { ...baseOffer, offerId: 'o3', eventId: 'e2', unitPriceMinor: 1 },
        { ...baseOffer, offerId: 'o4', eventId: 'e3', unitPriceMinor: 1 },
      ],
      mockHints: {
        o1: { orderRefPrefix: 'IGN' },
        o2: { orderRefPrefix: 'HNT' },
        e3: { orderRefPrefix: 'EH', note: 'x' },
      },
    });
    expect(parsed.cities).toEqual(['Lisbon', 'Sintra']);
    const [e1, e2, e3] = parsed.events;
    expect(e1?.orderPrefix).toBe('LIS');
    expect(e1?.offers.map((o) => o.orderPrefix)).toEqual(['OF', 'HNT']);
    expect(e2?.orderPrefix).toBe('EV');
    expect(e2?.offers[0]?.orderPrefix).toBeUndefined();
    expect(e3?.orderPrefix).toBe('EH');
    expect(() =>
      parseTicketInventory({ name: 'x', currency: 'EUR', orderPrefix: 'tk-1', events: [] }),
    ).toThrow(/\$\.orderPrefix/);
    expect(() =>
      parseTicketInventory({ name: 'x', currency: 'EUR', tripCities: 'Sintra', events: [] }),
    ).toThrow(/\$\.tripCities/);
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

describe('per-trip inventories (T-080)', () => {
  it('bundles Lisbon and Turks and Caicos next to Barcelona', () => {
    expect(TICKET_INVENTORY_NAMES).toEqual(['barcelona', 'lisbon', 'turks-and-caicos']);
    expect(loadAllTicketInventories().map((i) => i.name)).toEqual([
      'barcelona',
      'lisbon',
      'turks-and-caicos',
    ]);
  });

  it('parses Lisbon: the Benfica vs Porto match and fado, in EUR and in Lisbon', () => {
    const lis = loadTicketInventory('lisbon');
    expect(lis.currency).toBe('EUR');
    // Mostly Lisbon; FC Porto's home match (Porto) and Pena Palace (Sintra) are day trips the
    // inventory answers for through `tripCities`.
    expect(
      lis.events.filter((e) => e.event.venue.city !== 'Lisbon').map((e) => e.event.eventId),
    ).toEqual(['evt_lis_porto_vitoria', 'evt_lis_pena_0417']);
    expect(lis.cities).toEqual(['Lisbon', 'Sintra', 'Porto']);
    // Receipt prefixes: the fixture hint for Benfica, the inventory prefix elsewhere.
    const benfica = lis.events.find((e) => e.event.eventId === 'evt_lis_benfica_porto');
    expect(
      benfica?.offers.find((o) => o.offer.offerId === 'off_lis_benfica_porto_std')?.orderPrefix,
    ).toBe('SLB');
    expect(benfica?.orderPrefix).toBe('LIS');
    const match = lis.events.find((e) => e.event.eventId === 'evt_lis_benfica_porto');
    expect(match?.event.name).toBe('SL Benfica vs FC Porto');
    expect(match?.event.category).toBe('sports');
    // Flat offers[] are attached to their event.
    expect(match?.offers.map((o) => o.offer.offerId)).toEqual([
      'off_lis_benfica_porto_std',
      'off_lis_benfica_porto_premium',
    ]);
    const std = match?.offers[0]?.offer;
    expect(std && equals(std.unitPrice, money(5000, 'EUR'))).toBe(true);
    expect(std && equals(std.unitFees, money(500, 'EUR'))).toBe(true);
    const fado = lis.events.find((e) => /fado/i.test(e.event.name));
    expect(fado?.event.contentFlags).toEqual(expect.arrayContaining(['alcohol']));
    expect(fado?.offers).toHaveLength(1);
    // The club night stays 18+ and flagged for the minors rule.
    const club = lis.events.find((e) => e.event.eventId === 'evt_lis_club_0417');
    expect(club?.event.minimumAge).toBe(18);
    expect(club?.event.contentFlags).toEqual(expect.arrayContaining(['nightlife', '18+']));
  });

  it('parses Turks and Caicos: the family snorkel tour in USD, adult events flagged', () => {
    const tci = loadTicketInventory('turks-and-caicos');
    expect(tci.currency).toBe('USD');
    expect(tci.events.every((e) => e.event.venue.city === 'Providenciales')).toBe(true);
    const snorkel = tci.events.find((e) => e.event.eventId === 'evt_tci_snorkel_0622');
    expect(snorkel?.event.name).toBe('reef snorkel tour');
    expect(snorkel?.event.contentFlags).toEqual(['family']);
    const offer = snorkel?.offers[0]?.offer;
    expect(offer?.offerId).toBe('off_tci_snorkel_0622');
    expect(offer && equals(offer.unitPrice, money(6000, 'USD'))).toBe(true);
    expect(offer?.purchaseMode).toBe('api');
    expect(offer?.deliveryMethod).toBe('per_person_qr');
    // Family events carry the family flag; adult events never do.
    for (const e of tci.events) {
      const flags = e.event.contentFlags;
      if (flags.includes('family')) {
        expect(
          flags.some((f) => ['alcohol', 'nightlife', 'gambling', '18+', '21+'].includes(f)),
        ).toBe(false);
      }
    }
    const casino = tci.events.find((e) => e.event.eventId === 'evt_tci_casino_0624');
    expect(casino?.event.minimumAge).toBe(21);
    expect(casino?.event.contentFlags).toEqual(expect.arrayContaining(['gambling', '21+']));
  });

  it('keeps event and offer ids unique across every bundled inventory', () => {
    const all = loadAllTicketInventories();
    const eventIds = all.flatMap((i) => i.events.map((e) => e.event.eventId));
    const offerIds = all.flatMap((i) =>
      i.events.flatMap((e) => e.offers.map((o) => o.offer.offerId)),
    );
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect(new Set(offerIds).size).toBe(offerIds.length);
  });

  it('stores every bundled price as integer minor units in its inventory currency', () => {
    for (const inv of loadAllTicketInventories()) {
      for (const o of inv.events.flatMap((e) => e.offers)) {
        expect(Number.isSafeInteger(o.offer.unitPrice.amountMinor)).toBe(true);
        expect(o.offer.unitPrice.currency).toBe(inv.currency);
        expect(o.offer.unitFees.currency).toBe(inv.currency);
      }
    }
  });
});
