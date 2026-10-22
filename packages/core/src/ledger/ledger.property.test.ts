/**
 * fast-check properties (ARCHITECTURE §8):
 * - every split mode's shares sum to the total;
 * - balances over any ledger sum to zero;
 * - settlement clears every balance with ≤ n−1 transfers, never from a creditor.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate } from '../money.js';
import type { Balance, Expense, LineItem, SplitSpec } from '../domain/expense.js';
import { computeBalances } from './balances.js';
import { settle } from './settle.js';
import { buildLedger, computeShares, resolveParticipants } from './splits.js';
import {
  BARCELONA_CTX,
  BARCELONA_MEMBERS,
  applyTransfers,
  eur,
  expense,
  resetCounter,
} from './testkit.js';

const amountArb = fc.integer({ min: 1, max: 5_000_000 });
const membersArb = fc.shuffledSubarray([...BARCELONA_MEMBERS], { minLength: 1 });
const weightArb = fc.oneof(
  fc.integer({ min: 1, max: 12 }),
  fc.constantFrom(0.5, 1.5, 2.25, 0.1),
  fc.double({ min: 0.01, max: 50, noNaN: true, noDefaultInfinity: true }),
);

const payersArb = (amountMinor: number) =>
  fc
    .tuple(
      fc.shuffledSubarray([...BARCELONA_MEMBERS], { minLength: 1, maxLength: 3 }),
      fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 3, maxLength: 3 }),
    )
    .map(([payers, weights]) => {
      const parts = allocate(
        eur(amountMinor),
        payers.map((_, i) => weights[i] ?? 1),
      );
      const paidBy = payers
        .map((memberId, i) => ({ memberId, amount: parts[i] ?? eur(0) }))
        .filter((p) => p.amount.amountMinor > 0);
      // A tiny amount can leave a payer with 0; fall back to a single payer.
      return paidBy.length === payers.length
        ? paidBy
        : [{ memberId: payers[0] ?? BARCELONA_MEMBERS[0]!, amount: eur(amountMinor) }];
    });

const equalArb: fc.Arbitrary<SplitSpec> = membersArb.map((participants) => ({
  method: 'equal',
  participants,
}));

const excludeArb: fc.Arbitrary<SplitSpec> = fc
  .shuffledSubarray([...BARCELONA_MEMBERS], { maxLength: BARCELONA_MEMBERS.length - 1 })
  .map((excluded) => ({ method: 'exclude', excluded }));

const weightedArb: fc.Arbitrary<SplitSpec> = membersArb.chain((members) =>
  fc.array(weightArb, { minLength: members.length, maxLength: members.length }).map((weights) => ({
    method: 'weighted',
    weights: members.map((memberId, i) => ({ memberId, weight: weights[i] ?? 1 })),
  })),
);

const exactArb = (amountMinor: number): fc.Arbitrary<SplitSpec> =>
  membersArb.chain((members) =>
    fc
      .array(fc.integer({ min: 0, max: 10 }), {
        minLength: members.length,
        maxLength: members.length,
      })
      .filter((weights) => weights.some((w) => w > 0))
      .map((weights) => {
        const parts = allocate(eur(amountMinor), weights);
        return {
          method: 'exact',
          amounts: members.map((memberId, i) => ({ memberId, amount: parts[i] ?? eur(0) })),
        };
      }),
  );

const KINDS: LineItem['kind'][] = ['tax', 'tip', 'service', 'fee', 'discount'];

/** Itemized spec plus the total its lines imply (always > 0). */
const itemizedArb: fc.Arbitrary<{ split: SplitSpec; amountMinor: number }> = membersArb.chain(
  (participants) =>
    fc
      .tuple(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: 50_000 }),
            fc.shuffledSubarray(participants, { maxLength: participants.length }),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        fc.array(
          fc.tuple(
            fc.constantFrom(...KINDS),
            fc.integer({ min: 0, max: 5_000 }),
            fc.boolean(),
            fc.shuffledSubarray(participants, { minLength: 1, maxLength: participants.length }),
          ),
          { maxLength: 4 },
        ),
      )
      .map(([items, adjustments]) => {
        const lineItems: LineItem[] = [
          ...items.map(([amountMinor, claimedBy], i) => ({
            lineId: `item-${i}`,
            label: `item ${i}`,
            amount: eur(amountMinor),
            claimedBy,
            kind: 'item' as const,
          })),
          ...adjustments.map(([kind, amountMinor, claimed, claimants], i) => ({
            lineId: `adj-${i}`,
            label: kind,
            amount: eur(amountMinor),
            claimedBy: claimed ? claimants : [],
            kind,
          })),
        ];
        const amountMinor = lineItems.reduce(
          (acc, l) => acc + (l.kind === 'discount' ? -l.amount.amountMinor : l.amount.amountMinor),
          0,
        );
        const split: SplitSpec = { method: 'itemized', participants, lineItems };
        return { split, amountMinor };
      })
      .filter(({ amountMinor }) => amountMinor > 0),
);

/** A random valid expense in any mode. */
const expenseArb: fc.Arbitrary<Expense> = fc
  .oneof(
    amountArb.chain((amountMinor) =>
      fc
        .oneof(equalArb, excludeArb, weightedArb, exactArb(amountMinor))
        .map((split) => ({ split, amountMinor })),
    ),
    itemizedArb,
  )
  .chain(({ split, amountMinor }) =>
    fc.tuple(payersArb(amountMinor), fc.boolean()).map(([paidBy, undone]) =>
      expense({
        amount: eur(amountMinor),
        paidBy,
        split,
        status: undone ? 'undone' : 'logged',
      }),
    ),
  );

