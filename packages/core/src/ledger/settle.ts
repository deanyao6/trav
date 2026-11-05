/**
 * Settlement: turn net balances into a small, deterministic list of transfers.
 */
import type { MemberId } from '../primitives.js';
import { money } from '../money.js';
import type { Balance, Transfer } from '../domain/expense.js';
import { TravError } from '../errors.js';
import { assertUniqueMembers } from './context.js';

interface Party {
  readonly index: number; // position in `balances` = member order
  readonly memberId: MemberId;
  remaining: number; // always > 0 while listed
}

/** Largest remaining first; ties by member order. */
function pickMax(parties: readonly Party[]): Party {
  let best = parties[0];
  if (best === undefined) {
    throw new TravError('invariant_violation', 'pickMax on empty list');
  }
  for (const p of parties) {
    if (p.remaining > best.remaining || (p.remaining === best.remaining && p.index < best.index)) {
      best = p;
    }
  }
  return best;
}

function remove(parties: Party[], party: Party): void {
  const i = parties.indexOf(party);
  if (i >= 0) parties.splice(i, 1);
}

function assertBalances(balances: readonly Balance[]): string {
  const first = balances[0];
  if (first === undefined) return '';
  const currency = first.net.currency;
  assertUniqueMembers(
    balances.map((b) => b.memberId),
    'balances',
  );
  let total = 0;
  for (const b of balances) {
    if (b.net.currency !== currency) {
      throw new TravError('currency_mismatch', `settle: ${b.net.currency} vs ${currency}`, {
        memberId: b.memberId,
        left: b.net.currency,
        right: currency,
      });
    }
    if (!Number.isSafeInteger(b.net.amountMinor)) {
      throw new TravError('invalid_argument', `settle: non-integer balance for ${b.memberId}`, {
        memberId: b.memberId,
      });
    }
    total += b.net.amountMinor;
  }
  if (total !== 0) {
    throw new TravError('invariant_violation', `balances must sum to zero, got ${total}`, {
      totalMinor: total,
    });
  }
  return currency;
}

/**
 * Minimal transfer set that clears all balances: ≤ n−1 transfers, greedy
 * largest-debtor-to-largest-creditor, deterministic tie-break by member order
 * (the order of `balances`, which `computeBalances` emits in member order).
 * Output is sorted by debtor then creditor, both in member order, so the
 * settle-up card reads one debtor at a time (VOICE §4.6 B).
 *
 * `floorMinor` (T-049 small-amount floor, default 0): balances and transfers
 * smaller than the floor are forgiven rather than emitted. With a floor > 0 the
 * result may leave residuals below the floor; with 0 it clears every balance.
 *
 * Throws `invariant_violation` if balances don't sum to zero.
 */
export function settle(
  balances: readonly Balance[],
  options?: { readonly floorMinor?: number },
): Transfer[] {
  const floor = options?.floorMinor ?? 0;
  if (!Number.isSafeInteger(floor) || floor < 0) {
    throw new TravError('invalid_argument', `floorMinor must be a non-negative integer`, {
      floorMinor: floor,
    });
  }
  const currency = assertBalances(balances);
  if (balances.length === 0) return [];

  const debtors: Party[] = [];
  const creditors: Party[] = [];
  balances.forEach((b, index) => {
    const magnitude = Math.abs(b.net.amountMinor);
    if (magnitude === 0 || magnitude < floor) return;
    const party: Party = { index, memberId: b.memberId, remaining: magnitude };
    if (b.net.amountMinor < 0) debtors.push(party);
    else creditors.push(party);
  });

  const transfers: { from: Party; to: Party; amountMinor: number }[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    const debtor = pickMax(debtors);
    const creditor = pickMax(creditors);
    // Both parties carry at least `floor`, so every emitted transfer is >= floor.
    const amountMinor = Math.min(debtor.remaining, creditor.remaining);
    transfers.push({ from: debtor, to: creditor, amountMinor });
    // Whichever side is exhausted (or whose residual is below the floor) drops out.
    debtor.remaining -= amountMinor;
    creditor.remaining -= amountMinor;
    if (debtor.remaining === 0 || debtor.remaining < floor) remove(debtors, debtor);
    if (creditor.remaining === 0 || creditor.remaining < floor) remove(creditors, creditor);
  }

  transfers.sort((a, b) => a.from.index - b.from.index || a.to.index - b.to.index);
  return transfers.map((t) => ({
    from: t.from.memberId,
    to: t.to.memberId,
    amount: money(t.amountMinor, currency),
  }));
}

/**
 * Transfers still needed given transfers already marked paid (T-049): the
 * balances after `applyPayments`, settled. Over-payments show up as a transfer back.
 */
export function incrementalTransfers(
  balances: readonly Balance[],
  alreadyPaid: readonly Transfer[],
): Transfer[] {
  return settle(applyPayments(balances, alreadyPaid));
}

