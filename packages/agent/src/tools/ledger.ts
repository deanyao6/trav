/**
 * `log_expense` and `get_balances`. Money is integer minor units + ISO code,
 * shares come from `ledger.buildLedgerEntries` (never recomputed here), and a
 * chat expense is idempotent on its source message (`sourceRef.kind === 'message'`).
 */
import type {
  Expense,
  ExpenseCategory,
  ExpenseConfirmCard,
  IsoDateTime,
  LineItem,
  Member,
  MemberId,
  Money,
  OutboundMessage,
  SplitSpec,
  Trip,
} from '@trav/core';
import {
  convertMoney,
  convertSplit,
  formatIso,
  formatMoney,
  formatShares,
  formatTransfer,
  ledger,
  localDate,
  money,
  parseIso,
  TravError,
  zonedWallTimeToMs,
  zoneOffsetMinutes,
} from '@trav/core';
import { sanitizeInline } from '../context/groupContext.js';
import { alreadyLoggedText, fxAuditFields, fxQuoteFor } from '../ingest/chatExpense.js';
import { noRateQuestion } from '../ingest/expenseText.js';
import { foreignOriginal, modeShare, paidPhrase } from '../render/expenseConfirm.js';
import type { TripLedgerView, TripMoney } from '../context/tripMoney.js';
import { tripMoney } from '../context/tripMoney.js';
import type { RenderContext } from '../render/common.js';
import { GROUP, textMessage } from '../render/common.js';
import type { SettleUpRenderInput } from '../render/settleUp.js';
import { renderSettleUp } from '../render/settleUp.js';
import type { ToolContext, ToolDefinition } from './registry.js';
import {
  activeMembers,
  asRecord,
  bad,
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
  | {
      readonly method: 'weighted';
      readonly weights: readonly { readonly member: string; readonly weight: number }[];
    }
  | {
      readonly method: 'exact';
      readonly amounts: readonly { readonly member: string; readonly amountMinor: number }[];
    }
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
          if (amountMinor === undefined || amountMinor < 0)
            bad('amountMinor must be a non-negative integer');
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
          const kind = optEnum(li, 'kind', [
            'item',
            'tax',
            'tip',
            'service',
            'fee',
            'discount',
          ] as const);
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
  if (amountMinor === undefined || amountMinor <= 0)
    bad('amountMinor must be a positive integer (minor units)');
  const currency = optString(r, 'currency', 3)?.toUpperCase();
  if (currency === undefined || !/^[A-Z]{3}$/.test(currency))
    bad('currency must be an ISO 4217 code');
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
    if (id === undefined)
      throw new TravError('not_found', `${what}: no member "${ref}" on this trip`);
    return id;
  });
}

