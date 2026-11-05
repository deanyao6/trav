/**
 * T-169: the simulator played over the relay (no agent): member actions in
 * the "world" become signed vendor webhooks, Trav's sends become vendor
 * requests and land in the world under vendor ids.
 */
import { describe, expect, it } from 'vitest';
import type { InboundEvent, InboundMessage } from '../../interfaces/channel.js';
import {
  BCN_CONVERSATION,
  PROPOSAL_ACTIONS,
  PROPOSAL_TEXT,
  action,
  barcelona,
  dmMsg,
  eur,
  groupMsg,
  manualClock,
  optionsCard,
  privateExpenseCard,
  proposalCard,
  ticketCard,
} from '../../channel/testing.js';
import type { SettleUpCard } from '@trav/core';
import type { TranscriptMessage } from '../../channel/simulator/index.js';
import { mockQrDataUrl } from '../tickets/qr.js';
import { createRelayLoopback } from './loopback.js';

function setup(vendor: 'photon' | 'sendblue') {
  const clock = manualClock('2026-03-14T21:40:00+01:00');
  const lb = createRelayLoopback({ vendor, clock, conversations: [barcelona] });
  const events: InboundEvent[] = [];
  lb.channel.onEvent((e) => {
    events.push(e);
  });
  return { clock, lb, events };
}

describe.each(['photon', 'sendblue'] as const)('relay loopback over %s', (vendor) => {
  it('a member message reaches Trav through a signed webhook, as the member handle', async () => {
    const t = setup(vendor);
    await t.lb.channel.injectMessage({ from: 'h_dean', text: '@trav hi' });
    expect(t.lb.relay.stats().webhooksAccepted).toBe(1);
    const m = t.events[0] as InboundMessage;
    expect(m).toMatchObject({
      channel: 'imessage_relay',
      sender: 'h_dean',
      text: '@trav hi',
      conversationId: BCN_CONVERSATION,
    });
    // The world shows it under the same vendor id Trav got.
    expect(t.lb.channel.groupTranscript()[0]).toMatchObject({
      messageId: m.messageId,
      direction: 'inbound',
    });
  });

  it("Trav's card goes out as text under a vendor id; a 👍 in the world points back at Trav's id", async () => {
    const t = setup(vendor);
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    expect((await t.lb.channel.sendGroup(BCN_CONVERSATION, card)).ok).toBe(true);
    const wire = t.lb.channel.groupTranscript().at(-1) as TranscriptMessage;
    expect(wire.messageId).toBe(t.lb.relay.vendorIdsOf(card.id)[0]);
    expect(wire.card).toBeUndefined();
    expect(wire.actions).toEqual([]);
    expect(wire.outbound?.card?.type).toBe('booking_proposal');
    await t.lb.channel.injectReaction({
      from: 'h_dean',
      targetMessageId: wire.messageId,
      reaction: '👍',
    });
    expect(t.events.at(-1)).toMatchObject({
      type: 'reaction',
      targetMessageId: card.id,
      reaction: '👍',
      sender: 'h_dean',
    });
    // No buttons on iMessage.
    await expect(
      t.lb.channel.injectButtonTap({
        from: 'h_dean',
        cardMessageId: wire.messageId,
        actionId: 'approve',
      }),
    ).rejects.toThrow(/no buttons/);
  });

  it("a ticket DM shows the PNG QR in the member's thread only", async () => {
    const t = setup(vendor);
    const msg = dmMsg('mem_dean', 'your razzmatazz ticket for tonight 🎟️', {
      card: ticketCard('mem_dean'),
      images: [{ url: mockQrDataUrl('TRAV-MOCK-TICKET|o|t|c'), alt: "QR code, Dean's ticket" }],
    });
    expect((await t.lb.channel.sendDirect('h_dean', msg)).ok).toBe(true);
    const dm = t.lb.channel.dmTranscript('h_dean').at(-1) as TranscriptMessage;
    expect(dm.attachments).toHaveLength(1);
    expect(dm.attachments[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      alt: "QR code, Dean's ticket",
    });
    expect(dm.attachments[0]!.uri).toMatch(/^data:image\/png;base64,/);
    expect(t.lb.channel.groupTranscript()).toEqual([]);
    expect(t.lb.channel.dmTranscript('h_henry')).toEqual([]);
  });

  it("Trav's tapback lands on the member message in the world", async () => {
    const t = setup(vendor);
    const m = await t.lb.channel.injectMessage({ from: 'h_chase', text: 'thanks trav' });
    const ok = await t.lb.channel.react(BCN_CONVERSATION, {
      id: 'rx1',
      groupId: 'grp_barcelona',
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: m.messageId,
      emoji: '❤️',
    });
    expect(ok.ok).toBe(true);
    expect(t.lb.channel.groupTranscript().at(-1)).toMatchObject({
      type: 'reaction',
      direction: 'outbound',
      targetMessageId: m.messageId,
      reaction: '❤️',
    });
  });

  it('a member photo is uploaded to the "vendor CDN" and resolved back for the receipt reader', async () => {
    const t = setup(vendor);
    await t.lb.channel.injectMessage({
      from: 'h_chase',
      text: 'receipt',
      attachments: [
        { kind: 'image', mimeType: 'image/jpeg', uri: 'fixtures/receipts/rcpt_bcn_dinner.jpg' },
      ],
    });
    const m = t.events[0] as InboundMessage;
    expect(m.attachments).toEqual([
      { kind: 'image', mimeType: 'image/jpeg', uri: 'fixtures/receipts/rcpt_bcn_dinner.jpg' },
    ]);
    const wire = t.lb.mock.requests();
    expect(wire).toEqual([]); // inbound only
  });
});

