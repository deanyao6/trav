/**
 * Test fixtures for the simulator (not used at runtime): a Morning After and
 * a Wrapped message rendered by the agent's real card renderers
 * (`renderRecap`, `renderWrappedForSend`) from the Barcelona fixture numbers
 * (`fixtures/recaps/barcelona.json` 2026-03-15, `fixtures/wrapped/barcelona.json`).
 *
 * They stand in for what T-015 / T-016 send from `agent.runScheduled`, so the
 * simulator's hook (clock step → scheduler drain → channel → group thread →
 * `recap` / `wrapped` card in the UI) is tested with fixed numbers; the real
 * jobs run end to end in `demo-path.test.ts` (agent backend).
 */
import type {
  IsoDateTime,
  Member,
  OutboundMessage,
  RecapCard,
  ScheduledJob,
  WrappedCard,
} from '@trav/core';
import {
  DEFAULT_GROUP_SETTINGS,
  createDeterministicIdGenerator,
  createInMemoryScheduler,
  defaultConsent,
  defaultSpendingPolicy,
  money,
} from '@trav/core';
import type { RenderContext, SafetyContext, TravAgent, TurnResult } from '@trav/agent';
import { renderRecap, renderWrappedForSend } from '@trav/agent';
import { BARCELONA } from './groups.js';
import type { SimRuntimeInput, SimRuntimeOutput } from './runtime.js';
import { loadAgentBackend } from './runtime.js';
import type { SimulatorBackend } from './backend.js';

/** The simulator as `pnpm sim` serves it, offline: the real runtime, opened on demo state 1. */
export function demoBackend(): Promise<SimulatorBackend> {
  return loadAgentBackend({ offline: true, seed: true });
}

/** Crowley at the club (fixtures/chats/barcelona.jsonl msg_bcn_0139): the charge is on the tab from chat. */
export const CROWLEY_WATERS = '@trav 2 waters in here were €28, €14 EACH, me and chase';

/**
 * T-067: move on to 9am the morning after Razzmatazz, past Crowley's 2:14am Uber
 * (his card sync only sees charges that already happened). With `waters`
 * (default), Crowley logs his €28 of waters at the club at 1:30am first, as in the
 * script, so his card's only new shared-looking charge is the Uber.
 */
export async function toMorningAfterRide(
  b: SimulatorBackend,
  opts: { readonly waters?: boolean } = {},
): Promise<void> {
  if (opts.waters !== false) {
    await b.advanceClock!({ to: '2026-03-15T01:30:00+01:00', groupId: BARCELONA.groupId });
    await b.inject({
      type: 'message',
      from: 'h_crowley',
      text: CROWLEY_WATERS,
      groupId: BARCELONA.groupId,
    });
  }
  await b.advanceClock!({ to: '2026-03-15T09:00:00+01:00', groupId: BARCELONA.groupId });
}

/** Mock purchases so far: one `receipt` card per completed booking, across every group thread. */
export function bookingCount(backend: Pick<SimulatorBackend, 'state'>): number {
  return backend
    .state()
    .groups.flatMap((g) => g.thread)
    .filter((e) => e.kind === 'message' && e.card?.type === 'receipt').length;
}

export const SILENT_TURN: TurnResult = {
  outbound: [],
  toolCalls: [],
  auditEventIds: [],
  silent: true,
  modelSources: [],
  note: 'fake',
};

/**
 * A stand-in runtime with a real in-memory scheduler holding Barcelona's
 * `morning_after` (sun 10am) and `wrapped` (wed 10am, the day after the trip)
 * jobs. Its `runScheduled` sends what T-015 / T-016 send (the agent's own
 * renderers, fixture numbers) on the group lane; `drain` is
 * `createTravRuntime`'s drain. `ran` lists the job kinds in drain order.
 */
