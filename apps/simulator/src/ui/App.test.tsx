/**
 * Server-renders the UI against real `SimState` payloads from the real offline
 * backend (demo states 1–3) and against one fixture of every card type. This
 * is the no-browser half of the UI check; e2e/smoke.spec.ts clicks through
 * the same states in Chromium.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  ExpenseConfirmCard,
  OptionsCard,
  RecapCard,
  RichCard,
  SettleUpCard,
  WrappedCard,
} from '@trav/core';
import type { SimState, ThreadMessage } from '../shared/types.js';
import { BARCELONA, RAZZMATAZZ_ASK, RAZZMATAZZ_CARD_ASK } from '../server/groups.js';
import { demoBackend } from '../server/testkit.js';
import { AppView } from './App.js';
import type { AppViewProps } from './App.js';
import { Card, settleTextLines } from './components/Cards.js';

const noop = () => {};
const handlers = { onAction: noop, onReact: noop };

function render(state: SimState, meHandle: string, over: Partial<AppViewProps> = {}): string {
  const me = BARCELONA.members.find((m) => m.handle === meHandle)!;
  return renderToStaticMarkup(
    <AppView
      state={state}
      groupId={BARCELONA.groupId}
      meHandle={meHandle}
      dmMemberId={me.memberId}
      highlightDms={[]}
      draft=""
      onSelectGroup={noop}
      onSelectMe={noop}
      onSelectDm={noop}
      onDraft={noop}
      onSend={noop}
      handlers={handlers}
      {...over}
    />,
  );
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** T-168: the flagship buys on the ask, so its state after the ask is the receipt. */
async function boughtOnAsk() {
  const b = await demoBackend();
  await b.inject({
    type: 'message',
    from: 'h_dean',
    text: RAZZMATAZZ_ASK,
    groupId: BARCELONA.groupId,
  });
  return b.state();
}

