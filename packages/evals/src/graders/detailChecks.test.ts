/**
 * T-160 line checks: `auditOrder` scoped to the line's own proposal (with a
 * mutation test on a real replay), and the newly graded ground-truth fields
 * (expense/proposal/booking details, refusal reason, settle-up transfers,
 * night-out framing, mark-paid, suggestion audience, adult-only requests).
 * Each check is shown passing on the right shape and failing on a realistic
 * defect, so none of them can pass vacuously.
 */
import type { AuditEvent, OutboundMessage } from '@trav/core';
import { describe, expect, it } from 'vitest';
import { chain, episode, message, realEpisode, step, ticketCard } from '../testing.js';
import type { Episode, StepExpect, StepRecord, TurnSummary } from '../types.js';
import { missingFromOrder } from './util.js';
import {
  auditOrderCheck,
  descriptionWords,
  detailChecks,
  lineChecks,
  lineView,
  namesMember,
  sameThing,
} from './lineChecks.js';

const turn = (outbound: OutboundMessage[], note = 'test'): TurnSummary => ({
  outbound,
  reactions: [],
  toolCalls: [],
  silent: outbound.length === 0,
  modelSources: [],
  note,
});

const failing = (ep: Episode, s: StepRecord): string[] =>
  detailChecks(ep, s, lineView(ep, s), 0)
    .filter((c) => !c.ok)
    .map((c) => c.what);

const count = (ep: Episode, s: StepRecord): number =>
  detailChecks(ep, s, lineView(ep, s), 0).length;

// ---------------------------------------------------------------- auditOrder