function toSplit(raw: RawSplit, members: readonly Member[], currency: string): SplitSpec {
  switch (raw.method) {
    case 'equal':
      return {
        method: 'equal',
        participants: resolveAll(members, raw.participants, 'participants'),
      };
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

/**
 * `draft` (amount, payer and split in the currency the member said) carried
 * into the trip currency at the reference rate for its date (T-156; same rate
 * lookup, conversion and split carry-over as the chat flow, D-036).
 * `no_rate` ⇒ no usable rate (none on file, a malformed one): ask, never
 * guess. `too_small` ⇒ the converted total is less than one minor unit per
 * person sharing it (`ways`), e.g. ¥1 three ways: ask for the trip amount.
 */
async function convertToTrip(
  ctx: ToolContext,
  trip: Trip,
  draft: Expense,
  ways: number,
): Promise<
  | { readonly kind: 'ok'; readonly expense: Expense }
  | { readonly kind: 'no_rate' }
  | { readonly kind: 'too_small' }
> {
  const quote = await fxQuoteFor(ctx.fx, trip, draft.amount.currency, draft.occurredAt);
  if (quote === undefined) return { kind: 'no_rate' };
  let amount: Money;
  try {
    amount = convertMoney(draft.amount, trip.currency, quote.rate);
  } catch {
    return { kind: 'no_rate' }; // a malformed rate is no rate
  }
  if (amount.amountMinor < Math.max(1, ways)) return { kind: 'too_small' };
  return {
    kind: 'ok',
    expense: {
      ...draft,
      amount,
      original: {
        amount: draft.amount,
        rate: quote.rate,
        rateDate: quote.rateDate,
        source: quote.source,
      },
      paidBy: draft.paidBy.map((p) => ({ memberId: p.memberId, amount })),
      // the split was validated in the currency said, so this cannot throw
      split: convertSplit(draft.split, amount),
    },
  };
}

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;

/**
 * `occurredAt` as the model may pass it (T-156 r2), always a full ISO time
 * with an offset, so the rate lookup reads the right trip-local date:
 * absent ⇒ now; "2026-03-14" ⇒ that trip-local day (now if it is today, else
 * noon there); "2026-03-14T20:30" (no offset) ⇒ that wall time in the trip's
 * time zone; a time with `Z` or an offset is kept. Anything else is
 * `invalid_argument`, never a silent fall into the no-rate question.
 */
export function tripOccurredAt(
  value: string | undefined,
  now: IsoDateTime,
  timeZone: string,
): IsoDateTime {
  if (value === undefined) return now;
  const at = (date: string, hour: number, minute: number, second: number): IsoDateTime => {
    const ms = zonedWallTimeToMs(date, hour, minute, timeZone) + second * 1000;
    return formatIso(ms, zoneOffsetMinutes(ms, timeZone));
  };
  try {
    if (ISO_DATE_ONLY.test(value)) {
      return localDate(now, timeZone) === value ? now : at(value, 12, 0, 0);
    }
    const local = ISO_LOCAL.exec(value);
    if (local !== null) {
      const [, date, h, m, s] = local;
      const hour = Number(h);
      const minute = Number(m);
      const second = Number(s ?? '0');
      if (hour > 23 || minute > 59 || second > 59) bad('occurredAt: no such time');
      return at(date!, hour, minute, second);
    }
    // A strict ISO date-time with Z or an offset only (T-156 r2 review #3).
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      bad('occurredAt: not an ISO-8601 date-time');
    }
    parseIso(value);
    return value;
  } catch {
    return bad(
      'occurredAt must be YYYY-MM-DD (a trip-local day) or an ISO-8601 date-time, e.g. 2026-03-14T20:30:00+01:00',
    );
  }
}

export type LogExpenseResult =
  | {
      readonly kind: 'logged';
      readonly expenseId: string;
      readonly description: string;
      /** Trip currency (converted when the member said another; T-156). */
      readonly amount: Money;
      /** What was said, when it was another currency than the trip's. */
      readonly original?: Money;
      readonly paidBy: { readonly memberId: MemberId; readonly name: string };
      readonly shares: readonly {
        readonly memberId: MemberId;
        readonly name: string;
        readonly amountMinor: number;
      }[];
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
  // VOICE §3.4: another currency shows what was paid, then the trip amount (T-156).
  const { said, approx } = paidPhrase(expense);
  const head = `logged: ${said} ${sanitizeInline(expense.description, 40).toLowerCase()}${approx} on ${nameOf(members, payer.memberId)}`;
  const nonZero = shares.filter((s) => s.amount.amountMinor !== 0);
  // An equal-style split where rounding left someone at zero (€0.02 three
  // ways) is not "2 ways": list the shares instead (T-156 r2).
  const moneyFree =
    expense.split.method === 'equal' ||
    expense.split.method === 'exclude' ||
    expense.split.method === 'weighted';
  const allEqualish =
    nonZero.length > 0 &&
    (!moneyFree || nonZero.length === shares.length) &&
    Math.max(...nonZero.map((s) => s.amount.amountMinor)) -
      Math.min(...nonZero.map((s) => s.amount.amountMinor)) <=
      1;
  let line1: string;
  if (nonZero.length === 1 && nonZero[0]!.memberId !== payer.memberId) {
    line1 = `${head} · ${nameOf(members, nonZero[0]!.memberId)} owes ${formatMoney(nonZero[0]!.amount)}`;
  } else if (allEqualish) {
    const not =
      excluded.length > 0 ? ` (not ${excluded.map((id) => nameOf(members, id)).join(', ')})` : '';
    // what most of the others owe, as the chat flow's card says (VOICE §4.4; T-156 r2 review #1)
    const others = nonZero.filter((s) => s.memberId !== payer.memberId).map((s) => s.amount);
    const each = modeShare(others) ?? nonZero[0]!.amount;
    line1 = `${head}, ${nonZero.length} ways${not} → ${formatMoney(each)} each`;
  } else {
    line1 = `${head} · ${formatShares(nonZero.map((s) => ({ name: nameOf(members, s.memberId), amount: s.amount })))}`;
  }
  return `${line1}\n👎 to undo or tell me what to change`;
}

export const logExpenseTool: ToolDefinition<LogExpenseInput, LogExpenseResult> = {
  name: 'log_expense',
  description:
    'Log a shared expense a member paid and split it on the tab: equal, everyone except some people (exclude), weighted, exact amounts, or itemized line items. Pass the amount in the currency the member said, as integer minor units of that currency ($40 = 4000 with currency USD; €84 = 8400 with EUR; yen have no decimals, so ¥4000 = 4000 with JPY); exact amounts and line items use that same currency. Another currency than the trip\'s is converted by the tool at the day\'s reference rate (the result shows both, e.g. "$40 museum (≈€36.90)"); never convert it yourself. If there is no rate the tool returns a question to ask instead. Only members may log; the payer defaults to the sender.',
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
      occurredAt: {
        type: 'string',
        description:
          'when it was paid; default now. YYYY-MM-DD for a day in the trip time zone, or an ISO-8601 date-time (2026-03-14T20:30:00+01:00; without an offset it is read in the trip time zone). Picks the day of the reference rate.',
      },
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
    const payerId =
      input.paidBy === undefined ? me.memberId : resolveMemberRef(members, input.paidBy);
    if (payerId === undefined)
      throw new TravError('not_found', `no member "${input.paidBy ?? ''}" on this trip`);

    const messageId = messageIdOf(ctx);
    const expenses = ctx.stores.group.expenses;
    const prior = expenses.getBySourceRef({ kind: 'message', id: messageId });
    if (prior !== undefined) {
      return { kind: 'already_logged', expenseId: prior.expenseId, text: alreadyLoggedText(prior) };
    }

    const order = members.map((m) => m.memberId);
    let universe = order;
    if (input.activityId !== undefined) {
      const rows = ctx.stores.group.trips.listAttendance(input.activityId);
      const inIds = rows.filter((r) => r.status === 'in').map((r) => r.memberId);
      if (inIds.length > 0) universe = order.filter((id) => inIds.includes(id));
    }
    const splitCtx = { memberOrder: order, participantsUniverse: universe };
    const occurredAt = tripOccurredAt(input.occurredAt, ctx.now, trip.timeZone);
    const said = money(input.amountMinor, input.currency);
    // The id is drawn once the expense will be written (a question writes nothing).
    const draft: Expense = {
      expenseId: '',
      groupId: ctx.groupId,
      tripId: trip.tripId,
      description: input.description,
      category: input.category ?? 'other',
      amount: said,
      paidBy: [{ memberId: payerId, amount: said }],
      split: toSplit(input.split, members, input.currency),
      source: 'chat',
      sourceRef: { kind: 'message', id: messageId },
      ...(input.activityId !== undefined ? { activityId: input.activityId } : {}),
      occurredAt,
      createdAt: ctx.now,
      createdBy: me.memberId,
      status: 'logged',
    };
    let expense = draft;
    if (input.currency !== trip.currency) {
      // T-156 (D-036): the split is checked as stated, in the currency it was
      // stated in, then carried into the trip currency at the reference rate
      // for the expense's date. No rate ⇒ the chat flow's one question.
      const asSaid = ledger.computeShares(draft, splitCtx);
      // People sharing it: everyone in an equal-style split (¥1 three ways is
      // 3 even though yen rounding left two at ¥0), else those with money.
      const m = draft.split.method;
      const ways =
        m === 'equal' || m === 'exclude' || m === 'weighted'
          ? asSaid.length
          : asSaid.filter((s) => s.amount.amountMinor !== 0).length;
      const converted = await convertToTrip(ctx, trip, draft, ways);
      if (converted.kind !== 'ok') {
        const desc = sanitizeInline(input.description, 40).toLowerCase();
        return {
          kind: 'clarify',
          question: noRateQuestion(
            desc,
            formatMoney(said),
            trip.currency,
            converted.kind === 'too_small'
              ? `${formatMoney(said)} comes to under ${formatMoney(money(1, trip.currency))} each split ${String(ways)} ways`
              : undefined,
          ),
        };
      }
      expense = converted.expense;
    }
    expense = { ...expense, expenseId: ctx.ids.next('exp') };
    const amount = expense.amount;
    const split = expense.split;
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
        ...fxAuditFields(expense),
      },
    });
    const excluded = universe.filter((id) => !participants.includes(id));
    const text = renderExpenseLoggedText(expense, shares, members, excluded);
    const original = foreignOriginal(expense);
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
      ...(original !== undefined ? { original } : {}),
      paidBy: payerId,
      split: {
        method: split.method,
        participants: shares.map((s) => ({
          memberId: s.memberId,
          name: nameOf(members, s.memberId),
          share: s.amount,
        })),
        excluded: excluded.map((id) => ({ memberId: id, name: nameOf(members, id) })),
      },
    };
    return {
      kind: 'logged',
      expenseId: expense.expenseId,
      description: expense.description,
      amount,
      ...(original !== undefined ? { original } : {}),
      paidBy: { memberId: payerId, name: nameOf(members, payerId) },
      shares: shares.map((s) => ({
        memberId: s.memberId,
        name: nameOf(members, s.memberId),
        amountMinor: s.amount.amountMinor,
      })),
      excluded: excluded.map((id) => ({ memberId: id, name: nameOf(members, id) })),
      text,
      card,
    };
  },
};

