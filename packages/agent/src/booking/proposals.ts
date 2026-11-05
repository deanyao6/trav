/**
 * Booking proposals (ARCHITECTURE Flow 2 step 1; SAFETY §2.1, §2.5). The model's
 * `propose_booking` tool ends here, and this module ends at a `BookingProposal`
 * plus a `BookingProposalCard`: it never calls a provider's purchase method.
 *
 * Steps: resolve the trip → resolve who is in (the named subset wins; a member
 * marked out stays out; never guess from a headcount) → find the event and the
 * best offer (refundable first, then cheapest, `purchaseMode: 'api'` only) →
 * hold → sync the activity roster (reason text never stored) →
 * `checkProposalConsistency` (problems ⇒ one clarifying question, no proposal)
 * → `approval.evaluate` → audit `proposal.created` → `policy.evaluated` →
 * `approval.requested` → grant → card + VOICE §4.1 text.
 */
import type {
  Action,
  Activity,
  AuditEventId,
  BookingProposal,
  BookingProposalCard,
  Clock,
  GroupId,
  GroupSpendingPolicy,
  IdGenerator,
  IsoDate,
  IsoDateTime,
  Member,
  MemberId,
  MemberSpendingPrefs,
  MemberView,
  MessageId,
  AskSignal,
  Money,
  OptionsCard,
  OutboundMessage,
  PolicyContext,
  PolicyDecision,
  ProposalId,
  ReasonCode,
  Roster,
  Stores,
  Trip,
  TripId,
  ApprovalGrant,
} from '@trav/core';
import {
  addDays,
  addMinutes,
  allocateEqual,
  daysBetween,
  approval,
  formatClockTime,
  formatIso,
  formatMoney,
  formatTime,
  localDate,
  localHour,
  money,
  parseIso,
  safety,
  tabAutoCapOf,
  TravError,
  zonedWallTimeToMs,
  zoneOffsetMinutes,
} from '@trav/core';
import type {
  FlightsAdapter,
  LodgingAdapter,
  LodgingRate,
  LodgingSearchResult,
  TicketEvent,
  TicketHold,
  TicketOffer,
  TicketsAdapter,
} from '@trav/adapters';
import {
  APPROVE_TEXT_ALIASES,
  DECLINE_TEXT_ALIASES,
  NOT_ME_TEXT_ALIASES,
} from '../approval/whitelist.js';
import { sanitizeInline } from '../context/groupContext.js';
import { keptOffFor } from '../roster/index.js';
import type { AutoBuyVerdict } from './autoBuy.js';
import {
  choiceOffers,
  createTicketChoiceStore,
  planLive,
  renderTicketOptions,
  type TicketChoiceOption,
  type TicketChoicePlan,
  type TicketChoiceStore,
} from './choice.js';
import { proposeFlights, type FlightPlanStore } from './flights.js';
import { cardHolderFor, carrierOf, payersFor, type PayerRule } from './payers.js';
import {
  askedMinutes,
  CATEGORY_WORDS,
  foldText,
  resolveNight,
  venueKeyOf,
  weekdayName,
} from './request.js';

/** An eligible `autoBuyVerdict` (T-168). */
export type EligibleAutoBuy = Extract<AutoBuyVerdict, { readonly eligible: true }>;

export interface ProposalDeps {
  readonly stores: Stores;
  readonly tickets: TicketsAdapter;
  /** Lodging proposals (T-132); absent ⇒ "can't book places to stay from the chat yet". */
  readonly lodging?: LodgingAdapter;
  /** Group flights (T-074): "book option N" from the latest `search_flights` plan; absent ⇒ "can't book flights from the chat yet". */
  readonly flights?: FlightsAdapter;
  readonly flightPlans?: FlightPlanStore;
  /** T-168 (b): ticket options cards; absent ⇒ an in-memory store owned by the service. */
  readonly ticketChoices?: TicketChoiceStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What the model (or the offline booking-intent fallback) may ask for. */
export interface ProposeInput {
  readonly kind: 'ticket' | 'flight' | 'lodging' | 'transport' | 'other';
  /** Free text the event search matches ("razzmatazz", "barça"). */
  readonly query?: string;
  /** Provider event / offer ids when the model already searched. */
  readonly eventId?: string;
  readonly offerId?: string;
  /** Lodging: the `rateId` from `search_lodging` (T-132). */
  readonly itemRef?: string;
  /** Lodging: the most the member said the stay may cost, in trip minor units; a dearer live rate is never proposed (T-132 r1 #1). */
  readonly maxTotalMinor?: number;
  /** Lodging: the neighbourhoods the member asked for; the non-refundable trade-off line stays inside them (T-132 r1 #5). */
  readonly areas?: readonly string[];
  /** Flights: the option number on the latest flight options card ("book option 1"), T-074. */
  readonly option?: number;
  /** Flights: the options card the pick came from (a tap); a card a newer search replaced books nothing. */
  readonly planId?: string;
  /** Exactly who is going; wins over quantity and roster. */
  readonly attendeeMemberIds?: readonly MemberId[];
  /** Named out ("Henry's sick"), by id or by display name. */
  readonly excludedMemberIds?: readonly MemberId[];
  readonly excludedNames?: readonly string[];
  /** Exactly who is going, by display name ("for me" ⇒ the sender's name); resolved like `excludedNames`. */
  readonly attendeeNames?: readonly string[];
  readonly quantity?: number;
  readonly activityId?: string;
  /** Night to book (local trip date); default: tonight, else the next one. */
  readonly date?: IsoDate;
  /**
   * The night as the member said it, when `date` isn't given: `tonight`,
   * `tomorrow`, a weekday (`friday`), or `MM-DD` (T-081, `booking/request.ts`).
   * A named night is binding: nothing that night ⇒ say so and name the
   * closest one, never quietly book another night.
   */
  readonly day?: string;
  /** Words the offer's tier name must contain ("lateral", "vip"); no such tier ⇒ say so. */
  readonly tier?: readonly string[];
  /**
   * The start time as said ("3pm", "10:30am", "3": `askedTime`), T-143. With
   * a night: nothing starting within an hour of it ⇒ the closest slot, no hold.
   */
  readonly time?: string;
  readonly requestText?: string;
  /**
   * `sync` (default): the named attendees ARE the activity roster, everyone
   * else is written out. `add_on`: a separate purchase for members joining an
   * activity that is already booked (T-030 late joiner); the roster rows of
   * the members who already have tickets are left alone.
   */
  readonly rosterMode?: 'sync' | 'add_on';
}

export interface ProposeContext {
  readonly groupId: GroupId;
  readonly tripId: TripId | null;
  readonly requestedBy: MemberId;
  readonly sourceMessageId: MessageId;
  /**
   * Never `auto_approved`: when the policy would auto-approve, the decision is
   * still `needs_confirmation` (`any_one`, the policy's approvers plus the
   * requester) and a card with 👍 goes out. Set for every proposal that does
   * not come from the requester's own ask: a re-quote after "not me", a
   * roster change or a price change, and a late joiner's add-on (D-019 §3 "an
   * opt-out never spends", VOICE §6.2 re-proposal). `repropose` always sets it.
   */
  readonly requireConfirmation?: boolean;
  /**
   * T-168 (a), D-044: the triggering message's `autoBuyVerdict`, when it was
   * eligible. Set by the loop from the member's own words, never by the
   * model. The policy may then buy without a card, but only if the proposal
   * is exactly that ask: a ticket at the venue it named, on the night it
   * named (tonight when it named none), for exactly the people it named, at
   * the regular offer (no tier or offer the ask didn't say). Anything else ⇒
   * the card.
   */
  readonly autoBuy?: EligibleAutoBuy;
  /**
   * T-168 (b): the asker's own pick on Trav's ticket options card. Set only
   * by `pickTicketOption`. Kept as the policy's `pick` ask only when the
   * re-quoted total is the one the card showed.
   */
  readonly pick?: {
    readonly planId: string;
    readonly offerId: string;
    readonly expectedTotalMinor: number;
  };
  /** T-168 (b): the proposal is an option picked off a ticket options card (by anyone); the card names the tier. */
  readonly fromOptions?: boolean;
  /** T-168 (b): the member who picked the option (may differ from `requestedBy`); audited. */
  readonly pickedBy?: MemberId;
}

export interface EventSummary {
  readonly eventId: string;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: IsoDateTime;
}

export type ProposeResult =
  | {
      readonly kind: 'proposal';
      readonly proposal: BookingProposal;
      readonly decision: PolicyDecision;
      readonly grant: ApprovalGrant;
      readonly card: BookingProposalCard;
      readonly text: string;
      /** Pre-allocated id of the group message that will carry the card (in `approval.requested`). */
      readonly messageId: MessageId;
      readonly auditEventIds: readonly AuditEventId[];
      readonly event: EventSummary;
      readonly attendees: readonly MemberId[];
      readonly excluded: readonly MemberId[];
    }
  | {
      readonly kind: 'auto_approved';
      readonly proposal: BookingProposal;
      readonly decision: PolicyDecision;
      readonly grant: ApprovalGrant;
      readonly auditEventIds: readonly AuditEventId[];
    }
  | {
      readonly kind: 'clarify';
      readonly question: string;
      readonly problems: readonly string[];
    }
  | {
      readonly kind: 'denied';
      readonly proposalId: ProposalId;
      readonly reasons: readonly ReasonCode[];
      readonly ruleId: string;
      readonly text: string;
      readonly auditEventIds: readonly AuditEventId[];
    }
  | {
      /** T-168 (b): the offers really differ; the asker picks. Nothing held or bought. */
      readonly kind: 'ticket_options';
      readonly planId: string;
      readonly text: string;
      readonly card: OptionsCard;
    }
  | { readonly kind: 'duplicate'; readonly bookingId: string; readonly text: string }
  | { readonly kind: 'pending_exists'; readonly proposalId: ProposalId; readonly text: string }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'not_found'
        | 'sold_out'
        | 'redirect_only'
        | 'provider_unavailable'
        | 'unsupported_kind'
        | 'no_trip'
        | 'already_picked';
      readonly text: string;
    };

export interface ProposalService {
  propose(input: ProposeInput, ctx: ProposeContext): Promise<ProposeResult>;
  /**
   * Re-quote an existing proposal for a new attendee list (roster change,
   * "not me"): same event, same night, same requester; a fresh hold, key,
   * decision and grant. The caller has already superseded `previous` and
   * released its hold.
   */
  repropose(
    previous: BookingProposal,
    attendees: readonly MemberId[],
    sourceMessageId: MessageId,
  ): Promise<ProposeResult>;
  /** Release the provider hold of a proposal that will not be bought (decline, cancel, expiry). */
  releaseHold(proposal: BookingProposal): Promise<void>;
  /** T-168 (b): a ticket options card this service posted, by its card id. */
  ticketChoice(planId: string): TicketChoicePlan | undefined;
  /** T-168 (b): the newest ticket options card in the group. */
  latestTicketChoice(groupId: GroupId): TicketChoicePlan | undefined;
  /**
   * T-168 (b): option `index` of ticket options card `planId`, picked by
   * `pickedBy`. The asker's own pick on a live card is the `pick` ask (the
   * policy may buy on it); anyone else's, or a stale card, is the ordinary
   * card. A second pick on a picked card proposes nothing.
   */
  pickTicketOption(
    planId: string,
    index: number,
    pick: {
      readonly groupId: GroupId;
      readonly pickedBy: MemberId;
      readonly sourceMessageId: MessageId;
    },
  ): Promise<ProposeResult>;
}

/** The three VOICE §6.2 actions on a proposal card. A bare "ok" is never an alias. */
export const PROPOSAL_ACTIONS: readonly Action[] = [
  {
    id: 'approve',
    label: 'Approve',
    style: 'primary',
    tapback: '👍',
    textAliases: APPROVE_TEXT_ALIASES,
  },
  {
    id: 'not_me',
    label: 'Not me',
    style: 'secondary',
    textAliases: NOT_ME_TEXT_ALIASES,
  },
  {
    id: 'decline',
    label: 'Decline',
    style: 'destructive',
    tapback: '👎',
    textAliases: DECLINE_TEXT_ALIASES,
  },
];

/**
 * The group message that carries a proposal card: the pre-allocated message
 * id (already in `approval.requested`), the three actions, @mentions only for
 * approvers other than the requester (VOICE §3.5), and the hold expiry.
 */
