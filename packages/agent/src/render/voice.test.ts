/**
 * VOICE parity: every VOICE §4 example passes the voice linter (as the send
 * path runs it), and the renderers reproduce the flagship §4 examples
 * verbatim from typed data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Expense, PendingPrivateItem } from '@trav/core';
import { markPrivate, money, safety } from '@trav/core';
import { repoRoot } from '../model/paths.js';
import { renderBookingProposal } from './bookingProposal.js';
import { renderReceipt } from './receipt.js';
import { renderTicket } from './ticket.js';
import { renderExpenseLogged, renderLooksShared } from './expenseConfirm.js';
import { renderSettleUp } from './settleUp.js';
import { renderOptions } from './options.js';
import {
  FIVE,
  GROUP_ID,
  NOW,
  TRIP_ID,
  decide,
  razzmatazzProposal,
  razzmatazzWorld,
  renderCtx,
  ticketArtifact,
} from './testkit.js';

interface VoiceFixture {
  readonly properNouns: readonly string[];
  readonly examples: readonly {
    readonly id: string;
    readonly kind: safety.MessageKind;
    readonly text: string;
  }[];
}

const fixture = JSON.parse(
  readFileSync(join(repoRoot(), 'fixtures', 'safety', 'voice-examples.json'), 'utf8'),
) as VoiceFixture;
const example = (id: string): string => {
  const e = fixture.examples.find((x) => x.id === id);
  if (e === undefined) throw new Error(`no VOICE example ${id}`);
  return e.text;
};
const eur = (minor: number) => money(minor, 'EUR');

describe('every VOICE §4 example passes the voice linter', () => {
  it.each(fixture.examples.map((e) => [e.id, e] as const))('%s', (_id, e) => {
    expect(
      safety.lintVoice(e.text, { kind: e.kind, properNouns: fixture.properNouns }).violations,
    ).toEqual([]);
  });
});

describe('renderers reproduce the VOICE §4 examples verbatim', () => {
  it('4.1 A proposal', () => {
    const proposal = razzmatazzProposal();
    const m = renderBookingProposal(
      {
        proposal,
        decision: decide(proposal),
        item: { name: 'Razzmatazz', startsAt: '2026-03-13T00:00:00+01:00' },
      },
      renderCtx(),
    );
    expect(m.text).toBe(example('4.1-a'));
  });

  it('4.2 A receipt', () => {
    const w = razzmatazzWorld();
    const m = renderReceipt(
      { booking: w.booking, expense: w.expense, auditEvents: w.events },
      renderCtx(w.members, w.clock.now()),
    );
    expect(m.text).toBe(example('4.2-a'));
  });

  it('4.3 A ticket', () => {
    const m = renderTicket({ artifact: ticketArtifact('mem_priya', 'tkt_4') }, renderCtx());
    expect(m.text).toBe(example('4.3-a'));
  });

  it('4.4 A and B logged expenses', () => {
    const base: Expense = {
      expenseId: 'exp_1',
      groupId: GROUP_ID,
      tripId: TRIP_ID,
      description: 'dinner',
      category: 'food',
      amount: eur(8400),
      paidBy: [{ memberId: 'mem_dean', amount: eur(8400) }],
      split: { method: 'exclude', excluded: ['mem_henry'] },
      source: 'chat',
      sourceRef: { kind: 'message', id: 'm1' },
      occurredAt: NOW,
      createdAt: NOW,
      createdBy: 'mem_dean',
      status: 'logged',
    };
    expect(renderExpenseLogged({ expense: base }, renderCtx()).text).toBe(example('4.4-a'));
    const taxi: Expense = {
      ...base,
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
    };
    expect(renderExpenseLogged({ expense: taxi }, renderCtx()).text).toBe(example('4.4-b'));
  });

  it('4.5 A looks shared', () => {
    const item = markPrivate({
      id: 'priv_uber',
      ownerMemberId: 'mem_sam',
      groupId: GROUP_ID,
      tripId: TRIP_ID,
      createdAt: NOW,
      source: 'card',
      sourceItemId: 'priv_tx',
      status: 'pending',
      amount: eur(2340),
      occurredAt: '2026-03-13T02:14:00+01:00',
      merchantDisplay: 'Uber',
      category: 'transport',
      lowConfidence: false,
      suggestedParticipants: [...FIVE],
    }) as PendingPrivateItem;
    const m = renderLooksShared(
      {
        ownerMemberId: 'mem_sam',
        items: [
          { item, guess: 'that the ride back from razzmatazz?', splitWithLabel: 'the 5 who went' },
        ],
      },
      renderCtx(undefined, '2026-03-13T10:00:00+01:00'),
    );
    expect(m.text).toBe(example('4.5-a'));
  });

  const BAL = [
    { memberId: 'mem_dean', net: eur(6120) },
    { memberId: 'mem_henry', net: eur(0) },
    { memberId: 'mem_maya', net: eur(-3160) },
    { memberId: 'mem_jordan', net: eur(1200) },
    { memberId: 'mem_priya', net: eur(-2280) },
    { memberId: 'mem_sam', net: eur(-1880) },
  ];

  it('4.6 A running, B final (with the settlement transfers), C all square', () => {
    expect(
      renderSettleUp(
        { mode: 'running', currency: 'EUR', balances: BAL, totalSpent: eur(1), dayNumber: 3 },
        renderCtx(),
      ).text,
    ).toBe(example('4.6-a'));
    expect(
      renderSettleUp(
        {
          mode: 'final',
          currency: 'EUR',
          balances: BAL,
          totalSpent: eur(1),
          transfers: [
            { from: 'mem_maya', to: 'mem_dean', amount: eur(3160) },
            { from: 'mem_priya', to: 'mem_dean', amount: eur(2280) },
            { from: 'mem_sam', to: 'mem_dean', amount: eur(680) },
            { from: 'mem_sam', to: 'mem_jordan', amount: eur(1200) },
          ],
        },
        renderCtx(),
      ).text,
    ).toBe(example('4.6-b'));
    expect(
      renderSettleUp(
        {
          mode: 'running',
          currency: 'EUR',
          balances: BAL.map((b) => ({ ...b, net: eur(0) })),
          totalSpent: eur(0),
        },
        renderCtx(),
      ).text,
    ).toBe(example('4.6-c'));
  });

  it('4.10 C options', () => {
    const m = renderOptions(
      {
        context: 'nothing for barça under €60 a head this sunday',
        options: [
          { id: 'a', label: 'upper corner', price: eur(7200), refundable: true, tradeoff: '' },
          { id: 'b', label: 'behind the goal', price: eur(6800), refundable: false, tradeoff: '' },
          {
            id: 'c',
            label: 'Espanyol vs Getafe, saturday',
            price: eur(5500),
            refundable: true,
            tradeoff: "not barça, but it's a match",
          },
        ],
      },
      renderCtx(),
    );
    expect(m.text).toBe(example('4.10-c'));
  });
});
