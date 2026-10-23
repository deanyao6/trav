import { describe, expect, it } from 'vitest';
import { safety } from '@trav/core';
import type { BookingProposalCard, ReceiptCard, TicketCard } from '@trav/core';
import type { GroupView, SimState, ThreadEntry, ThreadMessage } from '../shared/types.js';
import { BARCELONA, RAZZMATAZZ_ASK } from './groups.js';
import {
  BARCELONA_SEED,
  SCRIPTED_TEXT,
  createScriptedBackend,
  isScriptedRazzAsk,
} from './scripted.js';
import type { ScriptedBackend } from './scripted.js';

function bcn(state: SimState): GroupView {
  const g = state.groups.find((x) => x.group.groupId === BARCELONA.groupId);
  if (!g) throw new Error('no barcelona');
  return g;
}

function messages(entries: readonly ThreadEntry[]): ThreadMessage[] {
  return entries.filter((e): e is ThreadMessage => e.kind === 'message');
}

function travMessages(view: GroupView): ThreadMessage[] {
  return messages(view.thread).filter((m) => m.isTrav);
}

function proposalMessage(
  view: GroupView,
  index = 0,
): ThreadMessage & { card: BookingProposalCard } {
  const list = messages(view.thread).filter((m) => m.card?.type === 'booking_proposal');
  const m = list[index];
  if (!m || m.card?.type !== 'booking_proposal') throw new Error(`no proposal #${index}`);
  return m as ThreadMessage & { card: BookingProposalCard };
}

async function askForTickets(
  b: ScriptedBackend,
): Promise<ThreadMessage & { card: BookingProposalCard }> {
  await b.inject({
    type: 'message',
    from: 'h_dean',
    text: RAZZMATAZZ_ASK,
    groupId: BARCELONA.groupId,
  });
  return proposalMessage(bcn(b.state()));
}

const PROPER = [
  'Dean',
  'Henry',
  'Maya',
  'Jordan',
  'Priya',
  'Sam',
  'Razzmatazz',
  'QR',
  'DMs',
  'Barcelona',
  'Lisbon',
];

describe('scripted backend: VOICE §9.5 demo state 1', () => {
  it('seeds six members chatting and Trav silent', async () => {
    const b = await createScriptedBackend();
    const view = bcn(b.state());
    const msgs = messages(view.thread);
    expect(msgs).toHaveLength(BARCELONA_SEED.length);
    expect(new Set(msgs.map((m) => m.from)).size).toBe(6);
    expect(travMessages(view)).toHaveLength(0);
    expect(view.typing).toBe(false);
    for (const m of BARCELONA.members) expect(view.dms[m.memberId]).toEqual([]);
    expect(b.state().offline).toBe(true);
    expect(b.state().backend).toBe('scripted');
  });

  it('stays silent on a group message that does not address Trav', async () => {
    const b = await createScriptedBackend();
    await b.inject({
      type: 'message',
      from: 'h_sam',
      text: 'who has the apartment key',
      groupId: BARCELONA.groupId,
    });
    expect(travMessages(bcn(b.state()))).toHaveLength(0);
  });
});

