import { describe, expect, it } from 'vitest';
import { createDeterministicIdGenerator, createSimulatedClock, money } from '@trav/core';
import type { ApprovalProof } from '../../interfaces/common.js';
import type { PurchaseTicketsRequest, TicketHold, TicketOrder } from '../../interfaces/tickets.js';
import type { MockTickets } from './index.js';
import { createMockTickets, eventNightOf, loadTicketInventory, mockQrDataUrl } from './index.js';
import { FIVE, TONIGHT, eur, proof, setupTickets } from './testing.js';

const GA = 'off_rzm_20260314_ga';
const KEY = 'idem_rzm_5';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

function errorCode(r: { ok: boolean; error?: { code: string } }): string | undefined {
  return r.ok ? undefined : r.error?.code;
}

async function holdFive(tickets: MockTickets, key = 'hold_key_1'): Promise<TicketHold> {
  return unwrap(await tickets.hold(GA, 5, key));
}

function request(hold: TicketHold, overrides: Partial<PurchaseTicketsRequest> = {}) {
  return {
    groupId: 'grp_barcelona',
    holdId: hold.holdId,
    holders: FIVE,
    expectedTotal: hold.total,
    idempotencyKey: KEY,
    approval: proof(),
    ...overrides,
  } satisfies PurchaseTicketsRequest;
}

describe('mock tickets: info and search', () => {
  it('is a mock adapter', () => {
    const { tickets } = setupTickets();
    expect(tickets.info).toEqual({ provider: 'mock-tickets', mode: 'mock' });
  });

  it('finds tonight’s Razzmatazz (after-midnight doors count as tonight)', async () => {
    const { tickets } = setupTickets();
    const found = unwrap(
      await tickets.searchEvents({
        city: 'barcelona',
        dateFrom: '2026-03-14',
        dateTo: '2026-03-14',
        query: 'Razzmatazz tickets',
        quantity: 5,
      }),
    );
    expect(found.map((e) => e.eventId)).toEqual(['evt_rzm_20260314']);
    expect(found[0] && eventNightOf(found[0])).toBe('2026-03-14');
  });

  it('matches without diacritics and by alias ("barca")', async () => {
    const { tickets } = setupTickets();
    const r = unwrap(
      await tickets.searchEvents({
        city: 'Barcelona',
        dateFrom: '2026-03-12',
        dateTo: '2026-03-17',
        query: 'barca match',
      }),
    );
    expect(r.map((e) => e.eventId)).toEqual(['evt_fcb_sev_20260315']);
    const g = unwrap(
      await tickets.searchEvents({
        city: 'BARCELONA',
        dateFrom: '2026-03-12',
        dateTo: '2026-03-17',
        query: 'park guell',
      }),
    );
    expect(g.map((e) => e.eventId)).toEqual(['evt_parkguell_20260316']);
  });

  it('keeps the sold-out night without a quantity and drops it with one', async () => {
    const { tickets } = setupTickets();
    const base = {
      city: 'Barcelona',
      dateFrom: '2026-03-15',
      dateTo: '2026-03-15',
      query: 'razzmatazz',
    };
    expect(unwrap(await tickets.searchEvents(base)).map((e) => e.eventId)).toEqual([
      'evt_rzm_20260315',
    ]);
    expect(unwrap(await tickets.searchEvents({ ...base, quantity: 1 }))).toEqual([]);
  });

  it('filters by category and max unit price incl. fees, sorted by start', async () => {
    const { tickets } = setupTickets();
    const all = {
      city: 'Barcelona',
      dateFrom: '2026-03-12',
      dateTo: '2026-03-17',
    };
    const sports = unwrap(await tickets.searchEvents({ ...all, categories: ['sports'] }));
    expect(sports.map((e) => e.eventId)).toEqual(['evt_fcb_sev_20260315']);
    // Barça is €72 / €68 incl. fees: nothing under €60.
    const cheap = unwrap(
      await tickets.searchEvents({ ...all, categories: ['sports'], maxUnitPrice: eur(6000) }),
    );
    expect(cheap).toEqual([]);
    // exactly at €68 includes Gol Nord
    const atCap = unwrap(
      await tickets.searchEvents({ ...all, categories: ['sports'], maxUnitPrice: eur(6800) }),
    );
    expect(atCap).toHaveLength(1);
    const everything = unwrap(await tickets.searchEvents(all));
    const starts = everything.map((e) => Date.parse(e.startsAt));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(everything.length).toBe(9);
  });

  it('returns nothing for other cities and rejects bad dates', async () => {
    const { tickets } = setupTickets();
    expect(
      unwrap(
        await tickets.searchEvents({
          city: 'Lisbon',
          dateFrom: '2026-03-12',
          dateTo: '2026-03-17',
        }),
      ),
    ).toEqual([]);
    expect(
      errorCode(
        await tickets.searchEvents({
          city: 'Barcelona',
          dateFrom: '2026-03-20',
          dateTo: '2026-03-12',
        }),
      ),
    ).toBe('invalid_request');
    expect(
      errorCode(
        await tickets.searchEvents({
          city: 'Barcelona',
          dateFrom: 'tonight',
          dateTo: '2026-03-12',
        }),
      ),
    ).toBe('invalid_request');
    expect(
      errorCode(
        await tickets.searchEvents({
          city: 'Barcelona',
          dateFrom: '2026-03-12',
          dateTo: '2026-03-12',
          quantity: 0,
        }),
      ),
    ).toBe('invalid_request');
  });
});

