import { describe, expect, it } from 'vitest';
import type { AuditEventInput, OutboundMessage } from '@trav/core';
import type { ChannelAdapter } from '../interfaces/channel.js';
import type { Result } from '../interfaces/common.js';
import type { ChannelProfileId } from './profiles.js';
import { createSimulatorChannel, type TranscriptMessage } from './simulator/index.js';
import {
  isContentFreeAck,
  pacingDeadline,
  pacingPriority,
  withOutboundPacing,
  type OutboundPacingOptions,
  type PacingFailure,
} from './pacing.js';
import type { ChannelTimers } from './timers.js';
import {
  BCN_CONVERSATION,
  PROPOSAL_ACTIONS,
  PROPOSAL_TEXT,
  barcelona,
  dmMsg,
  groupMsg,
  manualClock,
  proposalCard,
} from './testing.js';

const T0 = '2026-03-14T08:00:00+01:00';
const HANDLES = barcelona.participants.map((p) => p.handle);

function setup(opts: Partial<OutboundPacingOptions> = {}, profile?: ChannelProfileId) {
  const clock = manualClock(T0);
  const sim = createSimulatorChannel({
    clock,
    conversations: [barcelona],
    ...(profile !== undefined ? { profile } : {}),
  });
  const audit: AuditEventInput[] = [];
  const ch = withOutboundPacing(sim, { clock, audit: { append: (e) => audit.push(e) }, ...opts });
  const delivered: string[] = [];
  ch.onEvent(() => {
    delivered.push('turn');
  });
  const outbound = (): TranscriptMessage[] =>
    sim
      .transcript()
      .filter((e): e is TranscriptMessage => e.type === 'message' && e.direction === 'outbound');
  const advanceMs = (ms: number): void => clock.set(new Date(clock.nowMs() + ms).toISOString());
  return { clock, sim, ch, audit, outbound, advanceMs };
}

const approval = (): OutboundMessage =>
  groupMsg(PROPOSAL_TEXT, { card: proposalCard(), actions: PROPOSAL_ACTIONS });

describe('pacingPriority / isContentFreeAck', () => {
  it('approval prompts and urgent messages are critical; proactive is low; the rest normal', () => {
    expect(pacingPriority(approval())).toBe('critical');
    expect(pacingPriority(groupMsg('flight delayed', { urgent: true, proactive: true }))).toBe(
      'critical',
    );
    expect(pacingPriority(groupMsg('morning after', { proactive: true }))).toBe('low');
    expect(pacingPriority(groupMsg('sure', { replyTo: 'm1' }))).toBe('normal');
    expect(pacingPriority(dmMsg('mem_dean', 'your ticket'))).toBe('normal');
  });

  it.each([
    ['got it', true],
    ['Got it!', true],
    ['done 👍', true],
    ['ok, on it', true],
    ['👍', true],
    ['got it, booked 5 tickets', false],
    ['€18 each', false],
    ['', false],
  ])('%s → %s', (text, ack) => {
    expect(isContentFreeAck(groupMsg(text, { replyTo: 'm1' }))).toBe(ack);
  });

  it('a message with a card, buttons, images or mentions is never an ack', () => {
    expect(isContentFreeAck(groupMsg('ok', { mentions: ['mem_dean'] }))).toBe(false);
    expect(isContentFreeAck(groupMsg('ok', { actions: PROPOSAL_ACTIONS }))).toBe(false);
    expect(isContentFreeAck(groupMsg('ok', { images: [{ url: 'x.png', alt: 'x' }] }))).toBe(false);
  });
});