export function proposalMessage(
  res: Extract<ProposeResult, { kind: 'proposal' }>,
  groupId: GroupId,
): OutboundMessage {
  const me = res.proposal.requestedBy;
  const mentions = res.decision.requiredApprovers.includes(me)
    ? []
    : res.decision.requiredApprovers.filter((id) => id !== me);
  const expiresAt = proposalExpiresAt(res.decision, res.proposal);
  return {
    id: res.messageId,
    groupId,
    to: { kind: 'group' },
    text: res.text,
    card: res.card,
    actions: PROPOSAL_ACTIONS,
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/** The scheduler job id for a proposal's 15-minute expiry (replace-by-jobId keeps one per proposal). */
export function expiryJobId(proposalId: ProposalId): string {
  return `proposal_expiry:${proposalId}`;
}

/**
 * When a proposal stops being bookable: the shorter of the grant's expiry
 * (`decision.expiresAt`, the policy TTL) and the provider hold
 * (`holdExpiresAt`), VOICE §6.4 "15 minutes, or the provider's hold, if
 * shorter". The expiry job, the card's `holdExpiresAt` and the "price held
 * for N min" line all use this one value.
 */
export function proposalExpiresAt(
  decision: Pick<PolicyDecision, 'expiresAt'>,
  proposal: Pick<BookingProposal, 'holdExpiresAt'>,
): IsoDateTime | undefined {
  const grant = decision.expiresAt ?? undefined;
  const hold = proposal.holdExpiresAt;
  if (grant === undefined) return hold;
  if (hold === undefined) return grant;
  return parseIso(hold) < parseIso(grant) ? hold : grant;
}

const NIGHT_ROLLOVER_HOUR = 5;

/** The calendar date whose night an instant belongs to (2am sunday ⇒ saturday). */
export function nightOf(iso: IsoDateTime, tz: string): IsoDate {
  const date = localDate(iso, tz);
  if (localHour(iso, tz) >= NIGHT_ROLLOVER_HOUR) return date;
  const ms = parseIso(iso) - 24 * 60 * 60 * 1000;
  return localDate(formatIso(ms, zoneOffsetMinutes(ms, tz)), tz);
}

function activeMembers(members: readonly Member[]): Member[] {
  return members.filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest');
}

function names(ids: readonly MemberId[], byId: ReadonlyMap<MemberId, Member>): string {
  return ids.map((id) => sanitizeInline(byId.get(id)?.displayName ?? id, 40)).join(', ');
}

/**
 * The "who's in?" roster question (VOICE §4.11). `ids` is who Trav has as
 * going, never anyone the member excluded (T-158); nobody left ⇒ just ask.
 */
function whoIsInQuestion(ids: readonly MemberId[], byId: ReadonlyMap<MemberId, Member>): string {
  return ids.length === 0
    ? "who's in? tell me who's going"
    : `who's in? i've got ${names(ids, byId)}. 👍 if that's right, or tell me who to swap`;
}

function inOrder(ids: Iterable<MemberId>, order: readonly MemberId[]): MemberId[] {
  const set = new Set(ids);
  return order.filter((id) => set.has(id));
}

/** "Razzmatazz: Saturday club night" → "razzmatazz". */
export function shortEventName(name: string): string {
  const head = name.split(/[:·|]/)[0] ?? name;
  return sanitizeInline(head, 40).toLowerCase();
}

/**
 * What Trav calls a booking in a one-line status ("razzmatazz", "flights to
 * BCN"): a flight set keeps its airport code upper case (T-074), everything
 * else is the event's short lowercase name.
 */
export function bookingHeadline(p: {
  readonly kind?: BookingProposal['kind'] | undefined;
  readonly description: string;
}): string {
  return p.kind === 'flight' ? sanitizeInline(p.description, 60) : shortEventName(p.description);
}

function tripStartIso(trip: Trip): IsoDateTime {
  const ms = zonedWallTimeToMs(trip.startDate, 0, 0, trip.timeZone);
  return formatIso(ms, zoneOffsetMinutes(ms, trip.timeZone));
}

function offerTotal(offer: TicketOffer, quantity: number): Money {
  return money(
    (offer.unitPrice.amountMinor + offer.unitFees.amountMinor) * quantity,
    offer.unitPrice.currency,
  );
}

/**
 * Refundable as of `now`: a refund window that has already closed is not a
 * refund (SAFETY C5). "refundable until last night 6pm" is non-refundable.
 */
export function refundableNow(offer: Pick<TicketOffer, 'refundPolicy'>, now: IsoDateTime): boolean {
  const p = offer.refundPolicy;
  if (!p.refundable) return false;
  return p.refundableUntil === undefined || parseIso(p.refundableUntil) > parseIso(now);
}

export function rankOffers(
  offers: readonly TicketOffer[],
  quantity: number,
  now: IsoDateTime,
): TicketOffer[] {
  return offers
    .filter(
      (o) =>
        o.purchaseMode === 'api' &&
        o.available >= quantity &&
        o.maxPerOrder >= quantity &&
        o.unitPrice.amountMinor + o.unitFees.amountMinor > 0,
    )
    .sort((a, b) => {
      const ra = refundableNow(a, now);
      const rb = refundableNow(b, now);
      if (ra !== rb) return ra ? -1 : 1;
      return offerTotal(a, quantity).amountMinor - offerTotal(b, quantity).amountMinor;
    });
}

const QUERY_NOISE = new Set(['tickets', 'ticket', 'tix', 'the', 'for', 'and', 'get', 'with']);

/** The words of a query that can name one venue (3+ letters, no noise, no category words). */
function distinctiveWords(query: string): string[] {
  return [
    ...new Set(
      foldText(query)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3 && !QUERY_NOISE.has(w) && !CATEGORY_WORDS.has(w)),
    ),
  ];
}

/** What a category word asks "which …" about ("club tickets" ⇒ "club", "football" ⇒ "match"). */
const CATEGORY_NOUN: Readonly<Record<string, string>> = {
  club: 'club',
  clubbing: 'club',
  techno: 'club',
  party: 'party',
  show: 'show',
  park: 'park',
  match: 'match',
  game: 'game',
  football: 'match',
  soccer: 'match',
  futbol: 'match',
  tour: 'tour',
  museum: 'museum',
  concert: 'concert',
  gig: 'gig',
  beach: 'beach',
  boat: 'boat',
};

/**
 * A query that names no venue, only a kind of thing ("club tickets", "a
 * match tonight"): the noun to ask "which …" with ("one" for "night"),
 * else undefined (T-143).
 */
export function categoryOnly(query: string | undefined): string | undefined {
  if (query === undefined || distinctiveWords(query).length > 0) return undefined;
  const hit = foldText(query)
    .split(/[^a-z0-9]+/)
    .find((w) => CATEGORY_WORDS.has(w));
  return hit === undefined ? undefined : (CATEGORY_NOUN[hit] ?? 'one');
}

/**
 * Of `items`, the ones whose text (`hay`) carries the most distinctive query
 * words ("riverside" beats "night"). Category words ("club", "night") don't
 * score. Nothing scores (the provider matched an alias like "barça") ⇒
 * every item stays.
 */
export function bestMatchesBy<T>(
  items: readonly T[],
  query: string | undefined,
  hay: (item: T) => string,
): T[] {
  if (query === undefined) return [...items];
  const words = distinctiveWords(query);
  if (words.length === 0) return [...items];
  const score = (e: T): number => {
    const h = foldText(hay(e));
    return words.filter((w) => h.includes(w)).length;
  };
  const best = Math.max(0, ...items.map(score));
  return best === 0 ? [...items] : items.filter((e) => score(e) === best);
}

/** Of the events the provider matched, the best matches by name and venue (`bestMatchesBy`). */
export function bestMatches(
  events: readonly TicketEvent[],
  query: string | undefined,
): TicketEvent[] {
  return bestMatchesBy(events, query, (e) => `${e.name} ${e.venue.name}`);
}

/** An event a family group never sees named or priced (VOICE §8, SAFETY §2.7): 18+ or restricted content. */
export function adultsOnlyEvent(e: Pick<TicketEvent, 'minimumAge' | 'contentFlags'>): boolean {
  return (e.minimumAge ?? 0) >= 18 || safety.isRestrictedContent(e.contentFlags);
}

/** "club" ⇒ "clubs", "match" ⇒ "matches", "one" ⇒ "that" (T-143 r1 #5). */
export function categoryPlural(noun: string): string {
  if (noun === 'one') return 'that';
  if (noun === 'party') return 'parties';
  return /(?:ch|sh|s|x)$/.test(noun) ? `${noun}es` : `${noun}s`;
}

/**
 * What an "it's not on that night" line calls the ask (T-143 r1 #2, #5): a
 * category ask in the plural ("clubs"), else the first event's short name.
 * A family group never hears an adults-only name or a nightlife word: the
 * first all-ages event, else "that".
 */
export function askedThing(
  noun: string | undefined,
  events: readonly { readonly name: string; readonly adultsOnly: boolean }[],
  familyMode: boolean,
): string {
  if (noun !== undefined) {
    return familyMode && safety.isRestrictedText(noun) ? 'that' : categoryPlural(noun);
  }
  const first = events.find((e) => !familyMode || !e.adultsOnly);
  return first === undefined ? 'that' : shortEventName(first.name);
}

/** Minutes after local midnight of an instant (T-143). */
export function minuteOfDay(iso: IsoDateTime, tz: string): number {
  const ms = parseIso(iso);
  const local = Math.floor((ms + zoneOffsetMinutes(ms, tz) * 60_000) / 60_000);
  return ((local % 1440) + 1440) % 1440;
}

/** How far (minutes, round the clock) a start is from the nearest reading of the asked time. */
export function minutesOff(asked: readonly number[], minute: number): number {
  return Math.min(
    ...asked.map((a) => {
      const d = Math.abs(a - minute);
      return Math.min(d, 1440 - d);
    }),
  );
}

/** A start within this many minutes of the asked time is the slot they meant. */
export const TIME_SLACK_MINUTES = 60;

/** A slot Trav could book instead (T-143): its short name, night, start and per-person price. */
export interface SlotOption {
  readonly name: string;
  readonly night: IsoDate;
  readonly startsAt: IsoDateTime;
  /** VOICE §3.9 `formatTime` relative to now ("tonight 12am", "fri mar 13 10am"). */
  readonly when: string;
  /** Minutes after local midnight, for the asked-time order. */
  readonly minute: number;
  readonly each: Money;
  readonly refundable: boolean;
}

/** Closest night to the asked one, then nearest the asked time, then earliest. */
export function rankSlots(
  slots: readonly SlotOption[],
  night: IsoDate,
  asked: readonly number[],
): SlotOption[] {
  return [...slots].sort(
    (a, b) =>
      Math.abs(daysBetween(night, a.night)) - Math.abs(daysBetween(night, b.night)) ||
      (asked.length > 0 ? minutesOff(asked, a.minute) - minutesOff(asked, b.minute) : 0) ||
      parseIso(a.startsAt) - parseIso(b.startsAt),
  );
}

const slotPrice = (s: SlotOption): string =>
  `${formatMoney(s.each)} each · ${s.refundable ? 'refundable' : 'non-refundable'}`;

/**
 * VOICE §4.10 B, read-only (T-143): nothing for `what` `on` the asked night,
 * then the closest slot Trav could book with its price and what to say next.
 * A category ask (`named: false`) names the venue, and lists two when the
 * closest night has more than one. Undefined when `ranked` is empty. Nothing
 * is held.
 */
export function closestSlotText(input: {
  readonly what: string;
  readonly on: string;
  readonly named: boolean;
  readonly ranked: readonly SlotOption[];
}): string | undefined {
  const first = input.ranked[0];
  if (first === undefined) return undefined;
  const head = `nothing for ${input.what} ${input.on} that i can book`;
  const seen = new Set<string>();
  const sameNight = input.named
    ? [first]
    : input.ranked.filter((s) => {
        if (s.night !== first.night || seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
      });
  if (sameNight.length === 1) {
    const which = input.named ? '' : `${first.name}, `;
    return `${head}. no charge\nclosest is ${which}${first.when}, ${slotPrice(first)}. @ me if you want those instead`;
  }
  // Two options plus the head and the ask fit the 4-line reply (VOICE §3.1, §3.3).
  const shown = sameNight.slice(0, 2);
  const more = sameNight.length - shown.length;
  return [
    `${head}, no charge. closest:`,
    ...shown.map((s) => `${s.name} · ${s.when} · ${slotPrice(s)}`),
    `@ me with the one you want${more > 0 ? ` (+${String(more)} more that night)` : ''}`,
  ].join('\n');
}

/** "on saturday" / "tonight" / "tomorrow" (+ " at 3pm" when a time was asked) for the asked night. */
export function onNight(night: IsoDate, tonight: IsoDate, time?: string): string {
  const label = nightLabel(night, tonight);
  const on = label === 'tonight' || label === 'tomorrow' ? label : `on ${label}`;
  return time === undefined ? on : `${on} at ${time}`;
}

/** "tonight", "tomorrow", a weekday within the week ("saturday"), else "sat mar 14" (VOICE §3.9). */
export function nightLabel(night: IsoDate, tonight: IsoDate): string {
  if (night === tonight) return 'tonight';
  if (night === addDays(tonight, 1)) return 'tomorrow';
  const ahead = daysBetween(tonight, night);
  if (ahead > 1 && ahead < 7) return weekdayName(night);
  const [, m, d] = night.split('-').map(Number) as [number, number, number];
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][
    m - 1
  ];
  return `${weekdayName(night).slice(0, 3)} ${mon ?? ''} ${String(d)}`;
}

/** Events priced for the closest-slot line: never more than this many offer lookups. */
const MAX_SLOT_LOOKUPS = 8;

/**
 * VOICE §4.10 B for a night (or a time) with nothing on: says so, then the
 * closest slot Trav can book for `quantity` (refundable first, like
 * `rankOffers`), never a sold-out or site-only one (T-081 r1 #5), nor an
 * adults-only one in a family group (VOICE §8, T-143). No hold.
 */
async function otherNightText(input: {
  readonly tickets: TicketsAdapter;
  readonly upcoming: readonly TicketEvent[];
  readonly night: IsoDate;
  readonly now: IsoDateTime;
  readonly tz: string;
  readonly quantity: number;
  readonly familyMode: boolean;
  readonly query: string | undefined;
  readonly time?: string;
}): Promise<string> {
  const { tickets, night, now, tz, quantity, familyMode } = input;
  const noun = categoryOnly(input.query);
  const asked = input.time === undefined ? [] : askedMinutes(input.time);
  const what = askedThing(
    noun,
    input.upcoming.map((e) => ({ name: e.name, adultsOnly: adultsOnlyEvent(e) })),
    familyMode,
  );
  const on = onNight(night, nightOf(now, tz), input.time);
  const byNight = input.upcoming
    .filter((e) => !familyMode || !adultsOnlyEvent(e))
    .sort(
      (a, b) =>
        Math.abs(daysBetween(night, nightOf(a.startsAt, tz))) -
          Math.abs(daysBetween(night, nightOf(b.startsAt, tz))) ||
        parseIso(a.startsAt) - parseIso(b.startsAt),
    );
  const slots: SlotOption[] = [];
  for (const e of byNight.slice(0, MAX_SLOT_LOOKUPS)) {
    const res = await tickets.getOffers(e.eventId, quantity);
    if (!res.ok) continue;
    const best = rankOffers(res.value, quantity, now)[0];
    if (best === undefined) continue;
    slots.push({
      name: shortEventName(e.name),
      night: nightOf(e.startsAt, tz),
      startsAt: e.startsAt,
      when: formatTime(e.startsAt, tz, now),
      minute: minuteOfDay(e.startsAt, tz),
      each: money(best.unitPrice.amountMinor + best.unitFees.amountMinor, best.unitPrice.currency),
      refundable: refundableNow(best, now),
    });
  }
  const ranked = rankSlots(slots, night, asked);
  return (
    closestSlotText({ what, on, named: noun === undefined, ranked }) ??
    `nothing for ${what} ${on} that i can book, and no other night has ${quantity === 1 ? 'a ticket' : `${quantity} tickets`} i can book either. no charge`
  );
}

/** A bare https URL safe to post on its own line (VOICE §3.8); anything else ⇒ undefined. */
function safeCheckoutUrl(url: string | undefined): string | undefined {
  if (url === undefined || url.length > 200) return undefined;
  return /^https:\/\/[a-z0-9.-]+(?:\/[\w\-.~/?&=%]*)?$/i.test(url) ? url : undefined;
}

/**
 * An offer Trav can't buy (`redirect_only`): says so, the price and refund
 * terms, and the venue's checkout link on its own last line (VOICE §3.8).
 * Nothing is held or charged.
 */
function redirectText(event: TicketEvent, offer: TicketOffer, now: IsoDateTime): string {
  const each = formatMoney(
    money(offer.unitPrice.amountMinor + offer.unitFees.amountMinor, offer.unitPrice.currency),
  );
  const lines = [
    `${shortEventName(event.name)} only sells on its own site, so i can't buy it for you`,
    `${each} each · ${refundableNow(offer, now) ? 'refundable' : 'non-refundable'}`,
  ];
  const url = safeCheckoutUrl(offer.checkoutUrl);
  if (url !== undefined) lines.push(url);
  return lines.join('\n');
}

/**
 * Each payer's share (integer minor units, Σ = total): an equal split over
 * the attendees, then each share moved to its carrier (`payersFor`): a
 * minor's to their guardian, everything to one adult on a family tab.
 */
export function payerShares(
  attendees: readonly MemberId[],
  totalMinor: number,
  currency: Money['currency'],
  rule: PayerRule,
): { memberId: MemberId; shareMinor: number }[] {
  const shares = allocateEqual(money(totalMinor, currency), attendees.length);
  const carriers = payersFor(attendees, rule);
  const byCarrier = new Map<MemberId, number>(carriers.map((id) => [id, 0]));
  attendees.forEach((id, i) => {
    const to = carrierOf(id, carriers, rule);
    byCarrier.set(to, (byCarrier.get(to) ?? 0) + shares[i]!.amountMinor);
  });
  return carriers.map((memberId) => ({ memberId, shareMinor: byCarrier.get(memberId) ?? 0 }));
}

export function createProposalService(deps: ProposalDeps): ProposalService {
  const { stores, tickets, clock, ids } = deps;
  const group = stores.group;
  const choices = deps.ticketChoices ?? createTicketChoiceStore();

  async function releaseHold(proposal: BookingProposal): Promise<void> {
    if (proposal.kind !== 'ticket' || proposal.quoteRef.length === 0) return;
    await tickets.releaseHold(proposal.quoteRef);
  }

  async function propose(input: ProposeInput, ctx: ProposeContext): Promise<ProposeResult> {
    const now = clock.now();
    const grp = group.groups.get(ctx.groupId);
    if (grp === undefined) throw new TravError('not_found', `group ${ctx.groupId} not found`);
    const trip =
      ctx.tripId === null ? group.trips.current(ctx.groupId, now) : group.trips.get(ctx.tripId);
    if (trip === undefined) {
      return {
        kind: 'unavailable',
        reason: 'no_trip',
        text: "there's no trip set up for this group yet, so nothing to book against",
      };
    }
    if (input.kind === 'lodging' && deps.lodging !== undefined) {
      return proposeLodging(deps.lodging, input, ctx, grp, trip, now);
    }
    if (input.kind === 'flight' && deps.flights !== undefined && deps.flightPlans !== undefined) {
      return proposeFlights({
        deps: { flights: deps.flights, plans: deps.flightPlans, ids, stores },
        input,
        ctx,
        grp,
        trip,
        now,
        record: recordProposal,
      });
    }
    if (input.kind !== 'ticket') {
      return {
        kind: 'unavailable',
        reason: 'unsupported_kind',
        text: `i can't book ${input.kind === 'flight' ? 'flights' : input.kind === 'lodging' ? 'places to stay' : 'that'} from the chat yet. i can search and post options`,
      };
    }

    const members = group.members.listByGroup(ctx.groupId);
    const active = activeMembers(members);
    const order = active.map((m) => m.memberId);
    const byId = new Map(members.map((m) => [m.memberId, m] as const));
    const tz = trip.timeZone;
    const familyMode = safety.isFamilyMode(grp, members, now);

    // ---- 1. the event ----
    const searched = await tickets.searchEvents({
      city: trip.city,
      dateFrom: localDate(now, tz),
      dateTo: trip.endDate,
      ...(input.query !== undefined ? { query: input.query } : {}),
    });
    if (!searched.ok) {
      return {
        kind: 'unavailable',
        reason: 'provider_unavailable',
        text: "ticket site's not responding. no charge went through\n@ me again in a few",
      };
    }
    // The provider already matched `query` against names, venues and its own
    // aliases ("razz", "barça"); a second name-only filter here would drop
    // what its keywords found.
    // Then the events that match the most distinctive query words win, before
    // any same-night preference: "riverside club night" is the club, not the
    // fado night that happens to be tonight.
    const upcoming = bestMatches(
      searched.value
        .filter((e) => parseIso(e.startsAt) > parseIso(now))
        .sort((a, b) => parseIso(a.startsAt) - parseIso(b.startsAt)),
      input.query,
    );
    let candidates = upcoming;
    const tonight = nightOf(now, tz);
    const namedNight =
      input.date ?? (input.day !== undefined ? resolveNight(input.day, tonight, trip) : undefined);
    const asked = input.time === undefined ? [] : askedMinutes(input.time);
    const time = asked.length > 0 ? input.time : undefined;
    const elsewhere = async (night: IsoDate): Promise<ProposeResult> => ({
      kind: 'unavailable',
      reason: 'not_found',
      text: await otherNightText({
        tickets,
        upcoming,
        night,
        now,
        tz,
        // Enough for the party as asked; unsaid ⇒ everyone active, never just 1.
        quantity:
          input.quantity ??
          input.attendeeNames?.length ??
          input.attendeeMemberIds?.length ??
          Math.max(1, active.length - (input.excludedNames?.length ?? 0)),
        familyMode,
        query: input.query,
        ...(time !== undefined ? { time } : {}),
      }),
    });
    if (input.eventId !== undefined) {
      candidates = searched.value.filter((e) => e.eventId === input.eventId);
    } else {
      const wanted = namedNight ?? tonight;
      const sameNight = upcoming.filter((e) => nightOf(e.startsAt, tz) === wanted);
      if (sameNight.length > 0) {
        candidates = sameNight;
        if (asked.length > 0) {
          // A time was asked (T-143 r1 #3): only a start within the hour is
          // that slot. Otherwise say so and name the closest. No hold.
          const near = sameNight.filter(
            (e) => minutesOff(asked, minuteOfDay(e.startsAt, tz)) <= TIME_SLACK_MINUTES,
          );
          if (near.length === 0) return await elsewhere(wanted);
          candidates = near;
        }
      } else if (namedNight !== undefined && upcoming.length > 0) {
        // The member named a night and there is nothing then (T-081): say so
        // and name the closest one. No hold, no proposal for a night nobody asked for.
        return await elsewhere(namedNight);
      }
    }
    candidates = [...candidates].sort(
      (a, b) =>
        (asked.length > 0
          ? minutesOff(asked, minuteOfDay(a.startsAt, tz)) -
            minutesOff(asked, minuteOfDay(b.startsAt, tz))
          : 0) || parseIso(a.startsAt) - parseIso(b.startsAt),
    );
    const event = candidates[0];
    const noun = input.eventId === undefined ? categoryOnly(input.query) : undefined;
    if (event === undefined && noun !== undefined) {
      // "club tickets tonight" names no place and nothing like it is on sale
      // (T-143, VOICE §4.11): one question, which place and who's in. No
      // hold. A family group's question names no nightlife (VOICE §8) and
      // asks no headcount for it.
      const said = familyMode && safety.isRestrictedText(noun) ? 'one' : noun;
      const thing = said === 'one' ? 'one' : `a ${said}`;
      const night = namedNight ?? tonight;
      const when = onNight(night, tonight);
      return {
        kind: 'clarify',
        question: familyMode
          ? `i can't see ${thing} i can book ${when}\nwhich ${said} did you mean?`
          : `i can't see ${thing} i can book ${when}\nwhich ${said} did you mean, and ${whoIsInThat(group, trip, night, order, byId, /\b(?:club|clubs|bar|bars|party|nightlife|rave|disco)\b/.test(noun) ? 'nightlife' : undefined)}`,
        problems: ['unnamed_venue'],
      };
    }
    if (event === undefined) {
      const what =
        input.query === undefined ? 'that' : sanitizeInline(input.query, 40).toLowerCase();
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: `nothing for ${what} on sale for the trip dates. tell me another night or another place`,
      };
    }
    // A generic ask ("club tickets") that fits two venues that night: ask, never pick one.
    if (input.eventId === undefined && input.query !== undefined && input.day !== undefined) {
      const thatNight = candidates.filter(
        (e) => nightOf(e.startsAt, tz) === nightOf(event.startsAt, tz),
      );
      const venuesOf = (evs: readonly TicketEvent[]): string[] => [
        ...new Set(evs.map((e) => sanitizeInline(e.venue.name, 40))),
      ];
      // A family group never sees an adults-only venue named (VOICE §8, T-143).
      const venues = venuesOf(
        familyMode ? thatNight.filter((e) => !adultsOnlyEvent(e)) : thatNight,
      );
      if (venues.length <= 1 && venuesOf(thatNight).length > 1) {
        return {
          kind: 'clarify',
          question: "which one did you mean? name it and i'll check",
          problems: ['ambiguous_venue'],
        };
      }
      if (venues.length > 1) {
        const list = `${venues.slice(0, -1).join(', ')} or ${venues[venues.length - 1]!}`;
        return {
          kind: 'clarify',
          question: `which one, ${list}? ${venues.length === 2 ? 'both have' : 'they all have'} tickets ${nightLabel(nightOf(event.startsAt, tz), tonight)}`,
          problems: ['ambiguous_venue'],
        };
      }
    }

    // ---- 2. who is in ----
    const activity = findActivity(group, trip, event, input.activityId);
    const rosterRows = activity === null ? [] : group.trips.listAttendance(activity.activityId);
    const markedOut = new Set(rosterRows.filter((r) => r.status !== 'in').map((r) => r.memberId));
    // Members who already hold a confirmed ticket for this activity: a new
    // proposal is then an add-on for the others (T-030 late joiner) and must
    // neither re-buy for them nor write their roster rows.
    const booked =
      activity === null ? new Set<MemberId>() : bookedAttendees(group, trip, activity.activityId);
    const addOn =
      input.rosterMode === 'add_on' || (input.rosterMode === undefined && booked.size > 0);
    const base = (
      rosterRows.length > 0
        ? inOrder(
            rosterRows.filter((r) => r.status === 'in').map((r) => r.memberId),
            order,
          )
        : order
    ).filter((id) => !addOn || !booked.has(id));

    // One reading of who's in, shared with the lodging and flight paths: every
    // name is resolved before any question, and a "who's in?" lists only who
    // Trav has as going, never anyone the member just excluded (T-158).
    const party = resolveParty({ input, active, byId, order, base, markedOut });
    if (party.kind === 'clarify') return party;
    const attendees = party.attendees;
    if (addOn) {
      const twice = attendees.filter((id) => booked.has(id));
      if (twice.length > 0) {
        const rest = attendees.filter((id) => !booked.has(id));
        return {
          kind: 'clarify',
          question:
            rest.length > 0
              ? `${names(twice, byId)} already ${twice.length === 1 ? 'has' : 'have'} a ticket for that one. just ${names(rest, byId)}?`
              : `${names(twice, byId)} already ${twice.length === 1 ? 'has' : 'have'} a ticket for that one. who else is coming?`,
          problems: twice.map((id) => `already_booked:${sanitizeInline(id, 40)}`),
        };
      }
    }
    const outIds = addOn ? [] : order.filter((id) => !attendees.includes(id));
    const quantity = attendees.length;

    // An age-limited or adults-only plan with someone under 18 on it is a
    // no before anything is priced or held (T-143 follow-up; the same rule
    // `checkProposalConsistency` applies after the hold, SAFETY §2.7).
    const restrictedPlan =
      event.minimumAge !== undefined ||
      safety.isRestrictedContent(event.contentFlags) ||
      (activity !== null &&
        (activity.kind === 'nightlife' ||
          activity.ageRestriction !== null ||
          safety.isRestrictedContent(activity.contentTags)));
    if (
      restrictedPlan &&
      attendees.some((id) => {
        const m = byId.get(id);
        return m !== undefined && safety.isMinor(m, now);
      })
    ) {
      // The roster still reads as asked, with the minor kept off (T-153), as it did after the hold.
      if (activity !== null) syncRoster(group, activity, attendees, outIds, ctx, now);
      return {
        kind: 'clarify',
        question: ageLimitText(event.minimumAge ?? activity?.ageRestriction ?? null),
        problems: ['minor_on_restricted'],
      };
    }

    // ---- 3. the offer and the hold ----
    const soldOut = (): string => soldOutText(event, searched.value, tz, quantity, now, familyMode);
    const offersRes = await tickets.getOffers(event.eventId, quantity);
    if (!offersRes.ok) {
      return {
        kind: 'unavailable',
        reason: offersRes.error.code === 'sold_out' ? 'sold_out' : 'provider_unavailable',
        text: soldOut(),
      };
    }
    const ranked = rankOffers(offersRes.value, quantity, now);
    // A seat tier the member asked for ("sideline", "vip") narrows the offers; none ⇒ say so.
    const tierWords = (input.tier ?? []).map((w) => foldText(w)).filter((w) => w.length > 0);
    const tierAsked = input.offerId === undefined && tierWords.length > 0;
    const tiered = tierAsked
      ? ranked.filter((o) => tierWords.some((w) => foldText(o.tierName).includes(w)))
      : ranked;
    if (tierAsked && tiered.length === 0 && ranked.length > 0) {
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: `no ${sanitizeInline(tierWords.join(' '), 40)} tickets for ${shortEventName(event.name)} ${whenText(event.startsAt, tz, now)} that i can book. no charge\n@ me without that and i'll price the regular ones`,
      };
    }
    // T-168 (b): offers that really differ, none the refundable default (a
    // Barça match's seat sections): the asker picks. Never on a re-quote, an
    // add-on, a pick, or when a tier or offer was already named.
    const choice =
      input.offerId === undefined &&
      !tierAsked &&
      !addOn &&
      ctx.requireConfirmation !== true &&
      ctx.pick === undefined
        ? choiceOffers(ranked, (o) => refundableNow(o, now))
        : undefined;
    if (choice !== undefined) {
      return ticketOptions({ choice, event, trip, grp, ctx, members, attendees, outIds, now });
    }
    const offer =
      input.offerId === undefined ? tiered[0] : ranked.find((o) => o.offerId === input.offerId);
    if (offer === undefined) {
      const redirect = offersRes.value.find((o) => o.purchaseMode === 'redirect_only');
      return {
        kind: 'unavailable',
        reason: redirect !== undefined ? 'redirect_only' : 'sold_out',
        text: redirect !== undefined ? redirectText(event, redirect, now) : soldOut(),
      };
    }

    const keyInput = {
      groupId: ctx.groupId,
      tripId: trip.tripId,
      kind: 'ticket' as const,
      provider: tickets.info.provider,
      itemRef: offer.offerId,
      eventDate: nightOf(event.startsAt, tz),
      payerIds: attendees,
      currency: offer.unitPrice.currency,
    };
    let totalMinor = offerTotal(offer, quantity).amountMinor;
    let key = approval.deriveIdempotencyKey({ ...keyInput, totalMinor });
    const pendingSame = group.bookings
      .listPendingProposals(ctx.groupId)
      .find((p) => p.idempotencyKey === key && p.status === 'pending');
    if (pendingSame !== undefined) {
      return {
        kind: 'pending_exists',
        proposalId: pendingSame.proposalId,
        text: "that one's already waiting for a 👍 above",
      };
    }
    const existing = group.bookings.getBookingByKey(key);
    if (existing !== undefined) {
      return {
        kind: 'duplicate',
        bookingId: existing.bookingId,
        text: `already booked: ${sanitizeInline(existing.description, 60)}, ${formatMoney(money(existing.totalMinor, existing.currency))}. say "buy it again" if you really want a second set`,
      };
    }
    const heldRes = await tickets.hold(offer.offerId, quantity, key);
    if (!heldRes.ok) {
      return {
        kind: 'unavailable',
        reason: heldRes.error.code === 'sold_out' ? 'sold_out' : 'provider_unavailable',
        text:
          heldRes.error.code === 'sold_out'
            ? soldOut()
            : "ticket site's not responding. no charge went through\n@ me again in a few",
      };
    }
    const hold: TicketHold = heldRes.value;
    if (hold.total.amountMinor !== totalMinor) {
      totalMinor = hold.total.amountMinor;
      key = approval.deriveIdempotencyKey({ ...keyInput, totalMinor });
    }

    // ---- 4. roster sync (the named subset is the roster; reasons are never stored) ----
    const act = activity ?? createActivity(group, ids, trip, event, now);
    syncRoster(group, act, attendees, outIds, ctx, now);
    const roster: Roster = {
      activityId: act.activityId,
      inMemberIds: attendees,
      outMemberIds: outIds,
      maybeMemberIds: [],
      asOf: now,
    };

    // ---- 5. the proposal ----
    // Minors are never charged (VOICE §8): their share is carried by their
    // guardian, and a family-tab trip puts the whole thing on one adult.
    const payerRule: PayerRule = {
      members,
      now,
      familyTab: trip.familyTab === true,
      requestedBy: ctx.requestedBy,
    };
    const payers = payerShares(attendees, totalMinor, offer.unitPrice.currency, payerRule);
    // An expired refund window is no refund (SAFETY C5 fires on it).
    const refundable = refundableNow(offer, now);
    const proposal: BookingProposal = {
      proposalId: ids.next('prop'),
      groupId: ctx.groupId,
      tripId: trip.tripId,
      activityId: act.activityId,
      kind: 'ticket',
      provider: tickets.info.provider,
      itemRef: offer.offerId,
      tierName: sanitizeInline(offer.tierName, 40),
      description: sanitizeInline(`${event.name}`, 80),
      city: event.venue.city,
      totalMinor,
      currency: offer.unitPrice.currency,
      quotedAt: now,
      quoteRef: hold.holdId,
      holdExpiresAt: hold.expiresAt,
      payers,
      attendees,
      // A minor's own ask goes on the adult who carries it, never their card.
      paidBy: {
        kind: 'member_card',
        memberId: cardHolderFor(
          ctx.requestedBy,
          payers.map((s) => s.memberId),
          payerRule,
        ),
      },
      refundable,
      ...(refundable && offer.refundPolicy.refundableUntil !== undefined
        ? { refundDeadline: offer.refundPolicy.refundableUntil }
        : {}),
      eventDate: nightOf(event.startsAt, tz),
      ageRestriction: event.minimumAge ?? null,
      contentTags: event.contentFlags,
      requestedBy: ctx.requestedBy,
      requestedAt: now,
      sourceMessageId: ctx.sourceMessageId,
      idempotencyKey: key,
      status: 'pending',
    };

    // T-168: what the policy may buy on without a card (D-044).
    const ask = ticketAsk({
      ctx,
      input,
      event,
      tz,
      tonight,
      trip,
      attendees,
      byId,
      offerId: offer.offerId,
      totalMinor,
      addOn,
      tierAsked,
      now,
    });
    const recorded = await recordProposal({
      proposal,
      trip,
      grp,
      ctx,
      members,
      activity: act,
      roster,
      now,
      ...(ask !== undefined ? { ask } : {}),
      release: async () => {
        await tickets.releaseHold(hold.holdId);
      },
    });
    if (recorded.kind === 'done') return recorded.result;
    const { decision, grant, ruleId, messageId, auditIds } = recorded;

    const perPerson = money(Math.round(totalMinor / quantity), proposal.currency);
    const text = renderProposalText({
      proposal,
      decision,
      event,
      members,
      excluded: outIds,
      perPerson,
      now,
      tz,
      ruleId,
      capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
      ...(addOn ? { alreadyBooked: booked.size } : {}),
      // A named tier, or an option picked off the options card (T-168 b): say which seats.
      ...(tierAsked || ctx.fromOptions === true ? { tierName: offer.tierName } : {}),
      ...(trip.familyTab === true ? { familyTab: true } : {}),
    });
    const card = buildCard({
      cardId: ids.next('card'),
      proposal,
      decision,
      event,
      byId,
      excluded: outIds,
      perPerson,
      text,
      ruleId,
      capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
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
        eventId: event.eventId,
        name: sanitizeInline(event.name, 80),
        venue: sanitizeInline(event.venue.name, 80),
        startsAt: event.startsAt,
      },
      attendees,
      excluded: outIds,
    };
  }

  /**
   * A place to stay (T-132, VOICE §4.1 C): the rate the model picked from
   * `search_lodging`, re-checked with the provider so the card shows the live
   * price → who's staying (everyone active unless named; a member marked out
   * of the stay stays out) → the trip's lodging plan for that property, or a
   * new one → `recordProposal` like every other kind. Lodging has no provider
   * hold: the executor re-checks the rate again before any money moves, and a
   * changed price re-quotes (T-009). Nothing is bought here.
   */
  async function proposeLodging(
    lodging: LodgingAdapter,
    input: ProposeInput,
    ctx: ProposeContext,
    grp: { readonly spendingPolicy: GroupSpendingPolicy },
    trip: Trip,
    now: IsoDateTime,
  ): Promise<ProposeResult> {
    const rateId = input.itemRef ?? input.offerId;
    if (rateId === undefined) {
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: "which place? tell me the area and budget and i'll look. nothing's booked",
      };
    }
    const members = group.members.listByGroup(ctx.groupId);
    const active = activeMembers(members);
    const order = active.map((m) => m.memberId);
    const byId = new Map(members.map((m) => [m.memberId, m] as const));
    const tz = trip.timeZone;
    const checkIn = trip.startDate;
    const checkOut = trip.endDate;

    // ---- 1. the live rate (a re-price is quoted as is, never the old number) ----
    let rechecked = await lodging.recheckRate(rateId);
    if (!rechecked.ok && rechecked.error.code === 'price_changed') {
      rechecked = await lodging.recheckRate(rateId);
    }
    if (!rechecked.ok) {
      const code = rechecked.error.code;
      return {
        kind: 'unavailable',
        reason:
          code === 'not_found'
            ? 'not_found'
            : code === 'sold_out'
              ? 'sold_out'
              : 'provider_unavailable',
        text:
          code === 'not_found' || code === 'sold_out' || code === 'offer_expired'
            ? "that place isn't bookable anymore. nothing's booked, no charge\n@ me and i'll look again"
            : "the stays site isn't responding. no charge went through\n@ me again in a few",
      };
    }
    const rate = rechecked.value;
    // The budget the member said holds at the live price (T-132 r1 #1).
    if (input.maxTotalMinor !== undefined && rate.totalAmount.amountMinor > input.maxTotalMinor) {
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: `that one's ${formatMoney(rate.totalAmount)}, over the ${formatMoney(money(input.maxTotalMinor, rate.totalAmount.currency))} you said, so nothing's booked\n@ me with a bigger budget or another area`,
      };
    }

    // ---- 2. who's staying ----
    const existing = findLodgingActivity(group, trip, undefined, input.activityId);
    const rosterRows = existing === null ? [] : group.trips.listAttendance(existing.activityId);
    const markedOut = new Set(rosterRows.filter((r) => r.status !== 'in').map((r) => r.memberId));
    const base =
      rosterRows.length > 0
        ? inOrder(
            rosterRows.filter((r) => r.status === 'in').map((r) => r.memberId),
            order,
          )
        : order;
    const party = resolveParty({ input, active, byId, order, base, markedOut });
    if (party.kind === 'clarify') return party;
    const attendees = party.attendees;
    if (rate.sleeps < attendees.length) {
      return {
        kind: 'clarify',
        question: `that one sleeps ${String(rate.sleeps)} and there are ${String(attendees.length)} of you. want me to look for a bigger place?`,
        problems: ['over_capacity'],
      };
    }

    // ---- 3. the property (for its name and area) and the refundable trade-off ----
    const searched = await lodging.search({
      near: { city: trip.city },
      checkIn,
      checkOut,
      adults: attendees.length,
      // Every kind, so a hotel rate finds its hotel; the trade-off below only
      // weighs rates that sleep the whole party.
      wholeUnitForGroup: false,
    });
    const results: readonly LodgingSearchResult[] = searched.ok ? searched.value : [];
    const property = results.find((r) => r.rates.some((x) => x.rateId === rate.rateId))?.property;
    const name = sanitizeInline(property?.name ?? rate.roomName, 80);
    const refundable = refundableNow(rate, now);
    const totalMinor = rate.totalAmount.amountMinor;
    const currency = rate.totalAmount.currency;
    // The trade-off is a like-for-like stay (T-132 r1 #5): the same kind of
    // place, sleeping everyone, in the areas asked when any were.
    const areas = (input.areas ?? []).map((a) => foldText(a).trim()).filter((a) => a.length > 0);
    const fits = results
      .filter((r) => property === undefined || r.property.kind === property.kind)
      .filter((r) => {
        if (areas.length === 0) return true;
        const area = foldText(areaOf(r.property.place.address) ?? '');
        return areas.includes(area);
      })
      .map((r) => ({ ...r, rates: r.rates.filter((x) => x.sleeps >= attendees.length) }))
      .filter((r) => r.rates.length > 0);
    const cheaperLocked = refundable
      ? cheapestLockedBelow(fits, totalMinor, currency, now)
      : undefined;

    // ---- 4. nothing twice, and a lead guest the provider can book under ----
    const key = approval.deriveIdempotencyKey({
      groupId: ctx.groupId,
      tripId: trip.tripId,
      kind: 'lodging',
      provider: lodging.info.provider,
      itemRef: rate.rateId,
      eventDate: checkIn,
      payerIds: attendees,
      currency,
      totalMinor,
    });
    const pendingSame = group.bookings
      .listPendingProposals(ctx.groupId)
      .find((p) => p.idempotencyKey === key && p.status === 'pending');
    if (pendingSame !== undefined) {
      return {
        kind: 'pending_exists',
        proposalId: pendingSame.proposalId,
        text: "that one's already waiting for a 👍 above",
      };
    }
    const booked = group.bookings.getBookingByKey(key);
    if (booked !== undefined) {
      return {
        kind: 'duplicate',
        bookingId: booked.bookingId,
        text: `already booked: ${sanitizeInline(booked.description, 60)}, ${formatMoney(money(booked.totalMinor, booked.currency))}`,
      };
    }
    const payerRule: PayerRule = {
      members,
      now,
      familyTab: trip.familyTab === true,
      requestedBy: ctx.requestedBy,
    };
    const payers = payerShares(attendees, totalMinor, currency, payerRule);
    const holder = cardHolderFor(
      ctx.requestedBy,
      payers.map((s) => s.memberId),
      payerRule,
    );
    // D-037: the stay is booked under the card holder. A hotel or hostel (or a
    // property the search can't place) needs their family name, and v0 only
    // has display names: say so now, before anyone taps; never invent one.
    const wholeHome = property?.kind === 'vacation_rental' || property?.kind === 'apartment';
    if (!wholeHome && !hasFamilyName(byId.get(holder))) {
      const what =
        property?.kind === 'hotel' || property?.kind === 'hostel'
          ? `a ${property.kind}`
          : 'that place';
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: `${what} needs the lead guest's full name and i only have first names, so nothing's booked\nbook it on the site, or pick a whole-home rental and i'll post it here`,
      };
    }

    // ---- 5. the plan and who's on it (reasons are never stored) ----
    const activity =
      existing ??
      findLodgingActivity(group, trip, name, undefined) ??
      createLodgingActivity(group, ids, trip, name, property?.place.address, now);
    const outIds = order.filter((id) => !attendees.includes(id));
    syncRoster(group, activity, attendees, outIds, ctx, now);
    const roster: Roster = {
      activityId: activity.activityId,
      inMemberIds: attendees,
      outMemberIds: outIds,
      maybeMemberIds: [],
      asOf: now,
    };

    // ---- 6. the proposal ----
    const proposal: BookingProposal = {
      proposalId: ids.next('prop'),
      groupId: ctx.groupId,
      tripId: trip.tripId,
      activityId: activity.activityId,
      kind: 'lodging',
      provider: lodging.info.provider,
      itemRef: rate.rateId,
      description: name,
      ...(property !== undefined ? { city: property.place.city } : {}),
      totalMinor,
      currency,
      quotedAt: now,
      quoteRef: rate.rateId,
      ...(rate.expiresAt !== undefined ? { holdExpiresAt: rate.expiresAt } : {}),
      payers,
      attendees,
      paidBy: { kind: 'member_card', memberId: holder },
      refundable,
      ...(refundable && rate.refundPolicy.refundableUntil !== undefined
        ? { refundDeadline: rate.refundPolicy.refundableUntil }
        : {}),
      eventDate: checkIn,
      ageRestriction: null,
      contentTags: [],
      requestedBy: ctx.requestedBy,
      requestedAt: now,
      sourceMessageId: ctx.sourceMessageId,
      idempotencyKey: key,
      status: 'pending',
    };

    const recorded = await recordProposal({
      proposal,
      trip,
      grp,
      ctx,
      members,
      activity,
      roster,
      now,
      release: async () => {},
    });
    if (recorded.kind === 'done') return recorded.result;
    const { decision, grant, ruleId, messageId, auditIds } = recorded;
    const area = areaOf(property?.place.address);
    const text = renderLodgingText({
      proposal,
      decision,
      members,
      excluded: outIds,
      name,
      checkIn,
      checkOut,
      now,
      tz,
      capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
      ...(cheaperLocked !== undefined ? { cheaperLocked } : {}),
      ...(trip.familyTab === true ? { familyTab: true } : {}),
    });
    const nights = daysBetween(checkIn, checkOut);
    const card = buildLodgingCard({
      cardId: ids.next('card'),
      proposal,
      decision,
      byId,
      excluded: outIds,
      name,
      ...(area !== undefined ? { area } : {}),
      details: [
        `${String(nights)} night${nights === 1 ? '' : 's'}, ${stayDates(checkIn, checkOut)}`,
        `sleeps ${String(rate.sleeps)}`,
        ...(rate.payAtProperty !== undefined && rate.payAtProperty.amountMinor > 0
          ? [`${formatMoney(rate.payAtProperty)} paid at the property, not charged by trav`]
          : []),
      ],
      text,
      ruleId,
      capPerPersonMinor: grp.spendingPolicy.perPersonAutoCapMinor,
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
        eventId: rate.propertyId,
        name,
        venue: area ?? name,
        startsAt: tripStartIso(trip),
      },
      attendees,
      excluded: outIds,
    };
  }

  /**
   * Every proposal kind ends here (SAFETY §2.1): `checkProposalConsistency`
   * (problems ⇒ one question, the hold released) → `approval.evaluate` →
   * audit `proposal.created` → `policy.evaluated` → deny ⇒ the hold released,
   * else a grant → auto-approve, or audit `approval.requested` with the
   * pre-allocated card message id. The caller renders the card.
   */
  async function recordProposal(a: {
    readonly proposal: BookingProposal;
    readonly trip: Trip;
    readonly grp: { readonly spendingPolicy: GroupSpendingPolicy };
    readonly ctx: ProposeContext;
    readonly members: readonly Member[];
    readonly activity: Activity | null;
    readonly roster: Roster | null;
    readonly now: IsoDateTime;
    /** T-168: the ask behind it (`ticketAsk`); absent ⇒ never auto-approved. */
    readonly ask?: AskSignal;
    readonly release: () => Promise<void>;
  }): Promise<
    | { readonly kind: 'done'; readonly result: ProposeResult }
    | {
        readonly kind: 'card';
        readonly decision: PolicyDecision;
        readonly grant: ApprovalGrant;
        readonly ruleId: string;
        readonly messageId: MessageId;
        readonly auditIds: readonly AuditEventId[];
      }
  > {
    const { proposal, trip, grp, ctx, members, now } = a;
    const attendees = proposal.attendees;
    const key = proposal.idempotencyKey;
    const byId = new Map(members.map((m) => [m.memberId, m] as const));
    const consistency = approval.checkProposalConsistency(
      proposal,
      trip,
      a.activity,
      a.roster,
      members,
      now,
    );
    if (!consistency.ok) {
      await a.release();
      return {
        kind: 'done',
        result: {
          kind: 'clarify',
          question: clarifyFor(
            consistency.problems,
            attendees,
            byId,
            trip,
            proposal.ageRestriction,
          ),
          problems: consistency.problems,
        },
      };
    }

    // ---- 6. the policy ----
    const policyCtx = policyContextFor(proposal, trip, members, now, a.ask);
    const { spentTodayMinor, spentTripMinor } = policyCtx;
    const views = policyCtx.members;
    const evaluatedDecision = approval.evaluate(proposal, grp.spendingPolicy, policyCtx);
    // A re-quote or an add-on never auto-approves: stricter than the policy,
    // never looser, so the card still needs a 👍 (D-019 §3, VOICE §6.2).
    const confirmationForced =
      ctx.requireConfirmation === true && evaluatedDecision.outcome === 'auto_approve';
    const decision = confirmationForced
      ? confirmAnyway(evaluatedDecision, proposal, grp.spendingPolicy, views, now)
      : evaluatedDecision;

    const auditIds: AuditEventId[] = [];
    group.bookings.createProposal(proposal);
    auditIds.push(
      group.audit.append({
        groupId: ctx.groupId,
        tripId: trip.tripId,
        type: 'proposal.created',
        actor: { kind: 'member', id: ctx.requestedBy },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: key,
        payload: {
          kind: proposal.kind,
          provider: proposal.provider,
          itemRef: proposal.itemRef,
          totalMinor: proposal.totalMinor,
          currency: proposal.currency,
          payers: proposal.payers,
          attendees: proposal.attendees,
          refundable: proposal.refundable,
          requestedBy: proposal.requestedBy,
          sourceMessageId: proposal.sourceMessageId,
          ...(ctx.pickedBy !== undefined ? { pickedBy: ctx.pickedBy } : {}),
        },
      }).id,
    );
    const evaluated = group.audit.append({
      groupId: ctx.groupId,
      tripId: trip.tripId,
      type: 'policy.evaluated',
      actor: { kind: 'trav', id: 'trav' },
      visibility: 'group',
      proposalId: proposal.proposalId,
      idempotencyKey: key,
      payload: {
        outcome: decision.outcome,
        reasons: decision.reasons,
        ruleIds: decision.ruleIds,
        approvalMode: decision.approvalMode,
        requiredApprovers: decision.requiredApprovers,
        expiresAt: decision.expiresAt,
        policySnapshot: decision.policySnapshot,
        spentTodayMinor,
        spentTripMinor,
        // T-168: why it could skip the card (`explicit` ask, `pick`), or null.
        ask: a.ask ?? null,
        ...(confirmationForced
          ? { confirmationForced: true, policyOutcome: evaluatedDecision.outcome }
          : {}),
      },
    });
    auditIds.push(evaluated.id);
    group.bookings.saveDecision(decision, evaluated.id);

    const deciding = approval.decidingRule(decision);
    const ruleId = deciding?.ruleId ?? 'C1';

    if (decision.outcome === 'deny') {
      group.bookings.updateProposal({ ...proposal, status: 'rejected' });
      await a.release();
      if (decision.reasons.includes('duplicate') && decision.existingBookingId !== null) {
        return {
          kind: 'done',
          result: {
            kind: 'duplicate',
            bookingId: decision.existingBookingId,
            text: 'already booked that one. say "buy it again" if you really want a second set',
          },
        };
      }
      return {
        kind: 'done',
        result: {
          kind: 'denied',
          proposalId: proposal.proposalId,
          reasons: decision.reasons,
          ruleId,
          text: denyText(decision, proposal, grp.spendingPolicy.hardMaxPerBookingMinor),
          auditEventIds: auditIds,
        },
      };
    }

    const grant = approval.createGrant(decision, evaluated.id, ids, now);
    group.bookings.saveGrant(grant);

    if (decision.outcome === 'auto_approve') {
      return {
        kind: 'done',
        result: { kind: 'auto_approved', proposal, decision, grant, auditEventIds: auditIds },
      };
    }

    const messageId = ids.next('msg');
    auditIds.push(
      group.audit.append({
        groupId: ctx.groupId,
        tripId: trip.tripId,
        type: 'approval.requested',
        actor: { kind: 'trav', id: 'trav' },
        visibility: 'group',
        proposalId: proposal.proposalId,
        idempotencyKey: key,
        payload: {
          requiredApprovers: decision.requiredApprovers,
          approvalMode: decision.approvalMode,
          expiresAt: decision.expiresAt,
          cardMessageId: messageId,
        },
      }).id,
    );
    return { kind: 'card', decision, grant, ruleId, messageId, auditIds };
  }

  async function repropose(
    previous: BookingProposal,
    attendees: readonly MemberId[],
    sourceMessageId: MessageId,
  ): Promise<ProposeResult> {
    const trip = group.trips.get(previous.tripId);
    const ctx: ProposeContext = {
      groupId: previous.groupId,
      tripId: previous.tripId,
      requestedBy: previous.requestedBy,
      sourceMessageId,
      // Nobody asked for this card: it always needs a fresh 👍 (VOICE §6.2).
      requireConfirmation: true,
    };
    const input: ProposeInput = {
      kind: previous.kind === 'ticket' ? 'ticket' : previous.kind,
      attendeeMemberIds: attendees,
      ...(previous.activityId !== undefined ? { activityId: previous.activityId } : {}),
      ...(previous.eventDate !== '' ? { date: previous.eventDate } : {}),
      // A stay is re-quoted on the same rate (T-132), a flight set on the same
      // flights (T-074); the provider re-prices it.
      ...(previous.kind === 'lodging' || previous.kind === 'flight'
        ? { itemRef: previous.itemRef }
        : {}),
    };
    if (trip === undefined || previous.kind !== 'ticket') return propose(input, ctx);
    // Same event: match by night and (sanitized) name, which is what `description` holds.
    const now = clock.now();
    const searched = await tickets.searchEvents({
      city: trip.city,
      dateFrom: localDate(now, trip.timeZone),
      dateTo: trip.endDate,
    });
    const same = searched.ok
      ? searched.value.find(
          (e) =>
            nightOf(e.startsAt, trip.timeZone) === previous.eventDate &&
            sanitizeInline(e.name, 80) === previous.description,
        )
      : undefined;
    return propose(
      same === undefined
        ? { ...input, query: shortEventName(previous.description) }
        : { ...input, eventId: same.eventId },
      ctx,
    );
  }

  /**
   * The policy context for a proposal (SAFETY §2.1): the attendees' private
   * caps (read here, never shown), the group's spend in the last 24h and on
   * this trip, the idempotency hit, and the ask behind it (T-168).
   */
  function policyContextFor(
    proposal: BookingProposal,
    trip: Trip,
    members: readonly Member[],
    now: IsoDateTime,
    ask: AskSignal | undefined,
  ): PolicyContext {
    const prefs: Record<MemberId, MemberSpendingPrefs> = {};
    for (const id of proposal.attendees) {
      const p = stores.private.getPrefs(id);
      if (p !== undefined) prefs[id] = p;
    }
    return {
      now,
      members: approval.toMemberViews(members, now),
      prefs,
      spentTodayMinor: group.bookings.spentBetween(
        proposal.groupId,
        addMinutes(now, -24 * 60),
        now,
      ),
      spentTripMinor: group.bookings.spentBetween(proposal.groupId, tripStartIso(trip), now),
      existingBookingForKey:
        group.bookings.getBookingByKey(proposal.idempotencyKey)?.bookingId ?? null,
      ...(ask !== undefined ? { ask } : {}),
    };
  }

  /**
   * T-168 (D-044): the ask a ticket proposal may be bought on without a card,
   * decided in code from what the member said, never from model output.
   * - `explicit`: the triggering message's eligible `autoBuyVerdict`, and the
   *   proposal is exactly that ask: the venue it named, the night it named
   *   (tonight when none), exactly the people it named, the regular offer (no
   *   tier, no offer id, no add-on), requested by the member who said it,
   *   who is one of the attendees (T-193; the policy's C12 says it again).
   * - `pick`: the asker's own pick on a live options card, at the total the
   *   card showed, for the card's event and party.
   * Anything else (a re-quote, a mismatch anywhere) ⇒ undefined: the card.
   */
  function ticketAsk(a: {
    readonly ctx: ProposeContext;
    readonly input: ProposeInput;
    readonly event: TicketEvent;
    readonly tz: string;
    readonly tonight: IsoDate;
    readonly trip: Trip;
    readonly attendees: readonly MemberId[];
    readonly byId: ReadonlyMap<MemberId, Member>;
    readonly offerId: string;
    readonly totalMinor: number;
    readonly addOn: boolean;
    readonly tierAsked: boolean;
    readonly now: IsoDateTime;
  }): AskSignal | undefined {
    const { ctx, input, event, attendees } = a;
    if (ctx.requireConfirmation === true || a.addOn) return undefined;
    const sameSet = (x: readonly string[], y: readonly string[]): boolean =>
      x.length === y.length && new Set(x).size === x.length && x.every((v) => y.includes(v));
    if (ctx.pick !== undefined) {
      const plan = choices.get(ctx.pick.planId);
      if (plan === undefined || plan.groupId !== ctx.groupId) return undefined;
      const option = plan.options.find((o) => o.offerId === ctx.pick?.offerId);
      const ok =
        option !== undefined &&
        a.offerId === option.offerId &&
        a.totalMinor === ctx.pick.expectedTotalMinor &&
        a.totalMinor === option.totalMinor &&
        ctx.requestedBy === plan.requestedBy &&
        event.eventId === plan.eventId &&
        sameSet(attendees, plan.attendees) &&
        parseIso(a.now) <= parseIso(plan.expiresAt);
      return ok ? 'pick' : undefined;
    }
    const v = ctx.autoBuy;
    if (v === undefined) return undefined;
    // T-193 (SAFETY T17): an ask buys on its own only for a party the asker is in.
    if (!attendees.includes(ctx.requestedBy)) return undefined;
    if (input.offerId !== undefined || a.tierAsked || input.time !== undefined) return undefined;
    if (venueKeyOf(event.venue.name) !== v.venueKey) return undefined;
    const wanted =
      v.request.day === undefined ? a.tonight : resolveNight(v.request.day, a.tonight, a.trip);
    if (wanted === undefined || nightOf(event.startsAt, a.tz) !== wanted) return undefined;
    const fold = (s: string): string => foldText(s).trim();
    const proposed = attendees.map((id) => fold(a.byId.get(id)?.displayName ?? ''));
    if (proposed.some((n) => n.length === 0)) return undefined;
    if (attendees.length !== v.quantity || !sameSet(proposed, v.attendees.map(fold))) {
      return undefined;
    }
    return 'explicit';
  }

  /**
   * T-168 (b): the 2–4 options card for offers that really differ. Nothing is
   * held, bought or written to the roster; the pick re-runs `propose` on the
   * picked offer, which holds, re-prices and goes through the policy.
   */
  function ticketOptions(a: {
    readonly choice: readonly TicketOffer[];
    readonly event: TicketEvent;
    readonly trip: Trip;
    readonly grp: { readonly spendingPolicy: GroupSpendingPolicy };
    readonly ctx: ProposeContext;
    readonly members: readonly Member[];
    readonly attendees: readonly MemberId[];
    readonly outIds: readonly MemberId[];
    readonly now: IsoDateTime;
  }): ProposeResult {
    const { event, trip, ctx, members, attendees, now } = a;
    const tz = trip.timeZone;
    const quantity = attendees.length;
    const payerRule: PayerRule = {
      members,
      now,
      familyTab: trip.familyTab === true,
      requestedBy: ctx.requestedBy,
    };
    const planId = ids.next('card');
    const currency = a.choice[0]!.unitPrice.currency;
    const options: TicketChoiceOption[] = a.choice.map((o, i) => {
      const totalMinor = offerTotal(o, quantity).amountMinor;
      const refundable = refundableNow(o, now);
      const payers = payerShares(attendees, totalMinor, o.unitPrice.currency, payerRule);
      // What the policy would say on the asker's pick (no hold yet; the pick re-checks).
      const dry: BookingProposal = {
        proposalId: `${planId}#${String(i + 1)}`,
        groupId: ctx.groupId,
        tripId: trip.tripId,
        kind: 'ticket',
        provider: tickets.info.provider,
        itemRef: o.offerId,
        description: sanitizeInline(event.name, 80),
        city: event.venue.city,
        totalMinor,
        currency: o.unitPrice.currency,
        quotedAt: now,
        quoteRef: '',
        payers,
        attendees,
        paidBy: {
          kind: 'member_card',
          memberId: cardHolderFor(
            ctx.requestedBy,
            payers.map((s) => s.memberId),
            payerRule,
          ),
        },
        refundable,
        eventDate: nightOf(event.startsAt, tz),
        ageRestriction: event.minimumAge ?? null,
        contentTags: event.contentFlags,
        requestedBy: ctx.requestedBy,
        requestedAt: now,
        sourceMessageId: ctx.sourceMessageId,
        idempotencyKey: approval.deriveIdempotencyKey({
          groupId: ctx.groupId,
          tripId: trip.tripId,
          kind: 'ticket',
          provider: tickets.info.provider,
          itemRef: o.offerId,
          eventDate: nightOf(event.startsAt, tz),
          payerIds: attendees,
          currency: o.unitPrice.currency,
          totalMinor,
        }),
        status: 'pending',
      };
      const d = approval.evaluate(
        dry,
        a.grp.spendingPolicy,
        policyContextFor(dry, trip, members, now, 'pick'),
      );
      return {
        index: i + 1,
        offerId: o.offerId,
        tierName: sanitizeInline(o.tierName, 40),
        unitMinor: o.unitPrice.amountMinor + o.unitFees.amountMinor,
        totalMinor,
        refundable,
        autoOnPick: d.outcome === 'auto_approve',
      };
    });
    const cardHolder = cardHolderFor(
      ctx.requestedBy,
      payerShares(attendees, options[0]!.totalMinor, currency, payerRule).map((s) => s.memberId),
      payerRule,
    );
    const plan: TicketChoicePlan = {
      planId,
      groupId: ctx.groupId,
      tripId: trip.tripId,
      eventId: event.eventId,
      eventDate: nightOf(event.startsAt, tz),
      currency,
      attendees,
      excluded: a.outIds,
      requestedBy: ctx.requestedBy,
      cardHolder,
      sourceMessageId: ctx.sourceMessageId,
      options,
      createdAt: now,
      expiresAt: addMinutes(now, Math.round(a.grp.spendingPolicy.approvalTtlSeconds / 60)),
      status: 'pending',
    };
    choices.save(plan);
    const { text, card } = renderTicketOptions({
      plan,
      members,
      headline: `${shortEventName(event.name)} ${whenText(event.startsAt, tz, now)}`,
    });
    return { kind: 'ticket_options', planId, text, card };
  }

  async function pickTicketOption(
    planId: string,
    index: number,
    pick: {
      readonly groupId: GroupId;
      readonly pickedBy: MemberId;
      readonly sourceMessageId: MessageId;
    },
  ): Promise<ProposeResult> {
    const plan = choices.get(planId);
    if (plan === undefined || plan.groupId !== pick.groupId) {
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: "that options card is gone. @ me again and i'll price it fresh. nothing's booked",
      };
    }
    if (plan.status === 'picked') {
      return {
        kind: 'unavailable',
        reason: 'already_picked',
        text: `option ${String(plan.pickedIndex ?? 1)} was already picked on that one. nothing else booked`,
      };
    }
    const option = plan.options.find((o) => o.index === index);
    if (option === undefined) {
      const n = plan.options.length;
      return {
        kind: 'unavailable',
        reason: 'not_found',
        text: `there's no option ${String(index)} there. pick 1 to ${String(n)}. nothing's booked`,
      };
    }
    const now = clock.now();
    const isAsker = pick.pickedBy === plan.requestedBy;
    // Only the asker's own pick on a live card is their ok (T-168 b). Anyone
    // else's pick, or a stale card, is an ordinary proposal that needs a 👍.
    const asker = isAsker && planLive(plan, now);
    // T-168 r1 #3: another member's pick never closes the card. Once a card
    // from one of those picks is booked (or is still waiting), the asker's own
    // pick gets that answer instead of a second set of tickets.
    if (isAsker) {
      for (const other of plan.otherPicks ?? []) {
        const state = latestStatus(other.proposalId);
        if (state === 'completed' || state === 'approved' || state === 'executing') {
          choices.save({ ...plan, status: 'picked', pickedIndex: other.index });
          return {
            kind: 'unavailable',
            reason: 'already_picked',
            text: `option ${String(other.index)} is already booked on that one. nothing else booked`,
          };
        }
        if (state === 'pending') {
          return {
            kind: 'unavailable',
            reason: 'already_picked',
            text: `option ${String(other.index)} is waiting for a 👍 above. 👍 it, or say "no" on it first and pick again. nothing's booked`,
          };
        }
      }
      // Marked before the await: a second tap while this one is in flight proposes nothing.
      choices.save({ ...plan, status: 'picked', pickedIndex: index });
    }
    const res = await propose(
      {
        kind: 'ticket',
        eventId: plan.eventId,
        offerId: option.offerId,
        attendeeMemberIds: plan.attendees,
        date: plan.eventDate,
        requestText: `picked option ${String(index)}`,
      },
      {
        groupId: plan.groupId,
        tripId: plan.tripId,
        // The card said whose card it goes on: that stays, whoever tapped.
        requestedBy: plan.requestedBy,
        sourceMessageId: pick.sourceMessageId,
        fromOptions: true,
        // T-168 r1 #4: who actually picked, for the audit trail.
        pickedBy: pick.pickedBy,
        ...(asker
          ? { pick: { planId, offerId: option.offerId, expectedTotalMinor: option.totalMinor } }
          : {}),
      },
    );
    const current = choices.get(planId) ?? plan;
    if (isAsker) {
      // Nothing came of it (sold out, the site down, a question): the card stays pickable.
      if (res.kind === 'unavailable' || res.kind === 'clarify') choices.save(plan);
    } else if (res.kind === 'proposal') {
      choices.save({
        ...current,
        otherPicks: [...(current.otherPicks ?? []), { index, proposalId: res.proposal.proposalId }],
      });
    }
    return res;
  }

  /** A proposal's status, following "not me" / roster re-quotes to the newest one. */
  function latestStatus(proposalId: ProposalId): BookingProposal['status'] | undefined {
    let p = group.bookings.getProposal(proposalId);
    for (let hops = 0; p !== undefined && p.status === 'superseded' && hops < 20; hops += 1) {
      const next = p.supersededBy;
      if (next === undefined) break;
      p = group.bookings.getProposal(next);
    }
    return p?.status;
  }

  return {
    propose,
    repropose,
    releaseHold,
    ticketChoice: (planId) => choices.get(planId),
    latestTicketChoice: (groupId) => choices.latest(groupId),
    pickTicketOption,
  };
}

