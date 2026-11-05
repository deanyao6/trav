/**
 * The receipt "read it" card (T-011; VOICE §4.4 Example C, §4.11; SAFETY
 * §2.4). Group lane, `expense_confirm` with `status: 'pending'`: what Trav
 * read off the photo and the split it would log, waiting on the poster's 👍.
 *
 *   read it: Taverna del Gat Blau, €184 on Piotr
 *   drinks (€58) split 5 ways without Arjun, food 6 ways
 *   Arjun €21 · everyone else €32.60
 *   👍 to log it, or send fixes ("the wine was mine")
 *
 * Nothing is on the ledger until that 👍 (SAFETY §2.4 "structured results are
 * proposals"). The last line is the one question when Trav still needs
 * something ("who had what? or 👍 to split it 3 ways"). Shares come from
 * `ledger.computeShares` on the exact split the 👍 would log. Merchant and
 * labels were sanitized and injection-screened in `ingest/receiptLines.ts`.
 */
import type {
  Expense,
  ExpenseConfirmCard,
  LineItem,
  MemberId,
  Money,
  OutboundMessage,
  Participant,
} from '@trav/core';
import { formatMoney, ledger, sum } from '@trav/core';
import type { RenderContext } from './common.js';
import { GROUP, action, cardMessage, inMemberOrder, nameOf } from './common.js';
import { unequalShares } from './expenseConfirm.js';
import { isDrinkLine } from '../ingest/receiptLines.js';

/** SAFETY §2.4: the line a low-confidence receipt card carries. */
export const RECEIPT_LOW_CONFIDENCE_LINE = "i'm not certain about this one, please check the total";
export const RECEIPT_CONFIRM_LINE = '👍 to log it, or send fixes ("the wine was mine")';

export interface ReceiptReadInput {
  /** The provisional expense the 👍 would log (`status: 'logged'` shape, not yet stored). */
  readonly expense: Expense;
  readonly splitContext: ledger.SplitContext;
  /** Members the poster's words left out (for "(not Crowley)"). */
  readonly excluded: readonly MemberId[];
  readonly lowConfidence: boolean;
  /** True once the words said anything about lines; otherwise Trav asks "who had what?". */
  readonly itemInfo: boolean;
  /** One question that replaces the last line (VOICE §4.11). */
  readonly question?: string;
  /** A logged expense this looks like (same amount, close in time). */
  readonly duplicate?: { readonly amount: Money; readonly description: string; readonly payer: string };
  readonly poster: MemberId;
  /** Who may tap Log it (default: the poster; a minor's receipt: their guardian). */
  readonly confirmers?: readonly MemberId[];
  /** `Trip.familyTab`: one pot, so the card shows no split and never asks who had what. */
  readonly familyTab?: boolean;
}

export const RECEIPT_FAMILY_TAB_LINE = 'on the family tab, nothing to split';
export const RECEIPT_FAMILY_CONFIRM_LINE = '👍 to log it';

function shortLabel(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+x\d+$/, '')
    .replace(/^(?:bottle|jarro|jug|glass|pitcher) of\s+/, '')
    .trim();
}