describe('withOutboundPacing: small caps and deadlines (T-071 r2 review)', () => {
  it('on a small cap the default reserve leaves room for normal replies', async () => {
    const { ch, outbound } = setup({ maxSendsPerDay: 15, ratioAllowance: 100 });
    const r = await ch.sendGroup(BCN_CONVERSATION, groupMsg('dinner at 9'));
    expect(r.ok && r.value.queued).toBeUndefined();
    expect(outbound()).toHaveLength(1);
  });

  it('an explicit reserve at or above the cap is refused up front', () => {
    expect(() => setup({ maxSendsPerDay: 5, criticalReserve: 5 })).toThrow(/criticalReserve/);
  });

  it("a proposal's deadline is the earlier of expiresAt and its hold", () => {
    const card = proposalCard();
    const late = groupMsg(PROPOSAL_TEXT, {
      card,
      actions: PROPOSAL_ACTIONS,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(pacingDeadline(late)).toBe(card.holdExpiresAt);
    const early = groupMsg(PROPOSAL_TEXT, {
      card,
      actions: PROPOSAL_ACTIONS,
      expiresAt: '2000-01-01T00:00:00Z',
    });
    expect(pacingDeadline(early)).toBe('2000-01-01T00:00:00Z');
  });
});

describe('withOutboundPacing (T-071)', () => {
  it('under the limits a send goes straight through', async () => {
    const { ch, outbound } = setup();
    const r = await ch.sendGroup(BCN_CONVERSATION, groupMsg('hi'));
    expect(r).toMatchObject({ ok: true, value: { degraded: false } });
    expect(r.ok && r.value.queued).toBeUndefined();
    expect(outbound()).toHaveLength(1);
    expect(ch.stats()).toMatchObject({ sentInDay: 1, queued: 0 });
  });

  it('per-line daily cap: past it texts and DMs queue, and go out when the day rolls', async () => {
    const { ch, outbound, advanceMs } = setup({
      maxSendsPerDay: 3,
      criticalReserve: 0,
      ratioAllowance: 100,
    });
    for (let i = 0; i < 3; i++) await ch.sendGroup(BCN_CONVERSATION, groupMsg(`m${String(i)}`));
    const dm = dmMsg('mem_chase', 'your ticket');
    const r = await ch.sendDirect('h_chase', dm);
    expect(r).toMatchObject({ ok: true, value: { queued: true, messageId: dm.id } });
    expect(outbound()).toHaveLength(3);
    advanceMs(23 * 3_600_000);
    await ch.tick();
    expect(outbound()).toHaveLength(3);
    advanceMs(3_600_000 + 1);
    await ch.tick();
    expect(outbound().map((e) => e.messageId)).toContain(dm.id);
    expect(ch.stats().queued).toBe(0);
  });

  it('a queued approval prompt is delivered first when capacity returns, before the reply to the message that freed it', async () => {
    const { sim, ch, outbound } = setup({ ratioAllowance: 1, maxSendToReceiveRatio: 1 });
    await ch.sendGroup(BCN_CONVERSATION, groupMsg('intro'));
    const recap = groupMsg('morning after', { proactive: true });
    const reply = groupMsg('dinner is at 9', { replyTo: 'sim_in_0' });
    const prompt = approval();
    for (const m of [recap, reply, prompt]) {
      expect(await ch.sendGroup(BCN_CONVERSATION, m)).toMatchObject({
        ok: true,
        value: { queued: true },
      });
    }
    expect(ch.queue().map((q) => q.priority)).toEqual(['critical', 'normal', 'low']);
    // Trav answers the next message; the queued prompt must land before that answer.
    const stop = ch.onEvent(async () => {
      await ch.sendGroup(BCN_CONVERSATION, groupMsg('answer to chase'));
    });
    await sim.injectMessage({ from: 'h_chase', text: 'yo' });
    // 1 receive → ratio limit max(1, 1) = 1, still full: nothing moves yet.
    expect(outbound().map((e) => e.text)).toEqual(['intro']);
    await sim.injectMessage({ from: 'h_dean', text: 'hey' });
    // 2 receives → limit 2: exactly one more send, and it is the approval prompt.
    expect(outbound()[1]?.messageId).toBe(prompt.id);
    await sim.injectMessage({ from: 'h_piotr', text: 'a' });
    await sim.injectMessage({ from: 'h_arjun', text: 'b' });
    await sim.injectMessage({ from: 'h_crowley', text: 'c' });
    await sim.injectMessage({ from: 'h_henry', text: 'd' });
    await sim.injectMessage({ from: 'h_dean', text: 'e' });
    const order = outbound().map((e) => e.text);
    // The prompt first, then replies (oldest first, incl. Trav's answers), proactive last.
    expect(order).toEqual([
      'intro',
      PROPOSAL_TEXT,
      'dinner is at 9',
      'answer to chase',
      'answer to chase',
      'answer to chase',
      'answer to chase',
    ]);
    // Trav goes quiet; as capacity returns the 3 answers left go, the proactive recap last.
    stop();
    for (const text of ['f', 'g', 'h', 'i']) await sim.injectMessage({ from: 'h_chase', text });
    const all = outbound().map((e) => e.messageId);
    expect(all.indexOf(prompt.id)).toBe(1);
    expect(all.at(-1)).toBe(recap.id);
    expect(ch.queue()).toEqual([]);
  });

  it('the ratio guard holds through a 200-message simulated day, and nothing that needs an answer is lost', async () => {
    const ratio = 2;
    const allowance = 5;
    const { sim, ch, outbound, advanceMs, audit, clock } = setup({
      maxSendToReceiveRatio: ratio,
      ratioAllowance: allowance,
      maxQueue: 20,
    });
    const approvals: string[] = [];
    const critical: string[] = [];
    let n = 0;
    // A chatty fake agent: 3 sends per inbound (a reply, a DM, and a proactive or approval every few).
    const stop = ch.onEvent(async (e) => {
      if (e.type !== 'message') return;
      n += 1;
      await ch.sendGroup(BCN_CONVERSATION, groupMsg(`re ${String(n)}`, { replyTo: e.messageId }));
      await ch.sendDirect('h_dean', dmMsg('mem_dean', `dm ${String(n)}`));
      if (n % 5 === 0) {
        // Held for 15 minutes, like a real proposal.
        const holdEnd = new Date(clock.nowMs() + 900_000).toISOString();
        const p = groupMsg(PROPOSAL_TEXT, {
          card: { ...proposalCard(), holdExpiresAt: holdEnd },
          actions: PROPOSAL_ACTIONS,
          expiresAt: holdEnd,
        });
        approvals.push(p.id);
        critical.push(p.id);
        await ch.sendGroup(BCN_CONVERSATION, p);
      } else if (n % 7 === 0) {
        const u = groupMsg(`urgent ${String(n)}`, { urgent: true, proactive: true });
        critical.push(u.id);
        await ch.sendGroup(BCN_CONVERSATION, u);
      } else {
        await ch.sendGroup(BCN_CONVERSATION, groupMsg(`fyi ${String(n)}`, { proactive: true }));
      }
    });
    const check = (): void => {
      const s = ch.stats();
      expect(s.sentInRatioWindow).toBeLessThanOrEqual(s.ratioLimit);
      expect(s.sentInRatioWindow).toBeLessThanOrEqual(
        Math.max(allowance, ratio * s.receivedInRatioWindow),
      );
      // The transcript agrees with the guard's own count.
      expect(outbound().length).toBeLessThanOrEqual(
        Math.max(allowance, ratio * s.receivedInRatioWindow),
      );
    };
    // 200 member messages spread over 16 waking hours (every 4.8 minutes).
    for (let i = 0; i < 200; i++) {
      advanceMs(288_000);
      await sim.injectMessage({ from: HANDLES[i % HANDLES.length]!, text: `msg ${String(i)}` });
      check();
    }
    await ch.tick();
    check();
    // Nothing critical was dropped for room or lost silently: each one went
    // out, is still queued, or was withdrawn (audited) once its hold expired.
    const expiredIds = (): Set<string> =>
      new Set(
        ch
          .failures()
          .filter((f) => f.reason === 'expired')
          .map((f) => f.messageId),
      );
    const sentByDay = new Set(outbound().map((e) => e.messageId));
    const waiting = ch.queue().filter((q) => q.priority === 'critical');
    for (const id of critical) {
      const ok =
        sentByDay.has(id) || waiting.some((q) => q.messageId === id) || expiredIds().has(id);
      expect(ok, id).toBe(true);
    }
    expect(waiting.length).toBeLessThanOrEqual(1);
    // Critical ones jump the queue: almost every prompt went out inside its hold.
    expect(critical.filter((id) => sentByDay.has(id)).length).toBeGreaterThanOrEqual(
      critical.length - 2,
    );
    // Next morning the group talks again (Trav quiet): what waited goes out or has expired.
    stop();
    advanceMs(8 * 3_600_000);
    await sim.injectMessage({ from: 'h_dean', text: 'morning' });
    check();
    const sent = new Set(outbound().map((e) => e.messageId));
    for (const id of critical) expect(sent.has(id) || expiredIds().has(id), id).toBe(true);
    expect(approvals.length).toBe(40);
    // Every loss is audited; only proactive messages are dropped for room, and
    // only an approval with a dead hold is withdrawn.
    const drops = audit.filter((a) => a.type === 'message.budget_dropped');
    expect(drops.length).toBe(ch.stats().dropped);
    for (const d of drops) {
      if (d.payload['reason'] === 'expired') {
        expect(approvals).toContain(d.payload['messageId']);
      } else {
        expect(d.payload['reason']).toMatch(/^(line_pacing|queue_full)$/);
        expect(d.payload['priority']).toBe('low');
      }
    }
    expect(ch.queue().some((q) => q.priority === 'critical')).toBe(false);
  });

  it('a full queue drops a proactive message (audited), never an approval or a safety message', async () => {
    const { ch, audit, outbound } = setup({ maxSendsPerDay: 0, maxQueue: 2 });
    const low1 = groupMsg('fyi 1', { proactive: true });
    const low2 = groupMsg('fyi 2', { proactive: true });
    await ch.sendGroup(BCN_CONVERSATION, low1);
    await ch.sendGroup(BCN_CONVERSATION, low2);
    const low3 = groupMsg('fyi 3', { proactive: true });
    expect(await ch.sendGroup(BCN_CONVERSATION, low3)).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' },
    });
    // Critical ones push proactive ones out, then grow the queue past maxQueue.
    const prompts = [approval(), approval(), groupMsg('safety', { urgent: true })];
    for (const p of prompts) {
      expect(await ch.sendGroup(BCN_CONVERSATION, p)).toMatchObject({ value: { queued: true } });
    }
    expect(ch.queue().map((q) => q.messageId)).toEqual(prompts.map((p) => p.id));
    expect(audit.map((a) => a.payload['messageId'])).toEqual([low3.id, low2.id, low1.id]);
    expect(outbound()).toEqual([]);
  });

  it('a retried send never takes a second slot or queue entry', async () => {
    const { ch, outbound } = setup({ maxSendsPerDay: 1, criticalReserve: 0 });
    const m = groupMsg('hi');
    await ch.sendGroup(BCN_CONVERSATION, m);
    expect((await ch.sendGroup(BCN_CONVERSATION, m)).ok).toBe(true);
    expect(ch.stats().sentInDay).toBe(1);
    const q = approval();
    await ch.sendGroup(BCN_CONVERSATION, q);
    await ch.sendGroup(BCN_CONVERSATION, q);
    expect(ch.queue()).toHaveLength(1);
    expect(outbound()).toHaveLength(1);
  });

  it('a content-free reply goes out as a 👍 tapback where the channel has reactions', async () => {
    const { sim, ch, outbound } = setup({}, 'imessage_relay_group');
    const inbound = await sim.injectMessage({ from: 'h_dean', text: 'dinner moved to 9' });
    const ack = groupMsg('got it', { replyTo: inbound.messageId });
    const r = await ch.sendGroup(BCN_CONVERSATION, ack);
    expect(r).toMatchObject({ ok: true, value: { asReaction: true, messageId: ack.id } });
    expect(outbound()).toEqual([]);
    const tapbacks = sim.transcript().filter((e) => e.type === 'reaction');
    expect(tapbacks).toEqual([
      expect.objectContaining({
        direction: 'outbound',
        reaction: '👍',
        targetMessageId: inbound.messageId,
      }),
    ]);
    // A retry is the same tapback.
    await ch.sendGroup(BCN_CONVERSATION, ack);
    expect(sim.transcript().filter((e) => e.type === 'reaction')).toHaveLength(1);
    // Information is never squashed into a tapback.
    const info = groupMsg('got it, booked 5 tickets', { replyTo: inbound.messageId });
    await ch.sendGroup(BCN_CONVERSATION, info);
    expect(outbound().map((e) => e.messageId)).toEqual([info.id]);
  });

  it('without reactions (MMS) the ack goes out as text', async () => {
    const { sim, ch, outbound } = setup({}, 'mixed_group_mms');
    const inbound = await sim.injectMessage({ from: 'h_dean', text: 'dinner moved to 9' });
    const ack = groupMsg('got it', { replyTo: inbound.messageId });
    const r = await ch.sendGroup(BCN_CONVERSATION, ack);
    expect(r.ok && r.value.asReaction).toBeUndefined();
    expect(outbound().map((e) => e.text)).toEqual(['got it']);
  });

  it('an over-limit tapback is refused, not queued', async () => {
    const { sim, ch } = setup({ maxSendsPerDay: 1, criticalReserve: 0 });
    const out = groupMsg('hi');
    await ch.sendGroup(BCN_CONVERSATION, out);
    const r = await ch.react(BCN_CONVERSATION, {
      id: 'msg_r',
      groupId: out.groupId,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: out.id,
      emoji: '❤️',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(sim.transcript().filter((e) => e.type === 'reaction')).toEqual([]);
    expect(ch.queue()).toEqual([]);
  });

  it('inbound duplicates count once toward the ratio', async () => {
    const { sim, ch } = setup({ ratioAllowance: 0, maxSendToReceiveRatio: 1 });
    await sim.injectMessage({ from: 'h_dean', text: 'x', messageId: 'v1' });
    await sim.injectMessage({ from: 'h_dean', text: 'x', messageId: 'v1' });
    expect(ch.stats().receivedInRatioWindow).toBe(1);
  });

  it('with timers, the queue drains on its own when an old send leaves the window', async () => {
    const pending: { delayMs: number; fn: () => void }[] = [];
    const timers: ChannelTimers = {
      setTimer(delayMs, fn) {
        const t = { delayMs, fn };
        pending.push(t);
        return () => {
          const i = pending.indexOf(t);
          if (i >= 0) pending.splice(i, 1);
        };
      },
    };
    const { ch, outbound, advanceMs } = setup({ maxSendsPerDay: 1, criticalReserve: 0, timers });
    await ch.sendGroup(BCN_CONVERSATION, groupMsg('one'));
    // A safety message: critical, and no answer window to expire.
    const later = groupMsg('your 7am flight moved to 9:40am', { urgent: true });
    await ch.sendGroup(BCN_CONVERSATION, later);
    await ch.tick();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.delayMs).toBeGreaterThan(86_000_000);
    advanceMs(pending[0]!.delayMs);
    pending[0]!.fn();
    await ch.tick();
    expect(outbound().map((e) => e.messageId)).toContain(later.id);
  });

  it('rejects bad options', () => {
    const clock = manualClock(T0);
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    expect(() => withOutboundPacing(sim, { clock, criticalReserve: -1 })).toThrow();
    expect(() => withOutboundPacing(sim, { clock, maxAttempts: 1.5 })).toThrow();
  });

  it('rejects bad ratio and window options', () => {
    const clock = manualClock(T0);
    const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
    expect(() => withOutboundPacing(sim, { clock, maxSendsPerDay: -1 })).toThrow();
    expect(() => withOutboundPacing(sim, { clock, maxSendToReceiveRatio: Number.NaN })).toThrow();
    expect(() => withOutboundPacing(sim, { clock, ratioWindowMs: 0 })).toThrow();
  });
});

// ---------- round 2: retries, the critical reserve, expiry, in-flight resends, hard cap ----------

interface InnerControl {
  /** messageId → refusals still to return, each with its retryable flag. */
  readonly refuse: Map<string, { retryable: boolean; times: number }>;
  /** messageId → a gate the inner send waits on. */
  readonly gates: Map<string, Promise<void>>;
  readonly calls: string[];
}

/** The simulator behind a test double that can refuse or hold specific sends. */
function controlled(sim: ChannelAdapter): { inner: ChannelAdapter; control: InnerControl } {
  const control: InnerControl = { refuse: new Map(), gates: new Map(), calls: [] };
  const gated = async <T>(id: string, send: () => Promise<Result<T>>): Promise<Result<T>> => {
    control.calls.push(id);
    const gate = control.gates.get(id);
    if (gate !== undefined) await gate;
    const r = control.refuse.get(id);
    if (r !== undefined && r.times > 0) {
      r.times -= 1;
      return {
        ok: false,
        error: {
          code: r.retryable ? 'provider_unavailable' : 'invalid_request',
          message: 'refused by the test',
          retryable: r.retryable,
        },
      };
    }
    return send();
  };
  return {
    control,
    inner: {
      info: sim.info,
      capabilities: sim.capabilities,
      onEvent: (h) => sim.onEvent(h),
      sendGroup: (c, m, o) => gated(m.id, () => sim.sendGroup(c, m, o)),
      sendDirect: (to, m, o) => gated(m.id, () => sim.sendDirect(to, m, o)),
      react: (c, r, rm) => sim.react(c, r, rm),
      listParticipants: (c) => sim.listParticipants(c),
    },
  };
}

function rig(opts: Partial<OutboundPacingOptions> = {}) {
  const clock = manualClock('2026-03-14T21:40:00+01:00');
  const sim = createSimulatorChannel({ clock, conversations: [barcelona] });
  const { inner, control } = controlled(sim);
  const audit: AuditEventInput[] = [];
  const lost: PacingFailure[] = [];
  const ch = withOutboundPacing(inner, {
    clock,
    audit: { append: (e) => audit.push(e) },
    onFailure: (f) => lost.push(f),
    ...opts,
  });
  const outbound = (): string[] =>
    sim
      .transcript()
      .filter((e): e is TranscriptMessage => e.type === 'message' && e.direction === 'outbound')
      .map((e) => e.messageId);
  const advanceMs = (ms: number): void => clock.set(new Date(clock.nowMs() + ms).toISOString());
  const drops = (reason: string) =>
    audit.filter((a) => a.type === 'message.budget_dropped' && a.payload['reason'] === reason);
  return { clock, sim, ch, control, audit, lost, outbound, advanceMs, drops };
}

const DAY = 86_400_000;
const urgent = (text: string): OutboundMessage => groupMsg(text, { urgent: true });

describe('withOutboundPacing: retries, reserve, expiry, resends, hard cap (T-071 r2)', () => {
  it('a retryable refusal of a queued message goes back to the front and is retried after the backoff', async () => {
    const t = rig({ maxSendsPerDay: 1, criticalReserve: 0, retryBackoffMs: 30_000 });
    await t.ch.sendGroup(BCN_CONVERSATION, groupMsg('one'));
    const a = groupMsg('reply a', { replyTo: 'x' });
    const b = groupMsg('reply b', { replyTo: 'x' });
    await t.ch.sendGroup(BCN_CONVERSATION, a);
    await t.ch.sendGroup(BCN_CONVERSATION, b);
    t.control.refuse.set(a.id, { retryable: true, times: 1 });
    t.advanceMs(DAY + 1);
    await t.ch.tick();
    // a was refused once and waits out its backoff; b took the free slot meanwhile.
    expect(t.ch.queue()).toEqual([
      { messageId: a.id, lane: 'group', priority: 'normal', attempts: 1 },
    ]);
    expect(t.outbound()).toContain(b.id);
    t.advanceMs(DAY + 30_000);
    await t.ch.tick();
    expect(t.outbound()).toContain(a.id);
    expect(t.lost).toEqual([]);
    expect(t.ch.failures()).toEqual([]);
  });

  it('a critical message refused on every try is reported once and audited after maxAttempts', async () => {
    const t = rig({ maxSendsPerDay: 1, criticalReserve: 0, maxAttempts: 3, retryBackoffMs: 1_000 });
    await t.ch.sendGroup(BCN_CONVERSATION, groupMsg('one'));
    const prompt = urgent('flight cancelled, 2 options below');
    t.control.refuse.set(prompt.id, { retryable: true, times: 99 });
    expect(await t.ch.sendGroup(BCN_CONVERSATION, prompt)).toMatchObject({
      value: { queued: true },
    });
    for (let i = 0; i < 5; i++) {
      t.advanceMs(DAY + 5_000);
      await t.ch.tick();
    }
    expect(t.control.calls.filter((id) => id === prompt.id)).toHaveLength(3);
    expect(t.lost).toEqual([
      expect.objectContaining({
        messageId: prompt.id,
        reason: 'send_failed',
        priority: 'critical',
        attempts: 3,
        code: 'provider_unavailable',
      }),
    ]);
    expect(t.drops('send_failed')).toHaveLength(1);
    expect(t.drops('send_failed')[0]!.payload).toMatchObject({
      messageId: prompt.id,
      attempts: 3,
      code: 'provider_unavailable',
    });
    expect(t.ch.queue()).toEqual([]);
  });

  it('a non-retryable refusal is final at once; only a critical one is audited, every one reaches onFailure', async () => {
    const t = rig({ maxSendsPerDay: 1, criticalReserve: 0 });
    await t.ch.sendGroup(BCN_CONVERSATION, groupMsg('one'));
    const normal = dmMsg('mem_chase', 'your ticket');
    // Critical without an answer window (an approval card's hold would expire over the day).
    const crit = urgent('your flight is cancelled');
    t.control.refuse.set(normal.id, { retryable: false, times: 1 });
    t.control.refuse.set(crit.id, { retryable: false, times: 1 });
    await t.ch.sendDirect('h_chase', normal);
    await t.ch.sendGroup(BCN_CONVERSATION, crit);
    // Both in one drain (the refused slot is released, so the next one goes).
    t.advanceMs(DAY + 1);
    await t.ch.tick();
    expect(t.lost.map((f) => [f.messageId, f.reason, f.attempts])).toEqual([
      [crit.id, 'send_failed', 1],
      [normal.id, 'send_failed', 1],
    ]);
    expect(t.drops('send_failed').map((a) => a.payload['messageId'])).toEqual([crit.id]);
  });

  it('the daily cap keeps slots for critical messages: an approval prompt goes out while replies wait', async () => {
    const t = rig({ maxSendsPerDay: 5, criticalReserve: 2 });
    for (let i = 0; i < 3; i++) await t.ch.sendGroup(BCN_CONVERSATION, groupMsg(`m${String(i)}`));
    const waiting = groupMsg('reply', { replyTo: 'x' });
    expect(await t.ch.sendGroup(BCN_CONVERSATION, waiting)).toMatchObject({
      value: { queued: true },
    });
    const p1 = approval();
    const r1 = await t.ch.sendGroup(BCN_CONVERSATION, p1);
    expect(r1.ok && r1.value.queued).toBeUndefined();
    const p2 = urgent('your flight moved');
    const r2 = await t.ch.sendGroup(BCN_CONVERSATION, p2);
    expect(r2.ok && r2.value.queued).toBeUndefined();
    expect(t.outbound()).toEqual(expect.arrayContaining([p1.id, p2.id]));
    expect(t.outbound()).not.toContain(waiting.id);
    // A tapback is never critical: it can't use the reserve either.
    const r = await t.ch.react(BCN_CONVERSATION, {
      id: 'msg_r',
      groupId: p1.groupId,
      kind: 'reaction',
      to: { kind: 'group' },
      targetMessageId: p1.id,
      emoji: '👍',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('a queued proposal is withdrawn and audited when its hold expires, never delivered a day late', async () => {
    const t = rig({ maxSendsPerDay: 1, criticalReserve: 0 });
    await t.ch.sendGroup(BCN_CONVERSATION, groupMsg('one'));
    // The card's hold ends 21:55 (proposalCard), 15 minutes from now.
    const prompt = approval();
    await t.ch.sendGroup(BCN_CONVERSATION, prompt);
    const withWindow: OutboundMessage = {
      ...urgent('pick one by 9:50pm'),
      expiresAt: '2026-03-14T21:50:00+01:00',
    };
    await t.ch.sendGroup(BCN_CONVERSATION, withWindow);
    t.advanceMs(10 * 60_000 + 1);
    await t.ch.tick();
    expect(t.lost.map((f) => [f.messageId, f.reason])).toEqual([[withWindow.id, 'expired']]);
    t.advanceMs(5 * 60_000);
    await t.ch.tick();
    expect(t.lost.map((f) => f.messageId)).toEqual([withWindow.id, prompt.id]);
    expect(t.drops('expired').map((a) => a.payload['messageId'])).toEqual([
      withWindow.id,
      prompt.id,
    ]);
    t.advanceMs(DAY);
    await t.ch.tick();
    expect(t.outbound()).not.toContain(prompt.id);
    expect(t.ch.queue()).toEqual([]);
  });

  it('a resend of the same id while it is on the wire never sends twice (direct path and drain)', async () => {
    const t = rig({ maxSendsPerDay: 2, criticalReserve: 0 });
    let open!: () => void;
    const m = groupMsg('hold on');
    t.control.gates.set(
      m.id,
      new Promise<void>((r) => {
        open = r;
      }),
    );
    const first = t.ch.sendGroup(BCN_CONVERSATION, m);
    const again = t.ch.sendGroup(BCN_CONVERSATION, m);
    open();
    expect((await first).ok).toBe(true);
    expect((await again).ok).toBe(true);
    expect(t.ch.stats().sentInDay).toBe(1);
    expect(t.outbound().filter((id) => id === m.id)).toHaveLength(1);

    // Through a drain: q waits behind the cap, the drain is sending it, and it is resent.
    await t.ch.sendGroup(BCN_CONVERSATION, groupMsg('two'));
    const q = groupMsg('queued one', { replyTo: 'x' });
    expect(await t.ch.sendGroup(BCN_CONVERSATION, q)).toMatchObject({ value: { queued: true } });
    let release!: () => void;
    t.control.gates.set(
      q.id,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    t.advanceMs(DAY + 1);
    const draining = t.ch.tick();
    const resend = t.ch.sendGroup(BCN_CONVERSATION, q);
    release();
    await draining;
    expect((await resend).ok).toBe(true);
    expect(t.control.calls.filter((id) => id === q.id)).toHaveLength(1);
    expect(t.ch.stats().sentInDay).toBe(1);
    expect(t.ch.queue()).toEqual([]);
  });

  it('hard cap on queued replies and prompts: the oldest normal entry goes (audited), a critical one never', async () => {
    const t = rig({ maxSendsPerDay: 0, maxQueueTotal: 3 });
    const c1 = approval();
    const n1 = groupMsg('old reply', { replyTo: 'x' });
    const n2 = groupMsg('newer reply', { replyTo: 'x' });
    const c2 = urgent('safety');
    for (const m of [c1, n1, n2]) await t.ch.sendGroup(BCN_CONVERSATION, m);
    expect(await t.ch.sendGroup(BCN_CONVERSATION, c2)).toMatchObject({ value: { queued: true } });
    expect(t.ch.queue().map((q) => q.messageId)).toEqual([c1.id, c2.id, n2.id]);
    expect(t.lost).toEqual([
      expect.objectContaining({ messageId: n1.id, reason: 'queue_full', priority: 'normal' }),
    ]);
    expect(t.drops('queue_full').map((a) => a.payload['messageId'])).toEqual([n1.id]);
    // With only critical entries left to shed, the queue grows past the cap instead.
    for (const m of [urgent('a'), urgent('b'), approval()]) {
      expect(await t.ch.sendGroup(BCN_CONVERSATION, m)).toMatchObject({
        value: { queued: true },
      });
    }
    const left = t.ch.queue();
    expect(left.filter((q) => q.priority === 'critical')).toHaveLength(5);
    expect(left.filter((q) => q.priority === 'normal')).toEqual([]);
    expect(t.lost.every((f) => f.priority === 'normal')).toBe(true);
  });
});
