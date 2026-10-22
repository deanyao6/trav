/**
 * Test helpers for the flight optimizer. Not a test file (no `.test.ts`),
 * never imported by production code.
 *
 * Barcelona (flagship, MOTIVATION.md): six friends fly in from six US cities
 * and home to six different ones. Defined inline until the synthetic-data
 * agent lands `fixtures/flights/barcelona.json`; swap the data, keep the tests.
 */
import { addMinutes } from '../clock.js';
import { money } from '../money.js';
import type { CurrencyCode, IsoDateTime, MemberId } from '../primitives.js';
import { DEFAULT_WEIGHTS } from './types.js';
import type {
  FlightChoice,
  Leg,
  MemberTravel,
  OptimizerConstraints,
  OptimizerInput,
  OptimizerWeights,
} from './types.js';

export const DEAN: MemberId = 'mem_dean';
export const MAYA: MemberId = 'mem_maya';
export const JORDAN: MemberId = 'mem_jordan';
export const PRIYA: MemberId = 'mem_priya';
export const SAM: MemberId = 'mem_sam';
export const HENRY: MemberId = 'mem_henry';

export interface ChoiceSpec {
  readonly memberId: MemberId;
  readonly offerId: string;
  /** Major units (e.g. euros); converted to minor units. */
  readonly price: number;
  readonly currency?: CurrencyCode;
  readonly origin: string;
  readonly destination?: string;
  /** Landing at the destination. */
  readonly arriveAt: IsoDateTime;
  readonly durationMinutes?: number;
  readonly layover?: number;
  readonly stops?: number;
  readonly refundable?: boolean;
  /** Return leg: leaving the destination and landing home. Omit for one-way. */
  readonly inbound?: {
    readonly to: string;
    readonly departAt: IsoDateTime;
    readonly arriveAt: IsoDateTime;
    readonly layover?: number;
    readonly stops?: number;
  };
}

export function leg(spec: {
  origin: string;
  destination: string;
  departAt: IsoDateTime;
  arriveAt: IsoDateTime;
  layover?: number;
  stops?: number;
  durationMinutes?: number;
}): Leg {
  const stops = spec.stops ?? (spec.layover !== undefined && spec.layover > 0 ? 1 : 0);
  return {
    origin: spec.origin,
    destination: spec.destination,
    departAt: spec.departAt,
    arriveAt: spec.arriveAt,
    stops,
    durationMinutes: spec.durationMinutes ?? 480,
    longestLayoverMinutes: spec.layover ?? 0,
    carrier: 'ZZ',
    flightNumbers: stops === 0 ? ['ZZ100'] : ['ZZ100', 'ZZ200'],
  };
}

export function choice(spec: ChoiceSpec): FlightChoice {
  const duration = spec.durationMinutes ?? 480;
  const outbound = leg({
    origin: spec.origin,
    destination: spec.destination ?? 'BCN',
    departAt: addMinutes(spec.arriveAt, -duration),
    arriveAt: spec.arriveAt,
    durationMinutes: duration,
    ...(spec.layover !== undefined ? { layover: spec.layover } : {}),
    ...(spec.stops !== undefined ? { stops: spec.stops } : {}),
  });
  const base = {
    memberId: spec.memberId,
    offerId: spec.offerId,
    provider: 'mock-flights',
    outbound,
    price: money(Math.round(spec.price * 100), spec.currency ?? 'EUR'),
    refundable: spec.refundable ?? false,
  };
  if (spec.inbound === undefined) return base;
  return {
    ...base,
    inbound: leg({
      origin: spec.destination ?? 'BCN',
      destination: spec.inbound.to,
      departAt: spec.inbound.departAt,
      arriveAt: spec.inbound.arriveAt,
      ...(spec.inbound.layover !== undefined ? { layover: spec.inbound.layover } : {}),
      ...(spec.inbound.stops !== undefined ? { stops: spec.inbound.stops } : {}),
    }),
  };
}

export function inputOf(spec: {
  members: readonly MemberTravel[];
  choices: readonly FlightChoice[];
  weights?: OptimizerWeights;
  constraints?: OptimizerConstraints;
  maxResults?: number;
  search?: OptimizerInput['search'];
  destination?: string;
}): OptimizerInput {
  return {
    destination: spec.destination ?? 'BCN',
    members: spec.members,
    choices: spec.choices,
    weights: spec.weights ?? DEFAULT_WEIGHTS,
    constraints: spec.constraints ?? {},
    maxResults: spec.maxResults ?? 3,
    ...(spec.search !== undefined ? { search: spec.search } : {}),
  };
}

// ---------- Barcelona fixture ----------

