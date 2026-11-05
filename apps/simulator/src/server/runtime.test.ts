import { describe, expect, it } from 'vitest';
import type { InboundEvent } from '@trav/adapters';
import { TravError } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { ThreadMessage } from '../shared/types.js';
import { silentTurnStatus } from './backend.js';
import { RAZZMATAZZ_ASK } from './groups.js';
import { AGENT_BACKEND_HINT, backendChoice, loadAgentBackend, selectBackend } from './runtime.js';
import type { SimRuntimeInput, SimRuntimeOutput } from './runtime.js';
import type { MockTickets } from '@trav/adapters';

const SILENT: TurnResult = {
  outbound: [],
  toolCalls: [],
  auditEventIds: [],
  silent: true,
  modelSources: [],
  note: 'fake',
};

/** The parts of `TravAgent` the simulator never calls. */
const AGENT_REST: Pick<
  TravAgent,
  'intakeDocument' | 'importCardTransactions' | 'importEmailReceipts' | 'pendingCards'
> = {
  intakeDocument: () => Promise.reject(new Error('not used by the simulator backend')),
  importCardTransactions: () => Promise.reject(new Error('not used by the simulator backend')),
  importEmailReceipts: () => Promise.reject(new Error('not used by the simulator backend')),
  pendingCards: {
    byMessageId: () => undefined,
    pendingProposalsRequestedBy: () => [],
    lastTravQuestion: () => undefined,
  },
};

/** A stand-in TravAgent: records events; answers a mention with a card carrying an Approve button. */
function fakeRuntime() {
  const seen: InboundEvent[] = [];
  const create = ({ channel }: SimRuntimeInput) => {
    const agent: TravAgent = {
      async handleInbound(event) {
        seen.push(event);
        if (event.type === 'message' && event.text.includes('@trav')) {
          await channel.sendGroup(event.conversationId, {
            id: 'out_1',
            groupId: 'grp_barcelona',
            to: { kind: 'group' },
            text: 'razzmatazz tonight, 5 tickets',
            card: {
              cardId: 'card_1',
              type: 'options',
              title: 'options',
              fallbackText: 'razzmatazz tonight, 5 tickets',
              context: 'two ways to do it',
              options: [],
              pickAction: { id: 'pick', label: 'Pick', style: 'primary', textAliases: [] },
              status: 'pending',
            },
            actions: [{ id: 'approve', label: 'Approve', style: 'primary', textAliases: ['yes'] }],
          });
        }
        return SILENT;
      },
      async runScheduled() {
        return SILENT;
      },
      ...AGENT_REST,
    };
    return { agent };
  };
  return { seen, create };
}

