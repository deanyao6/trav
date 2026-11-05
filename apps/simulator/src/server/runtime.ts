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
import { createMockAlbum, createSimulatorChannel } from '@trav/adapters';
import type { AlbumAdapter, SimulatorChannel } from '@trav/adapters';
import { TravError, createSimulatedClock } from '@trav/core';
import type { Clock, ScheduledJob, Stores } from '@trav/core';
import type { TravAgent, TurnResult } from '@trav/agent';
import type { SimGroup } from '../shared/types.js';
import type { ChannelBackend, ResetOptions, SimulatorBackend } from './backend.js';
import { createAgentBackend, createSessionBackend, servicesOf } from './backend.js';
import { createGroupClocks } from './groupClocks.js';
import { SIM_GROUPS, toConversations } from './groups.js';
import { SEED_START, seedChat, seedFixtureGroups } from './seed.js';
import type { PhotoVisible } from './state.js';

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
  /**
   * T-200 (QA-08): the mock shared album (`createMockAlbum`, `fixtures/album/`).
   * It filters by each owner's photos flag at query time, so recaps and
   * Wrapped show only opted-in members' photos (SAFETY §2.6).
   */
  readonly album?: AlbumAdapter;
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
  /**
   * `scheduler.drain(clock.now())` through `agent.runScheduled` (the top-bar
   * clock); `groupId` limits it to that chat's jobs (D-035).
   */
  drain?(options?: { readonly groupId?: string }): Promise<readonly TurnResult[]>;
  /** Close the stores (called when the simulator starts over). */
  close?(): void;
  /**
   * The runtime's stores: the simulator seeds the non-Barcelona groups into
   * them (`seed.ts`) and reads each member's current photos flag from
   * `private` so an old recap re-renders without an opted-out member's photos.
   */
  readonly stores?: Pick<Stores, 'group'> & Partial<Pick<Stores, 'private'>>;
  /** T-094: schedules the recap jobs for groups seeded after the runtime was built (`seed.ts`). */
  scheduleTripJobs?(groupIds: readonly string[]): readonly unknown[];
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
  /**
   * Simulated time the first chat starts at. Default: Barcelona, sat mar 14,
   * 9:39pm. The other chats start at their `opensAt` (T-095), else here too.
   */
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
  /**
   * T-169: builds each session's channel. Default: the in-memory simulator
   * channel. `pnpm relay:dev` passes the relay loopback (`relay.ts`), so the
   * same UI and runtime run over the iMessage relay adapter and mock vendor.
   */
  readonly channelFactory?: SimChannelFactory;
}

/** One session's channel, on that session's clock. */
export type SimChannelFactory = (input: {
  readonly clock: Clock;
  readonly conversations: ReturnType<typeof toConversations>;
}) => SimulatorChannel;

/**
 * T-200 (SAFETY §2.6, G2): a member's photos show in a recap or Wrapped only
 * while their photos flag is on for that group, read at render time, so
 * "photos off" also hides them from cards already in the thread. A runtime
 * without a private store gets no filter (its cards carry no album photos).
 */
export function photoConsentOf(runtime: Pick<SimRuntimeOutput, 'stores'>): {
  readonly photoVisible?: PhotoVisible;
} {
  const store = runtime.stores?.private;
  if (store === undefined) return {};
  const on = (memberId: string, groupId: string): boolean => {
    const flags = store.getConsent(memberId, groupId);
    return flags?.photos === true && flags.memberId === memberId && flags.groupId === groupId;
  };
  return {
    photoVisible: (groupId, memberId) => {
      if (!on(memberId, groupId)) return false;
      // A minor's photo also needs their guardian's flag on (SAFETY §2.6).
      const guardian = runtime.stores?.group.members.get(memberId)?.guardianMemberId;
      return guardian === undefined || on(guardian, groupId);
    },
  };
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
    // T-095 (D-035): one clock per chat over the runtime's clock. The first
    // chat (Barcelona) starts at `startAt`; the others on their own trip
    // (`SimGroup.opensAt`), so no chat has to step through another trip's days.
    const clocks = createGroupClocks(
      clock,
      groups.map((g, i) => [g.groupId, i === 0 ? startAt : (g.opensAt ?? startAt)] as const),
    );
    const firstGroupId = groups[0]!.groupId;
    // While the session is built, turns run on the clock as the seed lines set it.
    clocks.pin();
    const conversations = toConversations(groups);
    const channel =
      options.channelFactory?.({ clock, conversations }) ??
      createSimulatorChannel({ clock, conversations });
    // The one call into the real runtime. Adjust the input/output mapping
    // here (and only here) if compose.ts changes.
    // A fresh album per session, on the session clock (T-200).
    const album = createMockAlbum({ clock });
    const runtime = await create({ channel, clock, offline: forceOffline, album });
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
      clocks,
      ...photoConsentOf(runtime),
    });
    // Lisbon and Turks and Caicos come from fixtures/groups (the runtime seeds Barcelona).
    // T-094: the runtime scheduled recap jobs for what was in its stores when
    // it was built (Barcelona); the fixture trips get theirs here (Morning
    // After + daily settle-up, Wrapped). Only the groups just seeded, and a
    // queued job is never replaced, so Barcelona's jobs are scheduled once.
    // T-095: each from its own chat's opening time, so a job before the chat
    // opens is never queued to fire late on its first clock step.
    if (runtime.stores) {
      for (const id of seedFixtureGroups(runtime.stores, groups)) {
        clocks.within(id, () => runtime.scheduleTripJobs?.([id]));
      }
    }
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
    }
    // Groups without seed lines (or an unseeded session) get their notice
    // too, at their own chat's time (T-095).
    for (const g of groups) {
      clocks.activate(g.groupId);
      await announce(g.groupId);
    }
    clocks.activate(firstGroupId);
    clocks.unpin();
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
  /** T-169: see `LoadAgentOptions.channelFactory`. */
  readonly channelFactory?: SimChannelFactory;
}

/** The backend `pnpm sim` serves: the agent runtime, or a loud failure if it can't load. */
export async function selectBackend(options: SelectBackendOptions): Promise<SimulatorBackend> {
  const backend = await loadAgentBackend({
    ...(options.offline !== undefined ? { offline: options.offline } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.createTravRuntime ? { createTravRuntime: options.createTravRuntime } : {}),
    ...(options.channelFactory ? { channelFactory: options.channelFactory } : {}),
  });
  options.log?.(AGENT_BACKEND_HINT);
  return backend;
}
