/**
 * Group flights in chat (T-074, D-040). Three pieces, none of which buys
 * anything:
 *
 *  1. `planGroupFlights`: one provider search per traveler (round trip, or
 *     open-jaw when they fly home somewhere else: that is how the inventory
 *     is shaped), each offer mapped to a core `FlightChoice`, then
 *     `flights.optimizeGroupFlights` ranks whole-group itineraries.
 *     Refundable first (SAFETY C5): the options are the best all-refundable
 *     sets, plus the best overall set as the last option when it is
 *     non-refundable and scores better, with its trade-off said. The ranked
 *     plan is kept per group (`FlightPlanStore`) and posted as one `options`
 *     card with per-person lines (VOICE §4.10, §3.1 caps).
 *  2. `proposeFlights`: "book option 1" ⇒ every pick's offer re-fetched from
 *     the provider (an expired offer is re-found on the same flights, never
 *     swapped for others), the live fares, one `BookingProposal` for the
 *     whole set (`itemRef` = the flight set, `paidBy: per_person_cards`:
 *     each payer pays their own fare, a minor's on their guardian), then the
 *     proposal service's shared `recordProposal` tail (consistency → policy →
 *     audit → grant). Flights are on every payer (SAFETY C2/C9).
 *  3. The flight-set encoding the proposal and the executor share.
 */
import type {
  AirportCode,
  ApprovalGrant,
  AuditEventId,
  BookingProposal,
  BookingProposalCard,
  GroupId,
  GroupSpendingPolicy,
  IdGenerator,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  MessageId,
  OptionsCard,
  PolicyDecision,
  Trip,
  TripId,
  Activity,
  Roster,
} from '@trav/core';
import { approval, flights as coreFlights, formatMoney, money, parseIso } from '@trav/core';
import type { FlightOffer, FlightSearchRequest, FlightsAdapter } from '@trav/adapters';
import { toFlightChoice } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';
import { possessive } from '../render/common.js';
import { carrierOf, payersFor, type PayerRule } from './payers.js';
import { weekdayName } from './request.js';
import type { ProposeContext, ProposeInput, ProposeResult } from './proposals.js';

// ---------- the flight set (proposal itemRef ⇄ executor) ----------

export const FLIGHT_SET_PREFIX = 'flights:';

