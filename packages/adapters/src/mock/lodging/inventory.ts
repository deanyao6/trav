/**
 * Lodging inventory for the mock LodgingAdapter: types, a validating mapper
 * from fixture JSON, and the bundled fixtures.
 *
 * Fixture shape (`fixtures/lodging/barcelona.json`, written by the
 * synthetic-data generator `barcelonaLodging()`): one stay window
 * (`checkIn`/`checkOut`), `results[]` already shaped like
 * `LodgingSearchResult` (Hotelbeds/Expedia-style property + rates, Money as
 * integer minor units), and `mockHints` keyed by rate or property id:
 *
 * - rate hints: `recheck: { expect: 'price_changed', newAmount } | { expect: 'sold_out' }`
 *   (what the provider's live price/availability turns out to be on recheck/book),
 *   `soldOut: true` (never listed; recheck/book return `sold_out`),
 *   `units` (bookable units, default 1), `confirmationPrefix`, `checkInInstructions`;
 * - property hints: `messageProperty: 'supported' | 'not_supported'` (default:
 *   `not_supported` for `vacation_rental`, Airbnb-style listings have no host
 *   messaging API; `supported` otherwise), `checkInFrom`/`checkOutBy` ("HH:MM").
 *
 * The JSON is imported statically (no `fs`). `barcelona-fixed` is a private
 * copy owned by this module's tests so fixed-value assertions do not depend on
 * whatever the shared fixture generator writes next. All listings are fictional.
 * Malformed fixtures throw `TravError('invalid_argument')` naming the path.
 */
import type { CurrencyCode, IsoDate, Money, TimeZone } from '@trav/core';
import { TravError, addDays, money, parseIso } from '@trav/core';
import type { RefundPolicy } from '../../interfaces/common.js';
import type { LodgingProperty, LodgingRate, PropertyKind } from '../../interfaces/lodging.js';
import barcelonaFixedJson from './barcelona.fixed.json' with { type: 'json' };
import barcelonaJson from '../../../../../fixtures/lodging/barcelona.json' with { type: 'json' };

export type HostMessaging = 'supported' | 'not_supported';

export type RecheckOutcome =
  | { readonly kind: 'price_changed'; readonly newAmount: Money }
  | { readonly kind: 'sold_out' };

export interface InventoryRate {
  /** The rate as cached by search (price before any recheck). */
  readonly rate: LodgingRate;
  /** What the provider says on recheck/book, if it differs from the cache. */
  readonly recheck?: RecheckOutcome;
  /** Sold out before anyone searched: never listed. */
  readonly soldOut: boolean;
  /** Bookable units of this rate (a whole apartment is 1). */
  readonly units: number;
  readonly confirmationPrefix: string;
  readonly checkInInstructions?: string;
}

export interface InventoryProperty {
  readonly property: LodgingProperty;
  readonly timeZone: TimeZone;
  readonly hostMessaging: HostMessaging;
  readonly checkInFrom?: string;
  readonly checkOutBy?: string;
  readonly rates: readonly InventoryRate[];
}

export interface LodgingInventory {
  readonly name: string;
  readonly provider: string;
  readonly city: string;
  readonly currency: CurrencyCode;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly properties: readonly InventoryProperty[];
}

