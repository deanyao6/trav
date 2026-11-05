import { describe, expect, it } from 'vitest';
import type { InjectionFixture } from '../fixtures.js';
import { injectionSteps, ownerSenderId } from './expand.js';

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
