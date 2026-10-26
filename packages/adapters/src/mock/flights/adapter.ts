/**
 * Mock `FlightsAdapter` (T-029-a). Duffel-shaped offers/orders over a fixture
 * inventory, with every time-dependent behavior read from the injected Clock:
 *
 * - `search` instantiates fresh offers (new ids) from matching templates; each
 *   offer expires `ttlMinutes` after the search (default 30).
 * - `getOffer` re-prices: a template with `reprice` changes its total after
 *   `afterMinutes`. The first `getOffer` that sees the new total returns
 *   `price_changed` with `newAmount`; later calls return the offer at the new total.
 * - `createOrder` checks, in order: idempotent replay, `ApprovalProof` (and
 *   that it was granted in the request's `groupId`, D-020), offer
 *   existence/expiry, travelers, `expectedTotal` vs current total
 *   (`price_changed`), proof currency and `maxAmount` (`approval_exceeded`).
 *   Only then does it "book" and bump `purchaseCount()`.
 *
 * No network, no real carriers, no `Date.now()`.
 */
import { createHash } from 'node:crypto';
import { addDays, addMinutes, equals, multiply, parseIso, subtract } from '@trav/core';
import type { Clock, GroupId, Money } from '@trav/core';
import type {
  AdapterError,
  AdapterInfo,
  ApprovalProof,
  IdempotencyKey,
  Result,
  Traveler,
} from '../../interfaces/common.js';
import type {
  CancellationQuote,
  ChangeOrRefundCondition,
  CreateFlightOrderRequest,
  FlightOffer,
  FlightOrder,
  FlightSearchRequest,
  FlightsAdapter,
} from '../../interfaces/flights.js';
import { checkRequestGroup } from '../payments/proof.js';
import { checkApprovalProof } from './approvalProof.js';
import { loadMockFlightInventory } from './inventory.js';
import type { FlightOfferTemplate, MockFlightInventory, TemplateCondition } from './inventory.js';

export interface MockFlightsOptions {
  readonly clock: Clock;
  /** Defaults to `loadMockFlightInventory('barcelona')`. */
  readonly inventory?: MockFlightInventory;
  /** If set, proofs for any other group are rejected with `approval_invalid`. */
  readonly groupId?: GroupId;
  /**
   * Mock convenience: search matches a slice whose first departure is within ±N
   * local calendar days of the requested date (default 1, so a Thursday search
   * also finds Wednesday red-eyes). Set 0 for Duffel's exact-date behavior.
   */
  readonly dateFlexDays?: number;
  /** Minutes a cancellation quote stays valid (default 15). */
  readonly cancellationQuoteTtlMinutes?: number;
}

export interface MockFlightsAdapter extends FlightsAdapter {
  /** Test hook: number of orders actually booked (idempotent replays do not count). */
  purchaseCount(): number;
  /** Test hook: number of cancellations actually confirmed. */
  cancellationCount(): number;
}

interface OfferInstance {
  readonly offerId: string;
  readonly template: FlightOfferTemplate;
  readonly passengerIds: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expiresMs: number;
  readonly createdMs: number;
  /** Per-passenger total the caller last saw (from search or getOffer). */
  quotedPerPassenger: Money;
  orderId?: string;
}

interface OrderRecord {
  order: FlightOrder;
  readonly groupId: string;
  readonly idempotencyKey: string;
  readonly offerId: string;
}

interface QuoteRecord {
  readonly quote: CancellationQuote;
  readonly expiresMs: number;
}

interface CancellationRecord {
  readonly quoteId: string;
  readonly orderId: string;
}

const AIRPORT_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

function pad(n: number): string {
  return String(n).padStart(6, '0');
}

function bookingReference(orderId: string): string {
  const digest = createHash('sha256').update(orderId).digest();
  let out = '';
  for (let i = 0; i < 6; i += 1) out += PNR_ALPHABET[(digest[i] ?? 0) % PNR_ALPHABET.length];
  return out;
}

function scaleCondition(c: TemplateCondition, passengers: number): ChangeOrRefundCondition {
  return c.penaltyPerPassenger === undefined
    ? { allowed: c.allowed }
    : { allowed: c.allowed, penalty: multiply(c.penaltyPerPassenger, passengers) };
}

/** Local "YYYY-MM-DD" and "HH:MM" of an ISO string that carries its local offset. */
function localDateOf(iso: string): string {
  return iso.slice(0, 10);
}
function localTimeOf(iso: string): string {
  return iso.slice(11, 16);
}

