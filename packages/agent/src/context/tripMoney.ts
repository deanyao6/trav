/**
 * The trip's money picture for the agent (T-065): one place that turns the
 * persisted expenses + ledger rows into balances and transfers via
 * `ledger.tripLedger` (T-058), so every reader (get_balances, the group
 * context, settle-up / recap / Wrapped inputs) gets the same VOICE §8 rules:
 *
 * - a minor is never a debtor or creditor: their shares and payments fold into
 *   their guardian (`Member.guardianMemberId`);
 * - a family-tab trip (`Trip.familyTab`) has zero balances and no transfers.
 *
 * The persisted ledger rows are the source of truth (they carry the split as it
 * was at log time, e.g. an attendance-scoped "everyone"), so they are passed to
 * `tripLedger` as `entries` rather than re-split.
 *
 * A minor with money on the tab and no valid guardian makes `tripLedger` refuse
 * (`minor_without_guardian`: never guess which adult pays for a child). That is
 * caught here and returned as `needs_guardian` (which minors, who to ask), so
 * callers ask the trip leads (VOICE §8) instead of throwing.
 */
import type { Expense, IsoDateTime, LedgerEntry, Member, MemberId, Money, Trip } from '@trav/core';
import { ledger } from '@trav/core';

export type TripLedgerView = ReturnType<typeof ledger.tripLedger>;

export interface TripMoneyInput {
  readonly trip: Pick<Trip, 'familyTab' | 'currency'>;
  /** Every group member, minors and people who left included (an inactive guardian still carries a minor). */
  readonly members: readonly Member[];
  readonly expenses: readonly Expense[];
  /** The persisted ledger rows for `expenses`. */
  readonly entries: readonly LedgerEntry[];
  readonly now: IsoDateTime;
}

export type TripMoney =
  | { readonly kind: 'ok'; readonly ledger: TripLedgerView }
  | {
      readonly kind: 'needs_guardian';
      /** Minors with money on the tab and no valid guardian, member order. */
      readonly minors: readonly MemberId[];
      /** Who to ask: active adult leads/guardians, member order (empty = ask the group). */
      readonly askMemberIds: readonly MemberId[];
      readonly total: Money;
    };

export function tripMoney(input: TripMoneyInput): TripMoney {
  try {
    return {
      kind: 'ok',
      ledger: ledger.tripLedger({
        trip: input.trip,
        members: input.members,
        expenses: input.expenses,
        entries: input.entries,
        now: input.now,
      }),
    };
  } catch (e) {
    if (!ledger.isMinorWithoutGuardianError(e)) throw e;
    const folding = ledger.minorFolding(input.members, input.now);
    const withRows = new Set(input.entries.map((x) => x.memberId));
    const found = folding.minors.filter(
      (id) => folding.guardianOf.get(id) === null && withRows.has(id),
    );
    const fromError = e.details?.['memberId'];
    const minors = found.length > 0 ? found : typeof fromError === 'string' ? [fromError] : [];
    const askMemberIds = input.members
      .filter(
        (m) =>
          (m.role === 'lead' || m.role === 'guardian') &&
          m.active &&
          m.leftAt === undefined &&
          !folding.guardianOf.has(m.memberId),
      )
      .map((m) => m.memberId);
    return {
      kind: 'needs_guardian',
      minors,
      askMemberIds,
      total: ledger.totalSpent(input.expenses, input.trip.currency),
    };
  }
}