const KINDS: ReadonlySet<string> = new Set<PropertyKind>([
  'hotel',
  'apartment',
  'hostel',
  'vacation_rental',
]);
const BOARD: ReadonlySet<string> = new Set([
  'room_only',
  'breakfast',
  'half_board',
  'full_board',
  'all_inclusive',
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PREFIX_RE = /^[A-Z]{2,4}$/;

type Obj = Record<string, unknown>;

function bad(path: string, msg: string): never {
  throw new TravError('invalid_argument', `lodging fixture ${path}: ${msg}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(path, 'expected an object');
  return v as Obj;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) bad(path, 'expected a non-empty string');
  return v;
}

function optStr(v: unknown, path: string): string | undefined {
  return v === undefined ? undefined : str(v, path);
}

function num(v: unknown, path: string, opts: { int?: boolean; min?: number; max?: number } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(path, 'expected a number');
  if (opts.int && !Number.isInteger(v)) bad(path, 'expected an integer');
  if (opts.min !== undefined && v < opts.min) bad(path, `must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) bad(path, `must be <= ${opts.max}`);
  return v;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) bad(path, 'expected an array');
  return v;
}

function date(v: unknown, path: string): IsoDate {
  const s = str(v, path);
  if (!DATE_RE.test(s)) bad(path, 'expected YYYY-MM-DD');
  try {
    if (addDays(s, 0) !== s) bad(path, 'not a calendar date');
  } catch {
    bad(path, 'not a calendar date');
  }
  return s;
}

function instant(v: unknown, path: string): string {
  const s = str(v, path);
  try {
    parseIso(s);
  } catch {
    bad(path, 'expected an ISO date-time with offset');
  }
  return s;
}

function moneyOf(v: unknown, path: string, currency: CurrencyCode): Money {
  const o = obj(v, path);
  const amount = num(o.amountMinor, `${path}.amountMinor`, { int: true, min: 0 });
  const cur = str(o.currency, `${path}.currency`);
  if (cur !== currency) bad(`${path}.currency`, `expected ${currency}, got ${cur}`);
  return money(amount, cur);
}

function hhmm(v: unknown, path: string): string | undefined {
  if (v === undefined) return undefined;
  const s = str(v, path);
  if (!HHMM_RE.test(s)) bad(path, 'expected HH:MM');
  return s;
}

function parseProperty(v: unknown, path: string): { property: LodgingProperty; timeZone: string } {
  const o = obj(v, path);
  const kind = str(o.kind, `${path}.kind`);
  if (!KINDS.has(kind)) bad(`${path}.kind`, `unknown kind ${kind}`);
  const p = obj(o.place, `${path}.place`);
  const timeZone = str(p.timeZone, `${path}.place.timeZone`);
  const geoRaw = p.geo === undefined ? undefined : obj(p.geo, `${path}.place.geo`);
  const geo = geoRaw && {
    lat: num(geoRaw.lat, `${path}.place.geo.lat`, { min: -90, max: 90 }),
    lon: num(geoRaw.lon, `${path}.place.geo.lon`, { min: -180, max: 180 }),
  };
  const address = optStr(p.address, `${path}.place.address`);
  const place = {
    name: str(p.name, `${path}.place.name`),
    city: str(p.city, `${path}.place.city`),
    countryCode: str(p.countryCode, `${path}.place.countryCode`),
    timeZone,
    ...(address !== undefined ? { address } : {}),
    ...(geo ? { geo } : {}),
  };
  const strings = (x: unknown, at: string) => arr(x, at).map((s, i) => str(s, `${at}[${i}]`));
  const property: LodgingProperty = {
    propertyId: str(o.propertyId, `${path}.propertyId`),
    provider: str(o.provider, `${path}.provider`),
    name: str(o.name, `${path}.name`),
    kind: kind as PropertyKind,
    place,
    amenities: strings(o.amenities ?? [], `${path}.amenities`),
    photoUrls: strings(o.photoUrls ?? [], `${path}.photoUrls`),
    maxOccupancy: num(o.maxOccupancy, `${path}.maxOccupancy`, { int: true, min: 1 }),
    ...(o.starRating !== undefined
      ? { starRating: num(o.starRating, `${path}.starRating`, { min: 0, max: 5 }) }
      : {}),
    ...(o.reviewScore !== undefined
      ? { reviewScore: num(o.reviewScore, `${path}.reviewScore`, { min: 0, max: 10 }) }
      : {}),
    ...(o.bedrooms !== undefined
      ? { bedrooms: num(o.bedrooms, `${path}.bedrooms`, { int: true, min: 0 }) }
      : {}),
    ...(o.url !== undefined ? { url: str(o.url, `${path}.url`) } : {}),
  };
  return { property, timeZone };
}

function parseRefundPolicy(v: unknown, path: string, currency: CurrencyCode): RefundPolicy {
  const o = obj(v, path);
  if (typeof o.refundable !== 'boolean') bad(`${path}.refundable`, 'expected a boolean');
  const until =
    o.refundableUntil === undefined || o.refundableUntil === null
      ? undefined
      : instant(o.refundableUntil, `${path}.refundableUntil`);
  if (o.refundable && until === undefined) {
    bad(`${path}.refundableUntil`, 'a refundable rate needs a deadline');
  }
  const summary = optStr(o.summary, `${path}.summary`);
  return {
    refundable: o.refundable,
    ...(o.refundable && until !== undefined ? { refundableUntil: until } : {}),
    ...(o.penalty !== undefined
      ? { penalty: moneyOf(o.penalty, `${path}.penalty`, currency) }
      : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function parseRate(
  v: unknown,
  path: string,
  propertyId: string,
  currency: CurrencyCode,
): LodgingRate {
  const o = obj(v, path);
  const pid = str(o.propertyId ?? propertyId, `${path}.propertyId`);
  if (pid !== propertyId) bad(`${path}.propertyId`, `does not match ${propertyId}`);
  const board = o.boardBasis === undefined ? undefined : str(o.boardBasis, `${path}.boardBasis`);
  if (board !== undefined && !BOARD.has(board)) bad(`${path}.boardBasis`, `unknown ${board}`);
  const totalAmount = moneyOf(o.totalAmount, `${path}.totalAmount`, currency);
  if (totalAmount.amountMinor <= 0) bad(`${path}.totalAmount`, 'must be positive');
  return {
    rateId: str(o.rateId, `${path}.rateId`),
    propertyId,
    roomName: str(o.roomName, `${path}.roomName`),
    sleeps: num(o.sleeps, `${path}.sleeps`, { int: true, min: 1 }),
    totalAmount,
    ...(o.payAtProperty !== undefined
      ? { payAtProperty: moneyOf(o.payAtProperty, `${path}.payAtProperty`, currency) }
      : {}),
    refundPolicy: parseRefundPolicy(o.refundPolicy, `${path}.refundPolicy`, currency),
    ...(board !== undefined ? { boardBasis: board as NonNullable<LodgingRate['boardBasis']> } : {}),
    needsRecheck: o.needsRecheck === undefined ? true : o.needsRecheck === true,
  };
}

function parseRecheck(v: unknown, path: string, currency: CurrencyCode): RecheckOutcome {
  const o = obj(v, path);
  const expect = str(o.expect, `${path}.expect`);
  if (expect === 'sold_out') return { kind: 'sold_out' };
  if (expect === 'price_changed') {
    const newAmount = moneyOf(o.newAmount, `${path}.newAmount`, currency);
    if (newAmount.amountMinor <= 0) bad(`${path}.newAmount`, 'must be positive');
    return { kind: 'price_changed', newAmount };
  }
  return bad(`${path}.expect`, `unknown recheck outcome ${expect}`);
}

/** Validates fixture JSON into a `LodgingInventory`. Throws `TravError` on bad data. */
export function parseLodgingInventory(json: unknown, name = 'inline'): LodgingInventory {
  const root = obj(json, '$');
  const provider = str(root.provider, '$.provider');
  const checkIn = date(root.checkIn, '$.checkIn');
  const checkOut = date(root.checkOut, '$.checkOut');
  if (checkOut <= checkIn) bad('$.checkOut', 'must be after checkIn');
  const results = arr(root.results, '$.results');
  if (results.length === 0) bad('$.results', 'expected at least one property');
  const hints = root.mockHints === undefined ? {} : obj(root.mockHints, '$.mockHints');
  const hint = (id: string): Obj =>
    hints[id] === undefined ? {} : obj(hints[id], `$.mockHints.${id}`);

  const firstRates = arr(obj(results[0], '$.results[0]').rates, '$.results[0].rates');
  const firstRate = obj(firstRates[0], '$.results[0].rates[0]');
  const currency = str(
    obj(firstRate.totalAmount, '$.results[0].rates[0].totalAmount').currency,
    '$.results[0].rates[0].totalAmount.currency',
  );

  const seenProps = new Set<string>();
  const seenRates = new Set<string>();
  const properties = results.map((r, i): InventoryProperty => {
    const at = `$.results[${i}]`;
    const ro = obj(r, at);
    const { property, timeZone } = parseProperty(ro.property, `${at}.property`);
    if (seenProps.has(property.propertyId)) bad(at, `duplicate property ${property.propertyId}`);
    seenProps.add(property.propertyId);
    const ph = hint(property.propertyId);
    const hm = ph.messageProperty;
    if (hm !== undefined && hm !== 'supported' && hm !== 'not_supported') {
      bad(`$.mockHints.${property.propertyId}.messageProperty`, 'expected supported|not_supported');
    }
    const hostMessaging: HostMessaging =
      (hm as HostMessaging | undefined) ??
      (property.kind === 'vacation_rental' ? 'not_supported' : 'supported');
    const rateList = arr(ro.rates, `${at}.rates`);
    if (rateList.length === 0) bad(`${at}.rates`, 'expected at least one rate');
    const rates = rateList.map((rv, j): InventoryRate => {
      const rat = `${at}.rates[${j}]`;
      const rate = parseRate(rv, rat, property.propertyId, currency);
      if (seenRates.has(rate.rateId)) bad(rat, `duplicate rate ${rate.rateId}`);
      seenRates.add(rate.rateId);
      if (rate.sleeps > property.maxOccupancy) bad(`${rat}.sleeps`, 'exceeds maxOccupancy');
      const rh = hint(rate.rateId);
      const hp = `$.mockHints.${rate.rateId}`;
      if (rh.soldOut !== undefined && typeof rh.soldOut !== 'boolean') {
        bad(`${hp}.soldOut`, 'expected a boolean');
      }
      const prefix = rh.confirmationPrefix === undefined ? 'TRV' : str(rh.confirmationPrefix, hp);
      if (!PREFIX_RE.test(prefix)) bad(`${hp}.confirmationPrefix`, 'expected 2-4 capitals');
      const instructions = optStr(rh.checkInInstructions, `${hp}.checkInInstructions`);
      return {
        rate,
        ...(rh.recheck !== undefined
          ? { recheck: parseRecheck(rh.recheck, `${hp}.recheck`, currency) }
          : {}),
        soldOut: rh.soldOut === true,
        units: rh.units === undefined ? 1 : num(rh.units, `${hp}.units`, { int: true, min: 1 }),
        confirmationPrefix: prefix,
        ...(instructions !== undefined ? { checkInInstructions: instructions } : {}),
      };
    });
    const checkInFrom = hhmm(ph.checkInFrom, `$.mockHints.${property.propertyId}.checkInFrom`);
    const checkOutBy = hhmm(ph.checkOutBy, `$.mockHints.${property.propertyId}.checkOutBy`);
    return {
      property,
      timeZone,
      hostMessaging,
      ...(checkInFrom !== undefined ? { checkInFrom } : {}),
      ...(checkOutBy !== undefined ? { checkOutBy } : {}),
      rates,
    };
  });

  return {
    name,
    provider,
    city: str(root.city, '$.city'),
    currency,
    checkIn,
    checkOut,
    properties,
  };
}

const BUNDLED: Readonly<Record<string, unknown>> = {
  barcelona: barcelonaJson,
  'barcelona-fixed': barcelonaFixedJson,
};

/** Bundled inventory names: the shared fixture and this module's private copy. */
export const LODGING_INVENTORY_NAMES: readonly string[] = Object.keys(BUNDLED);

/** Loads a bundled inventory by name. Throws `TravError('not_found')` for unknown names. */
export function loadLodgingInventory(name: string): LodgingInventory {
  const json = BUNDLED[name];
  if (json === undefined) throw new TravError('not_found', `no lodging inventory "${name}"`);
  return parseLodgingInventory(json, name);
}
