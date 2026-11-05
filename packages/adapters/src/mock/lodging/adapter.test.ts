import type { Money, SimulatedClock } from '@trav/core';
import { createSimulatedClock, money } from '@trav/core';
import { describe, expect, it } from 'vitest';
import type { ApprovalProof, Result } from '../../interfaces/common.js';
import type {
  BookLodgingRequest,
  LodgingBooking,
  LodgingSearchRequest,
} from '../../interfaces/lodging.js';
import type { MockLodging } from './adapter.js';
import { createMockLodging } from './adapter.js';
import { loadLodgingInventory, parseLodgingInventory } from './inventory.js';

/** Friday 20 Feb 2026, 8:30pm in Barcelona: the group picks a place three weeks out. */
const PLANNING = '2026-02-20T20:30:00+01:00';
const EIXAMPLE_FLEX = 'rate_bcn_eixample_3br_flex';
const EIXAMPLE_DEADLINE = '2026-03-07T23:59:00+01:00';
const SIX = ['mem_dean', 'mem_henry', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'];

const eur = (amountMinor: number): Money => money(amountMinor, 'EUR');

function proof(overrides: Partial<ApprovalProof> = {}): ApprovalProof {
  return {
    approvalId: 'grant_l000001',
    proposalId: 'prop_l000001',
    groupId: 'grp_barcelona',
    approvedBy: SIX,
    approvedAt: PLANNING,
    expiresAt: '2026-02-20T21:00:00+01:00',
    maxAmount: eur(138000),
    auditEventId: 'aud_l000001',
    ...overrides,
  };
}

function bookReq(overrides: Partial<BookLodgingRequest> = {}): BookLodgingRequest {
  return {
    groupId: 'grp_barcelona',
    rateId: EIXAMPLE_FLEX,
    leadGuest: { memberId: 'mem_dean', givenName: 'Dean', familyName: 'Fictional' },
    guestMemberIds: SIX,
    expectedTotal: eur(138000),
    idempotencyKey: 'idem_lodging_1',
    approval: proof(),
    ...overrides,
  };
}

const groupAsk: LodgingSearchRequest = {
  near: { city: 'Barcelona' },
  checkIn: '2026-03-12',
  checkOut: '2026-03-17',
  adults: 6,
  wholeUnitForGroup: true,
  maxTotal: eur(150000),
  refundableOnly: true,
};
/** The group ask with no price ceiling. */
const anyPrice: LodgingSearchRequest = (({ maxTotal: _ignored, ...rest }) => rest)(groupAsk);

function setup(
  start = PLANNING,
  groupId?: string,
): { clock: SimulatedClock; lodging: MockLodging } {
  const clock = createSimulatedClock(start);
  const lodging = createMockLodging({
    clock,
    inventory: loadLodgingInventory('barcelona'),
    ...(groupId !== undefined ? { groupId } : {}),
  });
  return { clock, lodging };
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function errorCode<T>(r: Result<T>): string {
  if (r.ok) throw new Error('expected an error');
  return r.error.code;
}

async function bookEixample(lodging: MockLodging): Promise<LodgingBooking> {
  return value(await lodging.book(bookReq()));
}

describe('mock lodging: inventory', () => {
  it('loads the shared Barcelona fixture (all 8 listings, hotel rates may span rooms)', () => {
    const inv = loadLodgingInventory('barcelona');
    expect(inv.provider).toBe('mock-lodging');
    expect(inv.currency).toBe('EUR');
    expect([inv.checkIn, inv.checkOut]).toEqual(['2026-03-12', '2026-03-17']);
    expect(inv.properties).toHaveLength(8);
    const hotel = inv.properties.find((p) => p.property.kind === 'hotel');
    expect(hotel?.property.maxOccupancy).toBe(3);
    expect(hotel?.rates[0]?.rate.sleeps).toBe(6);
    expect(Object.isFrozen(inv.properties[0]?.rates[0]?.rate)).toBe(true);
    expect(loadLodgingInventory('barcelona')).toBe(inv);
  });

  it('rejects unknown names and malformed fixtures with the path', () => {
    expect(() => loadLodgingInventory('narnia')).toThrow(/no lodging inventory/);
    expect(() => loadLodgingInventory('toString')).toThrow(/no lodging inventory/);
    expect(() => parseLodgingInventory({ provider: 'x' })).toThrow(/\$\.checkIn/);
    const mutated = (edit: (rate: RawRate) => void): RawFixture => {
      const raw = loadRaw();
      const rate = raw.results[0]?.rates[0];
      if (!rate) throw new Error('fixture has no first rate');
      edit(rate);
      return raw;
    };
    expect(() =>
      parseLodgingInventory(
        mutated((r) => {
          r.sleeps = 9;
        }),
      ),
    ).toThrow(/exceeds maxOccupancy/);
    expect(() =>
      parseLodgingInventory(
        mutated((r) => {
          r.totalAmount.amountMinor = 1380.5;
        }),
      ),
    ).toThrow(/expected an integer/);
    expect(() =>
      parseLodgingInventory(
        mutated((r) => {
          delete r.refundPolicy.refundableUntil;
        }),
      ),
    ).toThrow(/needs a deadline/);
    expect(parseLodgingInventory(loadRaw()).properties).toHaveLength(8);
  });
});

describe('mock lodging: search', () => {
  it('answers the group ask: refundable whole units under €1,500, cheapest first', async () => {
    const { lodging } = setup();
    expect(lodging.info).toEqual({ provider: 'mock-lodging', mode: 'mock' });
    const results = value(await lodging.search(groupAsk));
    const rateIds = results.flatMap((r) => r.rates.map((x) => x.rateId));
    expect(rateIds[0]).toBe(EIXAMPLE_FLEX);
    expect(rateIds).toEqual([EIXAMPLE_FLEX, 'rate_bcn_barceloneta_flex']);
    const first = results[0]?.rates[0];
    expect(first?.totalAmount).toEqual(eur(138000));
    expect(first?.payAtProperty).toEqual(eur(10500));
    expect(first?.refundPolicy).toMatchObject({
      refundable: true,
      refundableUntil: EIXAMPLE_DEADLINE,
    });
    // Never listed: the sold-out Sant Antoni flat, non-refundable rates, the hostel, the €5,600 penthouse.
    for (const gone of [
      'rate_bcn_santantoni_flex',
      'rate_bcn_eixample_3br_nonref',
      'rate_bcn_poblenou_nonref',
      'rate_bcn_hostel_flex',
      'rate_bcn_penthouse_flex',
    ]) {
      expect(rateIds).not.toContain(gone);
    }
  });

  it('lists refundable before non-refundable even when dearer', async () => {
    const { lodging } = setup();
    const results = value(await lodging.search({ ...anyPrice, refundableOnly: false }));
    const eixample = results.find((r) => r.property.propertyId === 'prop_bcn_eixample_3br');
    expect(eixample?.rates.map((r) => r.rateId)).toEqual([
      EIXAMPLE_FLEX,
      'rate_bcn_eixample_3br_nonref',
    ]);
    const flags = results.map((r) => r.rates[0]?.refundPolicy.refundable);
    expect(flags.indexOf(false)).toBeGreaterThan(flags.lastIndexOf(true));
  });

  it('a hotel with per-room occupancy matches six via a two-room rate', async () => {
    const { lodging } = setup();
    const results = value(
      await lodging.search({
        near: { city: 'barcelona' },
        checkIn: '2026-03-12',
        checkOut: '2026-03-17',
        adults: 6,
        kinds: ['hotel'],
      }),
    );
    expect(results.map((r) => r.rates[0]?.rateId)).toEqual(['rate_bcn_hotel_2triples']);
  });

  it('honors geo radius, bedrooms, kinds, occupancy, and an exact-cap maxTotal', async () => {
    const { lodging } = setup();
    const atCap = value(await lodging.search({ ...groupAsk, maxTotal: eur(138000) }));
    expect(atCap.flatMap((r) => r.rates.map((x) => x.rateId))).toEqual([EIXAMPLE_FLEX]);
    const oneUnder = value(await lodging.search({ ...groupAsk, maxTotal: eur(137999) }));
    expect(oneUnder).toEqual([]);

    const eight = value(await lodging.search({ ...anyPrice, adults: 8, refundableOnly: false }));
    expect(eight.map((r) => r.property.propertyId)).toEqual(['prop_bcn_diagonal_penthouse']);

    const fourBr = value(await lodging.search({ ...anyPrice, minBedrooms: 4 }));
    expect(fourBr.map((r) => r.property.propertyId)).toEqual(['prop_bcn_diagonal_penthouse']);

    const eixGeo = loadLodgingInventory('barcelona').properties[0]?.property.place.geo;
    expect(eixGeo).toBeDefined();
    const near = value(
      await lodging.search({
        ...groupAsk,
        near: { geo: eixGeo ?? { lat: 0, lon: 0 }, radiusKm: 0.05 },
      }),
    );
    expect(near.map((r) => r.property.propertyId)).toEqual(['prop_bcn_eixample_3br']);
  });

  it('other dates or cities return nothing; bad input is invalid_request', async () => {
    const { lodging } = setup();
    expect(value(await lodging.search({ ...groupAsk, checkIn: '2026-03-13' }))).toEqual([]);
    expect(value(await lodging.search({ ...groupAsk, near: { city: 'Lisbon' } }))).toEqual([]);
    for (const bad of [
      { ...groupAsk, checkOut: '2026-03-12' },
      { ...groupAsk, checkIn: '2026-02-30' },
      { ...groupAsk, adults: 0 },
      { ...groupAsk, adults: 2.5 },
      { ...groupAsk, maxTotal: money(150000, 'USD') },
      { ...groupAsk, maxTotal: { amountMinor: 1.5, currency: 'EUR' } },
      { ...groupAsk, near: { city: '  ' } },
      { ...groupAsk, near: { geo: { lat: 99, lon: 0 }, radiusKm: 1 } },
      { ...groupAsk, kinds: ['castle'] } as unknown as LodgingSearchRequest,
    ]) {
      expect(errorCode(await lodging.search(bad))).toBe('invalid_request');
    }
  });

  it('refuses a search for a stay that has already started (Clock)', async () => {
    const { lodging } = setup('2026-03-13T09:00:00+01:00');
    expect(errorCode(await lodging.search(groupAsk))).toBe('invalid_request');
  });
});

describe('mock lodging: refundable deadlines read the injected Clock', () => {
  it('is refundable at the deadline instant and not one millisecond later', async () => {
    const { clock, lodging } = setup();
    clock.set(EIXAMPLE_DEADLINE);
    const atDeadline = value(await lodging.search(groupAsk));
    expect(atDeadline[0]?.rates[0]?.refundPolicy.refundable).toBe(true);

    clock.advanceMs(1);
    const after = value(await lodging.search(groupAsk));
    expect(after.flatMap((r) => r.rates.map((x) => x.rateId))).not.toContain(EIXAMPLE_FLEX);
    const all = value(await lodging.search({ ...groupAsk, refundableOnly: false }));
    const flex = all.flatMap((r) => r.rates).find((x) => x.rateId === EIXAMPLE_FLEX);
    expect(flex?.refundPolicy).toMatchObject({
      refundable: false,
      refundableUntil: EIXAMPLE_DEADLINE,
    });
  });

  it('quotes a full refund before the deadline and a full forfeit after it', async () => {
    const { clock, lodging } = setup();
    const booking = await bookEixample(lodging);
    const before = value(await lodging.quoteCancellation(booking.bookingId));
    expect(before).toMatchObject({
      refundAmount: eur(138000),
      forfeitedAmount: eur(0),
      deadlinePassed: false,
      refundableUntil: EIXAMPLE_DEADLINE,
    });
    clock.set('2026-03-08T00:00:00+01:00');
    const after = value(await lodging.quoteCancellation(booking.bookingId));
    expect(after).toMatchObject({
      refundAmount: eur(0),
      forfeitedAmount: eur(138000),
      deadlinePassed: true,
    });
  });

  it('cancelling after the deadline needs an approval covering the forfeit', async () => {
    const { clock, lodging } = setup();
    const booking = await bookEixample(lodging);
    clock.set('2026-03-09T10:00:00+01:00');
    const window = {
      approvedAt: '2026-03-09T10:00:00+01:00',
      expiresAt: '2026-03-09T10:30:00+01:00',
    };
    const tooSmall = proof({ ...window, approvalId: 'grant_cancel_small', maxAmount: eur(137999) });
    expect(errorCode(await lodging.cancel(booking.bookingId, tooSmall, 'idem_cancel_a'))).toBe(
      'approval_exceeded',
    );
    expect(lodging.cancellationCount()).toBe(0);
    const enough = proof({ ...window, approvalId: 'grant_cancel_ok', maxAmount: eur(138000) });
    const cancelled = value(await lodging.cancel(booking.bookingId, enough, 'idem_cancel_b'));
    expect(cancelled.status).toBe('cancelled');
    expect(lodging.cancellationCount()).toBe(1);
  });

  it('cancelling before the deadline forfeits nothing; replay is idempotent; the unit is freed', async () => {
    const { clock, lodging } = setup();
    const booking = await bookEixample(lodging);
    clock.advanceHours(1);
    const window = { approvedAt: clock.now(), expiresAt: '2026-02-20T22:00:00+01:00' };
    const p = proof({ ...window, approvalId: 'grant_cancel_free', maxAmount: eur(0) });
    value(await lodging.cancel(booking.bookingId, p, 'idem_cancel_1'));
    const again = value(await lodging.cancel(booking.bookingId, p, 'idem_cancel_1'));
    expect(again.status).toBe('cancelled');
    expect(lodging.cancellationCount()).toBe(1);
    expect(value(await lodging.getBooking(booking.bookingId)).status).toBe('cancelled');
    const other = proof({ ...window, approvalId: 'grant_cancel_free2', maxAmount: eur(0) });
    expect(errorCode(await lodging.cancel(booking.bookingId, other, 'idem_cancel_2'))).toBe(
      'invalid_request',
    );
    const listed = value(await lodging.search(groupAsk));
    expect(listed[0]?.rates[0]?.rateId).toBe(EIXAMPLE_FLEX);
  });
});

describe('mock lodging: recheckRate', () => {
  it('reports a price change once, then serves the new price', async () => {
    const { lodging } = setup();
    const first = await lodging.recheckRate('rate_bcn_gracia_flex');
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe('price_changed');
      expect(first.error.newAmount).toEqual(eur(172000));
      expect(first.error.retryable).toBe(true);
    }
    const second = value(await lodging.recheckRate('rate_bcn_gracia_flex'));
    expect(second.totalAmount).toEqual(eur(172000));
    expect(second.needsRecheck).toBe(false);
  });

  it('a rate with no change rechecks clean; sold-out and unknown rates fail', async () => {
    const { lodging } = setup();
    const ok = value(await lodging.recheckRate(EIXAMPLE_FLEX));
    expect(ok.totalAmount).toEqual(eur(138000));
    expect(ok.needsRecheck).toBe(false);

    // Barceloneta is cached as available but the provider says sold out on recheck.
    const before = value(await lodging.search(groupAsk));
    expect(before.flatMap((r) => r.rates.map((x) => x.rateId))).toContain(
      'rate_bcn_barceloneta_flex',
    );
    expect(errorCode(await lodging.recheckRate('rate_bcn_barceloneta_flex'))).toBe('sold_out');
    const after = value(await lodging.search(groupAsk));
    expect(after.flatMap((r) => r.rates.map((x) => x.rateId))).not.toContain(
      'rate_bcn_barceloneta_flex',
    );

    expect(errorCode(await lodging.recheckRate('rate_bcn_santantoni_flex'))).toBe('sold_out');
    expect(errorCode(await lodging.recheckRate('rate_nope'))).toBe('not_found');
  });

  it('a stay that has started is offer_expired', async () => {
    const { lodging } = setup('2026-03-13T12:00:00+01:00');
    expect(errorCode(await lodging.recheckRate(EIXAMPLE_FLEX))).toBe('offer_expired');
  });
});

describe('mock lodging: book', () => {
  it('books with a valid proof and the right total', async () => {
    const { lodging } = setup();
    const booking = await bookEixample(lodging);
    expect(booking).toMatchObject({
      bookingId: 'lbk_mock_000001',
      status: 'confirmed',
      checkIn: '2026-03-12',
      checkOut: '2026-03-17',
      guestMemberIds: SIX,
      approvalId: 'grant_l000001',
      createdAt: PLANNING,
      checkInInstructions: expect.stringMatching(/check-in from 3pm/),
    });
    expect(booking.confirmationCode).toMatch(/^EIX-\d{5}$/);
    expect(booking.rate.totalAmount).toEqual(eur(138000));
    expect(lodging.bookingCount()).toBe(1);
    expect(value(await lodging.getBooking(booking.bookingId))).toEqual(booking);
    expect(errorCode(await lodging.getBooking('lbk_nope'))).toBe('not_found');
  });

  it('is idempotent per key: retries return the same booking and the counter stays 1', async () => {
    const { clock, lodging } = setup();
    const first = await bookEixample(lodging);
    clock.advanceMs(60_000);
    const again = value(await lodging.book(bookReq()));
    const reordered = value(await lodging.book(bookReq({ guestMemberIds: [...SIX].reverse() })));
    expect(again).toEqual(first);
    expect(reordered.bookingId).toBe(first.bookingId);
    expect(lodging.bookingCount()).toBe(1);

    // Same key, different booking ⇒ duplicate, nothing recorded.
    expect(errorCode(await lodging.book(bookReq({ expectedTotal: eur(137000) })))).toBe(
      'duplicate',
    );
    expect(
      errorCode(await lodging.book(bookReq({ approval: proof({ approvalId: 'grant_other' }) }))),
    ).toBe('duplicate');
    expect(lodging.bookingCount()).toBe(1);
  });

  it('rejects bad ApprovalProofs and records nothing', async () => {
    const { clock, lodging } = setup(PLANNING, 'grp_barcelona');
    const cases: [string, unknown, string][] = [
      ['missing', undefined, 'approval_invalid'],
      ['no approvers', proof({ approvedBy: [] }), 'approval_invalid'],
      ['no audit event', proof({ auditEventId: '' }), 'approval_invalid'],
      [
        'approved in the future',
        proof({ approvedAt: '2026-02-20T20:31:00+01:00' }),
        'approval_invalid',
      ],
      ['other group', proof({ groupId: 'grp_lisbon' }), 'approval_invalid'],
      ['wrong currency', proof({ maxAmount: money(200000, 'USD') }), 'approval_invalid'],
      ['one cent short', proof({ maxAmount: eur(137999) }), 'approval_exceeded'],
      [
        'float maxAmount',
        proof({ maxAmount: { amountMinor: 138000.5, currency: 'EUR' } }),
        'approval_invalid',
      ],
    ];
    for (const [name, approval, code] of cases) {
      const r = await lodging.book(
        bookReq({ approval: approval as ApprovalProof, idempotencyKey: `idem_${name}` }),
      );
      expect([name, errorCode(r)]).toEqual([name, code]);
    }
    expect(lodging.bookingCount()).toBe(0);

    // Expired on the Clock: valid until 21:00 exclusive.
    clock.set('2026-02-20T21:00:00+01:00');
    expect(errorCode(await lodging.book(bookReq({ idempotencyKey: 'idem_expired' })))).toBe(
      'approval_invalid',
    );
    expect(lodging.bookingCount()).toBe(0);
  });

  it('request identity (T-059): refuses another group even without a group-scoped adapter', async () => {
    const { lodging } = setup(); // no options.groupId: only the request names the group
    const cases: [string, Partial<BookLodgingRequest>, string][] = [
      [
        'proof from another group',
        { approval: proof({ groupId: 'grp_lisbon' }) },
        'approval_invalid',
      ],
      ['request for another group', { groupId: 'grp_lisbon' }, 'approval_invalid'],
      ['empty groupId', { groupId: '' }, 'invalid_request'],
      ['no groupId', { groupId: undefined as unknown as string }, 'invalid_request'],
    ];
    for (const [name, over, code] of cases) {
      const r = await lodging.book(bookReq({ ...over, idempotencyKey: `idem_${name}` }));
      expect([name, errorCode(r)]).toEqual([name, code]);
    }
    expect(lodging.bookingCount()).toBe(0);
    // The right group still books; a same-key replay naming another group is duplicate.
    const booking = await bookEixample(lodging);
    const replay = await lodging.book(
      bookReq({ groupId: 'grp_lisbon', approval: proof({ groupId: 'grp_lisbon' }) }),
    );
    expect(errorCode(replay)).toBe('duplicate');
    expect(lodging.bookingCount()).toBe(1);
    expect(value(await lodging.getBooking(booking.bookingId)).status).toBe('confirmed');
  });

  it('a same-key replay whose proof names another group is duplicate (book and cancel)', async () => {
    const { lodging } = setup();
    const booking = await bookEixample(lodging);
    const replay = await lodging.book(bookReq({ approval: proof({ groupId: 'grp_lisbon' }) }));
    expect(errorCode(replay)).toBe('duplicate');
    expect(value(await lodging.book(bookReq()))).toEqual(booking);

    const cancelProof = proof({ approvalId: 'grant_cancel_1' });
    value(await lodging.cancel(booking.bookingId, cancelProof, 'cancel_1'));
    const otherGroup = await lodging.cancel(
      booking.bookingId,
      proof({ approvalId: 'grant_cancel_1', groupId: 'grp_lisbon' }),
      'cancel_1',
    );
    expect(errorCode(otherGroup)).toBe('duplicate');
    expect(lodging.bookingCount()).toBe(1);
    expect(lodging.cancellationCount()).toBe(1);
  });

  it('allows spending exactly at the approval cap', async () => {
    const { lodging } = setup();
    const r = await lodging.book(bookReq({ approval: proof({ maxAmount: eur(138000) }) }));
    expect(r.ok).toBe(true);
  });

  it('rejects a wrong expectedTotal with price_changed + newAmount, and the fixture re-price', async () => {
    const { lodging } = setup();
    const low = await lodging.book(bookReq({ expectedTotal: eur(130000), idempotencyKey: 'k1' }));
    expect(low.ok).toBe(false);
    if (!low.ok) {
      expect(low.error.code).toBe('price_changed');
      expect(low.error.newAmount).toEqual(eur(138000));
    }
    // Gràcia re-prices €1,640 → €1,720 at the provider; booking at the cached price fails.
    const gracia = bookReq({
      rateId: 'rate_bcn_gracia_flex',
      expectedTotal: eur(164000),
      idempotencyKey: 'k2',
      approval: proof({ approvalId: 'grant_gracia', maxAmount: eur(172000) }),
    });
    const stale = await lodging.book(gracia);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.newAmount).toEqual(eur(172000));
    expect(errorCode(await lodging.book({ ...gracia, expectedTotal: 'lots' } as never))).toBe(
      'invalid_request',
    );
    expect(lodging.bookingCount()).toBe(0);
    // A proof sized for the old price does not cover the new one.
    const under = await lodging.book({
      ...gracia,
      expectedTotal: eur(172000),
      idempotencyKey: 'k3',
      approval: proof({ approvalId: 'grant_gracia_old', maxAmount: eur(164000) }),
    });
    expect(errorCode(under)).toBe('approval_exceeded');
    const fresh = await lodging.book({
      ...gracia,
      expectedTotal: eur(172000),
      idempotencyKey: 'k4',
    });
    expect(value(fresh).rate.totalAmount).toEqual(eur(172000));
    expect(lodging.bookingCount()).toBe(1);
  });

  it('one approval funds one booking', async () => {
    const { lodging } = setup();
    await bookEixample(lodging);
    const reuse = await lodging.book(
      bookReq({
        rateId: 'rate_bcn_hostel_flex',
        expectedTotal: eur(54000),
        idempotencyKey: 'idem_lodging_2',
      }),
    );
    expect(errorCode(reuse)).toBe('approval_invalid');
    expect(lodging.bookingCount()).toBe(1);
  });

  it('a whole unit can be booked once: its other rate is gone too', async () => {
    const { lodging } = setup();
    await bookEixample(lodging);
    const nonref = await lodging.book(
      bookReq({
        rateId: 'rate_bcn_eixample_3br_nonref',
        expectedTotal: eur(125000),
        idempotencyKey: 'idem_nonref',
        approval: proof({ approvalId: 'grant_nonref' }),
      }),
    );
    expect(errorCode(nonref)).toBe('sold_out');
    const listed = value(await lodging.search({ ...anyPrice, refundableOnly: false }));
    expect(listed.map((r) => r.property.propertyId)).not.toContain('prop_bcn_eixample_3br');
  });

  it('rejects sold-out, unknown, started stays and bad guest lists', async () => {
    const { lodging } = setup();
    const p = (id: string) => proof({ approvalId: id, maxAmount: eur(200000) });
    expect(
      errorCode(
        await lodging.book(
          bookReq({
            rateId: 'rate_bcn_santantoni_flex',
            expectedTotal: eur(129000),
            idempotencyKey: 'a',
            approval: p('g_a'),
          }),
        ),
      ),
    ).toBe('sold_out');
    expect(
      errorCode(
        await lodging.book(bookReq({ rateId: 'nope', idempotencyKey: 'b', approval: p('g_b') })),
      ),
    ).toBe('not_found');
    const guestCases: Partial<BookLodgingRequest>[] = [
      { guestMemberIds: [] },
      { guestMemberIds: [...SIX, 'mem_extra'] },
      { guestMemberIds: ['mem_dean', 'mem_dean'] },
      { leadGuest: { memberId: 'mem_stranger', givenName: 'S', familyName: 'T' } },
      { leadGuest: { memberId: 'mem_dean', givenName: '', familyName: 'T' } },
      { leadGuest: { memberId: 'mem_dean', givenName: 'Dean', familyName: ' ' } },
      { specialRequests: 'x'.repeat(501) },
    ];
    for (const [i, c] of guestCases.entries()) {
      const r = await lodging.book(
        bookReq({ ...c, idempotencyKey: `g${i}`, approval: p(`g_g${i}`) }),
      );
      expect(errorCode(r)).toBe('invalid_request');
    }
    expect(errorCode(await lodging.book(bookReq({ idempotencyKey: '' })))).toBe('invalid_request');
    expect(lodging.bookingCount()).toBe(0);

    const late = setup('2026-03-13T10:00:00+01:00');
    const window = {
      approvedAt: '2026-03-13T10:00:00+01:00',
      expiresAt: '2026-03-13T10:30:00+01:00',
    };
    expect(errorCode(await late.lodging.book(bookReq({ approval: proof(window) })))).toBe(
      'offer_expired',
    );
  });

  it('five guests in a six-bed unit is fine (Henry stays home)', async () => {
    const { lodging } = setup();
    const five = SIX.filter((m) => m !== 'mem_henry');
    const b = value(await lodging.book(bookReq({ guestMemberIds: five })));
    expect(b.guestMemberIds).toEqual(five);
  });
});

