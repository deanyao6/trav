/**
 * Mock TicketsAdapter (T-008-a). In-memory inventory from
 * `fixtures/tickets/*.json`; no network, no I/O, no wall clock.
 *
 * Lifecycle: searchEvents → getOffers → hold (locks price, reserves seats,
 * expires on the injected Clock after `holdMinutes`) → purchase (one
 * IssuedTicket per holder, fake QR payload) → getOrder / getTicketForHolder
 * → refund.
 *
 * Money-moving rules (SAFETY §2.1, ARCHITECTURE §10.3), checked in this order
 * on every new purchase:
 *  1. idempotent replay: a known `idempotencyKey` with the same hold, holders
 *     and approval returns the ORIGINAL order (no new order, counter unchanged);
 *     the same key with different parameters is `duplicate`;
 *  2. hold exists and is active (`hold_expired` at/after `expiresAt`;
 *     a hold already purchased under another key is `duplicate`);
 *  3. `ApprovalProof` well-formed and inside its validity window, granted in
 *     the request's `groupId` (`approval_invalid`; missing `groupId` is
 *     `invalid_request`, D-020);
 *  4. `expectedTotal` equals the held total (`price_changed` + `newAmount`);
 *  5. the proof covers the total in the same currency (`approval_exceeded` / `approval_invalid`);
 *  6. holders: exactly `quantity`, unique member ids, names present;
 *  7. one approval funds one order (`approval_invalid` on reuse with another key).
 *
 * Refunds need a proof for the order's group that has not funded any other
 * action (not the purchase, not another refund). A refunded ticket gets
 * `status: 'refunded'` in the order and `getTicketForHolder` answers
 * `not_found` for it, so it is never delivered by DM.
 *
 * Every state change returns the full resulting object (hold, order, ticket),
 * which is what the BookingExecutor writes to the audit log; this module
 * never writes audit events itself. Only the factory is exported (D-004).
 */
import type { Clock, IdGenerator, IdempotencyKey, MemberId, Money } from '@trav/core';
import {
  TravError,
  add,
  addDays,
  addMinutes,
  equals,
  localDate,
  localHour,
  money,
  multiply,
  parseIso,
  sum,
  zero,
} from '@trav/core';
import type { AdapterError, AdapterInfo, ApprovalProof, Result } from '../../interfaces/common.js';
import type {
  EventSearchRequest,
  IssuedTicket,
  PurchaseTicketsRequest,
  ReceiptLine,
  TicketEvent,
  TicketHold,
  TicketHolder,
  TicketOffer,
  TicketOrder,
  TicketsAdapter,
} from '../../interfaces/tickets.js';
import {
  checkApprovalCovers,
  checkApprovalProofShape,
  checkApprovalProofValidity,
  checkRequestGroup,
} from '../payments/proof.js';
import type { InventoryEvent, InventoryOffer, TicketInventory } from './inventory.js';
import { mockBarcodePayload } from './qr.js';

export type {
  InventoryEvent,
  InventoryOffer,
  InventorySeating,
  TicketInventory,
} from './inventory.js';
export {
  TICKET_INVENTORY_NAMES,
  loadAllTicketInventories,
  loadTicketInventory,
  parseTicketInventory,
} from './inventory.js';
export { MOCK_BARCODE_PREFIX, mockBarcodePayload, mockQrDataUrl } from './qr.js';

export interface MockTicketsOptions {
  readonly clock: Clock;
  /** Issues `tkt_` ticket ids (deterministic generator in tests). */
  readonly ids: IdGenerator;
  /**
   * One inventory, or several (one per trip). `searchEvents` matches an
   * event when the requested city is its venue city or one of its own
   * inventory's `cities` (so Lisbon finds its Sintra day trip, and Barcelona
   * never sees Lisbon events). Event and offer ids must be unique across
   * inventories, and so must receipt prefixes (the factory throws when two
   * inventories can issue the same prefix). Order numbers count per
   * inventory, so with disjoint prefixes a purchase in one trip never shifts
   * another trip's receipt numbers.
   */
  readonly inventory: TicketInventory | readonly TicketInventory[];
  /** First receipt/order number (default 48213, so the demo reads "RZ-48213"). */
  readonly orderNumberStart?: number;
}

