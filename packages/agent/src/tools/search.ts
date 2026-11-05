/**
 * Read-only provider searches: `search_events`, `search_flights`, `search_lodging`.
 * Results are compact, structured and sanitized (provider free text such as
 * refund summaries never enters a tool-enabled call; SAFETY §2.4).
 */
import type { IsoDate, MemberId } from '@trav/core';
import { formatMoney, formatTime, localDate, safety, TravError } from '@trav/core';
import type { FlightsAdapter, LodgingAdapter, TicketsAdapter, EventCategory } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';
import { adultsOnlyEvent, nightOf, refundableNow } from '../booking/proposals.js';
import { seatPlainWords } from '../booking/seats.js';
import type { ToolDefinition } from './registry.js';
import {
  activeMembers,
  asRecord,
  bad,
  optEnum,
  optInt,
  optString,
  optStringArray,
  requireTrip,
  resolveMemberRef,
} from './shared.js';

const CATEGORIES: readonly EventCategory[] = [
  'nightlife',
  'concert',
  'sports',
  'attraction',
  'tour',
  'theatre',
  'food_drink',
  'other',
];

function isoDate(v: string | undefined, what: string): IsoDate | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${what} must be YYYY-MM-DD`);
  return v;
}

export interface SearchEventsInput {
  readonly query?: string;
  readonly date?: IsoDate;
  readonly quantity?: number;
  readonly category?: EventCategory;
}

/** One bookable tier of an event (T-133: "anything cheaper" compares tiers of the same event). */
export interface TierResult {
  readonly offerId: string;
  readonly tier: string;
  /** Where the seats are in plain words ("behind the goal", "sideline"), null when the tier name doesn't say. */
  readonly seat: string | null;
  /** Per person, fees included. */
  readonly amountMinor: number;
  readonly currency: string;
  readonly text: string;
  /** Refundable as of now. */
  readonly refundable: boolean;
}

/** Tiers listed per event (cheapest first): enough to compare, small enough for a tool result. */
const MAX_TIERS = 4;
/** Events listed per search; `truncated` says when more matched. */
const MAX_EVENTS = 12;

export interface EventResult {
  readonly eventId: string;
  readonly name: string;
  readonly venue: string;
  readonly startsAt: string;
  /** The local night it belongs to (YYYY-MM-DD; a 2am start is the night before), T-143. */
  readonly night: IsoDate;
  /** When it starts, as Trav says it (VOICE §3.9): "tonight 12am", "fri mar 13 10am". */
  readonly when: string;
  readonly category: string;
  readonly minimumAge: number | null;
  /** 18+ or restricted content (nightlife, bar, gambling…): never named in a family group (T-148 r1 #3). */
  readonly adultsOnly: boolean;
  readonly from: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly text: string;
  } | null;
  readonly refundableOption: boolean;
  /** Tier name and refundability (as of now) of the cheapest bookable offer. */
  readonly fromTier: string | null;
  readonly fromRefundable: boolean | null;
  /** Plain-words seat of the cheapest bookable offer ("behind the goal"), null when unknown. */
  readonly fromSeat: string | null;
  /** Bookable tiers for the asked quantity, cheapest first (at most 4). */
  readonly tiers: readonly TierResult[];
  readonly bookable: boolean;
}

export function createSearchEventsTool(tickets: TicketsAdapter): ToolDefinition<
  SearchEventsInput,
  {
    readonly events: readonly EventResult[];
    readonly note?: string;
    /** A minor is on the trip (or it's forced): adults-only events go unnamed (VOICE §8). */
    readonly familyMode?: boolean;
    /** More events matched than the first `MAX_EVENTS` listed here. */
    readonly truncated?: true;
    /**
     * The local night now (a 2am search is still last night) and the trip's
     * first and last day (YYYY-MM-DD), so "saturday" can be read against the
     * results the way `propose_booking` reads it (T-143).
     */
    readonly calendar?: {
      readonly tonight: IsoDate;
      readonly tripStart: IsoDate;
      readonly tripEnd: IsoDate;
    };
  }
> {
  return {
    name: 'search_events',
    description:
      'Search events, clubs, matches, attractions and tours in the trip city for the trip dates. Returns the cheapest bookable price per event and its bookable seat tiers (cheapest first, with where the seats are and refundability), so you can compare tiers of the same event. Read-only: it never proposes or buys.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD local night; default: rest of the trip' },
        quantity: { type: 'integer', minimum: 1 },
        category: { type: 'string', enum: [...CATEGORIES] },
      },
      additionalProperties: false,
    },
    parse(raw) {
      const r = asRecord(raw);
      const out: { -readonly [K in keyof SearchEventsInput]: SearchEventsInput[K] } = {};
      const query = optString(r, 'query', 80);
      if (query !== undefined) out.query = query;
      const date = isoDate(optString(r, 'date', 10), 'date');
      if (date !== undefined) out.date = date;
      const quantity = optInt(r, 'quantity');
      if (quantity !== undefined) {
        if (quantity <= 0 || quantity > 50) bad('quantity out of range');
        out.quantity = quantity;
      }
      const category = optEnum(r, 'category', CATEGORIES);
      if (category !== undefined) out.category = category;
      return out;
    },
    async handler(input, ctx) {
      const trip = requireTrip(ctx);
      const today = localDate(ctx.now, trip.timeZone);
      const dateFrom = input.date ?? (today < trip.startDate ? trip.startDate : today);
      const dateTo = input.date ?? trip.endDate;
      const calendar = {
        tonight: nightOf(ctx.now, trip.timeZone),
        tripStart: trip.startDate,
        tripEnd: trip.endDate,
      };
      const res = await tickets.searchEvents({
        city: trip.city,
        dateFrom,
        dateTo,
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
        ...(input.category !== undefined ? { categories: [input.category] } : {}),
      });
      if (!res.ok) return { events: [], note: `provider ${res.error.code}` };
      const events: EventResult[] = [];
      for (const ev of res.value.slice(0, MAX_EVENTS)) {
        const offers = await tickets.getOffers(ev.eventId, input.quantity ?? 1);
        const api = offers.ok ? offers.value.filter((o) => o.purchaseMode === 'api') : [];
        const sorted = [...api].sort(
          (a, b) =>
            a.unitPrice.amountMinor +
            a.unitFees.amountMinor -
            (b.unitPrice.amountMinor + b.unitFees.amountMinor),
        );
        const cheapest = sorted[0];
        const tiers = sorted
          .filter((o) => o.maxPerOrder >= (input.quantity ?? 1))
          .slice(0, MAX_TIERS)
          .map((o): TierResult => {
            const each = o.unitPrice.amountMinor + o.unitFees.amountMinor;
            return {
              offerId: o.offerId,
              tier: sanitizeInline(o.tierName, 40),
              seat: seatPlainWords(o.tierName, ev.category) ?? null,
              amountMinor: each,
              currency: o.unitPrice.currency,
              text: formatMoney({ amountMinor: each, currency: o.unitPrice.currency }),
              refundable: refundableNow(o, ctx.now),
            };
          });
        const from =
          cheapest === undefined
            ? null
            : {
                amountMinor: cheapest.unitPrice.amountMinor + cheapest.unitFees.amountMinor,
                currency: cheapest.unitPrice.currency,
                text: formatMoney({
                  amountMinor: cheapest.unitPrice.amountMinor + cheapest.unitFees.amountMinor,
                  currency: cheapest.unitPrice.currency,
                }),
              };
        events.push({
          eventId: ev.eventId,
          name: sanitizeInline(ev.name, 80),
          venue: sanitizeInline(ev.venue.name, 80),
          startsAt: ev.startsAt,
          night: nightOf(ev.startsAt, trip.timeZone),
          when: formatTime(ev.startsAt, trip.timeZone, ctx.now),
          category: ev.category,
          minimumAge: ev.minimumAge ?? null,
          adultsOnly: adultsOnlyEvent(ev),
          from,
          refundableOption: api.some((o) => refundableNow(o, ctx.now)),
          fromTier: cheapest === undefined ? null : sanitizeInline(cheapest.tierName, 40),
          fromRefundable: cheapest === undefined ? null : refundableNow(cheapest, ctx.now),
          fromSeat:
            cheapest === undefined
              ? null
              : (seatPlainWords(cheapest.tierName, ev.category) ?? null),
          tiers,
          bookable: api.length > 0,
        });
      }
      const group = ctx.stores.group.groups.get(ctx.groupId);
      const familyMode =
        group !== undefined &&
        safety.isFamilyMode(group, ctx.stores.group.members.listByGroup(ctx.groupId), ctx.now);
      // More matched than listed: the list is not the whole picture (T-143 r1 #6).
      const truncated = res.value.length > MAX_EVENTS ? { truncated: true as const } : {};
      return familyMode
        ? { events, familyMode, calendar, ...truncated }
        : { events, calendar, ...truncated };
    },
  };
}

export interface SearchFlightsInput {
  readonly origin: string;
  readonly destination: string;
  readonly date: IsoDate;
  readonly members?: readonly string[];
}

export interface FlightResult {
  readonly offerId: string;
  readonly carrier: string;
  readonly departingAt: string;
  readonly arrivingAt: string;
  readonly stops: number;
  readonly total: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly refundable: boolean;
  readonly expiresAt: string;
}

export function createSearchFlightsTool(
  flights: FlightsAdapter,
): ToolDefinition<
  SearchFlightsInput,
  { readonly offers: readonly FlightResult[]; readonly note?: string }
> {
  return {
    name: 'search_flights',
    description:
      'Search one-way flight offers for one origin on one date (IATA codes). For a multi-origin group, call once per origin. Read-only; flights are always booked with a lead confirming.',
    inputSchema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'IATA, e.g. BOS' },
        destination: { type: 'string', description: 'IATA, e.g. BCN' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'who flies; default: the sender',
        },
      },
      required: ['origin', 'destination', 'date'],
      additionalProperties: false,
    },
    parse(raw) {
      const r = asRecord(raw);
      const iata = (k: string): string => {
        const v = optString(r, k, 3)?.toUpperCase();
        if (v === undefined || !/^[A-Z]{3}$/.test(v)) bad(`${k} must be a 3-letter IATA code`);
        return v;
      };
      const date = isoDate(optString(r, 'date', 10), 'date');
      if (date === undefined) bad('date is required');
      const members = optStringArray(r, 'members');
      return {
        origin: iata('origin'),
        destination: iata('destination'),
        date,
        ...(members !== undefined ? { members } : {}),
      };
    },
    async handler(input, ctx) {
      const members = activeMembers(ctx);
      const ids: MemberId[] = [];
      for (const ref of input.members ?? []) {
        const id = resolveMemberRef(members, ref);
        if (id === undefined) throw new TravError('not_found', `no member "${ref}" on this trip`);
        ids.push(id);
      }
      if (ids.length === 0 && ctx.senderMemberId !== null) ids.push(ctx.senderMemberId);
      if (ids.length === 0)
        throw new TravError('not_authorized', 'only members of this trip can search flights');
      const res = await flights.search({
        slices: [
          { origin: input.origin, destination: input.destination, departureDate: input.date },
        ],
        passengers: ids.map((memberId) => ({ memberId, type: 'adult' as const })),
      });
      if (!res.ok) return { offers: [], note: `provider ${res.error.code}` };
      const offers = res.value.slice(0, 8).map((o): FlightResult => {
        const first = o.slices[0];
        const segs = first?.segments ?? [];
        return {
          offerId: o.offerId,
          carrier: sanitizeInline(o.owner.name, 40),
          departingAt: segs[0]?.departingAt ?? '',
          arrivingAt: segs[segs.length - 1]?.arrivingAt ?? '',
          stops: Math.max(0, segs.length - 1),
          total: formatMoney(o.totalAmount),
          totalMinor: o.totalAmount.amountMinor,
          currency: o.totalAmount.currency,
          refundable: o.conditions.refundBeforeDeparture.allowed,
          expiresAt: o.expiresAt,
        };
      });
      return { offers };
    },
  };
}

export interface SearchLodgingInput {
  readonly checkIn?: IsoDate;
  readonly checkOut?: IsoDate;
  readonly adults?: number;
  readonly wholeUnit?: boolean;
  readonly maxTotalMinor?: number;
  readonly refundableOnly?: boolean;
}

export interface LodgingResult {
  readonly propertyId: string;
  readonly rateId: string;
  readonly name: string;
  readonly kind: string;
  readonly area: string;
  readonly sleeps: number;
  readonly bedrooms: number | null;
  readonly total: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly refundable: boolean;
  readonly refundableUntil: string | null;
  readonly reviewScore: number | null;
}

export function createSearchLodgingTool(
  lodging: LodgingAdapter,
): ToolDefinition<
  SearchLodgingInput,
  { readonly stays: readonly LodgingResult[]; readonly note?: string }
> {
  return {
    name: 'search_lodging',
    description:
      'Search places to stay in the trip city for the trip dates (whole-unit for the group by default). Refundable options first. Read-only; lodging is always booked with a lead confirming.',
    inputSchema: {
      type: 'object',
      properties: {
        checkIn: { type: 'string' },
        checkOut: { type: 'string' },
        adults: { type: 'integer', minimum: 1 },
        wholeUnit: { type: 'boolean' },
        maxTotalMinor: { type: 'integer', minimum: 1 },
        refundableOnly: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    parse(raw) {
      const r = asRecord(raw);
      const out: { -readonly [K in keyof SearchLodgingInput]: SearchLodgingInput[K] } = {};
      const checkIn = isoDate(optString(r, 'checkIn', 10), 'checkIn');
      if (checkIn !== undefined) out.checkIn = checkIn;
      const checkOut = isoDate(optString(r, 'checkOut', 10), 'checkOut');
      if (checkOut !== undefined) out.checkOut = checkOut;
      const adults = optInt(r, 'adults');
      if (adults !== undefined) {
        if (adults <= 0 || adults > 30) bad('adults out of range');
        out.adults = adults;
      }
      if (typeof r['wholeUnit'] === 'boolean') out.wholeUnit = r['wholeUnit'];
      const max = optInt(r, 'maxTotalMinor');
      if (max !== undefined) {
        if (max <= 0) bad('maxTotalMinor must be positive');
        out.maxTotalMinor = max;
      }
      if (typeof r['refundableOnly'] === 'boolean') out.refundableOnly = r['refundableOnly'];
      return out;
    },
    async handler(input, ctx) {
      const trip = requireTrip(ctx);
      const adults = input.adults ?? activeMembers(ctx).length;
      const res = await lodging.search({
        near: { city: trip.city },
        checkIn: input.checkIn ?? trip.startDate,
        checkOut: input.checkOut ?? trip.endDate,
        adults,
        wholeUnitForGroup: input.wholeUnit ?? true,
        ...(input.maxTotalMinor !== undefined
          ? { maxTotal: { amountMinor: input.maxTotalMinor, currency: trip.currency } }
          : {}),
        ...(input.refundableOnly !== undefined ? { refundableOnly: input.refundableOnly } : {}),
      });
      if (!res.ok) return { stays: [], note: `provider ${res.error.code}` };
      const stays: LodgingResult[] = [];
      for (const r of res.value) {
        for (const rate of r.rates) {
          stays.push({
            propertyId: r.property.propertyId,
            rateId: rate.rateId,
            name: sanitizeInline(r.property.name, 80),
            kind: r.property.kind,
            area: sanitizeInline(r.property.place.address ?? r.property.place.city, 80),
            sleeps: rate.sleeps,
            bedrooms: r.property.bedrooms ?? null,
            total: formatMoney(rate.totalAmount),
            totalMinor: rate.totalAmount.amountMinor,
            currency: rate.totalAmount.currency,
            refundable: rate.refundPolicy.refundable,
            refundableUntil: rate.refundPolicy.refundableUntil ?? null,
            reviewScore: r.property.reviewScore ?? null,
          });
        }
      }
      stays.sort((a, b) =>
        a.refundable !== b.refundable ? (a.refundable ? -1 : 1) : a.totalMinor - b.totalMinor,
      );
      return { stays: stays.slice(0, 8) };
    },
  };
}
