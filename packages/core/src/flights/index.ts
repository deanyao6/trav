/**
 * Multi-origin group flight optimizer (T-014). Pure: no I/O, no clock. The
 * adapter layer maps provider offers (Duffel-shaped `FlightOffer`) into
 * `FlightChoice`; this module never sees provider types.
 *
 * - `types.ts`      input/output shapes and `DEFAULT_WEIGHTS`
 * - `score.ts`      objective terms, fairness math, `scoreItinerary`, `cheapestPerPerson`
 * - `search.ts`     exact branch-and-bound, beam search, exhaustive oracle
 * - `rationale.ts`  lowercase one-liners for chat cards
 * - `optimizer.ts`  constraint relaxation driver, `optimizeGroupFlights`, `bruteForceOptimize`
 *
 * Objective (lower is better): weighted sum of arrival spread at the
 * destination, departure spread leaving the destination, return (home landing)
 * spread, total cost in major units, and the worst layover. Constraints: per
 * person cap, fairness vs the group median (opt-out per member), max arrival
 * spread, refundable-only. When nothing satisfies them all, the smallest set of
 * constraints is relaxed (arrival window, then refundable-only, then fairness,
 * then the cap) and every returned itinerary says which and why.
 */
export type {
  FlightChoice,
  GroupItinerary,
  Leg,
  MemberTravel,
  OptimizerConstraints,
  OptimizerInput,
  OptimizerResult,
  OptimizerWeights,
  RelaxedConstraint,
  ScoreBreakdown,
  SearchMode,
} from './types.js';
export { DEFAULT_WEIGHTS } from './types.js';
export { cheapestPerPerson, scoreItinerary } from './score.js';
export { formatMinutes } from './rationale.js';
export {
  BEAM_WIDTH,
  EXACT_COMBINATION_LIMIT,
  EXACT_NODE_BUDGET,
  bruteForceOptimize,
  optimizeGroupFlights,
} from './optimizer.js';
