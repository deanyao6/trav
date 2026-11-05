import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '../primitives.js';
import {
  CONFLICT_RATIO,
  blendTiers,
  budgetFigureSignal,
  describedTier,
  flightSignal,
  formatVibeFact,
  inferTier,
  lodgingSignal,
  parseVibeFact,
  spendSignal,
  statedTier,
  vibeAnswer,
  vibeWord,
} from './infer.js';
import type { TierInference, TierSignal } from './infer.js';

const EUR = 'EUR' as CurrencyCode;
const sig = (
  tier: TierSignal['tier'],
  weight: number,
  source: TierSignal['source'] = 'spend',
  at?: string,
): TierSignal => ({
  tier,
  weight,
  source,
  ...(at !== undefined ? { at } : {}),
});

describe('inferTier', () => {
  it('no signals is missing (Trav asks instead of guessing)', () => {
    expect(inferTier([])).toMatchObject({ status: 'missing', stated: false });
  });

  it('too little evidence is missing', () => {
    expect(inferTier([sig('high', 0.5)]).status).toBe('missing');
  });

  it('ignores zero, negative and non-finite weights', () => {
    expect(
      inferTier([sig('high', 0), sig('high', -3), sig('high', Number.NaN), sig('high', Infinity)])
        .status,
    ).toBe('missing');
  });

  it('one-sided evidence decides', () => {
    expect(inferTier([sig('high', 2), sig('high', 1)])).toMatchObject({
      status: 'known',
      tier: 'high',
    });
    expect(inferTier([sig('budget', 1.5)])).toMatchObject({ status: 'known', tier: 'budget' });
    expect(inferTier([sig('mid', 1)])).toMatchObject({ status: 'known', tier: 'mid' });
  });

  it('strong high and strong budget of comparable weight is a conflict', () => {
    // first class (2) and a 1-bedroom for six (1.5)
    expect(inferTier([sig('high', 2), sig('budget', 1.5)]).status).toBe('conflict');
    // exactly at the ratio still conflicts
    expect(inferTier([sig('high', 2), sig('budget', 2 * CONFLICT_RATIO)]).status).toBe('conflict');
  });

  it('a weak counter-signal does not conflict: the weighted mean decides', () => {
    expect(inferTier([sig('high', 4), sig('budget', 1)])).toMatchObject({
      status: 'known',
      tier: 'high',
    });
    expect(inferTier([sig('budget', 3), sig('high', 0.5)])).toMatchObject({
      status: 'known',
      tier: 'budget',
    });
  });

  it('high and budget evenly with lots of mid reads as mid', () => {
    expect(inferTier([sig('mid', 4), sig('high', 0.6), sig('budget', 0.6)])).toMatchObject({
      status: 'known',
      tier: 'mid',
    });
  });

  it('a stated signal beats every inferred one, and the latest stated wins', () => {
    const out = inferTier([
      sig('high', 2, 'flight'),
      sig('high', 1.5, 'lodging'),
      sig('budget', 1, 'stated', '2026-03-13T10:00:00+01:00'),
    ]);
    expect(out).toMatchObject({ status: 'known', tier: 'budget', stated: true });
    expect(
      inferTier([
        sig('budget', 1, 'stated', '2026-03-13T10:00:00+01:00'),
        sig('high', 1, 'stated', '2026-03-14T10:00:00+01:00'),
      ]).tier,
    ).toBe('high');
    // same instant: the later array position wins
    expect(inferTier([sig('budget', 1, 'stated', 'x'), sig('mid', 1, 'stated', 'x')]).tier).toBe(
      'mid',
    );
  });

  it('a stated signal settles a conflict', () => {
    expect(inferTier([sig('high', 2), sig('budget', 2), sig('mid', 1, 'stated', 'a')]).tier).toBe(
      'mid',
    );
  });
});

