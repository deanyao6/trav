/**
 * Family tab and minor-share folding (T-058, VOICE §8 "Money").
 *
 * Two rules, both applied AFTER the split math (`computeShares` is unchanged,
 * so every remainder rule from T-003 still holds; folding only ever adds whole
 * minor units together, it never re-rounds):
 *
 * 1. Minor folding. A minor (`safety.isMinor(member, now)`: birthDate under 18
 *    OR `ageBand === 'under18'`) is never charged and never appears as a debtor
 *    or creditor. Their share of every expense is added to their guardian's
 *    (`Member.guardianMemberId`), and anything they paid is credited to the
 *    guardian. Balances and transfers are computed over the non-minor members
 *    only, so a minor can never be listed. The UI shows "Lily (under Dad)" from
 *    `TripLedger.folded`.
 *
 *    No valid guardian (missing, unknown id, the minor themself, or another
 *    minor): we REFUSE rather than guess. Charging the payer or an arbitrary
 *    adult would silently put a child's costs on someone who never agreed to
 *    it. The refusal is lazy: it throws only when the minor actually has a
 *    share or a payment to fold, so a guardian-less minor who spent nothing
 *    does not block settle-up. Error: `TravError('invalid_argument')` with
 *    `details.reason === 'minor_without_guardian'` (see
 *    `isMinorWithoutGuardianError`).
 *
 * 2. Family tab (`Trip.familyTab === true`). All expenses go into one pot:
 *    nobody owes anybody, every balance is zero and settle-up is empty. The
 *    expenses are still validated (bad splits and duplicate ids still throw),
 *    and totals, per-category totals and "who fronted what" (folded) still work.
 *
 * Non-family trips with no minors produce exactly what
 * `buildLedger` → `computeBalances` → `settle` produce on their own.
 */
import type { CurrencyCode, IsoDateTime, MemberId } from '../primitives.js';
import type { Money } from '../money.js';
import { money } from '../money.js';
import type {
  Balance,
  Expense,
  ExpenseCategory,
  LedgerEntry,
  Share,
  Transfer,
} from '../domain/expense.js';
import type { Member } from '../domain/group.js';
import type { Trip } from '../domain/trip.js';
import { TravError } from '../errors.js';
import { isMinor } from '../safety/minors.js';
import type { SplitContext } from './context.js';
import { assertUniqueMembers } from './context.js';
import { computeBalances } from './balances.js';
import { settleAfterPayments } from './settle.js';
import { buildLedger, totalSpent } from './splits.js';

// ---------- minor folding ----------

/** Who absorbs each minor's money. `null` = the minor has no valid guardian. */
export interface MinorFolding {
  /** Every minor in the group (at `now`), in member order. */
  readonly minors: readonly MemberId[];
  readonly guardianOf: ReadonlyMap<MemberId, MemberId | null>;
}

export const MINOR_WITHOUT_GUARDIAN = 'minor_without_guardian';

/** True for the error the fold functions throw when a minor with money to fold has no guardian. */
export function isMinorWithoutGuardianError(e: unknown): e is TravError {
  return e instanceof TravError && e.details?.['reason'] === MINOR_WITHOUT_GUARDIAN;
}

/**
 * Work out which members are minors at `now` and who their guardian is. A
 * guardian is valid only if it is another member of `members` who is not
 * themself a minor; otherwise the minor maps to `null` (fold functions throw
 * if such a minor has anything to fold). An inactive guardian (left the group)
 * still carries the minor: past expenses must keep balancing. Inactive minors
 * are still folded for the same reason. Throws `invalid_argument` on
 * duplicate member ids.
 */
