/**
 * T-132: a place to stay in chat. The offline ask searches, proposes the
 * refundable rate through `propose_booking`, every payer approves, a relayed
 * approval counts for nothing, and the last payer's 👍 books it once and
 * splits it exactly (SAFETY §2.1, §2.5; VOICE §4.1 C).
 */
import { describe, expect, it } from 'vitest';
import type { BookingProposal, Member, OutboundMessage, PolicyDecision } from '@trav/core';
import {
  audit as auditCore,
  createDeterministicIdGenerator,
  createSimulatedClock,
  isReaction,
  money,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type { LodgingSearchResult } from '@trav/adapters';
import { createMockLodging, createMockTickets, loadTicketInventory } from '@trav/adapters';
import { seedBarcelona } from '../compose.js';
import type { TurnResult } from '../loop.js';
import { harness, type Harness } from '../runtime.testkit.js';
import {
  areaOf,
  cheapestLockedBelow,
  createProposalService,
  hasFamilyName,
  renderLodgingText,
  resolveParty,
  shortDate,
  stayDates,
  type ProposeInput,
} from './proposals.js';
import { leadGuestOf } from './executor.js';

const G = 'grp_barcelona';
const T = 'trip_barcelona';
const PLANNING = '2026-02-03T20:31:00+01:00';
const ASK =
  'ok now a place. @trav find a 6 person airbnb in eixample or gracia, under €1500 total, refundable pls';
const EIXAMPLE = 'rate_bcn_eixample_3br_flex';
const SIX = ['mem_dean', 'mem_henry', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'];

function group(r: TurnResult): OutboundMessage[] {
  return r.outbound.filter((o): o is OutboundMessage => !isReaction(o) && o.to.kind === 'group');
}

function planning(): Harness {
  const h = harness();
  h.clock.set(PLANNING);
  return h;
}

function stays(h: Harness) {
  return h.runtime.stores.group.bookings.listByTrip(T).filter((b) => b.kind === 'lodging');
}

async function ask(h: Harness, text = ASK) {
  const turn = await h.say('h_dean', text);
  const proposal = h.pending().find((p) => p.kind === 'lodging');
  const card = group(turn).find((m) => m.card?.type === 'booking_proposal');
  return { turn, proposal, card };
}

describe('lodging ask in chat (T-132)', () => {
  it('proposes the refundable Eixample rate for all 6 through the policy, and buys nothing', async () => {
    const h = planning();
    const { turn, proposal, card } = await ask(h);
    expect(turn.toolCalls).toEqual(['search_lodging', 'propose_booking']);
    const asked = h.model.responses
      .flatMap((r) => r.toolCalls)
      .find((c) => c.name === 'propose_booking');
    expect(asked?.input).toEqual({ kind: 'lodging', itemRef: EIXAMPLE });
    expect(proposal).toMatchObject({
      kind: 'lodging',
      provider: 'mock-lodging',
      itemRef: EIXAMPLE,
      totalMinor: 138000,
      currency: 'EUR',
      attendees: SIX,
      payers: SIX.map((memberId) => ({ memberId, shareMinor: 23000 })),
      paidBy: { kind: 'member_card', memberId: 'mem_dean' },
      refundable: true,
      refundDeadline: '2026-03-07T23:59:00+01:00',
      eventDate: '2026-03-12',
    });
    const p = proposal!;
    expect(p.payers.reduce((s, x) => s + x.shareMinor, 0)).toBe(p.totalMinor);
    const decision = h.runtime.stores.group.bookings.getDecision(p.proposalId)!.decision;
    expect(decision.outcome).toBe('needs_confirmation');
    expect(decision.approvalMode).toBe('each_payer');
    expect(decision.reasons).toContain('kind_requires_each_payer');
    expect(decision.requiredApprovers).toEqual(SIX);
    expect(h.auditTypes()).toEqual(
      expect.arrayContaining(['proposal.created', 'policy.evaluated', 'approval.requested']),
    );
    expect(card?.card).toMatchObject({
      type: 'booking_proposal',
      category: 'lodging',
      total: money(138000, 'EUR'),
      refundable: true,
      policy: { approvalMode: 'each_payer' },
    });
    expect(card?.text).toBe(
      [
        'found a place for 6: Eixample 3BR with balcony, mar 12–17',
        '€1,380 for 5 nights · €230 each · free cancel until mar 7',
        "there's a €1,190 one in Poblenou but it's non-refundable, so i'd go with this",
        "Dean, Henry, Maya, Jordan, Priya, Sam · on Dean's card, split 6 ways on the tab",
        'lodging is on everyone paying, so all 6 of you have to 👍',
        '👍 to book, or say "not me" first. open for 15 min',
      ].join('\n'),
    );
    // The seeded lodging plan is reused, not duplicated.
    const plans = h.runtime.stores.group.trips
      .listActivities(T)
      .filter((a) => a.kind === 'lodging');
    expect(plans).toHaveLength(1);
    expect(p.activityId).toBe(plans[0]!.activityId);
    expect(stays(h)).toHaveLength(0);
  });

  it("5 payers' 👍 and Jordan's relayed approval book nothing; Henry's own 👍 books once and splits €230 each", async () => {
    const h = planning();
    const { card } = await ask(h);
    const cardId = card!.id;
    for (const who of ['h_dean', 'h_jordan', 'h_sam', 'h_priya', 'h_maya']) {
      const t = await h.react(who, cardId, '👍');
      expect(t.note).toBe('approval:handled');
      expect(stays(h)).toHaveLength(0);
    }
    const relay = await h.say(
      'h_jordan',
      "henry's at practice, i'll approve for him. go ahead trav",
    );
    expect(relay.note).toBe('approval:claimed_for_other');
    expect(group(relay)).toHaveLength(0);
    const invalid = h
      .audit()
      .filter((e) => e.type === 'approval.invalid_attempt')
      .at(-1);
    expect(invalid?.payload).toMatchObject({ cause: 'claimed_for_other', claimedFor: 'mem_henry' });
    expect(stays(h)).toHaveLength(0);

    const done = await h.react('h_henry', cardId, '👍');
    expect(done.note).toBe('approval:handled');
    expect(group(done)[0]!.text).toMatch(/^booked ✅ eixample 3br with balcony, €1,380\n/);
    expect(group(done)[0]!.text).toContain('Henry, Maya, Jordan, Priya, Sam → Dean €230');
    expect(stays(h)).toHaveLength(1);
    const expense = h.runtime.stores.group.expenses
      .listByTrip(T)
      .find((e) => e.category === 'lodging')!;
    expect(expense.amount).toEqual(money(138000, 'EUR'));
    expect(expense.split).toEqual({ method: 'equal', participants: SIX });
    const owes = h.runtime.stores.group.expenses
      .listEntries(T)
      .filter((e) => e.expenseId === expense.expenseId && e.kind === 'owes');
    expect(owes.map((e) => [e.memberId, e.amount.amountMinor])).toEqual(
      SIX.map((id) => [id, 23000]),
    );
    const types = h.auditTypes();
    const at = (t: string) => types.indexOf(t);
    expect(at('policy.evaluated')).toBeLessThan(at('approval.granted'));
    expect(at('booking.attempted')).toBeLessThan(at('booking.completed'));
    expect(at('booking.completed')).toBeLessThan(at('ledger.written'));
    expect(auditCore.verifyAuditChain(h.runtime.stores.group.audit.listByGroup(G)).ok).toBe(true);
    // A second 👍 buys nothing more.
    await h.react('h_henry', cardId, '👍');
    expect(stays(h)).toHaveLength(1);

    // Another stay later gets its own plan, for everyone again (the booked plan is done).
    const second = await ask(
      h,
      '@trav find a 6 person airbnb in gracia, under €2000 total, refundable',
    );
    expect(second.proposal).toMatchObject({ itemRef: 'rate_bcn_gracia_flex', attendees: SIX });
    expect(second.proposal!.activityId).not.toBe(expense.activityId ?? 'none');
    const plans = h.runtime.stores.group.trips
      .listActivities(T)
      .filter((a) => a.kind === 'lodging');
    expect(plans).toHaveLength(2);
  });

  it('asking again while it waits does not post a second card', async () => {
    const h = planning();
    await ask(h);
    const again = await h.say('h_dean', ASK);
    expect(h.pending().filter((p) => p.kind === 'lodging')).toHaveLength(1);
    expect(group(again)[0]?.text).toBe("that one's already waiting for a 👍 above");
  });

  it('a stay that has started is not bookable: no proposal, no charge', async () => {
    const h = harness(); // mar 14, mid-trip
    const { turn, proposal } = await ask(h);
    expect(proposal).toBeUndefined();
    expect(group(turn)[0]?.text).toMatch(/nothing's booked|nothing fits/);
    expect(stays(h)).toHaveLength(0);
  });
});

describe('lodging helpers (T-132)', () => {
  const m = (memberId: string, displayName: string): Member => ({
    memberId,
    groupId: G,
    displayName,
    role: 'member',
    active: true,
    senderId: `h_${memberId}`,
    ageBand: 'adult',
    joinedAt: PLANNING,
  });
  const members = [m('a', 'Ana'), m('b', 'Ben'), m('c', 'Cy')];
  const byId = new Map(members.map((x) => [x.memberId, x] as const));
  const order = members.map((x) => x.memberId);
  const party = (input: Parameters<typeof resolveParty>[0]['input'], markedOut: string[] = []) =>
    resolveParty({
      input,
      active: members,
      byId,
      order,
      base: order,
      markedOut: new Set(markedOut),
    });

  it('resolveParty: everyone, minus the named out; a named subset; unknown names and empty ask one question', () => {
    expect(party({})).toEqual({ kind: 'party', attendees: ['a', 'b', 'c'] });
    expect(party({ excludedNames: ['ben'] })).toEqual({ kind: 'party', attendees: ['a', 'c'] });
    expect(party({ attendeeNames: ['Cy', 'Ana'] })).toEqual({
      kind: 'party',
      attendees: ['a', 'c'],
    });
    expect(party({ attendeeNames: ['Cy', 'Ana'] }, ['c'])).toEqual({
      kind: 'party',
      attendees: ['a'],
    });
    expect(party({ excludedNames: ['zed'] })).toMatchObject({
      kind: 'clarify',
      problems: ['unknown_name:zed'],
    });
    expect(party({ quantity: 2 })).toMatchObject({
      kind: 'clarify',
      problems: ['quantity_not_roster'],
    });
    expect(party({ excludedNames: ['ana', 'ben', 'cy'] })).toMatchObject({
      kind: 'clarify',
      problems: ['empty_roster'],
    });
  });

  it('dates and areas', () => {
    expect(shortDate('2026-03-07')).toBe('mar 7');
    expect(stayDates('2026-03-12', '2026-03-17')).toBe('mar 12–17');
    expect(stayDates('2026-03-30', '2026-04-02')).toBe('mar 30–apr 2');
    expect(areaOf("Carrer d'Aragó 255, Eixample")).toBe('Eixample');
    expect(areaOf('Somewhere')).toBeUndefined();
    expect(areaOf(undefined)).toBeUndefined();
  });

  it('cheapestLockedBelow: only cheaper, non-refundable (or past its deadline), same currency', () => {
    const rate = (id: string, minor: number, refundable: boolean, until?: string) => ({
      rateId: id,
      propertyId: `p_${id}`,
      roomName: 'whole',
      sleeps: 6,
      totalAmount: money(minor, 'EUR'),
      refundPolicy: { refundable, ...(until !== undefined ? { refundableUntil: until } : {}) },
      needsRecheck: false,
    });
    const res = (id: string, address: string, r: ReturnType<typeof rate>): LodgingSearchResult =>
      ({
        property: { propertyId: `p_${id}`, name: id, place: { address } },
        rates: [r],
      }) as unknown as LodgingSearchResult;
    const now = PLANNING;
    const results = [
      res('x', 'a, Poblenou', rate('x', 119000, false)),
      res('y', 'b, Gràcia', rate('y', 100000, true, '2026-01-01T00:00:00+01:00')),
      res('z', 'c, Sants', rate('z', 150000, false)),
    ];
    expect(cheapestLockedBelow(results, 138000, 'EUR', now)).toEqual({
      total: money(100000, 'EUR'),
      area: 'Gràcia',
    });
    expect(cheapestLockedBelow(results.slice(2), 138000, 'EUR', now)).toBeUndefined();
    expect(cheapestLockedBelow(results, 138000, 'USD', now)).toBeUndefined();
  });

  it('renderLodgingText: uneven shares say ≈, a non-refundable stay names no trade-off, one approver is named', () => {
    const p: BookingProposal = {
      proposalId: 'prop_1',
      groupId: G,
      tripId: T,
      kind: 'lodging',
      provider: 'mock-lodging',
      itemRef: 'r',
      description: 'Flat',
      totalMinor: 100000,
      currency: 'EUR',
      quotedAt: PLANNING,
      quoteRef: 'r',
      payers: [
        { memberId: 'a', shareMinor: 33334 },
        { memberId: 'b', shareMinor: 33333 },
        { memberId: 'c', shareMinor: 33333 },
      ],
      attendees: ['a', 'b', 'c'],
      paidBy: { kind: 'member_card', memberId: 'a' },
      refundable: false,
      eventDate: '2026-03-12',
      ageRestriction: null,
      contentTags: [],
      requestedBy: 'a',
      requestedAt: PLANNING,
      sourceMessageId: 'm',
      idempotencyKey: 'k',
      status: 'pending',
    };
    const decision = {
      outcome: 'needs_confirmation',
      approvalMode: 'any_one',
      requiredApprovers: ['b'],
      reasons: ['non_refundable'],
      expiresAt: '2026-02-03T20:46:00+01:00',
    } as unknown as PolicyDecision;
    const text = renderLodgingText({
      proposal: p,
      decision,
      members,
      excluded: [],
      name: 'Flat',
      checkIn: '2026-03-12',
      checkOut: '2026-03-13',
      now: PLANNING,
      tz: 'Europe/Madrid',
      capPerPersonMinor: 6000,
      cheaperLocked: { total: money(50000, 'EUR'), area: 'X' },
    });
    expect(text.split('\n')).toEqual([
      'found a place for 3: Flat, mar 12–13',
      '€1,000 for 1 night · ≈€333.33 each · non-refundable',
      "Ana, Ben, Cy · on Ana's card, split 3 ways on the tab",
      '👍 from Ben to book, or anyone can say "not me" first. open for 15 min',
    ]);
  });

  it('leadGuestOf: a family name only when the display name has one, never invented', () => {
    expect(leadGuestOf(m('a', 'Dean'))).toEqual({ memberId: 'a', givenName: 'Dean' });
    expect(leadGuestOf(m('a', 'Dean Yao'))).toEqual({
      memberId: 'a',
      givenName: 'Dean',
      familyName: 'Yao',
    });
    expect(leadGuestOf(m('a', '  '))).toBeUndefined();
    expect(hasFamilyName(m('a', 'Dean'))).toBe(false);
    expect(hasFamilyName(m('a', 'Dean Yao'))).toBe(true);
    expect(hasFamilyName(undefined)).toBe(false);
  });
});

describe('proposal service, lodging (T-132)', () => {
  function service(opts: { lodging?: boolean; fullNames?: boolean } = {}) {
    const clock = createSimulatedClock(PLANNING);
    const ids = createDeterministicIdGenerator('l');
    const stores = createMemoryStores({ clock, ids });
    seedBarcelona(stores);
    if (opts.fullNames === true) {
      for (const x of stores.group.members.listByGroup(G)) {
        stores.group.members.upsert({ ...x, displayName: `${x.displayName} Testperson` });
      }
    }
    const lodging = createMockLodging({ clock });
    const tickets = createMockTickets({ clock, ids, inventory: loadTicketInventory('barcelona') });
    const svc = createProposalService({
      stores,
      tickets,
      clock,
      ids,
      ...(opts.lodging === false ? {} : { lodging }),
    });
    let n = 0;
    const propose = (input: Omit<ProposeInput, 'kind'>) =>
      svc.propose(
        { kind: 'lodging', ...input },
        { groupId: G, tripId: T, requestedBy: 'mem_dean', sourceMessageId: `m${String((n += 1))}` },
      );
    return { svc, stores, lodging, propose };
  }

  it('everyone but Henry: 5 payers at €276, Henry out of the plan, the card says so', async () => {
    const s = service();
    const res = await s.propose({ itemRef: EIXAMPLE, excludedNames: ['Henry'] });
    expect(res.kind).toBe('proposal');
    if (res.kind !== 'proposal') return;
    const five = SIX.filter((id) => id !== 'mem_henry');
    expect(res.proposal.payers).toEqual(five.map((memberId) => ({ memberId, shareMinor: 27600 })));
    expect(res.excluded).toEqual(['mem_henry']);
    expect(res.text).toContain('€1,380 for 5 nights · €276 each');
    expect(res.text).toContain('Dean, Maya, Jordan, Priya, Sam (not Henry)');
    expect(res.card.excluded).toEqual([{ memberId: 'mem_henry', name: 'Henry' }]);
    expect(res.card.item.details).toContain('€105 paid at the property, not charged by trav');
    const rows = s.stores.group.trips.listAttendance(res.proposal.activityId!);
    expect(rows.find((r) => r.memberId === 'mem_henry')?.status).toBe('out');
    expect(s.lodging.bookingCount()).toBe(0);
  });

  it('no rate, an unknown rate, a sold-out rate: one honest line, no proposal, no audit', async () => {
    const s = service();
    const none = await s.propose({});
    expect(none).toMatchObject({ kind: 'unavailable', reason: 'not_found' });
    const unknown = await s.propose({ itemRef: 'rate_nope' });
    expect(unknown).toMatchObject({ kind: 'unavailable', reason: 'not_found' });
    const gone = await s.propose({ itemRef: 'rate_bcn_santantoni_flex' });
    expect(gone).toMatchObject({ kind: 'unavailable', reason: 'sold_out' });
    if (gone.kind === 'unavailable') expect(gone.text).toMatch(/nothing's booked, no charge/);
    expect(s.stores.group.audit.listByGroup(G)).toHaveLength(0);
  });

  it('a re-priced rate is quoted at the new price, never the old one', async () => {
    const s = service();
    const res = await s.propose({ itemRef: 'rate_bcn_gracia_flex' });
    expect(res.kind).toBe('proposal');
    if (res.kind !== 'proposal') return;
    expect(res.proposal.totalMinor).toBe(172000);
    expect(res.text).toContain('€1,720');
  });

  it('a hotel needs the lead guest’s family name: refused up front with first names only, proposed with full names', async () => {
    const first = service();
    const refused = await first.propose({ itemRef: 'rate_bcn_hotel_2triples' });
    expect(refused).toMatchObject({ kind: 'unavailable' });
    if (refused.kind === 'unavailable')
      expect(refused.text).toMatch(/^a hotel needs the lead guest's full name/);
    expect(first.stores.group.audit.listByGroup(G)).toHaveLength(0);
    const full = service({ fullNames: true });
    const ok = await full.propose({ itemRef: 'rate_bcn_hotel_2triples' });
    expect(ok.kind).toBe('proposal');
  });

  it('over the hard per-booking max: denied by the policy and audited, nothing proposed to tap', async () => {
    const s = service();
    const res = await s.propose({ itemRef: 'rate_bcn_penthouse_flex' });
    expect(res.kind).toBe('denied');
    const types = s.stores.group.audit.listByGroup(G).map((e) => e.type);
    expect(types).toContain('policy.evaluated');
    expect(types).not.toContain('approval.requested');
  });

  it('a re-quote ("not me") keeps the same rate and re-splits it', async () => {
    const s = service();
    const first = await s.propose({ itemRef: EIXAMPLE });
    if (first.kind !== 'proposal') throw new Error(first.kind);
    s.stores.group.bookings.updateProposal({ ...first.proposal, status: 'superseded' });
    const again = await s.svc.repropose(
      first.proposal,
      SIX.filter((id) => id !== 'mem_sam'),
      'm_not_me',
    );
    expect(again.kind).toBe('proposal');
    if (again.kind !== 'proposal') return;
    expect(again.proposal.itemRef).toBe(EIXAMPLE);
    expect(again.proposal.payers.every((p) => p.shareMinor === 27600)).toBe(true);
  });

  it('without a lodging adapter, stays stay unsupported', async () => {
    const s = service({ lodging: false });
    expect(await s.propose({ itemRef: EIXAMPLE })).toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported_kind',
    });
  });
});
