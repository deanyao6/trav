/**
 * VOICE §5 card invariants as a pure check. The renderer tests assert it is
 * empty for every rendered card, and the send path reports any violation the
 * same way as a voice-lint violation (fails in tests, logged in production).
 *
 *  - `card.fallbackText === text`
 *  - booking_proposal: Σ charged shares == total
 *  - receipt: Σ ledger.split shares == total when paid by one member's card
 *  - settle_up (also embedded in recap / Wrapped): Σ balances net == 0
 *  - ticket: never on the group lane; delivered only to `deliveredTo`
 *  - expense_confirm with visibility private (or a private digest item): never on the group lane,
 *    and on the DM lane only to its owner
 *  - recap.roastLines empty and `roast` unset when roast mode is off or a minor is present
 *  - `roast: true` ⇒ roast mode on and (for recaps) roastLines non-empty
 *  - Wrapped awards about a minor are "pick" awards only
 *
 * The lane/recipient subset (`laneViolations`) is a privacy class: the send
 * path suppresses those messages in every `voice` mode instead of logging and
 * sending them (SAFETY §2.3, §2.7).
 */
import type {
  ConsentLookup,
  ExpenseConfirmCard,
  Group,
  IsoDateTime,
  Member,
  MemberId,
  Outbound,
  RichCardType,
  SettleUpCard,
  Trip,
} from '@trav/core';
import { DM_ONLY_CARD_TYPES, isReaction, safety } from '@trav/core';

export interface InvariantContext {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly trip: Trip | null;
  readonly consent: ConsentLookup;
  readonly now: IsoDateTime;
}

function settleProblems(card: SettleUpCard, where: string): string[] {
  const out: string[] = [];
  const net = card.balances.reduce((acc, b) => acc + b.net.amountMinor, 0);
  if (net !== 0) out.push(`${where}: balances sum to ${String(net)}, not 0`);
  if (card.balances.some((b) => b.net.currency !== card.currency)) {
    out.push(`${where}: balance currency differs from ${card.currency}`);
  }
  return out;
}

function privateItems(card: ExpenseConfirmCard): ExpenseConfirmCard[] {
  return [card, ...(card.digestItems ?? [])].filter((c) => c.visibility === 'private');
}

/** Why a message must never reach its addressed lane/recipient. */
export type LaneViolationCause =
  'dm_only_card_in_group' | 'private_card_in_group' | 'private_card_wrong_recipient';

export interface LaneViolation {
  readonly cause: LaneViolationCause;
  /** The same string `cardInvariantViolations` reports. */
  readonly violation: string;
  readonly cardType: RichCardType;
  /** Whose private content it is (ticket `deliveredTo`, private item owner), when known. */
  readonly ownerId?: MemberId;
}

/**
 * Privacy/lane invariants: a DM-only card (ticket) or a private
 * `expense_confirm` on the group lane, or on a DM lane to anyone but its
 * owner. Any entry here means the message must not be sent at all.
 */
export function laneViolations(outbound: Outbound): LaneViolation[] {
  if (isReaction(outbound) || outbound.card === undefined) return [];
  const card = outbound.card;
  const toGroup = outbound.to.kind === 'group';
  const recipient = outbound.to.kind === 'member' ? outbound.to.memberId : undefined;
  const out: LaneViolation[] = [];
  if (toGroup && DM_ONLY_CARD_TYPES.includes(card.type)) {
    out.push({
      cause: 'dm_only_card_in_group',
      violation: `${card.type} card on the group lane`,
      cardType: card.type,
      ...(card.type === 'ticket' ? { ownerId: card.deliveredTo } : {}),
    });
  }
  if (card.type === 'ticket' && recipient !== undefined && recipient !== card.deliveredTo) {
    out.push({
      cause: 'private_card_wrong_recipient',
      violation: 'ticket delivered to someone other than deliveredTo',
      cardType: card.type,
      ownerId: card.deliveredTo,
    });
  }
  if (card.type === 'expense_confirm') {
    const priv = privateItems(card);
    const ownerId = priv[0]?.paidBy;
    const owner = ownerId !== undefined ? { ownerId } : {};
    if (priv.length > 0 && toGroup) {
      out.push({
        cause: 'private_card_in_group',
        violation: 'private expense_confirm on the group lane',
        cardType: card.type,
        ...owner,
      });
    }
    if (recipient !== undefined && priv.some((c) => c.paidBy !== recipient)) {
      out.push({
        cause: 'private_card_wrong_recipient',
        violation: "private expense_confirm sent to someone who isn't its owner",
        cardType: card.type,
        ...owner,
      });
    }
  }
  return out;
}

export function cardInvariantViolations(outbound: Outbound, ctx: InvariantContext): string[] {
  if (isReaction(outbound)) return [];
  const out: string[] = [];
  const card = outbound.card;
  const roastBlocked = safety.groupRoastBlock(ctx.group, ctx.members, ctx.trip, ctx.now) !== null;

  if (outbound.roast === true && !ctx.group.settings.roastMode) {
    out.push('roast: true while roast mode is off');
  }
  if (outbound.roast === true && roastBlocked) out.push('roast: true while roasts are blocked');
  if (card === undefined) return out;

  if (card.fallbackText !== outbound.text) out.push('card.fallbackText !== text');

  switch (card.type) {
    case 'booking_proposal': {
      const sum = card.charged.reduce((acc, c) => acc + (c.share?.amountMinor ?? 0), 0);
      if (card.charged.some((c) => c.share === undefined))
        out.push('booking_proposal: a charged member has no share');
      if (sum !== card.total.amountMinor) {
        out.push(
          `booking_proposal: shares sum to ${String(sum)}, total ${String(card.total.amountMinor)}`,
        );
      }
      break;
    }
    case 'receipt': {
      if (card.paidBy.kind === 'member_card') {
        const sum = card.ledger.split.reduce((acc, p) => acc + (p.share?.amountMinor ?? 0), 0);
        if (sum !== card.total.amountMinor) {
          out.push(
            `receipt: ledger split sums to ${String(sum)}, total ${String(card.total.amountMinor)}`,
          );
        }
      }
      break;
    }
    case 'ticket':
    case 'expense_confirm':
      // lane and recipient rules: `laneViolations` (appended below)
      break;
    case 'settle_up':
      out.push(...settleProblems(card, 'settle_up'));
      break;
    case 'recap': {
      out.push(...settleProblems(card.settle, 'recap.settle'));
      const lines = card.roastLines ?? [];
      if (roastBlocked && lines.length > 0)
        out.push('recap.roastLines non-empty while roasts are blocked');
      if (outbound.roast === true && lines.length === 0) out.push('roast: true with no roastLines');
      break;
    }
    case 'wrapped': {
      out.push(...settleProblems(card.finalSettle, 'wrapped.finalSettle'));
      for (const a of card.awards) {
        const m = ctx.members.find((x) => x.memberId === a.memberId);
        if (m !== undefined && safety.isMinor(m, ctx.now) && !/\bpick\b/i.test(a.title)) {
          out.push('wrapped: non-pick award about a minor');
        }
      }
      break;
    }
    case 'options':
      break;
  }
  out.push(...laneViolations(outbound).map((v) => v.violation));
  return out;
}