// ---------- helpers ----------

/**
 * The policy said `auto_approve`; the caller wants a 👍 anyway. Same rule as
 * the policy's C1 (`default_confirm`, `any_one`: the policy's adult approvers
 * plus the requester), with the VOICE §6.4 expiry (TTL or hold, whichever is
 * shorter). Only ever makes a decision stricter.
 */
function confirmAnyway(
  decision: PolicyDecision,
  proposal: BookingProposal,
  policy: GroupSpendingPolicy,
  views: readonly MemberView[],
  now: IsoDateTime,
): PolicyDecision {
  const byId = new Map(views.map((v) => [v.memberId, v] as const));
  const listed =
    policy.approvers === 'any_adult_member'
      ? views
      : policy.approvers.map((id) => byId.get(id)).filter((v): v is MemberView => v !== undefined);
  const pool = listed.filter(approval.canApprove).map((v) => v.memberId);
  const requester = byId.get(proposal.requestedBy);
  // T-104: only attendees approve (an excluded or out member never does).
  const requiredApprovers = approval.anyOneApprovers(
    proposal,
    pool,
    approval.canApprove(requester) ? requester.memberId : undefined,
    byId,
  );
  const ttl = addMinutes(now, policy.approvalTtlSeconds / 60);
  return {
    ...decision,
    outcome: 'needs_confirmation',
    approvalMode: 'any_one',
    requiredApprovers,
    reasons: ['default_confirm', ...decision.reasons],
    ruleIds: ['C1', ...decision.ruleIds],
    expiresAt: proposalExpiresAt({ expiresAt: ttl }, proposal) ?? ttl,
  };
}

