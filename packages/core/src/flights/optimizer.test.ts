import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addMinutes } from '../clock.js';
import { TravError } from '../errors.js';
import { money } from '../money.js';
import type { Money } from '../money.js';
import {
  DEFAULT_WEIGHTS,
  bruteForceOptimize,
  cheapestPerPerson,
  formatMinutes,
  optimizeGroupFlights,
  scoreItinerary,
} from './index.js';
import type {
  FlightChoice,
  GroupItinerary,
  MemberTravel,
  OptimizerConstraints,
  OptimizerInput,
  OptimizerWeights,
} from './index.js';
import { choice, inputOf, syntheticInput } from './testkit.js';

const eur = (major: number): Money => money(major * 100, 'EUR');
const at = (hhmm: string): string => `2026-03-13T${hhmm}:00+01:00`;
const member = (id: string, extra: Partial<MemberTravel> = {}): MemberTravel => ({
  memberId: id,
  name: id.replace('mem_', ''),
  origin: 'XXX',
  returnTo: 'YYY',
  ...extra,
});

function expectTravError(fn: () => unknown, code: TravError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TravError);
  expect((caught as TravError).code).toBe(code);
}

const keyOf = (it: GroupItinerary): string => it.picks.map((p) => p.offerId).join('|');

/** Independent fairness check (no shared code with the module): exact integer math. */
function fairnessHolds(
  it: GroupItinerary,
  members: readonly MemberTravel[],
  maxAbove: number,
): boolean {
  const prices = it.perPerson.map((p) => p.price.amountMinor);
  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;
  const m2 =
    n % 2 === 1 ? 2 * (sorted[(n - 1) / 2] ?? 0) : (sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0);
  const ppm = BigInt(Math.round(maxAbove * 1_000_000));
  return it.perPerson.every((p, i) => {
    if (members[i]?.fairnessOptOut === true) return true;
    return BigInt(2 * p.price.amountMinor) * 1_000_000n <= BigInt(m2) * (1_000_000n + ppm);
  });
}

/** Every hard constraint the result claims to honour actually holds. */
function assertHonoured(it: GroupItinerary, input: OptimizerInput): void {
  const relaxed = new Set(it.relaxed.map((r) => r.constraint));
  const c = input.constraints;
  const presentMembers = input.members.filter((m) =>
    it.perPerson.some((p) => p.memberId === m.memberId),
  );
  if (c.perPersonCap !== undefined && !relaxed.has('perPersonCap')) {
    for (const p of it.perPerson)
      expect(p.price.amountMinor).toBeLessThanOrEqual(c.perPersonCap.amountMinor);
  }
  if (c.refundableOnly === true && !relaxed.has('refundableOnly')) {
    expect(it.allRefundable).toBe(true);
  }
  if (c.maxArrivalSpreadMinutes !== undefined && !relaxed.has('maxArrivalSpreadMinutes')) {
    expect(it.breakdown.arrivalSpreadMinutes).toBeLessThanOrEqual(c.maxArrivalSpreadMinutes);
  }
  if (c.fairnessMaxAboveMedian !== undefined && !relaxed.has('fairnessMaxAboveMedian')) {
    expect(fairnessHolds(it, presentMembers, c.fairnessMaxAboveMedian)).toBe(true);
  }
  for (const r of it.relaxed) expect(r.reason.length).toBeGreaterThan(0);
}

