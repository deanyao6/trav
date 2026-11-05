import { describe, expect, it } from 'vitest';
import type { TranscriptMessage } from './simulator/index.js';
import { createSimulatorChannel } from './simulator/index.js';
import {
  CHANNEL_PROFILES,
  CHANNEL_PROFILE_IDS,
  channelProfile,
  isChannelProfileId,
  type ChannelProfileId,
} from './profiles.js';
import { printTranscript } from './transcript.js';
import {
  PROPOSAL_ACTIONS,
  PROPOSAL_TEXT,
  QR_DATA_URL,
  barcelona,
  dmMsg,
  groupMsg,
  manualClock,
  proposalCard,
  ticketCard,
} from './testing.js';

const T0 = '2026-03-14T21:40:00+01:00';

function sim(profile?: ChannelProfileId) {
  return createSimulatorChannel({
    clock: manualClock(T0),
    conversations: [barcelona],
    ...(profile !== undefined ? { profile } : {}),
  });
}

describe('channel profiles (T-069)', () => {
  it('every profile sets every flag; ids round-trip', () => {
    for (const id of CHANNEL_PROFILE_IDS) {
      const p = channelProfile(id);
      expect(isChannelProfileId(id)).toBe(true);
      for (const flag of [
        'buttons',
        'richCards',
        'reactions',
        'privateDm',
        'threadedReplies',
        'canAddMembers',
        'systemNotices',
        'seesAllGroupMessages',
        'typingIndicator',
        'readReceipts',
        'canRenameGroup',
      ] as const) {
        expect(typeof p[flag], `${id}.${flag}`).toBe('boolean');
      }
      expect(['imessage', 'rcs', 'mms']).toContain(p.groupTransport);
      // A phone-number line or the simulator: Trav sees every group message (no privacy mode).
      expect(p.seesAllGroupMessages).toBe(true);
    }
    expect(isChannelProfileId('sendblue')).toBe(false);
    expect(() => channelProfile('nope' as ChannelProfileId)).toThrow(/unknown channel profile/);
  });

  it('the relay group has tapbacks, threads, typing, read receipts and media but no buttons or cards', () => {
    expect(CHANNEL_PROFILES.imessage_relay_group).toMatchObject({
      buttons: false,
      richCards: false,
      reactions: true,
      threadedReplies: true,
      typingIndicator: true,
      readReceipts: true,
      canAddMembers: true,
      canRenameGroup: true,
      systemNotices: false,
      groupTransport: 'imessage',
      maxGroupSize: 32,
    });
  });

  it('the mixed / MMS group has no reactions, renames, member changes or threads', () => {
    expect(CHANNEL_PROFILES.mixed_group_mms).toMatchObject({
      buttons: false,
      richCards: false,
      reactions: false,
      threadedReplies: false,
      canAddMembers: false,
      canRenameGroup: false,
      typingIndicator: false,
      readReceipts: false,
      systemNotices: false,
      privateDm: true,
      groupTransport: 'mms',
    });
  });

  it('the default simulator channel is the simulator profile, kind "simulator"', () => {
    const s = sim();
    expect(s.capabilities).toEqual({ ...CHANNEL_PROFILES.simulator, kind: 'simulator' });
    // Under any profile the adapter kind stays the simulator's: code decides by flag.
    expect(sim('mixed_group_mms').capabilities.kind).toBe('simulator');
  });

  it('capability overrides apply on top of a profile', () => {
    const s = createSimulatorChannel({
      clock: manualClock(T0),
      conversations: [barcelona],
      profile: 'mixed_group_mms',
      capabilities: { privateDm: false },
    });
    expect(s.capabilities).toMatchObject({ reactions: false, privateDm: false });
  });
});

