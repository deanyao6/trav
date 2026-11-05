/**
 * Ticket inventory for the mock TicketsAdapter: types, a validating mapper
 * from fixture JSON, and the bundled fixtures (`fixtures/tickets/*.json`).
 *
 * The JSON is imported statically (no `fs`), so the mock stays usable from
 * any runtime and does no I/O. The mapper accepts offers either nested under
 * each event (`events[].offers[]`, the shape of `fixtures/tickets/barcelona.json`)
 * or as a flat top-level `offers[]` carrying `eventId`; money as `Money`
 * objects or as `*Minor` integers plus the inventory `currency`.
 * Receipt prefixes resolve offer, then event, then inventory: an offer's
 * `orderPrefix` or `mockHints.<offerId>.orderRefPrefix`, else the event's
 * `orderPrefix` or `mockHints.<eventId>.orderRefPrefix`, else the root
 * `orderPrefix`, else "TK". The root `city` and `tripCities` name the trip
 * cities the inventory answers for (day trips like Sintra from Lisbon).
 * Malformed fixtures throw `TravError('invalid_argument')` naming the path.
 */
import type { CurrencyCode, IsoDateTime, Money } from '@trav/core';
import { TravError, money, parseIso } from '@trav/core';
import type { Place, RefundPolicy } from '../../interfaces/common.js';
import type {
  DeliveryMethod,
  EventCategory,
  TicketEvent,
  TicketOffer,
} from '../../interfaces/tickets.js';
import barcelonaJson from '../../../../../fixtures/tickets/barcelona.json' with { type: 'json' };
import lisbonJson from '../../../../../fixtures/tickets/lisbon.json' with { type: 'json' };
import turksAndCaicosJson from '../../../../../fixtures/tickets/turks-and-caicos.json' with { type: 'json' };

/** Fixed seating block; seats are assigned consecutively from `firstSeat`. */
export interface InventorySeating {
  readonly gate?: string;
  readonly section: string;
  readonly row?: string;
  readonly firstSeat: number;
}

export interface InventoryOffer {
  /** `available` here is the starting stock. */
  readonly offer: TicketOffer;
  readonly seating?: InventorySeating;
  readonly entryBefore?: IsoDateTime;
  /** Overrides the inventory-wide hold window. */
  readonly holdMinutes?: number;
  /** Receipt prefix for this offer's orders (overrides the event's `orderPrefix`). */
  readonly orderPrefix?: string;
}

export interface InventoryEvent {
  readonly event: TicketEvent;
  /** Receipt number prefix, e.g. "RZ" ⇒ "RZ-48213". */
  readonly orderPrefix: string;
  /** Sales close at this instant (default: `endsAt`, else `startsAt`). */
  readonly salesEndAt: IsoDateTime;
  /** Extra search terms (aliases like "barca", "football"). */
  readonly keywords: readonly string[];
  readonly offers: readonly InventoryOffer[];
}

export interface TicketInventory {
  readonly name: string;
  readonly provider: string;
  readonly currency: CurrencyCode;
  readonly holdMinutes: number;
  /**
   * Trip cities this inventory answers for (root `city` plus `tripCities`,
   * deduped; may be empty). A search for one of them returns this inventory's
   * events wherever the venue is, and never another inventory's.
   */
  readonly cities: readonly string[];
  readonly events: readonly InventoryEvent[];
}

const CATEGORIES: ReadonlySet<string> = new Set<EventCategory>([
  'nightlife',
  'concert',
  'sports',
  'attraction',
  'tour',
  'theatre',
  'food_drink',
  'other',
]);

const DELIVERY: ReadonlySet<string> = new Set<DeliveryMethod>([
  'per_person_qr',
  'single_group_qr',
  'mobile_app_transfer',
  'will_call',
  'redirect',
]);

const CONTENT_FLAGS: ReadonlySet<string> = new Set([
  'nightlife',
  'club',
  'bar',
  'alcohol',
  '18+',
  '21+',
  'gambling',
  'cannabis',
  'adult',
  'late_night',
  'family',
]);

type Json = Record<string, unknown>;

function bad(path: string, why: string): never {
  throw new TravError('invalid_argument', `ticket inventory ${path}: ${why}`, { path });
}