/** The one-tap card states, from the same ask said as a question. */
async function states() {
  const b = await demoBackend();
  const s1 = b.state();
  await b.inject({
    type: 'message',
    from: 'h_dean',
    text: RAZZMATAZZ_CARD_ASK,
    groupId: BARCELONA.groupId,
  });
  const s2 = b.state();
  const proposal = s2.groups[0]!.thread.find(
    (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'booking_proposal',
  )!;
  await b.inject({
    type: 'button_tap',
    from: 'h_dean',
    cardMessageId: proposal.messageId,
    actionId: 'approve',
  });
  const s3 = b.state();
  return { s1, s2, s3 };
}

describe('AppView renders demo states 1–3', () => {
  it('state 1: trip list, send-as picker, six members chatting, offline badge, no Trav bubble', async () => {
    const { s1 } = await states();
    const html = render(s1, 'h_dean');
    expect(html).toContain('data-testid="offline-badge"');
    expect(html).not.toContain('scripted');
    for (const g of ['grp_barcelona', 'grp_lisbon', 'grp_turks_caicos'])
      expect(html).toContain(`trip-${g}`);
    for (const m of BARCELONA.members) expect(html).toContain(`data-testid="sendas-${m.handle}"`);
    expect(count(html, 'data-testid="bubble"')).toBe(7);
    expect(html).not.toContain('bubble-trav');
    expect(html).not.toContain('data-testid="card-');
    expect(html).toContain('sat mar 14 · 9:39pm · day 3');
    // The demo hint for Dean is one click away.
    expect(html).toContain('data-testid="hint"');
  });

  it("state 2: proposal card with buttons for Dean; Henry sees 'waiting on'", async () => {
    const { s2 } = await states();
    const dean = render(s2, 'h_dean');
    expect(dean).toContain('data-testid="card-booking_proposal"');
    expect(dean).toContain('data-testid="action-approve"');
    expect(dean).toContain('data-testid="action-not_me"');
    expect(dean).toContain('data-testid="action-decline"');
    expect(dean).toContain('€18 each · €90 total');
    expect(dean).toContain('Razzmatazz · tonight 12am · 5 tickets');
    expect(dean).toContain('trav-avatar');
    expect(dean).not.toContain('data-testid="hint"');
    const henry = render(s2, 'h_henry');
    expect(henry).not.toContain('data-testid="action-approve"');
    // Any one of the 5 charged can ok it under the cap; Henry is not charged, so not named.
    expect(henry).toContain('waiting on Dean, Chase +3');
  });

  it('state 2 (T-168): the flagship ask buys on the ask: receipt in the group, no proposal buttons, 5 DM tabs with a ticket, Henry empty', async () => {
    const s = await boughtOnAsk();
    const html = render(s, 'h_dean');
    expect(html).toContain('data-testid="card-receipt"');
    expect(html).not.toContain('data-testid="card-booking_proposal"');
    expect(html).not.toContain('data-testid="action-approve"');
    expect(html).toContain('RZ-48213');
    expect(html).toContain('5 tickets sent');
    expect(html).toContain('data-testid="dm-tab-mem_henry" data-count="0"');
    for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
      expect(html).toContain(`data-testid="dm-tab-${id}" data-count="1"`);
    }
  });

  it('state 2: the typing indicator renders while Trav works', async () => {
    const { s1 } = await states();
    const typing: SimState = {
      ...s1,
      groups: s1.groups.map((g, i) => (i === 0 ? { ...g, typing: true } : g)),
    };
    expect(render(typing, 'h_dean')).toContain('data-testid="typing"');
    expect(render(s1, 'h_dean')).not.toContain('data-testid="typing"');
  });

  it('state 3: receipt in the group, proposal shows Approved by Dean, 5 DM tabs with a ticket, Henry empty', async () => {
    const { s3 } = await states();
    const html = render(s3, 'h_dean');
    expect(html).toContain('data-testid="card-receipt"');
    expect(html).toContain('Approved by Dean');
    expect(html).not.toContain('data-testid="action-approve"');
    expect(html).toContain('RZ-48213');
    expect(html).toContain('5 tickets sent');
    expect(html).toContain('data-testid="dm-tab-mem_henry" data-count="0"');
    for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
      expect(html).toContain(`data-testid="dm-tab-${id}" data-count="1"`);
    }
    // Dean's own DM tab is open: his ticket renders there (once), with the lock line.
    expect(count(html, 'data-testid="card-ticket"')).toBe(1);
    expect(html).toContain('only Dean sees this');
    const henryView = render(s3, 'h_henry');
    expect(henryView).not.toContain('data-testid="card-ticket"');
    expect(henryView).toContain('nothing here yet');
  });

  it('a silent tap shows the muted status line', async () => {
    const { s2 } = await states();
    expect(render(s2, 'h_dean')).not.toContain('data-testid="sim-status"');
    const html = render(
      {
        ...s2,
        groups: s2.groups.map((g, i) =>
          i === 0
            ? { ...g, status: 'trav stayed quiet on that tap (approval:not_an_approver)' }
            : g,
        ),
      },
      'h_dean',
    );
    expect(html).toContain('data-testid="sim-status"');
    expect(html).toContain('approval:not_an_approver');
    // It is chrome, never a Trav bubble.
    expect(count(html, 'data-testid="bubble-trav"')).toBe(
      count(render(s2, 'h_dean'), 'data-testid="bubble-trav"'),
    );
  });

  it("another member's DM tab is view-only: no card buttons, no tapback picker", async () => {
    const { s3 } = await states();
    const crowley = BARCELONA.members.find((m) => m.handle === 'h_crowley')!;
    const privateExpense: ExpenseConfirmCard = {
      ...expense,
      cardId: 'card_private',
      visibility: 'private',
      status: 'pending',
      paidBy: crowley.memberId,
    };
    const shareIt = {
      id: 'confirm',
      label: 'Share it',
      style: 'primary',
      textAliases: ['share'],
      allowedMemberIds: [crowley.memberId],
    } as const;
    const dmCard: ThreadMessage = {
      ...cardMessage(privateExpense, [shareIt]),
      lane: 'dm',
      messageId: 'm_crowley_private',
    };
    const state: SimState = {
      ...s3,
      groups: s3.groups.map((g, i) =>
        i === 0 ? { ...g, dms: { ...g.dms, [crowley.memberId]: [dmCard] } } : g,
      ),
    };
    const dmPart = (html: string) => html.slice(html.indexOf('class="right-rail"'));

    // Sending as Dean, looking at Crowley's DM: look, don't tap.
    const asDean = dmPart(render(state, 'h_dean', { dmMemberId: crowley.memberId }));
    expect(asDean).toContain('only Crowley sees this');
    expect(asDean).toContain('data-testid="dm-readonly"');
    expect(asDean).toContain('€84');
    expect(asDean).not.toContain('>Share it<');
    expect(asDean).toContain('data-tapbacks="off"');
    expect(asDean).not.toContain('data-tapbacks="on"');

    // Sending as Crowley, Crowley's own DM: the buttons and tapbacks are live.
    const asCrowley = dmPart(render(state, 'h_crowley', { dmMemberId: crowley.memberId }));
    expect(asCrowley).not.toContain('data-testid="dm-readonly"');
    expect(asCrowley).toContain('>Share it<');
    expect(asCrowley).toContain('data-tapbacks="on"');
  });

  it('the group thread markup never contains a ticket, whoever is selected', async () => {
    const { s3 } = await states();
    for (const m of BARCELONA.members) {
      const html = render(s3, m.handle);
      const thread = html.slice(
        html.indexOf('data-testid="thread"'),
        html.indexOf('class="right-rail"'),
      );
      expect(thread).not.toContain('card-ticket');
      expect(thread).not.toContain('TRAV-MOCK-TICKET');
    }
  });
});

