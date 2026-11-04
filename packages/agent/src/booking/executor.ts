/**
 * BookingExecutor: THE single purchase call site (SAFETY §2.1; D-004).
 *
 * This file (`packages/agent/src/booking/executor.ts`) is the only non-test
 * file in `packages/` and `apps/` that may call a provider's `purchase(`,
 * `createOrder(`, `book(` or the payments adapter's `charge(`. The
 * architectural grep test (T-054) asserts exactly one call site per method,
 * and A1b asserts `execute` has one caller (`approval/handler.ts`).
 *
 * `execute()` order, each step idempotent and each audit event written before
 * the next step runs:
 *  1. load proposal, decision, grant; `checkGrant()` (match, complete, unexpired,
 *     not denied); the proof the providers will see is refused AT `expiresAt`.
 *     A retry of a booking that already landed under the key (`retryOfDone`)
 *     skips the grant status and expiry checks: nothing new can be bought.
 *  2. `bookings.getBookingByKey(idempotencyKey)` hit ⇒ `booking.duplicate_suppressed`,
 *     then steps 8 and 9 are re-run idempotently (a missing expense or missing
 *     tickets are filled in); return `duplicate` with `repaired` saying whether
 *     anything was, so the handler re-sends the receipt and ticket DMs then
 *  3. audit `booking.attempted`
 *  4. re-check, right before any money moves: the provider re-price (ticket hold
 *     re-read / flight offer / lodging rate), the LIVE activity roster through
 *     `checkProposalConsistency` (T-030 note b) and `detectGrantInvalidation`
 *     (price, payers, attendees, member inactive, policy snapshot). Any change ⇒
 *     `invalidateGrant`, audit `approval.invalidated`, return `refused`; the
 *     handler re-quotes. The payer's saved card is checked before purchasing.
 *  5. `toApprovalProof` (approvedBy ⊇ [requestedBy]; `proof.groupId === proposal.groupId`
 *     checked here) → provider purchase with `idempotencyKey` + proof (same key ⇒ same
 *     order) → for `member_card`, the payments charge to the requester's card
 *     (D-005) → grant consumed (it can never buy again). The purchase goes
 *     first so that every `failed` result really is `moneyMoved: false`: the
 *     common failures (sold out, hold expired, price changed) happen before
 *     any card is charged.
 *  6. audit `booking.completed` (the Booking row carries its id, so the event is
 *     sealed first; it is also the handler's "money moved" marker)
 *  7. `bookings.createBooking` right away, with no ticket refs yet (duplicate
 *     key ⇒ treat as step 2), so nothing after the charge can leave money
 *     moved without a Booking row; the proposal is `completed`
 *  8. ledger: `Expense{ sourceRef: { kind: 'booking', id } }` via `expenses.create`
 *     (idempotent on sourceRef); audit `ledger.written`
 *  9. ticket artifacts, each from `getTicketForHolder` (never `getOrder`), →
 *     `PrivateStore.putTicket(holder, …)` (QR never touches GroupStore); a
 *     minor's goes to the guardian; then the refs (ids only) are added to the
 *     Booking row. A holder whose artifact is already stored is not re-fetched.
 *     A failing `getTicketForHolder` throws AFTER steps 7 and 8 landed: the
 *     handler's "money moved" branch retries, and step 2 fills in the rest.
 * Any provider failure before the purchase ⇒ audit `booking.failed`, return
 * `failed` with `moneyMoved: false`. A charge that fails after the purchase is
 * audited `booking.failed{stage:'charge'}` and returned as `failed` with
 * `resumable: true`: the card was not charged, the grant stays complete and
 * the proposal goes back to `pending`, so the next approval re-runs `execute`
 * with the same key and grant; the provider replays the same order (never a
 * second one) and the charge is tried again. The mock providers have no void
 * for an unpaid order; if nobody retries, the proposal expires with no charge.
 */
import type {
  Activity,
  ApprovalGrant,
  AuditEventId,
  AuditEventInput,
  Booking,
  BookingProposal,
  Clock,
  Expense,
  ExpenseCategory,
  GrantId,
  GrantInvalidationCause,
  Group,
  IdGenerator,
  IsoDateTime,
  Member,
  MemberId,
  PolicyDecision,
  ProposalId,
  Stores,
  TicketArtifact,
  TicketRef,
  Trip,
} from '@trav/core';
import { approval, ledger, markPrivate, money, parseIso, safety, TravError } from '@trav/core';
import type {
  AdapterError,
  ApprovalProof,
  BookingPaymentsAdapter,
  FlightsAdapter,
  IssuedTicket,
  LodgingAdapter,
  Result,
  TicketsAdapter,
  Traveler,
} from '@trav/adapters';
import { mockQrDataUrl } from '@trav/adapters';
import { sanitizeInline } from '../context/groupContext.js';
import { bookingParty, rosterOf } from '../roster/index.js';
import { bookedAttendees } from './proposals.js';

export interface ProviderRegistry {
  readonly tickets: TicketsAdapter;
  readonly flights: FlightsAdapter;
  readonly lodging: LodgingAdapter;
  readonly payments: BookingPaymentsAdapter;
}