function sameSet(a: readonly MemberId[], b: readonly MemberId[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** "drinks (€58) split 5 ways without Arjun, food 6 ways, service + tax by share". */
function summaryLine(
  lines: readonly LineItem[],
  participants: readonly MemberId[],
  ctx: RenderContext,
  currency: string,
): string {
  const items = lines.filter((l) => l.kind === 'item');
  const adjustments = lines.filter((l) => l.kind !== 'item' && l.kind !== 'discount');
  const n = participants.length;
  const pieces: string[] = [];
  const drinkWithout = new Map<string, LineItem[]>();
  const claimed: LineItem[] = [];
  const unclaimed: LineItem[] = [];
  for (const l of items) {
    const who = l.claimedBy.length === 0 ? participants : l.claimedBy;
    if (sameSet(who, participants)) unclaimed.push(l);
    else {
      const missing = participants.filter((m) => !who.includes(m));
      if (isDrinkLine(l.label) && missing.length <= 2 && who.length >= 2) {
        const key = missing.join(',');
        drinkWithout.set(key, [...(drinkWithout.get(key) ?? []), l]);
      } else claimed.push(l);
    }
  }
  for (const [key, ls] of drinkWithout) {
    const missing = key.split(',');
    const amount = sum(
      ls.map((l) => l.amount),
      currency,
    );
    const names = inMemberOrder(ctx, missing).map((id) => nameOf(ctx, id));
    pieces.push(
      `drinks (${formatMoney(amount)}) split ${String(n - missing.length)} ways without ${names.join(' and ')}`,
    );
  }
  if (claimed.length > 3) {
    pieces.push(`${String(claimed.length)} lines claimed`);
  } else {
    for (const l of claimed) {
      const who = l.claimedBy;
      pieces.push(
        who.length === 1
          ? `${shortLabel(l.label)} on ${nameOf(ctx, who[0]!)}`
          : `${shortLabel(l.label)} ${String(who.length)} ways`,
      );
    }
  }
  if (unclaimed.length > 0 && pieces.length > 0) {
    const label = drinkWithout.size > 0 && unclaimed.every((l) => !isDrinkLine(l.label)) ? 'food' : 'the rest';
    pieces.push(`${label} ${String(n)} ways`);
  }
  if (adjustments.length > 0) {
    const names = [...new Set(adjustments.map((l) => (l.kind === 'fee' ? 'fees' : l.kind)))];
    pieces.push(`${names.join(' + ')} by share`);
  }
  return pieces.join(', ');
}

export function renderReceiptRead(
  input: ReceiptReadInput,
  ctx: RenderContext,
): OutboundMessage & { readonly card: ExpenseConfirmCard } {
  const { expense } = input;
  const cur = expense.amount.currency;
  const shares = ledger.computeShares(expense, input.splitContext);
  const payer = expense.paidBy[0]!.memberId;
  const ids = inMemberOrder(
    ctx,
    shares.filter((s) => s.amount.amountMinor !== 0).map((s) => s.memberId),
  );
  const participants: Participant[] = ids.map((id) => ({
    memberId: id,
    name: nameOf(ctx, id),
    share: shares.find((s) => s.memberId === id)!.amount,
  }));
  const amount = formatMoney(expense.amount);
  const merchant = expense.merchantDisplay ?? expense.description;
  const lines: string[] = [`read it: ${merchant}, ${amount} on ${nameOf(ctx, payer)}`];

  const split = expense.split.method === 'itemized' ? expense.split : undefined;
  const lineItems = split?.lineItems ?? [];
  const everyLineEqual = lineItems.every((l) => l.kind !== 'item' || l.claimedBy.length === 0);
  const excluded = inMemberOrder(
    ctx,
    input.excluded.filter((id) => !ids.includes(id)),
  );
  const amounts = participants.map((p) => p.share!.amountMinor);
  const nearlyEqual = Math.max(...amounts) - Math.min(...amounts) <= participants.length;
  const familyTab = input.familyTab === true;
  if (familyTab) {
    lines.push(RECEIPT_FAMILY_TAB_LINE);
  } else if (participants.length === 1) {
    lines[0] = `${lines[0]!}, all on ${participants[0]!.name}`;
  } else if (everyLineEqual && nearlyEqual) {
    const notPart =
      excluded.length > 0 && excluded.length <= participants.length
        ? ` (not ${excluded.map((id) => nameOf(ctx, id)).join(', ')})`
        : '';
    const others = participants.filter((p) => p.memberId !== payer);
    const each = (others[0] ?? participants[0]!).share!;
    lines.push(`${String(participants.length)} ways${notPart} → ${formatMoney(each)} each`);
  } else {
    const summary = summaryLine(lineItems, split?.participants ?? ids, ctx, cur);
    if (summary.length > 0) lines.push(summary);
    lines.push(unequalShares(participants, payer));
  }
  if (input.lowConfidence) lines.push(RECEIPT_LOW_CONFIDENCE_LINE);
  if (input.duplicate !== undefined) {
    const d = input.duplicate;
    lines.push(
      `looks like it's already on the tab: ${formatMoney(d.amount)} ${d.description} on ${d.payer}`,
    );
  }
  const itemLines = lineItems.filter((l) => l.kind === 'item').length;
  if (input.question !== undefined) lines.push(input.question);
  else if (input.duplicate !== undefined) lines.push("👍 only if it's a different one");
  else if (familyTab) lines.push(RECEIPT_FAMILY_CONFIRM_LINE);
  else if (!input.itemInfo && itemLines >= 2 && participants.length >= 2)
    lines.push(`who had what? or 👍 to split it ${String(participants.length)} ways`);
  else lines.push(RECEIPT_CONFIRM_LINE);

  const poster = input.confirmers ?? [input.poster];
  return cardMessage<ExpenseConfirmCard>(
    ctx,
    GROUP,
    lines,
    {
      type: 'expense_confirm',
      title: `${expense.description}, ${amount}`,
      expenseId: expense.expenseId,
      status: 'pending',
      source: 'receipt_photo',
      visibility: 'group',
      merchant,
      description: expense.description,
      occurredAt: expense.occurredAt,
      amount: expense.amount,
      paidBy: payer,
      split: {
        method: expense.split.method,
        participants,
        ...(excluded.length > 0
          ? { excluded: excluded.map((id) => ({ memberId: id, name: nameOf(ctx, id) })) }
          : {}),
      },
      lineItems: lineItems.map((l) => ({
        label: l.label,
        amount: l.amount,
        participants: l.claimedBy.length > 0 ? l.claimedBy : ids,
      })),
      ...(input.lowConfidence ? { lowConfidence: true } : {}),
    },
    {
      actions: [
        action('confirm', { label: 'Log it', allowedMemberIds: poster, textAliases: ['yes', 'log it'] }),
        action('decline', { label: "Don't log it", allowedMemberIds: poster, textAliases: ['no', 'drop it'] }),
      ],
    },
  );
}
