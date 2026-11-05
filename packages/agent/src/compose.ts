/**
 * Composition root: `createTravRuntime(options)` wires stores, clock, ids,
 * model client, tools, providers, executor, scheduler, memory, proposals and
 * the single send path (`outbound/send.ts`) into one `TravAgent` for the CLI,
 * the simulator and the evals.
 *
 * Defaults are the offline demo: in-memory stores seeded with the Barcelona
 * group (ids and handles follow `fixtures/_gen/trips.mjs` and the simulator's
 * groups), mock tickets/flights/lodging/payments, the offline model client,
 * an in-memory scheduler. Everything is overridable. Nothing here talks to a
 * network.
 *
 * The simulator calls `createTravRuntime({ channel, clock, offline })`, reads
 * back `{ agent }` and feeds `agent.handleInbound` itself, so the runtime does
 * not subscribe to the channel unless `subscribe: true` is passed.
 */
import type {
  Activity,
  Attendance,
  Clock,
  Group,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  Outbound,
  ScheduledJob,
  Scheduler,
  Stores,
  Trip,
} from '@trav/core';
import {
  createInMemoryScheduler,
  createSimulatedClock,
  createUlidIdGenerator,
  DEFAULT_GROUP_SETTINGS,
  defaultSpendingPolicy,
  parseIso,
  TravError,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type { AlbumAdapter, ChannelAdapter, TransactionsAdapter } from '@trav/adapters';
import {
  createMockBookingPayments,
  createMockFlights,
  createMockLodging,
  createMockTickets,
  createMockTransactions,
  loadAllTicketInventories,
} from '@trav/adapters';
import type { ApprovalHandler } from './approval/events.js';
import { normalizeApprovalEvent } from './approval/events.js';
import { createApprovalHandler } from './approval/handler.js';
import {
  createBookingExecutor,
  type BookingExecutor,
  type ProviderRegistry,
} from './booking/executor.js';
import { createProposalService, type ProposalService } from './booking/proposals.js';
import {
  createTravAgent,
  type AgentDeps,
  type TravAgent,
  type TurnResult,
  type TurnSender,
} from './loop.js';
import {
  createGroupMemory,
  createMemberMemory,
  type GroupMemory,
  type MemberMemory,
} from './memory/index.js';
import { createModelClient, readModelEnv, type ModelClient } from './model/client.js';
import { sendTurn as sendTurnViaSendPath, type SendDeps } from './outbound/send.js';
import { morningAfterJobsFor } from './recaps/morningAfter.js';
import { wrappedJobFor } from './recaps/wrapped.js';
import { announceFamilyMode } from './settings/flow.js';
import { createV0ToolRegistry } from './tools/index.js';
import type { ToolRegistry } from './tools/registry.js';

export interface TravRuntimeOptions {
  readonly channel: ChannelAdapter;
  /** Default: a simulated clock at the Barcelona "Razzmatazz moment" (sat 14 mar 2026, 9:40pm). */
  readonly clock?: Clock;
  readonly startAt?: IsoDateTime;
  /** Set by the simulator; the model client reads `TRAV_OFFLINE` itself, this forces offline when true. */
  readonly offline?: boolean;
  readonly ids?: IdGenerator;
  /** Default: in-memory stores seeded with `seed` (Barcelona). */
  readonly stores?: Stores;
  /** `'barcelona'` (default when `stores` is not given) or `'none'`. */
  readonly seed?: 'barcelona' | 'none';
  readonly model?: ModelClient;
  /** Environment for the model client; default `process.env`. Never logged. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly providers?: Partial<ProviderRegistry>;
  /** Shared album for Wrapped's photos (T-016/T-029). Default: none (no photos). */
  readonly album?: AlbumAdapter;
  /**
   * Linked cards (T-067). Default: the Plaid-shaped mock on this runtime's
   * clock (only charges that already happened), synced at the VOICE §2 digest
   * slots for every owner with `cardImport` on. `false` ⇒ no provider and no
   * scheduled card imports (callers that drive imports themselves).
   */
  readonly transactions?: TransactionsAdapter | false;
  readonly scheduler?: Scheduler;
  /** Default: `outbound/send.ts` (screen → voice lint → lane → audit). */
  readonly sendTurn?: TurnSender;
  /** `strict` throws on a voice violation (default under Vitest); `log` reports and sends. */
  readonly voice?: SendDeps['voice'];
  readonly onLintViolation?: SendDeps['onLintViolation'];
  /**
   * The booking executor (THE purchase call site). Default:
   * `createBookingExecutor` over `providers` (T-009). Tests inject a
   * recording fake; the approval handler is its only caller.
   */
  readonly executor?: BookingExecutor;
  /** Default: `createApprovalHandler` over the stores, executor, proposals and scheduler (T-030). */
  readonly approvalHandler?: ApprovalHandler;
  readonly maxToolRounds?: number;
  /** Called after every turn the channel subscription or `drain()` triggers. */
  readonly onTurn?: (result: TurnResult) => void;
  /** Subscribe `agent.handleInbound` to `channel.onEvent` (default false: the caller feeds events). */
  readonly subscribe?: boolean;
}

export interface TravRuntime {
  readonly agent: TravAgent;
  readonly stores: Stores;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly model: ModelClient;
  readonly channel: ChannelAdapter;
  readonly providers: ProviderRegistry;
  readonly executor: BookingExecutor;
  readonly approvalHandler: ApprovalHandler;
  readonly scheduler: Scheduler;
  readonly tools: ToolRegistry;
  readonly groupMemory: GroupMemory;
  readonly memberMemory: MemberMemory;
  readonly proposals: ProposalService;
  /** The linked-card provider scheduled imports sync from (undefined when turned off). */
  readonly transactions?: TransactionsAdapter;
  /** Turns produced by the channel subscription and `drain()`, in order. */
  readonly turns: readonly TurnResult[];
  /**
   * Run every due scheduled job (`scheduler.drain(clock.now())`) through the
   * agent. `groupId` limits it to that group's jobs (D-035: the simulator
   * keeps one clock per chat, so one chat's clock step never runs another
   * trip's jobs); every other job stays queued.
   */
  drain(options?: { readonly groupId?: string }): Promise<readonly TurnResult[]>;
  /**
   * T-094: schedule the recap jobs (Morning After + daily settle-up, Wrapped)
   * still ahead for the given groups' planning or active trips. For groups a
   * caller wrote into the stores after the runtime was built (the simulator's
   * Lisbon and Turks and Caicos fixtures). A job already queued is left as is,
   * and a job whose time has passed (it ran, or was skipped) is never added, so
   * calling this again, or for an already-scheduled group, never double-posts.
   * Returns the jobIds added.
   */
  scheduleTripJobs(groupIds: readonly string[]): readonly string[];
  /**
   * VOICE §8: post the family-mode notice once, as its own message, when the
   * group is in family mode and has not been told yet (`announceFamilyMode`
   * in `settings/flow.ts`). Call after seeding a group or changing its roster.
   */
  announceFamilyMode(groupId: string): Promise<readonly Outbound[]>;
  /** Unsubscribe from the channel and close the stores. */
  close(): void;
}

export const BARCELONA_NOW: IsoDateTime = '2026-03-14T21:40:00+01:00';

export function createTravRuntime(options: TravRuntimeOptions): TravRuntime {
  const clock = options.clock ?? createSimulatedClock(options.startAt ?? BARCELONA_NOW);
  const ids = options.ids ?? createUlidIdGenerator(clock);
  const stores = options.stores ?? createMemoryStores({ clock, ids });
  const seed = options.seed ?? (options.stores === undefined ? 'barcelona' : 'none');
  const seeded = seed === 'barcelona' && stores.group.groups.get(BARCELONA.groupId) === undefined;
  if (seeded) seedBarcelona(stores);
  const env = readModelEnv({
    ...(options.env ?? process.env),
    ...(options.offline === true ? { TRAV_OFFLINE: '1' } : {}),
  });
  const model = options.model ?? createModelClient({ env, clock });
  const providers: ProviderRegistry = {
    tickets:
      options.providers?.tickets ??
      // Every bundled trip's inventory (T-093): search filters by the trip's
      // city, so each group finds its own trip's events.
      createMockTickets({ clock, ids, inventory: loadAllTicketInventories() }),
    flights: options.providers?.flights ?? createMockFlights({ clock }),
    lodging: options.providers?.lodging ?? createMockLodging({ clock }),
    payments: options.providers?.payments ?? createMockBookingPayments({ clock }),
  };
  const scheduler = options.scheduler ?? createInMemoryScheduler();
  const transactions =
    options.transactions === false
      ? undefined
      : (options.transactions ?? createMockTransactions({ clock }));
  // Every planned or active trip's Morning Afters (T-015, 10am each morning
  // after a trip night) and end-of-trip Wrapped (T-016/T-142, 10am the day
  // after) still ahead, whoever seeded the stores (the demo seed, the evals,
  // a fixture loader). One pass per trip and jobs are idempotent by jobId, so
  // the seeded demo trip is scheduled exactly once.
  for (const job of recapJobsFor(stores, clock.now())) scheduler.schedule(job);
  const groupMemory = createGroupMemory({ repo: stores.group.groupMemory, ids });
  const memberMemory = createMemberMemory({ store: stores.private, ids });
  const proposals = createProposalService({ stores, tickets: providers.tickets, clock, ids });
  const tools = createV0ToolRegistry({
    proposals,
    tickets: providers.tickets,
    flights: providers.flights,
    lodging: providers.lodging,
    groupMemory,
    memberMemory,
  });
  const executor = options.executor ?? createLazyExecutor({ stores, providers, clock, ids });
  const approvalHandler =
    options.approvalHandler ??
    createApprovalHandler({ stores, executor, proposals, scheduler, clock, ids });
  const sendTurn =
    options.sendTurn ??
    createSendPathSender(options.channel, stores, clock, {
      ids,
      ...(options.voice !== undefined ? { voice: options.voice } : {}),
      ...(options.onLintViolation !== undefined
        ? { onLintViolation: options.onLintViolation }
        : {}),
    });

  const deps: AgentDeps = {
    stores,
    model,
    tools,
    channel: options.channel,
    providers,
    executor,
    clock,
    ids,
    scheduler,
    groupMemory,
    memberMemory,
    proposals,
    sendTurn,
    approval: { normalize: normalizeApprovalEvent, handler: approvalHandler },
    ...(options.album !== undefined ? { album: options.album } : {}),
    ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
    ...(transactions !== undefined ? { transactions } : {}),
  };
  const agent = createTravAgent(deps);

  const turns: TurnResult[] = [];
  let unsubscribe: (() => void) | undefined;
  if (options.subscribe === true) {
    unsubscribe = options.channel.onEvent(async (event) => {
      const result = await agent.handleInbound(event);
      turns.push(result);
      options.onTurn?.(result);
    });
  }

  return {
    agent,
    stores,
    clock,
    ids,
    model,
    channel: options.channel,
    providers,
    executor,
    approvalHandler,
    scheduler,
    tools,
    groupMemory,
    memberMemory,
    proposals,
    ...(transactions !== undefined ? { transactions } : {}),
    turns,
    async drain(drainOptions) {
      const out: TurnResult[] = [];
      for (const job of dueJobs(scheduler, clock.now(), drainOptions?.groupId)) {
        const result = await agent.runScheduled(job);
        turns.push(result);
        options.onTurn?.(result);
        out.push(result);
      }
      return out;
    },
    scheduleTripJobs(groupIds) {
      const queued = new Set(scheduler.list().map((j) => j.jobId));
      const added: string[] = [];
      for (const job of recapJobsFor(stores, clock.now(), groupIds)) {
        if (queued.has(job.jobId)) continue;
        scheduler.schedule(job);
        added.push(job.jobId);
      }
      return added;
    },
    announceFamilyMode(groupId) {
      return announceFamilyMode({ stores, clock, ids, sendTurn }, groupId);
    },
    close() {
      unsubscribe?.();
      stores.close();
    },
  };
}

// ---------- recap scheduling ----------

/**
 * The jobs due at `now`, removed from the queue, in drain order. With a
 * `groupId`, only that group's (D-035); every other job stays queued.
 */
export function dueJobs(scheduler: Scheduler, now: IsoDateTime, groupId?: string): ScheduledJob[] {
  if (groupId === undefined) return scheduler.drain(now);
  const t = parseIso(now);
  // `list()` is in drain order (runAt, then scheduling order).
  const due = scheduler.list().filter((j) => j.groupId === groupId && parseIso(j.runAt) <= t);
  for (const j of due) scheduler.cancel(j.jobId);
  return due;
}

/**
 * The recap jobs still ahead of `now` for every planning or active trip in the
 * stores: each Morning After, then the trip's Wrapped. Pure over the stores;
 * one entry per jobId. `groupIds` limits it to those groups (default: all).
 */
export function recapJobsFor(
  stores: Stores,
  now: IsoDateTime,
  groupIds?: readonly string[],
): ScheduledJob[] {
  const t = parseIso(now);
  const only = groupIds === undefined ? undefined : new Set(groupIds);
  const out = new Map<string, ScheduledJob>();
  for (const g of stores.group.groups.list()) {
    if (only !== undefined && !only.has(g.groupId)) continue;
    for (const trip of stores.group.trips.listByGroup(g.groupId)) {
      if (trip.status !== 'planning' && trip.status !== 'active') continue;
      for (const job of [...morningAfterJobsFor(trip), wrappedJobFor(trip)])
        if (parseIso(job.runAt) > t) out.set(job.jobId, job);
    }
  }
  return [...out.values()];
}

// ---------- executor ----------

/**
 * The real executor behind one delegating `execute` (the A1b arch check
 * allows exactly this one delegation outside the approval handler). Built on
 * first use so a runtime that never books never constructs it.
 */
function createLazyExecutor(deps: Parameters<typeof createBookingExecutor>[0]): BookingExecutor {
  let real: BookingExecutor | undefined;
  return {
    async execute(proposalId, grantId) {
      if (real === undefined) real = createBookingExecutor(deps);
      return real.execute(proposalId, grantId);
    },
  };
}

// ---------- the send path ----------

/** Adapts the loop's `TurnSender` to `outbound/send.ts` (`sendTurn`), the one production path (D-009). */
export function createSendPathSender(
  channel: ChannelAdapter,
  stores: Stores,
  clock: Clock,
  extra: Pick<SendDeps, 'ids' | 'voice' | 'onLintViolation'> = {},
): TurnSender {
  return (outbounds, ctx) =>
    sendTurnViaSendPath(
      outbounds,
      {
        channel,
        group: ctx.group,
        members: ctx.members,
        trip: ctx.trip,
        consent: (memberId) => stores.private.getConsent(memberId, ctx.group.groupId),
        audit: stores.group.audit,
        clock,
        handleFor: ctx.handleFor,
        ...extra,
      },
      ctx.optionsFor,
    );
}

// ---------- the Barcelona seed (ids and handles follow fixtures/_gen/trips.mjs) ----------

export interface BarcelonaSeed {
  readonly groupId: string;
  readonly tripId: string;
  readonly conversationId: string;
  readonly razzmatazzActivityId: string;
  readonly members: readonly {
    readonly memberId: MemberId;
    readonly name: string;
    readonly handle: string;
  }[];
}

export const BARCELONA: BarcelonaSeed = {
  groupId: 'grp_barcelona',
  tripId: 'trip_barcelona',
  conversationId: 'conv_barcelona',
  razzmatazzActivityId: 'act_bcn_razzmatazz',
  members: [
    { memberId: 'mem_dean', name: 'Dean', handle: 'h_dean' },
    { memberId: 'mem_henry', name: 'Henry', handle: 'h_henry' },
    { memberId: 'mem_maya', name: 'Maya', handle: 'h_maya' },
    { memberId: 'mem_jordan', name: 'Jordan', handle: 'h_jordan' },
    { memberId: 'mem_priya', name: 'Priya', handle: 'h_priya' },
    { memberId: 'mem_sam', name: 'Sam', handle: 'h_sam' },
  ],
};

/** Six adults, Dean leads, €60/person cap, trip 12–17 mar 2026, Razzmatazz planned for saturday night with everyone in. */
export function seedBarcelona(stores: Stores): BarcelonaSeed {
  const created = '2026-02-03T20:00:00-05:00';
  const b = BARCELONA;
  if (stores.group.groups.get(b.groupId) !== undefined) {
    throw new TravError('duplicate', 'barcelona group already seeded');
  }
  const group: Group = {
    groupId: b.groupId,
    name: 'barcelona 🇪🇸',
    conversationId: b.conversationId,
    channelKind: 'simulator',
    currency: 'EUR',
    settings: { ...DEFAULT_GROUP_SETTINGS, allAdultsConfirmed: true },
    spendingPolicy: { ...defaultSpendingPolicy(b.groupId, 'EUR'), perPersonAutoCapMinor: 6000 },
    createdAt: created,
  };
  stores.group.groups.create(group);
  const birthDates: Record<string, string> = {
    mem_dean: '2004-05-02',
    mem_henry: '2003-11-19',
    mem_maya: '2005-01-27',
    mem_jordan: '2005-08-14',
    mem_priya: '2004-09-03',
    mem_sam: '2005-12-30',
  };
  for (const m of b.members) {
    const member: Member = {
      memberId: m.memberId,
      groupId: b.groupId,
      displayName: m.name,
      role: m.memberId === 'mem_dean' ? 'lead' : 'member',
      active: true,
      senderId: m.handle,
      birthDate: birthDates[m.memberId] ?? '2004-01-01',
      ageBand: 'adult',
      joinedAt: created,
    };
    stores.group.members.upsert(member);
  }
  const trip: Trip = {
    tripId: b.tripId,
    groupId: b.groupId,
    name: 'Barcelona spring break',
    city: 'Barcelona',
    countryCode: 'ES',
    timeZone: 'Europe/Madrid',
    startDate: '2026-03-12',
    endDate: '2026-03-17',
    currency: 'EUR',
    status: 'active',
    familyTab: false,
    createdBy: 'mem_dean',
    createdAt: created,
  };
  stores.group.trips.create(trip);
  const razz: Activity = {
    activityId: b.razzmatazzActivityId,
    tripId: b.tripId,
    groupId: b.groupId,
    kind: 'nightlife',
    name: 'Razzmatazz',
    venue: 'Razzmatazz',
    address: 'Carrer dels Almogàvers 122',
    startsAt: '2026-03-15T00:00:00+01:00',
    endsAt: '2026-03-15T06:00:00+01:00',
    contentTags: ['nightlife', 'club', '18+', 'alcohol', 'late_night'],
    ageRestriction: 18,
    createdAt: '2026-03-10T12:30:00-04:00',
  };
  stores.group.trips.upsertActivity(razz);
  for (const m of b.members) {
    const row: Attendance = {
      activityId: razz.activityId,
      memberId: m.memberId,
      status: 'in',
      updatedAt: '2026-03-10T12:30:00-04:00',
      sourceMessageId: 'msg_bcn_razz_plan',
      setBy: 'mem_sam',
    };
    stores.group.trips.setAttendance(row);
  }
  return b;
}