export function minorFolding(members: readonly Member[], now: IsoDateTime): MinorFolding {
  assertUniqueMembers(
    members.map((m) => m.memberId),
    'members',
  );
  const byId = new Map(members.map((m) => [m.memberId, m] as const));
  const minorSet = new Set(members.filter((m) => isMinor(m, now)).map((m) => m.memberId));
  const guardianOf = new Map<MemberId, MemberId | null>();
  for (const m of members) {
    if (!minorSet.has(m.memberId)) continue;
    const g = m.guardianMemberId;
    const valid = g !== undefined && g !== m.memberId && byId.has(g) && !minorSet.has(g);
    guardianOf.set(m.memberId, valid ? g : null);
  }
  return { minors: members.map((m) => m.memberId).filter((id) => minorSet.has(id)), guardianOf };
}

/** The member who carries `memberId`'s money: their guardian for a minor, else themself. */
function carrier(memberId: MemberId, folding: MinorFolding): MemberId {
  if (!folding.guardianOf.has(memberId)) return memberId;
  const guardian = folding.guardianOf.get(memberId) ?? null;
  if (guardian === null) {
    throw new TravError(
      'invalid_argument',
      `member ${memberId} is a minor with no valid guardian; set guardianMemberId before logging their share`,
      { reason: MINOR_WITHOUT_GUARDIAN, memberId },
    );
  }
  return guardian;
}

/**
 * Fold minors' shares into their guardians'. Returns one share per carrier, in
 * `memberOrder`, with Σ unchanged (integer addition only, no re-rounding). A
 * guardian who was not a participant gains a share equal to the minor's.
 * Adults' zero shares stay listed (as in `computeShares`); a minor's zero share
 * is dropped and adds no row for their guardian. A minor with a non-zero share
 * and no valid guardian throws `minor_without_guardian`.
 */
export function foldShares(
  shares: readonly Share[],
  folding: MinorFolding,
  memberOrder: readonly MemberId[],
): Share[] {
  const first = shares[0];
  if (first === undefined) return [];
  const currency = first.amount.currency;
  const total = new Map<MemberId, number>();
  for (const s of shares) {
    if (s.amount.currency !== currency) {
      throw new TravError('currency_mismatch', `foldShares: ${s.amount.currency} vs ${currency}`, {
        memberId: s.memberId,
        left: s.amount.currency,
        right: currency,
      });
    }
    // A minor who owes exactly nothing has nothing to move: drop the row without
    // touching the guardian (a non-participant guardian must not appear with a
    // 0 share, and a guardian-less minor must not throw over nothing).
    if (folding.guardianOf.has(s.memberId) && s.amount.amountMinor === 0) continue;
    const to = carrier(s.memberId, folding);
    total.set(to, (total.get(to) ?? 0) + s.amount.amountMinor);
  }
  const ordered = memberOrder.filter((id) => total.has(id));
  if (ordered.length !== total.size) {
    const missing = [...total.keys()].find((id) => !memberOrder.includes(id));
    throw new TravError('invalid_argument', `foldShares: ${String(missing)} not in memberOrder`, {
      memberId: missing,
    });
  }
  return ordered.map((memberId) => ({
    memberId,
    amount: money(total.get(memberId) ?? 0, currency),
  }));
}

/**
 * Re-attribute ledger entries: a minor's `paid` and `owes` rows move to their
 * guardian. Rows that land on the same (expense, member, kind) are merged so
 * the "one row per participant per expense" shape of `buildLedgerEntries`
 * holds; merged `owes` rows that net to zero are dropped (as
 * `buildLedgerEntries` drops zero shares). Order: first occurrence.
 * Throws `minor_without_guardian` for a guardian-less minor with any row.
 */
