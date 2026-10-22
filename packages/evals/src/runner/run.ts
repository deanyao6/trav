/**
 * Scenario runner: one scenario ⇒ one fresh `createTravRuntime` (in-memory
 * stores seeded from `fixtures/groups/<trip>.json`, simulated clock, mock
 * providers, the production send path in `log` voice mode so lint findings
 * are recorded instead of thrown) ⇒ one `Episode`.
 *
 * The model client is the agent's own (`createModelClient`): offline scripts
 * and fallbacks in CI, or — only when the caller asks for live mode — the live
 * client with the file spend guard on `.trav/spend.json`. Every request is
 * recorded (prompt text, tools, source) so graders can scan group prompts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AuditEvent,
  Booking,
  BookingProposal,
  ConsentFlags,
  Member,
  OutboundMessage,
  SimulatedClock,
} from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  defaultConsent,
  isReaction,
  parseIso,
  safety,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type { SimulatorChannel } from '@trav/adapters';
import {
  createMockBookingPayments,
  createMockFlights,
  createMockLodging,
  createMockTickets,
  createSimulatorChannel,
  loadTicketInventory,
} from '@trav/adapters';
import type {
  ClassifyRequest,
  CompletionRequest,
  DocumentIntakeResult,
  ModelClient,
  TurnResult,
} from '@trav/agent';
import { createModelClient, createTravRuntime, readModelEnv } from '@trav/agent';
import type { TripName } from '../fixtures.js';
import type {
  Episode,
  EvalMode,
  LintRecord,
  ProbeRecord,
  PromptRecord,
  Scenario,
  Step,
  StepRecord,
  TurnSummary,
} from '../types.js';
import { CARD_REF_PREFIX, expandSteps } from './expand.js';
import { runProbe } from './probes.js';
import { loadGroupFixture, seedGroup } from './seed.js';

/** Default start of the clock per trip when no step carries a time. */
export const DEFAULT_START: Readonly<Record<TripName, string>> = {
  barcelona: '2026-03-14T21:40:00+01:00',
  lisbon: '2026-04-17T08:30:00+01:00',
  'turks-and-caicos': '2026-06-20T18:00:00-04:00',
};

export interface RunOptions {
  readonly mode: EvalMode;
  /**
   * Builds the base model client for a scenario's clock. Default: the agent's
   * offline client with misses logged under `stateDir` (live mode must pass
   * `liveModelFactory`).
   */
  readonly modelFactory?: (clock: SimulatedClock) => ModelClient;
  /** Where offline misses go. Default: a fresh temp dir per run. */
  readonly stateDir?: string;
}

/** Offline client (scripts + fallbacks), misses logged to `<stateDir>/offline-misses.jsonl`. */
export function offlineModelFactory(stateDir: string): (clock: SimulatedClock) => ModelClient {
  return (clock) =>
    createModelClient({
      env: readModelEnv({ TRAV_OFFLINE: '1', TRAV_STATE_DIR: stateDir }),
      clock,
    });
}

/**
 * The live client from the real environment (key, models, `TRAV_LIVE_BUDGET_USD`,
 * spend guard on `.trav/spend.json`). Throws if the environment is offline, so
 * a caller can never believe it is live when it is not.
 */
export function liveModelFactory(
  env: Readonly<Record<string, string | undefined>>,
): (clock: SimulatedClock) => ModelClient {
  const modelEnv = readModelEnv(env);
  if (modelEnv.offline) throw new Error('live mode requested but the model environment is offline');
  return (clock) => createModelClient({ env: modelEnv, clock });
}

function laneOf(systemPromptId: string): PromptRecord['lane'] {
  if (systemPromptId.startsWith('group_chat')) return 'group';
  if (systemPromptId.startsWith('dm_chat')) return 'dm';
  return 'other';
}

function messagesText(req: CompletionRequest): string {
  return JSON.stringify(req.messages);
}