const NON_NEGATIVE_MODES = new Set(['equal', 'exclude', 'weighted', 'exact']);

describe('property: shares', () => {
  it('sum to the total, cover exactly the resolved participants, in member order', () => {
    fc.assert(
      fc.property(expenseArb, (e) => {
        const shares = computeShares(e, BARCELONA_CTX);
        const participants = resolveParticipants(e.split, BARCELONA_CTX);
        expect(shares.reduce((acc, s) => acc + s.amount.amountMinor, 0)).toBe(e.amount.amountMinor);
        expect(shares.map((s) => s.memberId)).toEqual(participants);
        expect(shares.every((s) => s.amount.currency === 'EUR')).toBe(true);
        if (NON_NEGATIVE_MODES.has(e.split.method)) {
          expect(shares.every((s) => s.amount.amountMinor >= 0)).toBe(true);
        }
        // Equal-style modes never differ by more than one minor unit.
        if (e.split.method === 'equal' || e.split.method === 'exclude') {
          const amounts = shares.map((s) => s.amount.amountMinor);
          expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('are deterministic: the same expense always splits the same way', () => {
    fc.assert(
      fc.property(expenseArb, (e) => {
        expect(computeShares(e, BARCELONA_CTX)).toEqual(computeShares(e, BARCELONA_CTX));
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: balances', () => {
  it('sum to zero over any ledger and ignore undone expenses', () => {
    fc.assert(
      fc.property(fc.array(expenseArb, { maxLength: 12 }), (expenses) => {
        resetCounter();
        const unique = expenses.map((e, i) => ({ ...e, expenseId: `exp_p${i}` }));
        const balances = computeBalances(
          buildLedger(unique, BARCELONA_CTX),
          'EUR',
          BARCELONA_MEMBERS,
        );
        expect(balances.map((b) => b.memberId)).toEqual(BARCELONA_MEMBERS);
        expect(balances.reduce((acc, b) => acc + b.net.amountMinor, 0)).toBe(0);
        const liveOnly = computeBalances(
          buildLedger(
            unique.filter((e) => e.status === 'logged'),
            BARCELONA_CTX,
          ),
          'EUR',
          BARCELONA_MEMBERS,
        );
        expect(liveOnly).toEqual(balances);
      }),
      { numRuns: 150 },
    );
  });
});

/** n members whose nets sum to zero, in a fixed member order. */
const balancesArb: fc.Arbitrary<Balance[]> = fc
  .integer({ min: 1, max: 9 })
  .chain((n) =>
    fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
      minLength: n - 1,
      maxLength: n - 1,
    }),
  )
  .map((nets) => {
    const last = -nets.reduce((acc, v) => acc + v, 0);
    return [...nets, last].map((net, i) => ({ memberId: `mem_${i}`, net: eur(net) }));
  });

function checkSettlement(balances: readonly Balance[]): void {
  const transfers = settle(balances);
  const nonZero = balances.filter((b) => b.net.amountMinor !== 0).length;
  expect(transfers.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));
  expect(transfers.length).toBeLessThanOrEqual(Math.max(0, balances.length - 1));
  const net = new Map(balances.map((b) => [b.memberId, b.net.amountMinor]));
  for (const t of transfers) {
    expect(t.amount.amountMinor).toBeGreaterThan(0);
    expect(t.from).not.toBe(t.to);
    expect(net.get(t.from) ?? 0).toBeLessThan(0); // never from a creditor
    expect(net.get(t.to) ?? 0).toBeGreaterThan(0); // never to a debtor
  }
  for (const v of applyTransfers(balances, transfers).values()) expect(v).toBe(0);
  // Output is sorted by debtor then creditor in member order.
  const index = new Map(balances.map((b, i) => [b.memberId, i]));
  for (let i = 1; i < transfers.length; i += 1) {
    const a = transfers[i - 1]!;
    const b = transfers[i]!;
    const key = (t: typeof a) => (index.get(t.from) ?? 0) * 1000 + (index.get(t.to) ?? 0);
    expect(key(a)).toBeLessThan(key(b));
  }
  // Settling again after paying is a no-op.
  const after = [...applyTransfers(balances, transfers)].map(([memberId, v]) => ({
    memberId,
    net: eur(v),
  }));
  expect(settle(after)).toEqual([]);
}

describe('property: settlement', () => {
  it('clears every balance with ≤ n−1 transfers and never moves money from a creditor', () => {
    fc.assert(fc.property(balancesArb, checkSettlement), { numRuns: 500 });
  });

  it('end to end: random expenses → ledger → balances → settle', () => {
    fc.assert(
      fc.property(fc.array(expenseArb, { minLength: 1, maxLength: 10 }), (expenses) => {
        const unique = expenses.map((e, i) => ({ ...e, expenseId: `exp_e2e${i}` }));
        checkSettlement(
          computeBalances(buildLedger(unique, BARCELONA_CTX), 'EUR', BARCELONA_MEMBERS),
        );
      }),
      { numRuns: 150 },
    );
  });
});
