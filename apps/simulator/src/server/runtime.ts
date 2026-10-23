/**
 * Picks the simulator backend.
 *
 *   TRAV_SIM_BACKEND=scripted  the Barcelona demo script (scripted.ts)
 *   TRAV_SIM_BACKEND=agent     the real Trav runtime; fails loudly if it can't load
 *   (unset)                    the agent runtime if it loads, else the script
 *
 * `auto` prefers the real runtime because it is the product. The approval
 * handler (T-030) is wired; until the booking executor lands (T-009) an
 * Approve/👍 ends in Trav's own "couldn't book, no charge" line, so the
 * startup log points at `TRAV_SIM_BACKEND=scripted` for the full demo. A
 * runtime without the handler still gets the `approval:handler_not_wired`
 * status line in the UI.
 *
 * The agent runtime comes from `createTravRuntime` in `@trav/agent`
 * (packages/agent/src/compose.ts, T-009/T-021). It is looked up at runtime
 * through a dynamic import so this file typechecks and runs before that
 * export exists; until then `loadAgentBackend` throws `TravError` with a
 * `not_configured:` message and the default mode falls back to the script.
 */
import { createSimulatorChannel } from '@trav/adapters';
import type { SimulatorChannel } from '@trav/adapters';
import { TravError, createSimulatedClock } from '@trav/core';
import type { Clock, ScheduledJob } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { SimGroup } from '../shared/types.js';
import type { ChannelBackend, ResetOptions, SimulatorBackend } from './backend.js';
import { createAgentBackend, createSessionBackend, servicesOf } from './backend.js';
import { SIM_GROUPS, toConversations } from './groups.js';
import { createScriptedBackend } from './scripted.js';

export type BackendChoice = 'scripted' | 'agent' | 'auto';

export function backendChoice(value: string | undefined): BackendChoice {
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  if (value === 'scripted' || value === 'agent') return value;
  throw new TravError(
    'invalid_argument',
    `TRAV_SIM_BACKEND must be scripted, agent or auto, got "${value}"`,
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
}

/** Printed at startup whenever the simulator runs the real agent runtime. */
export const AGENT_BACKEND_HINT =
  'backend agent: the real Trav runtime. until the booking executor lands (T-009), ' +
  'Approve and 👍 on a proposal end in "couldn\'t book, no charge" here. ' +
  'for the full Barcelona demo (chat → proposal → receipt + tickets) run ' +
  'TRAV_SIM_BACKEND=scripted pnpm sim';

type CreateTravRuntime = (input: SimRuntimeInput) => SimRuntimeOutput | Promise<SimRuntimeOutput>;

function notConfigured(why: string): TravError {
  return new TravError('not_implemented', `not_configured: ${why}`);
}

/** Loads `createTravRuntime` from `@trav/agent` without a static import. */
async function importCreateTravRuntime(): Promise<CreateTravRuntime> {
  const mod: Record<string, unknown> = await import('@trav/agent');
  const create = mod['createTravRuntime'];
  if (typeof create !== 'function') {
    throw notConfigured('@trav/agent does not export createTravRuntime yet (T-009/T-021)');
  }
  return create as CreateTravRuntime;
}

export interface LoadAgentOptions {
  /** Force offline mode. Default false: the runtime decides (env + key). */
  readonly offline?: boolean;
  readonly groups?: readonly SimGroup[];
  /** Simulated trip time to start at. Default: Barcelona, sat mar 14, 9:39pm. */
  readonly startAt?: string;
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
    const clock = createSimulatedClock(reset.startAt ?? options.startAt ?? AGENT_DEMO_START);
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
    return createAgentBackend({
      agent,
      channel,
      clock,
      groups,
      offline,
      services: servicesOf(runtime, clock),
    });
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
  readonly responseDelayMs?: number;
  readonly log?: (line: string) => void;
  readonly createTravRuntime?: CreateTravRuntime;
}

export async function selectBackend(options: SelectBackendOptions): Promise<SimulatorBackend> {
  const scripted = (): Promise<SimulatorBackend> =>
    createScriptedBackend(
      options.responseDelayMs !== undefined ? { responseDelayMs: options.responseDelayMs } : {},
    );
  if (options.choice === 'scripted') return scripted();
  const agentOptions: LoadAgentOptions = {
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
    ...(options.createTravRuntime ? { createTravRuntime: options.createTravRuntime } : {}),
  };
  const agent = async (): Promise<SimulatorBackend> => {
    const backend = await loadAgentBackend(agentOptions);
    options.log?.(AGENT_BACKEND_HINT);
    return backend;
  };
  if (options.choice === 'agent') return agent();
  try {
    return await agent();
  } catch (e) {
    if (
      e instanceof TravError &&
      (e.code === 'not_implemented' || e.code === 'offline_script_missing')
    ) {
      options.log?.(
        `agent runtime not available (${e.message}); using the scripted Barcelona demo`,
      );
      return scripted();
    }
    throw e;
  }
}
