/**
 * Mock `LodgingAdapter` (T-008-b). Hotelbeds/Expedia-shaped
 * search → recheck → book over a fixture inventory (`./inventory.ts`).
 * No network, no wall clock, no randomness: every time-dependent rule reads
 * the injected Clock.
 *
 * - `search` serves the inventory's one stay window (other dates: no results),
 *   honors city/neighbourhood or geo+radius, occupancy, whole-unit, bedrooms,
 *   kinds, `maxTotal` and `refundableOnly`. Results list refundable options
 *   first, then cheapest. Sold-out rates (fixture `soldOut`, every unit booked,
 *   or a sold-out already observed on recheck) are not listed.
 * - Refund deadlines are fixed instants in the fixture; whether a rate is still
 *   refundable is decided on the Clock. A refund is possible up to and including
 *   `refundableUntil`; one millisecond later the rate is presented as
 *   `refundable: false` (so `refundableOnly` drops it) and a cancellation
 *   forfeits the full total.
 * - `recheckRate` surfaces the provider's live state from the fixture hint: the
 *   first recheck that sees a new price returns `price_changed` with
 *   `newAmount`; later rechecks return the rate at the new price
 *   (`needsRecheck: false`). `sold_out` likewise.
 * - `book` checks, in order: idempotent replay (same key + same parameters ⇒
 *   the original booking, counter unchanged; same key + different parameters ⇒
 *   `duplicate`), `ApprovalProof` shape/validity window/group (the proof must
 *   be for the request's `groupId`, D-020), one approval per
 *   booking, rate exists / stay not started / not sold out, guests,
 *   `expectedTotal` vs the live total (`price_changed` + `newAmount`), proof
 *   currency and `maxAmount` (`approval_exceeded`). Only then is a booking
 *   recorded and `bookingCount()` bumped.
 * - City tax is `payAtProperty`: paid by the guests at the property, never
 *   charged by Trav, so it is not part of `expectedTotal` or the approval.
 * - Host messaging: listings flagged `not_supported` (default for
 *   `vacation_rental`, the Airbnb-style case with no API) return
 *   `not_supported`; callers use `getCheckInSummary` (deep link to the listing
 *   + check-in data) instead.
 *
 * Only the factory is exported (D-004); the BookingExecutor is the only caller
 * of `book`.
 */
import { createHash } from 'node:crypto';
import type { Clock, GroupId, IdempotencyKey, IsoDate, Money } from '@trav/core';
import { addDays, equals, localDate, money, parseIso, subtract } from '@trav/core';
import type {
  AdapterError,
  AdapterInfo,
  ApprovalProof,
  GeoPoint,
  RefundPolicy,
  Result,
} from '../../interfaces/common.js';
import type {
  BookLodgingRequest,
  LodgingAdapter,
  LodgingBooking,
  LodgingRate,
  LodgingSearchRequest,
  LodgingSearchResult,
  PropertyKind,
  PropertyMessage,
} from '../../interfaces/lodging.js';
import {
  checkApprovalCovers,
  checkApprovalProofShape,
  checkApprovalProofValidity,
  checkRequestGroup,
} from '../payments/proof.js';
import type { InventoryProperty, InventoryRate, LodgingInventory } from './inventory.js';
import { isWholeUnit, loadLodgingInventory } from './inventory.js';

export interface MockLodgingOptions {
  readonly clock: Clock;
  /** Defaults to `loadLodgingInventory('barcelona')` (the shared fixture). */
  readonly inventory?: LodgingInventory;
  /** If set, proofs for any other group are rejected with `approval_invalid`. */
  readonly groupId?: GroupId;
}

/** What `cancel` would refund right now, on the injected Clock. */
export interface LodgingCancellationQuote {
  readonly bookingId: string;
  readonly refundAmount: Money;
  /** Money lost by cancelling now; the cancel approval must cover this. */
  readonly forfeitedAmount: Money;
  readonly refundableUntil?: string;
  readonly deadlinePassed: boolean;
}

