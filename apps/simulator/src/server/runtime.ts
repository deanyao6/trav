/**
 * Picks the simulator backend.
 *
 *   TRAV_SIM_BACKEND=scripted  the Barcelona demo script (scripted.ts)
 *   TRAV_SIM_BACKEND=agent     the real Trav runtime; fails loudly if it can't load
 *   (unset)                    the agent runtime if it loads, else the script
 *
 * `auto` prefers the real runtime because it is the product. Until T-030 wires
 * the approval handler, a proposal's Approve/👍 stops at the agent's gate
 * (`approval:handler_not_wired`): the startup log and the UI status line both
 * point at `TRAV_SIM_BACKEND=scripted` for the full demo.
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
import type { Clock } from '@trav/core';
import type { TravAgent } from '@trav/agent';
import type { SimGroup } from '../shared/types.js';
import type { SimulatorBackend } from './backend.js';
import { createAgentBackend } from './backend.js';
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
}

/** Printed at startup whenever the simulator runs the real agent runtime. */
export const AGENT_BACKEND_HINT =
  'backend agent: the real Trav runtime. until T-030 wires the approval handler, ' +
  'Approve and 👍 on a proposal do nothing here (the UI says so). ' +
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

export async function loadAgentBackend(options: LoadAgentOptions): Promise<SimulatorBackend> {
  const groups = options.groups ?? SIM_GROUPS;
  const clock = createSimulatedClock(options.startAt ?? '2026-03-14T21:39:30+01:00');
  const channel = createSimulatorChannel({ clock, conversations: toConversations(groups) });
  const create = options.createTravRuntime ?? (await importCreateTravRuntime());
  // T-009/T-021 wires this: the one call into the real runtime. Adjust the
  // input/output mapping here (and only here) when compose.ts lands.
  const forceOffline = options.offline === true;
  const runtime = await create({ channel, clock, offline: forceOffline });
  const agent = runtime?.agent;
  if (!agent || typeof agent.handleInbound !== 'function') {
    throw notConfigured('createTravRuntime did not return { agent: TravAgent }');
  }
  // The badge follows the model client's real mode, not an env-var guess.
  const mode = runtime.model?.mode;
  const offline = mode !== undefined ? mode === 'offline' : forceOffline;
  return createAgentBackend({ agent, channel, clock, groups, offline });
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
