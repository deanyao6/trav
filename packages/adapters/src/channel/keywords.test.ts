import { describe, expect, it } from 'vitest';
import type { PendingCardActions } from './keywords.js';
import {
  DEFAULT_TEXT_ALIASES,
  keywordCandidates,
  matchKeyword,
  normalizeReply,
  pendingFromMessage,
} from './keywords.js';
import {
  PROPOSAL_ACTIONS,
  action,
  groupMsg,
  optionsCard,
  privateExpenseCard,
  proposalCard,
  dmMsg,
} from './testing.js';

const proposal: PendingCardActions = {
  cardId: 'rz-001',
  messageId: 'msg_prop',
  actions: PROPOSAL_ACTIONS,
};

const lookShared: PendingCardActions = {
  cardId: 'exp-card-1',
  messageId: 'msg_shared',
  actions: [action('confirm', 'Share it'), action('keep_private', 'Keep private')],
};

describe('normalizeReply', () => {
  it.each([
    ['Yes!', 'yes'],
    ['  BOOK   it. ', 'book it'],
    ['@trav yes', 'yes'],
    ['trav, do it', 'do it'],
    ['yes trav', 'yes'],
    ['I’m out', "i'm out"],
    ['👍🏽', '👍'],
    ['👍️', '👍'],
    ['travel', 'travel'],
    ['YES TRAV!!', 'yes'],
    ['book it, trav.', 'book it'],
    ['Trav!! do it', 'do it'],
    ['!!yes!!', 'yes'],
  ])('%s → %s', (input, out) => {
    expect(normalizeReply(input)).toBe(out);
  });
});

describe('matchKeyword: single pending card', () => {
  it.each([
    ['yes', 'approve'],
    ['Yep', 'approve'],
    ['go', 'approve'],
    ['book it', 'approve'],
    ['Do it!', 'approve'],
    ['👍', 'approve'],
    ['👍🏻', 'approve'],
    ['no', 'decline'],
    ['nah', 'decline'],
    ['cancel', 'decline'],
    ['drop it', 'decline'],
    ['👎', 'decline'],
    ['not me', 'not_me'],
    ["I'm out", 'not_me'],
    ['i’m out', 'not_me'],
    ['without me', 'not_me'],
    ['YES TRAV!!', 'approve'],
    ['nah trav', 'decline'],
  ])('%s → %s', (text, actionId) => {
    expect(matchKeyword(text, [proposal])).toEqual({
      kind: 'match',
      cardId: 'rz-001',
      messageId: 'msg_prop',
      actionId,
      confidence: 1,
    });
  });

  it.each(['yes but not tonight', 'maybe', 'book it for 4 of us', 'can we do 6 instead', '', '❤️'])(
    '%j does not match (goes to the model or is ignored)',
    (text) => {
      expect(matchKeyword(text, [proposal])).toEqual({ kind: 'none' });
    },
  );

  it('uses the card textAliases, not a global list', () => {
    const custom: PendingCardActions = {
      cardId: 'c',
      actions: [action('approve', 'Approve', { textAliases: ['send it'] })],
    };
    expect(matchKeyword('send it', [custom])).toMatchObject({ kind: 'match', actionId: 'approve' });
    // 'yes' is not in this card's aliases, but its tapback 👍 still works
    expect(matchKeyword('yes', [custom])).toEqual({ kind: 'none' });
    expect(matchKeyword('👍', [custom])).toMatchObject({ kind: 'match', actionId: 'approve' });
  });

  it('nothing pending → none', () => {
    expect(matchKeyword('yes', [])).toEqual({ kind: 'none' });
  });
});

describe('matchKeyword: numbered options', () => {
  const pending = pendingFromMessage(groupMsg('pick one', { id: 'msg_opt', card: optionsCard() }))!;

  it.each([
    ['1', 'opt_sf'],
    ['2', 'opt_pg'],
    ['2.', 'opt_pg'],
    ['#2', 'opt_pg'],
    ['option 1', 'opt_sf'],
    ['1)', 'opt_sf'],
    ['2) ', 'opt_pg'],
    ['#1', 'opt_sf'],
  ])('%s picks %s', (text, value) => {
    expect(matchKeyword(text, [pending])).toEqual({
      kind: 'match',
      cardId: 'opt-1',
      messageId: 'msg_opt',
      actionId: 'pick',
      value,
      confidence: 1,
    });
  });

  it('an out-of-range number matches nothing', () => {
    expect(matchKeyword('3', [pending])).toEqual({ kind: 'none' });
  });

  it('a number with no options card pending matches nothing', () => {
    expect(matchKeyword('1', [proposal])).toEqual({ kind: 'none' });
  });
});