describe('simulator under the MMS profile (T-069)', () => {
  it('an approval card goes out as text: no card, no buttons, "reply \\"yes\\"" instead of 👍', async () => {
    const s = sim('mixed_group_mms');
    const msg = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    const r = await s.sendGroup(barcelona.conversationId, msg);
    expect(r).toMatchObject({ ok: true, value: { degraded: true } });
    const entry = s.sentMessage(msg.id)!;
    expect(entry.card).toBeUndefined();
    expect(entry.actions).toEqual([]);
    expect(entry.text).toContain('reply "yes" to book. price held for 15 min');
    expect(entry.text).not.toMatch(/👍|👎/u);
    // The envelope is untouched (fallbackText === text stays true for the agent).
    expect(entry.outbound?.text).toBe(PROPOSAL_TEXT);
    expect(printTranscript(s.groupTranscript())).toContain('reply "yes" to book');
  });

  it('Trav cannot react and members cannot tap back or tap buttons', async () => {
    const s = sim('mixed_group_mms');
    const msg = groupMsg('hi');
    await s.sendGroup(barcelona.conversationId, msg);
    const r = await s.react(barcelona.conversationId, {
      id: 'msg_react',
      groupId: msg.groupId,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: msg.id,
      emoji: '👍',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'not_supported' } });
    expect(s.transcript().filter((e) => e.type === 'reaction')).toEqual([]);
    await expect(
      s.injectReaction({ from: 'h_dean', targetMessageId: msg.id, reaction: '👍' }),
    ).rejects.toThrow(/no reactions/);
    await expect(
      s.injectButtonTap({ from: 'h_dean', cardMessageId: msg.id, actionId: 'approve' }),
    ).rejects.toThrow(/no buttons/);
  });

  it('a quote-reply target is dropped (MMS has no threads) and a QR still arrives as an image in the DM', async () => {
    const s = sim('mixed_group_mms');
    const inbound = await s.injectMessage({ from: 'h_dean', text: '@trav hi' });
    const reply = groupMsg('hey', { replyTo: inbound.messageId });
    await s.sendGroup(barcelona.conversationId, reply);
    expect(s.sentMessage(reply.id)?.replyToMessageId).toBeUndefined();
    const ticket = dmMsg('mem_chase', 'your razzmatazz ticket for tonight 🎟️', {
      card: ticketCard('mem_chase'),
      images: [{ url: QR_DATA_URL, alt: 'QR code for Chase' }],
    });
    expect((await s.sendDirect('h_chase', ticket)).ok).toBe(true);
    const dm = s.sentMessage(ticket.id) as TranscriptMessage;
    expect(dm.card).toBeUndefined();
    expect(dm.attachments).toEqual([
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', alt: 'QR code for Chase' }),
    ]);
  });
});

describe('simulator under the iMessage relay profile (T-069)', () => {
  it('keeps the 👍 instruction (tapbacks work) but drops the card and buttons', async () => {
    const s = sim('imessage_relay_group');
    const msg = groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });
    await s.sendGroup(barcelona.conversationId, msg);
    const entry = s.sentMessage(msg.id)!;
    expect(entry.text).toBe(PROPOSAL_TEXT);
    expect(entry.card).toBeUndefined();
    expect(entry.actions).toEqual([]);
    const tap = await s.injectReaction({ from: 'h_dean', targetMessageId: msg.id, reaction: '👍' });
    expect(tap).toMatchObject({ type: 'reaction', reaction: '👍', targetMessageId: msg.id });
    const r = await s.react(barcelona.conversationId, {
      id: 'msg_ack',
      groupId: msg.groupId,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: msg.id,
      emoji: '👍',
    });
    expect(r.ok).toBe(true);
  });

  it('keeps threaded replies', async () => {
    const s = sim('imessage_relay_group');
    const inbound = await s.injectMessage({ from: 'h_dean', text: '@trav hi' });
    const reply = groupMsg('hey', { replyTo: inbound.messageId });
    await s.sendGroup(barcelona.conversationId, reply);
    expect(s.sentMessage(reply.id)?.replyToMessageId).toBe(inbound.messageId);
  });
});
