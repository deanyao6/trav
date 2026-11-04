/**
 * Expense cards (card `expense_confirm`):
 *  - `renderExpenseLogged`: VOICE §4.4, group lane. A logged expense from chat
 *    text, a receipt photo, a promoted private item or a booking. The post is
 *    the confirmation; 👎 undoes. Shares come from `ledger.computeShares`
 *    (remainders go to the payer, silently).
 *  - `renderLooksShared`: VOICE §4.5, DM lane to the item's owner only, one
 *    item or a digest. `visibility: 'private'`; nothing becomes shared without
 *    the owner's 👍, and a minor never gets one (VOICE §6.1, §8).
 */
import type {
  Action,
  Expense,
  ExpenseConfirmCard,
  ExpenseSource,
  MemberId,
  Money,
  OutboundMessage,
  Participant,
  PendingPrivateItem,
} from '@trav/core';
import { TravError, formatClockTime, formatMoney, ledger, safety, sum } from '@trav/core';
import type { RenderContext } from './common.js';
import {
  GROUP,
  action,
  cardMessage,
  dayPhrase,
  dm,
  inMemberOrder,
  listNames,
  nameOf,
  whenShort,
} from './common.js';

// ---------- logged (group) ----------

export interface ExpenseLoggedRenderInput {
  readonly expense: Expense;
  /** Default: group member order; exclude-universe = active members. */
  readonly splitContext?: ledger.SplitContext;
  /** Low-confidence parse (injection detected or below threshold): ask them to check the total. */
  readonly lowConfidence?: boolean;
}

function defaultSplitContext(ctx: RenderContext): ledger.SplitContext {
  return {
    memberOrder: ctx.members.map((m) => m.memberId),
    participantsUniverse: ctx.members.filter((m) => m.active).map((m) => m.memberId),
  };
}

/**
 * Members of the universe left out of an `equal` split, from the split's own participant
 * list (not from the non-zero shares: a sub-cent-per-head amount gives some participants a
 * zero share, and they are still in the split).
 */
function excludedFromEqual(
  universe: readonly MemberId[],
  participants: readonly MemberId[],
): MemberId[] {
  return universe.filter((id) => !participants.includes(id));
}

