/**
 * Flagship scenario (MOTIVATION.md): six friends from six US cities, home to
 * six different ones. Acceptance for T-014: the top pick beats naive
 * cheapest-per-person on arrival spread, constraints are respected or
 * explicitly relaxed with a reason, and the run stays under 2s.
 */
import { describe, expect, it } from 'vitest';
import { money } from '../money.js';
import {
  bruteForceOptimize,
  cheapestPerPerson,
  optimizeGroupFlights,
  scoreItinerary,
} from './index.js';
import type { GroupItinerary } from './index.js';
import { BARCELONA_MEMBERS, CHASE, barcelonaInput } from './testkit.js';

const keyOf = (it: GroupItinerary): string => it.picks.map((p) => p.offerId).join('|');
const eur = (major: number) => money(major * 100, 'EUR');

describe('Barcelona: 6 origins, 6 different return cities', () => {
  const input = barcelonaInput();

  it('runs under 2s and returns at most 3 ranked itineraries', () => {
    const t0 = performance.now();
    const r = optimizeGroupFlights(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r.missing).toEqual([]);
    expect(r.itineraries.length).toBeLessThanOrEqual(3);
    expect(r.itineraries.map((i) => i.rank)).toEqual([1, 2, 3]);
    const scores = r.itineraries.map((i) => i.breakdown.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
  });

  it('top pick beats naive cheapest-per-person on arrival spread (and overall)', () => {
    const top = optimizeGroupFlights(input).itineraries[0] as GroupItinerary;
    const naive = scoreItinerary(cheapestPerPerson(input), input);
    expect(naive.arrivalSpreadMinutes).toBe(925); // 06:50 → 22:15
    expect(top.breakdown.arrivalSpreadMinutes).toBe(80); // 09:40 → 11:00
    expect(top.breakdown.arrivalSpreadMinutes).toBeLessThan(naive.arrivalSpreadMinutes);
    expect(top.breakdown.departureSpreadMinutes).toBeLessThan(naive.departureSpreadMinutes);
    expect(top.breakdown.score).toBeLessThan(naive.score);
    // It costs more than the cheapest combo and says so.
    expect(top.breakdown.totalCost).toEqual(eur(2689));
    expect(naive.totalCost).toEqual(eur(2470));
  });

  it('matches the exhaustive oracle on the full fixture', () => {
    const fast = optimizeGroupFlights(input);
    const slow = bruteForceOptimize(input);
    expect(fast.itineraries.map(keyOf)).toEqual(slow.itineraries.map(keyOf));
    expect(fast.itineraries.map(keyOf)).toEqual([
      'bos-2|sfo-2|ord-2|atl-2|den-2|iad-2',
      'bos-2|sfo-2|ord-2|atl-2|den-3|iad-2',
      'bos-2|sfo-2|ord-2|atl-3|den-2|iad-2',
    ]);
  });

  it('one-line lowercase rationale with the refundable flag', () => {
    const top = optimizeGroupFlights(input).itineraries[0] as GroupItinerary;
    expect(top.rationale).toBe(
      'everyone lands within 80 min, leaves within 25 min, €399–€538 each, €2,689 total, all refundable, +€219 vs cheapest',
    );
    expect(top.rationale.includes('\n')).toBe(false);
    expect(top.rationale[0]).toBe(top.rationale[0]?.toLowerCase());
    expect(top.allRefundable).toBe(true);
    expect(top.relaxed).toEqual([]);
  });

  it('picks are in member order, one per member, each flying home to their own city', () => {
    const top = optimizeGroupFlights(input).itineraries[0] as GroupItinerary;
    expect(top.picks.map((p) => p.memberId)).toEqual(BARCELONA_MEMBERS.map((m) => m.memberId));
    top.picks.forEach((p, i) => {
      expect(p.outbound.origin).toBe(BARCELONA_MEMBERS[i]?.origin);
      expect(p.inbound?.destination).toBe(BARCELONA_MEMBERS[i]?.returnTo);
    });
    expect(top.perPerson.map((p) => p.price.amountMinor)).toEqual([
      41200, 53800, 43000, 44500, 46500, 39900,
    ]);
  });

  it('the default 25% fairness limit holds for the top pick (Chase €538 vs median €437.50)', () => {
    const top = optimizeGroupFlights(input).itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([]);
    expect(top.perPerson[1]?.price).toEqual(eur(538));
  });

  it('a tighter 15% fairness limit is honoured without relaxing', () => {
    const r = optimizeGroupFlights(
      barcelonaInput({ constraints: { fairnessMaxAboveMedian: 0.15 } }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([]);
    // The limit is about the gap between members, so the optimizer lifts the
    // median (Dean and Crowley on slightly pricier mid-morning fares) rather than
    // send Chase on the 22:15 landing; still +€153 over the 25% pick.
    expect(keyOf(top)).toBe('bos-4|sfo-2|ord-2|atl-2|den-3|iad-2');
    const prices = top.perPerson.map((p) => p.price.amountMinor).sort((a, b) => a - b);
    const median2 = (prices[2] ?? 0) + (prices[3] ?? 0);
    for (const p of top.perPerson)
      expect(2 * p.price.amountMinor * 100).toBeLessThanOrEqual(median2 * 115);
  });

  it('with Chase opted out of the fairness limit, the 25% pick comes back under 15%', () => {
    const members = BARCELONA_MEMBERS.map((m) =>
      m.memberId === CHASE ? { ...m, fairnessOptOut: true } : m,
    );
    const r = optimizeGroupFlights(
      barcelonaInput({ members, constraints: { fairnessMaxAboveMedian: 0.15 } }),
    );
    expect(keyOf(r.itineraries[0] as GroupItinerary)).toBe('bos-2|sfo-2|ord-2|atl-2|den-2|iad-2');
    expect(r.itineraries[0]?.relaxed).toEqual([]);
  });

  it('cap €538: Chase lands exactly at the cap and nothing is relaxed', () => {
    const r = optimizeGroupFlights(
      barcelonaInput({ constraints: { perPersonCap: eur(538), fairnessMaxAboveMedian: 0.25 } }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([]);
    expect(top.perPerson[1]?.price).toEqual(eur(538));
    for (const it of r.itineraries) {
      for (const p of it.perPerson) expect(p.price.amountMinor).toBeLessThanOrEqual(53800);
    }
  });

  it('cap €450: nothing from SFO fits, so the cap is relaxed and the reason says why', () => {
    const r = optimizeGroupFlights(
      barcelonaInput({ constraints: { perPersonCap: eur(450), fairnessMaxAboveMedian: 0.25 } }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed).toEqual([
      { constraint: 'perPersonCap', reason: "over the €450/person cap: Chase's cheapest is €498" },
    ]);
    expect(top.rationale.endsWith(' · cap relaxed')).toBe(true);
    // Fairness was not relaxed and still holds.
    expect(top.relaxed.some((x) => x.constraint === 'fairnessMaxAboveMedian')).toBe(false);
  });

  it('refundable-only is feasible here: the top pick is already all refundable', () => {
    const r = optimizeGroupFlights(
      barcelonaInput({ constraints: { refundableOnly: true, fairnessMaxAboveMedian: 0.25 } }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([]);
    for (const it of r.itineraries) expect(it.allRefundable).toBe(true);
  });

  it('an impossible 30-min arrival window is relaxed with the closest achievable spread', () => {
    const r = optimizeGroupFlights(
      barcelonaInput({
        constraints: { maxArrivalSpreadMinutes: 30, fairnessMaxAboveMedian: 0.25 },
      }),
    );
    expect(r.itineraries[0]?.relaxed).toEqual([
      {
        constraint: 'maxArrivalSpreadMinutes',
        reason: 'no combo lands everyone within 30 min; closest is 40 min',
      },
    ]);
    // A feasible 90-min window is honoured.
    const ok = optimizeGroupFlights(
      barcelonaInput({
        constraints: { maxArrivalSpreadMinutes: 90, fairnessMaxAboveMedian: 0.25 },
      }),
    );
    expect(ok.itineraries[0]?.relaxed).toEqual([]);
    for (const it of ok.itineraries)
      expect(it.breakdown.arrivalSpreadMinutes).toBeLessThanOrEqual(90);
  });

  it('everything at once: relaxes the smallest set, each with a reason, and keeps the rest', () => {
    const r = optimizeGroupFlights(
      barcelonaInput({
        constraints: {
          maxArrivalSpreadMinutes: 30,
          refundableOnly: true,
          perPersonCap: eur(400),
          fairnessMaxAboveMedian: 0.05,
        },
      }),
    );
    const top = r.itineraries[0] as GroupItinerary;
    expect(top.relaxed.map((x) => x.constraint)).toEqual([
      'maxArrivalSpreadMinutes',
      'refundableOnly',
      'perPersonCap',
    ]);
    for (const x of top.relaxed) expect(x.reason).toMatch(/^[a-z]/);
    expect(top.relaxed[2]?.reason).toBe(
      "over the €400/person cap: Chase's cheapest is €498, Arjun's cheapest is €405 and Crowley's cheapest is €420",
    );
    // Fairness 5% was kept, so every fare is within 5% of the median.
    const prices = top.perPerson.map((p) => p.price.amountMinor).sort((a, b) => a - b);
    const median2 = (prices[2] ?? 0) + (prices[3] ?? 0);
    for (const p of top.perPerson)
      expect(2 * p.price.amountMinor * 100).toBeLessThanOrEqual(median2 * 105);
    expect(top.rationale.endsWith(' · arrival window, refundable-only and cap relaxed')).toBe(true);
  });

  it('Henry sick: five travelers, optimized without him', () => {
    const five = BARCELONA_MEMBERS.filter((m) => m.memberId !== 'mem_henry');
    const r = optimizeGroupFlights(
      barcelonaInput({
        members: five,
        choices: input.choices.filter((c) => c.memberId !== 'mem_henry'),
      }),
    );
    expect(r.missing).toEqual([]);
    expect(r.itineraries[0]?.picks).toHaveLength(5);
    expect(r.itineraries[0]?.picks.some((p) => p.memberId === 'mem_henry')).toBe(false);
  });
});
