import { describe, expect, it } from 'vitest';
import type { BookingProposal, RichCard } from '@trav/core';
import type {
  InboundButtonTap,
  InboundEvent,
  InboundMessage,
  InboundReaction,
} from '@trav/adapters';
import { razzmatazzProposal } from '../render/testkit.js';
import {
  classifyApprovalText,
  isOwnCancelText,
  followSupersededBy,
  MAX_SUPERSEDE_HOPS,
  normalizeApprovalEvent,
  reactionIntent,
  TEXT_ALIASES,
  type PendingCardIndex,
  type PendingCardRef,
} from './events.js';

const NOW = '2026-03-14T21:45:00+01:00';
const CONV = 'conv_barcelona';

const card = (proposalId: string): RichCard =>
  ({
    cardId: `card_${proposalId}`,
    type: 'booking_proposal',
    title: 'Razzmatazz',
    fallbackText: 'x',
    proposalId,
  }) as unknown as RichCard;

const ref = (messageId: string, proposalId?: string): PendingCardRef => ({
  cardId: `card_${proposalId ?? 'none'}`,
  messageId,
  card:
    proposalId === undefined
      ? ({ cardId: 'card_none', type: 'expense_confirm', fallbackText: 'x' } as unknown as RichCard)
      : card(proposalId),
  ...(proposalId !== undefined ? { proposalId } : {}),
  sentAt: NOW,
});

function index(
  opts: {
    readonly cards?: readonly PendingCardRef[];
    readonly mine?: readonly BookingProposal[];
    readonly asked?: PendingCardRef;
  } = {},
): PendingCardIndex {
  return {
    byMessageId: (id) => opts.cards?.find((c) => c.messageId === id),
    pendingProposalsRequestedBy: () => opts.mine ?? [],
    lastTravQuestion: () => opts.asked,
  };
}

const base = {
  channel: 'simulator' as const,
  conversationId: CONV,
  lane: 'group' as const,
  receivedAt: NOW,
};

function message(text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    ...base,
    type: 'message',
    messageId: 'm_in',
    sender: 'h_dean',
    text,
    attachments: [],
    ...extra,
  };
}

function reaction(reaction: string, targetMessageId: string, removed = false): InboundReaction {
  return {
    ...base,
    type: 'reaction',
    messageId: 'r_in',
    sender: 'h_dean',
    targetMessageId,
    reaction,
    removed,
  };
}

function tap(actionId: string, cardMessageId: string, value?: string): InboundButtonTap {
  return {
    ...base,
    type: 'button_tap',
    messageId: 't_in',
    sender: 'h_dean',
    cardMessageId,
    cardId: 'card_p1',
    actionId,
    ...(value !== undefined ? { value } : {}),
  };
}

describe('what counts as approval (VOICE §6.2)', () => {
  it.each([
    ['yes', 'approve'],
    ['Yep!', 'approve'],
    ['@trav book it', 'approve'],
    ['trav, do it', 'approve'],
    ['(go)', 'approve'],
    ['👍', 'approve'],
    ['no', 'decline'],
    ['nah.', 'decline'],
    ['drop it', 'decline'],
    ['👎', 'decline'],
    ['not me', 'not_me'],
    ["I'm out", 'not_me'],
    ['im out', 'not_me'],
    ['without me', 'not_me'],
  ])('classifyApprovalText(%j) = %s', (text, intent) => {
    expect(classifyApprovalText(text)).toBe(intent);
  });

  it.each([
    'ok',
    'okay',
    'yes please book it for 5',
    'book it tomorrow',
    'go team',
    "i'm out tonight",
    '',
    'sure',
  ])('classifyApprovalText(%j) is not an approval', (text) => {
    expect(classifyApprovalText(text)).toBeUndefined();
  });

  it('"ok" is never an alias (a bare "ok" in unrelated chat must not buy tickets)', () => {
    for (const aliases of Object.values(TEXT_ALIASES)) expect(aliases).not.toContain('ok');
  });

  it.each([
    ['👍', 'approve'],
    ['like', 'approve'],
    ['thumbs_up', 'approve'],
    ['+1', 'approve'],
    ['👎', 'decline'],
    ['dislike', 'decline'],
    ['❤️', undefined],
    ['haha', undefined],
    ['‼️', undefined],
  ])('reactionIntent(%j) = %s', (r, intent) => {
    expect(reactionIntent(r)).toBe(intent);
  });
});

