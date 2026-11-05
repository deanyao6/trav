/**
 * T-165, VOICE §4.13: the one-line group notice for an expense that landed on
 * the ledger, whatever the source (chat text, receipt photo, email receipt,
 * card transaction, booking):
 *
 *   Chase added Uber €18.60 · 4 ways (not Henry, Crowley)
 *
 * Pure functions of group-safe data only: an `Expense` from the GroupStore
 * (a private item only becomes one through `promote()` after its owner
 * confirmed it, with the private fields stripped) plus the member list. No
 * card, no buttons, no @tags: on a channel with `systemNotices` it renders
 * as a centered grey subscript, elsewhere as a short ordinary message.
 *
 * Batching: notices that land within `NOTICE_BATCH_WINDOW_MS` of the first
 * one in their batch become one line (`batchByWindow`, `renderExpenseNotice`
 * with several expenses).
 */
import type { Expense, MemberId, OutboundMessage, Share } from '@trav/core';
import { TravError, ledger, parseIso } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, inMemberOrder, listNames, nameOf, textMessage } from './common.js';
import { paidPhrase } from './expenseConfirm.js';

/** "~60 seconds" (T-165): notices landing this close together share one line. */
export const NOTICE_BATCH_WINDOW_MS = 60_000;

/** At most this many expenses are named in one batched line; the rest are counted. */
export const NOTICE_MAX_ITEMS = 3;

/** VOICE §3.1 ordinary-reply ceiling, kept well under: a notice is one short line. */
export const NOTICE_MAX_CHARS = 240;

export type SystemNoticeMessage = OutboundMessage & { readonly kind: 'system_notice' };

export interface NoticeRenderInput {
  /** One or more expenses of the same group, in the order they landed. */
  readonly expenses: readonly Expense[];
  /**
   * Who an `exclude` split and "(not …)" are measured against. Default: the
   * active members, as every ingestion path builds its split context.
   */
  readonly participantsUniverse?: readonly MemberId[];
}

/**
 * Split items that landed within `windowMs` of the first item of their batch
 * into one batch each, in time order (stable for equal times). Pure.
 */
