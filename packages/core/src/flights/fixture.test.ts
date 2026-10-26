/**
 * Runs the optimizer over the shared `fixtures/flights/barcelona.json`
 * (synthetic-data agent, Duffel-like snake_case offers with local wall-clock
 * times + IANA zones). The mapping below is the only place that knows that
 * shape; `optimizeGroupFlights` sees plain `FlightChoice`s.
 *
 * The inline fixture in `testkit.ts` carries the exact-value acceptance tests
 * (`barcelona.test.ts`); this file checks the same properties on the shared
 * data and skips itself if the file is missing or has moved to another shape.
 */
import { describe, expect, it } from 'vitest';
import { fixtureExists, loadFixture } from '../testkit/fixtures.js';
import { formatIso, zoneOffsetMinutes, zonedWallTimeToMs } from '../clock.js';
import { parseDecimal } from '../money.js';
import {
  DEFAULT_WEIGHTS,
  cheapestPerPerson,
  optimizeGroupFlights,
  scoreItinerary,
} from './index.js';
import type { FlightChoice, GroupItinerary, Leg, MemberTravel, OptimizerInput } from './index.js';

interface RawSegment {
  origin: string;
  destination: string;
  departing_at: string;
  departure_time_zone: string;
  arriving_at: string;
  arrival_time_zone: string;
  flight_number: string;
}
interface RawOffer {
  id: string;
  owner: string;
  total_amount: string;
  conditions: { refund_before_departure: { allowed: boolean } };
  slices: { segments: RawSegment[] }[];
}
interface RawFixture {
  provider: string;
  currency: string;
  travelers: { member_id: string; name: string; origin: string; return_to: string }[];
  offers: RawOffer[];
}

const FIXTURE = 'flights/barcelona.json';

function isRawFixture(x: unknown): x is RawFixture {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Partial<RawFixture>;
  return (
    typeof f.currency === 'string' &&
    Array.isArray(f.travelers) &&
    f.travelers.every((t) => typeof t?.member_id === 'string' && typeof t.origin === 'string') &&
    Array.isArray(f.offers) &&
    f.offers.every(
      (o) =>
        typeof o?.id === 'string' &&
        typeof o.total_amount === 'string' &&
        Array.isArray(o.slices) &&
        o.slices.length === 2 &&
        o.slices.every(
          (s) =>
            Array.isArray(s?.segments) &&
            s.segments.length > 0 &&
            s.segments.every(
              (g) =>
                typeof g?.departing_at === 'string' && typeof g.departure_time_zone === 'string',
            ),
        ),
    )
  );
}

function loadBarcelonaFlights(): RawFixture | null {
  if (!fixtureExists(FIXTURE)) return null;
  const parsed = loadFixture(FIXTURE);
  return isRawFixture(parsed) ? parsed : null;
}

/** `2026-03-12T19:35:00` in `Europe/Madrid` → ISO with the zone's offset at that instant. */
function localToIso(local: string, tz: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m) throw new Error(`unexpected local time ${local}`);
  const ms =
    zonedWallTimeToMs(m[1] as string, Number(m[2]), Number(m[3]), tz) + Number(m[4] ?? 0) * 1000;
  return formatIso(ms, zoneOffsetMinutes(ms, tz));
}

function toLeg(segments: readonly RawSegment[], carrier: string): Leg {
  const first = segments[0] as RawSegment;
  const last = segments[segments.length - 1] as RawSegment;
  const departAt = localToIso(first.departing_at, first.departure_time_zone);
  const arriveAt = localToIso(last.arriving_at, last.arrival_time_zone);
  let longestLayoverMinutes = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1] as RawSegment;
    const next = segments[i] as RawSegment;
    const gap =
      (Date.parse(localToIso(next.departing_at, next.departure_time_zone)) -
        Date.parse(localToIso(prev.arriving_at, prev.arrival_time_zone))) /
      60_000;
    longestLayoverMinutes = Math.max(longestLayoverMinutes, Math.round(gap));
  }
  return {
    origin: first.origin,
    destination: last.destination,
    departAt,
    arriveAt,
    stops: segments.length - 1,
    durationMinutes: Math.round((Date.parse(arriveAt) - Date.parse(departAt)) / 60_000),
    longestLayoverMinutes,
    carrier,
    flightNumbers: segments.map((s) => s.flight_number),
  };
}