// ---------- every card type renders from its RichCard shape ----------

const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR' });

const settle: SettleUpCard = {
  cardId: 'card_settle',
  type: 'settle_up',
  title: 'settle up',
  fallbackText: 'settle up',
  mode: 'final',
  asOf: '2026-03-17T10:00:00+01:00',
  currency: 'EUR',
  balances: [
    { memberId: 'mem_dean', name: 'Dean', net: eur(3160) },
    { memberId: 'mem_chase', name: 'Chase', net: eur(-3160) },
  ],
  transfers: [{ from: 'mem_chase', to: 'mem_dean', amount: eur(3160) }],
  totalSpent: eur(184000),
};

const expense: ExpenseConfirmCard = {
  cardId: 'card_exp',
  type: 'expense_confirm',
  title: 'logged',
  fallbackText: 'got it',
  expenseId: 'exp_1',
  status: 'logged',
  source: 'chat',
  visibility: 'group',
  description: 'dinner at Bodega Lluna',
  amount: eur(8400),
  paidBy: 'mem_dean',
  split: {
    method: 'exclude',
    participants: ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'].map(
      (memberId) => ({
        memberId,
        name: memberId,
        share: eur(1680),
      }),
    ),
    excluded: [{ memberId: 'mem_henry', name: 'Henry' }],
  },
};

const recap: RecapCard = {
  cardId: 'card_recap',
  type: 'recap',
  title: 'morning after ☀️',
  fallbackText: 'morning',
  kind: 'morning_after',
  date: '2026-03-15',
  dayNumber: 4,
  lastNight: {
    events: [{ label: 'Razzmatazz', attendees: ['mem_dean', 'mem_crowley'], amount: eur(9000) }],
    total: eur(9000),
  },
  settle: { ...settle, mode: 'running' },
  today: [
    { label: 'Barça vs Sevilla', startsAt: '2026-03-15T21:00:00+01:00', ticketsDelivered: true },
  ],
  photos: [],
};

const wrapped: WrappedCard = {
  cardId: 'card_wrapped',
  type: 'wrapped',
  title: 'wrapped',
  fallbackText: 'barcelona wrapped',
  trip: { name: 'Barcelona spring break', days: 6, people: 6, currency: 'EUR' },
  totals: {
    spent: eur(184000),
    perPerson: eur(30667),
    byCategory: [{ category: 'food', amount: eur(52000) }],
  },
  stats: [{ label: 'ubers', value: '23' }],
  awards: [
    {
      title: 'night owl',
      memberId: 'mem_crowley',
      evidence: 'latest receipt 4:12am',
      basis: 'ledger',
    },
  ],
  photos: [],
  finalSettle: settle,
  shareable: true,
};