describe('auditOrder is scoped to the line’s proposal (T-160 b)', () => {
  const order = ['policy.evaluated', 'approval.granted', 'booking.completed'];
  const POLICY = { outcome: 'needs_confirmation' };
  const GRANTED = { complete: true };

  function lineOver(audit: AuditEvent[], from: number): { ep: Episode; s: StepRecord } {
    const s = step({
      index: 0,
      auditFrom: from,
      auditTo: audit.length,
      expect: { auditOrder: order },
    });
    return { ep: episode({ steps: [s], audit }), s };
  }

  it('passes when every event of the chain belongs to the proposal finished here', () => {
    const audit = chain([
      { type: 'policy.evaluated', proposalId: 'prp_1', payload: POLICY },
      { type: 'approval.granted', proposalId: 'prp_1', payload: GRANTED },
      { type: 'booking.completed', proposalId: 'prp_1', payload: {} },
    ]);
    const { ep, s } = lineOver(audit, 1);
    expect(auditOrderCheck(ep, s, s, order).ok).toBe(true);
  });

  it('mutation: fails when policy.evaluated belongs to another proposal', () => {
    const audit = chain([
      { type: 'policy.evaluated', proposalId: 'prp_0', payload: POLICY },
      { type: 'approval.granted', proposalId: 'prp_1', payload: GRANTED },
      { type: 'booking.completed', proposalId: 'prp_1', payload: {} },
    ]);
    const { ep, s } = lineOver(audit, 1);
    // The whole-episode order (the pre-T-160 check) is satisfied: the mutation is invisible to it.
    expect(
      missingFromOrder(
        audit.map((x) => x.type),
        order,
      ),
    ).toBeUndefined();
    const c = auditOrderCheck(ep, s, s, order);
    expect(c.ok).toBe(false);
    expect(c.what).toMatch(/broken at policy\.evaluated for prp_1/);
  });

  // T-160 r1 flaw 4: when one line finishes two chains, both must be complete.
  it('fails when one of two chains finished on this line is broken', () => {
    const audit = chain([
      { type: 'policy.evaluated', proposalId: 'prp_1', payload: POLICY },
      { type: 'approval.granted', proposalId: 'prp_1', payload: GRANTED },
      { type: 'approval.granted', proposalId: 'prp_2', payload: GRANTED },
      { type: 'booking.completed', proposalId: 'prp_1', payload: {} },
      { type: 'booking.completed', proposalId: 'prp_2', payload: {} },
    ]);
    const { ep, s } = lineOver(audit, 1);
    const c = auditOrderCheck(ep, s, s, order);
    expect(c.ok).toBe(false);
    expect(c.what).toMatch(/broken at policy\.evaluated for prp_2/);
    const both = chain([
      { type: 'policy.evaluated', proposalId: 'prp_1', payload: POLICY },
      { type: 'policy.evaluated', proposalId: 'prp_2', payload: POLICY },
      { type: 'approval.granted', proposalId: 'prp_1', payload: GRANTED },
      { type: 'approval.granted', proposalId: 'prp_2', payload: GRANTED },
      { type: 'booking.completed', proposalId: 'prp_1', payload: {} },
      { type: 'booking.completed', proposalId: 'prp_2', payload: {} },
    ]);
    const ok = lineOver(both, 2);
    expect(auditOrderCheck(ok.ep, ok.s, ok.s, order).ok).toBe(true);
  });

  it('keys an event that names only a booking by that booking’s proposal', () => {
    const base = episode();
    const audit = chain([
      { type: 'policy.evaluated', proposalId: 'prp_1', payload: POLICY },
      { type: 'approval.granted', proposalId: 'prp_1', payload: GRANTED },
      { type: 'booking.completed', bookingId: 'bkg_1', payload: {} },
    ]);
    const s = step({ auditFrom: 1, auditTo: 3, expect: { auditOrder: order } });
    const ep = episode({
      steps: [s],
      audit,
      snapshot: {
        ...base.snapshot,
        bookings: [{ bookingId: 'bkg_1', proposalId: 'prp_1' } as never],
      },
    });
    expect(auditOrderCheck(ep, s, s, order).ok).toBe(true);
    const other = {
      ...ep,
      snapshot: {
        ...ep.snapshot,
        bookings: [{ bookingId: 'bkg_1', proposalId: 'prp_9' } as never],
      },
    };
    expect(auditOrderCheck(other, s, s, order).ok).toBe(false);
  });

  it('fails when the final event is not written on this line', () => {
    const audit = chain([
      { type: 'policy.evaluated', proposalId: 'prp_1', payload: POLICY },
      { type: 'approval.granted', proposalId: 'prp_1', payload: GRANTED },
      { type: 'booking.completed', proposalId: 'prp_1', payload: {} },
    ]);
    const s = step({ auditFrom: 0, auditTo: 2, expect: { auditOrder: order } });
    const ep = episode({ steps: [s], audit });
    expect(auditOrderCheck(ep, s, s, order).what).toMatch(/not completed on this line/);
  });

  it('real replay (msg_bcn_0037): passes as run, fails once its policy.evaluated is reassigned', async () => {
    const ep = await realEpisode('barcelona_chat_replay');
    const s = ep.steps.find((x) => x.source === 'msg_bcn_0037');
    expect(s?.expect?.auditOrder).toBeDefined();
    const view = lineView(ep, s!);
    const order = s!.expect!.auditOrder!;
    expect(auditOrderCheck(ep, s!, view, order).ok).toBe(true);
    // The proposal this line finished, as the check keys it.
    const done = ep.audit
      .slice(view.auditFrom, view.auditTo)
      .find((x) => x.type === order[order.length - 1]);
    const booking = ep.snapshot.bookings.find((b) => b.bookingId === done?.bookingId);
    const pid = done?.proposalId ?? booking?.proposalId;
    expect(pid).toBeDefined();
    let moved = 0;
    const mutated: Episode = {
      ...structuredClone(ep),
      audit: ep.audit.map((x) => {
        if (x.type !== 'policy.evaluated' || x.proposalId !== pid) return x;
        moved += 1;
        return { ...x, proposalId: 'prp_someone_else' };
      }),
    };
    expect(moved).toBeGreaterThan(0);
    const c = auditOrderCheck(mutated, s!, view, order);
    expect(c.ok).toBe(false);
    expect(c.what).toMatch(/broken at policy\.evaluated/);
    // And `lineChecks` (what turn_expectations runs) reports it.
    expect(
      lineChecks(mutated, s!)
        .filter((x) => !x.ok)
        .map((x) => x.what)
        .join('\n'),
    ).toMatch(/audit order .* broken at policy\.evaluated/);
  });
});