/** Records every request; delegates to `inner`. */
function recordingModel(
  inner: ModelClient,
  prompts: PromptRecord[],
  stepIndex: () => number,
): ModelClient {
  return {
    mode: inner.mode,
    async complete(req) {
      const res = await inner.complete(req);
      prompts.push({
        stepIndex: stepIndex(),
        kind: 'complete',
        systemPromptId: req.systemPromptId,
        lane: laneOf(req.systemPromptId),
        system: req.system,
        messages: messagesText(req),
        toolNames: req.tools.map((t) => t.name),
        source: res.source,
      });
      return res;
    },
    async classify<L extends string>(req: ClassifyRequest<L>) {
      const res = await inner.classify(req);
      prompts.push({
        stepIndex: stepIndex(),
        kind: 'classify',
        systemPromptId: req.systemPromptId,
        lane: 'other',
        system: req.system,
        messages: req.input,
        toolNames: [],
        source: res.source,
      });
      return res;
    },
  };
}

function summarizeTurn(r: TurnResult | DocumentIntakeResult): TurnSummary {
  const outbound: OutboundMessage[] = [];
  const reactions: string[] = [];
  for (const o of r.outbound) {
    if (isReaction(o)) reactions.push(o.emoji);
    else outbound.push(o);
  }
  const doc = 'injectionPatterns' in r ? r : undefined;
  return {
    outbound,
    reactions,
    toolCalls: [...r.toolCalls],
    silent: r.silent,
    modelSources: [...r.modelSources],
    note: r.note,
    ...(doc !== undefined
      ? {
          injectionPatterns: [...doc.injectionPatterns],
          lowConfidence: doc.lowConfidence,
          ...(doc.pendingItemId !== undefined ? { pendingItemId: doc.pendingItemId } : {}),
        }
      : {}),
  };
}

function stepLabel(step: Step): string {
  const cut = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);
  switch (step.do) {
    case 'say':
      // Labels reach grader evidence and reports; a DM's text is private.
      return step.lane === 'dm'
        ? `${step.from} (dm): [private message]`
        : `${step.from}: ${cut(step.text.replace(/\s+/g, ' '))}`;
    case 'react':
      return `${step.from} reacts ${step.reaction} on ${step.target}`;
    case 'tap':
      return `${step.from} taps ${step.actionId} on ${step.target}`;
    case 'advance':
      return `clock → ${step.to ?? `+${String(step.minutes ?? 0)}m`}`;
    case 'drain':
      return 'run scheduled jobs';
    case 'intake':
      return `intake ${step.source} ${step.itemId} (owner ${step.owner})`;
    case 'remember':
      return `remember (${step.lane}) for ${step.memberId}: ${cut(step.text)}`;
    case 'set_attendance':
      return `attendance ${step.memberId} ${step.status} for ${step.activityId}`;
    case 'patch_member':
      return `patch ${step.memberId} ${JSON.stringify(step.patch)}`;
    case 'probe':
      return `probe ${step.probe}`;
    case 'replay':
    case 'injection':
      return step.do;
  }
}

/** All participants: roster members plus any other handle the steps use (guests). */
function participants(members: readonly Member[], steps: readonly Step[]) {
  const known = new Set(members.map((m) => m.senderId));
  const out = members.map((m) => ({
    handle: m.senderId,
    displayName: m.displayName,
    memberId: m.memberId,
  }));
  for (const s of steps) {
    if (s.do !== 'say' && s.do !== 'react' && s.do !== 'tap') continue;
    if (s.from === '' || known.has(s.from)) continue;
    known.add(s.from);
    out.push({
      handle: s.from,
      displayName: (s.do === 'say' ? s.displayName : undefined) ?? s.from.replace(/^h_/, ''),
    } as (typeof out)[number]);
  }
  return out;
}

function firstAt(steps: readonly Step[]): string | undefined {
  for (const s of steps) if (s.at !== undefined) return s.at;
  return undefined;
}