const options: OptionsCard = {
  cardId: 'card_opts',
  type: 'options',
  title: 'options',
  fallbackText: 'nothing under €60',
  context: 'nothing for barça under €60 a head this sunday',
  options: [
    {
      id: 'o1',
      index: 1,
      label: 'upper corner',
      price: eur(7200),
      refundable: true,
      tradeoff: 'over the cap',
    },
    {
      id: 'o2',
      index: 2,
      label: 'behind the goal',
      price: eur(6800),
      refundable: false,
      tradeoff: 'non-refundable',
    },
  ],
  pickAction: { id: 'pick', label: 'Pick', style: 'primary', textAliases: ['1', '2'] },
  status: 'pending',
};

function cardMessage(card: RichCard, actions: ThreadMessage['actions'] = []): ThreadMessage {
  return {
    kind: 'message',
    seq: 1,
    at: '2026-03-15T10:00:00+01:00',
    lane: 'group',
    messageId: `m_${card.cardId}`,
    direction: 'outbound',
    from: 'trav',
    fromName: 'Trav',
    isTrav: true,
    text: card.fallbackText,
    card,
    actions,
    attachments: [],
    renderedAsCard: false,
    degraded: false,
    reactions: [],
    cardState: {
      status: 'pending',
      liveActionIds: [
        ...actions.map((a) => a.id),
        ...(card.type === 'options' ? ['pick' as const] : []),
      ],
    },
  };
}

describe('Card renders every RichCard type', () => {
  const me = BARCELONA.members[0]!;
  const r = (card: RichCard, actions: ThreadMessage['actions'] = []) =>
    renderToStaticMarkup(
      <Card msg={cardMessage(card, actions)} group={BARCELONA} me={me} onAction={noop} />,
    );

  it('expense_confirm: amount, split chips, Undo', () => {
    const html = r(expense, [
      { id: 'undo', label: 'Undo', style: 'secondary', textAliases: ['undo'] },
    ]);
    expect(html).toContain('€84');
    expect(html).toContain('€16.80');
    expect(html).toContain('not: Henry');
    expect(html).toContain('action-undo');
  });

  it('settle_up: + green / − red balances, transfer row with Paid', () => {
    const html = r(settle, [
      { id: 'paid', label: 'Paid', style: 'secondary', textAliases: ['paid'] },
    ]);
    expect(html).toContain('+€31.60');
    expect(html).toContain('-€31.60');
    expect(html).toContain('Chase → Dean €31.60');
    expect(html).toContain('>Paid<');
    expect(html).toContain('€1,840');
  });

  it('recap: last night rows, embedded settle, today', () => {
    const html = r(recap);
    expect(html).toContain('morning after ☀️');
    expect(html).toContain('Razzmatazz');
    expect(html).toContain('Barça vs Sevilla');
    expect(html).toContain('settle compact');
  });

  it('wrapped: header, stats, awards, Share', () => {
    const html = r(wrapped);
    expect(html).toContain('Barcelona spring break');
    expect(html).toContain('night owl');
    expect(html).toContain('€306.67');
    expect(html).toContain('>Share<');
  });

  it('options: numbered rows with a pick button per option', () => {
    const html = r(options, [
      { id: 'decline', label: 'Drop it', style: 'secondary', textAliases: ['drop it'] },
    ]);
    expect(html).toContain('1. upper corner');
    expect(html).toContain('data-testid="pick-1"');
    expect(html).toContain('data-testid="pick-2"');
    expect(html).toContain('>Drop it<');
    expect(html).toContain('non-refundable');
  });

  it('group flight options (T-074): each option lists who flies when for how much', () => {
    const flights: OptionsCard = {
      ...options,
      context: 'flights for 2 into BCN thu mar 12',
      options: [
        {
          id: 'card_f#1',
          index: 1,
          label: 'everyone lands within 1h',
          price: eur(95000),
          refundable: true,
          tradeoff: '',
          details: [
            'Dean BOS 7:10am → BCN 7:35pm · home 11am to JFK · €412',
            'Chase SFO wed 10:30pm → BCN 9:40pm, 1 stop · home 10am to LAX · €538',
          ],
        },
      ],
    };
    const html = r(flights);
    expect(html).toContain('data-testid="option-details-1"');
    expect(html).toContain('Dean BOS 7:10am → BCN 7:35pm · home 11am to JFK · €412');
    expect(html).toContain('Chase SFO wed 10:30pm');
  });

  it('an unknown card type renders its text fallback inside the panel, not an empty box', () => {
    const unknown = {
      cardId: 'card_future',
      type: 'poll',
      title: 'quick poll',
      fallbackText: 'tapas or paella tonight?\nreply 1 or 2',
    } as unknown as RichCard;
    const msg = { ...cardMessage(unknown), cardState: undefined } as unknown as ThreadMessage;
    const html = renderToStaticMarkup(<Card msg={msg} group={BARCELONA} me={me} onAction={noop} />);
    expect(html).toContain('data-testid="card-poll"');
    expect(html).toContain('data-testid="card-fallback"');
    expect(html).toContain('tapas or paella tonight?');
    expect(html).toContain('reply 1 or 2');
    // Empty msg.text: the card's own fallbackText is used.
    const bare = renderToStaticMarkup(
      <Card msg={{ ...msg, text: '' }} group={BARCELONA} me={me} onAction={noop} />,
    );
    expect(bare).toContain('tapas or paella tonight?');
  });

  it('readOnly: no buttons anywhere on the card (button row, digest items, options, settle Paid)', () => {
    const ro = (card: RichCard, actions: ThreadMessage['actions']) =>
      renderToStaticMarkup(
        <Card
          msg={cardMessage(card, actions)}
          group={BARCELONA}
          me={me}
          onAction={noop}
          readOnly
        />,
      );
    const undo = { id: 'undo', label: 'Undo', style: 'secondary', textAliases: [] } as const;
    expect(ro(expense, [undo])).not.toContain('<button');
    expect(ro(options, [])).not.toContain('<button');
    const paid = { id: 'paid', label: 'Paid', style: 'secondary', textAliases: [] } as const;
    expect(ro(settle, [paid])).not.toContain('<button');
    const digest: ExpenseConfirmCard = { ...expense, digestItems: [expense] };
    expect(ro(digest, [undo])).not.toContain('<button');
  });

  it('a resolved card shows its status chip instead of buttons', () => {
    const msg = {
      ...cardMessage(expense, [{ id: 'undo', label: 'Undo', style: 'secondary', textAliases: [] }]),
      cardState: { status: 'resolved', label: 'Undo · Dean', liveActionIds: [] },
    } as ThreadMessage;
    const html = renderToStaticMarkup(<Card msg={msg} group={BARCELONA} me={me} onAction={noop} />);
    expect(html).toContain('Undo · Dean');
    expect(html).not.toContain('action-undo');
  });
});

