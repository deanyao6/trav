import { describe, expect, it } from 'vitest';
import type { Expense, Member, OutboundMessage, PendingPrivateItem } from '@trav/core';
import { TravError, createDeterministicIdGenerator, markPrivate, money } from '@trav/core';
import { renderBookingProposal } from './bookingProposal.js';
import { NO_LEDGER_EXPENSE_ID, renderReceipt } from './receipt.js';
import { renderTicket } from './ticket.js';
import { renderExpenseLogged, renderLooksShared } from './expenseConfirm.js';
import { renderSettleUp } from './settleUp.js';
import { renderRecap } from './recap.js';
import { renderWrapped, renderWrappedForSend } from './wrapped.js';
import { renderOptions } from './options.js';
import { renderLastAction } from './lastAction.js';
import { cardInvariantViolations, laneViolations } from './invariants.js';
import { voiceViolations } from './lint.js';
import {
  FIVE,
  GROUP_ID,
  NOW,
  TRIP_ID,
  barcelonaGroup,
  barcelonaMembers,
  barcelonaTrip,
  consentFor,
  decide,
  razzmatazzProposal,
  razzmatazzWorld,
  renderCtx,
  ticketArtifact,
} from './testkit.js';

const eur = (minor: number) => money(minor, 'EUR');

/** Every rendered message: voice-clean (strict proper nouns) and VOICE §5 invariants hold. */
function expectClean(m: OutboundMessage, members: readonly Member[] = barcelonaMembers()): void {
  expect(m.card?.fallbackText).toBe(m.text);
  expect(voiceViolations(m, members, barcelonaTrip())).toEqual([]);
  expect(
    cardInvariantViolations(m, {
      group: barcelonaGroup(),
      members,
      trip: barcelonaTrip(),
      consent: consentFor(),
      now: NOW,
    }),
  ).toEqual([]);
}

