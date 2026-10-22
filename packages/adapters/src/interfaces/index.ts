/**
 * Trav adapter interfaces (types only). Mock implementations live in
 * `packages/adapters/src/mock/<provider>/` and the simulator channel in
 * `packages/adapters/src/channel/simulator/`; real adapters are stubs under
 * `packages/adapters/src/real/`, disabled by default, never called live in v0.
 * See research/connectors.md for feasibility and the real APIs each interface
 * is shaped after, and docs/ARCHITECTURE.md "How to add a provider mock".
 */
export type * from './common.js';
export type * from './channel.js';
export type * from './flights.js';
export type * from './lodging.js';
export type * from './tickets.js';
export type * from './payments.js';
export type * from './transactions.js';
export type * from './emailReceipts.js';
export type * from './album.js';
export type * from './context.js';
