/**
 * `log_expense` and `get_balances`. Money is integer minor units + ISO code,
 * shares come from `ledger.buildLedgerEntries` (never recomputed here), and a
 * chat expense is idempotent on its source message (`sourceRef.kind === 'message'`).
 */
import type {
  Expense,
  ExpenseCategory,
  ExpenseConfirmCard,
  LineItem,
  Member,
  MemberId,
  Money,
  SplitSpec,
} from '@trav/core';
import { formatMoney, formatShares, formatTransfer, ledger, money, TravError } from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import type { ToolContext, ToolDefinition } from './registry.js';
import {
  activeMembers,
  asRecord,
  bad,
  isoOrNow,
  isRecord,
  messageIdOf,
  nameOf,
  optEnum,
  optInt,
  optString,
  optStringArray,
  reqString,
  requireMember,
  requireTrip,
  resolveMemberRef,
} from './shared.js';

const CATEGORIES: readonly ExpenseCategory[] = [
  'tickets',
  'flights',
  'lodging',
  'food',
  'drinks',
  'transport',
  'groceries',
  'activities',
  'other',
];

/** Split as the model states it; member references may be ids or display names. */
export type RawSplit =
  | { readonly method: 'equal'; readonly participants: readonly string[] }
  | { readonly method: 'exclude'; readonly excluded: readonly string[] }
  | { readonly method: 'weighted'; readonly weights: readonly { readonly member: string; readonly weight: number }[] }
  | { readonly method: 'exact'; readonly amounts: readonly { readonly member: string; readonly amountMinor: number }[] }
  | {
      readonly method: 'itemized';
      readonly participants: readonly string[];
      readonly lineItems: readonly {
        readonly label: string;
        readonly amountMinor: number;
        readonly claimedBy: readonly string[];
        readonly kind?: LineItem['kind'];
      }[];
    };

export interface LogExpenseInput {
  readonly description: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly paidBy?: string;
  readonly split: RawSplit;
  readonly category?: ExpenseCategory;
  readonly occurredAt?: string;
  readonly activityId?: string;
}

function parseSplit(v: unknown): RawSplit {
  if (!isRecord(v)) bad('split must be an object');
  const method = v['method'];
  const refs = (key: string): string[] => {
    const arr = optStringArray(v, key);
    if (arr === undefined) bad(`split.${key} is required`);
    return arr;
  };
  switch (method) {
    case 'equal':
      return { method, participants: refs('participants') };
    case 'exclude':
      return { method, excluded: optStringArray(v, 'excluded') ?? [] };
    case 'weighted': {
      const weights = v['weights'];
      if (!Array.isArray(weights)) bad('split.weights must be an array');
      return {
        method,
        weights: weights.map((w) => {
          if (!isRecord(w)) bad('split.weights entries must be objects');
          const weight = w['weight'];
          if (typeof weight !== 'number' || !(weight > 0)) bad('weight must be > 0');
          return { member: reqString(w, 'member', 80), weight };
        }),
      };
    }
    case 'exact': {
      const amounts = v['amounts'];
      if (!Array.isArray(amounts)) bad('split.amounts must be an array');
      return {
        method,
        amounts: amounts.map((a) => {
          if (!isRecord(a)) bad('split.amounts entries must be objects');
          const amountMinor = optInt(a, 'amountMinor');
          if (amountMinor === undefined || amountMinor < 0) bad('amountMinor must be a non-negative integer');
          return { member: reqString(a, 'member', 80), amountMinor };
        }),
      };
    }
    case 'itemized': {
      const items = v['lineItems'];
      if (!Array.isArray(items)) bad('split.lineItems must be an array');
      return {
        method,
        participants: refs('participants'),
        lineItems: items.map((li) => {
          if (!isRecord(li)) bad('split.lineItems entries must be objects');
          const amountMinor = optInt(li, 'amountMinor');
          if (amountMinor === undefined) bad('lineItems.amountMinor must be an integer');
          const kind = optEnum(li, 'kind', ['item', 'tax', 'tip', 'service', 'fee', 'discount'] as const);
          return {
            label: reqString(li, 'label', 80),
            amountMinor,
            claimedBy: optStringArray(li, 'claimedBy') ?? [],
            ...(kind !== undefined ? { kind } : {}),
          };
        }),
      };
    }
    default:
      return bad('split.method must be equal, exclude, weighted, exact or itemized');
  }
}

