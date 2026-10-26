/**
 * Mock flight inventory: parses `fixtures/flights/<name>.json` into offer
 * templates. Two fixture shapes are accepted (auto-detected):
 *
 * 1. **Duffel wire shape** (snake_case, `total_amount: "412.00"`, local
 *    wall-clock `departing_at` + IANA zone; amounts PER PASSENGER; mock
 *    controls `expires_after_minutes` / `mock_reprice`). This is the adapter
 *    edge, so it does what a real Duffel adapter would: decimal strings →
 *    integer minor units (`parseDecimal`), local times → ISO-8601 with offset,
 *    durations → ISO-8601 durations.
 * 2. **Normalized shape** (the synthetic-data generator's output): offers that
 *    already match the `FlightOffer` interface (Money objects, offset-carrying
 *    ISO times), `members[]`, and `mockHints[offerId]`
 *    (`expiresInMinutes`, `priceOnRecheck`). Totals are divided by the offer's
 *    passenger count to get per-passenger fares.
 *
 * Either way the mock multiplies per-passenger fares by the passenger count of
 * each search. All carriers in the fixtures are fictional.
 */
import {
  TravError,
  formatIso,
  parseDecimal,
  parseIso,
  zoneOffsetMinutes,
  zonedWallTimeToMs,
} from '@trav/core';
import type { Money } from '@trav/core';
import type { Carrier, FlightSegment, FlightSlice } from '../../interfaces/flights.js';
import { loadFixture } from '../fixtures.js';

/** Per-passenger condition (penalty is per passenger, scaled on instantiation). */
export interface TemplateCondition {
  readonly allowed: boolean;
  readonly penaltyPerPassenger?: Money;
}

export interface FlightOfferTemplate {
  /** Stable fixture id, e.g. "bos-jfk-1". Search returns fresh offer ids per search. */
  readonly templateId: string;
  readonly owner: Carrier;
  readonly perPassengerTotal: Money;
  readonly perPassengerBase: Money;
  readonly perPassengerTax: Money;
  readonly refundBeforeDeparture: TemplateCondition;
  readonly changeBeforeDeparture: TemplateCondition;
  readonly requiresInstantPayment: boolean;
  /** Minutes of simulated time an offer stays valid after the search. */
  readonly ttlMinutes: number;
  /**
   * Mock control: after this many minutes since the search (0 = on the first
   * re-check), the per-passenger total changes.
   */
  readonly reprice?: { readonly afterMinutes: number; readonly perPassengerTotal: Money };
  readonly slices: readonly FlightSlice[];
}

export interface FixtureTraveler {
  readonly memberId: string;
  readonly name?: string;
  readonly origin: string;
  readonly returnTo: string;
}

export interface MockFlightInventory {
  readonly provider: string;
  readonly currency: string;
  readonly templates: readonly FlightOfferTemplate[];
  /** Who flies from/to where in this scenario (for demos, evals and the optimizer). */
  readonly travelers: readonly FixtureTraveler[];
}

