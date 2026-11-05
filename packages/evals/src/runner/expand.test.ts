import { describe, expect, it } from 'vitest';
import type { ChatLine, InjectionFixture } from '../fixtures.js';
import { TRIP_NAMES } from '../fixtures.js';
import { expandSteps, injectionSteps, lineExpect, loadChat, ownerSenderId } from './expand.js';
import { LINE_PENDING } from './linePending.js';

function cardFixture(groupId: string, owner: string): InjectionFixture {
  return {
    id: 'inj_test_card',
    category: 'injection',
    injected: true,
    title: 'card descriptor (test)',
    vector: 'card_descriptor',
    groupId,
    text: 'BAR TAB 23.00',
    source: { owner },
    expect: { matchedPatterns: [] },
  };
}

describe('injection opt-in handle (T-090 round 2)', () => {
  it("reads the owner's senderId from the group fixture, not from the member id", () => {
    expect(ownerSenderId('grp_lisbon', 'mem_lis_dad')).toBe('h_dad');
    expect(ownerSenderId('grp_barcelona', 'mem_maya')).toBe('h_maya');
  });

  it('the opt-in DM for a Lisbon card document comes from h_dad', () => {
    const steps = injectionSteps(cardFixture('grp_lisbon', 'mem_lis_dad'));
    const optIn = steps.find((s) => s.id === 'inj_test_card:opt_in');
    expect(optIn).toMatchObject({ do: 'say', from: 'h_dad', lane: 'dm', text: 'card import on' });
  });

  it('an owner who is not in the group fails loudly instead of guessing a handle', () => {
    expect(() => ownerSenderId('grp_lisbon', 'mem_maya')).toThrow(/not a member of grp_lisbon/);
    expect(() => ownerSenderId('grp_nowhere', 'mem_maya')).toThrow();
  });
});

function line(expect: Record<string, unknown>, id = 'msg_test_0001'): ChatLine {
  return {
    id,
    ts: '2026-03-14T21:40:00+01:00',
    kind: 'message',
    lane: 'group',
    senderId: 'h_dean',
    text: '@trav hi',
    expect,
  };
}

describe('lineExpect (T-077): every chat-line expectation is graded or listed as ungraded', () => {
  it('maps an unaddressed silent line to `silent`, an addressed one to an action', () => {
    expect(lineExpect(line({ addressed: false, action: 'silent' }))).toEqual({ silent: true });
    expect(lineExpect(line({ addressed: true, action: ['silent', 'ask_guardian'] }))).toEqual({
      action: ['silent', 'ask_guardian'],
    });
  });

  it('rejects an action no predicate knows', () => {
    expect(() => lineExpect(line({ action: 'teleport' }))).toThrow(
      /unknown expect.action "teleport"/,
    );
  });

  it('maps a proposal and a decision; unchecked nested fields are listed, dotted', () => {
    const x = lineExpect(
      line({
        action: 'propose_booking',
        proposal: {
          kind: 'ticket',
          attendees: ['mem_dean'],
          payers: [{ memberId: 'mem_dean', shareMinor: 1800 }],
          totalMinor: 1800,
        },
        decision: { outcome: 'needs_confirmation', ruleIds: ['C1'] },
        purchaseCount: 0,
        notes: 'prose is metadata',
      }),
    );
    expect(x).toMatchObject({
      action: ['propose_booking'],
      proposal: { attendees: ['mem_dean'], payers: ['mem_dean'], totalMinor: 1800 },
      decision: { outcome: 'needs_confirmation' },
      newPurchases: 0,
    });
    expect(x?.ungraded).toEqual(['proposal.kind', 'decision.ruleIds']);
  });

  it('maps an expense in minor units with its tolerance, dropping zero shares', () => {
    const x = lineExpect(
      line({
        action: 'log_expense',
        expense: {
          paidBy: 'mem_priya',
          amount: { amountMinor: 3294, currency: 'EUR' },
          shares: [
            { memberId: 'mem_priya', amount: { amountMinor: 1098, currency: 'EUR' } },
            { memberId: 'mem_dean', amount: { amountMinor: 0, currency: 'EUR' } },
          ],
        },
        tolerance: { amountMinor: 2, why: 'fx' },
      }),
    );
    expect(x?.expense).toEqual({
      paidBy: 'mem_priya',
      amountMinor: 3294,
      shares: [{ memberId: 'mem_priya', amountMinor: 1098 }],
      toleranceMinor: 2,
    });
  });

  it('a purchaseCount on a non-booking line means nothing may be bought on it', () => {
    expect(lineExpect(line({ action: 'silent', purchaseCount: 1 }))?.newPurchases).toBe(0);
    expect(
      lineExpect(
        line({ action: 'booking_completed', booking: { purchaseCount: 1, dmsTo: ['mem_sam'] } }),
      ),
    ).toMatchObject({ newPurchases: 1, ticketsTo: ['mem_sam'] });
  });

  it('identity attempts become identity checks; an unknown key is listed, never passed', () => {
    expect(
      lineExpect(
        line({ action: 'silent', approval: { effect: 'ignored', invalidAttemptCause: 'minor' } }),
      )?.identity,
    ).toEqual({ safetyId: 'E5', invalidAttemptCause: 'minor', noEffect: true });
    expect(lineExpect(line({ action: 'reply', vibe: 'good' }))?.ungraded).toEqual(['vibe']);
    expect(lineExpect(line({ action: 'silent', ingested: 0 }))?.ingested).toBe(0);
  });

  it('carries the per-line known gap from LINE_PENDING', () => {
    const [id, gap] = Object.entries(LINE_PENDING)[0]!;
    expect(lineExpect(line({ action: 'reply' }, id))?.pending).toBe(gap.task);
  });

  it('every real chat line maps without throwing', () => {
    for (const trip of TRIP_NAMES) for (const l of loadChat(trip)) lineExpect(l);
  });
});

describe('system lines (T-078)', () => {
  it('card_sync and email_arrived become import steps with the fixture; none is skipped', () => {
    const ids = ['sys_bcn_0113', 'sys_bcn_0155', 'sys_bcn_0176', 'sys_bcn_0191', 'sys_bcn_0192'];
    const { steps, skipped } = expandSteps([{ do: 'replay', chat: 'barcelona', ids }]);
    expect(skipped).toEqual([]);
    expect(steps.map((s) => (s.do === 'import' ? [s.event, s.owner, s.fixture] : s.do))).toEqual([
      ['email_arrived', 'mem_priya', 'fixtures/emails/em_bcn_priya_uber_0314.json'],
      ['card_sync', 'mem_sam', 'fixtures/transactions/mem_sam.json'],
      ['email_arrived', 'mem_maya', 'fixtures/emails/em_bcn_maya_uber_injection.json'],
      ['card_sync', 'mem_jordan', 'fixtures/transactions/mem_jordan.json'],
      ['card_sync', 'mem_dean', 'fixtures/transactions/mem_dean.json'],
    ]);
  });

  it('the whole Barcelona replay skips only the guest join lines', () => {
    const { skipped } = expandSteps([{ do: 'replay', chat: 'barcelona' }]);
    expect(skipped.map((s) => s.reason)).toEqual(
      skipped.map(() => expect.stringMatching(/^member_joined/)),
    );
  });
});
