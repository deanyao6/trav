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
 * What gets marked: the reactor's unrecorded rows ON THAT CARD, as the card
 * showed them (what they paid). The plan stays stable while expenses don't
 * change (`ledger.settleAfterPayments`), so usually the row still matches what
 * is owed. If the tab moved since (a later expense), the row is still recorded
 * at the card's amount and netted against what is owed now (`tabMoved`), unless
 * they have a payment recorded since that card went out: then nothing is
 * recorded (`stale`). A row already ticked on that card is `already_paid`: a
 * second 👍 never pays twice.
 */
import type {
  AuditEventId,
  IsoDateTime,
  MessageId,
  SettleUpCard,
  SettlementPayment,
  Transfer,
} from '@trav/core';
import { parseIso, safety } from '@trav/core';
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
  /** When Trav sent the card (`PendingCardRef.sentAt`). */
  readonly cardSentAt: IsoDateTime;
}

export type MarkPaidOutcome =
  | {
      readonly kind: 'marked';
      readonly payments: readonly SettlementPayment[];
      readonly auditEventIds: readonly AuditEventId[];
      /** Some row was recorded off a card the tab has moved past (VOICE §4.6 "tab changed" line). */
      readonly tabMoved: boolean;
    }
  /** Running card, no trip, or a sender who is not an active adult member. */
  | { readonly kind: 'not_applicable' }
  /** The reactor pays nothing on this card (a payee, someone else, a minor). */
  | { readonly kind: 'not_payer' }
  | { readonly kind: 'already_paid' }
  /** The tab moved since the card and they have paid since it went out: nothing recorded. */
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

  // A payment of theirs recorded since this card went out (from a newer card):
  // the card is behind them, so a row that no longer matches is not paid again.
  const sentMs = parseIso(input.cardSentAt);
  const paidSince = recorded.some((p) => p.from === me.memberId && parseIso(p.markedAt) >= sentMs);
  const toMark: Transfer[] = [];
  let refused = 0;
  let tabMoved = false;
  for (const t of mine) {
    const onThisCard = recorded.some(
      (p) => p.cardMessageId === input.cardMessageId && p.from === t.from && p.to === t.to,
    );
    if (t.paid === true || onThisCard) continue;
    if (open.some((o) => sameTransfer(o, t))) {
      toMark.push(t);
      continue;
    }
    // The tab moved since this card (a later expense): they paid what the card
    // said, so that is what gets recorded; the balances net it against what is
    // owed now. Unless they have paid since the card went out.
    if (paidSince) {
      refused += 1;
      continue;
    }
    toMark.push(t);
    tabMoved = true;
  }
  if (toMark.length === 0) {
    return refused > 0 ? { kind: 'stale' } : { kind: 'already_paid' };
  }

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
  return { kind: 'marked', payments, auditEventIds, tabMoved };
}