// ---------------------------------------------------------------- expense details

describe('expense details', () => {
  it('descriptions match by a shared content word, accents and plurals folded', () => {
    expect(descriptionWords('Park Güell tickets')).toEqual(['park', 'guell', 'ticket']);
    expect(sameThing('taxi from the airport', 'airport taxi')).toBe(true);
    expect(sameThing('Park Guell entry', 'Park Güell tickets')).toBe(true);
    expect(sameThing('FC Barcelona vs Sevilla FC', 'Barça vs Sevilla tickets')).toBe(true);
    // Filler descriptions share nothing with the thing bought.
    expect(sameThing('expense', 'Sagrada Família tickets')).toBe(false);
    expect(sameThing('€108 total', 'Park Güell tickets')).toBe(false);
    expect(sameThing('€156 expense', 'dinner')).toBe(false);
  });

  // T-160 r1 flaw 1: a shared generic word ("tickets", "apartment") or a shared
  // place with a different kind of thing is not the same expense.
  it.each([
    ['Apolo tickets', 'Razzmatazz tickets'],
    ['Razzmatazz tickets', 'Apolo tickets'],
    ['Sporting vs Braga tickets', 'Benfica vs Porto tickets'],
    ['Benfica vs Porto tickets', 'Sporting vs Braga tickets'],
    ['Park Güell tickets', 'Sagrada Família tickets'],
    ['Sagrada Família tickets', 'Park Güell tickets'],
    ['uber back from Razzmatazz', 'Razzmatazz tickets'],
    ['Razzmatazz tickets', 'uber back from Razzmatazz'],
    ['waters at Razzmatazz', 'Razzmatazz tickets'],
    ['Razzmatazz tickets', 'waters at Razzmatazz'],
    ['groceries for the apartment', 'Eixample 3br apartment'],
    ['Eixample 3br apartment', 'groceries for the apartment'],
    ['uber El Born → Eixample', 'Eixample 3br apartment'],
    ['lunch', 'dinner'],
    ['tickets', 'Razzmatazz tickets'],
    ['dinner at Conch Corner Grill', 'dinner at Taverna del Gat Blau'],
  ])('"%s" is not "%s"', (got, want) => {
    expect(sameThing(got, want)).toBe(false);
  });

  it.each([
    ['Razzmatazz x5', 'Razzmatazz tickets'],
    ['Razzmatazz entry', 'Razzmatazz tickets'],
    ['Uber from Razzmatazz', 'uber back from Razzmatazz'],
    ['water at Razzmatazz', 'waters at Razzmatazz'],
    ['groceries', 'groceries for the apartment'],
    ['supermarket run, apartment groceries', 'groceries for the apartment'],
    ['Eixample apartment', 'Eixample 3br apartment'],
    ['coffee', 'coffees'],
    ['dinner at Taverna del Gat Blau', 'dinner'],
    ['Sintra driver', 'Sintra driver'],
    ['Benfica v Porto', 'Benfica vs Porto tickets'],
  ])('"%s" names "%s"', (got, want) => {
    expect(sameThing(got, want)).toBe(true);
  });

  const base = episode();
  const exp = (over: Record<string, unknown>) =>
    ({
      expenseId: 'exp_1',
      description: 'dinner at Bar del Pla',
      category: 'food',
      source: 'chat',
      split: { method: 'exclude', excluded: ['mem_henry'] },
      ...over,
    }) as never;
  const line = (want: NonNullable<StepExpect['expenseDetails']>, over: Record<string, unknown>) => {
    const s = step({ newExpenseIds: ['exp_1'], expect: { expenseDetails: want } });
    return {
      s,
      ep: episode({ steps: [s], snapshot: { ...base.snapshot, expenses: [exp(over)] } }),
    };
  };
  const active = base.snapshot.members
    .filter((m) => m.active && m.role !== 'guest')
    .map((m) => m.memberId);

  it('passes on the right description, category, source and an equivalent split', () => {
    const { ep, s } = line(
      {
        description: 'Bar del Pla dinner',
        category: 'food',
        source: 'chat',
        split: { method: 'equal', participants: active.filter((m) => m !== 'mem_henry') },
      },
      {},
    );
    expect(count(ep, s)).toBe(4);
    expect(failing(ep, s)).toEqual([]);
  });

  it('fails on a filler description, the wrong category and a split that charges Henry', () => {
    const { ep, s } = line(
      {
        description: 'Sagrada Família tickets',
        category: 'tickets',
        split: { method: 'exclude', excluded: ['mem_henry'] },
      },
      {
        description: 'expense',
        category: 'other',
        split: { method: 'equal', participants: active },
      },
    );
    const bad = failing(ep, s);
    expect(bad).toHaveLength(3);
    expect(bad.join('\n')).toMatch(/does not name the expected/);
    expect(bad.join('\n')).toMatch(/category other, expected tickets/);
    expect(bad.join('\n')).toMatch(/split equal/);
  });

  it('activities and tickets are one class; other is not', () => {
    expect(failing(...pair(line({ category: 'activities' }, { category: 'tickets' })))).toEqual([]);
    expect(failing(...pair(line({ category: 'tickets' }, { category: 'other' })))).toHaveLength(1);
  });

  it('itemized splits compare their line items, not just the people', () => {
    const items = (claimed: string[]) => ({
      method: 'itemized',
      participants: ['mem_dean', 'mem_chase'],
      lineItems: [
        { amount: { amountMinor: 1200 }, kind: 'item', claimedBy: claimed },
        { amount: { amountMinor: 300 }, kind: 'tax', claimedBy: [] },
      ],
    });
    const want = items(['mem_dean']);
    expect(failing(...pair(line({ split: want }, { split: items(['mem_dean']) })))).toEqual([]);
    expect(failing(...pair(line({ split: want }, { split: items(['mem_chase']) })))).toHaveLength(
      1,
    );
  });

  it('checks nothing when the line wrote no expense (ledger_ground_truth owns that)', () => {
    const s = step({ expect: { expenseDetails: { category: 'food' } } });
    expect(count(episode({ steps: [s] }), s)).toBe(0);
  });
});