export function createMockFlights(options: MockFlightsOptions): MockFlightsAdapter {
  const { clock } = options;
  const inventory = options.inventory ?? loadMockFlightInventory('barcelona');
  const flexDays = options.dateFlexDays ?? 1;
  const quoteTtl = options.cancellationQuoteTtlMinutes ?? 15;
  const info: AdapterInfo = { provider: inventory.provider, mode: 'mock' };

  const offers = new Map<string, OfferInstance>();
  const orders = new Map<string, OrderRecord>();
  const ordersByKey = new Map<string, OrderRecord>();
  const quotes = new Map<string, QuoteRecord>();
  const cancellationsByKey = new Map<string, CancellationRecord>();
  let offerSeq = 0;
  let orderSeq = 0;
  let quoteSeq = 0;
  let purchases = 0;
  let cancellations = 0;

  const currentPerPassenger = (inst: OfferInstance, nowMs: number): Money => {
    const rp = inst.template.reprice;
    if (rp && nowMs >= inst.createdMs + rp.afterMinutes * 60_000) return rp.perPassengerTotal;
    return inst.template.perPassengerTotal;
  };

  const buildOffer = (inst: OfferInstance, perPassenger: Money): FlightOffer => {
    const t = inst.template;
    const n = inst.passengerIds.length;
    const totalAmount = multiply(perPassenger, n);
    const taxAmount = multiply(t.perPassengerTax, n);
    const baseAmount = subtract(totalAmount, taxAmount);
    const payment: FlightOffer['paymentRequirements'] = t.requiresInstantPayment
      ? { requiresInstantPayment: true, priceGuaranteeExpiresAt: inst.expiresAt }
      : {
          requiresInstantPayment: false,
          priceGuaranteeExpiresAt: inst.expiresAt,
          paymentRequiredBy: inst.expiresAt,
        };
    const offer: FlightOffer = {
      offerId: inst.offerId,
      provider: info.provider,
      totalAmount,
      taxAmount,
      owner: t.owner,
      slices: t.slices,
      passengerIds: inst.passengerIds,
      conditions: {
        refundBeforeDeparture: scaleCondition(t.refundBeforeDeparture, n),
        changeBeforeDeparture: scaleCondition(t.changeBeforeDeparture, n),
      },
      paymentRequirements: payment,
      expiresAt: inst.expiresAt,
    };
    return baseAmount.amountMinor >= 0 ? { ...offer, baseAmount } : offer;
  };

  const sliceMatches = (
    tSlice: FlightOfferTemplate['slices'][number],
    req: FlightSearchRequest['slices'][number],
  ): boolean => {
    const first = tSlice.segments[0];
    if (!first) return false;
    if (tSlice.origin !== req.origin || tSlice.destination !== req.destination) return false;
    const depDate = localDateOf(first.departingAt);
    let dateOk = false;
    for (let d = -flexDays; d <= flexDays; d += 1) {
      if (addDays(req.departureDate, d) === depDate) dateOk = true;
    }
    if (!dateOk) return false;
    if (req.departureWindow) {
      const t = localTimeOf(first.departingAt);
      if (t < req.departureWindow.from || t > req.departureWindow.to) return false;
    }
    return true;
  };

  const validateSearch = (request: FlightSearchRequest): string | undefined => {
    if (!Array.isArray(request.slices) || request.slices.length === 0) return 'no slices';
    for (const s of request.slices) {
      if (!AIRPORT_RE.test(s.origin) || !AIRPORT_RE.test(s.destination)) return 'bad airport code';
      if (s.origin === s.destination) return 'origin equals destination';
      if (!DATE_RE.test(s.departureDate)) return 'bad departure date';
      try {
        addDays(s.departureDate, 0);
      } catch {
        return 'bad departure date';
      }
      if (s.departureWindow) {
        const { from, to } = s.departureWindow;
        if (!HHMM_RE.test(from) || !HHMM_RE.test(to) || from > to) return 'bad departure window';
      }
    }
    if (!Array.isArray(request.passengers) || request.passengers.length === 0)
      return 'no passengers';
    const ids = request.passengers.map((p) => p.memberId);
    if (ids.some((id) => typeof id !== 'string' || id.length === 0)) return 'bad passenger id';
    if (new Set(ids).size !== ids.length) return 'duplicate passenger';
    if (
      request.maxConnections !== undefined &&
      (!Number.isInteger(request.maxConnections) || request.maxConnections < 0)
    ) {
      return 'bad maxConnections';
    }
    return undefined;
  };

  const adapter: MockFlightsAdapter = {
    info,

    search(request) {
      const problem = validateSearch(request);
      if (problem) return Promise.resolve(fail(`invalid_request`, `search: ${problem}`));
      // The fixture inventory is economy only.
      if (request.cabinClass !== undefined && request.cabinClass !== 'economy') {
        return Promise.resolve(ok([]));
      }
      const passengerIds = request.passengers.map((p) => p.memberId);
      const createdAt = clock.now();
      const createdMs = clock.nowMs();
      const matches = inventory.templates.filter(
        (t) =>
          t.slices.length === request.slices.length &&
          t.slices.every((s, i) => {
            const req = request.slices[i];
            return req !== undefined && sliceMatches(s, req);
          }) &&
          (request.maxConnections === undefined ||
            t.slices.every((s) => s.segments.length - 1 <= (request.maxConnections ?? 0))),
      );
      const result = matches.map((template) => {
        offerSeq += 1;
        const expiresAt = addMinutes(createdAt, template.ttlMinutes);
        const inst: OfferInstance = {
          offerId: `off_mock_${pad(offerSeq)}_${template.templateId}`,
          template,
          passengerIds,
          createdAt,
          createdMs,
          expiresAt,
          expiresMs: parseIso(expiresAt),
          quotedPerPassenger: template.perPassengerTotal,
        };
        offers.set(inst.offerId, inst);
        return buildOffer(inst, template.perPassengerTotal);
      });
      result.sort(
        (a, b) =>
          a.totalAmount.amountMinor - b.totalAmount.amountMinor || (a.offerId < b.offerId ? -1 : 1),
      );
      return Promise.resolve(ok(result));
    },

    getOffer(offerId) {
      const inst = offers.get(offerId);
      if (!inst) return Promise.resolve(fail('not_found', `no offer ${offerId}`));
      const nowMs = clock.nowMs();
      if (nowMs >= inst.expiresMs) {
        return Promise.resolve(fail('offer_expired', `offer ${offerId} expired; search again`));
      }
      const current = currentPerPassenger(inst, nowMs);
      if (!equals(current, inst.quotedPerPassenger)) {
        inst.quotedPerPassenger = current;
        return Promise.resolve(
          fail('price_changed', `offer ${offerId} re-priced`, {
            newAmount: multiply(current, inst.passengerIds.length),
          }),
        );
      }
      return Promise.resolve(ok(buildOffer(inst, current)));
    },

    createOrder(request: CreateFlightOrderRequest) {
      if (typeof request !== 'object' || (request as unknown) === null) {
        return Promise.resolve(fail('invalid_request', 'createOrder: request required'));
      }
      if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
        return Promise.resolve(fail('invalid_request', 'createOrder: idempotencyKey required'));
      }
      const replay = ordersByKey.get(request.idempotencyKey);
      if (replay) {
        if (
          replay.offerId === request.offerId &&
          replay.groupId === request.groupId &&
          replay.order.approvalId === request.approval?.approvalId
        ) {
          return Promise.resolve(ok(replay.order));
        }
        return Promise.resolve(
          fail('duplicate', 'idempotency key already used for a different order'),
        );
      }

      const nowMs = clock.nowMs();
      const proofError = checkApprovalProof(request.approval, nowMs, options.groupId);
      if (proofError) return Promise.resolve({ ok: false, error: proofError });
      const groupError = checkRequestGroup(request.groupId, request.approval);
      if (groupError) return Promise.resolve({ ok: false, error: groupError });

      const inst = offers.get(request.offerId);
      if (!inst) return Promise.resolve(fail('not_found', `no offer ${request.offerId}`));
      if (nowMs >= inst.expiresMs) {
        return Promise.resolve(fail('offer_expired', `offer ${request.offerId} expired`));
      }
      if (inst.orderId !== undefined) {
        return Promise.resolve(
          fail('duplicate', `offer ${request.offerId} is already booked as ${inst.orderId}`),
        );
      }

      const travelerProblem = checkTravelers(request.travelers, inst.passengerIds);
      if (travelerProblem) return Promise.resolve(fail('invalid_request', travelerProblem));

      const perPassenger = currentPerPassenger(inst, nowMs);
      const total = multiply(perPassenger, inst.passengerIds.length);
      if (!equals(total, request.expectedTotal)) {
        inst.quotedPerPassenger = perPassenger;
        return Promise.resolve(
          fail('price_changed', 'offer total differs from expectedTotal', { newAmount: total }),
        );
      }
      const proof: ApprovalProof = request.approval;
      if (proof.maxAmount.currency !== total.currency) {
        return Promise.resolve(fail('approval_invalid', 'approval currency differs from offer'));
      }
      if (total.amountMinor > proof.maxAmount.amountMinor) {
        return Promise.resolve(fail('approval_exceeded', 'offer total exceeds approved maxAmount'));
      }

      orderSeq += 1;
      const orderId = `ord_mock_${pad(orderSeq)}`;
      const order: FlightOrder = {
        orderId,
        bookingReference: bookingReference(orderId),
        status: 'confirmed',
        totalAmount: total,
        travelers: request.travelers,
        offer: buildOffer(inst, perPassenger),
        createdAt: clock.now(),
        approvalId: proof.approvalId,
      };
      const record: OrderRecord = {
        order,
        groupId: proof.groupId,
        idempotencyKey: request.idempotencyKey,
        offerId: inst.offerId,
      };
      inst.orderId = orderId;
      orders.set(orderId, record);
      ordersByKey.set(request.idempotencyKey, record);
      purchases += 1;
      return Promise.resolve(ok(order));
    },

    getOrder(orderId) {
      const rec = orders.get(orderId);
      return Promise.resolve(rec ? ok(rec.order) : fail('not_found', `no order ${orderId}`));
    },

    quoteCancellation(orderId) {
      const rec = orders.get(orderId);
      if (!rec) return Promise.resolve(fail('not_found', `no order ${orderId}`));
      if (rec.order.status === 'cancelled') {
        return Promise.resolve(fail('invalid_request', `order ${orderId} is already cancelled`));
      }
      const refundCond = rec.order.offer.conditions.refundBeforeDeparture;
      const total = rec.order.totalAmount;
      let refundAmount = multiply(total, 0);
      if (refundCond.allowed) {
        const penalty = refundCond.penalty ?? multiply(total, 0);
        refundAmount =
          penalty.amountMinor >= total.amountMinor ? refundAmount : subtract(total, penalty);
      }
      quoteSeq += 1;
      const now = clock.now();
      const expiresAt = addMinutes(now, quoteTtl);
      const quote: CancellationQuote = {
        quoteId: `ocr_mock_${pad(quoteSeq)}`,
        orderId,
        refundAmount,
        expiresAt,
      };
      quotes.set(quote.quoteId, { quote, expiresMs: parseIso(expiresAt) });
      return Promise.resolve(ok(quote));
    },

    confirmCancellation(quoteId: string, approval: ApprovalProof, idempotencyKey: IdempotencyKey) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return Promise.resolve(
          fail('invalid_request', 'confirmCancellation: idempotencyKey required'),
        );
      }
      const replay = cancellationsByKey.get(idempotencyKey);
      if (replay) {
        const rec = orders.get(replay.orderId);
        if (replay.quoteId === quoteId && rec) return Promise.resolve(ok(rec.order));
        return Promise.resolve(
          fail('duplicate', 'idempotency key already used for a different cancellation'),
        );
      }
      const nowMs = clock.nowMs();
      const proofError = checkApprovalProof(approval, nowMs, options.groupId);
      if (proofError) return Promise.resolve({ ok: false, error: proofError });

      const q = quotes.get(quoteId);
      if (!q) return Promise.resolve(fail('not_found', `no cancellation quote ${quoteId}`));
      if (nowMs >= q.expiresMs) {
        return Promise.resolve(fail('offer_expired', `cancellation quote ${quoteId} expired`));
      }
      const rec = orders.get(q.quote.orderId);
      if (!rec) return Promise.resolve(fail('not_found', `no order ${q.quote.orderId}`));
      if (rec.order.status === 'cancelled') {
        return Promise.resolve(
          fail('invalid_request', `order ${rec.order.orderId} is already cancelled`),
        );
      }
      if (approval.groupId !== rec.groupId) {
        return Promise.resolve(fail('approval_invalid', 'approval proof is for another group'));
      }
      const forfeited = subtract(rec.order.totalAmount, q.quote.refundAmount);
      if (approval.maxAmount.currency !== forfeited.currency) {
        return Promise.resolve(fail('approval_invalid', 'approval currency differs from order'));
      }
      if (forfeited.amountMinor > approval.maxAmount.amountMinor) {
        return Promise.resolve(
          fail('approval_exceeded', 'forfeited amount exceeds approved maxAmount'),
        );
      }
      rec.order = { ...rec.order, status: 'cancelled' };
      cancellationsByKey.set(idempotencyKey, { quoteId, orderId: rec.order.orderId });
      cancellations += 1;
      return Promise.resolve(ok(rec.order));
    },

    purchaseCount: () => purchases,
    cancellationCount: () => cancellations,
  };
  return adapter;
}

function checkTravelers(
  travelers: readonly Traveler[] | undefined,
  passengerIds: readonly string[],
): string | undefined {
  if (!Array.isArray(travelers)) return 'travelers required';
  const ids = travelers.map((t) => t.memberId);
  if (new Set(ids).size !== ids.length) return 'duplicate traveler';
  if (ids.length !== passengerIds.length || !passengerIds.every((p) => ids.includes(p))) {
    return 'travelers must match the offer passengers exactly';
  }
  for (const t of travelers) {
    if (!t.givenName?.trim() || !t.familyName?.trim()) return 'traveler name required';
  }
  return undefined;
}
