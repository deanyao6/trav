/**
 * The simulator's one backend: the real Trav runtime.
 *
 * `createTravRuntime` (packages/agent/src/compose.ts) over the simulator
 * channel and a simulated clock, behind `createAgentBackend`. Every inbound
 * event goes to `agent.handleInbound`, every Trav message goes out through
 * the runtime's send path (screen, voice lint, lane, audit), and an Approve or
 * 👍 on a proposal runs the approval handler, the policy and the mock booking
 * executor: receipt in the group, one ticket DM each, ledger split, audit rows.
 *
 * T-021 retired the scripted Barcelona responder that used to stand in for
 * the runtime (it answered the Razzmatazz ask with fixture cards and bypassed
 * the send path's audit). `TRAV_SIM_BACKEND` only accepts `agent` now (or
 * `auto`, the old default, which means the same thing); `scripted` is refused
 * with a message saying why.
 *
 * The runtime is looked up through a dynamic import so a missing export fails
 * as `TravError` `not_configured:` with a readable message instead of a crash.
 */
import { createSimulatorChannel } from '@trav/adapters';
import type { SimulatorChannel } from '@trav/adapters';
import { TravError, createSimulatedClock } from '@trav/core';
import type { Clock, ScheduledJob, Stores } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { SimGroup } from '../shared/types.js';
import type { ChannelBackend, ResetOptions, SimulatorBackend } from './backend.js';
import { createAgentBackend, createSessionBackend, servicesOf } from './backend.js';
import { SIM_GROUPS, toConversations } from './groups.js';
import { SEED_START, seedChat, seedFixtureGroups } from './seed.js';

export type BackendChoice = 'agent';

/** `TRAV_SIM_BACKEND`: unset, `auto` or `agent`. Anything else is refused with a reason. */
export function backendChoice(value: string | undefined): BackendChoice {
  if (value === undefined || value === '' || value === 'auto' || value === 'agent') return 'agent';
  if (value === 'scripted') {
    throw new TravError(
      'invalid_argument',
      'TRAV_SIM_BACKEND=scripted was retired (T-021): the simulator always runs the real Trav runtime. ' +
        'Unset TRAV_SIM_BACKEND; TRAV_OFFLINE=1 keeps it offline',
    );
  }
  throw new TravError(
    'invalid_argument',
    `TRAV_SIM_BACKEND must be agent (or unset), got "${value}"`,
  );
}

/** What the simulator passes to `createTravRuntime`. */
export interface SimRuntimeInput {
  readonly channel: SimulatorChannel;
  readonly clock: Clock;
  /** True forces offline; false lets the model client read `TRAV_OFFLINE` and the key itself. */
  readonly offline: boolean;
}

/** The minimum the simulator needs back from `createTravRuntime`. */
export interface SimRuntimeOutput {
  readonly agent: TravAgent;
  /**
   * The runtime's model client. Its `mode` is the truth for the offline badge:
   * `TRAV_OFFLINE=true`, `TRAV_OFFLINE=1` or a missing key all mean offline.
   */
  readonly model?: { readonly mode: 'live' | 'offline' };
  /** The runtime's scheduler (read-only use: which jobs are due, for the status line). */
  readonly scheduler?: { list(): readonly ScheduledJob[] };
  /** `scheduler.drain(clock.now())` through `agent.runScheduled` (the top-bar clock). */
  drain?(): Promise<readonly TurnResult[]>;
  /** Close the stores (called when the simulator starts over). */
  close?(): void;
  /** The runtime's stores: the simulator seeds the non-Barcelona groups into them (`seed.ts`). */
  readonly stores?: Pick<Stores, 'group'>;
  /** VOICE §8: posts the family-mode notice once if the group has a minor and wasn't told yet. */
  announceFamilyMode?(groupId: string): Promise<readonly unknown[]>;
}

/** Printed at startup: what the simulator is running. */
export const AGENT_BACKEND_HINT =
  'backend agent: the real Trav runtime over mock providers. ' +
  'Approve or 👍 on a proposal books it (mock purchase, receipt in the group, one ticket DM each). ' +
  'No real money or messages';

type CreateTravRuntime = (input: SimRuntimeInput) => SimRuntimeOutput | Promise<SimRuntimeOutput>;

function notConfigured(why: string): TravError {
  return new TravError('not_implemented', `not_configured: ${why}`);
}

/** Loads `createTravRuntime` from `@trav/agent` without a static import. */
async function importCreateTravRuntime(): Promise<CreateTravRuntime> {
  const mod: Record<string, unknown> = await import('@trav/agent');
  const create = mod['createTravRuntime'];
  if (typeof create !== 'function') {
    throw notConfigured('@trav/agent does not export createTravRuntime');
  }
  return create as CreateTravRuntime;
}