describe('blendTiers: the people going, leaning to the most budget-conscious', () => {
  const k = (tier: TierInference['tier']): TierInference => ({
    status: 'known',
    ...(tier !== undefined ? { tier } : {}),
    weights: { budget: 0, mid: 0, high: 0 },
    stated: false,
  });
  const missing: TierInference = {
    status: 'missing',
    weights: { budget: 0, mid: 0, high: 0 },
    stated: false,
  };
  const conflict: TierInference = {
    status: 'conflict',
    weights: { budget: 2, mid: 0, high: 2 },
    stated: false,
  };

  it('empty group and nobody known are missing', () => {
    expect(blendTiers([])).toEqual({ status: 'missing' });
    expect(blendTiers([missing, missing])).toEqual({ status: 'missing' });
  });

  it('anyone in conflict makes the blend a conflict', () => {
    expect(blendTiers([k('high'), conflict])).toEqual({ status: 'conflict' });
  });

  it('all the same tier: that tier, no stretch', () => {
    expect(blendTiers([k('high'), k('high')])).toEqual({ status: 'known', target: 'high' });
    expect(blendTiers([k('budget')])).toEqual({ status: 'known', target: 'budget' });
  });

  it('a mixed group aims at the lowest tier, one step up as the stretch', () => {
    expect(blendTiers([k('budget'), k('high'), k('high'), k('high')])).toEqual({
      status: 'known',
      target: 'budget',
      stretch: 'mid',
    });
    // the stretch never jumps two steps
    expect(blendTiers([k('budget'), k('high'), k('high'), k('high'), k('high')]).stretch).toBe(
      'mid',
    );
  });

  it('one high among budget folks gives no stretch (the mean rounds to budget)', () => {
    expect(blendTiers([k('budget'), k('budget'), k('budget'), k('budget'), k('high')])).toEqual({
      status: 'known',
      target: 'budget',
    });
  });

  it('members with no signals do not pull the blend', () => {
    expect(blendTiers([k('high'), missing, missing])).toEqual({ status: 'known', target: 'high' });
  });
});

describe('signals from structured facts', () => {
  it('flights: cabin, then routing, then a premium carrier', () => {
    expect(flightSignal({ cabin: 'first', airline: 'Emirates' })).toMatchObject({
      tier: 'high',
      weight: 2,
    });
    expect(flightSignal({ cabin: 'Business' })).toMatchObject({ tier: 'high' });
    expect(flightSignal({ cabin: 'premium economy' })).toMatchObject({ tier: 'mid' });
    expect(
      flightSignal({ cabin: 'economy', airline: 'TAP Air Portugal', layoverMinutes: 300 }),
    ).toMatchObject({
      tier: 'budget',
    });
    expect(flightSignal({ cabin: 'economy', airline: 'Ryanair' })).toMatchObject({
      tier: 'budget',
    });
    expect(flightSignal({ cabin: 'economy', airline: 'Qatar Airways' })).toMatchObject({
      tier: 'mid',
      weight: 0.5,
    });
    expect(
      flightSignal({ cabin: 'economy', airline: 'TAP Air Portugal', layoverMinutes: 90 }),
    ).toBeUndefined();
    expect(flightSignal({})).toBeUndefined();
  });

  it('a layover exactly at 3 hours reads as the cheap routing', () => {
    expect(flightSignal({ layoverMinutes: 180 })?.tier).toBe('budget');
    expect(flightSignal({ layoverMinutes: 179 })).toBeUndefined();
  });

  it('lodging: name, then beds for guests, then price per person per night', () => {
    expect(lodgingSignal({ name: 'the Ritz' })).toMatchObject({ tier: 'high' });
    expect(lodgingSignal({ name: 'Generator', kind: 'hostel' })).toMatchObject({ tier: 'budget' });
    expect(lodgingSignal({ name: 'Raval flat', bedrooms: 1, guests: 6 })).toMatchObject({
      tier: 'budget',
    });
    expect(lodgingSignal({ name: 'Eixample flat', bedrooms: 3, guests: 6 })).toBeUndefined();
    // €600 for 6 over 5 nights = €20 pp/night
    expect(lodgingSignal({ guests: 6, nights: 5, totalMinor: 60000, currency: EUR })?.tier).toBe(
      'budget',
    );
    // €5,400 for 6 over 5 nights = €180 pp/night
    expect(lodgingSignal({ guests: 6, nights: 5, totalMinor: 540000, currency: EUR })?.tier).toBe(
      'high',
    );
    expect(lodgingSignal({ guests: 6, nights: 5, totalMinor: 270000, currency: EUR })?.tier).toBe(
      'mid',
    );
    // exactly at the bands
    expect(lodgingSignal({ guests: 1, nights: 1, totalMinor: 4500, currency: EUR })?.tier).toBe(
      'budget',
    );
    expect(lodgingSignal({ guests: 1, nights: 1, totalMinor: 15000, currency: EUR })?.tier).toBe(
      'high',
    );
    // a currency on another scale gives no money signal
    expect(
      lodgingSignal({ guests: 1, nights: 1, totalMinor: 1500000, currency: 'JPY' }),
    ).toBeUndefined();
    expect(
      lodgingSignal({ guests: 0, nights: 5, totalMinor: 60000, currency: EUR }),
    ).toBeUndefined();
  });

  it('spend: per-person share bands per category', () => {
    expect(spendSignal({ category: 'food', shareMinor: 1200, currency: EUR })?.tier).toBe('budget');
    expect(spendSignal({ category: 'food', shareMinor: 2000, currency: EUR })?.tier).toBe('budget');
    expect(spendSignal({ category: 'food', shareMinor: 3500, currency: EUR })?.tier).toBe('mid');
    expect(spendSignal({ category: 'food', shareMinor: 6000, currency: EUR })?.tier).toBe('high');
    expect(spendSignal({ category: 'transport', shareMinor: 9000, currency: EUR })).toBeUndefined();
    expect(spendSignal({ category: 'food', shareMinor: 0, currency: EUR })).toBeUndefined();
    expect(spendSignal({ category: 'food', shareMinor: 12.5, currency: EUR })).toBeUndefined();
  });

  it("a member's own budget figure, per day", () => {
    expect(budgetFigureSignal({ amountMinor: 8000, currency: EUR, period: 'day' })?.tier).toBe(
      'mid',
    );
    expect(budgetFigureSignal({ amountMinor: 5000, currency: EUR, period: 'day' })?.tier).toBe(
      'budget',
    );
    expect(budgetFigureSignal({ amountMinor: 30000, currency: EUR, period: 'day' })?.tier).toBe(
      'high',
    );
    expect(budgetFigureSignal({ amountMinor: 35000, currency: EUR, period: 'week' })?.tier).toBe(
      'budget',
    );
    expect(
      budgetFigureSignal({ amountMinor: 120000, currency: EUR, period: 'trip', tripDays: 6 })?.tier,
    ).toBe('high');
    expect(
      budgetFigureSignal({ amountMinor: 120000, currency: EUR, period: 'trip' }),
    ).toBeUndefined();
    expect(
      budgetFigureSignal({ amountMinor: 8000, currency: EUR, period: undefined }),
    ).toBeUndefined();
  });
});