describe('scoreItinerary', () => {
  const members = [member('mem_a'), member('mem_b')];
  const a = choice({
    memberId: 'mem_a',
    offerId: 'a1',
    price: 400,
    origin: 'BOS',
    arriveAt: at('09:00'),
    layover: 45,
    inbound: {
      to: 'JFK',
      departAt: '2026-03-16T12:00:00+01:00',
      arriveAt: '2026-03-16T15:00:00-04:00',
      layover: 150,
    },
  });
  const b = choice({
    memberId: 'mem_b',
    offerId: 'b1',
    price: 512.5,
    origin: 'SFO',
    arriveAt: at('10:30'),
    inbound: {
      to: 'LAX',
      departAt: '2026-03-16T13:00:00+01:00',
      arriveAt: '2026-03-16T18:00:00-07:00',
    },
  });
  const input = inputOf({ members, choices: [a, b] });

  it('computes every term in minutes and the cost in integer minor units', () => {
    const s = scoreItinerary([a, b], input);
    expect(s.arrivalSpreadMinutes).toBe(90);
    expect(s.departureSpreadMinutes).toBe(60);
    // 15:00-04:00 = 19:00Z; 18:00-07:00 = 01:00Z next day → 360 min apart.
    expect(s.returnSpreadMinutes).toBe(360);
    expect(s.totalCost).toEqual(money(91250, 'EUR'));
    expect(s.worstLayoverMinutes).toBe(150);
    // 1×90 + 0.5×60 + 0.5×360 + 1×912.5 + 0.5×150 = 90 + 30 + 180 + 912.5 + 75
    expect(s.score).toBe(1287.5);
  });

  it('weights are applied per major unit of cost', () => {
    const w: OptimizerWeights = {
      ...DEFAULT_WEIGHTS,
      totalCost: 2,
      arrivalSpread: 0,
      departureSpread: 0,
      returnSpread: 0,
      worstLayover: 0,
    };
    expect(scoreItinerary([a, b], { ...input, weights: w }).score).toBe(1825);
  });

  it('one-way choices contribute no departure or return spread', () => {
    const oneWay = [
      { ...a, inbound: undefined } as unknown as FlightChoice,
      { ...b, inbound: undefined } as unknown as FlightChoice,
    ].map((c) => {
      const { inbound: _drop, ...rest } = c;
      return rest as FlightChoice;
    });
    const s = scoreItinerary(oneWay, input);
    expect(s.departureSpreadMinutes).toBe(0);
    expect(s.returnSpreadMinutes).toBe(0);
    expect(s.worstLayoverMinutes).toBe(45);
  });

  it('empty picks score zero', () => {
    const s = scoreItinerary([], input);
    expect(s).toEqual({
      arrivalSpreadMinutes: 0,
      departureSpreadMinutes: 0,
      returnSpreadMinutes: 0,
      totalCost: money(0, 'EUR'),
      worstLayoverMinutes: 0,
      score: 0,
    });
  });

  it('rejects mixed currencies', () => {
    const usd = { ...b, price: money(50000, 'USD') };
    expectTravError(() => scoreItinerary([a, usd], input), 'currency_mismatch');
  });
});

describe('input validation', () => {
  const members = [member('mem_a')];
  const ok = choice({
    memberId: 'mem_a',
    offerId: 'a1',
    price: 100,
    origin: 'BOS',
    arriveAt: at('09:00'),
  });

  it('unknown member on a choice', () => {
    const stray = choice({
      memberId: 'mem_zz',
      offerId: 'z',
      price: 100,
      origin: 'BOS',
      arriveAt: at('09:00'),
    });
    expectTravError(
      () => optimizeGroupFlights(inputOf({ members, choices: [ok, stray] })),
      'invalid_argument',
    );
  });

  it('duplicate member', () => {
    expectTravError(
      () =>
        optimizeGroupFlights(
          inputOf({ members: [member('mem_a'), member('mem_a')], choices: [ok] }),
        ),
      'duplicate',
    );
  });

  it('currency mismatch between choices, and between cap and choices', () => {
    const usd = choice({
      memberId: 'mem_a',
      offerId: 'a2',
      price: 100,
      currency: 'USD',
      origin: 'BOS',
      arriveAt: at('09:00'),
    });
    expectTravError(
      () => optimizeGroupFlights(inputOf({ members, choices: [ok, usd] })),
      'currency_mismatch',
    );
    expectTravError(
      () =>
        optimizeGroupFlights(
          inputOf({ members, choices: [ok], constraints: { perPersonCap: money(1, 'USD') } }),
        ),
      'currency_mismatch',
    );
  });

  it('maxResults and weights', () => {
    expectTravError(
      () => optimizeGroupFlights(inputOf({ members, choices: [ok], maxResults: 0 })),
      'invalid_argument',
    );
    expectTravError(
      () =>
        optimizeGroupFlights(
          inputOf({ members, choices: [ok], weights: { ...DEFAULT_WEIGHTS, totalCost: -1 } }),
        ),
      'invalid_argument',
    );
    expectTravError(
      () =>
        optimizeGroupFlights(
          inputOf({ members, choices: [ok], constraints: { fairnessMaxAboveMedian: -0.1 } }),
        ),
      'invalid_argument',
    );
  });

  it('perPersonCap: negative and fractional amounts are rejected; zero is allowed', () => {
    expectTravError(
      () =>
        optimizeGroupFlights(
          inputOf({ members, choices: [ok], constraints: { perPersonCap: money(-500, 'EUR') } }),
        ),
      'invalid_argument',
    );
    // Built by hand: money() itself would refuse the fractional amount.
    const fractional = { amountMinor: 450.5, currency: 'EUR' } as Money;
    expectTravError(
      () =>
        optimizeGroupFlights(
          inputOf({ members, choices: [ok], constraints: { perPersonCap: fractional } }),
        ),
      'invalid_argument',
    );
    const zeroCap = optimizeGroupFlights(
      inputOf({ members, choices: [ok], constraints: { perPersonCap: money(0, 'EUR') } }),
    );
    expect(zeroCap.itineraries[0]?.relaxed.map((r) => r.constraint)).toEqual(['perPersonCap']);
  });

  it('never calls the wall clock (times come from the choices only)', () => {
    // Behavioural check: identical inputs give identical outputs regardless of when they run.
    const first = optimizeGroupFlights(inputOf({ members, choices: [ok] }));
    const second = optimizeGroupFlights(inputOf({ members, choices: [ok] }));
    expect(first).toEqual(second);
  });
});