/** Attendees of every confirmed booking for the activity (ids only). */
export function bookedAttendees(
  group: Pick<Stores['group'], 'bookings'>,
  trip: Pick<Trip, 'tripId'>,
  activityId: string,
): Set<MemberId> {
  const out = new Set<MemberId>();
  for (const b of group.bookings.listByTrip(trip.tripId)) {
    if (b.activityId !== activityId || b.status !== 'confirmed') continue;
    for (const id of b.attendees) out.add(id);
  }
  return out;
}

/**
 * The "who's in" half of the which-one question (T-143 r1 #1, VOICE §4.11 A):
 * from the plan that night when one has attendance ("is it Dean, Chase,
 * Piotr, Arjun, Crowley? Henry's out"), else everyone active. One "?" only,
 * no reason why anyone is out.
 */
function whoIsInThat(
  group: Stores['group'],
  trip: Trip,
  night: IsoDate,
  order: readonly MemberId[],
  byId: ReadonlyMap<MemberId, Member>,
  /** The plan kind the ask is about ("club tickets" ⇒ nightlife): only that plan's roster counts (T-143 r2 #1). */
  kind?: string,
): string {
  const tz = trip.timeZone;
  const rows = group.trips
    .listActivities(trip.tripId)
    .filter((a) => a.startsAt !== undefined && nightOf(a.startsAt, tz) === night)
    .filter((a) => kind === undefined || a.kind === kind)
    .map((a) => group.trips.listAttendance(a.activityId))
    .find((r) => r.length > 0);
  if (rows === undefined) return `is it ${names([...order], byId)}?`;
  const ins = inOrder(
    rows.filter((r) => r.status === 'in').map((r) => r.memberId),
    order,
  );
  const outs = inOrder(
    rows.filter((r) => r.status === 'out').map((r) => r.memberId),
    order,
  );
  if (ins.length === 0) return "who's in?";
  const who = `is it ${names(ins, byId)}?`;
  if (outs.length === 0) return who;
  const out = outs.map((id) => sanitizeInline(byId.get(id)?.displayName ?? id, 40));
  const list =
    out.length === 1 ? out[0]! : `${out.slice(0, -1).join(', ')} and ${out[out.length - 1]!}`;
  return `${who} ${list}${out.length === 1 ? "'s" : ' are'} out`;
}

