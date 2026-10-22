/** Mock lodging provider (T-008-b). Exports the factory and inventory helpers only (D-004). */
export { createMockLodging } from './adapter.js';
export type {
  LodgingCancellationQuote,
  LodgingCheckInSummary,
  MockLodging,
  MockLodgingOptions,
} from './adapter.js';
export {
  LODGING_INVENTORY_NAMES,
  loadLodgingInventory,
  parseLodgingInventory,
} from './inventory.js';
export type {
  HostMessaging,
  InventoryProperty,
  InventoryRate,
  LodgingInventory,
  RecheckOutcome,
} from './inventory.js';