describe('mock tickets: offers and holds', () => {
  it('lists tonight’s tiers for 5, and none for the sold-out night', async () => {
    const { tickets } = setupTickets();
    const offers = unwrap(await tickets.getOffers('evt_rzm_20260314', 5));
    expect(offers.map((o) => o.offerId)).toEqual([
      'off_rzm_20260314_ga',
      'off_rzm_20260314_fast',
      'off_rzm_20260314_vip',
    ]);
    expect(unwrap(await tickets.getOffers('evt_rzm_20260315', 1))).toEqual([]);
    expect(errorCode(await tickets.getOffers('evt_nope', 1))).toBe('not_found');
    expect(errorCode(await tickets.getOffers('evt_rzm_20260314', 0))).toBe('invalid_request');
  });

  it('holds 5 GA for €90, locked for 15 minutes on the injected clock', async () => {
    const { tickets } = setupTickets();
    const before = tickets.availableFor(GA);
    const hold = await holdFive(tickets);
    expect(hold).toMatchObject({
      offerId: GA,
      quantity: 5,
      subtotal: eur(9000),
      fees: eur(0),
      taxes: eur(0),
      total: eur(9000),
      expiresAt: '2026-03-14T21:55:00+01:00',
    });
    expect(tickets.availableFor(GA)).toBe(before - 5);
    expect(tickets.holdCount()).toBe(1);
  });

  it('is idempotent per key: same hold back, no second reservation', async () => {
    const { tickets } = setupTickets();
    const a = await holdFive(tickets, 'k');
    const b = await holdFive(tickets, 'k');
    expect(b).toEqual(a);
    expect(tickets.holdCount()).toBe(1);
    expect(errorCode(await tickets.hold(GA, 4, 'k'))).toBe('duplicate');
  });

  it('adds fees per ticket (Barça: €65 + €7 fee)', async () => {
    const { tickets } = setupTickets();
    const hold = unwrap(await tickets.hold('off_fcb_sev_tribuna', 6, 'k'));
    expect(hold.subtotal).toEqual(eur(39000));
    expect(hold.fees).toEqual(eur(4200));
    expect(hold.total).toEqual(eur(43200)); // VOICE §4.1 Example B: €432 total
  });

  it('sold_out on the sold-out night and when stock runs out exactly', async () => {
    const { tickets } = setupTickets();
    expect(errorCode(await tickets.hold('off_rzm_20260315_ga', 5, 'a'))).toBe('sold_out');
    tickets.setAvailable(GA, 5);
    unwrap(await tickets.hold(GA, 5, 'b')); // exactly the remaining stock
    expect(tickets.availableFor(GA)).toBe(0);
    expect(errorCode(await tickets.hold(GA, 1, 'c'))).toBe('sold_out');
  });

  it('redirect-only items cannot be held', async () => {
    const { tickets } = setupTickets();
    const r = await tickets.hold('off_flamenco_20260313_show', 2, 'a');
    expect(errorCode(r)).toBe('not_supported');
    expect(!r.ok && r.error.message).toContain('redirect_only');
    expect(tickets.holdCount()).toBe(0);
  });

  it('rejects bad quantities and unknown offers', async () => {
    const { tickets } = setupTickets();
    expect(errorCode(await tickets.hold(GA, 0, 'a'))).toBe('invalid_request');
    expect(errorCode(await tickets.hold(GA, 2.5, 'a'))).toBe('invalid_request');
    expect(errorCode(await tickets.hold(GA, 11, 'a'))).toBe('invalid_request'); // maxPerOrder 10
    expect(errorCode(await tickets.hold('off_nope', 1, 'a'))).toBe('not_found');
    expect(errorCode(await tickets.hold(GA, 1, ''))).toBe('invalid_request');
  });

  it('expires exactly at expiresAt and returns the seats', async () => {
    const { tickets, clock } = setupTickets();
    const start = tickets.availableFor(GA);
    const hold = await holdFive(tickets);
    clock.advanceMs(15 * 60_000 - 1);
    expect(tickets.holdStatus(hold.holdId)).toBe('active');
    clock.advanceMs(1);
    expect(tickets.holdStatus(hold.holdId)).toBe('expired');
    expect(tickets.availableFor(GA)).toBe(start);
  });

  it('a fresh hold under the same key after expiry gets a new hold id', async () => {
    const { tickets, clock } = setupTickets();
    const first = await holdFive(tickets, 'k');
    clock.advanceMs(16 * 60_000);
    const second = await holdFive(tickets, 'k');
    expect(second.holdId).not.toBe(first.holdId);
    expect(second.expiresAt).toBe('2026-03-14T22:11:00+01:00');
  });

  it('releaseHold returns the seats and is safe to repeat', async () => {
    const { tickets } = setupTickets();
    const start = tickets.availableFor(GA);
    const hold = await holdFive(tickets);
    unwrap(await tickets.releaseHold(hold.holdId));
    unwrap(await tickets.releaseHold(hold.holdId));
    expect(tickets.availableFor(GA)).toBe(start);
    expect(errorCode(await tickets.purchase(request(hold)))).toBe('not_found');
    expect(errorCode(await tickets.releaseHold('hold_nope'))).toBe('not_found');
  });

  it('offer_expired once sales have closed', async () => {
    const { tickets } = setupTickets('2026-03-15T06:00:00+01:00');
    expect(errorCode(await tickets.hold(GA, 5, 'a'))).toBe('offer_expired');
    expect(unwrap(await tickets.getOffers('evt_rzm_20260314', 1))).toEqual([]);
  });
});