export function parseLogExpenseInput(raw: unknown): LogExpenseInput {
  const r = asRecord(raw);
  const amountMinor = optInt(r, 'amountMinor');
  if (amountMinor === undefined || amountMinor <= 0) bad('amountMinor must be a positive integer (minor units)');
  const currency = optString(r, 'currency', 3)?.toUpperCase();
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) bad('currency must be an ISO 4217 code');
  const out: { -readonly [K in keyof LogExpenseInput]: LogExpenseInput[K] } = {
    description: reqString(r, 'description', 80),
    amountMinor,
    currency,
    split: parseSplit(r['split'] ?? { method: 'exclude', excluded: [] }),
  };
  const paidBy = optString(r, 'paidBy', 80);
  if (paidBy !== undefined) out.paidBy = paidBy;
  const category = optEnum(r, 'category', CATEGORIES);
  if (category !== undefined) out.category = category;
  const occurredAt = optString(r, 'occurredAt', 40);
  if (occurredAt !== undefined) out.occurredAt = occurredAt;
  const activityId = optString(r, 'activityId', 80);
  if (activityId !== undefined) out.activityId = activityId;
  return out;
}

function resolveAll(members: readonly Member[], refs: readonly string[], what: string): MemberId[] {
  return refs.map((ref) => {
    const id = resolveMemberRef(members, ref);
    if (id === undefined) throw new TravError('not_found', `${what}: no member "${ref}" on this trip`);
    return id;
  });
}

function toSplit(raw: RawSplit, members: readonly Member[], currency: string): SplitSpec {
  switch (raw.method) {
    case 'equal':
      return { method: 'equal', participants: resolveAll(members, raw.participants, 'participants') };
    case 'exclude':
      return { method: 'exclude', excluded: resolveAll(members, raw.excluded, 'excluded') };
    case 'weighted':
      return {
        method: 'weighted',
        weights: raw.weights.map((w) => ({
          memberId: resolveAll(members, [w.member], 'weights')[0]!,
          weight: w.weight,
        })),
      };
    case 'exact':
      return {
        method: 'exact',
        amounts: raw.amounts.map((a) => ({
          memberId: resolveAll(members, [a.member], 'amounts')[0]!,
          amount: money(a.amountMinor, currency),
        })),
      };
    case 'itemized':
      return {
        method: 'itemized',
        participants: resolveAll(members, raw.participants, 'participants'),
        lineItems: raw.lineItems.map((li, i) => ({
          lineId: `li${i + 1}`,
          label: li.label,
          amount: money(li.amountMinor, currency),
          claimedBy: resolveAll(members, li.claimedBy, 'claimedBy'),
          kind: li.kind ?? 'item',
        })),
      };
  }
}

export type LogExpenseResult =
  | {
      readonly kind: 'logged';
      readonly expenseId: string;
      readonly description: string;
      readonly amount: Money;
      readonly paidBy: { readonly memberId: MemberId; readonly name: string };
      readonly shares: readonly { readonly memberId: MemberId; readonly name: string; readonly amountMinor: number }[];
      readonly excluded: readonly { readonly memberId: MemberId; readonly name: string }[];
      readonly text: string;
      readonly card: ExpenseConfirmCard;
    }
  | { readonly kind: 'already_logged'; readonly expenseId: string; readonly text: string }
  | { readonly kind: 'clarify'; readonly question: string };