function findActivity(
  group: Stores['group'],
  trip: Trip,
  event: TicketEvent,
  activityId: string | undefined,
): Activity | null {
  if (activityId !== undefined) {
    const a = group.trips.getActivity(activityId);
    if (a === undefined || a.tripId !== trip.tripId) {
      throw new TravError('not_found', `activity ${activityId} is not on this trip`);
    }
    return a;
  }
  const tz = trip.timeZone;
  const night = nightOf(event.startsAt, tz);
  const short = shortEventName(event.name);
  const venue = event.venue.name.toLowerCase();
  for (const a of group.trips.listActivities(trip.tripId)) {
    if (a.startsAt === undefined || nightOf(a.startsAt, tz) !== night) continue;
    const hay = `${a.name} ${a.venue ?? ''}`.toLowerCase();
    if (hay.includes(short) || hay.includes(venue)) return a;
  }
  return null;
}

/**
 * T-193 (SAFETY SC-5): who is already not going to the plan an auto-buy ask
 * names, as display names for `autoBuyVerdict`'s `alreadyOut`. The plan is the
 * trip's activity on the ask's night (the night it named, else tonight) whose
 * name or venue holds the ask's venue, the one `propose` would find; the rows
 * are the ones `propose` leaves off a party (`out` or `maybe`). No plan, no
 * rows, or a night that doesn't resolve ⇒ empty.
 */
