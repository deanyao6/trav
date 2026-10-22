import { describe, expect, it } from 'vitest';
import type { InboundEvent } from '@trav/adapters';
import { TravError } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { ThreadMessage } from '../shared/types.js';
import { backendChoice, loadAgentBackend, selectBackend } from './runtime.js';
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
