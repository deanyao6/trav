/**
 * T-074: group flights in chat. "@trav find us flights" runs
 * `flights.optimizeGroupFlights` over the mock airline (round trip or
 * open-jaw per origin) and posts one options card; "book option 1" proposes
 * that set through `recordProposal` (consistency → ApprovalPolicy → audit →
 * grant); nothing is bought until every payer 👍s, and then one order per
 * traveler goes out under its own key and proof, capped at its own fare.
 */
import { describe, expect, it } from 'vitest';
import type {
  BookingProposal,
  BookingProposalCard,
  Clock,
  Member,
  OptionsCard,
  OutboundMessage,
} from '@trav/core';
import {
  audit as auditCore,
  createDeterministicIdGenerator,
  createSimulatedClock,
  isReaction,
  money,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type {
  CreateFlightOrderRequest,
  FlightsAdapter,
  MockFlightsAdapter,
  Result,
} from '@trav/adapters';
import { createMockFlights, createMockTickets, loadTicketInventory } from '@trav/adapters';
import { partialFlightsText } from '../approval/handler.js';
import { seedBarcelona } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { harness, type Harness } from '../runtime.testkit.js';
import { createSearchFlightsTool } from '../tools/search.js';
import {
  createFlightPlanStore,
  dayDate,
  decodeFlightSet,
  encodeFlightSet,
  NO_FLIGHT_OPTIONS_TEXT,
  REPLACED_OPTIONS_TEXT,
  planGroupFlights,
  wallClock,
  type GroupFlightAsk,
} from './flights.js';
import { createProposalService } from './proposals.js';

const G = 'grp_barcelona';
const T = 'trip_barcelona';
const PLANNING = '2026-02-03T20:11:00+01:00';
const ASK =
  "@trav we're 6, flying BOS SFO ORD JFK LAX MIA into BCN thurs mar 12, home tues mar 17 to JFK LAX ORD IAD SEA ATL. find flights that land around the same time";
const HANDLES = ['h_dean', 'h_maya', 'h_priya', 'h_jordan', 'h_sam', 'h_henry'] as const;

/** The Barcelona travelers as they said it in the chat (open-jaw for all but Jordan). */
const TRAVELERS: GroupFlightAsk['travelers'] = [
  { memberId: 'mem_dean', origin: 'BOS', returnTo: 'JFK' },
  { memberId: 'mem_maya', origin: 'SFO', returnTo: 'LAX' },
  { memberId: 'mem_jordan', origin: 'ORD' },
  { memberId: 'mem_priya', origin: 'JFK', returnTo: 'IAD' },
  { memberId: 'mem_sam', origin: 'LAX', returnTo: 'SEA' },
  { memberId: 'mem_henry', origin: 'MIA', returnTo: 'ATL' },
];
const BCN_ASK: GroupFlightAsk = {
  travelers: TRAVELERS,
  destination: 'BCN',
  departDate: '2026-03-12',
  returnDate: '2026-03-17',
};

function group(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group');
}

/** The mock airline, with hooks: orders seen, a failing order, a fare that moves after quoting. */
interface SpyFlights extends FlightsAdapter {
  readonly inner: MockFlightsAdapter;
  readonly orders: CreateFlightOrderRequest[];
  failOrder?: number;
  /** offerId ⇒ minor units added to that offer's total on `getOffer`. */
  readonly bump: Map<string, number>;
}

function spyFlights(clock: Clock): SpyFlights {
  const inner = createMockFlights({ clock });
  const orders: CreateFlightOrderRequest[] = [];
  const bump = new Map<string, number>();
  const spy: SpyFlights = {
    inner,
    orders,
    bump,
    info: inner.info,
    search: (r) => inner.search(r),
    async getOffer(id) {
      const res = await inner.getOffer(id);
      const extra = bump.get(id);
      if (!res.ok || extra === undefined) return res;
      const t = res.value.totalAmount;
      return {
        ok: true,
        value: { ...res.value, totalAmount: money(t.amountMinor + extra, t.currency) },
      };
    },
    async createOrder(req) {
      orders.push(req);
      if (spy.failOrder !== undefined && orders.length === spy.failOrder) {
        return {
          ok: false,
          error: { code: 'sold_out', message: 'seat gone', retryable: false },
        } as Result<never>;
      }
      return inner.createOrder(req);
    },
    getOrder: (id) => inner.getOrder(id),
    quoteCancellation: (id) => inner.quoteCancellation(id),
    confirmCancellation: (q, a, k) => inner.confirmCancellation(q, a, k),
  };
  return spy;
}

function planning(): { h: Harness; flights: SpyFlights } {
  // The mock airline reads the runtime's own simulated clock (made by the harness).
  const ref: { h?: Harness } = {};
  const clock: Clock = { now: () => ref.h!.clock.now(), nowMs: () => ref.h!.clock.nowMs() };
  const flights = spyFlights(clock);
  const h = harness({ runtime: { providers: { flights } } });
  ref.h = h;
  h.clock.set(PLANNING);
  return { h, flights };
}

async function options(h: Harness): Promise<{ msg: OutboundMessage; card: OptionsCard }> {
  const turn = await h.say('h_dean', ASK);
  const msg = group(turn).find((m) => m.card?.type === 'options');
  if (msg === undefined || msg.card?.type !== 'options') {
    throw new Error(
      `no options card: ${group(turn)
        .map((m) => m.text)
        .join(' | ')}`,
    );
  }
  return { msg, card: msg.card };
}

async function bookOption(
  h: Harness,
  n = 1,
): Promise<{ msg: OutboundMessage; card: BookingProposalCard; proposal: BookingProposal }> {
  const turn = await h.say('h_dean', `@trav book option ${String(n)}`);
  const msg = group(turn).find((m) => m.card?.type === 'booking_proposal');
  if (msg === undefined || msg.card?.type !== 'booking_proposal') {
    throw new Error(
      `no proposal card: ${group(turn)
        .map((m) => m.text)
        .join(' | ')}`,
    );
  }
  const proposal = h.runtime.stores.group.bookings.getProposal(msg.card.proposalId)!;
  return { msg, card: msg.card, proposal };
}

function flightBookings(h: Harness) {
  return h.runtime.stores.group.bookings.listByTrip(T).filter((b) => b.kind === 'flight');
}

describe('the flight set ref (proposal itemRef ⇄ executor)', () => {
  it('round-trips who flies on which offer at which fare, and rejects anything else', () => {
    const parts = [
      { memberId: 'mem_dean', offerId: 'off_a_1', totalMinor: 41200 },
      { memberId: 'mem_sam', offerId: 'off_b_2', totalMinor: 55900 },
    ];
    const ref = encodeFlightSet(parts);
    expect(ref).toBe('flights:mem_dean=off_a_1@41200,mem_sam=off_b_2@55900');
    expect(decodeFlightSet(ref)).toEqual(parts);
    for (const bad of [
      'off_a_1',
      'flights:',
      'flights:off_a_1@41200',
      'flights:mem_dean=off_a_1@0',
      'flights:mem_dean=off_a_1@-5',
      'flights:mem_dean=off_a_1@1.5',
      'flights:mem_dean=off_a_1@41200,mem_sam=off_a_1@100',
      'flights:mem_dean=off_a_1@41200,mem_dean=off_b@100',
      'flights:mem dean=off_a_1@41200',
    ]) {
      expect(decodeFlightSet(bad)).toBeUndefined();
    }
    expect(() => encodeFlightSet([])).toThrow();
    expect(() => encodeFlightSet([...parts, { ...parts[0]!, offerId: 'off_c' }])).toThrow();
  });

  it('formats times and days the VOICE §3.9 way', () => {
    expect(wallClock('2026-03-12T07:10:00-04:00')).toBe('7:10am');
    expect(wallClock('2026-03-12T12:00:00+01:00')).toBe('12pm');
    expect(wallClock('2026-03-12T00:05:00+01:00')).toBe('12:05am');
    expect(dayDate('2026-03-12')).toBe('thu mar 12');
  });
});

describe('planGroupFlights (the optimizer over the mock airline)', () => {
  function rig() {
    const clock = createSimulatedClock(PLANNING);
    const ids = createDeterministicIdGenerator('f');
    const stores = createMemoryStores({ clock, ids });
    seedBarcelona(stores);
    const trip = stores.group.trips.get(T)!;
    const members = stores.group.members.listByGroup(G);
    const plans = createFlightPlanStore();
    const ctx = { groupId: G, trip, members, requestedBy: 'mem_dean', now: clock.now() };
    return { clock, ids, stores, trip, members, plans, ctx };
  }

  it('Barcelona: 3 whole-group options, all-refundable first, the per-person lines in the card, within the 6-line cap', async () => {
    const r = rig();
    const flights = createMockFlights({ clock: r.clock });
    const res = await planGroupFlights({ flights, plans: r.plans, ids: r.ids }, BCN_ASK, r.ctx);
    expect(res.kind).toBe('flight_options');
    if (res.kind !== 'flight_options') return;
    const lines = res.text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toBe('flights for 6 into BCN thu mar 12, home tue mar 17. best 3:');
    expect(lines[1]).toMatch(/^1\. €[\d,]+ · everyone lands within \d+h(?: \d+m)? · refundable$/);
    expect(lines.at(-1)).toBe('say "@trav book option 1" (or 2 or 3). nothing\'s booked yet');
    expect(res.text).not.toMatch(/\*\*|`|^- /m);
    // Refundable first (SAFETY C5): option 1 is all-refundable; a non-refundable
    // set only shows up later, with its trade-off said.
    expect(res.card.options[0]!.refundable).toBe(true);
    const locked = res.card.options.filter((o) => !o.refundable);
    for (const o of locked) {
      expect(o.index).toBeGreaterThan(1);
      expect(o.details!.some((d) => /non-refundable/.test(d))).toBe(true);
    }
    for (const o of res.card.options) {
      expect(o.details).toHaveLength(6);
      // Each line names the member and both legs, open-jaw included.
      expect(o.details![0]).toMatch(/^Dean BOS .* → BCN .* · home .* to JFK · €/);
      // The option total is the sum of the per-person fares, in integer minor units.
      const sum = o.details!.reduce(
        (s, d) => s + Number(/€([\d,]+)/.exec(d)![1]!.replace(/,/g, '')) * 100,
        0,
      );
      expect(sum).toBe(o.price.amountMinor);
    }
    // Option 1 is the optimizer's pick, kept for "book option 1".
    const plan = r.plans.latest(G)!;
    expect(plan.planId).toBe(res.card.cardId);
    expect(plan.options.map((o) => o.totalMinor)).toEqual(
      res.card.options.map((o) => o.price.amountMinor),
    );
    expect(plan.options[0]!.picks.map((p) => p.memberId)).toEqual(TRAVELERS.map((t) => t.memberId));
    expect(plan.options[0]!.picks.find((p) => p.memberId === 'mem_jordan')!.returnTo).toBe('ORD');
  });

  it('a traveler with no flights that day gets one honest line, no partial card and no plan', async () => {
    const r = rig();
    const flights = createMockFlights({ clock: r.clock });
    const res = await planGroupFlights(
      { flights, plans: r.plans, ids: r.ids },
      {
        ...BCN_ASK,
        travelers: [...TRAVELERS.slice(0, 5), { memberId: 'mem_henry', origin: 'ANC' }],
      },
      r.ctx,
    );
    expect(res).toMatchObject({ kind: 'unavailable', reason: 'not_found' });
    expect(res.text).toBe(
      "no flights for Henry (ANC → BCN) on thu mar 12, so no options yet. nothing's booked\ncheck the airports and dates and @ me again",
    );
    expect(r.plans.latest(G)).toBeUndefined();
  });

  it('the airline down: says so, no plan', async () => {
    const r = rig();
    const inner = createMockFlights({ clock: r.clock });
    const down: FlightsAdapter = {
      ...inner,
      search: () =>
        Promise.resolve({
          ok: false,
          error: { code: 'provider_unavailable', message: 'down', retryable: true },
        }),
    };
    const res = await planGroupFlights(
      { flights: down, plans: r.plans, ids: r.ids },
      BCN_ASK,
      r.ctx,
    );
    expect(res).toMatchObject({ kind: 'unavailable', reason: 'provider_unavailable' });
    expect(res.text).toMatch(/not responding, so no options yet. nothing's booked/);
    expect(r.plans.latest(G)).toBeUndefined();
  });

  it("a minor's fare goes on their guardian, who approves; the minor never does", async () => {
    const r = rig();
    const sam = r.members.find((m) => m.memberId === 'mem_sam')!;
    r.stores.group.members.upsert({
      ...sam,
      ageBand: 'under18',
      guardianMemberId: 'mem_dean',
    } as Member);
    const flights = createMockFlights({ clock: r.clock });
    const members = r.stores.group.members.listByGroup(G);
    await planGroupFlights({ flights, plans: r.plans, ids: r.ids }, BCN_ASK, { ...r.ctx, members });
    const service = createProposalService({
      stores: r.stores,
      tickets: createMockTickets({
        clock: r.clock,
        ids: r.ids,
        inventory: loadTicketInventory('barcelona'),
      }),
      flights,
      flightPlans: r.plans,
      clock: r.clock,
      ids: r.ids,
    });
    const res = await service.propose(
      { kind: 'flight', option: 1 },
      { groupId: G, tripId: T, requestedBy: 'mem_dean', sourceMessageId: 'msg_x' },
    );
    expect(res.kind).toBe('proposal');
    if (res.kind !== 'proposal') return;
    const p = res.proposal;
    expect(p.attendees).toHaveLength(6);
    const fares = new Map(
      decodeFlightSet(p.itemRef)!.map((x) => [x.memberId, x.totalMinor] as const),
    );
    expect(p.payers.map((s) => s.memberId)).not.toContain('mem_sam');
    expect(p.payers.find((s) => s.memberId === 'mem_dean')!.shareMinor).toBe(
      fares.get('mem_dean')! + fares.get('mem_sam')!,
    );
    expect(p.payers.reduce((s, x) => s + x.shareMinor, 0)).toBe(p.totalMinor);
    expect(res.decision.requiredApprovers).not.toContain('mem_sam');
    expect(res.text).toMatch(/Sam's on Dean's/);
  });
});

describe('flights in chat (T-074): ask → options → "book option 1" → every payer 👍 → booked', () => {
  it('Barcelona step 2 end to end: nothing bought until the sixth 👍, then 6 orders, 1 booking, audited, nothing on the tab', async () => {
    const { h, flights } = planning();
    const { msg: optionsMsg, card } = await options(h);
    expect(optionsMsg.text).toMatch(/^flights for 6 into BCN thu mar 12, home tue mar 17/);
    expect(h.pending()).toEqual([]);
    expect(flights.orders).toEqual([]);
    expect(h.auditTypes()).not.toContain('proposal.created');

    const { msg, card: pc, proposal } = await bookOption(h);
    // The proposal is option 1 exactly, at the live fares.
    expect(proposal).toMatchObject({
      kind: 'flight',
      provider: flights.info.provider,
      paidBy: { kind: 'per_person_cards' },
      totalMinor: card.options[0]!.price.amountMinor,
      currency: 'EUR',
      refundable: true,
    });
    expect([...proposal.attendees].sort()).toEqual(TRAVELERS.map((t) => t.memberId).sort());
    const set = decodeFlightSet(proposal.itemRef)!;
    expect(set).toHaveLength(6);
    // Each pays their own fare: payer shares are the per-traveler fares.
    for (const part of set) {
      expect(proposal.payers.find((s) => s.memberId === part.memberId)?.shareMinor).toBe(
        part.totalMinor,
      );
    }
    const decision = h.runtime.stores.group.bookings.getDecision(proposal.proposalId)!.decision;
    expect(decision.outcome).toBe('needs_confirmation');
    expect(decision.approvalMode).toBe('each_payer');
    expect(decision.reasons).toEqual(
      expect.arrayContaining(['kind_requires_each_payer', 'payer_not_requester']),
    );
    expect(decision.requiredApprovers).toHaveLength(6);
    expect(msg.text.split('\n').length).toBeLessThanOrEqual(6);
    expect(msg.text).toMatch(/^option 1, flights for 6: into BCN thu mar 12, home tue mar 17\n/);
    expect(msg.text).toMatch(/· refundable before departure/);
    expect(msg.text).toMatch(/each pays their own fare on their own card, nothing to split/);
    expect(msg.text).toMatch(/all 6 of you have to 👍/);
    expect(pc.item.details).toHaveLength(6);
    expect(pc.charged).toHaveLength(6);
    const types = h.auditTypes();
    expect(types.indexOf('proposal.created')).toBeLessThan(types.indexOf('policy.evaluated'));
    expect(types.indexOf('policy.evaluated')).toBeLessThan(types.indexOf('approval.requested'));

    // Five 👍s: nothing moves (SAFETY C2/C9).
    for (const handle of HANDLES.slice(0, 5)) await h.tap(handle, msg.id, 'approve');
    expect(flights.orders).toEqual([]);
    expect(flightBookings(h)).toEqual([]);

    const last = await h.tap('h_henry', msg.id, 'approve');
    expect(flights.inner.purchaseCount()).toBe(6);
    const [booking, ...more] = flightBookings(h);
    expect(more).toEqual([]);
    expect(booking).toMatchObject({
      kind: 'flight',
      totalMinor: proposal.totalMinor,
      paidBy: { kind: 'per_person_cards' },
      payers: proposal.payers,
    });
    expect(booking!.orderRef.split(', ')).toHaveLength(6);
    // Nothing on the tab: each paid their own fare (D-040).
    expect(h.runtime.stores.group.expenses.listByTrip(T)).toEqual([]);
    const receipt = group(last).find((m) => m.card?.type === 'receipt');
    expect(receipt?.text).toMatch(
      /^booked ✅ flights to BCN, €[\d,]+\n6 airline orders, refs in the card · refundable until /,
    );
    expect(receipt?.text).toMatch(/each on your own card, nothing to split$/);
    // Every order went out after the policy and the last grant, all audited.
    const log = h.audit().filter((e) => e.proposalId === proposal.proposalId);
    const seq = log.map((e) => e.type);
    expect(seq.filter((t) => t === 'approval.granted')).toHaveLength(6);
    expect(seq.lastIndexOf('approval.granted')).toBeLessThan(seq.indexOf('booking.attempted'));
    expect(seq.indexOf('booking.attempted')).toBeLessThan(seq.indexOf('booking.completed'));
    expect(seq).not.toContain('ledger.written');
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);

    // One order per traveler under its own key, with a proof capped at that fare.
    expect(flights.orders.map((o) => o.idempotencyKey)).toEqual(
      set.map((_, i) => `${proposal.idempotencyKey}#${String(i + 1)}`),
    );
    expect(new Set(flights.orders.map((o) => o.approval.approvalId)).size).toBe(6);
    for (const [i, o] of flights.orders.entries()) {
      expect(o.offerId).toBe(set[i]!.offerId);
      expect(o.travelers.map((t) => t.memberId)).toEqual([set[i]!.memberId]);
      expect(o.expectedTotal).toEqual(money(set[i]!.totalMinor, 'EUR'));
      expect(o.approval.maxAmount).toEqual(money(set[i]!.totalMinor, 'EUR'));
      expect(o.approval.proposalId).toBe(proposal.proposalId);
      expect(o.groupId).toBe(G);
      // v0 has first names only: booked under the given name, nothing invented.
      expect(o.travelers[0]!.familyName).toBeUndefined();
    }

    // A second tap buys nothing.
    await h.tap('h_henry', msg.id, 'approve');
    expect(flights.inner.purchaseCount()).toBe(6);
    expect(flightBookings(h)).toHaveLength(1);
  });

  it('[Option 2] on the options card is "book option 2" from whoever tapped: a proposal, nothing bought; a guest\'s tap does nothing', async () => {
    const { h, flights } = planning();
    const { msg, card } = await options(h);
    const guest = await h.tap('h_ava', msg.id, 'pick', card.options[1]!.id);
    expect(group(guest)).toEqual([]);
    expect(h.pending()).toEqual([]);
    const turn = await h.tap('h_maya', msg.id, 'pick', card.options[1]!.id);
    const sent = group(turn).find((m) => m.card?.type === 'booking_proposal');
    expect(sent?.text).toMatch(/^option 2, flights for 6: into BCN/);
    const [p] = h.pending();
    expect(p).toMatchObject({ kind: 'flight', requestedBy: 'mem_maya' });
    expect(p!.totalMinor).toBe(card.options[1]!.price.amountMinor);
    expect(flights.orders).toEqual([]);
    // A value that is not this card's option is no pick.
    const stale = await h.tap('h_dean', msg.id, 'pick', 'card_other#1');
    expect(group(stale)).toEqual([]);
  });

  it('"book option 1" with no options up, or a number that is not on the card, proposes nothing', async () => {
    const { h, flights } = planning();
    const early = await h.say('h_dean', '@trav book option 1');
    expect(group(early).map((m) => m.text)).toEqual([NO_FLIGHT_OPTIONS_TEXT]);
    await options(h);
    const wrong = await h.say('h_dean', '@trav book option 7');
    expect(group(wrong).map((m) => m.text)).toEqual([
      'which one? there are 3 options up. say "@trav book option 1" (up to 3)',
    ]);
    expect(h.pending()).toEqual([]);
    expect(flights.orders).toEqual([]);
  });

  it('"not me" re-quotes the same flights for the rest, and the fresh card needs its own 👍s', async () => {
    const { h, flights } = planning();
    await options(h);
    const { msg, proposal } = await bookOption(h);
    const out = await h.tap('h_sam', msg.id, 'not_me');
    const next = group(out).find((m) => m.card?.type === 'booking_proposal');
    expect(next?.card?.type).toBe('booking_proposal');
    if (next?.card?.type !== 'booking_proposal') return;
    const fresh = h.runtime.stores.group.bookings.getProposal(next.card.proposalId)!;
    expect(fresh.proposalId).not.toBe(proposal.proposalId);
    expect(fresh.attendees).not.toContain('mem_sam');
    expect(fresh.attendees).toHaveLength(5);
    const samFare = decodeFlightSet(proposal.itemRef)!.find((p) => p.memberId === 'mem_sam')!;
    expect(fresh.totalMinor).toBe(proposal.totalMinor - samFare.totalMinor);
    // The same offers for everyone else.
    const before = new Map(decodeFlightSet(proposal.itemRef)!.map((p) => [p.memberId, p.offerId]));
    for (const p of decodeFlightSet(fresh.itemRef)!) expect(p.offerId).toBe(before.get(p.memberId));
    expect(next.text).toMatch(/flights for 5 \(not Sam\)/);
    expect(h.runtime.stores.group.bookings.getProposal(proposal.proposalId)!.status).toBe(
      'superseded',
    );
    // Nothing bought by the re-quote; the 5 still each have to approve.
    expect(flights.orders).toEqual([]);
    for (const handle of ['h_dean', 'h_maya', 'h_priya', 'h_jordan']) {
      await h.tap(handle, next.id, 'approve');
    }
    expect(flights.orders).toEqual([]);
    await h.tap('h_henry', next.id, 'approve');
    expect(flights.inner.purchaseCount()).toBe(5);
    expect(flightBookings(h)[0]!.attendees).not.toContain('mem_sam');
  });

  it('a fare that moved after the card went up is never bought at the old price: a fresh card at the new total', async () => {
    const { h, flights } = planning();
    await options(h);
    const { msg, proposal } = await bookOption(h);
    const priya = decodeFlightSet(proposal.itemRef)!.find((p) => p.memberId === 'mem_priya')!;
    flights.bump.set(priya.offerId, 4000);
    for (const handle of HANDLES) await h.tap(handle, msg.id, 'approve');
    expect(flights.orders).toEqual([]);
    expect(flightBookings(h)).toEqual([]);
    const requote = h.pending().find((p) => p.kind === 'flight');
    expect(requote).toBeDefined();
    expect(requote!.proposalId).not.toBe(proposal.proposalId);
    expect(requote!.totalMinor).toBe(proposal.totalMinor + 4000);
    expect(h.auditTypes()).toContain('approval.invalidated');
  });

  /** Each traveler's offer on an option, by member. */
  const offersOf = (p: BookingProposal): Map<string, string> =>
    new Map(decodeFlightSet(p.itemRef)!.map((x) => [x.memberId, x.offerId] as const));

  it('"not me" on option 3 re-quotes option 3: the same flights for everyone left, never option 1 (review r1 #1)', async () => {
    const { h, flights } = planning();
    const { card } = await options(h);
    const { msg, proposal } = await bookOption(h, 3);
    expect(msg.text).toMatch(/^option 3, flights for 6/);
    expect(proposal.totalMinor).toBe(card.options[2]!.price.amountMinor);
    const out = await h.tap('h_sam', msg.id, 'not_me');
    const next = group(out).find((m) => m.card?.type === 'booking_proposal')!;
    expect(next.text).toMatch(/^option 3, flights for 5 \(not Sam\)/);
    const fresh = h.pending().find((p) => p.kind === 'flight')!;
    const before = offersOf(proposal);
    const after = offersOf(fresh);
    expect([...after.keys()].sort()).toEqual(
      [...before.keys()].filter((id) => id !== 'mem_sam').sort(),
    );
    for (const [member, offer] of after) expect(offer).toBe(before.get(member));
    const samFare = decodeFlightSet(proposal.itemRef)!.find((p) => p.memberId === 'mem_sam')!;
    expect(fresh.totalMinor).toBe(proposal.totalMinor - samFare.totalMinor);
    // A second "not me" on the fresh card still stays on option 3.
    const again = await h.tap('h_jordan', next.id, 'not_me');
    expect(group(again).find((m) => m.card?.type === 'booking_proposal')?.text).toMatch(
      // Everyone off option 3 since it was posted, in member order.
      /^option 3, flights for 4 \(not Jordan, Sam\)/,
    );
    expect(flights.orders).toEqual([]);
  });

  it('a fare that moves on option 2 re-quotes option 2 on the same flights at the new fare', async () => {
    const { h, flights } = planning();
    await options(h);
    const { msg, proposal } = await bookOption(h, 2);
    const priya = decodeFlightSet(proposal.itemRef)!.find((p) => p.memberId === 'mem_priya')!;
    flights.bump.set(priya.offerId, 2500);
    let last: TurnResult | undefined;
    for (const handle of HANDLES) last = await h.tap(handle, msg.id, 'approve');
    expect(flights.orders).toEqual([]);
    const requote = h.pending().find((p) => p.kind === 'flight')!;
    expect(requote.proposalId).not.toBe(proposal.proposalId);
    expect(offersOf(requote)).toEqual(offersOf(proposal));
    expect(requote.totalMinor).toBe(proposal.totalMinor + 2500);
    expect(
      group(last!)
        .map((m) => m.text)
        .join('\n'),
    ).toMatch(/option 2, flights for 6/);
  });

  it("the mock airline's own re-price (11 min later) on option 3: the repost is option 3, same flights", async () => {
    const { h, flights } = planning();
    await options(h);
    const { msg, proposal } = await bookOption(h, 3);
    h.clock.advanceMs(11 * 60 * 1000);
    let last: TurnResult | undefined;
    for (const handle of HANDLES) last = await h.tap(handle, msg.id, 'approve');
    expect(flights.inner.purchaseCount()).toBe(0);
    const requote = h.pending().find((p) => p.kind === 'flight');
    expect(requote).toBeDefined();
    expect(requote!.proposalId).not.toBe(proposal.proposalId);
    expect(offersOf(requote!)).toEqual(offersOf(proposal));
    expect(requote!.totalMinor).not.toBe(proposal.totalMinor);
    expect(
      group(last!)
        .map((m) => m.text)
        .join('\n'),
    ).toMatch(/^option 3, flights for 6/m);
  });

  it('a tap on an options card a newer search replaced books nothing and points at the newer card (review r1 #2)', async () => {
    const { h } = planning();
    const { msg: old, card: oldCard } = await options(h);
    const { msg: latest, card: newCard } = await options(h);
    expect(newCard.cardId).not.toBe(oldCard.cardId);
    const stale = await h.tap('h_maya', old.id, 'pick', oldCard.options[0]!.id);
    expect(group(stale).map((m) => m.text)).toEqual([REPLACED_OPTIONS_TEXT]);
    expect(h.pending()).toEqual([]);
    const ok = await h.tap('h_maya', latest.id, 'pick', newCard.options[0]!.id);
    expect(group(ok).some((m) => m.card?.type === 'booking_proposal')).toBe(true);
  });

  it('the expiry line keeps the airport code: "flights to BCN proposal expired" (review r1 #3)', async () => {
    const { h, flights } = planning();
    await options(h);
    await bookOption(h);
    h.clock.advanceMs(20 * 60 * 1000);
    const turns = await h.runtime.drain();
    const texts = turns.flatMap((t) => group(t).map((m) => m.text));
    expect(texts).toContain(
      'flights to BCN proposal expired, no charge. @ me if you still want it',
    );
    expect(flights.orders).toEqual([]);
  });

  it('the receipt says whose fare a guardian carries: "(Sam\'s on Dean\'s)" (review r1 #4)', async () => {
    const { h, flights } = planning();
    const sam = h.runtime.stores.group.members.get('mem_sam')!;
    h.runtime.stores.group.members.upsert({
      ...sam,
      ageBand: 'under18',
      guardianMemberId: 'mem_dean',
    } as Member);
    await options(h);
    const { msg, proposal } = await bookOption(h);
    expect(msg.text).toMatch(
      /each pays their own fare on their own card \(Sam's on Dean's\), nothing to split/,
    );
    const decision = h.runtime.stores.group.bookings.getDecision(proposal.proposalId)!.decision;
    expect(decision.requiredApprovers).not.toContain('mem_sam');
    let last: TurnResult | undefined;
    for (const handle of HANDLES.filter((x) => x !== 'h_sam')) {
      last = await h.tap(handle, msg.id, 'approve');
    }
    expect(flights.inner.purchaseCount()).toBe(6);
    const receipt = group(last!).find((m) => m.card?.type === 'receipt');
    expect(receipt?.text).toMatch(/each on your own card \(Sam's on Dean's\), nothing to split$/);
  });

  it('an order that fails after others landed: the booking covers who is booked, the rest are told plainly, nothing bought twice', async () => {
    const { h, flights } = planning();
    await options(h);
    const { msg, proposal } = await bookOption(h);
    flights.failOrder = 3;
    let last: TurnResult | undefined;
    for (const handle of HANDLES) last = await h.tap(handle, msg.id, 'approve');
    expect(flights.inner.purchaseCount()).toBe(2);
    const set = decodeFlightSet(proposal.itemRef)!;
    const booked = set.slice(0, 2).map((p) => p.memberId);
    const [booking, ...more] = flightBookings(h);
    expect(more).toEqual([]);
    expect(booking!.attendees).toEqual(booked);
    expect(booking!.totalMinor).toBe(set[0]!.totalMinor + set[1]!.totalMinor);
    expect(booking!.payers.map((p) => p.memberId)).toEqual(booked);
    const completed = h
      .audit()
      .find((e) => e.type === 'booking.completed' && e.proposalId === proposal.proposalId)!;
    // Maya's order was refused; Jordan's, Priya's and Sam's were never sent.
    expect(completed.payload['partial']).toMatchObject({
      failed: [set[2]!.memberId],
      notSent: set.slice(3).map((p) => p.memberId),
      errorCode: 'sold_out',
      approvedTotalMinor: proposal.totalMinor,
    });
    expect(flights.orders.map((o) => o.travelers[0]!.memberId)).toEqual(
      set.slice(0, 3).map((p) => p.memberId),
    );
    // One group message (VOICE §3.7): the receipt, then who isn't booked.
    const sent = group(last!);
    expect(sent).toHaveLength(1);
    const lines = sent[0]!.text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toMatch(/^booked ✅ flights to BCN, €[\d,]+$/);
    expect(lines[1]).toMatch(/^2 airline orders, refs in the card/);
    // Orders go out in member order: Dean and Henry landed, the third (Maya's) failed.
    expect(lines.slice(-3).join('\n')).toBe(
      [
        "Maya's flight didn't go through, so it's not booked and not charged",
        "i stopped there: Jordan, Priya, Sam weren't booked, nothing charged for them",
        "@ me and i'll look again",
      ].join('\n'),
    );
    // The grant is spent: another tap orders nothing more.
    await h.tap('h_henry', msg.id, 'approve');
    expect(flights.orders).toHaveLength(3);
    expect(auditCore.verifyAuditChain(h.audit()).ok).toBe(true);
  });

  it('partialFlightsText: the refused order, the unsent ones, and no "no charge" promise after an outage', () => {
    const t = (over: Partial<Parameters<typeof partialFlightsText>[0]>) =>
      partialFlightsText({
        failed: 'Sam',
        failedCount: 1,
        notSent: '',
        notSentCount: 0,
        errorCode: 'sold_out',
        ...over,
      });
    expect(t({})).toBe(
      "Sam's flight didn't go through, so it's not booked and not charged\n@ me and i'll look again",
    );
    expect(t({ failed: 'James', notSent: 'Henry', notSentCount: 1 })).toBe(
      "James' flight didn't go through, so it's not booked and not charged\ni stopped there: Henry wasn't booked, nothing charged for them\n@ me and i'll look again",
    );
    // A timeout or outage may have landed at the airline: never "not charged".
    const unsure = t({ errorCode: 'provider_unavailable' });
    expect(unsure).toBe(
      "Sam's flight didn't confirm, so check with the airline before rebooking\n@ me and i'll look again",
    );
    expect(unsure).not.toMatch(/not charged/);
    expect(t({ failed: 'Priya, Sam', failedCount: 2 })).toMatch(
      /^flights for Priya, Sam didn't go through, so they're not booked/,
    );
  });
});

describe('search_flights group form (the tool)', () => {
  const tool = createSearchFlightsTool(
    createMockFlights({ clock: createSimulatedClock(PLANNING) }),
  );

  it('validates the travelers: IATA codes, a member each, dates in order', () => {
    const base = { destination: 'BCN', date: '2026-03-12', returnDate: '2026-03-17' };
    expect(
      tool.parse({ ...base, travelers: [{ member: 'Dean', origin: 'bos', returnTo: 'jfk' }] }),
    ).toEqual({
      form: 'group',
      ...base,
      travelers: [{ member: 'Dean', origin: 'BOS', returnTo: 'JFK' }],
    });
    for (const bad of [
      { ...base, travelers: [] },
      { ...base, travelers: [{ member: 'Dean', origin: 'BOSTON' }] },
      { ...base, travelers: [{ member: '', origin: 'BOS' }] },
      { ...base, travelers: [{ member: 'Dean', origin: 'BCN' }] },
      { ...base, returnDate: '2026-03-01', travelers: [{ member: 'Dean', origin: 'BOS' }] },
      { ...base, travelers: Array.from({ length: 13 }, () => ({ member: 'Dean', origin: 'BOS' })) },
    ]) {
      expect(() => tool.parse(bad)).toThrow();
    }
    // The single form still needs its origin.
    expect(() => tool.parse({ destination: 'BCN', date: '2026-03-12' })).toThrow();
    expect(tool.parse({ origin: 'BOS', destination: 'BCN', date: '2026-03-12' })).toMatchObject({
      form: 'single',
      origin: 'BOS',
    });
  });

  it('a member listed twice, or someone not on the trip, is refused; the DM lane posts nothing', async () => {
    const { h } = planning();
    const ctx = {
      groupId: G,
      tripId: T,
      senderMemberId: 'mem_dean',
      senderId: 'h_dean',
      lane: 'group' as const,
      now: h.clock.now(),
      clock: h.clock,
      ids: h.ids,
      stores: h.runtime.stores,
    };
    const run = (input: unknown, lane: 'group' | 'dm' = 'group') =>
      h.runtime.tools.run('search_flights', input, { ...ctx, lane });
    const base = { destination: 'BCN', date: '2026-03-12', returnDate: '2026-03-17' };
    await expect(
      run({
        ...base,
        travelers: [
          { member: 'Dean', origin: 'BOS' },
          { member: 'mem_dean', origin: 'JFK' },
        ],
      }),
    ).rejects.toThrow(/twice/);
    await expect(run({ ...base, travelers: [{ member: 'Ava', origin: 'BOS' }] })).rejects.toThrow(
      /no member/,
    );
    const dm = await run({ ...base, travelers: [{ member: 'Dean', origin: 'BOS' }] }, 'dm');
    expect(dm).toMatchObject({ kind: 'unavailable', reason: 'wrong_lane' });
  });
});
