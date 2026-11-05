import { describe, expect, it } from 'vitest';
import { applyPayments, incrementalTransfers, settle } from './settle.js';
import {
  DEAN,
  JORDAN,
  MAYA,
  PRIYA,
  SAM,
  applyTransfers,
  balance,
  eur,
  expectTravError,
} from './testkit.js';

/** VOICE §4.6 B, member order Dean, Jordan, Maya, Priya, Sam. */
const VOICE_FINAL = [
  balance(DEAN, 6120),
  balance(JORDAN, 1200),
  balance(MAYA, -3160),
  balance(PRIYA, -2280),
  balance(SAM, -1880),
];

describe('settle', () => {
  it('VOICE §4.6 B: 4 transfers and everyone is square, debtor-grouped order', () => {
    const transfers = settle(VOICE_FINAL);
    expect(transfers).toEqual([
      { from: MAYA, to: DEAN, amount: eur(3160) },
      { from: PRIYA, to: DEAN, amount: eur(2280) },
      { from: SAM, to: DEAN, amount: eur(680) },
      { from: SAM, to: JORDAN, amount: eur(1200) },
    ]);
    expect(transfers.length).toBeLessThanOrEqual(VOICE_FINAL.length - 1);
    expect([...applyTransfers(VOICE_FINAL, transfers).values()]).toEqual([0, 0, 0, 0, 0]);
  });

  it('an already-settled group needs 0 transfers, and so does an empty one', () => {
    expect(settle([balance(DEAN, 0), balance(MAYA, 0), balance(SAM, 0)])).toEqual([]);
    expect(settle([])).toEqual([]);
  });

  it('two people: one transfer, debtor first', () => {
    expect(settle([balance(DEAN, -500), balance(MAYA, 500)])).toEqual([
      { from: DEAN, to: MAYA, amount: eur(500) },
    ]);
  });

  it('breaks ties by member order deterministically', () => {
    // Two equal creditors, two equal debtors: Maya (earlier) pays Dean (earlier).
    const transfers = settle([
      balance(DEAN, 100),
      balance(MAYA, -100),
      balance(SAM, 100),
      balance(PRIYA, -100),
    ]);
    expect(transfers).toEqual([
      { from: MAYA, to: DEAN, amount: eur(100) },
      { from: PRIYA, to: SAM, amount: eur(100) },
    ]);
  });

  it('chains through the largest creditor when one debtor covers several people', () => {
    const balances = [balance(DEAN, 300), balance(MAYA, 200), balance(SAM, -500)];
    expect(settle(balances)).toEqual([
      { from: SAM, to: DEAN, amount: eur(300) },
      { from: SAM, to: MAYA, amount: eur(200) },
    ]);
  });

  it('forgives balances below the small-amount floor', () => {
    const balances = [balance(DEAN, 1000), balance(MAYA, -995), balance(SAM, -5)];
    expect(settle(balances, { floorMinor: 10 })).toEqual([
      { from: MAYA, to: DEAN, amount: eur(995) },
    ]);
    expect(settle(balances)).toHaveLength(2);
    expectTravError(() => settle(balances, { floorMinor: -1 }), 'invalid_argument');
    expectTravError(() => settle(balances, { floorMinor: 1.5 }), 'invalid_argument');
  });

  it('rejects balances that do not sum to zero, mixed currencies or repeated members', () => {
    expectTravError(() => settle([balance(DEAN, 100), balance(MAYA, -99)]), 'invariant_violation');
    expectTravError(
      () => settle([balance(DEAN, 100), balance(MAYA, -100, 'USD')]),
      'currency_mismatch',
    );
    expectTravError(() => settle([balance(DEAN, 100), balance(DEAN, -100)]), 'invalid_argument');
  });
});