export interface LoadAgentOptions {
  /** Force offline mode. Default false: the runtime decides (env + key). */
  readonly offline?: boolean;
  readonly groups?: readonly SimGroup[];
  /** Simulated trip time to start at. Default: Barcelona, sat mar 14, 9:39pm. */
  readonly startAt?: string;
  /**
   * Open on demo state 1 (`seed.ts`): the seed lines go through the channel
   * into the runtime, then the clock sits at `startAt`. Applies to the first
   * session and to every `reset()` that doesn't pass `seed: false` (the
   * replay's first step). Default false.
   */
  readonly seed?: boolean;
  /** Test seam: replaces the dynamic import. */
  readonly createTravRuntime?: CreateTravRuntime;
}

/** Barcelona, sat mar 14, 9:39pm: a minute before the Razzmatazz ask. */
export const AGENT_DEMO_START = '2026-03-14T21:39:30+01:00';

export async function loadAgentBackend(options: LoadAgentOptions): Promise<SimulatorBackend> {
  const groups = options.groups ?? SIM_GROUPS;
  const create = options.createTravRuntime ?? (await importCreateTravRuntime());
  const forceOffline = options.offline === true;
  // The runtime of the live session, and of the one a reset is building.
  let active: SimRuntimeOutput | undefined;
  let pending: SimRuntimeOutput | undefined;

  const makeSession = async (reset: ResetOptions): Promise<ChannelBackend> => {
    const startAt = reset.startAt ?? options.startAt ?? AGENT_DEMO_START;
    const seed = options.seed === true && reset.seed !== false;
    // Seeding starts the clock at the first seed line; the session then sits at `startAt`.
    const clock = createSimulatedClock(seed ? SEED_START : startAt);
    const channel = createSimulatorChannel({ clock, conversations: toConversations(groups) });
    // The one call into the real runtime. Adjust the input/output mapping
    // here (and only here) if compose.ts changes.
    const runtime = await create({ channel, clock, offline: forceOffline });
    const agent = runtime?.agent;
    if (!agent || typeof agent.handleInbound !== 'function') {
      throw notConfigured('createTravRuntime did not return { agent: TravAgent }');
    }
    pending = runtime;
    // The badge follows the model client's real mode, not an env-var guess.
    const mode = runtime.model?.mode;
    const offline = mode !== undefined ? mode === 'offline' : forceOffline;
    const backend = createAgentBackend({
      agent,
      channel,
      clock,
      groups,
      offline,
      services: servicesOf(runtime, clock),
    });
    // Lisbon and Turks and Caicos come from fixtures/groups (the runtime seeds Barcelona).
    if (runtime.stores) seedFixtureGroups(runtime.stores, groups);
    // The family-mode notice posts once per group with a minor (Turks and Caicos):
    // first thing in that chat, before its seed lines, or right away unseeded.
    const announce = async (groupId: string): Promise<void> => {
      await runtime.announceFamilyMode?.(groupId);
    };
    if (seed) {
      await seedChat(
        channel,
        clock,
        new Set(groups.map((g) => g.conversationId)),
        startAt,
        async (conversationId) => {
          const g = groups.find((x) => x.conversationId === conversationId);
          if (g !== undefined) await announce(g.groupId);
        },
      );
      // Groups without seed lines still get their notice.
      for (const g of groups) await announce(g.groupId);
    } else {
      for (const g of groups) await announce(g.groupId);
    }
    return backend;
  };

  const first = await makeSession({});
  active = pending;
  return createSessionBackend('agent', makeSession, first, () => {
    // The old session's stores are closed only once the new one is live.
    const old = active;
    active = pending;
    old?.close?.();
  });
}

export interface SelectBackendOptions {
  readonly choice: BackendChoice;
  /** Force offline mode for the agent runtime. Default: the runtime decides. */
  readonly offline?: boolean;
  /** Open on demo state 1 (see `LoadAgentOptions.seed`). */
  readonly seed?: boolean;
  readonly log?: (line: string) => void;
  readonly createTravRuntime?: CreateTravRuntime;
}

/** The backend `pnpm sim` serves: the agent runtime, or a loud failure if it can't load. */
export async function selectBackend(options: SelectBackendOptions): Promise<SimulatorBackend> {
  const backend = await loadAgentBackend({
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.createTravRuntime ? { createTravRuntime: options.createTravRuntime } : {}),
  });
  options.log?.(AGENT_BACKEND_HINT);
  return backend;
}
