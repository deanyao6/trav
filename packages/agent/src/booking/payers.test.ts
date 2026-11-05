import { describe, expect, it } from 'vitest';
import type { Member } from '@trav/core';
import type { PayerRule } from './payers.js';
import { cardHolderFor, payersFor } from './payers.js';

const NOW = '2026-06-22T10:00:00-04:00';

function member(id: string, overrides: Partial<Member> = {}): Member {
  return {
    memberId: id,
    groupId: 'grp_tci',
    displayName: id.replace(/^mem_/, ''),
    role: 'member',
    active: true,
    senderId: `sim:${id}`,
    ageBand: 'adult',
    joinedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const members: readonly Member[] = [
  member('mem_mom', { role: 'lead' }),
  member('mem_dad', { role: 'guardian' }),
  member('mem_dean'),
  member('mem_lily', { ageBand: 'under18', guardianMemberId: 'mem_dad' }),
];

const rule = (requestedBy: string, familyTab = true): PayerRule => ({
  members,
  now: NOW,
  familyTab,
  requestedBy,
});

describe('payersFor: the family tab is one pot (VOICE §8, T-148 #2, D-030)', () => {
  it('an adults-only booking on a family-tab trip is all on the requester, not split per attendee', () => {
    expect(payersFor(['mem_mom', 'mem_dad'], rule('mem_dad'))).toEqual(['mem_dad']);
    expect(payersFor(['mem_dean', 'mem_dad'], rule('mem_dean'))).toEqual(['mem_dean']);
  });

  it('a booking a minor is on stays one pot too', () => {
    expect(payersFor(['mem_mom', 'mem_dad', 'mem_lily'], rule('mem_mom'))).toEqual(['mem_mom']);
  });

  it("a minor's ask goes on her guardian (the requester's guardian carries the pot)", () => {
    const payers = payersFor(['mem_lily'], rule('mem_lily'));
    expect(payers).toEqual(['mem_dad']);
    expect(cardHolderFor('mem_lily', payers, rule('mem_lily'))).toBe('mem_dad');
  });

  it('a requester who is not on the booking and guards nobody on it: still one pot, the first adult on it', () => {
    expect(payersFor(['mem_mom', 'mem_dad'], rule('mem_dean'))).toEqual(['mem_mom']);
    // Lily only, asked by Dean: her guardian Dad carries it.
    expect(payersFor(['mem_lily'], rule('mem_dean'))).toEqual(['mem_dad']);
  });

  it('a minor with no guardian on a family tab and no adult on it stays listed (C8 holds it)', () => {
    const orphan: PayerRule = {
      members: [member('mem_mom'), member('mem_kid', { ageBand: 'under18' })],
      now: NOW,
      familyTab: true,
      requestedBy: 'mem_mom',
    };
    expect(payersFor(['mem_kid'], orphan)).toEqual(['mem_kid']);
  });

  it('without a family tab, adults pay their own share and a minor folds into her guardian', () => {
    expect(payersFor(['mem_mom', 'mem_dad'], rule('mem_dad', false))).toEqual([
      'mem_mom',
      'mem_dad',
    ]);
    expect(payersFor(['mem_lily', 'mem_mom'], rule('mem_mom', false))).toEqual([
      'mem_dad',
      'mem_mom',
    ]);
  });

  it('empty attendees: no payers', () => {
    expect(payersFor([], rule('mem_dad'))).toEqual([]);
  });
});