const SETTLE_TEXT = 'final settle\nChase → Dean €376.48\nreply "sent" when you\'ve paid';

function settleCard(): SettleUpCard {
  return {
    cardId: 'settle-1',
    type: 'settle_up',
    title: 'final settle',
    fallbackText: SETTLE_TEXT,
    mode: 'final',
    asOf: '2026-03-17T10:30:00+01:00',
    currency: 'EUR',
    balances: [],
    transfers: [{ from: 'mem_chase', to: 'mem_dean', amount: eur(37648) }],
    totalSpent: eur(218200),
  };
}

function overlay(vendor: 'photon' | 'sendblue') {
  const clock = manualClock('2026-03-14T21:40:00+01:00');
  const lb = createRelayLoopback({ vendor, clock, conversations: [barcelona], view: 'overlay' });
  const events: InboundEvent[] = [];
  lb.channel.onEvent((e) => {
    events.push(e);
  });
  return { lb, events };
}

describe.each(['photon', 'sendblue'] as const)('relay loopback overlay view over %s', (vendor) => {
  it("draws Trav's card and buttons over the wire text, found by Trav id or vendor id", async () => {
    const t = overlay(vendor);
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await t.lb.channel.sendGroup(BCN_CONVERSATION, card);
    const vendorId = t.lb.relay.vendorIdsOf(card.id)[0]!;
    const shown = t.lb.channel.groupTranscript().at(-1) as TranscriptMessage;
    expect(shown.messageId).toBe(vendorId);
    expect(shown.card?.type).toBe('booking_proposal');
    expect(shown.actions.map((a) => a.id)).toEqual(['approve', 'not_me', 'decline']);
    expect(t.lb.channel.sentMessage(card.id)?.messageId).toBe(vendorId);
    expect(t.lb.channel.sentMessage(vendorId)?.card?.type).toBe('booking_proposal');
    // The world (the phones) still has no card or buttons.
    const phone = t.lb.world.groupTranscript().at(-1) as TranscriptMessage;
    expect(phone.card).toBeUndefined();
    expect(phone.actions).toEqual([]);
  });

  it('a tap on [Approve] travels as a signed 👍 tapback webhook on the Trav message, never as a tap', async () => {
    const t = overlay(vendor);
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await t.lb.channel.sendGroup(BCN_CONVERSATION, card);
    const vendorId = t.lb.relay.vendorIdsOf(card.id)[0]!;
    const before = t.lb.relay.stats().webhooksAccepted;
    const tap = await t.lb.channel.injectButtonTap({
      from: 'h_dean',
      cardMessageId: vendorId,
      actionId: 'approve',
    });
    expect(tap).toMatchObject({ type: 'button_tap', cardMessageId: vendorId, actionId: 'approve' });
    expect(t.lb.relay.stats().webhooksAccepted).toBe(before + 1);
    expect(t.events.map((e) => e.type)).toEqual(['reaction']);
    expect(t.events[0]).toMatchObject({
      channel: 'imessage_relay',
      sender: 'h_dean',
      reaction: '👍',
      targetMessageId: card.id,
    });
    expect(t.lb.world.groupTranscript().at(-1)).toMatchObject({
      type: 'reaction',
      direction: 'inbound',
      targetMessageId: vendorId,
    });
  });

  it('a tap on an option sends its number as text', async () => {
    const t = overlay(vendor);
    const card = groupMsg('1. sagrada familia\n2. park guell', { card: optionsCard() });
    await t.lb.channel.sendGroup(BCN_CONVERSATION, card);
    await t.lb.channel.injectButtonTap({
      from: 'h_chase',
      cardMessageId: card.id,
      actionId: 'pick',
      value: 'opt_pg',
    });
    expect(t.events.at(-1)).toMatchObject({ type: 'message', text: '2', sender: 'h_chase' });
  });

  it('[Sent] on the final settle card: a threaded "sent" where the vendor threads, else the 👍 the card offers', async () => {
    const t = overlay(vendor);
    const card = groupMsg(SETTLE_TEXT, {
      card: settleCard(),
      actions: [action('sent', 'Sent'), action('got_it', 'Got it')],
    });
    await t.lb.channel.sendGroup(BCN_CONVERSATION, card);
    await t.lb.channel.injectButtonTap({
      from: 'h_chase',
      cardMessageId: card.id,
      actionId: 'sent',
    });
    if (vendor === 'photon') {
      expect(t.events.at(-1)).toMatchObject({
        type: 'message',
        text: 'sent',
        replyToMessageId: card.id,
      });
    } else {
      expect(t.lb.relay.capabilities.threadedReplies).toBe(false);
      expect(t.events.at(-1)).toMatchObject({
        type: 'reaction',
        reaction: '👍',
        targetMessageId: card.id,
      });
    }
  });

  it("refuses a tap on an unknown message, a missing button, or someone else's DM card", async () => {
    const t = overlay(vendor);
    await expect(
      t.lb.channel.injectButtonTap({ from: 'h_dean', cardMessageId: 'nope', actionId: 'approve' }),
    ).rejects.toThrow(/unknown outbound message/);
    const plain = groupMsg('hey');
    await t.lb.channel.sendGroup(BCN_CONVERSATION, plain);
    await expect(
      t.lb.channel.injectButtonTap({
        from: 'h_dean',
        cardMessageId: plain.id,
        actionId: 'approve',
      }),
    ).rejects.toThrow(/has no card/);
    const card = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await t.lb.channel.sendGroup(BCN_CONVERSATION, card);
    await expect(
      t.lb.channel.injectButtonTap({ from: 'h_dean', cardMessageId: card.id, actionId: 'undo' }),
    ).rejects.toThrow(/has no undo button/);
    const dm = dmMsg('mem_crowley', 'uber €23.40, share it?', {
      card: privateExpenseCard(),
      actions: [action('confirm', 'Share it'), action('decline', 'Keep private')],
    });
    expect((await t.lb.channel.sendDirect('h_crowley', dm)).ok).toBe(true);
    await expect(
      t.lb.channel.injectButtonTap({ from: 'h_dean', cardMessageId: dm.id, actionId: 'confirm' }),
    ).rejects.toThrow(/cannot see/);
    expect(t.events).toEqual([]);
    // The owner's own tap goes through, in the DM lane.
    await t.lb.channel.injectButtonTap({
      from: 'h_crowley',
      cardMessageId: dm.id,
      actionId: 'confirm',
    });
    expect(t.events.at(-1)).toMatchObject({
      lane: 'dm',
      sender: 'h_crowley',
      conversationId: 'dm:h_crowley',
    });
  });

  it('marks a T-165 notice in the overlay; on the wire it is a plain text', async () => {
    const t = overlay(vendor);
    const n = groupMsg('Arjun added Uber €18.60 · 4 ways (not Henry, Chase)', {
      kind: 'system_notice',
    });
    expect((await t.lb.channel.sendGroup(BCN_CONVERSATION, n)).ok).toBe(true);
    expect(t.lb.channel.groupTranscript().at(-1)).toMatchObject({
      systemNotice: true,
      text: n.text,
    });
    expect(t.lb.world.groupTranscript().at(-1)).toMatchObject({
      systemNotice: false,
      text: n.text,
    });
  });
});
