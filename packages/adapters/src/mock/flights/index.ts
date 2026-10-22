/** Mock flights provider (T-029-a). Exports factories and pure mappers only. */
export { createMockFlights } from './adapter.js';
export type { MockFlightsAdapter, MockFlightsOptions } from './adapter.js';
export { loadMockFlightInventory, parseMockFlightInventory } from './inventory.js';
export type {
  FixtureTraveler,
  FlightOfferTemplate,
  MockFlightInventory,
  TemplateCondition,
} from './inventory.js';
export { sliceToLeg, toFlightChoice } from './toFlightChoice.js';
