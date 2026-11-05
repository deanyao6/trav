import { describe, expect, it } from 'vitest';
import { rankPlaces, tierForPerPerson } from './places.js';
import type { PricedPlace, PriceLevel } from './places.js';

const p = (id: string, level: PriceLevel, per: number): PricedPlace => ({
  placeId: id,
  priceLevel: level,
  perPersonMinor: per,
});

const CATALOG = [
  p('a1', 1, 900),
  p('a2', 1, 1400),
  p('b1', 2, 2400),
  p('b2', 2, 2800),
  p('c1', 3, 4800),
  p('c2', 3, 6500),
  p('d1', 4, 9500),
  p('d2', 4, 12000),
];

const levels = (target: 'budget' | 'mid' | 'high', extra = {}) =>
  rankPlaces(CATALOG, { target, ...extra }).map((r) => r.place.priceLevel);

describe('rankPlaces', () => {
  it('shifts the price level with the tier', () => {
    expect(levels('budget')).toEqual([1, 1, 2]);
    expect(levels('mid')).toEqual([2, 2, 3]);
    expect(levels('high')).toEqual([4, 4, 3]);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(levels('budget'))).toBeLessThan(avg(levels('mid')));
    expect(avg(levels('mid'))).toBeLessThan(avg(levels('high')));
  });

  it('is deterministic: catalog order breaks ties', () => {
    expect(rankPlaces(CATALOG, { target: 'budget' }).map((r) => r.place.placeId)).toEqual([
      'a1',
      'a2',
      'b1',
    ]);
    expect(rankPlaces(CATALOG, { target: 'budget' })).toEqual(
      rankPlaces(CATALOG, { target: 'budget' }),
    );
  });

  it('a stretch adds one step-up alternate above the main picks', () => {
    const out = rankPlaces(CATALOG, { target: 'budget', stretch: 'mid' });
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).map((r) => r.place.priceLevel)).toEqual([1, 1]);
    expect(out[2]).toMatchObject({ stepUp: true });
    expect(out[2]!.place.priceLevel).toBe(2);
  });

  it('a stretch equal to the target is ignored', () => {
    expect(rankPlaces(CATALOG, { target: 'mid', stretch: 'mid' }).every((r) => !r.stepUp)).toBe(
      true,
    );
  });

  it('a budget orders in-budget first and marks the rest, never drops them', () => {
    const out = rankPlaces(CATALOG, { target: 'high', perPersonBudgetMinor: 5000 });
    expect(out).toHaveLength(3);
    expect(out[0]!.place.perPersonMinor).toBeLessThanOrEqual(5000);
    // exactly at the figure is in budget
    const exact = rankPlaces([p('x', 3, 5000), p('y', 3, 5001)], {
      target: 'mid',
      perPersonBudgetMinor: 5000,
    });
    expect(exact.map((r) => [r.place.placeId, r.overBudget])).toEqual([
      ['x', false],
      ['y', true],
    ]);
    // everything over: still shown, all marked
    const all = rankPlaces(CATALOG, { target: 'budget', perPersonBudgetMinor: 100 });
    expect(all).toHaveLength(3);
    expect(all.every((r) => r.overBudget)).toBe(true);
  });

  it('empty catalog, tiny catalog and count', () => {
    expect(rankPlaces([], { target: 'mid' })).toEqual([]);
    expect(rankPlaces([p('a', 1, 100)], { target: 'high', stretch: 'high' })).toHaveLength(1);
    expect(rankPlaces(CATALOG, { target: 'mid', count: 5 })).toHaveLength(5);
    expect(rankPlaces(CATALOG, { target: 'mid', count: 0 })).toHaveLength(1);
  });
});

describe('tierForPerPerson', () => {
  it('reads a per-head figure as a tier, inclusive at the bands', () => {
    expect(tierForPerPerson(1500)).toBe('budget');
    expect(tierForPerPerson(2500)).toBe('budget');
    expect(tierForPerPerson(2501)).toBe('mid');
    expect(tierForPerPerson(6000)).toBe('mid');
    expect(tierForPerPerson(6001)).toBe('high');
  });
});
