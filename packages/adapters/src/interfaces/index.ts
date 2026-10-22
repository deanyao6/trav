/**
 * Trav adapter interfaces (types only). Mock implementations live elsewhere in
 * packages/adapters; real adapters are stubs, disabled by default, never called
 * live in v0. See research/connectors.md for feasibility and the real APIs each
 * interface is shaped after.
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
