/**
 * Purchase confirmation + receipt (VOICE §4.2, card `receipt`; ARCHITECTURE
 * Flow 2 step 4).
 *
 * Built FROM the audit log + the stored `Booking` + the ledger `Expense`,
 * never from model text. Before rendering, every number is cross-checked:
 *  - `booking.completed` exists, is the booking's `completedAuditEventId`, and
 *    its payload (total, currency, payers, attendees, refundable, providerRef)
 *    equals the booking record;
 *  - `policy.evaluated` (not deny) and, unless auto-approved, a complete
 *    `approval.granted` precede it for the same proposal;
 *  - the expense is the one the booking wrote (`sourceRef` booking, amount ==
 *    total, `ledger.written` logged) and its computed shares equal the audited
 *    payer shares to the cent.
 * Any mismatch throws `invariant_violation`: Trav never posts a receipt the
 * log can't prove.
 */
import type {
  AuditEvent,
  Booking,
  Expense,
  MemberId,
  Money,
  OutboundMessage,
  Participant,
  ReceiptCard,
} from '@trav/core';
import { TravError, formatMoney, ledger, money, sum } from '@trav/core';
import type { RenderContext } from './common.js';
import {
  GROUP,
  cardMessage,
  deadlinePhrase,
  headlineName,
  inMemberOrder,
  listNames,
  nameOf,
  plural,
  possessive,
} from './common.js';
import { completedFacts, policyFactsBefore } from './audit.js';

export interface ReceiptRenderInput {
  readonly booking: Booking;
  /** The ledger expense the executor wrote; `null` only for `per_person_cards` (nothing to split). */
  readonly expense: Expense | null;
  /** Audit events for this proposal and booking, in log order (e.g. `audit.listByGroup(groupId)`). */
  readonly auditEvents: readonly AuditEvent[];
  /** Short lowercase headline ("razzmatazz"); defaults to the merchant lowercased. */
  readonly headline?: string;
  /** Quantity noun (default `ticket` for ticket bookings); `null` omits the count. */
  readonly unit?: { readonly singular: string; readonly plural?: string } | null;
  /** Ticket DMs that were rendered for this booking (card ids, for tests and the simulator link). */
  readonly tickets?: readonly { readonly memberId: MemberId; readonly ticketCardId: string }[];
  /** Split context for share computation; default: group member order, all active members. */
  readonly splitContext?: ledger.SplitContext;
}

