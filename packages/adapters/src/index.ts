/**
 * @trav/adapters: channel and provider interfaces plus their mock
 * implementations. Imports @trav/core only.
 */
export const PACKAGE_NAME = '@trav/adapters';

export type * from './interfaces/index.js';
export * from './channel/index.js';
export * from './mock/tickets/index.js';
export * from './mock/payments/index.js';
export * from './mock/flights/index.js';
export * from './mock/fx/index.js';
// T-029-b: factories (plus their option/hook types) and the email injection scan.
export { createMockTransactions } from './mock/transactions/index.js';
export type {
  MockTransactionsAdapter,
  MockTransactionsOptions,
} from './mock/transactions/index.js';
export {
  EMAIL_WARNINGS,
  createMockEmailReceiptSource,
  createOfflineReceiptEmailParser,
  scanEmailForInjection,
} from './mock/email/index.js';
export type {
  InboundDelivery,
  MockEmailReceiptSource,
  MockEmailSourceOptions,
} from './mock/email/index.js';
export { createMockAlbum } from './mock/album/index.js';
export type { MockAlbumAdapter, MockAlbumOptions } from './mock/album/index.js';
// T-008-b: factories only (plus their option/hook types).
export { createMockLodging } from './mock/lodging/index.js';
export type { MockLodging, MockLodgingOptions } from './mock/lodging/index.js';
export { createMockSettleUp } from './mock/settleup/index.js';
export type { MockSettleUp, MockSettleUpOptions } from './mock/settleup/index.js';
// T-169: the mock iMessage relay and the simulator-over-relay loopback.
export { createMockRelay } from './mock/relay/index.js';
export type {
  MockMemberMessage,
  MockRelay,
  MockRelayFault,
  MockRelayOptions,
  MockRelaySend,
  SignedWebhook,
} from './mock/relay/index.js';
export { createRelayLoopback, fictionalAddress } from './mock/relay/loopback.js';
export type { RelayLoopback, RelayLoopbackOptions } from './mock/relay/loopback.js';
// T-167: read-only places for suggestions.
export { createMockVenues, parseVenueCatalog } from './mock/places/index.js';
export type { MockVenuesOptions, VenueCatalog } from './mock/places/index.js';