/** Most common amount among `shares` (ties: the first seen). */
function modeShare(shares: readonly Money[]): Money | undefined {
  const counts = new Map<number, number>();
  for (const s of shares) counts.set(s.amountMinor, (counts.get(s.amountMinor) ?? 0) + 1);
  let best: Money | undefined;
  let bestCount = 0;
  for (const s of shares) {
    const c = counts.get(s.amountMinor) ?? 0;
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

/** `Sam €20 · Maya €12`, or `Priya €21 · everyone else €32.60` when one amount covers most people. */
export function unequalShares(participants: readonly Participant[], payer: MemberId): string {
  const ordered = [
    ...participants.filter((p) => p.memberId !== payer),
    ...participants.filter((p) => p.memberId === payer),
  ];
  if (ordered.length > 3) {
    const common = modeShare(ordered.map((p) => p.share!));
    const sameCount = ordered.filter((p) => p.share!.amountMinor === common!.amountMinor).length;
    if (sameCount >= 2 && sameCount < ordered.length) {
      const others = ordered.filter((p) => p.share!.amountMinor !== common!.amountMinor);
      if (others.length <= 3) {
        return [
          ...others.map((p) => `${p.name} ${formatMoney(p.share!)}`),
          `everyone else ${formatMoney(common!)}`,
        ].join(' · ');
      }
    }
  }
  return ordered.map((p) => `${p.name} ${formatMoney(p.share!)}`).join(' · ');
}

export function renderExpenseLogged(
  input: ExpenseLoggedRenderInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: ExpenseConfirmCard } {
  const { expense } = input;
  const splitCtx = input.splitContext ?? defaultSplitContext(ctx);
  const shares = ledger.computeShares(expense, splitCtx);
  const cur = expense.amount.currency;
  const participantIds = inMemberOrder(
    ctx,
    shares.filter((s) => s.amount.amountMinor !== 0).map((s) => s.memberId),
  );
  const participants: Participant[] = participantIds.map((id) => ({
    memberId: id,
    name: nameOf(ctx, id),
    share: shares.find((s) => s.memberId === id)!.amount,
  }));
  const shareTotal = sum(
    participants.map((p) => p.share!),
    cur,
  );
  if (shareTotal.amountMinor !== expense.amount.amountMinor) {
    throw new TravError('invariant_violation', 'renderExpenseLogged: shares do not sum to amount', {
      expenseId: expense.expenseId,
    });
  }
  // Who is left out: named by the split (`exclude`), or the universe minus an `equal` subset.
  const excludedIds = inMemberOrder(
    ctx,
    expense.split.method === 'exclude'
      ? expense.split.excluded
      : expense.split.method === 'equal'
        ? excludedFromEqual(splitCtx.participantsUniverse, expense.split.participants)
        : [],
  );
  const excluded: Participant[] = excludedIds.map((id) => ({
    memberId: id,
    name: nameOf(ctx, id),
  }));

  if (expense.paidBy.length === 0) {
    throw new TravError('invalid_argument', 'renderExpenseLogged: expense has no payer');
  }
  const payer = expense.paidBy[0]!.memberId;
  const payerText =
    expense.paidBy.length === 1
      ? nameOf(ctx, payer)
      : listNames(
          ctx,
          expense.paidBy.map((p) => p.memberId),
        );
  const amount = formatMoney(expense.amount);
  const merchant = expense.merchantDisplay;
  const fromPhoto = expense.source === 'receipt_photo';
  const head = fromPhoto
    ? `read it: ${merchant ?? expense.description}, ${amount} on ${payerText}`
    : `logged: ${amount} ${expense.description} on ${payerText}`;

  const lines: string[] = [];
  if (expense.status === 'undone') {
    lines.push(`undone: ${amount} ${expense.description} on ${payerText}, it's off the tab`);
  } else {
    const isEqual = expense.split.method === 'equal' || expense.split.method === 'exclude';
    const nonPayer = participants.filter((p) => p.memberId !== payer);
    const each = modeShare((nonPayer.length > 0 ? nonPayer : participants).map((p) => p.share!));
    const nearlyEqual =
      each !== undefined &&
      participants.every(
        (p) => Math.abs(p.share!.amountMinor - each.amountMinor) <= participants.length,
      );
    if (participants.length === 1) {
      lines.push(`${head}, all on ${nameOf(ctx, participants[0]!.memberId)}`);
    } else if (isEqual && nearlyEqual) {
      // VOICE §4.4 A "(not Henry)"; when more are out than in, name who's in instead.
      const notPart =
        excluded.length === 0
          ? ''
          : excluded.length <= participants.length
            ? ` (not ${excluded.map((p) => p.name).join(', ')})`
            : ` (${participants.map((p) => p.name).join(', ')})`;
      lines.push(
        `${head}, ${String(participants.length)} ways${notPart} → ${formatMoney(each)} each`,
      );
    } else {
      lines.push(fromPhoto ? head : `${head} · ${unequalShares(participants, payer)}`);
      if (fromPhoto) lines.push(unequalShares(participants, payer));
    }
    if (input.lowConfidence === true)
      lines.push('double-check the total, i had a hard time reading it');
    if (fromPhoto) lines.push('👎 to undo, or send fixes ("the wine was mine")');
    else if (isEqual) lines.push('👎 to undo or tell me what to change');
    else lines.push('👎 to undo');
  }

  const allowed = [...new Set([payer, expense.createdBy])];
  const lineItems =
    expense.split.method === 'itemized'
      ? expense.split.lineItems.map((li) => ({
          label: li.label,
          amount: li.amount,
          participants: li.claimedBy.length > 0 ? li.claimedBy : participantIds,
        }))
      : undefined;
  return cardMessage<ExpenseConfirmCard>(
    ctx,
    GROUP,
    lines,
    {
      type: 'expense_confirm',
      title: `${expense.description}, ${amount}`,
      expenseId: expense.expenseId,
      status: expense.status === 'undone' ? 'undone' : 'logged',
      source: expense.source,
      visibility: 'group',
      ...(merchant !== undefined ? { merchant } : {}),
      description: expense.description,
      occurredAt: expense.occurredAt,
      amount: expense.amount,
      paidBy: payer,
      split: {
        method: expense.split.method,
        participants,
        ...(excluded.length > 0 ? { excluded } : {}),
      },
      ...(lineItems !== undefined ? { lineItems } : {}),
      ...(input.lowConfidence === true ? { lowConfidence: true } : {}),
    },
    expense.status === 'undone' ? {} : { actions: [action('undo', { allowedMemberIds: allowed })] },
  );
}

/** VOICE §3.7: a private item the owner shared reaches the group with the next recap, not as a ping. */
export const SHARED_NEXT_RECAP_LINE = "it'll show up in the group with the next recap";

/**
 * The owner's 👍 on a "looks shared?" DM (T-013): the VOICE §4.4 logged line
 * for the new tab entry, sent to the OWNER's DM only (VOICE §3.7: no group
 * ping), plus where it will surface. The card is the ordinary `logged`
 * expense card (group-safe data: the promoted expense), so 👎 / Undo on it
 * undoes the tab entry through the same path as a chat-logged expense.
 */
export function renderSharedToTab(
  input: ExpenseLoggedRenderInput & { readonly ownerMemberId: MemberId },
  ctx: RenderContext,
): OutboundMessage & { readonly card: ExpenseConfirmCard } {
  const base = renderExpenseLogged(input, ctx);
  const lines = base.text.split('\n');
  lines.splice(Math.max(1, lines.length - 1), 0, SHARED_NEXT_RECAP_LINE);
  const text = lines.join('\n');
  return { ...base, to: dm(input.ownerMemberId), text, card: { ...base.card, fallbackText: text } };
}

// ---------- looks shared? (private DM) ----------

export interface LooksSharedItem {
  /** The pending private item (owner's PrivateStore). Rendered only into the owner's DM. */
  readonly item: PendingPrivateItem;
  /** Optional recognizer line: "that the ride back from razzmatazz?" / "groceries for the airbnb?". */
  readonly guess?: string;
  /** Email extra: "Eixample → Poblenou, 4 riders". */
  readonly detail?: string;
  /** Who it would be split with, if not `item.suggestedParticipants`. */
  readonly splitWith?: readonly MemberId[];
  /** "the 5 who went" instead of listing names. */
  readonly splitWithLabel?: string;
}

const SOURCE: Readonly<Record<PendingPrivateItem['source'], ExpenseSource>> = {
  card: 'card_transaction',
  email: 'email_receipt',
  receipt: 'receipt_photo',
};

/** Max items listed in a digest before "+N more in the card" (VOICE §3.3, DM 6-line cap). */
const MAX_DIGEST_LINES = 4;

function itemCard(entry: LooksSharedItem, ctx: RenderContext, text: string): ExpenseConfirmCard {
  const { item } = entry;
  const participants = inMemberOrder(ctx, entry.splitWith ?? item.suggestedParticipants ?? []).map(
    (id): Participant => ({ memberId: id, name: nameOf(ctx, id) }),
  );
  return {
    cardId: ctx.ids.next('card'),
    type: 'expense_confirm',
    title: `${item.merchantDisplay}, ${formatMoney(item.amount)}`,
    fallbackText: text,
    expenseId: item.id,
    status: 'pending',
    source: SOURCE[item.source],
    visibility: 'private',
    merchant: item.merchantDisplay,
    description: item.merchantDisplay,
    occurredAt: item.occurredAt,
    amount: item.amount,
    paidBy: item.ownerMemberId,
    split: { method: 'equal', participants },
    ...(item.lineItems !== undefined
      ? {
          lineItems: item.lineItems.map((li) => ({
            label: li.label,
            amount: li.amount,
            participants: li.claimedBy,
          })),
        }
      : {}),
    ...(item.classifier !== undefined ? { classifier: { ...item.classifier } } : {}),
    ...(item.lowConfidence ? { lowConfidence: true } : {}),
  };
}

function splitWithText(entry: LooksSharedItem, ctx: RenderContext): string {
  if (entry.splitWithLabel !== undefined) return entry.splitWithLabel;
  const ids = entry.splitWith ?? entry.item.suggestedParticipants ?? [];
  const others = ids.filter((id) => id !== entry.item.ownerMemberId);
  if (others.length === 0) return 'the group';
  return listNames(ctx, others);
}

function singleLines(entry: LooksSharedItem, ctx: RenderContext): string[] {
  const { item } = entry;
  const amount = formatMoney(item.amount);
  const lines: string[] = [];
  if (item.source === 'email') {
    const day = dayPhrase(item.occurredAt, ctx.timeZone, ctx.now);
    lines.push(
      `${item.merchantDisplay} receipt from ${day}: ${amount}${entry.detail !== undefined ? `, ${entry.detail}` : ''}`,
    );
    lines.push(`split with ${splitWithText(entry, ctx)}? 👍 yes · 👎 just me`);
  } else {
    // VOICE §4.5 "at 2:14am"; an older charge keeps its day after the time ("at 2:14am on sun mar 15").
    const time = formatClockTime(item.occurredAt, ctx.timeZone);
    const full = whenShort(item.occurredAt, ctx.timeZone, ctx.now);
    const when =
      full === time
        ? time
        : full.endsWith(` ${time}`)
          ? `${time} on ${full.slice(0, -(time.length + 1))}`
          : full;
    lines.push(
      `saw ${amount} from ${item.merchantDisplay} at ${when}${entry.guess !== undefined ? `, ${entry.guess}` : ''}`,
    );
    lines.push(
      `looks shared. 👍 to split with ${splitWithText(entry, ctx)}, 👎 to keep it off the tab`,
    );
  }
  if (item.lowConfidence) lines.push('double-check the amount before you 👍');
  return lines;
}

function digestLine(entry: LooksSharedItem, index: number, ctx: RenderContext): string {
  const { item } = entry;
  const note =
    entry.guess ?? (item.classifier?.looksShared === true ? 'looks shared' : 'probably just you');
  return `${String(index)}. ${formatMoney(item.amount)} · ${item.merchantDisplay} · ${whenShort(
    item.occurredAt,
    ctx.timeZone,
    ctx.now,
  )} · ${note}`;
}

export function renderLooksShared(
  input: { readonly ownerMemberId: MemberId; readonly items: readonly LooksSharedItem[] },
  ctx: RenderContext,
): OutboundMessage & { readonly card: ExpenseConfirmCard } {
  const owner = ctx.members.find((m) => m.memberId === input.ownerMemberId);
  if (owner === undefined)
    throw new TravError('invalid_argument', 'renderLooksShared: unknown owner');
  if (safety.isMinor(owner, ctx.now)) {
    throw new TravError('invalid_argument', 'renderLooksShared: never prompt a minor (VOICE §6.1)');
  }
  if (input.items.length === 0)
    throw new TravError('invalid_argument', 'renderLooksShared: no items');
  for (const e of input.items) {
    if (e.item.ownerMemberId !== input.ownerMemberId) {
      throw new TravError('not_owner', 'renderLooksShared: item belongs to another member');
    }
  }
  const to = dm(input.ownerMemberId);
  const owners: Action['allowedMemberIds'] = [input.ownerMemberId];

  if (input.items.length === 1) {
    const entry = input.items[0]!;
    const lines = singleLines(entry, ctx);
    const text = lines.join('\n');
    const { cardId: _cardId, fallbackText: _fb, ...card } = itemCard(entry, ctx, text);
    return cardMessage<ExpenseConfirmCard>(ctx, to, lines, card, {
      actions: [
        action('confirm', { allowedMemberIds: owners }),
        action('keep_private', { allowedMemberIds: owners }),
      ],
    });
  }

  const items = input.items;
  const allCard = items.every((e) => e.item.source === 'card');
  const allEmail = items.every((e) => e.item.source === 'email');
  const noun = allCard ? 'charges' : allEmail ? 'receipts' : 'things';
  const lines = [
    `${String(items.length)} ${noun} that look shared, 👍 each one you want on the tab:`,
  ];
  const showAll = items.length <= MAX_DIGEST_LINES;
  const shown = showAll ? items : items.slice(0, MAX_DIGEST_LINES - 1);
  shown.forEach((e, i) => lines.push(digestLine(e, i + 1, ctx)));
  if (!showAll) lines.push(`+${String(items.length - shown.length)} more in the card`);
  lines.push('anything you skip stays private');

  const digestItems = items.map((e) => itemCard(e, ctx, singleLines(e, ctx).join('\n')));
  const first = items[0]!.item;
  const sameCurrency = items.every((e) => e.item.amount.currency === first.amount.currency);
  const amount = sameCurrency
    ? sum(
        items.map((e) => e.item.amount),
        first.amount.currency,
      )
    : first.amount;
  return cardMessage<ExpenseConfirmCard>(
    ctx,
    to,
    lines,
    {
      type: 'expense_confirm',
      title: `${String(items.length)} ${noun} that look shared`,
      expenseId: first.id,
      status: 'pending',
      source: SOURCE[first.source],
      visibility: 'private',
      description: `${String(items.length)} ${noun}`,
      amount,
      paidBy: input.ownerMemberId,
      split: { method: 'equal', participants: [] },
      digestItems,
    },
    {
      actions: items.flatMap((e, i) => [
        action('confirm', {
          label: `Share ${String(i + 1)}`,
          allowedMemberIds: owners,
          value: e.item.id,
          textAliases: [],
        }),
        action('keep_private', {
          label: `Keep ${String(i + 1)} private`,
          allowedMemberIds: owners,
          value: e.item.id,
          textAliases: [],
        }),
      ]),
    },
  );
}