export function recapRuntime(): {
  readonly create: (input: SimRuntimeInput) => SimRuntimeOutput;
  readonly ran: string[];
} {
  const scheduler = createInMemoryScheduler();
  const jobs: ScheduledJob[] = [
    {
      jobId: 'morning_after:trip_barcelona',
      groupId: BARCELONA.groupId,
      tripId: 'trip_barcelona',
      kind: 'morning_after',
      runAt: '2026-03-15T10:00:00+01:00',
      payload: {},
    },
    {
      jobId: 'wrapped:trip_barcelona',
      groupId: BARCELONA.groupId,
      tripId: 'trip_barcelona',
      kind: 'wrapped',
      runAt: '2026-03-18T10:00:00+01:00',
      payload: {},
    },
  ];
  for (const j of jobs) scheduler.schedule(j);
  const ran: string[] = [];
  const create = ({ channel, clock }: SimRuntimeInput): SimRuntimeOutput => {
    const agent: TravAgent = {
      handleInbound: () => Promise.resolve(SILENT_TURN),
      async runScheduled(job) {
        ran.push(job.kind);
        const msg =
          job.kind === 'morning_after'
            ? morningAfterMessage(clock.now())
            : job.kind === 'wrapped'
              ? wrappedMessage(clock.now())
              : undefined;
        if (!msg) return { ...SILENT_TURN, note: `scheduled:${job.kind}:not_handled` };
        const r = await channel.sendGroup(BARCELONA.conversationId, msg);
        if (!r.ok) throw new Error(r.error.message);
        return { ...SILENT_TURN, silent: false, note: `scheduled:${job.kind}` };
      },
      intakeDocument: () => Promise.reject(new Error('not used here')),
      importCardTransactions: () => Promise.reject(new Error('not used here')),
      importEmailReceipts: () => Promise.reject(new Error('not used here')),
      announceFamilyMode: () => Promise.resolve([]),
      pendingCards: {
        byMessageId: () => undefined,
        pendingProposalsRequestedBy: () => [],
        lastTravQuestion: () => undefined,
      },
    };
    return {
      agent,
      scheduler,
      async drain() {
        const out: TurnResult[] = [];
        for (const job of scheduler.drain(clock.now())) out.push(await agent.runScheduled(job));
        return out;
      },
    };
  };
  return { create, ran };
}

const eur = (minor: number) => money(minor, 'EUR');
const FIVE = ['mem_dean', 'mem_chase', 'mem_piotr', 'mem_arjun', 'mem_crowley'];

export function barcelonaMembers(): Member[] {
  return BARCELONA.members.map((m) => ({
    memberId: m.memberId,
    groupId: BARCELONA.groupId,
    displayName: m.name,
    role: m.memberId === 'mem_dean' ? 'lead' : 'member',
    active: true,
    senderId: m.handle,
    birthDate: '2004-06-01',
    ageBand: 'adult',
    joinedAt: '2026-02-03T20:00:00-05:00',
  }));
}

function ctx(now: IsoDateTime, idPrefix: string): RenderContext {
  return {
    groupId: BARCELONA.groupId,
    members: barcelonaMembers(),
    timeZone: BARCELONA.timeZone,
    now,
    ids: createDeterministicIdGenerator(idPrefix),
  };
}

function safetyCtx(): SafetyContext {
  return {
    group: {
      groupId: BARCELONA.groupId,
      name: BARCELONA.name,
      conversationId: BARCELONA.conversationId,
      channelKind: 'simulator',
      currency: 'EUR',
      settings: { ...DEFAULT_GROUP_SETTINGS, allAdultsConfirmed: true },
      spendingPolicy: defaultSpendingPolicy(BARCELONA.groupId, 'EUR'),
      createdAt: '2026-02-03T20:00:00-05:00',
    },
    trip: {
      tripId: 'trip_barcelona',
      groupId: BARCELONA.groupId,
      name: BARCELONA.tripName,
      city: 'Barcelona',
      countryCode: 'ES',
      timeZone: BARCELONA.timeZone,
      startDate: BARCELONA.tripStart,
      endDate: BARCELONA.tripEnd,
      currency: 'EUR',
      status: 'active',
      familyTab: false,
      createdBy: 'mem_dean',
      createdAt: '2026-02-03T20:00:00-05:00',
    },
    consent: (memberId) => defaultConsent(memberId, BARCELONA.groupId, '2026-02-03T20:00:00-05:00'),
  };
}