/**
 * Settle-up with payments already marked paid, keeping the plan stable (T-141
 * r2): the plan is `settle(balances)` over the balances BEFORE any payment, so
 * while the expenses don't change, ticking one row never reroutes anyone
 * else's. Plan rows exactly matched by a payment (from, to, amount) drop out.
 * Payments matching no row (paid from an older card, before the tab moved)
 * leave a residue: it is settled on its own and netted per member pair into
 * the remaining rows ("Maya → Dean €25.70" less a €20.70 payment is
 * "Maya → Dean €5"). `owing` is the balances after every payment, and `open`
 * clears it exactly (floor 0). Output in member order, debtor then creditor.
 */
export function settleAfterPayments(
  balances: readonly Balance[],
  payments: readonly Transfer[],
  options?: { readonly floorMinor?: number },
): { readonly owing: Balance[]; readonly open: Transfer[] } {
  const owing = applyPayments(balances, payments);
  const plan = settle(balances, options);
  if (payments.length === 0) return { owing, open: plan };
  const remaining = [...plan];
  const unmatched: Transfer[] = [];
  for (const p of payments) {
    const i = remaining.findIndex(
      (t) => t.from === p.from && t.to === p.to && t.amount.amountMinor === p.amount.amountMinor,
    );
    if (i >= 0) remaining.splice(i, 1);
    else unmatched.push(p);
  }
  if (unmatched.length === 0) return { owing, open: remaining };

  const currency = balances[0]?.net.currency ?? '';
  const zero = balances.map((b) => ({ memberId: b.memberId, net: money(0, currency) }));
  const correction = settle(applyPayments(zero, unmatched), options);
  const index = new Map(balances.map((b, i) => [b.memberId, i] as const));
  const idx = (id: MemberId): number => index.get(id) ?? Number.MAX_SAFE_INTEGER;
  // Signed amount per unordered pair: + means lower-index member pays the higher one.
  const pairs = new Map<string, { a: MemberId; b: MemberId; minor: number }>();
  for (const t of [...remaining, ...correction]) {
    const [a, b, sign] = idx(t.from) < idx(t.to) ? [t.from, t.to, 1] : [t.to, t.from, -1];
    const key = `${a}|${b}`;
    const row = pairs.get(key) ?? { a, b, minor: 0 };
    row.minor += sign * t.amount.amountMinor;
    pairs.set(key, row);
  }
  const open: Transfer[] = [];
  for (const { a, b, minor } of pairs.values()) {
    if (minor === 0) continue;
    open.push(
      minor > 0
        ? { from: a, to: b, amount: money(minor, currency) }
        : { from: b, to: a, amount: money(-minor, currency) },
    );
  }
  open.sort((x, y) => idx(x.from) - idx(y.from) || idx(x.to) - idx(y.to));
  return { owing, open };
}

/**
 * Balances after transfers already marked paid (T-049, T-141): each paid
 * transfer moves the debtor's balance up and the creditor's down. Same member
 * order as `balances`; still sums to zero. Throws on an unknown member, a
 * self-payment, another currency or a non-positive amount.
 */
export function applyPayments(
  balances: readonly Balance[],
  alreadyPaid: readonly Transfer[],
): Balance[] {
  const currency = assertBalances(balances);
  if (balances.length === 0) {
    if (alreadyPaid.length > 0) {
      throw new TravError('invalid_argument', 'alreadyPaid references members with no balance');
    }
    return [];
  }
  const net = new Map<MemberId, number>(balances.map((b) => [b.memberId, b.net.amountMinor]));
  for (const paid of alreadyPaid) {
    for (const id of [paid.from, paid.to]) {
      if (!net.has(id)) {
        throw new TravError('invalid_argument', `alreadyPaid: unknown member ${id}`, {
          memberId: id,
        });
      }
    }
    if (paid.from === paid.to) {
      throw new TravError('invalid_argument', `alreadyPaid: ${paid.from} cannot pay themselves`, {
        memberId: paid.from,
      });
    }
    if (paid.amount.currency !== currency) {
      throw new TravError(
        'currency_mismatch',
        `alreadyPaid: ${paid.amount.currency} vs ${currency}`,
        {
          left: paid.amount.currency,
          right: currency,
        },
      );
    }
    if (!Number.isSafeInteger(paid.amount.amountMinor) || paid.amount.amountMinor <= 0) {
      throw new TravError('invalid_argument', 'alreadyPaid: amount must be a positive integer', {
        from: paid.from,
        to: paid.to,
      });
    }
    net.set(paid.from, (net.get(paid.from) ?? 0) + paid.amount.amountMinor);
    net.set(paid.to, (net.get(paid.to) ?? 0) - paid.amount.amountMinor);
  }
  return balances.map((b) => ({
    memberId: b.memberId,
    net: money(net.get(b.memberId) ?? 0, currency),
  }));
}