export function notGoingToAskedPlan(
  group: Stores['group'],
  trip: Trip,
  verdict: { readonly venueKey: string; readonly request: { readonly day?: string } },
  members: readonly Member[],
  now: IsoDateTime,
): string[] {
  const tz = trip.timeZone;
  const tonight = nightOf(now, tz);
  const night =
    verdict.request.day === undefined ? tonight : resolveNight(verdict.request.day, tonight, trip);
  if (night === undefined || verdict.venueKey.length === 0) return [];
  const activity = group.trips
    .listActivities(trip.tripId)
    .find(
      (a) =>
        a.startsAt !== undefined &&
        nightOf(a.startsAt, tz) === night &&
        foldText(`${a.name} ${a.venue ?? ''}`).includes(verdict.venueKey),
    );
  if (activity === undefined) return [];
  return notGoingTo(group, activity.activityId, members);
}

function notGoingTo(
  group: Stores['group'],
  activityId: string,
  members: readonly Member[],
): string[] {
  const notIn = new Set(
    group.trips
      .listAttendance(activityId)
      .filter((r) => r.status !== 'in')
      .map((r) => r.memberId),
  );
  return members.filter((m) => notIn.has(m.memberId)).map((m) => m.displayName);
}

/**
 * T-193 (SC-5): the auto-buy verdict read against the roster of the plan the
 * ask names. `verdictFor(alreadyOut)` is `autoBuyVerdict` on the message with
 * that `alreadyOut`. An eligible verdict is returned only when the
 * `alreadyOut` it was read with is exactly who isn't going to the plan it
 * names (`notGoingToAskedPlan`), so "us" / "the 5 of us" mean the people
 * still going, and a sender already out never buys "for us" for the others.
 * Anything that doesn't line up is the ineligible verdict: the card.
 */
export function autoBuyVerdictOnRoster(
  verdictFor: (alreadyOut: readonly string[]) => AutoBuyVerdict,
  group: Stores['group'],
  trip: Trip | null,
  members: readonly Member[],
  now: IsoDateTime,
): AutoBuyVerdict {
  const plain = verdictFor([]);
  if (trip === null) return plain;
  const planOut = (v: AutoBuyVerdict): string[] | undefined =>
    v.eligible ? notGoingToAskedPlan(group, trip, v, members, now) : undefined;
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((x) => b.includes(x));
  const plainOut = planOut(plain);
  if (plainOut !== undefined && plainOut.length === 0) return plain;
  // Each distinct set of people not going to some plan on this trip.
  const sets: string[][] = [];
  for (const a of group.trips.listActivities(trip.tripId)) {
    const out = notGoingTo(group, a.activityId, members);
    if (out.length > 0 && !sets.some((s) => same(s, out))) sets.push(out);
  }
  for (const out of sets) {
    const v = verdictFor(out);
    const named = planOut(v);
    if (named !== undefined && same(named, out)) return v;
  }
  if (plainOut === undefined) return plain;
  // The words passed, but not against who is actually going to that plan.
  const narrowed = verdictFor(plainOut);
  return narrowed.eligible ? { eligible: false, reason: 'party' } : narrowed;
}