export const BARCELONA_MEMBERS: readonly MemberTravel[] = [
  { memberId: DEAN, name: 'Dean', origin: 'BOS', returnTo: 'JFK' },
  { memberId: MAYA, name: 'Maya', origin: 'SFO', returnTo: 'LAX' },
  { memberId: JORDAN, name: 'Jordan', origin: 'ORD', returnTo: 'DEN' },
  { memberId: PRIYA, name: 'Priya', origin: 'ATL', returnTo: 'MIA' },
  { memberId: SAM, name: 'Sam', origin: 'DEN', returnTo: 'SEA' },
  { memberId: HENRY, name: 'Henry', origin: 'IAD', returnTo: 'BOS' },
];

/** Outbound lands Fri 2026-03-13 (BCN, +01:00); return leaves Mon 2026-03-16. */
const bcn = (hhmm: string): IsoDateTime => `2026-03-13T${hhmm}:00+01:00`;
const bcnOut = (hhmm: string): IsoDateTime => `2026-03-16T${hhmm}:00+01:00`;

type Home = { to: string; offset: string };
const HOME: Readonly<Record<MemberId, Home>> = {
  [DEAN]: { to: 'JFK', offset: '-04:00' },
  [MAYA]: { to: 'LAX', offset: '-07:00' },
  [JORDAN]: { to: 'DEN', offset: '-06:00' },
  [PRIYA]: { to: 'MIA', offset: '-04:00' },
  [SAM]: { to: 'SEA', offset: '-07:00' },
  [HENRY]: { to: 'BOS', offset: '-04:00' },
};

function ret(
  memberId: MemberId,
  departHHMM: string,
  arriveHHMM: string,
  layover = 0,
): NonNullable<ChoiceSpec['inbound']> {
  const home = HOME[memberId] as Home;
  return {
    to: home.to,
    departAt: bcnOut(departHHMM),
    arriveAt: `2026-03-16T${arriveHHMM}:00${home.offset}`,
    layover,
  };
}

const ORIGIN: Readonly<Record<MemberId, string>> = {
  [DEAN]: 'BOS',
  [MAYA]: 'SFO',
  [JORDAN]: 'ORD',
  [PRIYA]: 'ATL',
  [SAM]: 'DEN',
  [HENRY]: 'IAD',
};

function offer(
  memberId: MemberId,
  offerId: string,
  price: number,
  arrive: string,
  opts: { layover?: number; refundable?: boolean; ret: NonNullable<ChoiceSpec['inbound']> },
): FlightChoice {
  return choice({
    memberId,
    offerId,
    price,
    origin: ORIGIN[memberId] as string,
    arriveAt: bcn(arrive),
    layover: opts.layover ?? 0,
    refundable: opts.refundable ?? false,
    inbound: opts.ret,
  });
}

/**
 * Per member: the cheapest fare lands at an awkward time (dawn or late night),
 * the next ones cluster mid-morning for a little more. Mixed refundability and
 * layovers, like real search results.
 */