export type MockHoldStatus = 'active' | 'released' | 'expired' | 'purchased';

/** The adapter plus test hooks. The executor only sees `TicketsAdapter`. */
export interface MockTickets extends TicketsAdapter {
  /** Orders actually created (idempotent replays do not count). */
  purchaseCount(): number;
  /** Holds actually created (idempotent replays do not count). */
  holdCount(): number;
  /** Refunds actually applied (idempotent replays do not count). */
  refundCount(): number;
  /** Current status of a hold, after applying expiry on the clock. */
  holdStatus(holdId: string): MockHoldStatus | undefined;
  /** Remaining stock for an offer (after expiring lapsed holds). */
  availableFor(offerId: string): number;
  /** Simulate stock changes (e.g. "sold out tonight"). */
  setAvailable(offerId: string, available: number): void;
  /** Simulate a provider price change; affects new holds only (holds lock price). */
  setUnitPrice(offerId: string, unitPrice: Money, unitFees?: Money): void;
}

interface InventoryState {
  readonly inventory: TicketInventory;
  /** Orders created from this inventory (drives its receipt numbers). */
  orders: number;
}

interface OfferState {
  readonly inv: InventoryOffer;
  readonly event: InventoryEvent;
  readonly source: InventoryState;
  available: number;
  unitPrice: Money;
  unitFees: Money;
  nextSeat: number;
}

interface HoldState {
  readonly hold: TicketHold;
  readonly offerId: string;
  readonly key: IdempotencyKey;
  readonly expiresAtMs: number;
  readonly unitPrice: Money;
  readonly unitFees: Money;
  status: MockHoldStatus;
}

interface OrderState {
  order: TicketOrder;
  readonly key: IdempotencyKey;
  readonly groupId: string;
  readonly holdId: string;
  readonly holderIds: readonly MemberId[];
  readonly offerId: string;
  readonly refunded: Set<string>;
}

interface RefundRecord {
  readonly orderId: string;
  readonly ticketIds: string;
  readonly approvalId: string;
  readonly approvalGroupId: string;
  readonly result: TicketOrder;
}

const DEFAULT_ORDER_NUMBER_START = 48213;
/** Club nights that start after midnight belong to the evening before ("tonight"). */
const NIGHT_ROLLOVER_HOUR = 6;
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'get',
  'tickets',
  'ticket',
  'tonight',
  'tomorrow',
  'some',
  'any',
  'with',
]);

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err<T>(
  code: AdapterError['code'],
  message: string,
  extra?: Partial<Pick<AdapterError, 'retryable' | 'newAmount'>>,
): Result<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: extra?.retryable ?? false,
      ...(extra?.newAmount !== undefined ? { newAmount: extra.newAmount } : {}),
    },
  };
}

function fromError<T>(error: AdapterError): Result<T> {
  return { ok: false, error };
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;
}

function isMoneyValue(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as { amountMinor?: unknown; currency?: unknown };
  return (
    typeof m.amountMinor === 'number' &&
    Number.isSafeInteger(m.amountMinor) &&
    typeof m.currency === 'string'
  );
}

function isInventoryList(
  value: TicketInventory | readonly TicketInventory[],
): value is readonly TicketInventory[] {
  return Array.isArray(value);
}

/** Calendar date the event "belongs to" in its venue's zone (after-midnight club nights roll back a day). */
export function eventNightOf(event: TicketEvent): string {
  const tz = event.venue.timeZone ?? 'UTC';
  const date = localDate(event.startsAt, tz);
  return localHour(event.startsAt, tz) < NIGHT_ROLLOVER_HOUR ? addDays(date, -1) : date;
}

