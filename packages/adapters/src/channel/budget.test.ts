import { describe, expect, it } from 'vitest';
import { audit } from '@trav/core';
import type { AuditEventInput } from '@trav/core';
import { budgetDay, withMessageBudget } from './budget.js';
import { createSimulatorChannel } from './simulator/index.js';
import { printTranscript } from './transcript.js';
import {
  BCN_CONVERSATION,
  BCN_GROUP,
  barcelona,
  dmMsg,
  groupMsg,
  manualClock,
  receiptCard,
  ticketCard,
} from './testing.js';

function setup(opts: { maxProactivePerDay?: number; start?: string; tz?: string } = {}) {
  const clock = manualClock(opts.start ?? '2026-03-14T10:00:00+01:00');
  const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
  const events: AuditEventInput[] = [];
  const channel = withMessageBudget(sim, {
    clock,
    audit: { append: (e) => events.push(e) },
    ...(opts.maxProactivePerDay !== undefined
      ? { maxProactivePerDay: opts.maxProactivePerDay }
      : {}),
    ...(opts.tz ? { timeZoneFor: () => opts.tz } : {}),
    tripIdFor: () => 'trip_bcn',
  });
  return { clock, sim, channel, events };
}

const proactive = (text: string) => groupMsg(text, { proactive: true });

describe('withMessageBudget: proactive cap', () => {
  it('drops the 3rd proactive group message of the day and audits it', async () => {
    const { channel, sim, events } = setup();
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('morning after'))).ok).toBe(true);
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('budget heads up'))).ok).toBe(true);
    const third = proactive('one more thing');
    const res = await channel.sendGroup(BCN_CONVERSATION, third);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('rate_limited');
      expect(res.error.retryable).toBe(false);
    }
    expect(sim.groupTranscript()).toHaveLength(2);
    expect(sim.sentMessage(third.id)).toBeUndefined();
    expect(events).toEqual([
      {
        groupId: BCN_GROUP,
        tripId: 'trip_bcn',
        type: 'message.budget_dropped',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        payload: {
          messageId: third.id,
          conversationId: BCN_CONVERSATION,
          day: '2026-03-14',
          cap: 2,
          sentToday: 2,
        },
      },
    ]);
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(2);
  });

  it('the cap resets on the next simulated day', async () => {
    const { channel, clock } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('c'))).ok).toBe(false);
    clock.set('2026-03-15T10:00:00+01:00');
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(0);
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('d'))).ok).toBe(true);
  });

  it('the day boundary follows the trip time zone when given', async () => {
    // 23:30 UTC on the 14th is 00:30 on the 15th in Madrid.
    const { channel, clock } = setup({ start: '2026-03-14T22:00:00Z', tz: 'Europe/Madrid' });
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    clock.set('2026-03-14T23:30:00Z');
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('c'))).ok).toBe(true);
  });

  it('budgetDay uses the clock offset by default and the zone when given', () => {
    const clock = manualClock('2026-03-14T23:30:00-05:00');
    expect(budgetDay(clock, undefined)).toBe('2026-03-14');
    expect(budgetDay(clock, 'Europe/Madrid')).toBe('2026-03-15');
  });

  it('a configured cap of 0 drops every proactive message; replies still go', async () => {
    const { channel, events } = setup({ maxProactivePerDay: 0 });
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('a'))).ok).toBe(false);
    expect(
      (await channel.sendGroup(BCN_CONVERSATION, groupMsg('reply', { replyTo: 'msg_x' }))).ok,
    ).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['message.budget_dropped']);
  });

  it('caps are per group', async () => {
    const { channel } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    const other = groupMsg('lisbon recap', { proactive: true, groupId: 'grp_lisbon' });
    expect(channel.proactiveSentToday('grp_lisbon')).toBe(0);
    // the simulator only knows the barcelona conversation; the budget is keyed on groupId
    expect((await channel.sendGroup(BCN_CONVERSATION, other)).ok).toBe(true);
  });

  it('a retried send of the same message id does not use a second slot', async () => {
    const { channel, sim } = setup();
    const a = proactive('recap');
    await channel.sendGroup(BCN_CONVERSATION, a);
    await channel.sendGroup(BCN_CONVERSATION, a);
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(1);
    expect((await channel.sendGroup(BCN_CONVERSATION, proactive('b'))).ok).toBe(true);
    // retry of an already-sent message after the cap is reached still succeeds
    expect((await channel.sendGroup(BCN_CONVERSATION, a)).ok).toBe(true);
    expect(sim.groupTranscript()).toHaveLength(2);
  });

  it('a failed send releases its slot', async () => {
    const { channel } = setup();
    const bad = await channel.sendGroup('conv_unknown', proactive('a'));
    expect(!bad.ok && bad.error.code).toBe('not_found');
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(0);
  });

  it('concurrent proactive sends cannot exceed the cap', async () => {
    const { channel, sim } = setup();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((t) => channel.sendGroup(BCN_CONVERSATION, proactive(t))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(sim.groupTranscript()).toHaveLength(2);
  });
});