export interface BalancesResult {
  readonly currency: string;
  /** `family_tab`: one pot, every balance zero, no transfers (T-058). */
  readonly mode: 'split' | 'family_tab';
  readonly totalSpentMinor: number;
  /** Minors whose money is carried by a guardian ("Lily (under Dad)"); never in `balances`. */
  readonly folded: readonly {
    readonly minor: MemberId;
    readonly name: string;
    readonly guardian: MemberId;
    readonly guardianName: string;
  }[];
  /** Set when a minor with money on the tab has no guardian: `text` is the question for the leads. */
  readonly needsGuardian?: {
    readonly minors: readonly MemberId[];
    readonly askMemberIds: readonly MemberId[];
  };
  readonly balances: readonly {
    readonly memberId: MemberId;
    readonly name: string;
    readonly netMinor: number;
  }[];
  readonly transfers: readonly {
    readonly from: MemberId;
    readonly to: MemberId;
    readonly amountMinor: number;
    readonly text: string;
  }[];
  readonly text: string;
}

/**
 * VOICE §8: a minor is never charged, so when one has money on the tab and no
 * guardian, ask the leads whose tab they're on instead of settling.
 */
export function guardianQuestion(
  members: readonly Member[],
  minors: readonly MemberId[],
  askMemberIds: readonly MemberId[],
): string {
  const kids = minors.map((id) => nameOf(members, id));
  const who =
    askMemberIds.length > 0 ? `, ${andList(askMemberIds.map((id) => nameOf(members, id)))}` : '';
  const share = kids.length === 1 ? `${kids[0] ?? ''}'s share goes` : 'their shares go';
  return `quick one before i settle up${who}: who's covering ${andList(kids)}? under-18s never owe anyone here, so ${share} on an adult's tab`;
}