describe('edge cases', () => {
  it('empty group returns nothing and nothing missing', () => {
    expect(optimizeGroupFlights(inputOf({ members: [], choices: [] }))).toEqual({
      itineraries: [],
      missing: [],
    });
  });

  it('a member with no choices is reported missing and the rest are optimized', () => {
    const members = [member('mem_a'), member('mem_b'), member('mem_c')];
    const choices = [
      choice({
        memberId: 'mem_a',
        offerId: 'a1',
        price: 100,
        origin: 'BOS',
        arriveAt: at('09:00'),
      }),
      choice({
        memberId: 'mem_c',
        offerId: 'c1',
        price: 120,
        origin: 'ORD',
        arriveAt: at('09:30'),
      }),
    ];
    const r = optimizeGroupFlights(inputOf({ members, choices }));
    expect(r.missing).toEqual(['mem_b']);
    expect(r.itineraries).toHaveLength(1);
    expect(r.itineraries[0]?.picks.map((p) => p.memberId)).toEqual(['mem_a', 'mem_c']);
    expect(r.itineraries[0]?.perPerson.map((p) => p.memberId)).toEqual(['mem_a', 'mem_c']);
  });

  it('everyone missing: no itineraries', () => {
    const r = optimizeGroupFlights(inputOf({ members: [member('mem_a')], choices: [] }));
    expect(r).toEqual({ itineraries: [], missing: ['mem_a'] });
  });

  it('the same offer sent twice is one option', () => {
    const members = [member('mem_a'), member('mem_b')];
    const a1 = choice({
      memberId: 'mem_a',
      offerId: 'a1',
      price: 100,
      origin: 'BOS',
      arriveAt: at('09:00'),
    });
    const b1 = choice({
      memberId: 'mem_b',
      offerId: 'b1',
      price: 100,
      origin: 'ORD',
      arriveAt: at('09:00'),
    });
    const r = optimizeGroupFlights(
      inputOf({ members, choices: [a1, a1, b1, { ...b1 }], maxResults: 5 }),
    );
    expect(r.itineraries).toHaveLength(1);
  });

  it('a single traveler gets a rationale without group phrasing', () => {
    const r = optimizeGroupFlights(
      inputOf({
        members: [member('mem_a')],
        choices: [
          choice({
            memberId: 'mem_a',
            offerId: 'a1',
            price: 100,
            origin: 'BOS',
            arriveAt: at('09:00'),
            refundable: true,
          }),
        ],
      }),
    );
    expect(r.itineraries[0]?.rationale).toBe('€100, all refundable, cheapest combo');
  });

  it('results are ranked by score, distinct, and capped at maxResults', () => {
    const input = syntheticInput(4, 5, 11, { maxResults: 3 });
    const r = optimizeGroupFlights(input);
    expect(r.itineraries).toHaveLength(3);
    expect(r.itineraries.map((i) => i.rank)).toEqual([1, 2, 3]);
    const scores = r.itineraries.map((i) => i.breakdown.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(new Set(r.itineraries.map(keyOf)).size).toBe(3);
    for (const it of r.itineraries) {
      expect(it.breakdown).toEqual(scoreItinerary(it.picks, input));
      expect(it.allRefundable).toBe(it.picks.every((p) => p.refundable));
    }
  });

  it('result does not depend on the order choices or members are given', () => {
    const input = syntheticInput(5, 6, 21, { constraints: { fairnessMaxAboveMedian: 0.3 } });
    const shuffled: OptimizerInput = {
      ...input,
      choices: [...input.choices].reverse(),
    };
    const a = optimizeGroupFlights(input).itineraries.map(keyOf);
    const b = optimizeGroupFlights(shuffled).itineraries.map(keyOf);
    expect(b).toEqual(a);
  });
});

describe('per-person cap', () => {
  const members = [member('mem_a'), member('mem_b')];
  const choices = [
    choice({
      memberId: 'mem_a',
      offerId: 'a-cheap',
      price: 300,
      origin: 'BOS',
      arriveAt: at('06:00'),
    }),
    choice({
      memberId: 'mem_a',
      offerId: 'a-cap',
      price: 450,
      origin: 'BOS',
      arriveAt: at('10:00'),
    }),
    choice({
      memberId: 'mem_a',
      offerId: 'a-over',
      price: 451,
      origin: 'BOS',
      arriveAt: at('10:00'),
    }),
    choice({ memberId: 'mem_b', offerId: 'b1', price: 420, origin: 'SFO', arriveAt: at('10:00') }),
  ];

  it('spending exactly at the cap is allowed; one minor unit over is not', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { perPersonCap: eur(450) } }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([]);
    expect(top.picks.map((p) => p.offerId)).toEqual(['a-cap', 'b1']);
    const overCap = r.itineraries
      .flatMap((i) => i.picks)
      .filter((p) => p.price.amountMinor > 45000);
    expect(overCap).toEqual([]);
  });

  it('with refundable-only kept, the reason names the cheapest refundable fare', () => {
    const mixed = [
      choice({
        memberId: 'mem_a',
        offerId: 'a1',
        price: 400,
        origin: 'BOS',
        arriveAt: at('10:00'),
        refundable: true,
      }),
      choice({
        memberId: 'mem_b',
        offerId: 'b-cheap',
        price: 460,
        origin: 'SFO',
        arriveAt: at('10:00'),
      }),
      choice({
        memberId: 'mem_b',
        offerId: 'b-ref',
        price: 600,
        origin: 'SFO',
        arriveAt: at('10:00'),
        refundable: true,
      }),
    ];
    const r = optimizeGroupFlights(
      inputOf({
        members,
        choices: mixed,
        constraints: { perPersonCap: eur(450), refundableOnly: true },
      }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([
      {
        constraint: 'perPersonCap',
        reason: "over the €450/person cap: b's cheapest refundable is €600",
      },
    ]);
    expect(top.allRefundable).toBe(true);
    expect(top.picks.map((p) => p.offerId)).toEqual(['a1', 'b-ref']);
  });

  it('a cap nobody can meet is relaxed with a reason naming who and why', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { perPersonCap: eur(400) } }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([
      { constraint: 'perPersonCap', reason: "over the €400/person cap: b's cheapest is €420" },
    ]);
    expect(top.rationale.endsWith(' · cap relaxed')).toBe(true);
    // Once relaxed, the normal objective applies: a lands with b at 10:00 for €450.
    expect(top.picks.map((p) => p.offerId)).toEqual(['a-cap', 'b1']);
  });
});