function mismatch(what: string, bookingId: string): never {
  throw new TravError('invariant_violation', `receipt: ${what} does not match the audit log`, {
    bookingId,
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * `card.ledger.expenseId` when the booking wrote no ledger entry
 * (`paidBy.kind === 'per_person_cards'`: each attendee paid on their own card,
 * nothing to split). `card.ledger.split` is then empty. Consumers must treat
 * this value as "no expense", never look it up.
 */
export const NO_LEDGER_EXPENSE_ID = '';

/** Max named transfers on the tab line before "+N more in the card" (VOICE §3.3). */
const MAX_TAB_ITEMS = 3;

export function renderReceipt(
  input: ReceiptRenderInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: ReceiptCard } {
  const { booking, expense } = input;
  const id = booking.bookingId;

  // 1. booking.completed is the source of the money facts.
  const completedEvent = input.auditEvents.find(
    (e) => e.type === 'booking.completed' && e.id === booking.completedAuditEventId,
  );
  if (completedEvent === undefined) mismatch('booking.completed event', id);
  if (completedEvent.bookingId !== undefined && completedEvent.bookingId !== id) {
    mismatch('booking id', id);
  }
  const facts = completedFacts(completedEvent);
  if (facts.totalMinor !== booking.totalMinor || facts.currency !== booking.currency) {
    mismatch('total', id);
  }
  if (facts.refundable !== booking.refundable) mismatch('refundability', id);
  if (facts.providerRef !== booking.providerRef) mismatch('provider ref', id);
  if (!sameSet(facts.attendees, booking.attendees)) mismatch('attendees', id);
  const bookingPayers = booking.payers.map((p) => `${p.memberId}:${String(p.shareMinor)}`);
  const auditPayers = facts.payers.map((p) => `${p.memberId}:${String(p.shareMinor)}`);
  if (!sameSet(bookingPayers, auditPayers)) mismatch('payers', id);

  // 2. the approval policy ran and passed before the purchase.
  const policy = policyFactsBefore(input.auditEvents, booking.proposalId, completedEvent);

  const cur = facts.currency;
  const total = money(facts.totalMinor, cur);

  // 3. the ledger write matches the audited payers exactly.
  let split: Participant[] = [];
  if (booking.paidBy.kind === 'member_card') {
    if (expense === null) mismatch('ledger expense (missing)', id);
    if (expense.sourceRef.kind !== 'booking' || expense.sourceRef.id !== id) {
      mismatch('expense source', id);
    }
    if (booking.expenseId !== undefined && booking.expenseId !== expense.expenseId) {
      mismatch('expense id', id);
    }
    if (expense.amount.amountMinor !== facts.totalMinor || expense.amount.currency !== cur) {
      mismatch('expense amount', id);
    }
    const payer = expense.paidBy;
    if (
      payer.length !== 1 ||
      payer[0]!.memberId !== booking.paidBy.memberId ||
      payer[0]!.amount.amountMinor !== facts.totalMinor
    ) {
      mismatch('expense payer', id);
    }
    const written = input.auditEvents.some(
      (e) =>
        e.type === 'ledger.written' &&
        (e.payload['expenseId'] === expense.expenseId || e.bookingId === id),
    );
    if (!written) mismatch('ledger.written event', id);
    const order = ctx.members.map((m) => m.memberId);
    const splitCtx = input.splitContext ?? {
      memberOrder: order,
      participantsUniverse: ctx.members.filter((m) => m.active).map((m) => m.memberId),
    };
    const shares = ledger
      .computeShares(expense, splitCtx)
      .filter((s) => s.amount.amountMinor !== 0);
    const shareKeys = shares.map((s) => `${s.memberId}:${String(s.amount.amountMinor)}`);
    if (!sameSet(shareKeys, auditPayers)) mismatch('ledger shares', id);
    split = inMemberOrder(
      ctx,
      shares.map((s) => s.memberId),
    ).map((mid) => ({
      memberId: mid,
      name: nameOf(ctx, mid),
      share: shares.find((s) => s.memberId === mid)!.amount,
    }));
    const splitSum = sum(
      split.map((p) => p.share!),
      cur,
    );
    if (splitSum.amountMinor !== total.amountMinor) mismatch('split sum', id);
  }

  // ---------- text (VOICE §4.2 A) ----------
  const headline = input.headline ?? headlineName(booking.merchant);
  const unit =
    input.unit !== undefined
      ? input.unit
      : booking.kind === 'ticket'
        ? { singular: 'ticket' }
        : null;
  const qty = facts.attendees.length;
  const count = unit === null ? undefined : plural(qty, unit.singular, unit.plural);
  const line1 = `booked ✅ ${[headline, count, formatMoney(total)].filter(Boolean).join(', ')}`;

  const refund = facts.refundable
    ? booking.refundDeadline !== undefined
      ? `refundable until ${deadlinePhrase(booking.refundDeadline, ctx.timeZone, ctx.now)}`
      : 'refundable'
    : 'non-refundable';
  const line2 = `order ${booking.orderRef} · ${refund}`;

  const lines = [line1, line2];
  if (booking.tickets.length > 0) {
    const viaGuardian = booking.tickets.filter((t) => t.deliveredToMemberId !== t.holderMemberId);
    const note =
      viaGuardian.length > 0
        ? ` (${viaGuardian
            .map(
              (t) =>
                `${possessive(nameOf(ctx, t.holderMemberId))} went to ${nameOf(ctx, t.deliveredToMemberId)}`,
            )
            .join(', ')})`
        : '';
    lines.push(
      booking.tickets.length === 1
        ? `the QR code is in your dms${note}`
        : `QR codes are in your dms, one each${note}`,
    );
  }

  if (booking.paidBy.kind === 'per_person_cards') {
    lines.push('each on your own card, nothing to split');
  } else {
    const holder = booking.paidBy.memberId;
    const debtors = split.filter((p) => p.memberId !== holder);
    const holderName = nameOf(ctx, holder);
    if (debtors.length === 0) {
      lines.push(`all on ${possessive(holderName)} card, nothing to split`);
    } else if (debtors.every((d) => d.share!.amountMinor === debtors[0]!.share!.amountMinor)) {
      lines.push(
        `tab: ${listNames(
          ctx,
          debtors.map((d) => d.memberId),
        )} → ${holderName} ${formatMoney(debtors[0]!.share!)}`,
      );
    } else {
      const shown = debtors
        .slice(0, MAX_TAB_ITEMS)
        .map((d) => `${d.name} → ${holderName} ${formatMoney(d.share!)}`);
      const more =
        debtors.length > MAX_TAB_ITEMS
          ? ` · +${String(debtors.length - MAX_TAB_ITEMS)} more in the card`
          : '';
      lines.push(`tab: ${shown.join(' · ')}${more}`);
    }
  }

  // ---------- card ----------
  // One line item: N tickets at the unit price when tickets split evenly; any
  // other kind (a flight bundle, a stay) or an uneven total is 1 × total.
  const ticketQty = booking.kind === 'ticket' ? qty : 1;
  const evenUnit = ticketQty > 1 && facts.totalMinor % ticketQty === 0;
  const unitPrice: Money = evenUnit ? money(facts.totalMinor / ticketQty, cur) : total;
  const ledgerRef =
    booking.paidBy.kind === 'member_card' && expense !== null
      ? { expenseId: expense.expenseId, split }
      : { expenseId: NO_LEDGER_EXPENSE_ID, split: [] };
  return cardMessage<ReceiptCard>(ctx, GROUP, lines, {
    type: 'receipt',
    title: `booked: ${headline}`,
    bookingId: id,
    proposalId: booking.proposalId,
    merchant: booking.merchant,
    orderRef: booking.orderRef,
    purchasedAt: booking.purchasedAt,
    lineItems: [
      {
        label: booking.description,
        qty: evenUnit ? ticketQty : 1,
        unit: unitPrice,
        total,
      },
    ],
    subtotal: total,
    total,
    refundable: facts.refundable,
    ...(booking.refundDeadline !== undefined ? { refundDeadline: booking.refundDeadline } : {}),
    paidBy: booking.paidBy,
    ledger: ledgerRef,
    ...(input.tickets !== undefined && input.tickets.length > 0 ? { tickets: input.tickets } : {}),
    auditEventId: completedEvent.id,
    ruleId: policy.ruleId,
  });
}
