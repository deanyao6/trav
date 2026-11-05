import { describe, expect, it } from 'vitest';
import { applyPayments, incrementalTransfers, settle, settleAfterPayments } from './settle.js';
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

describe('settleAfterPayments (T-141 r2: a stable plan)', () => {
  // Two creditors (m1, m5): the review's repro.
  const NETS = [
    balance('m0', -290),
    balance('m1', 873),
    balance('m2', -442),
    balance('m3', -568),
    balance('m4', -753),
    balance('m5', 1180),
  ];
  const key = (t: { from: string; to: string; amount: { amountMinor: number } }) =>
    `${t.from}>${t.to}:${String(t.amount.amountMinor)}`;

  it("ticking one row never reroutes anyone else's (2 creditors)", () => {
    const plan = settle(NETS);
    expect(new Set(plan.map((t) => t.to))).toEqual(new Set(['m1', 'm5']));
    const before = settleAfterPayments(NETS, []);
    expect(before.open).toEqual(plan);
    let paid: typeof plan = [];
    for (const row of plan) {
      paid = [...paid, row];
      const { owing, open } = settleAfterPayments(NETS, paid);
      // Exactly the plan minus what was paid, same order, nothing rerouted.
      expect(open.map(key)).toEqual(plan.filter((t) => !paid.includes(t)).map(key));
      expect([...applyTransfers(owing, open).values()].every((v) => v === 0)).toBe(true);
    }
    // The naive re-settle WOULD reroute here (why the plan is taken before payments).
    const rerouted = plan.filter(
      (row) =>
        incrementalTransfers(NETS, [row]).map(key).join() !==
        settleAfterPayments(NETS, [row]).open.map(key).join(),
    );
    expect(rerouted.length).toBeGreaterThan(0);
  });

  it('a payment matching no row (an older card) is netted into that pair', () => {
    // Maya owes Dean 3160 now; she paid 2000 off an older card.
    const { owing, open } = settleAfterPayments(VOICE_FINAL, [
      { from: MAYA, to: DEAN, amount: eur(2000) },
    ]);
    expect(open.find((t) => t.from === MAYA)).toEqual({ from: MAYA, to: DEAN, amount: eur(1160) });
    expect(open.filter((t) => t.from !== MAYA).map(key)).toEqual(
      settle(VOICE_FINAL)
        .filter((t) => t.from !== MAYA)
        .map(key),
    );
    expect([...applyTransfers(owing, open).values()].every((v) => v === 0)).toBe(true);
  });

  it('an over-payment comes back to the payer (from whoever still owes, not as a payee refund)', () => {
    const { owing, open } = settleAfterPayments(VOICE_FINAL, [
      { from: MAYA, to: DEAN, amount: eur(4000) },
    ]);
    const toMaya = open.filter((t) => t.to === MAYA).reduce((a, t) => a + t.amount.amountMinor, 0);
    expect(toMaya).toBe(840);
    expect(open.some((t) => t.from === MAYA)).toBe(false);
    expect([...applyTransfers(owing, open).values()].every((v) => v === 0)).toBe(true);
  });

  // T-141 r2 review #1: a payment from a card older than the latest expense,
  // to a creditor the new plan no longer routes to, never makes the payee refund it.
  it('an old-card payment to a different creditor is folded in: no row asks the payee to pay it back', () => {
    // Nets: Maya owes 1017 overall once her 2070 to Dean counts; Sam is now the creditor.
    const nets = [
      { memberId: DEAN, net: eur(2070) },
      { memberId: MAYA, net: eur(-3087) },
      { memberId: SAM, net: eur(1017) },
    ];
    const { owing, open } = settleAfterPayments(nets, [
      { from: MAYA, to: DEAN, amount: eur(2070) },
    ]);
    expect(open).toEqual([{ from: MAYA, to: SAM, amount: eur(1017) }]);
    expect([...applyTransfers(owing, open).values()].every((v) => v === 0)).toBe(true);
  });

  // r2 review #1 fuzz: with old-card payments folded in, paying rows straight
  // off `open` never reroutes anyone else's row.
  it('fuzz: after unmatched payments, paying open rows one by one leaves the other rows as they were', () => {
    const ids = [DEAN, MAYA, SAM, 'mem_jordan', 'mem_priya'];
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 400; run += 1) {
      const raw = ids.map(() => rnd(3000) - 1500);
      const sum = raw.reduce((a, b) => a + b, 0);
      raw[0] = raw[0]! - sum;
      const nets = ids.map((memberId, i) => ({ memberId, net: eur(raw[i]!) }));
      const payments: { from: string; to: string; amount: ReturnType<typeof eur> }[] = [];
      for (let k = 0; k < 1 + rnd(3); k += 1) {
        const a = ids[rnd(ids.length)]!;
        const b = ids[rnd(ids.length)]!;
        if (a !== b) payments.push({ from: a, to: b, amount: eur(1 + rnd(900)) });
      }
      let { open } = settleAfterPayments(nets, payments);
      while (open.length > 0) {
        const [paid, ...rest] = open;
        payments.push(paid!);
        const next = settleAfterPayments(nets, payments);
        expect(next.open.map(key).sort()).toEqual(rest.map(key).sort());
        expect([...applyTransfers(next.owing, next.open).values()].every((v) => v === 0)).toBe(
          true,
        );
        open = next.open;
      }
    }
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