export interface BookingExecutorDeps {
  readonly stores: Stores;
  readonly providers: ProviderRegistry;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type ExecuteResult =
  | {
      readonly kind: 'completed';
      readonly booking: Booking;
      readonly expense: Expense;
      readonly auditEventIds: readonly AuditEventId[];
    }
  | {
      readonly kind: 'duplicate';
      readonly booking: Booking;
      /** The booking's ledger expense, when it exists (it always should after a repair). */
      readonly expense?: Expense;
      /** True when this call filled in a missing expense or missing tickets: the receipt and DMs never went out. */
      readonly repaired: boolean;
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'proposal_mismatch'
        | 'incomplete'
        | 'expired'
        | 'wrong_status'
        | 'decision_denied'
        | 'decision_mismatch'
        | 'price_changed'
        | 'payers_changed'
        | 'proposal_not_pending'
        | 'consistency';
      /** The replacement proposal when a re-quote was needed. */
      readonly reproposalId?: ProposalId;
    }
  | {
      readonly kind: 'failed';
      readonly errorCode: string;
      readonly retriable: boolean;
      readonly moneyMoved: false;
      /**
       * The charge failed after the provider purchase: the proposal is back to
       * `pending` with its grant still complete, and approving it again re-runs
       * `execute` under the same key (the provider replays the same order).
       */
      readonly resumable?: true;
    };

export interface BookingExecutor {
  /** Throws `TravError('grant_invalid')` only on programmer misuse (unknown ids); every policy outcome is a returned value. */
  execute(proposalId: ProposalId, grantId: GrantId): Promise<ExecuteResult>;
}

type Refusal = Extract<ExecuteResult, { kind: 'refused' }>['reason'];

/**
 * Proposal statuses nothing can be bought from any more (their grant was
 * dropped). A `failed` proposal whose grant is still complete may be retried:
 * the grant re-check, not the proposal status, is what gates money.
 */
const TERMINAL_STATUSES: ReadonlySet<BookingProposal['status']> = new Set([
  'rejected',
  'expired',
  'superseded',
]);

/** Consistency problems that mean "who is on this changed" (SAFETY §2.1 invalidation rule). */
const ROSTER_PROBLEMS: readonly string[] = [
  'empty_roster',
  'quantity_not_roster',
  'attendee_marked_out',
  'payers_not_attendees',
];

const CATEGORY_BY_KIND: Readonly<Record<BookingProposal['kind'], ExpenseCategory>> = {
  ticket: 'tickets',
  flight: 'flights',
  lodging: 'lodging',
  transport: 'transport',
  other: 'other',
};

/** Everything one `execute` call needs, loaded once. */
interface Loaded {
  readonly proposal: BookingProposal;
  readonly grant: ApprovalGrant;
  readonly decision: PolicyDecision;
  readonly group: Group;
  readonly trip: Trip;
  readonly members: readonly Member[];
  readonly activity: Activity | null;
  readonly now: IsoDateTime;
}

/** The provider's current price for the item, plus the reference the purchase must present. */
interface Repriced {
  readonly totalMinor: number;
  readonly currency: string;
  readonly quoteRef: string;
}

/** What a provider purchase came back with, normalized across kinds. */
interface Purchased {
  readonly providerRef: string;
  readonly orderRef: string;
  readonly merchant: string;
  readonly totalMinor: number;
  readonly currency: string;
  readonly purchasedAt: IsoDateTime;
  /** For ticket orders: what the DM ticket cards say about the event (no barcodes here). */
  readonly ticketEvent?: TicketArtifact['event'];
}

/** The live party for the proposal's activity (or the proposal's own list without one). */
interface LiveParty {
  readonly attendees: readonly MemberId[];
  readonly payers: readonly MemberId[];
  readonly problems: readonly string[];
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function notSupported<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'not_supported', message, retryable: false } };
}

function nameOf(members: readonly Member[], id: MemberId): string {
  return sanitizeInline(members.find((m) => m.memberId === id)?.displayName ?? id, 40);
}

/**
 * A provider traveler from a member's display name ("Dean Yao" ⇒ Dean / Yao).
 * v0 stores no legal names, so a single-word display name yields none: the
 * executor then refuses to book a flight or stay for that member instead of
 * inventing a family name.
 */
export function travelerOf(member: Member): Traveler | undefined {
  const parts = sanitizeInline(member.displayName, 80).trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return undefined;
  return { memberId: member.memberId, givenName: parts[0]!, familyName: parts.slice(1).join(' ') };
}

/** `gate 14 · sector 234` + `row 8 · seat 11` ⇒ { gate, section, row, seat }, when present. */
export function parseSeat(ticket: Pick<IssuedTicket, 'section' | 'seat'>): TicketArtifact['seat'] {
  const text = [ticket.section, ticket.seat].filter((s) => s !== undefined).join(' · ');
  if (text.length === 0) return undefined;
  const pick = (label: string): string | undefined =>
    new RegExp(`\\b${label}\\s+([^·]+?)\\s*(?:·|$)`, 'i').exec(text)?.[1]?.trim();
  const seat = {
    ...(pick('gate') !== undefined ? { gate: pick('gate')! } : {}),
    ...(pick('sector') !== undefined ? { section: pick('sector')! } : {}),
    ...(pick('row') !== undefined ? { row: pick('row')! } : {}),
    ...(pick('seat') !== undefined ? { seat: pick('seat')! } : {}),
  };
  return Object.keys(seat).length > 0 ? seat : undefined;
}