describe('booking_proposal (VOICE §4.1)', () => {
  it('renders the Razzmatazz flagship proposal exactly', () => {
    const proposal = razzmatazzProposal();
    const decision = decide(proposal);
    expect(decision.outcome).toBe('needs_confirmation');
    const m = renderBookingProposal(
      {
        proposal,
        decision,
        item: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' },
        excluded: [{ memberId: 'mem_henry', reason: 'sick' }],
      },
      renderCtx(),
    );
    expect(m.text).toBe(
      [
        'razzmatazz tonight, 5 tickets',
        'Dean, Maya, Jordan, Priya, Sam (not Henry)',
        '€18 each · €90 total · refundable until 10pm',
        "charged to Dean's card, split 5 ways on the tab",
        '👍 to book. price held for 15 min',
      ].join('\n'),
    );
    expect(m.to).toEqual({ kind: 'group' });
    expect(m.mentions).toBeUndefined();
    expect(m.card.charged.map((c) => c.name)).toEqual(['Dean', 'Maya', 'Jordan', 'Priya', 'Sam']);
    expect(m.card.excluded).toEqual([{ memberId: 'mem_henry', name: 'Henry', reason: 'sick' }]);
    expect(m.card.policy.ruleId).toBe('C1');
    // The policy (not the renderer) decides who may tap: C1 any_one = any adult member.
    expect(m.card.policy.requiresApprovalFrom).toEqual([...decision.requiredApprovers]);
    expect(m.card.policy.requiresApprovalFrom).toContain('mem_dean');
    expect(m.card.holdExpiresAt).toBe('2026-03-12T21:55:00+01:00');
    expect(m.actions?.map((a) => a.id)).toEqual(['approve', 'not_me', 'decline']);
    expect(m.actions?.[0]?.allowedMemberIds).toEqual([...decision.requiredApprovers]);
    expect(m.actions?.[1]?.allowedMemberIds).toEqual([...FIVE]);
    expect(m.text).not.toContain('sick'); // the reason stays in the card (VOICE §4.1 notes)
    expectClean(m);
  });

  it('over the per-person cap and non-refundable: names and @tags the approving lead', () => {
    const members = barcelonaMembers();
    const six = members.map((x) => x.memberId);
    const proposal = razzmatazzProposal({
      proposalId: 'prop_barca',
      description: 'barça vs sevilla',
      totalMinor: 43200,
      payers: six.map((memberId) => ({ memberId, shareMinor: 7200 })),
      attendees: six,
      refundable: false,
      requestedBy: 'mem_maya',
      paidBy: { kind: 'member_card', memberId: 'mem_dean' },
      holdExpiresAt: '2026-03-12T21:55:00+01:00',
    });
    const decision = decide(proposal, members);
    const m = renderBookingProposal(
      {
        proposal,
        decision,
        item: {
          name: 'Barça vs Sevilla',
          headline: 'barça vs sevilla',
          startsAt: '2026-03-15T21:00:00+01:00',
        },
      },
      renderCtx(members),
    );
    const lines = m.text.split('\n');
    expect(lines[0]).toBe('barça vs sevilla, sun mar 15 9pm, 6 tickets');
    expect(lines[1]).toBe('Dean, Henry, Maya, Jordan, Priya, Sam');
    expect(lines[2]).toBe('€72 each · €432 total · non-refundable');
    // C3 escalates to each_payer: all six must tap, too many to @tag (VOICE §3.5).
    expect(lines[4]).toBe("that's over the €50/person cap, so all 6 of you have to ok it");
    expect(lines[5]).toBe('👍 from each of you to book. price held for 15 min');
    expect(m.mentions).toBeUndefined();
    expect(m.card.policy.overCap).toBe(true);
    expect(m.card.policy.approvalMode).toBe('each_payer');
    expect(m.card.policy.ruleId).toBe('C1');
    expect(lines.length).toBe(6);
    expectClean(m);
  });

  it("someone else's card (C10, T-148): the card owner is named as the one who oks it", () => {
    const members = barcelonaMembers();
    const proposal = razzmatazzProposal({ requestedBy: 'mem_maya' });
    const decision = decide(proposal, members, barcelonaGroup().spendingPolicy);
    expect(decision.reasons).toContain('card_not_requester');
    const m = renderBookingProposal(
      { proposal, decision, item: { name: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' } },
      renderCtx(members),
    );
    const lines = m.text.split('\n');
    expect(lines[4]).toBe("it's on Dean's card, so @Dean has to ok it");
    expect(lines[5]).toBe('👍 from Dean to book. price held for 15 min');
    expect(m.actions?.[0]?.allowedMemberIds).toEqual(['mem_dean']);
    expectClean(m);
  });

  it('lead-only approvers on a non-refundable booking: the reason and the @tagged approvers', () => {
    const members = barcelonaMembers();
    const policy = { ...barcelonaGroup().spendingPolicy, approvers: ['mem_dean'] as const };
    // Maya asks on her own card (on Dean's, C10 makes Dean the only approver).
    const proposal = razzmatazzProposal({
      refundable: false,
      requestedBy: 'mem_maya',
      paidBy: { kind: 'member_card', memberId: 'mem_maya' },
    });
    const decision = decide(proposal, members, { ...policy, approvers: ['mem_dean'] });
    const m = renderBookingProposal(
      { proposal, decision, item: { name: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' } },
      renderCtx(members),
    );
    const lines = m.text.split('\n');
    expect(lines[2]).toBe('€18 each · €90 total · non-refundable');
    expect(lines[4]).toBe("it's non-refundable, so @Dean or @Maya has to ok it");
    expect(lines[5]).toBe('👍 from Dean or Maya to book. price held for 15 min');
    expect(m.mentions).toEqual(['mem_dean', 'mem_maya']);
    expect(m.actions?.[0]?.allowedMemberIds).toEqual(['mem_dean', 'mem_maya']);
    expectClean(m);
  });

  it('each_payer with a short list tags each payer', () => {
    const members = barcelonaMembers();
    const proposal = razzmatazzProposal({
      totalMinor: 12000,
      payers: [
        { memberId: 'mem_dean', shareMinor: 6000 },
        { memberId: 'mem_maya', shareMinor: 6000 },
      ],
      attendees: ['mem_dean', 'mem_maya'],
    });
    const m = renderBookingProposal(
      {
        proposal,
        decision: decide(proposal, members),
        item: { name: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' },
      },
      renderCtx(members),
    );
    expect(m.text.split('\n').slice(4)).toEqual([
      "that's over the €50/person cap, so @Dean, @Maya each have to ok it",
      '👍 from each of you to book. price held for 15 min',
    ]);
    expect(m.mentions).toEqual(['mem_dean', 'mem_maya']);
    expect(m.text.split('\n')[1]).toBe('Dean, Maya (not Henry, Jordan, Priya, Sam)');
    expectClean(m);
  });

  it('refuses a decision that is not needs_confirmation, or shares that do not sum', () => {
    const proposal = razzmatazzProposal();
    const deny = { ...decide(proposal), outcome: 'deny' as const };
    expect(() =>
      renderBookingProposal({ proposal, decision: deny, item: { name: 'x' } }, renderCtx()),
    ).toThrow(TravError);
    const bad = razzmatazzProposal({ totalMinor: 9001 });
    expect(() =>
      renderBookingProposal(
        {
          proposal: bad,
          decision: { ...decide(proposal), proposalId: bad.proposalId },
          item: { name: 'x' },
        },
        renderCtx(),
      ),
    ).toThrow(/shares do not sum/);
  });
});

describe('receipt (VOICE §4.2): from the audit log, never free text', () => {
  it('Razzmatazz receipt text matches the ledger and the booking.completed entry exactly', () => {
    const w = razzmatazzWorld();
    const m = renderReceipt(
      {
        booking: w.booking,
        expense: w.expense,
        auditEvents: w.events,
        headline: 'razzmatazz',
      },
      renderCtx(w.members, w.clock.now()),
    );
    expect(m.text).toBe(
      [
        'booked ✅ razzmatazz, 5 tickets, €90',
        'order RZ-48213 · refundable until 10pm',
        'QR codes are in your dms, one each',
        'tab: Maya, Jordan, Priya, Sam → Dean €18',
      ].join('\n'),
    );
    const completed = w.events.find((e) => e.type === 'booking.completed')!;
    expect(m.card.auditEventId).toBe(completed.id);
    expect(m.card.ruleId).toBe('C1');
    expect(m.card.total).toEqual(eur(completed.payload['totalMinor'] as number));
    expect(m.card.refundable).toBe(completed.payload['refundable']);
    expect(m.card.ledger.expenseId).toBe('exp_rz');
    expect(m.card.ledger.split.map((p) => [p.memberId, p.share?.amountMinor])).toEqual(
      FIVE.map((id) => [id, 1800]),
    );
    expect(m.card.ledger.split.some((p) => p.memberId === 'mem_henry')).toBe(false);
    expect(m.card.paidBy).toEqual({ kind: 'member_card', memberId: 'mem_dean' });
    expect(m.text).not.toContain('Henry');
    expectClean(m, w.members);
  });

  it('works for an exact-amounts booking expense too', () => {
    const w = razzmatazzWorld({
      split: {
        method: 'exact',
        amounts: FIVE.map((memberId) => ({ memberId, amount: eur(1800) })),
      },
    });
    const m = renderReceipt(
      { booking: w.booking, expense: w.expense, auditEvents: w.events },
      renderCtx(w.members, w.clock.now()),
    );
    expect(m.text.split('\n')[3]).toBe('tab: Maya, Jordan, Priya, Sam → Dean €18');
  });

  it.each([
    ['policy.evaluated'],
    ['approval.granted'],
    ['booking.completed'],
    ['ledger.written'],
  ] as const)('refuses to render when %s is missing from the log', (type) => {
    const w = razzmatazzWorld({ skip: [type] });
    expect(() =>
      renderReceipt(
        { booking: w.booking, expense: w.expense, auditEvents: w.events },
        renderCtx(w.members, w.clock.now()),
      ),
    ).toThrow(TravError);
  });

  it('refuses when the audit total, payers or refundability disagree with the booking', () => {
    for (const completedPayload of [
      { totalMinor: 9900 },
      { refundable: false },
      {
        payers: FIVE.map((memberId) => ({
          memberId,
          shareMinor: memberId === 'mem_dean' ? 1801 : 1800,
        })),
      },
    ]) {
      const w = razzmatazzWorld({ completedPayload });
      expect(() =>
        renderReceipt(
          { booking: w.booking, expense: w.expense, auditEvents: w.events },
          renderCtx(w.members, w.clock.now()),
        ),
      ).toThrow(/does not match the audit log/);
    }
  });

  it('refuses when the ledger split disagrees with the audited shares (Henry snuck in)', () => {
    const w = razzmatazzWorld({ split: { method: 'equal', participants: [...FIVE, 'mem_henry'] } });
    expect(() =>
      renderReceipt(
        { booking: w.booking, expense: w.expense, auditEvents: w.events },
        renderCtx(w.members, w.clock.now()),
      ),
    ).toThrow(/ledger shares/);
  });
});

describe('ticket (VOICE §4.3): DM only', () => {
  it('renders Priya her own ticket, QR as image + card, never to the group', () => {
    const m = renderTicket(
      { artifact: ticketArtifact('mem_priya', 'tkt_rz_4'), headline: 'razzmatazz' },
      renderCtx(),
    );
    expect(m.text).toBe(
      [
        'your razzmatazz ticket for tonight 🎟️',
        'doors 12am · Carrer dels Almogàvers 122',
        "this one's yours only, don't forward it. everyone got their own",
      ].join('\n'),
    );
    expect(m.to).toEqual({ kind: 'member', memberId: 'mem_priya' });
    expect(m.card.deliveredTo).toBe('mem_priya');
    expect(m.card.qr.payload).toBe('RZ-48213:tkt_rz_4:SECRET');
    expect(m.images?.[0]?.url).toBe('data:image/png;base64,QRtkt_rz_4');
    expect(m.text).not.toContain('SECRET');
    expectClean(m);
  });

  it('a minor’s ticket goes to the guardian; anyone else is refused', () => {
    const members: Member[] = [
      ...barcelonaMembers(),
      {
        ...barcelonaMembers()[1]!,
        memberId: 'mem_lily',
        displayName: 'Lily',
        birthDate: '2012-01-01',
        ageBand: 'under18',
        guardianMemberId: 'mem_dean',
      },
    ];
    const m = renderTicket(
      { artifact: ticketArtifact('mem_lily', 'tkt_l', 'mem_dean'), headline: 'snorkel tour' },
      renderCtx(members),
    );
    expect(m.to).toEqual({ kind: 'member', memberId: 'mem_dean' });
    expect(m.text.split('\n')[0]).toBe("Lily's snorkel tour ticket for tonight 🎟️");
    expectClean(m, members);
    expect(() =>
      renderTicket({ artifact: ticketArtifact('mem_priya', 't', 'mem_sam') }, renderCtx()),
    ).toThrow(/guardian/);
  });
});

function chatExpense(over: Partial<Expense> = {}): Expense {
  return {
    expenseId: 'exp_dinner',
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    description: 'dinner',
    category: 'food',
    amount: eur(8400),
    paidBy: [{ memberId: 'mem_dean', amount: eur(8400) }],
    split: { method: 'exclude', excluded: ['mem_henry'] },
    source: 'chat',
    sourceRef: { kind: 'message', id: 'sim_in_9' },
    occurredAt: NOW,
    createdAt: NOW,
    createdBy: 'mem_dean',
    status: 'logged',
    ...over,
  };
}

describe('expense_confirm logged (VOICE §4.4)', () => {
  it('equal split excluding Henry', () => {
    const m = renderExpenseLogged({ expense: chatExpense() }, renderCtx());
    expect(m.text).toBe(
      [
        'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each',
        '👎 to undo or tell me what to change',
      ].join('\n'),
    );
    expect(m.card.visibility).toBe('group');
    expect(m.card.split.excluded?.map((p) => p.name)).toEqual(['Henry']);
    expect(m.card.split.participants.reduce((a, p) => a + p.share!.amountMinor, 0)).toBe(8400);
    expect(m.actions?.map((a) => a.id)).toEqual(['undo']);
    expectClean(m);
  });

  it('a sub-cent-per-head equal split keeps zero-share participants out of the "not" list', () => {
    const all = renderCtx()
      .members.filter((m) => m.active)
      .map((m) => m.memberId);
    const m = renderExpenseLogged(
      {
        expense: chatExpense({
          amount: eur(3),
          paidBy: [{ memberId: 'mem_dean', amount: eur(3) }],
          split: { method: 'equal', participants: all },
        }),
      },
      renderCtx(),
    );
    expect(m.card.split.excluded ?? []).toEqual([]);
    expect(m.text).not.toContain('(not');
    expectClean(m);
  });

  it('custom shares (exact) and the remainder going to the payer', () => {
    const custom = renderExpenseLogged(
      {
        expense: chatExpense({
          description: 'taxi',
          amount: eur(3200),
          paidBy: [{ memberId: 'mem_maya', amount: eur(3200) }],
          split: {
            method: 'exact',
            amounts: [
              { memberId: 'mem_maya', amount: eur(1200) },
              { memberId: 'mem_sam', amount: eur(2000) },
            ],
          },
          createdBy: 'mem_maya',
        }),
      },
      renderCtx(),
    );
    expect(custom.text).toBe(
      ['logged: €32 taxi on Maya · Sam €20 · Maya €12', '👎 to undo'].join('\n'),
    );
    expectClean(custom);

    const odd = renderExpenseLogged(
      {
        expense: chatExpense({
          amount: eur(1000),
          paidBy: [{ memberId: 'mem_dean', amount: eur(1000) }],
          split: { method: 'equal', participants: ['mem_dean', 'mem_maya', 'mem_sam'] },
        }),
      },
      renderCtx(),
    );
    // An `equal` subset names who's out, like `exclude` does (VOICE §4.4 A).
    expect(odd.text.split('\n')[0]).toBe(
      'logged: €10 dinner on Dean, 3 ways (not Henry, Jordan, Priya) → €3.33 each',
    );
    expect(odd.card.split.participants.find((p) => p.memberId === 'mem_dean')?.share).toEqual(
      eur(334),
    );
    expectClean(odd);
  });
});

function pending(over: Partial<PendingPrivateItem> = {}): PendingPrivateItem {
  return markPrivate({
    id: 'priv_uber',
    ownerMemberId: 'mem_sam',
    groupId: GROUP_ID,
    tripId: TRIP_ID,
    createdAt: NOW,
    source: 'card',
    sourceItemId: 'priv_tx_1',
    status: 'pending',
    amount: eur(2340),
    occurredAt: '2026-03-13T02:14:00+01:00',
    merchantDisplay: 'Uber',
    category: 'transport',
    classifier: { looksShared: true, confidence: 0.92, reason: 'late ride after a group booking' },
    lowConfidence: false,
    suggestedParticipants: [...FIVE],
    ...over,
  } as Omit<PendingPrivateItem, never>);
}

describe('expense_confirm looks shared (VOICE §4.5): private DM to the owner', () => {
  const morning = '2026-03-13T10:00:00+01:00';

  it('single card charge', () => {
    const m = renderLooksShared(
      {
        ownerMemberId: 'mem_sam',
        items: [
          {
            item: pending(),
            guess: 'that the ride back from razzmatazz?',
            splitWithLabel: 'the 5 who went',
          },
        ],
      },
      renderCtx(barcelonaMembers(), morning),
    );
    expect(m.text).toBe(
      [
        'saw €23.40 from Uber at 2:14am, that the ride back from razzmatazz?',
        'looks shared. 👍 to split with the 5 who went, 👎 to keep it off the tab',
      ].join('\n'),
    );
    expect(m.to).toEqual({ kind: 'member', memberId: 'mem_sam' });
    expect(m.card.visibility).toBe('private');
    expect(m.card.paidBy).toBe('mem_sam');
    expect(m.actions?.map((a) => a.id)).toEqual(['confirm', 'keep_private']);
    expectClean(m);
  });

  it('digest of several charges, and never someone else’s item', () => {
    const items = [
      {
        item: pending({
          id: 'p1',
          amount: eur(4720),
          merchantDisplay: 'Mercadona',
          occurredAt: '2026-03-13T11:40:00+01:00',
        }),
        guess: 'groceries for the airbnb?',
      },
      {
        item: pending({
          id: 'p2',
          amount: eur(1200),
          merchantDisplay: 'Bicing',
          occurredAt: '2026-03-13T14:05:00+01:00',
          classifier: { looksShared: false, confidence: 0.3, reason: 'solo' },
        }),
      },
      {
        item: pending({
          id: 'p3',
          amount: money(3890, 'USD'),
          merchantDisplay: 'Lyft',
          occurredAt: '2026-03-13T15:00:00+01:00',
          classifier: { looksShared: false, confidence: 0.2, reason: 'home city' },
        }),
      },
    ];
    const m = renderLooksShared(
      { ownerMemberId: 'mem_sam', items },
      renderCtx(barcelonaMembers(), '2026-03-13T20:00:00+01:00'),
    );
    expect(m.text).toBe(
      [
        '3 charges that look shared, 👍 each one you want on the tab:',
        '1. €47.20 · Mercadona · 11:40am · groceries for the airbnb?',
        '2. €12 · Bicing · 2:05pm · probably just you',
        '3. $38.90 · Lyft · 3pm · probably just you',
        'anything you skip stays private',
      ].join('\n'),
    );
    expect(m.card.digestItems).toHaveLength(3);
    expect(
      m.card.digestItems?.every((d) => d.visibility === 'private' && d.fallbackText.length > 0),
    ).toBe(true);
    expectClean(m);
    expect(() =>
      renderLooksShared({ ownerMemberId: 'mem_dean', items: [{ item: pending() }] }, renderCtx()),
    ).toThrow(/another member/);
  });

  it('never prompts a minor (VOICE §6.1)', () => {
    const members: Member[] = [
      ...barcelonaMembers(),
      {
        ...barcelonaMembers()[1]!,
        memberId: 'mem_lily',
        displayName: 'Lily',
        birthDate: '2012-01-01',
        ageBand: 'under18',
        guardianMemberId: 'mem_dean',
      },
    ];
    expect(() =>
      renderLooksShared(
        { ownerMemberId: 'mem_lily', items: [{ item: pending({ ownerMemberId: 'mem_lily' }) }] },
        renderCtx(members),
      ),
    ).toThrow(/minor/);
  });
});

const BAL = [
  { memberId: 'mem_dean', net: eur(6120) },
  { memberId: 'mem_henry', net: eur(0) },
  { memberId: 'mem_maya', net: eur(-3160) },
  { memberId: 'mem_jordan', net: eur(1200) },
  { memberId: 'mem_priya', net: eur(-2280) },
  { memberId: 'mem_sam', net: eur(-1880) },
];

describe('settle_up (VOICE §4.6)', () => {
  it('running tab', () => {
    const m = renderSettleUp(
      { mode: 'running', currency: 'EUR', balances: BAL, totalSpent: eur(84000), dayNumber: 3 },
      renderCtx(),
    );
    expect(m.text).toBe(
      [
        'running tab, day 3',
        'Dean is owed €61.20 · Jordan is owed €12',
        'Maya owes €31.60 · Priya owes €22.80 · Sam owes €18.80',
        `no rush, i'll do one clean settle at the end. "@trav settle now" if you'd rather square up today`,
      ].join('\n'),
    );
    expect(m.card.balances.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);
    expectClean(m);
  });

  it('final settle with the minimal transfers, and the all-square case', () => {
    const m = renderSettleUp(
      { mode: 'final', currency: 'EUR', balances: BAL, totalSpent: eur(84000) },
      renderCtx(),
    );
    const lines = m.text.split('\n');
    expect(lines[0]).toBe(
      `final settle, ${String(m.card.transfers.length)} transfers and everyone's square`,
    );
    expect(m.card.transfers.length).toBeLessThanOrEqual(5);
    expect(lines.at(-1)).toBe("👍 on this message when you've paid, i'll tick you off");
    expect(lines.slice(1, -1).every((l) => / → /.test(l))).toBe(true);
    expect(m.actions?.map((a) => a.id)).toEqual(['paid']);
    expectClean(m);

    const square = renderSettleUp(
      {
        mode: 'running',
        currency: 'EUR',
        balances: BAL.map((b) => ({ ...b, net: eur(0) })),
        totalSpent: eur(0),
      },
      renderCtx(),
    );
    expect(square.text).toBe('nobody owes anybody. rare. enjoy it');
    expectClean(square);
  });

  it('balances that do not sum to zero are refused', () => {
    expect(() =>
      renderSettleUp(
        {
          mode: 'running',
          currency: 'EUR',
          balances: [{ memberId: 'mem_dean', net: eur(1) }],
          totalSpent: eur(1),
        },
        renderCtx(),
      ),
    ).toThrow(/sum to zero/);
  });
});

const RECAP_BASE = {
  kind: 'morning_after' as const,
  date: '2026-03-14',
  dayNumber: 3,
  lastNight: {
    events: [
      { label: 'razzmatazz', attendees: [...FIVE], amount: eur(9000) },
      { label: 'ubers', attendees: [...FIVE], amount: eur(4700) },
      { label: 'the 3am kebab place', attendees: [...FIVE], amount: eur(6200) },
    ],
    total: eur(19900),
    perPerson: eur(3980),
  },
  settle: { mode: 'running' as const, currency: 'EUR', balances: BAL, totalSpent: eur(84000) },
  today: [
    { label: 'Sagrada Família', startsAt: '2026-03-14T15:00:00+01:00', ticketsDelivered: true },
  ],
};
const ROAST = ['Jordan has paid for kebabs 3 nights running. the tab remembers'];
const RECAP_NOW = '2026-03-14T10:00:00+01:00';

describe('recap (VOICE §4.7)', () => {
  it('roast mode off: neutral recap, roastLines empty, roast unset', () => {
    const ctx = renderCtx(barcelonaMembers(), RECAP_NOW);
    const m = renderRecap({ ...RECAP_BASE, roastLines: ROAST }, ctx, {
      group: barcelonaGroup(),
      trip: barcelonaTrip(),
      consent: consentFor({ roast: [...FIVE, 'mem_henry'] }),
    });
    expect(m.text).toBe(
      [
        'morning after, day 3 ☀️',
        'last night: razzmatazz (5 of you) €90 · ubers €47 · the 3am kebab place €62',
        '€199 total, €39.80 each',
        'tab: Maya → Dean €31.60 is the big one, full list in the card',
        'today: Sagrada Família at 3pm, tickets in your dms',
      ].join('\n'),
    );
    expect(m.card.roastLines).toEqual([]);
    expect(m.roast).toBeUndefined();
    expect(m.card.settle.balances.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);
    expectClean(m);
  });

  it('roast mode on with everyone 18+ and opted in: the line survives and roast is set', () => {
    const group = barcelonaGroup({ roastMode: true });
    const m = renderRecap(
      { ...RECAP_BASE, roastLines: ROAST },
      renderCtx(barcelonaMembers(), RECAP_NOW),
      {
        group,
        trip: barcelonaTrip(),
        consent: consentFor({ roast: [...FIVE, 'mem_henry'] }),
      },
    );
    expect(m.card.roastLines).toEqual(ROAST);
    expect(m.roast).toBe(true);
    expect(m.text).toContain(ROAST[0]);
  });

  it('roast mode on but a minor is present: roastLines empty', () => {
    const members: Member[] = [
      ...barcelonaMembers(),
      {
        ...barcelonaMembers()[1]!,
        memberId: 'mem_lily',
        displayName: 'Lily',
        birthDate: '2012-01-01',
        ageBand: 'under18',
        guardianMemberId: 'mem_dean',
      },
    ];
    const m = renderRecap({ ...RECAP_BASE, roastLines: ROAST }, renderCtx(members, RECAP_NOW), {
      group: barcelonaGroup({ roastMode: true }),
      trip: barcelonaTrip(),
      consent: consentFor({ roast: members.map((x) => x.memberId) }),
    });
    expect(m.card.roastLines).toEqual([]);
    expect(m.roast).toBeUndefined();
    expect(m.text).not.toContain('kebabs 3 nights');
  });

  it('a roast line naming someone who did not opt in is dropped; photos only from opted-in members', () => {
    const m = renderRecap(
      {
        ...RECAP_BASE,
        roastLines: ROAST,
        photos: [
          { url: 'album://1', byMemberId: 'mem_priya', alt: 'sunset' },
          { url: 'album://2', byMemberId: 'mem_sam', alt: 'club line' },
        ],
      },
      renderCtx(barcelonaMembers(), RECAP_NOW),
      {
        group: barcelonaGroup({ roastMode: true }),
        trip: barcelonaTrip(),
        consent: consentFor({ roast: ['mem_dean'], photos: ['mem_priya'] }),
      },
    );
    expect(m.card.roastLines).toEqual([]);
    expect(m.card.photos.map((p) => p.byMemberId)).toEqual(['mem_priya']);
    expect(m.images?.map((i) => i.url)).toEqual(['album://1']);
  });
});

describe('wrapped (VOICE §4.8)', () => {
  it('renders the Barcelona Wrapped with ≤3 emoji and the final settle', () => {
    const m = renderWrapped(
      {
        trip: { name: 'Barcelona', days: 6, people: 6, currency: 'EUR' },
        totals: {
          spent: eur(234000),
          perPerson: eur(39000),
          byCategory: [{ category: 'transport', amount: eur(41200) }],
        },
        stats: [
          { value: '23', label: 'ubers, €412. Priya booked 11 of them' },
          { value: '4', label: 'nights out · latest receipt 4:12am (kebab, obviously)' },
        ],
        awards: [
          {
            title: 'Uber Captain',
            memberId: 'mem_priya',
            evidence: 'booked 11 of 23 ubers',
            basis: 'ledger',
          },
          {
            title: 'Receipt Hoarder',
            memberId: 'mem_dean',
            evidence: '14 photos',
            basis: 'ledger',
          },
        ],
        finalSettle: { currency: 'EUR', balances: BAL, totalSpent: eur(234000) },
      },
      renderCtx(barcelonaMembers(), '2026-03-18T10:00:00+01:00'),
      { group: barcelonaGroup(), trip: barcelonaTrip(), consent: consentFor() },
    );
    const lines = m.text.split('\n');
    expect(lines[0]).toBe('barcelona wrapped 🎉');
    expect(lines[1]).toBe('6 days · 6 people · €2,340 · €390 each');
    expect(m.text).toContain('awards 🏆 Uber Captain: Priya · Receipt Hoarder: Dean (14 photos)');
    expect(lines.at(-1)).toMatch(/^final settle is in the card, \d transfers and you're done 💸$/);
    expect(m.card.shareable).toBe(true);
    expectClean(m);
  });

  it('drops non-pick awards about a minor and never shows a minor’s photos', () => {
    const members: Member[] = [
      { ...barcelonaMembers()[0]!, displayName: 'Dad', memberId: 'mem_dad' },
      {
        ...barcelonaMembers()[1]!,
        memberId: 'mem_lily',
        displayName: 'Lily',
        birthDate: '2012-01-01',
        ageBand: 'under18',
        guardianMemberId: 'mem_dad',
      },
    ];
    const m = renderWrapped(
      {
        trip: { name: 'Turks and Caicos', days: 7, people: 2, currency: 'USD', familyTab: true },
        totals: { spent: money(418000, 'USD'), perPerson: money(209000, 'USD'), byCategory: [] },
        stats: [{ value: '3', label: 'boat days · 0 rainy ones' }],
        awards: [
          {
            title: "Lily's pick",
            memberId: 'mem_lily',
            evidence: 'snorkel tour',
            basis: 'booking',
          },
          { title: 'Big Spender', memberId: 'mem_lily', evidence: '$80', basis: 'ledger' },
        ],
        photos: [{ url: 'album://lily', byMemberId: 'mem_lily', alt: 'reef' }],
        finalSettle: {
          currency: 'USD',
          balances: [
            { memberId: 'mem_dad', net: money(0, 'USD') },
            { memberId: 'mem_lily', net: money(0, 'USD') },
          ],
          totalSpent: money(418000, 'USD'),
        },
      },
      {
        groupId: GROUP_ID,
        members,
        timeZone: 'America/Grand_Turk',
        now: '2026-07-10T10:00:00-04:00',
        ids: createDeterministicIdGenerator('t'),
      },
      {
        group: barcelonaGroup(),
        trip: null,
        consent: consentFor({ photos: ['mem_dad', 'mem_lily'] }),
      },
    );
    expect(m.card.awards.map((a) => a.title)).toEqual(["Lily's pick"]);
    expect(m.card.photos).toEqual([]);
    expect(m.text.split('\n')[1]).toBe('7 days · $4,180 on the family tab');
    expect(voiceViolations(m, members, null)).toEqual([]);
  });
});

describe('options (VOICE §4.10 C)', () => {
  it('renders numbered options with trade-offs and refundability', () => {
    const m = renderOptions(
      {
        context: 'nothing for barça under €60 a head this sunday',
        options: [
          { id: 'o1', label: 'upper corner', price: eur(7200), refundable: true, tradeoff: '' },
          { id: 'o2', label: 'behind the goal', price: eur(6800), refundable: false, tradeoff: '' },
          {
            id: 'o3',
            label: 'Espanyol vs Getafe, saturday',
            price: eur(5500),
            refundable: true,
            tradeoff: "not barça, but it's a match",
          },
        ],
      },
      renderCtx(),
    );
    expect(m.text).toBe(
      [
        'nothing for barça under €60 a head this sunday. closest:',
        '1. €72 · upper corner · refundable',
        '2. €68 · behind the goal · non-refundable',
        "3. €55 · Espanyol vs Getafe, saturday · not barça, but it's a match",
        'reply 1, 2, or 3, or tell me to drop it',
      ].join('\n'),
    );
    expect(m.card.pickAction.textAliases).toEqual(['1', '2', '3']);
    expectClean(m);
  });
});

describe('"@trav what did you just do?" from the audit log', () => {
  it('restates the Razzmatazz booking: who approved, rule id, money, refund', () => {
    const w = razzmatazzWorld();
    const m = renderLastAction(
      {
        events: w.events,
        lookups: { booking: (id) => (id === w.booking.bookingId ? w.booking : undefined) },
      },
      renderCtx(w.members, '2026-03-12T21:45:00+01:00'),
    );
    expect(m.text).toBe(
      [
        "booked razzmatazz at 9:41pm: 5 tickets, €90 on Dean's card",
        'Dean approved it · rule C1, every booking needs one tap',
        'split 5 ways, €18 each · refundable until 10pm',
        "order RZ-48213, the receipt's up in the chat",
      ].join('\n'),
    );
    expect(m.card).toBeUndefined();
    expect(voiceViolations(m, w.members, w.trip)).toEqual([]);
  });

  it('pending proposal, and an empty log', () => {
    const w = razzmatazzWorld({
      skip: ['approval.granted', 'booking.attempted', 'booking.completed', 'ledger.written'],
    });
    const pendingMsg = renderLastAction(
      { events: w.events, lookups: { proposal: () => w.proposal } },
      renderCtx(w.members, NOW),
    );
    expect(pendingMsg.text).toBe(
      ['proposed razzmatazz at 9:40pm, waiting on a 👍', 'nothing bought yet, no charge'].join(
        '\n',
      ),
    );
    const none = renderLastAction({ events: [] }, renderCtx());
    expect(none.text).toBe("nothing yet. i haven't booked or logged anything on this trip");
    for (const msg of [pendingMsg, none])
      expect(voiceViolations(msg, w.members, w.trip)).toEqual([]);
  });

  it('refuses to describe a booking the log cannot prove was approved', () => {
    const w = razzmatazzWorld({ skip: ['approval.granted'] });
    expect(() =>
      renderLastAction(
        { events: w.events, lookups: { booking: () => w.booking } },
        renderCtx(w.members),
      ),
    ).toThrow(TravError);
  });
});

describe('T-026 review round 2 (renderers)', () => {
  it('flaw 2: an equal split over a participant subset shows "(not Henry)" and card.split.excluded', () => {
    const m = renderExpenseLogged(
      { expense: chatExpense({ split: { method: 'equal', participants: [...FIVE] } }) },
      renderCtx(),
    );
    expect(m.text.split('\n')[0]).toBe(
      'logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each',
    );
    expect(m.card.split.excluded?.map((p) => p.memberId)).toEqual(['mem_henry']);
    expectClean(m);

    // Everyone in: no aside, no excluded list.
    const all = renderExpenseLogged(
      {
        expense: chatExpense({
          amount: eur(6000),
          paidBy: [{ memberId: 'mem_dean', amount: eur(6000) }],
          split: { method: 'equal', participants: barcelonaMembers().map((x) => x.memberId) },
        }),
      },
      renderCtx(),
    );
    expect(all.text.split('\n')[0]).toBe('logged: €60 dinner on Dean, 6 ways → €10 each');
    expect(all.card.split.excluded).toBeUndefined();

    // More people out than in: name who's in instead of a long "not" list.
    const pair = renderExpenseLogged(
      {
        expense: chatExpense({
          description: 'taxi',
          amount: eur(2000),
          paidBy: [{ memberId: 'mem_maya', amount: eur(2000) }],
          split: { method: 'equal', participants: ['mem_maya', 'mem_sam'] },
          createdBy: 'mem_maya',
        }),
      },
      renderCtx(),
    );
    expect(pair.text.split('\n')[0]).toBe(
      'logged: €20 taxi on Maya, 2 ways (Maya, Sam) → €10 each',
    );
    expect(pair.card.split.excluded?.map((p) => p.name)).toEqual([
      'Dean',
      'Henry',
      'Jordan',
      'Priya',
    ]);
    expectClean(pair);
  });

  it('flaw 3: requester among more than three any_one approvers, with a reason, still says who', () => {
    const members = barcelonaMembers();
    const policy = {
      ...barcelonaGroup().spendingPolicy,
      approvers: ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya'],
    };
    // T-104: the requester must be on the booking to approve, so Sam (attending) asks.
    // On Sam's own card: on Dean's, C10 would make Dean the only approver.
    const proposal = razzmatazzProposal({
      refundable: false,
      requestedBy: 'mem_sam',
      paidBy: { kind: 'member_card', memberId: 'mem_sam' },
    });
    const decision = decide(proposal, members, policy);
    expect(decision.approvalMode).toBe('any_one');
    expect(decision.requiredApprovers).toHaveLength(5);
    expect(decision.requiredApprovers).toContain('mem_sam');
    const m = renderBookingProposal(
      { proposal, decision, item: { name: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' } },
      renderCtx(members),
    );
    expect(m.text.split('\n').slice(4)).toEqual([
      "it's non-refundable",
      '👍 from one of Dean, Maya, Jordan, Priya, Sam to book. price held for 15 min',
    ]);
    expect(m.mentions).toBeUndefined(); // too many to @tag (VOICE §3.5)
    expectClean(m);
  });

  const wrappedBase = {
    trip: { name: 'Barcelona', days: 6, people: 6, currency: 'EUR' },
    totals: { spent: eur(234000), perPerson: eur(39000), byCategory: [] },
    stats: [{ value: '23', label: 'ubers, €412' }],
    awards: [],
    finalSettle: { currency: 'EUR', balances: BAL, totalSpent: eur(234000) },
  };
  const WRAP_ROAST = 'Priya booked 11 of 23 ubers. the city has a metro';

  it('flaw 4: renderWrappedForSend gates roast lines once, returns them, and sets roast: true', () => {
    const r = renderWrappedForSend(
      { ...wrappedBase, roastLines: [`  ${WRAP_ROAST}  `, 'Henry has a weird body'] },
      renderCtx(barcelonaMembers(), '2026-03-17T20:00:00+01:00'),
      {
        group: barcelonaGroup({ roastMode: true }),
        trip: barcelonaTrip(),
        consent: consentFor({ roast: ['mem_priya', 'mem_henry'] }),
      },
    );
    expect(r.roastLines).toEqual([WRAP_ROAST]); // trimmed as in the text; the body line is gated out
    expect(r.message.text.split('\n')).toContain(WRAP_ROAST);
    expect(r.message.text).not.toContain('body');
    expect(r.message.roast).toBe(true);

    // Roast off: no lines, no flag; the legacy renderWrapped gives the same message.
    const offArgs = [
      { ...wrappedBase, roastLines: [WRAP_ROAST] },
      renderCtx(barcelonaMembers(), '2026-03-17T20:00:00+01:00'),
      { group: barcelonaGroup(), trip: barcelonaTrip(), consent: consentFor() },
    ] as const;
    const off = renderWrappedForSend(...offArgs);
    expect(off.roastLines).toEqual([]);
    expect(off.message.roast).toBeUndefined();
    expect(off.message.text).not.toContain('metro');
    expect(renderWrapped(...offArgs).text).toBe(off.message.text);
  });

  it('flaw 6: receipt qty is the attendee count only for tickets; per-person cards say "no ledger entry"', () => {
    const w = razzmatazzWorld();
    const ctx = renderCtx(w.members, w.clock.now());
    const ticket = renderReceipt(
      { booking: w.booking, expense: w.expense, auditEvents: w.events },
      ctx,
    );
    expect(ticket.card.lineItems).toEqual([
      { label: w.booking.description, qty: 5, unit: eur(1800), total: eur(9000) },
    ]);
    expect(ticket.card.ledger.expenseId).toBe('exp_rz');

    // A flight for the same 5 people at €90: one line, qty 1, not "5 × €18".
    const flight = renderReceipt(
      {
        booking: { ...w.booking, kind: 'flight', tickets: [] },
        expense: w.expense,
        auditEvents: w.events,
        headline: 'flights',
      },
      ctx,
    );
    expect(flight.card.lineItems).toEqual([
      { label: w.booking.description, qty: 1, unit: eur(9000), total: eur(9000) },
    ]);

    // Each on their own card: no ledger entry, and the card says so explicitly.
    const { expenseId: _e, ...noExpense } = w.booking;
    const own = renderReceipt(
      {
        booking: { ...noExpense, paidBy: { kind: 'per_person_cards' } },
        expense: null,
        auditEvents: w.events,
        headline: 'razzmatazz',
      },
      ctx,
    );
    expect(own.card.ledger).toEqual({ expenseId: NO_LEDGER_EXPENSE_ID, split: [] });
    expect(own.text.split('\n').at(-1)).toBe('each on your own card, nothing to split');
    expectClean(own, w.members);
  });

  it('flaw 7: each lane violation is reported once (no dead or duplicate branch)', () => {
    const t = renderTicket({ artifact: ticketArtifact('mem_priya', 'tkt') }, renderCtx());
    const inGroup: OutboundMessage = { ...t, to: { kind: 'group' } };
    const strings = cardInvariantViolations(inGroup, {
      group: barcelonaGroup(),
      members: barcelonaMembers(),
      trip: barcelonaTrip(),
      consent: consentFor(),
      now: NOW,
    });
    expect(strings.filter((v) => v === 'ticket card on the group lane')).toHaveLength(1);
    expect(laneViolations(inGroup)).toEqual([
      {
        cause: 'dm_only_card_in_group',
        violation: 'ticket card on the group lane',
        cardType: 'ticket',
        ownerId: 'mem_priya',
      },
    ]);
    expect(laneViolations({ ...t, to: { kind: 'member', memberId: 'mem_sam' } })).toEqual([
      {
        cause: 'private_card_wrong_recipient',
        violation: 'ticket delivered to someone other than deliveredTo',
        cardType: 'ticket',
        ownerId: 'mem_priya',
      },
    ]);
    expect(laneViolations(t)).toEqual([]);
  });
});