function obj(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(path, 'expected an object');
  }
  return value as Json;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) bad(path, 'expected a non-empty string');
  return value;
}

function optStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path);
}

function int(value: unknown, path: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    bad(path, `expected an integer >= ${min}`);
  }
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') bad(path, 'expected a boolean');
  return value;
}

function iso(value: unknown, path: string): IsoDateTime {
  const s = str(value, path);
  try {
    parseIso(s);
  } catch {
    bad(path, 'expected an ISO-8601 date-time with offset');
  }
  return s;
}

function optIso(value: unknown, path: string): IsoDateTime | undefined {
  return value === undefined ? undefined : iso(value, path);
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) bad(path, 'expected an array');
  return value;
}

/** `Money` object, or `<name>Minor` integer + inventory currency. */
function moneyField(o: Json, name: string, currency: CurrencyCode, path: string): Money {
  const direct = o[name];
  if (direct !== undefined) {
    const m = obj(direct, `${path}.${name}`);
    const cur = str(m.currency, `${path}.${name}.currency`);
    if (cur !== currency) bad(`${path}.${name}.currency`, `expected ${currency}`);
    return money(int(m.amountMinor, `${path}.${name}.amountMinor`), cur);
  }
  const minor = o[`${name}Minor`];
  if (minor !== undefined) return money(int(minor, `${path}.${name}Minor`), currency);
  if (name === 'unitFees') return money(0, currency);
  return bad(`${path}.${name}`, 'missing');
}

function place(value: unknown, path: string): Place {
  const o = obj(value, path);
  const geoRaw = o.geo;
  let geo: Place['geo'];
  if (geoRaw !== undefined) {
    const g = obj(geoRaw, `${path}.geo`);
    if (typeof g.lat !== 'number' || typeof g.lon !== 'number') bad(`${path}.geo`, 'lat/lon');
    geo = { lat: g.lat, lon: g.lon };
  }
  const address = optStr(o.address, `${path}.address`);
  const timeZone = optStr(o.timeZone, `${path}.timeZone`);
  return {
    name: str(o.name, `${path}.name`),
    city: str(o.city, `${path}.city`),
    countryCode: str(o.countryCode, `${path}.countryCode`),
    ...(address !== undefined ? { address } : {}),
    ...(geo !== undefined ? { geo } : {}),
    ...(timeZone !== undefined ? { timeZone } : {}),
  };
}

