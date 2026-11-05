/**
 * Probes: deterministic checks of one component, recorded into the episode so
 * graders stay pure. Each probe returns the component's ACTUAL output next to
 * the fixture's ground truth; the grader decides.
 *
 * - `mentions`      `detectMention` over `fixtures/mentions/labeled.json`
 * - `flights`       `optimizeGroupFlights` vs `bruteForceOptimize` on the
 *                   mock Barcelona inventory, plus the fixture's ground truth
 * - `ledger`        core splits/balances/settlement over `fixtures/ledger/*.json`
 * - `album_consent` the mock album's `listPhotos` along the fixture's consent timeline
 * - `roast_screen`  roast lines through the agent's real send path (gate 1 + gate 2)
 * - `minor_screen`  Turks and Caicos drafts through the real send path
 * - `auto_buy`      `autoBuyVerdict` over `fixtures/safety/auto-buy-asks.json` (T-182)
 */
import type {
  Clock,
  ConsentFlags,
  ConsentLookup,
  ContentTag,
  Expense,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  Share,
  SimulatedClock,
} from '@trav/core';
import {
  createDeterministicIdGenerator,
  createSimulatedClock,
  defaultConsent,
  flights,
  formatIso,
  ledger,
  parseIso,
} from '@trav/core';
import { createMemoryStores } from '@trav/core/storage';
import type { FlightOfferTemplate } from '@trav/adapters';
import {
  createMockAlbum,
  createSimulatorChannel,
  loadAllTicketInventories,
  loadMockFlightInventory,
  sliceToLeg,
} from '@trav/adapters';
import type { ModelClient } from '@trav/agent';
import { autoBuyVerdict, detectMention, sendOutbound, venueIndexFrom } from '@trav/agent';
import type { TripName } from '../fixtures.js';
import { loadFixture } from '../fixtures.js';
import type { ProbeName } from '../types.js';
import { PROBE_NAMES } from '../types.js';
import { loadGroupFixture, seedGroup } from './seed.js';

export interface ProbeDeps {
  /** Model for the mention classifier (offline client in CI). */
  readonly model: ModelClient;
}

// ---------- mentions ----------

interface LabeledLine {
  readonly id: string;
  readonly lane: 'group' | 'direct';
  readonly text: string;
  readonly expected: { readonly addressed: boolean; readonly kind: string };
  readonly via: 'rules' | 'classifier';
  readonly context?: {
    readonly replyToTravMessage?: boolean;
    readonly secondsSinceTravQuestion?: number | null;
  };
}

export interface MentionProbeRow {
  readonly id: string;
  /** `dm` rows are never quoted in evidence. */
  readonly lane: 'group' | 'dm';
  readonly text: string;
  readonly expected: boolean;
  readonly got: boolean;
  readonly reason: string;
  readonly via: string;
}

const MENTION_NOW = '2026-03-14T21:40:00+01:00';

export async function probeMentions(deps: ProbeDeps): Promise<{ rows: MentionProbeRow[] }> {
  const { lines } = loadFixture<{ lines: LabeledLine[] }>('mentions/labeled.json');
  const rows: MentionProbeRow[] = [];
  for (const line of lines) {
    const seconds = line.context?.secondsSinceTravQuestion;
    const res = await detectMention(
      line.text,
      {
        lane: line.lane === 'direct' ? 'dm' : 'group',
        repliesToTrav: line.context?.replyToTravMessage === true,
        platformMention: false,
        ...(typeof seconds === 'number'
          ? { lastTravQuestionAt: formatIso(parseIso(MENTION_NOW) - seconds * 1000, 60) }
          : {}),
        now: MENTION_NOW,
      },
      deps.model,
    );
    rows.push({
      id: line.id,
      lane: line.lane === 'direct' ? 'dm' : 'group',
      text: line.text,
      expected: line.expected.addressed,
      got: res.addressed,
      reason: res.reason,
      via: line.via,
    });
  }
  return { rows };
}

// ---------- flights ----------

export interface ItinerarySummary {
  readonly offerIds: readonly string[];
  readonly score: number;
  readonly arrivalSpreadMinutes: number;
  readonly totalCostMinor: number;
  readonly allRefundable: boolean;
}