describe('AppView: settle card after Sent (T-197, QA-02)', () => {
  const lastSettle = (s: SimState): ThreadMessage =>
    s.groups[0]!.thread.filter(
      (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'settle_up',
    ).at(-1)!;
  /** The settle card only (the thread also holds the running tab and other cards). */
  const settlePart = (html: string, messageId: string): string => {
    const start = html.indexOf(`data-message-id="${messageId}"`);
    expect(start).toBeGreaterThan(0);
    const end = html.indexOf('data-message-id="', start + 20);
    return html.slice(start, end < 0 ? undefined : end);
  };

  async function settledThenSent() {
    const b = await demoBackend();
    await b.inject({
      type: 'message',
      from: 'h_dean',
      text: '@trav i paid €84 for dinner, split with everyone but Henry',
      groupId: BARCELONA.groupId,
    });
    await b.advanceClock!({ step: 'morning', groupId: BARCELONA.groupId });
    await b.inject({
      type: 'message',
      from: 'h_dean',
      text: '@trav settle now',
      groupId: BARCELONA.groupId,
    });
    const before = b.state();
    const card = lastSettle(before);
    expect(card.card?.type === 'settle_up' && card.card.mode).toBe('final');
    await b.inject({
      type: 'button_tap',
      from: 'h_chase',
      cardMessageId: card.messageId,
      actionId: 'sent',
    });
    return { b, before, after: b.state() };
  }

  it('before Sent: rows show the payment app and the "pay details are in your dms" line, no sent chip', async () => {
    const { before } = await settledThenSent();
    const msg = lastSettle(before);
    const html = settlePart(render(before, 'h_chase'), msg.messageId);
    expect(html).toContain('Chase → Dean €16.80');
    expect(html).toContain('data-testid="settle-rail"');
    expect(html).toMatch(/· (venmo|zelle|paypal|cash app|apple cash|cash)</);
    expect(html).toContain('data-testid="settle-footer"');
    expect(html).toContain('pay details are in your dms. tap Sent when you');
    expect(html).not.toContain('data-testid="settle-sent-chip"');
    expect(html).not.toContain('data-testid="settle-nudge"');
    expect(html).toContain('data-testid="action-sent"');
  });

  it("after Chase's Sent: Chase's row has the pending sent chip, Dean is nudged and has Got it", async () => {
    const { after } = await settledThenSent();
    const msg = lastSettle(after);
    const card = msg.card as SettleUpCard;
    const chase = card.transfers.find((t) => t.from === 'mem_chase')!;
    expect(chase.pending).toBe(true);
    expect(chase.paid).not.toBe(true);

    const dean = settlePart(render(after, 'h_dean'), msg.messageId);
    expect(dean).toContain('data-testid="settle-row-mem_chase-mem_dean"');
    expect(count(dean, 'data-testid="settle-sent-chip"')).toBe(1);
    expect(dean).toContain('Chase says sent');
    expect(dean).toContain('data-testid="settle-nudge"');
    expect(dean).toContain('Dean, tap Got it or 👍 once it lands');
    // The payee's own view highlights the nudge, and the Got it button is his.
    expect(dean).toContain('class="settle-nudge me"');
    expect(dean).toContain('data-testid="action-got_it"');
    // Still owed: not marked paid, and the instruction line stays.
    expect(dean).not.toContain('status-chip green">paid');
    expect(dean).toContain('pay details are in your dms');
    // The nudge is drawn once (the agent's lead line is the same text: not repeated).
    expect(count(dean, 'tap Got it or 👍 once it lands')).toBe(1);

    // Chase sees the same chip, no highlighted nudge, and no second Sent.
    const chaseView = settlePart(render(after, 'h_chase'), msg.messageId);
    expect(chaseView).toContain('Chase says sent');
    expect(chaseView).toContain('class="settle-nudge"');
    expect(chaseView).not.toContain('data-testid="action-sent"');
    expect(chaseView).not.toContain('data-testid="action-got_it"');
  });
});

describe('settleTextLines', () => {
  const final = (fallbackText: string, paid = false): SettleUpCard => ({
    ...settle,
    fallbackText,
    transfers: [{ ...settle.transfers[0]!, ...(paid ? { paid: true } : {}) }],
  });
  it('takes a lead only when the next line is the head, and never the Got it nudge', () => {
    expect(
      settleTextLines(
        final(
          "tab changed since that card, here's where it stands now\nfinal settle, 1 transfer and everyone's square\nChase → Dean €31.60\ntap Sent when you've paid. whoever's getting it taps Got it or 👍, that's what clears it",
        ),
      ),
    ).toEqual({
      lead: "tab changed since that card, here's where it stands now",
      footer:
        "tap Sent when you've paid. whoever's getting it taps Got it or 👍, that's what clears it",
    });
    expect(
      settleTextLines(
        final(
          "Dean, tap Got it or 👍 once it lands\nfinal settle, 1 transfer and everyone's square\nChase says sent €31.60 to Dean\npay details are in your dms. tap Sent when you've paid. whoever's getting it taps Got it or 👍, that's what clears it",
        ),
      ).lead,
    ).toBeUndefined();
  });
  it('no footer once everything is paid, and nothing for a running tab', () => {
    expect(
      settleTextLines(
        final("final settle, it's paid and everyone's square\nChase → Dean €31.60 · paid", true),
      ),
    ).toEqual({});
    expect(
      settleTextLines({ ...settle, mode: 'running', fallbackText: 'running tab\nx\ntap Sent' }),
    ).toEqual({});
  });
});

describe('AppView: composer receipt photo (T-199, QA-07)', () => {
  it('offers the trip fixture receipts, previews the attached one, and posted photos show in the thread', async () => {
    const b = await demoBackend();
    const s = b.state();
    const html = render(s, 'h_piotr', { onAttach: noop });
    expect(html).toContain('data-testid="composer-attach"');
    expect(html).toContain('receipt: gatblau');
    expect(html).toContain('receipt: lunch service');
    // Only this trip's receipts.
    expect(html).not.toContain('receipt: tasca');
    expect(html).not.toContain('data-testid="composer-attachment"');

    const picked = render(s, 'h_piotr', { onAttach: noop, attachment: 'rcpt_bcn_gatblau' });
    expect(picked).toContain('data-testid="composer-attachment"');
    expect(picked).toContain('src="/api/receipts/rcpt_bcn_gatblau.png"');
    expect(picked).toContain('data-testid="composer-attachment-remove"');

    // No handler (read-only view): no attach control.
    expect(render(s, 'h_piotr')).not.toContain('data-testid="composer-attach"');

    await b.inject({
      type: 'message',
      from: 'h_piotr',
      text: "@trav dinner, i paid, Arjun didn't drink",
      groupId: BARCELONA.groupId,
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          uri: 'fixtures/receipts/rcpt_bcn_gatblau.png',
        },
      ],
    });
    const after = render(b.state(), 'h_dean');
    expect(after).toContain('data-testid="attachments"');
    expect(after).toContain(
      'class="attachment-img" data-testid="attachment" src="/api/receipts/rcpt_bcn_gatblau.png"',
    );
    expect(after).toContain('€184');
  });
});