describe('scripted backend: demo state 2 (the Razzmatazz ask)', () => {
  it('posts a booking_proposal for the five, Henry excluded, per VOICE §4.1 A', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    expect(p.text).toBe(
      [
        'razzmatazz tonight, 5 tickets',
        'Dean, Maya, Jordan, Priya, Sam (not Henry)',
        '€18 each · €90 total · refundable until 10pm',
        "charged to Dean's card, split 5 ways on the tab",
        '👍 to book. price held for 15 min',
      ].join('\n'),
    );
    expect(p.card.fallbackText).toBe(p.text);
    expect(p.card.charged.map((c) => c.name)).toEqual(['Dean', 'Maya', 'Jordan', 'Priya', 'Sam']);
    expect(p.card.excluded?.map((e) => e.name)).toEqual(['Henry']);
    // Shares sum to the total in integer minor units.
    const sum = p.card.charged.reduce((s, c) => s + (c.share?.amountMinor ?? 0), 0);
    expect(sum).toBe(p.card.total.amountMinor);
    expect(p.card.total).toEqual({ amountMinor: 9000, currency: 'EUR' });
    expect(p.actions.map((a) => a.id)).toEqual(['approve', 'not_me', 'decline']);
    expect(p.cardState).toEqual({
      status: 'pending',
      liveActionIds: ['approve', 'not_me', 'decline'],
    });
    // The health reason is never repeated back.
    expect(p.text).not.toMatch(/sick/i);
    expect(JSON.stringify(p.card)).not.toMatch(/sick/i);
  });

  it('shows the typing indicator while Trav works, then clears it', async () => {
    const b = await createScriptedBackend({ responseDelayMs: 5 });
    const seen: boolean[] = [];
    b.subscribe(() => seen.push(bcn(b.state()).typing));
    await askForTickets(b);
    expect(seen).toContain(true);
    expect(bcn(b.state()).typing).toBe(false);
  });

  it('a second ask while the proposal is open does not create another', async () => {
    const b = await createScriptedBackend();
    await askForTickets(b);
    await b.inject({
      type: 'message',
      from: 'h_maya',
      text: '@trav razzmatazz tickets?',
      groupId: BARCELONA.groupId,
    });
    const view = bcn(b.state());
    expect(messages(view.thread).filter((m) => m.card?.type === 'booking_proposal')).toHaveLength(
      1,
    );
    expect(travMessages(view).at(-1)?.text).toBe(SCRIPTED_TEXT.alreadyPending);
  });

  it('answers an unknown @trav ask with the scripted hint, and "thanks trav" with a ❤️ only', async () => {
    const b = await createScriptedBackend();
    await b.inject({
      type: 'message',
      from: 'h_priya',
      text: '@trav what time is it',
      groupId: BARCELONA.groupId,
    });
    expect(travMessages(bcn(b.state())).at(-1)?.text).toBe(SCRIPTED_TEXT.unknownAsk);
    const before = travMessages(bcn(b.state())).length;
    await b.inject({
      type: 'message',
      from: 'h_priya',
      text: 'thanks trav',
      groupId: BARCELONA.groupId,
    });
    const view = bcn(b.state());
    expect(travMessages(view)).toHaveLength(before);
    expect(messages(view.thread).at(-1)?.reactions).toEqual([
      { reaction: '❤️', count: 1, by: ['trav'] },
    ]);
  });
});

describe('scripted backend: demo state 3 (approve ⇒ receipt + 5 DMs)', () => {
  it('Approve from Dean posts the receipt in the group and one ticket DM to each of the five', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    const state = b.state();
    const view = bcn(state);
    const receiptMsg = travMessages(view).find((m) => m.card?.type === 'receipt');
    expect(receiptMsg).toBeDefined();
    const receipt = receiptMsg!.card as ReceiptCard;
    expect(receiptMsg!.text).toBe(
      [
        'booked ✅ razzmatazz, 5 tickets, €90',
        'order RZ-48213 · refundable until 10pm',
        'QR codes are in your dms, one each',
        'tab: Maya, Jordan, Priya, Sam → Dean €18',
      ].join('\n'),
    );
    expect(receipt.proposalId).toBe(p.card.proposalId);
    expect(receipt.ledger.split.map((s) => s.memberId)).toEqual([
      'mem_dean',
      'mem_maya',
      'mem_jordan',
      'mem_priya',
      'mem_sam',
    ]);
    expect(receipt.ledger.split.reduce((s, x) => s + (x.share?.amountMinor ?? 0), 0)).toBe(
      receipt.total.amountMinor,
    );

    // The proposal card now shows "Approved by Dean" and has no live buttons.
    const after = proposalMessage(view);
    expect(after.cardState?.status).toBe('approved');
    expect(after.cardState?.label).toBe('Approved by Dean');
    expect(after.cardState?.liveActionIds).toEqual([]);

    // Five ticket DMs, each addressed to its owner; Henry's DM is empty.
    for (const m of BARCELONA.members) {
      const dm = messages(view.dms[m.memberId] ?? []);
      if (m.memberId === 'mem_henry') {
        expect(dm).toEqual([]);
        continue;
      }
      expect(dm).toHaveLength(1);
      const t = dm[0]!.card as TicketCard;
      expect(t.type).toBe('ticket');
      expect(t.deliveredTo).toBe(m.memberId);
      expect(t.ownerMemberId).toBe(m.memberId);
      expect(t.holderName).toBe(m.name);
      expect(t.qr.dataUrl.startsWith('data:image/svg+xml')).toBe(true);
      expect(dm[0]!.text).toContain("don't forward it");
    }

    // Privacy: nothing ticket-shaped anywhere in the group thread payload.
    const groupJson = JSON.stringify(view.thread);
    expect(groupJson).not.toContain('"type":"ticket"');
    expect(groupJson).not.toContain('TRAV-MOCK-TICKET');
    expect(groupJson).not.toContain('data:image/svg+xml');
  });

  it('a 👍 tapback approves exactly like the button (one approval path)', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'reaction',
      from: 'h_dean',
      targetMessageId: p.messageId,
      reaction: '👍',
    });
    expect(b.bookingCount()).toBe(1);
    expect(travMessages(bcn(b.state())).some((m) => m.card?.type === 'receipt')).toBe(true);
  });

  it('a double approve (button then 👍, then another member) never books twice', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    await b.inject({
      type: 'reaction',
      from: 'h_dean',
      targetMessageId: p.messageId,
      reaction: '👍',
    });
    await b.inject({
      type: 'button_tap',
      from: 'h_maya',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    expect(b.bookingCount()).toBe(1);
    const view = bcn(b.state());
    expect(travMessages(view).filter((m) => m.card?.type === 'receipt')).toHaveLength(1);
    expect(messages(view.dms['mem_sam'] ?? [])).toHaveLength(1);
  });

  it('Henry (not charged) tapping approve is ignored silently (VOICE §6.2)', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    const before = travMessages(bcn(b.state())).length;
    await b.inject({
      type: 'button_tap',
      from: 'h_henry',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    expect(b.bookingCount()).toBe(0);
    expect(travMessages(bcn(b.state()))).toHaveLength(before);
    expect(proposalMessage(bcn(b.state())).cardState?.status).toBe('pending');
  });

  it('a charged member other than the requester can approve (any_one); the card is still on Dean', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_sam',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    expect(b.bookingCount()).toBe(1);
    const view = bcn(b.state());
    expect(proposalMessage(view).cardState?.label).toBe('Approved by Sam');
    const receipt = travMessages(view).find((m) => m.card?.type === 'receipt')!.card as ReceiptCard;
    expect(receipt.paidBy).toEqual({ kind: 'member_card', memberId: 'mem_dean' });
  });

  it('"yes" as a reply approves like the button', async () => {
    const b = await createScriptedBackend();
    await askForTickets(b);
    await b.inject({ type: 'message', from: 'h_dean', text: 'yes', groupId: BARCELONA.groupId });
    expect(b.bookingCount()).toBe(1);
  });

  it('an ask after booking points at the existing order instead of buying again', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    await b.inject({
      type: 'message',
      from: 'h_dean',
      text: RAZZMATAZZ_ASK,
      groupId: BARCELONA.groupId,
    });
    expect(b.bookingCount()).toBe(1);
    expect(travMessages(bcn(b.state())).at(-1)?.text).toBe(SCRIPTED_TEXT.alreadyBooked('RZ-48213'));
  });
});

