/** One mock over several per-trip inventories (T-080/T-093). */
import { describe, expect, it } from 'vitest';
import { createDeterministicIdGenerator, createSimulatedClock, money } from '@trav/core';
import type { TicketHold } from '../../interfaces/tickets.js';
import type { MockTickets } from './index.js';
import { createMockTickets, loadAllTicketInventories, loadTicketInventory } from './index.js';
import { FIVE, TONIGHT, proof } from './testing.js';

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

function setupAll(start: string): MockTickets {
  return createMockTickets({
    clock: createSimulatedClock(start),
    ids: createDeterministicIdGenerator('m'),
    inventory: loadAllTicketInventories(),
  });
}

async function buy(
  tickets: MockTickets,
  offerId: string,
  holders: typeof FIVE,
  groupId: string,
  approvalId: string,
  at: string,
  currency: string,
) {
  const hold: TicketHold = unwrap(await tickets.hold(offerId, holders.length, `h_${approvalId}`));
  return unwrap(
    await tickets.purchase({
      groupId,
      holdId: hold.holdId,
      holders,
      expectedTotal: hold.total,
      idempotencyKey: `k_${approvalId}`,
      approval: proof({
        approvalId,
        groupId,
        approvedAt: at,
        expiresAt: '2026-12-31T00:00:00Z',
        maxAmount: money(100000, currency),
      }),
    }),
  );
}

describe('mock tickets over several inventories', () => {
  it('each trip city sees only its own events', async () => {
    const tickets = setupAll('2026-03-01T12:00:00+01:00');
    const lis = unwrap(
      await tickets.searchEvents({
        city: 'Lisbon',
        dateFrom: '2026-04-15',
        dateTo: '2026-04-20',
        query: 'benfica vs porto',
      }),
    );
    expect(lis.map((e) => e.eventId)).toContain('evt_lis_benfica_porto');
    expect(lis.every((e) => e.venue.city === 'Lisbon')).toBe(true);

    const fado = unwrap(
      await tickets.searchEvents({
        city: 'Lisbon',
        dateFrom: '2026-04-15',
        dateTo: '2026-04-20',
        query: 'fado',
      }),
    );
    expect(fado.map((e) => e.eventId)).toEqual(['evt_lis_fado_0416']);

    const tci = unwrap(
      await tickets.searchEvents({
        city: 'Providenciales',
        dateFrom: '2026-06-20',
        dateTo: '2026-06-27',
        query: 'snorkel',
        quantity: 4,
      }),
    );
    expect(tci.map((e) => e.eventId)).toEqual(['evt_tci_snorkel_0622']);

    const bcn = unwrap(
      await tickets.searchEvents({
        city: 'Barcelona',
        dateFrom: '2026-03-12',
        dateTo: '2026-03-16',
      }),
    );
    expect(bcn.length).toBeGreaterThan(0);
    expect(bcn.every((e) => e.venue.city === 'Barcelona')).toBe(true);
  });

  it('a purchase in another trip never shifts the Razzmatazz receipt number', async () => {
    const tickets = setupAll('2026-03-14T21:40:00+01:00');
    const lisOrder = await buy(
      tickets,
      'off_lis_benfica_porto_std',
      FIVE.slice(0, 2),
      'grp_lisbon',
      'grant_lis',
      '2026-03-14T21:40:00+01:00',
      'EUR',
    );
    const tciOrder = await buy(
      tickets,
      'off_tci_snorkel_0622',
      FIVE.slice(0, 4),
      'grp_tci',
      'grant_tci',
      '2026-03-14T21:40:00+01:00',
      'USD',
    );
    const rzm = await buy(
      tickets,
      'off_rzm_20260314_ga',
      FIVE,
      'grp_barcelona',
      'grant_bcn',
      TONIGHT,
      'EUR',
    );
    expect(rzm.orderId).toBe('RZ-48213');
    // Lisbon and TCI share the default "TK" prefix: ids stay unique.
    expect(lisOrder.orderId).toBe('TK-48213');
    expect(tciOrder.orderId).toBe('TK-48214');
    expect(tciOrder.total.currency).toBe('USD');
    expect(tickets.purchaseCount()).toBe(3);
    expect(unwrap(await tickets.getOrder('TK-48214')).event.eventId).toBe('evt_tci_snorkel_0622');
  });

  it('one approval still funds only one order across inventories', async () => {
    const tickets = setupAll('2026-03-14T21:40:00+01:00');
    await buy(
      tickets,
      'off_lis_benfica_porto_std',
      FIVE.slice(0, 2),
      'grp_x',
      'grant_1',
      TONIGHT,
      'EUR',
    );
    const hold = unwrap(await tickets.hold('off_rzm_20260314_ga', 5, 'h_again'));
    const again = await tickets.purchase({
      groupId: 'grp_x',
      holdId: hold.holdId,
      holders: FIVE,
      expectedTotal: hold.total,
      idempotencyKey: 'k_again',
      approval: proof({ approvalId: 'grant_1', groupId: 'grp_x', maxAmount: money(100000, 'EUR') }),
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('approval_invalid');
  });

  it('rejects inventories that share event or offer ids, and an empty list', () => {
    const clock = createSimulatedClock(TONIGHT);
    const ids = createDeterministicIdGenerator('d');
    const bcn = loadTicketInventory('barcelona');
    expect(() => createMockTickets({ clock, ids, inventory: [bcn, bcn] })).toThrow(
      /more than one inventory/,
    );
    expect(() => createMockTickets({ clock, ids, inventory: [] })).toThrow(/at least one/);
  });

  it('a single inventory behaves exactly as before', async () => {
    const one = createMockTickets({
      clock: createSimulatedClock(TONIGHT),
      ids: createDeterministicIdGenerator('s'),
      inventory: loadTicketInventory('barcelona'),
    });
    const order = await buy(
      one,
      'off_rzm_20260314_ga',
      FIVE,
      'grp_barcelona',
      'g1',
      TONIGHT,
      'EUR',
    );
    expect(order.orderId).toBe('RZ-48213');
    expect(order.total).toEqual(money(9000, 'EUR'));
  });
});