describe('withMessageBudget: never limited', () => {
  it('replies and non-proactive group messages are never limited and not audited', async () => {
    const { channel, sim, events } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    for (let i = 0; i < 5; i++) {
      expect((await channel.sendGroup(BCN_CONVERSATION, groupMsg(`answer ${i}`))).ok).toBe(true);
      expect(
        (
          await channel.sendGroup(
            BCN_CONVERSATION,
            groupMsg(`r ${i}`, { proactive: true, replyTo: 'msg_q' }),
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await channel.sendGroup(BCN_CONVERSATION, groupMsg(`o ${i}`, { proactive: true }), {
            replyToMessageId: 'msg_q',
          })
        ).ok,
      ).toBe(true);
    }
    expect(sim.groupTranscript()).toHaveLength(17);
    expect(events).toEqual([]);
  });

  it('DMs are never limited, even when flagged proactive', async () => {
    const { channel, sim, events } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    for (let i = 0; i < 5; i++) {
      const res = await channel.sendDirect(
        'h_sam',
        dmMsg('mem_sam', `digest ${i}`, { proactive: true }),
      );
      expect(res.ok).toBe(true);
    }
    expect(sim.dmTranscript('h_sam')).toHaveLength(5);
    expect(events).toEqual([]);
  });

  it('urgent messages bypass the cap, do not consume it, and are audited as message.sent', async () => {
    const { channel, sim, events } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    const urgent = groupMsg('price changed on the hotel, need a 👍 by 6pm', {
      proactive: true,
      urgent: true,
    });
    const res = await channel.sendGroup(BCN_CONVERSATION, urgent);
    expect(res.ok).toBe(true);
    expect(sim.sentMessage(urgent.id)).toBeDefined();
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(2);
    expect(events).toEqual([
      {
        groupId: BCN_GROUP,
        tripId: 'trip_bcn',
        type: 'message.sent',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        payload: {
          messageId: urgent.id,
          conversationId: BCN_CONVERSATION,
          lane: 'group',
          urgent: true,
          budgetExempt: true,
          day: '2026-03-14',
          cap: 2,
          sentToday: 2,
        },
      },
    ]);
  });

  it('a retried urgent send is audited once', async () => {
    const { channel, sim, events } = setup();
    const urgent = groupMsg('hold expires in 5 min', { urgent: true });
    const first = await channel.sendGroup(BCN_CONVERSATION, urgent);
    const second = await channel.sendGroup(BCN_CONVERSATION, urgent);
    expect(second).toEqual(first);
    expect(sim.groupTranscript()).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['message.sent']);
  });

  it('urgent under the cap is still audited and leaves the budget untouched', async () => {
    const { channel, events } = setup();
    await channel.sendGroup(BCN_CONVERSATION, groupMsg('hold expiring', { urgent: true }));
    expect(events.map((e) => e.type)).toEqual(['message.sent']);
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(0);
  });

  it('a DM-only card is refused with invalid_request, uses no slot and writes no audit event', async () => {
    const { channel, sim, events } = setup();
    for (const extra of [{ urgent: true }, { proactive: true }, {}]) {
      const res = await channel.sendGroup(
        BCN_CONVERSATION,
        groupMsg('ticket', { card: ticketCard('mem_priya'), ...extra }),
      );
      expect(!res.ok && res.error.code).toBe('invalid_request');
    }
    const misaddressed = await channel.sendGroup(BCN_CONVERSATION, dmMsg('mem_priya', 'psst'));
    expect(!misaddressed.ok && misaddressed.error.code).toBe('invalid_request');
    expect(sim.transcript()).toHaveLength(0);
    expect(events).toEqual([]);
    expect(channel.proactiveSentToday(BCN_GROUP)).toBe(0);
  });

  it('a DM-only card is refused even after the budget is used up (no budget_dropped event)', async () => {
    const { channel, events } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    const res = await channel.sendGroup(
      BCN_CONVERSATION,
      groupMsg('ticket', { card: ticketCard('mem_priya'), proactive: true }),
    );
    expect(!res.ok && res.error.code).toBe('invalid_request');
    expect(events).toEqual([]);
  });

  it('audit payloads never carry private keys or message text', async () => {
    const { channel, events } = setup();
    await channel.sendGroup(BCN_CONVERSATION, proactive('a'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('b'));
    await channel.sendGroup(BCN_CONVERSATION, proactive('secret words here'));
    await channel.sendGroup(BCN_CONVERSATION, groupMsg('urgent words', { urgent: true }));
    expect(events.map((e) => e.type)).toEqual(['message.budget_dropped', 'message.sent']);
    for (const e of events) {
      for (const key of Object.keys(e.payload)) {
        expect(audit.PRIVATE_PAYLOAD_KEYS).not.toContain(key);
      }
      expect(JSON.stringify(e.payload)).not.toMatch(/words/);
    }
  });
});

describe('withMessageBudget: line cap', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('a 7-line card-less group message is rendered as a card', async () => {
    const { channel, sim } = setup();
    const msg = groupMsg(lines(7));
    expect((await channel.sendGroup(BCN_CONVERSATION, msg)).ok).toBe(true);
    const entry = sim.sentMessage(msg.id)!;
    expect(entry.renderedAsCard).toBe(true);
    expect(entry.text).toBe(lines(7));
    expect(printTranscript(sim.groupTranscript())).toContain(`[card: text ${msg.id}]`);
  });

  it('a 6-line message stays a bubble', async () => {
    const { channel, sim } = setup();
    const msg = groupMsg(lines(6));
    await channel.sendGroup(BCN_CONVERSATION, msg);
    expect(sim.sentMessage(msg.id)!.renderedAsCard).toBe(false);
  });

  it('a long message that already has a card keeps its own card', async () => {
    const { channel, sim } = setup();
    const msg = groupMsg(lines(9), { card: receiptCard() });
    await channel.sendGroup(BCN_CONVERSATION, msg);
    const entry = sim.sentMessage(msg.id)!;
    expect(entry.renderedAsCard).toBe(false);
    expect(entry.card?.type).toBe('receipt');
  });

  it('DMs are not subject to the group line cap', async () => {
    const { channel, sim } = setup();
    const msg = dmMsg('mem_sam', lines(8));
    await channel.sendDirect('h_sam', msg);
    expect(sim.sentMessage(msg.id)!.renderedAsCard).toBe(false);
  });

  it('a text-only channel just sends the text', async () => {
    const clock = manualClock('2026-03-14T10:00:00+01:00');
    const sim = createSimulatorChannel({
      clock,
      conversations: [barcelona],
      capabilities: { richCards: false },
    });
    const channel = withMessageBudget(sim, { clock, audit: { append: () => undefined } });
    const msg = groupMsg(lines(7));
    expect((await channel.sendGroup(BCN_CONVERSATION, msg)).ok).toBe(true);
    expect(sim.sentMessage(msg.id)!.renderedAsCard).toBe(false);
  });

  it('rejects invalid configuration', () => {
    const clock = manualClock('2026-03-14T10:00:00+01:00');
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    const audit = { append: () => undefined };
    expect(() => withMessageBudget(sim, { clock, audit, maxProactivePerDay: -1 })).toThrow();
    expect(() => withMessageBudget(sim, { clock, audit, maxProactivePerDay: 1.5 })).toThrow();
    expect(() => withMessageBudget(sim, { clock, audit, maxLines: 0 })).toThrow();
  });
});

describe('withMessageBudget: pass-through', () => {
  it('exposes the inner channel info, capabilities, events, reactions and participants', async () => {
    const { channel, sim } = setup();
    expect(channel.info).toBe(sim.info);
    expect(channel.capabilities).toBe(sim.capabilities);
    const seen: string[] = [];
    channel.onEvent((e) => {
      seen.push(e.type);
    });
    const ev = await sim.injectMessage({ from: 'h_maya', text: 'thanks trav' });
    expect(seen).toEqual(['message']);
    const r = await channel.react(BCN_CONVERSATION, {
      id: 'msg_heart',
      groupId: BCN_GROUP,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: ev.messageId,
      emoji: '❤️',
    });
    expect(r.ok).toBe(true);
    const p = await channel.listParticipants(BCN_CONVERSATION);
    expect(p.ok && p.value).toHaveLength(7);
  });
});
