/**
 * Test helpers for the ledger suite. Not a test file itself (no `.test.ts`),
 * never imported by production code.
 *
 * Barcelona (flagship, MOTIVATION.md): six college friends. Names follow the
 * VOICE.md examples. Fixture data is defined inline until `fixtures/groups/`
 * exists (synthetic-data agent).
 */
import { expect } from 'vitest';
import type { CurrencyCode, MemberId } from '../primitives.js';
import { money } from '../money.js';
import type { Balance, Expense, LineItem, SplitSpec, Transfer } from '../domain/expense.js';
import { TravError } from '../errors.js';
import type { SplitContext } from './context.js';

export const DEAN: MemberId = 'mem_dean';
export const CHASE: MemberId = 'mem_chase';
export const CROWLEY: MemberId = 'mem_crowley';
export const HENRY: MemberId = 'mem_henry';
export const PIOTR: MemberId = 'mem_piotr';
export const ARJUN: MemberId = 'mem_arjun';

/** Group member order for Barcelona. Remainders and ties follow this order. */
export const BARCELONA_MEMBERS: readonly MemberId[] = [DEAN, CHASE, CROWLEY, HENRY, PIOTR, ARJUN];

export const BARCELONA_CTX: SplitContext = {
  memberOrder: BARCELONA_MEMBERS,
  participantsUniverse: BARCELONA_MEMBERS,
};

export const eur = (n: number) => money(n, 'EUR');

let counter = 0;

export function resetCounter(): void {
  counter = 0;
}

/** A logged chat expense paid by Dean, split equally among all six unless overridden. */
export function expense(
  overrides: Partial<Expense> & { amount?: Expense['amount'] } = {},
): Expense {
  counter += 1;
  const amount = overrides.amount ?? eur(8400);
  const base: Expense = {
    expenseId: `exp_${String(counter).padStart(6, '0')}`,
    groupId: 'grp_barcelona',
    tripId: 'trip_barcelona',
    description: 'dinner',
    category: 'food',
    amount,
    paidBy: [{ memberId: DEAN, amount }],
    split: { method: 'equal', participants: BARCELONA_MEMBERS },
    source: 'chat',
    sourceRef: { kind: 'message', id: `msg_${String(counter).padStart(6, '0')}` },
    occurredAt: '2026-03-14T21:40:00+01:00',
    createdAt: '2026-03-14T21:41:00+01:00',
    createdBy: DEAN,
    status: 'logged',
  };
  return { ...base, ...overrides };
}

export function line(
  lineId: string,
  amountMinor: number,
  claimedBy: readonly MemberId[] = [],
  kind: LineItem['kind'] = 'item',
  currency: CurrencyCode = 'EUR',
): LineItem {
  return { lineId, label: lineId, amount: money(amountMinor, currency), claimedBy, kind };
}

export function itemized(
  participants: readonly MemberId[],
  lineItems: readonly LineItem[],
): SplitSpec {
  return { method: 'itemized', participants, lineItems };
}

export function balance(memberId: MemberId, netMinor: number, currency = 'EUR'): Balance {
  return { memberId, net: money(netMinor, currency) };
}

/** Apply transfers to balances and return the resulting nets (minor units) per member. */
export function applyTransfers(
  balances: readonly Balance[],
  transfers: readonly Transfer[],
): Map<MemberId, number> {
  const net = new Map(balances.map((b) => [b.memberId, b.net.amountMinor] as const));
  for (const t of transfers) {
    net.set(t.from, (net.get(t.from) ?? 0) + t.amount.amountMinor);
    net.set(t.to, (net.get(t.to) ?? 0) - t.amount.amountMinor);
  }
  return net;
}

export function minors(parts: readonly { readonly amount: { readonly amountMinor: number } }[]) {
  return parts.map((p) => p.amount.amountMinor);
}

export function expectTravError(fn: () => unknown, code: TravError['code']): TravError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TravError);
  expect((caught as TravError).code).toBe(code);
  return caught as TravError;
}