describe('fairness', () => {
  const members = [member('mem_a'), member('mem_b'), member('mem_c')];
  const base = (bPrice: number, cPrice: number): FlightChoice[] => [
    choice({ memberId: 'mem_a', offerId: 'a1', price: 400, origin: 'BOS', arriveAt: at('10:00') }),
    choice({
      memberId: 'mem_b',
      offerId: 'b1',
      price: bPrice,
      origin: 'ORD',
      arriveAt: at('10:00'),
    }),
    choice({
      memberId: 'mem_c',
      offerId: 'c1',
      price: cPrice,
      origin: 'SFO',
      arriveAt: at('10:00'),
    }),
  ];

  it('exactly at the limit is fair (no float drift: 10% of €500 is €550 on the nose)', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices: base(500, 550), constraints: { fairnessMaxAboveMedian: 0.1 } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([]);
  });

  it('one minor unit over the limit is unfair and, with no alternative, relaxed with a reason', () => {
    const choices = base(500, 550.01);
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { fairnessMaxAboveMedian: 0.1 } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([
      {
        constraint: 'fairnessMaxAboveMedian',
        // 10.002% over, shown rounded up so it never reads as equal to the limit.
        reason: 'c pays €550.01, 10.1% above the median (limit 10%)',
      },
    ]);
  });

  it('whole-percent overshoots stay whole; fractional limits show one decimal', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices: base(500, 700), constraints: { fairnessMaxAboveMedian: 0.125 } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([
      {
        constraint: 'fairnessMaxAboveMedian',
        reason: 'c pays €700, 40% above the median (limit 12.5%)',
      },
    ]);
  });

  it('a member who opted out may exceed the limit without relaxing', () => {
    const optedOut = [
      members[0],
      members[1],
      { ...(members[2] as MemberTravel), fairnessOptOut: true },
    ] as MemberTravel[];
    const r = optimizeGroupFlights(
      inputOf({
        members: optedOut,
        choices: base(500, 900),
        constraints: { fairnessMaxAboveMedian: 0.1 },
      }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([]);
    expect(r.itineraries[0]?.perPerson[2]?.price).toEqual(eur(900));
  });

  it('prefers a fair combination over an unfair cheaper one', () => {
    const choices = [
      ...base(500, 700),
      // c has a fair alternative that lands at an awkward time.
      choice({
        memberId: 'mem_c',
        offerId: 'c-fair',
        price: 540,
        origin: 'SFO',
        arriveAt: at('13:00'),
      }),
    ];
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { fairnessMaxAboveMedian: 0.1 } }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([]);
    expect(top.picks.map((p) => p.offerId)).toEqual(['a1', 'b1', 'c-fair']);
    expect(fairnessHolds(top, members, 0.1)).toBe(true);
  });

  it('even member counts use the mean of the two middle fares as the median', () => {
    const four = [...members, member('mem_d')];
    const choices = [
      ...base(420, 500),
      choice({
        memberId: 'mem_d',
        offerId: 'd1',
        price: 480,
        origin: 'DEN',
        arriveAt: at('10:00'),
      }),
    ];
    // Sorted 400, 420, 480, 500 → median 450 → 10% limit 495 → €500 is over.
    const over = optimizeGroupFlights(
      inputOf({ members: four, choices, constraints: { fairnessMaxAboveMedian: 0.1 } }),
    );
    expect(over.itineraries[0]?.relaxed.map((r) => r.constraint)).toEqual([
      'fairnessMaxAboveMedian',
    ]);
    // 11.2% limit is 500.4 → fair.
    const ok = optimizeGroupFlights(
      inputOf({ members: four, choices, constraints: { fairnessMaxAboveMedian: 0.112 } }),
    );
    expect(ok.itineraries[0]?.relaxed).toEqual([]);
  });
});

