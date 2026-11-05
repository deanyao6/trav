import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@trav/core';
import { message, step } from '../testing.js';
import type { TurnSummary } from '../types.js';
import { actionObserved, privateCard } from './actions.js';

function confirm(
  visibility: 'group' | 'private',
  digest?: 'private',
): NonNullable<OutboundMessage['card']> {
  return {
    type: 'expense_confirm',
    visibility,
    ...(digest !== undefined
      ? { digestItems: [{ type: 'expense_confirm', visibility: digest }] }
      : {}),
  } as unknown as NonNullable<OutboundMessage['card']>;
}

const turn = (outbound: OutboundMessage[]): TurnSummary => ({
  outbound,
  reactions: [],
  toolCalls: [],
  silent: false,
  modelSources: [],
  note: 'test',
});

describe('privateCard (T-077 r2)', () => {
  const dm = (card: NonNullable<OutboundMessage['card']>) =>
    message({ text: 'x', to: { kind: 'member', memberId: 'mem_crowley' }, card });

  it('is a DM of a private confirm card, or of a digest holding one', () => {
    expect(privateCard(dm(confirm('private')))).toBe(true);
    expect(privateCard(dm(confirm('group', 'private')))).toBe(true);
  });

  it("a group-visibility confirm card DM'd (an already logged expense) is not a looks-shared prompt", () => {
    expect(privateCard(dm(confirm('group')))).toBe(false);
    const s = step({ lane: 'dm', turn: turn([dm(confirm('group'))]) });
    expect(actionObserved('dm_looks_shared', s, 0)).toBe(false);
  });

  it('a private card sent to the group is never a DM', () => {
    expect(privateCard(message({ text: 'x', card: confirm('private') }))).toBe(false);
  });
});
