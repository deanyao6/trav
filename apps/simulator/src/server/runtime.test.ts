import { describe, expect, it } from 'vitest';
import type { InboundEvent } from '@trav/adapters';
import { TravError } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { ThreadMessage } from '../shared/types.js';
import { HANDLER_NOT_WIRED_STATUS, silentTurnStatus } from './backend.js';
import { RAZZMATAZZ_ASK } from './groups.js';
import { AGENT_BACKEND_HINT, backendChoice, loadAgentBackend, selectBackend } from './runtime.js';
import type { SimRuntimeInput } from './runtime.js';

const SILENT: TurnResult = {
  outbound: [],
  toolCalls: [],
  auditEventIds: [],
  silent: true,
  modelSources: [],
  note: 'fake',
};

/** The parts of `TravAgent` the simulator never calls. */
const AGENT_REST: Pick<TravAgent, 'intakeDocument' | 'pendingCards'> = {
  intakeDocument: () => Promise.reject(new Error('not used by the simulator backend')),
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
  it('parses TRAV_SIM_BACKEND', () => {
    expect(backendChoice(undefined)).toBe('auto');
    expect(backendChoice('')).toBe('auto');
    expect(backendChoice('scripted')).toBe('scripted');
    expect(backendChoice('agent')).toBe('agent');
    expect(() => backendChoice('live')).toThrow(TravError);
  });

  it('auto falls back to the scripted demo when the runtime is not configured', async () => {
    const logs: string[] = [];
    const backend = await selectBackend({
      choice: 'auto',
      offline: true,
      log: (l) => logs.push(l),
      createTravRuntime: () => {
        throw new TravError('not_implemented', 'not_configured: test');
      },
    });
    expect(backend.kind).toBe('scripted');
    expect(logs.join('\n')).toMatch(/scripted Barcelona demo/);
  });

  it('auto does not hide unexpected runtime errors', async () => {
    await expect(
      selectBackend({
        choice: 'auto',
        offline: true,
        createTravRuntime: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('explicit agent choice surfaces not_configured instead of falling back', async () => {
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
      from: 'h_sam',
      cardMessageId: card.messageId,
      actionId: 'approve',
    });
    await backend.inject({
      type: 'reaction',
      from: 'h_sam',
      targetMessageId: card.messageId,
      reaction: '👍',
    });
    expect(seen.map((e) => e.type)).toEqual(['message', 'button_tap', 'reaction']);
    const tap = seen[1]!;
    expect(tap).toMatchObject({
      type: 'button_tap',
      channel: 'simulator',
      lane: 'group',
      sender: 'h_sam',
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
      backend.inject({ type: 'message', from: 'h_maya', text: '@trav razz for 5' }),
    ]);
    const reply = backend
      .state()
      .groups[0]!.thread.find((e): e is ThreadMessage => e.kind === 'message' && e.isTrav)!;
    await Promise.all([
      backend.inject({
        type: 'reaction',
        from: 'h_sam',
        targetMessageId: reply.messageId,
        reaction: '👍',
      }),
      backend.inject({
        type: 'reaction',
        from: 'h_sam',
        targetMessageId: reply.messageId,
        reaction: '👍',
      }),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      'start:h_dean',
      'end:h_dean',
      'start:h_maya',
      'end:h_maya',
      'start:h_sam',
      'end:h_sam',
      'start:h_sam',
      'end:h_sam',
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
      backend.inject({ type: 'message', from: 'h_maya', text: '@trav b' }),
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
    expect(backend.state().status).toBeUndefined();
    const card = backend
      .state()
      .groups[0]!.thread.find((e): e is ThreadMessage => e.kind === 'message' && e.isTrav)!;
    next = { ...SILENT, note: 'approval:handler_not_wired' };
    await backend.inject({
      type: 'button_tap',
      from: 'h_dean',
      cardMessageId: card.messageId,
      actionId: 'approve',
    });
    expect(backend.state().status).toBe(HANDLER_NOT_WIRED_STATUS);
    expect(backend.state().lastError).toBeUndefined();

    next = { ...SILENT, note: 'mention:not_addressed' };
    await backend.inject({ type: 'message', from: 'h_maya', text: 'lol' });
    expect(backend.state().status).toBeUndefined();

    next = { ...SILENT, note: 'approval:handler_not_wired' };
    await backend.inject({
      type: 'reaction',
      from: 'h_sam',
      targetMessageId: card.messageId,
      reaction: '👍',
    });
    expect(backend.state().status).toMatch(/T-030.*TRAV_SIM_BACKEND=scripted/);
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
    expect(silentTurnStatus(tap, silent('approval:handler_not_wired'))).toBe(
      HANDLER_NOT_WIRED_STATUS,
    );
    expect(silentTurnStatus(tap, silent('approval:not_charged'))).toMatch(/not_charged/);
    expect(silentTurnStatus(tap, { silent: false, note: 'approval:handled' })).toBeUndefined();
    expect(silentTurnStatus(like, silent('approval:not_charged'))).toMatch(/tapback/);
    expect(silentTurnStatus(like, silent('approval:no_pending'))).toBeUndefined();
    expect(silentTurnStatus(like, silent('reaction:ack'))).toBeUndefined();
    // A typed alias ("yes") takes the approval path too, so a dead handler must show there.
    expect(silentTurnStatus(msg, silent('approval:handler_not_wired'))).toBe(
      HANDLER_NOT_WIRED_STATUS,
    );
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
    const card = after.groups[0]!.thread.find(
      (e): e is ThreadMessage => e.kind === 'message' && e.messageId === proposal!.messageId,
    )!;
    if (card.cardState?.status === 'pending') {
      // T-030 not wired yet: the tap must say so instead of doing nothing visibly.
      expect(after.status).toBe(HANDLER_NOT_WIRED_STATUS);
    } else {
      // T-030 landed: the tap did something visible, so no status line.
      expect(after.status).toBeUndefined();
    }
  });

  it('selectBackend prints the scripted-demo hint when it picks the agent runtime', async () => {
    const logs: string[] = [];
    const backend = await selectBackend({
      choice: 'auto',
      offline: true,
      log: (l) => logs.push(l),
      createTravRuntime: fakeRuntime().create,
    });
    expect(backend.kind).toBe('agent');
    expect(logs).toEqual([AGENT_BACKEND_HINT]);
    expect(AGENT_BACKEND_HINT).toContain('TRAV_SIM_BACKEND=scripted');
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