describe('scripted backend: concurrent events', () => {
  it('two asks sent at once (during the typing pause) make one proposal, and typing lasts until both finish', async () => {
    const b = await createScriptedBackend({ responseDelayMs: 10 });
    const typingFrames: boolean[] = [];
    b.subscribe(() => typingFrames.push(bcn(b.state()).typing));
    await Promise.all([
      b.inject({ type: 'message', from: 'h_dean', text: RAZZMATAZZ_ASK }),
      b.inject({ type: 'message', from: 'h_maya', text: '@trav razzmatazz for us' }),
    ]);
    const view = bcn(b.state());
    expect(messages(view.thread).filter((m) => m.card?.type === 'booking_proposal')).toHaveLength(
      1,
    );
    expect(travMessages(view).at(-1)?.text).toBe(SCRIPTED_TEXT.alreadyPending);
    // Once on, typing never flickers off before the last turn ends.
    const firstOn = typingFrames.indexOf(true);
    const lastOn = typingFrames.lastIndexOf(true);
    expect(typingFrames.slice(firstOn, lastOn + 1).every(Boolean)).toBe(true);
    expect(view.typing).toBe(false);
  });

  it('a double-click on Approve during the pause books once', async () => {
    const b = await createScriptedBackend({ responseDelayMs: 10 });
    const p = await askForTickets(b);
    const tap = {
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    } as const;
    await Promise.all([b.inject(tap), b.inject(tap)]);
    expect(b.bookingCount()).toBe(1);
  });
});