/**
 * Check-in data for the chat, used instead of host messaging where the
 * provider has none (Airbnb-style listings): the deep link plus what the group
 * needs to arrive.
 */
export interface LodgingCheckInSummary {
  readonly bookingId: string;
  readonly confirmationCode: string;
  readonly propertyName: string;
  readonly address?: string;
  readonly city: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  /** Local "HH:MM" in the property's time zone, if known. */
  readonly checkInFrom?: string;
  readonly checkOutBy?: string;
  readonly timeZone: string;
  readonly guestCount: number;
  readonly checkInInstructions?: string;
  /** Taxes the guests pay at the property (e.g. Barcelona city tax). */
  readonly payAtProperty?: Money;
  readonly refundableUntil?: string;
  readonly hostMessaging: 'supported' | 'not_supported';
  /** "See it yourself" / "message the host in the app" deep link. */
  readonly listingUrl?: string;
}

/** The adapter plus test hooks. The executor only sees `LodgingAdapter`. */
export interface MockLodging extends LodgingAdapter {
  /** Bookings actually created (idempotent replays do not count). */
  bookingCount(): number;
  /** Cancellations actually applied (idempotent replays do not count). */
  cancellationCount(): number;
  /** Guest messages actually sent to properties that support messaging. */
  messageCount(): number;
  /** Refund/forfeit if the booking were cancelled now. Read-only. */
  quoteCancellation(bookingId: string): Promise<Result<LodgingCancellationQuote>>;
  /** Check-in data + deep link (the fallback when host messaging is not supported). */
  getCheckInSummary(bookingId: string): Promise<Result<LodgingCheckInSummary>>;
}

interface RateState {
  readonly inv: InventoryRate;
  readonly prop: InventoryProperty;
  /** Total the caller last saw (search cache, then whatever recheck reported). */
  quoted: Money;
  soldOutObserved: boolean;
  activeBookings: number;
  /**
   * Active bookings across every rate of the property. A whole unit
   * (apartment / vacation rental) is one physical place: once any of its rates
   * is booked, all of its rates are gone.
   */
  readonly propertyLoad: { active: number };
}