describe('mock tickets: purchase (the Razzmatazz moment)', () => {
  it('issues one ticket per holder with a fake QR, and a receipt that adds up', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const order = unwrap(await tickets.purchase(request(hold)));
    expect(order.orderId).toBe('RZ-48213');
    expect(order.status).toBe('confirmed');
    expect(order.total).toEqual(eur(9000));
    expect(order.approvalId).toBe('grant_t000001');
    expect(order.createdAt).toBe(TONIGHT);
    expect(order.event.eventId).toBe('evt_rzm_20260314');
    expect(order.offer.unitPrice).toEqual(eur(1800));
    expect(order.receipt.receiptNumber).toBe('RZ-48213');
    expect(order.receipt.lines).toEqual([
      { description: 'General admission', quantity: 5, unitAmount: eur(1800), amount: eur(9000) },
    ]);
    const lineSum = order.receipt.lines.reduce((s, l) => s + l.amount.amountMinor, 0);
    expect(lineSum).toBe(order.total.amountMinor);

    expect(order.tickets.map((t) => t.holderMemberId)).toEqual(FIVE.map((h) => h.memberId));
    expect(order.tickets.map((t) => t.holderName)).toEqual([
      'Dean',
      'Chase',
      'Piotr',
      'Arjun',
      'Crowley',
    ]);
    expect(new Set(order.tickets.map((t) => t.ticketId)).size).toBe(5);
    expect(new Set(order.tickets.map((t) => t.barcode.payload)).size).toBe(5);
    for (const t of order.tickets) {
      expect(t.ticketId).toMatch(/^tkt_/);
      expect(t.barcode.format).toBe('qr');
      expect(t.barcode.payload).toContain('NOT-VALID-FOR-ENTRY');
      expect(t.barcode.payload).toContain(order.orderId);
      expect(t.barcode.payload).not.toContain(t.holderMemberId);
      expect(t.transferable).toBe(false);
    }
    expect(order.tickets.some((t) => t.holderMemberId === 'mem_henry')).toBe(false);
    expect(tickets.purchaseCount()).toBe(1);
    expect(tickets.holdStatus(hold.holdId)).toBe('purchased');
  });

  it('same idempotency key never creates a second order (retries, double approval, concurrent)', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const first = unwrap(await tickets.purchase(request(hold)));
    const retries = await Promise.all([
      tickets.purchase(request(hold)),
      tickets.purchase(request(hold)),
      tickets.purchase(request(hold)),
    ]);
    for (const r of retries) expect(unwrap(r)).toEqual(first);
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('concurrent first attempts with the same key create exactly one order', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const results = await Promise.all([
      tickets.purchase(request(hold)),
      tickets.purchase(request(hold)),
    ]);
    const orders = results.map((r) => unwrap(r));
    expect(orders[0]).toEqual(orders[1]);
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('a retry still returns the original after the hold and approval have lapsed', async () => {
    const { tickets, clock } = setupTickets();
    const hold = await holdFive(tickets);
    const first = unwrap(await tickets.purchase(request(hold)));
    clock.advanceHours(2);
    expect(unwrap(await tickets.purchase(request(hold)))).toEqual(first);
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('same key with different parameters is duplicate and buys nothing', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    unwrap(await tickets.purchase(request(hold)));
    const swapped = [...FIVE.slice(0, 4), { memberId: 'mem_henry', name: 'Henry' }];
    expect(errorCode(await tickets.purchase(request(hold, { holders: swapped })))).toBe(
      'duplicate',
    );
    const other = unwrap(await tickets.hold(GA, 5, 'hold_key_2'));
    expect(errorCode(await tickets.purchase(request(other)))).toBe('duplicate');
    expect(
      errorCode(
        await tickets.purchase(request(hold, { approval: proof({ approvalId: 'grant_other' }) })),
      ),
    ).toBe('duplicate');
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('same key with a different expectedTotal is duplicate', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    unwrap(await tickets.purchase(request(hold)));
    for (const expectedTotal of [eur(8999), eur(10000), money(9000, 'USD')]) {
      expect(errorCode(await tickets.purchase(request(hold, { expectedTotal })))).toBe('duplicate');
    }
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('a replay without a proof is rejected, not served', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    unwrap(await tickets.purchase(request(hold)));
    const noProof = { ...request(hold), approval: undefined } as unknown as PurchaseTicketsRequest;
    expect(errorCode(await tickets.purchase(noProof))).toBe('approval_invalid');
  });

  it('the same hold cannot be bought twice under a different key', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    unwrap(await tickets.purchase(request(hold)));
    const r = await tickets.purchase(
      request(hold, { idempotencyKey: 'another', approval: proof({ approvalId: 'grant_2' }) }),
    );
    expect(errorCode(r)).toBe('duplicate');
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('one approval funds one order', async () => {
    const { tickets } = setupTickets();
    unwrap(await tickets.purchase(request(await holdFive(tickets, 'h1'))));
    const second = await holdFive(tickets, 'h2');
    const r = await tickets.purchase(request(second, { idempotencyKey: 'k2' }));
    expect(errorCode(r)).toBe('approval_invalid');
    expect(tickets.purchaseCount()).toBe(1);
  });
});

describe('mock tickets: purchase rejections (counter stays 0)', () => {
  const cases: [string, (p: ApprovalProof) => unknown, string][] = [
    ['missing proof', () => undefined, 'approval_invalid'],
    ['null proof', () => null, 'approval_invalid'],
    ['empty approvalId', (p) => ({ ...p, approvalId: '' }), 'approval_invalid'],
    ['no approvers', (p) => ({ ...p, approvedBy: [] }), 'approval_invalid'],
    ['missing audit event', (p) => ({ ...p, auditEventId: undefined }), 'approval_invalid'],
    ['garbage expiry', (p) => ({ ...p, expiresAt: 'soon' }), 'approval_invalid'],
    [
      'expired proof',
      (p) => ({
        ...p,
        expiresAt: '2026-03-14T21:39:00+01:00',
        approvedAt: '2026-03-14T21:00:00+01:00',
      }),
      'approval_invalid',
    ],
    [
      'expires exactly now',
      (p) => ({ ...p, expiresAt: TONIGHT, approvedAt: '2026-03-14T21:00:00+01:00' }),
      'approval_invalid',
    ],
    [
      'approved in the future',
      (p) => ({ ...p, approvedAt: '2026-03-14T21:45:00+01:00' }),
      'approval_invalid',
    ],
    ['insufficient: one cent under', (p) => ({ ...p, maxAmount: eur(8999) }), 'approval_exceeded'],
    ['other currency', (p) => ({ ...p, maxAmount: money(9000, 'USD') }), 'approval_invalid'],
    [
      'float maxAmount',
      (p) => ({ ...p, maxAmount: { amountMinor: 90.5, currency: 'EUR' } }),
      'approval_invalid',
    ],
  ];

  it.each(cases)('%s', async (_label, mutate, code) => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const req = { ...request(hold), approval: mutate(proof()) } as PurchaseTicketsRequest;
    const r = await tickets.purchase(req);
    expect(errorCode(r)).toBe(code);
    expect(tickets.purchaseCount()).toBe(0);
    // The hold is untouched; a correct request still succeeds.
    unwrap(await tickets.purchase(request(hold, { idempotencyKey: 'fresh' })));
    expect(tickets.purchaseCount()).toBe(1);
  });

  const groupCases: [string, Partial<PurchaseTicketsRequest>, string][] = [
    [
      'a proof granted in another group',
      { approval: proof({ groupId: 'grp_lisbon' }) },
      'approval_invalid',
    ],
    ['a request for another group', { groupId: 'grp_lisbon' }, 'approval_invalid'],
    ['an empty groupId', { groupId: '' }, 'invalid_request'],
    ['no groupId', { groupId: undefined as unknown as string }, 'invalid_request'],
  ];

  it.each(groupCases)('refuses %s (T-059)', async (_label, overrides, code) => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const r = await tickets.purchase(request(hold, overrides));
    expect(errorCode(r)).toBe(code);
    expect(tickets.purchaseCount()).toBe(0);
    expect(tickets.holdStatus(hold.holdId)).toBe('active');
    // The same hold still buys for the right group.
    unwrap(await tickets.purchase(request(hold, { idempotencyKey: 'fresh' })));
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('a same-key replay naming another group is duplicate, not the original order', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    unwrap(await tickets.purchase(request(hold)));
    const r = await tickets.purchase(
      request(hold, { groupId: 'grp_lisbon', approval: proof({ groupId: 'grp_lisbon' }) }),
    );
    expect(errorCode(r)).toBe('duplicate');
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('a same-key replay whose proof names another group is duplicate, even with the same approvalId', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const order = unwrap(await tickets.purchase(request(hold)));
    const r = await tickets.purchase(request(hold, { approval: proof({ groupId: 'grp_lisbon' }) }));
    expect(errorCode(r)).toBe('duplicate');
    expect(unwrap(await tickets.purchase(request(hold)))).toEqual(order);
    expect(tickets.purchaseCount()).toBe(1);
  });

  it('proof exactly at the total is enough', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    unwrap(await tickets.purchase(request(hold, { approval: proof({ maxAmount: eur(9000) }) })));
  });

  it('wrong expectedTotal is price_changed with the held amount', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    for (const expectedTotal of [eur(8999), eur(9001), money(9000, 'USD')]) {
      const r = await tickets.purchase(request(hold, { expectedTotal }));
      expect(errorCode(r)).toBe('price_changed');
      expect(!r.ok && r.error.newAmount).toEqual(eur(9000));
    }
    expect(tickets.purchaseCount()).toBe(0);
  });

  it('a provider price change hits new holds only; a stale expectedTotal is caught', async () => {
    const { tickets } = setupTickets();
    const locked = await holdFive(tickets, 'h1');
    tickets.setUnitPrice(GA, eur(2000));
    const repriced = await holdFive(tickets, 'h2');
    expect(repriced.total).toEqual(eur(10000));
    const stale = await tickets.purchase(
      request(repriced, { idempotencyKey: 'k2', expectedTotal: eur(9000) }),
    );
    expect(errorCode(stale)).toBe('price_changed');
    expect(!stale.ok && stale.error.newAmount).toEqual(eur(10000));
    // With the right total but the old €90 approval: exceeded.
    const under = await tickets.purchase(request(repriced, { idempotencyKey: 'k2' }));
    expect(errorCode(under)).toBe('approval_exceeded');
    // The locked hold still buys at €90.
    const order = unwrap(await tickets.purchase(request(locked)));
    expect(order.total).toEqual(eur(9000));
    expect(order.offer.unitPrice).toEqual(eur(1800));
  });

  it('hold_expired on the injected clock', async () => {
    const { tickets, clock } = setupTickets();
    const hold = await holdFive(tickets);
    clock.advanceMs(15 * 60_000);
    const r = await tickets.purchase(
      request(hold, { approval: proof({ expiresAt: '2026-03-14T23:00:00+01:00' }) }),
    );
    expect(errorCode(r)).toBe('hold_expired');
    expect(tickets.purchaseCount()).toBe(0);
  });

  it('holder list must match the hold exactly', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    const bad: unknown[] = [
      FIVE.slice(0, 4),
      [...FIVE, { memberId: 'mem_henry', name: 'Henry' }],
      [...FIVE.slice(0, 4), FIVE[0]],
      [...FIVE.slice(0, 4), { memberId: 'mem_crowley', name: ' ' }],
      [...FIVE.slice(0, 4), { memberId: '', name: 'Crowley' }],
      'everyone',
    ];
    for (const holders of bad) {
      const r = await tickets.purchase({ ...request(hold), holders } as PurchaseTicketsRequest);
      expect(errorCode(r)).toBe('invalid_request');
    }
    expect(tickets.purchaseCount()).toBe(0);
  });

  it('unknown hold is not_found', async () => {
    const { tickets } = setupTickets();
    const hold = await holdFive(tickets);
    expect(errorCode(await tickets.purchase(request(hold, { holdId: 'hold_nope' })))).toBe(
      'not_found',
    );
  });
});

describe('mock tickets: per-holder tickets', () => {
  async function bought(): Promise<{ tickets: MockTickets; order: TicketOrder }> {
    const { tickets } = setupTickets();
    const order = unwrap(await tickets.purchase(request(await holdFive(tickets))));
    return { tickets, order };
  }

  it('getTicketForHolder returns only that member’s ticket', async () => {
    const { tickets, order } = await bought();
    for (const h of FIVE) {
      const t = unwrap(await tickets.getTicketForHolder(order.orderId, h.memberId));
      expect(t.holderMemberId).toBe(h.memberId);
      const others = order.tickets.filter((x) => x.holderMemberId !== h.memberId);
      for (const o of others) expect(JSON.stringify(t)).not.toContain(o.barcode.payload);
    }
    expect(errorCode(await tickets.getTicketForHolder(order.orderId, 'mem_henry'))).toBe(
      'not_found',
    );
    expect(errorCode(await tickets.getTicketForHolder('RZ-0', 'mem_dean'))).toBe('not_found');
  });

  it('getOrder returns the order; unknown is not_found', async () => {
    const { tickets, order } = await bought();
    expect(unwrap(await tickets.getOrder(order.orderId))).toEqual(order);
    expect(errorCode(await tickets.getOrder('nope'))).toBe('not_found');
  });

  it('seated match tickets get consecutive seats; fast-line carries entryBefore', async () => {
    const { tickets } = setupTickets();
    const hold = unwrap(await tickets.hold('off_fcb_sev_tribuna', 2, 'h'));
    const order = unwrap(
      await tickets.purchase({
        groupId: 'grp_barcelona',
        holdId: hold.holdId,
        holders: FIVE.slice(0, 2),
        expectedTotal: hold.total,
        idempotencyKey: 'k',
        approval: proof({ maxAmount: eur(14400) }),
      }),
    );
    expect(order.orderId).toBe('FCB-48213');
    expect(order.tickets.map((t) => [t.section, t.seat])).toEqual([
      ['gate 14 · sector 234', 'row 8 · seat 10'],
      ['gate 14 · sector 234', 'row 8 · seat 11'],
    ]);
    expect(order.receipt.lines.map((l) => l.description)).toEqual([
      'Tribuna lateral',
      'Service fee',
    ]);
    expect(order.receipt.lines.reduce((s, l) => s + l.amount.amountMinor, 0)).toBe(14400);

    const fastHold = unwrap(await tickets.hold('off_rzm_20260314_fast', 1, 'h2'));
    const fast = unwrap(
      await tickets.purchase({
        groupId: 'grp_barcelona',
        holdId: fastHold.holdId,
        holders: FIVE.slice(0, 1),
        expectedTotal: fastHold.total,
        idempotencyKey: 'k2',
        approval: proof({ approvalId: 'grant_2', maxAmount: eur(2200) }),
      }),
    );
    expect(fast.orderId).toBe('RZ-48214');
    expect(fast.tickets[0]?.entryBefore).toBe('2026-03-15T01:30:00+01:00');
  });

  it('QR data URL is a deterministic SVG image', () => {
    const a = mockQrDataUrl('TRAV-MOCK-TICKET|x');
    expect(a).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(mockQrDataUrl('TRAV-MOCK-TICKET|x')).toBe(a);
    expect(mockQrDataUrl('TRAV-MOCK-TICKET|y')).not.toBe(a);
    const svg = Buffer.from(a.split(',')[1] ?? '', 'base64').toString('utf8');
    expect(svg).toContain('not valid for entry');
  });

  it('is deterministic: the same script yields identical orders', async () => {
    const run = async () => {
      const clock = createSimulatedClock(TONIGHT);
      const t = createMockTickets({
        clock,
        ids: createDeterministicIdGenerator('t'),
        inventory: loadTicketInventory('barcelona'),
      });
      const hold = unwrap(await t.hold(GA, 5, 'h'));
      return unwrap(await t.purchase(request(hold)));
    };
    expect(await run()).toEqual(await run());
  });
});

describe('mock tickets: refunds', () => {
  async function bought() {
    const { tickets, clock } = setupTickets();
    const order = unwrap(await tickets.purchase(request(await holdFive(tickets))));
    return { tickets, clock, order };
  }
  /** A refund approval of its own: one approval funds one action. */
  const refundProof = (amountMinor = 1800, approvalId = 'grant_refund') =>
    proof({ approvalId, maxAmount: eur(amountMinor) });

  it('partial then full refund before the deadline; refunded tickets stop being served', async () => {
    const { tickets, order } = await bought();
    const crowley = order.tickets[4];
    if (!crowley) throw new Error('no ticket');
    const before = tickets.availableFor(GA);
    const partial = unwrap(
      await tickets.refund(order.orderId, [crowley.ticketId], refundProof(), 'r1'),
    );
    expect(partial.status).toBe('partially_refunded');
    expect(partial.refundAmount).toEqual(eur(1800));
    expect(partial.refundedAmount).toEqual(eur(1800));
    expect(tickets.availableFor(GA)).toBe(before + 1);
    expect(errorCode(await tickets.getTicketForHolder(order.orderId, 'mem_crowley'))).toBe(
      'not_found',
    );
    unwrap(await tickets.getTicketForHolder(order.orderId, 'mem_dean'));
    // idempotent
    expect(
      unwrap(await tickets.refund(order.orderId, [crowley.ticketId], refundProof(), 'r1')),
    ).toEqual(partial);
    expect(tickets.refundCount()).toBe(1);
    // already refunded under a new key
    expect(
      errorCode(
        await tickets.refund(
          order.orderId,
          [crowley.ticketId],
          refundProof(1800, 'grant_r2'),
          'r2',
        ),
      ),
    ).toBe('invalid_request');
    const rest = order.tickets.slice(0, 4).map((t) => t.ticketId);
    const full = unwrap(
      await tickets.refund(order.orderId, rest, refundProof(7200, 'grant_r3'), 'r3'),
    );
    expect(full.status).toBe('refunded');
    // This refund's amount, next to the cumulative total.
    expect(full.refundAmount).toEqual(eur(7200));
    expect(full.refundedAmount).toEqual(eur(9000));
    const stored = unwrap(await tickets.getOrder(order.orderId));
    expect(stored.refundAmount).toBeUndefined();
    expect(stored.refundedAmount).toEqual(eur(9000));
    expect(tickets.refundCount()).toBe(2);
  });

  it('one approval funds one action: the purchase approval cannot fund a refund', async () => {
    const { tickets, order } = await bought();
    const id = order.tickets[0]?.ticketId ?? '';
    // proof() is the purchase approval (grant_t000001), with a cap that covers the refund.
    const r = await tickets.refund(order.orderId, [id], proof(), 'r1');
    expect(errorCode(r)).toBe('approval_invalid');
    expect(tickets.refundCount()).toBe(0);
    expect(unwrap(await tickets.getTicketForHolder(order.orderId, 'mem_dean')).status).toBe(
      'issued',
    );
  });

  it('one approval funds one action: a refund approval cannot fund a second refund', async () => {
    const { tickets, order } = await bought();
    const [t0, t1] = order.tickets;
    if (!t0 || !t1) throw new Error('no tickets');
    const approval = refundProof(3600, 'grant_refund_once');
    unwrap(await tickets.refund(order.orderId, [t0.ticketId], approval, 'r1'));
    const second = await tickets.refund(order.orderId, [t1.ticketId], approval, 'r2');
    expect(errorCode(second)).toBe('approval_invalid');
    expect(tickets.refundCount()).toBe(1);
    // Same key is an idempotent replay, not a second use.
    expect(unwrap(await tickets.refund(order.orderId, [t0.ticketId], approval, 'r1')).status).toBe(
      'partially_refunded',
    );
    // A same-key replay whose proof names another group is duplicate.
    const otherGroup = await tickets.refund(
      order.orderId,
      [t0.ticketId],
      proof({ approvalId: 'grant_refund_once', maxAmount: eur(3600), groupId: 'grp_lisbon' }),
      'r1',
    );
    expect(errorCode(otherGroup)).toBe('duplicate');
    expect(tickets.refundCount()).toBe(1);
  });

  it('refund rejects: past deadline, insufficient proof, unknown ticket, key reuse', async () => {
    const { tickets, clock, order } = await bought();
    const id = order.tickets[0]?.ticketId ?? '';
    expect(errorCode(await tickets.refund(order.orderId, [id], refundProof(1799), 'a'))).toBe(
      'approval_exceeded',
    );
    expect(errorCode(await tickets.refund(order.orderId, ['tkt_x'], refundProof(), 'b'))).toBe(
      'invalid_request',
    );
    expect(errorCode(await tickets.refund(order.orderId, [], refundProof(), 'c'))).toBe(
      'invalid_request',
    );
    expect(errorCode(await tickets.refund('nope', [id], refundProof(), 'd'))).toBe('not_found');
    unwrap(await tickets.refund(order.orderId, [id], refundProof(), 'e'));
    expect(
      errorCode(
        await tickets.refund(order.orderId, [order.tickets[1]?.ticketId ?? ''], refundProof(), 'e'),
      ),
    ).toBe('duplicate');
    clock.set('2026-03-14T22:00:00+01:00');
    const late = await tickets.refund(
      order.orderId,
      [order.tickets[1]?.ticketId ?? ''],
      proof({ approvalId: 'g', expiresAt: '2026-03-14T23:00:00+01:00', maxAmount: eur(1800) }),
      'f',
    );
    expect(errorCode(late)).toBe('not_supported');
  });

  it('refunded tickets are marked refunded in the order and never handed out for DM', async () => {
    const { tickets, order } = await bought();
    expect(order.tickets.every((t) => t.status === 'issued')).toBe(true);
    const crowley = order.tickets[4];
    if (!crowley) throw new Error('no ticket');
    const after = unwrap(
      await tickets.refund(order.orderId, [crowley.ticketId], refundProof(), 'r1'),
    );
    expect(after.tickets.map((t) => [t.holderMemberId, t.status])).toEqual([
      ['mem_dean', 'issued'],
      ['mem_chase', 'issued'],
      ['mem_piotr', 'issued'],
      ['mem_arjun', 'issued'],
      ['mem_crowley', 'refunded'],
    ]);
    // getOrder is the same order minus this refund's own `refundAmount`.
    expect(unwrap(await tickets.getOrder(order.orderId))).toEqual({
      ...after,
      refundAmount: undefined,
    });
    // The executor DMs only what getTicketForHolder returns: Crowley gets nothing.
    const dmable = [];
    for (const h of FIVE) {
      const r = await tickets.getTicketForHolder(order.orderId, h.memberId);
      if (r.ok) dmable.push(r.value);
    }
    expect(dmable.map((t) => t.holderMemberId)).toEqual([
      'mem_dean',
      'mem_chase',
      'mem_piotr',
      'mem_arjun',
    ]);
    expect(dmable.every((t) => t.status === 'issued')).toBe(true);
    // A purchase replay after the refund serves the current order, not a stale "issued" Crowley.
    const replay = unwrap(await tickets.purchase(request(await holdFive(tickets))));
    expect(replay.tickets.find((t) => t.holderMemberId === 'mem_crowley')?.status).toBe('refunded');
  });

  it('refuses a refund approved in another group, refunding nothing', async () => {
    const { tickets, order } = await bought();
    const id = order.tickets[0]?.ticketId ?? '';
    const r = await tickets.refund(
      order.orderId,
      [id],
      proof({ approvalId: 'grant_lis', groupId: 'grp_lisbon', maxAmount: eur(1800) }),
      'r1',
    );
    expect(errorCode(r)).toBe('approval_invalid');
    expect(tickets.refundCount()).toBe(0);
    expect(unwrap(await tickets.getTicketForHolder(order.orderId, 'mem_dean')).status).toBe(
      'issued',
    );
  });

  it('non-refundable VIP cannot be refunded', async () => {
    const { tickets } = setupTickets();
    const hold = unwrap(await tickets.hold('off_rzm_20260314_vip', 1, 'h'));
    const order = unwrap(
      await tickets.purchase({
        groupId: 'grp_barcelona',
        holdId: hold.holdId,
        holders: FIVE.slice(0, 1),
        expectedTotal: hold.total,
        idempotencyKey: 'k',
        approval: proof({ maxAmount: hold.total }),
      }),
    );
    expect(hold.total).toEqual(eur(9500));
    const r = await tickets.refund(
      order.orderId,
      [order.tickets[0]?.ticketId ?? ''],
      proof({ approvalId: 'g2', maxAmount: eur(9500) }),
      'r',
    );
    expect(errorCode(r)).toBe('not_supported');
  });
});