describe('backend selection', () => {
  it('parses TRAV_SIM_BACKEND: always the agent runtime; the retired scripted value says why', () => {
    expect(backendChoice(undefined)).toBe('agent');
    expect(backendChoice('')).toBe('agent');
    expect(backendChoice('auto')).toBe('agent');
    expect(backendChoice('agent')).toBe('agent');
    expect(() => backendChoice('scripted')).toThrow(/retired \(T-021\)/);
    expect(() => backendChoice('scripted')).toThrow(TravError);
    expect(() => backendChoice('live')).toThrow(TravError);
  });

  it('there is no fallback: a runtime that is not configured fails loudly', async () => {
    await expect(
      selectBackend({
        choice: 'agent',
        offline: true,
        createTravRuntime: () => {
          throw new TravError('not_implemented', 'not_configured: test');
        },
      }),
    ).rejects.toThrow(/not_configured/);
  });

  it('unexpected runtime errors surface as themselves', async () => {
    await expect(
      selectBackend({
        choice: 'agent',
        offline: true,
        createTravRuntime: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('rejects a runtime that does not return a TravAgent', async () => {
    await expect(
      loadAgentBackend({ offline: true, createTravRuntime: () => ({}) as never }),
    ).rejects.toThrow(/did not return/);
  });

  it('the real @trav/agent import either provides createTravRuntime or fails as not_configured', async () => {
    const mod: Record<string, unknown> = await import('@trav/agent');
    if (typeof mod['createTravRuntime'] === 'function') return; // T-009/T-021 landed: covered by their tests
    await expect(loadAgentBackend({ offline: true })).rejects.toMatchObject({
      code: 'not_implemented',
      message: expect.stringMatching(/^not_configured:/),
    });
  });
});

describe('agent backend', () => {
  it('feeds every inbound event to TravAgent.handleInbound; a card button arrives as InboundButtonTap', async () => {
    const { seen, create } = fakeRuntime();
    const backend = await loadAgentBackend({ offline: true, createTravRuntime: create });
    expect(backend.kind).toBe('agent');
    await backend.inject({
      type: 'message',
      from: 'h_dean',
      text: '@trav razz for 5',
      groupId: 'grp_barcelona',
    });
    const card = backend
      .state()
      .groups[0]!.thread.find((e): e is ThreadMessage => e.kind === 'message' && e.isTrav)!;
    expect(card.card?.cardId).toBe('card_1');
    await backend.inject({
      type: 'button_tap',
      from: 'h_crowley',
      cardMessageId: card.messageId,
      actionId: 'approve',
    });
    await backend.inject({
      type: 'reaction',
      from: 'h_crowley',
      targetMessageId: card.messageId,
      reaction: '👍',
    });
    expect(seen.map((e) => e.type)).toEqual(['message', 'button_tap', 'reaction']);
    const tap = seen[1]!;
    expect(tap).toMatchObject({
      type: 'button_tap',
      channel: 'simulator',
      lane: 'group',
      sender: 'h_crowley',
      cardMessageId: card.messageId,
      cardId: 'card_1',
      actionId: 'approve',
    });
    expect(backend.state().offline).toBe(true);
  });

  it('turns never overlap: concurrent asks and a double-clicked Approve run one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const backend = await loadAgentBackend({
      offline: true,
      createTravRuntime: ({ channel }) => ({
        agent: {
          async handleInbound(event) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            order.push(`start:${'sender' in event ? event.sender : '?'}`);
            // Yield to the event loop so a concurrent turn would interleave here.
            await new Promise((r) => setTimeout(r, 5));
            if (event.type === 'message') {
              await channel.sendGroup(event.conversationId, {
                id: `out_${order.length}`,
                groupId: 'grp_barcelona',
                to: { kind: 'group' },
                text: 'on it',
              });
            }
            order.push(`end:${'sender' in event ? event.sender : '?'}`);
            active -= 1;
            return SILENT;
          },
          runScheduled: () => Promise.resolve(SILENT),
          ...AGENT_REST,
        },
      }),
    });
    await Promise.all([
      backend.inject({ type: 'message', from: 'h_dean', text: '@trav razz for 5' }),
      backend.inject({ type: 'message', from: 'h_chase', text: '@trav razz for 5' }),
    ]);
    const reply = backend
      .state()
      .groups[0]!.thread.find((e): e is ThreadMessage => e.kind === 'message' && e.isTrav)!;
    await Promise.all([
      backend.inject({
        type: 'reaction',
        from: 'h_crowley',
        targetMessageId: reply.messageId,
        reaction: '👍',
      }),
      backend.inject({
        type: 'reaction',
        from: 'h_crowley',
        targetMessageId: reply.messageId,
        reaction: '👍',
      }),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      'start:h_dean',
      'end:h_dean',
      'start:h_chase',
      'end:h_chase',
      'start:h_crowley',
      'end:h_crowley',
      'start:h_crowley',
      'end:h_crowley',
    ]);
    expect(backend.state().groups[0]!.typing).toBe(false);
  });

  it('a failing turn does not block the turns queued behind it', async () => {
    let calls = 0;
    const backend = await loadAgentBackend({
      offline: true,
      createTravRuntime: () => ({
        agent: {
          handleInbound: () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error('first fails')) : Promise.resolve(SILENT);
          },
          runScheduled: () => Promise.resolve(SILENT),
          ...AGENT_REST,
        },
      }),
    });
    await Promise.all([
      backend.inject({ type: 'message', from: 'h_dean', text: '@trav a' }),
      backend.inject({ type: 'message', from: 'h_chase', text: '@trav b' }),
    ]);
    expect(calls).toBe(2);
    expect(backend.state().lastError).toBeUndefined();
  });

  it('a throwing state listener never leaves the typing indicator stuck', async () => {
    const backend = await loadAgentBackend({
      offline: true,
      createTravRuntime: fakeRuntime().create,
    });
    const unsubscribe = backend.subscribe(() => {
      throw new Error('boom');
    });
    await expect(
      backend.inject({ type: 'message', from: 'h_dean', text: '@trav a' }),
    ).rejects.toThrow();
    unsubscribe();
    await backend.inject({ type: 'message', from: 'h_dean', text: '@trav b' });
    const typing = backend.state().groups.map((g) => g.typing);
    expect(typing.every((t) => t === false)).toBe(true);
  });

  it('a silent tap surfaces as a status line; the next turn clears it', async () => {
    let next: TurnResult = { ...SILENT, note: 'mention:none' };
    const { create } = fakeRuntime();
    const backend = await loadAgentBackend({
      offline: true,
      createTravRuntime: (input) => {
        const inner = create(input).agent;
        return {
          agent: {
            ...inner,
            async handleInbound(event) {
              await inner.handleInbound(event);
              return next;
            },
          },
        };
      },
    });
    await backend.inject({ type: 'message', from: 'h_dean', text: '@trav razz for 5' });
    expect(backend.state().groups[0]!.status).toBeUndefined();
    const card = backend
      .state()
      .groups[0]!.thread.find((e): e is ThreadMessage => e.kind === 'message' && e.isTrav)!;
    next = { ...SILENT, note: 'approval:not_pending' };
    await backend.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: card.messageId,
      actionId: 'approve',
    });
    expect(backend.state().groups[0]!.status).toBe(
      'trav stayed quiet on that tap (approval:not_pending)',
    );
    expect(backend.state().lastError).toBeUndefined();

    next = { ...SILENT, note: 'mention:not_addressed' };
    await backend.inject({ type: 'message', from: 'h_chase', text: 'lol' });
    expect(backend.state().groups[0]!.status).toBeUndefined();

    next = { ...SILENT, note: 'approval:not_required_approver' };
    await backend.inject({
      type: 'reaction',
      from: 'h_crowley',
      targetMessageId: card.messageId,
      reaction: '👍',
    });
    expect(backend.state().groups[0]!.status).toMatch(/tapback.*not_required_approver/);
  });

  it('silentTurnStatus: only silent taps and approval tapbacks get a line', () => {
    const tap = {
      type: 'button_tap',
      sender: 'h_dean',
      cardMessageId: 'm1',
      actionId: 'approve',
    } as unknown as InboundEvent;
    const like = {
      type: 'reaction',
      sender: 'h_dean',
      targetMessageId: 'm1',
      reaction: '👍',
    } as unknown as InboundEvent;
    const msg = { type: 'message', sender: 'h_dean', text: 'hi' } as unknown as InboundEvent;
    const silent = (note: string) => ({ silent: true, note });
    expect(silentTurnStatus(tap, silent('approval:not_pending'))).toMatch(/tap.*not_pending/);
    expect(silentTurnStatus(tap, silent('approval:not_charged'))).toMatch(/not_charged/);
    expect(silentTurnStatus(tap, { silent: false, note: 'approval:handled' })).toBeUndefined();
    expect(silentTurnStatus(like, silent('approval:not_charged'))).toMatch(/tapback/);
    expect(silentTurnStatus(like, silent('approval:no_pending'))).toBeUndefined();
    expect(silentTurnStatus(like, silent('reaction:ack'))).toBeUndefined();
    // A silent message (a typed alias that bound to nothing, an unaddressed line) gets no status line.
    expect(silentTurnStatus(msg, silent('approval:not_requester'))).toBeUndefined();
    expect(silentTurnStatus(msg, silent('mention:none'))).toBeUndefined();
    expect(silentTurnStatus(tap, undefined)).toBeUndefined();
  });

  it('the offline badge follows the runtime model mode, not the env var', async () => {
    const withMode = (mode: 'live' | 'offline') => (input: SimRuntimeInput) => ({
      ...fakeRuntime().create(input),
      model: { mode },
    });
    const live = await loadAgentBackend({ createTravRuntime: withMode('live') });
    expect(live.state().offline).toBe(false);
    const off = await loadAgentBackend({ createTravRuntime: withMode('offline') });
    expect(off.state().offline).toBe(true);
    // Not forcing offline leaves the decision to the runtime.
    let forced: boolean | undefined;
    await loadAgentBackend({
      createTravRuntime: (input) => {
        forced = input.offline;
        return withMode('offline')(input);
      },
    });
    expect(forced).toBe(false);
  });

  it('the real runtime: badge from its model mode; Approve on the Razzmatazz proposal is never a silent dead button', async () => {
    const mod: Record<string, unknown> = await import('@trav/agent');
    if (typeof mod['createTravRuntime'] !== 'function') return; // covered by the not_configured test
    // No `offline` option: the runtime reads TRAV_OFFLINE=1 (vitest env) itself.
    const backend = await loadAgentBackend({});
    expect(backend.state().offline).toBe(true);
    await backend.inject({
      type: 'message',
      from: 'h_dean',
      text: RAZZMATAZZ_ASK,
      groupId: 'grp_barcelona',
    });
    const proposal = backend
      .state()
      .groups[0]!.thread.find(
        (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'booking_proposal',
      );
    expect(
      proposal,
      'the offline runtime answers the Razzmatazz ask with a proposal',
    ).toBeDefined();
    await backend.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: proposal!.messageId,
      actionId: 'approve',
    });
    const after = backend.state();
    const g = after.groups[0]!;
    // T-009: the Approve books through the real executor. The receipt lands in
    // the group, one ticket card in each of the five DM tabs, nothing in Henry's.
    expect(g.status).toBeUndefined();
    expect(after.lastError).toBeUndefined();
    const receipt = g.thread.find(
      (e): e is ThreadMessage =>
        e.kind === 'message' && e.isTrav && e.seq > proposal!.seq && e.card?.type === 'receipt',
    );
    expect(receipt?.text).toMatch(/^booked ✅ razzmatazz, 5 tickets, €90/);
    expect(proposal!.messageId).not.toBe(receipt?.messageId);
    const card = g.thread.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.messageId === proposal!.messageId,
    );
    expect(card?.cardState).toMatchObject({ status: 'approved', label: 'Approved by Dean' });
    for (const id of ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley']) {
      const tickets = g.dms[id]!.filter(
        (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'ticket',
      );
      expect(tickets, id).toHaveLength(1);
      expect(tickets[0]!.card).toMatchObject({ type: 'ticket', deliveredTo: id });
    }
    expect(g.dms['mem_henry']).toEqual([]);
    expect(JSON.stringify(g.thread)).not.toContain('TRAV-MOCK-TICKET');
  });

  it('the real runtime: a booking that fails (sold out) marks the card resolved, not pending with live buttons', async () => {
    const mod: Record<string, unknown> = await import('@trav/agent');
    if (typeof mod['createTravRuntime'] !== 'function') return;
    const backend = await loadAgentBackend({
      createTravRuntime: async (input) => {
        const create = mod['createTravRuntime'] as (o: Record<string, unknown>) => SimRuntimeOutput;
        const adapters: Record<string, unknown> = await import('@trav/adapters');
        const createMockTickets = adapters['createMockTickets'] as (o: object) => MockTickets;
        const loadTicketInventory = adapters['loadTicketInventory'] as (n: string) => unknown;
        const core: Record<string, unknown> = await import('@trav/core');
        const createIds = core['createUlidIdGenerator'] as (c: unknown) => unknown;
        const tickets = createMockTickets({
          clock: input.clock,
          ids: createIds(input.clock),
          inventory: loadTicketInventory('barcelona'),
        });
        const runtime = create({ ...input, providers: { tickets } });
        const inner = runtime.agent;
        type WithStores = {
          stores: {
            group: {
              bookings: { listPendingProposals(g: string): readonly { quoteRef: string }[] };
            };
          };
        };
        return {
          ...runtime,
          agent: {
            ...inner,
            async handleInbound(event: InboundEvent) {
              if (event.type === 'button_tap') {
                // The hold lapsed and the whole night sold out before the tap:
                // the executor's re-read of the hold finds nothing to buy.
                const pending = (
                  runtime as unknown as WithStores
                ).stores.group.bookings.listPendingProposals('grp_barcelona');
                for (const p of pending) await tickets.releaseHold(p.quoteRef);
                tickets.setAvailable('off_rzm_20260314_ga', 0);
              }
              return inner.handleInbound(event);
            },
          },
        };
      },
    });
    await backend.inject({ type: 'message', from: 'h_dean', text: RAZZMATAZZ_ASK });
    const proposal = backend
      .state()
      .groups[0]!.thread.find(
        (e): e is ThreadMessage => e.kind === 'message' && e.card?.type === 'booking_proposal',
      )!;
    await backend.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: proposal.messageId,
      actionId: 'approve',
    });
    const g = backend.state().groups[0]!;
    const card = g.thread.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.messageId === proposal.messageId,
    )!;
    expect(card.cardState).toMatchObject({
      status: 'failed',
      label: 'Failed · no charge',
      liveActionIds: [],
    });
    const line = g.thread.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.isTrav && e.seq > proposal.seq,
    )!;
    expect(line.text).toMatch(/no charge went through/);
    expect(line.replyToMessageId).toBe(proposal.messageId);
    expect(Object.values(g.dms).every((d) => d.length === 0)).toBe(true);
  });

  it('selectBackend prints what it runs', async () => {
    const logs: string[] = [];
    const backend = await selectBackend({
      choice: 'agent',
      offline: true,
      log: (l) => logs.push(l),
      createTravRuntime: fakeRuntime().create,
    });
    expect(backend.kind).toBe('agent');
    expect(logs).toEqual([AGENT_BACKEND_HINT]);
    expect(AGENT_BACKEND_HINT).toContain('the real Trav runtime');
    expect(AGENT_BACKEND_HINT).not.toMatch(/scripted/);
  });

  it('seed: the demo-state-1 lines go through the runtime (Trav stays quiet) and the clock lands on the demo start', async () => {
    const { seen, create } = fakeRuntime();
    const backend = await selectBackend({ choice: 'agent', offline: true, seed: true, createTravRuntime: create });
    const bcn = backend.state().groups.find((g) => g.group.groupId === 'grp_barcelona')!;
    const texts = bcn.thread.flatMap((e) => (e.kind === 'message' ? [e.text] : []));
    expect(texts).toHaveLength(7);
    expect(texts.at(-1)).toBe('on it');
    expect(bcn.thread.some((e) => e.kind === 'message' && e.isTrav)).toBe(false);
    // Every seeded line (Barcelona's 7 and the other trips' 5) reached handleInbound.
    expect(seen.filter((e) => e.type === 'message')).toHaveLength(12);
    expect(backend.now()).toBe('2026-03-14T21:39:30+01:00');
    // A reset re-seeds; the replay's `seed: false` starts empty.
    await backend.reset!();
    expect(backend.state().groups[0]!.thread.filter((e) => e.kind === 'message')).toHaveLength(7);
    await backend.reset!({ seed: false, startAt: '2026-03-14T17:00:00+01:00' });
    expect(backend.state().groups[0]!.thread).toEqual([]);
    expect(backend.now()).toBe('2026-03-14T17:00:00+01:00');
  });

  it('a failing turn shows an error banner and clears typing instead of crashing the server', async () => {
    const backend = await loadAgentBackend({
      offline: true,
      createTravRuntime: () => ({
        agent: {
          handleInbound: () => Promise.reject(new Error('model script missing')),
          runScheduled: () => Promise.resolve(SILENT),
          ...AGENT_REST,
        },
      }),
    });
    await backend.inject({ type: 'message', from: 'h_dean', text: '@trav hi' });
    const state = backend.state();
    expect(state.lastError).toMatch(/model script missing/);
    expect(state.groups[0]!.typing).toBe(false);
  });
});