/** One traveler's provider offer in a group flight set, and the fare the group approved for it. */
export interface FlightSetPart {
  readonly memberId: MemberId;
  readonly offerId: string;
  readonly totalMinor: number;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const PART_RE = /^([A-Za-z0-9_.-]{1,120})=([A-Za-z0-9_.-]{1,120})@([1-9]\d{0,9})$/;

/**
 * `flights:<memberId>=<offerId>@<minor>,…`: the whole set the group approves,
 * whose fare each offer is and what it costs. One offer per traveler, one
 * traveler per offer.
 */
export function encodeFlightSet(parts: readonly FlightSetPart[]): string {
  if (parts.length === 0) throw new Error('encodeFlightSet: empty set');
  for (const p of parts) {
    if (
      !ID_RE.test(p.memberId) ||
      !ID_RE.test(p.offerId) ||
      !Number.isSafeInteger(p.totalMinor) ||
      p.totalMinor <= 0 ||
      p.totalMinor > 9_999_999_999
    ) {
      throw new Error(`encodeFlightSet: bad part ${p.offerId}`);
    }
  }
  if (new Set(parts.map((p) => p.offerId)).size !== parts.length) {
    throw new Error('encodeFlightSet: an offer appears twice');
  }
  if (new Set(parts.map((p) => p.memberId)).size !== parts.length) {
    throw new Error('encodeFlightSet: a traveler appears twice');
  }
  return `${FLIGHT_SET_PREFIX}${parts
    .map((p) => `${p.memberId}=${p.offerId}@${String(p.totalMinor)}`)
    .join(',')}`;
}

/** The parts of an encoded set; `undefined` for anything else (a single offer id, a malformed ref). */
export function decodeFlightSet(itemRef: string): FlightSetPart[] | undefined {
  if (!itemRef.startsWith(FLIGHT_SET_PREFIX)) return undefined;
  const body = itemRef.slice(FLIGHT_SET_PREFIX.length);
  if (body.length === 0) return undefined;
  const parts: FlightSetPart[] = [];
  for (const raw of body.split(',')) {
    const m = PART_RE.exec(raw);
    if (m === null) return undefined;
    parts.push({ memberId: m[1]!, offerId: m[2]!, totalMinor: Number(m[3]) });
  }
  if (new Set(parts.map((p) => p.offerId)).size !== parts.length) return undefined;
  if (new Set(parts.map((p) => p.memberId)).size !== parts.length) return undefined;
  return parts;
}

// ---------- the plan ----------

export interface FlightPick {
  readonly memberId: MemberId;
  readonly offerId: string;
  readonly origin: AirportCode;
  readonly destination: AirportCode;
  /** Where they fly home to (open-jaw when it differs from `origin`). */
  readonly returnTo?: AirportCode;
  readonly outbound: coreFlights.Leg;
  readonly inbound?: coreFlights.Leg;
  readonly priceMinor: number;
  readonly refundable: boolean;
}

export interface FlightPlanOption {
  readonly index: number;
  readonly picks: readonly FlightPick[];
  readonly totalMinor: number;
  readonly arrivalSpreadMinutes: number;
  readonly allRefundable: boolean;
}

export interface FlightPlan {
  /** Also the options card's `cardId`. */
  readonly planId: string;
  readonly groupId: GroupId;
  readonly tripId: TripId;
  readonly destination: AirportCode;
  readonly departDate: IsoDate;
  readonly returnDate?: IsoDate;
  readonly currency: string;
  readonly requestedBy: MemberId;
  readonly createdAt: IsoDateTime;
  readonly options: readonly FlightPlanOption[];
}

/**
 * The latest ranked plan per group, in memory: the offers it names live in
 * the provider's own session (the mock keeps them in memory too), so a plan
 * that outlives its runtime would point at nothing. A newer search replaces it.
 */
export interface FlightPlanStore {
  /** Keeps `plan` as its group's latest (same `planId` ⇒ an update of that plan). */
  save(plan: FlightPlan): void;
  latest(groupId: GroupId): FlightPlan | undefined;
  /** A plan by id, the latest or one a newer search replaced (so an old card can say so). */
  get(planId: string): FlightPlan | undefined;
  /** Which option of the latest plan a proposed flight set (`itemRef`) came from. */
  noteProposed(itemRef: string, planId: string, optionIndex: number): void;
  proposedFrom(
    itemRef: string,
  ): { readonly planId: string; readonly optionIndex: number } | undefined;
}

/** Plans kept by id per group (the latest plus the few it replaced). */
const PLANS_KEPT_PER_GROUP = 5;

export function createFlightPlanStore(): FlightPlanStore {
  const byGroup = new Map<GroupId, FlightPlan>();
  const byId = new Map<string, FlightPlan>();
  const order = new Map<GroupId, string[]>();
  const proposed = new Map<string, { planId: string; optionIndex: number }>();
  return {
    save(plan) {
      byGroup.set(plan.groupId, plan);
      byId.set(plan.planId, plan);
      const ids = (order.get(plan.groupId) ?? []).filter((id) => id !== plan.planId);
      ids.push(plan.planId);
      while (ids.length > PLANS_KEPT_PER_GROUP) {
        const evicted = ids.shift()!;
        byId.delete(evicted);
        for (const [ref, from] of proposed) if (from.planId === evicted) proposed.delete(ref);
      }
      order.set(plan.groupId, ids);
    },
    latest: (groupId) => byGroup.get(groupId),
    get: (planId) => byId.get(planId),
    noteProposed(itemRef, planId, optionIndex) {
      proposed.set(itemRef, { planId, optionIndex });
    },
    proposedFrom: (itemRef) => proposed.get(itemRef),
  };
}

// ---------- small text helpers (VOICE §3.4, §3.9) ----------

/** "2026-03-12T07:10:00-04:00" ⇒ "7:10am": the leg's own local wall clock. */
export function wallClock(iso: IsoDateTime): string {
  const h = Number(iso.slice(11, 13));
  const mm = iso.slice(14, 16);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === '00' ? `${String(h12)}${suffix}` : `${String(h12)}:${mm}${suffix}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-03-12" ⇒ "thu" (VOICE §3.9). */
function shortWeekday(date: IsoDate): string {
  return weekdayName(date).slice(0, 3);
}

/** "2026-03-12" ⇒ "thu mar 12" (VOICE §3.9). */
export function dayDate(date: IsoDate): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${shortWeekday(date)} ${MONTHS[m - 1] ?? ''} ${String(d)}`;
}

function fmt(minor: number, currency: string): string {
  return formatMoney(money(minor, currency as Parameters<typeof money>[1]));
}

function nameIn(members: readonly Member[], id: MemberId): string {
  return sanitizeInline(members.find((m) => m.memberId === id)?.displayName ?? id, 40);
}

function stopsText(leg: coreFlights.Leg): string {
  return leg.stops === 0 ? '' : `, ${String(leg.stops)} stop${leg.stops === 1 ? '' : 's'}`;
}

/** "Dean BOS 7:10am → BCN 7:35pm · home 11am to JFK · €412" (+ the day when it leaves the day before). */
export function pickLine(pick: FlightPick, members: readonly Member[], currency: string): string {
  const out = pick.outbound;
  const leavesEarlier = out.departAt.slice(0, 10) !== out.arriveAt.slice(0, 10);
  const dep = `${leavesEarlier ? `${shortWeekday(out.departAt.slice(0, 10))} ` : ''}${wallClock(out.departAt)}`;
  const parts = [
    `${nameIn(members, pick.memberId)} ${out.origin} ${dep} → ${out.destination} ${wallClock(out.arriveAt)}${stopsText(out)}`,
  ];
  if (pick.inbound !== undefined) {
    parts.push(`home ${wallClock(pick.inbound.departAt)} to ${pick.inbound.destination}`);
  }
  parts.push(fmt(pick.priceMinor, currency));
  if (!pick.refundable) parts.push('non-refundable');
  return parts.join(' · ');
}

function refundWord(option: FlightPlanOption): string {
  if (option.allRefundable) return 'refundable';
  const locked = option.picks.filter((p) => !p.refundable).length;
  return locked === option.picks.length ? 'non-refundable' : `${String(locked)} non-refundable`;
}

function spreadWord(option: FlightPlanOption, first: boolean): string {
  if (option.picks.length <= 1) {
    const p = option.picks[0];
    return p === undefined ? '' : `lands ${wallClock(p.outbound.arriveAt)}`;
  }
  if (option.arrivalSpreadMinutes === 0) return 'everyone lands together';
  const within = `within ${coreFlights.formatMinutes(option.arrivalSpreadMinutes)}`;
  return first ? `everyone lands ${within}` : `lands ${within}`;
}

function tradeoffVsFirst(
  option: FlightPlanOption,
  first: FlightPlanOption,
  currency: string,
): string {
  const d = option.totalMinor - first.totalMinor;
  if (d === 0) return '';
  return d > 0 ? `${fmt(d, currency)} more` : `${fmt(-d, currency)} less`;
}

// ---------- 1. planning ----------

export interface GroupFlightAsk {
  readonly travelers: readonly {
    readonly memberId: MemberId;
    readonly origin: AirportCode;
    /** Default: back to `origin`. */
    readonly returnTo?: AirportCode;
  }[];
  readonly destination: AirportCode;
  readonly departDate: IsoDate;
  /** No return date ⇒ one-way. */
  readonly returnDate?: IsoDate;
}

export interface FlightPlanContext {
  readonly groupId: GroupId;
  readonly trip: Trip;
  readonly members: readonly Member[];
  readonly requestedBy: MemberId;
  readonly now: IsoDateTime;
}

export type FlightOptionsResult =
  | {
      readonly kind: 'flight_options';
      readonly planId: string;
      readonly text: string;
      readonly card: OptionsCard;
      /** What the model may say back: option number, total, spread, refundability. */
      readonly options: readonly {
        readonly option: number;
        readonly totalMinor: number;
        readonly currency: string;
        readonly arrivalSpreadMinutes: number;
        readonly allRefundable: boolean;
      }[];
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'not_found' | 'provider_unavailable';
      readonly text: string;
    };

/** At most 3 options: 1 context line + 3 + 2 = the 6-line proposal cap (VOICE §3.1). */
const MAX_OPTIONS = 3;

function sliceRequest(
  ask: GroupFlightAsk,
  t: GroupFlightAsk['travelers'][number],
): FlightSearchRequest {
  const out = { origin: t.origin, destination: ask.destination, departureDate: ask.departDate };
  return {
    slices:
      ask.returnDate === undefined
        ? [out]
        : [
            out,
            {
              origin: ask.destination,
              destination: t.returnTo ?? t.origin,
              departureDate: ask.returnDate,
            },
          ],
    passengers: [{ memberId: t.memberId, type: 'adult' }],
  };
}

function toOption(it: coreFlights.GroupItinerary, index: number): FlightPlanOption {
  const picks = it.picks.map((c): FlightPick => ({
    memberId: c.memberId,
    offerId: c.offerId,
    origin: c.outbound.origin,
    destination: c.outbound.destination,
    ...(c.inbound !== undefined ? { returnTo: c.inbound.destination, inbound: c.inbound } : {}),
    outbound: c.outbound,
    priceMinor: c.price.amountMinor,
    refundable: c.refundable,
  }));
  return {
    index,
    picks,
    totalMinor: it.breakdown.totalCost.amountMinor,
    arrivalSpreadMinutes: it.breakdown.arrivalSpreadMinutes,
    allRefundable: it.allRefundable,
  };
}

const sameSet = (a: coreFlights.GroupItinerary, b: coreFlights.GroupItinerary): boolean =>
  a.picks.length === b.picks.length && a.picks.every((p, i) => p.offerId === b.picks[i]?.offerId);

/**
 * Searches, ranks and keeps the plan; never proposes or buys. A traveler with
 * no flights on those dates gets one honest line instead of a partial card.
 */
export async function planGroupFlights(
  deps: {
    readonly flights: FlightsAdapter;
    readonly plans: FlightPlanStore;
    readonly ids: IdGenerator;
  },
  ask: GroupFlightAsk,
  ctx: FlightPlanContext,
): Promise<FlightOptionsResult> {
  const members = ctx.members;
  const choices: coreFlights.FlightChoice[] = [];
  for (const t of ask.travelers) {
    const res = await deps.flights.search(sliceRequest(ask, t));
    if (!res.ok) {
      return {
        kind: 'unavailable',
        reason: 'provider_unavailable',
        text: "the flight site's not responding, so no options yet. nothing's booked\n@ me again in a few",
      };
    }
    for (const offer of res.value) {
      // Only offers that fly exactly what was asked, in the trip currency.
      if (offer.totalAmount.currency !== ctx.trip.currency) continue;
      if (!offer.passengerIds.includes(t.memberId)) continue;
      choices.push(toFlightChoice(offer, t.memberId));
    }
  }
  const travel: coreFlights.MemberTravel[] = ask.travelers.map((t) => ({
    memberId: t.memberId,
    origin: t.origin,
    returnTo: t.returnTo ?? t.origin,
    name: nameIn(members, t.memberId),
  }));
  const run = (refundableOnly: boolean, maxResults: number): coreFlights.OptimizerResult =>
    coreFlights.optimizeGroupFlights({
      destination: ask.destination,
      members: travel,
      choices,
      weights: coreFlights.DEFAULT_WEIGHTS,
      constraints: refundableOnly ? { refundableOnly: true } : {},
      maxResults,
    });
  // Refundable first (SAFETY C5): the all-refundable sets lead.
  const refundable = run(true, MAX_OPTIONS);
  if (refundable.missing.length > 0 || refundable.itineraries.length === 0) {
    const who = refundable.missing.map((id) => {
      const t = ask.travelers.find((x) => x.memberId === id);
      return `${nameIn(members, id)} (${t?.origin ?? '?'} → ${ask.destination})`;
    });
    return {
      kind: 'unavailable',
      reason: 'not_found',
      text: `no flights for ${who.join(', ') || 'that'} on ${dayDate(ask.departDate)}, so no options yet. nothing's booked\ncheck the airports and dates and @ me again`,
    };
  }
  const ranked = [...refundable.itineraries];
  // The best set overall, when it is not all-refundable and scores better,
  // is shown last with its trade-off (VOICE §4.10: alternatives say why
  // they're not the first choice).
  const overall = run(false, 1).itineraries[0];
  if (
    overall !== undefined &&
    !overall.allRefundable &&
    overall.breakdown.score < (ranked[0]?.breakdown.score ?? Infinity) &&
    !ranked.some((r) => sameSet(r, overall))
  ) {
    if (ranked.length >= MAX_OPTIONS) ranked.splice(MAX_OPTIONS - 1);
    ranked.push(overall);
  }
  const options = ranked.slice(0, MAX_OPTIONS).map((it, i) => toOption(it, i + 1));
  const planId = deps.ids.next('card');
  const plan: FlightPlan = {
    planId,
    groupId: ctx.groupId,
    tripId: ctx.trip.tripId,
    destination: ask.destination,
    departDate: ask.departDate,
    ...(ask.returnDate !== undefined ? { returnDate: ask.returnDate } : {}),
    currency: ctx.trip.currency,
    requestedBy: ctx.requestedBy,
    createdAt: ctx.now,
    options,
  };
  deps.plans.save(plan);
  const { text, card } = renderFlightOptions(plan, members);
  return {
    kind: 'flight_options',
    planId,
    text,
    card,
    options: options.map((o) => ({
      option: o.index,
      totalMinor: o.totalMinor,
      currency: plan.currency,
      arrivalSpreadMinutes: o.arrivalSpreadMinutes,
      allRefundable: o.allRefundable,
    })),
  };
}

/**
 * The options card (VOICE §4.10 C shape, §3.1 caps): what was searched, one
 * line per option (total · arrival spread · refundability · trade-off vs
 * option 1), who pays (each their own fare), how to pick. Per-person flights
 * are in the card's `details`.
 */
export function renderFlightOptions(
  plan: FlightPlan,
  members: readonly Member[],
): { readonly text: string; readonly card: OptionsCard } {
  const first = plan.options[0];
  if (first === undefined) throw new Error('renderFlightOptions: no options');
  const n = first.picks.length;
  const home = plan.returnDate === undefined ? '' : `, home ${dayDate(plan.returnDate)}`;
  const context = `flights for ${String(n)} into ${plan.destination} ${dayDate(plan.departDate)}${home}`;
  const k = plan.options.length;
  const lines = [`${context}. ${k === 1 ? 'best fit' : `best ${String(k)}`}:`];
  for (const o of plan.options) {
    const tradeoff = o.index === 1 ? '' : tradeoffVsFirst(o, first, plan.currency);
    lines.push(
      [
        `${String(o.index)}. ${fmt(o.totalMinor, plan.currency)}`,
        spreadWord(o, o.index === 1),
        refundWord(o),
        ...(tradeoff.length > 0 ? [tradeoff] : []),
      ].join(' · '),
    );
  }
  lines.push(
    n === 1
      ? 'flight times are in the card'
      : 'each person pays their own fare. who flies when is in the card',
  );
  const others = plan.options.slice(1).map((o) => String(o.index));
  const or =
    others.length === 0
      ? ''
      : ` (or ${others.length === 1 ? others[0]! : `${others.slice(0, -1).join(', ')} or ${others[others.length - 1]!}`})`;
  lines.push(`say "@trav book option 1"${or}. nothing's booked yet`);
  const text = lines.join('\n');
  const card: OptionsCard = {
    cardId: plan.planId,
    type: 'options',
    title: `flights into ${plan.destination}`,
    fallbackText: text,
    context,
    options: plan.options.map((o) => ({
      id: `${plan.planId}#${String(o.index)}`,
      index: o.index,
      label: spreadWord(o, true),
      price: money(o.totalMinor, plan.currency as Parameters<typeof money>[1]),
      refundable: o.allRefundable,
      tradeoff: o.index === 1 ? '' : tradeoffVsFirst(o, first, plan.currency),
      details: o.picks.map((p) => pickLine(p, members, plan.currency)),
    })),
    pickAction: { id: 'pick', label: 'Book this one', style: 'secondary', textAliases: [] },
    status: 'pending',
  };
  return { text, card };
}

/** The option a "pick" tap names: `<planId>#<n>` or a bare number. */
export function optionIndexOf(value: string | undefined, planId: string): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const m = /^(?:(.+)#)?(\d{1,2})$/.exec(v);
  if (m === null) return undefined;
  if (m[1] !== undefined && m[1] !== planId) return undefined;
  const n = Number(m[2]);
  return n >= 1 ? n : undefined;
}

// ---------- 2. the proposal ----------

/** The proposal service's shared tail (`recordProposal` in proposals.ts). */
export type RecordProposal = (a: {
  readonly proposal: BookingProposal;
  readonly trip: Trip;
  readonly grp: { readonly spendingPolicy: GroupSpendingPolicy };
  readonly ctx: ProposeContext;
  readonly members: readonly Member[];
  readonly activity: Activity | null;
  readonly roster: Roster | null;
  readonly now: IsoDateTime;
  readonly release: () => Promise<void>;
}) => Promise<
  | { readonly kind: 'done'; readonly result: ProposeResult }
  | {
      readonly kind: 'card';
      readonly decision: PolicyDecision;
      readonly grant: ApprovalGrant;
      readonly ruleId: string;
      readonly messageId: MessageId;
      readonly auditIds: readonly AuditEventId[];
    }
>;

interface LivePick extends FlightPick {
  readonly expiresAt: IsoDateTime;
  /** Refund penalty on the offer, minor units (0 when free or non-refundable). */
  readonly penaltyMinor: number;
}

export const REPLACED_OPTIONS_TEXT =
  "those flight options were replaced by a newer search, so nothing's booked\npick from the newer card";

export const NO_FLIGHT_OPTIONS_TEXT =
  "there are no flight options up right now, so nothing's booked\n@ me with who flies from where and when, and i'll find some";

const FLIGHTS_DOWN_TEXT =
  "the flight site's not responding. no charge went through\n@ me again in a few";

const sameLeg = (a: coreFlights.Leg | undefined, b: coreFlights.Leg | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.departAt === b.departAt &&
      a.origin === b.origin &&
      a.destination === b.destination &&
      a.flightNumbers.join('/') === b.flightNumbers.join('/');

/**
 * The live offer for a pick: re-fetched by id (a re-price is quoted as is);
 * expired or gone ⇒ the same flights at the same terms from a fresh search,
 * or nothing. Never another flight in its place.
 */
async function livePick(
  flights: FlightsAdapter,
  pick: FlightPick,
  plan: FlightPlan,
): Promise<LivePick | 'gone' | 'down'> {
  const from = (offer: FlightOffer): LivePick => {
    const choice = toFlightChoice(offer, pick.memberId);
    const penalty = offer.conditions.refundBeforeDeparture.penalty?.amountMinor ?? 0;
    return {
      ...pick,
      offerId: offer.offerId,
      outbound: choice.outbound,
      ...(choice.inbound !== undefined ? { inbound: choice.inbound } : {}),
      priceMinor: choice.price.amountMinor,
      refundable: choice.refundable,
      expiresAt: offer.expiresAt,
      penaltyMinor: choice.refundable ? penalty : 0,
    };
  };
  // Only this traveler's own fare, in the trip currency, is ever proposed.
  const fits = (offer: FlightOffer): boolean =>
    offer.passengerIds.length === 1 &&
    offer.passengerIds[0] === pick.memberId &&
    offer.totalAmount.currency === plan.currency;
  let got = await flights.getOffer(pick.offerId);
  if (!got.ok && got.error.code === 'price_changed') got = await flights.getOffer(pick.offerId);
  if (got.ok) return fits(got.value) ? from(got.value) : 'gone';
  if (got.error.code !== 'offer_expired' && got.error.code !== 'not_found') return 'down';
  const res = await flights.search(
    sliceRequest(
      {
        travelers: [],
        destination: plan.destination,
        departDate: plan.departDate,
        ...(plan.returnDate !== undefined ? { returnDate: plan.returnDate } : {}),
      },
      {
        memberId: pick.memberId,
        origin: pick.origin,
        ...(pick.returnTo !== undefined ? { returnTo: pick.returnTo } : {}),
      },
    ),
  );
  if (!res.ok) return 'down';
  const same = res.value.find((offer) => {
    if (!fits(offer)) return false;
    const c = toFlightChoice(offer, pick.memberId);
    return (
      c.refundable === pick.refundable &&
      sameLeg(c.outbound, pick.outbound) &&
      sameLeg(c.inbound, pick.inbound)
    );
  });
  return same === undefined ? 'gone' : from(same);
}

export interface ProposeFlightsDeps {
  readonly flights: FlightsAdapter;
  readonly plans: FlightPlanStore;
  readonly ids: IdGenerator;
  readonly stores: {
    readonly group: {
      readonly members: { listByGroup(groupId: GroupId): readonly Member[] };
      readonly bookings: {
        listPendingProposals(groupId: GroupId): readonly BookingProposal[];
        getBookingByKey(key: string):
          | {
              readonly bookingId: string;
              readonly description: string;
              readonly totalMinor: number;
              readonly currency: string;
            }
          | undefined;
      };
    };
  };
}

/** The plan option a proposal ask names, or the set a re-quote carries. */
function chosenOption(
  plans: FlightPlanStore,
  input: ProposeInput,
  groupId: GroupId,
  trip: Trip,
):
  | { plan: FlightPlan; option: FlightPlanOption; roster?: readonly MemberId[] }
  | { text: string; clarify?: true } {
  const set = input.itemRef === undefined ? undefined : decodeFlightSet(input.itemRef);
  const plan = plans.latest(groupId);
  if (plan === undefined || plan.tripId !== trip.tripId) return { text: NO_FLIGHT_OPTIONS_TEXT };
  if (set !== undefined) {
    // A re-quote ("not me", a price change): exactly the set's own flights,
    // each traveler on the offer they were proposed (never another option's),
    // under the option number it was proposed as.
    const from = plans.proposedFrom(input.itemRef!);
    if (from !== undefined && from.planId !== plan.planId) return { text: REPLACED_OPTIONS_TEXT };
    const all = plan.options.flatMap((o) => o.picks);
    const picks = set.map((part) =>
      all.find((p) => p.memberId === part.memberId && p.offerId === part.offerId),
    );
    if (picks.some((p) => p === undefined)) return { text: NO_FLIGHT_OPTIONS_TEXT };
    const own = picks as FlightPick[];
    const index =
      from?.optionIndex ??
      plan.options.find((o) =>
        own.every((p) => o.picks.some((q) => q.memberId === p.memberId && q.offerId === p.offerId)),
      )?.index;
    if (index === undefined) return { text: NO_FLIGHT_OPTIONS_TEXT };
    const base = plan.options.find((o) => o.index === index)!;
    return {
      plan,
      roster: base.picks.map((p) => p.memberId),
      option: {
        ...base,
        picks: own,
        totalMinor: own.reduce((s, p) => s + p.priceMinor, 0),
        allRefundable: own.every((p) => p.refundable),
      },
    };
  }
  // A tap names its own card: one a newer search replaced books nothing.
  if (input.planId !== undefined && input.planId !== plan.planId) {
    return { text: REPLACED_OPTIONS_TEXT };
  }
  const n = input.option ?? (plan.options.length === 1 ? 1 : undefined);
  const option = n === undefined ? undefined : plan.options.find((o) => o.index === n);
  if (option === undefined) {
    const k = plan.options.length;
    return {
      text: `which one? there ${k === 1 ? 'is 1 option' : `are ${String(k)} options`} up. say "@trav book option 1"${k > 1 ? ` (up to ${String(k)})` : ''}`,
      clarify: true,
    };
  }
  return { plan, option };
}

/** "2 non-refundable" ⇒ the trade-off line; all refundable ⇒ the fee note. */
function refundLine(picks: readonly LivePick[]): string {
  const locked = picks.filter((p) => !p.refundable).length;
  if (locked === 0) {
    return picks.some((p) => p.penaltyMinor > 0)
      ? 'refundable before departure, fees apply'
      : 'refundable before departure';
  }
  if (locked === picks.length) return 'non-refundable';
  return `${String(picks.length - locked)} refundable, ${String(locked)} non-refundable`;
}

/**
 * VOICE §4.1 for a flight set, at most 6 lines (§3.1): which option, where
 * and when; each fare (three named, the rest in the card); the total and
 * refund terms; who pays (each their own fare, a minor's on their guardian);
 * who has to 👍 and why; how long it's held. From the proposal, the live
 * picks and the decision only.
 */
export function renderFlightProposalText(input: {
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly picks: readonly LivePick[];
  readonly plan: FlightPlan;
  readonly optionIndex: number;
  readonly members: readonly Member[];
  readonly excluded: readonly MemberId[];
  readonly expiresAt: IsoDateTime;
  readonly now: IsoDateTime;
}): string {
  const { proposal: p, decision, picks, plan, members } = input;
  const n = p.attendees.length;
  const cur = p.currency;
  const home = plan.returnDate === undefined ? '' : `, home ${dayDate(plan.returnDate)}`;
  const notList =
    input.excluded.length > 0
      ? ` (not ${input.excluded.map((id) => nameIn(members, id)).join(', ')})`
      : '';
  const lines = [
    `option ${String(input.optionIndex)}, flights for ${String(n)}${notList}: into ${plan.destination} ${dayDate(plan.departDate)}${home}`,
  ];
  const fares = picks.map((x) => x.priceMinor);
  if (fares.every((f) => f === fares[0])) {
    lines.push(
      `${fmt(fares[0]!, cur)} each · ${picks.map((x) => nameIn(members, x.memberId)).join(', ')}`,
    );
  } else {
    const shown = picks
      .slice(0, 3)
      .map((x) => `${nameIn(members, x.memberId)} ${fmt(x.priceMinor, cur)}`);
    const more = picks.length > 3 ? ` · +${String(picks.length - 3)} more in the card` : '';
    lines.push(`${shown.join(' · ')}${more}`);
  }
  lines.push(`${fmt(p.totalMinor, cur)} total · ${refundLine(picks)}`);
  const payerIds = p.payers.map((s) => s.memberId);
  const carried = p.attendees.filter((id) => !payerIds.includes(id));
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const carriedNote =
    carried.length === 0
      ? ''
      : ` (${carried
          .map((id) => {
            // Whoever carries the fare: their guardian when paying, else the one payer.
            const g = byId.get(id)?.guardianMemberId;
            const carrier =
              g !== undefined && payerIds.includes(g)
                ? g
                : payerIds.length === 1
                  ? payerIds[0]
                  : undefined;
            const who = possessive(nameIn(members, id));
            return carrier === undefined
              ? `${who} on a guardian's`
              : `${who} on ${possessive(nameIn(members, carrier))}`;
          })
          .join(', ')})`;
  lines.push(
    n === 1 && carried.length === 0
      ? 'on your own card, nothing to split'
      : `each pays their own fare on their own card${carriedNote}, nothing to split`,
  );
  const minutes = Math.max(
    1,
    Math.round((parseIso(input.expiresAt) - parseIso(input.now)) / 60000),
  );
  const held = `price held for ${String(minutes)} min`;
  const approvers = decision.requiredApprovers;
  if (approvers.length > 1) {
    lines.push(
      `flights are on everyone paying, so all ${String(approvers.length)} of you have to 👍`,
    );
    lines.push(`👍 to book, or say "not me" first. ${held}`);
  } else if (approvers.length === 1 && approvers[0] !== p.requestedBy) {
    lines.push(`👍 from ${nameIn(members, approvers[0]!)} to book, or say "not me" first. ${held}`);
  } else {
    lines.push(`👍 to book. ${held}`);
  }
  return lines.join('\n');
}

function buildFlightCard(input: {
  readonly cardId: string;
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly picks: readonly LivePick[];
  readonly plan: FlightPlan;
  readonly members: readonly Member[];
  readonly excluded: readonly MemberId[];
  readonly text: string;
  readonly ruleId: string;
  readonly capPerPersonMinor: number;
  readonly expiresAt: IsoDateTime;
}): BookingProposalCard {
  const { proposal: p, decision, members } = input;
  const cur = p.currency as Parameters<typeof money>[1];
  const overCap = decision.reasons.includes('over_per_person_cap');
  const reason = decision.reasons.includes('kind_requires_each_payer')
    ? 'flights are on everyone paying'
    : overCap
      ? `over the ${formatMoney(money(input.capPerPersonMinor, cur))}/person cap`
      : !p.refundable
        ? 'non-refundable'
        : undefined;
  const firstOut = [...input.picks].sort(
    (a, b) => parseIso(a.outbound.departAt) - parseIso(b.outbound.departAt),
  )[0];
  return {
    cardId: input.cardId,
    type: 'booking_proposal',
    title: p.description,
    fallbackText: input.text,
    proposalId: p.proposalId,
    category: 'flight',
    item: {
      name: p.description,
      venue: input.plan.destination,
      ...(firstOut !== undefined ? { startsAt: firstOut.outbound.departAt } : {}),
      details: input.picks.map((x) => pickLine(x, members, p.currency)),
    },
    quantity: p.attendees.length,
    charged: p.payers.map((s) => ({
      memberId: s.memberId,
      name: nameIn(members, s.memberId),
      share: money(s.shareMinor, cur),
    })),
    excluded: input.excluded.map((id) => ({ memberId: id, name: nameIn(members, id) })),
    pricePerPerson: money(Math.round(p.totalMinor / Math.max(1, p.attendees.length)), cur),
    total: money(p.totalMinor, cur),
    refundable: p.refundable,
    ...(p.refundDeadline !== undefined ? { refundDeadline: p.refundDeadline } : {}),
    paidBy: p.paidBy,
    policy: {
      requiresApprovalFrom: decision.requiredApprovers,
      approvalMode: decision.approvalMode === 'each_payer' ? 'each_payer' : 'any_one',
      overCap,
      capPerPerson: money(input.capPerPersonMinor, cur),
      ...(reason !== undefined ? { reason } : {}),
      ruleId: input.ruleId,
    },
    holdExpiresAt: input.expiresAt,
    status: 'pending',
  };
}

/**
 * "book option N" (or a re-quote of a flight set) ⇒ one proposal for every
 * traveler on that option, at the live fares, through `record` (consistency →
 * `ApprovalPolicy` → audit → grant). Nothing is bought here.
 */
export async function proposeFlights(a: {
  readonly deps: ProposeFlightsDeps;
  readonly input: ProposeInput;
  readonly ctx: ProposeContext;
  readonly grp: { readonly spendingPolicy: GroupSpendingPolicy };
  readonly trip: Trip;
  readonly now: IsoDateTime;
  readonly record: RecordProposal;
}): Promise<ProposeResult> {
  const { deps, input, ctx, grp, trip, now } = a;
  const chosen = chosenOption(deps.plans, input, ctx.groupId, trip);
  if (!('plan' in chosen)) {
    return chosen.clarify === true
      ? { kind: 'clarify', question: chosen.text, problems: ['which_option'] }
      : { kind: 'unavailable', reason: 'not_found', text: chosen.text };
  }
  const { plan, option } = chosen;
  // Who the option was for: "not" names everyone dropped since, across re-quotes.
  const roster = chosen.roster ?? option.picks.map((p) => p.memberId);
  const members = deps.stores.group.members.listByGroup(ctx.groupId);
  const order = members.map((m) => m.memberId);

  // ---- who's flying: the option's travelers, narrowed when named ----
  const nameIds = (names: readonly string[] | undefined): MemberId[] =>
    (names ?? [])
      .map((n) =>
        members.find((m) => m.displayName.trim().toLowerCase() === n.trim().toLowerCase()),
      )
      .filter((m): m is Member => m !== undefined)
      .map((m) => m.memberId);
  const named = [...(input.attendeeMemberIds ?? []), ...nameIds(input.attendeeNames)];
  const out = new Set([...(input.excludedMemberIds ?? []), ...nameIds(input.excludedNames)]);
  const onOption = option.picks.map((p) => p.memberId);
  const unknown = named.filter((id) => !onOption.includes(id));
  if (unknown.length > 0) {
    return {
      kind: 'clarify',
      question: `option ${String(option.index)} has no flight for ${unknown.map((id) => nameIn(members, id)).join(', ')}. @ me to search again with everyone who's flying`,
      problems: ['not_on_option'],
    };
  }
  const picks = option.picks.filter(
    (p) => (named.length === 0 || named.includes(p.memberId)) && !out.has(p.memberId),
  );
  if (picks.length === 0) {
    return {
      kind: 'clarify',
      question: "who's flying? nobody's left on that option",
      problems: ['empty_roster'],
    };
  }
  const excluded = roster.filter((id) => !picks.some((p) => p.memberId === id));

  // ---- the live fares, from the provider (never the plan's numbers) ----
  const live: LivePick[] = [];
  for (const pick of picks) {
    const got = await livePick(deps.flights, pick, plan);
    if (got === 'down')
      return { kind: 'unavailable', reason: 'provider_unavailable', text: FLIGHTS_DOWN_TEXT };
    if (got === 'gone') {
      return {
        kind: 'unavailable',
        reason: 'sold_out',
        text: `${nameIn(members, pick.memberId)}'s flight on option ${String(option.index)} isn't bookable anymore, so nothing's booked\n@ me and i'll search again`,
      };
    }
    live.push(got);
  }
  live.sort((x, y) => order.indexOf(x.memberId) - order.indexOf(y.memberId));
  // An expired offer re-found on the same flights has a new id: the kept plan
  // follows it, so a re-quote of this set ("not me", a price change) still
  // finds its option.
  const renamed = new Map(
    live
      .map((x) => [picks.find((p) => p.memberId === x.memberId)?.offerId, x] as const)
      .filter(([old, x]) => old !== undefined && old !== x.offerId),
  );
  if (renamed.size > 0) {
    deps.plans.save({
      ...plan,
      // Every option that holds the re-found offer follows it (options share fares).
      options: plan.options.map((o) => ({
        ...o,
        picks: o.picks.map((p) => {
          const x = renamed.get(p.offerId);
          return x === undefined || x.memberId !== p.memberId ? p : { ...p, offerId: x.offerId };
        }),
      })),
    });
  }
  const attendees = live.map((x) => x.memberId);
  const currency = trip.currency;
  const totalMinor = live.reduce((s, x) => s + x.priceMinor, 0);

  // ---- who pays: each their own fare; a minor's lands on their guardian ----
  const rule: PayerRule = {
    members,
    now,
    familyTab: trip.familyTab === true,
    requestedBy: ctx.requestedBy,
  };
  const carriers = payersFor(attendees, rule);
  const byCarrier = new Map<MemberId, number>(carriers.map((id) => [id, 0]));
  for (const x of live) {
    const to = carrierOf(x.memberId, carriers, rule);
    byCarrier.set(to, (byCarrier.get(to) ?? 0) + x.priceMinor);
  }
  const payers = carriers.map((memberId) => ({
    memberId,
    shareMinor: byCarrier.get(memberId) ?? 0,
  }));

  // ---- nothing twice ----
  const itemRef = encodeFlightSet(
    live.map((x) => ({ memberId: x.memberId, offerId: x.offerId, totalMinor: x.priceMinor })),
  );
  // A later re-quote of this set keeps its option number (and its flights).
  deps.plans.noteProposed(itemRef, plan.planId, option.index);
  const inTrip = plan.departDate >= trip.startDate && plan.departDate <= trip.endDate;
  const eventDate: IsoDate | '' = inTrip ? plan.departDate : '';
  const key = approval.deriveIdempotencyKey({
    groupId: ctx.groupId,
    tripId: trip.tripId,
    kind: 'flight',
    provider: deps.flights.info.provider,
    itemRef,
    eventDate,
    payerIds: attendees,
    currency,
    totalMinor,
  });
  const pendingSame = deps.stores.group.bookings
    .listPendingProposals(ctx.groupId)
    .find((p) => p.idempotencyKey === key && p.status === 'pending');
  if (pendingSame !== undefined) {
    return {
      kind: 'pending_exists',
      proposalId: pendingSame.proposalId,
      text: "that one's already waiting for a 👍 above",
    };
  }
  const booked = deps.stores.group.bookings.getBookingByKey(key);
  if (booked !== undefined) {
    return {
      kind: 'duplicate',
      bookingId: booked.bookingId,
      text: `already booked: ${sanitizeInline(booked.description, 60)}, ${fmt(booked.totalMinor, booked.currency)}`,
    };
  }

  const refundable = live.every((x) => x.refundable);
  const firstDeparture = [...live].sort(
    (x, y) => parseIso(x.outbound.departAt) - parseIso(y.outbound.departAt),
  )[0]!.outbound.departAt;
  const holdExpiresAt = [...live].sort((x, y) => parseIso(x.expiresAt) - parseIso(y.expiresAt))[0]!
    .expiresAt;
  const proposal: BookingProposal = {
    proposalId: deps.ids.next('prop'),
    groupId: ctx.groupId,
    tripId: trip.tripId,
    kind: 'flight',
    provider: deps.flights.info.provider,
    itemRef,
    description: `flights to ${plan.destination}`,
    totalMinor,
    currency,
    quotedAt: now,
    quoteRef: itemRef,
    holdExpiresAt,
    payers,
    attendees,
    paidBy: { kind: 'per_person_cards' },
    refundable,
    // Refundable before departure (with the airline's fee): the first flight out.
    ...(refundable ? { refundDeadline: firstDeparture } : {}),
    eventDate,
    ageRestriction: null,
    contentTags: [],
    requestedBy: ctx.requestedBy,
    requestedAt: now,
    sourceMessageId: ctx.sourceMessageId,
    idempotencyKey: key,
    status: 'pending',
  };

  const recorded = await a.record({
    proposal,
    trip,
    grp,
    ctx,
    members,
    activity: null,
    roster: null,
    now,
    release: async () => {},
  });
  if (recorded.kind === 'done') return recorded.result;
  const { decision, grant, ruleId, messageId, auditIds } = recorded;
  const expiresAt =
    decision.expiresAt === null || parseIso(holdExpiresAt) < parseIso(decision.expiresAt)
      ? holdExpiresAt
      : decision.expiresAt;
  const text = renderFlightProposalText({
    proposal,
    decision,
    picks: live,
    plan,
    optionIndex: option.index,
    members,
    excluded,
    expiresAt,
    now,
  });
  const card = buildFlightCard({
    cardId: deps.ids.next('card'),
    proposal,
    decision,
    picks: live,
    plan,
    members,
    excluded,
    text,
    ruleId,
    capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
    expiresAt,
  });
  return {
    kind: 'proposal',
    proposal,
    decision,
    grant,
    card,
    text,
    messageId,
    auditEventIds: auditIds,
    event: {
      eventId: plan.planId,
      name: proposal.description,
      venue: plan.destination,
      startsAt: firstDeparture,
    },
    attendees,
    excluded,
  };
}