export const BARCELONA_CHOICES: readonly FlightChoice[] = [
  // Dean, BOS → BCN, home to JFK
  offer(DEAN, 'bos-1', 380, '06:50', { ret: ret(DEAN, '07:10', '10:05') }),
  offer(DEAN, 'bos-2', 412, '09:40', { refundable: true, ret: ret(DEAN, '12:30', '15:20') }),
  offer(DEAN, 'bos-3', 455, '15:20', {
    layover: 95,
    refundable: true,
    ret: ret(DEAN, '13:00', '19:40', 120),
  }),
  offer(DEAN, 'bos-4', 520, '10:05', {
    layover: 60,
    refundable: true,
    ret: ret(DEAN, '11:45', '16:30', 70),
  }),
  // Maya, SFO → BCN, home to LAX
  offer(MAYA, 'sfo-1', 498, '22:15', { layover: 210, ret: ret(MAYA, '06:30', '14:50', 180) }),
  offer(MAYA, 'sfo-2', 538, '10:15', {
    layover: 75,
    refundable: true,
    ret: ret(MAYA, '12:15', '19:10', 80),
  }),
  offer(MAYA, 'sfo-3', 610, '09:55', {
    layover: 50,
    refundable: true,
    ret: ret(MAYA, '12:40', '19:30', 60),
  }),
  offer(MAYA, 'sfo-4', 575, '17:40', {
    layover: 140,
    refundable: true,
    ret: ret(MAYA, '18:20', '23:55', 90),
  }),
  // Jordan, ORD → BCN, home to DEN
  offer(JORDAN, 'ord-1', 395, '07:30', { ret: ret(JORDAN, '19:00', '23:40', 95) }),
  offer(JORDAN, 'ord-2', 430, '10:30', {
    layover: 80,
    refundable: true,
    ret: ret(JORDAN, '12:20', '18:05', 85),
  }),
  offer(JORDAN, 'ord-3', 470, '09:15', {
    refundable: true,
    ret: ret(JORDAN, '11:30', '17:10', 60),
  }),
  // Priya, ATL → BCN, home to MIA
  offer(PRIYA, 'atl-1', 405, '18:05', { layover: 260, ret: ret(PRIYA, '06:00', '13:30', 150) }),
  offer(PRIYA, 'atl-2', 445, '10:45', {
    layover: 70,
    refundable: true,
    ret: ret(PRIYA, '12:10', '17:45', 75),
  }),
  offer(PRIYA, 'atl-3', 480, '09:30', { refundable: true, ret: ret(PRIYA, '12:50', '18:20', 50) }),
  offer(PRIYA, 'atl-4', 440, '13:10', { layover: 120, ret: ret(PRIYA, '15:30', '21:40', 130) }),
  offer(PRIYA, 'atl-5', 505, '10:00', { refundable: true, ret: ret(PRIYA, '11:50', '17:15') }),
  // Sam, DEN → BCN, home to SEA
  offer(SAM, 'den-1', 420, '21:50', { layover: 185, ret: ret(SAM, '07:00', '15:10', 200) }),
  offer(SAM, 'den-2', 465, '11:00', {
    layover: 90,
    refundable: true,
    ret: ret(SAM, '12:35', '19:20', 95),
  }),
  offer(SAM, 'den-3', 510, '09:50', {
    layover: 55,
    refundable: true,
    ret: ret(SAM, '12:00', '18:40', 60),
  }),
  // Henry, IAD → BCN, home to BOS
  offer(HENRY, 'iad-1', 372, '07:15', { ret: ret(HENRY, '07:30', '10:40') }),
  offer(HENRY, 'iad-2', 399, '10:20', { refundable: true, ret: ret(HENRY, '12:25', '15:35') }),
  offer(HENRY, 'iad-3', 450, '12:35', {
    layover: 110,
    refundable: true,
    ret: ret(HENRY, '14:00', '19:30', 100),
  }),
  offer(HENRY, 'iad-4', 640, '09:45', { refundable: true, ret: ret(HENRY, '12:00', '15:05') }),
];

export function barcelonaInput(
  overrides: Partial<Omit<OptimizerInput, 'destination'>> = {},
): OptimizerInput {
  return {
    destination: 'BCN',
    members: BARCELONA_MEMBERS,
    choices: BARCELONA_CHOICES,
    weights: DEFAULT_WEIGHTS,
    constraints: { fairnessMaxAboveMedian: 0.25 },
    maxResults: 3,
    ...overrides,
  };
}

/** Deterministic PRNG (mulberry32) for larger synthetic inputs; never Math.random. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `memberCount` members × `offersEach` offers with varied times/prices/layovers. */
export function syntheticInput(
  memberCount: number,
  offersEach: number,
  seed: number,
  overrides: Partial<Omit<OptimizerInput, 'destination'>> = {},
): OptimizerInput {
  const rnd = seededRandom(seed);
  const members: MemberTravel[] = Array.from({ length: memberCount }, (_, i) => ({
    memberId: `mem_${i}`,
    name: `Member${i}`,
    origin: `O${i}`,
    returnTo: `R${i}`,
  }));
  const choices: FlightChoice[] = [];
  for (const m of members) {
    for (let j = 0; j < offersEach; j += 1) {
      const arriveMin = Math.floor(rnd() * 24 * 60);
      const departMin = Math.floor(rnd() * 24 * 60);
      const layover = rnd() < 0.5 ? 0 : Math.floor(rnd() * 300);
      choices.push(
        choice({
          memberId: m.memberId,
          offerId: `${m.memberId}-${j}`,
          price: 250 + Math.floor(rnd() * 500),
          origin: m.origin,
          arriveAt: addMinutes('2026-03-13T00:00:00+01:00', arriveMin),
          layover,
          refundable: rnd() < 0.6,
          inbound: {
            to: m.returnTo,
            departAt: addMinutes('2026-03-16T00:00:00+01:00', departMin),
            arriveAt: addMinutes('2026-03-16T00:00:00+01:00', departMin + 540),
            layover: rnd() < 0.5 ? 0 : Math.floor(rnd() * 240),
          },
        }),
      );
    }
  }
  return {
    destination: 'BCN',
    members,
    choices,
    weights: DEFAULT_WEIGHTS,
    constraints: {},
    maxResults: 3,
    ...overrides,
  };
}