describe('normalizeApprovalEvent: buttons, tapbacks and text become one ApprovalEvent', () => {
  const cards = [ref('msg_card', 'p1'), ref('msg_expense')];

  it('a proposal button binds to its card and proposal; other buttons and unknown cards are none', () => {
    const r = normalizeApprovalEvent(tap('approve', 'msg_card'), index({ cards }), 'mem_dean', NOW);
    expect(r).toEqual({
      kind: 'event',
      event: {
        kind: 'approve',
        senderId: 'h_dean',
        via: 'button',
        messageId: 't_in',
        at: NOW,
        cardId: 'card_p1',
        proposalId: 'p1',
        targetMessageId: 'msg_card',
      },
    });
    expect(
      normalizeApprovalEvent(tap('pick', 'msg_card', '2'), index({ cards }), 'mem_dean', NOW),
    ).toMatchObject({ kind: 'event', event: { kind: 'pick', value: '2' } });
    expect(
      normalizeApprovalEvent(tap('undo', 'msg_card'), index({ cards }), 'mem_dean', NOW),
    ).toEqual({ kind: 'none' });
    expect(
      normalizeApprovalEvent(tap('approve', 'msg_expense'), index({ cards }), 'mem_dean', NOW),
    ).toEqual({ kind: 'none' });
    expect(
      normalizeApprovalEvent(tap('approve', 'msg_unknown'), index({ cards }), 'mem_dean', NOW),
    ).toEqual({ kind: 'none' });
  });

  it('a 👍/👎 tapback on the card is the same event as the button; other emoji, removals and non-cards are none', () => {
    const up = normalizeApprovalEvent(
      reaction('👍', 'msg_card'),
      index({ cards }),
      'mem_dean',
      NOW,
    );
    expect(up).toMatchObject({
      kind: 'event',
      event: {
        kind: 'approve',
        via: 'reaction',
        proposalId: 'p1',
        cardId: 'card_p1',
        targetMessageId: 'msg_card',
      },
    });
    expect(
      normalizeApprovalEvent(reaction('👎', 'msg_card'), index({ cards }), 'mem_dean', NOW),
    ).toMatchObject({
      kind: 'event',
      event: { kind: 'decline', via: 'reaction' },
    });
    expect(
      normalizeApprovalEvent(reaction('❤️', 'msg_card'), index({ cards }), 'mem_dean', NOW),
    ).toEqual({ kind: 'none' });
    expect(
      normalizeApprovalEvent(reaction('👍', 'msg_card', true), index({ cards }), 'mem_dean', NOW),
    ).toEqual({ kind: 'none' });
    expect(
      normalizeApprovalEvent(reaction('👍', 'msg_expense'), index({ cards }), 'mem_dean', NOW),
    ).toEqual({ kind: 'none' });
  });

  it("text: a quote-reply binds to that card first, then Trav's last question, then the requester's single pending proposal", () => {
    const replied = normalizeApprovalEvent(
      message('yes', { replyToMessageId: 'msg_card' }),
      index({ cards, asked: ref('msg_other', 'p9') }),
      'mem_dean',
      NOW,
    );
    expect(replied).toMatchObject({
      kind: 'event',
      event: { kind: 'approve', via: 'text', proposalId: 'p1', targetMessageId: 'msg_card' },
    });

    const asked = normalizeApprovalEvent(
      message('book it'),
      index({ cards, asked: ref('msg_q', 'p2') }),
      'mem_dean',
      NOW,
    );
    expect(asked).toMatchObject({
      kind: 'event',
      event: { kind: 'approve', proposalId: 'p2', targetMessageId: 'msg_q' },
    });

    const mine = normalizeApprovalEvent(
      message('yes'),
      index({ mine: [razzmatazzProposal({ proposalId: 'p3' })] }),
      'mem_dean',
      NOW,
    );
    expect(mine).toEqual({
      kind: 'event',
      event: {
        kind: 'approve',
        senderId: 'h_dean',
        via: 'text',
        messageId: 'm_in',
        at: NOW,
        proposalId: 'p3',
      },
    });
  });

  it("a quote-reply to a known non-proposal card is none: it never falls through to the reply window or the requester's own proposal", () => {
    const idx = index({
      cards,
      asked: ref('msg_q', 'p9'),
      mine: [razzmatazzProposal({ proposalId: 'p3' })],
    });
    expect(
      normalizeApprovalEvent(
        message('yes', { replyToMessageId: 'msg_expense' }),
        idx,
        'mem_dean',
        NOW,
      ),
    ).toEqual({ kind: 'none' });
    expect(
      normalizeApprovalEvent(
        message('not me', { replyToMessageId: 'msg_expense' }),
        idx,
        'mem_dean',
        NOW,
      ),
    ).toEqual({ kind: 'none' });
    // An unknown replied-to message (not one of Trav's cards) still falls through as before.
    expect(
      normalizeApprovalEvent(
        message('yes', { replyToMessageId: 'msg_nobody' }),
        idx,
        'mem_dean',
        NOW,
      ),
    ).toMatchObject({ kind: 'event', event: { proposalId: 'p9' } });
  });

  it('two pending proposals of the requester ⇒ ambiguous (Trav asks which); never a guess', () => {
    const r = normalizeApprovalEvent(
      message('yes'),
      index({
        mine: [razzmatazzProposal({ proposalId: 'p3' }), razzmatazzProposal({ proposalId: 'p4' })],
      }),
      'mem_dean',
      NOW,
    );
    expect(r).toEqual({ kind: 'ambiguous', senderId: 'h_dean', candidates: ['p3', 'p4'] });
  });

  it("an alias that binds to nothing is still an event without a proposalId (the loop's gate binds it); non-aliases are none", () => {
    expect(normalizeApprovalEvent(message('not me'), index(), 'mem_chase', NOW)).toEqual({
      kind: 'event',
      event: { kind: 'not_me', senderId: 'h_dean', via: 'text', messageId: 'm_in', at: NOW },
    });
    expect(normalizeApprovalEvent(message('not me'), index(), null, NOW)).toMatchObject({
      kind: 'event',
    });
    expect(normalizeApprovalEvent(message('ok'), index({ cards }), 'mem_dean', NOW)).toEqual({
      kind: 'none',
    });
    expect(
      normalizeApprovalEvent(message('Dean says yes'), index({ cards }), 'mem_henry', NOW),
    ).toEqual({ kind: 'none' });
  });

  it('identity is the channel sender only: the display name and names in the text change nothing', () => {
    const spoof = normalizeApprovalEvent(
      { ...message('yes'), sender: 'h_dean2' },
      index({ asked: ref('msg_q', 'p2') }),
      null,
      NOW,
    );
    expect(spoof).toMatchObject({
      kind: 'event',
      event: { senderId: 'h_dean2', proposalId: 'p2' },
    });
  });

  it('followSupersededBy walks the chain to the live proposal, stops on a loop or a missing link, and is bounded', () => {
    const chain: Record<string, { status: 'superseded' | 'pending'; supersededBy?: string }> = {
      p1: { status: 'superseded', supersededBy: 'p2' },
      p2: { status: 'superseded', supersededBy: 'p3' },
      p3: { status: 'pending' },
      loopA: { status: 'superseded', supersededBy: 'loopB' },
      loopB: { status: 'superseded', supersededBy: 'loopA' },
      dangling: { status: 'superseded', supersededBy: 'gone' },
    };
    const get = (id: string) => chain[id];
    expect(followSupersededBy(get, 'p1')).toBe('p3');
    expect(followSupersededBy(get, 'p3')).toBe('p3');
    expect(followSupersededBy(get, 'nope')).toBe('nope');
    expect(followSupersededBy(get, 'loopA')).toBe('loopB');
    expect(followSupersededBy(get, 'dangling')).toBe('gone');
    const long: Record<string, { status: 'superseded'; supersededBy: string }> = {};
    for (let i = 0; i < 100; i++)
      long[`c${i}`] = { status: 'superseded', supersededBy: `c${i + 1}` };
    expect(followSupersededBy((id) => long[id], 'c0')).toBe(`c${MAX_SUPERSEDE_HOPS}`);
  });

  it('membership events are none', () => {
    const joined: InboundEvent = {
      ...base,
      type: 'member_joined',
      participant: { handle: 'h_new', displayName: 'New', isTrav: false },
    };
    expect(normalizeApprovalEvent(joined, index({ cards }), 'mem_dean', NOW)).toEqual({
      kind: 'none',
    });
  });
});

describe('isOwnCancelText (T-137)', () => {
  it.each([
    'actually nah, staying in. cancel that',
    'cancel that',
    'cancel',
    '@trav cancel that',
    'trav, cancel mine',
    'nvm, drop it',
    'actually cancel my ticket pls',
    'changed my mind - scrap that',
    "ugh i'm out. cancel it",
  ])('"%s" is an own-cancel', (t) => {
    expect(isOwnCancelText(t)).toBe(true);
  });

  it.each([
    'cancel the vip thing, way too much',
    'cancel that for crowley',
    'cancel that and book the vip',
    'can you cancel that?? lol what do you think',
    "don't cancel that",
    'cancel that. cancel it',
    'staying in tonight',
    '',
    'henry wants to cancel that',
  ])('"%s" is not', (t) => {
    expect(isOwnCancelText(t)).toBe(false);
  });
});
