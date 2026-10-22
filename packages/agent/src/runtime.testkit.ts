/**
 * Test harness for the agent loop: a real `createTravRuntime` (in-memory
 * stores seeded with Barcelona, mock providers, the offline model client, the
 * production send path in strict voice mode) on a simulator channel, plus two
 * non-roster participants ("Ava", a guest, and a second "Dean" handle for the
 * display-name spoof). Not exported from the package index.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, BookingProposal, IdGenerator, SimulatedClock } from '@trav/core';
import { createDeterministicIdGenerator, createSimulatedClock } from '@trav/core';
import type {
  InboundButtonTap,
  InboundMessage,
  InboundReaction,
  MockTickets,
  SimulatorChannel,
} from '@trav/adapters';
import { createMockTickets, createSimulatorChannel, loadTicketInventory } from '@trav/adapters';
import {
  BARCELONA,
  BARCELONA_NOW,
  createTravRuntime,
  type TravRuntime,
  type TravRuntimeOptions,
} from './compose.js';
import type { TurnResult } from './loop.js';
import type {
  ClassifyRequest,
  CompletionRequest,
  CompletionResponse,
  ModelClient,
} from './model/client.js';
import { createModelClient, readModelEnv } from './model/client.js';

export const RAZZMATAZZ_ASK = "@trav get the 5 of us Razzmatazz tickets, Henry's sick";
export const FIVE = ['mem_dean', 'mem_maya', 'mem_jordan', 'mem_priya', 'mem_sam'] as const;

export const GUESTS = [
  { handle: 'h_ava', displayName: 'Ava' },
  { handle: 'h_dean2', displayName: 'Dean' },
] as const;

export interface SpyModel {
  readonly client: ModelClient;
  readonly completions: CompletionRequest[];
  /** Response i answers `completions[i]`. */
  readonly responses: CompletionResponse[];
  readonly classifies: ClassifyRequest<string>[];
}

/** Records every request and delegates to `inner` (the offline client by default). */
export function spyModel(inner: ModelClient): SpyModel {
  const completions: CompletionRequest[] = [];
  const responses: CompletionResponse[] = [];
  const classifies: ClassifyRequest<string>[] = [];
  const client: ModelClient = {
    mode: inner.mode,
    async complete(req) {
      completions.push(structuredClone(req));
      const res = await inner.complete(req);
      responses.push(res);
      return res;
    },
    classify(req) {
      classifies.push(req);
      return inner.classify(req);
    },
  };
  return { client, completions, responses, classifies };
}

/** A fresh state dir per harness so offline misses never land in the repo's `.trav/`. */
export function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'trav-agent-'));
}

export function offlineModel(clock: SimulatedClock, stateDir = tempStateDir()): ModelClient {
  return createModelClient({
    env: readModelEnv({ TRAV_OFFLINE: '1', TRAV_STATE_DIR: stateDir }),
    clock,
  });
}

export interface Harness {
  readonly runtime: TravRuntime;
  readonly channel: SimulatorChannel;
  readonly clock: SimulatedClock;
  readonly ids: IdGenerator;
  readonly model: SpyModel;
  readonly tickets: MockTickets;
  /** Group-lane message from a handle, handled by the agent. */
  say(
    from: string,
    text: string,
    opts?: Partial<Pick<InboundMessage, 'messageId' | 'replyToMessageId' | 'platformMention'>>,
  ): Promise<TurnResult>;
  /** DM-lane message from a handle. */
  dm(from: string, text: string): Promise<TurnResult>;
  react(from: string, targetMessageId: string, reaction: string): Promise<TurnResult>;
  tap(from: string, cardMessageId: string, actionId: string): Promise<TurnResult>;
  audit(): readonly AuditEvent[];
  auditTypes(): string[];
  pending(): BookingProposal[];
  /** The last inbound event the harness injected (for ids). */
  readonly last: { message?: InboundMessage; reaction?: InboundReaction; tap?: InboundButtonTap };
}

export interface HarnessOptions {
  readonly model?: ModelClient;
  readonly maxToolRounds?: number;
  readonly runtime?: Partial<
    Omit<TravRuntimeOptions, 'channel' | 'clock' | 'ids' | 'model' | 'maxToolRounds'>
  >;
}

export function harness(opts: HarnessOptions = {}): Harness {
  const clock = createSimulatedClock(BARCELONA_NOW);
  const ids = createDeterministicIdGenerator('t');
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: BARCELONA.conversationId,
        participants: [
          ...BARCELONA.members.map((m) => ({
            handle: m.handle,
            displayName: m.name,
            memberId: m.memberId,
          })),
          ...GUESTS.map((g) => ({ handle: g.handle, displayName: g.displayName })),
        ],
      },
    ],
  });
  const tickets = createMockTickets({ clock, ids, inventory: loadTicketInventory('barcelona') });
  const model = spyModel(opts.model ?? offlineModel(clock));
  const runtime = createTravRuntime({
    channel,
    clock,
    ids,
    offline: true,
    env: { TRAV_OFFLINE: '1', TRAV_STATE_DIR: tempStateDir() },
    model: model.client,
    providers: { tickets },
    voice: 'strict',
    ...(opts.maxToolRounds !== undefined ? { maxToolRounds: opts.maxToolRounds } : {}),
    ...opts.runtime,
  });
  const last: { message?: InboundMessage; reaction?: InboundReaction; tap?: InboundButtonTap } = {};
  const groupId = BARCELONA.groupId;
  return {
    runtime,
    channel,
    clock,
    ids,
    model,
    tickets,
    last,
    async say(from, text, o = {}) {
      const event = await channel.injectMessage({ from, text, ...o });
      last.message = event;
      return runtime.agent.handleInbound(event);
    },
    async dm(from, text) {
      const event = await channel.injectMessage({ from, text, lane: 'dm' });
      last.message = event;
      return runtime.agent.handleInbound(event);
    },
    async react(from, targetMessageId, reaction) {
      const event = await channel.injectReaction({ from, targetMessageId, reaction });
      last.reaction = event;
      return runtime.agent.handleInbound(event);
    },
    async tap(from, cardMessageId, actionId) {
      const event = await channel.injectButtonTap({ from, cardMessageId, actionId });
      last.tap = event;
      return runtime.agent.handleInbound(event);
    },
    audit: () => runtime.stores.group.audit.listByGroup(groupId),
    auditTypes: () => runtime.stores.group.audit.listByGroup(groupId).map((e) => e.type),
    pending: () => [...runtime.stores.group.bookings.listPendingProposals(groupId)],
  };
}
