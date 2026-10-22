/**
 * The one seam between the simulator server/UI and whatever answers as Trav.
 *
 * The HTTP layer (`routes.ts`) and the UI only talk to `SimulatorBackend`.
 * Two implementations:
 *   - `createAgentBackend(parts)`: the real `TravAgent` over the simulator
 *     channel (parts come from `runtime.ts`, which T-009/T-021 wire to
 *     `createTravRuntime`).
 *   - `createScriptedBackend()` (`scripted.ts`): a deterministic Barcelona
 *     replay of VOICE §9.5 demo states 1–3, for the UI and smoke test while
 *     the agent runtime is still being built.
 *
 * Both record through the same in-memory simulator channel, so transcripts,
 * lanes and the DM-only card refusal are identical; only the responder that
 * reacts to inbound events differs.
 */
import type { InboundEvent, SimulatorChannel, TranscriptEntry, Unsubscribe } from '@trav/adapters';
import type { Clock } from '@trav/core';
import type { TravAgent } from '@trav/agent';
import type { BackendKind, SimGroup, SimInbound, SimMember, SimState } from '../shared/types.js';
import { buildDmThread, buildState } from './state.js';
import type { ThreadEntry } from '../shared/types.js';

export interface SimulatorBackend {
  readonly kind: BackendKind;
  readonly groups: readonly SimGroup[];
  /** Every member of every group. */
  readonly members: readonly SimMember[];
  /**
   * Inject one inbound event through the simulator channel and wait for Trav's
   * turn to finish. Resolves with the event the channel delivered.
   * Rejects (with a plain `Error`) on an unknown sender/message or a tap on a
   * button that was never rendered: the channel's programmer-error checks.
   */
  inject(input: SimInbound): Promise<InboundEvent>;
  /** Raw group-lane transcript of one group (default: the first). Never contains DMs. */
  transcript(groupId?: string): readonly TranscriptEntry[];
  /** One member's private thread with Trav, as shown in the DM rail. */
  dms(memberId: string): readonly ThreadEntry[];
  /** The full UI payload. Group threads are filtered server-side (no private cards). */
  state(): SimState;
  /** Called after every change (inbound recorded, typing on/off, Trav's reply). */
  subscribe(listener: () => void): Unsubscribe;
  /** Start over (scripted backend: back to demo state 1). Optional. */
  reset?(): Promise<void>;
}

/** Reacts to one inbound event as Trav (the agent, or the demo script). */
export type Responder = (event: InboundEvent) => Promise<void>;

export interface ChannelBackendOptions {
  readonly kind: BackendKind;
  readonly groups: readonly SimGroup[];
  readonly channel: SimulatorChannel;
  readonly clock: Clock;
  readonly offline: boolean;
  readonly respond: Responder;
  /** Runs before each inbound is injected (the scripted backend advances its clock). */
  readonly beforeInject?: () => void;
}

export interface ChannelBackend extends SimulatorBackend {
  /** Set the error banner (e.g. a failed turn). */
  setError(message: string | undefined): void;
  /** Re-emit state to subscribers. */
  notify(): void;
}

/**
 * A backend over a simulator channel. Subscribes `respond` to the channel's
 * inbound events (the channel awaits each handler, so `inject` resolves only
 * after Trav's turn) and tracks the typing indicator per group.
 */
