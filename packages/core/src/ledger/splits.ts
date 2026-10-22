/**
 * Splits: validate an expense, resolve who is in, compute per-member shares,
 * and derive ledger entries. Every mode produces shares that sum to the
 * expense total to the minor unit. Remainder policy (one rule for every mode):
 * odd minor units go to the LARGEST fractional remainder first; ties go to the
 * payer (VOICE §4.4), then to the other participants in group member order.
 * For equal splits every fraction ties, so the payer always gets the odd cent.
 *
 * Pure functions; `TravError` on invalid input only, never on arithmetic.
 */
import type { CurrencyCode, MemberId } from '../primitives.js';
import type { Money } from '../money.js';
import { allocate, allocateEqual, equals, money, sum } from '../money.js';
import type { Expense, LedgerEntry, LineItem, Share, SplitSpec } from '../domain/expense.js';
import { TravError } from '../errors.js';
import type { SplitContext } from './context.js';
import {
  assertContext,
  assertKnownMembers,
  assertUniqueMembers,
  inMemberOrder,
} from './context.js';

// ---------- validation ----------

function assertMoneyIn(amount: Money, currency: CurrencyCode, what: string): void {
  if (amount.currency !== currency) {
    throw new TravError('currency_mismatch', `${what}: ${amount.currency} vs ${currency}`, {
      what,
      left: amount.currency,
      right: currency,
    });
  }
  if (!Number.isSafeInteger(amount.amountMinor)) {
    throw new TravError('invalid_argument', `${what}: amountMinor must be an integer`, { what });
  }
}

function assertPositiveMoney(amount: Money, currency: CurrencyCode, what: string): void {
  assertMoneyIn(amount, currency, what);
  if (amount.amountMinor <= 0) {
    throw new TravError('invalid_argument', `${what}: amount must be positive`, {
      what,
      amountMinor: amount.amountMinor,
    });
  }
}

function validatePayers(expense: Expense, ctx: SplitContext): void {
  const currency = expense.amount.currency;
  if (expense.paidBy.length === 0) {
    throw new TravError('invalid_argument', 'paidBy must list at least one payer', {
      expenseId: expense.expenseId,
    });
  }
  const payerIds = expense.paidBy.map((p) => p.memberId);
  assertKnownMembers(payerIds, ctx, 'paidBy');
  assertUniqueMembers(payerIds, 'paidBy');
  for (const payer of expense.paidBy) {
    assertPositiveMoney(payer.amount, currency, `paidBy[${payer.memberId}]`);
  }
  const paid = sum(
    expense.paidBy.map((p) => p.amount),
    currency,
  );
  if (!equals(paid, expense.amount)) {
    throw new TravError('invalid_argument', 'paidBy amounts must sum to the expense amount', {
      expenseId: expense.expenseId,
      expected: expense.amount.amountMinor,
      actual: paid.amountMinor,
    });
  }
}

/**
 * Signed contribution of a line to the receipt total. `discount` lines always
 * reduce the total, whichever sign the caller stored; every other kind must be
 * non-negative.
 */
function lineContribution(line: LineItem, currency: CurrencyCode): Money {
  assertMoneyIn(line.amount, currency, `lineItems[${line.lineId}]`);
  if (line.kind === 'discount') {
    return money(-Math.abs(line.amount.amountMinor), currency);
  }
  if (line.amount.amountMinor < 0) {
    throw new TravError(
      'invalid_argument',
      `lineItems[${line.lineId}]: ${line.kind} lines must be non-negative`,
      { lineId: line.lineId, kind: line.kind, amountMinor: line.amount.amountMinor },
    );
  }
  return money(line.amount.amountMinor, currency);
}

function validateItemized(
  split: Extract<SplitSpec, { method: 'itemized' }>,
  expense: Expense,
  participants: readonly MemberId[],
): void {
  const currency = expense.amount.currency;
  const participantSet = new Set(participants);
  const lineIds = new Set<string>();
  for (const line of split.lineItems) {
    if (lineIds.has(line.lineId)) {
      throw new TravError('invalid_argument', `lineItems: lineId ${line.lineId} listed twice`, {
        lineId: line.lineId,
      });
    }
    lineIds.add(line.lineId);
    assertUniqueMembers(line.claimedBy, `lineItems[${line.lineId}].claimedBy`);
    for (const claimant of line.claimedBy) {
      if (!participantSet.has(claimant)) {
        throw new TravError(
          'invalid_argument',
          `lineItems[${line.lineId}]: claimant ${claimant} is not a participant`,
          { lineId: line.lineId, memberId: claimant },
        );
      }
    }
  }
  const lineTotal = sum(
    split.lineItems.map((line) => lineContribution(line, currency)),
    currency,
  );
  if (!equals(lineTotal, expense.amount)) {
    throw new TravError('invalid_argument', 'line items must sum to the expense amount', {
      expenseId: expense.expenseId,
      expected: expense.amount.amountMinor,
      actual: lineTotal.amountMinor,
    });
  }
}

