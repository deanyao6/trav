/**
 * Sent → Got it on the final settle card (T-166, D-043; supersedes D-034's
 * payer-only 👍). No money moves through Trav: these record what members say.
 *
 * - **Sent** (the payer's [Sent], 👍 or "sent"): their open rows on that card
 *   become `sent`. Pending: balances don't change, the card reads "Chase says
 *   sent €42 to Dean".
 * - **Got it** (the payee's [Got it], 👍 or "got it"): every pending Sent to
 *   them for a row on that card becomes `received`, and a row they got with
 *   no Sent first is recorded `received` directly (fewer taps between
 *   friends). Only `received` reduces what is owed.
 * - **Undo** ([Undo], 👎 or "undo"): takes back the tapper's own last step.
 *   A payee's undo turns `received` back into `sent` (or `undone` if the
 *   payer never said sent); a payer's undo turns their `sent` into `undone`.
 *   A payer can't undo what the payee already confirmed (`payee_confirmed`).
 *
 * Who: an active adult member, acting on their own rows only (a payer's tap
 * never confirms, a payee's never sends). A guest, a minor (transfers never
 * name one), a running card or someone with no row on the card changes
 * nothing. A second tap changes nothing (`already`).
 *
 * Amounts: what the card row says, as T-141 did. If the tab moved since the
 * card (a later expense), the row is still recorded at the card's amount and
 * the balances net it (`tabMoved`), unless that pair was already confirmed
 * since the card went out (`stale`).
 */
import type {
  AuditEventId,
  AuditEventType,
  IsoDateTime,
  MemberId,
  MessageId,
  SettleUpCard,
  SettlementPayment,
  Transfer,
} from '@trav/core';
import { isSettlementCleared, isSettlementPending, parseIso, safety } from '@trav/core';
import type { ToolContext } from '../tools/registry.js';
import { settleUpFor } from '../tools/ledger.js';

export type SettleAction = 'sent' | 'got_it' | 'undo';

export interface SettleActionInput {
  readonly card: SettleUpCard;
  readonly cardMessageId: MessageId;
  /** When Trav sent the card (`PendingCardRef.sentAt`). */
  readonly cardSentAt: IsoDateTime;
  readonly action: SettleAction;
  readonly via: SettlementPayment['via'];
  /** The reaction / tap / message id (audit only). */
  readonly messageId: MessageId;
  /** A tap's `from:to` value: only that row. */
  readonly only?: { readonly from: MemberId; readonly to: MemberId };
}

export type SettleActionOutcome =
  | {
      readonly kind: 'done';
      readonly action: SettleAction;
      readonly changed: readonly SettlementPayment[];
      readonly auditEventIds: readonly AuditEventId[];
      /** Some row was recorded off a card the tab has moved past. */
      readonly tabMoved: boolean;
    }
  /** Running card, no trip, or a sender who is not an active adult member. */
  | { readonly kind: 'not_applicable' }
  /** Nothing of theirs on this card for this action (a payer's Got it, a payee's Sent, a bystander). */
  | { readonly kind: 'not_party' }
  /** Already done (a second tap), or nothing of theirs to undo. */
  | { readonly kind: 'already' }
  /** The tab moved and that pair was confirmed since the card went out: nothing recorded. */
  | { readonly kind: 'stale' }
  /** A payee's bare Got it with several open rows and none said sent: nothing recorded. */
  | { readonly kind: 'which_row'; readonly payers: readonly MemberId[] }
  /** A payer's undo on a transfer the payee already confirmed: only the payee can take that back. */
  | { readonly kind: 'payee_confirmed'; readonly payees: readonly MemberId[] };

/**
 * A text reply quoting the final settle card (button-less channels, VOICE
 * §3.6): "sent" / "paid" is Sent, "got it" / "received" is Got it, "undo" is
 * Undo. The whole reply must be the word; anything longer is not this.
 */
