/**
 * The one seam between the simulator server/UI and whatever answers as Trav.
 *
 * The HTTP layer (`routes.ts`) and the UI only talk to `SimulatorBackend`.
 * Two implementations:
 *   - `createAgentBackend(parts)`: the real `TravAgent` over the simulator
 *     channel (parts come from `runtime.ts`, which wraps `createTravRuntime`).
 *   - `createScriptedBackend()` (`scripted.ts`): a deterministic Barcelona
 *     replay of VOICE §9.5 demo states 1–3 for the UI (kept until T-021
 *     retires it; the agent backend runs the real flow since T-009).
 *
 * Both record through the same in-memory simulator channel, so transcripts,
 * lanes and the DM-only card refusal are identical; only the responder that
 * reacts to inbound events differs. Both get the same simulator services
 * (`SimServices`) from a real runtime: the simulated clock, the scheduler
 * drain and the document intake, so the top-bar clock and the DM rail's
 * demo documents run the product's code in either mode.
 */
import type { InboundEvent, SimulatorChannel, TranscriptEntry, Unsubscribe } from '@trav/adapters';
import type { Clock, IsoDateTime, RichCard, ScheduledJob, SimulatedClock } from '@trav/core';
import { TravError, parseIso } from '@trav/core';
import type { DocumentIntake, DocumentIntakeResult, TravAgent, TurnResult } from '@trav/agent';
import type {
  BackendKind,
  ClockRequest,
  IntakeOffer,
  SimControls,
  SimGroup,
  SimInbound,
  SimMember,
  SimState,
  ThreadEntry,
} from '../shared/types.js';
import { clockStatus, clockTarget } from './clock.js';
import type { DemoDocument } from './documents.js';
import { DEMO_DOCUMENTS, buildIntake } from './documents.js';
import { buildDmThread, buildState } from './state.js';

/** How a backend starts over (`POST /api/reset`, or the replay's first step). */
export interface ResetOptions {
  /** Seed demo state 1 (the scripted backend's chat lines). Default true. */
  readonly seed?: boolean;
  /** Simulated time to start at. Default: the backend's demo start. */
  readonly startAt?: IsoDateTime;
}

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
  /** Current simulated time. */
  now(): IsoDateTime;
  /** Called after every change (inbound recorded, typing on/off, Trav's reply). */
  subscribe(listener: () => void): Unsubscribe;
  /** Start over. Optional. */
  reset?(options?: ResetOptions): Promise<void>;
  /**
   * Move the simulated clock forward, then run every due scheduled job through
   * Trav (`scheduler.drain(now)` → `agent.runScheduled`); whatever that sends
   * goes through the channel like any other turn. Throws `TravError`
   * `not_implemented` when the backend has no clock services.
   */
  advanceClock?(request: ClockRequest): Promise<void>;
  /**
   * Feed one demo document (`documents.ts`) through `agent.intakeDocument`:
   * a pending private item for its owner and the "looks shared?" DM.
   * `not_found` for an unknown id, `duplicate` if it was already fed.
   */
  intake?(docId: string): Promise<void>;
}

/** What a responder may report back about a turn, besides what it sent. */
export interface RespondOutcome {
  /**
   * A muted operator line for the UI (not a Trav message): why a tap or
   * tapback produced no visible change. Replaced on the next turn in that group.
   */
  readonly status?: string;
}

/** Reacts to one inbound event as Trav (the agent, or the demo script). */
export type Responder = (event: InboundEvent) => Promise<RespondOutcome | undefined | void>;

/**
 * What a real runtime lends the simulator besides `handleInbound`
 * (`createTravRuntime`'s `clock`, `scheduler`, `drain` and
 * `agent.intakeDocument`). Every field but the clock is optional, and the UI
 * hides the controls a backend can't serve.
 */
export interface SimServices {
  readonly clock: SimulatedClock;
  /** For the status line: which jobs were due (read before draining). */
  readonly scheduler?: { list(): readonly ScheduledJob[] };
  /** `runtime.drain()`: every due job through `agent.runScheduled`. */
  readonly drain?: () => Promise<readonly TurnResult[]>;
  readonly intakeDocument?: (input: DocumentIntake) => Promise<DocumentIntakeResult>;
}