/** VOICE §4.4: "logged: €84 dinner on Dean, 5 ways (not Henry) → €16.80 each". */
export function renderExpenseLoggedText(
  expense: Expense,
  shares: readonly { readonly memberId: MemberId; readonly amount: Money }[],
  members: readonly Member[],
  excluded: readonly MemberId[],
): string {
  const payer = expense.paidBy[0]!;
  const head = `logged: ${formatMoney(expense.amount)} ${sanitizeInline(expense.description, 40).toLowerCase()} on ${nameOf(members, payer.memberId)}`;
  const nonZero = shares.filter((s) => s.amount.amountMinor !== 0);
  const allEqualish =
    nonZero.length > 0 &&
    Math.max(...nonZero.map((s) => s.amount.amountMinor)) -
      Math.min(...nonZero.map((s) => s.amount.amountMinor)) <=
      1;
  let line1: string;
  if (nonZero.length === 1 && nonZero[0]!.memberId !== payer.memberId) {
    line1 = `${head} · ${nameOf(members, nonZero[0]!.memberId)} owes ${formatMoney(nonZero[0]!.amount)}`;
  } else if (allEqualish) {
    const not = excluded.length > 0 ? ` (not ${excluded.map((id) => nameOf(members, id)).join(', ')})` : '';
    const each = nonZero[0]!.amount;
    line1 = `${head}, ${nonZero.length} ways${not} → ${formatMoney(each)} each`;
  } else {
    line1 = `${head} · ${formatShares(nonZero.map((s) => ({ name: nameOf(members, s.memberId), amount: s.amount })))}`;
  }
  return `${line1}\n👎 to undo or tell me what to change`;
}

export const logExpenseTool: ToolDefinition<LogExpenseInput, LogExpenseResult> = {
  name: 'log_expense',
  description:
    'Log a shared expense a member paid and split it on the tab: equal, everyone except some people (exclude), weighted, exact amounts, or itemized line items. Amounts are integer minor units (€84 = 8400) in the trip currency; if the member said a different currency, call anyway and the tool will ask. Only members may log; the payer defaults to the sender.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      amountMinor: { type: 'integer', minimum: 1 },
      currency: { type: 'string', description: 'ISO 4217' },
      paidBy: { type: 'string', description: 'member id or name; default sender' },
      split: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['equal', 'exclude', 'weighted', 'exact', 'itemized'] },
          participants: { type: 'array', items: { type: 'string' } },
          excluded: { type: 'array', items: { type: 'string' } },
          weights: { type: 'array', items: { type: 'object' } },
          amounts: { type: 'array', items: { type: 'object' } },
          lineItems: { type: 'array', items: { type: 'object' } },
        },
        required: ['method'],
      },
      category: { type: 'string', enum: [...CATEGORIES] },
      occurredAt: { type: 'string' },
      activityId: { type: 'string' },
    },
    required: ['description', 'amountMinor', 'currency', 'split'],
    additionalProperties: false,
  },
  parse: parseLogExpenseInput,
  async handler(input, ctx) {
    const me = requireMember(ctx);
    const trip = requireTrip(ctx);
    const members = activeMembers(ctx);
    if (input.currency !== trip.currency) {
      const said = formatMoney(money(input.amountMinor, input.currency));
      const tab = formatMoney(money(input.amountMinor, trip.currency));
      return {
        kind: 'clarify',
        question: `was that ${said} or ${tab}? the tab is in ${trip.currency}, so i can only log ${trip.currency} for now`,
      };
    }
    const payerId = input.paidBy === undefined ? me.memberId : resolveMemberRef(members, input.paidBy);
    if (payerId === undefined) throw new TravError('not_found', `no member "${input.paidBy ?? ''}" on this trip`);

    const messageId = messageIdOf(ctx);
    const expenses = ctx.stores.group.expenses;
    const prior = expenses.getBySourceRef({ kind: 'message', id: messageId });
    if (prior !== undefined) {
      return {
        kind: 'already_logged',
        expenseId: prior.expenseId,
        text: `already got that one: ${formatMoney(prior.amount)} ${sanitizeInline(prior.description, 40).toLowerCase()}`,
      };
    }

    const amount = money(input.amountMinor, trip.currency);
    const split = toSplit(input.split, members, trip.currency);
    const order = members.map((m) => m.memberId);
    let universe = order;
    if (input.activityId !== undefined) {
      const rows = ctx.stores.group.trips.listAttendance(input.activityId);
      const inIds = rows.filter((r) => r.status === 'in').map((r) => r.memberId);
      if (inIds.length > 0) universe = order.filter((id) => inIds.includes(id));
    }
    const expense: Expense = {
      expenseId: ctx.ids.next('exp'),
      groupId: ctx.groupId,
      tripId: trip.tripId,
      description: input.description,
      category: input.category ?? 'other',
      amount,
      paidBy: [{ memberId: payerId, amount }],
      split,
      source: 'chat',
      sourceRef: { kind: 'message', id: messageId },
      ...(input.activityId !== undefined ? { activityId: input.activityId } : {}),
      occurredAt: isoOrNow(input.occurredAt, ctx.now),
      createdAt: ctx.now,
      createdBy: me.memberId,
      status: 'logged',
    };
    const splitCtx = { memberOrder: order, participantsUniverse: universe };
    const shares = ledger.computeShares(expense, splitCtx);
    const entries = ledger.buildLedgerEntries(expense, splitCtx);
    expenses.create(expense, entries);
    const participants = shares.map((s) => s.memberId);
    ctx.stores.group.audit.append({
      groupId: ctx.groupId,
      tripId: trip.tripId,
      type: 'ledger.entry_created',
      actor: { kind: 'member', id: me.memberId },
      visibility: 'group',
      payload: {
        expenseId: expense.expenseId,
        splitMethod: split.method,
        participants,
        amounts: shares.map((s) => ({ memberId: s.memberId, amountMinor: s.amount.amountMinor })),
        sourceMessageId: messageId,
      },
    });
    const excluded = universe.filter((id) => !participants.includes(id));
    const text = renderExpenseLoggedText(expense, shares, members, excluded);
    const card: ExpenseConfirmCard = {
      cardId: ctx.ids.next('card'),
      type: 'expense_confirm',
      title: sanitizeInline(expense.description, 80),
      fallbackText: text,
      expenseId: expense.expenseId,
      status: 'logged',
      source: 'chat',
      visibility: 'group',
      description: expense.description,
      occurredAt: expense.occurredAt,
      amount,
      paidBy: payerId,
      split: {
        method: split.method,
        participants: shares.map((s) => ({ memberId: s.memberId, name: nameOf(members, s.memberId), share: s.amount })),
        excluded: excluded.map((id) => ({ memberId: id, name: nameOf(members, id) })),
      },
    };
    return {
      kind: 'logged',
      expenseId: expense.expenseId,
      description: expense.description,
      amount,
      paidBy: { memberId: payerId, name: nameOf(members, payerId) },
      shares: shares.map((s) => ({ memberId: s.memberId, name: nameOf(members, s.memberId), amountMinor: s.amount.amountMinor })),
      excluded: excluded.map((id) => ({ memberId: id, name: nameOf(members, id) })),
      text,
      card,
    };
  },
};