describe('scripted backend: not me, decline, expiry', () => {
  it('"Not me" from Sam supersedes with a 4-person proposal; the old card loses its buttons', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_sam',
      cardMessageId: p.messageId,
      actionId: 'not_me',
    });
    const view = bcn(b.state());
    const old = proposalMessage(view, 0);
    const next = proposalMessage(view, 1);
    expect(old.cardState?.status).toBe('superseded');
    expect(old.cardState?.label).toBe('Replaced · Sam is out');
    expect(old.cardState?.liveActionIds).toEqual([]);
    expect(next.card.quantity).toBe(4);
    expect(next.card.total.amountMinor).toBe(7200);
    expect(next.text.split('\n')[1]).toBe('Dean, Maya, Jordan, Priya (not Henry, Sam)');
    // Approving the dead card does nothing; the new one books 4.
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    expect(b.bookingCount()).toBe(0);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: next.messageId,
      actionId: 'approve',
    });
    expect(b.bookingCount()).toBe(1);
    const after = bcn(b.state());
    expect(messages(after.dms['mem_sam'] ?? [])).toEqual([]);
    expect(messages(after.dms['mem_priya'] ?? [])).toHaveLength(1);
  });

  it('Decline from a charged member drops it with no charge', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_maya',
      cardMessageId: p.messageId,
      actionId: 'decline',
    });
    const view = bcn(b.state());
    expect(travMessages(view).at(-1)?.text).toBe(SCRIPTED_TEXT.declined);
    expect(proposalMessage(view).cardState).toMatchObject({
      status: 'declined',
      label: 'Declined by Maya',
    });
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    expect(b.bookingCount()).toBe(0);
  });

  it('after the 15-minute hold the card shows Expired and an approve says so once, no charge', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    b.clock.advanceMs(16 * 60_000);
    expect(proposalMessage(bcn(b.state())).cardState?.status).toBe('expired');
    await b.inject({
      type: 'reaction',
      from: 'h_dean',
      targetMessageId: p.messageId,
      reaction: '👍',
    });
    await b.inject({
      type: 'reaction',
      from: 'h_maya',
      targetMessageId: p.messageId,
      reaction: '👍',
    });
    expect(b.bookingCount()).toBe(0);
    const notices = travMessages(bcn(b.state())).filter((m) => m.text === SCRIPTED_TEXT.expired);
    expect(notices).toHaveLength(1);
  });

  it('everyone opting out drops the proposal', async () => {
    const b = await createScriptedBackend();
    let p = await askForTickets(b);
    for (const h of ['h_dean', 'h_maya', 'h_jordan', 'h_priya', 'h_sam']) {
      const view = bcn(b.state());
      const all = messages(view.thread).filter((m) => m.card?.type === 'booking_proposal');
      p = all[all.length - 1] as typeof p;
      await b.inject({
        type: 'button_tap',
        from: h,
        cardMessageId: p.messageId,
        actionId: 'not_me',
      });
    }
    expect(travMessages(bcn(b.state())).at(-1)?.text).toBe(SCRIPTED_TEXT.everyoneOut);
    expect(b.bookingCount()).toBe(0);
  });
});

describe('scripted backend: channel identity checks and reset', () => {
  it('rejects a sender who is not in the chat and a button that was never rendered', async () => {
    const b = await createScriptedBackend();
    await expect(
      b.inject({
        type: 'message',
        from: 'h_stranger',
        text: '@trav hi',
        groupId: BARCELONA.groupId,
      }),
    ).rejects.toThrow(/not in/);
    await expect(
      b.inject({ type: 'message', from: 'h_lis_dad', text: 'hi', groupId: BARCELONA.groupId }),
    ).rejects.toThrow(/not in/);
    const p = await askForTickets(b);
    await expect(
      b.inject({
        type: 'button_tap',
        from: 'h_dean',
        cardMessageId: p.messageId,
        actionId: 'paid',
      }),
    ).rejects.toThrow(/no paid button/);
  });

  it("a member cannot tap a button on someone else's ticket DM", async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    const priyaTicket = messages(bcn(b.state()).dms['mem_priya'] ?? [])[0]!;
    await expect(
      b.inject({
        type: 'reaction',
        from: 'h_sam',
        targetMessageId: priyaTicket.messageId,
        reaction: '👍',
      }),
    ).rejects.toThrow(/another member's DM/);
  });

  it('reset returns to demo state 1 with a higher version', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    const v = b.state().version;
    let notified = 0;
    b.subscribe(() => (notified += 1));
    await b.reset();
    const state = b.state();
    expect(state.version).toBeGreaterThan(v);
    expect(notified).toBeGreaterThan(0);
    expect(travMessages(bcn(state))).toHaveLength(0);
    expect(b.bookingCount()).toBe(0);
    // And the flow works again after reset (same order ref: deterministic).
    const p2 = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p2.messageId,
      actionId: 'approve',
    });
    expect(travMessages(bcn(b.state())).at(-1)?.text).toContain('order RZ-48213');
  });

  it('other trips answer a mention with one scripted line and never book', async () => {
    const b = await createScriptedBackend();
    await b.inject({
      type: 'message',
      from: 'h_tci_mom',
      text: '@trav razzmatazz for us?',
      groupId: 'grp_turks_caicos',
    });
    const tci = b.state().groups.find((g) => g.group.groupId === 'grp_turks_caicos')!;
    expect(
      messages(tci.thread)
        .filter((m) => m.isTrav)
        .map((m) => m.text),
    ).toEqual([SCRIPTED_TEXT.otherGroup]);
    expect(b.bookingCount()).toBe(0);
  });

  it('a DM to Trav is answered in the DM only', async () => {
    const b = await createScriptedBackend();
    await b.inject({ type: 'message', from: 'h_priya', text: 'hey', lane: 'dm' });
    const view = bcn(b.state());
    expect(messages(view.dms['mem_priya'] ?? []).map((m) => m.text)).toEqual([
      'hey',
      SCRIPTED_TEXT.dm,
    ]);
    expect(travMessages(view)).toHaveLength(0);
  });
});