describe('Card: album photos on recaps and Wrapped (T-200, QA-08)', () => {
  const me = BARCELONA.members[0]!;
  const photos: RecapCard['photos'] = [
    {
      url: 'https://album.example.test/bcn/p1.jpg',
      byMemberId: 'mem_dean',
      alt: 'sunset at the bunkers',
    },
    { url: 'https://album.example.test/bcn/p2.jpg', byMemberId: 'mem_chase', alt: 'paella' },
    { url: 'https://album.example.test/bcn/p3.jpg', byMemberId: 'mem_crowley', alt: 'camp nou' },
    { url: 'https://album.example.test/bcn/p4.jpg', byMemberId: 'mem_arjun', alt: 'beach' },
  ];
  const r = (card: RichCard) =>
    renderToStaticMarkup(
      <Card msg={cardMessage(card, [])} group={BARCELONA} me={me} onAction={noop} />,
    );

  it('recap shows up to 3 photo tiles with owner and alt, never fetching the outside URL', () => {
    const html = r({ ...recap, photos });
    expect(html).toContain('data-testid="card-photos"');
    expect(count(html, 'data-testid="card-photo"')).toBe(3);
    expect(html).toContain('data-owner="mem_dean"');
    expect(html).toContain('aria-label="sunset at the bunkers"');
    expect(html).not.toContain('data-owner="mem_arjun"');
    expect(html).not.toContain('album.example.test');
  });

  it('Wrapped shows its highlights; no photos means no photo strip', () => {
    const html = r({ ...wrapped, photos });
    expect(count(html, 'data-testid="card-photo"')).toBe(4);
    expect(r(wrapped)).not.toContain('data-testid="card-photos"');
    expect(r(recap)).not.toContain('data-testid="card-photos"');
  });
});