describe('applyPayments (T-141)', () => {
  it('moves the debtor up and the creditor down, keeps order and Σ 0, never mutates the input', () => {
    const input = [...VOICE_FINAL];
    const after = applyPayments(input, [{ from: MAYA, to: DEAN, amount: eur(3160) }]);
    expect(after.map((b) => b.memberId)).toEqual(VOICE_FINAL.map((b) => b.memberId));
    expect(after.find((b) => b.memberId === MAYA)?.net.amountMinor).toBe(0);
    expect(after.find((b) => b.memberId === DEAN)?.net.amountMinor).toBe(
      (VOICE_FINAL.find((b) => b.memberId === DEAN)?.net.amountMinor ?? 0) - 3160,
    );
    expect(after.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);
    expect(input).toEqual(VOICE_FINAL);
    expect(settle(after)).toEqual(
      incrementalTransfers(VOICE_FINAL, [{ from: MAYA, to: DEAN, amount: eur(3160) }]),
    );
  });

  it('no payments is the identity; bad payments throw', () => {
    expect(applyPayments(VOICE_FINAL, [])).toEqual(VOICE_FINAL);
    expectTravError(
      () => applyPayments(VOICE_FINAL, [{ from: MAYA, to: MAYA, amount: eur(1) }]),
      'invalid_argument',
    );
    expectTravError(
      () => applyPayments(VOICE_FINAL, [{ from: MAYA, to: DEAN, amount: eur(1.5) }]),
      'invalid_argument',
    );
  });
});

describe('incrementalTransfers', () => {
  it('drops a transfer already paid and keeps the rest', () => {
    const remaining = incrementalTransfers(VOICE_FINAL, [
      { from: MAYA, to: DEAN, amount: eur(3160) },
    ]);
    expect(remaining).toEqual([
      { from: PRIYA, to: DEAN, amount: eur(2280) },
      { from: SAM, to: DEAN, amount: eur(680) },
      { from: SAM, to: JORDAN, amount: eur(1200) },
    ]);
  });

  it('handles a late expense: a paid transfer still counts after balances move', () => {
    // Everyone paid; then Dean logged a late €30 split 3 ways (Maya, Sam, Dean).
    const late = [balance(DEAN, 2000), balance(MAYA, -1000), balance(SAM, -1000)];
    expect(incrementalTransfers(late, [])).toHaveLength(2);
    // Maya already sent Dean €10 earlier in the day → only Sam is left.
    expect(incrementalTransfers(late, [{ from: MAYA, to: DEAN, amount: eur(1000) }])).toEqual([
      { from: SAM, to: DEAN, amount: eur(1000) },
    ]);
  });

  it('turns an over-payment into a transfer back and still clears everything', () => {
    const paid = [{ from: MAYA, to: DEAN, amount: eur(4000) }];
    const remaining = incrementalTransfers(VOICE_FINAL, paid);
    expect(remaining.length).toBeLessThanOrEqual(VOICE_FINAL.length - 1);
    const after = applyTransfers(VOICE_FINAL, [...paid, ...remaining]);
    expect([...after.values()]).toEqual([0, 0, 0, 0, 0]);
    expect(remaining.some((t) => t.to === MAYA)).toBe(true);
  });

  it('returns nothing when all square and rejects unknown members or bad amounts', () => {
    expect(incrementalTransfers([balance(DEAN, 0), balance(MAYA, 0)], [])).toEqual([]);
    expect(incrementalTransfers([], [])).toEqual([]);
    expectTravError(
      () => incrementalTransfers(VOICE_FINAL, [{ from: 'mem_ghost', to: DEAN, amount: eur(1) }]),
      'invalid_argument',
    );
    expectTravError(
      () => incrementalTransfers(VOICE_FINAL, [{ from: MAYA, to: DEAN, amount: eur(0) }]),
      'invalid_argument',
    );
    expectTravError(
      () => incrementalTransfers([], [{ from: MAYA, to: DEAN, amount: eur(1) }]),
      'invalid_argument',
    );
    expectTravError(
      () => incrementalTransfers(VOICE_FINAL, [{ from: MAYA, to: MAYA, amount: eur(1) }]),
      'invalid_argument',
    );
  });
});