function toInput(f: RawFixture): OptimizerInput {
  const members: MemberTravel[] = f.travelers.map((t) => ({
    memberId: t.member_id,
    name: t.name,
    origin: t.origin,
    returnTo: t.return_to,
  }));
  const choices: FlightChoice[] = [];
  for (const m of members) {
    const prefix = `${m.origin.toLowerCase()}-${m.returnTo.toLowerCase()}-`;
    for (const o of f.offers.filter((x) => x.id.startsWith(prefix))) {
      choices.push({
        memberId: m.memberId,
        offerId: o.id,
        provider: f.provider,
        outbound: toLeg((o.slices[0] as RawOffer['slices'][number]).segments, o.owner),
        inbound: toLeg((o.slices[1] as RawOffer['slices'][number]).segments, o.owner),
        price: parseDecimal(o.total_amount, f.currency),
        refundable: o.conditions.refund_before_departure.allowed,
      });
    }
  }
  return {
    destination: 'BCN',
    members,
    choices,
    weights: DEFAULT_WEIGHTS,
    constraints: { fairnessMaxAboveMedian: 0.25 },
    maxResults: 3,
  };
}

const fixture = loadBarcelonaFlights();

describe.skipIf(fixture === null)('shared fixtures/flights/barcelona.json', () => {
  const input = toInput(fixture as RawFixture);

  it('maps to one FlightChoice per offer, every member covered, legs consistent', () => {
    expect(input.choices).toHaveLength((fixture as RawFixture).offers.length);
    for (const m of input.members) {
      const mine = input.choices.filter((c) => c.memberId === m.memberId);
      expect(mine.length).toBeGreaterThan(0);
      for (const c of mine) {
        expect(c.outbound.origin).toBe(m.origin);
        expect(c.outbound.destination).toBe('BCN');
        expect(c.inbound?.origin).toBe('BCN');
        expect(c.inbound?.destination).toBe(m.returnTo);
        expect(c.price.amountMinor).toBeGreaterThan(0);
        expect(Date.parse(c.outbound.arriveAt)).toBeGreaterThan(Date.parse(c.outbound.departAt));
      }
    }
  });

  it('runs under 2s; top pick beats naive cheapest-per-person on arrival spread', () => {
    const t0 = performance.now();
    const r = optimizeGroupFlights(input);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(r.missing).toEqual([]);
    expect(r.itineraries.length).toBeGreaterThan(0);
    expect(r.itineraries.length).toBeLessThanOrEqual(3);

    const top = r.itineraries[0] as GroupItinerary;
    const naive = scoreItinerary(cheapestPerPerson(input), input);
    expect(top.breakdown.arrivalSpreadMinutes).toBeLessThan(naive.arrivalSpreadMinutes);
    expect(top.breakdown.score).toBeLessThanOrEqual(naive.score);
    expect(top.picks.map((p) => p.memberId)).toEqual(input.members.map((m) => m.memberId));
    expect(top.rationale).toMatch(/^everyone lands within /);
    expect(top.rationale.includes('\n')).toBe(false);
  });

  it('the fairness limit is honoured or explicitly relaxed with a reason', () => {
    for (const it of optimizeGroupFlights(input).itineraries) {
      const relaxedFairness = it.relaxed.find((x) => x.constraint === 'fairnessMaxAboveMedian');
      if (relaxedFairness) {
        expect(relaxedFairness.reason).toMatch(/median/);
        continue;
      }
      const prices = it.perPerson.map((p) => p.price.amountMinor).sort((a, b) => a - b);
      const n = prices.length;
      const m2 =
        n % 2 === 1
          ? 2 * (prices[(n - 1) / 2] ?? 0)
          : (prices[n / 2 - 1] ?? 0) + (prices[n / 2] ?? 0);
      for (const p of it.perPerson)
        expect(2 * p.price.amountMinor * 100).toBeLessThanOrEqual(m2 * 125);
    }
  });
});