describe('AppView: ledger notices (T-165)', () => {
  it('a system notice renders as the centered grey subscript, not a Trav bubble', async () => {
    const { s1 } = await states();
    const thread = s1.groups[0]!.thread;
    const last = thread[thread.length - 1]!;
    const notice: ThreadMessage = {
      kind: 'message',
      seq: last.seq + 1,
      at: last.at,
      lane: 'group',
      messageId: 'msg_notice_ui',
      direction: 'outbound',
      from: 'trav',
      fromName: 'trav',
      isTrav: true,
      text: 'Crowley added Uber €23.40 · 5 ways (not Henry)',
      actions: [],
      attachments: [],
      renderedAsCard: false,
      degraded: false,
      systemNotice: true,
      reactions: [],
    };
    const withNotice: SimState = {
      ...s1,
      groups: s1.groups.map((g, i) => (i === 0 ? { ...g, thread: [...g.thread, notice] } : g)),
    };
    const html = render(withNotice, 'h_dean');
    expect(html).toContain(
      '<div class="system-line system-notice" data-testid="system-notice" data-message-id="msg_notice_ui">Crowley added Uber €23.40 · 5 ways (not Henry)</div>',
    );
    expect(html).not.toContain('class="msg-row out" data-message-id="msg_notice_ui"');
    expect(count(html, 'data-testid="system-notice"')).toBe(1);
    expect(count(render(s1, 'h_dean'), 'data-testid="system-notice"')).toBe(0);
  });
});