function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** The trip's money via `ledger.tripLedger` over the persisted rows (T-065; minors folded, family tab). */
function tripMoneyFor(ctx: ToolContext): {
  readonly trip: Trip;
  readonly members: readonly Member[];
  readonly money: TripMoney;
} {
  const trip = requireTrip(ctx);
  // Every member (left, guests and minors too): an inactive guardian still
  // carries a minor, and dropping anyone's rows would unbalance the tab.
  const members = ctx.stores.group.members.listByGroup(ctx.groupId);
  const expenses = ctx.stores.group.expenses;
  return {
    trip,
    members,
    money: tripMoney({
      trip,
      members,
      expenses: expenses.listByTrip(trip.tripId),
      entries: expenses.listEntries(trip.tripId),
      payments: ctx.stores.group.settlements.listByTrip(trip.tripId),
      now: ctx.now,
    }),
  };
}

/** Rows worth showing: current members, plus anyone else who still has money on the tab. */
function shownBalances(
  view: TripLedgerView,
  members: readonly Member[],
): TripLedgerView['balances'] {
  const current = new Set(
    members
      .filter((m) => m.active && m.leftAt === undefined && m.role !== 'guest')
      .map((m) => m.memberId),
  );
  return view.balances.filter((b) => current.has(b.memberId) || b.net.amountMinor !== 0);
}

/** "Lily (under Dad)" for each minor folded into a guardian (VOICE §8). */
function foldedRows(view: TripLedgerView, members: readonly Member[]): BalancesResult['folded'] {
  return view.folded.flatMap((f) =>
    f.guardian === null
      ? []
      : [
          {
            minor: f.minor,
            name: nameOf(members, f.minor),
            guardian: f.guardian,
            guardianName: nameOf(members, f.guardian),
          },
        ],
  );
}