export function createMockTickets(options: MockTicketsOptions): MockTickets {
  const { clock, ids } = options;
  const inventories: readonly TicketInventory[] = isInventoryList(options.inventory)
    ? options.inventory
    : [options.inventory];
  const first = inventories[0];
  if (first === undefined) {
    throw new TravError('invalid_argument', 'mock-tickets needs at least one inventory');
  }
  const orderNumberStart = options.orderNumberStart ?? DEFAULT_ORDER_NUMBER_START;
  if (!Number.isSafeInteger(orderNumberStart) || orderNumberStart < 0) {
    throw new TravError('invalid_argument', 'orderNumberStart must be a non-negative integer');
  }
  const info: AdapterInfo = { provider: first.provider, mode: 'mock' };

  const events = new Map<string, InventoryEvent>();
  /** eventId => folded cities a search may name to find it (venue + its inventory's trip cities). */
  const eventCities = new Map<string, ReadonlySet<string>>();
  const offers = new Map<string, OfferState>();
  /** Receipt prefix => the inventory that issues it (prefixes never span inventories). */
  const prefixOwner = new Map<string, TicketInventory>();
  const claimPrefix = (p: string, inventory: TicketInventory): void => {
    const owner = prefixOwner.get(p);
    if (owner !== undefined && owner !== inventory) {
      throw new TravError(
        'invalid_argument',
        `mock-tickets: receipt prefix ${p} is used by more than one inventory`,
      );
    }
    prefixOwner.set(p, inventory);
  };
  for (const inventory of inventories) {
    const source: InventoryState = { inventory, orders: 0 };
    const tripCities = inventory.cities.map((c) => fold(c.trim()));
    for (const ev of inventory.events) {
      claimPrefix(ev.orderPrefix, inventory);
      for (const inv of ev.offers) {
        if (inv.orderPrefix !== undefined) claimPrefix(inv.orderPrefix, inventory);
      }
      eventCities.set(ev.event.eventId, new Set([fold(ev.event.venue.city.trim()), ...tripCities]));
      if (events.has(ev.event.eventId)) {
        throw new TravError(
          'invalid_argument',
          `mock-tickets: event ${ev.event.eventId} is in more than one inventory`,
        );
      }
      events.set(ev.event.eventId, ev);
      for (const inv of ev.offers) {
        if (offers.has(inv.offer.offerId)) {
          throw new TravError(
            'invalid_argument',
            `mock-tickets: offer ${inv.offer.offerId} is in more than one inventory`,
          );
        }
        offers.set(inv.offer.offerId, {
          inv,
          event: ev,
          source,
          available: inv.offer.available,
          unitPrice: inv.offer.unitPrice,
          unitFees: inv.offer.unitFees,
          nextSeat: inv.seating?.firstSeat ?? 1,
        });
      }
    }
  }

  const holds = new Map<string, HoldState>();
  const holdByKey = new Map<IdempotencyKey, string>();
  const orders = new Map<string, OrderState>();
  const orderByKey = new Map<IdempotencyKey, string>();
  /** approvalId => the action that consumed it (`purchase:<key>` / `refund:<key>`). */
  const approvalUse = new Map<string, string>();
  const refundsByKey = new Map<IdempotencyKey, RefundRecord>();
  let holdCounter = 0;
  let orderCounter = 0;
  let refundCounter = 0;

  /** Expire lapsed holds and return their seats. A hold is expired AT `expiresAt`. */
  const sweep = (): void => {
    const nowMs = clock.nowMs();
    for (const h of holds.values()) {
      if (h.status === 'active' && nowMs >= h.expiresAtMs) {
        h.status = 'expired';
        const state = offers.get(h.offerId);
        if (state) state.available += h.hold.quantity;
      }
    }
  };

  const offerView = (state: OfferState): TicketOffer => ({
    ...state.inv.offer,
    unitPrice: state.unitPrice,
    unitFees: state.unitFees,
    available: state.available,
  });

  const salesClosed = (ev: InventoryEvent): boolean => clock.nowMs() >= parseIso(ev.salesEndAt);

  const offerState = (offerId: string): OfferState => {
    const state = offers.get(offerId);
    if (!state) throw new TravError('not_found', `mock-tickets: unknown offer ${offerId}`);
    return state;
  };

  const matchesQuery = (ev: InventoryEvent, query: string | undefined): boolean => {
    if (query === undefined) return true;
    const tokens = fold(query)
      .split(/[^a-z0-9+]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
    if (tokens.length === 0) return true;
    const haystack = fold(
      [
        ev.event.name,
        ev.event.venue.name,
        ev.event.category,
        ...ev.event.contentFlags,
        ...ev.keywords,
        ...ev.offers.map((o) => o.offer.tierName),
      ].join(' '),
    );
    return tokens.some((t) => haystack.includes(t));
  };

  const issueTickets = (
    orderId: string,
    state: OfferState,
    holders: readonly TicketHolder[],
  ): IssuedTicket[] =>
    holders.map((holder) => {
      const ticketId = ids.next('tkt');
      const seating = state.inv.seating;
      let seatFields: Pick<IssuedTicket, 'section' | 'seat'> = {};
      if (seating) {
        const seatNo = state.nextSeat;
        state.nextSeat += 1;
        const rowPart = seating.row !== undefined ? `row ${seating.row} · ` : '';
        seatFields = {
          section:
            seating.gate !== undefined
              ? `gate ${seating.gate} · sector ${seating.section}`
              : `sector ${seating.section}`,
          seat: `${rowPart}seat ${seatNo}`,
        };
      }
      return {
        ticketId,
        status: 'issued',
        holderMemberId: holder.memberId,
        holderName: holder.name,
        barcode: { format: 'qr', payload: mockBarcodePayload(orderId, ticketId) },
        transferable: !state.inv.offer.requiresHolderNames,
        ...seatFields,
        ...(state.inv.entryBefore !== undefined ? { entryBefore: state.inv.entryBefore } : {}),
      };
    });

  const validateHolders = (holders: unknown, quantity: number): AdapterError | undefined => {
    const bad = (message: string): AdapterError => ({
      code: 'invalid_request',
      message,
      retryable: false,
    });
    if (!Array.isArray(holders)) return bad('holders must be an array');
    if (holders.length !== quantity) {
      return bad(`expected ${quantity} holders, got ${holders.length}`);
    }
    const seen = new Set<string>();
    for (const h of holders as unknown[]) {
      if (typeof h !== 'object' || h === null) return bad('holder must be an object');
      const holder = h as Partial<TicketHolder>;
      if (typeof holder.memberId !== 'string' || holder.memberId.length === 0) {
        return bad('holder.memberId is required');
      }
      if (typeof holder.name !== 'string' || holder.name.trim().length === 0) {
        return bad('holder.name is required');
      }
      if (seen.has(holder.memberId)) return bad(`duplicate holder ${holder.memberId}`);
      seen.add(holder.memberId);
    }
    return undefined;
  };

  const adapter: MockTickets = {
    info,

    searchEvents(request: EventSearchRequest) {
      sweep();
      if (typeof request.city !== 'string' || request.city.trim().length === 0) {
        return Promise.resolve(err('invalid_request', 'city is required'));
      }
      let fromDate: string;
      let toDate: string;
      try {
        // addDays validates the calendar date and normalizes it.
        fromDate = addDays(request.dateFrom, 0);
        toDate = addDays(request.dateTo, 0);
      } catch {
        return Promise.resolve(err('invalid_request', 'dateFrom/dateTo must be YYYY-MM-DD'));
      }
      if (fromDate > toDate) {
        return Promise.resolve(err('invalid_request', 'dateFrom is after dateTo'));
      }
      const quantity = request.quantity;
      if (quantity !== undefined && !isPositiveInt(quantity)) {
        return Promise.resolve(err('invalid_request', 'quantity must be a positive integer'));
      }
      const city = fold(request.city.trim());
      const categories = request.categories;
      const maxUnit = request.maxUnitPrice;

      const found = [...events.values()]
        .filter((ev) => eventCities.get(ev.event.eventId)?.has(city) === true)
        .filter((ev) => {
          const night = eventNightOf(ev.event);
          return night >= fromDate && night <= toDate;
        })
        .filter((ev) => categories === undefined || categories.includes(ev.event.category))
        .filter((ev) => matchesQuery(ev, request.query))
        .filter((ev) => {
          if (quantity === undefined && maxUnit === undefined) return true;
          return ev.offers.some((inv) => {
            const state = offerState(inv.offer.offerId);
            if (quantity !== undefined && state.available < quantity) return false;
            if (maxUnit !== undefined) {
              if (maxUnit.currency !== state.unitPrice.currency) return false;
              if (add(state.unitPrice, state.unitFees).amountMinor > maxUnit.amountMinor) {
                return false;
              }
            }
            return true;
          });
        })
        .sort(
          (a, b) =>
            parseIso(a.event.startsAt) - parseIso(b.event.startsAt) ||
            a.event.eventId.localeCompare(b.event.eventId),
        )
        .map((ev) => ev.event);
      return Promise.resolve(ok(found));
    },

    getOffers(eventId, quantity) {
      sweep();
      const ev = events.get(eventId);
      if (!ev) return Promise.resolve(err('not_found', `no event ${eventId}`));
      if (!isPositiveInt(quantity)) {
        return Promise.resolve(err('invalid_request', 'quantity must be a positive integer'));
      }
      if (salesClosed(ev)) return Promise.resolve(ok([]));
      const list = ev.offers
        .map((inv) => offerState(inv.offer.offerId))
        .filter((state) => state.available >= quantity)
        .map(offerView);
      return Promise.resolve(ok(list));
    },

    hold(offerId, quantity, idempotencyKey) {
      sweep();
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return Promise.resolve(err('invalid_request', 'idempotencyKey is required'));
      }
      const priorId = holdByKey.get(idempotencyKey);
      const prior = priorId === undefined ? undefined : holds.get(priorId);
      if (prior) {
        if (prior.offerId !== offerId || prior.hold.quantity !== quantity) {
          return Promise.resolve(
            err('duplicate', 'idempotency key already used for a different hold'),
          );
        }
        if (prior.status === 'active' || prior.status === 'purchased') {
          return Promise.resolve(ok(prior.hold));
        }
        // expired or released: fall through and place a fresh hold under the same key.
      }
      const state = offers.get(offerId);
      if (!state) return Promise.resolve(err('not_found', `no offer ${offerId}`));
      const offer = state.inv.offer;
      if (offer.purchaseMode === 'redirect_only') {
        return Promise.resolve(
          err(
            'not_supported',
            `redirect_only: members buy this on the provider's site (${offer.checkoutUrl ?? 'no url'})`,
          ),
        );
      }
      if (!isPositiveInt(quantity) || quantity > offer.maxPerOrder) {
        return Promise.resolve(
          err('invalid_request', `quantity must be 1-${offer.maxPerOrder} for this offer`),
        );
      }
      if (salesClosed(state.event)) {
        return Promise.resolve(err('offer_expired', 'sales for this event have closed'));
      }
      if (state.available < quantity) {
        return Promise.resolve(
          err('sold_out', `only ${state.available} left for ${offer.tierName}`),
        );
      }

      holdCounter += 1;
      const subtotal = multiply(state.unitPrice, quantity);
      const fees = multiply(state.unitFees, quantity);
      const taxes = zero(state.unitPrice.currency);
      const now = clock.now();
      const expiresAt = addMinutes(
        now,
        state.inv.holdMinutes ?? state.source.inventory.holdMinutes,
      );
      const hold: TicketHold = {
        holdId: `hold_mock_${String(holdCounter).padStart(6, '0')}`,
        offerId,
        quantity,
        subtotal,
        fees,
        taxes,
        total: sum([subtotal, fees, taxes], state.unitPrice.currency),
        expiresAt,
      };
      state.available -= quantity;
      holds.set(hold.holdId, {
        hold,
        offerId,
        key: idempotencyKey,
        expiresAtMs: parseIso(expiresAt),
        unitPrice: state.unitPrice,
        unitFees: state.unitFees,
        status: 'active',
      });
      holdByKey.set(idempotencyKey, hold.holdId);
      return Promise.resolve(ok(hold));
    },

    releaseHold(holdId) {
      sweep();
      const h = holds.get(holdId);
      if (!h) return Promise.resolve(err('not_found', `no hold ${holdId}`));
      if (h.status === 'purchased') {
        return Promise.resolve(err('invalid_request', 'hold was already purchased'));
      }
      if (h.status === 'active') {
        h.status = 'released';
        offerState(h.offerId).available += h.hold.quantity;
      }
      return Promise.resolve(ok(undefined));
    },

    purchase(request: PurchaseTicketsRequest) {
      sweep();
      if (typeof request !== 'object' || request === null) {
        return Promise.resolve(err('invalid_request', 'request is required'));
      }

      // 1. Idempotent replay.
      const priorOrderId = orderByKey.get(request.idempotencyKey);
      if (priorOrderId !== undefined) {
        const shapeError = checkApprovalProofShape(request.approval);
        if (shapeError) return Promise.resolve(fromError(shapeError));
        const prior = orders.get(priorOrderId);
        if (!prior) throw new Error(`mock-tickets: lost order ${priorOrderId}`);
        const holderIds: unknown[] = Array.isArray(request.holders)
          ? request.holders.map((h: TicketHolder | null) => h?.memberId)
          : [];
        const same =
          prior.groupId === request.groupId &&
          prior.groupId === request.approval.groupId &&
          prior.holdId === request.holdId &&
          prior.order.approvalId === request.approval.approvalId &&
          isMoneyValue(request.expectedTotal) &&
          equals(request.expectedTotal, prior.order.total) &&
          holderIds.length === prior.holderIds.length &&
          holderIds.every((id, i) => id === prior.holderIds[i]);
        if (!same) {
          return Promise.resolve(
            err('duplicate', 'idempotency key already used for a different purchase'),
          );
        }
        return Promise.resolve(ok(prior.order));
      }
      if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length === 0) {
        return Promise.resolve(err('invalid_request', 'idempotencyKey is required'));
      }

      // 2. Hold.
      const h = holds.get(request.holdId);
      if (!h) return Promise.resolve(err('not_found', `no hold ${String(request.holdId)}`));
      if (h.status === 'purchased') {
        return Promise.resolve(
          err('duplicate', 'hold was already purchased under another idempotency key'),
        );
      }
      if (h.status === 'released') {
        return Promise.resolve(err('not_found', 'hold was released'));
      }
      if (h.status === 'expired') {
        return Promise.resolve(
          err('hold_expired', 'hold expired; place a new hold and re-approve'),
        );
      }

      // 3. Approval validity.
      const validity = checkApprovalProofValidity(request.approval, clock.nowMs());
      if (validity) return Promise.resolve(fromError(validity));
      const approval: ApprovalProof = request.approval;
      const groupError = checkRequestGroup(request.groupId, approval);
      if (groupError) return Promise.resolve(fromError(groupError));

      // 4. Expected total.
      if (!isMoneyValue(request.expectedTotal) || !equals(request.expectedTotal, h.hold.total)) {
        return Promise.resolve(
          err('price_changed', 'expectedTotal does not match the held total', {
            newAmount: h.hold.total,
          }),
        );
      }

      // 5. Approval covers the total.
      const covers = checkApprovalCovers(approval, h.hold.total);
      if (covers) return Promise.resolve(fromError(covers));

      // 6. Holders.
      const holderError = validateHolders(request.holders, h.hold.quantity);
      if (holderError) return Promise.resolve(fromError(holderError));

      // 7. One approval, one action (an order or a refund).
      const usedBy = approvalUse.get(approval.approvalId);
      if (usedBy !== undefined && usedBy !== `purchase:${request.idempotencyKey}`) {
        return Promise.resolve(err('approval_invalid', 'approval already used for another action'));
      }

      const state = offerState(h.offerId);
      if (salesClosed(state.event)) {
        return Promise.resolve(err('offer_expired', 'sales for this event have closed'));
      }

      orderCounter += 1;
      // Numbered per inventory; prefixes are disjoint across inventories
      // (checked in the factory), so ids are unique and one trip's purchases
      // never shift another trip's numbers.
      state.source.orders += 1;
      const prefix = state.inv.orderPrefix ?? state.event.orderPrefix;
      const orderId = `${prefix}-${orderNumberStart + state.source.orders - 1}`;
      const now = clock.now();
      const offer = state.inv.offer;
      const lines: ReceiptLine[] = [
        {
          description: offer.tierName,
          quantity: h.hold.quantity,
          unitAmount: h.unitPrice,
          amount: h.hold.subtotal,
        },
      ];
      if (h.hold.fees.amountMinor > 0) {
        lines.push({
          description: 'Service fee',
          quantity: h.hold.quantity,
          unitAmount: h.unitFees,
          amount: h.hold.fees,
        });
      }
      if (h.hold.taxes.amountMinor > 0) {
        lines.push({
          description: 'Taxes',
          quantity: 1,
          unitAmount: h.hold.taxes,
          amount: h.hold.taxes,
        });
      }
      const order: TicketOrder = {
        orderId,
        event: state.event.event,
        offer: { ...offerView(state), unitPrice: h.unitPrice, unitFees: h.unitFees },
        status: 'confirmed',
        total: h.hold.total,
        receipt: { receiptNumber: orderId, issuedAt: now, lines },
        tickets: issueTickets(orderId, state, request.holders),
        createdAt: now,
        approvalId: approval.approvalId,
      };
      h.status = 'purchased';
      orders.set(orderId, {
        order,
        key: request.idempotencyKey,
        groupId: request.groupId,
        holdId: h.hold.holdId,
        holderIds: request.holders.map((x) => x.memberId),
        offerId: h.offerId,
        refunded: new Set(),
      });
      orderByKey.set(request.idempotencyKey, orderId);
      approvalUse.set(approval.approvalId, `purchase:${request.idempotencyKey}`);
      return Promise.resolve(ok(order));
    },

    getOrder(orderId) {
      const o = orders.get(orderId);
      return Promise.resolve(o ? ok(o.order) : err('not_found', `no order ${orderId}`));
    },

    getTicketForHolder(orderId, memberId) {
      const o = orders.get(orderId);
      if (!o) return Promise.resolve(err('not_found', `no order ${orderId}`));
      const ticket = o.order.tickets.find((t) => t.holderMemberId === memberId);
      if (!ticket) return Promise.resolve(err('not_found', 'no ticket for this member'));
      // A refunded ticket is void: never hand it out for DM delivery.
      if (ticket.status !== 'issued' || o.refunded.has(ticket.ticketId)) {
        return Promise.resolve(err('not_found', 'this ticket was refunded'));
      }
      return Promise.resolve(ok(ticket));
    },

    refund(orderId, ticketIds, approval, idempotencyKey) {
      sweep();
      const idsKey = Array.isArray(ticketIds) ? [...ticketIds].sort().join(',') : '';
      const prior = refundsByKey.get(idempotencyKey);
      if (prior) {
        const shapeError = checkApprovalProofShape(approval);
        if (shapeError) return Promise.resolve(fromError(shapeError));
        if (
          prior.orderId !== orderId ||
          prior.ticketIds !== idsKey ||
          prior.approvalId !== approval.approvalId ||
          prior.approvalGroupId !== approval.groupId
        ) {
          return Promise.resolve(
            err('duplicate', 'idempotency key already used for a different refund'),
          );
        }
        return Promise.resolve(ok(prior.result));
      }
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return Promise.resolve(err('invalid_request', 'idempotencyKey is required'));
      }
      const o = orders.get(orderId);
      if (!o) return Promise.resolve(err('not_found', `no order ${orderId}`));
      if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
        return Promise.resolve(err('invalid_request', 'ticketIds must not be empty'));
      }
      if (new Set(ticketIds).size !== ticketIds.length) {
        return Promise.resolve(err('invalid_request', 'duplicate ticketIds'));
      }
      const known = new Set(o.order.tickets.map((t) => t.ticketId));
      for (const id of ticketIds) {
        if (!known.has(id)) {
          return Promise.resolve(err('invalid_request', `ticket ${id} is not in this order`));
        }
        if (o.refunded.has(id)) {
          return Promise.resolve(err('invalid_request', `ticket ${id} is already refunded`));
        }
      }
      const policy = o.order.offer.refundPolicy;
      if (!policy.refundable) {
        return Promise.resolve(err('not_supported', 'these tickets are non-refundable'));
      }
      if (
        policy.refundableUntil !== undefined &&
        clock.nowMs() >= parseIso(policy.refundableUntil)
      ) {
        return Promise.resolve(err('not_supported', 'the refund window has closed'));
      }
      const validity = checkApprovalProofValidity(approval, clock.nowMs());
      if (validity) return Promise.resolve(fromError(validity));
      const groupError = checkRequestGroup(o.groupId, approval);
      if (groupError) return Promise.resolve(fromError(groupError));
      // One approval, one action: neither the purchase approval nor another
      // refund's approval may fund this refund.
      const usedBy = approvalUse.get(approval.approvalId);
      if (usedBy !== undefined && usedBy !== `refund:${idempotencyKey}`) {
        return Promise.resolve(err('approval_invalid', 'approval already used for another action'));
      }
      const unit = add(o.order.offer.unitPrice, o.order.offer.unitFees);
      const refundAmount = multiply(unit, ticketIds.length);
      const covers = checkApprovalCovers(approval, refundAmount);
      if (covers) return Promise.resolve(fromError(covers));

      for (const id of ticketIds) o.refunded.add(id);
      offerState(o.offerId).available += ticketIds.length;
      refundCounter += 1;
      const allRefunded = o.refunded.size === o.order.tickets.length;
      o.order = {
        ...o.order,
        status: allRefunded ? 'refunded' : 'partially_refunded',
        refundedAmount: add(o.order.refundedAmount ?? zero(refundAmount.currency), refundAmount),
        tickets: o.order.tickets.map((t) =>
          o.refunded.has(t.ticketId) ? { ...t, status: 'refunded' } : t,
        ),
      };
      // The result names this action's amount; the stored order keeps only the total.
      const result: TicketOrder = { ...o.order, refundAmount };
      refundsByKey.set(idempotencyKey, {
        orderId,
        ticketIds: idsKey,
        approvalId: approval.approvalId,
        approvalGroupId: approval.groupId,
        result,
      });
      approvalUse.set(approval.approvalId, `refund:${idempotencyKey}`);
      return Promise.resolve(ok(result));
    },

    purchaseCount: () => orderCounter,
    holdCount: () => holdCounter,
    refundCount: () => refundCounter,
    holdStatus(holdId) {
      sweep();
      return holds.get(holdId)?.status;
    },
    availableFor(offerId) {
      sweep();
      return offerState(offerId).available;
    },
    setAvailable(offerId, available) {
      if (!Number.isSafeInteger(available) || available < 0) {
        throw new TravError('invalid_argument', 'available must be a non-negative integer');
      }
      offerState(offerId).available = available;
    },
    setUnitPrice(offerId, unitPrice, unitFees) {
      const state = offerState(offerId);
      state.unitPrice = money(unitPrice.amountMinor, unitPrice.currency);
      state.unitFees =
        unitFees === undefined
          ? zero(unitPrice.currency)
          : money(unitFees.amountMinor, unitFees.currency);
      if (state.unitFees.currency !== state.unitPrice.currency) {
        throw new TravError('currency_mismatch', 'unitFees currency differs from unitPrice');
      }
    },
  };
  return adapter;
}