interface BookingRecord {
  booking: LodgingBooking;
  readonly groupId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly approvalId: string;
  readonly rateId: string;
  readonly guestKey: string;
  /** Lead guest identity (member + name on the booking) for idempotent replays. */
  readonly leadKey: string;
  readonly expectedTotal: Money;
  readonly state: RateState;
  readonly messages: PropertyMessage[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALL_KINDS: ReadonlySet<string> = new Set(['hotel', 'apartment', 'hostel', 'vacation_rental']);
const MAX_MESSAGE_CHARS = 1000;
const MAX_SPECIAL_REQUEST_CHARS = 500;

function fail<T>(
  code: AdapterError['code'],
  message: string,
  extra?: Partial<AdapterError>,
): Result<T> {
  const retryable = code === 'price_changed' || code === 'rate_limited';
  return { ok: false, error: { code, message, retryable, ...extra } };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function done<T>(r: Result<T>): Promise<Result<T>> {
  return Promise.resolve(r);
}

function pad(n: number): string {
  return String(n).padStart(6, '0');
}

function isMoney(v: unknown): v is Money {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as { amountMinor?: unknown; currency?: unknown };
  return (
    typeof m.amountMinor === 'number' &&
    Number.isSafeInteger(m.amountMinor) &&
    typeof m.currency === 'string' &&
    /^[A-Z]{3}$/.test(m.currency)
  );
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function validDate(v: unknown): v is IsoDate {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  try {
    return addDays(v, 0) === v;
  } catch {
    return false;
  }
}

/** Lowercase, strip accents, collapse whitespace ("Gràcia" ⇒ "gracia"). */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function confirmationCode(prefix: string, bookingId: string): string {
  const digest = createHash('sha256').update(bookingId).digest();
  const n = (digest.readUInt32BE(0) % 90000) + 10000;
  return `${prefix}-${n}`;
}

/** The fixture refund policy as it stands at `nowMs`. */
function policyAt(p: RefundPolicy, nowMs: number): RefundPolicy {
  if (!p.refundable || p.refundableUntil === undefined) return p;
  if (nowMs <= parseIso(p.refundableUntil)) return p;
  return {
    refundable: false,
    refundableUntil: p.refundableUntil,
    ...(p.penalty !== undefined ? { penalty: p.penalty } : {}),
    summary: 'free cancellation has ended',
  };
}

/** Refund and forfeit for cancelling a stay of `total` under `p` at `nowMs`. */
function cancellationTerms(
  p: RefundPolicy,
  total: Money,
  nowMs: number,
): { refund: Money; forfeited: Money; deadlinePassed: boolean } {
  const nothing = money(0, total.currency);
  const deadlinePassed = p.refundableUntil !== undefined && nowMs > parseIso(p.refundableUntil);
  if (!p.refundable || deadlinePassed) {
    return { refund: nothing, forfeited: total, deadlinePassed };
  }
  const penalty = p.penalty ?? nothing;
  if (penalty.amountMinor >= total.amountMinor) {
    return { refund: nothing, forfeited: total, deadlinePassed };
  }
  return { refund: subtract(total, penalty), forfeited: penalty, deadlinePassed };
}

/** Bookable on our side: not a fixture sell-out, units left, whole unit not taken. */
function hasRoom(s: RateState): boolean {
  if (s.inv.soldOut) return false;
  if (s.activeBookings >= s.inv.units) return false;
  return !(isWholeUnit(s.prop.property.kind) && s.propertyLoad.active > 0);
}

/**
 * What the provider says right now. A fixture sell-out discovered on
 * recheck/book is remembered (`soldOutObserved`, so search stops listing the
 * stale cache entry). A unit our own bookings filled is NOT remembered:
 * `hasRoom` re-evaluates it, so a cancellation frees the rate again.
 */
function soldOutNow(s: RateState): boolean {
  if (s.inv.recheck?.kind === 'sold_out') {
    s.soldOutObserved = true;
    return true;
  }
  return !hasRoom(s);
}

function livePrice(s: RateState): Money {
  return s.inv.recheck?.kind === 'price_changed' ? s.inv.recheck.newAmount : s.inv.rate.totalAmount;
}

function guestKeyOf(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

function leadKeyOf(lead: unknown): string {
  if (typeof lead !== 'object' || lead === null) return '';
  const l = lead as { memberId?: unknown; givenName?: unknown; familyName?: unknown };
  return JSON.stringify([l.memberId, l.givenName, l.familyName]);
}

export function createMockLodging(options: MockLodgingOptions): MockLodging {
  const { clock } = options;
  const inventory = options.inventory ?? loadLodgingInventory('barcelona');
  const info: AdapterInfo = { provider: inventory.provider, mode: 'mock' };

  const rates = new Map<string, RateState>();
  for (const prop of inventory.properties) {
    const propertyLoad = { active: 0 };
    for (const inv of prop.rates) {
      rates.set(inv.rate.rateId, {
        inv,
        prop,
        quoted: inv.rate.totalAmount,
        soldOutObserved: false,
        activeBookings: 0,
        propertyLoad,
      });
    }
  }
  const bookings = new Map<string, BookingRecord>();
  const bookingsByKey = new Map<IdempotencyKey, BookingRecord>();
  const cancellationsByKey = new Map<
    IdempotencyKey,
    { readonly bookingId: string; readonly approvalId: string }
  >();
  /** approvalId ⇒ the action that consumed it ("book:<key>" / "cancel:<key>"). */
  const approvalUse = new Map<string, string>();
  let bookingSeq = 0;
  let cancellations = 0;
  let messages = 0;

  const present = (s: RateState, total: Money, nowMs: number, rechecked: boolean): LodgingRate => ({
    ...s.inv.rate,
    totalAmount: total,
    refundPolicy: policyAt(s.inv.rate.refundPolicy, nowMs),
    needsRecheck: rechecked ? false : s.inv.rate.needsRecheck,
  });

  const stayStarted = (prop: InventoryProperty): boolean =>
    localDate(clock.now(), prop.timeZone) > inventory.checkIn;

  const validateSearch = (r: LodgingSearchRequest): string | undefined => {
    if (typeof r !== 'object' || r === null) return 'request required';
    if (!validDate(r.checkIn) || !validDate(r.checkOut))
      return 'checkIn/checkOut must be YYYY-MM-DD';
    if (r.checkOut <= r.checkIn) return 'checkOut must be after checkIn';
    if (!Number.isInteger(r.adults) || r.adults < 1 || r.adults > 30) return 'adults must be 1-30';
    if (r.childrenAges !== undefined) {
      if (!Array.isArray(r.childrenAges)) return 'childrenAges must be a list';
      if (r.childrenAges.some((a) => !Number.isInteger(a) || a < 0 || a > 17)) {
        return 'childrenAges must be whole years 0-17';
      }
    }
    if (r.minBedrooms !== undefined && (!Number.isInteger(r.minBedrooms) || r.minBedrooms < 0)) {
      return 'minBedrooms must be a non-negative integer';
    }
    if (
      r.kinds !== undefined &&
      (!Array.isArray(r.kinds) || r.kinds.some((k) => !ALL_KINDS.has(k)))
    ) {
      return 'unknown property kind';
    }
    if (r.maxTotal !== undefined) {
      if (!isMoney(r.maxTotal) || r.maxTotal.amountMinor <= 0)
        return 'maxTotal must be positive Money';
      if (r.maxTotal.currency !== inventory.currency) {
        return `maxTotal must be in ${inventory.currency}`;
      }
    }
    const near = r.near as unknown;
    if (typeof near !== 'object' || near === null) return 'near required';
    if ('city' in near) {
      if (!nonEmpty((near as { city: unknown }).city)) return 'near.city required';
    } else if ('geo' in near) {
      const n = near as { geo: unknown; radiusKm: unknown };
      const g = n.geo as Partial<GeoPoint> | null;
      if (
        typeof g !== 'object' ||
        g === null ||
        typeof g.lat !== 'number' ||
        typeof g.lon !== 'number' ||
        Math.abs(g.lat) > 90 ||
        Math.abs(g.lon) > 180
      ) {
        return 'near.geo must be a lat/lon';
      }
      if (typeof n.radiusKm !== 'number' || !(n.radiusKm > 0) || n.radiusKm > 100) {
        return 'near.radiusKm must be in (0, 100]';
      }
    } else {
      return 'near must be a city or a geo point';
    }
    return undefined;
  };

  const nearMatches = (prop: InventoryProperty, near: LodgingSearchRequest['near']): boolean => {
    if ('city' in near) {
      const q = fold(near.city);
      const p = prop.property.place;
      return (
        fold(p.city) === q ||
        (p.address !== undefined && fold(p.address).includes(q)) ||
        fold(p.name).includes(q)
      );
    }
    const geo = prop.property.place.geo;
    return geo !== undefined && distanceKm(near.geo, geo) <= near.radiusKm;
  };

  const lookupBooking = (bookingId: string): BookingRecord | undefined =>
    typeof bookingId === 'string' ? bookings.get(bookingId) : undefined;

  const checkGuests = (
    req: BookLodgingRequest,
    sleeps: number,
    kind: PropertyKind,
  ): string | undefined => {
    const ids = req.guestMemberIds as unknown;
    if (!Array.isArray(ids) || ids.length === 0) return 'guestMemberIds required';
    if (!ids.every(nonEmpty)) return 'guest ids must be non-empty strings';
    if (new Set(ids).size !== ids.length) return 'duplicate guest';
    if (ids.length > sleeps) return `this rate sleeps ${sleeps}, not ${ids.length}`;
    const lead = req.leadGuest as Partial<BookLodgingRequest['leadGuest']> | undefined;
    if (typeof lead !== 'object' || lead === null) return 'leadGuest required';
    if (!nonEmpty(lead.memberId) || !(ids as string[]).includes(lead.memberId)) {
      return 'leadGuest must be one of the guests';
    }
    if (!nonEmpty(lead.givenName)) return 'leadGuest name required';
    // D-037: a whole-home rental is booked under a given name; a hotel or hostel needs the surname.
    if (lead.familyName !== undefined && !nonEmpty(lead.familyName)) {
      return 'leadGuest familyName must be non-empty when given';
    }
    if (!isWholeUnit(kind) && lead.familyName === undefined) {
      return 'leadGuest familyName required for this property';
    }
    if (
      req.specialRequests !== undefined &&
      (typeof req.specialRequests !== 'string' ||
        req.specialRequests.length > MAX_SPECIAL_REQUEST_CHARS)
    ) {
      return `specialRequests must be text up to ${MAX_SPECIAL_REQUEST_CHARS} characters`;
    }
    return undefined;
  };

  const adapter: MockLodging = {
    info,

    search(request) {
      const problem = validateSearch(request);
      if (problem) return done(fail('invalid_request', `search: ${problem}`));
      const anyProp = inventory.properties[0];
      if (anyProp && localDate(clock.now(), anyProp.timeZone) > request.checkIn) {
        return done(fail('invalid_request', 'search: checkIn is in the past'));
      }
      // The mock inventory prices exactly one stay window.
      if (request.checkIn !== inventory.checkIn || request.checkOut !== inventory.checkOut) {
        return done(ok([]));
      }
      const nowMs = clock.nowMs();
      const guests = request.adults + (request.childrenAges?.length ?? 0);
      const out: LodgingSearchResult[] = [];
      for (const prop of inventory.properties) {
        const p = prop.property;
        if (!nearMatches(prop, request.near)) continue;
        // Whole units: the listing's capacity. Hotels/hostels: per room; the rate decides.
        if (isWholeUnit(p.kind) && p.maxOccupancy < guests) continue;
        if (request.kinds && !request.kinds.includes(p.kind)) continue;
        if (request.wholeUnitForGroup && !isWholeUnit(p.kind)) continue;
        if (request.minBedrooms !== undefined && (p.bedrooms ?? 0) < request.minBedrooms) continue;
        const shown: LodgingRate[] = [];
        for (const inv of prop.rates) {
          const s = rates.get(inv.rate.rateId);
          if (!s) continue;
          if (s.soldOutObserved || !hasRoom(s)) continue;
          if (inv.rate.sleeps < guests) continue;
          const rate = present(s, s.quoted, nowMs, false);
          if (request.refundableOnly && !rate.refundPolicy.refundable) continue;
          if (request.maxTotal && rate.totalAmount.amountMinor > request.maxTotal.amountMinor) {
            continue;
          }
          shown.push(rate);
        }
        if (shown.length === 0) continue;
        shown.sort(
          (a, b) =>
            Number(b.refundPolicy.refundable) - Number(a.refundPolicy.refundable) ||
            a.totalAmount.amountMinor - b.totalAmount.amountMinor ||
            (a.rateId < b.rateId ? -1 : 1),
        );
        out.push({ property: p, rates: shown });
      }
      out.sort((a, b) => {
        const ra = a.rates[0];
        const rb = b.rates[0];
        if (!ra || !rb) return 0;
        return (
          Number(rb.refundPolicy.refundable) - Number(ra.refundPolicy.refundable) ||
          ra.totalAmount.amountMinor - rb.totalAmount.amountMinor ||
          (a.property.propertyId < b.property.propertyId ? -1 : 1)
        );
      });
      return done(ok(out));
    },

    recheckRate(rateId) {
      const s = typeof rateId === 'string' ? rates.get(rateId) : undefined;
      if (!s) return done(fail('not_found', `no rate ${String(rateId)}`));
      if (stayStarted(s.prop)) {
        return done(fail('offer_expired', `rate ${rateId} is for a stay that has already started`));
      }
      if (soldOutNow(s)) {
        return done(fail('sold_out', `rate ${rateId} is no longer available`));
      }
      const live = livePrice(s);
      if (!equals(live, s.quoted)) {
        s.quoted = live;
        return done(fail('price_changed', `rate ${rateId} re-priced`, { newAmount: live }));
      }
      return done(ok(present(s, live, clock.nowMs(), true)));
    },

    book(request) {
      if (typeof request !== 'object' || request === null) {
        return done(fail('invalid_request', 'book: request required'));
      }
      if (!nonEmpty(request.idempotencyKey)) {
        return done(fail('invalid_request', 'book: idempotencyKey required'));
      }

      // 1. Idempotent replay: same key ⇒ the original booking, nothing new recorded.
      const replay = bookingsByKey.get(request.idempotencyKey);
      if (replay) {
        const shapeError = checkApprovalProofShape(request.approval);
        if (shapeError) return done({ ok: false, error: shapeError });
        const ids = request.guestMemberIds as unknown;
        const same =
          replay.groupId === request.groupId &&
          replay.groupId === request.approval.groupId &&
          replay.rateId === request.rateId &&
          replay.approvalId === request.approval.approvalId &&
          Array.isArray(ids) &&
          guestKeyOf(ids as string[]) === replay.guestKey &&
          leadKeyOf(request.leadGuest) === replay.leadKey &&
          isMoney(request.expectedTotal) &&
          equals(replay.expectedTotal, request.expectedTotal);
        if (!same) {
          return done(fail('duplicate', 'idempotency key already used for a different booking'));
        }
        return done(ok(replay.booking));
      }

      // 2. ApprovalProof: well-formed, inside its window on the Clock, right group.
      const nowMs = clock.nowMs();
      const proofError = checkApprovalProofValidity(request.approval, nowMs);
      if (proofError) return done({ ok: false, error: proofError });
      const proof: ApprovalProof = request.approval;
      const groupError = checkRequestGroup(request.groupId, proof);
      if (groupError) return done({ ok: false, error: groupError });
      if (options.groupId !== undefined && proof.groupId !== options.groupId) {
        return done(fail('approval_invalid', 'approval proof is for another group'));
      }
      // 3. One approval funds one money-moving action.
      const usedBy = approvalUse.get(proof.approvalId);
      if (usedBy !== undefined && usedBy !== `book:${request.idempotencyKey}`) {
        return done(fail('approval_invalid', 'approval already used for another action'));
      }

      // 4. Rate.
      const s = typeof request.rateId === 'string' ? rates.get(request.rateId) : undefined;
      if (!s) return done(fail('not_found', `no rate ${String(request.rateId)}`));
      if (stayStarted(s.prop)) {
        return done(fail('offer_expired', 'this stay has already started'));
      }
      if (soldOutNow(s)) {
        return done(fail('sold_out', `rate ${request.rateId} is no longer available`));
      }

      // 5. Guests.
      const guestProblem = checkGuests(request, s.inv.rate.sleeps, s.prop.property.kind);
      if (guestProblem) return done(fail('invalid_request', `book: ${guestProblem}`));

      // 6. Price: expectedTotal must equal the live total.
      if (!isMoney(request.expectedTotal)) {
        return done(fail('invalid_request', 'book: expectedTotal must be Money'));
      }
      const live = livePrice(s);
      if (!equals(live, request.expectedTotal)) {
        s.quoted = live;
        return done(
          fail('price_changed', 'rate total differs from expectedTotal', { newAmount: live }),
        );
      }

      // 7. The proof must cover the total, in the same currency.
      const coverError = checkApprovalCovers(proof, live);
      if (coverError) return done({ ok: false, error: coverError });

      bookingSeq += 1;
      const bookingId = `lbk_mock_${pad(bookingSeq)}`;
      const rate = present(s, live, nowMs, true);
      const booking: LodgingBooking = {
        bookingId,
        confirmationCode: confirmationCode(s.inv.confirmationPrefix, bookingId),
        status: 'confirmed',
        property: s.prop.property,
        rate,
        checkIn: inventory.checkIn,
        checkOut: inventory.checkOut,
        guestMemberIds: [...request.guestMemberIds],
        ...(s.inv.checkInInstructions !== undefined
          ? { checkInInstructions: s.inv.checkInInstructions }
          : {}),
        createdAt: clock.now(),
        approvalId: proof.approvalId,
      };
      const record: BookingRecord = {
        booking,
        groupId: proof.groupId,
        idempotencyKey: request.idempotencyKey,
        approvalId: proof.approvalId,
        rateId: s.inv.rate.rateId,
        guestKey: guestKeyOf(request.guestMemberIds),
        leadKey: leadKeyOf(request.leadGuest),
        expectedTotal: money(live.amountMinor, live.currency),
        state: s,
        messages: [],
      };
      s.quoted = live;
      s.activeBookings += 1;
      s.propertyLoad.active += 1;
      bookings.set(bookingId, record);
      bookingsByKey.set(request.idempotencyKey, record);
      approvalUse.set(proof.approvalId, `book:${request.idempotencyKey}`);
      return done(ok(booking));
    },

    getBooking(bookingId) {
      const rec = lookupBooking(bookingId);
      return done(rec ? ok(rec.booking) : fail('not_found', `no booking ${String(bookingId)}`));
    },

    cancel(bookingId, approval, idempotencyKey) {
      if (!nonEmpty(idempotencyKey)) {
        return done(fail('invalid_request', 'cancel: idempotencyKey required'));
      }
      const replayOf = cancellationsByKey.get(idempotencyKey);
      if (replayOf !== undefined) {
        const rec = bookings.get(replayOf.bookingId);
        const proofShape = checkApprovalProofShape(approval);
        if (proofShape) return done({ ok: false, error: proofShape });
        if (
          replayOf.bookingId === bookingId &&
          rec &&
          replayOf.approvalId === approval.approvalId &&
          rec.groupId === approval.groupId
        ) {
          return done(ok(rec.booking));
        }
        return done(fail('duplicate', 'idempotency key already used for a different cancellation'));
      }
      const nowMs = clock.nowMs();
      const proofError = checkApprovalProofValidity(approval, nowMs);
      if (proofError) return done({ ok: false, error: proofError });
      if (options.groupId !== undefined && approval.groupId !== options.groupId) {
        return done(fail('approval_invalid', 'approval proof is for another group'));
      }
      const rec = lookupBooking(bookingId);
      if (!rec) return done(fail('not_found', `no booking ${String(bookingId)}`));
      if (rec.booking.status === 'cancelled') {
        return done(fail('invalid_request', `booking ${bookingId} is already cancelled`));
      }
      if (approval.groupId !== rec.groupId) {
        return done(fail('approval_invalid', 'approval proof is for another group'));
      }
      const usedBy = approvalUse.get(approval.approvalId);
      if (usedBy !== undefined && usedBy !== `cancel:${idempotencyKey}`) {
        return done(fail('approval_invalid', 'approval already used for another action'));
      }
      const terms = cancellationTerms(
        rec.state.inv.rate.refundPolicy,
        rec.booking.rate.totalAmount,
        nowMs,
      );
      const coverError = checkApprovalCovers(approval, terms.forfeited);
      if (coverError) return done({ ok: false, error: coverError });

      rec.booking = { ...rec.booking, status: 'cancelled' };
      rec.state.activeBookings -= 1;
      rec.state.propertyLoad.active -= 1;
      cancellationsByKey.set(idempotencyKey, {
        bookingId: rec.booking.bookingId,
        approvalId: approval.approvalId,
      });
      approvalUse.set(approval.approvalId, `cancel:${idempotencyKey}`);
      cancellations += 1;
      return done(ok(rec.booking));
    },

    messageProperty(bookingId, text) {
      const rec = lookupBooking(bookingId);
      if (!rec) return done(fail('not_found', `no booking ${String(bookingId)}`));
      if (rec.state.prop.hostMessaging === 'not_supported') {
        return done(notSupported(rec));
      }
      if (rec.booking.status === 'cancelled') {
        return done(fail('invalid_request', `booking ${bookingId} is cancelled`));
      }
      if (!nonEmpty(text) || text.length > MAX_MESSAGE_CHARS) {
        return done(fail('invalid_request', `message must be 1-${MAX_MESSAGE_CHARS} characters`));
      }
      const msg: PropertyMessage = { from: 'guest', text, sentAt: clock.now() };
      rec.messages.push(msg);
      messages += 1;
      return done(ok(msg));
    },

    listPropertyMessages(bookingId) {
      const rec = lookupBooking(bookingId);
      if (!rec) return done(fail('not_found', `no booking ${String(bookingId)}`));
      if (rec.state.prop.hostMessaging === 'not_supported') return done(notSupported(rec));
      return done(ok([...rec.messages]));
    },

    quoteCancellation(bookingId) {
      const rec = lookupBooking(bookingId);
      if (!rec) return done(fail('not_found', `no booking ${String(bookingId)}`));
      if (rec.booking.status === 'cancelled') {
        return done(fail('invalid_request', `booking ${bookingId} is already cancelled`));
      }
      const policy = rec.state.inv.rate.refundPolicy;
      const terms = cancellationTerms(policy, rec.booking.rate.totalAmount, clock.nowMs());
      return done(
        ok({
          bookingId: rec.booking.bookingId,
          refundAmount: terms.refund,
          forfeitedAmount: terms.forfeited,
          ...(policy.refundableUntil !== undefined
            ? { refundableUntil: policy.refundableUntil }
            : {}),
          deadlinePassed: terms.deadlinePassed,
        }),
      );
    },

    getCheckInSummary(bookingId) {
      const rec = lookupBooking(bookingId);
      if (!rec) return done(fail('not_found', `no booking ${String(bookingId)}`));
      const { booking, state } = rec;
      const p = booking.property;
      const policy = state.inv.rate.refundPolicy;
      const summary: LodgingCheckInSummary = {
        bookingId: booking.bookingId,
        confirmationCode: booking.confirmationCode,
        propertyName: p.name,
        ...(p.place.address !== undefined ? { address: p.place.address } : {}),
        city: p.place.city,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        ...(state.prop.checkInFrom !== undefined ? { checkInFrom: state.prop.checkInFrom } : {}),
        ...(state.prop.checkOutBy !== undefined ? { checkOutBy: state.prop.checkOutBy } : {}),
        timeZone: state.prop.timeZone,
        guestCount: booking.guestMemberIds.length,
        ...(booking.checkInInstructions !== undefined
          ? { checkInInstructions: booking.checkInInstructions }
          : {}),
        ...(booking.rate.payAtProperty !== undefined
          ? { payAtProperty: booking.rate.payAtProperty }
          : {}),
        ...(policy.refundable && policy.refundableUntil !== undefined
          ? { refundableUntil: policy.refundableUntil }
          : {}),
        hostMessaging: state.prop.hostMessaging,
        ...(p.url !== undefined ? { listingUrl: p.url } : {}),
      };
      return done(ok(summary));
    },

    bookingCount: () => bookingSeq,
    cancellationCount: () => cancellations,
    messageCount: () => messages,
  };
  return adapter;
}

function notSupported<T>(rec: BookingRecord): Result<T> {
  const link = rec.booking.property.url;
  return fail(
    'not_supported',
    `host messaging is not available for ${rec.booking.property.name}; use getCheckInSummary` +
      (link !== undefined ? ` or the listing link ${link}` : ''),
  );
}