export function balancesFor(ctx: ToolContext): BalancesResult {
  const { trip, members, money: tm } = tripMoneyFor(ctx);
  if (tm.kind === 'needs_guardian') {
    return {
      currency: trip.currency,
      mode: trip.familyTab ? 'family_tab' : 'split',
      totalSpentMinor: tm.total.amountMinor,
      balances: [],
      transfers: [],
      folded: [],
      needsGuardian: { minors: tm.minors, askMemberIds: tm.askMemberIds },
      text: guardianQuestion(members, tm.minors, tm.askMemberIds),
    };
  }
  const view = tm.ledger;
  const { transfers, total } = view;
  const folded = foldedRows(view, members);
  const lines = transfers.map((t) =>
    formatTransfer(nameOf(members, t.from), nameOf(members, t.to), t.amount),
  );
  let text: string;
  if (view.mode === 'family_tab') {
    text = `${formatMoney(total)} on the family tab so far, nothing to split`;
  } else {
    text =
      transfers.length === 0
        ? `${formatMoney(total)} on the tab so far. nobody owes anybody. rare. enjoy it`
        : [`${formatMoney(total)} on the tab so far`, ...lines.slice(0, 5)].join('\n');
    if (folded.length > 0) {
      text += `\n${folded.map((f) => `${f.name} (under ${f.guardianName})`).join(' · ')}`;
    }
  }
  return {
    currency: trip.currency,
    mode: view.mode,
    totalSpentMinor: total.amountMinor,
    balances: shownBalances(view, members).map((b) => ({
      memberId: b.memberId,
      name: nameOf(members, b.memberId),
      netMinor: b.net.amountMinor,
    })),
    transfers: transfers.map((t, i) => ({
      from: t.from,
      to: t.to,
      amountMinor: t.amount.amountMinor,
      text: lines[i]!,
    })),
    folded,
    text,
  };
}

export type SettleUpForResult =
  | { readonly kind: 'ok'; readonly input: SettleUpRenderInput }
  | {
      readonly kind: 'needs_guardian';
      readonly minors: readonly MemberId[];
      readonly askMemberIds: readonly MemberId[];
      readonly question: string;
    };

/**
 * The settle-up / recap / Wrapped money input from the store (T-065): balances
 * and transfers from `ledger.tripLedger`, so no minor row and, for a family
 * tab, no transfers. A guardian-less minor with money yields the VOICE §8
 * question instead of an input.
 */
export function settleUpFor(ctx: ToolContext, mode: 'running' | 'final'): SettleUpForResult {
  const { trip, members, money: tm } = tripMoneyFor(ctx);
  if (tm.kind === 'needs_guardian') {
    return {
      kind: 'needs_guardian',
      minors: tm.minors,
      askMemberIds: tm.askMemberIds,
      question: guardianQuestion(members, tm.minors, tm.askMemberIds),
    };
  }
  const view = tm.ledger;
  return {
    kind: 'ok',
    input: {
      mode,
      currency: trip.currency,
      balances: shownBalances(view, members),
      transfers: view.transfers,
      // T-141: final cards list what members already said they paid, ticked.
      ...(mode === 'final' && view.paid.length > 0 ? { paid: view.paid } : {}),
      totalSpent: view.total,
      ...(view.mode === 'family_tab' ? { familyTab: true } : {}),
    },
  };
}

/**
 * The settle-up message for the group: the `settle_up` card, or (guardian-less
 * minor) the plain-text question to the leads. Never throws over a minor.
 */
export function renderSettleUpFor(
  ctx: ToolContext,
  mode: 'running' | 'final',
  rctx: RenderContext,
  opts: { readonly showTotal?: boolean; readonly lead?: string } = {},
): OutboundMessage {
  const r = settleUpFor(ctx, mode);
  if (r.kind === 'needs_guardian') return textMessage(rctx, GROUP, [r.question]);
  return renderSettleUp(
    {
      ...r.input,
      ...(opts.showTotal === true ? { showTotal: true } : {}),
      ...(opts.lead !== undefined ? { lead: opts.lead } : {}),
    },
    rctx,
  );
}

export const getBalancesTool: ToolDefinition<Record<string, never>, BalancesResult> = {
  name: 'get_balances',
  description:
    "The tab: total spent on the trip, each member's net position (positive = is owed) and the minimal set of transfers that settles up. Read-only.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  parse: (raw) => {
    asRecord(raw);
    return {};
  },
  handler: async (_input, ctx) => balancesFor(ctx),
};
