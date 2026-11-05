/**
 * T-058: family tab and minor-share folding (VOICE §8 "Money").
 * The TCI fixture (fixtures/groups + fixtures/ledger/turks-and-caicos.json) is
 * the acceptance case: Lily (14, guardian Dad) never appears in balances or
 * transfers, and the family-tab trip settles with zero transfers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { MemberId } from '../primitives.js';
import { allocate, money } from '../money.js';
import type { Expense, ExpenseCategory, LedgerEntry, Share } from '../domain/expense.js';
import type { Member } from '../domain/group.js';
import type { Trip } from '../domain/trip.js';
import { TravError } from '../errors.js';
import { member } from '../safety/test-helpers.js';
import { computeBalances } from './balances.js';
import { contextFor } from './context.js';
import {
  MINOR_WITHOUT_GUARDIAN,
  foldLedgerEntries,
  foldShares,
  isMinorWithoutGuardianError,
  minorFolding,
  spendByCategory,
  tripLedger,
} from './family.js';
import { settle } from './settle.js';
import { buildLedger, buildLedgerEntries, computeShares } from './splits.js';
import {
  BARCELONA_CTX,
  BARCELONA_MEMBERS,
  HENRY,
  MAYA,
  eur,
  expectTravError,
  expense,
  resetCounter,
} from './testkit.js';
import * as ledgerIndex from './index.js';

// ---------- a small family (USD) ----------

const MOM = 'mem_mom';
const DAD = 'mem_dad';
const KID = 'mem_kid'; // adult child
const LILY = 'mem_lily'; // minor, guardian Dad
const NOW = '2026-06-22T12:00:00-04:00';

const FAMILY: readonly Member[] = [
  member({ memberId: MOM, displayName: 'Mom', ageBand: 'adult', role: 'lead' }),
  member({ memberId: DAD, displayName: 'Dad', ageBand: 'adult', role: 'guardian' }),
  member({ memberId: KID, displayName: 'Kid', ageBand: 'adult' }),
  member({ memberId: LILY, displayName: 'Lily', ageBand: 'under18', guardianMemberId: DAD }),
];
const FAMILY_IDS = FAMILY.map((m) => m.memberId);
const SIB = 'mem_sib'; // second minor, same guardian
const FAMILY_WITH_SIB: readonly Member[] = [
  ...FAMILY,
  member({ memberId: SIB, displayName: 'Sib', ageBand: 'under18', guardianMemberId: DAD }),
];
const FAMILY_CTX = contextFor(FAMILY_IDS);
const usd = (n: number) => money(n, 'USD');

function famExpense(over: Partial<Expense> & { amountMinor?: number; payer?: MemberId } = {}) {
  const { amountMinor, payer, ...rest } = over;
  const amount = usd(amountMinor ?? 10000);
  return expense({
    groupId: 'grp_fam',
    tripId: 'trip_fam',
    amount,
    paidBy: [{ memberId: payer ?? MOM, amount }],
    split: { method: 'equal', participants: FAMILY_IDS },
    ...rest,
  });
}

const splitTrip: Pick<Trip, 'familyTab' | 'currency'> = { familyTab: false, currency: 'USD' };
const familyTrip: Pick<Trip, 'familyTab' | 'currency'> = { familyTab: true, currency: 'USD' };

const nets = (bs: readonly { memberId: string; net: { amountMinor: number } }[]) =>
  bs.map((b) => [b.memberId, b.net.amountMinor] as const);
const pairs = (ss: readonly Share[]) => ss.map((s) => [s.memberId, s.amount.amountMinor] as const);

function mentions(result: ReturnType<typeof tripLedger>, id: MemberId): boolean {
  return (
    result.balances.some((b) => b.memberId === id) ||
    result.transfers.some((t) => t.from === id || t.to === id) ||
    result.paid.some((t) => t.from === id || t.to === id) ||
    result.frontedBy.some((f) => f.memberId === id)
  );
}

// ---------- minorFolding ----------

describe('minorFolding', () => {
  it('maps each minor to a valid guardian, in member order', () => {
    const f = minorFolding(FAMILY, NOW);
    expect(f.minors).toEqual([LILY]);
    expect([...f.guardianOf]).toEqual([[LILY, DAD]]);
  });

  it('treats a birthDate under 18 as a minor even when ageBand says unknown', () => {
    const teen = member({
      memberId: 't',
      displayName: 'T',
      birthDate: '2010-01-01',
      guardianMemberId: MOM,
    });
    const f = minorFolding([FAMILY[0] as Member, teen], NOW);
    expect(f.guardianOf.get('t')).toBe(MOM);
  });

  it('age is evaluated at `now`: an 18th birthday ends the folding', () => {
    const turning = member({ memberId: 't', displayName: 'T', birthDate: '2008-06-22' });
    expect(minorFolding([turning], '2026-06-21T12:00:00Z').minors).toEqual(['t']);
    expect(minorFolding([turning], '2026-06-22T12:00:00Z').minors).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['unknown member', 'mem_ghost'],
    ['self', LILY],
    ['another minor', 'mem_sib'],
  ])('a %s guardian is recorded as null', (_label, guardian) => {
    const sib = member({
      memberId: 'mem_sib',
      displayName: 'Sib',
      ageBand: 'under18',
      guardianMemberId: DAD,
    });
    const lily = member({
      memberId: LILY,
      displayName: 'Lily',
      ageBand: 'under18',
      ...(guardian !== undefined ? { guardianMemberId: guardian } : {}),
    });
    const f = minorFolding([FAMILY[0] as Member, FAMILY[1] as Member, sib, lily], NOW);
    expect(f.guardianOf.get(LILY)).toBeNull();
    expect(f.guardianOf.get('mem_sib')).toBe(DAD);
  });

  it('ignores guardianMemberId on adults and rejects duplicate members', () => {
    const adult = member({
      memberId: 'a',
      displayName: 'A',
      ageBand: 'adult',
      guardianMemberId: MOM,
    });
    expect(minorFolding([adult, FAMILY[0] as Member], NOW).minors).toEqual([]);
    expectTravError(() => minorFolding([adult, adult], NOW), 'invalid_argument');
  });
});

// ---------- foldShares ----------

describe('foldShares', () => {
  const folding = minorFolding(FAMILY, NOW);

  it("adds the minor's share to the guardian; Σ unchanged; same rounding as computeShares", () => {
    // $100.01 / 4, Mom pays: computeShares gives Mom the odd cent (payer tie rule).
    const e = famExpense({ amountMinor: 10001 });
    const raw = computeShares(e, FAMILY_CTX);
    expect(pairs(raw)).toEqual([
      [MOM, 2501],
      [DAD, 2500],
      [KID, 2500],
      [LILY, 2500],
    ]);
    const folded = foldShares(raw, folding, FAMILY_IDS);
    expect(pairs(folded)).toEqual([
      [MOM, 2501],
      [DAD, 5000],
      [KID, 2500],
    ]);
    expect(folded.reduce((a, s) => a + s.amount.amountMinor, 0)).toBe(10001);
  });

  it("when the minor pays, the payer's odd cent is folded too (no re-rounding)", () => {
    const e = famExpense({ amountMinor: 1001, payer: LILY });
    const folded = foldShares(computeShares(e, FAMILY_CTX), folding, FAMILY_IDS);
    // 1001/4 = 250 r1, Lily (payer) gets 251 → Dad 250 + 251
    expect(pairs(folded)).toEqual([
      [MOM, 250],
      [DAD, 501],
      [KID, 250],
    ]);
  });

  it('when the guardian pays, they take the odd cent and carry the minor on top', () => {
    const e = famExpense({ amountMinor: 1001, payer: DAD });
    const raw = computeShares(e, FAMILY_CTX);
    expect(pairs(raw)).toEqual([
      [MOM, 250],
      [DAD, 251],
      [KID, 250],
      [LILY, 250],
    ]);
    expect(pairs(foldShares(raw, folding, FAMILY_IDS))).toEqual([
      [MOM, 250],
      [DAD, 501],
      [KID, 250],
    ]);
  });

  it('two minors sharing one guardian both fold into that guardian', () => {
    const ids = [...FAMILY_IDS, SIB];
    const fold2 = minorFolding(FAMILY_WITH_SIB, NOW);
    const e = famExpense({
      amountMinor: 1002,
      payer: SIB,
      split: { method: 'equal', participants: ids },
    });
    const raw = computeShares(e, contextFor(ids));
    expect(pairs(raw)).toEqual([
      [MOM, 201],
      [DAD, 200],
      [KID, 200],
      [LILY, 200],
      [SIB, 201],
    ]);
    expect(pairs(foldShares(raw, fold2, ids))).toEqual([
      [MOM, 201],
      [DAD, 601],
      [KID, 200],
    ]);
  });

  it("a minor's exactly-zero share adds no row for a non-participant guardian", () => {
    const e = famExpense({
      amountMinor: 100,
      payer: MOM,
      split: {
        method: 'exact',
        amounts: [
          { memberId: MOM, amount: usd(100) },
          { memberId: LILY, amount: usd(0) },
        ],
      },
    });
    const raw = computeShares(e, FAMILY_CTX);
    expect(pairs(raw)).toEqual([
      [MOM, 100],
      [LILY, 0],
    ]);
    const folded = foldShares(raw, folding, FAMILY_IDS);
    expect(pairs(folded)).toEqual([[MOM, 100]]);
    expect(folded.some((s) => s.memberId === DAD)).toBe(false);
  });

  it('a guardian who was not a participant still carries the minor', () => {
    const e = famExpense({
      amountMinor: 3000,
      split: { method: 'equal', participants: [MOM, LILY] },
    });
    expect(pairs(foldShares(computeShares(e, FAMILY_CTX), folding, FAMILY_IDS))).toEqual([
      [MOM, 1500],
      [DAD, 1500],
    ]);
  });

  it('a split of only the minor lands entirely on the guardian', () => {
    const e = famExpense({ amountMinor: 999, split: { method: 'equal', participants: [LILY] } });
    expect(pairs(foldShares(computeShares(e, FAMILY_CTX), folding, FAMILY_IDS))).toEqual([
      [DAD, 999],
    ]);
  });

  it('folds a negative itemized share (minor claims a voucher) without breaking Σ', () => {
    const e = famExpense({
      amountMinor: 1500,
      split: {
        method: 'itemized',
        participants: [DAD, LILY],
        lineItems: [
          { lineId: 'a', label: 'a', amount: usd(2000), claimedBy: [DAD], kind: 'item' },
          { lineId: 'b', label: 'b', amount: usd(1000), claimedBy: [LILY], kind: 'item' },
          { lineId: 'v', label: 'v', amount: usd(1500), claimedBy: [LILY], kind: 'discount' },
        ],
      },
    });
    const raw = computeShares(e, FAMILY_CTX);
    expect(pairs(raw)).toEqual([
      [DAD, 2000],
      [LILY, -500],
    ]);
    expect(pairs(foldShares(raw, folding, FAMILY_IDS))).toEqual([[DAD, 1500]]);
  });

  it('is the identity for a group with no minors (Barcelona)', () => {
    resetCounter();
    const e = expense({ amount: eur(8401), split: { method: 'exclude', excluded: [HENRY] } });
    const raw = computeShares(e, BARCELONA_CTX);
    const none = minorFolding(
      BARCELONA_MEMBERS.map((id) => member({ memberId: id, displayName: id, ageBand: 'adult' })),
      NOW,
    );
    expect(foldShares(raw, none, BARCELONA_MEMBERS)).toEqual(raw);
  });

  it('returns [] for no shares', () => {
    expect(foldShares([], folding, FAMILY_IDS)).toEqual([]);
  });

  it('throws minor_without_guardian for a non-zero share; drops a zero share', () => {
    const orphan = minorFolding(
      [FAMILY[0] as Member, member({ memberId: LILY, displayName: 'Lily', ageBand: 'under18' })],
      NOW,
    );
    const err = expectTravError(
      () => foldShares([{ memberId: LILY, amount: usd(100) }], orphan, [MOM, LILY]),
      'invalid_argument',
    );
    expect(err.details?.['reason']).toBe(MINOR_WITHOUT_GUARDIAN);
    expect(isMinorWithoutGuardianError(err)).toBe(true);
    expect(isMinorWithoutGuardianError(new TravError('invalid_argument', 'x'))).toBe(false);
    expect(
      pairs(
        foldShares(
          [
            { memberId: MOM, amount: usd(100) },
            { memberId: LILY, amount: usd(0) },
          ],
          orphan,
          [MOM, LILY],
        ),
      ),
    ).toEqual([[MOM, 100]]);
  });

  it('rejects mixed currencies and carriers outside memberOrder', () => {
    expectTravError(
      () =>
        foldShares(
          [
            { memberId: MOM, amount: usd(1) },
            { memberId: DAD, amount: eur(1) },
          ],
          folding,
          FAMILY_IDS,
        ),
      'currency_mismatch',
    );
    expectTravError(
      () => foldShares([{ memberId: LILY, amount: usd(1) }], folding, [MOM, LILY]),
      'invalid_argument',
    );
  });
});

// ---------- foldLedgerEntries ----------

describe('foldLedgerEntries', () => {
  const folding = minorFolding(FAMILY, NOW);

  it("credits the minor's payment and debits their share to the guardian, merged per expense", () => {
    resetCounter();
    const e = famExpense({ amountMinor: 2400, payer: LILY });
    const entries = foldLedgerEntries(buildLedgerEntries(e, FAMILY_CTX), folding);
    expect(entries.map((x) => [x.memberId, x.kind, x.amount.amountMinor])).toEqual([
      [DAD, 'paid', 2400],
      [MOM, 'owes', 600],
      [DAD, 'owes', 1200],
      [KID, 'owes', 600],
    ]);
    expect(entries.some((x) => x.memberId === LILY)).toBe(false);
  });

  it('merges a guardian and minor co-paying, and drops owes rows that net to zero', () => {
    const rows: LedgerEntry[] = [
      { expenseId: 'e1', tripId: 't', memberId: DAD, kind: 'paid', amount: usd(500) },
      { expenseId: 'e1', tripId: 't', memberId: LILY, kind: 'paid', amount: usd(500) },
      { expenseId: 'e1', tripId: 't', memberId: DAD, kind: 'owes', amount: usd(500) },
      { expenseId: 'e1', tripId: 't', memberId: LILY, kind: 'owes', amount: usd(-500) },
      { expenseId: 'e1', tripId: 't', memberId: MOM, kind: 'owes', amount: usd(1000) },
      { expenseId: 'e2', tripId: 't', memberId: LILY, kind: 'owes', amount: usd(7) },
    ];
    expect(
      foldLedgerEntries(rows, folding).map((x) => [
        x.expenseId,
        x.memberId,
        x.kind,
        x.amount.amountMinor,
      ]),
    ).toEqual([
      ['e1', DAD, 'paid', 1000],
      ['e1', MOM, 'owes', 1000],
      ['e2', DAD, 'owes', 7],
    ]);
  });

  it('throws minor_without_guardian when an unguarded minor has any row', () => {
    const orphan = minorFolding(
      [FAMILY[0] as Member, member({ memberId: LILY, displayName: 'Lily', ageBand: 'under18' })],
      NOW,
    );
    const rows: LedgerEntry[] = [
      { expenseId: 'e1', tripId: 't', memberId: LILY, kind: 'paid', amount: usd(5) },
    ];
    expect(isMinorWithoutGuardianError(catchErr(() => foldLedgerEntries(rows, orphan)))).toBe(true);
  });
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

// ---------- spendByCategory ----------

describe('spendByCategory', () => {
  it('totals logged expenses per category, largest first, ties by name, undone skipped', () => {
    resetCounter();
    const cat = (c: ExpenseCategory, n: number, status: Expense['status'] = 'logged') =>
      famExpense({ amountMinor: n, category: c, status });
    expect(
      spendByCategory(
        [
          cat('food', 1000),
          cat('activities', 3000),
          cat('food', 2000),
          cat('drinks', 9999, 'undone'),
          cat('lodging', 3000),
        ],
        'USD',
      ).map((x) => [x.category, x.amount.amountMinor]),
    ).toEqual([
      ['activities', 3000],
      ['food', 3000],
      ['lodging', 3000],
    ]);
    expect(spendByCategory([], 'USD')).toEqual([]);
  });

  it('rejects an expense in another currency', () => {
    resetCounter();
    expectTravError(() => spendByCategory([expense()], 'USD'), 'currency_mismatch');
  });
});

// ---------- tripLedger ----------

describe('tripLedger: split trips', () => {
  it('no minors: byte-identical to buildLedger → computeBalances → settle (Barcelona)', () => {
    resetCounter();
    const expenses = [
      expense({ amount: eur(8401) }),
      expense({
        amount: eur(12000),
        paidBy: [{ memberId: MAYA, amount: eur(12000) }],
        split: { method: 'exclude', excluded: [HENRY] },
      }),
      expense({ amount: eur(333), status: 'undone' }),
    ];
    const members = BARCELONA_MEMBERS.map((id) =>
      member({ memberId: id, displayName: id, ageBand: 'adult' }),
    );
    const balances = computeBalances(
      buildLedger(expenses, BARCELONA_CTX),
      'EUR',
      BARCELONA_MEMBERS,
    );
    for (const floorMinor of [undefined, 0, 500]) {
      const got = tripLedger({
        trip: { familyTab: false, currency: 'EUR' },
        members,
        expenses,
        ctx: BARCELONA_CTX,
        now: NOW,
        ...(floorMinor !== undefined ? { floorMinor } : {}),
      });
      expect(got.mode).toBe('split');
      expect(got.balances).toEqual(balances);
      expect(got.transfers).toEqual(
        settle(balances, floorMinor === undefined ? undefined : { floorMinor }),
      );
      expect(got.folded).toEqual([]);
    }
  });

  it('with a minor: the minor is never listed; the guardian carries their share and payments', () => {
    resetCounter();
    const expenses = [
      famExpense({ amountMinor: 10001, payer: MOM }),
      famExpense({ amountMinor: 2401, payer: LILY, category: 'activities' }),
      famExpense({
        amountMinor: 5000,
        payer: KID,
        split: { method: 'equal', participants: [KID, LILY] },
      }),
    ];
    const got = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
    });
    expect(mentions(got, LILY)).toBe(false);
    expect(got.balances.map((b) => b.memberId)).toEqual([MOM, DAD, KID]);
    // Shares: e1 Mom 2501, others 2500. e2 (Lily pays, 601 to Lily) Mom/Dad/Kid 600.
    // e3 Kid 2500, Lily 2500. Dad carries Lily: 2500 + 601 + 2500.
    expect(nets(got.balances)).toEqual([
      [MOM, 10001 - 2501 - 600],
      [DAD, 2401 - (2500 + 600) - (2500 + 601 + 2500)],
      [KID, 5000 - 2500 - 600 - 2500],
    ]);
    expect(got.balances.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);
    expect(got.transfers.length).toBeGreaterThan(0);
    expect(got.transfers.length).toBeLessThanOrEqual(2);
    expect(got.folded).toEqual([{ minor: LILY, guardian: DAD }]);
    expect(pairs(got.frontedBy)).toEqual([
      [MOM, 10001],
      [DAD, 2401],
      [KID, 5000],
    ]);
  });

  it('an unguarded minor who spent nothing does not block settle-up; one with a share does', () => {
    resetCounter();
    const members = [
      ...FAMILY.slice(0, 3),
      member({ memberId: LILY, displayName: 'Lily', ageBand: 'under18' }),
    ];
    const adultsOnly = famExpense({ split: { method: 'equal', participants: [MOM, DAD, KID] } });
    const ok = tripLedger({
      trip: splitTrip,
      members,
      expenses: [adultsOnly],
      ctx: FAMILY_CTX,
      now: NOW,
    });
    expect(mentions(ok, LILY)).toBe(false);
    expect(ok.folded).toEqual([{ minor: LILY, guardian: null }]);
    expect(
      isMinorWithoutGuardianError(
        catchErr(() =>
          tripLedger({
            trip: splitTrip,
            members,
            expenses: [famExpense()],
            ctx: FAMILY_CTX,
            now: NOW,
          }),
        ),
      ),
    ).toBe(true);
    // Same refusal under a family tab: we never guess who carries a child.
    expect(
      isMinorWithoutGuardianError(
        catchErr(() =>
          tripLedger({
            trip: familyTrip,
            members,
            expenses: [famExpense()],
            ctx: FAMILY_CTX,
            now: NOW,
          }),
        ),
      ),
    ).toBe(true);
  });

  it('an inactive guardian (left the group) still carries the minor', () => {
    resetCounter();
    const members = [
      member({ memberId: MOM, displayName: 'Mom', ageBand: 'adult' }),
      member({
        memberId: DAD,
        displayName: 'Dad',
        ageBand: 'adult',
        active: false,
        leftAt: '2026-06-21T09:00:00-04:00',
      }),
      member({ memberId: LILY, displayName: 'Lily', ageBand: 'under18', guardianMemberId: DAD }),
    ];
    const ids = members.map((m) => m.memberId);
    const e = famExpense({
      amountMinor: 300,
      payer: MOM,
      split: { method: 'equal', participants: [MOM, LILY] },
    });
    const got = tripLedger({
      trip: splitTrip,
      members,
      expenses: [e],
      ctx: contextFor(ids),
      now: NOW,
    });
    expect(got.folded).toEqual([{ minor: LILY, guardian: DAD }]);
    expect(nets(got.balances)).toEqual([
      [MOM, 150],
      [DAD, -150],
    ]);
    expect(got.transfers.map((t) => [t.from, t.to, t.amount.amountMinor])).toEqual([
      [DAD, MOM, 150],
    ]);
  });

  it('two minors sharing one guardian: both fold into the guardian end to end', () => {
    resetCounter();
    const ids = FAMILY_WITH_SIB.map((m) => m.memberId);
    const e = famExpense({
      amountMinor: 1002,
      payer: SIB,
      split: { method: 'equal', participants: ids },
    });
    const got = tripLedger({
      trip: splitTrip,
      members: FAMILY_WITH_SIB,
      expenses: [e],
      ctx: contextFor(ids),
      now: NOW,
    });
    expect(got.folded).toEqual([
      { minor: LILY, guardian: DAD },
      { minor: SIB, guardian: DAD },
    ]);
    // Sib's 1002 is credited to Dad, who owes 200 + 200 + 201 = 601.
    expect(nets(got.balances)).toEqual([
      [MOM, -201],
      [DAD, 1002 - 601],
      [KID, -200],
    ]);
    expect(got.transfers.map((t) => [t.from, t.to, t.amount.amountMinor])).toEqual([
      [MOM, DAD, 201],
      [KID, DAD, 200],
    ]);
    expect(pairs(got.frontedBy)).toEqual([[DAD, 1002]]);
    expect(mentions(got, LILY) || mentions(got, SIB)).toBe(false);
  });

  it('output order follows ctx.memberOrder, not the order `members` was passed in', () => {
    resetCounter();
    // Mom fronts for Dad, Kid and Lily: Dad (carrying Lily) and Kid end up equal
    // debtors (−300 each), so settle's tie-break and output order depend on member order.
    const expenses = [
      famExpense({
        amountMinor: 200,
        payer: MOM,
        split: { method: 'equal', participants: [DAD, KID] },
      }),
      famExpense({
        amountMinor: 400,
        payer: MOM,
        split: { method: 'equal', participants: [KID, LILY] },
      }),
    ];
    const base = { trip: splitTrip, expenses, ctx: FAMILY_CTX, now: NOW };
    const straight = tripLedger({ ...base, members: FAMILY });
    const reversed = tripLedger({ ...base, members: FAMILY.slice().reverse() });
    expect(reversed).toEqual(straight);
    expect(nets(reversed.balances)).toEqual([
      [MOM, 600],
      [DAD, -300],
      [KID, -300],
    ]);
    expect(reversed.transfers.map((t) => [t.from, t.to, t.amount.amountMinor])).toEqual([
      [DAD, MOM, 300],
      [KID, MOM, 300],
    ]);
    // Same as the raw computeBalances → settle chain over the folded entries in ctx order.
    const raw = computeBalances(
      foldLedgerEntries(buildLedger(expenses, FAMILY_CTX), minorFolding(FAMILY, NOW)),
      'USD',
      [MOM, DAD, KID],
    );
    expect(reversed.balances).toEqual(raw);
    expect(reversed.transfers).toEqual(settle(raw));
    // A member absent from ctx.memberOrder is appended after the ctx order.
    const extra = member({ memberId: 'mem_extra', displayName: 'Extra', ageBand: 'adult' });
    const withExtra = tripLedger({ ...base, members: [extra, ...FAMILY.slice().reverse()] });
    expect(withExtra.balances.map((b) => b.memberId)).toEqual([MOM, DAD, KID, 'mem_extra']);
    // With a per-expense context function there is no single order: `members` order is used.
    const fnCtx = tripLedger({ ...base, ctx: () => FAMILY_CTX, members: FAMILY.slice().reverse() });
    expect(fnCtx.balances.map((b) => b.memberId)).toEqual([KID, DAD, MOM]);
  });

  it('accepts precomputed entries (T-065): same result as rebuilding, members order, no ctx needed', () => {
    resetCounter();
    const expenses = [
      famExpense({
        amountMinor: 900,
        payer: LILY,
        split: { method: 'equal', participants: [MOM, DAD, KID] },
      }),
      famExpense({
        amountMinor: 400,
        payer: MOM,
        split: { method: 'equal', participants: [KID, LILY] },
      }),
    ];
    const rebuilt = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
    });
    const persisted = buildLedger(expenses, FAMILY_CTX);
    const fromEntries = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      entries: persisted,
      now: NOW,
    });
    expect(fromEntries).toEqual(rebuilt);
    expect(fromEntries.balances.some((b) => b.memberId === LILY)).toBe(false);
    // Entries win over ctx: they are the persisted truth (here an attendance-scoped split).
    const scoped = buildLedger(expenses, {
      memberOrder: FAMILY_IDS,
      participantsUniverse: [MOM, DAD],
    });
    expect(() =>
      tripLedger({
        trip: splitTrip,
        members: FAMILY,
        expenses,
        entries: scoped,
        ctx: FAMILY_CTX,
        now: NOW,
      }),
    ).not.toThrow();
    // Order follows `members` with entries.
    const rev = tripLedger({
      trip: splitTrip,
      members: FAMILY.slice().reverse(),
      expenses,
      entries: persisted,
      now: NOW,
    });
    expect(rev.balances.map((b) => b.memberId)).toEqual([KID, DAD, MOM]);
    // Family tab from entries: zero transfers.
    const fam = tripLedger({
      trip: familyTrip,
      members: FAMILY,
      expenses,
      entries: persisted,
      now: NOW,
    });
    expect(fam.transfers).toEqual([]);
    expect(fam.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    // An entry naming a non-member throws rather than being dropped.
    const ghost: LedgerEntry = { ...persisted[0]!, memberId: 'mem_ghost' };
    expectTravError(
      () =>
        tripLedger({
          trip: splitTrip,
          members: FAMILY,
          expenses,
          entries: [...persisted, ghost],
          now: NOW,
        }),
      'invalid_argument',
    );
    // Neither ctx nor entries.
    expectTravError(
      () => tripLedger({ trip: splitTrip, members: FAMILY, expenses, now: NOW }),
      'invalid_argument',
    );
  });

  it('rejects a group with no adult to carry the tab', () => {
    const kids = [member({ memberId: LILY, displayName: 'Lily', ageBand: 'under18' })];
    expectTravError(
      () =>
        tripLedger({
          trip: splitTrip,
          members: kids,
          expenses: [],
          ctx: contextFor([LILY]),
          now: NOW,
        }),
      'invalid_argument',
    );
  });

  it('still rejects duplicate expenses and invalid splits', () => {
    resetCounter();
    const e = famExpense();
    for (const trip of [splitTrip, familyTrip]) {
      expectTravError(
        () => tripLedger({ trip, members: FAMILY, expenses: [e, e], ctx: FAMILY_CTX, now: NOW }),
        'duplicate',
      );
      expectTravError(
        () =>
          tripLedger({
            trip,
            members: FAMILY,
            expenses: [famExpense({ split: { method: 'equal', participants: ['mem_ghost'] } })],
            ctx: FAMILY_CTX,
            now: NOW,
          }),
        'invalid_argument',
      );
    }
  });
});

describe('tripLedger: payments marked paid (T-141)', () => {
  const twoExpenses = (): Expense[] => {
    resetCounter();
    return [
      famExpense({ amountMinor: 12000, payer: MOM }),
      famExpense({
        amountMinor: 3000,
        payer: KID,
        split: { method: 'equal', participants: [KID, LILY] },
      }),
    ];
  };

  it('a paid transfer reduces what is owed; the rest settles; Σ stays 0; total unchanged', () => {
    const expenses = twoExpenses();
    const before = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
    });
    expect(before.paid).toEqual([]);
    const first = before.transfers[0]!;
    const after = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
      payments: [first],
    });
    expect(after.paid).toEqual([first]);
    expect(after.transfers).toEqual(before.transfers.slice(1));
    expect(after.balances.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);
    const net = (l: typeof before, id: MemberId): number =>
      l.balances.find((b) => b.memberId === id)?.net.amountMinor ?? NaN;
    expect(net(after, first.from)).toBe(net(before, first.from) + first.amount.amountMinor);
    expect(net(after, first.to)).toBe(net(before, first.to) - first.amount.amountMinor);
    expect(after.total).toEqual(before.total);
    expect(after.frontedBy).toEqual(before.frontedBy);
    expect(mentions(after, LILY)).toBe(false);
  });

  it('every transfer paid: everyone is at zero, nothing left to settle', () => {
    const expenses = twoExpenses();
    const before = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
    });
    const after = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
      payments: before.transfers,
    });
    expect(after.transfers).toEqual([]);
    expect(after.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
  });

  it('a payment naming a minor is carried by the guardian (minors never pay or receive)', () => {
    const expenses = twoExpenses();
    const viaGuardian = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
      payments: [{ from: DAD, to: MOM, amount: usd(1000) }],
    });
    const viaMinor = tripLedger({
      trip: splitTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
      payments: [{ from: LILY, to: MOM, amount: usd(1000) }],
    });
    expect(viaMinor.balances).toEqual(viaGuardian.balances);
    expect(viaMinor.paid).toEqual([{ from: DAD, to: MOM, amount: usd(1000) }]);
    expect(mentions(viaMinor, LILY)).toBe(false);
  });

  it('a family tab ignores payments; a bad payment throws', () => {
    const expenses = twoExpenses();
    const fam = tripLedger({
      trip: familyTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
      payments: [{ from: DAD, to: MOM, amount: usd(1000) }],
    });
    expect(fam.paid).toEqual([]);
    expect(fam.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    const bad =
      (amount: ReturnType<typeof usd>, from: MemberId = DAD) =>
      () =>
        tripLedger({
          trip: splitTrip,
          members: FAMILY,
          expenses,
          ctx: FAMILY_CTX,
          now: NOW,
          payments: [{ from, to: MOM, amount }],
        });
    expectTravError(bad(usd(0)), 'invalid_argument');
    expectTravError(bad(money(100, 'EUR')), 'currency_mismatch');
    expectTravError(bad(usd(100), MOM), 'invalid_argument');
  });
});

describe('tripLedger: family tab', () => {
  it('one pot: zero balances, zero transfers; totals, categories and fronted amounts still work', () => {
    resetCounter();
    const expenses = [
      famExpense({ amountMinor: 26001, payer: DAD, category: 'activities' }),
      famExpense({ amountMinor: 14200, payer: MOM, category: 'food' }),
      famExpense({ amountMinor: 2400, payer: LILY, category: 'food' }),
      famExpense({ amountMinor: 5000, payer: KID, category: 'food', status: 'undone' }),
      famExpense({
        amountMinor: 999,
        payer: KID,
        category: 'other',
        split: { method: 'exclude', excluded: [MOM] },
      }),
    ];
    const got = tripLedger({
      trip: familyTrip,
      members: FAMILY,
      expenses,
      ctx: FAMILY_CTX,
      now: NOW,
    });
    expect(got.mode).toBe('family_tab');
    expect(got.transfers).toEqual([]);
    expect(nets(got.balances)).toEqual([
      [MOM, 0],
      [DAD, 0],
      [KID, 0],
    ]);
    expect(got.balances.every((b) => b.net.currency === 'USD')).toBe(true);
    expect(got.total).toEqual(usd(26001 + 14200 + 2400 + 999));
    expect(got.byCategory.map((c) => [c.category, c.amount.amountMinor])).toEqual([
      ['activities', 26001],
      ['food', 16600],
      ['other', 999],
    ]);
    expect(pairs(got.frontedBy)).toEqual([
      [MOM, 14200],
      [DAD, 26001 + 2400],
      [KID, 999],
    ]);
    expect(mentions(got, LILY)).toBe(false);
  });

  it('an empty family-tab trip settles to nothing', () => {
    const got = tripLedger({
      trip: familyTrip,
      members: FAMILY,
      expenses: [],
      ctx: FAMILY_CTX,
      now: NOW,
    });
    expect(got.transfers).toEqual([]);
    expect(got.total).toEqual(usd(0));
    expect(got.byCategory).toEqual([]);
    expect(got.frontedBy).toEqual([]);
  });

  it('is exported from the ledger namespace', () => {
    expect(ledgerIndex.tripLedger).toBe(tripLedger);
    expect(ledgerIndex.foldShares).toBe(foldShares);
  });
});

// ---------- the TCI fixture (acceptance) ----------

interface TciGroup {
  members: Member[];
  trip: Trip;
}
interface TciLedger {
  currency: string;
  familyTab: boolean;
  expenses: {
    expenseId: string;
    description: string | null;
    category: ExpenseCategory | null;
    amount: { amountMinor: number; currency: string };
    paidBy: string;
    source: Expense['source'];
    occurredAt: string;
    fromChatLine: string;
  }[];
  final: {
    totalSpent: { amountMinor: number; currency: string };
    frontedBy: { memberId: string; amount: { amountMinor: number; currency: string } }[];
    transfers: unknown[];
    neverInBalances: string[];
  };
}

const fixture = <T>(rel: string): T =>
  JSON.parse(readFileSync(new URL(`../../../../fixtures/${rel}`, import.meta.url), 'utf8')) as T;

describe('TCI fixture (Lily, 14, guardian Dad)', () => {
  const g = fixture<TciGroup>('groups/turks-and-caicos.json');
  const l = fixture<TciLedger>('ledger/turks-and-caicos.json');
  const ids = g.members.map((m) => m.memberId);
  const LILY_TCI = 'mem_tci_lily';
  const now = '2026-06-24T12:00:00-04:00';
  // The fixture logs no split (one pot); for the split-mode check we split each expense equally.
  const expenses: Expense[] = l.expenses.map((x) => ({
    expenseId: x.expenseId,
    groupId: g.trip.groupId,
    tripId: g.trip.tripId,
    description: x.description ?? 'expense',
    category: x.category ?? 'other',
    amount: x.amount,
    paidBy: [{ memberId: x.paidBy, amount: x.amount }],
    split: { method: 'equal', participants: ids },
    source: x.source,
    sourceRef: { kind: 'message', id: x.fromChatLine },
    occurredAt: x.occurredAt,
    createdAt: x.occurredAt,
    createdBy: x.paidBy,
    status: 'logged',
  }));

  it('fixture sanity: Lily is a minor folded into Dad, and the trip is a family tab', () => {
    expect(g.trip.familyTab).toBe(true);
    expect(l.familyTab).toBe(true);
    expect([...minorFolding(g.members, now).guardianOf]).toEqual([[LILY_TCI, 'mem_tci_dad']]);
    expect(l.expenses.some((x) => x.paidBy === LILY_TCI)).toBe(true); // she does pay for something
  });

  it('family tab: settles with zero transfers; Lily never in balances; totals match the fixture', () => {
    const got = tripLedger({
      trip: g.trip,
      members: g.members,
      expenses,
      ctx: contextFor(ids),
      now,
    });
    expect(got.mode).toBe('family_tab');
    expect(got.transfers).toEqual(l.final.transfers);
    expect(got.transfers).toEqual([]);
    for (const id of l.final.neverInBalances) expect(mentions(got, id)).toBe(false);
    expect(got.balances.every((b) => b.net.amountMinor === 0)).toBe(true);
    expect(got.total).toEqual(l.final.totalSpent);
    const byId = (xs: readonly { memberId: string; amount: { amountMinor: number } }[]) =>
      Object.fromEntries(xs.map((x) => [x.memberId, x.amount.amountMinor]));
    expect(byId(got.frontedBy)).toEqual(byId(l.final.frontedBy));
    expect(got.folded).toEqual([{ minor: LILY_TCI, guardian: 'mem_tci_dad' }]);
  });

  it('same trip with splitting turned on: Lily still never appears; Dad carries her share', () => {
    const got = tripLedger({
      trip: { ...g.trip, familyTab: false },
      members: g.members,
      expenses,
      ctx: contextFor(ids),
      now,
    });
    expect(mentions(got, LILY_TCI)).toBe(false);
    // Each of the 4 owes 6500 + 9500 + 3550 + 600 = 20150; Dad carries Lily's too.
    expect(nets(got.balances)).toEqual([
      ['mem_tci_mom', 52200 - 20150],
      ['mem_tci_dad', 28400 - 40300],
      ['mem_tci_dean', -20150],
    ]);
    expect(got.transfers.map((t) => [t.from, t.to, t.amount.amountMinor])).toEqual([
      ['mem_tci_dad', 'mem_tci_mom', 11900],
      ['mem_tci_dean', 'mem_tci_mom', 20150],
    ]);
  });
});

// ---------- properties ----------

describe('properties', () => {
  const adults = [MOM, DAD, KID];
  const anyone = [...adults, LILY];

  it('folding never lists a minor, keeps Σ balances = 0, and settles every split ledger', () => {
    const exp = fc
      .record({
        amount: fc.integer({ min: 1, max: 2_000_000 }),
        payer: fc.constantFrom(...anyone),
        participants: fc.shuffledSubarray(anyone, { minLength: 1 }),
      })
      .map((r) =>
        famExpense({
          amountMinor: r.amount,
          payer: r.payer,
          split: { method: 'equal', participants: r.participants },
        }),
      );
    fc.assert(
      fc.property(fc.array(exp, { maxLength: 8 }), fc.boolean(), (expenses, familyTab) => {
        const got = tripLedger({
          trip: { familyTab, currency: 'USD' },
          members: FAMILY,
          expenses,
          ctx: FAMILY_CTX,
          now: NOW,
        });
        expect(mentions(got, LILY)).toBe(false);
        expect(got.balances.reduce((a, b) => a + b.net.amountMinor, 0)).toBe(0);
        if (familyTab) {
          expect(got.transfers).toEqual([]);
        } else {
          // guardian's folded net = unfolded Dad net + unfolded Lily net; others unchanged
          const raw = new Map(
            nets(computeBalances(buildLedger(expenses, FAMILY_CTX), 'USD', FAMILY_IDS)),
          );
          expect(nets(got.balances)).toEqual([
            [MOM, raw.get(MOM)],
            [DAD, (raw.get(DAD) ?? 0) + (raw.get(LILY) ?? 0)],
            [KID, raw.get(KID)],
          ]);
          const after = new Map(nets(got.balances).map(([id, n]) => [id, n]));
          for (const t of got.transfers) {
            after.set(t.from, (after.get(t.from) ?? 0) + t.amount.amountMinor);
            after.set(t.to, (after.get(t.to) ?? 0) - t.amount.amountMinor);
          }
          expect([...after.values()].every((v) => v === 0)).toBe(true);
          expect(got.transfers.length).toBeLessThanOrEqual(adults.length - 1);
        }
        expect(got.total.amountMinor).toBe(expenses.reduce((a, e) => a + e.amount.amountMinor, 0));
      }),
      { numRuns: 200 },
    );
  });

  it('foldShares preserves Σ, never lists a minor and stays integer across split modes', () => {
    const folding = minorFolding(FAMILY, NOW);
    const methodArb = fc.constantFrom('equal', 'exclude', 'weighted', 'exact', 'itemized');
    const weightsArb = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 4, maxLength: 4 });
    const seen = new Set<string>();
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.constantFrom(...anyone),
        fc.shuffledSubarray(anyone, { minLength: 1 }),
        methodArb,
        weightsArb,
        (amountMinor, payer, members, method, weights) => {
          const amount = usd(amountMinor);
          const w = (i: number) => (weights[i] ?? 0) + 1; // integer weights ≥ 1
          let split: Expense['split'];
          switch (method) {
            case 'equal':
              split = { method, participants: members };
              break;
            case 'exclude':
              // excluded = everyone NOT drawn, so at least one participant remains
              split = { method, excluded: anyone.filter((id) => !members.includes(id)) };
              break;
            case 'weighted':
              split = {
                method,
                weights: members.map((memberId, i) => ({ memberId, weight: w(i) })),
              };
              break;
            case 'exact': {
              // amounts that sum exactly (zeros allowed, e.g. a minor with $0.00)
              const parts = allocate(
                amount,
                members.map((_, i) => weights[i] ?? 0).some((x) => x > 0)
                  ? members.map((_, i) => weights[i] ?? 0)
                  : members.map(() => 1),
              );
              split = {
                method,
                amounts: members.map((memberId, i) => ({
                  memberId,
                  amount: parts[i] ?? usd(0),
                })),
              };
              break;
            }
            case 'itemized': {
              // one claimed line per member plus an unclaimed tip, summing to the amount
              const parts = allocate(amount, [...members.map((_, i) => w(i)), 1]);
              split = {
                method,
                participants: members,
                lineItems: [
                  ...members.map((memberId, i) => ({
                    lineId: `l${i}`,
                    label: `l${i}`,
                    amount: parts[i] ?? usd(0),
                    claimedBy: [memberId],
                    kind: 'item' as const,
                  })),
                  {
                    lineId: 'tip',
                    label: 'tip',
                    amount: parts[members.length] ?? usd(0),
                    claimedBy: [],
                    kind: 'tip' as const,
                  },
                ],
              };
              break;
            }
          }
          seen.add(method);
          const e = famExpense({ amountMinor, payer, split });
          const folded = foldShares(computeShares(e, FAMILY_CTX), folding, FAMILY_IDS);
          expect(folded.reduce((a, s) => a + s.amount.amountMinor, 0)).toBe(amountMinor);
          expect(folded.some((s) => s.memberId === LILY)).toBe(false);
          expect(folded.every((s) => Number.isSafeInteger(s.amount.amountMinor))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
    expect([...seen].sort()).toEqual(['equal', 'exact', 'exclude', 'itemized', 'weighted']);
  });
});
