/**
 * Balances: fold ledger entries into one net position per member.
 */
import type { CurrencyCode, MemberId } from '../primitives.js';
import { money } from '../money.js';
import type { Balance, LedgerEntry } from '../domain/expense.js';
import { TravError } from '../errors.js';
import { assertUniqueMembers } from './context.js';

/**
 * Net per member (positive = is owed). Includes every member in `memberOrder`,
 * zeros included, in that order. Σ = 0 for a complete ledger; this function
 * does not enforce that (a partial entry list is a valid input), `settle` does.
 */
export function computeBalances(
  entries: readonly LedgerEntry[],
  currency: CurrencyCode,
  memberOrder: readonly MemberId[],
): Balance[] {
  if (memberOrder.length === 0) {
    throw new TravError('invalid_argument', 'memberOrder must not be empty');
  }
  assertUniqueMembers(memberOrder, 'memberOrder');
  const net = new Map<MemberId, number>(memberOrder.map((id) => [id, 0] as const));
  for (const entry of entries) {
    if (!net.has(entry.memberId)) {
      throw new TravError('invalid_argument', `ledger entry for unknown member ${entry.memberId}`, {
        memberId: entry.memberId,
        expenseId: entry.expenseId,
      });
    }
    if (entry.amount.currency !== currency) {
      throw new TravError(
        'currency_mismatch',
        `ledger entry ${entry.expenseId}: ${entry.amount.currency} vs ${currency}`,
        { expenseId: entry.expenseId, left: entry.amount.currency, right: currency },
      );
    }
    if (!Number.isSafeInteger(entry.amount.amountMinor)) {
      throw new TravError(
        'invalid_argument',
        `ledger entry ${entry.expenseId}: non-integer amount`,
        {
          expenseId: entry.expenseId,
        },
      );
    }
    const signed = entry.kind === 'paid' ? entry.amount.amountMinor : -entry.amount.amountMinor;
    net.set(entry.memberId, (net.get(entry.memberId) ?? 0) + signed);
  }
  return memberOrder.map((memberId) => ({
    memberId,
    net: money(net.get(memberId) ?? 0, currency),
  }));
}