describe('arrival window and refundable-only', () => {
  const members = [member('mem_a'), member('mem_b')];
  const choices = [
    choice({
      memberId: 'mem_a',
      offerId: 'a1',
      price: 300,
      origin: 'BOS',
      arriveAt: at('06:00'),
      refundable: true,
    }),
    choice({ memberId: 'mem_a', offerId: 'a2', price: 380, origin: 'BOS', arriveAt: at('09:00') }),
    choice({ memberId: 'mem_b', offerId: 'b1', price: 350, origin: 'SFO', arriveAt: at('10:00') }),
    choice({ memberId: 'mem_b', offerId: 'b2', price: 390, origin: 'SFO', arriveAt: at('12:00') }),
  ];

  it('honours a feasible arrival window', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { maxArrivalSpreadMinutes: 60 } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([]);
    expect(r.itineraries[0]?.picks.map((p) => p.offerId)).toEqual(['a2', 'b1']);
    for (const it of r.itineraries)
      expect(it.breakdown.arrivalSpreadMinutes).toBeLessThanOrEqual(60);
  });

  it('relaxes an impossible window and reports the closest achievable spread', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { maxArrivalSpreadMinutes: 30 } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([
      {
        constraint: 'maxArrivalSpreadMinutes',
        reason: 'no combo lands everyone within 30 min; closest is 60 min',
      },
    ]);
  });

  describe('window reason when fairness is also active', () => {
    const two = [member('mem_a'), member('mem_b')];
    const z = (hhmm: string): string => `2026-03-13T${hhmm}:00Z`;
    const mixed = [
      choice({
        memberId: 'mem_a',
        offerId: 'a-cheap',
        price: 300,
        origin: 'BOS',
        arriveAt: z('10:00'),
      }),
      choice({
        memberId: 'mem_a',
        offerId: 'a-pricey',
        price: 900,
        origin: 'BOS',
        arriveAt: z('12:00'),
      }),
      choice({ memberId: 'mem_b', offerId: 'b1', price: 300, origin: 'SFO', arriveAt: z('14:00') }),
      choice({ memberId: 'mem_b', offerId: 'b2', price: 300, origin: 'SFO', arriveAt: z('12:30') }),
    ];

    it('says the only in-window combos break fairness, and names the closest fair spread', () => {
      const r = optimizeGroupFlights(
        inputOf({
          members: two,
          choices: mixed,
          constraints: { maxArrivalSpreadMinutes: 60, fairnessMaxAboveMedian: 0.1 },
        }),
      );
      const top = r.itineraries[0] as GroupItinerary;
      expect(top.relaxed).toEqual([
        {
          constraint: 'maxArrivalSpreadMinutes',
          reason:
            'the only combos landing everyone within 60 min break the fairness limit; closest fair one is 2h 30m',
        },
      ]);
      // The quoted spread is the pick's own: the reason never claims a spread it can't deliver.
      expect(top.picks.map((p) => p.offerId)).toEqual(['a-cheap', 'b2']);
      expect(top.breakdown.arrivalSpreadMinutes).toBe(150);
      expect(fairnessHolds(top, two, 0.1)).toBe(true);
      // The brute-force oracle agrees on the wording.
      const oracle = bruteForceOptimize(
        inputOf({
          members: two,
          choices: mixed,
          constraints: { maxArrivalSpreadMinutes: 60, fairnessMaxAboveMedian: 0.1 },
        }),
      );
      expect(oracle.itineraries[0]?.relaxed).toEqual(top.relaxed);
    });

    it('when the window is out of reach anyway, quotes both the raw and the fair closest', () => {
      const r = optimizeGroupFlights(
        inputOf({
          members: two,
          choices: mixed,
          constraints: { maxArrivalSpreadMinutes: 20, fairnessMaxAboveMedian: 0.1 },
        }),
      );
      expect(r.itineraries[0]?.relaxed).toEqual([
        {
          constraint: 'maxArrivalSpreadMinutes',
          reason:
            'no combo lands everyone within 20 min; closest is 30 min, closest fair one is 2h 30m',
        },
      ]);
    });
  });

  it('refundable-only: relaxed with the member who has no refundable fare', () => {
    const r = optimizeGroupFlights(
      inputOf({ members, choices, constraints: { refundableOnly: true } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([
      { constraint: 'refundableOnly', reason: 'no refundable fare for b' },
    ]);
    expect(r.itineraries[0]?.allRefundable).toBe(false);
  });

  it('refundable-only: honoured when feasible, even if it costs more', () => {
    const withRefundable = [
      ...choices,
      choice({
        memberId: 'mem_b',
        offerId: 'b3',
        price: 600,
        origin: 'SFO',
        arriveAt: at('07:00'),
        refundable: true,
      }),
    ];
    const r = optimizeGroupFlights(
      inputOf({ members, choices: withRefundable, constraints: { refundableOnly: true } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([]);
    expect(r.itineraries[0]?.allRefundable).toBe(true);
    expect(r.itineraries[0]?.picks.map((p) => p.offerId)).toEqual(['a1', 'b3']);
    expect(r.itineraries[0]?.rationale).toBe(
      'everyone lands within 60 min, €300–€600 each, €900 total, all refundable, +€250 vs cheapest',
    );
  });

  it('relaxes the smallest set of constraints, least painful first', () => {
    // Window 30 is impossible; cap €400 is fine on its own. Only the window should go.
    const r = optimizeGroupFlights(
      inputOf({
        members,
        choices,
        constraints: {
          maxArrivalSpreadMinutes: 30,
          perPersonCap: eur(400),
          fairnessMaxAboveMedian: 0.5,
        },
      }),
    );
    expect(r.itineraries[0]?.relaxed.map((x) => x.constraint)).toEqual(['maxArrivalSpreadMinutes']);
    for (const it of r.itineraries)
      assertHonoured(
        it,
        inputOf({
          members,
          choices,
          constraints: { perPersonCap: eur(400), fairnessMaxAboveMedian: 0.5 },
        }),
      );
  });
});

describe('formatMinutes', () => {
  it('matches VOICE duration style', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(90)).toBe('90 min');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(135)).toBe('2h 15m');
  });
});

// ---------- property tests ----------

const arbChoice = (memberId: string, offerId: string): fc.Arbitrary<FlightChoice> =>
  fc
    .record({
      price: fc.integer({ min: 100, max: 900 }),
      arrive: fc.integer({ min: 0, max: 24 * 60 - 1 }),
      depart: fc.integer({ min: 0, max: 24 * 60 - 1 }),
      layover: fc.integer({ min: 0, max: 300 }),
      refundable: fc.boolean(),
      oneWay: fc.boolean(),
    })
    .map((r) =>
      choice({
        memberId,
        offerId,
        price: r.price,
        origin: 'XXX',
        arriveAt: addMinutes('2026-03-13T00:00:00+01:00', r.arrive),
        layover: r.layover,
        refundable: r.refundable,
        ...(r.oneWay
          ? {}
          : {
              inbound: {
                to: 'YYY',
                departAt: addMinutes('2026-03-16T00:00:00+01:00', r.depart),
                arriveAt: addMinutes('2026-03-16T00:00:00+01:00', r.depart + 500),
              },
            }),
      }),
    );

const arbWeights: fc.Arbitrary<OptimizerWeights> = fc.record({
  arrivalSpread: fc.double({ min: 0, max: 3, noNaN: true }),
  departureSpread: fc.double({ min: 0, max: 3, noNaN: true }),
  returnSpread: fc.double({ min: 0, max: 3, noNaN: true }),
  totalCost: fc.double({ min: 0, max: 3, noNaN: true }),
  worstLayover: fc.double({ min: 0, max: 3, noNaN: true }),
});

const arbConstraints: fc.Arbitrary<OptimizerConstraints> = fc
  .record({
    cap: fc.option(fc.integer({ min: 100, max: 900 }), { nil: undefined }),
    fairness: fc.option(fc.double({ min: 0, max: 0.6, noNaN: true }), { nil: undefined }),
    window: fc.option(fc.integer({ min: 0, max: 600 }), { nil: undefined }),
    refundableOnly: fc.boolean(),
  })
  .map((r) => ({
    ...(r.cap === undefined ? {} : { perPersonCap: eur(r.cap) }),
    ...(r.fairness === undefined ? {} : { fairnessMaxAboveMedian: r.fairness }),
    ...(r.window === undefined ? {} : { maxArrivalSpreadMinutes: r.window }),
    ...(r.refundableOnly ? { refundableOnly: true } : {}),
  }));

const arbInput: fc.Arbitrary<OptimizerInput> = fc
  .record({
    memberCount: fc.integer({ min: 1, max: 4 }),
    counts: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 4, maxLength: 4 }),
    optOut: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    weights: arbWeights,
    constraints: arbConstraints,
    maxResults: fc.integer({ min: 1, max: 3 }),
  })
  .chain((r) => {
    const members: MemberTravel[] = Array.from({ length: r.memberCount }, (_, i) =>
      member(`mem_${i}`, r.optOut[i] ? { fairnessOptOut: true } : {}),
    );
    const choiceArbs = members.flatMap((m, i) =>
      Array.from({ length: r.counts[i] ?? 1 }, (_, j) =>
        arbChoice(m.memberId, `${m.memberId}-${j}`),
      ),
    );
    return fc.tuple(...choiceArbs).map((choices) =>
      inputOf({
        members,
        choices,
        weights: r.weights,
        constraints: r.constraints,
        maxResults: r.maxResults,
      }),
    );
  });