/** Sunday 10am after Razzmatazz: last night's four expenses (€264), the running tab. */
export function morningAfterMessage(
  now: IsoDateTime = '2026-03-15T10:00:00+01:00',
): OutboundMessage & { readonly card: RecapCard } {
  return renderRecap(
    {
      kind: 'morning_after',
      date: '2026-03-15',
      dayNumber: 4,
      lastNight: {
        events: [
          { label: 'dinner', attendees: FIVE, amount: eur(8400) },
          { label: 'razzmatazz', attendees: FIVE, amount: eur(9000) },
          { label: 'the 3am kebab place', attendees: FIVE, amount: eur(6200) },
        ],
        total: eur(23600),
        perPerson: eur(4720),
      },
      settle: {
        mode: 'running',
        currency: 'EUR',
        balances: [
          { memberId: 'mem_dean', net: eur(7200) },
          { memberId: 'mem_henry', net: eur(0) },
          { memberId: 'mem_chase', net: eur(-1800) },
          { memberId: 'mem_piotr', net: eur(-1800) },
          { memberId: 'mem_arjun', net: eur(-1800) },
          { memberId: 'mem_crowley', net: eur(-1800) },
        ],
        totalSpent: eur(23600),
        dayNumber: 4,
      },
      today: [
        {
          label: 'Barça vs Sevilla',
          startsAt: '2026-03-15T21:00:00+01:00',
          ticketsDelivered: true,
        },
      ],
    },
    ctx(now, 'simfix_recap'),
    safetyCtx(),
  );
}

/** Wednesday 10am, the day after the trip: totals from `fixtures/wrapped/barcelona.json`. */
export function wrappedMessage(
  now: IsoDateTime = '2026-03-18T10:00:00+01:00',
): OutboundMessage & { readonly card: WrappedCard } {
  return renderWrappedForSend(
    {
      trip: { name: BARCELONA.tripName, days: 6, people: 6, currency: 'EUR' },
      totals: {
        spent: eur(309364),
        perPerson: eur(51561),
        byCategory: [
          { category: 'lodging', amount: eur(138000) },
          { category: 'tickets', amount: eur(87600) },
          { category: 'food', amount: eur(57810) },
        ],
      },
      stats: [
        { label: 'expenses on the tab', value: '20' },
        { label: 'bookings', value: '3' },
      ],
      awards: [
        {
          title: 'MVP Spender',
          memberId: 'mem_dean',
          evidence: 'fronted the most',
          basis: 'ledger',
        },
        {
          title: 'Uber Captain',
          memberId: 'mem_crowley',
          evidence: 'the 2am ride',
          basis: 'ledger',
        },
        { title: 'Night Owl', memberId: 'mem_piotr', evidence: 'kebabs at 2am', basis: 'ledger' },
      ],
      finalSettle: {
        currency: 'EUR',
        balances: [
          { memberId: 'mem_dean', net: eur(9000) },
          { memberId: 'mem_henry', net: eur(-1800) },
          { memberId: 'mem_chase', net: eur(-3160) },
          { memberId: 'mem_piotr', net: eur(1500) },
          { memberId: 'mem_arjun', net: eur(-2740) },
          { memberId: 'mem_crowley', net: eur(-2800) },
        ],
        totalSpent: eur(309364),
      },
    },
    ctx(now, 'simfix_wrapped'),
    safetyCtx(),
  ).message;
}