describe('mock lodging: host messaging', () => {
  it('Airbnb-style rentals return not_supported; the check-in summary is the fallback', async () => {
    const { lodging } = setup();
    const booking = await bookEixample(lodging);
    const sent = await lodging.messageProperty(
      booking.bookingId,
      'landing at 11pm, late check-in ok?',
    );
    expect(errorCode(sent)).toBe('not_supported');
    expect(errorCode(await lodging.listPropertyMessages(booking.bookingId))).toBe('not_supported');
    expect(lodging.messageCount()).toBe(0);
    const summary = value(await lodging.getCheckInSummary(booking.bookingId));
    expect(summary).toMatchObject({
      propertyName: 'Eixample 3BR with balcony',
      checkInFrom: '15:00',
      checkOutBy: '11:00',
      timeZone: 'Europe/Madrid',
      guestCount: 6,
      payAtProperty: eur(10500),
      refundableUntil: EIXAMPLE_DEADLINE,
      hostMessaging: 'not_supported',
    });
  });

  it('a hotel that supports messaging keeps a thread', async () => {
    const { clock, lodging } = setup();
    const booking = value(
      await lodging.book(
        bookReq({
          rateId: 'rate_bcn_hotel_2triples',
          expectedTotal: eur(231000),
          approval: proof({ maxAmount: eur(231000) }),
        }),
      ),
    );
    clock.advanceMs(1000);
    const msg = value(
      await lodging.messageProperty(booking.bookingId, 'can we drop bags at 10am?'),
    );
    expect(msg).toEqual({ from: 'guest', text: 'can we drop bags at 10am?', sentAt: clock.now() });
    expect(value(await lodging.listPropertyMessages(booking.bookingId))).toEqual([msg]);
    expect(errorCode(await lodging.messageProperty(booking.bookingId, ''))).toBe('invalid_request');
    expect(errorCode(await lodging.messageProperty('lbk_nope', 'hi'))).toBe('not_found');
    expect(lodging.messageCount()).toBe(1);
    const summary = value(await lodging.getCheckInSummary(booking.bookingId));
    expect(summary.hostMessaging).toBe('supported');
    expect(summary.payAtProperty).toBeUndefined();
  });
});

