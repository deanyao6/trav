import { describe, expect, it } from 'vitest';
import type { InboundEvent, InboundMessage } from '../interfaces/channel.js';
import { createSimulatorChannel } from './simulator/index.js';
import { mergeBurst, withInboundDebounce } from './debounce.js';
import { withOutboundPacing } from './pacing.js';
import type { ChannelTimers } from './timers.js';
import { BCN_CONVERSATION, barcelona, groupMsg, manualClock } from './testing.js';

const T0 = '2026-03-14T21:39:00+01:00';

function setup(opts: { timers?: ChannelTimers; maxHoldMs?: number } = {}) {
  const clock = manualClock(T0);
  const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
  const ch = withInboundDebounce(sim, { clock, ...opts });
  const turns: InboundEvent[] = [];
  ch.onEvent((e) => {
    turns.push(e);
  });
  const advanceMs = (ms: number): void => clock.set(new Date(clock.nowMs() + ms).toISOString());
  return { clock, sim, ch, turns, advanceMs };
}

function texts(turns: readonly InboundEvent[]): string[] {
  return turns.map((t) => (t.type === 'message' ? t.text : t.type));
}

describe('withInboundDebounce (T-071)', () => {
  it('5 messages from one member in 2 seconds become one turn, 3 seconds after the last', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    const parts = ['@trav', 'get the 5 of us', 'razzmatazz tickets', "henry's", 'sick'];
    const ids: string[] = [];
    for (const [i, text] of parts.entries()) {
      if (i > 0) advanceMs(500);
      ids.push((await sim.injectMessage({ from: 'h_dean', text })).messageId);
    }
    expect(turns).toEqual([]);
    expect(ch.pendingBursts()).toBe(1);
    advanceMs(2_999);
    await ch.tick();
    expect(turns).toEqual([]);
    advanceMs(1);
    await ch.tick();
    expect(turns).toHaveLength(1);
    const merged = turns[0] as InboundMessage;
    expect(merged).toMatchObject({
      type: 'message',
      sender: 'h_dean',
      messageId: ids[0],
      mergedMessageIds: ids,
      text: parts.join('\n'),
    });
    expect(ch.pendingBursts()).toBe(0);
  });

  it('a single message is delivered unchanged (no mergedMessageIds)', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    const ev = await sim.injectMessage({ from: 'h_dean', text: '@trav hi' });
    advanceMs(3_000);
    await ch.tick();
    expect(turns).toEqual([ev]);
  });

  it('never merges two senders; another sender flushes the first burst, order kept', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    await sim.injectMessage({ from: 'h_dean', text: 'a1' });
    advanceMs(200);
    await sim.injectMessage({ from: 'h_dean', text: 'a2' });
    advanceMs(200);
    await sim.injectMessage({ from: 'h_chase', text: 'yes' });
    expect(texts(turns)).toEqual(['a1\na2']);
    advanceMs(200);
    await sim.injectMessage({ from: 'h_dean', text: 'a3' });
    expect(texts(turns)).toEqual(['a1\na2', 'yes']);
    expect((turns[1] as InboundMessage).sender).toBe('h_chase');
    advanceMs(3_000);
    await ch.tick();
    expect(texts(turns)).toEqual(['a1\na2', 'yes', 'a3']);
  });

  it('a tapback in the same conversation flushes the burst before it', async () => {
    const { sim, ch, turns } = setup();
    const out = groupMsg('👍 to book');
    await sim.sendGroup(BCN_CONVERSATION, out);
    await sim.injectMessage({ from: 'h_dean', text: 'one sec' });
    await sim.injectReaction({ from: 'h_chase', targetMessageId: out.id, reaction: '👍' });
    expect(texts(turns)).toEqual(['one sec', 'reaction']);
    expect(ch.pendingBursts()).toBe(0);
  });

  it('a burst that never pauses is still answered after maxHoldMs', async () => {
    const { sim, ch, turns, advanceMs } = setup({ maxHoldMs: 10_000 });
    for (let i = 0; i < 8; i++) {
      await sim.injectMessage({ from: 'h_dean', text: `m${String(i)}` });
      advanceMs(2_000);
      await ch.tick();
    }
    // m0..m4 held from t=0 to t=10s, then flushed; m5 starts the next burst.
    expect(texts(turns)[0]).toBe('m0\nm1\nm2\nm3\nm4');
  });

  it('the next inbound flushes a due burst first, even without tick()', async () => {
    const { sim, turns, advanceMs } = setup();
    await sim.injectMessage({ from: 'h_dean', text: 'first' });
    advanceMs(5_000);
    await sim.injectMessage({ from: 'h_dean', text: 'second' });
    expect(texts(turns)).toEqual(['first']);
  });

  it('drops redeliveries of an id, inside a burst and after it went out', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    await sim.injectMessage({ from: 'h_dean', text: 'x', messageId: 'vendor_1' });
    await sim.injectMessage({ from: 'h_dean', text: 'x', messageId: 'vendor_1' });
    await sim.injectMessage({ from: 'h_dean', text: 'y', messageId: 'vendor_2' });
    advanceMs(3_000);
    await ch.tick();
    expect(texts(turns)).toEqual(['x\ny']);
    await sim.injectMessage({ from: 'h_dean', text: 'y', messageId: 'vendor_2' });
    advanceMs(3_000);
    await ch.tick();
    expect(turns).toHaveLength(1);
  });

  it('a quote-reply to a different message starts its own burst', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    const card = groupMsg('👍 to book');
    await sim.sendGroup(BCN_CONVERSATION, card);
    await sim.injectMessage({ from: 'h_dean', text: 'lol' });
    await sim.injectMessage({ from: 'h_dean', text: 'yes', replyToMessageId: card.id });
    advanceMs(3_000);
    await ch.tick();
    expect(texts(turns)).toEqual(['lol', 'yes']);
    expect((turns[1] as InboundMessage).replyToMessageId).toBe(card.id);
  });

  it('flushAll delivers held bursts now; timers fire the flush on their own', async () => {
    const pending: { fn: () => void }[] = [];
    const timers: ChannelTimers = {
      setTimer(delayMs, fn) {
        const t = { fn };
        pending.push(t);
        void delayMs;
        return () => pending.splice(pending.indexOf(t), 1);
      },
    };
    const { sim, ch, turns, advanceMs } = setup({ timers });
    await sim.injectMessage({ from: 'h_dean', text: 'held' });
    expect(pending).toHaveLength(1);
    advanceMs(3_000);
    pending[0]!.fn();
    await ch.tick(); // waits for the timer's step (serialised)
    expect(texts(turns)).toEqual(['held']);
    await sim.injectMessage({ from: 'h_chase', text: 'bye' });
    await ch.flushAll();
    expect(texts(turns)).toEqual(['held', 'bye']);
  });

  it('mergeBurst: mention and forwarded are true if any part was; never merges attachments', () => {
    const base: InboundMessage = {
      type: 'message',
      channel: 'imessage_relay',
      conversationId: 'c',
      lane: 'group',
      receivedAt: T0,
      messageId: 'm1',
      sender: 'h_dean',
      text: 'a',
      attachments: [],
    };
    const merged = mergeBurst([
      base,
      { ...base, messageId: 'm2', text: 'b', platformMention: true, forwarded: true },
      { ...base, messageId: 'm3', text: 'c' },
    ]);
    expect(merged).toMatchObject({
      messageId: 'm1',
      text: 'a\nb\nc',
      platformMention: true,
      forwarded: true,
      mergedMessageIds: ['m1', 'm2', 'm3'],
      attachments: [],
    });
    expect(mergeBurst([base])).toBe(base);
    expect(() => mergeBurst([])).toThrow(/empty/);
    const photo = { kind: 'image', mimeType: 'image/jpeg', uri: 'r1.jpg' } as const;
    expect(() => mergeBurst([base, { ...base, messageId: 'm2', attachments: [photo] }])).toThrow(
      /attachments/,
    );
  });

  it('"yes" then a photo are two events: the burst flushes and the photo goes at once', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    const photo = { kind: 'image', mimeType: 'image/jpeg', uri: 'receipt.jpg' } as const;
    const yes = await sim.injectMessage({ from: 'h_dean', text: 'yes' });
    advanceMs(500);
    const pic = await sim.injectMessage({ from: 'h_dean', text: '', attachments: [photo] });
    expect(turns).toEqual([yes, pic]);
    expect(ch.pendingBursts()).toBe(0);
    // A caption right after the photo is its own burst, never folded into the photo.
    advanceMs(500);
    await sim.injectMessage({ from: 'h_dean', text: 'split this with everyone' });
    advanceMs(3_000);
    await ch.tick();
    expect(texts(turns)).toEqual(['yes', '', 'split this with everyone']);
    expect(turns.every((t) => t.type !== 'message' || t.mergedMessageIds === undefined)).toBe(true);
    // A redelivered photo is dropped.
    await sim.injectMessage({
      from: 'h_dean',
      text: '',
      attachments: [photo],
      messageId: pic.messageId,
    });
    expect(turns).toHaveLength(3);
  });

  it('a merged burst that reads like an exact approval carries mergedMessageIds (2+) for the agent to refuse', async () => {
    const { sim, ch, turns, advanceMs } = setup();
    await sim.injectMessage({ from: 'h_dean', text: 'do' });
    advanceMs(400);
    await sim.injectMessage({ from: 'h_dean', text: 'it' });
    advanceMs(3_000);
    await ch.tick();
    const merged = turns[0] as InboundMessage;
    expect(merged.text).toBe('do\nit');
    expect(merged.mergedMessageIds).toHaveLength(2);
  });

  it('over pacing, the ratio counts every message a member sent, not the merged turn', async () => {
    const clock = manualClock(T0);
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const paced = withOutboundPacing(sim, { clock, ratioAllowance: 0, maxSendToReceiveRatio: 1 });
    const ch = withInboundDebounce(paced, { clock });
    const turns: InboundEvent[] = [];
    ch.onEvent((e) => {
      turns.push(e);
    });
    for (const text of ['a', 'b', 'c', 'd', 'e']) await sim.injectMessage({ from: 'h_dean', text });
    clock.set(new Date(clock.nowMs() + 3_000).toISOString());
    await ch.tick();
    expect(turns).toHaveLength(1);
    expect(paced.stats()).toMatchObject({ receivedInRatioWindow: 5, ratioLimit: 5 });
  });
});
