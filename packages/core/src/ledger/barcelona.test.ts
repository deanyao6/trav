/**
 * The Barcelona 6-person flagship (MOTIVATION.md, CLAUDE.md §8) as a ledger
 * fixture: Airbnb, Razzmatazz for 5 (Henry's sick), itemized dinner, weighted
 * taxi, a two-payer grocery run, exact-amount Barça tickets and an undone
 * expense. Member data is inline until `fixtures/groups/barcelona.json` lands.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Expense } from '../domain/expense.js';
import type { SplitContext } from './context.js';
import { computeBalances } from './balances.js';
import { settle } from './settle.js';
import { buildLedger, totalSpent } from './splits.js';
import {
  BARCELONA_CTX,
  BARCELONA_MEMBERS,
  DEAN,
  HENRY,
  PIOTR,
  CHASE,
  ARJUN,
  CROWLEY,
  applyTransfers,
  eur,
  expense,
  itemized,
  line,
  resetCounter,
} from './testkit.js';

const RAZZMATAZZ_ROSTER: SplitContext = {
  memberOrder: BARCELONA_MEMBERS,
  participantsUniverse: [DEAN, CHASE, CROWLEY, PIOTR, ARJUN],
};

function barcelonaExpenses(): Expense[] {
  resetCounter();
  return [
    expense({
      expenseId: 'exp_airbnb',
      description: 'airbnb, 3 nights',
      category: 'lodging',
      amount: eur(150000),
      paidBy: [{ memberId: DEAN, amount: eur(150000) }],
      split: { method: 'equal', participants: BARCELONA_MEMBERS },
    }),
    expense({
      expenseId: 'exp_razzmatazz',
      description: 'razzmatazz, 5 tickets',
      category: 'tickets',
      amount: eur(11250),
      paidBy: [{ memberId: DEAN, amount: eur(11250) }],
      split: { method: 'exclude', excluded: [HENRY] },
      source: 'booking',
      sourceRef: { kind: 'booking', id: 'bk_razzmatazz' },
      activityId: 'act_razzmatazz',
    }),
    expense({
      expenseId: 'exp_dinner',
      description: 'bar del pla',
      amount: eur(18400),
      paidBy: [{ memberId: PIOTR, amount: eur(18400) }],
      split: itemized(BARCELONA_MEMBERS, [
        line('food', 12600),
        line('drinks', 5800, [DEAN, CHASE, CROWLEY, HENRY, PIOTR]),
      ]),
    }),
    expense({
      expenseId: 'exp_taxi',
      description: 'taxi from the airport',
      category: 'transport',
      amount: eur(3200),
      paidBy: [{ memberId: CHASE, amount: eur(3200) }],
      split: {
        method: 'weighted',
        weights: [
          { memberId: CROWLEY, weight: 20 },
          { memberId: CHASE, weight: 12 },
        ],
      },
    }),
    expense({
      expenseId: 'exp_groceries',
      description: 'groceries',
      category: 'groceries',
      amount: eur(6117),
      paidBy: [
        { memberId: CROWLEY, amount: eur(4000) },
        { memberId: ARJUN, amount: eur(2117) },
      ],
      split: { method: 'equal', participants: BARCELONA_MEMBERS },
    }),
    expense({
      expenseId: 'exp_barca',
      description: 'barça tickets',
      category: 'tickets',
      amount: eur(30000),
      paidBy: [{ memberId: DEAN, amount: eur(30000) }],
      split: {
        method: 'exact',
        amounts: [
          { memberId: DEAN, amount: eur(10000) },
          { memberId: CHASE, amount: eur(10000) },
          { memberId: PIOTR, amount: eur(10000) },
        ],
      },
    }),
    expense({
      expenseId: 'exp_undone',
      description: 'drinks (logged by mistake)',
      category: 'drinks',
      amount: eur(5000),
      paidBy: [{ memberId: HENRY, amount: eur(5000) }],
      status: 'undone',
    }),
  ];
}

const contextFor = (e: Expense): SplitContext =>
  e.activityId === 'act_razzmatazz' ? RAZZMATAZZ_ROSTER : BARCELONA_CTX;

beforeEach(resetCounter);

describe('Barcelona (6 friends)', () => {
  it('Razzmatazz: split among the 5 who went, Henry never charged', () => {
    const entries = buildLedger(barcelonaExpenses(), contextFor);
    const razz = entries.filter((e) => e.expenseId === 'exp_razzmatazz');
    expect(razz.filter((e) => e.kind === 'owes').map((e) => e.memberId)).toEqual([
      DEAN,
      CHASE,
      CROWLEY,
      PIOTR,
      ARJUN,
    ]);
    expect(razz.filter((e) => e.kind === 'owes').every((e) => e.amount.amountMinor === 2250)).toBe(
      true,
    );
    expect(razz.some((e) => e.memberId === HENRY)).toBe(false);
  });

  it('balances reconcile to the cent and sum to zero', () => {
    const balances = computeBalances(
      buildLedger(barcelonaExpenses(), contextFor),
      'EUR',
      BARCELONA_MEMBERS,
    );
    expect(balances.map((b) => [b.memberId, b.net.amountMinor])).toEqual([
      [DEAN, 149720],
      [CHASE, -39529],
      [CROWLEY, -29530],
      [HENRY, -29279],
      [PIOTR, -23129],
      [ARJUN, -28253],
    ]);
    expect(balances.reduce((acc, b) => acc + b.net.amountMinor, 0)).toBe(0);
  });

  it('settles in ≤ 5 transfers, all to Dean, and everyone is square afterwards', () => {
    const balances = computeBalances(
      buildLedger(barcelonaExpenses(), contextFor),
      'EUR',
      BARCELONA_MEMBERS,
    );
    const transfers = settle(balances);
    expect(transfers).toEqual([
      { from: CHASE, to: DEAN, amount: eur(39529) },
      { from: CROWLEY, to: DEAN, amount: eur(29530) },
      { from: HENRY, to: DEAN, amount: eur(29279) },
      { from: PIOTR, to: DEAN, amount: eur(23129) },
      { from: ARJUN, to: DEAN, amount: eur(28253) },
    ]);
    expect(transfers.length).toBeLessThanOrEqual(BARCELONA_MEMBERS.length - 1);
    expect([...applyTransfers(balances, transfers).values()]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('total spent excludes the undone expense', () => {
    expect(totalSpent(barcelonaExpenses(), 'EUR')).toEqual(eur(218967));
  });

  it('already settled: a fresh trip, or one where everyone paid their share, needs 0 transfers', () => {
    expect(settle(computeBalances([], 'EUR', BARCELONA_MEMBERS))).toEqual([]);
    // Six friends each pay exactly their own €25 share of a shared €150 cab bill.
    const squared = expense({
      amount: eur(15000),
      paidBy: BARCELONA_MEMBERS.map((memberId) => ({ memberId, amount: eur(2500) })),
    });
    const balances = computeBalances(
      buildLedger([squared], BARCELONA_CTX),
      'EUR',
      BARCELONA_MEMBERS,
    );
    expect(balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    expect(settle(balances)).toEqual([]);
  });
});