function createActivity(
  group: Stores['group'],
  ids: IdGenerator,
  trip: Trip,
  event: TicketEvent,
  now: IsoDateTime,
): Activity {
  const kind: Activity['kind'] =
    event.category === 'nightlife'
      ? 'nightlife'
      : event.category === 'sports'
        ? 'sports'
        : event.category === 'tour'
          ? 'tour'
          : 'attraction';
  const activity: Activity = {
    activityId: ids.next('act'),
    tripId: trip.tripId,
    groupId: trip.groupId,
    kind,
    name: sanitizeInline(event.name, 80),
    venue: sanitizeInline(event.venue.name, 80),
    ...(event.venue.address !== undefined
      ? { address: sanitizeInline(event.venue.address, 120) }
      : {}),
    startsAt: event.startsAt,
    ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
    contentTags: event.contentFlags,
    ageRestriction: event.minimumAge ?? null,
    createdAt: now,
  };
  group.trips.upsertActivity(activity);
  return activity;
}

/**
 * Who a proposal is for, from the ask (T-132; the ticket, lodging and flight
 * paths all read it here): a named subset wins, but a member marked out stays
 * out; else `base` minus anyone named out. An unknown name, a count that
 * isn't the roster, or nobody ⇒ one question.
 *
 * Every name, in or out, is resolved before any question (T-158), so the
 * "who's in?" lists who Trav has as going: the named people it could match
 * when the ask named people (r1 #4: "for chase, crowley and zed" ⇒ "i've got
 * Chase, Crowley", never the whole group), else everyone still in; never anyone
 * the member just excluded or who is marked out.
 */
export function resolveParty(a: {
  readonly input: Pick<
    ProposeInput,
    'attendeeMemberIds' | 'attendeeNames' | 'excludedMemberIds' | 'excludedNames' | 'quantity'
  >;
  readonly active: readonly Member[];
  readonly byId: ReadonlyMap<MemberId, Member>;
  readonly order: readonly MemberId[];
  readonly base: readonly MemberId[];
  readonly markedOut: ReadonlySet<MemberId>;
}):
  | { readonly kind: 'party'; readonly attendees: MemberId[] }
  | Extract<ProposeResult, { kind: 'clarify' }> {
  const { input, active, byId, order, base, markedOut } = a;
  const whoIsIn = (ids: readonly MemberId[], problems: string[]) =>
    ({
      kind: 'clarify',
      question: whoIsInQuestion(ids, byId),
      problems,
    }) as const;
  const byName = (raw: string): Member | undefined => {
    const hits = active.filter((m) => m.displayName.toLowerCase() === raw.trim().toLowerCase());
    return hits.length === 1 ? hits[0] : undefined;
  };
  const problems: string[] = [];

  const excluded = new Set<MemberId>(input.excludedMemberIds ?? []);
  for (const raw of input.excludedNames ?? []) {
    const m = byName(raw);
    if (m === undefined) problems.push(`unknown_name:${sanitizeInline(raw, 40)}`);
    else excluded.add(m.memberId);
  }
  for (const id of excluded) {
    if (!byId.has(id)) problems.push(`unknown_member:${sanitizeInline(id, 40)}`);
  }

  const asked = (input.attendeeMemberIds ?? []).length + (input.attendeeNames ?? []).length > 0;
  const named: MemberId[] = [];
  for (const id of input.attendeeMemberIds ?? []) {
    if (order.includes(id)) named.push(id);
    else problems.push(`attendee_not_member:${sanitizeInline(id, 40)}`);
  }
  for (const raw of input.attendeeNames ?? []) {
    const m = byName(raw);
    if (m === undefined) problems.push(`unknown_name:${sanitizeInline(raw, 40)}`);
    else if (!order.includes(m.memberId)) {
      problems.push(`attendee_not_member:${sanitizeInline(m.memberId, 40)}`);
    } else named.push(m.memberId);
  }

  const attendees = asked
    ? // The named subset wins, but a member marked out for the activity stays out (SAFETY §2.5).
      inOrder(
        named.filter((id) => !excluded.has(id) && !markedOut.has(id)),
        order,
      )
    : base.filter((id) => !excluded.has(id));
  if (problems.length > 0) return whoIsIn(attendees, [...new Set(problems)]);
  if (input.quantity !== undefined && input.quantity !== attendees.length) {
    return whoIsIn(attendees, ['quantity_not_roster']);
  }
  if (attendees.length === 0) {
    return {
      kind: 'clarify',
      question: "who's in? nobody is marked in for that one yet",
      problems: ['empty_roster'],
    };
  }
  return { kind: 'party', attendees };
}

/**
 * The trip's lodging plan: the one asked for by id, else (with `name`) the
 * one for that property, else (no name) the only lodging plan with no
 * booking yet. Null when there is none.
 */
function findLodgingActivity(
  group: Stores['group'],
  trip: Trip,
  name: string | undefined,
  activityId: string | undefined,
): Activity | null {
  if (activityId !== undefined) {
    const a = group.trips.getActivity(activityId);
    if (a === undefined || a.tripId !== trip.tripId || a.kind !== 'lodging') {
      throw new TravError('not_found', `lodging activity ${activityId} is not on this trip`);
    }
    return a;
  }
  // A plan whose stay is already booked is done: another stay gets its own plan.
  const open = group.trips
    .listActivities(trip.tripId)
    .filter(
      (a) =>
        a.kind === 'lodging' &&
        a.bookingId === undefined &&
        bookedAttendees(group, trip, a.activityId).size === 0,
    );
  if (name === undefined) return open.length === 1 ? open[0]! : null;
  const want = foldText(name);
  return open.find((a) => foldText(a.venue ?? '') === want || foldText(a.name) === want) ?? null;
}

function createLodgingActivity(
  group: Stores['group'],
  ids: IdGenerator,
  trip: Trip,
  name: string,
  address: string | undefined,
  now: IsoDateTime,
): Activity {
  const activity: Activity = {
    activityId: ids.next('act'),
    tripId: trip.tripId,
    groupId: trip.groupId,
    kind: 'lodging',
    name,
    venue: name,
    ...(address !== undefined ? { address: sanitizeInline(address, 120) } : {}),
    contentTags: [],
    ageRestriction: null,
    createdAt: now,
  };
  group.trips.upsertActivity(activity);
  return activity;
}

/** A display name with a family name in it ("Dean Yao"), the only name source v0 has (D-037). */
export function hasFamilyName(member: Pick<Member, 'displayName'> | undefined): boolean {
  if (member === undefined) return false;
  return sanitizeInline(member.displayName, 80).trim().split(/\s+/).filter(Boolean).length >= 2;
}

/** "Carrer de Pujades 140, Poblenou" ⇒ "Poblenou" (the neighbourhood after the last comma). */
export function areaOf(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  const parts = address.split(',').map((s) => s.trim());
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last === undefined || last.length === 0 ? undefined : sanitizeInline(last, 40);
}

/** The cheapest stay that is cheaper than `totalMinor` only because it can't be refunded (VOICE §4.1 C). */
export function cheapestLockedBelow(
  results: readonly LodgingSearchResult[],
  totalMinor: number,
  currency: Money['currency'],
  now: IsoDateTime,
): { readonly total: Money; readonly area: string | undefined } | undefined {
  let best: { rate: LodgingRate; address: string | undefined } | undefined;
  for (const r of results) {
    for (const rate of r.rates) {
      if (refundableNow(rate, now) || rate.totalAmount.currency !== currency) continue;
      if (rate.totalAmount.amountMinor >= totalMinor) continue;
      if (best === undefined || rate.totalAmount.amountMinor < best.rate.totalAmount.amountMinor) {
        best = { rate, address: r.property.place.address };
      }
    }
  }
  return best === undefined
    ? undefined
    : { total: best.rate.totalAmount, area: areaOf(best.address) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "2026-03-07" ⇒ "mar 7" (VOICE §3.9). */
export function shortDate(date: IsoDate): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1] ?? ''} ${String(d)}`;
}

/** "mar 12–17", or "mar 30–apr 2" across a month. */
export function stayDates(checkIn: IsoDate, checkOut: IsoDate): string {
  const sameMonth = checkIn.slice(0, 7) === checkOut.slice(0, 7);
  const end = sameMonth ? String(Number(checkOut.slice(8, 10))) : shortDate(checkOut);
  return `${shortDate(checkIn)}–${end}`;
}

/**
 * Writes in/out rows for everyone named; one `roster.changed` event when
 * anything changed. A member who said "maybe" is left as maybe (it already
 * counts as out at booking time) rather than overwritten.
 */
function syncRoster(
  group: Stores['group'],
  activity: Activity,
  inIds: readonly MemberId[],
  outIds: readonly MemberId[],
  ctx: ProposeContext,
  now: IsoDateTime,
): void {
  const current = new Map(
    group.trips.listAttendance(activity.activityId).map((r) => [r.memberId, r.status]),
  );
  // T-153: a minor (or an unattested unknown age) is never written in on an adult-only plan;
  // the D9 check below still refuses the booking itself.
  const keptOff = keptOffFor(group, activity, group.members.listByGroup(ctx.groupId), now);
  const changed: { memberId: MemberId; status: 'in' | 'out' }[] = [];
  const write = (memberId: MemberId, wanted: 'in' | 'out'): void => {
    const was = current.get(memberId);
    let status = wanted;
    if (wanted === 'in' && keptOff.has(memberId)) {
      // A stale in or maybe row is set to out, as `setAttendance` does.
      if (was !== 'in' && was !== 'maybe') return;
      status = 'out';
    } else if (was === status || (status === 'out' && was === 'maybe')) {
      return;
    }
    group.trips.setAttendance({
      activityId: activity.activityId,
      memberId,
      status,
      updatedAt: now,
      sourceMessageId: ctx.sourceMessageId,
      setBy: ctx.requestedBy,
    });
    changed.push({ memberId, status });
  };
  for (const id of inIds) write(id, 'in');
  for (const id of outIds) write(id, 'out');
  if (changed.length > 0) {
    group.audit.append({
      groupId: ctx.groupId,
      tripId: activity.tripId,
      type: 'roster.changed',
      actor: { kind: 'member', id: ctx.requestedBy },
      visibility: 'group',
      payload: {
        activityId: activity.activityId,
        changes: changed,
        sourceMessageId: ctx.sourceMessageId,
      },
    });
  }
}

function soldOutText(
  event: TicketEvent,
  all: readonly TicketEvent[],
  tz: string,
  quantity: number,
  now: IsoDateTime,
  familyMode: boolean,
): string {
  const night = nightOf(event.startsAt, tz);
  // A family group never hears an adults-only name (VOICE §8, T-143 follow-up).
  const alt = all.find(
    (e) =>
      e.eventId !== event.eventId &&
      nightOf(e.startsAt, tz) === night &&
      parseIso(e.startsAt) > parseIso(now) &&
      e.category === event.category &&
      !(familyMode && adultsOnlyEvent(e)),
  );
  const when = night === nightOf(now, tz) ? 'tonight' : formatClockTime(event.startsAt, tz);
  const what =
    familyMode && adultsOnlyEvent(event) ? "that one's" : `${shortEventName(event.name)} is`;
  const first = `${what} sold out ${when}`;
  if (alt === undefined) return `${first}\nnothing else i can grab for ${quantity} on that night`;
  return `${first}\n${sanitizeInline(alt.venue.name, 40)} has tickets the same night. @ me for ${quantity} of those instead`;
}

/**
 * An age-limited booking with someone under 18 on it (consistency
 * `minor_on_restricted`, policy D9), T-148 #5. It must be delivered in a
 * family group, so: all-ages wording, never "18+"/"21+" (the outbound
 * screen's backstop drops those, VOICE §8); the event's real minimum age
 * when it is under 18 ("jet ski" is 16 and up); who's on it, not who's
 * charged; the minor isn't named.
 */
export function ageLimitText(ageRestriction: number | null): string {
  const what =
    ageRestriction !== null && ageRestriction < 18
      ? `that one's ${String(ageRestriction)} and up, and i don't book anything with an age limit for someone under 18`
      : "that one's not all-ages and someone on it is under 18";
  return `${what}, so nothing's booked, no charge\ntell me who's actually going`;
}

function clarifyFor(
  problems: readonly string[],
  attendees: readonly MemberId[],
  byId: ReadonlyMap<MemberId, Member>,
  trip: Trip,
  ageRestriction: number | null,
): string {
  if (problems.includes('minor_on_restricted')) return ageLimitText(ageRestriction);
  if (problems.includes('date_outside_trip')) {
    return `that's outside the trip dates (${trip.startDate} to ${trip.endDate}). which night did you mean`;
  }
  if (problems.includes('city_not_in_trip')) {
    return `that's not in ${sanitizeInline(trip.city, 40)}. did you mean somewhere here`;
  }
  return whoIsInQuestion(attendees, byId);
}

function denyText(
  decision: PolicyDecision,
  proposal: BookingProposal,
  hardMaxMinor: number,
): string {
  const r = decision.reasons;
  if (r.includes('over_hard_max')) {
    return `${formatMoney(money(proposal.totalMinor, proposal.currency))} is over this group's ${formatMoney(money(hardMaxMinor, proposal.currency))} per-booking limit, so i won't propose it\na lead can raise the limit if that's really the plan`;
  }
  if (r.includes('minor_age_restricted')) return ageLimitText(proposal.ageRestriction);
  if (r.includes('quote_expired')) {
    return "the price i had expired before i could post it. @ me again and i'll re-quote";
  }
  if (r.includes('requester_is_guest') || r.includes('requester_not_member')) {
    return 'i only book for people on this trip. ask one of them to @ me';
  }
  if (r.includes('payer_not_member') || r.includes('payer_inactive')) {
    return "someone on that list isn't on the trip anymore. tell me who's in";
  }
  if (r.includes('currency_mismatch')) {
    return "that's priced in a different currency than the tab, which i can't do yet";
  }
  return "i can't propose that one under this group's rules. a lead can change them";
}

interface RenderInput {
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly event: TicketEvent;
  readonly members: readonly Member[];
  readonly excluded: readonly MemberId[];
  readonly perPerson: Money;
  readonly now: IsoDateTime;
  readonly tz: string;
  readonly ruleId: string;
  readonly capPerPersonMinor: number;
  /** Add-on for a late joiner: how many members already hold tickets for this activity. */
  readonly alreadyBooked?: number;
  /** The seat tier, when the member asked for one ("Tribuna lateral"). */
  readonly tierName?: string;
  /** Family-tab trip: one pot, no splitting (VOICE §8). */
  readonly familyTab?: boolean;
}

function minutesUntil(iso: IsoDateTime, now: IsoDateTime): number {
  return Math.max(1, Math.round((parseIso(iso) - parseIso(now)) / 60000));
}