describe('property: optimizer matches brute force on small inputs', () => {
  it('top result objective, picks and relaxed set equal the exhaustive oracle (auto mode)', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const fast = optimizeGroupFlights(input);
        const slow = bruteForceOptimize(input);
        expect(fast.missing).toEqual(slow.missing);
        expect(fast.itineraries.length).toBe(slow.itineraries.length);
        expect(fast.itineraries.map((i) => i.breakdown.score)).toEqual(
          slow.itineraries.map((i) => i.breakdown.score),
        );
        expect(fast.itineraries.map(keyOf)).toEqual(slow.itineraries.map(keyOf));
        expect(fast.itineraries[0]?.relaxed).toEqual(slow.itineraries[0]?.relaxed);
        for (const it of fast.itineraries) assertHonoured(it, input);
      }),
      { numRuns: 300 },
    );
  });

  it('beam mode is exact when the beam is wider than the search space', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const beam = optimizeGroupFlights({ ...input, search: 'beam' });
        const slow = bruteForceOptimize(input);
        expect(beam.itineraries.map(keyOf)).toEqual(slow.itineraries.map(keyOf));
      }),
      { numRuns: 150 },
    );
  });

  it('unconstrained top score equals an in-test enumeration over scoreItinerary', () => {
    fc.assert(
      fc.property(arbInput, (raw) => {
        const input: OptimizerInput = { ...raw, constraints: {} };
        const top = optimizeGroupFlights(input).itineraries[0];
        const perMember = input.members.map((m) =>
          input.choices.filter((c) => c.memberId === m.memberId),
        );
        if (perMember.some((l) => l.length === 0)) {
          // the module reports those as missing; enumerate the rest
        }
        const lists = perMember.filter((l) => l.length > 0);
        if (lists.length === 0) {
          expect(top).toBeUndefined();
          return;
        }
        let best = Infinity;
        const walk = (depth: number, picks: FlightChoice[]): void => {
          if (depth === lists.length) {
            best = Math.min(best, scoreItinerary(picks, input).score);
            return;
          }
          for (const c of lists[depth] ?? []) walk(depth + 1, [...picks, c]);
        };
        walk(0, []);
        expect(top?.breakdown.score).toBe(best);
        expect(top?.relaxed).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

describe('larger inputs', () => {
  it('beam results are feasible and never worse than the cheapest feasible combo', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const input = syntheticInput(6, 12, seed, {
        constraints: { fairnessMaxAboveMedian: 0.4, refundableOnly: false },
      });
      const beam = optimizeGroupFlights({ ...input, search: 'beam' });
      const exact = optimizeGroupFlights({ ...input, search: 'exact' });
      expect(beam.itineraries.length).toBeGreaterThan(0);
      for (const it of beam.itineraries) assertHonoured(it, input);
      const naive = scoreItinerary(cheapestPerPerson(input), input).score;
      expect(beam.itineraries[0]?.breakdown.score).toBeLessThanOrEqual(naive);
      expect(beam.itineraries[0]?.breakdown.score).toBeGreaterThanOrEqual(
        exact.itineraries[0]?.breakdown.score ?? 0,
      );
    }
  });

  it('6 members × 40 offers stays under 2s in auto mode', () => {
    const input = syntheticInput(6, 40, 99, {
      constraints: { fairnessMaxAboveMedian: 0.3, perPersonCap: eur(700) },
    });
    const t0 = performance.now();
    const r = optimizeGroupFlights(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r.itineraries).toHaveLength(3);
    for (const it of r.itineraries) assertHonoured(it, input);
  });

  it('a pathological all-ties input (branch-and-bound worst case) still terminates under 2s', () => {
    const members = Array.from({ length: 6 }, (_, i) => member(`mem_${i}`));
    const choices = members.flatMap((m) =>
      Array.from({ length: 40 }, (_, j) =>
        choice({
          memberId: m.memberId,
          offerId: `${m.memberId}-${j}`,
          price: 400,
          origin: 'XXX',
          arriveAt: at('10:00'),
        }),
      ),
    );
    const t0 = performance.now();
    const r = optimizeGroupFlights(inputOf({ members, choices }));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.itineraries).toHaveLength(3);
    expect(r.itineraries[0]?.breakdown.score).toBe(2400);
  });
});