function validateExact(split: Extract<SplitSpec, { method: 'exact' }>, expense: Expense): void {
  const currency = expense.amount.currency;
  for (const entry of split.amounts) {
    assertMoneyIn(entry.amount, currency, `amounts[${entry.memberId}]`);
    if (entry.amount.amountMinor < 0) {
      throw new TravError('invalid_argument', `amounts[${entry.memberId}] must be non-negative`, {
        memberId: entry.memberId,
        amountMinor: entry.amount.amountMinor,
      });
    }
  }
  const total = sum(
    split.amounts.map((a) => a.amount),
    currency,
  );
  if (!equals(total, expense.amount)) {
    throw new TravError('invalid_argument', 'exact amounts must sum to the expense amount', {
      expenseId: expense.expenseId,
      expected: expense.amount.amountMinor,
      actual: total.amountMinor,
    });
  }
}

/**
 * Throws `invalid_argument` if payers don't sum, participants unknown, amounts
 * non-positive, exact/itemized amounts don't reconcile; `currency_mismatch`
 * when any amount is in another currency than the expense.
 */
export function validateExpense(expense: Expense, ctx: SplitContext): void {
  assertContext(ctx);
  assertPositiveMoney(expense.amount, expense.amount.currency, 'amount');
  validatePayers(expense, ctx);
  const participants = resolveParticipants(expense.split, ctx);
  switch (expense.split.method) {
    case 'exact':
      validateExact(expense.split, expense);
      break;
    case 'itemized':
      validateItemized(expense.split, expense, participants);
      break;
    default:
      break;
  }
}

// ---------- participants ----------

/** Who ends up in the split for a spec (after exclude/roster resolution), in member order. */
export function resolveParticipants(split: SplitSpec, ctx: SplitContext): MemberId[] {
  assertContext(ctx);
  let ids: readonly MemberId[];
  switch (split.method) {
    case 'equal':
    case 'itemized':
      assertKnownMembers(split.participants, ctx, `${split.method}.participants`);
      assertUniqueMembers(split.participants, `${split.method}.participants`);
      ids = split.participants;
      break;
    case 'exclude': {
      // Excluding someone who is already absent from the universe is harmless;
      // excluding an unknown member is a typo and rejected.
      assertKnownMembers(split.excluded, ctx, 'exclude.excluded');
      assertUniqueMembers(split.excluded, 'exclude.excluded');
      const excluded = new Set(split.excluded);
      ids = ctx.participantsUniverse.filter((id) => !excluded.has(id));
      break;
    }
    case 'weighted': {
      const members = split.weights.map((w) => w.memberId);
      assertKnownMembers(members, ctx, 'weighted.weights');
      assertUniqueMembers(members, 'weighted.weights');
      for (const w of split.weights) {
        if (!Number.isFinite(w.weight) || w.weight <= 0) {
          throw new TravError(
            'invalid_argument',
            `weighted.weights[${w.memberId}]: weight must be > 0, got ${String(w.weight)}`,
            { memberId: w.memberId, weight: w.weight },
          );
        }
      }
      ids = members;
      break;
    }
    case 'exact': {
      const members = split.amounts.map((a) => a.memberId);
      assertKnownMembers(members, ctx, 'exact.amounts');
      assertUniqueMembers(members, 'exact.amounts');
      ids = members;
      break;
    }
  }
  const resolved = inMemberOrder(ids, ctx.memberOrder);
  if (resolved.length === 0) {
    throw new TravError('invalid_argument', `${split.method} split has no participants`, {
      method: split.method,
    });
  }
  return resolved;
}

// ---------- shares ----------

/**
 * Tie-break order for remainder minor units (used once the largest-remainder
 * rule has nothing left to decide): payers first (largest paid amount first,
 * ties by member order), then everyone else in member order. Only participants
 * are listed.
 */
function remainderPriority(
  expense: Expense,
  participants: readonly MemberId[],
  ctx: SplitContext,
): MemberId[] {
  const index = new Map(ctx.memberOrder.map((id, i) => [id, i] as const));
  const participantSet = new Set(participants);
  const payers = expense.paidBy
    .filter((p) => participantSet.has(p.memberId))
    .slice()
    .sort(
      (a, b) =>
        b.amount.amountMinor - a.amount.amountMinor ||
        (index.get(a.memberId) ?? 0) - (index.get(b.memberId) ?? 0),
    )
    .map((p) => p.memberId);
  const payerSet = new Set(payers);
  return [...payers, ...participants.filter((id) => !payerSet.has(id))];
}

type Minor = Map<MemberId, number>;

