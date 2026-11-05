/** T-167: the `spending_tier` probe and grader. */
import { describe, expect, it } from 'vitest';
import { probeSpendingTier } from '../runner/probes.js';
import type { SpendingTierCase } from '../runner/probes.js';
import { episode, OFFLINE, scenario } from '../testing.js';
import type { GraderResult } from '../types.js';
import { spendingTier } from './quality.js';

function graded(cases: readonly SpendingTierCase[]): readonly GraderResult[] {
  const ep = episode({ probes: [{ probe: 'spending_tier', stepIndex: 0, result: { cases } }] });
  return spendingTier.grade(ep, scenario(), OFFLINE) as readonly GraderResult[];
}

describe('spending_tier probe', () => {
  it('covers the high-end, budget and mixed Barcelona variants, all as labeled', async () => {
    const { cases } = await probeSpendingTier();
    expect(cases.map((c) => c.fixture)).toEqual([
      'barcelona-budget',
      'barcelona-high',
      'barcelona-mixed',
    ]);
    for (const c of cases) expect(c.members).toEqual(c.expectedMembers);
    const hi = cases.find((c) => c.fixture === 'barcelona-high')!;
    const lo = cases.find((c) => c.fixture === 'barcelona-budget')!;
    expect(Math.min(...hi.restaurantLevels)).toBeGreaterThan(Math.max(...lo.restaurantLevels));
    // A conflict gets no list (Trav asks instead).
    expect(cases.find((c) => c.fixture === 'barcelona-mixed')!.restaurantLevels).toEqual([]);
  });

  it('the grader passes the real probe and fails a mislabel or a wrong price level', async () => {
    const { cases } = await probeSpendingTier();
    const ok = graded(cases);
    expect(ok[0]!.pass).toBe(true);
    expect(ok[0]!.skipped).toBeUndefined();

    const hi = cases.find((c) => c.fixture === 'barcelona-high')!;
    const mislabel = graded([{ ...hi, members: { ...hi.members, mem_dean: 'budget' } }]);
    expect(mislabel[0]!.pass).toBe(false);
    const cheapList = graded([{ ...hi, restaurantLevels: [1, 2, 4] }]);
    expect(cheapList[0]!.pass).toBe(false);
    const wrongGroup = graded([{ ...hi, group: { status: 'conflict' } }]);
    expect(wrongGroup[0]!.pass).toBe(false);
  });

  it('no probe in the episode is skipped, not passed silently', () => {
    expect(graded([])[0]!.skipped).toBeDefined();
  });
});
