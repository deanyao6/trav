/**
 * "Mark paid" on the final settle card (T-141, D-034): a 👍 or [Paid] from the
 * payer of a transfer records that they SAY they paid it. No money moves
 * through Trav; this is the payer's word, written as a `SettlementPayment` and
 * audited (`settlement.marked_paid`). Balances then apply it
 * (`ledger.tripLedger` `payments`), so the re-rendered card ticks the row and
 * the remaining lines are what is still owed.
 *
 * Who can mark: only the transfer's payer (`from`), an active adult member.
 * A payee, anyone else, a guest or a minor changes nothing (transfers never
 * name a minor: a minor's share is folded onto their guardian, so a minor
 * cannot tick their guardian's row). A payee confirming receipt is T-037.
 *
 * What gets marked: the reactor's open rows ON THAT CARD that still match what
 * is owed now (same from, to and amount). A row the tab has since moved past
 * is `stale` (nothing recorded; the caller posts the current card). A row
 * already recorded (this card, or the same transfer from another card) is
 * `already_paid`: a second 👍 never pays twice.
 */
import type {
  AuditEventId,
  MessageId,
  SettleUpCard,
  SettlementPayment,
  Transfer,
} from '@trav/core';
import { safety } from '@trav/core';
import type { ToolContext } from '../tools/registry.js';
import { settleUpFor } from '../tools/ledger.js';

export interface MarkPaidInput {
  /** The settle card as Trav sent it. */
  readonly card: SettleUpCard;
  readonly cardMessageId: MessageId;
  readonly via: SettlementPayment['via'];
  /** The reaction / tap message id (audit only). */
  readonly messageId: MessageId;
  /** [Paid] on one row (`from:to`): only the transfer to this payee. */
  readonly onlyTo?: string;
}

export type MarkPaidOutcome =
  | {
      readonly kind: 'marked';
      readonly payments: readonly SettlementPayment[];
      readonly auditEventIds: readonly AuditEventId[];
    }
  /** Running card, no trip, or a sender who is not an active adult member. */
  | { readonly kind: 'not_applicable' }
  /** The reactor pays nothing on this card (a payee, someone else, a minor). */
  | { readonly kind: 'not_payer' }
  | { readonly kind: 'already_paid' }
  /** The tab moved since the card (new expense, another payment): nothing recorded. */
  | { readonly kind: 'stale' };

const sameTransfer = (a: Transfer, b: Transfer): boolean =>
  a.from === b.from &&
  a.to === b.to &&
  a.amount.amountMinor === b.amount.amountMinor &&
  a.amount.currency === b.amount.currency;

export function markPaid(ctx: ToolContext, input: MarkPaidInput): MarkPaidOutcome {
  const { card } = input;
  if (card.mode !== 'final' || ctx.tripId === null || ctx.senderMemberId === null) {
    return { kind: 'not_applicable' };
  }
  const me = ctx.stores.group.members.get(ctx.senderMemberId);
  if (
    me === undefined ||
    me.groupId !== ctx.groupId ||
    !me.active ||
    me.leftAt !== undefined ||
    me.role === 'guest' ||
    safety.isMinor(me, ctx.now)
  ) {
    return { kind: 'not_applicable' };
  }
  const mine = card.transfers.filter(
    (t) => t.from === me.memberId && (input.onlyTo === undefined || t.to === input.onlyTo),
  );
  if (mine.length === 0) return { kind: 'not_payer' };

  const tripId = ctx.tripId;
  const recorded = ctx.stores.group.settlements.listByTrip(tripId);
  const live = settleUpFor(ctx, 'final');
  const open = live.kind === 'ok' ? (live.input.transfers ?? []) : [];

  const toMark: Transfer[] = [];
  let already = 0;
  for (const t of mine) {
    const onThisCard = recorded.some(
      (p) => p.cardMessageId === input.cardMessageId && p.from === t.from && p.to === t.to,
    );
    if (t.paid === true || onThisCard) {
      already += 1;
      continue;
    }
    if (open.some((o) => sameTransfer(o, t))) {
      toMark.push(t);
      continue;
    }
    // Paid from another settle card already: the same transfer is on record.
    if (recorded.some((p) => sameTransfer(p, t))) already += 1;
  }
  if (toMark.length === 0) return already > 0 ? { kind: 'already_paid' } : { kind: 'stale' };

  const payments: SettlementPayment[] = [];
  const auditEventIds: AuditEventId[] = [];
  for (const t of toMark) {
    const payment: SettlementPayment = {
      paymentId: ctx.ids.next('pay'),
      groupId: ctx.groupId,
      tripId,
      from: t.from,
      to: t.to,
      amount: t.amount,
      markedBy: me.memberId,
      markedAt: ctx.now,
      via: input.via,
      cardMessageId: input.cardMessageId,
      status: 'marked_paid',
    };
    ctx.stores.group.settlements.record(payment);
    payments.push(payment);
    auditEventIds.push(
      ctx.stores.group.audit.append({
        groupId: ctx.groupId,
        tripId,
        type: 'settlement.marked_paid',
        actor: { kind: 'member', id: me.memberId },
        visibility: 'group',
        payload: {
          paymentId: payment.paymentId,
          from: payment.from,
          to: payment.to,
          amountMinor: payment.amount.amountMinor,
          currency: payment.amount.currency,
          via: payment.via,
          cardMessageId: payment.cardMessageId,
          messageId: input.messageId,
          moneyMoved: false,
        },
      }).id,
    );
  }
  return { kind: 'marked', payments, auditEventIds };
}