/**
 * Allocate `total` over `members` (a subset of `priority`) with optional
 * weights, handing remainders out in priority order. Returns minor units.
 */
function allocateInPriority(
  total: Money,
  members: readonly MemberId[],
  priority: readonly MemberId[],
  weightOf?: (memberId: MemberId) => number,
): Minor {
  const memberSet = new Set(members);
  const ordered = priority.filter((id) => memberSet.has(id));
  const parts =
    weightOf === undefined
      ? allocateEqual(total, ordered.length)
      : allocate(
          total,
          ordered.map((id) => weightOf(id)),
        );
  const out: Minor = new Map();
  ordered.forEach((id, i) => out.set(id, parts[i]?.amountMinor ?? 0));
  return out;
}

// ---------- exact rationals for the itemized pass ----------
//
// Itemized receipts are rounded ONCE: each member's entitlement is kept as an
// exact fraction across every line, then the integer total is distributed by
// largest remainder. Rounding each line separately would pile the odd cents
// onto the same people (three €20 lines, 3 people → 20.01/20.01/19.98).

interface Rat {
  readonly num: bigint;
  readonly den: bigint; // > 0
}

const RAT_ZERO: Rat = { num: 0n, den: 1n };

function bigGcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function rat(num: bigint, den: bigint): Rat {
  const g = bigGcd(num, den);
  return g > 1n ? { num: num / g, den: den / g } : { num, den };
}

function ratAdd(a: Rat, b: Rat): Rat {
  if (a.den === b.den) return rat(a.num + b.num, a.den);
  return rat(a.num * b.den + b.num * a.den, a.den * b.den);
}

/** Floor toward −∞ for BigInt division with a positive divisor. */
function floorDiv(num: bigint, den: bigint): bigint {
  const q = num / den;
  return num < 0n && q * den !== num ? q - 1n : q;
}

/**
 * Round exact entitlements (which sum to `totalMinor`) to integers by the
 * largest-remainder method; ties go to the earlier member in `priority`.
 */
function roundEntitlements(
  entitlements: ReadonlyMap<MemberId, Rat>,
  totalMinor: number,
  priority: readonly MemberId[],
): Minor {
  const rows = priority.map((memberId, index) => {
    const e = entitlements.get(memberId) ?? RAT_ZERO;
    const floor = floorDiv(e.num, e.den);
    return { memberId, index, floor, frac: e.num - floor * e.den, den: e.den };
  });
  let leftover = BigInt(totalMinor) - rows.reduce((acc, r) => acc + r.floor, 0n);
  if (leftover < 0n || leftover > BigInt(rows.length)) {
    throw new TravError('invariant_violation', 'itemized entitlements do not sum to the total', {
      leftover: Number(leftover),
    });
  }
  const byRemainder = rows.slice().sort((a, b) => {
    const left = a.frac * b.den; // compare a.frac/a.den vs b.frac/b.den
    const right = b.frac * a.den;
    if (left !== right) return left > right ? -1 : 1;
    return a.index - b.index;
  });
  const out: Minor = new Map(rows.map((r) => [r.memberId, Number(r.floor)] as const));
  for (const r of byRemainder) {
    if (leftover === 0n) break;
    out.set(r.memberId, Number(r.floor) + 1);
    leftover -= 1n;
  }
  return out;
}

function itemizedShares(
  split: Extract<SplitSpec, { method: 'itemized' }>,
  expense: Expense,
  participants: readonly MemberId[],
  priority: readonly MemberId[],
): Minor {
  const currency = expense.amount.currency;
  const subtotals = new Map<MemberId, Rat>(participants.map((id) => [id, RAT_ZERO] as const));
  const addEach = (target: Map<MemberId, Rat>, owners: readonly MemberId[], amount: Money) => {
    const part: Rat = rat(BigInt(amount.amountMinor), BigInt(owners.length));
    for (const id of owners) target.set(id, ratAdd(target.get(id) ?? RAT_ZERO, part));
  };

  // Pass 1: items. Claimed lines go to their claimants (equally when several
  // people claimed one line); unclaimed lines split equally among everyone present.
  let itemTotal = 0n;
  const adjustments: LineItem[] = [];
  for (const line of split.lineItems) {
    if (line.kind !== 'item') {
      adjustments.push(line);
      continue;
    }
    const amount = lineContribution(line, currency);
    itemTotal += BigInt(amount.amountMinor);
    addEach(subtotals, line.claimedBy.length > 0 ? line.claimedBy : participants, amount);
  }

  // Pass 2: tax / tip / service / fee / discount, pro-rata over item subtotals.
  // A line explicitly claimed ("my voucher") goes to its claimants instead.
  // If nobody has an item subtotal (receipt is all adjustments), split equally.
  const entitlements = new Map<MemberId, Rat>(subtotals);
  let unclaimedAdjustments = 0n;
  for (const line of adjustments) {
    const amount = lineContribution(line, currency);
    if (line.claimedBy.length > 0) addEach(entitlements, line.claimedBy, amount);
    else unclaimedAdjustments += BigInt(amount.amountMinor);
  }
  if (unclaimedAdjustments !== 0n) {
    for (const id of participants) {
      const subtotal = subtotals.get(id) ?? RAT_ZERO;
      const share: Rat =
        itemTotal > 0n
          ? rat(unclaimedAdjustments * subtotal.num, subtotal.den * itemTotal)
          : rat(unclaimedAdjustments, BigInt(participants.length));
      entitlements.set(id, ratAdd(entitlements.get(id) ?? RAT_ZERO, share));
    }
  }
  return roundEntitlements(entitlements, expense.amount.amountMinor, priority);
}