describe('mock lodging: the lead guest name (D-037, T-132)', () => {
  it('a whole-home rental books under a given name alone; a hotel refuses it and books with a family name', async () => {
    const { lodging } = setup();
    const home = await lodging.book(
      bookReq({ leadGuest: { memberId: 'mem_dean', givenName: 'Dean' } }),
    );
    expect(value(home).status).toBe('confirmed');
    const hotelReq = (familyName?: string, key = 'idem_hotel'): BookLodgingRequest =>
      bookReq({
        rateId: 'rate_bcn_hotel_2triples',
        expectedTotal: eur(231000),
        idempotencyKey: key,
        leadGuest: {
          memberId: 'mem_dean',
          givenName: 'Dean',
          ...(familyName !== undefined ? { familyName } : {}),
        },
        approval: proof({ approvalId: `grant_${key}`, maxAmount: eur(231000) }),
      });
    expect(errorCode(await lodging.book(hotelReq()))).toBe('invalid_request');
    expect(lodging.bookingCount()).toBe(1);
    expect(value(await lodging.book(hotelReq('Fictional', 'idem_hotel_2'))).status).toBe(
      'confirmed',
    );
    expect(lodging.bookingCount()).toBe(2);
  });
});

describe('mock lodging: review fixes', () => {
  it('a unit filled by our own booking comes back after cancel (not remembered as sold out)', async () => {
    const { clock, lodging } = setup();
    const booking = await bookEixample(lodging);
    expect(errorCode(await lodging.recheckRate('rate_bcn_eixample_3br_nonref'))).toBe('sold_out');
    expect(errorCode(await lodging.recheckRate(EIXAMPLE_FLEX))).toBe('sold_out');
    clock.advanceHours(1);
    const p = proof({
      approvalId: 'grant_cancel_free',
      approvedAt: clock.now(),
      expiresAt: '2026-02-20T22:00:00+01:00',
      maxAmount: eur(0),
    });
    value(await lodging.cancel(booking.bookingId, p, 'idem_cancel_1'));
    const listed = value(await lodging.search({ ...anyPrice, refundableOnly: false }));
    const eixample = listed.find((r) => r.property.propertyId === 'prop_bcn_eixample_3br');
    expect(eixample?.rates.map((r) => r.rateId)).toEqual([
      EIXAMPLE_FLEX,
      'rate_bcn_eixample_3br_nonref',
    ]);
    // A fixture sell-out discovered on recheck still stays hidden.
    expect(errorCode(await lodging.recheckRate('rate_bcn_barceloneta_flex'))).toBe('sold_out');
    const after = value(await lodging.search(groupAsk));
    expect(after.flatMap((r) => r.rates.map((x) => x.rateId))).not.toContain(
      'rate_bcn_barceloneta_flex',
    );
  });

  it('same key with a different lead guest is a duplicate, not a replay', async () => {
    const { lodging } = setup();
    const first = await bookEixample(lodging);
    const otherLead = await lodging.book(
      bookReq({ leadGuest: { memberId: 'mem_maya', givenName: 'Maya', familyName: 'Fictional' } }),
    );
    expect(errorCode(otherLead)).toBe('duplicate');
    const renamed = await lodging.book(
      bookReq({ leadGuest: { memberId: 'mem_dean', givenName: 'Dean', familyName: 'Other' } }),
    );
    expect(errorCode(renamed)).toBe('duplicate');
    expect(value(await lodging.book(bookReq())).bookingId).toBe(first.bookingId);
    expect(lodging.bookingCount()).toBe(1);
  });
});

// ---------- helpers ----------

interface RawRate {
  sleeps: number;
  totalAmount: { amountMinor: number };
  refundPolicy: { refundableUntil?: string };
}

interface RawFixture {
  results: { rates: RawRate[] }[];
}

function loadRaw(): RawFixture {
  // Rebuild a raw fixture from the parsed shared inventory (round-trips through the parser).
  const inv = loadLodgingInventory('barcelona');
  return structuredClone({
    provider: inv.provider,
    city: inv.city,
    checkIn: inv.checkIn,
    checkOut: inv.checkOut,
    results: inv.properties.map((p) => ({
      property: p.property,
      rates: p.rates.map((r) => r.rate),
    })),
  }) as unknown as RawFixture;
}
