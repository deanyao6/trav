import { describe, expect, it } from 'vitest';
import type { TranscriptEntry, TranscriptMessage } from '@trav/adapters';
import type { ExpenseConfirmCard, RichCard, TicketCard } from '@trav/core';
import { BARCELONA } from './groups.js';
import type { ChannelView } from './state.js';
import {
  buildDmThread,
  buildGroupThread,
  buildState,
  cardVisibleTo,
  summarizeReactions,
} from './state.js';

const AT = '2026-03-14T21:40:00+01:00';
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR' });

function ticket(owner: string): TicketCard {
  return {
    cardId: `card_tkt_${owner}`,
    type: 'ticket',
    title: 'your ticket',
    fallbackText: 'your razzmatazz ticket',
    bookingId: 'bkg_1',
    ownerMemberId: owner,
    deliveredTo: owner,
    event: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: AT },
    qr: {
      dataUrl: 'data:image/svg+xml;base64,QR',
      payload: 'TRAV-MOCK-TICKET|NOT-VALID-FOR-ENTRY|x',
    },
    holderName: owner,
  };
}

function expense(
  visibility: 'group' | 'private',
  paidBy = 'mem_sam',
  digest?: ExpenseConfirmCard[],
): ExpenseConfirmCard {
  return {
    cardId: `card_exp_${visibility}_${paidBy}`,
    type: 'expense_confirm',
    title: 'looks shared?',
    fallbackText: 'uber €23.40',
    expenseId: 'exp_1',
    status: 'pending',
    source: 'card_transaction',
    visibility,
    description: 'uber',
    amount: eur(2340),
    paidBy,
    split: { method: 'equal', participants: [] },
    ...(digest ? { digestItems: digest } : {}),
  };
}

let seq = 0;
function msg(over: Partial<TranscriptMessage> & { card?: RichCard }): TranscriptMessage {
  seq += 1;
  return {
    type: 'message',
    seq,
    at: AT,
    lane: 'group',
    conversationId: BARCELONA.conversationId,
    direction: 'outbound',
    from: 'trav',
    fromName: 'trav',
    messageId: `m${seq}`,
    text: 'x',
    actions: [],
    attachments: [],
    renderedAsCard: false,
    degraded: false,
    ...over,
  };
}

function view(group: TranscriptEntry[], dms: Record<string, TranscriptEntry[]> = {}): ChannelView {
  return {
    travHandle: 'trav',
    groupTranscript: () => group,
    dmTranscript: (h) => dms[h] ?? [],
  };
}

describe('group thread payload never contains a private card', () => {
  it('drops ticket and private expense_confirm cards that reached the group lane', () => {
    const entries = [
      msg({ text: 'hello' }),
      msg({ card: ticket('mem_priya') }),
      msg({ card: expense('private') }),
      msg({ card: expense('group', 'mem_sam', [expense('private', 'mem_maya')]) }),
      msg({ card: expense('group') }),
    ];
    const thread = buildGroupThread(BARCELONA, view(entries), AT);
    const types = thread.map((e) => (e.kind === 'message' ? (e.card?.type ?? 'text') : e.kind));
    expect(types).toEqual(['text', 'expense_confirm']);
    const json = JSON.stringify(thread);
    expect(json).not.toContain('TRAV-MOCK-TICKET');
    expect(json).not.toContain('"visibility":"private"');
  });

  it('drops DM-lane entries and other conversations even if the transcript source mixes them', () => {
    const entries = [
      msg({ text: 'group line' }),
      msg({ lane: 'dm', conversationId: 'dm:h_priya', text: 'a private line' }),
      msg({ conversationId: 'conv_lisbon', text: 'lisbon line' }),
    ];
    const thread = buildGroupThread(BARCELONA, view(entries), AT);
    expect(thread.map((e) => (e.kind === 'message' ? e.text : ''))).toEqual(['group line']);
  });

  it('never copies the raw outbound envelope into the payload', () => {
    const outbound = {
      id: 'm_x',
      groupId: BARCELONA.groupId,
      to: { kind: 'group' as const },
      text: 'hi',
    };
    const thread = buildGroupThread(BARCELONA, view([msg({ text: 'hi', outbound })]), AT);
    expect(Object.keys(thread[0]!)).not.toContain('outbound');
  });
});

describe('DM threads only show cards addressed to that member', () => {
  it("keeps Priya's own ticket and drops a ticket for someone else", () => {
    const priya = BARCELONA.members.find((m) => m.memberId === 'mem_priya')!;
    const dm = [
      msg({
        lane: 'dm',
        conversationId: 'dm:h_priya',
        dmHandle: 'h_priya',
        card: ticket('mem_priya'),
      }),
      msg({
        lane: 'dm',
        conversationId: 'dm:h_priya',
        dmHandle: 'h_priya',
        card: ticket('mem_sam'),
      }),
      msg({
        lane: 'dm',
        conversationId: 'dm:h_priya',
        dmHandle: 'h_priya',
        card: expense('private', 'mem_maya'),
      }),
    ];
    const thread = buildDmThread(BARCELONA, priya, view([], { h_priya: dm }), AT);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.kind === 'message' && thread[0]!.card?.type).toBe('ticket');
  });

  it('cardVisibleTo: private expense only to its payer, ticket only to deliveredTo', () => {
    expect(cardVisibleTo(expense('private', 'mem_sam'), 'mem_sam')).toBe(true);
    expect(cardVisibleTo(expense('private', 'mem_sam'), 'mem_dean')).toBe(false);
    expect(cardVisibleTo(ticket('mem_dean'), 'mem_dean')).toBe(true);
    expect(cardVisibleTo(ticket('mem_dean'), 'mem_henry')).toBe(false);
  });

  it('drops outbound DMs that belong to another group', () => {
    const priya = BARCELONA.members.find((m) => m.memberId === 'mem_priya')!;
    const other = msg({
      lane: 'dm',
      conversationId: 'dm:h_priya',
      text: 'from another trip',
      outbound: {
        id: 'o1',
        groupId: 'grp_other',
        to: { kind: 'member', memberId: 'mem_priya' },
        text: 'x',
      },
    });
    expect(buildDmThread(BARCELONA, priya, view([], { h_priya: [other] }), AT)).toEqual([]);
  });
});

describe('reactions and empty groups', () => {
  it('summarizes tapbacks, honoring removals', () => {
    expect(
      summarizeReactions([
        { handle: 'h_dean', reaction: '👍', removed: false },
        { handle: 'h_maya', reaction: '👍', removed: false },
        { handle: 'h_dean', reaction: '👍', removed: true },
        { handle: 'h_sam', reaction: '❤️', removed: false },
      ]),
    ).toEqual([
      { reaction: '👍', count: 1, by: ['h_maya'] },
      { reaction: '❤️', count: 1, by: ['h_sam'] },
    ]);
    expect(summarizeReactions(undefined)).toEqual([]);
  });

  it('an empty transcript gives an empty thread, empty DMs and no preview', () => {
    const state = buildState({
      version: 1,
      backend: 'scripted',
      offline: true,
      now: AT,
      groups: [BARCELONA],
      channel: view([]),
      typing: new Set(),
    });
    const g = state.groups[0]!;
    expect(g.thread).toEqual([]);
    expect(g.preview).toBeUndefined();
    expect(Object.values(g.dms).every((d) => d.length === 0)).toBe(true);
    expect(g.typing).toBe(false);
  });
});
