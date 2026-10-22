import { beforeEach, describe, expect, it } from 'vitest';
import { money } from '../money.js';
import type { LedgerEntry } from '../domain/expense.js';
import { computeBalances } from './balances.js';
import { buildLedger, totalSpent } from './splits.js';
import {
  BARCELONA_CTX,
  BARCELONA_MEMBERS,
  DEAN,
  HENRY,
  MAYA,
  SAM,
  eur,
  expectTravError,
  expense,
  resetCounter,
} from './testkit.js';

beforeEach(resetCounter);

const entry = (
  memberId: string,
  kind: LedgerEntry['kind'],
  amountMinor: number,
  currency = 'EUR',
): LedgerEntry => ({
  expenseId: 'exp_x',
  tripId: 'trip_barcelona',
  memberId,
  kind,
  amount: money(amountMinor, currency),
});

describe('computeBalances', () => {
  it('lists every member in order, zeros included, and nets paid minus owes', () => {
    const balances = computeBalances(
      [entry(DEAN, 'paid', 3000), entry(DEAN, 'owes', 1000), entry(MAYA, 'owes', 2000)],
      'EUR',
      [DEAN, MAYA, SAM],
    );
    expect(balances).toEqual([
      { memberId: DEAN, net: eur(2000) },
      { memberId: MAYA, net: eur(-2000) },
      { memberId: SAM, net: eur(0) },
    ]);
  });

  it('is all zeros with no entries', () => {
    expect(computeBalances([], 'EUR', [DEAN, MAYA]).map((b) => b.net.amountMinor)).toEqual([0, 0]);
  });

  it('rejects unknown members, foreign currencies, an empty or duplicated member order', () => {
    expectTravError(
      () => computeBalances([entry('mem_ghost', 'paid', 1)], 'EUR', [DEAN]),
      'invalid_argument',
    );
    expectTravError(
      () => computeBalances([entry(DEAN, 'paid', 1, 'USD')], 'EUR', [DEAN]),
      'currency_mismatch',
    );
    expectTravError(() => computeBalances([], 'EUR', []), 'invalid_argument');
    expectTravError(() => computeBalances([], 'EUR', [DEAN, DEAN]), 'invalid_argument');
  });

  it('does not throw on a partial ledger (settle enforces Σ = 0)', () => {
    const balances = computeBalances([entry(DEAN, 'paid', 500)], 'EUR', [DEAN, MAYA]);
    expect(balances[0]?.net.amountMinor).toBe(500);
  });
});

describe('buildLedger', () => {
  it('rejects a duplicate expense id so nothing is ever counted twice', () => {
    const e = expense();
    const copy = { ...e, description: 'same expense, retried' };
    expectTravError(() => buildLedger([e, copy], BARCELONA_CTX), 'duplicate');
  });

  it('skips undone expenses and accepts a per-expense context', () => {
    const live = expense({ amount: eur(1200) });
    const undone = expense({ amount: eur(99900), status: 'undone' });
    const entries = buildLedger([live, undone], (x) =>
      x.expenseId === live.expenseId
        ? { memberOrder: BARCELONA_MEMBERS, participantsUniverse: [DEAN, MAYA, SAM] }
        : BARCELONA_CTX,
    );
    expect(entries.every((x) => x.expenseId === live.expenseId)).toBe(true);
    const balances = computeBalances(entries, 'EUR', BARCELONA_MEMBERS);
    expect(balances.reduce((acc, b) => acc + b.net.amountMinor, 0)).toBe(0);
    expect(balances.find((b) => b.memberId === HENRY)?.net.amountMinor).toBe(-200);
  });
});

describe('totalSpent', () => {
  it('sums logged expenses only and throws on a currency mismatch', () => {
    const total = totalSpent(
      [expense({ amount: eur(100) }), expense({ amount: eur(250) }), expense({ status: 'undone' })],
      'EUR',
    );
    expect(total).toEqual(eur(350));
    expect(totalSpent([], 'EUR')).toEqual(eur(0));
    expectTravError(() => totalSpent([expense({ amount: eur(100) })], 'USD'), 'currency_mismatch');
  });
});