export interface BalancesResult {
  readonly currency: string;
  readonly totalSpentMinor: number;
  readonly balances: readonly { readonly memberId: MemberId; readonly name: string; readonly netMinor: number }[];
  readonly transfers: readonly { readonly from: MemberId; readonly to: MemberId; readonly amountMinor: number; readonly text: string }[];
  readonly text: string;
}

export function balancesFor(ctx: ToolContext): BalancesResult {
  const trip = requireTrip(ctx);
  const members = activeMembers(ctx);
  const order = members.map((m) => m.memberId);
  const expenses = ctx.stores.group.expenses;
  const entries = expenses.listEntries(trip.tripId).filter((e) => order.includes(e.memberId));
  const balances = ledger.computeBalances(entries, trip.currency, order);
  const transfers = ledger.settle(balances);
  const total = ledger.totalSpent(expenses.listByTrip(trip.tripId), trip.currency);
  const lines = transfers.map((t) => formatTransfer(nameOf(members, t.from), nameOf(members, t.to), t.amount));
  const text =
    transfers.length === 0
      ? `${formatMoney(total)} on the tab so far. nobody owes anybody. rare. enjoy it`
      : [`${formatMoney(total)} on the tab so far`, ...lines.slice(0, 5)].join('\n');
  return {
    currency: trip.currency,
    totalSpentMinor: total.amountMinor,
    balances: balances.map((b) => ({ memberId: b.memberId, name: nameOf(members, b.memberId), netMinor: b.net.amountMinor })),
    transfers: transfers.map((t, i) => ({ from: t.from, to: t.to, amountMinor: t.amount.amountMinor, text: lines[i]! })),
    text,
  };
}

export const getBalancesTool: ToolDefinition<Record<string, never>, BalancesResult> = {
  name: 'get_balances',
  description:
    'The tab: total spent on the trip, each member\'s net position (positive = is owed) and the minimal set of transfers that settles up. Read-only.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: (raw) => {
    asRecord(raw);
    return {};
  },
  handler: async (_input, ctx) => balancesFor(ctx),
};
