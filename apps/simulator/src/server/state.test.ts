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
  terminalReplyState,
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
  paidBy = 'mem_crowley',
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
      msg({ card: ticket('mem_arjun') }),
      msg({ card: expense('private') }),
      msg({ card: expense('group', 'mem_crowley', [expense('private', 'mem_chase')]) }),
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
      msg({ lane: 'dm', conversationId: 'dm:h_arjun', text: 'a private line' }),
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

describe('a proposal card ends when Trav quote-replies it with a terminal line (T-009)', () => {
  function proposalCard(): RichCard {
    return {
      cardId: 'card_prop_1',
      type: 'booking_proposal',
      title: 'Razzmatazz',
      fallbackText: 'razzmatazz tonight, 5 tickets',
      proposalId: 'prop_1',
      category: 'event',
      item: { name: 'Razzmatazz', venue: 'Razzmatazz', startsAt: '2026-03-15T00:00:00+01:00' },
      quantity: 5,
      charged: [{ memberId: 'mem_dean', name: 'Dean', share: eur(1800) }],
      excluded: [],
      pricePerPerson: eur(1800),
      total: eur(9000),
      refundable: true,
      paidBy: { kind: 'member_card', memberId: 'mem_dean' },
      policy: {
        requiresApprovalFrom: ['mem_dean'],
        approvalMode: 'any_one',
        overCap: false,
        capPerPerson: eur(6000),
        ruleId: 'C1',
      },
      holdExpiresAt: '2026-03-14T21:55:00+01:00',
      status: 'pending',
    };
  }
  const actions = [
    { id: 'approve' as const, label: 'Approve', style: 'primary' as const, textAliases: [] },
  ];

  function stateAfter(reply: Partial<TranscriptMessage> | undefined) {
    const card = msg({ card: proposalCard(), actions });
    const entries: TranscriptEntry[] = [card];
    if (reply) entries.push(msg({ ...reply, replyToMessageId: card.messageId }));
    const thread = buildGroupThread(BARCELONA, view(entries), AT);
    return thread[0]!.kind === 'message' ? thread[0]!.cardState : undefined;
  }

  it('a failed booking: "Failed · no charge", buttons dead; without the reply the card stays live', () => {
    expect(stateAfter(undefined)).toEqual({ status: 'pending', liveActionIds: ['approve'] });
    expect(
      stateAfter({
        text: "couldn't book razzmatazz. no charge went through\n@ me again in a few and i'll retry",
      }),
    ).toMatchObject({ status: 'failed', label: 'Failed · no charge', liveActionIds: [] });
    // An unrelated later Trav line (no reply-to) changes nothing.
    const card = msg({ card: proposalCard(), actions });
    const thread = buildGroupThread(BARCELONA, view([card, msg({ text: 'see you there' })]), AT);
    expect(thread[0]!.kind === 'message' ? thread[0]!.cardState?.status : '').toBe('pending');
  });

  it('expiry and a typed decline resolve the card too', () => {
    expect(
      stateAfter({ text: 'razzmatazz proposal expired, no charge. @ me if you still want it' }),
    ).toMatchObject({ status: 'expired', label: 'Expired', liveActionIds: [] });
    expect(stateAfter({ text: 'dropped razzmatazz. no charge' })).toMatchObject({
      status: 'declined',
      label: 'Declined',
      liveActionIds: [],
    });
    expect(terminalReplyState("couldn't complete that one. no charge went through")).toEqual({
      status: 'failed',
      label: 'Failed · no charge',
    });
  });

  it('the post-purchase fallback line (money moved) reads "Booked · receipt pending", never "no charge" (T-009 r1 #3)', () => {
    const line =
      "something went wrong on my end after the purchase. the charge went through and the booking stands\n@ me in a minute and i'll sort out the receipt and tickets";
    const state = stateAfter({ text: line });
    expect(state).toMatchObject({
      status: 'booked',
      label: 'Booked · receipt pending',
      liveActionIds: [],
    });
    expect(state?.label).not.toMatch(/no charge|failed/i);
    // "no charge went through" still wins over "went through".
    expect(
      terminalReplyState("couldn't book razzmatazz. no charge went through\n@ me again in a few"),
    ).toEqual({ status: 'failed', label: 'Failed · no charge' });
    // A line that says nothing about money never claims "no charge".
    expect(terminalReplyState('something odd happened')).toEqual({
      status: 'failed',
      label: 'Failed',
    });
  });

  it('the charge-failed line is not a reply to the card: the card stays live for the retry', () => {
    const card = msg({ card: proposalCard(), actions });
    const line = msg({
      text: "couldn't charge the card for razzmatazz. no charge went through, nothing's booked yet\ntap Approve again in a few and i'll retry",
    });
    const thread = buildGroupThread(BARCELONA, view([card, line]), AT);
    expect(thread[0]!.kind === 'message' ? thread[0]!.cardState : undefined).toEqual({
      status: 'pending',
      liveActionIds: ['approve'],
    });
  });
});