describe('signals from words', () => {
  it.each([
    ['first-class Emirates', 'high'],
    ['we are at the Ritz', 'high'],
    ['that tasting menu was unreal', 'high'],
    ['TAP with a 5-hour layover', 'budget'],
    ['a 5 hour layover in lisbon', 'budget'],
    ['a 1-bedroom Airbnb for 6', 'budget'],
    ['kebabs again', 'budget'],
    ['hostel by the beach', 'budget'],
  ] as const)('described: %s', (text, tier) => {
    expect(describedTier(text)).toBe(tier);
  });

  it('described: high and budget words together, or neither, say nothing', () => {
    expect(describedTier('first class to a hostel')).toBeUndefined();
    expect(describedTier('see you at the airport')).toBeUndefined();
  });

  it.each([
    ['can we keep it cheap tonight', 'budget'],
    ['nothing fancy', 'budget'],
    ['something casual', 'budget'],
    ["let's treat ourselves", 'high'],
    ['somewhere nice', 'high'],
    ['fine dining tonight?', 'high'],
    ['not too fancy', 'mid'],
    ['nothing too pricey', 'mid'],
    ['mid-range is fine', 'mid'],
  ] as const)('stated: %s', (text, tier) => {
    expect(statedTier(text)).toBe(tier);
  });

  it('stated: nothing about price', () => {
    expect(statedTier('where should we eat')).toBeUndefined();
    expect(statedTier('who is coming to razz')).toBeUndefined();
  });

  it.each([
    ['casual', 'budget'],
    ['@trav casual', 'budget'],
    ['Casual pls', 'budget'],
    ['keep it cheap', 'budget'],
    ['fancy', 'high'],
    ['fancy tonight!', 'high'],
    ["let's treat ourselves", 'high'],
    ['either', 'mid'],
    ['somewhere in between', 'mid'],
    ['honestly casual lol', 'budget'],
  ] as const)('vibe answer: %s', (text, tier) => {
    expect(vibeAnswer(text)).toBe(tier);
  });

  it('a longer message or an unrelated one is not an answer', () => {
    expect(vibeAnswer('')).toBeUndefined();
    expect(vibeAnswer('get the 5 of us razz tickets')).toBeUndefined();
    expect(
      vibeAnswer('casual but also i want to talk about the flights home tomorrow'),
    ).toBeUndefined();
    expect(vibeAnswer('who is paying')).toBeUndefined();
  });
});

describe('the vibe in group memory', () => {
  it('round-trips and words a tier about the night, never a person', () => {
    expect(formatVibeFact('budget', '2026-03-14')).toBe('the group said casual for 2026-03-14');
    expect(parseVibeFact(formatVibeFact('high', '2026-03-15'))).toEqual({
      tier: 'high',
      localDate: '2026-03-15',
    });
    expect(parseVibeFact(formatVibeFact('mid', '2026-03-15'))?.tier).toBe('mid');
    expect(parseVibeFact('arjun is vegetarian')).toBeUndefined();
    expect(vibeWord('budget')).toBe('casual');
    for (const t of ['budget', 'mid', 'high'] as const) {
      expect(vibeWord(t)).not.toMatch(/cheap|poor|broke|rich|budget/);
    }
  });
});