export function createChannelBackend(options: ChannelBackendOptions): ChannelBackend {
  const { channel, clock, groups } = options;
  if (groups.length === 0) throw new Error('simulator backend: at least one group is required');
  const listeners = new Set<() => void>();
  const typing = new Set<string>();
  let version = 0;
  let lastError: string | undefined;

  const groupByConversation = new Map(groups.map((g) => [g.conversationId, g]));
  const groupById = new Map(groups.map((g) => [g.groupId, g]));
  const allMembers = groups.flatMap((g) => g.members);
  const groupOfHandle = new Map(allMembers.map((m) => [m.handle, groupById.get(m.groupId)!]));

  function notify(): void {
    version += 1;
    for (const l of [...listeners]) l();
  }

  function groupOf(event: InboundEvent): SimGroup | undefined {
    const direct = groupByConversation.get(event.conversationId);
    if (direct) return direct;
    if ('sender' in event) return groupOfHandle.get(event.sender);
    return undefined;
  }

  // Turns in flight per group: the indicator stays on until the last one finishes.
  const inFlight = new Map<string, number>();
  const setTyping = (groupId: string, delta: 1 | -1): void => {
    const n = (inFlight.get(groupId) ?? 0) + delta;
    if (n > 0) {
      inFlight.set(groupId, n);
      typing.add(groupId);
    } else {
      inFlight.delete(groupId);
      typing.delete(groupId);
    }
  };

  channel.onEvent(async (event) => {
    const group = groupOf(event);
    if (group) setTyping(group.groupId, 1);
    notify();
    try {
      await options.respond(event);
      lastError = undefined;
    } catch (e) {
      lastError = `trav's turn failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      if (group) setTyping(group.groupId, -1);
      notify();
    }
  });

  function requireGroup(groupId: string | undefined): SimGroup {
    if (groupId === undefined) return groups[0]!;
    const g = groupById.get(groupId);
    if (!g) throw new Error(`unknown group ${groupId}`);
    return g;
  }

  const backend: ChannelBackend = {
    kind: options.kind,
    groups,
    members: allMembers,

    async inject(input) {
      options.beforeInject?.();
      switch (input.type) {
        case 'message': {
          const lane = input.lane ?? 'group';
          return channel.injectMessage({
            from: input.from,
            text: input.text,
            lane,
            ...(lane === 'group'
              ? { conversationId: requireGroup(input.groupId).conversationId }
              : {}),
          });
        }
        case 'reaction':
          return channel.injectReaction({
            from: input.from,
            targetMessageId: input.targetMessageId,
            reaction: input.reaction,
            ...(input.removed !== undefined ? { removed: input.removed } : {}),
          });
        case 'button_tap':
          return channel.injectButtonTap({
            from: input.from,
            cardMessageId: input.cardMessageId,
            actionId: input.actionId,
            ...(input.value !== undefined ? { value: input.value } : {}),
          });
      }
    },

    transcript(groupId) {
      return channel.groupTranscript(requireGroup(groupId).conversationId);
    },

    dms(memberId) {
      const member = allMembers.find((m) => m.memberId === memberId);
      if (!member) throw new Error(`unknown member ${memberId}`);
      return buildDmThread(groupById.get(member.groupId)!, member, channel, clock.now());
    },

    state() {
      return buildState({
        version,
        backend: options.kind,
        offline: options.offline,
        now: clock.now(),
        groups,
        channel,
        typing,
        ...(lastError !== undefined ? { lastError } : {}),
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setError(message) {
      lastError = message;
      notify();
    },

    notify,
  };
  return backend;
}

/** What `runtime.ts` hands over once `createTravRuntime` exists. */
export interface AgentBackendParts {
  readonly agent: TravAgent;
  readonly channel: SimulatorChannel;
  readonly clock: Clock;
  readonly groups: readonly SimGroup[];
  /** `TRAV_OFFLINE=1` (the model client is scripted). */
  readonly offline: boolean;
}

/**
 * The real Trav: every inbound event goes to `agent.handleInbound`, which owns
 * identity, mention gating, approvals (button taps and 👍 tapbacks normalize to
 * the same `ApprovalEvent`) and sending through the channel. This backend adds
 * nothing but the typing indicator and the state payload.
 */
export function createAgentBackend(parts: AgentBackendParts): SimulatorBackend {
  return createChannelBackend({
    kind: 'agent',
    groups: parts.groups,
    channel: parts.channel,
    clock: parts.clock,
    offline: parts.offline,
    respond: async (event) => {
      await parts.agent.handleInbound(event);
    },
  });
}