describe('scripted text follows VOICE (lintVoice)', () => {
  it('every scripted Trav string passes the voice linter', async () => {
    const b = await createScriptedBackend();
    const p = await askForTickets(b);
    await b.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: p.messageId,
      actionId: 'approve',
    });
    const view = bcn(b.state());
    const receipt = travMessages(view).find((m) => m.card?.type === 'receipt')!;
    const ticket = messages(view.dms['mem_priya'] ?? [])[0]!;
    const cases: [string, safety.MessageKind][] = [
      [p.text, 'proposal'],
      [receipt.text, 'receipt'],
      [ticket.text, 'dm'],
      [SCRIPTED_TEXT.unknownAsk, 'reply'],
      [SCRIPTED_TEXT.otherGroup, 'reply'],
      [SCRIPTED_TEXT.dm, 'dm'],
      [SCRIPTED_TEXT.alreadyBooked('RZ-48213'), 'reply'],
      [SCRIPTED_TEXT.alreadyPending, 'reply'],
      [SCRIPTED_TEXT.declined, 'reply'],
      [SCRIPTED_TEXT.everyoneOut, 'reply'],
      [SCRIPTED_TEXT.expired, 'reply'],
    ];
    for (const [text, kind] of cases) {
      const result = safety.lintVoice(text, { kind, properNouns: PROPER });
      expect(result.violations, text).toEqual([]);
    }
  });
});

describe('isScriptedRazzAsk', () => {
  it('answers the general-admission ask, not the VIP mezzanine or a roster question', () => {
    expect(isScriptedRazzAsk(RAZZMATAZZ_ASK)).toBe(true);
    expect(isScriptedRazzAsk('@trav razzmatazz tickets?')).toBe(true);
    expect(isScriptedRazzAsk('@trav razzmatazz for us')).toBe(true);
    expect(isScriptedRazzAsk('@trav book the razz vip mezzanine for all 6 tonight')).toBe(false);
    expect(isScriptedRazzAsk("@trav who's in for razzmatazz tonight?")).toBe(false);
    expect(isScriptedRazzAsk('@trav who is coming to razz')).toBe(false);
    expect(isScriptedRazzAsk('@trav dinner at 9')).toBe(false);
  });

  it('a VIP ask gets the scripted "only know the razzmatazz ask" line, no proposal', async () => {
    const b = await createScriptedBackend();
    await b.inject({
      type: 'message',
      from: 'h_sam',
      text: '@trav book the razz vip mezzanine for all 6 tonight',
      groupId: BARCELONA.groupId,
    });
    const view = bcn(b.state());
    expect(messages(view.thread).some((m) => m.card?.type === 'booking_proposal')).toBe(false);
    expect(travMessages(view).map((m) => m.text)).toEqual([SCRIPTED_TEXT.unknownAsk]);
  });
});

describe('approval label', () => {
  it("names the approval that booked it: Dean's 👍, not a later no-op Approve from Sam", async () => {
    const b = await createScriptedBackend();
    await b.inject({ type: 'message', from: 'h_dean', text: RAZZMATAZZ_ASK, groupId: BARCELONA.groupId });
    const p = proposalMessage(bcn(b.state()));
    await b.inject({ type: 'reaction', from: 'h_dean', targetMessageId: p.messageId, reaction: '👍' });
    await b.inject({ type: 'button_tap', from: 'h_sam', cardMessageId: p.messageId, actionId: 'approve' }).catch(
      () => undefined, // the channel may refuse a tap on a collapsed button; either way nothing changes
    );
    const after = proposalMessage(bcn(b.state()));
    expect(after.cardState?.label).toBe('Approved by Dean');
    expect(b.bookingCount()).toBeLessThanOrEqual(1);
  });
});
