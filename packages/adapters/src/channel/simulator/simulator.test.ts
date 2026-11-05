import { describe, expect, it } from 'vitest';
import type { InboundEvent } from '../../interfaces/channel.js';
import { createSimulatorChannel, dmConversationId } from './index.js';
import { printTranscript } from '../transcript.js';
import {
  BCN_CONVERSATION,
  PROPOSAL_ACTIONS,
  PROPOSAL_TEXT,
  barcelona,
  dmMsg,
  groupMsg,
  manualClock,
  optionsCard,
  privateExpenseCard,
  proposalCard,
  receiptCard,
  ticketCard,
} from '../testing.js';

const START = '2026-03-14T21:40:00+01:00';

function setup(capabilities = {}) {
  const clock = manualClock(START);
  const sim = createSimulatorChannel({ clock, conversations: [barcelona], capabilities });
  const events: InboundEvent[] = [];
  sim.onEvent((e) => {
    events.push(e);
  });
  return { clock, sim, events };
}

describe('simulator channel: outbound', () => {
  it('records group sends with clock time and returns the OutboundMessage id', async () => {
    const { sim } = setup();
    const msg = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    const res = await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(res).toEqual({
      ok: true,
      value: { messageId: msg.id, sentAt: START, degraded: false },
    });
    const [entry] = sim.groupTranscript();
    expect(entry).toMatchObject({
      type: 'message',
      lane: 'group',
      direction: 'outbound',
      fromName: 'trav',
      text: PROPOSAL_TEXT,
      actions: PROPOSAL_ACTIONS,
    });
    expect(sim.sentMessage(msg.id)?.card?.cardId).toBe('rz-001');
  });

  it('is idempotent per message id (a retried send is not recorded twice)', async () => {
    const { sim, clock } = setup();
    const msg = groupMsg('dinner logged');
    const first = await sim.sendGroup(BCN_CONVERSATION, msg);
    clock.advanceMinutes(1);
    const second = await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(second).toEqual(first);
    expect(sim.transcript()).toHaveLength(1);
  });

  it('refuses to reuse a message id for a different thread', async () => {
    const { sim } = setup();
    const msg = dmMsg('mem_arjun', 'hi');
    await sim.sendDirect('h_arjun', msg);
    const res = await sim.sendDirect('h_crowley', {
      ...msg,
      to: { kind: 'member', memberId: 'mem_crowley' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('duplicate');
  });

  it('sendGroup with a DM-only ticket card returns invalid_request and records nothing', async () => {
    const { sim } = setup();
    const res = await sim.sendGroup(
      BCN_CONVERSATION,
      groupMsg('your ticket', { card: ticketCard('mem_arjun') }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid_request');
    expect(sim.transcript()).toHaveLength(0);
  });

  it('sendGroup with a private expense_confirm card returns invalid_request', async () => {
    const { sim } = setup();
    const res = await sim.sendGroup(
      BCN_CONVERSATION,
      groupMsg('uber?', { card: privateExpenseCard() }),
    );
    expect(!res.ok && res.error.code).toBe('invalid_request');
    expect(sim.transcript()).toHaveLength(0);
  });

  it('sendGroup with a group-visible digest hiding a private item returns invalid_request', async () => {
    const { sim } = setup();
    const card = {
      ...privateExpenseCard(),
      visibility: 'group' as const,
      digestItems: [privateExpenseCard('x')],
    };
    const res = await sim.sendGroup(BCN_CONVERSATION, groupMsg('digest', { card }));
    expect(!res.ok && res.error.code).toBe('invalid_request');
  });

  it('sendGroup refuses a message addressed to a member, and unknown conversations', async () => {
    const { sim } = setup();
    const toMember = await sim.sendGroup(BCN_CONVERSATION, dmMsg('mem_arjun', 'psst'));
    expect(!toMember.ok && toMember.error.code).toBe('invalid_request');
    const unknown = await sim.sendGroup('conv_nope', groupMsg('hi'));
    expect(!unknown.ok && unknown.error.code).toBe('not_found');
    expect(sim.transcript()).toHaveLength(0);
  });

  it('sendDirect delivers a ticket to its owner on the DM lane only', async () => {
    const { sim } = setup();
    const res = await sim.sendDirect(
      'h_arjun',
      dmMsg('mem_arjun', 'your ticket', { card: ticketCard('mem_arjun') }),
    );
    expect(res.ok).toBe(true);
    expect(sim.dmTranscript('h_arjun')).toHaveLength(1);
    expect(sim.dmTranscript('h_arjun')[0]).toMatchObject({
      lane: 'dm',
      conversationId: dmConversationId('h_arjun'),
      dmName: 'Arjun',
    });
    expect(sim.groupTranscript()).toHaveLength(0);
    expect(sim.dmTranscript('h_henry')).toHaveLength(0);
  });

  it('sendDirect refuses group-addressed messages, wrong handles and misaddressed tickets', async () => {
    const { sim } = setup();
    const groupAddressed = await sim.sendDirect('h_arjun', groupMsg('hi'));
    expect(!groupAddressed.ok && groupAddressed.error.code).toBe('invalid_request');
    // handle belongs to Arjun but the message is for Crowley
    const wrongHandle = await sim.sendDirect('h_arjun', dmMsg('mem_crowley', 'hi'));
    expect(!wrongHandle.ok && wrongHandle.error.code).toBe('invalid_request');
    // ticket owned by Crowley addressed to Arjun
    const wrongTicket = await sim.sendDirect(
      'h_arjun',
      dmMsg('mem_arjun', 'ticket', { card: ticketCard('mem_crowley') }),
    );
    expect(!wrongTicket.ok && wrongTicket.error.code).toBe('invalid_request');
    const unknown = await sim.sendDirect('h_ghost', dmMsg('mem_ghost', 'hi'));
    expect(!unknown.ok && unknown.error.code).toBe('not_found');
    expect(sim.transcript()).toHaveLength(0);
  });

  it('sendDirect refuses a private expense card (or digest item) owned by another member', async () => {
    const { sim } = setup();
    // privateExpenseCard is Crowley's uber; sending it to Arjun leaks Crowley's card data
    const foreign = await sim.sendDirect(
      'h_arjun',
      dmMsg('mem_arjun', 'uber?', { card: privateExpenseCard() }),
    );
    expect(!foreign.ok && foreign.error.code).toBe('invalid_request');
    const arjunDigest = {
      ...privateExpenseCard('digest'),
      paidBy: 'mem_arjun',
      digestItems: [
        { ...privateExpenseCard('mine'), paidBy: 'mem_arjun' },
        privateExpenseCard('crowleys'),
      ],
    };
    const digest = await sim.sendDirect(
      'h_arjun',
      dmMsg('mem_arjun', 'digest', { card: arjunDigest }),
    );
    expect(!digest.ok && digest.error.code).toBe('invalid_request');
    expect(sim.transcript()).toHaveLength(0);
    // the owner gets it
    const own = await sim.sendDirect(
      'h_crowley',
      dmMsg('mem_crowley', 'uber?', { card: privateExpenseCard() }),
    );
    expect(own.ok).toBe(true);
    const ownDigest = await sim.sendDirect(
      'h_arjun',
      dmMsg('mem_arjun', 'digest', {
        card: {
          ...arjunDigest,
          digestItems: [{ ...privateExpenseCard('mine'), paidBy: 'mem_arjun' }],
        },
      }),
    );
    expect(ownDigest.ok).toBe(true);
  });

  it('records outbound images as image attachments', async () => {
    const { sim } = setup();
    const msg = groupMsg('day 3 ☀️', {
      images: [
        { url: 'data:image/png;base64,AAAA', alt: 'sunset at bunkers' },
        { url: 'fixtures/album/beach.JPG', alt: 'beach' },
      ],
    });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    expect(sim.sentMessage(msg.id)!.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        uri: 'data:image/png;base64,AAAA',
        alt: 'sunset at bunkers',
      },
      { kind: 'image', mimeType: 'image/jpeg', uri: 'fixtures/album/beach.JPG', alt: 'beach' },
    ]);
  });

  it('sendDirect returns not_supported when the channel cannot DM', async () => {
    const { sim } = setup({ privateDm: false });
    const res = await sim.sendDirect('h_arjun', dmMsg('mem_arjun', 'hi'));
    expect(!res.ok && res.error.code).toBe('not_supported');
  });

  it('degrades cards and buttons on a text-only channel', async () => {
    const { sim } = setup({ richCards: false, buttons: false });
    const res = await sim.sendGroup(
      BCN_CONVERSATION,
      groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS }),
    );
    expect(res.ok && res.value.degraded).toBe(true);
    const [entry] = sim.groupTranscript();
    expect(entry).toMatchObject({ text: PROPOSAL_TEXT, actions: [], degraded: true });
    expect(entry?.type === 'message' && entry.card).toBeUndefined();
  });

  it('react records Trav tapbacks on existing messages, not_found otherwise', async () => {
    const { sim } = setup();
    const inbound = await sim.injectMessage({ from: 'h_chase', text: 'thanks trav' });
    const ok = await sim.react(BCN_CONVERSATION, {
      id: 'msg_r1',
      groupId: 'grp_barcelona',
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: inbound.messageId,
      emoji: '❤️',
    });
    expect(ok.ok).toBe(true);
    expect(sim.groupTranscript().at(-1)).toMatchObject({
      type: 'reaction',
      direction: 'outbound',
      reaction: '❤️',
    });
    const missing = await sim.react(BCN_CONVERSATION, {
      id: 'msg_r2',
      groupId: 'grp_barcelona',
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: 'nope',
      emoji: '👍',
    });
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });

  it('listParticipants includes Trav', async () => {
    const { sim } = setup();
    const res = await sim.listParticipants(BCN_CONVERSATION);
    expect(res.ok && res.value.map((p) => p.handle)).toEqual([
      'h_dean',
      'h_chase',
      'h_piotr',
      'h_arjun',
      'h_crowley',
      'h_henry',
      'trav',
    ]);
    expect(res.ok && res.value.filter((p) => p.isTrav)).toHaveLength(1);
    const missing = await sim.listParticipants('nope');
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });
});

describe('simulator channel: inbound injection', () => {
  it('delivers injected group messages to subscribers with lane and clock time', async () => {
    const { sim, events, clock } = setup();
    clock.advanceMinutes(2);
    const ev = await sim.injectMessage({
      from: 'h_dean',
      text: "@trav get the 5 of us Razzmatazz tickets, Henry's sick",
    });
    expect(events).toEqual([ev]);
    expect(ev).toMatchObject({
      type: 'message',
      channel: 'simulator',
      lane: 'group',
      conversationId: BCN_CONVERSATION,
      sender: 'h_dean',
      receivedAt: '2026-03-14T21:42:00+01:00',
      attachments: [],
    });
  });

  it('delivers DM-lane messages on the sender DM conversation', async () => {
    const { sim, events } = setup();
    await sim.injectMessage({ from: 'h_crowley', text: 'yes share it', lane: 'dm' });
    expect(events[0]).toMatchObject({ lane: 'dm', conversationId: 'dm:h_crowley' });
    expect(sim.groupTranscript()).toHaveLength(0);
    expect(sim.dmTranscript('h_crowley')).toHaveLength(1);
  });

  it('allows duplicate delivery of the same messageId (caller dedupes)', async () => {
    const { sim, events } = setup();
    await sim.injectMessage({ from: 'h_dean', text: 'yes', messageId: 'dup_1' });
    await sim.injectMessage({ from: 'h_dean', text: 'yes', messageId: 'dup_1' });
    expect(events.map((e) => (e.type === 'message' ? e.messageId : ''))).toEqual([
      'dup_1',
      'dup_1',
    ]);
  });

  it('rejects messages from someone not in the chat', async () => {
    const { sim } = setup();
    await expect(sim.injectMessage({ from: 'h_stranger', text: 'hi' })).rejects.toThrow();
  });

  it('injects reactions on Trav messages with the target lane', async () => {
    const { sim, events } = setup();
    const msg = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    const ev = await sim.injectReaction({
      from: 'h_dean',
      targetMessageId: msg.id,
      reaction: '👍',
    });
    expect(ev).toMatchObject({
      type: 'reaction',
      lane: 'group',
      sender: 'h_dean',
      targetMessageId: msg.id,
      reaction: '👍',
      removed: false,
    });
    expect(events).toEqual([ev]);
  });

  it('injects button taps carrying the card id; refuses buttons that were never shown', async () => {
    const { sim, events } = setup();
    const msg = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    const ev = await sim.injectButtonTap({
      from: 'h_dean',
      cardMessageId: msg.id,
      actionId: 'approve',
    });
    expect(ev).toMatchObject({
      type: 'button_tap',
      lane: 'group',
      cardMessageId: msg.id,
      cardId: 'rz-001',
      actionId: 'approve',
    });
    expect(events).toHaveLength(1);
    await expect(
      sim.injectButtonTap({ from: 'h_dean', cardMessageId: msg.id, actionId: 'paid' }),
    ).rejects.toThrow(/no paid button/);
  });

  it('options cards expose their pick button with a value', async () => {
    const { sim } = setup();
    const msg = groupMsg('two options', { card: optionsCard() });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    const ev = await sim.injectButtonTap({
      from: 'h_chase',
      cardMessageId: msg.id,
      actionId: 'pick',
      value: 'opt_pg',
    });
    expect(ev).toMatchObject({ actionId: 'pick', value: 'opt_pg', cardId: 'opt-1' });
  });

  it('a member cannot tap or react to another member DM card', async () => {
    const { sim } = setup();
    const msg = dmMsg('mem_crowley', 'uber?', {
      card: { ...privateExpenseCard(), visibility: 'private' },
      actions: [],
    });
    await sim.sendDirect('h_crowley', msg);
    await expect(
      sim.injectReaction({ from: 'h_chase', targetMessageId: msg.id, reaction: '👍' }),
    ).rejects.toThrow(/another member/);
    const own = await sim.injectReaction({
      from: 'h_crowley',
      targetMessageId: msg.id,
      reaction: '👍',
    });
    expect(own).toMatchObject({ lane: 'dm', conversationId: 'dm:h_crowley' });
  });

  it('button taps are impossible on a button-less channel', async () => {
    const { sim } = setup({ buttons: false });
    const msg = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await sim.sendGroup(BCN_CONVERSATION, msg);
    await expect(
      sim.injectButtonTap({ from: 'h_dean', cardMessageId: msg.id, actionId: 'approve' }),
    ).rejects.toThrow(/no buttons/);
  });

  it('membership changes update participants and emit events', async () => {
    const { sim, events } = setup();
    await sim.injectMemberLeft({ participant: { handle: 'h_henry', displayName: 'Henry' } });
    await sim.injectMemberJoined({ participant: { handle: 'h_alex', displayName: 'Alex' } });
    expect(events.map((e) => e.type)).toEqual(['member_left', 'member_joined']);
    expect(sim.participants().map((p) => p.handle)).not.toContain('h_henry');
    expect(sim.participants().map((p) => p.handle)).toContain('h_alex');
  });

  it('unsubscribe stops delivery', async () => {
    const clock = manualClock(START);
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const seen: string[] = [];
    const off = sim.onEvent((e) => {
      seen.push(e.type);
    });
    await sim.injectMessage({ from: 'h_dean', text: 'a' });
    off();
    await sim.injectMessage({ from: 'h_dean', text: 'b' });
    expect(seen).toEqual(['message']);
  });
});

describe('simulator channel: lanes', () => {
  it('DMs never appear in the group transcript', async () => {
    const { sim } = setup();
    await sim.injectMessage({ from: 'h_dean', text: '@trav get the 5 of us Razzmatazz tickets' });
    await sim.sendGroup(BCN_CONVERSATION, groupMsg('booked', { card: receiptCard() }));
    for (const m of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
      const handle = `h_${m.slice(4)}`;
      const res = await sim.sendDirect(handle, dmMsg(m, 'your ticket', { card: ticketCard(m) }));
      expect(res.ok).toBe(true);
    }
    await sim.injectMessage({ from: 'h_crowley', text: 'share it', lane: 'dm' });

    const group = sim.groupTranscript();
    expect(group).toHaveLength(2);
    expect(group.every((e) => e.lane === 'group')).toBe(true);
    expect(JSON.stringify(group)).not.toContain('"ticket"');
    expect(JSON.stringify(group)).not.toContain('qr');
    expect(sim.dmTranscript('h_henry')).toHaveLength(0);
    expect(sim.dmTranscript('h_crowley')).toHaveLength(2);
    expect(sim.transcript()).toHaveLength(8);
  });
});

// ---------- T-165: system notices ----------

describe('simulator channel: system notices (T-165)', () => {
  const LINE = 'Chase added Uber €18.60 · 4 ways (not Henry, Crowley)';
  const notice = (extra = {}) => groupMsg(LINE, { kind: 'system_notice', ...extra });

  it('advertises the capability by default and renders the notice as a subscript, not a bubble', async () => {
    const { sim } = setup();
    expect(sim.capabilities.systemNotices).toBe(true);
    const res = await sim.sendGroup(BCN_CONVERSATION, notice());
    expect(res.ok && res.value.degraded).toBe(false);
    const [entry] = sim.groupTranscript();
    expect(entry).toMatchObject({
      type: 'message',
      systemNotice: true,
      text: LINE,
      degraded: false,
    });
    expect(printTranscript(sim.groupTranscript())).toContain(`(notice) ${LINE}`);
    expect(printTranscript(sim.groupTranscript())).not.toContain('trav:');
  });

  it('an ordinary message is never a notice', async () => {
    const { sim } = setup();
    await sim.sendGroup(BCN_CONVERSATION, groupMsg('dinner logged'));
    expect(sim.groupTranscript()[0]).toMatchObject({ systemNotice: false });
  });

  it('with the capability off, a notice that still reaches the channel posts as an ordinary bubble, flagged degraded', async () => {
    const { sim } = setup({ systemNotices: false });
    expect(sim.capabilities.systemNotices).toBe(false);
    const res = await sim.sendGroup(BCN_CONVERSATION, notice());
    expect(res.ok && res.value.degraded).toBe(true);
    expect(sim.groupTranscript()[0]).toMatchObject({ systemNotice: false, text: LINE });
    expect(printTranscript(sim.groupTranscript())).not.toContain('(notice)');
  });

  it('refuses a notice with anything attached, or in a DM', async () => {
    const { sim } = setup();
    for (const extra of [
      { actions: [{ id: 'undo' as const, label: 'Undo' }] },
      { mentions: ['mem_chase'] },
      { card: receiptCard() },
    ]) {
      const res = await sim.sendGroup(BCN_CONVERSATION, notice(extra));
      expect(res.ok ? 'ok' : res.error.code).toBe('invalid_request');
    }
    const multi = await sim.sendGroup(
      BCN_CONVERSATION,
      groupMsg('a\nb', { kind: 'system_notice' }),
    );
    expect(multi.ok ? 'ok' : multi.error.code).toBe('invalid_request');
    const dm = await sim.sendDirect('h_chase', dmMsg('mem_chase', LINE, { kind: 'system_notice' }));
    expect(dm.ok ? 'ok' : dm.error.code).toBe('invalid_request');
    expect(sim.transcript()).toEqual([]);
  });
});