describe('DM threads only show cards addressed to that member', () => {
  it("keeps Arjun's own ticket and drops a ticket for someone else", () => {
    const arjun = BARCELONA.members.find((m) => m.memberId === 'mem_arjun')!;
    const dm = [
      msg({
        lane: 'dm',
        conversationId: 'dm:h_arjun',
        dmHandle: 'h_arjun',
        card: ticket('mem_arjun'),
      }),
      msg({
        lane: 'dm',
        conversationId: 'dm:h_arjun',
        dmHandle: 'h_arjun',
        card: ticket('mem_crowley'),
      }),
      msg({
        lane: 'dm',
        conversationId: 'dm:h_arjun',
        dmHandle: 'h_arjun',
        card: expense('private', 'mem_chase'),
      }),
    ];
    const thread = buildDmThread(BARCELONA, arjun, view([], { h_arjun: dm }), AT);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.kind === 'message' && thread[0]!.card?.type).toBe('ticket');
  });

  it('cardVisibleTo: private expense only to its payer, ticket only to deliveredTo', () => {
    expect(cardVisibleTo(expense('private', 'mem_crowley'), 'mem_crowley')).toBe(true);
    expect(cardVisibleTo(expense('private', 'mem_crowley'), 'mem_dean')).toBe(false);
    expect(cardVisibleTo(ticket('mem_dean'), 'mem_dean')).toBe(true);
    expect(cardVisibleTo(ticket('mem_dean'), 'mem_henry')).toBe(false);
  });

  it('drops outbound DMs that belong to another group', () => {
    const arjun = BARCELONA.members.find((m) => m.memberId === 'mem_arjun')!;
    const other = msg({
      lane: 'dm',
      conversationId: 'dm:h_arjun',
      text: 'from another trip',
      outbound: {
        id: 'o1',
        groupId: 'grp_other',
        to: { kind: 'member', memberId: 'mem_arjun' },
        text: 'x',
      },
    });
    expect(buildDmThread(BARCELONA, arjun, view([], { h_arjun: [other] }), AT)).toEqual([]);
  });
});

describe('reactions and empty groups', () => {
  it('summarizes tapbacks, honoring removals', () => {
    expect(
      summarizeReactions([
        { handle: 'h_dean', reaction: '👍', removed: false },
        { handle: 'h_chase', reaction: '👍', removed: false },
        { handle: 'h_dean', reaction: '👍', removed: true },
        { handle: 'h_crowley', reaction: '❤️', removed: false },
      ]),
    ).toEqual([
      { reaction: '👍', count: 1, by: ['h_chase'] },
      { reaction: '❤️', count: 1, by: ['h_crowley'] },
    ]);
    expect(summarizeReactions(undefined)).toEqual([]);
  });

  it('an empty transcript gives an empty thread, empty DMs and no preview', () => {
    const state = buildState({
      version: 1,
      backend: 'agent',
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

describe('group flight options cards (T-074 review r1 #2)', () => {
  function flightOptions(cardId: string): RichCard {
    return {
      cardId,
      type: 'options',
      title: 'flights into BCN',
      fallbackText: 'flights for 6 into BCN thu mar 12',
      context: 'flights for 6 into BCN thu mar 12',
      options: [
        {
          id: `${cardId}#1`,
          index: 1,
          label: 'everyone lands within 3h',
          price: eur(295600),
          refundable: true,
          tradeoff: '',
        },
      ],
      pickAction: { id: 'pick', label: 'Book this one', style: 'secondary', textAliases: [] },
      status: 'pending',
    };
  }
  const stateOf = (e: ReturnType<typeof buildGroupThread>[number] | undefined) =>
    e?.kind === 'message' ? e.cardState : undefined;

  it('a newer search drops the older card (buttons dead); the newest stays pickable', () => {
    const thread = buildGroupThread(
      BARCELONA,
      view([
        msg({ card: flightOptions('card_a') }),
        msg({ text: 'hm' }),
        msg({ card: flightOptions('card_b') }),
      ]),
      AT,
    );
    expect(stateOf(thread[0])).toMatchObject({
      status: 'dropped',
      label: 'Replaced by newer flight options',
      liveActionIds: [],
    });
    expect(stateOf(thread[2])).toEqual({ status: 'pending', liveActionIds: ['pick'] });
  });
});