export function foldLedgerEntries(
  entries: readonly LedgerEntry[],
  folding: MinorFolding,
): LedgerEntry[] {
  const merged = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const memberId = carrier(e.memberId, folding);
    const key = `${e.expenseId}\u0000${memberId}\u0000${e.kind}`;
    const prev = merged.get(key);
    if (prev === undefined) {
      merged.set(key, { ...e, memberId });
      continue;
    }
    if (prev.amount.currency !== e.amount.currency) {
      throw new TravError(
        'currency_mismatch',
        `ledger entry ${e.expenseId}: ${e.amount.currency} vs ${prev.amount.currency}`,
        { expenseId: e.expenseId, left: e.amount.currency, right: prev.amount.currency },
      );
    }
    merged.set(key, {
      ...prev,
      amount: money(prev.amount.amountMinor + e.amount.amountMinor, prev.amount.currency),
    });
  }
  return [...merged.values()].filter((e) => !(e.kind === 'owes' && e.amount.amountMinor === 0));
}

// ---------- trip view ----------

export interface CategoryTotal {
  readonly category: ExpenseCategory;
  readonly amount: Money;
}

/**
 * Per-category totals of `logged` expenses (undone skipped), largest first,
 * ties by category name. Categories with nothing spent are omitted. Throws
 * `currency_mismatch` if an expense is not in `currency`.
 */
export function spendByCategory(
  expenses: readonly Expense[],
  currency: CurrencyCode,
): CategoryTotal[] {
  const totals = new Map<ExpenseCategory, number>();
  for (const e of expenses) {
    if (e.status === 'undone') continue;
    const amount = totalSpent([e], currency); // validates currency + integer
    totals.set(e.category, (totals.get(e.category) ?? 0) + amount.amountMinor);
  }
  return [...totals.entries()]
    .filter(([, minor]) => minor !== 0)
    .sort(([ca, a], [cb, b]) => b - a || (ca < cb ? -1 : ca > cb ? 1 : 0))
    .map(([category, minor]) => ({ category, amount: money(minor, currency) }));
}

export interface TripLedgerInput {
  readonly trip: Pick<Trip, 'familyTab' | 'currency'>;
  /**
   * Every group member (minors included; ages are read here). Output order
   * follows `ctx.memberOrder` when `ctx` is static, else this array's order.
   */
  readonly members: readonly Member[];
  readonly expenses: readonly Expense[];
  /**
   * Split context for each expense, as for `buildLedger`. Required unless
   * `entries` is given.
   */
  readonly ctx?: SplitContext | ((expense: Expense) => SplitContext);
  /**
   * Ledger entries already built for `expenses` (the rows persisted at log
   * time, T-065), used instead of re-running `buildLedger(expenses, ctx)`: they
   * are the source of truth for who paid and owes what, and `expenses` is only
   * used for the totals. Output order is then `members` order. Every entry must
   * name a member of `members`.
   */
  readonly entries?: readonly LedgerEntry[];
  /** Age is evaluated at this instant (`safety.isMinor`). */
  readonly now: IsoDateTime;
  /** Small-amount floor passed to `settle` (T-049). Ignored for a family tab. */
  readonly floorMinor?: number;
  /**
   * Transfers members said they paid (T-141, `SettlementPayment`). Applied to
   * the balances before settling, so `balances` is what is still owed and
   * `transfers` is what is left to pay. A minor named here is carried by their
   * guardian (minors never pay or receive). Ignored for a family tab.
   */
  readonly payments?: readonly Transfer[];
}

export interface TripLedger {
  readonly mode: 'split' | 'family_tab';
  /** One row per NON-minor member, in member order. All zero for a family tab. */
  readonly balances: Balance[];
  /** Minimal settle-up of what is still owed. Always empty for a family tab; never names a minor. */
  readonly transfers: Transfer[];
  /** `payments` as applied (minors folded onto guardians), input order. Empty for a family tab. */
  readonly paid: Transfer[];
  /** Σ logged expenses. */
  readonly total: Money;
  readonly byCategory: CategoryTotal[];
  /** Who put money in (minors' payments credited to their guardian), member order, > 0 only. */
  readonly frontedBy: Share[];
  /** Minors and the guardian who carries them ("Lily (under Dad)"), member order. */
  readonly folded: readonly { readonly minor: MemberId; readonly guardian: MemberId | null }[];
}