describe('matchKeyword: ambiguity', () => {
  it('"yes" with a proposal and a looks-shared prompt both pending is ambiguous', () => {
    const res = matchKeyword('yes', [proposal, lookShared]);
    expect(res.kind).toBe('ambiguous');
    if (res.kind === 'ambiguous') {
      expect(res.candidates.map((c) => [c.cardId, c.actionId])).toEqual([
        ['rz-001', 'approve'],
        ['exp-card-1', 'confirm'],
      ]);
    }
  });

  it('two pending proposals: "👍" is ambiguous', () => {
    const other = { ...proposal, cardId: 'rz-002', messageId: 'msg_prop2' };
    expect(matchKeyword('👍', [proposal, other]).kind).toBe('ambiguous');
  });

  it('a quote-reply to one card resolves the ambiguity', () => {
    expect(matchKeyword('yes', [proposal, lookShared], { replyToMessageId: 'msg_shared' })).toEqual(
      {
        kind: 'match',
        cardId: 'exp-card-1',
        messageId: 'msg_shared',
        actionId: 'confirm',
        confidence: 1,
      },
    );
  });

  it('a quote-reply to an unrelated message does not resolve it', () => {
    expect(
      matchKeyword('yes', [proposal, lookShared], { replyToMessageId: 'msg_other' }).kind,
    ).toBe('ambiguous');
  });

  it('an alias only one pending card understands is not ambiguous', () => {
    expect(matchKeyword('not me', [proposal, lookShared])).toMatchObject({
      kind: 'match',
      cardId: 'rz-001',
      actionId: 'not_me',
    });
    expect(matchKeyword('keep private', [proposal, lookShared])).toMatchObject({
      kind: 'match',
      cardId: 'exp-card-1',
      actionId: 'keep_private',
    });
  });

  it('two options cards pending: "1" is ambiguous', () => {
    const a = pendingFromMessage(groupMsg('a', { card: optionsCard('opt-a') }))!;
    const b = pendingFromMessage(groupMsg('b', { card: optionsCard('opt-b') }))!;
    expect(matchKeyword('1', [a, b]).kind).toBe('ambiguous');
  });

  it('one card whose actions share an alias is ambiguous (misconfigured card)', () => {
    const bad: PendingCardActions = {
      cardId: 'bad',
      actions: [
        action('approve', 'A', { textAliases: ['ok'] }),
        action('confirm', 'B', { textAliases: ['ok'] }),
      ],
    };
    expect(matchKeyword('ok', [bad]).kind).toBe('ambiguous');
    expect(keywordCandidates('ok', [bad])).toHaveLength(2);
  });
});

describe('pendingFromMessage', () => {
  it('builds from message actions', () => {
    const msg = groupMsg('p', { id: 'msg_x', card: proposalCard(), actions: PROPOSAL_ACTIONS });
    expect(pendingFromMessage(msg)).toEqual({
      cardId: 'rz-001',
      messageId: 'msg_x',
      actions: PROPOSAL_ACTIONS,
    });
  });

  it('returns undefined for messages without a card or without actions', () => {
    expect(pendingFromMessage(groupMsg('hi'))).toBeUndefined();
    expect(
      pendingFromMessage(dmMsg('mem_crowley', 'x', { card: privateExpenseCard() })),
    ).toBeUndefined();
  });
});

describe('DEFAULT_TEXT_ALIASES', () => {
  it('carries the VOICE §6.2 aliases', () => {
    expect(DEFAULT_TEXT_ALIASES.approve).toEqual(
      expect.arrayContaining(['yes', 'yep', 'go', 'book it', 'do it']),
    );
    expect(DEFAULT_TEXT_ALIASES.decline).toEqual(
      expect.arrayContaining(['no', 'nah', 'cancel', 'drop it']),
    );
    expect(DEFAULT_TEXT_ALIASES.not_me).toEqual(
      expect.arrayContaining(['not me', "i'm out", 'without me']),
    );
  });
});