export function batchByWindow<T extends { readonly at: string }>(
  items: readonly T[],
  windowMs: number = NOTICE_BATCH_WINDOW_MS,
): T[][] {
  const sorted = items
    .map((item, i) => ({ item, i, t: parseIso(item.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const batches: T[][] = [];
  let start = Number.NEGATIVE_INFINITY;
  for (const { item, t } of sorted) {
    const current = batches[batches.length - 1];
    if (current !== undefined && t - start <= windowMs) {
      current.push(item);
    } else {
      batches.push([item]);
      start = t;
    }
  }
  return batches;
}

function isMember(ctx: Pick<RenderContext, 'members'>, id: MemberId): boolean {
  return ctx.members.some((m) => m.memberId === id);
}

/** Who "added" it: whoever put it on the tab (`createdBy`), else the first payer. */
function actorOf(expense: Expense, ctx: Pick<RenderContext, 'members'>): MemberId {
  if (isMember(ctx, expense.createdBy)) return expense.createdBy;
  const payer = expense.paidBy[0]?.memberId;
  if (payer === undefined || !isMember(ctx, payer)) {
    throw new TravError('invalid_argument', 'expense notice: no member to name', {
      expenseId: expense.expenseId,
    });
  }
  return payer;
}

/** "Uber €18.60", "museum $40 (≈€36.90)", plus " on Chase" when someone else paid. */
function itemPhrase(
  expense: Expense,
  actor: MemberId,
  ctx: Pick<RenderContext, 'members'>,
): string {
  const { said, approx } = paidPhrase(expense);
  const payers = expense.paidBy.map((p) => p.memberId).filter((id) => isMember(ctx, id));
  const onPayer =
    payers.length > 0 && !(payers.length === 1 && payers[0] === actor)
      ? ` on ${listNames(ctx, payers)}`
      : '';
  return `${expense.description} ${said}${approx}${onPayer}`;
}

/**
 * "4 ways (not Henry, Crowley)" / "6 ways" / "all on Chase" / "5 ways by item" /
 * "3 ways, custom shares". `compact` drops the parenthesis (batched lines).
 */
function splitPhrase(
  expense: Expense,
  shares: readonly Share[],
  universe: readonly MemberId[],
  ctx: Pick<RenderContext, 'members'>,
  compact: boolean,
): string {
  const ids = inMemberOrder(
    ctx,
    shares
      .filter((s) => s.amount.amountMinor !== 0 && isMember(ctx, s.memberId))
      .map((s) => s.memberId),
  );
  if (ids.length === 0) return 'on the tab';
  if (ids.length === 1) return `all on ${nameOf(ctx, ids[0]!)}`;
  const n = `${String(ids.length)} ways`;
  const split = expense.split;
  if (split.method === 'itemized') return `${n} by item`;
  if (split.method === 'weighted' || split.method === 'exact') return `${n}, custom shares`;
  if (compact) return n;
  const excluded = inMemberOrder(
    ctx,
    (split.method === 'exclude'
      ? split.excluded
      : universe.filter((id) => !split.participants.includes(id))
    ).filter((id) => isMember(ctx, id) && !ids.includes(id)),
  );
  if (excluded.length === 0) return n;
  // VOICE §4.4: "(not Henry)"; when more are out than in, name who's in instead.
  return excluded.length <= ids.length
    ? `${n} (not ${excluded.map((id) => nameOf(ctx, id)).join(', ')})`
    : `${n} (${ids.map((id) => nameOf(ctx, id)).join(', ')})`;
}

interface NoticeItem {
  readonly actor: MemberId;
  readonly item: string;
  readonly full: string;
  readonly compact: string;
}

function describe(
  expense: Expense,
  ctx: Pick<RenderContext, 'members'>,
  universe: readonly MemberId[],
): NoticeItem {
  const splitCtx: ledger.SplitContext = {
    memberOrder: ctx.members.map((m) => m.memberId),
    participantsUniverse: universe,
  };
  const shares = ledger.computeShares(expense, splitCtx);
  const actor = actorOf(expense, ctx);
  const item = itemPhrase(expense, actor, ctx);
  return {
    actor,
    item,
    full: splitPhrase(expense, shares, universe, ctx, false),
    compact: splitPhrase(expense, shares, universe, ctx, true),
  };
}

/** "Arjun added Uber €18.60 (4 ways) · Crowley added Uber €23.40 (5 ways) and dinner €40 (3 ways)". */
function batchedLine(
  items: readonly NoticeItem[],
  shown: number,
  ctx: Pick<RenderContext, 'members'>,
): string {
  const visible = items.slice(0, shown);
  const actors: MemberId[] = [];
  for (const i of visible) if (!actors.includes(i.actor)) actors.push(i.actor);
  const segments = actors.map((actor) => {
    const mine = visible.filter((i) => i.actor === actor).map((i) => `${i.item} (${i.compact})`);
    const list =
      mine.length === 1
        ? mine[0]!
        : `${mine.slice(0, -1).join(', ')} and ${mine[mine.length - 1]!}`;
    return `${nameOf(ctx, actor)} added ${list}`;
  });
  const rest = items.length - visible.length;
  if (rest > 0) segments.push(`+${String(rest)} more on the tab`);
  return segments.join(' · ');
}

/** The notice text for one batch (pure). */
export function expenseNoticeText(
  input: NoticeRenderInput,
  ctx: Pick<RenderContext, 'members'>,
): string {
  if (input.expenses.length === 0) {
    throw new TravError('invalid_argument', 'expense notice: nothing to announce');
  }
  const universe =
    input.participantsUniverse ?? ctx.members.filter((m) => m.active).map((m) => m.memberId);
  const items = input.expenses.map((e) => describe(e, ctx, universe));
  if (items.length === 1) {
    const only = items[0]!;
    return `${nameOf(ctx, only.actor)} added ${only.item} · ${only.full}`;
  }
  for (let shown = Math.min(NOTICE_MAX_ITEMS, items.length); shown > 1; shown--) {
    const line = batchedLine(items, shown, ctx);
    if (line.length <= NOTICE_MAX_CHARS) return line;
  }
  return batchedLine(items, 1, ctx);
}

/** The group-lane `system_notice` for one batch. Never proactive: it follows someone's action. */
export function renderExpenseNotice(
  input: NoticeRenderInput,
  ctx: RenderContext,
): SystemNoticeMessage {
  for (const e of input.expenses) {
    if (e.groupId !== ctx.groupId) {
      throw new TravError('invalid_argument', 'expense notice: expense from another group', {
        expenseId: e.expenseId,
      });
    }
  }
  const message = textMessage(ctx, GROUP, [expenseNoticeText(input, ctx)]);
  return {
    ...message,
    kind: 'system_notice',
    noticeExpenseIds: input.expenses.map((e) => e.expenseId),
  };
}