/**
 * Order for balances, settle-up tie-breaks and `frontedBy`. With a static
 * `SplitContext` this is `ctx.memberOrder` (the same order the raw
 * `computeBalances` → `settle` chain uses), whatever order `members` came in;
 * members absent from `ctx.memberOrder` are appended in `members` order. With a
 * per-expense context function there is no single order, so `members` order is used.
 */
function balanceOrder(
  members: readonly Member[],
  ctx: SplitContext | ((expense: Expense) => SplitContext) | undefined,
): MemberId[] {
  const ids = members.map((m) => m.memberId);
  if (ctx === undefined || typeof ctx === 'function') return ids;
  const present = new Set(ids);
  const inCtx = ctx.memberOrder.filter((id) => present.has(id));
  const listed = new Set(inCtx);
  return [...inCtx, ...ids.filter((id) => !listed.has(id))];
}

/**
 * The trip's money picture with both T-058 rules applied (see the module doc).
 * Throws what `buildLedger` throws (invalid split, `duplicate` expense id,
 * currency mismatch) and `minor_without_guardian` when a guardian-less minor
 * has a share or payment.
 */
export function tripLedger(input: TripLedgerInput): TripLedger {
  const { trip, members, expenses, ctx, now } = input;
  const currency = trip.currency;
  const folding = minorFolding(members, now);
  let raw: readonly LedgerEntry[];
  if (input.entries !== undefined) raw = input.entries;
  else if (ctx !== undefined) raw = buildLedger(expenses, ctx);
  else throw new TravError('invalid_argument', 'tripLedger: pass ctx or entries');
  const entries = foldLedgerEntries(raw, folding);
  const order = balanceOrder(members, input.entries === undefined ? ctx : undefined).filter(
    (id) => !folding.guardianOf.has(id),
  );
  if (order.length === 0) {
    throw new TravError(
      'invalid_argument',
      'tripLedger: the group has no adult member to carry the tab',
    );
  }

  const paid = new Map<MemberId, number>();
  for (const e of entries) {
    if (e.kind === 'paid') paid.set(e.memberId, (paid.get(e.memberId) ?? 0) + e.amount.amountMinor);
  }
  const balances = computeBalances(entries, currency, order);
  const frontedBy: Share[] = order
    .filter((id) => (paid.get(id) ?? 0) > 0)
    .map((memberId) => ({ memberId, amount: money(paid.get(memberId) ?? 0, currency) }));
  const common = {
    total: totalSpent(expenses, currency),
    byCategory: spendByCategory(expenses, currency),
    frontedBy,
    folded: folding.minors.map((minor) => ({
      minor,
      guardian: folding.guardianOf.get(minor) ?? null,
    })),
  };

  if (trip.familyTab) {
    return {
      mode: 'family_tab',
      balances: order.map((memberId) => ({ memberId, net: money(0, currency) })),
      transfers: [],
      paid: [],
      ...common,
    };
  }
  // T-141: what members said they paid, minors carried by their guardian.
  // A payment that folds into a self-transfer (a minor paying their own
  // guardian) or names someone off the tab moves nothing: skipped, never thrown,
  // so one odd row cannot break every reader (T-141 r2).
  const listed = new Set(order);
  const paidTransfers = (input.payments ?? [])
    .map((t) => ({
      from: carrier(t.from, folding),
      to: carrier(t.to, folding),
      amount: t.amount,
    }))
    .filter((t) => t.from !== t.to && listed.has(t.from) && listed.has(t.to));
  const floorMinor = input.floorMinor;
  const { owing, open } = settleAfterPayments(
    balances,
    paidTransfers,
    floorMinor === undefined ? undefined : { floorMinor },
  );
  return {
    mode: 'split',
    balances: owing,
    transfers: open,
    paid: paidTransfers,
    ...common,
  };
}