export function settleReplyAction(text: string): SettleAction | undefined {
  const t = text
    .toLowerCase()
    .replace(/(^|\s)@trav\b/gu, ' ')
    .replace(/[^\p{L}\p{N}\s'👍👎]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^(?:undo|undo that|undo it|take that back)$/u.test(t)) return 'undo';
  if (/^(?:got it|got it thanks|got it ty|received|it landed|landed)$/u.test(t)) return 'got_it';
  if (/^(?:sent|sent it|just sent it|paid|i paid|paid it|done)$/u.test(t)) return 'sent';
  return undefined;
}

const sameTransfer = (a: Transfer, b: Transfer): boolean =>
  a.from === b.from &&
  a.to === b.to &&
  a.amount.amountMinor === b.amount.amountMinor &&
  a.amount.currency === b.amount.currency;

const samePair = (a: { from: MemberId; to: MemberId }, b: { from: MemberId; to: MemberId }) =>
  a.from === b.from && a.to === b.to;

export function settleAction(ctx: ToolContext, input: SettleActionInput): SettleActionOutcome {
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
  const tripId = ctx.tripId;
  const now = ctx.now;
  const recorded = ctx.stores.group.settlements.listByTrip(tripId);
  const inScope = (t: { from: MemberId; to: MemberId }): boolean =>
    input.only === undefined || samePair(t, input.only);
  const changed: SettlementPayment[] = [];
  const auditEventIds: AuditEventId[] = [];

  const write = (
    p: SettlementPayment,
    isNew: boolean,
    type: AuditEventType,
    extra: Record<string, unknown> = {},
  ): void => {
    if (isNew) ctx.stores.group.settlements.record(p);
    else ctx.stores.group.settlements.update(p);
    changed.push(p);
    auditEventIds.push(
      ctx.stores.group.audit.append({
        groupId: ctx.groupId,
        tripId,
        type,
        actor: { kind: 'member', id: me.memberId },
        visibility: 'group',
        payload: {
          paymentId: p.paymentId,
          from: p.from,
          to: p.to,
          amountMinor: p.amount.amountMinor,
          currency: p.amount.currency,
          status: p.status,
          via: input.via,
          cardMessageId: input.cardMessageId,
          messageId: input.messageId,
          moneyMoved: false,
          ...extra,
        },
      }).id,
    );
  };

  if (input.action === 'undo') return undo();

  const allMine = card.transfers.filter(
    (t) =>
      t.paid !== true && inScope(t) && (input.action === 'sent' ? t.from : t.to) === me.memberId,
  );
  if (allMine.length === 0) return { kind: 'not_party' };
  let mine = allMine;
  if (input.action === 'got_it' && input.only === undefined) {
    // A payee's bare 👍 / "got it" confirms what was said sent to them. With
    // nothing said sent, it clears their one row; with several rows it can't
    // know which one landed, so it records nothing (`which_row`).
    const sentToMe = allMine.filter((t) =>
      recorded.some((p) => samePair(p, t) && isSettlementPending(p)),
    );
    if (sentToMe.length > 0) mine = sentToMe;
    else if (allMine.length > 1) return { kind: 'which_row', payers: allMine.map((t) => t.from) };
  }

  const live = settleUpFor(ctx, 'final');
  const open = live.kind === 'ok' ? (live.input.transfers ?? []) : [];
  const sentMs = parseIso(input.cardSentAt);
  let tabMoved = false;
  let refused = 0;

  for (const t of mine) {
    const pair = recorded.filter((p) => samePair(p, t));
    const pending = pair.filter((p) => isSettlementPending(p));
    const onCard = pair.find((p) => p.cardMessageId === input.cardMessageId);
    if (input.action === 'sent') {
      if (pending.length > 0) continue; // already said sent
    } else if (pending.length > 0) {
      // The payee confirms what the payer said they sent, at that amount.
      for (const p of pending) {
        write(
          {
            ...p,
            status: 'received',
            receivedAt: now,
            receivedBy: me.memberId,
            updatedAt: now,
          },
          false,
          'settlement.received',
        );
      }
      continue;
    }
    if (onCard !== undefined && isSettlementCleared(onCard)) continue;
    if (!open.some((o) => sameTransfer(o, t))) {
      // The tab moved since this card. Confirmed since it went out: the card is behind.
      const since = pair.filter(
        (p) => isSettlementCleared(p) && parseIso(p.receivedAt ?? p.markedAt) >= sentMs,
      );
      if (since.some((p) => p.amount.amountMinor === t.amount.amountMinor)) continue;
      if (since.length > 0) {
        refused += 1;
        continue;
      }
      tabMoved = true;
    }
    const state =
      input.action === 'sent'
        ? ({ status: 'sent', sentAt: now } as const)
        : ({ status: 'received', receivedAt: now, receivedBy: me.memberId } as const);
    const type = input.action === 'sent' ? 'settlement.sent' : 'settlement.received';
    if (onCard !== undefined) {
      // An undone row on this same card comes back (the card's row is the key).
      const { sentAt: _s, receivedAt: _r, receivedBy: _b, ...base } = onCard;
      write({ ...base, ...state, updatedAt: now }, false, type);
    } else {
      write(
        {
          paymentId: ctx.ids.next('pay'),
          groupId: ctx.groupId,
          tripId,
          from: t.from,
          to: t.to,
          amount: t.amount,
          markedBy: me.memberId,
          markedAt: now,
          via: input.via,
          cardMessageId: input.cardMessageId,
          ...state,
          updatedAt: now,
        },
        true,
        type,
      );
    }
  }
  if (changed.length === 0) return refused > 0 ? { kind: 'stale' } : { kind: 'already' };
  return { kind: 'done', action: input.action, changed, auditEventIds, tabMoved };

  /** The tapper's own last step on this card's pairs, taken back. */
  function undo(): SettleActionOutcome {
    const pairs = card.transfers.filter(
      (t) => inScope(t) && (t.from === me!.memberId || t.to === me!.memberId),
    );
    if (pairs.length === 0) return { kind: 'not_party' };
    const onPairs = recorded.filter((p) => pairs.some((t) => samePair(t, p)));
    // As payee: what I confirmed. As payer: what I said I sent and is still pending.
    const confirmed = onPairs.filter(
      (p) => p.to === me!.memberId && isSettlementCleared(p) && p.receivedAt !== undefined,
    );
    const sent = onPairs.filter(
      (p) => p.from === me!.memberId && isSettlementPending(p) && p.markedBy === me!.memberId,
    );
    const stepAt = (p: SettlementPayment): number =>
      parseIso(
        (p.to === me!.memberId && isSettlementCleared(p) ? p.receivedAt : p.sentAt) ?? p.markedAt,
      );
    const steps = [...confirmed, ...sent];
    if (steps.length === 0) {
      const lockedFor = onPairs.filter((p) => p.from === me!.memberId && isSettlementCleared(p));
      if (lockedFor.length > 0) {
        return { kind: 'payee_confirmed', payees: [...new Set(lockedFor.map((p) => p.to))] };
      }
      return { kind: 'already' };
    }
    const last = Math.max(...steps.map(stepAt));
    for (const p of steps.filter((s) => stepAt(s) === last)) {
      if (p.to === me!.memberId && isSettlementCleared(p)) {
        const { receivedAt: _r, receivedBy: _b, ...base } = p;
        write(
          { ...base, status: p.sentAt !== undefined ? 'sent' : 'undone', updatedAt: now },
          false,
          'settlement.undone',
          { undid: 'received' },
        );
      } else {
        const { sentAt: _s, ...base } = p;
        write({ ...base, status: 'undone', updatedAt: now }, false, 'settlement.undone', {
          undid: 'sent',
        });
      }
    }
    return { kind: 'done', action: 'undo', changed, auditEventIds, tabMoved: false };
  }
}