export async function runScenario(scenario: Scenario, opts: RunOptions): Promise<Episode> {
  const trip: TripName = scenario.setup?.group ?? 'barcelona';
  const { steps, skipped } = expandSteps(scenario.steps);
  const start = scenario.setup?.startAt ?? firstAt(steps) ?? DEFAULT_START[trip];
  const clock = createSimulatedClock(start);
  const ids = createDeterministicIdGenerator(
    scenario.id.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'eval',
  );
  const stores = createMemoryStores({ clock, ids });
  const fixture = loadGroupFixture(trip);
  seedGroup(stores, trip, {
    extras: scenario.setup?.fixtureExtras === true,
    ...(scenario.setup?.settings !== undefined ? { settings: scenario.setup.settings } : {}),
  });
  const groupId = fixture.group.groupId;
  const tripId = fixture.trip.tripId;
  for (const [memberId, flags] of Object.entries(scenario.setup?.consent ?? {})) {
    const base =
      stores.private.getConsent(memberId, groupId) ?? defaultConsent(memberId, groupId, start);
    stores.private.putConsent(memberId, { ...base, ...flags, updatedAt: start });
  }

  const channel: SimulatorChannel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: fixture.group.conversationId,
        participants: participants(fixture.members, steps),
      },
    ],
  });
  const tickets = createMockTickets({ clock, ids, inventory: loadTicketInventory('barcelona') });
  const flightsMock = createMockFlights({ clock });
  const lodging = createMockLodging({ clock });
  const payments = createMockBookingPayments({ clock });

  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'trav-evals-'));
  const base = (opts.modelFactory ?? offlineModelFactory(stateDir))(clock);
  const prompts: PromptRecord[] = [];
  let current = -1;
  const model = recordingModel(base, prompts, () => current);
  const lint: LintRecord[] = [];

  const runtime = createTravRuntime({
    channel,
    clock,
    ids,
    stores,
    seed: 'none',
    model,
    offline: opts.mode === 'offline',
    env: { TRAV_OFFLINE: opts.mode === 'offline' ? '1' : undefined, TRAV_STATE_DIR: stateDir },
    providers: { tickets, flights: flightsMock, lodging, payments },
    voice: 'log',
    onLintViolation: (o, violations) => {
      lint.push({
        messageId: o.id,
        text: isReaction(o) ? o.emoji : o.text,
        violations: [...violations],
      });
    },
  });

  const purchases = (): number =>
    tickets.purchaseCount() + flightsMock.purchaseCount() + lodging.bookingCount();
  const auditAll = (): readonly AuditEvent[] => stores.group.audit.listByGroup(groupId);
  const expenseIds = (): Set<string> =>
    new Set(
      stores.group.expenses.listByTrip(tripId, { includeUndone: true }).map((e) => e.expenseId),
    );
  const consentNow = (): Record<string, ConsentFlags | undefined> =>
    Object.fromEntries(
      stores.group.members
        .listByGroup(groupId)
        .map((m) => [m.memberId, stores.private.getConsent(m.memberId, groupId)]),
    );

  const records: StepRecord[] = [];
  const probes: ProbeRecord[] = [];
  const byStepId = new Map<string, readonly OutboundMessage[]>();
  const cardRefs = new Map<string, string>();
  let episodeError: string | undefined;

  const resolveTarget = (target: string): string | undefined => {
    if (target.startsWith(CARD_REF_PREFIX))
      return cardRefs.get(target.slice(CARD_REF_PREFIX.length));
    const out = byStepId.get(target);
    return (out?.find((m) => m.card !== undefined) ?? out?.[0])?.id;
  };

  const moveClock = (to: string): void => {
    if (parseIso(to) > clock.nowMs()) clock.set(to);
  };

  try {
    for (const step of steps) {
      if (step.at !== undefined) moveClock(step.at);
      const index = records.length;
      current = index;
      // Window of this record's audit events / expenses; drained turns open their own.
      let auditBefore = auditAll().length;
      let expBefore = expenseIds();
      const at = clock.now();
      const baseRecord = {
        ...(step.id !== undefined ? { stepId: step.id } : {}),
        kind:
          step.source !== undefined && step.do !== 'intake' ? ('replay_line' as const) : step.do,
        label: stepLabel(step),
        ...(step.source !== undefined ? { source: step.source } : {}),
        ...(step.expect !== undefined ? { expect: step.expect } : {}),
      };
      const finish = (
        extra: Partial<StepRecord> & Pick<StepRecord, 'lane'>,
        idx = index,
      ): StepRecord => {
        const newEvents = auditAll().slice(auditBefore);
        const newProposalIds = newEvents
          .filter((e) => e.type === 'proposal.created' && e.proposalId !== undefined)
          .map((e) => e.proposalId!);
        const expAfter = expenseIds();
        const turnPhotos =
          extra.turn?.outbound.some(
            (m) =>
              (m.images?.length ?? 0) > 0 ||
              ((m.card?.type === 'recap' || m.card?.type === 'wrapped') &&
                m.card.photos.length > 0),
          ) === true;
        const record: StepRecord = {
          index: idx,
          at,
          ...baseRecord,
          auditTypes: newEvents.map((e) => e.type),
          auditFrom: auditBefore,
          auditTo: auditBefore + newEvents.length,
          newProposalIds: newProposalIds,
          newProposals: newProposalIds
            .map((id) => stores.group.bookings.getProposal(id))
            .filter((p): p is BookingProposal => p !== undefined)
            .map((p) => structuredClone(p)),
          newExpenseIds: [...expAfter].filter((id) => !expBefore.has(id)),
          purchasesAfter: purchases(),
          proactive: false,
          minors: stores.group.members
            .listByGroup(groupId)
            .filter((m) => m.active && safety.isMinor(m, clock.now()))
            .map((m) => m.memberId),
          ...(turnPhotos ? { consentAtSend: consentNow() } : {}),
          ...extra,
        };
        auditBefore += newEvents.length;
        expBefore = expAfter;
        return record;
      };
      /** Runs due jobs one at a time so each scheduled turn is its own record. */
      const drainEach = async (): Promise<number> => {
        let n = 0;
        for (const job of runtime.scheduler.drain(clock.now())) {
          current = records.length;
          const r = await runtime.agent.runScheduled(job);
          records.push(
            finish(
              {
                lane: 'group',
                proactive: true,
                turn: summarizeTurn(r),
                label: `scheduled ${job.kind}: ${r.note}`,
              },
              records.length,
            ),
          );
          n += 1;
        }
        return n;
      };

      try {
        switch (step.do) {
          case 'say': {
            const replyTo = step.replyTo === undefined ? undefined : resolveTarget(step.replyTo);
            const event = await channel.injectMessage({
              from: step.from,
              text: step.text,
              lane: step.lane ?? 'group',
              ...(replyTo !== undefined ? { replyToMessageId: replyTo } : {}),
              ...(step.attachments !== undefined ? { attachments: step.attachments } : {}),
            });
            const turn = summarizeTurn(await runtime.agent.handleInbound(event));
            records.push(finish({ lane: step.lane ?? 'group', from: step.from, turn }));
            break;
          }
          case 'react':
          case 'tap': {
            const target = resolveTarget(step.target);
            if (target === undefined) {
              records.push(
                finish({
                  lane: 'group',
                  from: step.from,
                  skipped: `target ${step.target} was never sent`,
                }),
              );
              break;
            }
            const event =
              step.do === 'react'
                ? await channel.injectReaction({
                    from: step.from,
                    targetMessageId: target,
                    reaction: step.reaction,
                  })
                : await channel.injectButtonTap({
                    from: step.from,
                    cardMessageId: target,
                    actionId: step.actionId,
                  });
            const turn = summarizeTurn(await runtime.agent.handleInbound(event));
            records.push(finish({ lane: 'group', from: step.from, turn }));
            break;
          }
          case 'advance': {
            if (step.to !== undefined) moveClock(step.to);
            else clock.advanceMs((step.minutes ?? 0) * 60_000);
            records.push(finish({ lane: 'system' }));
            if (step.drain !== false) await drainEach();
            break;
          }
          case 'drain': {
            if ((await drainEach()) === 0) {
              records.push(finish({ lane: 'system', skipped: 'no jobs due' }));
            }
            break;
          }
          case 'intake': {
            const result = await runtime.agent.intakeDocument({
              groupId,
              ownerMemberId: step.owner,
              source: step.source,
              itemId: step.itemId,
              text: step.text,
              ...(step.extracted !== undefined
                ? { extracted: { ...step.extracted, category: 'other' as const } }
                : {}),
            });
            records.push(finish({ lane: 'dm', from: step.owner, turn: summarizeTurn(result) }));
            break;
          }
          case 'remember': {
            runtime.memberMemory.remember(step.memberId, groupId, {
              category: step.category,
              text: step.text,
              aboutMemberIds: [step.memberId],
              sourceMessageId: `msg_eval_${String(index)}`,
              sourceTripId: tripId,
              now: clock.now(),
              sourceLane: step.lane,
            });
            records.push(finish({ lane: 'system' }));
            break;
          }
          case 'set_attendance': {
            stores.group.trips.setAttendance({
              activityId: step.activityId,
              memberId: step.memberId,
              status: step.status,
              updatedAt: clock.now(),
              sourceMessageId: `msg_eval_${String(index)}`,
              setBy: step.memberId,
            });
            records.push(finish({ lane: 'system' }));
            break;
          }
          case 'patch_member': {
            const m = stores.group.members.get(step.memberId);
            if (m === undefined) throw new Error(`patch_member: unknown member ${step.memberId}`);
            stores.group.members.upsert({ ...m, ...step.patch } as Member);
            records.push(finish({ lane: 'system' }));
            break;
          }
          case 'probe': {
            const result = await runProbe(step.probe, step.args, { model });
            probes.push({ probe: step.probe, stepIndex: index, result });
            records.push(finish({ lane: 'system' }));
            break;
          }
          case 'replay':
          case 'injection':
            throw new Error(`${step.do} steps must be expanded before running`);
        }
      } catch (e) {
        records.push(finish({ lane: 'system', error: e instanceof Error ? e.message : String(e) }));
      }

      const last = records[records.length - 1];
      if (step.id !== undefined && last?.turn !== undefined)
        byStepId.set(step.id, last.turn.outbound);
      if (step.cardRef !== undefined) {
        const card = last?.turn?.outbound.find((m) => m.card !== undefined);
        if (card !== undefined) cardRefs.set(step.cardRef, card.id);
      }
    }
  } catch (e) {
    episodeError = e instanceof Error ? e.message : String(e);
  }
  current = -1;

  const audit = auditAll();
  const proposalIds = [
    ...new Set(audit.filter((e) => e.type === 'proposal.created').map((e) => e.proposalId)),
  ].filter((id): id is string => id !== undefined);
  const proposals = proposalIds
    .map((id) => stores.group.bookings.getProposal(id))
    .filter((p): p is BookingProposal => p !== undefined);
  const bookings: readonly Booking[] = stores.group.bookings.listByTrip(tripId);
  const members = stores.group.members.listByGroup(groupId);
  const ticketsByHolder: Record<string, number> = {};
  for (const b of bookings) {
    for (const m of members) {
      const n = stores.private.listTickets(m.memberId, b.bookingId).length;
      if (n > 0) ticketsByHolder[m.memberId] = (ticketsByHolder[m.memberId] ?? 0) + n;
    }
  }

  const privateStrings = [
    ...(scenario.setup?.privateStrings ?? []),
    ...(scenario.setup?.fixtureExtras === true
      ? (fixture.labels.privateFactsNeverInGroup ?? [])
      : []),
  ];

  const episode: Episode = {
    scenarioId: scenario.id,
    mode: opts.mode,
    steps: records,
    transcript: channel.transcript(),
    audit,
    snapshot: {
      group: stores.group.groups.get(groupId),
      members,
      trip: stores.group.trips.get(tripId),
      proposals,
      bookings,
      expenses: stores.group.expenses.listByTrip(tripId),
      entries: stores.group.expenses.listEntries(tripId),
      groupMemory: stores.group.groupMemory.listByGroup(groupId),
      consent: consentNow(),
      ticketsByHolder,
    },
    prompts,
    lint,
    probes,
    purchases: purchases(),
    charges: payments.chargeCount(),
    skippedLines: skipped,
    privateStrings,
    expect: scenario.expect ?? {},
    ...(episodeError !== undefined ? { error: episodeError } : {}),
  };
  runtime.close();
  return episode;
}