// ---------- small validators (fixture errors are programmer errors ⇒ throw) ----------

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new TravError('invalid_argument', `flight fixture ${path}: ${msg}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected object');
  return v as Obj;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected array');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(path, 'expected non-empty string');
  return v;
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'expected boolean');
  return v;
}

function posInt(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    fail(path, 'expected positive integer');
  }
  return v;
}

const IATA_AIRPORT_RE = /^[A-Z]{3}$/;
const LOCAL_DT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00)?$/;

function airport(v: unknown, path: string): string {
  const s = str(v, path);
  if (!IATA_AIRPORT_RE.test(s)) fail(path, `bad airport code "${s}"`);
  return s;
}

function amount(v: unknown, currency: string, path: string): Money {
  const m = parseDecimal(str(v, path), currency);
  if (m.amountMinor < 0) fail(path, 'amount must be >= 0');
  return m;
}

/** "2026-03-12T07:10:00" in "America/New_York" → "2026-03-12T07:10:00-04:00". */
export function localToIso(local: string, tz: string, path = 'time'): string {
  const match = LOCAL_DT_RE.exec(local);
  if (!match) fail(path, `expected local date-time "YYYY-MM-DDTHH:MM[:00]", got "${local}"`);
  const [, date = '', hh = '', mm = ''] = match;
  const ms = zonedWallTimeToMs(date, Number(hh), Number(mm), tz);
  const iso = formatIso(ms, zoneOffsetMinutes(ms, tz));
  // A wall time inside a DST gap does not exist; refuse rather than silently shift.
  if (!iso.startsWith(`${date}T${hh}:${mm}`)) fail(path, `"${local}" does not exist in ${tz}`);
  return iso;
}

/** 445 → "PT7H25M"; 0 → "PT0M". */
export function minutesToIsoDuration(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new TravError('invalid_argument', `duration minutes must be >= 0, got ${minutes}`);
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `PT${m}M`;
  return m === 0 ? `PT${h}H` : `PT${h}H${m}M`;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((parseIso(b) - parseIso(a)) / 60_000);
}

function parseCondition(v: unknown, currency: string, path: string): TemplateCondition {
  const o = obj(v, path);
  const allowed = bool(o['allowed'], `${path}.allowed`);
  if (o['penalty_amount'] === undefined) return { allowed };
  return {
    allowed,
    penaltyPerPassenger: amount(o['penalty_amount'], currency, `${path}.penalty_amount`),
  };
}

function parseSegment(
  v: unknown,
  carriers: ReadonlyMap<string, Carrier>,
  path: string,
): FlightSegment {
  const o = obj(v, path);
  const carrierOf = (key: string): Carrier => {
    const code = str(o[key], `${path}.${key}`);
    const c = carriers.get(code);
    if (!c) fail(`${path}.${key}`, `unknown carrier "${code}"`);
    return c;
  };
  const departureTimeZone = str(o['departure_time_zone'], `${path}.departure_time_zone`);
  const arrivalTimeZone = str(o['arrival_time_zone'], `${path}.arrival_time_zone`);
  const departingAt = localToIso(
    str(o['departing_at'], `${path}.departing_at`),
    departureTimeZone,
    `${path}.departing_at`,
  );
  const arrivingAt = localToIso(
    str(o['arriving_at'], `${path}.arriving_at`),
    arrivalTimeZone,
    `${path}.arriving_at`,
  );
  const minutes = minutesBetween(departingAt, arrivingAt);
  if (minutes <= 0) fail(path, 'arrives before it departs');
  const segment: FlightSegment = {
    origin: airport(o['origin'], `${path}.origin`),
    destination: airport(o['destination'], `${path}.destination`),
    departingAt,
    departureTimeZone,
    arrivingAt,
    arrivalTimeZone,
    marketingCarrier: carrierOf('marketing_carrier'),
    flightNumber: str(o['flight_number'], `${path}.flight_number`),
    duration: minutesToIsoDuration(minutes),
  };
  return o['operating_carrier'] === undefined
    ? segment
    : { ...segment, operatingCarrier: carrierOf('operating_carrier') };
}

function parseSlice(v: unknown, carriers: ReadonlyMap<string, Carrier>, path: string): FlightSlice {
  const segs = arr(obj(v, path)['segments'], `${path}.segments`).map((s, i) =>
    parseSegment(s, carriers, `${path}.segments[${i}]`),
  );
  return buildSlice(segs, path);
}

/** Checks the segments connect in order and derives the slice's endpoints and duration. */
function buildSlice(segs: readonly FlightSegment[], path: string): FlightSlice {
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (!first || !last) fail(path, 'slice needs at least one segment');
  for (let i = 1; i < segs.length; i += 1) {
    const prev = segs[i - 1];
    const next = segs[i];
    if (!prev || !next) continue;
    if (prev.destination !== next.origin) fail(path, `segment ${i} does not connect`);
    if (minutesBetween(prev.arrivingAt, next.departingAt) <= 0) {
      fail(path, `segment ${i} departs before the previous one lands`);
    }
  }
  return {
    origin: first.origin,
    destination: last.destination,
    duration: minutesToIsoDuration(minutesBetween(first.departingAt, last.arrivingAt)),
    segments: segs,
  };
}

/**
 * Validates and normalizes a fixture object of either supported shape.
 * Throws `TravError('invalid_argument')` on bad data.
 */
export function parseMockFlightInventory(raw: unknown): MockFlightInventory {
  const root = obj(raw, '$');
  const first = Array.isArray(root['offers']) ? (root['offers'] as unknown[])[0] : undefined;
  const normalized =
    typeof first === 'object' && first !== null && 'offerId' in first && 'totalAmount' in first;
  return normalized ? parseNormalizedInventory(root) : parseDuffelWireInventory(root);
}

// ---------- shape 2: normalized (FlightOffer-like) ----------

function moneyObj(v: unknown, currency: string, path: string): Money {
  const o = obj(v, path);
  const amountMinor = o['amountMinor'];
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    fail(`${path}.amountMinor`, 'expected a non-negative integer');
  }
  if (o['currency'] !== currency) fail(`${path}.currency`, `expected ${currency}`);
  return { amountMinor, currency };
}

function perPassenger(m: Money, n: number, path: string): Money {
  if (m.amountMinor % n !== 0) fail(path, `amount does not divide evenly across ${n} passengers`);
  return { amountMinor: m.amountMinor / n, currency: m.currency };
}

function carrierObj(v: unknown, path: string): Carrier {
  const o = obj(v, path);
  return { iataCode: str(o['iataCode'], `${path}.iataCode`), name: str(o['name'], `${path}.name`) };
}

function isoWithOffset(v: unknown, path: string): string {
  const s = str(v, path);
  try {
    parseIso(s);
  } catch {
    fail(path, `expected ISO-8601 date-time with offset, got "${s}"`);
  }
  return s;
}

function normalizedSegment(v: unknown, path: string): FlightSegment {
  const o = obj(v, path);
  const departingAt = isoWithOffset(o['departingAt'], `${path}.departingAt`);
  const arrivingAt = isoWithOffset(o['arrivingAt'], `${path}.arrivingAt`);
  const minutes = minutesBetween(departingAt, arrivingAt);
  if (minutes <= 0) fail(path, 'arrives before it departs');
  const segment: FlightSegment = {
    origin: airport(o['origin'], `${path}.origin`),
    destination: airport(o['destination'], `${path}.destination`),
    departingAt,
    departureTimeZone: str(o['departureTimeZone'], `${path}.departureTimeZone`),
    arrivingAt,
    arrivalTimeZone: str(o['arrivalTimeZone'], `${path}.arrivalTimeZone`),
    marketingCarrier: carrierObj(o['marketingCarrier'], `${path}.marketingCarrier`),
    flightNumber: str(o['flightNumber'], `${path}.flightNumber`),
    duration: minutesToIsoDuration(minutes),
  };
  return o['operatingCarrier'] === undefined
    ? segment
    : {
        ...segment,
        operatingCarrier: carrierObj(o['operatingCarrier'], `${path}.operatingCarrier`),
      };
}

function normalizedCondition(
  v: unknown,
  currency: string,
  n: number,
  path: string,
): TemplateCondition {
  const o = obj(v, path);
  const allowed = bool(o['allowed'], `${path}.allowed`);
  if (o['penalty'] === undefined) return { allowed };
  return {
    allowed,
    penaltyPerPassenger: perPassenger(moneyObj(o['penalty'], currency, `${path}.penalty`), n, path),
  };
}

function parseNormalizedInventory(root: Obj): MockFlightInventory {
  const currency = str(root['currency'], '$.currency');
  if (!/^[A-Z]{3}$/.test(currency)) fail('$.currency', `bad currency "${currency}"`);
  const defaultTtl =
    root['default_offer_ttl_minutes'] === undefined
      ? 30
      : posInt(root['default_offer_ttl_minutes'], '$.default_offer_ttl_minutes');
  const hints = root['mockHints'] === undefined ? {} : obj(root['mockHints'], '$.mockHints');

  const seen = new Set<string>();
  const templates = arr(root['offers'], '$.offers').map((v, i): FlightOfferTemplate => {
    const path = `$.offers[${i}]`;
    const o = obj(v, path);
    const templateId = str(o['offerId'], `${path}.offerId`);
    if (seen.has(templateId)) fail(path, `duplicate offer id "${templateId}"`);
    seen.add(templateId);
    const passengerIds = arr(o['passengerIds'], `${path}.passengerIds`);
    const n = passengerIds.length;
    if (n === 0) fail(`${path}.passengerIds`, 'expected at least one passenger');

    const total = moneyObj(o['totalAmount'], currency, `${path}.totalAmount`);
    const perPassengerTotal = perPassenger(total, n, `${path}.totalAmount`);
    let perPassengerTax: Money = { amountMinor: 0, currency };
    let perPassengerBase = perPassengerTotal;
    if (o['taxAmount'] !== undefined) {
      perPassengerTax = perPassenger(
        moneyObj(o['taxAmount'], currency, `${path}.taxAmount`),
        n,
        `${path}.taxAmount`,
      );
      perPassengerBase = {
        amountMinor: perPassengerTotal.amountMinor - perPassengerTax.amountMinor,
        currency,
      };
      if (perPassengerBase.amountMinor < 0) fail(path, 'taxAmount exceeds totalAmount');
    }
    if (o['baseAmount'] !== undefined) {
      const base = moneyObj(o['baseAmount'], currency, `${path}.baseAmount`);
      if (base.amountMinor !== perPassengerBase.amountMinor * n) {
        fail(path, 'baseAmount + taxAmount must equal totalAmount');
      }
    }

    const conditions = obj(o['conditions'], `${path}.conditions`);
    const payment = obj(o['paymentRequirements'], `${path}.paymentRequirements`);
    const slices = arr(o['slices'], `${path}.slices`).map((s, j) => {
      const sp = `${path}.slices[${j}]`;
      return buildSlice(
        arr(obj(s, sp)['segments'], `${sp}.segments`).map((g, k) =>
          normalizedSegment(g, `${sp}.segments[${k}]`),
        ),
        sp,
      );
    });
    if (slices.length === 0) fail(path, 'offer needs at least one slice');

    const hint =
      hints[templateId] === undefined ? {} : obj(hints[templateId], `$.mockHints.${templateId}`);
    const template: FlightOfferTemplate = {
      templateId,
      owner: carrierObj(o['owner'], `${path}.owner`),
      perPassengerTotal,
      perPassengerBase,
      perPassengerTax,
      refundBeforeDeparture: normalizedCondition(
        conditions['refundBeforeDeparture'],
        currency,
        n,
        `${path}.conditions.refundBeforeDeparture`,
      ),
      changeBeforeDeparture: normalizedCondition(
        conditions['changeBeforeDeparture'],
        currency,
        n,
        `${path}.conditions.changeBeforeDeparture`,
      ),
      requiresInstantPayment: bool(
        payment['requiresInstantPayment'],
        `${path}.paymentRequirements.requiresInstantPayment`,
      ),
      ttlMinutes:
        hint['expiresInMinutes'] === undefined
          ? defaultTtl
          : posInt(hint['expiresInMinutes'], `$.mockHints.${templateId}.expiresInMinutes`),
      slices,
    };
    if (hint['priceOnRecheck'] === undefined) return template;
    const after = hint['repriceAfterMinutes'];
    if (
      after !== undefined &&
      (typeof after !== 'number' || !Number.isInteger(after) || after < 0)
    ) {
      fail(`$.mockHints.${templateId}.repriceAfterMinutes`, 'expected integer >= 0');
    }
    return {
      ...template,
      reprice: {
        afterMinutes: after ?? 0,
        perPassengerTotal: perPassenger(
          moneyObj(hint['priceOnRecheck'], currency, `$.mockHints.${templateId}.priceOnRecheck`),
          n,
          `$.mockHints.${templateId}.priceOnRecheck`,
        ),
      },
    };
  });

  const members = root['members'] === undefined ? [] : arr(root['members'], '$.members');
  const travelers = members.map((t, i): FixtureTraveler => {
    const o = obj(t, `$.members[${i}]`);
    const traveler: FixtureTraveler = {
      memberId: str(o['memberId'], `$.members[${i}].memberId`),
      origin: airport(o['origin'], `$.members[${i}].origin`),
      returnTo: airport(o['returnTo'], `$.members[${i}].returnTo`),
    };
    return o['name'] === undefined
      ? traveler
      : { ...traveler, name: str(o['name'], `$.members[${i}].name`) };
  });

  return {
    provider: root['provider'] === undefined ? 'mock-flights' : str(root['provider'], '$.provider'),
    currency,
    templates,
    travelers,
  };
}

// ---------- shape 1: Duffel wire (snake_case) ----------

function parseDuffelWireInventory(root: Obj): MockFlightInventory {
  const currency = str(root['currency'], '$.currency');
  if (!/^[A-Z]{3}$/.test(currency)) fail('$.currency', `bad currency "${currency}"`);
  const defaultTtl = posInt(root['default_offer_ttl_minutes'], '$.default_offer_ttl_minutes');

  const carriers = new Map<string, Carrier>();
  arr(root['carriers'], '$.carriers').forEach((c, i) => {
    const o = obj(c, `$.carriers[${i}]`);
    const iataCode = str(o['iata_code'], `$.carriers[${i}].iata_code`);
    carriers.set(iataCode, { iataCode, name: str(o['name'], `$.carriers[${i}].name`) });
  });

  const seen = new Set<string>();
  const templates = arr(root['offers'], '$.offers').map((v, i): FlightOfferTemplate => {
    const path = `$.offers[${i}]`;
    const o = obj(v, path);
    const templateId = str(o['id'], `${path}.id`);
    if (seen.has(templateId)) fail(path, `duplicate offer id "${templateId}"`);
    seen.add(templateId);
    const ownerCode = str(o['owner'], `${path}.owner`);
    const owner = carriers.get(ownerCode);
    if (!owner) fail(`${path}.owner`, `unknown carrier "${ownerCode}"`);

    const perPassengerTotal = amount(o['total_amount'], currency, `${path}.total_amount`);
    const perPassengerBase = amount(o['base_amount'], currency, `${path}.base_amount`);
    const perPassengerTax = amount(o['tax_amount'], currency, `${path}.tax_amount`);
    if (
      perPassengerBase.amountMinor + perPassengerTax.amountMinor !==
      perPassengerTotal.amountMinor
    ) {
      fail(path, 'base_amount + tax_amount must equal total_amount');
    }
    const conditions = obj(o['conditions'], `${path}.conditions`);
    const payment = obj(o['payment_requirements'], `${path}.payment_requirements`);
    const slices = arr(o['slices'], `${path}.slices`).map((s, j) =>
      parseSlice(s, carriers, `${path}.slices[${j}]`),
    );
    if (slices.length === 0) fail(path, 'offer needs at least one slice');

    const template: FlightOfferTemplate = {
      templateId,
      owner,
      perPassengerTotal,
      perPassengerBase,
      perPassengerTax,
      refundBeforeDeparture: parseCondition(
        conditions['refund_before_departure'],
        currency,
        `${path}.conditions.refund_before_departure`,
      ),
      changeBeforeDeparture: parseCondition(
        conditions['change_before_departure'],
        currency,
        `${path}.conditions.change_before_departure`,
      ),
      requiresInstantPayment: bool(
        payment['requires_instant_payment'],
        `${path}.payment_requirements.requires_instant_payment`,
      ),
      ttlMinutes:
        o['expires_after_minutes'] === undefined
          ? defaultTtl
          : posInt(o['expires_after_minutes'], `${path}.expires_after_minutes`),
      slices,
    };
    if (o['mock_reprice'] === undefined) return template;
    const rp = obj(o['mock_reprice'], `${path}.mock_reprice`);
    return {
      ...template,
      reprice: {
        afterMinutes: posInt(rp['after_minutes'], `${path}.mock_reprice.after_minutes`),
        perPassengerTotal: amount(
          rp['total_amount'],
          currency,
          `${path}.mock_reprice.total_amount`,
        ),
      },
    };
  });

  const travelers = (
    root['travelers'] === undefined ? [] : arr(root['travelers'], '$.travelers')
  ).map((t, i): FixtureTraveler => {
    const o = obj(t, `$.travelers[${i}]`);
    return {
      memberId: str(o['member_id'], `$.travelers[${i}].member_id`),
      name: str(o['name'], `$.travelers[${i}].name`),
      origin: airport(o['origin'], `$.travelers[${i}].origin`),
      returnTo: airport(o['return_to'], `$.travelers[${i}].return_to`),
    };
  });

  return {
    provider: root['provider'] === undefined ? 'mock-flights' : str(root['provider'], '$.provider'),
    currency,
    templates,
    travelers,
  };
}

/** Loads `fixtures/flights/<name>.json` (default: the Barcelona flagship inventory). */
export function loadMockFlightInventory(name = 'barcelona'): MockFlightInventory {
  return parseMockFlightInventory(loadFixture('flights', name));
}