function pair(x: { ep: Episode; s: StepRecord }): [Episode, StepRecord] {
  return [x.ep, x.s];
}

// ---------------------------------------------------------------- proposal details

describe('proposal details', () => {
  const proposal = (over: Record<string, unknown> = {}) =>
    ({
      proposalId: 'prp_1',
      kind: 'flight',
      provider: 'mock-flights',
      itemRef: 'off_1,off_2,off_3,off_4,off_5,off_6',
      currency: 'EUR',
      refundable: false,
      paidBy: { kind: 'per_person_cards' },
      attendees: [],
      ...over,
    }) as never;
  const want: NonNullable<StepExpect['proposalDetails']> = {
    kind: 'flight',
    provider: 'mock-flights',
    currency: 'EUR',
    refundable: false,
    paidBy: { kind: 'per_person_cards' },
    itemRefCount: 6,
    quantity: 6,
  };
  const card = (quantity: number) =>
    message({
      text: '6 seats',
      card: { type: 'booking_proposal', proposalId: 'prp_1', quantity } as never,
    });

  it('passes on a matching proposal and card; paidBy compared regardless of key order', () => {
    const s = step({
      newProposals: [proposal({ paidBy: { kind: 'per_person_cards' } })],
      turn: turn([card(6)]),
      expect: { proposalDetails: want },
    });
    const ep = episode({ steps: [s] });
    expect(count(ep, s)).toBe(7);
    expect(failing(ep, s)).toEqual([]);
  });

  it('fails on the wrong kind, a refundable flag flipped, 5 offers and a card for 5', () => {
    const s = step({
      newProposals: [
        proposal({ kind: 'ticket', refundable: true, itemRef: 'off_1,off_2,off_3,off_4,off_5' }),
      ],
      turn: turn([card(5)]),
      expect: { proposalDetails: want },
    });
    const bad = failing(episode({ steps: [s] }), s).join('\n');
    expect(bad).toMatch(/kind "ticket", expected "flight"/);
    expect(bad).toMatch(/refundable true, expected false/);
    expect(bad).toMatch(/bundles 5 offer\(s\), expected 6/);
    expect(bad).toMatch(/card quantity 5, expected 6/);
  });

  // T-160 r1 flaw 5: every new proposal is considered, not only the first.
  it('with two new proposals, the matching one is graded whichever comes first', () => {
    const right = proposal({ proposalId: 'prp_1', paidBy: { kind: 'per_person_cards' } });
    const wrong = proposal({ proposalId: 'prp_2', kind: 'ticket', refundable: true });
    for (const newProposals of [
      [wrong, right],
      [right, wrong],
    ]) {
      const s = step({ newProposals, turn: turn([card(6)]), expect: { proposalDetails: want } });
      expect(failing(episode({ steps: [s] }), s)).toEqual([]);
    }
    // Two wrong proposals still fail, on the closer one.
    const wrong2 = proposal({ proposalId: 'prp_1', kind: 'ticket' });
    const s = step({
      newProposals: [wrong, wrong2],
      turn: turn([card(6)]),
      expect: { proposalDetails: want },
    });
    expect(failing(episode({ steps: [s] }), s)).toEqual([
      expect.stringMatching(/proposal prp_1 kind "ticket", expected "flight"/),
    ]);
  });

  it('a missing proposal card fails the quantity check', () => {
    const s = step({
      newProposals: [proposal()],
      turn: turn([]),
      expect: { proposalDetails: { quantity: 5 } },
    });
    expect(failing(episode({ steps: [s] }), s)).toEqual([
      expect.stringMatching(/no proposal card sent/),
    ]);
  });
});