/** "tonight" for the current night, else VOICE §3.9 relative/absolute time from core. */
function whenText(startsAt: IsoDateTime, tz: string, now: IsoDateTime): string {
  if (nightOf(startsAt, tz) === nightOf(now, tz)) return 'tonight';
  return formatTime(startsAt, tz, now);
}

/** VOICE §4.1: what, when, how many, who, price each + total, refundability, who approves, hold window. */
export function renderProposalText(input: RenderInput): string {
  const { proposal: p, decision, event, members, excluded, perPerson, now, tz } = input;
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const n = p.attendees.length;
  const lines: string[] = [];
  const count = `${n} ticket${n === 1 ? '' : 's'}`;
  const booked = input.alreadyBooked ?? 0;
  lines.push(
    booked > 0
      ? `${shortEventName(event.name)} ${whenText(event.startsAt, tz, now)}, ${n} more ${n === 1 ? 'ticket' : 'tickets'} (${booked} already booked, this one's separate)`
      : `${shortEventName(event.name)} ${whenText(event.startsAt, tz, now)}, ${count}${input.tierName === undefined ? '' : ` · ${sanitizeInline(input.tierName, 40)}`}`,
  );
  const who = names(p.attendees, byId);
  lines.push(excluded.length > 0 ? `${who} (not ${names(excluded, byId)})` : who);
  const refund = !p.refundable
    ? 'non-refundable'
    : p.refundDeadline === undefined
      ? 'refundable'
      : `refundable until ${localDate(p.refundDeadline, tz) === localDate(now, tz) ? formatClockTime(p.refundDeadline, tz) : whenText(p.refundDeadline, tz, now)}`;
  lines.push(
    `${formatMoney(perPerson)} each · ${formatMoney(money(p.totalMinor, p.currency))} total · ${refund}`,
  );
  const payerName =
    p.paidBy.kind === 'member_card' ? names([p.paidBy.memberId], byId) : 'each card';
  const payerIds = p.payers.map((s) => s.memberId);
  const holder = p.paidBy.kind === 'member_card' ? p.paidBy.memberId : undefined;
  const carried = p.attendees.filter((id) => !payerIds.includes(id));
  if (n > 1 && carried.length > 0 && payerIds.length === 1) {
    // Family tab, or one adult carrying a minor: one person's share, nobody else's.
    lines.push(
      `charged to ${payerName}'s card, ${input.familyTab === true ? 'on the family tab' : `all on ${names(payerIds, byId)}`}`,
    );
  } else if (n > 1 && carried.length > 0) {
    lines.push(
      `charged to ${payerName}'s card, split ${payerIds.length} ways on the tab (${carried
        .map((id) => {
          const g = byId.get(id)?.guardianMemberId;
          return `${names([id], byId)} under ${g === undefined ? 'a guardian' : names([g], byId)}`;
        })
        .join(', ')})`,
    );
  } else if (n > 1) lines.push(`charged to ${payerName}'s card, split ${n} ways on the tab`);
  else if (
    holder !== undefined &&
    (holder === p.attendees[0] || payerIds.every((id) => id === holder))
  ) {
    // Their own ticket, or a minor's carried by the card holder (it's their tab, not the kid's).
    lines.push(`charged to ${payerName}'s card`);
  } else lines.push(`charged to ${payerName}'s card, on ${names(payerIds, byId)}'s tab`);

  const holdEnd = proposalExpiresAt(decision, p) ?? addMinutes(now, 15);
  const held = `price held for ${minutesUntil(holdEnd, now)} min`;
  const approvers = decision.requiredApprovers;
  const requesterCan = approvers.includes(p.requestedBy);
  if (decision.approvalMode === 'each_payer') {
    // One approver (a family tab, one adult carrying it): name them (VOICE §4.1 B).
    const who = approvers.length === 1 ? names([approvers[0]!], byId) : 'everyone charged';
    const why = decision.reasons.includes('over_per_person_cap')
      ? `that's over the ${formatMoney(money(input.capPerPersonMinor, p.currency))}/person cap, so ${who} has to 👍`
      : decision.reasons.includes('over_tab_auto_cap')
        ? // T-193 (D-046): more than the tab cap on someone else's word.
          `that's over ${formatMoney(money(tabAutoCapOf(decision.policySnapshot), p.currency))} each on ${names([p.requestedBy], byId)}'s ask, so ${who} has to 👍`
        : `${who} has to 👍 this one`;
    lines.push(why);
    lines.push(`👍 to book, or say "not me" first. ${held}`);
  } else if (requesterCan) {
    if (!p.refundable) lines.push("it's non-refundable, so check the date before you tap");
    lines.push(`👍 to book. ${held}`);
  } else {
    // VOICE §4.1 B: name everyone who can approve; under any_one one tap from
    // any of them is enough, so say so instead of implying they all must.
    // C10 (T-148): someone else's card, or a minor asking: the card owner signs off.
    const onCard =
      p.paidBy.kind === 'member_card' &&
      (decision.reasons.includes('card_not_requester') ||
        decision.reasons.includes('minor_requester')) &&
      approvers.length === 1 &&
      approvers[0] === p.paidBy.memberId;
    const so = !p.refundable
      ? "it's non-refundable, so "
      : onCard
        ? `it's on ${payerName}'s card, so `
        : '';
    const list = approvers.map((id) => names([id], byId));
    if (list.length <= 1) {
      const okBy = list[0] ?? 'a trip adult';
      lines.push(`${so}${okBy} has to ok it`);
      lines.push(`👍 from ${okBy} to book, or anyone can say "not me" first. ${held}`);
    } else {
      const anyOf = `${list.slice(0, -1).join(', ')} or ${list[list.length - 1] ?? ''}`;
      lines.push(`${so}any one of ${anyOf} can ok it`);
      lines.push(`one 👍 from any of them books it, or anyone can say "not me" first. ${held}`);
    }
  }
  return lines.join('\n');
}

interface CardInput {
  readonly cardId: string;
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly event: TicketEvent;
  readonly byId: ReadonlyMap<MemberId, Member>;
  readonly excluded: readonly MemberId[];
  readonly perPerson: Money;
  readonly text: string;
  readonly ruleId: string;
  readonly capPerPersonMinor: number;
}

function buildCard(input: CardInput): BookingProposalCard {
  const { proposal: p, decision, event, byId, text } = input;
  const name = (id: MemberId): string => sanitizeInline(byId.get(id)?.displayName ?? id, 40);
  const overCap = decision.reasons.includes('over_per_person_cap');
  const reason = overCap
    ? `over the ${formatMoney(money(input.capPerPersonMinor, p.currency))}/person cap`
    : !p.refundable
      ? 'non-refundable'
      : undefined;
  return {
    cardId: input.cardId,
    type: 'booking_proposal',
    title: sanitizeInline(event.name, 80),
    fallbackText: text,
    proposalId: p.proposalId,
    category: 'event',
    item: {
      name: sanitizeInline(event.name, 80),
      venue: sanitizeInline(event.venue.name, 80),
      startsAt: event.startsAt,
      ...(event.endsAt !== undefined ? { endsAt: event.endsAt } : {}),
    },
    quantity: p.attendees.length,
    charged: p.payers.map((s) => ({
      memberId: s.memberId,
      name: name(s.memberId),
      share: money(s.shareMinor, p.currency),
    })),
    excluded: input.excluded.map((id) => ({ memberId: id, name: name(id) })),
    pricePerPerson: input.perPerson,
    total: money(p.totalMinor, p.currency),
    refundable: p.refundable,
    ...(p.refundDeadline !== undefined ? { refundDeadline: p.refundDeadline } : {}),
    paidBy: p.paidBy,
    policy: {
      requiresApprovalFrom: decision.requiredApprovers,
      approvalMode: decision.approvalMode === 'each_payer' ? 'each_payer' : 'any_one',
      overCap,
      capPerPerson: money(input.capPerPersonMinor, p.currency),
      ...(reason !== undefined ? { reason } : {}),
      ruleId: input.ruleId,
    },
    holdExpiresAt: proposalExpiresAt(decision, p) ?? p.quotedAt,
    status: 'pending',
  };
}

export interface LodgingRenderInput {
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly members: readonly Member[];
  readonly excluded: readonly MemberId[];
  /** The property's name, sanitized. */
  readonly name: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly now: IsoDateTime;
  readonly tz: string;
  readonly capPerPersonMinor: number;
  /** A cheaper stay that is non-refundable: named as the trade-off (VOICE §4.1 C). */
  readonly cheaperLocked?: { readonly total: Money; readonly area: string | undefined };
  readonly familyTab?: boolean;
}

/**
 * VOICE §4.1 C, at most 6 lines (§3.1): the place and dates, the total for
 * the nights with each share and the refund terms, the non-refundable
 * trade-off when there is one, who's staying and whose card, who has to 👍
 * and why, and how long the ask is open. Built from the stored proposal and
 * the policy decision only, never model text.
 */
export function renderLodgingText(input: LodgingRenderInput): string {
  const { proposal: p, decision, members, excluded, now, tz } = input;
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const n = p.attendees.length;
  const total = money(p.totalMinor, p.currency);
  const nights = daysBetween(input.checkIn, input.checkOut);
  const lines: string[] = [];
  lines.push(
    `found a place for ${String(n)}: ${input.name}, ${stayDates(input.checkIn, input.checkOut)}`,
  );
  const shares = p.payers.map((s) => s.shareMinor);
  const even = shares.every((s) => s === shares[0]);
  const each =
    shares.length <= 1
      ? undefined
      : even
        ? `${formatMoney(money(shares[0]!, p.currency))} each`
        : `≈${formatMoney(money(Math.round(p.totalMinor / shares.length), p.currency))} each`;
  const refund = !p.refundable
    ? 'non-refundable'
    : p.refundDeadline === undefined
      ? 'free cancel'
      : `free cancel until ${shortDate(localDate(p.refundDeadline, tz))}`;
  lines.push(
    [
      `${formatMoney(total)} for ${String(nights)} night${nights === 1 ? '' : 's'}`,
      ...(each !== undefined ? [each] : []),
      refund,
    ].join(' · '),
  );
  if (p.refundable && input.cheaperLocked !== undefined) {
    const where = input.cheaperLocked.area === undefined ? '' : ` in ${input.cheaperLocked.area}`;
    lines.push(
      `there's a ${formatMoney(input.cheaperLocked.total)} one${where} but it's non-refundable, so i'd go with this`,
    );
  }
  const who = names(p.attendees, byId);
  const holder =
    p.paidBy.kind === 'member_card' ? `${names([p.paidBy.memberId], byId)}'s card` : 'each card';
  const payerIds = p.payers.map((s) => s.memberId);
  const split =
    payerIds.length <= 1
      ? input.familyTab === true
        ? 'on the family tab'
        : `all on ${names(payerIds, byId)}`
      : `split ${String(payerIds.length)} ways on the tab`;
  lines.push(
    `${excluded.length > 0 ? `${who} (not ${names(excluded, byId)})` : who} · on ${holder}, ${split}`,
  );
  const approvers = decision.requiredApprovers;
  const open = `open for ${String(minutesUntil(proposalExpiresAt(decision, p) ?? addMinutes(now, 15), now))} min`;
  if (decision.approvalMode === 'each_payer' && approvers.length > 1) {
    const why = decision.reasons.includes('kind_requires_each_payer')
      ? 'lodging is on everyone paying'
      : decision.reasons.includes('over_per_person_cap')
        ? `that's over the ${formatMoney(money(input.capPerPersonMinor, p.currency))}/person cap`
        : 'this one is on everyone paying';
    lines.push(`${why}, so all ${String(approvers.length)} of you have to 👍`);
    lines.push(`👍 to book, or say "not me" first. ${open}`);
  } else if (approvers.length === 1 && approvers[0] !== p.requestedBy) {
    const okBy = names([approvers[0]!], byId);
    lines.push(`👍 from ${okBy} to book, or anyone can say "not me" first. ${open}`);
  } else if (approvers.length > 1 && !approvers.includes(p.requestedBy)) {
    const list = approvers.map((id) => names([id], byId));
    lines.push(
      `one 👍 from ${list.slice(0, -1).join(', ')} or ${list[list.length - 1] ?? ''} books it. ${open}`,
    );
  } else {
    lines.push(`👍 to book, or say "not me" first. ${open}`);
  }
  return lines.join('\n');
}

function buildLodgingCard(input: {
  readonly cardId: string;
  readonly proposal: BookingProposal;
  readonly decision: PolicyDecision;
  readonly byId: ReadonlyMap<MemberId, Member>;
  readonly excluded: readonly MemberId[];
  readonly name: string;
  readonly area?: string;
  readonly details: readonly string[];
  readonly text: string;
  readonly ruleId: string;
  readonly capPerPersonMinor: number;
}): BookingProposalCard {
  const { proposal: p, decision, byId } = input;
  const name = (id: MemberId): string => sanitizeInline(byId.get(id)?.displayName ?? id, 40);
  const overCap = decision.reasons.includes('over_per_person_cap');
  const reason = overCap
    ? `over the ${formatMoney(money(input.capPerPersonMinor, p.currency))}/person cap`
    : !p.refundable
      ? 'non-refundable'
      : decision.reasons.includes('kind_requires_each_payer')
        ? 'lodging is on everyone paying'
        : undefined;
  const n = Math.max(1, p.payers.length);
  return {
    cardId: input.cardId,
    type: 'booking_proposal',
    title: input.name,
    fallbackText: input.text,
    proposalId: p.proposalId,
    category: 'lodging',
    item: {
      name: input.name,
      ...(input.area !== undefined ? { venue: input.area } : {}),
      details: input.details,
    },
    quantity: p.attendees.length,
    charged: p.payers.map((s) => ({
      memberId: s.memberId,
      name: name(s.memberId),
      share: money(s.shareMinor, p.currency),
    })),
    excluded: input.excluded.map((id) => ({ memberId: id, name: name(id) })),
    pricePerPerson: money(Math.round(p.totalMinor / n), p.currency),
    total: money(p.totalMinor, p.currency),
    refundable: p.refundable,
    ...(p.refundDeadline !== undefined ? { refundDeadline: p.refundDeadline } : {}),
    paidBy: p.paidBy,
    policy: {
      requiresApprovalFrom: decision.requiredApprovers,
      approvalMode: decision.approvalMode === 'each_payer' ? 'each_payer' : 'any_one',
      overCap,
      capPerPerson: money(input.capPerPersonMinor, p.currency),
      ...(reason !== undefined ? { reason } : {}),
      ruleId: input.ruleId,
    },
    holdExpiresAt: proposalExpiresAt(decision, p) ?? p.quotedAt,
    status: 'pending',
  };
}
