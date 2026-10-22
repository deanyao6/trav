/**
 * Multi-origin group flight optimizer (T-014): types. Pure. The adapter layer
 * maps provider offers (Duffel-shaped `FlightOffer`) into `FlightChoice`; this
 * module never sees provider types.
 */
import type { AirportCode, IsoDateTime, MemberId } from '../primitives.js';
import type { Money } from '../money.js';

export interface Leg {
  readonly origin: AirportCode;
  readonly destination: AirportCode;
  readonly departAt: IsoDateTime;
  readonly arriveAt: IsoDateTime;
  readonly stops: number;
  readonly durationMinutes: number;
  /** Longest connection on this leg; 0 for nonstop. */
  readonly longestLayoverMinutes: number;
  readonly carrier: string;
  readonly flightNumbers: readonly string[];
}

/** One bookable option for one member: outbound to the trip city and (optionally) the return. */
export interface FlightChoice {
  readonly memberId: MemberId;
  /** Provider offer id; the agent re-prices it before proposing. */
  readonly offerId: string;
  readonly provider: string;
  readonly outbound: Leg;
  readonly inbound?: Leg;
  readonly price: Money;
  readonly refundable: boolean;
}

export interface MemberTravel {
  readonly memberId: MemberId;
  readonly origin: AirportCode;
  /** Where they fly home to; may differ from origin (Barcelona fixture). */
  readonly returnTo: AirportCode;
  /** Member accepted paying more than the fairness limit. */
  readonly fairnessOptOut?: boolean;
  /** Display name for rationales and relax reasons; falls back to `memberId`. */
  readonly name?: string;
}

/**
 * Weights of the (lower-is-better) objective. Spreads and layovers are in
 * minutes; `totalCost` is per MAJOR unit of the trip currency (€1 / $1), so
 * the defaults say "one minute of arrival spread is worth about €1 of group
 * cost" and "a minute of departure spread or layover is worth about 50c".
 */
export interface OptimizerWeights {
  /** Spread (max − min) of landing times at the destination. */
  readonly arrivalSpread: number;
  /** Spread of the times members leave the destination (inbound departures). */
  readonly departureSpread: number;
  /** Spread of the times members land back home (inbound arrivals). */
  readonly returnSpread: number;
  readonly totalCost: number;
  readonly worstLayover: number;
}

export interface OptimizerConstraints {
  readonly perPersonCap?: Money;
  /** e.g. 0.25 ⇒ no member pays > 25% above the median share unless opted out. */
  readonly fairnessMaxAboveMedian?: number;
  readonly maxArrivalSpreadMinutes?: number;
  readonly refundableOnly?: boolean;
}

/**
 * `auto` (default) runs the exact branch-and-bound search when the number of
 * combinations is small and beam search otherwise; the other values force one.
 */
export type SearchMode = 'auto' | 'exact' | 'beam';

export interface OptimizerInput {
  readonly destination: AirportCode;
  readonly members: readonly MemberTravel[];
  /** Candidate choices per member; each member needs ≥1 or the optimizer reports `missing`. */
  readonly choices: readonly FlightChoice[];
  readonly weights: OptimizerWeights;
  readonly constraints: OptimizerConstraints;
  /**
   * How many ranked itineraries to return (integer >= 1). The optimizer does
   * not cap it: clamping is the caller's job. The recommended default is 3
   * (what the tests and fixtures use, and what fits in one chat message). Larger values cost search
   * time, since the exact search keeps the top `maxResults` leaves.
   */
  readonly maxResults: number;
  readonly search?: SearchMode;
}

export interface ScoreBreakdown {
  readonly arrivalSpreadMinutes: number;
  readonly departureSpreadMinutes: number;
  readonly returnSpreadMinutes: number;
  readonly totalCost: Money;
  readonly worstLayoverMinutes: number;
  /** Lower is better. */
  readonly score: number;
}

export interface RelaxedConstraint {
  readonly constraint: keyof OptimizerConstraints;
  readonly reason: string;
}

export interface GroupItinerary {
  readonly rank: number;
  /** One choice per member, in `input.members` order (members in `missing` are skipped). */
  readonly picks: readonly FlightChoice[];
  readonly breakdown: ScoreBreakdown;
  readonly perPerson: readonly { readonly memberId: MemberId; readonly price: Money }[];
  readonly allRefundable: boolean;
  /** One line for the chat card, e.g. "everyone lands within 90 min, €2,870 total". */
  readonly rationale: string;
  /** Constraints that had to be relaxed to find anything, with reasons. */
  readonly relaxed: readonly RelaxedConstraint[];
}

export interface OptimizerResult {
  readonly itineraries: readonly GroupItinerary[];
  /** Members with no candidate choice. */
  readonly missing: readonly MemberId[];
}

export const DEFAULT_WEIGHTS: OptimizerWeights = {
  arrivalSpread: 1,
  departureSpread: 0.5,
  returnSpread: 0.5,
  totalCost: 1,
  worstLayover: 0.5,
};
