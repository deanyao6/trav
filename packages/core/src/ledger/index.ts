/**
 * Ledger, splits and settlement (T-003). Pure functions; throw `TravError` on
 * invalid input, never on arithmetic (every split sums to the total exactly).
 */
import type { CurrencyCode, MemberId } from '../primitives.js';
import type { Money } from '../money.js';
import type {
  Balance,
  Expense,
  LedgerEntry,
  Share,
  SplitSpec,
  Transfer,
} from '../domain/expense.js';
import { notImplemented } from '../errors.js';

export interface SplitContext {
  /** Group member order; shares and remainders are assigned deterministically in this order. */
  readonly memberOrder: readonly MemberId[];
  /** For `exclude`: the universe is the roster of the linked activity, else all active members. */
  readonly participantsUniverse: readonly MemberId[];
}

/** Throws `invalid_argument` if payers don't sum, participants unknown, amounts non-positive, etc. */
export function validateExpense(expense: Expense, ctx: SplitContext): void {
  return notImplemented(`validateExpense(${expense.expenseId}, ${ctx.memberOrder.length})`);
}

/** Who ends up in the split for a spec (after exclude/roster resolution), in member order. */
export function resolveParticipants(split: SplitSpec, ctx: SplitContext): MemberId[] {
  return notImplemented(`resolveParticipants(${split.method}, ${ctx.memberOrder.length})`);
}

/**
 * Per-member shares for one expense. Σ shares === expense.amount to the minor
 * unit. Itemized: claimed lines go to claimants; unclaimed lines split equally
 * among participants; tax/tip/service/fee lines are allocated pro-rata to each
 * member's item subtotal. Remainder minor units go to the payer first.
 */
export function computeShares(expense: Expense, ctx: SplitContext): Share[] {
  return notImplemented(`computeShares(${expense.expenseId}, ${ctx.memberOrder.length})`);
}

/** `paid` entries for payers, `owes` entries for participants. */
export function buildLedgerEntries(expense: Expense, ctx: SplitContext): LedgerEntry[] {
  return notImplemented(`buildLedgerEntries(${expense.expenseId}, ${ctx.memberOrder.length})`);
}

/** Net per member (positive = is owed). Includes every member in `memberOrder`, zeros included. Σ = 0. */
export function computeBalances(
  entries: readonly LedgerEntry[],
  currency: CurrencyCode,
  memberOrder: readonly MemberId[],
): Balance[] {
  return notImplemented(`computeBalances(${entries.length}, ${currency}, ${memberOrder.length})`);
}

/**
 * Minimal transfer set that clears all balances: ≤ n−1 transfers, greedy
 * largest-debtor-to-largest-creditor, deterministic tie-break by member order.
 * Amounts below `floorMinor` are netted away (T-049 small-amount floor).
 */
export function settle(
  balances: readonly Balance[],
  options?: { readonly floorMinor?: number },
): Transfer[] {
  return notImplemented(`settle(${balances.length}, ${options?.floorMinor ?? 0})`);
}

export function totalSpent(expenses: readonly Expense[], currency: CurrencyCode): Money {
  return notImplemented(`totalSpent(${expenses.length}, ${currency})`);
}

/** Transfers needed after a late expense, given transfers already marked paid (T-049). */
export function incrementalTransfers(
  balances: readonly Balance[],
  alreadyPaid: readonly Transfer[],
): Transfer[] {
  return notImplemented(`incrementalTransfers(${balances.length}, ${alreadyPaid.length})`);
}