export function createBookingExecutor(deps: BookingExecutorDeps): BookingExecutor {
  const { stores, providers, clock, ids } = deps;
  const group = stores.group;

  // ---------- helpers ----------

  function audit(input: AuditEventInput): AuditEventId {
    return group.audit.append(input).id;
  }

  function common(proposal: BookingProposal, bookingId?: string) {
    return {
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      actor: { kind: 'trav', id: 'trav' } as const,
      visibility: 'group' as const,
      proposalId: proposal.proposalId,
      idempotencyKey: proposal.idempotencyKey,
      ...(bookingId !== undefined ? { bookingId } : {}),
    };
  }

  function setStatus(proposalId: ProposalId, status: BookingProposal['status']): void {
    const current = group.bookings.getProposal(proposalId);
    if (current === undefined || current.status === status) return;
    group.bookings.updateProposal({ ...current, status });
  }

  function load(proposalId: ProposalId, grantId: GrantId): Loaded {
    const proposal = group.bookings.getProposal(proposalId);
    const grant = group.bookings.getGrant(grantId);
    const decision = group.bookings.getDecision(proposalId)?.decision;
    if (proposal === undefined || grant === undefined || decision === undefined) {
      throw new TravError('grant_invalid', `execute: unknown proposal, grant or decision`, {
        proposalId,
        grantId,
      });
    }
    const grp = group.groups.get(proposal.groupId);
    const trip = group.trips.get(proposal.tripId);
    if (grp === undefined || trip === undefined) {
      throw new TravError('grant_invalid', `execute: proposal ${proposalId} has no group or trip`, {
        proposalId,
      });
    }
    return {
      proposal,
      grant,
      decision,
      group: grp,
      trip,
      members: group.members.listByGroup(proposal.groupId),
      activity:
        proposal.activityId === undefined
          ? null
          : (group.trips.getActivity(proposal.activityId) ?? null),
      now: clock.now(),
    };
  }

  /** The `approval.granted` event that completed the grant; the decision event for an auto-approval. */
  function grantedEventId(ctx: Loaded): AuditEventId {
    const granted = group.audit
      .listByProposal(ctx.proposal.proposalId)
      .filter((e) => e.type === 'approval.granted' && e.lifecycle?.complete === true)
      .at(-1);
    return granted?.id ?? ctx.grant.decisionId;
  }

  // ---------- step 4: the re-check ----------

  /** The provider order a charge failure left standing under this proposal's key, if any. */
  function standingOrder(proposalId: ProposalId): Repriced | undefined {
    const failed = group.audit
      .listByProposal(proposalId)
      .filter((e) => e.type === 'booking.failed')
      .at(-1);
    const p = failed?.payload as Record<string, unknown> | undefined;
    if (p?.stage !== 'charge' || p.resumable !== true) return undefined;
    if (
      typeof p.quoteRef !== 'string' ||
      typeof p.totalMinor !== 'number' ||
      typeof p.currency !== 'string'
    )
      return undefined;
    return {
      quoteRef: p.quoteRef,
      totalMinor: p.totalMinor,
      currency: p.currency as Repriced['currency'],
    };
  }

  function liveParty(ctx: Loaded): LiveParty {
    const { proposal, trip, members, activity, now } = ctx;
    if (activity === null) {
      const check = approval.checkProposalConsistency(proposal, trip, null, null, members, now);
      return {
        attendees: proposal.attendees,
        payers: proposal.payers.map((p) => p.memberId),
        problems: check.problems,
      };
    }
    const roster = rosterOf(group.trips, activity.activityId, members, now);
    const party = bookingParty(roster, bookedAttendees(group, trip, activity.activityId));
    const check = approval.checkProposalConsistency(
      proposal,
      trip,
      activity,
      { ...roster, inMemberIds: party.attendees },
      members,
      now,
    );
    return { attendees: party.attendees, payers: party.payers, problems: check.problems };
  }

  async function reprice(proposal: BookingProposal): Promise<Result<Repriced>> {
    switch (proposal.kind) {
      case 'ticket': {
        // The same key re-reads the active hold (price locked); a released one
        // is re-placed at the provider's current price, which step 4 compares.
        const held = await providers.tickets.hold(
          proposal.itemRef,
          proposal.attendees.length,
          proposal.idempotencyKey,
        );
        if (!held.ok) return held;
        return ok({
          totalMinor: held.value.total.amountMinor,
          currency: held.value.total.currency,
          quoteRef: held.value.holdId,
        });
      }
      case 'flight': {
        const offer = await providers.flights.getOffer(proposal.itemRef);
        if (!offer.ok) return offer;
        return ok({
          totalMinor: offer.value.totalAmount.amountMinor,
          currency: offer.value.totalAmount.currency,
          quoteRef: offer.value.offerId,
        });
      }
      case 'lodging': {
        const rate = await providers.lodging.recheckRate(proposal.itemRef);
        if (!rate.ok) return rate;
        return ok({
          totalMinor: rate.value.totalAmount.amountMinor,
          currency: rate.value.totalAmount.currency,
          quoteRef: rate.value.rateId,
        });
      }
      default:
        return notSupported(`no provider can book a ${proposal.kind} proposal yet`);
    }
  }

  /** A fresh ticket hold this call placed (not the proposal's) is released when nothing is bought. */
  async function releaseFreshHold(ctx: Loaded, repriced: Repriced | undefined): Promise<void> {
    if (
      repriced === undefined ||
      ctx.proposal.kind !== 'ticket' ||
      repriced.quoteRef === ctx.proposal.quoteRef
    ) {
      return;
    }
    await providers.tickets.releaseHold(repriced.quoteRef);
  }

  /** Price, payer, attendee, membership or policy change ⇒ the grant is dead; the handler re-quotes. */
  async function invalidate(
    ctx: Loaded,
    cause: GrantInvalidationCause,
    extra: Record<string, unknown>,
    repriced: Repriced | undefined,
  ): Promise<ExecuteResult> {
    const { proposal } = ctx;
    const fresh = group.bookings.getGrant(ctx.grant.grantId) ?? ctx.grant;
    if (fresh.status === 'pending' || fresh.status === 'complete') {
      const invalidated = approval.invalidateGrant(fresh, cause);
      group.bookings.saveGrant(invalidated);
      const input = approval.invalidatedAuditInput(invalidated, proposal, {
        kind: 'trav',
        id: 'trav',
      });
      audit({ ...input, payload: { ...input.payload, stage: 'recheck', ...extra } });
    }
    await releaseFreshHold(ctx, repriced);
    setStatus(proposal.proposalId, 'pending');
    const reason: Refusal =
      cause === 'price_changed'
        ? 'price_changed'
        : cause === 'policy_changed'
          ? 'consistency'
          : 'payers_changed';
    return { kind: 'refused', reason };
  }

  /** A typed provider error before any money moved. */
  async function providerFailure(
    ctx: Loaded,
    bookingId: string,
    error: AdapterError,
    stage: 'reprice' | 'purchase',
    repriced: Repriced | undefined,
  ): Promise<ExecuteResult> {
    const { proposal } = ctx;
    if (error.code === 'price_changed') {
      return invalidate(
        ctx,
        'price_changed',
        {
          ...(error.newAmount !== undefined
            ? { newTotalMinor: error.newAmount.amountMinor, newCurrency: error.newAmount.currency }
            : {}),
        },
        repriced,
      );
    }
    if (error.code === 'hold_expired' || error.code === 'offer_expired') {
      await releaseFreshHold(ctx, repriced);
      setStatus(proposal.proposalId, 'pending');
      return { kind: 'refused', reason: 'expired' };
    }
    audit({
      ...common(proposal, bookingId),
      type: 'booking.failed',
      payload: {
        errorCode: error.code,
        retriable: error.retryable,
        stage,
        moneyMoved: false,
      },
    });
    await releaseFreshHold(ctx, repriced);
    setStatus(proposal.proposalId, 'failed');
    return { kind: 'failed', errorCode: error.code, retriable: error.retryable, moneyMoved: false };
  }

  // ---------- step 5: the purchase (one call site per provider method) ----------

  async function purchase(
    ctx: Loaded,
    repriced: Repriced,
    proof: ApprovalProof,
  ): Promise<Result<Purchased>> {
    const { proposal, members } = ctx;
    const expectedTotal = money(proposal.totalMinor, proposal.currency);
    const base = {
      groupId: proposal.groupId,
      expectedTotal,
      idempotencyKey: proposal.idempotencyKey,
      approval: proof,
    };
    switch (proposal.kind) {
      case 'ticket': {
        const res = await providers.tickets.purchase({
          ...base,
          holdId: repriced.quoteRef,
          holders: proposal.attendees.map((memberId) => ({
            memberId,
            name: nameOf(members, memberId),
          })),
        });
        if (!res.ok) return res;
        const order = res.value;
        return ok({
          providerRef: order.orderId,
          orderRef: order.receipt.receiptNumber,
          merchant: sanitizeInline(order.event.venue.name, 80),
          totalMinor: order.total.amountMinor,
          currency: order.total.currency,
          purchasedAt: order.createdAt,
          ticketEvent: {
            name: sanitizeInline(order.event.name, 80),
            venue: sanitizeInline(order.event.venue.name, 80),
            ...(order.event.venue.address !== undefined
              ? { address: sanitizeInline(order.event.venue.address, 120) }
              : {}),
            startsAt: order.event.startsAt,
            ...(order.event.doorsAt !== undefined ? { doorsAt: order.event.doorsAt } : {}),
          },
        });
      }
      case 'flight': {
        const travelers = proposal.attendees.map((id) => {
          const member = members.find((m) => m.memberId === id);
          return member === undefined ? undefined : travelerOf(member);
        });
        if (travelers.some((t) => t === undefined)) {
          return notSupported('a traveler has no family name on file');
        }
        const res = await providers.flights.createOrder({
          ...base,
          offerId: repriced.quoteRef,
          travelers: travelers as Traveler[],
        });
        if (!res.ok) return res;
        const order = res.value;
        return ok({
          providerRef: order.orderId,
          orderRef: order.bookingReference,
          merchant: sanitizeInline(order.offer.owner.name, 80),
          totalMinor: order.totalAmount.amountMinor,
          currency: order.totalAmount.currency,
          purchasedAt: order.createdAt,
        });
      }
      case 'lodging': {
        const leadId =
          proposal.paidBy.kind === 'member_card' ? proposal.paidBy.memberId : proposal.requestedBy;
        const lead = members.find((m) => m.memberId === leadId);
        const leadGuest = lead === undefined ? undefined : travelerOf(lead);
        if (leadGuest === undefined) {
          return notSupported('the lead guest has no family name on file');
        }
        const res = await providers.lodging.book({
          ...base,
          rateId: repriced.quoteRef,
          leadGuest,
          guestMemberIds: proposal.attendees,
        });
        if (!res.ok) return res;
        const stay = res.value;
        return ok({
          providerRef: stay.bookingId,
          orderRef: stay.confirmationCode,
          merchant: sanitizeInline(stay.property.name, 80),
          totalMinor: stay.rate.totalAmount.amountMinor,
          currency: stay.rate.totalAmount.currency,
          purchasedAt: stay.createdAt,
        });
      }
      default:
        return notSupported(`no provider can book a ${proposal.kind} proposal yet`);
    }
  }

  // ---------- steps 8 and 9: ledger and tickets (idempotent) ----------

  function splitFor(booking: Booking, memberOrder: readonly MemberId[]): Expense['split'] {
    const exact = {
      method: 'exact' as const,
      amounts: booking.payers.map((p) => ({
        memberId: p.memberId,
        amount: money(p.shareMinor, booking.currency),
      })),
    };
    if (booking.paidBy.kind !== 'member_card') return exact;
    // "split N ways on the tab" is an equal split when the proposal's shares
    // are exactly what the ledger's equal split would compute; else exact.
    const equal = { method: 'equal' as const, participants: booking.attendees };
    const probe: Expense = {
      expenseId: 'probe',
      groupId: booking.groupId,
      tripId: booking.tripId,
      description: 'probe',
      category: 'tickets',
      amount: money(booking.totalMinor, booking.currency),
      paidBy: [
        { memberId: booking.paidBy.memberId, amount: money(booking.totalMinor, booking.currency) },
      ],
      split: equal,
      source: 'booking',
      sourceRef: { kind: 'booking', id: booking.bookingId },
      occurredAt: booking.purchasedAt,
      createdAt: booking.purchasedAt,
      createdBy: booking.paidBy.memberId,
      status: 'logged',
    };
    try {
      const shares = ledger.computeShares(probe, {
        memberOrder,
        participantsUniverse: memberOrder,
      });
      const want = new Map(booking.payers.map((p) => [p.memberId, p.shareMinor]));
      const same =
        shares.length === want.size &&
        shares.every((s) => want.get(s.memberId) === s.amount.amountMinor);
      return same ? equal : exact;
    } catch {
      return exact;
    }
  }

  /** The ledger expense for the booking (D-005): one card fronting the total, split among the payers. */
  function buildExpense(booking: Booking, ctx: Loaded, expenseId: string): Expense {
    const total = money(booking.totalMinor, booking.currency);
    const memberOrder = ctx.members.map((m) => m.memberId);
    const paidBy =
      booking.paidBy.kind === 'member_card'
        ? [{ memberId: booking.paidBy.memberId, amount: total }]
        : booking.payers.map((p) => ({
            memberId: p.memberId,
            amount: money(p.shareMinor, booking.currency),
          }));
    return {
      expenseId,
      groupId: booking.groupId,
      tripId: booking.tripId,
      description: sanitizeInline(booking.description, 80),
      merchantDisplay: booking.merchant,
      category: CATEGORY_BY_KIND[booking.kind],
      amount: total,
      paidBy,
      split: splitFor(booking, memberOrder),
      source: 'booking',
      sourceRef: { kind: 'booking', id: booking.bookingId },
      ...(booking.activityId !== undefined ? { activityId: booking.activityId } : {}),
      occurredAt: booking.purchasedAt,
      createdAt: ctx.now,
      createdBy: ctx.proposal.requestedBy,
      status: 'logged',
    };
  }

  /** Writes the expense once (idempotent on `sourceRef`) and `ledger.written` with it. */
  function ensureExpense(
    booking: Booking,
    ctx: Loaded,
    auditIds: AuditEventId[],
  ): { readonly booking: Booking; readonly expense: Expense; readonly created: boolean } {
    const sourceRef = { kind: 'booking', id: booking.bookingId } as const;
    const existing = group.expenses.getBySourceRef(sourceRef);
    if (existing !== undefined) {
      const linked =
        booking.expenseId === existing.expenseId
          ? booking
          : { ...booking, expenseId: existing.expenseId };
      if (linked !== booking) group.bookings.updateBooking(linked);
      return { booking: linked, expense: existing, created: false };
    }
    const memberOrder = ctx.members.map((m) => m.memberId);
    const splitCtx: ledger.SplitContext = {
      memberOrder,
      participantsUniverse: ctx.members.filter((m) => m.active).map((m) => m.memberId),
    };
    const expense = buildExpense(booking, ctx, ids.next('exp'));
    const shares = ledger.computeShares(expense, splitCtx);
    group.expenses.create(expense, ledger.buildLedgerEntries(expense, splitCtx));
    auditIds.push(
      audit({
        ...common(ctx.proposal, booking.bookingId),
        type: 'ledger.written',
        payload: {
          expenseId: expense.expenseId,
          bookingId: booking.bookingId,
          splitMethod: expense.split.method,
          participants: shares.map((s) => s.memberId),
          shares: shares.map((s) => ({ memberId: s.memberId, shareMinor: s.amount.amountMinor })),
          totalMinor: expense.amount.amountMinor,
          currency: expense.amount.currency,
          paidBy: expense.paidBy.map((p) => p.memberId),
        },
      }),
    );
    const linked: Booking = { ...booking, expenseId: expense.expenseId };
    group.bookings.updateBooking(linked);
    return { booking: linked, expense, created: true };
  }

  /** Where a holder's ticket is delivered: a minor's goes to the guardian. */
  function deliveredTo(ctx: Loaded, memberId: MemberId): MemberId {
    const member = ctx.members.find((m) => m.memberId === memberId);
    const guardian =
      member !== undefined && safety.isMinor(member, ctx.now) ? member.guardianMemberId : undefined;
    return guardian ?? memberId;
  }

  /** The event facts the DM ticket cards show, from the `booking.completed` the receipt is rendered from. */
  function ticketEventOf(booking: Booking): TicketArtifact['event'] {
    const fallback = {
      name: booking.description,
      venue: booking.merchant,
      startsAt: booking.purchasedAt,
    };
    const raw = group.audit.get(booking.completedAuditEventId)?.payload['ticketEvent'];
    if (typeof raw !== 'object' || raw === null) return fallback;
    const e = raw as Readonly<Record<string, unknown>>;
    const str = (k: string): string | undefined => {
      const v = e[k];
      return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    const name = str('name');
    const venue = str('venue');
    const startsAt = str('startsAt');
    if (name === undefined || venue === undefined || startsAt === undefined) return fallback;
    const address = str('address');
    const doorsAt = str('doorsAt');
    return {
      name,
      venue,
      startsAt,
      ...(address !== undefined ? { address } : {}),
      ...(doorsAt !== undefined ? { doorsAt } : {}),
    };
  }

  /**
   * Step 9, idempotent: every attendee's own ticket from the provider (never
   * the whole order) into their private partition, then the refs (ids only)
   * onto the Booking row. A holder whose artifact is already stored is not
   * fetched again; a holder whose ticket cannot be fetched throws after the
   * ones before it were stored, and the next call picks up from there.
   */
  async function ensureTickets(
    ctx: Loaded,
    booking: Booking,
  ): Promise<{ readonly booking: Booking; readonly changed: boolean }> {
    if (booking.kind !== 'ticket') return { booking, changed: false };
    const refs: TicketRef[] = [];
    let changed = false;
    let event: TicketArtifact['event'] | undefined;
    for (const memberId of booking.attendees) {
      const stored = stores.private.listTickets(memberId, booking.bookingId);
      const ref = booking.tickets.find((t) => t.holderMemberId === memberId);
      const have =
        stored.find((a) => ref !== undefined && a.ticketId === ref.ticketId) ?? stored[0];
      if (have !== undefined) {
        refs.push({
          ticketId: have.ticketId,
          holderMemberId: memberId,
          deliveredToMemberId: have.deliveredToMemberId,
        });
        continue;
      }
      const res = await providers.tickets.getTicketForHolder(booking.providerRef, memberId);
      if (!res.ok) {
        throw new TravError('invariant_violation', `no ticket for a holder after purchase`, {
          providerRef: booking.providerRef,
          bookingId: booking.bookingId,
          memberId,
          code: res.error.code,
        });
      }
      const ticket = res.value;
      event ??= ticketEventOf(booking);
      const seat = parseSeat(ticket);
      const delivered = deliveredTo(ctx, memberId);
      const artifact: TicketArtifact = markPrivate({
        id: ids.next('priv'),
        ownerMemberId: memberId,
        groupId: booking.groupId,
        tripId: booking.tripId,
        createdAt: ctx.now,
        ticketId: ticket.ticketId,
        bookingId: booking.bookingId,
        holderName: sanitizeInline(ticket.holderName, 80),
        event,
        ...(seat !== undefined ? { seat } : {}),
        qrPayload: ticket.barcode.payload,
        qrDataUrl: mockQrDataUrl(ticket.barcode.payload),
        deliveredToMemberId: delivered,
      });
      stores.private.putTicket(memberId, artifact);
      refs.push({
        ticketId: ticket.ticketId,
        holderMemberId: memberId,
        deliveredToMemberId: delivered,
      });
      changed = true;
    }
    const same =
      refs.length === booking.tickets.length &&
      refs.every((r, i) => {
        const t = booking.tickets[i];
        return (
          t !== undefined &&
          t.ticketId === r.ticketId &&
          t.holderMemberId === r.holderMemberId &&
          t.deliveredToMemberId === r.deliveredToMemberId
        );
      });
    if (same) return { booking, changed };
    const linked: Booking = { ...booking, tickets: refs };
    group.bookings.updateBooking(linked);
    return { booking: linked, changed: true };
  }

  /** Steps 8 and 9 for a Booking row that exists: whatever is missing is filled in, nothing twice. */
  async function finish(
    ctx: Loaded,
    booking: Booking,
    auditIds: AuditEventId[],
  ): Promise<{ readonly booking: Booking; readonly expense: Expense; readonly repaired: boolean }> {
    const written = ensureExpense(booking, ctx, auditIds);
    const ticketed = await ensureTickets(ctx, written.booking);
    return {
      booking: ticketed.booking,
      expense: written.expense,
      repaired: written.created || ticketed.changed,
    };
  }

  // ---------- execute ----------

  async function execute(proposalId: ProposalId, grantId: GrantId): Promise<ExecuteResult> {
    const ctx = load(proposalId, grantId);
    const { proposal, grant, decision, now } = ctx;
    const refused = (reason: Refusal): ExecuteResult => ({ kind: 'refused', reason });

    // 1. the grant, re-checked here whatever the handler already did.
    const existing = group.bookings.getBookingByKey(proposal.idempotencyKey);
    // A booking already landed under this key with this proposal's own grant
    // (spent, or not yet marked spent): a retry, never a new purchase, so a
    // consumed status or a TTL that ran out since is no refusal (the
    // mismatch and deny checks still are).
    const retryOfDone =
      existing !== undefined &&
      grant.proposalId === proposal.proposalId &&
      decision.proposalId === proposal.proposalId &&
      decision.outcome !== 'deny' &&
      (grant.status === 'consumed' || grant.status === 'complete');
    if (!retryOfDone) {
      const check = approval.checkGrant(grant, proposal, decision, now);
      if (!check.valid) return refused(check.reason);
      if (parseIso(now) >= parseIso(grant.expiresAt)) return refused('expired');
    }
    if (TERMINAL_STATUSES.has(proposal.status)) return refused('proposal_not_pending');

    // 2. idempotency: the key already bought this. Whatever steps 8 and 9 did
    //    not finish last time is filled in now.
    if (existing !== undefined) {
      audit({
        ...common(proposal, existing.bookingId),
        type: 'booking.duplicate_suppressed',
        payload: { existingBookingId: existing.bookingId, grantId },
      });
      setStatus(proposal.proposalId, 'completed');
      const done = await finish(ctx, existing, []);
      return {
        kind: 'duplicate',
        booking: done.booking,
        expense: done.expense,
        repaired: done.repaired,
      };
    }

    // 3. attempted.
    const bookingId = ids.next('bk');
    const auditIds: AuditEventId[] = [];
    auditIds.push(
      audit({
        ...common(proposal, bookingId),
        type: 'booking.attempted',
        payload: { idempotencyKey: proposal.idempotencyKey, quoteRef: proposal.quoteRef, grantId },
      }),
    );
    setStatus(proposal.proposalId, 'executing');

    // 4. the re-check: price, roster, membership, policy. After a charge
    //    failure the provider order already stands under the key (its own
    //    booking used up the availability), so a flight or lodging retry
    //    replays it at the locked price instead of re-checking the rate
    //    (T-009 r2 review #2). Tickets re-read their hold under the same key.
    const standing = proposal.kind === 'ticket' ? undefined : standingOrder(proposal.proposalId);
    const repricedRes = standing !== undefined ? ok(standing) : await reprice(proposal);
    if (!repricedRes.ok) {
      return providerFailure(ctx, bookingId, repricedRes.error, 'reprice', undefined);
    }
    const repriced = repricedRes.value;
    const live = liveParty(ctx);
    const rosterish = live.problems.some((p) => ROSTER_PROBLEMS.includes(p));
    const cause =
      approval.detectGrantInvalidation({
        proposal,
        decision,
        currentPolicy: ctx.group.spendingPolicy,
        currentTotalMinor: repriced.totalMinor,
        currentCurrency: repriced.currency,
        currentPayerIds: live.payers,
        currentAttendeeIds: live.attendees,
        members: approval.toMemberViews(ctx.members, now),
      }) ??
      (rosterish
        ? 'payers_changed'
        : live.problems.includes('attendee_not_member')
          ? 'member_inactive'
          : null);
    if (cause !== null) {
      return invalidate(
        ctx,
        cause,
        {
          currentTotalMinor: repriced.totalMinor,
          currentAttendees: live.attendees,
          ...(live.problems.length > 0 ? { problems: live.problems } : {}),
        },
        repriced,
      );
    }
    if (live.problems.length > 0) {
      // Not a roster change (a minor on an 18+ night, a date now outside the
      // trip): nothing to re-quote for, nothing bought.
      audit({
        ...common(proposal, bookingId),
        type: 'booking.failed',
        payload: {
          errorCode: 'consistency',
          retriable: false,
          stage: 'recheck',
          moneyMoved: false,
          problems: live.problems,
        },
      });
      await releaseFreshHold(ctx, repriced);
      setStatus(proposal.proposalId, 'failed');
      return refused('consistency');
    }
    if (proposal.paidBy.kind === 'member_card') {
      const card = await providers.payments.hasPaymentMethod(proposal.paidBy.memberId);
      if (!card.ok || !card.value) {
        return providerFailure(
          ctx,
          bookingId,
          card.ok
            ? { code: 'not_configured', message: 'payer has no saved card', retryable: false }
            : card.error,
          'purchase',
          repriced,
        );
      }
    }

    // 5. the proof and the purchase.
    const proof = toApprovalProof(grant, decision, proposal, grantedEventId(ctx));
    if (proof.groupId !== proposal.groupId || proof.groupId !== ctx.group.groupId) {
      throw new TravError('invariant_violation', 'execute: approval proof is for another group', {
        proposalId,
      });
    }
    const bought = await purchase(ctx, repriced, proof);
    if (!bought.ok) return providerFailure(ctx, bookingId, bought.error, 'purchase', repriced);
    const purchased = bought.value;
    let paymentRef: string | undefined;
    if (proposal.paidBy.kind === 'member_card') {
      const charged = await providers.payments.charge({
        groupId: proposal.groupId,
        payerMemberId: proposal.paidBy.memberId,
        amount: money(purchased.totalMinor, purchased.currency),
        reference: `booking:${purchased.providerRef}`,
        idempotencyKey: proposal.idempotencyKey,
        approval: proof,
      });
      if (!charged.ok) {
        // The provider order stands under the key and the grant is still
        // complete: the proposal goes back to `pending`, so the next approval
        // re-runs `execute`, which replays the order (same key ⇒ same order,
        // never a second one) and charges then. The card was not charged, so
        // nothing is owed yet.
        audit({
          ...common(proposal, bookingId),
          type: 'booking.failed',
          payload: {
            errorCode: charged.error.code,
            retriable: true,
            resumable: true,
            stage: 'charge',
            moneyMoved: false,
            providerRef: purchased.providerRef,
            quoteRef: repriced.quoteRef,
            totalMinor: purchased.totalMinor,
            currency: purchased.currency,
          },
        });
        setStatus(proposal.proposalId, 'pending');
        return {
          kind: 'failed',
          errorCode: charged.error.code,
          retriable: true,
          moneyMoved: false,
          resumable: true,
        };
      }
      paymentRef = charged.value.intentId;
    }
    // The money has moved: the grant is spent and can never buy again.
    const spent = group.bookings.getGrant(grant.grantId) ?? grant;
    if (spent.status === 'complete' && spent.complete) {
      group.bookings.saveGrant(approval.consumeGrant(spent));
    }

    // 6. completed: the money facts the receipt is rendered from.
    const completedId = audit({
      ...common(proposal, bookingId),
      type: 'booking.completed',
      payload: {
        providerRef: purchased.providerRef,
        orderRef: purchased.orderRef,
        totalMinor: purchased.totalMinor,
        currency: purchased.currency,
        payers: proposal.payers,
        attendees: proposal.attendees,
        refundable: proposal.refundable,
        kind: proposal.kind,
        provider: proposal.provider,
        paidBy: proposal.paidBy.kind,
        ...(paymentRef !== undefined ? { paymentRef } : {}),
        // What the DM ticket cards say about the event (no barcodes), so a
        // later step-9 repair renders the same cards without `getOrder`.
        ...(purchased.ticketEvent !== undefined ? { ticketEvent: purchased.ticketEvent } : {}),
      },
    });
    auditIds.push(completedId);

    // 7. the booking row, right away: no ticket refs yet (step 9 adds them).
    const booking: Booking = {
      bookingId,
      proposalId: proposal.proposalId,
      groupId: proposal.groupId,
      tripId: proposal.tripId,
      ...(proposal.activityId !== undefined ? { activityId: proposal.activityId } : {}),
      kind: proposal.kind,
      provider: proposal.provider,
      providerRef: purchased.providerRef,
      orderRef: purchased.orderRef,
      description: proposal.description,
      merchant: purchased.merchant,
      totalMinor: purchased.totalMinor,
      currency: purchased.currency,
      payers: proposal.payers,
      attendees: proposal.attendees,
      paidBy: proposal.paidBy,
      refundable: proposal.refundable,
      ...(proposal.refundDeadline !== undefined ? { refundDeadline: proposal.refundDeadline } : {}),
      idempotencyKey: proposal.idempotencyKey,
      purchasedAt: purchased.purchasedAt,
      status: 'confirmed',
      tickets: [],
      completedAuditEventId: completedId,
    };
    try {
      group.bookings.createBooking(booking);
    } catch (e) {
      if (!(e instanceof TravError && e.code === 'duplicate')) throw e;
      const prior = group.bookings.getBookingByKey(proposal.idempotencyKey);
      if (prior === undefined) throw e;
      audit({
        ...common(proposal, prior.bookingId),
        type: 'booking.duplicate_suppressed',
        payload: { existingBookingId: prior.bookingId, grantId },
      });
      setStatus(proposal.proposalId, 'completed');
      return { kind: 'duplicate', booking: prior, repaired: false };
    }
    setStatus(proposal.proposalId, 'completed');

    // 8. the ledger, then 9. the tickets, each in its holder's private partition.
    const done = await finish(ctx, booking, auditIds);
    return {
      kind: 'completed',
      booking: done.booking,
      expense: done.expense,
      auditEventIds: auditIds,
    };
  }

  return { execute };
}

/**
 * Maps a complete core grant + decision into the opaque proof provider
 * adapters require. `approvedBy` always includes `proposal.requestedBy`: the
 * charged card is the requester's (D-005) and the payments mock requires the
 * payer among the approvers. `approvedAt` is the last signature (or the
 * request time for a policy auto-approval), `expiresAt` the grant's, and
 * `maxAmount` the proposal total, so a provider refuses anything dearer.
 */
export function toApprovalProof(
  grant: ApprovalGrant,
  decision: PolicyDecision,
  proposal: BookingProposal,
  grantedAuditEventId: AuditEventId,
): ApprovalProof {
  if (grant.proposalId !== proposal.proposalId || decision.proposalId !== proposal.proposalId) {
    throw new TravError('grant_invalid', 'toApprovalProof: grant, decision and proposal differ', {
      grantId: grant.grantId,
      proposalId: proposal.proposalId,
    });
  }
  if (grant.status !== 'complete' || !grant.complete || decision.outcome === 'deny') {
    throw new TravError(
      'grant_invalid',
      `toApprovalProof: grant ${grant.grantId} is not complete`,
      {
        grantId: grant.grantId,
        status: grant.status,
      },
    );
  }
  const signers = grant.grantedBy.map((g) => g.memberId);
  const approvedBy = [...new Set([proposal.requestedBy, ...signers])];
  const approvedAt =
    grant.grantedBy.length === 0
      ? proposal.requestedAt
      : grant.grantedBy.reduce(
          (latest, g) => (parseIso(g.at) > parseIso(latest) ? g.at : latest),
          grant.grantedBy[0]!.at,
        );
  return {
    approvalId: grant.grantId,
    proposalId: proposal.proposalId,
    groupId: proposal.groupId,
    approvedBy,
    approvedAt,
    expiresAt: grant.expiresAt,
    maxAmount: money(proposal.totalMinor, proposal.currency),
    auditEventId: grantedAuditEventId,
  };
}