function refundPolicy(value: unknown, currency: CurrencyCode, path: string): RefundPolicy {
  const o = obj(value, path);
  const refundable = bool(o.refundable, `${path}.refundable`);
  const refundableUntil = optIso(o.refundableUntil, `${path}.refundableUntil`);
  const summary = optStr(o.summary, `${path}.summary`);
  const hasPenalty = o.penalty !== undefined || o.penaltyMinor !== undefined;
  const penalty = hasPenalty ? moneyField(o, 'penalty', currency, path) : undefined;
  return {
    refundable,
    ...(refundableUntil !== undefined ? { refundableUntil } : {}),
    ...(penalty !== undefined ? { penalty } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function seating(value: unknown, path: string): InventorySeating | undefined {
  if (value === undefined) return undefined;
  const o = obj(value, path);
  const gate = optStr(o.gate, `${path}.gate`);
  const row = optStr(o.row, `${path}.row`);
  return {
    section: str(o.section, `${path}.section`),
    firstSeat: int(o.firstSeat, `${path}.firstSeat`, 1),
    ...(gate !== undefined ? { gate } : {}),
    ...(row !== undefined ? { row } : {}),
  };
}

function prefix(value: unknown, path: string): string {
  const s = str(value, path);
  if (!/^[A-Z0-9]{1,8}$/.test(s)) bad(path, 'expected 1-8 uppercase letters or digits');
  return s;
}

function optPrefix(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : prefix(value, path);
}

/** `mockHints.<id>.orderRefPrefix`, if any. */
function hintPrefix(hints: Json, id: string): string | undefined {
  const h = hints[id];
  if (h === undefined) return undefined;
  const o = obj(h, `$.mockHints.${id}`);
  return optPrefix(o.orderRefPrefix, `$.mockHints.${id}.orderRefPrefix`);
}

function offer(
  value: unknown,
  eventId: string,
  currency: CurrencyCode,
  path: string,
  hints: Json,
): InventoryOffer {
  const o = obj(value, path);
  if (o.eventId !== undefined && o.eventId !== eventId) bad(`${path}.eventId`, 'mismatch');
  const delivery = str(o.deliveryMethod, `${path}.deliveryMethod`);
  if (!DELIVERY.has(delivery)) bad(`${path}.deliveryMethod`, `unknown "${delivery}"`);
  const purchaseMode = str(o.purchaseMode, `${path}.purchaseMode`);
  if (purchaseMode !== 'api' && purchaseMode !== 'redirect_only') {
    bad(`${path}.purchaseMode`, 'expected api | redirect_only');
  }
  const checkoutUrl = optStr(o.checkoutUrl, `${path}.checkoutUrl`);
  if (purchaseMode === 'redirect_only' && checkoutUrl === undefined) {
    bad(`${path}.checkoutUrl`, 'redirect_only offers need a checkoutUrl');
  }
  const maxPerOrder = int(o.maxPerOrder, `${path}.maxPerOrder`, 1);
  const seats = seating(o.seating, `${path}.seating`);
  const entryBefore = optIso(o.entryBefore, `${path}.entryBefore`);
  const holdMinutes =
    o.holdMinutes === undefined ? undefined : int(o.holdMinutes, `${path}.holdMinutes`, 1);
  const offerId = str(o.offerId, `${path}.offerId`);
  const orderPrefix = optPrefix(o.orderPrefix, `${path}.orderPrefix`) ?? hintPrefix(hints, offerId);
  const ticketOffer: TicketOffer = {
    offerId,
    eventId,
    tierName: str(o.tierName, `${path}.tierName`),
    unitPrice: moneyField(o, 'unitPrice', currency, path),
    unitFees: moneyField(o, 'unitFees', currency, path),
    available: int(o.available, `${path}.available`),
    maxPerOrder,
    refundPolicy: refundPolicy(o.refundPolicy, currency, `${path}.refundPolicy`),
    deliveryMethod: delivery as DeliveryMethod,
    requiresHolderNames: bool(o.requiresHolderNames, `${path}.requiresHolderNames`),
    purchaseMode,
    ...(checkoutUrl !== undefined ? { checkoutUrl } : {}),
  };
  return {
    offer: ticketOffer,
    ...(seats !== undefined ? { seating: seats } : {}),
    ...(entryBefore !== undefined ? { entryBefore } : {}),
    ...(holdMinutes !== undefined ? { holdMinutes } : {}),
    ...(orderPrefix !== undefined ? { orderPrefix } : {}),
  };
}

/** Validate fixture JSON and map it to a `TicketInventory`. */
export function parseTicketInventory(json: unknown): TicketInventory {
  const root = obj(json, '$');
  const currency = str(root.currency, '$.currency');
  if (!/^[A-Z]{3}$/.test(currency)) bad('$.currency', 'expected an ISO 4217 code');
  const provider = root.provider === undefined ? 'mock-tickets' : str(root.provider, '$.provider');
  const holdMinutes = int(root.holdMinutes ?? 15, '$.holdMinutes', 1);
  const flatOffers = root.offers === undefined ? [] : arr(root.offers, '$.offers');
  const hints = root.mockHints === undefined ? {} : obj(root.mockHints, '$.mockHints');
  const rootPrefix = optPrefix(root.orderPrefix, '$.orderPrefix') ?? 'TK';
  const homeCity = optStr(root.city, '$.city');
  const tripCities = arr(root.tripCities ?? [], '$.tripCities').map((c, i) =>
    str(c, `$.tripCities[${i}]`),
  );
  const cities: string[] = [];
  for (const c of [...(homeCity !== undefined ? [homeCity] : []), ...tripCities]) {
    if (!cities.includes(c)) cities.push(c);
  }

  const seenEvents = new Set<string>();
  const seenOffers = new Set<string>();
  const events = arr(root.events, '$.events').map((raw, i): InventoryEvent => {
    const path = `$.events[${i}]`;
    const e = obj(raw, path);
    const eventId = str(e.eventId, `${path}.eventId`);
    if (seenEvents.has(eventId)) bad(`${path}.eventId`, `duplicate "${eventId}"`);
    seenEvents.add(eventId);
    const category = str(e.category, `${path}.category`);
    if (!CATEGORIES.has(category)) bad(`${path}.category`, `unknown "${category}"`);
    const flags = arr(e.contentFlags ?? [], `${path}.contentFlags`).map((f, j) => {
      const flag = str(f, `${path}.contentFlags[${j}]`);
      if (!CONTENT_FLAGS.has(flag)) bad(`${path}.contentFlags[${j}]`, `unknown "${flag}"`);
      return flag as TicketEvent['contentFlags'][number];
    });
    const startsAt = iso(e.startsAt, `${path}.startsAt`);
    const endsAt = optIso(e.endsAt, `${path}.endsAt`);
    const doorsAt = optIso(e.doorsAt, `${path}.doorsAt`);
    const minimumAge =
      e.minimumAge === undefined ? undefined : int(e.minimumAge, `${path}.minimumAge`);
    const imageUrl = optStr(e.imageUrl, `${path}.imageUrl`);
    const url = optStr(e.url, `${path}.url`);
    const event: TicketEvent = {
      eventId,
      provider,
      name: str(e.name, `${path}.name`),
      category: category as EventCategory,
      venue: place(e.venue, `${path}.venue`),
      startsAt,
      contentFlags: flags,
      ...(endsAt !== undefined ? { endsAt } : {}),
      ...(doorsAt !== undefined ? { doorsAt } : {}),
      ...(minimumAge !== undefined ? { minimumAge } : {}),
      ...(imageUrl !== undefined ? { imageUrl } : {}),
      ...(url !== undefined ? { url } : {}),
    };
    const nested = e.offers === undefined ? [] : arr(e.offers, `${path}.offers`);
    const offers = [
      ...nested.map((o, j) => offer(o, eventId, currency, `${path}.offers[${j}]`, hints)),
      ...flatOffers.flatMap((o, j) =>
        obj(o, `$.offers[${j}]`).eventId === eventId
          ? [offer(o, eventId, currency, `$.offers[${j}]`, hints)]
          : [],
      ),
    ];
    for (const o of offers) {
      if (seenOffers.has(o.offer.offerId)) bad(path, `duplicate offerId "${o.offer.offerId}"`);
      seenOffers.add(o.offer.offerId);
    }
    const salesEndAt = optIso(e.salesEndAt, `${path}.salesEndAt`) ?? endsAt ?? startsAt;
    return {
      event,
      orderPrefix:
        optPrefix(e.orderPrefix, `${path}.orderPrefix`) ?? hintPrefix(hints, eventId) ?? rootPrefix,
      salesEndAt,
      keywords: arr(e.keywords ?? [], `${path}.keywords`).map((k, j) =>
        str(k, `${path}.keywords[${j}]`),
      ),
      offers,
    };
  });

  flatOffers.forEach((o, j) => {
    const eventId = str(obj(o, `$.offers[${j}]`).eventId, `$.offers[${j}].eventId`);
    if (!seenEvents.has(eventId)) bad(`$.offers[${j}].eventId`, `unknown event "${eventId}"`);
  });

  return {
    name: str(root.name, '$.name'),
    provider,
    currency,
    holdMinutes,
    cities,
    events,
  };
}

const BUNDLED: Readonly<Record<string, unknown>> = {
  barcelona: barcelonaJson,
  lisbon: lisbonJson,
  'turks-and-caicos': turksAndCaicosJson,
};

/** Names of the bundled ticket fixtures (`fixtures/tickets/<name>.json`). */
export const TICKET_INVENTORY_NAMES: readonly string[] = Object.keys(BUNDLED);

/** Parse a bundled fixture. Throws `not_found` for an unknown name. */
export function loadTicketInventory(name: string): TicketInventory {
  const raw = BUNDLED[name];
  if (raw === undefined) {
    throw new TravError('not_found', `no ticket inventory fixture "${name}"`, { name });
  }
  return parseTicketInventory(raw);
}

/** Every bundled fixture, parsed, in `TICKET_INVENTORY_NAMES` order (one city each). */
export function loadAllTicketInventories(): readonly TicketInventory[] {
  return TICKET_INVENTORY_NAMES.map(loadTicketInventory);
}
