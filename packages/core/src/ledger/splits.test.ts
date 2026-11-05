import { beforeEach, describe, expect, it } from 'vitest';
import { money } from '../money.js';
import type { SplitContext } from './context.js';
import {
  buildLedgerEntries,
  computeShares,
  resolveParticipants,
  validateExpense,
} from './splits.js';
import {
  BARCELONA_CTX,
  BARCELONA_MEMBERS,
  DEAN,
  HENRY,
  PIOTR,
  CHASE,
  ARJUN,
  CROWLEY,
  eur,
  expectTravError,
  expense,
  itemized,
  line,
  minors,
  resetCounter,
} from './testkit.js';

const ids = (shares: readonly { memberId: string }[]) => shares.map((s) => s.memberId);
const total = (shares: readonly { amount: { amountMinor: number } }[]) =>
  shares.reduce((acc, s) => acc + s.amount.amountMinor, 0);

beforeEach(resetCounter);

describe('equal', () => {
  it('splits €84 six ways with no remainder', () => {
    const shares = computeShares(expense(), BARCELONA_CTX);
    expect(ids(shares)).toEqual(BARCELONA_MEMBERS);
    expect(minors(shares)).toEqual([1400, 1400, 1400, 1400, 1400, 1400]);
  });

  it('hands remainder cents to the payer first, then member order', () => {
    const shares = computeShares(
      expense({ amount: eur(10000), paidBy: [{ memberId: CROWLEY, amount: eur(10000) }] }),
      BARCELONA_CTX,
    );
    // 10000 / 6 = 1666 r4 → Crowley (payer), then Dean, Chase, Henry.
    expect(minors(shares)).toEqual([1667, 1667, 1667, 1667, 1666, 1666]);
    expect(total(shares)).toBe(10000);
  });

  it('a payer who is not a participant gets no share; remainder goes by member order', () => {
    const shares = computeShares(
      expense({
        amount: eur(1000),
        paidBy: [{ memberId: DEAN, amount: eur(1000) }],
        split: { method: 'equal', participants: [HENRY, CROWLEY, CHASE] },
      }),
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual([CHASE, CROWLEY, HENRY]);
    expect(minors(shares)).toEqual([334, 333, 333]);
  });

  it('rejects an empty, unknown or duplicated participant list', () => {
    expectTravError(
      () => computeShares(expense({ split: { method: 'equal', participants: [] } }), BARCELONA_CTX),
      'invalid_argument',
    );
    expectTravError(
      () =>
        computeShares(
          expense({ split: { method: 'equal', participants: [DEAN, 'mem_nobody'] } }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
    expectTravError(
      () =>
        computeShares(
          expense({ split: { method: 'equal', participants: [DEAN, DEAN] } }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
  });
});

describe('exclude', () => {
  it('VOICE §4.4 A: €84 split with everyone but Henry → €16.80 each', () => {
    const shares = computeShares(
      expense({ split: { method: 'exclude', excluded: [HENRY] } }),
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual([DEAN, CHASE, CROWLEY, PIOTR, ARJUN]);
    expect(minors(shares)).toEqual([1680, 1680, 1680, 1680, 1680]);
  });

  it('uses the activity roster as the universe and tolerates excluding an absent member', () => {
    const razzmatazz: SplitContext = {
      memberOrder: BARCELONA_MEMBERS,
      participantsUniverse: [DEAN, CHASE, CROWLEY, PIOTR, ARJUN], // Henry's out tonight
    };
    // Henry is already absent; excluding him again is harmless.
    const five = computeShares(
      expense({ amount: eur(10001), split: { method: 'exclude', excluded: [HENRY] } }),
      razzmatazz,
    );
    expect(ids(five)).toEqual([DEAN, CHASE, CROWLEY, PIOTR, ARJUN]);
    expect(minors(five)).toEqual([2001, 2000, 2000, 2000, 2000]);
    // Exclude Arjun from the roster of five → 4 ways.
    const four = computeShares(
      expense({ amount: eur(10000), split: { method: 'exclude', excluded: [ARJUN] } }),
      razzmatazz,
    );
    expect(ids(four)).toEqual([DEAN, CHASE, CROWLEY, PIOTR]);
    expect(minors(four)).toEqual([2500, 2500, 2500, 2500]);
  });

  it('rejects excluding everyone or an unknown member', () => {
    expectTravError(
      () =>
        resolveParticipants({ method: 'exclude', excluded: [...BARCELONA_MEMBERS] }, BARCELONA_CTX),
      'invalid_argument',
    );
    expectTravError(
      () => resolveParticipants({ method: 'exclude', excluded: ['mem_ghost'] }, BARCELONA_CTX),
      'invalid_argument',
    );
    expectTravError(
      () => resolveParticipants({ method: 'exclude', excluded: [HENRY, HENRY] }, BARCELONA_CTX),
      'invalid_argument',
    );
  });
});

describe('weighted', () => {
  it('VOICE §4.4 B: €32 taxi on Chase, Crowley 20 / Chase 12', () => {
    const shares = computeShares(
      expense({
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
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual([CHASE, CROWLEY]);
    expect(minors(shares)).toEqual([1200, 2000]);
  });

  it('policy: largest fractional remainder wins, even over the payer', () => {
    // 1:2 on €10 → 333.3 / 666.7 → Chase's larger fraction wins even though Dean paid.
    const unequal = computeShares(
      expense({
        amount: eur(1000),
        split: {
          method: 'weighted',
          weights: [
            { memberId: DEAN, weight: 1 },
            { memberId: CHASE, weight: 2 },
          ],
        },
      }),
      BARCELONA_CTX,
    );
    expect(minors(unequal)).toEqual([333, 667]);
  });

  it('policy: an exact tie in fractional remainders goes to the payer', () => {
    // 1.5 : 1.5 on €10.01 is a tie → the payer (Crowley) gets the cent.
    const tie = computeShares(
      expense({
        amount: eur(1001),
        paidBy: [{ memberId: CROWLEY, amount: eur(1001) }],
        split: {
          method: 'weighted',
          weights: [
            { memberId: DEAN, weight: 1.5 },
            { memberId: CROWLEY, weight: 1.5 },
          ],
        },
      }),
      BARCELONA_CTX,
    );
    expect(ids(tie)).toEqual([DEAN, CROWLEY]);
    expect(minors(tie)).toEqual([500, 501]);
  });

  it('rejects zero, negative, NaN weights and duplicate members', () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectTravError(
        () =>
          resolveParticipants(
            { method: 'weighted', weights: [{ memberId: DEAN, weight }] },
            BARCELONA_CTX,
          ),
        'invalid_argument',
      );
    }
    expectTravError(
      () =>
        resolveParticipants(
          {
            method: 'weighted',
            weights: [
              { memberId: DEAN, weight: 1 },
              { memberId: DEAN, weight: 1 },
            ],
          },
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
  });
});

describe('exact', () => {
  it('uses the stated amounts in member order', () => {
    const shares = computeShares(
      expense({
        amount: eur(3200),
        paidBy: [{ memberId: CHASE, amount: eur(3200) }],
        split: {
          method: 'exact',
          amounts: [
            { memberId: CROWLEY, amount: eur(2000) },
            { memberId: CHASE, amount: eur(1200) },
          ],
        },
      }),
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual([CHASE, CROWLEY]);
    expect(minors(shares)).toEqual([1200, 2000]);
  });

  it('allows a zero share (listed in shares, omitted from entries)', () => {
    const e = expense({
      amount: eur(5000),
      split: {
        method: 'exact',
        amounts: [
          { memberId: DEAN, amount: eur(0) },
          { memberId: CHASE, amount: eur(5000) },
        ],
      },
    });
    expect(minors(computeShares(e, BARCELONA_CTX))).toEqual([0, 5000]);
    const owes = buildLedgerEntries(e, BARCELONA_CTX).filter((x) => x.kind === 'owes');
    expect(owes).toHaveLength(1);
    expect(owes[0]?.memberId).toBe(CHASE);
  });

  it('rejects amounts that do not sum to the total, with the gap in details', () => {
    const err = expectTravError(
      () =>
        validateExpense(
          expense({
            amount: eur(3200),
            split: {
              method: 'exact',
              amounts: [
                { memberId: CROWLEY, amount: eur(2000) },
                { memberId: CHASE, amount: eur(1100) },
              ],
            },
          }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
    expect(err.details).toMatchObject({ expected: 3200, actual: 3100 });
  });

  it('rejects negative amounts and foreign currencies', () => {
    expectTravError(
      () =>
        validateExpense(
          expense({
            amount: eur(1000),
            split: {
              method: 'exact',
              amounts: [
                { memberId: CROWLEY, amount: eur(1500) },
                { memberId: CHASE, amount: eur(-500) },
              ],
            },
          }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
    expectTravError(
      () =>
        validateExpense(
          expense({
            amount: eur(1000),
            split: {
              method: 'exact',
              amounts: [{ memberId: CROWLEY, amount: money(1000, 'USD') }],
            },
          }),
          BARCELONA_CTX,
        ),
      'currency_mismatch',
    );
  });
});

describe('itemized', () => {
  it('VOICE §4.4 C: Bar del Pla €184 on Piotr, Arjun did not drink', () => {
    const shares = computeShares(
      expense({
        amount: eur(18400),
        paidBy: [{ memberId: PIOTR, amount: eur(18400) }],
        split: itemized(BARCELONA_MEMBERS, [
          line('food', 12600),
          line('drinks', 5800, [DEAN, CHASE, CROWLEY, HENRY, PIOTR]),
        ]),
      }),
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual(BARCELONA_MEMBERS);
    expect(minors(shares)).toEqual([3260, 3260, 3260, 3260, 3260, 2100]);
    expect(total(shares)).toBe(18400);
  });

  it('allocates tax and tip pro-rata over item subtotals, shared lines equally', () => {
    const shares = computeShares(
      expense({
        amount: eur(7800),
        split: itemized(
          [DEAN, CHASE, CROWLEY, HENRY],
          [
            line('steak', 3000, [DEAN]),
            line('pasta', 2000, [CHASE]),
            line('salad', 1000, [CROWLEY, HENRY]),
            line('tax', 600, [], 'tax'),
            line('tip', 1200, [], 'tip'),
          ],
        ),
      }),
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual([DEAN, CHASE, CROWLEY, HENRY]);
    // subtotals 3000 / 2000 / 500 / 500 → tax 300/200/50/50, tip 600/400/100/100
    expect(minors(shares)).toEqual([3900, 2600, 650, 650]);
  });

  it('policy: pro-rata cent goes to the largest fractional remainder, not the payer', () => {
    // Dean €4 + Chase €6, €0.01 tax pro-rata → Dean 0.4¢ / Chase 0.6¢ → Chase gets it, Dean paid.
    const shares = computeShares(
      expense({
        amount: eur(1001),
        paidBy: [{ memberId: DEAN, amount: eur(1001) }],
        split: itemized(
          [DEAN, CHASE],
          [line('a', 400, [DEAN]), line('b', 600, [CHASE]), line('tax', 1, [], 'tax')],
        ),
      }),
      BARCELONA_CTX,
    );
    expect(minors(shares)).toEqual([400, 601]);
  });

  it('policy: tied pro-rata cents go to the payer, then member order', () => {
    const shares = computeShares(
      expense({
        amount: eur(3100),
        paidBy: [{ memberId: CHASE, amount: eur(3100) }],
        split: itemized(
          [DEAN, CHASE, CROWLEY],
          [
            line('a', 1000, [DEAN]),
            line('b', 1000, [CHASE]),
            line('c', 1000, [CROWLEY]),
            line('service', 100, [], 'service'),
          ],
        ),
      }),
      BARCELONA_CTX,
    );
    expect(minors(shares)).toEqual([1033, 1034, 1033]);
    // A shared line with an odd cent: neither claimant paid → member order (Crowley before Henry).
    const odd = computeShares(
      expense({
        amount: eur(1001),
        split: itemized([CROWLEY, HENRY], [line('salad', 1001, [CROWLEY, HENRY])]),
      }),
      BARCELONA_CTX,
    );
    expect(minors(odd)).toEqual([501, 500]);
  });

  it('T-011 case: 3 items, 4 people, one excluded; a claim by the excluded person is rejected', () => {
    const present = [DEAN, CHASE, CROWLEY]; // Henry excluded
    const shares = computeShares(
      expense({
        amount: eur(6000),
        split: itemized(present, [line('a', 2000), line('b', 2000), line('c', 2000)]),
      }),
      BARCELONA_CTX,
    );
    expect(ids(shares)).toEqual(present);
    expect(minors(shares)).toEqual([2000, 2000, 2000]);
    expectTravError(
      () =>
        validateExpense(
          expense({
            amount: eur(6000),
            split: itemized(present, [line('a', 2000, [HENRY]), line('b', 4000)]),
          }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
  });

  it('treats a discount as a reduction whichever sign it was stored with', () => {
    for (const stored of [400, -400]) {
      const shares = computeShares(
        expense({
          amount: eur(3600),
          split: itemized(
            [DEAN, CHASE],
            [
              line('a', 1000, [DEAN]),
              line('b', 3000, [CHASE]),
              line('promo', stored, [], 'discount'),
            ],
          ),
        }),
        BARCELONA_CTX,
      );
      expect(minors(shares)).toEqual([900, 2700]);
    }
  });

  it("a claimed discount larger than the claimant's items yields a negative share", () => {
    // Dean €10 dish, Chase €30 dish, Dean's €15 voucher → Dean is owed €5, Chase owes €30.
    const shares = computeShares(
      expense({
        amount: eur(2500),
        split: itemized(
          [DEAN, CHASE],
          [
            line('a', 1000, [DEAN]),
            line('b', 3000, [CHASE]),
            line('voucher', 1500, [DEAN], 'discount'),
          ],
        ),
      }),
      BARCELONA_CTX,
    );
    expect(minors(shares)).toEqual([-500, 3000]);
    expect(total(shares)).toBe(2500);
  });

  it('splits an all-adjustment receipt equally and honours a claimed service line', () => {
    const equalFallback = computeShares(
      expense({
        amount: eur(900),
        split: itemized([DEAN, CHASE, CROWLEY], [line('cover', 900, [], 'service')]),
      }),
      BARCELONA_CTX,
    );
    expect(minors(equalFallback)).toEqual([300, 300, 300]);
    const claimed = computeShares(
      expense({
        amount: eur(2500),
        split: itemized(
          [DEAN, CHASE],
          [line('a', 1000, [DEAN]), line('b', 1000, [CHASE]), line('fee', 500, [CHASE], 'fee')],
        ),
      }),
      BARCELONA_CTX,
    );
    expect(minors(claimed)).toEqual([1000, 1500]);
  });

  it('a participant who claimed nothing while everything is claimed owes zero', () => {
    const shares = computeShares(
      expense({
        amount: eur(2000),
        split: itemized([DEAN, CHASE, ARJUN], [line('a', 1000, [DEAN]), line('b', 1000, [CHASE])]),
      }),
      BARCELONA_CTX,
    );
    expect(minors(shares)).toEqual([1000, 1000, 0]);
    const entries = buildLedgerEntries(
      expense({
        amount: eur(2000),
        split: itemized([DEAN, CHASE, ARJUN], [line('a', 1000, [DEAN]), line('b', 1000, [CHASE])]),
      }),
      BARCELONA_CTX,
    );
    expect(entries.map((e) => e.memberId)).toEqual([DEAN, DEAN, CHASE]);
  });

  it('rejects lines that do not sum, duplicate lineIds, negative items and empty participants', () => {
    const err = expectTravError(
      () =>
        validateExpense(
          expense({ amount: eur(1000), split: itemized([DEAN, CHASE], [line('a', 900)]) }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
    expect(err.details).toMatchObject({ expected: 1000, actual: 900 });
    expectTravError(
      () =>
        validateExpense(
          expense({
            amount: eur(1000),
            split: itemized([DEAN, CHASE], [line('a', 500), line('a', 500)]),
          }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
    expectTravError(
      () =>
        validateExpense(
          expense({
            amount: eur(1000),
            split: itemized([DEAN, CHASE], [line('a', 1500), line('b', -500)]),
          }),
          BARCELONA_CTX,
        ),
      'invalid_argument',
    );
    expectTravError(
      () => validateExpense(expense({ split: itemized([], [line('a', 8400)]) }), BARCELONA_CTX),
      'invalid_argument',
    );
  });
});

describe('multiple payers', () => {
  it('records one paid entry per payer and splits the total normally', () => {
    const e = expense({
      paidBy: [
        { memberId: DEAN, amount: eur(5000) },
        { memberId: CHASE, amount: eur(3400) },
      ],
    });
    expect(minors(computeShares(e, BARCELONA_CTX))).toEqual([1400, 1400, 1400, 1400, 1400, 1400]);
    const paid = buildLedgerEntries(e, BARCELONA_CTX).filter((x) => x.kind === 'paid');
    expect(paid.map((p) => [p.memberId, p.amount.amountMinor])).toEqual([
      [DEAN, 5000],
      [CHASE, 3400],
    ]);
  });

  it('orders remainder cents by paid amount, then member order', () => {
    const shares = computeShares(
      expense({
        amount: eur(10000),
        paidBy: [
          { memberId: DEAN, amount: eur(4000) },
          { memberId: ARJUN, amount: eur(6000) },
        ],
      }),
      BARCELONA_CTX,
    );
    // r4 → Arjun (6000), Dean (4000), then Chase, Crowley.
    expect(minors(shares)).toEqual([1667, 1667, 1667, 1666, 1666, 1667]);
  });

  it('rejects payers that do not sum, duplicates, non-positive or unknown payers', () => {
    const bad: Parameters<typeof expense>[0][] = [
      {
        paidBy: [
          { memberId: DEAN, amount: eur(5000) },
          { memberId: CHASE, amount: eur(3000) },
        ],
      },
      {
        paidBy: [
          { memberId: DEAN, amount: eur(4200) },
          { memberId: DEAN, amount: eur(4200) },
        ],
      },
      {
        paidBy: [
          { memberId: DEAN, amount: eur(8400) },
          { memberId: CHASE, amount: eur(0) },
        ],
      },
      { paidBy: [{ memberId: 'mem_ghost', amount: eur(8400) }] },
      { paidBy: [] },
    ];
    for (const overrides of bad) {
      expectTravError(() => validateExpense(expense(overrides), BARCELONA_CTX), 'invalid_argument');
    }
    expectTravError(
      () =>
        validateExpense(
          expense({ paidBy: [{ memberId: DEAN, amount: money(8400, 'USD') }] }),
          BARCELONA_CTX,
        ),
      'currency_mismatch',
    );
  });
});

describe('validateExpense / buildLedgerEntries', () => {
  it('rejects a non-positive amount and a malformed context', () => {
    expectTravError(
      () => validateExpense(expense({ amount: eur(0), paidBy: [] }), BARCELONA_CTX),
      'invalid_argument',
    );
    expectTravError(
      () =>
        validateExpense(expense(), {
          memberOrder: [DEAN, DEAN],
          participantsUniverse: [DEAN],
        }),
      'invalid_argument',
    );
    expectTravError(
      () =>
        validateExpense(expense(), {
          memberOrder: [DEAN],
          participantsUniverse: [DEAN, CHASE],
        }),
      'invalid_argument',
    );
    expectTravError(
      () => validateExpense(expense(), { memberOrder: [], participantsUniverse: [] }),
      'invalid_argument',
    );
  });

  it('builds paid and owes rows whose signs net to zero', () => {
    const entries = buildLedgerEntries(expense(), BARCELONA_CTX);
    expect(entries).toHaveLength(7);
    const net = entries.reduce(
      (acc, e) => acc + (e.kind === 'paid' ? e.amount.amountMinor : -e.amount.amountMinor),
      0,
    );
    expect(net).toBe(0);
    expect(entries[0]).toEqual({
      expenseId: 'exp_000001',
      tripId: 'trip_barcelona',
      memberId: DEAN,
      kind: 'paid',
      amount: eur(8400),
    });
  });

  it('an undone expense is validated but yields no entries', () => {
    expect(buildLedgerEntries(expense({ status: 'undone' }), BARCELONA_CTX)).toEqual([]);
    expectTravError(
      () => buildLedgerEntries(expense({ status: 'undone', paidBy: [] }), BARCELONA_CTX),
      'invalid_argument',
    );
  });
});
