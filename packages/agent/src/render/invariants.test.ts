import { describe, expect, it } from 'vitest';
import type { Member, OutboundMessage, RecapCard } from '@trav/core';
import { money } from '@trav/core';
import { cardInvariantViolations } from './invariants.js';
import type { InvariantContext } from './invariants.js';
import { renderBookingProposal } from './bookingProposal.js';
import { renderReceipt } from './receipt.js';
import { renderTicket } from './ticket.js';
import { renderSettleUp } from './settleUp.js';
import { renderRecap } from './recap.js';
import { renderLooksShared } from './expenseConfirm.js';
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

const eur = (n: number) => money(n, 'EUR');

function ictx(over: Partial<InvariantContext> = {}): InvariantContext {
  return {
    group: barcelonaGroup(),
    members: barcelonaMembers(),
    trip: barcelonaTrip(),
    consent: consentFor(),
    now: NOW,
    ...over,
  };
}

function withMinor(): Member[] {
  return [
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
}

describe('VOICE §5 card invariants', () => {
  it('booking_proposal: charged shares must sum to the total', () => {
    const proposal = razzmatazzProposal();
    const m = renderBookingProposal(
      { proposal, decision: decide(proposal), item: { name: 'Razzmatazz' } },
      renderCtx(),
    );
    expect(cardInvariantViolations(m, ictx())).toEqual([]);
    const tampered = {
      ...m,
      card: { ...m.card, total: eur(9900) },
    } as OutboundMessage;
    expect(cardInvariantViolations(tampered, ictx()).join()).toMatch(
      /shares sum to 9000, total 9900/,
    );
  });

  it('receipt: ledger split must sum to the total when one card paid', () => {
    const w = razzmatazzWorld();
    const m = renderReceipt(
      { booking: w.booking, expense: w.expense, auditEvents: w.events },
      renderCtx(w.members, w.clock.now()),
    );
    expect(cardInvariantViolations(m, ictx())).toEqual([]);
    const tampered = {
      ...m,
      card: { ...m.card, ledger: { ...m.card.ledger, split: m.card.ledger.split.slice(1) } },
    } as OutboundMessage;
    expect(cardInvariantViolations(tampered, ictx()).join()).toMatch(
      /receipt: ledger split sums to 7200/,
    );
  });

  it('settle_up (standalone and embedded): balances must sum to zero', () => {
    const m = renderSettleUp(
      {
        mode: 'running',
        currency: 'EUR',
        balances: [
          { memberId: 'mem_dean', net: eur(500) },
          { memberId: 'mem_sam', net: eur(-500) },
        ],
        totalSpent: eur(1000),
      },
      renderCtx(),
    );
    expect(cardInvariantViolations(m, ictx())).toEqual([]);
    const tampered = {
      ...m,
      card: { ...m.card, balances: [{ memberId: 'mem_dean', name: 'Dean', net: eur(500) }] },
    } as OutboundMessage;
    expect(cardInvariantViolations(tampered, ictx())).toContain(
      'settle_up: balances sum to 500, not 0',
    );
  });

  it('ticket: never in a group message, and only to deliveredTo', () => {
    const t = renderTicket({ artifact: ticketArtifact('mem_priya', 'tkt') }, renderCtx());
    expect(cardInvariantViolations(t, ictx())).toEqual([]);
    expect(cardInvariantViolations({ ...t, to: { kind: 'group' } }, ictx())).toContain(
      'ticket card on the group lane',
    );
    expect(
      cardInvariantViolations({ ...t, to: { kind: 'member', memberId: 'mem_sam' } }, ictx()),
    ).toContain('ticket delivered to someone other than deliveredTo');
  });

  it('private expense_confirm: never in a group message, and only to its owner', () => {
    const m = renderLooksShared(
      {
        ownerMemberId: 'mem_sam',
        items: [
          {
            item: {
              id: 'priv_1',
              ownerMemberId: 'mem_sam',
              groupId: GROUP_ID,
              tripId: TRIP_ID,
              createdAt: NOW,
              source: 'email',
              sourceItemId: 'em',
              status: 'pending',
              amount: eur(1860),
              occurredAt: '2026-03-12T01:30:00+01:00',
              merchantDisplay: 'Uber',
              category: 'transport',
              lowConfidence: false,
              suggestedParticipants: ['mem_dean', 'mem_jordan', 'mem_sam'],
            } as never,
            detail: 'Eixample → Poblenou, 4 riders',
          },
        ],
      },
      renderCtx(),
    );
    expect(cardInvariantViolations(m, ictx())).toEqual([]);
    expect(cardInvariantViolations({ ...m, to: { kind: 'group' } }, ictx())).toContain(
      'private expense_confirm on the group lane',
    );
    expect(
      cardInvariantViolations({ ...m, to: { kind: 'member', memberId: 'mem_dean' } }, ictx()),
    ).toContain("private expense_confirm sent to someone who isn't its owner");
  });

  const recapInput = {
    kind: 'morning_after' as const,
    date: '2026-03-14',
    dayNumber: 3,
    lastNight: {
      events: [{ label: 'razzmatazz', attendees: [...FIVE], amount: eur(9000) }],
      total: eur(9000),
    },
    roastLines: ['Priya has booked 11 of 23 ubers. the city has a metro'],
    settle: { mode: 'running' as const, currency: 'EUR', balances: [], totalSpent: eur(9000) },
  };

  it('recap: roastLines empty when roast mode is off', () => {
    const m = renderRecap(recapInput, renderCtx(), {
      group: barcelonaGroup(),
      trip: barcelonaTrip(),
      consent: consentFor({ roast: [...FIVE] }),
    });
    expect(m.card.roastLines).toEqual([]);
    expect(cardInvariantViolations(m, ictx())).toEqual([]);
    // A hand-built recap that smuggles a roast line past the renderer is caught.
    const smuggled = {
      ...m,
      roast: true,
      card: { ...m.card, roastLines: recapInput.roastLines } as RecapCard,
    } as OutboundMessage;
    const v = cardInvariantViolations(smuggled, ictx());
    expect(v).toContain('recap.roastLines non-empty while roasts are blocked');
    expect(v).toContain('roast: true while roast mode is off');
  });

  it('recap: roastLines empty when a minor is present, even with roast mode on', () => {
    const members = withMinor();
    const group = barcelonaGroup({ roastMode: true });
    const m = renderRecap(recapInput, renderCtx(members), {
      group,
      trip: barcelonaTrip(),
      consent: consentFor({ roast: members.map((x) => x.memberId) }),
    });
    expect(m.card.roastLines).toEqual([]);
    expect(m.roast).toBeUndefined();
    const smuggled = {
      ...m,
      card: { ...m.card, roastLines: recapInput.roastLines } as RecapCard,
    } as OutboundMessage;
    expect(cardInvariantViolations(smuggled, ictx({ group, members }))).toContain(
      'recap.roastLines non-empty while roasts are blocked',
    );
  });

  it('roast: true needs roast lines on a recap', () => {
    const group = barcelonaGroup({ roastMode: true, allAdultsConfirmed: true });
    const m = renderRecap({ ...recapInput, roastLines: [] }, renderCtx(), {
      group,
      trip: barcelonaTrip(),
      consent: consentFor({ roast: [...FIVE] }),
    });
    expect(cardInvariantViolations({ ...m, roast: true }, ictx({ group }))).toContain(
      'roast: true with no roastLines',
    );
  });
});