/** The parts of a `createTravRuntime` result the simulator services come from. */
export interface ServiceSource {
  readonly agent: Pick<TravAgent, 'intakeDocument'>;
  readonly scheduler?: { list(): readonly ScheduledJob[] };
  drain?(): Promise<readonly TurnResult[]>;
}

/** The simulator services a runtime lends (clock, scheduler drain, document intake). */
export function servicesOf(runtime: ServiceSource, clock: SimulatedClock): SimServices {
  const { agent } = runtime;
  return {
    clock,
    ...(runtime.scheduler !== undefined && typeof runtime.scheduler.list === 'function'
      ? { scheduler: runtime.scheduler }
      : {}),
    ...(typeof runtime.drain === 'function' ? { drain: () => runtime.drain!() } : {}),
    ...(typeof agent.intakeDocument === 'function'
      ? { intakeDocument: (input: DocumentIntake) => agent.intakeDocument(input) }
      : {}),
  };
}

export interface ChannelBackendOptions {
  readonly kind: BackendKind;
  readonly groups: readonly SimGroup[];
  readonly channel: SimulatorChannel;
  readonly clock: Clock;
  readonly offline: boolean;
  readonly respond: Responder;
  /** Runs before each inbound is injected (the scripted backend advances its clock). */
  readonly beforeInject?: () => void;
  readonly services?: SimServices;
  /** Default `DEMO_DOCUMENTS`. */
  readonly documents?: readonly DemoDocument[];
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
 *
 * Turns are serialized across the whole simulator: `respond`, a clock step's
 * drain and a document intake never run at once. A double-click on Approve,
 * two members asking at the same moment, or "next morning" pressed while
 * Trav is still answering reach Trav one after the other, never as two
 * concurrent turns that could each open a proposal or book.
 */
export function createChannelBackend(options: ChannelBackendOptions): ChannelBackend {
  const { channel, clock, groups, services } = options;
  if (groups.length === 0) throw new Error('simulator backend: at least one group is required');
  const documents = options.documents ?? DEMO_DOCUMENTS;
  const listeners = new Set<() => void>();
  const typing = new Set<string>();
  let version = 0;
  let lastError: string | undefined;
  /** Per group (GroupView.status): a line from one trip never shows under another. */
  const statusByGroup = new Map<string, string>();
  /** Demo documents already fed (or queued), so each one arrives once. */
  const fed = new Set<string>();
  // One turn at a time (see above). Never rejects (see `channel.onEvent` below).
  let queue: Promise<void> = Promise.resolve();

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

  function setStatus(group: SimGroup | undefined, status: string | undefined): void {
    if (!group) return;
    if (status === undefined) statusByGroup.delete(group.groupId);
    else statusByGroup.set(group.groupId, status);
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

  const turn = async (
    work: () => Promise<RespondOutcome | undefined | void>,
    group: SimGroup | undefined,
  ): Promise<void> => {
    try {
      const outcome = await work();
      lastError = undefined;
      setStatus(group, outcome ? outcome.status : undefined);
    } catch (e) {
      lastError = `trav's turn failed: ${e instanceof Error ? e.message : String(e)}`;
      setStatus(group, undefined);
    } finally {
      if (group) setTyping(group.groupId, -1);
      notify();
    }
  };

  /** Queue one unit of Trav work behind every earlier turn (typing on while it waits). */
  function enqueue(
    group: SimGroup | undefined,
    work: () => Promise<RespondOutcome | undefined | void>,
  ): Promise<void> {
    // Typing shows as soon as the work lands, even while it waits its turn.
    if (group) setTyping(group.groupId, 1);
    try {
      notify();
    } catch {
      // A throwing listener must not leave the typing counter stuck at 1.
      if (group) setTyping(group.groupId, -1);
      throw new Error('simulator state listener threw');
    }
    const run = queue.then(() => turn(work, group));
    // `turn` catches the work's errors; this also survives a throwing state
    // listener, so one bad turn can never wedge every later one.
    queue = run.catch(() => undefined);
    return run;
  }

  channel.onEvent((event) => enqueue(groupOf(event), () => options.respond(event)));

  function requireGroup(groupId: string | undefined): SimGroup {
    if (groupId === undefined) return groups[0]!;
    const g = groupById.get(groupId);
    if (!g) throw new Error(`unknown group ${groupId}`);
    return g;
  }

  function intakeOffers(): Map<string, Record<string, IntakeOffer[]>> {
    const out = new Map<string, Record<string, IntakeOffer[]>>();
    for (const g of groups) {
      const byMember: Record<string, IntakeOffer[]> = {};
      for (const m of g.members) byMember[m.memberId] = [];
      if (services?.intakeDocument) {
        for (const d of documents) {
          if (d.groupId !== g.groupId || fed.has(d.docId)) continue;
          byMember[d.ownerMemberId]?.push({ docId: d.docId, kind: d.kind });
        }
      }
      out.set(g.groupId, byMember);
    }
    return out;
  }

  function controls(): SimControls {
    return {
      clock: services !== undefined,
      scheduler: services?.drain !== undefined,
      intake: services?.intakeDocument !== undefined,
      reset: false,
      replay: false,
    };
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
        case 'member_joined':
          return channel.injectMemberJoined({
            conversationId: requireGroup(input.groupId).conversationId,
            participant: { handle: input.handle, displayName: input.displayName },
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
        status: statusByGroup,
        intake: intakeOffers(),
        controls: controls(),
        ...(lastError !== undefined ? { lastError } : {}),
      });
    },

    now: () => clock.now(),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ...(services !== undefined
      ? {
          async advanceClock(request: ClockRequest): Promise<void> {
            const group = requireGroup(request.groupId);
            await enqueue(group, async () => {
              const before = services.clock.now();
              const target = clockTarget(request, before, group);
              if (target !== undefined) services.clock.set(target);
              const now = services.clock.now();
              const due = (services.scheduler?.list() ?? []).filter(
                (j) => parseIso(j.runAt) <= parseIso(now),
              );
              const results = services.drain ? await services.drain() : [];
              const status = clockStatus({
                request,
                group,
                now,
                moved: target !== undefined,
                jobs: due,
                results,
                scheduler: services.drain !== undefined,
              });
              return status !== undefined ? { status } : undefined;
            });
          },
        }
      : {}),

    ...(services?.intakeDocument !== undefined
      ? {
          async intake(docId: string): Promise<void> {
            const intakeDocument = services.intakeDocument!;
            const doc = documents.find((d) => d.docId === docId);
            if (!doc) throw new TravError('not_found', `no demo document ${docId}`);
            if (fed.has(docId)) throw new TravError('duplicate', `${docId} was already fed`);
            const group = requireGroup(doc.groupId);
            fed.add(docId); // reserved now: a double-click queues nothing twice
            await enqueue(group, async () => {
              try {
                const result = await intakeDocument(await buildIntake(doc));
                if (!result.silent) return undefined;
                return {
                  status: `trav sent nothing for that ${doc.kind} document (${result.note})`,
                };
              } catch (e) {
                fed.delete(docId); // nothing was ingested: it can be fed again
                throw e;
              }
            });
          },
        }
      : {}),

    setError(message) {
      lastError = message;
      notify();
    },

    notify,
  };
  return backend;
}

/**
 * A backend that can start over: each session is a fresh channel (and, for
 * the agent, a fresh runtime). Subscribers stay attached across resets and
 * the state version keeps increasing, so the UI never ignores the new state.
 */
export function createSessionBackend(
  kind: BackendKind,
  makeSession: (options: ResetOptions) => Promise<ChannelBackend>,
  first: ChannelBackend,
  onReset?: () => void,
): SimulatorBackend {
  let session = first;
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = (): void => {
    version += 1;
    for (const l of [...listeners]) l();
  };
  let unsubscribeInner: Unsubscribe = session.subscribe(emit);

  const forward = {
    kind,
    get groups() {
      return session.groups;
    },
    get members() {
      return session.members;
    },
    inject: (input: SimInbound) => session.inject(input),
    transcript: (groupId?: string) => session.transcript(groupId),
    dms: (memberId: string) => session.dms(memberId),
    now: () => session.now(),
    state(): SimState {
      const s = session.state();
      return { ...s, version, controls: { ...s.controls, reset: true } };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async reset(options: ResetOptions = {}) {
      const next = await makeSession(options);
      unsubscribeInner();
      onReset?.();
      session = next;
      unsubscribeInner = session.subscribe(emit);
      emit();
    },
    advanceClock(request: ClockRequest): Promise<void> {
      if (!session.advanceClock) {
        return Promise.reject(new TravError('not_implemented', 'this backend has no clock'));
      }
      return session.advanceClock(request);
    },
    intake(docId: string): Promise<void> {
      if (!session.intake) {
        return Promise.reject(new TravError('not_implemented', 'this backend has no intake'));
      }
      return session.intake(docId);
    },
  };
  return forward;
}

/** What `runtime.ts` hands over from `createTravRuntime`. */
export interface AgentBackendParts {
  readonly agent: TravAgent;
  readonly channel: SimulatorChannel;
  readonly clock: Clock;
  readonly groups: readonly SimGroup[];
  /** The runtime's model client is in offline mode (no live model call can happen). */
  readonly offline: boolean;
  /** Clock, scheduler drain and intake from the runtime (top-bar clock, DM-rail documents). */
  readonly services?: SimServices;
}

/** A "looks shared?" card's Share it / Keep private / 👍 / 👎 got no answer. */
export const SHARE_FLOW_NOT_WIRED_STATUS =
  'share/keep flow not wired yet (T-012/T-013): the charge stays private and nothing went on the tab';

function isLooksSharedCard(card: RichCard | undefined): boolean {
  return card?.type === 'expense_confirm' && card.status === 'pending';
}

/**
 * The muted status line for one agent turn, if any: a button tap (or an
 * approval tapback) that Trav answered with silence. Without it a dead
 * Approve button looks exactly like a slow one. Ordinary silence (a tapback
 * on a friend's message, a message that didn't mention Trav) shows nothing.
 * `targetCard` is the card the tap or tapback was on, when known.
 */
export function silentTurnStatus(
  event: InboundEvent,
  result: Pick<TurnResult, 'silent' | 'note'> | undefined,
  targetCard?: RichCard,
): string | undefined {
  if (!result || !result.silent) return undefined;
  if (event.type !== 'button_tap' && event.type !== 'reaction') return undefined;
  if (isLooksSharedCard(targetCard) && !(event.type === 'reaction' && event.removed)) {
    return SHARE_FLOW_NOT_WIRED_STATUS;
  }
  if (event.type === 'reaction') {
    if (!result.note.startsWith('approval:') || result.note === 'approval:no_pending') {
      return undefined;
    }
    return `trav stayed quiet on that tapback (${result.note})`;
  }
  return `trav stayed quiet on that tap (${result.note === '' ? 'no reason given' : result.note})`;
}

/** The card a tap or tapback points at, if Trav sent it on this channel. */
export function targetCardOf(
  channel: Pick<SimulatorChannel, 'sentMessage'>,
  event: InboundEvent,
): RichCard | undefined {
  const id =
    event.type === 'button_tap'
      ? event.cardMessageId
      : event.type === 'reaction'
        ? event.targetMessageId
        : undefined;
  return id === undefined ? undefined : channel.sentMessage(id)?.card;
}

/**
 * The real Trav: every inbound event goes to `agent.handleInbound`, which owns
 * identity, mention gating, approvals (button taps and 👍 tapbacks normalize to
 * the same `ApprovalEvent`) and sending through the channel. This backend adds
 * the typing indicator, the state payload and the status line for a silent
 * tap; `createChannelBackend` serializes the turns.
 */
export function createAgentBackend(parts: AgentBackendParts): ChannelBackend {
  return createChannelBackend({
    kind: 'agent',
    groups: parts.groups,
    channel: parts.channel,
    clock: parts.clock,
    offline: parts.offline,
    ...(parts.services !== undefined ? { services: parts.services } : {}),
    respond: async (event) => {
      const result: TurnResult | undefined = await parts.agent.handleInbound(event);
      const status = silentTurnStatus(event, result, targetCardOf(parts.channel, event));
      return status !== undefined ? { status } : undefined;
    },
  });
}