/**
 * Per-member shares for one expense, in member order. Σ shares === expense.amount
 * to the minor unit. Itemized: claimed lines go to claimants; unclaimed lines
 * split equally among participants; tax/tip/service/fee/discount lines are
 * allocated pro-rata to each member's item subtotal. Remainder minor units go
 * to the largest fractional remainder; ties to the payer, then member order.
 *
 * Participants who end up owing nothing (exact €0, itemized with nothing
 * claimed) are still listed with a zero share so callers can see who was present.
 * An itemized share can be NEGATIVE when a member claims a discount larger than
 * their own items ("my €15 voucher" on a €10 dish): that member is owed the
 * difference and the others' shares still sum with it to the total.
 *
 * T-058 hook: minor-share folding into `guardianMemberId` belongs AFTER this
 * function (fold the returned shares), so the split math stays unchanged.
 */
export function computeShares(expense: Expense, ctx: SplitContext): Share[] {
  validateExpense(expense, ctx);
  const participants = resolveParticipants(expense.split, ctx);
  const priority = remainderPriority(expense, participants, ctx);
  const currency = expense.amount.currency;
  const split = expense.split;

  let minor: Minor;
  switch (split.method) {
    case 'equal':
    case 'exclude':
      minor = allocateInPriority(expense.amount, participants, priority);
      break;
    case 'weighted': {
      const weight = new Map(split.weights.map((w) => [w.memberId, w.weight] as const));
      minor = allocateInPriority(
        expense.amount,
        participants,
        priority,
        (id) => weight.get(id) ?? 0,
      );
      break;
    }
    case 'exact':
      minor = new Map(split.amounts.map((a) => [a.memberId, a.amount.amountMinor] as const));
      break;
    case 'itemized':
      minor = itemizedShares(split, expense, participants, priority);
      break;
  }

  return participants.map((memberId) => ({
    memberId,
    amount: money(minor.get(memberId) ?? 0, currency),
  }));
}

// ---------- ledger entries ----------

/**
 * `paid` entries for payers, `owes` entries for participants with a non-zero
 * share. An `undone` expense yields no entries (it never counts) but is still
 * validated.
 */
export function buildLedgerEntries(expense: Expense, ctx: SplitContext): LedgerEntry[] {
  const shares = computeShares(expense, ctx);
  if (expense.status === 'undone') return [];
  const paid: LedgerEntry[] = expense.paidBy.map((p) => ({
    expenseId: expense.expenseId,
    tripId: expense.tripId,
    memberId: p.memberId,
    kind: 'paid',
    amount: p.amount,
  }));
  const owes: LedgerEntry[] = shares
    .filter((s) => s.amount.amountMinor !== 0)
    .map((s) => ({
      expenseId: expense.expenseId,
      tripId: expense.tripId,
      memberId: s.memberId,
      kind: 'owes',
      amount: s.amount,
    }));
  return [...paid, ...owes];
}

/**
 * Entries for a whole list of expenses. Throws `duplicate` if two expenses
 * share an `expenseId` (the same expense logged twice must never double-count).
 * `ctx` may be a function so each expense can carry its own exclude-universe
 * (the roster of its activity).
 */
export function buildLedger(
  expenses: readonly Expense[],
  ctx: SplitContext | ((expense: Expense) => SplitContext),
): LedgerEntry[] {
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  for (const expense of expenses) {
    if (seen.has(expense.expenseId)) {
      throw new TravError('duplicate', `expense ${expense.expenseId} appears twice`, {
        expenseId: expense.expenseId,
      });
    }
    seen.add(expense.expenseId);
    entries.push(...buildLedgerEntries(expense, typeof ctx === 'function' ? ctx(expense) : ctx));
  }
  return entries;
}

/** Sum of every `logged` expense; `undone` ones are skipped. Throws on a currency mismatch. */
export function totalSpent(expenses: readonly Expense[], currency: CurrencyCode): Money {
  return sum(
    expenses.filter((e) => e.status !== 'undone').map((e) => e.amount),
    currency,
  );
}
