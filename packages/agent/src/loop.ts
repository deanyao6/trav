/**
 * Trav's turn loop (T-007). One inbound event ⇒ at most one group message plus
 * N DMs. See docs/ARCHITECTURE.md "Flow 1" for the step order.
 */
import type {
  AuditEventId,
  Clock,
  IdGenerator,
  Outbound,
  ScheduledJob,
  Scheduler,
  Stores,
} from '@trav/core';
import { notImplemented } from '@trav/core';
import type { ChannelAdapter, InboundEvent } from '@trav/adapters';
import type { ModelClient } from './model/client.js';
import type { ToolRegistry } from './tools/registry.js';
import type { BookingExecutor, ProviderRegistry } from './booking/executor.js';
import type { GroupMemory, MemberMemory } from './memory/index.js';

export interface AgentDeps {
  readonly stores: Stores;
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly channel: ChannelAdapter;
  readonly providers: ProviderRegistry;
  readonly executor: BookingExecutor;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly scheduler: Scheduler;
  readonly groupMemory: GroupMemory;
  readonly memberMemory: MemberMemory;
  /** Max model round-trips per turn (tool loop cap). Default 6. */
  readonly maxToolRounds?: number;
}

export interface TurnResult {
  /** What was handed to `sendTurn`, after screening. */
  readonly outbound: readonly Outbound[];
  readonly toolCalls: readonly string[];
  readonly auditEventIds: readonly AuditEventId[];
  /** True when Trav chose silence (not addressed, tapback-only ack, etc.). */
  readonly silent: boolean;
}

export interface TravAgent {
  /** Handles one channel event end to end (identity → mention → approval event or model loop → send). */
  handleInbound(event: InboundEvent): Promise<TurnResult>;
  /** Handles a due scheduled job (recap, settle-up, expiry, digest, Wrapped). */
  runScheduled(job: ScheduledJob): Promise<TurnResult>;
}

export function createTravAgent(deps: AgentDeps): TravAgent {
  return notImplemented(`createTravAgent(${deps.model.mode})`);
}