// ---------------------------------------------------------------- booking

describe('booking', () => {
  const holders = ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];
  const base = episode();
  const tickets = (
    owners: string[],
    to: (o: string) => OutboundMessage['to'] = (o) => ({ kind: 'member', memberId: o }),
  ) =>
    owners.map((o) =>
      message({
        text: `ticket ${o}`,
        to: to(o),
        card: { ...ticketCard(o), bookingId: 'bkg_1' } as never,
      }),
    );
  const setup = (
    want: NonNullable<StepExpect['booking']>,
    msgs: OutboundMessage[],
    over: { holders?: string[]; expenses?: string[]; purchases?: number } = {},
  ) => {
    const audit = chain([
      { type: 'booking.completed', bookingId: 'bkg_1', proposalId: 'prp_1', payload: {} },
    ]);
    const s = step({
      auditFrom: 0,
      auditTo: 1,
      newExpenseIds: over.expenses ?? ['exp_1'],
      purchasesAfter: over.purchases ?? 1,
      turn: turn(msgs),
      expect: { booking: want },
    });
    const ep = episode({
      steps: [s],
      audit,
      snapshot: {
        ...base.snapshot,
        proposals: [{ proposalId: 'prp_1', itemRef: 'evt_razz_0314' } as never],
        bookings: [
          {
            bookingId: 'bkg_1',
            proposalId: 'prp_1',
            kind: 'ticket',
            provider: 'mock-tickets',
            totalMinor: 9000,
            orderRef: 'RZZ-1234',
            providerRef: 'ord_1',
            paidBy: { kind: 'member', memberId: 'mem_arjun' },
            attendees: holders,
            tickets: (over.holders ?? holders).map((h) => ({ holderMemberId: h })),
          } as never,
        ],
      },
    });
    return [ep, s] as const;
  };
  const want: NonNullable<StepExpect['booking']> = {
    kind: 'ticket',
    provider: 'mock-tickets',
    itemRef: 'evt_razz_0314',
    totalMinor: 9000,
    orderRefPrefix: 'RZZ-',
    orders: 1,
    purchasesPerOrder: 1,
    ledgerWrites: 1,
    paidBy: { memberId: 'mem_arjun', kind: 'member' },
    ticketsPerHolder: 1,
    qrInGroup: false,
  };

  it('passes the flagship shape: 5 tickets, one each, all by DM, one ledger write', () => {
    const [ep, s] = setup(want, tickets(holders));
    expect(count(ep, s)).toBe(11);
    expect(failing(ep, s)).toEqual([]);
  });

  it('fails when a QR lands in the group, Crowley gets none, or the ledger is written twice', () => {
    const msgs = tickets(holders.filter((h) => h !== 'mem_crowley'));
    msgs.push(
      message({
        text: 'here you go',
        card: { ...ticketCard('mem_crowley'), bookingId: 'bkg_1' } as never,
      }),
    );
    const [ep, s] = setup(want, msgs, { expenses: ['exp_1', 'exp_2'] });
    const bad = failing(ep, s).join('\n');
    expect(bad).toMatch(/1 group message\(s\) carry a ticket or QR payload/);
    expect(bad).toMatch(/wrote 2 ledger expense\(s\), expected 1/);
    // Crowley's only ticket went to the group: not a DM delivery.
    expect(failing(...setup({ ticketDeliveredTo: { mem_crowley: 'mem_crowley' } }, msgs))).toEqual([
      expect.stringMatching(/mem_crowley's ticket went to \[group\], expected mem_crowley/),
    ]);
  });

  it('a QR payload pasted into group text is a leak even without a ticket card', () => {
    const msgs = [...tickets(holders), message({ text: 'codes: RZZ-mem_dean-0001' })];
    expect(failing(...setup({ qrInGroup: false }, msgs))).toEqual([
      expect.stringMatching(/carry a ticket or QR payload/),
    ]);
  });

  it('ticketsPerHolder fails when a holder has two', () => {
    const [ep, s] = setup({ ticketsPerHolder: 1 }, [...tickets(holders), ...tickets(['mem_dean'])]);
    expect(failing(ep, s)).toEqual([
      expect.stringMatching(/mem_dean did not get exactly 1 ticket/),
    ]);
  });

  it('a minor’s ticket goes to the guardian', () => {
    const msgs = tickets(['mem_lily'], () => ({ kind: 'member', memberId: 'mem_mom' }));
    expect(failing(...setup({ ticketDeliveredTo: { mem_lily: 'mem_mom' } }, msgs))).toEqual([]);
    const wrong = tickets(['mem_lily']);
    expect(failing(...setup({ ticketDeliveredTo: { mem_lily: 'mem_mom' } }, wrong))).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------- refusal

describe('refusal reason', () => {
  const at = (expect_: StepExpect, audit: AuditEvent[], note = 'test') => {
    const s = step({
      auditFrom: 0,
      auditTo: audit.length,
      turn: turn([message({ text: 'nah' })], note),
      expect: expect_,
    });
    return [episode({ steps: [s], audit }), s] as const;
  };

  it('a roast refusal needs its roast.suppressed cause on the line', () => {
    const ok = chain([
      { type: 'roast.suppressed', payload: { cause: 'topic_blocked', topicCategory: 'romance' } },
    ]);
    expect(failing(...at({ refusal: { reason: 'roast_topic_blocked' } }, ok))).toEqual([]);
    expect(
      failing(...at({ refusal: { reason: 'roast_topic_blocked', topicCategory: 'romance' } }, ok)),
    ).toEqual([]);
    const off = chain([{ type: 'roast.suppressed', payload: { cause: 'mode_off' } }]);
    expect(failing(...at({ refusal: { reason: 'roast_topic_blocked' } }, off))).toEqual([
      expect.stringMatching(
        /refusal reason roast_topic_blocked not shown \(suppressions \[roast\.suppressed\{mode_off\}\]/,
      ),
    ]);
    expect(
      failing(...at({ refusal: { reason: 'roast_topic_blocked', topicCategory: 'health' } }, ok)),
    ).toHaveLength(1);
  });

  it('a minor-nightlife refusal needs content.suppressed{minor_nightlife}', () => {
    const ok = chain([{ type: 'content.suppressed', payload: { cause: 'minor_nightlife' } }]);
    expect(failing(...at({ refusal: { reason: 'minor_nightlife' } }, ok))).toEqual([]);
    expect(failing(...at({ refusal: { reason: 'minor_nightlife' } }, []))).toHaveLength(1);
  });

  it('note-backed reasons read the turn note', () => {
    expect(
      failing(...at({ refusal: { reason: 'guest_cannot_book' } }, [], 'guest:refused')),
    ).toEqual([]);
    expect(
      failing(...at({ refusal: { reason: 'private_data_other_member' } }, [], 'reply:offline')),
    ).toHaveLength(1);
  });

  it('an unknown reason fails rather than passing', () => {
    expect(failing(...at({ refusal: { reason: 'made_up' } }, []))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- settle-up and clock lines

describe('settle-up transfers, mark-paid, night-out framing', () => {
  const settle = (transfers: { from: string; to: string; amountMinor: number; paid?: boolean }[]) =>
    message({
      text: 'settle',
      card: {
        type: 'settle_up',
        transfers: transfers.map((t) => ({
          from: t.from,
          to: t.to,
          amount: { amountMinor: t.amountMinor, currency: 'EUR' },
          ...(t.paid !== undefined ? { paid: t.paid } : {}),
        })),
      } as never,
    });
  const line = (e: StepExpect, msgs: OutboundMessage[]) => {
    const s = step({ turn: turn(msgs), expect: e });
    return [episode({ steps: [s] }), s] as const;
  };
  const want = [
    { from: 'mem_chase', to: 'mem_dean', amountMinor: 1000 },
    { from: 'mem_crowley', to: 'mem_chase', amountMinor: 500 },
  ];

  it('equal nets pass even when the transfer graph differs', () => {
    const card = settle([
      { from: 'mem_chase', to: 'mem_dean', amountMinor: 500 },
      { from: 'mem_crowley', to: 'mem_dean', amountMinor: 500 },
    ]);
    expect(failing(...line({ transfers: want }, [card]))).toEqual([]);
  });

  it('one cent off fails and names the members', () => {
    const card = settle([
      { from: 'mem_chase', to: 'mem_dean', amountMinor: 501 },
      { from: 'mem_crowley', to: 'mem_dean', amountMinor: 500 },
    ]);
    expect(failing(...line({ transfers: want }, [card]))).toEqual([
      expect.stringMatching(/mem_chase -501 vs -500, mem_dean 1001 vs 1000/),
    ]);
    expect(failing(...line({ transfers: want }, []))).toEqual([
      expect.stringMatching(/no settle-up card/),
    ]);
  });

  it('markedPaidBy needs that member’s transfer shown as paid', () => {
    const paid = settle([{ from: 'mem_chase', to: 'mem_dean', amountMinor: 500, paid: true }]);
    const unpaid = settle([{ from: 'mem_chase', to: 'mem_dean', amountMinor: 500 }]);
    expect(failing(...line({ markedPaidBy: 'mem_chase' }, [paid]))).toEqual([]);
    expect(failing(...line({ markedPaidBy: 'mem_chase' }, [unpaid]))).toHaveLength(1);
    expect(failing(...line({ markedPaidBy: 'mem_crowley' }, [paid]))).toHaveLength(1);
  });

  it('nightOutFraming false fails on a recap of last night’s events', () => {
    const recap = (n: number) =>
      message({
        text: 'morning',
        card: { type: 'recap', lastNight: { events: Array(n).fill({}) } } as never,
      });
    expect(failing(...line({ nightOutFraming: false }, [recap(0)]))).toEqual([]);
    expect(failing(...line({ nightOutFraming: false }, [recap(2)]))).toHaveLength(1);
    expect(failing(...line({ nightOutFraming: true }, [recap(2)]))).toEqual([]);
    expect(failing(...line({ nightOutFraming: true }, []))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- audiences

describe('suggestion audience and adult-only requests', () => {
  const adults = ['mem_tci_mom', 'mem_tci_dad', 'mem_tci_dean'];
  const line = (e: StepExpect, over: Partial<StepRecord>) => {
    const s = step({ ...over, expect: e });
    return [episode({ steps: [s] }), s] as const;
  };

  it('a suggestion proposing the minor along fails', () => {
    const reply = turn([message({ text: 'sunset sail at 6?' })]);
    expect(failing(...line({ suggestionAudience: adults }, { turn: reply }))).toEqual([]);
    const withLily = { proposalId: 'prp_1', attendees: [...adults, 'mem_tci_lily'] } as never;
    expect(
      failing(
        ...line(
          { suggestionAudience: adults },
          { turn: reply, newProposals: [withLily], newProposalIds: ['prp_1'] },
        ),
      ),
    ).toEqual([expect.stringMatching(/prp_1 includes mem_tci_lily/)]);
    expect(failing(...line({ suggestionAudience: adults }, { turn: turn([]) }))).toHaveLength(1);
  });

  // T-160 r1 flaw 6: a group reply naming someone outside the audience fails.
  it('a group reply naming a member outside the audience fails; a DM or the audience does not', () => {
    const aud = ['mem_dean', 'mem_chase'];
    const ok = turn([message({ text: 'Dean, Chase: rooftop bar at 10?' })]);
    expect(failing(...line({ suggestionAudience: aud }, { turn: ok }))).toEqual([]);
    const outside = turn([message({ text: 'rooftop bar at 10, Henry’s welcome too' })]);
    expect(failing(...line({ suggestionAudience: aud }, { turn: outside }))).toEqual([
      expect.stringMatching(/group reply names mem_henry, outside \[mem_dean, ?mem_chase\]/),
    ]);
    const dm = turn([
      message({
        text: 'rooftop bar at 10, henry is out',
        to: { kind: 'member', memberId: 'mem_dean' },
      }),
      message({ text: 'rooftop bar at 10?' }),
    ]);
    expect(failing(...line({ suggestionAudience: aud }, { turn: dm }))).toEqual([]);
  });

  it('namesMember matches whole names in any case, possessives included', () => {
    expect(namesMember("after lily's asleep", 'Lily')).toBe(true);
    expect(namesMember('LILY can come', 'Lily')).toBe(true);
    expect(namesMember('the lilypad bar', 'Lily')).toBe(false);
    expect(namesMember('Chasers bar', 'Chase')).toBe(false);
    expect(namesMember('anything', '')).toBe(false);
  });

  it('an adult-only request fails when a minor screen suppressed the reply', () => {
    const reply = turn([message({ text: 'casino at 9, the 3 of you' })]);
    expect(failing(...line({ explicitAdultRequest: true }, { turn: reply }))).toEqual([]);
    const audit = chain([{ type: 'content.suppressed', payload: { cause: 'minor_alcohol' } }]);
    const s = step({
      turn: reply,
      auditFrom: 0,
      auditTo: 1,
      expect: { explicitAdultRequest: true },
    });
    expect(failing(episode({ steps: [s], audit }), s)).toEqual([
      expect.stringMatching(/minor screens \[minor_alcohol\]/),
    ]);
  });
});