export interface FlightsProbe {
  readonly members: readonly string[];
  readonly missing: readonly string[];
  readonly fast: readonly ItinerarySummary[];
  readonly oracle: readonly ItinerarySummary[];
  readonly naive: ItinerarySummary;
  readonly refundableFast: readonly ItinerarySummary[];
  readonly refundableOracle: readonly ItinerarySummary[];
  readonly groundTruth: {
    readonly naiveArrivalSpreadMinutes: number;
    readonly groupTotalLowerBoundMinor: number;
  };
}

function templateChoice(t: FlightOfferTemplate, memberId: MemberId): flights.FlightChoice {
  const [out, back] = t.slices;
  if (out === undefined) throw new Error(`template ${t.templateId} has no slices`);
  const choice: flights.FlightChoice = {
    memberId,
    offerId: t.templateId,
    provider: 'mock-flights',
    outbound: sliceToLeg(out),
    price: t.perPassengerTotal,
    refundable: t.refundBeforeDeparture.allowed,
  };
  return back === undefined ? choice : { ...choice, inbound: sliceToLeg(back) };
}

/** Optimizer input from the mock inventory: each traveler's offers from their origin, home to their return city. */
export function barcelonaOptimizerInput(
  constraints: flights.OptimizerConstraints = {},
): flights.OptimizerInput {
  const inv = loadMockFlightInventory('barcelona');
  const members: flights.MemberTravel[] = inv.travelers.map((t) => ({
    memberId: t.memberId,
    origin: t.origin,
    returnTo: t.returnTo,
    ...(t.name !== undefined ? { name: t.name } : {}),
  }));
  const choices: flights.FlightChoice[] = [];
  for (const m of members) {
    for (const t of inv.templates) {
      const out = t.slices[0];
      const back = t.slices[1];
      if (out?.origin === m.origin && back?.destination === m.returnTo) {
        choices.push(templateChoice(t, m.memberId));
      }
    }
  }
  return {
    destination: 'BCN',
    members,
    choices,
    weights: flights.DEFAULT_WEIGHTS,
    constraints,
    maxResults: 3,
  };
}

function summarize(it: flights.GroupItinerary): ItinerarySummary {
  return {
    offerIds: it.picks.map((p) => p.offerId),
    score: it.breakdown.score,
    arrivalSpreadMinutes: it.breakdown.arrivalSpreadMinutes,
    totalCostMinor: it.breakdown.totalCost.amountMinor,
    allRefundable: it.allRefundable,
  };
}

export function probeFlights(): FlightsProbe {
  const input = barcelonaOptimizerInput();
  const fast = flights.optimizeGroupFlights(input);
  const oracle = flights.bruteForceOptimize(input);
  const naivePicks = flights.cheapestPerPerson(input);
  const naiveScore = flights.scoreItinerary(naivePicks, input);
  const refundable = barcelonaOptimizerInput({ refundableOnly: true });
  const gt = loadFixture<{
    groundTruth: {
      naiveCheapestPerPerson: { arrivalSpreadMinutes: number };
      groupTotalLowerBound: Money;
    };
  }>('flights/barcelona-groundtruth.json').groundTruth;
  return {
    members: input.members.map((m) => m.memberId),
    missing: fast.missing,
    fast: fast.itineraries.map(summarize),
    oracle: oracle.itineraries.map(summarize),
    naive: {
      offerIds: naivePicks.map((p) => p.offerId),
      score: naiveScore.score,
      arrivalSpreadMinutes: naiveScore.arrivalSpreadMinutes,
      totalCostMinor: naiveScore.totalCost.amountMinor,
      allRefundable: naivePicks.every((p) => p.refundable),
    },
    refundableFast: flights.optimizeGroupFlights(refundable).itineraries.map(summarize),
    refundableOracle: flights.bruteForceOptimize(refundable).itineraries.map(summarize),
    groundTruth: {
      naiveArrivalSpreadMinutes: gt.naiveCheapestPerPerson.arrivalSpreadMinutes,
      groupTotalLowerBoundMinor: gt.groupTotalLowerBound.amountMinor,
    },
  };
}

// ---------- ledger ----------

interface LedgerFixture {
  readonly currency: string;
  readonly expenses: readonly (Expense & {
    readonly expectedShares: readonly Share[];
    readonly fromChatLine?: string;
  })[];
  readonly final: {
    readonly totalSpent: Money;
    readonly balances: readonly { readonly memberId: string; readonly net: Money }[];
    readonly maxTransfers: number;
  };
}

export interface LedgerProbeTrip {
  readonly trip: TripName;
  readonly memberOrder: readonly string[];
  /** Per expense: fixture ground truth vs core's shares (non-zero only). */
  readonly expenses: readonly {
    readonly expenseId: string;
    readonly expected: readonly { readonly memberId: string; readonly amountMinor: number }[];
    readonly got: readonly { readonly memberId: string; readonly amountMinor: number }[];
    readonly error?: string;
  }[];
  readonly expectedBalances: Readonly<Record<string, number>>;
  readonly gotBalances: Readonly<Record<string, number>>;
  readonly transfers: readonly {
    readonly from: string;
    readonly to: string;
    readonly amountMinor: number;
  }[];
  readonly maxTransfers: number;
  readonly expectedTotalMinor: number;
  readonly gotTotalMinor: number;
}

function shareRows(shares: readonly Share[]): { memberId: string; amountMinor: number }[] {
  return shares
    .filter((s) => s.amount.amountMinor !== 0)
    .map((s) => ({ memberId: s.memberId, amountMinor: s.amount.amountMinor }));
}

export function probeLedger(trips: readonly TripName[]): { trips: LedgerProbeTrip[] } {
  const out: LedgerProbeTrip[] = [];
  for (const trip of trips) {
    const fx = loadFixture<LedgerFixture>(`ledger/${trip}.json`);
    const memberOrder = loadGroupFixture(trip).members.map((m) => m.memberId);
    const ctx = ledger.contextFor(memberOrder);
    const expenses = fx.expenses.map((e) => {
      const expected = shareRows(e.expectedShares);
      try {
        return { expenseId: e.expenseId, expected, got: shareRows(ledger.computeShares(e, ctx)) };
      } catch (err) {
        return {
          expenseId: e.expenseId,
          expected,
          got: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    const balances = ledger.computeBalances(
      ledger.buildLedger(fx.expenses, ctx),
      fx.currency,
      memberOrder,
    );
    const transfers = ledger.settle(balances);
    out.push({
      trip,
      memberOrder,
      expenses,
      expectedBalances: Object.fromEntries(
        fx.final.balances.map((b) => [b.memberId, b.net.amountMinor]),
      ),
      gotBalances: Object.fromEntries(balances.map((b) => [b.memberId, b.net.amountMinor])),
      transfers: transfers.map((t) => ({
        from: t.from,
        to: t.to,
        amountMinor: t.amount.amountMinor,
      })),
      maxTransfers: fx.final.maxTransfers,
      expectedTotalMinor: fx.final.totalSpent.amountMinor,
      gotTotalMinor: ledger.totalSpent(fx.expenses, fx.currency).amountMinor,
    });
  }
  return { trips: out };
}

// ---------- album consent ----------

export interface AlbumCheckpoint {
  readonly at: string;
  readonly consent: Readonly<Record<string, boolean>>;
  /** Photos `listPhotos` returned, with their owners. */
  readonly returned: readonly { readonly photoId: string; readonly owner: string }[];
  /** Non-hidden photos of owners consenting at `at` (what should come back). */
  readonly eligible: readonly string[];
}

interface AlbumFile {
  readonly groupId: string;
  readonly tripId: string;
  readonly photos: readonly { photoId: string; ownerMemberId: string; hidden: boolean }[];
  readonly consentTimeline: readonly { at: string; memberId: string; photos: boolean }[];
}

function consentLookup(groupId: string, state: Readonly<Record<string, boolean>>, at: string) {
  return (memberId: MemberId): ConsentFlags | undefined =>
    state[memberId] === undefined
      ? undefined
      : { ...defaultConsent(memberId, groupId, at), photos: state[memberId] === true };
}

export async function probeAlbumConsent(
  trip: TripName,
): Promise<{ checkpoints: AlbumCheckpoint[] }> {
  const file = loadFixture<AlbumFile>(`album/${trip}.json`);
  const clock = createSimulatedClock('2026-01-01T00:00:00Z');
  // Every `fixtures/album/*.json` file; `listPhotos` scopes to the group.
  const album = createMockAlbum({ clock });
  const timeline = [...file.consentTimeline].sort((a, b) => parseIso(a.at) - parseIso(b.at));
  const first = timeline[0];
  const stops = [
    ...(first !== undefined ? [formatIso(parseIso(first.at) - 60_000, 60)] : []),
    ...timeline.map((t) => t.at),
  ];
  const checkpoints: AlbumCheckpoint[] = [];
  for (const at of stops) {
    const state: Record<string, boolean> = {};
    for (const t of timeline) if (parseIso(t.at) <= parseIso(at)) state[t.memberId] = t.photos;
    const res = await album.listPhotos(
      { groupId: file.groupId, tripId: file.tripId },
      consentLookup(file.groupId, state, at),
    );
    const returned = res.ok
      ? res.value.map((p) => ({ photoId: p.photoId, owner: p.ownerMemberId }))
      : [];
    checkpoints.push({
      at,
      consent: { ...state },
      returned,
      eligible: file.photos
        .filter((p) => !p.hidden && state[p.ownerMemberId] === true)
        .map((p) => p.photoId),
    });
  }
  return { checkpoints };
}

// ---------- send-path probes (roast, minors) ----------

export interface ScreenCase {
  readonly id: string;
  /** What the fixture says must happen. */
  readonly expected: 'sent' | 'suppressed';
  readonly expectedCause?: string;
  readonly category?: string;
  /** The draft answers an explicit adult-only request (SAFETY F3). */
  readonly explicitAdultRequest?: boolean;
  /** What the send path did. */
  readonly sent: boolean;
  readonly sentText?: string;
  readonly causes: readonly string[];
  /** Audit event types the send path wrote for this draft. */
  readonly audit: readonly string[];
  /** The draft text (for evidence). */
  readonly text: string;
  readonly toGroup: boolean;
}

interface MiniSendEnv {
  readonly clock: SimulatedClock;
  send(
    draft: OutboundMessage,
    options: Parameters<typeof sendOutbound>[2],
  ): Promise<{ sent: boolean; sentText?: string; causes: string[]; audit: string[] }>;
}

function miniSendEnv(
  trip: TripName,
  at: string,
  opts: {
    settings?: Readonly<Record<string, unknown>>;
    consent?: (m: Member) => Partial<ConsentFlags>;
    patchMembers?: (m: Member) => Member;
    /** Guests in the thread (e.g. "Alex", a friend who is not on the roster). */
    guests?: readonly string[];
  },
): MiniSendEnv {
  const clock = createSimulatedClock(at);
  const ids = createDeterministicIdGenerator(`probe_${trip}`);
  const stores = createMemoryStores({ clock, ids });
  const f = seedGroup(stores, trip, opts.settings !== undefined ? { settings: opts.settings } : {});
  for (const name of opts.guests ?? []) {
    const handle = `h_guest_${name.toLowerCase()}`;
    stores.group.members.upsert({
      memberId: `mem_guest_${name.toLowerCase()}`,
      groupId: f.group.groupId,
      displayName: name,
      role: 'guest',
      active: true,
      senderId: handle,
      ageBand: 'adult',
      joinedAt: at,
    });
  }
  for (const m of f.members) {
    const patched = opts.patchMembers?.(m) ?? m;
    if (patched !== m) stores.group.members.upsert(patched);
    const c = opts.consent?.(m);
    if (c !== undefined) {
      stores.private.putConsent(m.memberId, {
        ...defaultConsent(m.memberId, f.group.groupId, at),
        ...c,
      });
    }
  }
  const channel = createSimulatorChannel({
    clock,
    conversations: [
      {
        conversationId: f.group.conversationId,
        participants: f.members.map((m) => ({
          handle: m.senderId,
          displayName: m.displayName,
          memberId: m.memberId,
        })),
      },
    ],
  });
  const consent: ConsentLookup = (memberId) => stores.private.getConsent(memberId, f.group.groupId);
  return {
    clock,
    async send(draft, options) {
      const members = stores.group.members.listByGroup(f.group.groupId);
      const group = stores.group.groups.get(f.group.groupId)!;
      const before = stores.group.audit.listByGroup(group.groupId).length;
      const outcome = await sendOutbound(
        draft,
        {
          channel,
          group,
          members,
          trip: stores.group.trips.get(f.trip.tripId) ?? null,
          consent,
          audit: stores.group.audit,
          clock: clock as Clock,
          handleFor: (memberId) => stores.group.members.get(memberId)?.senderId,
          voice: 'log',
          ids,
        },
        options,
      );
      const audit = stores.group.audit
        .listByGroup(group.groupId)
        .slice(before)
        .map((e) => e.type);
      const sentMsg =
        outcome.sent !== null && !outcome.suppressed && 'text' in outcome.outbound
          ? outcome.outbound.text
          : undefined;
      return {
        sent: sentMsg !== undefined,
        ...(sentMsg !== undefined ? { sentText: sentMsg } : {}),
        causes: outcome.suppressions.map((s) => String(s.cause)),
        audit,
      };
    },
  };
}

interface RoastCases {
  readonly blocked: readonly { id: string; category: string; line: string }[];
  readonly allowed: readonly { id: string; line: string }[];
  readonly gated: readonly { id: string; cause: string; target: string; line: string }[];
}

const ROAST_AT = '2026-03-15T10:00:00+01:00';

/**
 * Each fixture roast line as a marked roast aside (`roast: true`, listed in
 * `roastLines`) in a Barcelona group with roast mode on and every member opted
 * in, through the agent's send path. Gated lines get the one setup change
 * their cause names (opted out, left the chat, not a member).
 */
export async function probeRoastScreen(): Promise<{ cases: ScreenCase[] }> {
  const fx = loadFixture<RoastCases>('safety/roast-blocklist-cases.json');
  const cases: ScreenCase[] = [];
  const all: {
    id: string;
    line: string;
    expected: 'sent' | 'suppressed';
    category?: string;
    cause?: string;
    target?: string;
  }[] = [
    ...fx.blocked.map((b) => ({
      id: b.id,
      line: b.line,
      expected: 'suppressed' as const,
      category: b.category,
    })),
    ...fx.allowed.map((a) => ({ id: a.id, line: a.line, expected: 'sent' as const })),
    ...fx.gated.map((g) => ({
      id: g.id,
      line: g.line,
      expected: 'suppressed' as const,
      cause: g.cause,
      target: g.target,
    })),
  ];
  for (const c of all) {
    const env = miniSendEnv('barcelona', ROAST_AT, {
      settings: { roastMode: true, allAdultsConfirmed: true },
      consent: (m) => ({
        roast: !(c.cause === 'roast_member_opted_out' && m.displayName === c.target),
      }),
      patchMembers: (m) =>
        c.cause === 'roast_target_inactive' && m.displayName === c.target
          ? { ...m, active: false }
          : m,
      ...(c.cause === 'roast_target_not_member' && c.target !== undefined
        ? { guests: [c.target] }
        : {}),
    });
    const draft: OutboundMessage = {
      id: `msg_probe_${c.id}`,
      groupId: 'grp_barcelona',
      to: { kind: 'group' },
      text: c.line,
      roast: true,
    };
    const r = await env.send(draft, { roastLines: [c.line] });
    const roastSurvived = r.sent && r.sentText !== undefined && r.sentText.includes(c.line);
    cases.push({
      id: c.id,
      expected: c.expected,
      ...(c.cause !== undefined ? { expectedCause: c.cause } : {}),
      ...(c.category !== undefined ? { category: c.category } : {}),
      sent: roastSurvived,
      ...(r.sentText !== undefined ? { sentText: r.sentText } : {}),
      causes: r.causes,
      audit: r.audit,
      text: c.line,
      toGroup: true,
    });
  }
  return { cases };
}

interface TcCandidates {
  readonly members: readonly { memberId: string; displayName: string }[];
  readonly candidates: readonly {
    id: string;
    expect: 'sent' | 'suppressed';
    cause?: string;
    text: string;
    contentTags?: readonly string[];
    to?: string;
    explicitAdultRequest?: boolean;
    audience?: readonly string[];
  }[];
}

const MINOR_AT = '2026-06-23T16:00:00-04:00';

/** `fixtures/safety/turks-caicos-candidates.json` drafts through the send path of the seeded Turks and Caicos group. */
export async function probeMinorScreen(): Promise<{ cases: ScreenCase[] }> {
  const fx = loadFixture<TcCandidates>('safety/turks-caicos-candidates.json');
  const seeded = loadGroupFixture('turks-and-caicos').members;
  const byName = new Map(seeded.map((m) => [m.displayName, m.memberId]));
  const mapId = (id: string): string => {
    const name = fx.members.find((m) => m.memberId === id)?.displayName;
    const mapped = name === undefined ? undefined : byName.get(name);
    if (mapped === undefined) throw new Error(`minor_screen: unknown fixture member ${id}`);
    return mapped;
  };
  const cases: ScreenCase[] = [];
  for (const c of fx.candidates) {
    const env = miniSendEnv('turks-and-caicos', MINOR_AT, {});
    const to = c.to === undefined ? null : mapId(c.to);
    const draft: OutboundMessage = {
      id: `msg_probe_${c.id}`,
      groupId: 'grp_turks_caicos',
      to: to === null ? { kind: 'group' } : { kind: 'member', memberId: to },
      text: c.text,
    };
    const r = await env.send(draft, {
      ...(c.contentTags !== undefined ? { contentTags: c.contentTags as ContentTag[] } : {}),
      ...(c.audience !== undefined ? { audience: c.audience.map(mapId) } : {}),
      ...(c.explicitAdultRequest !== undefined
        ? { explicitAdultRequest: c.explicitAdultRequest }
        : {}),
    });
    cases.push({
      id: c.id,
      expected: c.expect,
      ...(c.cause !== undefined ? { expectedCause: c.cause } : {}),
      ...(c.explicitAdultRequest !== undefined
        ? { explicitAdultRequest: c.explicitAdultRequest }
        : {}),
      sent: r.sent,
      ...(r.sentText !== undefined ? { sentText: r.sentText } : {}),
      causes: r.causes,
      audit: r.audit,
      text: c.text,
      toGroup: to === null,
    });
  }
  return { cases };
}

// ---------- auto_buy (T-182) ----------

interface AutoBuyFixture {
  readonly sender: string;
  readonly roster: readonly string[];
  readonly cases: readonly {
    readonly id: string;
    readonly text: string;
    readonly eligible: boolean;
    readonly quantity?: number;
    readonly excluded?: readonly string[];
  }[];
}

export interface AutoBuyCase {
  readonly id: string;
  readonly text: string;
  readonly expectedEligible: boolean;
  readonly expectedQuantity?: number;
  readonly expectedExcluded?: readonly string[];
  readonly eligible: boolean;
  readonly quantity?: number;
  readonly excluded?: readonly string[];
  readonly reason?: string;
}

/** `fixtures/safety/auto-buy-asks.json` through `autoBuyVerdict` on the bundled ticket inventories. */
export function probeAutoBuy(): { cases: AutoBuyCase[] } {
  const fx = loadFixture<AutoBuyFixture>('safety/auto-buy-asks.json');
  const index = venueIndexFrom(loadAllTicketInventories());
  const cases = fx.cases.map((c): AutoBuyCase => {
    const v = autoBuyVerdict({ text: c.text, index, sender: fx.sender, roster: fx.roster });
    return {
      id: c.id,
      text: c.text,
      expectedEligible: c.eligible,
      ...(c.quantity !== undefined ? { expectedQuantity: c.quantity } : {}),
      ...(c.excluded !== undefined ? { expectedExcluded: c.excluded } : {}),
      eligible: v.eligible,
      ...(v.eligible ? { quantity: v.quantity, excluded: v.excluded } : { reason: v.reason }),
    };
  });
  return { cases };
}

// ---------- dispatch ----------

export async function runProbe(
  probe: ProbeName,
  args: Readonly<Record<string, unknown>> | undefined,
  deps: ProbeDeps,
): Promise<unknown> {
  switch (probe) {
    case 'mentions':
      return probeMentions(deps);
    case 'flights':
      return probeFlights();
    case 'ledger':
      return probeLedger((args?.['trips'] as TripName[] | undefined) ?? ['barcelona', 'lisbon']);
    case 'album_consent':
      return probeAlbumConsent((args?.['trip'] as TripName | undefined) ?? 'barcelona');
    case 'roast_screen':
      return probeRoastScreen();
    case 'minor_screen':
      return probeMinorScreen();
    case 'auto_buy':
      return probeAutoBuy();
    default: {
      // Scenario validation rejects unknown probes; this is the backstop, so an
      // unknown name is a step error (graded), never a silent no-op.
      const never: never = probe;
      throw new Error(`unknown probe ${String(never)} (probes: ${PROBE_NAMES.join(', ')})`);
    }
  }
}
